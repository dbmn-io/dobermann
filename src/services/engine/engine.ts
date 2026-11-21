// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine (engine-types.ts is its interface). Tables in (`load`, `append`, `drop`), queries
 * of `from`, `join`, `select`, `filter` and `sort` steps with every function (engine-functions.ts),
 * results read a window at a time. A result is a view over the tables: `select` works its
 * expressions out only for the rows read; `filter`, `sort` and `join` keep row numbers.
 *
 * A run works in slices and gives way between them (SLICE rows), so a screen can show its progress
 * and Stop can reach it (`cancel`).
 */
import { ARITY, callFunction, type FunctionContext, type LookupSource } from './engine-functions';
import { StoredTable, TextDictionary } from './engine-columns';
import { COMPARE_RELATION, COMPARE_STATUS, runCompare } from './engine-compare';
import {
    FUNCTIONS, ROW_LIMIT, type CompareStats, type Engine, type Expr, type FunctionName, type JoinKind, type JoinStats, type Problem,
    type Query, type ResultId, type RowTests, type RunOptions, type Value, type RunOutcome, type Step, type StatsWindow, type Table, type TableWindow
} from './engine-types';
import { compareValues, fromValue, isNumber, num, readNumber, Real, toValue, truthy, type V } from './engine-values';

/** A column of a step's rows: its name, and the inputs it can be named by (`{ column, of }`). */
interface Col {
    name: string;
    owners: string[];
    /** Its name in `read`, when two columns share a name (after a join): "input.name". */
    shown?: string;
}

/** A step's rows: its columns, how many rows, and a value by row and column. */
interface Relation {
    cols: Col[];
    rowCount: number;
    value(row: number, column: number): V;
}

type Kind = 'from' | 'join' | 'compare' | 'select' | 'filter' | 'group' | 'sort';
const KINDS: Kind[] = ['from', 'join', 'compare', 'select', 'filter', 'group', 'sort'];
const RUNS_NOW = new Set<Kind>(['from', 'join', 'compare', 'select', 'filter', 'group', 'sort']);
const AGGREGATES = ['count', 'countValues', 'sum', 'min', 'max'];


/** Rows worked between two give-ways. */
const SLICE = 65_536;

class Cancelled extends Error {}
class TooMany extends Error {
    constructor(readonly problem: Problem) { super(problem.message); }
}

const kindOf = (step: Step): Kind | undefined => KINDS.find(k => k in step);
const stepName = (step: Step, i: number): string => step.as ?? `step ${i + 1}`;

/** A step's inputs: the names it reads (a loaded table, or an earlier step's `as`). */
function inputsOf(step: Step, kind: Kind): string[] {
    const s = step as Record<string, unknown>;
    if (kind === 'join') return [String(s.left), String(s.right)];
    if (kind === 'compare') return (s.compare as string[]) ?? [];
    return [String(s[kind])];
}

/** A group's key: blank is a value like any other (as GROUP BY); numbers and text never alike. */
function groupKeyOf(parts: V[]): string {
    let key = '';
    for (const v of parts) key += v === null ? 'z\u0001' : isNumber(v) ? `n${num(v)}\u0001` : `t${v.length}:${v}`;
    return key;
}

/** A row's key, for matching: blank when any part is blank; numbers and text never alike. */
function keyOf(parts: V[]): string | null {
    let key = '';
    for (const v of parts) {
        if (v === null) return null;
        key += isNumber(v) ? `n${num(v)}\u0001` : `t${v.length}:${v}`;
    }
    return key;
}

const giveWay = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const count = (n: number): string => n.toLocaleString('en-US');

export class QueryEngine implements Engine {
    private readonly tables = new Map<string, StoredTable>();
    /** Every table's text, once (engine-columns.ts). */
    private readonly dict = new TextDictionary();
    private readonly results = new Map<ResultId, Relation>();
    private readonly cancelled = new Set<ResultId>();
    /** Each result's compare and join steps' statistics, by step name (a join's with its values, for windows). */
    private readonly stepStats = new Map<ResultId, Map<string, CompareStats | JoinFacts>>();
    private nextResult = 1;
    private readonly ctx: FunctionContext = {
        table: name => {
            const t = this.tables.get(name);
            return t ? ({ columns: t.columns, rowCount: t.rowCount, value: (r, c) => t.value(r, c) } as LookupSource) : undefined;
        }
    };

    /**
     * @param rowLimit the most rows a join may make (ROW_LIMIT unless a test asks for less).
     * @param rowTests the row tests filter steps may name (Results' search).
     */
    constructor(private readonly rowLimit = ROW_LIMIT, private readonly rowTests: RowTests = {}) {}

    /* ---------- Tables ---------- */

