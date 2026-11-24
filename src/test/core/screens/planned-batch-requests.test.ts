// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's Review as the Requests table (#466/#470, slice 4): a batch's requests before anything is sent, Ready
 * rows made from the batch plan a page at a time, as Execute will send them.
 */
import { expect } from 'chai';
import { planBatch, type BatchPlanInput } from '../../../data-loading/batch-plan';
import { PlannedBatchRequests, SEARCH_MAX } from '../../../screens/console/requests/planned-batch-requests';

const input = (count: number): BatchPlanInput => ({
    endpoint: { method: 'POST', path: '/stock', body: '{"sku":"{{sku}}","qty":"{{qty:number}}"}' },
    baseUrl: 'https://api.example.test', headers: ['sku', 'qty'],
    rows: Array.from({ length: count }, (_, i) => [`SKU-${i + 1}`, String(i + 1)]),
    mappings: [{ variable: 'sku', column: 'sku', dataType: 'string' }, { variable: 'qty', column: 'qty', dataType: 'number' }], reps: 1
});

async function source(count: number) {
    const i = input(count);
    const total = (await planBatch(i)).totals.requests;
    return new PlannedBatchRequests({
        input: () => i, total: () => total,
        headers: () => ({ 'Content-Type': { value: 'application/json', enabled: true }, Authorization: { value: 'Bearer x', enabled: true }, 'X-Off': { value: 'no', enabled: false } }),
        bodyText: body => JSON.stringify(body, null, 2)
    });
}

describe('Review\'s Ready rows (the planned batch)', () => {
    it('a page of Ready rows, as Execute will send them: no response, no HTTP, no time', async () => {
        const s = await source(120);
        const page = await s.page({ offset: 50, limit: 3 });
        expect([page.total, page.of]).to.deep.equal([120, 120]);
        expect(page.rows.map(r => [r.id, r.n, r.status, r.rowStart, r.rowEnd])).to.deep.equal([['plan-51', 51, 'ready', 51, 51], ['plan-52', 52, 'ready', 52, 52], ['plan-53', 53, 'ready', 53, 53]]);
        const [row] = page.rows;
        expect({ http: row.http, timeMs: row.timeMs, sent: row.sent, response: row.response, url: row.url, method: row.method }).to.deep.equal({
            http: null, timeMs: null, sent: null, response: null, url: 'https://api.example.test/stock', method: 'POST'
        });
        expect(row.request?.preview).to.equal('{ "sku": "SKU-51", "qty": 51 }');
        expect(row.requestHeaders, 'the enabled ones, the secret masked').to.deep.equal([{ name: 'Content-Type', value: 'application/json' }, { name: 'Authorization', value: '••••' }]);
    });

    it('the counts: every request Ready', async () => {
        expect(await (await source(7)).counts()).to.deep.equal({ total: 7, counts: { ready: 7 } });
    });

    it('one request in full, for the transaction window: its body as sent, its input rows', async () => {
        const detail = await (await source(10)).detail('plan-4');
        expect(JSON.parse(detail!.requestBody!)).to.deep.equal({ sku: 'SKU-4', qty: 4 });
        expect(detail!.responseBody).to.equal(null);
        expect(detail!.rows).to.deep.equal([4, 4]);
        expect(detail!.input, 'its input rows, from the plan').to.deep.equal({ columns: ['sku', 'qty'], rows: [['SKU-4', '4']] });
        expect(await (await source(10)).detail('plan-99')).to.equal(undefined);
    });

    it('a search reaches the planned bodies', async () => {
        const page = await (await source(40)).page({ offset: 0, limit: 50, search: 'SKU-37' });
        expect(page.rows.map(r => r.n)).to.deep.equal([37]);
        expect([page.total, page.of]).to.deep.equal([1, 40]);
    });

    it('a search of a batch too big to plan whole says so, plainly', async () => {
        const page = await (await source(SEARCH_MAX + 1)).page({ offset: 0, limit: 50, search: 'SKU-7' });
        expect(page.rows).to.deep.equal([]);
        expect(page.error).to.match(/search the Input tab/);
    });

    it('a Status filter without Ready shows none', async () => {
        const page = await (await source(5)).page({ offset: 0, limit: 50, statuses: ['error'] });
        expect([page.rows.length, page.total]).to.deep.equal([0, 0]);
    });

    it('before Review has planned: nothing yet', async () => {
        const s = new PlannedBatchRequests({ input: () => undefined, total: () => 0, headers: () => ({}), bodyText: b => String(b) });
        expect(await s.page({ offset: 0, limit: 5 })).to.deep.equal({ rows: [], total: 0, of: 0 });
        expect(await s.counts()).to.deep.equal({ total: 0, counts: {} });
    });
});

describe('Review\'s Ready rows: through the Run Batch controller', () => {
    it('a page asked for is answered from the plan Review made, with its seq', async () => {
        const { RunBatchController } = await import('../../../screens/run-batch/run-batch.controller');
        const { ScreenSession } = await import('../../../screens/screen-session');
        const posted: Array<Record<string, any>> = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const endpoint = { id: 'ep-1', name: 'Put stock', method: 'POST', path: '/stock', body: '{"sku":"{{sku}}"}', headers: {} };
        const controller = new RunBatchController(session, { endpoints: {}, environments: {} } as never, { context: 'runBatch', endpointId: 'ep-1', endpointName: 'Put stock', endpoint } as never);
        const i = input(30);
        const kept = controller as unknown as { lastPlanInput: BatchPlanInput; lastPlan: unknown };
        kept.lastPlanInput = i;
        kept.lastPlan = await planBatch(i);
        await controller.handleMessage({ type: 'console.requests.page', seq: 4, offset: 10, limit: 2 } as never);
        const answer = posted.find(m => m.type === 'console.requests.rows')!;
        expect({ seq: answer.seq, total: answer.total, ns: answer.rows.map((r: { n: number }) => r.n), status: answer.rows[0].status }).to.deep.equal({ seq: 4, total: 30, ns: [11, 12], status: 'ready' });
        await controller.handleMessage({ type: 'console.requests.counts' } as never);
        expect(posted.find(m => m.type === 'console.requests.counts')).to.deep.include({ total: 30, counts: { ready: 30 } });
    });
});
