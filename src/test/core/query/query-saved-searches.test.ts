// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Saved searches on Query's Results (James, 2026-11-23, public issue 16; the mock's recommendations): a search kept under
 * a name, with the query (its file in the workspace folder), so Duplicate, Copy the query and Import a query keep them.
 * A saved search is the search box's text only. The ★ drop-down is the design system's (dbmn-saved-searches.js); here,
 * what is kept and how it travels.
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import { cleanSearches, duplicateQuery, importQueryCopy, queryForSupport, type SavedQuery } from '../../../services/query/query-store';

type Msg = Record<string, unknown> & { type: string };
const memory = () => { const m = new Map<string, unknown>(); return { get: <T>(k: string) => m.get(k) as T, update: async (k: string, v: unknown) => { m.set(k, v); } }; };
const QUERY = (searches?: unknown) => ({
    id: 'qry-s', name: 'Stock', reached: 4, createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z',
    sources: [{ id: 'vA', name: 'Stock', endpointId: '', endpointName: 'stock.csv', view: '', executionId: '', isBatch: false, environment: '', executedAt: '', file: { name: 'stock.csv' } }],
    joins: [], ...(searches ? { searches } : {})
}) as unknown as SavedQuery;

describe('Query: saved searches', function () {
    this.timeout(20000);

    it('kept clean: trimmed; a search with no name or no text left out; a name up to 30 characters; each name once (any case, the first kept); up to 50', () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ name: `s${i}`, text: `@qty>${i}` }));
        assert.deepStrictEqual(cleanSearches([
            { name: '  Low stock ', text: ' @qty<5 ' },
            { name: '', text: '@qty>0' },
            { name: 'Nothing', text: '   ' },
            { name: 'low STOCK', text: '@qty<2' },
            { name: 'x'.repeat(40), text: 'sydney' },
            'not a search', null
        ]), [{ name: 'Low stock', text: '@qty<5' }, { name: 'x'.repeat(30), text: 'sydney' }]);
        assert.strictEqual(cleanSearches(many).length, 50);
        assert.deepStrictEqual(cleanSearches(undefined), []);
    });

    it('Results: the list saved with the query and given back (query.searches; every state carries it too), with no run again', async () => {
        const state = memory();
        await state.update('queries', [QUERY()]);
        const seen: Msg[] = [];
        const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
        const ports = {
            metadata: { getUnifiedExecutionHistory: async () => [] },
            environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
            endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
            state, toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } }, logger: { log() { /* */ }, error() { /* */ } },
            host: { close() { /* */ }, openConsole: async () => { /* */ } },
            queryFiles: { read: async () => ({ columns: ['sku', 'qty'], rows: [{ sku: 'A', qty: 1 }] }), save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: 'qry-s', start: 'results' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        const before = seen.filter(m => m.type === 'query.counting' || m.type === 'query.rowsData').length;
        await controller.handleMessage({ type: 'query.saveSearches', searches: [{ name: 'Low stock', text: '@qty<5' }, { name: ' ', text: 'x' }] } as never);
        const opened = seen.find(m => m.type === 'query.state') as Msg & { searches: unknown };
        assert.deepStrictEqual(opened.searches, [], 'none yet, said as an empty list');
        const back = [...seen].reverse().find(m => m.type === 'query.searches') as Msg & { searches: unknown };
        assert.deepStrictEqual(back.searches, [{ name: 'Low stock', text: '@qty<5' }]);
        assert.deepStrictEqual((state.get<SavedQuery[]>('queries') ?? [])[0].searches, [{ name: 'Low stock', text: '@qty<5' }]);
        assert.strictEqual(seen.filter(m => m.type === 'query.counting' || m.type === 'query.rowsData').length, before, 'nothing ran again');
        controller.dispose();
    });

    it('Add a view\'s picker: its saved searches kept once for every query (not with one), given back with the state', async () => {
        // (James, 2026-11-23: "everywhere where we have a search box"; the picker's table shows the ★, the design system's)
        const state = memory();
        await state.update('queries', [QUERY()]);
        const seen: Msg[] = [];
        const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
        const ports = {
            metadata: { getUnifiedExecutionHistory: async () => [] },
            environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
            endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
            state, toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } }, logger: { log() { /* */ }, error() { /* */ } },
            host: { close() { /* */ }, openConsole: async () => { /* */ } },
            queryFiles: { read: async () => ({ columns: ['sku', 'qty'], rows: [{ sku: 'A', qty: 1 }] }), save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: 'qry-s' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        assert.deepStrictEqual((seen.find(m => m.type === 'query.state') as Msg & { addViewSearches: unknown }).addViewSearches, []);
        await controller.handleMessage({ type: 'query.saveAddViewSearches', searches: [{ name: 'Prod GETs', text: '@env=prod @method=get' }, { name: '', text: 'x' }] } as never);
        assert.deepStrictEqual(([...seen].reverse().find(m => m.type === 'query.addViewSearches') as Msg & { searches: unknown }).searches, [{ name: 'Prod GETs', text: '@env=prod @method=get' }]);
        assert.deepStrictEqual(state.get('query.addView.savedSearches'), [{ name: 'Prod GETs', text: '@env=prod @method=get' }]);
        // (not on the query: another query's picker has them too)
        assert.strictEqual((state.get<SavedQuery[]>('queries') ?? [])[0].searches, undefined);
        controller.dispose();
    });

    it('a query with none says so: an empty list in its state', async () => {
        assert.deepStrictEqual(cleanSearches(QUERY().searches), []);
    });

    it('they travel: Copy the query keeps them, Import a query cleans and keeps them, Duplicate keeps them', async () => {
        const searches = [{ name: 'Low stock', text: '@qty<5' }, { name: 'Sydney', text: '@city=Sydney' }];
        const copy = queryForSupport(QUERY(searches));
        assert.deepStrictEqual(copy.query.searches, searches);
        const state = memory();
        const pasted = JSON.parse(JSON.stringify(copy));
        pasted.query.searches.push({ name: 'low stock', text: 'again' }, { name: '', text: 'none' });
        const { query } = await importQueryCopy(state, JSON.stringify(pasted));
        assert.deepStrictEqual(query?.searches, searches);
        const twin = await duplicateQuery(state, query!.id);
        assert.deepStrictEqual(twin?.searches, searches);
    });
});
