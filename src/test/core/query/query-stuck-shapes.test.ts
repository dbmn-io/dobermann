// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * No saved query opens stuck (2026-11-22, from James: "if we get a query that's stuck, how do we support people"). Each
 * shape a query can be saved in, by an older build, a removal or a move, opens with no error and can be edited: a join
 * picked takes, and Results has rows. repairQuery (query-store.ts) makes it whole as it opens and after every change.
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import { repairQuery, type SavedQuery } from '../../../services/query/query-store';
import { queryFromCompare } from '../../../services/query/query-from-compare';
import type { SavedCompare } from '../../../services/compare/compare-store';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

type Msg = Record<string, unknown> & { type: string };
type State = Msg & { error: string; total: number; views: { id: string; error: string; waiting: boolean }[]; joins: { view: string; kind: string; on: { left?: { view: string; column: string }; right?: { view: string; column: string } }[] }[]; compare: { baseline: string; views: string[] } | null };

const rows = (n: number, qty: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, qty: qty(i) }));
const FILES: Record<string, { columns: string[]; rows: Record<string, unknown>[] } | undefined> = {
    vA: { columns: ['sku', 'qty'], rows: rows(10, i => i) },
    vB: { columns: ['sku', 'qty'], rows: rows(10, i => (i === 2 ? 50 : i)) },
    vC: { columns: ['sku', 'qty'], rows: rows(8, i => i) },
    vX: { columns: ['sku', 'bin'], rows: Array.from({ length: 10 }, (_, i) => ({ sku: `S${i}`, bin: `B${i}` })) }
};

const src = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.slice(1), endpointId: '', endpointName: 'stock.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-22T00:00:00Z', file: { name: 'stock.xlsx', sheet: id }, ...extra });
const pair = (left: string, right: string, column = 'sku') => ({ left: { parts: [{ view: left, column }] }, right: { parts: [{ view: right, column }] } });
const query = (sources: unknown[], joins: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'qry-stuck', name: 'Stuck', sources, joins, reached: 4, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z', ...extra }) as unknown as SavedQuery;

async function open(initial: SavedQuery) {
    const store = new Map<string, unknown>([['queries', [initial]]]);
    const seen: Msg[] = [];
    const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
    const ports = {
        metadata: { getUnifiedExecutionHistory: async () => [], getExecution: async (id: string) => ({ id, executionType: 'individual', status: 'completed', environment: 'TEST', startedAt: '2026-11-23T00:00:00Z' }), getBatchExecution: async () => undefined },
        environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
        endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
        state: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } },
        toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } },
        logger: { log() { /* */ }, error() { /* */ } },
        host: { close() { /* */ }, openConsole: async () => { /* */ } },
        sql: () => initSqlJs({ locateFile: () => SQL_WASM_PATH }),
        newCompareEngine: () => true,
        queryFiles: { read: async (_q: string, view: string) => FILES[view], save: async () => { /* */ }, remove: async () => { /* */ } }
    };
    const controller = new QueryController(session, ports as never, { queryId: initial.id });
    await controller.handleMessage({ type: 'query.ready' } as never);
    const state = () => [...seen].reverse().find(m => m.type === 'query.state') as State;
    const send = (m: Msg) => controller.handleMessage(m as never);
    const saved = () => (store.get('queries') as SavedQuery[])[0];
    return { send, state, saved, dispose: () => controller.dispose() };
}

/** Opened with no error, every view after the first with one join; and a join picked on sku takes: rows come out. */
async function editable(q: Awaited<ReturnType<typeof open>>, what: string): Promise<void> {
    assert.strictEqual(q.state().error, '', `${what}: opens with no error`);
    const s = q.saved();
    assert.deepStrictEqual(s.joins.map(j => j.view), s.sources.slice(1).map(v => v.id), `${what}: a join per view after the first, in order`);
    // (each join with no column yet, as the user would: its kind kept, sku picked on the first view and on it)
    for (const j of s.joins.filter(x => !x.on.length || x.on.every(p => !p.left.parts.some(c => c.column)))) {
        await q.send({ type: 'query.setJoin', view: j.view, kind: j.kind, on: [{ left: { view: s.sources[0].id, column: 'sku' }, right: { column: 'sku' } }] });
    }
    assert.strictEqual(q.state().error, '', `${what}: joined, no error`);
    assert.ok(q.state().total > 0, `${what}: Results has rows`);
    assert.ok(q.state().views.every(v => !v.waiting || v.error), `${what}: no view left waiting`);
}

