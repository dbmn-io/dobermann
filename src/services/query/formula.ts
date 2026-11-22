// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Calculations: the formula a user writes for a calculated column, read into a tree and written
 * as the SQL it runs as.
 *
 * The language is spreadsheet style: function calls (IF, ROUND, CONCAT...), nested anywhere, with
 * + - * / and = <> > < >= <=, text in double quotes (single quotes work too) and numbers. A column
 * is `@` and a path, each dot one level in: the view, then the run when a view has several (BL,
 * C1), then the column, then a key inside it (`@Stock.BL.quantityOnHand`, `@address.city`). The
 * user types the shortest path that is still unique; a path that finds two columns is an error
 * that lists them, even when they differ only in capitals. The full path is what is saved (`fullText`), so a formula keeps its meaning
 * when another view with the same column names is added.
 *
 * Each function is one SQLite expression, so a calculated column is a real column of the query:
 * Results can sort, filter and search it like any other. Rules the SQL keeps: dividing always
 * keeps the decimals and dividing by 0 is blank; a sum with a blank in it is blank; CONCAT
 * treats a blank as nothing; IFBLANK picks the other value for a blank or empty text.
 *
 * COMPARE(a, b, ...) is the one function that is not a value: it makes a compared column (its
 * sides side by side, the differences marked), and goes only around the whole formula.
 */

/** A column a formula can name: `key` is the caller's own (the view and column), `path` its parts. */
export interface FormulaColumn {
    key: string;
    /** The view's name, the run's name when the view has several, then the column's name split at its dots. */
    path: string[];
}

export type FormulaNode =
    | { k: 'num'; v: number }
    | { k: 'str'; v: string }
    | { k: 'ref'; key: string }
    | { k: 'neg'; a: FormulaNode }
    | { k: 'bin'; op: FormulaOp; a: FormulaNode; b: FormulaNode }
    | { k: 'fn'; name: string; args: FormulaNode[] };

export type FormulaOp = '+' | '-' | '*' | '/' | '=' | '<>' | '>' | '<' | '>=' | '<=';

export interface ParsedFormula {
    /** The value it works out; for a COMPARE, its first side. */
    tree: FormulaNode;
    /** COMPARE's sides, each a value (two or more). */
    compare?: FormulaNode[];
    /** The columns it uses, by key, in the order first used. */
    columns: string[];
}

/** What is wrong with a formula, in words, and where (the character it starts at). */
export class FormulaError extends Error {
    constructor(message: string, readonly at: number, readonly choices?: string[]) {
        super(message);
        this.name = 'FormulaError';
    }
}

export interface FormulaFunction {
    name: string;
    group: 'Logic' | 'Numbers' | 'Text' | 'Convert' | 'Compare';
    usage: string;
    says: string;
    example: string;
    min: number;
    /** Most arguments it takes (Infinity: any number). */
    max: number;
}

