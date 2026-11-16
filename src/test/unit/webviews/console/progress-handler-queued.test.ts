// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #309: the Console's progress row for a queued batch — no
 * running clock, no "Remaining: calculating...", and when it should start.
 * The real progress-handler.js and time-formatter.js in JSDOM.
 */

import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="progress-display" class="hidden">
            <span id="progress-phase"></span><span id="progress-count">0/0</span>
            <div id="progress-bar-fill"></div>
            <span id="progress-elapsed">⏱️ 00s</span>
            <span id="progress-eta">⏱️ Remaining: calculating...</span>
        </div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window as any;
    win.currentBatchId = 'batch-1';
    win.updateButtonVisibility = () => undefined;
    win.updateLogsTabIndicator = () => undefined;
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/time-formatter.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/icons.js'), 'utf8'));
    // A top-level class in a <script> is global; in eval it is not — export it by hand.
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/console/modules/progress-handler.js'), 'utf8') + '\nwindow.ProgressHandler = ProgressHandler;');
    const handler = dom.window.eval('new ProgressHandler()') as any;
    const text = (id: string) => dom.window.document.getElementById(id)!.textContent;
    return { win, dom, handler, text };
}

describe('Console progress row while queued (GitHub Issue #309)', () => {
    it('a pending update after a running one stops and clears the clock', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 65000 });
        expect(handler.executionStartTime).to.not.equal(null);
        expect(text('progress-elapsed')).to.equal('1m 5s');

        handler.handleProgressUpdate({ status: 'pending', queuedBehind: 'Orders' });
        expect(handler.executionStartTime, 'nothing to time while queued').to.equal(null);
        expect(text('progress-elapsed')).to.equal('Queued');
        expect(text('progress-phase')).to.equal('Queued');
    });

    it('says when it should start, from the batch ahead\'s estimate', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'pending', queuedBehind: 'Orders', expectedStartTime: Date.now() + 4 * 60 * 1000 + 10 * 1000 });
        expect(text('progress-eta')).to.equal('Starts in ~4m');
    });

    it('without an estimate it names the batch it waits on, or just "the current batch"', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'pending', queuedBehind: 'Orders' });
        expect(text('progress-eta')).to.equal('After Orders');
        handler.handleProgressUpdate({ status: 'pending', queued: true });
        expect(text('progress-eta')).to.equal('After the current batch');
    });

    it('a pending batch that is not queued (first chunk being prepared) says calculating, not queued', () => {
        const { handler, text } = load();
        // The Console replays the batch's 'pending' status when it opens
        handler.handleProgressUpdate({ status: 'pending', current: 0, total: 500 });
        expect(text('progress-eta')).to.equal('Remaining: calculating...');
        expect(text('progress-phase')).to.equal('Preparing');
    });

    it('once running, the queued text gives way to calculating until the first estimate', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'pending', queued: true });
        expect(text('progress-eta')).to.equal('After the current batch');
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 1000 });
        expect(text('progress-eta')).to.equal('Remaining: calculating...');
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 1000, estimatedEndTime: Date.now() + 125000 });
        handler._updateTimerDisplay();
        expect(text('progress-eta')).to.match(/^Remaining: 2m/);
    });

    it('the clock starts fresh once the batch actually runs', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'pending', queuedBehind: 'Orders' });
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 3000 });
        expect(text('progress-elapsed')).to.equal('3s');
    });
});

describe('Console clock after a resume (GitHub Issue #311)', () => {
    it('resyncs to the backend start time instead of restarting from this session', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 5000 });
        handler.handleProgressUpdate({ status: 'paused' });
        // Resume: the backend reports now - total run time (19 hours)
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 19 * 3600 * 1000 });
        expect(text('progress-elapsed')).to.match(/^19h 0m \d+s$/);
    });

    it('a start time within a tick of the local clock is left alone', () => {
        const { handler } = load();
        const start = Date.now() - 65000;
        handler.handleProgressUpdate({ status: 'running', startTime: start });
        handler.handleProgressUpdate({ status: 'running', startTime: start + 500 });
        expect(handler.executionStartTime).to.equal(start);
    });

    it('clockDisagrees: never started, or off by more than two seconds', () => {
        const { handler } = load();
        expect(handler.clockDisagrees(Date.now())).to.equal(true);
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 1000 });
        expect(handler.clockDisagrees(handler.executionStartTime + 1000)).to.equal(false);
        expect(handler.clockDisagrees(handler.executionStartTime - 60000)).to.equal(true);
    });

    // GitHub Issue #336: a reprocess opens in the Console still showing the run before it
    it('a new run in a reused Console says calculating, not the last run\'s spent estimate', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() - 60000, estimatedEndTime: Date.now() - 1000 });
        handler.handleProgressUpdate({ status: 'completed' });

        handler.handleProgressUpdate({ status: 'running', startTime: Date.now() });
        expect(handler.executionETA, 'the last run\'s estimate is gone').to.equal(null);
        handler._updateTimerDisplay();
        expect(text('progress-eta')).to.equal('Remaining: calculating...');
    });

    // #344: waiting for VS Code, not for a batch ahead: short, and says what to do
    it('waiting for VS Code says to open it', () => {
        const { handler, text } = load();
        handler.handleProgressUpdate({ status: 'pending', queued: true, waitingFor: 'VS Code' });
        expect(text('progress-eta')).to.equal('Please open VS Code');
    });
});
