// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which of the web app's file writes go out at once, and which wait for the next batch (web/src/shell/node/fs.ts). A
 * change saved just before a reload was lost (2026-11-23: a saved search deleted, the page reloaded at once, and it came
 * back): files were only written out 300 ms after a change. Small JSON files written whole (a saved query, a lookup
 * table, a setting) now go out at once; the run history's database, a run's archive growing by appends, and anything
 * large stay batched, so they never start a write on every change.
 *   npm run test:core
 */
import * as assert from 'assert';
import { writesNow, WRITE_NOW_MAX } from '../../../services/workspace/write-now';

describe('The web app\'s file writes: at once, or batched', () => {
    it('a saved query, a lookup table and a deleted query file go out at once', () => {
        assert.strictEqual(writesNow('/ws/Queries/Stock/query.json', 2_000, false), true);
        assert.strictEqual(writesNow('/ws/Lookup Tables/UOM.json', 40_000, false), true);
        assert.strictEqual(writesNow('/ws/Queries/Stock/query.json', 0, false), true, 'removed');
    });

    it('the run history database, a run archive growing by appends, a temporary file and anything large wait for the batch', () => {
        assert.strictEqual(writesNow('/ws/.dbmn/executions.db', 4_000_000, false), false);
        assert.strictEqual(writesNow('/ws/Prod/Stock/run-1/responses.jsonl', 900, true), false, 'appended');
        assert.strictEqual(writesNow('/ws/Queries/Stock/query.json.tmp', 2_000, false), false, 'the rename that follows is the save');
        assert.strictEqual(writesNow('/ws/Queries/Stock/rows.json', WRITE_NOW_MAX + 1, false), false, 'a big file view\'s rows');
        assert.strictEqual(writesNow('/ws/Queries/Stock/query.json', 2_000, true), false, 'appended JSON is not a whole save');
    });
});
