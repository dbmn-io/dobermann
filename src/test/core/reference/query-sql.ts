// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The engine's tests' reference (since 2026-11-23, when Query stopped running SQL): the SQL a
 * query's steps write, run in SQLite by query-engine.ts here, to check the engine against.
 * Writes a Query's SQL: SELECT the columns, FROM the first view, one LEFT JOIN or JOIN per other
 * view with its pairs in ON ... AND. The joins live in FROM and the writer never adds a WHERE of
 * its own; a WHERE comes only from outside (a saved search), passed in `where`.
 *
 * Names are written bare when they are plain (inventory.sku) and in double quotes otherwise
 * ("location.city"), so the SQL reads like SQL someone typed. Text is always a quoted literal
 * with its quotes doubled, and a count is always a whole number, so nothing typed into a
 * function can become SQL.
 */
import { CALC_VIEW } from '../../../services/query/query-types';
import type { ColumnRef, QueryCalc, QueryFn, QueryJoin, QueryJoinKind, QueryKey, QuerySpec, QueryView } from '../../../services/query/query-types';
import { COLUMN_KEY, RESERVED, defaultColumns, formulaColumns, tableNames } from '../../../services/query/query-columns';
import { parseFormula, type FormulaNode } from '../../../services/query/formula';
import { compareLeftKeys } from '../../../services/query/query-compare';
import type { ColumnFn } from '../../../services/column-functions/column-functions';
// (the column helpers the app keeps, for tests that read both from here)
export { allColumns, defaultColumns, formulaColumns, isReservedWord, joinKeyColumns, lookupsUsed, resultColumns, tableNames } from '../../../services/query/query-columns';

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;


