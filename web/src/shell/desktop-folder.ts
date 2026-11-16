// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop app's workspace folder, from its window. The main process owns the folder
 * (src/services/desktop/desktop-workspace-folder.ts): this is the shell's side of it.
 *
 * - `desktopFolderSource`: folder mode's files (./node/fs.ts), read and written by the main process.
 * - `desktopFolder`: the app's first step. It returns only once a folder is connected (found,
 *   or chosen by the user: src/services/desktop/desktop-folder-setup.ts), and puts the folder on
 *   the account's list of workspaces, as DBMN for VS Code does with its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModalHost } from '../../../src/screens/modal.types';
import { connectDesktopFolder, type ConnectedDesktopFolder } from '../../../src/services/desktop/desktop-folder-setup';
import type { DesktopBridge, DesktopFolderFileReply } from '../../../src/services/desktop/desktop-protocol';
import { accountWorkspaces, recordWorkspace } from '../../../src/platform/supabase/account-workspaces';
import type { FolderSource } from './node/folder-source';

export function desktopFolderSource(bridge: Pick<DesktopBridge, 'folderFile'>): FolderSource {
    /** A request the main process refused or couldn't do is an error here, never a missing file. */
    const done = (reply: DesktopFolderFileReply): Extract<DesktopFolderFileReply, { ok: true }> => {
        if (!reply.ok) throw new Error(reply.error);
        return reply;
    };
    return {
        async stat(parts) {
            return done(await bridge.folderFile({ op: 'stat', parts })).file;
        },
        async read(parts) {
            const file = done(await bridge.folderFile({ op: 'read', parts })).file;
            return file?.bytes ? { size: file.size, lastModified: file.lastModified, bytes: file.bytes } : undefined;
        },
        async write(parts, bytes, at) {
            // A view on a bigger buffer is sent as just its own bytes
            const own = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
            return done(await bridge.folderFile({ op: 'write', parts, bytes: own, ...(at === undefined ? {} : { at }) })).file;
        },
        async remove(parts) {
            done(await bridge.folderFile({ op: 'remove', parts }));
        },
        async list(parts) {
            return done(await bridge.folderFile({ op: 'list', parts })).entries;
        }
    };
}

export async function desktopFolder(bridge: DesktopBridge, client: SupabaseClient, modal: ModalHost): Promise<ConnectedDesktopFolder> {
    const log = (message: string, error?: unknown): void => { console.warn(message, error ?? ''); };
    const connected = await connectDesktopFolder({ bridge, workspaces: () => accountWorkspaces(client), modal, log });
    const { folder, deviceId } = connected;
    // The account's list: where DBMN for VS Code, the web app and another computer's app look
    void recordWorkspace(client, { workspaceId: folder.workspaceId, deviceId, name: folder.name, path: folder.path })
        .catch(error => log('[Workspace] could not record the workspace on the account', error));
    return connected;
}
