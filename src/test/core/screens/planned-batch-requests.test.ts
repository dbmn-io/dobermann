// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's Review as the Requests table (#466/#470, slice 4): a batch's requests before anything is sent, Ready
 * Every request listed: the first SAMPLE built and READY, the rest PLANNED, a pointer to their rows (James, 2026-11-25:
 * "GENERATE the JSON for the first 5, have them at status Ready… the rest, as planned"; the engine builds them as it sends).
 */
import { expect } from 'chai';
import { planBatch, planRanges, planRequests, type BatchPlanInput } from '../../../data-loading/batch-plan';
import { BUILT_LATER, PlannedBatchRequests, SAMPLE } from '../../../screens/console/requests/planned-batch-requests';

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
    it('every request listed: the first 5 built and Ready, the rest Planned, not built and saying so', async () => {
        const s = await source(120);
        expect(SAMPLE).to.equal(5);
        const page = await s.page({ offset: 3, limit: 4 });
        expect([page.total, page.of]).to.deep.equal([120, 120]);
        expect(page.rows.map(r => [r.id, r.n, r.status, r.rowStart, r.rowEnd])).to.deep.equal([
            ['plan-4', 4, 'ready', 4, 4], ['plan-5', 5, 'ready', 5, 5], ['plan-6', 6, 'planned', 6, 6], ['plan-7', 7, 'planned', 7, 7]]);
        expect(page.rows[0].request?.preview, 'a sample: its body').to.equal('{ "sku": "SKU-4", "qty": 4 }');
        expect(page.rows[2].request, 'past the samples: not built').to.deep.equal({ preview: BUILT_LATER, items: null, bytes: null, later: true });
        const far = await s.page({ offset: 100, limit: 2 });
        expect(far.rows.map(r => [r.n, r.rowStart, r.status, r.request?.later])).to.deep.equal([[101, 101, 'planned', true], [102, 102, 'planned', true]]);
        const [row] = page.rows;
        expect({ http: row.http, timeMs: row.timeMs, sent: row.sent, response: row.response, url: row.url, method: row.method }).to.deep.equal({
            http: null, timeMs: null, sent: null, response: null, url: 'https://api.example.test/stock', method: 'POST'
        });
        expect(row.requestHeaders, 'the enabled ones, the secret masked').to.deep.equal([{ name: 'Content-Type', value: 'application/json' }, { name: 'Authorization', value: '••••' }]);
    });

    it('the counts: 5 Ready, the rest Planned', async () => {
        expect(await (await source(7)).counts()).to.deep.equal({ total: 7, counts: { ready: 5, planned: 2 } });
        expect(await (await source(3)).counts()).to.deep.equal({ total: 3, counts: { ready: 3 } });
    });

    it('one request in full, for the transaction window: its body as sent, its input rows', async () => {
        const detail = await (await source(10)).detail('plan-4');
        expect(JSON.parse(detail!.requestBody!)).to.deep.equal({ sku: 'SKU-4', qty: 4 });
        expect(detail!.responseBody).to.equal(null);
        expect(detail!.rows).to.deep.equal([4, 4]);
        expect(detail!.input, 'its input rows, from the plan').to.deep.equal({ columns: ['sku', 'qty'], rows: [['SKU-4', '4']] });
        expect(await (await source(10)).detail('plan-99')).to.equal(undefined);
        const later = await (await source(10)).detail('plan-8');
        expect(later!.requestBody, 'past the samples: not built, and it says so').to.equal(BUILT_LATER);
        expect(later!.input, 'its input rows all the same').to.deep.equal({ columns: ['sku', 'qty'], rows: [['SKU-8', '8']] });
    });

    it('a search: the samples by their bodies, every row by its input rows; nothing past the samples is built', async () => {
        const s = await source(40);
        const page = await s.page({ offset: 0, limit: 50, search: 'SKU-37' });
        expect(page.rows.map(r => [r.n, r.request?.later])).to.deep.equal([[37, true]]);
        expect([page.total, page.of]).to.deep.equal([1, 40]);
    });

    it('a Status filter: Ready the samples, Planned the rest, neither none', async () => {
        const page = await (await source(5)).page({ offset: 0, limit: 50, statuses: ['error'] });
        const s = await source(12);
        const ready = await s.page({ offset: 0, limit: 50, statuses: ['ready'] });
        expect([ready.rows.map(r => r.n), ready.total]).to.deep.equal([[1, 2, 3, 4, 5], 5]);
        const planned = await s.page({ offset: 0, limit: 3, statuses: ['planned'] });
        expect([planned.rows.map(r => [r.n, r.status]), planned.total]).to.deep.equal([[[6, 'planned'], [7, 'planned'], [8, 'planned']], 7]);
        expect([page.rows.length, page.total]).to.deep.equal([0, 0]);
    });

    it('before Review has planned: nothing yet', async () => {
        const s = new PlannedBatchRequests({ input: () => undefined, total: () => 0, headers: () => ({}), bodyText: b => String(b) });
        expect(await s.page({ offset: 0, limit: 5 })).to.deep.equal({ rows: [], total: 0, of: 0 });
        expect(await s.counts()).to.deep.equal({ total: 0, counts: {} });
    });
});