/** Every function, in the order the builder lists them. */
export const FORMULA_FUNCTIONS: FormulaFunction[] = [
    { name: 'IF', group: 'Logic', usage: 'IF(test, then, else)', says: 'One value or another', example: 'IF(@quantityOnHand > 100, "Plenty", "Low")', min: 2, max: 3 },
    { name: 'IFBLANK', group: 'Logic', usage: 'IFBLANK(value, otherwise)', says: 'The value, or something else when it is blank', example: 'IFBLANK(@qtyOnHand, 0)', min: 2, max: 2 },
    { name: 'AND', group: 'Logic', usage: 'AND(test, test, …)', says: 'Every test is true', example: 'AND(@quantityOnHand > 0, @status = "ACTIVE")', min: 2, max: Infinity },
    { name: 'OR', group: 'Logic', usage: 'OR(test, test, …)', says: 'Any test is true', example: 'OR(@status = "HOLD", @status = "QC")', min: 2, max: Infinity },
    { name: 'NOT', group: 'Logic', usage: 'NOT(test)', says: 'The opposite', example: 'NOT(@status = "HOLD")', min: 1, max: 1 },
    { name: 'ROUND', group: 'Numbers', usage: 'ROUND(number, places)', says: 'To so many decimal places', example: 'ROUND(@price * 1.1, 2)', min: 1, max: 2 },
    { name: 'ABS', group: 'Numbers', usage: 'ABS(number)', says: 'Without its sign: how far apart, either way', example: 'ABS(@qtyOrdered - @qtyAcked)', min: 1, max: 1 },
    { name: 'FLOOR', group: 'Numbers', usage: 'FLOOR(number)', says: 'Down to a whole number', example: 'FLOOR(@quantityOnHand / 12)', min: 1, max: 1 },
    { name: 'CEIL', group: 'Numbers', usage: 'CEIL(number)', says: 'Up to a whole number', example: 'CEIL(@quantityOnHand / 12)', min: 1, max: 1 },
    { name: 'MIN', group: 'Numbers', usage: 'MIN(a, b, …)', says: 'The smallest (blank if any is blank)', example: 'MIN(@qtyOrdered, @qtyAcked)', min: 2, max: Infinity },
    { name: 'MAX', group: 'Numbers', usage: 'MAX(a, b, …)', says: 'The largest (blank if any is blank)', example: 'MAX(@qtyOrdered, @qtyAcked)', min: 2, max: Infinity },
    { name: 'CONCAT', group: 'Text', usage: 'CONCAT(a, b, …)', says: 'Joined together; a blank counts as nothing', example: 'CONCAT(@sku, " · ", @description)', min: 2, max: Infinity },
    { name: 'UPPER', group: 'Text', usage: 'UPPER(text)', says: 'In capitals', example: 'UPPER(@description)', min: 1, max: 1 },
    { name: 'LOWER', group: 'Text', usage: 'LOWER(text)', says: 'In small letters', example: 'LOWER(@status)', min: 1, max: 1 },
    { name: 'TRIM', group: 'Text', usage: 'TRIM(text)', says: 'Without spaces at either end', example: 'TRIM(@description)', min: 1, max: 1 },
    { name: 'LEFT', group: 'Text', usage: 'LEFT(text, count)', says: 'The first so many characters', example: 'LEFT(@sku, 4)', min: 2, max: 2 },
    { name: 'RIGHT', group: 'Text', usage: 'RIGHT(text, count)', says: 'The last so many characters', example: 'RIGHT(@sku, 3)', min: 2, max: 2 },
    { name: 'SUBSTR', group: 'Text', usage: 'SUBSTR(text, start, count)', says: 'From a place, counting from 1', example: 'SUBSTR(@sku, 6, 3)', min: 2, max: 3 },
    { name: 'REPLACE', group: 'Text', usage: 'REPLACE(text, this, that)', says: 'One piece swapped for another', example: 'REPLACE(@description, ",", "")', min: 3, max: 3 },
    { name: 'LENGTH', group: 'Text', usage: 'LENGTH(text)', says: 'How many characters', example: 'LENGTH(@sku)', min: 1, max: 1 },
    { name: 'NUMBER', group: 'Convert', usage: 'NUMBER(value)', says: 'As a number ("0042" is 42); blank if it isn’t one', example: 'NUMBER(@code)', min: 1, max: 1 },
    { name: 'TEXT', group: 'Convert', usage: 'TEXT(value)', says: 'As text', example: 'TEXT(@quantityOnHand)', min: 1, max: 1 },
    { name: 'COMPARE', group: 'Compare', usage: 'COMPARE(a, b, …)', says: 'A compared column: the values side by side, the differences marked', example: 'COMPARE(@quantityOnHand, @quantityAvailable)', min: 2, max: 4 }
];
const FN = new Map(FORMULA_FUNCTIONS.map(f => [f.name, f]));

// ---- Pieces ----

export type FormulaToken =
    | { t: 'ws' | 'op' | 'bad'; s: string; at: number }
    | { t: 'num'; s: string; at: number; v: number }
    | { t: 'str'; s: string; at: number; v: string; open: boolean }
    | { t: 'word'; s: string; at: number; u: string }
    | { t: 'ref'; s: string; at: number; parts: string[] };

const PART = /^(?:"(?:[^"]|"")*"?|[A-Za-z0-9_]*)/;

