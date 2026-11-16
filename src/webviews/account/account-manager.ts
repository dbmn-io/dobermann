// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Account Webview Manager (GitHub Issue #211)
 *
 * In-extension account dashboard showing login form (when signed out)
 * or account details, license, usage, and actions (when signed in).
 *
 * Following Architecture.md: WebviewBase pattern, message-driven UI,
 * business logic stays in backend services.
 */

import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { IDbmnAuthService, IDbmnTelemetry } from '../../services/dbmn-auth/dbmn-auth.interface';
import { DbmnAuthState, DbmnLicenseStatus, DbmnTelemetryStats } from '../../types/dbmn-auth';
import { APIEndpointManager } from '../../apiEndpointManager';
import { EnvironmentManager } from '../../environmentManager';
import { performFlexionTechMigration, FlexionTechMigrationData } from '../../services/migration/flexiontech-migration.service';
import { sendDbmnSignInLinkInApp } from '../../services/ui/dbmn-prompts';
import { IToastService } from '../../services/notifications/toast.interface';
import { BadgeService } from '../../services/badges/badge.service';

export class AccountWebviewManager extends WebviewBase {
    private authService: IDbmnAuthService;
    private toastService: IToastService;
    private telemetryService: IDbmnTelemetry | null;
    private endpointManager: APIEndpointManager | null;
    private environmentManager: EnvironmentManager | null;
    private authStateDisposable: { dispose: () => void } | null = null;
    private wasAuthenticated = false;
    private hadConnectivityIssue = false;