describe('Query: no saved shape opens stuck (repairQuery)', function () {
    this.timeout(20000);

    it('a view with no join at all gets one, empty ("Pick a column"), and can be joined', async () => {
        const q = await open(query([src('vA'), src('vX')], []));
        await editable(q, 'no join');
        q.dispose();
    });

    it('a join for the first view, one for a view no longer there, and one said twice: gone', async () => {
        const q = await open(query([src('vA'), src('vX')], [
            { view: 'vA', kind: 'left', on: [] },
            { view: 'vGone', kind: 'left', on: [pair('vA', 'vGone')] },
            { view: 'vX', kind: 'left', on: [pair('vA', 'vX')] },
            { view: 'vX', kind: 'inner', on: [] }
        ]));
        assert.deepStrictEqual(q.saved().joins.map(j => [j.view, j.kind, j.on.length]), [['vX', 'left', 1]]);
        await editable(q, 'stray joins');
        q.dispose();
    });

    it('a pair to a view no longer there goes; the join asks for its columns again', async () => {
        const q = await open(query([src('vA'), src('vX')], [{ view: 'vX', kind: 'left', on: [pair('vGone', 'vX')] }]));
        assert.deepStrictEqual(q.saved().joins[0].on, []);
        await editable(q, 'pair to a removed view');
        q.dispose();
    });

    it('a run whose first run is no longer there is a view of its own', async () => {
        const q = await open(query([src('vA'), src('vB', { runOf: 'vGone', run: 'C1' })], [{ view: 'vB', kind: 'compare', on: [pair('vGone', 'vB')] }]));
        assert.strictEqual(q.saved().sources[1].runOf, undefined);
        await editable(q, 'orphan run');
        q.dispose();
    });

    it('a compare saved after another view opens with the compare first, that view joined to it', async () => {
        const q = await open(query([src('vX'), src('vA'), src('vB', { runOf: 'vA', run: 'C1' })], [
            { view: 'vA', kind: 'left', on: [] },
            { view: 'vB', kind: 'compare', on: [pair('vA', 'vB')] }
        ]));
        assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vA', 'vB', 'vX']);
        assert.strictEqual(q.state().compare?.baseline, 'vA');
        await editable(q, 'compare not first');
        q.dispose();
    });

    it('a compare with its key emptied opens, and the key can be picked again', async () => {
        const q = await open(query([src('vA'), src('vB', { runOf: 'vA', run: 'C1' })], [{ view: 'vB', kind: 'compare', on: [] }]));
        assert.strictEqual(q.state().error, '');
        await q.send({ type: 'query.setJoin', view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { column: 'sku' } }] });
        assert.strictEqual(q.state().error, '');
        assert.strictEqual(q.state().total, 10);
        q.dispose();
    });

    it('a view whose result is gone says so on its slot; the rest still work, and taking it out clears it', async () => {
        const q = await open(query([src('vA'), src('vX'), src('vGone')], [{ view: 'vX', kind: 'left', on: [pair('vA', 'vX')] }, { view: 'vGone', kind: 'left', on: [pair('vA', 'vGone')] }]));
        assert.ok(q.state().views.find(v => v.id === 'vGone')?.error, 'the missing result is said on its view');
        assert.strictEqual(q.state().total, 10);
        await q.send({ type: 'query.removeView', id: 'vGone' });
        assert.strictEqual(q.state().error, '');
        assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vA', 'vX']);
        q.dispose();
    });

    it('the compare\'s Baseline taken out: the next run is the Baseline, the compare keeps its key', async () => {
        const q = await open(query([src('vA'), src('vB', { runOf: 'vA', run: 'C1' }), src('vC', { runOf: 'vA', run: 'C2' })], [
            { view: 'vB', kind: 'compare', on: [pair('vA', 'vB')] },
            { view: 'vC', kind: 'compare', on: [pair('vA', 'vC')] }
        ]));
        await q.send({ type: 'query.removeView', id: 'vA' });
        assert.strictEqual(q.state().error, '');
        assert.deepStrictEqual(q.saved().sources.map(s => s.id), ['vB', 'vC']);
        assert.strictEqual(q.state().compare?.baseline, 'vB');
        assert.deepStrictEqual(q.saved().joins.map(j => [j.view, j.kind, j.on.map(p => `${p.left.parts[0].view}.${p.left.parts[0].column}=${p.right.parts[0].column}`).join()]), [['vC', 'compare', 'vB.sku=sku']]);
        assert.ok(q.state().total > 0);
        q.dispose();
    });

    it('the first view taken out of a plain query: the next is first, with no join of its own left over', async () => {
        const q = await open(query([src('vA'), src('vX'), src('vB')], [{ view: 'vX', kind: 'left', on: [pair('vA', 'vX')] }, { view: 'vB', kind: 'left', on: [pair('vX', 'vB')] }]));
        await q.send({ type: 'query.removeView', id: 'vA' });
        assert.deepStrictEqual(q.saved().joins.map(j => j.view), ['vB']);
        assert.strictEqual(q.state().error, '');
        assert.ok(q.state().total > 0);
        q.dispose();
    });

    it('a hidden first view, and a report column of a view no longer there', async () => {
        const q = await open(query([src('vA', { off: true }), src('vX')], [{ view: 'vX', kind: 'left', on: [pair('vA', 'vX')] }], { select: [{ view: 'vGone', column: 'sku' }, { view: 'vX', column: 'bin' }] }));
        assert.deepStrictEqual(q.saved().select, [{ view: 'vX', column: 'bin' }]);
        assert.strictEqual(q.state().error, '');
        await q.send({ type: 'query.toggleView', id: 'vA' });
        assert.strictEqual(q.state().error, '');
        assert.ok(q.state().total > 0);
        q.dispose();
    });

    it('repairQuery leaves a whole query as it is', () => {
        const whole = query([src('vA'), src('vX')], [{ view: 'vX', kind: 'left', on: [pair('vA', 'vX')] }]);
        assert.strictEqual(repairQuery(whole), false);
    });
});

