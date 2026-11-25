// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Requests tab's messages through the real Console controller (#466): a page asked for and
 * answered with its `seq`, one request in full, and a live run's changes told at most every 250 ms.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConsoleController } from '../../../screens/console/console.controller';
import { ScreenSession } from '../../../screens/screen-session';

type Message = Record<string, any>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function batch(count: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-requests-'));
    const members = Array.from({ length: count }, (_, k) => {
        const i = k + 1;
        const requestFile = path.join(dir, `m-${i}.request.json`);
        const responseFile = path.join(dir, `m-${i}.response.json`);
        fs.writeFileSync(requestFile, JSON.stringify({ sku: `SKU-${i}` }));
        fs.writeFileSync(responseFile, JSON.stringify({ httpStatus: 201, headers: { 'x-request-id': `r-${i}` }, data: { ok: i } }));
        return { id: `m-${i}`, status: 'pending', endpointMethod: 'POST', endpointPath: '/stock', rowStart: i, rows: '1', requestFile, responseFile, createdAt: new Date() };
    });
    const posted: Message[] = [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
    const metadata: Record<string, unknown> = { getBatchMemberExecutions: async () => members, getExecution: async (id: string) => members.find(m => m.id === id) ?? null };
    const ports = {
        metadata,
        state: { get: () => undefined, update: async () => undefined },
        logger: { log: () => undefined, error: () => undefined },
        toast: { info: () => undefined, warn: () => undefined, error: () => undefined }
    };
    const controller = new ConsoleController(session, ports as never, { type: 'batch', batchId: 'b-1', responseFiles: [] } as never);
    (ConsoleController as unknown as { activeConsoles: Map<string, ConsoleController> }).activeConsoles.set('b-1', controller);
    const of = (type: string) => posted.filter(m => m.type === type);
    const done = () => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); };
    return { controller, members, metadata, posted, of, done };
}

