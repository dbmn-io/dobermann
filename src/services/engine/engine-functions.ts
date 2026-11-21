// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Every function the engine carries (FUNCTIONS in engine-types.ts), each giving what SQLite gives
 * today for the same values: the ƒ dialog's column functions (column-functions.ts, columnFnSql) and
 * the formula language's (formula.ts, formulaSql), with its operators. DESIGN-review.md §3 lists
 * each one's behaviour on blanks and types; the tester's reference harness checks every one
 * against SQLite on the same values.
 */
import type { FunctionName } from './engine-types';
import {
    arithmetic, asText, castInteger, chars, compareValues, isNumber, makeNumber,
    num, readNumberCounted, Real, sameValue, textAsNumber, truthy, type V
} from './engine-values';


/** A loaded table a function reads (TRANSLATE): its column names and rows, as the engine holds them. */
export interface LookupSource {
    columns: string[];
    rowCount: number;
    value(row: number, column: number): V;
}

export interface FunctionContext {
    /** A loaded table by name, or undefined. */
    table(name: string): LookupSource | undefined;
}

/** How many arguments each function takes: [least, most]. */
export const ARITY: Record<FunctionName, [number, number]> = {
    '+': [2, 2], '-': [2, 2], '*': [2, 2], '/': [2, 2], NEG: [1, 1],
    '=': [2, 2], '<>': [2, 2], '>': [2, 2], '<': [2, 2], '>=': [2, 2], '<=': [2, 2],
    IF: [2, 3], IFBLANK: [2, 2], AND: [2, Infinity], OR: [2, Infinity], NOT: [1, 1],
    ROUND: [1, 2], ABS: [1, 1], FLOOR: [1, 1], CEIL: [1, 1], MIN: [2, Infinity], MAX: [2, Infinity],
    CONCAT: [2, Infinity], UPPER: [1, 1], LOWER: [1, 1], TRIM: [1, 1], LTRIM: [1, 2], LEFT: [2, 2], RIGHT: [2, 2],
    SUBSTR: [2, 3], REPLACE: [3, 3], LENGTH: [1, 1],
    TEXT: [1, 1], NUMERIC: [1, 1], NUMBER: [1, 1],
    TRANSLATE: [4, 4]
};

const bool = (b: boolean | null): V => (b === null ? null : b ? 1 : 0);

/** + - *: blank if either is blank or not a number (readNumber); an integer when both are and it fits. */
function arith(a: V, b: V, op: '+' | '-' | '*'): V {
    const x = arithmetic(a);
    const y = arithmetic(b);
    if (x === null || y === null) return null;
    const p = num(x), q = num(y);
    const r = op === '+' ? p + q : op === '-' ? p - q : p * q;
    const real = x instanceof Real || y instanceof Real;
    return makeNumber(r, real);
}

/** The formula's division: x * 1.0 / NULLIF(y, 0): always a real; by 0 (or blank) blank. */
function divide(a: V, b: V): V {
    if (a === null || b === null) return null;
    // NULLIF(y, 0): only a number 0 is 0 (text "0" is not equal to the integer 0)
    if (isNumber(b) && num(b) === 0) return null;
    const x = arithmetic(a);
    const y = arithmetic(b);
    if (x === null || y === null || num(y) === 0) return null;
    return makeNumber(num(x) / num(y), true);
}

/** = <> < > <= >=: equal by sameValue (42 = "42"); otherwise in compareValues' order. Blank: not known. */
function compare(a: V, b: V, test: (c: number) => boolean): V {
    if (a === null || b === null) return null;
    return bool(test(sameValue(a, b) ? 0 : compareValues(a, b)));
}

/** A value as text, for the text functions (blank stays blank; a number as its text). */
const text = (v: V): string | null => asText(v);

/** Upper / Lower case: every letter, accented ones included (James, 2026-11-21; SQLite changes a–z only). */
function letterCase(t: string, upper: boolean): string {
    return upper ? t.toUpperCase() : t.toLowerCase();
}