export function quoteName(name: string): string {
    return PLAIN.test(name) && !RESERVED.has(name.toLowerCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function quoteText(text: string): string {
    return `'${String(text).replace(/'/g, "''")}'`;
}

function wholeNumber(n: number): number {
    const whole = Math.floor(Number(n));
    return Number.isFinite(whole) && whole > 0 ? whole : 1;
}


/**
 * What the SQL calls each view: its name as it is written when that is the table's own name but
 * for its capitals (Products.sku), else the table's name.
 */
export function refNames(views: QueryView[]): Map<string, string> {
    const tables = tableNames(views);
    return new Map(views.map(v => {
        const table = tables.get(v.id) ?? '';
        return [v.id, v.name.toLowerCase() === table ? v.name : table];
    }));
}

/** A view's table as FROM and JOIN write it: `Products`. */
export function tableSql(view: QueryView, tables: Map<string, string>): string {
    const table = tables.get(view.id) ?? '';
    return quoteName(view.name.toLowerCase() === table ? view.name : table);
}

function applyFns(sql: string, fns: QueryFn[] | undefined): string {
    return columnFnSql(sql, fns);
}

/** `names`: what the SQL calls each view (refNames). */
export function columnSql(ref: ColumnRef, names: Map<string, string>): string {
    const table = names.get(ref.view);
    if (!table) throw new Error(`Query: no view "${ref.view}"`);
    return applyFns(`${quoteName(table)}.${quoteName(ref.column)}`, ref.fns);
}

export function keySql(key: QueryKey, tables: Map<string, string>): string {
    if (!key.parts.length) throw new Error('Query: a join pair needs a column on each side');
    const parts = key.parts.map(p => columnSql(p, tables));
    const joined = parts.length === 1 ? parts[0] : parts.join(key.separator ? ` || ${quoteText(key.separator)} || ` : ' || ');
    return applyFns(joined, key.fns);
}

/**
 * The left side of pair `pair` of join `index` as SQL: its own left side, or for a Compare join
 * the key of whichever view in the compare so far has the record (query-compare.ts).
 */
export function leftKeySql(spec: QuerySpec, index: number, pair: number, names: Map<string, string>): string {
    const keys = compareLeftKeys(spec.joins, index, pair).map(k => keySql(k, names));
    return keys.length > 1 ? `COALESCE(${keys.join(', ')})` : keys[0] ?? '';
}

function onSql(spec: QuerySpec, index: number, tables: Map<string, string>, indent: string): string {
    const join = spec.joins[index];
    if (!join.on.length) throw new Error('Query: a join needs at least one pair');
    return join.on.map((pair, p) => `${keySql(pair.right, tables)} = ${leftKeySql(spec, index, p, tables)}`).join(`\n${indent}AND `);
}

const JOIN_SQL: Record<QueryJoinKind, string> = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', outer: 'FULL OUTER JOIN', compare: 'FULL OUTER JOIN' };

/** FROM and its joins, up to (not including) join number `upTo` (all of them when left out). */
export function fromSql(spec: QuerySpec, upTo?: number): string {
    const tables = tableNames(spec.views);
    const names = refNames(spec.views);
    const first = spec.views[0];
    if (!first) throw new Error('Query: no views');
    const joins = spec.joins.slice(0, upTo ?? spec.joins.length);
    const heads = joins.map(j => {
        const view = spec.views.find(v => v.id === j.view);
        if (!view) throw new Error(`Query: no view "${j.view}"`);
        return `${JOIN_SQL[j.kind] ?? 'JOIN'} ${tableSql(view, tables)}`;
    });
    const width = Math.max(0, ...heads.map(h => h.length));
    const lines = [`FROM ${tableSql(first, tables)}`];
    joins.forEach((join, i) => {
        const indent = ' '.repeat(2 + width + 1);
        lines.push(`  ${heads[i].padEnd(width)} ON ${onSql(spec, i, names, indent)}`);
    });
    return lines.join('\n');
}






/**
 * A calculated column's SQL: its formula's (formula.ts), or its SQL as it was typed. A COMPARE
 * formula is several columns, one per side, named `name 1`, `name 2`...
 */
export function calcSql(calc: QueryCalc, spec: QuerySpec, names: Map<string, string>): string[] {
    if (!calc.formula) return [`(${calc.expr}) AS ${quoteName(calc.name)}`];
    const parsed = parseFormula(calc.formula, formulaColumns(spec));
    const column = (key: string): string => {
        const at = key.indexOf(COLUMN_KEY);
        return columnSql({ view: key.slice(0, at), column: key.slice(at + 1) }, names);
    };
    if (parsed.compare) return parsed.compare.map((side, i) => `${formulaSql(side, column)} AS ${quoteName(`${calc.name} ${i + 1}`)}`);
    return [`${formulaSql(parsed.tree, column)} AS ${quoteName(calc.name)}`];
}

/** One column of SELECT (or several, for a COMPARE): a view's column, or a calculated one as `its SQL AS its name`. */
function selectSql(ref: ColumnRef, spec: QuerySpec, names: Map<string, string>): string[] {
    if (ref.view !== CALC_VIEW) return [compareKeyColumnSql(ref, spec, names) ?? columnSql(ref, names)];
    const calc = spec.calc?.find(c => c.name === ref.column);
    if (!calc) throw new Error(`Query: no calculated column "${ref.column}"`);
    return calcSql(calc, spec, names);
}

/**
 * A compare's key column, as Compare shows it: one column, the key of whichever view in the
 * compare has the record (COALESCE(BL.gtin, C1.gtin, ...)), so a record only C1 has still shows
 * its key. Undefined for any other column, or a key column with functions of its own.
 */
export function compareKeyColumnSql(ref: ColumnRef, spec: QuerySpec, names: Map<string, string>): string | undefined {
    if (ref.fns?.length) return undefined;
    const joins = spec.joins.filter(j => j.kind === 'compare');
    const first = joins[0];
    if (!first || joins.length < 1) return undefined;
    const pair = first.on.findIndex(p => p.left.parts.length === 1 && !p.left.fns?.length && p.left.parts[0].view === ref.view && p.left.parts[0].column === ref.column && !p.left.parts[0].fns?.length);
    if (pair < 0) return undefined;
    const others = joins.map(j => j.on[pair]?.right).filter((k): k is QueryKey => !!k && k.parts.length > 0 && k.parts.every(x => !!x.column) && k.parts.every(x => names.has(x.view)));
    if (!others.length) return undefined;
    return `COALESCE(${[columnSql(ref, names), ...others.map(k => keySql(k, names))].join(', ')})`;
}



/**
 * What a row's status needs that Results may not show: each view of the compare's key in the row
 * (blank: it hasn't the record), the Baseline first. `sql` reads it in the query; `own` reads it
 * from the view's table alone (the record window's).
 */
export function compareKeySql(spec: QuerySpec): { view: string; sql: string }[] {
    const joins = spec.joins.filter(j => j.kind === 'compare');
    const first = joins[0];
    if (!first?.on[0]) return [];
    const names = refNames(spec.views);
    const baseline = first.on[0].left;
    return [
        { view: baseline.parts[0]?.view ?? '', sql: keySql(baseline, names) },
        ...joins.filter(j => j.on[0]).map(j => ({ view: j.view, sql: keySql(j.on[0].right, names) }))
    ];
}

export interface WriteSqlOptions {
    /** A WHERE from outside the builder (a saved search), already SQL. */
    where?: string;
    /** More expressions after the columns (what a row's status needs, not shown). */
    extra?: string[];
    limit?: number;
    offset?: number;
}

const SELECT_WIDTH = 100;

export function writeSql(spec: QuerySpec, options: WriteSqlOptions = {}): string {
    const names = refNames(spec.views);
    const select = [...(spec.select.length ? spec.select : defaultColumns(spec)).flatMap(c => selectSql(c, spec, names)), ...(options.extra ?? [])];
    if (!select.length) throw new Error('Query: no columns');
    // The columns wrap under the first one, a line of about a hundred characters each
    const head = `SELECT ${spec.distinct ? 'DISTINCT ' : ''}`;
    const rows: string[] = [];
    for (const column of select) {
        const last = rows[rows.length - 1];
        if (last !== undefined && head.length + last.length + column.length + 2 <= SELECT_WIDTH) rows[rows.length - 1] = `${last}, ${column}`;
        else rows.push(column);
    }
    const lines = [head + rows.join(`,\n${' '.repeat(head.length)}`), fromSql(spec)];
    if (options.where?.trim()) lines.push(`WHERE ${options.where.trim()}`);
    if (options.limit !== undefined) lines.push(`LIMIT ${wholeNumber(options.limit)}${options.offset ? ` OFFSET ${wholeNumber(options.offset)}` : ''}`);
    return lines.join('\n');
}

// ---- The column functions and formulas as SQL (from column-functions.ts and formula.ts) ----


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
            // Remove line breaks (column-functions.ts columnFnCall): \r\n, then \n, then \r, each a space
            case 'breaks': out = `REPLACE(REPLACE(REPLACE(${out}, char(13) || char(10), ' '), char(10), ' '), char(13), ' ')`; break;
            case 'translate': {
                const col = (id: string): string => `"${String(id).replace(/"/g, '""')}"`;
                out = `COALESCE((SELECT ${col(f.to)} FROM ${lookupTableSql(f.table)} WHERE ${col(f.from)} = CAST(${out} AS TEXT) LIMIT 1), ${out})`;
                break;
            }
        }
    }
    return out;
}

