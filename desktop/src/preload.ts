// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: the only thing of Electron the window's page can reach: `window.dbmnDesktop`
 * (`DesktopBridge`). Sandboxed, so nothing is imported but Electron's own bridge; `ipcRenderer`
 * itself is never exposed, and the main process parses everything sent here.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopChannels } from '../../src/services/desktop/desktop-protocol';

// A sandboxed preload can't import the protocol: repeated, and a mismatch doesn't compile
const CHANNELS: DesktopChannels = {
    fetch: 'dbmn:fetch',
    cancelFetch: 'dbmn:fetch:cancel',
    omarchyTheme: 'dbmn:theme:omarchy',
    omarchyThemeChanged: 'dbmn:theme:omarchy:changed',
    systemAccent: 'dbmn:theme:accent',
    systemAccentChanged: 'dbmn:theme:accent:changed',
    folderState: 'dbmn:folder:state',
    folderFind: 'dbmn:folder:find',
    folderConnect: 'dbmn:folder:connect',
    folderChoose: 'dbmn:folder:choose',
    folderUseDefault: 'dbmn:folder:default',
    folderReveal: 'dbmn:folder:reveal',
    folderFile: 'dbmn:folder:file'
};

// A packaged build's backend, handed over as a window argument ('--dbmn-backend=' in the protocol)
const handed = process.argv.find(argument => argument.startsWith('--dbmn-backend='));
const backend = handed ? JSON.parse(atob(handed.slice('--dbmn-backend='.length))) as DesktopBridge['backend'] : undefined;

const bridge: DesktopBridge = {
    v: 1,
    ...(backend ? { backend } : {}),
    fetch: request => ipcRenderer.invoke(CHANNELS.fetch, request),
    cancelFetch: id => ipcRenderer.send(CHANNELS.cancelFetch, { id }),
    // #373: the page gets the theme as data (a palette), never a listener handle or the event
    omarchyTheme: () => ipcRenderer.invoke(CHANNELS.omarchyTheme),
    onOmarchyTheme: listener => { ipcRenderer.on(CHANNELS.omarchyThemeChanged, (_event, theme) => listener(theme)); },
    systemAccent: () => ipcRenderer.invoke(CHANNELS.systemAccent),
    onSystemAccent: listener => { ipcRenderer.on(CHANNELS.systemAccentChanged, (_event, accent) => listener(accent)); },
    // The workspace folder: the main process owns it, and reads and writes its files
    folderState: () => ipcRenderer.invoke(CHANNELS.folderState),
    folderFind: candidates => ipcRenderer.invoke(CHANNELS.folderFind, candidates),
    folderConnect: candidate => ipcRenderer.invoke(CHANNELS.folderConnect, candidate),
    folderChoose: () => ipcRenderer.invoke(CHANNELS.folderChoose),
    folderUseDefault: () => ipcRenderer.invoke(CHANNELS.folderUseDefault),
    folderReveal: () => ipcRenderer.invoke(CHANNELS.folderReveal),
    folderFile: request => ipcRenderer.invoke(CHANNELS.folderFile, request)
};

contextBridge.exposeInMainWorld('dbmnDesktop', bridge);
