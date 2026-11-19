// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Runs in the web app (#343): the same pipeline VS Code's ServiceBootstrap wires (preparation,
 * engines, the sql.js run history, FetchRequestExecutor), over the browser's filesystem
 * (./node/fs.ts). History and its files stay in this browser, as they stay on the machine in
 * VS Code. Requests go from the browser to the API: one that refuses the browser (CORS) needs
 * DBMN for VS Code.
 */
import { appLog } from './app-log';
import { DATA_DIR, LEGACY_DATA_DIR } from '../../../src/services/workspace/workspace-layout';
import { QueryFileStore } from '../../../src/services/query/query-file-store';
import { listRunFiles, readRunFile, RUN_ARCHIVE_NAME, runFileExists, writeRunFile } from '../../../src/services/run-content/run-content-store';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import { folderRoot, loadFromFolder, onFolderChange } from './node/fs';
import { AGENT_WAITING_FOR, AgentClient, routeByEnvironment } from '../../../src/services/agent/local-agent';
import { accountAgentListeners } from '../../../src/platform/supabase/agent-discovery';
import { AGENT_CONNECT_EXPLAINER, loopbackTransport, type LoopbackPermission } from '../../../src/services/agent/agent-loopback';
import type { ModalHost } from '../../../src/screens/modal.types';
import { agentBrowserSignIn } from './oauth';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import schemaSql from '../../../src/services/storage/sqlite-schema.sql?raw';
import type { EnvironmentConfig, EnvironmentManager } from '../../../src/environmentManager';
import type { IConfiguration } from '../../../src/platform/interfaces/configuration.interface';
import type { APIEndpointManager } from '../../../src/apiEndpointManager';
import { JsonGenerator } from '../../../src/data-loading/json-generator';
import { TemplateParser } from '../../../src/data-loading/template-parser';
import { ConsoleProgressSink } from '../../../src/screens/console/console-progress-sink';
import { BatchExecutionEngine } from '../../../src/services/execution/batch-execution-engine.service';
import { ExecutionFileService } from '../../../src/services/execution/execution-file.service';
import { ExecutionMetadataService } from '../../../src/services/execution/execution-metadata.service';
import { ExecutionService } from '../../../src/services/execution/execution.service';
import { FetchRequestExecutor } from '../../../src/services/execution/fetch-request-executor';
import { IndividualExecutionEngine } from '../../../src/services/execution/individual-execution-engine.service';
import type { IRequestExecutor, RequestEnvironment, RequestEnvironmentLookup } from '../../../src/services/execution/request-executor.interface';
import type { BatchExecutionEngineDependencies } from '../../../src/services/execution/batch-execution-engine.interface';
import type { IDbmnTelemetry } from '../../../src/services/dbmn-auth/dbmn-auth.interface';
import type { IExtensionDiagnosticLogger } from '../../../src/services/logging/extension-diagnostic-logger.interface';
import { DatabaseAdapter } from '../../../src/services/storage/database-adapter';
import { SqlJsEngineLoadError, SqlJsExecutionStorage } from '../../../src/services/storage/sqljs-execution-storage.service';
import { TransactionCreator } from '../../../src/services/transaction-creator/transaction-creator.service';
import { BatchMemberTransactionHandler } from '../../../src/services/transaction-preparation/handlers/batch-member-transaction.handler';
import { BatchTransactionHandler } from '../../../src/services/transaction-preparation/handlers/batch-transaction.handler';
import { IndividualTransactionHandler } from '../../../src/services/transaction-preparation/handlers/individual-transaction.handler';
import { ArrayRepetitionHelper } from '../../../src/services/transaction-preparation/helpers/array-repetition.helper';
import { PathGeneratorHelper } from '../../../src/services/transaction-preparation/helpers/path-generator.helper';
import { TransactionPreparationService } from '../../../src/services/transaction-preparation/transaction-preparation.service';
import { decodeJwtPayload } from '../../../src/utils/jwt-payload';
import { ExecutionLoggingService } from '../../../src/services/logging/execution-logging.service';
import { openAgentIdentity } from './agent-identity';
import { desktopBridge } from './desktop';
import { bridgeFetch } from '../../../src/services/desktop/desktop-fetch';
import { getBackend } from '../../../src/services/dbmn-backend/backend-config';

