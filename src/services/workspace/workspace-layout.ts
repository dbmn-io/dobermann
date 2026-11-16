// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Where DBMN keeps its own files inside a workspace folder (#344): the history database, batch
 * files and the workspace marker, in `.dbmn/`. Before #344 this was `.active8/`; see
 * move-data-dir.ts. Run results stay in the workspace's environment folders, as before.
 */

/** DBMN's own folder inside a workspace. */
export const DATA_DIR = '.dbmn';
/** Its name before #344. Kept as a link to DATA_DIR so older versions share the same history. */
export const LEGACY_DATA_DIR = '.active8';
/** The marker in DATA_DIR that says which DBMN workspace a folder is. */
export const WORKSPACE_MARKER = 'workspace.json';

/** `.dbmn/workspace.json`: lets the web app check it was given the right folder. */
export interface WorkspaceMarker {
    /** Random, made once: the same folder keeps it for good. */
    id: string;
    /** The folder's name when it was made, for messages ("the workspace 'Dobermann-Workspace'"). */
    name: string;
    createdAt: string;
    /** VS Code's machine id on the device that made it. */
    createdOn?: string;
}

export function parseWorkspaceMarker(text: string): WorkspaceMarker | undefined {
    try {
        const value = JSON.parse(text) as Partial<WorkspaceMarker>;
        return typeof value.id === 'string' && value.id && typeof value.name === 'string'
            ? { id: value.id, name: value.name, createdAt: String(value.createdAt ?? ''), createdOn: value.createdOn }
            : undefined;
    } catch {
        return undefined;
    }
}
