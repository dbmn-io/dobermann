// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the Logs screen's controller over a real AppLog and LogReader. The page
 * gets the newest lines, older ones as it scrolls back, and a search over every line kept. Not
 * live: Refresh reads them again.
 */
import { expect } from 'chai';
import { ScreenSession } from '../../../screens/screen-session';
import { LogsController, LOGS_PAGE, LOGS_SEARCHES_KEY } from '../../../screens/logs/logs.controller';
import type { LogsPorts } from '../../../screens/logs/logs.ports';
import { AppLog, localDay, type AppLogPersistence, type LogLine } from '../../../services/logging/app-log';
import { LogReader, type LogRow, type RunRecord } from '../../../services/logging/log-reader';

type Message = Record<string, unknown>;

class Days implements AppLogPersistence {
    lines: LogLine[] = [];
    async append(lines: LogLine[]) { this.lines.push(...lines); }
    async days() { return [...new Set(this.lines.map(l => localDay(l.time)))].sort().reverse(); }
    async read(day: string) { return this.lines.filter(l => localDay(l.time) === day); }
}

async function setUp(opts: { search?: string; runs?: RunRecord[]; prefs?: Map<string, unknown> } = {}) {
    const days = new Days();
    const log = new AppLog({ saveAfterMs: 0 });
    await log.start(days);
    const posted: Message[] = [];
    const saved: Array<{ name: string; text: string }> = [];
    const toasts: string[] = [];
    const runs = opts.runs ?? [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
    const ports: LogsPorts = {
        reader: new LogReader(days, { runs: async () => runs.filter(r => r.executionType !== 'batch_member'), members: async id => runs.filter(r => r.batchId === id) }, () => log.recent()),
        requests: { events: async id => id === 'm3' ? [
            { timestamp: '2026-11-19T09:00:00.900Z', level: 'info', phase: 'preparation', event: 'transaction_created', data: { requestHeaders: { Accept: 'application/json', 'X-Tenant-Pass': 'tp-7781-zz' } } },
            { timestamp: '2026-11-19T09:00:01.000Z', level: 'info', phase: 'execution', event: 'request', http: { method: 'POST', url: 'https://api.customer.test/items', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abcdefghijklmnop', 'X-Company-Key': 'ck_live_9f8e7d6c5b' }, body: '{"itemId":"","password":"hunter22"}' } },
            { timestamp: '2026-11-19T09:00:01.120Z', level: 'error', phase: 'execution', event: 'response', http: { status: 400, statusText: 'Bad Request', duration: 120, body: '{"error":"itemId must not be empty"}' } }
        ] : [] },
        redact: text => log.redactor.text(text),
        files: { save: async (name, text) => { saved.push({ name, text }); return true; } },
        toast: { info: m => toasts.push(`info ${m}`), warn: m => toasts.push(`warn ${m}`), error: m => toasts.push(`error ${m}`) },
        now: () => new Date(2026, 10, 19, 14, 5).getTime(),
        prefs: opts.prefs ? { get: key => opts.prefs!.get(key), update: (key, value) => { opts.prefs!.set(key, value); } } : undefined
    };
    const controller = new LogsController(session, ports, { search: opts.search });
    const write = async (message: string, time: number, over: Partial<LogLine> = {}) => { log.write({ level: 'info', source: 'sign-in', message, time, ...over }); await log.flush(); };
    return { log, days, posted, saved, toasts, controller, write, runs };
}
const of = (posted: Message[], type: string) => posted.filter(m => m.type === type);
const messages = (m: Message) => (m.lines as LogRow[]).map(l => l.message);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Logs screen (controller)', () => {
    it('opens on the newest lines, a page of them, with the search it was asked for', async () => {
        const { posted, controller, write } = await setUp({ search: '@source=sign-in' });
        await write('Hub ready', at(19, 9), { source: 'start-up' });
        await write('Token request refused', at(19, 10), { level: 'error' });
        await controller.handleMessage({ type: 'logs.ready' });
        const first = of(posted, 'logs.lines')[0];
        expect(messages(first)).to.deep.equal(['Token request refused']);
        expect(first).to.include({ done: true, search: '@source=sign-in' });
    });

    it('scrolled back, the page before; nothing is capped', async () => {
        const { posted, controller, days } = await setUp();
        for (let i = 0; i < LOGS_PAGE + 120; i++) days.lines.push({ seq: i + 1, time: at(10 + (i % 9), 9, i % 60), level: 'info', source: 'sync', message: `l${i}` });
        await controller.handleMessage({ type: 'logs.ready' });
        const first = of(posted, 'logs.lines')[0];
        expect(first.lines as LogRow[]).to.have.length(LOGS_PAGE);
        expect(first.done).to.equal(false);
        await controller.handleMessage({ type: 'logs.older' });
        const older = of(posted, 'logs.older')[0];
        expect(older.lines as LogRow[]).to.have.length(120);
        expect(older.done).to.equal(true);
        const keys = [...(first.lines as LogRow[]), ...(older.lines as LogRow[])].map(l => l.key);
        expect(new Set(keys).size).to.equal(LOGS_PAGE + 120);
    });

    it('a search runs over every line kept and replaces what shows; an answer to an older search is dropped', async () => {
        const { posted, controller, write } = await setUp();
        await write('invalid_client, weeks ago', at(1, 9), { level: 'error' });
        await write('Signed in', at(19, 9));
        await controller.handleMessage({ type: 'logs.ready' });
        const slow = controller.handleMessage({ type: 'logs.search', text: 'Signed' });
        await controller.handleMessage({ type: 'logs.search', text: 'invalid_client' });
        await slow;
        const answers = of(posted, 'logs.lines').slice(1);
        expect(answers.map(messages)).to.deep.equal([['invalid_client, weeks ago']]);
    });

    it('Save writes every line the search finds, from all of them, newest first as shown, under a dated name', async () => {
        const { saved, toasts, controller, write } = await setUp();
        await write('refused once', at(2, 9), { level: 'error' });
        await write('fine', at(10, 9));
        await write('refused again', at(18, 9), { level: 'error' });
        await controller.handleMessage({ type: 'logs.ready' });
        await controller.handleMessage({ type: 'logs.search', text: '@level=error' });
        await controller.handleMessage({ type: 'logs.save' });
        expect(saved).to.have.length(1);
        expect(saved[0].name).to.equal('dbmn-log-2026-11-19-1405.txt');
        expect(saved[0].text.trim().split('\n').map(l => l.replace(/^.*sign-in {2}/, ''))).to.deep.equal(['refused again', 'refused once']);
        expect(toasts).to.deep.equal(['info Saved 2 lines to dbmn-log-2026-11-19-1405.txt']);
    });

    it('asked again with a search, the open screen searches for it', async () => {
        const { posted, controller } = await setUp();
        await controller.handleMessage({ type: 'logs.ready' });
        controller.showSearch('@run=7c1e40aa');
        await tick();
        expect(posted).to.deep.include({ type: 'logs.searchFor', text: '@run=7c1e40aa' });
        expect(of(posted, 'logs.lines')).to.have.length(2);
    });

    it('a request\'s line opens its request and response; a header\'s value shows only when harmless, secrets go', async () => {
        const { posted, controller } = await setUp();
        await controller.handleMessage({ type: 'logs.ready' });
        await controller.handleMessage({ type: 'logs.open', open: 'm3', key: 'rm3' });
        const text = String(of(posted, 'logs.opened')[0].text);
        expect(text).to.contain('POST https://api.customer.test/items');
        expect(text).to.contain('Content-Type: application/json');
        expect(text).to.contain('Authorization: [removed]').and.contain('X-Company-Key: [removed]');
        expect(text).to.not.contain('ck_live_9f8e7d6c5b').and.not.contain('abcdefghijklmnop').and.not.contain('hunter22');
        expect(text).to.contain('400 Bad Request (120 ms)').and.contain('itemId must not be empty');
        // The request and its answer come first; headers inside the run log's own data are hidden too
        expect(text.indexOf('Request\n')).to.equal(0);
        expect(text.indexOf('Response\n')).to.be.lessThan(text.indexOf('Everything its run log holds'));
        expect(text).to.not.contain('tp-7781-zz');
        expect(text).to.contain('"Accept": "application/json"');
    });

    it('a key in the search box stops a search still looking, and its answer never lands', async () => {
        const { posted, controller, days } = await setUp();
        for (let d = 1; d <= 20; d++) for (let i = 0; i < 3_000; i++) days.lines.push({ seq: d * 10_000 + i, time: at(d, 9, i % 60), level: 'info', source: 'sync', message: `l${d}.${i}` });
        await controller.handleMessage({ type: 'logs.ready' });
        const looking = controller.handleMessage({ type: 'logs.search', text: 'nowhere to be found' });
        await new Promise(resolve => setTimeout(resolve, 5));
        await controller.handleMessage({ type: 'logs.typing' });
        await looking;
        expect(of(posted, 'logs.lines')).to.have.length(1);   // the first page only
    });

    it('nothing arrives by itself; Refresh reads the lines again, as the search box has them', async () => {
        const batch: RunRecord = { id: 'b1', executionType: 'batch', environment: 'Test', endpointName: 'Create Item', batchConfiguration: { name: 'Load items' }, status: 'completed', startedAt: new Date(at(19, 9)), completedAt: new Date(at(19, 9, 5)) };
        const { posted, controller, write, runs } = await setUp({ runs: [batch] });
        await controller.handleMessage({ type: 'logs.ready' });
        expect(messages(of(posted, 'logs.lines')[0])).to.deep.equal(['Batch completed: 0 done, 0 failed', 'Batch started: 0 requests']);
        await write('Signed in', at(19, 10));
        runs.push({ id: 'm1', batchId: 'b1', executionType: 'batch_member', status: 'completed', rows: '1', endpointMethod: 'POST', endpointPath: '/items', httpStatus: 201, httpStatusText: 'Created', startedAt: new Date(at(19, 9, 1)), completedAt: new Date(at(19, 9, 1)) });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(of(posted, 'logs.lines')).to.have.length(1);
        expect(posted.map(m => m.type)).to.not.include('logs.append');
        await controller.handleMessage({ type: 'logs.refresh', text: '@source=sign-in' });
        expect(messages(of(posted, 'logs.lines')[1])).to.deep.equal(['Signed in']);
        // A batch read before is read again: its new request is there
        await controller.handleMessage({ type: 'logs.refresh', text: '@source=run' });
        expect(messages(of(posted, 'logs.lines')[2])).to.include('Row 1: POST /items → 201 Created');
    });

    it('while it looks, the page hears that it is searching and how far back it has got', async () => {
        const { posted, controller, days } = await setUp();
        for (let d = 1; d <= 18; d++) for (let i = 0; i < 4_000; i++) days.lines.push({ seq: d * 10_000 + i, time: at(d, 9, i % 60), level: 'info', source: 'sync', message: `l${d}.${i}` });
        await controller.handleMessage({ type: 'logs.ready' });
        posted.length = 0;
        await controller.handleMessage({ type: 'logs.search', text: 'nowhere to be found' });
        const types = posted.map(m => m.type);
        expect(types[0]).to.equal('logs.searching');
        expect(types[types.length - 1]).to.equal('logs.lines');
        const said = posted.filter(m => m.type === 'logs.searching');
        expect(said[0]).to.deep.equal({ type: 'logs.searching', value: 0 });
        for (const m of said.slice(1)) expect(m.value).to.be.within(0, 100).and.to.be.a('number');
    });

    // James, 2026-11-23: "that saved search should be everywhere where we have a search box"
    it('the ★\'s saved searches: given to the page as it opens, kept when changed (cleaned), and told back', async () => {
        const prefs = new Map<string, unknown>([[LOGS_SEARCHES_KEY, [{ name: 'Errors', text: '@level=error' }]]]);
        const { posted, controller } = await setUp({ prefs });
        await controller.handleMessage({ type: 'logs.ready' });
        expect(of(posted, 'logs.searches')[0].searches).to.deep.equal([{ name: 'Errors', text: '@level=error' }]);
        await controller.handleMessage({ type: 'logs.saveSearches', searches: [{ name: ' Errors ', text: '@level=error' }, { name: 'errors', text: 'twice' }, { name: 'Sign-in', text: ' @source=sign-in ' }, { name: '', text: 'x' }] });
        const kept = [{ name: 'Errors', text: '@level=error' }, { name: 'Sign-in', text: '@source=sign-in' }];
        expect(prefs.get(LOGS_SEARCHES_KEY)).to.deep.equal(kept);
        expect(of(posted, 'logs.searches').pop()!.searches).to.deep.equal(kept);
    });

    it('no settings store: no saved searches, and nothing breaks', async () => {
        const { posted, controller } = await setUp();
        await controller.handleMessage({ type: 'logs.ready' });
        await controller.handleMessage({ type: 'logs.saveSearches', searches: [{ name: 'A', text: 'a' }] });
        expect(of(posted, 'logs.searches')).to.deep.equal([]);
    });
});
