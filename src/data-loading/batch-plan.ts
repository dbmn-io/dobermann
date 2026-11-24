// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch plan — what a Run Batch will send, worked out from the template and the rows.
 *
 * One answer for Step 4 (GitHub Issue #308): the template's shape, what each variable does,
 * how the rows group into requests, how many requests there are, and the first few of them
 * (body or URL, with the input rows behind each). The Step 4 screen and its ⓘ "How your rows
 * become API requests" both draw from it.
 *
 * The requests are built by the REAL JsonGenerator / QueryParamRepetitionHelper — the code
 * Execute runs — on a prefix of the rows, so the preview is the batch, not a picture of it.
 * Totals are counted over every row with the same grouping rule (JsonGenerator
 * .groupingColumnsFor: a new group when ANY variable at the level changes).
 *
 * The shapes (see JsonGenerator.generateBatchJsonFiles):
 *   single        no array: one request per row                     { "id": "{{id}}" }
 *   flat          one array repeated, N rows per request            [ { "sku": "{{sku}}" } ]
 *   grouped       header + lines: a request per header combination  { "po": …, "lines": [ … ] }
 *   nested-2      orders[].items[]: N orders per request
 *   nested-3      shipments[].packages[].items[]
 *   query-repeat  GET, one query parameter repeats many rows into one URL
 *   query-each    no body, variables in the URL: one request per row
 */
import { JsonGenerator } from './json-generator';
import { TemplateParser } from './template-parser';
import { stripJsonCommentsSafe } from '../utils/json-comment-stripper';
import { flattenQueryParams } from '../utils/jwt-validation';
import { QueryParamRepetitionHelper, QueryParamRepetitionConfig } from '../services/transaction-preparation/helpers/query-param-repetition.helper';
import { RepeatableArray } from './zod-schemas';
import { fillBaseUrl } from '../utils/environment-url';

export type BatchShape = 'single' | 'flat' | 'grouped' | 'nested-2' | 'nested-3' | 'query-repeat' | 'query-each';

/**
 * request    — a new request starts when it changes (the request's header)
 * group      — a new entry in `level` starts when it changes (an order inside a request)
 * item       — once per row, an entry in `level`
 * first-row  — outside the repeated array: each request takes it from its first row
 * row        — one request per row
 * url        — in the URL (path or query parameter)
 * generated  — {{A8:…}}: Dobermann makes it up
 * environment— {{ENV:…}}: the same for every row
 */
export type VariableRole = 'request' | 'group' | 'item' | 'first-row' | 'row' | 'url' | 'generated' | 'environment';

export interface PlanVariable {
    name: string;
    column: string | null;
    role: VariableRole;
    /** The array it belongs to, for group/item; null otherwise. */
    level: string | null;
    /** For generated values: what it does, in words. */
    note?: string;
}

export interface PlanLevel {
    /** 'request' or the array's name. */
    name: string;
    /** Variables that start a new one; empty = a static wrapper, or one per row. */
    keyedBy: string[];
}

export interface PlanRequest {
    index: number;
    /** What makes this request this request: its grouping values. */
    key: Array<{ variable: string; value: string }>;
    rowCount: number;
    /** 1-based, inclusive, in the order the rows are sent (sorted when grouped). */
    rowRange: { start: number; end: number };
    inputRows: string[][];
    method: string;
    url: string;
    queryParams: Record<string, string>;
    /** null when the request has no body. */
    body: unknown | null;
    size: number;
}

export interface PlanGroupTable {
    columns: string[];
    rows: Array<{ values: string[]; rowCount: number; request: number }>;
    more: number;
}

export interface BatchPlan {
    shape: BatchShape;
    method: string;
    hasBody: boolean;
    /** The repeated array; '$root' for a top-level array; null when nothing repeats. */
    arrayPath: string | null;
    /** Arrays that could be the repeated one (a picker only when there are two or more). */
    arrayCandidates: string[];
    reps: { applies: boolean; label: string; value: number };
    variables: PlanVariable[];
    levels: PlanLevel[];
    totals: { rows: number; requests: number };
    groups: PlanGroupTable | null;
    requests: PlanRequest[];
    notes: string[];
    /** The template as the user wrote it (comments kept), for the ⓘ. */
    template: string;
    /** The path and query parameters with their {{variables}}, e.g. `/items/{{item}}?site={{site}}`. */
    urlTemplate: string;
}

export interface BatchPlanInput {
    endpoint: {
        method?: string;
        path?: string;
        body?: string;
        bodyWithComments?: string;
        queryParams?: Record<string, unknown>;
    };
    baseUrl?: string;
    headers: string[];
    rows: string[][];
    mappings: Array<{ variable: string; column?: string | null; dataType?: string }>;
    /** Items per request where that applies (flat rows, outer entries). */
    reps: number;
    /** The chosen array when the template has more than one candidate. */
    arrayPath?: string | null;
    queryParamRepetition?: QueryParamRepetitionConfig | null;
    environmentVariables?: Record<string, string>;
    previewCount?: number;
    /** The requests from this one on (0-based): Review's Requests table pages through a batch (planRequests). */
    previewOffset?: number;
    groupTableSize?: number;
}

const ROOT = '$root';
const isSystem = (name: string) => /^(A8|ENV)(:|$)/i.test(name.trim());
const nameOf = (declaration: string) => declaration.trim().split(/[:|]/)[0].trim();
const variablesIn = (text: string): string[] => {
    const out: string[] = [];
    for (const m of (text || '').matchAll(/\{\{([^{}]*)\}\}/g)) {
        const content = m[1].trim();
        if (!content || content.startsWith(':')) continue;
        const prefix = content.split(':')[0].trim().toUpperCase();
        const name = prefix === 'A8' || prefix === 'ENV' ? content : nameOf(content);
        if (!out.includes(name)) out.push(name);
    }
    return out;
};

/**
 * `limit` of a batch's requests from `offset` (0-based), exactly as planBatch builds them, without building the ones
 * before: Review's Requests table (#466/#470) pages through a batch of thousands. Only the rows behind these requests
 * go to the generator; the totals are still the whole batch's.
 */
export async function planRequests(input: BatchPlanInput, offset: number, limit: number): Promise<PlanRequest[]> {
    const from = Math.max(0, Math.floor(offset));
    const count = Math.max(0, Math.floor(limit));
    // A batch-wide {{A8:sequence}} counts on through the requests: how many numbers the ones before used isn't known
    // without building them, so those are built from the start (and the page taken from them), as Execute numbers them
    if (from > 0 && usesBatchSequence(input.endpoint.body)) {
        return (await planBatch({ ...input, previewOffset: 0, previewCount: from + count })).requests.slice(from, from + count);
    }
    return (await planBatch({ ...input, previewOffset: from, previewCount: count })).requests;
}

/** {{A8:sequence}} (or :global) anywhere in the body: a number drawn on through the batch (`:local` starts again per request). */
function usesBatchSequence(body: string | undefined): boolean {
    return Array.from(String(body || '').matchAll(/\{\{\s*A8:sequence([^}]*)\}\}/gi)).some(m => !/:\s*local\b/i.test(m[1]));
}