    /** Start a table (replacing one of the same name). `more`: further pieces follow by `append`; it is loading until one says `last`. */
    load(name: string, table: Table, options?: { more?: boolean }): void {
        const replaced = this.tables.has(name);
        const stored = new StoredTable(name, [...table.columns], this.dict);
        stored.complete = false;
        this.tables.set(name, stored);
        if (replaced) this.tidy();
        this.put(stored, table);
        if (!options?.more) this.completed(stored);
    }

    append(name: string, table: Table, options?: { last?: boolean }): void {
        const stored = this.tables.get(name);
        if (!stored) throw new Error(`Engine: no table "${name}" to add to`);
        if (table.columns.length !== stored.columns.length || table.columns.some((c, i) => c !== stored.columns[i])) {
            throw new Error(`Engine: the rows for "${name}" have other columns`);
        }
        this.put(stored, table);
        if (options?.last) this.completed(stored);
    }

    drop(name: string): void {
        if (this.tables.delete(name)) this.tidy();
    }

    /** A table is all in: its columns' spare room goes, and with no table coming in, the dictionary's lookup. */
    private completed(stored: StoredTable): void {
        stored.complete = true;
        stored.cols.forEach(c => c.trim());
        if ([...this.tables.values()].every(t => t.complete)) this.dict.seal();
    }

    /** A table gone or replaced: the texts no table uses any more go too, once there are enough of them. */
    private tidy(): void {
        if (this.dict.worthCompacting) this.dict.compact([...this.tables.values()].flatMap(t => t.cols));
    }

    private put(stored: StoredTable, table: Table): void {
        const n = stored.columns.length;
        for (const row of table.rows) {
            for (let c = 0; c < n; c++) stored.cols[c].push(fromValue(row[c] ?? null));
            stored.rowCount++;
        }
    }

    /* ---------- Checking ---------- */

    check(query: Query): Problem[] {
        const problems: Problem[] = [];
        const known = new Map<string, Col[]>();   // a step's name → its columns
        const steps = query.steps ?? [];
        if (!steps.length) return [{ step: 'query', message: 'The query has no steps.' }];
        steps.forEach((step, i) => {
            const name = stepName(step, i);
            const kind = kindOf(step);
            if (!kind) { problems.push({ step: name, message: 'A step of a kind the engine does not know.' }); return; }
            if (!RUNS_NOW.has(kind)) { problems.push({ step: name, message: `The engine does not run a ${kind} step yet.` }); return; }
            const inputs = inputsOf(step, kind).map(input => ({ input, cols: this.colsOf(input, known, kind === 'from') }));
            const missing = inputs.filter(x => typeof x.cols === 'string');
            if (missing.length) { missing.forEach(x => problems.push({ step: name, message: x.cols as string })); return; }
            const say = (message: string) => problems.push({ step: name, message });
            let out: Col[];
            if (kind === 'compare') {
                const s = step as Extract<Step, { compare: string[] }>;
                const ins = inputs as { input: string; cols: Col[] }[];
                if (ins.length < 2) say('A compare needs at least two inputs.');
                if (new Set(s.compare).size !== s.compare.length) say('An input is in the compare twice.');
                if (s.on?.length !== ins.length) say('A compare needs a key for each input.');
                else {
                    const parts = s.on[0].length;
                    if (!parts) say('A compare needs at least one key column.');
                    s.on.forEach((key, i) => {
                        if (key.length !== parts) say(`${ins[i].input}'s key has ${key.length} columns, the Baseline's ${parts}.`);
                        key.forEach(e => this.checkExpr(e, ins[i].cols, ins[i].input, say));
                    });
                }
                s.columns?.forEach(c => {
                    if (c.values.length !== ins.length) say(`"${c.name}" needs a value for each input.`);
                    else c.values.forEach((e, i) => this.checkExpr(e, ins[i].cols, ins[i].input, say));
                });
                (s.notCompared ?? []).forEach(n => {
                    if (n === s.compare[0]) say('The Baseline is always compared.');
                    else if (!s.compare.includes(n)) say(`"${n}" is not in the compare.`);
                });
                out = compareCols(ins.map(x => x.input), ins.map(x => x.cols), s.columns ?? []);
            } else if (kind === 'join') {
                const s = step as Extract<Step, { join: JoinKind }>;
                const [l, r] = inputs as { input: string; cols: Col[] }[];
                if (!['inner', 'left', 'right', 'outer'].includes(s.join)) say(`A join is inner, left, right or outer, not "${s.join}".`);
                if (!s.on?.length) say('A join needs at least one pair of key columns.');
                s.on?.forEach(p => { this.checkExpr(p.left, l.cols, l.input, say); this.checkExpr(p.right, r.cols, r.input, say); });
                out = joinedCols(l.input, l.cols, r.input, r.cols);
            } else {
                const { input, cols } = inputs[0] as { input: string; cols: Col[] };
                out = cols;
                if (kind === 'from') out = cols.map(c => ({ name: c.name, owners: [input, ...(step.as ? [step.as] : [])] }));
                else if (kind === 'select') {
                    const s = step as Extract<Step, { select: string }>;
                    if (!s.columns.length) say('A select step needs at least one column.');
                    s.columns.forEach(c => this.checkExpr(c.value, cols, input, say));
                    out = s.columns.map(c => ({ name: c.name, owners: [] }));
                    const seen = new Set<string>();
                    out.forEach(c => { if (seen.has(c.name)) say(`Two columns are called "${c.name}".`); seen.add(c.name); });
                } else if (kind === 'filter') {
                    const f = step as Extract<Step, { filter: string }>;
                    if ('test' in f) { if (!this.rowTests[f.test?.name]) say(`There is no row test "${f.test?.name}".`); }
                    else this.checkExpr(f.where, cols, input, say);
                } else if (kind === 'group') {
                    const s = step as Extract<Step, { group: string }>;
                    s.by.forEach(b => this.checkExpr(b.value, cols, input, say));
                    s.aggregates.forEach(a => {
                        if (!AGGREGATES.includes(a.fn)) say(`There is no aggregate "${a.fn}".`);
                        if (a.value) this.checkExpr(a.value, cols, input, say);
                        else if (a.fn !== 'count') say(`"${a.name}" (${a.fn}) needs a value.`);
                    });
                    out = [...s.by.map(b => b.name), ...s.aggregates.map(a => a.name)].map(name => ({ name, owners: [] }));
                    if (!out.length) say('A group step needs something to group by or count.');
                    const seen = new Set<string>();
                    out.forEach(c => { if (seen.has(c.name)) say(`Two columns are called "${c.name}".`); seen.add(c.name); });
                } else if (kind === 'sort') {
                    const s = step as Extract<Step, { sort: string }>;
                    if (!s.by.length) say('A sort step needs something to sort by.');
                    s.by.forEach(b => this.checkExpr(b.value, cols, input, say));
                }
            }
            known.set(name, out);
        });
        if (query.result && !known.has(query.result)) problems.push({ step: query.result, message: `No step is called "${query.result}".` });
        return problems;
    }

