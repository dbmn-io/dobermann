// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One retry every Supabase adapter in this folder uses (#417). Not a core module: nothing in
 * the core speaks PostgREST.
 */
/**
 * PostgREST checks a real (ES256) token's "issued at" against a cached clock. Seen 2026-10-06
 * on the local stack: after 27 idle minutes, the first of three catalogue reads straight after
 * sign-in was refused with "JWT issued at future", and the other two, a moment later and with
 * the same token, passed. The cached clock evidently lagged until that first request refreshed
 * it. Could not be reproduced on a warm API. Retry such a refusal once, after a moment.
 */
const ISSUED_AT_FUTURE = /issued at future/i;
const CLOCK_SETTLE_MS = 1100;

type QueryResult<T> = { data: T | null; error: { message: string } | null };

export async function settled<T>(query: () => PromiseLike<QueryResult<T>>): Promise<QueryResult<T>> {
    const first = await query();
    if (!first.error || !ISSUED_AT_FUTURE.test(first.error.message)) {
        return first;
    }
    await new Promise(resolve => setTimeout(resolve, CLOCK_SETTLE_MS));
    return query();
}
