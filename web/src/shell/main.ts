// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web app's host (#343). The Hub page and its tabs are the extension's own screens
 * (src/webviews); this runs the same core controllers VS Code runs (src/screens), over the
 * same catalogue managers, with the browser and Supabase as the host.
 *
 * The page's first script (vite.config.ts) installs `acquireVsCodeApi` and queues what the
 * screens post until this has loaded the user's catalogue.
 */
// First, before any other module is evaluated: the page's backend (#377)
import '../backend';
import { chooseSystemTheme, chooseTheme, currentThemeMenu, endThemeHint, onThemeChanged, startTheme, themeHintDue } from './theme';
import { getBackend } from '../../../src/services/dbmn-backend/backend-config';
import { APIEndpointManager } from '../../../src/apiEndpointManager';
import { EnvironmentManager } from '../../../src/environmentManager';
import { SystemManager } from '../../../src/systemManager';
import { confirmDestructiveInModal } from '../../../src/screens/confirm-destructive';
import { HubController } from '../../../src/screens/hub/hub.controller';
import { ConsoleController } from '../../../src/screens/console/console.controller';
import { applyResumeChoice } from '../../../src/screens/console/batch-resume';
import type { HubTabsSnapshot } from '../../../src/screens/hub/hub.ports';
import { ScreenSession } from '../../../src/screens/screen-session';
import { SupabaseCatalogStore } from '../../../src/platform/supabase/supabase-catalog-store';
import { RunOrchestrator } from '../../../src/services/execution/run-orchestrator';
import { confirmProductionExecution } from '../../../src/services/ui/production-guard.service';
import type { APIEndpointConfig } from '../../../src/apiConfigManager';
import { HubPreferencesService } from '../../../src/services/hub-preferences/hub-preferences.service';
import { RecentEndpointsService } from '../../../src/services/recent-endpoints/recent-endpoints.service';
import { signInLinkProblem, supabase, takeHandedOverSignIn, takeSignInLink } from '../supabase';
import { accountSection } from './account';
import { webTelemetry } from './telemetry';
import { screenHost } from './browser-host';
import { accountSettings } from './account-settings';
import { CatalogueState, conflictMessage } from '../../../src/services/catalogue/catalogue-state';
import { followCatalogueChanges } from '../../../src/services/catalogue/catalogue-live';
import { webCatalogueStorageInfo, type VsCodeCatalogueSignals } from '../../../src/services/catalogue/catalogue-location';
import { accountAgentListeners } from '../../../src/platform/supabase/agent-discovery';
import { RUN_COUNTERS_LOCAL_MESSAGE } from '../../../src/services/catalogue/run-counters';
import { startGlobalSystems } from './policies';
import { listenForOAuthCallbacks, webOAuthActions, webOAuthRefresher } from './oauth';
import { AuthGate, promptAuthExpiredInModal, type IEnvironmentAuthGate } from '../../../src/services/environment/auth-gate';
import { AGENT_WAITING, agentAwareAuthGate, type AgentConnectionState } from '../../../src/services/agent/local-agent';
import { TokenExpiryService } from '../../../src/services/token/token-expiry.service';
import { browserDeviceStore } from './browser-stores';
import { loadWhatsNew } from './whats-new';
import { openBrowserVault } from './browser-vault';
import { webTabs } from './tabs';
import { queryFiles, startExecution, useWorkspaceRoot, WORKSPACE_ROOT } from './execution';
import { mountBrowserFs, mountFolder } from './node/fs';
import { BLOCKED_HELP, folderState, pickWorkspaceFolder, reconnectWorkspaceFolder, type FolderState } from './workspace-folder';
import { desktopBridge } from './desktop';
import { desktopFolder, desktopFolderSource } from './desktop-folder';
import { DATA_DIR, WORKSPACE_MARKER } from '../../../src/services/workspace/workspace-layout';

/** #344: how often the VS Code icon asks whether DBMN for VS Code is there. */
const AGENT_CONNECTION_CHECK_MS = 5_000;

type Message = Record<string, unknown>;

