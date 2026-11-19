// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the app's one log. Every part of the app writes here, in VS Code, the web
 * app and the desktop app alike; the Logs screen shows it, live. It knows no host: each host
 * gives it somewhere to keep its lines (AppLogPersistence) and, in VS Code, a place to mirror
 * start-up (the "DBMN Start-up" Output channel, the one place a failed start can be read when
 * the Hub never opens).
 *
 *   const log = new AppLog({ persistence });
 *   await log.start();                               // the lines kept from before
 *   log.write({ level: 'info', source: 'sign-in', environment: 'Prod', message: 'Signed in' });
 *   const logger = log.logger('sync');               // an IExtensionDiagnosticLogger for old code
 *   const stop = log.subscribe(line => …);           // the Logs screen, live
 *
 * Rules:
 *   - Secrets never get in: every line passes the Redactor when it is written (redact.ts).
 *   - Only the last `keep` lines are kept (5,000 by default), on this computer only. Nothing
 *     here is ever sent anywhere.
 *   - Writing never throws and never waits: a host whose storage fails loses lines, not work.
 *   - debug and trace lines are dropped unless `debug` is on: the engines write a great many.
 *
 * A run's own lines are not kept here: the run's log files hold them (ExecutionLoggingService),
 * and the Logs screen reads those for a run.
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

/** Where a host keeps the lines: a file in VS Code and the desktop app, IndexedDB in a browser. */
export interface AppLogPersistence {
    /** The lines kept from before, oldest first. */
    load(): Promise<LogLine[]>;
    /** Lines written since the last call, oldest first. */
    append(lines: LogLine[]): Promise<void>;
    /** Everything kept, replacing what is there (when appends have grown past what is kept). */
    replace(lines: LogLine[]): Promise<void>;
}

export interface AppLogOptions {
    persistence?: AppLogPersistence;
    /** How many lines to keep (5,000). */
    keep?: number;
    /** Keep debug and trace lines too. */
    debug?: boolean;
    /** How long to gather lines before saving them (1 s). Errors are saved at once. */
    saveAfterMs?: number;
    /** Each line as it is written, for a host's own mirror (VS Code's start-up channel). */
    mirror?: (line: LogLine) => void;
    /** What `logger(...).show()` does: the host opens the Logs screen. */
    onShow?: () => void;
    /** For tests. */
    now?: () => number;
}

/** The longest detail kept on one line. */
const MOST_DETAIL = 8_000;

export class AppLog {
    readonly redactor = new Redactor();
    private readonly keep: number;
    private readonly saveAfterMs: number;
    private persistence?: AppLogPersistence;
    private readonly mirror?: (line: LogLine) => void;
    private readonly now: () => number;
    private debugOn: boolean;
    private onShow?: () => void;
    private buffer: LogLine[] = [];
    private unsaved: LogLine[] = [];
    /** Lines in storage since the last replace: past 1.5 × keep, storage is rewritten. */
    private stored = 0;
    private nextSeq = 1;
    private started = false;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private saving: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<(line: LogLine) => void>();

    constructor(options: AppLogOptions = {}) {
        this.keep = Math.max(1, options.keep ?? 5_000);
        this.saveAfterMs = options.saveAfterMs ?? 1_000;
        this.persistence = options.persistence;
        this.mirror = options.mirror;
        this.onShow = options.onShow;
        this.now = options.now ?? (() => Date.now());
        this.debugOn = options.debug ?? false;
    }

    /**
     * Read the lines kept from before. Lines written before this finishes come after them, so a
     * host can log from its first moment and say where lines are kept once it knows (VS Code
     * knows its storage folder only after it has decided which backend it talks to).
     */
    async start(persistence?: AppLogPersistence): Promise<void> {
        if (this.started) return;
        this.started = true;
        if (persistence) this.persistence = persistence;
        if (!this.persistence) return;
        let previous: LogLine[] = [];
        try {
            previous = (await this.persistence.load()).filter(isLogLine);
        } catch {
            previous = [];
        }
        const lastSeq = previous.reduce((most, l) => Math.max(most, l.seq), 0);
        // lines written while loading get numbers after the kept ones
        const early = this.buffer.map((l, i) => ({ ...l, seq: lastSeq + 1 + i }));
        this.nextSeq = lastSeq + 1 + early.length;
        this.buffer = [...previous, ...early].slice(-this.keep);
        this.stored = previous.length;
        this.unsaved = early;
        if (early.length) this.scheduleSave(true);
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
            this.buffer.push(line);
            if (this.buffer.length > this.keep) this.buffer.splice(0, this.buffer.length - this.keep);
            this.unsaved.push(line);
            this.scheduleSave(line.level === 'error');
            try { this.mirror?.(line); } catch { /* a mirror never stops a line */ }
            for (const listener of [...this.listeners]) {
                try { listener(line); } catch { /* nor does a listener */ }
            }
            return line;
        } catch {
            return undefined;
        }
    }

    /** Every line kept, oldest first. */
    lines(): readonly LogLine[] {
        return this.buffer;
    }

    /** Each new line as it is written. Returns the way to stop. */
    subscribe(listener: (line: LogLine) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Save what is waiting now (before the app closes). */
    async flush(): Promise<void> {
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
            // The run engines' own info lines are their working notes: a run's story is one line
            // per request (from the run's files), so theirs are kept only with debug on
            const quiet = !source && from === 'run' && level === 'info';
            this.write({
                level: quiet ? 'debug' : level,
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
            if (this.stored + lines.length > this.keep * 1.5) {
                await persistence.replace([...this.buffer]);
                this.stored = this.buffer.length;
            } else {
                await persistence.append(lines);
                this.stored += lines.length;
            }
        } catch {
            // storage refused: the lines stay on screen, and are lost at the next start
        }
    }
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

function isLogLine(value: unknown): value is LogLine {
    const l = value as LogLine;
    return !!l && typeof l === 'object' && typeof l.seq === 'number' && typeof l.time === 'number'
        && typeof l.message === 'string' && typeof l.level === 'string' && typeof l.source === 'string';
}
