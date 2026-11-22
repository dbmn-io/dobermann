// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A Query's columns, as the engine and the screen need them: every column, the joining views'
 * keys (shown once), the columns shown when none are picked, the columns a formula can name,
 * Results' columns (a COMPARE calculation a column per side), the lookup tables its functions
 * read, and each view's table name. (Until 2026-11-23 these sat with the SQL writer, query-sql.ts;
 * Query no longer runs SQL, and that writer is the engine's tests' reference now, under
 * src/test/core/reference.)
 */
import { CALC_VIEW } from './query-types';
import type { ColumnRef, QuerySpec, QueryView } from './query-types';
import { lookupsIn } from '../column-functions/column-functions';
import { parseFormula } from './formula';
import type { FormulaColumn } from './formula';

/** Words SQLite won't take as a bare name. */
export const RESERVED = new Set(('abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without').split(' '));

export function isReservedWord(name: string): boolean {
    return RESERVED.has(name.toLowerCase());
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
 * The columns shown when none are picked: in a compare, its key (what is compared is picked);
 * else every column, but for a joining view's key (the view it joins has it already), a column whose name an earlier view has shown (two columns of one
 * name are picked by hand) and a column with no value in any row. The calculated ones come last.
 */
export function defaultColumns(spec: QuerySpec): ColumnRef[] {
    // A compare starts with its key only: what is compared is picked (Columns), nothing comes up on its own
    const compare = spec.joins.find(j => j.kind === 'compare');
    if (compare) {
        const key = compare.on.flatMap(p => p.left.parts).filter(p => spec.views.some(v => v.id === p.view && v.columns.includes(p.column))).map(p => ({ view: p.view, column: p.column }));
        if (key.length) return [...key, ...(spec.calc ?? []).map(c => ({ view: CALC_VIEW, column: c.name }))];
    }
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

export const COLUMN_KEY = '\n';

/** The columns a formula can name: each view's, as `@view.column` (a column "address.city" two levels deep). */
export function formulaColumns(spec: QuerySpec): FormulaColumn[] {
    // A run is a level of the path: @Stock.C1.quantityOnHand
    return spec.views.flatMap(v => v.columns.map(column => ({
        key: `${v.id}${COLUMN_KEY}${column}`,
        path: [...(v.run ? [v.runOfName ?? v.name, v.run] : [v.name]), ...column.split('.')]
    })));
}

/** The lookup tables a query's functions read (Translate values), in its joins and its columns. */
export function lookupsUsed(spec: QuerySpec): string[] {
    const keys = spec.joins.flatMap(j => j.on.flatMap(p => [p.left, p.right]));
    const fns = [...keys.flatMap(k => [...(k.fns ?? []), ...k.parts.flatMap(p => p.fns ?? [])]), ...spec.select.flatMap(c => c.fns ?? [])];
    return [...new Set(lookupsIn(fns))];
}

/**
 * Results' columns, one per column of the SQL: the report's columns (or the default ones), a
 * COMPARE calculation as a column per side, `name 1`, `name 2`..., grouped under its name.
 */
export function resultColumns(spec: QuerySpec): ColumnRef[] {
    const base = spec.select.length ? spec.select : defaultColumns(spec);
    return base.flatMap(c => {
        if (c.view !== CALC_VIEW) return [c];
        const calc = spec.calc?.find(x => x.name === c.column);
        if (!calc?.formula) return [c];
        try {
            const parsed = parseFormula(calc.formula, formulaColumns(spec));
            if (parsed.compare) return parsed.compare.map((_, i) => ({ view: CALC_VIEW, column: `${calc.name} ${i + 1}`, group: calc.name }));
        } catch { /* a formula that no longer reads: the column says so when the SQL is written */ }
        return [c];
    });
}

/** Each view of the compare, the Baseline first: the places a row's status names. Empty when nothing is compared. */
export function compareKeyViews(spec: QuerySpec): string[] {
    const joins = spec.joins.filter(j => j.kind === 'compare');
    const first = joins[0];
    if (!first?.on[0]) return [];
    return [first.on[0].left.parts[0]?.view ?? '', ...joins.filter(j => j.on[0]).map(j => j.view)];
}
