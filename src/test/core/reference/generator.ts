/**
 * Reference data for Query's engine tests: tables made from a seed, so a failure can be made
 * again exactly. The tester owns this file (the engine's builder doesn't write the cases it is
 * judged by).
 *
 * What a pair of tables can hold, each switched on by an option:
 * - keys that repeat on one side or both (one to many, many to many);
 * - keys only on the left, only on the right, and on both;
 * - blanks: null and the empty string, in keys and in values;
 * - mixed types in one column: numbers, numbers written as text, true/false, text;
 * - a key of two columns;
 * - keys written differently on each side (spaces, leading zeros, case), so a function
 *   (TRIM, LTRIM zeros, UPPER) is needed to match them.
 */

export type Value = string | number | boolean | null;

export interface Table {
    name: string;
    columns: string[];
    rows: Value[][];
}

export interface PairOptions {
    /** Seed: the same seed makes the same tables. */
    seed: number;
    /** Rows on the left (the right is about the same). */
    rows: number;
    /** Share of the left's keys that the right also has (0 to 1). */
    overlap?: number;
    /** Share of keys that appear on two or three rows of a side. */
    repeats?: number;
    /** Share of key cells that are null or '' (half each). */
    blankKeys?: number;
    /** Share of value cells that are null or ''. */
    blankValues?: number;
    /** A value column holding numbers, numbers as text, true/false and text. */
    mixedTypes?: boolean;
    /** The key is two columns (code and site), not one. */
    twoColumnKey?: boolean;
    /** The right's keys are written differently (spaces, leading zeros, case). */
    noisyRightKeys?: boolean;
}

export interface Pair {
    left: Table;
    right: Table;
    /** The key's column names, left then right, in order (one or two each). */
    leftKey: string[];
    rightKey: string[];
}

/** A small fast PRNG (mulberry32): the same seed always gives the same numbers. */
export function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const code = (n: number) => `K${String(n).padStart(5, '0')}`;
const SITES = ['north', 'south', 'east'] as const;

/** A value for the mixed-types column: a number, a number as text, true/false, or text. */
function mixed(r: () => number): Value {
    const n = Math.floor(r() * 1000);
    switch (Math.floor(r() * 4)) {
        case 0: return n;
        case 1: return String(n);
        case 2: return r() < 0.5;
        default: return pick(r, ['EA', 'BOX', 'pallet', 'Each']);
    }
}

/** The same key written another way: spaces round it, leading zeros, or its case changed. */
function noisy(r: () => number, key: string): string {
    switch (Math.floor(r() * 3)) {
        case 0: return `  ${key} `;
        case 1: return key.replace(/^K/, 'K00');
        default: return key.toLowerCase();
    }
}

function blankOr(r: () => number, share: number, value: Value): Value {
    if (r() >= share) return value;
    return r() < 0.5 ? null : '';
}

/** Two tables to join or compare, as the options say. */
export function makePair(options: PairOptions): Pair {
    const r = random(options.seed);
    const overlap = options.overlap ?? 0.7;
    const repeats = options.repeats ?? 0;
    const blankKeys = options.blankKeys ?? 0;
    const blankValues = options.blankValues ?? 0;
    const two = !!options.twoColumnKey;

    // Distinct keys: the left's, then the right's (some shared, some only its own)
    const leftKeys = Array.from({ length: options.rows }, (_, i) => i + 1);
    const shared = leftKeys.filter(() => r() < overlap);
    const rightOnly = Array.from({ length: Math.max(1, Math.round(options.rows * (1 - overlap))) }, (_, i) => options.rows + i + 1);
    const rightKeys = [...shared, ...rightOnly];

    const leftKey = two ? ['code', 'site'] : ['code'];
    const rightKey = two ? ['itemCode', 'itemSite'] : ['itemCode'];
    const left: Table = { name: 'L', columns: [...leftKey, 'qty', 'uom', ...(options.mixedTypes ? ['mixed'] : [])], rows: [] };
    const right: Table = { name: 'R', columns: [...rightKey, 'price', 'status', ...(options.mixedTypes ? ['mixed'] : [])], rows: [] };

    const site = (n: number) => SITES[n % SITES.length];
    const copies = () => (r() < repeats ? (r() < 0.5 ? 2 : 3) : 1);

    for (const n of leftKeys) {
        for (let c = copies(); c > 0; c--) {
            const key: Value[] = [blankOr(r, blankKeys, code(n)), ...(two ? [site(n)] : [])];
            left.rows.push([...key, blankOr(r, blankValues, Math.floor(r() * 500)), blankOr(r, blankValues, pick(r, ['EA', 'BOX'])), ...(options.mixedTypes ? [blankOr(r, blankValues, mixed(r))] : [])]);
        }
    }
    for (const n of rightKeys) {
        for (let c = copies(); c > 0; c--) {
            const written = options.noisyRightKeys ? noisy(r, code(n)) : code(n);
            const key: Value[] = [blankOr(r, blankKeys, written), ...(two ? [site(n)] : [])];
            right.rows.push([...key, blankOr(r, blankValues, Math.round(r() * 10000) / 100), blankOr(r, blankValues, pick(r, ['active', 'hold', 'expired'])), ...(options.mixedTypes ? [blankOr(r, blankValues, mixed(r))] : [])]);
        }
    }
    return { left, right, leftKey, rightKey };
}

/** The named presets every engine run is checked on, from plain to awkward. */
export const PRESETS: Record<string, Omit<PairOptions, 'seed' | 'rows'>> = {
    plain: {},
    repeated: { repeats: 0.3 },
    blanks: { blankKeys: 0.1, blankValues: 0.2 },
    mixed: { mixedTypes: true, blankValues: 0.1 },
    twoColumnKey: { twoColumnKey: true, repeats: 0.2 },
    noisyKeys: { noisyRightKeys: true },
    everything: { repeats: 0.3, blankKeys: 0.1, blankValues: 0.2, mixedTypes: true, twoColumnKey: true },
};
