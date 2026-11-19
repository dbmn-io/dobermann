// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { AppLog, localDay, sourceForTag, type AppLogPersistence, type LogLine } from '../../../services/logging/app-log';
import { AppLogDayFiles, type AppLogFileSystem } from '../../../services/logging/app-log-file';
import { REMOVED } from '../../../services/logging/redact';

class MemoryPersistence implements AppLogPersistence {
    saved: LogLine[] = [];
    fail = false;
    /** Bytes per day, as a test sets them (a day's real size otherwise). */
    sized: Record<string, number> = {};
    removed: string[] = [];
    async sizes() {
        const out: Record<string, number> = { ...this.sized };
        for (const l of this.saved) { const d = localDay(l.time); if (!(d in this.sized)) out[d] = (out[d] ?? 0) + JSON.stringify(l).length + 1; }
        return out;
    }
    async remove(day: string) {
        this.removed.push(day);
        delete this.sized[day];
        this.saved = this.saved.filter(l => localDay(l.time) !== day);
    }
    async append(lines: LogLine[]) {
        if (this.fail) throw new Error('disk full');
        this.saved.push(...lines);
    }
    async days() { return [...new Set(this.saved.map(l => localDay(l.time)))].sort().reverse(); }
    async read(day: string) { return this.saved.filter(l => localDay(l.time) === day); }
}

const clock = (start = 1_000) => { let t = start; return () => t++; };

