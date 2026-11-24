// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's run, as the new top and footer show it (#464, #465; shapes agreed with the design
 * system 2026-11-24): ⓘ's details (what today's Settings tab shows, in one message), and the
 * figures the footer's status box lists (finished) or counts (live). Built from the run's record
 * and its environment as they are now, so a rename or a thread change is said again at once.
 */
import type { EnvironmentConfig } from '../../environmentManager';
import { fillBaseUrl } from '../../utils/environment-url';
import { isProductionEnvironment } from '../../services/ui/production-guard.service';
import { runHeaders } from './run-headers';
import { MASK } from './requests/request-rows';

/** The parts of a run's record the details and figures read. */
export interface RunRecord {
    id: string;
    executionType?: string;
    status: string;
    environment?: string;
    environmentId?: string;
    organization?: string;
    endpointId?: string;
    endpointName?: string;
    endpointMethod?: string;
    endpointPath?: string;
    baseUrl?: string;
    rows?: string;
    startedAt?: Date | string;
    completedAt?: Date | string;
    createdAt?: Date | string;
    batchConfiguration?: { name?: string; stopOnFirstError?: boolean; parallelProcessing?: { enabled?: boolean; maxConcurrency?: number | string } };
    environmentVariables?: Record<string, string>;
    copiedFromBatchId?: string;
    copiedFromEnvironment?: string;
    copiedAt?: Date | string;
    reprocessedFromBatchId?: string;
}

export interface RunDetails {
    name: string;
    renamable: true;
    environment: { name: string; id: string | null; production: boolean };
    headers: Array<{ name: string; value: string }>;
    endpoint: { name: string; id: string | null; method: string };
    url: string;
    errorHandling: 'continue' | 'stopOnFirst' | null;
    errorHandlingEditable: boolean;
    threads: { current: number; max: number; editable: boolean } | null;
    executionId: string;
    kind: 'batch' | 'single';
    started: string | null;
    durationMs: number | null;
    lineage: { copiedFrom?: { runId: string; environment: string | null; at: string | null }; reprocessedFrom?: string } | null;
    variables: Array<{ name: string; value: string }>;
}

export interface RunFigures {
    state: string;
    withErrors: boolean;
    requests: { total: number; done: number };
    rows: { sent: number | null; total: number | null };
    completed: number;
    errors: number;
    reprocessed: number | null;
    started: string | null;
    tookMs: number | null;
    elapsedMs: number | null;
    etaMs: number | null;
    threads: { current: number; max: number } | null;
    errorHandling: 'continue' | 'stopOnFirst' | null;
}

/** A run that may still change: its threads and error handling can be set. */
const UNDER_WAY = new Set(['pending', 'queued', 'preparing', 'running', 'paused']);
/** Requests not yet done. */
const NOT_DONE = new Set(['ready', 'pending', 'queued', 'running']);
/** Variables whose values are never shown (nothing in an environment marks one secret: by name). */
const SECRET_NAME = /pass(word)?|secret|token|(api)?.?key|credential/i;
/** A run's name: as Run Batch and Query keep names. */
export const MAX_RUN_NAME = 100;

const iso = (v: Date | string | undefined): string | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const ms = (v: Date | string | undefined): number | null => {
    const s = iso(v);
    return s ? Date.parse(s) : null;
};

/** The name the Console, History and Logs show: the run's own, else its endpoint's. */
export function runName(run: RunRecord): string {
    return run.batchConfiguration?.name?.trim() || run.endpointName || run.endpointPath || run.id;
}

export function isBatch(run: RunRecord): boolean {
    return run.executionType === 'batch';
}

/** Threads: what the run uses, and the most its environment allows (1 when it allows none at once). */
function threadsOf(run: RunRecord, environment: EnvironmentConfig | undefined): { current: number; max: number } | null {
    if (!isBatch(run)) return null;
    const current = Number(run.batchConfiguration?.parallelProcessing?.maxConcurrency) || 1;
    const parallel = environment?.parallelProcessing;
    const max = parallel && parallel.enabled !== false ? Number(parallel.maxConcurrency) || current : current;
    return { current, max: Math.max(max, current) };
}

