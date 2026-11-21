// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's compare on the new engine (src/services/engine), behind the development setting "New
 * compare engine (testing)": the first piece of Query moving off SQLite
 * (~/Projects/dbmn/audits/query-2026-11-21/compare-first-switch.md).
 *
 * A query that is one compare and nothing else (no other join, no calculated column, no Translate
 * values, no Distinct) runs here; anything more runs on SQLite as before, and `whyNotOnEngine` says
 * why in a line the Join step shows. This file only translates: the views' rows into the engine,
 * the spec into an engine Query (a compare step, then a select of Results' columns and each view's
 * key), the engine's rows back into what Results reads (rows and key values, as
 * QuerySession.rows({ extra: compareKeySql }) gives them), and CompareStats into the fields the
 * Join step's compare summary reads (QueryJoinStats).
 */
import { asColumnValue, wholeNumber, type ColumnFn } from '../column-functions/column-functions';
import { QueryEngine } from '../engine/engine';
import { localEngineHost, type EngineHost } from '../engine/engine-host';
import type { CompareStats, Expr, FunctionName, JoinStats, Progress, Query, StatsWindow, Table, Value } from '../engine/engine-types';
import { ROW_LIMIT } from '../engine/engine-types';
import { FUNCTIONS } from '../engine/engine-types';
import type { FormulaNode } from './formula';
import { queryCompare } from './query-compare';
import { formulaColumns, resultColumns } from './query-sql';
import { comparedGroups, type RelationKind, type RowStatus, type StatusCounts, type StatusFilter } from './query-status';
import { parseFormula } from './formula';
import { CALC_VIEW, type ColumnRef, type QueryJoinStats, type QueryKey, type QuerySpec } from './query-types';

/** Why a query runs on SQLite even with the setting on, in a few words; undefined when it runs on the engine. */
export function whyNotOnEngine(spec: QuerySpec): string | undefined {
    const compare = queryCompare(spec.joins, spec.views[0]?.id);
    if (!compare) return 'it is not a compare';
    if (spec.joins.some(j => j.kind !== 'compare')) return 'it has a join besides the compare';
    if ((spec.calc ?? []).length || spec.select.some(c => c.view === CALC_VIEW)) return 'it has a calculated column';
    if (spec.distinct) return 'Distinct is on';
    const keys = compareKeys(spec);
    if (!keys.length || keys.some(k => !k.parts.length || k.parts.some(p => !p.column))) return 'its key is not picked yet';
    if (keys.some(k => k.parts.length > 1 && k.fns?.length)) return 'a key joins columns with a function on the whole';
    return undefined;
}

/** One line for the Join step when the setting is on but the query runs on SQLite. */
export function onSqliteLine(why: string): string {
    return `New compare engine (testing): this query runs on the old engine, because ${why}.`;
}

/** The compare's views, the Baseline first, and each one's key: one QueryKey per pair (+ AND). */
function compareKeysByView(spec: QuerySpec): { view: string; keys: QueryKey[] }[] {
    const joins = spec.joins.filter(j => j.kind === 'compare');
    const first = joins[0];
    if (!first) return [];
    const baseline = first.on[0]?.left.parts[0]?.view ?? spec.views[0]?.id ?? '';
    return [
        { view: baseline, keys: first.on.map(p => p.left) },
        ...joins.map(j => ({ view: j.view, keys: j.on.map(p => p.right) }))
    ];
}

function compareKeys(spec: QuerySpec): QueryKey[] {
    return compareKeysByView(spec).flatMap(v => v.keys);
}

/** A column function as an engine Expr around `x` (column-functions.ts columnFnSql, function for function). */
export function fnExpr(x: Expr, f: ColumnFn): Expr {
    switch (f.fn) {
        case 'trim': return { fn: 'TRIM', args: [x] };
        case 'upper': return { fn: 'UPPER', args: [x] };
        case 'lower': return { fn: 'LOWER', args: [x] };
        case 'text': return { fn: 'TEXT', args: [x] };
        case 'number': return { fn: 'NUMERIC', args: [x] };
        case 'ltrimZeros': return { fn: 'LTRIM', args: [x, { value: '0' }] };
        case 'first': return { fn: 'SUBSTR', args: [x, { value: 1 }, { value: wholeNumber(f.n) }] };
        case 'last': return { fn: 'SUBSTR', args: [x, { value: -wholeNumber(f.n) }] };
        case 'replace': return { fn: 'REPLACE', args: [x, { value: f.from }, { value: f.to }] };
        case 'translate': return { fn: 'TRANSLATE', args: [x, { value: lookupTableName(f.table) }, { value: f.from }, { value: f.to }] };
    }
}

/** A lookup table's name in the engine. */
export function lookupTableName(id: string): string {
    return `__lookup_${id}`;
}

/**
 * A calculated column's formula (formula.ts's tree) as an engine Expr: formulaSql, node for node.
 * `column(key)` gives a column's Expr. Every builder function is an engine function of the same
 * name; the engine's listed differences from SQLite apply (engine-types.ts). COMPARE has no single
 * value: its sides are columns of their own (resultColumns), as in formulaSql.
 */
export function formulaExpr(node: FormulaNode, column: (key: string) => Expr): Expr {
    const go = (n: FormulaNode): Expr => formulaExpr(n, column);
    switch (node.k) {
        case 'num': return { value: Number.isFinite(node.v) ? node.v : null };
        case 'str': return { value: node.v };
        case 'ref': return column(node.key);
        case 'neg': return { fn: 'NEG', args: [go(node.a)] };
        case 'bin': return { fn: node.op, args: [go(node.a), go(node.b)] };
        case 'fn': {
            if (node.name === 'COMPARE') throw new Error('Formula: COMPARE has no single value; write each side');
            if (!(FUNCTIONS as readonly string[]).includes(node.name)) throw new Error(`Formula: no function ${node.name}`);
            return { fn: node.name as FunctionName, args: node.args.map(go) };
        }
    }
}

/** A view's column with its functions, the first innermost. */
export function refExpr(ref: ColumnRef): Expr {
    return (ref.fns ?? []).reduce<Expr>((x, f) => fnExpr(x, f), { column: ref.column, of: ref.view });
}

/** How Results' rows come out of the engine's select: which of its columns is what. */
export interface CompareLayout {
    /** Results' columns (resultColumns(spec)). */
    columns: ColumnRef[];
    /** The compare's views, the Baseline first. */
    places: string[];
    /** For each place, its key's parts: their select column, and the key's separator (several parts joined as SQL's || would). */
    keyParts: { at: number[]; separator: string }[];
    /** For a Results column that is the compare's key (shown from whichever view has the record): the key's place pair. */
    keyColumnOf: (number | undefined)[];
    /** A compare's status columns (statusColumns), when asked for. */
    status?: StatusLayout;
}

