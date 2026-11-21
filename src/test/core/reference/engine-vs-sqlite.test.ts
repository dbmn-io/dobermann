// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine judged against SQLite, by the tester: the same seeded tables (generator.ts) and
 * the same select or filter, run through SQLite as today's Query runs it and through the engine;
 * the rows must be the same, as a multiset.
 *
 * The four differences the engine is meant to have (engine-types.ts "Differences from SQLite")
 * are kept out of the SQLite matrix and tested on their own, with the expected answer written
 * here, not taken from either side:
 *   1. comparisons exact by type; 2. FLOOR/CEIL read text as NUMBER; 3. NUMERIC is NUMBER;
 *   4. UPPER/LOWER on every letter.
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { QueryEngine } from '../../../services/engine/engine';
import type { Expr, Query, Value as EngineValue } from '../../../services/engine/engine-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';
import { makePair, PRESETS, type Table, type Value } from './generator';
import { differences, load, rows } from './sqlite-reference';

/** A generator value as the engine takes it: yes/no as the text "true"/"false", as Query loads. */
const toEngine = (v: Value): EngineValue => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v);

/**
 * James's one rule for reading text as a number (2026-11-21, "Blank." and "ok."), written here
 * from the rule, not from the engine: a number is itself; text that is a plain number, spaces
 * round it allowed, is that number; anything else (other text, "", yes/no) is blank.
 */
export function readNumber(v: EngineValue): EngineValue {
    if (v === null || typeof v === 'number') return v;
    const t = v.trim();
    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
}

/** The table with a column "n:<c>" beside each column: its values read by the rule, for SQLite's number cases. */
function withNumbers(t: Table): Table {
    return { name: t.name, columns: [...t.columns, ...t.columns.map(c => `n:${c}`)], rows: t.rows.map(r => { const e = r.map(toEngine); return [...e, ...e.map(readNumber)]; }) };
}

