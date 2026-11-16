// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: the Chain button on the Console's Completed tab.
 *
 * Asked 2026-10-05: a run that is still running or paused cannot be chained, but the button
 * should stay visible, disabled, with a tooltip that names the status (Can't chain "Paused").
 * It used to be hidden until the run completed. The real console-chain.js in JSDOM.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function load() {
    const dom = new JSDOM(
        `<!DOCTYPE html><body><button id="chain-btn" class="export-button hidden" title="Send these rows to another API as its Run Batch input">Chain</button></body>`,
        { runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const w = dom.window as any;
    w.vscode = { postMessage: () => undefined };
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/console/modules/console-chain.js'), 'utf8'));
    const btn = dom.window.document.getElementById('chain-btn') as HTMLButtonElement;
    return { w, btn };
}

describe('Chain button availability (#247)', () => {
    it('is shown but disabled while the run is running, and the tooltip names the status', () => {
        const { w, btn } = load();
        w.ConsoleChain.onSwitchTab('success');
        w.ConsoleChain.onStatus('running');
        expect(btn.classList.contains('hidden'), 'visible on Completed').to.equal(false);
        expect(btn.disabled).to.equal(true);
        expect(btn.title).to.equal('Can\'t chain "Running"');
    });

    it('a paused run says so', () => {
        const { w, btn } = load();
        w.ConsoleChain.onSwitchTab('success');
        w.ConsoleChain.onStatus('paused');
        expect(btn.disabled).to.equal(true);
        expect(btn.title).to.equal('Can\'t chain "Paused"');
    });

    it('comes on with its normal tooltip once the run has ended, however it ended', () => {
        for (const status of ['completed', 'stopped', 'error', 'cancelled']) {
            const { w, btn } = load();
            w.ConsoleChain.onSwitchTab('success');
            w.ConsoleChain.onStatus(status);
            expect(btn.disabled, status).to.equal(false);
            expect(btn.title, status).to.equal('Send these rows to another API as its Run Batch input');
        }
    });

    it('a live status change flips it without a tab switch', () => {
        const { w, btn } = load();
        w.ConsoleChain.onSwitchTab('success');
        w.ConsoleChain.onStatus('running');
        expect(btn.disabled).to.equal(true);
        w.ConsoleChain.onStatus('completed');
        expect(btn.disabled).to.equal(false);
    });

    it('is hidden on every tab but Completed', () => {
        const { w, btn } = load();
        w.ConsoleChain.onStatus('completed');
        for (const tab of ['error', 'input', 'raw', 'info', 'links']) {
            w.ConsoleChain.onSwitchTab(tab);
            expect(btn.classList.contains('hidden'), tab).to.equal(true);
        }
    });
});
