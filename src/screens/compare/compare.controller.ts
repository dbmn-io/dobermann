// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare — one saved compare (compare-store): a Baseline and one to three other
 * results of one endpoint, read through one Console View, matched on a key and compared column
 * by column. Shared by every host.
 *
 * A compare starts in the Console (Compare, next to Chain) as a draft holding its Baseline; the
 * Hub's Compare list opens it again once Select has picked what to compare. Steps (the page's
 * step bar, like Run Batch): Select (the Baseline and the results compared with it), Match (the
 * key: it must pair records one to one), Compare (the columns, each Strict or Relaxed, and the
 * join), Results. The Hub's Edit opens on Select.
 *
 * The Baseline is BL; the others are C1, C2, C3, in the order picked. One compare measures every
 * result against BL (compareAcross); Results read it through a CompareLens: the results shown
 * (C1 to C3 can be hidden), the compared columns not hidden, and which rows. Picking another
 * result as Baseline swaps it with BL and compares again.
 *
 * Nothing here sends a request: it reads the runs' saved response files. The result stays
 * here and the page asks for one window of rows at a time, so any number of rows works.
 */
import type { ScreenSession } from '../screen-session';
import type { ComparePorts } from './compare.ports';
import { buildConsoleReportConfig } from '../console/console-report-config';
import { ResponseDataExtractor } from '../../services/console/response-data-extractor';
import { ConsoleViewsStore } from '../../services/console/console-views-store';
import { buildCompareSide, CompareSide, CompareView } from '../../services/compare/compare-side';
import {
    keyCanCompare,
    matchProfile,
    MatchKind,
    MANY_KINDS,
    MatchProfile,
    CompareJoin,
    CompareRowData,
    CompareSpec,
} from '../../services/compare/compare-engine';
import { compareAcross, AcrossResult } from '../../services/compare/compare-across';
import { CompareLens, LensFilter, LensSort, placeLetter, Relation, RELATIONS } from '../../services/compare/compare-lens';
import { buildCompareSheets, compareFileName } from '../../services/compare/compare-export';
import { ConsoleExportService } from '../../services/console/export.service';
import { comparableRuns, CompareRun, RequestTemplates } from '../../services/compare/compare-runs';
import { reportNameProblem } from '../../services/compare/report-name';
import { getCompare, isDraft, removeCompare, saveCompare, CompareSetup, CompareSource, MAX_COMPARE_SOURCES, SavedCompare } from '../../services/compare/compare-store';
import * as searchMatcherScript from '../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../utils/shared-script';

const { parseSearchExpression, matchesRow } = sharedScript<typeof searchMatcherScript>(searchMatcherScript, 'SearchMatcher');

export type { CompareSetup } from '../../services/compare/compare-store';

export interface CompareConfig {
    /** The saved compare (compare-store). */
    compareId: string;
    /** Kept for the hosts; every compare opens on Select (compare.ready). */
    start?: 'results' | 'match' | 'edit';
}

export type { CompareRun } from '../../services/compare/compare-runs';

export type CompareMessage = { type: string; [key: string]: unknown };

/**
 * A value as it goes to the page. A field the record does not have is not null: Compare tells
 * them apart (strict), so the page must too. A message turns undefined into null on the way,
 * so a missing field goes as this marker and the page shows "missing".
 */
export const MISSING_VALUE = Object.freeze({ $dbmnMissing: true });
/** Find reads this many rows between giving way to the page. */
const SEARCH_CHUNK = 2000;
/** Match's drill-in shows this many values a page, and at most this many records of one from each side. */
const VALUES_SHOWN = 25;
const GROUP_SHOWN = 25;
/** A key on more records than this is far from a key: the drill-in says why, and lists keys only. */
const GROUP_LOOK = 50;
/** The keys such a drill-in lists. */
const KEYS_LISTED = 20;

/**
 * For each "many" kind, the records its values hold on each side (Match shows BL's and the other
 * result's, the picture between them), the records on values the other side doesn't have at all,
 * and the most one value holds: how far it is from a key.
 */
type KindCounts = Partial<Record<MatchKind, number>>;
function groupSizes(profile: MatchProfile): { recordsBase: KindCounts; recordsOther: KindCounts; unmatched: KindCounts; largest: KindCounts } {
    const recordsBase: KindCounts = {};
    const recordsOther: KindCounts = {};
    const unmatched: KindCounts = {};
    const largest: KindCounts = {};
    const add = (to: KindCounts, kind: MatchKind, n: number) => { to[kind] = (to[kind] ?? 0) + n; };
    for (const g of profile.groups) {
        if (!MANY_KINDS.includes(g.kind)) continue;
        add(recordsBase, g.kind, g.base.length);
        add(recordsOther, g.kind, g.other.length);
        if (!g.base.length || !g.other.length) add(unmatched, g.kind, g.base.length + g.other.length);
        largest[g.kind] = Math.max(largest[g.kind] ?? 0, g.base.length + g.other.length);
    }
    return { recordsBase, recordsOther, unmatched, largest };
}

const wire = (value: unknown): unknown => (value === undefined ? MISSING_VALUE : value);

function iso(d: unknown): string {
    if (d instanceof Date) return d.toISOString();
    return typeof d === 'string' ? d : '';
}

export class CompareController {
    private closed = false;
    private readonly views: ConsoleViewsStore;
    private readonly extractor: ResponseDataExtractor;
    private runs: CompareRun[] = [];
    private endpoint: { id: string; name: string; method: string; path: string } | undefined;
    /** The saved compare: its sources are the Baseline (place 0), then C1, C2, C3. */
    private compare: SavedCompare | undefined;
    private viewName: string | undefined;
    /** Columns shown on Results, never compared. */
    private shownColumns: string[] = [];
    /** Columns removed on Results (the gear, × on a heading), compared or shown only. */
    private hidden: string[] = [];
    /** Where the View's rows sit in a response ('root': the response itself). */
    private rowBasis = 'root';
    private sides: CompareSide[] = [];
    /** The Match step's check under way: a newer one (the ticks changed) stops it. */
    private matching: AbortController | undefined;
    /** How the Baseline meets each other result on the key being tried (Match). */
    private profiles: { signature: string; byPlace: Map<number, MatchProfile> } | undefined;

