// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A View a query reads is locked (src/services/query/query-view-lock.ts): columns can be added,
 * none removed, and its row basis and name stay.
 *   npm run test:core
 */
import * as assert from 'assert';
import { keepLockedViews, viewsInQueries } from '../../../services/query/query-view-lock';

const column = (id: string) => ({ id: `data.items.${id}`, source: 'current' });
const view = (name: string, columns: string[], rowBasis = 'data.items') => ({ name, rowBasis, columns: columns.map(column) });
const settings = (...views: unknown[]) => ({ success: { activeView: 'Stock', views }, errors: { activeView: '', views: [] } });
const names = (s: unknown) => (s as { success: { views: { name: string; columns: { id: string }[] }[] } }).success.views;

describe('Query: a View a query reads is locked', () => {
    const stored = settings(view('Stock', ['sku', 'qty']), view('Other', ['sku']));

    it('lets columns be added', () => {
        const incoming = settings(view('Stock', ['sku', 'qty', 'lot']), view('Other', ['sku']));
        const kept = keepLockedViews(stored, incoming, ['Stock']);
        assert.deepStrictEqual(kept.reverted, []);
        assert.strictEqual(kept.settings, incoming);
    });

    it('puts back a View that lost a column', () => {
        const kept = keepLockedViews(stored, settings(view('Stock', ['sku']), view('Other', ['sku'])), ['Stock']);
        assert.deepStrictEqual(kept.reverted, ['Stock']);
        assert.deepStrictEqual(names(kept.settings)[0].columns.map(c => c.id), ['data.items.sku', 'data.items.qty']);
    });

    it('puts back a View whose row basis changed', () => {
        const kept = keepLockedViews(stored, settings(view('Stock', ['sku', 'qty'], 'data'), view('Other', ['sku'])), ['Stock']);
        assert.deepStrictEqual(kept.reverted, ['Stock']);
    });

    it('puts back a View that was renamed or deleted, beside the new one', () => {
        const kept = keepLockedViews(stored, settings(view('Stock 2', ['sku', 'qty']), view('Other', ['sku'])), ['Stock']);
        assert.deepStrictEqual(kept.reverted, ['Stock']);
        assert.deepStrictEqual(names(kept.settings).map(v => v.name), ['Stock 2', 'Other', 'Stock']);
    });

    it('leaves a View no query reads alone', () => {
        const incoming = settings(view('Stock', ['sku', 'qty']));
        assert.deepStrictEqual(keepLockedViews(stored, incoming, ['Stock']).reverted, []);
        assert.deepStrictEqual(names(keepLockedViews(stored, incoming, ['Stock']).settings).map(v => v.name), ['Stock']);
    });

    it('finds the Views queries read by request, whichever endpoint sent it', () => {
        const source = (endpointId: string, viewName: string, request?: string) => ({ id: endpointId + viewName, name: viewName, endpointId, endpointName: 'E', view: viewName, request, executionId: 'x', isBatch: false, environment: 'DEV', executedAt: '' });
        const state = { get: () => [
            { id: 'qry-1', name: 'One', sources: [source('a', 'Stock', 'GET /stock'), source('b', 'Stock', 'GET /stock'), source('c', 'Lines', 'GET /lines')], joins: [] },
            { id: 'qry-2', name: 'Two', sources: [source('z', 'Stock', 'GET /stock'), source('old', 'Legacy')], joins: [] }
        ], update: async () => undefined } as never;
        assert.deepStrictEqual(viewsInQueries(state, { endpointId: 'other', request: 'GET /stock' }), { Stock: 2 });
        assert.deepStrictEqual(viewsInQueries(state, { endpointId: 'old', request: 'GET /legacy' }), { Legacy: 1 });
    });
});
