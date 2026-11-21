// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine (engine-types.ts is its interface). Piece 1: tables in (`load`, `append`, `drop`),
 * queries of `from`, `select` and `filter` steps with every function (engine-functions.ts), and
 * results read a window at a time. A result is a view over the tables: `select` works its
 * expressions out only for the rows read, `filter` keeps the row numbers that pass.
 */
import { ARITY, callFunction, type FunctionContext, type LookupSource } from './engine-functions';
import { StoredTable } from './engine-columns';
import { FUNCTIONS, type Engine, type Expr, type FunctionName, type Problem, type Query, type ResultId, type Step, type Table, type TableWindow, type CompareStats, type JoinStats, type StatsWindow } from './engine-types';
import { forComparison, fromValue, toValue, truthy, type Affinity, type V } from './engine-values';

/** A step's rows: its columns, how many rows, and a value by row and column. */
interface Relation {
    columns: string[];
    /** Each column's affinity for comparisons (engine-values.ts Affinity): a table's columns BLOB, a select's its expression's. */
    affinity: Affinity[];
    rowCount: number;
    value(row: number, column: number): V;
}

/** The comparisons, which first convert their sides for their affinities, as SQLite does. */
const COMPARISONS = new Set<FunctionName>(['=', '<>', '>', '<', '>=', '<=']);

/** The step kinds this piece runs; the rest are refused by name until their piece. */
const STEP_KINDS = ['from', 'join', 'compare', 'select', 'filter', 'group', 'sort'] as const;
const RUNS_NOW = new Set(['from', 'select', 'filter']);

function kindOf(step: Step): typeof STEP_KINDS[number] | undefined {
    return STEP_KINDS.find(k => k in step);
}

/** A step's input: the name it reads (a loaded table, or an earlier step's `as`). */
function inputOf(step: Step): string | undefined {
    const s = step as Record<string, unknown>;
    for (const k of ['from', 'select', 'filter', 'group', 'sort']) if (typeof s[k] === 'string') return s[k] as string;
    return undefined;
}

const stepName = (step: Step, i: number): string => step.as ?? `step ${i + 1}`;

export class QueryEngine implements Engine {
    private readonly tables = new Map<string, StoredTable>();
    private readonly results = new Map<ResultId, Relation>();
    private nextResult = 1;
    private readonly ctx: FunctionContext = {
        table: name => {
            const t = this.tables.get(name);
            return t ? ({ columns: t.columns, rowCount: t.rowCount, value: (r, c) => t.value(r, c) } as LookupSource) : undefined;
        }
    };

    /** Start a table (replacing one of the same name). `more`: further pieces follow by `append`; it is loading until one says `last`. */
    load(name: string, table: Table, options?: { more?: boolean }): void {
        const stored = new StoredTable(name, [...table.columns]);
        stored.complete = !options?.more;
        this.tables.set(name, stored);
        this.put(stored, table);
    }

    append(name: string, table: Table, options?: { last?: boolean }): void {
        const stored = this.tables.get(name);
        if (!stored) throw new Error(`Engine: no table "${name}" to add to`);
        if (table.columns.length !== stored.columns.length || table.columns.some((c, i) => c !== stored.columns[i])) {
            throw new Error(`Engine: the rows for "${name}" have other columns`);
        }
        this.put(stored, table);
        stored.complete = !!options?.last;
    }

    drop(name: string): void {
        this.tables.delete(name);
    }

    private put(stored: StoredTable, table: Table): void {
        const n = stored.columns.length;
        for (const row of table.rows) {
            for (let c = 0; c < n; c++) stored.cols[c].push(fromValue(row[c] ?? null));
            stored.rowCount++;
        }
    }

    check(query: Query): Problem[] {
        const problems: Problem[] = [];
        const known = new Map<string, string[]>();   // a step's or table's name → its columns
        const steps = query.steps ?? [];
        if (!steps.length) return [{ step: 'query', message: 'The query has no steps.' }];
        let last: string[] | undefined;
        steps.forEach((step, i) => {
            const name = stepName(step, i);
            const kind = kindOf(step);
            if (!kind) { problems.push({ step: name, message: 'A step of a kind the engine does not know.' }); return; }
            if (!RUNS_NOW.has(kind)) { problems.push({ step: name, message: `The engine does not run a ${kind} step yet.` }); return; }
            const input = inputOf(step)!;
            const columns = this.columnsOf(input, known, kind === 'from');
            if (typeof columns === 'string') { problems.push({ step: name, message: columns }); return; }
            let out = columns;
            if (kind === 'select') {
                const s = step as Extract<Step, { select: string }>;
                s.columns.forEach(c => this.checkExpr(c.value, columns, input, name, problems));
                out = s.columns.map(c => c.name);
            } else if (kind === 'filter') {
                this.checkExpr((step as Extract<Step, { filter: string }>).where, columns, input, name, problems);
            }
            known.set(name, out);
            if (step.as) known.set(step.as, out);
            last = out;
        });
        if (query.result && !known.has(query.result)) problems.push({ step: query.result, message: `No step is called "${query.result}".` });
        void last;
        return problems;
    }

    /** An input's columns: an earlier step's, or a loaded, complete table's; or why not. */
    private columnsOf(input: string, known: Map<string, string[]>, tableOnly: boolean): string[] | string {
        if (!tableOnly && known.has(input)) return known.get(input)!;
        const t = this.tables.get(input);
        if (!t) return `There is no table or step called "${input}".`;
        if (!t.complete) return `"${input}" is still loading.`;
        return t.columns;
    }

