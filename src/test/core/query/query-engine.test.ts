// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query: the SQL the builder writes and what SQLite makes of it (src/services/query).
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { QuerySession, QueryRowData } from '../reference/query-engine';
import { defaultColumns, joinKeyColumns, quoteName, tableNames, writeSql } from '../reference/query-sql';
import { readFileRows } from '../../../services/query/query-file';
import * as XLSX from 'xlsx';
import { cleanViewName, guessViewName, moveView, moveViewFirst, QuerySource, renameView, SavedQuery, viewNameProblem } from '../../../services/query/query-store';
import type { QueryKey, QuerySpec } from '../../../services/query/query-types';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

const col = (view: string, column: string): QueryKey => ({ parts: [{ view, column }] });

/** The mock-up's report: stock, each item, its supplier, each location. */
const STOCK: QuerySpec = {
    views: [
        { id: 'inv', name: 'inventory', columns: ['sku', 'quantityOnHand', 'locationId', 'facilityId', 'status'] },
        { id: 'itm', name: 'items', columns: ['sku', 'description', 'supplierId', 'status'] },
        { id: 'sup', name: 'suppliers', columns: ['id', 'name'] },
        { id: 'loc', name: 'locations', columns: ['id', 'facilityId', 'zone'] }
    ],
    joins: [
        { view: 'itm', kind: 'left', on: [{ left: col('inv', 'sku'), right: col('itm', 'sku') }] },
        { view: 'sup', kind: 'left', on: [{ left: col('itm', 'supplierId'), right: col('sup', 'id') }] },
        { view: 'loc', kind: 'inner', on: [
            { left: col('inv', 'locationId'), right: col('loc', 'id') },
            { left: col('inv', 'facilityId'), right: col('loc', 'facilityId') }
        ] }
    ],
    select: [
        { view: 'inv', column: 'sku' }, { view: 'itm', column: 'description' }, { view: 'inv', column: 'quantityOnHand' },
        { view: 'sup', column: 'name' }, { view: 'loc', column: 'zone' }
    ]
};

const DATA: Record<string, QueryRowData[]> = {
    inv: [
        { sku: 'WOOF-001', quantityOnHand: 120, locationId: 'A1', facilityId: 'F1', status: 'active' },
        { sku: 'WOOF-002', quantityOnHand: 36, locationId: 'A2', facilityId: 'F1', status: 'active' },
        { sku: 'MEOW-014', quantityOnHand: 0, locationId: 'A1', facilityId: 'F2', status: 'reserved' },
        { sku: 'PURR-220', quantityOnHand: 8, locationId: 'Z9', facilityId: 'F1', status: 'active' }
    ],
    itm: [
        { sku: 'WOOF-001', description: 'Chew rope, large', supplierId: 1, status: 'active' },
        { sku: 'WOOF-002', description: 'Squeaky bone', supplierId: 1, status: 'discontinued' },
        { sku: 'PURR-220', description: 'Laser pointer', supplierId: 2, status: 'active' }
    ],
    sup: [{ id: 1, name: 'Bark & Co' }, { id: 2, name: 'Whisker Supply' }, { id: 3, name: 'Unused' }],
    loc: [{ id: 'A1', facilityId: 'F1', zone: 'Pick' }, { id: 'A2', facilityId: 'F1', zone: 'Pick' }, { id: 'A1', facilityId: 'F2', zone: 'Bulk' }]
};

