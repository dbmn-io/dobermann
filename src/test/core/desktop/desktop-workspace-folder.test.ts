// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop app's workspace folder, as its main process owns it: which folder is this
 * installation's, how one is found, chosen or made, and what the window may read and write.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { desktopWorkspaceFolder, type DesktopWorkspaceFolder } from '../../../services/desktop/desktop-workspace-folder';
import { parseWorkspaceMarker } from '../../../services/workspace/workspace-layout';

const text = (value: string) => new TextEncoder().encode(value);

describe('The desktop app\'s workspace folder', () => {
    let dir: string;
    let home: string;
    let configFile: string;
    const open = (): DesktopWorkspaceFolder => desktopWorkspaceFolder({ configFile, homeDir: () => home });
    const marker = (root: string) => parseWorkspaceMarker(fs.readFileSync(path.join(root, '.dbmn', 'workspace.json'), 'utf8'));
    /** A folder DBMN for VS Code has used: marked. */
    const vscodeWorkspace = (name: string, id: string): string => {
        const root = path.join(dir, name);
        fs.mkdirSync(path.join(root, '.dbmn'), { recursive: true });
        fs.writeFileSync(path.join(root, '.dbmn', 'workspace.json'), JSON.stringify({ id, name, createdAt: '2026-01-01T00:00:00.000Z' }));
        return root;
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-desktop-folder-'));
        home = path.join(dir, 'home');
        fs.mkdirSync(home);
        configFile = path.join(dir, 'app-data', 'workspace-folder.json');
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a new installation has no folder, and says where the default one would be', () => {
        const state = open().state();
        expect(state.kind).to.equal('none');
        expect(state.defaultPath).to.equal(path.join(home, 'Dobermann-Workspace'));
        expect(state.deviceId).to.match(/^desktop-[0-9a-f-]{36}$/);
        expect(open().state().deviceId, 'the same installation next time').to.equal(state.deviceId);
        expect(fs.existsSync(state.defaultPath), 'nothing is made until the user says so').to.equal(false);
    });

    it('the default folder is made, marked as a DBMN workspace, and remembered', () => {
        const workspace = open();
        const result = workspace.useDefault();
        const root = path.join(home, 'Dobermann-Workspace');
        expect(result).to.deep.include({ ok: true });
        expect(marker(root)?.name).to.equal('Dobermann-Workspace');
        expect(fs.lstatSync(path.join(root, '.active8')).isSymbolicLink(), 'older versions of DBMN for VS Code find the same history').to.equal(true);

        // Next start: connected, with nothing asked
        const next = open().state();
        expect(next).to.deep.include({ kind: 'connected' });
        if (next.kind === 'connected') expect(next.folder).to.deep.equal({ path: root, name: 'Dobermann-Workspace', workspaceId: marker(root)!.id });
    });

    it('a folder DBMN for VS Code uses keeps its own marker', () => {
        const root = vscodeWorkspace('Shared', 'ws-shared');
        const result = open().usePicked(root);
        expect(result).to.deep.equal({ ok: true, folder: { path: root, name: 'Shared', workspaceId: 'ws-shared' } });
    });

    it('DBMN\'s own folder inside a workspace is not a workspace', () => {
        const root = vscodeWorkspace('Shared', 'ws-shared');
        const result = open().usePicked(path.join(root, '.dbmn'));
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.message).to.contain('Choose the folder that contains it');
        expect(open().state().kind, 'nothing was remembered').to.equal('none');
    });

    it('finds which of the account\'s folders are on this computer, by their marker', () => {
        const mine = vscodeWorkspace('Mine', 'ws-mine');
        const other = vscodeWorkspace('Other', 'ws-other');
        const workspace = open();
        const found = workspace.find([
            { path: mine, workspaceId: 'ws-mine' },
            { path: other, workspaceId: 'ws-not-this-one' },                       // a different workspace is at that path now
            { path: path.join(dir, 'on-another-computer'), workspaceId: 'ws-laptop' },
            { path: 'relative/Workspace', workspaceId: 'ws-mine' },
            { path: mine, workspaceId: 'ws-mine' }                                 // the same folder from a second device
        ]);
        expect(found).to.deep.equal([{ path: mine, name: 'Mine', workspaceId: 'ws-mine' }]);
        expect(workspace.find('not a list')).to.deep.equal([]);
    });

    it('the window can only point it at a folder that holds the workspace it names', () => {
        const mine = vscodeWorkspace('Mine', 'ws-mine');
        const workspace = open();
        expect(workspace.connect({ path: home, workspaceId: 'ws-mine' }).ok, 'any folder').to.equal(false);
        expect(workspace.connect({ path: mine, workspaceId: 'ws-someone-else' }).ok, 'a workspace, but not that one').to.equal(false);
        expect(workspace.connect({ path: mine }).ok, 'no workspace named').to.equal(false);
        expect(workspace.state().kind).to.equal('none');
        expect(fs.existsSync(path.join(home, '.dbmn')), 'and nothing was written to the refused folder').to.equal(false);

        expect(workspace.connect({ path: mine, workspaceId: 'ws-mine' })).to.deep.include({ ok: true });
        expect(workspace.state()).to.deep.include({ kind: 'connected' });
    });

    it('a remembered folder that has gone is reported, never made again or replaced', () => {
        const root = vscodeWorkspace('Mine', 'ws-mine');
        expect(open().usePicked(root).ok).to.equal(true);
        const away = path.join(dir, 'Moved');
        fs.renameSync(root, away);

        const workspace = open();
        expect(workspace.state()).to.deep.include({ kind: 'missing', path: root });
        expect(fs.existsSync(root)).to.equal(false);
        expect(workspace.root()).to.equal(undefined);

        // Put back (the drive is connected again): in use without asking
        fs.renameSync(away, root);
        expect(workspace.state()).to.deep.include({ kind: 'connected' });
    });

    it('it goes missing while the app is open: noticed at the next look', () => {
        const root = vscodeWorkspace('Mine', 'ws-mine');
        const workspace = open();
        workspace.usePicked(root);
        expect(workspace.state().kind).to.equal('connected');
        fs.renameSync(root, path.join(dir, 'Moved'));
        expect(workspace.state()).to.deep.include({ kind: 'missing', path: root });
    });

    describe('its files, for the window', () => {
        let root: string;
        let workspace: DesktopWorkspaceFolder;
        beforeEach(() => {
            root = vscodeWorkspace('Mine', 'ws-mine');
            workspace = open();
            workspace.usePicked(root);
        });

        it('reads, writes whole, and grows a file from a position', async () => {
            const parts = ['.dbmn', 'batches', 'run-1', 'archive.jsonl'];
            expect(await workspace.file({ op: 'stat', parts }), 'not there yet').to.deep.equal({ ok: true, file: undefined });
            expect(await workspace.file({ op: 'read', parts })).to.deep.equal({ ok: true });

            const written = await workspace.file({ op: 'write', parts, bytes: text('one\n') });
            expect(written).to.deep.include({ ok: true });
            expect(fs.readFileSync(path.join(root, ...parts), 'utf8')).to.equal('one\n');

            const grown = await workspace.file({ op: 'write', parts, bytes: text('two\n'), at: 4 });
            expect(grown.ok && grown.file?.size).to.equal(8);
            expect(fs.readFileSync(path.join(root, ...parts), 'utf8')).to.equal('one\ntwo\n');

            const read = await workspace.file({ op: 'read', parts });
            expect(read.ok && new TextDecoder().decode(read.file?.bytes)).to.equal('one\ntwo\n');
            const stat = await workspace.file({ op: 'stat', parts });
            expect(stat.ok && stat.file, 'stat and read agree, so a change by another writer shows').to.deep.equal(read.ok && { size: read.file!.size, lastModified: read.file!.lastModified });
            expect(fs.readdirSync(path.dirname(path.join(root, ...parts))), 'no temporary file left behind').to.deep.equal(['archive.jsonl']);
        });

        it('lists a folder and removes a file', async () => {
            await workspace.file({ op: 'write', parts: ['Training Ground', 'run.json'], bytes: text('{}') });
            const top = await workspace.file({ op: 'list', parts: [] });
            expect(top.ok && top.entries?.find(entry => entry.name === 'Training Ground')).to.deep.equal({ name: 'Training Ground', kind: 'directory' });
            const inside = await workspace.file({ op: 'list', parts: ['Training Ground'] });
            expect(inside.ok && inside.entries).to.deep.equal([{ name: 'run.json', kind: 'file' }]);
            expect(await workspace.file({ op: 'list', parts: ['nowhere'] })).to.deep.equal({ ok: true });

            expect(await workspace.file({ op: 'remove', parts: ['Training Ground', 'run.json'] })).to.deep.equal({ ok: true });
            expect(fs.existsSync(path.join(root, 'Training Ground', 'run.json'))).to.equal(false);
            expect(await workspace.file({ op: 'remove', parts: ['Training Ground', 'run.json'] }), 'already gone').to.deep.equal({ ok: true });
        });

        it('never reaches outside the workspace folder', async () => {
            const outside = path.join(dir, 'secret.txt');
            fs.writeFileSync(outside, 'secret');
            for (const parts of [['..', 'secret.txt'], ['.dbmn', '..', '..', 'secret.txt'], ['../secret.txt'], [outside], ['a\\..\\..\\secret.txt'], ['.'], [''], []]) {
                for (const op of ['read', 'stat', 'remove'] as const) {
                    expect(await workspace.file({ op, parts }), `${op} ${JSON.stringify(parts)}`).to.deep.equal({ ok: false, error: 'Not a workspace file request.' });
                }
                expect(await workspace.file({ op: 'write', parts, bytes: text('x') }), `write ${JSON.stringify(parts)}`).to.deep.equal({ ok: false, error: 'Not a workspace file request.' });
            }
            expect(await workspace.file({ op: 'list', parts: ['..'] })).to.deep.equal({ ok: false, error: 'Not a workspace file request.' });
            expect(fs.readFileSync(outside, 'utf8')).to.equal('secret');
        });

        it('on Windows a name is never a drive', async () => {
            const windows = desktopWorkspaceFolder({ configFile, homeDir: () => home, platform: 'win32' });
            expect(await windows.file({ op: 'read', parts: ['C:', 'Windows', 'win.ini'] })).to.deep.equal({ ok: false, error: 'Not a file name.' });
        });

        it('a save never makes a folder that has gone again', async () => {
            fs.renameSync(root, path.join(dir, 'Moved'));
            const reply = await workspace.file({ op: 'write', parts: ['.dbmn', 'executions.db'], bytes: text('db') });
            expect(reply).to.deep.equal({ ok: false, error: `The workspace folder ${root} can't be found.` });
            expect(fs.existsSync(root)).to.equal(false);
        });

        it('answers nothing without a folder', async () => {
            fs.rmSync(configFile);
            const fresh = open();
            expect(await fresh.file({ op: 'read', parts: ['.dbmn', 'workspace.json'] })).to.deep.equal({ ok: false, error: 'No workspace folder is connected.' });
            expect(fresh.root()).to.equal(undefined);
        });
    });
});