    /** Counts each read of the results: a Check of results since replaced is never kept. */
    private sidesVersion = 0;
    /** The running compare was stopped by the user's Cancel (not by newer work). */
    private cancelledByUser = false;
    private spec: CompareSpec | undefined;
    /** Every result measured against BL (place 0). */
    private across: AcrossResult | undefined;
    /** What Results show of it (the results shown, the columns not hidden), and the same with nothing hidden. */
    private lens: CompareLens | undefined;
    private fullLens: CompareLens | undefined;
    private lensVersion = 0;
    /** The results shown on Results, by place (BL always). */
    private visible: number[] = [];
    private join: CompareJoin = 'full';
    private running: AbortController | undefined;
    /** Result rows for the current filter, find and sort, cached between window requests. */
    private filtered: { signature: string; indices: number[] } | undefined;
    /** The find under way: its signature and its answer to come (window requests for it wait on it). */
    private filtering: { signature: string; promise: Promise<number[] | null> } | undefined;
    /** Each find's number: a find seeing a newer one stops. */
    private searchSeq = 0;

    constructor(private readonly session: ScreenSession, private readonly ports: ComparePorts, private readonly config: CompareConfig) {
        this.views = new ConsoleViewsStore({ state: ports.state, endpoints: ports.endpoints, log: m => ports.logger?.log(m) });
        this.extractor = new ResponseDataExtractor({ executionMetadataService: ports.metadata });
    }

    dispose(): void {
        this.closed = true;
        this.running?.abort();
        this.session.dismissAll();
        // Closed on Select before Next: the draft goes (it was never in the Hub's list)
        const compare = this.compare ?? getCompare(this.ports.state, this.config.compareId);
        if (compare && isDraft(compare)) {
            removeCompare(this.ports.state, compare.id).catch(error => this.ports.logger?.error('[Compare] Removing the draft failed', error));
        }
    }

    private post(message: Record<string, unknown>): void {
        if (!this.closed) this.session.post(message);
    }

