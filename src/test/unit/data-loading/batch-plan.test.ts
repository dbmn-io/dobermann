// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { planBatch, BatchPlanInput } from '../../../data-loading/batch-plan';

// Run Batch Step 4 (#308): one plan per template shape — what is sent, how rows group, how many.
const run = (over: Partial<BatchPlanInput> & Pick<BatchPlanInput, 'endpoint' | 'headers' | 'rows'>) => planBatch({
    mappings: over.headers.map(h => ({ variable: h, column: h, dataType: 'string' })), reps: 1000, ...over
});
const roles = (plan: Awaited<ReturnType<typeof planBatch>>) => Object.fromEntries(plan.variables.map(v => [v.name, v.level ? `${v.role}:${v.level}` : v.role]));

describe('planBatch', () => {
    it('single: no array, one request per row', async () => {
        const plan = await run({ endpoint: { method: 'POST', path: '/products', body: '{"gtin":"{{gtin}}","price":"{{price:number}}"}' },
            headers: ['gtin', 'price'], rows: [['a', '1'], ['b', '2'], ['c', '3']] });
        expect(plan.shape).to.equal('single');
        expect(plan.totals).to.deep.equal({ rows: 3, requests: 3 });
        expect(plan.requests.map(r => r.body)).to.deep.equal([{ gtin: 'a', price: 1 }, { gtin: 'b', price: 2 }, { gtin: 'c', price: 3 }]);
        expect(plan.reps.applies).to.equal(false);
        expect(roles(plan)).to.deep.equal({ gtin: 'row', price: 'row' });
    });

    it('flat: a top-level array, Reps rows per request', async () => {
        const rows = Array.from({ length: 25 }, (_, i) => [`g${i}`, String(i)]);
        const plan = await run({ endpoint: { method: 'POST', path: '/inventory', body: '[{"gtin":"{{gtin}}","qty":"{{qty:number}}"}]' },
            headers: ['gtin', 'qty'], rows, reps: 10 });
        expect(plan.shape).to.equal('flat');
        expect(plan.arrayPath).to.equal('$root');
        expect(plan.totals).to.deep.equal({ rows: 25, requests: 3 });
        expect(plan.reps).to.deep.equal({ applies: true, label: 'Rows per request', value: 10 });
        expect(plan.requests.map(r => r.rowCount)).to.deep.equal([10, 10, 5]);
        expect((plan.requests[2].body as unknown[])[0]).to.deep.equal({ gtin: 'g20', qty: 20 });
        expect(plan.requests[2].rowRange).to.deep.equal({ start: 21, end: 25 });
    });

    it('a value beside the array is a header: it splits requests (grouped), it is not taken from a first row', async () => {
        const plan = await run({ endpoint: { method: 'POST', path: '/orders', body: '{"warehouse":"{{site}}","items":[{"sku":"{{sku}}"}]}' },
            headers: ['site', 'sku'], rows: [['A', '1'], ['B', '2']], reps: 10 });
        expect(plan.shape).to.equal('grouped');
        expect(plan.totals.requests).to.equal(2);
    });

    it('grouped (Puppy School Lesson 5): a request per buyer + supplier, rows nest into lines', async () => {
        const body = JSON.stringify({ poNumber: 'PO-{{A8:sequence}}', buyerGln: '{{location.gln:string}}', supplierGln: '{{product.supplier.gln:string}}',
            lines: [{ gtin: '{{gtin:string}}', lineNumber: '{{A8:sequence:local}}', orderedQty: '{{reorderQty:number}}' }] });
        const headers = ['gtin', 'location.gln', 'product.supplier.gln', 'reorderQty'];
        const s = ['4012345000054', '4012345000030', '4012345000047'];
        const rows = Array.from({ length: 30 }, (_, i) => [`000${i}`, '0614141000012', s[i % 3], '100']);
        const plan = await run({ endpoint: { method: 'POST', path: '/purchase-orders', body }, headers, rows });
        expect(plan.shape).to.equal('grouped');
        expect(plan.arrayPath).to.equal('lines');
        expect(plan.totals).to.deep.equal({ rows: 30, requests: 3 });
        expect(plan.reps.applies).to.equal(false);
        expect(roles(plan)).to.deep.equal({
            'A8:sequence': 'generated', 'location.gln': 'request', 'product.supplier.gln': 'request',
            gtin: 'item:lines', 'A8:sequence:local': 'generated', reorderQty: 'item:lines'
        });
        expect(plan.levels).to.deep.equal([{ name: 'request', keyedBy: ['location.gln', 'product.supplier.gln'] }, { name: 'lines', keyedBy: [] }]);
        // Sorted by the header, as the generator sends them.
        expect(plan.requests.map(r => r.key[1].value)).to.deep.equal(['4012345000030', '4012345000047', '4012345000054']);
        expect(plan.requests.every(r => r.rowCount === 10 && (r.body as { lines: unknown[] }).lines.length === 10)).to.equal(true);
        expect(plan.groups?.columns).to.deep.equal(['location.gln', 'product.supplier.gln']);
        expect(plan.groups?.rows.map(g => [g.values[1], g.rowCount, g.request])).to.deep.equal([['4012345000030', 10, 1], ['4012345000047', 10, 2], ['4012345000054', 10, 3]]);
        expect(plan.requests[0].url).to.equal('/purchase-orders');
    });

    it('nested-2: orders[].items[], Reps orders per request', async () => {
        const body = JSON.stringify({ orders: [{ orderId: '{{orderId}}', items: [{ sku: '{{sku}}' }] }] });
        const rows = [['o1', 'a'], ['o1', 'b'], ['o2', 'c'], ['o3', 'd'], ['o3', 'e'], ['o4', 'f'], ['o5', 'g']];
        const plan = await run({ endpoint: { method: 'POST', path: '/orders', body }, headers: ['orderId', 'sku'], rows, reps: 2 });
        expect(plan.shape).to.equal('nested-2');
        expect(plan.reps).to.deep.equal({ applies: true, label: 'orders per request', value: 2 });
        expect(plan.totals).to.deep.equal({ rows: 7, requests: 3 });
        expect(roles(plan)).to.deep.equal({ orderId: 'group:orders', sku: 'item:items' });
        expect((plan.requests[0].body as { orders: unknown[] }).orders).to.have.length(2);
        expect(plan.groups?.rows.map(g => [g.values[0], g.rowCount, g.request])).to.deep.equal([['o1', 2, 1], ['o2', 1, 1], ['o3', 2, 2], ['o4', 1, 2], ['o5', 1, 3]]);
    });

    it('nested-3: shipments[].packages[].items[]', async () => {
        const body = JSON.stringify({ shipments: [{ shipmentId: '{{shipmentId}}', packages: [{ sscc: '{{sscc}}', items: [{ gtin: '{{gtin}}' }] }] }] });
        const rows = [['s1', 'p1', 'a'], ['s1', 'p1', 'b'], ['s1', 'p2', 'c'], ['s2', 'p3', 'd']];
        const plan = await run({ endpoint: { method: 'POST', path: '/shipments', body }, headers: ['shipmentId', 'sscc', 'gtin'], rows, reps: 10 });
        expect(plan.shape).to.equal('nested-3');
        expect(roles(plan)).to.deep.equal({ shipmentId: 'group:shipments', sscc: 'group:packages', gtin: 'item:items' });
        expect(plan.totals.requests).to.equal(1);
        expect(plan.levels.map(l => l.name)).to.deep.equal(['request', 'shipments', 'packages', 'items']);
    });

    it('query-repeat: many rows packed into one URL parameter', async () => {
        const rows = Array.from({ length: 6 }, (_, i) => [`ITEM${i}`]);
        const plan = await run({
            endpoint: { method: 'GET', path: '/items', body: '', queryParams: { query: 'itemId={{item}}[ or ]', size: '100' } },
            headers: ['item'], rows,
            queryParamRepetition: { enabled: true, paramKey: 'query', pattern: 'itemId={{item}}', separator: ' or ', maxUrlLength: 2048, maxPerRequest: 4 }
        });
        expect(plan.shape).to.equal('query-repeat');
        expect(plan.totals).to.deep.equal({ rows: 6, requests: 2 });
        expect(plan.requests[0].queryParams.query).to.equal('itemId=ITEM0 or itemId=ITEM1 or itemId=ITEM2 or itemId=ITEM3');
        expect(plan.requests[0].url).to.match(/^\/items\?query=itemId%3DITEM0%20or/);
        expect(plan.requests[0].body).to.equal(null);
        expect(plan.requests[1].rowRange).to.deep.equal({ start: 5, end: 6 });
    });

    it('query-each: {{ENV:region}} in the path or a query parameter is the environment\'s value, the same for every row', async () => {
        const plan = await run({ endpoint: { method: 'GET', path: '/{{ENV:region}}/items/{{item}}', body: '', queryParams: { tenant: '{{ENV:tenant}}' } },
            headers: ['item'], rows: [['A'], ['B']], baseUrl: 'https://api.example.com', environmentVariables: { region: 'en', tenant: 'acme' } });
        expect(plan.shape).to.equal('query-each');
        expect(plan.requests.map(r => r.url)).to.deep.equal(['https://api.example.com/en/items/A?tenant=acme', 'https://api.example.com/en/items/B?tenant=acme']);
        expect(roles(plan).item).to.equal('url');
    });

    it('query-each: no body, a URL per row', async () => {
        const plan = await run({ endpoint: { method: 'GET', path: '/items/{{item}}', body: '{}', queryParams: { site: '{{site}}' } },
            headers: ['item', 'site'], rows: [['A', 'X'], ['B', 'Y']], baseUrl: 'https://api.example.com/' });
        expect(plan.shape).to.equal('query-each');
        expect(plan.totals.requests).to.equal(2);
        expect(plan.requests.map(r => r.url)).to.deep.equal(['https://api.example.com/items/A?site=X', 'https://api.example.com/items/B?site=Y']);
        expect(roles(plan)).to.deep.equal({ item: 'url', site: 'url' });
    });
});