interface ShellWindow extends Window {
    /** Filled by the page's first script: what the screens posted before we were ready. */
    __dbmnHostQueue: Message[];
    __dbmnShell?: { receive(message: Message): void };
    /** Set by dbmn-modal.js once the page answers modal requests. */
    __dbmnModalBridgeAttached?: boolean;
}

const page = window as unknown as ShellWindow;

// #373: the page in its theme before anything else paints
startTheme();

async function start(): Promise<void> {
    const client = supabase();
    // A sign-in handed over by dbmn.io after a VS Code sign-in, out of the address bar either way
    await takeHandedOverSignIn(client);
    const session = (await client.auth.getSession()).data.session;
    // #376: an email link's code is spent (or refused) by now; out of the address bar either way
    const link = takeSignInLink();
    if (!session) {
        const problem = link.failed ? 'expired' : link.fromLink ? await signInLinkProblem() : undefined;
        location.replace(problem ? `/signin.html?link=${problem}` : '/signin.html');
        return;
    }
    // An OAuth provider comes back to /oauth-callback.html, which hands the answer to this tab
    listenForOAuthCallbacks();
    const catalogue = new SupabaseCatalogStore(client, {
        accessToken: async () => (await client.auth.getSession()).data.session?.access_token
    });
    const scope = `${getBackend().profile}:${session.user.id}`;
    const state = new CatalogueState(catalogue, browserDeviceStore(scope), await openBrowserVault(scope));
    await Promise.all([state.load(), mountBrowserFs(scope)]);

    // The Hub's page gets messages the way a webview does: as window message events
    const hubSession = new ScreenSession({ post: message => window.postMessage(message, location.origin) }, screenHost);

    // The desktop app is always on a workspace folder, which its main process owns: found, or the
    // user chooses one before anything else starts (desktop-folder.ts). Until the host below
    // exists, only that question's own messages are answered; the rest wait their turn.
    const desktop = desktopBridge();
    const held: Message[] = [];
    if (desktop) {
        const beforeHost = (message: Message) => {
            if (message.type === 'dbmnModalResult' || message.type === 'dbmnModalActionPending') void hubSession.handleShared(message);
            else held.push(message);
        };
        page.__dbmnHostQueue.splice(0).forEach(beforeHost);
        page.__dbmnShell = { receive: beforeHost };
    }
    // The Hub page starts listening for modals a moment after it loads (dbmn-modal.js): a question
    // asked before that would be lost, and the app would wait on it for good
    const onceModalsListen: typeof hubSession.showModal = async spec => {
        while (!page.__dbmnModalBridgeAttached) await new Promise(resolve => setTimeout(resolve, 25));
        return hubSession.showModal(spec);
    };
    const desktopRoot = desktop ? (await desktopFolder(desktop, client, { showModal: onceModalsListen })).folder : undefined;
    const folder: FolderState = desktop && desktopRoot
        ? { kind: 'connected', source: desktopFolderSource(desktop), root: desktopRoot.path, aliases: [], name: desktopRoot.name }
        // #344: the user's DBMN workspace folder (the one VS Code uses), when they've picked it and the
        // browser still lets us in; otherwise this browser's own storage, as before
        : await folderState(client, scope);
    if (folder.kind === 'connected') {
        useWorkspaceRoot(folder.root);
        const database = `${folder.root}/${DATA_DIR}/executions.db`;
        await mountFolder(folder.source, folder.root, [database, `${folder.root}/${DATA_DIR}/${WORKSPACE_MARKER}`], [database], folder.aliases);
    }
    /** Start again on the folder as it is now. (A running batch doesn't hold this up: see beforeunload.) */
    let restarting = false;
    const restart = () => {
        restarting = true;
        location.reload();
    };
    if (desktop) {
        // The folder went while the app was open (moved, its drive unplugged): back to the first step
        const watching = setInterval(() => {
            void desktop.folderState().then(now => {
                if (now.kind === 'connected' && now.folder.path === desktopRoot?.path) return;
                clearInterval(watching);
                restart();
            }).catch(() => undefined);
        }, 5000);
    }

    const endpoints = new APIEndpointManager(state);
    const environments = new EnvironmentManager(state);
    const systems = new SystemManager(state);
    startGlobalSystems(client, scope, { systems, endpoints, environments });
    // #415: environments read their Standard System's configuration (claims, org levels)
    environments.setSystemLookup(id => systems.getSystem(id));

    const toast = {
        info: (message: string) => hubSession.post({ type: 'dbmnToast', level: 'info', message }),
        warn: (message: string) => hubSession.post({ type: 'dbmnToast', level: 'warn', message }),
        error: (message: string) => hubSession.post({ type: 'dbmnToast', level: 'error', message })
    };
    // Changes made elsewhere (VS Code, another tab or device) show here as they happen (#342);
    // an edit saved over one of them wins, with a warning
    state.onConflict = conflict => toast.warn(conflictMessage(conflict));
    state.onCountersLocal = () => toast.warn(RUN_COUNTERS_LOCAL_MESSAGE);
    // #342: a user whose DBMN for VS Code has signed in here, with its catalogue still on that
    // computer, is told on Home where to save it. Read at start, when the catalogue changes
    // (VS Code saving it is one such change) and now and then while the tab is in view.
    let vsCode: VsCodeCatalogueSignals = { seenAt: [], saved: true };
    const readVsCodeSignals = async () => {
        try {
            const [listeners, saved] = await Promise.all([accountAgentListeners(client), catalogue.hasMigratedFromVsCode()]);
            const next = { seenAt: listeners.map(l => l.updatedAt), saved };
            if (JSON.stringify(next) === JSON.stringify(vsCode)) return;
            vsCode = next;
            await hub?.broadcastState();
        } catch (error) {
            console.warn('[Catalogue] could not tell whether DBMN for VS Code has signed in on this account', error);
        }
    };
    followCatalogueChanges(catalogue, state, {
        onReloaded: () => { endpoints.notifyChanged(); environments.notifyChanged(); systems.notifyChanged(); void readVsCodeSignals(); },
        log: (message, error) => (error ? console.warn(message, error) : console.info(message))
    });
    setInterval(() => { if (document.visibilityState === 'visible') void readVsCodeSignals(); }, 2 * 60 * 1000);
    const tokenExpiry = new TokenExpiryService();
    // #359: one set of refresh tokens for the app: sign-in keeps them, the gate and runs use them
    const refresher = webOAuthRefresher(environments, state.secrets, systems);
    const oauth = webOAuthActions(environments, refresher, undefined, undefined, systems);
    const browserGate = new AuthGate({
        environments,
        oauth: {
            isSignedIn: async id => {
                const token = await environments.getEnvironmentToken(id);
                try {
                    if (token && !tokenExpiry.isTokenExpired(token)) return true;
                } catch {
                    return true;   // not a JWT: the API judges it
                }
                // #359: none, or expired: a refresh token gets a new one without the popup
                return !!(await refresher.refresh(id));
            },
            signIn: id => oauth.signIn(id)
        },
        // Signed in to the web app (it opens on sign-in): DBMN environments use that session
        dbmn: { isSignedIn: () => true },
        isTokenExpired: token => tokenExpiry.isTokenExpired(token),
        promptAuthExpired: name => promptAuthExpiredInModal(hubSession, name),
        toast,
        log: {
            info: message => console.info(message),
            warn: (message, error) => console.warn(message, error ?? ''),
            error: (message, error) => console.error(message, error ?? '')
        }
    });
    const snapshotKey = 'hubTabsSnapshot';
    let hub: HubController;
    const settings = await accountSettings(client, state);   // #281: the account's, this browser's for the rest
    // 0.4.1: runs here count towards Weekly Usage, as VS Code's do
    const telemetry = webTelemetry(client, settings, desktop ? 'desktop' : 'web');
    window.addEventListener('pagehide', () => { void telemetry.flush(); });
    const execution = await startExecution({
        client,
        environments,
        endpoints,
        settings,
        telemetry: () => telemetry,
        openConsole: (executionId, isBatch, focus) => hub.openConsoleTab(executionId, isBatch, focus),
        onHistoryChangedElsewhere: () => { void hub?.broadcastState(); },
        // #344: a run for DBMN for VS Code waits for it; say so (and when it's come)
        agentPrompts: { modal: () => hubSession, toast },
        onAgentWaiting: waiting => {
            toast.info(waiting ? AGENT_WAITING : 'VS Code is connected: waiting runs are starting.');
            void showAgentConnection();
        },
        ensureAuthenticated: environment => authGate.ensureAuthenticated(environment as never),
        // #359: a request that came back 401 mid-batch: new credentials without asking, then again
        // (A single run records its environment by name; a batch by id.)
        refreshCredentials: async idOrName => {
            const environment = await environments.getEnvironment(idOrName)
                ?? (await environments.getAllEnvironments()).find(e => e.name === idOrName);
            if (environment?.authMethod === 'dbmn') return !(await client.auth.refreshSession()).error;
            // (In the web app a Local agent environment's refresh token is VS Code's; the desktop app has its own)
            if (environment?.authMethod === 'oauth' && (desktop || environment.runOn !== 'local-agent')) return !!(await refresher.refresh(environment.id));
            return false;
        }
    });
    // #344 step 4: in the web app, an environment that runs in DBMN for VS Code signs in there (its
    // tokens stay there). The desktop app signs in every environment itself
    const authGate: IEnvironmentAuthGate = execution.agent
        ? agentAwareAuthGate(browserGate, execution.agent, { environments, modal: () => hubSession, toast })
        : browserGate;
    // Dev server only (never a production build): what e2e diagnostics read when a test fails
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
        Object.assign(window, { __dbmnDebug: { execution, runContent: await import('../../../src/services/run-content/run-content-store') } });
    }

    // Closing or reloading this page stops a running batch and drops every unsaved tab (an edited
    // endpoint or environment, Run Batch data not yet run), so the browser asks first. Ctrl+W is
    // the browser's own shortcut, so this is the only guard it gets.
    // (beforeunload can't wait, so the running count is kept up to date here.)
    let batchesRunning = 0;
    setInterval(() => { void execution.engine.getRunningBatches().then(ids => { batchesRunning = ids.length; }); }, 2000);
    const unsavedTabs = (): boolean => {
        const tabs = (window as { HubTabs?: { getState(): { tabs: Array<{ dirty?: boolean }> } } }).HubTabs?.getState().tabs ?? [];
        return tabs.some(tab => tab.dirty);
    };
    window.addEventListener('beforeunload', event => {
        if (restarting || (batchesRunning === 0 && !unsavedTabs())) return;
        event.preventDefault();
        event.returnValue = '';
    });

    // Run API: the same path as VS Code's (RunOrchestrator), on the Hub's modal
    const runs = new RunOrchestrator({
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, trace: () => undefined, error: (m, e) => console.error(m, e), show: () => undefined, clear: () => undefined, dispose: () => undefined },
        environments,
        endpoints,
        pipeline: { getTransactionPreparationService: () => execution.preparation, getBatchExecutionEngine: () => execution.engine },
        individualEngine: () => execution.individualEngine,
        modal: () => hubSession,
        // The same gate as VS Code (#311): missing or expired credentials ask first, and Sign In
        // signs in (OAuth: the popup) before the run goes ahead
        ensureAuthenticated: environment => authGate.ensureAuthenticated(environment as never),
        promptSignIn: async () => { location.replace('/signin.html'); },
        confirmProduction: (environment, action) => confirmProductionExecution(environment as never, action, hubSession),
        workspaceRoot: async () => WORKSPACE_ROOT,
        links: () => execution.store,
        toast: { error: toast.error },
        telemetry: () => telemetry
    });
    const runEndpoint = (endpoint: APIEndpointConfig) => runs.runApiEndpointCommand(endpoint);

    // Home's "New in vX.Y.Z": this installation's, whoever is signed in
    const whatsNew = await loadWhatsNew(browserDeviceStore('installation'));

    hub = new HubController(hubSession, {
        endpoints,
        environments,
        systems,
        recent: new RecentEndpointsService(state.globalState),
        compares: { state: () => state.globalState, queryFiles },
        preferences: new HubPreferencesService(state.globalState),
        settings,
        executions: {
            metadata: execution.metadata,
            pause: async id => { await execution.engine.pauseBatch(id, 'User requested pause'); },
            // The batch's files first: after a reload they're not loaded until asked for (#344)
            resume: async (id, choice) => {
                await execution.preloadRun(id);
                await applyResumeChoice(execution.engine, id, choice, () => ConsoleController.sendClearErrors(id));
                await execution.engine.resumeBatch(id);
            },
            cancel: async (id, isBatch) => {
                if (isBatch) await execution.engine.cancelBatch(id);
                else await execution.executionService.cancel(id);
            }
        },
        auth: {
            // Signed in to get here; signing out anywhere sends the page back to sign-in
            isSignedIn: () => true,
            onChanged: listener => {
                const { data } = client.auth.onAuthStateChange(event => {
                    if (event === 'SIGNED_OUT') location.replace('/signin.html');
                    listener();
                });
                return { dispose: () => data.subscription.unsubscribe() };
            },
            promptSignIn: async () => { location.replace('/signin.html'); }
        },
        confirmDestructive: opts => confirmDestructiveInModal(hubSession, opts),
        toast,
        tabs: webTabs({
            authGate,
            endpoints,
            environments,
            systems,
            toast,
            openBatch: (id, chain) => hub.openBatchTab(id, chain),
            openCompare: id => hub.openCompareTab(id, 'match'),
            openEnvironment: id => hub.openEnvironmentTab(id),
            openEndpoint: id => hub.openEndpointTab(id, false),
            openConsole: (id, isBatch) => hub.openConsoleTab(id, isBatch),
            runEndpoint,
            executeBulkLoad: request => runs.executeBulkLoad(request),
            promptSignIn: async () => { location.replace('/signin.html'); },
            refreshHub: () => { void hub.broadcastState(); },
            execution,
            state,
            settings,
            refresher
        }),
        runApi: runEndpoint,
        // Settings › Workspace (#344): this browser, or the workspace folder VS Code uses
        workspace: {
            info: () => desktop && folder.kind === 'connected'
                ? {
                    workspacePath: folder.root,
                    executionsDbPath: `${folder.root}/${DATA_DIR}/executions.db`,
                    note: 'History and run results are kept in this folder. Set DBMN for VS Code to the same folder and both show the same History.',
                    chooseLabel: 'Change folder…',
                    canReveal: true
                }
                : folder.kind === 'connected'
                ? {
                    workspacePath: folder.root,
                    executionsDbPath: `${folder.root}/${DATA_DIR}/executions.db`,
                    note: 'History and run results are kept in this folder. DBMN for VS Code on this computer can use the same folder: both then show the same History.',
                    chooseLabel: 'Change folder…',
                    canReveal: false
                }
                : folder.kind === 'reconnect'
                    ? {
                        workspacePath: folder.path,
                        executionsDbPath: 'Waiting for the folder',
                        note: 'Your browser needs your permission again to use this folder. Until then, History is this browser\'s own.',
                        chooseLabel: 'Reconnect folder',
                        canReveal: false,
                        home: {
                            title: 'Workspace folder not connected',
                            text: 'History shows only this browser\'s runs, not DBMN for VS Code\'s. '
                                + (folder.blocked ? BLOCKED_HELP : 'Your browser needs your permission again.'),
                            button: 'Reconnect folder'
                        }
                    }
                    : {
                        workspacePath: 'This browser',
                        executionsDbPath: 'Kept in this browser',
                        note: 'History lives in this browser and is lost if site data is cleared. Use a folder on this computer to keep it.'
                            + (folder.suggestedPath ? ` DBMN for VS Code uses ${folder.suggestedPath}: pick that one, if it's on this computer, to see its runs too.` : ''),
                        chooseLabel: 'Use a folder…',
                        canReveal: false,
                        home: {
                            title: 'History is kept in this browser only',
                            text: 'It\'s lost if site data is cleared. Use a folder on this computer to keep it'
                                + (folder.suggestedPath ? ` (${folder.suggestedPath}, if it's here, also shows DBMN for VS Code's runs).` : '.'),
                            button: 'Use a folder…'
                        }
                    },
            reveal: async () => (desktop ? desktop.folderReveal() : true),
            choose: async () => {
                if (desktop) {
                    // The computer's folder dialog, from the main process; then start again on the folder
                    const chosen = await desktop.folderChoose();
                    if (chosen.ok) restart();
                    else if (!chosen.cancelled) toast.warn(chosen.message);
                    return;
                }
                if (folder.kind === 'reconnect') {
                    const permission = await reconnectWorkspaceFolder(folder.handle);
                    if (permission === 'granted') location.reload();
                    else if (permission === 'denied') toast.warn(BLOCKED_HELP);
                    return;   // 'prompt': dismissed; the card stays
                }
                if (typeof window.showDirectoryPicker !== 'function') {
                    toast.warn('Using a folder needs Chrome or Edge. In this browser, History stays in the browser.');
                    return;
                }
                // #441: a folder that isn't a workspace on this account yet: the user says whether to set it up
                const picked = await pickWorkspaceFolder(client, scope, async question => (await hubSession.showModal({
                    title: 'Use this folder?',
                    body: question,
                    actions: [
                        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                        { id: 'setUp', label: 'Use this folder', variant: 'primary' }
                    ],
                    dismissible: true,
                    size: 'sm'
                })).actionId === 'setUp');
                if (!picked) return;   // cancelled
                if (picked.ok) location.reload();   // start over on the folder
                else toast.warn(picked.message);
            }
        },
        tabSnapshots: {
            peek: () => state.globalState.get<HubTabsSnapshot>(snapshotKey),
            take: () => {
                const snapshot = state.globalState.get<HubTabsSnapshot>(snapshotKey);
                void state.globalState.update(snapshotKey, undefined);
                return snapshot;
            },
            save: async snapshot => { await state.globalState.update(snapshotKey, snapshot); }
        },
        whatsNew: () => whatsNew,
        // The web app is always on the account's catalogue: Settings says so, and what that means;
        // Home has a card for a VS Code user whose catalogue is still on their computer
        catalogueStorage: { info: () => webCatalogueStorageInfo(vsCode), saveToAccount: async () => undefined },
        sections: { account: accountSection(client, message => hubSession.post(message), toast.info) }
    });
    void readVsCodeSignals();
    // A page has no close event a host can wait on: keep the strip on every change instead
    window.addEventListener('pagehide', () => { void hub.pageClosed(); });

    // #344: the browser needs permission again for the workspace folder. Ask at once: the
    // modal's click is what lets the browser ask (it never asks without one)
    let askedToReconnect = false;
    let toldAboutMove = false;
    const askToReconnect = async () => {
        if (folder.kind !== 'reconnect' || askedToReconnect) return;
        askedToReconnect = true;
        const answer = await hubSession.showModal({
            title: 'Reconnect your workspace folder',
            body: `DBMN needs your permission again to use ${folder.path}. Until then, History shows only this browser's runs, not DBMN for VS Code's.`
                + (folder.blocked ? ` ${BLOCKED_HELP}` : ''),
            actions: [
                { id: 'later', label: 'Not now', variant: 'secondary' },
                { id: 'reconnect', label: 'Reconnect folder', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });
        if (answer.actionId !== 'reconnect') return;
        const permission = await reconnectWorkspaceFolder(folder.handle);
        if (permission === 'granted') location.reload();
        else if (permission === 'denied') toast.warn(BLOCKED_HELP);
    };

    // As a webview's host does: each message handled as it arrives, not one after another (a
    // handler waiting on a modal must not hold up the modal's own reply)
    // #373: Settings › UI › Theme is this host's (VS Code themes itself): the options, and the pick
    const offerThemes = () => hubSession.post({ type: 'themeOptions', ...currentThemeMenu(), hint: themeHintDue() });
    onThemeChanged(offerThemes);
    // #344: the icon beside an environment that runs in DBMN for VS Code: is VS Code there? Asked
    // every few seconds while any environment runs there (none: nothing asked, no icon), and
    // never in a way that makes the browser ask its permission (agent-loopback.ts state()).
    // The desktop app runs them itself: never asked, no icon.
    let agentState: AgentConnectionState | undefined;
    const showAgentConnection = async (always = false) => {
        const agent = execution.agent;
        const anyRunThere = !!agent && (await environments.getAllEnvironments()).some(environment => environment.runOn === 'local-agent');
        const state = agent && anyRunThere ? await agent.connectionState().catch(() => 'away' as const) : undefined;
        if (state === agentState && !always) return;
        agentState = state;
        hubSession.post({ type: 'agentConnection', state });
    };
    setInterval(() => { void showAgentConnection(); }, AGENT_CONNECTION_CHECK_MS);
    const receive = (message: Message) => {
        void (async () => {
            if (message.type === 'setTheme') {
                chooseTheme(String(message.id ?? ''));
                return;
            }
            if (message.type === 'themeHintDone') {
                endThemeHint();
                return;
            }
            if (message.type === 'setSystemTheme') {
                if (message.mode === 'light' || message.mode === 'dark') chooseSystemTheme(message.mode, String(message.id ?? ''));
                return;
            }
            if (await hubSession.handleShared(message)) return;
            await hub.handle(message);
            // The Hub's page is wired and has its state: what tests (and anything else) wait for
            if (message.type === 'ready') {
                offerThemes();
                void showAgentConnection(true);
                document.body.dataset.dbmnHost = 'ready';
                void askToReconnect();
                if (execution.movedFromBrowser && !toldAboutMove) {
                    toldAboutMove = true;
                    const runs = `${execution.movedFromBrowser} run${execution.movedFromBrowser === 1 ? '' : 's'}`;
                    toast.info(desktop
                        ? `Moved ${runs} from the app's own storage into your workspace folder. They're in History.`
                        : `Moved ${runs} from this browser into your workspace folder. They're in History, and in DBMN for VS Code's.`);
                }
            }
        })().catch(error => {
            console.error('[web] message failed', message.type, error);
            toast.error(error instanceof Error ? error.message : String(error));
        });
    };
    page.__dbmnShell = { receive };
    held.splice(0).forEach(receive);
    page.__dbmnHostQueue.splice(0).forEach(receive);
}

start().catch(error => {
    console.error('[web] start failed', error);
    void startFailed(error instanceof Error ? error.message : String(error));
});

/** How long the page gets to start answering modal requests (dbmn-modal.js attaches after load). */
const MODAL_BRIDGE_WAIT_MS = 5_000;

/**
 * The app can't start: say so where every other message shows, in a modal on the Hub, with the
 * one thing to do. The shell may not be wired yet (start failed before that), so the modal's
 * answer gets a receiver of its own; a page whose scripts never attached the modal bridge gets
 * the words in the page instead.
 */
async function startFailed(message: string): Promise<void> {
    const session = new ScreenSession({ post: m => window.postMessage(m, location.origin) }, screenHost);
    const receive = (m: Message) => { void session.handleShared(m); };
    page.__dbmnShell = { receive };
    page.__dbmnHostQueue.splice(0).forEach(receive);
    const deadline = Date.now() + MODAL_BRIDGE_WAIT_MS;
    while (!page.__dbmnModalBridgeAttached && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!page.__dbmnModalBridgeAttached) {
        document.body.insertAdjacentHTML('afterbegin', `<p class="dbmn-web-start-error">DBMN couldn't start. ${message.replace(/</g, '&lt;')}</p>`);
        return;
    }
    const result = await session.showModal({
        title: 'DBMN couldn\'t start',
        body: message,
        dismissible: false,
        actions: [{ id: 'reload', label: 'Reload', variant: 'primary' }]
    });
    if (result.actionId === 'reload') location.reload();
}
