// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: which endpoints can a Console View's rows feed?
 *
 * Pure ranking, no I/O. The strongest signal is the one Run Batch acts on: a column whose
 * name matches a template variable is mapped without asking (exact, ignoring case, or
 * ignoring punctuation — `location.gln` ↔ `location_gln`). The #247 URL guess
 * (`GET /employeeStatus` ↔ `POST /employeeStatus/save`) comes second.
 */
import { APIEndpointConfig } from '../../data-loading/types';
import { endpointInputVariables } from './endpoint-input-variables';

/** How a variable got its column — the same order Run Batch's auto-map tries (#307 first). */
export type MappingHow = 'remembered' | 'exact' | 'loose' | 'partial';

export interface VariableMapping {
    name: string;
    optional: boolean;
    column: string | null;
    how: MappingHow | null;
}

export interface ChainTargetCandidate {
    endpointId: string;
    name: string;
    method: string;
    path: string;
    /** Every input variable (A8/ENV excluded) and the column Run Batch would give it. */
    variables: VariableMapping[];
    /** Input variables a column matches with confidence (remembered, exact, loose). */
    matched: string[];
    /** Required input variables with no confident column. */
    missingRequired: string[];
    /** Every required variable is matched with confidence, and there is at least one variable. */
    fullyCovered: boolean;
    /** Same resource as the source by the URL guess. */
    sameResource: boolean;
    /** How many input variables the endpoint has. */
    variableCount: number;
}

export interface ChainSourceEndpoint {
    id?: string;
    method?: string;
    path?: string;
}

/** Same rule as TemplateRename.looseName (shared/template-rename.js). */
export function looseName(name: string): string {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TRAILING_VERBS = new Set(['save', 'saveall', 'create', 'update', 'delete', 'remove', 'list', 'search', 'get', 'find', 'bulk', 'batch']);

/**
 * The resource a path names: query string and variables gone, id-like and verb-like trailing
 * segments dropped, lower-cased. `/lmcore/api/lmcore/employeeStatus/save` →
 * `lmcore/api/lmcore/employeestatus`.
 */
export function resourceStem(path: string | undefined): string {
    if (!path) return '';
    let p = path.split('?')[0];
    p = p.replace(/^[a-z]+:\/\/[^/]+/i, '');            // absolute URL → path
    const segments = p.split('/').map(s => s.trim()).filter(Boolean);
    while (segments.length > 1) {
        const last = segments[segments.length - 1];
        const lower = last.toLowerCase();
        const isVariable = /^\{\{.*\}\}$/.test(last) || /^[:{]/.test(last);
        const isId = /^\d+$/.test(last) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(last);
        if (isVariable || isId || TRAILING_VERBS.has(lower)) {
            segments.pop();
            continue;
        }
        break;
    }
    return segments.join('/').toLowerCase();
}

/**
 * The column Run Batch's Map & Transform would pick for each variable, in its order: the column
 * this endpoint remembered (#307), an exact name ignoring case, a name ignoring punctuation,
 * then a partial name. Only the first three count as confident; a partial is a guess the user
 * checks on Step 2. (Mirrors data-transformer.js findBestColumnMatch + rememberedColumnFor.)
 */
export function mapEndpointVariables(endpoint: APIEndpointConfig, columns: string[]): VariableMapping[] {
    const remembered: Record<string, string> = ((endpoint as any)?.dataLoadingConfig?.columnMappings) || {};
    return endpointInputVariables(endpoint).map(v => {
        const lower = v.name.toLowerCase();
        const pick = (column: string | undefined, how: MappingHow): VariableMapping | null =>
            column ? { name: v.name, optional: v.optional, column, how } : null;
        return pick(columns.includes(remembered[v.name]) ? remembered[v.name] : undefined, 'remembered')
            || pick(columns.find(c => c.toLowerCase() === lower), 'exact')
            || pick(looseName(v.name) ? columns.find(c => looseName(c) === looseName(v.name)) : undefined, 'loose')
            || pick(columns.find(c => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase())), 'partial')
            || { name: v.name, optional: v.optional, column: null, how: null };
    });
}

export const isConfident = (m: VariableMapping): boolean => m.how === 'remembered' || m.how === 'exact' || m.how === 'loose';

export function rankChainTargets(
    columns: string[],
    endpoints: APIEndpointConfig[],
    source: ChainSourceEndpoint
): ChainTargetCandidate[] {
    const sourceStem = resourceStem(source.path);
    const candidates = endpoints
        .filter(ep => ep && ep.id && ep.id !== source.id)
        .map((ep): ChainTargetCandidate => {
            const variables = mapEndpointVariables(ep, columns);
            const matched = variables.filter(isConfident).map(v => v.name);
            const missingRequired = variables.filter(v => !v.optional && !isConfident(v)).map(v => v.name);
            return {
                endpointId: ep.id!,
                name: ep.name || ep.path || ep.id!,
                method: (ep.method || 'GET').toUpperCase(),
                path: ep.path || '',
                variables,
                matched,
                missingRequired,
                fullyCovered: variables.length > 0 && missingRequired.length === 0 && matched.length > 0,
                sameResource: !!sourceStem && resourceStem(ep.path) === sourceStem,
                variableCount: variables.length
            };
        });

    return candidates.sort((a, b) =>
        Number(b.fullyCovered) - Number(a.fullyCovered)
        || b.matched.length - a.matched.length
        || Number(b.sameResource) - Number(a.sameResource)
        || a.name.localeCompare(b.name));
}

/**
 * Review 2026-10-04: suggest only endpoints that take every required variable from a column.
 * One matching key column is not a suggestion — search finds those.
 */
export function isSuggested(candidate: ChainTargetCandidate): boolean {
    return candidate.fullyCovered;
}

export const MAX_SUGGESTIONS = 5;

/** One line for the Chain dialog: "5 of 5 variables match", "3 of 4 · missing reason". */
export function describeCandidate(candidate: ChainTargetCandidate): string {
    const parts: string[] = [];
    if (candidate.variableCount === 0) {
        parts.push('no variables to fill');
    } else if (candidate.matched.length > 0) {
        parts.push(`${candidate.matched.length} of ${candidate.variableCount} variable${candidate.variableCount === 1 ? '' : 's'} match`);
        if (candidate.missingRequired.length > 0) {
            const shown = candidate.missingRequired.slice(0, 3).join(', ');
            const more = candidate.missingRequired.length > 3 ? ` and ${candidate.missingRequired.length - 3} more` : '';
            parts.push(`missing ${shown}${more}`);
        }
    }
    if (candidate.sameResource) parts.push('same resource');
    return parts.join(' · ');
}
