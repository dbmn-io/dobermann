// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #321: the batch engine loads and runs with no VS Code and no `global` services. What it
 * used to read from `vscode.workspace.getConfiguration` and `global.dbmn*Service` is injected.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { BatchExecutionEngine } from '../../../services/execution/batch-execution-engine.service';
import { BatchExecutionEngineDependencies } from '../../../services/execution/batch-execution-engine.interface';
import { IDbmnAuthService } from '../../../services/dbmn-auth/dbmn-auth.interface';
import { MemoryConfiguration } from '../../../platform/memory/memory-configuration';
import { RecordingProgressSink } from '../../../platform/memory/recording-progress-sink';
import { createMockLogger } from '../../helpers/logging/mock-logger';

interface EngineInternals {
    isCriticalError(memberResult: { httpStatus?: number; errorMessage?: string }): boolean;
    executeRetryDirect(batchId: string, memberIds: string[]): Promise<void>;
    sendMemberResultToReport(...args: unknown[]): Promise<void>;
}

function engineWith(extra: Partial<BatchExecutionEngineDependencies> = {}) {
    const executeRecord = stub().resolves({ success: true, httpStatus: 200 });
    const deps = {
        executionMetadataService: {
            getExecution: stub().resolves({ id: 'batch-1', executionType: 'batch', environmentId: 'env-1' }),
            getBatchMemberExecutions: stub().resolves([{ id: 'm-1' }, { id: 'm-2' }]),
            updateExecution: stub().resolves()
        },
        executionService: { executeRecord, cancel: stub(), cleanupExecutionMemory: stub() },
        ...extra
    } as unknown as BatchExecutionEngineDependencies;
    const engine = new BatchExecutionEngine(deps, createMockLogger());
    const internals = engine as unknown as EngineInternals;
    stub(internals, 'sendMemberResultToReport').resolves();
    return { internals, executeRecord };
}

describe('BatchExecutionEngine host dependencies (Issue #321)', () => {
    describe('critical errors come from the injected settings', () => {
        it('defaults to 401/403 and network errors when no settings are injected', () => {
            const { internals } = engineWith();
            expect(internals.isCriticalError({ httpStatus: 401 })).to.equal(true);
            expect(internals.isCriticalError({ httpStatus: 500 })).to.equal(false);
            expect(internals.isCriticalError({ errorMessage: 'connection refused' })).to.equal(true);
        });

        it('uses dbmn.execution.criticalErrorCodes and treatNetworkErrorsAsCritical when set', () => {
            const { internals } = engineWith({
                configuration: new MemoryConfiguration({
                    'dbmn.execution.criticalErrorCodes': [500],
                    'dbmn.execution.treatNetworkErrorsAsCritical': false
                })
            });
            expect(internals.isCriticalError({ httpStatus: 500 })).to.equal(true);
            expect(internals.isCriticalError({ httpStatus: 401 })).to.equal(false);
            expect(internals.isCriticalError({ errorMessage: 'connection refused' })).to.equal(false);
        });
    });

    describe('a direct retry checks the DBMN session through the injected auth', () => {
        it('expired session: asks to sign in again and runs nothing', async () => {
            const auth = { ensureValidSession: stub().resolves({ status: 'expired' }) } as unknown as IDbmnAuthService;
            const promptDbmnAuthExpired = stub().resolves(false);
            const { internals, executeRecord } = engineWith({ dbmnAuth: () => auth, promptDbmnAuthExpired });

            await internals.executeRetryDirect('batch-1', ['m-1']);

            expect(promptDbmnAuthExpired.calledOnceWith(auth)).to.equal(true);
            expect(executeRecord.called).to.equal(false);
        });

        it('valid session: runs each member and tells the Console it is running', async () => {
            const auth = { ensureValidSession: stub().resolves({ status: 'success' }) } as unknown as IDbmnAuthService;
            const progressSink = new RecordingProgressSink();
            const { internals, executeRecord } = engineWith({ dbmnAuth: () => auth, progressSink });

            await internals.executeRetryDirect('batch-1', ['m-1', 'm-2']);

            expect(executeRecord.callCount).to.equal(2);
            expect(progressSink.of('memberStatus').map(e => [e.executionIds, e.status])).to.deep.equal([
                [['m-1'], 'running'],
                [['m-2'], 'running']
            ]);
        });

        it('no auth service wired (signed-out surfaces, tests): runs without a session check', async () => {
            const { internals, executeRecord } = engineWith();
            await internals.executeRetryDirect('batch-1', ['m-1']);
            expect(executeRecord.calledOnce).to.equal(true);
        });
    });
});
