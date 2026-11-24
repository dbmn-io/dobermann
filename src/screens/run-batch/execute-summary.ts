// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: what Run Batch's Execute confirmation says and offers, from the batch plan Review was drawn from and the
 * active environment: N rows as M requests to <environment> with its header values, the URL; Error handling and
 * Threads to choose; on production the shared guard (production-guard.service), folded into the same window.
 * Pure: the page draws it (runBatch.executeConfirm), the host never decides it twice.
 */
import { productionGuardFor, type ProductionGuard, type ProductionGuardEnv } from '../../services/ui/production-guard.service';

export interface ExecuteSummary {
    rows: number;
    requests: number;
    /** Rows (or items) per request where the plan has one, else null. */
    rowsPerRequest: { label: string; value: number } | null;
    method: string;
    /** The environment's base URL and the endpoint's path with its {{variables}}. */
    url: string;
    environment: { name: string; production: boolean; headers: Array<{ name: string; value: string }> };
    /** Review's own words (and the approved mock's): Continue processing / Stop on first error. */
    errorHandling: { value: 'continue' | 'stop'; options: Array<{ value: 'continue' | 'stop'; label: string }> };
    threads: { value: number; options: number[] };
    guard: ProductionGuard | null;
    /** The whole of it in one line, e.g. "105 rows as 21 requests to Test (ORG DM1): POST https://…/items". */
    sentence: string;
}

export interface ExecuteSummaryInput {
    plan: {
        method: string;
        urlTemplate: string;
        reps: { applies: boolean; label: string; value: number };
        totals: { rows: number; requests: number };
        requests: Array<{ url: string }>;
    } | undefined;
    environment: ProductionGuardEnv & { baseUrl?: string; parallelProcessing?: { enabled: boolean; maxConcurrency: number } };
    headers: Array<{ name: string; value: string }>;
    /** What the user chose last time on this tab (kept by Run Batch), else the defaults. */
    current: { stopOnFirstError?: boolean; threads?: number };
}

const PARALLEL = [2, 4, 8, 16];
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

/** The Threads a run may use: one always; in parallel, 2, 4, 8, 16 up to the environment's limit (as Review offers). */
export function threadChoices(environment: ExecuteSummaryInput['environment']): number[] {
    const parallel = environment.parallelProcessing;
    if (!parallel || !parallel.enabled) return [1];
    const max = parallel.maxConcurrency || 16;
    return [1, ...PARALLEL.filter(n => n <= max)];
}

export function executeSummary(input: ExecuteSummaryInput): ExecuteSummary {
    const { plan, environment, headers, current } = input;
    if (!plan) throw new Error('Review has not been drawn yet: nothing to confirm');
    const rows = plan.totals.rows;
    const requests = plan.totals.requests;
    const base = (environment.baseUrl || '').replace(/\/+$/, '');
    const url = plan.urlTemplate ? `${base}${plan.urlTemplate.startsWith('/') ? '' : '/'}${plan.urlTemplate}` : (plan.requests[0]?.url || base);
    const options = threadChoices(environment);
    const threads = current.threads && options.includes(current.threads) ? current.threads : 1;
    const shownHeaders = headers.filter(h => h.value).map(h => ({ name: h.name, value: h.value }));
    const said = shownHeaders.length ? ` (${shownHeaders.map(h => `${h.name} ${h.value}`).join(', ')})` : '';
    return {
        rows,
        requests,
        rowsPerRequest: plan.reps.applies ? { label: plan.reps.label, value: plan.reps.value } : null,
        method: plan.method,
        url,
        environment: { name: environment.name, production: environment.environmentType === 'production', headers: shownHeaders },
        errorHandling: {
            value: current.stopOnFirstError ? 'stop' : 'continue',
            options: [{ value: 'continue', label: 'Continue processing' }, { value: 'stop', label: 'Stop on first error' }]
        },
        threads: { value: threads, options },
        guard: productionGuardFor(environment, 'Run Batch'),
        sentence: `${plural(rows, 'row')} as ${plural(requests, 'request')} to ${environment.name}${said}: ${plan.method} ${url}`
    };
}
