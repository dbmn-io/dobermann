// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: what the user was looking at on Review, carried into the Console that takes the Run Batch tab's place, so the
 * swap shows no jump: the Requests tab, its search, how far it was scrolled, the request picked, its sort and widths.
 * Sent by the page with Execute (executeBulkLoadCommand.review), kept by Run Batch, handed by the Hub to the Console.
 */
export interface ReviewHandoff {
    tab: 'requests';
    search: string;
    scrollTop: number;
    /** The request picked (its index on Review), if one was. */
    selected?: number;
    sort?: { id: string; dir: 'asc' | 'desc' } | null;
    widths?: Record<string, number>;
}

/** What the page sent, kept only as far as it is the shape above (anything else is dropped, never trusted). */
export function cleanReviewHandoff(value: unknown): ReviewHandoff | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    const out: ReviewHandoff = {
        tab: 'requests',
        search: typeof v.search === 'string' ? v.search.slice(0, 2000) : '',
        scrollTop: typeof v.scrollTop === 'number' && Number.isFinite(v.scrollTop) && v.scrollTop > 0 ? Math.round(v.scrollTop) : 0
    };
    if (typeof v.selected === 'number' && Number.isInteger(v.selected) && v.selected >= 0) out.selected = v.selected;
    const sort = v.sort as Record<string, unknown> | null | undefined;
    if (sort && typeof sort.id === 'string') out.sort = { id: sort.id, dir: sort.dir === 'desc' ? 'desc' : 'asc' };
    if (v.widths && typeof v.widths === 'object') {
        const widths: Record<string, number> = {};
        for (const [id, w] of Object.entries(v.widths as Record<string, unknown>)) {
            if (typeof w === 'number' && Number.isFinite(w) && w > 0 && w < 5000) widths[id] = Math.round(w);
        }
        if (Object.keys(widths).length) out.widths = widths;
    }
    return out;
}
