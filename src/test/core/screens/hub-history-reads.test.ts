// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Public issue 1: while a batch runs, the Hub re-read the whole run history up to four times a second. Each request of
 * the batch (a batch_member row) fired onExecutionChanged; the Hub rebuilt its whole state at most every 250 ms, and
 * the run list's cache (DatabaseAdapter.runList) was read again because its stamp, SQLite's change count, moves with
 * every row, a batch's requests included. History shows runs, never a batch's requests: only a run's own row matters.
 * Real storage, a real history, the Hub's own timer.
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
import { APIEndpointManager } from '../../../apiEndpointManager';
import { EnvironmentManager } from '../../../environmentManager';
import { SystemManager } from '../../../systemManager';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { HubPreferencesService } from '../../../services/hub-preferences/hub-preferences.service';
import { RecentEndpointsService } from '../../../services/recent-endpoints/recent-endpoints.service';
import { HubController } from '../../../screens/hub/hub.controller';
import { HubPorts } from '../../../screens/hub/hub.ports';
import { ScreenSession } from '../../../screens/screen-session';

const HISTORY = 3000;
const REQUESTS = 300;

describe('Public issue 1: the Hub during a batch reads the run history once, not four times a second', function () {
    this.timeout(60_000);
    let tempDir: string;
    let storage: SqlJsExecutionStorage;

    const row = (type: 'individual' | 'batch' | 'batch_member', extra: Partial<ExecutionMetadata> = {}): Omit<ExecutionMetadata, 'id'> => ({
        environment: 'DBMN Local', environmentId: 'env-local', organization: '',
        endpointId: 'endpoint-1', endpointName: 'Stock', endpointMethod: 'POST', endpointPath: '/stock',
        executionType: type, rows: '1', status: 'completed', createdAt: new Date(), ...extra
    });

    beforeEach(async () => { tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dbmn-hub-reads-')); });
    afterEach(async () => {
        try { storage.close(); } catch { /* closed */ }
        sinon.restore();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it(`${REQUESTS} requests of a batch on a history of ${HISTORY.toLocaleString()} runs: one read at most, and the batch's own changes still shown`, async () => {
        storage = new SqlJsExecutionStorage(tempStorageOptions(tempDir));
        const adapter = new DatabaseAdapter(storage);
        await adapter.initialize();
        const metadata = new ExecutionMetadataService({ executionMetadataManager: adapter, dobermannInstance: {} } as never, createMockLogger());
        await storage.createExecutionBatch(Array.from({ length: HISTORY }, () => row('individual')));
        const batchId = await storage.createExecution(row('batch', { status: 'running', rows: `${REQUESTS}(${REQUESTS + 1})` }));
        const members = await storage.createExecutionBatch(Array.from({ length: REQUESTS }, () => row('batch_member', { batchId, status: 'pending' })));

        const context = memoryStoreContext();
        const posted: Array<Record<string, unknown>> = [];
        const ports = {
            endpoints: new APIEndpointManager(context), environments: new EnvironmentManager(context), systems: new SystemManager(context),
            recent: new RecentEndpointsService(new MemoryKeyValueStore()), preferences: new HubPreferencesService(new MemoryKeyValueStore()),
            settings: { get: <T>(_s: string, _k: string, d: T) => d, update: async () => undefined },
            auth: { isSignedIn: () => true, promptSignIn: async () => undefined },
            confirmDestructive: async () => true,
            toast: { info: () => undefined, warn: () => undefined, error: () => undefined },
            tabs: {}, runApi: async () => undefined,
            executions: { metadata }
        } as unknown as HubPorts;
        const controller = new HubController(new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined }), ports);
        await controller.handle({ type: 'ready' });

        const t0 = Date.now();
        await storage.getAllTransactions();
        const oneReadMs = Date.now() - t0;
        const batchBefore = await storage.getExecution(batchId);
        const reads = sinon.spy(storage, 'getAllTransactions');
        const states = () => posted.filter(m => m.type === 'hubState').length;
        const statesBefore = states();
        const started = Date.now();
        for (const id of members) {
            await metadata.updateExecution(id, { status: 'completed', completedAt: new Date() });
            await new Promise(resolve => setTimeout(resolve, 4));      // a request every few ms, as a fast batch sends them
        }
        await new Promise(resolve => setTimeout(resolve, 400));          // the Hub's last refresh, if any
        const tookMs = Date.now() - started;
        const readsDuring = reads.callCount;
        const statesDuring = states() - statesBefore;
        console.log(`      [issue 1] ${REQUESTS} requests over ${tookMs} ms on ${HISTORY} runs: ${readsDuring} full reads of the history (${oneReadMs} ms each), ${statesDuring} hubState posts`);
        // What the Hub could draw from its state for a running batch is its own row (History, the activity chip and the
        // rail list runs; a batch's bar and its tab's "n/total" come from the Console's progress, setTabStatus): a
        // request never writes it, so nothing the Hub's state carries ticks with a request, then or now
        expect(await storage.getExecution(batchId), 'the batch\'s own row, unchanged by its requests').to.deep.equal(batchBefore);
        expect(readsDuring, 'full reads of the history while the batch\'s requests ran').to.be.at.most(1);
        expect(statesDuring, 'whole Hub states posted while only the batch\'s requests changed').to.be.at.most(1);

        // The batch's own row still shows: it finishes, History says so
        await metadata.updateExecution(batchId, { status: 'completed', completedAt: new Date() });
        await new Promise(resolve => setTimeout(resolve, 400));
        const last = posted.filter(m => m.type === 'hubState').pop() as { transactions: Array<{ id: string; status: string }> };
        expect(last.transactions.find(t => t.id === batchId)?.status, 'the batch finishing is in History').to.equal('completed');
    });
});
