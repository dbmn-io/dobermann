// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's database button (2026-11-22, James: "New Query", "New Compare", "Add to Compare"): this result is
 * saved on a query to add (SavedQuery.adding) and the query opened; Add to Compare's list is the saved compares.
 */
import * as assert from 'assert';
import { ConsoleCompareHandler } from '../../../screens/console/console-compare-handler';
import { createQuery, getQuery, listQueries, saveQuery } from '../../../services/query/query-store';

function store() {
    const data = new Map<string, unknown>();
    return { get: <T>(k: string) => data.get(k) as T, update: async (k: string, v: unknown) => { data.set(k, v); } };
}

function handler(state = store(), executionId = 'run-2') {
    const opened: string[] = [];
    const said: string[] = [];
    const posted: Record<string, unknown>[] = [];
    const runs = ['run-1', 'run-2'].map((id, i) => ({ id, executionType: 'batch', status: 'completed', environment: 'QA', createdAt: `2026-11-2${i}T00:00:00Z` }));
    const h = new ConsoleCompareHandler({
        getSourceRef: () => ({ executionId, endpointId: 'ep-1' }),
        metadata: { getExecutionsByEndpoint: async () => runs } as never,
        state,
        post: async m => { posted.push(m); },
        notify: (_level, m) => { said.push(m); },
        openCompare: async id => { opened.push(id); }
    });
    return { h, state, opened, said, posted };
}

describe('The Console\'s database button', () => {
    it('New Query: a new query, this result to add, opened', async () => {
        const { h, state, opened } = handler();
        await h.handle({ type: 'console.report', payload: { view: 'Items', kind: 'query' } });
        const [q] = listQueries(state);
        assert.deepStrictEqual(opened, [q.id]);
        assert.deepStrictEqual(q.adding, [{ endpointId: 'ep-1', executionId: 'run-2', view: 'Items' }]);
        assert.strictEqual(q.pickRun, undefined);
        assert.strictEqual(q.name, 'New query');
    });

    it('New Compare: named a compare, its other runs offered once it opens', async () => {
        const { h, state, opened } = handler();
        await h.handle({ type: 'console.report', payload: { view: 'Items', kind: 'compare' } });
        const [q] = listQueries(state);
        assert.deepStrictEqual(opened, [q.id]);
        assert.strictEqual(q.name, 'New compare');
        assert.strictEqual(q.pickRun, true);
        assert.strictEqual(q.adding!.length, 1);
    });

    it('Add to Compare: lists the saved compares; the picked one gets this result and opens; one it has already, said', async () => {
        const state = store();
        const plain = await createQuery(state);
        const cmp = await createQuery(state);
        cmp.name = 'Stock each morning';
        cmp.sources = [{ id: 'v1', name: 'Items', endpointId: 'ep-1', endpointName: 'Items', view: 'Items', executionId: 'run-1', isBatch: true, environment: 'QA', executedAt: '' },
            { id: 'v2', name: 'Items_C1', endpointId: 'ep-1', endpointName: 'Items', view: 'Items', executionId: 'run-0', isBatch: true, environment: 'QA', executedAt: '', runOf: 'v1', run: 'C1' }];
        cmp.joins = [{ view: 'v2', kind: 'compare', on: [{ left: { parts: [{ view: 'v1', column: 'sku' }] }, right: { parts: [{ view: 'v2', column: 'sku' }] } }] }];
        await saveQuery(state, cmp);
        const { h, opened, posted } = handler(state);
        await h.handle({ type: 'console.compareViews' });
        assert.deepStrictEqual((posted[0].payload as { compares: unknown[] }).compares, [{ id: cmp.id, name: 'Stock each morning' }]);
        await h.handle({ type: 'console.report', payload: { view: 'Items', kind: 'add', queryId: cmp.id } });
        assert.deepStrictEqual(opened, [cmp.id]);
        assert.deepStrictEqual(getQuery(state, cmp.id)!.adding, [{ endpointId: 'ep-1', executionId: 'run-2', view: 'Items' }]);
        assert.strictEqual(getQuery(state, plain.id)!.adding, undefined);
        // run-1 is in it already: said, opened, nothing added
        const again = handler(state, 'run-1');
        await again.h.handle({ type: 'console.report', payload: { view: 'Items', kind: 'add', queryId: cmp.id } });
        assert.deepStrictEqual(again.said, ['Stock each morning already has this result.']);
        assert.deepStrictEqual(getQuery(state, cmp.id)!.adding!.length, 1);
    });

    it('a run not finished, or an endpoint not saved: said, nothing made', async () => {
        const { h, state, said, opened } = handler(store(), 'run-9');
        await h.handle({ type: 'console.report', payload: { view: 'Items', kind: 'query' } });
        assert.deepStrictEqual(said, ['This result can go in a query once its run has finished.']);
        assert.deepStrictEqual(listQueries(state), []);
        assert.deepStrictEqual(opened, []);
    });
});
