// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Saved queries in the workspace folder (src/services/query/query-folder): one folder per query,
 * named after it, its CSV and Excel views' rows beside it, shared by every app on that folder.
 *   npm run test:core
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import { QUERY_FILE, QUERIES_FOLDER, safeFileName, useQueryFolder } from '../../../services/query/query-folder';
import { createQuery, duplicateQuery, getQuery, listQueries, QUERIES_KEY, removeQuery, saveQuery, type SavedQuery } from '../../../services/query/query-store';
import { QueryFileStore } from '../../../services/query/query-file-store';
import { readFileRows } from '../../../services/query/query-file';
import { reportNameProblem } from '../../../services/compare/report-name';

describe('Query: saved queries in the workspace folder', () => {
    let root: string;
    const queries = () => path.join(root, QUERIES_FOLDER);
    const folders = () => (fs.existsSync(queries()) ? fs.readdirSync(queries()).sort() : []);
    /** Another app on the same folder: it reads the folder as it is now. */
    const elsewhere = () => useQueryFolder({ root: () => root });
    const bins = readFileRows('Bins.csv', { text: 'sku,bin\n00123,A-01\n' });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-query-folder-'));
        useQueryFolder({ root: () => root });
    });
    afterEach(() => {
        useQueryFolder(undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('each query is a folder named after it, its query.json inside; the state store is left alone', async () => {
        const state = new MemoryKeyValueStore();
        const query = await createQuery(state);
        query.name = 'Inventory check';
        await saveQuery(state, query);
        assert.deepStrictEqual(folders(), ['Inventory check']);
        const kept = JSON.parse(fs.readFileSync(path.join(queries(), 'Inventory check', QUERY_FILE), 'utf8')) as SavedQuery;
        assert.strictEqual(kept.id, query.id);
        assert.strictEqual(state.get(QUERIES_KEY), undefined, 'nothing in this app\'s own store');
    });

    it('another app on the folder lists and opens the same queries', async () => {
        const mine = new MemoryKeyValueStore();
        const theirs = new MemoryKeyValueStore();
        const query = await createQuery(mine);
        elsewhere();
        assert.deepStrictEqual(listQueries(theirs).map(q => q.id), [query.id]);
        assert.strictEqual(getQuery(theirs, query.id)?.name, query.name);
    });

    it('renaming moves the folder, its CSV and Excel rows with it', async () => {
        const state = new MemoryKeyValueStore();
        const files = new QueryFileStore({ dataDir: async () => path.join(root, '.dbmn') });
        const query = await createQuery(state);
        await files.save(query.id, 'v-1', bins);
        query.name = 'Bins';
        query.updatedAt = new Date(Date.now() + 1000).toISOString();
        await saveQuery(state, query);
        assert.deepStrictEqual(folders(), ['Bins']);
        assert.deepStrictEqual(fs.readdirSync(path.join(queries(), 'Bins')).sort(), [QUERY_FILE, 'v-1.json']);
        assert.deepStrictEqual(await files.read(query.id, 'v-1'), bins);
    });

    it('a change of letter case only keeps the folder (Windows and macOS see one folder)', async () => {
        const state = new MemoryKeyValueStore();
        const files = new QueryFileStore({ dataDir: async () => path.join(root, '.dbmn') });
        const query = await createQuery(state);
        query.name = 'bins';
        await saveQuery(state, query);
        await files.save(query.id, 'v-1', bins);
        query.name = 'Bins';
        await saveQuery(state, query);
        assert.deepStrictEqual(folders(), ['bins']);
        assert.strictEqual(getQuery(state, query.id)?.name, 'Bins');
        assert.deepStrictEqual(await files.read(query.id, 'v-1'), bins);
    });

    it('deleting a query deletes its folder, rows and all', async () => {
        const state = new MemoryKeyValueStore();
        const files = new QueryFileStore({ dataDir: async () => path.join(root, '.dbmn') });
        const query = await createQuery(state);
        await files.save(query.id, 'v-1', bins);
        await removeQuery(state, query.id);
        await files.remove(query.id);
        assert.deepStrictEqual(folders(), []);
        assert.deepStrictEqual(listQueries(state), []);
    });

    it('a query folder copied in under another name opens: it is found by the id inside', async () => {
        const state = new MemoryKeyValueStore();
        const query = await createQuery(state);
        fs.renameSync(path.join(queries(), query.name), path.join(queries(), 'from support'));
        elsewhere();
        assert.strictEqual(getQuery(state, query.id)?.name, query.name);
    });

    it('the same query in two folders: the newer edit is the one listed', async () => {
        const state = new MemoryKeyValueStore();
        const query = await createQuery(state);
        const newer = { ...query, name: 'Newer', updatedAt: new Date(Date.now() + 60000).toISOString() };
        fs.mkdirSync(path.join(queries(), 'copy'), { recursive: true });
        fs.writeFileSync(path.join(queries(), 'copy', QUERY_FILE), JSON.stringify(newer));
        elsewhere();
        assert.deepStrictEqual(listQueries(state).map(q => q.name), ['Newer']);
    });

    it('names a folder can\'t have are made safe; two queries never share a folder', async () => {
        assert.strictEqual(safeFileName('Sales: Q1/Q2?', 'x'), 'Sales- Q1-Q2-');
        assert.strictEqual(safeFileName('con', 'qry-1'), 'qry-1');
        assert.strictEqual(safeFileName('  ...  ', 'qry-1'), 'qry-1');
        const state = new MemoryKeyValueStore();
        const a = await createQuery(state);
        const b = await createQuery(state);
        a.name = 'A/B';
        b.name = 'A-B';
        await saveQuery(state, a);
        await saveQuery(state, b);
        assert.deepStrictEqual(folders(), ['A-B', 'A-B (2)']);
        assert.deepStrictEqual(listQueries(state).map(q => q.name).sort(), ['A-B', 'A/B']);
    });

    it('a duplicate gets its own folder and its own copy of the rows (not the original\'s query.json)', async () => {
        const state = new MemoryKeyValueStore();
        const files = new QueryFileStore({ dataDir: async () => path.join(root, '.dbmn') });
        const query = await createQuery(state);
        await files.save(query.id, 'v-1', bins);
        const copy = await duplicateQuery(state, query.id);
        await files.copy(query.id, copy!.id);
        assert.strictEqual(getQuery(state, copy!.id)?.name, copy!.name);
        assert.strictEqual(getQuery(state, query.id)?.name, query.name);
        assert.deepStrictEqual(await files.read(copy!.id, 'v-1'), bins);
    });

    it('report names are checked against the folder\'s queries', async () => {
        const state = new MemoryKeyValueStore();
        const query = await createQuery(state);
        query.name = 'Stock';
        await saveQuery(state, query);
        assert.match(reportNameProblem(new MemoryKeyValueStore(), 'qry-other', 'stock'), /already called/);
    });

    it('with no workspace folder, queries stay in the app\'s state store as before', async () => {
        const state = new MemoryKeyValueStore();
        useQueryFolder(undefined);
        await createQuery(state);
        assert.strictEqual((state.get(QUERIES_KEY) as SavedQuery[]).length, 1);
        assert.deepStrictEqual(folders(), []);
    });
});
