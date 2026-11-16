// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Reprocessing one transaction of a finished batch runs it directly. The
 * batch's stored totals (what History and the Executions tree summarise)
 * must follow, or a fully fixed batch keeps showing its old failures.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('Reprocess one transaction — the batch totals follow', () => {
    let updateExecution: SinonStub;
    let engine: BatchExecutionEngine;

    beforeEach(() => {
        // Before the retry: two done, one failed. executeRecord fixes the failed one.
        const members = [
            { id: 'm-1', status: 'completed' },
            { id: 'm-2', status: 'completed' },
            { id: 'm-3', status: 'error' }
        ];
        updateExecution = stub().resolves();
        const deps: any = {
            executionMetadataService: {
                getExecution: stub().resolves({ id: 'batch-1', executionType: 'batch', status: 'completed', environmentId: 'env' }),
                getBatchMemberExecutions: stub().callsFake(async () => members.map(m => ({ ...m }))),
                updateExecution
            },
            executionService: {
                executeRecord: stub().callsFake(async (id: string) => {
                    members.find(m => m.id === id)!.status = 'completed';
                    return { success: true, httpStatus: 200 };
                })
            }
        };
        engine = new BatchExecutionEngine(deps, createMockLogger());
        stub(engine as any, 'sendMemberResultToReport').resolves();
        stub(engine as any, 'logBatchEvent').resolves();
    });

    it('recounts the batch after the transaction runs', async () => {
        await (engine as any).executeRetryDirect('batch-1', ['m-3']);
        const batchUpdates = updateExecution.getCalls().filter(c => c.args[0] === 'batch-1').map(c => c.args[1]);
        const last = batchUpdates[batchUpdates.length - 1];
        expect(last, 'the batch totals were updated').to.exist;
        expect(last.batchMemberProgress).to.include({ total: 3, completed: 3, error: 0 });
        expect(last.membersFailed).to.equal(0);
    });
});
