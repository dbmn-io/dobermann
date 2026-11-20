// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A compare inside Query (src/services/query/query-compare.ts): Compare joins line every view up
 * on the Baseline's key, every record of every view kept, a record later views have and the
 * Baseline hasn't still one row.
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { QuerySession } from '../../../services/query/query-engine';
import { alignCompareJoins, isCompare, queryCompare, runJoin } from '../../../services/query/query-compare';
import { nextRunName, runName } from '../../../services/query/query-store';
import type { QuerySource } from '../../../services/query/query-store';
import { formulaColumns } from '../../../services/query/query-sql';
import { resolvePath, shortRef } from '../../../services/query/formula';
import type { QueryJoin, QueryKey, QuerySpec } from '../../../services/query/query-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

const col = (view: string, column: string): QueryKey => ({ parts: [{ view, column }] });

/** Stock (the Baseline), Items and a count, compared on sku; Suppliers joined to Items, to show. */
function joins(): QueryJoin[] {
    return [
        { view: 'itm', kind: 'compare', on: [{ left: col('stk', 'sku'), right: col('itm', 'itemCode') }] },
        // Its left side is wrong on purpose: one key across the compare puts Stock's sku there
        { view: 'cnt', kind: 'compare', on: [{ left: col('itm', 'itemCode'), right: col('cnt', 'SKU') }] },
        { view: 'sup', kind: 'left', on: [{ left: col('itm', 'supplier'), right: col('sup', 'id') }] }
    ];
}

