// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the app's one log. Every part of the app writes here, in VS Code, the web
 * app and the desktop app alike; the Logs screen shows it, live. It knows no host: each host
 * gives it somewhere to keep its lines (AppLogPersistence) and, in VS Code, a place to mirror
 * start-up (the "DBMN Start-up" Output channel, the one place a failed start can be read when
 * the Hub never opens).
 *
 *   const log = new AppLog();
 *   await log.start(store);                          // where lines are kept (from now on)
 *   log.write({ level: 'info', source: 'sign-in', environment: 'Prod', message: 'Signed in' });
 *   const logger = log.logger('sync');               // an IExtensionDiagnosticLogger for old code
 *   const stop = log.subscribe(line => …);           // the Logs screen, live
 *
 * Rules:
 *   - Secrets never get in: every line passes the Redactor when it is written (redact.ts).
 *   - Lines are kept in a file per day (AppLogDayFiles), on this computer only, and nothing here
 *     is ever sent anywhere. The Logs screen reads the days back (LogReader).
 *   - Kept for a while, by age and by size, whole days at a time (James, 2026-11-19): days older
 *     than `days` (14) go, then the oldest days while all of them take more than `megabytes`
 *     (150); today's never does. Both are settings (dbmn.logs.keepDays, dbmn.logs.mostMegabytes).
 *     Checked when the log starts, every few hours, and whenever it grows past the size.
 *   - A line written again and again (the same words but for its numbers, within a second: a
 *     batch failing on every row) is written once, then "…and 2,341 more like it".
 *   - A day that alone passes the size keeps its lines without their details (stacks) until it
 *     ends, saying so once: a runaway costs kilobytes, not megabytes.
 *   - Nothing is kept twice. Each request a run sends is already in the run history (its status,
 *     error, request and response), and the Logs screen reads it from there; the engines write
 *     their per-request working notes at debug level, which is not kept unless `debug` is on.
 *     What the run history does not hold is kept here: a batch queued, paused, waiting, resumed,
 *     stopped at its error limit, a sign-in refreshed mid-run, and every engine warning and
 *     error (a batch that fails outside any one request, a record it could not save).
 *   - A line that names a run (`batch_…`, `exec_…`) is tied to it, so `@run=` finds it.
 *   - Writing never throws and never waits: a host whose storage fails loses lines, not work.
 *   - debug and trace lines are dropped unless `debug` is on: the engines write a great many.
 */
import type { IExtensionDiagnosticLogger } from './extension-diagnostic-logger.interface';
import { Redactor } from './redact';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Where in the app a line comes from: the Logs screen's Source column. */
export type LogSource =
    | 'start-up' | 'account' | 'sync' | 'sign-in' | 'environments'
    | 'run' | 'import' | 'export' | 'reporting' | 'app';

export const LOG_SOURCES: readonly LogSource[] = [
    'start-up', 'account', 'sync', 'sign-in', 'environments', 'run', 'import', 'export', 'reporting', 'app'
];

/** The run a line is about, so the line can open it. */
export interface LogRun {
    id: string;
    name: string;
    /** The request within the run, from 1. */
    request?: number;
}

export interface LogLine {
    /** Increasing across restarts: the order lines were written in. */
    seq: number;
    /** Milliseconds since 1970 (UTC). */
    time: number;
    level: LogLevel;
    source: LogSource;
    message: string;
    environment?: string;
    run?: LogRun;
    /** More than fits on the line: an error's stack, the data written with it. */
    detail?: string;
}

/** What a writer gives: the line without its place in the log. */
export interface LogEntry {
    level: LogLevel;
    source: LogSource;
    message: string;
    environment?: string;
    run?: LogRun;
    detail?: string;
    /** An error to add to the detail (its stack). */
    error?: unknown;
    /** Data to add to the detail, as JSON. */
    data?: unknown;
    /** For lines that happened earlier than they are written. */
    time?: number;
}