describe('Console Requests (host): through the controller', () => {
    it('a page asked for is answered with its seq, rows, total and of', async () => {
        const h = batch(3);
        try {
            await h.controller.handle({ type: 'console.requests.page', seq: 7, offset: 1, limit: 50, search: '', sort: null });
            const [answer] = h.of('console.requests.rows');
            expect({ seq: answer.seq, total: answer.total, of: answer.of, ns: answer.rows.map((r: Message) => r.n) }).to.deep.equal({ seq: 7, total: 3, of: 3, ns: [2, 3] });
            expect(answer.rows[0]['response header: x-request-id']).to.equal('r-2');
        } finally { h.done(); }
    });

    it('one request in full, and the column tree', async () => {
        const h = batch(2);
        try {
            await h.controller.handle({ type: 'console.requests.detail', seq: 1, id: 'm-2' });
            const [{ detail }] = h.of('console.requests.detail');
            expect(JSON.parse(detail.requestBody)).to.deep.equal({ sku: 'SKU-2' });
            expect(detail.rows).to.deep.equal([2, 2]);
            await h.controller.handle({ type: 'console.requests.columns', seq: 2 });
            const [{ tree }] = h.of('console.requests.columnTree');
            expect(tree.responseHeaders).to.deep.equal(['x-request-id']);
        } finally { h.done(); }
    });

    it('live: the tab\'s counts every 250 ms, and the table told to ask again, once', async () => {
        const h = batch(4);
        try {
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: true });   // (the tab on screen)
            await wait(20);
            h.members[0].status = 'running';
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'running');
            h.members[0].status = 'completed';
            h.members[1].status = 'running';
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-2'], 'running');
            expect(h.of('console.requests.counts'), 'not yet').to.have.length(0);
            await wait(320);
            const said = { type: 'console.requests.counts', total: 4, counts: { completed: 1, running: 1, pending: 2 } };
            expect(h.of('console.requests.counts')).to.deep.equal([said]);
            expect(h.of('console.requests.changed')).to.deep.equal([{ ...said, type: 'console.requests.changed' }]);
        } finally { h.done(); }
    });

    it('the table\'s reloads are paced by what its pages cost: four times, 250 ms to a second', async () => {
        expect([10, 95, 200, 400].map(ms => ConsoleController.requestsReloadDelay(ms))).to.deep.equal([250, 380, 800, 1000]);
        const h = batch(3);
        try {
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: true });   // (the tab on screen)
            await wait(20);
            (h.controller as unknown as { lastRequestsPageMs: number }).lastRequestsPageMs = 200;   // a big run's page
            h.members[0].status = 'completed';
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'completed');
            await wait(400);
            expect(h.of('console.requests.counts'), 'the counts keep their pace').to.have.length(1);
            expect(h.of('console.requests.changed'), 'the table waits').to.have.length(0);
            await wait(500);
            expect(h.of('console.requests.changed')).to.have.length(1);
        } finally { h.done(); }
    });

    it('a Requests tab never opened is never told to reload: its counts only (the table is made unseen at load)', async () => {
        const h = batch(3);
        try {
            await h.controller.handle({ type: 'console.requests.counts' });   // (as the page asks at load)
            h.members[0].status = 'completed';
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'completed');
            await wait(400);
            expect(h.of('console.requests.changed')).to.have.length(0);
            expect(h.of('console.requests.counts').length, 'the tab\'s count still follows').to.be.greaterThan(1);
        } finally { h.done(); }
    });

    it('off screen the table isn\'t told; shown again, it is told at once', async () => {
        const h = batch(3);
        try {
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: false });
            h.members[0].status = 'completed';
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'completed');
            await wait(400);
            expect(h.of('console.requests.counts'), 'counts still').to.have.length(1);
            expect(h.of('console.requests.changed')).to.have.length(0);
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await wait(20);
            expect(h.of('console.requests.changed')).to.deep.equal([{ type: 'console.requests.changed', total: 3, counts: { completed: 1, pending: 2 } }]);
            // Hidden before it asked for its page (a Run API's Console shows Requests for a moment, then Completed): the
            // word isn't known to be heard, so shown again it is told again (James, 2026-11-26: the row stayed Running)
            await h.controller.handle({ type: 'console.requests.shown', shown: false });
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await wait(20);
            expect(h.of('console.requests.changed'), 'told again: it never asked').to.have.length(2);
            // It asks for its page: heard. Shown again with nothing missed: nothing more
            await h.controller.handle({ type: 'console.requests.page', seq: 2, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await wait(20);
            expect(h.of('console.requests.changed'), 'nothing missed: nothing more').to.have.length(2);
        } finally { h.done(); }
    });

    it('a request read while in flight, its end never told (a paged Run API\'s page one): shown again, the table is told to ask again', async () => {
        // (James, 2026-11-26: the row said Running under "Execution Complete"; the result is told before its status is stored)
        const h = batch(1);
        try {
            h.members[0].status = 'running';
            // (as storage answers: a reading of its own each time, not the rows themselves)
            h.metadata.getBatchMemberExecutions = async () => h.members.map(m => ({ ...m }));
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: false });
            h.members[0].status = 'completed';   // stored, with no word to the Console
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await wait(20);
            expect(h.of('console.requests.changed')).to.deep.equal([{ type: 'console.requests.changed', total: 1, counts: { completed: 1 } }]);
            // (all finished now: showing it again reads nothing more)
            await h.controller.handle({ type: 'console.requests.page', seq: 2, offset: 0, limit: 50 });
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await wait(20);
            expect(h.of('console.requests.changed'), 'a finished run is not read again').to.have.length(1);
        } finally { h.done(); }
    });

    it('a request in flight on the page shown, its end never told: looked for each second, told once it has changed, quiet until then', async () => {
        const h = batch(1);
        try {
            h.members[0].status = 'running';
            h.metadata.getBatchMemberExecutions = async () => h.members.map(m => ({ ...m }));
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            await wait(1300);
            expect(h.of('console.requests.changed'), 'still in flight: nothing told').to.have.length(0);
            h.members[0].status = 'completed';   // stored, with no word to the Console
            await wait(1300);
            expect(h.of('console.requests.changed')).to.deep.equal([{ type: 'console.requests.changed', total: 1, counts: { completed: 1 } }]);
            await h.controller.handle({ type: 'console.requests.page', seq: 2, offset: 0, limit: 50 });
            await wait(1300);
            expect(h.of('console.requests.changed'), 'finished: no more looking').to.have.length(1);
        } finally { h.done(); }
    });

    it('a batch being told of its changes is not read by the in-flight look, whatever its size: only a run gone quiet is', async () => {
        const h = batch(3);
        try {
            let reads = 0;
            h.members[0].status = 'running';
            h.metadata.getBatchMemberExecutions = async () => { reads++; return h.members.map(m => ({ ...m })); };
            await h.controller.handle({ type: 'console.requests.shown', shown: true });
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            const after = reads;
            // Words keep coming for 2.5 s (a batch running), with the table not asking again: nothing is read
            for (let i = 0; i < 10; i++) { (h.controller as unknown as { requestsWordAt: number }).requestsWordAt = Date.now(); await wait(250); }
            expect(reads, 'no reading while it is being told').to.equal(after);
            // Quiet for over a second: looked at (the look comes round each second; allow two)
            await wait(2300);
            expect(reads, 'gone quiet: looked').to.be.greaterThan(after);
        } finally { h.done(); }
    });

    it('a request with its files offers Logs (the window opened from this tab had no Logs button for a batch\'s requests)', async () => {
        const h = batch(2);
        try {
            await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
            const rows = (h.of('console.requests.rows')[0] as unknown as { rows: { hasLogs: boolean }[] }).rows;
            // (no log path on the record: the Logs window finds the .log beside the request file)
            expect(rows.map(r => r.hasLogs)).to.deep.equal([true, true]);
        } finally { h.done(); }
    });

    it('a single run: its response, written as it ends, reaches the Requests side (its window asked before it was)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-single-'));
        const run: Record<string, unknown> = { id: 'x-1', status: 'running', endpointMethod: 'GET', endpointPath: '/reference/carriers', createdAt: new Date() };
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const metadata = { getExecution: async (id: string) => (id === 'x-1' ? { ...run } : null), countBatchMembersByStatus: async () => ({}) };
        const ports = { metadata, state: { get: () => undefined, update: async () => undefined },
            logger: { log: () => undefined, error: () => undefined }, toast: { info: () => undefined, warn: () => undefined, error: () => undefined } };
        const controller = new ConsoleController(session, ports as never, { type: 'individual', executionId: 'x-1', responseFiles: [] } as never);
        (ConsoleController as unknown as { activeConsoles: Map<string, ConsoleController> }).activeConsoles.set('x-1', controller);
        const of = (type: string) => posted.filter(m => m.type === type);
        try {
            // The window opens as the run starts: no response yet
            await controller.handle({ type: 'console.requests.detail', seq: 1, id: 'x-1' });
            expect(of('console.requests.detail')[0].detail.responseBody).to.equal(null);
            // The run ends: its response is written, and the Console is told its status
            const responseFile = path.join(dir, 'x-1.response.json');
            fs.writeFileSync(responseFile, JSON.stringify({ httpStatus: 200, headers: {}, data: { carriers: ['WOOF'] } }));
            Object.assign(run, { status: 'completed', responseFile });
            await ConsoleController.sendStatusUpdate('x-1', { status: 'completed' } as never);
            await wait(320);
            expect(of('console.requests.counts'), 'the page told: its open window asks again').to.have.length.greaterThan(0);
            await controller.handle({ type: 'console.requests.detail', seq: 2, id: 'x-1' });
            expect(of('console.requests.detail')[1].detail.responseBody).to.contain('WOOF');
        } finally { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a finished single run whose response file lands a moment after it ends: the next detail has it, with no other word', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-late-'));
        const responseFile = path.join(dir, 'y-1.response.json');
        // (its record says completed before it names its response file: both written as it ends)
        const run: Record<string, unknown> = { id: 'y-1', status: 'completed', endpointMethod: 'GET', endpointPath: '/reference/carriers', createdAt: new Date() };
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const metadata = { getExecution: async (id: string) => (id === 'y-1' ? { ...run } : null) };
        const ports = { metadata, state: { get: () => undefined, update: async () => undefined },
            logger: { log: () => undefined, error: () => undefined }, toast: { info: () => undefined, warn: () => undefined, error: () => undefined } };
        const controller = new ConsoleController(session, ports as never, { type: 'individual', executionId: 'y-1', responseFiles: [] } as never);
        const details = () => posted.filter(m => m.type === 'console.requests.detail').map(m => m.detail.responseBody);
        try {
            await controller.handle({ type: 'console.requests.detail', seq: 1, id: 'y-1' });   // (written behind: not yet)
            fs.writeFileSync(responseFile, JSON.stringify({ httpStatus: 200, headers: {}, data: { carriers: ['WOOF'] } }));
            run.responseFile = responseFile;
            await controller.handle({ type: 'console.requests.detail', seq: 2, id: 'y-1' });   // (the window asks again)
            expect(details()[0]).to.equal(null);
            expect(details()[1]).to.contain('WOOF');
        } finally { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a batch\'s counts come from the store\'s count, not its records', async () => {
        const h = batch(3);
        try {
            let counted = 0;
            (h.metadata as Record<string, unknown>).countBatchMembersByStatus = async () => { counted++; return { pending: 2, completed: 1 }; };
            await h.controller.handle({ type: 'console.requests.columns', seq: 1 });
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'completed');
            await wait(320);
            expect(counted).to.be.greaterThan(0);
            expect(h.of('console.requests.counts')[0]).to.deep.include({ total: 3, counts: { pending: 2, completed: 1 } });
        } finally { h.done(); }
    });

    it('nothing is told before the tab has asked, or after the Console has closed', async () => {
        const h = batch(2);
        await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'running');
        await wait(300);
        expect(h.of('console.requests.changed').length + h.of('console.requests.counts').length).to.equal(0);
        await h.controller.handle({ type: 'console.requests.page', seq: 1, offset: 0, limit: 50 });
        h.controller.requestsChanged();
        h.done();
        await wait(300);
        expect(h.of('console.requests.changed').length + h.of('console.requests.counts').length).to.equal(0);
    });
});

