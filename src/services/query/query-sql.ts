// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Writes a Query's SQL: SELECT the columns, FROM the first view, one LEFT JOIN or JOIN per other
 * view with its pairs in ON ... AND. The joins live in FROM and the writer never adds a WHERE of
 * its own; a WHERE comes only from outside (a saved search), passed in `where`.
 *
 * Names are written bare when they are plain (inventory.sku) and in double quotes otherwise
 * ("location.city"), so the SQL reads like SQL someone typed. Text is always a quoted literal
 * with its quotes doubled, and a count is always a whole number, so nothing typed into a
 * function can become SQL.
 */
import { CALC_VIEW } from './query-types';
import type { ColumnRef, QueryCalc, QueryFn, QueryJoin, QueryJoinKind, QueryKey, QuerySpec, QueryView } from './query-types';
import { columnFnSql } from '../column-functions/column-functions';
import { formulaSql, parseFormula } from './formula';
import { compareLeftKeys } from './query-compare';
import type { FormulaColumn } from './formula';

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Words SQLite won't take as a bare name. */
const RESERVED = new Set(('abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without').split(' '));

export function isReservedWord(name: string): boolean {
    return RESERVED.has(name.toLowerCase());
}

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
 * Each view's table name: its name in lower case with anything that isn't a letter, digit or _
 * turned to _, and a number added when two views would share one (items, items_2).
 */
export function tableNames(views: QueryView[]): Map<string, string> {
    const names = new Map<string, string>();
    const taken = new Set<string>();
    for (const view of views) {
        let base = view.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
        if (!base) base = 'view';
        if (/^[0-9]/.test(base)) base = `t_${base}`;
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
        taken.add(name);
        names.set(view.id, name);
    }
    return names;
}

/**
 * What the SQL calls each view: its name as it is written when that is the table's own name but
 * for its capitals (Products.sku), else the table's name. A view given a letter goes by it (d.sku).
 */
export function refNames(views: QueryView[]): Map<string, string> {
    const tables = tableNames(views);
    return new Map(views.map(v => {
        const table = tables.get(v.id) ?? '';
        if (v.alias) return [v.id, v.alias.toLowerCase()];
        return [v.id, v.name.toLowerCase() === table ? v.name : table];
    }));
}

/** A view's table as FROM and JOIN write it: `Products`, or `stock AS d` when it has a letter. */
export function tableSql(view: QueryView, tables: Map<string, string>): string {
    const table = tables.get(view.id) ?? '';
    if (view.alias) return `${quoteName(table)} AS ${view.alias.toLowerCase()}`;
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

/** Every column of every view, in the views' order, then the calculated ones. */
export function allColumns(spec: QuerySpec): ColumnRef[] {
    return [
        ...spec.views.flatMap(v => v.columns.map(column => ({ view: v.id, column }))),
        ...(spec.calc ?? []).map(c => ({ view: CALC_VIEW, column: c.name }))
    ];
}

/**
 * The joining view's column in each pair of one column each side, with the column it is matched
 * to. The two are the same thing in every row the join matches (as they are, or once a function
 * has tidied one), so the joining view's is not shown: it would say the same thing twice. Not
 * for a RIGHT or outer join: the joining view's rows that match nothing have their key only there.
 */
export function joinKeyColumns(spec: QuerySpec): { key: ColumnRef; same: ColumnRef }[] {
    const out: { key: ColumnRef; same: ColumnRef }[] = [];
    for (const join of spec.joins) {
        if (join.kind === 'right' || join.kind === 'outer' || join.kind === 'compare') continue;
        for (const pair of join.on) {
            const single = pair.left.parts.length === 1 && pair.right.parts.length === 1;
            if (single) out.push({ key: { view: pair.right.parts[0].view, column: pair.right.parts[0].column }, same: { view: pair.left.parts[0].view, column: pair.left.parts[0].column } });
        }
    }
    return out;
}

/**
 * The columns shown when none are picked: every column, but for a joining view's key (the view
 * it joins has it already), a column whose name an earlier view has shown (two columns of one
 * name are picked by hand) and a column with no value in any row. The calculated ones come last.
 */
export function defaultColumns(spec: QuerySpec): ColumnRef[] {
    const keys = new Set(joinKeyColumns(spec).map(k => `${k.key.view}\n${k.key.column}`));
    const seen = new Set<string>();
    const out: ColumnRef[] = [];
    for (const view of spec.views) {
        for (const column of view.columns) {
            if (keys.has(`${view.id}\n${column}`) || seen.has(column) || view.empty?.includes(column)) continue;
            out.push({ view: view.id, column });
        }
        view.columns.forEach(column => seen.add(column));
    }
    return [...out, ...(spec.calc ?? []).map(c => ({ view: CALC_VIEW, column: c.name }))];
}

const COLUMN_KEY = '\n';

/** The columns a formula can name: each view's, as `@view.column` (a column "address.city" two levels deep). */
export function formulaColumns(spec: QuerySpec): FormulaColumn[] {
    // A run is a level of the path: @Stock.C1.quantityOnHand
    return spec.views.flatMap(v => v.columns.map(column => ({
        key: `${v.id}${COLUMN_KEY}${column}`,
        path: [...(v.run ? [v.runOfName ?? v.name, v.run] : [v.name]), ...column.split('.')]
    })));
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
    if (ref.view !== CALC_VIEW) return [columnSql(ref, names)];
    const calc = spec.calc?.find(c => c.name === ref.column);
    if (!calc) throw new Error(`Query: no calculated column "${ref.column}"`);
    return calcSql(calc, spec, names);
}

export interface WriteSqlOptions {
    /** A WHERE from outside the builder (a saved search), already SQL. */
    where?: string;
    limit?: number;
    offset?: number;
}

const SELECT_WIDTH = 100;

export function writeSql(spec: QuerySpec, options: WriteSqlOptions = {}): string {
    const names = refNames(spec.views);
    const select = (spec.select.length ? spec.select : defaultColumns(spec)).flatMap(c => selectSql(c, spec, names));
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
