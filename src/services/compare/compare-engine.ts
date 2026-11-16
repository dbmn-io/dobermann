// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare — the keyed row-and-value compare of two saved results.
 *
 * Both sides arrive as the flat rows a Console View produces (column id → raw value), so a
 * compare shows exactly what the Console shows. Rows pair up on the key columns the user
 * picks (a business key such as itemCode; the database id differs per environment), then
 * the ticked columns are compared value by value.
 *
 * Values compare strictly by JSON type unless the user sets a column to Relaxed (see
 * strictValue / relaxedValue below).
 *
 * Every group is worked out in one pass: changed, only in A, only in B, duplicate key, same.
 * The join the user picks (full / left / right / inner) only decides which groups are shown,
 * so changing it never re-runs the compare.
 *
 * No row limit. The work runs in chunks that yield to the event loop, reports progress and
 * honours an AbortSignal. The result is held in typed arrays (about 13 bytes a row plus the
 * differing column numbers), so a million-row compare stays small.
 */

export type CompareRowKind = 'changed' | 'onlyA' | 'onlyB' | 'duplicate' | 'same';

export const COMPARE_ROW_KINDS: readonly CompareRowKind[] = ['changed', 'onlyA', 'onlyB', 'duplicate', 'same'];

/**
 * Values compare strictly by their JSON type and exact value: the string "00123" is not the
 * number 123, and "12.50" is not "12.5". Compare is system against system, so a difference is
 * a difference; nothing is reformatted (a dropped leading zero is exactly the kind of change it
 * must show). A column the user does not care about is unticked, not reinterpreted.
 *
 * A column can be set to Relaxed, by the user, one column at a time: surrounding and repeated
 * spaces and letter case are ignored, a number equals its exact text (12.5 = "12.5"), and blank,
 * null and missing are one value. Relaxed never parses numbers, so leading zeros always count.
 * The match key is always strict.
 */
export type CompareColumnMode = 'strict' | 'relaxed';

export interface CompareSpec {
    keyColumns: string[];
    compareColumns: string[];
    /** Compared columns set to Relaxed. Every other column compares strictly. */
    relaxedColumns?: string[];
}

export type CompareRowData = Record<string, unknown>;

export interface CompareProgress {
    /** Rows worked through so far, across both sides. */
    done: number;
    total: number;
}

export interface CompareRunOptions {
    onProgress?: (progress: CompareProgress) => void;
    signal?: AbortSignal;
    /** Rows handled between yields to the event loop. */
    chunkSize?: number;
}

/** One result row, read back from the compact store. */
export interface CompareRowView {
    kind: CompareRowKind;
    /** Row numbers in side A (several for a duplicate key, none for onlyB). */
    a: number[];
    /** Row numbers in side B. */
    b: number[];
    /** Compared columns whose values differ (changed rows only). */
    diffColumns: string[];
}

const KIND_CODE: Record<CompareRowKind, number> = { changed: 0, onlyA: 1, onlyB: 2, duplicate: 3, same: 4 };
const CODE_KIND: CompareRowKind[] = ['changed', 'onlyA', 'onlyB', 'duplicate', 'same'];
const KEY_JOIN = '\u001f';

/** A value as the strict compare sees it: its JSON type, then its exact value. */
export function strictValue(value: unknown): string {
    if (value === undefined) return 'u';
    if (value === null) return 'z';
    switch (typeof value) {
        case 'string': return 's' + value;
        case 'number': return 'n' + String(value);
        case 'boolean': return value ? 'b1' : 'b0';
        case 'bigint': return 'n' + value.toString();
        default: return 'j' + JSON.stringify(value);
    }
}

/** A value as a Relaxed column sees it. Leading zeros are kept: nothing is parsed. */
export function relaxedValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return 'j' + JSON.stringify(value);
    const text = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
    return text === '' ? '' : 't' + text;
}

export function valuesDiffer(a: unknown, b: unknown, mode: CompareColumnMode): boolean {
    if (a === b) return false;
    return mode === 'relaxed' ? relaxedValue(a) !== relaxedValue(b) : strictValue(a) !== strictValue(b);
}

/** The match key: always strict, so "1" and 1, or "007" and "7", never pair. */
export function rowKey(row: CompareRowData, keyColumns: string[]): string {
    if (keyColumns.length === 1) {
        return strictValue(row[keyColumns[0]]);
    }
    let key = '';
    for (let i = 0; i < keyColumns.length; i++) {
        if (i > 0) key += KEY_JOIN;
        key += strictValue(row[keyColumns[i]]);
    }
    return key;
}