/** The pieces of a formula, each with where it starts: what the builder colours, and what the parser reads. */
export function formulaTokens(src: string): FormulaToken[] {
    const out: FormulaToken[] = [];
    let i = 0;
    while (i < src.length) {
        const rest = src.slice(i);
        let m: RegExpExecArray | null;
        let tok: FormulaToken;
        if ((m = /^\s+/.exec(rest))) tok = { t: 'ws', s: m[0], at: i };
        else if (rest[0] === '@') {
            // @ then parts joined by dots, each a plain name or "a name" (its "" a quote)
            let j = 1;
            const parts: string[] = [];
            for (;;) {
                const pm = PART.exec(rest.slice(j));
                const raw = pm ? pm[0] : '';
                parts.push(raw.startsWith('"') ? raw.replace(/^"|"$/g, '').replace(/""/g, '"') : raw);
                j += raw.length;
                if (rest[j] === '.') { j++; continue; }
                break;
            }
            tok = { t: 'ref', s: rest.slice(0, j), at: i, parts };
        } else if (rest[0] === '"' || rest[0] === "'") {
            const q = rest[0];
            let j = 1;
            let v = '';
            let open = true;
            while (j < rest.length) {
                if (rest[j] === q) {
                    if (rest[j + 1] === q) { v += q; j += 2; continue; }
                    j++; open = false; break;
                }
                v += rest[j++];
            }
            tok = { t: 'str', s: rest.slice(0, j), at: i, v, open };
        } else if ((m = /^\d+(\.\d+)?/.exec(rest)) || (m = /^\.\d+/.exec(rest))) tok = { t: 'num', s: m[0], at: i, v: Number(m[0]) };
        else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) tok = { t: 'word', s: m[0], at: i, u: m[0].toUpperCase() };
        else if ((m = /^(<>|!=|>=|<=|[=<>+\-*/(),])/.exec(rest))) tok = { t: 'op', s: m[0], at: i };
        else tok = { t: 'bad', s: rest[0], at: i };
        out.push(tok);
        i += tok.s.length;
    }
    return out;
}

// ---- Columns by path ----

const lower = (s: string): string => s.toLowerCase();

/** A typed path's parts, a part with dots in it split there (a quoted "address.city" is two levels). */
function typedParts(parts: string[]): string[] {
    return parts.flatMap(p => p.split('.'));
}

/**
 * The columns a typed path finds: its parts in order among the column's path, the last one the
 * column's own last part. Case does not matter: `@sku` finds both Stock's sku and a file's SKU,
 * and the user picks one (two systems often spell one field with different capitals, so a
 * column is never chosen by its capitals alone).
 */
export function resolvePath(parts: string[], columns: FormulaColumn[]): FormulaColumn[] {
    const want = typedParts(parts).map(lower);
    if (!want.length || want[want.length - 1] === '') return [];
    return columns.filter(col => {
        const path = col.path.map(lower);
        if (path[path.length - 1] !== want[want.length - 1]) return false;
        let i = 0;
        for (const part of path.slice(0, -1)) if (i < want.length - 1 && part === want[i]) i++;
        return i === want.length - 1;
    });
}

const PLAIN_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
const partText = (p: string): string => (PLAIN_PART.test(p) ? p : `"${p.replace(/"/g, '""')}"`);

/** A column's whole path, as saved: `@Stock.BL.quantityOnHand`, `@Counts."Qty Counted"`. */
export function fullRef(col: FormulaColumn): string {
    return `@${col.path.map(partText).join('.')}`;
}

/** Every way to pick `size` of `items`, keeping their order. */
function picks<T>(items: T[], size: number): T[][] {
    if (!size) return [[]];
    const out: T[][] = [];
    items.forEach((item, i) => picks(items.slice(i + 1), size - 1).forEach(rest => out.push([item, ...rest])));
    return out;
}

/**
 * The shortest way to write a column that finds it alone: its name, else its name with one part
 * of its path before it (the nearest first: the run before the view), else more, else all of it.
 */
export function shortRef(col: FormulaColumn, columns: FormulaColumn[]): string {
    const last = col.path[col.path.length - 1];
    const before = col.path.slice(0, -1).map((part, at) => ({ part, at }));
    for (let size = 0; size <= before.length; size++) {
        const nearestFirst = picks(before, size).sort((x, y) => y.reduce((n, p) => n + p.at, 0) - x.reduce((n, p) => n + p.at, 0));
        for (const choice of nearestFirst) {
            const parts = [...choice.map(p => p.part), last];
            const found = resolvePath(parts, columns);
            if (found.length === 1 && found[0].key === col.key) return `@${parts.map(partText).join('.')}`;
        }
    }
    return fullRef(col);
}

/** Rewrites every column of a formula with `write`; a column it can't find is left as typed. */
function rewriteRefs(src: string, columns: FormulaColumn[], write: (col: FormulaColumn) => string): string {
    return formulaTokens(src).map(t => {
        if (t.t !== 'ref') return t.s;
        const found = resolvePath(t.parts, columns);
        return found.length === 1 ? write(found[0]) : t.s;
    }).join('');
}

/** The formula with every column as its whole path: what is saved. */
export function fullText(src: string, columns: FormulaColumn[]): string {
    return rewriteRefs(src, columns, fullRef);
}

/** The formula with every column as short as it can be: what the user reads. */
export function shortText(src: string, columns: FormulaColumn[]): string {
    return rewriteRefs(src, columns, col => shortRef(col, columns));
}

