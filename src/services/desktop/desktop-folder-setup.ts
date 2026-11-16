// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop app's first step, in its window: get onto a workspace folder before anything else
 * starts. The app never runs without one (desktop-workspace-folder.ts), so this returns only
 * when a folder is connected.
 *
 * In order:
 * 1. The folder this installation used last time, when it is still there: no question asked.
 * 2. Never chosen here: the folders the account says DBMN has used (DBMN for VS Code records
 *    its own). One of them on this computer: connected, no question asked. Several: the user
 *    says which.
 * 3. Otherwise the user chooses: the default folder, or another one in the computer's folder
 *    dialog. The question can't be closed, and comes back until a folder is connected.
 * A folder that was used before and is gone (moved, its drive not connected) is the user's to
 * settle the same way; it is never quietly replaced.
 */
import type { DbmnModalSpec, ModalHost } from '../../screens/modal.types';
import type { AccountWorkspace } from '../workspace/account-workspace';
import type { DesktopBridge, DesktopFolder, DesktopFolderResult, DesktopFolderState } from './desktop-protocol';

export type DesktopFolderBridge = Pick<DesktopBridge, 'folderState' | 'folderFind' | 'folderConnect' | 'folderChoose' | 'folderUseDefault'>;
export type ConnectedDesktopFolder = Extract<DesktopFolderState, { kind: 'connected' }>;

export interface DesktopFolderSetupDeps {
    bridge: DesktopFolderBridge;
    /** The account's workspaces, most recently used first. */
    workspaces(): Promise<AccountWorkspace[]>;
    modal: ModalHost;
    log?: (message: string, error?: unknown) => void;
}

const FOLDER_FIELD = 'folder';

/** The question, for where things stand. `problem`: why the last answer didn't connect a folder. */
export function folderQuestion(state: Exclude<DesktopFolderState, { kind: 'connected' }>, found: DesktopFolder[], problem?: string): DbmnModalSpec {
    const lead = problem ? `${problem}\n\n` : '';
    const chooseAnother = { id: 'choose', label: 'Choose another folder…', variant: 'secondary' as const };
    if (state.kind === 'missing') {
        return {
            title: 'Your workspace folder can\'t be found',
            body: `${lead}DBMN can't find ${state.path}. It may have been moved or renamed, or its drive isn't connected. `
                + `Put it back and try again, or use another folder. The default folder is ${state.defaultPath}.`,
            actions: [
                { id: 'retry', label: 'Try again', variant: 'secondary' },
                chooseAnother,
                { id: 'default', label: 'Use the default folder', variant: 'primary' }
            ],
            dismissible: false,
            size: 'md'
        };
    }
    if (found.length > 1) {
        return {
            title: 'Choose your DBMN workspace folder',
            body: `${lead}DBMN keeps your run history and results in a folder on this computer. More than one of your workspace folders is here: choose the one to use.`,
            fields: [{
                id: FOLDER_FIELD,
                type: 'radio',
                value: found[0].path,
                options: found.map(folder => ({ value: folder.path, label: folder.path }))
            }],
            actions: [chooseAnother, { id: 'use', label: 'Use this folder', variant: 'primary' }],
            dismissible: false,
            size: 'md'
        };
    }
    return {
        title: 'Choose your DBMN workspace folder',
        body: `${lead}DBMN keeps your run history and results in a folder on this computer. It will use ${state.defaultPath} unless you choose another folder. `
            + 'If you use DBMN for VS Code, choose the folder it uses and both show the same History.',
        actions: [chooseAnother, { id: 'default', label: 'Use this folder', variant: 'primary' }],
        dismissible: false,
        size: 'md'
    };
}

export async function connectDesktopFolder(deps: DesktopFolderSetupDeps): Promise<ConnectedDesktopFolder> {
    const { bridge, modal } = deps;
    const log = deps.log ?? (() => undefined);
    let problem: string | undefined;
    /** Step 2 is tried once: a folder that wouldn't connect by itself is for the user to settle. */
    let looked = false;
    let found: DesktopFolder[] = [];

    for (;;) {
        const state = await bridge.folderState();
        if (state.kind === 'connected') return state;

        if (state.kind === 'none' && !looked) {
            looked = true;
            try {
                const workspaces = await deps.workspaces();
                found = workspaces.length ? await bridge.folderFind(workspaces.map(w => ({ path: w.path, workspaceId: w.workspaceId }))) : [];
            } catch (error) {
                log('[Workspace] could not look for the account\'s workspace folders on this computer', error);
                found = [];
            }
            if (found.length === 1) {
                const result = await bridge.folderConnect({ path: found[0].path, workspaceId: found[0].workspaceId });
                found = [];
                if (result.ok) continue;
                problem = result.message;
            }
        }
        if (state.kind === 'missing') found = [];

        const answer = await modal.showModal(folderQuestion(state, found, problem));
        problem = undefined;
        let result: DesktopFolderResult | undefined;
        if (answer.actionId === 'choose') {
            result = await bridge.folderChoose();
        } else if (answer.actionId === 'default') {
            result = await bridge.folderUseDefault();
        } else if (answer.actionId === 'use') {
            const picked = found.find(folder => folder.path === answer.fields[FOLDER_FIELD]) ?? found[0];
            if (picked) result = await bridge.folderConnect({ path: picked.path, workspaceId: picked.workspaceId });
        }
        // 'retry', or the question went away unanswered: look again, and ask again
        if (result && !result.ok && !result.cancelled) problem = result.message;
    }
}
