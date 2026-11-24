// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's Requests tab (#466): one row per request, for dbmn-table's `source`. The shape was
 * agreed with the design system (2026-11-24): what a row shows stays light (previews, counts, sizes);
 * the full bodies are fetched only when a request is opened (#467, requestDetail).
 *
 * Two sources give these rows through one interface: a stored run (stored-run-requests.ts) and,
 * before anything is stored, a planned batch (Run Batch's Review, #470: response fields null,
 * `sent` null, status 'ready').
 */

/** Every status a request can have (the Status column's filter lists the ones present). */
export const REQUEST_STATUSES = ['ready', 'pending', 'running', 'completed', 'error', 'test_failed', 'cancelled', 'split'] as const;

export interface HeaderPair { name: string; value: string }

export interface BodySummary {
    /** The first ~200 characters, on one line. */
    preview: string;
    /** The top-level array's length, when the body is one and was read whole; else null. */
    items: number | null;
    bytes: number | null;
    contentType?: string | null;
}

/** One request as the table shows it. A header pulled out as its own column is a flat key (headerKey). */
export interface RequestRow {
    id: string;
    n: number;
    status: string;
    http: number | null;
    httpText: string | null;
    timeMs: number | null;
    sent: string | null;
    rowStart: number | null;
    rowEnd: number | null;
    method: string;
    url: string;
    query: Record<string, string>;
    request: BodySummary | null;
    response: BodySummary | null;
    requestHeaders: HeaderPair[];
    responseHeaders: HeaderPair[];
    reason: string | null;
    reprocessCount: number;
    hasLogs: boolean;
    [pulledOutHeader: string]: unknown;
}

export interface RequestSort { id: string; dir: 'asc' | 'desc' }

/** A column as the page shows it: what plain words search (shown ones) and @name reaches. */
export interface RequestColumn { id: string; name: string; hidden?: boolean }

export interface RequestPageQuery {
    offset: number;
    limit: number;
    search?: string;
    sort?: RequestSort | null;
    columns?: RequestColumn[];
}

export interface RequestPage { rows: RequestRow[]; total: number; of: number }

/** The View editor's tree (#468): what the run has, by group. Header names as the run actually has them. */
export interface RequestColumnTree {
    run: RequestColumn[];
    request: RequestColumn[];
    response: RequestColumn[];
    requestHeaders: string[];
    responseHeaders: string[];
}

/** Everything about one request, for the transaction window and the cell window (#467). */
export interface RequestDetail {
    id: string;
    method: string;
    url: string;
    query: Record<string, string>;
    requestHeaders: HeaderPair[];
    responseHeaders: HeaderPair[];
    requestBody: string | null;
    responseBody: string | null;
    rows: [number, number] | null;
}

/** Rows that come from somewhere: a stored run, or a planned batch. */
export interface RequestSource {
    page(query: RequestPageQuery): Promise<RequestPage>;
    columnTree(): Promise<RequestColumnTree>;
    detail(id: string): Promise<RequestDetail | undefined>;
}

/** A pulled-out header's column id (and row key): agreed flat, so dbmn-table never reads it as a path. */
export function headerKey(side: 'request' | 'response', name: string): string {
    return `${side} header: ${name.toLowerCase()}`;
}

/** Headers never shown as they are (the same rule as Links' differences). */
export const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey']);
export const MASK = '••••';

export function headerPairs(headers: Record<string, unknown> | undefined | null): HeaderPair[] {
    if (!headers || typeof headers !== 'object') return [];
    return Object.entries(headers).map(([name, value]) => ({
        name,
        value: SECRET_HEADERS.has(name.toLowerCase()) ? MASK : (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
    }));
}

/** The run's columns, in the agreed ids. */
export const RUN_COLUMNS: RequestColumn[] = [
    { id: 'n', name: '#' }, { id: 'status', name: 'Status' }, { id: 'http', name: 'HTTP' }, { id: 'timeMs', name: 'Time' },
    { id: 'sent', name: 'Sent' }, { id: 'rowStart', name: 'Input rows' }, { id: 'reprocessCount', name: 'Reprocessed' },
    { id: 'reason', name: 'Reason' }, { id: 'id', name: 'Execution ID' }
];
export const REQUEST_COLUMNS: RequestColumn[] = [
    { id: 'request', name: 'Request' }, { id: 'method', name: 'Method' }, { id: 'url', name: 'URL' }, { id: 'query', name: 'Query' },
    { id: 'requestBytes', name: 'Request size' }, { id: 'requestHeaders', name: 'Request headers' }
];
export const RESPONSE_COLUMNS: RequestColumn[] = [
    { id: 'response', name: 'Response' }, { id: 'responseBytes', name: 'Response size' }, { id: 'contentType', name: 'Content type' },
    { id: 'responseHeaders', name: 'Response headers' }
];

const PREVIEW_CHARS = 200;
/** A body past this is only previewed: its items aren't counted (the page stays light). */
export const PREVIEW_READ_LIMIT = 64 * 1024;

/** A body as the row shows it. `text` is what was sent or received, as text. */
export function bodySummary(text: string | null | undefined, bytes: number | null, contentType?: string | null): BodySummary | null {
    if (text === null || text === undefined) return null;
    const head = text.length > PREVIEW_READ_LIMIT ? text.slice(0, PREVIEW_READ_LIMIT) : text;
    let items: number | null = null;
    if (text.length <= PREVIEW_READ_LIMIT) {
        try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) items = parsed.length; } catch { /* not JSON */ }
    }
    const flat = head.replace(/\s+/g, ' ').trim();
    return {
        preview: flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + '…' : flat,
        items,
        bytes,
        ...(contentType !== undefined ? { contentType } : {})
    };
}

/** "3" or "3(10)" (a batch's) as a count of rows. */
export function rowCount(rows: string | undefined): number {
    const n = parseInt(String(rows ?? '1'), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

export function urlWithQuery(path: string, query: Record<string, string>): string {
    const pairs = Object.entries(query);
    if (!pairs.length || path.includes('?')) return path;
    return `${path}?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/** A value to sort by: numbers as numbers, blanks last either way. */
export function sortValue(row: RequestRow, id: string): number | string | null {
    if (id === 'requestBytes') return row.request?.bytes ?? null;
    if (id === 'responseBytes') return row.response?.bytes ?? null;
    if (id === 'contentType') return row.response?.contentType ?? null;
    const v = row[id];
    if (v === null || v === undefined || v === '') return null;
    return typeof v === 'number' ? v : String(v).toLowerCase();
}

export function compareRows(sort: RequestSort | null | undefined): (a: RequestRow, b: RequestRow) => number {
    if (!sort) return (a, b) => a.n - b.n;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return (a, b) => {
        const x = sortValue(a, sort.id);
        const y = sortValue(b, sort.id);
        if (x === null && y === null) return a.n - b.n;
        if (x === null) return 1;
        if (y === null) return -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return c !== 0 ? c * dir : a.n - b.n;
    };
}
