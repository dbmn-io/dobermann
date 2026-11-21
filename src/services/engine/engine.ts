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
import { StoredTable } from './engine-columns';
import {
    FUNCTIONS, ROW_LIMIT, type CompareStats, type Engine, type Expr, type FunctionName, type JoinKind, type JoinStats, type Problem,
    type Query, type ResultId, type RunOptions, type RunOutcome, type Step, type StatsWindow, type Table, type TableWindow
} from './engine-types';
import { compareValues, fromValue, isNumber, num, toValue, truthy, type V } from './engine-values';

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
const RUNS_NOW = new Set<Kind>(['from', 'join', 'compare', 'select', 'filter', 'sort']);

/** A compare row's status, by code (Uint8Array), and its relation. */
const STATUS = ['same', 'diff', 'missing', 'notInBaseline', 'duplicate'] as const;
const RELATION = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'] as const;

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

/** A compare's key: as keyOf, but a blank is a key part like any other (the old Compare's rule). */
function compareKeyOf(parts: V[]): string {
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
    private readonly results = new Map<ResultId, Relation>();
    private readonly cancelled = new Set<ResultId>();
    /** Each result's compare steps' statistics, by step name. */
    private readonly compareStats = new Map<ResultId, Map<string, CompareStats>>();
    private nextResult = 1;
    private readonly ctx: FunctionContext = {
        table: name => {
            const t = this.tables.get(name);
            return t ? ({ columns: t.columns, rowCount: t.rowCount, value: (r, c) => t.value(r, c) } as LookupSource) : undefined;
        }
    };

    /** @param rowLimit the most rows a join may make (ROW_LIMIT unless a test asks for less). */
    constructor(private readonly rowLimit = ROW_LIMIT) {}

    /* ---------- Tables ---------- */

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
                    this.checkExpr((step as Extract<Step, { filter: string }>).where, cols, input, say);
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
                const rel = kind === 'compare'
                    ? await this.compared(step as Extract<Step, { compare: string[] }>, name, input, slice, stats => {
                        if (!this.compareStats.has(id)) this.compareStats.set(id, new Map());
                        this.compareStats.get(id)!.set(name, stats);
                    })
                    : await this.stepRelation(step, kind, name, input, slice);
                made.set(name, rel);
                last = rel;
            }
            if (this.cancelled.has(id)) { this.compareStats.delete(id); return { cancelled: true }; }
            const answer = query.result ? made.get(query.result)! : last!;
            progress('Done', answer.rowCount, answer.rowCount);
            this.results.set(id, answer);
            return { result: id, total: answer.rowCount };
        } catch (error) {
            this.compareStats.delete(id);
            if (error instanceof Cancelled) return { cancelled: true };
            if (error instanceof TooMany) return { problems: [error.problem] };
            throw error;
        } finally {
            this.cancelled.delete(id);
        }
    }

    private async stepRelation(step: Step, kind: Kind, name: string, input: (n: string) => Relation,
        slice: (stage: string, done: number, total: number) => Promise<void>): Promise<Relation> {
        if (kind === 'join') return this.joined(step as Extract<Step, { join: JoinKind }>, name, input, slice);
        const from = inputsOf(step, kind)[0];
        const base = input(from);
        if (kind === 'from') return { ...base, cols: base.cols.map(c => ({ name: c.name, owners: [from, ...(step.as ? [step.as] : [])] })) };
        if (kind === 'select') {
            const s = step as Extract<Step, { select: string }>;
            const exprs = s.columns.map(c => this.compile(c.value, base, from));
            return { cols: s.columns.map(c => ({ name: c.name, owners: [] })), rowCount: base.rowCount, value: (row, c) => exprs[c](row) };
        }
        if (kind === 'sort') return this.sorted(step as Extract<Step, { sort: string }>, base, from, name, slice);
        // filter: the rows whose condition is true, as SQLite's WHERE reads it
        const where = this.compile((step as Extract<Step, { filter: string }>).where, base, from);
        const kept: number[] = [];
        for (let r = 0; r < base.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(`Filtering ${name}`, r, base.rowCount);
            if (truthy(where(r)) === true) kept.push(r);
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
        slice: (stage: string, done: number, total: number) => Promise<void>): Promise<Relation> {
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
        let pairs = 0, leftAlone = 0;
        for (let r = 0; r < left.rowCount; r++) {
            if (r && r % SLICE === 0) await slice(stage, right.rowCount + r, work);
            const key = keyOf(lk.map(f => f(r)));
            leftKeys[r] = key;
            const list = key === null ? undefined : byKey.get(key);
            if (list) { pairs += list.length; for (const x of list) usedRight[x] = 1; } else leftAlone++;
        }
        let rightAlone = 0;
        for (let r = 0; r < right.rowCount; r++) if (!usedRight[r]) rightAlone++;
        const keepsLeft = step.join === 'left' || step.join === 'outer';
        const keepsRight = step.join === 'right' || step.join === 'outer';
        const rows = pairs + (keepsLeft ? leftAlone : 0) + (keepsRight ? rightAlone : 0);
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

    /**
     * Compare, as the old Compare (compare-across.ts; the rule is on the step in engine-types.ts).
     * Every key, the Baseline's first; the rows a key makes (one, or one per repeat in a later
     * input, or one for a key the Baseline repeats); each row's status, relation and differs; and
     * each input's statistics.
     */
    private async compared(step: Extract<Step, { compare: string[] }>, name: string, input: (n: string) => Relation,
        slice: (stage: string, done: number, total: number) => Promise<void>, keep: (stats: CompareStats) => void): Promise<Relation> {
        const names = step.compare;
        const rels = names.map(n => input(n));
        const places = rels.length;
        const columns = step.columns ?? [];
        const skipped = new Set((step.notCompared ?? []).map(n => names.indexOf(n)).filter(i => i > 0));
        const stage = `Comparing ${names.length} inputs`;
        const work = rels.reduce((n, r) => n + r.rowCount, 0) * 2;
        let done = 0;
        const keyFns = rels.map((rel, i) => step.on[i].map(e => this.compile(e, rel, names[i])));
        const valueFns = rels.map((rel, i) => columns.map(c => this.compile(c.values[i], rel, names[i])));

        // 1. Every key, the Baseline's first, then each input's in order; each row's key number
        const keyIndex = new Map<string, number>();
        const keyed: Int32Array[] = [];
        for (let p = 0; p < places; p++) {
            const rel = rels[p];
            const at = new Int32Array(rel.rowCount);
            for (let r = 0; r < rel.rowCount; r++) {
                if (++done % SLICE === 0) await slice(stage, done, work);
                const key = compareKeyOf(keyFns[p].map(f => f(r)));
                let k = keyIndex.get(key);
                if (k === undefined) { k = keyIndex.size; keyIndex.set(key, k); }
                at[r] = k;
            }
            keyed.push(at);
        }
        const keys = keyIndex.size;
        keyIndex.clear();
        // Each input's rows for each key: how many, and (for keys on more than one row anywhere) which
        const held = keyed.map(() => new Int32Array(keys));
        const firstRow = keyed.map(() => new Int32Array(keys).fill(-1));
        keyed.forEach((at, p) => at.forEach((k, r) => { if (held[p][k]++ === 0) firstRow[p][k] = r; }));
        const many = new Map<number, number[][]>();
        for (let k = 0; k < keys; k++) if (held.some(h => h[k] > 1)) many.set(k, names.map(() => []));
        if (many.size) keyed.forEach((at, p) => at.forEach((k, r) => many.get(k)?.[p].push(r)));

        // 2. The rows: one per key; a key repeated in a later input, one per record of the input holding it most
        const rowsOf: number[][] = names.map(() => []);
        const dupRow: number[] = [];
        const repeatedRow: number[] = [];
        let length = 0;
        for (let k = 0; k < keys; k++) {
            const each = many.get(k);
            if (!each) { for (let p = 0; p < places; p++) rowsOf[p].push(firstRow[p][k]); length++; continue; }
            if (each[0].length > 1) {
                // Repeated in the Baseline: one row, not compared (each input's first record shown)
                for (let p = 0; p < places; p++) rowsOf[p].push(each[p].length ? each[p][0] : -1);
                dupRow.push(length++);
                continue;
            }
            const n = Math.max(...each.map(list => list.length));
            for (let i = 0; i < n; i++) {
                for (let p = 0; p < places; p++) rowsOf[p].push(each[p].length ? each[p][Math.min(i, each[p].length - 1)] : -1);
                repeatedRow.push(length++);
            }
        }
        const rowAt = rowsOf.map(r => Int32Array.from(r));
        const isDup = new Uint8Array(length); dupRow.forEach(r => { isDup[r] = 1; });
        const isRepeated = new Uint8Array(length); repeatedRow.forEach(r => { isRepeated[r] = 1; });

        // 3. Each row's status, relation, missing and differs
        const status = new Uint8Array(length);
        const relation = new Uint8Array(length);
        const differs = columns.map(() => new Uint8Array(length));
        const statusCounts = { same: 0, diff: 0, missing: 0, notInBaseline: 0, duplicate: 0 };
        for (let row = 0; row < length; row++) {
            if (++done % SLICE === 0) await slice(stage, done, work);
            const base = rowAt[0][row];
            let missing = false, changed = false;
            for (let p = 1; p < places; p++) if (!skipped.has(p) && rowAt[p][row] < 0) missing = true;
            relation[row] = base < 0 ? 3 : missing ? 2 : isRepeated[row] || isDup[row] ? 1 : 0;
            if (isDup[row]) status[row] = 4;
            else if (base < 0) status[row] = 3;
            else {
                for (let c = 0; c < columns.length; c++) {
                    const b = valueFns[0][c](base);
                    for (let p = 1; p < places; p++) {
                        const r = rowAt[p][row];
                        if (skipped.has(p) || r < 0) continue;
                        if (compareValues(b, valueFns[p][c](r)) !== 0) { differs[c][row] = 1; changed = true; break; }
                    }
                }
                status[row] = changed ? 1 : missing ? 2 : 0;
            }
            statusCounts[STATUS[status[row]]]++;
        }

        // 4. Each input's statistics
        const compared = names.map((_, p) => p).filter(p => !skipped.has(p));
        const perInput = names.map((n, p) => {
            const h = held[p], b = held[0];
            const ab = { matched: 0, oneToOne: 0, repeatedKeys: 0, repeatedRecords: 0, only: 0 };
            const aa = { matched: 0, repeatedKeys: 0, repeatedRecords: 0, onlyHere: 0 };
            for (let k = 0; k < keys; k++) {
                const here = h[k];
                if (!here) continue;
                if (b[k]) {
                    ab.matched += here;
                    if (here === 1 && b[k] === 1) ab.oneToOne++;
                    else { ab.repeatedKeys++; ab.repeatedRecords += here; }
                } else ab.only += here;
                const elsewhere = compared.some(q => q !== p && held[q][k] > 0);
                if (elsewhere) aa.matched += here; else aa.onlyHere += here;
                if (here > 1) { aa.repeatedKeys++; aa.repeatedRecords += here; }
            }
            return { name: n, rows: rels[p].rowCount, againstBaseline: ab, againstAll: aa };
        });
        keep({ perInput, rows: length, status: statusCounts });

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
                if (extra === 0) return STATUS[status[row]];
                if (extra === 1) return RELATION[relation[row]];
                if (extra < 2 + places) return rowAt[extra - 2][row] < 0 ? 1 : 0;
                return differs[extra - 2 - places][row];
            }
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
        const keys: { values: V[]; sign: number }[] = [];
        for (const b of step.by) {
            const f = this.compile(b.value, base, input);
            const values = new Array<V>(n);
            for (let r = 0; r < n; r++) {
                if (r && r % SLICE === 0) await slice(`Sorting ${name}`, r, n);
                values[r] = f(r);
            }
            keys.push({ values, sign: b.descending ? -1 : 1 });
        }
        const order = new Array<number>(n);
        for (let r = 0; r < n; r++) order[r] = r;
        order.sort((x, y) => {
            for (const k of keys) {
                const c = compareValues(k.values[x], k.values[y]);
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

    stats(result: ResultId, step: string, _window?: StatsWindow): JoinStats | CompareStats | Table {
        if (!this.results.has(result)) throw new Error(`Engine: no result "${result}"`);
        const found = this.compareStats.get(result)?.get(step);
        if (found) return found;
        throw new Error(`Engine: no statistics for "${step}" (a join step's come with their own piece)`);
    }

    release(result: ResultId): void {
        this.results.delete(result);
        this.compareStats.delete(result);
    }

    /** Roughly what the loaded tables hold, in bytes (the memory checks). */
    bytes(): number {
        let n = 0;
        for (const t of this.tables.values()) for (const c of t.cols) n += c.bytes();
        return n;
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