/** Dobermann issue 7: the app's one log, the same in VS Code, the web app and the desktop app. */
describe('AppLog: the app\'s one log', () => {
    it('writes lines with an increasing number and time, and tells listeners as they come', () => {
        const log = new AppLog({ now: clock() });
        const heard: LogLine[] = [];
        const stop = log.subscribe(l => heard.push(l));
        log.write({ level: 'info', source: 'sync', message: 'Catalogue synced' });
        log.write({ level: 'warn', source: 'sign-in', environment: 'Prod', message: 'Token expires soon' });
        stop();
        log.write({ level: 'info', source: 'app', message: 'not heard' });
        const seqs = log.recent().map(l => l.seq);
        expect(seqs[1] - seqs[0]).to.equal(1);
        expect(seqs[2] - seqs[1]).to.equal(1);
        expect(heard.map(l => l.message)).to.deep.equal(['Catalogue synced', 'Token expires soon']);
        expect(heard[1]).to.include({ level: 'warn', source: 'sign-in', environment: 'Prod' });
    });

    it('numbers lines after the last session\'s, so lines from two sessions keep their order', () => {
        const first = new AppLog({ now: () => 5_000 });
        const a = first.write({ level: 'info', source: 'app', message: 'first session' })!;
        const second = new AppLog({ now: () => 6_000 });
        const b = second.write({ level: 'info', source: 'app', message: 'second session' })!;
        expect(b.seq).to.be.greaterThan(a.seq);
    });

    it('keeps every line: nothing is trimmed, however many', async () => {
        const store = new MemoryPersistence();
        const log = new AppLog({ persistence: store, saveAfterMs: 0 });
        await log.start();
        for (let i = 1; i <= 12_000; i++) log.write({ level: 'info', source: 'sync', message: `line ${i}`, time: i * 2_000 });
        await log.flush();
        expect(store.saved).to.have.length(12_000);
        expect(store.saved[0].message).to.equal('line 1');
    });

    it('keeps what the run history does not hold: a batch\'s events and the engines\' errors; their per-request notes (debug) only with debug on', () => {
        const log = new AppLog();
        const engine = log.logger();
        engine.info('[BatchExecutionEngine] Batch batch_1795062978302_akgfokh paused mid-run: the environment signed out');
        engine.error('[BatchExecutionEngine] Batch batch_1795062978302_akgfokh execution failed', new Error('database is locked'));
        engine.debug('[IndividualExecutionEngine] Starting individual execution exec_1795062978399_q1w2e3r');
        expect(log.recent().map(l => [l.source, l.level])).to.deep.equal([['run', 'info'], ['run', 'error']]);
        expect(log.recent()[1].detail).to.contain('database is locked');
        // Tied to its run, so @run=<the batch> finds it
        expect(log.recent()[0].run).to.deep.equal({ id: 'batch_1795062978302_akgfokh', name: 'batch_1795062978302_akgfokh' });
        log.setDebug(true);
        engine.debug('[IndividualExecutionEngine] Starting individual execution exec_1795062978399_q1w2e3r');
        expect(log.recent()).to.have.length(3);
    });

    it('removes secrets where the line is written: message, detail, data and known values', () => {
        const log = new AppLog();
        log.addSecret('s3cr3t-client-value');
        log.write({
            level: 'error', source: 'sign-in', environment: 'Prod',
            message: 'Token request failed with client_secret=s3cr3t-client-value',
            data: { headers: { Authorization: 'Basic abc', Accept: 'application/json' }, note: 'used s3cr3t-client-value' },
            error: new Error('401 for Bearer abcdefghijklmnopqrstuvwxyz')
        });
        const line = log.recent()[0];
        expect(line.message).to.equal(`Token request failed with client_secret=${REMOVED}`);
        expect(line.detail).to.not.contain('s3cr3t-client-value');
        expect(line.detail).to.not.contain('abcdefghijklmnopqrstuvwxyz');
        expect(line.detail).to.contain('"Accept": "application/json"');
        expect(line.detail).to.contain(`"Authorization": "${REMOVED}"`);
    });

    it('drops debug lines unless asked for them', () => {
        const log = new AppLog();
        log.write({ level: 'debug', source: 'sync', message: 'chatty' });
        expect(log.recent()).to.have.length(0);
        log.setDebug(true);
        log.write({ level: 'debug', source: 'sync', message: 'chatty' });
        expect(log.recent()).to.have.length(1);
    });

    it('never throws: a failing mirror or listener stops nothing', () => {
        const log = new AppLog({ mirror: () => { throw new Error('channel gone'); } });
        log.subscribe(() => { throw new Error('screen gone'); });
        expect(() => log.write({ level: 'info', source: 'app', message: 'still written' })).to.not.throw();
        expect(log.recent()).to.have.length(1);
    });

    it('cuts a very long detail short, saying how much was left out', () => {
        const log = new AppLog();
        log.write({ level: 'info', source: 'sync', message: 'big', detail: 'x'.repeat(20_000) });
        const detail = log.recent()[0].detail!;
        expect(detail.length).to.be.lessThan(8_100);
        expect(detail).to.match(/12,000 more characters\)$/);
    });

    describe('kept', () => {
        it('lines written before the host says where are kept once it does', async () => {
            const store = new MemoryPersistence();
            const log = new AppLog({ saveAfterMs: 0 });
            log.write({ level: 'info', source: 'start-up', message: 'written before start' });
            await log.start(store);
            log.write({ level: 'info', source: 'app', message: 'after' });
            await log.flush();
            expect(store.saved.map(l => l.message)).to.deep.equal(['written before start', 'after']);
            expect(log.store()).to.equal(store);
        });

        it('saves an error at once, without waiting', async () => {
            const store = new MemoryPersistence();
            const log = new AppLog({ persistence: store, saveAfterMs: 60_000 });
            await log.start();
            log.write({ level: 'error', source: 'start-up', message: 'could not start' });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(store.saved.map(l => l.message)).to.deep.equal(['could not start']);
        });

        it('carries on when storage fails', async () => {
            const store = new MemoryPersistence();
            store.fail = true;
            const log = new AppLog({ persistence: store, saveAfterMs: 0 });
            await log.start();
            log.write({ level: 'error', source: 'app', message: 'still here' });
            await log.flush();
            expect(log.recent().map(l => l.message)).to.deep.equal(['still here']);
        });
    });

    describe('logger(): the old logging writes here', () => {
        it('takes the source from the message\'s [Component] tag and drops the tag', () => {
            const log = new AppLog();
            const logger = log.logger();
            logger.info('[OAuthService] Token refreshed');
            logger.warn('[BatchExecutionEngine] Request 4 slow', new Error('timeout'));
            logger.error('[ServiceBootstrap] Could not register', new Error('boom'));
            logger.info('No tag at all');
            expect(log.recent().map(l => [l.source, l.level, l.message])).to.deep.equal([
                ['sign-in', 'info', 'Token refreshed'],
                ['run', 'warn', 'Request 4 slow'],
                ['start-up', 'error', 'Could not register'],
                ['app', 'info', 'No tag at all']
            ]);
            expect(log.recent()[1].detail).to.contain('timeout');
        });

        it('a logger for a source and environment puts them on every line, strings in the message, data in the detail', () => {
            const log = new AppLog();
            const logger = log.logger('sign-in', { environment: 'Test' });
            logger.info('[Anything] Token request', 'to', { tokenUrl: 'https://x.test/token', client_secret: 'shh' });
            const line = log.recent()[0];
            expect(line).to.include({ source: 'sign-in', environment: 'Test', message: 'Token request to' });
            expect(line.detail).to.contain('https://x.test/token').and.not.contain('shh');
        });

        it('show() asks the host to open Logs', () => {
            let shown = 0;
            const log = new AppLog({ onShow: () => { shown++; } });
            log.logger('app').show();
            expect(shown).to.equal(1);
        });
    });

    it('component tags map to sources', () => {
        expect(sourceForTag('OAuth')).to.equal('sign-in');
        expect(sourceForTag('JIT')).to.equal('run');
        expect(sourceForTag('Dobermann')).to.equal('start-up');
        expect(sourceForTag('Compare')).to.equal('reporting');
        expect(sourceForTag('QuickAccess')).to.equal('app');
    });
});

