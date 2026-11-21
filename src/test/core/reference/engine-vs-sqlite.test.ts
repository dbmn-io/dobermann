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

/** An expression for both sides: the engine's form and SQLite's text. */
interface Case { name: string; engine: Expr; sql: string }
const col = (c: string): Case => ({ name: c, engine: { column: c }, sql: `"${c}"` });
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
    function both(table: Table, select: Case[], where?: Case): { expected: Value[][]; actual: Value[][] } {
        const db = load(SQL, [table]);
        const sql = `SELECT ${select.map(c => c.sql).join(', ')} FROM "L"${where ? ` WHERE ${where.sql}` : ''}`;
        let expected: Value[][];
        try { expected = rows(db, sql); } finally { db.close(); }
        const engine = new QueryEngine();
        engine.load('L', { columns: table.columns, rows: table.rows.map(r => r.map(toEngine)) });
        const steps: Query['steps'] = [{ as: 'l', from: 'L' }];
        if (where) steps.push({ as: 'f', filter: 'l', where: where.engine });
        steps.push({ as: 'out', select: where ? 'f' : 'l', columns: select.map((c, i) => ({ name: `c${i}`, value: c.engine })) });
        const ran = engine.run({ steps });
        if ('problems' in ran) throw new Error(`engine refused: ${JSON.stringify(ran.problems)}`);
        const actual = engine.read(ran.result, 0, ran.total).rows as Value[][];
        engine.release(ran.result);
        return { expected, actual };
    }

    for (const preset of ['plain', 'blanks', 'mixed', 'noisyKeys', 'everything'] as const) {
        it(`select: every text and number function on every column, preset ${preset}`, () => {
            const { left } = makePair({ seed: 21, rows: 400, ...PRESETS[preset] });
            const failures: string[] = [];
            for (const c of left.columns) {
                for (const k of [col(c), ...textCases(col(c)), ...numberCases(col(c))]) {
                    const { expected, actual } = both(left, [k]);
                    const d = differences(expected, actual, 3);
                    if (d.missing.length || d.extra.length) failures.push(`${k.name}: missing ${d.missing.join(' ')} extra ${d.extra.join(' ')}`);
                }
            }
            assert.deepStrictEqual(failures, [], failures.slice(0, 10).join('\n'));
        });
    }

    it('filter: same-type comparisons and logic keep the same rows as SQLite', () => {
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
            const { expected, actual } = both(left, [code, qty, uom], f);
            const d = differences(expected, actual, 3);
            if (d.missing.length || d.extra.length) failures.push(`${f.name}: missing ${d.missing.length} extra ${d.extra.length}`);
        }
        assert.deepStrictEqual(failures, []);
    });

    it('the harness can see a difference: NUMERIC on text columns differs from SQLite, as intended', () => {
        const { left } = makePair({ seed: 23, rows: 50, ...PRESETS.plain });
        const { expected, actual } = both(left, [fn('NUMERIC', a => `CAST(${a[0]} AS NUMERIC)`, col('code'))]);
        const d = differences(expected, actual, 3);
        assert.ok(d.missing.length > 0 && d.extra.length > 0, 'SQLite gives 0 for "K00001", the engine blank');
    });

    // ---- The four intended differences: the expected answer is written here ----

    /** One value through one function in the engine. */
    function one(fnName: string, ...args: EngineValue[]): Value {
        const engine = new QueryEngine();
        engine.load('T', { columns: ['x'], rows: [[args[0]]] });
        const ran = engine.run({ steps: [{ as: 't', from: 'T' }, { select: 't', columns: [{ name: 'y', value: { fn: fnName as never, args: [{ column: 'x' }, ...args.slice(1).map(v => ({ value: v }))] } }] }] });
        if ('problems' in ran) throw new Error(JSON.stringify(ran.problems));
        return engine.read(ran.result, 0, 1).rows[0][0] as Value;
    }

    it('difference 1: comparisons are exact by type (a number never equals text)', () => {
        assert.strictEqual(one('=', 42, '42'), 0);
        assert.strictEqual(one('=', '42', 42), 0);
        assert.strictEqual(one('=', 42, 42), 1);
        assert.strictEqual(one('=', '42', '42'), 1);
    });

    it('difference 2: FLOOR and CEIL read text as NUMBER does', () => {
        assert.strictEqual(one('FLOOR', 'abc'), null);
        assert.strictEqual(one('FLOOR', '12abc'), null);
        assert.strictEqual(one('FLOOR', '1e3'), 1000);
        assert.strictEqual(one('CEIL', '2.1'), 3);
    });

    it('difference 3: As a number (NUMERIC) is NUMBER: not a plain number gives blank', () => {
        assert.strictEqual(one('NUMERIC', 'abc'), null);
        assert.strictEqual(one('NUMERIC', '12abc'), null);
        assert.strictEqual(one('NUMERIC', ''), null);
        assert.strictEqual(one('NUMERIC', '0042'), 42);
    });

    it('difference 4: Upper and Lower case change every letter, accented ones too', () => {
        assert.strictEqual(one('UPPER', 'café'), 'CAFÉ');
        assert.strictEqual(one('LOWER', 'ÉTÉ'), 'été');
    });
});