describe('planRanges: where each request\'s rows are, nothing built', () => {
    it('a grouped template (a PO per request): 500 rows, 13 POs: 5 sample POs built and Ready, the other 8 Planned on the same rows', async () => {
        const pos = Array.from({ length: 13 }, (_, i) => `PO-${String(i + 1).padStart(2, '0')}`);
        const grouped: BatchPlanInput = {
            endpoint: { method: 'POST', path: '/po', body: '{"poNumber":"{{po}}","lines":[{"sku":"{{sku}}"}]}' },
            baseUrl: 'https://api.example.test', headers: ['po', 'sku'],
            rows: Array.from({ length: 500 }, (_, i) => [pos[i % 13], `SKU-${i + 1}`]),
            mappings: [{ variable: 'po', column: 'po', dataType: 'string' }, { variable: 'sku', column: 'sku', dataType: 'string' }], reps: 1
        };
        const total = (await planBatch(grouped)).totals.requests;
        expect(total, 'one request per PO').to.equal(13);
        const built = await planRequests(grouped, 0, 13);
        const ranges = await planRanges(grouped, 0, 13);
        expect(ranges.map(r => [r.index, r.rowRange.start, r.rowRange.end, r.inputRows[0][0]])).to.deep.equal(built.map(r => [r.index, r.rowRange.start, r.rowRange.end, r.inputRows[0][0]]));
        const s = new PlannedBatchRequests({ input: () => grouped, total: () => total, headers: () => ({}), bodyText: b => JSON.stringify(b) });
        const page = await s.page({ offset: 0, limit: 50 });
        expect(page.rows.map(r => r.status)).to.deep.equal([...Array(5).fill('ready'), ...Array(8).fill('planned')]);
        expect(page.rows[0].request?.preview).to.match(/"poNumber":"PO-01"/);
        expect(page.rows[12].request?.later).to.equal(true);
    });

    it('the same rows as the requests built, for a batch packing rows into an array (3 a request), from any offset', async () => {
        const packed: BatchPlanInput = { ...input(10), endpoint: { method: 'POST', path: '/stock', body: '[{"sku":"{{sku}}","qty":"{{qty:number}}"}]' }, reps: 3 };
        const built = await planRequests(packed, 0, 4);
        const ranges = await planRanges(packed, 0, 4);
        expect(ranges.map(r => [r.index, r.rowRange.start, r.rowRange.end, r.inputRows.length, r.body])).to.deep.equal(
            built.map(r => [r.index, r.rowRange.start, r.rowRange.end, r.inputRows.length, null]));
        expect((await planRanges(packed, 2, 2)).map(r => [r.index, r.rowRange.start, r.rowRange.end])).to.deep.equal([[3, 7, 9], [4, 10, 10]]);
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
        await controller.handleMessage({ type: 'console.requests.page', seq: 4, offset: 1, limit: 2 } as never);
        const answer = posted.find(m => m.type === 'console.requests.rows')!;
        expect({ seq: answer.seq, total: answer.total, of: answer.of, ns: answer.rows.map((r: { n: number }) => r.n), status: answer.rows[0].status })
            .to.deep.equal({ seq: 4, total: 30, of: 30, ns: [2, 3], status: 'ready' });
        await controller.handleMessage({ type: 'console.requests.counts' } as never);
        expect(posted.find(m => m.type === 'console.requests.counts')).to.deep.include({ total: 30, counts: { ready: 5, planned: 25 } });
    });
});
