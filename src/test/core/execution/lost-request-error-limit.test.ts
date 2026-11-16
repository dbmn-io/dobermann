// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #344: a request lost when DBMN for VS Code closed counts towards the batch's error limit like any
 * other error. It may have half-happened, which is what "stop at the first error" is for. A batch
 * with no limit (or room under it) carries on, and waits for VS Code before the next request.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { BatchExecutionEngine } from '../../../services/execution/batch-execution-engine.service';
import { BatchExecutionEngineDependencies } from '../../../services/execution/batch-execution-engine.interface';
import { AGENT_LOST } from '../../../services/agent/local-agent';
import { createMockLogger } from '../../helpers/logging/mock-logger';

interface ToleranceConfig { mode: 'absolute' | 'percentage'; limit: number }
interface State {
    batchId: string; status: string; totalMembers: number; completedMembers: number; successfulMembers: number;
    failedMembers: number; totalExecutionDuration: number; toleranceConfig?: ToleranceConfig;
}
interface Internals {
    batchStates: Map<string, State>;
    sendStatusUpdateToReport(batchId: string, status: string, errorMessage?: string): Promise<void>;
    executeSingleMember(batchId: string, batchState: State, batchMetadata: object, member: { id: string }, progressCallback: undefined,
        token: undefined, activeExecutions: Map<string, Promise<void>>, memberIndex: number): Promise<void>;
}
const QUIET = ['logBatchEvent', 'broadcastBatchEvent', 'updateBatchMetadata', 'updateBatchStatusBar', 'sendMemberResultToReport',
    'recordMemberTelemetry', 'trackCompletion'] as const;

async function runLostRequest(toleranceConfig?: ToleranceConfig, inFlight = 1) {
    const executeRecord = stub().resolves({ success: false, executionId: 'm2', duration: 5, errorMessage: AGENT_LOST });
    const deps = { executionMetadataService: {}, executionService: { executeRecord } } as unknown as BatchExecutionEngineDependencies;
    const engine = new BatchExecutionEngine(deps, createMockLogger()) as unknown as Internals;
    const quiet = engine as unknown as Record<string, () => unknown>;
    for (const name of QUIET) stub(quiet, name).resolves();
    stub(quiet, 'closeRunSession').returns(0);
    const statuses = stub(engine, 'sendStatusUpdateToReport').resolves();
    const state: State = {
        batchId: 'b1', status: 'running', totalMembers: 10, completedMembers: 1, successfulMembers: 1,
        failedMembers: 0, totalExecutionDuration: 0, toleranceConfig
    };
    engine.batchStates.set('b1', state);
    await Promise.all(Array.from({ length: inFlight }, (_, i) =>
        engine.executeSingleMember('b1', state, { environmentId: 'env-1' }, { id: `m${i + 2}` }, undefined, undefined, new Map(), i + 2)));
    return { state, statuses };
}

describe('A request lost when VS Code closed counts towards the error limit (#344)', () => {
    it('"stop at the first error": the batch stops, saying VS Code stopped answering and to check the row', async () => {
        const { state, statuses } = await runLostRequest({ mode: 'absolute', limit: 0 });
        expect(state.status).to.equal('stopped');
        expect(state.failedMembers).to.equal(1);
        const stopped = statuses.getCalls().find(c => c.args[1] === 'stopped');
        expect(stopped?.args[2]).to.equal(`Batch stopped: Transaction 2 failed - ${AGENT_LOST}`);
    });

    it('no error limit: the row is an error and the batch carries on (it waits for VS Code next)', async () => {
        const { state, statuses } = await runLostRequest(undefined);
        expect(state.status).to.equal('running');
        expect(state.failedMembers).to.equal(1);
        expect(statuses.getCalls().some(c => c.args[1] === 'stopped')).to.equal(false);
    });

    it('several requests lost together (one per thread): one stop, one message; every row is an error', async () => {
        const { state, statuses } = await runLostRequest({ mode: 'absolute', limit: 0 }, 4);
        expect(state.status).to.equal('stopped');
        expect(state.failedMembers).to.equal(4);
        expect(statuses.getCalls().filter(c => c.args[1] === 'stopped')).to.have.length(1);
    });
});
