// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The lookup tables a request template's `lu` reads (James, 2026-11-23: `{{uom | lu:uom:tms>wms}}`).
 *
 * Each host says once where its tables are (`useTemplateLookups`: the same store the Hub and Query
 * read), and the tables are read again before a run fills its template or Validate checks it
 * (`refreshTemplateLookups`), so an edit made a moment ago counts. Filling itself is synchronous
 * (modifier-executor.ts), so it reads what was last read here. Small: a table is up to 1,000 rows.
 *
 * The rule for a value is lookup-tables.ts lookupValue, the one Query's Translate values follows:
 * exact text, any column to any other. What `lu` adds: a value that is blank, not in the table,
 * in it twice, or whose To is blank, fails, and says why in words.
 */
import { lookupColumn, lookupValue, type LookupTable } from '../services/lookup-tables/lookup-tables';
import type { LookupModifier, ModifierResult } from './modifier-types';

let read: (() => Promise<LookupTable[]>) | undefined;
let tables: LookupTable[] = [];

/** Where this host's lookup tables are: every table, whole. */
export function useTemplateLookups(source: () => Promise<LookupTable[]>): void {
    read = source;
}

/** Every table a store holds, whole (the store lists them, then reads each). */
export function allTablesOf(store: { list(): Promise<Array<{ id: string }>>; get(id: string): Promise<LookupTable | undefined> }): () => Promise<LookupTable[]> {
    return async () => (await Promise.all((await store.list()).map(t => store.get(t.id)))).filter((t): t is LookupTable => !!t);
}

/** The tables read again (before a run, before Validate); kept as they were when they can't be read. */
export async function refreshTemplateLookups(): Promise<LookupTable[]> {
    if (!read) return tables;
    try { tables = await read(); } catch { /* the last ones read */ }
    return tables;
}

/** The tables as last read (for Run Batch's page: Validate checks there as the run will). */
export function templateLookupTables(): LookupTable[] {
    return tables;
}

/** For tests: the tables as given. */
export function setTemplateLookupTables(list: LookupTable[]): void {
    tables = list;
}

/** Does a template use `lu` anywhere (so the tables are worth reading first)? */
export function templateUsesLookups(text: string): boolean {
    return /\|\s*lu:/i.test(String(text || ''));
}

/** `value` through one `lu`: its result (the To's value, or the value itself), or why it fails. */
export function applyLookup(value: string, mod: LookupModifier, list: LookupTable[] = tables): ModifierResult {
    const table = list.find(t => t.name.trim().toLowerCase() === mod.table.trim().toLowerCase());
    if (!table) return { success: false, error: `there's no lookup table called ${mod.table}` };
    const from = lookupColumn(table, mod.from);
    if (!from) return { success: false, error: `${table.name} has no column called ${mod.from}` };
    const to = mod.to === undefined ? undefined : lookupColumn(table, mod.to);
    if (mod.to !== undefined && !to) return { success: false, error: `${table.name} has no column called ${mod.to}` };
    // ("any value not provided is flagged as invalid")
    if (value === '' || value === undefined || value === null) return { success: false, error: `needs a value from ${table.name}'s ${from.name} column` };
    const answer = lookupValue(table, from.id, value, to ? to.id : undefined);
    if (answer.kind === 'missing') return { success: false, error: `${value} isn't in ${table.name}'s ${from.name} column` };
    // (in two rows or more: the first row's, as Translate values does; the first row wins, 2026-11-23)
    if (to && answer.value === '') return { success: false, error: `${value}'s ${to.name} in ${table.name} is blank` };
    return { success: true, value: answer.value };
}