/**
 * Where the web app's runs keep their files: this browser's own storage (`/dbmn`), or with the
 * workspace folder picked (#344), VS Code's own path for that folder, so both store the same
 * paths. Set once at start-up, before startExecution.
 */
export let WORKSPACE_ROOT = '/dbmn';
/** This browser's own storage: where runs go while the workspace folder isn't connected. */
const BROWSER_ROOT = '/dbmn';
/** A stored path's folder: VS Code on Windows stores backslashes. */
const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

/** A query's file views keep their rows beside the history database: in the browser, or the workspace folder. */
export const queryFiles = new QueryFileStore({
    dataDir: async () => `${WORKSPACE_ROOT}/${DATA_DIR}`,
    preload: folder => loadFromFolder([], [folder])
});

export function useWorkspaceRoot(root: string): void {
    WORKSPACE_ROOT = root;
}
const SCHEMA_PATH = '/dbmn-app/sqlite-schema.sql';

/** Dobermann issue 7: the old logging writes to the app's log (warnings and errors also reach the console). */
export const webLogger: IExtensionDiagnosticLogger = appLog.logger();

export interface WebExecution {
    metadata: ExecutionMetadataService;
    store: DatabaseAdapter;
    preparation: TransactionPreparationService;
    engine: BatchExecutionEngine;
    individualEngine: IndividualExecutionEngine;
    executionService: ExecutionService;
    transactionCreator: TransactionCreator;
    progressSink: ConsoleProgressSink;
    logging: ExecutionLoggingService;
    /** #344: before a run's Console opens, its files from the workspace folder (nothing without one). */
    preloadRun(executionId: string): Promise<void>;
    /** #344: runs moved from this browser into the workspace folder at start-up. */
    movedFromBrowser: number;
    /** #344 step 4: DBMN for VS Code, for environments that run in the local agent. None in the desktop app. */
    agent?: AgentClient;
}

/**
 * The browser's say on this site reaching apps on this device (Chrome's Local Network Access).
 * `unknown` where there is nothing to ask: a page that is itself on this device (a dev server),
 * or a browser without the permission (Firefox, Safari).
 */
async function loopbackPermission(): Promise<LoopbackPermission> {
    // Dev only: an e2e test runs this page in a Chromium told to count it as a public site, and says so
    const countedAsPublic = import.meta.env.DEV && (window as unknown as { __DBMN_E2E_PUBLIC_SITE__?: boolean }).__DBMN_E2E_PUBLIC_SITE__ === true;
    if (!countedAsPublic && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) return 'unknown';
    for (const name of ['loopback-network', 'local-network-access']) {
        try {
            return (await navigator.permissions.query({ name: name as PermissionName })).state;
        } catch {
            // not a permission this browser knows by that name
        }
    }
    return 'unknown';
}

export interface StartExecutionDeps {
    client: SupabaseClient;
    environments: EnvironmentManager;
    /** For run counters ({{A8:sequence}}, #366): without it every run drew the start value, 1001. */
    endpoints: APIEndpointManager;
    settings: IConfiguration;
    openConsole(executionId: string, isBatch: boolean, focus?: boolean): Promise<void>;
    /** #344: runs another writer (VS Code) saved to the workspace folder are in now. */
    onHistoryChangedElsewhere?(): void;
    /** #344: requests started or stopped waiting for DBMN for VS Code to come. */
    onAgentWaiting?(waiting: boolean): void;
    /** #374: where the "Connect to DBMN for VS Code" explainer opens, and where a blocked browser is said. */
    agentPrompts: { modal(): ModalHost; toast: { error(message: string): void } };
    /** #344: the sign-in check, once VS Code comes for a run that waited for it (main.ts's gate). */
    ensureAuthenticated?(environment: EnvironmentConfig): Promise<boolean>;
    /** #359: after a 401, new credentials for the environment (its id, or a single run's name for it) without asking (true: try again). */
    refreshCredentials?(environmentId: string): Promise<boolean>;
    /** 0.4.1: Weekly Usage counts batches run here too (telemetry.ts). */
    telemetry?(): IDbmnTelemetry | undefined;
}

