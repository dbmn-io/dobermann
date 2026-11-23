// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One rule for looking a value up (shared/lookup-value.js lookupValue, re-exported by lookup-tables.ts): what Query's
 * Translate values does in the engine and what Run Batch's lookups read, so they never disagree. A value in the From
 * column more than once: the first row wins, top to bottom as the table keeps them (the manager for James, 2026-11-23:
 * "just pick one and move on", "if we're looking up, we pick the first one"), and how many rows matched is said.
 *   npm run test:core
 */
import * as assert from 'assert';
import { lookupValue, LookupTablesStore, type LookupTable } from '../../../services/lookup-tables/lookup-tables';
import { loadLookupInto, lookupTableName } from '../../../services/query/query-new-engine';
import { localEngineHost } from '../../../services/engine/engine-host';
import { QueryEngine } from '../../../services/engine/engine';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';

const UOM: LookupTable = {
    id: 'lkp-uom', name: 'uom', updatedAt: '',
    columns: [{ id: 'c1', name: 'TMS' }, { id: 'c2', name: 'WMS' }, { id: 'c3', name: 'ERP' }],
    rows: [{ c1: 'EA', c2: 'EACH', c3: 'U' }, { c1: 'CS', c2: 'CASE', c3: 'C12' }, { c1: 'CS', c2: 'CASE2', c3: 'C6' }, { c1: 'BX', c2: '', c3: 'B' }, { c1: ' PK', c2: 'PACK', c3: 'P' }]
};

describe('Lookup tables: one rule for a value looked up (Translate values, and Run Batch\'s lu)', () => {
    it('found, missing; in two rows, the first row\'s, saying how many; any column to any other, by name (any case) or id; exact text', () => {
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'EA', 'WMS'), { kind: 'found', value: 'EACH' });
        assert.deepStrictEqual(lookupValue(UOM, 'wms', 'EACH', 'tms'), { kind: 'found', value: 'EA' });
        assert.deepStrictEqual(lookupValue(UOM, 'c3', 'U', 'c2'), { kind: 'found', value: 'EACH' });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'CS', 'WMS'), { kind: 'found', value: 'CASE', rows: 2 });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'CS', 'ERP'), { kind: 'found', value: 'C12', rows: 2 });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'XX', 'WMS'), { kind: 'missing' });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'ea', 'WMS'), { kind: 'missing' }, 'letter case counts');
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'PK', 'WMS'), { kind: 'missing' }, 'no trimming: the table has " PK"');
        assert.deepStrictEqual(lookupValue(UOM, 'WMS', 'CASE'), { kind: 'found', value: 'CASE' }, 'no To: is it in the column');
        assert.deepStrictEqual(lookupValue(UOM, 'Nope', 'EA', 'WMS'), { kind: 'missing' });
    });

    it('the engine\'s Translate values agrees: found gives the value (in two rows, the first\'s); missing and a blank To keep the original', async () => {
        const engine = new QueryEngine();
        const host = localEngineHost(engine);
        await loadLookupInto(host, UOM);
        const values = ['EA', 'CS', 'XX', 'BX', 'ea', 'PK', ' PK'];
        engine.load('t', { columns: ['u'], rows: values.map(v => [v]) });
        const out = await engine.run({ steps: [{ from: 't' }, { select: 'step 1', columns: [{ name: 'x', value: { fn: 'TRANSLATE', args: [{ column: 'u' }, { value: lookupTableName(UOM.id) }, { value: 'c1' }, { value: 'c2' }] } }] }] });
        assert.ok('result' in out);
        const got = engine.read(out.result, 0, values.length).rows.map(r => r[0]);
        const want = values.map(v => { const a = lookupValue(UOM, 'c1', v, 'c2'); return a.kind === 'found' && a.value !== '' ? a.value : v; });
        assert.deepStrictEqual(got, want);
    });

    it('the first row is the first as the table keeps them: through a save, a reload, and rows added after', async () => {
        const state = new MemoryKeyValueStore();
        const store = new LookupTablesStore(state);
        const made = await store.create('Units', ['TMS', 'WMS']);
        await store.save({ ...made, rows: [{ c1: 'EA', c2: 'Unit' }, { c1: 'CS', c2: 'Case' }] });
        await store.addRow(made.id, { c1: 'EA', c2: 'Each' });
        const again = await new LookupTablesStore(state).get(made.id);
        assert.deepStrictEqual(lookupValue(again!, 'TMS', 'EA', 'WMS'), { kind: 'found', value: 'Unit', rows: 2 });
        // (James's own example: Unit,EA and Each,EA, looked up from the second column)
        assert.deepStrictEqual(lookupValue({ columns: [{ id: 'c1', name: 'COL1' }, { id: 'c2', name: 'COL2' }], rows: [{ c1: 'Unit', c2: 'EA' }, { c1: 'Each', c2: 'EA' }] }, 'COL2', 'EA', 'COL1'), { kind: 'found', value: 'Unit', rows: 2 });
    });

    it('a table by its name, any letter case', async () => {
        const store = new LookupTablesStore(new MemoryKeyValueStore());
        const made = await store.create('Unit codes', ['TMS', 'WMS']);
        assert.strictEqual((await store.findByName('unit CODES'))?.id, made.id);
        assert.strictEqual(await store.findByName('nope'), undefined);
    });
});
