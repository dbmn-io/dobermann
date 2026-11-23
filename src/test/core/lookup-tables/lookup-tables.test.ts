// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Lookup tables (src/services/lookup-tables/lookup-tables.ts): kept with the saved queries, any
 * number of columns up to the limit, a key one value per row, a column's id kept when it is
 * renamed, and every store on the same state told of a change.
 *   npm run test:core
 */
import * as assert from 'assert';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import {
    LookupTablesStore, LOOKUP_MAX_COLUMNS, LOOKUP_TABLES_KEY, lookupTableProblem
} from '../../../services/lookup-tables/lookup-tables';

const NOW = '2026-11-20T10:00:00.000Z';
const fresh = () => {
    const state = new MemoryKeyValueStore();
    return { state, store: new LookupTablesStore(state, { now: () => NOW }) };
};

describe('Lookup tables', () => {
    it('a new table: its name and its columns, one to five, all equal; no rows; a name taken is refused, in words', async () => {
        const { state, store } = fresh();
        const units = await store.create('Units', ['ERP', 'WMS', 'Finance']);
        assert.deepStrictEqual(units.columns, [{ id: 'c1', name: 'ERP' }, { id: 'c2', name: 'WMS' }, { id: 'c3', name: 'Finance' }]);
        assert.deepStrictEqual(units.rows, []);
        assert.ok(units.id.startsWith('lkp-'));
        assert.strictEqual((state.get<unknown[]>(LOOKUP_TABLES_KEY) || []).length, 1);
        await assert.rejects(store.create('units', ['a', 'b']), /There's a lookup table called units already/);
        await assert.rejects(store.create('Wide', ['a', 'b', 'c', 'd', 'e', 'f']), /up to 5 columns/);
        await assert.rejects(store.create('Twins', ['WMS', 'wms']), /Two columns are called wms/);
        await assert.rejects(store.create('Long', ['a'.repeat(21)]), /up to 20 characters/);
        assert.deepStrictEqual((await store.list()).map(t => [t.name, t.rows]), [['Units', 0]]);
        // (no names given, as an older page asks: code and value)
        assert.deepStrictEqual((await store.create('Plain')).columns.map(c => c.name), ['code', 'value']);
    });

    it('several columns: saved and read back by id, values as text; the same value in two rows is fine (no key)', async () => {
        const { store } = fresh();
        const table = await store.create('Units', ['ERP unit', 'WMS unit', 'Finance unit']);
        const columns = [{ id: 'c1', name: 'ERP unit' }, { id: 'c2', name: 'WMS unit' }, { id: 'c3', name: 'Finance unit' }];
        await store.save({ ...table, columns, rows: [{ c1: 'EA', c2: 'EACH', c3: 'UNIT' }, { c1: 'CS', c2: 'CASE', c3: 12 as unknown as string }, { c1: 'EA', c2: 'EACH2', c3: '' }] });
        const read = await store.get(table.id);
        assert.deepStrictEqual(read?.rows[1], { c1: 'CS', c2: 'CASE', c3: '12' });
        assert.strictEqual(read?.rows.length, 3);
        const [summary] = await store.list();
        assert.deepStrictEqual([summary.rows, summary.columns.length, summary.updatedAt], [3, 3, NOW]);
    });

    it('up to five columns, each named once (any case), up to 20 characters; a file\'s old key mark is read without it', async () => {
        const many = Array.from({ length: LOOKUP_MAX_COLUMNS + 1 }, (_, i) => ({ id: `c${i}`, name: `col ${i}` }));
        assert.match(lookupTableProblem({ name: 'Wide', columns: many, rows: [] }), /up to 5 columns/);
        assert.strictEqual(lookupTableProblem({ name: 'Wide', columns: many.slice(0, LOOKUP_MAX_COLUMNS), rows: [] }), '');
        assert.match(lookupTableProblem({ name: 'T', columns: [{ id: 'a', name: 'x' }, { id: 'b', name: 'X' }], rows: [] }), /Two columns are called X/);
        const { store } = fresh();
        const table = await store.create('T', ['code', 'value']);
        await assert.rejects(store.save({ ...table, columns: [...table.columns, ...many.slice(0, 4)] }), /up to 5 columns/);
        assert.deepStrictEqual((await store.get(table.id))?.columns.length, 2, 'a table that can\'t be kept is not changed');
        await store.save({ ...table, columns: [{ id: 'c1', name: 'code', key: true } as never, { id: 'c2', name: 'value' }] });
        assert.deepStrictEqual((await store.get(table.id))?.columns, [{ id: 'c1', name: 'code' }, { id: 'c2', name: 'value' }]);
    });

    it('a column renamed keeps its id (a saved query\'s from and to keep working)', async () => {
        const { store } = fresh();
        const table = await store.create('Units');
        await store.save({ ...table, columns: [{ id: 'c1', name: 'ERP unit' }, { id: 'c2', name: 'WMS unit' }] });
        assert.deepStrictEqual((await store.get(table.id))?.columns.map(c => c.id), ['c1', 'c2']);
    });

    it('a row added (Translate\'s "+ Add"): the others blank, heard by every screen; refused when the value is there, the table full or gone', async () => {
        const { state, store } = fresh();
        const heard: string[] = [];
        new LookupTablesStore(state).onChange(c => heard.push(c.kind));
        const table = await store.create('UOM', ['TMS', 'WMS', 'ERP']);
        await store.addRow(table.id, { c1: 'DZ', c2: 'DOZEN' }, { column: 'c1', value: 'DZ' });
        assert.deepStrictEqual((await store.get(table.id))?.rows, [{ c1: 'DZ', c2: 'DOZEN', c3: '' }]);
        assert.deepStrictEqual(heard, ['saved', 'saved']);
        await assert.rejects(store.addRow(table.id, { c1: 'DZ', c2: 'X' }, { column: 'TMS', value: 'DZ' }), /DZ is in TMS already/);
        const full = await store.get(table.id);
        await store.save({ ...full!, rows: Array.from({ length: 1000 }, (_, i) => ({ c1: `K${i}`, c2: '', c3: '' })) });
        await assert.rejects(store.addRow(table.id, { c1: 'NEW' }), /up to 1,000 rows/);
        await store.remove(table.id);
        await assert.rejects(store.addRow(table.id, { c1: 'NEW' }), /has been deleted/);
    });

    it('rename, duplicate, delete: a deleted table reads as undefined', async () => {
        const { store } = fresh();
        const table = await store.create('Units');
        await store.save({ ...table, rows: [{ c1: 'EA', c2: 'each' }] });
        await store.rename(table.id, 'Unit codes');
        const copy = await store.duplicate(table.id);
        assert.strictEqual(copy.name, 'Unit codes copy');
        assert.deepStrictEqual(copy.rows, [{ c1: 'EA', c2: 'each' }]);
        await assert.rejects(store.rename(copy.id, 'unit codes'), /already called/);
        await store.remove(table.id);
        assert.strictEqual(await store.get(table.id), undefined);
        assert.deepStrictEqual((await store.list()).map(t => t.name), ['Unit codes copy']);
        await assert.rejects(store.save({ ...table }), /has been deleted/);
    });

    it('a change is heard by every store on the same state (the Hub saves, an open query reruns)', async () => {
        const { state, store } = fresh();
        const reader = new LookupTablesStore(state);
        const heard: string[] = [];
        const stop = reader.onChange(change => heard.push(`${change.kind}:${change.id}`));
        const table = await store.create('Units');
        await store.save({ ...table, rows: [{ c1: 'EA', c2: 'each' }] });
        await store.remove(table.id);
        stop();
        await store.create('Other');
        assert.deepStrictEqual(heard, [`saved:${table.id}`, `saved:${table.id}`, `deleted:${table.id}`]);
        // Another state (another workspace in a test): not told
        const other = fresh();
        const quiet: string[] = [];
        other.store.onChange(change => quiet.push(change.id));
        await store.create('Third');
        assert.deepStrictEqual(quiet, []);
    });
});

describe('Lookup tables: one JSON file each (James, 2026-11-21)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const folderFor = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-lookups-'));
        return { dir, folder: { workspaceRoot: async () => dir } };
    };
    const files = (dir: string) => (fs.existsSync(path.join(dir, 'Lookup Tables')) ? fs.readdirSync(path.join(dir, 'Lookup Tables')).sort() : []);

    it('each table its own file; an edit rewrites only that table\'s; delete takes its file away', async () => {
        const { dir, folder } = folderFor();
        const store = new LookupTablesStore(folder, { now: () => NOW });
        const units = await store.create('Units');
        const sites = await store.create('Sites');
        expect2(files(dir), ['Sites.json', 'Units.json']);
        const sitesFile = path.join(dir, 'Lookup Tables', 'Sites.json');
        const before = fs.readFileSync(sitesFile, 'utf8');
        await store.save({ ...units, rows: [{ c1: 'EA', c2: 'each' }] });
        assert.strictEqual(fs.readFileSync(sitesFile, 'utf8'), before, 'the other table is not rewritten');
        assert.deepStrictEqual((await new LookupTablesStore(folder).get(units.id))?.rows, [{ c1: 'EA', c2: 'each' }]);
        assert.deepStrictEqual((await store.list()).map(t => t.name), ['Sites', 'Units']);
        await store.remove(units.id);
        expect2(files(dir), ['Sites.json']);
        assert.strictEqual(await store.get(units.id), undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('up to 1,000 rows: it is a translation table', async () => {
        const { dir, folder } = folderFor();
        const store = new LookupTablesStore(folder);
        const table = await store.create('Big');
        const rows = Array.from({ length: 1001 }, (_, i) => ({ c1: `K${i}`, c2: `V${i}` }));
        await assert.rejects(store.save({ ...table, rows }), /up to 1,000 rows/);
        await store.save({ ...table, rows: rows.slice(0, 1000) });
        assert.strictEqual((await store.list())[0].rows, 1000);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a renamed table renames its file; the file is found by the id inside, whatever it is called', async () => {
        const { dir, folder } = folderFor();
        const store = new LookupTablesStore(folder, { now: () => NOW });
        const units = await store.create('Units');
        await store.save({ ...units, name: 'UOM / units' });
        expect2(files(dir), ['UOM - units.json']);
        fs.renameSync(path.join(dir, 'Lookup Tables', 'UOM - units.json'), path.join(dir, 'Lookup Tables', 'from a colleague.json'));
        assert.strictEqual((await new LookupTablesStore(folder).get(units.id))?.name, 'UOM / units');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a change is heard by every store on the same folder object', async () => {
        const { dir, folder } = folderFor();
        const heard: string[] = [];
        new LookupTablesStore(folder).onChange(c => heard.push(c.kind));
        await new LookupTablesStore(folder).create('Units');
        assert.deepStrictEqual(heard, ['saved']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // James, 2026-11-23: "that saved search should be everywhere where we have a search box": a table's ★, kept in its file
    it('a table\'s saved searches: kept with it, read back by a fresh store, cleaned; a rename and a duplicate keep them', async () => {
        const { state, store } = fresh();
        const table = await store.create('Units', ['ERP', 'WMS']);
        await store.save({ ...table, searches: [{ name: 'Each', text: '@erp=EA' }, { name: '', text: 'no name' }, { name: 'each', text: 'twice' }] });
        const again = new LookupTablesStore(state, { now: () => NOW });
        assert.deepStrictEqual((await again.get(table.id))!.searches, [{ name: 'Each', text: '@erp=EA' }]);
        assert.deepStrictEqual((await again.rename(table.id, 'UOM')).searches, [{ name: 'Each', text: '@erp=EA' }]);
        assert.deepStrictEqual((await again.duplicate(table.id)).searches, [{ name: 'Each', text: '@erp=EA' }]);
        // A table without them: none
        const plain = await store.create('Sites', ['code']);
        assert.strictEqual((await again.get(plain.id))!.searches, undefined);
    });
});

function expect2(actual: string[], wanted: string[]) { assert.deepStrictEqual(actual, wanted); }
