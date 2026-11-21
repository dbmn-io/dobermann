// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The compare step: inputs compared on a key, the first the Baseline.
 *
 * The rule (James, 2026-11-21: "If we have a one-to-many relationship, the one should be compared
 * to the many each time, even if the key repeats"):
 *
 * - The rows for a key are as many as the most rows any input has for it.
 * - An input with the key once shows that one record on every one of those rows, and is compared
 *   each time: one to many, either way (the Baseline's one against C1's three, or the Baseline's
 *   three against C1's one).
 * - An input with the key several times is paired in order of appearance: its first with the
 *   others' first, its second with their second. One with fewer than the most (but more than one)
 *   shows its last again past its end.
 * - An input without the key is missing on those rows.
 * - Every row is compared; the Baseline is not special in this. `relation` says repeated
 *   ("oneToMany") where any input has the key more than once.
 * - A blank key never matches anything: each record with a blank in its key is a row of its own.
 *
 * Rows come in the order their keys first appear: the Baseline's, then each later input's.
 * Everything else is as the old Compare (compare-across.ts): a row the Baseline lacks is not
 * compared; status is "diff" where a compared value differs from the Baseline's (exact by type),
 * else "missing" where a compared input lacks the record, else "same".
 */
import type { CompareStats } from './engine-types';
import { compareValues, isNumber, num, type V } from './engine-values';

export const COMPARE_STATUS = ['same', 'diff', 'missing', 'notInBaseline'] as const;
export const COMPARE_RELATION = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'] as const;

/** One input of a compare: its rows, its key's parts and its compared values as functions of a row. */
export interface CompareInput {
    name: string;
    rowCount: number;
    key: ((row: number) => V)[];
    values: ((row: number) => V)[];
    /** Kept in the rows, left out of status, relation and differs (notCompared). */
    skipped: boolean;
}

/** What a compare made: each row's record in each input (-1: none), its status, relation and differs; the statistics. */
export interface CompareMade {
    rowAt: Int32Array[];
    status: Uint8Array;
    relation: Uint8Array;
    differs: Uint8Array[];
    stats: CompareStats;
}

/** A key's text, or null when a part is blank (it matches nothing). Numbers and text never alike. */
function keyOf(parts: V[]): string | null {
    let key = '';
    for (const v of parts) {
        if (v === null) return null;
        key += isNumber(v) ? `n${num(v)}\u0001` : `t${v.length}:${v}`;
    }
    return key;
}

export async function runCompare(inputs: CompareInput[], columns: number, tick: (done: number, total: number) => Promise<void>, every: number): Promise<CompareMade> {
    const places = inputs.length;
    const work = inputs.reduce((n, x) => n + x.rowCount, 0) * 2;
    let done = 0;

    // 1. Every key, the Baseline's first, then each input's in order; each row's key number. A
    //    blank key is a key of its own for that record alone.
    const keyIndex = new Map<string, number>();
    let keys = 0;
    const blank: boolean[] = [];
    const keyed: Int32Array[] = [];
    for (const x of inputs) {
        const at = new Int32Array(x.rowCount);
        for (let r = 0; r < x.rowCount; r++) {
            if (++done % every === 0) await tick(done, work);
            const key = keyOf(x.key.map(f => f(r)));
            let k: number | undefined;
            if (key === null) { k = keys++; blank[k] = true; }
            else {
                k = keyIndex.get(key);
                if (k === undefined) { k = keys++; keyIndex.set(key, k); blank[k] = false; }
            }
            at[r] = k;
        }
        keyed.push(at);
    }
    keyIndex.clear();
    // Each input's rows for each key: how many, its first, and (for keys on more than one row anywhere) all of them
    const held = keyed.map(() => new Int32Array(keys));
    const firstRow = keyed.map(() => new Int32Array(keys).fill(-1));
    keyed.forEach((at, p) => at.forEach((k, r) => { if (held[p][k]++ === 0) firstRow[p][k] = r; }));
    const many = new Map<number, number[][]>();
    for (let k = 0; k < keys; k++) if (held.some(h => h[k] > 1)) many.set(k, inputs.map(() => []));
    if (many.size) keyed.forEach((at, p) => at.forEach((k, r) => many.get(k)?.[p].push(r)));

    // 2. The rows: as many for a key as the most any input has; the one shown on each, the many in order
    const rowsOf: number[][] = inputs.map(() => []);
    const repeatedRow: number[] = [];
    let length = 0;
    for (let k = 0; k < keys; k++) {
        const each = many.get(k);
        if (!each) { for (let p = 0; p < places; p++) rowsOf[p].push(firstRow[p][k]); length++; continue; }
        const n = Math.max(...each.map(list => list.length));
        for (let i = 0; i < n; i++) {
            for (let p = 0; p < places; p++) rowsOf[p].push(each[p].length ? each[p][Math.min(i, each[p].length - 1)] : -1);
            repeatedRow.push(length++);
        }
    }
    const rowAt = rowsOf.map(r => Int32Array.from(r));
    const isRepeated = new Uint8Array(length);
    repeatedRow.forEach(r => { isRepeated[r] = 1; });

    // 3. Each row's status, relation and differs
    const status = new Uint8Array(length);
    const relation = new Uint8Array(length);
    const differs = Array.from({ length: columns }, () => new Uint8Array(length));
    const counts = { same: 0, diff: 0, missing: 0, notInBaseline: 0 };
    const base = inputs[0];
    for (let row = 0; row < length; row++) {
        if (++done % every === 0) await tick(done, work);
        const b = rowAt[0][row];
        let missing = false, changed = false;
        for (let p = 1; p < places; p++) if (!inputs[p].skipped && rowAt[p][row] < 0) missing = true;
        relation[row] = b < 0 ? 3 : missing ? 2 : isRepeated[row] ? 1 : 0;
        if (b < 0) status[row] = 3;
        else {
            for (let c = 0; c < columns; c++) {
                const bv = base.values[c](b);
                for (let p = 1; p < places; p++) {
                    const r = rowAt[p][row];
                    if (inputs[p].skipped || r < 0) continue;
                    if (compareValues(bv, inputs[p].values[c](r)) !== 0) { differs[c][row] = 1; changed = true; break; }
                }
            }
            status[row] = changed ? 1 : missing ? 2 : 0;
        }
        counts[COMPARE_STATUS[status[row]]]++;
    }

    // 4. Each input's statistics (a blank key matches nothing: its records are "only")
    const compared = inputs.map((_, p) => p).filter(p => !inputs[p].skipped);
    const perInput = inputs.map((x, p) => {
        const h = held[p], bh = held[0];
        const ab = { matched: 0, oneToOne: 0, repeatedKeys: 0, repeatedRecords: 0, only: 0 };
        const aa = { matched: 0, repeatedKeys: 0, repeatedRecords: 0, onlyHere: 0 };
        for (let k = 0; k < keys; k++) {
            const here = h[k];
            if (!here) continue;
            if (blank[k]) { ab.only += here; aa.onlyHere += here; continue; }
            if (bh[k]) {
                ab.matched += here;
                if (here === 1 && bh[k] === 1) ab.oneToOne++;
                else { ab.repeatedKeys++; ab.repeatedRecords += here; }
            } else ab.only += here;
            if (compared.some(q => q !== p && held[q][k] > 0)) aa.matched += here; else aa.onlyHere += here;
            if (here > 1) { aa.repeatedKeys++; aa.repeatedRecords += here; }
        }
        return { name: x.name, rows: x.rowCount, againstBaseline: ab, againstAll: aa };
    });
    return { rowAt, status, relation, differs, stats: { perInput, rows: length, status: counts } };
}
