// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Values inside the engine, and how they convert, as SQLite does it today (the app's reference:
 * DESIGN-review.md §3). SQLite tells a whole number (integer) from a real even when the real is
 * whole: 2.0 is a real and reads "2.0" as text, 2 is an integer and reads "2". So inside an
 * expression a real is a `Real`, an integer a plain number; out of the engine both are plain
 * numbers (as sql.js gives them).
 */
import type { Value } from './engine-types';

/** A real (floating point) number, kept apart from a whole integer. */
export class Real {
    constructor(readonly r: number) {}
}

/** A value while an expression is worked out: blank, an integer, a real, or text. */
export type V = null | number | Real | string;

/** A value coming in: a whole number is an integer, any other number a real (as QuerySession.load stores it). */
export function fromValue(value: Value): V {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        // (as QuerySession.load's valueSql: a whole number within the integers SQLite holds is one; 1e20 stays a real)
        return Number.isSafeInteger(value) ? value : new Real(value);
    }
    return String(value);
}

/** A value going out: numbers plain, as sql.js gives them. */
export function toValue(v: V): Value {
    if (v instanceof Real) return v.r;
    return v;
}

export const isNumber = (v: V): v is number | Real => typeof v === 'number' || v instanceof Real;
export const num = (v: number | Real): number => (typeof v === 'number' ? v : v.r);

/** A number as SQLite makes it: an integer when it is a safe whole number and `real` isn't asked for. */
export function makeNumber(n: number, real: boolean): number | Real | null {
    if (!Number.isFinite(n)) return null;
    if (!real && Number.isInteger(n) && Number.isSafeInteger(n)) return n;
    return new Real(n);
}

/**
 * A real as SQLite writes it as text ("%!.15g"): 15 significant digits, a whole real keeps ".0"
 * (2.0, -3.0), and large or small ones go to an exponent written e+NN / e-NN (1.0e+20).
 */
export function realText(r: number): string {
    if (r === 0) return Object.is(r, -0) ? '-0.0' : '0.0';
    let s = r.toPrecision(15);
    let mantissa = s;
    let exp = '';
    const e = s.indexOf('e');
    if (e >= 0) { mantissa = s.slice(0, e); exp = s.slice(e + 1); }
    if (mantissa.includes('.')) mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '');
    // %g: an exponent below -4 or at least 15 (the precision) is written as one
    const power = Math.floor(Math.log10(Math.abs(r)));
    if (!exp && (power < -4 || power >= 15)) {
        s = r.toExponential(14);
        const at = s.indexOf('e');
        mantissa = s.slice(0, at).replace(/0+$/, '').replace(/\.$/, '');
        exp = s.slice(at + 1);
    }
    if (!mantissa.includes('.')) mantissa += '.0';
    if (!exp) return mantissa;
    const sign = exp.startsWith('-') ? '-' : '+';
    const digits = exp.replace(/^[+-]/, '').padStart(2, '0');
    return `${mantissa}e${sign}${digits}`;
}

/** A value as text, as SQLite's CAST(x AS TEXT) (blank stays blank). */
export function asText(v: V): string | null {
    if (v === null) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Real) return realText(v.r);
    return String(v);
}

