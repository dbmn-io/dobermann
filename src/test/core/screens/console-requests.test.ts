// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's Requests tab, host side (#466): a stored run's requests as rows for dbmn-table's
 * `source`, paged, sorted and searched on the host, light (a request's files are opened only for
 * the rows asked for), and live while the run goes.
 */
import { expect } from 'chai';
import type { ExecutionMetadata } from '../../../storage/execution-metadata';
import { StoredRunRequests, parseResponseFile } from '../../../screens/console/requests/stored-run-requests';
import { REQUEST_STATUSES } from '../../../screens/console/requests/request-rows';

type Record_ = Partial<ExecutionMetadata> & { id: string; reprocessCount?: number };
const breathes = { count: 0 };

/** A run of `count` requests of 200 input rows each, their files in memory; what was read is counted. */
function run(count: number, over: (i: number) => Partial<Record_> = () => ({})) {
    const files = new Map<string, string>();
    const reads: string[] = [];
    const records: Record_[] = [];
    for (let i = 1; i <= count; i++) {
        const id = `m-${String(i).padStart(4, '0')}`;
        const requestFile = `/run/${id}.request.json`;
        const responseFile = `/run/${id}.response.json`;
        files.set(requestFile, JSON.stringify([{ sku: `SKU-WOOF-${String(i).padStart(3, '0')}`, uom: 'EA' }]));
        files.set(responseFile, JSON.stringify({
            executionId: id, httpStatus: i % 10 === 0 ? 422 : 201, headers: { 'Content-Type': 'application/json', 'x-request-id': `req-${i}`, 'Set-Cookie': 'session=secret' },
            data: i % 10 === 0 ? { error: 'uom XX is not a unit' } : { created: 1 }
        }));
        records.push({
            id, status: i % 10 === 0 ? 'error' : 'completed', httpStatus: i % 10 === 0 ? 422 : 201, runTime: 100 + i,
            startedAt: new Date(Date.UTC(2026, 10, 24, 9, 0, i)), rowStart: (i - 1) * 200 + 1, rows: '200',
            endpointMethod: 'post', endpointPath: '/functions/v1/playground', requestQueryParams: { dryRun: 'false' },
            requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer abc', org: 'vic' },
            requestFile, responseFile, errorMessage: i % 10 === 0 ? 'HTTP 422' : undefined, logPath: `/run/${id}.log`,
            reprocessCount: 0,
            ...over(i)
        });
    }
    let asked = 0;
    const slow = { ms: 0 };
    const source = new StoredRunRequests({
        requests: async () => { asked++; return records as ExecutionMetadata[]; },
        yieldNow: async () => { breathes.count++; await new Promise(resolve => setImmediate(resolve)); },
        files: {
            exists: p => files.has(p),
            read: p => { reads.push(p); const until = Date.now() + slow.ms; while (Date.now() < until) { /* a slow disk */ } return files.get(p)!; }
        }
    });
    return { source, records, files, reads, slow, asked: () => asked };
}

