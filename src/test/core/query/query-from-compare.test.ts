// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * An old saved compare as a query (query-from-compare.ts, 2026-11-22): its runs, its key, its compared and shown
 * columns, its sort; Relaxed said once; and the query it makes runs as a compare on the engine.
 */
import * as assert from 'assert';
import type { SavedCompare } from '../../../services/compare/compare-store';
import { queryFromCompare } from '../../../services/query/query-from-compare';

const result = (n: number) => ({ kind: 'result' as const, endpointId: 'ep-inv', view: 'Default', executionId: `run-${n}`, isBatch: n % 2 === 0, environment: 'QA', executedAt: `2026-11-1${n}T00:00:00Z` });

function old(setup: Partial<NonNullable<SavedCompare['setup']>> = {}): SavedCompare {
    return {
        id: 'cmp-1', name: 'Inventory each morning', sources: [result(0), result(1), result(2)], createdAt: '2026-11-10T00:00:00Z',
        setup: { keyColumns: ['sku', 'locationGln'], compareColumns: ['quantityOnHand', 'status', 'note'], relaxedColumns: [], join: 'full', ...setup }
    };
}

describe('An old saved compare as a query', () => {
    it('the Baseline is the first view, the others its runs C1, C2, each in the compare on the whole key', () => {
        const q = queryFromCompare(old(), { name: 'Inventory', method: 'GET', path: '/inventory/v1/items' });
        assert.ok(q.id.startsWith('qry-'));
        assert.strictEqual(q.name, 'Inventory each morning');
        assert.strictEqual(q.fromCompare, 'cmp-1');
        const [bl, c1, c2] = q.sources;
        assert.deepStrictEqual(q.sources.map(s => s.executionId), ['run-0', 'run-1', 'run-2']);
        assert.deepStrictEqual([bl.runOf, c1.runOf, c2.runOf], [undefined, bl.id, bl.id]);
        assert.deepStrictEqual([c1.run, c2.run], ['C1', 'C2']);
        assert.strictEqual(bl.name, 'items');
        assert.deepStrictEqual([c1.name, c2.name], ['items_C1', 'items_C2']);
        assert.deepStrictEqual(q.sources.map(s => [s.endpointName, s.view, s.request, s.isBatch, s.environment]), [
            ['Inventory', 'Default', 'GET /inventory/v1/items', true, 'QA'], ['Inventory', 'Default', 'GET /inventory/v1/items', false, 'QA'], ['Inventory', 'Default', 'GET /inventory/v1/items', true, 'QA']
        ]);
        assert.deepStrictEqual(q.joins.map(j => [j.view, j.kind, j.on.map(p => `${p.left.parts[0].view === bl.id ? 'BL' : '?'}.${p.left.parts[0].column}=${p.right.parts[0].view === j.view ? 'own' : '?'}.${p.right.parts[0].column}`)]), [
            [c1.id, 'compare', ['BL.sku=own.sku', 'BL.locationGln=own.locationGln']],
            [c2.id, 'compare', ['BL.sku=own.sku', 'BL.locationGln=own.locationGln']]
        ]);
        assert.strictEqual(q.notice, undefined);
    });

    it('compared columns in the old order across every run, hidden ones left out; shown columns the Baseline\'s, after them', () => {
        const q = queryFromCompare(old({ columnOrder: ['note', 'quantityOnHand'], hiddenColumns: ['status'], shownColumns: ['createdAt'] }), undefined);
        const bl = q.sources[0].id;
        assert.deepStrictEqual(q.select!.map(c => `${q.sources.findIndex(s => s.id === c.view)}:${c.column}${c.group ? `(${c.group})` : ''}`), [
            '0:note(note)', '1:note(note)', '2:note(note)', '0:quantityOnHand(quantityOnHand)', '1:quantityOnHand(quantityOnHand)', '2:quantityOnHand(quantityOnHand)', '0:createdAt'
        ]);
        assert.strictEqual(q.select!.at(-1)!.view, bl);
    });

    it('its sort comes over by its place among Results\' columns (the key first); a column not shown, no sort', () => {
        const byRun = queryFromCompare(old({ sort: { column: 'quantityOnHand', place: 2, dir: 'desc' } }), undefined);
        // sku, locationGln, then quantityOnHand BL C1 C2: C2's is the 5th (index 4)
        assert.deepStrictEqual(byRun.sort, { column: 4, dir: 'desc' });
        assert.deepStrictEqual(queryFromCompare(old({ sort: { column: 'locationGln', dir: 'asc' } }), undefined).sort, { column: 1, dir: 'asc' });
        assert.strictEqual(queryFromCompare(old({ sort: { column: 'gone', dir: 'asc' } }), undefined).sort, undefined);
    });

    it('Relaxed columns compare exactly now: said once, in its notice', () => {
        const q = queryFromCompare(old({ relaxedColumns: ['note', 'status'] }), undefined);
        assert.strictEqual(q.notice, 'Opened from your old compare. Relaxed matching is gone: note, status are now compared exactly.');
        assert.strictEqual(queryFromCompare(old({ relaxedColumns: ['note'] }), undefined).notice, 'Opened from your old compare. Relaxed matching is gone: note is now compared exactly.');
    });

    it('with no endpoint left, it still converts: named after the compare', () => {
        const q = queryFromCompare({ ...old(), name: undefined }, undefined);
        assert.strictEqual(q.name, 'Endpoint');
        assert.strictEqual(q.sources[0].endpointName, 'Endpoint');
        assert.strictEqual(q.sources.length, 3);
    });
});
