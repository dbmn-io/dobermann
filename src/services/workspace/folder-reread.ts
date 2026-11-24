// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * When the web app reads a workspace folder file again before a screen uses it (web/src/shell/node/fs.ts,
 * loadFromFolder). It holds what it read in memory; another writer (DBMN for VS Code) may have saved the file since.
 * A run's archive is one file per endpoint folder, so a later VS Code run on the same endpoint grows the archive the web
 * app already holds, and that run didn't open until a reload (#459).
 *
 * Read it: when it isn't held yet, or when the folder's copy differs from the one last read or written (size or time),
 * unless it holds changes of its own not saved yet (the save checks and merges then).
 */
export interface FolderStamp {
    size: number;
    lastModified: number;
}

export function readsFromFolder(held: boolean, unsaved: boolean, known: FolderStamp | undefined, now: FolderStamp | undefined): boolean {
    if (!held) return true;
    if (unsaved || !now) return false;
    return !known || known.size !== now.size || known.lastModified !== now.lastModified;
}
