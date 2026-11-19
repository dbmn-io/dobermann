// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the Logs screen's lines, read from where they are kept, newest first, a page
 * at a time, searched across all of them. Nothing is copied and nothing is left out:
 *
 *   - the app's own lines (sign-in, sync, start-up…): its day files (AppLogDayFiles)
 *   - runs: the run history (executions.db). A batch is a line when it starts and when it ends,
 *     and one line for each request, as each finishes; a single run is one line
 *
 * Search is the tables' own (search-matcher.js), run here over every line, so a search reaches
 * back to the first line kept and not just to what a screen has loaded. A page stops when it
 * has `want` lines, or after looking at `budget` lines (a rare word in a long history is found a
 * piece at a time, and the screen says how far back it has looked).
 *
 * It never holds the thread for long: in the web and desktop apps it runs beside the page, and a
 * key typed in the search box must never wait for it. Every few milliseconds it lets the page in,
 * and it stops the moment `stop()` says a newer search (a key) has come.
 */
import * as searchMatcherScript from '../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../utils/shared-script';
import { localDay, type AppLogPersistence, type LogLevel, type LogLine, type LogRun, type LogSource } from './app-log';

type SearchTerms = unknown;
const { parseSearchExpression, matchesRow } = sharedScript<{
    parseSearchExpression(text: string): SearchTerms;
    matchesRow(terms: SearchTerms, row: unknown, columns: Array<{ id: string; name: string }>, value: (row: unknown, id: string) => unknown): boolean;
}>(searchMatcherScript, 'SearchMatcher');

/** A line as the screen shows it: the app's, or one made from the run history. */
export interface LogRow {
    /** Unique, and orders lines written at the same moment. */
    key: string;
    time: number;
    level: LogLevel;
    source: LogSource;
    message: string;
    environment?: string;
    run?: LogRun;
    detail?: string;
    /** A request with more to show (its request and response): the execution to open. */
    open?: string;
}

/** Where a page ended: the next page starts with the line after it. */
export interface LogCursor {
    time: number;
    key: string;
}

export interface LogPage {
    /** Newest first. */
    lines: LogRow[];
    /** `stop()` said to stop before the page was full. */
    stopped?: boolean;
    /** Where to go on from, when there is more to look at. */
    next?: LogCursor;
    /** Every line has been looked at. */
    done: boolean;
}

/** The part of a run's record a line needs (ExecutionMetadata). */
export interface RunRecord {
    id: string;
    executionType?: string;
    batchId?: string;
    environment?: string;
    endpointName?: string;
    endpointMethod?: string;
    endpointPath?: string;
    rows?: string;
    status?: string;
    createdAt?: Date | string;
    startedAt?: Date | string;
    completedAt?: Date | string;
    errorMessage?: string;
    httpStatus?: number;
    httpStatusText?: string;
    batchConfiguration?: { name?: string };
}

/** The run history: runs (batches and single runs, not a batch's requests), and a batch's requests. */
export interface RunHistory {
    runs(): Promise<RunRecord[]>;
    members(batchId: string): Promise<RunRecord[]>;
    /** A slice of a batch's requests with only what a line needs (Dobermann issue 7): read so, a big batch never holds the page up. */
    memberPage?(batchId: string, offset: number, limit: number): Promise<RunRecord[]>;
}

/** The screen's columns, as the table names them, for `@column` terms. */
export const LOG_COLUMNS = [
    { id: 'time', name: 'Time' },
    { id: 'level', name: 'Level' },
    { id: 'source', name: 'Source' },
    { id: 'environment', name: 'Environment' },
    { id: 'run', name: 'Run' },
    { id: 'message', name: 'Message' }
];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** The computer's own time as the screen shows it, and as it is searched: 2026-11-19 14:03:22.120. */
export function logTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** A line as text, its detail indented under it: what Copy and Save write (dbmn-log.js writes the same). */
export function logRowText(row: LogRow): string {
    const where = [row.environment, row.run?.name || row.run?.id].filter(Boolean).join(' · ');
    const head = `${logTime(row.time)}  ${row.level.toUpperCase().padEnd(5)}  ${row.source}${where ? `  [${where}]` : ''}  ${row.message}`;
    return row.detail ? `${head}\n${row.detail.replace(/^/gm, '    ')}` : head;
}

