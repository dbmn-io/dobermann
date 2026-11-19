// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: a request opened from the Logs screen, as text: what its own run log holds
 * (ExecutionLoggingService), event by event, the request and the response with their bodies.
 *
 * Headers show their value only when it is harmless (Content-Type, Accept…); every other header
 * shows its name, its value `[removed]`, whatever it is called, since a header can carry a secret under any name.
 * The text then goes through the app log's secret removal (redact.ts) as a line does, for runs
 * written before it existed.
 */
import type { LogEvent } from './execution-logging.interface';
import { REMOVED } from './redact';

/** Headers whose values are shown. Any other header shows its name only. */
export const SHOWN_HEADERS = new Set([
    'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection', 'content-encoding',
    'content-language', 'content-length', 'content-type', 'date', 'etag', 'expires', 'host', 'last-modified',
    'location', 'pragma', 'retry-after', 'server', 'transfer-encoding', 'user-agent', 'vary',
    'x-correlation-id', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'
]);

/** The word a hidden value shows as: the same as a secret removed from a line. */
const NOT_SHOWN = REMOVED;

function headerLines(headers: Record<string, string> | undefined): string[] {
    return Object.entries(headers ?? {}).map(([name, value]) => `  ${name}: ${SHOWN_HEADERS.has(name.toLowerCase()) ? value : NOT_SHOWN}`);
}

function bodyText(body: unknown): string {
    if (body === undefined || body === null || body === '') return '';
    if (typeof body === 'string') {
        try {
            return JSON.stringify(JSON.parse(body), null, 2);
        } catch {
            return body;
        }
    }
    try {
        return JSON.stringify(body, null, 2);
    } catch {
        return String(body);
    }
}

const indent = (text: string) => text.replace(/^/gm, '  ');

/** Headers anywhere in a run log's data (`headers`, `requestHeaders`…): harmless values only. */
function hideHeaders(value: unknown, depth = 0): unknown {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => hideHeaders(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (/headers$/i.test(key) && v && typeof v === 'object' && !Array.isArray(v)) {
            out[key] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, val]) => [name, SHOWN_HEADERS.has(name.toLowerCase()) ? val : NOT_SHOWN]));
        } else {
            out[key] = hideHeaders(v, depth + 1);
        }
    }
    return out;
}

function httpLines(http: NonNullable<LogEvent['http']>): string[] {
    const out: string[] = [];
    const call = [http.method, http.url || http.path].filter(Boolean).join(' ');
    const status = http.status !== undefined ? `${http.status}${http.statusText ? ` ${http.statusText}` : ''}` : '';
    const took = http.duration !== undefined ? ` (${http.duration} ms)` : '';
    if (call || status) out.push(`  ${[call, status].filter(Boolean).join(' → ')}${took}`);
    const headers = headerLines(http.headers);
    if (headers.length) out.push('  Headers', ...headers.map(h => `  ${h}`));
    if (http.queryParams && Object.keys(http.queryParams).length) {
        out.push('  Query', ...Object.entries(http.queryParams).map(([k, v]) => `    ${k}=${v}`));
    }
    const body = bodyText(http.body);
    if (body) out.push('  Body', indent(indent(body)));
    return out;
}

/**
 * A request's run log as text, its secrets removed by `redact`: the request and its response
 * first, then everything the run log holds, event by event.
 */
export function requestDetail(events: LogEvent[], redact: (text: string) => string): string {
    if (!events.length) return 'Nothing more was kept for this request.';
    const out: string[] = [];
    const sent = events.find(e => e.http?.method);
    const answered = [...events].reverse().find(e => e.http?.status !== undefined);
    if (sent?.http) out.push('Request', ...httpLines(sent.http), '');
    if (answered?.http && answered !== sent) out.push('Response', ...httpLines(answered.http), '');
    const failed = events.filter(e => e.error);
    for (const e of failed) out.push(`Error: ${e.error!.message}${e.error!.code ? ` (${e.error!.code})` : ''}`, '');
    out.push('Everything its run log holds', '');
    for (const event of events) {
        out.push([event.timestamp, event.level.toUpperCase(), `${event.phase} · ${event.event}`].filter(Boolean).join('  '));
        if (event.http) out.push(...httpLines(event.http));
        if (event.error) out.push(`  Error: ${event.error.message}${event.error.code ? ` (${event.error.code})` : ''}`);
        if (event.data && Object.keys(event.data).length) out.push(indent(bodyText(hideHeaders(event.data))));
        out.push('');
    }
    return redact(out.join('\n').trimEnd());
}
