// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Calculations (src/services/query/formula.ts): formulas read into a tree, columns found by their
 * @ path, and the SQL each one runs as, run on SQLite. Also the row limit: a join that would make
 * too many rows is found before it is made.
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { QuerySession, QueryRowData } from '../../../services/query/query-engine';
import { formulaColumns, writeSql } from '../../../services/query/query-sql';
import { FormulaColumn, FormulaError, fullRef, fullText, parseFormula, resolvePath, shortRef, shortText } from '../../../services/query/formula';
import type { QueryKey, QuerySpec } from '../../../services/query/query-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

const col = (view: string, column: string): QueryKey => ({ parts: [{ view, column }] });

/** Stock from the warehouse and a stock count from a file, on sku. */
const SPEC: QuerySpec = {
    views: [
        { id: 'stk', name: 'Stock', columns: ['sku', 'quantityOnHand', 'quantityAvailable', 'status', 'description', 'address.city', 'code'] },
        { id: 'cnt', name: 'Counts', columns: ['SKU', 'Qty Counted', 'description'] }
    ],
    joins: [{ view: 'cnt', kind: 'left', on: [{ left: col('stk', 'sku'), right: col('cnt', 'SKU') }] }],
    select: [{ view: 'stk', column: 'sku' }]
};

const DATA: Record<string, QueryRowData[]> = {
    stk: [
        { sku: 'WOOF-033', quantityOnHand: 54, quantityAvailable: 52, status: 'ACTIVE', description: 'Kibble 10 kg', 'address.city': 'Melbourne', code: ' 0042 ' },
        { sku: 'WOOF-902', quantityOnHand: 7, quantityAvailable: 7, status: 'HOLD', description: null, 'address.city': 'Sydney', code: 'abc' },
        { sku: 'MEOW-118', quantityOnHand: 0, quantityAvailable: 0, status: 'ACTIVE', description: 'Litter 5 kg', 'address.city': null, code: '1.5' }
    ],
    cnt: [
        { SKU: 'WOOF-033', 'Qty Counted': 52, description: 'Kibble 10kg' },
        { SKU: 'MEOW-118', 'Qty Counted': null, description: 'Litter 5 kg' }
    ]
};

const COLUMNS: FormulaColumn[] = formulaColumns(SPEC);
const key = (view: string, column: string): string => `${view}\n${column}`;