describe('AppLog: kept for a while, by age and by size', () => {
    const MB = 1024 * 1024;
    const NOW = new Date(2026, 10, 19, 12).getTime();
    const dayAgo = (n: number) => localDay(NOW - n * 24 * 60 * 60 * 1000);

    it('deletes days older than it keeps (14 by default), whole days, never today', async () => {
        const store = new MemoryPersistence();
        store.sized = { [dayAgo(30)]: 10, [dayAgo(14)]: 10, [dayAgo(13)]: 10, [dayAgo(0)]: 10 };
        const log = new AppLog({ persistence: store, now: () => NOW });
        await log.start();
        expect(store.removed).to.deep.equal([dayAgo(30), dayAgo(14)]);
    });

    it('then deletes the oldest days while all of them take more than the size; today stays even alone over it', async () => {
        const store = new MemoryPersistence();
        store.sized = { [dayAgo(3)]: 60 * MB, [dayAgo(2)]: 60 * MB, [dayAgo(1)]: 60 * MB, [dayAgo(0)]: 200 * MB };
        const log = new AppLog({ persistence: store, now: () => NOW });
        await log.start();
        expect(store.removed).to.deep.equal([dayAgo(3), dayAgo(2), dayAgo(1)]);
    });

    it('uses the user\'s settings, and checks again when they change', async () => {
        const store = new MemoryPersistence();
        store.sized = { [dayAgo(5)]: 10, [dayAgo(2)]: 10, [dayAgo(0)]: 10 };
        let days = 14;
        const log = new AppLog({ persistence: store, now: () => NOW, retention: () => ({ days, megabytes: 150 }) });
        await log.start();
        expect(store.removed).to.deep.equal([]);
        days = 3;
        await log.prune();
        expect(store.removed).to.deep.equal([dayAgo(5)]);
        expect(log.retention()).to.deep.equal({ days: 3, megabytes: 150 });
        // Nonsense is the default
        days = -2;
        expect(log.retention().days).to.equal(14);
    });

    it('a day alone over the size keeps its lines without their details, and says so once', async () => {
        const store = new MemoryPersistence();
        store.sized = { [dayAgo(0)]: 2 * MB };
        let t = NOW;
        const log = new AppLog({ persistence: store, now: () => t++, retention: () => ({ megabytes: 1 }) });
        await log.start();
        log.write({ level: 'error', source: 'app', message: 'one thing broke', error: new Error('with a long stack') });
        log.write({ level: 'error', source: 'sync', message: 'another broke', error: new Error('and another stack') });
        const lines = log.recent();
        expect(lines.map(l => l.message)).to.deep.equal([
            'Today\'s log is over 1 MB: lines are kept without their details until tomorrow', 'one thing broke', 'another broke'
        ]);
        expect(lines.every(l => !l.detail)).to.equal(true);
    });
});

