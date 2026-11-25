// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A batch whose path names an environment variable the environment lacks (`{{ENV:version}}` on an environment with
 * no `version`) is refused before anything is made or sent, naming the variable, as Run API refuses it. Before, the
 * batch sent the template as typed: every request a 404 at `…/{{ENV:version}}/inventory`.
 *
 * Run Batch's Execute through the RunOrchestrator, as both hosts run it, with the real preparation, engine and
 * sql.js history, against a local server (2026-11-25: replaces the web spec batch-missing-env, which walked the
 * screens for this; how the page shows a refused start is batch-start-refused.test.ts's).
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunOrchestrator, type RunOrchestratorDeps } from '../../../services/execution/run-orchestrator';
import type { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';
import { createMockLogger } from '../../helpers/logging/mock-logger';

const ROWS = [{ sku: 'SKU-1', qty: '10' }, { sku: 'SKU-2', qty: '20' }];

describe('Run Batch: a {{ENV:name}} the environment lacks is refused before anything is sent', function () {
    this.timeout(30000);

    let tempDir: string;
    let server: StubServer;
    let pipeline: CorePipeline;
    let environment: RequestEnvironment;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-missing-env-'));
        server = await startStubServer();
        server.on('POST /v2/inventory', () => ({ status: 201, body: { ok: true } }));
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'jwt' };
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'core-token' });
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    async function execute(variables: Record<string, string>) {
        const endpoint = { ...inventoryEndpoint(), path: '/{{ENV:version}}/inventory' };
        const env = { ...environment, variables };
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
            batchName: 'Missing env', parallelProcessing: { enabled: false, maxConcurrency: 1 }
        });
        return { result, opened: pipeline.progress.of('openConsole').length, sent: server.requests.map(r => r.url) };
    }

    it('refused, naming the variable and the environment: no batch, no request', async () => {
        const { result, opened, sent } = await execute({});
        expect(result.success).to.equal(false);
        expect(result.message).to.match(/^Missing environment variables: version\. Add them to the "Stub API" environment, then run again\.$/);
        expect(opened, 'no batch was made').to.equal(0);
        expect(sent, 'nothing was sent').to.deep.equal([]);
    });

    it('with the variable set, each request goes to its value: /v2/inventory', async () => {
        const { result, sent } = await execute({ version: 'v2' });
        expect(result.success, JSON.stringify(result)).to.equal(true);
        expect(sent).to.deep.equal(['/v2/inventory', '/v2/inventory']);
    });
});
