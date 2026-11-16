// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The DBMN desktop app's main process (#392, under #373). The window is the web app: the same
 * screens and shell (../web), which find `window.dbmnDesktop` and send requests through this
 * process instead of the page, so the browser's CORS rule doesn't apply.
 *
 * This file wires; the rules are core's (src/services/desktop): what the window may load, open
 * and be granted (desktop-window-policy.ts), and what it may ask this process for
 * (desktop-protocol.ts, parsed before anything is done).
 *
 * Security baseline (Architecture-v2 2.3): contextIsolation, sandbox, no Node in the page, web
 * security on, no <webview>, no second window, no navigation off the app's pages, IPC answered
 * only for the app's own top page.
 *
 * Two ways to run:
 * - Bundled pages (a packaged build, or `DBMN_DESKTOP_PAGES=<folder>` from source): the web app's
 *   static export (`npm --prefix web run build:desktop`), served on the app's own scheme
 *   (`dbmn-app://app/`), never `file://` and never a remote page. This process hands the pages
 *   their backend. Today every package is a dev-channel build (channel.ts): a local stack only.
 * - A dev server (from source, no bundle): `DBMN_DESKTOP_URL`, on 127.0.0.1 only; the dev server
 *   hands the pages their backend, as it does a browser.
 *
 * #373: on Omarchy the window wears the desktop's theme and follows each change to it. The main
 * process reads Omarchy's state (omarchy-theme-source.ts) and hands the window the palette; the
 * page maps it onto the screens' tokens and keeps the user's choice (web/src/shell/theme.ts).
 * On Windows and macOS the window is also told the computer's accent colour, which the standard
 * Light and Dark themes wear (system-accent.ts).
 *
 * Not yet: a production-channel build (#380 and the Supabase deploy first; it must also refuse
 * the debugging switches a dev-channel build leaves open for its e2e, DBMN_OMARCHY_STATE_DIR
 * and DBMN_SYSTEM_ACCENT among them), the CSP of #372, secrets in the OS keychain, OAuth over loopback.
 *
 * The workspace folder: the app always runs on one, and this process owns it (found, chosen in
 * the computer's folder dialog, or made; desktop-workspace-folder.ts). The window never keeps
 * history in its own storage.
 */
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { desktopDevBackend, type DevStackBackend } from '../../src/services/dbmn-backend/backend-config';
import { desktopFetcher } from '../../src/services/desktop/desktop-fetch';
import { omarchyThemeSource } from '../../src/services/desktop/omarchy-theme-source';
import { desktopWorkspaceFolder } from '../../src/services/desktop/desktop-workspace-folder';
import { DESKTOP_BACKEND_ARGUMENT, DESKTOP_CHANNELS, type DesktopFolderResult, type DesktopFolderState } from '../../src/services/desktop/desktop-protocol';
import { BUNDLED_APP_ORIGIN, DESKTOP_SCHEME, bundledPagePath, devAppOrigin, fillBackendPill, isAppPage, opensInBrowser, permissionAllowed } from '../../src/services/desktop/desktop-window-policy';
import { CHANNEL } from './channel';

if (CHANNEL !== 'dev') {
    // TODO(#380): the production channel. Until then no package may reach production.
    throw new Error('This build of DBMN has no production channel yet.');
}
/** The bundled pages' folder: a package's own, or one named when run from source. */
const PAGES = app.isPackaged ? path.join(process.resourcesPath, 'app-pages') : process.env.DBMN_DESKTOP_PAGES;
const APP_ORIGIN = PAGES ? BUNDLED_APP_ORIGIN : devAppOrigin(process.env.DBMN_DESKTOP_URL);
/** Bundled pages get their backend from here (a dev server hands its own pages theirs). */
const BACKEND: DevStackBackend | undefined = PAGES ? desktopDevBackend(process.env) : undefined;
/** A dev build's links to the website go to the local site (`npm run dev:local`). */
const DEV_SITE_ORIGIN = BACKEND?.siteUrl ?? (process.env.DBMN_SITE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

// Before the app is ready: the pages' scheme behaves as https does (storage, fetch, modules)
protocol.registerSchemesAsPrivileged([{ scheme: DESKTOP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

// Every renderer sandboxed, whatever a window asks for
app.enableSandbox();
// A dev build keeps its own profile, apart from an installed app's (a test passes its own)
if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), PAGES ? `dbmn-desktop-${BACKEND?.profile}` : 'dbmn-desktop-dev'));
}

const log = (message: string, error?: unknown): void => { console.warn(message, error ?? ''); };
const fetcher = desktopFetcher({ fetch, log });
/** #373: the desktop's Omarchy theme. A dev build's e2e points it at a folder of its own. */
const omarchy = omarchyThemeSource({ homeDir: app.getPath('home'), stateDir: process.env.DBMN_OMARCHY_STATE_DIR || undefined, log });
/** The workspace folder: which one is this installation's (kept in its own data), and its files. */
const workspace = desktopWorkspaceFolder({ configFile: path.join(app.getPath('userData'), 'workspace-folder.json'), homeDir: () => app.getPath('home'), log });

/** Only the app's own top page is answered: never a frame, never a page from anywhere else. */
function fromApp(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const frame = event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && isAppPage(frame.url, APP_ORIGIN);
}

ipcMain.handle(DESKTOP_CHANNELS.fetch, (event, raw: unknown) => {
    if (!fromApp(event)) return { ok: false, aborted: false, error: 'Not from DBMN.' };
    return fetcher.fetch(raw);
});
ipcMain.on(DESKTOP_CHANNELS.cancelFetch, (event, raw: unknown) => {
    if (fromApp(event)) fetcher.cancel(raw);
});
ipcMain.handle(DESKTOP_CHANNELS.omarchyTheme, event => (fromApp(event) ? omarchy.current() : undefined));

/**
 * #373: the computer's accent colour, where the user picks one (Windows, macOS), as the system
 * gives it (the page checks it is a colour). A dev build's e2e names one.
 */
function systemAccent(): string | undefined {
    if (process.env.DBMN_SYSTEM_ACCENT) return process.env.DBMN_SYSTEM_ACCENT;
    if (process.platform !== 'win32' && process.platform !== 'darwin') return undefined;
    try {
        return systemPreferences.getAccentColor();
    } catch {
        return undefined;
    }
}
let accentTold: string | undefined;
ipcMain.handle(DESKTOP_CHANNELS.systemAccent, event => {
    if (!fromApp(event)) return undefined;
    accentTold = systemAccent();
    return accentTold;
});
/** Tells the app's windows an accent colour they haven't heard. */
function followAccent(): void {
    const accent = systemAccent();
    if (accent === accentTold) return;
    accentTold = accent;
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && isAppPage(window.webContents.getURL(), APP_ORIGIN)) window.webContents.send(DESKTOP_CHANNELS.systemAccentChanged, accent);
    }
}
// Windows says when the accent changes; macOS doesn't, so it is also read again when a window is returned to
systemPreferences.on('accent-color-changed', followAccent);