/** An expression for both sides: the engine's form and SQLite's text. */
interface Case { name: string; engine: Expr; sql: string }
const col = (c: string): Case => ({ name: c, engine: { column: c }, sql: `"${c}"` });
/** A column as a number: the engine reads it by the rule itself; SQLite is given it already read. */
const numCol = (c: string): Case => ({ name: c, engine: { column: c }, sql: `"n:${c}"` });
const lit = (v: string | number): Case => ({ name: JSON.stringify(v), engine: { value: v }, sql: typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'` });
const fn = (name: string, sqlFn: (args: string[]) => string, ...args: Case[]): Case => ({
    name: `${name}(${args.map(a => a.name).join(', ')})`,
    engine: { fn: name as never, args: args.map(a => a.engine) },
    sql: sqlFn(args.map(a => a.sql)),
});

/** Functions whose engine rule is SQLite's (nothing on the differences list), on a value. */
function textCases(x: Case): Case[] {
    return [
        fn('TRIM', a => `TRIM(${a[0]})`, x),
        fn('LTRIM', a => `LTRIM(${a[0]}, ${a[1]})`, x, lit('0')),
        fn('SUBSTR', a => `SUBSTR(${a[0]}, ${a[1]}, ${a[2]})`, x, lit(1), lit(3)),
        fn('SUBSTR', a => `SUBSTR(${a[0]}, ${a[1]})`, x, lit(-2)),
        fn('REPLACE', a => `REPLACE(${a[0]}, ${a[1]}, ${a[2]})`, x, lit('K'), lit('x')),
        fn('LENGTH', a => `LENGTH(${a[0]})`, x),
        fn('TEXT', a => `CAST(${a[0]} AS TEXT)`, x),
        fn('IFBLANK', a => `COALESCE(NULLIF(${a[0]}, ''), ${a[1]})`, x, lit('none')),
        fn('CONCAT', a => a.map(s => `COALESCE(${s}, '')`).join(' || '), x, lit('-'), x),
    ];
}
function numberCases(x: Case): Case[] {
    return [
        fn('+', a => `${a[0]} + ${a[1]}`, x, lit(1)),
        fn('*', a => `${a[0]} * ${a[1]}`, x, lit(2)),
        fn('/', a => `${a[0]} * 1.0 / NULLIF(${a[1]}, 0)`, x, lit(4)),
        fn('NEG', a => `-${a[0]}`, x),
        fn('ABS', a => `ABS(${a[0]})`, x),
        fn('ROUND', a => `ROUND(${a[0]}, ${a[1]})`, x, lit(0)),
    ];
}

describe('Query engine against SQLite (reference, the tester\'s)', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    /** The rows of one select of `exprs` over table L, from both sides. */
    async function both(table: Table, select: Case[], where?: Case): Promise<{ expected: Value[][]; actual: Value[][] }> {
        table = withNumbers(table);
        const db = load(SQL, [table]);
        const sql = `SELECT ${select.map(c => c.sql).join(', ')} FROM "L"${where ? ` WHERE ${where.sql}` : ''}`;
        let expected: Value[][];
        try { expected = rows(db, sql); } finally { db.close(); }
        const engine = new QueryEngine();
        engine.load('L', { columns: table.columns, rows: table.rows.map(r => r.map(toEngine)) });
        const steps: Query['steps'] = [{ as: 'l', from: 'L' }];
        if (where) steps.push({ as: 'f', filter: 'l', where: where.engine });
        steps.push({ as: 'out', select: where ? 'f' : 'l', columns: select.map((c, i) => ({ name: `c${i}`, value: c.engine })) });
        const ran = await engine.run({ steps });
        if (!('result' in ran)) throw new Error(`engine refused: ${JSON.stringify(ran)}`);
        const actual = engine.read(ran.result, 0, ran.total).rows as Value[][];
        engine.release(ran.result);
        return { expected, actual };
    }

    for (const preset of ['plain', 'blanks', 'mixed', 'noisyKeys', 'everything'] as const) {
        it(`select: every text and number function on every column, preset ${preset}`, async () => {
            const { left } = makePair({ seed: 21, rows: 400, ...PRESETS[preset] });
            const failures: string[] = [];
            for (const c of left.columns) {
                for (const k of [col(c), ...textCases(col(c)), ...numberCases(numCol(c))]) {
                    const { expected, actual } = await both(left, [k]);
                    const d = differences(expected, actual, 3);
                    if (d.missing.length || d.extra.length) failures.push(`${k.name}: missing ${d.missing.join(' ')} extra ${d.extra.join(' ')}`);
                }
            }
            assert.deepStrictEqual(failures, [], failures.slice(0, 10).join('\n'));
        });
    }

    it('filter: same-type comparisons and logic keep the same rows as SQLite', async () => {
        const { left } = makePair({ seed: 22, rows: 500, ...PRESETS.repeated });
        const qty = col('qty'), uom = col('uom'), code = col('code');
        const cmp = (op: string, a: Case, b: Case) => fn(op, s => `${s[0]} ${op} ${s[1]}`, a, b);
        const filters = [
            cmp('>', qty, lit(250)), cmp('<=', qty, lit(10)), cmp('=', uom, lit('EA')), cmp('<>', uom, lit('BOX')),
            cmp('>', code, lit('K00200')),
            fn('AND', s => `(${s[0]}) AND (${s[1]})`, cmp('>', qty, lit(100)), cmp('=', uom, lit('EA'))),
            fn('OR', s => `(${s[0]}) OR (${s[1]})`, cmp('<', qty, lit(20)), cmp('=', uom, lit('BOX'))),
            fn('NOT', s => `NOT (${s[0]})`, cmp('=', uom, lit('EA'))),
        ];
        const failures: string[] = [];
        for (const f of filters) {
            const { expected, actual } = await both(left, [code, qty, uom], f);
            const d = differences(expected, actual, 3);
            if (d.missing.length || d.extra.length) failures.push(`${f.name}: missing ${d.missing.length} extra ${d.extra.length}`);
        }
        assert.deepStrictEqual(failures, []);
    });

    it('the harness can see a difference: NUMERIC on text columns differs from SQLite, as intended', async () => {
        const { left } = makePair({ seed: 23, rows: 50, ...PRESETS.plain });
        const { expected, actual } = await both(left, [fn('NUMERIC', a => `CAST(${a[0]} AS NUMERIC)`, col('code'))]);
        const d = differences(expected, actual, 3);
        assert.ok(d.missing.length > 0 && d.extra.length > 0, 'SQLite gives 0 for "K00001", the engine blank');
    });

    // ---- Joins: every kind, every preset, the same rows as SQLite and in the engine's stated order ----

    /** A join of L and R on the pair's key (with key functions on R when given), from both sides. */
    async function joinBoth(pair: ReturnType<typeof makePair>, kind: 'inner' | 'left' | 'right' | 'outer', rightFns: string[] = []): Promise<{ expected: Value[][]; actual: Value[][] }> {
        const { left, right, leftKey, rightKey } = pair;
        const wrap = (sql: string) => rightFns.reduce((s, f) => `${f}(${s})`, sql);
        const wrapE = (e: Expr): Expr => rightFns.reduce<Expr>((x, f) => ({ fn: f as never, args: [x] }), e);
        const cols = [...left.columns.map(c => `"L"."${c}"`), ...right.columns.map(c => `"R"."${c}"`)];
        const on = leftKey.map((l, i) => `"L"."${l}" = ${wrap(`"R"."${rightKey[i]}"`)}`).join(' AND ');
        const JOIN = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', outer: 'FULL OUTER JOIN' }[kind];
        // The engine's order: the left's rows in order, each with its matches in the right's order, then the right's unmatched
        const sql = `SELECT ${cols.join(', ')} FROM "L" ${JOIN} "R" ON ${on} ORDER BY ("L".rowid IS NULL), "L".rowid, "R".rowid`;
        const db = load(SQL, [left, right]);
        let expected: Value[][];
        try { expected = rows(db, sql); } finally { db.close(); }
        const engine = new QueryEngine();
        engine.load('L', { columns: left.columns, rows: left.rows.map(r => r.map(toEngine)) });
        engine.load('R', { columns: right.columns, rows: right.rows.map(r => r.map(toEngine)) });
        const ran = await engine.run({ steps: [
            { as: 'l', from: 'L' }, { as: 'r', from: 'R' },
            { as: 'j', join: kind, left: 'l', right: 'r', on: leftKey.map((l, i) => ({ left: { column: l, of: 'l' }, right: wrapE({ column: rightKey[i], of: 'r' }) })) },
        ] });
        if (!('result' in ran)) throw new Error(`engine refused: ${JSON.stringify(ran)}`);
        const actual = engine.read(ran.result, 0, ran.total).rows as Value[][];
        engine.release(ran.result);
        return { expected, actual };
    }

    for (const preset of ['plain', 'repeated', 'blanks', 'mixed', 'twoColumnKey', 'everything'] as const) {
        it(`join: inner, left, right and outer give SQLite's rows in the engine's order, preset ${preset}`, async () => {
            const pair = makePair({ seed: 31, rows: 300, ...PRESETS[preset] });
            const failures: string[] = [];
            for (const kind of ['inner', 'left', 'right', 'outer'] as const) {
                const { expected, actual } = await joinBoth(pair, kind);
                const d = differences(expected, actual, 2);
                if (d.missing.length || d.extra.length) failures.push(`${kind}: ${expected.length} vs ${actual.length} rows; missing ${d.missing.join(' ')} extra ${d.extra.join(' ')}`);
                else if (JSON.stringify(expected) !== JSON.stringify(actual)) failures.push(`${kind}: same rows, different order`);
            }
            assert.deepStrictEqual(failures, [], failures.join('\n'));
        });
    }

    it('join: TRIM and UPPER on the right key match noisy keys as SQLite does', async () => {
        const pair = makePair({ seed: 32, rows: 300, ...PRESETS.noisyKeys });
        for (const kind of ['inner', 'outer'] as const) {
            const { expected, actual } = await joinBoth(pair, kind, ['TRIM', 'UPPER']);
            const d = differences(expected, actual, 2);
            assert.deepStrictEqual(d, { missing: [], extra: [] }, kind);
        }
    });

    // ---- The four intended differences: the expected answer is written here ----

    /** One value through one function in the engine. */
    async function one(fnName: string, ...args: EngineValue[]): Promise<Value> {
        const engine = new QueryEngine();
        engine.load('T', { columns: ['x'], rows: [[args[0]]] });
        const ran = await engine.run({ steps: [{ as: 't', from: 'T' }, { select: 't', columns: [{ name: 'y', value: { fn: fnName as never, args: [{ column: 'x' }, ...args.slice(1).map(v => ({ value: v }))] } }] }] });
        if (!('result' in ran)) throw new Error(JSON.stringify(ran));
        return engine.read(ran.result, 0, 1).rows[0][0] as Value;
    }

    it('difference 1 (James, 2026-11-21: "loose is good. do it."): a number equals text with the same characters', async () => {
        assert.strictEqual(await one('=', 42, '42'), 1);
        assert.strictEqual(await one('=', '42', 42), 1);
        assert.strictEqual(await one('=', 12.5, '12.5'), 1);
        assert.strictEqual(await one('=', 42, 42), 1);
        assert.strictEqual(await one('=', '42', '42'), 1);
        // Loose is by the text, never by reading the text as a number: leading zeros and trailing zeros still differ.
        assert.strictEqual(await one('=', 7, '007'), 0);
        assert.strictEqual(await one('=', 12.5, '12.50'), 0);
        assert.strictEqual(await one('=', 42, ' 42'), 0);
    });

    it('difference 2 (James, 2026-11-21: text that is not a number reads as blank): FLOOR and CEIL read text as NUMBER does', async () => {
        assert.strictEqual(await one('FLOOR', 'abc'), null);
        assert.strictEqual(await one('FLOOR', '12abc'), null);
        assert.strictEqual(await one('FLOOR', '1e3'), 1000);
        assert.strictEqual(await one('CEIL', '2.1'), 3);
    });

    it('difference 3 (James, 2026-11-21: "Blank."): As a number (NUMERIC) is NUMBER: not a plain number gives blank', async () => {
        assert.strictEqual(await one('NUMERIC', 'abc'), null);
        assert.strictEqual(await one('NUMERIC', '12abc'), null);
        assert.strictEqual(await one('NUMERIC', ''), null);
        assert.strictEqual(await one('NUMERIC', '0042'), 42);
    });

    it('difference 2 too: one rule everywhere: arithmetic, Sum, and the edges SQLite reads differently', async () => {
        assert.strictEqual(await one('+', 'abc', 1), null);
        assert.strictEqual(await one('+', '12abc', 1), null);
        assert.strictEqual(await one('+', ' 41 ', 1), 42);
        assert.strictEqual(await one('*', '', 2), null);
        assert.strictEqual(await one('NUMBER', '1.2.3'), null);
        assert.strictEqual(await one('NUMBER', '1e'), null);
        assert.strictEqual(await one('NUMBER', '1e3'), 1000);
        assert.strictEqual(await one('ABS', '-7'), 7);
        const e = new QueryEngine();
        e.load('T', { columns: ['x'], rows: [['abc'], ['12abc'], ['5'], [3], [''], [null]] });
        const ran = await e.run({ steps: [{ as: 't', from: 'T' }, { group: 't', by: [], aggregates: [{ name: 's', fn: 'sum', value: { column: 'x' } }] }] });
        assert.ok('result' in ran);
        assert.deepStrictEqual(e.read(ran.result, 0, 1).rows, [[8]], 'Sum adds "5" and 3; "abc", "12abc", "" add nothing');
        const none = new QueryEngine();
        none.load('T', { columns: ['x'], rows: [['abc'], ['']] });
        const r2 = await none.run({ steps: [{ as: 't', from: 'T' }, { group: 't', by: [], aggregates: [{ name: 's', fn: 'sum', value: { column: 'x' } }] }] });
        assert.ok('result' in r2);
        assert.deepStrictEqual(none.read(r2.result, 0, 1).rows, [[null]], 'a sum with nothing to add is blank');
    });

    it('difference 2, the count (James, 2026-11-21: "blank, plus a count"): text that is not a number is counted, blanks are not', async () => {
        // Counted by hand: 'abc', '12abc' and '1.2.3' are text that isn't a number; '', ' ' and null are already blank;
        // ' 41 ', '5' and 3 are numbers. So 3 in every column that reads x as a number, and none in one that doesn't.
        const xs: EngineValue[] = ['abc', '12abc', '5', 3, '', ' ', null, ' 41 ', '1.2.3'];
        const e = new QueryEngine();
        e.load('T', { columns: ['x'], rows: xs.map(v => [v]) });
        const ran = await e.run({ steps: [{ as: 't', from: 'T' }, { as: 'r', select: 't', columns: [
            { name: 'plus', value: { fn: '+' as never, args: [{ column: 'x' }, { value: 1 }] } },
            { name: 'num', value: { fn: 'NUMBER' as never, args: [{ column: 'x' }] } },
            { name: 'floor', value: { fn: 'FLOOR' as never, args: [{ column: 'x' }] } },
            { name: 'upper', value: { fn: 'UPPER' as never, args: [{ column: 'x' }] } },
            { name: 'same', value: { column: 'x' } },
        ] }] }, { countNotNumbers: ['plus', 'num', 'floor', 'upper', 'same'] });
        assert.ok('result' in ran, JSON.stringify(ran));
        assert.deepStrictEqual(ran.notNumbers, { r: { plus: 3, num: 3, floor: 3 } }, 'only counts above 0; Upper and a plain column read no numbers');
        const g = new QueryEngine();
        g.load('T', { columns: ['k', 'x'], rows: xs.map((v, i) => [i < 4 ? 'a' : 'b', v]) });
        const grouped = await g.run({ steps: [{ as: 't', from: 'T' }, { as: 'g', group: 't', by: [{ name: 'k', value: { column: 'k' } }], aggregates: [{ name: 's', fn: 'sum', value: { column: 'x' } }, { name: 'n', fn: 'countValues', value: { column: 'x' } }] }] });
        assert.ok('result' in grouped, JSON.stringify(grouped));
        assert.deepStrictEqual(g.read(grouped.result, 0, 2).rows, [['a', 8, 4], ['b', 41, 4]]);
        assert.deepStrictEqual(grouped.notNumbers, { g: { s: 3 } }, 'Sum left out "abc", "12abc" and "1.2.3"; Count of values reads no numbers');
    });

    it('difference 2, the count: a yes/no test (IF, AND, a filter) on such text is not true and is not counted', async () => {
        const e = new QueryEngine();
        e.load('T', { columns: ['x'], rows: [['abc'], ['1'], [1], ['1.2.3'], [null]] });
        const ran = await e.run({ steps: [{ as: 't', from: 'T' }, { as: 'f', filter: 't', where: { fn: 'OR' as never, args: [{ column: 'x' }, { value: 1 }] } },   // reads x as yes/no, keeps every row
            { as: 'r', select: 'f', columns: [
                { name: 'iff', value: { fn: 'IF' as never, args: [{ column: 'x' }, { value: 'yes' }, { value: 'no' }] } },
                { name: 'both', value: { fn: 'AND' as never, args: [{ column: 'x' }, { value: 1 }] } },
            ] }] }, { countNotNumbers: ['iff', 'both'] });
        assert.ok('result' in ran, JSON.stringify(ran));
        assert.strictEqual(ran.notNumbers, undefined);
        assert.deepStrictEqual(e.read(ran.result, 0, ran.total).rows.map(r => r[0]), ['no', 'yes', 'yes', 'no', 'no'], '"abc" and "1.2.3" are not true; "1" and 1 are');
    });

    it('difference 1 in a group (the Query session\'s reading of "equal", 2026-11-21): 42 and "42" are one group; "042" is not', async () => {
        const e = new QueryEngine();
        e.load('T', { columns: ['k'], rows: [[42], ['42'], ['042'], [12.5], ['12.5'], ['12.50'], [null], [null]] });
        const ran = await e.run({ steps: [{ as: 't', from: 'T' }, { as: 'g', group: 't', by: [{ name: 'k', value: { column: 'k' } }], aggregates: [{ name: 'n', fn: 'count' }] }] });
        assert.ok('result' in ran, JSON.stringify(ran));
        const counts = e.read(ran.result, 0, ran.total).rows.map(r => r[1]);
        assert.deepStrictEqual(counts, [2, 1, 2, 1, 2], 'by first seen: 42 twice, "042", 12.5 twice, "12.50", blank twice');
    });

    it('difference 4 (James, 2026-11-21: "Yes."): Upper and Lower case change every letter, accented ones too', async () => {
        assert.strictEqual(await one('UPPER', 'café'), 'CAFÉ');
        assert.strictEqual(await one('LOWER', 'ÉTÉ'), 'été');
    });
});

describe('Query engine group against SQLite (reference, the tester\'s)', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    /** A group of L by `by` (column names; none for one row), every aggregate on `of`, from both sides, groups in first-seen order. */
    async function both(table: Table, by: string[], of: string): Promise<{ expected: Value[][]; actual: Value[][] }> {
        const q = (c: string) => `"${c}"`;
        // Sum reads text by the rule (text that is not a number left out): SQLite sums the read column
        const aggs = `COUNT(*), COUNT(${q(of)}), SUM(${q(`n:${of}`)}), MIN(${q(of)}), MAX(${q(of)})`;
        table = withNumbers(table);
        const sql = by.length
            ? `SELECT ${by.map(q).join(', ')}, ${aggs} FROM "L" GROUP BY ${by.map(q).join(', ')} ORDER BY MIN(rowid)`
            : `SELECT ${aggs} FROM "L"`;
        const db = load(SQL, [table]);
        let expected: Value[][];
        try { expected = rows(db, sql); } finally { db.close(); }
        const e = new QueryEngine();
        e.load('L', { columns: table.columns, rows: table.rows.map(r => r.map(toEngine)) });
        const ran = await e.run({ steps: [{ as: 'l', from: 'L' }, { group: 'l', by: by.map(c => ({ name: c, value: { column: c } })), aggregates: (['count', 'countValues', 'sum', 'min', 'max'] as const).map(fn => ({ name: fn, fn, ...(fn === 'count' ? {} : { value: { column: of } }) })) }] });
        if (!('result' in ran)) throw new Error(JSON.stringify(ran));
        return { expected, actual: e.read(ran.result, 0, ran.total).rows as Value[][] };
    }

    for (const preset of ['plain', 'repeated', 'blanks', 'mixed', 'twoColumnKey', 'everything'] as const) {
        it(`by one column, two, and none; every aggregate on every column; preset ${preset}`, async () => {
            const { left } = makePair({ seed: 61, rows: 400, ...PRESETS[preset] });
            const failures: string[] = [];
            for (const by of [['uom'], ['code'], ['uom', ...(left.columns.includes('site') ? ['site'] : ['qty'])], []]) {
                for (const of of left.columns) {
                    const { expected, actual } = await both(left, by, of);
                    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                        const i = expected.findIndex((r, n) => JSON.stringify(r) !== JSON.stringify(actual[n]));
                        failures.push(`by ${by.join('+') || '(none)'} of ${of}: ${expected.length} vs ${actual.length} groups; first difference ${JSON.stringify(expected[i])} vs ${JSON.stringify(actual[i])}`);
                    }
                }
            }
            assert.deepStrictEqual(failures, [], failures.slice(0, 6).join('\n'));
        });
    }

    it('with no rows: no groups by a column, and one row with none', async () => {
        const empty: Table = { name: 'L', columns: ['code', 'qty'], rows: [] };
        const a = await both(empty, ['code'], 'qty');
        assert.deepStrictEqual(a.actual, a.expected);
        const b = await both(empty, [], 'qty');
        assert.deepStrictEqual(b.actual, b.expected);
        assert.strictEqual(b.actual.length, 1);
    });
});
