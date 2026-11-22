// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query: one saved query (query-store). Any number of views, each a saved result read through
 * one of its endpoint's Console Views, joined into one flat table the way SQL joins tables.
 * Shared by every host.
 *
 * Steps (the page's step bar): Views (which results, each through which View), Join (how each
 * view after the first meets the ones before it: LEFT JOIN or JOIN, ON pairs, with the counts
 * and the relationship each join makes, and a preview of the table as it forms), Columns (which
 * show, in what order) and Results.
 *
 * The clicks write SQL and SQLite runs it (services/query): the SQL the page shows is what ran.
 * Nothing here sends a request. Each view's rows are read from its run's saved responses and
 * loaded into a database that lives in memory only, so a query works on copies.
 */
import { getEndpointViewScopeKey } from '../../services/console/view-scope-key';
import type { SqlJsStatic } from 'sql.js';
import type { ScreenSession } from '../screen-session';
import type { ComparePorts } from '../compare/compare.ports';
import { buildConsoleReportConfig } from '../console/console-report-config';
import { ResponseDataExtractor } from '../../services/console/response-data-extractor';
import { ConsoleViewsStore } from '../../services/console/console-views-store';
import { buildCompareSide, CompareView } from '../../services/compare/compare-side';
import { isComparableRun } from '../../services/compare/compare-store';
import { QueryRowData, QuerySession } from '../../services/query/query-engine';
import type { TooManyRows } from '../../services/query/query-engine';
import { allColumns, columnSql, compareKeyColumnSql, compareKeySql, defaultColumns, formulaColumns, fromSql, joinKeyColumns, lookupsUsed, quoteName, quoteText, refNames, resultColumns as resultColumnRefs, tableNames, writeSql } from '../../services/query/query-sql';
import { FORMULA_FUNCTIONS, formulaSql, fullRef, fullText, parseFormula, shortRef, shortText } from '../../services/query/formula';
import type { FormulaNode } from '../../services/query/formula';
import { reportNameProblem } from '../../services/compare/report-name';
import { loadQueryFolder } from '../../services/query/query-folder';
import { cleanViewName, getQuery, rebaseCompare, repairQuery, guessViewName, viewNameFromPath, VIEW_NAME_MAX, MAX_QUERY_VIEWS, moveView, moveViewFirst, changesCompareBaseline, newSourceId, nextRunName, QuerySource, renameView, runName, saveQuery, SavedQuery } from '../../services/query/query-store';
import { columnTypes, spread, TYPE_SAMPLE, type ColumnType } from '../../services/query/column-types';
import { CALC_VIEW, QUERY_JOIN_KINDS } from '../../services/query/query-types';
import { comparableRuns, type RequestTemplates, type RunHeaderValue } from '../../services/compare/compare-runs';
import { alignCompareJoins, groupCompare, isCompare, MAX_COMPARE_VIEWS, queryCompare, runJoin } from '../../services/query/query-compare';
import { columnCellDiffs, comparedGroups, passes, rowStatus, statusCounts, type RowStatus, type StatusCounts, type StatusFilter } from '../../services/query/query-status';
import { resultWorkbook } from '../../services/query/query-export';
import { asColumnValue, lookupsIn } from '../../services/column-functions/column-functions';
import type { LookupTablesReader, LookupTableSummary } from '../../services/lookup-tables/lookup-tables';
import type { ColumnRef, QueryFn, QueryJoin, QueryJoinKind, QueryJoinStats, QueryKey, QuerySpec } from '../../services/query/query-types';
import { ConsoleExportService } from '../../services/console/export.service';
import type { ColumnDefinition } from '../../types/console-messages';
import { ConsoleChainHandler } from '../console/console-chain-handler';
import type { ChainHandoff } from '../../services/chain/chain-types';
import type { APIEndpointConfig } from '../../apiConfigManager';
import { isWorkbook, readFileSheets, readWorkbookSheet, workbookBytes, workbookSheets, QueryFileRows, QueryFileSheet } from '../../services/query/query-file';
import type { QueryFileStore } from '../../services/query/query-file-store';
import { localEngineHost, type EngineHost } from '../../services/engine/engine-host';
import { QueryEngine } from '../../services/engine/engine';
import { QUERY_ROW_TESTS, searchColumns, searchTest, type SearchArg } from './query-search';
import { compareKeyExprs, resultsKey, sampleQueries, pagedCounts, readPagedRow, readStatusPage, type PagedStatus, eachPage, runHeld, holdStatus, countAlike, fromKeptCompare, compareStepKey, buildQuery, SAMPLE_ROWS, type FullFigures, type SampleFacts, type StatusLayout, fnSampleQueries, formulaExpr, labelExpr, loadLookupInto, loadViewInto, onSqliteLine, pagedTotals, readPage, runPaged, spreadPage, type NotNumbers, type PagedResult, type ShownSort, queryWithColumns, recordQuery, compareKeyPartExprs, runOnEngine, TooManyOnEngine, whyNotQueryOnEngine, joinCountPlan, joinCountOf, joinCountRowsQuery, JOIN_STATUS, type JoinCount, type JoinCountKind } from '../../services/query/query-new-engine';
import type { CompareStats, Progress, Query as EngineQuery, TableWindow } from '../../services/engine/engine-types';


/** Query needs what Compare needs, and SQLite: the host starts sql.js its own way. */
export interface QueryPorts extends ComparePorts {
    sql(): Promise<SqlJsStatic>;
    /** A System's name, to tell the same path on two Systems apart. */
    systemName?(id: string): Promise<string | undefined>;
    /** Chain: Run Batch opens on an endpoint with the query's rows as its input. */
    openRunBatch?(endpoint: APIEndpointConfig, chain: ChainHandoff): Promise<void>;
    /** Where a file view's rows are kept on this computer, so the query opens and runs without the file. */
    queryFiles?: QueryFileStore;
    /** The lookup tables Translate values reads (Reporting's): shared live, a deleted one missing. */
    lookups?: LookupTablesReader;
    /** Open a lookup table in its own tab (from Translate values in the functions dialog). */
    openLookup?(id: string): Promise<void>;
    /** A new lookup table, empty, opened in its own tab ("+ New lookup table…" in Translate values' table picker). */
    newLookup?(): Promise<void>;
    /** Settings' "New compare engine (testing)", a development build's only: Query runs on the new engine. */
    newCompareEngine?(): boolean;
    /** Where the new engine runs: a worker of its own (the web app), or this thread when left out. */
    engineHost?(): EngineHost;
}

export interface QueryConfig {
    queryId: string;
    /** Where the tab opens: 'results' runs the query and shows only Results; anything else opens on Views. */
    start?: 'results' | 'match' | 'edit';
}

export type QueryMessage = { type: string; [key: string]: unknown };

/**
 * A compare's records worked out per second, and what each value costs in memory: on screen, Results'
 * first page of 4 x 105k (420,000 records) took 1.5 s from history and 1.8 s from a workbook (the
 * tester, 2026-11-22). For the estimate Results says before a large compare starts.
 */
const RECORDS_PER_SECOND = 250_000;
const BYTES_PER_VALUE = 24;
/** Past this the compare is refused in words: what a browser tab can hold, with room for the page. */
const TAB_BYTES = 3_000_000_000;

/** How large a compare is before it runs: its views, records, about how long and how much memory. */
function compareSize(spec: QuerySpec, rows: (id: string) => number): { views: number; records: number; seconds: number; bytes: number } {
    const views = spec.views.length;
    const records = spec.views.reduce((n, v) => n + rows(v.id), 0);
    const values = spec.views.reduce((n, v) => n + rows(v.id) * Math.max(1, v.columns.length), 0);
    // (the views' values, and the compare's own per row: which record of each view, its status)
    const bytes = values * BYTES_PER_VALUE + records * (16 + 4 * views);
    return { views, records, seconds: Math.max(1, Math.round(records / RECORDS_PER_SECOND)), bytes };
}

/** Distinct's count waits for Results to be left this long after a page (ms): a sort or filter clicked meanwhile goes first. */
const ALIKE_AFTER_MS = 1000;

/** A view's rows into the engine this many at a time (a file's, read whole: feedEngine). */
const FEED_ROWS = 20_000;
/** Search reads this many rows between giving way to the page. */
const SEARCH_CHUNK = 5000;
/** The Join step's preview. */
const PREVIEW_ROWS = 50;

function iso(d: unknown): string {
    if (d instanceof Date) return d.toISOString();
    return typeof d === 'string' ? d : '';
}

function rootView(responses: unknown[]): CompareView {
    const first = (responses.find(r => (r as { status?: string })?.status === 'completed') ?? responses[0]) as Record<string, unknown> | undefined;
    const data = first && typeof first === 'object' ? first : {};
    const columns = Object.keys(data)
        .filter(k => ['string', 'number', 'boolean'].includes(typeof data[k]))
        .map(id => ({ id, source: 'current' }));
    return { name: 'Root', rowBasis: 'root', columns };
}

/** A view's rows as loaded: its columns by the names the Console heads them with. */
interface LoadedView {
    columns: string[];
    /** Its rows; empty once the new engine holds them (`dropped`): read again from storage when needed (rowsOf). */
    rows: QueryRowData[];
    rowBasis: string;
    error?: string;
    /** Let go here, the engine has them: how many there were, and a value from each column. */
    dropped?: { count: number; samples: Map<string, string> };
}

/** A join pair as the page edits it: one column each side. */
interface PagePair {
    left: { view: string; column: string; fns?: QueryFn[] };
    right: { column: string; fns?: QueryFn[] };
}

/** How long a key must stay the same before the Join step counts again (several quick changes cost one count). */
const JOIN_COUNT_QUIET_MS = 500;

/** The Join step's counts as the page is sent them: each run or view against the Baseline, then Results' rows. */
interface JoinCounts {
    baseline: string;
    views: Record<string, { state: 'waiting' | 'counting' | 'done' | 'failed'; done?: number; total?: number; count?: JoinCount; stale?: boolean }>;
    results?: { state: 'counting' | 'done'; rows: number; inEvery: number; stale?: boolean };
}

/**
 * A view's join, in place of any it has. The first change that puts a view in already gives it an
 * empty join (repairQuery: every view after the first has one); the join made once its rows are
 * read takes that one's place, never sits beside it (repairQuery would keep the first, the empty one).
 */
function setJoin(q: SavedQuery, join: QueryJoin): void {
    q.joins = [...q.joins.filter(j => j.view !== join.view), join];
}

export class QueryController {
    private closed = false;
    private readonly views: ConsoleViewsStore;
    private readonly extractor: ResponseDataExtractor;
    private query: SavedQuery | undefined;
    private readonly loaded = new Map<string, LoadedView>();
    /** Each loaded view's rows with a value, by column (filledRows). */
    private readonly filled = new WeakMap<LoadedView, Map<string, number>>();
    private session: QuerySession | undefined;
    /** The views the session's tables were loaded for (ids and names): another set means loading again. */
    private sessionKey = '';
    /** Every row of the query as it stands, read once and windowed for the page. */
    private result: QueryResult | undefined;
    /**
     * The new engine (src/services/engine), with "New compare engine (testing)" on: the views loaded
     * into it (again when they change, as the SQLite session's), the run under way (for Stop), the
     * Join step's figures from its last run, and why a query runs on SQLite instead (a line on Join).
     */
    private engine: EngineHost | undefined;
    private engineKey = '';
    private engineRunning: string | undefined;
    private engineStats: Map<string, QueryJoinStats> | undefined;
    private engineNote = '';
    /** Results' rows kept in the engine (a query not a compare, no search): which query and sort, and the engine they are in. */
    private paged: { key: string; result: PagedResult; host: EngineHost } | undefined;
    /** Results' own run still going (a search or sort), which a newer one stops. */
    private pagedRunning: string | undefined;
    /** How many rows the query makes before any search (what "n of m" counts against). */
    private pagedAll: { key: string; total: number } | undefined;
    /** Rows alike in every column shown, from the last run: what Distinct would fold. */
    private engineDuplicates = 0;
    /** Results' columns where text read as a number wasn't one, from the last engine run (blank, plus a count). */
    private engineNotNumbers: NotNumbers = [];
    private engineOn = false;
    private filtered: { key: string; indices: number[]; searched?: number[] } | undefined;
    private searchSeq = 0;
    /** Counts each change: work for an older one is dropped. */
    private version = 0;
    /** Results as the page last asked for it: what Chain sends. */
    private shown: Pick<RowsRequest, 'search' | 'sort' | 'filter'> = {};
    /**
     * Chain, the Console's own (its handler here, its dialog on the page): Results' rows become a
     * Run Batch's input. A link needs a run to come from, so it is the first view's.
     */
    private readonly chain: ConsoleChainHandler;

    /** Lookup tables loaded in the session, by id: the version loaded (a table edited since is loaded again). */
    private lookupsLoaded = new Map<string, string>();
    private lookupList: LookupTableSummary[] = [];
    private stopLookups?: () => void;

    /** Translate values with no from or to yet: the table's first column becomes its second (until both are picked). */
    private withLookupColumns(fns: QueryFn[]): QueryFn[] {
        return fns.map(f => {
            if (f.fn !== 'translate') return f;
            const t = this.lookupList.find(x => x.id === f.table);
            const cols = t?.columns ?? [];
            return { ...f, from: f.from || cols[0]?.id || '', to: f.to || cols[1]?.id || cols[0]?.id || '' };
        });
    }

    /**
     * The lookup tables the query's functions read, loaded where it runs (each as it is now: an
     * edit is read again). One that has been deleted stops the query: it says so, and does not run.
     */
    private async loadLookups(session: QuerySession, spec: QuerySpec): Promise<void> {
        const used = lookupsUsed(spec);
        if (!used.length) return;
        if (!this.ports.lookups) throw new Error('This query translates values with a lookup table, and lookup tables are not available here.');
        for (const id of used) {
            const table = await this.ports.lookups.get(id);
            if (!table) throw new Error('A lookup table this query translates with has been deleted, so it can\'t run. Untick Translate values on its column, or pick another table.');
            if (this.lookupsLoaded.get(id) === table.updatedAt) continue;
            session.loadLookup(table);
            this.lookupsLoaded.set(id, table.updatedAt);
        }
    }

    /** The lookup tables the engine holds, by id: the version loaded. */
    private readonly engineLookups = new Map<string, string>();

    /** The lookup tables these functions read, into the engine (again when one changed). */
    private async loadEngineLookups(engine: EngineHost, ids: string[]): Promise<void> {
        if (!ids.length) return;
        if (!this.ports.lookups) throw new Error('This query translates values with a lookup table, and lookup tables are not available here.');
        for (const id of ids) {
            const table = await this.ports.lookups.get(id);
            if (!table) throw new Error('A lookup table this query translates with has been deleted, so it can\'t run. Untick Translate values on its column, or pick another table.');
            if (this.engineLookups.get(id) === table.updatedAt) continue;
            await loadLookupInto(engine, table);
            this.engineLookups.set(id, table.updatedAt);
        }
    }

    /** A few rows of a query on the engine (the Columns step's and the record window's small reads). */
    private async engineWindow(spec: QuerySpec, query: EngineQuery, count: number, extraView?: string): Promise<TableWindow> {
        const engine = await this.engineFor(spec);
        // (the compare the step last ran, when it compares the same: read from it, not made again)
        const kept = this.engineCompare && this.engineCompare.host === engine && this.engineCompare.views === this.engineKey ? this.engineCompare : undefined;
        query = fromKeptCompare(query, kept);
        // (a view not joined yet is read on its own: it goes in too)
        if (extraView && !spec.views.some(v => v.id === extraView)) {
            const loaded = this.loaded.get(extraView);
            if (loaded) await loadViewInto(engine, extraView, loaded.columns, await this.rowsOf(extraView));
        }
        const out = await engine.run(query);
        if ('cancelled' in out) return { columns: [], rows: [], total: 0 };
        if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
        try {
            return await engine.read(out.result, 0, count);
        } finally {
            await engine.release(out.result);
        }
    }

    constructor(private readonly session_: ScreenSession, private readonly ports: QueryPorts, private readonly config: QueryConfig) {
        // A lookup table edited or deleted (in Reporting): a query that reads it runs again
        this.stopLookups = ports.lookups?.onChange(change => {
            void this.ports.lookups?.list().then(list => { this.lookupList = list; });
            const { spec } = this.query ? this.spec() : { spec: undefined };
            if (!spec || !lookupsUsed(spec).includes(change.id)) return;
            this.lookupsLoaded.delete(change.id);
            this.engineLookups.delete(change.id);
            this.result = undefined;
            void this.refresh();
        });
        this.views = new ConsoleViewsStore({ state: ports.state, endpoints: ports.endpoints, log: m => ports.logger?.log(m) });
        this.extractor = new ResponseDataExtractor({ executionMetadataService: ports.metadata });
        this.chain = new ConsoleChainHandler({
            getTabRowsForChain: async () => {
                const shown = await this.shownRows(this.shown);
                if (!shown || !this.query) return null;
                const headings = columnHeadings(shown.columns, new Map(this.query.sources.map(s => [s.id, s.name])));
                const data: Record<string, unknown>[] = [];
                await shown.each(rows => { for (const row of rows) data.push(Object.fromEntries(row.map((value, c) => [`c${c}`, value]))); });
                return {
                    data,
                    columns: headings.map((name, c) => ({ id: `c${c}`, name, type: 'string' as const, sortable: false, filterable: false }))
                };
            },
            getChainSourceRef: () => {
                const from = this.query?.sources.find(s => !s.file);
                return { executionId: from?.executionId, endpointId: from?.endpointId };
            },
            toCsv: (data, columns) => new ConsoleExportService().exportToCsvString(data, columns, { includeHeaders: true, delimiter: ',', quoteChar: '"' } as never),
            // The dialog says the rows are the query's, not its first view's (so no warning about that one run's environment)
            post: async message => {
                const payload = message.payload as Record<string, unknown> | undefined;
                this.post(message.type === 'console.chainOptions' && payload
                    ? { ...message, payload: { ...payload, sourceEndpoint: this.query?.name, viewName: undefined, warnings: [], searchTerm: String(this.shown.search ?? '').trim() || undefined } }
                    : message);
            },
            notify: (level, text) => this.ports.toast[level](text),
            store: this.ports.metadata as never,
            endpoints: this.ports.endpoints as never,
            environments: this.ports.environments as never,
            openConsole: (id, isBatch) => this.ports.host.openConsole(id, isBatch),
            openRunBatch: async (endpoint, handoff) => {
                if (!this.ports.openRunBatch) throw new Error('This app cannot open Run Batch from here.');
                await this.ports.openRunBatch(endpoint, { ...handoff, sourceLabel: `Query: ${this.query?.name ?? ''}`, viewName: undefined });
            }
        });
    }

    dispose(): void {
        this.closed = true;
        this.stopJoinCount();
        if (this.alikeTimer) clearTimeout(this.alikeTimer);
        this.stopLookups?.();
        this.session_.dismissAll();
        this.session?.close();
        this.session = undefined;
        this.engine?.close();
        this.engine = undefined;
    }

    private post(message: Record<string, unknown>): void {
        if (!this.closed) this.session_.post(message);
    }

