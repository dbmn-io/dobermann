// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The engine's first piece (src/services/engine): tables in and windows out, select and filter,
 * and every function giving what SQLite gives today on awkward values. A smoke check; the tester's
 * reference harness is the full one.
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { QueryEngine } from '../../../services/engine/engine';
import type { Expr, FunctionName, Table, Value } from '../../../services/engine/engine-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

/** The values every function is tried on. */
const VALUES: Value[] = [null, '', 0, 1, 42, -7, 1.5, 2.5, -2.5, 1e20, 0.1, 'abc', '0042', ' 12 ', '12abc', '1.50', '1e3', '-5', 'é', 'Café', 'a b', '000', '  x  ', 'true'];

/** How SQLite writes each function today (column-functions.ts, formula.ts formulaSql). */
const SQL: Partial<Record<FunctionName, (a: string[]) => string>> = {
    '+': a => `(${a[0]} + ${a[1]})`, '-': a => `(${a[0]} - ${a[1]})`, '*': a => `(${a[0]} * ${a[1]})`,
    '/': a => `(${a[0]} * 1.0 / NULLIF(${a[1]}, 0))`, NEG: a => `-(${a[0]})`,
    '=': a => `(${a[0]} = ${a[1]})`, '<>': a => `(${a[0]} <> ${a[1]})`, '>': a => `(${a[0]} > ${a[1]})`, '<': a => `(${a[0]} < ${a[1]})`,
    IF: a => `CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2] ?? 'NULL'} END`,
    IFBLANK: a => `COALESCE(NULLIF(${a[0]}, ''), ${a[1]})`,
    AND: a => `(${a.join(' AND ')})`, OR: a => `(${a.join(' OR ')})`, NOT: a => `(NOT ${a[0]})`,
    ROUND: a => `ROUND(${a[0]}, ${a[1] ?? '0'})`, ABS: a => `ABS(${a[0]})`,
    FLOOR: a => `(CAST(${a[0]} AS INTEGER) - (${a[0]} < CAST(${a[0]} AS INTEGER)))`,
    CEIL: a => `(CAST(${a[0]} AS INTEGER) + (${a[0]} > CAST(${a[0]} AS INTEGER)))`,
    MIN: a => `MIN(${a.join(', ')})`, MAX: a => `MAX(${a.join(', ')})`,
    CONCAT: a => `(${a.map(x => `COALESCE(${x}, '')`).join(' || ')})`,
    UPPER: a => `UPPER(${a[0]})`, LOWER: a => `LOWER(${a[0]})`, TRIM: a => `TRIM(${a[0]})`, LTRIM: a => `LTRIM(${a[0]}, ${a[1]})`,
    LEFT: a => `SUBSTR(${a[0]}, 1, ${a[1]})`, RIGHT: a => `CASE WHEN ${a[1]} > 0 THEN SUBSTR(${a[0]}, -(${a[1]})) ELSE '' END`,
    SUBSTR: a => `SUBSTR(${a.join(', ')})`, REPLACE: a => `REPLACE(${a.join(', ')})`, LENGTH: a => `LENGTH(${a[0]})`,
    TEXT: a => `CAST(${a[0]} AS TEXT)`, NUMERIC: a => `CAST(${a[0]} AS NUMERIC)`,
    NUMBER: a => `CASE WHEN typeof(${a[0]}) IN ('integer', 'real') THEN ${a[0]} WHEN TRIM(${a[0]}) GLOB '*[0-9]*' AND TRIM(${a[0]}) NOT GLOB '*[^0-9.eE+-]*' THEN CAST(TRIM(${a[0]}) AS NUMERIC) END`
};

/** A row's values in SQLite, as the app stores them (a whole real as an integer: QuerySession.load's valueSql). */
function sqliteTable(db: Database, columns: string[], rows: Value[][]): void {
    db.run(`CREATE TABLE t (${columns.join(', ')})`);
    const put = db.prepare(`INSERT INTO t VALUES (${columns.map((_, i) => `CASE WHEN typeof(?${i + 1}) = 'real' AND ?${i + 1} = CAST(?${i + 1} AS INTEGER) THEN CAST(?${i + 1} AS INTEGER) ELSE ?${i + 1} END`).join(', ')})`);
    for (const r of rows) put.run(r as (string | number | null)[]);
    put.free();
}

