// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #437: two paused batches, resumed one after the other, ran side by side. A new
 * batch waits for a running one (#62, #309), but a resumed batch took the other branch of
 * doExecuteBatch, the one for a batch already in memory, which never looked at the queue.
 * A resumed batch waits its turn like a new one.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('Resumed batch — waits for a running batch (GitHub Issue #437)', () => {
    let engine: BatchExecutionEngine;
    let runConsumerLoop: SinonStub;
    let reports: any[];

    const pausedState = (batchId: string) => ({
        batchId, status: 'paused', totalMembers: 20, completedMembers: 5, successfulMembers: 5, failedMembers: 0,
        cancelledMembers: 0, currentMemberId: null, totalExecutionDuration: 0, completionTimestamps: []
    });

    beforeEach(() => {
        const deps: any = {
            executionMetadataService: {
                getExecution: stub().callsFake(async (id: string) => ({ id, executionType: 'batch', status: 'paused', rows: '20', endpointName: `Orders ${id}` })),
                getBatchMemberExecutions: stub().resolves([]),
                updateExecution: stub().resolves()
            },
            executionService: { executeRecord: stub().resolves({ success: true, httpStatus: 200 }), cleanupExecutionMemory: stub() }
        };
        engine = new BatchExecutionEngine(deps, createMockLogger());
        stub(engine as any, 'broadcastBatchEvent').resolves();
        stub(engine as any, 'sendStatusUpdateToReport').resolves();
        stub(engine as any, 'startProgressTimer');
        stub(engine as any, 'cleanupOrphanedBatchMembers').resolves();
        stub(engine as any, 'syncCountsFromDatabase').resolves();
        stub(engine as any, 'runProducerLoop').resolves();
        reports = [];
        // The resumed batch's own progress: what the Console is told about it
        const realExecute = engine.executeBatch.bind(engine);
        stub(engine, 'executeBatch').callsFake((id: string) => realExecute(id, undefined, { report: (r: unknown) => reports.push({ id, ...(r as object) }) }));
        // A's consumer loop stands for A running: it stays running until the test finishes it
        runConsumerLoop = stub(engine as any, 'runConsumerLoop').resolves();

        (engine as any).batchStates.set('A', pausedState('A'));
        (engine as any).batchStates.set('B', pausedState('B'));
    });

    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const status = (id: string) => (engine as any).batchStates.get(id)?.status;

    it('B, resumed while A runs, is queued and does not start', async () => {
        await engine.resumeBatch('A');
        (engine as any).batchStates.get('A').status = 'running';
        runConsumerLoop.resetHistory();

        const resumeB = engine.resumeBatch('B');
        await wait(50);

        expect(runConsumerLoop.called, 'B must not run while A does').to.equal(false);
        expect(status('B')).to.equal('pending');
        expect(reports.filter(r => r.id === 'B').some(r => r.status === 'pending' && r.queued), 'B is reported queued').to.equal(true);

        // A finishes: B's turn
        (engine as any).batchStates.get('A').status = 'completed';
        await resumeB;
        expect(runConsumerLoop.calledOnce, 'B ran once A was done').to.equal(true);
    });

    it('B cancelled while queued after a resume never starts', async () => {
        (engine as any).batchStates.get('A').status = 'running';

        const resumeB = engine.resumeBatch('B');
        await wait(50);
        await engine.cancelBatch('B');
        (engine as any).batchStates.get('A').status = 'completed';

        await resumeB;
        expect(runConsumerLoop.called, 'cancelled B must not run').to.equal(false);
    });

    it('with nothing else running, a resumed batch starts at once', async () => {
        await engine.resumeBatch('B');
        expect(runConsumerLoop.calledOnce).to.equal(true);
    });
});
