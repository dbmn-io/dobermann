// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the Logs screen reads every line from where it is kept, the app's day files
 * and the run history, merged by time, newest first, with nothing capped or copied.
 */
import { expect } from 'chai';
import { localDay, type AppLogPersistence, type LogLine } from '../../../services/logging/app-log';
import { LogReader, logRowText, type LogCursor, type LogRow, type RunHistory, type RunRecord } from '../../../services/logging/log-reader';

const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime();

class Days implements AppLogPersistence {
    constructor(public lines: LogLine[] = []) {}
    async append(lines: LogLine[]) { this.lines.push(...lines); }
    async days() { return [...new Set(this.lines.map(l => localDay(l.time)))].sort().reverse(); }
    async read(day: string) { return this.lines.filter(l => localDay(l.time) === day); }
}
let seq = 1;
const line = (time: number, message: string, over: Partial<LogLine> = {}): LogLine => ({ seq: seq++, time, level: 'info', source: 'sign-in', message, ...over });

/** A batch of `n` requests, one a second from `start`; request 3 refused. */
function batch(id: string, name: string, start: number, n: number, status = 'completed'): { run: RunRecord; members: RunRecord[] } {
    const members = Array.from({ length: n }, (_, i): RunRecord => ({
        id: `${id}-m${i + 1}`, batchId: id, executionType: 'batch_member', environment: 'Test', endpointMethod: 'POST', endpointPath: '/items',
        rows: String(i + 1), status: i === 2 ? 'failed' : 'completed', httpStatus: i === 2 ? 400 : 201, httpStatusText: i === 2 ? 'Bad Request' : 'Created',
        errorMessage: i === 2 ? 'itemId must not be empty' : undefined,
        startedAt: new Date(start + i * 1000), completedAt: new Date(start + i * 1000 + 500)
    }));
    const run: RunRecord = {
        id, executionType: 'batch', environment: 'Test', endpointName: 'Create Item', batchConfiguration: { name }, status,
        startedAt: new Date(start - 100), completedAt: status === 'running' ? undefined : new Date(start + n * 1000)
    };
    return { run, members };
}
function history(...batches: Array<{ run: RunRecord; members: RunRecord[] }>): RunHistory & { reads: number } {
    const h = {
        reads: 0,
        runs: async () => batches.map(b => b.run),
        members: async (id: string) => { h.reads++; return batches.find(b => b.run.id === id)?.members ?? []; }
    };
    return h;
}
async function all(reader: LogReader, search = '', want = 7): Promise<LogRow[]> {
    const rows: LogRow[] = [];
    let before: LogCursor | undefined;
    for (let i = 0; i < 1000; i++) {
        const page = await reader.page({ search, before, want, budget: 5 });
        rows.push(...page.lines);
        if (page.done) return rows;
        before = page.next;
    }
    throw new Error('never done');
}

