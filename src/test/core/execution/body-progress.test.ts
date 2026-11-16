// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #115: a big response body takes seconds to arrive. The run's Console hears it
 * ("Receiving 12,340 records · 10.2 MB"); a real batch's members stay quiet (the batch's own
 * progress owns that footer). Real pipeline, real fetch, stub server.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { bodyProgressConsoleId } from '../../../services/execution/execution.service';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';

const EXPORT: APIEndpointConfig = {
    id: 'endpoint-export', name: 'Inventory export', path: '/inventory/export', method: 'GET', headers: {}, queryParams: {}
} as APIEndpointConfig;

describe('Response body progress (Issue #115)', () => {
    let tempDir: string;
    let server: StubServer;
    let environment: RequestEnvironment;
    let pipeline: CorePipeline;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-body-progress-'));
        server = await startStubServer();
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'none' };
        pipeline = await buildCorePipeline(tempDir, environment);
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    const receiving = (executionId: string) => pipeline.progress.of('progress')
        .filter(e => e.executionId === executionId && e.payload.receiving)
        .map(e => e.payload.receiving!);

    it('Run API: the Console hears a JSONL body arrive, ending with every record in', async () => {
        server.on('GET /inventory/export', { headers: { 'content-type': 'application/x-ndjson' }, body: '{"sku":"A"}\n{"sku":"B"}\n{"sku":"C"}' });
        const prepared = await pipeline.preparation.prepareIndividualTransaction({
            endpoint: EXPORT, environment: environment.id, environmentId: environment.id, workspaceRoot: pipeline.workspaceRoot
        } as never);
        const executionId = prepared.executionId!;
        const result = await pipeline.executionService.executeRecord(executionId);
        expect(result, JSON.stringify(result)).to.include({ success: true, httpStatus: 200 });

        const events = receiving(executionId);
        expect(events.length).to.be.greaterThan(0);
        expect(events[events.length - 1]).to.deep.include({ lines: 3, jsonl: true, done: true });
        expect(events[events.length - 1].bytes).to.equal(35);
    });

    it('a real batch\'s members send no body progress', async () => {
        server.on('POST /inventory', { status: 201, body: { ok: true } });
        const prepared = await pipeline.preparation.prepareBatchTransactions({
            endpoint: inventoryEndpoint(), environment: environment.name, environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot, csvData: [['sku', 'qty'], ['A', '1'], ['B', '2']],
            columnMappings: { sku: 'sku', qty: 'qty' },
            batchConfig: { rowsPerTransaction: 1, parallelProcessing: { enabled: false, maxConcurrency: 1 } },
            batchName: 'No body progress'
        } as never);
        await pipeline.engine.executeRecord(prepared.batchId!);
        expect(pipeline.progress.of('progress').filter(e => e.payload.receiving)).to.have.length(0);
    });
});

describe('Where body progress goes (Issues #115, #436)', () => {
    const paged = { id: 'batch-1', endpointConfig: { method: 'GET', path: '/items', queryParams: { page: '{{A8:PAGE:1}}', size: '{{A8:SIZE:50}}' } } } as never;
    const plain = { id: 'batch-2', endpointConfig: { method: 'POST', path: '/items', queryParams: {} } } as never;

    it('a Run API: its own Console', () => {
        expect(bodyProgressConsoleId('individual', 'exec-1')).to.equal('exec-1');
    });

    it('the first page of a paginated run: the batch\'s Console, nothing else shows there yet', () => {
        expect(bodyProgressConsoleId('batch_member', 'page-1', { parentBatch: paged, memberCount: 1 })).to.equal('batch-1');
    });

    it('a page of Fetch all, once there is more than one: none, the batch\'s own progress owns the footer', () => {
        expect(bodyProgressConsoleId('batch_member', 'page-2', { parentBatch: paged, memberCount: 721 })).to.equal(undefined);
    });

    it('a real batch\'s members: none', () => {
        expect(bodyProgressConsoleId('batch_member', 'm-1', { parentBatch: plain, memberCount: 1 })).to.equal(undefined);
    });
});
