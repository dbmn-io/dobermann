// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #323 / #335: Cancel aborts the requests in flight (the Fetch standard's AbortSignal reaches
 * fetch); Pause is the stop that lets them finish. An aborted request is recorded as cancelled,
 * never as an error, and never counts as a reason to stop the batch.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';

const rows = (count: number): string[][] => [['sku', 'qty'], ...Array.from({ length: count }, (_, i) => [`SKU-${i + 1}`, String(i + 1)])];

async function until(condition: () => boolean, ms = 5000): Promise<void> {
    const giveUp = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > giveUp) throw new Error('timed out waiting');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

describe('Cancel aborts the requests in flight (#323, #335)', function () {
    this.timeout(20000);

    let tempDir: string;
    let server: StubServer;
    let pipeline: CorePipeline;
    let environment: RequestEnvironment;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-cancel-'));
        server = await startStubServer();
        server.on('POST /inventory', { hang: true });   // never answers: only an abort ends these
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'jwt' };
        pipeline = await buildCorePipeline(tempDir, environment, { token: 't' });
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('a batch: every thread\'s request is aborted, recorded as cancelled, and nothing more is sent', async () => {
        const prepared = await pipeline.preparation.prepareBatchTransactions({
            endpoint: inventoryEndpoint(),
            environment: environment.name,
            environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot,
            csvData: rows(12),
            columnMappings: { sku: 'sku', qty: 'qty' },
            batchConfig: { rowsPerTransaction: 1, parallelProcessing: { enabled: true, maxConcurrency: 4 } },
            batchName: 'Cancel me'
        });
        const batchId = prepared.batchId!;
        const run = pipeline.engine.executeRecord(batchId);
        await until(() => server.requests.length === 4);   // four threads, each waiting on the server

        await pipeline.engine.cancelBatch(batchId);
        await run;   // ends: the requests were aborted, not left to hang

        const batch = await pipeline.executionMetadataService.getExecution(batchId);
        const members = await pipeline.executionMetadataService.getBatchMemberExecutions(batchId);
        expect(batch?.status).to.equal('cancelled');
        expect(members.filter(m => m.status === 'cancelled'), 'the four in flight').to.have.length(4);
        expect(members.filter(m => m.status === 'error'), 'none recorded as an error').to.have.length(0);
        expect(server.requests, 'nothing more sent').to.have.length(4);
    });

    it('a single run: its request is aborted and the run is cancelled, not an error', async () => {
        const prepared = await pipeline.preparation.prepareIndividualTransaction({
            endpoint: { ...inventoryEndpoint(), body: '{"sku":"SKU-1","quantityOnHand":"1"}' },
            environment: environment.id,   // the fixture's lookup is by id
            environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot
        } as never);
        const id = prepared.executionId!;
        const run = pipeline.executionService.executeRecord(id);
        await until(() => server.requests.length === 1);

        await pipeline.executionService.cancel(id);
        const result = await run;

        expect(result.success).to.equal(false);
        expect(result.cancelled).to.equal(true);
        expect((await pipeline.executionMetadataService.getExecution(id))?.status).to.equal('cancelled');
    });
});