/** The spec as an engine Query: the compare, then a select of Results' columns and each view's key parts. */
export function compareQuery(spec: QuerySpec): { query: Query; layout: CompareLayout } {
    const byView = compareKeysByView(spec);
    const places = byView.map(v => v.view);
    const columns = resultColumns(spec);
    // A key part per column of each pair's key (a key of two columns is two parts: they match as both)
    const keyExprs = byView.map(v => v.keys.flatMap(k => k.parts.map(p => (k.fns ?? []).reduce<Expr>((x, f) => fnExpr(x, f), refExpr(p)))));
    const select: { name: string; value: Expr }[] = columns.map((c, i) => ({ name: `c${i}`, value: refExpr(c) }));
    const keyParts = byView.map((v, p) => {
        const at = keyExprs[p].map((e, i) => { select.push({ name: `k${p}_${i}`, value: e }); return select.length - 1; });
        return { at, separator: v.keys.length === 1 && v.keys[0].parts.length > 1 ? v.keys[0].separator ?? '' : '' };
    });
    // Results' key column: a Baseline key column (no functions) shows whichever view's key the record has
    const first = spec.joins.find(j => j.kind === 'compare');
    const keyColumnOf = columns.map(c => {
        if (c.fns?.length || !first) return undefined;
        const pair = first.on.findIndex(p => p.left.parts.length === 1 && !p.left.fns?.length && p.left.parts[0].view === c.view && p.left.parts[0].column === c.column && !p.left.parts[0].fns?.length);
        return pair < 0 ? undefined : pair;
    });
    return {
        query: {
            steps: [
                { as: 'compare', compare: places, on: keyExprs, columns: [] },
                { as: 'rows', select: 'compare', columns: select }
            ],
            result: 'rows'
        },
        layout: { columns, places, keyParts, keyColumnOf }
    };
}

/** A key value as SQL's || makes it from its parts: blank when a part is blank. */
function joinedKey(parts: Value[], separator: string): Value {
    if (parts.length === 1) return parts[0];
    if (parts.some(p => p === null)) return null;
    return parts.map(p => String(p)).join(separator);
}

/** Results' rows and each row's key in each place, from the engine's rows (QuerySession.rows({ extra }) gives the same shape). */
export function resultRows(rows: Value[][], layout: CompareLayout): { rows: unknown[][]; keyValues: unknown[][] } {
    const outRows: unknown[][] = [];
    const keyValues: unknown[][] = [];
    for (const row of rows) {
        const keys = layout.keyParts.map(k => joinedKey(k.at.map(i => row[i]), k.separator));
        const shown = layout.columns.map((_, i) => {
            const pair = layout.keyColumnOf[i];
            if (pair === undefined || row[i] !== null) return row[i];
            // The key from whichever view has the record (COALESCE over the views' keys)
            for (const k of layout.keyParts) { const v = row[k.at[pair] ?? -1]; if (v !== null && v !== undefined) return v; }
            return null;
        });
        outRows.push(shown);
        keyValues.push(keys);
    }
    return { rows: outRows, keyValues };
}

/**
 * The compare summary's figures as the Join step reads them (QueryJoinStats per Compare join, by
 * its view): each later view's records against the Baseline on its own join's right side; the
 * Baseline's on every join's left side, against the whole compare (its records no other view
 * has, its repeats). Rows after: the compare's rows.
 */
export function compareJoinStats(stats: CompareStats, places: string[]): Map<string, QueryJoinStats> {
    const base = stats.perInput[0];
    const out = new Map<string, QueryJoinStats>();
    places.slice(1).forEach((view, i) => {
        const x = stats.perInput[i + 1];
        const ab = x.againstBaseline;
        const none = { oneToOne: 0, oneToMany: 0, manyToOne: 0, manyToMany: 0 };
        out.set(view, {
            leftRows: base.rows,
            leftMatched: base.rows - base.againstAll.onlyHere,
            rightRows: x.rows,
            rightMatched: ab.matched,
            rowsAfter: stats.rows,
            relationship: !ab.matched ? 'none' : ab.repeatedKeys ? 'oneToMany' : 'oneToOne',
            keys: { ...none, oneToOne: ab.oneToOne, oneToMany: ab.repeatedKeys, manyToOne: base.againstAll.repeatedKeys },
            typeMismatch: false,
            rows: { ...none, oneToOne: ab.oneToOne, manyToOne: base.againstAll.repeatedRecords },
            records: { ...none, oneToOne: ab.oneToOne, oneToMany: ab.repeatedRecords },
            leftBlank: 0,
            leftValues: 0,
            rightValues: 0,
            values: [],
            valuesTotal: 0
        });
    });
    return out;
}

/** A view's rows into the engine, its values as Query's tables hold them (yes/no as text, a whole number as one). */
export function loadView(engine: QueryEngine, viewId: string, columns: string[], rows: Record<string, unknown>[]): void {
    engine.load(viewId, { columns, rows: rows.map(r => columns.map(c => asColumnValue(r[c]))) });
}

/** Rows a piece of a view carries to the engine (a worker's message stays small; the page gives way between pieces). */
const PIECE = 20_000;

/** A view's rows into an engine host, a piece at a time. */
export async function loadViewInto(host: EngineHost, viewId: string, columns: string[], rows: Record<string, unknown>[]): Promise<void> {
    const piece = (from: number) => ({ columns, rows: rows.slice(from, from + PIECE).map(r => columns.map(c => asColumnValue(r[c]))) });
    if (rows.length <= PIECE) { await host.load(viewId, piece(0)); return; }
    await host.load(viewId, piece(0), { more: true });
    for (let from = PIECE; from < rows.length; from += PIECE) await host.append(viewId, piece(from), { last: from + PIECE >= rows.length });
}

/** A lookup table into an engine host (loadLookupTable's rows). */
export async function loadLookupInto(host: EngineHost, table: { id: string; columns: { id: string }[]; rows: Array<Record<string, string>> }): Promise<void> {
    const columns = table.columns.map(c => c.id);
    await host.load(lookupTableName(table.id), { columns, rows: table.rows.map(r => columns.map(c => (r[c] === undefined ? null : String(r[c])))) });
}

/** A compare run on the engine: Results' rows and key values, the Join step's figures, and the total. */
export interface CompareOnEngine {
    rows: unknown[][];
    keyValues: unknown[][];
    stats: Map<string, QueryJoinStats>;
    total: number;
    layout: CompareLayout;
}

