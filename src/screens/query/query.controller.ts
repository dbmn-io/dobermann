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
import { allColumns, columnSql, compareKeySql, defaultColumns, formulaColumns, fromSql, joinKeyColumns, lookupsUsed, quoteName, refNames, resultColumns as resultColumnRefs, tableNames, writeSql } from '../../services/query/query-sql';
import { FORMULA_FUNCTIONS, formulaSql, fullRef, fullText, parseFormula, shortRef, shortText } from '../../services/query/formula';
import { reportNameProblem } from '../../services/compare/report-name';
import { cleanViewName, getQuery, guessViewName, shortViewName, VIEW_NAME_MAX, MAX_QUERY_VIEWS, moveView, moveViewFirst, nameViews, newSourceId, nextRunName, QuerySource, renameView, runName, saveQuery, SavedQuery, untickBlanks, untickClashes } from '../../services/query/query-store';
import { columnTypes, spread, TYPE_SAMPLE, type ColumnType } from '../../services/query/column-types';
import { CALC_VIEW, QUERY_JOIN_KINDS } from '../../services/query/query-types';
import { comparableRuns, type RequestTemplates, type RunHeaderValue } from '../../services/compare/compare-runs';
import { alignCompareJoins, groupCompare, MAX_COMPARE_VIEWS, queryCompare, runJoin } from '../../services/query/query-compare';
import { passes, rowStatus, statusCounts, type RowStatus, type StatusFilter } from '../../services/query/query-status';
import { lookupsIn } from '../../services/column-functions/column-functions';
import type { LookupTablesReader, LookupTableSummary } from '../../services/lookup-tables/lookup-tables';
import type { ColumnRef, QueryFn, QueryJoin, QueryJoinKind, QueryJoinStats, QueryKey, QuerySpec } from '../../services/query/query-types';
import { ConsoleExportService } from '../../services/console/export.service';
import type { ColumnDefinition } from '../../types/console-messages';
import { ConsoleChainHandler } from '../console/console-chain-handler';
import type { ChainHandoff } from '../../services/chain/chain-types';
import type { APIEndpointConfig } from '../../apiConfigManager';
import { readFileSheets, QueryFileRows, QueryFileSheet } from '../../services/query/query-file';
import type { QueryFileStore } from '../../services/query/query-file-store';
import * as searchMatcherScript from '../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../utils/shared-script';

const { parseSearchExpression, matchesRow } = sharedScript<typeof searchMatcherScript>(searchMatcherScript, 'SearchMatcher');

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
}

export interface QueryConfig {
    queryId: string;
    /** Where the tab opens: 'results' runs the query and shows only Results; anything else opens on Views. */
    start?: 'results' | 'match' | 'edit';
}

export type QueryMessage = { type: string; [key: string]: unknown };

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
    rows: QueryRowData[];
    rowBasis: string;
    error?: string;
}

/** A join pair as the page edits it: one column each side. */
interface PagePair {
    left: { view: string; column: string; fns?: QueryFn[] };
    right: { column: string; fns?: QueryFn[] };
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

