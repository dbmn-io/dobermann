// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's compare on the new engine (query-new-engine.ts) against the same compare on SQLite
 * (QuerySession), where their rules agree: keys each once, no blank keys. Results' rows, each row's
 * keys and status, the Join step's figures; then what only the engine does (repeats compared one
 * to many, blank keys their own rows), what keeps a query on SQLite, and the column functions.
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { COLUMN_FUNCTIONS, columnFnSql, type ColumnFn } from '../../../services/column-functions/column-functions';
import { QueryEngine } from '../../../services/engine/engine';
import { QuerySession } from '../../../services/query/query-engine';
import { buildQuery, runOnEngine, TooManyOnEngine, compareKeyExprs, compareQuery, fnExpr, fnSampleQueries, formulaExpr, labelExpr, loadLookupTable, loadView, queryWithColumns, recordQuery, resultRows, onSqliteLine, runCompareOnEngine, whyNotOnEngine } from '../../../services/query/query-new-engine';
import { formulaSql, parseFormula, FORMULA_FUNCTIONS } from '../../../services/query/formula';
import type { Value } from '../../../services/engine/engine-types';
import { compareKeySql, resultColumns } from '../../../services/query/query-sql';
import { rowStatus } from '../../../services/query/query-status';
import type { QueryKey, QuerySpec } from '../../../services/query/query-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

type Row = Record<string, unknown>;

/** Three runs of a stock view (BL, C1, C2) compared on sku, qty and status compared. */
function runsSpec(): QuerySpec {
    const view = (id: string, run: string) => ({ id, name: `stock ${run}`, run, columns: ['sku', 'qty', 'status'] });
    return {
        views: [view('bl', 'BL'), view('c1', 'C1'), view('c2', 'C2')],
        joins: ['c1', 'c2'].map(v => ({ view: v, kind: 'compare' as const, on: [{ left: { parts: [{ view: 'bl', column: 'sku' }] }, right: { parts: [{ view: v, column: 'sku' }] } }] })),
        select: [
            { view: 'bl', column: 'sku' },
            ...['bl', 'c1', 'c2'].map(v => ({ view: v, column: 'qty', group: 'qty' })),
            ...['bl', 'c1', 'c2'].map(v => ({ view: v, column: 'status', group: 'status' }))
        ]
    };
}

/** Rows with each key once: some missing from a run, some only in one, some values different. */
function runRows(run: number, n: number): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
        if ((i + run) % 7 === 0) continue;
        rows.push({ sku: i % 5 === 0 ? i : `SKU-${i}`, qty: (i * 3 + (i % 11 === 0 ? run : 0)) % 50, status: i % 13 === run ? 'HOLD' : 'OK' });
    }
    if (run) rows.push({ sku: `ONLY-${run}`, qty: 1, status: 'OK' });
    return rows;
}

