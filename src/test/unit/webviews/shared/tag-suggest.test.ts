// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #432: tag suggestions as you type (shared/tag-suggest.js), the GitHub/Jira labels pattern:
 * the rules for what is offered, and the keys, on the real script in JSDOM.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'src/webviews/shared/tag-suggest.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { suggest } = require(path.join(ROOT, 'src/webviews/shared/tag-suggest.js'));

const KNOWN = ['orders', 'smoke', 'billing', 'order-lines', 'reorder', 'inventory', 'outbound', 'org'];

describe('Tag suggestions: what is offered (#432)', () => {
    it('starts-with first, then contains, at most five', () => {
        expect(suggest(KNOWN, 'or', []).tags).to.deep.equal(['orders', 'order-lines', 'org', 'reorder', 'inventory']);
        expect(suggest(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], 'a', []).tags).to.have.length(5);
    });

    it('case doesn\'t matter, and a tag already on the item is not offered', () => {
        expect(suggest(KNOWN, 'OR', ['orders']).tags).to.deep.equal(['order-lines', 'org', 'reorder', 'inventory']);
    });

    it('"New tag" while nothing in use matches exactly; not when one does, or it is already on', () => {
        expect(suggest(KNOWN, 'ord', []).create).to.equal('ord');
        expect(suggest(KNOWN, 'Orders', []).create).to.equal(null);
        expect(suggest(KNOWN, 'smoke', ['smoke']).create).to.equal(null);
        expect(suggest(KNOWN, 'zzz', [])).to.deep.equal({ tags: [], create: 'zzz' });
    });

    it('nothing typed: the most used, for ↓ on an empty field', () => {
        expect(suggest(KNOWN, '', []).tags).to.deep.equal(KNOWN.slice(0, 5));
        expect(suggest(KNOWN, '  ', []).create).to.equal(null);
    });
});

describe('Tag suggestions: the keys (#432)', () => {
    function field(current: string[] = []) {
        const dom = new JSDOM('<!DOCTYPE html><body><div id="box"><input id="tag"></div></body>', { runScripts: 'outside-only' });
        const w = dom.window as unknown as Window & { TagSuggest: { attach: Function } };
        dom.window.eval(SCRIPT);
        const input = dom.window.document.getElementById('tag') as HTMLInputElement;
        const picked: string[] = [];
        w.TagSuggest.attach(input, { getKnown: () => KNOWN, getCurrent: () => current, onPick: (t: string) => { picked.push(t); input.value = ''; } });
        const type = (text: string) => { input.value = text; input.dispatchEvent(new dom.window.Event('input')); };
        const key = (k: string) => { const e = new dom.window.KeyboardEvent('keydown', { key: k, cancelable: true }); input.dispatchEvent(e); return e; };
        const options = () => Array.from(dom.window.document.querySelectorAll('.tag-suggest li')).map(li => li.textContent);
        const active = () => dom.window.document.querySelector('.tag-suggest li.active')?.textContent;
        const list = () => dom.window.document.querySelector('.tag-suggest') as HTMLElement;
        return { input, picked, type, key, options, active, list };
    }

    it('typing lists matches with "New tag" last; the first is highlighted; Enter picks it', () => {
        const f = field();
        f.type('ord');
        expect(f.options()).to.deep.equal(['orders', 'order-lines', 'reorder', 'New tag ord']);
        expect(f.input.getAttribute('aria-expanded')).to.equal('true');
        expect(f.active()).to.equal('orders');
        const enter = f.key('Enter');
        expect(enter.defaultPrevented).to.equal(true);
        expect(f.picked).to.deep.equal(['orders']);
        expect(f.list().classList.contains('hidden')).to.equal(true);
    });

    it('each option shows the tag as the chip it becomes (.tag-chip), the typed part in bold inside it', () => {
        const f = field();
        f.type('ord');
        const chips = Array.from(f.list().querySelectorAll('li')).map(li => li.querySelector('.tag-chip'));
        expect(chips.map(c => c?.textContent)).to.deep.equal(['orders', 'order-lines', 'reorder', 'ord']);
        expect(chips[0]!.querySelector('strong')?.textContent).to.equal('ord');
        expect(f.list().querySelector('.tag-suggest-create .tag-suggest-hint')?.textContent).to.equal('New tag ');
    });

    it('↓ and ↑ move (and wrap), Tab picks; "New tag" adds what was typed', () => {
        const f = field();
        f.type('ord');
        f.key('ArrowDown');
        expect(f.active()).to.equal('order-lines');
        f.key('ArrowDown');
        expect(f.active()).to.equal('reorder');
        f.key('ArrowDown');
        expect(f.active()).to.equal('New tag ord');
        f.key('ArrowDown');
        expect(f.active(), 'wraps to the top').to.equal('orders');
        f.key('ArrowUp');
        f.key('Tab');
        expect(f.picked).to.deep.equal(['ord']);
    });

    it('Escape closes the list and picks nothing; ↓ on an empty field opens the most used', () => {
        const f = field(['orders']);
        f.type('sm');
        f.key('Escape');
        expect(f.list().classList.contains('hidden')).to.equal(true);
        expect(f.picked).to.deep.equal([]);
        f.type('');
        f.key('ArrowDown');
        expect(f.options()).to.deep.equal(['smoke', 'billing', 'order-lines', 'reorder', 'inventory']);
    });

    it('the input is a combobox pointing at its listbox and the highlighted option', () => {
        const f = field();
        f.type('bil');
        expect(f.input.getAttribute('role')).to.equal('combobox');
        expect(f.input.getAttribute('aria-controls')).to.equal(f.list().id);
        expect(f.list().getAttribute('role')).to.equal('listbox');
        const activeId = f.input.getAttribute('aria-activedescendant');
        expect(activeId && f.list().querySelector(`#${activeId}`)?.textContent).to.equal('billing');
    });
});
