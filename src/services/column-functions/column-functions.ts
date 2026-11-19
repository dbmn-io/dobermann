// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Functions on a column: the one definition Query, Compare and Run Batch share, so "Upper case"
 * means the same wherever it is ticked.
 *
 * Each function is a standard SQLite function. Query runs them as SQL (`columnFnSql`); Compare and
 * Run Batch, which hold their values in memory, run them here (`applyColumnFns`), giving exactly
 * what SQLite gives for the same value (column-functions.test.ts checks every function against
 * SQLite itself). The list the dialog shows (`COLUMN_FUNCTIONS`) is written as the SQL it makes,
 * with the column's name in it and its values typed in place: the DbmnFunctions dialog's shape
 * (src/webviews/shared/dbmn-functions.js).
 *
 * Functions apply in order, the first innermost. A blank (null) stays blank through every one,
 * as in SQL.
 */

/** One function on a column, with its values. */
export type ColumnFn =
    | { fn: 'trim' }
    | { fn: 'upper' }
    | { fn: 'lower' }
    | { fn: 'ltrimZeros' }
    /** CAST(x AS TEXT) and CAST(x AS NUMERIC): the number 123 meets the text "123". */
    | { fn: 'text' }
    | { fn: 'number' }
    | { fn: 'first'; n: number }
    | { fn: 'last'; n: number }
    | { fn: 'replace'; from: string; to: string };

export type ColumnFnId = ColumnFn['fn'];

/** A piece of a function as the dialog writes it: 'x' (the column), text, or a value typed in place. */
export type ColumnFnPiece = 'x' | string | { key: 'n' | 'from' | 'to'; label: string; number?: boolean };

export interface ColumnFnDefinition {
    id: ColumnFnId;
    label: string;
    sql: ColumnFnPiece[];
}

/** What can be ticked, in the order the dialog lists them. */
export const COLUMN_FUNCTIONS: ColumnFnDefinition[] = [
    { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
    { id: 'upper', label: 'Upper case', sql: ['UPPER(', 'x', ')'] },
    { id: 'text', label: 'As text', sql: ['CAST(', 'x', ' AS TEXT)'] },
    { id: 'number', label: 'As a number', sql: ['CAST(', 'x', ' AS NUMERIC)'] },
    { id: 'ltrimZeros', label: 'Drop leading zeros', sql: ['LTRIM(', 'x', ", '0')"] },
    { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', number: true, label: 'How many characters' }, ')'] },
    { id: 'last', label: 'Last characters', sql: ['SUBSTR(', 'x', ', -', { key: 'n', number: true, label: 'How many characters' }, ')'] },
    { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Text to replace' }, "', '", { key: 'to', label: 'Replace with' }, "')"] }
];

/** A value's starting value in the dialog, by key. */
export const COLUMN_FUNCTION_DEFAULTS = { n: 4, from: '-', to: '' };

/** A count of characters: a whole number, at least 1. */
export function wholeNumber(n: number): number {
    const whole = Math.floor(Number(n));
    return Number.isFinite(whole) && whole > 0 ? whole : 1;
}

export function quoteText(text: string): string {
    return `'${String(text).replace(/'/g, "''")}'`;
}

/** The functions as SQL around `sql` (a column, already quoted), the first innermost. */
export function columnFnSql(sql: string, fns: ColumnFn[] | undefined): string {
    let out = sql;
    for (const f of fns ?? []) {
        switch (f.fn) {
            case 'trim': out = `TRIM(${out})`; break;
            case 'upper': out = `UPPER(${out})`; break;
            case 'lower': out = `LOWER(${out})`; break;
            case 'text': out = `CAST(${out} AS TEXT)`; break;
            case 'number': out = `CAST(${out} AS NUMERIC)`; break;
            case 'ltrimZeros': out = `LTRIM(${out}, '0')`; break;
            case 'first': out = `SUBSTR(${out}, 1, ${wholeNumber(f.n)})`; break;
            case 'last': out = `SUBSTR(${out}, -${wholeNumber(f.n)})`; break;
            case 'replace': out = `REPLACE(${out}, ${quoteText(f.from)}, ${quoteText(f.to)})`; break;
        }
    }
    return out;
}

/** What a value is, as SQLite holds it: a number, text, or blank. A yes/no is 1 or 0. */
export type ColumnValue = string | number | null;

/** A value from a result or a file, as SQLite would hold it. */
export function asColumnValue(value: unknown): ColumnValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

/**
 * A number as SQLite writes it as text. A value is stored as sql.js stores a JavaScript number: a
 * whole number that fits 32 bits as a whole number ("54"), anything else as a real, written to 15
 * significant digits with at least one decimal ("1.5", "123456789012.0", "1.0e+21").
 */
function numberText(n: number): string {
    if (n === (n | 0)) return String(n);
    const exp = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)));
    const tidy = (digits: string): string => {
        const t = digits.includes('.') ? digits.replace(/0+$/, '').replace(/\.$/, '.0') : `${digits}.0`;
        return t;
    };
    if (exp < -4 || exp >= 15) {
        const [mantissa, power] = n.toExponential(14).split('e');
        const p = Number(power);
        return `${tidy(mantissa)}e${p < 0 ? '-' : '+'}${String(Math.abs(p)).padStart(2, '0')}`;
    }
    return tidy(n.toPrecision(15));
}

/** SQLite's text of a value (what the text functions work on). */
function asText(v: string | number): string {
    return typeof v === 'number' ? numberText(v) : v;
}

/** CAST(text AS NUMERIC): the longest number at its start, or 0; a whole number stays whole. */
function textAsNumber(text: string): number {
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
}

/** SQLite's UPPER and LOWER change only the letters A to Z. */
function asciiCase(text: string, upper: boolean): string {
    return upper ? text.replace(/[a-z]+/g, s => s.toUpperCase()) : text.replace(/[A-Z]+/g, s => s.toLowerCase());
}

/** Characters, as SQLite counts them (not UTF-16 halves). */
function chars(text: string): string[] {
    return Array.from(text);
}

/** One function on one value, as SQLite does it. */
function applyOne(v: ColumnValue, f: ColumnFn): ColumnValue {
    if (v === null) return null;
    switch (f.fn) {
        case 'trim': return asText(v).replace(/^ +| +$/g, '');
        case 'upper': return asciiCase(asText(v), true);
        case 'lower': return asciiCase(asText(v), false);
        case 'ltrimZeros': return asText(v).replace(/^0+/, '');
        case 'text': return asText(v);
        case 'number': return typeof v === 'number' ? v : textAsNumber(v);
        case 'first': return chars(asText(v)).slice(0, wholeNumber(f.n)).join('');
        case 'last': return chars(asText(v)).slice(-wholeNumber(f.n)).join('');
        case 'replace': return f.from === '' ? asText(v) : asText(v).split(f.from).join(f.to);
    }
}

/** A value through the functions, in order, the same as `columnFnSql` gives in SQLite. */
export function applyColumnFns(value: unknown, fns: ColumnFn[] | undefined): ColumnValue {
    let v = asColumnValue(value);
    for (const f of fns ?? []) v = applyOne(v, f);
    return v;
}
