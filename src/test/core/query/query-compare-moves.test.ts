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
    return { send, state, toasts, seen, saved: () => (store.get('queries') as SavedQuery[])[0], dispose: () => controller.dispose() };
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

        it('a move that makes another of the compare\'s views first makes it the Baseline (#7): the joins follow, the compare runs', async () => {
            const q = await opened(engineOn);
            await q.send({ type: 'query.moveFirst', id: 'vC2' });
            const after = q.saved();
            assert.deepStrictEqual(after.sources.map(s => s.id), ['vC2', 'vBL', 'vC1', 'vC3']);
            // Every other view of the compare, the old Baseline too, compared with C2 on the same key line, by its own column
            assert.deepStrictEqual(after.joins.map(j => [j.view, j.kind, j.on.map(p => `${p.left.parts[0].view}.${p.left.parts[0].column}=${p.right.parts[0].view}.${p.right.parts[0].column}`)]), [
                ['vBL', 'compare', ['vC2.sku=vBL.sku']], ['vC1', 'compare', ['vC2.sku=vC1.sku']], ['vC3', 'compare', ['vC2.sku=vC3.sku']]
            ]);
            assert.strictEqual(q.state().error, '');
            assert.strictEqual(q.state().compare?.baseline, 'vC2');
            assert.deepStrictEqual(q.state().compare?.views, ['vC2', 'vBL', 'vC1', 'vC3']);
            // C2 holds 18 records: the other two keys are only in the others now, and Results still has every key
            await q.send({ type: 'query.rows', seq: 7, offset: 0, limit: 50 });
            const page = q.seen.filter(m => m.type === 'query.rowsData' && m.seq === 7).pop() as Msg & { total: number; shown: number };
            assert.strictEqual(page.shown, 20);
            // Moved back by a drag of the old Baseline to the front: the compare as it began
            await q.send({ type: 'query.moveView', id: 'vBL', to: 0 });
            assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vBL', 'vC2', 'vC1', 'vC3']);
            assert.strictEqual(q.state().compare?.baseline, 'vBL');
            assert.strictEqual(q.state().error, '');
            // The Baseline moved right: the view after it is the Baseline now, the old one where it was put
            await q.send({ type: 'query.moveView', id: 'vBL', to: 2 });
            assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vC2', 'vC1', 'vBL', 'vC3']);
            assert.strictEqual(q.state().compare?.baseline, 'vC2');
            assert.strictEqual(q.state().error, '');
            q.dispose();
        });

        it('runs of one view: the run made the Baseline is the view\'s first run, the old Baseline its run', async () => {
            const q = await opened(engineOn);
            const runs = q.saved();
            runs.sources.forEach((s, i) => { if (i) { s.runOf = 'vBL'; s.run = `C${i}`; } });
            await q.send({ type: 'query.moveFirst', id: 'vC2' });
            const after = q.saved().sources.map(s => [s.id, s.runOf ?? '', s.run ?? '']);
            assert.deepStrictEqual(after, [['vC2', '', ''], ['vBL', 'vC2', 'C2'], ['vC1', 'vC2', 'C1'], ['vC3', 'vC2', 'C3']]);
            assert.strictEqual(q.state().error, '');
            q.dispose();
        });

        it('a view outside the compare can\'t be made first while the compare is there: refused, said, nothing changed', async () => {
            const q = await opened(engineOn);
            const saved = q.saved();
            saved.sources.push({ ...saved.sources[1], id: 'vX', name: 'Extra', file: { name: 'stock.xlsx', sheet: 'vBL' } });
            saved.joins.push({ view: 'vX', kind: 'left', on: [{ left: { parts: [{ view: 'vBL', column: 'sku' }] }, right: { parts: [{ view: 'vX', column: 'sku' }] } }] });
            const before = JSON.stringify({ sources: saved.sources.map(s => s.id), joins: saved.joins });
            await q.send({ type: 'query.moveFirst', id: 'vX' });
            await q.send({ type: 'query.moveView', id: 'vX', to: 0 });
            assert.strictEqual(JSON.stringify({ sources: q.saved().sources.map(s => s.id), joins: q.saved().joins }), before);
            assert.strictEqual(q.toasts.filter(t => t.startsWith('Only a view in the compare')).length, 2);
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

    async function twoKey(shared?: Map<string, unknown>) {
        const query = {
            id: 'qry-two', name: 'Two keys', letters: 'names', reached: 4, clashes: 'unticked', blanks: 'unticked', createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z',
            sources: ['vBL', 'vC1'].map((id, i) => ({ id, name: ['Stock', 'Stock_C1'][i], endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-22T00:00:00Z', file: { name: 'stock.xlsx', sheet: id } })),
            joins: [{ view: 'vC1', kind: 'compare', on: ['sku', 'loc'].map(c => ({ left: { parts: [{ view: 'vBL', column: c }] }, right: { parts: [{ view: 'vC1', column: c }] } })) }],
            select: [{ view: 'vBL', column: 'qty', group: 'qty' }, { view: 'vC1', column: 'qty', group: 'qty' }]
        };
        const store = shared ?? new Map<string, unknown>([['queries', [query]]]);
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
        return { controller, seen, store };
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
        // The record window's own (#5, #19, #21): which fields are compared (marked by default), each result's heading,
        // a field every view has is never "not in this view"
        assert.deepStrictEqual(detail.fields.map(f => [f.name, (f as unknown as { compared: boolean }).compared]), [['sku', false], ['loc', false], ['qty', true]]);
        assert.deepStrictEqual((detail as unknown as { heads: { file: string; executedAt: string }[] }).heads.map(h => h.file), ['stock.xlsx', 'stock.xlsx']);
        assert.deepStrictEqual(detail.fields.map(f => (f as unknown as { absent: boolean[] }).absent), [[false, false], [false, false], [false, false]]);
        // The export's summary of the compare (#13): key, compared, rows per view, the counts Results showed, the filters
        const summary = (controller as unknown as { compareSummary(m: unknown): [string, string][] }).compareSummary({
            seq: 0, offset: 0, limit: 0, counts: { all: 10, same: 9, diff: 1, missing: {}, relations: {}, columns: { qty: 1 } },
            filter: { kinds: ['diff'], columns: [], relations: null, hidden: [] }, diffsOnly: true
        });
        assert.deepStrictEqual(summary.filter(([k]) => k), [
            ['Key', 'sku + loc'], ['Compared', 'qty'], ['Rows Stock', '10 (Stock)'], ['Rows Stock_C1', '10 (Stock_C1)'],
            ['Same', '9'], ['DIFF', '1'], ['Filters', 'Status: DIFF · Only diffs']
        ]);
        controller.dispose();
    });

    it('what the compare found is kept for the Hub\'s line (#11); Side by side or Compact is remembered for the user (#18)', async () => {
        const { controller, seen, store } = await twoKey();
        await controller.handleMessage({ type: 'query.rows', seq: 1, offset: 0, limit: 50 } as never);
        // S0 · L2 differs (qty 2 against 99): one DIFF, nothing missing
        assert.deepStrictEqual((store.get('queries') as { found?: unknown }[])[0].found, { diff: 1, missing: 0 });
        await controller.handleMessage({ type: 'query.preference', key: 'resultsView', value: 'compact' } as never);
        await controller.handleMessage({ type: 'query.preference', key: 'anything', value: 1 } as never);
        assert.deepStrictEqual(store.get('queryPreferences'), { resultsView: 'compact' });
        controller.dispose();
        // (the next query opened hears it)
        const again = await twoKey(store);
        const init = again.seen.find(m => m.type === 'query.init') as Msg & { prefs: Record<string, unknown> };
        assert.deepStrictEqual(init.prefs, { resultsView: 'compact' });
        again.controller.dispose();
        void seen;
    });
});

describe('Query: a compare\'s views lead (compareLeads)', function () {
    it('a view added before a compare moves after it, its pairs turned round to join the compare', async () => {
        const { compareLeads } = await import('../../../services/query/query-store');
        const src = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, endpointId: 'e', endpointName: 'e', view: 'v', executionId: id, isBatch: true, environment: '', executedAt: '', ...extra });
        const q = {
            id: 'q', name: 'q', letters: 'names', createdAt: '', updatedAt: '',
            sources: [src('vX'), src('vBL'), src('vC1', { runOf: 'vBL', run: 'C1' })],
            joins: [
                { view: 'vBL', kind: 'left' as const, on: [{ left: { parts: [{ view: 'vX', column: 'sku' }] }, right: { parts: [{ view: 'vBL', column: 'code' }] } }] },
                { view: 'vC1', kind: 'compare' as const, on: [{ left: { parts: [{ view: 'vBL', column: 'sku' }] }, right: { parts: [{ view: 'vC1', column: 'sku' }] } }] }
            ]
        } as unknown as SavedQuery;
        assert.strictEqual(compareLeads(q), true);
        assert.deepStrictEqual(q.sources.map(s => s.id), ['vBL', 'vC1', 'vX']);
        assert.deepStrictEqual(q.joins.map(j => [j.view, j.kind]), [['vC1', 'compare'], ['vX', 'left']]);
        assert.deepStrictEqual(q.joins[1].on.map(p => [p.left.parts[0], p.right.parts[0]]), [[{ view: 'vBL', column: 'code' }, { view: 'vX', column: 'sku' }]]);
        // Already first: nothing moves
        assert.strictEqual(compareLeads(q), false);
    });
    it('a query with no compare, or its compare already first, is left as it is', async () => {
        const { compareLeads } = await import('../../../services/query/query-store');
        const q = savedCompare();
        const before = JSON.stringify(q);
        assert.strictEqual(compareLeads(q), false);
        assert.strictEqual(JSON.stringify(q), before);
    });
});
