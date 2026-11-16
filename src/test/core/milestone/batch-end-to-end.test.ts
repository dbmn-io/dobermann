// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #325 — milestone: a batch runs end to end outside the Extension Development Host.
 *
 * CSV rows → TransactionPreparationService → BatchExecutionEngine → ExecutionService →
 * FetchRequestExecutor → a local HTTP server, with the history in real sql.js storage on disk.
 * No VS Code is loaded (the test:core guard would fail the run), no mocks of DBMN code.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';
import { runFileExists } from '../../../services/run-content/run-content-store';

const HEADER = ['sku', 'qty'];
const rows = (count: number): string[][] =>
    Array.from({ length: count }, (_, i) => [`SKU-${String(i + 1).padStart(3, '0')}`, String((i + 1) * 10)]);

describe('Milestone: a batch end to end with no VS Code (Issue #325)', function () {
    this.timeout(20000);

    let tempDir: string;
    let server: StubServer;
    let pipeline: CorePipeline;
    let environment: RequestEnvironment;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-milestone-'));
        server = await startStubServer();
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'jwt' };
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    async function runBatch(csvRows: string[][], parallel = 2) {
        const prepared = await pipeline.preparation.prepareBatchTransactions({
            endpoint: inventoryEndpoint(),
            environment: environment.name,
            environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot,
            csvData: [HEADER, ...csvRows],
            columnMappings: { sku: 'sku', qty: 'qty' },
            batchConfig: { rowsPerTransaction: 1, parallelProcessing: { enabled: parallel > 1, maxConcurrency: parallel } },
            batchName: 'Core milestone'
        });
        const batchId = prepared.batchId;
        if (!batchId) {
            throw new Error('preparation returned no batch id');
        }
        const state = await pipeline.engine.executeRecord(batchId);
        const batch = await pipeline.executionMetadataService.getExecution(batchId);
        const members = await pipeline.executionMetadataService.getBatchMemberExecutions(batchId);
        return { batchId, state, batch, members };
    }

    it('25 rows: every request sent once with its row, every member completed, results on disk', async () => {
        server.on('POST /inventory', req => ({ status: 201, body: { received: JSON.parse(req.body) } }));
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'core-token' });

        const { batchId, batch, members } = await runBatch(rows(25));

        // The server saw exactly the 25 rows, each once, with the token
        const sent = server.requests.map(r => JSON.parse(r.body)).sort((a, b) => a.sku.localeCompare(b.sku));
        expect(sent).to.deep.equal(rows(25).map(([sku, qty]) => ({ sku, quantityOnHand: qty })));
        expect(server.requests.every(r => r.headers.authorization === 'Bearer core-token')).to.equal(true);

        // History: the batch and every member completed, each with its response file
        expect(batch?.status).to.equal('completed');
        // #445: the batch keeps the name it was given, and the endpoint keeps its own
        expect(batch?.batchConfiguration?.name).to.equal('Core milestone');
        expect(batch?.endpointName).to.not.equal('Core milestone');
        expect(members).to.have.length(25);
        expect(members.every(m => m.status === 'completed' && m.httpStatus === 201)).to.equal(true);
        for (const member of members) {
            expect(!!member.responseFile && runFileExists(member.responseFile), `response for ${member.id}`).to.equal(true);
        }

        // The Console was opened for the batch, saw every result, and was told it completed
        expect(pipeline.progress.of('openConsole').some(e => e.executionId === batchId)).to.equal(true);
        expect(pipeline.progress.of('memberResult').filter(e => e.batchId === batchId)).to.have.length(25);
        const statuses = pipeline.progress.of('status').filter(e => e.executionId === batchId).map(e => e.update.status);
        expect(statuses[statuses.length - 1]).to.equal('completed');
    });

    it('#424/#160: a variable in the base URL fills it, and the batch keeps that URL whatever changes mid-run', async () => {
        server.on('POST /v1/inventory', { status: 201, body: { ok: true } });
        environment = { ...environment, baseUrl: `${server.url}/{{version}}`, variables: { version: 'v1' } };
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'core-token' });

        const prepared = await pipeline.preparation.prepareBatchTransactions({
            endpoint: inventoryEndpoint(),
            environment: environment.name,
            environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot,
            csvData: [HEADER, ...rows(4)],
            columnMappings: { sku: 'sku', qty: 'qty' },
            batchConfig: { rowsPerTransaction: 1, parallelProcessing: { enabled: false, maxConcurrency: 1 } },
            batchName: 'Base URL variable',
            environmentVariables: { version: 'v1' },
            baseUrl: `${server.url}/v1`
        });
        // After the batch started: the variable switched and the URL's path edited
        environment.variables = { version: 'v2' };
        environment.baseUrl = `${server.url}/api/{{version}}`;
        await pipeline.engine.executeRecord(prepared.batchId as string);

        expect(server.requests.map(r => r.url)).to.deep.equal(Array(4).fill('/v1/inventory'));
        const batch = await pipeline.executionMetadataService.getExecution(prepared.batchId as string);
        expect(batch?.status).to.equal('completed');
        expect(batch?.baseUrl, 'kept on the batch').to.equal(`${server.url}/v1`);
    });

    it('a 401 is critical by default: the batch stops instead of sending the rest', async () => {
        server.on('POST /inventory', { status: 401, body: { error: 'unauthorized' } });
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'expired' });

        const { batch, members } = await runBatch(rows(10), 1);

        expect(batch?.status).to.equal('stopped');
        expect(server.requests.length, 'stopped after the first 401').to.equal(1);
        expect(members.filter(m => m.status === 'error')).to.have.length(1);
    });

    it('#359: a token that expires mid-batch is refreshed without asking, and the batch carries on', async () => {
        let token = 'fresh';
        server.on('POST /inventory', req => (req.headers.authorization === 'Bearer fresh-2'
            ? { status: 201, body: { ok: true } }
            : req.headers.authorization === 'Bearer fresh' && server.requests.length <= 3
                ? { status: 201, body: { ok: true } }
                : { status: 401, body: { error: 'invalid_token' } }));
        const refreshed: string[] = [];
        pipeline = await buildCorePipeline(tempDir, environment, {
            currentToken: () => token,
            refreshCredentials: async id => { refreshed.push(id); token = 'fresh-2'; return true; }
        });

        const { batch, members } = await runBatch(rows(10), 1);

        expect(refreshed, 'refreshed once, for the batch\'s environment').to.deep.equal(['env-stub']);
        expect(batch?.status).to.equal('completed');
        expect(members.every(m => m.status === 'completed')).to.equal(true);
    });

    it('#359: a refresh that fails stops the batch at the 401, as before', async () => {
        server.on('POST /inventory', { status: 401, body: { error: 'invalid_token' } });
        pipeline = await buildCorePipeline(tempDir, environment, { token: 'expired', refreshCredentials: async () => false });

        const { batch } = await runBatch(rows(10), 1);

        expect(batch?.status).to.equal('stopped');
        expect(server.requests.length).to.equal(1);
    });

    it('settings decide what is critical: with 401 not critical, every row is still tried', async () => {
        server.on('POST /inventory', { status: 401, body: { error: 'unauthorized' } });
        pipeline = await buildCorePipeline(tempDir, environment, {
            token: 'expired',
            settings: { 'dbmn.execution.criticalErrorCodes': [] }
        });

        const { members } = await runBatch(rows(10), 1);

        expect(server.requests).to.have.length(10);
        expect(members.every(m => m.status === 'error' && m.httpStatus === 401)).to.equal(true);
    });
});
