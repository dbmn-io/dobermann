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
    it('a new table: a key and a value column, no rows, kept with the queries; a second is named apart', async () => {
        const { state, store } = fresh();
        const units = await store.create('Units');
        assert.deepStrictEqual(units.columns, [{ id: 'c1', name: 'code', key: true }, { id: 'c2', name: 'value' }]);
        assert.deepStrictEqual(units.rows, []);
        assert.ok(units.id.startsWith('lkp-'));
        assert.strictEqual((state.get<unknown[]>(LOOKUP_TABLES_KEY) || []).length, 1);
        const again = await store.create('units');
        assert.strictEqual(again.name, 'units 2');
        assert.deepStrictEqual((await store.list()).map(t => [t.name, t.rows]), [['Units', 0], ['units 2', 0]]);
    });

    it('many columns (ERP, WMS, finance…): saved and read back by id, values as text', async () => {
        const { store } = fresh();
        const table = await store.create('Units');
        const columns = [{ id: 'erp', name: 'ERP unit', key: true }, { id: 'wms', name: 'WMS unit' }, { id: 'fin', name: 'Finance unit' }, { id: 'note', name: 'Note' }];
        await store.save({ ...table, columns, rows: [{ erp: 'EA', wms: 'EACH', fin: 'UNIT', note: '' }, { erp: 'CS', wms: 'CASE', fin: 12 as unknown as string, note: 'twelve' }] });
        const read = await store.get(table.id);
        assert.deepStrictEqual(read?.columns.map(c => c.name), ['ERP unit', 'WMS unit', 'Finance unit', 'Note']);
        assert.deepStrictEqual(read?.rows[1], { erp: 'CS', wms: 'CASE', fin: '12', note: 'twelve' });
        const [summary] = await store.list();
        assert.deepStrictEqual([summary.rows, summary.columns.length, summary.updatedAt], [2, 4, NOW]);
    });

    it('up to the column limit; a key one value per row, and every row has one', async () => {
        const many = Array.from({ length: LOOKUP_MAX_COLUMNS + 1 }, (_, i) => ({ id: `c${i}`, name: `col ${i}` }));
        assert.match(lookupTableProblem({ name: 'Wide', columns: many, rows: [] }), /up to 50 columns/);
        assert.strictEqual(lookupTableProblem({ name: 'Wide', columns: many.slice(0, LOOKUP_MAX_COLUMNS), rows: [] }), '');
        const columns = [{ id: 'k', name: 'code', key: true }, { id: 'v', name: 'value' }];
        assert.match(lookupTableProblem({ name: 'T', columns, rows: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }] }), /code A is in two rows/);
        assert.match(lookupTableProblem({ name: 'T', columns, rows: [{ k: '', v: '1' }] }), /Every row needs a code/);
        assert.match(lookupTableProblem({ name: 'T', columns: [{ id: 'a', name: 'x' }, { id: 'b', name: 'X' }], rows: [] }), /Two columns are called X/);

        const { store } = fresh();
        const table = await store.create('T');
        await assert.rejects(store.save({ ...table, columns, rows: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }] }), /a key is in one row only/);
        assert.deepStrictEqual((await store.get(table.id))?.rows, [], 'a table that can\'t be kept is not changed');
    });

    it('a column renamed keeps its id (a saved query\'s from and to keep working)', async () => {
        const { store } = fresh();
        const table = await store.create('Units');
        await store.save({ ...table, columns: [{ id: 'c1', name: 'ERP unit', key: true }, { id: 'c2', name: 'WMS unit' }] });
        assert.deepStrictEqual((await store.get(table.id))?.columns.map(c => c.id), ['c1', 'c2']);
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

    it('tables kept in the state store before move into files once, and leave the state', async () => {
        const { dir, folder } = folderFor();
        const state = new MemoryKeyValueStore();
        const old = new LookupTablesStore(state);
        const a = await old.create('Units');
        await old.save({ ...a, rows: [{ c1: 'EA', c2: 'each' }] });
        await old.create('Sites');
        const store = new LookupTablesStore(folder);
        assert.strictEqual(await store.migrateFrom(state), 2);
        assert.strictEqual(state.get(LOOKUP_TABLES_KEY), undefined);
        assert.deepStrictEqual((await store.get(a.id))?.rows, [{ c1: 'EA', c2: 'each' }]);
        assert.strictEqual(await store.migrateFrom(state), 0, 'once');
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
});

function expect2(actual: string[], wanted: string[]) { assert.deepStrictEqual(actual, wanted); }
