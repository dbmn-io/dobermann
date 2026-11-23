// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Three files on Join, one made Compare (James, 2026-11-23, demo set c, c-pack-BL/C1/C2: "I just changed [the join] to
 * compare and it added another column… it added a join instead of changing it to compare, this is very confusing").
 * A file with the Baseline file's columns can be a run of it: Compare takes it in, keyed on the same column. A file with
 * other columns stays out, unjoined, its join empty: never a join he didn't make. Delete join takes any join back to
 * unjoined, a compare's every view with it.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import type { SavedQuery } from '../../../services/query/query-store';

type Msg = Record<string, unknown> & { type: string };
type PageJoin = { view: string; kind: string; on: { left: { view: string; column: string }; right: { view?: string; column: string } }[] };
type State = Msg & { joins: PageJoin[]; compare: { baseline: string; views: string[] } | null };

const PACK = ['sku', 'name', 'qty'];
const ROWS = [['WOOF-201', 'Biscuit', 5], ['WOOF-202', 'Pepper', 3], ['WOOF-203', 'Rex', 7], ['WOOF-204', 'Luna', 2]];
const file = (columns: string[], rows: unknown[][]) => ({ columns, rows: rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]]))) });
const src = (id: string, name: string) => ({ id, name, endpointId: '', endpointName: `${name}.xlsx`, view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-23T00:00:00Z', file: { name: `${name}.xlsx`, sheet: 'Sheet1' } });

describe('Query: three files on Join, one made Compare (demo set c)', function () {
    this.timeout(20000);

    /** The query with three files, as James had it: C1 joined to BL on sku, C2 not joined yet. */
    async function setUp(c2Columns = PACK) {
        const files: Record<string, ReturnType<typeof file>> = {
            vBL: file(PACK, ROWS), vC1: file(PACK, ROWS),
            vC2: file(c2Columns, [ROWS[0], ROWS[1], ROWS[2], ['WOOF-203', 'Rex', 7], ROWS[3]])
        };
        const query = { id: 'qry-c', name: 'c-pack', reached: 2, createdAt: '', updatedAt: '', sources: [src('vBL', 'c-pack-BL'), src('vC1', 'c-pack-C1'), src('vC2', 'c-pack-C2')], joins: [] } as unknown as SavedQuery;
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
            queryFiles: { read: async (_q: string, view: string) => files[view], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: query.id });
        await controller.handleMessage({ type: 'query.ready' } as never);
        const send = (m: Record<string, unknown>) => controller.handleMessage(m as never);
        const state = () => [...seen].reverse().find(m => m.type === 'query.state') as State;
        const joinOf = (id: string) => state().joins.find(j => j.view === id)!;
        const keys = (id: string) => joinOf(id).on.map(p => `${p.left.view}.${p.left.column}=${p.right.column}`);
        await send({ type: 'query.setJoin', view: 'vC1', kind: 'left', on: [{ left: { view: 'vBL', column: 'sku' }, right: { column: 'sku' } }] });
        return { controller, send, state, joinOf, keys };
    }
    const compareOn = { type: 'query.setJoin', view: 'vC1', kind: 'compare', on: [{ left: { view: 'vBL', column: 'sku' }, right: { column: 'sku' } }] };

    it('C1 made Compare: C2, a file with the same columns, comes into the compare on sku; no plain join is left for it', async () => {
        const { controller, send, state, joinOf, keys } = await setUp();
        await send(compareOn);
        assert.deepStrictEqual(state().compare?.views, ['vBL', 'vC1', 'vC2']);
        assert.strictEqual(joinOf('vC2').kind, 'compare');
        assert.deepStrictEqual(keys('vC2'), ['vBL.sku=sku']);
        controller.dispose();
    });

    it('the same columns in another order or letter case are the same file shape', async () => {
        const { controller, send, state } = await setUp(['QTY', 'Name', 'SKU']);
        await send(compareOn);
        assert.deepStrictEqual(state().compare?.views, ['vBL', 'vC1', 'vC2']);
        controller.dispose();
    });

    it('a file with other columns stays out: unjoined, its join empty, never a join made for it', async () => {
        const { controller, send, state, joinOf } = await setUp(['code', 'dog', 'count']);
        await send(compareOn);
        assert.deepStrictEqual(state().compare?.views, ['vBL', 'vC1']);
        assert.deepStrictEqual({ kind: joinOf('vC2').kind, on: joinOf('vC2').on }, { kind: 'left', on: [] });
        controller.dispose();
    });

    it('Delete join on the compare: every view in it back to unjoined, none of them compared; picked again, Compare takes all three back', async () => {
        const { controller, send, state, joinOf } = await setUp();
        await send(compareOn);
        await send({ type: 'query.deleteJoin', views: ['vC1', 'vC2'] });
        assert.strictEqual(state().compare, null);
        for (const id of ['vC1', 'vC2']) assert.deepStrictEqual({ kind: joinOf(id).kind, on: joinOf(id).on }, { kind: 'left', on: [] }, id);
        await send({ type: 'query.setJoin', view: 'vC1', kind: 'left', on: [{ left: { view: 'vBL', column: 'sku' }, right: { column: 'sku' } }] });
        await send(compareOn);
        assert.deepStrictEqual(state().compare?.views, ['vBL', 'vC1', 'vC2']);
        controller.dispose();
    });

    it('Delete join on a plain join: that view back to unjoined, the others as they were', async () => {
        const { controller, send, joinOf, keys } = await setUp(['code', 'dog', 'count']);
        await send({ type: 'query.setJoin', view: 'vC2', kind: 'left', on: [{ left: { view: 'vBL', column: 'sku' }, right: { column: 'code' } }] });
        await send({ type: 'query.deleteJoin', views: ['vC2'] });
        assert.deepStrictEqual({ kind: joinOf('vC2').kind, on: joinOf('vC2').on }, { kind: 'left', on: [] });
        assert.deepStrictEqual(keys('vC1'), ['vBL.sku=sku']);
        controller.dispose();
    });
});