describe('Calculations', () => {
    let SQL: SqlJsStatic;
    let session: QuerySession;
    before(async () => {
        SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH });
        session = new QuerySession(SQL, SPEC);
        for (const [id, rows] of Object.entries(DATA)) await session.load(id, rows);
    });
    after(() => session.close());

    /** The formula's value on each Stock row, in Stock's order. */
    function values(formula: string): unknown[] {
        const spec: QuerySpec = { ...SPEC, calc: [{ name: 'out', expr: '', formula: fullText(formula, COLUMNS) }], select: [{ view: '', column: 'out' }] };
        session.setSpec(spec);
        return session.run(writeSql(spec)).rows.map(r => r[0]);
    }
    function problem(formula: string): FormulaError {
        try {
            parseFormula(formula, COLUMNS);
        } catch (error) {
            if (error instanceof FormulaError) return error;
            throw error;
        }
        throw new Error(`No error for ${formula}`);
    }

    describe('columns by @ path', () => {
        it('finds a column by its name alone when only one view has it', () => {
            assert.deepStrictEqual(resolvePath(['quantityOnHand'], COLUMNS).map(c => c.key), [key('stk', 'quantityOnHand')]);
        });
        it('never picks sku or SKU by its capitals: both are offered, and the view tells them apart', () => {
            assert.deepStrictEqual(resolvePath(['sku'], COLUMNS).map(c => c.key), [key('stk', 'sku'), key('cnt', 'SKU')]);
            assert.deepStrictEqual(resolvePath(['SKU'], COLUMNS).map(c => c.key), [key('stk', 'sku'), key('cnt', 'SKU')]);
            assert.deepStrictEqual(resolvePath(['Counts', 'sku'], COLUMNS).map(c => c.key), [key('cnt', 'SKU')]);
            const byKey = (k: string): FormulaColumn => COLUMNS.find(c => c.key === k) as FormulaColumn;
            assert.strictEqual(shortRef(byKey(key('cnt', 'SKU')), COLUMNS), '@Counts.SKU');
            assert.deepStrictEqual(problem('@sku').choices, ['@Stock.sku', '@Counts.SKU']);
        });
        it('finds two columns when two views share a name, and the view tells them apart', () => {
            assert.strictEqual(resolvePath(['description'], COLUMNS).length, 2);
            assert.deepStrictEqual(resolvePath(['Counts', 'description'], COLUMNS).map(c => c.key), [key('cnt', 'description')]);
        });
        it('goes inside a column with a dot, and finds a key by its own name', () => {
            assert.deepStrictEqual(resolvePath(['address', 'city'], COLUMNS).map(c => c.key), [key('stk', 'address.city')]);
            assert.deepStrictEqual(resolvePath(['city'], COLUMNS).map(c => c.key), [key('stk', 'address.city')]);
            assert.deepStrictEqual(resolvePath(['Stock', 'address.city'], COLUMNS).map(c => c.key), [key('stk', 'address.city')]);
        });
        it('writes the shortest path that is unique, and the whole path to save', () => {
            const byKey = (k: string): FormulaColumn => COLUMNS.find(c => c.key === k) as FormulaColumn;
            assert.strictEqual(shortRef(byKey(key('stk', 'quantityOnHand')), COLUMNS), '@quantityOnHand');
            assert.strictEqual(shortRef(byKey(key('cnt', 'description')), COLUMNS), '@Counts.description');
            assert.strictEqual(shortRef(byKey(key('cnt', 'Qty Counted')), COLUMNS), '@"Qty Counted"');
            assert.strictEqual(fullRef(byKey(key('cnt', 'Qty Counted'))), '@Counts."Qty Counted"');
            assert.strictEqual(fullText('@quantityOnHand - @"Qty Counted"', COLUMNS), '@Stock.quantityOnHand - @Counts."Qty Counted"');
            assert.strictEqual(shortText('@Stock.quantityOnHand - @Counts."Qty Counted"', COLUMNS), '@quantityOnHand - @"Qty Counted"');
        });
        it('a run is a level of the path: BL and C1 tell a view\'s runs apart', () => {
            const runs: FormulaColumn[] = [
                { key: 'bl', path: ['Stock', 'BL', 'quantityOnHand'] },
                { key: 'c1', path: ['Stock', 'C1', 'quantityOnHand'] },
                { key: 'items', path: ['Items', 'qtyOnHand'] }
            ];
            assert.strictEqual(resolvePath(['quantityOnHand'], runs).length, 2);
            assert.strictEqual(shortRef(runs[1], runs), '@C1.quantityOnHand');
            assert.deepStrictEqual(resolvePath(['Stock', 'C1', 'quantityOnHand'], runs).map(c => c.key), ['c1']);
        });
    });

    describe('what a formula works out', () => {
        it('sums, differences and comparisons', () => {
            assert.deepStrictEqual(values('@quantityOnHand - @quantityAvailable'), [2, 0, 0]);
            assert.deepStrictEqual(values('@quantityOnHand = @quantityAvailable'), [0, 1, 1]);
            assert.deepStrictEqual(values('-@quantityOnHand + 1'), [-53, -6, 1]);
        });
        it('dividing keeps the decimals, and dividing by 0 is blank', () => {
            assert.deepStrictEqual(values('@quantityOnHand / 4'), [13.5, 1.75, 0]);
            assert.deepStrictEqual(values('@quantityOnHand / @quantityAvailable'), [54 / 52, 1, null]);
        });
        it('a blank in a sum is blank; IFBLANK picks the other value', () => {
            assert.deepStrictEqual(values('@quantityOnHand - @"Qty Counted"'), [2, null, null]);
            assert.deepStrictEqual(values('@quantityOnHand - IFBLANK(@"Qty Counted", 0)'), [2, 7, 0]);
        });
        it('IF, AND, OR, NOT, nested', () => {
            assert.deepStrictEqual(values('IF(@quantityOnHand = IFBLANK(@"Qty Counted", 0), "Counted right", "Recount")'), ['Recount', 'Recount', 'Counted right']);
            assert.deepStrictEqual(values('IF(AND(@quantityOnHand > 0, @status = "ACTIVE"), "Sell", "Hold")'), ['Sell', 'Hold', 'Hold']);
            assert.deepStrictEqual(values('IF(OR(@status = "HOLD", @quantityOnHand = 0), 1, 0)'), [0, 1, 1]);
            assert.deepStrictEqual(values('IF(NOT(@status = "HOLD"), "open")'), ['open', null, 'open']);
        });
        it('numbers: ROUND, ABS, FLOOR, CEIL, MIN, MAX', () => {
            assert.deepStrictEqual(values('ROUND(@quantityOnHand / 52 * 100, 1)'), [103.8, 13.5, 0]);
            assert.deepStrictEqual(values('ABS(@quantityAvailable - @quantityOnHand)'), [2, 0, 0]);
            assert.deepStrictEqual(values('FLOOR(@quantityOnHand / 4)'), [13, 1, 0]);
            assert.deepStrictEqual(values('CEIL(@quantityOnHand / 4)'), [14, 2, 0]);
            assert.deepStrictEqual(values('FLOOR(0 - @quantityOnHand / 4)'), [-14, -2, 0]);
            assert.deepStrictEqual(values('CEIL(0 - @quantityOnHand / 4)'), [-13, -1, 0]);
            assert.deepStrictEqual(values('MIN(@quantityOnHand, @quantityAvailable)'), [52, 7, 0]);
            assert.deepStrictEqual(values('MAX(@quantityOnHand, @quantityAvailable, 10)'), [54, 10, 10]);
        });
        it('text: CONCAT counts a blank as nothing; LEFT, RIGHT, SUBSTR, REPLACE, LENGTH, UPPER, LOWER, TRIM', () => {
            assert.deepStrictEqual(values('CONCAT(@Stock.sku, " · ", @Stock.description)'), ['WOOF-033 · Kibble 10 kg', 'WOOF-902 · ', 'MEOW-118 · Litter 5 kg']);
            assert.deepStrictEqual(values('LEFT(@Stock.sku, 4)'), ['WOOF', 'WOOF', 'MEOW']);
            assert.deepStrictEqual(values('RIGHT(@Stock.sku, 3)'), ['033', '902', '118']);
            assert.deepStrictEqual(values('RIGHT(@Stock.sku, 0)'), ['', '', '']);
            assert.deepStrictEqual(values('SUBSTR(@Stock.sku, 6, 2)'), ['03', '90', '11']);
            assert.deepStrictEqual(values('REPLACE(@Stock.sku, "-", "")'), ['WOOF033', 'WOOF902', 'MEOW118']);
            assert.deepStrictEqual(values('LENGTH(@Stock.sku)'), [8, 8, 8]);
            assert.deepStrictEqual(values('LOWER(@status)'), ['active', 'hold', 'active']);
            assert.deepStrictEqual(values('UPPER(TRIM(@code))'), ['0042', 'ABC', '1.5']);
        });
        it('NUMBER makes number text a number and anything else blank; TEXT makes text', () => {
            assert.deepStrictEqual(values('NUMBER(@code)'), [42, null, 1.5]);
            assert.deepStrictEqual(values('NUMBER(@code) + 1'), [43, null, 2.5]);
            assert.deepStrictEqual(values('NUMBER(@quantityOnHand)'), [54, 7, 0]);
            assert.deepStrictEqual(values('TEXT(@quantityOnHand) = "54"'), [1, 0, 0]);
        });
        it('text in single quotes too, and a quote inside text doubled', () => {
            assert.deepStrictEqual(values(`CONCAT('it''s ', @status)`), ["it's ACTIVE", "it's HOLD", "it's ACTIVE"]);
            assert.deepStrictEqual(values('CONCAT("say ""hi""", "")'), ['say "hi"', 'say "hi"', 'say "hi"']);
        });
        it('a column inside another, by its path', () => {
            assert.deepStrictEqual(values('UPPER(@address.city)'), ['MELBOURNE', 'SYDNEY', null]);
        });
        it('COMPARE makes a column per side', () => {
            const spec: QuerySpec = { ...SPEC, calc: [{ name: 'qty', expr: '', formula: 'COMPARE(@quantityOnHand, @quantityAvailable)' }], select: [{ view: '', column: 'qty' }] };
            session.setSpec(spec);
            const out = session.run(writeSql(spec));
            assert.deepStrictEqual(out.columns, ['qty 1', 'qty 2']);
            assert.deepStrictEqual(out.rows, [[54, 52], [7, 7], [0, 0]]);
        });
        it('a calculation written as SQL before the builder still runs as it is', () => {
            const spec: QuerySpec = { ...SPEC, calc: [{ name: 'old', expr: 'stock.quantityOnHand * 2' }], select: [{ view: '', column: 'old' }] };
            session.setSpec(spec);
            assert.deepStrictEqual(session.run(writeSql(spec)).rows.map(r => r[0]), [108, 14, 0]);
        });
    });

    describe('what is wrong, in words', () => {
        it('a column that two views have lists both to pick from', () => {
            const e = problem('@description');
            assert.match(e.message, /more than one column: pick one/);
            assert.deepStrictEqual(e.choices, ['@Stock.description', '@Counts.description']);
        });
        it('says what is missing and where', () => {
            assert.match(problem('ROUND(@quantityOnHand, 1').message, /ROUND\( is not closed/);
            assert.match(problem('(@quantityOnHand + 1').message, /bracket is not closed/);
            assert.match(problem('SUMMIT(@quantityOnHand)').message, /no function called SUMMIT/);
            assert.match(problem('LEFT(@Stock.sku)').message, /LEFT takes 2: LEFT\(text, count\)/);
            assert.match(problem('@nope').message, /no column @nope/);
            assert.match(problem('@').message, /Pick a column after @/);
            assert.match(problem('"open').message, /no closing quote/);
            assert.match(problem('@Stock.sku @Stock.sku').message, /Didn’t expect/);
            assert.strictEqual(problem('@quantityOnHand + @nope').at, 18);
        });
        it('COMPARE goes only around the whole calculation', () => {
            assert.match(problem('UPPER(COMPARE(@Stock.sku, @Counts.SKU))').message, /COMPARE goes on its own/);
            assert.match(problem('COMPARE(@Stock.sku)').message, /COMPARE takes 2 to 4/);
            assert.ok(parseFormula('COMPARE(UPPER(@Stock.sku), @Counts.SKU)', COLUMNS).compare);
        });
    });
});

