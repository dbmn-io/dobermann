// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #314: DbmnContextMenu — one menu at a time, items in order, a choice closes it
 * and reports its id, Escape closes it.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function load() {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/icons.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/dbmn-context-menu.js'), 'utf8'));
    return dom;
}

describe('DbmnContextMenu (Issue #314)', () => {
    it('shows the items in order, with icons, and reports the chosen id', () => {
        const dom = load();
        const w = dom.window as any;
        const chosen: string[] = [];
        w.DbmnContextMenu.show({ clientX: 10, clientY: 10, preventDefault() { /* noop */ } },
            [{ id: 'open', label: 'Open', icon: 'circle-play' }, { separator: true }, { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }],
            (id: string) => chosen.push(id));
        const items = Array.from(dom.window.document.querySelectorAll('.dbmn-context-menu-item')) as HTMLElement[];
        expect(items.map(i => i.textContent)).to.deep.equal(['Open', 'Delete']);
        expect(items[1].classList.contains('is-danger')).to.equal(true);
        expect(dom.window.document.querySelectorAll('.dbmn-context-menu-icon svg')).to.have.length(2);
        expect(w.DbmnContextMenu.isOpen).to.equal(true);
        items[1].click();
        expect(chosen).to.deep.equal(['delete']);
        expect(w.DbmnContextMenu.isOpen, 'closed on choice').to.equal(false);
    });

    it('only one menu at a time; Escape closes it', () => {
        const dom = load();
        const w = dom.window as any;
        const ev = { clientX: 0, clientY: 0, preventDefault() { /* noop */ } };
        w.DbmnContextMenu.show(ev, [{ id: 'a', label: 'A' }], () => undefined);
        w.DbmnContextMenu.show(ev, [{ id: 'b', label: 'B' }], () => undefined);
        expect(dom.window.document.querySelectorAll('.dbmn-context-menu')).to.have.length(1);
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(w.DbmnContextMenu.isOpen).to.equal(false);
    });
});