    async handleMessage(message: CompareMessage): Promise<void> {
        try {
            switch (message.type) {
                // Every compare opens on Select: nothing is read until a later step is asked for
                case 'compare.ready': return await this.open('edit');
                // The Hub's Edit while this tab is open
                case 'compare.startEdit': this.post({ type: 'compare.openEdit' }); return;
                // Select's picks unchanged: read them, for Match, or for Results when asked (the step bar's Results)
                case 'compare.load': return await this.open(message.to === 'results' ? 'results' : 'match');
                case 'compare.edit': return await this.edit(message as unknown as { ids: string[]; to?: string });
                case 'compare.match': return await this.match(message.keyColumns as string[]);
                case 'compare.matchGroup': return await this.matchGroup(message as unknown as { keyColumns: string[]; place: number; kind: MatchKind; index: number; alone?: boolean });
                case 'compare.run': return await this.run(message.setup as CompareSetup);
                case 'compare.setJoin': return await this.setJoin(message.join as CompareJoin);
                case 'compare.lens': return await this.setLens(message as unknown as { visible: number[]; hidden: string[] });
                case 'compare.remove': return await this.removeSource(Number(message.place), message.keyColumns as string[] | undefined);
                case 'compare.baseline': return await this.makeBaseline(Number(message.place), message.keyColumns as string[] | undefined);
                case 'compare.layout': return await this.saveLayout(message as unknown as { columnOrder?: string[]; sort?: LensSort | null; columnWidths?: Record<string, number> });
                case 'compare.setView': await this.ports.state.update(RESULTS_VIEW_KEY, message.view === 'compact' ? 'compact' : 'side'); return;
                case 'compare.rows': return await this.rows(message as unknown as RowsRequest);
                case 'compare.record': return this.record(message as unknown as { index: number });
                case 'compare.export': return await this.export(message as unknown as ExportRequest);
                case 'compare.rename': return await this.rename(String(message.name ?? '').trim());
                case 'compare.cancel': this.cancelledByUser = !!this.running; this.running?.abort(); return;
                case 'compare.openConsole': {
                    const source = this.compare?.sources[Number(message.place)];
                    if (source) await this.ports.host.openConsole(source.executionId, source.isBatch);
                    return;
                }
                default:
                    await this.session.handleShared(message);
            }
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') {
                // Only the user's Cancel says so: work stopped for newer work (Edit, a new run)
                // must not unlock the page while the newer work runs
                if (this.cancelledByUser) this.post({ type: 'compare.cancelled' });
                this.cancelledByUser = false;
                return;
            }
            const text = error instanceof Error ? error.message : String(error);
            this.ports.logger?.error(`[Compare] ${message.type} failed`, error);
            this.post({ type: 'compare.error', message: text });
        }
    }

    /** The endpoint's finished runs, newest first: what Edit can pick from. */
    private async loadRuns(endpointId: string, endpoint?: RequestTemplates): Promise<void> {
        this.runs = await comparableRuns(this.ports.metadata, this.ports.environments, endpointId, endpoint);
    }

    /**
     * Open the saved compare: read its results through the View, then Match, or straight to
     * Results when it has run before (the Hub's Open), or the results dialog (the Hub's Edit).
     */
    private async open(start: 'results' | 'match' | 'edit'): Promise<void> {
        const compare = getCompare(this.ports.state, this.config.compareId);
        if (!compare) throw new Error('This compare is no longer saved. Start a new one from a Console.');
        this.compare = compare;
        const base = compare.sources[0];
        const endpoint = await this.ports.endpoints.getEndpoint(base.endpointId);
        this.endpoint = endpoint
            ? { id: endpoint.id, name: endpoint.name, method: endpoint.method, path: endpoint.path }
            : { id: base.endpointId, name: 'Endpoint', method: '', path: '' };
        await this.loadRuns(base.endpointId, endpoint);
        this.viewName = base.view;
        const missing = this.missingSources();
        const select = start === 'edit' || isDraft(compare) || missing.length > 0;
        // Where this is going, so the page shows the work on the step it leads to
        this.postInit(select ? 'select' : start === 'results' && !!compare.setup ? 'results' : 'match');
        if (select) {
            if (missing.length) this.ports.toast.warn(`${missing.map(letter).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} no longer in History. Pick another result.`);
            this.post({ type: 'compare.openEdit' });
            return;
        }
        await this.readSides();
        const setup = this.savedSetup();
        // Results asked for: the compare as it was saved, when its key still pairs one to one
        const runNow = start === 'results' && await this.runnable(setup);
        this.postSides(setup, runNow);
        if (runNow) await this.run(setup!);
    }

    /** A saved setup that can run as it is: every column still there, the key still one to one. */
    private async runnable(setup: (CompareSetup & { missingColumns: string[] }) | undefined): Promise<boolean> {
        return !!setup && setup.compareColumns.length > 0 && !setup.missingColumns.length && await this.keyOk(setup.keyColumns);
    }

    /** The places whose result is gone from History. */
    private missingSources(): number[] {
        const have = new Set(this.runs.map(r => r.id));
        return (this.compare?.sources ?? []).map((s, i) => (have.has(s.executionId) ? -1 : i)).filter(i => i >= 0);
    }

    /** The name typed in the footer. Refused (another report has it), the box goes back to the name it has. */
    private async rename(name: string): Promise<void> {
        const compare = this.compare;
        if (!compare) return;
        if (name && name !== compare.name) {
            const problem = reportNameProblem(this.ports.state, compare.id, name);
            if (problem) this.ports.toast.warn(problem);
            else {
                compare.name = name;
                await saveCompare(this.ports.state, compare);
                this.ports.host.compared?.();
            }
        }
        this.post({ type: 'compare.named', name: compare.name ?? '' });
    }

    /** `opens`: the step this is on its way to (Results can still stop at Match: compare.sides says). */
    private postInit(opens: 'select' | 'match' | 'results'): void {
        const compare = this.compare!;
        const runs = new Map(this.runs.map(r => [r.id, r]));
        this.post({
            type: 'compare.init',
            opens,
            // The key and columns saved: Select can skip ahead to Match, Compare or Results
            setup: compare.setup ?? null,
            // Compared with these very results: until then (picks changed), Columns and Results wait for Match
            compared: !!compare.comparedAt,
            name: compare.name ?? this.endpoint?.name ?? 'Compare',
            endpoint: this.endpoint,
            view: this.viewName,
            max: MAX_COMPARE_SOURCES,
            // The Baseline first, then C1, C2, C3
            sources: compare.sources.map(s => {
                const run = runs.get(s.executionId);
                return {
                    id: s.executionId,
                    environment: run?.environment ?? s.environment,
                    header: run?.header ?? s.header,
                    executedAt: run?.executedAt ?? s.executedAt,
                    rows: run?.rows ?? '',
                    status: run?.status ?? '',
                    incomplete: !!run?.incomplete,
                    missing: !run,
                };
            }),
            runs: this.runs,
            // Side by side or Compact: the one last used, on any compare
            resultsView: this.ports.state.get<string>(RESULTS_VIEW_KEY) === 'compact' ? 'compact' : 'side',
        });
    }

    /**
     * Select's Next: the results picked (again). The Baseline first; the key and columns carry
     * over. On to Match (its key is checked there), or to Results when the step bar's Results
     * asked and the key still pairs one to one.
     */
    private async edit(message: { ids: string[]; to?: string }): Promise<void> {
        const compare = this.compare;
        if (!compare) throw new Error('This compare is no longer saved.');
        const ids = [...new Set(message.ids)];
        if (ids.length < 2) throw new Error('Pick at least one result to compare with the Baseline.');
        if (ids.length > MAX_COMPARE_SOURCES) throw new Error(`Compare up to ${MAX_COMPARE_SOURCES} results at a time.`);
        const base = compare.sources[0];
        const sources: CompareSource[] = ids.map(id => {
            const run = this.runs.find(r => r.id === id);
            if (!run) throw new Error('That result is no longer in History.');
            return { kind: 'result', endpointId: base.endpointId, view: base.view, executionId: run.id, isBatch: run.isBatch, environment: run.environment, executedAt: run.executedAt, ...(run.header ? { header: run.header } : {}) };
        });
        this.running?.abort();
        this.compare = { ...compare, sources, comparedAt: undefined, counts: undefined };
        await saveCompare(this.ports.state, this.compare);
        this.ports.host.compared?.();
        this.clearResults();
        const toResults = message.to === 'results' && !!compare.setup;
        this.postInit(toResults ? 'results' : 'match');
        await this.readSides();
        const setup = this.savedSetup();
        // With a key that still pairs one to one and columns ticked, Results again
        const runNow = toResults && await this.runnable(setup);
        this.postSides(setup, runNow);
        if (runNow) await this.run(setup!);
    }

    /** Warn when a result did not fetch every page: its missing rows would look like differences. */
    private warnPages(): void {
        const runs = new Map(this.runs.map(r => [r.id, r]));
        const short = (this.compare?.sources ?? []).map((s, i) => (runs.get(s.executionId)?.incomplete ? letter(i) : '')).filter(Boolean);
        if (!short.length) return;
        this.ports.toast.warn(`${short.join(' and ')} did not fetch every page. Rows on the pages not fetched will look missing.`);
    }

    /** The success tab's saved Views (Compare uses completed rows only). */
    private async successViews(): Promise<{ names: string[]; byName: Map<string, CompareView> }> {
        const settings = await this.views.load(this.endpoint?.id ?? '') as { success?: { views?: CompareView[] } } | null;
        const list = (settings?.success?.views ?? []).filter(v => v && Array.isArray(v.columns));
        return { names: list.map(v => v.name), byName: new Map(list.map(v => [v.name, v])) };
    }

    private async loadResponses(source: CompareSource): Promise<unknown[]> {
        await this.ports.preloadRun?.(source.executionId);
        const config = await buildConsoleReportConfig({
            executionId: source.executionId,
            isBatch: source.isBatch,
            executionMetadataService: this.ports.metadata,
            environments: this.ports.environments,
        });
        return this.extractor.extractResponses(config.responseFiles, config.responseFileStatusMap, config.responseFileDetails);
    }

    /** Read every result and build its rows through the View. */
    private async readSides(): Promise<void> {
        const sources = this.compare!.sources;
        const { byName } = await this.successViews();
        let view = this.viewName ? byName.get(this.viewName) : undefined;
        // A View the endpoint no longer has: Compare reads results only through the endpoint's Views
        if (!view && byName.size) throw new Error(`The View "${this.viewName}" no longer exists. Start a new compare from a Console.`);
        const responses: unknown[][] = [];
        for (let i = 0; i < sources.length; i++) {
            this.post({ type: 'compare.progress', phase: `Reading ${letter(i)}`, done: i, total: sources.length });
            responses.push(await this.loadResponses(sources[i]));
        }
        // No saved View: the Console shows the top-level fields, and so does Compare
        const shape = view ?? rootView(responses[0]);
        this.rowBasis = shape.rowBasis || 'root';
        this.sides = responses.map(r => buildCompareSide(r, shape));
        this.sidesVersion++;
        this.profiles = undefined;
        this.warnPages();
    }

    /** The results are read. `running`: Results follow at once (the page stays busy until then). */
    private postSides(setup: (CompareSetup & { missingColumns: string[] }) | undefined, running: boolean): void {
        this.post({
            type: 'compare.sides',
            view: this.viewName,
            columns: this.sides[0].columns,
            samples: this.samples(),
            sides: this.sides.map(s => ({ rows: s.rows.length, responses: s.responseCount, completed: s.completedCount })),
            setup,
            running,
        });
    }

    /** One value per column from BL, its first that is not empty, for Match's list (a short look, not the whole result). */
    private samples(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        const rows = this.sides[0]?.rows ?? [];
        for (const column of this.sides[0]?.columns ?? []) {
            for (let i = 0; i < rows.length && i < SAMPLE_ROWS; i++) {
                const value = rows[i][column.id];
                if (value !== undefined && value !== null && value !== '') { out[column.id] = value; break; }
            }
        }
        return out;
    }

    private clearResults(): void {
        this.across = undefined;
        this.lens = undefined;
        this.fullLens = undefined;
        this.visible = [];
        this.filtered = undefined;
    }

    /** The saved setup, minus columns the View no longer has (they are reported). */
    private savedSetup(): (CompareSetup & { missingColumns: string[] }) | undefined {
        const setup = this.compare?.setup;
        if (!setup) return undefined;
        const have = new Set(this.sides[0].columns.map(c => c.id));
        const used = [...setup.keyColumns, ...setup.compareColumns, ...(setup.shownColumns ?? [])];
        return {
            keyColumns: setup.keyColumns.filter(c => have.has(c)),
            compareColumns: setup.compareColumns.filter(c => have.has(c)),
            relaxedColumns: (setup.relaxedColumns ?? []).filter(c => have.has(c)),
            shownColumns: (setup.shownColumns ?? []).filter(c => have.has(c)),
            join: setup.join ?? 'full',
            hiddenColumns: (setup.hiddenColumns ?? []).filter(c => have.has(c)),
            ...(setup.columnOrder ? { columnOrder: setup.columnOrder.filter(c => have.has(c)) } : {}),
            ...(setup.columnWidths ? { columnWidths: setup.columnWidths } : {}),
            ...(setup.sort && have.has(setup.sort.column) ? { sort: setup.sort } : {}),
            missingColumns: [...new Set(used.filter(c => !have.has(c)))],
        };
    }

    /** Save part of the setup with the compare (hidden columns, column order, sort, join). */
    private async saveSetup(part: Partial<CompareSetup>): Promise<void> {
        const compare = this.compare;
        if (!compare?.setup) return;
        this.compare = { ...compare, setup: { ...compare.setup, ...part } };
        await saveCompare(this.ports.state, this.compare);
    }

    /**
     * Results show other results or columns: every row is counted again (a hidden result or
     * column is not compared). The hidden columns are saved with the compare; the View is not touched.
     */
    private async setLens(message: { visible: number[]; hidden: string[] }): Promise<void> {
        if (!this.across) return;
        const started = Date.now();
        this.visible = message.visible.filter(p => p > 0 && p < this.sides.length);
        this.hidden = message.hidden.filter(c => this.spec?.compareColumns.includes(c) || this.shownColumns.includes(c));
        this.buildLens(this.hidden);
        await this.saveSetup({ hiddenColumns: message.hidden });
        const ms = Date.now() - started;
        this.ports.logger?.log(`[Compare] Recount: ${this.across.length} rows in ${ms} ms`);
        this.post({ type: 'compare.counts', ...this.lensCounts(), ms });
    }

    /** Which rows, picked on the Compare step: where the Status filter starts (the page sets it). Saved. */
    private async setJoin(join: CompareJoin): Promise<void> {
        this.join = join;
        if (this.across) await this.saveSetup({ join });
    }

    /** The column order (headings dragged) and sort (a heading clicked), saved with the compare. */
    private async saveLayout(message: { columnOrder?: string[]; sort?: LensSort | null; columnWidths?: Record<string, number> }): Promise<void> {
        const part: Partial<CompareSetup> = {};
        if (message.columnOrder) part.columnOrder = message.columnOrder;
        if (message.sort !== undefined) part.sort = message.sort ?? undefined;
        if (message.columnWidths && typeof message.columnWidths === 'object') {
            part.columnWidths = Object.fromEntries(Object.entries(message.columnWidths).filter(([, w]) => Number.isFinite(w) && w >= 20 && w <= 4000).map(([k, w]) => [k, Math.round(w)]));
        }
        // Only the order and the sort change which rows come first: widths leave the rows as they are
        if (message.columnOrder || message.sort !== undefined) this.filtered = undefined;
        await this.saveSetup(part);
    }

    /**
     * Another result as Baseline: it swaps places with BL (it becomes BL, BL takes its letter),
     * the swap is saved, and every result is measured against the new BL.
     */
    /**
     * Another result becomes BL; BL takes its place. On Results, every result is matched and
     * compared again. Before Results (Match, Columns) the key ticked there is checked again, and
     * nothing is compared: the compare waits for Match again.
     */
    private async makeBaseline(place: number, keyColumns?: string[]): Promise<void> {
        const compare = this.compare;
        if (!compare || place <= 0 || place >= compare.sources.length || place >= this.sides.length) return;
        const compared = !!this.lens && !!compare.setup;
        const sources = compare.sources.slice();
        [sources[0], sources[place]] = [sources[place], sources[0]];
        [this.sides[0], this.sides[place]] = [this.sides[place], this.sides[0]];
        this.sidesVersion++;
        const setup = compare.setup && { ...compare.setup, sort: compare.setup.sort?.place !== undefined ? undefined : compare.setup.sort };
        this.compare = compared
            ? { ...compare, sources, setup }
            : { ...compare, sources, ...(setup ? { setup } : {}), comparedAt: undefined, counts: undefined };
        await saveCompare(this.ports.state, this.compare);
        this.ports.host.compared?.();
        this.profiles = undefined;
        const visible = this.visible;
        if (!compared) this.clearResults();
        this.postInitSources();
        const key = compared ? compare.setup!.keyColumns : keyColumns ?? [];
        if (key.length) await this.match(key);
        if (compared) await this.run(this.compare.setup!, visible);
    }

    /**
     * A slot's Remove, before Results: the result leaves the compare (those after it move up a
     * place) without reading the others again, and the key ticked is checked again. BL keeps one
     * result to compare with.
     */
    private async removeSource(place: number, keyColumns?: string[]): Promise<void> {
        const compare = this.compare;
        if (!compare || place <= 0 || place >= compare.sources.length || compare.sources.length <= 2 || place >= this.sides.length) return;
        this.running?.abort();
        this.compare = { ...compare, sources: compare.sources.filter((_, i) => i !== place), comparedAt: undefined, counts: undefined };
        this.sides = this.sides.filter((_, i) => i !== place);
        this.sidesVersion++;
        await saveCompare(this.ports.state, this.compare);
        this.ports.host.compared?.();
        this.profiles = undefined;
        this.clearResults();
        this.postInitSources();
        if (keyColumns?.length) await this.match(keyColumns);
    }

    /** The results' names and order after a swap, without starting over. */
    private postInitSources(): void {
        const runs = new Map(this.runs.map(r => [r.id, r]));
        this.post({
            type: 'compare.sources',
            sources: this.compare!.sources.map(s => {
                const run = runs.get(s.executionId);
                return { id: s.executionId, environment: run?.environment ?? s.environment, header: run?.header ?? s.header, executedAt: run?.executedAt ?? s.executedAt, rows: run?.rows ?? '', status: run?.status ?? '', incomplete: !!run?.incomplete, missing: !run };
            }),
            // Match's samples are BL's, and the results' sizes follow their places
            samples: this.samples(),
            sides: this.sides.map(s => ({ rows: s.rows.length, responses: s.responseCount, completed: s.completedCount })),
        });
    }

    /** The shown-only columns not removed on Results. */
    private shownVisible(): string[] {
        return this.shownColumns.filter(c => !this.hidden.includes(c));
    }

    private buildLens(hidden: string[]): void {
        const across = this.across!;
        const all = Array.from({ length: across.places }, (_, p) => p);
        this.lens = new CompareLens(across, { visible: [0, ...this.visible], hiddenColumns: hidden });
        // The counts with every result and column, for "4 of 6"
        this.fullLens = this.visible.length === all.length - 1 && !hidden.length
            ? this.lens
            : new CompareLens(across, { visible: all });
        this.lensVersion++;
        this.filtered = undefined;
    }

    private lensCounts(): Record<string, unknown> {
        return {
            visible: this.lens!.visible,
            counts: { ...this.lens!.counts, missingBy: this.lens!.missingBy },
            allCounts: { ...this.fullLens!.counts, missingBy: this.fullLens!.missingBy },
            columnDiffCounts: this.lens!.columnDiffCounts,
            // How each row's key meets the results (Match's pictures): the Relationship column
            relationCounts: this.lens!.relationCounts,
        };
    }

    private requireSides(): void {
        if (this.sides.length < 2) throw new Error('The results are not read yet.');
    }

    /** How the Baseline meets each other result on this key (cached while the key stays the same). */
    private async profilesFor(keyColumns: string[], signal?: AbortSignal): Promise<Map<number, MatchProfile>> {
        const signature = JSON.stringify(keyColumns);
        // The results can be read again while a Check runs (Edit): check those, never keep the old
        while (this.profiles?.signature !== signature) {
            const version = this.sidesVersion;
            const sides = this.sides;
            const byPlace = new Map<number, MatchProfile>();
            const others = sides.length - 1;
            for (let i = 1; i < sides.length; i++) {
                byPlace.set(i, await matchProfile(sides[0].rows, sides[i].rows, keyColumns, {
                    signal,
                    onProgress: p => this.post({ type: 'compare.progress', phase: 'Checking the match', done: (i - 1) * p.total + p.done, total: others * p.total }),
                }));
            }
            if (version === this.sidesVersion) this.profiles = { signature, byPlace };
        }
        return this.profiles.byPlace;
    }

    /** The key can be used: BL holds each value once at most, in every result's match (one to many is compared). */
    private async keyOk(keyColumns: string[]): Promise<boolean> {
        if (!keyColumns.length) return false;
        return [...(await this.profilesFor(keyColumns)).values()].every(p => keyCanCompare(p.counts));
    }

    /** Match: how the Baseline meets each other result on the key ticked (a check under way for older ticks stops). */
    private async match(keyColumns: string[]): Promise<void> {
        this.requireSides();
        this.matching?.abort();
        if (!keyColumns.length) {
            this.post({ type: 'compare.matchProfile', keyColumns, pairs: [], ok: false });
            return;
        }
        const matching = new AbortController();
        this.matching = matching;
        const profiles = await this.profilesFor(keyColumns, matching.signal);
        if (this.matching === matching) this.matching = undefined;
        this.post({
            type: 'compare.matchProfile',
            keyColumns,
            pairs: [...profiles].map(([place, p]) => ({ place, counts: p.counts, rowsBase: p.rowsBase, rowsOther: p.rowsOther, ...groupSizes(p) })),
            ok: await this.keyOk(keyColumns),
        });
    }

    /**
     * Match's drill-in: the records that share a repeated value of the key, from BL and the other
     * result, a page of values at a time. A value on thousands of records gets a short why instead.
     */
    private async matchGroup(message: { keyColumns: string[]; place: number; kind: MatchKind; index: number; alone?: boolean }): Promise<void> {
        this.requireSides();
        const { keyColumns, place, kind } = message;
        if (!MANY_KINDS.includes(kind) || !this.sides[place]) return;
        const profile = (await this.profilesFor(keyColumns)).get(place);
        if (!profile) return;
        const all = profile.groups.filter(g => g.kind === kind);
        if (!all.length) return;
        // One to many is what this solves: the values on both sides. A value the "one" side doesn't
        // have is missing as well as repeated, so it shows only when asked (or when there is nothing else)
        const paired = all.filter(g => g.base.length && g.other.length);
        const alone = !!message.alone || !paired.length;
        const groups = alone ? all : paired;
        const index = Math.max(0, Math.min(groups.length - 1, Math.floor(Number(message.index) || 0)));
        const base = this.sides[0];
        const other = this.sides[place];
        const sizes = all.map(x => x.base.length + x.other.length);
        const records = sizes.reduce((a, b) => a + b, 0);
        const most = Math.max(...sizes);
        if (most > GROUP_LOOK) {
            // Far from a key (a user id on every record): why, and its first keys with what each holds.
            // Its records are too many to look through, and no column is worked out
            this.post({
                type: 'compare.matchGroup', keyColumns, place, kind, index: 0, total: all.length, records, most, large: true,
                keys: all.slice(0, KEYS_LISTED).map(x => {
                    const row = x.base.length ? base.rows[x.base[0]] : other.rows[x.other[0]];
                    return { values: keyColumns.map(c => wire(row[c])), base: x.base.length, other: x.other.length };
                }),
            });
            return;
        }
        // A page of values, each with its records from BL (left) and the other result (right), at
        // most a few from each side
        const start = Math.floor(index / VALUES_SHOWN) * VALUES_SHOWN;
        const cells = (row: CompareRowData) => base.columns.map(c => wire(row[c.id]));
        this.post({
            type: 'compare.matchGroup',
            keyColumns,
            place,
            kind,
            index: start,
            total: groups.length,
            records,
            // The values the one side doesn't have, and whether they are listed
            lonely: all.length - paired.length,
            alone,
            columns: base.columns.map(c => ({ id: c.id, name: c.name, key: keyColumns.includes(c.id) })),
            values: groups.slice(start, start + VALUES_SHOWN).map(g => ({
                base: g.base.slice(0, GROUP_SHOWN).map(n => cells(base.rows[n])),
                other: g.other.slice(0, GROUP_SHOWN).map(n => cells(other.rows[n])),
                held: [g.base.length, g.other.length],
            })),
        });
    }

    private async run(setup: CompareSetup, visible?: number[]): Promise<void> {
        this.requireSides();
        if (!(await this.keyOk(setup.keyColumns))) throw new Error('BL has a value of the key on more than one record. Pick the columns again on Match.');
        this.spec = { keyColumns: setup.keyColumns, compareColumns: setup.compareColumns, relaxedColumns: setup.relaxedColumns };
        this.shownColumns = (setup.shownColumns ?? []).filter(c => !setup.keyColumns.includes(c) && !setup.compareColumns.includes(c));
        this.join = setup.join;
        const started = Date.now();
        await this.work();
        // Every result shown, unless kept from before a new Baseline
        this.visible = (visible ?? this.sides.map((_, i) => i)).filter(p => p > 0 && p < this.sides.length);
        const saved = this.compare?.setup;
        this.hidden = (setup.hiddenColumns ?? saved?.hiddenColumns ?? []).filter(c => setup.compareColumns.includes(c) || this.shownColumns.includes(c));
        this.buildLens(this.hidden);
        await this.remember(setup);
        this.ports.host.compared?.();
        this.postResult(Date.now() - started);
    }

    /** Measure every result against BL, the one compare Results read. */
    private async work(): Promise<void> {
        const spec = this.spec;
        if (!spec) throw new Error('Run the compare first.');
        this.running?.abort();
        const controller = new AbortController();
        this.running = controller;
        const across = await compareAcross(this.sides.map(s => s.rows), spec, 0, {
            signal: controller.signal,
            onProgress: p => this.post({ type: 'compare.progress', phase: 'Comparing', done: p.done, total: p.total }),
        });
        if (this.running === controller) this.running = undefined;
        this.across = across;
        this.filtered = undefined;
    }

    private postResult(ms: number): void {
        const setup = this.compare?.setup;
        this.post({
            type: 'compare.result',
            ...this.lensCounts(),
            hiddenColumns: this.hidden,
            columnOrder: setup?.columnOrder ?? [],
            columnWidths: setup?.columnWidths ?? {},
            sort: setup?.sort ?? null,
            join: this.join,
            rowCounts: this.sides.map(s => s.rows.length),
            ms,
        });
    }

    /**
     * One window of result rows for the grid: each row's Status, each result's values (the key,
     * then the compared columns shown, then those shown only) and, per compared column, which
     * results hold alike values.
     */
    private async rows(message: RowsRequest): Promise<void> {
        const lens = this.lens;
        if (!lens) return;
        const indices = await this.filteredIndices(message);
        // A newer search, or another compare, took over while this one ran: its own answer follows
        if (!indices || lens !== this.lens) return;
        const start = Math.max(0, Math.min(message.start, indices.length));
        const end = Math.min(indices.length, start + Math.max(0, Math.min(message.count, 500)));
        const cols = [...lens.result.spec.keyColumns, ...lens.columns, ...this.shownVisible()];
        const out = [];
        for (let i = start; i < end; i++) {
            const index = indices[i];
            out.push({
                index,
                status: lens.status(index),
                values: this.sides.map((_, p) => {
                    const r = lens.visible.includes(p) ? lens.result.record(index, p) : undefined;
                    return r ? cols.map(c => wire(r[c])) : null;
                }),
                groups: lens.groups(index),
                relation: lens.relation(index),
                repeated: lens.result.repeatedIn.get(index) ?? null,
            });
        }
        this.post({ type: 'compare.rowsPage', requestId: message.requestId, total: indices.length, start, columns: cols, rows: out });
    }

    /**
     * The rows the Status filter keeps that match the find, in the sort's order, cached between
     * window requests. The find gives way as it goes (a few thousand rows at a time), so typing
     * stays quick on a big compare, and stops when a newer search comes in (null: superseded).
     */
    private async filteredIndices(message: { filter: LensFilter; search: string; sort?: LensSort | null }): Promise<number[] | null> {
        const lens = this.lens!;
        const search = (message.search || '').trim();
        const filter = cleanFilter(message.filter);
        const sort = message.sort && [...lens.result.spec.keyColumns, ...lens.columns, ...this.shownVisible()].includes(message.sort.column) ? message.sort : null;
        const signature = `${this.lensVersion}|${JSON.stringify(filter)}|${search}|${JSON.stringify(sort)}`;
        if (this.filtered?.signature === signature) return this.filtered.indices;
        // The same search asked again while it runs (the next chunk of rows): wait for it
        if (this.filtering?.signature === signature) return this.filtering.promise;
        const seq = ++this.searchSeq;
        const promise = (async (): Promise<number[] | null> => {
            let indices: number[] | null = lens.indicesOf(filter);
            if (search) indices = await this.searchRows(indices, search, seq);
            if (!indices || seq !== this.searchSeq) return null;
            if (sort) indices = lens.sort(indices, sort);
            this.filtered = { signature, indices };
            return indices;
        })();
        this.filtering = { signature, promise };
        try {
            return await promise;
        } finally {
            if (this.filtering?.promise === promise) this.filtering = undefined;
        }
    }

    /** Save the setup and what this run found with the compare (the Hub's Compare list). */
    private async remember(setup: CompareSetup): Promise<void> {
        const compare = this.compare;
        const lens = this.fullLens;
        if (!compare || !lens) return;
        const before = compare.setup;
        this.compare = {
            ...compare,
            // Hidden columns, column order and sort are kept unless the page says otherwise
            setup: {
                ...setup,
                hiddenColumns: setup.hiddenColumns ?? before?.hiddenColumns ?? [],
                ...(setup.columnOrder ?? before?.columnOrder ? { columnOrder: setup.columnOrder ?? before?.columnOrder } : {}),
                ...(setup.columnWidths ?? before?.columnWidths ? { columnWidths: setup.columnWidths ?? before?.columnWidths } : {}),
                ...(setup.sort ?? before?.sort ? { sort: setup.sort ?? before?.sort } : {}),
            },
            comparedAt: new Date().toISOString(),
            // What it found with every result and column (the Hub list's line)
            counts: { changed: lens.counts.diff, missing: lens.counts.missing, same: lens.counts.same },
        };
        await saveCompare(this.ports.state, this.compare);
    }

    /** Export to Excel: the summary and the rows the screen shows, side by side, in the screen's order. */
    private async export(message: ExportRequest): Promise<void> {
        const lens = this.lens;
        if (!lens || !this.sides[0]) throw new Error('Run the compare first.');
        const files = this.ports.files;
        if (!files) throw new Error('This app cannot save files.');
        const indices = await this.filteredIndices(message);
        if (!indices) return;
        const endpoint = this.endpoint?.name ?? 'Endpoint';
        const names = message.names;
        const fileLabels = lens.visible.map(p => `${placeLetter(p)} ${names[p] ?? ''}`.trim());
        const target = await files.chooseSaveTarget(compareFileName(endpoint, fileLabels), { 'Excel Workbook': ['xlsx'] }, 'Export Compare to Excel');
        if (!target) {
            this.post({ type: 'compare.exported', cancelled: true });
            return;
        }
        const started = Date.now();
        const sheets = buildCompareSheets({
            lens, columns: this.sides[0].columns, indices, names, order: message.columnOrder, shown: this.shownVisible(),
            endpoint, view: this.viewName ?? '', filter: cleanFilter(message.filter), search: message.search,
        });
        const path = await new ConsoleExportService().exportToExcelMultiSheet(sheets, { includeHeaders: true, targetUri: target });
        this.ports.logger?.log(`[Compare] Excel export: ${indices.length} rows in ${Date.now() - started} ms`);
        await files.exported?.(path);
        this.ports.toast.info(`Saved ${path.split(/[\\/]/).pop()}`);
        this.post({ type: 'compare.exported', path });
    }

    /** The Console's find, over the shown results' values of the shown columns. */
    private async searchRows(indices: number[], search: string, seq: number): Promise<number[] | null> {
        const lens = this.lens!;
        const terms = parseSearchExpression(search);
        // Named as Results head them, so `@status=active` finds its column (Status and Relationship are Compare's own, not searched)
        const names = new Map(this.sides[0].columns.map(c => [c.id, c.name]));
        const cols = [...lens.result.spec.keyColumns, ...lens.columns, ...this.shownVisible()].map(id => ({ id, name: names.get(id) ?? id, type: 'string' }));
        // The results shown, read by row number (no differences worked out: 100,000 rows a keystroke)
        const rowsOf = (index: number): CompareRowData[] => lens.visible.map(p => lens.result.record(index, p)).filter((r): r is CompareRowData => !!r);
        const get = (r: Record<string, unknown>, id: string) => r[id];
        // A result row matches when any result's record does, each read on its own as the Console
        // reads a row: an exact find ("ITEM1") must meet the value itself, not two values joined
        const matches = (index: number) => rowsOf(index).some(record => {
            const flat: Record<string, string> = {};
            for (const c of cols) flat[c.id] = cell(record[c.id]);
            return matchesRow(terms, flat, cols, get);
        });
        const out: number[] = [];
        for (let start = 0; start < indices.length; start += SEARCH_CHUNK) {
            // Give way to the page (typing) between chunks; a newer search stops this one
            if (start) await new Promise(resolve => setTimeout(resolve, 0));
            if (seq !== this.searchSeq) return null;
            const end = Math.min(indices.length, start + SEARCH_CHUNK);
            for (let i = start; i < end; i++) if (matches(indices[i])) out.push(indices[i]);
        }
        return out;
    }

    /** Every View column of one result row, each result's values side by side, for the record panel. */
    private record(message: { index: number }): void {
        const spec = this.spec;
        const lens = this.lens;
        if (!spec || !lens || !this.sides[0]) return;
        const row = lens.result.row(message.index);
        const places = lens.visible;
        const rowsBy = places.map(p => row.rows[p].map(n => this.sides[p].rows[n]));
        const status = lens.status(message.index);
        const groups = lens.groups(message.index);
        const differs = new Set(lens.columns.filter((_, i) => new Set(places.map(p => groups[i][p]).filter(g => g >= 0)).size > 1));
        const key = new Set(spec.keyColumns);
        const compared = new Set(lens.columns);
        const shownOnly = new Set(this.shownVisible());
        const relaxed = new Set(spec.relaxedColumns ?? []);
        this.post({
            type: 'compare.recordDetail',
            index: message.index,
            status,
            places,
            fields: this.sides[0].columns.map(c => ({
                id: c.id,
                name: c.name,
                role: key.has(c.id) ? 'key' : compared.has(c.id) ? (relaxed.has(c.id) ? 'relaxed' : 'strict') : shownOnly.has(c.id) ? 'shown' : 'notCompared',
                differs: differs.has(c.id),
                values: rowsBy.map(rows => rows.map(r => wire(r[c.id]))),
                path: pathInRecord(c.id, this.rowBasis),
            })),
            // Each record exactly as its system sent it, for the JSON view
            raw: rowsBy.map(rows => rows.map(r => sentRecord(r, this.rowBasis))),
        });
    }
}