/**
 * The engine (sql-wasm.wasm) is one of the app's own files: fetched from its server in the
 * browser, so a dev server that stopped or the site being down fails here first, after the page
 * itself is up; bundled with the install on the desktop.
 */
export function engineUnavailableMessage(host = location.host, desktop = !!desktopBridge()): string {
    return desktop
        ? 'DBMN\'s own files are missing from this install. Reinstall the app.'
        : `DBMN couldn't fetch its own files from ${host}. Reload the page; if that keeps failing, the server there is down.`;
}

export async function startExecution(deps: StartExecutionDeps): Promise<WebExecution> {
    const logger = webLogger;
    fs.writeFileSync(SCHEMA_PATH, schemaSql);
    // #344: this browser's history moves from .active8 to .dbmn, once (nothing older reads it here)
    if (fs.existsSync(`${BROWSER_ROOT}/${LEGACY_DATA_DIR}`) && !fs.existsSync(`${BROWSER_ROOT}/${DATA_DIR}`)) {
        fs.renameSync(`${BROWSER_ROOT}/${LEGACY_DATA_DIR}`, `${BROWSER_ROOT}/${DATA_DIR}`);
    }

    const storage = new SqlJsExecutionStorage({
        resolveDatabaseDir: async () => `${WORKSPACE_ROOT}/${DATA_DIR}`,
        wasmPath: wasmUrl,
        schemaPath: SCHEMA_PATH,
        logger
    });
    const store = new DatabaseAdapter(storage);
    try {
        await store.initialize();
    } catch (error) {
        if (!(error instanceof SqlJsEngineLoadError)) throw error;
        appLog.write({ level: 'error', source: 'start-up', message: 'The SQLite engine did not load', error: error.cause });
        throw new Error(engineUnavailableMessage());
    }

    // #344: the workspace folder's database changed under us. VS Code saved (refresh History),
    // or our own save found it changed (merge, then save again: never over theirs)
    const databaseFile = `${WORKSPACE_ROOT}/${DATA_DIR}/executions.db`;
    onFolderChange((changed, reason) => {
        if (changed !== databaseFile) return;
        const merged = storage.refreshFromDisk({ save: reason === 'conflict' });
        appLog.write({ level: 'info', source: 'app', message: `Run history ${merged ? 'merged from the workspace folder' : 'already up to date'} (${reason})` });
        if (merged) deps.onHistoryChangedElsewhere?.();
    });
    // Never in the way of starting: what didn't move stays in the browser and moves next time
    const movedFromBrowser = folderRoot()
        ? await moveBrowserRuns(storage, logger).catch(error => { appLog.write({ level: 'warn', source: 'app', message: 'Could not move this browser\'s runs into the workspace folder yet', error }); return 0; })
        : 0;
    const preloadRun = async (executionId: string): Promise<void> => {
        if (!folderRoot()) return;
        const run = await storage.getExecution(executionId);
        if (!run) return;
        const own = [run.requestFile, run.responseFile, run.logPath].filter((p): p is string => !!p);
        if (run.executionType === 'batch') {
            // A batch keeps everything in its own folder: load that folder. Its own input file is
            // there too, so the folder is known before any member has a response (a resume after
            // a reload: its unsent members' bodies are in that archive)
            const members = await storage.getBatchMemberFiles(executionId);
            const folders = new Set([...members.map(m => m.responseFile), run.requestFile].filter((p): p is string => !!p).map(parentOf));
            await loadFromFolder(own, [...folders]);
            return;
        }
        // An individual run: its own files and its folder's archive, never the whole folder
        const archives = own.map(p => `${parentOf(p)}/${RUN_ARCHIVE_NAME}`);
        await loadFromFolder([...new Set([...own, ...archives])]);
    };

    const metadata = new ExecutionMetadataService({ executionMetadataManager: store, dobermannInstance: {} }, logger);
    const files = new ExecutionFileService({ logger, dobermannInstance: undefined, vscodeAPI: undefined });
    // Each transaction's log, beside its request and response in the run's content archive (#358)
    const logging = new ExecutionLoggingService({ executionMetadataService: metadata }, logger);
    const transactionCreator = new TransactionCreator(metadata, files, logger, undefined, logging);
    const progressSink = new ConsoleProgressSink((executionId, options) => deps.openConsole(executionId, options.isBatch, options.focus !== false));

    const pathGenerator = new PathGeneratorHelper();
    const jsonGenerator = new JsonGenerator(deps.endpoints);
    const preparation = new TransactionPreparationService({
        individualHandler: new IndividualTransactionHandler(transactionCreator, pathGenerator, jsonGenerator),
        batchHandler: new BatchTransactionHandler(transactionCreator, pathGenerator),
        batchMemberHandler: new BatchMemberTransactionHandler(transactionCreator, pathGenerator, new TemplateParser(), jsonGenerator),
        arrayRepetitionHelper: new ArrayRepetitionHelper(),
        executionMetadataService: metadata,
        executionLoggingService: logging,
        transactionCreator,
        jsonGenerator,
        progressSink
    }, logger);

    const environments = {
        getEnvironment: (id: string) => deps.environments.getEnvironment(id) as Promise<RequestEnvironment | undefined>,
        getActiveEnvironment: () => deps.environments.getActiveEnvironment() as Promise<RequestEnvironment | undefined>
    };
    // #392: the desktop app sends from its main process (no CORS); a browser sends from the page
    const desktop = desktopBridge();
    const browserExecutor = new FetchRequestExecutor({
        environments,
        fetch: desktop ? bridgeFetch(desktop) : undefined,
        // The token by the environment's auth method (Dobermann.acquireRequestToken in VS Code)
        getToken: async environment => {
            const env = environment as EnvironmentConfig | undefined;
            switch (env?.authMethod) {
                case 'dbmn':
                    return (await deps.client.auth.getSession()).data.session?.access_token;
                case 'none':
                    return undefined;
                case 'google-service-account':
                    throw new Error('Google service accounts run in DBMN for VS Code for now.');
                default:
                    return env ? deps.environments.getEnvironmentToken(env.id) : undefined;
            }
        },
        secretSink: value => appLog.addSecret(value),
        logger
    });
    // #344 step 4, #374: in the web app, environments set to "Run in: Local agent" send each
    // prepared request through DBMN for VS Code, over loopback; the rest go from the browser.
    // The desktop app sends every request itself, whatever Run in says: no VS Code link at all
    const viaAgent = desktop ? undefined : await agentRouting(deps, browserExecutor, environments, progressSink);
    const requestExecutor = viaAgent?.requestExecutor ?? browserExecutor;
    const agent = viaAgent?.agent;
    const readiness = viaAgent?.readiness;

    const executionService = new ExecutionService({
        executionValidationService: {},
        executionMetadataService: metadata,
        executionFileService: files,
        dobermannInstance: undefined,
        requestExecutor,
        environments,
        executionLoggingService: logging,
        progressSink // Issue #115: "Receiving…" in the Console
    }, logger);

    const engine = new BatchExecutionEngine({
        executionMetadataService: metadata,
        executionService,
        transactionCreator,
        transactionPreparationService: preparation,
        executionLoggingService: logging,
        progressSink,
        configuration: deps.settings,
        readiness,
        refreshCredentials: deps.refreshCredentials,
        dbmnTelemetry: deps.telemetry
    }, logger);

    const individualEngine = new IndividualExecutionEngine({ executionMetadataService: metadata, executionService, progressSink, refreshCredentials: deps.refreshCredentials }, logger);

    return { metadata, store, preparation, engine, individualEngine, executionService, transactionCreator, progressSink, logging, preloadRun, movedFromBrowser, agent };
}