export async function planBatch(input: BatchPlanInput): Promise<BatchPlan> {
    const previewCount = input.previewCount ?? 5;
    const previewOffset = Math.max(0, Math.floor(input.previewOffset ?? 0));
    const groupTableSize = input.groupTableSize ?? 8;
    const method = (input.endpoint.method || 'POST').toUpperCase();
    const template = input.endpoint.bodyWithComments || input.endpoint.body || '';
    const body = input.endpoint.body && input.endpoint.body.trim() ? stripJsonCommentsSafe(input.endpoint.body).trim() : '';
    const hasBody = body !== '' && body !== '{}';
    const queryParams = flattenQueryParams((input.endpoint.queryParams || {}) as Record<string, string>);
    const path = input.endpoint.path || '';
    const urlTemplate = path + (Object.keys(queryParams).length
        ? '?' + Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&') : '');
    const columnOf = (variable: string) => input.mappings.find(m => m.variable === variable)?.column || null;
    const valueOf = (row: string[], variable: string) => {
        const column = columnOf(variable) || variable;
        const i = input.headers.indexOf(column);
        return i === -1 ? '' : (row[i] ?? '');
    };
    const notes: string[] = [];
    const reps = Math.max(1, Math.floor(input.reps || 1));
    // #424: the base URL's own variables, from the environment
    const baseUrl = fillBaseUrl(input.baseUrl || '', input.environmentVariables);

    // ── URL-only shapes ────────────────────────────────────────────────────────────────
    const urlVariables = [...variablesIn(path), ...Object.values(queryParams).flatMap(v => variablesIn(String(v)))];
    const fillUrl = (row: string[], params: Record<string, string>) => {
        const sub = (text: string) => text.replace(/\{\{([^{}]*)\}\}/g, (match, declaration: string) => {
            // {{ENV:name}}: the environment's value, the same for every row (checked before the
            // system-variable skip, which kept the template in the URL as typed)
            if (/^ENV:/i.test(declaration.trim())) {
                const env = input.environmentVariables?.[declaration.trim().slice(4).split(/[:|]/)[0].trim()];
                return env ?? match;
            }
            const name = nameOf(declaration);
            if (isSystem(name)) return match;
            return valueOf(row, name);
        });
        const filled: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) filled[k] = sub(String(v));
        const qs = Object.entries(filled).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        return { url: `${baseUrl.replace(/\/+$/, '')}${sub(path)}${qs ? '?' + qs : ''}`, params: filled };
    };

    if (input.queryParamRepetition?.enabled && !hasBody) {
        const helper = new QueryParamRepetitionHelper();
        const mappingRecord = Object.fromEntries(input.mappings.filter(m => m.column).map(m => [m.variable, m.column as string]));
        const analysis = await helper.analyzeQueryParamRepetition([input.headers, ...input.rows], input.queryParamRepetition, mappingRecord);
        const { paramKey } = input.queryParamRepetition;
        // (from the offset: the rows of the requests before it are counted, not built)
        let start = 1 + analysis.rowGroups.slice(0, previewOffset).reduce((n, g) => n + Math.max(0, g.rows.length - 1), 0);
        const requests: PlanRequest[] = analysis.rowGroups.slice(previewOffset, previewOffset + previewCount).map((group, at) => {
            const index = previewOffset + at;
            const rows = group.rows.slice(1);
            const params = { ...queryParams, [paramKey]: group.queryString };
            const filled = fillUrl(rows[0] || [], params);
            filled.params[paramKey] = group.queryString;
            const qs = Object.entries(filled.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
            const url = `${baseUrl.replace(/\/+$/, '')}${filled.url.slice(baseUrl.replace(/\/+$/, '').length).split('?')[0]}?${qs}`;
            const request: PlanRequest = { index: index + 1, key: [], rowCount: rows.length, rowRange: { start, end: start + rows.length - 1 },
                inputRows: rows, method, url, queryParams: filled.params, body: null, size: url.length };
            start += rows.length;
            return request;
        });
        if (analysis.includedRowCount < analysis.totalRows) {
            notes.push(`${analysis.totalRows - analysis.includedRowCount} of ${analysis.totalRows} rows have no \`${analysis.variableName}\` and are left out.`);
        }
        notes.push(`Values are packed into each URL up to ${input.queryParamRepetition.maxUrlLength} characters${input.queryParamRepetition.maxPerRequest ? `, at most ${input.queryParamRepetition.maxPerRequest} per request` : ''}.`);
        return {
            shape: 'query-repeat', method, hasBody, arrayPath: null, arrayCandidates: [],
            reps: { applies: false, label: '', value: reps },
            variables: urlVariables.map(name => ({ name, column: isSystem(name) ? null : columnOf(name), role: roleForSystem(name) ?? 'url', level: null, note: systemNote(name) })),
            levels: [{ name: 'request', keyedBy: [] }],
            totals: { rows: input.rows.length, requests: analysis.transactionCount },
            groups: null, requests, notes, template, urlTemplate
        };
    }

    if (!hasBody) {
        const requests: PlanRequest[] = input.rows.slice(previewOffset, previewOffset + previewCount).map((row, at) => {
            const index = previewOffset + at;
            const filled = fillUrl(row, queryParams);
            return { index: index + 1, key: urlVariables.filter(v => !isSystem(v)).map(v => ({ variable: v, value: valueOf(row, v) })),
                rowCount: 1, rowRange: { start: index + 1, end: index + 1 }, inputRows: [row], method, url: filled.url,
                queryParams: filled.params, body: null, size: filled.url.length };
        });
        return {
            shape: 'query-each', method, hasBody, arrayPath: null, arrayCandidates: [],
            reps: { applies: false, label: '', value: reps },
            variables: urlVariables.map(name => ({ name, column: isSystem(name) ? null : columnOf(name), role: roleForSystem(name) ?? 'url', level: null, note: systemNote(name) })),
            levels: [{ name: 'request', keyedBy: [] }],
            totals: { rows: input.rows.length, requests: input.rows.length },
            groups: null, requests, notes, template, urlTemplate
        };
    }

    // ── Body shapes ───────────────────────────────────────────────────────────────────
    const generator = new JsonGenerator();
    const gen = generator as unknown as {
        groupingColumnsFor(variables: string[] | undefined, options: { mappings: BatchPlanInput['mappings'] }): string[];
        extractVariablesFromObject(obj: unknown, excludeKeys?: string[]): string[];
    };
    const analysis = generator.analyzeNestedArrays(body);
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* reported by the generator below */ }
    const allBodyVariables = new TemplateParser().extractVariablesFromJson(body).map(v => v.name);

    const arrayCandidates = repeatableArrayCandidates(parsed);
    const shape = bodyShape(analysis, arrayCandidates);

    const arrayPath = shape === 'single' ? null
        : shape === 'flat' ? (input.arrayPath && arrayCandidates.includes(input.arrayPath) ? input.arrayPath : arrayCandidates[0])
            : (analysis.outerArray ?? null);
    const options = {
        template: body,
        headers: input.headers,
        mappings: input.mappings.map(m => ({ variable: m.variable, column: m.column ?? null, dataType: m.dataType || 'string' })),
        repeatableArrays: arrayPath ? [{ arrayPath, enabled: true, maxRepetitions: shape === 'grouped' ? 1000 : reps }] : [],
        environmentVariables: input.environmentVariables || {}
    };

    // Variables and what they do.
    const rootVars = (shape === 'nested-2' || shape === 'nested-3') && parsed && analysis.outerArray
        ? gen.extractVariablesFromObject(parsed, [analysis.outerArray]) : [];
    const outer = analysis.outerVariables ?? [];
    const middle = analysis.middleVariables ?? [];
    const inner = analysis.innerVariables ?? [];
    const flatItemVars = shape === 'flat' && arrayPath
        ? variablesIn(JSON.stringify((arrayAt(parsed, arrayPath) || [])[0])) : [];
    const roleOf = (name: string): Pick<PlanVariable, 'role' | 'level'> => {
        switch (shape) {
            case 'grouped':
                return outer.includes(name) ? { role: 'request', level: null } : { role: 'item', level: analysis.innerArray ?? null };
            case 'nested-2':
                if (rootVars.includes(name)) return { role: 'request', level: null };
                if (outer.includes(name)) return { role: 'group', level: analysis.outerArray ?? null };
                return { role: 'item', level: analysis.innerArray ?? null };
            case 'nested-3':
                if (rootVars.includes(name)) return { role: 'request', level: null };
                if (outer.includes(name)) return { role: 'group', level: analysis.outerArray ?? null };
                if (middle.includes(name)) return { role: 'group', level: analysis.middleArray ?? null };
                return { role: 'item', level: analysis.innerArray ?? null };
            case 'flat':
                return flatItemVars.includes(name) ? { role: 'item', level: arrayPath } : { role: 'first-row', level: null };
            default:
                return { role: 'row', level: null };
        }
    };
    const bodyVariables = [...allBodyVariables, ...urlVariables.filter(v => !allBodyVariables.includes(v))];
    const variables: PlanVariable[] = bodyVariables.map(name => {
        const system = roleForSystem(name);
        if (system) return { name, column: null, role: system, level: null, note: systemNote(name, analysis.innerArray) };
        if (urlVariables.includes(name) && !allBodyVariables.includes(name)) return { name, column: columnOf(name), role: 'url', level: null };
        return { name, column: columnOf(name), ...roleOf(name) };
    });

    const levels: PlanLevel[] = [];
    if (shape === 'grouped') {
        levels.push({ name: 'request', keyedBy: outer }, { name: analysis.innerArray!, keyedBy: [] });
    } else if (shape === 'nested-2') {
        levels.push({ name: 'request', keyedBy: rootVars }, { name: analysis.outerArray!, keyedBy: outer }, { name: analysis.innerArray!, keyedBy: [] });
    } else if (shape === 'nested-3') {
        levels.push({ name: 'request', keyedBy: rootVars }, { name: analysis.outerArray!, keyedBy: outer },
            { name: analysis.middleArray!, keyedBy: middle }, { name: analysis.innerArray!, keyedBy: [] });
    } else if (shape === 'flat') {
        levels.push({ name: 'request', keyedBy: [] }, { name: arrayPath!, keyedBy: [] });
        const firstRow = variables.filter(v => v.role === 'first-row').map(v => '`' + v.name + '`');
        if (firstRow.length > 0) {
            notes.push(`${firstRow.join(', ')} ${firstRow.length === 1 ? 'is' : 'are'} outside the repeated array, so each request takes ${firstRow.length === 1 ? 'it' : 'them'} from its first row.`);
        }
    } else {
        levels.push({ name: 'request', keyedBy: [] });
    }

    // Sort as the generator sorts (nested shapes), so row numbers line up with what is sent.
    const sortVariables = [...rootVars, ...outer, ...middle];
    const sortColumns = shape === 'grouped' || shape === 'nested-2' || shape === 'nested-3'
        ? gen.groupingColumnsFor(sortVariables, options).map(c => input.headers.indexOf(c)).filter(i => i !== -1) : [];
    const rows = sortColumns.length === 0 ? input.rows.slice()
        : input.rows.slice().sort((a, b) => {
            for (const i of sortColumns) {
                const diff = (a[i] || '').trim().localeCompare((b[i] || '').trim());
                if (diff !== 0) return diff;
            }
            return 0;
        });

    // Group keys over EVERY row (for the totals and the ⓘ table).
    const keyIndices = (vars: string[]) => gen.groupingColumnsFor(vars, options).map(c => input.headers.indexOf(c)).filter(i => i !== -1);
    const keyFor = (indices: number[]) => (row: string[]) => indices.map(i => (row[i] ?? '').trim()).join('\u0001');
    const requestKey = keyFor(keyIndices(shape === 'grouped' ? outer : rootVars));
    const entryKey = keyFor(keyIndices([...rootVars, ...outer]));

    let totalRequests: number;
    const table: PlanGroupTable | null = { columns: [], rows: [], more: 0 };
    if (shape === 'grouped') {
        const order: string[] = [];
        const counts = new Map<string, { row: string[]; n: number }>();
        for (const row of rows) {
            const k = requestKey(row);
            const seen = counts.get(k);
            if (seen) seen.n++; else { counts.set(k, { row, n: 1 }); order.push(k); }
        }
        totalRequests = order.length;
        table.columns = gen.groupingColumnsFor(outer, options);
        const idx = keyIndices(outer);
        order.slice(0, groupTableSize).forEach((k, i) => table.rows.push({ values: idx.map(j => counts.get(k)!.row[j] ?? ''), rowCount: counts.get(k)!.n, request: i + 1 }));
        table.more = Math.max(0, order.length - groupTableSize);
    } else if (shape === 'nested-2' || shape === 'nested-3') {
        // Entries (orders) per request group (root), Reps of them per request.
        const roots = new Map<string, Map<string, { row: string[]; n: number }>>();
        for (const row of rows) {
            const r = requestKey(row);
            if (!roots.has(r)) roots.set(r, new Map());
            const entries = roots.get(r)!;
            const e = entryKey(row);
            const seen = entries.get(e);
            if (seen) seen.n++; else entries.set(e, { row, n: 1 });
        }
        totalRequests = 0;
        const groupColumns = gen.groupingColumnsFor([...rootVars, ...outer], options);
        const idx = keyIndices([...rootVars, ...outer]);
        table.columns = groupColumns;
        let shown = 0;
        let total = 0;
        for (const entries of roots.values()) {
            const list = [...entries.values()];
            list.forEach((entry, i) => {
                const request = totalRequests + Math.floor(i / reps) + 1;
                total++;
                if (shown < groupTableSize) { table.rows.push({ values: idx.map(j => entry.row[j] ?? ''), rowCount: entry.n, request }); shown++; }
            });
            totalRequests += Math.max(1, Math.ceil(list.length / reps));
        }
        table.more = Math.max(0, total - shown);
    } else if (shape === 'flat') {
        totalRequests = Math.ceil(rows.length / reps);
        table.columns = [];
    } else {
        totalRequests = rows.length;
    }

    // Where each request starts among the (sorted) rows: only needed to build requests past the first (planRequests)
    const requestStarts = (upTo: number): number[] => {
        const starts: number[] = [];
        if (shape === 'single') { for (let i = 0; i < rows.length && starts.length < upTo; i++) starts.push(i); return starts; }
        if (shape === 'flat') { for (let i = 0; i < rows.length && starts.length < upTo; i += reps) starts.push(i); return starts; }
        let lastRequest: string | undefined;
        let lastEntry: string | undefined;
        let entriesInRequest = 0;
        for (let i = 0; i < rows.length && starts.length < upTo; i++) {
            const r = requestKey(rows[i]);
            if (shape === 'grouped') {
                if (r !== lastRequest) { starts.push(i); lastRequest = r; }
                continue;
            }
            // nested: a new root starts a request; within it, every `reps` entries do
            const e = entryKey(rows[i]);
            if (r !== lastRequest) { starts.push(i); lastRequest = r; lastEntry = e; entriesInRequest = 1; continue; }
            if (e !== lastEntry) {
                lastEntry = e;
                if (entriesInRequest >= reps) { starts.push(i); entriesInRequest = 1; } else entriesInRequest++;
            }
        }
        return starts;
    };
    if (previewOffset > 0) {
        const starts = requestStarts(previewOffset + previewCount + 1);
        const from = starts[previewOffset];
        const page: PlanRequest[] = [];
        if (from !== undefined && previewCount > 0) {
            const to = starts[previewOffset + previewCount] ?? rows.length;
            const slice = rows.slice(from, to);
            const sliceCsv = [input.headers, ...slice].map(r => r.map(csvCell).join(',')).join('\n');
            const built = await generator.generateBatchJsonFiles(sliceCsv, options);
            if (!built.success) throw new Error((built as { error?: string }).error || 'Could not build the requests');
            const keyVars = shape === 'grouped' ? outer : shape === 'single' ? [] : rootVars;
            built.files.slice(0, previewCount).forEach((file: { content: unknown; rowRange?: { start: number; end: number } }, i: number) => {
                const local = file.rowRange ?? { start: i + 1, end: i + 1 };
                const inputRows = slice.slice(local.start - 1, local.end);
                const filled = fillUrl(inputRows[0] || [], queryParams);
                page.push({
                    index: previewOffset + i + 1,
                    key: keyVars.map(v => ({ variable: v, value: valueOf(inputRows[0] || [], v) })),
                    rowCount: inputRows.length, rowRange: { start: from + local.start, end: from + local.end }, inputRows,
                    method, url: filled.url, queryParams: filled.params,
                    body: file.content, size: new TextEncoder().encode(JSON.stringify(file.content)).length
                });
            });
        }
        const repsLabelAt = shape === 'flat' ? 'Rows per request'
            : shape === 'nested-2' || shape === 'nested-3' ? `${analysis.outerArray} per request` : '';
        return {
            shape, method, hasBody, arrayPath, arrayCandidates,
            reps: { applies: shape === 'flat' || shape === 'nested-2' || shape === 'nested-3', label: repsLabelAt, value: reps },
            variables, levels,
            totals: { rows: input.rows.length, requests: totalRequests },
            groups: table.columns.length > 0 ? table : null,
            requests: page, notes, template, urlTemplate
        };
    }

    // The first requests, built by the generator from a prefix of the (sorted) rows.
    let prefixLength: number;
    if (shape === 'single') prefixLength = previewCount;
    else if (shape === 'flat') prefixLength = previewCount * reps;
    else {
        const wanted = shape === 'grouped' ? previewCount : previewCount * reps;
        const key = shape === 'grouped' ? requestKey : entryKey;
        const seen = new Set<string>();
        prefixLength = rows.length;
        for (let i = 0; i < rows.length; i++) {
            seen.add(key(rows[i]));
            if (seen.size > wanted) { prefixLength = i; break; }
        }
    }
    const prefix = rows.slice(0, Math.min(prefixLength, rows.length));
    const csv = [input.headers, ...prefix].map(r => r.map(csvCell).join(',')).join('\n');
    const result = prefix.length === 0 ? { success: true, files: [] as Array<{ content: unknown; rowRange?: { start: number; end: number } }> }
        : await generator.generateBatchJsonFiles(csv, options);
    if (!result.success) {
        throw new Error((result as { error?: string }).error || 'Could not build the requests');
    }
    const keyVariables = shape === 'grouped' ? outer : shape === 'single' ? [] : rootVars;
    const requests: PlanRequest[] = result.files.slice(0, previewCount).map((file, i) => {
        const range = file.rowRange ?? { start: i + 1, end: i + 1 };
        const inputRows = prefix.slice(range.start - 1, range.end);
        const filled = fillUrl(inputRows[0] || [], queryParams);
        const json = JSON.stringify(file.content);
        return {
            index: i + 1,
            key: keyVariables.map(v => ({ variable: v, value: valueOf(inputRows[0] || [], v) })),
            rowCount: inputRows.length, rowRange: range, inputRows,
            method, url: filled.url, queryParams: filled.params,
            body: file.content, size: new TextEncoder().encode(json).length
        };
    });

    const repsLabel = shape === 'flat' ? 'Rows per request'
        : shape === 'nested-2' || shape === 'nested-3' ? `${analysis.outerArray} per request` : '';
    return {
        shape, method, hasBody, arrayPath, arrayCandidates,
        reps: { applies: shape === 'flat' || shape === 'nested-2' || shape === 'nested-3', label: repsLabel, value: reps },
        variables, levels,
        totals: { rows: input.rows.length, requests: totalRequests },
        groups: table.columns.length > 0 ? table : null,
        requests, notes, template, urlTemplate
    };
}

