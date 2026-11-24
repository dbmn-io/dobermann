// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Results' totals in Compact (James, 2026-11-23: "totals in compact views should be for the baseline only"): a compared
 * column shown in one cell totals as its Baseline's column does, and nothing else; its other results' totals aren't
 * shown there. Side by side keeps every result's total.
 *   npm run test:core
 */
import * as assert from 'assert';
import * as resultsScript from '../../../webviews/query/query-compare-results.js';
import { sharedScript } from '../../../utils/shared-script';

type Col = { view: string; column: string; group?: string };
const { compactTotals } = sharedScript<{
    compactTotals(totals: Record<string, string>, tableIds: string[], resultCols: Col[], baseline: string | undefined, colId: (c: Col) => string): Record<string, string>;
}>(resultsScript, 'QueryCompareResults');

const colId = (c: Col) => `${c.view}:${c.column}`;
const COLS: Col[] = [{ view: 'vBL', column: 'sku' }, { view: 'vBL', column: 'qty', group: 'qty' }, { view: 'vC1', column: 'qty', group: 'qty' }, { view: 'vC2', column: 'qty', group: 'qty' }, { view: 'vBL', column: 'price' }];
const TOTALS = { 'vBL:sku': 'Total', 'vBL:qty': '17', 'vC1:qty': '19', 'vC2:qty': '24', 'vBL:price': '41.50' };

describe('Query: Results\' totals in Compact', () => {
    it('a compared column in one cell: the Baseline\'s total, and no other', () => {
        const out = compactTotals(TOTALS, ['vBL:sku', 'compact:qty', 'vBL:price'], COLS, 'vBL', colId);
        assert.deepStrictEqual(out, { 'vBL:sku': 'Total', 'compact:qty': '17', 'vBL:price': '41.50' });
    });

    it('the Baseline made C1: its total', () => {
        assert.strictEqual(compactTotals(TOTALS, ['compact:qty'], COLS, 'vC1', colId)['compact:qty'], '19');
    });

    it('Side by side (no compact columns): every result\'s total, as it was', () => {
        assert.deepStrictEqual(compactTotals(TOTALS, ['vBL:sku', 'vBL:qty', 'vC1:qty', 'vC2:qty', 'vBL:price'], COLS, 'vBL', colId), TOTALS);
    });
});

/**
 * James, 2026-11-24: "the cells that are different should get a standard background for a DIFF… the cell gets a diff
 * colour, and the pop up also gives the coloured background". A compared column's total that is not its Baseline's
 * total wears the DIFF class (and its result's colour), as a differing cell does; the Baseline's and the alike don't.
 */
const { markTotals } = sharedScript<{
    markTotals(totals: Record<string, unknown>, resultCols: Col[], baseline: string | undefined, colId: (c: Col) => string, colourOf: (view: string) => string): Record<string, unknown>;
}>(resultsScript, 'QueryCompareResults');
const colourOf = (view: string) => `tone-${view}`;

describe('Query: a total that differs from the Baseline\'s, marked as a DIFF', () => {
    it('C2 differs: its total marked, in its colour; BL, an alike C1 and plain columns as they were', () => {
        const out = markTotals({ ...TOTALS, 'vC1:qty': '17' }, COLS, 'vBL', colId, colourOf);
        assert.deepStrictEqual(out, {
            'vBL:sku': 'Total', 'vBL:qty': '17', 'vC1:qty': '17',
            'vC2:qty': { value: '24', className: 'compare-differs tone-vC2' },
            'vBL:price': '41.50'
        });
    });

    it('measured against the Baseline, whichever result it is', () => {
        const out = markTotals(TOTALS, COLS, 'vC1', colId, colourOf);
        assert.deepStrictEqual(out['vBL:qty'], { value: '17', className: 'compare-differs tone-vBL' });
        assert.strictEqual(out['vC1:qty'], '19');
        assert.deepStrictEqual(out['vC2:qty'], { value: '24', className: 'compare-differs tone-vC2' });
    });

    it('no compare (no Baseline) or no totals: nothing marked', () => {
        assert.deepStrictEqual(markTotals(TOTALS, COLS, undefined, colId, colourOf), TOTALS);
        assert.deepStrictEqual(markTotals({}, COLS, 'vBL', colId, colourOf), {});
    });
});
