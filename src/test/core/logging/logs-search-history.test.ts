// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7, James 2026-11-19: "when I do a search in the logs and then I hit delete…
 * everything freezes. We can't have that." `@level=warn` with a character deleted is `@level=war`,
 * which no line matches, so the search reads every batch's requests in the run history. Read
 * whole (a full record each, 2,000 at once), each batch held the page for ~50–140 ms, one after
 * another for seconds: in the web and desktop apps the search shares the page's thread.
 *
 * Here, over a real run history (sql.js): no batch is read whole, the page is never held for
 * long, and a key stops the search at once.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { tempStorageOptions } from '../fixtures/temp-storage';
import { LogReader } from '../../../services/logging/log-reader';
import { runHistory } from '../../../screens/logs/run-history';
import { LogsController } from '../../../screens/logs/logs.controller';
import { ScreenSession } from '../../../screens/screen-session';

describe('Logs search over a big run history never freezes the page', function () {
    this.timeout(120_000);
    const BATCHES = 8;
    const REQUESTS = 4_000;
    let dir: string;
    let storage: SqlJsExecutionStorage;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-'));
        storage = new SqlJsExecutionStorage(tempStorageOptions(dir));
        await storage.initialize();
        const base = { environment: 'Test', endpointId: 'e1', endpointName: 'Create Item', endpointMethod: 'POST', endpointPath: '/items' };
        const t0 = Date.now() - BATCHES * 3_600_000;
        for (let b = 0; b < BATCHES; b++) {
            const start = new Date(t0 + b * 3_600_000);
            const id = await storage.createExecution({ ...base, executionType: 'batch', rows: String(REQUESTS), status: 'completed', startedAt: start, completedAt: new Date(start.getTime() + 600_000), createdAt: start } as Omit<ExecutionMetadata, 'id'>);
            await storage.createExecutionBatch(Array.from({ length: REQUESTS }, (_, i) => ({
                ...base, executionType: 'batch_member', batchId: id, rows: String(i + 1), status: i % 50 ? 'completed' : 'error',
                httpStatus: i % 50 ? 201 : 400, httpStatusText: i % 50 ? 'Created' : 'Bad Request', errorMessage: i % 50 ? undefined : 'itemId must not be empty',
                startedAt: new Date(start.getTime() + i * 100), completedAt: new Date(start.getTime() + i * 100 + 50), createdAt: new Date(start.getTime() + i * 100)
            } as Omit<ExecutionMetadata, 'id'>)));
        }
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const metadata = () => ({
        getAllTransactions: () => storage.getAllTransactions(),
        getBatchMemberExecutions: (id: string) => storage.getBatchMemberExecutions(id),
        getBatchMemberLogRows: (id: string, offset: number, limit: number) => storage.getBatchMemberLogRows(id, offset, limit)
    });
    function screen() {
        const posted: Array<Record<string, unknown>> = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const controller = new LogsController(session, {
            reader: new LogReader(undefined, runHistory(metadata())), redact: t => t,
            files: { save: async () => true }, toast: { info: () => undefined, warn: () => undefined, error: () => undefined }
        });
        return { posted, controller };
    }

    it('reads a batch\'s requests a slice at a time, only what a line needs', async () => {
        const [batch] = await storage.getAllTransactions();
        const slice = await storage.getBatchMemberLogRows(batch.id, 501, 3);
        expect(slice.map(r => r.rows)).to.deep.equal(['502', '503', '504']);
        expect(slice[0]).to.include({ status: 'completed', environment: 'Test', endpointMethod: 'POST', endpointPath: '/items', httpStatus: 201, httpStatusText: 'Created' });
        expect(slice[0].completedAt).to.be.instanceOf(Date);
        expect(Object.keys(slice[0])).to.not.include('endpointConfig');
    });

    it('`@level=war` (warn, a character deleted): every batch is read, and the page is never held for long', async () => {
        const { posted, controller } = screen();
        let last = Date.now();
        let longest = 0;
        const probe = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 1);
        await controller.handleMessage({ type: 'logs.search', text: '@level=war' });
        clearInterval(probe);
        const answer = posted.find(m => m.type === 'logs.lines')!;
        expect(answer.lines).to.deep.equal([]);
        expect(answer.done).to.equal(true);
        // (read whole, one batch of these held it 150 ms or more; read in slices, under 30)
        expect(longest, 'the longest the page waited (ms)').to.be.lessThan(80);
    });

    it('a key while it is looking stops it at once', async () => {
        const { posted, controller } = screen();
        const looking = controller.handleMessage({ type: 'logs.search', text: '@level=war' });
        await new Promise(resolve => setTimeout(resolve, 20));
        const pressed = Date.now();
        await controller.handleMessage({ type: 'logs.typing' });
        await looking;
        expect(Date.now() - pressed, 'stopped within (ms)').to.be.lessThan(80);
        expect(posted.filter(m => m.type === 'logs.lines')).to.have.length(0);
    });
});
