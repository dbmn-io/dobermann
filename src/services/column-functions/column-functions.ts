// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Functions on a column: the one definition Query, Compare and Run Batch share, so "Upper case"
 * means the same wherever it is ticked.
 *
 * Each function was a standard SQLite function (the SQL is the engine's tests' reference now:
 * src/test/core/reference/query-sql.ts columnFnSql); Compare and
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
    | { fn: 'replace'; from: string; to: string }
    /**
     * Translate values: a lookup table's row whose `from` column holds the value gives its `to`
     * column (table and columns by id, so a rename keeps it); a value the table hasn't stays as it
     * is. Only SQL can: the table is loaded where the query runs (lookupTableSql). In memory it is
     * left as it is.
     */
    | { fn: 'translate'; table: string; from: string; to: string };

export type ColumnFnId = ColumnFn['fn'];

/** A piece of a function as the dialog writes it: 'x' (the column), text, or a value typed in place. */
export type ColumnFnPiece = 'x' | string | { key: 'n' | 'from' | 'to' | 'table'; label: string; number?: boolean; kind?: 'lookup' };

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


/** The lookup tables functions read. */
export function lookupsIn(fns: ColumnFn[] | undefined): string[] {
    return (fns ?? []).flatMap(f => (f.fn === 'translate' && f.table ? [f.table] : []));
}

/** What a value is, as Query's tables hold it: a number, text, or blank. */
export type ColumnValue = string | number | null;

/**
 * A value from a result or a file, as Query's tables hold it (query-engine.ts toSql): yes/no is
 * the text "true" or "false", a list or object its JSON.
 */
export function asColumnValue(value: unknown): ColumnValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint') return value.toString();
    return JSON.stringify(value);
}

/**
 * A number as SQLite writes it as text. A whole number is held as one (query-engine.ts valueSql),
 * so it is written plainly: a 13-digit barcode is "1234567890123". Anything else is a decimal,
 * written to 15 significant digits with at least one decimal place ("1.5", "1.0e+21").
 */
function numberText(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 2 ** 63) return String(n);
    const exp = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)));
    const tidy = (digits: string): string => (digits.includes('.') ? digits.replace(/0+$/, '').replace(/\.$/, '.0') : `${digits}.0`);
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
        // (needs the table, which only SQL has: see columnFnSql)
        case 'translate': return v;
    }
}

/** A value through the functions, in order, the same as `columnFnSql` gives in SQLite. */
export function applyColumnFns(value: unknown, fns: ColumnFn[] | undefined): ColumnValue {
    let v = asColumnValue(value);
    for (const f of fns ?? []) v = applyOne(v, f);
    return v;
}
