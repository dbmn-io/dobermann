// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* eslint-disable no-restricted-imports -- Sinon required for stubbing vscode.window in this thin adapter */
/**
 * Unit tests for VSCodeToastService (GitHub Issue #263).
 *
 * Delivery model:
 *   - forceNative → straight to vscode.window.show*Message.
 *   - a DBMN webview is visible → render in its DbmnToast overlay (no native).
 *   - nothing visible → queue the toast + show ONE coalesced "New notifications
 *     from DBMN — View" nudge; View opens the Hub which drains the queue.
 */
import '../../../setup';
import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { VSCodeToastService } from '../../../../services/notifications/vscode-toast.service';
import { ToastDelivery, ToastPayload, TOAST_TARGETS_KEY } from '../../../../services/notifications/toast.interface';

function setTargets(targets: ToastDelivery[]): void {
    (globalThis as Record<string, unknown>)[TOAST_TARGETS_KEY] = new Set(targets);
}
function clearTargets(): void {
    delete (globalThis as Record<string, unknown>)[TOAST_TARGETS_KEY];
}

describe('VSCodeToastService', () => {
    let infoStub: SinonStub;
    let warnStub: SinonStub;
    let errorStub: SinonStub;
    let execStub: SinonStub;
    let toast: VSCodeToastService;

    beforeEach(() => {
        infoStub = stub(vscode.window, 'showInformationMessage').resolves(undefined);
        warnStub = stub(vscode.window, 'showWarningMessage').resolves(undefined);
        errorStub = stub(vscode.window, 'showErrorMessage').resolves(undefined);
        execStub = stub(vscode.commands, 'executeCommand').resolves(undefined);
        toast = new VSCodeToastService();
        clearTargets();
    });

    afterEach(() => {
        restore();
        clearTargets();
    });

    describe('forceNative', () => {
        it('sends info straight to the native notification with the real message', () => {
            toast.info('Critical info', { forceNative: true });
            expect(infoStub.calledOnceWithExactly('Critical info')).to.equal(true);
        });

        it('sends error straight to showErrorMessage', () => {
            toast.error('Sign-in failed', { forceNative: true });
            expect(errorStub.calledOnceWithExactly('Sign-in failed')).to.equal(true);
            expect(infoStub.called).to.equal(false);
        });

        it('is fire-and-forget — returns void', () => {
            expect(toast.info('x', { forceNative: true })).to.equal(undefined);
        });
    });

    describe('visible webview', () => {
        it('delivers to a visible target and never touches the native channel', () => {
            const received: ToastPayload[] = [];
            setTargets([(p) => { received.push(p); return true; }]);

            toast.warn('Heads up');

            expect(received).to.have.length(1);
            expect(received[0]).to.deep.include({ level: 'warn', message: 'Heads up' });
            expect(warnStub.called).to.equal(false);
            expect(infoStub.called).to.equal(false);
        });
    });

    describe('no visible webview — queue + nudge', () => {
        it('queues the toast and shows a single actionable nudge (not the raw message)', () => {
            toast.info('Saved');

            expect(infoStub.calledOnce).to.equal(true);
            expect(infoStub.firstCall.args[0]).to.equal('New notifications from DBMN');
            expect(infoStub.firstCall.args[1]).to.equal('View');
        });

        it('coalesces multiple queued toasts into one nudge', () => {
            toast.info('a');
            toast.warn('b');
            toast.error('c');

            expect(infoStub.calledOnce).to.equal(true); // one nudge only
            expect(warnStub.called).to.equal(false);
            expect(errorStub.called).to.equal(false);
        });

        it('drainPending() replays queued toasts into a now-visible target', () => {
            toast.info('Saved');   // queued (no target)
            toast.warn('Careful'); // queued

            const received: ToastPayload[] = [];
            setTargets([(p) => { received.push(p); return true; }]);
            toast.drainPending();

            expect(received.map(r => r.message)).to.deep.equal(['Saved', 'Careful']);
        });

        it('keeps toasts queued if drain happens while still not visible', () => {
            toast.info('Saved');
            setTargets([() => false]); // present but not visible
            toast.drainPending();

            // Still queued — a later visible drain should deliver it.
            const received: ToastPayload[] = [];
            setTargets([(p) => { received.push(p); return true; }]);
            toast.drainPending();
            expect(received.map(r => r.message)).to.deep.equal(['Saved']);
        });

        it('opens the Hub when the user clicks View', async () => {
            infoStub.resolves('View');
            toast.info('Saved');
            // Let the nudge promise resolve.
            await new Promise(resolve => setImmediate(resolve));
            expect(execStub.calledWith('dbmn.openHub')).to.equal(true);
        });
    });
});
