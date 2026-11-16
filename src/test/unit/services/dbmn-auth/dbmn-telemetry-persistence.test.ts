// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as sinon from 'sinon';
import { DbmnTelemetryService, FLUSH_DEBOUNCE_MS, FLUSH_INTERVAL_MS } from '../../../../services/dbmn-auth/dbmn-telemetry.service';
import { dbmnStorageKeys } from '../../../../services/dbmn-backend/backend-config';
import { DbmnTelemetryEntry } from '../../../../types/dbmn-auth';

/**
 * A run must reach Weekly Usage even when the window is reloaded seconds later
 * (the dev loop: build, reload). The buffer is mirrored to globalState on every
 * record, restored on the next activation, and a flush follows a record after a
 * short quiet period instead of waiting for the 5-minute timer.
 */
describe('DbmnTelemetryService persistence and prompt flush', () => {
    let clock: sinon.SinonFakeTimers;
    let store: Map<string, unknown>;
    let context: any;
    let fetchStub: sinon.SinonStub;
    let authService: any;
    const key = () => dbmnStorageKeys().telemetryPending;

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: new Date('2026-09-23T11:20:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        store = new Map();
        context = {
            globalState: {
                get: (k: string) => store.get(k),
                update: (k: string, v: unknown) => { if (v === undefined) { store.delete(k); } else { store.set(k, v); } return Promise.resolve(); }
            }
        };
        fetchStub = sinon.stub(globalThis, 'fetch' as any).resolves({ ok: true, status: 204 } as any);
        authService = {
            ensureValidSession: sinon.stub().resolves({ status: 'success', session: { accessToken: 'token' } }),
            getLicenseStatus: sinon.stub().resolves({ tier: 'free' })
        };
    });

    afterEach(() => {
        fetchStub.restore();
        clock.restore();
    });

    const pending = (): DbmnTelemetryEntry[] | undefined => store.get(key()) as DbmnTelemetryEntry[] | undefined;
    const sentEntries = (call = 0): any[] => JSON.parse(fetchStub.getCall(call).args[1].body).p_events;

    it('mirrors every record to globalState so a reload cannot lose it', async () => {
        const service = new DbmnTelemetryService(context);
        service.recordBatchRun(200, 196, 4);
        service.recordApiCall();
        await Promise.resolve();

        const entries = pending();
        expect(entries).to.have.length(1);
        expect(entries![0].batchRuns).to.equal(1);
        expect(entries![0].batchRecords).to.equal(200);
        expect(entries![0].apiCalls).to.equal(1);
        expect(entries![0].eventDate).to.equal('2026-09-23');
        service.dispose();
    });

    it('flushes a run a few seconds after it is recorded, not five minutes later', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        service.recordBatchRun(200, 200, 0);

        await clock.tickAsync(FLUSH_DEBOUNCE_MS - 1);
        expect(fetchStub.called).to.equal(false);
        await clock.tickAsync(1);
        expect(fetchStub.calledOnce).to.equal(true);
        expect(FLUSH_DEBOUNCE_MS).to.be.lessThan(FLUSH_INTERVAL_MS);

        const sent = sentEntries();
        expect(sent).to.have.length(1);
        expect(sent[0].batch_runs).to.equal(1);
        expect(sent[0].batch_records).to.equal(200);
        expect(pending()).to.equal(undefined);
        service.dispose();
    });

    it('sends what a previous session left unsent, once the auth service is available', async () => {
        const first = new DbmnTelemetryService(context);
        first.recordBatchRun(12, 12, 0);
        first.recordExecutionTime(1500);
        await Promise.resolve();
        // Window reloaded before the debounce fired: no auth service was ever set, nothing sent.
        expect(fetchStub.called).to.equal(false);

        const second = new DbmnTelemetryService(context);
        second.setAuthService(authService);
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);

        expect(fetchStub.calledOnce).to.equal(true);
        const sent = sentEntries();
        expect(sent).to.have.length(1);
        expect(sent[0].batch_runs).to.equal(1);
        expect(sent[0].batch_records).to.equal(12);
        expect(sent[0].execution_time_ms).to.equal(1500);
        expect(pending()).to.equal(undefined);
        first.dispose();
        second.dispose();
    });

    it('keeps entries persisted when the flush fails', async () => {
        fetchStub.resolves({ ok: false, status: 500 } as any);
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        service.recordBatchRun(5, 5, 0);
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);

        expect(fetchStub.calledOnce).to.equal(true);
        const entries = pending();
        expect(entries).to.have.length(1);
        expect(entries![0].batchRecords).to.equal(5);
        service.dispose();
    });

    it('reports local counters the server has not confirmed yet, and moves on every record', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        let changes = 0;
        const sub = service.onDidChange(() => { changes++; });

        service.recordApiCall();
        service.recordApiCall();
        expect(changes).to.equal(2);
        let local = service.getUnsyncedStats();
        expect(local.weekly.apiCalls).to.equal(2);
        expect(local.alltime.apiCalls).to.equal(2);

        // Flushed, but the Account view has not refetched server stats: still counted locally.
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);
        expect(fetchStub.calledOnce).to.equal(true);
        expect(changes).to.equal(3);
        local = service.getUnsyncedStats();
        expect(local.weekly.apiCalls).to.equal(2);

        // Fresh server stats arrived: the flushed part is theirs now, only new records stay local.
        service.markStatsSynced();
        expect(service.getUnsyncedStats().weekly.apiCalls).to.equal(0);
        service.recordBatchRun(30, 30, 0);
        local = service.getUnsyncedStats();
        expect(local.weekly.batchRuns).to.equal(1);
        expect(local.weekly.rowsProcessed).to.equal(30);

        sub.dispose();
        service.recordApiCall();
        expect(changes).to.equal(4);
        service.dispose();
    });

    it('counts a restored entry from last week in all-time but not this week', async () => {
        // Clock is Wednesday 2026-09-23; Monday is 2026-09-21.
        store.set(key(), [
            { environmentBaseUrl: 'http://127.0.0.1', eventDate: '2026-09-20', apiCalls: 7, batchRuns: 1, batchRecords: 7, batchSuccesses: 7, batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 100, featuresUsed: {} },
            { environmentBaseUrl: 'http://127.0.0.1', eventDate: '2026-09-21', apiCalls: 3, batchRuns: 0, batchRecords: 0, batchSuccesses: 0, batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 50, featuresUsed: {} }
        ]);
        const service = new DbmnTelemetryService(context);
        const local = service.getUnsyncedStats();
        expect(local.alltime.apiCalls).to.equal(10);
        expect(local.weekly.apiCalls).to.equal(3);
        expect(local.weekly.batchRuns).to.equal(0);
        service.dispose();
    });

    it('0.4.0: rows an older version left per environment go as one row for the day, without the address', async () => {
        store.set(key(), [
            { environmentBaseUrl: 'https://tenant-a.example.com', eventDate: '2026-09-23', apiCalls: 2, batchRuns: 1, batchRecords: 2, batchSuccesses: 2, batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 10, featuresUsed: {} },
            { environmentBaseUrl: 'https://tenant-b.example.com', eventDate: '2026-09-23', apiCalls: 3, batchRuns: 0, batchRecords: 0, batchSuccesses: 0, batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 5, featuresUsed: {} }
        ]);
        store.set(dbmnStorageKeys().telemetryEndpointPending, [{ environmentBaseUrl: 'https://tenant-a.example.com', eventDate: '2026-09-23', method: 'GET', pathTemplate: '/items', calls: 1, failures: 0, executionTimeMs: 1 }]);
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);

        expect(fetchStub.calledOnce, 'one upload: the per-endpoint rows are not sent').to.equal(true);
        expect(fetchStub.getCall(0).args[0]).to.match(/upsert_telemetry_events$/);
        const sent = sentEntries();
        expect(sent).to.have.length(1);
        expect(sent[0].api_calls).to.equal(5);
        expect(JSON.stringify(sent)).to.not.include('example.com');
        expect(store.get(dbmnStorageKeys().telemetryEndpointPending)).to.equal(undefined);
        service.dispose();
    });

    it('lets a running batch add rows, outcomes and time member by member', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        service.recordBatchProgress({ batchRuns: 1, rows: 100, successes: 1, durationMs: 400.4 });
        service.recordBatchProgress({ rows: 100, failures: 1, durationMs: 350 });
        const local = service.getUnsyncedStats();
        expect(local.weekly.batchRuns).to.equal(1);
        expect(local.weekly.rowsProcessed).to.equal(200);
        expect(local.weekly.totalExecutionTimeMs).to.equal(750);

        await clock.tickAsync(FLUSH_DEBOUNCE_MS);
        const sent = sentEntries()[0];
        expect(sent.batch_runs).to.equal(1);
        expect(sent.batch_records).to.equal(200);
        expect(sent.batch_successes).to.equal(1);
        expect(sent.batch_failures).to.equal(1);
        expect(sent.execution_time_ms).to.equal(750);
        service.dispose();
    });

    it('one row per day, whatever was run against: totals only', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        service.recordApiCall();
        service.recordBatchRun(10, 9, 1);
        service.recordFeatureUsage('puppy_school_opened');
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);

        const sent = sentEntries();
        expect(sent).to.have.length(1);
        expect(sent[0]).to.not.have.property('environment_base_url');
        expect(sent[0]).to.include({ event_date: '2026-09-23', api_calls: 1, batch_runs: 1, batch_records: 10, batch_successes: 9, batch_failures: 1 });
        expect(sent[0].features_used).to.deep.equal({ puppy_school_opened: true });
        service.dispose();
    });

    for (const status of ['auth_error', 'network_error'] as const) {
        it(`keeps what is waiting, and sends nothing, when the session can't be refreshed (${status})`, async () => {
            authService.ensureValidSession = sinon.stub().resolves({ status });
            const service = new DbmnTelemetryService(context);
            service.setAuthService(authService);
            service.recordApiCall();
            await clock.tickAsync(FLUSH_DEBOUNCE_MS);
            expect(fetchStub.called).to.equal(false);
            expect(pending()).to.have.length(1);
            service.dispose();
        });
    }

    it('coalesces a burst of records into one flush', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        for (let i = 0; i < 50; i++) {
            service.recordApiCall();
        }
        service.recordBatchRun(50, 50, 0);
        await clock.tickAsync(FLUSH_DEBOUNCE_MS);

        expect(fetchStub.calledOnce).to.equal(true);
        expect(sentEntries()[0].api_calls).to.equal(50);
        service.dispose();
    });
});

