// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as sinon from 'sinon';
import {
    confirmProductionExecution,
    isProductionEnvironment,
    clearProductionSuppression,
    ProductionGuardEnv
} from '../../../../services/ui/production-guard.service';
import { DbmnModalSpec, DbmnModalResult } from '../../../../services/ui/dbmn-prompts';

/**
 * GitHub Issue #273: production execution guard.
 * Pure-logic unit tests — the modal is stubbed via an in-memory ModalHost.
 */
describe('ProductionGuard - GitHub Issue #273', () => {
    let clock: sinon.SinonFakeTimers;
    const prodEnv: ProductionGuardEnv = { id: 'env-prod', name: 'Prod', environmentType: 'production' };
    const devEnv: ProductionGuardEnv = { id: 'env-dev', name: 'Dev', environmentType: 'development' };

    // A stub ModalHost that answers with a scripted action + fields.
    function host(result: DbmnModalResult): { showModal: sinon.SinonStub } {
        return { showModal: sinon.stub().resolves(result) };
    }

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        clearProductionSuppression();
    });

    afterEach(() => {
        clock.restore();
        clearProductionSuppression();
    });

    describe('isProductionEnvironment', () => {
        it('is true only for production type', () => {
            expect(isProductionEnvironment(prodEnv)).to.equal(true);
            expect(isProductionEnvironment(devEnv)).to.equal(false);
            expect(isProductionEnvironment(undefined)).to.equal(false);
        });
    });

    it('proceeds without a modal for non-production environments', async () => {
        const h = host({ actionId: 'execute', fields: {} });
        const proceed = await confirmProductionExecution(devEnv, 'Run API', h);
        expect(proceed).to.equal(true);
        expect(h.showModal.called).to.equal(false);
    });

    it('shows the modal and proceeds when the user confirms', async () => {
        const h = host({ actionId: 'execute', fields: { suppress: '0' } });
        const proceed = await confirmProductionExecution(prodEnv, 'Run API', h);
        expect(proceed).to.equal(true);
        expect(h.showModal.calledOnce).to.equal(true);
        const spec = h.showModal.firstCall.args[0] as DbmnModalSpec;
        expect(spec.body).to.contain('PRODUCTION');
        expect(spec.body).to.contain('Prod');
    });

    it('blocks execution when the user cancels', async () => {
        const h = host({ actionId: 'cancel', fields: {} });
        const proceed = await confirmProductionExecution(prodEnv, 'Run API', h);
        expect(proceed).to.equal(false);
    });

    it('blocks execution when the modal is dismissed', async () => {
        const h = host({ actionId: 'dismiss', fields: {} });
        const proceed = await confirmProductionExecution(prodEnv, 'Run API', h);
        expect(proceed).to.equal(false);
    });

    it('suppresses subsequent warnings within the chosen window', async () => {
        const h = host({ actionId: 'execute', fields: { suppress: '15' } });
        // First call prompts and sets a 15-minute suppression.
        expect(await confirmProductionExecution(prodEnv, 'Run API', h)).to.equal(true);
        expect(h.showModal.callCount).to.equal(1);

        // Within 15 minutes: no further prompt.
        clock.tick(14 * 60_000);
        const h2 = host({ actionId: 'cancel', fields: {} });
        expect(await confirmProductionExecution(prodEnv, 'Run API', h2)).to.equal(true);
        expect(h2.showModal.called).to.equal(false);
    });

    it('re-prompts once the suppression window expires', async () => {
        const h = host({ actionId: 'execute', fields: { suppress: '15' } });
        await confirmProductionExecution(prodEnv, 'Run API', h);

        // Past 15 minutes: prompt again.
        clock.tick(15 * 60_000 + 1);
        const h2 = host({ actionId: 'execute', fields: { suppress: '0' } });
        expect(await confirmProductionExecution(prodEnv, 'Run API', h2)).to.equal(true);
        expect(h2.showModal.calledOnce).to.equal(true);
    });

    it('keeps suppression per-environment', async () => {
        const other: ProductionGuardEnv = { id: 'env-prod-2', name: 'Prod2', environmentType: 'production' };
        const h = host({ actionId: 'execute', fields: { suppress: '30' } });
        await confirmProductionExecution(prodEnv, 'Run API', h);

        // A different production env is still prompted.
        const h2 = host({ actionId: 'execute', fields: { suppress: '0' } });
        await confirmProductionExecution(other, 'Run API', h2);
        expect(h2.showModal.calledOnce).to.equal(true);
    });

    it('re-warns after suppression is cleared for that environment (env switch)', async () => {
        const h = host({ actionId: 'execute', fields: { suppress: '60' } });
        await confirmProductionExecution(prodEnv, 'Run API', h);

        // Simulates leaving + returning to the env (setActiveEnvironment clears it).
        clearProductionSuppression(prodEnv.id);

        const h2 = host({ actionId: 'execute', fields: { suppress: '0' } });
        expect(await confirmProductionExecution(prodEnv, 'Run API', h2)).to.equal(true);
        expect(h2.showModal.calledOnce).to.equal(true);
    });

    it('clearProductionSuppression() with no id clears every environment', async () => {
        const other: ProductionGuardEnv = { id: 'env-prod-2', name: 'Prod2', environmentType: 'production' };
        await confirmProductionExecution(prodEnv, 'Run API', host({ actionId: 'execute', fields: { suppress: '60' } }));
        await confirmProductionExecution(other, 'Run API', host({ actionId: 'execute', fields: { suppress: '60' } }));

        clearProductionSuppression();

        const h1 = host({ actionId: 'execute', fields: { suppress: '0' } });
        const h2 = host({ actionId: 'execute', fields: { suppress: '0' } });
        await confirmProductionExecution(prodEnv, 'Run API', h1);
        await confirmProductionExecution(other, 'Run API', h2);
        expect(h1.showModal.calledOnce).to.equal(true);
        expect(h2.showModal.calledOnce).to.equal(true);
    });

    it('proceeds without a bridge (headless) rather than dead-ending', async () => {
        // No host and no global bridge registered.
        delete (globalThis as Record<string, unknown>).dbmnShowModal;
        const proceed = await confirmProductionExecution(prodEnv, 'Run API');
        expect(proceed).to.equal(true);
    });
});
