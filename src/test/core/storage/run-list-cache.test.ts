// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One list of runs per app (James, 2026-11-23: "yes. NOW."): the Hub's History, Add a view and the
 * Console's runs to compare all read DatabaseAdapter's list, read from the database again only when
 * the history has changed (SqlJsExecutionStorage.changeStamp): a run started, finished or deleted,
 * here or by another app on the same workspace folder.
 *   npm run test:core
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { DatabaseAdapter } from '../../../services/storage/database-adapter';
import { ExecutionMetadataService } from '../../../services/execution/execution-metadata.service';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { tempStorageOptions } from '../fixtures/temp-storage';
import { createMockLogger } from '../../helpers/logging/mock-logger';

describe('The run list: one per app, read again only when the history changes', () => {
    let tempDir: string;
    const open: SqlJsExecutionStorage[] = [];

    const run = (name: string, type: 'individual' | 'batch' | 'batch_member' = 'individual', extra: Partial<ExecutionMetadata> = {}): Omit<ExecutionMetadata, 'id'> => ({
        environment: 'DBMN Local', environmentId: 'env-local', organization: '',
        endpointId: 'endpoint-1', endpointName: name, endpointMethod: 'GET', endpointPath: '/inventory',
        executionType: type, rows: '1', status: 'running', createdAt: new Date(), ...extra
    });

    /** An app: its storage on the shared folder, its adapter (the one list), its metadata service. */
    async function app() {
        const storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir));
        const adapter = new DatabaseAdapter(storage);
        await adapter.initialize();
        open.push(storage);
        const metadata = new ExecutionMetadataService({ executionMetadataManager: adapter, dobermannInstance: {} } as never, createMockLogger());
        const reads = sinon.spy(storage, 'getAllTransactions');
        const names = async () => (await adapter.getAllTransactions()).map(e => e.endpointName).sort();
        return { storage, adapter, metadata, reads, names };
    }

    beforeEach(async () => { tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-run-list-')); });
    afterEach(async () => {
        for (const storage of open.splice(0)) { try { storage.close(); } catch { /* already closed */ } }
        sinon.restore();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('the Hub, Add a view and the Console share one read while nothing changes', async () => {
        const a = await app();
        await a.storage.createExecution(run('Stock', 'individual', { status: 'completed' }));
        a.reads.resetHistory();
        await a.adapter.getAllTransactions();                                   // the Hub's History
        await a.metadata.getUnifiedExecutionHistory();                          // Add a view
        await a.adapter.getExecutionsByEndpoint('endpoint-1', { runsOnly: true }); // the Console's runs to compare
        await a.adapter.getAllTransactions();
        expect(a.reads.callCount, 'read from the database once').to.equal(1);
    });

    it('a run started, finished and deleted shows in the next read, with no reload', async () => {
        const a = await app();
        expect(await a.names()).to.deep.equal([]);
        const id = await a.storage.createExecution(run('Stock'));
        expect(await a.names(), 'started').to.deep.equal(['Stock']);
        await a.storage.updateExecution(id, { status: 'completed', completedAt: new Date() });
        expect((await a.adapter.getAllTransactions())[0].status, 'finished').to.equal('completed');
        expect((await a.metadata.getUnifiedExecutionHistory()).map(e => e.endpointName), 'and in Add a view, once finished').to.deep.equal(['Stock']);
        await a.storage.deleteExecution(id);
        expect(await a.names(), 'deleted').to.deep.equal([]);
    });

    it('another app on the same workspace folder: its runs show at the next read, not at this app\'s next save', async () => {
        const web = await app();
        await web.storage.createExecution(run('Run in the web app'));
        expect(await web.names()).to.deep.equal(['Run in the web app']);
        const vscode = await app();
        await vscode.storage.createExecution(run('Run in VS Code'));
        vscode.storage.close();                                                 // VS Code saves to the file
        expect(await web.names(), 'merged from the file, then read').to.deep.equal(['Run in VS Code', 'Run in the web app']);
        web.reads.resetHistory();
        await web.names();
        expect(web.reads.callCount, 'and not read again while the file stays the same').to.equal(0);
    });

    it('a batch\'s requests are never in it; a caller changing its copy changes nothing shared', async () => {
        const a = await app();
        const batch = await a.storage.createExecution(run('Load', 'batch'));
        await a.storage.createExecution(run('Load row 1', 'batch_member', { batchId: batch }));
        expect(await a.names()).to.deep.equal(['Load']);
        expect((await a.adapter.getExecutionsByEndpoint('endpoint-1', { runsOnly: true })).map(e => e.endpointName)).to.deep.equal(['Load']);
        const mine = await a.adapter.getAllTransactions();
        mine.length = 0;
        expect(await a.names(), 'the shared list as it was').to.deep.equal(['Load']);
    });

    it('a read that fails is not kept: the next one reads again', async () => {
        const a = await app();
        a.reads.restore();
        const failing = sinon.stub(a.storage, 'getAllTransactions').onFirstCall().rejects(new Error('busy')).callThrough();
        let failed = false;
        await a.adapter.getAllTransactions().catch(() => { failed = true; });
        expect(failed).to.equal(true);
        expect(await a.adapter.getAllTransactions()).to.deep.equal([]);
        expect(failing.callCount).to.equal(2);
    });
});
