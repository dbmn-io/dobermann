// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: the saved compares (the Hub's Compare list): the Baseline first, then the
 * results measured against it; a new compare starts from the last setup of its endpoint and View.
 */
import { expect } from 'chai';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import {
    createCompare,
    createDraft,
    duplicateCompare,
    getCompare,
    listCompares,
    removeCompare,
    saveCompare,
    savedCompares,
    viewsInCompares,
    CompareSource,
} from '../../../services/compare/compare-store';

const source = (executionId: string, view = 'View1', endpointId = 'ep1'): CompareSource => ({
    kind: 'result', endpointId, view, executionId, isBatch: true, environment: 'SIT', executedAt: '2026-11-09T08:00:00.000Z',
});
const setup = { keyColumns: ['sku'], compareColumns: ['qty'], relaxedColumns: [], join: 'full' as const };

describe('Saved compares', () => {
    it('saves a new compare at once, newest first, and opens the same one for the same results', async () => {
        const state = new MemoryKeyValueStore();
        const first = await createCompare(state, [source('r1'), source('r2')]);
        const second = await createCompare(state, [source('r3'), source('r1')]);
        expect(listCompares(state).map(c => c.id)).to.deep.equal([second.id, first.id]);
        expect((await createCompare(state, [source('r1'), source('r2')])).id).to.equal(first.id);
        // The Baseline is part of what the compare is: another Baseline is another compare
        expect((await createCompare(state, [source('r2'), source('r1')])).id).to.not.equal(first.id);
    });

    it('starts from the key and columns of the last compare of the same endpoint and View', async () => {
        const state = new MemoryKeyValueStore();
        const done = await createCompare(state, [source('r1'), source('r2')]);
        await saveCompare(state, { ...done, setup, comparedAt: '2026-11-09T09:00:00.000Z' });
        expect((await createCompare(state, [source('r3'), source('r4')])).setup).to.deep.equal(setup);
        expect((await createCompare(state, [source('r3'), source('r4'), source('r5')], )).setup).to.deep.equal(setup);
        expect((await createCompare(state, [source('r3', 'View2'), source('r4', 'View2')])).setup).to.equal(undefined);
    });

    it("the Console's Compare saves a draft of the Baseline: not listed, opened again, completed by Select", async () => {
        const state = new MemoryKeyValueStore();
        const done = await createCompare(state, [source('r1'), source('r2')]);
        await saveCompare(state, { ...done, setup, comparedAt: '2026-11-09T09:00:00.000Z' });
        const draft = await createDraft(state, source('r3'));
        expect(draft.sources).to.have.length(1);
        expect(draft.setup).to.deep.equal(setup);   // the key and columns used last time
        expect((await createDraft(state, source('r3'))).id).to.equal(draft.id);
        expect(savedCompares(state).map(c => c.id)).to.deep.equal([done.id]);
        expect(viewsInCompares(state, 'ep1')).to.deep.equal({ View1: 1 });
        await saveCompare(state, { ...draft, sources: [source('r3'), source('r1')] });
        expect(savedCompares(state).map(c => c.id)).to.deep.equal([draft.id, done.id]);
    });

    it('takes one to three results besides the Baseline', async () => {
        const state = new MemoryKeyValueStore();
        let error = '';
        await createCompare(state, [source('r1')]).catch(e => { error = e.message; });
        expect(error).to.match(/at least one/);
        await createCompare(state, ['a', 'b', 'c', 'd', 'e'].map(id => source(id))).catch(e => { error = e.message; });
        expect(error).to.match(/up to 4/);
    });

    it('duplicates and deletes', async () => {
        const state = new MemoryKeyValueStore();
        const c = await createCompare(state, [source('r1'), source('r2')]);
        await saveCompare(state, { ...c, setup });
        const copy = await duplicateCompare(state, c.id);
        expect(copy!.id).to.not.equal(c.id);
        expect(copy!.setup).to.deep.equal(setup);
        expect(copy!.sources.map(s => s.executionId)).to.deep.equal(['r1', 'r2']);
        await removeCompare(state, c.id);
        expect(getCompare(state, c.id)).to.equal(undefined);
        expect(listCompares(state)).to.have.length(1);
    });

    it('counts the compares that read each View, so the Console can flag them', async () => {
        const state = new MemoryKeyValueStore();
        await createCompare(state, [source('r1'), source('r2')]);
        await createCompare(state, [source('r3'), source('r2')]);
        await createCompare(state, [source('r1', 'View2'), source('r2', 'View2')]);
        await createCompare(state, [source('x1', 'View1', 'ep2'), source('x2', 'View1', 'ep2')]);
        expect(viewsInCompares(state, 'ep1')).to.deep.equal({ View1: 2, View2: 1 });
    });
});
