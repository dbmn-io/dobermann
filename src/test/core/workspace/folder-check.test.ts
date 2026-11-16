// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { checkPickedFolder, isUnderRoot, rootsByFolderName, WEB_APP_DEVICE_ID, webAppWorkspacePath } from '../../../services/workspace/folder-check';
import type { AccountWorkspace } from '../../../services/workspace/account-workspace';

/** #344: the web app on the user's DBMN workspace folder; #441: it can set one up itself. */
const home: AccountWorkspace = { workspaceId: 'ws-1', deviceId: 'dev', name: 'Dobermann-Workspace', path: '/home/alex/Dobermann-Workspace', updatedAt: '2026-10-09' };
const marker = { id: 'ws-1', name: 'Dobermann-Workspace', createdAt: '' };

describe('checkPickedFolder (#344, #441)', () => {
    it('the right folder: accepted, with the path VS Code uses', () => {
        expect(checkPickedFolder({ name: 'Dobermann-Workspace', marker }, [home])).to.deep.equal({ ok: true, marker, root: '/home/alex/Dobermann-Workspace', aliases: [] });
    });

    it('.dbmn itself (or .active8): pick the folder that contains it', () => {
        for (const name of ['.dbmn', '.active8']) {
            const result = checkPickedFolder({ name }, [home]);
            expect(result.ok).to.equal(false);
            expect('setUp' in result, 'nothing to set up').to.equal(false);
            expect((result as { message: string }).message).to.contain('Pick the folder that contains it. Pick /home/alex/Dobermann-Workspace.');
        }
    });

    it('#441: no marker and nothing on the account (a new computer): offered to set up, no VS Code needed', () => {
        const result = checkPickedFolder({ name: 'dbmn' }, []);
        expect(result).to.deep.include({ ok: false, setUp: 'create' });
        const question = (result as { question: string }).question;
        expect(question).to.equal('"dbmn" isn\'t a DBMN workspace yet. Set it up as yours? DBMN keeps your History and run results in it.');
        expect(question).not.to.contain('VS Code');
    });

    it('#441: no marker, VS Code has a workspace on the account: offered, and VS Code\'s folder named in case it is on this computer', () => {
        const result = checkPickedFolder({ name: 'Downloads' }, [home]);
        expect(result).to.deep.include({ ok: false, setUp: 'create' });
        expect((result as { question: string }).question).to.contain('If DBMN for VS Code on this computer uses /home/alex/Dobermann-Workspace, pick that folder instead');
    });

    it('#441: a folder only DBMN for VS Code 0.3.1 used (.active8, no marker): offered, its History kept', () => {
        const result = checkPickedFolder({ name: 'dbmn', legacyData: true }, []);
        expect(result).to.deep.include({ ok: false, setUp: 'create' });
        expect((result as { question: string }).question).to.contain('has DBMN for VS Code\'s History in it');
    });

    it('#441: a marked folder not on this account: offered to link it', () => {
        const other = { id: 'ws-other', name: 'Old', createdAt: '' };
        const result = checkPickedFolder({ name: 'Old', marker: other }, [home]);
        expect(result).to.deep.include({ ok: false, setUp: 'link', marker: other });
        expect((result as { question: string }).question).to.contain('"Old" is the DBMN workspace "Old", not yet used with this account. Use it?');
    });

    it('#441: set up by the web app, then VS Code records the same folder: the web app keeps its own path, VS Code\'s is an alias', () => {
        const web: AccountWorkspace = { workspaceId: 'ws-1', deviceId: WEB_APP_DEVICE_ID, name: 'dbmn', path: webAppWorkspacePath('dbmn'), updatedAt: '2026-11-12' };
        const vsCode: AccountWorkspace = { ...home, path: 'C:\\Users\\alex\\dbmn', updatedAt: '2026-11-13' };
        expect(checkPickedFolder({ name: 'dbmn', marker }, [vsCode, web])).to.deep.equal({ ok: true, marker, root: '/workspace-folder/dbmn', aliases: ['C:\\Users\\alex\\dbmn'] });
    });

    it('#441: the web app\'s path for a folder named "dbmn" is not the browser\'s own storage (/dbmn)', () => {
        expect(webAppWorkspacePath('dbmn')).to.equal('/workspace-folder/dbmn');
    });

    it('VS Code on two computers: the latest path is the root, the other an alias', () => {
        const laptop: AccountWorkspace = { ...home, deviceId: 'laptop', path: '/Users/alex/Dobermann-Workspace', updatedAt: '2026-10-01' };
        expect(checkPickedFolder({ name: 'Dobermann-Workspace', marker }, [home, laptop])).to.deep.equal({ ok: true, marker, root: home.path, aliases: [laptop.path] });
    });

    describe('#443: VS Code\'s paths for a folder the account has no path for', () => {
        // As 0.3.1 recorded it on Windows, normalised as the web app's files are
        const recorded = '/c:/Users/foranjam/Active8-Workspace/production/labor-managemetn-core-activity/batch/2026-11-12T01-10-11_xjf/transaction-001-response.json';

        it('the folder is found by its name in the path', () => {
            expect(rootsByFolderName(recorded, 'Active8-Workspace')).to.deep.equal(['/c:/Users/foranjam/Active8-Workspace']);
        });

        it('ignoring case, and every place the name appears, outermost first (the caller keeps the one that holds the file)', () => {
            expect(rootsByFolderName('/c:/dbmn/work/DBMN/production/run.json', 'dbmn')).to.deep.equal(['/c:/dbmn', '/c:/dbmn/work/DBMN']);
        });

        it('not when the name is only the file itself, or absent', () => {
            expect(rootsByFolderName('/c:/Users/alex/dbmn', 'dbmn')).to.deep.equal([]);
            expect(rootsByFolderName(recorded, 'Dobermann-Workspace')).to.deep.equal([]);
        });

        it('a Windows drive letter matches in either case; other paths match exactly', () => {
            expect(isUnderRoot(recorded, '/C:/Users/foranjam/Active8-Workspace')).to.equal(true);
            expect(isUnderRoot('/c:/Users/foranjam/Active8-Workspace', '/c:/Users/foranjam/Active8-Workspace')).to.equal(true);
            expect(isUnderRoot('/c:/Users/foranjam/Active8-Workspace-2/x', '/c:/Users/foranjam/Active8-Workspace')).to.equal(false);
            expect(isUnderRoot('/home/alex/Dobermann-Workspace/x', '/home/alex/dobermann-workspace')).to.equal(false);
        });
    });
});