/** The longest leading number in text: SQLite's reading of text as a number (" 12abc" → 12, "abc" → none). */
const NUMBER_PREFIX = /^[ \t\n\f\r\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const INTEGER_PREFIX = /^[ \t\n\f\r\v]*([+-]?\d+)/;
/** The whole text is one number (with spaces round it): SQLite's "well-formed". */
const WHOLE_NUMBER = /^[ \t\n\f\r\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\f\r\v]*$/;
const WHOLE_INTEGER = /^[ \t\n\f\r\v]*[+-]?\d+[ \t\n\f\r\v]*$/;

/**
 * Text as a number for arithmetic (+ - * / and the like): its leading number, else 0. An integer
 * when the leading number is written as one ("12", "12abc"), else a real ("1.5", "1e3").
 */
export function textAsNumber(t: string): number | Real {
    const m = NUMBER_PREFIX.exec(t);
    if (!m) return 0;
    const lit = m[1];
    const n = Number(lit);
    if (/^[+-]?\d+$/.test(lit) && Number.isSafeInteger(n)) return n;
    return new Real(n);
}

/**
 * A value read as a number: the one rule everywhere in the engine (NUMBER, As a number, arithmetic,
 * Round, Abs, Floor, Ceil, Sum, a yes/no test). A number as it is; text that is a plain number,
 * spaces round it allowed, as that number ("0042" → 42, " 1.50 " → 1.5, "1e3" → 1000, "1.0" → 1);
 * any other text blank ("abc", "12abc", "", "1.2.3"). James, 2026-11-21. SQLite reads a text's
 * leading number instead ("12abc" → 12, "abc" → 0): engine-types.ts, "Differences from SQLite".
 */
export function readNumber(v: V): number | Real | null {
    if (v === null || isNumber(v)) return v;
    if (!WHOLE_NUMBER.test(v)) return null;
    return castNumeric(v.trim()) as number | Real;
}

/**
 * Text read as a number that isn't one (James, 2026-11-21: blank, plus a count). Counted only
 * while `on`: the engine turns it on around one column's values at a time (engine.ts countNotNumbers).
 * Empty text and spaces are blank already, not counted.
 */
export const notNumbers = { on: false, count: 0 };

/** readNumber, counting text that isn't a number (notNumbers): arithmetic, Round, Abs, Floor, Ceil, NUMBER. */
export function readNumberCounted(v: V): number | Real | null {
    const n = readNumber(v);
    if (n === null && notNumbers.on && typeof v === 'string' && v.trim() !== '') notNumbers.count++;
    return n;
}

/** A value as a number for arithmetic: readNumber, counted. */
export const arithmetic = (v: V): number | Real | null => readNumberCounted(v);

/**
 * SQLite's CAST(x AS NUMERIC), as NUMBER uses it on text it has already found to be a number: its
 * leading number ("0042" → 42, "1.50" → 1.5); a real that is whole becomes an integer ("1.0" → 1,
 * "1e3" → 1000). (Text with no number in it, 0, as SQLite; NUMBER never passes such text.)
 */
export function castNumeric(v: V): V {
    if (v === null || isNumber(v)) return v;
    const m = NUMBER_PREFIX.exec(v);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return new Real(n);
    if (Number.isInteger(n) && Math.abs(n) < 9.2e18) return Number.isSafeInteger(n) ? n : new Real(n);
    return new Real(n);
}

/** CAST(x AS INTEGER): a real cut toward zero; text's leading whole number ("2.9" → 2, "1e3" → 1, "abc" → 0). */
const INT64_MAX = 9223372036854775807;
const INT64_MIN = -9223372036854775808;
export function castInteger(v: V): number | null {
    if (v === null) return null;
    if (typeof v === 'number') return v;
    // (cut toward zero; past SQLite's 64-bit integers, held at their ends)
    if (v instanceof Real) return v.r >= INT64_MAX ? INT64_MAX : v.r <= INT64_MIN ? INT64_MIN : Math.trunc(v.r);
    const m = INTEGER_PREFIX.exec(v);
    return m ? Number(m[1]) : 0;
}



/** Is a value true (a filter, IF, AND, OR, NOT): blank is not known; a number other than 0 is; text as readNumber reads it (not a number: not known). */
export function truthy(v: V): boolean | null {
    const n = readNumber(v);
    if (n === null) return null;
    return num(n) !== 0;
}

/**
 * Are two values equal: James, 2026-11-21 ("loose is good"). A number equals text that reads the
 * same characters as the number is shown (42 = "42", 12.5 = "12.5"), but not other text for the same
 * number ("12.50", "007", " 42"), so leading zeros stay apart. Two numbers by value, two texts by
 * their characters. Blank is equal to nothing (null: not known), as SQL's =.
 */
export function sameValue(a: V, b: V): boolean | null {
    if (a === null || b === null) return null;
    return equalForm(a) === equalForm(b);
}

/** Two cells alike, for the compare: by sameValue, and two blanks alike. */
export function alike(a: V, b: V): boolean {
    if (a === null || b === null) return a === b;
    return equalForm(a) === equalForm(b);
}

/** A value's form for equality: text as it is; a number as JavaScript writes it, as Results shows it (2.0 as "2"). */
export function equalForm(v: number | Real | string): string {
    return typeof v === 'string' ? v : String(num(v));
}

/** One part of a key (join, compare, group): its equal form, so equal values make the same key. */
export function keyPart(v: number | Real | string): string {
    const f = equalForm(v);
    return `${f.length}:${f}`;
}

/**
 * A row's key as text for matching, from its parts: null when any part is blank; equal values
 * (sameValue: 42 and "42") the same text. A key of one part is its value's own text (no new string
 * a row for text already held); of several, each part's length and text, so parts never run into
 * each other. Every reader of one compare or join has as many parts, so their texts match.
 */
export function keyReader(parts: ((row: number) => V)[]): (row: number) => string | null {
    if (parts.length === 1) {
        const f = parts[0];
        return row => { const v = f(row); return v === null ? null : equalForm(v); };
    }
    return row => {
        let key = '';
        for (const p of parts) {
            const v = p(row);
            if (v === null) return null;
            key += keyPart(v);
        }
        return key;
    };
}

/**
 * The order of values (sort, Min, Max, < and >): blank first, then numbers by value, then text by
 * its characters' code points (the same order as UTF-8's bytes). Equality is sameValue's, not
 * this: 42 and "42" are equal though a number sorts before text.
 */
export function compareValues(a: V, b: V): number {
    if (a === null || b === null) return a === null ? (b === null ? 0 : -1) : 1;
    const an = isNumber(a);
    const bn = isNumber(b);
    if (an && bn) { const x = num(a), y = num(b); return x < y ? -1 : x > y ? 1 : 0; }
    if (an) return -1;
    if (bn) return 1;
    return compareText(a as string, b as string);
}

/** Text by code points (UTF-8 byte order), not by JavaScript's UTF-16 units. */
export function compareText(a: string, b: string): number {
    if (a === b) return 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a.codePointAt(i)!;
        const y = b.codePointAt(i)!;
        if (x !== y) return x < y ? -1 : 1;
        if (x > 0xffff) i++;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** A value's characters, as SQLite counts them (code points; a number as its text). */
export function chars(t: string): string[] {
    return Array.from(t);
}
