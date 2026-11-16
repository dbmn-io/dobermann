// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #312: the Settings tab's Configure controls (Name, Error Handling,
 * Processing Mode). They posted dbmn.updateBatch* commands that were removed in
 * June 2026, so nothing happened. They are Console messages now.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ConsoleController } from '../../../../screens/console/console.controller';
import { ScreenSession } from '../../../../screens/screen-session';
import { ServiceTokens } from '../../../../container/service-container.interface';
import { ExecutionServiceTokens } from '../../../../container/execution-service-registry';

describe('Console host: batch settings (Issue #312)', () => {
    let sandbox: sinon.SinonSandbox;
    let services: Map<unknown, unknown>;
    let manager: ConsoleController;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        services = new Map();
        // The Console's services, looked up as the tests set them
        const ports = {
            get metadata() { return services.get(ExecutionServiceTokens.ExecutionMetadataService); },
            get batchEngine() { return services.get(ServiceTokens.BatchExecutionEngine); },
            get endpoints() { return services.get(ServiceTokens.EndpointManager); },
            state: { get: sandbox.stub(), update: sandbox.stub() },
            logger: { log: () => undefined, error: () => undefined },
            toast: { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() }
        };
        const session = new ScreenSession({ post: () => undefined }, { openExternal: () => undefined });
        manager = new ConsoleController(session, ports as any, { type: 'batch', batchId: 'batch-1', responseFiles: [] } as any);
            });

    afterEach(() => sandbox.restore());

    const send = (type: string, payload: Record<string, unknown>) =>
        (manager as any).handleUpdateBatchSetting({ type, correlationId: 'c', payload });

    it('renames the batch, keeping its other settings and its endpoint name (#445)', async () => {
        const updateExecution = sandbox.stub().resolves();
        const getExecution = sandbox.stub().resolves({
            id: 'batch-1', endpointName: 'Bulk Inventory Upload',
            batchConfiguration: { stopOnFirstError: true, parallelProcessing: { enabled: true, maxConcurrency: 4 }, name: 'old' }
        });
        services.set(ExecutionServiceTokens.ExecutionMetadataService, { updateExecution, getExecution });
        const r = await send('updateBatchName', { batchId: 'batch-1', name: '  Inventory load  ' });
        expect(r.success).to.equal(true);
        expect(updateExecution.calledOnce).to.equal(true);
        const [id, updates] = updateExecution.firstCall.args;
        expect(id).to.equal('batch-1');
        expect(updates).to.not.have.property('endpointName');
        expect(updates.batchConfiguration).to.deep.equal({
            stopOnFirstError: true, errorTolerance: false, maxErrors: 0,
            parallelProcessing: { enabled: true, maxConcurrency: 4 }, name: 'Inventory load'
        });
    });

    it('names a batch that had no settings stored (#445)', async () => {
        const updateExecution = sandbox.stub().resolves();
        const getExecution = sandbox.stub().resolves({ id: 'batch-1', endpointName: 'Bulk Inventory Upload' });
        services.set(ExecutionServiceTokens.ExecutionMetadataService, { updateExecution, getExecution });
        await send('updateBatchName', { batchId: 'batch-1', name: 'Inventory load' });
        expect(updateExecution.firstCall.args[1].batchConfiguration).to.deep.equal({
            stopOnFirstError: false, errorTolerance: false, maxErrors: 0, name: 'Inventory load'
        });
    });

    it('sets the error mode through the engine', async () => {
        const updateBatchErrorMode = sandbox.stub().resolves();
        services.set(ServiceTokens.BatchExecutionEngine, { updateBatchErrorMode });
        await send('updateBatchErrorMode', { batchId: 'batch-1', stopOnFirstError: true });
        expect(updateBatchErrorMode.calledOnceWith('batch-1', { stopOnFirstError: true })).to.equal(true);
    });

    it('changes the thread count through the engine', async () => {
        const updateBatchConcurrency = sandbox.stub().resolves({ success: true, currentConcurrency: 8, maxConcurrency: 8 });
        services.set(ServiceTokens.BatchExecutionEngine, { updateBatchConcurrency });
        const r = await send('updateBatchConcurrency', { batchId: 'batch-1', concurrency: 8 });
        expect(r.success).to.equal(true);
        expect(updateBatchConcurrency.calledOnceWith('batch-1', 8)).to.equal(true);
    });

    it('a refused thread count snaps the Console back to the real value', async () => {
        services.set(ServiceTokens.BatchExecutionEngine, {
            updateBatchConcurrency: sandbox.stub().resolves({ success: false, currentConcurrency: 4, maxConcurrency: 4, message: 'Cannot exceed environment maximum of 4 threads' })
        });
        const snap = sandbox.stub(ConsoleController, 'sendConcurrencyUpdate').resolves();
        const r = await send('updateBatchConcurrency', { batchId: 'batch-1', concurrency: 16 });
        expect(r.success).to.equal(false);
        expect(snap.calledOnceWith('batch-1', { currentConcurrency: 4, maxConcurrency: 4 })).to.equal(true);
    });

    it('falls back to the open batch when the payload names none', async () => {
        const updateBatchErrorMode = sandbox.stub().resolves();
        services.set(ServiceTokens.BatchExecutionEngine, { updateBatchErrorMode });
        await send('updateBatchErrorMode', { stopOnFirstError: false });
        expect(updateBatchErrorMode.calledOnceWith('batch-1', { stopOnFirstError: false })).to.equal(true);
    });
});