    /** An input's columns: an earlier step's, or a loaded, complete table's; or why not. */
    private colsOf(input: string, known: Map<string, Col[]>, tableOnly: boolean): Col[] | string {
        if (!tableOnly && known.has(input)) return known.get(input)!;
        const t = this.tables.get(input);
        if (!t) return `There is no table or step called "${input}".`;
        if (!t.complete) return `"${input}" is still loading.`;
        return t.columns.map(name => ({ name, owners: [input] }));
    }

    private checkExpr(e: Expr, cols: Col[], input: string, say: (message: string) => void): void {
        if ('column' in e) {
            const found = findColumn(e, cols, input);
            if (typeof found === 'string') say(found);
            return;
        }
        if ('value' in e) return;
        if (!FUNCTIONS.includes(e.fn)) { say(`There is no function "${e.fn}".`); return; }
        const [least, most] = ARITY[e.fn];
        if (e.args.length < least || e.args.length > most) say(`${e.fn} takes ${least === most ? least : `${least} to ${most === Infinity ? 'any number of' : most}`} values, not ${e.args.length}.`);
        e.args.forEach(a => this.checkExpr(a, cols, input, say));
    }

    /* ---------- Running ---------- */

    async run(query: Query, options?: RunOptions): Promise<RunOutcome> {
        const problems = this.check(query);
        if (problems.length) return { problems };
        const id = `r${this.nextResult++}`;
        const progress = (stage: string, done: number, total: number) => options?.onProgress?.({ result: id, stage, done, total });
        // Between slices: give way, say how far, and stop when asked to
        const slice = async (stage: string, done: number, total: number): Promise<void> => {
            progress(stage, done, total);
            await giveWay();
            if (this.cancelled.has(id)) throw new Cancelled();
        };
        try {
            progress('Starting', 0, 0);
            const made = new Map<string, Relation>();
            let last: Relation | undefined;
            for (let i = 0; i < query.steps.length; i++) {
                const step = query.steps[i];
                const kind = kindOf(step)!;
                const name = stepName(step, i);
                const input = (n: string): Relation => (kind !== 'from' && made.get(n)) || this.tableRelation(n);
                const keep = (stats: CompareStats | JoinFacts) => {
                    if (!this.stepStats.has(id)) this.stepStats.set(id, new Map());
                    this.stepStats.get(id)!.set(name, stats);
                };
                const rel = kind === 'compare' ? await this.compared(step as Extract<Step, { compare: string[] }>, name, input, slice, keep)
                    : kind === 'join' ? await this.joined(step as Extract<Step, { join: JoinKind }>, name, input, slice, keep)
                    : await this.stepRelation(step, kind, name, input, slice);
                made.set(name, rel);
                last = rel;
            }
            if (this.cancelled.has(id)) { this.stepStats.delete(id); return { cancelled: true }; }
            const answer = query.result ? made.get(query.result)! : last!;
            progress('Done', answer.rowCount, answer.rowCount);
            this.results.set(id, answer);
            return { result: id, total: answer.rowCount };
        } catch (error) {
            const kept = this.stepStats.get(id);
            this.stepStats.delete(id);
            if (error instanceof Cancelled) return { cancelled: true };
            if (error instanceof TooMany) {
                const counted: Record<string, JoinStats | CompareStats> = {};
                for (const [step, facts] of kept ?? []) counted[step] = facts instanceof JoinFacts ? facts.stats : facts;
                return { problems: [error.problem], stats: counted };
            }
            throw error;
        } finally {
            this.cancelled.delete(id);
        }
    }

