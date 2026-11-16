// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #324: a corrupt executions.db is moved aside and replaced with a fresh one, and the host
 * is told where the old file went (in VS Code: a native notice with Show / Copy / Email). Before
 * #324 this could only be exercised through vscode.window.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { tempStorageOptions } from '../fixtures/temp-storage';

describe('SqlJsExecutionStorage — corruption recovery (Issue #324)', () => {
    let tempDir: string;
    let storage: SqlJsExecutionStorage | undefined;

    beforeEach(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-corrupt-'));
    });

    afterEach(async () => {
        try { storage?.close(); } catch { /* already closed */ }
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('keeps the corrupt file, starts a working database, and tells the host where the old one is', async () => {
        const dbDir = path.join(tempDir, '.dbmn');
        await fs.promises.mkdir(dbDir, { recursive: true });
        await fs.promises.writeFile(path.join(dbDir, 'executions.db'), Buffer.from('SQLite format 3\0 this is not a database'));

        const notices: Array<{ corruptPath: string; cause: unknown }> = [];
        storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir, {
            notifyCorruptionRecovered: (corruptPath, cause) => notices.push({ corruptPath, cause })
        }));
        await storage.initialize();

        expect(notices).to.have.length(1);
        expect(path.dirname(notices[0].corruptPath)).to.equal(dbDir);
        expect(path.basename(notices[0].corruptPath)).to.match(/^executions\.db\.corrupted-\d+$/);
        expect(fs.existsSync(notices[0].corruptPath), 'corrupt file kept for forensics').to.equal(true);

        const id = await storage.createExecution({
            environment: 'DBMN Local', environmentId: 'env-local', organization: '', endpointId: 'endpoint-1',
            endpointName: 'After recovery', endpointMethod: 'POST', endpointPath: '/inventory',
            executionType: 'individual', rows: '1', status: 'completed', createdAt: new Date()
        } as Omit<ExecutionMetadata, 'id'>);
        expect((await storage.getExecution(id))?.endpointName).to.equal('After recovery');
    });

    it('a notifier that throws never stops the database from opening', async () => {
        const dbDir = path.join(tempDir, '.dbmn');
        await fs.promises.mkdir(dbDir, { recursive: true });
        await fs.promises.writeFile(path.join(dbDir, 'executions.db'), Buffer.from('garbage'));

        storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir, {
            notifyCorruptionRecovered: () => { throw new Error('no UI here'); }
        }));
        await storage.initialize();
        expect(await storage.getExecutions()).to.deep.equal([]);
    });
});