/**
 * #344 step 4, #374: the web app's routing by "Run in". Environments set to Local agent send each
 * prepared request through DBMN for VS Code, over loopback (waiting, queued, until it's there);
 * the rest go from the browser.
 */
async function agentRouting(
    deps: StartExecutionDeps,
    browserExecutor: FetchRequestExecutor,
    environments: RequestEnvironmentLookup,
    progressSink: ConsoleProgressSink
): Promise<{ agent: AgentClient; requestExecutor: IRequestExecutor; readiness: NonNullable<BatchExecutionEngineDependencies['readiness']> }> {
    const userId = (await deps.client.auth.getSession()).data.session?.user.id ?? '';
    const transport = loopbackTransport({
        listeners: () => accountAgentListeners(deps.client),
        fetch: (url, init) => fetch(url, { ...init, cache: 'no-store' }),
        permission: loopbackPermission,
        explain: async () => (await deps.agentPrompts.modal().showModal(AGENT_CONNECT_EXPLAINER)).actionId === 'continue',
        say: message => deps.agentPrompts.toast.error(message),
        blocksLoopback: /Safari\//.test(navigator.userAgent) && !/Chrom(e|ium)\//.test(navigator.userAgent),
        log: (message, error) => console.warn(message, error)
    });
    const agent = new AgentClient(transport, () => userId,
        {
            // Who is asking: every message is signed with this browser's key (its public half is on the account)
            signer: await openAgentIdentity(`${getBackend().profile}:${userId}`, deps.client),
            browserSignIn: agentBrowserSignIn(),
            environment: id => deps.environments.getEnvironment(id),
            onWaiting: waiting => deps.onAgentWaiting?.(waiting),
            // A run's Console says it's waiting (Queued: Please open VS Code), then that it's going
            onRequestWaiting: (executionId, waiting) => progressSink.progress(executionId, {
                executionId, title: '', message: waiting ? `Please open ${AGENT_WAITING_FOR}` : 'Running',
                totalProgress: 0, startTime: Date.now(), timestamp: Date.now(),
                ...(waiting ? { status: 'pending', queued: true, waitingFor: AGENT_WAITING_FOR } : { status: 'running' })
            })
        });
    // A batch for an environment that runs in DBMN for VS Code waits, queued, until VS Code is
    // there; then the sign-in check (the run's own was skipped while VS Code was away)
    const waitedFor = new Set<string>();
    const readiness = async (environmentId: string): Promise<{ waitingFor: string } | { stop: string } | undefined> => {
        const environment = await deps.environments.getEnvironment(environmentId);
        if (environment?.runOn !== 'local-agent') return undefined;
        if (!(await agent.connected().catch(() => false))) {
            waitedFor.add(environmentId);
            return { waitingFor: AGENT_WAITING_FOR };
        }
        if (waitedFor.delete(environmentId) && deps.ensureAuthenticated && !(await deps.ensureAuthenticated(environment))) {
            return { stop: 'not signed in to the environment in DBMN for VS Code' };
        }
        return undefined;
    };
    const requestExecutor = routeByEnvironment({
        environments,
        browser: browserExecutor,
        agent,
        // #356: asked without CORS, any answer (opaque) means a server is there and kept the browser out
        reachable: url => fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false),
        // A single run waits for VS Code without leaving its request behind; then the sign-in check
        beforeAgentRequest: async (environment, signal, options) => {
            const waited = await agent.waitUntilConnected(signal, options?.executionId);
            if (waited && deps.ensureAuthenticated && !(await deps.ensureAuthenticated(environment))) {
                throw new Error(`Not signed in to ${environment.name} in VS Code: sign in and run it again.`);
            }
        }
    });

    return { agent, requestExecutor, readiness };
}

