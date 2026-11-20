// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query: a report that joins any number of views into one flat table, the way SQL does.
 *
 * A view is what the Console shows of a result (its columns, one row per item of its row basis),
 * so it is already a flat table. A Query names its views, says how each one after the first
 * joins to the views before it, and picks the columns to show. The clicks write SQL
 * (query-sql.ts) and SQLite runs it (query-engine.ts): what the user reads is what runs.
 */
import type { ColumnFn } from '../column-functions/column-functions';

/** A view in the query: `name` is what the user sees and the table's name in the SQL. */
export interface QueryView {
    id: string;
    name: string;
    /** Its letter: the SQL's alias for it (FROM stock AS d ... d.sku). Without one the SQL uses the table's name. */
    alias?: string;
    columns: string[];
    /** Its columns with no value in any row: left out of the columns shown until they are picked. */
    empty?: string[];
}

/**
 * Tidies a column before it joins, for keys from different systems: the functions Query, Compare
 * and Run Batch share (src/services/column-functions), each a standard SQLite function, applied
 * in order, the first innermost.
 */
export type QueryFn = ColumnFn;

/** One column of one view, tidied by `fns` if any. */
export interface ColumnRef {
    view: string;
    column: string;
    fns?: QueryFn[];
}

/**
 * One side of an ON pair: a column, or several joined end to end with `separator` between them
 * (a key one system keeps in two columns). `fns` tidy the joined text as a whole.
 */
export interface QueryKey {
    parts: ColumnRef[];
    separator?: string;
    fns?: QueryFn[];
}

/** `left = right`. The right side is the joining view's; the left may name any earlier view. */
export interface QueryPair {
    left: QueryKey;
    right: QueryKey;
}

/** LEFT JOIN keeps every row so far, matched or not; an inner JOIN keeps only rows that match. */
export type QueryJoinKind = 'left' | 'inner';

export interface QueryJoin {
    view: string;
    kind: QueryJoinKind;
    on: QueryPair[];
}

/**
 * A calculated column: a name and what it works out. `formula` is the builder's language
 * (formula.ts), every column as its whole path (@Stock.quantityOnHand); `expr` is SQL over the
 * views' columns, each by its view's letter (a.quantityOnHand - b.reorderPoint), as calculated
 * columns were written before the builder: it runs as it is. In `select` it is `{ view: '', column: name }`.
 */
export interface QueryCalc {
    name: string;
    expr: string;
    formula?: string;
}

/** The `view` of a ColumnRef that names a calculated column. */
export const CALC_VIEW = '';

export interface QuerySpec {
    /** The first is FROM; each other one has a join, in this order. */
    views: QueryView[];
    joins: QueryJoin[];
    /** The columns shown, in order, from any view. Empty: every column of every view. */
    select: ColumnRef[];
    distinct?: boolean;
    calc?: QueryCalc[];
}

/** How the key values of a join meet, in Compare's words: left is the table so far, right the joining view. */
export type QueryRelationship = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany' | 'none';

/** A value the join is made on, and how many rows (left) and records of the joining view (right) hold it: 0 is none. */
export interface QueryValue {
    key: unknown[];
    left: number;
    right: number;
}

export interface QueryJoinStats {
    /** Rows before this join, and how many of them find a match. */
    leftRows: number;
    leftMatched: number;
    /** The joining view's records, and how many of them match something. */
    rightRows: number;
    rightMatched: number;
    /** Rows once this join is made (a LEFT JOIN keeps the unmatched left rows). */
    rowsAfter: number;
    relationship: QueryRelationship;
    /** Key values by how they meet. */
    keys: { oneToOne: number; oneToMany: number; manyToOne: number; manyToMany: number };
    /** A pair whose sides share no type (numbers one side, text the other): they can never match as they are. */
    typeMismatch: boolean;
    /** Rows (left) and the joining view's records (right) on the values of each kind. */
    rows: { oneToOne: number; oneToMany: number; manyToOne: number; manyToMany: number };
    records: { oneToOne: number; oneToMany: number; manyToOne: number; manyToMany: number };
    /** Rows with nothing to join on (a NULL in the key): they match nothing. */
    leftBlank: number;
    /** How many different values each side joins on (a NULL is not one). */
    leftValues: number;
    rightValues: number;
    /** The values joined on, a few of each kind: no match first, then not used, then held more than once by the joining view, then the rest. */
    values: QueryValue[];
    /** How many values there are in all. */
    valuesTotal: number;
}

export interface QueryRows {
    columns: string[];
    rows: unknown[][];
}
