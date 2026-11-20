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
import { alignCompareJoins, groupCompare, isCompare, queryCompare, runJoin } from '../../../services/query/query-compare';
import { nextRunName, runName } from '../../../services/query/query-store';
import type { QuerySource } from '../../../services/query/query-store';
import { compareKeySql, defaultColumns, formulaColumns, lookupsUsed, resultColumns, writeSql } from '../../../services/query/query-sql';
import { passes, rowStatus, statusCounts } from '../../../services/query/query-status';
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

    it('groups views read the same way: making a join a Compare brings them in, and the key is picked once', () => {
        // Four results of one endpoint through one View, and a fifth view of another endpoint
        const inv = (id: string) => ({ id, endpointId: 'inv', view: 'Default', columns: ['GTIN', 'onHand'] });
        const views = [{ ...inv('a'), columns: ['gtin', 'onHand'] }, inv('b'), inv('c'), inv('d'), { id: 'p', endpointId: 'prd', view: 'Default', columns: ['gtin'] }];
        const blank = (view: string): QueryJoin => ({ view, kind: 'left', on: [] });
        const js: QueryJoin[] = [{ view: 'b', kind: 'compare', on: [] }, blank('c'), blank('d'), blank('p')];
        groupCompare(js, views, true);
        assert.deepStrictEqual(js.map(j => j.kind), ['compare', 'compare', 'compare', 'left'], 'the same-shaped views come in; the other endpoint does not');
        // The Baseline's key picked once: each same-shaped view takes its own column of that name (any case)
        js[0].on = [{ left: col('a', 'gtin'), right: { parts: [] } }];
        alignCompareJoins(js);
        groupCompare(js, views, false);
        assert.deepStrictEqual(js.slice(0, 3).map(j => j.on[0].right.parts[0]?.column), ['GTIN', 'GTIN', 'GTIN']);
        assert.deepStrictEqual(js.slice(0, 3).map(j => j.on[0].left.parts[0]?.column), ['gtin', 'gtin', 'gtin']);
        // A column picked by hand stays
        js[1].on[0].right = col('c', 'onHand');
        groupCompare(js, views, false);
        assert.strictEqual(js[1].on[0].right.parts[0].column, 'onHand');
        // A view already joined by hand is never pulled in
        const mine: QueryJoin[] = [{ view: 'b', kind: 'compare', on: [] }, { view: 'c', kind: 'left', on: [{ left: col('a', 'gtin'), right: col('c', 'GTIN') }] }];
        groupCompare(mine, views, true);
        assert.strictEqual(mine[1].kind, 'left');
    });

    it('a compare starts with its key only: what is compared is picked', () => {
        const spec: QuerySpec = {
            views: [{ id: 'stk', name: 'Stock', columns: ['sku', 'qty'] }, { id: 'itm', name: 'Items', columns: ['itemCode', 'qty'] }],
            joins: [{ view: 'itm', kind: 'compare', on: [{ left: col('stk', 'sku'), right: col('itm', 'itemCode') }] }],
            select: []
        };
        assert.deepStrictEqual(defaultColumns(spec), [{ view: 'stk', column: 'sku' }]);
        // A query: every column, as before
        assert.ok(defaultColumns({ ...spec, joins: [{ ...spec.joins[0], kind: 'left' }] }).length > 1);
    });

    describe('Results\' Status', () => {
        it('a row is DIFF where a compared column\'s cells differ, Missing where a view has no record, else Same', async () => {
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
                select: [{ view: 'stk', column: 'sku' }, { view: 'stk', column: 'qty', group: 'qty' }, { view: 'itm', column: 'qty', group: 'qty' }, { view: 'cnt', column: 'qty', group: 'qty' }]
            };
            const s = new QuerySession(SQL, spec);
            await s.load('stk', [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);
            await s.load('itm', [{ itemCode: 'A', qty: 1, supplier: 1 }, { itemCode: 'B', qty: 5, supplier: 1 }]);
            await s.load('cnt', [{ SKU: 'A', qty: 1 }, { SKU: 'C', qty: 4 }]);
            await s.load('sup', [{ id: 1, name: 'Bark & Co' }]);
            const columns = resultColumns(spec);
            const keys = compareKeySql(spec);
            assert.deepStrictEqual(keys.map(k => k.view), ['stk', 'itm', 'cnt']);
            const out = s.rows({ extra: keys.map(k => k.sql) });
            const rows = out.rows.map(r => r.slice(0, columns.length));
            const keyValues = out.rows.map(r => r.slice(columns.length));
            const names: Record<string, string> = { stk: 'Stock', itm: 'Items', cnt: 'Counts' };
            const places = keys.map(k => names[k.view]);
            const status = rowStatus(columns, rows, places, keyValues, v => names[v])!;
            const bySku = new Map(rows.map((r, i) => [r[0] ?? '-', status.rows[i]]));
            assert.deepStrictEqual(bySku.get('A'), { diff: [], missing: [], groups: [], relation: 'oneToOne' });
            // B: Items has another qty; the count has no B
            assert.deepStrictEqual(bySku.get('B'), { diff: ['Items'], missing: ['Counts'], groups: ['qty'], relation: 'onlyBase' });
            // C: only the count has it
            assert.deepStrictEqual(bySku.get('-'), { diff: [], missing: ['Stock', 'Items'], groups: [], relation: 'onlyOther' });
            assert.deepStrictEqual(status.places, ['Stock', 'Items', 'Counts']);
            // Filters as Compare's: DIFF ticked alone, Missing in Counts alone, the qty column's DIFFs
            const kept = (f: Parameters<typeof passes>[1]) => rows.filter((_, i) => passes(status.rows[i], f)).map(r => r[0] ?? '-').sort();
            assert.deepStrictEqual(kept({ kinds: ['diff'] }), ['B']);
            assert.deepStrictEqual(kept({ kinds: ['missing:Counts'] }), ['B']);
            assert.deepStrictEqual(kept({ kinds: ['same'] }), ['A']);
            assert.deepStrictEqual(kept({ columns: ['qty'] }), ['B']);
            assert.deepStrictEqual(kept({ relations: ['onlyOther'] }), ['-']);
            const counts = statusCounts(status.rows, rows.map((_, i) => i));
            assert.deepStrictEqual([counts.diff, counts.same, counts.missing.Counts, counts.columns.qty], [1, 1, 1, 1]);
            // Items hidden: B's qty differs only in Items, so it is no longer DIFF
            const hid = rowStatus(columns, rows, places, keyValues, v => names[v], ['Items'])!;
            assert.deepStrictEqual(hid.rows[rows.findIndex(r => r[0] === 'B')].diff, []);
            s.close();
        });
        it('a COMPARE calculation is a column per side in Results, under its name', () => {
            const spec: QuerySpec = {
                views: [{ id: 'stk', name: 'Stock', columns: ['sku', 'onHand', 'available'] }],
                joins: [],
                select: [{ view: 'stk', column: 'sku' }, { view: '', column: 'qty' }],
                calc: [{ name: 'qty', expr: '', formula: 'COMPARE(@Stock.onHand, @Stock.available)' }]
            };
            assert.deepStrictEqual(resultColumns(spec), [{ view: 'stk', column: 'sku' }, { view: '', column: 'qty 1', group: 'qty' }, { view: '', column: 'qty 2', group: 'qty' }]);
            const st = rowStatus(resultColumns(spec), [['A', 5, 5], ['B', 5, 3]], [], [], v => v)!;
            assert.deepStrictEqual(st.rows, [{ diff: [], missing: [], groups: [] }, { diff: ['2'], missing: [], groups: ['qty'] }]);
        });
        it('a key on more than one row: one to many, and where it repeats', () => {
            const cols = [{ view: 'a', column: 'k' }, { view: 'a', column: 'q', group: 'q' }, { view: 'b', column: 'q', group: 'q' }];
            const st = rowStatus(cols, [['X', 1, 1], ['X', 1, 2], ['Y', 3, 3]], ['A', 'B'], [['X', 'X'], ['X', 'X'], ['Y', 'Y']], v => v.toUpperCase())!;
            assert.deepStrictEqual(st.rows.map(r => r.relation), ['oneToMany', 'oneToMany', 'oneToOne']);
            assert.deepStrictEqual(st.rows[0].repeated, ['A', 'B']);
        });
        it('nothing compared: no status', () => {
            assert.strictEqual(rowStatus([{ view: 'stk', column: 'sku' }], [['A']], [], [], v => v), undefined);
        });
    });

    it('Translate values: a lookup table\'s from column becomes its to column; a value it hasn\'t stays', async () => {
        const spec: QuerySpec = {
            views: [{ id: 'itm', name: 'Items', columns: ['sku', 'uom'] }],
            joins: [],
            select: [{ view: 'itm', column: 'sku' }, { view: 'itm', column: 'uom', fns: [{ fn: 'translate', table: 'units', from: 'erp', to: 'wms' }] }]
        };
        assert.deepStrictEqual(lookupsUsed(spec), ['units']);
        const s = new QuerySession(SQL, spec);
        await s.load('itm', [{ sku: 'A', uom: 'each' }, { sku: 'B', uom: 'case' }, { sku: 'C', uom: 'box' }, { sku: 'D', uom: null }]);
        s.loadLookup({ id: 'units', columns: [{ id: 'erp' }, { id: 'wms' }, { id: 'fin' }], rows: [{ erp: 'each', wms: 'EA', fin: 'UNIT' }, { erp: 'case', wms: 'CS', fin: 'CASE' }] });
        assert.deepStrictEqual(s.run(writeSql(spec)).rows.map(r => r[1]), ['EA', 'CS', 'box', null]);
        // To another column of the same table: Finance's
        const fin: QuerySpec = { ...spec, select: [{ view: 'itm', column: 'uom', fns: [{ fn: 'translate', table: 'units', from: 'erp', to: 'fin' }] }] };
        s.setSpec(fin);
        assert.deepStrictEqual(s.run(writeSql(fin)).rows.map(r => r[0]), ['UNIT', 'CASE', 'box', null]);
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

