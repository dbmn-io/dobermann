// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: the Compare engine pairs rows on a business key and compares the ticked
 * columns, with no VS Code loaded.
 */
import { expect } from 'chai';
import {
    compareRows,
    kindsForJoin,
    keyCanCompare,
    matchProfile,
    valuesDiffer,
    CompareRowData,
} from '../../../services/compare/compare-engine';

const item = (id: number, itemCode: string, extra: Partial<CompareRowData> = {}): CompareRowData => ({
    id, itemCode, description: 'Carton ' + itemCode, height: 400, status: 'Active', ...extra,
});

const spec = (over: Partial<{ keyColumns: string[]; compareColumns: string[]; relaxedColumns: string[] }> = {}) => ({
    keyColumns: ['itemCode'],
    compareColumns: ['description', 'height', 'status'],
    ...over,
});

describe('Compare engine', () => {
    // Test and Production number their rows differently; itemCode is the business key.
    const test = [
        item(1, 'ITM-1'),
        item(2, 'ITM-2', { height: 400 }),
        item(3, 'ITM-3', { status: 'Active' }),
        item(4, 'ITM-NEW'),
    ];
    const prod = [
        item(901, 'ITM-1'),
        item(902, 'ITM-2', { height: 410 }),
        item(903, 'ITM-3', { status: 'Inactive', description: 'Carton ITM-3 (old)' }),
        item(904, 'ITM-OLD'),
    ];

    it('sorts every row into same, changed, only in A and only in B', async () => {
        const result = await compareRows(test, prod, spec());
        expect(result.counts).to.deep.equal({ changed: 2, onlyA: 1, onlyB: 1, duplicate: 0, same: 1 });
        expect(result.columnDiffCounts).to.deep.equal({ description: 1, height: 1, status: 1 });

        const rows = Array.from({ length: result.length }, (_, i) => result.row(i));
        expect(rows.map(r => r.kind)).to.deep.equal(['same', 'changed', 'changed', 'onlyA', 'onlyB']);
        expect(rows[1]).to.deep.equal({ kind: 'changed', a: [1], b: [1], diffColumns: ['height'] });
        expect(rows[2].diffColumns).to.deep.equal(['description', 'status']);
        expect(rows[3]).to.include({ kind: 'onlyA' });
        expect(rows[3].a).to.deep.equal([3]);
        expect(rows[4].b).to.deep.equal([3]);
    });

    it('never compares the key, and only compares the ticked columns', async () => {
        const result = await compareRows(test, prod, spec({ compareColumns: ['itemCode', 'status'] }));
        expect(result.spec.compareColumns).to.deep.equal(['status']);
        expect(result.counts.changed).to.equal(1);
        expect(result.counts.same).to.equal(2);
    });

    it('pairs nothing on the database id, because each environment numbers its own rows', async () => {
        const result = await compareRows(test, prod, spec({ keyColumns: ['id'] }));
        expect(result.counts).to.include({ onlyA: 4, onlyB: 4, changed: 0, same: 0 });
    });

    it('matches on several key columns together', async () => {
        const a = [{ order: 'O1', line: 1, qty: 5 }, { order: 'O1', line: 2, qty: 3 }];
        const b = [{ order: 'O1', line: 2, qty: 4 }, { order: 'O1', line: 1, qty: 5 }];
        const result = await compareRows(a, b, spec({ keyColumns: ['order', 'line'], compareColumns: ['qty'] }));
        expect(result.counts).to.include({ same: 1, changed: 1 });
        expect(result.row(1)).to.deep.equal({ kind: 'changed', a: [1], b: [0], diffColumns: ['qty'] });
    });

    it('puts a key that appears twice into its own group with every row, instead of pairing one', async () => {
        const b = [...prod, item(905, 'ITM-2', { description: 'copy' })];
        const result = await compareRows(test, b, spec());
        expect(result.counts.duplicate).to.equal(1);
        const dup = result.row(result.indicesOf(new Set(['duplicate']))[0]);
        expect(dup).to.deep.equal({ kind: 'duplicate', a: [1], b: [1, 4], diffColumns: [] });
    });

    it('finds a duplicate key that exists only in B', async () => {
        const b = [item(1, 'X'), item(2, 'X')];
        const result = await compareRows([], b, spec());
        expect(result.counts).to.include({ duplicate: 1, onlyB: 0 });
        expect(result.row(0).b).to.deep.equal([0, 1]);
    });

    describe('strict by default: system against system, nothing is reformatted', () => {
        it('a string is not a number, and a dropped leading zero is a difference', () => {
            expect(valuesDiffer('00123', 123, 'strict')).to.equal(true);
            expect(valuesDiffer('00123', '123', 'strict')).to.equal(true);
            expect(valuesDiffer('12.50', '12.5', 'strict')).to.equal(true);
            expect(valuesDiffer('12.5', 12.5, 'strict')).to.equal(true);
        });
        it('spaces, case, null, blank and missing all count', () => {
            expect(valuesDiffer('tape ', 'tape', 'strict')).to.equal(true);
            expect(valuesDiffer('Shelf', 'SHELF', 'strict')).to.equal(true);
            expect(valuesDiffer('', null, 'strict')).to.equal(true);
            expect(valuesDiffer(null, undefined, 'strict')).to.equal(true);
            expect(valuesDiffer(true, 'true', 'strict')).to.equal(true);
        });
        it('long digit-only codes never merge', () => {
            expect(valuesDiffer('12345678901234567890', '12345678901234567891', 'strict')).to.equal(true);
            expect(valuesDiffer('12345678901234567890', '12345678901234567891', 'relaxed')).to.equal(true);
        });
        it('the same JSON number is the same', () => {
            expect(valuesDiffer(12.5, 12.5, 'strict')).to.equal(false);
            expect(valuesDiffer({ a: [1, 2] }, { a: [1, 2] }, 'strict')).to.equal(false);
        });
        it('compares nested values by content', async () => {
            const result = await compareRows([{ k: 1, tags: ['a', 'b'] }], [{ k: 1, tags: ['a', 'c'] }], spec({ keyColumns: ['k'], compareColumns: ['tags'] }));
            expect(result.counts.changed).to.equal(1);
        });
        it('the key is strict too: "1" and 1, or "007" and "7", never pair', async () => {
            const result = await compareRows([{ code: '007' }, { code: '1' }], [{ code: '7' }, { code: 1 }], spec({ keyColumns: ['code'], compareColumns: [] }));
            expect(result.counts).to.include({ onlyA: 2, onlyB: 2, same: 0 });
        });
    });

    describe('Relaxed, set per column by the user', () => {
        it('ignores spaces and case, and treats blank, null and missing as one', () => {
            expect(valuesDiffer('Packing tape 48mm ', 'packing  TAPE 48mm', 'relaxed')).to.equal(false);
            expect(valuesDiffer('', null, 'relaxed')).to.equal(false);
            expect(valuesDiffer('  ', undefined, 'relaxed')).to.equal(false);
        });
        it('matches a number to its exact text, but never drops a leading zero', () => {
            expect(valuesDiffer(12.5, '12.5', 'relaxed')).to.equal(false);
            expect(valuesDiffer('00123', 123, 'relaxed')).to.equal(true);
            expect(valuesDiffer('12.50', 12.5, 'relaxed')).to.equal(true);
        });
        it('applies only to the columns set to Relaxed', async () => {
            const a = [{ k: 'A', description: 'Steel shelf', uom: 'EA' }];
            const b = [{ k: 'A', description: 'STEEL SHELF', uom: 'ea' }];
            const result = await compareRows(a, b, spec({ keyColumns: ['k'], compareColumns: ['description', 'uom'], relaxedColumns: ['description'] }));
            expect(result.row(0)).to.include({ kind: 'changed' });
            expect(result.row(0).diffColumns).to.deep.equal(['uom']);
        });
    });

    it('shows the groups a join asks for', () => {
        expect([...kindsForJoin('full')].sort()).to.deep.equal(['changed', 'duplicate', 'onlyA', 'onlyB', 'same']);
        expect(kindsForJoin('left').has('onlyB')).to.equal(false);
        expect(kindsForJoin('right').has('onlyA')).to.equal(false);
        expect([...kindsForJoin('inner')].sort()).to.deep.equal(['changed', 'duplicate', 'same']);
    });

    describe('Match: how the Baseline meets another result on a key', () => {
        it('counts one to one, and records only on one side, which can be compared', async () => {
            const p = await matchProfile(test, prod, ['itemCode']);
            expect(p.counts).to.deep.equal({ oneToOne: 3, onlyBase: 1, onlyOther: 1, oneToMany: 0, manyToOne: 0, manyToMany: 0 });
            expect(keyCanCompare(p.counts)).to.equal(true);
            // The Baseline's keys in its order, then the ones only the other has
            expect(p.groups.map(g => g.kind)).to.deep.equal(['oneToOne', 'oneToOne', 'oneToOne', 'onlyBase', 'onlyOther']);
            expect(p.groups[0]).to.deep.include({ base: [0], other: [0] });
        });

        it('finds a key that matches more than one record, on either side or both', async () => {
            const base = [item(1, 'A'), item(2, 'B'), item(3, 'B'), item(4, 'C'), item(5, 'C'), item(6, 'D'), item(7, 'E'), item(8, 'E')];
            const other = [item(11, 'A'), item(12, 'A'), item(13, 'B'), item(14, 'C'), item(15, 'C'), item(16, 'D')];
            const p = await matchProfile(base, other, ['itemCode']);
            // A: one to many; B: many to one; C: many to many; D: one to one; E: twice, and not in the other
            expect(p.counts).to.deep.equal({ oneToOne: 1, onlyBase: 0, onlyOther: 0, oneToMany: 1, manyToOne: 2, manyToMany: 1 });
            expect(p.groups[0]).to.deep.include({ kind: 'oneToMany', base: [0], other: [0, 1] });
            expect(keyCanCompare(p.counts)).to.equal(false);
        });

        it('compares one to many (BL holds the value once), not many to one', async () => {
            const base = [item(1, 'A'), item(2, 'B')];
            const other = [item(11, 'A'), item(12, 'A'), item(13, 'B')];
            expect(keyCanCompare((await matchProfile(base, other, ['itemCode'])).counts)).to.equal(true);
            expect(keyCanCompare((await matchProfile(other, base, ['itemCode'])).counts)).to.equal(false);
        });

        it('cannot compare on a key that matches nothing (the database id each environment numbers itself)', async () => {
            const p = await matchProfile(test, prod, ['id']);
            expect(p.counts.oneToOne).to.equal(0);
            expect(keyCanCompare(p.counts)).to.equal(false);
        });

        it('a second column makes a repeated key one to one', async () => {
            const base = [item(1, 'SKU-1', { location: 'L1' }), item(2, 'SKU-1', { location: 'L2' })];
            const other = [item(9, 'SKU-1', { location: 'L2' }), item(8, 'SKU-1', { location: 'L1' })];
            expect(keyCanCompare((await matchProfile(base, other, ['itemCode'])).counts)).to.equal(false);
            const both = await matchProfile(base, other, ['itemCode', 'location']);
            expect(both.counts.oneToOne).to.equal(2);
            expect(both.groups[0]).to.deep.include({ base: [0], other: [1] });
        });

    });

    it('reports progress and can be cancelled', async () => {
        const a = Array.from({ length: 5000 }, (_, i) => item(i, 'K' + i));
        const seen: number[] = [];
        const controller = new AbortController();
        let error: Error | undefined;
        try {
            await compareRows(a, a, spec(), {
                chunkSize: 1000,
                signal: controller.signal,
                onProgress: p => { seen.push(p.done); if (p.done >= 3000) controller.abort(); },
            });
        } catch (e) {
            error = e as Error;
        }
        expect(error?.name).to.equal('AbortError');
        expect(seen[0]).to.equal(1000);
    });

    it('compares 200,000 rows a side in a few seconds, with no row limit', async function () {
        this.timeout(20000);
        const n = 200000;
        const a: CompareRowData[] = new Array(n);
        const b: CompareRowData[] = new Array(n);
        for (let i = 0; i < n; i++) {
            a[i] = { id: i, itemCode: 'ITM-' + i, description: 'Item ' + i, length: 100, width: 50, height: 400, weightKg: 1.5, status: 'Active' };
            b[i] = { id: n + i, itemCode: 'ITM-' + (i + 10), description: 'Item ' + (i + 10), length: 100, width: 50, height: i % 50 === 0 ? 410 : 400, weightKg: 1.5, status: 'Active' };
        }
        const started = Date.now();
        const result = await compareRows(a, b, spec({ compareColumns: ['description', 'length', 'width', 'height', 'weightKg', 'status'] }));
        const ms = Date.now() - started;
        expect(result.counts.onlyA).to.equal(10);
        expect(result.counts.onlyB).to.equal(10);
        expect(result.counts.changed + result.counts.same).to.equal(n - 10);
        expect(result.columnDiffCounts.weightKg).to.equal(0);
        expect(ms).to.be.below(8000);
    });
});
