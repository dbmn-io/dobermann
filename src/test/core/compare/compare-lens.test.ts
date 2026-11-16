// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: what Results show of a compare. Each row's Status is worked out from the results
 * shown and the columns not hidden: DIFF and who differs (BL when it alone is the odd one out),
 * Missing and who lacks the record, or Same. Hiding a result or column is a recount.
 */
import { expect } from 'chai';
import { compareAcross } from '../../../services/compare/compare-across';
import { CompareRowData, CompareSpec } from '../../../services/compare/compare-engine';
import { CompareLens, filterForJoin, LensFilter, statusText } from '../../../services/compare/compare-lens';

// BL, C1, C2, C3 by sku: [quantityOnHand, status], or null when the result has no record
const DATA: Record<string, ([number, string] | null)[]> = {
    'SKU-09': [[123, 'active'], [123, 'active'], [123, 'active'], [123, 'active']],   // Same
    'SKU-10': [[123, 'active'], [123, 'active'], [123, 'active'], [345, 'active']],   // only C3 differs
    'SKU-11': [[123, 'active'], [234, 'active'], [234, 'active'], [123, 'active']],   // C1 and C2
    'SKU-12': [[123, 'active'], [345, 'active'], [345, 'active'], [345, 'active']],   // BL the odd one out
    'SKU-13': [[123, 'held'], [234, 'held'], [123, 'active'], [9, 'held']],           // C1, C2 (status), C3
    'SKU-14': [[123, 'active'], [123, 'active'], null, [123, 'active']],               // not in C2
    'SKU-15': [null, [50, 'active'], [50, 'active'], [51, 'active']],                  // not in BL
    'SKU-16': [[5, 'low'], [5, 'low'], [6, 'low'], null],                              // C2 differs, not in C3
};
const sides: CompareRowData[][] = [0, 1, 2, 3].map(p => Object.entries(DATA)
    .filter(([, v]) => v[p])
    .map(([sku, v]) => ({ sku, quantityOnHand: v[p]![0], status: v[p]![1] })));
const spec: CompareSpec = { keyColumns: ['sku'], compareColumns: ['quantityOnHand', 'status'] };

