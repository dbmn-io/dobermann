// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A query's tab wears the Reporting list's icon for it: a query's (blend), or Compare's (scale)
 * once a join is set to Compare, and back again. hub-tabs.js in JSDOM, with the strip rendered.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body><div class="hub-layout"><div id="hubTabStripWrapper"><div id="hubTabStrip"></div></div><div id="hubTabBodies"></div></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = dom.window as any;
    w.vscode = { postMessage: () => undefined };
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/icons.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/hub/hub-tabs.js'), 'utf8'));
    return { dom, w };
}
const settle = () => new Promise(r => setTimeout(r, 30));

describe('HubTabs: a query tab\'s icon follows the query (blend, or scale once it is a compare)', () => {
    it('blend as a query; scale once a join is Compare; blend again when it is not', async () => {
        const { dom, w } = load();
        w.HubTabs.init?.();
        w.HubTabs.openOrFocusTab({ type: 'compare', refId: 'qry-1', name: 'Stock' });
        w.HubTabs.openOrFocusTab({ type: 'compare', refId: 'cmp-9', name: 'Old compare' });
        await settle();
        const icons = () => [...dom.window.document.querySelectorAll('#hubTabStrip .hub-tab-glyph')].map(g => g.getAttribute('data-icon'));
        expect(icons()).to.deep.equal(['blend', 'scale']);
        w.HubTabs.setQueries([{ id: 'qry-1', joins: [{ kind: 'compare' }] }]);
        await settle();
        expect(icons()).to.deep.equal(['scale', 'scale']);
        w.HubTabs.setQueries([{ id: 'qry-1', joins: [{ kind: 'left' }] }]);
        await settle();
        expect(icons()).to.deep.equal(['blend', 'scale']);
    });
});