/** A key as people read it: the values, joined with " + ". */
export function displayKey(key: string): string {
    return key.split(KEY_JOIN).map(part => {
        const tag = part.charAt(0);
        if (tag === 'u' || tag === 'z') return '(blank)';
        if (tag === 'b') return part === 'b1' ? 'true' : 'false';
        return part.slice(1);
    }).join(' + ');
}

/** Growable typed-array store for the result rows. */
class RowStore {
    kind: Uint8Array;
    a: Int32Array;
    b: Int32Array;
    diffStart: Int32Array;
    diffPool: Uint16Array;
    length = 0;
    diffLength = 0;
    /** Duplicate-key rows hold several row numbers a side. */
    readonly duplicates = new Map<number, { a: number[]; b: number[] }>();

    constructor(capacity: number) {
        const size = Math.max(16, capacity);
        this.kind = new Uint8Array(size);
        this.a = new Int32Array(size);
        this.b = new Int32Array(size);
        this.diffStart = new Int32Array(size + 1);
        this.diffPool = new Uint16Array(Math.max(16, size >> 2));
    }

    push(kind: CompareRowKind, a: number, b: number, diffs?: number[]): number {
        if (this.length === this.kind.length) this.grow();
        const at = this.length++;
        this.kind[at] = KIND_CODE[kind];
        this.a[at] = a;
        this.b[at] = b;
        this.diffStart[at] = this.diffLength;
        if (diffs && diffs.length) {
            if (this.diffLength + diffs.length > this.diffPool.length) {
                const next = new Uint16Array(Math.max(this.diffPool.length * 2, this.diffLength + diffs.length));
                next.set(this.diffPool);
                this.diffPool = next;
            }
            for (const d of diffs) this.diffPool[this.diffLength++] = d;
        }
        this.diffStart[at + 1] = this.diffLength;
        return at;
    }

    private grow(): void {
        const size = this.kind.length * 2;
        const kind = new Uint8Array(size); kind.set(this.kind); this.kind = kind;
        const a = new Int32Array(size); a.set(this.a); this.a = a;
        const b = new Int32Array(size); b.set(this.b); this.b = b;
        const ds = new Int32Array(size + 1); ds.set(this.diffStart); this.diffStart = ds;
    }
}

export class CompareResult {
    constructor(
        readonly spec: CompareSpec,
        readonly rowCountA: number,
        readonly rowCountB: number,
        readonly counts: Record<CompareRowKind, number>,
        /** Rows that differ, per compared column. */
        readonly columnDiffCounts: Record<string, number>,
        private readonly store: RowStore,
    ) {}

    get length(): number {
        return this.store.length;
    }

    kindAt(index: number): CompareRowKind {
        return CODE_KIND[this.store.kind[index]];
    }

    row(index: number): CompareRowView {
        const s = this.store;
        const kind = CODE_KIND[s.kind[index]];
        const diffColumns: string[] = [];
        for (let d = s.diffStart[index]; d < s.diffStart[index + 1]; d++) {
            diffColumns.push(this.spec.compareColumns[s.diffPool[d]]);
        }
        if (kind === 'duplicate') {
            const dup = s.duplicates.get(index)!;
            return { kind, a: dup.a.slice(), b: dup.b.slice(), diffColumns };
        }
        return {
            kind,
            a: s.a[index] >= 0 ? [s.a[index]] : [],
            b: s.b[index] >= 0 ? [s.b[index]] : [],
            diffColumns,
        };
    }

    /** Result row numbers of the given kinds, in result order (A's order, then B-only rows). */
    indicesOf(kinds: ReadonlySet<CompareRowKind>): number[] {
        const codes = new Set<number>([...kinds].map(k => KIND_CODE[k]));
        const out: number[] = [];
        const kind = this.store.kind;
        for (let i = 0; i < this.store.length; i++) {
            if (codes.has(kind[i])) out.push(i);
        }
        return out;
    }
}

function abortError(): Error {
    const error = new Error('Compare cancelled');
    error.name = 'AbortError';
    return error;
}

/** Hands the event loop back between chunks, so a long compare never freezes the host. */
function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => {
        if (typeof setImmediate === 'function') setImmediate(resolve);
        else setTimeout(resolve, 0);
    });
}

/**
 * Compare two sides. `rowsA` and `rowsB` are the View's flat rows for each saved result.
 */
