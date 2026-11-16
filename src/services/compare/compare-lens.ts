// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: what Results show of a compare. The compare (compareAcross) measures every result
 * against the Baseline (BL, place 0) once; the lens reads it through what the user shows:
 *
 *   - the results shown (BL always; C1, C2, C3 can be hidden)
 *   - the compared columns not hidden
 *
 * and gives each row its Status: DIFF and the results that differ, and/or Missing and the
 * results without the record, or Same. A hidden result or column is not compared, so hiding one
 * changes the Status, the counts and the rows a filter shows. A new lens is a recount over every
 * row; only rows with some difference read their values again.
 *
 * The Status filter picks rows by kind: Same, DIFF, and Missing by result (Missing BL, Missing
 * C1...). Which rows (the join picked on the Compare step) only sets where its ticks start.
 *
 * Who differs: each result shown whose value differs from BL's in a shown column. When BL alone
 * is the odd one out (two or more others, all alike, all unlike BL) it is BL that differs.
 */
import type { CompareJoin, CompareRowData } from './compare-engine';
import type { AcrossResult } from './compare-across';

export type LensKind = 'same' | 'diff' | 'missing';
export const LENS_KINDS: readonly LensKind[] = ['same', 'diff', 'missing'];

/** The Status filter's ticks: Same, DIFF, and the results whose missing records show. */
export interface LensFilter {
    same: boolean;
    diff: boolean;
    /** Places: a row missing from any of these shows. */
    missing: number[];
    /** Compared columns (their count pill clicked): only rows that differ in every one of these. */
    columns?: string[];
    /** The Relationship filter: the relationships shown (absent: all of them). */
    relations?: Relation[];
}

/**
 * How a row's key meets the results, Match's pictures in Results: every shown result has it once
 * (oneToOne); some result holds it more than once, shown or not, so BL's record is compared with
 * each (oneToMany); some shown result lacks it while BL has it (onlyBase); BL lacks it (onlyOther).
 */
export type Relation = 'oneToOne' | 'oneToMany' | 'onlyBase' | 'onlyOther';
export const RELATIONS: readonly Relation[] = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'];

export interface LensOptions {
    /** The results shown, by place. BL (0) is always shown. */
    visible: number[];
    /** Compared columns hidden on Results. */
    hiddenColumns?: string[];
}

/**
 * Where the Status filter starts for the join picked on the Compare step (a soft rule: every
 * row is still there, ticked back on in the filter): Everything; All of BL (not Missing BL);
 * All of C1 (not Missing C1); Matching only (no Missing).
 */
export function filterForJoin(join: CompareJoin, visible: number[]): LensFilter {
    const missing = join === 'inner' ? [] : visible.filter(p => !(join === 'left' && p === 0) && !(join === 'right' && p === 1));
    return { same: true, diff: true, missing };
}

export interface LensStatus {
    /** The results that differ (BL alone when it is the odd one out). */
    diff: number[];
    /** The results shown that have no record for the key. */
    missing: number[];
}

export interface LensSort {
    /** A key column or a compared column. */
    column: string;
    /** Sort by this result's values (Side by side); absent: BL's, or the first result's that has one. */
    place?: number;
    dir: 'asc' | 'desc';
}

const SHOWN = 1, SAME = 2, DIFF = 4;

export class CompareLens {
    readonly visible: number[];
    /** The compared columns shown, in the compare's order. */
    readonly columns: string[];
    readonly counts: Record<LensKind, number> = { same: 0, diff: 0, missing: 0 };
    /** Rows missing from each result, by place. */
    readonly missingBy: number[];
    /** Rows where some shown result differs in the column. */
    readonly columnDiffCounts: Record<string, number> = {};
    /** Per row: Same or DIFF as bits; 0 when no result shown has the row. */
    private readonly flags: Uint8Array;
    /** Per row: the places it is missing from, as bits. */
    private readonly gone: Uint8Array;
    /** Rows with a difference: the shown columns where some shown result differs from BL. */
    private readonly differing = new Map<number, string[]>();
    /** Rows of each relationship. */
    readonly relationCounts: Record<Relation, number> = { oneToOne: 0, oneToMany: 0, onlyBase: 0, onlyOther: 0 };
    /** Per row: its relationship, as its place in RELATIONS. */
    private readonly relations: Uint8Array;