export function runDetails(input: {
    run: RunRecord;
    environment?: EnvironmentConfig;
    /** The endpoint still exists (its name is then a link). */
    endpointExists: boolean;
    /** A batch's first request's path, its variables filled (the template's otherwise). */
    requestPath?: string;
}): RunDetails {
    const { run, environment } = input;
    const batch = isBatch(run);
    const headers = runHeaders(run.environmentVariables, run.organization, environment);
    const headerNames = new Set(headers.map(h => h.name.toLowerCase()));
    const base = run.baseUrl || (environment?.baseUrl ? fillBaseUrl(environment.baseUrl, environment.variables) : '');
    const path = input.requestPath || run.endpointPath || '';
    const started = iso(run.startedAt);
    const ended = ms(run.completedAt);
    const underWay = UNDER_WAY.has(run.status);
    const threads = threadsOf(run, environment);
    const copiedFrom = run.copiedFromBatchId
        ? { runId: run.copiedFromBatchId, environment: run.copiedFromEnvironment || null, at: iso(run.copiedAt) }
        : undefined;
    return {
        name: runName(run),
        renamable: true,
        environment: { name: environment?.name || run.environment || '', id: environment?.id ?? null, production: isProductionEnvironment(environment) },
        headers,
        endpoint: { name: run.endpointName || run.endpointPath || '', id: input.endpointExists ? run.endpointId ?? null : null, method: (run.endpointMethod || '').toUpperCase() },
        url: base ? `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}` : path,
        errorHandling: batch ? (run.batchConfiguration?.stopOnFirstError ? 'stopOnFirst' : 'continue') : null,
        errorHandlingEditable: batch && underWay,
        threads: threads ? { ...threads, editable: underWay } : null,
        executionId: run.id,
        kind: batch ? 'batch' : 'single',
        started,
        durationMs: started && ended !== null && !underWay ? ended - Date.parse(started) : null,
        lineage: copiedFrom || run.reprocessedFromBatchId
            ? { ...(copiedFrom ? { copiedFrom } : {}), ...(run.reprocessedFromBatchId ? { reprocessedFrom: run.reprocessedFromBatchId } : {}) }
            : null,
        variables: Object.entries(run.environmentVariables || {})
            .filter(([name]) => !headerNames.has(name.toLowerCase()))
            .map(([name, value]) => ({ name, value: SECRET_NAME.test(name) ? MASK : String(value ?? '') }))
    };
}

/**
 * A batch's input rows, from its record's "requests(lines)": the lines are the file's as read, its header line among
 * them (transaction-preparation writes csvData.length, the header row included), so the rows are one fewer: a file of
 * 1,000 rows says "5(1001)". (Lesson 3 showed "Rows 1,000 of 1,001" beside an Input tab of 1000.) No "(…)": not known.
 */
export function rowsTotal(rows: string | undefined): number | null {
    const both = String(rows ?? '').match(/^\s*(\d+)\s*\((\d+)\)/);
    return both ? Math.max(0, parseInt(both[2], 10) - 1) : null;
}

export function runFigures(input: {
    run: RunRecord;
    environment?: EnvironmentConfig;
    /** Requests by status (a batch's members; a single run: its own). */
    counts: Record<string, number>;
    /** Rows the done requests carried, when the requests were read (null while a run goes: counting them is not cheap). */
    rowsSent?: number | null;
    /** Requests retried at least once, when the requests were read. */
    reprocessed?: number | null;
    /** The engine's estimate while a run goes. */
    progress?: { estimatedEndTime?: number | null } | null;
    now: number;
}): RunFigures {
    const { run, counts, now } = input;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const notDone = Object.entries(counts).reduce((n, [status, c]) => n + (NOT_DONE.has(status) ? c : 0), 0);
    const completed = counts.completed || 0;
    const errors = (counts.error || 0) + (counts.test_failed || 0);
    const started = iso(run.startedAt);
    const startedMs = started ? Date.parse(started) : null;
    const endedMs = ms(run.completedAt);
    const underWay = UNDER_WAY.has(run.status);
    const eta = input.progress?.estimatedEndTime;
    const batch = isBatch(run);
    return {
        state: run.status,
        withErrors: errors > 0 || run.status === 'error' || run.status === 'failed',
        requests: { total, done: total - notDone },
        rows: { sent: input.rowsSent ?? null, total: batch ? rowsTotal(run.rows) : 1 },
        completed,
        errors,
        reprocessed: input.reprocessed ?? null,
        started,
        tookMs: !underWay && startedMs !== null && endedMs !== null ? endedMs - startedMs : null,
        elapsedMs: underWay && startedMs !== null ? Math.max(0, now - startedMs) : null,
        etaMs: underWay && typeof eta === 'number' && eta > now ? eta - now : null,
        threads: threadsOf(run, input.environment),
        errorHandling: batch ? (run.batchConfiguration?.stopOnFirstError ? 'stopOnFirst' : 'continue') : null
    };
}

/** A new name, as the run keeps it; a reason when it isn't kept (the old name comes back). */
export function checkRunName(name: unknown, current: string): { name: string } | { refused: string } {
    const kept = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!kept) return { refused: 'A run needs a name.' };
    if (kept.length > MAX_RUN_NAME) return { refused: `Up to ${MAX_RUN_NAME} characters.` };
    if (kept === current) return { refused: '' };
    return { name: kept };
}
