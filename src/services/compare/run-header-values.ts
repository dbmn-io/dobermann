// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A run's header values for a list of runs (the Hub's History): the same reading Query's Add a view uses
 * (headerValuesOf: the values the run kept, else what its request shows against the endpoint's and the
 * environment's templates), so `@org=…` finds in History what Query finds. History read only the kept values: a
 * run from before they were kept, or kept under another name, was never found (James, 2026-11-26, platform #477).
 *
 * `headers`: everything the run was sent with, as text, for `@headers~…` when the variable's name isn't known.
 */
import { headerValuesOf, type RequestTemplates } from './compare-runs';

type Run = Parameters<typeof headerValuesOf>[0] & { endpointId?: string };
type Environment = NonNullable<Parameters<typeof headerValuesOf>[1]> & { id?: string };

export interface RunHeaderSearch {
    /** Each header variable's value, by its name; the option's label after it when it has one ("840 · Brisbane"). */
    headerValues: Record<string, string>;
    /** The header variables' values and the request headers the run sent, a line each. */
    headersText: string;
}

/** Headers never shown or searched: they carry secrets. */
const SECRET = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|apikey)$/i;

export function runHeaderSearch(run: Run, environment: Environment | undefined, endpoint: RequestTemplates | undefined): RunHeaderSearch {
    const headerValues: Record<string, string> = {};
    for (const h of headerValuesOf(run, environment, endpoint)) headerValues[h.name] = h.label ? `${h.value} · ${h.label}` : h.value;
    const lines = Object.entries(headerValues).map(([name, value]) => `${name}: ${value}`);
    for (const [name, value] of Object.entries(run.requestHeaders ?? {})) {
        if (!SECRET.test(name) && value !== undefined && value !== null && String(value) !== '') lines.push(`${name}: ${value}`);
    }
    return { headerValues, headersText: lines.join('\n') };
}

/** Every run with its header values beside it (a copy: the storage's own list is not written). */
export function withRunHeaderSearch<T extends Run & { environmentId?: string }>(
    runs: T[], environments: Environment[], endpoints: (RequestTemplates & { id?: string })[]
): (T & RunHeaderSearch)[] {
    const environmentById = new Map(environments.map(e => [e.id, e]));
    const endpointById = new Map(endpoints.map(e => [e.id, e]));
    return runs.map(run => ({ ...run, ...runHeaderSearch(run, environmentById.get(run.environmentId), endpointById.get(run.endpointId)) }));
}
