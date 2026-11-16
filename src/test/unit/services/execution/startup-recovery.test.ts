// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #313: after VS Code closed with work in flight, the next activation pauses
 * what was running AND what was queued, cancels orphaned single requests, and says
 * so in one line — without asking the user anything during activation.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { StartupRecoveryService } from '../../../../services/execution/startup-recovery.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('StartupRecoveryService (Issue #313)', () => {
    const rows = () => [
        { id: 'B1', executionType: 'batch', status: 'running', endpointName: 'Bulk Inventory Uploader' },
        { id: 'B2', executionType: 'batch', status: 'pending', endpointName: 'Inventory' },     // queued behind B1
        { id: 'B3', executionType: 'batch', status: 'completed', endpointName: 'Orders' },
        { id: 'm1', executionType: 'batch_member', status: 'running', batchId: 'B1' },
        { id: 'm2', executionType: 'batch_member', status: 'pending', batchId: 'B1' },
        { id: 'i1', executionType: 'individual', status: 'running', endpointName: 'Ping' },
        { id: 'i2', executionType: 'individual', status: 'completed', endpointName: 'Ping' }
    ];

    function make(all = rows()) {
        const updateExecution = stub().resolves();
        const service = new StartupRecoveryService({ getAllTransactions: stub().resolves(all), updateExecution } as any, createMockLogger());
        return { service, updateExecution };
    }

    it('pauses the running batch and the queued batch, resets the running member, cancels the single request', async () => {
        const { service, updateExecution } = make();
        const summary = await service.recover();

        const updates = Object.fromEntries(updateExecution.getCalls().map(c => [c.args[0], c.args[1]]));
        expect(updates.B1.status).to.equal('paused');
        expect(updates.B2.status, 'the queued batch is paused too — nothing would ever start it').to.equal('paused');
        expect(updates.B3, 'finished work is left alone').to.equal(undefined);
        expect(updates.m1.status).to.equal('pending');
        expect(updates.m2, 'a pending member is already right').to.equal(undefined);
        expect(updates.i1.status).to.equal('cancelled');
        expect(updates.i2).to.equal(undefined);

        expect(summary.batches).to.deep.equal([
            { id: 'B1', name: 'Bulk Inventory Uploader', wasQueued: false },
            { id: 'B2', name: 'Inventory', wasQueued: true }
        ]);
        expect(summary.membersReset).to.equal(1);
        expect(summary.individualsCancelled).to.equal(1);
    });

    it('says what it did, in one line', () => {
        expect(StartupRecoveryService.describe({
            batches: [{ id: 'B1', name: 'Bulk Inventory Uploader', wasQueued: false }, { id: 'B2', name: 'Inventory', wasQueued: true }],
            membersReset: 1, individualsCancelled: 0, errors: []
        })).to.equal('Found 2 batches running or queued when VS Code closed: "Bulk Inventory Uploader", "Inventory". They\'ve been paused — resume them when you\'re ready.');
        expect(StartupRecoveryService.describe({ batches: [{ id: 'B1', name: 'Orders', wasQueued: false }], membersReset: 0, individualsCancelled: 1, errors: [] }))
            .to.equal('Found a batch running when VS Code closed: "Orders". It\'s been paused — resume it when you\'re ready. 1 single request was cancelled — run again if needed.');
    });

    it('nothing in flight: nothing to say', async () => {
        const { service, updateExecution } = make(rows().filter(r => r.status === 'completed'));
        const summary = await service.recover();
        expect(StartupRecoveryService.isEmpty(summary)).to.equal(true);
        expect(updateExecution.called).to.equal(false);
    });

    it('one record failing to update does not stop the others', async () => {
        const { service, updateExecution } = make();
        updateExecution.withArgs('B1').rejects(new Error('locked'));
        const summary = await service.recover();
        expect(summary.errors).to.have.length(1);
        expect(summary.batches.map(b => b.id)).to.deep.equal(['B2']);
    });
});
