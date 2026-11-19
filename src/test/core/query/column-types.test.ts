// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The kind of values a result's columns hold (src/services/query/column-types.ts).
 *   npm run test:core
 */
import * as assert from 'assert';
import { columnTypes, spread, TYPE_SAMPLE } from '../../../services/query/column-types';

describe('Query: what kind of values a column holds', () => {
    it('numbers, yes or no, ISO dates and text, each from every value agreeing', () => {
        const rows = [
            ['PO-1', 54, true, '2026-10-06', '2026-10-06T09:15:02Z', 'NZD'],
            ['PO-2', 552, false, '2026-10-07', '2026-10-07T10:00:00+11:00', 'AUD'],
            ['PO-3', 6.5, true, '2026-10-08', '2026-10-08 10:00', '']
        ];
        assert.deepStrictEqual(columnTypes(rows, 6), ['text', 'number', 'yesno', 'date', 'date', 'text']);
    });

    it('blanks say nothing; a column of blanks is text', () => {
        assert.deepStrictEqual(columnTypes([[null, '', 3], [undefined, null, null], ['', '', 4]], 3), ['text', 'text', 'number']);
        assert.deepStrictEqual(columnTypes([], 2), ['text', 'text']);
    });

    it('one value of another kind makes the column text', () => {
        assert.deepStrictEqual(columnTypes([[1, '2026-10-06', 'true'], ['two', 'soon', 'false'], [3, '2026-10-08', 'maybe']], 3), ['text', 'text', 'text']);
    });

    it('day and month dates are never guessed, and true or false as text counts as yes or no', () => {
        assert.deepStrictEqual(columnTypes([['11/12/2026', 'true', '0614141000043'], ['12/11/2026', 'false', '0614141000050']], 3), ['text', 'yesno', 'text']);
    });
});

describe('Query: a column\'s kind is read from rows across the whole result', () => {
    it('spread keeps the first and spaces the rest to the end', () => {
        const rows = Array.from({ length: 10 }, (_, i) => i);
        assert.deepStrictEqual(spread(rows, 20), rows);
        assert.deepStrictEqual(spread(rows, 5), [0, 2, 4, 6, 8]);
    });

    it('a value of another kind far down the rows is seen', () => {
        const rows: unknown[][] = Array.from({ length: 5000 }, (_, i) => [i < 4990 ? 7 : 'n/a']);
        assert.deepStrictEqual(columnTypes(rows.slice(0, 50), 1), ['number']);          // the first rows alone would say number
        assert.deepStrictEqual(columnTypes(spread(rows, TYPE_SAMPLE), 1).length, 1);
        assert.deepStrictEqual(columnTypes([...spread(rows, TYPE_SAMPLE), rows[4999]], 1), ['text']);
    });
});
