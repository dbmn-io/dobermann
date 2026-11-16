// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: what changed between two linked runs. A chain's rows can land somewhere
 * else on purpose (DEV → UAT), but the user should see it: the Chain dialog warns before, and
 * the Links tab shows it after. A warning only, never a block.
 *
 * Compared: environment, organization, and every request header both runs sent with a
 * different value. Secrets are never compared or shown, and headers that change on every
 * request (length, date, trace ids) are ignored.
 */

export interface RunContext {
    environment?: string;
    organization?: string;
    headers?: Record<string, string>;
}

export interface LinkDifference {
    field: string;      // "Environment", "Organization", or the header name
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
    compare('Organization', from.organization, to.organization);

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

/** "Environment DEV → UAT · Location DC-01 → DC-02" */
export function describeDifferences(diffs: LinkDifference[]): string {
    return diffs.map(d => `${d.field} ${d.from} → ${d.to}`).join(' · ');
}
