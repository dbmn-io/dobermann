// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #312: a progress tick on a console tab patches that tab's label and bar
 * in the DOM; it does not rebuild the strip or post a snapshot. The real
 * hub-tabs.js in JSDOM, with the strip rendered.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body><div class="hub-layout"><div id="hubTabStripWrapper"><div id="hubTabStrip"></div></div><div id="hubTabBodies"></div></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as any;
    w.vscode = { postMessage: (m: unknown) => w.__posted.push(m) }; w.__posted = [];
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/icons.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/hub/hub-tabs.js'), 'utf8'));
    return { dom, w };
}

describe('HubTabs progress patch (Issue #312)', () => {
    it('a progress tick updates the tab in place without rebuilding the strip', async () => {
        const { dom, w } = load();
        w.HubTabs.init?.();
        const t = w.HubTabs.openOrFocusTab({ type: 'console', refId: 'run-1', name: 'Run 1' });
        w.HubTabs.setStatus(t.id, 'running', { done: 10, total: 100 });
        await new Promise(r => setTimeout(r, 30)); // let any rAF render settle
        const strip = dom.window.document.getElementById('hubTabStrip')!;
        const tabEl = strip.querySelector('.hub-tab');
        expect(tabEl, 'strip rendered').to.not.equal(null);
        expect(strip.querySelector('.hub-tab-progress-label'), 'progress label rendered').to.not.equal(null);

        let rebuilt = 0;
        const observer = new dom.window.MutationObserver(records => { if (records.some(r => r.removedNodes.length)) rebuilt++; });
        observer.observe(strip, { childList: true });
        w.__posted.length = 0;
        w.HubTabs.setStatus(t.id, 'running', { done: 42, total: 100 });
        await new Promise(r => setTimeout(r, 30));

        expect(strip.querySelector('.hub-tab-progress-label')!.textContent).to.equal('42/100');
        expect((tabEl as HTMLElement).style.getPropertyValue('--tab-progress')).to.equal('42%');
        expect(rebuilt, 'no strip rebuild').to.equal(0);
        expect(w.__posted.filter((m: any) => m.type === 'hubTabsSnapshot'), 'no snapshot post').to.have.length(0);
    });

    // #438: the tab shows its progress in the Console footer's status colour: a tint behind the
    // tab's own text and a line along the top (hub.css), both as far as --tab-progress
    it('#438: the tab is tinted to its progress in the footer\'s status colour, its own text left as it is', async () => {
        const { dom, w } = load();
        w.HubTabs.init?.();
        const t = w.HubTabs.openOrFocusTab({ type: 'console', refId: 'run-2', name: 'Set Vendor' });
        w.HubTabs.setStatus(t.id, 'running', { done: 25, total: 100 });
        await new Promise(r => setTimeout(r, 30));
        const strip = dom.window.document.getElementById('hubTabStrip')!;
        const tab = () => strip.querySelector('.hub-tab') as HTMLElement;

        const bar = tab().querySelector('.hub-tab-progress') as HTMLElement;
        expect(bar.className).to.equal('hub-tab-progress hub-tab-progress--running');
        expect(bar.getAttribute('aria-hidden')).to.equal('true');
        expect(tab().style.getPropertyValue('--tab-progress')).to.equal('25%');
        expect(tab().querySelectorAll('.hub-tab-name'), 'one copy of the text, no inverted copy').to.have.length(1);
        expect(tab().querySelector('.hub-tab-progress-label')!.className).to.contain('hub-tab-progress-label--running');

        // A tick moves the tint and the count in place
        w.HubTabs.setStatus(t.id, 'running', { done: 60, total: 100 });
        await new Promise(r => setTimeout(r, 30));
        expect(tab().style.getPropertyValue('--tab-progress')).to.equal('60%');
        expect(tab().querySelector('.hub-tab-progress-label')!.textContent).to.equal('60/100');

        // The footer's colour per status: done uses completed; failed and partial use error; cancelled is stopped's grey (#438)
        for (const [status, colour] of [['paused', 'paused'], ['completed', 'completed'], ['done', 'completed'], ['partial', 'error'], ['failed', 'error'], ['stopped', 'stopped'], ['cancelled', 'stopped']]) {
            w.HubTabs.setStatus(t.id, status, { done: 60, total: 100 });
            await new Promise(r => setTimeout(r, 30));
            expect((tab().querySelector('.hub-tab-progress') as HTMLElement).className, status).to.equal(`hub-tab-progress hub-tab-progress--${colour}`);
            expect(tab().querySelector('.hub-tab-progress-label')!.className, status).to.contain(`hub-tab-progress-label--${colour}`);
            expect(tab().classList.contains(`tab-tone--${colour}`), `${status}: the tab wears it too (the open tab's background)`).to.equal(true);
        }
    });
});