describe('The engine, first piece: tables, select, filter, functions', () => {
    let SQL_: SqlJsStatic;
    before(async () => { SQL_ = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    /** Every value (or pair of values) through one function, in SQLite and in the engine: the same answers. */
    /** `ours`: for a row on the list of differences (engine-types.ts), the engine's answer; else SQLite's is expected. */
    async function same(fn: FunctionName, arity: number, extra: Value[] = [], ours?: (row: Value[]) => Value | undefined) {
        const rows: Value[][] = [];
        if (arity === 1) VALUES.forEach(v => rows.push([v, ...extra]));
        else VALUES.forEach(a => VALUES.forEach(b => rows.push([a, b, ...extra])));
        const columns = ['a', 'b', 'c', 'd'].slice(0, arity + extra.length);
        const db = new SQL_.Database();
        sqliteTable(db, columns, rows);
        const want = db.exec(`SELECT ${SQL[fn]!(columns)} FROM t`)[0].values.map((r, i) => { const o = ours?.(rows[i]); return o === undefined ? r[0] : o; });
        db.close();
        const engine = new QueryEngine();
        engine.load('t', { columns, rows });
        const expr: Expr = { fn, args: columns.map(c => ({ column: c })) };
        const out = await engine.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: expr }] }] });
        assert.ok('result' in out, JSON.stringify(out));
        const got = engine.read(out.result, 0, rows.length).rows.map(r => r[0]);
        const wrong = rows.map((r, i) => [r, want[i], got[i]] as const).filter(([, w, g]) => !Object.is(w, g) && !(typeof w === 'number' && typeof g === 'number' && w === g));
        assert.deepStrictEqual(wrong.slice(0, 5), [], `${fn}: ${wrong.length} values differ, e.g. ${JSON.stringify(wrong.slice(0, 5))}`);
    }

    // The listed differences (engine-types.ts): text read as NUMBER reads it
    const plainNumber = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
    const asNumber = (v: Value): Value | undefined => (typeof v !== 'string' ? undefined : plainNumber.test(v) ? Number(v.trim()) : null);
    it('FLOOR as SQLite; text as NUMBER reads it (difference 2)', async () => same('FLOOR', 1, [], r => { const n = asNumber(r[0]); return n === undefined ? undefined : n === null ? null : Math.floor(n as number); }));
    it('CEIL as SQLite; text as NUMBER reads it (difference 2)', async () => same('CEIL', 1, [], r => { const n = asNumber(r[0]); return n === undefined ? undefined : n === null ? null : Math.ceil(n as number); }));
    it('As a number (NUMERIC) as SQLite for numbers; text as NUMBER reads it (difference 3)', async () => same('NUMERIC', 1, [], r => asNumber(r[0])));
    it('Upper / Lower case as SQLite, but every letter (difference 4)', async () => {
        await same('UPPER', 1, [], r => (typeof r[0] === 'string' ? r[0].toUpperCase() : undefined));
        await same('LOWER', 1, [], r => (typeof r[0] === 'string' ? r[0].toLowerCase() : undefined));
    });
    for (const fn of ['NEG', 'ABS', 'TRIM', 'LENGTH', 'TEXT', 'NUMBER', 'NOT', 'ROUND'] as FunctionName[]) {
        it(`${fn} as SQLite`, async () => same(fn, 1));
    }
    for (const fn of ['+', '-', '*', '/', '=', '<>', '>', '<', 'IFBLANK', 'AND', 'OR', 'MIN', 'MAX', 'CONCAT', 'LTRIM', 'LEFT', 'RIGHT', 'SUBSTR', 'ROUND'] as FunctionName[]) {
        it(`${fn} of two as SQLite`, async () => same(fn, 2));
    }
    it('SUBSTR of three, REPLACE and IF as SQLite', async () => {
        await same('SUBSTR', 2, [2]);
        await same('SUBSTR', 2, [-2]);
        await same('REPLACE', 2, ['_']);
        await same('IF', 2, ['no']);
    });

    it('comparisons are exact by type, whatever the sides came from (difference 1): TEXT(a) = 42 and NUMERIC(a) = \'42\' only meet by type', async () => {
        const e = new QueryEngine();
        const rows: Value[][] = [[42, '42'], ['42', 42], ['0042', '42'], [1.5, '1.5']];
        e.load('t', { columns: ['a', 'b'], rows });
        const a: Expr = { column: 'a' }, b: Expr = { column: 'b' };
        const out = await e.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [
            { name: 'textA_is_b', value: { fn: '=', args: [{ fn: 'TEXT', args: [a] }, b] } },
            { name: 'textA_is_42', value: { fn: '=', args: [{ fn: 'TEXT', args: [a] }, { value: 42 }] } },
            { name: 'numA_is_b', value: { fn: '=', args: [{ fn: 'NUMERIC', args: [a] }, b] } },
            { name: 'numA_is_text42', value: { fn: '=', args: [{ fn: 'NUMERIC', args: [a] }, { value: '42' }] } },
            { name: 'numA_is_numB', value: { fn: '=', args: [{ fn: 'NUMERIC', args: [a] }, { fn: 'NUMBER', args: [b] }] } }
        ] }] });
        assert.ok('result' in out);
        assert.deepStrictEqual(e.read(out.result, 0, 9).rows, [
            [1, 0, 0, 0, 1],
            [0, 0, 1, 0, 1],
            [0, 0, 0, 0, 1],
            [1, 0, 0, 0, 1]
        ]);
    });

    it('sort as SQLite ORDER BY, ties in their order: ascending, descending (blanks last), two keys, a calculated key', async () => {
        const rows: Value[][] = [];
        VALUES.forEach((a, i) => VALUES.slice(0, 6).forEach(b => rows.push([a, b, i])));
        const db = new SQL_.Database();
        sqliteTable(db, ['a', 'b', 'n'], rows);
        const sql = (order: string) => db.exec(`SELECT a, b, n FROM t ORDER BY ${order}, rowid`)[0].values;
        const e = new QueryEngine();
        e.load('t', { columns: ['a', 'b', 'n'], rows });
        const ours = async (by: { value: Expr; descending?: boolean }[]) => {
            const out = await e.run({ steps: [{ from: 't' }, { sort: 'step 1', by }] });
            assert.ok('result' in out, JSON.stringify(out));
            return e.read(out.result, 0, rows.length).rows;
        };
        const a: Expr = { column: 'a' }, b: Expr = { column: 'b' };
        assert.deepStrictEqual(await ours([{ value: a }]), sql('a'));
        assert.deepStrictEqual(await ours([{ value: a, descending: true }]), sql('a DESC'));
        assert.deepStrictEqual(await ours([{ value: b }, { value: a, descending: true }]), sql('b, a DESC'));
        assert.deepStrictEqual(await ours([{ value: { fn: 'LENGTH', args: [a] } }]), sql('LENGTH(a)'));
        db.close();
    });

    it('select and filter at their edges: a filter keeps only true rows (blank, 0 and "abc" are not); steps read by name; the result can be a middle step', async () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [[1], [0], [null], ['abc'], ['2x'], [''], [-1]] });
        const kept = await e.run({ steps: [{ from: 't' }, { filter: 'step 1', where: { column: 'a' } }] });
        assert.ok('result' in kept);
        assert.deepStrictEqual(e.read(kept.result, 0, 9).rows, [[1], ['2x'], [-1]]);
        const middle = await e.run({ result: 'doubled', steps: [
            { from: 't', as: 'in' },
            { as: 'doubled', select: 'in', columns: [{ name: 'd', value: { fn: '*', args: [{ column: 'a', of: 'in' }, { value: 2 }] } }, { name: 'k', value: { value: 'x' } }] },
            { filter: 'doubled', where: { fn: '>', args: [{ column: 'd' }, { value: 0 }] } }
        ] });
        assert.ok('result' in middle);
        assert.strictEqual(middle.total, 7);
        assert.deepStrictEqual(e.read(middle.result, 0, 2).rows, [[2, 'x'], [0, 'x']]);
    });

    it('check refuses a select with no columns or two of one name, a sort with nothing to sort by, a step that reads one after it', async () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [] });
        const said = (q: Parameters<QueryEngine['check']>[0]) => e.check(q).map(p => p.message).join(' | ');
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [] }] }), /at least one column/);
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { column: 'a' } }, { name: 'x', value: { value: 1 } }] }] }), /Two columns are called "x"/);
        assert.match(said({ steps: [{ from: 't' }, { sort: 'step 1', by: [] }] }), /something to sort by/);
        assert.match(said({ steps: [{ from: 't' }, { filter: 'later', where: { value: 1 } }, { as: 'later', select: 'step 1', columns: [{ name: 'a', value: { column: 'a' } }] }] }), /no table or step called "later"/);
    });

    describe('joins', () => {
        // Keys of every kind: repeats, blanks, a number and its text, whole reals, text alike but for case
        const L: Value[][] = [[1, 'a', 'L1'], [2, 'b', 'L2'], [2, 'b', 'L3'], [null, 'c', 'L4'], ['1', 'a', 'L5'], [3, null, 'L6'], [4.0, 'D', 'L7'], [5, 'e', 'L8'], [1.5, 'f', 'L9']];
        const R: Value[][] = [[1, 'a', 'R1'], [2, 'b', 'R2'], [2, 'b', 'R3'], [null, 'c', 'R4'], [1, 'A', 'R5'], [3, null, 'R6'], [4, 'd', 'R7'], [6, 'g', 'R8'], ['1.5', 'f', 'R9'], [1.5, 'f', 'R10']];
        const KINDS = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', outer: 'FULL JOIN' } as const;

        async function joinsAsSqlite(kind: keyof typeof KINDS, on: { sql: string; left: Expr; right: Expr }[]) {
            const db = new SQL_.Database();
            db.run('CREATE TABLE l (k, j, name)'); db.run('CREATE TABLE r (k, j, name)');
            L.forEach(row => db.run('INSERT INTO l VALUES (?, ?, ?)', row as (string | number | null)[]));
            R.forEach(row => db.run('INSERT INTO r VALUES (?, ?, ?)', row as (string | number | null)[]));
            const want = db.exec(`SELECT l.k, l.j, l.name, r.k, r.j, r.name FROM l ${KINDS[kind]} r ON ${on.map(p => p.sql).join(' AND ')} ORDER BY (l.rowid IS NULL), l.rowid, r.rowid`)[0]?.values ?? [];
            db.close();
            const e = new QueryEngine();
            e.load('l', { columns: ['k', 'j', 'name'], rows: L });
            e.load('r', { columns: ['k', 'j', 'name'], rows: R });
            const out = await e.run({ steps: [{ join: kind, left: 'l', right: 'r', on: on.map(p => ({ left: p.left, right: p.right })) }] });
            assert.ok('result' in out, JSON.stringify(out));
            const got = e.read(out.result, 0, 1000);
            assert.deepStrictEqual(got.columns, ['l.k', 'l.j', 'l.name', 'r.k', 'r.j', 'r.name']);
            assert.deepStrictEqual(got.rows, want, `${kind} join`);
        }
        const k = (of: string): Expr => ({ column: 'k', of });
        const j = (of: string): Expr => ({ column: 'j', of });
        for (const kind of ['inner', 'left', 'right', 'outer'] as const) {
            it(`${kind} join as SQLite: one key, two keys, a key with a function; a blank key matches nothing; 1 never meets "1"`, async () => {
                await joinsAsSqlite(kind, [{ sql: 'l.k = r.k', left: k('l'), right: k('r') }]);
                await joinsAsSqlite(kind, [{ sql: 'l.k = r.k', left: k('l'), right: k('r') }, { sql: 'l.j = r.j', left: j('l'), right: j('r') }]);
                await joinsAsSqlite(kind, [{ sql: 'UPPER(l.j) = UPPER(r.j)', left: { fn: 'UPPER', args: [j('l')] }, right: { fn: 'UPPER', args: [j('r')] } }]);
            });
        }

        it('a join step\'s statistics as today\'s joinStats counts them in SQLite (query-engine.ts), one key and two', async () => {
            for (const parts of [['k'], ['k', 'j']]) {
                const db = new SQL_.Database();
                db.run('CREATE TABLE l (k, j, name)'); db.run('CREATE TABLE r (k, j, name)');
                L.forEach(row => db.run('INSERT INTO l VALUES (?, ?, ?)', row as (string | number | null)[]));
                R.forEach(row => db.run('INSERT INTO r VALUES (?, ?, ?)', row as (string | number | null)[]));
                const ks = parts.map((_, i) => `k${i}`);
                const groups = `WITH _l AS (SELECT ${parts.map((p, i) => `${p} AS k${i}`).join(', ')} FROM l), _r AS (SELECT ${parts.map((p, i) => `${p} AS k${i}`).join(', ')} FROM r),
_lg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _l WHERE ${ks.map(k => `${k} IS NOT NULL`).join(' AND ')} GROUP BY ${ks.join(', ')}),
_rg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _r WHERE ${ks.map(k => `${k} IS NOT NULL`).join(' AND ')} GROUP BY ${ks.join(', ')})`;
                const same = ks.map(k => `lg.${k} = rg.${k}`).join(' AND ');
                const kinds = ['lg.n = 1 AND rg.n = 1', 'lg.n = 1 AND rg.n > 1', 'lg.n > 1 AND rg.n = 1', 'lg.n > 1 AND rg.n > 1'];
                const t = db.exec(`${groups} SELECT (SELECT COUNT(*) FROM _l), (SELECT COUNT(*) FROM _r), (SELECT COALESCE(SUM(n), 0) FROM _lg),
  COALESCE(SUM(lg.n), 0), COALESCE(SUM(rg.n), 0), COALESCE(SUM(lg.n * rg.n), 0),
  ${kinds.map(k => `COALESCE(SUM(${k}), 0), COALESCE(SUM((${k}) * lg.n), 0), COALESCE(SUM((${k}) * rg.n), 0)`).join(', ')},
  (SELECT COUNT(*) FROM _lg), (SELECT COUNT(*) FROM _rg) FROM _lg AS lg JOIN _rg AS rg ON ${same}`)[0].values[0].map(Number);
                const onlyRight = Number(db.exec(`${groups} SELECT COUNT(*) FROM _rg AS rg WHERE NOT EXISTS (SELECT 1 FROM _lg AS lg WHERE ${same})`)[0].values[0][0]);
                db.close();
                const [leftRows, rightRows, leftKeyed, leftMatched, rightMatched, pairs] = t;
                const kc = t.slice(6, 18);
                const e = new QueryEngine();
                e.load('l', { columns: ['k', 'j', 'name'], rows: L });
                e.load('r', { columns: ['k', 'j', 'name'], rows: R });
                const out = await e.run({ steps: [{ as: 'j', join: 'outer', left: 'l', right: 'r', on: parts.map(p => ({ left: { column: p, of: 'l' }, right: { column: p, of: 'r' } })) }] });
                assert.ok('result' in out);
                const st = e.stats(out.result, 'j') as import('../../../services/engine/engine-types').JoinStats;
                assert.deepStrictEqual(
                    [st.leftRows, st.rightRows, st.leftRows - st.leftBlank, st.leftMatched, st.rightMatched, st.rowsAfter - (st.leftRows - st.leftMatched) - (st.rightRows - st.rightMatched)],
                    [leftRows, rightRows, leftKeyed, leftMatched, rightMatched, pairs], parts.join('+'));
                assert.deepStrictEqual(st.keys, { oneToOne: kc[0], oneToMany: kc[3], manyToOne: kc[6], manyToMany: kc[9] });
                assert.deepStrictEqual(st.rows, { oneToOne: kc[1], oneToMany: kc[4], manyToOne: kc[7], manyToMany: kc[10] });
                assert.deepStrictEqual(st.records, { oneToOne: kc[2], oneToMany: kc[5], manyToOne: kc[8], manyToMany: kc[11] });
                assert.deepStrictEqual([st.leftValues, st.rightValues, st.valuesTotal], [t[18], t[19], t[18] + onlyRight]);
            }
        });

        it('the values behind a count, a page at a time; a key that is a number on one side and text on the other said', async () => {
            const e = new QueryEngine();
            e.load('l', { columns: ['k'], rows: [['a'], ['a'], ['b'], ['c'], [null], ['d'], ['d'], ['d']] });
            e.load('r', { columns: ['k'], rows: [['a'], ['b'], ['b'], ['b'], ['x'], ['d'], ['d']] });
            const out = await e.run({ steps: [{ as: 'j', join: 'left', left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
            assert.ok('result' in out);
            const w = (kind: import('../../../services/engine/engine-types').StatsWindow['kind'], from = 0, count = 10) => (e.stats(out.result, 'j', { kind, side: 'left', from, count }) as Table);
            assert.deepStrictEqual(w('manyToOne'), { columns: ['key', 'left', 'right'], rows: [['a', 2, 1]] });
            assert.deepStrictEqual(w('oneToMany').rows, [['b', 1, 3]]);
            assert.deepStrictEqual(w('manyToMany').rows, [['d', 3, 2]]);
            assert.deepStrictEqual(w('onlyLeft').rows, [['c', 1, 0]]);
            assert.deepStrictEqual(w('onlyRight').rows, [['x', 0, 1]]);
            const st = e.stats(out.result, 'j') as import('../../../services/engine/engine-types').JoinStats;
            assert.strictEqual(st.leftBlank, 1);
            assert.strictEqual(st.relationship, 'manyToMany');
            assert.strictEqual(st.typeMismatch, false);
            const many = new QueryEngine();
            many.load('l', { columns: ['k'], rows: [['a'], ['a'], ['b'], ['c'], ['c'], ['c']] });
            many.load('r', { columns: ['k'], rows: [['a'], ['a'], ['b'], ['b'], ['c'], ['c'], [1]] });
            const m = await many.run({ steps: [{ as: 'j', join: 'inner', left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
            assert.ok('result' in m);
            // Rows they make first: c (3 × 2), then a (2 × 2); paged
            assert.deepStrictEqual((many.stats(m.result, 'j', { kind: 'manyToMany', side: 'left', from: 0, count: 1 }) as Table).rows, [['c', 3, 2]]);
            assert.deepStrictEqual((many.stats(m.result, 'j', { kind: 'manyToMany', side: 'left', from: 1, count: 5 }) as Table).rows, [['a', 2, 2]]);
            const t = new QueryEngine();
            t.load('l', { columns: ['k'], rows: [['1'], ['2']] });
            t.load('r', { columns: ['k'], rows: [[1], [2]] });
            const tm = await t.run({ steps: [{ as: 'j', join: 'left', left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
            assert.ok('result' in tm);
            assert.strictEqual((t.stats(tm.result, 'j') as import('../../../services/engine/engine-types').JoinStats).typeMismatch, true);
        });

        it('a join over the row limit is refused before any row is made; under it, made', async () => {
            const e = new QueryEngine(5);
            e.load('l', { columns: ['k'], rows: [[1], [1], [1]] });
            e.load('r', { columns: ['k'], rows: [[1], [1]] });
            const out = await e.run({ steps: [{ as: 'j', join: 'inner', left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
            assert.ok('problems' in out);
            assert.strictEqual(out.problems[0].step, 'j');
            assert.match(out.problems[0].message, /would make 6 rows, more than the 5/);
            // The counts up to it stay, so the Join step can still show them
            const counted = out.stats?.j as import('../../../services/engine/engine-types').JoinStats;
            assert.deepStrictEqual([counted.rowsAfter, counted.relationship, counted.keys.manyToMany], [6, 'manyToMany', 1]);
            const e6 = new QueryEngine(6);
            e6.load('l', { columns: ['k'], rows: [[1], [1], [1]] });
            e6.load('r', { columns: ['k'], rows: [[1], [1]] });
            const made = await e6.run({ steps: [{ join: 'inner', left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
            assert.ok('result' in made);
            assert.strictEqual(made.total, 6);
        });

        it('a join reads steps and tables by name; a column on both sides needs its input named; select after a join', async () => {
            const e = new QueryEngine();
            e.load('inv', { columns: ['gtin', 'qty'], rows: [['A', 1], ['B', 2]] });
            e.load('prod', { columns: ['gtin', 'name'], rows: [['A', 'Apple'], ['C', 'Cherry']] });
            const said = e.check({ steps: [{ as: 'j', join: 'left', left: 'inv', right: 'prod', on: [{ left: { column: 'gtin' }, right: { column: 'gtin' } }] }, { select: 'j', columns: [{ name: 'g', value: { column: 'gtin' } }] }] });
            assert.match(said.map(p => p.message).join(), /"gtin" is in more than one input \(inv, prod\): say which/);
            const out = await e.run({ steps: [
                { as: 'i', from: 'inv' },
                { as: 'j', join: 'outer', left: 'i', right: 'prod', on: [{ left: { column: 'gtin' }, right: { column: 'gtin' } }] },
                { select: 'j', columns: [{ name: 'gtin', value: { fn: 'IFBLANK', args: [{ column: 'gtin', of: 'i' }, { column: 'gtin', of: 'prod' }] } }, { name: 'qty', value: { column: 'qty' } }, { name: 'name', value: { column: 'name' } }] }
            ] });
            assert.ok('result' in out, JSON.stringify(out));
            assert.deepStrictEqual(e.read(out.result, 0, 9).rows, [['A', 1, 'Apple'], ['B', 2, null], ['C', null, 'Cherry']]);
        });

        it('a long run says how far it has got, stage by stage, and Stop ends it between slices', async () => {
            const rows: Value[][] = [];
            for (let i = 0; i < 200_000; i++) rows.push([i % 1000]);
            const e = new QueryEngine();
            e.load('l', { columns: ['k'], rows });
            e.load('r', { columns: ['k'], rows: rows.slice(0, 1000) });
            const query = { steps: [{ join: 'inner' as const, left: 'l', right: 'r', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] };
            const heard: string[] = [];
            const done = await e.run(query, { onProgress: p => heard.push(`${p.stage} ${p.done}/${p.total}`) });
            assert.ok('result' in done);
            assert.strictEqual(done.total, 200_000);
            assert.ok(heard.some(h => /^Joining r \d+\/201000$/.test(h)), heard.join(' | '));
            assert.strictEqual(heard[heard.length - 1], 'Done 200000/200000');
            const stopped = await e.run(query, { onProgress: p => { if (p.done > 0) e.cancel(p.result); } });
            assert.deepStrictEqual(stopped, { cancelled: true });
        });
    });

    it('group as SQLite GROUP BY: count, countValues, sum, min, max; by one value, two, an expression, and none', async () => {
        const rows: Value[][] = [];
        VALUES.forEach((a, i) => rows.push([i % 3 ? 'x' : i % 2 ? 'y' : null, a, i % 4]));
        rows.push(['x', 1.5, 0], ['x', 2, 0], [null, 'abc', 1]);
        const db = new SQL_.Database();
        sqliteTable(db, ['g', 'v', 'h'], rows);
        const aggregates = [
            { name: 'n', fn: 'count' as const }, { name: 'vals', fn: 'countValues' as const, value: { column: 'v' } },
            { name: 's', fn: 'sum' as const, value: { column: 'v' } }, { name: 'lo', fn: 'min' as const, value: { column: 'v' } }, { name: 'hi', fn: 'max' as const, value: { column: 'v' } }
        ];
        const aggSql = 'COUNT(*), COUNT(v), SUM(v), MIN(v), MAX(v)';
        // (SQLite's group order is its own: ours is first appearance, so both are put in the groups' order)
        const sqlOf = (by: string) => db.exec(`SELECT ${by ? `${by}, ` : ''}${aggSql}, MIN(rowid) AS f FROM t ${by ? `GROUP BY ${by}` : ''} ORDER BY f`)[0].values.map(r => r.slice(0, -1));
        const e = new QueryEngine();
        e.load('t', { columns: ['g', 'v', 'h'], rows });
        const ours = async (by: { name: string; value: Expr }[]) => {
            const out = await e.run({ steps: [{ from: 't' }, { group: 'step 1', by, aggregates }] });
            assert.ok('result' in out, JSON.stringify(out));
            return e.read(out.result, 0, 999).rows;
        };
        assert.deepStrictEqual(await ours([{ name: 'g', value: { column: 'g' } }]), sqlOf('g'));
        assert.deepStrictEqual(await ours([{ name: 'g', value: { column: 'g' } }, { name: 'h', value: { column: 'h' } }]), sqlOf('g, h'));
        assert.deepStrictEqual(await ours([{ name: 'u', value: { fn: 'UPPER', args: [{ column: 'g' }] } }]), sqlOf('UPPER(g)'));
        assert.deepStrictEqual(await ours([]), sqlOf(''));
        // None at all: one row, as SQLite
        e.load('empty', { columns: ['v'], rows: [] });
        const none = await e.run({ steps: [{ from: 'empty' }, { group: 'step 1', by: [], aggregates: [{ name: 'n', fn: 'count' }, { name: 's', fn: 'sum', value: { column: 'v' } }] }] });
        assert.ok('result' in none);
        assert.deepStrictEqual(e.read(none.result, 0, 9).rows, [[0, null]]);
        db.close();
    });

    it('tables come in, in pieces, and are read a window at a time; a table still loading is refused', async () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a', 'b'], rows: [[1, 'x']] }, { more: true });
        const refused = await e.run({ steps: [{ from: 't' }] });
        assert.ok('problems' in refused && /still loading/.test(refused.problems[0].message));
        e.append('t', { columns: ['a', 'b'], rows: [[2, 'y'], [3, null]] }, { last: true });
        const out = await e.run({ steps: [{ from: 't' }, { filter: 'step 1', where: { fn: '>', args: [{ column: 'a' }, { value: 1 }] } }] });
        assert.ok('result' in out);
        assert.strictEqual(out.total, 2);
        assert.deepStrictEqual(e.read(out.result, 1, 5), { columns: ['a', 'b'], rows: [[3, null]], total: 2 });
        e.release(out.result);
        assert.throws(() => e.read(out.result, 0, 1));
    });

    it('check refuses, in words, before any work: an unknown table, column, function, arity, and steps of later pieces', async () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [] });
        const said = (q: Parameters<QueryEngine['check']>[0]) => e.check(q).map(p => p.message);
        assert.match(said({ steps: [{ from: 'nope' }] })[0], /no table or step called "nope"/);
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { column: 'b' } }] }] })[0], /no column "b"/);
        assert.match(said({ steps: [{ from: 't' }, { filter: 'step 1', where: { fn: 'UPPER', args: [] } }] })[0], /UPPER takes 1 values, not 0/);
        assert.match(said({ steps: [{ from: 't' }, { group: 'step 1', by: [], aggregates: [] }] })[0], /something to group by or count/);
        assert.match(said({ steps: [{ join: 'inner', left: 't', right: 't', on: [] }] })[0], /at least one pair of key columns/);
    });

    it('Translate values reads a loaded lookup table: the first row whose from-column holds the value, as text; not found, the value', async () => {
        const e = new QueryEngine();
        e.load('units', { columns: ['erp', 'wms'], rows: [['EA', 'each'], ['1', 'one'], ['EA', 'second'], ['BX', null]] });
        e.load('t', { columns: ['u'], rows: [['EA'], [1], ['CS'], [null], ['BX']] });
        const out = await e.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { fn: 'TRANSLATE', args: [{ column: 'u' }, { value: 'units' }, { value: 'erp' }, { value: 'wms' }] } }] }] });
        assert.ok('result' in out);
        assert.deepStrictEqual(e.read(out.result, 0, 9).rows.map(r => r[0]), ['each', 'one', 'CS', null, 'BX']);
    });
});