/**
 * Where a host keeps the lines, a file per day (AppLogDayFiles): real files in VS Code and the
 * desktop app, IndexedDB in a browser. Days are the computer's own (localDay).
 */
export interface AppLogPersistence {
    /** Lines written since the last call, oldest first: each goes in its own day's file. */
    append(lines: LogLine[]): Promise<void>;
    /** The days with lines, newest first ('2026-11-19'). */
    days(): Promise<string[]>;
    /** A day's lines, oldest first. */
    read(day: string): Promise<LogLine[]>;
    /** How big each day's file is, in bytes. */
    sizes?(): Promise<Record<string, number>>;
    /** A day's file deleted (the log keeping to its age and size). */
    remove?(day: string): Promise<void>;
}

/** How long, and how much, the log keeps. */
export interface LogRetention {
    days: number;
    megabytes: number;
}

export const DEFAULT_RETENTION: LogRetention = { days: 14, megabytes: 150 };

/** The computer's own day a time falls on: '2026-11-19'. */
export function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface AppLogOptions {
    persistence?: AppLogPersistence;
    /** Keep debug and trace lines, and the run engines' lines, too. */
    debug?: boolean;
    /** How long to gather lines before saving them (1 s). Errors are saved at once. */
    saveAfterMs?: number;
    /** Each line as it is written, for a host's own mirror (VS Code's start-up channel). */
    mirror?: (line: LogLine) => void;
    /** What `logger(...).show()` does: the host opens the Logs screen. */
    onShow?: () => void;
    /** How long and how much to keep (the user's settings); 14 days and 150 MB when not given. */
    retention?: () => Partial<LogRetention>;
    /** For tests. */
    now?: () => number;
}

/** The longest detail kept on one line. */
const MOST_DETAIL = 8_000;
/** Lines alike (the same words but for numbers and ids) within this long are folded into one. */
const REPEAT_MS = 1_000;
/** How often the log checks its age and size while the app stays open. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A run's id as the run history makes them: batch_1795062978302_akgfokh, exec_…. */
const RUN_ID = /\b(?:batch|exec)_\d{10,}_[a-z0-9]+\b/i;
/** Lines this session keeps in memory, for a start that fails before the Logs screen can open. */
const RECENT = 1_000;

export class AppLog {
    readonly redactor = new Redactor();
    private readonly saveAfterMs: number;
    private persistence?: AppLogPersistence;
    private readonly mirror?: (line: LogLine) => void;
    private readonly now: () => number;
    private debugOn: boolean;
    private onShow?: () => void;
    private buffer: LogLine[] = [];
    private unsaved: LogLine[] = [];
    /** Increasing across restarts (a clock that goes back aside): microseconds when this session began. */
    private nextSeq: number;
    private started = false;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private saving: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<(line: LogLine) => void>();
    private retentionOf?: () => Partial<LogRetention>;
    /** Bytes kept, all days and today's, as last counted plus what was saved since. */
    private totalBytes = 0;
    private todayBytes = 0;
    private today = '';
    /** Today is over the size: lines kept without details (said once). */
    private overToday = '';
    private pruning: Promise<void> | undefined;
    private pruneTimer: ReturnType<typeof setInterval> | undefined;
    /** The line being repeated, and how many times since it was written. */
    private repeat: { shape: string; line: LogLine; count: number; last: number } | undefined;
    private repeatTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(options: AppLogOptions = {}) {
        this.saveAfterMs = options.saveAfterMs ?? 1_000;
        this.persistence = options.persistence;
        this.mirror = options.mirror;
        this.onShow = options.onShow;
        this.now = options.now ?? (() => Date.now());
        this.debugOn = options.debug ?? false;
        this.retentionOf = options.retention;
        this.nextSeq = this.now() * 1000;
    }