export function rowFromLine(line: LogLine): LogRow {
    const row: LogRow = { key: `a${String(line.seq).padStart(16, '0')}`, time: line.time, level: line.level, source: line.source, message: line.message };
    if (line.environment) row.environment = line.environment;
    if (line.run) row.run = line.run;
    if (line.detail) row.detail = line.detail;
    return row;
}

const ms = (value: Date | string | undefined): number | undefined => {
    if (value === undefined || value === null) return undefined;
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
};
const FAILED = new Set(['failed', 'error', 'errored', 'timeout']);
const STOPPED = new Set(['cancelled', 'canceled', 'stopped', 'skipped', 'aborted']);
const FINISHED = new Set([...FAILED, ...STOPPED, 'completed', 'complete', 'success', 'succeeded', 'partial', 'completed_with_errors']);

function levelOf(record: RunRecord): LogLevel {
    const status = (record.status ?? '').toLowerCase();
    if (FAILED.has(status) || (record.httpStatus ?? 0) >= 400) return 'error';
    if (STOPPED.has(status)) return 'warn';
    return 'info';
}

/** Has it run to an end (a line is written when a request finishes, not before)? */
export function hasFinished(record: RunRecord): boolean {
    return FINISHED.has((record.status ?? '').toLowerCase()) || record.httpStatus !== undefined;
}

export function runOf(record: RunRecord): LogRun {
    return { id: record.id, name: record.batchConfiguration?.name || record.endpointName || record.id };
}

function answer(record: RunRecord): string {
    const call = [record.endpointMethod, record.endpointPath].filter(Boolean).join(' ');
    const status = record.httpStatus !== undefined ? `${record.httpStatus}${record.httpStatusText ? ` ${record.httpStatusText}` : ''}` : (record.status ?? '');
    const said = record.errorMessage ? ` · ${record.errorMessage}` : '';
    return `${call ? `${call} → ` : ''}${status}${said}`;
}

/** A finished request of a batch, or a single run: one line. */
export function requestRow(record: RunRecord, run: LogRun): LogRow | undefined {
    const time = ms(record.completedAt) ?? ms(record.startedAt);
    if (time === undefined || !hasFinished(record)) return undefined;
    const rows = record.rows && record.rows !== '1' || record.batchId ? `Row${record.rows?.includes('-') ? 's' : ''} ${record.rows ?? ''}: ` : '';
    const row: LogRow = { key: `r${record.id}`, time, level: levelOf(record), source: 'run', message: `${rows}${answer(record)}`, run, open: record.id };
    if (record.environment) row.environment = record.environment;
    return row;
}

/** A batch's own lines: when it started, and how it ended (counted from its requests). */
export function batchRows(batch: RunRecord, members: RunRecord[]): LogRow[] {
    const run = runOf(batch);
    const out: LogRow[] = [];
    const started = ms(batch.startedAt);
    const env = batch.environment ? { environment: batch.environment } : {};
    if (started !== undefined) out.push({ key: `s${batch.id}`, time: started, level: 'info', source: 'run', message: `Batch started: ${members.length.toLocaleString('en')} request${members.length === 1 ? '' : 's'}`, run, ...env });
    const ended = ms(batch.completedAt);
    if (ended !== undefined && hasFinished(batch)) {
        const failed = members.filter(m => levelOf(m) === 'error').length;
        const done = members.filter(m => hasFinished(m) && levelOf(m) !== 'error').length;
        const left = members.length - failed - done;
        const says = [`${done.toLocaleString('en')} done`, `${failed.toLocaleString('en')} failed`, ...(left ? [`${left.toLocaleString('en')} not run`] : [])].join(', ');
        out.push({ key: `t${batch.id}`, time: ended, level: levelOf(batch) === 'error' ? 'error' : failed ? 'warn' : levelOf(batch), source: 'run', message: `Batch ${(batch.status ?? 'ended').toLowerCase()}: ${says}`, run, ...env });
    }
    return out;
}

/** How long the lines of a batch not ended are reused before they are made again. */
const UNFINISHED_KEPT_MS = 15_000;

/** A batch's requests read this many at a time. */
const MEMBER_SLICE = 500;

/** The longest the reader works before letting the page in. */
const SLICE_MS = 8;

