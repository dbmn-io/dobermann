// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #459: the web app read a workspace folder file once and never again, so a later VS Code run on an endpoint (its
 * archive grown in the folder) didn't open until a reload. Before a screen uses a file it is read again when the
 * folder's copy changed, unless it holds unsaved changes of its own.
 *   npm run test:core
 */
import * as assert from 'assert';
import { readsFromFolder } from '../../../services/workspace/folder-reread';

describe('The web app reads a folder file again when another writer changed it', () => {
    const read = { size: 400, lastModified: 1000 };

    it('not held yet: read', () => {
        assert.strictEqual(readsFromFolder(false, false, undefined, undefined), true);
    });

    it('a run archive VS Code grew since: read again', () => {
        assert.strictEqual(readsFromFolder(true, false, read, { size: 900, lastModified: 2000 }), true);
        assert.strictEqual(readsFromFolder(true, false, read, { size: 400, lastModified: 2000 }), true, 'saved again, same size');
    });

    it('unchanged, or gone from the folder: the copy held stays', () => {
        assert.strictEqual(readsFromFolder(true, false, read, { ...read }), false);
        assert.strictEqual(readsFromFolder(true, false, read, undefined), false);
    });

    it('changes of ours not saved yet: never read over (the save checks and merges)', () => {
        assert.strictEqual(readsFromFolder(true, true, read, { size: 900, lastModified: 2000 }), false);
    });
});