    /**
     * Say where lines are kept. Lines written before this are kept too, so a host can log from
     * its first moment and say where once it knows (VS Code knows its storage folder only after
     * it has decided which backend it talks to).
     */
    async start(persistence?: AppLogPersistence): Promise<void> {
        if (this.started) return;
        this.started = true;
        if (persistence) this.persistence = persistence;
        if (this.unsaved.length) await this.flush();
        await this.prune();
        this.pruneTimer = setInterval(() => { void this.prune(); }, PRUNE_EVERY_MS);
        (this.pruneTimer as { unref?: () => void }).unref?.();
    }

    /** The user's settings for how long and how much to keep; the log checks again at once. */
    setRetention(retention: (() => Partial<LogRetention>) | undefined): void {
        this.retentionOf = retention;
        void this.prune();
    }

    /** How long and how much to keep, now. */
    retention(): LogRetention {
        let wanted: Partial<LogRetention> = {};
        try { wanted = this.retentionOf?.() ?? {}; } catch { wanted = {}; }
        const whole = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback);
        return { days: whole(wanted.days, DEFAULT_RETENTION.days), megabytes: whole(wanted.megabytes, DEFAULT_RETENTION.megabytes) };
    }

    /**
     * Keep to the age and size: days older than `days` go, then the oldest days while all of
     * them take more than `megabytes`. Today's file is never deleted. Never throws.
     */
    prune(): Promise<void> {
        this.pruning ??= this.pruneNow().catch(() => undefined).finally(() => { this.pruning = undefined; });
        return this.pruning;
    }

    private async pruneNow(): Promise<void> {
        const store = this.persistence;
        if (!store?.sizes || !store.remove || !this.started) return;
        await this.saving;
        const { days, megabytes } = this.retention();
        const most = megabytes * 1024 * 1024;
        const today = localDay(this.now());
        // Kept: today and the days before it, `days` in all
        const firstKept = localDay(this.now() - (days - 1) * DAY_MS);
        const sizes = await store.sizes();
        const oldestFirst = Object.keys(sizes).sort();
        let total = oldestFirst.reduce((sum, day) => sum + (sizes[day] ?? 0), 0);
        for (const day of oldestFirst) {
            if (day === today) break;
            if (day >= firstKept && total <= most) break;
            await store.remove(day);
            total -= sizes[day] ?? 0;
        }
        this.totalBytes = total;
        this.today = today;
        this.todayBytes = sizes[today] ?? 0;
    }

    /** Where the lines are kept, for reading them back (the Logs screen). */
    store(): AppLogPersistence | undefined {
        return this.persistence;
    }

    setDebug(on: boolean): void {
        this.debugOn = on;
    }

    setOnShow(onShow: (() => void) | undefined): void {
        this.onShow = onShow;
    }

    /** A secret the app is using: never written, wherever it appears. */
    addSecret(value: string | undefined | null): void {
        this.redactor.addSecret(value);
    }

    /** Write a line. Never throws. */
    write(entry: LogEntry): LogLine | undefined {
        try {
            if (entry.level === 'debug' && !this.debugOn) return undefined;
            const line = this.lineFor(entry);
            // The same line again within a second: counted, not written (a batch failing on every row)
            const shape = `${line.level}|${line.source}|${line.run?.id ?? ''}|${shapeOf(line.message)}`;
            const repeat = this.repeat;
            if (repeat && repeat.shape === shape && line.time - repeat.last < REPEAT_MS) {
                repeat.count++;
                repeat.last = line.time;
                this.armRepeat();
                return undefined;
            }
            this.endRepeat();
            this.repeat = { shape, line, count: 0, last: line.time };
            this.armRepeat();
            this.keep(line);
            return line;
        } catch {
            return undefined;
        }
    }

    /** A line kept: shown to the mirror and the listeners, saved soon. */
    private keep(line: LogLine): void {
        // Today alone past the size: its lines keep their words, not their details, till it ends
        const day = localDay(line.time);
        if (day !== this.today) { this.today = day; this.todayBytes = 0; }
        const most = this.retention().megabytes * 1024 * 1024;
        if (this.todayBytes > most && line.detail) {
            delete line.detail;
            if (this.overToday !== day) {
                this.overToday = day;
                this.keep({ seq: this.nextSeq++, time: line.time, level: 'warn', source: 'app', message: `Today's log is over ${this.retention().megabytes} MB: lines are kept without their details until tomorrow` });
            }
        }
        try { this.mirror?.(line); } catch { /* a mirror never stops a line */ }
        this.buffer.push(line);
        if (this.buffer.length > RECENT) this.buffer.splice(0, this.buffer.length - RECENT);
        this.unsaved.push(line);
        this.scheduleSave(line.level === 'error');
        for (const listener of [...this.listeners]) {
            try { listener(line); } catch { /* nor does a listener */ }
        }
    }

    /** The repeats of a line come to an end: "…and N more like it". */
    private endRepeat(): void {
        const repeat = this.repeat;
        this.repeat = undefined;
        if (this.repeatTimer) { clearTimeout(this.repeatTimer); this.repeatTimer = undefined; }
        if (!repeat || repeat.count === 0) return;
        const { line, count } = repeat;
        const folded: LogLine = {
            seq: this.nextSeq++, time: repeat.last, level: line.level, source: line.source,
            message: `…and ${count.toLocaleString('en')} more like "${line.message.length > 80 ? `${line.message.slice(0, 80)}…` : line.message}"`
        };
        if (line.environment) folded.environment = line.environment;
        if (line.run) folded.run = line.run;
        this.keep(folded);
    }

    /** A second with no repeat ends it. */
    private armRepeat(): void {
        if (this.repeatTimer) clearTimeout(this.repeatTimer);
        this.repeatTimer = setTimeout(() => { this.repeatTimer = undefined; this.endRepeat(); }, REPEAT_MS);
        (this.repeatTimer as { unref?: () => void }).unref?.();
    }

    /** This session's latest lines, oldest first (the rest are in storage: LogReader reads them). */
    recent(): readonly LogLine[] {
        return this.buffer;
    }

    /** Each new line as it is written. Returns the way to stop. */
    subscribe(listener: (line: LogLine) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Save what is waiting now (before the app closes). */
    async flush(): Promise<void> {
        this.endRepeat();
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        this.saving = this.saving.then(() => this.save());
        await this.saving;
    }

    /**
     * An IExtensionDiagnosticLogger that writes here, for the code that logs through one today.
     * A message's leading `[Component]` tag picks the source when none is given, and is dropped
     * from the line (it names a class, not something a user knows).
     */
    logger(source?: LogSource, where: { environment?: string; run?: LogRun } = {}): IExtensionDiagnosticLogger {
        const write = (level: LogLevel, message: string, error: unknown, args: unknown[]) => {
            const { text, tag } = splitTag(message);
            const strings = args.filter(a => typeof a === 'string') as string[];
            const data = args.filter(a => typeof a !== 'string' && a !== undefined);
            const from = source ?? sourceForTag(tag);
            this.write({
                level,
                source: from,
                message: strings.length ? `${text} ${strings.join(' ')}` : text,
                environment: where.environment,
                run: where.run,
                error,
                data: data.length === 0 ? undefined : data.length === 1 ? data[0] : data
            });
        };
        return {
            info: (message, ...args) => write('info', message, undefined, args),
            warn: (message, ...args) => {
                // old code passes an error as the second argument to warn too
                const [first, ...rest] = args;
                if (first instanceof Error) write('warn', message, first, rest);
                else write('warn', message, undefined, args);
            },
            error: (message, error, ...args) => write('error', message, error, args),
            debug: (message, ...args) => write('debug', message, undefined, args),
            trace: (message, ...args) => write('debug', message, undefined, args),
            show: () => { this.onShow?.(); },
            clear: () => undefined,
            dispose: () => undefined
        };
    }

    private lineFor(entry: LogEntry): LogLine {
        const r = this.redactor;
        const details: string[] = [];
        if (entry.detail) details.push(entry.detail);
        if (entry.error !== undefined && entry.error !== null) details.push(describeError(entry.error));
        if (entry.data !== undefined) details.push(stringify(r.value(entry.data)));
        let detail = details.length ? r.text(details.join('\n')) : undefined;
        if (detail && detail.length > MOST_DETAIL) detail = `${detail.slice(0, MOST_DETAIL)}\n… (${(detail.length - MOST_DETAIL).toLocaleString('en')} more characters)`;
        const line: LogLine = {
            seq: this.nextSeq++,
            time: entry.time ?? this.now(),
            level: entry.level,
            source: entry.source,
            message: r.text(String(entry.message ?? '')).trim()
        };
        if (entry.environment) line.environment = r.text(entry.environment);
        if (entry.run) line.run = { ...entry.run, name: r.text(entry.run.name) };
        else {
            // A line that names a run belongs to it (its name is filled in where it is shown)
            const id = RUN_ID.exec(line.message)?.[0];
            if (id) line.run = { id, name: id };
        }
        if (detail) line.detail = detail;
        return line;
    }

    private scheduleSave(now: boolean): void {
        if (!this.persistence || !this.started) return;
        if (now) {
            void this.flush();
            return;
        }
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saving = this.saving.then(() => this.save());
        }, this.saveAfterMs);
    }

    private async save(): Promise<void> {
        const persistence = this.persistence;
        if (!persistence || this.unsaved.length === 0) return;
        const lines = this.unsaved;
        this.unsaved = [];
        try {
            await persistence.append(lines);
            const bytes = lines.reduce((sum, l) => sum + JSON.stringify(l).length + 1, 0);
            this.totalBytes += bytes;
            this.todayBytes += lines.filter(l => localDay(l.time) === this.today).reduce((sum, l) => sum + JSON.stringify(l).length + 1, 0);
            // Grown past the size: the oldest days go now, not at the next check
            if (this.totalBytes > this.retention().megabytes * 1024 * 1024) void this.prune();
        } catch {
            // storage refused: the lines stay on screen, and are lost at the next start
        }
    }
}

