// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The templates still standing in an endpoint's path, query parameters and headers when a run
 * is about to go: a value nobody supplied. Run API refuses with their names. The body is not
 * looked at (its templates are the JSON generator's, as for Run Batch, #145); `{{A8:…}}` and
 * `{{V8:…}}` are generated at execution; `{{}}` and `{{:type}}` take their name from the JSON
 * key; `{{ENV:name}}` has been replaced from the environment before this runs (env-template).
 */
import type { APIEndpointConfig } from '../../data-loading/types';

const TEMPLATE = /\{\{([^}]+)\}\}/g;

type Valued = string | { value?: unknown } | null | undefined;

function templatesIn(text: string | undefined, into: string[]): void {
    if (!text) return;
    for (const match of text.matchAll(TEMPLATE)) {
        const name = match[1];
        if (name.startsWith('A8:') || name.startsWith('V8:') || name === '' || name.startsWith(':')) continue;
        if (!into.includes(match[0])) into.push(match[0]);
    }
}

function valuesOf(record: Record<string, Valued> | undefined): string[] {
    if (!record) return [];
    return Object.values(record).map(v => (typeof v === 'string' ? v : typeof v?.value === 'string' ? v.value : '')).filter(Boolean);
}

/** `{{name}}` and `{{name:type}}` still in the path, query parameters or headers, each once, in order of appearance. */
export function unresolvedVariables(endpoint: Pick<APIEndpointConfig, 'path' | 'queryParams' | 'headers'>): string[] {
    const out: string[] = [];
    templatesIn(endpoint.path, out);
    for (const value of valuesOf(endpoint.queryParams as Record<string, Valued> | undefined)) templatesIn(value, out);
    for (const value of valuesOf(endpoint.headers as Record<string, Valued> | undefined)) templatesIn(value, out);
    return out;
}