describe('AppLog: a line written again and again is written once', () => {
    it('lines alike within a second (the same words but for numbers and ids): the first, then how many more', async () => {
        let t = 1_000_000;
        const log = new AppLog({ now: () => t });
        const engine = log.logger();
        for (let i = 1; i <= 2_342; i++) { engine.error(`[BatchExecutionEngine] Member ${i} execution failed`, new Error('ECONNREFUSED')); t += 2; }
        log.write({ level: 'info', source: 'sync', message: 'Catalogue synced' });
        expect(log.recent().map(l => l.message)).to.deep.equal([
            'Member 1 execution failed',
            '…and 2,341 more like "Member 1 execution failed"',
            'Catalogue synced'
        ]);
        expect(log.recent()[0].detail).to.contain('ECONNREFUSED');
    });

    it('lines that differ in words, or come more than a second apart, are each written', () => {
        let t = 1_000_000;
        const log = new AppLog({ now: () => t });
        log.write({ level: 'warn', source: 'sync', message: 'Row 1 slow' });
        log.write({ level: 'warn', source: 'sync', message: 'Row 2 refused' });
        t += 1_500;
        log.write({ level: 'warn', source: 'sync', message: 'Row 3 refused' });
        expect(log.recent().map(l => l.message)).to.deep.equal(['Row 1 slow', 'Row 2 refused', 'Row 3 refused']);
    });

    it('a pause of a second ends the repeats, and flushing does too', async () => {
        let t = 1_000_000;
        const log = new AppLog({ now: () => t });
        log.write({ level: 'warn', source: 'sync', message: 'retry 1' });
        log.write({ level: 'warn', source: 'sync', message: 'retry 2' });
        await log.flush();
        expect(log.recent().map(l => l.message)).to.deep.equal(['retry 1', '…and 1 more like "retry 1"']);
    });
});

describe('AppLogDayFiles: the log kept as a JSON-lines file per day', () => {
    function memoryFs(): AppLogFileSystem & { files: Map<string, string> } {
        const files = new Map<string, string>();
        return {
            files,
            readFile: async (f: string) => {
                if (!files.has(f)) throw new Error('ENOENT');
                return files.get(f)!;
            },
            appendFile: async (f: string, d: string) => { files.set(f, (files.get(f) ?? '') + d); },
            mkdir: async () => undefined,
            readdir: async (dir: string) => [...files.keys()].filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1)),
            stat: async (f: string) => { if (!files.has(f)) throw new Error('ENOENT'); return { size: files.get(f)!.length }; },
            unlink: async (f: string) => { files.delete(f); }
        };
    }
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

    it('puts each line in its own day\'s file, lists the days newest first, reads a day back', async () => {
        const fs = memoryFs();
        const files = new AppLogDayFiles('/logs', fs);
        expect(await files.days()).to.deep.equal([]);
        await files.append([
            { seq: 1, time: at(2026, 11, 18, 23), level: 'info', source: 'app', message: 'late' },
            { seq: 2, time: at(2026, 11, 19, 0), level: 'info', source: 'app', message: 'after midnight' }
        ]);
        await files.append([{ seq: 3, time: at(2026, 11, 19, 9), level: 'warn', source: 'sign-in', message: 'morning' }]);
        expect(await files.days()).to.deep.equal(['2026-11-19', '2026-11-18']);
        expect((await files.read('2026-11-19')).map(l => l.message)).to.deep.equal(['after midnight', 'morning']);
        expect([...fs.files.keys()]).to.deep.equal(['/logs/app-log-2026-11-18.jsonl', '/logs/app-log-2026-11-19.jsonl']);
    });

    it('skips a line cut short when the app stopped, and anything that is not a log line', async () => {
        const fs = memoryFs();
        const files = new AppLogDayFiles('/logs', fs);
        await files.append([{ seq: 1, time: at(2026, 11, 19), level: 'info', source: 'app', message: 'one' }]);
        fs.files.set('/logs/app-log-2026-11-19.jsonl', fs.files.get('/logs/app-log-2026-11-19.jsonl') + '{"nope":true}\n{"seq":3,"ti');
        fs.files.set('/logs/notes.txt', 'not a day');
        expect((await files.read('2026-11-19')).map(l => l.message)).to.deep.equal(['one']);
        expect(await files.days()).to.deep.equal(['2026-11-19']);
    });

    it('says how big each day is, and deletes a day', async () => {
        const fs = memoryFs();
        const files = new AppLogDayFiles('/logs', fs);
        await files.append([{ seq: 1, time: at(2026, 11, 18), level: 'info', source: 'app', message: 'one' }]);
        await files.append([{ seq: 2, time: at(2026, 11, 19), level: 'info', source: 'app', message: 'two' }]);
        const sizes = await files.sizes();
        expect(Object.keys(sizes)).to.deep.equal(['2026-11-19', '2026-11-18']);
        expect(sizes['2026-11-18']).to.be.greaterThan(40);
        await files.remove('2026-11-18');
        expect(await files.days()).to.deep.equal(['2026-11-19']);
    });
});