    constructor(readonly result: AcrossResult, options: LensOptions) {
        const places = result.places;
        this.visible = [0, ...[...new Set(options.visible)].filter(p => p > 0 && p < places).sort((a, b) => a - b)];
        const hidden = new Set(options.hiddenColumns ?? []);
        this.columns = result.spec.compareColumns.filter(c => !hidden.has(c));
        for (const c of this.columns) this.columnDiffCounts[c] = 0;
        this.missingBy = new Array<number>(places).fill(0);
        this.flags = new Uint8Array(result.length);
        this.gone = new Uint8Array(result.length);
        this.relations = new Uint8Array(result.length);
        for (let i = 0; i < result.length; i++) {
            const records = this.records(i);
            if (!records.some(Boolean)) continue;
            // One to many folds back as its results are hidden: a key's rows past the most records
            // a shown result holds are not shown (all hidden: one row, as if never repeated)
            const at = result.repeatAt.get(i);
            const shownMost = at ? Math.max(1, ...this.visible.map(p => at.held[p] ?? 0)) : 1;
            if (at && at.row >= shownMost) continue;
            const relation: Relation = at && shownMost > 1 ? 'oneToMany'
                : !records[0] ? 'onlyOther' : records.some(r => !r) ? 'onlyBase' : 'oneToOne';
            this.relations[i] = RELATIONS.indexOf(relation);
            this.relationCounts[relation]++;
            const status = this.statusOf(i, records);
            let f = SHOWN;
            if (status.diff.length) f |= DIFF;
            if (!status.diff.length && !status.missing.length) f |= SAME;
            this.flags[i] = f;
            for (const p of status.missing) { this.gone[i] |= 1 << p; this.missingBy[p]++; }
            if (f & SAME) this.counts.same++;
            if (f & DIFF) {
                this.counts.diff++;
                const cols = this.differingColumns(records);
                this.differing.set(i, cols);
                for (const c of cols) this.columnDiffCounts[c]++;
            }
            if (status.missing.length) this.counts.missing++;
        }
    }

    /** The shown results' records for a key, in `visible` order (undefined: none). */
    private records(index: number): (CompareRowData | undefined)[] {
        return this.visible.map(p => this.result.record(index, p));
    }

    /** A row's relationship (Match's picture for it). */
    relation(index: number): Relation {
        return RELATIONS[this.relations[index]];
    }

    status(index: number): LensStatus {
        return this.statusOf(index, this.records(index));
    }

    private statusOf(index: number, records: (CompareRowData | undefined)[]): LensStatus {
        const missing = this.visible.filter((_, v) => !records[v]);
        const base = records[0];
        // Nothing differs when nothing did across every result and column, or BL has no record
        if (!base || this.result.kindOf(index) !== 'changed' || !this.columns.length) return { diff: [], missing };
        const others = this.visible.map((p, v) => ({ p, r: records[v] })).filter(x => x.p !== 0 && x.r) as { p: number; r: CompareRowData }[];
        const differs = others.filter(o => this.columns.some(c => this.result.differ(c, base[c], o.r[c])));
        if (others.length > 1 && differs.length === others.length) {
            const first = others[0].r;
            const alike = others.every(o => this.columns.every(c => !this.result.differ(c, first[c], o.r[c])));
            if (alike) return { diff: [0], missing };
        }
        return { diff: differs.map(o => o.p), missing };
    }

    /** The shown columns where some shown result differs from BL. */
    private differingColumns(records: (CompareRowData | undefined)[]): string[] {
        const base = records[0];
        if (!base) return [];
        return this.columns.filter(c => records.some((r, v) => v > 0 && r && this.result.differ(c, base[c], r[c])));
    }

