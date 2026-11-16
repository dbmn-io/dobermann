// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop app's first step: it only starts on a workspace folder. Found when it can be,
 * and the user's to choose when it can't.
 */
import { expect } from 'chai';
import type { DbmnModalResult, DbmnModalSpec } from '../../../screens/modal.types';
import { connectDesktopFolder, type DesktopFolderBridge } from '../../../services/desktop/desktop-folder-setup';
import type { DesktopFolder, DesktopFolderResult, DesktopFolderState } from '../../../services/desktop/desktop-protocol';
import type { AccountWorkspace } from '../../../services/workspace/account-workspace';

const DEFAULT = '/home/pup/Dobermann-Workspace';
const rest = { deviceId: 'desktop-1', defaultPath: DEFAULT };
const folder = (path: string, workspaceId: string): DesktopFolder => ({ path, name: path.split('/').pop() ?? path, workspaceId });
const onAccount = (path: string, workspaceId: string): AccountWorkspace => ({ path, workspaceId, deviceId: 'vscode-machine', name: 'w', updatedAt: '2026-10-01T00:00:00Z' });

/** A computer: which folders are on it, and what the user does at the folder dialog. */
function computer(options: { state: DesktopFolderState; onDisk?: DesktopFolder[]; dialog?: Array<DesktopFolderResult> }) {
    let state = options.state;
    const calls: string[] = [];
    const connect = (connected: DesktopFolder): DesktopFolderResult => {
        state = { kind: 'connected', folder: connected, ...rest };
        return { ok: true, folder: connected };
    };
    const bridge: DesktopFolderBridge = {
        folderState: async () => state,
        folderFind: async candidates => {
            calls.push(`find ${candidates.map(c => c.path).join(',')}`);
            return (options.onDisk ?? []).filter(f => candidates.some(c => c.path === f.path && c.workspaceId === f.workspaceId));
        },
        folderConnect: async candidate => {
            calls.push(`connect ${candidate.path}`);
            const found = (options.onDisk ?? []).find(f => f.path === candidate.path && f.workspaceId === candidate.workspaceId);
            return found ? connect(found) : { ok: false, message: 'That folder isn\'t a DBMN workspace on this computer any more. Choose a folder.' };
        },
        folderChoose: async () => {
            calls.push('choose');
            const result = options.dialog?.shift() ?? { ok: false, cancelled: true, message: 'No folder was chosen.' };
            return result.ok ? connect(result.folder) : result;
        },
        folderUseDefault: async () => {
            calls.push('default');
            return connect(folder(DEFAULT, 'ws-new'));
        }
    };
    return { bridge, calls, putBack: (connected: DesktopFolder) => { state = { kind: 'connected', folder: connected, ...rest }; } };
}

/** The user: one answer per question, in order. */
function user(answers: Array<Partial<DbmnModalResult> & { actionId: string }>) {
    const asked: DbmnModalSpec[] = [];
    return {
        asked,
        modal: {
            showModal: async (spec: DbmnModalSpec): Promise<DbmnModalResult> => {
                asked.push(spec);
                const answer = answers.shift();
                if (!answer) throw new Error(`Asked again with no answer left: ${spec.title}`);
                return { fields: {}, ...answer };
            }
        }
    };
}