/**
 * Runs any query (buildQuery): the views must be loaded (loadView). `onProgress` hears each stage;
 * `cancel` stops it (undefined is returned). The Join step's figures: a compare's from CompareStats,
 * each plain join's from its JoinStats (the values behind a count not yet: `values` empty). Throws
 * with the engine's words when the query can't run (the row limit among them).
 * `timings`: how long each part took, in ms, for the stage timings the setting logs.
 */
/** The engine refused a join past the row limit: which join of the spec, how many rows, and the figures counted until then. */
export class TooManyOnEngine extends Error {
    constructor(readonly tooMany: { join: number; rows: number; limit: number }, readonly stats: Map<string, QueryJoinStats>) {
        super(`Join ${tooMany.join + 1} would make ${tooMany.rows} rows`);
    }
}

/** A plain join's figures as the Join step reads them, with the values behind each count (the first 50 of each kind, as today). */
async function plainJoinStats(host: EngineHost, result: string, step: string, stats: JoinStats): Promise<QueryJoinStats> {
    const kinds: StatsWindow['kind'][] = ['onlyLeft', 'onlyRight', 'oneToOne', 'oneToMany', 'manyToOne', 'manyToMany'];
    const values = (await Promise.all(kinds.map(async kind => {
        const w = await host.stats(result, step, { kind, side: 'left', from: 0, count: 50 }) as Table;
        const parts = w.columns.length - 2;
        return w.rows.map(r => ({ key: r.slice(0, parts), left: Number(r[parts]), right: Number(r[parts + 1]) }));
    }))).flat();
    return { ...stats, typeMismatch: false, values };
}

/** The Join step's figures from a run: a compare's from CompareStats, each plain join's (its spec index's view) from its JoinStats. */
async function joinFigures(spec: QuerySpec, places: string[], get: (step: string) => Promise<JoinStats | CompareStats | undefined>, values?: (step: string, stats: JoinStats) => Promise<QueryJoinStats>): Promise<Map<string, QueryJoinStats>> {
    const compare = places.length ? await get('compare') as CompareStats | undefined : undefined;
    const out = compare ? compareJoinStats(compare, places) : new Map<string, QueryJoinStats>();
    const plain = spec.joins.filter(j => j.kind !== 'compare');
    for (const [i, j] of plain.entries()) {
        const st = await get(`join${i + 1}`) as JoinStats | undefined;
        if (st) out.set(j.view, values ? await values(`join${i + 1}`, st) : { ...st, typeMismatch: false, values: [] });
    }
    return out;
}

/** An engine as an EngineHost (tests and the VS Code host hand in the engine itself). */
const hostOf = (engine: QueryEngine | EngineHost): EngineHost => (engine instanceof QueryEngine ? localEngineHost(engine) : engine);