describe('Query', () => {
    let SQL: SqlJsStatic;
    before(async () => { SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH }); });

    async function open(spec: QuerySpec, data: Record<string, QueryRowData[]>): Promise<QuerySession> {
        const session = new QuerySession(SQL, spec);
        for (const view of spec.views) await session.load(view.id, data[view.id] ?? []);
        return session;
    }

    describe('long numbers', () => {
        it('a whole number past 32 bits (a barcode) is a whole number: As text meets the same barcode written as text', async () => {
            const spec: QuerySpec = {
                views: [{ id: 'a', name: 'stock', columns: ['gtin'] }, { id: 'b', name: 'sheet', columns: ['gtin', 'qty'] }],
                joins: [{ view: 'b', kind: 'inner', on: [{ left: { parts: [{ view: 'a', column: 'gtin', fns: [{ fn: 'text' }] }] }, right: col('b', 'gtin') }] }],
                select: [{ view: 'a', column: 'gtin' }, { view: 'b', column: 'qty' }]
            };
            const session = await open(spec, { a: [{ gtin: 1234567890123 }, { gtin: 54 }], b: [{ gtin: '1234567890123', qty: '7' }, { gtin: '54', qty: '1' }] });
            assert.deepStrictEqual(session.rows().rows, [[1234567890123, '7'], [54, '1']]);
            assert.deepStrictEqual(session.run('SELECT typeof(gtin), CAST(gtin AS TEXT) FROM stock').rows, [['integer', '1234567890123'], ['integer', '54']]);
            // A number with a fraction stays one
            const frac = await open({ views: [{ id: 'a', name: 'p', columns: ['v'] }], joins: [], select: [{ view: 'a', column: 'v' }] }, { a: [{ v: 1.5 }, { v: 1e21 }] });
            assert.deepStrictEqual(frac.run('SELECT typeof(v) FROM p').rows, [['real'], ['real']]);
        });
    });

    describe('a sample of its rows', () => {
        it('spreads up to the number asked for from the first row to the last, its own columns only', async () => {
            const spec: QuerySpec = { views: [{ id: 'a', name: 'a', columns: ['n'] }], joins: [], select: [{ view: 'a', column: 'n' }] };
            const session = await open(spec, { a: Array.from({ length: 2500 }, (_, i) => ({ n: i })) });
            const sample = session.sample(1000);
            assert.deepStrictEqual(sample.columns, ['n']);
            assert.ok(sample.rows.length <= 1000 && sample.rows.length >= 800, `${sample.rows.length} rows`);
            assert.strictEqual(sample.rows[0][0], 0);
            assert.ok(Number(sample.rows[sample.rows.length - 1][0]) >= 2490);
            assert.strictEqual(session.sample(5000).rows.length, 2500);
        });
    });

    describe('the SQL it writes', () => {
        it('joins live in FROM, pairs in ON ... AND, and there is no WHERE', () => {
            assert.strictEqual(writeSql(STOCK), [
                'SELECT inventory.sku, items.description, inventory.quantityOnHand, suppliers.name, locations.zone',
                'FROM inventory',
                '  LEFT JOIN items     ON items.sku = inventory.sku',
                '  LEFT JOIN suppliers ON suppliers.id = items.supplierId',
                '  JOIN locations      ON locations.id = inventory.locationId',
                '                      AND locations.facilityId = inventory.facilityId'
            ].join('\n'));
        });

        it('no columns picked: every column, but a joining view\'s key and a name an earlier view has', () => {
            const sql = writeSql({ ...STOCK, select: [] });
            // items.sku, suppliers.id, locations.id and locations.facilityId are joined on; items.status is inventory's name too
            assert.strictEqual(sql.split('\nFROM')[0].replace(/\s+/g, ' '),
                'SELECT inventory.sku, inventory.quantityOnHand, inventory.locationId, inventory.facilityId, inventory.status, items.description, items.supplierId, suppliers.name, locations.zone');
            assert.deepStrictEqual(joinKeyColumns(STOCK)[0], { key: { view: 'itm', column: 'sku' }, same: { view: 'inv', column: 'sku' } });
            // A function on a side tidies the key so it meets the other: still one thing, shown once
            const tidied: QuerySpec = { ...STOCK, select: [], joins: [{ view: 'itm', kind: 'left', on: [{ left: col('inv', 'sku'), right: { parts: [{ view: 'itm', column: 'sku', fns: [{ fn: 'trim' }] }] } }] }], views: STOCK.views.slice(0, 2) };
            assert.deepStrictEqual(defaultColumns(tidied).map(c => `${c.view}.${c.column}`), ['inv.sku', 'inv.quantityOnHand', 'inv.locationId', 'inv.facilityId', 'inv.status', 'itm.description', 'itm.supplierId']);
        });

        it('DISTINCT, a WHERE from outside and a LIMIT go where SQL puts them', () => {
            const sql = writeSql({ ...STOCK, distinct: true }, { where: "inventory.status = 'active'", limit: 50 });
            assert.ok(sql.startsWith('SELECT DISTINCT inventory.sku'));
            assert.ok(sql.endsWith("WHERE inventory.status = 'active'\nLIMIT 50"));
        });

        it('names that are not plain are quoted; views sharing a name get a number', () => {
            assert.strictEqual(quoteName('location.city'), '"location.city"');
            assert.strictEqual(quoteName('order'), '"order"');
            assert.strictEqual(quoteName('a"b'), '"a""b"');
            const names = tableNames([
                { id: 'a', name: 'asn lines', columns: [] }, { id: 'b', name: 'asn-lines', columns: [] }, { id: 'c', name: '2024', columns: [] }, { id: 'd', name: '!!', columns: [] }
            ]);
            assert.deepStrictEqual([...names.values()], ['asn_lines', 'asn_lines_2', 't_2024', 'view']);
        });

        it('functions wrap the column, the first innermost; a pair side can join columns', () => {
            const spec: QuerySpec = {
                views: [{ id: 'a', name: 'a', columns: ['code', 'p1', 'p2'] }, { id: 'b', name: 'b', columns: ['code'] }],
                joins: [{ view: 'b', kind: 'left', on: [
                    { left: { parts: [{ view: 'a', column: 'code', fns: [{ fn: 'trim' }, { fn: 'upper' }] }] }, right: { parts: [{ view: 'b', column: 'code', fns: [{ fn: 'ltrimZeros' }] }] } },
                    { left: { parts: [{ view: 'a', column: 'p1' }, { view: 'a', column: 'p2' }], separator: '-' }, right: { parts: [{ view: 'b', column: 'code', fns: [{ fn: 'first', n: 4 }, { fn: 'replace', from: '_', to: '-' }] }], fns: [{ fn: 'last', n: 3 }] } }
                ] }],
                select: []
            };
            const sql = writeSql(spec);
            assert.ok(sql.includes("ON LTRIM(b.code, '0') = UPPER(TRIM(a.code))"), sql);
            assert.ok(sql.includes("AND SUBSTR(REPLACE(SUBSTR(b.code, 1, 4), '_', '-'), -3) = a.p1 || '-' || a.p2"), sql);
        });
    });

    describe('running it', () => {
        it('the stock report: LEFT JOIN keeps the unmatched, JOIN drops them', async () => {
            const session = await open(STOCK, DATA);
            const { columns, rows } = session.rows();
            assert.deepStrictEqual(columns, ['sku', 'description', 'quantityOnHand', 'name', 'zone']);
            assert.deepStrictEqual(rows, [
                ['WOOF-001', 'Chew rope, large', 120, 'Bark & Co', 'Pick'],
                ['WOOF-002', 'Squeaky bone', 36, 'Bark & Co', 'Pick'],
                ['MEOW-014', null, 0, null, 'Bulk']
            ]);
            assert.strictEqual(session.count(), 3);
            assert.deepStrictEqual(session.rows({ limit: 1, offset: 1 }).rows.map(r => r[0]), ['WOOF-002']);
            session.close();
        });

        it('join stats: counts, the relationship and the rows each join leaves', async () => {
            const session = await open(STOCK, DATA);
            const items = session.joinStats(0);
            assert.deepStrictEqual({ ...items, values: undefined }, {
                leftRows: 4, leftMatched: 3, rightRows: 3, rightMatched: 3, rowsAfter: 4, relationship: 'oneToOne', typeMismatch: false,
                keys: { oneToOne: 3, oneToMany: 0, manyToOne: 0, manyToMany: 0 },
                rows: { oneToOne: 3, oneToMany: 0, manyToOne: 0, manyToMany: 0 },
                records: { oneToOne: 3, oneToMany: 0, manyToOne: 0, manyToMany: 0 },
                leftBlank: 0, leftValues: 4, rightValues: 3, valuesTotal: 4, values: undefined
            });
            const suppliers = session.joinStats(1);
            assert.strictEqual(suppliers.relationship, 'manyToOne');
            assert.deepStrictEqual([suppliers.leftRows, suppliers.leftMatched, suppliers.rightRows, suppliers.rightMatched, suppliers.rowsAfter], [4, 3, 3, 2, 4]);
            // The values joined on: the one with no match first, then the matched
            assert.deepStrictEqual(items.values.map(v => [v.left, v.right]), [[1, 0], [1, 1], [1, 1], [1, 1]]);
            // Many to one: two rows share a supplier; the supplier nothing uses is listed as not used
            assert.deepStrictEqual([suppliers.rows.manyToOne, suppliers.records.manyToOne], [2, 1]);
            assert.deepStrictEqual(suppliers.values.filter(v => v.left === 0).map(v => v.right), [1]);
            const locations = session.joinStats(2);
            assert.deepStrictEqual([locations.leftRows, locations.leftMatched, locations.rowsAfter, locations.relationship], [4, 3, 3, 'oneToOne']);
            session.close();
        });

        it('one to many and many to many say how many rows they make, and which values repeat', async () => {
            const spec: QuerySpec = {
                views: [{ id: 'a', name: 'items', columns: ['sku', 'category'] }, { id: 'b', name: 'suppliers', columns: ['name', 'category'] }],
                joins: [{ view: 'b', kind: 'left', on: [{ left: col('a', 'category'), right: col('b', 'category') }] }],
                select: []
            };
            const items = [{ sku: 'A', category: 'Toys' }, { sku: 'B', category: 'Toys' }, { sku: 'C', category: 'Litter' }, { sku: 'D', category: null }];
            const many = await open(spec, { a: items, b: [{ name: 'S1', category: 'Toys' }, { name: 'S2', category: 'Toys' }, { name: 'S3', category: 'Toys' }, { name: 'S4', category: 'Litter' }, { name: 'S5', category: null }] });
            const stats = many.joinStats(0);
            assert.strictEqual(stats.relationship, 'manyToMany');
            assert.strictEqual(stats.rowsAfter, 2 * 3 + 1 + 1, 'Toys 2 x 3, Litter once, and the item with no category kept');
            assert.deepStrictEqual(stats.values, [{ key: ['Toys'], left: 2, right: 3 }, { key: ['Litter'], left: 1, right: 1 }]);
            assert.deepStrictEqual([stats.rows.manyToMany, stats.records.manyToMany, stats.leftBlank], [2, 3, 1]);
            assert.strictEqual(many.count(), stats.rowsAfter);
            assert.strictEqual(stats.leftMatched, 3, 'a NULL key matches nothing');
            many.close();

            const one = await open(spec, { a: [items[2]], b: [{ name: 'S4', category: 'Litter' }, { name: 'S6', category: 'Litter' }] });
            assert.strictEqual(one.joinStats(0).relationship, 'oneToMany');
            one.close();
        });

        it('values keep their type: leading zeros stay, and text never equals a number', async () => {
            const spec: QuerySpec = {
                views: [{ id: 'a', name: 'a', columns: ['code', 'flag', 'extra'] }, { id: 'b', name: 'b', columns: ['code'] }],
                joins: [{ view: 'b', kind: 'left', on: [{ left: col('a', 'code'), right: col('b', 'code') }] }],
                select: [{ view: 'a', column: 'code' }, { view: 'a', column: 'flag' }, { view: 'a', column: 'extra' }, { view: 'b', column: 'code' }]
            };
            const session = await open(spec, { a: [{ code: '00123', flag: true, extra: { a: [1] } }, { code: 123, flag: false }], b: [{ code: '00123' }, { code: '123' }] });
            assert.deepStrictEqual(session.rows().rows, [['00123', 'true', '{"a":[1]}', '00123'], [123, 'false', null, null]]);
            session.close();
        });

        it('a number never meets text as it is: the join says so, and "as text" fixes it', async () => {
            const spec = (asText: boolean): QuerySpec => ({
                views: [{ id: 'a', name: 'a', columns: ['id'] }, { id: 'b', name: 'b', columns: ['id'] }],
                joins: [{ view: 'b', kind: 'left', on: [{ left: { parts: [{ view: 'a', column: 'id', fns: asText ? [{ fn: 'text' }] : [] }] }, right: col('b', 'id') }] }],
                select: []
            });
            const data = { a: [{ id: 123 }, { id: 124 }], b: [{ id: '123' }, { id: '124' }] };
            const strict = await open(spec(false), data);
            assert.deepStrictEqual([strict.joinStats(0).leftMatched, strict.joinStats(0).typeMismatch], [0, true]);
            strict.close();
            const cast = await open(spec(true), data);
            assert.deepStrictEqual([cast.joinStats(0).leftMatched, cast.joinStats(0).typeMismatch], [2, false]);
            assert.ok(cast.sql().includes('ON b.id = CAST(a.id AS TEXT)'));
            cast.close();
        });

        it('functions make keys from two systems meet', async () => {
            const spec = (fns: boolean): QuerySpec => ({
                views: [{ id: 'a', name: 'inventory', columns: ['sku'] }, { id: 'b', name: 'count', columns: ['Item Code', 'counted'] }],
                joins: [{ view: 'b', kind: 'left', on: [{ left: col('a', 'sku'), right: { parts: [{ view: 'b', column: 'Item Code', fns: fns ? [{ fn: 'trim' }, { fn: 'upper' }] : [] }] } }] }],
                select: []
            });
            const data = { a: [{ sku: 'WOOF-001' }, { sku: 'WOOF-002' }], b: [{ 'Item Code': ' woof-001 ', counted: 118 }, { 'Item Code': 'WOOF-002', counted: 36 }] };
            const before = await open(spec(false), data);
            assert.strictEqual(before.joinStats(0).leftMatched, 1);
            before.close();
            const after = await open(spec(true), data);
            assert.strictEqual(after.joinStats(0).leftMatched, 2);
            assert.ok(after.sql().includes('ON UPPER(TRIM(count."Item Code")) = inventory.sku'), after.sql());
            after.close();
        });

        it('hostile names and text stay names and text', async () => {
            const evil = 'x"; DROP TABLE a; --';
            const spec: QuerySpec = {
                views: [{ id: 'a', name: 'a', columns: [evil, 'select'] }, { id: 'b', name: 'b; DROP TABLE a', columns: ['k'] }],
                joins: [{ view: 'b', kind: 'left', on: [{ left: { parts: [{ view: 'a', column: evil, fns: [{ fn: 'replace', from: "'); DROP TABLE a; --", to: "'" }, { fn: 'first', n: Number('1; DROP TABLE a') }] }] }, right: col('b', 'k') }] }],
                select: [{ view: 'a', column: evil }, { view: 'a', column: 'select' }, { view: 'b', column: 'k' }]
            };
            const session = await open(spec, { a: [{ [evil]: 'v', select: 1 }], b: [{ k: 'v' }] });
            assert.deepStrictEqual(session.rows().rows, [['v', 1, 'v']]);
            assert.strictEqual(session.joinStats(0).leftMatched, 1);
            assert.strictEqual(session.run('SELECT COUNT(*) FROM a').rows[0][0], 1, 'the table is still there');
            session.close();
        });

        it('DISTINCT folds line rows into their headers', async () => {
            const spec: QuerySpec = {
                views: [{ id: 'l', name: 'asn lines', columns: ['asnNumber', 'supplier', 'sku'] }],
                joins: [], select: [{ view: 'l', column: 'asnNumber' }, { view: 'l', column: 'supplier' }], distinct: true
            };
            const session = await open(spec, { l: [{ asnNumber: 'A1', supplier: 'S', sku: 'x' }, { asnNumber: 'A1', supplier: 'S', sku: 'y' }, { asnNumber: 'A2', supplier: 'S', sku: 'x' }] });
            assert.strictEqual(session.count(), 2);
            assert.ok(session.sql().startsWith('SELECT DISTINCT asn_lines.asnNumber'));
            session.close();
        });

        it('any SQL SQLite runs works on the tables, JSON functions included', async () => {
            const session = await open(STOCK, DATA);
            const grouped = session.run('SELECT suppliers.name, SUM(inventory.quantityOnHand) FROM inventory JOIN items ON items.sku = inventory.sku JOIN suppliers ON suppliers.id = items.supplierId GROUP BY suppliers.name ORDER BY 1');
            assert.deepStrictEqual(grouped.rows, [['Bark & Co', 156], ['Whisker Supply', 8]]);
            assert.strictEqual(session.run(`SELECT json_extract('{"a":[1,2]}', '$.a[1]')`).rows[0][0], 2);
            assert.throws(() => session.run('SELECT nope FROM inventory'), /no such column/);
            session.close();
        });

        it('100,000 rows: loads, joins and counts in seconds', async function () {
            this.timeout(60000);
            const n = 100000;
            const spec: QuerySpec = {
                views: [
                    { id: 'a', name: 'inventory', columns: ['sku', 'qty', 'loc', 'status', 'c5', 'c6', 'c7', 'c8'] },
                    { id: 'b', name: 'items', columns: ['sku', 'description', 'supplierId', 'c4', 'c5', 'c6'] }
                ],
                joins: [{ view: 'b', kind: 'left', on: [{ left: col('a', 'sku'), right: col('b', 'sku') }] }],
                select: []
            };
            const a = Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i}`, qty: i % 500, loc: `L${i % 900}`, status: 'active', c5: 'x', c6: i, c7: 'text value', c8: null }));
            const b = Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i + 5000}`, description: `Item ${i}`, supplierId: i % 17, c4: 'y', c5: i, c6: 'z' }));
            const t0 = Date.now();
            const session = await open(spec, { a, b });
            const t1 = Date.now();
            const stats = session.joinStats(0);
            const t2 = Date.now();
            const page = session.rows({ limit: 200 });
            const total = session.count();
            const t3 = Date.now();
            console.log(`        load ${t1 - t0} ms, join stats ${t2 - t1} ms, first page + count ${t3 - t2} ms`);
            assert.strictEqual(stats.leftMatched, n - 5000);
            assert.strictEqual(stats.relationship, 'oneToOne');
            assert.strictEqual(total, n);
            assert.strictEqual(page.rows.length, 200);
            assert.ok(t3 - t0 < 30000);
            session.close();
        });
    });
    it('a calculated column is its expression AS its name, last unless placed', async () => {
        const spec: QuerySpec = { ...STOCK, select: [], calc: [{ name: 'double qty', expr: 'inventory.quantityOnHand * 2' }] };
        assert.ok(writeSql(spec).split('\nFROM')[0].endsWith('(inventory.quantityOnHand * 2) AS "double qty"'));
        const placed: QuerySpec = { ...spec, select: [{ view: '', column: 'double qty' }, { view: 'inv', column: 'sku' }] };
        assert.strictEqual(writeSql(placed).split('\n')[0], 'SELECT (inventory.quantityOnHand * 2) AS "double qty", inventory.sku');
        const session = await open(placed, DATA);
        assert.deepStrictEqual(session.rows().rows[0], [240, 'WOOF-001']);
        session.close();
    });
    describe('a view has one short name, which the SQL uses', () => {
        it('the SQL writes the name as it is typed: FROM, JOIN and before each column', () => {
            const spec: QuerySpec = {
                views: [{ id: 's', name: 'LowStock', columns: ['gtin'] }, { id: 'p', name: 'Products', columns: ['gtin', 'name'] }],
                joins: [{ view: 'p', kind: 'left', on: [{ left: col('s', 'gtin'), right: col('p', 'gtin') }] }],
                select: []
            };
            assert.strictEqual(writeSql(spec), 'SELECT LowStock.gtin, Products.name\nFROM LowStock\n  LEFT JOIN Products ON Products.gtin = LowStock.gtin');
        });

        it('a name is cleaned to what SQL takes without quotes, and cut at 32 (the slot shortens a long one)', () => {
            assert.strictEqual(cleanViewName('Low stock-items!'), 'Lowstockitems');
            assert.strictEqual(cleanViewName('a'.repeat(40)).length, 32);
            assert.strictEqual(cleanViewName('2024 orders'), 'orders');
            assert.strictEqual(cleanViewName('a_b'), 'a_b');
        });

        it('a new view is named from what it reads; a name taken, or a word of SQL, gets a number', () => {
            assert.strictEqual(guessViewName('Get Products', []), 'Products');
            assert.strictEqual(guessViewName('List Locations', ['Products']), 'Locations');
            assert.strictEqual(guessViewName('Get Products', ['products']), 'Products2');
            assert.strictEqual(guessViewName('Order', []), 'Order2');
            assert.strictEqual(guessViewName('Get', []), 'Get');
            assert.strictEqual(guessViewName('!!!', []), 'Data');
            assert.strictEqual(guessViewName('Purchase order lines', []), 'Purchaseorderlines');
        });

        it('why a name is refused', () => {
            assert.strictEqual(viewNameProblem('Stock', ['Products']), '');
            assert.match(viewNameProblem('stock', ['Stock']), /already called/);
            assert.match(viewNameProblem('select', []), /SQL keeps/);
            assert.match(viewNameProblem('low stock', []), /letters, digits/);
            assert.match(viewNameProblem('', []), /needs a name/);
        });

        it('renamed, its calculated columns and search follow', () => {
            const query = {
                id: 'q-1', name: 'q', joins: [], createdAt: '', updatedAt: '',
                sources: [{ id: 'v1', name: 'Stock' }, { id: 'v2', name: 'Products' }] as QuerySource[],
                calc: [{ name: 'short', expr: 'Stock.onHand - Products.reorderPoint' }],
                search: '@stock.sku=A1'
            } as SavedQuery;
            assert.strictEqual(renameView(query, 'v1', 'Low'), '');
            assert.strictEqual(query.sources[0].name, 'Low');
            assert.strictEqual(query.calc?.[0].expr, 'Low.onHand - Products.reorderPoint');
            assert.strictEqual(query.search, '@Low.sku=A1');
            // A name another view has is refused, and nothing changes
            assert.match(renameView(query, 'v1', 'products'), /already called/);
            assert.strictEqual(query.sources[0].name, 'Low');
        });

    });
    it('a column with no value in any row is left out of the default columns until it is picked', () => {
        const spec: QuerySpec = { views: [{ id: 'a', name: 'a', columns: ['sku', 'note', 'qty'], empty: ['note'] }], joins: [], select: [] };
        assert.deepStrictEqual(defaultColumns(spec).map(c => c.column), ['sku', 'qty']);
    });
    describe('Move to first', () => {
        const pair = (a: string, ac: string, b: string, bc: string) => ({ left: col(a, ac), right: col(b, bc) });
        const saved = (): SavedQuery => ({
            id: 'q-1', name: 'q', createdAt: '', updatedAt: '',
            sources: [{ id: 'stock', name: 'Stock' }, { id: 'prod', name: 'Products' }, { id: 'loc', name: 'Locations' }, { id: 'asn', name: 'ASNs' }] as QuerySource[],
            joins: [
                { view: 'prod', kind: 'inner', on: [pair('stock', 'gtin', 'prod', 'gtin')] },
                { view: 'loc', kind: 'left', on: [pair('stock', 'gln', 'loc', 'gln'), pair('prod', 'facility', 'loc', 'facility')] },
                { view: 'asn', kind: 'left', on: [pair('prod', 'gtin', 'asn', 'gtin')] }
            ]
        });

        it('the view goes first and the others keep their order', () => {
            const query = saved();
            moveViewFirst(query, 'asn');
            assert.deepStrictEqual(query.sources.map(s => s.id), ['asn', 'stock', 'prod', 'loc']);
            assert.deepStrictEqual(query.joins.map(j => j.view), ['stock', 'prod', 'loc']);
        });

        it('each pair stays, with the view now further right; a view whose pairs moved on has none', () => {
            const query = saved();
            moveViewFirst(query, 'asn');
            const [stock, prod, loc] = query.joins;
            // Stock met ASNs only through Products, which is now on its right
            assert.deepStrictEqual(stock, { view: 'stock', kind: 'left', on: [] });
            // Products keeps its pair with Stock and gains the one with ASNs, turned round; its JOIN stays
            assert.deepStrictEqual(prod, { view: 'prod', kind: 'inner', on: [pair('stock', 'gtin', 'prod', 'gtin'), pair('asn', 'gtin', 'prod', 'gtin')] });
            assert.deepStrictEqual(loc.on, [pair('stock', 'gln', 'loc', 'gln'), pair('prod', 'facility', 'loc', 'facility')]);
        });

        it('a view moved to any place: the others keep their order, and each pair goes to the view now further right', () => {
            const query = saved();
            moveView(query, 'stock', 2);
            assert.deepStrictEqual(query.sources.map(s => s.id), ['prod', 'loc', 'stock', 'asn']);
            const [loc, stock, asn] = query.joins;
            assert.deepStrictEqual(loc, { view: 'loc', kind: 'left', on: [pair('prod', 'facility', 'loc', 'facility')] });
            // Stock's pairs with Products and Locations are now its own, turned round
            assert.deepStrictEqual(stock.on, [pair('prod', 'gtin', 'stock', 'gtin'), pair('loc', 'gln', 'stock', 'gln')]);
            assert.deepStrictEqual(asn.on, [pair('prod', 'gtin', 'asn', 'gtin')]);
            // Where it already is, or past the end (held to the last place)
            moveView(query, 'stock', 2);
            moveView(query, 'asn', 99);
            assert.deepStrictEqual(query.sources.map(s => s.id), ['prod', 'loc', 'stock', 'asn']);
        });

        it('a view moved between others (not first) keeps its join, as everyone else does: only the order changes (James, 2026-11-22)', () => {
            const query = saved();
            moveView(query, 'asn', 1);
            assert.deepStrictEqual(query.sources.map(s => s.id), ['stock', 'asn', 'prod', 'loc']);
            assert.deepStrictEqual(query.joins, saved().joins);
        });

        it('the first view, or one that is not there, changes nothing', () => {
            const query = saved();
            moveViewFirst(query, 'stock');
            moveViewFirst(query, 'gone');
            assert.deepStrictEqual(query, saved());
        });
    });
    describe('a file as a view', () => {
        it('a CSV: the first row names the columns, values stay text, a blank is NULL', () => {
            const read = readFileRows('bins.csv', { text: '\uFEFFsku,bin,,bin\r\nWOOF-001,00A1,x,1\r\n\r\nWOOF-002,,,\r\n' });
            assert.deepStrictEqual(read.columns, ['sku', 'bin', 'Column 3', 'bin_2']);
            assert.deepStrictEqual(read.rows, [
                { sku: 'WOOF-001', bin: '00A1', 'Column 3': 'x', bin_2: '1' },
                { sku: 'WOOF-002', bin: null, 'Column 3': null, bin_2: null }
            ]);
        });

        it('a workbook: the first sheet, each cell with the type it has', () => {
            const book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['sku', 'qty'], ['WOOF-001', 12], ['00123', 0.5]]), 'Stock');
            const read = readFileRows('stock.xlsx', { base64: XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) });
            assert.deepStrictEqual(read, { columns: ['sku', 'qty'], rows: [{ sku: 'WOOF-001', qty: 12 }, { sku: '00123', qty: 0.5 }] });
        });

        it('a file with nothing in it is refused', () => {
            assert.throws(() => readFileRows('empty.csv', { text: '' }), /no columns/);
        });
    });
});
