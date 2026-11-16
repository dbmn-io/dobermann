// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { DATA_DIR } from '../../services/workspace/workspace-layout';
import { getBackend, devBackendMarkup } from '../../services/dbmn-backend/backend-config';
import { ChainHandoff } from '../../services/chain/chain-types';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { summariseChangelog, whatsNewBaseline, WhatsNew, WhatsNewBaseline } from '../../services/release-notes/whats-new';
import { WebviewBase, IEmbeddedPanelBridge } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { confirmDestructive, DbmnModalSpec } from '../../services/ui/dbmn-prompts';
import { ToastDelivery, ToastPayload, TOAST_TARGETS_KEY, IToastService } from '../../services/notifications/toast.interface';
import { APIEndpointManager } from '../../apiEndpointManager';
import { RecentEndpointsService } from '../../services/recent-endpoints/recent-endpoints.service';
import { HubPreferencesService } from '../../services/hub-preferences/hub-preferences.service';
import { EnvironmentManager } from '../../environmentManager';
import { SystemManager } from '../../systemManager';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { StartupRecoveryService, StartupRecoverySummary } from '../../services/execution/startup-recovery.service';
import { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { ImportExportWebviewManager } from '../import-export/import-export-manager';
import { AccountWebviewManager } from '../account/account-manager';
import { EndpointWebviewManager } from '../endpoint/endpoint-manager';
import { EnvironmentWebviewManager } from '../environment/environment-manager';
import { CompareWebview, compareStateStore } from '../compare/compare-webview';
import { RunBatchWebview } from '../run-batch/run-batch-webview';
import { ConsoleWebviewManager } from '../console/console-webview-manager';
import { ConsoleController } from '../../screens/console/console.controller';
import { applyResumeChoice } from '../../screens/console/batch-resume';
import { buildConsoleReportConfig } from '../../screens/console/console-report-config';
import { UIServiceTokens } from '../../container/ui-services-registry';
import { IBatchExecutionEngine } from '../../services/execution/batch-execution-engine.interface';
import { IEnvironmentAuthGate } from '../../services/environment/environment-auth-gate.service';
import { IDbmnAuthService, IDbmnTelemetry } from '../../services/dbmn-auth/dbmn-auth.interface';
import { IImportExportService } from '../../services/import-export/import-export.service.interface';
import { getDobermannWorkspaceFolder } from '../../utils/workspace-helper';
import { dbmnSettings } from '../../platform/vscode/vscode-settings';
import { HubController } from '../../screens/hub/hub.controller';
import type { VsCodeCatalogue } from '../../platform/vscode/vscode-catalogue';
import { HubExecutions, HubPorts, HubSection, HubTab, HubTabFactory, HubTabsSnapshot, TabChannel } from '../../screens/hub/hub.ports';
import { buildHubPage } from '../../screens/pages';
import { bundledCommit } from '../../utils/version-label';
import { normaliseThemeChoice, resolveTheme, themeMenu, type ThemeHost } from '../../services/theme/theme-choice';
import type { ThemeTokens } from '../../services/theme/omarchy-vscode-theme';

const HUB_TABS_SNAPSHOT_KEY = 'dbmn.hub.tabsSnapshot.v1';
/** Where Home's "What's new" starts for the installed version (Issue #348). */
const WHATS_NEW_BASELINE_KEY = 'dbmn.home.whatsNewBaseline.v1';
/** DBMN's theme in this VS Code (the picker in the Hub header), and whether its hint is done. */
const THEME_KEY = 'dbmn.theme';
const THEME_HINT_KEY = 'dbmn.theme.hintDone';

/** Workbench chords the Hub's frames may ask VS Code to run (they don't reach the keybinding
 *  service from a webview). Only these, so the message can't trigger arbitrary commands. Keep
 *  in sync with CHORD_MAP in hub.js / hub-tabs.js. */
const WORKBENCH_COMMAND_ALLOWLIST = new Set<string>([
    'workbench.action.showCommands',
    'workbench.action.quickOpen',
    'workbench.action.files.newUntitledFile',
    'workbench.action.files.openFile',
    'workbench.action.toggleSidebarVisibility',
    'workbench.action.togglePanel',
    'workbench.action.terminal.toggleTerminal',
    'workbench.action.openSettings',
    'workbench.view.explorer',
    'workbench.action.findInFiles',
    'workbench.view.scm',
    'workbench.view.extensions',
    'workbench.view.debug'
]);

/** A tab's manager talks to its "panel"; the bridge carries that through the Hub's channel. */
class HubEmbeddedBridge implements IEmbeddedPanelBridge {
    private disposeHandlers: Array<() => void> = [];
    private disposed = false;

    constructor(public readonly hostWebview: vscode.Webview, private readonly channel: TabChannel) {}

    get tabId(): string {
        return this.channel.tabId;
    }

    postBack(message: unknown): void {
        if (!this.disposed) this.channel.post(message as Record<string, unknown>);
    }

    onDispose(handler: () => void): void {
        if (this.disposed) {
            handler();
            return;
        }
        this.disposeHandlers.push(handler);
    }

    fireDispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const handler of this.disposeHandlers.splice(0)) {
            try { handler(); } catch { /* swallow */ }
        }
    }

    requestClose(): void {
        if (!this.disposed) this.channel.close();
    }
}