    private checkExpr(e: Expr, columns: string[], input: string, step: string, problems: Problem[]): void {
        if ('column' in e) {
            if (e.of !== undefined && e.of !== input) problems.push({ step, message: `"${e.of}" is not this step's input.` });
            if (!columns.includes(e.column)) problems.push({ step, message: `There is no column "${e.column}".` });
            return;
        }
        if ('value' in e) return;
        if (!FUNCTIONS.includes(e.fn)) { problems.push({ step, message: `There is no function "${e.fn}".` }); return; }
        const [least, most] = ARITY[e.fn];
        if (e.args.length < least || e.args.length > most) problems.push({ step, message: `${e.fn} takes ${least === most ? least : `${least} to ${most === Infinity ? 'any number of' : most}`} values, not ${e.args.length}.` });
        e.args.forEach(a => this.checkExpr(a, columns, input, step, problems));
    }

    run(query: Query): { result: ResultId; total: number } | { problems: Problem[] } {
        const problems = this.check(query);
        if (problems.length) return { problems };
        const made = new Map<string, Relation>();
        let last: Relation | undefined;
        query.steps.forEach((step, i) => {
            const kind = kindOf(step)!;
            const input = inputOf(step)!;
            const from = kind === 'from' ? undefined : made.get(input);
            const rel = this.stepRelation(step, kind, input, from);
            made.set(stepName(step, i), rel);
            if (step.as) made.set(step.as, rel);
            last = rel;
        });
        const answer = query.result ? made.get(query.result)! : last!;
        const id = `r${this.nextResult++}`;
        this.results.set(id, answer);
        return { result: id, total: answer.rowCount };
    }

    private stepRelation(step: Step, kind: string, input: string, earlier: Relation | undefined): Relation {
        const base: Relation = earlier ?? this.tableRelation(input);
        if (kind === 'from') return base;
        if (kind === 'select') {
            const s = step as Extract<Step, { select: string }>;
            const exprs = s.columns.map(c => this.compile(c.value, base));
            return { columns: s.columns.map(c => c.name), affinity: exprs.map(x => x.aff), rowCount: base.rowCount, value: (row, c) => exprs[c].f(row) };
        }
        // filter: the rows whose condition is true, as SQLite's WHERE reads it
        const where = this.compile((step as Extract<Step, { filter: string }>).where, base).f;
        const kept: number[] = [];
        for (let r = 0; r < base.rowCount; r++) if (truthy(where(r)) === true) kept.push(r);
        const rows = Int32Array.from(kept);
        return { columns: base.columns, affinity: base.affinity, rowCount: rows.length, value: (row, c) => base.value(rows[row], c) };
    }

    private tableRelation(name: string): Relation {
        const t = this.tables.get(name)!;
        // (a snapshot of its length: rows appended later are not in this result)
        const count = t.rowCount;
        return { columns: t.columns, affinity: t.columns.map(() => 'blob' as Affinity), rowCount: count, value: (row, c) => t.value(row, c) };
    }

    /** An expression as a function of a row of `rel`, with its affinity (a CAST's type: TEXT, NUMERIC; else none). */
    private compile(e: Expr, rel: Relation): { f: (row: number) => V; aff: Affinity } {
        if ('column' in e) {
            const at = rel.columns.indexOf(e.column);
            return { f: row => rel.value(row, at), aff: rel.affinity[at] ?? 'none' };
        }
        if ('value' in e) {
            const v = fromValue(e.value);
            return { f: () => v, aff: 'none' };
        }
        const args = e.args.map(a => this.compile(a, rel));
        const name: FunctionName = e.fn;
        const aff: Affinity = name === 'TEXT' ? 'text' : name === 'NUMERIC' ? 'numeric' : 'none';
        if (COMPARISONS.has(name)) {
            const [x, y] = args;
            return { f: row => callFunction(name, forComparison(x.f(row), x.aff, y.f(row), y.aff), this.ctx), aff };
        }
        return { f: row => callFunction(name, args.map(a => a.f(row)), this.ctx), aff };
    }

    cancel(_result: ResultId): void {
        // (runs finish before they return in this piece: nothing to stop)
    }

    read(result: ResultId, from: number, count: number): TableWindow {
        const rel = this.results.get(result);
        if (!rel) throw new Error(`Engine: no result "${result}"`);
        const start = Math.max(0, Math.floor(from));
        const end = Math.min(rel.rowCount, start + Math.max(0, Math.floor(count)));
        const rows: Table['rows'] = [];
        const n = rel.columns.length;
        for (let r = start; r < end; r++) {
            const row = new Array(n);
            for (let c = 0; c < n; c++) row[c] = toValue(rel.value(r, c));
            rows.push(row);
        }
        return { columns: [...rel.columns], rows, total: rel.rowCount };
    }

    stats(_result: ResultId, _step: string, _window?: StatsWindow): JoinStats | CompareStats | Table {
        throw new Error('Engine: statistics come with the join and compare pieces');
    }

    release(result: ResultId): void {
        this.results.delete(result);
    }

    /** Roughly what the loaded tables hold, in bytes (the memory checks). */
    bytes(): number {
        let n = 0;
        for (const t of this.tables.values()) for (const c of t.cols) n += c.bytes();
        return n;
    }
}
