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
import { allColumns, columnSql, defaultColumns, fromSql, joinKeyColumns, quoteName, tableNames, writeSql } from '../../services/query/query-sql';
import { reportNameProblem } from '../../services/compare/report-name';
import { cleanViewName, getQuery, guessViewName, MAX_QUERY_VIEWS, moveView, moveViewFirst, nameViews, newSourceId, nextRunName, QuerySource, renameView, runName, saveQuery, SavedQuery, untickBlanks, untickClashes } from '../../services/query/query-store';
import { columnTypes, spread, TYPE_SAMPLE, type ColumnType } from '../../services/query/column-types';
import { CALC_VIEW, QUERY_JOIN_KINDS } from '../../services/query/query-types';
import { alignCompareJoins, MAX_COMPARE_VIEWS, queryCompare, runJoin } from '../../services/query/query-compare';
import type { ColumnRef, QueryFn, QueryJoin, QueryJoinKind, QueryJoinStats, QuerySpec } from '../../services/query/query-types';
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
    private result: { key: string; columns: ColumnRef[]; rows: unknown[][] } | undefined;
    private filtered: { key: string; indices: number[] } | undefined;
    private searchSeq = 0;
    /** Counts each change: work for an older one is dropped. */
    private version = 0;
    /** Results as the page last asked for it: what Chain sends. */
    private shown: Pick<RowsRequest, 'search' | 'sort'> = {};
    /**
     * Chain, the Console's own (its handler here, its dialog on the page): Results' rows become a
     * Run Batch's input. A link needs a run to come from, so it is the first view's.
     */
    private readonly chain: ConsoleChainHandler;

    constructor(private readonly session_: ScreenSession, private readonly ports: QueryPorts, private readonly config: QueryConfig) {
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
                case 'query.addRun': return await this.addRun(String(message.of ?? ''), String(message.executionId ?? ''));
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
                    if (QUERY_JOIN_KINDS.includes(message.kind as QueryJoinKind)) {
                        const kind = message.kind as QueryJoinKind;
                        // A compare takes up to four views, the Baseline included
                        const inCompare = queryCompare(q.joins)?.views.length ?? 1;
                        if (kind === 'compare' && join.kind !== 'compare' && inCompare >= MAX_COMPARE_VIEWS) {
                            this.ports.toast.warn(`A compare takes ${MAX_COMPARE_VIEWS} views. Take one out of it to put ${q.sources.find(s => s.id === join.view)?.name ?? 'this one'} in.`);
                            return;
                        }
                        join.kind = kind;
                    }
                    if (Array.isArray(message.on)) {
                        // A run's own column is its first run's, filled in below: its pairs need only their left side
                        const isRun = runsOf(q).has(join.view);
                        join.on = (message.on as PagePair[]).filter(p => p?.left?.column && (p?.right?.column || isRun)).map(p => ({
                            left: { parts: [{ view: p.left.view, column: p.left.column, ...(p.left.fns?.length ? { fns: p.left.fns } : {}) }] },
                            right: { parts: [{ view: join.view, column: p.right.column, ...(p.right.fns?.length ? { fns: p.right.fns } : {}) }] }
                        }));
                    }
                    // One key across the compare: every Compare join after the first joins on the first one's key
                    alignCompareJoins(q.joins, runsOf(q));
                });
                case 'query.setSelect': return await this.change(q => {
                    q.select = Array.isArray(message.select) ? (message.select as ColumnRef[]).map(c => ({ view: c.view, column: c.column })) : undefined;
                });
                case 'query.moveColumn': return await this.moveColumn(Number(message.from), Number(message.to));
                case 'query.distinct': return await this.change(q => { q.distinct = !!message.on; });
                case 'query.setCalc': return await this.setCalc(String(message.name ?? ''), String(message.expr ?? ''), typeof message.was === 'string' ? message.was : undefined);
                case 'query.removeCalc': return await this.change(q => {
                    q.calc = q.calc?.filter(c => c.name !== message.name);
                    q.select = q.select?.filter(c => !(c.view === CALC_VIEW && c.column === message.name));
                });
                case 'query.setSql': return await this.setSql(String(message.sql ?? ''));
                case 'query.latest': return await this.useLatest(String(message.id));
                case 'query.viewRows': return this.viewRows(String(message.id), String(message.search ?? ''), Number(message.seq));
                case 'query.fnSample': return this.fnSample(message as unknown as { view: string; column: string; fns?: QueryFn[]; seq: number });
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
        await Promise.all(ids.map(async id => {
            current.set(id, await this.ports.endpoints.getEndpoint(id).catch(() => undefined));
            views[id] = (await this.successViews(id)).map(v => v.name);
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
                rows: String(e.rows ?? '')
            });
        }
        this.post({ type: 'query.sourceList', results, views });
    }

    private async successViews(endpointId: string): Promise<CompareView[]> {
        const settings = await this.views.load(endpointId) as { success?: { views?: CompareView[] } } | null;
        return (settings?.success?.views ?? []).filter(v => v && Array.isArray(v.columns));
    }

    private async addView(message: { endpointId: string; executionId: string; view: string }): Promise<void> {
        const query = this.query;
        if (!query) return;
        if (query.sources.length >= MAX_QUERY_VIEWS) throw new Error(`A query takes up to ${MAX_QUERY_VIEWS} views.`);
        const run = await this.ports.metadata.getExecution(message.executionId) ?? await this.ports.metadata.getBatchExecution(message.executionId);
        if (!run) throw new Error('That result is no longer in History.');
        const endpoint = await this.ports.endpoints.getEndpoint(message.endpointId).catch(() => undefined);
        const endpointName = endpoint?.name || run.endpointName || 'Endpoint';
        // Named after its View, or its endpoint when the View's name says nothing ("Default")
        const plain = !message.view || /^(default|root|view)$/i.test(message.view.trim());
        const base = plain ? endpointName : message.view;
        const name = guessViewName(base, query.sources.map(s => s.name));
        const source: QuerySource = {
            id: newSourceId(), name, endpointId: message.endpointId, endpointName, view: message.view,
            request: endpoint ? getEndpointViewScopeKey(endpoint.method, endpoint.path) : (run.endpointMethod && run.endpointPath ? getEndpointViewScopeKey(run.endpointMethod, run.endpointPath) : ''),
            system: (endpoint?.systemId ? await this.ports.systemName?.(endpoint.systemId).catch(() => undefined) : undefined) ?? '',
            executionId: message.executionId, isBatch: run.executionType === 'batch',
            environment: run.environment || 'Unknown', executedAt: iso(run.startedAt || run.createdAt)
        };
        await this.attach(source);
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
        const inCompare = queryCompare(query.joins)?.views.length ?? 1;
        if (inCompare >= MAX_COMPARE_VIEWS) {
            this.ports.toast.warn(`A compare takes ${MAX_COMPARE_VIEWS} runs and views. Take one out of it to add another run.`);
            return;
        }
        const run = await this.ports.metadata.getExecution(executionId) ?? await this.ports.metadata.getBatchExecution(executionId);
        if (!run) throw new Error('That result is no longer in History.');
        const label = nextRunName(query, head.id);
        const source: QuerySource = {
            ...head, id: newSourceId(), name: guessViewName(`${head.name}_${label}`, query.sources.map(s => s.name)),
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
    private fnSample(message: { view: string; column: string; fns?: QueryFn[]; seq: number }): void {
        const tables = tableNames(this.spec().spec.views);
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
        this.post({ type: 'query.fnSample', seq: message.seq, rows, error });
    }

    /** Add a calculated column, or change the one named `was`. Its expression is tried first: one SQLite refuses is not kept. */
    private async setCalc(nameIn: string, exprIn: string, was?: string): Promise<void> {
        const query = this.query;
        if (!query) return;
        const name = nameIn.trim();
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
                columns = spec.select.length ? spec.select : defaultColumns(spec);
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
                resultTypes = columnTypes(session.sample(TYPE_SAMPLE).rows, columns.length);
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
            columns: (now.columns ?? []).map(c => ({ view: c.view, column: c.column })),
            // One row of the report, every view's columns: what Columns shows under each name
            sampleRow: now.sampleRow ?? [],
            // A joining view's key, and the column it is matched to: not shown twice
            keyColumns: joinKeyColumns(this.spec().spec).map(k => ({ view: k.key.view, column: k.key.column, sameView: k.same.view, sameColumn: k.same.column })),
            allSelected: !(query.select?.length),
            distinct: !!query.distinct,
            duplicates: now.duplicates ?? 0,
            maxViews: MAX_QUERY_VIEWS,
            // A Compare join makes the query a compare: its Baseline and the views in it
            compare: queryCompare(query.joins) ?? null,
            maxCompare: MAX_COMPARE_VIEWS,
            // Results' columns: the steps', or what the user's own SQL makes
            resultColumns: (now.resultColumns ?? now.columns ?? []).map((c, i) => ({ view: c.view, column: c.column, type: now.resultTypes?.[i] ?? 'text' })),
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
        this.shown = { search: message.search, sort: message.sort };
        const found = await this.found(message);
        if (found === null) return;
        if (!found) {
            this.post({ type: 'query.rowsData', seq: message.seq, offset: 0, rows: [], shown: 0, total: 0 });
            return;
        }
        const { result, indices } = found;
        const offset = Math.max(0, Math.floor(Number(message.offset) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(message.limit) || 200)));
        this.post({
            type: 'query.rowsData', seq: message.seq, offset,
            rows: indices.slice(offset, offset + limit).map(i => result.rows[i]),
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
        const columns = (spec.select.length ? spec.select : defaultColumns(spec)).map(c => ({ view: c.view, column: c.column }));
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
    private async found(message: Pick<RowsRequest, 'search' | 'sort'>): Promise<{ result: { key: string; columns: ColumnRef[]; rows: unknown[][] }; indices: number[] } | undefined | null> {
        const session = this.session;
        const { spec } = this.spec();
        if (!session || !spec.views.length) return undefined;
        let result: { key: string; columns: ColumnRef[]; rows: unknown[][] };
        try {
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
        const key = JSON.stringify([search, sort]);
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
            this.filtered = { key, indices };
        }
        return { result, indices: this.filtered.indices };
    }

    /** Every row of Results, read once: the steps' SQL, or the user's own. */
    private read(session: QuerySession, spec: QuerySpec): { key: string; columns: ColumnRef[]; rows: unknown[][] } {
        const own = this.query?.sql;
        const key = own ?? session.sql();
        if (!this.result || this.result.key !== key) {
            const tooMany = own ? undefined : session.tooManyRows();
            if (tooMany) throw new Error(tooManyRowsText(tooMany, spec));
            const out = own ? session.run(own) : session.rows();
            const columns = own ? out.columns.map(column => ({ view: CALC_VIEW, column })) : spec.select.length ? spec.select : defaultColumns(spec);
            this.result = { key, columns, rows: out.rows };
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