/**
 * One turn of the event loop, so a key (or anything else waiting) runs first. A message to
 * itself rather than a timer: a browser may hold a timer back (a tab in the background), and a
 * test's fake clock never runs one.
 */
function letThePageIn(): Promise<void> {
    if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(0);
    });
}

/** Newest first: by time, then key. */
const newestFirst = (a: LogRow, b: LogRow) => b.time - a.time || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
const olderThan = (row: LogRow, cursor: LogCursor) => row.time < cursor.time || (row.time === cursor.time && row.key < cursor.key);

/** Each local day from one time to another, as localDay names them. */
function daysBetween(from: number, to: number): string[] {
    const days: string[] = [];
    const d = new Date(from);
    d.setHours(12, 0, 0, 0);
    const last = localDay(to);
    for (let i = 0; i < 400; i++) {
        const day = localDay(d.getTime());
        days.push(day);
        if (day >= last) break;
        d.setDate(d.getDate() + 1);
    }
    return days;
}

export class LogReader {
    /** A batch's lines, made once: its requests no longer change once it has ended. */
    private readonly made = new Map<string, LogRow[]>();
    /**
     * A batch not ended (running, paused, left unfinished) is made again, but not for every day it
     * spans nor every page of one search: kept a few seconds. (One paused two weeks ago was read
     * fifteen times a page, and a search over a history with a few took minutes: 2026-11-19.)
     */
    private readonly recentlyMade = new Map<string, { at: number; rows: LogRow[] }>();

    /**
     * `recent`: the app's latest lines in memory (AppLog.recent), for those written but not yet
     * saved (lines are saved together, a second at most after they are written).
     */
    constructor(private readonly app: AppLogPersistence | undefined, private readonly history?: RunHistory, private readonly recent?: () => readonly LogLine[]) {}

    /** A batch's lines may change (it is running again, or was resumed): make them again. No id: every batch (Refresh). */
    forget(batchId?: string): void {
        if (batchId) { this.made.delete(batchId); this.recentlyMade.delete(batchId); }
        else { this.made.clear(); this.recentlyMade.clear(); }
    }

    async page(query: { search?: string; before?: LogCursor; want?: number; budget?: number; stop?: () => boolean; progress?: (at: { day: string; oldest: string; newest: string }) => void } = {}): Promise<LogPage> {
        const want = query.want ?? 500;
        const budget = query.budget ?? 50_000;
        const search = (query.search ?? '').trim();
        const terms = search ? parseSearchExpression(search) : undefined;
        const matches = (row: LogRow) => !terms || matchesRow(terms, row, LOG_COLUMNS, (r, id) => valueOf(r as LogRow, id));

        const appDays = this.app ? await this.app.days().catch(() => [] as string[]) : [];
        const runs = this.history ? await this.history.runs().catch(() => [] as RunRecord[]) : [];
        // An app line tied to a run by its id shows the run's name
        const names = new Map(runs.map(r => [r.id, runOf(r).name]));
        const named = (row: LogRow): LogRow => row.run && row.run.name === row.run.id && names.has(row.run.id) ? { ...row, run: { ...row.run, name: names.get(row.run.id)! } } : row;
        // The days each run spans, so a day's lines can be made without reading every run
        const runsByDay = new Map<string, RunRecord[]>();
        for (const run of runs) {
            const start = ms(run.startedAt) ?? ms(run.createdAt);
            if (start === undefined) continue;
            const end = Math.max(start, ms(run.completedAt) ?? (hasFinished(run) ? start : Date.now()));
            for (const day of daysBetween(start, end)) {
                const list = runsByDay.get(day);
                if (list) list.push(run);
                else runsByDay.set(day, [run]);
            }
        }
        const recentByDay = new Map<string, LogLine[]>();
        for (const line of this.recent?.() ?? []) {
            const day = localDay(line.time);
            const list = recentByDay.get(day);
            if (list) list.push(line);
            else recentByDay.set(day, [line]);
        }
        const firstDay = query.before ? localDay(query.before.time) : undefined;
        const days = [...new Set([...appDays, ...recentByDay.keys(), ...runsByDay.keys()])].filter(d => !firstDay || d <= firstDay).sort().reverse();

        const lines: LogRow[] = [];
        let looked = 0;
        // Let the page in every few milliseconds; stop when asked
        let since = Date.now();
        const breathe = async (): Promise<boolean> => {
            if (Date.now() - since < SLICE_MS) return !!query.stop?.();
            await letThePageIn();
            since = Date.now();
            return !!query.stop?.();
        };
        const newest = days[0] ?? '';
        const oldest = days[days.length - 1] ?? '';
        for (const day of days) {
            query.progress?.({ day, oldest, newest });
            if (await breathe()) return { lines, next: lines.length ? { time: lines[lines.length - 1].time, key: lines[lines.length - 1].key } : query.before, done: false, stopped: true };
            const rows: LogRow[] = [];
            const appLines = appDays.includes(day) && this.app ? await this.app.read(day).catch(() => [] as LogLine[]) : [];
            // (a line saved since it was in memory is the same line: once)
            const saved = new Set(appLines.map(l => l.seq));
            for (const line of [...appLines, ...(recentByDay.get(day) ?? []).filter(l => !saved.has(l.seq))]) rows.push(named(rowFromLine(line)));
            for (const run of runsByDay.get(day) ?? []) {
                const made = await this.runRows(run, breathe);
                if (!made) return { lines, next: lines.length ? { time: lines[lines.length - 1].time, key: lines[lines.length - 1].key } : query.before, done: false, stopped: true };
                for (const row of made) if (localDay(row.time) === day) rows.push(row);
                if (await breathe()) return { lines, next: lines.length ? { time: lines[lines.length - 1].time, key: lines[lines.length - 1].key } : query.before, done: false, stopped: true };
            }
            rows.sort(newestFirst);
            for (const row of rows) {
                if (query.before && !olderThan(row, query.before)) continue;
                looked++;
                if (looked % 500 === 0 && await breathe()) return { lines, next: { time: row.time, key: row.key }, done: false, stopped: true };
                if (matches(row)) lines.push(row);
                if (lines.length >= want || looked >= budget) {
                    return { lines, next: { time: row.time, key: row.key }, done: false };
                }
            }
        }
        return { lines, done: true };
    }