export async function compareRows(
    rowsA: readonly CompareRowData[],
    rowsB: readonly CompareRowData[],
    spec: CompareSpec,
    run: CompareRunOptions = {},
): Promise<CompareResult> {
    if (spec.keyColumns.length === 0) {
        throw new Error('Pick at least one column to match rows on.');
    }
    const keySet = new Set(spec.keyColumns);
    const compareColumns = spec.compareColumns.filter(c => !keySet.has(c));
    const effective: CompareSpec = { ...spec, compareColumns, relaxedColumns: (spec.relaxedColumns ?? []).filter(c => compareColumns.includes(c)) };
    const relaxed = new Set(spec.relaxedColumns ?? []);
    const modes: CompareColumnMode[] = compareColumns.map(c => (relaxed.has(c) ? 'relaxed' : 'strict'));
    const chunk = run.chunkSize ?? 20000;
    const total = rowsA.length * 2 + rowsB.length * 2;
    let done = 0;
    const tick = async (n: number) => {
        done += n;
        if (run.signal?.aborted) throw abortError();
        run.onProgress?.({ done, total });
        await yieldToEventLoop();
        if (run.signal?.aborted) throw abortError();
    };

    // 1. Keys for each side. A key seen twice on either side is a duplicate key.
    const keysA: string[] = new Array(rowsA.length);
    const firstA = new Map<string, number>();
    const dupKeys = new Set<string>();
    for (let i = 0; i < rowsA.length; i++) {
        const k = rowKey(rowsA[i], spec.keyColumns);
        keysA[i] = k;
        if (firstA.has(k)) dupKeys.add(k); else firstA.set(k, i);
        if ((i + 1) % chunk === 0) await tick(chunk);
    }
    await tick(rowsA.length % chunk);

    const keysB: string[] = new Array(rowsB.length);
    const firstB = new Map<string, number>();
    for (let i = 0; i < rowsB.length; i++) {
        const k = rowKey(rowsB[i], spec.keyColumns);
        keysB[i] = k;
        if (firstB.has(k)) dupKeys.add(k); else firstB.set(k, i);
        if ((i + 1) % chunk === 0) await tick(chunk);
    }
    await tick(rowsB.length % chunk);

    // Every row number per duplicate key, so a duplicate shows all its rows together.
    const dupRows = new Map<string, { a: number[]; b: number[] }>();
    if (dupKeys.size) {
        for (const k of dupKeys) dupRows.set(k, { a: [], b: [] });
        for (let i = 0; i < keysA.length; i++) dupRows.get(keysA[i])?.a.push(i);
        for (let i = 0; i < keysB.length; i++) dupRows.get(keysB[i])?.b.push(i);
    }

    const counts: Record<CompareRowKind, number> = { changed: 0, onlyA: 0, onlyB: 0, duplicate: 0, same: 0 };
    const columnDiffCounts: Record<string, number> = {};
    for (const c of compareColumns) columnDiffCounts[c] = 0;
    const store = new RowStore(Math.max(rowsA.length, rowsB.length) + 16);
    const usedB = new Uint8Array(rowsB.length);
    const emittedDup = new Set<string>();
    const diffs: number[] = [];

    const emitDuplicate = (k: string) => {
        if (emittedDup.has(k)) return;
        emittedDup.add(k);
        const at = store.push('duplicate', -1, -1);
        store.duplicates.set(at, dupRows.get(k)!);
        counts.duplicate++;
    };

    // 2. Walk A in order: pair each row with its B partner and compare the ticked columns.
    for (let i = 0; i < rowsA.length; i++) {
        const k = keysA[i];
        if (dupKeys.has(k)) {
            emitDuplicate(k);
        } else {
            const j = firstB.get(k);
            if (j === undefined) {
                store.push('onlyA', i, -1);
                counts.onlyA++;
            } else {
                usedB[j] = 1;
                diffs.length = 0;
                const ra = rowsA[i], rb = rowsB[j];
                for (let c = 0; c < compareColumns.length; c++) {
                    const col = compareColumns[c];
                    if (valuesDiffer(ra[col], rb[col], modes[c])) {
                        diffs.push(c);
                        columnDiffCounts[col]++;
                    }
                }
                if (diffs.length) {
                    store.push('changed', i, j, diffs);
                    counts.changed++;
                } else {
                    store.push('same', i, j);
                    counts.same++;
                }
            }
        }
        if ((i + 1) % chunk === 0) await tick(chunk);
    }
    await tick(rowsA.length % chunk);

    // 3. B rows with no partner, in B's order. Duplicate keys found only in B land here too.
    for (let j = 0; j < rowsB.length; j++) {
        if (!usedB[j]) {
            const k = keysB[j];
            if (dupKeys.has(k)) emitDuplicate(k);
            else {
                store.push('onlyB', -1, j);
                counts.onlyB++;
            }
        }
        if ((j + 1) % chunk === 0) await tick(chunk);
    }
    await tick(rowsB.length % chunk);

    return new CompareResult(effective, rowsA.length, rowsB.length, counts, columnDiffCounts, store);
}