/**
 * Arrays that can repeat from data (GitHub Issue #354): a top-level array, or an array reached
 * through objects only — `items`, `Payload.ExportDocuments` — whose item has a variable of its own.
 * An array inside another array's item (`ExportDocuments[].ConditionCodes`) is part of that item,
 * not a candidate. Shallowest first, so a top-level array stays the default.
 */
function repeatableArrayCandidates(parsed: unknown): string[] {
    if (Array.isArray(parsed)) return [ROOT];
    const found: string[] = [];
    const walk = (obj: Record<string, unknown>, prefix: string) => {
        for (const [key, value] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (Array.isArray(value)) {
                if (value.length > 0 && variablesIn(JSON.stringify(value[0])).some(v => !isSystem(v))) found.push(path);
            } else if (value && typeof value === 'object') {
                walk(value as Record<string, unknown>, path);
            }
        }
    };
    if (parsed && typeof parsed === 'object') walk(parsed as Record<string, unknown>, '');
    const depth = (path: string) => path.split('.').length;
    return found.sort((a, b) => depth(a) - depth(b));
}

/** The array at a candidate path ('$root' or dotted through objects); undefined when there is none. */
function arrayAt(parsed: unknown, path: string): unknown[] | undefined {
    if (path === ROOT) return Array.isArray(parsed) ? parsed : undefined;
    let current: unknown = parsed;
    for (const part of path.split('.')) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return Array.isArray(current) ? current : undefined;
}

