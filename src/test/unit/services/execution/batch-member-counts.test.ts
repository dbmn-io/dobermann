// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #312: the engine's loops count a batch's members with one GROUP BY query.
 * They used to load every member row as an object to count it — the producer every
 * 100 ms, the consumer after every member — which pinned the extension host for
 * the life of a big batch (48,000 rows, hundreds of ms a call). Pausing the batch
 * made everything else fly; that was the loops stopping.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('Batch member counts come from a COUNT query (Issue #312)', () => {
    it('pending and completed counts never load the member rows when the storage can count', async () => {
        const getBatchMemberExecutions = stub().resolves([]);
        const countBatchMembersByStatus = stub().resolves({ completed: 40000, error: 12, cancelled: 3, split: 1, running: 8, pending: 16 });
        const engine = new BatchExecutionEngine({
            executionMetadataService: { getBatchMemberExecutions, countBatchMembersByStatus, getExecution: stub().resolves(null), updateExecution: stub().resolves() },
            executionService: {}
        } as any, createMockLogger());

        expect(await (engine as any).getPendingMemberCount('B')).to.equal(16);
        expect(await (engine as any).getCompletedMembersCountFromDatabase('B')).to.equal(40016);
        const state: any = { batchId: 'B' };
        await (engine as any).syncCountsFromDatabase('B', state);
        expect(state).to.include({ successfulMembers: 40000, failedMembers: 12, cancelledMembers: 3, completedMembers: 40016 });
        expect(getBatchMemberExecutions.called, 'no full member load').to.equal(false);
        expect(countBatchMembersByStatus.callCount).to.equal(3);
    });

    it('falls back to counting the rows for a storage without the query', async () => {
        const members = [{ status: 'completed' }, { status: 'completed' }, { status: 'error' }, { status: 'pending' }];
        const engine = new BatchExecutionEngine({
            executionMetadataService: { getBatchMemberExecutions: stub().resolves(members), getExecution: stub().resolves(null), updateExecution: stub().resolves() },
            executionService: {}
        } as any, createMockLogger());
        expect(await (engine as any).getPendingMemberCount('B')).to.equal(1);
        expect(await (engine as any).getCompletedMembersCountFromDatabase('B')).to.equal(3);
    });
});
