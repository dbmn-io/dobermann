// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { moveLegacyDataDir } from '../../../../services/workspace/move-data-dir';

/** #344: `.active8` → `.dbmn`, older versions still on the same files. */
describe('moveLegacyDataDir (#344)', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-move-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const write = (rel: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    };
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const isLink = (rel: string) => fs.lstatSync(path.join(root, rel)).isSymbolicLink();

    it('a workspace from before: renamed, and .active8 still reaches the same files', () => {
        write('.active8/executions.db', 'history');
        expect(moveLegacyDataDir(root, 'linux')).to.equal('moved');
        expect(read('.dbmn/executions.db')).to.equal('history');
        expect(isLink('.active8')).to.equal(true);
        write('.active8/written-by-an-older-version', 'x');   // an older version writes through the link
        expect(read('.dbmn/written-by-an-older-version')).to.equal('x');
        expect(moveLegacyDataDir(root, 'linux'), 'once').to.equal('done');
    });

    it('a new workspace: .dbmn, with the link for older versions', () => {
        expect(moveLegacyDataDir(root, 'linux')).to.equal('created');
        expect(fs.statSync(path.join(root, '.dbmn')).isDirectory()).to.equal(true);
        expect(isLink('.active8')).to.equal(true);
    });

    it('rename refused: .dbmn links back for now, and the move finishes on a later start', () => {
        write('.active8/executions.db', 'history');
        const rename = fs.renameSync;
        (fs as { renameSync: typeof fs.renameSync }).renameSync = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
        try {
            expect(moveLegacyDataDir(root, 'linux')).to.equal('linked-back');
        } finally {
            (fs as { renameSync: typeof fs.renameSync }).renameSync = rename;
        }
        expect(isLink('.dbmn')).to.equal(true);
        expect(read('.dbmn/executions.db'), 'this version still uses the same files').to.equal('history');
        expect(moveLegacyDataDir(root, 'linux')).to.equal('moved');
        expect(isLink('.dbmn')).to.equal(false);
        expect(read('.dbmn/executions.db')).to.equal('history');
    });

    it('two real folders are left alone', () => {
        write('.active8/executions.db', 'old');
        write('.dbmn/executions.db', 'new');
        expect(moveLegacyDataDir(root, 'linux')).to.equal('both-exist');
        expect(read('.active8/executions.db')).to.equal('old');
    });
});
