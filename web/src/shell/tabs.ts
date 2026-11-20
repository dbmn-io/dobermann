// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web app's Hub tabs: the same core controllers VS Code runs, each with its own
 * ScreenSession posting through the Hub's channel into its frame.
 */
import type { APIEndpointManager } from '../../../src/apiEndpointManager';
import type { EnvironmentManager } from '../../../src/environmentManager';
import type { SystemManager } from '../../../src/systemManager';
import { confirmDestructiveInModal } from '../../../src/screens/confirm-destructive';
import { EndpointEditorController } from '../../../src/screens/endpoint/endpoint-editor.controller';
import { EnvironmentEditorController } from '../../../src/screens/environment/environment-editor.controller';
import type { HubTab, HubTabFactory, TabChannel } from '../../../src/screens/hub/hub.ports';
import type { ChainHandoff } from '../../../src/services/chain/chain-types';
import type { APIEndpointConfig } from '../../../src/apiConfigManager';
import type { StoreContext } from '../../../src/platform/interfaces/store-context.interface';
import type { HubSettings } from '../../../src/screens/hub/hub.ports';
import { ConsoleController, ConsoleWebviewConfig } from '../../../src/screens/console/console.controller';
import { buildConsolePage } from '../../../src/screens/console/console-page';
import { buildConsoleReportConfig } from '../../../src/screens/console/console-report-config';
import * as fs from 'fs';
import { takeFile } from './node/fs';
import { RunBatchController } from '../../../src/screens/run-batch/run-batch.controller';
import { CompareController } from '../../../src/screens/compare/compare.controller';
import { buildComparePage } from '../../../src/screens/compare/compare-page';
import type { ComparePorts } from '../../../src/screens/compare/compare.ports';
import { QueryController } from '../../../src/screens/query/query.controller';
import { LookupTablesStore } from '../../../src/services/lookup-tables/lookup-tables';
import { buildQueryPage } from '../../../src/screens/query/query-page';
import { buildDesignSystemPage } from '../../../src/screens/design-system/design-system-page';
import { buildLogsPage } from '../../../src/screens/logs/logs-page';
import { LogsController } from '../../../src/screens/logs/logs.controller';
import { appLog } from './app-log';
import { runHistory } from '../../../src/screens/logs/run-history';
import { LogReader } from '../../../src/services/logging/log-reader';
import { isQueryId } from '../../../src/services/query/query-store';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/** SQLite for queries, started once and shared by every Query tab. */
let sqlEngine: ReturnType<typeof initSqlJs> | undefined;
import { buildRunBatchPage } from '../../../src/screens/run-batch/run-batch-page';
import { FormatConverterService } from '../../../src/services/format-converter/format-converter.service';
import { DataTypeDetectionService } from '../../../src/services/data-type-detection/data-type-detection.service';
import { DataTransformationService } from '../../../src/services/data-transformation/data-transformation.service';
import type { BulkLoadRequest } from '../../../src/services/execution/run-orchestrator';
import type { BulkLoadResult } from '../../../src/webviews/run-batch/bulk-load-result';
import { queryFiles, WebExecution, webLogger, WORKSPACE_ROOT } from './execution';
import { lookupTab } from './lookup-tab';
import { buildEndpointPage, buildEnvironmentPage } from '../../../src/screens/pages';
import { desktopBridge } from './desktop';
import { ScreenSession } from '../../../src/screens/screen-session';
import { asset, download, screenHost, template } from './browser-host';
import { webOAuthActions } from './oauth';
import type { OAuthTokenRefresher } from '../../../src/services/oauth/oauth-refresh';

export interface WebTabDeps {
    endpoints: APIEndpointManager;
    environments: EnvironmentManager;
    systems: SystemManager;
    toast: { info(m: string): void; warn(m: string): void; error(m: string): void };
    openBatch(endpointId: string, chain?: ChainHandoff): Promise<void>;
    /** #298: a compare started in a Console: its tab opens on Match. */
    openCompare(compareId: string): Promise<void>;
    openEnvironment(environmentId: string): Promise<void>;
    openEndpoint(endpointId: string): Promise<void>;
    openConsole(executionId: string, isBatch: boolean): Promise<void>;
    /** A lookup table's tab (a query's Translate values opens the table it reads). */
    openLookup(id: string): Promise<void>;
    runEndpoint(endpoint: APIEndpointConfig): Promise<void>;
    executeBulkLoad(request: BulkLoadRequest): Promise<BulkLoadResult>;
    /** GitHub Issue #396: the DBMN sign-in, when that is why a batch did not start. */
    promptSignIn?(): Promise<void>;
    /** A compare has run: the Hub's Compare list refreshes (#298). */
    refreshHub?(): void;
    execution: WebExecution;
    state: StoreContext;
    settings: HubSettings;
    /** Re-run, Resume and Reprocess check credentials first, as a fresh Run does (#311). */
    authGate: { ensureAuthenticatedForBatch(batch: { environmentId?: string; environment?: string }): Promise<boolean> };
    /** #359: the app's OAuth refresh tokens. */
    refresher: OAuthTokenRefresher;
}

