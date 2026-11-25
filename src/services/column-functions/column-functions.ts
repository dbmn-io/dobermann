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

import { callFunction, type FunctionContext } from '../engine/engine-functions';
import type { Expr, FunctionName } from '../engine/engine-types';
import { fromValue, toValue, type V } from '../engine/engine-values';

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
    | { fn: 'translate'; table: string; from: string; to: string }
    /*
     * The steps Map and calculated columns add (James, 2026-11-25: one list of functions, one window,
     * steps in sequence, never nested). Each is an engine function (columnFnCall), run in memory by
     * the engine's own code, so Map and Query give the same value. `other` steps take another
     * column of the same row (`col`, an id the screen resolves: Map a file's column, Query its
     * column key) or a value typed in (`value`): exactly one.
     */
    /** Remove line breaks: each \r\n, \n or \r becomes a space. */
    | { fn: 'breaks' }
    /** If blank: a blank (or empty) value becomes `use`. */
    | { fn: 'ifblank'; use: string }
    /** If it is: a value equal to `is` becomes `then`; any other becomes `else`, or stays as it is when `else` is ''. */
    | { fn: 'ifis'; is: string; then: string; else: string }
    /** Arithmetic with another column or a value: x + o, x − o, x × o, x ÷ o, o − x, o ÷ x, the % change of x from o. */
    | ({ fn: OtherFnId } & OtherValue)
    /** Round to so many decimal places (0 or more). */
    | { fn: 'round'; places: number }
    /** Join text: x, then `between`, then the other column or value. */
    | ({ fn: 'jointext'; between: string } & OtherValue);

/** The arithmetic steps, each with another column or a value. */
export type OtherFnId = 'plus' | 'minus' | 'times' | 'divide' | 'subfrom' | 'divinto' | 'pct';

/** Another column of the same row (an id the screen resolves), or a value typed in: one of them. */
export type OtherValue = { col: string; value?: undefined } | { value: string | number; col?: undefined };

export type ColumnFnId = ColumnFn['fn'];

/** A piece of a function as the dialog writes it: 'x' (the column), text, or a value typed in place. */
export type ColumnFnPiece = 'x' | string | {
    key: 'n' | 'from' | 'to' | 'table' | 'use' | 'is' | 'then' | 'else' | 'places' | 'between' | 'other';
    label: string;
    number?: boolean;
    /** A whole number at least this (Count: 1; Places: 0). */
    min?: number;
    /** lookup: a lookup table (Table, From, To); other: another column of the row, or a value (col / value). */
    kind?: 'lookup' | 'other';
};

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
    { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Text to replace' }, "', '", { key: 'to', label: 'Replace with' }, "')"] },
    // (2026-11-25: Map's and calculated columns' steps; `other`: another column of the row, or a value)
    { id: 'lower', label: 'Lower case', sql: ['LOWER(', 'x', ')'] },
    { id: 'breaks', label: 'Remove line breaks', sql: ['BREAKS(', 'x', ')'] },
    { id: 'ifblank', label: 'If blank', sql: ['IFBLANK(', 'x', ', ', { key: 'use', label: 'Use' }, ')'] },
    { id: 'ifis', label: 'If it is', sql: ['IF(', 'x', ' = ', { key: 'is', label: 'Is' }, ', ', { key: 'then', label: 'Then' }, ', ', { key: 'else', label: 'Otherwise' }, ')'] },
    { id: 'plus', label: 'Plus', sql: ['(', 'x', ' + ', { key: 'other', label: 'Plus', kind: 'other' }, ')'] },
    { id: 'minus', label: 'Minus', sql: ['(', 'x', ' - ', { key: 'other', label: 'Minus', kind: 'other' }, ')'] },
    { id: 'times', label: 'Times', sql: ['(', 'x', ' * ', { key: 'other', label: 'Times', kind: 'other' }, ')'] },
    { id: 'divide', label: 'Divided by', sql: ['(', 'x', ' / ', { key: 'other', label: 'Divided by', kind: 'other' }, ')'] },
    { id: 'subfrom', label: 'Subtract from', sql: ['(', { key: 'other', label: 'Subtract from', kind: 'other' }, ' - ', 'x', ')'] },
    { id: 'divinto', label: 'Divide into', sql: ['(', { key: 'other', label: 'Divide into', kind: 'other' }, ' / ', 'x', ')'] },
    { id: 'pct', label: '% change from', sql: ['PCT(', 'x', ', ', { key: 'other', label: 'From', kind: 'other' }, ')'] },
    { id: 'round', label: 'Round', sql: ['ROUND(', 'x', ', ', { key: 'places', label: 'Places', number: true, min: 0 }, ')'] },
    { id: 'jointext', label: 'Join text', sql: ['CONCAT(', 'x', ', ', { key: 'between', label: 'Between' }, ', ', { key: 'other', label: 'With', kind: 'other' }, ')'] }
];

/** A value's starting value in the dialog, by key. */
export const COLUMN_FUNCTION_DEFAULTS = { n: 4, from: '-', to: '', use: '', is: '', then: '', else: '', places: 2, between: ' ' };

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