/** A message without its numbers and ids: lines alike have the same shape. */
function shapeOf(message: string): string {
    return message.replace(new RegExp(RUN_ID.source, 'gi'), '·').replace(/\d+/g, '#');
}

/** `[OAuthService] Token refreshed` → the tag and the rest. */
function splitTag(message: string): { text: string; tag?: string } {
    const m = /^\s*\[([^\]]{1,40})\]\s*/.exec(String(message ?? ''));
    return m ? { text: String(message).slice(m[0].length), tag: m[1] } : { text: String(message ?? '') };
}

/** The source the old logging's component tags stand for. */
export function sourceForTag(tag: string | undefined): LogSource {
    if (!tag) return 'app';
    const t = tag.toLowerCase();
    if (/oauth|sign-?in|google|token|auth-gate/.test(t)) return 'sign-in';
    if (/batch|jit|execution|transaction|individual|producer|consumer|fetch|response|parameter|run|progress|retry|reprocess/.test(t)) return 'run';
    if (/bootstrap|dobermann|startup|start-up|activate|recovery/.test(t)) return 'start-up';
    if (/sync|catalogue|catalog/.test(t)) return 'sync';
    if (/account|dbmn-?auth|licen/.test(t)) return 'account';
    if (/environment/.test(t)) return 'environments';
    if (/import/.test(t)) return 'import';
    if (/export/.test(t)) return 'export';
    if (/compare|query|report/.test(t)) return 'reporting';
    return 'app';
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
    return stringify(error);
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

export function isLogLine(value: unknown): value is LogLine {
    const l = value as LogLine;
    return !!l && typeof l === 'object' && typeof l.seq === 'number' && typeof l.time === 'number'
        && typeof l.message === 'string' && typeof l.level === 'string' && typeof l.source === 'string';
}
