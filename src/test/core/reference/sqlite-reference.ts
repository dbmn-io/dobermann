// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The SQLite side of Query's reference tests: the expected rows for a join, its key functions
 * and a calculation, worked out by SQLite (sql.js), which the app has trusted until now. The
 * engine's answer for the same tables and query must match these rows. Owned by the tester.
 *
 * SQLite is the reference for joins, functions and calculations only. A compare with keys that
 * repeat follows the old Compare's rule, not SQL: those tests live apart.
 */
import type { Database, SqlJsStatic } from 'sql.js';
import type { Table, Value } from './generator';
import { valueSql } from '../../../services/query/query-engine';

export type JoinKind = 'inner' | 'left' | 'right' | 'outer';
/** A function on a key column before it is matched (the Functions dialog's, by name). */
export type KeyFn = 'trim' | 'upper' | 'lower' | 'text' | 'number' | 'ltrimZeros';

export interface KeyPart { left: string; right: string; leftFns?: KeyFn[]; rightFns?: KeyFn[] }

export interface JoinCase {
    kind: JoinKind;
    on: KeyPart[];
    /** Columns out, as table.column; all of both tables when left out. */
    select?: string[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A column with its functions, as SQL. */
export function withFns(column: string, fns: KeyFn[] = []): string {
    return fns.reduce((sql, fn) => {
        switch (fn) {
            case 'trim': return `TRIM(${sql})`;
            case 'upper': return `UPPER(${sql})`;
            case 'lower': return `LOWER(${sql})`;
            case 'text': return `CAST(${sql} AS TEXT)`;
            case 'number': return `CAST(${sql} AS NUMERIC)`;
            case 'ltrimZeros': return `LTRIM(${sql}, '0')`;
        }
    }, column);
}

/** A value as today's Query loads it (query-engine.ts toSql): true/false as the text "true"/"false". */
function bind(v: Value): string | number | null {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return v;
}

/** The tables, loaded into a fresh in-memory database, every column untyped (as Query loads). */
export function load(SQL: SqlJsStatic, tables: Table[]): Database {
    const db = new SQL.Database();
    for (const t of tables) {
        db.run(`CREATE TABLE ${q(t.name)} (${t.columns.map(q).join(', ')})`);
        const insert = db.prepare(`INSERT INTO ${q(t.name)} VALUES (${t.columns.map((_, i) => valueSql(`?${i + 1}`)).join(', ')})`);
        for (const row of t.rows) insert.run(row.map(bind));
        insert.free();
    }
    return db;
}

const JOIN: Record<JoinKind, string> = { inner: 'JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', outer: 'FULL OUTER JOIN' };

/** The SQL for a join of L and R (the generator's table names). */
export function joinSql(left: Table, right: Table, c: JoinCase): string {
    const cols = c.select ?? [...left.columns.map(x => `${left.name}.${x}`), ...right.columns.map(x => `${right.name}.${x}`)];
    const select = cols.map(col => { const [t, x] = col.split('.'); return `${q(t)}.${q(x)} AS ${q(col)}`; }).join(', ');
    const on = c.on.map(p => `${withFns(`${q(left.name)}.${q(p.left)}`, p.leftFns)} = ${withFns(`${q(right.name)}.${q(p.right)}`, p.rightFns)}`).join(' AND ');
    return `SELECT ${select} FROM ${q(left.name)} ${JOIN[c.kind]} ${q(right.name)} ON ${on}`;
}

/** The rows SQLite gives for a query, every value as it came out. */
export function rows(db: Database, sql: string): Value[][] {
    const out: Value[][] = [];
    const stmt = db.prepare(sql);
    while (stmt.step()) out.push(stmt.get() as Value[]);
    stmt.free();
    return out;
}

/** The expected rows of a join of two tables, from SQLite. */
export function expectedJoin(SQL: SqlJsStatic, left: Table, right: Table, c: JoinCase): Value[][] {
    const db = load(SQL, [left, right]);
    try { return rows(db, joinSql(left, right, c)); } finally { db.close(); }
}

/**
 * Rows in a form that compares as sets (order is not part of a join's answer): each row
 * written as text, the list sorted. Numbers keep their written form, so 7 and '7' differ,
 * as they do in SQLite.
 */
export function canonical(rowsIn: Value[][]): string[] {
    return rowsIn.map(r => JSON.stringify(r.map(v => (typeof v === 'number' ? { n: v } : v)))).sort();
}

/** Where two answers differ: rows only in each, by their canonical text (the first few). */
export function differences(expected: Value[][], actual: Value[][], limit = 5): { missing: string[]; extra: string[] } {
    const count = (list: string[]) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    const e = count(canonical(expected)), a = count(canonical(actual));
    const missing: string[] = [], extra: string[] = [];
    for (const [k, n] of e) for (let i = n - (a.get(k) ?? 0); i > 0 && missing.length < limit; i--) missing.push(k);
    for (const [k, n] of a) for (let i = n - (e.get(k) ?? 0); i > 0 && extra.length < limit; i--) extra.push(k);
    return { missing, extra };
}