/** One of the first functions on one value, as SQLite does it (unchanged: Compare and Run Batch rely on it). */
function applyOne(v: ColumnValue, f: SqliteFn): ColumnValue {
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

/** The first functions, each written here as SQLite does it; every other one runs on the engine's code. */
type SqliteFn = Extract<ColumnFn, { fn: 'trim' | 'upper' | 'lower' | 'ltrimZeros' | 'text' | 'number' | 'first' | 'last' | 'replace' | 'translate' }>;
const SQLITE_FNS: ReadonlySet<ColumnFnId> = new Set(['trim', 'upper', 'lower', 'ltrimZeros', 'text', 'number', 'first', 'last', 'replace', 'translate']);
const isSqliteFn = (f: ColumnFn): f is SqliteFn => SQLITE_FNS.has(f.fn);

/* ---------- Each function as an engine call ---------- */

/**
 * A function's argument: 'x' (the value coming down the chain), a value, another column of the row
 * (its id, which the screen resolves), a lookup table (its id), or another call.
 */
export type FnArg = 'x' | { value: string | number | null } | { col: string } | { lookup: string } | FnCall;
/** A function as the engine runs it: one of its functions (engine-types.ts FUNCTIONS), around its arguments. */
export interface FnCall { fn: FunctionName; args: FnArg[] }

const call = (fn: FunctionName, ...args: FnArg[]): FnCall => ({ fn, args });
const val = (value: string | number | null): FnArg => ({ value });
/** An `other` step's other side: its column, or its value. */
const other = (f: OtherValue): FnArg => (f.col !== undefined ? { col: f.col } : val(f.value ?? null));

/**
 * A function as an engine call around 'x': the one definition Query's engine (fnExpr walks it) and
 * the in-memory run (applyColumnFns) both use, so a step gives the same value everywhere.
 */
export function columnFnCall(f: ColumnFn): FnCall {
    switch (f.fn) {
        case 'trim': return call('TRIM', 'x');
        case 'upper': return call('UPPER', 'x');
        case 'lower': return call('LOWER', 'x');
        case 'text': return call('TEXT', 'x');
        case 'number': return call('NUMERIC', 'x');
        case 'ltrimZeros': return call('LTRIM', 'x', val('0'));
        case 'first': return call('SUBSTR', 'x', val(1), val(wholeNumber(f.n)));
        case 'last': return call('SUBSTR', 'x', val(-wholeNumber(f.n)));
        case 'replace': return call('REPLACE', 'x', val(f.from), val(f.to));
        case 'translate': return call('TRANSLATE', 'x', { lookup: f.table }, val(f.from), val(f.to));
        case 'breaks': return call('REPLACE', call('REPLACE', call('REPLACE', 'x', val('\r\n'), val(' ')), val('\n'), val(' ')), val('\r'), val(' '));
        case 'ifblank': return call('IFBLANK', 'x', val(f.use));
        case 'ifis': return call('IF', call('=', 'x', val(f.is)), val(f.then), f.else === '' ? 'x' : val(f.else));
        case 'plus': return call('+', 'x', other(f));
        case 'minus': return call('-', 'x', other(f));
        case 'times': return call('*', 'x', other(f));
        case 'divide': return call('/', 'x', other(f));
        case 'subfrom': return call('-', other(f), 'x');
        case 'divinto': return call('/', other(f), 'x');
        case 'pct': return call('*', call('/', call('-', 'x', other(f)), other(f)), val(100));
        case 'round': return call('ROUND', 'x', val(Math.max(0, Math.floor(Number(f.places)) || 0)));
        case 'jointext': return call('CONCAT', 'x', val(f.between), other(f));
    }
}

/**
 * A call as an engine Expr around `x` (Query's engine: fnExpr). `col` gives another column's Expr,
 * `lookup` a lookup table's value (its name in the engine).
 */
export function callExpr(c: FnCall, x: Expr, col: (id: string) => Expr, lookup: (id: string) => Expr): Expr {
    const arg = (a: FnArg): Expr => {
        if (a === 'x') return x;
        if ('fn' in a) return callExpr(a, x, col, lookup);
        if ('col' in a) return col(a.col);
        if ('lookup' in a) return lookup(a.lookup);
        return { value: a.value };
    };
    return { fn: c.fn, args: c.args.map(arg) };
}

/** The ids of the other columns the functions read (a screen loads or offers them). */
export function columnsIn(fns: ColumnFn[] | undefined): string[] {
    return (fns ?? []).flatMap(f => ('col' in f && typeof f.col === 'string' ? [f.col] : []));
}

/** No lookup table in memory: Translate values is left as it is there (see applyOne). */
const NO_TABLES: FunctionContext = { table: () => undefined };

/** A call worked out on one value, by the engine's own functions. `col` gives another column's value of the row. */
function runCall(c: FnCall, x: V, col: (id: string) => unknown): V {
    const arg = (a: FnArg): V => {
        if (a === 'x') return x;
        if ('fn' in a) return runCall(a, x, col);
        if ('col' in a) return fromValue(asColumnValue(col(a.col)));
        if ('lookup' in a) return null;
        return fromValue(a.value);
    };
    return callFunction(c.fn, c.args.map(arg), NO_TABLES);
}

/**
 * A value through the functions, in order. The first functions give what `columnFnSql` gives in
 * SQLite; the others what Query's engine gives (they are its functions). `col` gives another
 * column's value of the same row, for the steps that use one (no `col`: they read blank).
 */
export function applyColumnFns(value: unknown, fns: ColumnFn[] | undefined, col: (id: string) => unknown = () => null): ColumnValue {
    let v = asColumnValue(value);
    for (const f of fns ?? []) {
        if (isSqliteFn(f)) v = applyOne(v, f);
        else {
            const out = toValue(runCall(columnFnCall(f), fromValue(v), col));
            v = typeof out === 'number' && !Number.isFinite(out) ? null : out;
        }
    }
    return v;
}