describe('Too many rows', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    /** 200 stock rows and 300 lots, all on three statuses: a join on status repeats rows badly. */
    async function session(kind: 'left' | 'inner'): Promise<QuerySession> {
        const spec: QuerySpec = {
            views: [{ id: 's', name: 'Stock', columns: ['sku', 'status'] }, { id: 'l', name: 'Lots', columns: ['lot', 'status'] }],
            joins: [{ view: 'l', kind, on: [{ left: col('s', 'status'), right: col('l', 'status') }] }],
            select: []
        };
        const out = new QuerySession(SQL, spec);
        const statuses = ['A', 'B', 'C'];
        await out.load('s', Array.from({ length: 200 }, (_, i) => ({ sku: `S${i}`, status: i < 10 ? 'X' : statuses[i % 3] })));
        await out.load('l', Array.from({ length: 300 }, (_, i) => ({ lot: `L${i}`, status: statuses[i % 3] })));
        return out;
    }

    it('works out the rows a join makes without making them, as COUNT(*) does', async () => {
        for (const kind of ['left', 'inner'] as const) {
            const s = await session(kind);
            assert.strictEqual(s.rowsAfterJoin(0), s.count(), kind);
            s.close();
        }
    });
    it('names the first join over the limit, and nothing under it', async () => {
        const s = await session('left');
        const rows = s.count();
        assert.deepStrictEqual(s.tooManyRows(rows - 1), { join: 0, rows, limit: rows - 1 });
        assert.strictEqual(s.tooManyRows(rows), undefined);
        assert.strictEqual(s.tooManyRows(), undefined);
        s.close();
    });
});

