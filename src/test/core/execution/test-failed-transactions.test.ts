// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #428: a transaction whose response test fails is an error the moment it finishes — the
 * Console hears "errors", not "success" because the server said 200 — and it carries why
 * (the test, the assertion) to the Console and into its log.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import { RequestEnvironment } from '../../../services/execution/request-executor.interface';
import { readRunFile } from '../../../services/run-content/run-content-store';
import { buildCorePipeline, CorePipeline, inventoryEndpoint } from '../fixtures/core-pipeline';
import { startStubServer, StubServer } from '../fixtures/stub-server';

const rows = (count: number): string[][] => [['sku', 'qty'], ...Array.from({ length: count }, (_, i) => [`SKU-${i + 1}`, String(i + 1)])];

/** The body the item master's bulk import answers with (#428). */
const BULK_IMPORT_OK = {
    success: true,
    header: null,
    data: { Messages: null, TotalCount: 1, FailedRecords: [], FailedCount: 0, SuccessCount: 1 },
    errors: [],
    statusCode: 'OK'
};

const WRONG_TEST = 'expect(response.json().data.success).to.be.true;';
const RIGHT_TEST = 'expect(response.json().success).to.be.true;';

function endpointWithTest(script: string): APIEndpointConfig {
    return {
        ...inventoryEndpoint(),
        dataLoadingConfig: {
            jsonTemplate: inventoryEndpoint().body,
            testScripts: [{ name: 'PostExecutionTest', script, enabled: true, priority: 0 }]
        }
    } as unknown as APIEndpointConfig;
}

describe('A transaction whose test fails (#428)', function () {
    this.timeout(20000);

    let tempDir: string;
    let server: StubServer;
    let pipeline: CorePipeline;
    let environment: RequestEnvironment;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-428-'));
        server = await startStubServer();
        server.on('POST /inventory', { status: 200, body: BULK_IMPORT_OK });
        environment = { id: 'env-stub', name: 'Stub API', baseUrl: server.url, authMethod: 'jwt' };
        pipeline = await buildCorePipeline(tempDir, environment, { token: 't', responseTests: true });
    });

    afterEach(async () => {
        pipeline?.close();
        await server.close();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    async function runBatch(script: string) {
        const prepared = await pipeline.preparation.prepareBatchTransactions({
            endpoint: endpointWithTest(script),
            environment: environment.name,
            environmentId: environment.id,
            workspaceRoot: pipeline.workspaceRoot,
            csvData: rows(2),
            columnMappings: { sku: 'sku', qty: 'qty' },
            batchConfig: { rowsPerTransaction: 1 },
            batchName: 'Tested'
        });
        const batchId = prepared.batchId!;
        await pipeline.engine.executeRecord(batchId);
        const members = await pipeline.executionMetadataService.getBatchMemberExecutions(batchId);
        const results = pipeline.progress.events.filter(e => e.kind === 'memberResult');
        return { members, results };
    }

    it('is saved as an error with the test named, and the Console hears it as one', async () => {
        const { members, results } = await runBatch(WRONG_TEST);

        expect(members).to.have.length(2);
        for (const member of members) {
            expect(member.status).to.equal('error');
            expect(member.httpStatus).to.equal(200);
            expect(member.testStatus).to.equal('failed');
            expect(member.errorMessage).to.equal('Test "PostExecutionTest" failed: Expected undefined to be true');
        }

        expect(results).to.have.length(2);
        for (const event of results) {
            const update = (event as { update: { classification: string; result: { metadata: Record<string, unknown> } } }).update;
            expect(update.classification, 'straight to the Error tab, never Completed first').to.equal('errors');
            expect(update.result.metadata.testStatus).to.equal('failed');
            expect(update.result.metadata.errorMessage).to.equal('Test "PostExecutionTest" failed: Expected undefined to be true');
        }
    });

    it('writes the test and its result into the transaction log', async () => {
        const { members } = await runBatch(WRONG_TEST);
        const events = readRunFile(members[0].logPath!).trim().split('\n').map(line => JSON.parse(line));

        const check = events.find(e => e.event === 'test_check');
        expect(check.data.testScripts[0]).to.include({ name: 'PostExecutionTest', enabled: true, script: WRONG_TEST });

        const done = events.find(e => e.event === 'tests_completed');
        expect(done.data.results).to.deep.equal([{ name: 'PostExecutionTest', passed: false, error: 'Expected undefined to be true' }]);
    });

    it('a passing test leaves it completed, heard as a success', async () => {
        const { members, results } = await runBatch(RIGHT_TEST);

        expect(members.map(m => m.status)).to.deep.equal(['completed', 'completed']);
        expect(members.map(m => m.testStatus)).to.deep.equal(['passed', 'passed']);
        const classifications = results.map(e => (e as { update: { classification: string } }).update.classification);
        expect(classifications).to.deep.equal(['success', 'success']);
    });
});
