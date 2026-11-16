// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare several — three or four saved results of one endpoint, side by side.
 *
 * One row per key across every result, the baseline's rows first (in its order), then keys the
 * baseline lacks, in result order. Each compared value is measured against the baseline's, with
 * the same rules as two results (strictValue, or relaxedValue for a Relaxed column).
 *
 * One to many: a key on several rows of another result (the baseline has it once, or not at all)
 * is a row for each of them, side by side. A result with the key once shows that record on every
 * one of them (the baseline's is compared with each); a result with fewer of them than another
 * shows its last again past it, so no row reads as missing from a result that has the key.
 *
 * A row is one kind, the first that applies:
 *   duplicate      the key is on more than one row of the baseline (not compared; Match stops it)
 *   notInBaseline  the baseline has no row for the key
 *   changed        some result's value differs from the baseline's
 *   missing        nothing differs, but some result has no row for the key
 *   same           every result has the row, and every value is the baseline's
 *
 * Which values differ is worked out again when a row is read (a window at a time), so the
 * result holds only the row numbers and the kind of each row.
 */
import { rowKey, valuesDiffer, CompareColumnMode, CompareRowData, CompareRunOptions, CompareSpec } from './compare-engine';

export type AcrossKind = 'changed' | 'missing' | 'notInBaseline' | 'duplicate' | 'same';

export const ACROSS_KINDS: readonly AcrossKind[] = ['changed', 'missing', 'notInBaseline', 'duplicate', 'same'];

const CODE: Record<AcrossKind, number> = { changed: 0, missing: 1, notInBaseline: 2, duplicate: 3, same: 4 };
const KIND_OF: AcrossKind[] = ['changed', 'missing', 'notInBaseline', 'duplicate', 'same'];

export interface AcrossRowView {
    kind: AcrossKind;
    /** Row numbers in each result, by result (several for a duplicate key, none when it has no row). */
    rows: number[][];
    /** The compared columns whose value differs from the baseline's, by result. */
    diffs: string[][];
}

export class AcrossResult {
    constructor(
        readonly spec: CompareSpec,
        readonly baseline: number,
        readonly rowCounts: number[],
        readonly counts: Record<AcrossKind, number>,
        /** Rows where some result's value differs from the baseline's, per compared column. */
        readonly columnDiffCounts: Record<string, number>,
        /** Rows added for one to many: a key's rows past its first. */
        readonly repeated: number,
        /** One to many: each of a repeated key's rows, and the results that hold it more than once. */
        readonly repeatedIn: ReadonlyMap<number, number[]>,
        /** One to many: each of those rows' place in its key's rows, and how many records each result holds. */
        readonly repeatAt: ReadonlyMap<number, { row: number; held: number[] }>,
        private readonly sides: readonly (readonly CompareRowData[])[],
        /** Each row's row number in each result, by result (-1: none). */
        private readonly first: Int32Array[],
        private readonly kinds: Uint8Array,
        private readonly duplicates: Map<number, number[][]>,
        private readonly modes: CompareColumnMode[],
    ) {}

    get length(): number {
        return this.kinds.length;
    }

    /** How many results (places) the compare holds. */
    get places(): number {
        return this.first.length;
    }

    /** The kind measured over every result and every compared column. */
    kindOf(index: number): AcrossKind {
        return KIND_OF[this.kinds[index]];
    }

    /** A result's record on a row, or undefined when it has none. */
    record(index: number, place: number): CompareRowData | undefined {
        const n = this.first[place]?.[index] ?? -1;
        return n >= 0 ? this.sides[place][n] : undefined;
    }

    /** Whether two values of a compared column differ, by that column's rule (Strict or Relaxed). */
    differ(column: string, a: unknown, b: unknown): boolean {
        const c = this.spec.compareColumns.indexOf(column);
        return valuesDiffer(a, b, c >= 0 ? this.modes[c] : 'strict');
    }

    /** Each result's row numbers for one key, by result: what Find reads (no differences worked out). */
    rowNumbers(index: number): number[][] {
        return this.duplicates.get(index)?.map(r => r.slice())
            ?? this.first.map(f => (f[index] >= 0 ? [f[index]] : []));
    }

    row(index: number): AcrossRowView {
        const kind = KIND_OF[this.kinds[index]];
        const rows = this.rowNumbers(index);
        const diffs = rows.map(() => [] as string[]);
        if (kind === 'changed') {
            const base = this.sides[this.baseline][rows[this.baseline][0]];
            const cols = this.spec.compareColumns;
            rows.forEach((r, s) => {
                if (s === this.baseline || !r.length) return;
                const other = this.sides[s][r[0]];
                for (let c = 0; c < cols.length; c++) {
                    if (valuesDiffer(base[cols[c]], other[cols[c]], this.modes[c])) diffs[s].push(cols[c]);
                }
            });
        }
        return { kind, rows, diffs };
    }

    /** Result row numbers of the given kinds, in result order. */
    indicesOf(kinds: ReadonlySet<AcrossKind>): number[] {
        const codes = new Set([...kinds].map(k => CODE[k]));
        const out: number[] = [];
        for (let i = 0; i < this.kinds.length; i++) if (codes.has(this.kinds[i])) out.push(i);
        return out;
    }
}

function abortError(): Error {
    const error = new Error('Compare cancelled');
    error.name = 'AbortError';
    return error;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => {
        if (typeof setImmediate === 'function') setImmediate(resolve);
        else setTimeout(resolve, 0);
    });
}

