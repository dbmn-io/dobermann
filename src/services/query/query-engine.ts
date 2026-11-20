// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Runs a Query on SQLite (sql.js). Each view's rows are loaded as a table in a database that
 * lives in memory only, so a query works on copies: it cannot change a record, a saved result or
 * the run history, and it cannot send a request.
 *
 * Values keep their JSON type, as Compare keeps them: a number stays a number, text stays text
 * ("00123" keeps its zeros and never equals 123), null and missing are NULL, true and false are
 * the words, and an object or array is its JSON text. The tables declare no column types, so
 * SQLite stores each value as given.
 *
 * The host passes sql.js in already started (Node and the browser each find the wasm their own
 * way), so this file has no host in it.
 */
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { fromSql, keySql, leftKeySql, quoteName, refNames, tableNames, tableSql, writeSql, WriteSqlOptions } from './query-sql';
import { keepsUnmatched } from './query-types';
import type { QueryJoinStats, QueryRelationship, QueryRows, QueryValue, QuerySpec } from './query-types';

export type QueryRowData = Record<string, unknown>;

/**
 * A value as Query's tables hold it: numbers as numbers, text as text, yes/no as the text "true"
 * or "false", blank as NULL, a list or object as its JSON. column-functions.ts reads values the same way.
 */
export function toSql(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'bigint') return value.toString();
    return JSON.stringify(value);
}

const INSERT_CHUNK = 5000;

/**
 * How a value goes into a table, around its parameter (`?1`). sql.js stores a JavaScript number
 * that does not fit 32 bits as a decimal (REAL), so a 13-digit barcode would read back as
 * "1234567890123.0" and never meet the same barcode written as text. A decimal that is a whole
 * number SQLite can hold exactly is stored as the whole number it is.
 */
export function valueSql(param: string): string {
    return `CASE WHEN typeof(${param}) = 'real' AND ${param} = CAST(${param} AS INTEGER) THEN CAST(${param} AS INTEGER) ELSE ${param} END`;
}

/**
 * The most rows a query may make. sql.js holds a query's rows in the page's memory, and a join on
 * a column that repeats (status, not sku) can make millions from a few thousand: past this the
 * query is not run, so it can never take the page down. Below it nothing is stopped: a join that
 * repeats rows says so in its counts, and the user fixes it.
 */
export const MAX_QUERY_ROWS = 2_000_000;

/** Join number `join` would make `rows` rows: more than `limit`. */
export interface TooManyRows {
    join: number;
    rows: number;
    limit: number;
}

export class QuerySession {
    private readonly db: Database;
    private readonly tables: Map<string, string>;

    constructor(SQL: SqlJsStatic, private spec: QuerySpec) {
        this.db = new SQL.Database();
        this.tables = tableNames(spec.views);
    }

