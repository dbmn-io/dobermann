// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #115: what a response body is, from its text, content type and URL.
 *
 * JSON Lines (JSONL / NDJSON, https://jsonlines.org) is one JSON value per line: bulk exports,
 * feeds and streamed results. A JSONL response is still ONE transaction (one request, one status,
 * one retry); its lines become an array of records in `data`, so the Console's Completed tab gives
 * each line its own row through the usual row basis (`data`), and `format` lets the Raw tab show
 * the lines as they came.
 *
 * - Declared JSONL (`application/x-ndjson`, `application/jsonl`, … or a `.jsonl`/`.ndjson` URL):
 *   every line that parses is a record. Lines that don't (often the last one, cut off when a stream
 *   breaks) are kept in `format.invalid` so the loss is visible, not silent.
 * - Declared JSON: parsed as JSON. A body that isn't one JSON value but whose every line is (APIs
 *   that send JSONL as `application/json`) is JSONL. Anything else stays text, so the body is kept.
 * - Anything else: text, as before, unless every line (two or more) is a JSON object or array.
 */

export interface JsonlInvalidLine {
    /** 1-based line number in the body. */
    line: number;
    /** The line as received, cut to MAX_INVALID_TEXT characters. */
    text: string;
}

export interface JsonlFormat {
    kind: 'jsonl';
    records: number;
    /** Lines that are not JSON; at most MAX_INVALID_KEPT are kept, `invalidCount` has them all. */
    invalid: JsonlInvalidLine[];
    invalidCount: number;
}

export type ResponseFormat = JsonlFormat;

/** How much of a body has arrived (#115): a big export can take many seconds to download. */
export interface BodyProgress {
    bytes: number;
    /** Lines so far: records, for a JSON Lines body. */
    lines: number;
    /** From Content-Length, when the server sent one (streamed bodies usually don't). */
    totalBytes?: number;
    /** Labelled JSON Lines, so `lines` are records. */
    jsonl: boolean;
    /** Records coming, from X-Total-Count (the common header for it), when the server sends one. */
    totalRecords?: number;
    /** The whole body is in. */
    done: boolean;
}

export type BodyProgressListener = (progress: BodyProgress) => void;

const PROGRESS_INTERVAL_MS = 250;

/**
 * The body as text. With a listener, read as a stream so the listener hears how much has
 * arrived (at most every PROGRESS_INTERVAL_MS, and once at the end); without one, in one go.
 */
export async function readResponseText(response: Response, onProgress?: BodyProgressListener): Promise<string> {
    if (!onProgress || !response.body) return response.text();
    const length = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(length) && length > 0 ? length : undefined;
    const jsonl = isJsonlContentType(response.headers.get('content-type')) || JSONL_URL.test(response.url);
    const count = Number(response.headers.get('x-total-count'));
    const totalRecords = jsonl && Number.isInteger(count) && count > 0 ? count : undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    let lines = 0;
    let last = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        parts.push(text);
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
        const now = Date.now();
        if (now - last >= PROGRESS_INTERVAL_MS) {
            last = now;
            onProgress({ bytes, lines, totalBytes, totalRecords, jsonl, done: false });
        }
    }
    parts.push(decoder.decode());
    // A last line with no newline after it is a line too
    const tail = parts[parts.length - 1] || parts[parts.length - 2] || '';
    if (bytes > 0 && !tail.endsWith('\n')) lines++;
    onProgress({ bytes, lines, totalBytes, totalRecords, jsonl, done: true });
    // Parsing and saving a big body next is one long blocking stretch. In the web app the Console
    // shares this page's thread, so let it paint "100% · Processing" first or it shows the last
    // update (95%) until the run is over.
    await new Promise(resolve => setTimeout(resolve, 50));
    return parts.join('');
}

export interface ParsedResponseBody {
    data: unknown;
    format?: ResponseFormat;
}

const JSONL_CONTENT_TYPE = /\b(?:application|text)\/(?:x-)?(?:ndjson|jsonl|jsonlines|json-lines)\b/i;
const JSONL_URL = /\.(?:jsonl|ndjson)(?:[?#]|$)/i;
const JSON_CONTENT_TYPE = /\bjson\b/i;
const MAX_INVALID_KEPT = 100;
const MAX_INVALID_TEXT = 500;

export function isJsonlContentType(contentType: string | null | undefined): boolean {
    return !!contentType && JSONL_CONTENT_TYPE.test(contentType);
}

export function parseResponseBody(text: string, contentType: string | null | undefined, url?: string): ParsedResponseBody {
    if (isJsonlContentType(contentType) || (url && JSONL_URL.test(url))) {
        const parsed = parseJsonl(text, false);
        // Labelled JSONL but no line is JSON: a pretty-printed JSON document, or not JSON at all
        if (parsed?.format?.records === 0 && parsed.format.invalidCount > 0) {
            try { return { data: JSON.parse(text) }; } catch { return { data: text }; }
        }
        return parsed ?? { data: text };
    }
    if (contentType && JSON_CONTENT_TYPE.test(contentType)) {
        if (text.trim() === '') return { data: text };
        try {
            return { data: JSON.parse(text) };
        } catch {
            return parseJsonl(text, true) ?? { data: text };
        }
    }
    return looksLikeJsonl(text) ? (parseJsonl(text, true) ?? { data: text }) : { data: text };
}

/** Cheap pre-check before trying a plain-text body as JSONL. */
function looksLikeJsonl(text: string): boolean {
    const start = text.trimStart()[0];
    return (start === '{' || start === '[') && /\n\s*[{[]/.test(text);
}

/**
 * Lines → records. `strict` (sniffing, not declared): every non-blank line must be a JSON object
 * or array, and there must be two or more; otherwise null, so the caller keeps the text.
 */
function parseJsonl(text: string, strict: boolean): ParsedResponseBody | null {
    const records: unknown[] = [];
    const invalid: JsonlInvalidLine[] = [];
    let invalidCount = 0;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            if (strict) return null;
            invalidCount++;
            if (invalid.length < MAX_INVALID_KEPT) invalid.push({ line: i + 1, text: line.slice(0, MAX_INVALID_TEXT) });
            continue;
        }
        if (strict && (value === null || typeof value !== 'object')) return null;
        records.push(value);
    }
    if (strict && records.length < 2) return null;
    return { data: records, format: { kind: 'jsonl', records: records.length, invalid, invalidCount } };
}