/**
 * #344: runs made while the workspace folder wasn't connected live in this browser's storage.
 * Connected again, they move into the folder: their history rows (paths moved to the folder's)
 * and their files (archive records added to the folder's archives, never written over them).
 * The browser keeps its copy, as a backup, until a later start finds every one of its runs in the
 * folder's history; then it lets go of them. Returns how many runs moved this time.
 */
async function moveBrowserRuns(storage: SqlJsExecutionStorage, logger: IExtensionDiagnosticLogger): Promise<number> {
    const browserDatabase = `${BROWSER_ROOT}/${DATA_DIR}/executions.db`;
    if (!fs.existsSync(browserDatabase)) return 0;
    const browser = new SqlJsExecutionStorage({
        resolveDatabaseDir: async () => `${BROWSER_ROOT}/${DATA_DIR}`,
        wasmPath: wasmUrl,
        schemaPath: SCHEMA_PATH,
        logger
    });
    await browser.initialize();
    const ids = (await browser.getExecutions()).map(e => e.id).filter((id): id is string => !!id);
    browser.close();
    if (ids.length === 0) return 0;

    // Moved on an earlier start and in the folder's history now: the browser's copy can go
    if (storage.hasExecutions(ids).size === ids.length) {
        for (const entry of fs.readdirSync(BROWSER_ROOT)) fs.rmSync(`${BROWSER_ROOT}/${entry}`, { recursive: true, force: true });
        appLog.write({ level: 'info', source: 'app', message: `${ids.length} runs this browser kept are in the workspace folder now: removed from the browser` });
        return 0;
    }

    const moved = storage.importExecutionsFrom(browserDatabase, { from: BROWSER_ROOT, to: WORKSPACE_ROOT });
    // Their files: each run folder's archive records (and loose files, a batch's input CSV)
    const folders: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir)) {
            const child = `${dir}/${entry}`;
            // Not runs: the history itself, and Export downloads older sessions kept here
            if ([DATA_DIR, LEGACY_DATA_DIR, 'exports'].some(skip => child === `${BROWSER_ROOT}/${skip}`)) continue;
            if (fs.statSync(child).isDirectory()) { folders.push(child); walk(child); }
        }
    };
    walk(BROWSER_ROOT);
    for (const dir of folders) {
        // Files only: sub-folders are walked on their own
        const names = listRunFiles(dir).filter(name => name !== RUN_ARCHIVE_NAME && !(fs.existsSync(`${dir}/${name}`) && fs.statSync(`${dir}/${name}`).isDirectory()));
        if (names.length === 0) continue;
        const target = WORKSPACE_ROOT + dir.slice(BROWSER_ROOT.length);
        // The folder's archive first, so new records are added after what's there
        await loadFromFolder([`${target}/${RUN_ARCHIVE_NAME}`, ...names.map(name => `${target}/${name}`)]);
        for (const name of names) {
            const from = `${dir}/${name}`;
            const to = `${target}/${name}`;
            if (runFileExists(to)) continue;   // already moved
            if (fs.existsSync(from) && fs.statSync(from).isFile()) fs.writeFileSync(to, fs.readFileSync(from));   // a loose file stays one
            else writeRunFile(to, readRunFile(from));
        }
    }
    if (moved) appLog.write({ level: 'info', source: 'app', message: `Moved ${moved} runs from this browser into the workspace folder` });
    return moved;
}