    /**
     * Loads one view's rows as its table. Rows go in a few thousand at a time with a pause
     * between, so a big view doesn't freeze the page; `onProgress` hears the count so far.
     */
    async load(viewId: string, rows: QueryRowData[], onProgress?: (done: number) => void): Promise<void> {
        const view = this.spec.views.find(v => v.id === viewId);
        const table = this.tables.get(viewId);
        if (!view || !table) throw new Error(`Query: no view "${viewId}"`);
        if (!view.columns.length) throw new Error(`Query: "${view.name}" has no columns`);
        this.db.run(`DROP TABLE IF EXISTS ${quoteName(table)}`);
        this.db.run(`CREATE TABLE ${quoteName(table)} (${view.columns.map(quoteName).join(', ')})`);
        const insert = this.db.prepare(`INSERT INTO ${quoteName(table)} VALUES (${view.columns.map((_, i) => valueSql(`?${i + 1}`)).join(', ')})`);
        try {
            for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
                this.db.run('BEGIN');
                const end = Math.min(rows.length, start + INSERT_CHUNK);
                for (let i = start; i < end; i++) insert.run(view.columns.map(c => toSql(rows[i][c])));
                this.db.run('COMMIT');
                onProgress?.(end);
                if (end < rows.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        } finally {
            insert.free();
        }
    }

    /** New joins or columns over the same views (their tables stay loaded). */
    setSpec(spec: QuerySpec): void {
        this.spec = spec;
    }

    /** The query's SQL, as the user reads it. */
    sql(options?: WriteSqlOptions): string {
        return writeSql(this.spec, options);
    }

    /** Runs any SQL SQLite can run on the loaded tables: tables in, a table out. */
    run(sql: string): QueryRows {
        const results = this.db.exec(sql);
        const last = results[results.length - 1];
        return last ? { columns: last.columns, rows: last.values } : { columns: [], rows: [] };
    }

    /** The query's rows (all of them, or a page with `limit`/`offset`). */
    rows(options?: WriteSqlOptions): QueryRows {
        return this.run(this.sql(options));
    }

    /**
     * Up to `max` of the query's rows, spread evenly from its first to its last: enough to tell
     * what a column holds without reading every row, and not just the first ones.
     */
    sample(max: number): QueryRows {
        const total = this.count();
        if (total <= max) return this.rows();
        const step = Math.ceil(total / max);
        const out = this.run(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER () AS "__dbmn_n" FROM (${this.sql()})) WHERE ("__dbmn_n" - 1) % ${step} = 0`);
        return { columns: out.columns.slice(0, -1), rows: out.rows.map(r => r.slice(0, -1)) };
    }

    /**
     * How many rows join number `index` makes, worked out from how many rows hold each key value
     * on each side, without making them (the unmatched rows a LEFT, RIGHT or outer join keeps added). Only the joins before it are made, and each of those is
     * under the limit (tooManyRows checks them in order).
     */
    rowsAfterJoin(index: number): number {
        const join = this.spec.joins[index];
        if (!join) throw new Error(`Query: no join ${index}`);
        const rightView = this.spec.views.find(v => v.id === join.view);
        if (!rightView) throw new Error(`Query: no view "${join.view}"`);
        const names = refNames(this.spec.views);
        const ks = join.on.map((_, i) => `k${i}`);
        const notNull = ks.map(k => `${k} IS NOT NULL`).join(' AND ');
        const same = ks.map(k => `lg.${k} = rg.${k}`).join(' AND ');
        const [leftRows, matchedRows, pairs, rightRows, rightMatched] = this.run(`WITH _l AS (SELECT ${join.on.map((_, i) => `${leftKeySql(this.spec, index, i, names)} AS k${i}`).join(', ')} ${fromSql(this.spec, index)}),
_r AS (SELECT ${join.on.map((p, i) => `${keySql(p.right, names)} AS k${i}`).join(', ')} FROM ${tableSql(rightView, this.tables)}),
_lg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _l WHERE ${notNull} GROUP BY ${ks.join(', ')}),
_rg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _r WHERE ${notNull} GROUP BY ${ks.join(', ')})
SELECT (SELECT COUNT(*) FROM _l), COALESCE(SUM(lg.n), 0), COALESCE(SUM(lg.n * rg.n), 0), (SELECT COUNT(*) FROM _r), COALESCE(SUM(rg.n), 0) FROM _lg AS lg JOIN _rg AS rg ON ${same}`).rows[0].map(Number);
        const keeps = keepsUnmatched(join.kind);
        return pairs + (keeps.left ? leftRows - matchedRows : 0) + (keeps.right ? rightRows - rightMatched : 0);
    }

    /** The first join that would make more than `limit` rows, or undefined when every join is under it. */
    tooManyRows(limit = MAX_QUERY_ROWS): TooManyRows | undefined {
        for (let i = 0; i < this.spec.joins.length; i++) {
            const rows = this.rowsAfterJoin(i);
            if (rows > limit) return { join: i, rows, limit };
        }
        return undefined;
    }

    /** How many rows the query makes. */
    count(where?: string): number {
        const inner = writeSql(this.spec, { where });
        return Number(this.run(`SELECT COUNT(*) FROM (${inner})`).rows[0]?.[0] ?? 0);
    }

    /**
     * How join number `index` meets the table built by the joins before it: how many rows match,
     * the relationship its key values make, the rows it leaves, and the values each side joins on.
     * A key with a NULL in it matches nothing, as in SQL.
     */
    joinStats(index: number, perKind = 50): QueryJoinStats {
        const join = this.spec.joins[index];
        if (!join) throw new Error(`Query: no join ${index}`);
        const rightView = this.spec.views.find(v => v.id === join.view);
        if (!rightView) throw new Error(`Query: no view "${join.view}"`);
        const right = tableSql(rightView, this.tables);
        const names = refNames(this.spec.views);
        const n = join.on.length;
        const ks = Array.from({ length: n }, (_, i) => `k${i}`);
        const leftKeys = join.on.map((_, i) => `${leftKeySql(this.spec, index, i, names)} AS k${i}`).join(', ');
        const rightKeys = join.on.map((p, i) => `${keySql(p.right, names)} AS k${i}`).join(', ');
        const notNull = ks.map(k => `${k} IS NOT NULL`).join(' AND ');
        const same = ks.map(k => `lg.${k} = rg.${k}`).join(' AND ');
        const groups = `WITH _l AS (SELECT ${leftKeys} ${fromSql(this.spec, index)}),
_r AS (SELECT ${rightKeys} FROM ${right}),
_lg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _l WHERE ${notNull} GROUP BY ${ks.join(', ')}),
_rg AS (SELECT ${ks.join(', ')}, COUNT(*) AS n FROM _r WHERE ${notNull} GROUP BY ${ks.join(', ')})`;
        const kinds = ['lg.n = 1 AND rg.n = 1', 'lg.n = 1 AND rg.n > 1', 'lg.n > 1 AND rg.n = 1', 'lg.n > 1 AND rg.n > 1'];
        const totals = this.run(`${groups}
