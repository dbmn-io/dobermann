// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: Run Batch's Execute through the RunOrchestrator, as both hosts run it, with the real preparation, engine
 * and sql.js history, against a local server that fails the second request. Error handling as the confirmation chose
 * it holds from the first request: Stop on first error stops after the failure, Continue processing runs on.
 * With no choice (today's Review), the batch keeps the mode the endpoint was saved with.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunOrchestrator, type RunOrchestratorDeps } from '../../../services/execution/run-orchestrator';
import type { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';
import { createMockLogger } from '../../helpers/logging/mock-logger';

const ROWS = Array.from({ length: 6 }, (_, i) => ({ sku: `SKU-${i + 1}`, qty: String((i + 1) * 10) }));

describe('Run Batch: Error handling holds from the first request (#470)', function () {
    this.timeout(30000);

    let tempDir: string;
    let server: StubServer;
    let pipeline: CorePipeline;
    let environment: RequestEnvironment;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-error-mode-'));
        server = await startStubServer();
        // The second row fails; every other row is taken
        server.on('POST /inventory', req => (JSON.parse(req.body).sku === 'SKU-2' ? { status: 500, body: { error: 'boom' } } : { status: 201, body: { ok: true } }));
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'jwt' };
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'core-token' });
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    async function execute(choice: { stopOnFirstError?: boolean }, endpoint: APIEndpointConfig = inventoryEndpoint()) {
        const env = { ...environment, variables: {} };
        const deps = {
            logger: createMockLogger(),
            environments: { getActiveEnvironment: async () => env, getEnvironment: async () => env },
            endpoints: { getEndpoint: async () => endpoint },
            pipeline: { getTransactionPreparationService: () => pipeline.preparation, getBatchExecutionEngine: () => pipeline.engine },
            individualEngine: () => undefined,
            modal: () => undefined,
            ensureAuthenticated: async () => true,
            promptSignIn: async () => undefined,
            confirmProduction: async () => true,
            workspaceRoot: async () => pipeline.workspaceRoot,
            toast: { error: () => undefined }
        } as unknown as RunOrchestratorDeps;
        const result = await new RunOrchestrator(deps).executeBulkLoad({
            endpointId: endpoint.id, jsonData: ROWS, mappings: [{ variable: 'sku', column: 'sku' }, { variable: 'qty', column: 'qty' }],
            batchName: 'Error mode', parallelProcessing: { enabled: false, maxConcurrency: 1 }, ...choice
        });
        expect(result.success, JSON.stringify(result)).to.equal(true);
        // (executeBulkLoad returns once the batch has run: one at a time, every request it sent is in)
        const opened = pipeline.progress.of('openConsole').map(e => e.executionId).filter(Boolean);
        expect(opened, 'the batch opened its Console').to.not.be.empty;
        return { batch: await pipeline.executionMetadataService.getExecution(String(opened[0])), sent: server.requests.map(r => JSON.parse(r.body).sku) };
    }

    it('Stop on first error: the failed second request is the last one sent', async () => {
        const { batch, sent } = await execute({ stopOnFirstError: true });
        expect(sent).to.deep.equal(['SKU-1', 'SKU-2']);
        expect(batch?.batchConfiguration?.stopOnFirstError).to.equal(true);
        expect(String(batch?.status).toLowerCase()).to.not.equal('completed');
    });

    it('Continue processing: every row is sent, the failure among them', async () => {
        const { sent } = await execute({ stopOnFirstError: false });
        expect(sent).to.deep.equal(ROWS.map(r => r.sku));
    });

    it('Continue processing chosen overrides an endpoint saved as Stop on first error', async () => {
        const saved = { ...inventoryEndpoint(), dataLoadingConfig: { errorHandling: { mode: 'stopOnFirst' } } } as unknown as APIEndpointConfig;
        const { sent } = await execute({ stopOnFirstError: false }, saved);
        expect(sent).to.have.length(ROWS.length);
    });

    it('no choice (today\'s Review): the endpoint\'s saved Stop on first error still stops it', async () => {
        const saved = { ...inventoryEndpoint(), dataLoadingConfig: { errorHandling: { mode: 'stopOnFirst' } } } as unknown as APIEndpointConfig;
        const { sent } = await execute({}, saved);
        expect(sent).to.deep.equal(['SKU-1', 'SKU-2']);
    });
});