describe('Query: Reset joins', function () {
    this.timeout(20000);
    it('every join back to "Pick a column", each keeping its kind; a compare stays one on its Baseline; the views and columns stay', async () => {
        const q = await open(query([src('vA'), src('vB', { runOf: 'vA', run: 'C1' }), src('vX')], [
            { view: 'vB', kind: 'compare', on: [pair('vA', 'vB')] },
            { view: 'vX', kind: 'inner', on: [pair('vA', 'vX')] }
        ], { select: [{ view: 'vA', column: 'sku' }, { view: 'vX', column: 'bin' }] }));
        await q.send({ type: 'query.resetJoins' });
        const s = q.saved();
        assert.deepStrictEqual(s.sources.map(v => v.id), ['vA', 'vB', 'vX']);
        assert.deepStrictEqual(s.joins.map(j => [j.view, j.kind, j.on.map(p => `${p.left.parts[0].view}.${p.left.parts[0].column}=${p.right.parts[0].column}`).join()]), [['vB', 'compare', 'vA.='], ['vX', 'inner', '']]);
        assert.deepStrictEqual(s.select, [{ view: 'vA', column: 'sku' }, { view: 'vX', column: 'bin' }]);
        assert.strictEqual(q.state().compare?.baseline, 'vA');
        // and joined again from there
        await q.send({ type: 'query.setJoin', view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { column: 'sku' } }] });
        await q.send({ type: 'query.setJoin', view: 'vX', kind: 'inner', on: [{ left: { view: 'vA', column: 'sku' }, right: { column: 'sku' } }] });
        assert.strictEqual(q.state().error, '');
        assert.ok(q.state().total > 0);
        q.dispose();
    });
});