/** The parts of Dobermann the Hub reaches for (not the class itself: no import cycle). */
interface IDobermannLike {
    serviceContainer?: IServiceContainer;
    environmentWebview?: {
        checkForUnsavedChanges(): Promise<boolean>;
        showUnsavedChangesDialog(): Promise<'save' | 'discard' | 'cancel'>;
        saveCurrentContext(): Promise<boolean>;
        dispose(): void;
    };
    endpointWebview?: {
        checkForUnsavedChanges(): Promise<boolean>;
        showUnsavedChangesDialog(): Promise<'save' | 'discard' | 'cancel'>;
        saveCurrentContext(): Promise<boolean>;
        dispose(): void;
    };
    onEditorClosed?: vscode.Event<{ context: string; itemId?: string }>;
    /** Issue #313: what startup recovery did; shown once, then cleared. */
    startupRecovery?: StartupRecoverySummary;
}

/**
 * The DBMN Hub in VS Code: the panel, running the shared HubController with VS Code's
 * services as its ports. Tabs are the VS Code managers, embedded through a bridge.
 */
export class HubWebviewManager extends WebviewBase {
    private readonly controller: HubController;
    private importExportDelegate?: ImportExportWebviewManager;
    private accountDelegate?: AccountWebviewManager;
    private pageClosedAttached = false;
    private toastTarget?: ToastDelivery;
    private toastViewStateSub?: vscode.Disposable;

    constructor(
        context: vscode.ExtensionContext,
        private readonly endpointManager: APIEndpointManager,
        private readonly environmentManager: EnvironmentManager,
        private readonly systemManager: SystemManager,
        private readonly dobermannInstance?: IDobermannLike
    ) {
        super(context);
        this.controller = new HubController(this.session, this.ports());
    }

    private catalogue(): Pick<VsCodeCatalogue, 'storage' | 'saveToAccount' | 'removeFromDevice'> | undefined {
        return (globalThis as Record<string, unknown>).dbmnCatalogue as VsCodeCatalogue | undefined;
    }

    /** The global toast service (extension.ts), or a fresh one in early activation. */
    private get toastService(): IToastService {
        return ((globalThis as Record<string, unknown>).dbmnToastService as IToastService | undefined)
            ?? new (require('../../services/notifications/vscode-toast.service').VSCodeToastService)();
    }

