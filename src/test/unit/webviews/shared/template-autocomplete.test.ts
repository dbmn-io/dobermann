// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * `{{` in a plain field opens the template list (template-autocomplete.js), in JSDOM: the list
 * filters from the start of a name, Enter writes `{{value}}` and puts the caret after it, an
 * existing `}}` is not doubled, and Escape closes it.
 */
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../..');

function page() {
    const dom = new JSDOM('<!DOCTYPE html><body><input id="endpointPath" type="text"><input id="other" type="text"></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window as any;
    win.HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t: string) => ({ width: t.length * 7 }), font: '' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/webviews/shared/template-autocomplete.js'), 'utf8'));
    win.TemplateAutocomplete.attach({
        selector: '#endpointPath',
        suggestions: () => [
            { value: 'ENV:region', detail: 'en', group: 'Environment' },
            ...win.TemplateAutocomplete.GENERATED
        ],
        empty: { Environment: 'No variables' }
    });
    const doc = dom.window.document;
    const input = doc.getElementById('endpointPath') as HTMLInputElement;
    const type = (value: string, caret = value.length) => {
        input.focus();
        input.value = value;
        input.setSelectionRange(caret, caret);
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    const key = (name: string) => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: name, bubbles: true }));
    const shown = () => Array.from(doc.querySelectorAll('#tpl-ac-popup:not(.hidden) .tpl-ac-value')).map(el => el.textContent);
    return { input, type, key, shown, doc, win };
}

describe('template autocomplete in plain fields', () => {
    it('opens on {{ with the environment and the generated values, and filters from the start of a name', () => {
        const p = page();
        p.type('/{{');
        expect(p.shown()).to.include('{{ENV:region}}').and.include('{{A8:sequence}}');
        p.type('/{{EN');
        expect(p.shown()).to.deep.equal(['{{ENV:region}}']);
        p.type('/{{reg');
        expect(p.shown(), 'the part after the colon matches too').to.deep.equal(['{{ENV:region}}']);
    });

    it('Enter writes {{value}} and puts the caret after it', () => {
        const p = page();
        p.type('/{{EN/orders', 5);
        p.key('Enter');
        expect(p.input.value).to.equal('/{{ENV:region}}/orders');
        expect(p.input.selectionStart).to.equal('/{{ENV:region}}'.length);
        expect(p.shown()).to.deep.equal([]);
    });

    it('a closing }} already there is not doubled', () => {
        const p = page();
        p.type('/{{EN}}/orders', 5);
        p.key('Enter');
        expect(p.input.value).to.equal('/{{ENV:region}}/orders');
    });

    it('stays shut outside a template, after one is closed, and on Escape', () => {
        const p = page();
        p.type('/orders');
        expect(p.shown()).to.deep.equal([]);
        p.type('/{{ENV:region}}/x');
        expect(p.shown()).to.deep.equal([]);
        p.type('/{{');
        p.key('Escape');
        expect(p.shown()).to.deep.equal([]);
    });
});