    /**
     * For each shown column, which value each result holds, as group numbers by place (results
     * alike under the column's rule share one; -1: not shown or no record). Compact draws its
     * pills from these.
     */
    groups(index: number): number[][] {
        const records = this.records(index);
        return this.columns.map(c => {
            const out = new Array<number>(this.result.places).fill(-1);
            const reps: unknown[] = [];
            this.visible.forEach((p, v) => {
                const r = records[v];
                if (!r) return;
                let g = reps.findIndex(x => !this.result.differ(c, x, r[c]));
                if (g < 0) { g = reps.length; reps.push(r[c]); }
                out[p] = g;
            });
            return out;
        });
    }

    /** The rows the Status filter keeps (a row with a difference and a missing record shows for either). */
    indicesOf(filter: LensFilter): number[] {
        let mask = 0;
        if (filter.same) mask |= SAME;
        if (filter.diff) mask |= DIFF;
        let gone = 0;
        for (const p of filter.missing) gone |= 1 << p;
        const columns = filter.columns?.length ? new Set(filter.columns.filter(c => this.columns.includes(c))) : undefined;
        const relations = filter.relations ? new Set(filter.relations.map(r => RELATIONS.indexOf(r))) : undefined;
        const out: number[] = [];
        for (let i = 0; i < this.flags.length; i++) {
            if (!this.flags[i] || !((this.flags[i] & mask) || (this.gone[i] & gone))) continue;
            if (columns && !this.differsInAll(i, columns)) continue;
            if (relations && !relations.has(this.relations[i])) continue;
            out.push(i);
        }
        return out;
    }

    /** Column filters narrow as a spreadsheet's do: a row shows when it differs in each column filtered. */
    private differsInAll(index: number, columns: Set<string>): boolean {
        const cols = this.differing.get(index);
        if (!cols) return false;
        for (const c of columns) if (!cols.includes(c)) return false;
        return true;
    }

    /** Rows in a column's order. Blanks (no record, no value) go last either way; ties keep the compare's order. */
    sort(indices: number[], sort: LensSort): number[] {
        const place = sort.place;
        const valueOf = (i: number): unknown => {
            if (place !== undefined) return this.result.record(i, place)?.[sort.column];
            for (const p of this.visible) {
                const r = this.result.record(i, p);
                if (r) return r[sort.column];
            }
            return undefined;
        };
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const keyed = indices.map((i, at) => ({ i, at, v: valueOf(i) }));
        const dir = sort.dir === 'desc' ? -1 : 1;
        keyed.sort((x, y) => {
            const bx = blank(x.v), by = blank(y.v);
            if (bx || by) return bx && by ? x.at - y.at : bx ? 1 : -1;
            const c = typeof x.v === 'number' && typeof y.v === 'number' ? x.v - y.v : collator.compare(text(x.v), text(y.v));
            return c ? c * dir : x.at - y.at;
        });
        return keyed.map(k => k.i);
    }
}

function blank(v: unknown): boolean {
    return v === undefined || v === null || v === '';
}

function text(v: unknown): string {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** The Baseline is BL; the others are C1, C2, C3. */
export const placeLetter = (place: number): string => (place === 0 ? 'BL' : `C${place}`);

/** The Status filter in words: "Same, DIFF, Missing BL". */
export function filterText(filter: LensFilter, name: (column: string) => string = c => c): string {
    const parts = [filter.same ? 'Same' : '', filter.diff ? 'DIFF' : '', ...filter.missing.map(p => `Missing ${placeLetter(p)}`)].filter(Boolean);
    const kinds = parts.join(', ') || 'Nothing ticked';
    return filter.columns?.length ? `${kinds}; differs in ${filter.columns.map(name).join(' and ')}` : kinds;
}

/** A row's Status in words, as the grid's pills read: "DIFF C1 C2", "Missing C3", "Same". */
export function statusText(status: LensStatus): string {
    const parts: string[] = [];
    if (status.diff.length) parts.push(`DIFF ${status.diff.map(placeLetter).join(' ')}`);
    if (status.missing.length) parts.push(`Missing ${status.missing.map(placeLetter).join(' ')}`);
    return parts.length ? parts.join(' · ') : 'Same';
}