/** A lookup table's name where a query runs: loaded under it before the query reads it (query-engine.ts loadLookup). */
export function lookupTableSql(id: string): string {
    return `"__lookup_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}"`;
}

/** Whole numbers as written; anything else as SQLite reads a decimal. */
function numberSql(v: number): string {
    return Number.isFinite(v) ? String(v) : 'NULL';
}

/** A value's SQL; `column(key)` writes a column's own SQL. */
export function formulaSql(node: FormulaNode, column: (key: string) => string): string {
    const go = (n: FormulaNode): string => formulaSql(n, column);
    switch (node.k) {
        case 'num': return numberSql(node.v);
        case 'str': return quoteText(node.v);
        case 'ref': return column(node.key);
        case 'neg': return `-(${go(node.a)})`;
        case 'bin':
            // Dividing keeps the decimals (7 / 2 is 3.5) and dividing by 0 is blank
            if (node.op === '/') return `(${go(node.a)} * 1.0 / NULLIF(${go(node.b)}, 0))`;
            return `(${go(node.a)} ${node.op} ${go(node.b)})`;
        case 'fn': {
            const a = node.args.map(go);
            switch (node.name) {
                case 'IF': return `CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2] ?? 'NULL'} END`;
                case 'IFBLANK': return `COALESCE(NULLIF(${a[0]}, ''), ${a[1]})`;
                case 'AND': return `(${a.join(' AND ')})`;
                case 'OR': return `(${a.join(' OR ')})`;
                case 'NOT': return `(NOT ${a[0]})`;
                case 'ROUND': return `ROUND(${a[0]}, ${a[1] ?? '0'})`;
                // SQLite has no FLOOR or CEIL of its own: the whole number, one less (or more) when it was cut the other way
                case 'FLOOR': return `(CAST(${a[0]} AS INTEGER) - (${a[0]} < CAST(${a[0]} AS INTEGER)))`;
                case 'CEIL': return `(CAST(${a[0]} AS INTEGER) + (${a[0]} > CAST(${a[0]} AS INTEGER)))`;
                case 'CONCAT': return `(${a.map(x => `COALESCE(${x}, '')`).join(' || ')})`;
                case 'LEFT': return `SUBSTR(${a[0]}, 1, ${a[1]})`;
                case 'RIGHT': return `CASE WHEN ${a[1]} > 0 THEN SUBSTR(${a[0]}, -(${a[1]})) ELSE '' END`;
                // A number as it is; text that is a plain number (" 0042 ", "1.5", "-3e2") as that number; anything else blank
                case 'NUMBER': return `CASE WHEN typeof(${a[0]}) IN ('integer', 'real') THEN ${a[0]} WHEN TRIM(${a[0]}) GLOB '*[0-9]*' AND TRIM(${a[0]}) NOT GLOB '*[^0-9.eE+-]*' THEN CAST(TRIM(${a[0]}) AS NUMERIC) END`;
                case 'TEXT': return `CAST(${a[0]} AS TEXT)`;
                case 'COMPARE': throw new Error('Formula: COMPARE has no single value; write each side');
                default: return `${node.name}(${a.join(', ')})`;
            }
        }
    }
}