describe('Console Requests (host): the lean query a row is made from', () => {
    it('reads each request\'s figures, headers and file paths from real storage, in the order made', async () => {
        const { SqlJsExecutionStorage } = await import('../../../services/storage/sqljs-execution-storage.service');
        const { tempStorageOptions } = await import('../fixtures/temp-storage');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-request-rows-'));
        try {
            const storage = new SqlJsExecutionStorage(tempStorageOptions(dir));
            await storage.initialize();
            const base = { environment: 'Test', endpointId: 'e1', endpointName: 'Put stock', endpointMethod: 'POST', endpointPath: '/stock' };
            const t = new Date(Date.UTC(2026, 10, 24, 9));
            const batchId = await storage.createExecution({ ...base, executionType: 'batch', rows: '400', status: 'completed', createdAt: t } as never);
            await storage.createExecutionBatch([1, 2].map(i => ({
                ...base, executionType: 'batch_member', batchId, rowStart: (i - 1) * 200 + 1, rows: '200', status: i === 2 ? 'error' : 'completed',
                httpStatus: i === 2 ? 422 : 201, httpStatusText: i === 2 ? 'Unprocessable' : 'Created', runTime: 90 + i, errorMessage: i === 2 ? 'HTTP 422' : undefined,
                startedAt: new Date(t.getTime() + i), createdAt: new Date(t.getTime() + i), requestFile: `/r/${i}.req`, responseFile: `/r/${i}.res`, logPath: `/r/${i}.log`,
                requestHeaders: { org: 'vic' }, requestQueryParams: { dryRun: 'true' }
            })) as never);
            const rows = await storage.getBatchMemberRequestRows(batchId);
            expect(rows.map(r => ({ status: r.status, http: r.httpStatus, text: r.httpStatusText, time: r.runTime, rowStart: r.rowStart, rows: r.rows, reason: r.errorMessage,
                headers: r.requestHeaders, query: r.requestQueryParams, reprocessCount: r.reprocessCount, files: [r.requestFile, r.responseFile, r.logPath], method: r.endpointMethod }))).to.deep.equal([
                { status: 'completed', http: 201, text: 'Created', time: 91, rowStart: 1, rows: '200', reason: undefined, headers: { org: 'vic' }, query: { dryRun: 'true' }, reprocessCount: 0, files: ['/r/1.req', '/r/1.res', '/r/1.log'], method: 'POST' },
                { status: 'error', http: 422, text: 'Unprocessable', time: 92, rowStart: 201, rows: '200', reason: 'HTTP 422', headers: { org: 'vic' }, query: { dryRun: 'true' }, reprocessCount: 0, files: ['/r/2.req', '/r/2.res', '/r/2.log'], method: 'POST' }
            ]);
            expect(rows[0].startedAt).to.be.instanceOf(Date);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