// The workspace folder: remembered in the app's own data, found, chosen and made here, and its
// files read and written here (the rules are core's; this adds the computer's folder dialog)
const NOT_FROM_APP: DesktopFolderResult = { ok: false, message: 'Not from DBMN.' };
ipcMain.handle(DESKTOP_CHANNELS.folderState, (event): DesktopFolderState | undefined => (fromApp(event) ? workspace.state() : undefined));
ipcMain.handle(DESKTOP_CHANNELS.folderFind, (event, raw: unknown) => (fromApp(event) ? workspace.find(raw) : []));
ipcMain.handle(DESKTOP_CHANNELS.folderConnect, (event, raw: unknown) => (fromApp(event) ? workspace.connect(raw) : NOT_FROM_APP));
ipcMain.handle(DESKTOP_CHANNELS.folderUseDefault, event => (fromApp(event) ? workspace.useDefault() : NOT_FROM_APP));
ipcMain.handle(DESKTOP_CHANNELS.folderChoose, async (event): Promise<DesktopFolderResult> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!fromApp(event) || !window) return NOT_FROM_APP;
    const current = workspace.state();
    const picked = await dialog.showOpenDialog(window, {
        title: 'Choose your DBMN workspace folder',
        buttonLabel: 'Use this folder',
        defaultPath: current.kind === 'connected' ? current.folder.path : app.getPath('home'),
        properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true, message: 'No folder was chosen.' };
    return workspace.usePicked(picked.filePaths[0]);
});
ipcMain.handle(DESKTOP_CHANNELS.folderReveal, async event => {
    const root = fromApp(event) ? workspace.root() : undefined;
    return !!root && (await shell.openPath(root)) === '';
});
ipcMain.handle(DESKTOP_CHANNELS.folderFile, (event, raw: unknown) => (fromApp(event) ? workspace.file(raw) : { ok: false, error: 'Not from DBMN.' }));

