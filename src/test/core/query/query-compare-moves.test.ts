// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A compare survives every action a view's menu still offers (2026-11-22): moves that keep the Baseline first,
 * hiding and showing, renaming, removing a view. Moves that would change which view is first are refused while
 * the query holds a compare (they broke it: its other views kept pointing at the old Baseline).
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import type { SavedQuery } from '../../../services/query/query-store';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

type Msg = Record<string, unknown> & { type: string };

const rows = (n: number, change: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, qty: change(i) }));
const FILES: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {
    vBL: { columns: ['sku', 'qty'], rows: rows(20, i => i) },
    vC1: { columns: ['sku', 'qty'], rows: rows(20, i => (i === 3 ? 99 : i)) },
    vC2: { columns: ['sku', 'qty'], rows: rows(18, i => i) },
    vC3: { columns: ['sku', 'qty'], rows: rows(20, i => (i === 5 ? 77 : i)) }
};

function savedCompare(): SavedQuery {
    const src = (id: string, i: number) => ({ id, name: ['Stock', 'Stock_C1', 'Stock_C2', 'Stock_C3'][i], endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-22T00:00:00Z', file: { name: 'stock.xlsx', sheet: id } });
    const ids = ['vBL', 'vC1', 'vC2', 'vC3'];
    return {
        id: 'qry-moves', name: 'Stock compare', sources: ids.map(src), letters: 'names', reached: 4, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z',
        joins: ids.slice(1).map(id => ({ view: id, kind: 'compare' as const, on: [{ left: { parts: [{ view: 'vBL', column: 'sku' }] }, right: { parts: [{ view: id, column: 'sku' }] } }] }))
    } as SavedQuery;
}

async function opened(engineOn: boolean) {
    const store = new Map<string, unknown>([['queries', [savedCompare()]]]);
    const seen: Msg[] = [];
    const toasts: string[] = [];
    const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
    const ports = {
        metadata: { getUnifiedExecutionHistory: async () => [] },
        environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
        endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
        state: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } },
        toast: { info: (m: string) => toasts.push(m), warn: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) },
        logger: { log() { /* */ }, error() { /* */ } },
        host: { close() { /* */ }, openConsole: async () => { /* */ } },
        sql: () => initSqlJs({ locateFile: () => SQL_WASM_PATH }),
        newCompareEngine: () => engineOn,
        queryFiles: { read: async (_q: string, view: string) => FILES[view], save: async () => { /* */ }, remove: async () => { /* */ } }
    };
    const controller = new QueryController(session, ports as never, { queryId: 'qry-moves' });
    await controller.handleMessage({ type: 'query.ready' } as never);
    const state = () => [...seen].reverse().find(m => m.type === 'query.state') as Msg & { error: string; total: number; compare: { baseline: string; views: string[] } | null; views: { id: string }[] };
    const send = (m: Msg) => controller.handleMessage(m as never);
    return { send, state, toasts, saved: () => (store.get('queries') as SavedQuery[])[0], dispose: () => controller.dispose() };
}

for (const engineOn of [true, false]) {
    describe(`Query: a compare survives its views' menu (${engineOn ? 'new' : 'old'} engine)`, function () {
        this.timeout(20000);

        it('opens as a compare of four, the Baseline first', async () => {
            const q = await opened(engineOn);
            assert.strictEqual(q.state().error, '');
            assert.strictEqual(q.state().compare?.baseline, 'vBL');
            assert.deepStrictEqual(q.state().compare?.views, ['vBL', 'vC1', 'vC2', 'vC3']);
            assert.strictEqual(q.state().total, 20);
            q.dispose();
        });

        it('Move left / right among the others, Hide and Show, Rename, Remove: still a compare on the same Baseline', async () => {
            const q = await opened(engineOn);
            const fine = (what: string) => {
                assert.strictEqual(q.state().error, '', `${what}: ${q.state().error}`);
                assert.strictEqual(q.state().compare?.baseline, 'vBL', what);
                assert.ok(q.state().total > 0, `${what}: rows`);
            };
            await q.send({ type: 'query.moveView', id: 'vC2', to: 1 });
            assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vBL', 'vC2', 'vC1', 'vC3']);
            fine('Move left');
            await q.send({ type: 'query.moveView', id: 'vC2', to: 2 });
            fine('Move right');
            await q.send({ type: 'query.toggleView', id: 'vC1' });
            fine('Hide');
            await q.send({ type: 'query.toggleView', id: 'vC1' });
            fine('Show');
            assert.deepStrictEqual(q.state().compare?.views.slice().sort(), ['vBL', 'vC1', 'vC2', 'vC3']);
            await q.send({ type: 'query.renameView', id: 'vC1', name: 'Stock_Tuesday' });
            fine('Rename');
            await q.send({ type: 'query.removeView', id: 'vC3' });
            fine('Remove');
            assert.deepStrictEqual(q.state().compare?.views, ['vBL', 'vC2', 'vC1'].filter(v => q.saved().sources.some(s => s.id === v)).sort((a, b) => q.saved().sources.findIndex(s => s.id === a) - q.saved().sources.findIndex(s => s.id === b)));
            q.dispose();
        });

        it('Make C2 the Baseline (Results, a run of the Baseline\'s view): the two runs\' results swap, the compare and its joins stay', async () => {
            const q = await opened(engineOn);
            // (runs of one endpoint: each slot reads its run's result; files stand in for the rows, the swap is of the results)
            const runs = q.saved();
            runs.sources.forEach((s, i) => { s.executionId = `run-${i}`; if (i) { s.runOf = 'vBL'; s.run = `C${i}`; } });
            const joins = JSON.stringify(runs.joins);
            await q.send({ type: 'query.makeBaseline', id: 'vC2' });
            assert.deepStrictEqual(q.saved().sources.map(s => s.executionId), ['run-2', 'run-1', 'run-0', 'run-3']);
            assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vBL', 'vC1', 'vC2', 'vC3']);
            assert.strictEqual(JSON.stringify(q.saved().joins), joins);
            assert.strictEqual(q.state().error, '');
            assert.strictEqual(q.state().compare?.baseline, 'vBL');
            assert.ok(q.state().total > 0);
            q.dispose();
        });

        it('a move that would change which view is first is refused, and said: the compare is as it was', async () => {
            const q = await opened(engineOn);
            const before = JSON.stringify({ sources: q.saved().sources.map(s => s.id), joins: q.saved().joins });
            await q.send({ type: 'query.moveFirst', id: 'vC2' });
            await q.send({ type: 'query.moveView', id: 'vC1', to: 0 });
            await q.send({ type: 'query.moveView', id: 'vBL', to: 2 });
            assert.strictEqual(JSON.stringify({ sources: q.saved().sources.map(s => s.id), joins: q.saved().joins }), before);
            assert.strictEqual(q.state().error, '');
            assert.strictEqual(q.state().compare?.baseline, 'vBL');
            assert.strictEqual(q.toasts.filter(t => t === 'The Baseline stays first in a compare.').length, 3);
            q.dispose();
        });
    });
}

