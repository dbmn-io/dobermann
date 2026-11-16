// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: is the folder the user picked in the web app their DBMN workspace? A browser only says
 * the folder's *name*, so the check reads the workspace's marker (`.dbmn/workspace.json`) and
 * compares its id with the workspaces on the user's account (account-workspaces.ts).
 *
 * #441: the web app can set a workspace up itself (a new computer needs no DBMN for VS Code): a
 * folder with no marker, or one whose workspace isn't on this account yet, is offered to the
 * user, and the web app writes the marker and puts it on the account (workspace-folder.ts).
 *
 * The folder's path: a browser never learns where the folder is on disk, so the web app uses
 * the path the account has for it. A workspace the web app put on the account has its own row
 * (WEB_APP_DEVICE_ID, at `/workspace-folder/<folder name>`), and that row wins, so the web app's own runs keep
 * their paths when DBMN for VS Code later records the same folder. Every other path the account
 * has for the workspace is an alias: its runs open from the folder too.
 */
import type { AccountWorkspace } from './account-workspace';
import { DATA_DIR, LEGACY_DATA_DIR, type WorkspaceMarker } from './workspace-layout';

/** The account row for a workspace the web app set up or linked (one for every browser). */
export const WEB_APP_DEVICE_ID = 'web-app';

/**
 * Where the web app keeps a workspace it set up itself: a browser has only the folder's name.
 * Under `/workspace-folder`, never at `/dbmn`, which is the browser's own storage (a folder
 * named "dbmn" would otherwise be mistaken for it).
 */
export function webAppWorkspacePath(folderName: string): string {
    return `/workspace-folder/${folderName}`;
}

export type FolderCheck =
    | { ok: true; marker: WorkspaceMarker; root: string; aliases: string[] }
    /** Not usable as it is, and nothing to offer: say why. */
    | { ok: false; message: string }
    /** #441: can be set up here, if the user says so: `create` a new workspace, or `link` this one to the account. */
    | { ok: false; setUp: 'create' | 'link'; question: string; marker?: WorkspaceMarker };

export interface PickedFolder {
    name: string;
    marker?: WorkspaceMarker;
    /** It has DBMN for VS Code's history from before `.dbmn` (`.active8` only). */
    legacyData?: boolean;
}

export function checkPickedFolder(picked: PickedFolder, workspaces: AccountWorkspace[]): FolderCheck {
    const expected = workspaces[0];   // most recently used first
    if (picked.name === DATA_DIR || picked.name === LEGACY_DATA_DIR) {
        const pickThis = expected ? ` Pick ${expected.path}.` : '';
        return { ok: false, message: `That's DBMN's own folder (${picked.name}), inside the workspace. Pick the folder that contains it.${pickThis}` };
    }
    const vsCodeHint = expected && expected.deviceId !== WEB_APP_DEVICE_ID
        ? ` If DBMN for VS Code on this computer uses ${expected.path}, pick that folder instead, so both show the same History.`
        : '';
    if (!picked.marker) {
        return {
            ok: false,
            setUp: 'create',
            question: picked.legacyData
                ? `"${picked.name}" has DBMN for VS Code's History in it. Use it as your DBMN workspace? That History stays, and both show it.`
                : `"${picked.name}" isn't a DBMN workspace yet. Set it up as yours? DBMN keeps your History and run results in it.${vsCodeHint}`
        };
    }
    const mine = workspaces.filter(w => w.workspaceId === picked.marker!.id);
    if (mine.length === 0) {
        return {
            ok: false,
            setUp: 'link',
            marker: picked.marker,
            question: `"${picked.name}" is the DBMN workspace "${picked.marker.name}", not yet used with this account. Use it?${vsCodeHint}`
        };
    }
    const root = (mine.find(w => w.deviceId === WEB_APP_DEVICE_ID) ?? mine[0]).path;
    const aliases = [...new Set(mine.map(w => w.path))].filter(p => p !== root);
    return { ok: true, marker: picked.marker, root, aliases };
}

/**
 * #443: where a path recorded by DBMN for VS Code (or another computer) could have its workspace
 * folder, found by the folder's name: `/c:/Users/alex/Active8-Workspace/production/run.json`
 * with the folder "Active8-Workspace" gives `/c:/Users/alex/Active8-Workspace`. Every place the
 * name appears, outermost first; the caller keeps the first whose rest is in the folder. Paths are
 * normalised (`/`-separated, leading `/`). Names match ignoring case, as on Windows and macOS.
 */
export function rootsByFolderName(normalisedPath: string, folderName: string): string[] {
    const name = folderName.toLowerCase();
    const parts = normalisedPath.split('/').filter(Boolean);
    const roots: string[] = [];
    // Not the last part: a root has something in it
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].toLowerCase() === name) roots.push('/' + parts.slice(0, i + 1).join('/'));
    }
    return roots;
}

/** Whether `p` is `root` or under it. A Windows drive's letter matches in either case (`c:` and `C:`). */
export function isUnderRoot(p: string, root: string): boolean {
    const drive = /^\/[a-zA-Z]:(\/|$)/;
    const [a, b] = drive.test(root) && drive.test(p) ? [p.toLowerCase(), root.toLowerCase()] : [p, root];
    return a === b || a.startsWith(b + '/');
}