    private async stepRelation(step: Step, kind: Kind, name: string, input: (n: string) => Relation,
        slice: (stage: string, done: number, total: number) => Promise<void>): Promise<Relation> {
        const from = inputsOf(step, kind)[0];
        const base = input(from);
        if (kind === 'from') return { ...base, cols: base.cols.map(c => ({ name: c.name, owners: [from, ...(step.as ? [step.as] : [])] })) };
        if (kind === 'select') {
            const s = step as Extract<Step, { select: string }>;
            const exprs = s.columns.map(c => this.compile(c.value, base, from));
            return { cols: s.columns.map(c => ({ name: c.name, owners: [] })), rowCount: base.rowCount, value: (row, c) => exprs[c](row) };
        }
        if (kind === 'sort') return this.sorted(step as Extract<Step, { sort: string }>, base, from, name, slice);
        if (kind === 'group') return this.grouped(step as Extract<Step, { group: string }>, base, from, name, slice);
        // filter: the rows whose condition is true, as SQLite's WHERE reads it; or that pass the host's row test
        const f = step as Extract<Step, { filter: string }>;
        let pass: (r: number) => boolean;
        if ('test' in f) {
            const test = this.rowTests[f.test.name](f.test.arg, base.cols.map(c => c.name));
            const n = base.cols.length;
            pass = r => { const row = new Array<Value>(n); for (let c = 0; c < n; c++) row[c] = toValue(base.value(r, c)); return test(row); };
        } else {
            const where = this.compile(f.where, base, from);
            pass = r => truthy(where(r)) === true;
        }
        const kept: number[] = [];
        for (let r = 0; r < base.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(`Filtering ${name}`, r, base.rowCount);
            if (pass(r)) kept.push(r);
        }
        const rows = Int32Array.from(kept);
        return { cols: base.cols, rowCount: rows.length, value: (row, c) => base.value(rows[row], c) };
    }

    /**
     * Join: a hash of the right input's keys, then the left's rows looked up in it. The rows it
     * would make are counted from the keys first (each left row's matches, and the unmatched rows
     * the kind keeps); past the row limit it is refused, no row made.
     */
    private async joined(step: Extract<Step, { join: JoinKind }>, name: string, input: (n: string) => Relation,
        slice: (stage: string, done: number, total: number) => Promise<void>, keep: (facts: JoinFacts) => void): Promise<Relation> {
        const left = input(step.left);
        const right = input(step.right);
        const stage = `Joining ${step.right}`;
        const work = left.rowCount + right.rowCount;
        const lk = step.on.map(p => this.compile(p.left, left, step.left));
        const rk = step.on.map(p => this.compile(p.right, right, step.right));
        // The right's rows by key
        const byKey = new Map<string, number[]>();
        for (let r = 0; r < right.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(stage, r, work);
            const key = keyOf(rk.map(f => f(r)));
            if (key === null) continue;
            const list = byKey.get(key);
            if (list) list.push(r); else byKey.set(key, [r]);
        }
        // The left's keys, and how many rows the join would make
        const leftKeys = new Array<string | null>(left.rowCount);
        const usedRight = new Uint8Array(right.rowCount);
        // Each left key's rows, and its first row (for the values behind a count)
        const leftHeld = new Map<string, { n: number; first: number }>();
        let pairs = 0, leftAlone = 0;
        for (let r = 0; r < left.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(stage, right.rowCount + r, work);
            const key = keyOf(lk.map(f => f(r)));
            leftKeys[r] = key;
            if (key !== null) { const h = leftHeld.get(key); if (h) h.n++; else leftHeld.set(key, { n: 1, first: r }); }
            const list = key === null ? undefined : byKey.get(key);
            if (list) { pairs += list.length; for (const x of list) usedRight[x] = 1; } else leftAlone++;
        }
        let rightAlone = 0;
        for (let r = 0; r < right.rowCount; r++) if (!usedRight[r]) rightAlone++;
        const keepsLeft = step.join === 'left' || step.join === 'outer';
        const keepsRight = step.join === 'right' || step.join === 'outer';
        const rows = pairs + (keepsLeft ? leftAlone : 0) + (keepsRight ? rightAlone : 0);
        keep(joinFacts(left, right, lk, rk, leftHeld, byKey, rows));
        if (rows > this.rowLimit) {
            throw new TooMany({ step: name, message: `Joining ${step.right} would make ${count(rows)} rows, more than the ${count(this.rowLimit)} a query can hold. Check its key columns.` });
        }
        // The rows: the left's in order, each with its matches in the right's order; then the right's unmatched
        const lRow = new Int32Array(rows);
        const rRow = new Int32Array(rows);
        let at = 0;
        for (let r = 0; r < left.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(`Making the rows of ${step.right}`, r, left.rowCount);
            const key = leftKeys[r];
            const list = key === null ? undefined : byKey.get(key);
            if (list) for (const x of list) { lRow[at] = r; rRow[at++] = x; }
            else if (keepsLeft) { lRow[at] = r; rRow[at++] = -1; }
        }
        if (keepsRight) for (let r = 0; r < right.rowCount; r++) if (!usedRight[r]) { lRow[at] = -1; rRow[at++] = r; }
        const split = left.cols.length;
        return {
            cols: joinedCols(step.left, left.cols, step.right, right.cols),
            rowCount: rows,
            value: (row, c) => {
                if (c < split) { const l = lRow[row]; return l < 0 ? null : left.value(l, c); }
                const r = rRow[row];
                return r < 0 ? null : right.value(r, c - split);
            }
        };
    }

