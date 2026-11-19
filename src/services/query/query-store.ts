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
import type { ColumnRef, QueryCalc, QueryJoin } from './query-types';
import { isReservedWord } from './query-sql';

export const QUERIES_KEY = 'queries';
const ID_PREFIX = 'qry-';

/** A view of the query: a saved result of an endpoint, read through one of its Console Views. */
export interface QuerySource {
    /** The view's id within the query (joins and columns name it). */
    id: string;
    /** Its name, on its slot and in the SQL (Products.sku) and the search (@Products.sku): short, no spaces (cleanViewName). */
    name: string;
    /** The letter it went by before views had one name (see nameViews). */
    alias?: string;
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
    /** The user's own SQL: when set, Results shows what it makes, not what the steps write. */
    sql?: string;
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
    /** 'unticked': columns picked before a shared name was left unticked have had theirs unticked, once (untickClashes). */
    clashes?: 'unticked';
    /** 'unticked': columns picked before an empty column was left unticked have had theirs unticked, once (untickBlanks). */
    blanks?: 'unticked';
    /** 'names': each view has one short name, which the SQL uses (see nameViews). */
    letters?: 'abc' | 'names';
    /**
     * The furthest step reached while the query was being built (1 Views … 4 Results). A new query's
     * steps open one at a time; once it has reached Results they are all open. Absent: a query made
     * before this was kept, all open.
     */
    reached?: number;
}

/** How many views a query takes. */
export const MAX_QUERY_VIEWS = 10;
/** A view's name is short: it heads its slot, and the SQL writes it before every column. */
export const VIEW_NAME_MAX = 12;

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
    if (query.sql) query.sql = change(query.sql);
    if (query.search) query.search = change(query.search);
}

/**
 * Call a view something else. Its calculated columns, the user's own SQL and the saved search
 * follow. Returns why it can't be, or ''.
 */
export function renameView(query: SavedQuery, id: string, name: string): string {
    const source = query.sources.find(s => s.id === id);
    if (!source) return '';
    const problem = viewNameProblem(name, query.sources.filter(s => s !== source).map(s => s.name));
    if (problem) return problem;
    const was = source.name;
    source.name = name;
    delete source.alias;
    rewrite(query, text => renamed(text, was, name));
    return '';
}

/**
 * Views first went by a letter (stock AS a ... a.sku) beside a longer name. Now a view has one
 * short name and the SQL uses it. A query saved before is given names from what its views were
 * called, and its calculated columns, own SQL and search follow. True when it changed.
 */
export function nameViews(query: SavedQuery): boolean {
    if (query.letters === 'names') return false;
    query.letters = 'names';
    const moves: { letter: string; table: string; name: string }[] = [];
    const taken: string[] = [];
    for (const source of query.sources) {
        const name = guessViewName(source.name, taken);
        taken.push(name);
        moves.push({ letter: source.alias ?? '', table: source.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''), name });
        source.name = name;
        delete source.alias;
    }
    rewrite(query, text => {
        let out = text;
        // "stock AS a" becomes the name alone; then a letter before a column, then the table's old name
        for (const m of moves) if (m.table && m.letter) out = out.replace(new RegExp(`\\b${escaped(m.table)}\\s+AS\\s+${escaped(m.letter)}\\b`, 'gi'), `\u0000${m.name}\u0000`);
        for (const m of moves) if (m.letter) out = out.replace(new RegExp(`\\b${escaped(m.letter)}(?=\\.(?=["\\w]))`, 'gi'), `\u0000${m.name}\u0000`);
        return out.replace(/\u0000/g, '');
    });
    return true;
}

/**
 * A column whose name an earlier view has is left unticked, for the user to tick. A query whose
 * columns were picked before that still shows both: once, the later view's is unticked.
 * `columns`: each view's column names. True when the query changed.
 */
export function untickClashes(query: SavedQuery, columns: (viewId: string) => string[]): boolean {
    if (query.clashes === 'unticked') return false;
    query.clashes = 'unticked';
    if (!query.select?.length) return true;
    const earlier = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (const source of query.sources) {
        earlier.set(source.id, new Set(seen));
        columns(source.id).forEach(name => seen.add(name));
    }
    query.select = query.select.filter(c => !earlier.get(c.view)?.has(c.column));
    return true;
}

/**
 * A column with no value in any row is left unticked, for the user to tick. A query whose
 * columns were picked before that still shows them: once, they are unticked.
 * `empty`: each view's columns with no value. True when the query changed.
 */
export function untickBlanks(query: SavedQuery, empty: (viewId: string) => string[]): boolean {
    if (query.blanks === 'unticked') return false;
    query.blanks = 'unticked';
    if (!query.select?.length) return true;
    const kept = query.select.filter(c => !empty(c.view).includes(c.column));
    // Never down to nothing: a query shows at least what it showed
    if (kept.length) query.select = kept;
    return true;
}

/** Make a view the first: the one FROM reads, whose rows a LEFT JOIN keeps. */
export function moveViewFirst(query: SavedQuery, id: string): void {
    moveView(query, id, 0);
}

/**
 * Move a view to another place (0 is first: the one FROM reads). The others keep their order
 * round it. Each pair of columns stays, with whichever of its views is now further right: so a
 * view whose pairs all moved on has none, and waits for its columns to be picked.
 */
export function moveView(query: SavedQuery, id: string, to: number): void {
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

export function listQueries(state: QueryState): SavedQuery[] {
    const list = state.get<SavedQuery[]>(QUERIES_KEY);
    return Array.isArray(list) ? list.filter(q => q && typeof q.id === 'string' && Array.isArray(q.sources)) : [];
}

export function getQuery(state: QueryState, id: string): SavedQuery | undefined {
    return listQueries(state).find(q => q.id === id);
}

/** Save a query, newest first. */
export async function saveQuery(state: QueryState, query: SavedQuery): Promise<void> {
    await state.update(QUERIES_KEY, [query, ...listQueries(state).filter(q => q.id !== query.id)]);
}

export async function removeQuery(state: QueryState, id: string): Promise<void> {
    await state.update(QUERIES_KEY, listQueries(state).filter(q => q.id !== id));
}

function newId(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newSourceId(): string {
    return newId('v-');
}

/** A new, empty query: the Reporting list's New query. */
export async function createQuery(state: QueryState): Promise<SavedQuery> {
    const name = freeReportName(state, 'New query');
    const now = new Date().toISOString();
    const query: SavedQuery = { id: newId(ID_PREFIX), name, sources: [], joins: [], letters: 'names', reached: 1, createdAt: now, updatedAt: now };
    await saveQuery(state, query);
    return query;
}

export async function duplicateQuery(state: QueryState, id: string): Promise<SavedQuery | undefined> {
    const from = getQuery(state, id);
    if (!from) return undefined;
    const now = new Date().toISOString();
    const copy: SavedQuery = { ...JSON.parse(JSON.stringify(from)) as SavedQuery, id: newId(ID_PREFIX), name: freeReportName(state, `${from.name.slice(0, REPORT_NAME_MAX - 5)} copy`), createdAt: now, updatedAt: now };
    await saveQuery(state, copy);
    return copy;
}