// ---- Reading ----

const COMPARISONS = new Set(['=', '<>', '!=', '>', '<', '>=', '<=']);

function takes(f: FormulaFunction): string {
    if (f.min === f.max) return `${f.min}`;
    if (f.max === Infinity) return `${f.min} or more`;
    return `${f.min} to ${f.max}`;
}

/** Reads a formula, or throws a FormulaError saying what is wrong and where. */
export function parseFormula(src: string, columns: FormulaColumn[]): ParsedFormula {
    const tk = formulaTokens(src).filter(t => t.t !== 'ws');
    const used: string[] = [];
    let i = 0;
    const end = src.length;
    const fail = (message: string, at: number, choices?: string[]): never => { throw new FormulaError(message, at, choices); };
    const isOp = (s: string): boolean => { const t = tk[i]; return !!t && t.t === 'op' && t.s === s; };
    let compareAt = -1;

    function primary(depth: number): FormulaNode {
        const t = tk[i];
        if (!t) return fail('It ends too soon', end);
        switch (t.t) {
            case 'bad': return fail(`Can’t read “${t.s}”`, t.at);
            case 'num': i++; return { k: 'num', v: t.v };
            case 'str':
                if (t.open) return fail('Some text has no closing quote', t.at);
                i++; return { k: 'str', v: t.v };
            case 'ref': {
                i++;
                if (!t.parts.length || t.parts[t.parts.length - 1] === '') return fail('Pick a column after @', t.at);
                const found = resolvePath(t.parts, columns);
                if (!found.length) return fail(`There is no column ${t.s}`, t.at);
                if (found.length > 1) return fail(`${t.s} is more than one column: pick one`, t.at, found.map(fullRef));
                if (!used.includes(found[0].key)) used.push(found[0].key);
                return { k: 'ref', key: found[0].key };
            }
            case 'op':
                if (t.s === '(') {
                    i++;
                    const v = comparison(depth + 1);
                    if (!isOp(')')) return fail('A bracket is not closed', t.at);
                    i++;
                    return v;
                }
                if (t.s === '-') { i++; return { k: 'neg', a: primary(depth) }; }
                return fail(`Didn’t expect “${t.s}” here`, t.at);
            case 'word': {
                const f = FN.get(t.u);
                if (!f) return fail(`There is no function called ${t.s}`, t.at);
                i++;
                if (!isOp('(')) return fail(`${t.u} needs ( after it`, t.at);
                i++;
                const args: FormulaNode[] = [];
                if (!isOp(')')) {
                    for (;;) {
                        args.push(comparison(depth + 1));
                        if (isOp(',')) { i++; continue; }
                        break;
                    }
                }
                if (!isOp(')')) return fail(`${t.u}( is not closed`, t.at);
                i++;
                if (args.length < f.min || args.length > f.max) return fail(`${t.u} takes ${takes(f)}: ${f.usage}`, t.at);
                if (t.u === 'COMPARE') {
                    if (depth > 0 || compareAt >= 0) return fail('COMPARE goes on its own, around the whole calculation', t.at);
                    compareAt = t.at;
                }
                return { k: 'fn', name: t.u, args };
            }
        }
        return fail('It ends too soon', end);
    }
    function product(depth: number): FormulaNode {
        let a = primary(depth);
        while (isOp('*') || isOp('/')) {
            const op = tk[i++].s as FormulaOp;
            a = { k: 'bin', op, a, b: primary(depth) };
        }
        return a;
    }
    function sum(depth: number): FormulaNode {
        let a = product(depth);
        while (isOp('+') || isOp('-')) {
            const op = tk[i++].s as FormulaOp;
            a = { k: 'bin', op, a, b: product(depth) };
        }
        return a;
    }
    function comparison(depth: number): FormulaNode {
        const a = sum(depth);
        const t = tk[i];
        if (t && t.t === 'op' && COMPARISONS.has(t.s)) {
            i++;
            const op = (t.s === '!=' ? '<>' : t.s) as FormulaOp;
            return { k: 'bin', op, a, b: sum(depth) };
        }
        return a;
    }

    if (!tk.length) fail('Type a calculation', 0);
    const tree = comparison(0);
    if (i < tk.length) fail(`Didn’t expect “${tk[i].s}” here`, tk[i].at);
    if (tree.k === 'fn' && tree.name === 'COMPARE') return { tree: tree.args[0], compare: tree.args, columns: used };
    if (compareAt >= 0) fail('COMPARE goes on its own, around the whole calculation', compareAt);
    return { tree, columns: used };
}

