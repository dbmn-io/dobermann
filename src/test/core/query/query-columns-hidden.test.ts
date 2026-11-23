// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Columns step's sample cells: one that differs only by characters you can't see says so (James, 2026-11-23, kennel
 * demo: kennelB's "Biscuit " showed amber with no clue why; "YES!" to marking them). The host says what the difference
 * is (columnCellHidden, by the engine's own rule for an unseen-only difference); the page marks the characters.
 *   npm run test:core
 */
import * as assert from 'assert';
import { unseenSaid } from '../../../services/engine/engine-compare';
import { columnCellHidden } from '../../../services/query/query-status';
import type { ColumnRef } from '../../../services/query/query-types';

describe('Query: Columns cells that differ only by characters you can\'t see', () => {
    it('says what the difference is, in words', () => {
        assert.strictEqual(unseenSaid('Biscuit', 'Biscuit '), 'differs only by a space at the end');
        assert.strictEqual(unseenSaid('Pepper', ' Pepper'), 'differs only by a space at the start');
        assert.strictEqual(unseenSaid('loves walks', 'loves  walks'), 'differs only by a space in the middle');
        assert.strictEqual(unseenSaid('Daisy', 'Dai​sy'), 'differs only by a zero-width space in the middle');
        assert.strictEqual(unseenSaid('loves swims', 'loves\tswims'), 'differs only by a tab in the middle, against a space');
        assert.strictEqual(unseenSaid('bouncy', 'bouncy\n'), 'differs only by a line break at the end');
        assert.strictEqual(unseenSaid('Maltese', 'Maltese '), 'differs only by a non-breaking space at the end');
        assert.strictEqual(unseenSaid('', '  '), 'differs only by spaces, against blank');
    });

    it('a real difference, or no difference, says nothing', () => {
        assert.strictEqual(unseenSaid('Biscuit', 'Biscuits'), '');
        assert.strictEqual(unseenSaid('Biscuit', 'Biscuit'), '');
    });

    it('the host\'s cells: words on a compared cell that differs only by unseen characters; nothing on the first or on a real difference', () => {
        const columns: ColumnRef[] = [
            { view: 'vA', column: 'sku' },
            { view: 'vA', column: 'name', group: 'name' }, { view: 'vB', column: 'name', group: 'name' },
            { view: 'vA', column: 'breed', group: 'breed' }, { view: 'vB', column: 'breed', group: 'breed' }
        ];
        const values = ['WOOF-001', 'Biscuit', 'Biscuit ', 'Beagle', 'Poodle'];
        assert.deepStrictEqual(columnCellHidden(columns, values, v => (v === 'vA' ? 0 : 1)), ['', '', 'differs only by a space at the end', '', '']);
    });
});