function bodyShape(analysis: { hasNestedArrays: boolean; nestingLevel?: number }, arrayCandidates: string[]): BatchShape {
    if (analysis.hasNestedArrays && analysis.nestingLevel === 1) return 'grouped';
    if (analysis.hasNestedArrays && analysis.nestingLevel === 2) return 'nested-2';
    if (analysis.hasNestedArrays && analysis.nestingLevel === 3) return 'nested-3';
    return arrayCandidates.length > 0 ? 'flat' : 'single';
}

/**
 * The array setting Execute sends with — the one Step 4 shows (GitHub Issue #354).
 *
 * Execute used to hand the endpoint's saved `repeatableArrays` straight to the generator, while
 * the plan ignored a saved array it did not offer: Review showed a request per row and Execute
 * packed every row into one. Both now take the array from here:
 *   - no array to repeat: nothing (a stale saved array is dropped)
 *   - one array, rows per request: the saved array when it is a candidate, else the first
 *     candidate, as planBatch picks it, with the saved Rows per request
 *   - 2- and 3-level templates: unchanged — the generator takes only the Reps from it
 */
export function effectiveRepeatableArrays(body: string | undefined, saved: RepeatableArray[] | null | undefined): RepeatableArray[] {
    const savedArrays = saved || [];
    const text = body && body.trim() ? stripJsonCommentsSafe(body).trim() : '';
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return savedArrays; }
    const analysis = new JsonGenerator().analyzeNestedArrays(text);
    const candidates = repeatableArrayCandidates(parsed);
    const shape = bodyShape(analysis, candidates);
    if (shape !== 'flat' && shape !== 'single') return savedArrays;
    const enabled = savedArrays.find(a => a.enabled);
    if (shape === 'single' || !enabled) return [];
    const arrayPath = candidates.includes(enabled.arrayPath) ? enabled.arrayPath : candidates[0];
    return [{ arrayPath, enabled: true, maxRepetitions: enabled.maxRepetitions }];
}

function roleForSystem(name: string): VariableRole | null {
    if (/^A8:/i.test(name)) return 'generated';
    if (/^ENV:/i.test(name)) return 'environment';
    return null;
}

function systemNote(name: string, innerArray?: string): string | undefined {
    if (/^A8:sequence:local/i.test(name)) return `numbers each entry, from 1 in every ${innerArray ? '`' + innerArray + '`' : 'array'}`;
    if (/^A8:sequence/i.test(name)) return 'a new number for each request';
    if (/^A8:(PAGE|SIZE)/i.test(name)) return 'pagination';
    if (/^A8:/i.test(name)) return 'generated by Dobermann';
    if (/^ENV:/i.test(name)) return 'from the environment';
    return undefined;
}

function csvCell(value: string): string {
    const v = value ?? '';
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
