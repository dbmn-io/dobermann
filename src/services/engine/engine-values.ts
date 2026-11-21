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

/** A value as a number for arithmetic; blank stays blank. */
export function arithmetic(v: V): number | Real | null {
    if (v === null) return null;
    if (typeof v === 'string') return textAsNumber(v);
    return v;
}

/**
 * CAST(x AS NUMERIC). Text: its leading number ("0042" → 42, "1.50" → 1.5, "12abc" → 12); a real
 * that is whole becomes an integer ("1.0" → 1, "1e3" → 1000).
 * QUIRK for James (DESIGN-review.md §3): text with no number in it ("abc", "") becomes 0, as SQLite
 * does today. If James wants blank instead, flip NUMERIC_TEXT_WITHOUT_A_NUMBER_IS_ZERO.
 */
export const NUMERIC_TEXT_WITHOUT_A_NUMBER_IS_ZERO = true;
export function castNumeric(v: V): V {
    if (v === null || isNumber(v)) return v;
    const m = NUMBER_PREFIX.exec(v);
    if (!m) return NUMERIC_TEXT_WITHOUT_A_NUMBER_IS_ZERO ? 0 : null;
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

/**
 * The numeric type SQLite gives a value before some functions (ABS): a number as it is; text that is
 * wholly a number becomes it (an integer when written as one); other text stays text.
 */
export function numericType(v: V): V {
    if (v === null || isNumber(v)) return v;
    if (WHOLE_INTEGER.test(v)) { const n = Number(v.trim()); return Number.isSafeInteger(n) ? n : new Real(n); }
    if (WHOLE_NUMBER.test(v)) return new Real(Number(v.trim()));
    return v;
}

/** A value as SQLite's sqlite3_value_double: a number as it is, text's leading number, else 0. */
export function asDouble(v: V): number {
    if (v === null) return 0;
    if (typeof v === 'string') return num(textAsNumber(v));
    return num(v);
}

/** Is a value true, as SQLite's WHERE and CASE WHEN read it: blank is not; a number other than 0 is; text by its leading number. */
export function truthy(v: V): boolean | null {
    if (v === null) return null;
    if (typeof v === 'string') return num(textAsNumber(v)) !== 0;
    return num(v) !== 0;
}

/**
 * The order SQLite gives values with no column affinity (as Query's tables have): blank first,
 * then numbers by value, then text by its characters' code points (BINARY: the same order as the
 * bytes of UTF-8). A number is never equal to text.
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

/**
 * A value's affinity in a comparison, as SQLite gives it: a column of Query's tables (declared with
 * no type) has BLOB affinity; a CAST gives its type (TEXT, NUMERIC); a constant or any other
 * expression has none. Comparing, SQLite first converts: a side with a number affinity turns the
 * other side's well-formed number text into a number ("0042" = CAST(x AS INTEGER) compares 42); a
 * side with TEXT affinity turns the other side's number into text only when that side has no
 * affinity at all, a constant (TEXT(x) = 5 compares "5" with "5"; TEXT(x) = a column holding 5 doesn't).
 */
export type Affinity = 'blob' | 'none' | 'text' | 'numeric';

/** Text that is wholly a number becomes it (an integer when it is a whole one); anything else as it is. */
export function applyNumericAffinity(v: V): V {
    if (typeof v !== 'string' || !WHOLE_NUMBER.test(v)) return v;
    const n = Number(v.trim());
    if (Number.isSafeInteger(n)) return n;
    return new Real(n);
}

/** A number becomes its text; anything else as it is. */
export function applyTextAffinity(v: V): V {
    return isNumber(v) ? asText(v) : v;
}

/** The two sides of a comparison after SQLite's conversions for their affinities. */
export function forComparison(a: V, aff: Affinity, b: V, bff: Affinity): [V, V] {
    if (aff === 'numeric' && bff !== 'numeric') return [a, applyNumericAffinity(b)];
    if (bff === 'numeric' && aff !== 'numeric') return [applyNumericAffinity(a), b];
    if (aff === 'text' && bff === 'none') return [a, applyTextAffinity(b)];
    if (bff === 'text' && aff === 'none') return [applyTextAffinity(a), b];
    return [a, b];
}