describe('Query compare on the new engine', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    async function both(spec: QuerySpec, data: Record<string, Row[]>) {
        const session = new QuerySession(SQL, spec);
        for (const v of spec.views) await session.load(v.id, data[v.id]);
        const columns = resultColumns(spec);
        const keys = compareKeySql(spec);
        const out = session.rows({ extra: keys.map(k => k.sql) });
        const sqlite = { rows: out.rows.map(r => r.slice(0, columns.length)), keyValues: out.rows.map(r => r.slice(columns.length)) };
        session.close();
        const engine = new QueryEngine();
        for (const v of spec.views) loadView(engine, v.id, v.columns, data[v.id]);
        const ours = (await runCompareOnEngine(engine, spec))!;
        return { sqlite, ours, columns };
    }

    it('a compare of runs, each key once: the same rows, keys and statuses as SQLite; the figures the Join step reads', async () => {
        const spec = runsSpec();
        const data = { bl: runRows(0, 400), c1: runRows(1, 400), c2: runRows(2, 400) };
        const { sqlite, ours, columns } = await both(spec, data);
        const sorted = (r: { rows: unknown[][]; keyValues: unknown[][] }) => r.rows.map((row, i) => JSON.stringify([row, r.keyValues[i]])).sort();
        assert.strictEqual(ours.total, sqlite.rows.length);
        assert.deepStrictEqual(sorted(ours), sorted(sqlite));
        const label = (v: string) => v;
        const status = (r: { rows: unknown[][]; keyValues: unknown[][] }) => {
            const st = rowStatus(columns, r.rows, ['bl', 'c1', 'c2'], r.keyValues, label)!;
            return r.rows.map((row, i) => JSON.stringify([row, st.rows[i]])).sort();
        };
        assert.deepStrictEqual(status(ours), status(sqlite));
        // The Join step's figures: C1 against the Baseline
        const c1 = ours.stats.get('c1')!;
        const inBl = new Set(data.bl.map(r => JSON.stringify(r.sku)));
        assert.strictEqual(c1.rightRows, data.c1.length);
        assert.strictEqual(c1.rightMatched, data.c1.filter(r => inBl.has(JSON.stringify(r.sku))).length);
        assert.strictEqual(c1.rowsAfter, ours.total);
        // The Baseline's, against the whole compare: its records no other run has
        const elsewhere = new Set([...data.c1, ...data.c2].map(r => JSON.stringify(r.sku)));
        assert.strictEqual(c1.leftRows - c1.leftMatched, data.bl.filter(r => !elsewhere.has(JSON.stringify(r.sku))).length);
    });

    it('a key of two columns joined with a separator: the keys Results reads as SQL joins them', async () => {
        const spec = runsSpec();
        spec.views.forEach(v => v.columns.push('loc'));
        spec.joins.forEach(j => {
            j.on = [{ left: { parts: [{ view: 'bl', column: 'sku' }, { view: 'bl', column: 'loc' }], separator: '/' }, right: { parts: [{ view: j.view, column: 'sku' }, { view: j.view, column: 'loc' }], separator: '/' } }];
        });
        const data = {
            bl: [{ sku: 'A', loc: 1, qty: 1, status: 'OK' }, { sku: 'A', loc: 2, qty: 2, status: 'OK' }],
            c1: [{ sku: 'A', loc: 2, qty: 3, status: 'OK' }],
            c2: [{ sku: 'B', loc: 1, qty: 1, status: 'OK' }]
        };
        const { sqlite, ours } = await both(spec, data);
        const sorted = (r: { rows: unknown[][]; keyValues: unknown[][] }) => r.keyValues.map(k => JSON.stringify(k)).sort();
        assert.deepStrictEqual(sorted(ours), sorted(sqlite));
    });

    it('what only the engine does: the one compared with each of the many, a Baseline that repeats included; a blank key its own row', async () => {
        const spec = runsSpec();
        const data = {
            bl: [{ sku: 'A', qty: 1, status: 'OK' }, { sku: 'R', qty: 1, status: 'OK' }, { sku: 'R', qty: 2, status: 'OK' }, { sku: null, qty: 9, status: 'OK' }],
            c1: [{ sku: 'A', qty: 1, status: 'OK' }, { sku: 'A', qty: 5, status: 'OK' }, { sku: 'R', qty: 1, status: 'OK' }, { sku: null, qty: 9, status: 'OK' }],
            c2: [{ sku: 'A', qty: 1, status: 'OK' }, { sku: 'R', qty: 2, status: 'OK' }]
        };
        const engine = new QueryEngine();
        for (const v of spec.views) loadView(engine, v.id, v.columns, data[v.id as keyof typeof data]);
        const ours = (await runCompareOnEngine(engine, spec))!;
        // A: BL once, C1 twice: two rows, BL's and C2's record on each. R: BL twice, C1 once. Blank keys: one row each
        assert.deepStrictEqual(ours.rows.map(r => [r[0], r[1], r[2], r[3]]), [
            ['A', 1, 1, 1], ['A', 1, 5, 1],
            ['R', 1, 1, 2], ['R', 2, 1, 2],
            [null, 9, null, null],
            [null, null, 9, null]
        ]);
        assert.deepStrictEqual(ours.keyValues.slice(4), [[null, null, null], [null, null, null]]);
        const c1 = ours.stats.get('c1')!;
        assert.deepStrictEqual([c1.rightRows, c1.rightMatched, c1.records.oneToOne, c1.records.oneToMany, c1.keys.oneToMany], [4, 3, 0, 3, 2]);
        // The Baseline repeats R: said on every join's left, against the whole compare
        assert.deepStrictEqual([c1.keys.manyToOne, c1.rows.manyToOne, c1.leftRows - c1.leftMatched], [1, 2, 1]);
    });

    it('a query stays on SQLite, and says why, when it is more than a compare', () => {
        const spec = runsSpec();
        assert.strictEqual(whyNotOnEngine(spec), undefined);
        assert.strictEqual(whyNotOnEngine({ ...spec, joins: [] }), 'it is not a compare');
        assert.strictEqual(whyNotOnEngine({ ...spec, joins: [...spec.joins, { view: 'x', kind: 'left', on: [] }] }), 'it has a join besides the compare');
        assert.strictEqual(whyNotOnEngine({ ...spec, calc: [{ name: 'd', expr: '1' }] }), 'it has a calculated column');
        assert.strictEqual(whyNotOnEngine({ ...spec, distinct: true }), 'Distinct is on');
        // (Translate values runs on the engine: its lookup table is loaded into it)
        assert.strictEqual(whyNotOnEngine({ ...spec, select: [{ view: 'bl', column: 'sku', fns: [{ fn: 'translate', table: 't', from: 'a', to: 'b' }] }] }), undefined);
        assert.strictEqual(onSqliteLine('it has a calculated column'), 'New compare engine (testing): this query runs on the old engine, because it has a calculated column.');
        assert.deepStrictEqual(compareQuery(spec).layout.places, ['bl', 'c1', 'c2']);
    });

    it('each column function gives what SQLite gives, but for the engine\'s listed differences', async () => {
        const values: unknown[] = [null, '', 'abc', ' a b ', '0042', '007-X', 42, 1.5, 'Café', '12abc'];
        const fns: ColumnFn[] = [
            ...COLUMN_FUNCTIONS.filter(d => !d.sql.some(p => typeof p === 'object')).map(d => ({ fn: d.id }) as ColumnFn),
            { fn: 'lower' }, { fn: 'first', n: 2 }, { fn: 'last', n: 3 }, { fn: 'replace', from: '-', to: '' }
        ];
        const db = new SQL.Database();
        db.run('CREATE TABLE t (x)');
        values.forEach(v => db.run('INSERT INTO t VALUES (?)', [v as string | number | null]));
        const engine = new QueryEngine();
        engine.load('t', { columns: ['x'], rows: values.map(v => [v as string | number | null]) });
        for (const f of fns) {
            const want = db.exec(`SELECT ${columnFnSql('x', [f])} FROM t`)[0].values.map(r => r[0]);
            const out = await engine.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'y', value: fnExpr({ column: 'x' }, f) }] }] });
            assert.ok('result' in out);
            const got = engine.read(out.result, 0, 99).rows.map(r => r[0]);
            // The listed differences (engine-types.ts): As a number reads text by the one rule; Upper/Lower every letter
            const expected = want.map((w, i) => {
                const v = values[i];
                if (f.fn === 'number' && typeof v === 'string') return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v) ? Number(v.trim()) : null;
                if ((f.fn === 'upper' || f.fn === 'lower') && typeof v === 'string') return f.fn === 'upper' ? v.toUpperCase() : v.toLowerCase();
                return w;
            });
            assert.deepStrictEqual(got, expected, f.fn);
        }
        db.close();
    });

    it('a calculated column\'s formula on the engine gives what its SQL gives, every builder function, but for the listed differences', async () => {
        // Values that read the same by SQLite's leading-number rule and the engine's one rule (difference 2), plain letters only (difference 4)
        const values: Value[] = [null, 0, 1, -7, 2.5, 100, 'abc', 'Abc d', ' x ', '0042', '7', '1.5', ''];
        const plain = (v: Value) => typeof v !== 'string' || /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v);
        const rows: Value[][] = [];
        for (const a of values) for (const b of values) rows.push([a, b]);
        const columns = [{ key: 'a', path: ['t', 'a'] }, { key: 'b', path: ['t', 'b'] }];
        // [formula, does it read its values as numbers]: those are given only rows whose text is a plain number
        const formulas: [string, boolean][] = [
            ['@a + @b', true], ['@a - @b', true], ['@a * @b', true], ['@a / @b', true], ['-@a', true],
            ['@a = @b', false], ['@a <> @b', false], ['@a > @b', false], ['@a < @b', false], ['@a >= @b', false], ['@a <= @b', false],
            ['IF(@a > 1, "big", "small")', false], ['IF(@a = @b, 1)', false], ['IFBLANK(@a, @b)', false],
            ['AND(@a > 0, @b > 0)', false], ['OR(@a > 0, @b > 0)', false], ['NOT(@a > 0)', false],
            ['ROUND(@a * 1.25, 1)', true], ['ROUND(@a)', true], ['ABS(@a)', true], ['FLOOR(@a / 3)', true], ['CEIL(@a / 3)', true],
            ['MIN(@a, @b)', false], ['MAX(@a, @b)', false],
            ['CONCAT(@a, " · ", @b)', false], ['UPPER(@a)', false], ['LOWER(@a)', false], ['TRIM(@a)', false],
            ['LEFT(@a, 2)', false], ['RIGHT(@a, 2)', false], ['SUBSTR(@a, 2, 2)', false], ['REPLACE(@a, "b", "B")', false], ['LENGTH(@a)', false],
            ['NUMBER(@a)', true], ['TEXT(@a)', false]
        ];
        // Every builder function is in the list (COMPARE is columns, not a value)
        const used = new Set(formulas.flatMap(([f]) => [...f.matchAll(/([A-Z]+)\(/g)].map(m => m[1])));
        assert.deepStrictEqual(FORMULA_FUNCTIONS.map(f => f.name).filter(n => n !== 'COMPARE' && !used.has(n)), []);
        const db = new SQL.Database();
        db.run('CREATE TABLE t (a, b)');
        rows.forEach(r => db.run('INSERT INTO t VALUES (?, ?)', r as (string | number | null)[]));
        const engine = new QueryEngine();
        engine.load('t', { columns: ['a', 'b'], rows });
        const wrong: string[] = [];
        for (const [text, numeric] of formulas) {
            const tree = parseFormula(text, columns).tree;
            const want = db.exec(`SELECT ${formulaSql(tree, key => key)} FROM t`)[0].values.map(r => r[0]);
            const out = await engine.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'y', value: formulaExpr(tree, key => ({ column: key })) }] }] });
            assert.ok('result' in out, `${text}: ${JSON.stringify(out)}`);
            const got = engine.read(out.result, 0, rows.length).rows.map(r => r[0]);
            rows.forEach((r, i) => {
                if (numeric && !(plain(r[0]) && plain(r[1]))) return;
                const w = want[i], g = got[i];
                if (!(Object.is(w, g) || (typeof w === 'number' && w === g))) wrong.push(`${text} on ${JSON.stringify(r)}: SQL ${JSON.stringify(w)}, engine ${JSON.stringify(g)}`);
            });
        }
        db.close();
        assert.deepStrictEqual(wrong.slice(0, 8), [], `${wrong.length} values differ`);
    });

    describe('any query on the engine: the same rows as its SQL', () => {
        const data: Record<string, Row[]> = {
            inv: [
                { sku: 'A1', gtin: 'G1', qty: 5, loc: 'L1', part: 'x' }, { sku: 'A2', gtin: 'G2', qty: 0, loc: 'L2', part: 'y' },
                { sku: 'A3', gtin: 'G2', qty: 7, loc: null, part: 'x' }, { sku: 'A4', gtin: null, qty: 1, loc: 'L1', part: 'z' },
                { sku: 'A5', gtin: 'g1', qty: 2, loc: 'L9', part: 'x' }, { sku: 'A6', gtin: 'G9', qty: 3, loc: 'L2', part: 'y' }
            ],
            prod: [
                { gtin: 'G1', name: 'Bone', code: 'G1-x' }, { gtin: 'G2', name: 'Ball', code: 'G2-y' }, { gtin: 'G2', name: 'Ball (old)', code: 'G2-x' },
                { gtin: 'G3', name: 'Lead', code: 'G3-x' }, { gtin: null, name: 'Nothing', code: null }
            ],
            loc: [{ gln: 'L1', site: 'North' }, { gln: 'L2', site: 'South' }, { gln: 'L7', site: 'West' }]
        };
        const views = [
            { id: 'inv', name: 'inv', columns: ['sku', 'gtin', 'qty', 'loc', 'part'] },
            { id: 'prod', name: 'prod', columns: ['gtin', 'name', 'code'] },
            { id: 'loc', name: 'loc', columns: ['gln', 'site'] }
        ];
        const key = (view: string, column: string, fns?: QuerySpec['select'][number]['fns']): QueryKey => ({ parts: [{ view, column, ...(fns ? { fns } : {}) }] });

        async function same(spec: QuerySpec, label: string) {
            const session = new QuerySession(SQL, spec);
            for (const v of spec.views) await session.load(v.id, data[v.id]);
            const want = session.rows().rows.map(r => JSON.stringify(r)).sort();
            session.close();
            const engine = new QueryEngine();
            for (const v of spec.views) loadView(engine, v.id, v.columns, data[v.id]);
            const { query, layout } = buildQuery(spec);
            const out = await engine.run(query);
            assert.ok('result' in out, `${label}: ${JSON.stringify(out)}`);
            const got = resultRows(engine.read(out.result, 0, 9999).rows, layout).rows.map(r => JSON.stringify(r)).sort();
            assert.deepStrictEqual(got, want, label);
        }

        for (const kind of ['inner', 'left', 'right', 'outer'] as const) {
            it(`${kind} joins, two of them, the default columns: repeats, blanks, a key in another case`, async () => {
                await same({ views, joins: [{ view: 'prod', kind, on: [{ left: key('inv', 'gtin'), right: key('prod', 'gtin') }] }, { view: 'loc', kind, on: [{ left: key('inv', 'loc'), right: key('loc', 'gln') }] }], select: [] }, kind);
            });
        }

        // (a view in the query is joined: with one join, two views)
        const two = views.slice(0, 2);

        it('a key with functions; a key of two columns joined with a separator against one column', async () => {
            await same({ views: two, joins: [{ view: 'prod', kind: 'left', on: [{ left: key('inv', 'gtin', [{ fn: 'upper' }]), right: key('prod', 'gtin') }] }], select: [] }, 'upper key');
            await same({ views: two, joins: [{ view: 'prod', kind: 'left', on: [{ left: { parts: [{ view: 'inv', column: 'gtin' }, { view: 'inv', column: 'part' }], separator: '-' }, right: key('prod', 'code') }] }], select: [{ view: 'inv', column: 'sku' }, { view: 'prod', column: 'name' }] }, 'two columns');
        });

        it('calculated columns by their formula (a COMPARE a column per side); Distinct', async () => {
            const spec: QuerySpec = {
                views: two, joins: [{ view: 'prod', kind: 'left', on: [{ left: key('inv', 'gtin'), right: key('prod', 'gtin') }] }],
                select: [{ view: 'inv', column: 'sku' }, { view: '', column: 'double' }, { view: '', column: 'label' }, { view: '', column: 'both' }],
                calc: [
                    { name: 'double', expr: '', formula: '@inv.qty * 2 + 1' },
                    { name: 'label', expr: '', formula: 'IF(@inv.qty > 2, CONCAT(@prod.name, "!"), IFBLANK(@prod.name, "none"))' },
                    { name: 'both', expr: '', formula: 'COMPARE(@inv.gtin, @prod.gtin)' }
                ]
            };
            await same(spec, 'calc');
            await same({ views: two, joins: [{ view: 'prod', kind: 'left', on: [{ left: key('inv', 'gtin'), right: key('prod', 'gtin') }] }], select: [{ view: 'inv', column: 'part' }, { view: 'prod', column: 'name' }], distinct: true }, 'distinct');
        });

        it('a compare of runs with a view brought in by a plain join', async () => {
            const runs: Record<string, Row[]> = {
                bl: [{ sku: 'A', gtin: 'G1', qty: 1 }, { sku: 'B', gtin: 'G2', qty: 2 }, { sku: 'C', gtin: 'G3', qty: 3 }],
                c1: [{ sku: 'A', gtin: 'G1', qty: 1 }, { sku: 'B', gtin: 'G2', qty: 9 }, { sku: 'D', gtin: 'G9', qty: 4 }]
            };
            Object.assign(data, runs);
            const spec: QuerySpec = {
                views: [
                    { id: 'bl', name: 'stock BL', run: 'BL', columns: ['sku', 'gtin', 'qty'] }, { id: 'c1', name: 'stock C1', run: 'C1', columns: ['sku', 'gtin', 'qty'] },
                    { id: 'prod', name: 'prod', columns: ['gtin', 'name', 'code'] }
                ],
                joins: [
                    { view: 'c1', kind: 'compare', on: [{ left: key('bl', 'sku'), right: key('c1', 'sku') }] },
                    { view: 'prod', kind: 'left', on: [{ left: key('bl', 'gtin'), right: key('prod', 'gtin') }] }
                ],
                select: [{ view: 'bl', column: 'sku' }, { view: 'bl', column: 'qty', group: 'qty' }, { view: 'c1', column: 'qty', group: 'qty' }, { view: 'prod', column: 'name' }]
            };
            await same(spec, 'compare + join');
        });
    });

    describe('the Columns step\'s and Results\' small reads on the engine', () => {
        const rows: Row[] = [
            { sku: ' a-1 ', qty: 1 }, { sku: 'B-2', qty: 2 }, { sku: ' a-1 ', qty: 3 }, { sku: '', qty: 4 }, { sku: null, qty: 5 },
            { sku: 'c-3', qty: 6 }, { sku: 'd-4', qty: 7 }, { sku: 'e-5', qty: 8 }, { sku: 'f-6', qty: 9 }, { sku: 42, qty: 10 }
        ];
        const read = async (engine: QueryEngine, query: Parameters<QueryEngine['run']>[0], n: number) => {
            const out = await engine.run(query);
            assert.ok('result' in out, JSON.stringify(out));
            return engine.read(out.result, 0, n);
        };

        it('the function dialog\'s sample: a few different values, as they are and as the functions leave them; the record\'s own first', async () => {
            const engine = new QueryEngine();
            loadView(engine, 'v', ['sku', 'qty'], rows);
            const fns: ColumnFn[] = [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'replace', from: '-', to: '' }];
            const { few, own } = fnSampleQueries('v', 'sku', fns, 'd-4');
            // SQLite's: SELECT DISTINCT sku, f(sku) … WHERE sku IS NOT NULL AND sku <> '' LIMIT 6
            const db = new SQL.Database();
            db.run('CREATE TABLE v (sku, qty)');
            rows.forEach(r => db.run('INSERT INTO v VALUES (?, ?)', [r.sku as string | number | null, r.qty as number]));
            const want = db.exec(`SELECT DISTINCT sku, ${columnFnSql('sku', fns)} FROM v WHERE sku IS NOT NULL AND sku <> '' LIMIT 6`)[0].values;
            db.close();
            assert.deepStrictEqual((await read(engine, few, 6)).rows, want);
            assert.deepStrictEqual((await read(engine, own!, 1)).rows, [['d-4', 'D4']]);
        });

        it('Translate values reads its lookup table in the engine', async () => {
            const engine = new QueryEngine();
            loadView(engine, 'v', ['sku', 'qty'], rows);
            loadLookupTable(engine, { id: 't1', columns: [{ id: 'erp' }, { id: 'wms' }], rows: [{ erp: 'B-2', wms: 'Bee' }, { erp: '42', wms: 'Answer' }] });
            const { few } = fnSampleQueries('v', 'sku', [{ fn: 'translate', table: 't1', from: 'erp', to: 'wms' }], '');
            const got = (await read(engine, few, 9)).rows;
            assert.deepStrictEqual(got.filter(r => r[0] === 'B-2' || r[0] === 42), [['B-2', 'Bee'], [42, 'Answer']]);
        });

        it('the record window\'s records, and the calculation check\'s first rows with the key beside them', async () => {
            const spec = runsSpec();
            const data = { bl: runRows(0, 30), c1: runRows(1, 30), c2: runRows(2, 30) };
            const engine = new QueryEngine();
            for (const v of spec.views) loadView(engine, v.id, v.columns, data[v.id as keyof typeof data]);
            const keys = compareKeyExprs(spec);
            assert.deepStrictEqual(keys.map(k => k.view), ['bl', 'c1', 'c2']);
            const got = await read(engine, recordQuery('c1', keys[1].expr, 'SKU-3'), 5);
            assert.deepStrictEqual(got.rows, data.c1.filter(r => r.sku === 'SKU-3').map(r => [r.sku, r.qty, r.status]));
            // The check: the key from whichever view has the record, then the formula on the first rows
            const check = await read(engine, queryWithColumns(spec, [labelExpr(spec, { view: 'bl', column: 'sku' }), { fn: '*', args: [{ column: 'qty', of: 'bl' }, { value: 2 }] }]), 4);
            const first = (await runCompareOnEngine(engine, spec))!;
            assert.deepStrictEqual(check.rows.map(r => r[0]), first.rows.slice(0, 4).map(r => r[0]));
            assert.deepStrictEqual(check.rows.map(r => r[1]), first.rows.slice(0, 4).map(r => (typeof r[1] === 'number' ? r[1] * 2 : null)));
        });
    });

    describe('every query on the engine: the Join step\'s figures and Distinct', () => {
        const views = [{ id: 'inv', name: 'inv', columns: ['sku', 'gtin'] }, { id: 'prod', name: 'prod', columns: ['gtin', 'name'] }];
        const data: Record<string, Row[]> = {
            inv: [{ sku: 'A', gtin: 'G1' }, { sku: 'B', gtin: 'G2' }, { sku: 'C', gtin: 'G2' }, { sku: 'D', gtin: null }, { sku: 'E', gtin: 'G7' }, { sku: 'A', gtin: 'G1' }],
            prod: [{ gtin: 'G1', name: 'Bone' }, { gtin: 'G2', name: 'Ball' }, { gtin: 'G2', name: 'Ball 2' }, { gtin: 'G3', name: 'Lead' }]
        };
        const spec = (kind: 'inner' | 'left' | 'right' | 'outer', distinct = false): QuerySpec => ({
            views, joins: [{ view: 'prod', kind, on: [{ left: { parts: [{ view: 'inv', column: 'gtin' }] }, right: { parts: [{ view: 'prod', column: 'gtin' }] } }] }],
            select: [{ view: 'inv', column: 'sku' }, { view: 'prod', column: 'name' }], distinct
        });
        const engineFor = () => { const e = new QueryEngine(); for (const v of views) loadView(e, v.id, v.columns, data[v.id]); return e; };

        it('a plain join\'s figures and the values behind each count, as joinStats gives them', async () => {
            const s = spec('left');
            const session = new QuerySession(SQL, s);
            for (const v of views) await session.load(v.id, data[v.id]);
            const want = session.joinStats(0);
            session.close();
            const got = (await runOnEngine(engineFor(), s))!.stats.get('prod')!;
            const { values: wantValues, ...wantRest } = want;
            const { values: gotValues, ...gotRest } = got;
            assert.deepStrictEqual(gotRest, wantRest);
            const sorted = (v: typeof want.values) => v.map(x => JSON.stringify(x)).sort();
            assert.deepStrictEqual(sorted(gotValues), sorted(wantValues));
        });

        it('Distinct: the rows alike counted, as SQLite counts them; on, they fold', async () => {
            const s = spec('left');
            const session = new QuerySession(SQL, s);
            for (const v of views) await session.load(v.id, data[v.id]);
            const all = session.count();
            session.setSpec(spec('left', true));
            const distinct = session.count();
            session.close();
            const run = (await runOnEngine(engineFor(), s))!;
            assert.strictEqual(run.duplicates, all - distinct);
            const folded = (await runOnEngine(engineFor(), spec('left', true)))!;
            assert.strictEqual(folded.total, distinct);
        });

        it('a join past the row limit: refused, which join and how many rows, and the figures counted until then', async () => {
            const many: Row[] = Array.from({ length: 1500 }, (_, i) => ({ sku: `S${i}`, gtin: 'G' }));
            const e = new QueryEngine(1_000_000);
            const s: QuerySpec = { views, joins: [{ view: 'prod', kind: 'inner', on: [{ left: { parts: [{ view: 'inv', column: 'gtin' }] }, right: { parts: [{ view: 'prod', column: 'gtin' }] } }] }], select: [] };
            loadView(e, 'inv', views[0].columns, many);
            loadView(e, 'prod', views[1].columns, Array.from({ length: 1500 }, (_, i) => ({ gtin: 'G', name: `N${i}` })));
            // (2,250,000 rows: past the engine's limit)
            await assert.rejects(runOnEngine(e, s), (error: unknown) => {
                assert.ok(error instanceof TooManyOnEngine);
                assert.deepStrictEqual([error.tooMany.join, error.tooMany.rows], [0, 2_250_000]);
                assert.strictEqual(error.stats.get('prod')?.rowsAfter, 2_250_000);
                return true;
            });
        });
    });
});
