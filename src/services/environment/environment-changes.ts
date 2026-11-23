// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What changed between two readings of an environment, in words a toast can show: the header
 * picker set `org`, another tab renamed it, another device changed its type. Read by the
 * environment editor when the environment it shows changes under it.
 */
import type { EnvironmentConfig } from '../../environmentManager';

type Reading = Partial<EnvironmentConfig>;

const NAMED: Array<[keyof EnvironmentConfig, string]> = [
    ['name', 'name'], ['baseUrl', 'URL'], ['environmentType', 'type'], ['description', 'description'],
    ['authMethod', 'sign-in'], ['targetTimezone', 'timezone'], ['runOn', 'where it runs'], ['systemId', 'System']
];

/**
 * JSON with every object's keys in order, so two readings compare by what they hold. Postgres
 * (jsonb) hands an environment back with its keys reordered: compared as plain JSON, the editor's
 * own save, echoed, read as "changed elsewhere". A list's order still counts.
 */
function canonical(value: unknown): string {
    return JSON.stringify(value ?? null, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v));
}

/**
 * Kept with an environment but not one of its settings: createdAt (made up afresh on every read when an environment
 * was kept without one: sanitizeEnvironmentConfig) and lastUsed (moved when it is picked). Left out when two readings
 * are compared, or every save of anything at all read as "settings changed" (the manager for James, 2026-11-23).
 */
const BOOKKEEPING = new Set(['createdAt', 'lastUsed']);
const settingsOf = (reading: Reading | undefined): unknown => (reading && typeof reading === 'object'
    ? Object.fromEntries(Object.entries(reading).filter(([key]) => !BOOKKEEPING.has(key)))
    : reading);

/** The same stored environment, setting for setting (in any key order; its bookkeeping aside). */
export function sameEnvironment(a: Reading | undefined, b: Reading | undefined): boolean {
    return canonical(settingsOf(a)) === canonical(settingsOf(b));
}

/** "org is now nz", "header Accept changed", "name is now Staging": the differences, most useful first. */
export function describeEnvironmentChanges(before: Reading, after: Reading): string[] {
    const out: string[] = [];
    const vars = new Set([...Object.keys(before.variables ?? {}), ...Object.keys(after.variables ?? {})]);
    for (const name of vars) {
        const was = before.variables?.[name];
        const now = after.variables?.[name];
        if (was === now) continue;
        out.push(now === undefined ? `${name} removed` : `${name} is now ${now || '(empty)'}`);
    }
    if (canonical(before.variableSettings ?? {}) !== canonical(after.variableSettings ?? {})) out.push('variable options changed');
    const headers = new Set([...Object.keys(before.headers ?? {}), ...Object.keys(after.headers ?? {})]);
    for (const name of headers) {
        if (canonical(before.headers?.[name]) !== canonical(after.headers?.[name])) out.push(`header ${name} changed`);
    }
    for (const [key, label] of NAMED) {
        const was = before[key];
        const now = after[key];
        if (was === now) continue;
        out.push(typeof now === 'string' && now ? `${label} is now ${now}` : `${label} changed`);
    }
    if (canonical(before.oauthConfig) !== canonical(after.oauthConfig)) out.push('sign-in settings changed');
    if (canonical(before.parallelProcessing) !== canonical(after.parallelProcessing)) out.push('concurrency changed');
    if (out.length === 0 && !sameEnvironment(before, after)) out.push('settings changed');
    return out;
}
