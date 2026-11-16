// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #198: a paginated batch reprocesses like any other batch — each page
 * member keeps its own request — but can't be split, since splitting adds
 * members and next-page numbering counts them.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { isPaginatedBatch } from '../../../../services/pagination/pagination-detector.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

const pagedEndpoint = { method: 'GET', path: '/items', queryParams: { page: '{{A8:PAGE:1}}', size: '{{A8:SIZE:50}}' } };
const plainEndpoint = { method: 'POST', path: '/items', queryParams: {} };

describe('BatchExecutionEngine.reprocessBatch — paginated batches (Issue #198)', () => {
    let engine: BatchExecutionEngine;
    let reprocessMembers: SinonStub;
    let getExecution: SinonStub;
    let splitStub: SinonStub;

    const makeEngine = (endpointConfig: unknown) => {
        getExecution = stub().resolves({ id: 'batch-1', executionType: 'batch', status: 'completed', endpointConfig });
        const deps: any = {
            executionMetadataService: {
                getExecution,
                updateExecution: stub().resolves(),
                getBatchMemberExecutions: stub().resolves([
                    { id: 'page-1', status: 'completed' },
                    { id: 'page-2', status: 'error' },
                    { id: 'page-3', status: 'error' },
                    { id: 'page-4', status: 'pending' }
                ])
            },
            executionService: { executeRecord: stub().resolves({ success: true }) }
        };
        engine = new BatchExecutionEngine(deps, createMockLogger());
        reprocessMembers = stub(engine, 'reprocessMembersInBatch').resolves(0);
        splitStub = stub(engine as any, 'splitAndReprocessTransactions').resolves();
    };

    it('reprocesses the failed pages of a paginated batch', async () => {
        makeEngine(pagedEndpoint);
        const result = await engine.reprocessBatch('batch-1', 'ERRORS' as any);
        expect(result).to.equal('batch-1');
        expect(reprocessMembers.calledOnceWith('batch-1', ['page-2', 'page-3'])).to.equal(true);
    });

    it('reprocesses incomplete and all pages too', async () => {
        makeEngine(pagedEndpoint);
        await engine.reprocessBatch('batch-1', 'INCOMPLETE' as any);
        expect(reprocessMembers.lastCall.args[1]).to.deep.equal(['page-2', 'page-3', 'page-4']);
        await engine.reprocessBatch('batch-1', 'ALL' as any);
        expect(reprocessMembers.lastCall.args[1]).to.deep.equal(['page-1', 'page-2', 'page-3', 'page-4']);
    });

    it('refuses to split a paginated batch', async () => {
        makeEngine(pagedEndpoint);
        let error: Error | undefined;
        try {
            await engine.reprocessBatch('batch-1', 'SPLIT' as any, ['page-2']);
        } catch (e) {
            error = e as Error;
        }
        expect(error?.message).to.match(/cannot be split/);
        expect(splitStub.called).to.equal(false);
        expect(reprocessMembers.called).to.equal(false);
    });

    it('still splits a batch that is not paginated', async () => {
        makeEngine(plainEndpoint);
        await engine.reprocessBatch('batch-1', 'SPLIT' as any, ['page-2']);
        expect(splitStub.calledOnceWith('batch-1', ['page-2'])).to.equal(true);
    });

    it('isPaginatedBatch reads the batch endpoint config', () => {
        expect(isPaginatedBatch({ endpointConfig: pagedEndpoint })).to.equal(true);
        expect(isPaginatedBatch({ endpointConfig: plainEndpoint })).to.equal(false);
        expect(isPaginatedBatch({})).to.equal(false);
        expect(isPaginatedBatch(null)).to.equal(false);
    });
});
