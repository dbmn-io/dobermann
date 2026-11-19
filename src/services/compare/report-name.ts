// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A report's name: a query's or a compare's. It is the report's tab, its line on the Reporting
 * list and what a search finds, so it is short; and one report may come to read another by
 * name, so no two reports share one, whatever their kind.
 */
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';

export const REPORT_NAME_MAX = 30;

type Named = { id?: unknown; name?: unknown };
type ReportState = Pick<IKeyValueStore, 'get'>;

/** The names taken (lower case) by every saved query and compare but `exceptId`. */
function taken(state: ReportState, exceptId?: string): Set<string> {
    const names = new Set<string>();
    for (const key of ['queries', 'compares']) {
        const list = state.get<Named[]>(key);
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (item && item.id !== exceptId && typeof item.name === 'string' && item.name.trim()) names.add(item.name.trim().toLowerCase());
        }
    }
    return names;
}

/** Why the report `id` can't be called `name`, or '' when it can. */
export function reportNameProblem(state: ReportState, id: string, name: string): string {
    if (!name) return 'A report needs a name.';
    if (name.length > REPORT_NAME_MAX) return `A name is up to ${REPORT_NAME_MAX} characters.`;
    return taken(state, id).has(name.toLowerCase()) ? `Another report is already called ${name}.` : '';
}

/** `base`, cut to length, with a number after it when another report has the name. */
export function freeReportName(state: ReportState, base: string, exceptId?: string): string {
    const names = taken(state, exceptId);
    const clean = base.trim() || 'Report';
    let name = clean.slice(0, REPORT_NAME_MAX).trim();
    for (let n = 2; names.has(name.toLowerCase()); n++) {
        const tail = ` ${n}`;
        name = `${clean.slice(0, REPORT_NAME_MAX - tail.length).trim()}${tail}`;
    }
    return name;
}