describe('#419 the telemetry switch', () => {
    let clock: sinon.SinonFakeTimers;
    let store: Map<string, unknown>;
    let context: any;
    let fetchStub: sinon.SinonStub;
    const authService = {
        ensureValidSession: sinon.stub().resolves({ status: 'success', session: { accessToken: 'token' } }),
        getLicenseStatus: sinon.stub().resolves({ tier: 'free' })
    } as any;
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: new Date('2026-10-29T11:20:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        store = new Map();
        context = { globalState: { get: (k: string) => store.get(k), update: (k: string, v: unknown) => { if (v === undefined) store.delete(k); else store.set(k, v); return Promise.resolve(); } } };
        fetchStub = sinon.stub(globalThis, 'fetch' as any).resolves({ ok: true, status: 204 } as any);
    });
    afterEach(() => { fetchStub.restore(); clock.restore(); });

    it('off: nothing is recorded, nothing is sent, and nothing left waiting from before survives', async () => {
        store.set(dbmnStorageKeys().telemetryPending, [{ environmentBaseUrl: 'http://127.0.0.1', eventDate: '2026-10-28', apiCalls: 3, batchRuns: 0, batchRecords: 0, batchSuccesses: 0, batchFailures: 0, exportRecords: 0, importRecords: 0, executionTimeMs: 0, featuresUsed: {} }]);
        const service = new DbmnTelemetryService(context, { enabled: () => false });
        service.setAuthService(authService);
        service.recordApiCall();
        service.recordBatchRun(10, 10, 0);
        await Promise.resolve();
        expect(store.get(dbmnStorageKeys().telemetryPending), 'the old pending rows are dropped').to.equal(undefined);
        await clock.tickAsync(FLUSH_INTERVAL_MS + FLUSH_DEBOUNCE_MS);
        expect(fetchStub.called).to.equal(false);
        expect(service.getUnsyncedStats().weekly.apiCalls).to.equal(0);
    });

    it('turned off later: the next flush drops what was waiting instead of sending it', async () => {
        let on = true;
        const service = new DbmnTelemetryService(context, { enabled: () => on });
        service.setAuthService(authService);
        service.recordApiCall();
        await Promise.resolve();
        expect(store.get(dbmnStorageKeys().telemetryPending)).to.have.length(1);
        on = false;
        await service.flush();
        expect(fetchStub.called).to.equal(false);
        expect(store.get(dbmnStorageKeys().telemetryPending)).to.equal(undefined);
    });

    it('VS Code\'s own telemetry setting off: DBMN sends nothing either', async () => {
        const vscodeApi = require('vscode') as { env?: { isTelemetryEnabled?: boolean } };
        const before = vscodeApi.env;
        vscodeApi.env = { isTelemetryEnabled: false };
        try {
            const service = new DbmnTelemetryService(context);
            service.setAuthService(authService);
            service.recordApiCall();
            await clock.tickAsync(FLUSH_INTERVAL_MS + FLUSH_DEBOUNCE_MS);
            expect(fetchStub.called).to.equal(false);
            expect(service.getUnsyncedStats().weekly.apiCalls).to.equal(0);
            service.dispose();
        } finally {
            vscodeApi.env = before;
        }
    });

    it('on (the default): the usual flush', async () => {
        const service = new DbmnTelemetryService(context);
        service.setAuthService(authService);
        service.recordApiCall();
        await clock.tickAsync(FLUSH_DEBOUNCE_MS + 1);
        expect(fetchStub.called).to.equal(true);
    });
});