/** Compare every result with the baseline (`baseline` is its place in `sides`). */
export async function compareAcross(
    sides: readonly (readonly CompareRowData[])[],
    spec: CompareSpec,
    baseline: number,
    run: CompareRunOptions = {},
): Promise<AcrossResult> {
    if (spec.keyColumns.length === 0) throw new Error('Pick at least one column to match rows on.');
    if (baseline < 0 || baseline >= sides.length) throw new Error('Pick a baseline.');
    const keySet = new Set(spec.keyColumns);
    const compareColumns = spec.compareColumns.filter(c => !keySet.has(c));
    const relaxed = new Set(spec.relaxedColumns ?? []);
    const effective: CompareSpec = { ...spec, compareColumns, relaxedColumns: compareColumns.filter(c => relaxed.has(c)) };
    const modes: CompareColumnMode[] = compareColumns.map(c => (relaxed.has(c) ? 'relaxed' : 'strict'));
    const chunk = run.chunkSize ?? 20000;
    const total = sides.reduce((n, rows) => n + rows.length, 0) * 2;
    let done = 0;
    const tick = async (n: number) => {
        done += n;
        if (run.signal?.aborted) throw abortError();
        run.onProgress?.({ done, total });
        await yieldToEventLoop();
        if (run.signal?.aborted) throw abortError();
    };

    // 1. Every key, the baseline's first, and each result's first row for it
    const order = [baseline, ...sides.map((_, s) => s).filter(s => s !== baseline)];
    const indexOf = new Map<string, number>();
    const firsts: number[][] = sides.map(() => []);
    const dupIndices = new Set<number>();
    const keysBySide: number[][] = sides.map(() => []);
    for (const s of order) {
        const rows = sides[s];
        const keyed = keysBySide[s];
        for (let i = 0; i < rows.length; i++) {
            const k = rowKey(rows[i], spec.keyColumns);
            let at = indexOf.get(k);
            if (at === undefined) {
                at = indexOf.size;
                indexOf.set(k, at);
            }
            keyed.push(at);
            const f = firsts[s];
            if (f[at] === undefined || f[at] < 0) f[at] = i;
            else dupIndices.add(at);
            if ((i + 1) % chunk === 0) await tick(chunk);
        }
        await tick(rows.length % chunk);
    }
    const keys = indexOf.size;

    // Every row number of a key on more than one row anywhere, by result
    const all = new Map<number, number[][]>();
    for (const at of dupIndices) all.set(at, sides.map(() => []));
    if (dupIndices.size) {
        keysBySide.forEach((keyed, s) => keyed.forEach((at, i) => all.get(at)?.[s].push(i)));
    }

    // The rows: one per key; one to many, one per record of the result with the most
    const rowsOf: number[][] = sides.map(() => []);
    const duplicates = new Map<number, number[][]>();
    const repeatedIn = new Map<number, number[]>();
    const repeatAt = new Map<number, { row: number; held: number[] }>();
    let repeated = 0;
    for (let at = 0; at < keys; at++) {
        const each = all.get(at);
        if (!each) {
            sides.forEach((_, s) => rowsOf[s].push(firsts[s][at] ?? -1));
            continue;
        }
        if (each[baseline].length > 1) {
            // Repeated in the baseline: one row, not compared
            duplicates.set(rowsOf[0].length, each);
            sides.forEach((_, s) => rowsOf[s].push(-1));
            continue;
        }
        const n = Math.max(...each.map(r => r.length));
        const many = each.map((list, s) => (list.length > 1 ? s : -1)).filter(s => s >= 0);
        const held = each.map(list => list.length);
        for (let r = 0; r < n; r++) {
            repeatAt.set(rowsOf[0].length, { row: r, held });
            repeatedIn.set(rowsOf[0].length, many);
            each.forEach((list, s) => rowsOf[s].push(list.length ? list[Math.min(r, list.length - 1)] : -1));
        }
        repeated += n - 1;
    }
    const length = rowsOf[0].length;
    const first = rowsOf.map(r => Int32Array.from(r));

    // 2. The kind of each row, and which columns differ from the baseline
    const counts: Record<AcrossKind, number> = { changed: 0, missing: 0, notInBaseline: 0, duplicate: 0, same: 0 };
    const columnDiffCounts: Record<string, number> = {};
    for (const c of compareColumns) columnDiffCounts[c] = 0;
    const kinds = new Uint8Array(length);
    const differs = new Uint8Array(compareColumns.length);
    const base = first[baseline];
    for (let at = 0; at < length; at++) {
        let kind: AcrossKind;
        if (duplicates.has(at)) kind = 'duplicate';
        else if (base[at] < 0) kind = 'notInBaseline';
        else {
            const b = sides[baseline][base[at]];
            let missing = false, changed = false;
            differs.fill(0);
            for (let s = 0; s < sides.length; s++) {
                if (s === baseline) continue;
                const n = first[s][at];
                if (n < 0) { missing = true; continue; }
                const o = sides[s][n];
                for (let c = 0; c < compareColumns.length; c++) {
                    if (!differs[c] && valuesDiffer(b[compareColumns[c]], o[compareColumns[c]], modes[c])) {
                        differs[c] = 1;
                        changed = true;
                    }
                }
            }
            if (changed) for (let c = 0; c < compareColumns.length; c++) if (differs[c]) columnDiffCounts[compareColumns[c]]++;
            kind = changed ? 'changed' : missing ? 'missing' : 'same';
        }
        kinds[at] = CODE[kind];
        counts[kind]++;
        if ((at + 1) % chunk === 0) await tick(chunk);
    }
    await tick(Math.max(0, total - done));

    return new AcrossResult(effective, baseline, sides.map(r => r.length), counts, columnDiffCounts, repeated, repeatedIn, repeatAt, sides, first, kinds, duplicates, modes);
}