describe('LogReader: every line, from where it is kept', () => {
    it('merges the app\'s days and the runs by time, newest first, across days', async () => {
        const app = new Days([line(at(17, 9), 'Signed in to Test'), line(at(19, 8), 'Signed in again')]);
        const reader = new LogReader(app, history(batch('b1', 'Load items', at(18, 10), 4)));
        const page = await reader.page({ want: 100 });
        expect(page.done).to.equal(true);
        expect(page.lines.map(r => r.message)).to.deep.equal([
            'Signed in again',
            'Batch completed: 3 done, 1 failed',
            'Row 4: POST /items → 201 Created',
            'Row 3: POST /items → 400 Bad Request · itemId must not be empty',
            'Row 2: POST /items → 201 Created',
            'Row 1: POST /items → 201 Created',
            'Batch started: 4 requests',
            'Signed in to Test'
        ]);
        const refused = page.lines[3];
        expect(refused).to.include({ level: 'error', source: 'run', environment: 'Test', open: 'b1-m3' });
        expect(refused.run).to.deep.equal({ id: 'b1', name: 'Load items' });
    });

    it('pages back without missing or repeating a line, however the pages fall', async () => {
        const app = new Days(Array.from({ length: 30 }, (_, i) => line(at(10 + (i % 5), 9, i), `app ${i}`)));
        const reader = new LogReader(app, history(batch('b1', 'One', at(12, 9, 10), 25), batch('b2', 'Two', at(14, 9, 40), 12)));
        const everything = (await reader.page({ want: 10_000 })).lines;
        const paged = await all(reader);
        expect(paged.map(r => r.key)).to.deep.equal(everything.map(r => r.key));
        expect(new Set(paged.map(r => r.key)).size).to.equal(30 + 25 + 2 + 12 + 2);
    });

    it('searches every line kept, not only the newest: a rare word weeks back is found', async () => {
        const app = new Days([line(at(1, 9), 'Token request refused: invalid_client', { level: 'error' })]);
        for (let d = 2; d <= 28; d++) for (let i = 0; i < 20; i++) app.lines.push(line(at(d, 9, i), `ordinary ${d}.${i}`));
        const reader = new LogReader(app);
        const found = await all(reader, 'invalid_client');
        expect(found.map(r => r.message)).to.deep.equal(['Token request refused: invalid_client']);
        // A page that looked as far as it may without finding it says where to go on from
        const first = await reader.page({ search: 'invalid_client', budget: 100 });
        expect(first).to.include({ done: false });
        expect(first.lines).to.have.length(0);
        expect(first.next!.time).to.be.lessThan(at(28, 0));
    });

    it('searches with the tables\' terms: a level, a source, a run by its name or its id', async () => {
        const reader = new LogReader(new Days([line(at(19, 8), 'Signed in')]), history(batch('7c1e40aa', 'Load items', at(19, 9), 5)));
        const count = async (search: string) => (await reader.page({ search, want: 100 })).lines.length;
        expect(await count('@level=error')).to.equal(1);
        expect(await count('@source=sign-in')).to.equal(1);
        expect(await count('@run=7c1e40aa')).to.equal(7);
        expect(await count('@run="Load items" @level=info')).to.equal(5);
        expect(await count('itemId')).to.equal(1);
        expect(await count('@source!=run')).to.equal(1);
    });

    it('a request is a line once it has finished; a batch still going has no end line yet', async () => {
        const going = batch('b9', 'Going', at(19, 9), 3, 'running');
        going.members[2] = { ...going.members[2], status: 'pending', httpStatus: undefined, completedAt: undefined, startedAt: undefined };
        const h = history(going);
        const reader = new LogReader(new Days(), h);
        const lines = (await reader.page({ want: 100 })).lines.map(r => r.message);
        expect(lines).to.deep.equal(['Row 2: POST /items → 201 Created', 'Row 1: POST /items → 201 Created', 'Batch started: 3 requests']);
        // A finished batch's lines are made once; a running one's each time it is read
        await reader.page({ want: 100 });
        expect(h.reads).to.equal(2);
    });

    it('a single run is one line, and a line as text has its detail under it', async () => {
        const single: RunRecord = { id: 'x1', executionType: 'individual', environment: 'Prod', endpointName: 'Get item', endpointMethod: 'GET', endpointPath: '/items/1', rows: '1', status: 'completed', httpStatus: 200, httpStatusText: 'OK', startedAt: new Date(at(19, 10)), completedAt: new Date(at(19, 10, 0, 1)) };
        const reader = new LogReader(new Days([line(at(19, 9), 'Refresh failed', { level: 'warn', detail: 'Error: 401\n    at refresh' })]), { runs: async () => [single], members: async () => [] });
        const rows = (await reader.page({ want: 10 })).lines;
        expect(rows[0]).to.include({ message: 'GET /items/1 → 200 OK', open: 'x1' });
        expect(rows[0].run).to.deep.equal({ id: 'x1', name: 'Get item' });
        expect(logRowText(rows[1])).to.match(/^2026-11-19 09:00:00\.000 {2}WARN {3}sign-in {2}Refresh failed\n {4}Error: 401\n {8}at refresh$/);
    });
});

describe('LogReader: lines not yet saved', () => {
    it('reads the latest lines from memory too, each once, whether saved yet or not', async () => {
        const saved = line(at(19, 9), 'saved already');
        const app = new Days([saved]);
        const unsaved = line(at(19, 9, 0, 1), 'written a moment ago');
        const reader = new LogReader(app, undefined, () => [saved, unsaved]);
        expect((await reader.page()).lines.map(r => r.message)).to.deep.equal(['written a moment ago', 'saved already']);
    });
});

describe('LogReader: an engine\'s line about a run', () => {
    it('shows the run\'s name, and is found with the run\'s other lines', async () => {
        const app = new Days([line(at(18, 10, 2), 'Batch b1 paused mid-run: the environment signed out', { source: 'run', run: { id: 'b1', name: 'b1' } })]);
        const reader = new LogReader(app, history(batch('b1', 'Load items', at(18, 10), 4)));
        const rows = (await reader.page({ search: '@run="Load items" paused' })).lines;
        expect(rows.map(r => [r.message, r.run?.name])).to.deep.equal([['Batch b1 paused mid-run: the environment signed out', 'Load items']]);
    });
});

describe('LogReader: never holds up typing', () => {
    it('lets the page in every few milliseconds, and stops the moment it is told to', async () => {
        const app = new Days();
        for (let d = 1; d <= 28; d++) for (let i = 0; i < 2_000; i++) app.lines.push(line(at(d, 9, 0, i % 60), `ordinary ${d}.${i}`));
        const reader = new LogReader(app);
        // A timer due every moment runs while the reader is looking: the page gets in, often
        let last = Date.now();
        let longest = 0;
        const timer = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 0);
        let stop = false;
        setTimeout(() => { stop = true; }, 120);
        const page = await reader.page({ search: 'never there', budget: 1_000_000, stop: () => stop });
        clearInterval(timer);
        expect(page).to.include({ done: false, stopped: true });
        expect(longest, 'the longest the page waited (ms)').to.be.lessThan(80);
    });
});