export type CompareJoin = 'full' | 'left' | 'right' | 'inner';

/** The groups a join shows. Changed, same and duplicate rows exist on both sides, so every join shows them. */
export function kindsForJoin(join: CompareJoin): Set<CompareRowKind> {
    const kinds = new Set<CompareRowKind>(['changed', 'duplicate', 'same']);
    if (join === 'full' || join === 'left') kinds.add('onlyA');
    if (join === 'full' || join === 'right') kinds.add('onlyB');
    return kinds;
}

/**
 * How the Baseline's records meet another result's on a key, for the Match step. Each key
 * value is one group: the records of each side that carry it.
 *
 * The Baseline is always the "one": a key can be used when BL holds each value once at most.
 * One to many (a value on several records of the other result) is compared, BL's record against
 * each of them (compare-across). A value on several of BL's records (many to one, many to many)
 * stops the compare. Counts are of values; one to one and only on one side are also records.
 */
export type MatchKind = 'oneToOne' | 'onlyBase' | 'onlyOther' | 'oneToMany' | 'manyToOne' | 'manyToMany';

export const MATCH_KINDS: readonly MatchKind[] = ['oneToOne', 'onlyBase', 'onlyOther', 'oneToMany', 'manyToOne', 'manyToMany'];

/** The kinds where a value is on more than one record. */
export const MANY_KINDS: readonly MatchKind[] = ['oneToMany', 'manyToOne', 'manyToMany'];

/** The kinds that stop a compare: a value on more than one of BL's records. */
export const BLOCKING_KINDS: readonly MatchKind[] = ['manyToOne', 'manyToMany'];

export interface MatchGroup {
    kind: MatchKind;
    /** Row numbers on each side. */
    base: number[];
    other: number[];
}

export interface MatchProfile {
    keyColumns: string[];
    rowsBase: number;
    rowsOther: number;
    counts: Record<MatchKind, number>;
    /** Every key: the Baseline's in its row order, then the ones only the other result has. */
    groups: MatchGroup[];
}

function kindOf(base: number, other: number): MatchKind {
    if (base > 1) return other > 1 ? 'manyToMany' : 'manyToOne';
    if (other > 1) return 'oneToMany';
    if (base === 0) return 'onlyOther';
    return other === 0 ? 'onlyBase' : 'oneToOne';
}

export async function matchProfile(
    rowsBase: readonly CompareRowData[],
    rowsOther: readonly CompareRowData[],
    keyColumns: string[],
    run: CompareRunOptions = {},
): Promise<MatchProfile> {
    const byKey = new Map<string, MatchGroup>();
    const order: MatchGroup[] = [];
    const groupFor = (k: string): MatchGroup => {
        let g = byKey.get(k);
        if (!g) {
            g = { kind: 'oneToOne', base: [], other: [] };
            byKey.set(k, g);
            order.push(g);
        }
        return g;
    };
    // In chunks, yielding between them: a big result never freezes the screen, and it shows progress
    const chunk = run.chunkSize ?? 20_000;
    const total = rowsBase.length + rowsOther.length;
    let done = 0;
    for (const [rows, side] of [[rowsBase, 'base'], [rowsOther, 'other']] as const) {
        for (let start = 0; start < rows.length; start += chunk) {
            if (run.signal?.aborted) throw abortError();
            const end = Math.min(rows.length, start + chunk);
            for (let n = start; n < end; n++) groupFor(rowKey(rows[n], keyColumns))[side].push(n);
            done += end - start;
            run.onProgress?.({ done, total });
            await yieldToEventLoop();
        }
    }
    const counts = Object.fromEntries(MATCH_KINDS.map(k => [k, 0])) as Record<MatchKind, number>;
    for (const g of order) {
        g.kind = kindOf(g.base.length, g.other.length);
        counts[g.kind]++;
    }
    return { keyColumns: keyColumns.slice(), rowsBase: rowsBase.length, rowsOther: rowsOther.length, counts, groups: order };
}

/** The key can be compared: BL holds each value once at most, and at least one of its records pairs. */
export function keyCanCompare(counts: Record<MatchKind, number>): boolean {
    return (counts.oneToOne > 0 || counts.oneToMany > 0) && BLOCKING_KINDS.every(k => counts[k] === 0);
}