    /** Every line of a run, made from its record (and its requests). */
    async runRows(run: RunRecord, pause?: () => Promise<boolean>): Promise<LogRow[] | undefined> {
        if (run.executionType !== 'batch') {
            const row = requestRow(run, runOf(run));
            return row ? [row] : [];
        }
        const made = this.made.get(run.id);
        if (made) return made;
        const recent = this.recentlyMade.get(run.id);
        if (recent && Date.now() - recent.at < UNFINISHED_KEPT_MS) return recent.rows;
        const members = await this.membersOf(run.id, pause);
        if (!members) return undefined;   // stopped part way: nothing kept
        const name = runOf(run);
        const rows = [...batchRows(run, members), ...members.map(m => requestRow({ ...m, environment: m.environment || run.environment }, name)).filter((r): r is LogRow => !!r)];
        // Kept for good once it has ended; not ended, for a few seconds (it may still change)
        if (hasFinished(run)) this.made.set(run.id, rows);
        else this.recentlyMade.set(run.id, { at: Date.now(), rows });
        return rows;
    }

    /**
     * A batch's requests: a slice at a time where the history can (only what a line needs), letting
     * the page in between; undefined when `pause` says to stop.
     */
    private async membersOf(batchId: string, pause?: () => Promise<boolean>): Promise<RunRecord[] | undefined> {
        const history = this.history;
        if (!history) return [];
        if (!history.memberPage) return history.members(batchId).catch(() => [] as RunRecord[]);
        const members: RunRecord[] = [];
        for (let offset = 0; ; offset += MEMBER_SLICE) {
            const slice = await history.memberPage(batchId, offset, MEMBER_SLICE).catch(() => [] as RunRecord[]);
            members.push(...slice);
            if (slice.length < MEMBER_SLICE) return members;
            if (pause && await pause()) return undefined;
        }
    }
}

/** What a column searches: a run by its name or its id. */
export function valueOf(row: LogRow, id: string): unknown {
    switch (id) {
        case 'time': return logTime(row.time);
        case 'run': return row.run ? { name: row.run.name, id: row.run.id } : '';
        default: return (row as unknown as Record<string, unknown>)[id] ?? '';
    }
}