describe('Right and outer joins', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    /** Stock and a count: one sku in both, one only in Stock, two only in the count. */
    async function session(kind: 'inner' | 'left' | 'right' | 'outer'): Promise<QuerySession> {
        const spec: QuerySpec = {
            views: [{ id: 's', name: 'Stock', columns: ['sku', 'qty'] }, { id: 'c', name: 'Counts', columns: ['SKU', 'counted'] }],
            joins: [{ view: 'c', kind, on: [{ left: col('s', 'sku'), right: col('c', 'SKU') }] }],
            select: []
        };
        const out = new QuerySession(SQL, spec);
        await out.load('s', [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);
        await out.load('c', [{ SKU: 'A', counted: 1 }, { SKU: 'C', counted: 5 }, { SKU: null, counted: 9 }]);
        return out;
    }

    it('writes RIGHT JOIN and FULL OUTER JOIN, and keeps the rows each should', async () => {
        const rows: Record<string, number> = { inner: 1, left: 2, right: 3, outer: 4 };
        for (const kind of ['inner', 'left', 'right', 'outer'] as const) {
            const s = await session(kind);
            const sql = s.sql();
            if (kind === 'right') assert.match(sql, /RIGHT JOIN Counts/);
            if (kind === 'outer') assert.match(sql, /FULL OUTER JOIN Counts/);
            assert.strictEqual(s.count(), rows[kind], kind);
            assert.strictEqual(s.rowsAfterJoin(0), rows[kind], `${kind}: worked out`);
            assert.strictEqual(s.joinStats(0).rowsAfter, rows[kind], `${kind}: in the join's counts`);
            s.close();
        }
    });
    it('shows the joining view\'s key in a right or outer join: its unmatched rows have it only there', async () => {
        const s = await session('outer');
        const out = s.rows();
        assert.deepStrictEqual(out.columns, ['sku', 'qty', 'SKU', 'counted']);
        assert.ok(out.rows.some(r => r[0] === null && r[2] === 'C'));
        s.close();
    });
});
