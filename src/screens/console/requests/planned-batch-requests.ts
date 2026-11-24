// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A batch's requests before anything is sent (#466/#470: Run Batch's Review, the same Requests table as the Console):
 * Ready rows, made from the batch plan a page at a time (data-loading/batch-plan.ts planRequests), as Execute will
 * send them. No response, no HTTP, no time, no sent: the Console's stored-run source takes over at Execute.
 *
 * Light, as the stored source is: a page plans only its own requests. A search reaches the planned requests
 * themselves, so it plans the batch whole, up to SEARCH_MAX requests (a bigger batch is searched on its Input tab).
 */
import * as searchMatcherScript from '../../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../../utils/shared-script';
import { planRequests, type BatchPlanInput, type PlanRequest } from '../../../data-loading/batch-plan';
import {
    REQUEST_COLUMNS, RESPONSE_COLUMNS, RUN_COLUMNS, bodySummary, headerKey, headerPairs, type HeaderPair,
    type RequestColumn, type RequestColumnTree, type RequestDetail, type RequestPage, type RequestPageQuery, type RequestRow, type RequestSource
} from './request-rows';

interface SearchPlan {
    terms: { columns: string[]; test(value: unknown): boolean }[];
    rowMatches(hit: (term: number) => boolean): boolean;
}
const { parseSearchExpression, planSearch } = sharedScript<{ parseSearchExpression(text: string): unknown; planSearch(parsed: unknown, columns: unknown[]): SearchPlan }>(searchMatcherScript, 'SearchMatcher');

/** The most planned requests a search plans to look through. */
export const SEARCH_MAX = 2000;

export interface PlannedBatchPorts {
    /** The plan's input as Review last planned it; undefined before Review has. */
    input(): BatchPlanInput | undefined;
    /** How many requests the batch makes (the plan's totals). */
    total(): number;
    /** The endpoint's headers, as every request sends them. */
    headers(): Record<string, unknown> | undefined;
    /** A body as Execute sends it (BASE64 fields encoded), from the plan's JSON. */
    bodyText(body: unknown): string;
}

const DEFAULT_COLUMNS: RequestColumn[] = [
    ...RUN_COLUMNS.filter(c => ['n', 'status', 'rowStart'].includes(c.id)),
    { id: 'request', name: 'Request' }, { id: 'url', name: 'URL' }, { id: 'requestHeaders', name: 'Request headers' }
];

export class PlannedBatchRequests implements RequestSource {
    constructor(private readonly ports: PlannedBatchPorts) {}

    async counts(): Promise<{ total: number; counts: Record<string, number> }> {
        const total = this.ports.input() ? this.ports.total() : 0;
        return { total, counts: total ? { ready: total } : {} };
    }

    async page(query: RequestPageQuery): Promise<RequestPage & { error?: string }> {
        const input = this.ports.input();
        if (!input) return { rows: [], total: 0, of: 0 };
        const of = this.ports.total();
        const offset = Math.max(0, query.offset || 0);
        const limit = Math.max(0, query.limit || 0);
        // (every planned request is Ready: a Status filter without Ready shows none)
        if (Array.isArray(query.statuses) && !query.statuses.includes('ready')) return { rows: [], total: 0, of };
        const search = (query.search || '').trim();
        if (!search) {
            const rows = (await planRequests(input, offset, limit)).map(r => this.row(r));
            return { rows, total: of, of };
        }
        if (of > SEARCH_MAX) return { rows: [], total: 0, of, error: `A search of the requests looks through up to ${SEARCH_MAX.toLocaleString()} before they are sent: search the Input tab for this batch's ${of.toLocaleString()}.` };
        const columns = query.columns && query.columns.length ? query.columns : DEFAULT_COLUMNS;
        const plan = planSearch(parseSearchExpression(search), columns.map(c => ({ id: c.id, name: c.name, type: 'string', hidden: !!c.hidden })));
        const all = (await planRequests(input, 0, of)).map(r => this.row(r, true));
        const kept = all.filter(row => plan.rowMatches(i => plan.terms[i].columns.some(id => plan.terms[i].test(searchValue(row, id)))));
        kept.forEach(r => { delete r.__requestText; });
        return { rows: kept.slice(offset, offset + limit), total: kept.length, of };
    }

    async columnTree(): Promise<RequestColumnTree> {
        return {
            run: RUN_COLUMNS, request: REQUEST_COLUMNS, response: RESPONSE_COLUMNS,
            requestHeaders: headerPairs(this.ports.headers() as Record<string, unknown>).map(h => h.name),
            responseHeaders: []
        };
    }

    async detail(id: string): Promise<RequestDetail | undefined> {
        const input = this.ports.input();
        const n = Number(String(id).replace(/^plan-/, ''));
        if (!input || !Number.isFinite(n) || n < 1) return undefined;
        const [r] = await planRequests(input, n - 1, 1);
        if (!r) return undefined;
        const row = this.row(r);
        return {
            id, method: row.method, url: row.url, query: row.query, requestHeaders: row.requestHeaders, responseHeaders: [],
            requestBody: r.body === null ? '' : this.ports.bodyText(r.body), responseBody: null,
            rows: [r.rowRange.start, r.rowRange.end],
            // (its input rows from the plan: nothing else holds them before Execute)
            input: { columns: input.headers.slice(), rows: r.inputRows.map(row => row.slice()) }
        };
    }

    /** A planned request as a Ready row (`search`: with its whole body, for a search to read). */
    private row(r: PlanRequest, search = false): RequestRow {
        const requestHeaders: HeaderPair[] = headerPairs(enabledOnly(this.ports.headers()));
        const text = r.body === null ? null : this.ports.bodyText(r.body);
        const row: RequestRow = {
            id: `plan-${r.index}`, n: r.index, status: 'ready', http: null, httpText: null, timeMs: null, sent: null,
            rowStart: r.rowRange.start, rowEnd: r.rowRange.end, method: r.method, url: r.url, query: { ...r.queryParams },
            request: text === null ? null : bodySummary(text, r.size), response: null,
            requestHeaders, responseHeaders: [], reason: null, reprocessCount: 0, hasLogs: false
        };
        for (const h of requestHeaders) row[headerKey('request', h.name)] = h.value;
        if (search) row.__requestText = text ?? '';
        return row;
    }
}

/** An endpoint's headers as sent: the enabled ones, by value ({ value, enabled } or a plain string). */
function enabledOnly(headers: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, h] of Object.entries(headers || {})) {
        if (h && typeof h === 'object') {
            const v = h as { value?: unknown; enabled?: boolean };
            if (v.enabled === false) continue;
            out[name] = String(v.value ?? '');
        } else out[name] = String(h ?? '');
    }
    return out;
}

function searchValue(row: RequestRow, id: string): unknown {
    switch (id) {
        case 'request': return row.__requestText ?? row.request?.preview ?? '';
        case 'requestHeaders': return row.requestHeaders.map(h => `${h.name}: ${h.value}`).join('\n');
        case 'rowStart': return row.rowStart === null ? '' : `${row.rowStart}–${row.rowEnd}`;
        default: return row[id] ?? '';
    }
}