app.on('web-contents-created', (_event, contents) => {
    // The window shows the app's pages and nothing else
    contents.on('will-navigate', (event, url) => {
        if (!isAppPage(url, APP_ORIGIN)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
        if (!isAppPage(url, APP_ORIGIN)) event.preventDefault();
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    // Never a second window: a link to one of DBMN's sites opens in the user's browser
    contents.setWindowOpenHandler(({ url }) => {
        if (opensInBrowser(url, DEV_SITE_ORIGIN)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    // A page that reloads or goes: nothing it asked for is still wanted
    contents.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) fetcher.cancelAll();
    });
    contents.on('destroyed', () => fetcher.cancelAll());
});

function openWindow(background: string): void {
    const window = new BrowserWindow({
        width: 1500,
        height: 950,
        title: 'DBMN',
        // The theme's background before the page paints: no white flash, no wrong-theme flash
        backgroundColor: background,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            webviewTag: false,
            additionalArguments: BACKEND ? [DESKTOP_BACKEND_ARGUMENT + Buffer.from(JSON.stringify(BACKEND)).toString('base64')] : []
        }
    });
    // No menu bar (File, Edit, View...): the app has no use for it. Its shortcuts still work
    // (reload, zoom, full screen; DevTools in a dev build).
    window.setMenuBarVisibility(false);
    // #373: each theme the desktop changes to, to the app's own top page
    const stopFollowing = omarchy.watch(theme => {
        if (!window.isDestroyed() && isAppPage(window.webContents.getURL(), APP_ORIGIN)) window.webContents.send(DESKTOP_CHANNELS.omarchyThemeChanged, theme);
    });
    window.on('closed', stopFollowing);
    window.on('focus', followAccent);
    void window.loadURL(`${APP_ORIGIN}/`);
}

/** The window's first colour: the desktop's theme background, or Dark Modern's. */
async function windowBackground(): Promise<string> {
    return (await omarchy.current())?.palette.background ?? '#1e1e1e';
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const [window] = BrowserWindow.getAllWindows();
        if (window?.isMinimized()) window.restore();
        window?.focus();
    });
    void app.whenReady().then(async () => {
        const appSession = session.defaultSession;
        if (PAGES) {
            const pages = PAGES;
            protocol.handle(DESKTOP_SCHEME, async request => {
                const file = bundledPagePath(request.url);
                if (!file) return new Response('Not found.', { status: 404 });
                try {
                    if (file === 'index.html' && BACKEND) {
                        // The Hub page says which backend this build is on
                        const html = fillBackendPill(await fs.promises.readFile(path.join(pages, file), 'utf8'), BACKEND);
                        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                    }
                    return await net.fetch(pathToFileURL(path.join(pages, file)).toString());
                } catch {
                    return new Response('Not found.', { status: 404 });
                }
            });
        }
        appSession.setPermissionRequestHandler((_contents, permission, answer, details) => {
            answer(permissionAllowed(permission, details.requestingUrl, APP_ORIGIN));
        });
        appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, APP_ORIGIN));
        openWindow(await windowBackground());
        app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void windowBackground().then(openWindow); });
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
