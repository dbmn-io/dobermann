// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: a batch in an environment that runs in DBMN for VS Code waits, queued, until VS Code is
 * there (the engine's `readiness`), and says what it waits for; a cancel or a declined sign-in
 * ends it unstarted.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { BatchExecutionEngine } from '../../../services/execution/batch-execution-engine.service';
import { BatchExecutionEngineDependencies } from '../../../services/execution/batch-execution-engine.interface';
import { createMockLogger } from '../../helpers/logging/mock-logger';

type Readiness = NonNullable<BatchExecutionEngineDependencies['readiness']>;
interface Internals {
    waitUntilReady(batchId: string, environmentId: string | undefined, progress?: { report(p: unknown): void }, token?: { isCancellationRequested: boolean }): Promise<boolean>;
    sendStatusUpdateToReport(batchId: string, status: string): Promise<void>;
    pauseBatch(batchId: string, reason: string): Promise<void>;
}

function engine(readiness?: Readiness) {
    const deps = { executionMetadataService: {}, executionService: {}, readiness } as unknown as BatchExecutionEngineDependencies;
    const internals = new BatchExecutionEngine(deps, createMockLogger()) as unknown as Internals;
    const statuses = stub(internals, 'sendStatusUpdateToReport').resolves();
    const pause = stub(internals, 'pauseBatch').resolves();
    return { internals, statuses, pause };
}

describe('Batch waits until what it runs on is there (#344)', function () {
    this.timeout(10_000);

    it('ready (or no readiness at all, as in VS Code): starts at once', async () => {
        expect(await engine().internals.waitUntilReady('b1', 'env-1')).to.equal(true);
        expect(await engine(async () => undefined).internals.waitUntilReady('b1', 'env-1')).to.equal(true);
    });

    it('not yet: waits, queued, saying what for; starts when it comes', async () => {
        let calls = 0;
        const { internals, statuses } = engine(async () => (++calls < 3 ? { waitingFor: 'DBMN for VS Code' } : undefined));
        const reported: unknown[] = [];
        expect(await internals.waitUntilReady('b1', 'env-1', { report: p => reported.push(p) })).to.equal(true);
        expect(reported[0]).to.deep.include({ status: 'pending', queued: true, waitingFor: 'DBMN for VS Code' });
        expect(statuses.calledWith('b1', 'pending'), 'the Console hears it\'s starting').to.equal(true);
    });

    it('a sign-in that didn\'t happen once it came: not run, paused with the reason (Resume later)', async () => {
        const { internals, pause } = engine(async () => ({ stop: 'not signed in' }));
        expect(await internals.waitUntilReady('b1', 'env-1')).to.equal(false);
        expect(pause.calledWith('b1', 'not signed in')).to.equal(true);
    });

    it('Cancel while waiting: ends the wait, never starts', async () => {
        const token = { isCancellationRequested: false };
        const { internals } = engine(async () => { token.isCancellationRequested = true; return { waitingFor: 'DBMN for VS Code' }; });
        expect(await internals.waitUntilReady('b1', 'env-1', undefined, token)).to.equal(false);
    });
});
