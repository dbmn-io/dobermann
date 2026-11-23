// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AppLog } from './services/logging/app-log';
import { AppLogDayFiles } from './services/logging/app-log-file';
import { LoggerRegistry as AppLogRegistry } from './utils/logger-registry';
import { Dobermann } from './dobermann';
import { createDefaultEndpoint } from './apiConfigManager';
import { IExecutionMetadataService } from './services/execution/execution-metadata.interface';
import { IExecutionService } from './services/execution/execution.interface';
import { IExecutionLoggingService } from './services/logging/execution-logging.interface';
import { IExecutionCoordinator } from './services/execution/execution-coordinator.interface';
import { UIServiceTokens } from './container/ui-services-registry';
import { CoreServiceTokens } from './container/core-services-registry';
import { IProgressManager } from './services/progress-manager/progress-manager.interface';
import { ServiceTokens } from './container/service-container.interface';
import { ExecutionPriority } from './types/execution-state';
import { ExecutionStatus } from './types/unified-execution-status';
import { ExecutionCommands } from './commands/execution-commands';
import { TenantAuthProvider } from './services/oauth/tenant-auth-provider';
import { OAuthConfigService } from './services/oauth/oauth-config.service';
import { OAuthFlowHandler } from './services/oauth/oauth-flow-handler';
import { OAuthTokenRefresher } from './services/oauth/oauth-refresh';
import { moveDeviceSecrets, VaultedDeviceStore } from './services/catalogue/device-secrets';
import { EnvironmentManager } from './environmentManager';
import { APIEndpointManager } from './apiEndpointManager';
import { OAuthService } from './services/oauth/oauth.service';
import { OAuthTokenService } from './services/oauth/oauth-token.service';
import { WorkspaceManagerService } from './services/workspace/workspace-manager.service';
import { ImportExportWebviewManager } from './webviews/import-export/import-export-manager';
import { ConsoleWebviewManager } from './webviews/console/console-webview-manager';

import { EnvironmentMigrationService } from './services/migration/environment-migration.service';
import { GlobalSystemsService, wireGlobalSystems } from './services/systems/global-systems.service';
import { wireGlobalSystemSwitch } from './services/systems/global-system-adoption';
import { SystemOperationsService } from './services/systems/system-operations.service';
import { performFlexionTechMigration, FlexionTechMigrationData } from './services/migration/flexiontech-migration.service';

// DBMN Authentication (GitHub Issue #208)
import { DbmnAuthService } from './services/dbmn-auth/dbmn-auth.service';
import { registerDbmnServices, DbmnServiceTokens } from './container/dbmn-services-registry';
import { DbmnTelemetryService } from './services/dbmn-auth/dbmn-telemetry.service';
import { vscodeTelemetryOptions } from './services/dbmn-auth/vscode-telemetry-options';
import { BadgeService, earnedMessage } from './services/badges/badge.service';
import { fetchMyBadges } from './services/badges/badge-api';
import { resolveBackend, initBackend, getBackend, backendLabel, isBackendReachable, backendUnreachableMessage } from './services/dbmn-backend/backend-config';
import { AccountWebviewManager } from './webviews/account/account-manager';
import { confirmDestructive, hostChoice } from './services/ui/dbmn-prompts';
import { StartupRecoveryService } from './services/execution/startup-recovery.service';
// Portable toast layer (GitHub Issue #263 — first step of VS Code eject)
import { VSCodeToastService } from './services/notifications/vscode-toast.service';
import { getToast } from './services/notifications/get-toast';
import { deliverOAuthCallback } from './services/oauth/oauth-callback';
import { VsCodeCatalogue } from './platform/vscode/vscode-catalogue';
import { forwardSettingsEdits } from './platform/vscode/vscode-settings';
import { accountAgentKeys } from './platform/supabase/agent-keys';
import { accountAgentListeners, announceAgentListener, withdrawAgentListener } from './platform/supabase/agent-discovery';
import { AgentHost } from './services/agent/local-agent';
import { VsCodeAgentListener } from './platform/vscode/vscode-agent-listener';
import { createClient } from '@supabase/supabase-js';
import type { IEnvironmentAuthGate } from './services/environment/auth-gate';
import { allTablesOf, useTemplateLookups } from './data-loading/template-lookups';
import { LookupTablesStore } from './services/lookup-tables/lookup-tables';
import { vsCodeLookupFolder } from './platform/vscode/vscode-execution-storage';

let dobermann: Dobermann;
/** Dobermann issue 7: the app's one log (made first in activate, saved in deactivate). */
let appLog: AppLog | undefined;

// Startup recovery (Issue #313): pause what was running or queued when the host
// went away, remember what was done, and let the Hub tell the user when it opens.
// Never waits on the user here — that held activation (and the Hub) until a
// native notification was answered.
async function performStartupRecovery(serviceContainer: any): Promise<void> {
    const { LoggerRegistry } = await import('./utils/logger-registry');
    const logger = LoggerRegistry.getDiagnosticLogger();
    try {
        const executionMetadataService = serviceContainer.resolve(ServiceTokens.ExecutionMetadataService) as IExecutionMetadataService;
        const summary = await new StartupRecoveryService(executionMetadataService, logger).recover();
        if (!StartupRecoveryService.isEmpty(summary)) {
            dobermann.startupRecovery = summary;
        }
    } catch (error) {
        logger.error('❌ [StartupRecovery] Failed to perform startup recovery:', error as Error);
        // Don't throw - we don't want startup recovery failure to prevent extension activation
    }
}