interface RowsRequest {
    requestId: number;
    filter: LensFilter;
    search: string;
    sort?: LensSort | null;
    start: number;
    count: number;
}

interface ExportRequest {
    filter: LensFilter;
    search: string;
    sort?: LensSort | null;
    /** What each result is called on screen, by place. */
    names: string[];
    /** The compared columns in the screen's order. */
    columnOrder?: string[];
}

/** How far down BL Match looks for a column's sample value. */
const SAMPLE_ROWS = 500;

/** Side by side or Compact: the one last used, on any compare. */
const RESULTS_VIEW_KEY = 'dbmn.compare.resultsView';

/** The Baseline is BL; the others are C1, C2, C3. */
export const letter = placeLetter;

/** The Status filter as the page sent it, made safe. */
function cleanFilter(filter: Partial<LensFilter> | undefined): LensFilter {
    return {
        same: !!filter?.same,
        diff: !!filter?.diff,
        missing: Array.isArray(filter?.missing) ? filter!.missing.map(Number).filter(p => Number.isInteger(p) && p >= 0 && p < 8) : [],
        columns: Array.isArray(filter?.columns) ? filter!.columns.filter((c): c is string => typeof c === 'string') : [],
        ...(Array.isArray(filter?.relations) ? { relations: filter!.relations.filter((r): r is Relation => RELATIONS.includes(r as Relation)) } : {}),
    };
}

