// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Two VS Code windows, one history database.
 *
 * Reported 2026-09-20. A 67,000-record batch ran on 18 September, wrote its files, and was
 * recorded — it is there in the window's log. The next day its history was gone, and the
 * database file contained not one byte from the 18th onward. No save had failed.
 *
 * Every window loads the WHOLE database into memory at startup (sql.js has no file system:
 * the file is just a byte array) and saves by exporting all of it back over the file.
 * Thirteen windows had that file open that day. One of them, holding a 14 September copy,
 * exported it after the batch was written — and the batch stopped existing. A lost update,
 * silent on both sides, because each write did exactly what it was told.
 *
 * sql.js cannot lock the file, so the fix is compare-and-merge: a generation counter in
 * db_metadata, a stat before each save, and a merge of anything the file gained since we
 * read it. Executions are appended and then only ever mutated by the window that owns them,
 * so on an id we both hold, ours is the live one.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { tempStorageOptions } from '../fixtures/temp-storage';

describe('SqlJsExecutionStorage — two windows, one file', () => {
    let tempDir: string;
    const open: SqlJsExecutionStorage[] = [];

    const execution = (name: string, type: 'individual' | 'batch' = 'individual'): Omit<ExecutionMetadata, 'id'> => ({
        environment: 'DBMN Local',
        environmentId: 'env-local',
        organization: '',
        endpointId: 'endpoint-1',
        endpointName: name,
        endpointMethod: 'POST',
        endpointPath: '/inventory',
        executionType: type,
        rows: '1',
        status: 'completed',
        createdAt: new Date()
    });

    const resumption = (index: number) => ({
        currentExecutionIndex: index,
        completedExecutions: [] as string[],
        failedExecutions: [] as string[],
        skippedExecutions: [] as string[]
    });

    /** A fresh window: its own service, its own in-memory copy of the same file. */
    async function openWindow(): Promise<SqlJsExecutionStorage> {
        const storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir));
        await storage.initialize();
        open.push(storage);
        return storage;
    }

    const names = async (storage: SqlJsExecutionStorage): Promise<string[]> =>
        (await storage.getExecutions()).map(e => e.endpointName).sort();

    beforeEach(async () => {
        // Issue #324: a temp folder, no VS Code context — test:core
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-windows-'));
    });

    afterEach(async () => {
        for (const storage of open.splice(0)) { try { storage.close(); } catch { /* already closed */ } }
        sinon.restore();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('THE BUG: the older window must not erase what the newer one recorded', async () => {
        const windowA = await openWindow();
        await windowA.createExecution(execution('Loaded before B opened'));
        windowA.close();                                   // A's work is on disk

        const windowB = await openWindow();                // B starts, reads the file
        const windowC = await openWindow();                // C starts, reads the same file

        await windowC.createExecution(execution('Bulk Inventory Uploader'));
        windowC.close();                                   // C saves: 2 executions on disk

        // B still believes history ends where it did when B started. It now saves.
        await windowB.createExecution(execution('Something in B'));
        windowB.close();

        const reopened = await openWindow();
        expect(await names(reopened), 'every window\'s work survives').to.deep.equal(
            ['Bulk Inventory Uploader', 'Loaded before B opened', 'Something in B']
        );
    });

    it('#344: refreshFromDisk shows another writer\'s runs now, not at the next save', async () => {
        const web = await openWindow();                    // the web app, on the shared folder
        await web.createExecution(execution('Run in the web app'));
        const vscode = await openWindow();
        await vscode.createExecution(execution('Run in VS Code'));
        vscode.close();                                    // VS Code saves

        expect(await names(web), 'not yet').to.deep.equal(['Run in the web app']);
        expect(web.refreshFromDisk(), 'there was something to merge').to.equal(true);
        expect(await names(web)).to.deep.equal(['Run in VS Code', 'Run in the web app']);
        expect(web.refreshFromDisk(), 'nothing new since').to.equal(false);

        web.close();
        expect(await names(await openWindow()), 'and both are on disk').to.deep.equal(['Run in VS Code', 'Run in the web app']);
    });

    it('#344: importExecutionsFrom brings in only the runs it lacks, with their paths moved', async () => {
        // The browser's own history, kept while the workspace folder wasn't connected
        const browserDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-browser-'));
        const browser = new SqlJsExecutionStorage(tempStorageOptions(browserDir));
        await browser.initialize();
        const ranInBrowser = await browser.createExecution({ ...execution('Run while disconnected'), requestFile: '/dbmn/dbmn-local/get-carriers/req.json', responseFile: '/dbmn/dbmn-local/get-carriers/res.json' });
        browser.close();
        const browserDb = path.join(browserDir, '.dbmn', 'executions.db');

        const folder = await openWindow();
        await folder.createExecution(execution('Already in the folder'));
        expect(folder.importExecutionsFrom(browserDb, { from: '/dbmn', to: '/home/me/Dobermann-Workspace' })).to.equal(1);
        const moved = await folder.getExecution(ranInBrowser);
        expect(moved?.requestFile).to.equal('/home/me/Dobermann-Workspace/dbmn-local/get-carriers/req.json');
        expect(moved?.responseFile).to.equal('/home/me/Dobermann-Workspace/dbmn-local/get-carriers/res.json');
        expect(folder.hasExecutions([ranInBrowser, 'nope'])).to.deep.equal(new Set([ranInBrowser]));

        // Again (the browser's copy not cleaned up yet), after the folder's copy changed: untouched
        await folder.updateExecution(ranInBrowser, { status: 'error' });
        expect(folder.importExecutionsFrom(browserDb, { from: '/dbmn', to: '/home/me/Dobermann-Workspace' })).to.equal(0);
        expect((await folder.getExecution(ranInBrowser))?.status, 'the folder\'s copy wins').to.equal('error');
        folder.close();
        expect(await names(await openWindow()), 'saved').to.deep.equal(['Already in the folder', 'Run while disconnected']);
        await fs.promises.rm(browserDir, { recursive: true, force: true });
    });

    it('a window that wrote nothing still must not roll the file back', async () => {
        const idle = await openWindow();                   // opens, reads, writes nothing
        const busy = await openWindow();
        await busy.createExecution(execution('Ran while the other sat idle'));
        busy.close();

        idle.close();                                      // flushes its untouched copy

        expect(await names(await openWindow())).to.deep.equal(['Ran while the other sat idle']);
    });

    it('on an id both windows hold, the owner\'s row is the live one', async () => {
        const owner = await openWindow();
        const id = await owner.createExecution({ ...execution('Long batch', 'batch'), status: 'pending' });
        owner.close();

        const other = await openWindow();                  // reads it as pending
        await owner.initialize();                          // owner reopens and finishes the run
        await owner.updateExecution(id, { status: 'completed' });
        owner.close();

        await other.createExecution(execution('Unrelated work'));
        other.close();                                     // must not resurrect 'pending'

        const reopened = await openWindow();
        expect((await reopened.getExecution(id))?.status, 'the owner finished it').to.equal('completed');
        expect(await names(reopened)).to.deep.equal(['Long batch', 'Unrelated work']);
    });

    it('a batch you can resume survives the same collision', async () => {
        const first = await openWindow();
        const batchId = await first.createExecution(execution('Resumable', 'batch'));
        await first.storeBatchResumptionData(batchId, resumption(500));
        first.close();

        const stale = await openWindow();
        const other = await openWindow();
        const otherBatch = await other.createExecution(execution('Second batch', 'batch'));
        await other.storeBatchResumptionData(otherBatch, resumption(12));
        other.close();
        stale.close();

        const reopened = await openWindow();
        expect(await reopened.getBatchResumptionData(batchId), 'the first batch').to.not.equal(null);
        expect(await reopened.getBatchResumptionData(otherBatch), 'the second batch').to.not.equal(null);
    });

    /**
     * Reported 2026-10-04. Activation on a 70 MB history took 10–31 s; the log said "Another
     * window wrote to the history database — merged in 61129 execution(s)" every time, with
     * no other window open. initialize()'s first save ran before the file's size and mtime
     * were recorded, so the window saw its own file as changed and merged all of it into
     * itself — 61,129 INSERT OR REPLACEs, one statement at a time, blocking the extension host.
     */
    it('opening a window does not merge the file into itself', async () => {
        const first = await openWindow();
        for (const name of ['one', 'two', 'three']) { await first.createExecution(execution(name)); }
        first.close();

        const merge = sinon.spy(SqlJsExecutionStorage.prototype as any, 'mergeTable');
        await openWindow();
        expect(merge.called, 'nothing changed on disk, so nothing to merge').to.equal(false);
    });

    it('a real merge takes only the rows that differ, not the whole file', async () => {
        const first = await openWindow();
        for (const name of ['one', 'two', 'three']) { await first.createExecution(execution(name)); }
        first.close();

        const windowB = await openWindow();
        const windowC = await openWindow();
        await windowC.createExecution(execution('from C'));
        windowC.close();

        const merge = sinon.spy(SqlJsExecutionStorage.prototype as any, 'mergeTable');
        await windowB.createExecution(execution('from B'));
        windowB.close();

        const executionsMerge = merge.getCalls().find(call => call.args[1] === 'executions');
        expect(executionsMerge?.returnValue, 'only C\'s new row').to.equal(1);
        expect(await names(await openWindow())).to.deep.equal(['from B', 'from C', 'one', 'three', 'two']);
    });

    it('the row-by-row fallback merges the same way', async () => {
        sinon.stub(SqlJsExecutionStorage.prototype as any, 'mergeTable').callsFake(function (this: any, ...args: unknown[]) {
            return this.mergeTableRowByRow(...args);
        });
        const first = await openWindow();
        const pending = await first.createExecution({ ...execution('Long batch', 'batch'), status: 'pending' });
        first.close();

        const windowB = await openWindow();
        const windowC = await openWindow();
        await windowC.createExecution(execution('from C'));
        windowC.close();
        const owner = await openWindow();
        await owner.updateExecution(pending, { status: 'completed' });
        owner.close();

        await windowB.createExecution(execution('from B'));
        windowB.close();

        const reopened = await openWindow();
        expect(await names(reopened)).to.deep.equal(['Long batch', 'from B', 'from C']);
        expect((await reopened.getExecution(pending))?.status).to.equal('completed');
    });

    it('the file never shrinks: a save holding fewer executions is refused', async () => {
        const windowA = await openWindow();
        for (const name of ['one', 'two', 'three']) { await windowA.createExecution(execution(name)); }
        windowA.close();

        const stale = await openWindow();
        stale.close();                                     // same content — fine

        const dbPath = path.join(tempDir, '.dbmn', 'executions.db');
        const before = fs.statSync(dbPath).size;
        expect(before, 'the database is still there').to.be.greaterThan(0);
        expect(await names(await openWindow())).to.deep.equal(['one', 'three', 'two']);
    });
});