    /** Compare (its rule is at the top of engine-compare.ts): the rows it makes, as a view over its inputs, and its statistics. */
    private async compared(step: Extract<Step, { compare: string[] }>, name: string, input: (n: string) => Relation,
        slice: (stage: string, done: number, total: number) => Promise<void>, keep: (stats: CompareStats) => void): Promise<Relation> {
        const names = step.compare;
        const rels = names.map(n => input(n));
        const places = rels.length;
        const columns = step.columns ?? [];
        const skipped = new Set(step.notCompared ?? []);
        const made = await runCompare(rels.map((rel, i) => ({
            name: names[i],
            rowCount: rel.rowCount,
            key: step.on[i].map(e => this.compile(e, rel, names[i])),
            values: columns.map(c => this.compile(c.values[i], rel, names[i])),
            skipped: i > 0 && skipped.has(names[i])
        })), columns.length, (done, total) => slice(`Comparing ${names.length} inputs`, done, total), SLICE);
        keep(made.stats);
        const { rowAt, status, relation, differs } = made;
        const length = made.stats.rows;
        const inputCols = rels.map(r => r.cols.length);
        const starts: number[] = [];
        inputCols.reduce((n, c) => { starts.push(n); return n + c; }, 0);
        const own = inputCols.reduce((n, c) => n + c, 0);
        return {
            cols: compareCols(names, rels.map(r => r.cols), columns),
            rowCount: length,
            value: (row, c) => {
                if (c < own) {
                    let p = places - 1;
                    while (starts[p] > c) p--;
                    const r = rowAt[p][row];
                    return r < 0 ? null : rels[p].value(r, c - starts[p]);
                }
                const extra = c - own;
                if (extra === 0) return COMPARE_STATUS[status[row]];
                if (extra === 1) return COMPARE_RELATION[relation[row]];
                if (extra < 2 + places) return rowAt[extra - 2][row] < 0 ? 1 : 0;
                return differs[extra - 2 - places][row];
            }
        };
    }

    /** Group (the rule is on the step in engine-types.ts): a row per group, its `by` values from its first row, then the aggregates. */
    private async grouped(step: Extract<Step, { group: string }>, base: Relation, input: string, name: string,
        slice: (stage: string, done: number, total: number) => Promise<void>): Promise<Relation> {
        const by = step.by.map(b => this.compile(b.value, base, input));
        const aggs = step.aggregates.map(a => ({ fn: a.fn, value: a.value ? this.compile(a.value, base, input) : undefined }));
        const groups = new Map<string, number>();
        const first: number[] = [];
        const acc: Accumulator[][] = [];
        const start = () => aggs.map(() => new Accumulator());
        for (let r = 0; r < base.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(`Grouping ${name}`, r, base.rowCount);
            const key = by.length ? groupKeyOf(by.map(f => f(r))) : '';
            let g = groups.get(key);
            if (g === undefined) { g = first.length; groups.set(key, g); first.push(r); acc.push(start()); }
            const a = acc[g];
            for (let i = 0; i < aggs.length; i++) a[i].add(aggs[i].value ? aggs[i].value!(r) : null, aggs[i].fn);
        }
        // With nothing to group by: one row, even for no rows
        if (!by.length && !first.length) { first.push(-1); acc.push(start()); }
        const results = acc.map(a => a.map((x, i) => x.result(aggs[i].fn)));
        return {
            cols: [...step.by.map(b => b.name), ...step.aggregates.map(a => a.name)].map(n => ({ name: n, owners: [] })),
            rowCount: first.length,
            value: (row, c) => (c < by.length ? by[c](first[row]) : results[row][c - by.length])
        };
    }