/**
 * A key of two columns (sku AND location, "+ AND"): every part shows on Results with its key mark, and the record
 * window finds each view's records by the whole key and says the whole key as its title (2026-11-22: it found
 * nothing, matching the joined key against its first part; James saw only the first key).
 */
describe('Query: a compare on a key of two columns (new engine)', function () {
    this.timeout(20000);
    const grid = (change: (sku: number, loc: number) => number) => {
        const out: Record<string, unknown>[] = [];
        for (let s = 0; s < 5; s++) for (const loc of ['L1', 'L2']) out.push({ sku: `S${s}`, loc, qty: change(s, loc === 'L1' ? 1 : 2) });
        return out;
    };
    const files: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {
        vBL: { columns: ['sku', 'loc', 'qty'], rows: grid((s, l) => s * 10 + l) },
        vC1: { columns: ['sku', 'loc', 'qty'], rows: grid((s, l) => (s === 0 && l === 2 ? 99 : s * 10 + l)) }
    };

    async function twoKey() {
        const query = {
            id: 'qry-two', name: 'Two keys', letters: 'names', reached: 4, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z',
            sources: ['vBL', 'vC1'].map((id, i) => ({ id, name: ['Stock', 'Stock_C1'][i], endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-22T00:00:00Z', file: { name: 'stock.xlsx', sheet: id } })),
            joins: [{ view: 'vC1', kind: 'compare', on: ['sku', 'loc'].map(c => ({ left: { parts: [{ view: 'vBL', column: c }] }, right: { parts: [{ view: 'vC1', column: c }] } })) }],
            select: [{ view: 'vBL', column: 'qty', group: 'qty' }, { view: 'vC1', column: 'qty', group: 'qty' }]
        };
        const store = new Map<string, unknown>([['queries', [query]]]);
        const seen: Msg[] = [];
        const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
        const ports = {
            metadata: { getUnifiedExecutionHistory: async () => [] },
            environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
            endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
            state: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } },
            toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } }, logger: { log() { /* */ }, error() { /* */ } },
            host: { close() { /* */ }, openConsole: async () => { /* */ } },
            sql: () => initSqlJs({ locateFile: () => SQL_WASM_PATH }), newCompareEngine: () => true,
            queryFiles: { read: async (_q: string, view: string) => files[view], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: 'qry-two' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        return { controller, seen };
    }

    it('both key columns lead Results; a record is found by both, and its title is both', async () => {
        const { controller, seen } = await twoKey();
        const state = [...seen].reverse().find(m => m.type === 'query.state') as Msg & { error: string; resultColumns: { view: string; column: string }[] };
        assert.strictEqual(state.error, '');
        assert.deepStrictEqual(state.resultColumns.slice(0, 2).map(c => c.column), ['sku', 'loc']);
        await controller.handleMessage({ type: 'query.rows', seq: 1, offset: 0, limit: 50, sort: { column: 0, dir: 'asc' } } as never);
        const page = seen.find(m => m.type === 'query.rowsData' && m.seq === 1) as Msg & { rows: unknown[][] };
        const at = page.rows.findIndex(r => r[0] === 'S0' && r[1] === 'L2');
        assert.ok(at >= 0, 'S0 · L2 is a row');
        await controller.handleMessage({ type: 'query.record', index: at, hidden: [] } as never);
        const detail = seen.find(m => m.type === 'query.recordDetail') as Msg & { places: string[]; keyText: string; fields: { name: string; values: unknown[][]; differs: boolean }[] };
        assert.strictEqual(detail.keyText, 'S0 · L2');
        const field = (name: string) => detail.fields.find(f => f.name === name)!;
        // One record a view: the one with both parts (not every location of S0)
        assert.deepStrictEqual(field('loc').values, [['L2'], ['L2']]);
        assert.deepStrictEqual(field('qty').values, [[2], [99]]);
        assert.strictEqual(field('qty').differs, true);
        controller.dispose();
    });
});
