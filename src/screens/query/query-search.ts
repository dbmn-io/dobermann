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

const { parseSearchExpression, matchesRow } = sharedScript<typeof searchMatcherScript>(searchMatcherScript, 'SearchMatcher');

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

/** A row's values as the search reads them: each column's text by its id, blank as nothing. */
export function searchTest(arg: SearchArg): (row: readonly unknown[]) => boolean {
    const terms = parseSearchExpression(arg.search);
    const cols = arg.cols;
    const get = (r: Record<string, unknown>, id: string) => r[id];
    return row => {
        const flat: Record<string, string> = {};
        for (let c = 0; c < cols.length; c++) flat[cols[c].id] = row[c] === null || row[c] === undefined ? '' : String(row[c]);
        return matchesRow(terms, flat, cols, get);
    };
}

/** The row tests Query's engine is given: the search box. */
export const QUERY_ROW_TESTS: RowTests = {
    search: arg => { const test = searchTest(arg as SearchArg); return (row: Value[]) => test(row); }
};
