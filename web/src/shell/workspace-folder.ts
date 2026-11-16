// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * "Use a folder" (#344): the web app on the user's DBMN workspace folder, the one DBMN for VS
 * Code uses, instead of this browser's own storage. Chrome and Edge (File System Access).
 * The desktop app doesn't come here: it is always on a folder, which its main process owns
 * (desktop-folder.ts).
 *
 * - Pick: the folder's marker (`.dbmn/workspace.json`) must name a workspace on the user's account
 *   (core folder-check.ts). #441: when it doesn't, the user is asked, and the web app sets the
 *   folder up itself (writes the marker, puts it on the account): a new computer needs no
 *   DBMN for VS Code. A folder only VS Code 0.3.1 used (`.active8`) is used as it is.
 *   Accepted, its handle is remembered for this user in this browser.
 * - Later visits: Chrome usually keeps the permission; when it asks again, it can only ask
 *   after a click, so Settings shows Reconnect folder.
 * - The folder is mounted at the account's path for it (VS Code's own, or `/workspace-folder/<name>`
 *   for one the web app set up), with the workspace's other paths as aliases, so the web app and VS Code
 *   each open the other's runs as they are.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { accountWorkspaces, recordWorkspace } from '../../../src/platform/supabase/account-workspaces';
import { checkPickedFolder, WEB_APP_DEVICE_ID, webAppWorkspacePath } from '../../../src/services/workspace/folder-check';
import { browserFolderSource, legacyDataDirSource, type FolderSource } from './node/folder-source';
import { DATA_DIR, LEGACY_DATA_DIR, parseWorkspaceMarker, WORKSPACE_MARKER, type WorkspaceMarker } from '../../../src/services/workspace/workspace-layout';

export type FolderState =
    | { kind: 'browser'; suggestedPath?: string }                       // not using a folder
    | { kind: 'connected'; source: FolderSource; root: string; aliases: string[]; name: string }
    | { kind: 'reconnect'; handle: FileSystemDirectoryHandle; name: string; path: string; blocked: boolean };   // permission to ask again (or blocked)

const STORE = 'handles';