describe('The desktop app starts on a workspace folder', () => {
    it('the folder used last time: nothing asked, the account not even read', async () => {
        const mine = folder('/home/pup/Dobermann-Workspace', 'ws-1');
        const { bridge, calls } = computer({ state: { kind: 'connected', folder: mine, ...rest } });
        const { modal, asked } = user([]);
        const connected = await connectDesktopFolder({ bridge, modal, workspaces: async () => { throw new Error('not needed'); } });
        expect(connected.folder).to.deep.equal(mine);
        expect(asked).to.have.length(0);
        expect(calls).to.deep.equal([]);
    });

    it('never chosen here, and the folder DBMN for VS Code uses is on this computer: connected, nothing asked', async () => {
        const mine = folder('/home/pup/Dobermann-Workspace', 'ws-1');
        const { bridge, calls } = computer({ state: { kind: 'none', ...rest }, onDisk: [mine] });
        const { modal, asked } = user([]);
        const connected = await connectDesktopFolder({
            bridge, modal,
            workspaces: async () => [onAccount(mine.path, 'ws-1'), onAccount('C:\\Users\\pup\\Dobermann-Workspace', 'ws-laptop')]
        });
        expect(connected.folder).to.deep.equal(mine);
        expect(asked).to.have.length(0);
        expect(calls).to.deep.equal([`find ${mine.path},C:\\Users\\pup\\Dobermann-Workspace`, `connect ${mine.path}`]);
    });

    it('several of the account\'s folders are here: the user says which', async () => {
        const first = folder('/home/pup/Dobermann-Workspace', 'ws-1');
        const second = folder('/data/Work-Runs', 'ws-2');
        const { bridge, calls } = computer({ state: { kind: 'none', ...rest }, onDisk: [first, second] });
        const { modal, asked } = user([{ actionId: 'use', fields: { folder: second.path } }]);
        const connected = await connectDesktopFolder({ bridge, modal, workspaces: async () => [onAccount(first.path, 'ws-1'), onAccount(second.path, 'ws-2')] });
        expect(connected.folder).to.deep.equal(second);
        expect(asked).to.have.length(1);
        expect(asked[0].fields?.[0].options?.map(option => option.value)).to.deep.equal([first.path, second.path]);
        expect(asked[0].dismissible, 'the question can\'t be closed').to.equal(false);
        expect(calls.slice(-1)).to.deep.equal([`connect ${second.path}`]);
    });

    it('none of them is here: the default folder, on the user\'s say', async () => {
        const { bridge, calls } = computer({ state: { kind: 'none', ...rest } });
        const { modal, asked } = user([{ actionId: 'default' }]);
        const connected = await connectDesktopFolder({ bridge, modal, workspaces: async () => [onAccount('C:\\Users\\pup\\Dobermann-Workspace', 'ws-laptop')] });
        expect(connected.folder.path).to.equal(DEFAULT);
        expect(asked[0].title).to.equal('Choose your DBMN workspace folder');
        expect(asked[0].body).to.contain(DEFAULT);
        expect(asked[0].dismissible).to.equal(false);
        expect(calls.slice(-1)).to.deep.equal(['default']);
    });

    it('asks until a folder is connected: a closed dialog and a refused folder both come back to the question', async () => {
        const chosen = folder('/data/Runs', 'ws-9');
        const { bridge } = computer({
            state: { kind: 'none', ...rest },
            dialog: [
                { ok: false, cancelled: true, message: 'No folder was chosen.' },
                { ok: false, message: 'DBMN can\'t write to /mnt/readonly. Choose a folder you can save files in.' },
                { ok: true, folder: chosen }
            ]
        });
        // The third: the question went away unanswered (the page's own time limit)
        const { modal, asked } = user([{ actionId: 'choose' }, { actionId: 'choose' }, { actionId: 'dismiss' }, { actionId: 'choose' }]);
        const connected = await connectDesktopFolder({ bridge, modal, workspaces: async () => [] });
        expect(connected.folder).to.deep.equal(chosen);
        expect(asked).to.have.length(4);
        expect(asked[1].body, 'closing the dialog is not an error').to.not.contain('No folder was chosen');
        expect(asked[2].body, 'why the folder was refused').to.contain('DBMN can\'t write to /mnt/readonly.');
        expect(asked[3].body, 'said once').to.not.contain('/mnt/readonly');
    });

    it('the account can\'t be read (offline): the user still chooses', async () => {
        const { bridge } = computer({ state: { kind: 'none', ...rest } });
        const { modal, asked } = user([{ actionId: 'default' }]);
        const connected = await connectDesktopFolder({ bridge, modal, workspaces: async () => { throw new Error('offline'); } });
        expect(connected.folder.path).to.equal(DEFAULT);
        expect(asked).to.have.length(1);
    });

    it('the folder used before has gone: said so, and never swapped for another without asking', async () => {
        const gone = '/media/usb/Dobermann-Workspace';
        const machine = computer({ state: { kind: 'missing', path: gone, ...rest }, onDisk: [folder('/home/pup/Other', 'ws-2')] });
        const first = user([{ actionId: 'retry' }, { actionId: 'default' }]);
        const connected = await connectDesktopFolder({ bridge: machine.bridge, modal: first.modal, workspaces: async () => [onAccount('/home/pup/Other', 'ws-2')] });
        expect(first.asked[0].title).to.equal('Your workspace folder can\'t be found');
        expect(first.asked[0].body).to.contain(gone);
        expect(first.asked[0].actions.map(action => action.id)).to.deep.equal(['retry', 'choose', 'default']);
        expect(machine.calls, 'no other folder was looked for or connected').to.deep.equal(['default']);
        expect(connected.folder.path).to.equal(DEFAULT);
    });

    it('the folder comes back (the drive is plugged in): Try again connects it', async () => {
        const mine = folder('/media/usb/Dobermann-Workspace', 'ws-1');
        const machine = computer({ state: { kind: 'missing', path: mine.path, ...rest } });
        const modal = {
            showModal: async (): Promise<DbmnModalResult> => {
                machine.putBack(mine);
                return { actionId: 'retry', fields: {} };
            }
        };
        const connected = await connectDesktopFolder({ bridge: machine.bridge, modal, workspaces: async () => [] });
        expect(connected.folder).to.deep.equal(mine);
    });
});
