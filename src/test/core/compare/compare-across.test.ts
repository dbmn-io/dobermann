// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare several. Three or four results, one row per key, every value measured
 * against the baseline's, with the same strict rules as two results.
 */
import { expect } from 'chai';
import { compareAcross } from '../../../services/compare/compare-across';
import { CompareLens } from '../../../services/compare/compare-lens';
import type { CompareRowData } from '../../../services/compare/compare-engine';

const item = (code: string, gtin: unknown, height: unknown): CompareRowData => ({ itemCode: code, gtin, height });
const spec = { keyColumns: ['itemCode'], compareColumns: ['gtin', 'height'] };

describe('Compare several (across)', () => {
    // DEV, SIT, UAT, PROD
    const dev = [item('ITM-1', '0093', 400), item('ITM-2', '0094', 400), item('ITM-3', '0095', 400), item('ITM-5', '0097', 1)];
    const sit = [item('ITM-1', '0093', 400), item('ITM-2', '0094', 410), item('ITM-3', '0095', 400), item('ITM-5', '0097', 1)];
    const uat = [item('ITM-1', '0093', 400), item('ITM-2', '0094', 400), item('ITM-5', '0097', 1), item('ITM-5', '0097', 2)];
    const prod = [item('ITM-1', '93', 400), item('ITM-2', '0094', 400), item('ITM-3', '0095', 400), item('ITM-4', '0096', 400)];
    const sides = [dev, sit, uat, prod];

    it('gives one row per key (one per record of a repeated one), the baseline first, each a single kind', async () => {
        const r = await compareAcross(sides, spec, 0);
        const kinds = Array.from({ length: r.length }, (_, i) => r.row(i).kind);
        // ITM-1: PROD lost the zeros. ITM-2: SIT height. ITM-3: not in UAT. ITM-5: twice in UAT, a
        // row each (not in PROD; the second's height differs). ITM-4: only in PROD.
        expect(kinds).to.deep.equal(['changed', 'changed', 'missing', 'missing', 'changed', 'notInBaseline']);
        expect(r.counts).to.deep.equal({ changed: 3, missing: 2, notInBaseline: 1, duplicate: 0, same: 0 });
        expect(r.rowCounts).to.deep.equal([4, 4, 4, 4]);
        expect(r.repeated).to.equal(1);
    });

    it('says which columns differ from the baseline, result by result, strictly', async () => {
        const r = await compareAcross(sides, spec, 0);
        expect(r.row(0).diffs).to.deep.equal([[], [], [], ['gtin']]);     // "0093" is not "93"
        expect(r.row(1).diffs).to.deep.equal([[], ['height'], [], []]);
        expect(r.columnDiffCounts).to.deep.equal({ gtin: 1, height: 2 });   // ITM-2's, and ITM-5's second record
        expect(r.row(2).rows).to.deep.equal([[2], [2], [], [2]]);
    });

    it('one to many: a row for each record, the results with it once on every row', async () => {
        const r = await compareAcross(sides, spec, 0);
        expect(r.row(3).rows).to.deep.equal([[3], [3], [2], []]);
        expect(r.row(4).rows).to.deep.equal([[3], [3], [3], []]);
        expect(r.row(4).diffs).to.deep.equal([[], [], ['height'], []]);   // DEV's height 1 against UAT's 2        // Both rows are marked, with the result that holds the key twice (UAT, place 2)
        expect([...r.repeatedIn]).to.deep.equal([[3, [2]], [4, [2]]]);
    });

    it('gives each row its relationship, and filters on it', async () => {
        const lens = new CompareLens(await compareAcross(sides, spec, 0), { visible: [1, 2, 3] });
        // ITM-1, ITM-2 everywhere; ITM-3 not in UAT; ITM-5 twice in UAT (and not in PROD); ITM-4 only in PROD
        expect(Array.from({ length: 6 }, (_, i) => lens.relation(i))).to.deep.equal(['oneToOne', 'oneToOne', 'onlyBase', 'oneToMany', 'oneToMany', 'onlyOther']);
        expect(lens.relationCounts).to.deep.equal({ oneToOne: 2, oneToMany: 2, onlyBase: 1, onlyOther: 1 });
        const all = { same: true, diff: true, missing: [0, 1, 2, 3] };
        expect(lens.indicesOf(all)).to.have.length(6);
        expect(lens.indicesOf({ ...all, relations: ['oneToMany'] })).to.deep.equal([3, 4]);
        // Hiding the result that repeats it folds its rows back to one, as if it were not compared
        const noUat = new CompareLens(lens.result, { visible: [1, 3] });
        expect(noUat.relation(3)).to.equal('onlyBase');   // ITM-5: BL and SIT have it, PROD doesn't
        expect(noUat.indicesOf(all)).to.not.include(4);
        expect(noUat.relationCounts.oneToMany).to.equal(0);
    });

    it('repeats a result\'s last record when another holds the key more often (never a false missing)', async () => {
        const one = [item('K', '1', 1)];
        const twice = [item('K', '1', 1), item('K', '1', 1)];
        const thrice = [item('K', '1', 1), item('K', '1', 1), item('K', '1', 1)];
        const r = await compareAcross([one, twice, thrice], spec, 0);
        expect(r.length).to.equal(3);
        expect(r.row(2).rows).to.deep.equal([[0], [1], [2]]);   // C1's second record again on row 3
        expect(r.counts.missing).to.equal(0);
        // C2 hidden: C1's two records, two rows; C1 hidden too: one row
        const all = { same: true, diff: true, missing: [0, 1, 2] };
        expect(new CompareLens(r, { visible: [1] }).indicesOf(all)).to.deep.equal([0, 1]);
        expect(new CompareLens(r, { visible: [] }).indicesOf(all)).to.deep.equal([0]);
    });

    it('a key the baseline holds twice is one row, not compared', async () => {
        const r = await compareAcross(sides, spec, 2);   // UAT, with ITM-5 twice
        const dup = r.indicesOf(new Set(['duplicate']));
        expect(dup).to.have.length(1);
        expect(r.row(dup[0]).rows[2]).to.deep.equal([2, 3]);
        expect(r.repeated).to.equal(0);
    });

    it('measures against another baseline when asked', async () => {
        const r = await compareAcross(sides, spec, 3);
        // PROD first: its keys in its order, then the rest
        expect(r.row(0).kind).to.equal('changed');
        expect(r.row(0).diffs).to.deep.equal([['gtin'], ['gtin'], ['gtin'], []]);
        expect(r.row(3).kind).to.equal('missing');                     // ITM-4 is only in PROD
        expect(r.indicesOf(new Set(['duplicate']))).to.deep.equal([]);
        expect(r.indicesOf(new Set(['notInBaseline']))).to.deep.equal([4, 5]);   // ITM-5: twice in UAT, not in PROD
    });

    it('a Relaxed column ignores case and spaces but keeps leading zeros', async () => {
        const a = [{ k: 1, name: 'Carton ', code: '007' }];
        const b = [{ k: 1, name: 'carton', code: '7' }];
        const c = [{ k: 1, name: 'CARTON', code: '007' }];
        const r = await compareAcross([a, b, c], { keyColumns: ['k'], compareColumns: ['name', 'code'], relaxedColumns: ['name', 'code'] }, 0);
        expect(r.row(0).diffs).to.deep.equal([[], ['code'], []]);
    });

    it('stops when cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        let error: Error | undefined;
        try { await compareAcross(sides, spec, 0, { signal: controller.signal }); } catch (e) { error = e as Error; }
        expect(error?.name).to.equal('AbortError');
    });
});
