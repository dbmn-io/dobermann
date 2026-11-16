// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: an endpoint's results, as the Compare dialog lists them (the Console's Compare
 * and Compare's own Edit).
 *
 * Each result carries its environment's header values as they were when it ran (`org` 880,
 * `org` 840): one environment run for two companies is two "virtual environments", and the
 * dialog tells them apart by these. A batch keeps every variable it ran with; a single run keeps
 * its header variables from now on. An older single run kept only `org` (as its organization),
 * so the rest are worked out as a person would from its first request: the headers, query
 * parameters and path it sent, lined up against the templates they came from
 * (`Organization: {{org}}` sent as `Organization: 880` is org 880).
 */
import type { IExecutionMetadataService } from '../execution/execution-metadata.interface';
import { headerVariableNames, VariableBearer } from '../environment/variable-options';
import { isComparableRun } from './compare-store';

/** One header variable's value on a run; `label` is the option's name (840 is "Brisbane"). */
export interface RunHeaderValue {
    name: string;
    value: string;
    label?: string;
}

/** A finished run of the endpoint, as the Compare dialog lists it. */
export interface CompareRun {
    id: string;
    isBatch: boolean;
    environment: string;
    executedAt: string;
    status: string;
    /** The run's own row count ("rows" on the History record). */
    rows: string;
    /** A paginated batch that has not fetched every page yet. */
    incomplete?: boolean;
    /** The environment's header values when it ran. */
    header?: RunHeaderValue[];
}

type RunRecord = {
    environmentId?: string;
    organization?: string;
    environmentVariables?: Record<string, string>;
    /** What the run sent: its headers, query parameters and path, variables filled. */
    requestHeaders?: Record<string, string>;
    requestQueryParams?: Record<string, string>;
    endpointPath?: string;
};

/** A header or query parameter as an endpoint or environment keeps it (old shape: the value alone). */
type TemplateMap = Record<string, string | { value?: string }>;

/** Where a run's request came from: the endpoint's and the environment's templates. */
export interface RequestTemplates {
    path?: string;
    headers?: TemplateMap;
    queryParams?: TemplateMap;
}

type EnvironmentRecord = VariableBearer & { headers?: TemplateMap };
type EnvironmentLookup = { getEnvironment(id: string): Promise<EnvironmentRecord | undefined> };

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

function textOf(item: string | { value?: string } | undefined): string | undefined {
    return typeof item === 'string' ? item : item?.value;
}

/**
 * The variables a template names, valued from what was sent: `Bearer {{token}}` and
 * `Bearer abc` give token abc. `{{ENV:org}}` names org; a system value (`{{A8:date}}`) matches
 * anything and names nothing. Nothing when the sent text does not fit the template.
 */
export function valuesFromTemplate(template: string, sent: string): Record<string, string> {
    const names: (string | undefined)[] = [];
    let pattern = '';
    let last = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
        pattern += template.slice(last, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.*?)';
        const inner = match[1].replace(/^ENV:/i, '').trim();
        names.push(inner.includes(':') ? undefined : inner);
        last = (match.index ?? 0) + match[0].length;
    }
    if (!names.length) return {};
    pattern += template.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new RegExp(`^${pattern}$`, 's').exec(sent);
    const values: Record<string, string> = {};
    names.forEach((name, i) => { if (name && found && found[i + 1] && !found[i + 1].includes('{{') && !(name in values)) values[name] = found[i + 1]; });
    return values;
}

/** The variables a run's request shows: each header, query parameter and the path against its template. */
export function valuesFromRequest(run: RunRecord, templates: RequestTemplates[]): Record<string, string> {
    const values: Record<string, string> = {};
    const take = (found: Record<string, string>) => { for (const [k, v] of Object.entries(found)) if (!(k in values)) values[k] = v; };
    const sentHeaders = new Map(Object.entries(run.requestHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const t of templates) {
        for (const [name, item] of Object.entries(t.headers ?? {})) {
            const template = textOf(item);
            const sent = sentHeaders.get(name.toLowerCase());
            if (template && sent !== undefined) take(valuesFromTemplate(template, sent));
        }
        for (const [name, item] of Object.entries(t.queryParams ?? {})) {
            const template = textOf(item);
            const sent = run.requestQueryParams?.[name];
            if (template && sent !== undefined) take(valuesFromTemplate(template, sent));
        }
        if (t.path && run.endpointPath) take(valuesFromTemplate(t.path, run.endpointPath));
    }
    return values;
}

function iso(d: unknown): string {
    if (d instanceof Date) return d.toISOString();
    return typeof d === 'string' ? d : '';
}

/**
 * The run's header values: the environment's header variables, valued as the run kept them, or
 * else as its request shows them. With the environment gone, the run's organization is all
 * that is known.
 */
export function headerValuesOf(run: RunRecord, environment: EnvironmentRecord | undefined, endpoint?: RequestTemplates): RunHeaderValue[] {
    let fromRequest: Record<string, string> | undefined;
    const shown = (name: string): string | undefined => {
        fromRequest ??= valuesFromRequest(run, [endpoint ?? {}, { headers: environment?.headers }]);
        return fromRequest[name];
    };
    const kept = (name: string): string | undefined =>
        run.environmentVariables?.[name] ?? (name === 'org' ? run.organization : undefined) ?? shown(name);
    // The run's org shows whatever the environment ticks: environments from before header
    // variables keep org as a plain variable, and every run has recorded its org all along.
    const names = environment ? headerVariableNames(environment) : [];
    if (run.organization && !names.includes('org')) names.unshift('org');
    const values: RunHeaderValue[] = [];
    for (const name of names) {
        const value = kept(name);
        if (!value) continue;
        const label = environment?.variableSettings?.[name]?.labels?.[value];
        values.push({ name, value, ...(label ? { label } : {}) });
    }
    return values;
}

/** The endpoint's finished results, newest first (an error run counts: it is a result too). */
export async function comparableRuns(
    metadata: Pick<IExecutionMetadataService, 'getExecutionsByEndpoint'>,
    environments: EnvironmentLookup | undefined,
    endpointId: string,
    /** The endpoint's templates now: an older single run's header values are read off its request with them. */
    endpoint?: RequestTemplates
): Promise<CompareRun[]> {
    const all = (await metadata.getExecutionsByEndpoint(endpointId))
        .filter(isComparableRun)
        .sort((x, y) => iso(y.createdAt).localeCompare(iso(x.createdAt)));
    const byId = new Map<string, Promise<EnvironmentRecord | undefined>>();
    const environmentOf = (id: string | undefined): Promise<EnvironmentRecord | undefined> => {
        if (!id || !environments) return Promise.resolve(undefined);
        if (!byId.has(id)) byId.set(id, environments.getEnvironment(id).catch(() => undefined));
        return byId.get(id)!;
    };
    return Promise.all(all.map(async e => {
        const header = headerValuesOf(e, await environmentOf(e.environmentId), endpoint);
        return {
            id: e.id,
            isBatch: e.executionType === 'batch',
            environment: e.environment || 'Unknown',
            executedAt: iso(e.startedAt || e.createdAt),
            status: String(e.status).toLowerCase(),
            rows: String(e.rows ?? ''),
            ...(e.batchConfiguration?.pagesComplete === false ? { incomplete: true } : {}),
            ...(header.length ? { header } : {}),
        };
    }));
}
