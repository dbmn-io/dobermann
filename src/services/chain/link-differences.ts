// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: what changed between two linked runs. A chain's rows can land somewhere
 * else on purpose (DEV → UAT), but the user should see it: the Chain dialog warns before, and
 * the Links tab shows it after. A warning only, never a block.
 *
 * Compared: environment; the environment's header values each run was sent with, each by its
 * own name (org, version…; James, 2026-11-24: "whatever headings exist on the environment that
 * we've run against", never a fixed Organization), one on one side only included; and every
 * request header both runs sent with a different value. Secrets are never compared or shown, and
 * headers that change on every request (length, date, trace ids) are ignored.
 */

export interface RunContext {
    environment?: string;
    /** The environment's header values the run was sent with, by name (an old run's organization as org). */
    headerValues?: Record<string, string>;
    headers?: Record<string, string>;
}

export interface LinkDifference {
    field: string;      // "Environment", a header value's name (org), or a request header's
    from: string;
    to: string;
}

const IGNORED_HEADERS = new Set([
    // secrets
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey',
    // differ on every request
    'content-length', 'date', 'host', 'connection', 'user-agent', 'accept-encoding',
    'x-request-id', 'x-correlation-id', 'correlation-id', 'request-id', 'traceparent', 'tracestate',
    'idempotency-key'
]);

function normalise(value: unknown): string {
    return value === undefined || value === null ? '' : String(value).trim();
}

/** `from` is the run the rows came from, `to` the run they went into. */
export function linkDifferences(from: RunContext, to: RunContext): LinkDifference[] {
    const out: LinkDifference[] = [];
    const compare = (field: string, a: unknown, b: unknown) => {
        const x = normalise(a);
        const y = normalise(b);
        if (x && y && x !== y) out.push({ field, from: x, to: y });
    };
    compare('Environment', from.environment, to.environment);
    for (const d of headerDifferences(from.headerValues, to.headerValues)) {
        out.push({ field: d.field, from: d.from || NOT_SENT, to: d.to || NOT_SENT });
    }

    const lower = (h?: Record<string, string>) => {
        const m = new Map<string, { name: string; value: string }>();
        for (const [name, value] of Object.entries(h || {})) {
            if (IGNORED_HEADERS.has(name.toLowerCase())) continue;
            m.set(name.toLowerCase(), { name, value: normalise(value) });
        }
        return m;
    };
    const a = lower(from.headers);
    const b = lower(to.headers);
    for (const [key, left] of a) {
        const right = b.get(key);
        if (!right) continue;                 // a header only one endpoint sends is not a change
        if (left.value !== right.value && left.value && right.value) {
            out.push({ field: left.name, from: left.value, to: right.value });
        }
    }
    return out;
}

/** The word for a header value one run had and the other didn't. */
const NOT_SENT = 'not sent';

/**
 * Two runs' header values, by name (case aside): each that differs, or that one has and the other
 * doesn't ('' on the side without). A run that kept none is not compared: it says nothing.
 */
export function headerDifferences(from: Record<string, string> | undefined, to: Record<string, string> | undefined): LinkDifference[] {
    const byName = (values?: Record<string, string>) => {
        const m = new Map<string, { name: string; value: string }>();
        for (const [name, value] of Object.entries(values || {})) {
            const v = normalise(value);
            if (v) m.set(name.toLowerCase(), { name, value: v });
        }
        return m;
    };
    const a = byName(from);
    const b = byName(to);
    if (a.size === 0 || b.size === 0) return [];
    const out: LinkDifference[] = [];
    for (const [key, left] of a) {
        const right = b.get(key);
        if (!right) out.push({ field: left.name, from: left.value, to: '' });
        else if (left.value !== right.value) out.push({ field: left.name, from: left.value, to: right.value });
    }
    for (const [key, right] of b) {
        if (!a.has(key)) out.push({ field: right.name, from: '', to: right.value });
    }
    return out;
}

/** The Chain dialog's warnings: the rows' run against the active environment, a header at a time. */
export function chainHeaderWarnings(diffs: LinkDifference[]): string[] {
    return diffs.map(d => `Rows came from ${d.from ? `${d.field} ${d.from}` : `a run without ${d.field}`}. `
        + `The active environment sends ${d.to ? `${d.field} ${d.to}` : `no ${d.field}`}.`);
}

/** "Environment DEV → UAT · Location DC-01 → DC-02" */
export function describeDifferences(diffs: LinkDifference[]): string {
    return diffs.map(d => `${d.field} ${d.from} → ${d.to}`).join(' · ');
}