// FlexionTech migration — offered once after first DBMN login
async function offerFlexionTechMigration(
    context: vscode.ExtensionContext,
    endpointManager: APIEndpointManager,
    environmentManager: EnvironmentManager
): Promise<void> {
    const MIGRATION_DONE_KEY = 'flexiontech-migration-completed';
    if (context.globalState.get<boolean>(MIGRATION_DONE_KEY)) { return; }

    const legacyExt = vscode.extensions.getExtension('FlexionTech.active8');
    if (!legacyExt) { return; }

    const legacyVersion: string = legacyExt.packageJSON?.version || '0.0.0';
    const [major, minor, patch] = legacyVersion.split('.').map(Number);
    const hasAutoMigration = major > 0 || minor > 0 || patch >= 51;

    if (hasAutoMigration) {
        // ── v0.0.51+ : automatic migration via API ──
        const api = legacyExt.isActive ? legacyExt.exports : await legacyExt.activate();
        if (!api?.getMigrationData) { return; }

        const action = await hostChoice({
            title: 'Import legacy DBMN data?',
            body: 'Legacy DBMN install detected. Import your environments and endpoints?',
            actions: [
                { id: 'not-now', label: 'Not Now', variant: 'secondary' },
                { id: 'never', label: "Don't Ask Again", variant: 'secondary' },
                { id: 'import', label: 'Import Now', variant: 'primary' }
            ]
        });

        if (action === 'import') {
            const data = await api.getMigrationData();
            const results = await performFlexionTechMigration(data, endpointManager, environmentManager);
            getToast()?.info(
                `Imported ${results.endpoints.imported} endpoints and ${results.environments.imported} environments.` +
                (results.endpoints.skipped + results.environments.skipped > 0
                    ? ` (${results.endpoints.skipped + results.environments.skipped} duplicates skipped)`
                    : '')
            );
            await context.globalState.update(MIGRATION_DONE_KEY, true);
        } else if (action === 'never') {
            await context.globalState.update(MIGRATION_DONE_KEY, true);
        }
        // "Not Now" — will prompt again next login

    } else {
        // ── v0.0.50 or older : no API, guide manual migration ──
        const action = await hostChoice({
            title: 'Legacy DBMN detected',
            body: `Legacy DBMN (v${legacyVersion}) detected. Update to v0.0.51 for automatic migration, or export/import manually.`,
            actions: [
                { id: 'guide', label: 'Migration Guide', variant: 'secondary' },
                { id: 'never', label: "Don't Ask Again", variant: 'secondary' },
                { id: 'update', label: 'Update FlexionTech', variant: 'primary' }
            ]
        });

        if (action === 'update') {
            vscode.commands.executeCommand('extension.open', 'FlexionTech.active8');
        } else if (action === 'guide') {
            vscode.env.openExternal(vscode.Uri.parse(require('./services/dbmn-backend/backend-config').resolveDocsUrl('https://dbmn.io/docs/migration/')));
        } else if (action === 'never') {
            await context.globalState.update(MIGRATION_DONE_KEY, true);
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // Each start-up step, timed, before anything else can hang: a start that sticks shows where
    // in Output › DBMN Start-up (and its log file) instead of leaving nothing behind
    const startup = vscode.window.createOutputChannel('DBMN Start-up', { log: true });
    context.subscriptions.push(startup);
    // Dobermann issue 7: the app's one log, from the first moment. Everything goes to Logs; the
    // start-up lines are also mirrored to the channel above, the one place a failed start can be
    // read when the Hub never opens.
    appLog = new AppLog({
        mirror: line => {
            if (line.source !== 'start-up') return;
            if (line.level === 'error') startup.error(line.message);
            else if (line.level === 'warn') startup.warn(line.message);
            else startup.info(line.message);
        }
    });
    AppLogRegistry.setAppLog(appLog);
    // `lu` in request templates reads the lookup tables the Hub and Query keep (read when a run needs them)
    useTemplateLookups(() => allTablesOf(new LookupTablesStore(vsCodeLookupFolder()))());
    const log = appLog;
    const started = Date.now();
    const step = (name: string) => log.write({ level: 'info', source: 'start-up', message: `${name} (+${Date.now() - started} ms)` });
    step('activating');
    try {
        // FIRST: decide which DBMN backend this build talks to. A packaged build is always
        // production; the Extension Development Host defaults to the local stack. Everything
        // below reads it through getBackend(). See services/dbmn-backend/backend-config.ts.
        const backend = resolveBackend({
            isDevelopment: context.extensionMode === vscode.ExtensionMode.Development,
            env: process.env
        });
        initBackend(backend);
        // The log is kept per computer, apart for each backend profile (a dev host on the local
        // stack never mixes its lines into the installed app's)
        // a file per day, kept per profile (the dev build's local stack apart from production)
        // How long and how much it keeps: the user's settings (Settings → Logs), checked again when they change
        log.setRetention(() => {
            const config = vscode.workspace.getConfiguration('dbmn');
            return { days: config.get<number>('logs.keepDays', 14), megabytes: config.get<number>('logs.mostMegabytes', 150) };
        });
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('dbmn.logs')) void log.prune();
        }));
        void log.start(new AppLogDayFiles(path.join(context.globalStorageUri.fsPath, `logs${backend.storageSuffix}`)));
        if (backend.isDevBuild) {
            console.log(`[DBMN] ${backendLabel(backend)} backend: ${backend.apiUrl} (site ${backend.siteUrl})`);
        }

        // Register URI handler for OAuth callbacks
        const uriHandler = vscode.window.registerUriHandler({
            handleUri: async (uri: vscode.Uri) => {
                // OAuth callback received - process through proper channels

                // Check if this is an OAuth callback
                if (uri.path === '/oauth-callback') {
                    // #361: the browser's answer goes to the sign-in waiting for it: a code whose
                    // state matches, or the sign-in page's error (which fails the sign-in at once,
                    // with the server's description, instead of after a 60-second timeout).
                    const query = new URLSearchParams(uri.query);
                    const outcome = deliverOAuthCallback(query, message => console.warn(message));
                    if (outcome === 'ignored') {
                        getToast()?.warn('A sign-in response arrived that does not belong to the sign-in in progress. It was ignored.');
                    } else if (outcome === 'no-sign-in') {
                        const error = query.get('error');
                        if (error) getToast()?.error(`Sign-in failed: ${query.get('error_description') || error}`);
                        else getToast()?.info('A sign-in response arrived, but no sign-in is waiting for it. Start the sign-in again.');
                    }
                }

                // DBMN auth callback (GitHub Issue #208)
                if (uri.path === '/dbmn-auth-callback') {
                    const query = new URLSearchParams(uri.query);
                    const accessToken = query.get('access_token');
                    const refreshToken = query.get('refresh_token');

                    if (accessToken && refreshToken) {
                        // Pass tokens to DBMN auth service
                        const dbmnAuthService = (global as any).dbmnAuthService as DbmnAuthService | undefined;
                        if (dbmnAuthService) {
                            dbmnAuthService.handleAuthCallback(accessToken, refreshToken).catch(err => {
                                console.error('[DbmnAuth] Callback handling failed:', err);
                                getToast()?.error('DBMN sign-in failed. Please try again.');
                            });
                        }
                    } else {
                        const error = query.get('error');
                        console.error('[DbmnAuth] Auth callback error:', error);
                        getToast()?.error(`DBMN sign-in failed: ${error || 'Missing tokens'}`);
                    }
                }
            }
        });
        context.subscriptions.push(uriHandler);
        // Initialize workspace manager first
        const workspaceManager = new WorkspaceManagerService(context);
        step('workspace folder: preparing');
        await workspaceManager.initialize();
        step('workspace folder: ready');

        // Make workspace manager globally available for backward compatibility
        (global as any).dobermannWorkspaceManager = workspaceManager;

        // =====================================================================
        // DBMN Authentication Gate (GitHub Issue #208)
        // Hard gate: extension requires DBMN sign-in before ANY functionality
        // =====================================================================
        const dbmnAuthService = new DbmnAuthService(context);
        (global as any).dbmnAuthService = dbmnAuthService;
        step('DBMN sign-in: restoring');
        await dbmnAuthService.initialize();
        step('DBMN sign-in: restored');

        // Portable toast layer (GitHub Issue #263). Installed on `global` so the
        // sites that already pull `dbmnAuthService` from globals can reach the
        // toast the same way until those globals get refactored out. The UI
        // services registry registers the same instance under
        // `UIServiceTokens.ToastService` for DI-aware call sites.
        const dbmnToastService = new VSCodeToastService();
        (global as Record<string, unknown>).dbmnToastService = dbmnToastService;

        // No silent fallback: if the LOCAL stack is down, say so and say how to fix it. The
        // extension stays on the local profile (signed out) — it never reaches for production.
        if (backend.profile === 'local') {
            void isBackendReachable(backend).then(reachable => {
                if (!reachable) {
                    dbmnToastService.warn(backendUnreachableMessage(backend), { persistent: true });
                }
            });
        }

        // Wire telemetry service (GitHub Issue #211)
        // On while `dbmn.telemetry.enabled` and VS Code's own telemetry setting are both on
        const telemetryService = new DbmnTelemetryService(context, vscodeTelemetryOptions());
        telemetryService.setAuthService(dbmnAuthService);
        (global as Record<string, unknown>).dbmnTelemetryService = telemetryService;
        context.subscriptions.push({ dispose: () => telemetryService.dispose() });
        // #419: switching either off drops whatever was waiting to be sent
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('dbmn.telemetry.enabled')) void telemetryService.flush();
        }));
        context.subscriptions.push(vscode.env.onDidChangeTelemetryEnabled(() => { void telemetryService.flush(); }));

        // Badges + Puppy School progress. Read-only: the server records every pass, this
        // shows the collection and says so when a new badge arrives. The service itself is
        // portable; everything VS Code-specific is wired here.
        const badgeService = new BadgeService({
            // Cached per backend profile, like the session: a local run must never show (or
            // overwrite) the production account's collection.
            store: {
                get: <T>(key: string) => context.globalState.get<T>(key + backend.storageSuffix),
                update: (key: string, value: unknown) => context.globalState.update(key + backend.storageSuffix, value)
            },
            getSession: async () => {
                if (!dbmnAuthService.isAuthenticated()) { return null; }
                const refreshed = await dbmnAuthService.ensureValidSession();
                const session = dbmnAuthService.getSession();
                return refreshed.status === 'success' && session
                    ? { userId: session.userId, accessToken: session.accessToken }
                    : null;
            },
            fetchBadges: fetchMyBadges
        });
        (global as Record<string, unknown>).dbmnBadgeService = badgeService;
        context.subscriptions.push(badgeService.onChange((_state, newlyEarned) => {
            if (newlyEarned.length > 0) {
                dbmnToastService.info(earnedMessage(newlyEarned));
            }
        }));
        // A learner clicks "Check my homework" in the browser, then comes back here: that is
        // when a new badge should show up. Throttled inside the service.
        context.subscriptions.push(vscode.window.onDidChangeWindowState(windowState => {
            if (windowState.focused) { void badgeService.refresh(); }
        }));
        void badgeService.refresh();

        // Create account webview manager (GitHub Issue #211)
        const accountWebview = new AccountWebviewManager(context, dbmnAuthService, dbmnToastService, telemetryService);

        // Auth state surfaces on the Hub Account page + Sign In button
        // (see hub.html / account-frontend.js).
        let wasAuthenticated = dbmnAuthService.isAuthenticated();
        const authStateDisposable = dbmnAuthService.onAuthStateChanged((state) => {
            // The badge collection belongs to the account, not the machine.
            if (state.isAuthenticated && !wasAuthenticated) {
                void badgeService.refresh({ force: true });
            } else if (!state.isAuthenticated && wasAuthenticated) {
                void badgeService.clear();
            }

            // FlexionTech migration now handled via Account page (no auto-prompt)
            wasAuthenticated = state.isAuthenticated;
        });
        context.subscriptions.push(authStateDisposable);

        // Register DBMN commands (available even when not authenticated)
        context.subscriptions.push(
            vscode.commands.registerCommand('dbmn.dbmnSignIn', async () => {
                await accountWebview.open();
            })
        );

        // Set DBMN auth context — controls menu/action visibility via when-clauses
        const isDbmnAuthenticated = dbmnAuthService.isAuthenticated();
        await vscode.commands.executeCommand('setContext', 'dbmn.isDbmnAuthenticated', isDbmnAuthenticated);

        if (!isDbmnAuthenticated) {
            console.log('[DbmnAuth] Not authenticated — endpoints visible (read-only), environments/transactions gated.');
        }

        // Create Dobermann instance (always — needed for endpoint tree even when not authenticated)
        step('DBMN core: starting (history, catalogue)');
        // #362: no secret in plain state: the device's own environments keep theirs in the vault
        // (moved there once from the plain copies, which older versions also read)
        const deviceStore = new VaultedDeviceStore(context.globalState, context.secrets);
        try {
            await deviceStore.load();
            const moved = await moveDeviceSecrets(context.globalState, context.secrets);
            if (moved) console.log(`[Vault] moved ${moved} environments' secrets out of older device copies`);
        } catch (error) {
            console.error('[Vault] could not move the device\'s environment secrets to the vault', error);
        }
        dobermann = new Dobermann(context, deviceStore);

        // Wait for initialization to complete
        await dobermann.waitForInitialization();
        step('DBMN core: ready');

        // #342: signed in to DBMN, the catalogue managers work on the account's shared catalogue
        const catalogue = new VsCodeCatalogue(
            context,
            dobermann.getCatalogueStore(),
            { endpoints: dobermann.getEndpointManager(), environments: dobermann.getEnvironmentManager(), systems: dobermann.getSystemManager() },
            dbmnAuthService,
            (message, error) => dobermann.getOutputChannel().appendLine(error ? `${message}: ${error instanceof Error ? error.message : String(error)}` : message)
        );
        catalogue.start();
        context.subscriptions.push(catalogue);
        // The Hub's Settings and Home say where the catalogue lives, and can save it to the account
        (global as Record<string, unknown>).dbmnCatalogue = catalogue;
        // #281: a roaming setting edited in VS Code's Settings while signed in goes to the account
        context.subscriptions.push(forwardSettingsEdits((message, error) => dobermann.getOutputChannel().appendLine(error ? `${message}: ${error instanceof Error ? error.message : String(error)}` : message)));

        // The web app's local agent (#344 step 4, #374). It answers the web app on loopback; VS
        // Code's own runs never go through it. Never in the way of starting.
        try {
            const agentLog = (message: string, error?: unknown) => dobermann.getOutputChannel().appendLine(error ? `${message}: ${error instanceof Error ? error.message : String(error)}` : message);
            const agentUser = () => (dbmnAuthService.isAuthenticated() ? dbmnAuthService.getSession()?.userId : undefined);
            // The DBMN account, as the signed-in user: the web app's public keys, and where this window listens
            const accountToken = async () => {
                const result = await dbmnAuthService.ensureValidSession();
                return result.status === 'success' ? result.session.accessToken : null;
            };
            const account = createClient(getBackend().apiUrl, getBackend().anonKey, { accessToken: accountToken });
            const agentVersion = String(context.extension.packageJSON.version ?? '');
            const agentHost = new AgentHost({
                userId: agentUser,
                // Who is asking: the web app signs each message; its public key is on this DBMN account
                publicKey: accountAgentKeys(account, agentUser),
                getEnvironment: id => dobermann.getEnvironmentManager().getEnvironment(id),
                executor: dobermann.getRequestExecutor(),
                authGate: { isAuthenticationValid: environment => dobermann.serviceContainer.resolve<IEnvironmentAuthGate>(UIServiceTokens.EnvironmentAuthGate).isAuthenticationValid(environment) },
                oauthStart: (id, redirectUri, forceLogin) => dobermann.serviceContainer.resolve<OAuthService>('IOAuthService').startBrowserSignIn(id, redirectUri, forceLogin),
                oauthSignOut: id => dobermann.serviceContainer.resolve<OAuthService>('IOAuthService').signOut(id),
                oauthFinish: (id, code, state) => dobermann.serviceContainer.resolve<OAuthService>('IOAuthService').finishBrowserSignIn(id, code, state),
                // #375: what the agent host needs to refuse (version, redirect)
                agentVersion,
                devBuild: () => getBackend().isDevBuild,
                log: agentLog
            });
            const listener = new VsCodeAgentListener(agentHost, {
                agentVersion,
                devBuild: () => getBackend().isDevBuild,
                deviceId: vscode.env.machineId,
                signedIn: () => !!agentUser(),
                announce: found => announceAgentListener(account, found),
                withdraw: listenerId => withdrawAgentListener(account, listenerId),
                listeners: () => accountAgentListeners(account),
                log: agentLog
            });
            context.subscriptions.push(listener, dbmnAuthService.onAuthStateChanged(() => { void listener.announce(); }));
            void listener.start().catch(error => agentLog('[Agent] could not listen for the web app', error));
        } catch (error) {
            console.warn('[Agent] could not start the local agent', error);
        }

        // Now that dobermann is ready, give Account webview access to managers for FlexionTech migration
        accountWebview.setManagers(dobermann.getEndpointManager(), dobermann.getEnvironmentManager());


        // #415: the global Systems, configured by DBMN in Supabase, listed with the user's own.
        // Fetched again on signing in: the first sign-in brings them.
        try {
            const globalSystems = new GlobalSystemsService(context.globalState, dbmnAuthService);
            // #415: environments read their Standard System's configuration (claims, org levels)
            dobermann.getEnvironmentManager().setSystemLookup(id => dobermann.getSystemManager().getSystem(id));
            context.subscriptions.push(wireGlobalSystems(globalSystems, dobermann.getSystemManager()));
            // An own System named like a global one is switched to it (its endpoints and environments);
            // an environment with no System whose address matches a global one is linked to it
            context.subscriptions.push(wireGlobalSystemSwitch(dobermann.getSystemManager(), new SystemOperationsService(
                dobermann.getSystemManager(), dobermann.getEndpointManager(), dobermann.getEnvironmentManager()),
                dobermann.getEnvironmentManager()));
            let signedIn = dbmnAuthService.isAuthenticated();
            context.subscriptions.push(dbmnAuthService.onAuthStateChanged(state => {
                if (state.isAuthenticated && !signedIn) void globalSystems.refresh();
                signedIn = state.isAuthenticated;
            }));
        } catch (err) {
            console.warn('[GlobalSystems] Failed to initialise global Systems:', err);
        }


        // Register OAuth authentication provider
        await registerOAuthProvider(context);

        // Log architecture configuration on startup
        const { LoggerRegistry } = await import('./utils/logger-registry');
        const archLogger = LoggerRegistry.getDiagnosticLogger();

        archLogger.info('🚀 [Dobermann] Extension activated with NEW architecture');
        archLogger.info('   📋 Transaction Preparation: ✅ enabled');
        archLogger.info('   📋 Execution Coordinator: ✅ enabled');

        // Perform startup recovery for orphaned running executions
        await performStartupRecovery(dobermann.serviceContainer);

        // Run environment migration for Issue #113/#126
        // Stamps the config version and the OAuth client authentication (#415)
        try {
            const migrationService = new EnvironmentMigrationService(dobermann.getEnvironmentManager());
            const migrationStatus = await migrationService.detectMigrationRequired();

            if (migrationStatus.migrationRequired) {
                archLogger.info(`🔄 [Migration] Found ${migrationStatus.environmentsRequiringMigration.length} environments needing migration`);
                const result = await migrationService.migrateAllEnvironments();

                if (result.success) {
                    archLogger.info(`✅ [Migration] Successfully migrated ${result.migratedCount} environments`);
                } else {
                    archLogger.warn(`⚠️ [Migration] Migration completed with ${result.failedCount} failures`);
                }
            }
        } catch (migrationError) {
            archLogger.warn(`⚠️ [Migration] Environment migration failed: ${migrationError}`);
            // Non-fatal - continue activation
        }

        // Initialize and start Environment Status Service
        try {
            const { UIServiceTokens } = await import('./container/ui-services-registry');

            const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
            environmentStatusService.startAutoUpdate();

            // Add to cleanup on deactivation
            context.subscriptions.push({
                dispose: () => {
                    environmentStatusService.stopAutoUpdate();
                    environmentStatusService.dispose();
                }
            });
        } catch (error) {
            console.warn('[Extension] Could not initialize environment status service:', error);
        }

        // Register execution commands with feature flag support
        try {
            const executionCommands = new ExecutionCommands(dobermann.serviceContainer);
            executionCommands.registerCommands(context);
        } catch (error) {
            console.warn('[Extension] Could not register execution commands:', error);
        }

        // Note: Endpoint opening is handled by tree item commands (dobermann.openEndpointFromTree)
        // This ensures reopening works even when the item is already selected
        step('activated');
    } catch (error) {
        log.write({ level: 'error', source: 'start-up', message: `activation failed (+${Date.now() - started} ms): ${error instanceof Error ? error.message : String(error)}`, error });
        // Permitted native fallback: activation can fail before the toast service
        // is wired onto globals, so this must not depend on it.
        vscode.window.showErrorMessage(`Dobermann extension failed to activate: ${error instanceof Error ? error.message : error}`);
        throw error;
    }

    // Main webview command
    // ── P2a: DBMN Hub ────────────────────────────────────────────────────
    let hubManagerInstance: import('./webviews/hub/hub-manager').HubWebviewManager | undefined;
    // Pre-construct the manager on activate so the first activity-bar click
    // skips the require()/DI resolution and goes straight to createWebview.
    try {
        const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
        const deps = resolveHubDependencies(dobermann.serviceContainer);
        hubManagerInstance = new HubWebviewManager(
            context,
            deps.endpointManager,
            deps.environmentManager,
            deps.systemManager,
            dobermann
        );
        // Pre-warm the data fetches that broadcastInitialState awaits — so
        // by the time the first click arrives, sql.js WASM is loaded and
        // the manager caches are hot. Fire-and-forget; failures are
        // surfaced on the real call.
        void deps.endpointManager.getAllEndpoints().catch(() => {});
        void deps.systemManager.getAllSystems().catch(() => {});
        void deps.environmentManager.getAllEnvironments().catch(() => {});

        // GitHub Issue #286: on an extension-host restart VS Code brings back
        // the Hub editor tabs from its own persisted layout, but a webview tab
        // is inert unless an extension revives it. The result was Hub tabs
        // piling up one per restart: the dead ones were never reclaimed and the
        // pre-create below added a fresh one each time.
        //
        // Rather than depend on VS Code's restore (which can't revive tabs that
        // were persisted by a build with no serializer registered — i.e. every
        // tab a user already has), close every Hub tab we find and open exactly
        // one. The Hub's *inner* tabs are unaffected: they rehydrate from
        // HUB_TABS_SNAPSHOT_KEY, which is the state the user actually cares
        // about keeping.
        const closeStrayHubTabs = async (): Promise<number> => {
            try {
                const strays = vscode.window.tabGroups.all
                    .flatMap(group => group.tabs)
                    .filter(tab => {
                        const input: unknown = tab.input;
                        if (!(input instanceof vscode.TabInputWebview)) return false;
                        // VS Code namespaces the viewType it reports here
                        // (e.g. `mainThreadWebview-hub`), so match the suffix
                        // rather than the bare id.
                        const vt = input.viewType;
                        return vt === 'hub' || vt.endsWith('-hub');
                    });
                if (strays.length > 0) {
                    await vscode.window.tabGroups.close(strays, true);
                }
                return strays.length;
            } catch {
                // Tab housekeeping is best-effort — never block activation.
                return 0;
            }
        };

        // Registered so VS Code has an owner for the viewType and stops leaving
        // unrevivable tabs behind on future restarts. We deliberately do not
        // adopt the restored panel: `closeStrayHubTabs` + a single fresh
        // create is the one path, so there is only ever one way to end up with
        // a Hub.
        context.subscriptions.push(
            vscode.window.registerWebviewPanelSerializer('hub', {
                async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
                    panel.dispose();
                }
            })
        );

        // Setting-gated pre-create: by default open the Hub in the editor
        // strip silently (preserveFocus so the user's current editor stays
        // active). Combined with the inline-state hydration in
        // getHtmlContent, the first activity-bar click reveals an already-
        // mounted, already-populated Hub — no perceptible cold start.
        const preloadHub = vscode.workspace.getConfiguration('dbmn')
            .get<boolean>('preloadHubOnStartup', true);
        void (async () => {
            try {
                // Let VS Code finish restoring its editor layout before we
                // take stock of what's open, otherwise the strays we're here
                // to remove haven't appeared yet.
                await new Promise(resolve => setTimeout(resolve, 0));
                const closed = await closeStrayHubTabs();
                if (closed > 0) {
                    console.log(`[Hub] issue#286 closed ${closed} stray Hub tab(s) on activation`);
                }
                // Reopen when preload is on, OR when we just closed a stray —
                // a stray is proof the user had a Hub open, so replacing it is
                // the "reopen new" half of issue #286 and shouldn't depend on
                // the preload setting.
                if ((preloadHub || closed > 0) && !hubManagerInstance!.isMounted()) {
                    await hubManagerInstance!.createWebview({ context: 'hub' });
                    hubManagerInstance!.revealPanel(true);
                }
            } catch {
                // Pre-create is best-effort. Lazy fallback in openHub.
            }
        })();
    } catch {
        // If DI isn't ready yet for some reason, fall back to lazy
        // construction in the command handler below.
    }

    const openHubCommand = vscode.commands.registerCommand('dbmn.openHub', async (opts?: { section?: string }) => {
        try {
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            // Queue the section switch BEFORE createWebview so a cold-open hub
            // lands on the requested section the first time its `ready` fires.
            if (opts?.section) {
                hubManagerInstance!.navigateToSection(opts.section);
            }
            // Fast-path: the hub is already mounted (e.g. user re-clicked the
            // activity-bar icon). Just reveal it. Skips the HTML reload that
            // the generic createWebview re-entry path would otherwise trigger.
            if (hubManagerInstance!.isMounted()) {
                hubManagerInstance!.revealPanel();
                return;
            }
            await hubManagerInstance!.createWebview({ context: 'hub' });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            getToast()?.error(`Could not open DBMN Hub: ${msg}`);
        }
    });
    context.subscriptions.push(openHubCommand);

    // Ctrl/Cmd+W override — VS Code's built-in `closeActiveEditor` fires at
    // the workbench layer BEFORE the keydown reaches the iframe, so a
    // preventDefault() inside the webview can't stop it. The contributed
    // keybinding in package.json (when activeWebviewPanelId == 'hub') routes
    // the keystroke here instead. We hand off to the frontend, which runs the
    // dirty-aware close path on the active tab.
    const closeActiveHubTabCommand = vscode.commands.registerCommand('dbmn.hub.closeActiveTab', () => {
        hubManagerInstance?.requestCloseActiveTab();
    });
    context.subscriptions.push(closeActiveHubTabCommand);

    // Hub launcher — invisible "view" hooked to the DBMN activity-bar icon so
    // that clicking the icon triggers a command, not a sidebar. VS Code's
    // activity bar always opens a sidebar; we let it open momentarily, fire
    // the openHub command, then close the sidebar so the user lands directly
    // on the Hub editor tab.
    const launcherProvider: vscode.TreeDataProvider<never> = {
        getChildren: () => [],
        getTreeItem: () => ({}) as vscode.TreeItem
    };
    const launcherTreeView = vscode.window.createTreeView('dbmnHubLauncher', {
        treeDataProvider: launcherProvider
    });
    launcherTreeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            void vscode.commands.executeCommand('dbmn.openHub');
            // Defer close to the next task-queue tick (0 ms). VS Code finishes
            // its sidebar-open work in the current microtask drain, so a
            // macrotask `setTimeout(0)` lands after the open completes and
            // beats the previous 50 ms delay to the user's eye. If the race
            // ever resurfaces (stale empty sidebar after close), bump back
            // up to 16 ms — one frame is still well below perception.
            setTimeout(() => {
                void vscode.commands.executeCommand('workbench.action.closeSidebar');
            }, 0);
        }
    }, undefined, context.subscriptions);
    context.subscriptions.push(launcherTreeView);

    // Command for opening endpoint from tree - fires even when item is already selected
    // This fixes the issue where clicking a closed endpoint doesn't reopen it.
    //
    // Editing an endpoint doesn't call DBMN and doesn't need auth —
    // the user is just looking at / changing config. Issue #208's gate
    // (showInformationMessage "Sign in to DBMN to edit and run endpoints") was
    // dropped because (a) it surfaced an unwanted bottom-right toast for the
    // common case of browsing the Catalogue while signed out, and (b) the run
    // path already gates on auth where it actually matters (the API call).
    /** The Hub, created on first use from a command that opens one of its tabs. */
    const hubForCommands = () => {
        if (!hubManagerInstance) {
            const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
            const deps = resolveHubDependencies(dobermann.serviceContainer);
            hubManagerInstance = new HubWebviewManager(
                context,
                deps.endpointManager,
                deps.environmentManager,
                deps.systemManager,
                dobermann
            );
        }
        return hubManagerInstance!;
    };
    // The Console's Settings tab and the palette: the endpoint's editor as a Hub tab
    const openEndpointFromTreeCommand = vscode.commands.registerCommand('dbmn.openEndpointFromTree', async (endpointId: string) => {
        try {
            await hubForCommands().openEndpointAsTab(endpointId);
        } catch (error) {
            console.error(`[Extension] Error opening endpoint from tree:`, error);
            getToast()?.error(`Error opening endpoint: ${error}`);
        }
    });

    // GitHub Issue #232: Smart Run command — auto-detects template variables to choose API vs Batch
    const smartRunCommand = vscode.commands.registerCommand('dbmn.run', async (item: any) => {
        try {
            const endpoint = item.endpoint
                ? await dobermann.getEndpointManager().getEndpoint(item.endpoint.id)
                : undefined;

            if (!endpoint) {
                getToast()?.error('No endpoint selected');
                return;
            }

            // Detect template variables (excluding A8: auto-generated and ENV: variables).
            // Issue #257: query-param values count too — a `{{customerId}}` in a
            // query param should land on Run Batch the same as body/path templates.
            // Disabled query params are excluded (they're not sent on the wire).
            const variablePattern = /\{\{([^}]+)\}\}/g;
            const queryParamText = Object.values(endpoint.queryParams || {})
                .map((qp) => {
                    if (typeof qp === 'string') return qp;
                    if (qp && typeof qp === 'object' && 'value' in qp) {
                        const cfg = qp as { value: string; enabled: boolean };
                        return cfg.enabled === false ? '' : cfg.value;
                    }
                    return '';
                })
                .join(' ');
            const allText = (endpoint.body || '') + ' ' + (endpoint.path || '') + ' ' + queryParamText;
            let hasUserVariables = false;
            let match;
            while ((match = variablePattern.exec(allText)) !== null) {
                const varText = match[1].trim();
                if (!varText.startsWith('A8:') && !varText.startsWith('A8.') &&
                    !varText.startsWith('ENV:') && !varText.startsWith('#') && !varText.startsWith('/')) {
                    hasUserVariables = true;
                    break;
                }
            }

            if (hasUserVariables) {
                await vscode.commands.executeCommand('dbmn.runBatch', item);
            } else {
                await vscode.commands.executeCommand('dbmn.testEndpoint', item);
            }
        } catch (error) {
            console.error('[Extension] Error in smart run command:', error);
            getToast()?.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // GitHub Issue #98: Run Batch command - opens dedicated batch execution webview
    const runBatchCommand = vscode.commands.registerCommand('dbmn.runBatch', async (item: any) => {
        try {
            if (!item.endpoint) {
                getToast()?.error('No endpoint selected for batch execution');
                return;
            }

            // R3: Run Batch always opens as an embedded Hub tab. Route the
            // command (endpoint editor's "Run Batch" button, sidebar tree
            // context menu, palette) through the Hub so the prep view
            // mounts in column 3 instead of as a separate VS Code panel.
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            // GitHub Issue #247: a Console chain arrives with its rows for Step 1.
            await hubManagerInstance!.openBatchTab(item.endpoint.id, item.chain);

        } catch (error) {
            console.error('[Extension] Error opening Run Batch tab:', error);
            getToast()?.error(`Error opening Run Batch: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // #298: a compare started in a Console's Completed tab, a Hub tab like Run Batch
    const openCompareCommand = vscode.commands.registerCommand('dbmn.openCompare', async (item: { compareId?: string }) => {
        try {
            if (!item?.compareId) return;
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            await hubManagerInstance!.openCompareTab(item.compareId);
        } catch (error) {
            getToast()?.error(`Error opening Compare: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // A lookup table, opened from a query's Translate values (the Reporting list opens it in the Hub itself)
    const openLookupTableCommand = vscode.commands.registerCommand('dbmn.openLookupTable', async (id?: string) => {
        try {
            if (typeof id !== 'string' || !id) return;
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            await hubManagerInstance!.openLookupTab(id);
        } catch (error) {
            getToast()?.error(`Error opening the lookup table: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    const testEndpointCommand = vscode.commands.registerCommand('dbmn.testEndpoint', async (item: any) => {
        if (item.endpoint) {
            try {

                // Use the new architecture execution commands instead of legacy executeEndpoint
                const executionCommands = new ExecutionCommands(dobermann.serviceContainer);
                await executionCommands.runApiEndpointCommand(item);

            } catch (error) {
            }
        }
    });

    // Environment management commands
    // Route through Hub so environments open as embedded tabs, not separate panels.
    // Matches the Run Batch pattern (lines 815-830).
    const addEnvironmentCommand = vscode.commands.registerCommand('dbmn.addEnvironment', async (item?: any) => {
        try {
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            await hubManagerInstance!.addEnvironment();
        } catch (error) {
            console.error('[Extension] Error opening add environment tab:', error);
            getToast()?.error(`Error adding environment: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Edit environment command (inline gear icon)
    // Command for opening environment from tree - fires even when item is already selected
    // This fixes the issue where clicking a closed environment doesn't reopen it
    const openEnvironmentFromTreeCommand = vscode.commands.registerCommand('dbmn.openEnvironmentFromTree', async (environmentId: string) => {
        try {
            await hubForCommands().openEnvironmentAsTab(environmentId);
        } catch (error) {
            console.error(`[Extension] Error opening environment from tree:`, error);
            getToast()?.error(`Error opening environment: ${error}`);
        }
    });

    // Command to open the current active environment (used by status bar)
    const openCurrentEnvironmentCommand = vscode.commands.registerCommand('dbmn.openCurrentEnvironment', async () => {
        try {
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            const activeEnv = await dobermann.getActiveEnvironment();
            await hubManagerInstance!.openEnvironmentAsTab(activeEnv?.id);
        } catch (error) {
            getToast()?.error(`Error opening current environment: ${error}`);
        }
    });



    const setActiveEnvironmentCommand = vscode.commands.registerCommand('dbmn.setActiveEnvironment', async (item: any) => {
        if (item && item.environment) {
            try {
                const environmentManager = dobermann.getEnvironmentManager();
                const environmentId = item.environment.id;

                await environmentManager.setActiveEnvironment(environmentId);
            } catch (error) {
                console.error('[Extension] Failed to set active environment:', error);
                getToast()?.error(`Failed to activate environment: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });

    // Folder management commands (environment-only — endpoint folders were
    // superseded by the System + URL-segment tree)
    // Import/Export command
    const openImportExportWebview = async (startMode?: 'import' | 'export') => {
        const importExportWebview = new ImportExportWebviewManager(
            context,
            dobermann.serviceContainer,
            dobermann.getEndpointManager(),
            dobermann.getEnvironmentManager()
        );
        await importExportWebview.createWebview({
            context: 'import-export' as any,
            itemId: undefined,
            data: startMode ? { startMode } : undefined
        });
    };

    const importExportCommand = vscode.commands.registerCommand('dbmn.importExport', async () => {
        try {
            await openImportExportWebview();
        } catch (error) {
            console.error('[Extension] Error opening import/export:', error);
            getToast()?.error(`Error opening import/export: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Hub > Import — skips the landing chooser and goes straight to the
    // Import page (file picker + conflict resolution).
    const importConfigCommand = vscode.commands.registerCommand('dbmn.importConfig', async () => {
        try {
            await openImportExportWebview('import');
        } catch (error) {
            getToast()?.error(`Could not open Import: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Hub > Export — skips the landing and lands on the Export selection page.
    const exportConfigCommand = vscode.commands.registerCommand('dbmn.exportConfig', async () => {
        try {
            await openImportExportWebview('export');
        } catch (error) {
            getToast()?.error(`Could not open Export: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Test commands for development
    const testWorkspaceFileCommand = vscode.commands.registerCommand('dbmn.testWorkspaceFile', async () => {
        try {
            const mockResponse = {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json', 'x-mock-response': 'true' },
                data: {
                    users: [
                        { id: 1, name: 'John Doe', email: 'john@test.com' },
                        { id: 2, name: 'Jane Smith', email: 'jane@test.com' }
                    ],
                    pagination: { page: 1, totalItems: 2 }
                }
            };

            const result = await dobermann.createWorkspaceResultFile(
                mockResponse,
                'GET',
                '/api/users',
                245
            );

            if (result.success) {
            } else {
            }
        } catch (error) {
        }
    });

    // Command to open files in read-only mode
    const openFileReadOnlyCommand = vscode.commands.registerCommand('dbmn.openFileReadOnly', async (filePath: string) => {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);

            // Open the document in a read-only editor
            await vscode.window.showTextDocument(document, {
                preview: true,
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.Active
            });

            // Make the editor read-only by executing the command to toggle read-only mode
            await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');

        } catch (error) {
            getToast()?.error(`Failed to open file: ${error instanceof Error ? error.message : error}`);
        }
    });

    const viewTransactionReportCommand = vscode.commands.registerCommand('dbmn.viewTransactionReport', async (item: any) => {
        try {
            const executionId = item.id || item.executionId;
            const isBatch = item.isBatch || item.contextValue?.includes('batch');

            // R3: Console always opens as an embedded Hub tab. Route all
            // callers (sidebar tree, progress adapter, individual engine,
            // batch run) through the Hub so the Console renders inside
            // column 3 instead of as a separate VS Code editor panel.
            if (!hubManagerInstance) {
                const { HubWebviewManager, resolveHubDependencies } = require('./webviews/hub/hub-manager');
                const deps = resolveHubDependencies(dobermann.serviceContainer);
                hubManagerInstance = new HubWebviewManager(
                    context,
                    deps.endpointManager,
                    deps.environmentManager,
                    deps.systemManager,
                    dobermann
                );
            }
            await hubManagerInstance!.openConsoleTab(executionId, !!isBatch, item.focus !== false);
            return;


        } catch (error) {
            getToast()?.error(`Failed to open console: ${error instanceof Error ? error.message : String(error)}`);
        }
    });



    // Helper function to get environment ID from tree item
    function getEnvironmentIdFromItem(item?: any): string | undefined {
        if (!item) {
            return undefined;
        }

        // Check if item is an environment tree item
        if (item.itemType === 'environment' && item.environment) {
            return item.environment.id;
        }

        // Check if item has environment property directly
        if (item.environment && item.environment.id) {
            return item.environment.id;
        }

        // Check if item has environmentId property
        if (item.environmentId) {
            return item.environmentId;
        }

        return undefined;
    }

    // OAuth Commands
    const oauthSignInCommand = vscode.commands.registerCommand('dbmn.oauth.signIn', async (item?: any) => {
        try {
            const environmentId = getEnvironmentIdFromItem(item);
            if (!environmentId) {
                getToast()?.error('Please select an environment to sign in');
                return;
            }

            const serviceContainer = dobermann.serviceContainer;
            const oauthService = serviceContainer.resolve<OAuthService>('IOAuthService');

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'OAuth Authentication',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Starting OAuth authentication...' });
                await oauthService.authenticate(environmentId);
                progress.report({ message: 'Authentication successful!' });
            });

            // Refresh tree to show updated auth status
            // Update status bar to reflect OAuth authentication
            try {
                const { UIServiceTokens } = await import('./container/ui-services-registry');
                const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
                await environmentStatusService.updateDisplay();
            } catch (error) {
                console.error('[OAuth] Failed to update status bar:', error);
            }

            getToast()?.info('OAuth authentication successful!');
        } catch (error) {
            getToast()?.error(`OAuth sign-in failed: ${error instanceof Error ? error.message : error}`);
        }
    });

    const oauthSignOutCommand = vscode.commands.registerCommand('dbmn.oauth.signOut', async (item?: any): Promise<boolean> => {
        try {
            const environmentId = getEnvironmentIdFromItem(item);
            if (!environmentId) {
                getToast()?.error('Please select an environment to sign out');
                return false;
            }

            const confirmed = await confirmDestructive({
                title: 'Sign out?',
                body: 'Are you sure you want to sign out? This will remove your OAuth tokens.',
                confirmLabel: 'Sign Out'
            });

            if (confirmed) {
                const serviceContainer = dobermann.serviceContainer;
                const oauthService = serviceContainer.resolve<OAuthService>('IOAuthService');

                await oauthService.signOut(environmentId);

                // Refresh tree to show updated auth status
                // Update status bar to reflect sign-out
                try {
                    const { UIServiceTokens } = await import('./container/ui-services-registry');
                    const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
                    await environmentStatusService.updateDisplay();
                } catch (error) {
                    console.error('[OAuth] Failed to update status bar:', error);
                }

                getToast()?.info('Successfully signed out');
                return true;
            }

            // User cancelled sign-out
            return false;
        } catch (error) {
            getToast()?.error(`OAuth sign-out failed: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    });

    const oauthRefreshCommand = vscode.commands.registerCommand('dbmn.oauth.refresh', async (item?: any) => {
        try {
            const environmentId = getEnvironmentIdFromItem(item);
            if (!environmentId) {
                getToast()?.error('Please select an environment to refresh tokens');
                return;
            }

            const serviceContainer = dobermann.serviceContainer;
            const oauthService = serviceContainer.resolve<OAuthService>('IOAuthService');

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing OAuth Token',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Refreshing authentication token...' });
                await oauthService.refreshToken(environmentId);
                progress.report({ message: 'Token refreshed successfully!' });
            });

            // Refresh tree to show updated auth status
            // Update status bar to reflect refreshed token
            try {
                const { UIServiceTokens } = await import('./container/ui-services-registry');
                const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
                await environmentStatusService.updateDisplay();
            } catch (error) {
                console.error('[OAuth] Failed to update status bar:', error);
            }

            getToast()?.info('OAuth token refreshed successfully!');
        } catch (error) {
            getToast()?.error(`OAuth token refresh failed: ${error instanceof Error ? error.message : error}`);
        }
    });

    const oauthRequestNewTokenCommand = vscode.commands.registerCommand('dbmn.oauth.requestNewToken', async (item?: any) => {
        try {
            const environmentId = getEnvironmentIdFromItem(item);
            if (!environmentId) {
                getToast()?.error('Please select an environment to request a new token');
                return;
            }

            const serviceContainer = dobermann.serviceContainer;
            const oauthService = serviceContainer.resolve<OAuthService>('IOAuthService');

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Requesting New Token',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Signing out and requesting fresh credentials...' });
                await oauthService.requestNewToken(environmentId);
                progress.report({ message: 'New token obtained successfully!' });
            });

            // Refresh tree to show updated auth status
            // Update status bar
            try {
                const { UIServiceTokens } = await import('./container/ui-services-registry');
                const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
                await environmentStatusService.updateDisplay();
            } catch (error) {
                console.error('[OAuth] Failed to update status bar:', error);
            }

            getToast()?.info('New OAuth token obtained successfully!');
        } catch (error) {
            getToast()?.error(`Request new token failed: ${error instanceof Error ? error.message : error}`);
        }
    });

    const oauthHasRefreshTokenCommand = vscode.commands.registerCommand('dbmn.oauth.hasRefreshToken', async (item?: any) => {
        try {
            const environmentId = getEnvironmentIdFromItem(item);
            if (!environmentId) {
                return false;
            }
            const serviceContainer = dobermann.serviceContainer;
            const oauthService = serviceContainer.resolve<OAuthService>('IOAuthService');

            // Check if the environment has refresh token capability
            return await oauthService.hasRefreshToken(environmentId);
        } catch (error) {
            console.error(`OAuth refresh token check failed: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    });

    // Workspace Management Commands
    const selectWorkspaceFolderCommand = vscode.commands.registerCommand('dbmn.selectWorkspaceFolder', async () => {
        try {
            const workspaceManager = (global as any).dobermannWorkspaceManager as WorkspaceManagerService;
            if (!workspaceManager) {
                getToast()?.error('Workspace manager not initialized');
                return;
            }

            const selected = await workspaceManager.selectWorkspaceFolder();
            if (selected) {
                getToast()?.info('Dobermann workspace folder updated successfully!');

                // Refresh trees to reflect new workspace
            }
        } catch (error) {
            getToast()?.error(`Failed to select workspace folder: ${error instanceof Error ? error.message : error}`);
        }
    });

    // Environment Status Menu Command
    const environmentStatusMenuCommand = vscode.commands.registerCommand('dbmn.environmentStatusMenuClick', async () => {
        try {
            const { UIServiceTokens } = await import('./container/ui-services-registry');
            const environmentStatusService = dobermann.serviceContainer.resolve(UIServiceTokens.EnvironmentStatusService) as any;
            await environmentStatusService.showEnvironmentStatusMenu();
        } catch (error) {
            getToast()?.error(`Failed to show environment status menu: ${error instanceof Error ? error.message : error}`);
        }
    });

    const openDobermannWorkspaceCommand = vscode.commands.registerCommand('dbmn.openWorkspace', async () => {
        try {
            const workspaceManager = (global as any).dobermannWorkspaceManager as WorkspaceManagerService;
            if (!workspaceManager) {
                getToast()?.error('Workspace manager not initialized');
                return;
            }

            await workspaceManager.openWorkspace();
        } catch (error) {
            getToast()?.error(`Failed to open Dobermann workspace: ${error instanceof Error ? error.message : error}`);
        }
    });

    // Internal command for webview closure notification (not exposed in command palette)
    const webviewClosedCommand = vscode.commands.registerCommand('dbmn.internal.webviewClosed', async (data) => {
        try {
            const { context, itemId } = data;
            dobermann.handleWebviewClosed(context, itemId);
        } catch (error) {
            console.error('[Extension] Error handling webview closure:', error);
        }
    });


    // Subscribe to all commands and views
    context.subscriptions.push(
        openEndpointFromTreeCommand,
        smartRunCommand, // GitHub Issue #232: Smart Run command
        runBatchCommand, // GitHub Issue #98: Run Batch moved to dedicated webview
        openCompareCommand, // #298
        openLookupTableCommand,
        testEndpointCommand,
        addEnvironmentCommand,
        openEnvironmentFromTreeCommand,
        openCurrentEnvironmentCommand,
        setActiveEnvironmentCommand,
        webviewClosedCommand,
        importExportCommand,
        importConfigCommand,
        exportConfigCommand,
        testWorkspaceFileCommand,
        openFileReadOnlyCommand,
        viewTransactionReportCommand,
        oauthSignInCommand,
        oauthSignOutCommand,
        oauthRefreshCommand,
        oauthRequestNewTokenCommand,
        oauthHasRefreshTokenCommand,
        selectWorkspaceFolderCommand,
        environmentStatusMenuCommand,
        openDobermannWorkspaceCommand
    );


    // Refresh tree when endpoints or environments change
    const refreshTreeOnChange = () => {
    };

    // Set up listeners for endpoint and environment changes
    context.subscriptions.push(
        dobermann.getEndpointManager().onEndpointsChanged(refreshTreeOnChange),
        dobermann.getEnvironmentManager().onEnvironmentsChanged(refreshTreeOnChange)
    );


    // Create global logger instance for easy access throughout the extension
    // This provides a simple API while using the rich logging system underneath
    const createGlobalLogger = () => {
        const service = dobermann.serviceContainer?.resolve<IExecutionLoggingService>(CoreServiceTokens.ExecutionLoggingService);
        return service ? {
            log: (executionId: string, level: 'info' | 'warn' | 'error' | 'debug', message: string) => service.log(executionId, level, message),
            info: (executionId: string, message: string) => service.info(executionId, message),
            warn: (executionId: string, message: string) => service.warn(executionId, message),
            error: (executionId: string, message: string) => service.error(executionId, message),
            debug: (executionId: string, message: string) => service.debug(executionId, message),
            // Access to the rich API for complex events
            logExecution: (executionId: string, event: any) => service.logExecutionEvent(executionId, event)
        } : null;
    };

    // Register execution logger professionally via LoggerRegistry
    import('./utils/logger-registry').then(({ LoggerRegistry }) => {
        const executionLogger = createGlobalLogger();
        if (executionLogger) {
            LoggerRegistry.setExecutionLogger(executionLogger);
        } else {
            console.warn('⚠️ Dobermann execution logger failed to initialize - ExecutionLoggingService not available');
        }
    }).catch(() => {
        console.warn('⚠️ LoggerRegistry import failed - falling back to no execution logging');
    });
}

/**
 * Register the OAuth authentication provider for environments (any System)
 * Following Architecture.md - Service registration patterns
 */
async function registerOAuthProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Create OAuth service dependencies
        const environmentManager = dobermann.getEnvironmentManager();
        const configService = new OAuthConfigService(environmentManager, dobermann.getSystemManager());

        // Get diagnostic logger for OAuth services
        const { LoggerRegistry } = await import('./utils/logger-registry');
        const oauthLogger = LoggerRegistry.getDiagnosticLogger();

        const flowHandler = new OAuthFlowHandler(oauthLogger, {
            redirectUri: () => vscode.workspace.getConfiguration('dbmn.oauth').get<string>('redirectUri'),
            // #415: token requests say who is asking; a Standard System's row can override it
            userAgent: () => `Dobermann/${String(context.extension.packageJSON.version ?? '')}`
        });
        const tokenService = new OAuthTokenService(context);
        // #367: an older version kept pasted tokens here in plain text; nothing reads them now
        await context.globalState.update('oauth_sessions', undefined);
        await context.globalState.update('oauth_session_mapping', undefined);

        // Create OAuth authentication provider
        const authProvider = new TenantAuthProvider(context, configService, flowHandler);
        // #359: refresh tokens in SecretStorage; a refresh updates the session and the request token
        const refresher = new OAuthTokenRefresher({
            vault: context.secrets,
            flow: flowHandler,
            config: id => configService.getConfig(id),
            saveAccessToken: async (id, token) => {
                await authProvider.replaceAccessToken(id, token);
                await environmentManager.setEnvironmentToken(id, token.access_token);
            },
            log: (message, error) => (error ? oauthLogger.warn(message, error instanceof Error ? error : undefined) : oauthLogger.info(message))
        });
        authProvider.refresher = refresher;

        // Create main OAuth service
        const oauthService = new OAuthService(
            environmentManager,
            configService,
            tokenService,
            authProvider,
            flowHandler,
            oauthLogger,
            refresher
        );

        // Register OAuth service in the service container
        const serviceContainer = dobermann.serviceContainer;
        serviceContainer.registerSingleton('IOAuthService', oauthService);

        // Register authentication provider with VS Code
        const authProviderDisposable = vscode.authentication.registerAuthenticationProvider(
            TenantAuthProvider.getProviderId(),
            TenantAuthProvider.getProviderLabel(),
            authProvider,
            { supportsMultipleAccounts: false }
        );

        // Add to context subscriptions for cleanup
        context.subscriptions.push(authProviderDisposable);

        // Store OAuth service instance for global access (could be added to service container later)
        (global as any).oauthService = oauthService;

        // OAuth authentication provider registered successfully

    } catch (error) {
        console.error('❌ Failed to register OAuth authentication provider:', error);
        // Don't throw - OAuth failure shouldn't prevent extension activation
    }
}

export async function deactivate() {
    if (dobermann) {
        dobermann.dispose();
    }
    await appLog?.flush();
}
