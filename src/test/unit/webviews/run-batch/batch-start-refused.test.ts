// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { RunCancelledError } from '../../../../errors/run-cancelled-error';
import {
    BatchStartFailure, BatchStartFailureHost, bulkLoadFailure, describeBatchStartFailure, reportBatchStartFailure
} from '../../../../webviews/run-batch/bulk-load-result';

/**
 * GitHub Issue #396 — a batch that is refused before it starts must say so. The command that
 * starts a batch catches everything and returns `{ success: false }`; Run Batch reads it.
 * A refusal is the user stopping at a prompt or a real failure.
 */
function host(panelOpen: boolean) {
    const posted: Array<{ type: string; error?: string }> = [];
    const h: BatchStartFailureHost = {
        hasPanel: () => panelOpen,
        postToPage: message => { posted.push(message); }
    };
    return { h, posted };
}

describe('Run Batch — a refused start is never silent (#396)', () => {
    describe('what the start command hands back', () => {
        it('a stop at a prompt is cancelled, not an error', () => {
            expect(bulkLoadFailure(new RunCancelledError('Sign-in was not completed'))).to.deep.equal({ success: false, message: 'Sign-in was not completed', cancelled: true });
        });

        it('any other failure keeps its message', () => {
            expect(bulkLoadFailure(new Error('Endpoint not found: ep-9'))).to.deep.equal({ success: false, message: 'Endpoint not found: ep-9' });
            expect(bulkLoadFailure('plain text')).to.deep.equal({ success: false, message: 'plain text' });
        });
    });

    describe('what Run Batch makes of it', () => {
        it('a batch that started is not a failure', () => {
            expect(describeBatchStartFailure({ success: true, message: 'started' })).to.equal(null);
            expect(describeBatchStartFailure(undefined)).to.equal(null);
        });

        it('stopping at a sign-in prompt is not an error', () => {
            expect(describeBatchStartFailure({ success: false, message: 'Waiting', cancelled: true })).to.deep.equal({ kind: 'cancelled', message: 'Waiting' });
        });

        it('anything else is an error with its reason, or a stock one', () => {
            expect(describeBatchStartFailure({ success: false, message: 'member 3 failed' })).to.deep.equal({ kind: 'error', message: 'member 3 failed' });
            expect(describeBatchStartFailure({ success: false, message: '' })).to.deep.equal({ kind: 'error', message: 'The batch could not be started.' });
        });
    });

    describe('what the user sees', () => {
        it('an ordinary failure shows its reason on the Batch tab, which stays', async () => {
            const { h, posted } = host(true);
            await reportBatchStartFailure({ kind: 'error', message: 'Endpoint not found: ep-9' }, h);
            expect(posted).to.deep.equal([{ type: 'bulkLoadCommandExecuted', error: 'Endpoint not found: ep-9' }]);
        });

        it('a run the user stopped at a sign-in prompt just gets Execute back — no error', async () => {
            const { h, posted } = host(true);
            await reportBatchStartFailure({ kind: 'cancelled', message: 'Waiting for sign-in' }, h);
            expect(posted).to.deep.equal([{ type: 'resetExecuteButton' }]);
        });

        it('with the tab gone, a failure is the Console\'s to show — no second report', async () => {
            const { h, posted } = host(false);
            await reportBatchStartFailure({ kind: 'error', message: 'member 3 failed' } as BatchStartFailure, h);
            expect(posted).to.deep.equal([]);
        });
    });

    describe('the Batch page (the real data-transformer.js)', () => {
        const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
        const SCRIPTS = ['json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js', 'dt-data-ingestion.js',
            'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

        function page() {
            const dom = new JSDOM('<!DOCTYPE html><body><button id="csvExecuteBtn">Execute</button></body>', { runScripts: 'outside-only' });
            const win = dom.window as unknown as Window & { vscode: unknown; DbmnToast: unknown };
            const toasts: Array<{ type: string; message: string; persistent: boolean }> = [];
            win.vscode = { postMessage: () => undefined };
            win.DbmnToast = { show: (type: string, message: string, options: { persistent: boolean }) => { toasts.push({ type, message, persistent: options.persistent }); } };
            for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
            const send = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
            const button = dom.window.document.getElementById('csvExecuteBtn') as HTMLButtonElement;
            return { send, button, toasts };
        }

        it('a refused start puts Execute back and leaves the reason on screen', () => {
            const { send, button, toasts } = page();
            button.disabled = true;
            send({ type: 'batchPreparationProgress', stage: 'preparing', message: 'Preparing batch execution...' });
            expect(button.textContent).to.contain('Preparing batch execution...');

            send({ type: 'bulkLoadCommandExecuted', error: 'Endpoint not found: ep-9' });

            expect(button.disabled, 'Execute can be pressed again').to.equal(false);
            expect(button.textContent).to.equal('Execute');
            expect(toasts).to.deep.equal([{ type: 'error', message: 'Endpoint not found: ep-9', persistent: true }]);
        });
    });
});
