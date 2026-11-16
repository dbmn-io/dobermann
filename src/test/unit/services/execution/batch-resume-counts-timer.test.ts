// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #311: after a resume the Console's counts and clock were "all
 * over the place" — the bottom progress count came from stale in-memory
 * tallies, and the clock restarted from zero because the engine reset
 * `startedAt` and reported that as the start time.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

const HOUR = 3600 * 1000;

describe('Resume — counts and clock (GitHub Issue #311)', () => {
    let engine: BatchExecutionEngine;
    let updateExecution: SinonStub;
    let members: Array<{ id: string; status: string }>;
    let metadata: any;

    beforeEach(() => {
        members = [
            { id: 'm-1', status: 'completed' },
            { id: 'm-2', status: 'completed' },
            { id: 'm-3', status: 'completed' },
            { id: 'm-4', status: 'error' },
            { id: 'm-5', status: 'cancelled' },
            { id: 'm-6', status: 'pending' }
        ];
        metadata = { id: 'B', executionType: 'batch', status: 'paused', rows: '6', createdAt: new Date(Date.now() - 30 * HOUR), endpointName: 'Orders' };
        updateExecution = stub().resolves();
        const deps: any = {
            executionMetadataService: {
                getExecution: stub().callsFake(async () => metadata),
                getBatchMemberExecutions: stub().callsFake(async () => members.map(m => ({ ...m }))),
                updateExecution
            },
            executionService: { executeRecord: stub().resolves({ success: true }), cleanupExecutionMemory: stub() }
        };
        engine = new BatchExecutionEngine(deps, createMockLogger());
        stub(engine as any, 'broadcastBatchEvent').resolves();
        stub(engine as any, 'cleanupOrphanedBatchMembers').resolves();
    });

    const state = () => (engine as any).batchStates.get('B');

    it('resume syncs the tallies with the database before the Console is told anything', async () => {
        (engine as any).batchStates.set('B', {
            batchId: 'B', status: 'paused', totalMembers: 6,
            completedMembers: 2, successfulMembers: 2, failedMembers: 0, cancelledMembers: 0, // stale
            currentMemberId: null, totalExecutionDuration: 0, completionTimestamps: []
        });
        stub(engine, 'executeBatch').callsFake(async () => state());

        await engine.resumeBatch('B');

        expect(state().completedMembers, 'completed + error + cancelled').to.equal(5);
        expect(state().successfulMembers).to.equal(3);
        expect(state().failedMembers).to.equal(1);
        expect(state().cancelledMembers).to.equal(1);
    });

    it('pausing folds the session into the run time and persists it', async () => {
        (engine as any).batchStates.set('B', {
            batchId: 'B', status: 'running', totalMembers: 6, completedMembers: 3, successfulMembers: 3, failedMembers: 0, cancelledMembers: 0,
            currentMemberId: null, totalExecutionDuration: 0, completionTimestamps: [],
            startedAt: new Date(Date.now() - 60000), activeRunMs: 19 * HOUR
        });
        stub(engine as any, 'sendStatusUpdateToReport').resolves();

        await engine.pauseBatch('B', 'User requested pause');

        expect(state().activeRunMs).to.be.closeTo(19 * HOUR + 60000, 1000);
        const persisted = updateExecution.getCalls().map(c => c.args[1]).find(u => u.status === 'paused');
        expect(persisted.runTime).to.be.closeTo(19 * HOUR + 60000, 1000);
    });

    it('the clock the Console gets after a resume counts from the total run time, not from the resume', async () => {
        (engine as any).batchStates.set('B', {
            batchId: 'B', status: 'running', totalMembers: 6, completedMembers: 3, successfulMembers: 3, failedMembers: 0, cancelledMembers: 0,
            currentMemberId: null, totalExecutionDuration: 0, completionTimestamps: [],
            startedAt: new Date(Date.now() - 10000), activeRunMs: 19 * HOUR
        });
        const start = (engine as any).displayStartTime(state());
        expect(Date.now() - start).to.be.closeTo(19 * HOUR + 10000, 1000);
    });

    it('after a reload the run time comes back from the batch record', async () => {
        metadata.runTime = 5 * HOUR;
        let seen: any;
        stub(engine, 'executeBatch').callsFake(async () => { seen = { ...state() }; return state(); });

        await engine.resumeBatch('B'); // no in-memory state → reconstructed from the database

        expect(seen.activeRunMs).to.equal(5 * HOUR);
    });
});
