// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Results' search box on the new engine (query-search.ts, a filter step by the "search" row test):
 * row for row the rows the held-rows search kept, which read each row through search-matcher.js
 * (the design system's rules) as below. Words, a column's value, OR, ranges, wildcards, blanks,
 * dates, numbers; in this thread and through a port, as in the web app's worker.
 *   npm run test:core
 */
import * as assert from 'assert';
import * as searchMatcherScript from '../../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../../utils/shared-script';
import { QueryEngine } from '../../../services/engine/engine';
import { remoteEngineHost, serveEngine, type EnginePort } from '../../../services/engine/engine-host';
import { loadView, readPage, runPaged } from '../../../services/query/query-new-engine';
import { resultColumns } from '../../../services/query/query-sql';
import type { QuerySpec } from '../../../services/query/query-types';
import { QUERY_ROW_TESTS, searchColumns } from '../../../screens/query/query-search';

const { parseSearchExpression, matchesRow } = sharedScript<typeof searchMatcherScript>(searchMatcherScript, 'SearchMatcher');

type Row = Record<string, unknown>;

const rows: Row[] = Array.from({ length: 3000 }, (_, i) => ({
    sku: i % 17 === 0 ? null : `SKU-${String(i).padStart(4, '0')}`,
    status: ['ACTIVE', 'HOLD', 'active', '', 'Closed'][i % 5],
    qty: i % 11 === 0 ? null : (i * 7) % 250,
    price: i % 3 ? (i % 90) + 0.5 : i % 90,
    when: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
    note: i % 9 === 0 ? 'Café crème' : i % 4 === 0 ? 'blue widget, large' : 'red widget'
}));
const spec: QuerySpec = { views: [{ id: 'inv', name: 'Inventory', columns: ['sku', 'status', 'qty', 'price', 'when', 'note'] }], joins: [], select: [] };
const SEARCHES = [
    'widget', 'red widget', 'blue, red', 'hold', '@status=ACTIVE', '@status=hold', '@qty>100', '@qty>=100 @qty<200', '@price=45.5',
    'SKU-00*', '@sku=SKU-01*', 'café', '@note=blue*', '@status=', '!@status=', '@when>2026-06-01', '@inventory.qty<10', '"large"', 'nothing-here-xyz', '42'
];

describe('Results\' search box on the new engine', () => {
    /** The held-rows search, as query.controller.ts read every row before (its loop, kept here as the reference). */
    function heldSearch(all: unknown[][], search: string): number[] {
        const terms = parseSearchExpression(search);
        const cols = searchColumns(resultColumns(spec), new Map([['inv', 'Inventory']]));
        const get = (r: Record<string, unknown>, id: string) => r[id];
        const out: number[] = [];
        all.forEach((row, i) => {
            const flat: Record<string, string> = {};
            for (let c = 0; c < cols.length; c++) flat[cols[c].id] = row[c] === null || row[c] === undefined ? '' : String(row[c]);
            if (matchesRow(terms, flat, cols, get)) out.push(i);
        });
        return out;
    }

    async function check(host: Parameters<typeof runPaged>[0]) {
        const everything = (await runPaged(host, spec))!;
        const all = await readPage(host, everything, 0, everything.total);
        const cols = searchColumns(resultColumns(spec), new Map([['inv', 'Inventory']]));
        const counts: string[] = [];
        for (const search of SEARCHES) {
            const want = heldSearch(all, search).map(i => all[i]);
            const found = (await runPaged(host, spec, null, undefined, { search, cols }))!;
            const got = await readPage(host, found, 0, found.total);
            assert.deepStrictEqual(got, want, `"${search}": ${got.length} rows, the held search ${want.length}`);
            counts.push(`${search}=${got.length}`);
        }
        // (the searches find something, most of them, so the comparison is not empty against empty)
        assert.ok(counts.filter(c => !c.endsWith('=0')).length >= SEARCHES.length - 3, counts.join(' '));
    }

    it('row for row the rows the held search kept, for every kind of search', async () => {
        const engine = new QueryEngine(undefined, QUERY_ROW_TESTS);
        loadView(engine, 'inv', spec.views[0].columns, rows);
        await check(engine);
    });

    it('the same through a port, as in the web app\'s worker; a search the engine has no test for is refused', async () => {
        const handlers: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
        const port = (me: 0 | 1): EnginePort => ({
            post: message => { const copy = JSON.parse(JSON.stringify(message)); setTimeout(() => handlers[1 - me].forEach(h => h(copy)), 0); },
            listen: handler => { handlers[me].push(handler); }
        });
        const engine = new QueryEngine(undefined, QUERY_ROW_TESTS);
        loadView(engine, 'inv', spec.views[0].columns, rows);
        serveEngine(port(1), engine);
        await check(remoteEngineHost(port(0)));
        const bare = new QueryEngine();
        loadView(bare, 'inv', spec.views[0].columns, rows);
        await assert.rejects(runPaged(bare, spec, null, undefined, { search: 'x', cols: [] }), /no row test "search"/);
    });
});
