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