describe('Console Requests (host): a row per request', () => {
    it('pages: 50 at a time from the top, the total and the run\'s size', async () => {
        const { source } = run(210);
        const first = await source.page({ offset: 0, limit: 50 });
        expect(first.rows.map(r => r.n)).to.deep.equal(Array.from({ length: 50 }, (_, i) => i + 1));
        expect([first.total, first.of]).to.deep.equal([210, 210]);
        const last = await source.page({ offset: 200, limit: 50 });
        expect(last.rows.map(r => r.n)).to.deep.equal([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);
    });

    it('opens only the files of the rows asked for', async () => {
        const { source, reads } = run(210);
        await source.page({ offset: 50, limit: 50 });
        expect(reads).to.have.length(100);
        expect(reads.every(p => /m-0(0[5-9]\d|100)\./.test(p))).to.equal(true);
    });

    it('a row\'s figures, as agreed with the design system', async () => {
        const { source } = run(12);
        const [row] = (await source.page({ offset: 9, limit: 1 })).rows;
        expect({ id: row.id, n: row.n, status: row.status, http: row.http, timeMs: row.timeMs, sent: row.sent, rowStart: row.rowStart, rowEnd: row.rowEnd,
            method: row.method, url: row.url, query: row.query, reason: row.reason, reprocessCount: row.reprocessCount, hasLogs: row.hasLogs }).to.deep.equal({
            id: 'm-0010', n: 10, status: 'error', http: 422, timeMs: 110, sent: '2026-11-24T09:00:10.000Z', rowStart: 1801, rowEnd: 2000,
            method: 'POST', url: '/functions/v1/playground?dryRun=false', query: { dryRun: 'false' }, reason: 'HTTP 422', reprocessCount: 0, hasLogs: true
        });
        expect(row.request).to.deep.equal({ preview: '[{"sku":"SKU-WOOF-010","uom":"EA"}]', items: 1, bytes: Buffer.byteLength('[{"sku":"SKU-WOOF-010","uom":"EA"}]') });
        expect(row.response?.preview).to.equal('{"error":"uom XX is not a unit"}');
        expect(row.response?.items).to.equal(null);
        expect(row.response?.contentType).to.equal('application/json');
    });

    it('headers: lists by name for the count cell, each also as a flat column key; secrets masked', async () => {
        const { source } = run(1);
        const [row] = (await source.page({ offset: 0, limit: 1 })).rows;
        expect(row.requestHeaders).to.deep.equal([
            { name: 'Content-Type', value: 'application/json' }, { name: 'Authorization', value: '••••' }, { name: 'org', value: 'vic' }
        ]);
        expect(row.responseHeaders).to.deep.equal([
            { name: 'Content-Type', value: 'application/json' }, { name: 'x-request-id', value: 'req-1' }, { name: 'Set-Cookie', value: '••••' }
        ]);
        expect(row['request header: org']).to.equal('vic');
        expect(row['request header: authorization']).to.equal('••••');
        expect(row['response header: x-request-id']).to.equal('req-1');
        expect(JSON.stringify(row)).to.not.include('Bearer abc');
        expect(JSON.stringify(row)).to.not.include('session=secret');
    });

    it('an old run with only organization: no request headers were kept, so none are shown (the org is in ⓘ)', async () => {
        const { source } = run(2, () => ({ requestHeaders: undefined, organization: 'vic' }));
        const [row] = (await source.page({ offset: 0, limit: 1 })).rows;
        expect(row.requestHeaders).to.deep.equal([]);
        expect(Object.keys(row).filter(k => k.startsWith('request header: '))).to.deep.equal([]);
        expect((await source.columnTree()).requestHeaders).to.deep.equal([]);
    });

    it('an older single run\'s response file ({ _meta: { responseHeaders }, …data })', async () => {
        const { source, files, records } = run(1);
        files.set(records[0].responseFile!, JSON.stringify({ _meta: { status: 200, responseHeaders: { 'content-type': 'text/plain' } }, ok: true }));
        const [row] = (await source.page({ offset: 0, limit: 1 })).rows;
        expect(row.responseHeaders).to.deep.equal([{ name: 'content-type', value: 'text/plain' }]);
        expect(row.response?.preview).to.equal('{"ok":true}');
    });

    it('every status comes through as it is', async () => {
        const { source } = run(REQUEST_STATUSES.length, i => ({ status: REQUEST_STATUSES[i - 1] }));
        const page = await source.page({ offset: 0, limit: 50 });
        expect(page.rows.map(r => r.status)).to.deep.equal([...REQUEST_STATUSES]);
    });

    it('sorts on the host: HTTP, then time, the blanks last whichever way', async () => {
        const { source } = run(20, i => (i === 3 ? { httpStatus: undefined, runTime: undefined, status: 'running' } : {}));
        const desc = await source.page({ offset: 0, limit: 3, sort: { id: 'http', dir: 'desc' } });
        expect(desc.rows.map(r => [r.n, r.http])).to.deep.equal([[10, 422], [20, 422], [1, 201]]);
        const asc = await source.page({ offset: 0, limit: 50, sort: { id: 'timeMs', dir: 'asc' } });
        expect(asc.rows[0].n).to.equal(1);
        expect(asc.rows[19].n, 'no time yet: last').to.equal(3);
    });

    it('a search on the record alone opens no file but the page\'s', async () => {
        const { source, reads } = run(210);
        const page = await source.page({ offset: 0, limit: 50, search: '@status=error' });
        expect([page.total, page.of]).to.deep.equal([21, 210]);
        expect(page.rows.every(r => r.status === 'error')).to.equal(true);
        expect(reads, 'only the 21 rows shown').to.have.length(42);
    });

    it('a search in the bodies opens each request once, and keeps the answer until the run changes', async () => {
        const { source, reads, records } = run(50);
        const page = await source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-007' });
        expect(page.rows.map(r => r.id)).to.deep.equal(['m-0007']);
        const scanned = reads.length;
        expect(scanned).to.equal(50 * 2 + 2);
        await source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-007' });
        expect(reads.length - scanned, 'the kept answer: only the row shown').to.equal(2);
        records[6].status = 'error';
        source.changed();
        await source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-007' });
        expect(reads.length - scanned - 2, 'scanned again after the change').to.equal(50 * 2 + 2);
    });

    it('a response header can be searched by its column', async () => {
        const { source } = run(30);
        const columns = [{ id: 'n', name: '#' }, { id: 'response header: x-request-id', name: 'x-request-id' }];
        const page = await source.page({ offset: 0, limit: 50, search: '@x-request-id=req-17', columns });
        expect(page.rows.map(r => r.n)).to.deep.equal([17]);
    });

    it('live: statuses change in place and the counts follow', async () => {
        const { source, records } = run(5, () => ({ status: 'pending', httpStatus: undefined, runTime: undefined, startedAt: undefined }));
        expect(await source.counts()).to.deep.equal({ total: 5, counts: { pending: 5 } });
        records[0].status = 'running';
        records[1].status = 'completed'; records[1].httpStatus = 201; records[1].runTime = 90;
        source.changed();
        expect(await source.counts()).to.deep.equal({ total: 5, counts: { running: 1, completed: 1, pending: 3 } });
        const page = await source.page({ offset: 0, limit: 5 });
        expect(page.rows.map(r => [r.n, r.status, r.http])).to.deep.equal([[1, 'running', null], [2, 'completed', 201], [3, 'pending', null], [4, 'pending', null], [5, 'pending', null]]);
        expect(page.rows[2].sent).to.equal(null);
    });

    it('the View editor\'s tree: the run\'s own header names, request and response', async () => {
        const { source } = run(3, i => (i === 2 ? { requestHeaders: { 'X-Trace': 't' } } : {}));
        const tree = await source.columnTree();
        expect(tree.requestHeaders).to.deep.equal(['Content-Type', 'Authorization', 'org', 'X-Trace']);
        expect(tree.responseHeaders).to.deep.equal(['Content-Type', 'x-request-id', 'Set-Cookie']);
        expect(tree.run.map(c => c.id)).to.include.members(['n', 'status', 'http', 'timeMs', 'sent', 'rowStart', 'reprocessCount', 'reason', 'id']);
    });

    it('one request in full, for the transaction window', async () => {
        const { source } = run(10);
        const detail = await source.detail('m-0010');
        expect(detail).to.deep.include({ id: 'm-0010', method: 'POST', url: '/functions/v1/playground?dryRun=false', rows: [1801, 2000] });
        expect(JSON.parse(detail!.requestBody!)).to.deep.equal([{ sku: 'SKU-WOOF-010', uom: 'EA' }]);
        expect(JSON.parse(detail!.responseBody!)).to.deep.equal({ error: 'uom XX is not a unit' });
        expect(detail!.responseHeaders.map(h => h.name)).to.deep.equal(['Content-Type', 'x-request-id', 'Set-Cookie']);
        expect(await source.detail('nope')).to.equal(undefined);
    });

    it('the run\'s records are read once until the run changes', async () => {
        const h = run(30);
        await h.source.page({ offset: 0, limit: 10 });
        await h.source.page({ offset: 10, limit: 10 });
        await h.source.counts();
        expect(h.asked()).to.equal(1);
        h.source.changed();
        await h.source.page({ offset: 0, limit: 10 });
        expect(h.asked()).to.equal(2);
    });

    it('a sort on a column only the files hold is not done (it would open every file)', async () => {
        const { source, reads } = run(40);
        const page = await source.page({ offset: 0, limit: 5, sort: { id: 'contentType', dir: 'desc' } });
        expect(page.rows.map(r => r.n)).to.deep.equal([1, 2, 3, 4, 5]);
        expect(reads).to.have.length(10);
    });

    it('a long search lets the page breathe between slices', async () => {
        const h = run(60);
        h.slow.ms = 1;
        breathes.count = 0;
        const page = await h.source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-059' });
        expect(page.rows.map(r => r.n)).to.deep.equal([59]);
        expect(breathes.count, 'gave way several times').to.be.greaterThan(3);
    });

    it('a newer search stops the one working through the files', async () => {
        const h = run(60);
        h.slow.ms = 1;
        const first = h.source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-059' });
        await new Promise(resolve => setImmediate(resolve));
        const second = h.source.page({ offset: 0, limit: 50, search: 'SKU-WOOF-003' });
        const [a, b] = await Promise.all([first, second]);
        expect([a.rows.length, a.total], 'stopped: not wanted').to.deep.equal([0, 0]);
        expect(b.rows.map(r => r.n)).to.deep.equal([3]);
    });

    it('two pages of the same search share one pass through the files', async () => {
        const { source, reads } = run(40);
        const [a, b] = await Promise.all([
            source.page({ offset: 0, limit: 1, search: 'SKU-WOOF' }),
            source.page({ offset: 1, limit: 1, search: 'SKU-WOOF' })
        ]);
        expect([a.total, b.total]).to.deep.equal([40, 40]);
        expect([a.rows[0].n, b.rows[0].n]).to.deep.equal([1, 2]);
        expect(reads).to.have.length(40 * 2 + 2 + 2);
    });

    it('the Status heading\'s filter: only the statuses ticked, the run\'s size still said', async () => {
        const { source } = run(30);
        const page = await source.page({ offset: 0, limit: 50, statuses: ['error'] });
        expect([page.total, page.of]).to.deep.equal([3, 30]);
        expect(page.rows.map(r => r.n)).to.deep.equal([10, 20, 30]);
        expect((await source.page({ offset: 0, limit: 5, statuses: null })).total).to.equal(30);
    });
});

describe('Console Requests (host): a JSON Lines response is given back as its lines', () => {
    // (the engine keeps a JSON Lines body as its records and the lines that weren't JSON: Raw's card read it as lines)
    const file = JSON.stringify({
        httpStatus: 200, headers: { 'content-type': 'application/x-ndjson' },
        data: [{ sku: 'DOG-001' }, { sku: 'DOG-002' }, { sku: 'DOG-003' }],
        format: { kind: 'jsonl', records: 3, invalid: [{ line: 4, text: '{"sku":"DOG-0' }], invalidCount: 1 }
    });

    it('a record a line, the line that wasn\'t JSON back where it was, whether the body is shown pretty or not', () => {
        const lines = '{"sku":"DOG-001"}\n{"sku":"DOG-002"}\n{"sku":"DOG-003"}\n{"sku":"DOG-0';
        expect(parseResponseFile(file, true).body).to.equal(lines);
        expect(parseResponseFile(file, false).body).to.equal(lines);
        expect(parseResponseFile(file).headers).to.deep.equal([{ name: 'content-type', value: 'application/x-ndjson' }]);
    });

    it('a JSON body stays JSON', () => {
        expect(parseResponseFile(JSON.stringify({ httpStatus: 200, headers: {}, data: [{ a: 1 }] }), false).body).to.equal('[{"a":1}]');
    });
});


describe('Console Requests (host): the files read where there is no Buffer (the web app)', () => {
    // (round 38c: Buffer.byteLength threw there, the read's catch gave no text, and every body was missing)
    it('a request\'s response and its size, with Buffer gone', async () => {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-nobuffer-'));
        const responseFile = path.join(dir, 'r.response.json');
        fs.writeFileSync(responseFile, JSON.stringify({ httpStatus: 200, headers: {}, data: { carriers: ['WOOF', 'ÄÖ'] } }));
        const record = { id: 'r-1', status: 'completed', endpointMethod: 'GET', endpointPath: '/reference/carriers', responseFile, createdAt: new Date() };
        const source = new StoredRunRequests({ requests: async () => [record as never], files: { exists: p => fs.existsSync(p), read: p => fs.readFileSync(p, 'utf8') } });
        const bytes = Buffer.byteLength(fs.readFileSync(responseFile, 'utf8'));
        const saved = (globalThis as { Buffer?: unknown }).Buffer;
        try {
            (globalThis as { Buffer?: unknown }).Buffer = undefined;
            const detail = await source.detail('r-1');
            expect(detail?.responseBody).to.contain('WOOF');
            const page = await source.page({ offset: 0, limit: 10 });
            expect(page.rows[0].response?.bytes, 'its size in bytes, UTF-8').to.equal(bytes);
        } finally {
            (globalThis as { Buffer?: unknown }).Buffer = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
