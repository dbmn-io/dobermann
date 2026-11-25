// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A stored run's requests as Requests rows (#466). Light on purpose (James, 2026-11-20: "let's be
 * efficient with resources"): the run's records (only the columns a row needs) give every row's
 * figures and are kept until the run changes; a request's two files (what was sent, what came back)
 * are opened only for the rows on the page asked for, one at a time.
 *
 * A search that reaches the bodies or the response headers opens every request's files once. It
 * never holds the page (in the web and desktop apps this shares the page's thread): it works in
 * slices of a few milliseconds, a newer search stops it, and only the matching ids are kept until
 * the run changes. Measured on a generated run of 5,000 requests of 200 items: see the commit.
 * The columns that live only in the files (content type, sizes, response headers) don't sort: a sort
 * would open all of them on every change of a live run.
 */
import * as searchMatcherScript from '../../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../../utils/shared-script';
import { isEmptyRequestBody } from '../../../services/console/request-body';
import {
    RESPONSE_COLUMNS, REQUEST_COLUMNS, RUN_COLUMNS, bodySummary, compareRows, headerKey, headerPairs, rowCount, urlWithQuery,
    type HeaderPair, type RequestColumn, type RequestColumnTree, type RequestDetail, type RequestPage, type RequestPageQuery,
    type RequestRow, type RequestSort, type RequestSource
} from './request-rows';

interface SearchPlan {
    terms: { columns: string[]; test(value: unknown): boolean }[];
    rowMatches(hit: (term: number) => boolean): boolean;
}
const { parseSearchExpression, planSearch } = sharedScript<{ parseSearchExpression(text: string): unknown; planSearch(parsed: unknown, columns: unknown[]): SearchPlan }>(searchMatcherScript, 'SearchMatcher');

/** A request's record: what a row is made from (storage's BatchMemberRequestRow, or a whole record). */
export interface RequestRecord {
    id: string;
    status: string;
    httpStatus?: number;
    httpStatusText?: string;
    runTime?: number;
    startedAt?: Date | string;
    rowStart?: number;
    rows?: string;
    endpointMethod?: string;
    endpointPath?: string;
    requestHeaders?: Record<string, string>;
    requestQueryParams?: Record<string, string>;
    errorMessage?: string;
    reprocessCount?: number;
    logPath?: string;
    requestFile?: string;
    responseFile?: string;
}

/** What the source reads: the run's requests (in the order they were made) and their files. */
export interface StoredRunPorts {
    requests(): Promise<RequestRecord[]>;
    files: {
        exists(path: string): boolean;
        read(path: string): string;
    };
    /** How many requests have each status, counted by the store (cheap: no records read). */
    countByStatus?: () => Promise<Record<string, number>>;
    /** Lets the page breathe between slices of a long search (a test can make it immediate). */
    yieldNow?: () => Promise<void>;
}

/** A request's two files, read. */
interface ReadFiles {
    requestBody: string | null;
    requestBytes: number | null;
    responseBody: string | null;
    responseBytes: number | null;
    responseHeaders: HeaderPair[];
}

/** Columns whose values are only in the files. */
/** Byte lengths, in Node and the browser alike. */
const utf8 = new TextEncoder();
/** A request that has had its answer: its response is expected. */
const FINISHED = new Set(['completed', 'error', 'test_failed', 'failed']);
const FILE_COLUMNS = new Set(['request', 'response', 'contentType', 'responseHeaders', 'requestBytes', 'responseBytes']);
export const needsFiles = (id: string) => FILE_COLUMNS.has(id) || id.startsWith('response header: ');

/** The Requests tab's columns shown before the page says (the default View). */
const DEFAULT_COLUMNS: RequestColumn[] = [
    ...RUN_COLUMNS.filter(c => ['n', 'status', 'http', 'timeMs', 'sent', 'rowStart', 'reprocessCount'].includes(c.id)),
    { id: 'request', name: 'Request' }, { id: 'response', name: 'Response' },
    { id: 'requestHeaders', name: 'Request headers' }, { id: 'responseHeaders', name: 'Response headers' }
];

/** Response header names kept for the tree: past this, a run with odd headers stops adding. */
const MAX_HEADER_NAMES = 500;
/** Responses read for the tree's header names before any page is. */
const TREE_SAMPLE = 20;
/** The longest a search works before letting the page breathe. */
const SLICE_MS = 12;

const breathe = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class StoredRunRequests implements RequestSource {
    private version = 0;
    /** The run's records, until it changes. */
    private records: { version: number; list: RequestRecord[] } | null = null;
    /** One search's answer over the files (the matching ids), until the run changes. */
    private kept: { key: string; version: number; ids: Set<string> } | null = null;
    /** The search working through the files now; a newer one stops it. */
    private scan: { key: string; token: number; done: Promise<Set<string> | null> } | null = null;
    private token = 0;
    private readonly responseHeaderNames = new Map<string, string>();

    constructor(private readonly ports: StoredRunPorts) {}

    /** The run changed (a request ran, was reprocessed): its records and file answers are read again. */
    changed(): void {
        this.version++;
        this.records = null;
    }

    /**
     * Whether the requests as last read include one in flight. Such a reading can be behind: a result is told before
     * its status is stored, and the last request of a run that doesn't end has no later word.
     */
    heldUnfinished(): boolean {
        return !!this.records && this.records.list.some(r => r.status === 'running');
    }

    /**
     * Reads the run's requests again and says whether a status differs from the last reading (then that reading is
     * the new one). For a request last read in flight whose end was never told.
     */
    async readAgainForChange(): Promise<boolean> {
        const held = this.records;
        if (!held) return false;
        const now = await this.ports.requests();
        if (this.records !== held) return false;   // read again meanwhile
        const was = new Map(held.list.map(r => [r.id, r.status]));
        const differs = now.length !== held.list.length || now.some(r => was.get(r.id) !== r.status);
        if (differs) this.changed();
        return differs;
    }

    /** How many requests have each status (the live `changed` message, the Status filter). */
    async counts(): Promise<{ total: number; counts: Record<string, number> }> {
        // (counted by the store while the records aren't held: a live run's tab counts stay cheap)
        if (!this.records && this.ports.countByStatus) {
            const counts = await this.ports.countByStatus();
            return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
        }
        const requests = await this.list();
        const counts: Record<string, number> = {};
        for (const r of requests) counts[r.status || 'pending'] = (counts[r.status || 'pending'] || 0) + 1;
        return { total: requests.length, counts };
    }

    async page(query: RequestPageQuery): Promise<RequestPage> {
        const requests = await this.list();
        // (the Status heading's filter: only the statuses ticked; `of` stays the run's whole size)
        const only = Array.isArray(query.statuses) ? new Set(query.statuses.map(String)) : null;
        const all = requests.map((r, i) => recordRow(r, i + 1));
        const rows = only ? all.filter(r => only.has(r.status)) : all;
        const byId = new Map(requests.map(r => [r.id, r]));
        const ordered = await this.order(rows, byId, query);
        if (!ordered) return { rows: [], total: 0, of: all.length };   // a newer search took over: this answer is not wanted
        const offset = Math.max(0, query.offset || 0);
        const limit = Math.max(0, query.limit || 0);
        const shown = ordered.slice(offset, offset + limit).map(row => this.withFiles(row, byId.get(row.id)!));
        return { rows: shown, total: ordered.length, of: all.length };
    }

    async columnTree(): Promise<RequestColumnTree> {
        const requests = await this.list();
        const requestNames = new Map<string, string>();
        for (const r of requests) {
            for (const name of Object.keys(r.requestHeaders || {})) {
                if (!requestNames.has(name.toLowerCase())) requestNames.set(name.toLowerCase(), name);
            }
        }
        // (the response headers' names: from the responses read so far, and the first few)
        for (const r of requests.slice(0, TREE_SAMPLE)) this.readFiles(r);
        return {
            run: RUN_COLUMNS, request: REQUEST_COLUMNS, response: RESPONSE_COLUMNS,
            requestHeaders: [...requestNames.values()],
            responseHeaders: [...this.responseHeaderNames.values()]
        };
    }

    async detail(id: string): Promise<RequestDetail | undefined> {
        const requests = await this.list();
        const at = requests.findIndex(x => x.id === id);
        if (at < 0) return undefined;
        const r = requests[at];
        const files = this.readFiles(r, true);
        // A finished request whose response isn't there yet (the web app writes a run's files a moment behind; a
        // single run's window asks as it ends): its record is read again next time, not kept as it was
        if (files.responseBody === null && FINISHED.has(String(r.status || ''))) this.records = null;
        const row = recordRow(r, at + 1);
        return {
            id, method: row.method, url: row.url, query: row.query,
            requestHeaders: row.requestHeaders, responseHeaders: files.responseHeaders,
            requestBody: files.requestBody, responseBody: files.responseBody,
            rows: row.rowStart !== null && row.rowEnd !== null ? [row.rowStart, row.rowEnd] : null,
            row
        };
    }

    private async list(): Promise<RequestRecord[]> {
        const version = this.version;
        if (this.records && this.records.version === version) return this.records.list;
        const list = await this.ports.requests();
        if (version === this.version) this.records = { version, list };
        return list;
    }

    /** The rows the search keeps, in the sort's order; null when a newer search stopped this one. */
    private async order(rows: RequestRow[], byId: Map<string, RequestRecord>, query: RequestPageQuery): Promise<RequestRow[] | null> {
        const search = (query.search || '').trim();
        const columns = query.columns && query.columns.length ? query.columns : DEFAULT_COLUMNS;
        // (the columns only the files hold don't sort: see the top)
        const sort: RequestSort | null = query.sort && !needsFiles(query.sort.id) ? query.sort : null;
        let plan: SearchPlan | null = null;
        // A column name still being typed ("@status", no operator yet) is not a search: it was read as a plain word and
        // every request's files were opened for it, on each pause in the typing (James, 2026-11-26: typing dragged)
        const typingAColumn = /^@[^=~!<>\s]*$/.test(search);
        if (search && !typingAColumn) plan = planSearch(parseSearchExpression(search), columns.map(c => ({ id: c.id, name: c.name, type: 'string', hidden: !!c.hidden })));
        let kept: RequestRow[];
        if (plan && plan.terms.some(t => t.columns.some(needsFiles))) {
            const key = JSON.stringify({ search, columns: columns.map(c => [c.id, !!c.hidden]) });
            const ids = await this.searchFiles(key, plan, rows, byId);
            if (!ids) return null;
            kept = rows.filter(r => ids.has(r.id));
        } else {
            kept = plan ? rows.filter(row => matches(plan!, row)) : rows.slice();
        }
        return kept.sort(compareRows(sort));
    }

    /** The ids of the requests a search over the files matches: kept per run version, worked out a slice at a time. */
    private async searchFiles(key: string, plan: SearchPlan, rows: RequestRow[], byId: Map<string, RequestRecord>): Promise<Set<string> | null> {
        const version = this.version;
        if (this.kept && this.kept.key === key && this.kept.version === version) return this.kept.ids;
        if (this.scan && this.scan.key === key) return this.scan.done;
        const token = ++this.token;
        const yieldNow = this.ports.yieldNow || breathe;
        const done = (async () => {
            const ids = new Set<string>();
            let sliceStart = Date.now();
            for (const row of rows) {
                if (token !== this.token) return null;
                const files = this.readFiles(byId.get(row.id)!, false, false);
                if (matches(plan, searchRow(row, files))) ids.add(row.id);
                if (Date.now() - sliceStart >= SLICE_MS) {
                    await yieldNow();
                    sliceStart = Date.now();
                }
            }
            if (token !== this.token) return null;
            this.kept = { key, version, ids };
            return ids;
        })();
        this.scan = { key, token, done };
        try {
            return await done;
        } finally {
            if (this.scan && this.scan.token === token) this.scan = null;
        }
    }

    /**
     * What a finished request's files gave a row (its two previews and its response headers), kept by request: a row
     * drawn again doesn't read its files again. Each was read and parsed whole on every page: with responses of 500
     * records, switching to the tab, scrolling and typing all dragged (James, 2026-11-26, 487 such requests). The
     * small summary is kept, never the bodies. A request sent again (its reprocess count) or changed is read again.
     */
    private summaries = new Map<string, { key: string; request: RequestRow['request']; response: RequestRow['response']; responseHeaders: HeaderPair[] }>();

    /** A row with what its files hold, for the page. */
    private withFiles(row: RequestRow, record: RequestRecord): RequestRow {
        const key = `${record.status}|${record.reprocessCount ?? 0}|${record.requestFile ?? ''}|${record.responseFile ?? ''}`;
        let held = this.summaries.get(record.id);
        if (!held || held.key !== key) {
            const files = this.readFiles(record);
            const contentType = files.responseHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value ?? null;
            held = {
                key,
                request: bodySummary(files.requestBody, files.requestBytes),
                response: bodySummary(files.responseBody, files.responseBytes, contentType),
                responseHeaders: files.responseHeaders
            };
            // (only once it has ended and its response is there: the web app writes a run's files a moment behind)
            if (FINISHED.has(String(record.status || '')) && files.responseBody !== null) this.summaries.set(record.id, held);
            else this.summaries.delete(record.id);
        }
        const full: RequestRow = { ...row, request: held.request, response: held.response, responseHeaders: held.responseHeaders };
        for (const h of held.responseHeaders) full[headerKey('response', h.name)] = h.value;
        return full;
    }

    /** A request's files. `pretty`: the response body laid out (the transaction window); else compact. */
    private readFiles(record: RequestRecord, pretty = false, sizes = true): ReadFiles {
        const { files } = this.ports;
        const read = (path: string | undefined): { text: string | null; bytes: number | null } => {
            if (!path || !files.exists(path)) return { text: null, bytes: null };
            try {
                const text = files.read(path);
                // (TextEncoder, not Buffer: the web app has no Buffer, and its ReferenceError, caught here, made every
                //  body there read as missing: no response in the window, nothing in Request/Response, round 38c)
                // (a search has no use for the size: encoding each body to count its bytes was a cost per file)
                return { text, bytes: sizes ? utf8.encode(text).length : null };
            } catch {
                return { text: null, bytes: null };
            }
        };
        const request = read(record.requestFile);
        const response = read(record.responseFile);
        const parsed = parseResponseFile(response.text, pretty);
        for (const h of parsed.headers) {
            const lower = h.name.toLowerCase();
            if (!this.responseHeaderNames.has(lower) && this.responseHeaderNames.size < MAX_HEADER_NAMES) this.responseHeaderNames.set(lower, h.name);
        }
        return {
            requestBody: request.text === null ? null : (isEmptyRequestBody(request.text) ? '' : request.text),
            requestBytes: request.bytes,
            responseBody: parsed.body,
            responseBytes: response.bytes,
            responseHeaders: parsed.headers
        };
    }
}

/** A request's row from its record alone (no file opened). */
export function recordRow(r: RequestRecord, n: number): RequestRow {
    const query = { ...(r.requestQueryParams || {}) };
    const requestHeaders = headerPairs(r.requestHeaders);
    const sent = r.startedAt instanceof Date ? r.startedAt.toISOString() : (r.startedAt ? String(r.startedAt) : null);
    const rowStart = typeof r.rowStart === 'number' ? r.rowStart : null;
    const row: RequestRow = {
        id: r.id,
        n,
        status: r.status || 'pending',
        http: typeof r.httpStatus === 'number' ? r.httpStatus : null,
        httpText: r.httpStatusText || null,
        timeMs: typeof r.runTime === 'number' ? r.runTime : null,
        sent,
        rowStart,
        rowEnd: rowStart === null ? null : rowStart + rowCount(r.rows) - 1,
        method: (r.endpointMethod || '').toUpperCase(),
        url: urlWithQuery(r.endpointPath || '', query),
        query,
        request: null,
        response: null,
        requestHeaders,
        responseHeaders: [],
        reason: r.errorMessage || null,
        reprocessCount: r.reprocessCount ?? 0,
        // (as the Logs window finds them: the record's log path, or the .log beside its request file; with only the
        // first, a batch's requests offered no Logs in the window opened from this tab. James, 2026-11-26)
        hasLogs: !!(r.logPath || r.requestFile)
    };
    for (const h of requestHeaders) row[headerKey('request', h.name)] = h.value;
    return row;
}

/**
 * A response file: { headers, data } as a request writes it (execution-file.service.ts); an older
 * single run's { _meta: { responseHeaders }, …data }; or plain text.
 */
/**
 * A JSON Lines response file (format.kind 'jsonl', its data the records) as its lines again: a record a line, the lines
 * that weren't JSON put back where they were (blank lines aren't kept, so a place can shift by those). Else null.
 */
export function jsonLinesOf(file: Record<string, unknown>): string | null {
    const format = file.format as { kind?: string; invalid?: Array<{ line: number; text: string }> } | undefined;
    if (!format || format.kind !== 'jsonl' || !Array.isArray(file.data)) return null;
    const lines = (file.data as unknown[]).map(record => JSON.stringify(record));
    (format.invalid || []).slice().sort((a, b) => a.line - b.line).forEach(bad => {
        lines.splice(Math.min(Math.max(0, bad.line - 1), lines.length), 0, String(bad.text ?? ''));
    });
    return lines.join('\n');
}

export function parseResponseFile(text: string | null, pretty = true): { body: string | null; headers: HeaderPair[] } {
    if (text === null) return { body: null, headers: [] };
    const out = (v: unknown) => (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { body: text, headers: [] }; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if ('data' in o && ('httpStatus' in o || 'headers' in o)) {
            // (a JSON Lines body is kept as its records and the lines that weren't JSON: given back as received,
            //  a record a line, the others where they were, as Raw's card did; the window reads it as JSON Lines)
            const lines = jsonLinesOf(o);
            if (lines !== null) return { body: lines, headers: headerPairs(o.headers as Record<string, unknown>) };
            return { body: o.data === undefined ? null : out(o.data), headers: headerPairs(o.headers as Record<string, unknown>) };
        }
        if (o._meta && typeof o._meta === 'object') {
            const { _meta, ...rest } = o;
            return { body: out(rest), headers: headerPairs((_meta as Record<string, unknown>).responseHeaders as Record<string, unknown>) };
        }
    }
    return { body: out(parsed), headers: [] };
}

/** A row as the search reads it, with its files' text (whole bodies, not previews). */
function searchRow(row: RequestRow, files: ReadFiles): RequestRow {
    const full: RequestRow = { ...row, responseHeaders: files.responseHeaders, __requestText: files.requestBody ?? '', __responseText: files.responseBody ?? '' };
    const contentType = files.responseHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '';
    full.__contentType = contentType;
    for (const h of files.responseHeaders) full[headerKey('response', h.name)] = h.value;
    return full;
}

/** What a column of a row reads as, for the search. */
function searchValue(row: RequestRow, id: string): unknown {
    switch (id) {
        case 'request': return row.__requestText ?? row.request?.preview ?? '';
        case 'response': return row.__responseText ?? row.response?.preview ?? '';
        case 'contentType': return row.__contentType ?? row.response?.contentType ?? '';
        case 'requestHeaders': return row.requestHeaders.map(h => `${h.name}: ${h.value}`).join('\n');
        case 'responseHeaders': return row.responseHeaders.map(h => `${h.name}: ${h.value}`).join('\n');
        case 'rowStart': return row.rowStart === null ? '' : `${row.rowStart}–${row.rowEnd}`;
        default: return row[id] ?? '';
    }
}

function matches(plan: SearchPlan, row: RequestRow): boolean {
    return plan.rowMatches(i => plan.terms[i].columns.some(id => plan.terms[i].test(searchValue(row, id))));
}
