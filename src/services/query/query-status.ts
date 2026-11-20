// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Results for a query with compared columns, as Compare shows them.
 *
 * Each row's status: DIFF where a compared column's cells differ (and in which places), Missing
 * where a view of the compare has no record, else Same. How its key met the others: one to one,
 * one to many (its key is on more than one row of a view: each of those is compared with it), not
 * in every result, or not in the Baseline. A result hidden on Results is left out of all of it, as
 * Compare leaves out a result it hides.
 *
 * Results' filters combine as Compare's: the Status ticks, a compared column's DIFF pill (rows
 * that differ there), and the relationship's ticks.
 */
import { CALC_VIEW } from './query-types';
import type { ColumnRef } from './query-types';

export type RelationKind = 'oneToOne' | 'oneToMany' | 'onlyBase' | 'onlyOther';
export const RELATION_KINDS: readonly RelationKind[] = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'];

/** A row's status. */
export interface RowStatus {
    /** The places whose value differs from the first's in a compared column. */
    diff: string[];
    /** The places of the compare without the record. */
    missing: string[];
    /** The compared columns (by name) that differ in this row. */
    groups: string[];
    /** How its key met the others (only in a compare). */
    relation?: RelationKind;
    /** The places where its key is on more than one row. */
    repeated?: string[];
}

/** What Results shows, by Compare's filters. Each left out (or null) lets every row through. */
export interface StatusFilter {
    /** 'same', 'diff', 'missing:<place>': the ticked lines of the Status menu. */
    kinds?: string[] | null;
    /** Compared columns: rows that differ in any of them. */
    columns?: string[];
    relations?: RelationKind[] | null;
    /** Results hidden on Results: left out of every status. */
    hidden?: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The compared columns of Results: the cells side by side with one group, two or more. */
export function comparedGroups(columns: ColumnRef[]): { name: string; cells: number[] }[] {
    const groups: { name: string; cells: number[] }[] = [];
    columns.forEach((c, i) => {
        const last = groups[groups.length - 1];
        if (c.group && last && last.name === c.group && last.cells[last.cells.length - 1] === i - 1) last.cells.push(i);
        else if (c.group) groups.push({ name: c.group, cells: [i] });
    });
    return groups.filter(g => g.cells.length > 1);
}

/**
 * Each row's status. `keyPlaces` are the views of the compare, the Baseline first, and
 * `keys[row][place]` each one's key in the row (blank: it hasn't the record). A cell differs
 * from its column's first cell when their text differs; a place without the record is Missing,
 * not different. A COMPARE calculation's sides are places 1, 2... Undefined when nothing is compared.
 */
export function rowStatus(
    columns: ColumnRef[], rows: unknown[][], keyPlaces: string[], keys: unknown[][], placeOf: (view: string) => string, hidden: string[] = []
): { rows: RowStatus[]; places: string[] } | undefined {
    const compared = comparedGroups(columns);
    if (!compared.length && !keyPlaces.length) return undefined;
    const placeOfCell = (i: number): string => (columns[i].view === CALC_VIEW ? (/ (\d+)$/.exec(columns[i].column)?.[1] ?? columns[i].column) : placeOf(columns[i].view));
    const places = [...new Set([...keyPlaces, ...compared.flatMap(g => g.cells.map(placeOfCell))])];
    const shown = (p: string): boolean => !hidden.includes(p);
    // How many rows hold each key, in each place: more than one, and the key repeats there
    const held = keyPlaces.map((_, p) => {
        const count = new Map<string, number>();
        keys.forEach(k => { const v = k[p]; if (v !== null && v !== undefined) count.set(text(v), (count.get(text(v)) ?? 0) + 1); });
        return count;
    });
    return {
        places,
        rows: rows.map((row, r) => {
            const k = keys[r] ?? [];
            const missing = keyPlaces.filter((p, i) => shown(p) && (k[i] === null || k[i] === undefined));
            const diff = new Set<string>();
            const groups: string[] = [];
            for (const g of compared) {
                const cells = g.cells.filter(i => shown(placeOfCell(i)) && !missing.includes(placeOfCell(i)));
                if (cells.length < 2) continue;
                const first = text(row[cells[0]]);
                let differs = false;
                cells.slice(1).forEach(i => { if (text(row[i]) !== first) { diff.add(placeOfCell(i)); differs = true; } });
                if (differs) groups.push(g.name);
            }
            const status: RowStatus = { diff: [...diff], missing, groups };
            if (keyPlaces.length) {
                const repeated = keyPlaces.filter((p, i) => shown(p) && k[i] !== null && k[i] !== undefined && (held[i].get(text(k[i])) ?? 0) > 1);
                status.relation = shown(keyPlaces[0]) && missing.includes(keyPlaces[0]) ? 'onlyOther'
                    : missing.length ? 'onlyBase'
                        : repeated.length ? 'oneToMany' : 'oneToOne';
                if (repeated.length) status.repeated = repeated;
            }
            return status;
        })
    };
}

/** Does a row pass Results' filters? */
export function passes(status: RowStatus, filter: StatusFilter): boolean {
    const kinds = filter.kinds;
    if (kinds) {
        const same = !status.diff.length && !status.missing.length;
        const ok = (status.diff.length > 0 && kinds.includes('diff')) || status.missing.some(p => kinds.includes(`missing:${p}`)) || (same && kinds.includes('same'));
        if (!ok) return false;
    }
    if (filter.columns?.length && !filter.columns.some(c => status.groups.includes(c))) return false;
    if (filter.relations && status.relation && !filter.relations.includes(status.relation)) return false;
    return true;
}

/** The counts Results' controls show: each status, each relationship, and each compared column's DIFFs. */
export interface StatusCounts {
    all: number;
    same: number;
    diff: number;
    missing: Record<string, number>;
    relations: Partial<Record<RelationKind, number>>;
    columns: Record<string, number>;
}

export function statusCounts(statuses: RowStatus[], indices: number[]): StatusCounts {
    const out: StatusCounts = { all: indices.length, same: 0, diff: 0, missing: {}, relations: {}, columns: {} };
    for (const i of indices) {
        const st = statuses[i];
        if (st.diff.length) out.diff++;
        if (!st.diff.length && !st.missing.length) out.same++;
        st.missing.forEach(p => { out.missing[p] = (out.missing[p] ?? 0) + 1; });
        if (st.relation) out.relations[st.relation] = (out.relations[st.relation] ?? 0) + 1;
        st.groups.forEach(g => { out.columns[g] = (out.columns[g] ?? 0) + 1; });
    }
    return out;
}
