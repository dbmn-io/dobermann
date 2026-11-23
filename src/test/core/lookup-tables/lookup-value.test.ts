// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One rule for looking a value up (lookup-tables.ts lookupValue): what Query's Translate values does in the engine
 * and what Run Batch's `lu` template function reads, so the two never disagree.
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
    it('found, missing, twice; any column to any other, by name (any case) or id; exact text', () => {
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'EA', 'WMS'), { kind: 'found', value: 'EACH' });
        assert.deepStrictEqual(lookupValue(UOM, 'wms', 'EACH', 'tms'), { kind: 'found', value: 'EA' });
        assert.deepStrictEqual(lookupValue(UOM, 'c3', 'U', 'c2'), { kind: 'found', value: 'EACH' });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'CS', 'WMS'), { kind: 'twice', rows: 2 });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'XX', 'WMS'), { kind: 'missing' });
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'ea', 'WMS'), { kind: 'missing' }, 'letter case counts');
        assert.deepStrictEqual(lookupValue(UOM, 'TMS', 'PK', 'WMS'), { kind: 'missing' }, 'no trimming: the table has " PK"');
        assert.deepStrictEqual(lookupValue(UOM, 'WMS', 'CASE'), { kind: 'found', value: 'CASE' }, 'no To: is it in the column');
        assert.deepStrictEqual(lookupValue(UOM, 'Nope', 'EA', 'WMS'), { kind: 'missing' });
    });

    it('the engine\'s Translate values agrees: found gives the value; missing, twice and a blank To keep the original', async () => {
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

    it('a table by its name, any letter case', async () => {
        const store = new LookupTablesStore(new MemoryKeyValueStore());
        const made = await store.create('Unit codes', ['TMS', 'WMS']);
        assert.strictEqual((await store.findByName('unit CODES'))?.id, made.id);
        assert.strictEqual(await store.findByName('nope'), undefined);
    });
});