describe('Query: Copy the query and Import a query (for support)', function () {
    it('a copy holds what the query is made of: no id, no counts, no rows; imported, it is a new query that opens', async () => {
        const { queryForSupport, importQueryCopy, listQueries } = await import('../../../services/query/query-store');
        const saved = query([src('vA'), src('vX')], [{ view: 'vX', kind: 'left', on: [pair('vA', 'vX')] }], { select: [{ view: 'vX', column: 'bin' }], search: '@bin=B1', rows: 10, found: { diff: 1, missing: 0 }, notice: 'x' });
        const copy = queryForSupport(saved);
        assert.strictEqual(copy.kind, 'dbmn.query');
        assert.strictEqual(copy.version, 1);
        const text = JSON.stringify(copy);
        for (const gone of ['"id":"qry-stuck"', '"rows":', '"found":', '"notice":']) assert.ok(!text.includes(gone), `${gone} left out`);
        assert.deepStrictEqual(copy.query.sources?.map(s => s.id), ['vA', 'vX']);
        // Imported into another app's store: a new id, a free name, the same views and joins
        const store = new Map<string, unknown>([['queries', [{ ...saved, name: 'Stuck' }]]]);
        const state = { get: <T>(k: string) => store.get(k) as T, update: async (k: string, v: unknown) => { store.set(k, v); } };
        const made = await importQueryCopy(state as never, text);
        assert.ok(made.query, made.problem);
        assert.notStrictEqual(made.query!.id, 'qry-stuck');
        assert.notStrictEqual(made.query!.name, 'Stuck', 'a name the store already has is not reused');
        assert.deepStrictEqual(made.query!.joins, saved.joins);
        assert.strictEqual(listQueries(state as never).length, 2);
        // and it opens, editable
        const q = await open(made.query!);
        assert.strictEqual(q.state().error, '');
        assert.strictEqual(q.state().total, 10);
        q.dispose();
    });
    it('text that is not a copied query is refused, in words, and nothing is saved', async () => {
        const { importQueryCopy } = await import('../../../services/query/query-store');
        const store = new Map<string, unknown>();
        const state = { get: <T>(k: string) => store.get(k) as T, update: async (k: string, v: unknown) => { store.set(k, v); } };
        for (const text of ['', 'hello', '{"kind":"dbmn.endpoint"}', '{"kind":"dbmn.query","query":{}}']) {
            const made = await importQueryCopy(state as never, text);
            assert.ok(!made.query && made.problem, text);
        }
        assert.match((await importQueryCopy(state as never, '{"kind":"dbmn.query","version":2,"query":{"sources":[],"joins":[]}}')).problem ?? '', /newer DBMN/);
        assert.strictEqual(store.get('queries'), undefined);
    });
});

describe('Query: round 3 (2026-11-23)', function () {
    this.timeout(20000);

    it('a query that becomes a compare again (+ run) keeps the key its joins are on, not "Pick a column"', async () => {
        // Stock (a run of an endpoint) joined to two files on sku; no compare. + run on Stock: a compare of Stock's runs, on sku
        const stock = src('vS', { file: undefined, endpointId: 'ep-stock', executionId: 'run-1', view: 'Default' });
        const q = await open(query([stock, src('vA'), src('vB')], [{ view: 'vA', kind: 'left', on: [pair('vS', 'vA')] }, { view: 'vB', kind: 'left', on: [pair('vS', 'vB')] }]));
        await q.send({ type: 'query.addRun', of: 'vS', executionId: 'run-2' });
        const run = q.saved().sources.find(x => x.runOf === 'vS');
        assert.ok(run, 'the run is in');
        const joins = q.saved().joins.filter(j => j.view === run!.id);
        assert.strictEqual(joins.length, 1, 'one join for the run');
        assert.strictEqual(joins[0].kind, 'compare');
        assert.deepStrictEqual(joins[0].on.map(p => [p.left.parts.map(c => c.column), p.right.parts.map(c => c.column)]), [[['sku'], ['sku']]], 'the compare is on sku, both sides');
        q.dispose();
    });

    it('an old saved compare opened as a query: its compared columns are compared across BL and C1, none unticked', async () => {
        const compare = {
            id: 'cmp-old', name: 'Old stock compare', createdAt: '2026-11-10T00:00:00Z',
            sources: ['run-1', 'run-2'].map(executionId => ({ endpointId: 'ep-stock', view: 'Default', executionId, isBatch: false, environment: 'TEST', executedAt: '2026-11-10T00:00:00Z' })),
            setup: { keyColumns: ['sku'], compareColumns: ['qty'], relaxedColumns: [], join: 'full' }
        } as unknown as SavedCompare;
        const made = queryFromCompare(compare, { name: 'stock' });
        // (read from files in this test: the BL and C1 rows of vA and vB)
        made.sources.forEach((x, i) => { (x as unknown as { file: unknown }).file = { name: 'stock.xlsx', sheet: i ? 'vB' : 'vA' }; FILES[x.id] = FILES[i ? 'vB' : 'vA']; });
        const q = await open(made);
        const columns = (q.state() as unknown as { columns: { view: string; column: string; group?: string }[] }).columns;
        const qty = columns.filter(c => c.column === 'qty');
        assert.deepStrictEqual(qty.map(c => c.view), made.sources.map(x => x.id), 'qty from BL and from C1');
        assert.ok(qty.every(c => c.group === 'qty'), 'one compared column');
        assert.deepStrictEqual(q.saved().select?.filter(c => c.column === 'qty').length, 2, 'still both, saved');
        q.dispose();
    });
});