describe('A compare inside Query', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    it('is a compare while a join is a Compare; its Baseline is the first one\'s left view', () => {
        const j = joins();
        assert.ok(isCompare(j));
        assert.deepStrictEqual(queryCompare(j), { baseline: 'stk', views: ['stk', 'itm', 'cnt'] });
        assert.strictEqual(queryCompare(j.map(x => ({ ...x, kind: 'left' as const }))), undefined);
    });

    it('puts one key across the compare: a later Compare joins on the first one\'s key', () => {
        const j = joins();
        alignCompareJoins(j);
        assert.deepStrictEqual(j[1].on[0].left, col('stk', 'sku'));
        assert.deepStrictEqual(j[1].on[0].right, col('cnt', 'SKU'));
        // The first one's key has two columns: the later one gets the second, its own side still to pick
        j[0].on.push({ left: col('stk', 'site'), right: col('itm', 'site') });
        alignCompareJoins(j);
        assert.deepStrictEqual(j[1].on.map(p => p.left), [col('stk', 'sku'), col('stk', 'site')]);
        assert.deepStrictEqual(j[1].on[1].right, { parts: [{ view: 'cnt', column: '' }] });
        // A plain join is left as it is
        assert.deepStrictEqual(j[2].on[0].left, col('itm', 'supplier'));
    });

    it('keeps every record of every view, one row a record, whichever views have it', async () => {
        const j = joins();
        alignCompareJoins(j);
        const spec: QuerySpec = {
            views: [
                { id: 'stk', name: 'Stock', columns: ['sku', 'qty'] },
                { id: 'itm', name: 'Items', columns: ['itemCode', 'qty', 'supplier'] },
                { id: 'cnt', name: 'Counts', columns: ['SKU', 'qty'] },
                { id: 'sup', name: 'Suppliers', columns: ['id', 'name'] }
            ],
            joins: j,
            select: [{ view: 'stk', column: 'sku' }, { view: 'itm', column: 'itemCode' }, { view: 'cnt', column: 'SKU' }, { view: 'sup', column: 'name' }]
        };
        const s = new QuerySession(SQL, spec);
        await s.load('stk', [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);
        await s.load('itm', [{ itemCode: 'A', qty: 1, supplier: 1 }, { itemCode: 'C', qty: 3, supplier: 2 }]);
        await s.load('cnt', [{ SKU: 'A', qty: 1 }, { SKU: 'C', qty: 4 }, { SKU: 'D', qty: 5 }]);
        await s.load('sup', [{ id: 1, name: 'Bark & Co' }, { id: 2, name: 'Whisker Supply' }]);
        const sql = s.sql();
        assert.match(sql, /FULL OUTER JOIN Items\s+ON Items\.itemCode = Stock\.sku/);
        assert.match(sql, /FULL OUTER JOIN Counts\s+ON Counts\.SKU = COALESCE\(Stock\.sku, Items\.itemCode\)/);
        const rows = s.rows().rows.map(r => r.map(v => v ?? '-').join(' ')).sort();
        // C: Items and the count have it, Stock hasn't; still one row
        assert.deepStrictEqual(rows, ['- - D -', '- C C Whisker Supply', 'A A A Bark & Co', 'B - - -']);
        assert.strictEqual(s.rowsAfterJoin(0), 3);
        assert.strictEqual(s.rowsAfterJoin(1), 4);
        assert.strictEqual(s.joinStats(1).rowsAfter, 4);
        assert.strictEqual(s.count(), 4);
        s.close();
    });

    describe('runs of a view', () => {
        const source = (id: string, extra: Partial<QuerySource> = {}): QuerySource => ({ id, name: id === 'bl' ? 'Stock' : `Stock_${extra.run}`, endpointId: 'e', endpointName: 'Stock', view: 'Default', executionId: id, isBatch: false, environment: 'vic', executedAt: '', ...extra });

        it('names them: the first BL once it has runs, then C1, C2, never one taken', () => {
            const q = { sources: [source('bl')] };
            assert.strictEqual(runName(q, 'bl'), '');
            assert.strictEqual(nextRunName(q, 'bl'), 'C1');
            q.sources.push(source('c1', { runOf: 'bl', run: 'C1' }), source('c3', { runOf: 'bl', run: 'C3' }));
            assert.strictEqual(runName(q, 'bl'), 'BL');
            assert.strictEqual(runName(q, 'c3'), 'C3');
            assert.strictEqual(nextRunName(q, 'bl'), 'C2');
        });

        it('a run joins as a Compare on its first run\'s key: the same column, its own table', () => {
            const j: QueryJoin[] = [];
            // Before there is a compare: the first run's column is still to pick
            j.push(runJoin(j, 'c1', 'bl'));
            assert.strictEqual(j[0].kind, 'compare');
            assert.deepStrictEqual(queryCompare(j), { baseline: 'bl', views: ['bl', 'c1'] });
            // Its column picked on the first run: the run's is the same
            j[0].on[0].left = col('bl', 'sku');
            const runs = new Map([['c1', 'bl'], ['c2', 'bl']]);
            alignCompareJoins(j, runs);
            assert.deepStrictEqual(j[0].on[0].right, col('c1', 'sku'));
            // A second run joins on the compare's key, and gets the same column too
            j.push(runJoin(j, 'c2', 'bl'));
            alignCompareJoins(j, runs);
            assert.deepStrictEqual(j[1].on[0], { left: col('bl', 'sku'), right: col('c2', 'sku') });
            // Before a compare, a run takes the column its view already joins on
            const plain: QueryJoin[] = [{ view: 'itm', kind: 'left', on: [{ left: col('bl', 'gtin'), right: col('itm', 'gtin') }] }];
            const r = runJoin(plain, 'c9', 'bl');
            assert.deepStrictEqual(r.on.map(p => p.left), [col('bl', 'gtin')]);
            // A run can't be made a plain join: runs are always matched
            j[1].kind = 'left';
            alignCompareJoins(j, runs);
            assert.strictEqual(j[1].kind, 'compare');
        });

        it('a run is a level of a formula\'s path: @C1.quantityOnHand', () => {
            const spec: QuerySpec = {
                views: [
                    { id: 'bl', name: 'Stock', columns: ['sku', 'quantityOnHand'], run: 'BL', runOfName: 'Stock' },
                    { id: 'c1', name: 'Stock_C1', columns: ['sku', 'quantityOnHand'], run: 'C1', runOfName: 'Stock' }
                ],
                joins: [], select: []
            };
            const cols = formulaColumns(spec);
            assert.deepStrictEqual(cols.map(c => c.path.join('.')), ['Stock.BL.sku', 'Stock.BL.quantityOnHand', 'Stock.C1.sku', 'Stock.C1.quantityOnHand']);
            assert.strictEqual(resolvePath(['quantityOnHand'], cols).length, 2);
            assert.strictEqual(shortRef(cols[3], cols), '@C1.quantityOnHand');
        });
    });
});