    /** When set, replies bypass `this.panel` and go to whichever sink the
     *  caller provides (the Hub uses this to host Account as an embedded
     *  delegate without an own panel). All postMessage calls go via
     *  `postToWebview()` rather than `this.panel.webview.postMessage` direct. */
    private postMessageOverride?: (msg: unknown) => void;
    private badgeDisposable: { dispose: () => void } | null = null;
    private telemetryDisposable: { dispose: () => void } | null = null;
    private telemetryPushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        context: vscode.ExtensionContext,
        authService: IDbmnAuthService,
        toastService: IToastService,
        telemetryService?: IDbmnTelemetry,
        endpointManager?: APIEndpointManager,
        environmentManager?: EnvironmentManager,
        postMessageOverride?: (msg: unknown) => void
    ) {
        super(context);
        this.authService = authService;
        this.toastService = toastService;
        this.telemetryService = telemetryService ?? null;
        this.endpointManager = endpointManager ?? null;
        this.environmentManager = environmentManager ?? null;
        this.postMessageOverride = postMessageOverride;
    }

    private postToWebview(message: unknown): void {
        if (this.postMessageOverride) {
            this.postMessageOverride(message);
        } else {
            this.panel?.webview.postMessage(message);
        }
    }

    /** Public hooks for the Hub to drive an embedded Account flow. */
    async dispatchHubMessage(message: WebviewMessage): Promise<void> {
        await this.handleMessage(message);
    }
    async pushInitialStateForHub(): Promise<void> {
        // The Hub embeds Account as a section that is initialised eagerly at
        // Hub load — before the user has necessarily navigated to it. Subscribe
        // and push the cached auth state so the section is correct the moment
        // it's shown, but DEFER the network stats fetch (and its "showing
        // cached data" connectivity warning) until onAccountSectionShown().
        // Previously the warning fired at Hub startup when offline, even though
        // the user was never looking at the Account page — the notice is only
        // relevant once the account page is actually loaded.
        this.subscribeAndPushState();
        this.pushFlexionTechStatus();
    }

    /**
     * The Hub navigated to the Account section — now the account page is
     * genuinely being viewed, so fetch fresh stats. Called on every entry to
     * the section, so it also recovers after a reconnect (navigate away and
     * back re-fetches).
     */
    async onAccountSectionShown(): Promise<void> {
        // They are looking at the collection now: clear the dot on the Account nav icon,
        // and ask the server for anything new (forced — this is a deliberate look).
        const badges = this.getBadgeService();
        if (badges) {
            void badges.markSeen().then(() => badges.refresh({ force: true }));
        }
        await this.refreshStats();
    }

    /** Created early in extension.ts and held on globals, like the auth and toast services. */
    private getBadgeService(): BadgeService | undefined {
        return (globalThis as Record<string, unknown>).dbmnBadgeService as BadgeService | undefined;
    }

    private pushBadgeState(): void {
        const badges = this.getBadgeService();
        if (badges) { this.postToWebview(badges.buildMessage()); }
    }

    getWebviewType(): string {
        return 'account';
    }

    /**
     * Open beside the Hub so it stays visible — matches endpoint, env,
     * console, and import/export editors.
     */
    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Beside;
    }

    /**
     * Set endpoint/environment managers after dobermann initialization.
     * These are needed for FlexionTech migration but aren't available at construction time.
     */
    setManagers(endpointManager: APIEndpointManager, environmentManager: EnvironmentManager): void {
        this.endpointManager = endpointManager;
        this.environmentManager = environmentManager;
    }

    /**
     * Open or reveal the account webview.
     */
    async open(): Promise<void> {
        await this.createWebview({ context: 'account' });
    }

    protected getWebviewTitle(_config: WebviewConfig): string {
        return 'DBMN Account';
    }

    async getHtmlContent(_config: WebviewConfig): Promise<string> {
        const template = this.loadTemplate('account.html');
        const cssUris = this.getSharedCssUris();
        const cssLinks = `
            <link rel="stylesheet" href="${cssUris.atomic}">
            <link rel="stylesheet" href="${cssUris.core}">
            <link rel="stylesheet" href="${cssUris.modals}">
            <link rel="stylesheet" href="${cssUris.tables}">
            <link rel="stylesheet" href="${cssUris.toast}">
        `;
        const scriptUri = this.getWebviewUri('account/account.js');
        // GitHub Issue #263: the sign-in flow opens a DbmnModal on this panel
        // via WebviewBase.showModal; the modal renderer must be loaded in the
        // frontend to receive the dbmnModalRequest messages.
        const dbmnModalUri = this.getWebviewUri('shared/dbmn-modal.js');
        const rowPasteUri = this.getWebviewUri('shared/row-paste.js');
        const dbmnToastUri = this.getWebviewUri('shared/dbmn-toast.js');
        const dbmnClipboardUri = this.getWebviewUri('shared/dbmn-clipboard.js');

        return this.substituteTemplate(template, {
            SHARED_STYLES: cssLinks,
            ACCOUNT_SCRIPT: scriptUri.toString(),
            DBMN_MODAL_SCRIPT: dbmnModalUri.toString(),
            ROW_PASTE_SCRIPT: rowPasteUri.toString(),
            DBMN_TOAST_SCRIPT: dbmnToastUri.toString(),
            DBMN_CLIPBOARD_SCRIPT: dbmnClipboardUri.toString()
        });
    }

    protected async initializeWebview(): Promise<void> {
        // Standalone Account panel: opening the panel IS the user loading the
        // account page, so subscribe, push cached state, then fetch fresh
        // stats (surfacing any connectivity warning) immediately.
        this.subscribeAndPushState();
        await this.refreshStats();

        // Check for FlexionTech extension and push status to webview
        this.pushFlexionTechStatus();
    }

    /**
     * Subscribe to auth state changes and push the current (cached) auth state
     * to the webview. Cheap and network-free — safe to run eagerly even when
     * the account page isn't being viewed yet. telemetryStats carries the
     * last-known cached numbers (restored from storage) or null on a fresh
     * install; refreshStats() fetches the live values.
     */
    private subscribeAndPushState(): void {
        this.disposeAuthListener();
        this.wasAuthenticated = this.authService.getAuthState().isAuthenticated;
        this.authStateDisposable = this.authService.onAuthStateChanged((state) => {
            this.pushAuthState(state);
            // Detect sign-in transition or recovery from connectivity issue
            if (state.isAuthenticated && (!this.wasAuthenticated || this.hadConnectivityIssue)) {
                this.wasAuthenticated = true;
                this.hadConnectivityIssue = false;
                void this.refreshStats();
            } else {
                this.wasAuthenticated = state.isAuthenticated;
            }
        });

        // Send current auth state immediately — cached telemetryStats (or null)
        // so the usage sections paint before the live fetch returns.
        this.pushAuthState(this.authService.getAuthState());

        // Every record moves the usage tiles at once (server numbers + what is still on
        // this machine). Coalesced: a batch completes members many times a second.
        this.telemetryDisposable?.dispose();
        this.telemetryDisposable = this.telemetryService?.onDidChange?.(() => this.schedulePushAuthState()) ?? null;

        // Badges + Puppy School progress: cached state now, every change after. Pushed even
        // while the Account section is hidden — the dot on its nav icon depends on it.
        this.badgeDisposable?.dispose();
        this.badgeDisposable = this.getBadgeService()?.onChange(() => this.pushBadgeState()) ?? null;
        this.pushBadgeState();
    }

    /**
     * Flush telemetry, fetch fresh license + stats from the server, and push
     * the result to the webview. Never fabricates zeros — offline, the auth
     * service serves the last-known cached stats (persisted across reloads),
     * so the view shows real cached numbers or, if nothing was ever cached, a
     * dash. Emits `statsRefreshing` so the view can spin next to the usage
     * headers while the fetch is in flight.
     *
     * The warning only belongs here — a network call the user triggered by
     * viewing the account page. The Hub defers this until the Account section
     * is opened so the notice never fires eagerly at Hub startup.
     */
    private async refreshStats(): Promise<void> {
        // Signed out — the pushed auth state already renders the sign-in view.
        if (!this.authService.getAuthState().isAuthenticated) {
            return;
        }

        // Ensure DBMN session token is fresh before fetching stats
        await this.authService.ensureValidSession();

        this.postToWebview({ type: 'statsRefreshing', refreshing: true });
        try {
            if (this.telemetryService) {
                await this.telemetryService.flush();
            }
            const fetched = await this.authService.fetchLicenseStatus(true);
            if (fetched) {
                // The server's numbers now include everything flushed before this point.
                this.telemetryService?.markStatsSynced?.();
            }
        } catch (err) {
            console.warn('[AccountWebview] Failed to fetch telemetry stats:', err);
        } finally {
            this.postToWebview({ type: 'statsRefreshing', refreshing: false });
        }

        // Re-check auth state — if a 401 caused sign-out during fetch, the
        // listener already pushed the signed-out state.
        const currentState = this.authService.getAuthState();
        if (!currentState.isAuthenticated) {
            return;
        }

        // Push whatever we have: fresh (online), cached (offline), or null
        // (never cached — the view shows a dash). No fabricated zeros.
        this.pushAuthState(currentState);

        // Only genuine network trouble warrants a footer notice. A dead/expired
        // DBMN session (auth_error) is surfaced passively via the expired badge
        // + Sign In and lazily at run time (the run path prompts re-login).
        if (currentState.connectivityStatus === 'network_error') {
            this.hadConnectivityIssue = true;
            const message = currentState.telemetryStats
                ? 'Unable to connect to dbmn.io — showing cached data'
                : 'Unable to connect to dbmn.io — usage data unavailable offline';
            this.postToWebview({ type: 'connectivityWarning', message });
        }
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'signIn':
                // GitHub Issue #263: single sign-in entry point. When the
                // Account is opened standalone (`this.panel` exists) the modal
                // renders on the Account panel itself. When embedded inside the
                // Hub (`this.panel` is undefined and messages are routed via
                // postMessageOverride), passing `this` would early-return dismiss
                // — let the modal flow fall through to the Hub's global bridge.
                {
                    const host = this.panel ? this : undefined;
                    await sendDbmnSignInLinkInApp(this.authService, this.toastService, host);
                }
                break;
            case 'signOut':
                await this.authService.signOut();
                break;
            case 'openPuppySchool':
                this.telemetryService?.recordFeatureUsage('puppy_school_opened');
                await this.authService.openPuppySchool();
                break;
            case 'refreshSession':
                // The footer Sign In button — used when a background refresh
                // races to auth_error and the user needs to re-sign-in. The
                // in-app magic-link modal pre-fills the email (last session
                // or persisted lastEmail) so the user just clicks Sign In.
                await sendDbmnSignInLinkInApp(this.authService, this.toastService);
                break;
            case 'importFromFlexionTech':
                await this.handleFlexionTechImport();
                break;
            case 'dismissFlexionTechMigration':
                await this.context.globalState.update('flexiontech-migration-completed', true);
                this.postToWebview({ type: 'flexionTechStatus', installed: false });
                break;
            case 'openImportExport':
                vscode.commands.executeCommand('dbmn.importExport');
                break;
        }
    }

    /**
     * Push auth state to webview without raw tokens.
     */
    private schedulePushAuthState(): void {
        if (this.telemetryPushTimer) {
            return;
        }
        this.telemetryPushTimer = setTimeout(() => {
            this.telemetryPushTimer = null;
            const state = this.authService.getAuthState();
            if (state.isAuthenticated) {
                this.pushAuthState(state);
            }
        }, 500);
    }

    /**
     * The usage numbers the view shows: the server's last fetched stats plus whatever this
     * machine has recorded that the server does not reflect yet. Never fabricates zeros — with
     * nothing from the server and nothing recorded locally, the view keeps its dash.
     */
    private displayedTelemetryStats(state: DbmnAuthState): DbmnAuthState['telemetryStats'] {
        const local = this.telemetryService?.getUnsyncedStats?.();
        if (!local) {
            return state.telemetryStats;
        }
        const isZero = (s: DbmnTelemetryStats) => s.apiCalls === 0 && s.batchRuns === 0 && s.rowsProcessed === 0 && s.totalExecutionTimeMs === 0;
        if (!state.telemetryStats) {
            return isZero(local.weekly) && isZero(local.alltime) ? null : local;
        }
        const add = (server: DbmnTelemetryStats, delta: DbmnTelemetryStats): DbmnTelemetryStats => ({
            apiCalls: (server.apiCalls || 0) + delta.apiCalls,
            batchRuns: (server.batchRuns || 0) + delta.batchRuns,
            rowsProcessed: (server.rowsProcessed || 0) + delta.rowsProcessed,
            totalExecutionTimeMs: (server.totalExecutionTimeMs || 0) + delta.totalExecutionTimeMs
        });
        return {
            weekly: add(state.telemetryStats.weekly, local.weekly),
            alltime: add(state.telemetryStats.alltime, local.alltime)
        };
    }

    private pushAuthState(state: DbmnAuthState): void {
        const serializeLicense = (l: DbmnLicenseStatus) => ({
            licenseType: l.licenseType,
            accessLevel: l.accessLevel,
            status: l.status,
            trialEndsAt: l.trialEndsAt,
            subscriptionEndsAt: l.subscriptionEndsAt,
            licensedEnvironmentUrls: l.licensedEnvironmentUrls,
            isLifetime: l.isLifetime
        });

        this.postToWebview({
            type: 'authStateUpdate',
            isAuthenticated: state.isAuthenticated,
            displayName: state.session?.displayName ?? null,
            email: state.session?.email ?? null,
            license: state.license ? serializeLicense(state.license) : null,
            userLicense: state.userLicense ? serializeLicense(state.userLicense) : null,
            usage: state.usage,
            telemetryStats: this.displayedTelemetryStats(state),
            connectivityStatus: state.connectivityStatus
        });
    }

    // =========================================================================
    // FlexionTech Migration
    // =========================================================================

    private pushFlexionTechStatus(): void {
        const legacyExt = vscode.extensions.getExtension('FlexionTech.active8');

        if (!legacyExt) {
            this.postToWebview({ type: 'flexionTechStatus', installed: false });
            return;
        }

        const version: string = legacyExt.packageJSON?.version || '0.0.0';
        const [major, minor, patch] = version.split('.').map(Number);
        const hasApi = major > 0 || minor > 0 || patch >= 51;

        this.postToWebview({
            type: 'flexionTechStatus',
            installed: true,
            version,
            hasApi
        });
    }

    private async handleFlexionTechImport(): Promise<void> {
        if (!this.endpointManager || !this.environmentManager) {
            this.postToWebview({
                type: 'flexionTechImportResult',
                success: false,
                error: 'Extension managers not available. Please reload and try again.'
            });
            return;
        }

        try {
            const legacyExt = vscode.extensions.getExtension('FlexionTech.active8');
            if (!legacyExt) {
                this.postToWebview({
                    type: 'flexionTechImportResult',
                    success: false,
                    error: 'Legacy DBMN extension not found. Is it still installed?'
                });
                return;
            }

            const api = legacyExt.isActive ? legacyExt.exports : await legacyExt.activate();
            if (!api?.getMigrationData) {
                this.postToWebview({
                    type: 'flexionTechImportResult',
                    success: false,
                    error: 'Legacy DBMN extension does not support automatic migration. Please update to v0.0.51+.'
                });
                return;
            }

            const data: FlexionTechMigrationData = await api.getMigrationData();
            const results = await performFlexionTechMigration(data, this.endpointManager, this.environmentManager);

            await this.context.globalState.update('flexiontech-migration-completed', true);

            // Refresh tree views
            vscode.commands.executeCommand('dbmn.refreshEnvironments');

            this.postToWebview({
                type: 'flexionTechImportResult',
                success: true,
                endpointsImported: results.endpoints.imported,
                endpointsSkipped: results.endpoints.skipped,
                environmentsImported: results.environments.imported,
                environmentsSkipped: results.environments.skipped
            });
        } catch (error) {
            console.error('[AccountWebview] FlexionTech migration failed:', error);
            this.postToWebview({
                type: 'flexionTechImportResult',
                success: false,
                error: error instanceof Error ? error.message : 'Migration failed'
            });
        }
    }

    private disposeAuthListener(): void {
        if (this.authStateDisposable) {
            this.authStateDisposable.dispose();
            this.authStateDisposable = null;
        }
    }

    dispose(): void {
        this.disposeAuthListener();
        this.badgeDisposable?.dispose();
        this.badgeDisposable = null;
        this.telemetryDisposable?.dispose();
        this.telemetryDisposable = null;
        if (this.telemetryPushTimer) {
            clearTimeout(this.telemetryPushTimer);
            this.telemetryPushTimer = null;
        }
        super.dispose();
    }
}