SELECT (SELECT COUNT(*) FROM _l), (SELECT COUNT(*) FROM _r), (SELECT COALESCE(SUM(n), 0) FROM _lg),
  COALESCE(SUM(lg.n), 0), COALESCE(SUM(rg.n), 0), COALESCE(SUM(lg.n * rg.n), 0),
  ${kinds.map(k => `COALESCE(SUM(${k}), 0), COALESCE(SUM((${k}) * lg.n), 0), COALESCE(SUM((${k}) * rg.n), 0)`).join(',\n  ')},
  (SELECT COUNT(*) FROM _lg), (SELECT COUNT(*) FROM _rg)
FROM _lg AS lg JOIN _rg AS rg ON ${same}`).rows[0].map(Number);
        const [leftRows, rightRows, leftKeyed, leftMatched, rightMatched, pairs] = totals;
        const [oneToOne, , , oneToMany, , oneToManyRecords, manyToOne, manyToOneRows, , manyToMany, manyToManyRows, manyToManyRecords, leftValues, rightValues] = totals.slice(6);
        // The values, a few of each kind, what needs a look first: no match, not used, repeated in the joining view, the rest
        const cap = Math.max(1, Math.floor(perKind));
        const list = this.run(`${groups},
_v AS (SELECT ${ks.map(k => `lg.${k} AS ${k}`).join(', ')}, lg.n AS ln, COALESCE(rg.n, 0) AS rn FROM _lg AS lg LEFT JOIN _rg AS rg ON ${same}
  UNION ALL SELECT ${ks.map(k => `rg.${k}`).join(', ')}, 0, rg.n FROM _rg AS rg WHERE NOT EXISTS (SELECT 1 FROM _lg AS lg WHERE ${same})),
_k AS (SELECT *, CASE WHEN rn = 0 THEN 0 WHEN ln = 0 THEN 1 WHEN rn > 1 THEN 2 ELSE 3 END AS kind FROM _v),
_n AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY ln * MAX(rn, 1) DESC, rn DESC, ${ks.join(', ')}) AS place, COUNT(*) OVER () AS every FROM _k)
SELECT ${ks.join(', ')}, ln, rn, every FROM _n WHERE place <= ${cap} ORDER BY kind, place`).rows;
        const values: QueryValue[] = list.map(row => ({ key: row.slice(0, n), left: Number(row[n]), right: Number(row[n + 1]) }));
        const valuesTotal = list.length ? Number(list[0][n + 2]) : 0;
        // Types on each side of each pair: no type in common means the pair can never match
        const types = (sql: string): Set<string> => new Set(this.run(sql).rows.map(r => (r[0] === 'integer' || r[0] === 'real' ? 'number' : String(r[0]))).filter(t => t !== 'null'));
        const typeMismatch = join.on.some((_, i) => {
            const l = types(`SELECT DISTINCT typeof(k${i}) FROM (SELECT ${leftKeys} ${fromSql(this.spec, index)})`);
            const r = types(`SELECT DISTINCT typeof(k${i}) FROM (SELECT ${rightKeys} FROM ${right})`);
            return l.size > 0 && r.size > 0 && ![...l].some(t => r.has(t));
        });
        let relationship: QueryRelationship = 'none';
        if (manyToMany || (oneToMany && manyToOne)) relationship = 'manyToMany';
        else if (oneToMany) relationship = 'oneToMany';
        else if (manyToOne) relationship = 'manyToOne';
        else if (oneToOne) relationship = 'oneToOne';
        return {
            leftRows, leftMatched, rightRows, rightMatched,
            rowsAfter: pairs + (keepsUnmatched(join.kind).left ? leftRows - leftMatched : 0) + (keepsUnmatched(join.kind).right ? rightRows - rightMatched : 0),
            relationship,
            typeMismatch,
            keys: { oneToOne, oneToMany, manyToOne, manyToMany },
            rows: { oneToOne, oneToMany, manyToOne: manyToOneRows, manyToMany: manyToManyRows },
            records: { oneToOne, oneToMany: oneToManyRecords, manyToOne, manyToMany: manyToManyRecords },
            leftBlank: leftRows - leftKeyed,
            leftValues, rightValues,
            values,
            valuesTotal
        };
    }

    close(): void {
        this.db.close();
    }
}
