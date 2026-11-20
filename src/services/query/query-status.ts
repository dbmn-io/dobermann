// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Results' Status for a query with compared columns, as Compare says it: a row is DIFF where a
 * compared column's cells differ (and in which places), Missing where a view of the compare has no
 * record, else Same.
 */
import { CALC_VIEW } from './query-types';
import type { ColumnRef } from './query-types';

/** A row's status: the places whose value differs from the first's in a compared column, and the places of the compare without the record. */
export interface RowStatus {
    diff: string[];
    missing: string[];
}


/**
 * Each row's status, from its compared columns (Results' columns side by side with one group) and
 * which views of the compare have its record. A cell differs from the group's first cell when its
 * text differs, a view without the record left out (it is Missing, not different). A COMPARE
 * calculation's sides are places 1, 2... Undefined when nothing is compared.
 */
export function rowStatus(columns: ColumnRef[], rows: unknown[][], keyPlaces: string[], present: number[][], placeOf: (view: string) => string): { rows: RowStatus[]; places: string[] } | undefined {
    const groups: number[][] = [];
    columns.forEach((c, i) => {
        const last = groups[groups.length - 1];
        if (c.group && i > 0 && columns[i - 1].group === c.group && last && last.includes(i - 1)) last.push(i);
        else if (c.group) groups.push([i]);
    });
    const compared = groups.filter(g => g.length > 1);
    if (!compared.length && !keyPlaces.length) return undefined;
    const placeOfCell = (i: number): string => (columns[i].view === CALC_VIEW ? (/ (\d+)$/.exec(columns[i].column)?.[1] ?? columns[i].column) : placeOf(columns[i].view));
    const places = [...new Set([...keyPlaces, ...compared.flatMap(g => g.map(placeOfCell))])];
    const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return {
        places,
        rows: rows.map((row, r) => {
            const missing = keyPlaces.filter((_, p) => present[r] && present[r][p] === 0);
            const diff = new Set<string>();
            for (const g of compared) {
                const cells = g.filter(i => !missing.includes(placeOfCell(i)));
                if (cells.length < 2) continue;
                const first = text(row[cells[0]]);
                cells.slice(1).forEach(i => { if (text(row[i]) !== first) diff.add(placeOfCell(i)); });
            }
            return { diff: [...diff], missing };
        })
    };
}