    /**
     * Sort: by each `by` in turn, in compareValues' order (blank first, then numbers, then text by
     * code points); `descending` reverses it, so blanks come last. Ties: rows equal on every `by`
     * keep the order they came in (a stable sort; SQLite promises no order for ties).
     */
    private async sorted(step: Extract<Step, { sort: string }>, base: Relation, input: string, name: string,
        slice: (stage: string, done: number, total: number) => Promise<void>): Promise<Relation> {
        const n = base.rowCount;
        const keys: { values: V[]; sign: number; cmp: (a: V, b: V) => number }[] = [];
        for (const b of step.by) {
            const f = this.compile(b.value, base, input);
            const values = new Array<V>(n);
            for (let r = 0; r < n; r++) {
                if (r && r % SLICE === 0) await slice(`Sorting ${name}`, r, n);
                values[r] = f(r);
            }
            keys.push({ values, sign: b.descending ? -1 : 1, cmp: b.order === 'shown' ? shownOrder() : compareValues });
        }
        const order = new Array<number>(n);
        for (let r = 0; r < n; r++) order[r] = r;
        // (text ranked once instead was measured slower on unique keys, 1.9 s against 1.6 s for 1M: not kept)
        order.sort((x, y) => {
            for (const k of keys) {
                const c = k.cmp(k.values[x], k.values[y]);
                if (c) return c * k.sign;
            }
            return x - y;
        });
        const rows = Int32Array.from(order);
        return { cols: base.cols, rowCount: n, value: (row, c) => base.value(rows[row], c) };
    }

    private tableRelation(name: string): Relation {
        const t = this.tables.get(name)!;
        // (a snapshot of its length: rows appended later are not in this result)
        const rowCount = t.rowCount;
        return { cols: t.columns.map(c => ({ name: c, owners: [name] })), rowCount, value: (row, c) => t.value(row, c) };
    }

    /** An expression as a function of a row of `rel` (read as `input`). Comparisons are exact by type (engine-values.ts compareValues). */
    private compile(e: Expr, rel: Relation, input: string): (row: number) => V {
        if ('column' in e) {
            const at = findColumn(e, rel.cols, input) as number;
            return row => rel.value(row, at);
        }
        if ('value' in e) {
            const v = fromValue(e.value);
            return () => v;
        }
        const args = e.args.map(a => this.compile(a, rel, input));
        const name: FunctionName = e.fn;
        return row => callFunction(name, args.map(a => a(row)), this.ctx);
    }

    cancel(result: ResultId): void {
        this.cancelled.add(result);
    }

    /* ---------- Results ---------- */

    read(result: ResultId, from: number, count: number): TableWindow {
        const rel = this.results.get(result);
        if (!rel) throw new Error(`Engine: no result "${result}"`);
        const start = Math.max(0, Math.floor(from));
        const end = Math.min(rel.rowCount, start + Math.max(0, Math.floor(count)));
        const rows: Table['rows'] = [];
        const n = rel.cols.length;
        for (let r = start; r < end; r++) {
            const row = new Array(n);
            for (let c = 0; c < n; c++) row[c] = toValue(rel.value(r, c));
            rows.push(row);
        }
        return { columns: rel.cols.map(c => c.shown ?? c.name), rows, total: rel.rowCount };
    }

    readRows(result: ResultId, rows: number[]): TableWindow {
        const rel = this.results.get(result);
        if (!rel) throw new Error(`Engine: no result "${result}"`);
        const n = rel.cols.length;
        const out: Table['rows'] = [];
        for (const r of rows) {
            if (!Number.isInteger(r) || r < 0 || r >= rel.rowCount) continue;
            const row = new Array(n);
            for (let c = 0; c < n; c++) row[c] = toValue(rel.value(r, c));
            out.push(row);
        }
        return { columns: rel.cols.map(c => c.shown ?? c.name), rows: out, total: rel.rowCount };
    }