    constructor(private readonly session_: ScreenSession, private readonly ports: QueryPorts, private readonly config: QueryConfig) {
        // A lookup table edited or deleted (in Reporting): a query that reads it runs again
        this.stopLookups = ports.lookups?.onChange(change => {
            void this.ports.lookups?.list().then(list => { this.lookupList = list; });
            const { spec } = this.query ? this.spec() : { spec: undefined };
            if (!spec || !lookupsUsed(spec).includes(change.id)) return;
            this.lookupsLoaded.delete(change.id);
            this.result = undefined;
            void this.refresh();
        });
        this.views = new ConsoleViewsStore({ state: ports.state, endpoints: ports.endpoints, log: m => ports.logger?.log(m) });
        this.extractor = new ResponseDataExtractor({ executionMetadataService: ports.metadata });
        this.chain = new ConsoleChainHandler({
            getTabRowsForChain: async () => {
                const found = await this.found(this.shown);
                if (!found || !this.query) return null;
                const headings = columnHeadings(found.result.columns, new Map(this.query.sources.map(s => [s.id, s.name])));
                return {
                    data: found.indices.map(i => Object.fromEntries(found.result.rows[i].map((value, c) => [`c${c}`, value]))),
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
        this.stopLookups?.();
        this.session_.dismissAll();
        this.session?.close();
        this.session = undefined;
    }

    private post(message: Record<string, unknown>): void {
        if (!this.closed) this.session_.post(message);
    }

    async handleMessage(message: QueryMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'query.ready': return await this.open();
                // Its row in the Reporting list clicked again while the tab is open: Edit, or Run
                case 'query.start': return this.post({ type: 'query.goTo', start: message.start === 'results' ? 'results' : 'edit' });
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
                case 'query.moveFirst': return await this.change(q => { moveViewFirst(q, String(message.id)); });
                // Hidden, or shown again: the view and its joins stay in the query either way
                case 'query.toggleView': return await this.change(q => { const s = q.sources.find(x => x.id === String(message.id)); if (s) { if (s.off) delete s.off; else s.off = true; } });
                // Dragged to another place on Views or Join: its pairs go with it
                case 'query.moveView': return await this.change(q => { moveView(q, String(message.id), Number(message.to)); });
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
                case 'query.viewRows': return this.viewRows(String(message.id), String(message.search ?? ''), Number(message.seq));
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
                case 'query.openLookup': {
                    const id = String(message.id ?? '');
                    if (id && this.ports.openLookup) await this.ports.openLookup(id);
                    else if (id) this.ports.toast.info('Lookup tables open from Reporting.');
                    return;
                }
                case 'query.fnSample': return await this.fnSample(message as unknown as { view: string; column: string; fns?: QueryFn[]; seq: number });
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

    private async open(): Promise<void> {
        const query = getQuery(this.ports.state, this.config.queryId);
        if (!query) throw new Error('This query is no longer saved.');
        this.query = query;
        if (nameViews(query)) await saveQuery(this.ports.state, query);
        this.post({ type: 'query.init', name: query.name, empty: query.sources.length === 0, reached: query.reached ?? 4, start: this.config.start === 'results' ? 'results' : 'edit' });
        // The views show at once, by what is saved; their rows are read behind them
        this.postState({ reading: true });
        await this.refresh();
        await this.postSources();
    }

    /**
     * What Add a view picks from: every finished result, newest first, with what it is found by (its request,
     * its endpoint's name now, its System, where it ran) and the Views it can be read through. Views belong
     * to a method and path (ConsoleViewsStore), so results of the same request list the same Views.
     */
    private async postSources(): Promise<void> {
        const history = (await this.ports.metadata.getUnifiedExecutionHistory()).filter(isComparableRun);
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
        this.post({ type: 'query.sourceList', results, views });
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
            this.post({ type: 'query.progress', text: `Reading ${sources[i].name}`, done: i, total: sources.length });
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
                    q.joins.push(runJoin(q.joins, source.id, source.runOf));
                    alignCompareJoins(q.joins, runsOf(q));
                    return;
                }
                q.joins.push({ view: source.id, kind: 'left', on: [] });
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
        const path = endpoint?.path || run.endpointPath || '';
        const base = plain ? shortViewName(endpointName, path) : message.view;
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
        delete source.alias;
        await this.change(q => { q.sources.push(source); }, false);
        this.postState({ reading: true });
        await this.load(source);
        await this.change(q => {
            if (!q.sources.includes(source)) return;
            q.joins.push(runJoin(q.joins, source.id, head.id));
            alignCompareJoins(q.joins, runsOf(q));
        });
    }

    /**
     * A file as views: read now, in full, and its rows kept on this computer (query-file-store).
     * A CSV is one view; a workbook is one per sheet, each named for its sheet.
     */
    /** A workbook read and waiting for the user to say which of its sheets become views. */
    private pendingFile?: { name: string; sheets: QueryFileSheet[] };

    private async addFile(message: FileMessage): Promise<void> {
        const query = this.query;
        if (!query) return;
        if (query.sources.length >= MAX_QUERY_VIEWS) throw new Error(`A query takes up to ${MAX_QUERY_VIEWS} views.`);
        const fileName = String(message.name || 'File');
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
        await this.addSheets(pending.name, pending.sheets.filter(s => names.includes(s.sheet)), true);
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
                q.joins.push({ view: source.id, kind: 'left', on: [] });
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
    private viewRows(id: string, search: string, seq: number): void {
        const LIMIT = 500;
        const loaded = this.loaded.get(id);
        const columns = loaded?.columns ?? [];
        const words = search.toLowerCase().split(/\s+/).filter(Boolean);
        const text = (value: unknown): string => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        const all = loaded?.rows ?? [];
        const found = words.length
            ? all.filter(row => { const line = columns.map(c => text(row[c])).join('\n').toLowerCase(); return words.every(w => line.includes(w)); })
            : all;
        this.post({
            type: 'query.viewRowsData', seq, columns, total: all.length, found: found.length,
            rows: found.slice(0, LIMIT).map(row => columns.map(c => text(row[c])))
        });
    }

    /** A few of a column's values, as they are and as `fns` leave them: the function dialog's sample. */
    private async fnSample(message: { view: string; column: string; fns?: QueryFn[]; seq: number }): Promise<void> {
        const tables = tableNames(this.spec().spec.views);
        // Translate values being tried: its table loaded, its columns filled in
        message.fns = this.withLookupColumns(message.fns ?? []);
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
                rows = this.session.run(`SELECT DISTINCT ${plain}, ${columnSql({ ...ref, fns: message.fns ?? [] }, tables)} FROM ${quoteName(table)} WHERE ${plain} IS NOT NULL AND ${plain} <> '' LIMIT 6`).rows;
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

    /** Every column a formula can name: its key, its whole @ path, the shortest that is unique, and a value from it. */
    private formulaColumnsFor(): { key: string; full: string; short: string; path: string[]; view: string; sample: string }[] {
        const { spec } = this.spec();
        const columns = formulaColumns(spec);
        return columns.map(c => {
            const at = c.key.indexOf('\n');
            const view = c.key.slice(0, at);
            const loaded = this.loaded.get(view);
            const value = loaded?.rows.find(r => r[c.key.slice(at + 1)] !== null && r[c.key.slice(at + 1)] !== undefined && r[c.key.slice(at + 1)] !== '')?.[c.key.slice(at + 1)];
            return { key: c.key, full: fullRef(c), short: shortRef(c, columns), path: c.path, view, sample: value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) };
        });
    }

    /**
     * The calculation builder's check, as the user types: the formula read (formula.ts), its SQL,
     * and its value on the first few rows; or what is wrong, where, and the columns to pick from.
     */
    private calcCheck(formula: string, seq: number): void {
        const { spec } = this.spec();
        const columns = formulaColumns(spec);
        const names = refNames(spec.views);
        try {
            const parsed = parseFormula(formula, columns);
            const colSql = (key: string): string => { const at = key.indexOf('\n'); return columnSql({ view: key.slice(0, at), column: key.slice(at + 1) }, names); };
            const sides = parsed.compare ?? [parsed.tree];
            const sql = sides.map(side => formulaSql(side, colSql));
            const first = spec.views[0];
            const label = first ? columnSql({ view: first.id, column: first.columns[0] }, names) : "''";
            const rows = this.session && spec.views.length
                ? this.session.run(`SELECT ${label}, ${sql.join(', ')} ${fromSql(spec)} LIMIT 4`).rows
                : [];
            this.post({ type: 'query.calcCheck', seq, ok: true, sql: sql.join(',\n'), compare: !!parsed.compare, label: first ? first.columns[0] : '', rows, used: parsed.columns });
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
            if (!this.session) throw new Error('Add a view first.');
            try {
                this.session.run(`SELECT * FROM (${sql}) LIMIT 1`);
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

    private async change(apply: (query: SavedQuery) => void | Promise<void>, refresh = true): Promise<void> {
        const query = this.query;
        if (!query) return;
        await apply(query);
        query.updatedAt = new Date().toISOString();
        await saveQuery(this.ports.state, query);
        this.ports.host.compared?.();
        if (refresh) await this.refresh();
        else this.post({ type: 'query.named', name: query.name });
    }

    /** Read one view's rows from its run's saved responses, through its Console View. */
    private async load(source: QuerySource): Promise<void> {
        if (this.loaded.has(source.id)) return;
        if (source.file) {
            const kept = await this.ports.queryFiles?.read(this.query?.id ?? '', source.id);
            this.loaded.set(source.id, kept
                ? { ...kept, rowBasis: 'line' }
                : { columns: [], rows: [], rowBasis: 'line', error: 'Pick the file again: its rows are not on this computer.' });
            return;
        }
        try {
            await this.ports.preloadRun?.(source.executionId);
            const config = await buildConsoleReportConfig({
                executionId: source.executionId,
                isBatch: source.isBatch,
                executionMetadataService: this.ports.metadata,
                environments: this.ports.environments,
            });
            const responses = await this.extractor.extractResponses(config.responseFiles, config.responseFileStatusMap, config.responseFileDetails);
            const views = await this.successViews(source.endpointId);
            const saved = views.find(v => v.name === source.view);
            // A view that has gone is said, never swapped for other columns
            if (source.view && !saved) throw new Error(`The view "${source.view}" is no longer in the Console.`);
            const view = saved ?? rootView(responses);
            const side = buildCompareSide(responses, view);
            // Headed as the Console heads them; two columns sharing a header keep their paths
            const count = new Map<string, number>();
            side.columns.forEach(c => count.set(c.name, (count.get(c.name) ?? 0) + 1));
            const named = side.columns.map(c => ({ id: c.id, name: (count.get(c.name) ?? 0) > 1 ? c.id : c.name }));
            const rows = side.rows.map(row => {
                const out: QueryRowData = {};
                for (const c of named) out[c.name] = row[c.id];
                return out;
            });
            this.loaded.set(source.id, { columns: named.map(c => c.name), rows, rowBasis: view.rowBasis || 'root' });
        } catch (error) {
            this.loaded.set(source.id, { columns: [], rows: [], rowBasis: 'root', error: error instanceof Error ? error.message : String(error) });
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
        for (const source of query.sources) {
            const run = runName(query, source.id);
            const view = {
                id: source.id, name: source.name, columns: this.loaded.get(source.id)?.columns ?? [], empty: this.emptyColumns(source.id),
                ...(run ? { run, runOfName: query.sources.find(s => s.id === (source.runOf ?? source.id))?.name ?? source.name } : {})
            };
            // A view sits out on its own (hidden, unread, or not joined yet): the views after it that
            // join to the ones still in carry on, so a report can be looked at before every view is joined
            if (!usable(source) || source.off) { waiting.push(source.id); continue; }
            if (!views.length) { views.push(view); continue; }
            const join = query.joins.find(j => j.view === source.id);
            const complete = !!join && join.on.length > 0 && join.on.every(p => p.left.parts.every(has) && p.right.parts.every(c => view.columns.includes(c.column)));
            if (!complete) { waiting.push(source.id); continue; }
            views.push(view);
            joins.push(join!);
        }
        // A joining view's key is never shown beside the column it matches: it says the same twice
        const keys = new Set(joinKeyColumns({ views, joins, select: [] }).map(k => `${k.key.view}\n${k.key.column}`));
        const select = (query.select ?? []).filter(has).filter(c => !keys.has(`${c.view}\n${c.column}`));
        return { spec: { views, joins, select, distinct: query.distinct, calc: query.calc }, waiting };
    }

    /** Load what isn't loaded, run the query, and send the page everything the steps show. */
    private async refresh(): Promise<void> {
        const query = this.query;
        if (!query) return;
        const version = ++this.version;
        for (let i = 0; i < query.sources.length; i++) {
            if (this.loaded.has(query.sources[i].id)) continue;
            this.post({ type: 'query.progress', text: `Reading ${query.sources[i].name}`, done: i, total: query.sources.length });
            await this.load(query.sources[i]);
            if (version !== this.version || this.closed) return;
        }
        const tidied = untickClashes(query, id => this.loaded.get(id)?.columns ?? []);
        if (untickBlanks(query, id => this.emptyColumns(id)) || tidied) await saveQuery(this.ports.state, query);
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
        let duplicates = 0;
        if (spec.views.length) {
            try {
                const session = await this.sessionFor(spec, version);
                if (!session) return;
                // The report's columns (Columns' step); Results' own, a COMPARE calculation a column per side
                columns = spec.select.length ? spec.select : defaultColumns(spec);
                resultColumns = resultColumnRefs(spec);
                if (this.ports.lookups) this.lookupList = await this.ports.lookups.list();
                await this.loadLookups(session, spec);
                sql = session.sql();
                // A join that would make far too many rows is never made: it would fill the page's memory
                const tooMany = session.tooManyRows();
                if (tooMany) {
                    stats = spec.joins.map((_, i) => (i <= tooMany.join ? session.joinStats(i) : null));
                    throw new Error(tooManyRowsText(tooMany, spec));
                }
                total = session.count();
                // Rows alike in every column shown: what Distinct would fold (or has)
                const other = Number(session.run(`SELECT COUNT(*) FROM (${writeSql({ ...spec, distinct: !spec.distinct })})`).rows[0]?.[0] ?? 0);
                duplicates = Math.abs(other - total);
                stats = spec.joins.map((_, i) => session.joinStats(i));
                preview = session.rows({ limit: PREVIEW_ROWS }).rows;
                // (from rows across the whole result, so a column that changes further down is not mislabelled)
                resultTypes = columnTypes(session.sample(TYPE_SAMPLE).rows, resultColumns.length);
                sampleRow = this.sampleRow(session, spec);
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
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            }
        }
        if (query.rows !== total && !failure) {
            query.rows = total;
            await saveQuery(this.ports.state, query);
        }
        this.postState({ waiting, stats: new Map(spec.joins.map((j, i) => [j.view, stats[i]])), columns, resultColumns, resultTypes, sampleRow, duplicates, sql, total, preview, error: failure, sqlError });
    }

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
        if (!this.loaded.get(id)?.rows.length) return [];
        return [...this.filledRows(id)].filter(([, n]) => n === 0).map(([column]) => column);
    }

    /**
     * One row as the report will have it, every view's columns: the first where every join found
     * its match, so each view has a value to show (or the first row there is, when none does).
     */
    private sampleRow(session: QuerySession, spec: QuerySpec): { view: string; column: string; value: string }[] {
        const select = allColumns(spec).filter(c => c.view !== CALC_VIEW);
        const one = (inner: boolean): unknown[] | undefined => session.run(writeSql({
            views: spec.views, joins: inner ? spec.joins.map(j => ({ ...j, kind: 'inner' as const })) : spec.joins, select
        }, { limit: 1 })).rows[0];
        const row = one(true) ?? one(false);
        if (!row) return [];
        const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60);
        return select.map((c, i) => ({ view: c.view, column: c.column, value: text(row[i]) }));
    }

    /** Everything the steps show. `reading`: a view was just added and its rows are still being read. */
    private postState(now: { reading?: boolean; waiting?: string[]; stats?: Map<string, QueryJoinStats | null>; columns?: ColumnRef[]; resultColumns?: ColumnRef[]; resultTypes?: ColumnType[]; sampleRow?: { view: string; column: string; value: string }[]; duplicates?: number; sql?: string; total?: number; preview?: unknown[][]; error?: string; sqlError?: string }): void {
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
                    rows: loaded?.rows.length ?? 0, error: loaded?.error ?? '', reading: !loaded,
                    waiting: !!now.waiting?.includes(s.id), off: !!s.off,
                    // A run of a view (C1...), or BL for its first run; the first run's id
                    run: runName(query, s.id), runOf: s.runOf ?? '',
                    columns: (loaded?.columns ?? []).map(name => ({ name, sample: sample(loaded!.rows, name), filled: this.filledRows(s.id).get(name) ?? 0, empty: !!loaded!.rows.length && !this.filledRows(s.id).get(name) }))
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
            // A joining view's key, and the column it is matched to: not shown twice
            keyColumns: joinKeyColumns(this.spec().spec).map(k => ({ view: k.key.view, column: k.key.column, sameView: k.same.view, sameColumn: k.same.column })),
            allSelected: !(query.select?.length),
            distinct: !!query.distinct,
            duplicates: now.duplicates ?? 0,
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
            ownSql: query.sql ?? '', sqlError: now.sqlError ?? '',
            search: query.search ?? '', sort: query.sort ?? null, totals: !!query.totals,
            widths: query.widths ?? {},
            sql: now.sql ?? '', total: now.total ?? 0, preview: now.preview ?? [], error: now.error ?? ''
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
            const rows = this.loaded.get(view.id)?.rows ?? [];
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
        const found = await this.found(message);
        if (found === null) return;
        if (!found) {
            this.post({ type: 'query.rowsData', seq: message.seq, offset: 0, rows: [], shown: 0, total: 0 });
            return;
        }
        const { result, indices } = found;
        void result;
        const offset = Math.max(0, Math.floor(Number(message.offset) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(message.limit) || 200)));
        this.post({
            type: 'query.rowsData', seq: message.seq, offset,
            rows: indices.slice(offset, offset + limit).map(i => result.rows[i]),
            ...(found.statuses ? { status: indices.slice(offset, offset + limit).map(i => found.statuses![i]), index: indices.slice(offset, offset + limit) } : {}),
            // Every control's counts: among the rows the search finds, and among them all
            ...(found.statuses && offset === 0 ? { counts: statusCounts(found.statuses, found.searched ?? indices), countsAll: statusCounts(found.statuses, found.statuses.map((_, i) => i)) } : {}),
            shown: indices.length, total: result.rows.length,
            ...(message.totals && offset === 0 ? this.totals(result, indices) : {})
        });
    }

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
        if (result && held && this.session) {
            for (const row of result.rows) move(row);
            result.columns = columns;
            result.key = sql;
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
        const found = query ? await this.found(message) : undefined;
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
        const { result, indices } = found;
        const column = (id: string, heading: string): ColumnDefinition => ({ id, name: heading, type: 'string', sortable: false, filterable: false });
        const headings = columnHeadings(result.columns, new Map(query.sources.map(s => [s.id, s.name])));
        const columns = headings.map((h, i) => column(`c${i}`, h));
        const data = indices.map(i => Object.fromEntries(result.rows[i].map((value, c) => [`c${c}`, value])));
        const search = String(message.search ?? '').trim();
        const about: [string, string][] = [
            ['Query', query.name],
            ['Rows', search ? `${indices.length} of ${result.rows.length}` : String(result.rows.length)],
            ...(search ? [['Search', search] as [string, string]] : []),
            ...query.sources.map(s => [`View ${s.name}`, [s.endpointName, s.system, s.request, s.view, s.environment, s.executedAt].filter(Boolean).join(' · ')] as [string, string]),
            ...result.key.split('\n').map((line, i) => [i ? '' : 'SQL', line] as [string, string])
        ];
        const path = await new ConsoleExportService().exportToExcelMultiSheet([
            { sheetName: 'Results', data, columns },
            { sheetName: 'Query', data: about.map(([a, b]) => ({ a, b })), columns: [column('a', ''), column('b', '')] }
        ], { includeHeaders: true, targetUri: target });
        await files.exported?.(path);
        this.ports.toast.info(`Saved ${path.split(/[\\/]/).pop()}`);
        this.post({ type: 'query.exported' });
    }

    /**
     * Results' rows after the search and the sort, as row numbers. Undefined: the query cannot
     * run yet. Null: a newer search took over.
     */
    private async found(message: Pick<RowsRequest, 'search' | 'sort' | 'filter'>): Promise<{ result: QueryResult; indices: number[]; searched?: number[]; statuses?: RowStatus[] } | undefined | null> {
        const session = this.session;
        const { spec } = this.spec();
        if (!session || !spec.views.length) return undefined;
        let result: QueryResult;
        try {
            await this.loadLookups(session, spec);
            result = this.read(session, spec);
        } catch (error) {
            // The user's own SQL no longer runs (the page says why): no rows. The steps' SQL failing is an error
            if (this.query?.sql) return undefined;
            throw error;
        }
        const search = String(message.search ?? '').trim();
        const sort = message.sort && Number.isInteger(message.sort.column) && message.sort.column < result.columns.length ? message.sort : null;
        // Results is remembered as it was left
        const query = this.query;
        if (query && (query.search ?? '') !== search || JSON.stringify(query?.sort ?? null) !== JSON.stringify(sort)) {
            if (query) {
                query.search = search || undefined;
                query.sort = sort ? { column: sort.column, dir: sort.dir === 'desc' ? 'desc' : 'asc' } : null;
                await saveQuery(this.ports.state, query);
            }
        }
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
        const result = this.result;
        const session = this.session;
        if (!result || !session || !result.keyViews || !result.keyValues || !Number.isInteger(index) || !result.rows[index]) return;
        const { spec } = this.spec();
        const tables = tableNames(spec.views);
        const keys = compareKeySql(spec);
        const places: string[] = [];
        const records: Record<string, unknown>[][] = [];
        result.keyViews.forEach((viewId, p) => {
            const place = result.keyPlaces![p];
            if (hidden.includes(place)) return;
            places.push(place);
            const value = result.keyValues![index][p];
            const view = spec.views.find(v => v.id === viewId);
            if (value === null || value === undefined || !view) { records.push([]); return; }
            const out = session.run(`SELECT * FROM ${quoteName(tables.get(viewId) ?? '')} AS ${quoteName(refNames(spec.views).get(viewId) ?? '')} WHERE ${keys[p].sql} = ${typeof value === 'number' ? value : `'${String(value).replace(/'/g, "''")}'`} LIMIT 5`);
            records.push(out.rows.map(r => Object.fromEntries(out.columns.map((c, i) => [c, r[i]]))));
        });
        const names = [...new Set(records.flatMap(rs => rs.flatMap(r => Object.keys(r))))];
        const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
        const fields = names.map(name => {
            const values = records.map(rs => rs.map(r => r[name]));
            const held = values.filter(v => v.length).map(v => JSON.stringify(v.map(text)));
            return { name, values, differs: new Set(held).size > 1 };
        });
        const status = result.statusOf ? result.statusOf(hidden)[index] : undefined;
        this.post({ type: 'query.recordDetail', index, places, fields, status });
    }

    /** The places Results' Status names (each view of the compare, each place a compared column has), or null when nothing is compared. */
    private statusPlaces(): string[] | null {
        const query = this.query;
        if (!query || query.sql) return null;
        const { spec } = this.spec();
        if (!spec.views.length) return null;
        const label = (viewId: string): string => runName(query, viewId) || spec.views.find(v => v.id === viewId)?.name || viewId;
        const status = rowStatus(resultColumnRefs(spec), [], compareKeySql(spec).map(k => label(k.view)), [], label);
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
                const label = (viewId: string): string => runName(this.query!, viewId) || spec.views.find(v => v.id === viewId)?.name || viewId;
                const keyPlaces = keys.map(k => label(k.view));
                const first = rowStatus(columns, rows, keyPlaces, keyValues, label);
                const cache = new Map<string, RowStatus[]>();
                this.result = {
                    key, columns, rows,
                    ...(first ? {
                        places: first.places, keyPlaces, keyValues, keyViews: keys.map(k => k.view),
                        statusOf: (hidden: string[]) => {
                            const at = hidden.slice().sort().join('\n');
                            if (!at) return first.rows;
                            if (!cache.has(at)) cache.set(at, rowStatus(columns, rows, keyPlaces, keyValues, label, hidden)!.rows);
                            return cache.get(at)!;
                        }
                    } : {})
                };
            }
            this.filtered = undefined;
        }
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
        const terms = parseSearchExpression(search);
        // A column answers to its name (@sku: any view's) and to its view's letter with it (@d.sku: that view's)
        const letters = new Map(this.query?.sources.map(s => [s.id, s.name]) ?? []);
        const cols = result.columns.map((c, i) => {
            const letter = letters.get(c.view);
            return { id: letter ? `${letter}.${c.column}`.toLowerCase() : `c${i}`, name: c.column, type: 'string' };
        });
        const get = (r: Record<string, unknown>, id: string) => r[id];
        const out: number[] = [];
        for (let start = 0; start < result.rows.length; start += SEARCH_CHUNK) {
            if (start) await new Promise(resolve => setTimeout(resolve, 0));
            if (seq !== this.searchSeq || this.closed) return null;
            const end = Math.min(result.rows.length, start + SEARCH_CHUNK);
            for (let i = start; i < end; i++) {
                const flat: Record<string, string> = {};
                const row = result.rows[i];
                for (let c = 0; c < cols.length; c++) flat[cols[c].id] = row[c] === null || row[c] === undefined ? '' : String(row[c]);
                if (matchesRow(terms, flat, cols, get)) out.push(i);
            }
        }
        return out;
    }
}

/** A file's content from the page: text for CSV-like files, base64 for a workbook. */
interface FileMessage {
    name: string;
    text?: string;
    base64?: string;
}

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

/** Each run's first run, by id: what keeps a run's key its first run's. */
function runsOf(query: SavedQuery): Map<string, string> {
    return new Map(query.sources.filter(s => s.runOf).map(s => [s.id, s.runOf as string]));
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