    private get authService(): IDbmnAuthService | undefined {
        return (globalThis as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
    }

    getWebviewType(): string {
        return 'hub';
    }

    protected getWebviewTitle(_config: WebviewConfig): string {
        return 'DBMN Hub';
    }

    /** Switch section (catalogue / transactions / …), now and after the next `ready`. */
    navigateToSection(section: string): void {
        this.controller.navigateToSection(section);
    }

    /** True when the Hub panel exists: `dbmn.openHub` then skips reloading its HTML. */
    isMounted(): boolean {
        return !!this.panel;
    }

    /** `preserveFocus` for background pre-creation, so the user's editor keeps focus. */
    revealPanel(preserveFocus = false): void {
        this.panel?.reveal(undefined, preserveFocus);
    }

    /** Ctrl/Cmd+W: close the active tab (dirty-aware), not the Hub itself. */
    requestCloseActiveTab(): void {
        this.panel?.webview.postMessage({ type: 'closeActiveTabFromHost' });
    }

    async openEnvironmentAsTab(environmentId?: string): Promise<void> {
        await this.ensurePanel();
        await this.controller.openEnvironmentTab(environmentId);
    }
    /** An endpoint from elsewhere (the Console's Settings tab, the palette): its editor tab. */
    async openEndpointAsTab(endpointId: string): Promise<void> {
        await this.ensurePanel();
        await this.controller.openEndpointTab(endpointId, false);
    }

    /** #415: Add Environment from the palette: the New environment dialog, then the editor. */
    async addEnvironment(): Promise<void> {
        await this.controller.addEnvironment();
    }

    /** Run Batch from elsewhere (the editor's button, the palette). */
    async openBatchTab(endpointId: string, chain?: ChainHandoff): Promise<void> {
        await this.ensurePanel();
        await this.controller.openBatchTab(endpointId, chain);
    }

    /** A compare started in a Console (#298): its tab opens on Match. */
    async openCompareTab(compareId: string): Promise<void> {
        await this.ensurePanel();
        await this.controller.openCompareTab(compareId, 'match');
    }

    /** A Console from elsewhere (progress adapter, execution engines). */
    async openConsoleTab(executionId: string, isBatch: boolean, focus = true): Promise<void> {
        await this.ensurePanel();
        await this.controller.openConsoleTab(executionId, isBatch, focus);
    }

    private async ensurePanel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
        } else {
            await this.createWebview({ context: 'hub' });
        }
    }

    /** Parsed once per extension run; the bundled changelog never changes. */
    private whatsNewCache: WhatsNew | null | undefined;

    /** Home's "New in vX.Y.Z" (Issue #348): everything since the version this install ran
     *  before, so an upgrade that skips a release still hears about it. */
    private whatsNew(): WhatsNew | null {
        if (this.whatsNewCache !== undefined) return this.whatsNewCache;
        try {
            const version: string = this.context.extension?.packageJSON?.version ?? '';
            if (!version) return (this.whatsNewCache = null);
            const baseline = whatsNewBaseline(
                this.context.globalState.get<WhatsNewBaseline>(WHATS_NEW_BASELINE_KEY), version);
            void this.context.globalState.update(WHATS_NEW_BASELINE_KEY, baseline);
            const text = fs.readFileSync(path.join(this.context.extensionPath, 'CHANGELOG.md'), 'utf8');
            this.whatsNewCache = summariseChangelog(text, version, baseline.since);
        } catch {
            this.whatsNewCache = null;
        }
        return this.whatsNewCache;
    }

    async getHtmlContent(_config: WebviewConfig): Promise<string> {
        let state: Record<string, unknown> | undefined;
        try {
            state = await this.controller.initialState();
        } catch {
            // The ready → hubState broadcast fills it shortly after first paint
        }
        const page = buildHubPage(this.loadTemplate('hub.html'), rel => this.getWebviewUri(rel).toString(), state, devBackendMarkup(getBackend()),
            this.context.extension?.packageJSON?.version, bundledCommit());
        // #372: each tab's first script, as text for hub-tabs.js to put inline. A tab's frame here
        // can't fetch webview-resource URLs (the reason webview-base inlines every screen's
        // scripts); the web app's tabs load it as a file, which its CSP needs. Not run here
        // (type="text/plain").
        const tabFrame = this.loadTemplate('tab-frame.js').replace(/<\/script/gi, '<\\/script');
        return page.replace('</body>', () => `<script type="text/plain" id="dbmn-tab-frame-source">${tabFrame}</script>\n</body>`);
    }

    /** VS Code's own colours as the Hub reads them (hub.js), for Follow system's card. */
    private editorTheme: NonNullable<ThemeHost['editor']> = { tokens: {}, dark: true };

    /**
     * The theme picker, as the web and desktop apps have it, with Follow system meaning VS Code's
     * theme. A pick colours DBMN's panels (the Hub, its tabs, the Console), not the rest of VS Code.
     * The pick is this installation's (globalState), as a device's is elsewhere.
     */
    private offerThemes(): void {
        const stored = this.context.globalState.get<string>(THEME_KEY);
        const choice = normaliseThemeChoice({ theme: stored });
        const host: ThemeHost = { systemDark: this.editorTheme.dark, editor: this.editorTheme };
        void this.panel?.webview.postMessage({
            type: 'themeOptions',
            ...themeMenu(choice, host),
            editorTheme: true,
            applied: resolveTheme(choice, host) ?? null,
            hint: !this.context.globalState.get<boolean>(THEME_HINT_KEY) && stored === undefined
        });
    }

    /** The picker's messages; true when it was one. */
    private async handleThemeMessage(message: WebviewMessage): Promise<boolean> {
        const payload = message as unknown as Record<string, unknown>;
        if (message.type === 'setTheme') {
            await this.context.globalState.update(THEME_KEY, normaliseThemeChoice({ theme: String(payload.id ?? '') }).theme);
            await this.context.globalState.update(THEME_HINT_KEY, true);
            this.offerThemes();
            return true;
        }
        if (message.type === 'themeHintDone') {
            await this.context.globalState.update(THEME_HINT_KEY, true);
            return true;
        }
        if (message.type === 'editorTheme') {
            const tokens: ThemeTokens = {};
            const given = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens as Record<string, unknown> : {};
            for (const [name, value] of Object.entries(given)) {
                if (/^--vscode-[\w-]+$/.test(name) && typeof value === 'string') tokens[name] = value;
            }
            this.editorTheme = { tokens, dark: payload.dark !== false };
            this.offerThemes();
            return true;
        }
        return message.type === 'setSystemTheme';   // VS Code says which theme: nothing to pick
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        if (await this.handleThemeMessage(message)) return;
        if (message.type === 'ready') {
            this.offerThemes();
            this.registerGlobalBridge();
            // The DbmnToast listener exists now: replay host toasts queued while hidden
            this.flushPendingToasts();
            if (this.panel && !this.pageClosedAttached) {
                this.pageClosedAttached = true;
                this.panel.onDidDispose(() => {
                    this.pageClosedAttached = false;
                    void this.controller.pageClosed();
                });
            }
        }
        await this.controller.handle(message);
    }

    dispose(): void {
        this.controller.dispose();
        this.unregisterGlobalBridge();
        super.dispose();
    }

    // ─── Ports ─────────────────────────────────────────────────────────

    private ports(): HubPorts {
        const manager = this;
        return {
            endpoints: this.endpointManager,
            environments: this.environmentManager,
            systems: this.systemManager,
            recent: new RecentEndpointsService(this.context.globalState),
            preferences: new HubPreferencesService(this.context.globalState),
            settings: dbmnSettings(),   // #281: the account's while signed in, else VS Code's
            auth: {
                isSignedIn: () => this.authService?.isAuthenticated() ?? false,
                sessionExpired: () => this.authService?.getAuthState().connectivityStatus === 'auth_error',
                onChanged: listener => this.authService?.onAuthStateChanged
                    ? this.authService.onAuthStateChanged(listener)
                    : { dispose: () => undefined },
                promptSignIn: async () => {
                    const { sendDbmnSignInLinkInApp } = require('../../services/ui/dbmn-prompts');
                    await sendDbmnSignInLinkInApp(this.authService, this.toastService);
                }
            },
            get executions() {
                return manager.executions();
            },
            compares: {
                state: () => {
                    const container = this.dobermannInstance?.serviceContainer;
                    return container ? compareStateStore(container, this.context) : this.context.globalState;
                }
            },
            confirmDestructive,
            toast: {
                info: m => this.toastService.info(m),
                warn: m => this.toastService.warn(m),
                error: m => this.toastService.error(m)
            },
            tabs: this.tabFactory(),
            runApi: async endpoint => {
                // dbmn.testEndpoint takes a tree item (ExecutionCommands.extractEndpoint)
                await vscode.commands.executeCommand('dbmn.testEndpoint', { itemType: 'endpoint', endpoint });
            },
            tabSnapshots: {
                peek: () => this.context.workspaceState.get<HubTabsSnapshot>(HUB_TABS_SNAPSHOT_KEY),
                take: () => {
                    const snapshot = this.context.workspaceState.get<HubTabsSnapshot>(HUB_TABS_SNAPSHOT_KEY);
                    // Cleared on read: a reload mid-session can't restore twice
                    void this.context.workspaceState.update(HUB_TABS_SNAPSHOT_KEY, undefined);
                    return snapshot;
                },
                save: async snapshot => { await this.context.workspaceState.update(HUB_TABS_SNAPSHOT_KEY, snapshot); }
            },
            whatsNew: () => this.whatsNew(),
            sections: {
                get account() { return manager.accountSection(); },
                get importExport() { return manager.importExportSection(); }
            },
            // #342: extension.ts keeps the catalogue (the account's, or this computer's by choice)
            catalogueStorage: {
                info: () => manager.catalogue()?.storage(),
                saveToAccount: async () => { await manager.catalogue()?.saveToAccount(); },
                removeFromDevice: async () => { await manager.catalogue()?.removeFromDevice(); }
            },
            exportEndpoints: async ids => {
                const service = this.dobermannInstance?.serviceContainer?.resolve<IImportExportService>(ServiceTokens.ImportExportService);
                if (!service) return { error: 'import/export service is not ready' };
                // No targetPath: the service asks for the file with the OS save dialog
                const result = await service.exportToZip({ endpoints: ids, environments: [], includeConsoleSettings: false, filename: 'dbmn-endpoints' });
                return result.success ? { filePath: result.filePath } : { error: result.error };
            },
            workspace: {
                // extension.ts holds the workspace manager on globalThis; executions.db lives in .dbmn (#344)
                info: () => {
                    const ws = (globalThis as Record<string, unknown>).dobermannWorkspaceManager as { getWorkspacePath?: () => string | null } | undefined;
                    const workspacePath = ws?.getWorkspacePath?.() || undefined;
                    return { workspacePath, executionsDbPath: workspacePath ? `${workspacePath}/${DATA_DIR}/executions.db` : undefined };
                },
                reveal: async () => {
                    const folder = getDobermannWorkspaceFolder();
                    if (!folder) return false;
                    await vscode.env.openExternal(folder);
                    return true;
                },
                choose: async () => { await vscode.commands.executeCommand('dbmn.selectWorkspaceFolder'); }
            },
            runWorkbenchCommand: command => {
                if (WORKBENCH_COMMAND_ALLOWLIST.has(command)) void vscode.commands.executeCommand(command);
            },
            closeStandaloneEditors: () => this.closeStandaloneEditors(),
            onStandaloneEditorClosed: listener => this.dobermannInstance?.onEditorClosed?.(listener) ?? { dispose: () => undefined },
            takeStartupRecovery: () => {
                const summary = this.dobermannInstance?.startupRecovery;
                if (!summary || !this.dobermannInstance) return undefined;
                this.dobermannInstance.startupRecovery = undefined;
                return { message: StartupRecoveryService.describe(summary), batchIds: summary.batches.map(b => b.id) };
            }
        };
    }

    private executions(): HubExecutions | undefined {
        const container = this.dobermannInstance?.serviceContainer;
        let metadata: IExecutionMetadataService | undefined;
        try {
            metadata = container?.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService);
        } catch {
            return undefined;
        }
        if (!container || !metadata) return undefined;
        const engine = () => {
            const e = container.resolve<IBatchExecutionEngine>(ServiceTokens.BatchExecutionEngine);
            if (!e) throw new Error('BatchExecutionEngine not available');
            return e;
        };
        return {
            metadata,
            pause: async id => { await engine().pauseBatch(id, 'User requested pause'); },
            resumeRefused: async id => {
                // Issue #311: the environment's sign-in before a batch resumes
                const meta = await metadata!.getExecution(id);
                const gate = container.resolve<IEnvironmentAuthGate>(UIServiceTokens.EnvironmentAuthGate);
                return gate && meta && !(await gate.ensureAuthenticatedForBatch(meta)) ? meta.environment : undefined;
            },
            resume: async (id, choice) => {
                await applyResumeChoice(engine(), id, choice, () => ConsoleController.sendClearErrors(id));
                await engine().resumeBatch(id);
            },
            cancel: async (id, isBatch) => {
                if (isBatch) {
                    await engine().cancelBatch(id);
                } else {
                    const service = container.resolve<{ cancel(executionId: string): Promise<void> }>(ServiceTokens.ExecutionService);
                    if (!service) throw new Error('ExecutionService not available');
                    await service.cancel(id);
                }
            },
            closeStandaloneConsole: id => ConsoleController.closeConsoleForExecution(id)
        };
    }

    /** Tabs are the VS Code managers, each given a virtual panel that posts through the channel. */
    private tabFactory(): HubTabFactory {
        const embed = (manager: { handleEmbeddedMessage(m: WebviewMessage): Promise<void>; dispose(): void }, bridge: HubEmbeddedBridge, html: string, ready?: () => void): HubTab => ({
            html,
            handle: message => manager.handleEmbeddedMessage(message as unknown as WebviewMessage),
            ready,
            dispose: () => {
                bridge.fireDispose();
                manager.dispose();
            }
        });
        const bridgeFor = (channel: TabChannel) => {
            if (!this.panel) throw new Error('The Hub is not open');
            return new HubEmbeddedBridge(this.panel.webview, channel);
        };
        return {
            endpoint: async (config, channel) => {
                const bridge = bridgeFor(channel);
                const manager = new EndpointWebviewManager(this.context, this.endpointManager, this.dobermannInstance as unknown as ConstructorParameters<typeof EndpointWebviewManager>[2]);
                manager.serviceContainer = this.dobermannInstance?.serviceContainer;
                const { html } = await manager.createWebviewEmbedded({ context: 'endpoint', itemId: config.itemId, duplicateFromId: config.duplicateFromId }, bridge);
                return embed(manager, bridge, html);
            },
            environment: async (config, channel) => {
                const bridge = bridgeFor(channel);
                const manager = new EnvironmentWebviewManager(this.context, this.environmentManager, this.dobermannInstance);
                const { html } = await manager.createWebviewEmbedded({ context: 'environment', itemId: config.itemId || '', draft: config.draft }, bridge);
                return embed(manager, bridge, html);
            },
            batch: async ({ endpoint, chain }, channel) => {
                const container = this.dobermannInstance?.serviceContainer;
                if (!container) throw new Error('Service container not available');
                const bridge = bridgeFor(channel);
                const config = { context: 'runBatch' as const, endpointId: endpoint.id, endpointName: endpoint.name, endpoint, chain };
                const manager = new RunBatchWebview(this.context, container, config);
                const { html } = await manager.createWebviewEmbedded(config as WebviewConfig, bridge);
                return { ...embed(manager, bridge, html), applyChain: c => manager.applyChain(c) };
            },
            compare: async ({ compareId, endpointName, start }, channel) => {
                const container = this.dobermannInstance?.serviceContainer;
                if (!container) throw new Error('Service container not available');
                const bridge = bridgeFor(channel);
                const config = { context: 'compare' as const, compareId, endpointName, start, onCompared: () => { void this.controller?.broadcastState(); } };
                const manager = new CompareWebview(this.context, container, config);
                const { html } = await manager.createWebviewEmbedded(config as unknown as WebviewConfig, bridge);
                return embed(manager, bridge, html);
            },
            console: async ({ executionId, isBatch }, channel) => {
                const container = this.dobermannInstance?.serviceContainer;
                if (!container) throw new Error('Service container not available');
                const openStarted = Date.now(); // Issue #312: the open timeline starts at the click
                const reportConfig = await buildConsoleReportConfig({
                    executionId,
                    isBatch,
                    executionMetadataService: container.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService),
                    environments: this.environmentManager
                });
                const manager = new ConsoleWebviewManager({
                    serviceContainer: container,
                    extensionContext: this.context,
                    componentName: 'ConsoleWebviewManager',
                    enableLogging: true
                });
                (manager as unknown as { openMarks: Array<[string, number]> }).openMarks = [['click', openStarted], ['config built', Date.now()]];
                const bridge = bridgeFor(channel);
                const { html } = await manager.createEmbedded(reportConfig as unknown as Parameters<typeof manager.createEmbedded>[0], bridge);
                manager.mark('html built');
                const summary = (reportConfig.executionSummary as Record<string, unknown> | undefined) || {};
                return {
                    ...embed(manager as unknown as WebviewBase, bridge, html, () => { void manager.onEmbeddedReady(); }),
                    // The endpoint's name beats "Batch Console - 2026-…"
                    // #445: a named batch by its own name
                    name: (summary.batchName as string | undefined) || (summary.endpointName as string | undefined) || (summary.endpointPath as string | undefined)
                        || (reportConfig.title as string | undefined) || `Console ${executionId.slice(0, 8)}`,
                    status: (summary.status as string | undefined)?.toLowerCase(),
                    endpointId: reportConfig.endpointId as string | undefined
                };
            }
        };
    }

    /** Account and Import/Export: headless managers whose replies go to the Hub's page. */
    private accountSection(): HubSection | undefined {
        if (!this.accountDelegate) {
            const g = globalThis as Record<string, unknown>;
            const auth = this.authService;
            if (!auth) return undefined;
            this.accountDelegate = new AccountWebviewManager(this.context, auth, this.toastService, g.dbmnTelemetryService as IDbmnTelemetry | undefined,
                this.endpointManager, this.environmentManager, msg => this.panel?.webview.postMessage(msg));
        }
        const delegate = this.accountDelegate;
        return {
            ready: () => delegate.pushInitialStateForHub(),
            shown: () => delegate.onAccountSectionShown(),
            handle: message => delegate.dispatchHubMessage(message as never)
        };
    }

    private importExportSection(): HubSection | undefined {
        if (!this.importExportDelegate) {
            const container = this.dobermannInstance?.serviceContainer;
            if (!container) return undefined;
            this.importExportDelegate = new ImportExportWebviewManager(this.context, container, this.endpointManager, this.environmentManager,
                msg => this.panel?.webview.postMessage(msg));
        }
        const delegate = this.importExportDelegate;
        return {
            ready: () => delegate.pushInitialStateForHub(),
            handle: message => delegate.dispatchHubMessage(message as never)
        };
    }

    /** Editors open in their own VS Code tabs: Save / Discard / Cancel, then close. */
    private async closeStandaloneEditors(): Promise<boolean> {
        const editors = [this.dobermannInstance?.endpointWebview, this.dobermannInstance?.environmentWebview]
            .filter(Boolean) as NonNullable<IDobermannLike['endpointWebview']>[];
        for (const editor of editors) {
            try {
                if (await editor.checkForUnsavedChanges()) {
                    const choice = await editor.showUnsavedChangesDialog();
                    if (choice === 'cancel') return false;
                    if (choice === 'save' && !await editor.saveCurrentContext()) {
                        this.toast?.warn('Could not save — endpoint not switched.');
                        return false;
                    }
                }
                editor.dispose();
            } catch {
                // Best effort: a stuck editor mustn't block the switch
            }
        }
        return true;
    }

    // ─── Global bridges: modals and toasts from anywhere in the extension ──

    /** Extension code (e.g. execution-commands) finds the Hub's modal without an import cycle. */
    private registerGlobalBridge(): void {
        const g = globalThis as Record<string, unknown>;
        g.dbmnShowModal = (spec: DbmnModalSpec) => this.showModal(spec);
        g.__dbmnShowModalOwner = this;
        this.registerToastTarget();
    }

    private unregisterGlobalBridge(): void {
        const g = globalThis as Record<string, unknown>;
        // Only if it's ours: a fresh Hub may already have taken over
        if (g.__dbmnShowModalOwner === this) {
            g.dbmnShowModal = undefined;
            g.__dbmnShowModalOwner = undefined;
        }
        const targets = g[TOAST_TARGETS_KEY] as Set<ToastDelivery> | undefined;
        if (targets && this.toastTarget) targets.delete(this.toastTarget);
        this.toastTarget = undefined;
        this.toastViewStateSub?.dispose();
        this.toastViewStateSub = undefined;
    }

    /** Host toasts show in the Hub's DbmnToast while it's visible; hidden, the service queues them. */
    private registerToastTarget(): void {
        const g = globalThis as Record<string, unknown>;
        let targets = g[TOAST_TARGETS_KEY] as Set<ToastDelivery> | undefined;
        if (!targets) {
            targets = new Set<ToastDelivery>();
            g[TOAST_TARGETS_KEY] = targets;
        }
        this.toastTarget ??= (payload: ToastPayload): boolean => {
            if (!this.panel?.visible) return false;
            this.panel.webview.postMessage({ type: 'dbmnToast', level: payload.level, message: payload.message, opts: payload.opts });
            return true;
        };
        targets.add(this.toastTarget);
        // 'ready' fires once: a hidden-then-shown Hub replays the queue here
        if (!this.toastViewStateSub && this.panel) {
            this.toastViewStateSub = this.panel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible) this.flushPendingToasts();
            });
            this.context.subscriptions.push(this.toastViewStateSub);
        }
    }

    private flushPendingToasts(): void {
        ((globalThis as Record<string, unknown>).dbmnToastService as { drainPending?: () => void } | undefined)?.drainPending?.();
    }
}

/**
 * The Hub's dependencies from the DI container. Needs an initialised container: never
 * getGlobalContainer(), which is silently empty before setGlobalContainer() (the P0.2
 * env-editor System dropdown bug).
 */
export function resolveHubDependencies(
    container: IServiceContainer
): { endpointManager: APIEndpointManager; environmentManager: EnvironmentManager; systemManager: SystemManager } {
    return {
        endpointManager: container.resolve<APIEndpointManager>(ServiceTokens.EndpointManager),
        environmentManager: container.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager),
        systemManager: container.resolve<SystemManager>(ServiceTokens.SystemManager)
    };
}
