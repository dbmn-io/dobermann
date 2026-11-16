// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Regression test for single-value cell paste (GitHub Issue #252)
 *
 * In Run Batch → Step 3 (Review & Edit Data), pasting a single value into a
 * single cell silently did nothing: the paste handler redirected to the bulk
 * "paste area" whenever the pasted column count differed from the grid width.
 *
 * The fix (dt-data-entry-grid.js → handleGridCellPaste) only redirects when the
 * pasted data has MORE columns than fit from the target cell; anything that fits
 * (a single value, or fewer columns than remain) pastes in place.
 *
 * This test mirrors that pure decision so the boundary can't regress.
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Mirrors the #252 guard in handleGridCellPaste():
 *   const expectedColCount = cells.length - startColIndex;
 *   if (firstRowCols.length > expectedColCount) { redirect to paste area }
 *
 * @returns true when the paste should be redirected to the bulk paste area
 */
function shouldRedirectPaste(pastedColumnCount: number, expectedColCount: number): boolean {
    return pastedColumnCount > expectedColCount;
}

describe('Grid cell paste redirect decision (#252)', () => {
    it('pastes a single value into a single cell in place (no redirect)', () => {
        // Pasting "EMR840000021838" -> 1 column, target cell leaves 1 column.
        expect(shouldRedirectPaste(1, 1)).to.equal(false);
    });

    it('pastes a single value when several columns remain (no redirect)', () => {
        // 1 value pasted into the first of 3 remaining columns.
        expect(shouldRedirectPaste(1, 3)).to.equal(false);
    });

    it('pastes fewer columns than fit in place (no redirect)', () => {
        expect(shouldRedirectPaste(2, 3)).to.equal(false);
    });

    it('pastes when columns exactly fill the remaining width (no redirect)', () => {
        expect(shouldRedirectPaste(3, 3)).to.equal(false);
    });

    it('redirects only when pasted columns exceed the remaining width', () => {
        expect(shouldRedirectPaste(4, 3)).to.equal(true);
    });
});
