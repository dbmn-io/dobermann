// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The saved queries, on the Hub's Reporting list beside the compares. A query keeps which
 * results it reads (each through one Console View), how they join and which columns show. It
 * stores no rows: those stay in History.
 *
 * Kept in the same small state store as the compares and the Console's Views.
 */
import { freeReportName, REPORT_NAME_MAX } from '../compare/report-name';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { ColumnRef, QueryCalc, QueryJoin, QueryKey } from './query-types';
import { isReservedWord } from './query-sql';
import { readFolderQueries, removeFolderQuery, writeFolderQuery } from './query-folder';

export const QUERIES_KEY = 'queries';
const ID_PREFIX = 'qry-';

/** A view of the query: a saved result of an endpoint, read through one of its Console Views. */
export interface QuerySource {
    /** The view's id within the query (joins and columns name it). */
    id: string;
    /** Its name, on its slot and in the SQL (Products.sku) and the search (@Products.sku): short, no spaces (cleanViewName). */
    name: string;
    endpointId: string;
    endpointName: string;
    /** Its request ("GET /path") and its System's name, as they were when it was added. */
    request?: string;
    system?: string;
    view: string;
    executionId: string;
    isBatch: boolean;
    environment: string;
    executedAt: string;
    /**
     * A file from the user's computer, not a saved result (endpointId, executionId and view are
     * empty). Its rows are read when it is picked and kept on this computer (query-file-store),
     * not here: on another computer the query asks for the file.
     */
    file?: { name: string; sheet?: string };
    /** Hidden by the user: kept in the query, with its joins, but left out of what it makes until shown again. */
    off?: boolean;
    /**
     * Another run of the same endpoint and View as the view `runOf` (its first run, the BL): a
     * table of its own, always matched with the first by a Compare join on the same key column.
     * `run` is its name: C1, C2... The first run has neither; it is BL once it has a run.
     */
    runOf?: string;
    run?: string;
}

/** A run's name, or BL for the first run of a view that has runs, or '' for a view with none. */
export function runName(query: Pick<SavedQuery, 'sources'>, id: string): string {
    const source = query.sources.find(s => s.id === id);
    if (!source) return '';
    if (source.run) return source.run;
    return query.sources.some(s => s.runOf === id) ? 'BL' : '';
}

/** The next run's name for the view `of`: C1, C2... (never one already taken). */
export function nextRunName(query: Pick<SavedQuery, 'sources'>, of: string): string {
    const taken = new Set(query.sources.filter(s => s.runOf === of).map(s => s.run));
    let n = 1;
    while (taken.has(`C${n}`)) n++;
    return `C${n}`;
}

export interface SavedQuery {
    id: string;
    name: string;
    sources: QuerySource[];
    joins: QueryJoin[];
    /** The columns shown, in order. Absent: every column of every view. */
    select?: ColumnRef[];
    distinct?: boolean;
    /** Calculated columns, each an SQL expression. */
    calc?: QueryCalc[];
    /** Results as it was left: its search, its sort and whether totals show. */
    search?: string;
    sort?: { column: number; dir: 'asc' | 'desc' } | null;
    totals?: boolean;
    /** Results' column widths the user set, in px, by `view:column`. */
    widths?: Record<string, number>;
    createdAt: string;
    updatedAt: string;
    /** Rows the query made when it last ran (the Hub list's line). */
    rows?: number;
    /** Special characters switched off on this report after Results turned them on by itself (a DIFF only in spaces or blanks). */
    specialOff?: boolean;
    /** A compare's DIFF and Missing rows when Results last counted them all (the Hub list's line, #11). */
    found?: { diff: number; missing: number };
    /**
     * The furthest step reached while the query was being built (1 Views … 4 Results). A new query's
     * steps open one at a time; once it has reached Results they are all open. Absent: a query made
     * before this was kept, all open.
     */
    reached?: number;
    /** The old saved compare it was made from (query-from-compare.ts): opening that compare opens this. */
    fromCompare?: string;
    /** Said once when it next opens, then dropped (what a conversion could not keep). */
    notice?: string;
    /**
     * Results to add as it next opens (the Console's New Query / New Compare / Add to Compare): its screen adds them
     * as Add a view does (a run of a view already in it joins its compare), then drops this.
     */
    adding?: { endpointId: string; executionId: string; view: string }[];
    /** With `adding`: then offer its first view's other runs at once (New Compare). */
    pickRun?: boolean;
}

