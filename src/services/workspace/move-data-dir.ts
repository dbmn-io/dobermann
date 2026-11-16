// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: `.active8` → `.dbmn`, keeping older versions on the same history. Runs before anything
 * opens the workspace's files.
 *
 * - `.active8` alone (a workspace from before #344): rename it to `.dbmn`, and leave `.active8`
 *   as a link to `.dbmn` (a junction on Windows: no admin rights needed), so the marketplace
 *   version or a main-branch build keeps reading and writing the same files.
 * - The rename refused (Windows, while another window holds the database open): `.dbmn`
 *   becomes a link to `.active8` for now, so this version still uses the same files, and the
 *   move is finished on a later start.
 * - Neither (a new workspace): `.dbmn`, with the `.active8` link for older versions.
 * - Both as real folders: left alone and reported; `.dbmn` is used.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, LEGACY_DATA_DIR } from './workspace-layout';

export type MoveOutcome =
    | 'moved'          // .active8 renamed to .dbmn; .active8 is a link
    | 'linked-back'    // could not rename yet: .dbmn links to .active8
    | 'created'        // new workspace: .dbmn, plus the .active8 link
    | 'done'           // already moved
    | 'both-exist';    // two real folders: left alone

const lstat = (p: string) => { try { return fs.lstatSync(p); } catch { return undefined; } };

function link(target: string, at: string, platform: NodeJS.Platform): void {
    // A relative link survives the workspace folder being moved; a junction needs an absolute path
    if (platform === 'win32') fs.symlinkSync(target, at, 'junction');
    else fs.symlinkSync(path.basename(target), at, 'dir');
}

export function moveLegacyDataDir(root: string, platform: NodeJS.Platform = process.platform): MoveOutcome {
    const current = path.join(root, DATA_DIR);
    const legacy = path.join(root, LEGACY_DATA_DIR);
    let c = lstat(current);
    const l = lstat(legacy);

    // A rename that could not happen last time (.dbmn is our link back): try again now
    if (c?.isSymbolicLink() && l?.isDirectory() && !l.isSymbolicLink()) {
        fs.unlinkSync(current);
        c = undefined;
    }

    if (c?.isDirectory()) {
        if (!l) {
            link(current, legacy, platform);
            return 'done';
        }
        return l.isSymbolicLink() ? 'done' : 'both-exist';
    }
    if (!l) {
        fs.mkdirSync(current, { recursive: true });
        link(current, legacy, platform);
        return 'created';
    }
    try {
        fs.renameSync(legacy, current);
    } catch {
        link(legacy, current, platform);
        return 'linked-back';
    }
    link(current, legacy, platform);
    return 'moved';
}
