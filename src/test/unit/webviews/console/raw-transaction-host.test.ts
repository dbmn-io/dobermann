// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Host side of the Raw transaction card (Issues #306, #296):
 * - Reprocess on a batch member reprocesses it in its batch; on an
 *   individual transaction (no batch) it re-runs the transaction in place.
 * - A request file holding `{}` reads back as no body.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConsoleController } from '../../../../screens/console/console.controller';
import { ScreenSession } from '../../../../screens/screen-session';
import { ServiceTokens } from '../../../../container/service-container.interface';
import { ExecutionServiceTokens } from '../../../../container/execution-service-registry';

describe('Console host: Raw transaction card (Issues #306, #296)', () => {
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
        manager = new ConsoleController(session, ports as any, { type: 'individual', responseFiles: [] } as any);
    });

    afterEach(() => sandbox.restore());

    describe('retryMember', () => {
        it('reprocesses a batch member in its batch', async () => {
            const reprocessMembersInBatch = sandbox.stub().resolves(1);
            services.set(ServiceTokens.BatchExecutionEngine, { reprocessMembersInBatch });
            const rerun = sandbox.stub(manager as any, 'handleRerunTransaction').resolves({ success: true });

            await (manager as any).handleRetryMember({ type: 'retryMember', correlationId: 'c1', payload: { executionId: 'm-7', batchId: 'batch-1' } });

            expect(reprocessMembersInBatch.calledOnceWith('batch-1', ['m-7'])).to.equal(true);
            expect(rerun.called).to.equal(false);
        });

        it('re-runs an individual transaction in place (it has no batch)', async () => {
            const reprocessMembersInBatch = sandbox.stub().resolves(0);
            services.set(ServiceTokens.BatchExecutionEngine, { reprocessMembersInBatch });
            const rerun = sandbox.stub(manager as any, 'handleRerunTransaction').resolves({ success: true });

            await (manager as any).handleRetryMember({ type: 'retryMember', correlationId: 'c2', payload: { executionId: 'exec-1', batchId: '' } });

            expect(rerun.calledOnce).to.equal(true);
            expect(rerun.firstCall.args[0].payload).to.deep.equal({ executionId: 'exec-1' });
            expect(reprocessMembersInBatch.called).to.equal(false);
        });
    });

    describe('Input export with the Status filter (Issue #304)', () => {
        const input = ['A', 'B', 'C', 'D', 'E'].map(sku => ({ sku }));
        const extract = async (filter?: string) => {
            services.set(ExecutionServiceTokens.ExecutionMetadataService, {
                getBatchMemberExecutions: sandbox.stub().resolves([
                    { id: 'm-1', rowStart: 1, rows: 2, status: 'completed' },
                    { id: 'm-2', rowStart: 3, rows: 2, status: 'error' }
                ])
            });
            (manager as any).loadedRawData = { inputData: input, responses: [] };
            (manager as any).currentConfig = { batchId: 'batch-1', endpointId: 'ep-1' };
            const view = { name: 'All Columns', rowBasis: 'root', columns: [{ id: 'Result', source: 'current' }, { id: 'sku', source: 'current' }] };
            return (manager as any).extractTabData('input', null, undefined, undefined, view, filter);
        };

        it('exports only the rows with the chosen result, with their Result', async () => {
            const tabData = await extract('error');
            expect(tabData.data).to.deep.equal([{ Result: 'Error', sku: 'C' }, { Result: 'Error', sku: 'D' }]);
        });

        it('exports every row with its Result when the filter is All', async () => {
            const tabData = await extract('all');
            expect(tabData.data.map((r: any) => r.Result)).to.deep.equal(['Completed', 'Completed', 'Error', 'Error', 'Not processed']);
        });
    });

    describe('get_raw_transaction_content', () => {
        let dir: string;
        beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmn-raw-')); });
        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

        const contentFor = async (requestBody: string) => {
            const requestFile = path.join(dir, 'transaction-001-request.json');
            fs.writeFileSync(requestFile, requestBody);
            services.set(ExecutionServiceTokens.ExecutionMetadataService, {
                getExecution: sandbox.stub().resolves({ id: 'exec-1', requestFile })
            });
            const response = await (manager as any).handleGetRawTransactionContent({
                type: 'console.get_raw_transaction_content', correlationId: 'c3', payload: { executionIds: ['exec-1'] }
            });
            return response.data.contents[0].requestContent;
        };

        it('reads `{}` back as no body', async () => {
            expect(await contentFor('{}')).to.equal('');
            expect(await contentFor('  {\n}\n')).to.equal('');
        });

        it('keeps a real body, formatted', async () => {
            expect(await contentFor('{"sku":"A"}')).to.equal('{\n  "sku": "A"\n}');
        });
    });
});
