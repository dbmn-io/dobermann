// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #309: a batch queued behind another could not be cancelled.
 * cancelBatch marked it cancelled, but the queue wait never looked, reset the
 * status to pending when its turn came, and ran the "cancelled" batch anyway.
 * The wait also reported nothing the Console could show as "queued" — the
 * first progress message read as running, so the batch had a ticking clock.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('Queued batch — cancel while waiting (GitHub Issue #309)', () => {
    let engine: BatchExecutionEngine;
    let executeRecord: SinonStub;
    let reports: any[];
    let runConsumerLoop: SinonStub;

    let rowsOfB = '2';
    function metadata(id: string) {
        return { id, executionType: 'batch', status: 'pending', rows: id === 'B' ? rowsOfB : '2', endpointName: id === 'A' ? 'Orders A' : 'Orders B' };
    }

    beforeEach(() => {
        rowsOfB = '2';
        executeRecord = stub().resolves({ success: true, httpStatus: 200 });
        const deps: any = {
            executionMetadataService: {
                getExecution: stub().callsFake(async (id: string) => metadata(id)),
                getBatchMemberExecutions: stub().resolves([{ id: 'm-1', status: 'pending' }, { id: 'm-2', status: 'pending' }]),
                updateExecution: stub().resolves()
            },
            executionService: { executeRecord, cleanupExecutionMemory: stub() }
        };
        engine = new BatchExecutionEngine(deps, createMockLogger());
        stub(engine as any, 'broadcastBatchEvent').resolves();
        stub(engine as any, 'sendStatusUpdateToReport').resolves();
        stub(engine as any, 'startProgressTimer');
        stub(engine as any, 'runProducerLoop').resolves();
        runConsumerLoop = stub(engine as any, 'runConsumerLoop').resolves();
        reports = [];

        // Batch A is running with a known throughput: 10 done in the last minute.
        (engine as any).batchStates.set('A', {
            batchId: 'A', status: 'running', totalMembers: 20, completedMembers: 10,
            startedAt: new Date(Date.now() - 60000),
            completionTimestamps: Array.from({ length: 10 }, (_, i) => Date.now() - i * 5000),
            failedMembers: 0, successfulMembers: 10, cancelledMembers: 0, currentMemberId: null, totalExecutionDuration: 0
        });
    });

    const progress = () => ({ report: (data: unknown) => reports.push(data) });
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    it('reports the batch as pending, behind A, with an expected start — never as running', async () => {
        const run = engine.executeBatch('B', undefined, progress());
        await wait(50);

        expect(reports.length, 'queue outlook reported at once').to.be.greaterThan(0);
        const first = reports[0];
        expect(first.status).to.equal('pending');
        expect(first.queuedBehind).to.equal('Orders A');
        // 10 remaining at 10/min → about a minute from now
        expect(first.expectedStartTime).to.be.closeTo(Date.now() + 60000, 5000);
        expect(reports.some((r: any) => r.status === 'running')).to.equal(false);

        await engine.cancelBatch('B');
        await run;
    });

    it('cancel while queued: the batch ends cancelled and never starts when its turn comes', async () => {
        const run = engine.executeBatch('B', undefined, progress());
        await wait(50);

        await engine.cancelBatch('B');
        // A finishes afterwards — the old code took this as B's cue to start
        (engine as any).batchStates.get('A').status = 'completed';

        const state = await run;
        expect(state.status).to.equal('cancelled');
        expect(runConsumerLoop.called, 'B must not run').to.equal(false);
        expect(executeRecord.called).to.equal(false);
        expect((engine as any).batchStates.has('B'), 'in-memory state released').to.equal(false);
    });

    it('no cancel: the batch starts once A is done', async () => {
        const run = engine.executeBatch('B', undefined, progress());
        await wait(50);
        (engine as any).batchStates.get('A').status = 'completed';

        await run;
        expect(runConsumerLoop.calledOnce, 'B ran when its turn came').to.equal(true);
    });

    it('a batch of one request (a paginated Run API) does not queue — it runs alongside A', async () => {
        rowsOfB = '1';
        await engine.executeBatch('B', undefined, progress());
        expect(runConsumerLoop.calledOnce, 'B ran at once').to.equal(true);
        expect(reports.some((r: any) => r.status === 'pending'), 'never reported as queued').to.equal(false);
    });

    it('a running batch of one does not hold the queue: a real batch starts behind it', async () => {
        (engine as any).batchStates.get('A').totalMembers = 1;
        await engine.executeBatch('B', undefined, progress());
        expect(runConsumerLoop.calledOnce).to.equal(true);
    });
});