/**
 * A row's record as its system sent it: the item at the View's row basis (with no row basis, the
 * response's body). The table builder keeps it on the row, out of sight of columns and exports.
 */
function sentRecord(row: CompareRowData, rowBasis: string): unknown {
    const record = (row as { __record?: unknown }).__record;
    if (rowBasis !== 'root') return record;
    return record && typeof record === 'object' ? (record as { data?: unknown }).data : undefined;
}

/** Where a View column sits inside the sent record ("sku", "items"); null: above it (a parent's field). */
function pathInRecord(columnId: string, rowBasis: string): string | null {
    const base = rowBasis === 'root' ? 'data' : rowBasis;
    return columnId.startsWith(`${base}.`) ? columnId.slice(base.length + 1) : null;
}

function cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** No saved View yet: the top-level fields of the first completed response, as the Console does. */
function rootView(responses: unknown[]): CompareView {
    const first = (responses.find(r => (r as { status?: string })?.status === 'completed') ?? responses[0]) as Record<string, unknown> | undefined;
    const data = first && typeof first === 'object' ? first : {};
    const columns = Object.keys(data)
        .filter(k => ['string', 'number', 'boolean'].includes(typeof data[k]))
        .map(id => ({ id, source: 'current' }));
    return { name: 'Root', rowBasis: 'root', columns };
}