/** How many views a query takes. */
export const MAX_QUERY_VIEWS = 10;
/** A view's name is short: it heads its slot, and the SQL writes it before every column. */
/** A view's name at most: the slot shortens a long one with "…", the whole of it on hover. */
export const VIEW_NAME_MAX = 32;

/** A name as SQL takes it without quotes: letters, digits and _, a letter first, no longer than the slot shows. */
export function cleanViewName(text: string): string {
    return String(text ?? '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '').slice(0, VIEW_NAME_MAX);
}

/** Why a view can't be called `name`, or '' when it can. `others`: the names the query's other views have. */
export function viewNameProblem(name: string, others: string[]): string {
    if (!name) return 'A view needs a name.';
    if (name !== cleanViewName(name)) return `A name is letters, digits and _, a letter first, up to ${VIEW_NAME_MAX}.`;
    if (isReservedWord(name)) return `${name} is a word SQL keeps for itself. Pick another name.`;
    if (others.some(o => o.toLowerCase() === name.toLowerCase())) return `Another view is already called ${name}.`;
    return '';
}

/** The words a request's name starts with that say nothing about what it reads. */
const VERBS = /^(get|list|fetch|find|search|query|read|load|export|post|put)\s+(?=\S)/i;

/**
 * A name for a new view, from what it reads ("Get Products" is Products, "Bins.csv" was already
 * Bins): cleaned, and numbered when another view has it (Products2).
 */
/** The last word of a path that only says what to do: the word before it goes in front (inventory_search). */
const ACTION_WORDS = new Set(['save', 'search', 'find', 'list', 'export', 'query', 'bulk', 'all']);

/**
 * A new view's name, from what it reads: the last word of the request's path, a parameter
 * ({{sku}}, {id}, :id, a number) skipped; an action word (ACTION_WORDS) takes the word before it
 * in front; a View other than the default goes on the end. GET /inventory: inventory;
 * POST /inventory/search: inventory_search; View "Stock lines": inventory_StockLines.
 */
export function viewNameFromPath(path: string, view?: string): string {
    const words = String(path ?? '').split(/[?#]/)[0].split('/').map(w => w.trim())
        .filter(w => w && !/[{}$]/.test(w) && !w.startsWith(':') && !/^\d+$/.test(w));
    const word = (w: string | undefined): string => String(w ?? '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    let name = word(words.pop());
    if (ACTION_WORDS.has(name.toLowerCase()) && words.length) name = `${word(words.pop())}_${name}`;
    if (view && !/^(default|root|view)$/i.test(view.trim())) {
        const v = view.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
        if (v) name = name ? `${name}_${v}` : v;
    }
    return name;
}

export function guessViewName(from: string, others: string[]): string {
    const base = cleanViewName(String(from ?? '').trim().replace(VERBS, '')) || 'Data';
    const free = (name: string): boolean => !viewNameProblem(name, others);
    if (free(base)) return base;
    for (let n = 2; ; n++) {
        const name = `${base.slice(0, VIEW_NAME_MAX - String(n).length)}${n}`;
        if (free(name)) return name;
    }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with what it calls a view changed: before a column (old.sku), where FROM and JOIN name it, and after AS. */
function renamed(text: string, was: string, now: string): string {
    if (!was || was.toLowerCase() === now.toLowerCase()) return text;
    const old = escaped(was);
    return text
        .replace(new RegExp(`\\b${old}\\b(?=\\s*\\.)`, 'gi'), now)
        .replace(new RegExp(`(\\b(?:FROM|JOIN|AS)\\s+)${old}\\b`, 'gi'), `$1${now}`)
        .replace(new RegExp(`\\b${escaped(now)}\\s+AS\\s+${escaped(now)}\\b`, 'gi'), now);
}

function rewrite(query: SavedQuery, change: (text: string) => string): void {
    query.calc?.forEach(c => { c.expr = change(c.expr); });
    if (query.search) query.search = change(query.search);
}

/**
 * Call a view something else. Its calculated columns and the saved search follow. Returns why it can't be, or ''.
 */
export function renameView(query: SavedQuery, id: string, name: string): string {
    const source = query.sources.find(s => s.id === id);
    if (!source) return '';
    const problem = viewNameProblem(name, query.sources.filter(s => s !== source).map(s => s.name));
    if (problem) return problem;
    const was = source.name;
    source.name = name;
    rewrite(query, text => renamed(text, was, name));
    return '';
}

/** Make a view the first: the one FROM reads, whose rows a LEFT JOIN keeps. */
/**
 * A saved query made whole as it opens, so no shape it can be saved in leaves it stuck (2026-11-22: a support case is a
 * query the user can't edit their way out of). Every view after the first has exactly one join, in the views' order (a
 * join missing is made, empty: "Pick a column"; one for the first view, for a view no longer there, or said twice, goes);
 * a pair naming a view no longer there goes (the join asks for its columns again); a run of a view no longer there is a view of its own; the report's columns of a view
 * no longer there go; a compare's views come first (compareLeads). True when anything changed.
 */
export function repairQuery(query: SavedQuery): boolean {
    const before = JSON.stringify([query.sources, query.joins, query.select]);
    // Views: each once, each with an id
    const seen = new Set<string>();
    query.sources = (Array.isArray(query.sources) ? query.sources : []).filter(s => s && typeof s.id === 'string' && !seen.has(s.id) && !!seen.add(s.id));
    const ids = new Set(query.sources.map(s => s.id));
    for (const s of query.sources) {
        if (s.runOf && (!ids.has(s.runOf) || s.runOf === s.id)) { delete s.runOf; delete s.run; }
    }
    // (a run of a run: of the first run)
    for (const s of query.sources) {
        const head = s.runOf ? query.sources.find(h => h.id === s.runOf) : undefined;
        if (head?.runOf) s.runOf = head.runOf;
    }
    // A key side's parts, each naming a view
    const side = (k: unknown): QueryKey => {
        const key = (k ?? {}) as QueryKey;
        return { ...key, parts: (Array.isArray(key.parts) ? key.parts : []).filter(p => p && typeof p.view === 'string') };
    };
    const first = query.sources[0]?.id;
    const joins = new Map<string, QueryJoin>();
    for (const j of Array.isArray(query.joins) ? query.joins : []) {
        if (!j || !ids.has(j.view) || j.view === first || joins.has(j.view)) continue;
        const on = (Array.isArray(j.on) ? j.on : []).map(p => ({ left: side(p?.left), right: side(p?.right) }))
            // (a pair to a view no longer there: gone, the join asks for its columns again)
            .filter(p => p.left.parts.length > 0 && p.left.parts.every(c => ids.has(c.view)) && p.left.parts.every(c => c.view !== j.view))
            .map(p => ({ ...p, right: { ...p.right, parts: p.right.parts.length ? p.right.parts.map(c => ({ ...c, view: j.view })) : [{ view: j.view, column: '' }] } }));
        joins.set(j.view, { view: j.view, kind: j.kind || 'left', on });
    }
    query.joins = query.sources.slice(1).map(s => joins.get(s.id) ?? { view: s.id, kind: 'left', on: [] });
    if (query.select) query.select = query.select.filter(c => c && (!c.view || ids.has(c.view)));
    compareLeads(query);
    return JSON.stringify([query.sources, query.joins, query.select]) !== before;
}

/**
 * A compare's views lead (James, 2026-11-22): the engine works the compare out first and joins every other view to it,
 * so the Baseline is the first view and the compare's other views follow it. A view that came before them (added
 * first, the runs after it) moves after them, joined to the compare by its own columns; pairs it had turn round with it.
 * True when anything moved.
 */
export function compareLeads(query: SavedQuery): boolean {
    const compares = query.joins.filter(j => j.kind === 'compare');
    if (!compares.length) return false;
    const has = (id: string | undefined): id is string => !!id && query.sources.some(s => s.id === id);
    const baseline = compares[0].on[0]?.left.parts[0]?.view;
    if (!has(baseline)) return false;
    // (the compare's other views keep the order they have on screen)
    const inCompare = new Set([baseline, ...compares.map(j => j.view).filter(has)]);
    const members = [baseline, ...query.sources.map(s => s.id).filter(id => id !== baseline && inCompare.has(id))];
    if (members.every((id, i) => query.sources[i]?.id === id)) return false;
    // The Baseline made first: every join fits the new order (a pair to the view that was first now belongs to that view)
    if (query.sources[0]?.id !== baseline) reanchorView(query, baseline, 0);
    const byId = new Map(query.sources.map(s => [s.id, s]));
    query.sources = [...members.map(id => byId.get(id)!), ...query.sources.filter(s => !members.includes(s.id))];
    const joins = new Map(query.joins.map(j => [j.view, j]));
    query.joins = query.sources.slice(1).map(s => joins.get(s.id) ?? { view: s.id, kind: 'left', on: [] });
    return true;
}

export function moveViewFirst(query: SavedQuery, id: string): void {
    if (rebaseCompare(query, id)) return;
    if (changesCompareBaseline(query, id, 0)) return;
    reanchorView(query, id, 0);
}

/**
 * Would this move change which view is first while the query holds a compare, in a way that can't be done? Moves that
 * make another of the compare's views first are done by rebaseCompare; what is left (a view outside the compare made
 * first, or a compare whose views don't all have their key) is refused.
 */
export function changesCompareBaseline(query: SavedQuery, id: string, to: number): boolean {
    if (!query.joins.some(j => j.kind === 'compare')) return false;
    const at = query.sources.findIndex(s => s.id === id);
    const place = Math.max(0, Math.min(query.sources.length - 1, Math.floor(to)));
    if (at < 0 || !Number.isFinite(to) || place === at || (at !== 0 && place !== 0)) return false;
    const first = place === 0 ? id : query.sources[1]?.id;
    return !first || !canRebase(query, first);
}

/** The compare's views, the Baseline first, each with its key (one per key line), or nothing when a key is not whole. */
function compareKeys(query: SavedQuery): { view: string; key: QueryKey[] }[] | undefined {
    const compares = query.joins.filter(j => j.kind === 'compare');
    const first = compares[0];
    const baseline = first?.on[0]?.left.parts[0]?.view;
    if (!first || !baseline) return undefined;
    const lines = first.on.length;
    const out = [{ view: baseline, key: first.on.map(p => p.left) }, ...compares.map(j => ({ view: j.view, key: j.on.map(p => p.right) }))];
    const whole = (k: QueryKey) => k.parts.length > 0 && k.parts.every(p => !!p.column);
    return out.every(v => v.key.length === lines && v.key.every(whole)) ? out : undefined;
}

function canRebase(query: SavedQuery, id: string): boolean {
    const keys = compareKeys(query);
    return !!keys && keys.some(k => k.view === id) && keys[0].view !== id;
}

/**
 * Another of the compare's views made its Baseline (#7, 2026-11-22: as old Compare let any result be the Baseline): it
 * goes first; every other view of the compare, the old Baseline too, is compared with it on the same key lines, each
 * by its own columns; a run of the old Baseline's view becomes a run of the new one, the old Baseline its run in turn.
 * Joins outside the compare stay as they are. False (nothing changed) when it can't be: not in the compare, or a key
 * not whole yet.
 */
export function rebaseCompare(query: SavedQuery, id: string): boolean {
    if (!canRebase(query, id)) return false;
    const keys = compareKeys(query)!;
    const oldBase = keys[0].view;
    const newKey = keys.find(k => k.view === id)!.key;
    // The new Baseline first; the others keep their order
    const at = query.sources.findIndex(s => s.id === id);
    query.sources.unshift(...query.sources.splice(at, 1));
    const others = keys.filter(k => k.view !== id);
    const order = new Map(query.sources.map((s, i) => [s.id, i]));
    others.sort((a, b) => (order.get(a.view) ?? 0) - (order.get(b.view) ?? 0));
    const compareJoins: QueryJoin[] = others.map(k => ({
        view: k.view, kind: 'compare',
        on: newKey.map((left, i) => ({ left: JSON.parse(JSON.stringify(left)) as QueryKey, right: JSON.parse(JSON.stringify(k.key[i])) as QueryKey }))
    }));
    query.joins = [...compareJoins, ...query.joins.filter(j => j.kind !== 'compare')];
    // Runs: the new Baseline is its view's first run, the old Baseline the run it was (its label)
    const head = query.sources.find(s => s.id === id)!;
    if (head.runOf === oldBase) {
        const label = head.run;
        const old = query.sources.find(s => s.id === oldBase);
        query.sources.forEach(s => { if (s.runOf === oldBase) s.runOf = id; });
        delete head.runOf;
        delete head.run;
        if (old) { old.runOf = id; if (label) old.run = label; }
    }
    return true;
}

/**
 * Move a view to another place. Its join goes with it, as it is, and so do everyone else's (James, 2026-11-22: "moving
 * a view should move its joins"): only the order on screen changes, and the query joins each view once the views it
 * joins to are in, wherever they sit (the controller's spec). A move to or from the first place changes which view
 * FROM reads, so there the pairs are turned round as reanchorView does.
 */
export function moveView(query: SavedQuery, id: string, to: number): void {
    const at = query.sources.findIndex(s => s.id === id);
    const place = Math.max(0, Math.min(query.sources.length - 1, Math.floor(to)));
    if (at < 0 || !Number.isFinite(to) || place === at) return;
    // (in a compare, a move that makes another of its views first makes it the Baseline; the view moved then takes its place)
    if (query.joins.some(j => j.kind === 'compare') && (at === 0 || place === 0)) {
        if (changesCompareBaseline(query, id, to)) return;
        const first = place === 0 ? id : query.sources[1].id;
        rebaseCompare(query, first);
        if (place !== 0) { const now = query.sources.findIndex(s => s.id === id); query.sources.splice(place, 0, ...query.sources.splice(now, 1)); }
        return;
    }
    if (at === 0 || place === 0) { reanchorView(query, id, to); return; }
    query.sources.splice(place, 0, ...query.sources.splice(at, 1));
}

/**
 * Move a view to another place and make every join fit the new order (each pair with whichever of its views is now
 * further right; a view whose pairs all moved on has none, and waits for its columns to be picked). What making a
 * view the first does: FROM reads it.
 */
export function reanchorView(query: SavedQuery, id: string, to: number): void {
    const at = query.sources.findIndex(s => s.id === id);
    const place0 = Math.max(0, Math.min(query.sources.length - 1, Math.floor(to)));
    if (at < 0 || !Number.isFinite(to) || place0 === at) return;
    query.sources.splice(place0, 0, ...query.sources.splice(at, 1));
    const place = new Map(query.sources.map((s, i) => [s.id, i]));
    const kinds = new Map(query.joins.map(j => [j.view, j.kind]));
    const pairs = new Map<string, QueryJoin['on']>();
    for (const join of query.joins) {
        for (const pair of join.on) {
            const lefts = [...new Set(pair.left.parts.map(part => part.view))];
            const last = [join.view, ...lefts].reduce((a, b) => ((place.get(b) ?? -1) > (place.get(a) ?? -1) ? b : a));
            // Turned round when its left view is now the later one; a left side made of several views can't be
            if (last !== join.view && lefts.length > 1) continue;
            const kept = last === join.view ? pair : { left: pair.right, right: pair.left };
            pairs.set(last, [...(pairs.get(last) ?? []), kept]);
        }
    }
    query.joins = query.sources.slice(1).map(s => ({ view: s.id, kind: kinds.get(s.id) ?? 'left', on: pairs.get(s.id) ?? [] }));
}

export type QueryState = Pick<IKeyValueStore, 'get' | 'update'>;

export function isQueryId(id: string): boolean {
    return id.startsWith(ID_PREFIX);
}

const isSavedQuery = (q: unknown): q is SavedQuery =>
    !!q && typeof (q as SavedQuery).id === 'string' && Array.isArray((q as SavedQuery).sources);

/**
 * The saved queries, newest first. With a workspace folder (query-folder), the ones in its
 * Queries folder, which every app on that folder shares; without one, this app's state store.
 */
export function listQueries(state: QueryState): SavedQuery[] {
    const inFolder = readFolderQueries();
    if (inFolder) {
        return (inFolder.filter(isSavedQuery) as SavedQuery[])
            .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    }
    const list = state.get<SavedQuery[]>(QUERIES_KEY);
    return Array.isArray(list) ? list.filter(isSavedQuery) : [];
}

export function getQuery(state: QueryState, id: string): SavedQuery | undefined {
    return listQueries(state).find(q => q.id === id);
}

/** Save a query, newest first: its own file in the workspace folder, or the state store without one. */
export async function saveQuery(state: QueryState, query: SavedQuery): Promise<void> {
    if (writeFolderQuery(query)) return;
    await state.update(QUERIES_KEY, [query, ...listQueries(state).filter(q => q.id !== query.id)]);
}

export async function removeQuery(state: QueryState, id: string): Promise<void> {
    if (removeFolderQuery(id)) return;
    await state.update(QUERIES_KEY, listQueries(state).filter(q => q.id !== id));
}

function newId(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A new query's id. */
export function newQueryId(): string {
    return newId(ID_PREFIX);
}

export function newSourceId(): string {
    return newId('v-');
}

/** A new, empty query: the Reporting list's New query. */
export async function createQuery(state: QueryState): Promise<SavedQuery> {
    const name = freeReportName(state, 'New query');
    const now = new Date().toISOString();
    const query: SavedQuery = { id: newId(ID_PREFIX), name, sources: [], joins: [], reached: 1, createdAt: now, updatedAt: now };
    await saveQuery(state, query);
    return query;
}

/** A query copied out for support (Hub: Copy the query): what it is made of, no rows, no result data, nothing secret. */
export interface QueryCopy { kind: 'dbmn.query'; version: 1; copiedAt: string; query: Partial<SavedQuery> }

/**
 * A query as text to paste into an email or a file: its views (which endpoint, View and run each reads, by name and id),
 * joins, columns, calculated columns, search and sort. Never rows (a file view's rows stay on this computer), never
 * counts, and nothing from an environment: a query holds no tokens or credentials.
 */
export function queryForSupport(query: SavedQuery): QueryCopy {
    const keep = <T extends object>(o: T, keys: (keyof T)[]): Partial<T> => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) as Partial<T>;
    const sources = query.sources.map(s => keep(s, ['id', 'name', 'endpointId', 'endpointName', 'request', 'system', 'view', 'executionId', 'isBatch', 'environment', 'executedAt', 'file', 'off', 'runOf', 'run']) as QuerySource);
    return {
        kind: 'dbmn.query', version: 1, copiedAt: new Date().toISOString(),
        query: { ...keep(query, ['name', 'joins', 'select', 'distinct', 'calc', 'search', 'sort', 'totals', 'widths', 'createdAt', 'updatedAt']), sources }
    };
}

/**
 * A copied query made a saved one of this app's (Hub: Import a query): a new id and a free name; its views keep what
 * they read, and a run this computer doesn't have says so on its view (the query still opens, to look at and edit).
 * A problem is said in words for the user, and nothing is saved.
 */
export async function importQueryCopy(state: QueryState, text: string): Promise<{ query?: SavedQuery; problem?: string }> {
    let copy: Partial<QueryCopy> | undefined;
    try { copy = JSON.parse(String(text ?? '').trim()) as Partial<QueryCopy>; } catch { copy = undefined; }
    const q = copy?.query;
    if (!copy || copy.kind !== 'dbmn.query' || !q || !Array.isArray(q.sources) || !Array.isArray(q.joins)) {
        return { problem: 'That is not a copied query. Copy it again with Copy the query, and paste all of it.' };
    }
    if ((copy.version ?? 1) > 1) return { problem: 'This query was copied from a newer DBMN. Update DBMN, then import it.' };
    const now = new Date().toISOString();
    const query = {
        ...(JSON.parse(JSON.stringify(q)) as SavedQuery),
        id: newId(ID_PREFIX),
        name: freeReportName(state, String(q.name || 'Imported query').slice(0, REPORT_NAME_MAX)),
        createdAt: q.createdAt || now, updatedAt: now, reached: 4
    } as SavedQuery;
    repairQuery(query);
    await saveQuery(state, query);
    return { query };
}

export async function duplicateQuery(state: QueryState, id: string): Promise<SavedQuery | undefined> {
    const from = getQuery(state, id);
    if (!from) return undefined;
    const now = new Date().toISOString();
    const copy: SavedQuery = { ...JSON.parse(JSON.stringify(from)) as SavedQuery, id: newId(ID_PREFIX), name: freeReportName(state, `${from.name.slice(0, REPORT_NAME_MAX - 5)} copy`), createdAt: now, updatedAt: now };
    await saveQuery(state, copy);
    return copy;
}