    async handleMessage(message: QueryMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'query.ready': return await this.open();
                // Its row in the Reporting list clicked again while the tab is open: Edit, or Run
                // A choice Results remembers for the user, for every query (Side by side or Compact)
                case 'query.preference': {
                    const key = String(message.key ?? '');
                    if (!QUERY_PREFERENCE_KEYS.includes(key)) return;
                    await this.ports.state.update(QUERY_PREFERENCES, { ...this.preferences(), [key]: message.value });
                    return;
                }
                // Special characters switched off on this report while Results had turned them on by itself: they stay off here
                case 'query.specialOff': return await this.change(q => { q.specialOff = true; }, false);
                case 'query.start': {
                    this.post({ type: 'query.goTo', start: message.start === 'results' ? 'results' : 'edit' });
                    // (opened again from the Console's Add to Compare: its result is added now)
                    return await this.addPending();
                }
                case 'query.sources': return await this.postSources();
                case 'query.addView': return await this.addView(message as unknown as { endpointId: string; executionId: string; view: string });
                // Change view (a slot's menu): the run, and its other runs, read again through another of its endpoint's Views
                case 'query.changeView': return await this.change(q => {
                    const head = q.sources.find(x => x.id === String(message.id));
                    if (!head) return;
                    const view = String(message.view ?? '');
                    [head, ...q.sources.filter(x => x.runOf === head.id)].forEach(x => { x.view = view; this.loaded.delete(x.id); });
                    this.result = undefined;
                });
                case 'query.addRun': return await this.addRun(String(message.of ?? ''), String(message.executionId ?? ''));
                // Several ticked in Add a view: each in turn (a query's and a compare's limits are checked one by one)
                case 'query.addViews': return await this.addViews((Array.isArray(message.items) ? message.items as { endpointId: string; executionId: string; view: string }[] : [])
                    .map(item => ({ endpointId: String(item.endpointId), executionId: String(item.executionId), view: String(item.view ?? '') })));
                case 'query.addRuns': {
                    for (const id of Array.isArray(message.executionIds) ? (message.executionIds as unknown[]).map(String) : []) await this.addRun(String(message.of ?? ''), id);
                    return;
                }
                case 'query.addFile': return await this.addFile(message as unknown as FileMessage);
                case 'query.addSheets': return await this.pickSheets(Array.isArray(message.sheets) ? message.sheets.map(String) : []);
                case 'query.fileData': return await this.fileAgain(message as unknown as FileMessage & { id: string });
                case 'query.removeView': return await this.change(q => {
                    const id = String(message.id);
                    // The compare's Baseline taken out: the next of its views is the Baseline first, so the compare keeps its key
                    const inCompare = queryCompare(q.joins, q.sources[0]?.id);
                    if (inCompare && inCompare.baseline === id && inCompare.views.length > 1) rebaseCompare(q, inCompare.views[1]);
                    // A view's runs stay: the first of them is the view's first run now
                    const runs = q.sources.filter(s => s.runOf === id);
                    if (runs.length) {
                        const head = runs[0];
                        delete head.runOf;
                        delete head.run;
                        runs.slice(1).forEach(r => { r.runOf = head.id; });
                    }
                    q.sources = q.sources.filter(s => s.id !== id);
                    q.joins = q.joins.filter(j => j.view !== id).map(j => ({ ...j, on: j.on.filter(p => p.left.parts.every(c => c.view !== id)) }));
                    q.select = q.select?.filter(c => c.view !== id);
                    this.loaded.delete(id);
                    void this.ports.queryFiles?.remove(q.id, id);
                });
                // A view's name is what the SQL calls it: its calculated columns, own SQL and search follow
                case 'query.renameView': return await this.change(q => {
                    const problem = renameView(q, String(message.id), cleanViewName(String(message.name ?? '')));
                    if (problem) this.ports.toast.warn(problem);
                });
                // The view FROM reads, whose rows a LEFT JOIN keeps. No join is made up: a view left with no pair asks for its columns
                case 'query.moveFirst': return await this.change(q => { this.sayBaselineStays(q, String(message.id), 0); moveViewFirst(q, String(message.id)); });
                // Hidden, or shown again: the view and its joins stay in the query either way
                case 'query.toggleView': return await this.change(q => { const s = q.sources.find(x => x.id === String(message.id)); if (s) { if (s.off) delete s.off; else s.off = true; } });
                // Dragged to another place on Views or Join: its pairs go with it
                case 'query.moveView': return await this.change(q => { this.sayBaselineStays(q, String(message.id), Number(message.to)); moveView(q, String(message.id), Number(message.to)); });
                case 'query.rename': return await this.change(q => {
                    // Refused, the box goes back to the name it has (query.named)
                    const name = String(message.name ?? '').trim();
                    if (!name || name === q.name) return;
                    const problem = reportNameProblem(this.ports.state, q.id, name);
                    if (problem) this.ports.toast.warn(problem);
                    else q.name = name;
                }, false);
                case 'query.setJoin': return await this.change(q => {
                    const join = q.joins.find(j => j.view === message.view);
                    if (!join) return;
                    const madeCompare = message.kind === 'compare' && join.kind !== 'compare';
                    // (Delete join deletes: Compare picked again starts a new, empty compare)
                    if (QUERY_JOIN_KINDS.includes(message.kind as QueryJoinKind)) {
                        const kind = message.kind as QueryJoinKind;
                        // A compare takes up to four views, the Baseline included
                        const inCompare = queryCompare(q.joins, q.sources[0]?.id)?.views.length ?? 1;
                        if (kind === 'compare' && join.kind !== 'compare' && inCompare >= MAX_COMPARE_VIEWS) {
                            this.ports.toast.warn(`A compare takes ${MAX_COMPARE_VIEWS} views. Take one out of it to put ${q.sources.find(s => s.id === join.view)?.name ?? 'this one'} in.`);
                            return;
                        }
                        join.kind = kind;
                    }
                    if (Array.isArray(message.on)) {
                        // A run's own column is its first run's, filled in below: its pairs need only their left side
                        // (and in a compare, a view read the same way as the Baseline takes its key column: picked once, on the Baseline)
                        const isRun = runsOf(q).has(join.view) || (join.kind === 'compare' && this.sameShapeAsBaseline(q, join.view));
                        join.on = (message.on as PagePair[]).filter(p => p?.left?.column && (p?.right?.column || isRun)).map(p => ({
                            left: { parts: [{ view: p.left.view, column: p.left.column, ...(p.left.fns?.length ? { fns: this.withLookupColumns(p.left.fns) } : {}) }] },
                            right: { parts: [{ view: join.view, column: p.right.column, ...(p.right.fns?.length ? { fns: this.withLookupColumns(p.right.fns) } : {}) }] }
                        }));
                    }
                    // One key across the compare: every Compare join after the first joins on the first one's key
                    alignCompareJoins(q.joins, runsOf(q));
                    // Views read the same way compare as one: made a Compare, they come in; the key is picked once
                    groupCompare(q.joins, this.shapes(q), madeCompare);
                    // (a pair said twice, as quick picks can send it, once)
                    // (in a compare, a key column said twice is one: the copy with its own column picked stays)
                    const said = (k: QueryKey): string => JSON.stringify(k.parts.map(x => [x.view, x.column, x.fns?.length ? x.fns : []]));
                    q.joins.forEach(j => {
                        const seen = new Map<string, number>();
                        const kept: typeof j.on = [];
                        for (const p of j.on) {
                            const k = j.kind === 'compare' ? said(p.left) : said(p.left) + said(p.right);
                            const at = seen.get(k);
                            if (at === undefined) { seen.set(k, kept.length); kept.push(p); continue; }
                            if (!kept[at].right.parts.some(x => x.column) && p.right.parts.some(x => x.column)) kept[at] = p;
                        }
                        j.on = kept;
                    });
                });
                // Delete join (the join-type menu): the views go back to not joined, out of the report until joined again
                // A compare's kind, from its one button: every join in it takes it, in one change
                // Stop (the Join step's counting): what is being worked out is left; the step says the counts were stopped
                // Count again, after Stop
                case 'query.recount': return await this.refresh();
                // Stop on Results' working line: its run (and the step's count it waits for) ends between slices
                case 'query.stopReading': {
                    if (this.pagedRunning) this.engine?.cancel(this.pagedRunning);
                    if (this.engineRunning) this.engine?.cancel(this.engineRunning);
                    return;
                }
                case 'query.stopCounting': {
                    this.version++;
                    // (the new engine stops between its slices)
                    if (this.engineRunning) this.engine?.cancel(this.engineRunning);
                    this.post({ type: 'query.counting', since: null, stage: 'Stopped: the counts were not worked out' });
                    return;
                }
                case 'query.setCompareKind': return await this.change(q => {
                    const kind = String(message.kind) as QueryJoinKind;
                    if (!QUERY_JOIN_KINDS.includes(kind)) return;
                    q.joins.forEach(j => { if (j.kind === 'compare') j.kind = kind; });
                    alignCompareJoins(q.joins, runsOf(q));
                });
                // Reset joins (the Join step's footer): every join back to "Pick a column", each keeping its kind; a compare stays a
                // compare on the same Baseline, its key to pick again. The views, the report's columns, the filters stay
                case 'query.resetJoins': return await this.change(q => {
                    const baseline = queryCompare(q.joins, q.sources[0]?.id)?.baseline;
                    q.joins.forEach(j => {
                        j.on = j.kind === 'compare' && baseline ? [{ left: { parts: [{ view: baseline, column: '' }] }, right: { parts: [{ view: j.view, column: '' }] } }] : [];
                    });
                });
                case 'query.deleteJoin': return await this.change(q => {
                    const gone = new Set((Array.isArray(message.views) ? message.views : [message.view]).map(String));
                    q.joins.forEach(j => { if (gone.has(j.view)) { j.kind = 'left'; j.on = []; } });
                    // A run is only ever compared with its first run: out of the compare, it is a view of its own
                    q.sources.forEach(x => {
                        if (!gone.has(x.id) || !x.runOf) return;
                        const head = q.sources.find(h => h.id === x.runOf);
                        delete x.runOf;
                        delete x.run;
                        x.name = guessViewName(head?.name ?? x.name, q.sources.filter(o => o !== x).map(o => o.name));
                    });
                    alignCompareJoins(q.joins, runsOf(q));
                });
                // The report's columns, in Results' order: each a view's column with its functions, a compared column's cells sharing a group
                case 'query.setSelect': return await this.change(q => {
                    q.select = Array.isArray(message.select) ? (message.select as ColumnRef[]).map(c => ({
                        view: String(c.view), column: String(c.column),
                        ...(Array.isArray(c.fns) && c.fns.length ? { fns: this.withLookupColumns(c.fns) } : {}),
                        ...(typeof c.group === 'string' && c.group.trim() ? { group: c.group.trim() } : {})
                    })) : undefined;
                });
                case 'query.moveColumn': return await this.moveColumn(Number(message.from), Number(message.to));
                case 'query.distinct': return await this.change(q => { q.distinct = !!message.on; });
                case 'query.setCalc': return await this.setCalc(String(message.name ?? ''), String(message.expr ?? ''), typeof message.was === 'string' ? message.was : undefined, typeof message.formula === 'string' ? message.formula : undefined);
                case 'query.calcCheck': return this.calcCheck(String(message.formula ?? ''), Number(message.seq));
                case 'query.removeCalc': return await this.change(q => {
                    q.calc = q.calc?.filter(c => c.name !== message.name);
                    q.select = q.select?.filter(c => !(c.view === CALC_VIEW && c.column === message.name));
                });
                case 'query.setSql': return await this.setSql(String(message.sql ?? ''));
                case 'query.latest': return await this.useLatest(String(message.id));
                case 'query.viewRows': return await this.viewRows(message);
                case 'query.viewRowsClosed': { const next = this.viewLine.then(() => this.viewRowsClosed()); this.viewLine = next.catch(() => undefined); return await next; }
                // Make Baseline (Results' slot menu, a run of the Baseline's view): the two runs swap their results; what is built on BL stays as it is
                case 'query.makeBaseline': return await this.change(q => {
                    const run = q.sources.find(x => x.id === String(message.id));
                    const head = run?.runOf ? q.sources.find(x => x.id === run.runOf) : undefined;
                    if (!run || !head) return;
                    const fields = ['executionId', 'isBatch', 'environment', 'executedAt'] as const;
                    const keep = fields.map(f => head[f]);
                    fields.forEach((f, i) => { (head as unknown as Record<string, unknown>)[f] = run[f]; (run as unknown as Record<string, unknown>)[f] = keep[i]; });
                    this.loaded.delete(head.id);
                    this.loaded.delete(run.id);
                    this.result = undefined;
                });
                case 'query.record': return await this.record(Number(message.index), Array.isArray(message.hidden) ? (message.hidden as string[]).map(String) : []);
                case 'query.newLookup': {
                    if (this.ports.newLookup) await this.ports.newLookup();
                    return;
                }
                case 'query.openLookup': {
                    const id = String(message.id ?? '');
                    if (id && this.ports.openLookup) await this.ports.openLookup(id);
                    else if (id) this.ports.toast.info('Lookup tables open from Reporting.');
                    return;
                }
                case 'query.fnSample': return await this.fnSample(message as unknown as { view: string; column: string; fns?: QueryFn[]; seq: number; record?: string });
                case 'query.setWidth': return await this.change(q => {
                    const key = String(message.key ?? '');
                    const width = Math.round(Number(message.width));
                    if (!key || !Number.isFinite(width) || width < 20 || width > 4000) return;
                    q.widths = { ...q.widths, [key]: width };
                }, false);
                case 'query.totals': return await this.change(q => { q.totals = !!message.on; }, false);
                case 'query.rows': return await this.rows(message as unknown as RowsRequest);
                // A step reached for the first time while the query is built: kept, so it reopens where it got to
                case 'query.reached': {
                    const q = this.query;
                    const step = Math.min(4, Math.max(1, Math.floor(Number(message.step) || 1)));
                    if (q && q.reached !== undefined && step > q.reached) {
                        q.reached = step;
                        await saveQuery(this.ports.state, q);
                    }
                    return;
                }
                case 'query.export': return await this.export(message as unknown as RowsRequest);
                case 'query.openConsole': {
                    const source = this.query?.sources.find(s => s.id === message.id);
                    if (source && !source.file) await this.ports.host.openConsole(source.executionId, source.isBatch);
                    return;
                }
                default:
                    if (await this.chain.handle(message as { type: string; payload?: unknown })) return;
                    await this.session_.handleShared(message);
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.ports.logger?.error(`[Query] ${message.type} failed`, error);
            this.post({ type: 'query.error', message: text });
        }
    }

    /** A compare's DIFF and Missing rows, kept on the query when they change (the Hub list says them, #11). */
    private async rememberFound(counts: StatusCounts): Promise<void> {
        const query = this.query;
        if (!query) return;
        const found = { diff: counts.diff ?? 0, missing: Object.values(counts.missing ?? {}).reduce((a, b) => a + b, 0) };
        if (query.found && query.found.diff === found.diff && query.found.missing === found.missing) return;
        query.found = found;
        await saveQuery(this.ports.state, query);
        this.ports.host.compared?.();
    }

    /** The user's Results choices, kept with their queries (so on every computer they sign in on). */
    private preferences(): Record<string, unknown> {
        const kept = this.ports.state.get<Record<string, unknown>>(QUERY_PREFERENCES);
        return kept && typeof kept === 'object' ? kept : {};
    }

    /** Results the Console asked to add (SavedQuery.adding), added as Add a view adds them; New Compare then offers runs. */
    private async addPending(): Promise<void> {
        const stored = getQuery(this.ports.state, this.config.queryId);
        const items = stored?.adding ?? [];
        if (!this.query || !items.length) return;
        const pickRun = !!stored?.pickRun;
        delete this.query.adding;
        delete this.query.pickRun;
        const before = new Set(this.query.sources.map(s => s.id));
        await this.addViews(items);
        if (!this.query.sources.some(s => !before.has(s.id))) await saveQuery(this.ports.state, this.query);
        const head = this.query.sources.find(s => !s.runOf && !s.file);
        if (pickRun && head) this.post({ type: 'query.pickRun', id: head.id });
    }

    private async open(): Promise<void> {
        // The web app on a workspace folder: its queries read in first (query-folder; nothing elsewhere)
        await loadQueryFolder().catch(() => undefined);
        const query = getQuery(this.ports.state, this.config.queryId);
        if (!query) throw new Error('This query is no longer saved.');
        this.query = query;
        // Made whole as it opens (repairQuery: a join for every view, none to a view no longer there, the compare first),
        // so no saved shape leaves it stuck
        if (repairQuery(query)) await saveQuery(this.ports.state, query);
        this.post({ type: 'query.init', name: query.name, empty: query.sources.length === 0, reached: query.reached ?? 4, start: this.config.start === 'results' ? 'results' : 'edit', prefs: this.preferences(), ...(query.specialOff ? { specialOff: true } : {}) });
        // The views show at once, by what is saved; their rows are read behind them
        this.postState({ reading: true });
        const t = Date.now();
        await this.refresh();
        const t1 = Date.now();
        // Only this query's own endpoints now (its slots' header values): every result in History, for Add a view, is
        // read when Add a view first opens (James, 2026-11-22: the whole app froze for seconds as a query opened)
        await this.postSources(new Set((this.query?.sources ?? []).map(x => x.endpointId).filter(Boolean)));
        // (made from the Console: its result added now)
        await this.addPending();
        console.log(`[query-open] views and query ${t1 - t}  ms · this query's results ${Date.now() - t1} ms`);
    }

    /**
     * What Add a view picks from: every finished result, newest first, with what it is found by (its request,
     * its endpoint's name now, its System, where it ran) and the Views it can be read through. Views belong
     * to a method and path (ConsoleViewsStore), so results of the same request list the same Views.
     */
    private async postSources(only?: Set<string>): Promise<void> {
        const history = (await this.ports.metadata.getUnifiedExecutionHistory()).filter(isComparableRun).filter(e => !only || (!!e.endpointId && only.has(e.endpointId)));
        type Known = { name: string; method: string; path: string; systemId?: string };
        const ids = [...new Set(history.map(e => e.endpointId).filter((id): id is string => !!id))];
        const current = new Map<string, Known | undefined>();
        const views: Record<string, string[]> = {};
        // Each result's header values (ORG and the like): what tells apart runs of one request on one environment
        const headers = new Map<string, RunHeaderValue[]>();
        const incomplete = new Set<string>();
        await Promise.all(ids.map(async id => {
            current.set(id, await this.ports.endpoints.getEndpoint(id).catch(() => undefined));
            views[id] = (await this.successViews(id)).map(v => v.name);
            const runs = await comparableRuns(this.ports.metadata, this.ports.environments, id, current.get(id) as RequestTemplates | undefined).catch(() => []);
            runs.forEach(r => { if (r.header?.length) headers.set(r.id, r.header); if (r.incomplete) incomplete.add(r.id); });
        }));
        const systems = new Map<string, string>();
        const systemName = async (id: string | undefined): Promise<string> => {
            if (!id) return '';
            if (!systems.has(id)) systems.set(id, (await this.ports.systemName?.(id).catch(() => undefined)) ?? '');
            return systems.get(id)!;
        };
        const results: Record<string, unknown>[] = [];
        for (const e of history.sort((x, y) => iso(y.createdAt).localeCompare(iso(x.createdAt)))) {
            if (!e.endpointId) continue;
            const endpoint = current.get(e.endpointId);
            const method = endpoint?.method ?? e.endpointMethod;
            const path = endpoint?.path ?? e.endpointPath;
            results.push({
                id: e.id,
                endpointId: e.endpointId,
                endpoint: endpoint?.name || e.endpointName || 'Endpoint',
                request: method && path ? getEndpointViewScopeKey(method, path) : '',
                // Shown and searched apart in Add views (@method, @path)
                method: method ? method.toUpperCase() : '',
                path: path ?? '',
                system: await systemName(endpoint?.systemId ?? (e.endpointConfig as Known | undefined)?.systemId),
                isBatch: e.executionType === 'batch',
                environment: e.environment || 'Unknown',
                executedAt: iso(e.startedAt || e.createdAt),
                rows: String(e.rows ?? ''),
                status: String(e.status ?? '').toLowerCase(),
                // A paginated batch that has not fetched every page yet, as the batch list says
                ...(incomplete.has(e.id) ? { incomplete: true } : {}),
                header: (headers.get(e.id) ?? []).map(h => ({ name: h.name, value: h.label ? `${h.value} · ${h.label}` : h.value }))
            });
        }
        this.post({ type: 'query.sourceList', results, views, all: !only });
    }

    private async successViews(endpointId: string): Promise<CompareView[]> {
        const settings = await this.views.load(endpointId) as { success?: { views?: CompareView[] } } | null;
        return (settings?.success?.views ?? []).filter(v => v && Array.isArray(v.columns));
    }

    private async addView(message: { endpointId: string; executionId: string; view: string }): Promise<void> {
        await this.addViews([message]);
    }

    /**
     * Several results ticked in Add a view: every slot shows at once (each still being read), then
     * each is read in turn, the footer saying which, and the query is worked out once at the end.
     */
    private async addViews(items: { endpointId: string; executionId: string; view: string }[]): Promise<void> {
        const query = this.query;
        if (!query) return;
        const sources: QuerySource[] = [];
        for (const item of items) {
            const source = await this.sourceFor(item, sources);
            if (source) sources.push(source);
        }
        if (!sources.length) return;
        // Results of one endpoint through one View are runs of one view (BL, C1...), as in the mock: compared on its key, picked once
        const inCompare = (): number => (queryCompare(query.joins, query.sources[0]?.id)?.views.length ?? 1) + sources.filter(x => x.runOf && !query.joins.some(j => j.view === x.id)).length;
        sources.forEach(source => {
            const head = [...query.sources, ...sources].find(x => x !== source && !x.runOf && !x.file && x.endpointId === source.endpointId && (x.view ?? '') === (source.view ?? ''));
            if (!head || sources.indexOf(head) > sources.indexOf(source) || inCompare() >= MAX_COMPARE_VIEWS) return;
            const label = nextRunName({ sources: [...query.sources, ...sources] }, head.id);
            source.runOf = head.id;
            source.run = label;
            source.name = guessViewName(`${head.name.slice(0, VIEW_NAME_MAX - label.length - 1)}_${label}`, [...query.sources, ...sources].filter(x => x !== source).map(x => x.name));
        });
        const firstEver = query.sources.length === 0;
        await this.change(q => { q.sources.push(...sources); }, false);
        this.postState({ reading: true });
        for (let i = 0; i < sources.length; i++) {
            this.post({ type: 'query.progress', text: `Reading ${sources[i].name}`, done: i, total: sources.length, view: sources[i].id });
            await this.load(sources[i]);
            if (this.closed) return;
            // (each one's rows show on its slot as it is read)
            this.postState({ reading: true });
        }
        await this.change(q => {
            sources.forEach((source, i) => {
                if (!q.sources.includes(source) || (firstEver && i === 0)) return;
                if (source.runOf) {
                    // A run: matched with its first run on the compare's key ("sku, the same"); its columns sit in the view's compared ones
                    setJoin(q, runJoin(q.joins.filter(j => j.view !== source.id), source.id, source.runOf));
                    alignCompareJoins(q.joins, runsOf(q));
                    return;
                }
                setJoin(q, { view: source.id, kind: 'left', on: [] });
                const mine = this.loaded.get(source.id)?.columns ?? [];
                const taken = new Set(q.sources.filter(s => s !== source).flatMap(s => this.loaded.get(s.id)?.columns ?? []));
                const blank = new Set(this.emptyColumns(source.id));
                if (q.select?.length) q.select.push(...mine.filter(column => !taken.has(column) && !blank.has(column)).map(column => ({ view: source.id, column })));
            });
        });
    }

    /** A result as a view of the query, not yet added; undefined (said) past a limit. `pending`: views being added with it. */
    private async sourceFor(message: { endpointId: string; executionId: string; view: string }, pending: QuerySource[]): Promise<QuerySource | undefined> {
        const query = this.query;
        if (!query) return undefined;
        const all = [...query.sources, ...pending];
        if (all.length >= MAX_QUERY_VIEWS) { this.ports.toast.warn(`A query takes up to ${MAX_QUERY_VIEWS} views.`); return undefined; }
        // Four of one endpoint at most: as many as a compare takes
        if (all.filter(s => s.endpointId === message.endpointId).length >= MAX_COMPARE_VIEWS) {
            this.ports.toast.warn(`A query takes up to ${MAX_COMPARE_VIEWS} results of one endpoint.`);
            return undefined;
        }
        const run = await this.ports.metadata.getExecution(message.executionId) ?? await this.ports.metadata.getBatchExecution(message.executionId);
        if (!run) throw new Error('That result is no longer in History.');
        const endpoint = await this.ports.endpoints.getEndpoint(message.endpointId).catch(() => undefined);
        const endpointName = endpoint?.name || run.endpointName || 'Endpoint';
        // Named after its View, or its endpoint when the View's name says nothing ("Default")
        const plain = !message.view || /^(default|root|view)$/i.test(message.view.trim());
        // Named from its path's last word (and its View, when not the default): see viewNameFromPath
        const base = viewNameFromPath(endpoint?.path || run.endpointPath || '', message.view) || (plain ? endpointName : message.view);
        const name = guessViewName(base, all.map(s => s.name));
        const source: QuerySource = {
            id: newSourceId(), name, endpointId: message.endpointId, endpointName, view: message.view,
            request: endpoint ? getEndpointViewScopeKey(endpoint.method, endpoint.path) : (run.endpointMethod && run.endpointPath ? getEndpointViewScopeKey(run.endpointMethod, run.endpointPath) : ''),
            system: (endpoint?.systemId ? await this.ports.systemName?.(endpoint.systemId).catch(() => undefined) : undefined) ?? '',
            executionId: message.executionId, isBatch: run.executionType === 'batch',
            environment: run.environment || 'Unknown', executedAt: iso(run.startedAt || run.createdAt)
        };
        return source;
    }

    /**
     * Another run of a view: a result of the same endpoint, read through the same View, as a table
     * of its own (C1, C2...), matched with the view's first run by a Compare join on its key.
     */
    private async addRun(of: string, executionId: string): Promise<void> {
        const query = this.query;
        if (!query) return;
        const first = query.sources.find(s => s.id === of);
        if (!first || first.file) return;
        const head = first.runOf ? query.sources.find(s => s.id === first.runOf) ?? first : first;
        if (query.sources.length >= MAX_QUERY_VIEWS) throw new Error(`A query takes up to ${MAX_QUERY_VIEWS} views.`);
        const inCompare = queryCompare(query.joins, query.sources[0]?.id)?.views.length ?? 1;
        if (inCompare >= MAX_COMPARE_VIEWS) {
            this.ports.toast.warn(`A compare takes ${MAX_COMPARE_VIEWS} runs and views. Take one out of it to add another run.`);
            return;
        }
        const run = await this.ports.metadata.getExecution(executionId) ?? await this.ports.metadata.getBatchExecution(executionId);
        if (!run) throw new Error('That result is no longer in History.');
        const label = nextRunName(query, head.id);
        const source: QuerySource = {
            // Its name in the SQL: the view's, cut to leave room for its run (CompareSt_C1)
            ...head, id: newSourceId(), name: guessViewName(`${head.name.slice(0, VIEW_NAME_MAX - label.length - 1)}_${label}`, query.sources.map(s => s.name)),
            runOf: head.id, run: label, executionId, isBatch: run.executionType === 'batch',
            environment: run.environment || 'Unknown', executedAt: iso(run.startedAt || run.createdAt)
        };
        delete source.off;
        await this.change(q => { q.sources.push(source); }, false);
        this.postState({ reading: true });
        await this.load(source);
        await this.change(q => {
            if (!q.sources.includes(source)) return;
            setJoin(q, runJoin(q.joins.filter(j => j.view !== source.id), source.id, head.id));
            alignCompareJoins(q.joins, runsOf(q));
        });
    }

    /**
     * A file as views: read now, in full, and its rows kept on this computer (query-file-store).
     * A CSV is one view; a workbook is one per sheet, each named for its sheet.
     */
    /** A workbook read and waiting for the user to say which of its sheets become views. */
    private pendingFile?: { name: string; sheets: QueryFileSheet[]; bytes?: Uint8Array };

    private async addFile(message: FileMessage): Promise<void> {
        const query = this.query;
        if (!query) return;
        if (query.sources.length >= MAX_QUERY_VIEWS) throw new Error(`A query takes up to ${MAX_QUERY_VIEWS} views.`);
        const fileName = String(message.name || 'File');
        if (isWorkbook(fileName) && message.base64) {
            // A workbook: its sheets listed from their first rows (about a second), each picked one then read on its own
            this.post({ type: 'query.progress', text: `Reading ${fileName}` });
            const bytes = workbookBytes(String(message.base64));
            const list = workbookSheets(bytes);
            if (!list.length) throw new Error(`${fileName} has no columns: a sheet's first row should name them.`);
            if (list.length > 1) {
                this.pendingFile = { name: fileName, sheets: [], bytes };
                this.post({ type: 'query.fileSheets', name: fileName, room: MAX_QUERY_VIEWS - query.sources.length, sheets: list });
                return;
            }
            await this.addSheets(fileName, await this.readSheets(fileName, bytes, [list[0].sheet]));
            return;
        }
        const sheets = readFileSheets(fileName, message);
        // A workbook of several sheets: the user says which become views (query.addSheets answers)
        if (sheets.length > 1) {
            this.pendingFile = { name: fileName, sheets };
            this.post({
                type: 'query.fileSheets', name: fileName, room: MAX_QUERY_VIEWS - query.sources.length,
                sheets: sheets.map(s => ({ sheet: s.sheet, rows: s.rows.length, columns: s.columns.length }))
            });
            return;
        }
        await this.addSheets(fileName, sheets);
    }

    /** The sheets picked from the workbook just read: each becomes a view. None picked: the workbook is let go. */
    private async pickSheets(names: string[]): Promise<void> {
        const pending = this.pendingFile;
        this.pendingFile = undefined;
        if (!pending || !names.length) return;
        const room = MAX_QUERY_VIEWS - (this.query?.sources.length ?? 0);
        const sheets = pending.bytes ? await this.readSheets(pending.name, pending.bytes, names.slice(0, room)) : pending.sheets.filter(s => names.includes(s.sheet));
        await this.addSheets(pending.name, sheets, true);
    }

    /** A workbook's sheets read one at a time, saying which ("Reading sheet C2 (2 of 4)"), the page given way between them. */
    private async readSheets(fileName: string, bytes: Uint8Array, names: string[]): Promise<QueryFileSheet[]> {
        const out: QueryFileSheet[] = [];
        for (const [i, sheet] of names.entries()) {
            this.post({ type: 'query.progress', text: names.length > 1 ? `Reading sheet ${sheet} (${i + 1} of ${names.length})` : `Reading ${fileName}` });
            await new Promise(resolve => setTimeout(resolve, 30));
            out.push(readWorkbookSheet(bytes, sheet));
        }
        return out;
    }

    private async addSheets(fileName: string, sheets: QueryFileSheet[], bySheet = false): Promise<void> {
        const query = this.query;
        if (!query) return;
        const room = MAX_QUERY_VIEWS - query.sources.length;
        const base = fileName.replace(/\.[^.]+$/, '') || 'File';
        for (const read of sheets.slice(0, room)) {
            // One sheet: the file's name. Several: each sheet's own
            const name = guessViewName((bySheet || sheets.length > 1) && read.sheet ? read.sheet : base, query.sources.map(s => s.name));
            const source: QuerySource = {
                id: newSourceId(), name, endpointId: '', endpointName: fileName, view: '',
                executionId: '', isBatch: false, environment: '', executedAt: new Date().toISOString(),
                file: { name: fileName, ...(read.sheet ? { sheet: read.sheet } : {}) }
            };
            this.loaded.set(source.id, { columns: read.columns, rows: read.rows, rowBasis: 'line' });
            await this.keepFile(source.id, read);
            await this.attach(source);
        }
        if (sheets.length > room) this.ports.toast.warn(`A query takes up to ${MAX_QUERY_VIEWS} views: ${sheets.length - room} of ${fileName}'s sheets were left out.`);
    }

    /**
     * A file view's file, picked again: a newer copy of it, or its rows are not on this computer.
     * A workbook picked again is read for every view that is one of its sheets.
     */
    private async fileAgain(message: FileMessage & { id: string }): Promise<void> {
        const query = this.query;
        const source = query?.sources.find(s => s.id === message.id && s.file);
        if (!query || !source?.file) return;
        const was = source.file.name;
        const fileName = String(message.name || was);
        const sheets = readFileSheets(fileName, message);
        const mine = query.sources.filter(s => s === source || (s.file?.sheet && source.file?.sheet && s.file.name === was));
        const read = new Map<string, QueryFileRows>();
        const gone: string[] = [];
        for (const s of mine) {
            const sheet = s.file?.sheet ? sheets.find(x => x.sheet === s.file?.sheet) : sheets[0];
            if (sheet) read.set(s.id, sheet); else gone.push(s.file?.sheet ?? '');
        }
        if (!read.has(source.id)) throw new Error(`${fileName} has no sheet "${source.file.sheet}".`);
        for (const [id, sheet] of read) {
            this.loaded.set(id, { columns: sheet.columns, rows: sheet.rows, rowBasis: 'line' });
            await this.keepFile(id, sheet);
        }
        this.sessionKey = '';
        this.engineKey = '';
        if (gone.length) this.ports.toast.warn(`${fileName} has no sheet ${gone.map(g => `"${g}"`).join(', ')}: ${gone.length === 1 ? 'that view keeps' : 'those views keep'} the rows read before.`);
        await this.change(q => {
            for (const s of q.sources) {
                if (!read.has(s.id) || !s.file) continue;
                s.file = { name: fileName, ...(s.file.sheet ? { sheet: s.file.sheet } : {}) };
                s.endpointName = fileName;
                s.executedAt = new Date().toISOString();
            }
        });
    }

    /** Keep a file's rows for the next time the query opens. One that cannot be kept still works now. */
    private async keepFile(viewId: string, read: QueryFileRows): Promise<void> {
        if (!this.query || !this.ports.queryFiles) return;
        try {
            await this.ports.queryFiles.save(this.query.id, viewId, read);
        } catch (error) {
            this.ports.logger?.error('Query: a file\'s rows could not be kept', error);
            this.ports.toast.warn('The file\'s rows could not be kept on this computer. The query will ask for the file next time.');
        }
    }

    /** Put a new view in the query: on the screen at once, with a join that waits for its columns. No join is guessed: a guess comes back when a view is removed and added again, and it is the user's to make. */
    private async attach(source: QuerySource): Promise<void> {
        const query = this.query;
        if (!query) return;
        // The view is on the screen at once; its rows are read after
        await this.change(q => { q.sources.push(source); }, false);
        this.postState({ reading: true });
        if (query.sources.length > 1) {
            await this.load(source);
            const mine = this.loaded.get(source.id)?.columns ?? [];
            await this.change(q => {
                if (!q.sources.includes(source)) return;
                setJoin(q, { view: source.id, kind: 'left', on: [] });
                // Columns picked by hand: the new view's join them (before any calculated ones stay where they are)
                // but for a name an earlier view has: two columns of one name are picked by hand
                const taken = new Set(q.sources.filter(s => s !== source).flatMap(s => this.loaded.get(s.id)?.columns ?? []));
                // and for a column with no value in any row
                const blank = new Set(this.emptyColumns(source.id));
                if (q.select?.length) q.select.push(...mine.filter(column => !taken.has(column) && !blank.has(column)).map(column => ({ view: source.id, column })));
            });
        } else {
            await this.refresh();
        }
    }

    /**
     * A view's own rows, to look through before it is joined: the first of those every word of
     * `search` is found in (any column, capitals ignored).
     */
    /**
     * A view's own rows dialog (the count on its Views row): a page of its rows at a time, as the
     * design system's table scrolls, searched by the one copy of the search rules (searchTest,
     * search-matcher.js) and sorted as Results sorts. On the new engine the view is read where it
     * already is, the rows the search keeps held there until the search, the sort or the dialog
     * changes; else from the rows held here. One page at a time: a search waits for the one before.
     */
    private viewFound?: { key: string; columns: string[]; found: number; total: number; host?: EngineHost; result?: string; rows?: QueryRowData[] };
    private viewLine: Promise<unknown> = Promise.resolve();

    private viewRows(message: Record<string, unknown>): Promise<void> {
        const next = this.viewLine.then(() => this.viewPage(message));
        this.viewLine = next.catch(() => undefined);
        return next;
    }

    private async viewPage(message: Record<string, unknown>): Promise<void> {
        const id = String(message.id);
        const seq = Number(message.seq);
        const search = String(message.search ?? '').trim();
        const offset = Math.max(0, Math.floor(Number(message.offset) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(message.limit) || 200)));
        const columns = this.loaded.get(id)?.columns ?? [];
        // (a Join count's records: `count` names the kind and the run or view it is of)
        const askedCount = message.count as { kind?: unknown; of?: unknown } | undefined;
        const count = askedCount && typeof askedCount.of === 'string' && typeof askedCount.kind === 'string' ? { kind: askedCount.kind as JoinCountKind, of: askedCount.of } : undefined;
        const asked = message.sort as { id?: unknown; dir?: unknown } | null | undefined;
        const sort = asked && typeof asked.id === 'string' && columns.includes(asked.id) ? { id: asked.id, dir: asked.dir === 'desc' ? 'desc' as const : 'asc' as const } : null;
        const text = (value: unknown): string => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        const key = JSON.stringify([id, columns, this.rowCount(id), search, sort, count ?? null]);
        try {
            let found = this.viewFound;
            if (!found || found.key !== key || (found.host && !found.host.alive())) {
                await this.viewRowsClosed();
                found = await this.viewFind(id, columns, search, sort, key, text, count);
                this.viewFound = found;
            }
            let rows: string[][];
            if (found.host && found.result) {
                const window = await found.host.read(found.result, offset, limit);
                const at = found.columns.map(c => window.columns.indexOf(c));
                rows = window.rows.map(row => at.map(i => (i < 0 ? '' : text(row[i]))));
            } else {
                const shown = found.columns;
                rows = (found.rows ?? []).slice(offset, offset + limit).map(row => shown.map(c => text(row[c])));
            }
            this.post({ type: 'query.viewRowsData', seq, columns: found.columns, total: found.total, found: found.found, offset, rows });
        } catch (e) {
            this.post({ type: 'query.viewRowsData', seq, columns, total: this.rowCount(id), found: 0, offset, rows: [], error: e instanceof Error ? e.message : String(e) });
        }
    }

    /** The rows a search of a view keeps, in the sort's order: on the engine (held there), or here. */
    private async viewFind(id: string, columns: string[], search: string, sort: { id: string; dir: 'asc' | 'desc' } | null, key: string, text: (value: unknown) => string, count?: { kind: JoinCountKind; of: string }): Promise<NonNullable<QueryController['viewFound']>> {
        const total = this.rowCount(id);
        const arg: SearchArg = { search, cols: columns.map(c => ({ id: c, name: c, type: 'string' })) };
        const engine = this.engine;
        if (count) {
            // A Join count's records: read from the compare its counts came from, then searched and sorted as a view's rows are
            const kept = this.joinCountKept.get(count.of);
            if (!kept || !kept.host.alive()) throw new Error('Those counts have changed: close this and click the count again.');
            const { spec } = this.spec();
            const ofKey = (view: string) => spec.joins.find(j => j.kind === 'compare' && (view === kept.baseline ? true : j.view === view))?.on.flatMap(p => (view === kept.baseline ? p.left : p.right).parts.map(x => x.column)) ?? [];
            const base0 = joinCountRowsQuery(kept.id, kept.baseline, count.of, count.kind, columns, ofKey(count.kind === 'onlyBaseline' ? kept.baseline : count.of));
            const steps = [...base0.steps];
            let base = base0.result!;
            if (search) { steps.push({ as: 'found', filter: base, test: { name: 'search', arg, columns } }); base = 'found'; }
            if (sort) { steps.push({ as: 'resorted', sort: base, by: [{ value: { column: sort.id }, descending: sort.dir === 'desc', order: 'shown' }] }); base = 'resorted'; }
            const out = await kept.host.run({ steps, result: base });
            if ('cancelled' in out) throw new Error('The search was stopped.');
            if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
            const all = await kept.host.read(out.result, 0, 0);
            return { key, columns: count.kind === 'repeat' ? [JOIN_STATUS, ...columns] : columns, found: all.total, total: all.total, host: kept.host, result: out.result };
        }
        // (a view read on the new engine went into it as it was read, and was let go here: read it there)
        if (this.loaded.get(id)?.dropped && engine && engine.alive() && this.streamed.has(id)) {
            const steps: EngineQuery['steps'] = [{ as: 'all', from: id }];
            let base = 'all';
            if (search) { steps.push({ as: 'found', filter: base, test: { name: 'search', arg, columns } }); base = 'found'; }
            if (sort) { steps.push({ as: 'sorted', sort: base, by: [{ value: { column: sort.id }, descending: sort.dir === 'desc', order: 'shown' }] }); base = 'sorted'; }
            const out = await engine.run({ steps, result: base });
            if ('cancelled' in out) throw new Error('The search was stopped.');
            if ('problems' in out) throw new Error(out.problems.map(p => p.message).join(' '));
            const first = await engine.read(out.result, 0, 0);
            return { key, columns, found: first.total, total, host: engine, result: out.result };
        }
        let rows = await this.rowsOf(id);
        if (search) {
            const test = searchTest(arg);
            rows = rows.filter(row => test(columns.map(c => text(row[c]))));
        }
        if (sort) {
            // (as the table sorts its own rows: numbers inside text by size, blanks last)
            const sign = sort.dir === 'desc' ? -1 : 1;
            rows = rows.map((row, i) => ({ row, i, v: text(row[sort.id]) }))
                .sort((x, y) => (!x.v || !y.v ? (x.v ? -1 : y.v ? 1 : 0) : sign * x.v.localeCompare(y.v, undefined, { numeric: true, sensitivity: 'base' })) || x.i - y.i)
                .map(x => x.row);
        }
        return { key, columns, found: rows.length, total, rows };
    }

    /** The view's rows dialog closed (or asked again): what its search kept is let go. */
    private async viewRowsClosed(): Promise<void> {
        const was = this.viewFound;
        this.viewFound = undefined;
        if (was?.host && was.result && was.host.alive()) await was.host.release(was.result).catch(() => undefined);
    }

    /** A few of a column's values, as they are and as `fns` leave them: the function dialog's sample. */
    private async fnSample(message: { view: string; column: string; fns?: QueryFn[]; seq: number; record?: string }): Promise<void> {
        const { spec } = this.spec();
        const tables = tableNames(spec.views);
        // Translate values being tried: its table loaded, its columns filled in
        message.fns = this.withLookupColumns(message.fns ?? []);
        if (this.onEngine(spec)) return await this.fnSampleOnEngine(spec, message);
        for (const id of lookupsIn(message.fns)) {
            const table = await this.ports.lookups?.get(id);
            if (table && this.session && this.lookupsLoaded.get(id) !== table.updatedAt) { this.session.loadLookup(table); this.lookupsLoaded.set(id, table.updatedAt); }
        }
        const table = tables.get(message.view);
        let rows: unknown[][] = [];
        let error: string | undefined;
        if (this.session && table && message.column) {
            const ref = { view: message.view, column: message.column };
            const plain = columnSql(ref, tables);
            try {
                const made = columnSql({ ...ref, fns: message.fns ?? [] }, tables);
                rows = this.session.run(`SELECT DISTINCT ${plain}, ${made} FROM ${quoteName(table)} WHERE ${plain} IS NOT NULL AND ${plain} <> '' LIMIT 6`).rows;
                // This record (the cell whose ƒ was clicked) first: the row the dialog lights
                const record = String(message.record ?? '');
                if (record) {
                    const own = this.session.run(`SELECT ${plain}, ${made} FROM ${quoteName(table)} WHERE CAST(${plain} AS TEXT) = ${quoteText(record)} LIMIT 1`).rows[0];
                    if (own) rows = [own, ...rows.filter(r => String(r[0]) !== String(own[0]))].slice(0, 6);
                }
            } catch (e) {
                error = e instanceof Error ? e.message : String(e);
            }
        }
        // Translate values: the whole table for the dialog, and this column's value to light its row
        const last = [...(message.fns ?? [])].reverse().find(f => f.fn === 'translate');
        const lookup = last && last.fn === 'translate' ? await this.ports.lookups?.get(last.table) : undefined;
        const lookupTable = lookup ? { columns: lookup.columns.map(c => ({ id: c.id, name: c.name })), rows: lookup.rows } : undefined;
        this.post({ type: 'query.fnSample', seq: message.seq, rows, error, ...(lookupTable ? { table: lookupTable, value: rows[0]?.[0] ?? null } : {}) });
    }

    /** fnSample on the new engine: the same rows, read without sql.js. */
    private async fnSampleOnEngine(spec: QuerySpec, message: { view: string; column: string; fns?: QueryFn[]; seq: number; record?: string }): Promise<void> {
        let rows: unknown[][] = [];
        let error: string | undefined;
        try {
            await this.loadEngineLookups(await this.engineFor(spec), lookupsIn(message.fns));
            if (message.column) {
                const { few, own } = fnSampleQueries(message.view, message.column, message.fns ?? [], String(message.record ?? ''));
                rows = (await this.engineWindow(spec, few, 6, message.view)).rows;
                if (own) {
                    const mine = (await this.engineWindow(spec, own, 1, message.view)).rows[0];
                    if (mine) rows = [mine, ...rows.filter(r => String(r[0]) !== String(mine[0]))].slice(0, 6);
                }
            }
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        const last = [...(message.fns ?? [])].reverse().find(f => f.fn === 'translate');
        const lookup = last && last.fn === 'translate' ? await this.ports.lookups?.get(last.table) : undefined;
        const lookupTable = lookup ? { columns: lookup.columns.map(c => ({ id: c.id, name: c.name })), rows: lookup.rows } : undefined;
        this.post({ type: 'query.fnSample', seq: message.seq, rows, error, ...(lookupTable ? { table: lookupTable, value: rows[0]?.[0] ?? null } : {}) });
    }

    /** Every column a formula can name: its key, its whole @ path, the shortest that is unique, and a value from it. */
    private formulaColumnsFor(): { key: string; full: string; short: string; path: string[]; view: string; sample: string }[] {
        const { spec } = this.spec();
        const columns = formulaColumns(spec);
        return columns.map(c => {
            const at = c.key.indexOf('\n');
            const view = c.key.slice(0, at);
            const loaded = this.loaded.get(view);
            if (loaded?.dropped) return { key: c.key, full: fullRef(c), short: shortRef(c, columns), path: c.path, view, sample: loaded.dropped.samples.get(c.key.slice(at + 1)) ?? '' };
            const value = loaded?.rows.find(r => r[c.key.slice(at + 1)] !== null && r[c.key.slice(at + 1)] !== undefined && r[c.key.slice(at + 1)] !== '')?.[c.key.slice(at + 1)];
            return { key: c.key, full: fullRef(c), short: shortRef(c, columns), path: c.path, view, sample: value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) };
        });
    }

    /**
     * The calculation builder's check, as the user types: the formula read (formula.ts), its SQL,
     * and its value on the first few rows; or what is wrong, where, and the columns to pick from.
     */
    private async calcCheck(formula: string, seq: number): Promise<void> {
        const { spec } = this.spec();
        const columns = formulaColumns(spec);
        const names = refNames(spec.views);
        try {
            const parsed = parseFormula(formula, columns);
            const colSql = (key: string): string => { const at = key.indexOf('\n'); return columnSql({ view: key.slice(0, at), column: key.slice(at + 1) }, names); };
            const sides = parsed.compare ?? [parsed.tree];
            const sql = sides.map(side => formulaSql(side, colSql));
            // Beside each result, the record's key (the first join's, a compare's from whichever view has it), so you know which record each line is
            const first = spec.views[0];
            const keyPart = spec.joins.find(j => j.on.length)?.on[0]?.left.parts[0];
            const key = keyPart && spec.views.some(v => v.id === keyPart.view && v.columns.includes(keyPart.column))
                ? { view: keyPart.view, column: keyPart.column }
                : first ? { view: first.id, column: first.columns[0] } : undefined;
            const label = key ? compareKeyColumnSql(key, spec, names) ?? columnSql(key, names) : "''";
            let rows: unknown[][] = [];
            if (this.onEngine(spec) && spec.views.length) {
                // On the new engine: the formula's Expr on the query's first rows, the key beside each
                const byKey = (k: string) => { const at = k.indexOf('\n'); return { column: k.slice(at + 1), of: k.slice(0, at) }; };
                await this.loadEngineLookups(await this.engineFor(spec), lookupsUsed(spec));
                const window = await this.engineWindow(spec, queryWithColumns(spec, [key ? labelExpr(spec, key) : { value: '' }, ...sides.map(side => formulaExpr(side, byKey))]), 4);
                rows = window.rows;
            } else if (this.session && spec.views.length) {
                rows = this.session.run(`SELECT ${label}, ${sql.join(', ')} ${fromSql(spec)} LIMIT 4`).rows;
            }
            this.post({ type: 'query.calcCheck', seq, ok: true, sql: sql.join(',\n'), compare: !!parsed.compare, label: key?.column ?? '', rows, used: parsed.columns });
        } catch (error) {
            const e = error as { message?: string; at?: number; choices?: string[] };
            this.post({ type: 'query.calcCheck', seq, ok: false, error: e.message ?? String(error), at: e.at ?? -1, choices: e.choices ?? [] });
        }
    }

    /**
     * Add a calculated column, or change the one named `was`. A formula (the builder's) is read
     * first, and kept with every column as its whole path; SQL typed before the builder is tried
     * first: one SQLite refuses is not kept.
     */
    private async setCalc(nameIn: string, exprIn: string, was?: string, formulaIn?: string): Promise<void> {
        const query = this.query;
        if (!query) return;
        const name = nameIn.trim();
        if (formulaIn !== undefined) {
            if (!name || !formulaIn.trim()) throw new Error('A calculated column needs a name and a calculation.');
            if ((query.calc ?? []).some(c => c.name.toLowerCase() === name.toLowerCase() && c.name !== was)) throw new Error(`There is already a calculated column called ${name}.`);
            const columns = formulaColumns(this.spec().spec);
            parseFormula(formulaIn, columns);
            const formula = fullText(formulaIn.trim(), columns);
            await this.change(q => {
                const calc = q.calc ?? [];
                const at = was ? calc.findIndex(c => c.name === was) : -1;
                const made = { name, expr: shortText(formula, columns), formula };
                if (at >= 0) {
                    calc[at] = made;
                    q.select?.forEach(c => { if (c.view === CALC_VIEW && c.column === was) c.column = name; });
                } else {
                    calc.push(made);
                    if (q.select?.length) q.select.push({ view: CALC_VIEW, column: name });
                }
                q.calc = calc;
            });
            return;
        }
        const expr = exprIn.trim();
        if (!name || !expr) throw new Error('A calculated column needs a name and a calculation.');
        if (/;|--|\/\*/.test(expr)) throw new Error('A calculation is one expression: no ; and no comments.');
        if ((query.calc ?? []).some(c => c.name.toLowerCase() === name.toLowerCase() && c.name !== was)) throw new Error(`There is already a calculated column called ${name}.`);
        const { spec } = this.spec();
        if (this.session && spec.views.length) {
            try {
                this.session.run(`SELECT (${expr}) ${fromSql(spec)} LIMIT 1`);
            } catch (error) {
                throw new Error(`That calculation does not run: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await this.change(q => {
            const calc = q.calc ?? [];
            const at = was ? calc.findIndex(c => c.name === was) : -1;
            if (at >= 0) {
                calc[at] = { name, expr };
                q.select?.forEach(c => { if (c.view === CALC_VIEW && c.column === was) c.column = name; });
            } else {
                calc.push({ name, expr });
                // Columns picked by hand: the new one joins them at the end
                if (q.select?.length) q.select.push({ view: CALC_VIEW, column: name });
            }
            q.calc = calc;
        });
    }

    /** The user's own SQL for Results, or none (the steps' SQL again). One SELECT, tried before it is kept. */
    private async setSql(sqlIn: string): Promise<void> {
        const sql = sqlIn.trim().replace(/;\s*$/, '');
        if (sql) {
            if (!/^\s*(select|with)\b/i.test(sql) || sql.includes(';')) throw new Error('Write one SELECT.');
            // (your own SQL is SQLite's: its tables are loaded for it, the new engine's setting or not)
            const { spec } = this.spec();
            const session = this.session ?? (spec.views.length ? await this.sessionFor(spec, this.version) : undefined);
            if (!session) throw new Error('Add a view first.');
            try {
                session.run(`SELECT * FROM (${sql}) LIMIT 1`);
            } catch (error) {
                throw new Error(`That SQL does not run: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await this.change(q => {
            q.sql = sql || undefined;
            q.sort = null;
        });
    }

    /** Read a view from its endpoint's newest result in the same environment. Nothing is sent. */
    private async useLatest(id: string): Promise<void> {
        const source = this.query?.sources.find(s => s.id === id);
        if (!source || source.file) return;
        const runs = (await this.ports.metadata.getUnifiedExecutionHistory()).filter(isComparableRun)
            .filter(e => e.endpointId === source.endpointId && (e.environment || 'Unknown') === source.environment)
            .sort((x, y) => iso(y.startedAt || y.createdAt).localeCompare(iso(x.startedAt || x.createdAt)));
        const newest = runs[0];
        if (!newest || newest.id === source.executionId) {
            this.ports.toast.info(`${source.name} already reads the newest result.`);
            this.post({ type: 'query.idle' });
            return;
        }
        await this.change(q => {
            const s = q.sources.find(x => x.id === id);
            if (!s) return;
            s.executionId = newest.id;
            s.isBatch = newest.executionType === 'batch';
            s.executedAt = iso(newest.startedAt || newest.createdAt);
            this.loaded.delete(id);
            this.sessionKey = '';
            this.engineKey = '';
        });
    }

    /** Change the saved query, save it, and show what it makes now. */
    /** Is a view read the same way (endpoint and View) as the compare's Baseline? Its key column is then the Baseline's. */
    private sameShapeAsBaseline(q: SavedQuery, id: string): boolean {
        const baseline = queryCompare(q.joins, q.sources[0]?.id)?.baseline;
        const a = q.sources.find(x => x.id === baseline);
        const b = q.sources.find(x => x.id === id);
        return !!a && !!b && a !== b && !a.file && !b.file && a.endpointId === b.endpointId && (a.view ?? '') === (b.view ?? '');
    }

    /** Each view as grouping a compare needs it: what it reads, and its columns. */
    private shapes(q: SavedQuery): { id: string; endpointId?: string; view?: string; columns: string[] }[] {
        return q.sources.map(x => ({ id: x.id, endpointId: x.file ? undefined : x.endpointId, view: x.view, columns: this.loaded.get(x.id)?.columns ?? [] }));
    }

    /** A move that would change a compare's Baseline is refused (query-store changesCompareBaseline): said, plainly. */
    private sayBaselineStays(query: SavedQuery, id: string, to: number): void {
        if (changesCompareBaseline(query, id, to)) this.ports.toast.info('Only a view in the compare, with its key picked, can be its Baseline.');
    }

    private async change(apply: (query: SavedQuery) => void | Promise<void>, refresh = true): Promise<void> {
        const query = this.query;
        if (!query) return;
        await apply(query);
        // Whole after every change, as on opening (repairQuery): a compare made after another view comes first, that
        // view joined to it; the first view's join, if a move or a removal left one, goes
        repairQuery(query);
        query.updatedAt = new Date().toISOString();
        await saveQuery(this.ports.state, query);
        this.ports.host.compared?.();
        if (refresh) await this.refresh();
        else this.post({ type: 'query.named', name: query.name });
    }

    /** Read one view's rows from its run's saved responses, through its Console View. */
    private async load(source: QuerySource): Promise<void> {
        if (this.loaded.has(source.id)) return;
        // (how far it has got, on the footer's line: "Reading C2: 30,000 rows (page 60 of 210)"; and in its own Rows cell)
        const say = (text: string, done: number, total: number, rows: number) => this.post({ type: 'query.progress', text, view: source.id, read: { rows, done, total } });
        // On the new engine its rows go into the engine as they are read, piece by piece, never held here
        const feed = this.ports.newCompareEngine?.() ? this.feedEngine(source.id) : undefined;
        const loaded = await this.readView(source, say, feed?.piece);
        this.loaded.set(source.id, feed && !loaded.error ? await feed.finish(loaded) : loaded);
    }

    /**
     * A view's rows into the engine as they are read (load): each piece of rows appended to its table
     * and let go, the table complete with the last. Kept here: how many rows, each column's rows with a
     * value and a value from it (what Views and Columns show), as a dropped view keeps them.
     */
    private feedEngine(id: string): { piece: (columns: string[], rows: QueryRowData[]) => Promise<void>; finish: (loaded: LoadedView) => Promise<LoadedView> } {
        const host = this.engineHostNow();
        let started = false;
        let count = 0;
        let columns: string[] = [];
        const filled = new Map<string, number>();
        const samples = new Map<string, string>();
        const piece = async (cols: string[], rows: QueryRowData[]): Promise<void> => {
            columns = cols;
            for (const c of cols) {
                let n = 0;
                for (const row of rows) { const v = row[c]; if (v !== null && v !== undefined && v !== '') n++; }
                filled.set(c, (filled.get(c) ?? 0) + n);
                if (!samples.get(c)) samples.set(c, sample(rows, c));
            }
            const table = { columns: cols, rows: rows.map(r => cols.map(c => asColumnValue(r[c]))) };
            if (!started) await host.load(id, table, { more: true }); else await host.append(id, table);
            started = true;
            count += rows.length;
        };
        const finish = async (loaded: LoadedView): Promise<LoadedView> => {
            // (a file's rows come whole: in pieces from here)
            for (let at = 0; at < loaded.rows.length; at += FEED_ROWS) await piece(loaded.columns, loaded.rows.slice(at, at + FEED_ROWS));
            if (started) await host.append(id, { columns, rows: [] }, { last: true });
            else await host.load(id, { columns: loaded.columns, rows: [] });
            const out: LoadedView = { columns: loaded.columns, rows: [], rowBasis: loaded.rowBasis, dropped: { count, samples } };
            this.filled.set(out, new Map(loaded.columns.map(c => [c, filled.get(c) ?? 0])));
            this.streamed.set(id, JSON.stringify([id, loaded.columns, count]));
            return out;
        };
        return { piece, finish };
    }

    /** Views in the engine as they are now (their id, columns and rows: engineLoad's entry), by id: loaded again only when that changes. */
    private readonly streamed = new Map<string, string>();

    /** The engine, or a new one when there is none or it stopped working (everything kept in the old one let go). */
    private engineHostNow(): EngineHost {
        if (this.engine && this.engine.alive()) return this.engine;
        this.engine?.close();
        this.engineLookups.clear();
        this.streamed.clear();
        this.engineKey = '';
        this.paged = undefined; this.pagedAll = undefined; this.pagedHeld = undefined; this.pagedBase = undefined; this.engineCompare = undefined;
        this.engine = this.ports.engineHost?.() ?? localEngineHost(new QueryEngine(undefined, QUERY_ROW_TESTS), {
            // (Query's export where the engine is this thread's, as the web app's worker makes it)
            workbook: (engine, args) => resultWorkbook(engine, args[0] as string, args[1] as number[], args[2] as string[], args[3] as [string, string][], args[4] as StatusLayout | undefined)
        });
        return this.engine;
    }

    /**
     * A view's rows, wherever they are: held here, or read again from storage when the new engine
     * holds them and they were let go here (only for what still needs them all: SQLite, a new
     * engine, the view's own rows table). Not kept: they are let go again when done.
     */
    private async rowsOf(id: string): Promise<QueryRowData[]> {
        const loaded = this.loaded.get(id);
        if (!loaded) return [];
        if (!loaded.dropped) return loaded.rows;
        const source = this.query?.sources.find(s => s.id === id);
        if (!source) return [];
        // (read again from storage: said where the user is looking, the footer and Results' working line)
        let again: LoadedView;
        try {
            again = await this.readView(source, (text, done, total) => {
                this.post({ type: 'query.progress', text, done, total });
                this.post({ type: 'query.reading', stage: text, done, total });
            });
        } finally {
            // (the page is told the reading is over: its step bar stops working, Next and Back work again)
            this.post({ type: 'query.idle' });
        }
        // (its rows were here before: not finding them now is said, never run as an empty view)
        if (again.error) throw new Error(`${source.name}: ${again.error}`);
        return again.rows;
    }

    /** How many rows a view has (held, or let go to the engine). */
    private rowCount(id: string): number {
        const loaded = this.loaded.get(id);
        return loaded?.dropped ? loaded.dropped.count : loaded?.rows.length ?? 0;
    }

    /** The new engine holds this view: its rows are let go here, its counts and samples kept. */
    private dropRows(id: string): void {
        const loaded = this.loaded.get(id);
        if (!loaded || loaded.dropped || loaded.error || !loaded.rows.length) return;
        this.filledRows(id);
        loaded.dropped = { count: loaded.rows.length, samples: new Map(loaded.columns.map(c => [c, sample(loaded.rows, c)])) };
        loaded.rows = [];
    }

    /** A view's rows read from where they are kept: a file's on this computer, a run's from its results. */
    /** Response files read and made rows of at a time: the page gives way between them, and says how far it has got. */
    private static readonly READ_FILES = 50;

    private async readView(source: QuerySource, said?: (text: string, done: number, total: number, rows: number) => void, sink?: (columns: string[], rows: QueryRowData[]) => Promise<void>): Promise<LoadedView> {
        if (source.file) {
            const kept = await this.ports.queryFiles?.read(this.query?.id ?? '', source.id);
            return kept
                ? { ...kept, rowBasis: 'line' }
                : { columns: [], rows: [], rowBasis: 'line', error: 'Pick the file again: its rows are not on this computer.' };
        }
        try {
            await this.ports.preloadRun?.(source.executionId);
            const config = await buildConsoleReportConfig({
                executionId: source.executionId,
                isBatch: source.isBatch,
                executionMetadataService: this.ports.metadata,
                environments: this.ports.environments,
            });
            const views = await this.successViews(source.endpointId);
            const saved = views.find(v => v.name === source.view);
            // A view that has gone is said, never swapped for other columns
            if (source.view && !saved) throw new Error(`The view "${source.view}" is no longer in the Console.`);
            // A run's responses a few files at a time (a batch of 210 pages: never all of them parsed at once,
            // never one long block on the page): each piece's rows made, its responses let go
            const files = config.responseFiles;
            const step = QueryController.READ_FILES;
            const name = runName(this.query!, source.id) || source.name;
            let view = saved;
            let named: { id: string; name: string }[] | undefined;
            const rows: QueryRowData[] = [];
            let read = 0;
            for (let at = 0; at < Math.max(1, files.length); at += step) {
                const responses = await this.extractor.extractResponses(files.slice(at, at + step), config.responseFileStatusMap, config.responseFileDetails);
                view ??= rootView(responses);
                const side = buildCompareSide(responses, view);
                // (the columns from the first piece with a completed response, as the whole run's first would give them)
                if (!named && (side.rows.length || at + step >= files.length)) {
                    // Headed as the Console heads them; two columns sharing a header keep their paths
                    const count = new Map<string, number>();
                    side.columns.forEach(c => count.set(c.name, (count.get(c.name) ?? 0) + 1));
                    named = side.columns.map(c => ({ id: c.id, name: (count.get(c.name) ?? 0) > 1 ? c.id : c.name }));
                }
                const piece: QueryRowData[] = [];
                for (const row of side.rows) {
                    const out: QueryRowData = {};
                    for (const c of named ?? []) out[c.name] = row[c.id];
                    piece.push(out);
                }
                // (into the engine as it is read, or held here)
                if (sink && piece.length) await sink((named ?? []).map(c => c.name), piece);
                else for (const row of piece) rows.push(row);
                read += piece.length;
                const done = Math.min(files.length, at + step);
                if (files.length > step) {
                    said?.(`Reading ${name}: ${read.toLocaleString('en-US')} rows (page ${done.toLocaleString('en-US')} of ${files.length.toLocaleString('en-US')})`, done, files.length, read);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            return { columns: (named ?? []).map(c => c.name), rows, rowBasis: view?.rowBasis || 'root' };
        } catch (error) {
            return { columns: [], rows: [], rowBasis: 'root', error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * The query as SQLite can run it now: the views that loaded, up to the first join still
     * missing its pairs (the views after it wait for the user), and the columns still there.
     */
    private spec(): { spec: QuerySpec; waiting: string[] } {
        const query = this.query!;
        const usable = (s: QuerySource) => (this.loaded.get(s.id)?.columns.length ?? 0) > 0;
        const views: QuerySpec['views'] = [];
        const joins: QueryJoin[] = [];
        const waiting: string[] = [];
        const has = (ref: ColumnRef) => ref.view === CALC_VIEW
            ? !!query.calc?.some(c => c.name === ref.column)
            : views.some(v => v.id === ref.view && v.columns.includes(ref.column));
        // Each view joins once the views its join names are in, wherever they sit on screen (a view moved keeps its join:
        // James, 2026-11-22): passes over the views in screen order until none more can join
        const viewOf = (source: QuerySource) => {
            const run = runName(query, source.id);
            return {
                id: source.id, name: source.name, columns: this.loaded.get(source.id)?.columns ?? [], empty: this.emptyColumns(source.id),
                ...(run ? { run, runOfName: query.sources.find(s => s.id === (source.runOf ?? source.id))?.name ?? source.name } : {})
            };
        };
        const left = query.sources.filter(source => {
            // A view sits out on its own (hidden, unread): the others carry on, so a report can be looked at before every view is in
            if (!usable(source) || source.off) { waiting.push(source.id); return false; }
            return true;
        });
        for (let more = true; more && left.length;) {
            more = false;
            for (let i = 0; i < left.length; i++) {
                const source = left[i];
                const view = viewOf(source);
                if (views.length) {
                    const join = query.joins.find(j => j.view === source.id);
                    const complete = !!join && join.on.length > 0 && join.on.every(p => p.left.parts.every(has) && p.right.parts.every(c => view.columns.includes(c.column)));
                    if (!complete) continue;
                    joins.push(join!);
                }
                views.push(view);
                left.splice(i, 1);
                more = true;
                break;
            }
        }
        // (not joined yet, or joined to a view that isn't in: they wait)
        left.forEach(source => waiting.push(source.id));
        // A joining view's key is never shown beside the column it matches: it says the same twice
        const keys = new Set(joinKeyColumns({ views, joins, select: [] }).map(k => `${k.key.view}\n${k.key.column}`));
        const picked = (query.select ?? []).filter(has).filter(c => !keys.has(`${c.view}\n${c.column}`));
        // A compare's key leads the report, every column of it, in the key's order: a column added to the key on Join
        // (+ AND) is in Results too, not only the first (James, 2026-11-22: "I can ONLY see 1 key")
        const compareJoin = joins.find(j => j.kind === 'compare');
        const keyCols = compareJoin ? compareJoin.on.flatMap(p => p.left.parts).filter(p => !p.fns?.length && has({ view: p.view, column: p.column })).map(p => ({ view: p.view, column: p.column })) : [];
        const isKeyCol = (c: ColumnRef) => !c.fns?.length && keyCols.some(k => k.view === c.view && k.column === c.column);
        const select = picked.length && keyCols.length ? [...keyCols, ...picked.filter(c => !isKeyCol(c))] : picked;
        // A calculated column whose columns are gone (a View changed under it) is left out and said on Columns, never
        // the whole query failing for it (James, 2026-11-22; as agreed 2026-11-20: such a calculation is flagged)
        const broken = new Map<string, string>();
        const allCalc = query.calc ?? [];
        const named = formulaColumns({ views, joins, select, distinct: query.distinct, calc: allCalc });
        const calc = allCalc.filter(c => {
            if (!c.formula) return true;
            try { parseFormula(c.formula, named); return true; } catch (e) { broken.set(c.name, e instanceof Error ? e.message : String(e)); return false; }
        });
        this.brokenCalcs = broken;
        const shown = broken.size ? select.filter(c => !(c.view === CALC_VIEW && broken.has(c.column))) : select;
        return { spec: { views, joins, select: shown, distinct: query.distinct, calc }, waiting };
    }

    /** Load what isn't loaded, run the query, and send the page everything the steps show. */
    private async refresh(): Promise<void> {
        const query = this.query;
        if (!query) return;
        const version = ++this.version;
        for (let i = 0; i < query.sources.length; i++) {
            if (this.loaded.has(query.sources[i].id)) continue;
            this.post({ type: 'query.progress', text: `Reading ${query.sources[i].name}`, done: i, total: query.sources.length, view: query.sources[i].id });
            await this.load(query.sources[i]);
            if (version !== this.version || this.closed) return;
            // (each view's count shows as soon as it is read, the next one's bar starts: one at a time, in order)
            if (query.sources.slice(i + 1).some(s => !this.loaded.has(s.id))) this.postState({ reading: true });
        }
        const { spec, waiting } = this.spec();
        this.result = undefined;
        this.filtered = undefined;
        let sql = '';
        let total = 0;
        let stats: (QueryJoinStats | null)[] = [];
        let preview: unknown[][] = [];
        let columns: ColumnRef[] = [];
        let failure = '';
        let sqlError = '';
        let resultColumns: ColumnRef[] | undefined;
        // What kind of values each of Results' columns holds, going by its first rows
        let resultTypes: ColumnType[] = [];
        let sampleRow: { view: string; column: string; value: string }[] = [];
        // Each report column on that record, after its functions, and whether it differs (Columns)
        let columnCells: { value: string; differs: boolean }[] = [];
        let duplicates = 0;
        let notNumbers: NotNumbers = [];
        let sample: SampleFacts | undefined;
        if (spec.views.length) {
            try {
                // On the new engine, sql.js is not touched: no views loaded into it, no SQL run
                const onEngine = this.onEngine(spec);
                // The report's columns (Columns' step); Results' own, a COMPARE calculation a column per side
                columns = spec.select.length ? spec.select : defaultColumns(spec);
                resultColumns = resultColumnRefs(spec);
                // The step draws at once (its lines, samples from each view's own rows), saying it is counting
                // and since when; then the counting, which on large results can take a while. Said before the
                // database and the lookup tables are ready (a tab's first database takes seconds): the views are
                // read, so Views is done and Next works (James, 2026-11-22: three seconds waiting on Next: Join)
                const since = new Date().toISOString();
                const t0 = Date.now();
                this.postState({ waiting, counting: since, columns, resultColumns, sql, stats: new Map() });
                const session = onEngine ? undefined : await this.sessionFor(spec, version);
                if (!onEngine && !session) return;
                const t1 = Date.now();
                if (this.ports.lookups) this.lookupList = await this.ports.lookups.list();
                if (session) await this.loadLookups(session, spec);
                sql = session ? session.sql() : '';
                // ([query-open]: where a refresh's time goes, in the console)
                console.log(`[query-open] ${onEngine ? 'engine' : `database ${t1 - t0} ms`} · lookups ${Date.now() - t1} ms`);
                // Each stage said as it starts (the page counts the seconds); Stop, or any change, ends it between stages
                const stage = async (text: string): Promise<boolean> => {
                    this.post({ type: 'query.counting', since, stage: text });
                    await new Promise<void>(resolve => setTimeout(resolve, 40));
                    return version === this.version && !this.closed;
                };
                if (onEngine) {
                    // On the new engine: its stages said as they come (Stop reaches it between slices)
                    let said = '';
                    const words: Record<string, string> = { Starting: 'Starting', Done: 'Reading the rows' };
                    let result: QueryResult | undefined;
                    let kept: PagedResult | undefined;
                    const onStage = (stg: string) => {
                        // (the engine names a view by its id: said by its name)
                        const named = spec.views.reduce((t, v) => t.split(v.id).join(v.run || v.name), stg);
                        const text = words[stg] ?? (stg.startsWith('Comparing') ? `Comparing ${spec.views.length} views` : named);
                        if (text !== said) { said = text; this.post({ type: 'query.counting', since, stage: text }); }
                    };
                    try {
                        // Not a compare: its rows stay in the engine, Results reads them a page at a time
                        // (Stop, or a newer change, while the views go into the engine: no run after)
                        const wanted = () => version === this.version && !this.closed;
                        if (this.pagedOn(spec, '')) kept = await this.engineKept(spec, onStage, wanted);
                        else result = await this.engineRead(spec, engineKey(spec), onStage, wanted);
                    } catch (error) {
                        // Past the row limit: the joins' figures until then still show, and the step says why
                        if (error instanceof TooManyOnEngine) {
                            const counted = error.stats;
                            stats = spec.joins.map(j => counted.get(j.view) ?? null);
                            throw new Error(tooManyRowsText(error.tooMany, spec));
                        }
                        throw error;
                    }
                    if ((!result && !kept) || version !== this.version || this.closed) return;
                    duplicates = this.engineDuplicates;
                    notNumbers = this.engineNotNumbers;
                    sample = this.engineSampleFacts;
                    stats = spec.joins.map(j => this.engineStats?.get(j.view) ?? null);
                    // The Columns step's sample record and its cells, from the engine
                    const sampled = await this.engineSample(spec, columns);
                    sampleRow = sampled.row;
                    columnCells = sampled.cells;
                    if (kept && this.engine) {
                        total = kept.total;
                        preview = await readPage(this.engine, kept, 0, PREVIEW_ROWS);
                        resultTypes = columnTypes(await spreadPage(this.engine, kept, TYPE_SAMPLE), resultColumns.length);
                    } else if (result) {
                        total = result.rows.length;
                        preview = result.rows.slice(0, PREVIEW_ROWS);
                        resultTypes = columnTypes(spread(result.rows, TYPE_SAMPLE), resultColumns.length);
                    }
                } else if (session) {
                    if (!await stage('Checking how many rows the joins make')) return;
                    // A join that would make far too many rows is never made: it would fill the page's memory
                    const tooMany = session.tooManyRows();
                    if (tooMany) {
                        stats = spec.joins.map((_, i) => (i <= tooMany.join ? session.joinStats(i) : null));
                        throw new Error(tooManyRowsText(tooMany, spec));
                    }
                    if (!await stage('Counting the rows')) return;
                    total = session.count();
                    // Rows alike in every column shown: what Distinct would fold (or has)
                    const other = Number(session.run(`SELECT COUNT(*) FROM (${writeSql({ ...spec, distinct: !spec.distinct })})`).rows[0]?.[0] ?? 0);
                    duplicates = Math.abs(other - total);
                    stats = [];
                    for (let i = 0; i < spec.joins.length; i++) {
                        if (!await stage(spec.joins.length > 1 ? `Counting how the records meet: join ${i + 1} of ${spec.joins.length}` : 'Counting how the records meet')) return;
                        stats.push(session.joinStats(i));
                    }
                    if (!await stage('Reading the first rows')) return;
                    preview = session.rows({ limit: PREVIEW_ROWS }).rows;
                    // (from rows across the whole result, so a column that changes further down is not mislabelled)
                    resultTypes = columnTypes(session.sample(TYPE_SAMPLE).rows, resultColumns.length);
                    const sampled = this.sampleRow(session, spec, columns);
                    sampleRow = sampled.row;
                    columnCells = sampled.cells;
                    if (query.sql) {
                        // The user's own SQL: Results shows what it makes
                        try {
                            const own = this.read(session, spec);
                            total = own.rows.length;
                            resultColumns = own.columns;
                            resultTypes = columnTypes(spread(own.rows, TYPE_SAMPLE), own.columns.length);
                        } catch (error) {
                            sqlError = error instanceof Error ? error.message : String(error);
                        }
                    }
                }
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            }
        }
        if (query.rows !== total && !failure) {
            query.rows = total;
            await saveQuery(this.ports.state, query);
        }
        this.postState({ waiting, stats: new Map(spec.joins.map((j, i) => [j.view, stats[i]])), columns, resultColumns, resultTypes, sampleRow, columnCells, duplicates, notNumbers, sql, total, preview, error: failure, sqlError, ...(sample ? { sample } : {}) });
        // The Join step's counts, every record, run by run (on the new engine)
        if (version === this.version && !this.closed) {
            // (why there are no counts, when there are none: said where they would be, never a bar that waits forever)
            // The counts need only the views and their keys: a calculated column that no longer works (a View changed
            // under it) doesn't stop them; the step that has it says what is wrong (James, 2026-11-22)
            const why = !this.engineOn ? (this.engineNote || 'Counts come once every view in the compare has its key column.') : '';
            void this.countJoin(this.engineOn ? { ...spec, calc: [], select: [] } : undefined, why);
        }
    }

    /**
     * The Join step's counts (James, 2026-11-22, mock v30): every record counted, not a sample. Each run or
     * view in the compare against the Baseline in turn, its figures sent as soon as they're in, how far it
     * has got while it runs; then the whole compare once, for Results' rows. Counts for this key are kept:
     * a change elsewhere (Columns) sends them again. A key change stops what is running at once and starts
     * again once the key has stayed the same for half a second; the old figures show, greyed, till then.
     */
    private async countJoin(spec: QuerySpec | undefined, why = ''): Promise<void> {
        const plan = spec ? joinCountPlan(spec) : undefined;
        const key = plan ? plan.key + JSON.stringify([plan.baseline, ...plan.pairs.map(p => p.view)].map(id => this.streamed.get(id) ?? '')) : '';
        if (!plan) {
            // ([query-join]: each decision in the console, to read when the counts don't come)
            console.log(`[query-join] no counts: ${why || (spec ? 'not a compare with every key column picked' : 'no query to count')}`);
            this.stopJoinCount();
            this.joinCounts = undefined;
            this.post({ type: 'query.joinCounts', counts: null, why: why || (spec ? 'Counts come once every view in the compare has its key column.' : '') });
            return;
        }
        if (key === this.joinCountKey && this.joinCounts) { console.log('[query-join] counts kept: the key is as before'); this.post({ type: 'query.joinCounts', counts: this.joinCounts }); return; }
        console.log(`[query-join] counting ${plan.pairs.length} against ${plan.baseline}`);
        this.stopJoinCount();
        const run = ++this.joinCountRun;
        this.joinCountKey = key;
        const before = this.joinCounts?.views ?? {};
        const counts: JoinCounts = {
            baseline: plan.baseline,
            views: Object.fromEntries(plan.pairs.map(p => [p.view, { state: 'waiting' as const, ...(before[p.view]?.count ? { count: before[p.view].count, stale: true } : {}) }])),
            results: this.joinCounts?.results ? { ...this.joinCounts.results, stale: true } : undefined
        };
        this.joinCounts = counts;
        const send = () => { if (run === this.joinCountRun && !this.closed) this.post({ type: 'query.joinCounts', counts: structuredClone(counts) }); };
        send();
        await new Promise(resolve => setTimeout(resolve, JOIN_COUNT_QUIET_MS));
        const live = () => run === this.joinCountRun && !this.closed;
        if (!live()) return;
        const host = this.engineHostNow();
        // One compare, how far it has got sent at most ten times a second; undefined when stopped or failed
        const counting = async (query: EngineQuery, said: (done: number, total: number) => void): Promise<string | undefined> => {
            let at = 0;
            const out = await host.run(query, {
                onProgress: p => {
                    this.joinCountRunning = { host, id: p.result };
                    if (!live()) { host.cancel(p.result); return; }
                    const now = Date.now();
                    if (p.total > 0 && now - at > 100) { at = now; said(p.done, p.total); }
                }
            }).catch(() => undefined);
            this.joinCountRunning = undefined;
            const id = out && 'result' in out ? out.result : undefined;
            if (id && !live()) { void host.release(id).catch(() => undefined); return undefined; }
            return id;
        };
        for (const pair of plan.pairs) {
            if (!live()) return;
            counts.views[pair.view] = { ...counts.views[pair.view], state: 'counting', done: 0, total: 0 };
            send();
            const out = await counting(pair.query, (done, total) => { counts.views[pair.view] = { ...counts.views[pair.view], done, total }; send(); });
            if (!live()) return;
            if (!out) { console.log(`[query-join] ${pair.view}: the count did not finish`); counts.views[pair.view] = { state: 'failed' }; send(); continue; }
            const stats = await host.stats(out, 'compare').catch(() => undefined) as CompareStats | undefined;
            // (kept: the records behind its counts are read from it when one is clicked)
            this.joinCountKept.set(pair.view, { host, id: out, baseline: plan.baseline });
            counts.views[pair.view] = stats ? { state: 'done', count: joinCountOf(stats) } : { state: 'failed' };
            send();
        }
        // Results' rows: the whole compare, once
        if (!live()) return;
        counts.results = { ...(counts.results ?? { rows: 0, inEvery: 0 }), state: 'counting' };
        send();
        const whole = await counting(plan.whole, () => undefined);
        if (!live()) return;
        const stats = whole ? await host.stats(whole, 'compare').catch(() => undefined) as CompareStats | undefined : undefined;
        if (whole) void host.release(whole).catch(() => undefined);
        counts.results = stats ? { state: 'done', rows: stats.rows, inEvery: stats.status.same + stats.status.diff } : undefined;
        send();
    }

    /** The Join step's count under way, stopped (its run cancelled in the engine). */
    private stopJoinCount(): void {
        this.joinCountRun++;
        if (this.joinCountRunning) this.joinCountRunning.host.cancel(this.joinCountRunning.id);
        this.joinCountRunning = undefined;
        this.joinCountKey = '';
        this.joinCountKept.forEach(k => { if (k.host.alive()) void k.host.release(k.id).catch(() => undefined); });
        this.joinCountKept.clear();
    }

    /** Each pair's compare, kept while its counts stand: what a count's records are read from. */
    private readonly joinCountKept = new Map<string, { host: EngineHost; id: string; baseline: string }>();

    /** Calculated columns left out of the query because a column they name is gone, by name, with why. */
    private brokenCalcs = new Map<string, string>();
    private joinCounts: JoinCounts | undefined;
    private joinCountKey = '';
    private joinCountRun = 0;
    private joinCountRunning: { host: EngineHost; id: string } | undefined;

    /** How many of a view's rows have a value in each column (counted once for the rows as loaded). */
    private filledRows(id: string): Map<string, number> {
        const loaded = this.loaded.get(id);
        if (!loaded || loaded.error) return new Map();
        let filled = this.filled.get(loaded);
        if (!filled) {
            const counts = new Map(loaded.columns.map(column => [column, 0]));
            for (const row of loaded.rows) {
                for (const column of loaded.columns) {
                    const v = row[column];
                    if (v !== null && v !== undefined && v !== '') counts.set(column, (counts.get(column) ?? 0) + 1);
                }
            }
            filled = counts;
            this.filled.set(loaded, filled);
        }
        return filled;
    }

    /** A view's columns with no value in any of its rows. */
    private emptyColumns(id: string): string[] {
        if (!this.rowCount(id)) return [];
        return [...this.filledRows(id)].filter(([, n]) => n === 0).map(([column]) => column);
    }

    /**
     * One row as the report will have it, every view's columns: the first where every join found
     * its match, so each view has a value to show (or the first row there is, when none does).
     */
    /**
     * One record of the query, every view's columns as they are, and each report column (`columns`)
     * after its functions, with whether it differs from its compared column's first cell in slot
     * order (columnCellDiffs): what Join and Columns show under each name.
     */
    private sampleRow(session: QuerySession, spec: QuerySpec, columns: ColumnRef[]): { row: { view: string; column: string; value: string }[]; cells: { value: string; differs: boolean }[] } {
        const raw = allColumns(spec).filter(c => c.view !== CALC_VIEW);
        const shown = columns.map((c, i) => ({ c, i })).filter(x => x.c.view !== CALC_VIEW && spec.views.some(v => v.id === x.c.view));
        const select = [...raw, ...shown.map(x => ({ view: x.c.view, column: x.c.column, ...(x.c.fns?.length ? { fns: x.c.fns } : {}) }))];
        const one = (inner: boolean): unknown[] | undefined => session.run(writeSql({
            views: spec.views, joins: inner ? spec.joins.map(j => ({ ...j, kind: 'inner' as const })) : spec.joins, select, calc: spec.calc
        }, { limit: 1 })).rows[0];
        const got = one(true) ?? one(false);
        if (!got) return { row: [], cells: columns.map(() => ({ value: '', differs: false })) };
        const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60);
        const values = columns.map(() => '');
        shown.forEach((x, k) => { values[x.i] = text(got[raw.length + k]); });
        const order = this.query?.sources.map(src => src.id) ?? [];
        const differs = columnCellDiffs(columns, values, view => { const at = order.indexOf(view); return at < 0 ? order.length : at; });
        return { row: raw.map((c, i) => ({ view: c.view, column: c.column, value: text(got[i]) })), cells: values.map((value, i) => ({ value, differs: differs[i] })) };
    }

    /** sampleRow on the new engine: the same record and cells, read without sql.js. */
    private async engineSample(spec: QuerySpec, columns: ColumnRef[]): Promise<{ row: { view: string; column: string; value: string }[]; cells: { value: string; differs: boolean }[] }> {
        const raw = allColumns(spec).filter(c => c.view !== CALC_VIEW);
        const shown = columns.map((c, i) => ({ c, i })).filter(x => x.c.view !== CALC_VIEW && spec.views.some(v => v.id === x.c.view));
        const { everyView, any } = sampleQueries(spec, raw, shown.map(x => ({ view: x.c.view, column: x.c.column, ...(x.c.fns?.length ? { fns: x.c.fns } : {}) })));
        const got = (await this.engineWindow(spec, everyView, 1)).rows[0] ?? (await this.engineWindow(spec, any, 1)).rows[0];
        if (!got) return { row: [], cells: columns.map(() => ({ value: '', differs: false })) };
        const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60);
        const values = columns.map(() => '');
        shown.forEach((x, k) => { values[x.i] = text(got[raw.length + k]); });
        const order = this.query?.sources.map(src => src.id) ?? [];
        const differs = columnCellDiffs(columns, values, view => { const at = order.indexOf(view); return at < 0 ? order.length : at; });
        return { row: raw.map((c, i) => ({ view: c.view, column: c.column, value: text(got[i]) })), cells: values.map((value, i) => ({ value, differs: differs[i] })) };
    }

    /** Everything the steps show. `reading`: a view was just added and its rows are still being read. */
    private postState(now: { reading?: boolean; counting?: string; waiting?: string[]; stats?: Map<string, QueryJoinStats | null>; columns?: ColumnRef[]; resultColumns?: ColumnRef[]; resultTypes?: ColumnType[]; sampleRow?: { view: string; column: string; value: string }[]; columnCells?: { value: string; differs: boolean }[]; duplicates?: number; notNumbers?: NotNumbers; sql?: string; total?: number; preview?: unknown[][]; error?: string; sqlError?: string; sample?: SampleFacts }): void {
        const query = this.query;
        if (!query) return;
        const tables = tableNames(query.sources.map(s => ({ id: s.id, name: s.name, columns: [] })));
        this.post({
            type: 'query.state',
            reading: !!now.reading,
            name: query.name,
            views: query.sources.map(s => {
                const loaded = this.loaded.get(s.id);
                return {
                    id: s.id, name: s.name, alias: s.name, table: tables.get(s.id), endpointName: s.endpointName, view: s.view,
                    endpointId: s.endpointId, executionId: s.executionId,
                    request: s.request ?? '', system: s.system ?? '', file: s.file?.name ?? '', sheet: s.file?.sheet ?? '',
                    environment: s.environment, executedAt: s.executedAt, rowBasis: loaded?.rowBasis ?? 'root',
                    rows: this.rowCount(s.id), error: loaded?.error ?? '', reading: !loaded,
                    waiting: !!now.waiting?.includes(s.id), off: !!s.off,
                    // A run of a view (C1...), or BL for its first run; the first run's id
                    run: runName(query, s.id), runOf: s.runOf ?? '',
                    columns: (loaded?.columns ?? []).map(name => ({ name, sample: loaded!.dropped ? loaded!.dropped.samples.get(name) ?? '' : sample(loaded!.rows, name), filled: this.filledRows(s.id).get(name) ?? 0, empty: !!this.rowCount(s.id) && !this.filledRows(s.id).get(name) }))
                };
            }),
            joins: query.joins.map(j => ({
                view: j.view, kind: j.kind,
                on: j.on.map(p => ({ left: p.left.parts[0], right: p.right.parts[0] })),
                stats: now.stats?.get(j.view) ?? null
            })),
            columns: (now.columns ?? []).map(c => ({ view: c.view, column: c.column, ...(c.fns?.length ? { fns: c.fns } : {}), ...(c.group ? { group: c.group } : {}) })),
            // One row of the report, every view's columns: what Columns shows under each name
            sampleRow: now.sampleRow ?? [],
            // Counting how the rows meet, since then (an ISO time): the step is drawn, its counts still to come
            counting: now.counting ?? null,
            // Columns' cells, by report column: the value after its functions, and amber or not
            columnCells: now.columnCells ?? [],
            // A joining view's key, and the column it is matched to: not shown twice
            keyColumns: joinKeyColumns(this.spec().spec).map(k => ({ view: k.key.view, column: k.key.column, sameView: k.same.view, sameColumn: k.same.column })),
            allSelected: !(query.select?.length),
            distinct: !!query.distinct,
            duplicates: now.duplicates ?? 0,
            // Results' columns where text read as a number wasn't one (left blank): how many rows
            notNumbers: now.notNumbers ?? [],
            maxViews: MAX_QUERY_VIEWS,
            maxPerEndpoint: MAX_COMPARE_VIEWS,
            // A Compare join makes the query a compare: its Baseline and the views in it
            compare: queryCompare(query.joins, query.sources[0]?.id) ?? null,
            // Results' Status: the places a row can differ or be missing in (none: no compared column)
            statusPlaces: this.statusPlaces(),
            // Translate values: the lookup tables to pick from, each with its columns
            lookupTables: this.lookupList.map(t => ({ id: t.id, name: t.name, count: t.rows, columns: t.columns.map(c => ({ id: c.id, name: c.name })) })),
            maxCompare: MAX_COMPARE_VIEWS,
            // Results' columns: the steps', or what the user's own SQL makes
            resultColumns: (now.resultColumns ?? now.columns ?? []).map((c, i) => ({ view: c.view, column: c.column, type: now.resultTypes?.[i] ?? 'text', ...(c.group ? { group: c.group } : {}) })),
            // What the calculation builder offers: every column by its @ path, and the functions
            formulaColumns: this.formulaColumnsFor(),
            formulaFunctions: FORMULA_FUNCTIONS.map(f => ({ ...f, max: Number.isFinite(f.max) ? f.max : null })),
            calc: query.calc ?? [],
            // (each calculated column left out, and why: Columns says so, with Change and Delete)
            brokenCalcs: [...this.brokenCalcs].map(([name, error]) => ({ name, error })),
            ownSql: query.sql ?? '', sqlError: now.sqlError ?? '',
            search: query.search ?? '', sort: query.sort ?? null, totals: !!query.totals,
            widths: query.widths ?? {},
            sql: now.sql ?? '', total: now.total ?? 0, preview: now.preview ?? [], error: now.error ?? '',
            // "New compare engine (testing)": on the new engine (its counts' values not opened yet), or why not
            onEngine: this.engineOn, engineNote: this.engineNote,
            // (a compare's figures of a sample, until Results has worked out the whole: the step says so)
            sample: now.sample ?? null
        });
    }

    /** The database with this spec's views loaded as tables (loaded again only when the views change). */
    private async sessionFor(spec: QuerySpec, version: number): Promise<QuerySession | undefined> {
        const key = JSON.stringify(spec.views.map(v => [v.id, v.name, v.columns]));
        if (this.session && this.sessionKey === key) {
            this.session.setSpec(spec);
            return this.session;
        }
        this.session?.close();
        this.session = undefined;
        this.lookupsLoaded.clear();
        const SQL = await this.ports.sql();
        const session = new QuerySession(SQL, spec);
        for (const view of spec.views) {
            const rows = await this.rowsOf(view.id);
            await session.load(view.id, rows, done => this.post({ type: 'query.progress', text: `Loading ${view.name}`, done, total: rows.length }));
            if (version !== this.version || this.closed) { session.close(); return undefined; }
        }
        this.session = session;
        this.sessionKey = key;
        return session;
    }

    /** One window of Results' rows, after the search and the sort. */
    private async rows(message: RowsRequest): Promise<void> {
        this.shown = { search: message.search, sort: message.sort, filter: message.filter };
        // What the user asked for goes first: Distinct's count in the background stops (or doesn't start yet), and starts again after
        if (this.alikeTimer) { clearTimeout(this.alikeTimer); this.alikeTimer = undefined; this.alikeNext ??= this.alikePending; }
        if (this.alikeRunning) {
            this.alikeRunning.host.cancel(this.alikeRunning.id);
            this.alikeRunning = undefined;
            this.alikeNext ??= this.alikeAgain;
        }
        // Each part's time, in the console as "[query-results] …" (the setting is for testing)
        const started = performance.now();
        let at = started;
        const laps: string[] = [];
        this.lap = (what: string) => { const t = performance.now(); laps.push(`${what} ${Math.round(t - at)}`); at = t; };
        const shown = await this.shownRows(message);
        this.lap('rows found');
        if (shown === null) return;
        if (!shown) {
            this.post({ type: 'query.rowsData', seq: message.seq, offset: 0, rows: [], shown: 0, total: 0 });
            return;
        }
        const offset = Math.max(0, Math.floor(Number(message.offset) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(message.limit) || 200)));
        const page = await shown.page(offset, limit);
        this.lap('page read');
        const counts = shown.counts && offset === 0 ? await shown.counts() ?? {} : {};
        this.lap('counts');
        const totals = message.totals && offset === 0 ? await shown.totals() : {};
        this.lap('totals');
        this.post({
            type: 'query.rowsData', seq: message.seq, offset,
            ...page,
            // Every control's counts: among the rows the search finds, and among them all
            ...counts,
            shown: shown.shown, total: shown.total,
            ...totals
        });
        // Distinct's count waits for this page, and for Results to be left a moment (clicks in a row never meet it)
        const next = this.alikeNext;
        this.alikeNext = undefined;
        if (next) {
            this.alikePending = next;
            this.alikeTimer = setTimeout(() => { this.alikeTimer = undefined; this.alikePending = undefined; if (!this.closed) next(); }, ALIKE_AFTER_MS);
        }
        if (this.engineOn) console.log(`[query-results] rows ${offset}+${limit} (${shown.shown} of ${shown.total}) in ${Math.round(performance.now() - started)} ms: ${laps.join(' · ')} (ms)`);
        this.lap = () => undefined;
    }

    /** Results' request's parts timed (rows): a no-op between requests. */
    private lap: (what: string) => void = () => undefined;

    /**
     * A column of Results dragged to a new place. The rows are the same ones, so nothing is read
     * again: the order is saved, and the rows held here have the value moved in each.
     */
    private async moveColumn(from: number, to: number): Promise<void> {
        const query = this.query;
        if (!query || query.sql) return;
        const { spec } = this.spec();
        // (a column keeps its functions, and its place in a compared column)
        const columns = (spec.select.length ? spec.select : defaultColumns(spec)).map(c => ({ ...c }));
        // Results' columns may be more (a COMPARE calculation is a column per side): its places map back to the report's
        const shown = resultColumnRefs(spec);
        if (shown.length !== columns.length) {
            const owner = shown.map(c => columns.findIndex(x => x.view === c.view && (x.column === c.column || (c.group !== undefined && x.view === CALC_VIEW && x.column === c.group))));
            const a = owner[from];
            const b = owner[to];
            if (a === undefined || b === undefined || a < 0 || b < 0 || a === b) return;
            const move2 = <T>(list: T[]): void => { list.splice(b, 0, list.splice(a, 1)[0]); };
            move2(columns);
            query.select = columns;
            query.sort = null;
            await saveQuery(this.ports.state, query);
            this.result = undefined;
            this.filtered = undefined;
            await this.refresh();
            return;
        }
        const inRange = (n: number): boolean => Number.isInteger(n) && n >= 0 && n < columns.length;
        if (!inRange(from) || !inRange(to) || from === to) return;
        const move = <T>(list: T[]): void => { list.splice(to, 0, list.splice(from, 1)[0]); };
        const result = this.result;
        const held = !!result && result.columns.length === columns.length && result.columns.every((c, i) => c.view === columns[i].view && c.column === columns[i].column);
        move(columns);
        query.select = columns;
        // The sort follows its column
        const follow = (sort: { column: number; dir: 'asc' | 'desc' } | null | undefined): void => {
            if (!sort) return;
            const gone = sort.column > from ? sort.column - 1 : sort.column;
            sort.column = sort.column === from ? to : gone >= to ? gone + 1 : gone;
        };
        follow(query.sort);
        if (this.shown.sort !== query.sort) follow(this.shown.sort);
        const now = this.spec().spec;
        this.session?.setSpec(now);
        const sql = this.session?.sql() ?? '';
        // (on the new engine too: the rows held are moved, not read again)
        const onEngine = this.onEngine(now);
        if (result && held && (this.session || onEngine)) {
            for (const row of result.rows) move(row);
            result.columns = columns;
            result.key = onEngine ? engineKey(now) : sql;
            if (this.filtered) this.filtered.key = JSON.stringify([String(query.search ?? '').trim(), query.sort ? { column: query.sort.column, dir: query.sort.dir } : null]);
        } else {
            this.result = undefined;
            this.filtered = undefined;
        }
        this.post({ type: 'query.arranged', columns, sql });
        query.updatedAt = new Date().toISOString();
        await saveQuery(this.ports.state, query);
        this.ports.host.compared?.();
    }

    /** Export to Excel: the rows Results shows (its search and sort), and a sheet saying what made them. */
    private async export(message: RowsRequest): Promise<void> {
        const query = this.query;
        const files = this.ports.files;
        if (!files) throw new Error('This app cannot save files.');
        const found = query ? await this.shownRows(message) : undefined;
        if (!query || !found) {
            this.post({ type: 'query.exported' });
            if (found !== null) throw new Error('Nothing to export yet.');
            return;
        }
        const name = `Query ${query.name}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150);
        const target = await files.chooseSaveTarget(`${name}.xlsx`, { 'Excel Workbook': ['xlsx'] }, 'Export Query to Excel');
        if (!target) {
            this.post({ type: 'query.exported' });
            return;
        }
        // The columns Results shows: a hidden result's left out, as Results leaves them out
        const shownStatus = this.pagedStatus(this.spec().spec, message.filter ?? undefined);
        const keep = found.columns.map((_, i) => i).filter(i => !shownStatus?.hidden.length || !shownStatus.hidden.includes(shownStatus.placeOfColumn(i)));
        const headings = keep.map(i => columnHeadings(found.columns, new Map(query.sources.map(s => [s.id, s.name])))[i]);
        const search = String(message.search ?? '').trim();
        const about: [string, string][] = [
            ['Query', query.name],
            ['Rows', search ? `${found.shown} of ${found.total}` : String(found.total)],
            ...(search ? [['Search', search] as [string, string]] : []),
            ...query.sources.map(s => [`View ${s.name}`, [s.endpointName, s.system, s.request, s.view, s.environment, s.executedAt].filter(Boolean).join(' · ')] as [string, string]),
            // A compare's own (#13, as old Compare's file): its key, what it compares, each view's rows, the Status counts
            // Results showed and the filters on
            ...this.compareSummary(message),
            // (the SQL, when it ran on SQLite)
            ...(found.key.startsWith('engine:') ? [] : found.key.split('\n').map((line, i) => [i ? '' : 'SQL', line] as [string, string]))
        ];
        let path: string;
        if (found.workbook) {
            // Made in the engine's worker, where the rows are: the page only saves the file
            this.post({ type: 'query.progress', text: `Exporting ${found.shown.toLocaleString('en-US')} rows` });
            path = await new ConsoleExportService().saveBytes(target, await found.workbook(keep, headings, about));
        } else {
            // (read a window at a time when the rows are in the engine; kept as the rows they are, no object a row)
            const data: unknown[][] = [];
            await found.each(rows => { for (const row of rows) data.push(keep.map(c => row[c])); });
            path = await new ConsoleExportService().exportArraysToExcel([
                { sheetName: 'Results', header: headings, rows: data },
                { sheetName: 'Query', header: ['', ''], rows: about }
            ], { targetUri: target });
        }
        await files.exported?.(path);
        this.ports.toast.info(`Saved ${path.split(/[\\/]/).pop()}`);
        this.post({ type: 'query.exported' });
    }

    /** The export's summary of a compare: key, compared columns, rows per view, Status counts, filters (nothing when not a compare). */
    private compareSummary(message: RowsRequest): [string, string][] {
        const query = this.query;
        const { spec } = this.spec();
        if (!query || !isCompare(spec.joins)) return [];
        const name = new Map(query.sources.map(s => [s.id, s.name]));
        const first = spec.joins.find(j => j.kind === 'compare');
        const key = (first?.on ?? []).flatMap(p => p.left.parts.map(x => x.column)).join(' + ');
        const groups = new Map<string, number>();
        spec.select.forEach(c => { if (c.group) groups.set(c.group, (groups.get(c.group) ?? 0) + 1); });
        const compared = [...groups].filter(([, n]) => n > 1).map(([g]) => g);
        const label = this.placeLabel(spec);
        const out: [string, string][] = [['', ''], ['Key', key || '(none)'], ['Compared', compared.join(', ') || '(none)']];
        spec.views.forEach(v => out.push([`Rows ${label(v.id)}`, `${this.rowCount(v.id).toLocaleString('en-US')} (${name.get(v.id) ?? v.id})`]));
        const c = message.counts;
        if (c) {
            out.push(['Same', String(c.same ?? 0)], ['DIFF', String(c.diff ?? 0)]);
            Object.entries(c.missing ?? {}).forEach(([place, n]) => out.push([`Missing ${place}`, String(n)]));
            if (c.noKey) out.push(['No key', String(c.noKey)]);
        }
        const f = message.filter;
        const filters: string[] = [];
        if (f?.kinds) filters.push(`Status: ${f.kinds.map(k => (k === 'diff' ? 'DIFF' : k === 'same' ? 'Same' : k === 'noKey' ? 'No key' : k.replace(/^missing:/, 'Missing '))).join(', ') || 'none'}`);
        if (f?.columns?.length) filters.push(`Differs in: ${f.columns.join(', ')}`);
        if (f?.relations) filters.push(`How keys meet: ${f.relations.join(', ') || 'none'}`);
        if (f?.hidden?.length) filters.push(`Hidden: ${f.hidden.join(', ')}`);
        if (message.diffsOnly) filters.push('Only diffs');
        out.push(['Filters', filters.join(' · ') || 'none']);
        return out;
    }

    /** Results is remembered as it was left: its search and its sort. */
    private async remember(search: string, sort: { column: number; dir: string } | null): Promise<void> {
        const query = this.query;
        if (!query) return;
        if ((query.search ?? '') === search && JSON.stringify(query.sort ?? null) === JSON.stringify(sort ? { column: sort.column, dir: sort.dir === 'desc' ? 'desc' : 'asc' } : null)) return;
        query.search = search || undefined;
        query.sort = sort ? { column: sort.column, dir: sort.dir === 'desc' ? 'desc' : 'asc' } : null;
        await saveQuery(this.ports.state, query);
    }

    /**
     * Are Results' rows read from the engine a page at a time? On the new engine, a query that is
     * not a compare (whose status comes from the engine's compare columns: the next piece); its
     * search is the engine's filter by the search box's own rules (query-search.ts).
     */
    private pagedOn(spec: QuerySpec, _search: string): boolean {
        // A compare's status the engine works out (query-new-engine.ts statusColumns); a plain query
        // with compared columns (no compare: no record to miss) stays held, its status rowStatus'
        const statusable = isCompare(spec.joins) || !comparedGroups(resultColumnRefs(spec)).length;
        return statusable && this.onEngine(spec);
    }

    /** A view's place on Results (BL, C1…, or its name). */
    private placeLabel(spec: QuerySpec): (viewId: string) => string {
        return viewId => runName(this.query!, viewId) || spec.views.find(v => v.id === viewId)?.name || viewId;
    }

    /** A compare's status on Results' pages: the views hidden there (not compared), the Status filter, the places' names. */
    private pagedStatus(spec: QuerySpec, filter: StatusFilter | undefined): PagedStatus | undefined {
        if (!isCompare(spec.joins)) return undefined;
        const label = this.placeLabel(spec);
        const columns = resultColumnRefs(spec);
        // A column's place as rowStatus names it: a calculation's side by compareSides, else its view's place
        const sides = compareSides(spec, label);
        const placeOfColumn = (i: number): string => (columns[i].view === CALC_VIEW ? (sides(columns[i].column) ?? / (\d+)$/.exec(columns[i].column)?.[1] ?? columns[i].column) : label(columns[i].view));
        // (a filter with nothing ticked or picked is no filter: the same rows as none)
        const active = !!filter && (!!filter.kinds || !!filter.columns?.length || !!filter.relations);
        return { filter: active ? filter : undefined, label, placeOfColumn, hidden: filter?.hidden ?? [] };
    }

    /** The paged result before the current one, kept one step longer: a page still being read from it finishes. */
    private pagedRetired: { id: string; host: EngineHost } | undefined;

    /** The current paged result is being replaced: the one before it goes now, this one when the next replaces it. */
    private retirePaged(host: EngineHost): void {
        if (this.pagedRetired && this.pagedRetired.host.alive() && this.pagedRetired.id !== this.pagedHeld?.result.id) void this.pagedRetired.host.release(this.pagedRetired.id).catch(() => undefined);
        this.pagedRetired = this.paged && this.paged.host === host ? { id: this.paged.result.id, host } : undefined;
    }

    /**
     * A compare held in the engine, every row's status worked out once (runHeld): Results' sorts,
     * searches, Status filters and counts are runs from it. Which query and hidden views it is for.
     */
    private pagedHeld: { key: string; result: PagedResult; host: EngineHost } | undefined;
    /** The Status menu's counts for a held compare and a search (shownRows). */
    private countsKept = new Map<string, StatusCounts>();
    /** The compare step of the step's last run, kept (engineKept): the sample record and a calculation's first rows read from it (engineWindow). */
    private engineCompare: { id: string; step: string; host: EngineHost; views: string } | undefined;
    /** A compare as the step last ran it (engineKept): Results holds its status from it when it is the same query. */
    private pagedBase: { key: string; result: PagedResult; host: EngineHost } | undefined;

    /** Keep `held` as the compare Results reads from; the one before is let go (unless Results' rows are still it). */
    private holdPaged(held: { key: string; result: PagedResult; host: EngineHost } | undefined): void {
        const before = this.pagedHeld;
        this.pagedHeld = held;
        if (!before || before.result.id === held?.result.id || !before.host.alive()) return;
        // (Results' rows still the old one: retirePaged lets it go a step later)
        if (this.paged?.result.id === before.result.id || this.pagedRetired?.id === before.result.id) return;
        void before.host.release(before.result.id).catch(() => undefined);
    }

    /** A compare's whole figures (runHeld), by the compare and by the query: the Join step shows them once known. */
    private fullFigures: (FullFigures & { compare: string; spec: string }) | undefined;
    /** A compare's figures for the step until then: of a sample (the Baseline's first rows). */
    private engineSampleFacts: SampleFacts | undefined;

    /** What a query compares (its views as loaded, inputs and keys): the same text, the same compare. */
    private compareKeyOf(spec: QuerySpec): string {
        return `${this.engineKey}\n${compareStepKey(buildQuery(spec).query)}`;
    }

    /** Distinct's count to work out once Results' page is sent (heldFor). */
    private alikeNext: (() => void) | undefined;
    /** Distinct's count running in the background, and how to start it again when the user's request stops it. */
    private alikeRunning: { id: string; host: EngineHost } | undefined;
    private alikeTimer: ReturnType<typeof setTimeout> | undefined;
    private alikePending: (() => void) | undefined;
    private alikeAgain: (() => void) | undefined;

    /** Distinct's count for a held compare, worked out after Results' first page and then told (still this query). */
    private async alikeLater(spec: QuerySpec, host: EngineHost, held: PagedResult): Promise<void> {
        const key = engineKey(spec);
        // (the user's next request stops it, and it starts again once that request's page is sent: rows)
        this.alikeAgain = () => void this.alikeLater(spec, host, held);
        let duplicates: number | undefined;
        try {
            duplicates = await countAlike(host, held, id => { this.alikeRunning = { id, host }; }).catch(() => undefined);
        } finally {
            this.alikeRunning = undefined;
        }
        if (duplicates !== undefined) this.alikeAgain = undefined;
        if (duplicates === undefined || this.closed || this.fullFigures?.spec !== key) return;
        this.fullFigures.duplicates = duplicates;
        this.engineDuplicates = duplicates;
        this.post({ type: 'query.figures', duplicates });
    }

    /** Results has worked out the whole compare: kept, and the page told (the Join step's figures, rows alike, numbers counted). */
    private tellFigures(spec: QuerySpec, figures: FullFigures): void {
        this.fullFigures = { ...figures, compare: this.compareKeyOf(spec), spec: engineKey(spec) };
        this.engineStats = figures.stats;
        this.engineDuplicates = figures.duplicates ?? 0;
        this.engineNotNumbers = figures.notNumbers;
        this.engineSampleFacts = undefined;
        this.pagedAll = { key: engineKey(spec), total: figures.total };
        this.post({ type: 'query.figures', stats: Object.fromEntries(spec.joins.map(j => [j.view, figures.stats.get(j.view) ?? null])), duplicates: figures.duplicates, notNumbers: figures.notNumbers, total: figures.total });
    }

    /** The held compare for this query and these hidden views: made when there is none (or another). */
    private async heldFor(spec: QuerySpec, host: EngineHost, status: PagedStatus, onStage?: (p: Progress) => void): Promise<PagedResult | undefined> {
        const key = resultsKey(engineKey(spec), null, '', { ...status, filter: undefined });
        if (this.pagedHeld && this.pagedHeld.key === key && this.pagedHeld.host === host) return this.pagedHeld.result;
        let held: (PagedResult & { figures?: FullFigures }) | undefined;
        // How large it is, said before it starts (and refused in words past what a browser tab can hold)
        const size = compareSize(spec, id => this.rowCount(id));
        if (size.bytes > TAB_BYTES) {
            throw new Error(`Too large to compare here: ${size.views} views, ${size.records.toLocaleString('en-US')} records, about ${(size.bytes / 1e9).toFixed(1)} GB. A browser tab holds about ${(TAB_BYTES / 1e9).toFixed(0)} GB. Compare fewer records, or fewer columns.`);
        }
        if (size.seconds >= 3) {
            this.post({ type: 'query.reading', stage: 'Comparing the records', done: 0, total: 0, note: `A large compare: ${size.views} views, ${size.records.toLocaleString('en-US')} records. About ${size.seconds} seconds.` });
        }
        try {
            // The whole compare (Join and Columns had a sample): its rows, and with them the true figures
            if (this.pagedRunning) host.cancel(this.pagedRunning);
            held = await runHeld(host, spec, status, p => { this.pagedRunning = p.result; onStage?.(p); });
        } finally {
            this.pagedRunning = undefined;
        }
        if (held?.figures) {
            this.tellFigures(spec, held.figures);
            // (Distinct's count, once the first page is sent: counted from the held rows, told when known)
            if (held.figures.duplicates === undefined) this.alikeNext = () => void this.alikeLater(spec, host, held!);
        }
        if (held) this.holdPaged({ key, result: held, host });
        return held;
    }

    /** Results' rows in the engine for this query and sort (run again only when either changes). */
    private async pagedFor(spec: QuerySpec, sort: ShownSort | null, onStage?: (p: Progress) => void, search = '', status?: PagedStatus): Promise<PagedResult | undefined> {
        const key = resultsKey(engineKey(spec), sort, search, status);
        const host = await this.engineFor(spec);
        this.lap('the engine ready');
        if (this.paged && this.paged.key === key && this.paged.host === host) return this.paged.result;
        this.retirePaged(host);
        this.paged = undefined;
        await this.loadEngineLookups(host, lookupsUsed(spec));
        let result: PagedResult | undefined;
        try {
            // (a newer search or sort stops Results' run still going: its own, never the step's count)
            // (a compare: from its held rows, or the held rows themselves when nothing is sorted, searched or filtered)
            const held = status ? await this.heldFor(spec, host, status, onStage) : undefined;
            this.lap('the compare held');
            if (status && !held) return undefined;
            if (held && !sort && !search && !status?.filter) result = held;
            else {
                if (this.pagedRunning) host.cancel(this.pagedRunning);
                result = await runPaged(host, spec, sort, p => { this.pagedRunning = p.result; onStage?.(p); }, search ? this.searchArg(resultColumnRefs(spec), search) : undefined, status, held?.id);
            }
        } finally {
            this.pagedRunning = undefined;
        }
        if (result) this.paged = { key, result, host };
        // (the rows before any search or status filter: what "n of m" counts against)
        if (result && !search && !status?.filter) this.pagedAll = { key: engineKey(spec), total: result.total };
        return result;
    }

    /**
     * Results' rows as the table, its totals, export and Chain read them: kept in the engine and
     * read a page at a time (pagedOn), or held here after the search and the sort (found).
     */
    private async shownRows(message: Pick<RowsRequest, 'search' | 'sort' | 'filter'>): Promise<ShownRows | undefined | null> {
        const { spec } = this.spec();
        const search = String(message.search ?? '').trim();
        const status = spec.views.length ? this.pagedStatus(spec, message.filter ?? undefined) : undefined;
        if (spec.views.length && this.pagedOn(spec, search)) {
            const columns = resultColumnRefs(spec);
            const sort = message.sort && Number.isInteger(message.sort.column) && message.sort.column >= 0 && message.sort.column < columns.length ? { column: message.sort.column, dir: message.sort.dir === 'desc' ? 'desc' as const : 'asc' as const } : null;
            await this.remember(search, sort);
            // (the step's count still going: waited for, never run twice at once)
            await this.engineLoading;
            this.lap('waited for the views');
            await this.counting;
            this.lap('waited for the step\'s count');
            // What Results is working on, said on it as it goes (stage, rows done of rows to do)
            const reading = (p: Progress) => this.post({ type: 'query.reading', stage: p.stage, done: p.done, total: p.total });
            // (the rows before the search and the filter: counted once, when not known yet)
            if ((search || status?.filter) && this.pagedAll?.key !== engineKey(spec)) await this.pagedFor(spec, null, reading);
            const paged = await this.pagedFor(spec, sort, reading, search, status);
            this.lap('Results\' rows in the engine');
            const host = this.engine;
            if (!paged || !host) return null;
            const total = search || status?.filter ? this.pagedAll?.total ?? paged.total : paged.total;
            // The Status menu's counts: among the rows the search finds, and among them all (asked for with the first page only)
            const counts = status && paged.layout.status ? async () => {
                const held = this.pagedHeld?.host === host ? this.pagedHeld.result.id : undefined;
                // (they change with the search, not with the sort or the Status filter: counted once for each)
                const counted = async (text: string): Promise<StatusCounts | undefined> => {
                    const key = held ? `${held}\n${text}` : '';
                    const had = key ? this.countsKept.get(key) : undefined;
                    if (had) return had;
                    // (the rows the search found are Results' rows when no Status filter is on: counted from them, not searched again)
                    const out = text && !status.filter && text === search
                        ? await pagedCounts(host, spec, undefined, status, paged.id)
                        : await pagedCounts(host, spec, text ? this.searchArg(columns, text) : undefined, status, held);
                    if (key && out) {
                        if (this.countsKept.size > 20) this.countsKept.clear();
                        this.countsKept.set(key, out);
                    }
                    return out;
                };
                const found = await counted(search);
                const every = search ? await counted('') : found;
                // (what the whole compare found, for the Hub list's line: kept when it changes)
                if (every && !status.filter?.hidden?.length) await this.rememberFound(every);
                // (differences only in spaces or blanks, across the whole compare: Results shows the special characters then)
                const made = await Promise.resolve(host.stats(paged.id, 'compare')).catch(() => undefined) as CompareStats | undefined;
                return found && every ? { counts: found, countsAll: every, ...(made?.quiet ? { quiet: made.quiet } : {}) } : undefined;
            } : undefined;
            return {
                columns: paged.layout.columns, key: engineKey(spec), total, shown: paged.total,
                page: async (offset, limit) => (status && paged.layout.status ? await readStatusPage(host, paged, offset, limit, status) : { rows: await readPage(host, paged, offset, limit) }),
                ...(counts ? { counts } : {}),
                each: each => eachPage(host, paged, each),
                ...(host.workbook && paged.layout.keyColumnOf.every(k => k === undefined)
                    ? { workbook: (keep: number[], header: string[], about: [string, string][]) => host.workbook!(paged.id, keep, header, about, paged.layout.status) } : {}),
                totals: () => pagedTotals(host, paged)
            };
        }
        const found = await this.found(message);
        if (!found) return found;
        const { result, indices, statuses } = found;
        return {
            columns: result.columns, key: result.key, total: result.rows.length, shown: indices.length,
            page: async (offset, limit) => ({
                rows: indices.slice(offset, offset + limit).map(i => result.rows[i]),
                ...(statuses ? { status: indices.slice(offset, offset + limit).map(i => statuses[i]), index: indices.slice(offset, offset + limit) } : {})
            }),
            ...(statuses ? { counts: async () => ({ counts: statusCounts(statuses, found.searched ?? indices), countsAll: statusCounts(statuses, statuses.map((_, i) => i)) }) } : {}),
            each: async each => { for (let at = 0; at < indices.length; at += 20_000) await each(indices.slice(at, at + 20_000).map(i => result.rows[i]), at); },
            totals: async () => this.totals(result, indices)
        };
    }

    /**
     * Results' rows after the search and the sort, as row numbers. Undefined: the query cannot
     * run yet. Null: a newer search took over.
     */
    private async found(message: Pick<RowsRequest, 'search' | 'sort' | 'filter'>): Promise<{ result: QueryResult; indices: number[]; searched?: number[]; statuses?: RowStatus[] } | undefined | null> {
        const { spec } = this.spec();
        if (!spec.views.length) return undefined;
        let result: QueryResult;
        try {
            if (this.onEngine(spec)) {
                const ran = await this.engineRead(spec, engineKey(spec));
                if (!ran) return undefined;
                result = ran;
            } else {
                const session = this.session;
                if (!session) return undefined;
                await this.loadLookups(session, spec);
                result = this.read(session, spec);
            }
        } catch (error) {
            // The user's own SQL no longer runs (the page says why): no rows. The steps' SQL failing is an error
            if (this.query?.sql) return undefined;
            throw error;
        }
        const search = String(message.search ?? '').trim();
        const sort = message.sort && Number.isInteger(message.sort.column) && message.sort.column < result.columns.length ? message.sort : null;
        await this.remember(search, sort);
        // Compare's filters: Status ticks, a compared column's DIFF pill, relations; a hidden result left out of every status
        const filter: StatusFilter = result.statusOf ? (message.filter ?? {}) : {};
        const statuses = result.statusOf ? result.statusOf(filter.hidden ?? []) : undefined;
        const key = JSON.stringify([search, sort, filter]);
        if (!this.filtered || this.filtered.key !== key) {
            const seq = ++this.searchSeq;
            let indices = result.rows.map((_, i) => i);
            if (search) {
                const kept = await this.search(result, search, seq);
                if (!kept) return null;
                indices = kept;
            }
            if (sort) {
                const dir = sort.dir === 'desc' ? -1 : 1;
                const c = sort.column;
                indices.sort((a, b) => dir * compareValues(result.rows[a][c], result.rows[b][c]) || a - b);
            }
            // (the rows the search finds, before Compare's filters: what their counts say)
            const searched = indices;
            if (statuses) indices = indices.filter(i => passes(statuses[i], filter));
            this.filtered = { key, indices, searched };
        }
        const kept = this.filtered!;
        return { result, indices: kept.indices, searched: kept.searched, statuses };
    }

    /**
     * The record window (Compare's): one row of Results, every column of each view of the compare
     * for its key, side by side, and where they differ.
     */
    private async record(index: number, hidden: string[]): Promise<void> {
        const RECORD_ROWS = 200;
        const { spec } = this.spec();
        const onEngine = this.onEngine(spec);
        // On Results' pages: the row read from the engine by its place, its keys with it, its status as the page had it
        const paged = onEngine && this.paged && isCompare(spec.joins) && this.engine ? this.paged.result : undefined;
        const pagedRow = paged ? await readPagedRow(this.engine!, paged, index) : undefined;
        const label = this.placeLabel(spec);
        const pagedStatusRow = pagedRow && paged?.layout.status ? (await readStatusPage(this.engine!, paged, index, 1, this.pagedStatus(spec, { hidden })!)).status[0] : undefined;
        const result: QueryResult | undefined = pagedRow && paged
            ? {
                key: '', columns: paged.layout.columns, rows: Object.assign([], { [index]: pagedRow.row }), keyViews: paged.layout.places,
                keyPlaces: paged.layout.places.map(label), keyValues: Object.assign([], { [index]: pagedRow.keys }),
                ...(pagedStatusRow ? { statusOf: () => Object.assign([] as RowStatus[], { [index]: pagedStatusRow }) } : {})
            }
            : this.result;
        const session = this.session;
        if (!result || (!session && !onEngine) || !result.keyViews || !result.keyValues || !Number.isInteger(index) || !result.rows[index]) return;
        const engineKeys = onEngine ? compareKeyExprs(spec) : [];
        // (on Results' pages: each view's records found by its whole key, every part of it)
        const partKeys = onEngine && pagedRow ? compareKeyPartExprs(spec) : [];
        const tables = tableNames(spec.views);
        const keys = compareKeySql(spec);
        const places: string[] = [];
        const placeViews: string[] = [];
        const records: Record<string, unknown>[][] = [];
        for (const [p, viewId] of result.keyViews.entries()) {
            const place = result.keyPlaces![p];
            if (hidden.includes(place)) continue;
            places.push(place);
            placeViews.push(viewId);
            const value = result.keyValues![index][p];
            const view = spec.views.find(v => v.id === viewId);
            if (value === null || value === undefined || !view) { records.push([]); continue; }
            if (onEngine) {
                // On the new engine: every one of the view's rows whose key is the row's (old Compare showed them all; a
                // key held more than RECORD_ROWS times shows that many, and says so)
                const parts = pagedRow?.parts[p];
                const whole = partKeys.find(k => k.view === viewId);
                const key = engineKeys.find(k => k.view === viewId);
                const out = whole && parts && parts.length === whole.exprs.length ? await this.engineWindow(spec, recordQuery(viewId, whole.exprs, parts), RECORD_ROWS)
                    : key ? await this.engineWindow(spec, recordQuery(viewId, key.expr, value as string | number), RECORD_ROWS) : { columns: [], rows: [] };
                records.push(out.rows.map(r => Object.fromEntries(out.columns.map((c, i) => [c, r[i]]))));
                continue;
            }
            if (!session) { records.push([]); continue; }
            const out = session.run(`SELECT * FROM ${quoteName(tables.get(viewId) ?? '')} AS ${quoteName(refNames(spec.views).get(viewId) ?? '')} WHERE ${keys[p].sql} = ${typeof value === 'number' ? value : `'${String(value).replace(/'/g, "''")}'`} LIMIT ${RECORD_ROWS}`);
            records.push(out.rows.map(r => Object.fromEntries(out.columns.map((c, i) => [c, r[i]]))));
        }
        const names = [...new Set(records.flatMap(rs => rs.flatMap(r => Object.keys(r))))];
        const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
        // Each field: its values by place; `absent` where the place's records have no such column (not in that view: told
        // apart from null and from blank, #21); `compared` when it is one of the compare's compared columns (marked by
        // default, #5); `differs` by its values' text where it is present
        const comparedNames = new Set(spec.select.filter(c => c.group && !c.fns?.length).map(c => c.column));
        const fields = names.map(name => {
            const values = records.map(rs => rs.map(r => (name in r ? r[name] : null)));
            const absent = records.map(rs => rs.length > 0 && rs.every(r => !(name in r)));
            const held = values.filter((v, i) => v.length && !absent[i]).map(v => JSON.stringify(v.map(x => (x === null || x === undefined ? null : text(x)))));
            return { name, values, absent, compared: comparedNames.has(name), differs: new Set(held).size > 1 };
        });
        const more = records.some(rs => rs.length >= RECORD_ROWS);
        const status = result.statusOf ? result.statusOf(hidden)[index] : undefined;
        // Its title: the whole key, every part (the first place that has the record)
        const keyText = pagedRow?.parts.find(ps => ps.length && ps.every(v => v !== null && v !== undefined))?.map(v => text(v)).join(' · ');
        // Each place's heading: its run, its environment, its header values, when it ran (#19)
        const heads = placeViews.map(id => {
            const source = this.query?.sources.find(x => x.id === id);
            return source ? { environment: source.file ? '' : source.environment, executedAt: source.executedAt, file: source.file?.name ?? '', execution: source.executionId } : {};
        });
        this.post({ type: 'query.recordDetail', index, places, placeViews, heads, fields, status, ...(keyText ? { keyText } : {}), ...(more ? { more: RECORD_ROWS } : {}) });
    }

    /** The places Results' Status names (each view of the compare, each place a compared column has), or null when nothing is compared. */
    private statusPlaces(): string[] | null {
        const query = this.query;
        if (!query || query.sql) return null;
        const { spec } = this.spec();
        if (!spec.views.length) return null;
        const label = (viewId: string): string => runName(query, viewId) || spec.views.find(v => v.id === viewId)?.name || viewId;
        const status = rowStatus(resultColumnRefs(spec), [], compareKeySql(spec).map(k => label(k.view)), [], label, [], compareSides(spec, label));
        return status ? status.places : null;
    }

    /**
     * Every row of Results, read once: the steps' SQL, or the user's own. With compared columns,
     * each row's status too (rowStatus): which views' values differ, and which views of the compare
     * have no record.
     */
    private read(session: QuerySession, spec: QuerySpec): QueryResult {
        const own = this.query?.sql;
        const key = own ?? session.sql();
        if (!this.result || this.result.key !== key) {
            const tooMany = own ? undefined : session.tooManyRows();
            if (tooMany) throw new Error(tooManyRowsText(tooMany, spec));
            if (own) {
                const out = session.run(own);
                this.result = { key, columns: out.columns.map(column => ({ view: CALC_VIEW, column })), rows: out.rows };
            } else {
                const columns = resultColumnRefs(spec);
                const keys = compareKeySql(spec);
                const out = session.rows(keys.length ? { extra: keys.map(k => k.sql) } : undefined);
                const rows = keys.length ? out.rows.map(r => r.slice(0, columns.length)) : out.rows;
                const keyValues = keys.length ? out.rows.map(r => r.slice(columns.length)) : [];
                this.result = this.compareResult(key, spec, columns, rows, keyValues, keys.map(k => k.view));
            }
            this.filtered = undefined;
        }
        return this.result;
    }

    /** Results from its rows (and a compare's keys in each place): each row's status worked out once, again for each set of results hidden. */
    private compareResult(key: string, spec: QuerySpec, columns: ColumnRef[], rows: unknown[][], keyValues: unknown[][], keyViews: string[]): QueryResult {
        const label = (viewId: string): string => runName(this.query!, viewId) || spec.views.find(v => v.id === viewId)?.name || viewId;
        const keyPlaces = keyViews.map(label);
        const sides = compareSides(spec, label);
        const first = rowStatus(columns, rows, keyPlaces, keyValues, label, [], sides);
        const cache = new Map<string, RowStatus[]>();
        return {
            key, columns, rows,
            ...(first ? {
                places: first.places, keyPlaces, keyValues, keyViews,
                statusOf: (hidden: string[]) => {
                    const at = hidden.slice().sort().join('\n');
                    if (!at) return first.rows;
                    if (!cache.has(at)) cache.set(at, rowStatus(columns, rows, keyPlaces, keyValues, label, hidden, sides)!.rows);
                    return cache.get(at)!;
                }
            } : {})
        };
    }

    /**
     * Is this query run on the new engine? "New compare engine (testing)" on, and the query one the
     * engine takes (query-new-engine.ts whyNotQueryOnEngine: not SQL of its own or a calculation
     * written as SQL). With the setting on and the query on SQLite, the Join step says why.
     */
    private onEngine(spec: QuerySpec): boolean {
        const on = !!this.ports.newCompareEngine?.();
        // Every query, but one with SQL of its own or a calculated column written as SQL
        const why = on ? (this.query?.sql ? 'it has SQL of its own' : whyNotQueryOnEngine(spec)) : undefined;
        // (a join still to make is not said: the step shows it)
        this.engineNote = on && why && why !== 'a join has no key yet' ? onSqliteLine(why) : '';
        this.engineOn = on && !why;
        return this.engineOn;
    }

    /** The engine with this spec's views loaded (loaded again only when the views change). */
    /** One load at a time: a second call waits for the first, then finds its views in. */
    private engineLoading: Promise<unknown> = Promise.resolve();
    /** The step's run on the engine still going: Results waits for it, never runs beside it. */
    private counting: Promise<unknown> = Promise.resolve();

    private engineFor(spec: QuerySpec): Promise<EngineHost> {
        const next = this.engineLoading.then(() => this.engineLoad(spec));
        this.engineLoading = next.catch(() => undefined);
        return next;
    }

    private async engineLoad(spec: QuerySpec): Promise<EngineHost> {
        const key = JSON.stringify(spec.views.map(v => [v.id, v.columns, this.rowCount(v.id)]));
        if (this.engine && this.engine.alive() && this.engineKey === key) return this.engine;
        // (the engine there is, or a new one when it stopped working: then every view goes in again)
        const engine = this.engineHostNow();
        // Only the views not in it yet, or changed: a view read on the new engine went in as it was read (feedEngine)
        for (const view of spec.views) {
            const entry = JSON.stringify([view.id, view.columns, this.rowCount(view.id)]);
            if (this.streamed.get(view.id) === entry) continue;
            await loadViewInto(engine, view.id, view.columns, await this.rowsOf(view.id));
            this.streamed.set(view.id, entry);
            // (the engine has them now: let go here)
            this.dropRows(view.id);
        }
        this.engineKey = key;
        return engine;
    }

    /** A query's run on the new engine, its rows kept there for Results' pages (with the figures and the rows alike); undefined when stopped. */
    private async engineKept(spec: QuerySpec, onStage?: (stage: string) => void, wanted: () => boolean = () => true): Promise<PagedResult | undefined> {
        const columns = resultColumnRefs(spec);
        const remembered = this.query?.sort;
        const keptSort = remembered && Number.isInteger(remembered.column) && remembered.column >= 0 && remembered.column < columns.length ? { column: remembered.column, dir: remembered.dir === 'desc' ? 'desc' as const : 'asc' as const } : null;
        const keptStatus = this.pagedStatus(spec, undefined);
        const started = performance.now();
        let at = started;
        const laps: string[] = [];
        const lap = (what: string) => { const t = performance.now(); laps.push(`${what} ${Math.round(t - at)}`); at = t; };
        const host = await this.engineFor(spec);
        await this.loadEngineLookups(host, lookupsUsed(spec));
        lap('views into the engine');
        if (!wanted()) return undefined;
        let run;
        try {
            // Kept as Results first asks for them (its remembered sort, a compare's status, nothing hidden or filtered): one run for both
            // (a compare: its rows for the step's figures and first rows only; Results holds it when it is opened, runHeld)
            // (a compare: on a sample, the Baseline's first rows and their keys in the others: Results works out the whole, heldFor)
            const going = runOnEngine(host, spec, p => { this.engineRunning = p.result; onStage?.(p.stage); }, { keep: true, sort: keptStatus ? null : keptSort, status: keptStatus, ...(keptStatus ? { sample: SAMPLE_ROWS } : {}) });
            this.counting = going.catch(() => undefined);
            run = await going;
        } finally {
            this.engineRunning = undefined;
        }
        if (!run?.kept) return undefined;
        at = performance.now();
        laps.push(...run.timings.map(([what, ms]) => `${what} ${ms}`));
        this.engineStats = run.stats;
        this.engineDuplicates = run.duplicates;
        this.engineNotNumbers = run.notNumbers;
        this.engineSampleFacts = run.sample;
        // (Results has worked out this compare already: its true figures, and for these columns its rows alike and numbers counted)
        const full = run.sample && this.fullFigures?.compare === this.compareKeyOf(spec) ? this.fullFigures : undefined;
        if (full) {
            this.engineStats = full.stats;
            this.engineSampleFacts = undefined;
            if (full.spec === engineKey(spec)) { this.engineDuplicates = full.duplicates ?? 0; this.engineNotNumbers = full.notNumbers; }
        }
        if (!keptStatus) {
            this.retirePaged(host);
            this.paged = { key: resultsKey(engineKey(spec), keptSort, '', keptStatus), result: run.kept, host };
            this.pagedAll = { key: engineKey(spec), total: run.kept.total };
        } else {
            // A compare's sample: its rows for the step only (the first rows, the sample record); its compare kept for the sample record and a calculation's first rows
            const before = this.pagedBase;
            this.pagedBase = { key: `sample\n${engineKey(spec)}`, result: run.kept, host };
            const was = this.engineCompare;
            this.engineCompare = run.compare ? { ...run.compare, host, views: this.engineKey } : undefined;
            if (was && was.host.alive() && was.id !== run.compare?.id) void was.host.release(was.id).catch(() => undefined);
            if (before && before.host.alive() && before.result.id !== run.kept.id) void before.host.release(before.result.id).catch(() => undefined);
        }
        console.log(`[query-engine] ${run.total} rows of ${spec.views.length} views, kept in the engine, in ${Math.round(performance.now() - started)} ms: ${laps.join(' · ')} (ms)`);
        return run.kept;
    }

    /** Results from the new engine (run again only when the query changes): undefined when Stop stopped it. */
    private async engineRead(spec: QuerySpec, key: string, onStage?: (stage: string) => void, wanted: () => boolean = () => true): Promise<QueryResult | undefined> {
        if (this.result?.key === key) return this.result;
        // Stage timings (the setting is for testing): each part, in ms, in the console as "[query-engine] …"
        const started = performance.now();
        let at = started;
        const laps: string[] = [];
        const lap = (what: string) => { const t = performance.now(); laps.push(`${what} ${Math.round(t - at)}`); at = t; };
        const engine = await this.engineFor(spec);
        await this.loadEngineLookups(engine, lookupsUsed(spec));
        lap('views into the engine');
        if (!wanted()) return undefined;
        let run;
        try {
            run = await runOnEngine(engine, spec, p => { this.engineRunning = p.result; onStage?.(p.stage); });
        } finally {
            this.engineRunning = undefined;
        }
        if (!run) return undefined;
        at = performance.now();
        laps.push(...run.timings.map(([what, ms]) => `${what} ${ms}`));
        this.engineStats = run.stats;
        this.engineDuplicates = run.duplicates;
        this.engineNotNumbers = run.notNumbers;
        this.result = this.compareResult(key, spec, run.layout.columns, run.rows, run.keyValues, run.layout.places);
        lap('row status');
        this.filtered = undefined;
        console.log(`[query-engine] ${run.total} rows of ${spec.views.length} views in ${Math.round(performance.now() - started)} ms: ${laps.join(' · ')} (ms)`);
        return this.result;
    }

    /**
     * A column's total over these rows when every value it has is a number; null otherwise. With
     * it, how many decimals to show: as many as the column's values have, two at most (prices
     * read 16,716,135.90, counts read whole).
     */
    private totals(result: { columns: ColumnRef[]; rows: unknown[][] }, indices: number[]): { totals: (number | null)[]; places: number[] } {
        const places: number[] = [];
        const totals = result.columns.map((_, c) => {
            let sum = 0;
            let any = false;
            let decimals = 0;
            for (const i of indices) {
                const v = result.rows[i][c];
                if (v === null || v === undefined || v === '') continue;
                if (typeof v !== 'number') { places[c] = 0; return null; }
                sum += v;
                any = true;
                if (decimals < 2 && !Number.isInteger(v)) decimals = Math.max(decimals, Math.min(2, (String(v).split('.')[1] ?? '').length || 2));
            }
            places[c] = decimals;
            const unit = 10 ** decimals;
            return any ? Math.round(sum * unit) / unit : null;
        });
        return { totals, places };
    }

    /** The rows the search keeps, read a few thousand at a time; a newer search stops this one. */
    private async search(result: { columns: ColumnRef[]; rows: unknown[][] }, search: string, seq: number): Promise<number[] | null> {
        // A column answers to its name (@sku: any view's) and to its view's name with it (@stock.sku: that view's): query-search.ts
        const test = searchTest(this.searchArg(result.columns, search));
        const out: number[] = [];
        for (let start = 0; start < result.rows.length; start += SEARCH_CHUNK) {
            if (start) await new Promise(resolve => setTimeout(resolve, 0));
            if (seq !== this.searchSeq || this.closed) return null;
            const end = Math.min(result.rows.length, start + SEARCH_CHUNK);
            for (let i = start; i < end; i++) if (test(result.rows[i])) out.push(i);
        }
        return out;
    }

    /** What the search reads: the text, and Results' columns by the names it knows them by (a view by its alias: BL, C1…, or its name). */
    private searchArg(columns: ColumnRef[], search: string): SearchArg {
        const query = this.query;
        return { search, cols: searchColumns(columns, new Map(query?.sources.map(s => [s.id, runName(query, s.id) || s.name]) ?? [])) };
    }
}

/** A file's content from the page: text for CSV-like files, base64 for a workbook. */
interface FileMessage {
    name: string;
    text?: string;
    base64?: string;
}

/** Where the user's Results choices are kept, and which they are: Side by side or Compact (#18). */
const QUERY_PREFERENCES = 'queryPreferences';
const QUERY_PREFERENCE_KEYS = ['resultsView', 'specialCharacters'];

interface RowsRequest {
    seq: number;
    offset: number;
    limit: number;
    search?: string;
    /** Results' filters, as Compare's (query-status.ts): Status ticks, compared columns, relations, hidden results. */
    filter?: StatusFilter;
    sort?: { column: number; dir: 'asc' | 'desc' } | null;
    /** Send the columns' totals with the first window. */
    totals?: boolean;
    /** Export: the Status menu's counts as Results shows them, and whether Only diffs is on (the file's summary). */
    counts?: StatusCounts | null;
    diffsOnly?: boolean;
}

/** Results' headings: a column's name, with its view's letter when the name is in more than one view (sku (D)). */
export function columnHeadings(columns: ColumnRef[], letters: Map<string, string>): string[] {
    const count = new Map<string, number>();
    columns.forEach(c => count.set(c.column, (count.get(c.column) ?? 0) + 1));
    return columns.map(c => ((count.get(c.column) ?? 0) > 1 && letters.get(c.view) ? `${c.column} (${letters.get(c.view)})` : c.column));
}

/** The first value a column has, for the pickers. */
function sample(rows: QueryRowData[], column: string): string {
    for (let i = 0; i < rows.length && i < 200; i++) {
        const v = rows[i][column];
        if (v !== null && v !== undefined && v !== '') return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60);
    }
    return '';
}

/** Numbers by size, text by its letters (numbers inside it by size), blanks last. */
function compareValues(a: unknown, b: unknown): number {
    const blankA = a === null || a === undefined || a === '';
    const blankB = b === null || b === undefined || b === '';
    if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Why a query was not run: the join, how many rows it would make, and what to do. */
export function tooManyRowsText(tooMany: TooManyRows, spec: QuerySpec): string {
    const join = spec.joins[tooMany.join];
    const view = spec.views.find(v => v.id === join?.view)?.name ?? `join ${tooMany.join + 1}`;
    return `Joining ${view} would make ${tooMany.rows.toLocaleString('en')} rows, more than a query can hold (${tooMany.limit.toLocaleString('en')}), so it was not run. Join on a column that repeats less, or add another column to the join.`;
}

/**
 * What the Status tags call each side of a COMPARE calculation ("price 1", "price 2"): the
 * column it reads when the sides read different columns (quantityOnHand, quantityAvailable),
 * else the view or run it comes from (BL, C1); a side that is a calculation keeps its number.
 */
function compareSides(spec: QuerySpec, label: (view: string) => string): (column: string) => string | undefined {
    const names = new Map<string, string>();
    for (const calc of spec.calc ?? []) {
        if (!calc.formula) continue;
        let sides: FormulaNode[] | undefined;
        try { sides = parseFormula(calc.formula, formulaColumns(spec)).compare; } catch { continue; }
        if (!sides) continue;
        const refs = sides.map(n => (n.k === 'ref' ? { view: n.key.slice(0, n.key.indexOf('\n')), column: n.key.slice(n.key.indexOf('\n') + 1) } : undefined));
        const columnsDiffer = new Set(refs.map(r => r?.column ?? '')).size === refs.length;
        refs.forEach((r, i) => { if (r) names.set(`${calc.name} ${i + 1}`, columnsDiffer ? r.column : label(r.view)); });
    }
    return column => names.get(column);
}

/** Each run's first run, by id: what keeps a run's key its first run's. */
function runsOf(query: SavedQuery): Map<string, string> {
    return new Map(query.sources.filter(s => s.runOf).map(s => [s.id, s.runOf as string]));
}

/** Results' rows as their readers see them, wherever the rows are (shownRows). */
interface ShownRows {
    columns: ColumnRef[];
    /** What ran: the SQL, or "engine:" and the query. */
    key: string;
    total: number;
    shown: number;
    page(offset: number, limit: number): Promise<{ rows: unknown[][]; status?: RowStatus[]; index?: number[] }>;
    counts?: () => Promise<{ counts: ReturnType<typeof statusCounts>; countsAll: ReturnType<typeof statusCounts>; quiet?: number } | undefined>;
    each(each: (rows: unknown[][], offset: number) => void | Promise<void>): Promise<void>;
    totals(): Promise<{ totals: (number | null)[]; places: number[] }>;
    /** Where the engine can make it (the web app's worker): the export's workbook, made from the rows where they are. */
    workbook?(keep: number[], header: string[], about: [string, string][]): Promise<Uint8Array>;
}

interface QueryResult {
    key: string;
    columns: ColumnRef[];
    rows: unknown[][];
    places?: string[];
    /** A compare's views (their places, ids, and each row's key in each). */
    keyPlaces?: string[];
    keyViews?: string[];
    keyValues?: unknown[][];
    /** Each row's status, with the results hidden on Results left out. */
    statusOf?: (hidden: string[]) => RowStatus[];
}

/** Results' key on the new engine: the query as the engine sees it. */
function engineKey(spec: QuerySpec): string {
    return `engine:${JSON.stringify(spec)}`;
}
