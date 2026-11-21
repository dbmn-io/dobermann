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
import type { Expr, FunctionName, Value } from '../../../services/engine/engine-types';
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
    function same(fn: FunctionName, arity: number, extra: Value[] = [], ours?: (row: Value[]) => Value | undefined) {
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
        const out = engine.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: expr }] }] });
        assert.ok('result' in out, JSON.stringify(out));
        const got = engine.read(out.result, 0, rows.length).rows.map(r => r[0]);
        const wrong = rows.map((r, i) => [r, want[i], got[i]] as const).filter(([, w, g]) => !Object.is(w, g) && !(typeof w === 'number' && typeof g === 'number' && w === g));
        assert.deepStrictEqual(wrong.slice(0, 5), [], `${fn}: ${wrong.length} values differ, e.g. ${JSON.stringify(wrong.slice(0, 5))}`);
    }

    // The listed differences (engine-types.ts): text read as NUMBER reads it
    const plainNumber = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
    const asNumber = (v: Value): Value | undefined => (typeof v !== 'string' ? undefined : plainNumber.test(v) ? Number(v.trim()) : null);
    it('FLOOR as SQLite; text as NUMBER reads it (difference 2)', () => same('FLOOR', 1, [], r => { const n = asNumber(r[0]); return n === undefined ? undefined : n === null ? null : Math.floor(n as number); }));
    it('CEIL as SQLite; text as NUMBER reads it (difference 2)', () => same('CEIL', 1, [], r => { const n = asNumber(r[0]); return n === undefined ? undefined : n === null ? null : Math.ceil(n as number); }));
    it('As a number (NUMERIC) as SQLite for numbers; text as NUMBER reads it (difference 3)', () => same('NUMERIC', 1, [], r => asNumber(r[0])));
    it('Upper / Lower case as SQLite, but every letter (difference 4)', () => {
        same('UPPER', 1, [], r => (typeof r[0] === 'string' ? r[0].toUpperCase() : undefined));
        same('LOWER', 1, [], r => (typeof r[0] === 'string' ? r[0].toLowerCase() : undefined));
    });
    for (const fn of ['NEG', 'ABS', 'TRIM', 'LENGTH', 'TEXT', 'NUMBER', 'NOT', 'ROUND'] as FunctionName[]) {
        it(`${fn} as SQLite`, () => same(fn, 1));
    }
    for (const fn of ['+', '-', '*', '/', '=', '<>', '>', '<', 'IFBLANK', 'AND', 'OR', 'MIN', 'MAX', 'CONCAT', 'LTRIM', 'LEFT', 'RIGHT', 'SUBSTR', 'ROUND'] as FunctionName[]) {
        it(`${fn} of two as SQLite`, () => same(fn, 2));
    }
    it('SUBSTR of three, REPLACE and IF as SQLite', () => {
        same('SUBSTR', 2, [2]);
        same('SUBSTR', 2, [-2]);
        same('REPLACE', 2, ['_']);
        same('IF', 2, ['no']);
    });

    it('comparisons are exact by type, whatever the sides came from (difference 1): TEXT(a) = 42 and NUMERIC(a) = \'42\' only meet by type', () => {
        const e = new QueryEngine();
        const rows: Value[][] = [[42, '42'], ['42', 42], ['0042', '42'], [1.5, '1.5']];
        e.load('t', { columns: ['a', 'b'], rows });
        const a: Expr = { column: 'a' }, b: Expr = { column: 'b' };
        const out = e.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [
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

    it('sort as SQLite ORDER BY, ties in their order: ascending, descending (blanks last), two keys, a calculated key', () => {
        const rows: Value[][] = [];
        VALUES.forEach((a, i) => VALUES.slice(0, 6).forEach(b => rows.push([a, b, i])));
        const db = new SQL_.Database();
        sqliteTable(db, ['a', 'b', 'n'], rows);
        const sql = (order: string) => db.exec(`SELECT a, b, n FROM t ORDER BY ${order}, rowid`)[0].values;
        const e = new QueryEngine();
        e.load('t', { columns: ['a', 'b', 'n'], rows });
        const ours = (by: { value: Expr; descending?: boolean }[]) => {
            const out = e.run({ steps: [{ from: 't' }, { sort: 'step 1', by }] });
            assert.ok('result' in out, JSON.stringify(out));
            return e.read(out.result, 0, rows.length).rows;
        };
        const a: Expr = { column: 'a' }, b: Expr = { column: 'b' };
        assert.deepStrictEqual(ours([{ value: a }]), sql('a'));
        assert.deepStrictEqual(ours([{ value: a, descending: true }]), sql('a DESC'));
        assert.deepStrictEqual(ours([{ value: b }, { value: a, descending: true }]), sql('b, a DESC'));
        assert.deepStrictEqual(ours([{ value: { fn: 'LENGTH', args: [a] } }]), sql('LENGTH(a)'));
        db.close();
    });

    it('select and filter at their edges: a filter keeps only true rows (blank, 0 and "abc" are not); steps read by name; the result can be a middle step', () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [[1], [0], [null], ['abc'], ['2x'], [''], [-1]] });
        const kept = e.run({ steps: [{ from: 't' }, { filter: 'step 1', where: { column: 'a' } }] });
        assert.ok('result' in kept);
        assert.deepStrictEqual(e.read(kept.result, 0, 9).rows, [[1], ['2x'], [-1]]);
        const middle = e.run({ result: 'doubled', steps: [
            { from: 't', as: 'in' },
            { as: 'doubled', select: 'in', columns: [{ name: 'd', value: { fn: '*', args: [{ column: 'a', of: 'in' }, { value: 2 }] } }, { name: 'k', value: { value: 'x' } }] },
            { filter: 'doubled', where: { fn: '>', args: [{ column: 'd' }, { value: 0 }] } }
        ] });
        assert.ok('result' in middle);
        assert.strictEqual(middle.total, 7);
        assert.deepStrictEqual(e.read(middle.result, 0, 2).rows, [[2, 'x'], [0, 'x']]);
    });

    it('check refuses a select with no columns or two of one name, a sort with nothing to sort by, a step that reads one after it', () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [] });
        const said = (q: Parameters<QueryEngine['check']>[0]) => e.check(q).map(p => p.message).join(' | ');
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [] }] }), /at least one column/);
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { column: 'a' } }, { name: 'x', value: { value: 1 } }] }] }), /Two columns are called "x"/);
        assert.match(said({ steps: [{ from: 't' }, { sort: 'step 1', by: [] }] }), /something to sort by/);
        assert.match(said({ steps: [{ from: 't' }, { filter: 'later', where: { value: 1 } }, { as: 'later', select: 'step 1', columns: [{ name: 'a', value: { column: 'a' } }] }] }), /no table or step called "later"/);
    });

    it('tables come in, in pieces, and are read a window at a time; a table still loading is refused', () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a', 'b'], rows: [[1, 'x']] }, { more: true });
        const refused = e.run({ steps: [{ from: 't' }] });
        assert.ok('problems' in refused && /still loading/.test(refused.problems[0].message));
        e.append('t', { columns: ['a', 'b'], rows: [[2, 'y'], [3, null]] }, { last: true });
        const out = e.run({ steps: [{ from: 't' }, { filter: 'step 1', where: { fn: '>', args: [{ column: 'a' }, { value: 1 }] } }] });
        assert.ok('result' in out);
        assert.strictEqual(out.total, 2);
        assert.deepStrictEqual(e.read(out.result, 1, 5), { columns: ['a', 'b'], rows: [[3, null]], total: 2 });
        e.release(out.result);
        assert.throws(() => e.read(out.result, 0, 1));
    });

    it('check refuses, in words, before any work: an unknown table, column, function, arity, and steps of later pieces', () => {
        const e = new QueryEngine();
        e.load('t', { columns: ['a'], rows: [] });
        const said = (q: Parameters<QueryEngine['check']>[0]) => e.check(q).map(p => p.message);
        assert.match(said({ steps: [{ from: 'nope' }] })[0], /no table or step called "nope"/);
        assert.match(said({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { column: 'b' } }] }] })[0], /no column "b"/);
        assert.match(said({ steps: [{ from: 't' }, { filter: 'step 1', where: { fn: 'UPPER', args: [] } }] })[0], /UPPER takes 1 values, not 0/);
        assert.match(said({ steps: [{ from: 't' }, { group: 'step 1', by: [], aggregates: [] }] })[0], /does not run a group step yet/);
    });

    it('Translate values reads a loaded lookup table: the first row whose from-column holds the value, as text; not found, the value', () => {
        const e = new QueryEngine();
        e.load('units', { columns: ['erp', 'wms'], rows: [['EA', 'each'], ['1', 'one'], ['EA', 'second'], ['BX', null]] });
        e.load('t', { columns: ['u'], rows: [['EA'], [1], ['CS'], [null], ['BX']] });
        const out = e.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { fn: 'TRANSLATE', args: [{ column: 'u' }, { value: 'units' }, { value: 'erp' }, { value: 'wms' }] } }] }] });
        assert.ok('result' in out);
        assert.deepStrictEqual(e.read(out.result, 0, 9).rows.map(r => r[0]), ['each', 'one', 'CS', null, 'BX']);
    });
});
