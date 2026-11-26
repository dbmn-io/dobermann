// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's host logic (hub/hub.js and its sections), shared by VS Code and the web app. Moved
 * from HubWebviewManager (#343). Owns the embedded tabs: their screens come from the host's
 * HubTabFactory, and their messages travel in the `__embeddedFromTab__` / `__embeddedToTab__`
 * envelopes hub-tabs.js speaks.
 */
import { freeReportName, REPORT_NAME_MAX, reportNameProblem } from '../../services/compare/report-name';
import { duplicateCompare, getCompare, removeCompare, saveCompare, savedCompares, type SavedCompare } from '../../services/compare/compare-store';
import { createQuery, duplicateQuery, getQuery, importQueryCopy, isQueryId, queryForSupport, listQueries, removeQuery, saveQuery, type SavedQuery } from '../../services/query/query-store';
import { loadQueryFolder } from '../../services/query/query-folder';
import { queryFromCompare } from '../../services/query/query-from-compare';
import { isDraft } from '../../services/compare/compare-store';
import { withRunHeaderSearch } from '../../services/compare/run-header-values';
import { validateShortIdentifier } from '../../data-loading/system-schema';
import type { Disposable } from '../../platform/events';
import type { ChainHandoff } from '../../services/chain/chain-types';
import { SystemOperationsService } from '../../services/systems/system-operations.service';
import { TagManagerService } from '../../services/tags/tag-manager.service';
import { promptNewSystemInModal } from '../new-system-prompt';
import { promptNewEnvironmentInModal, type NewEnvironmentDraft } from '../new-environment-prompt';
import type { ScreenSession } from '../screen-session';
import { BatchTab, HubPorts, HubTab, HubTabsSnapshot, LogsTab, LookupTab, SerializedHubTab, TabChannel } from './hub.ports';
import { isLookupId, LookupTablesStore } from '../../services/lookup-tables/lookup-tables';
import { askBeforeCancellingBatch } from '../console/batch-cancel';
import { askHowToResume } from '../console/batch-resume';
import { headerVariablesOf, headerVariablesPicking, type VariableBearer } from '../../services/environment/variable-options';

interface OpenTab {
    tab: HubTab;
    onReady?: () => void;
}

/** Settings the Hub's Settings section may write, and how to coerce each. */
const WRITABLE_SETTINGS: Record<string, 'boolean' | 'number' | 'number[]'> = {
    'execution.autoOpenConsoleOnCompletion': 'boolean',
    'execution.treatNetworkErrorsAsCritical': 'boolean',
    'execution.criticalErrorCodes': 'number[]',
    'execution.maxCsvRows': 'number',
    'ui.confirmTransactionDeletion': 'boolean',
    // Dobermann issue 7: how long and how much of the app's log is kept
    'logs.keepDays': 'number',
    'logs.mostMegabytes': 'number'
};

/**
 * The runs sent with every change of the Hub's state (several a second while a batch runs): the
 * newest. History asks for the rest (`historyAll`) when a search needs them, or Show all is
 * clicked, so a search always reaches every run.
 */
const TRANSACTION_LIMIT = 500;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (n: number, noun: string) => n === 1 ? `1 ${noun}` : `${n} ${noun}s`;

/** Issue #310: a bulk update skips what the manager refused, and says so. */
function describeSkipped(skipped: Array<{ id: string; name?: string; reason: string }>): string {
    if (!skipped.length) return '';
    const shown = skipped.slice(0, 3).map(s => `${s.name ?? s.id}: ${s.reason}`).join('; ');
    const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
    return ` Skipped ${skipped.length} — ${shown}${more}.`;
}

function splitTabId(tabId: string): [string, string] {
    const sep = tabId.indexOf(':');
    return sep < 0 ? [tabId, ''] : [tabId.slice(0, sep), tabId.slice(sep + 1)];
}

/** A name as kept: one line, no control characters, single spaces, no longer than `max`. */
function cleanName(text: string, max: number): string {
    return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export class HubController {
    private readonly tabs = new Map<string, OpenTab>();
    /** A draft tab's id (`endpoint:new-*`, `environment:new-*`) is fixed for its life; after a save, its item's id. */
    private readonly savedIdByTabId = new Map<string, string>();
    /** Per Console tab: progress for the strip's bar, mirrored from the Console's own messages. */
    private readonly tabProgress = new Map<string, { done: number; total: number; status?: string }>();
    /** Issue #312: the last setTabStatus per tab, for coalescing. */
    private readonly tabStatusPosted = new Map<string, { at: number; status?: string; total?: number }>();
    /** A count held back by the 250 ms window, posted when it ends (else the tab waits for the next message). */
    private readonly tabStatusTrailing = new Map<string, ReturnType<typeof setTimeout>>();
    /** The strip as the frontend last reported it, persisted when the Hub closes. */
    private lastTabsSnapshot: HubTabsSnapshot | null = null;
    /** True once this page has held a tab: until then an empty strip must not overwrite last
     *  session's, which Home is still offering to re-open (#348). */
    private sawTabsThisSession = false;
    private subscriptions: Disposable[] = [];
    private broadcasts = 0;
    private subscribed = false;
    private transactionsTimer?: ReturnType<typeof setTimeout>;
    /** Section to show once the page is ready (deep links, e.g. startup recovery → History). */
    private pendingSection?: string;
    /** Standalone editors closed by a swap: their close events don't reach the page. */
    private suppressEditorClosed = 0;
    private tagService?: TagManagerService;
    private systemOps?: SystemOperationsService;

    constructor(private readonly session: ScreenSession, private readonly ports: HubPorts) {}

    // ─── Lifecycle ─────────────────────────────────────────────────────

    /**
     * The Hub's page is up: state, live updates, then Home (#348). Home offers to re-open the
     * tabs from last time rather than reopening them by itself.
     */
    async onReady(): Promise<void> {
        await this.broadcastState();
        this.subscribe();
        this.announceStartupRecovery();
        if (this.pendingSection) {
            this.session.post({ type: 'navigateToSection', section: this.pendingSection });
            this.pendingSection = undefined;
        }
        this.postHomeInfo();
    }

    /** The Hub's page went away: keep the working set for next time, close the tabs. */
    async pageClosed(): Promise<void> {
        // A session that never held a tab leaves the previous one's in place, still on offer
        // from Home (#348)
        if (this.lastTabsSnapshot && this.sawTabsThisSession) {
            try {
                await this.ports.tabSnapshots?.save(this.lastTabsSnapshot);
            } catch {
                // Best effort: storage must never block closing
            }
        }
        this.sawTabsThisSession = false;
        this.lastTabsSnapshot = null;
        // Without this, reopening finds stale entries, "focuses" tabs the fresh page doesn't
        // have, and every restored tab shows an empty body.
        this.closeAllTabs();
    }

    dispose(): void {
        this.closeAllTabs();
        this.subscriptions.forEach(s => s.dispose());
        this.subscriptions = [];
        this.subscribed = false;
        if (this.transactionsTimer) clearTimeout(this.transactionsTimer);
    }

    navigateToSection(section: string): void {
        this.pendingSection = section;
        this.session.post({ type: 'navigateToSection', section });
    }

    // ─── Messages ──────────────────────────────────────────────────────

    async handle(msg: Record<string, unknown>): Promise<void> {
        const str = (key: string) => typeof msg[key] === 'string' ? msg[key] as string : undefined;
        const list = (key: string) => Array.isArray(msg[key]) ? msg[key] as string[] : [];
        switch (msg.type) {
            case 'ready':
                await this.onReady();
                break;
            case 'hubTabsSnapshot':
                this.lastTabsSnapshot = {
                    tabs: Array.isArray(msg.tabs) ? msg.tabs as SerializedHubTab[] : [],
                    activeTabId: (msg.activeTabId as string | null | undefined) ?? null
                };
                if (this.lastTabsSnapshot.tabs.length > 0) this.sawTabsThisSession = true;
                break;
            case 'reopenTabs':
                await this.restoreTabs();
                this.postHomeInfo();
                break;
            case 'runWorkbenchCommand':
                if (str('command')) this.ports.runWorkbenchCommand?.(str('command')!);
                break;
            case 'openEndpointAsTab':
                // No Recent touch: merely opening must not re-sort the catalogue. Save and run do.
                if (str('endpointId')) await this.openEndpointTab(str('endpointId')!, msg.preview === true);
                break;
            case 'closeEmbeddedTab':
                if (str('tabId')) this.closeTab(str('tabId')!);
                break;
            case '__embeddedFromTab__':
                await this.fromTab(str('tabId'), msg.payload as Record<string, unknown> | undefined);
                break;
            case 'runEndpoint':
                if (str('endpointId')) await this.runFromCatalogue(str('endpointId')!);
                break;
            case 'addEndpoint':
                // Each click its own draft; fromClipboard pastes once the tab is listening
                await this.openEndpointTab(`new-${Date.now()}`, false, { fromClipboard: msg.fromClipboard === true });
                break;
            case 'addEnvironment':
                await this.addEnvironment();
                break;
            case 'openEnvironmentAsTab':
                await this.openEnvironmentTab(str('environmentId'));
                break;
            case 'openBatchAsTab':
                if (str('endpointId')) await this.openBatchTab(str('endpointId')!);
                break;
            case 'renameReport': {
                // A report's name is its tab's: open, its own screen checks the name (unique, not too
                // long) and keeps it; not open (the Reporting list's Rename), it is renamed here, by the same check
                const compareId = str('compareId');
                if (compareId && isLookupId(compareId)) { await this.renameLookup(compareId, str('name') ?? ''); break; }
                const name = cleanName(str('name') ?? '', REPORT_NAME_MAX);
                const open = compareId ? this.tabs.get(`compare:${compareId}`) : undefined;
                if (compareId && open) {
                    await open.tab.handle({ type: isQueryId(compareId) ? 'query.rename' : 'compare.rename', name });
                    await this.broadcastState();
                } else if (compareId && name) await this.renameClosedReport(compareId, name);
                break;
            }
            case 'renameEndpoint':
                if (str('endpointId')) await this.renameEndpoint(str('endpointId')!, str('name') ?? '');
                break;
            case 'renameEnvironment':
                if (str('environmentId')) await this.renameEnvironment(str('environmentId')!, str('name') ?? '');
                break;
            case 'renameRun':
                if (str('id')) await this.renameRun(str('id')!, str('name') ?? '');
                break;
            case 'openDesignSystem':
                await this.openDesignTab();
                break;
            case 'openLogs':
                await this.openLogsTab(str('search'));
                break;
            case 'openCompare': {
                // #298: the Compare list's Open (Results) and Edit (its results dialog)
                const start = str('start');
                if (str('compareId')) await this.openCompareTab(str('compareId')!, start === 'edit' || start === 'match' ? start : 'results');
                break;
            }
            // Lookup tables (Reporting): a new one opens to be filled; Query's Translate values opens one by id
            case 'newLookup':
                // (its name and columns, from the New lookup table dialog; none from an older page: code and value)
                await this.newLookup(str('name') ?? 'Lookup table', Array.isArray(msg.columns) ? (msg.columns as unknown[]).map(String) : undefined);
                break;
            case 'openLookup':
            case 'lookup.open':
                if (str('id')) await this.openLookupTab(str('id')!);
                break;
            case 'duplicateLookup':
                if (str('id')) await this.duplicateLookup(str('id')!);
                break;
            case 'deleteLookup':
                if (str('id')) await this.deleteLookup(str('id')!);
                break;
            case 'newQuery': {
                // Reporting's New query: an empty query, opened on Views
                const state = this.ports.compares?.state();
                if (!state) break;
                const query = await createQuery(state);
                await this.broadcastState();
                await this.openCompareTab(query.id);
                break;
            }
            // A query copied out for support, and one pasted back in (query-store queryForSupport / importQueryCopy)
            case 'copyQuery': {
                const state = this.ports.compares?.state();
                const query = state && str('compareId') ? getQuery(state, str('compareId')!) : undefined;
                if (query) this.session.post({ type: 'queryCopy', name: query.name, text: JSON.stringify(queryForSupport(query), null, 2) });
                break;
            }
            case 'importQuery': {
                const state = this.ports.compares?.state();
                if (!state) break;
                const made = await importQueryCopy(state, String(msg.text ?? ''));
                if (!made.query) { this.ports.toast.warn(made.problem ?? 'The query could not be imported.'); break; }
                await this.broadcastState();
                await this.openCompareTab(made.query.id);
                break;
            }
            case 'duplicateCompare':
                if (str('compareId')) await this.duplicateCompare(str('compareId')!);
                break;
            case 'deleteCompares':
                // Select, then Delete: one after another, so each save sees the last
                if (Array.isArray(msg.compareIds)) for (const id of msg.compareIds) await this.deleteCompare(String(id));
                break;
            case 'deleteCompare':
                if (str('compareId')) await this.deleteCompare(str('compareId')!);
                break;
            case 'createSystem':
                await this.createSystem();
                break;
            case 'renameSystem':
                await this.renameSystem(str('systemId'), str('newName'));
                break;
            case 'deleteSystem':
                if (str('systemId')) await this.deleteSystem(str('systemId')!);
                break;
            case 'mergeSystem':
                // Issue #275: fold a System into another
                await this.mergeSystem(str('systemId'), str('targetSystemId'));
                break;
            case 'bulkUpdateEndpoints':
                // Select mode → Update. system: 'keep', '' (clear), '__new__' (ask for a name) or an id
                await this.bulkUpdateEndpoints(list('ids'), str('system') ?? 'keep', list('addTags'), list('removeTags'));
                break;
            case 'bulkExportEndpoints':
                await this.bulkExportEndpoints(list('ids'));
                break;
            case 'saveCatalogueToAccount':
                // #342: a catalogue kept on this computer, saved to the account after all
                await this.ports.catalogueStorage?.saveToAccount();
                await this.broadcastState();
                break;
            case 'removeCatalogueFromDevice':
                // #427: signed out, the account's catalogue off this computer
                await this.ports.catalogueStorage?.removeFromDevice?.();
                await this.broadcastState();
                break;
            case 'bulkDeleteEndpoints':
                await this.bulkDeleteEndpoints(list('ids'));
                break;
            case 'bulkDeleteTransactions':
                await this.deleteTransactions(list('ids'));
                break;
            case 'historyAll':
                // History searches every run, not only the newest sent with the state
                this.session.post({ type: 'historyAll', transactions: withRunHeaderSearch(
                    (await this.readHistory()) as never[], await this.ports.environments.getAllEnvironments() as never[], await this.ports.endpoints.getAllEndpoints() as never[]) });
                break;
            case 'searchTransactionContent':
                // #444: each typed word on its own (`terms`); `term` is the one-piece search from before
                await this.searchTransactions(list('terms').length ? list('terms') : [str('term') ?? ''].filter(Boolean),
                    list('ids'), typeof msg.requestId === 'number' ? msg.requestId : 0);
                break;
            case 'setEnvironmentVariable':
                // #424: the header picker set a variable (activating the environment if it isn't)
                await this.setEnvironmentVariable(str('environmentId') ?? '', str('name') ?? '', str('value') ?? '');
                break;
            case 'addVariableOption':
                // #424: the header's "Add" on a variable with typed options: asked for, added, picked
                await this.addVariableOption(str('environmentId') ?? '', str('name') ?? '');
                break;
            case 'setActiveEnvironment':
                await this.setActiveEnvironment(str('environmentId'));
                break;
            case 'requestCloseEditors':
                this.session.post({ type: 'closeEditorsResult', ok: await this.closeStandaloneEditors() });
                break;
            case 'openTransaction':
                if (str('id')) await this.openConsoleTab(str('id')!, msg.isBatch === true);
                break;
            case 'transactionAction':
                // Issue #314: the History list's right-click menu
                await this.transactionAction(str('action') ?? '', str('id') ?? '', msg.isBatch === true, str('status'));
                break;
            case 'importExportReady':
                await this.ports.sections?.importExport?.ready();
                break;
            case 'exportSelected':
            case 'uploadFile':
            case 'uploadPostmanFile':
            case 'postmanOptionsChanged':
            case 'confirmIncludeHeaders':
            case 'executeImport':
            case 'openLocation':
                await this.section('importExport', msg);
                break;
            case 'accountReady':
                await this.ports.sections?.account?.ready();
                break;
            case 'accountSectionShown':
                // Account's stats wait until the section is actually looked at
                await this.ports.sections?.account?.shown?.();
                break;
            case 'signIn':
            case 'signOut':
            case 'openPuppySchool':
            case 'refreshSession':
            case 'importFromFlexionTech':
            case 'dismissFlexionTechMigration':
            case 'openImportExport':
                await this.section('account', msg);
                break;
            case 'setHubPreferences':
                // The page mirrors its whole getState() object on every change; no rebroadcast
                await this.ports.preferences.set(msg.preferences);
                break;
            case 'setDbmnSetting':
                await this.setSetting(str('key'), msg.value);
                break;
            case 'openWorkspaceFolder':
                if (this.ports.workspace && !await this.ports.workspace.reveal()) {
                    this.ports.toast.warn('No DBMN workspace folder is set yet — use Change folder… first.');
                }
                break;
            case 'selectWorkspaceFolder':
                await this.ports.workspace?.choose();
                await this.broadcastState();
                break;
            case 'openTagManager':
                await this.pushTagManagerData();
                break;
            case 'tagRename':
                await this.tagOp('rename', () => this.tags().renameTag(str('from') ?? '', str('to') ?? ''));
                break;
            case 'tagMerge':
                await this.tagOp('merge', () => this.tags().mergeTags(list('sources'), str('target') ?? ''));
                break;
            case 'tagDelete':
                await this.tagOp('delete', () => this.tags().deleteTag(str('tag') ?? ''));
                break;
        }
    }

    private async section(name: 'account' | 'importExport', msg: Record<string, unknown>): Promise<void> {
        const section = this.ports.sections?.[name];
        if (section) {
            await section.handle(msg);
        } else {
            this.ports.toast.info(name === 'account' ? 'Account runs in DBMN for VS Code for now.' : 'Import and export run in DBMN for VS Code for now.');
        }
    }

    // ─── State ─────────────────────────────────────────────────────────

    /** Everything the Hub renders. Embedded in the page at first paint, and posted on every change. */
    async initialState(): Promise<Record<string, unknown>> {
        // Saved queries are in the workspace folder (query-folder): read in first. Then every old
        // saved compare is a query now: made once, as the Hub lists them (the old one is kept, not listed)
        const compareState = this.ports.compares?.state();
        if (compareState) {
            await loadQueryFolder().catch(error => console.warn('[Hub] could not read the Queries folder', error));
            await this.convertCompares(compareState);
        }
        const { endpoints: endpointStore, environments: environmentStore, systems: systemStore } = this.ports;
        const [endpoints, systems, environments, active, transactions] = await Promise.all([
            endpointStore.getAllEndpoints(),
            systemStore.getAllSystems(),
            environmentStore.getAllEnvironments(),
            environmentStore.getActiveEnvironment(),
            this.readHistory()
        ]);
        // #424: each environment with the variables its header shows, their values and options
        // (from the environments just read: asking the store per environment read them all again each time)
        const withHeaderVariables = environments.map(env => ({ ...env, headerVariables: headerVariablesOf(env) }));
        const settings = this.ports.settings;
        return {
            endpoints,
            recentEndpoints: this.ports.recent.list(),
            hubPreferences: this.ports.preferences.get(),
            systems,
            environments: withHeaderVariables,
            activeEnvironmentId: active?.id,
            activeSystemId: active?.systemId,
            // (each with its header values, read as Query reads them: @org=… and @headers~… in History, platform #477)
            transactions: withRunHeaderSearch(transactions.slice(0, TRANSACTION_LIMIT) as never[], environments as never[], endpoints as never[]),
            transactionsTotal: transactions.length,
            compares: this.ports.compares ? savedCompares(this.ports.compares.state()).filter(c => !listQueries(this.ports.compares!.state()).some(q => q.fromCompare === c.id)) : [],
            queries: this.ports.compares ? listQueries(this.ports.compares.state()) : [],
            // Lookup tables, kept with the queries: their names, columns and how many rows (Reporting's list)
            lookupTables: (await (await this.lookups())?.list()) ?? [],
            dbmnSettings: {
                autoOpenConsoleOnCompletion: settings.get('dbmn', 'execution.autoOpenConsoleOnCompletion', true),
                treatNetworkErrorsAsCritical: settings.get('dbmn', 'execution.treatNetworkErrorsAsCritical', true),
                criticalErrorCodes: settings.get('dbmn', 'execution.criticalErrorCodes', [401, 403]),
                maxCsvRows: settings.get('dbmn', 'execution.maxCsvRows', 100000),
                confirmTransactionDeletion: settings.get('dbmn', 'ui.confirmTransactionDeletion', true),
                logsKeepDays: settings.get('dbmn', 'logs.keepDays', 14),
                logsMostMegabytes: settings.get('dbmn', 'logs.mostMegabytes', 150),
                telemetryEnabled: settings.get('dbmn', 'telemetry.enabled', true)
            },
            workspaceInfo: this.ports.workspace?.info() ?? {},
            catalogueStorage: this.ports.catalogueStorage?.info() ?? null,
            // Signed out, the catalogue hides run controls: runs need a DBMN identity
            isSignedIn: this.ports.auth.isSignedIn(),
            // GitHub Issue #396: the header's "DBMN sign-in expired" warning
            dbmnSessionExpired: this.ports.auth.isSignedIn() && this.ports.auth.sessionExpired?.() === true
        };
    }

    /**
     * History's rows: the app's one list of runs (DatabaseAdapter.getAllTransactions), shared with Add
     * a view and the Console and read again only when the history changes (it was the costly part of
     * the Hub's state, measured 2026-11-16: ~70 ms for 3,000 runs, ~220 ms for 10,000). A refresh
     * that changes nothing in it (an environment switch, an endpoint saved) costs a look at a number.
     */
    private readHistory(): Promise<unknown[]> {
        const metadata = this.ports.executions?.metadata;
        if (!metadata) return Promise.resolve([]);
        // (the app's one list of runs, kept by the storage until the history changes: no copy here)
        return metadata.getAllTransactions().catch(() => []);
    }

    /**
     * Latest wins: refreshes overlap (sign-out refreshes for the auth change, then again when
     * the catalogue switches back to the device's, #342), and a slower, older one must not
     * post over a newer one.
     */
    async broadcastState(): Promise<void> {
        const broadcast = ++this.broadcasts;
        this.refreshQueryTabNames();
        const state = await this.initialState();
        if (broadcast === this.broadcasts) this.session.post({ type: 'hubState', ...state });
    }

    private subscribe(): void {
        if (this.subscribed) return;
        this.subscribed = true;
        const { endpoints, environments, systems, recent, auth, executions } = this.ports;
        const refresh = () => { void this.broadcastState(); };
        this.subscriptions.push(
            endpoints.onEndpointsChanged(() => {
                refresh();
                this.refreshTabNames();
                // Deleted or re-imported endpoints fall out of Recent
                void endpoints.getAllEndpoints().then(all => recent.prune(all.map(e => e.id))).catch(() => undefined);
            }),
            recent.onDidChange(refresh),
            systems.onSystemsChanged(refresh),
            // #281: Settings changed on another device (or signing in brought the account's)
            this.ports.settings.onDidChange?.(refresh) ?? { dispose: () => undefined },
            environments.onEnvironmentsChanged(() => {
                refresh();
                this.refreshTabNames();
            })
        );
        const closed = this.ports.onStandaloneEditorClosed?.(e => {
            if (this.suppressEditorClosed > 0) {
                this.suppressEditorClosed--;
                return;
            }
            this.session.post({ type: 'editorClosed', context: e.context, itemId: e.itemId });
        });
        if (closed) this.subscriptions.push(closed);
        const authChanged = auth.onChanged?.(refresh);
        if (authChanged) this.subscriptions.push(authChanged);
        // Batches fire many changes: rebroadcast at most every 250 ms while they come, and once
        // after the last. (Not 250 ms after the last: a running batch changes every few ms, so
        // History and the header's "2 paused" waited for everything to stop. Found 2026-11-12.)
        // (No disposable; the listener just posts to a page that may be gone.)
        executions?.metadata.onExecutionChanged.event(execution => {
            // A batch's request: nothing the Hub draws from its state changes with one (public issue 1). History, the
            // activity chip and the rail list runs, never a batch's requests, and a request never writes its batch's
            // row; a running batch's bar and its tab's "n/total" come from the Console's progress (setTabStatus). Each
            // request used to rebuild the whole state and re-read every run, four times a second for the whole batch
            if (execution?.executionType === 'batch_member') return;
            this.followRunName(execution);
            if (this.transactionsTimer) return;
            this.transactionsTimer = setTimeout(() => {
                this.transactionsTimer = undefined;
                void refresh();
            }, 250);
        });
    }

    /** The names open Console tabs were last given: a run's change renames its tab only when its name changed. */
    private readonly consoleTabNames = new Map<string, string>();

    /** A run renamed (#464: in place on its Console, or anywhere): its open Console tab says the new name. */
    private followRunName(execution: { id?: string; batchConfiguration?: { name?: string }; endpointName?: string; endpointPath?: string } | undefined): void {
        if (!execution?.id) return;
        const tabId = `console:${execution.id}`;
        if (!this.tabs.has(tabId)) return;
        const name = execution.batchConfiguration?.name?.trim() || execution.endpointName || execution.endpointPath;
        if (!name || this.consoleTabNames.get(tabId) === name) return;
        this.consoleTabNames.set(tabId, name);
        this.session.post({ type: 'embeddedTabName', tabId, name });
    }

    private announceStartupRecovery(): void {
        const recovery = this.ports.takeStartupRecovery?.();
        if (recovery) {
            this.session.post({ type: 'startupRecovery', message: recovery.message, batchIds: recovery.batchIds });
        }
    }

    // ─── Environments ──────────────────────────────────────────────────

    private async setEnvironmentVariable(environmentId: string, name: string, value: string): Promise<void> {
        const store = this.ports.environments;
        try {
            const env = await store.getEnvironment(environmentId);
            if (!env) return;
            this.showPicked(env, name, value);
            if ((await store.getActiveEnvironment())?.id !== env.id) {
                await store.setActiveEnvironment(env.id);
            }
            await store.setVariable(env.id, name, value);
            await this.broadcastState();
        } catch (error) {
            this.session.post({ type: 'setActiveEnvironmentError', error: message(error) });
            await this.broadcastState().catch(() => undefined);   // the header back to what is stored
        }
    }

    /**
     * The header shows a pick the moment it is made. Saving can take a while (with the catalogue
     * in the account it is a round trip to the server, James 2026-11-13: "painfully slow"), so
     * the Hub draws the new value first and the full state follows once it is saved.
     */
    private showPicked(env: VariableBearer & { id: string }, name: string, value: string, add?: { label?: string }): void {
        this.session.post({ type: 'headerVariablesPicked', environmentId: env.id, headerVariables: headerVariablesPicking(env, name, value, add) });
    }

    /** The header's "Add" for a variable: one dialog for the value and its label, then it is an option and the value. */
    private async addVariableOption(environmentId: string, name: string): Promise<void> {
        const store = this.ports.environments;
        try {
            const env = await store.getEnvironment(environmentId);
            if (!env) return;
            const answer = await this.session.showModal({
                title: `Add ${name}`,
                body: `A new ${name} for ${env.name}. It joins the options and becomes the value.`,
                fields: [
                    { id: 'value', type: 'text', label: 'Value', placeholder: 'What requests send, e.g. 840', value: '', autoFocus: true },
                    { id: 'label', type: 'text', label: 'Label (optional)', placeholder: 'What the list shows, e.g. Brisbane', value: '' }
                ],
                actions: [
                    { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                    { id: 'add', label: 'Add', variant: 'primary' }
                ],
                size: 'sm'
            });
            const value = (answer.fields.value ?? '').trim();
            if (answer.actionId !== 'add' || !value) return;
            const label = (answer.fields.label ?? '').trim() || undefined;
            this.showPicked(env, name, value, { label });
            if ((await store.getActiveEnvironment())?.id !== env.id) {
                await store.setActiveEnvironment(env.id);
            }
            await store.addVariableOption(env.id, name, value, label);
            await this.broadcastState();
        } catch (error) {
            this.session.post({ type: 'setActiveEnvironmentError', error: message(error) });
            await this.broadcastState().catch(() => undefined);   // the header back to what is stored
        }
    }

    /**
     * The header shows the new environment the moment it is picked; the full state follows once
     * it is saved. James, on 0.4.0 (2026-11-16): changing environment was "annoyingly SLOW",
     * about 5 s the first time and under 2 s after, with nothing on screen until it was done.
     */
    private async setActiveEnvironment(environmentId?: string): Promise<void> {
        if (!environmentId) return;
        const store = this.ports.environments;
        try {
            const env = await store.getEnvironment(environmentId);
            if (!env) return;
            this.session.post({ type: 'activeEnvironmentPicked', environmentId: env.id });
            await store.setActiveEnvironment(env.id);
            await this.broadcastState();
        } catch (error) {
            this.session.post({ type: 'setActiveEnvironmentError', error: message(error) });
            await this.broadcastState().catch(() => undefined);   // the header back to what is stored
        }
    }

    // ─── Systems ───────────────────────────────────────────────────────

    private async createSystem(): Promise<void> {
        try {
            const created = await promptNewSystemInModal(this.ports.systems, this.session);
            if (!created) return;
            await this.broadcastState();
            this.session.post({ type: 'systemCreated', systemId: created.id });
        } catch (error) {
            this.session.post({ type: 'createSystemError', error: message(error) });
        }
    }

    /** Rename in place: ids are stable, so everything linked keeps working. */
    private async renameSystem(systemId?: string, rawName?: string): Promise<void> {
        const newName = rawName?.trim().toLowerCase();
        if (!systemId || !newName) return;
        try {
            const others = (await this.ports.systems.getAllSystems()).filter(s => s.id !== systemId);
            const error = validateShortIdentifier(newName, { kind: 'System', existingNames: new Set(others.map(s => s.name.toLowerCase())) });
            if (error) {
                this.session.post({ type: 'renameSystemError', systemId, error });
                return;
            }
            await this.ports.systems.updateSystem(systemId, { name: newName });
            await this.broadcastState();
        } catch (error) {
            this.session.post({ type: 'renameSystemError', systemId, error: message(error) });
        }
    }

    /** Only an empty System: anything still linked must be reassigned first. */
    private async deleteSystem(systemId: string): Promise<void> {
        try {
            const system = await this.ports.systems.getSystem(systemId);
            if (!system) return;
            const endpoints = (await this.ports.endpoints.getAllEndpoints()).filter(e => e.systemId === systemId);
            const environments = (await this.ports.environments.getAllEnvironments()).filter(e => e.systemId === systemId);
            if (endpoints.length > 0 || environments.length > 0) {
                this.ports.toast.warn(`Cannot delete System "${system.name}": ${endpoints.length} endpoint(s) and ${environments.length} environment(s) still linked. Reassign them first, then retry.`);
                return;
            }
            if (!await this.ports.confirmDestructive({ title: 'Delete System?', body: `Delete empty System "${system.name}"?`, confirmLabel: 'Delete' })) return;
            await this.ports.systems.deleteSystem(systemId);
            await this.broadcastState();
            this.ports.toast.info(`System "${system.name}" deleted.`);
        } catch (error) {
            this.ports.toast.error(`Delete System failed: ${message(error)}`);
        }
    }

    private operations(): SystemOperationsService {
        this.systemOps ??= new SystemOperationsService(this.ports.systems, this.ports.endpoints, this.ports.environments);
        return this.systemOps;
    }

    /** Issue #275: move a System's endpoints and environments to another, then delete it. */
    private async mergeSystem(sourceId?: string, targetId?: string): Promise<void> {
        if (!sourceId || !targetId || sourceId === targetId) return;
        try {
            const [source, target] = await Promise.all([this.ports.systems.getSystem(sourceId), this.ports.systems.getSystem(targetId)]);
            if (!source || !target) {
                this.ports.toast.warn('Merge failed: one of the Systems no longer exists.');
                return;
            }
            const endpointCount = (await this.ports.endpoints.getAllEndpoints()).filter(e => e.systemId === sourceId).length;
            const envCount = (await this.ports.environments.getAllEnvironments()).filter(e => e.systemId === sourceId).length;
            const linked = [endpointCount ? plural(endpointCount, 'endpoint') : '', envCount ? plural(envCount, 'environment') : ''].filter(Boolean).join(' and ');
            const moves = linked ? `Move ${linked} to "${target.name}"` : 'Nothing is linked to it';
            if (!await this.ports.confirmDestructive({
                title: 'Merge Systems?',
                body: `Merge "${source.name}" into "${target.name}"? ${moves}, then delete "${source.name}". This can't be undone.`,
                confirmLabel: 'Merge'
            })) return;
            const summary = await this.operations().mergeSystems([sourceId], targetId);
            await this.broadcastState();
            this.ports.toast.info(`Merged "${source.name}" into "${target.name}" — reassigned ${plural(summary.endpointsTouched, 'endpoint')}`
                + (summary.environmentsTouched ? ` and ${plural(summary.environmentsTouched, 'environment')}` : '') + '.');
        } catch (error) {
            this.ports.toast.error(`Merge Systems failed: ${message(error)}`);
        }
    }

    // ─── Catalogue: Select mode ────────────────────────────────────────

    /** The modal was the confirmation; this applies it in one write and says what changed. */
    private async bulkUpdateEndpoints(ids: string[], system: string, addTags: string[], removeTags: string[]): Promise<void> {
        if (!ids.length) return;
        try {
            let systemId: string | null | undefined;
            let systemLabel = '';
            if (system === '__new__') {
                const created = await promptNewSystemInModal(this.ports.systems, this.session);
                if (!created) return;   // Cancelling the name cancels the update
                systemId = created.id;
                systemLabel = `new System "${created.name}"`;
            } else if (system === '') {
                systemId = null;
                systemLabel = 'System cleared';
            } else if (system !== 'keep') {
                systemId = system;
                systemLabel = `System "${(await this.ports.systems.getSystem(system))?.name ?? system}"`;
            }
            const { touched, skipped } = await this.operations().updateSelection(ids, { systemId, addTags, removeTags });
            await this.broadcastState();
            const what = [
                systemLabel,
                addTags.length ? `+${plural(addTags.length, 'tag')}` : '',
                removeTags.length ? `−${plural(removeTags.length, 'tag')}` : ''
            ].filter(Boolean).join(', ');
            this.ports.toast.info(touched === 0 && !skipped.length
                ? 'Nothing to update: the selection already matches.'
                : `Updated ${plural(touched, 'endpoint')}${what ? `: ${what}` : ''}.${describeSkipped(skipped)}`);
        } catch (error) {
            this.ports.toast.error(`Update failed: ${message(error)}`);
        }
    }

    private async bulkExportEndpoints(ids: string[]): Promise<void> {
        if (!ids.length) return;
        if (!this.ports.exportEndpoints) {
            this.ports.toast.info('Export runs in DBMN for VS Code for now.');
            return;
        }
        try {
            const result = await this.ports.exportEndpoints(ids);
            if (result.filePath) {
                this.ports.toast.info(`Exported ${plural(ids.length, 'endpoint')} to ${result.filePath}`);
            } else if (result.error && result.error !== 'Export cancelled by user') {
                this.ports.toast.error(`Export failed: ${result.error}`);
            }
        } catch (error) {
            this.ports.toast.error(`Export failed: ${message(error)}`);
        }
    }

    /**
     * Always confirmed, naming what goes. History is kept. One write; the change event
     * re-renders the catalogue and prunes Recent. Their editor and Run Batch tabs close.
     */
    private async bulkDeleteEndpoints(ids: string[]): Promise<void> {
        if (!ids.length) return;
        try {
            const names = (await this.ports.endpoints.getAllEndpoints()).filter(e => ids.includes(e.id)).map(e => e.name || e.path || e.id);
            if (!names.length) return;
            const shown = names.slice(0, 5).map(name => `• ${name}`).join('\n');
            const more = names.length > 5 ? `\n…and ${names.length - 5} more` : '';
            if (!await this.ports.confirmDestructive({
                title: names.length === 1 ? 'Delete endpoint?' : `Delete ${names.length} endpoints?`,
                body: `${shown}${more}\n\nTheir History is kept. This cannot be undone.`,
                confirmLabel: 'Delete'
            })) return;
            const { deleted } = await this.ports.endpoints.deleteEndpoints(ids);
            const gone = new Set(deleted.map(e => e.id));
            for (const tabId of [...this.tabs.keys()]) {
                const [kind, id] = splitTabId(tabId);
                const endpointId = kind === 'endpoint' ? (this.savedIdByTabId.get(tabId) ?? id) : kind === 'batch' ? id : undefined;
                if (endpointId && gone.has(endpointId)) this.closeTabFromHost(tabId);
            }
            this.ports.toast.info(deleted.length === 1 ? `Deleted "${deleted[0].name}".` : `Deleted ${deleted.length} endpoints.`);
        } catch (error) {
            this.ports.toast.error(`Delete failed: ${message(error)}`);
        }
    }

    // ─── Tags ──────────────────────────────────────────────────────────

    private tags(): TagManagerService {
        this.tagService ??= new TagManagerService(this.ports.endpoints);
        return this.tagService;
    }

    private async pushTagManagerData(): Promise<void> {
        this.session.post({ type: 'tagManagerData', tags: await this.tags().listTagCounts() });
    }

    private async tagOp(op: string, run: () => Promise<unknown>): Promise<void> {
        const summary = await run();
        await this.pushTagManagerData();
        this.session.post({ type: 'tagOpComplete', op, summary });
    }

    // ─── Settings ──────────────────────────────────────────────────────

    /** Only the settings the Hub shows: the page can't write anything else. */
    private async setSetting(key: string | undefined, value: unknown): Promise<void> {
        const kind = key ? WRITABLE_SETTINGS[key] : undefined;
        if (!key || !kind) return;
        let coerced: boolean | number | number[];
        if (kind === 'boolean') {
            coerced = !!value;
        } else if (kind === 'number') {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 1) return;
            coerced = Math.floor(n);
        } else {
            if (!Array.isArray(value)) return;
            coerced = value.map(Number).filter(n => Number.isFinite(n) && n >= 100 && n <= 599).map(Math.floor);
        }
        try {
            await this.ports.settings.update('dbmn', key, coerced);
        } catch (error) {
            this.session.post({ type: 'setDbmnSettingError', key, error: message(error) });
        }
    }

    // ─── Runs and History ──────────────────────────────────────────────

    /** Catalogue ▷ Run API: always one call (Run Batch is the row's other button). */
    private async runFromCatalogue(endpointId: string): Promise<void> {
        if (!await this.closeStandaloneEditors()) {
            // Cancelled at Save/Discard: the page reverts its optimistic row highlight
            this.session.post({ type: 'swapResult', ok: false, endpointId });
            return;
        }
        try {
            const endpoint = await this.ports.endpoints.getEndpoint(endpointId);
            if (!endpoint) throw new Error('Endpoint not found');
            await this.ports.runApi(endpoint);
            this.session.post({ type: 'swapResult', ok: true, endpointId });
        } catch (error) {
            this.session.post({ type: 'runEndpointError', endpointId, error: message(error) });
            this.session.post({ type: 'swapResult', ok: false, endpointId });
        }
    }

    private async closeStandaloneEditors(): Promise<boolean> {
        if (!this.ports.closeStandaloneEditors) return true;
        return this.ports.closeStandaloneEditors();
    }

    /** Issue #246: delete from History, confirmed unless the user turned that off. */
    private async deleteTransactions(ids: string[]): Promise<void> {
        if (!ids.length) return;
        const executions = this.ports.executions;
        if (!executions) {
            this.ports.toast.error('Cannot delete — execution service is not available.');
            return;
        }
        if (this.ports.settings.get('dbmn', 'ui.confirmTransactionDeletion', true)) {
            // Name a few, so the user sees what goes, not just a count
            const sample = await Promise.all(ids.slice(0, 3).map(id => executions.metadata.getExecution(id).catch(() => null)));
            const names = sample.filter(Boolean).map(e => (e as { endpointName?: string }).endpointName || 'transaction');
            const more = ids.length > sample.length ? ` and ${ids.length - sample.length} more` : '';
            const body = ids.length === 1
                ? `Delete transaction "${names[0] || ids[0]}"?`
                : `Delete ${ids.length} transactions (${names.join(', ')}${more})?`;
            if (!await this.ports.confirmDestructive({ title: 'Delete transactions?', body, confirmLabel: 'Delete' })) return;
        }
        try {
            // The storage count includes batch members; the user ticked ids.length rows
            await executions.metadata.deleteExecutions(ids);
            let closed = 0;
            for (const id of ids) {
                if (this.tabs.has(`console:${id}`)) {
                    this.closeTabFromHost(`console:${id}`);
                    closed++;
                } else if (executions.closeStandaloneConsole?.(id)) {
                    closed++;
                }
            }
            await this.broadcastState();
            this.ports.toast.info(`Deleted ${plural(ids.length, 'transaction')}${closed > 0 ? ` · closed ${plural(closed, 'open console')}` : ''}.`);
        } catch (error) {
            this.ports.toast.error(`Bulk delete failed: ${message(error)}`);
        }
    }

    /**
     * History's content search, word by word (#444: a run passes when each word is in its details
     * or its bodies). Issue #246: the page can't read bodies; answer even on failure so it never waits.
     */
    private async searchTransactions(terms: string[], ids: string[], requestId: number): Promise<void> {
        const matchedByTerm: Record<string, string[]> = {};
        if (terms.length > 0 && ids.length > 0 && this.ports.executions) {
            try {
                for (const term of terms) {
                    matchedByTerm[term] = await this.ports.executions.metadata.searchExecutionBodies(ids, term);
                }
            } catch (error) {
                this.ports.toast.warn(`Content search failed: ${message(error)}`);
            }
        }
        const matchedIds = Array.from(new Set(Object.values(matchedByTerm).flat()));
        this.session.post({ type: 'transactionContentSearchResult', matchedIds, matchedByTerm, requestId });
    }

    /** Issue #314: History's row actions, through the same engine paths as the Console footer. */
    private async transactionAction(action: string, id: string, isBatch: boolean, status?: string): Promise<void> {
        if (!id) return;
        const executions = this.ports.executions;
        try {
            switch (action) {
                case 'pause':
                    if (!executions) throw new Error('BatchExecutionEngine not available');
                    await executions.pause(id);
                    return;
                case 'resume': {
                    if (!executions) throw new Error('BatchExecutionEngine not available');
                    // #335: the Console's Resume question and steps, not a resume without asking
                    const choice = await askHowToResume(
                        await executions.metadata.getExecution(id),
                        await executions.metadata.getBatchMemberExecutions(id),
                        spec => this.session.showModal(spec));
                    if (!choice) return;
                    const refused = await executions.resumeRefused?.(id);
                    if (refused !== undefined) {
                        this.ports.toast.info(`Resume cancelled — sign in to "${refused}" and resume again.`);
                        return;
                    }
                    await this.openConsoleTab(id, true);
                    void executions.resume(id, choice).catch(error => this.ports.toast.error(`Resume failed: ${message(error)}`));
                    return;
                }
                case 'cancel': {
                    if (!executions) throw new Error('ExecutionService not available');
                    // #335: a running batch asks first, as the Console's Cancel does
                    const choice = isBatch ? await askBeforeCancellingBatch(status, spec => this.session.showModal(spec)) : 'cancel';
                    if (choice === 'pause') await executions.pause(id);
                    if (choice === 'cancel') await executions.cancel(id, isBatch);
                    return;
                }
                case 'delete':
                    await this.deleteTransactions([id]);
                    return;
                case 'reprocess':
                case 'rerun':
                case 'open':
                    // Their dialogs live in the Console
                    await this.openConsoleTab(id, isBatch);
                    return;
            }
        } catch (error) {
            this.ports.toast.error(`${action} failed: ${message(error)}`);
        }
    }

    // ─── Tabs ──────────────────────────────────────────────────────────

    /** The Hub's channel into one tab. Watches what the tab's screen says, for the strip. */
    private channel(tabId: string, watch?: (msg: Record<string, unknown>) => boolean): TabChannel {
        return {
            tabId,
            post: msg => {
                if (!this.tabs.has(tabId) && !this.opening.has(tabId)) return;
                if (watch && watch(msg) === false) return;
                this.session.post({ type: '__embeddedToTab__', tabId, payload: msg });
            },
            close: () => this.closeTabFromHost(tabId),
            showModal: spec => this.session.showModal(spec)
        };
    }

    /** Tabs being built: their screen may post before the tab is registered. */
    private readonly opening = new Set<string>();

    private async mount(tabId: string, build: (channel: TabChannel) => Promise<HubTab>, mountMessage: Record<string, unknown>, watch?: (msg: Record<string, unknown>) => boolean, onReady?: (tab: HubTab) => void): Promise<HubTab | undefined> {
        this.opening.add(tabId);
        try {
            const tab = await build(this.channel(tabId, watch));
            this.tabs.set(tabId, { tab, onReady: onReady ? () => onReady(tab) : tab.ready?.bind(tab) });
            this.session.post({ ...mountMessage, tabId, html: tab.html });
            return tab;
        } finally {
            this.opening.delete(tabId);
        }
    }

    private focus(tabId: string, refId?: string, name?: string): void {
        this.session.post({ type: 'focusEmbeddedTab', tabId, refId, name });
    }

    /** A message from a tab's page. Its close control means the tab, not a VS Code editor. */
    private async fromTab(tabId: string | undefined, payload: Record<string, unknown> | undefined): Promise<void> {
        if (!tabId || !payload) return;
        switch (payload.type) {
            // (A page's maximise control is hidden in a tab, and tabs are always full width: #349)
            case 'closeWebview':
                this.closeTabFromHost(tabId);
                return;
            case 'runWorkbenchCommand':
                if (typeof payload.command === 'string') this.ports.runWorkbenchCommand?.(payload.command);
                return;
            case 'duplicateEndpointAsTab':
                // A new tab from the source, leaving this one as it is
                if (typeof payload.sourceEndpointId === 'string') {
                    await this.openEndpointTab(`new-${Date.now()}`, false, { duplicateFromId: payload.sourceEndpointId });
                }
                return;
            case '__tabDirty__':
                this.session.post({ type: 'embeddedTabDirty', tabId, dirty: !!payload.dirty });
                return;
            case '__embeddedReady__': {
                const entry = this.tabs.get(tabId);
                const ready = entry?.onReady;
                if (entry) entry.onReady = undefined;
                try {
                    ready?.();
                } catch (error) {
                    console.error(`[Hub] onReady threw for ${tabId}`, error);
                }
                return;
            }
        }
        await this.tabs.get(tabId)?.tab.handle(payload);
    }

    /**
     * An endpoint editor in its own tab. Opening one already open focuses it, including a draft
     * tab since saved as that endpoint (its tabId still reads `endpoint:new-*`).
     */
    async openEndpointTab(endpointId: string, preview: boolean, options: { fromClipboard?: boolean; duplicateFromId?: string } = {}): Promise<void> {
        const tabId = `endpoint:${endpointId}`;
        const store = this.ports.endpoints;
        if (this.tabs.has(tabId)) {
            this.focus(tabId, endpointId, (await store.getEndpoint(endpointId))?.name || endpointId);
            return;
        }
        for (const [draftTabId, savedId] of this.savedIdByTabId) {
            if (savedId === endpointId && this.tabs.has(draftTabId)) {
                // The page looks tabs up by `${type}:${refId}`: the draft's refId, not the saved id
                this.focus(draftTabId, splitTabId(draftTabId)[1], (await store.getEndpoint(endpointId))?.name || endpointId);
                return;
            }
        }
        const endpoint = await store.getEndpoint(endpointId);
        let name = endpoint?.name;
        if (!name && options.duplicateFromId) {
            const source = await store.getEndpoint(options.duplicateFromId);
            name = source ? 'COPY ' + source.name : 'New Endpoint';
        }
        name ??= endpointId.startsWith('new-') ? 'New Endpoint' : endpointId;

        await this.mount(
            tabId,
            channel => this.ports.tabs.endpoint({ itemId: endpointId, duplicateFromId: options.duplicateFromId }, channel),
            { type: 'mountEmbeddedTab', tabType: 'endpoint', refId: endpointId, name, preview },
            msg => {
                if (msg.type === 'endpointDeleted') {
                    // Its endpoint is gone: close the tab rather than leave a dead editor
                    this.closeTabFromHost(tabId);
                    return false;
                }
                if (msg.type === 'endpointSaved') {
                    const savedId = (msg.endpoint as { id?: string } | undefined)?.id;
                    if (savedId) {
                        void this.ports.recent.touch(savedId);
                        if (endpointId.startsWith('new-')) {
                            this.savedIdByTabId.set(tabId, savedId);
                            this.refreshTabNames();
                        }
                    }
                }
                return true;
            },
            // New Endpoint from Clipboard: paste once the tab's page is listening
            options.fromClipboard ? tab => { void tab.handle({ type: 'pasteEndpointFromClipboard' }); } : undefined
        );
    }

    /**
     * #415: the System first, then the URL; then the editor, with both filled in. A URL an
     * environment already has offers that one instead, moved to the chosen System if asked.
     */
    async addEnvironment(): Promise<void> {
        try {
            const environments = await this.ports.environments.getAllEnvironments();
            const choice = await promptNewEnvironmentInModal(this.ports.systems, this.session, { environments });
            if (!choice) return;
            if ('openEnvironmentId' in choice) {
                if (choice.moveToSystemId) await this.ports.environments.updateEnvironment(choice.openEnvironmentId, { systemId: choice.moveToSystemId });
                await this.openEnvironmentTab(choice.openEnvironmentId);
                return;
            }
            await this.openEnvironmentTab(undefined, choice);
        } catch (error) {
            this.ports.toast.error(`Add Environment failed: ${message(error)}`);
        }
    }

    async openEnvironmentTab(environmentId?: string, draft?: NewEnvironmentDraft): Promise<void> {
        const refId = environmentId || `new-${Date.now()}`;
        const tabId = `environment:${refId}`;
        const env = environmentId ? await this.ports.environments.getEnvironment(environmentId) : undefined;
        const name = env?.name || 'New Environment';
        if (this.tabs.has(tabId)) {
            this.focus(tabId, refId, name);
            return;
        }
        // A new environment's tab, since saved as this one: focus it rather than open a second
        for (const [draftTabId, savedId] of this.savedIdByTabId) {
            if (environmentId && savedId === environmentId && draftTabId.startsWith('environment:') && this.tabs.has(draftTabId)) {
                this.focus(draftTabId, splitTabId(draftTabId)[1], name);
                return;
            }
        }
        await this.mount(
            tabId,
            channel => this.ports.tabs.environment({ itemId: environmentId, draft }, channel),
            { type: 'mountEmbeddedTab', tabType: 'environment', refId, name },
            msg => {
                if (msg.type === 'environmentDeleted') {
                    this.closeTabFromHost(tabId);
                    return false;
                }
                const savedId = msg.type === 'environmentSaved' ? (msg.environment as { id?: string } | undefined)?.id : undefined;
                if (savedId && !environmentId) {
                    this.savedIdByTabId.set(tabId, savedId);
                    this.refreshTabNames();
                }
                return true;
            }
        );
    }

    /** Run Batch for an endpoint (#418: a DBMN sign-in is not needed to run). */
    async openBatchTab(endpointId: string, chain?: ChainHandoff): Promise<void> {
        const tabId = `batch:${endpointId}`;
        const endpoint = await this.ports.endpoints.getEndpoint(endpointId);
        if (this.tabs.has(tabId)) {
            this.focus(tabId, endpointId, `Batch: ${endpoint?.name || endpointId}`);
            // GitHub Issue #247: chaining into an open Run Batch replaces what it holds: ask first
            const open = this.tabs.get(tabId)?.tab as BatchTab | undefined;
            if (chain && open?.applyChain) {
                const choice = await this.session.showModal({
                    title: 'Replace Run Batch data?',
                    body: `Run Batch for ${endpoint?.name || 'this endpoint'} is already open. Replace what it holds with the ${chain.rowCount.toLocaleString()} chained row${chain.rowCount === 1 ? '' : 's'}?`,
                    actions: [
                        { id: 'cancel', label: 'Keep it', variant: 'secondary' },
                        { id: 'replace', label: 'Replace', variant: 'primary' }
                    ],
                    dismissible: true,
                    size: 'sm'
                });
                if (choice.actionId === 'replace') open.applyChain(chain);
            }
            return;
        }
        if (!endpoint) {
            this.session.post({ type: 'runEndpointError', endpointId, error: 'Endpoint not found' });
            return;
        }
        const factory = this.ports.tabs.batch;
        if (!factory) {
            this.ports.toast.info('Run Batch runs in DBMN for VS Code for now.');
            return;
        }
        await this.mount(tabId, channel => factory({ endpoint, chain }, channel),
            { type: 'mountEmbeddedTab', tabType: 'batch', refId: endpointId, name: `Batch: ${endpoint.name}` });
    }

    /**
     * #298: a saved compare, one tab each. It opens on Select (Compare reads nothing until a
     * later step is asked for); an open tab is brought forward.
     */
    /** The design system's page, where the host offers it (a development build's header button). */
    async openDesignTab(): Promise<void> {
        const id = 'design:system';
        if (this.tabs.has(id)) {
            this.focus(id, 'system', 'Design system');
            return;
        }
        const factory = this.ports.tabs.design;
        if (!factory) return;
        await this.mount(id, channel => factory(channel), { type: 'mountEmbeddedTab', tabType: 'design', refId: 'system', name: 'Design system' });
    }

    /**
     * Dobermann issue 7: the Logs screen, one tab. Asked for again with a search (a toast's Show in
     * Logs), the open tab searches for it.
     */
    async openLogsTab(search?: string): Promise<void> {
        const id = 'logs:app';
        const open = this.tabs.get(id);
        if (open) {
            this.focus(id, 'app', 'Logs');
            if (search) (open.tab as LogsTab).search?.(search);
            return;
        }
        const factory = this.ports.tabs.logs;
        if (!factory) return;
        await this.mount(id, channel => factory({ search }, channel), { type: 'mountEmbeddedTab', tabType: 'logs', refId: 'app', name: 'Logs' });
    }

    // ─── Lookup tables (src/services/lookup-tables): kept with the saved queries ───

    /** Lookup tables: one file each in the workspace's Lookup Tables folder. */
    private async lookups(): Promise<LookupTablesStore | undefined> {
        const compares = this.ports.compares;
        if (!compares) return undefined;
        if (!compares.lookups) return new LookupTablesStore(compares.state());
        return new LookupTablesStore(compares.lookups);
    }

    /** A lookup table's tab: one per table, its name its title. Gone since: said so. */
    async openLookupTab(id: string): Promise<void> {
        const table = await (await this.lookups())?.get(id);
        if (!table) {
            this.ports.toast.warn('This lookup table has been deleted.');
            return;
        }
        const tabId = `lookup:${id}`;
        if (this.tabs.has(tabId)) {
            this.focus(tabId, id, table.name);
            return;
        }
        const factory = this.ports.tabs.lookup;
        if (!factory) return;
        const renamed = (name: string) => {
            this.session.post({ type: 'embeddedTabName', tabId, name });
            void this.broadcastState();
        };
        await this.mount(tabId, channel => factory({ id, name: table.name, renamed }, channel),
            { type: 'mountEmbeddedTab', tabType: 'lookup', refId: id, name: table.name });
    }

    /** Reporting's New lookup table: a key and a value column, opened to be filled. */
    private async newLookup(name: string, columns?: string[]): Promise<void> {
        const store = await this.lookups();
        if (!store) return;
        let table;
        try {
            table = await store.create(name, columns);
        } catch (error) {
            this.ports.toast.warn(error instanceof Error ? error.message : String(error));
            return;
        }
        await this.broadcastState();
        await this.openLookupTab(table.id);
    }

    private async renameLookup(id: string, raw: string): Promise<void> {
        const name = cleanName(raw, REPORT_NAME_MAX);
        if (!name) return;
        const open = this.tabs.get(`lookup:${id}`);
        if (open) {
            await (open.tab as LookupTab).rename?.(name);
            return;
        }
        try { await (await this.lookups())?.rename(id, name); }
        catch (error) { this.ports.toast.warn(message(error)); return; }
        await this.broadcastState();
    }

    private async duplicateLookup(id: string): Promise<void> {
        try {
            const copy = await (await this.lookups())?.duplicate(id);
            if (!copy) return;
            await this.broadcastState();
            await this.openLookupTab(copy.id);
        } catch (error) { this.ports.toast.warn(message(error)); }
    }

    /** Deleted (the list asked first): a query that uses it says it is missing and doesn't run. */
    private async deleteLookup(id: string): Promise<void> {
        await (await this.lookups())?.remove(id);
        if (this.tabs.has(`lookup:${id}`)) this.closeTabFromHost(`lookup:${id}`);
        await this.broadcastState();
    }

    async openCompareTab(compareId: string, start: 'results' | 'match' | 'edit' = 'results'): Promise<void> {
        const state = this.ports.compares?.state();
        // A query is a report too: it opens in the same kind of tab, on its own screen
        if (isQueryId(compareId)) {
            const query = state ? getQuery(state, compareId) : undefined;
            if (!query) {
                this.ports.toast.warn('This query is no longer saved.');
                return;
            }
            const id = `compare:${compareId}`;
            // What its conversion from an old compare could not keep: said once, as it first opens
            if (query.notice && state) {
                this.ports.toast.info(query.notice);
                delete query.notice;
                await saveQuery(state, query);
            }
            // Its tab is its icon and its name: the icon says it is a query
            const title = query.name;
            if (this.tabs.has(id)) {
                this.focus(id, compareId, title);
                await this.tabs.get(id)!.tab.handle({ type: 'query.start', start });
                return;
            }
            const queryFactory = this.ports.tabs.compare;
            if (!queryFactory) return;
            await this.mount(id, channel => queryFactory({ compareId, endpointName: query.name, start }, channel),
                { type: 'mountEmbeddedTab', tabType: 'compare', refId: compareId, name: title });
            await this.broadcastState();
            return;
        }
        const compare = state ? getCompare(state, compareId) : undefined;
        if (!compare) {
            this.ports.toast.warn('This compare is no longer saved.');
            return;
        }
        // An old saved compare opens as the query made from it (a reopened tab too), on Views, as every query does
        const made = state && !isDraft(compare) ? await this.queryOfCompare(state, compare) : undefined;
        if (made) { await this.openCompareTab(made.id, start); return; }
        // (one never finished, only its Baseline picked: there is nothing to make a query of)
        this.ports.toast.warn('This compare was never finished, so it can\'t open. Start a new one from the Console.');
    }

    /** Every old saved compare (past Select) not yet a query, made one (queryFromCompare). Nothing is removed. */
    private async convertCompares(state: NonNullable<ReturnType<NonNullable<HubPorts['compares']>['state']>>): Promise<void> {
        for (const compare of savedCompares(state)) await this.queryOfCompare(state, compare);
    }

    /** The query an old compare became, made now if it hasn't been. */
    private async queryOfCompare(state: NonNullable<ReturnType<NonNullable<HubPorts['compares']>['state']>>, compare: SavedCompare): Promise<SavedQuery | undefined> {
        const had = listQueries(state).find(q => q.fromCompare === compare.id);
        if (had) return had;
        if (!compare.sources.length) return undefined;
        try {
            const endpoint = await this.ports.endpoints.getEndpoint(compare.sources[0].endpointId).catch(() => undefined);
            const query = queryFromCompare(compare, endpoint ? { name: endpoint.name, method: endpoint.method, path: endpoint.path } : undefined);
            await saveQuery(state, query);
            return query;
        } catch (error) {
            // (left as it was: it still opens in the old screen)
            console.error(`[Hub] could not make a query of compare ${compare.id}`, error);
            return undefined;
        }
    }

    /** A copy of a saved compare, opened on its results dialog to change it. */
    private async duplicateCompare(compareId: string): Promise<void> {
        const state = this.ports.compares?.state();
        if (state && isQueryId(compareId)) {
            const query = await duplicateQuery(state, compareId);
            if (!query) return;
            await this.ports.compares?.queryFiles?.copy(compareId, query.id);
            await this.broadcastState();
            await this.openCompareTab(query.id);
            return;
        }
        const copy = state ? await duplicateCompare(state, compareId) : undefined;
        if (!copy) return;
        await this.broadcastState();
        await this.openCompareTab(copy.id, 'edit');
    }

    /**
     * Rename from the Hub's lists (the one Rename dialog, hub-tabs.js). The thing's own rules hold:
     * the managers refuse a name another endpoint (or environment in its folder) has, and say why.
     * Open in an editor with nothing unsaved, it is renamed and its editor's name follows
     * (renamedOpen → the tab's dbmnRenamed); with changes not saved, the Hub's list refuses before
     * asking (it knows which tabs are dirty), so an editor's own edits are never overwritten.
     */
    private openIn(kind: 'endpoint' | 'environment' | 'console', id: string): string | undefined {
        for (const tabId of this.tabs.keys()) {
            const [k, refId] = splitTabId(tabId);
            if (k === kind && (refId === id || this.savedIdByTabId.get(tabId) === id)) return tabId;
        }
        return undefined;
    }
    private async renameEndpoint(id: string, raw: string): Promise<void> {
        const name = cleanName(raw, 50);
        if (!name) return;
        try { await this.ports.endpoints.updateEndpoint(id, { name }); }
        catch (error) { this.ports.toast.warn(message(error)); return; }
        const tabId = this.openIn('endpoint', id);
        if (tabId) this.session.post({ type: 'renamedOpen', tabId, name });
    }
    private async renameEnvironment(id: string, raw: string): Promise<void> {
        const name = cleanName(raw, 50);
        if (!name) return;
        try { await this.ports.environments.updateEnvironment(id, { name }); }
        catch (error) { this.ports.toast.warn(message(error)); return; }
        const tabId = this.openIn('environment', id);
        if (tabId) this.session.post({ type: 'renamedOpen', tabId, name });
    }
    /** A batch run's own name (#445): History lists it by it; its endpoint's name stays its endpoint's. */
    private async renameRun(id: string, raw: string): Promise<void> {
        const name = cleanName(raw, 100);
        const metadata = this.ports.executions?.metadata;
        if (!name || !metadata?.updateExecution) return;
        if (this.openIn('console', id)) { this.ports.toast.info('Its Console is open: rename it on the Console, by its name.'); return; }
        try {
            const run = await metadata.getExecution(id);
            if (!run) return;
            await metadata.updateExecution(id, {
                batchConfiguration: { stopOnFirstError: false, errorTolerance: false, maxErrors: 0, ...run.batchConfiguration, name }
            });
            await this.broadcastState();
        } catch (error) { this.ports.toast.warn(message(error)); }
    }

    /** A report renamed from the Reporting list while no tab has it open. */
    private async renameClosedReport(compareId: string, name: string): Promise<void> {
        const state = this.ports.compares?.state();
        if (!state) return;
        const report = isQueryId(compareId) ? getQuery(state, compareId) : getCompare(state, compareId);
        if (!report || report.name === name) return;
        const problem = reportNameProblem(state, compareId, name);
        if (problem) { this.ports.toast.warn(problem); return; }
        report.name = name;
        if (isQueryId(compareId)) await saveQuery(state, report as SavedQuery);
        else await saveCompare(state, report as SavedCompare);
        await this.broadcastState();
    }

    /** Delete a saved compare (the list asked first). Its results stay in History. */
    private async deleteCompare(compareId: string): Promise<void> {
        // (the Reporting list's Delete, one or those selected, holds lookup tables too)
        if (isLookupId(compareId)) { await this.deleteLookup(compareId); return; }
        const state = this.ports.compares?.state();
        if (!state) return;
        if (isQueryId(compareId)) {
            await removeQuery(state, compareId);
            await this.ports.compares?.queryFiles?.remove(compareId);
        }
        else await removeCompare(state, compareId);
        if (this.tabs.has(`compare:${compareId}`)) this.closeTabFromHost(`compare:${compareId}`);
        await this.broadcastState();
    }

    /** A Console for one run. Its endpoint's Run Batch tab gives way to it. */
    /** `focus: false`: an open tab stays where it is (a queued batch starting on its own, #437). */
    async openConsoleTab(executionId: string, isBatch: boolean, focus = true): Promise<void> {
        const tabId = `console:${executionId}`;
        if (this.tabs.has(tabId)) {
            if (focus) this.focus(tabId, executionId);
            return;
        }
        const factory = this.ports.tabs.console;
        if (!factory) return;
        this.opening.add(tabId);
        try {
            const tab = await factory({ executionId, isBatch }, this.channel(tabId, msg => {
                this.peekProgress(tabId, msg);
                return true;
            }));
            // #470: the endpoint's Run Batch tab becomes the run's Console: the page puts the Console in its place (its
            // slot and whether it was the one shown) and drops the Run Batch page once the Console is drawn. One tab from
            // the file to the finished run; the Run Batch screen is gone (no way back to Review for a batch that started)
            const replaces = tab.endpointId && this.tabs.has(`batch:${tab.endpointId}`) ? `batch:${tab.endpointId}` : undefined;
            // (and it opens where Review was: the Requests tab, its search, scroll and pick, so the swap shows no jump)
            if (replaces) {
                const review = (this.tabs.get(replaces)?.tab as BatchTab | undefined)?.handoff?.();
                if (review) tab.carryOn?.(review);
            }
            this.tabs.set(tabId, { tab, onReady: tab.ready?.bind(tab) });
            if (tab.name) this.consoleTabNames.set(tabId, tab.name);
            this.session.post({
                type: 'mountEmbeddedTab',
                tabId,
                tabType: isBatch ? 'batchConsole' : 'console',
                refId: executionId,
                name: tab.name,
                status: tab.status,
                html: tab.html,
                ...(replaces ? { replaces } : {})
            });
            if (replaces) this.closeTab(replaces);
        } finally {
            this.opening.delete(tabId);
        }
    }

    /** Close from the host: the page drops the iframe, the tab's screen is disposed. */
    closeTabFromHost(tabId: string): void {
        this.session.post({ type: 'closeEmbeddedTabFromHost', tabId });
        this.closeTab(tabId);
    }

    /** The page has already dropped the iframe. */
    private closeTab(tabId: string): void {
        const entry = this.tabs.get(tabId);
        if (!entry) return;
        this.tabs.delete(tabId);
        this.savedIdByTabId.delete(tabId);
        this.tabProgress.delete(tabId);
        this.tabStatusPosted.delete(tabId);
        clearTimeout(this.tabStatusTrailing.get(tabId));
        this.tabStatusTrailing.delete(tabId);
        try {
            entry.tab.dispose();
        } catch {
            // A failing dispose must not keep the tab
        }
    }

    private closeAllTabs(): void {
        [...this.tabs.keys()].forEach(tabId => this.closeTab(tabId));
    }

    /** A query or compare renamed on its own screen: its tab says the new name. */
    private refreshQueryTabNames(): void {
        const state = this.ports.compares?.state();
        if (!state) return;
        for (const tabId of this.tabs.keys()) {
            const [kind, refId] = splitTabId(tabId);
            if (kind !== 'compare') continue;
            const name = isQueryId(refId) ? getQuery(state, refId)?.name : getCompare(state, refId)?.name;
            if (name) this.session.post({ type: 'embeddedTabName', tabId, name });
        }
    }

    /** After a save or rename, the strip shows current names (positive only: never back to "New"). */
    private refreshTabNames(): void {
        Promise.all([this.ports.endpoints.getAllEndpoints(), this.ports.environments.getAllEnvironments()]).then(([endpoints, envs]) => {
            for (const tabId of this.tabs.keys()) {
                const [kind, refId] = splitTabId(tabId);
                let name: string | undefined;
                if (kind === 'endpoint') {
                    name = endpoints.find(e => e.id === (this.savedIdByTabId.get(tabId) || refId))?.name;
                } else if (kind === 'environment') {
                    name = envs.find(e => e.id === (this.savedIdByTabId.get(tabId) || refId))?.name;
                } else if (kind === 'batch') {
                    const ep = endpoints.find(e => e.id === refId);
                    if (ep?.name) name = `Batch: ${ep.name}`;
                }
                // (a new one's tab, since saved: which it now is, so the Hub's lists know it is open there)
                const savedId = this.savedIdByTabId.get(tabId);
                if (name) this.session.post({ type: 'embeddedTabName', tabId, name, ...(savedId ? { savedId } : {}) });
            }
        }).catch(() => undefined);
    }

    /**
     * What Home shows besides hubState (#348): last session's tabs it can re-open, and the
     * "New in vX.Y.Z" summary. Sent on ready and after a re-open.
     */
    private postHomeInfo(): void {
        let snapshot: HubTabsSnapshot | undefined;
        try {
            snapshot = this.ports.tabSnapshots?.peek();
        } catch {
            snapshot = undefined;
        }
        const reopenable = (snapshot && Array.isArray(snapshot.tabs) ? snapshot.tabs : [])
            .filter(t => t && t.type && t.refId && !(t.type === 'endpoint' && t.refId.startsWith('new-')));
        let whatsNew = null;
        try {
            whatsNew = this.ports.whatsNew?.() ?? null;
        } catch {
            whatsNew = null;
        }
        this.session.post({
            type: 'hubHomeInfo',
            reopen: reopenable.length > 0 ? { count: reopenable.length, names: reopenable.map(t => t.name || t.refId) } : null,
            whatsNew
        });
    }

    /**
     * Reopen the strip as it was when the Hub last closed (Home's Re-open, #348). Edits in a page can't come back,
     * so drafts (`new-*`, nothing saved) are skipped, and lost unsaved work gets one warning.
     */
    private async restoreTabs(): Promise<void> {
        let snapshot: HubTabsSnapshot | undefined;
        try {
            snapshot = this.ports.tabSnapshots?.take();
        } catch {
            return;
        }
        if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return;
        let lostUnsaved = 0;
        const restored = new Set<string>();
        for (const t of snapshot.tabs) {
            if (!t?.type || !t.refId) continue;
            if (t.type === 'endpoint' && t.refId.startsWith('new-')) {
                if (t.dirty) lostUnsaved++;
                continue;
            }
            try {
                if (t.type === 'endpoint') await this.openEndpointTab(t.refId, false);
                else if (t.type === 'environment') await this.openEnvironmentTab(t.refId);
                else if (t.type === 'batch') await this.openBatchTab(t.refId);
                else if (t.type === 'compare') await this.openCompareTab(t.refId);
                else if (t.type === 'design') await this.openDesignTab();
                else if (t.type === 'logs') await this.openLogsTab();
                else if (t.type === 'lookup') await this.openLookupTab(t.refId);
                else if (t.type === 'console' || t.type === 'batchConsole') await this.openConsoleTab(t.refId, t.type === 'batchConsole');
                else if (t.type === 'page') {
                    // Hub-native page tabs (Settings, Account, Import/Export, #292): the page re-hosts the section
                    this.session.post({ type: 'openPageTab', page: t.refId, name: t.name });
                    if (t.refId === 'account') await this.ports.sections?.account?.shown?.();
                }
                restored.add(`${t.type}:${t.refId}`);
                if (t.dirty) lostUnsaved++;
            } catch {
                // Deleted since, or purged: the rest still come back
            }
        }
        // Focus only a tab that came back: focusing a missing one spawns an empty phantom
        if (snapshot.activeTabId && restored.has(snapshot.activeTabId)) {
            this.focus(snapshot.activeTabId);
        }
        if (lostUnsaved > 0) {
            const noun = lostUnsaved === 1 ? 'tab' : 'tabs';
            this.ports.toast.warn(`${lostUnsaved} ${noun} had unsaved changes when the Hub was closed — those edits couldn't be preserved. Save often to avoid losing work.`);
        }
    }

    /**
     * A Console tab's progress for the strip's bar and count. The engine's progress_update
     * carries no counts (members report one by one), so count them here. `done` only ever
     * rises (a stale zero snapshot mustn't reset it) and never passes the total.
     */
    private peekProgress(tabId: string, msg: Record<string, unknown>): void {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (!payload) return;
        const counter = this.tabProgress.get(tabId) || { done: 0, total: 0, status: undefined };
        let status: string | undefined;
        if (msg.type === 'progress_update') {
            status = payload.status as string | undefined;
            // A reopened Console seeds current/total for a batch already under way
            if (typeof payload.current === 'number' && payload.current > counter.done) counter.done = payload.current;
            if (typeof payload.total === 'number' && payload.total > 0) counter.total = payload.total;
        } else if (msg.type === 'status_update') {
            status = payload.status as string | undefined;
            const p = payload.progress as { completed?: number; total?: number } | undefined;
            if (typeof p?.completed === 'number' && p.completed > counter.done) counter.done = p.completed;
            if (typeof p?.total === 'number' && p.total > 0) counter.total = p.total;
        } else if (msg.type === 'batch_member_result_update') {
            counter.done += 1;
            if (typeof payload.totalMembers === 'number' && payload.totalMembers > 0) counter.total = payload.totalMembers;
        } else {
            return;
        }
        if (counter.total > 0 && counter.done > counter.total) counter.done = counter.total;

        // A steady status: a page of a paginated fetch-all completing mustn't blank the bar
        if (status) {
            const lower = status.toLowerCase();
            const moreWork = counter.total > 0 && counter.done < counter.total;
            if (lower === 'paused' || lower === 'stopped' || lower === 'cancelled') {
                counter.status = lower === 'cancelled' ? 'stopped' : lower;
            } else if (lower === 'running') {
                counter.status = 'running';
            } else if (lower === 'completed' || lower === 'done') {
                counter.status = moreWork ? 'running' : 'completed';
            } else if (lower === 'error' || lower === 'failed') {
                // #438: the run ended in error, as the Console footer shows it; the tab follows
                counter.status = 'failed';
            } else if (lower === 'partial') {
                counter.status = 'partial';
            } else {
                counter.status = counter.status || lower;
            }
        }
        this.tabProgress.set(tabId, counter);
        const { done, total } = counter;
        if (!counter.status && done === 0 && total === 0) return;

        // Issue #312: at most one post per 250 ms, unless the status or the total changed or the run finished. A count
        // held back is posted when the window ends: a new run's first count (Fetch all on a Run API's tab: 1 of 10
        // after its 1 of 1) was otherwise held until the next page, a second later, the tab showing 100% (2026-11-26)
        const now = Date.now();
        const last = this.tabStatusPosted.get(tabId);
        const finished = total > 0 && done >= total;
        if (last && last.status === counter.status && last.total === total && !finished && now - last.at < 250) {
            if (!this.tabStatusTrailing.has(tabId)) {
                this.tabStatusTrailing.set(tabId, setTimeout(() => {
                    this.tabStatusTrailing.delete(tabId);
                    const latest = this.tabProgress.get(tabId);
                    if (latest) this.postTabStatus(tabId, latest);
                }, 250 - (now - last.at)));
            }
            return;
        }
        this.postTabStatus(tabId, counter);
    }

    private postTabStatus(tabId: string, counter: { done: number; total: number; status?: string }): void {
        clearTimeout(this.tabStatusTrailing.get(tabId));
        this.tabStatusTrailing.delete(tabId);
        const { done, total } = counter;
        this.tabStatusPosted.set(tabId, { at: Date.now(), status: counter.status, total });
        this.session.post({ type: 'setTabStatus', tabId, status: counter.status, progress: { done, total } });
    }
}