describe('Compare lens (what Results show)', () => {
    const ALL = { same: true, diff: true, missing: [0, 1, 2, 3] };
    async function lens(visible = [0, 1, 2, 3], hiddenColumns: string[] = []) {
        return new CompareLens(await compareAcross(sides, spec, 0), { visible, hiddenColumns });
    }
    function statuses(l: CompareLens, filter: LensFilter = ALL): Record<string, string> {
        const out: Record<string, string> = {};
        l.indicesOf(filter).forEach(i => {
            const r = [0, 1, 2, 3].map(p => l.result.record(i, p)).find(Boolean)!;
            out[r.sku as string] = statusText(l.status(i));
        });
        return out;
    }

    it('names who differs and who is missing, BL when it alone is the odd one out', async () => {
        expect(statuses(await lens())).to.deep.equal({
            'SKU-09': 'Same',
            'SKU-10': 'DIFF C3',
            'SKU-11': 'DIFF C1 C2',
            'SKU-12': 'DIFF BL',
            'SKU-13': 'DIFF C1 C2 C3',
            'SKU-14': 'Missing C2',
            'SKU-15': 'Missing BL',
            'SKU-16': 'DIFF C2 · Missing C3',
        });
    });

    it('counts each kind; a row with a difference and a missing record counts as both', async () => {
        const l = await lens();
        expect(l.counts).to.deep.equal({ same: 1, diff: 5, missing: 3 });
        expect(l.missingBy).to.deep.equal([1, 0, 1, 1]);
        expect(l.columnDiffCounts).to.deep.equal({ quantityOnHand: 5, status: 1 });
    });

    it('hiding results compares only those shown: BL against C2 lists C2\'s differences', async () => {
        const l = await lens([0, 2]);
        expect(statuses(l)).to.deep.equal({
            'SKU-09': 'Same', 'SKU-10': 'Same', 'SKU-11': 'DIFF C2', 'SKU-12': 'DIFF C2',
            'SKU-13': 'DIFF C2', 'SKU-14': 'Missing C2', 'SKU-15': 'Missing BL', 'SKU-16': 'DIFF C2',
        });
        expect(l.counts).to.deep.equal({ same: 2, diff: 4, missing: 2 });
    });

    it('a hidden column is not compared', async () => {
        const l = await lens([0, 1, 2, 3], ['quantityOnHand']);
        expect(l.columns).to.deep.equal(['status']);
        expect(statuses(l)['SKU-13']).to.equal('DIFF C2');
        expect(statuses(l)['SKU-11']).to.equal('Same');
    });

    it('a row no result shown has is left out', async () => {
        const l = await lens([0, 3]);
        expect(Object.keys(statuses(l))).to.include('SKU-15');   // C3 has it
        const onlyC2 = new CompareLens(await compareAcross([[], [], [{ sku: 'X', quantityOnHand: 1, status: 'a' }], []], spec, 0), { visible: [0, 1] });
        expect(onlyC2.indicesOf(ALL)).to.deep.equal([]);
    });

    it('which rows only sets where the Status filter starts: every row is still counted', async () => {
        const l = await lens();
        const keys = (join: 'full' | 'left' | 'right' | 'inner') => Object.keys(statuses(l, filterForJoin(join, l.visible)));
        expect(keys('full')).to.have.length(8);
        expect(keys('left')).to.not.include('SKU-15');                       // not Missing BL
        expect(keys('right')).to.include('SKU-14');                           // missing from C2, not C1
        expect(keys('inner')).to.deep.equal(['SKU-09', 'SKU-10', 'SKU-11', 'SKU-12', 'SKU-13', 'SKU-16']);   // SKU-16 shows for its DIFF
        expect(l.counts.missing).to.equal(3);
    });

    it('a column\'s filter keeps the rows that differ in it; several narrow (each must differ), with the Status ticks', async () => {
        const l = await lens();
        expect(Object.keys(statuses(l, { ...ALL, columns: ['status'] }))).to.deep.equal(['SKU-13']);
        expect(Object.keys(statuses(l, { ...ALL, columns: ['quantityOnHand'] }))).to.deep.equal(['SKU-10', 'SKU-11', 'SKU-12', 'SKU-13', 'SKU-16']);
        expect(Object.keys(statuses(l, { ...ALL, columns: ['status', 'quantityOnHand'] }))).to.deep.equal(['SKU-13']);
        expect(Object.keys(statuses(l, { same: false, diff: false, missing: [3], columns: ['quantityOnHand'] }))).to.deep.equal(['SKU-16']);
    });

    it('the filter: Missing by result, a row showing for any of its ticks', async () => {
        const l = await lens();
        expect(Object.keys(statuses(l, { same: false, diff: false, missing: [3] }))).to.deep.equal(['SKU-16']);
        expect(Object.keys(statuses(l, { same: true, diff: false, missing: [] }))).to.deep.equal(['SKU-09']);
    });

    it('groups each column\'s values by result, alike under its rule', async () => {
        const l = await lens();
        const at = l.indicesOf({ same: false, diff: true, missing: [] }).find(i => l.result.record(i, 0)?.sku === 'SKU-13')!;
        expect(l.groups(at)).to.deep.equal([[0, 1, 0, 2], [0, 0, 1, 0]]);   // quantityOnHand: BL=C2, C1, C3; status: C2 alone
    });

    it('sorts by a result\'s values or BL\'s, blanks last either way', async () => {
        const l = await lens();
        const all = l.indicesOf(ALL);
        const skus = (ix: number[]) => ix.map(i => [0, 1, 2, 3].map(p => l.result.record(i, p)).find(Boolean)!.sku);
        expect(skus(l.sort(all, { column: 'quantityOnHand', place: 3, dir: 'asc' }))).to.deep.equal(['SKU-13', 'SKU-15', 'SKU-09', 'SKU-11', 'SKU-14', 'SKU-10', 'SKU-12', 'SKU-16']);
        expect(skus(l.sort(all, { column: 'quantityOnHand', dir: 'desc' })).slice(0, 2)).to.deep.equal(['SKU-09', 'SKU-10']);
        expect(skus(l.sort(all, { column: 'sku', dir: 'desc' }))[0]).to.equal('SKU-16');
    });
});
