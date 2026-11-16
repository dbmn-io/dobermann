// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Toasts sit just above the footer — the page's controls (Back/Next, Re-run,
 * Delete) live in .webview-footer and a bottom-right toast used to cover them.
 * The real dbmn-toast.js in JSDOM, with layout stubbed (JSDOM has none).
 */

import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function rect(top: number, bottom: number) {
    return () => ({ top, bottom, height: bottom - top, width: 800, left: 0, right: 800, x: 0, y: top, toJSON: () => ({}) });
}

function load(body: string) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window as any;
    Object.defineProperty(win, 'innerHeight', { value: 600, configurable: true });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/dbmn-toast.js'), 'utf8'));
    const bottom = () => (dom.window.document.getElementById('dbmn-toast-container') as HTMLElement).style.bottom;
    return { win, dom, bottom };
}

describe('DbmnToast clears the footer', () => {
    it('keeps the default offset when there is no footer', () => {
        const { win, bottom } = load('<main></main>');
        win.DbmnToast.info('hello');
        expect(bottom()).to.equal('16px');
    });

    it('sits just above a visible bottom footer', () => {
        const { win, dom, bottom } = load('<div class="webview-footer"></div>');
        (dom.window.document.querySelector('.webview-footer') as any).getBoundingClientRect = rect(540, 600);
        win.DbmnToast.info('hello');
        expect(bottom()).to.equal('68px'); // 60px footer + 8px gap
    });

    it('ignores a hidden footer and one that is not at the bottom of the view', () => {
        const { win, dom, bottom } = load('<div class="webview-footer" id="hidden"></div><div class="webview-footer" id="mid"></div>');
        (dom.window.document.getElementById('hidden') as any).getBoundingClientRect = rect(0, 0);
        (dom.window.document.getElementById('mid') as any).getBoundingClientRect = rect(200, 260);
        win.DbmnToast.info('hello');
        expect(bottom()).to.equal('16px');
    });
});