/** SQLite's TRIM/LTRIM: characters from a set (default a space) off the ends. */
function trimSet(t: string, set: string, left: boolean, right: boolean): string {
    const cs = new Set(chars(set));
    const list = chars(t);
    let i = 0, j = list.length;
    if (left) while (i < j && cs.has(list[i])) i++;
    if (right) while (j > i && cs.has(list[j - 1])) j--;
    return list.slice(i, j).join('');
}

/** SQLite's SUBSTR(x, y, z) on characters, its rules for a start of 0, a negative start and a negative length. */
function substr(x: V, y: V, z: V | undefined): V {
    if (x === null || y === null || z === null) return null;
    const t = text(x)!;
    const cs = chars(t);
    const len = cs.length;
    let p1 = castInteger(y)!;
    let p2: number;
    let negP2 = false;
    if (z !== undefined) {
        p2 = castInteger(z)!;
        if (p2 < 0) { p2 = -p2; negP2 = true; }
    } else {
        p2 = 1_000_000_000;
    }
    if (p1 < 0) {
        p1 += len;
        if (p1 < 0) { p2 += p1; if (p2 < 0) p2 = 0; p1 = 0; }
    } else if (p1 > 0) {
        p1--;
    } else if (p2 > 0) {
        p2--;
    }
    if (negP2) {
        p1 -= p2;
        if (p1 < 0) { p2 += p1; p1 = 0; }
    }
    return cs.slice(p1, p1 + p2).join('');
}

/** SQLite's ROUND(x, places): always a real; places below 0 taken as 0; halves away from zero. */
function round(x: V, p: V | undefined): V {
    if (x === null) return null;
    if (p === null) return null;
    let places = p === undefined ? 0 : castInteger(p)!;
    if (places < 0) places = 0;
    if (places > 30) places = 30;
    const read = readNumberCounted(x);
    if (read === null) return null;
    const n = num(read);
    if (places === 0) return makeNumber(n < 0 ? -Math.floor(-n + 0.5) : Math.floor(n + 0.5), true);
    // (as SQLite: printf with so many decimals, read back)
    return makeNumber(Number(n.toFixed(Math.min(places, 100))), true);
}

/** ABS: an integer stays one, a real one; text as readNumber reads it (not a number: blank). */
function abs(x: V): V {
    const v = readNumberCounted(x);
    if (v === null) return null;
    if (typeof v === 'number') return Math.abs(v);
    return new Real(Math.abs(v.r));
}

/**
 * FLOOR and CEIL, on numbers: x read as NUMBER reads it (a number, or text that is a plain number;
 * anything else blank), then the whole number at or below (FLOOR) or at or above (CEIL) it, an
 * integer, held at SQLite's 64-bit ends as its CAST is.
 */
function floor(x: V): V {
    const n = numberFn(x);
    if (n === null) return null;
    const i = castInteger(n)!;
    return i - (compareValues(n, i) < 0 ? 1 : 0);
}
function ceil(x: V): V {
    const n = numberFn(x);
    if (n === null) return null;
    const i = castInteger(n)!;
    return i + (compareValues(n, i) > 0 ? 1 : 0);
}

/** SQLite's MIN/MAX of several: blank if any is blank, else the least / greatest in SQLite's order. */
function minMax(args: V[], max: boolean): V {
    if (args.some(a => a === null)) return null;
    let best = args[0];
    for (const a of args.slice(1)) {
        const c = compareValues(a, best);
        if (max ? c > 0 : c < 0) best = a;
    }
    return best;
}

/** NUMBER (and As a number): readNumber (text that isn't a number counted). */
function numberFn(x: V): V {
    return readNumberCounted(x);
}

/** Translate values: the first row of the table whose `from` column holds the value (as text) gives its `to` column; not found, the value. */
function translate(x: V, tableName: V, from: V, to: V, ctx: FunctionContext): V {
    if (x === null) return null;
    const table = ctx.table(String(tableName ?? ''));
    if (!table) return x;
    const fromAt = table.columns.indexOf(String(from ?? ''));
    const toAt = table.columns.indexOf(String(to ?? ''));
    if (fromAt < 0 || toAt < 0) return x;
    const key = text(x);
    for (let r = 0; r < table.rowCount; r++) {
        const v = table.value(r, fromAt);
        if (typeof v === 'string' && v === key) {
            const found = table.value(r, toAt);
            return found === null ? x : found;
        }
    }
    return x;
}

