// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: what Execute's confirmation window sends back with executeBulkLoadCommand (`confirm`), checked before a run:
 * Error handling, Threads (only one the environment allows, else one at a time) and, on production, the guard's
 * yes with its Warning frequency in minutes. Anything else the page sends is dropped, never trusted.
 */
export interface ExecuteChoices {
    stopOnFirstError: boolean;
    threads: number;
    /** The production guard's yes: its Warning frequency (0, 15, 30 or 60 minutes). Absent: no yes was given. */
    productionMinutes?: number;
}

const MINUTES = [0, 15, 30, 60];

export function cleanExecuteChoices(value: unknown, allowedThreads: number[]): ExecuteChoices {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const threads = typeof v.threads === 'number' && allowedThreads.includes(v.threads) ? v.threads : 1;
    const out: ExecuteChoices = { stopOnFirstError: v.errorHandling === 'stop', threads };
    const production = v.production as Record<string, unknown> | undefined;
    if (production && typeof production === 'object') {
        const minutes = Number(production.minutes);
        out.productionMinutes = MINUTES.includes(minutes) ? minutes : 0;
    }
    return out;
}
