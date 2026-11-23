// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Translate values' "+ Add" (James, 2026-11-23, the mock's step 3): the functions dialog's sample says each value
 * before and after, which ones aren't in the From column (and which are in it twice); a value added from there
 * becomes a row of the lookup table, and the sample asked again shows it translated.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import { LookupTablesStore } from '../../../services/lookup-tables/lookup-tables';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import type { SavedQuery } from '../../../services/query/query-store';

type Msg = Record<string, unknown> & { type: string };
type Line = { before: unknown; after: unknown; missing?: boolean; twice?: boolean; looked?: string };

describe('Query: Translate values\' "+ Add" (a value not in the lookup table)', function () {
    this.timeout(20000);

    async function setUp(first: { fn: 'upper' }[] = []) {
        const lookups = new LookupTablesStore(new MemoryKeyValueStore());
        const uom = await lookups.create('UOM', ['TMS', 'WMS']);
        await lookups.save({ ...uom, rows: [{ c1: 'EA', c2: 'EACH' }, { c1: 'BX', c2: 'BOX' }, { c1: 'BX', c2: 'BOX2' }] });
        const files = { vA: { columns: ['sku', 'uom'], rows: [{ sku: 'S1', uom: 'EA' }, { sku: 'S2', uom: 'DZ' }, { sku: 'S3', uom: 'BX' }, { sku: 'S4', uom: 'gr' }] } };
        const query = { id: 'qry-uom', name: 'Units', reached: 4, createdAt: '', updatedAt: '', joins: [], sources: [{ id: 'vA', name: 'Stock', endpointId: '', endpointName: 'stock.csv', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-23T00:00:00Z', file: { name: 'stock.csv' } }], select: [{ view: 'vA', column: 'sku' }, { view: 'vA', column: 'uom' }] } as unknown as SavedQuery;
        const store = new Map<string, unknown>([['queries', [query]]]);
        const seen: Msg[] = [];
        const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
        const ports = {
            metadata: { getUnifiedExecutionHistory: async () => [] },
            environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
            endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
            state: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } },
            toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } },
            logger: { log() { /* */ }, error() { /* */ } },
            host: { close() { /* */ }, openConsole: async () => { /* */ } },
            lookups,
            queryFiles: { read: async (_q: string, view: string) => files[view as 'vA'], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: query.id, start: 'results' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        const fns = [...first, { fn: 'translate', table: uom.id, from: 'c1', to: 'c2' }];
        const sample = async (seq: number, steps = false) => {
            await controller.handleMessage({ type: 'query.fnSample', seq, view: 'vA', column: 'uom', fns, ...(steps ? { steps: true } : {}) } as never);
            return [...seen].reverse().find(m => m.type === 'query.fnSample' && m.seq === seq) as Msg & { rows: Line[]; lookup?: unknown };
        };
        return { controller, lookups, uom, seen, sample };
    }

    it('the sample: each value before and after; DZ not in TMS; BX in it twice (the first row\'s)', async () => {
        const { sample, uom, controller } = await setUp();
        const got = await sample(1);
        assert.deepStrictEqual(got.lookup, { table: uom.id, from: 'c1', to: 'c2' });
        const by = new Map(got.rows.map(r => [String(r.before), r]));
        assert.deepStrictEqual(by.get('EA'), { before: 'EA', after: 'EACH' });
        assert.deepStrictEqual(by.get('DZ'), { before: 'DZ', after: 'DZ', missing: true });
        assert.deepStrictEqual(by.get('BX'), { before: 'BX', after: 'BOX', twice: true });
        controller.dispose();
    });

    it('a function before Translate (Upper): what was looked up, and what "+ Add" adds, is the value as it reached Translate', async () => {
        const { sample, controller } = await setUp([{ fn: 'upper' }]);
        const by = new Map((await sample(3)).rows.map(r => [String(r.before), r]));
        assert.deepStrictEqual(by.get('gr'), { before: 'gr', after: 'GR', missing: true, looked: 'GR' });
        assert.deepStrictEqual(by.get('EA'), { before: 'EA', after: 'EACH' });
        controller.dispose();
    });

    it('the chain of steps (mock v6): each step\'s value; a value not found stops at the Translate step (missingAt); twice, every step and twiceAt', async () => {
        const { sample, controller } = await setUp([{ fn: 'upper' }]);
        const by = new Map((await sample(4, true)).rows.map(r => [String(r.before), r as Line & { steps?: unknown[]; missingAt?: number; twiceAt?: number }]));
        assert.deepStrictEqual(by.get('gr'), { before: 'gr', after: 'GR', missing: true, looked: 'GR', steps: ['GR'], missingAt: 1 });
        assert.deepStrictEqual(by.get('EA'), { before: 'EA', after: 'EACH', steps: ['EA', 'EACH'] });
        assert.deepStrictEqual(by.get('BX'), { before: 'BX', after: 'BOX', twice: true, steps: ['BX', 'BOX'], twiceAt: 1 });
        controller.dispose();
    });

    it('"+ Add" DZ as DOZEN: a row of the table; asked again, DZ translates; added twice, refused in words', async () => {
        const { controller, lookups, uom, seen, sample } = await setUp();
        await controller.handleMessage({ type: 'query.addLookupRow', seq: 7, table: uom.id, from: 'c1', to: 'c2', value: 'DZ', out: 'DOZEN' } as never);
        assert.deepStrictEqual(seen.filter(m => m.type === 'query.lookupRowAdded').pop(), { type: 'query.lookupRowAdded', seq: 7, ok: true });
        assert.deepStrictEqual((await lookups.get(uom.id))?.rows.at(-1), { c1: 'DZ', c2: 'DOZEN' });
        const again = new Map((await sample(2)).rows.map(r => [String(r.before), r]));
        assert.deepStrictEqual(again.get('DZ'), { before: 'DZ', after: 'DOZEN' });
        await controller.handleMessage({ type: 'query.addLookupRow', seq: 8, table: uom.id, from: 'c1', to: 'c2', value: 'DZ', out: 'DOZ' } as never);
        const refused = seen.filter(m => m.type === 'query.lookupRowAdded').pop() as Msg & { ok: boolean; error: string };
        assert.strictEqual(refused.ok, false);
        assert.match(refused.error, /DZ is in TMS already/);
        controller.dispose();
    });
});
