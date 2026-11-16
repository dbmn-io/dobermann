// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A page of Fetch all (or Next pages) that fails for a moment is asked for again before it counts
 * as an error (found 2026-10-16 hunting Puppy School Lesson 4's short table: one page answered 503
 * and the table stayed 500 rows short, the Errors tab's "1" the only sign).
 *
 * Only pages: they are reads, so asking twice is harmless. A batch that creates or changes data is
 * never retried here: a POST the server may already have processed must not run twice.
 *
 * Temporary: the server too busy (429), or failing for now (500, 502, 503, 504), or no answer at
 * all (the network). Anything else (a 400, a 404) will fail the same way again.
 *
 * Portable: a result in, a decision out.
 */
import type { ExecutionResult } from '../execution/execution.interface';

/** How long to wait before each further try: two more, a second then three apart. */
export const PAGE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Did this page fail in a way worth asking again? */
export function isTemporaryPageFailure(result: Pick<ExecutionResult, 'success' | 'httpStatus' | 'cancelled'>): boolean {
    if (result.success || result.cancelled) return false;
    // No status: no answer came back (the network dropped, the request timed out)
    if (!result.httpStatus) return true;
    return TEMPORARY_STATUSES.has(result.httpStatus);
}