/** Work out one function on its arguments' values. */
export function callFunction(name: FunctionName, a: V[], ctx: FunctionContext): V {
    switch (name) {
        case '+': return arith(a[0], a[1], '+');
        case '-': return arith(a[0], a[1], '-');
        case '*': return arith(a[0], a[1], '*');
        case '/': return divide(a[0], a[1]);
        case 'NEG': { const x = arithmetic(a[0]); return x === null ? null : typeof x === 'number' ? (x === 0 ? 0 : -x) : new Real(-x.r); }
        case '=': return compare(a[0], a[1], c => c === 0);
        case '<>': return compare(a[0], a[1], c => c !== 0);
        case '>': return compare(a[0], a[1], c => c > 0);
        case '<': return compare(a[0], a[1], c => c < 0);
        case '>=': return compare(a[0], a[1], c => c >= 0);
        case '<=': return compare(a[0], a[1], c => c <= 0);
        case 'IF': return truthy(a[0]) ? a[1] : (a.length > 2 ? a[2] : null);
        case 'IFBLANK': return a[0] === null || a[0] === '' ? a[1] : a[0];
        case 'AND': {
            const t = a.map(truthy);
            if (t.some(x => x === false)) return 0;
            return t.some(x => x === null) ? null : 1;
        }
        case 'OR': {
            const t = a.map(truthy);
            if (t.some(x => x === true)) return 1;
            return t.some(x => x === null) ? null : 0;
        }
        case 'NOT': { const t = truthy(a[0]); return t === null ? null : t ? 0 : 1; }
        case 'ROUND': return round(a[0], a.length > 1 ? a[1] : undefined);
        case 'ABS': return abs(a[0]);
        case 'FLOOR': return floor(a[0]);
        case 'CEIL': return ceil(a[0]);
        case 'MIN': return minMax(a, false);
        case 'MAX': return minMax(a, true);
        case 'CONCAT': return a.map(v => text(v) ?? '').join('');
        case 'UPPER': { const t = text(a[0]); return t === null ? null : letterCase(t, true); }
        case 'LOWER': { const t = text(a[0]); return t === null ? null : letterCase(t, false); }
        case 'TRIM': { const t = text(a[0]); return t === null ? null : trimSet(t, ' ', true, true); }
        case 'LTRIM': {
            const t = text(a[0]);
            if (t === null) return null;
            if (a.length > 1 && a[1] === null) return null;
            return trimSet(t, a.length > 1 ? text(a[1])! : ' ', true, false);
        }
        case 'LEFT': return substr(a[0], 1, a[1]);
        case 'RIGHT': {
            // CASE WHEN n > 0 THEN SUBSTR(t, -(n)) ELSE '' END
            const n = a[1];
            if (n === null || compareValues(n, 0) <= 0) return '';
            // (a count of characters, as LEFT's and SUBSTR's positions: read as SQLite reads it, not by the value rule)
            const lead = typeof n === 'string' ? textAsNumber(n) : n;
            const neg = typeof lead === 'number' ? -lead : new Real(-num(lead));
            return substr(a[0], neg, undefined);
        }
        case 'SUBSTR': return substr(a[0], a[1], a.length > 2 ? a[2] : undefined);
        case 'REPLACE': {
            const [t, f, r] = a.map(text);
            if (t === null || f === null || r === null) return null;
            return f === '' ? t : t.split(f).join(r);
        }
        case 'LENGTH': { const t = text(a[0]); return t === null ? null : chars(t).length; }
        case 'TEXT': return text(a[0]);
        // "As a number": the same rule as NUMBER (James, 2026-11-21: text that is not a number is blank)
        case 'NUMERIC': return numberFn(a[0]);
        case 'NUMBER': return numberFn(a[0]);
        case 'TRANSLATE': return translate(a[0], a[1], a[2], a[3], ctx);
    }
}
