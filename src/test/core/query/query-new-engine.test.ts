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
import { compareQuery, fnExpr, formulaExpr, loadView, onSqliteLine, runCompareOnEngine, whyNotOnEngine } from '../../../services/query/query-new-engine';
import { formulaSql, parseFormula, FORMULA_FUNCTIONS } from '../../../services/query/formula';
import type { Value } from '../../../services/engine/engine-types';
import { compareKeySql, resultColumns } from '../../../services/query/query-sql';
import { rowStatus } from '../../../services/query/query-status';
import type { QuerySpec } from '../../../services/query/query-types';
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
        assert.strictEqual(whyNotOnEngine({ ...spec, select: [{ view: 'bl', column: 'sku', fns: [{ fn: 'translate', table: 't', from: 'a', to: 'b' }] }] }), 'it uses Translate values');
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
});
