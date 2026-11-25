// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Saved calculated columns as a query opens (James, 2026-11-25, "Steps only"; typed formulas rebuilt by hand, no
 * conversion): one with steps runs; a typed formula is kept but not run, said as "Typed formula: rebuild it as steps";
 * steps that name a column the query no longer has, or come back to themselves, are set aside with words. The query
 * still runs either way.
 */
import * as assert from 'assert';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import type { SavedQuery } from '../../../services/query/query-store';

type Msg = Record<string, unknown> & { type: string };

describe('Query: saved calculated columns, steps and typed formulas', function () {
    this.timeout(20000);

    it('steps run; a typed formula, a missing column and a loop are set aside, each said', async () => {
        const FILES: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {
            vA: { columns: ['sku', 'qty'], rows: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 5 }] }
        };
        const query = {
            id: 'qry-calc', name: 'Stock', reached: 4, createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
            sources: [{ id: 'vA', name: 'stock', endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-26T00:00:00Z', file: { name: 'stock.xlsx', sheet: 'Sheet1' } }],
            joins: [],
            select: [{ view: 'vA', column: 'sku' }, { view: '', column: 'double' }, { view: '', column: 'typed' }, { view: '', column: 'gone' }, { view: '', column: 'one' }, { view: '', column: 'two' }],
            calc: [
                { name: 'double', start: { col: 'vA\nqty' }, steps: [{ fn: 'times', value: 2 }] },
                { name: 'typed', expr: '', formula: '@stock.qty * 3' },
                { name: 'gone', start: { col: 'vA\nprice' }, steps: [] },
                { name: 'one', start: { col: 'calc:two' }, steps: [] },
                { name: 'two', start: { col: 'vA\nqty' }, steps: [{ fn: 'plus', col: 'calc:one' }] }
            ]
        } as unknown as SavedQuery;
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
            queryFiles: { read: async (_q: string, view: string) => FILES[view], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: query.id, start: 'results' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        await controller.handleMessage({ type: 'query.rows', seq: 1, offset: 0, limit: 50, search: '', sort: null, filter: {} } as never);
        const state = [...seen].reverse().find(m => m.type === 'query.state') as Msg & { error: string; brokenCalcs: { name: string; error: string }[] };
        assert.strictEqual(state.error, '', state.error);
        const said = Object.fromEntries(state.brokenCalcs.map(b => [b.name, b.error]));
        assert.strictEqual(said.typed, 'Typed formula: rebuild it as steps.');
        assert.match(said.gone, /uses price, which isn't in the query now/);
        assert.match(said.one, /can't use itself: (one → two → one|two → one → two)/);
        assert.match(said.two, /can't use itself/);
        assert.strictEqual(said.double, undefined, 'the one with steps runs');
        const data = [...seen].reverse().find(m => m.type === 'query.rowsData') as Msg & { rows: unknown[][] };
        assert.deepStrictEqual(data.rows, [['A', 4], ['B', 10]]);
        // (the typed one keeps its place in the saved columns, so one rebuilt under its name takes it)
        assert.ok((store.get('queries') as SavedQuery[])[0].select?.some(c => c.view === '' && c.column === 'typed'));
        controller.dispose();
    });

    it('saved from the window: added, renamed (others that use it follow), refused in words; its sample step by step', async () => {
        const FILES: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {
            vA: { columns: ['sku', 'qty'], rows: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 5 }] }
        };
        const query = {
            id: 'qry-win', name: 'Stock', reached: 4, createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
            sources: [{ id: 'vA', name: 'stock', endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-26T00:00:00Z', file: { name: 'stock.xlsx', sheet: 'Sheet1' } }],
            joins: [], select: [{ view: 'vA', column: 'sku' }]
        } as unknown as SavedQuery;
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
            queryFiles: { read: async (_q: string, view: string) => FILES[view], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: query.id, start: 'results' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        const send = (m: Msg) => controller.handleMessage(m as never);
        const saved = () => (store.get('queries') as SavedQuery[])[0];
        const errorOf = () => String(([...seen].reverse().find(m => m.type === 'query.error') as Msg & { message: string } | undefined)?.message ?? '');
        await send({ type: 'query.setCalcSteps', name: 'triple', start: { col: 'vA\nqty' }, steps: [{ fn: 'times', value: 3 }] });
        await send({ type: 'query.setCalcSteps', name: 'more', start: { col: 'calc:triple' }, steps: [{ fn: 'plus', value: 1 }] });
        assert.deepStrictEqual(saved().select, [{ view: 'vA', column: 'sku' }, { view: '', column: 'triple' }, { view: '', column: 'more' }]);
        // Renamed: its place in the columns and `more`'s start follow
        await send({ type: 'query.setCalcSteps', name: 'thrice', was: 'triple', start: { col: 'vA\nqty' }, steps: [{ fn: 'times', value: 3 }] });
        assert.deepStrictEqual(saved().calc?.map(c => [c.name, c.start]), [['thrice', { col: 'vA\nqty' }], ['more', { col: 'calc:thrice' }]]);
        assert.deepStrictEqual(saved().select?.map(c => c.column), ['sku', 'thrice', 'more']);
        // Refused, in words, nothing saved
        const before = JSON.stringify(saved().calc);
        for (const [m, words] of [
            [{ name: '', start: { value: 1 }, steps: [] }, /needs a name/],
            [{ name: 'MORE', start: { value: 1 }, steps: [] }, /already a calculated column called MORE/],
            [{ name: 'p', start: { col: 'vA\nprice' }, steps: [] }, /price isn't in the query/],
            [{ name: 'thrice', was: 'thrice', start: { col: 'calc:more' }, steps: [] }, /can't use itself/]
        ] as [Record<string, unknown>, RegExp][]) {
            await send({ ...m, type: 'query.setCalcSteps' });
            assert.match(errorOf(), words, JSON.stringify(m));
        }
        assert.strictEqual(JSON.stringify(saved().calc), before);
        // The sample: the key, the start, then after each step
        await send({ type: 'query.calcSample', seq: 7, start: { col: 'calc:more' }, steps: [{ fn: 'times', value: 2 }, { fn: 'text' }, { fn: 'jointext', between: ' ', value: 'units' }] });
        const sample = [...seen].reverse().find(m => m.type === 'query.calcSample') as Msg & { seq: number; ok: boolean; rows: unknown[][] };
        assert.strictEqual(sample.ok, true, JSON.stringify(sample));
        assert.deepStrictEqual(sample.rows, [['A', 7, 14, '14', '14 units'], ['B', 16, 32, '32', '32 units']]);
        controller.dispose();
    });
});
