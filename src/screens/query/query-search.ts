// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Results' search box, for the new engine: a row test the engine's filter step calls by name
 * (engine-types.ts RowTests), made of the one copy of the search rules, search-matcher.js (the
 * design system's). The held-rows search (query.controller.ts) reads the same columns the same way.
 */
import * as searchMatcherScript from '../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../utils/shared-script';
import type { RowTests, Value } from '../../services/engine/engine-types';
import type { ColumnRef } from '../../services/query/query-types';

/** planSearch's shape (search-matcher.js: a term's test depends on the value alone; rowMatches asks of the terms it needs). */
interface SearchPlan {
    terms: { columns: string[]; test(value: unknown): boolean }[];
    rowMatches(hit: (term: number) => boolean): boolean;
}
const { parseSearchExpression, planSearch } = sharedScript<typeof searchMatcherScript & { planSearch(parsed: unknown, columns: unknown[]): SearchPlan }>(searchMatcherScript, 'SearchMatcher');

/** A column as the search names it: by its name (@sku), and with its view's name (@stock.sku: that view's). */
export interface SearchColumn { id: string; name: string; type: string }

/** Results' columns as the search reads them. `letters`: each view's name by its id. */
export function searchColumns(columns: ColumnRef[], letters: Map<string, string>): SearchColumn[] {
    return columns.map((c, i) => {
        const letter = letters.get(c.view);
        return { id: letter ? `${letter}.${c.column}`.toLowerCase() : `c${i}`, name: c.column, type: 'string' };
    });
}

/** What the engine's "search" row test is given. */
export interface SearchArg { search: string; cols: SearchColumn[] }

/** Answers kept per term: past this many different texts, a term's answers are worked out again rather than kept. */
const KEPT_ANSWERS = 1_000_000;

/**
 * A row's values as the search reads them: each column's text by its id, blank as nothing. The search
 * taken apart once (search-matcher.js planSearch, the one copy of its rules), and each term's answer
 * kept per text: a text met again (a status, a description on many rows) is never tested again.
 */
export function searchTest(arg: SearchArg): (row: readonly unknown[]) => boolean {
    const cols = arg.cols;
    const plan = planSearch(parseSearchExpression(arg.search), cols);
    const at = new Map(cols.map((c, i) => [c.id, i]));
    // (by the value itself, a number or a text: its text made only the first time it is met; 42 and "42" are kept apart but answered alike)
    const answers = plan.terms.map(() => new Map<unknown, boolean>());
    // (each term's columns as places in the row, once)
    const places = plan.terms.map((t: { columns: string[] }) => t.columns.map(id => at.get(id) ?? -1));
    return row => plan.rowMatches((i: number) => {
        const term = plan.terms[i];
        const kept = answers[i];
        for (const c of places[i]) {
            const v = c < 0 || row[c] === null || row[c] === undefined ? '' : row[c];
            let hit = kept.get(v);
            if (hit === undefined) {
                hit = !!term.test(String(v));
                if (kept.size < KEPT_ANSWERS) kept.set(v, hit);
            }
            if (hit) return true;
        }
        return false;
    });
}

/** The row tests Query's engine is given: the search box. */
export const QUERY_ROW_TESTS: RowTests = {
    search: arg => { const test = searchTest(arg as SearchArg); return (row: Value[]) => test(row); }
};
