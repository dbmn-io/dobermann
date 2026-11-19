// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { AppLog, sourceForTag, type AppLogPersistence, type LogLine } from '../../../services/logging/app-log';
import { AppLogFile, type AppLogFileSystem } from '../../../services/logging/app-log-file';
import { REMOVED } from '../../../services/logging/redact';

class MemoryPersistence implements AppLogPersistence {
    saved: LogLine[] = [];
    appends = 0;
    replaces = 0;
    fail = false;
    constructor(previous: LogLine[] = []) { this.saved = [...previous]; }
    async load() { return [...this.saved]; }
    async append(lines: LogLine[]) {
        if (this.fail) throw new Error('disk full');
        this.appends++;
        this.saved.push(...lines);
    }
    async replace(lines: LogLine[]) {
        if (this.fail) throw new Error('disk full');
        this.replaces++;
        this.saved = [...lines];
    }
}

const clock = () => { let t = 1_000; return () => t++; };

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
        expect(log.lines().map(l => l.seq)).to.deep.equal([1, 2, 3]);
        expect(heard.map(l => l.message)).to.deep.equal(['Catalogue synced', 'Token expires soon']);
        expect(heard[1]).to.include({ level: 'warn', source: 'sign-in', environment: 'Prod', time: 1001 });
    });

    it('keeps only the last lines it is asked to keep', () => {
        const log = new AppLog({ keep: 3 });
        for (let i = 1; i <= 5; i++) log.write({ level: 'info', source: 'app', message: `line ${i}` });
        expect(log.lines().map(l => l.message)).to.deep.equal(['line 3', 'line 4', 'line 5']);
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
        const line = log.lines()[0];
        expect(line.message).to.equal(`Token request failed with client_secret=${REMOVED}`);
        expect(line.detail).to.not.contain('s3cr3t-client-value');
        expect(line.detail).to.not.contain('abcdefghijklmnopqrstuvwxyz');
        expect(line.detail).to.contain('"Accept": "application/json"');
        expect(line.detail).to.contain(`"Authorization": "${REMOVED}"`);
    });

    it('drops debug lines unless asked for them', () => {
        const log = new AppLog();
        log.write({ level: 'debug', source: 'run', message: 'chatty' });
        expect(log.lines()).to.have.length(0);
        log.setDebug(true);
        log.write({ level: 'debug', source: 'run', message: 'chatty' });
        expect(log.lines()).to.have.length(1);
    });

    it('never throws: a failing mirror or listener stops nothing', () => {
        const log = new AppLog({ mirror: () => { throw new Error('channel gone'); } });
        log.subscribe(() => { throw new Error('screen gone'); });
        expect(() => log.write({ level: 'info', source: 'app', message: 'still written' })).to.not.throw();
        expect(log.lines()).to.have.length(1);
    });

    it('cuts a very long detail short, saying how much was left out', () => {
        const log = new AppLog();
        log.write({ level: 'info', source: 'run', message: 'big', detail: 'x'.repeat(20_000) });
        const detail = log.lines()[0].detail!;
        expect(detail.length).to.be.lessThan(8_100);
        expect(detail).to.match(/12,000 more characters\)$/);
    });

    describe('kept across a restart', () => {
        it('reads the lines from before, then numbers new ones after them, early lines included', async () => {
            const before: LogLine[] = [
                { seq: 41, time: 1, level: 'info', source: 'start-up', message: 'old 1' },
                { seq: 42, time: 2, level: 'error', source: 'sign-in', message: 'old 2' }
            ];
            const store = new MemoryPersistence(before);
            const log = new AppLog({ persistence: store, saveAfterMs: 0 });
            log.write({ level: 'info', source: 'start-up', message: 'written before start' });
            await log.start();
            log.write({ level: 'info', source: 'app', message: 'after' });
            await log.flush();
            expect(log.lines().map(l => [l.seq, l.message])).to.deep.equal([
                [41, 'old 1'], [42, 'old 2'], [43, 'written before start'], [44, 'after']
            ]);
            expect(store.saved.map(l => l.seq)).to.deep.equal([41, 42, 43, 44]);
        });

        it('rewrites the store once appends grow past half again what is kept', async () => {
            const store = new MemoryPersistence();
            const log = new AppLog({ persistence: store, keep: 4, saveAfterMs: 0 });
            await log.start();
            for (let i = 1; i <= 7; i++) {
                log.write({ level: 'info', source: 'app', message: `l${i}` });
                await log.flush();
            }
            expect(store.replaces).to.be.greaterThan(0);
            expect(store.saved.length).to.be.at.most(6);
            expect(store.saved[store.saved.length - 1].message).to.equal('l7');
        });

        it('saves an error at once, without waiting', async () => {
            const store = new MemoryPersistence();
            const log = new AppLog({ persistence: store, saveAfterMs: 60_000 });
            await log.start();
            log.write({ level: 'error', source: 'start-up', message: 'could not start' });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(store.saved.map(l => l.message)).to.deep.equal(['could not start']);
        });

        it('carries on when storage fails, and ignores a store it cannot read', async () => {
            const broken: AppLogPersistence = {
                load: async () => { throw new Error('unreadable'); },
                append: async () => { throw new Error('disk full'); },
                replace: async () => { throw new Error('disk full'); }
            };
            const log = new AppLog({ persistence: broken, saveAfterMs: 0 });
            await log.start();
            log.write({ level: 'error', source: 'app', message: 'still here' });
            await log.flush();
            expect(log.lines().map(l => l.message)).to.deep.equal(['still here']);
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
            expect(log.lines().map(l => [l.source, l.level, l.message])).to.deep.equal([
                ['sign-in', 'info', 'Token refreshed'],
                ['run', 'warn', 'Request 4 slow'],
                ['start-up', 'error', 'Could not register'],
                ['app', 'info', 'No tag at all']
            ]);
            expect(log.lines()[1].detail).to.contain('timeout');
        });

        it('keeps the run engines\' own info lines only with debug on; their warnings and errors always', () => {
            const log = new AppLog();
            const logger = log.logger();
            logger.info('[BatchExecutionEngine] Chunk 3 prepared');
            logger.warn('[BatchExecutionEngine] Request 4 slow');
            log.logger('run').info('[Anything] Run started');
            expect(log.lines().map(l => l.message)).to.deep.equal(['Request 4 slow', 'Run started']);
        });

        it('a logger for a source and environment puts them on every line, strings in the message, data in the detail', () => {
            const log = new AppLog();
            const logger = log.logger('sign-in', { environment: 'Test' });
            logger.info('[Anything] Token request', 'to', { tokenUrl: 'https://x.test/token', client_secret: 'shh' });
            const line = log.lines()[0];
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

describe('AppLogFile: the log kept as JSON lines', () => {
    function memoryFs(): AppLogFileSystem & { files: Map<string, string> } {
        const files = new Map<string, string>();
        return {
            files,
            readFile: async (f: string) => {
                if (!files.has(f)) throw new Error('ENOENT');
                return files.get(f)!;
            },
            appendFile: async (f: string, d: string) => { files.set(f, (files.get(f) ?? '') + d); },
            writeFile: async (f: string, d: string) => { files.set(f, d); },
            mkdir: async () => undefined
        };
    }

    it('appends, replaces and reads back, skipping a line cut short', async () => {
        const fs = memoryFs();
        const file = new AppLogFile('/logs/app-log.jsonl', fs);
        expect(await file.load()).to.deep.equal([]);
        await file.append([{ seq: 1, time: 1, level: 'info', source: 'app', message: 'one' }]);
        await file.append([{ seq: 2, time: 2, level: 'warn', source: 'app', message: 'two' }]);
        fs.files.set('/logs/app-log.jsonl', fs.files.get('/logs/app-log.jsonl') + '{"seq":3,"ti');
        expect((await file.load()).map(l => l.message)).to.deep.equal(['one', 'two']);
        await file.replace([{ seq: 2, time: 2, level: 'warn', source: 'app', message: 'two' }]);
        expect((await file.load()).map(l => l.seq)).to.deep.equal([2]);
    });

    it('an AppLog over the file comes back after a restart', async () => {
        const fs = memoryFs();
        const first = new AppLog({ persistence: new AppLogFile('/l.jsonl', fs), saveAfterMs: 0 });
        await first.start();
        first.write({ level: 'info', source: 'start-up', message: 'started' });
        await first.flush();
        const second = new AppLog({ persistence: new AppLogFile('/l.jsonl', fs) });
        await second.start();
        expect(second.lines().map(l => l.message)).to.deep.equal(['started']);
    });
});
