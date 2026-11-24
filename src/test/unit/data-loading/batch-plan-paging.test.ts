// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { planBatch, planRequests, BatchPlanInput } from '../../../data-loading/batch-plan';

/**
 * Review's Requests table pages through a batch (#466/#470): planRequests(input, offset, limit) must give exactly
 * the requests planBatch gives at those places (bodies, row ranges, numbers, URLs), building only those.
 */
const input = (over: Partial<BatchPlanInput> & Pick<BatchPlanInput, 'endpoint' | 'headers' | 'rows'>): BatchPlanInput => ({
    mappings: over.headers.map(h => ({ variable: h, column: h, dataType: 'string' })), reps: 1000, ...over
});

async function samePages(i: BatchPlanInput, pages: Array<[number, number]>) {
    const whole = (await planBatch({ ...i, previewCount: 1_000_000 })).requests;
    for (const [offset, limit] of pages) {
        const page = await planRequests(i, offset, limit);
        expect(page, `${offset}+${limit}`).to.deep.equal(whole.slice(offset, offset + limit));
    }
    return whole;
}

describe('planRequests: a page of a batch\'s requests, as planBatch builds them', () => {
    it('single: one request per row', async () => {
        const rows = Array.from({ length: 23 }, (_, i) => [`g${i}`, String(i)]);
        const whole = await samePages(input({ endpoint: { method: 'POST', path: '/products', body: '{"gtin":"{{gtin}}","price":"{{price:number}}"}' }, headers: ['gtin', 'price'], rows }),
            [[0, 5], [5, 5], [20, 5], [22, 1], [23, 5]]);
        expect(whole).to.have.length(23);
    });

    it('flat: Reps rows per request', async () => {
        const rows = Array.from({ length: 95 }, (_, i) => [`g${i}`, String(i)]);
        await samePages(input({ endpoint: { method: 'POST', path: '/inventory', body: '[{"gtin":"{{gtin}}","qty":"{{qty:number}}"}]' }, headers: ['gtin', 'qty'], rows, reps: 10 }),
            [[0, 3], [3, 3], [8, 5], [9, 1]]);
    });

    it('grouped (Lesson 5): a request per buyer + supplier, sorted, its sequence numbers as sent', async () => {
        const body = JSON.stringify({ poNumber: 'PO-{{A8:sequence}}', buyerGln: '{{location.gln:string}}', supplierGln: '{{product.supplier.gln:string}}',
            lines: [{ gtin: '{{gtin:string}}', lineNumber: '{{A8:sequence:local}}', orderedQty: '{{reorderQty:number}}' }] });
        const headers = ['gtin', 'location.gln', 'product.supplier.gln', 'reorderQty'];
        const rows = Array.from({ length: 70 }, (_, i) => [`000${i}`, '0614141000012', `40123450${String(i % 7).padStart(5, '0')}`, '100']);
        const whole = await samePages(input({ endpoint: { method: 'POST', path: '/purchase-orders', body }, headers, rows }), [[0, 2], [2, 3], [5, 2], [6, 1]]);
        expect(whole).to.have.length(7);
    });

    it('grouped with no sequence: the page built from its own rows only', async () => {
        const body = JSON.stringify({ buyerGln: '{{buyer}}', lines: [{ gtin: '{{gtin}}', qty: '{{qty:number}}' }] });
        const rows = Array.from({ length: 60 }, (_, i) => [`B${i % 9}`, `g${i}`, String(i)]);
        await samePages(input({ endpoint: { method: 'POST', path: '/orders', body }, headers: ['buyer', 'gtin', 'qty'], rows }), [[0, 3], [3, 3], [7, 2], [8, 5]]);
    });

    it('nested-2: Reps orders per request, a root\'s orders split across requests', async () => {
        const body = JSON.stringify({ site: '{{site}}', orders: [{ orderId: '{{orderId}}', items: [{ sku: '{{sku}}' }] }] });
        const rows: string[][] = [];
        for (let s = 0; s < 3; s++) for (let o = 0; o < 7; o++) for (let k = 0; k <= o % 3; k++) rows.push([`S${s}`, `o${s}-${o}`, `sku${k}`]);
        await samePages(input({ endpoint: { method: 'POST', path: '/orders', body }, headers: ['site', 'orderId', 'sku'], rows, reps: 3 }), [[0, 2], [2, 2], [4, 5], [8, 1]]);
    });

    it('query-each and query-repeat: URLs from the offset, with their row ranges', async () => {
        const rows = Array.from({ length: 17 }, (_, i) => [`ITEM${i}`]);
        await samePages(input({ endpoint: { method: 'GET', path: '/items/{{item}}', body: '' }, headers: ['item'], rows }), [[0, 4], [4, 4], [16, 4]]);
        await samePages(input({
            endpoint: { method: 'GET', path: '/items', body: '', queryParams: { query: 'itemId={{item}}[ or ]' } }, headers: ['item'], rows,
            queryParamRepetition: { enabled: true, paramKey: 'query', pattern: 'itemId={{item}}', separator: ' or ', maxUrlLength: 2048, maxPerRequest: 4 }
        }), [[0, 2], [2, 2], [4, 1]]);
    });

    it('the totals are still the whole batch\'s', async () => {
        const rows = Array.from({ length: 40 }, (_, i) => [`g${i}`]);
        const plan = await planBatch({ ...input({ endpoint: { method: 'POST', path: '/p', body: '{"g":"{{g}}"}' }, headers: ['g'], rows }), previewOffset: 30, previewCount: 5 });
        expect(plan.totals).to.deep.equal({ rows: 40, requests: 40 });
        expect(plan.requests.map(r => r.index)).to.deep.equal([31, 32, 33, 34, 35]);
    });
});
