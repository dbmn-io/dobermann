// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query: a file view's rows kept on this computer (src/services/query/query-file-store).
 *   npm run test:core
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QueryFileStore } from '../../../services/query/query-file-store';
import * as XLSX from 'xlsx';
import { readFileRows, readFileSheets } from '../../../services/query/query-file';

describe('Query: a file view\'s rows are kept', () => {
    let dir: string;
    let store: QueryFileStore;
    const bins = readFileRows('Bins.csv', { text: 'sku,bin,qty\n00123,A-01,\n00456,B-07,4\n' });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-query-files-'));
        store = new QueryFileStore({ dataDir: async () => dir });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('read back as they were read from the file: text stays text, a blank stays NULL', async () => {
        await store.save('qry-1', 'v-1', bins);
        assert.deepStrictEqual(await store.read('qry-1', 'v-1'), bins);
        assert.strictEqual(bins.rows[0].sku, '00123');
        assert.strictEqual(bins.rows[0].qty, null);
    });

    it('nothing kept reads as undefined, so the query asks for the file', async () => {
        assert.strictEqual(await store.read('qry-1', 'v-none'), undefined);
    });

    it('picked again, the newer rows take the place of the old', async () => {
        await store.save('qry-1', 'v-1', bins);
        const newer = readFileRows('Bins.csv', { text: 'sku,bin\n00789,C-02\n' });
        await store.save('qry-1', 'v-1', newer);
        assert.deepStrictEqual(await store.read('qry-1', 'v-1'), newer);
    });

    it('a removed view drops its rows; a deleted query drops them all', async () => {
        await store.save('qry-1', 'v-1', bins);
        await store.save('qry-1', 'v-2', bins);
        await store.remove('qry-1', 'v-1');
        assert.strictEqual(await store.read('qry-1', 'v-1'), undefined);
        assert.ok(await store.read('qry-1', 'v-2'));
        await store.remove('qry-1');
        assert.strictEqual(await store.read('qry-1', 'v-2'), undefined);
        await store.remove('qry-never');   // nothing kept: no error
    });

    it('a copy of a query has its own rows', async () => {
        await store.save('qry-1', 'v-1', bins);
        await store.copy('qry-1', 'qry-2');
        await store.remove('qry-1');
        assert.deepStrictEqual(await store.read('qry-2', 'v-1'), bins);
    });

    it('an id never reaches outside the data folder', async () => {
        await store.save('../../escape', '../v', bins);
        assert.deepStrictEqual(fs.readdirSync(dir), ['query-files']);
        assert.ok(await store.read('../../escape', '../v'));
    });
});

describe('Query: a workbook is a view per sheet', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['sku', 'name'], ['WOOF-001', 'Lead'], ['WOOF-002', 'Bowl']]), 'Products');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Blank');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['sku', 'qty'], ['WOOF-001', 4], [null, null], ['00123', 2.5]]), 'Stock');
    const base64 = XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) as string;

    it('each sheet with a first row of names is a table, by its sheet\'s name; a blank sheet is passed over', () => {
        const sheets = readFileSheets('Warehouse.xlsx', { base64 });
        assert.deepStrictEqual(sheets.map(s => s.sheet), ['Products', 'Stock']);
        assert.deepStrictEqual(sheets[0].columns, ['sku', 'name']);
        assert.strictEqual(sheets[0].rows.length, 2);
    });

    it('cells keep their type, and a blank line is not a row', () => {
        const stock = readFileSheets('Warehouse.xlsx', { base64 })[1];
        assert.deepStrictEqual(stock.rows, [{ sku: 'WOOF-001', qty: 4 }, { sku: '00123', qty: 2.5 }]);
    });

    it('the first sheet is what a single read gives, and a CSV is one table with no sheet name', () => {
        assert.deepStrictEqual(readFileRows('Warehouse.xlsx', { base64 }).columns, ['sku', 'name']);
        const csv = readFileSheets('Bins.csv', { text: 'sku,bin\n00123,A-01\n' });
        assert.deepStrictEqual(csv.map(s => s.sheet), ['']);
    });

    it('a workbook with nothing in it says so', () => {
        const empty = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(empty, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
        assert.throws(() => readFileSheets('Empty.xlsx', { base64: XLSX.write(empty, { type: 'base64', bookType: 'xlsx' }) as string }), /no columns/);
    });
});
