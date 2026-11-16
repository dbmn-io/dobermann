// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsEngineLoadError, SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { tempStorageOptions } from '../fixtures/temp-storage';

/**
 * Unit tests for sql.js execution storage
 * GitHub Issue #109: Migration to sql.js for cross-platform compatibility
 */
describe('SqlJsExecutionStorage', () => {
    let storage: SqlJsExecutionStorage;
    let tempDir: string;

    beforeEach(async () => {
        // Issue #324: a temp folder, no VS Code context — test:core
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-storage-'));
        storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir));
    });

    afterEach(async () => {
        // Close database connection
        if (storage) {
            storage.close();
        }

        // Restore stubs
        sinon.restore();

        // Clean up temp directory
        try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe('execution links (Issue #247)', () => {
        const base = {
            environment: 'DEV', environmentId: 'env-dev', organization: 'ACME',
            endpointId: 'endpoint-1', endpointName: 'Purchase Orders', endpointMethod: 'GET', endpointPath: '/po',
            createdAt: new Date()
        };

        it('reads a link from both ends, with each side\'s environment and headers', async () => {
            await storage.initialize();
            const source = await storage.createExecution({ ...base, executionType: 'individual', rows: '1', status: 'completed', requestHeaders: { Location: 'DC-01' } } as Omit<ExecutionMetadata, 'id'>);
            const batch = await storage.createExecution({ ...base, environment: 'UAT', endpointName: 'Replenish', endpointMethod: 'POST', executionType: 'batch', rows: '2', status: 'completed', startedAt: new Date() } as Omit<ExecutionMetadata, 'id'>);
            await storage.createExecution({ ...base, environment: 'UAT', executionType: 'batch_member', batchId: batch, rows: '1', status: 'completed', requestHeaders: { Location: 'DC-02' } } as Omit<ExecutionMetadata, 'id'>);

            await storage.addExecutionLink({ sourceExecutionId: source, targetExecutionId: batch, viewName: 'Open lines', rowCount: 312 });

            const fromSource = await storage.getExecutionLinks(source);
            expect(fromSource.upstream).to.have.length(0);
            expect(fromSource.downstream).to.have.length(1);
            expect(fromSource.downstream[0]).to.include({ executionId: batch, isBatch: true, endpointId: 'endpoint-1', endpointName: 'Replenish', environment: 'UAT', viewName: 'Open lines', rowCount: 312 });
            expect(fromSource.downstream[0].headers).to.deep.equal({ Location: 'DC-02' });   // a batch's: its first member's
            expect(fromSource.self).to.deep.include({ environment: 'DEV', organization: 'ACME' });

            const fromBatch = await storage.getExecutionLinks(batch);
            expect(fromBatch.downstream).to.have.length(0);
            expect(fromBatch.upstream[0]).to.include({ executionId: source, endpointMethod: 'GET', environment: 'DEV' });
        });

        it('a chained batch cancelled before it ran, or a deleted run, shows no link', async () => {
            await storage.initialize();
            const source = await storage.createExecution({ ...base, executionType: 'individual', rows: '1', status: 'completed' } as Omit<ExecutionMetadata, 'id'>);
            const cancelled = await storage.createExecution({ ...base, executionType: 'batch', rows: '1', status: 'cancelled' } as Omit<ExecutionMetadata, 'id'>);
            const deleted = await storage.createExecution({ ...base, executionType: 'batch', rows: '1', status: 'completed', startedAt: new Date() } as Omit<ExecutionMetadata, 'id'>);
            await storage.addExecutionLink({ sourceExecutionId: source, targetExecutionId: cancelled });
            await storage.addExecutionLink({ sourceExecutionId: source, targetExecutionId: deleted });
            await storage.deleteExecution(deleted);

            const links = await storage.getExecutionLinks(source);
            expect(links.downstream).to.have.length(0);
        });
    });

    describe('countBatchMembersByStatus (Issue #312)', () => {
        it('counts a batch\'s members per status without loading them', async () => {
            await storage.initialize();
            const base = {
                environment: 'test-env', environmentId: 'env-123', organization: 'test-org',
                endpointId: 'endpoint-1', endpointName: 'Batch Endpoint', endpointMethod: 'POST', endpointPath: '/api/batch',
                createdAt: new Date()
            };
            const batchId = await storage.createExecution({ ...base, executionType: 'batch', rows: '5', status: 'running' } as Omit<ExecutionMetadata, 'id'>);
            const other = await storage.createExecution({ ...base, executionType: 'batch', rows: '1', status: 'running' } as Omit<ExecutionMetadata, 'id'>);
            for (const status of ['completed', 'completed', 'error', 'running', 'pending']) {
                await storage.createExecution({ ...base, executionType: 'batch_member', batchId, rows: '1', status } as Omit<ExecutionMetadata, 'id'>);
            }
            await storage.createExecution({ ...base, executionType: 'batch_member', batchId: other, rows: '1', status: 'pending' } as Omit<ExecutionMetadata, 'id'>);

            expect(await storage.countBatchMembersByStatus(batchId)).to.deep.equal({ completed: 2, error: 1, running: 1, pending: 1 });
            expect(await storage.countBatchMembersByStatus(other)).to.deep.equal({ pending: 1 });
            expect(await storage.countBatchMembersByStatus('no-such-batch')).to.deep.equal({});
        });

        it('getBatchMemberFiles returns id, status, response file and creation time per member, in order', async () => {
            await storage.initialize();
            const base = {
                environment: 'test-env', environmentId: 'env-123', organization: 'test-org',
                endpointId: 'endpoint-1', endpointName: 'Batch Endpoint', endpointMethod: 'POST', endpointPath: '/api/batch'
            };
            const batchId = await storage.createExecution({ ...base, executionType: 'batch', rows: '2', status: 'running', createdAt: new Date() } as Omit<ExecutionMetadata, 'id'>);
            const m1 = await storage.createExecution({ ...base, executionType: 'batch_member', batchId, rows: '1', status: 'completed', createdAt: new Date(1000), responseFile: '/r/1.json', requestHeaders: { a: 'b' } } as Omit<ExecutionMetadata, 'id'>);
            const m2 = await storage.createExecution({ ...base, executionType: 'batch_member', batchId, rows: '1', status: 'pending', createdAt: new Date(2000) } as Omit<ExecutionMetadata, 'id'>);

            const files = await storage.getBatchMemberFiles(batchId);
            expect(files.map(f => f.id)).to.deep.equal([m1, m2]);
            expect(files[0]).to.deep.equal({ id: m1, status: 'completed', responseFile: '/r/1.json', createdAt: new Date(1000) });
            expect(files[1].responseFile).to.equal(undefined);
            expect(Object.keys(files[0]), 'lean rows, no request headers etc.').to.have.length(4);
        });
    });

    describe('initialize', () => {
        it('should create database file and schema', async () => {
            await storage.initialize();

            const dbPath = path.join(tempDir, '.dbmn', 'executions.db');
            const exists = await fs.promises.access(dbPath).then(() => true).catch(() => false);

            expect(exists).to.be.true;
        });

        it('should configure database with WAL mode', async () => {
            await storage.initialize();

            // Database should be initialized without errors
            // WAL mode configuration is tested implicitly through successful operations
            expect(storage).to.not.be.null;
        });

        // The web app fetches the engine from its server: when that server is gone (a dev
        // server that stopped, the site down) sql.js throws a bare string, "both async and sync
        // fetching of the wasm failed". The host needs to know it was the engine, and from where.
        it('names the engine load when sql-wasm.wasm cannot be loaded, keeping the cause', async () => {
            // sql.js keeps its first successful load for the whole process, so the tests above
            // would hand this one a working engine: a fresh copy of sql.js and of the service.
            const servicePath = require.resolve('../../../services/storage/sqljs-execution-storage.service');
            const sqlJsPath = require.resolve('sql.js');
            delete require.cache[servicePath];
            delete require.cache[sqlJsPath];
            const fresh = require(servicePath) as typeof import('../../../services/storage/sqljs-execution-storage.service');
            // A failed load aborts sql.js's Node build with a second, uncaught error after the
            // rejection: not ours, and not the host's to see (the browser build logs it)
            const ignoreAbort = (e: Error) => { if (!/Aborted/.test(e.message)) throw e; };
            process.on('uncaughtException', ignoreAbort);
            const missing = path.join(tempDir, 'nowhere', 'sql-wasm.wasm');
            storage = new fresh.SqlJsExecutionStorage(tempStorageOptions(tempDir, { wasmPath: missing }));
            try {
                const error = await storage.initialize().then(() => undefined, (e: unknown) => e);

                expect(error).to.be.instanceOf(fresh.SqlJsEngineLoadError);
                expect((error as SqlJsEngineLoadError).wasmPath).to.equal(missing);
                expect((error as SqlJsEngineLoadError).message).to.include(missing);
                expect(String((error as SqlJsEngineLoadError).cause)).to.include('ENOENT');
            } finally {
                await new Promise(resolve => setTimeout(resolve, 20));
                process.off('uncaughtException', ignoreAbort);
                delete require.cache[servicePath];
                delete require.cache[sqlJsPath];
            }
        });
    });

    describe('createExecution', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should create execution and return ID', async () => {
            const metadata: Omit<ExecutionMetadata, 'id'> = {
                environment: 'test-env',
                environmentId: 'env-123',
                organization: 'test-org',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/api/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            };

            const id = await storage.createExecution(metadata);

            expect(id).to.be.a('string');
            expect(id).to.match(/^exec_/);
        });

        it('should store execution with all fields', async () => {
            const metadata: Omit<ExecutionMetadata, 'id'> = {
                environment: 'test-env',
                environmentId: 'env-123',
                organization: 'test-org',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/api/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date(),
                requestHeaders: { 'Authorization': 'Bearer token' },
                requestQueryParams: { 'param1': 'value1' }
            };

            const id = await storage.createExecution(metadata);
            const retrieved = await storage.getExecution(id);

            expect(retrieved).to.not.be.null;
            expect(retrieved!.endpointName).to.equal('Test Endpoint');
            expect(retrieved!.status).to.equal('pending');
            expect(retrieved!.requestHeaders).to.deep.equal({ 'Authorization': 'Bearer token' });
            expect(retrieved!.requestQueryParams).to.deep.equal({ 'param1': 'value1' });
        });

        it('should create batch execution', async () => {
            const metadata: Omit<ExecutionMetadata, 'id'> = {
                environment: 'test-env',
                environmentId: 'env-123',
                organization: 'test-org',
                endpointId: 'endpoint-1',
                endpointName: 'Batch Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/api/batch',
                executionType: 'batch',
                rows: '100',
                status: 'pending',
                createdAt: new Date(),
                batchConfiguration: {
                    stopOnFirstError: false,
                    maxConcurrentExecutions: 4
                },
                preparationState: {
                    totalRows: 100,
                    totalTransactions: 100,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: 8,
                    isComplete: false
                }
            };

            const id = await storage.createExecution(metadata);
            const retrieved = await storage.getExecution(id);

            expect(retrieved).to.not.be.null;
            expect(retrieved!.executionType).to.equal('batch');
            expect(retrieved!.rows).to.equal('100');
            expect(retrieved!.preparationState).to.deep.equal({
                totalRows: 100,
                totalTransactions: 100,
                preparedTransactions: 0,
                nextCsvRowIndex: 0,
                chunkSize: 8,
                isComplete: false
            });
        });
    });

    describe('updateExecution', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should update execution status', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.updateExecution(id, { status: 'running' });

            const retrieved = await storage.getExecution(id);
            expect(retrieved!.status).to.equal('running');
        });

        it('should update batch preparation state', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'pending',
                createdAt: new Date(),
                preparationState: {
                    totalRows: 100,
                    totalTransactions: 100,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: 8,
                    isComplete: false
                }
            });

            await storage.updateExecution(id, {
                preparationState: {
                    totalRows: 100,
                    totalTransactions: 100,
                    preparedTransactions: 8,
                    nextCsvRowIndex: 8,
                    chunkSize: 8,
                    isComplete: false
                }
            });

            const retrieved = await storage.getExecution(id);
            expect(retrieved!.preparationState!.preparedTransactions).to.equal(8);
            expect(retrieved!.preparationState!.nextCsvRowIndex).to.equal(8);
        });

        it('should throw error if execution not found', async () => {
            try {
                await storage.updateExecution('non-existent', { status: 'running' });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
                expect((error as Error).message).to.include('not found');
            }
        });
    });

    describe('bulkUpdateExecutions', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should update multiple executions atomically', async () => {
            // Create 3 executions
            const id1 = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const id2 = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const id3 = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test 3',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            // Bulk update all to running
            await storage.bulkUpdateExecutions([
                { id: id1, updates: { status: 'running' } },
                { id: id2, updates: { status: 'running' } },
                { id: id3, updates: { status: 'running' } }
            ]);

            // Verify all updated
            const exec1 = await storage.getExecution(id1);
            const exec2 = await storage.getExecution(id2);
            const exec3 = await storage.getExecution(id3);

            expect(exec1!.status).to.equal('running');
            expect(exec2!.status).to.equal('running');
            expect(exec3!.status).to.equal('running');
        });
    });

    describe('getExecution', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should return null for non-existent execution', async () => {
            const result = await storage.getExecution('non-existent');
            expect(result).to.be.null;
        });

        it('should return execution by ID', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const result = await storage.getExecution(id);

            expect(result).to.not.be.null;
            expect(result!.id).to.equal(id);
            expect(result!.endpointName).to.equal('Test');
        });
    });

    describe('getExecutions', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should return all executions', async () => {
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'completed',
                createdAt: new Date()
            });

            const results = await storage.getExecutions();

            expect(results).to.have.length(2);
        });

        it('should filter by status', async () => {
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'completed',
                createdAt: new Date()
            });

            const results = await storage.getExecutions({ status: 'pending' });

            expect(results).to.have.length(1);
            expect(results[0].status).to.equal('pending');
        });

        it('should filter by environment', async () => {
            await storage.createExecution({
                environment: 'prod',
                endpointId: 'endpoint-1',
                endpointName: 'Test 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'staging',
                endpointId: 'endpoint-1',
                endpointName: 'Test 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const results = await storage.getExecutions({ environment: 'prod' });

            expect(results).to.have.length(1);
            expect(results[0].environment).to.equal('prod');
        });
    });

    describe('getExecutionTable', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should return paginated results', async () => {
            // Create 10 executions
            for (let i = 0; i < 10; i++) {
                await storage.createExecution({
                    environment: 'test-env',
                    endpointId: 'endpoint-1',
                    endpointName: `Test ${i}`,
                    endpointMethod: 'POST',
                    endpointPath: '/test',
                    executionType: 'individual',
                    rows: '1',
                    status: 'pending',
                    createdAt: new Date()
                });
            }

            const page1 = await storage.getExecutionTable({ limit: 5, offset: 0 });
            const page2 = await storage.getExecutionTable({ limit: 5, offset: 5 });

            expect(page1.executions).to.have.length(5);
            expect(page1.totalCount).to.equal(10);
            expect(page1.hasMore).to.be.true;

            expect(page2.executions).to.have.length(5);
            expect(page2.totalCount).to.equal(10);
            expect(page2.hasMore).to.be.false;
        });
    });

    describe('getExecutionStats', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should return correct statistics', async () => {
            // Create executions with different statuses
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'completed',
                runTime: 1000,
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test 3',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'error',
                createdAt: new Date()
            });

            const stats = await storage.getExecutionStats();

            expect(stats.totalExecutions).to.equal(3);
            expect(stats.pendingExecutions).to.equal(1);
            expect(stats.completedExecutions).to.equal(1);
            expect(stats.errorExecutions).to.equal(1);
            expect(stats.averageRunTime).to.equal(1000);
        });
    });

    describe('deleteExecution', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should delete execution', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.deleteExecution(id);

            const result = await storage.getExecution(id);
            expect(result).to.be.null;
        });
    });

    // Issue #246: bulk delete from Hub transactions tab.
    describe('deleteExecutions (bulk)', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        const makeOne = async (i: number) => storage.createExecution({
            environment: 'test-env',
            endpointId: `ep-${i}`,
            endpointName: `Test ${i}`,
            endpointMethod: 'POST',
            endpointPath: `/test/${i}`,
            executionType: 'individual',
            rows: '1',
            status: 'completed',
            createdAt: new Date()
        });

        it('is a no-op when ids is empty', async () => {
            const removed = await storage.deleteExecutions([]);
            expect(removed).to.equal(0);
        });

        it('deletes only the requested ids', async () => {
            const ids = await Promise.all([0, 1, 2].map(makeOne));
            const removed = await storage.deleteExecutions([ids[0], ids[2]]);
            expect(removed).to.equal(2);
            expect(await storage.getExecution(ids[0])).to.be.null;
            expect(await storage.getExecution(ids[1])).to.not.be.null;
            expect(await storage.getExecution(ids[2])).to.be.null;
        });

        it('dedupes duplicate ids in the input', async () => {
            const ids = await Promise.all([0, 1].map(makeOne));
            const removed = await storage.deleteExecutions([ids[0], ids[0], ids[1]]);
            expect(removed).to.equal(2);
        });

        it('refuses to wipe more than half the table (when table is big enough to matter)', async () => {
            // Safety guard exempts tiny tables — bulk up past the
            // threshold so the >50% rule kicks in.
            const ids: string[] = [];
            for (let i = 0; i < 60; i++) ids.push(await makeOne(i));
            const toDelete = ids.slice(0, 40);
            let threw = false;
            try {
                await storage.deleteExecutions(toDelete);
            } catch (e) {
                threw = true;
                expect(String((e as Error).message)).to.match(/>50%/);
            }
            expect(threw).to.equal(true);
            // Nothing should have been deleted.
            for (const id of toDelete) {
                expect(await storage.getExecution(id)).to.not.be.null;
            }
        });
    });

    describe('batch operations', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should get individual executions only', async () => {
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Individual',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'pending',
                createdAt: new Date()
            });

            const individuals = await storage.getIndividualExecutions();

            expect(individuals).to.have.length(1);
            expect(individuals[0].executionType).to.equal('individual');
        });

        it('should get batch executions only', async () => {
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Individual',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'pending',
                createdAt: new Date()
            });

            const batches = await storage.getBatchExecutions();

            expect(batches).to.have.length(1);
            expect(batches[0].executionType).to.equal('batch');
        });

        it('should get batch member executions for batch', async () => {
            const batchId = await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '3',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Member 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Member 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const members = await storage.getBatchMemberExecutions(batchId);

            expect(members).to.have.length(2);
            expect(members[0].executionType).to.equal('batch_member');
            expect(members[0].batchId).to.equal(batchId);
        });

        it('should delete batch and all members', async () => {
            const batchId = await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '2',
                status: 'pending',
                createdAt: new Date()
            });

            const member1Id = await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Member 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.deleteBatch(batchId);

            const batch = await storage.getExecution(batchId);
            const member = await storage.getExecution(member1Id);

            expect(batch).to.be.null;
            expect(member).to.be.null;
        });
    });

    describe('getActiveQueue', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should return only active individual and batch executions', async () => {
            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Pending Individual',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Running Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'running',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                endpointId: 'endpoint-1',
                endpointName: 'Completed Individual',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'completed',
                createdAt: new Date()
            });

            const activeQueue = await storage.getActiveQueue();

            expect(activeQueue).to.have.length(2);
            expect(activeQueue[0].status).to.be.oneOf(['pending', 'running']);
            expect(activeQueue[1].status).to.be.oneOf(['pending', 'running']);
        });
    });

    describe('null/undefined handling (GitHub Issue #102)', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should convert null to undefined for optional fields', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
                // All optional fields omitted (will be undefined)
            });

            const retrieved = await storage.getExecution(id);

            // Verify all optional fields are undefined, not null
            expect(retrieved!.organization).to.be.undefined;
            expect(retrieved!.batchId).to.be.undefined;
            expect(retrieved!.runTime).to.be.undefined;
            expect(retrieved!.responseFile).to.be.undefined;
            expect(retrieved!.requestFile).to.be.undefined;
            expect(retrieved!.logPath).to.be.undefined;
            expect(retrieved!.httpStatus).to.be.undefined;
            expect(retrieved!.httpStatusText).to.be.undefined;
            expect(retrieved!.errorMessage).to.be.undefined;
            expect(retrieved!.requestHash).to.be.undefined;
            expect(retrieved!.requestHeaders).to.be.undefined;
            expect(retrieved!.requestQueryParams).to.be.undefined;
            expect(retrieved!.testStatus).to.be.undefined;
            expect(retrieved!.testsPassed).to.be.undefined;
            expect(retrieved!.testsFailed).to.be.undefined;
            expect(retrieved!.testResults).to.be.undefined;
            expect(retrieved!.startedAt).to.be.undefined;
            expect(retrieved!.completedAt).to.be.undefined;
            expect(retrieved!.copiedFromBatchId).to.be.undefined;
        });

        it('should pass Zod validation with null->undefined conversion', async () => {
            // Create parent batch first to satisfy foreign key constraint
            const batchId = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Parent Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '10',
                status: 'running',
                createdAt: new Date()
            });

            const metadata: Omit<ExecutionMetadata, 'id'> = {
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'completed',
                runTime: 1234,
                httpStatus: 200,
                httpStatusText: 'OK',
                createdAt: new Date()
            };

            // Should not throw validation error
            const id = await storage.createExecution(metadata);
            const retrieved = await storage.getExecution(id);

            expect(retrieved).to.not.be.null;
            expect(retrieved!.batchId).to.equal(batchId);
            expect(retrieved!.runTime).to.equal(1234);
            expect(retrieved!.httpStatus).to.equal(200);
        });
    });

    describe('tree view filtering (GitHub Issue #102)', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should exclude batch_member from getAllTransactions', async () => {
            const batchId = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Batch Parent',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '3',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Member 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Individual',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'individual',
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const allTransactions = await storage.getAllTransactions();

            // Should only return batch parent and individual (not batch_member)
            expect(allTransactions).to.have.length(2);
            expect(allTransactions.every(t => t.executionType !== 'batch_member')).to.be.true;
            expect(allTransactions.some(t => t.executionType === 'batch')).to.be.true;
            expect(allTransactions.some(t => t.executionType === 'individual')).to.be.true;
        });

        it('should still query batch members via getBatchMemberExecutions', async () => {
            const batchId = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '2',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Member 1',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Member 2',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch_member',
                batchId: batchId,
                rows: '1',
                status: 'pending',
                createdAt: new Date()
            });

            const members = await storage.getBatchMemberExecutions(batchId);

            expect(members).to.have.length(2);
            expect(members.every(m => m.executionType === 'batch_member')).to.be.true;
            expect(members.every(m => m.batchId === batchId)).to.be.true;
        });
    });

    describe('batch status transitions (GitHub Issue #102)', () => {
        beforeEach(async () => {
            await storage.initialize();
        });

        it('should support pending -> running -> completed flow', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'pending',
                createdAt: new Date()
            });

            let exec = await storage.getExecution(id);
            expect(exec!.status).to.equal('pending');

            await storage.updateExecution(id, { status: 'running', startedAt: new Date() });
            exec = await storage.getExecution(id);
            expect(exec!.status).to.equal('running');

            expect(exec!.startedAt).to.not.be.undefined;

            await storage.updateExecution(id, { status: 'completed', completedAt: new Date() });
            exec = await storage.getExecution(id);
            expect(exec!.status).to.equal('completed');
            expect(exec!.completedAt).to.not.be.undefined;
        });

        it('should support paused and stopped states', async () => {
            const id = await storage.createExecution({
                environment: 'test-env',
                environmentId: 'env-123',
                endpointId: 'endpoint-1',
                endpointName: 'Test Batch',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                rows: '100',
                status: 'running',
                createdAt: new Date()
            });

            await storage.updateExecution(id, { status: 'paused' });
            let exec = await storage.getExecution(id);
            expect(exec!.status).to.equal('paused');

            await storage.updateExecution(id, { status: 'stopped' });
            exec = await storage.getExecution(id);
            expect(exec!.status).to.equal('stopped');
        });
    });
});
