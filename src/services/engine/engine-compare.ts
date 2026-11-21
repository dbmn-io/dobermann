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
 *
 * On each row, a compared value is measured against the first input that has the record there and
 * is compared (the Baseline, unless it lacks the record or is in notCompared), equal by sameValue
 * (42 and "42" alike, as Results has always measured it by text: query-status.ts rowStatus; two
 * blanks alike, a blank and a value not); so a row the Baseline lacks is still
 * compared among the others. Status, the first that applies: "diff" where a value differs, else
 * "notInBaseline" where the Baseline lacks the record, else "missing" where a compared input
 * lacks it, else "same".
 */
import type { CompareStats } from './engine-types';
import { alike, keyPart, type V } from './engine-values';

export const COMPARE_STATUS = ['same', 'diff', 'missing', 'notInBaseline'] as const;
export const COMPARE_RELATION = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'] as const;

/** One input of a compare: its rows, its key's parts and its compared values as functions of a row. */
export interface CompareInput {
    name: string;
    rowCount: number;
    key: ((row: number) => V)[];
    /** Its value for each compared column; none where the column has no cell for this input. */
    values: (((row: number) => V) | undefined)[];
    /** Kept in the rows, left out of status, relation and differs (notCompared). */
    skipped: boolean;
}

/** What a compare made: each row's record in each input (-1: none), its status, relation and differs; the statistics. */
export interface CompareMade {
    rowAt: Int32Array[];
    status: Uint8Array;
    relation: Uint8Array;
    /** By input: 1 where one of its values differs from its column's first (`diff:<input>`). */
    diffBy: Uint8Array[];
    /** By input: 1 where it holds the row's key on more than one record (`repeated:<input>`). */
    repeatedBy: Uint8Array[];
    differs: Uint8Array[];
    stats: CompareStats;
}

/** A key's text, or null when a part is blank (it matches nothing). Equal values (sameValue: 42 and "42") alike. */
function keyOf(parts: V[]): string | null {
    let key = '';
    for (const v of parts) {
        if (v === null) return null;
        key += keyPart(v);
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
    // (for each repeated row, the inputs that hold its key more than once)
    const repeatedIn: number[][] = [];
    let length = 0;
    for (let k = 0; k < keys; k++) {
        const each = many.get(k);
        if (!each) { for (let p = 0; p < places; p++) rowsOf[p].push(firstRow[p][k]); length++; continue; }
        const n = Math.max(...each.map(list => list.length));
        const holders = each.map((list, p) => (list.length > 1 ? p : -1)).filter(p => p >= 0);
        for (let i = 0; i < n; i++) {
            for (let p = 0; p < places; p++) rowsOf[p].push(each[p].length ? each[p][Math.min(i, each[p].length - 1)] : -1);
            repeatedIn.push(holders);
            repeatedRow.push(length++);
        }
    }
    const rowAt = rowsOf.map(r => Int32Array.from(r));
    const isRepeated = new Uint8Array(length);
    const repeatedBy = inputs.map(() => new Uint8Array(length));
    repeatedRow.forEach((r, i) => { isRepeated[r] = 1; for (const p of repeatedIn[i]) repeatedBy[p][r] = 1; });

    // 3. Each row's status, relation and differs
    const status = new Uint8Array(length);
    const relation = new Uint8Array(length);
    const differs = Array.from({ length: columns }, () => new Uint8Array(length));
    const diffBy = inputs.map(() => new Uint8Array(length));
    const counts = { same: 0, diff: 0, missing: 0, notInBaseline: 0 };
    for (let row = 0; row < length; row++) {
        if (++done % every === 0) await tick(done, work);
        const b = rowAt[0][row];
        let missing = false, changed = false;
        for (let p = 1; p < places; p++) if (!inputs[p].skipped && rowAt[p][row] < 0) missing = true;
        relation[row] = b < 0 ? 3 : missing ? 2 : isRepeated[row] ? 1 : 0;
        // Each column measured against its first input that has the record, is compared and has a cell in it
        for (let c = 0; c < columns; c++) {
            let first: V | undefined;
            for (let p = 0; p < places; p++) {
                const r = rowAt[p][row];
                const value = inputs[p].values[c];
                if (inputs[p].skipped || r < 0 || !value) continue;
                if (first === undefined) { first = value(r); continue; }
                if (!alike(first, value(r))) { differs[c][row] = 1; diffBy[p][row] = 1; changed = true; }
            }
        }
        status[row] = changed ? 1 : b < 0 ? 3 : missing ? 2 : 0;
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
    return { rowAt, status, relation, differs, diffBy, repeatedBy, stats: { perInput, rows: length, status: counts } };
}