function openHandles(scope: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(`dbmn-workspace-folder:${scope}`, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const testFolder = (): Promise<FileSystemDirectoryHandle> | undefined => (import.meta as { env?: { DEV?: boolean } }).env?.DEV
    ? (window as unknown as { __dbmnTestWorkspaceFolder?: Promise<FileSystemDirectoryHandle> }).__dbmnTestWorkspaceFolder
    : undefined;

async function savedHandle(scope: string): Promise<FileSystemDirectoryHandle | undefined> {
    // Dev server only (never a production build): e2e hands over a test folder here. A test
    // browser can't use the OS picker, and Chrome crashes reading a browser-private (OPFS)
    // folder handle back from IndexedDB, the test's only stand-in for a picked folder.
    const injected = testFolder();
    if (injected) return injected;
    const db = await openHandles(scope);
    return new Promise(resolve => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('folder');
        request.onsuccess = () => resolve(request.result as FileSystemDirectoryHandle | undefined);
        request.onerror = () => resolve(undefined);
    });
}

async function saveHandle(scope: string, handle: FileSystemDirectoryHandle | undefined): Promise<void> {
    // Dev server only: a test's folder is handed over through the seam above, never kept here
    // (Chrome crashes reading a browser-private folder's handle back from IndexedDB)
    if (testFolder()) return;
    const db = await openHandles(scope);
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        if (handle) tx.objectStore(STORE).put(handle, 'folder'); else tx.objectStore(STORE).delete('folder');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** The folder's DBMN data: `.dbmn`; else (#441) `.active8`, when only DBMN for VS Code 0.3.1 has used it. */
async function dataDirOf(handle: FileSystemDirectoryHandle): Promise<string> {
    for (const name of [DATA_DIR, LEGACY_DATA_DIR]) {
        try {
            await handle.getDirectoryHandle(name);
            return name;
        } catch { /* not there */ }
    }
    return DATA_DIR;
}

async function readMarker(handle: FileSystemDirectoryHandle, dataDir: string): Promise<WorkspaceMarker | undefined> {
    try {
        const file = await (await (await handle.getDirectoryHandle(dataDir)).getFileHandle(WORKSPACE_MARKER)).getFile();
        return parseWorkspaceMarker(await file.text());
    } catch {
        return undefined;
    }
}

/** What the folder check is given: the folder's name, its marker, and whether it holds 0.3.1's data. */
async function picked(handle: FileSystemDirectoryHandle): Promise<{ name: string; marker?: WorkspaceMarker; legacyData: boolean; dataDir: string }> {
    const dataDir = await dataDirOf(handle);
    return { name: handle.name, marker: await readMarker(handle, dataDir), legacyData: dataDir === LEGACY_DATA_DIR, dataDir };
}

function sourceFor(handle: FileSystemDirectoryHandle, dataDir: string): FolderSource {
    const source = browserFolderSource(handle);
    return dataDir === LEGACY_DATA_DIR ? legacyDataDirSource(source, DATA_DIR, LEGACY_DATA_DIR) : source;
}

/** #441: make the picked folder a DBMN workspace on this account: its marker (kept, when it has one), and the account's row. */
async function setUpFolder(client: SupabaseClient, handle: FileSystemDirectoryHandle, dataDir: string, existing: WorkspaceMarker | undefined): Promise<void> {
    let marker = existing;
    if (!marker) {
        marker = { id: crypto.randomUUID(), name: handle.name, createdAt: new Date().toISOString(), createdOn: WEB_APP_DEVICE_ID };
        const data = await handle.getDirectoryHandle(dataDir, { create: true });
        const writable = await (await data.getFileHandle(WORKSPACE_MARKER, { create: true })).createWritable();
        await writable.write(JSON.stringify(marker, null, 2));
        await writable.close();
    }
    await recordWorkspace(client, { workspaceId: marker.id, deviceId: WEB_APP_DEVICE_ID, name: handle.name, path: webAppWorkspacePath(handle.name) });
}

export const canUseFolders = (): boolean => typeof window.showDirectoryPicker === 'function';

/** Where this user's DBMN data lives in this browser right now. */
export async function folderState(client: SupabaseClient, scope: string): Promise<FolderState> {
    const workspaces = await accountWorkspaces(client).catch(() => []);
    // The folder DBMN for VS Code (or the desktop app) uses, to suggest; never the web app's own path for one it set up
    const suggestedPath = workspaces.find(w => w.deviceId !== WEB_APP_DEVICE_ID)?.path;
    const handle = canUseFolders() ? await savedHandle(scope).catch(() => undefined) : undefined;
    if (!handle) return { kind: 'browser', suggestedPath };
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
        return { kind: 'reconnect', handle, name: handle.name, path: workspaces[0]?.path ?? handle.name, blocked: permission === 'denied' };
    }
    const folder = await picked(handle);
    const check = checkPickedFolder(folder, workspaces);
    if (!check.ok) return { kind: 'browser', suggestedPath };   // the folder changed since: start over
    return { kind: 'connected', source: sourceFor(handle, folder.dataDir), root: check.root, aliases: check.aliases, name: handle.name };
}

/**
 * The folder picker, then the check. #441: a folder that isn't a workspace on this account yet is
 * offered to the user (`ask`, the question), and set up when they say yes. Accepted: remembered,
 * and the caller reloads onto it. Must run from the user's click (browsers only show the picker
 * then). Undefined: cancelled, or the user said no.
 */
export async function pickWorkspaceFolder(
    client: SupabaseClient, scope: string, ask: (question: string) => Promise<boolean>
): Promise<{ ok: true } | { ok: false; message: string } | undefined> {
    let handle: FileSystemDirectoryHandle;
    try {
        handle = await window.showDirectoryPicker!({ id: 'dbmn-workspace', mode: 'readwrite' });
    } catch {
        return undefined;   // cancelled
    }
    const folder = await picked(handle);
    const check = checkPickedFolder(folder, await accountWorkspaces(client));
    if (!check.ok && 'setUp' in check) {
        if (!(await ask(check.question))) return undefined;
        try {
            await setUpFolder(client, handle, folder.dataDir, check.marker);
        } catch (error) {
            return { ok: false, message: `DBMN couldn't set up "${handle.name}": ${error instanceof Error ? error.message : String(error)}` };
        }
    } else if (!check.ok) {
        return check;
    }
    await saveHandle(scope, handle);
    return { ok: true };
}

/**
 * The browser wants permission again: ask, from the user's click. `denied` when the site's
 * File editing permission is blocked: the browser then refuses without asking.
 */
export async function reconnectWorkspaceFolder(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
    try {
        return await handle.requestPermission({ mode: 'readwrite' });
    } catch {
        return 'denied';
    }
}

/** What to do when the browser blocks the folder (it won't even ask). */
export const BLOCKED_HELP = 'Your browser is blocking DBMN from using the folder. Click the ⓘ to the left of the address, set File editing to Allow (or Reset permission), then Reconnect folder.';

/** Back to this browser's own storage. */
export async function forgetWorkspaceFolder(scope: string): Promise<void> {
    await saveHandle(scope, undefined);
}