export async function runOnEngine(engineIn: QueryEngine | EngineHost, spec: QuerySpec, onProgress?: (p: Progress) => void, options?: { keep?: boolean; sort?: ShownSort | null; status?: PagedStatus; hold?: boolean }): Promise<(CompareOnEngine & { timings: [string, number][]; duplicates: number; notNumbers: NotNumbers; kept?: PagedResult; held?: PagedResult }) | undefined> {
    const timings: [string, number][] = [];
    let at = now();
    const lap = (what: string) => { const t = now(); timings.push([what, Math.round(t - at)]); at = t; };
    const engine = hostOf(engineIn);
    // Kept for Results' pages: as Results first asks for them (its sort, a compare's status columns), and in the
    // same run the rows alike in every column shown (Distinct's count): one run serves the Join step and Results
    // (a compare: held without its sort, its status worked out once; the sort then a run from it)
    const holding = !!options?.keep && !!options.status && !!options.hold;
    const built = options?.keep ? pagedQuery(spec, holding ? null : options.sort, undefined, holding ? { ...options.status!, filter: undefined } : options.status) : buildQuery(spec);
    const { layout } = built;
    const shownColumns = layout.columns.map((_, i) => ({ name: `c${i}`, value: { column: `c${i}` } as Expr }));
    const query: Query = options?.keep && !spec.distinct
        ? { steps: [...built.query.steps, { as: 'alike', group: 'rows', by: shownColumns, aggregates: [] }], result: built.query.result }
        : built.query;
    // Results' columns that read text as a number: their rows where it wasn't one, counted in the same run
    const counted = readsNumbersColumns(built.query);
    const out = await engine.run(query, { onProgress: p => { onProgress?.(p); }, ...(counted.length ? { countNotNumbers: counted } : {}), ...(holding ? { hold: true } : {}) });
    lap('engine run');
    if ('cancelled' in out) return undefined;
    if ('problems' in out) {
        // Past the row limit: which join (by the spec's numbering), and the figures counted until then
        const failing = out.problems.find(p => /^join\d+$/.test(p.step));
        if (failing && out.stats) {
            const plain = spec.joins.map((j, i) => ({ j, i })).filter(x => x.j.kind !== 'compare');
            const at = plain[Number(failing.step.slice(4)) - 1]?.i ?? 0;
            const stats = await joinFigures(spec, layout.places, async step => out.stats?.[step]);
            throw new TooManyOnEngine({ join: at, rows: (out.stats[failing.step] as JoinStats).rowsAfter, limit: ROW_LIMIT }, stats);
        }
        throw new Error(out.problems.map(p => p.message).join(' '));
    }
    let keep = false;
    try {
        const stats = await joinFigures(spec, layout.places, async step => await engine.stats(out.result, step) as JoinStats | CompareStats, (step, st) => plainJoinStats(engine, out.result, step, st));
        lap('statistics');
        if (options?.keep) {
            // Its rows stay in the engine, read a page at a time; the rows alike counted in the same run
            keep = true;
            const duplicates = spec.distinct ? 0 : (out.steps?.rows ?? out.total) - (out.steps?.alike ?? out.steps?.rows ?? out.total);
            const held = holding ? { id: out.result, total: out.total, layout } : undefined;
            // (Results' remembered sort, from the held rows)
            let kept: PagedResult = { id: out.result, total: out.total, layout };
            if (held && options.sort) {
                const sorted = await runPaged(engine, spec, options.sort, onProgress, undefined, options.status, held.id);
                if (!sorted) { await engine.release(held.id); return undefined; }
                kept = sorted;
                lap('sorted');
            }
            return { rows: [], keyValues: [], stats, total: out.total, layout, timings, duplicates, notNumbers: notNumbersOf(out.notNumbers, query), kept, ...(held ? { held } : {}) };
        }
        const read = await engine.read(out.result, 0, out.total);
        lap('read every row');
        const { rows, keyValues } = resultRows(read.rows, layout);
        lap('rows for Results');
        // Rows alike in every column shown: what Distinct would fold
        const seen = new Set<string>();
        for (const r of rows) seen.add(r.map(v => (v === null ? '\u0000' : typeof v === 'number' ? `n${v}` : `t${String(v)}`)).join('\u0001'));
        const duplicates = spec.distinct ? 0 : rows.length - seen.size;
        lap('rows alike');
        return { rows, keyValues, stats, total: out.total, layout, timings, duplicates, notNumbers: notNumbersOf(out.notNumbers, query) };
    } finally {
        if (!keep) await engine.release(out.result);
    }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Results' columns (by number) with rows where text read as a number wasn't one, and how many rows (James, 2026-11-21: blank, plus a count). */
export type NotNumbers = { column: number; rows: number }[];

/** The functions that read text as a number (engine-values.ts readNumberCounted). */
const READS_NUMBERS = new Set<string>(['+', '-', '*', '/', 'NEG', 'ROUND', 'ABS', 'FLOOR', 'CEIL', 'NUMBER', 'NUMERIC']);
const readsNumbers = (e: Expr): boolean => 'fn' in e && (READS_NUMBERS.has(e.fn) || e.args.some(readsNumbers));

/** Results' columns (c0, c1…) whose value reads text as a number somewhere: the ones worth counting. */
function readsNumbersColumns(query: Query): string[] {
    const select = [...query.steps].reverse().find((s): s is Extract<Query['steps'][number], { select: string }> => 'select' in s && s.columns.some(c => c.name === 'c0'));
    return select ? select.columns.filter(c => /^c\d+$/.test(c.name) && readsNumbers(c.value)).map(c => c.name) : [];
}

/** The run's counts for Results' columns, by column number. */
function notNumbersOf(noted: Record<string, Record<string, number>> | undefined, query: Query): NotNumbers {
    const step = query.result ?? '';
    return Object.entries(noted?.[step] ?? {}).filter(([name]) => /^c\d+$/.test(name)).map(([name, rows]) => ({ column: Number(name.slice(1)), rows }));
}

/**
 * Runs the compare: the views must be loaded (loadView). `onProgress` hears each stage; `cancel`
 * stops it (undefined is returned). Throws with the engine's words when the query can't run.
 */
export async function runCompareOnEngine(engineIn: QueryEngine | EngineHost, spec: QuerySpec, onProgress?: (p: Progress) => void): Promise<CompareOnEngine | undefined> {
    const engine = hostOf(engineIn);
    const { query, layout } = compareQuery(spec);
    const out = await engine.run(query, { onProgress });
    if ('cancelled' in out) return undefined;
    if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
    try {
        const stats = await engine.stats(out.result, 'compare') as CompareStats;
        const read = await engine.read(out.result, 0, out.total);
        const { rows, keyValues } = resultRows(read.rows, layout);
        return { rows, keyValues, stats: compareJoinStats(stats, layout.places), total: out.total, layout };
    } finally {
        await engine.release(out.result);
    }
}

/* ---------- Any query: plain joins, a view brought in beside a compare, calculated columns, Distinct ---------- */

/** The first of `values` that is not blank: COALESCE, as IF(x = x, x, …) (x = x is blank only when x is). */
function coalesce(values: Expr[]): Expr {
    return values.reduceRight<Expr | undefined>((rest, x) => (rest ? { fn: 'IF', args: [{ fn: '=', args: [x, x] }, x, rest] } : x), undefined) ?? { value: null };
}

/**
 * One side of a join pair as an Expr: a column, or several joined end to end with the separator
 * as SQL's || joins them (blank when any is blank), then the key's own functions.
 */
export function keyExpr(key: QueryKey): Expr {
    const parts = key.parts.map(refExpr);
    let joined: Expr;
    if (parts.length === 1) joined = parts[0];
    else {
        const pieces = key.separator ? parts.flatMap((p, i) => (i ? [{ value: key.separator! } as Expr, p] : [p])) : parts;
        const known = parts.length === 1 ? { fn: '=' as const, args: [parts[0], parts[0]] } : { fn: 'AND' as const, args: parts.map(p => ({ fn: '=' as const, args: [p, p] })) };
        joined = { fn: 'IF', args: [known, { fn: 'CONCAT', args: pieces }] };
    }
    return (key.fns ?? []).reduce<Expr>((x, f) => fnExpr(x, f), joined);
}

/** Why a query can't run on the engine yet (whatever its kind), or undefined. */
export function whyNotQueryOnEngine(spec: QuerySpec): string | undefined {
    if (!spec.views.length) return 'it has no views';
    if ((spec.calc ?? []).some(c => !c.formula)) return 'it has a calculated column written as SQL';
    if (spec.joins.some(j => !j.on.length || j.on.some(p => !p.left.parts.length || !p.right.parts.length))) return 'a join has no key yet';
    return undefined;
}

/**
 * Any query as an engine Query: a compare step over the compare's views (when it is one), then each
 * other join in order on what came before, then a select of Results' columns (calculated ones by
 * their formula, a compare's key from whichever view has the record) and each compare view's key;
 * Distinct a group by every column.
 */
export function buildQuery(spec: QuerySpec, options?: { status?: StatusPlaces }): { query: Query; layout: CompareLayout } {
    const steps: Query['steps'] = [];
    const byView = compareKeysByView(spec);
    const places = byView.map(v => v.view);
    let base = spec.views[0].id;
    const keyExprs = byView.map(v => v.keys.flatMap(k => k.parts.map(p => (k.fns ?? []).reduce<Expr>((x, f) => fnExpr(x, f), refExpr(p)))));
    if (byView.length) {
        steps.push({ as: 'compare', compare: places, on: keyExprs, columns: [] });
        base = 'compare';
    }
    spec.joins.filter(j => j.kind !== 'compare').forEach((j, i) => {
        steps.push({ as: `join${i + 1}`, join: j.kind as 'inner' | 'left' | 'right' | 'outer', left: base, right: j.view, on: j.on.map(p => ({ left: keyExpr(p.left), right: keyExpr(p.right) })) });
        base = `join${i + 1}`;
    });
    const columns = resultColumns(spec);
    const formulaCols = formulaColumns(spec);
    const byKey = (key: string): Expr => { const at = key.indexOf('\n'); return { column: key.slice(at + 1), of: key.slice(0, at) }; };
    const first = spec.joins.find(j => j.kind === 'compare');
    const keyColumnOf = columns.map(c => {
        if (c.view === CALC_VIEW || c.fns?.length || !first) return undefined;
        const pair = first.on.findIndex(p => p.left.parts.length === 1 && !p.left.fns?.length && p.left.parts[0].view === c.view && p.left.parts[0].column === c.column && !p.left.parts[0].fns?.length);
        return pair < 0 ? undefined : pair;
    });
    const valueOf = (c: ColumnRef, i: number): Expr => {
        if (c.view !== CALC_VIEW) {
            const pair = keyColumnOf[i];
            // A compare's key column: whichever view's key the record has
            if (pair !== undefined) return coalesce([refExpr(c), ...byView.slice(1).map(v => v.keys[pair]).filter(Boolean).map(keyExpr)]);
            return refExpr(c);
        }
        // A calculated column (a COMPARE formula a column per side: "name 1", "name 2"…)
        const calc = spec.calc?.find(x => x.name === c.column) ?? spec.calc?.find(x => c.group === x.name);
        if (!calc?.formula) throw new Error(`Query: no calculated column "${c.column}"`);
        const parsed = parseFormula(calc.formula, formulaCols);
        const side = c.group === calc.name && parsed.compare ? parsed.compare[Number(/ (\d+)$/.exec(c.column)?.[1] ?? 1) - 1] : parsed.tree;
        return formulaExpr(side, byKey);
    };
    const select: { name: string; value: Expr }[] = columns.map((c, i) => ({ name: `c${i}`, value: valueOf(c, i) }));
    const keyParts = byView.map((v, p) => {
        const at = keyExprs[p].map((e, i) => { select.push({ name: `k${p}_${i}`, value: e }); return select.length - 1; });
        return { at, separator: v.keys.length === 1 && v.keys[0].parts.length > 1 ? v.keys[0].separator ?? '' : '' };
    });
    // Each row's status, worked out as Results works it out (statusColumns), when asked for
    let status: StatusLayout | undefined;
    if (options?.status && byView.length) {
        const made = statusColumns(spec, select.slice(0, columns.length).map(c => c.value), places, options.status);
        select.push(...made.columns);
        status = made.layout;
    }
    steps.push({ as: 'rows', select: base, columns: select });
    if (spec.distinct) steps.push({ as: 'distinct', group: 'rows', by: select.map(c => ({ name: c.name, value: { column: c.name } })), aggregates: [] });
    return {
        query: { steps, result: spec.distinct ? 'distinct' : 'rows' },
        // (the keys already shown by a compare's key column: resultRows leaves them as they are)
        layout: { columns, places, keyParts, keyColumnOf: columns.map(() => undefined), ...(status ? { status } : {}) }
    };
}

/**
 * A compare's status on Results, worked out by the engine as Results has always worked it out
 * (query-status.ts rowStatus), equal by the engine's sameValue (42 and "42" alike, as rowStatus's
 * text; "042" and 42 not): each compared column's
 * cells measured against its first cell that is shown and whose view has the record; which places
 * differ, which compare views lack the record, which repeat the key, the relation. Cells may be any
 * column of the query: a compare view's, a view joined beside it, a COMPARE calculation's side.
 */
export interface StatusPlaces {
    /** A compare view's place on Results (BL, C1…). */
    label: (view: string) => string;
    /** A Results column's place, as rowStatus names it (a view's place, a calculation's side). */
    placeOfColumn: (column: number) => string;
    /** Places hidden on Results: left out of every status. */
    hidden: string[];
}

/** The status columns a select adds (statusColumns) and where they are. */
export interface StatusLayout {
    /** Compare views (ids), their places. */
    places: string[];
    labels: string[];
    /** Places a cell can differ in, in order. */
    diffPlaces: string[];
    groups: string[];
    hidden: string[];
}

const known = (e: Expr): Expr => ({ fn: '=', args: [e, e] });
const not = (e: Expr): Expr => ({ fn: 'NOT', args: [e] });
const and = (parts: Expr[]): Expr => (parts.length === 0 ? { value: 1 } : parts.length === 1 ? parts[0] : { fn: 'AND', args: parts });
const or = (parts: Expr[]): Expr => (parts.length === 0 ? { value: 0 } : parts.length === 1 ? parts[0] : { fn: 'OR', args: parts });
const ifThen = (test: Expr, then: Expr, otherwise: Expr): Expr => ({ fn: 'IF', args: [test, then, otherwise] });
/** Two cells differ: not sameValue; a blank and a value differ; two blanks don't. 1 or 0, never blank. */
const differ = (a: Expr, b: Expr): Expr => ifThen(known(a), ifThen(known(b), { fn: '<>', args: [a, b] }, { value: 1 }), ifThen(known(b), { value: 1 }, { value: 0 }));
const yes = (e: Expr): Expr => ifThen(e, { value: 1 }, { value: 0 });

/** The status columns for a select over a compare (named s_…), from Results' columns' values. */
function statusColumns(spec: QuerySpec, values: Expr[], places: string[], where: StatusPlaces): { columns: { name: string; value: Expr }[]; layout: StatusLayout } {
    const labels = places.map(where.label);
    const shown = (place: string) => !where.hidden.includes(place);
    const own = (name: string): Expr => ({ column: name, of: 'compare' });
    const missing = (p: number): Expr => ({ fn: '=', args: [own(`missing:${places[p]}`), { value: 1 }] });
    // A record whose key is blank (James, 2026-11-21): its own status, No key, when the result holding it is shown
    const holders = places.map((_, p) => p).filter(p => shown(labels[p]));
    const keyIsBlank: Expr = { fn: '=', args: [own('status'), { value: 'noKey' }] };
    const noKey = and([keyIsBlank, or(holders.map(p => not(missing(p))))]);
    const columns: { name: string; value: Expr }[] = [];
    const resultCols = resultColumns(spec);
    // Each compared column: its cells (shown), each present when its view has the record; a cell differs from the first present
    const groups = comparedGroups(resultCols);
    const diffPlaces: string[] = [];
    const placeFlags = new Map<string, Expr[]>();
    groups.forEach((g, gi) => {
        const cells = g.cells.filter(i => shown(where.placeOfColumn(i)));
        const present = cells.map(i => { const p = places.indexOf(resultCols[i].view); return p >= 0 ? not(missing(p)) : { value: 1 } as Expr; });
        const flags = cells.map((i, k) => {
            if (k === 0) return { value: 0 } as Expr;
            const firstIs = (j: number) => and([present[j], not(or(present.slice(0, j)))]);
            return yes(and([not(noKey), present[k], or(cells.slice(0, k).map((jCol, j) => and([firstIs(j), differ(values[i], values[jCol])])))]));
        });
        columns.push({ name: `s_g${gi}`, value: yes(or(flags)) });
        cells.forEach((i, k) => {
            const place = where.placeOfColumn(i);
            if (!placeFlags.has(place)) { placeFlags.set(place, []); diffPlaces.push(place); }
            placeFlags.get(place)!.push(flags[k]);
        });
    });
    diffPlaces.forEach((place, k) => columns.push({ name: `s_dp${k}`, value: yes(or(placeFlags.get(place)!)) }));
    places.forEach((v, p) => {
        columns.push({ name: `s_missing${p}`, value: ifThen(noKey, { value: 0 }, own(`missing:${v}`)) });
        columns.push({ name: `s_repeated${p}`, value: own(`repeated:${v}`) });
    });
    const shownMissing = places.map((_, p) => p).filter(p => shown(labels[p])).map(missing);
    const shownRepeated = places.map((_, p) => p).filter(p => shown(labels[p])).map(p => ({ fn: '=', args: [own(`repeated:${places[p]}`), { value: 1 }] } as Expr));
    const anyDiff = or(groups.map((_, gi) => ({ fn: '=', args: [{ column: `s_g${gi}` }, { value: 1 }] } as Expr)));
    // (worked out from the columns above: the select's own columns can't be read in it, so again from their parts)
    const groupFlags = columns.filter(c => /^s_g\d+$/.test(c.name)).map(c => ({ fn: '=', args: [c.value, { value: 1 }] } as Expr));
    void anyDiff;
    columns.push({ name: 's_diff', value: yes(or(groupFlags)) });
    columns.push({ name: 's_same', value: yes(and([not(or(groupFlags)), not(or(shownMissing))])) });
    // (No key's place: the shown result holding the record)
    columns.push({ name: 's_nokey', value: holders.reduceRight<Expr>((rest, p) => ifThen(and([keyIsBlank, not(missing(p))]), { value: labels[p] }, rest), { value: null }) });
    // Relation: a shown Baseline without the record, only in another; a shown view without it, only in the Baseline; a shown view repeating the key, one to many
    const baseShown = shown(labels[0]);
    columns.push({
        name: 's_relation',
        value: ifThen(baseShown ? missing(0) : { value: 0 }, { value: 'onlyOther' }, ifThen(or(shownMissing), { value: 'onlyBase' }, ifThen(or(shownRepeated), { value: 'oneToMany' }, { value: 'oneToOne' })))
    });
    return { columns, layout: { places, labels, diffPlaces, groups: groups.map(g => g.name), hidden: where.hidden } };
}

/** A row's status (rowStatus's shape) from its status columns, by name. */
export function statusOfRow(get: (name: string) => Value, st: StatusLayout): RowStatus {
    const shown = (place: string) => !st.hidden.includes(place);
    const out: RowStatus = {
        diff: st.diffPlaces.filter((_, k) => get(`s_dp${k}`) === 1),
        missing: st.labels.filter((l, p) => shown(l) && get(`s_missing${p}`) === 1),
        groups: st.groups.filter((_, g) => get(`s_g${g}`) === 1)
    };
    const noKey = get('s_nokey');
    if (typeof noKey === 'string') out.noKey = noKey;
    out.relation = get('s_relation') as RelationKind;
    const repeated = st.labels.filter((l, p) => shown(l) && get(`s_repeated${p}`) === 1);
    if (repeated.length) out.repeated = repeated;
    return out;
}

/** Results' status filter (the Status ticks, a column's DIFF pill, the relations) as an engine filter over the status columns. */
export function statusFilterExpr(filter: StatusFilter, st: StatusLayout): Expr | undefined {
    const is = (column: string, v: Value): Expr => ({ fn: '=', args: [{ column }, { value: v }] });
    const all: Expr[] = [];
    if (filter.kinds) {
        const kinds: Expr[] = [];
        if (filter.kinds.includes('diff')) kinds.push(is('s_diff', 1));
        if (filter.kinds.includes('same')) kinds.push(is('s_same', 1));
        if (filter.kinds.includes('noKey')) kinds.push(known({ column: 's_nokey' }));
        st.labels.forEach((l, p) => { if (!st.hidden.includes(l) && filter.kinds!.includes(`missing:${l}`)) kinds.push(is(`s_missing${p}`, 1)); });
        all.push(or(kinds));
    }
    if (filter.columns?.length) all.push(or(filter.columns.map(c => st.groups.indexOf(c)).filter(g => g >= 0).map(g => is(`s_g${g}`, 1))));
    if (filter.relations) all.push(or(filter.relations.map(r => is('s_relation', r))));
    return all.length ? and(all) : undefined;
}

const RELATIONS: RelationKind[] = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'];

/** The Status menu's counts (statusCounts'), as a group over the status columns: one row of sums. */
export function statusCountsStep(input: string, st: StatusLayout): Query['steps'][number] {
    const sumOf = (name: string, e: Expr) => ({ name, fn: 'sum' as const, value: e });
    const is = (column: string, v: Value): Expr => ({ fn: '=', args: [{ column }, { value: v }] });
    return {
        as: 'counts', group: input, by: [],
        aggregates: [
            { name: 'all', fn: 'count' },
            sumOf('diff', { column: 's_diff' }),
            sumOf('same', { column: 's_same' }),
            sumOf('nokey', yes(known({ column: 's_nokey' }))),
            ...st.places.map((_, p) => sumOf(`missing${p}`, { column: `s_missing${p}` })),
            ...RELATIONS.map(r => sumOf(`rel_${r}`, is('s_relation', r))),
            ...st.groups.map((_, g) => sumOf(`g${g}`, { column: `s_g${g}` }))
        ]
    };
}

/** The counts' row as statusCounts gave them (a count only where there is one). */
export function statusCountsOf(row: Value[], st: StatusLayout): StatusCounts {
    const n = st.places.length;
    const num = (v: Value) => (typeof v === 'number' ? v : 0);
    const out: StatusCounts = { all: num(row[0]), diff: num(row[1]), same: num(row[2]), missing: {}, relations: {}, columns: {} };
    if (num(row[3])) out.noKey = num(row[3]);
    st.labels.forEach((l, p) => { const k = num(row[4 + p]); if (k && !st.hidden.includes(l)) out.missing[l] = k; });
    RELATIONS.forEach((r, i) => { const k = num(row[4 + n + i]); if (k) out.relations[r] = k; });
    st.groups.forEach((g, i) => { const k = num(row[4 + n + 4 + i]); if (k) out.columns[g] = k; });
    return out;
}

/* ---------- The Columns step's and Results' small reads, on the engine ---------- */

/** A lookup table (Translate values) into the engine, under the name TRANSLATE reads: its columns by id, its values as text. */
export function loadLookupTable(engine: QueryEngine, table: { id: string; columns: { id: string }[]; rows: Array<Record<string, string>> }): void {
    const columns = table.columns.map(c => c.id);
    engine.load(lookupTableName(table.id), { columns, rows: table.rows.map(r => columns.map(c => (r[c] === undefined ? null : String(r[c])))) });
}

/** Each compare view's key (its first pair's, as compareKeySql), as an Expr over that view alone. */
export function compareKeyExprs(spec: QuerySpec): { view: string; expr: Expr }[] {
    return compareKeysByView(spec).filter(v => v.keys[0]).map(v => ({ view: v.view, expr: keyExpr(v.keys[0]) }));
}

/** The query's rows as buildQuery makes them, but with these columns: the calculation check's first rows. */
export function queryWithColumns(spec: QuerySpec, columns: Expr[]): Query {
    const { query } = buildQuery({ ...spec, distinct: false });
    const last = query.steps[query.steps.length - 1] as Extract<Query['steps'][number], { select: string }>;
    return { steps: [...query.steps.slice(0, -1), { as: 'rows', select: last.select, columns: columns.map((value, i) => ({ name: `c${i}`, value })) }], result: 'rows' };
}

/** The label beside each line of the calculation check: a compare's key from whichever view has it, else the column. */
export function labelExpr(spec: QuerySpec, ref: ColumnRef): Expr {
    const keys = compareKeysByView(spec);
    const first = keys[0]?.keys.findIndex(k => k.parts.length === 1 && k.parts[0].view === ref.view && k.parts[0].column === ref.column && !k.fns?.length && !k.parts[0].fns?.length) ?? -1;
    if (first < 0) return refExpr(ref);
    return coalesce([refExpr(ref), ...keys.slice(1).map(v => v.keys[first]).filter(Boolean).map(keyExpr)]);
}

/** The function dialog's sample: a few different values of a view's column, as they are and as `fns` leave them; the record's own first. */
export function fnSampleQueries(view: string, column: string, fns: ColumnFn[], record: string): { few: Query; own: Query | undefined } {
    const plain: Expr = { column, of: view };
    const made = fns.reduce<Expr>((x, f) => fnExpr(x, f), plain);
    const pick = { select: 'kept', columns: [{ name: 'plain', value: plain }, { name: 'made', value: made }] };
    return {
        few: { steps: [
            { from: view },
            { as: 'kept', filter: 'step 1', where: { fn: 'AND', args: [{ fn: '=', args: [plain, plain] }, { fn: '<>', args: [plain, { value: '' }] }] } },
            { as: 'picked', ...pick },
            { group: 'picked', by: [{ name: 'plain', value: { column: 'plain' } }, { name: 'made', value: { column: 'made' } }], aggregates: [] }
        ] },
        own: record ? { steps: [
            { from: view },
            { as: 'kept', filter: 'step 1', where: { fn: '=', args: [{ fn: 'TEXT', args: [plain] }, { value: record }] } },
            pick
        ] } : undefined
    };
}

/** The record window's records of one view: the rows whose key is the row's (up to five). */
export function recordQuery(view: string, key: Expr, value: Value): Query {
    return { steps: [{ from: view }, { filter: 'step 1', where: { fn: '=', args: [key, { value }] } }] };
}

/* ---------- Results by pages: its rows stay in the engine, read a window at a time ---------- */

/** Results' sort: a column of Results (its place), up or down. */
export interface ShownSort { column: number; dir: 'asc' | 'desc' }

/**
 * The query Results pages through: buildQuery; the search box's rows (a filter step by the host's
 * "search" row test, given `search`: query-search.ts); then sorted as Results sorts when a column is picked.
 */
export function pagedQuery(spec: QuerySpec, sort?: ShownSort | null, search?: unknown, status?: PagedStatus, held?: string): { query: Query; layout: CompareLayout } {
    const { query, layout } = buildQuery(spec, status ? { status } : undefined);
    // (from a compare held in the engine, its status worked out once: runHeld; else the whole query again)
    let base = held ? 'held' : query.result ?? 'rows';
    const steps: Query['steps'] = held ? [{ as: 'held', from: held }] : [...query.steps];
    if (search !== undefined) {
        steps.push({ as: 'found', filter: base, test: { name: 'search', arg: search } });
        base = 'found';
    }
    // Results' status filter, over the engine's status columns
    const kept = status?.filter && layout.status ? statusFilterExpr(status.filter, layout.status) : undefined;
    if (kept) {
        steps.push({ as: 'kept', filter: base, where: kept });
        base = 'kept';
    }
    if (sort && Number.isInteger(sort.column) && sort.column >= 0 && sort.column < layout.columns.length) {
        steps.push({ as: 'sorted', sort: base, by: [{ value: { column: `c${sort.column}` }, descending: sort.dir === 'desc', order: 'shown' }] });
        base = 'sorted';
    }
    return { query: { steps, result: base }, layout };
}

/** A compare's status on Results' pages: its places (StatusPlaces: names, hidden ones) and the Status filter. */
export interface PagedStatus extends StatusPlaces {
    filter?: StatusFilter;
}

/** The status counts (statusCounts') among the rows the search finds: the paged query up to its search, then a group over its status columns. */
export async function pagedCounts(engineIn: QueryEngine | EngineHost, spec: QuerySpec, search: unknown, status: PagedStatus, held?: string): Promise<StatusCounts | undefined> {
    const engine = hostOf(engineIn);
    const { query, layout } = pagedQuery(spec, null, search, { ...status, filter: undefined }, held);
    if (!layout.status) return undefined;
    const out = await engine.run({ steps: [...query.steps, statusCountsStep(query.result ?? 'rows', layout.status)], result: 'counts' });
    if (!('result' in out)) return undefined;
    try {
        const row = (await engine.read(out.result, 0, 1)).rows[0];
        return row ? statusCountsOf(row, layout.status) : undefined;
    } finally {
        await engine.release(out.result);
    }
}

/** A page of a compare's Results with each row's status (rowStatus's shape) and its place in the paged result. */
export async function readStatusPage(engineIn: QueryEngine | EngineHost, paged: PagedResult, offset: number, limit: number, status: PagedStatus): Promise<{ rows: unknown[][]; status: RowStatus[]; index: number[] }> {
    const window = await hostOf(engineIn).read(paged.id, offset, limit);
    const { rows } = resultRows(window.rows, paged.layout);
    const at = new Map(window.columns.map((c, i) => [c, i]));
    void status;
    return { rows, status: window.rows.map(r => statusOfRow(name => r[at.get(name) ?? -1] ?? null, paged.layout.status!)), index: window.rows.map((_, i) => offset + i) };
}

/** One row of a paged result by its place: Results' row and its key in each compare view (the record window). */
export async function readPagedRow(engineIn: QueryEngine | EngineHost, paged: PagedResult, index: number): Promise<{ row: unknown[]; keys: unknown[] } | undefined> {
    const window = await hostOf(engineIn).readRows(paged.id, [index]);
    if (!window.rows.length) return undefined;
    const { rows, keyValues } = resultRows(window.rows, paged.layout);
    return { row: rows[0], keys: keyValues[0] };
}

/** A query's rows kept in the engine for Results to page through. */
export interface PagedResult {
    id: string;
    total: number;
    layout: CompareLayout;
}

/** Runs a paged query: its result kept (release it when done); undefined when stopped. */
export async function runPaged(engineIn: QueryEngine | EngineHost, spec: QuerySpec, sort?: ShownSort | null, onProgress?: (p: Progress) => void, search?: unknown, status?: PagedStatus, held?: string): Promise<PagedResult | undefined> {
    const engine = hostOf(engineIn);
    const { query, layout } = pagedQuery(spec, sort, search, status, held);
    const out = await engine.run(query, { onProgress });
    if ('cancelled' in out) return undefined;
    if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
    return { id: out.result, total: out.total, layout };
}

/**
 * A compare held in the engine for Results (RunOptions.hold): every row and its status worked out
 * once, no sort, search or Status filter; Results' runs then start from it (pagedQuery's `held`).
 */
export async function runHeld(engineIn: QueryEngine | EngineHost, spec: QuerySpec, status: PagedStatus, onProgress?: (p: Progress) => void): Promise<PagedResult | undefined> {
    const engine = hostOf(engineIn);
    const { query, layout } = pagedQuery(spec, null, undefined, { ...status, filter: undefined });
    const out = await engine.run(query, { onProgress, hold: true });
    if ('cancelled' in out) return undefined;
    if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
    return { id: out.result, total: out.total, layout };
}

/** One page of Results from a paged result: the rows as Results shows them (keys left out). */
export async function readPage(engineIn: QueryEngine | EngineHost, paged: PagedResult, offset: number, limit: number): Promise<unknown[][]> {
    const window = await hostOf(engineIn).read(paged.id, offset, limit);
    return resultRows(window.rows, paged.layout).rows;
}

/** Every row of a paged result, a window at a time (export, Chain, totals): `each` hears each window. */
export async function eachPage(engineIn: QueryEngine | EngineHost, paged: PagedResult, each: (rows: unknown[][], offset: number) => void | Promise<void>, size = 20_000): Promise<void> {
    for (let offset = 0; offset < paged.total; offset += size) await each(await readPage(engineIn, paged, offset, size), offset);
}

/** Rows spread across a paged result, for what kind of values each column holds: 20 windows evenly apart (20 reads, not one per row). */
export async function spreadPage(engineIn: QueryEngine | EngineHost, paged: PagedResult, count: number): Promise<unknown[][]> {
    if (paged.total <= count) return readPage(engineIn, paged, 0, count);
    const windows = 20;
    const size = Math.ceil(count / windows);
    const out: unknown[][] = [];
    for (let i = 0; i < windows; i++) out.push(...await readPage(engineIn, paged, Math.floor((i * (paged.total - size)) / (windows - 1)), size));
    return out;
}

/** Results' totals as they were worked out on its rows: per column, the numbers' sum (blank when a value is text), to two places at most. */
export async function pagedTotals(engineIn: QueryEngine | EngineHost, paged: PagedResult): Promise<{ totals: (number | null)[]; places: number[] }> {
    const n = paged.layout.columns.length;
    const sums = new Array<number>(n).fill(0);
    const any = new Array<boolean>(n).fill(false);
    const text = new Array<boolean>(n).fill(false);
    const decimals = new Array<number>(n).fill(0);
    await eachPage(engineIn, paged, rows => {
        for (const row of rows) for (let c = 0; c < n; c++) {
            const v = row[c];
            if (text[c] || v === null || v === undefined || v === '') continue;
            if (typeof v !== 'number') { text[c] = true; continue; }
            sums[c] += v;
            any[c] = true;
            if (decimals[c] < 2 && !Number.isInteger(v)) decimals[c] = Math.max(decimals[c], Math.min(2, (String(v).split('.')[1] ?? '').length || 2));
        }
    });
    const places = decimals.map((d, c) => (text[c] ? 0 : d));
    return { totals: sums.map((sum, c) => (text[c] || !any[c] ? null : Math.round(sum * 10 ** places[c]) / 10 ** places[c])), places };
}

/**
 * The Columns step's sample record on the engine (sampleRow's): every view's columns as they are,
 * then `extra` (the report's columns after their functions), from the first row where every view
 * has its record (its plain joins as inner joins, no compare view missing), else the first row.
 */
export function sampleQueries(spec: QuerySpec, raw: ColumnRef[], extra: ColumnRef[]): { everyView: Query; any: Query } {
    const exprs = [...raw, ...extra].map(refExpr);
    const any = queryWithColumns(spec, exprs);
    const inner: QuerySpec = { ...spec, joins: spec.joins.map(j => (j.kind === 'compare' ? j : { ...j, kind: 'inner' as const })) };
    const places = compareKeysByView(spec).map(v => v.view);
    const flags: Expr[] = places.map(p => ({ column: `missing:${p}`, of: 'compare' }));
    const withFlags = queryWithColumns(inner, [...exprs, ...flags]);
    const n = exprs.length;
    const everyView: Query = places.length
        ? {
            steps: [
                ...withFlags.steps,
                { as: 'present', filter: 'rows', where: and(places.map((_, i) => ({ fn: '=', args: [{ column: `c${n + i}` }, { value: 0 }] } as Expr))) },
                { as: 'sample', select: 'present', columns: exprs.map((_, i) => ({ name: `c${i}`, value: { column: `c${i}` } })) }
            ],
            result: 'sample'
        }
        : queryWithColumns(inner, exprs);
    return { everyView, any };
}

/** Which kept result Results' rows are: the query, its sort, its search, a compare's hidden views and Status filter. */
export function resultsKey(specKey: string, sort: ShownSort | null | undefined, search: string, status: PagedStatus | undefined): string {
    return `${specKey}\n${JSON.stringify(sort ?? null)}${search ? `\n${search}` : ''}${status ? `\n${JSON.stringify([status.hidden, status.filter ?? null])}` : ''}`;
}
