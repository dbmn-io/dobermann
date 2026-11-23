// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A search that names a view's column not in the report adds it to the report (James, 2026-11-23:
 * "@qty adds it as a compare column. @c1.qty adds as report column", "a. Stay."): the rule
 * (src/webviews/query/query-search-adds.js), as Results' search box uses it.
 *   npm run test:core
 */
import * as assert from 'assert';
import * as addsScript from '../../../webviews/query/query-search-adds.js';
import * as matcherScript from '../../../webviews/shared/search-matcher.js';
import { sharedScript } from '../../../utils/shared-script';

type Col = { view: string; column: string; group?: string };
type View = { id: string; alias: string; columns: string[] };
type Spec = { id: string; name: string; aliases: string[] };
type WithoutColumns = (text: string, gone: Spec[], keep?: Spec[]) => string;
const { columnsToAdd, searchAfterRemoval } = sharedScript<{
    columnsToAdd(names: string[], report: Col[], views: View[], compareViews: string[]): Col[];
    searchAfterRemoval(search: string, removed: Spec[], remaining: Spec[], withoutColumns: WithoutColumns): string;
}>(addsScript, 'QuerySearchAdds');
const { columnTerms, withoutColumns } = sharedScript<{ columnTerms(text: string): { name: string; done?: boolean }[]; withoutColumns: WithoutColumns }>(matcherScript, 'SearchMatcher');

// A compare of Stock's runs (BL, C1) on sku, reporting sku and status; and a Bins view joined to it
const VIEWS: View[] = [
    { id: 'vBL', alias: 'BL', columns: ['sku', 'qty', 'status', 'lot'] },
    { id: 'vC1', alias: 'C1', columns: ['sku', 'qty', 'status', 'lot'] },
    { id: 'vBins', alias: 'Bins', columns: ['sku', 'bin', 'qty'] }
];
const REPORT: Col[] = [{ view: 'vBL', column: 'sku' }, { view: 'vBL', column: 'status', group: 'status' }, { view: 'vC1', column: 'status', group: 'status' }];
const COMPARE = ['vBL', 'vC1'];

describe('Query: a search naming a column not in the report adds it', () => {
    it('@qty: qty compared across the compare\'s runs, one group', () => {
        assert.deepStrictEqual(columnsToAdd(['qty'], REPORT, VIEWS, COMPARE), [
            { view: 'vBL', column: 'qty', group: 'qty' }, { view: 'vC1', column: 'qty', group: 'qty' }
        ]);
    });

    it('@C1.qty: C1\'s qty alone, shown, not compared; letter case as typed doesn\'t matter', () => {
        assert.deepStrictEqual(columnsToAdd(['C1.qty'], REPORT, VIEWS, COMPARE), [{ view: 'vC1', column: 'qty' }]);
        assert.deepStrictEqual(columnsToAdd(['c1.QTY'], REPORT, VIEWS, COMPARE), [{ view: 'vC1', column: 'qty' }]);
    });

    it('@Bins.bin: a joined view\'s column, shown', () => {
        assert.deepStrictEqual(columnsToAdd(['Bins.bin'], REPORT, VIEWS, COMPARE), [{ view: 'vBins', column: 'bin' }]);
    });

    it('@bin, a name only a view outside the compare has: that view\'s column, shown', () => {
        assert.deepStrictEqual(columnsToAdd(['bin'], REPORT, VIEWS, COMPARE), [{ view: 'vBins', column: 'bin' }]);
    });

    it('nothing added for a column already in the report, a name no view has, or a term still being typed', () => {
        assert.deepStrictEqual(columnsToAdd(['status', 'BL.sku', 'nosuch', 'qt', 'C9.qty'], REPORT, VIEWS, COMPARE), []);
    });

    it('not a compare: @qty adds the first view\'s qty that has it; each column once, however often it is named', () => {
        const plain: View[] = [{ id: 'vA', alias: 'Stock', columns: ['sku', 'qty'] }, { id: 'vB', alias: 'Bins', columns: ['sku', 'qty'] }];
        assert.deepStrictEqual(columnsToAdd(['qty', 'qty', 'Stock.qty'], [{ view: 'vA', column: 'sku' }], plain, []), [{ view: 'vA', column: 'qty' }]);
    });

    it('a column with a dot in its name (address.city) is found whole, after the view\'s alias', () => {
        const dotted: View[] = [{ id: 'vA', alias: 'Ship', columns: ['id', 'address.city'] }];
        assert.deepStrictEqual(columnsToAdd(['Ship.address.city'], [{ view: 'vA', column: 'id' }], dotted, []), [{ view: 'vA', column: 'address.city' }]);
        assert.deepStrictEqual(columnsToAdd(['address.city'], [{ view: 'vA', column: 'id' }], dotted, []), [{ view: 'vA', column: 'address.city' }]);
    });

    it('the round trip: @qty adds qty; × on it removes it and its term; with the term gone it doesn\'t come back', () => {
        // (James, 2026-11-23: "just keep the Delete key"; the manager: × removes the column and its term, and it stays removed)
        const spec = (c: Col): Spec => ({ id: `${c.view}:${c.column}`, name: c.column, aliases: [`${VIEWS.find(v => v.id === c.view)!.alias}.${c.column}`] });
        const typed = '@qty>5 ';
        const added = columnsToAdd(columnTerms(typed).filter(t => t.done !== false).map(t => t.name), REPORT, VIEWS, COMPARE);
        assert.deepStrictEqual(added.map(c => c.view), ['vBL', 'vC1'], 'added, compared');
        const report = [...REPORT, ...added];
        // × on qty's heading: the compared column goes whole, BL's and C1's
        const removed = report.filter(c => c.column === 'qty');
        const remaining = report.filter(c => c.column !== 'qty');
        const after = searchAfterRemoval(typed, removed.map(spec), remaining.map(spec), withoutColumns);
        assert.strictEqual(after.trim(), '', 'its term went with it');
        assert.deepStrictEqual(columnsToAdd(columnTerms(after).map(t => t.name), remaining, VIEWS, COMPARE), [], 'nothing comes back');
    });

    it('× on one column keeps the search\'s other terms and words; a term another column still answers to stays', () => {
        const spec = (c: Col): Spec => ({ id: `${c.view}:${c.column}`, name: c.column, aliases: [`${VIEWS.find(v => v.id === c.view)!.alias}.${c.column}`] });
        const report = [...REPORT, { view: 'vC1', column: 'lot' }, { view: 'vBins', column: 'lot' }];
        const typed = '@C1.lot=L7 @status=active woof';
        const removed = [{ view: 'vC1', column: 'lot' }];
        const after = searchAfterRemoval(typed, removed.map(spec), report.filter(c => !(c.view === 'vC1' && c.column === 'lot')).map(spec), withoutColumns);
        assert.strictEqual(after, '@status=active woof');
        assert.strictEqual(searchAfterRemoval('@lot=L7', removed.map(spec), report.filter(c => !(c.view === 'vC1' && c.column === 'lot')).map(spec), withoutColumns), '@lot=L7', 'Bins.lot still answers to @lot');
    });
});
