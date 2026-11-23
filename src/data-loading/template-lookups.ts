// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The lookup tables a request template's list and lookup types read (James, 2026-11-23:
 * `{{uom:list|uom:wms}}`, `{{uom:lookup|uom:tms>wms}}`; they replaced the `lu` function).
 *
 * Each host says once where its tables are (`useTemplateLookups`: the same store the Hub and Query
 * read), and the tables are read again before a run fills its template or Validate checks it
 * (`refreshTemplateLookups`), so an edit made a moment ago counts. Filling itself is synchronous
 * (modifier-executor.ts), so it reads what was last read here. Small: a table is up to 1,000 rows.
 *
 * The rule for a value is lookup-tables.ts lookupValue, the one Query's Translate values follows:
 * exact text, any column to any other. What `lu` adds: a value that is blank, not in the table,
 * whose To is blank, fails, and says why in words; one in it more than once takes the first row's
 * (the manager for James, 2026-11-23: "if we're looking up, we pick the first one").
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

/** Does a template use a list or lookup type anywhere (so the tables are worth reading first)? */
export function templateUsesLookups(text: string): boolean {
    return /:\s*(list|lookup)\s*\|/i.test(String(text || ''));
}

/** The lookup tables a template's list and lookup types name, lower case. */
export function lookupTablesNamed(text: string): Set<string> {
    return new Set(Array.from(String(text || '').matchAll(/:\s*(?:list|lookup)\s*\|\s*([^:|}"\s>]+)/gi), m => m[1].trim().toLowerCase()));
}

/** A list or lookup's valid values: its From column's (or its table's one column's), each once. */
export function lookupValuesOf(mod: LookupModifier, list: LookupTable[] = tables): string[] {
    const table = list.find(t => t.name.trim().toLowerCase() === mod.table.trim().toLowerCase());
    if (!table) return [];
    const from = mod.from ? lookupColumn(table, mod.from) : (table.columns.length === 1 ? table.columns[0] : undefined);
    if (!from) return [];
    return [...new Set(table.rows.map(r => r[from.id] ?? '').filter(v => v !== ''))];
}

/** `value` through one list or lookup: its result (the To's value, or the value itself), or why it fails. */
export function applyLookup(value: string, mod: LookupModifier, list: LookupTable[] = tables): ModifierResult {
    const table = list.find(t => t.name.trim().toLowerCase() === mod.table.trim().toLowerCase());
    if (!table) return { success: false, error: `there's no lookup table called ${mod.table}` };
    // (`list|uom`: a table of one column needs no column named; with more, it's said, never guessed)
    if (!mod.from && table.columns.length !== 1) {
        return { success: false, error: `${table.name} has more than one column: say which, e.g. ${mod.table}:${(table.columns[0] || { name: 'column' }).name.toLowerCase()}` };
    }
    const from = mod.from ? lookupColumn(table, mod.from) : table.columns[0];
    if (!from) return { success: false, error: `${table.name} has no column called ${mod.from}` };
    const to = mod.to === undefined ? undefined : lookupColumn(table, mod.to);
    if (mod.to !== undefined && !to) return { success: false, error: `${table.name} has no column called ${mod.to}` };
    // ("any value not provided is flagged as invalid")
    if (value === '' || value === undefined || value === null) return { success: false, error: `needs a value from ${table.name}'s ${from.name} column` };
    const answer = lookupValue(table, from.id, value, to ? to.id : undefined);
    if (answer.kind === 'missing') return { success: false, error: `${value} isn't in ${table.name}'s ${from.name} column` };
    // (in the From column more than once: the first row's, top to bottom; Validate notes it)
    if (to && answer.value === '') return { success: false, error: `${value}'s ${to.name} in ${table.name} is blank` };
    return { success: true, value: answer.value };
}