interface Screen {
    handle(message: Record<string, unknown>): Promise<void>;
    dispose(): void;
}

function tab(html: string, session: ScreenSession, screen: Screen): HubTab {
    return {
        html,
        handle: async message => {
            if (await session.handleShared(message)) return;
            await screen.handle(message);
        },
        dispose: () => {
            session.dismissAll();
            screen.dispose();
        }
    };
}

export function webTabs(deps: WebTabDeps): HubTabFactory {
    /** GitHub Issue #165: variables the endpoint editor sends to an environment, until it opens. */
    const pendingVariables = new Map<string, string[]>();
    const sessionFor = (channel: TabChannel) => new ScreenSession({ post: m => channel.post(m) }, screenHost);

    return {
        endpoint: async (config, channel) => {
            const session = sessionFor(channel);
            const controller = new EndpointEditorController(session, {
                endpoints: deps.endpoints,
                environments: deps.environments,
                systems: deps.systems,
                confirmDestructive: opts => confirmDestructiveInModal(session, opts),
                toast: deps.toast,
                readClipboard: () => navigator.clipboard.readText(),
                runApi: endpoint => deps.runEndpoint(endpoint),
                openRunBatch: endpoint => deps.openBatch(endpoint.id),
                openEnvironmentWithVariables: async (environmentId, variables) => {
                    pendingVariables.set(environmentId, variables);
                    await deps.openEnvironment(environmentId);
                },
                saveFile: (name, bytes) => download(name, bytes),
                host: { close: () => channel.close() }
            }, config);
            const endpoint = await deps.endpoints.getEndpoint(config.itemId);
            const html = buildEndpointPage(await template('endpoint/endpoint.html'), asset, endpoint, { itemId: config.itemId });
            return tab(html, session, controller);
        },
        batch: async ({ endpoint, chain }, channel) => {
            const session = sessionFor(channel);
            const controller = new RunBatchController(session, {
                endpoints: deps.endpoints,
                environments: deps.environments,
                formatConverter: new FormatConverterService(new DataTypeDetectionService(), new DataTransformationService()),
                settings: deps.settings,
                toast: deps.toast,
                executeBulkLoad: request => deps.executeBulkLoad(request),
                promptSignIn: deps.promptSignIn,
                host: {
                    close: () => channel.close(),
                    openConsole: (id, isBatch) => deps.openConsole(id, isBatch)
                }
            }, { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint, chain });
            const screen = { handle: (m: Record<string, unknown>) => controller.handleMessage(m as never), dispose: () => controller.dispose() };
            return {
                ...tab(buildRunBatchPage(asset, { endpointId: endpoint.id, endpointName: endpoint.name }), session, screen),
                applyChain: c => controller.applyChain(c)
            };
        },
        compare: async ({ compareId, endpointName, start }, channel) => {
            const session = sessionFor(channel);
            const { execution } = deps;
            const ports: ComparePorts = {
                metadata: execution.metadata,
                endpoints: deps.endpoints,
                environments: deps.environments,
                state: deps.state.globalState,
                preloadRun: id => execution.preloadRun(id),   // #344: a run's files from the workspace folder
                // An export is written, then handed over as a download, as the Console's are
                files: {
                    chooseSaveTarget: async name => `/dbmn-app/exports/${Date.now()}/${name}`,
                    exported: async path => {
                        const bytes = takeFile(path);
                        if (bytes) await download(path.split('/').pop() || 'export', bytes);
                        fs.rmSync(path, { force: true });
                    }
                },
                toast: deps.toast,
                logger: { log: () => undefined, error: (message, error) => webLogger.error(message, error instanceof Error ? error : undefined) },
                host: {
                    close: () => channel.close(),
                    openConsole: (id, batch) => deps.openConsole(id, batch),
                    compared: () => deps.refreshHub?.()
                }
            };
            if (isQueryId(compareId)) {
                // A query: Compare's ports and SQLite, started from the app's own wasm file
                const query = new QueryController(session, { ...ports, sql: () => (sqlEngine ??= initSqlJs({ locateFile: () => sqlWasmUrl })), systemName: async id => (await deps.systems.getSystem(id))?.name, openRunBatch: (endpoint, chain) => deps.openBatch(endpoint.id, chain), queryFiles, lookups: new LookupTablesStore(deps.state.globalState), openLookup: async id => { deps.openLookup(id); } }, { queryId: compareId, start });
                const queryScreen = { handle: (m: Record<string, unknown>) => query.handleMessage(m as never), dispose: () => query.dispose() };
                return { ...tab(buildQueryPage(asset, { queryId: compareId, name: endpointName }), session, queryScreen), name: `Query: ${endpointName}` };
            }
            const controller = new CompareController(session, ports, { compareId, start });
            const screen = { handle: (m: Record<string, unknown>) => controller.handleMessage(m as never), dispose: () => controller.dispose() };
            return { ...tab(buildComparePage(asset, { compareId, endpointName }), session, screen), name: `Compare: ${endpointName}` };
        },
        // A lookup table: kept with the saved queries, in this browser's state
        lookup: lookupTab({ state: deps.state.globalState, toast: deps.toast }),
        // The design system's page: components on show, nothing to run
        design: async channel => tab(buildDesignSystemPage(asset), sessionFor(channel), { handle: async () => undefined, dispose: () => undefined }),
        // Dobermann issue 7: the app's log; Save is a download, as exports are
        logs: async ({ search }, channel) => {
            const session = sessionFor(channel);
            const controller = new LogsController(session, {
                reader: new LogReader(appLog.store(), runHistory(deps.execution.metadata), () => appLog.recent()),
                requests: { events: id => deps.execution.logging.getExecutionLogs(id) },
                redact: text => appLog.redactor.text(text),
                files: { save: async (name, text) => { await download(name, new TextEncoder().encode(text)); return true; } },
                toast: deps.toast
            }, { search });
            const screen = { handle: (m: Record<string, unknown>) => controller.handleMessage(m as never), dispose: () => controller.dispose() };
            return { ...tab(buildLogsPage(asset), session, screen), search: text => controller.showSearch(text) };
        },
        console: async ({ executionId, isBatch }, channel) => {
            const session = sessionFor(channel);
            const { execution } = deps;
            await execution.preloadRun(executionId);   // #344: its files from the workspace folder
            const config = await buildConsoleReportConfig({ executionId, isBatch, executionMetadataService: execution.metadata, environments: deps.environments }) as unknown as ConsoleWebviewConfig;
            const controller = new ConsoleController(session, {
                metadata: execution.metadata,
                links: execution.store,
                batchEngine: execution.engine,
                individualEngine: execution.individualEngine,
                cancelExecution: id => execution.executionService.cancel(id),
                transactionCreator: execution.transactionCreator,
                executionLogging: execution.logging,
                authGate: deps.authGate,
                endpoints: deps.endpoints,
                environments: deps.environments,
                state: deps.state.globalState,
                settings: deps.settings,
                clipboard: navigator.clipboard,
                logger: { log: () => undefined, error: (message, error) => webLogger.error(message, error) },
                toast: deps.toast,
                files: {
                    // The browser saves downloads where it saves them: the export is written, then handed over
                    chooseSaveTarget: async name => `/dbmn-app/exports/${Date.now()}/${name}`,   // a download, never the workspace folder
                    exported: async path => {
                        const bytes = takeFile(path);
                        if (bytes) await download(path.split('/').pop() || 'export', bytes);
                        fs.rmSync(path, { force: true });
                    }
                },
                host: {
                    close: () => channel.close(),
                    openEndpoint: id => deps.openEndpoint(id),
                    openEnvironment: id => deps.openEnvironment(id),
                    openConsole: (id, batch) => deps.openConsole(id, batch),
                    openRunBatch: (endpoint, chain) => deps.openBatch(endpoint.id, chain),
                    openCompare: compareId => deps.openCompare(compareId),
                    runApi: endpoint => deps.runEndpoint(endpoint)
                }
            }, config);
            const summary = config.executionSummary || {};
            return {
                ...tab(buildConsolePage(await template('console/console.html'), asset, config), session, controller),
                ready: () => { void controller.onReady(); },
                name: summary.batchName || summary.endpointName || summary.endpointPath || `Console ${executionId.slice(0, 8)}`, // #445: a batch by its own name
                status: summary.status?.toLowerCase(),
                endpointId: config.endpointId
            };
        },
        environment: async (config, channel) => {
            const session = sessionFor(channel);
            const controller = new EnvironmentEditorController(session, {
                environments: deps.environments,
                systems: deps.systems,
                confirmDestructive: opts => confirmDestructiveInModal(session, opts),
                toast: deps.toast,
                oauth: webOAuthActions(deps.environments, deps.refresher, deps.execution.agent, deps.toast, deps.systems),
                // #344: in the web app, an environment that runs in DBMN for VS Code: its secrets are
                // entered there. The desktop app runs it itself, so they're entered here
                secretsElsewhere: environment => (deps.execution.agent && environment.runOn === 'local-agent' ? 'DBMN for VS Code' : undefined),
                takePendingVariables: async id => {
                    const variables = pendingVariables.get(id);
                    pendingVariables.delete(id);
                    return variables;
                },
                host: { close: () => channel.close() }
            }, config.itemId, config.draft);
            const environment = config.itemId ? await deps.environments.getEnvironment(config.itemId) : undefined;
            const html = buildEnvironmentPage(await template('environment/environment.html'), asset, { id: config.itemId, folder: environment?.folder }, desktopBridge() ? 'desktop' : 'web');
            return tab(html, session, controller);
        }
    };
}