    stats(result: ResultId, step: string, window?: StatsWindow): JoinStats | CompareStats | Table {
        if (!this.results.has(result)) throw new Error(`Engine: no result "${result}"`);
        const found = this.stepStats.get(result)?.get(step);
        if (!found) throw new Error(`Engine: no statistics for "${step}": not a join or compare step of this result`);
        if (found instanceof JoinFacts) return window ? found.window(window) : found.stats;
        if (window) throw new Error('Engine: a compare step\'s statistics have no window yet');
        return found;
    }

    release(result: ResultId): void {
        this.results.delete(result);
        this.stepStats.delete(result);
    }

    /** Roughly what the loaded tables hold, in bytes (the memory checks). */
    bytes(): number {
        let n = 0;
        for (const t of this.tables.values()) for (const c of t.cols) n += c.bytes();
        return n + this.dict.bytes();
    }
}

/** A join's columns: the left's, then the right's, each also named by the input it came from; a name on both sides shown as "input.name". */
function joinedCols(leftName: string, left: Col[], rightName: string, right: Col[]): Col[] {
    const names = (cols: Col[]) => new Set(cols.map(c => c.name));
    const l = names(left), r = names(right);
    const side = (cols: Col[], input: string, other: Set<string>): Col[] => cols.map(c => ({
        name: c.name,
        owners: [...c.owners, input],
        ...(other.has(c.name) ? { shown: `${input}.${c.name}` } : c.shown ? { shown: c.shown } : {})
    }));
    return [...side(left, leftName, r), ...side(right, rightName, l)];
}

/** A compare's columns: every input's (named by `of`; a name in two inputs shown "input.name"), then status, relation, missing:<input>, differs:<column>. */
function compareCols(names: string[], cols: Col[][], columns: { name: string }[]): Col[] {
    const seen = new Map<string, number>();
    cols.forEach(list => list.forEach(c => seen.set(c.name, (seen.get(c.name) ?? 0) + 1)));
    const own = cols.flatMap((list, p) => list.map(c => ({
        name: c.name,
        owners: [...c.owners, names[p]],
        ...((seen.get(c.name) ?? 0) > 1 ? { shown: `${names[p]}.${c.name}` } : c.shown ? { shown: c.shown } : {})
    })));
    const added = ['status', 'relation', ...names.map(n => `missing:${n}`), ...columns.map(c => `differs:${c.name}`)];
    return [...own, ...added.map(name => ({ name, owners: [] }))];
}

/**
 * The column `{ column, of }` names among a step's columns (read as `input`): by name, and when
 * `of` is given, among those of that input (the step's own input names every column). Or why not:
 * none, or two inputs with that name and no `of` to say which.
 */
function findColumn(e: { column: string; of?: string }, cols: Col[], input: string): number | string {
    const named = cols.map((c, i) => ({ c, i })).filter(x => x.c.name === e.column);
    const found = e.of === undefined || e.of === input ? named : named.filter(x => x.c.owners.includes(e.of!));
    if (found.length === 1) return found[0].i;
    if (!found.length) return e.of !== undefined && e.of !== input ? `There is no column "${e.column}" in "${e.of}".` : `There is no column "${e.column}".`;
    return `"${e.column}" is in more than one input (${found.map(x => x.c.owners[x.c.owners.length - 1]).join(', ')}): say which.`;
}

/** A join step's statistics, and what its windows read: each key value's rows on each side. */
class JoinFacts {
    constructor(
        readonly stats: JoinStats,
        /** Every key value: its rows on the left and the right, and a row holding it (on the left if it has one). */
        private readonly values: { ln: number; rn: number; side: 'left' | 'right'; row: number }[],
        private readonly partsOf: (value: { side: 'left' | 'right'; row: number }) => V[],
        private readonly parts: number
    ) {}

    /** The values behind one count (engine-types.ts StatsWindow). */
    window(w: StatsWindow): Table {
        const of = (v: { ln: number; rn: number }): StatsWindow['kind'] =>
            !v.rn ? 'onlyLeft' : !v.ln ? 'onlyRight'
                : v.ln === 1 && v.rn === 1 ? 'oneToOne' : v.ln === 1 ? 'oneToMany' : v.rn === 1 ? 'manyToOne' : 'manyToMany';
        const picked = this.values.filter(v => of(v) === w.kind).map(v => ({ v, key: this.partsOf(v) }));
        picked.sort((a, b) => (b.v.ln * Math.max(b.v.rn, 1)) - (a.v.ln * Math.max(a.v.rn, 1)) || b.v.rn - a.v.rn
            || a.key.reduce<number>((c, x, i) => c || compareValues(x, b.key[i]), 0));
        const from = Math.max(0, Math.floor(w.from));
        const columns = this.parts === 1 ? ['key'] : Array.from({ length: this.parts }, (_, i) => `key ${i + 1}`);
        return {
            columns: [...columns, 'left', 'right'],
            rows: picked.slice(from, from + Math.max(0, Math.floor(w.count))).map(p => [...p.key.map(toValue), p.v.ln, p.v.rn])
        };
    }
}

