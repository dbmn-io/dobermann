// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A batch's requests before anything is sent (#466/#470: Run Batch's Review, the same Requests table as the Console):
 * Ready rows, made from the batch plan a page at a time (data-loading/batch-plan.ts planRequests), as Execute will
 * send them. No response, no HTTP, no time, no sent: the Console's stored-run source takes over at Execute.
 *
 * Every request is listed, PLANNED: its number and the rows behind it (planRanges, nothing built). Only the first
 * SAMPLE are built, with their bodies, as samples (James, 2026-11-25, by question: "All rows, first 5 built" and
 * "PLANNED"; "Execution engine is responsible for this": the engine builds the rest as it sends them). A planned row
 * past the samples says so in its Request cell; its window shows its input rows and says the same. A search looks
 * through the samples' bodies and every row's number and input rows.
 */
import * as searchMatcherScript from '../../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../../utils/shared-script';
import { planRanges, planRequests, type BatchPlanInput, type PlanRequest } from '../../../data-loading/batch-plan';
import {
    REQUEST_COLUMNS, RESPONSE_COLUMNS, RUN_COLUMNS, bodySummary, headerKey, headerPairs, type HeaderPair,
    type RequestColumn, type RequestColumnTree, type RequestDetail, type RequestPage, type RequestPageQuery, type RequestRow, type RequestSource
} from './request-rows';

interface SearchPlan {
    terms: { columns: string[]; test(value: unknown): boolean }[];
    rowMatches(hit: (term: number) => boolean): boolean;
}
const { parseSearchExpression, planSearch } = sharedScript<{ parseSearchExpression(text: string): unknown; planSearch(parsed: unknown, columns: unknown[]): SearchPlan }>(searchMatcherScript, 'SearchMatcher');

/** How many requests Review builds, as samples. */
export const SAMPLE = 5;
/** What a planned request past the samples says where its body would be. */
export const BUILT_LATER = 'Built when the batch runs';

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
        return { total, counts: total ? { planned: total } : {} };
    }

    async page(query: RequestPageQuery): Promise<RequestPage & { error?: string }> {
        const input = this.ports.input();
        if (!input) return { rows: [], total: 0, of: 0 };
        const of = this.ports.total();
        const offset = Math.max(0, query.offset || 0);
        const limit = Math.max(0, Math.min(query.limit || 0, of - offset));
        // (every request on Review is Planned: a Status filter without Planned shows none)
        if (Array.isArray(query.statuses) && !query.statuses.includes('planned')) return { rows: [], total: 0, of };
        const search = (query.search || '').trim();
        if (!search) return { rows: await this.rows(input, offset, limit), total: of, of };
        // A search: the samples by their bodies, every row by its number and input rows (nothing more is built)
        const columns = query.columns && query.columns.length ? query.columns : DEFAULT_COLUMNS;
        const plan = planSearch(parseSearchExpression(search), columns.map(c => ({ id: c.id, name: c.name, type: 'string', hidden: !!c.hidden })));
        const all = await this.rows(input, 0, of, true);
        const kept = all.filter(row => plan.rowMatches(i => plan.terms[i].columns.some(id => plan.terms[i].test(searchValue(row, id)))));
        kept.forEach(r => { delete r.__requestText; delete r.__inputText; });
        return { rows: kept.slice(offset, offset + limit), total: kept.length, of };
    }

    /** Rows from `offset`: the samples built (planRequests), the rest planned only (planRanges). */
    private async rows(input: BatchPlanInput, offset: number, limit: number, search = false): Promise<RequestRow[]> {
        if (limit <= 0) return [];
        const out: RequestRow[] = [];
        const builtEnd = Math.min(SAMPLE, offset + limit);
        if (offset < SAMPLE) (await planRequests(input, offset, builtEnd - offset)).forEach(r => out.push(this.row(r, search)));
        const from = Math.max(offset, SAMPLE);
        const left = offset + limit - from;
        if (left > 0) (await planRanges(input, from, left)).forEach(r => out.push(this.row(r, search, false)));
        return out;
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
        if (!input || !Number.isFinite(n) || n < 1 || n > this.ports.total()) return undefined;
        const built = n <= SAMPLE;
        const [r] = built ? await planRequests(input, n - 1, 1) : await planRanges(input, n - 1, 1);
        if (!r) return undefined;
        const row = this.row(r, false, built);
        return {
            id, method: row.method, url: row.url, query: row.query, requestHeaders: row.requestHeaders, responseHeaders: [],
            // (past the samples: not built, and it says so where its body would be)
            requestBody: !built ? BUILT_LATER : r.body === null ? '' : this.ports.bodyText(r.body), responseBody: null,
            rows: [r.rowRange.start, r.rowRange.end],
            // (its input rows from the plan: nothing else holds them before Execute)
            input: { columns: input.headers.slice(), rows: r.inputRows.map(row => row.slice()) }
        };
    }

    /** A planned request as a row (`search`: with its whole body and input rows, for a search to read; `built`: a
     *  sample, with its body, or a planned one past them, which says it is built when the batch runs). */
    private row(r: PlanRequest, search = false, built = true): RequestRow {
        const requestHeaders: HeaderPair[] = headerPairs(enabledOnly(this.ports.headers()));
        const text = built && r.body !== null ? this.ports.bodyText(r.body) : null;
        const row: RequestRow = {
            id: `plan-${r.index}`, n: r.index, status: 'planned', http: null, httpText: null, timeMs: null, sent: null,
            rowStart: r.rowRange.start, rowEnd: r.rowRange.end, method: r.method, url: r.url, query: { ...r.queryParams },
            request: !built ? { preview: BUILT_LATER, items: null, bytes: null, later: true } : text === null ? null : bodySummary(text, r.size), response: null,
            requestHeaders, responseHeaders: [], reason: null, reprocessCount: 0, hasLogs: false
        };
        for (const h of requestHeaders) row[headerKey('request', h.name)] = h.value;
        if (search) { row.__requestText = text ?? ''; row.__inputText = r.inputRows.map(x => x.join(' ')).join('\n'); }
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
        case 'rowStart': return [row.rowStart === null ? '' : `${row.rowStart}–${row.rowEnd}`, row.__inputText ?? ''].join('\n');
        default: return row[id] ?? '';
    }
}