/** A join's statistics from the keys it matched on: the left's held per key, the right's rows per key. */
function joinFacts(left: Relation, right: Relation, lk: ((row: number) => V)[], rk: ((row: number) => V)[],
    leftHeld: Map<string, { n: number; first: number }>, byKey: Map<string, number[]>, rowsAfter: number): JoinFacts {
    const keys = { oneToOne: 0, oneToMany: 0, manyToOne: 0, manyToMany: 0 };
    const rows = { ...keys };
    const records = { ...keys };
    let leftKeyed = 0, leftMatched = 0, rightMatched = 0;
    const values: { ln: number; rn: number; side: 'left' | 'right'; row: number }[] = [];
    for (const [key, h] of leftHeld) {
        leftKeyed += h.n;
        const rn = byKey.get(key)?.length ?? 0;
        values.push({ ln: h.n, rn, side: 'left', row: h.first });
        if (!rn) continue;
        leftMatched += h.n;
        rightMatched += rn;
        const kind = h.n === 1 && rn === 1 ? 'oneToOne' : h.n === 1 ? 'oneToMany' : rn === 1 ? 'manyToOne' : 'manyToMany';
        keys[kind]++;
        rows[kind] += h.n;
        records[kind] += rn;
    }
    for (const [key, list] of byKey) if (!leftHeld.has(key)) values.push({ ln: 0, rn: list.length, side: 'right', row: list[0] });
    // Types on each side of each key part: no type in common means it can never match
    const typesOf = (rel: Relation, fns: ((row: number) => V)[]) => fns.map(f => {
        let num = false, text = false;
        for (let r = 0; r < rel.rowCount && !(num && text); r++) { const v = f(r); if (v === null) continue; if (isNumber(v)) num = true; else text = true; }
        return { num, text };
    });
    const lt = typesOf(left, lk), rt = typesOf(right, rk);
    const typeMismatch = lt.some((l, i) => (l.num || l.text) && (rt[i].num || rt[i].text) && !((l.num && rt[i].num) || (l.text && rt[i].text)));
    const relationship: JoinStats['relationship'] = keys.manyToMany || (keys.oneToMany && keys.manyToOne) ? 'manyToMany'
        : keys.oneToMany ? 'oneToMany' : keys.manyToOne ? 'manyToOne' : keys.oneToOne ? 'oneToOne' : 'none';
    const stats: JoinStats = {
        leftRows: left.rowCount, leftMatched, rightRows: right.rowCount, rightMatched, rowsAfter, relationship,
        keys, rows, records, typeMismatch,
        leftBlank: left.rowCount - leftKeyed,
        leftValues: leftHeld.size, rightValues: byKey.size, valuesTotal: values.length
    };
    return new JoinFacts(stats, values, v => (v.side === 'left' ? lk : rk).map(f => f(v.row)), lk.length);
}

/** One aggregate over a group's rows, as SQLite's count, count(x), sum, min and max. */
class Accumulator {
    private rows = 0;
    private values = 0;
    private summed = 0;
    private intSum = 0;
    private realSum = 0;
    private real = false;
    private best: V = null;

    add(v: V, fn: string): void {
        this.rows++;
        if (v === null) return;
        this.values++;
        if (fn === 'sum') {
            // (text read as a number by the one rule: text that is not a number is left out)
            const n = readNumber(v);
            if (n === null) return;
            this.summed++;
            if (typeof n === 'number') { this.intSum += n; this.realSum += n; }
            else { this.real = true; this.realSum += n.r; }
        } else if (fn === 'min' || fn === 'max') {
            const c = this.best === null ? 0 : compareValues(v, this.best);
            if (this.best === null || (fn === 'min' ? c < 0 : c > 0)) this.best = v;
        }
    }

    result(fn: string): V {
        switch (fn) {
            case 'count': return this.rows;
            case 'countValues': return this.values;
            case 'sum': return !this.summed ? null : this.real ? new Real(this.realSum) : this.intSum;
            default: return this.best;
        }
    }
}

/**
 * Results' order (a sort step's `order: 'shown'`): blank and empty text last, numbers by size, any
 * other pair by its text, letters in a natural locale order with numbers inside it by size: as the
 * Query screen sorted its rows before (query.controller.ts compareValues).
 */
function shownOrder(): (a: V, b: V) => number {
    const collator = new Intl.Collator(undefined, { numeric: true });
    const text = (v: V): string => (typeof v === 'string' ? v : v instanceof Real ? String(v.r) : String(v));
    return (a, b) => {
        const blankA = a === null || a === '';
        const blankB = b === null || b === '';
        if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
        if (isNumber(a) && isNumber(b)) return num(a) - num(b);
        return collator.compare(text(a), text(b));
    };
}
