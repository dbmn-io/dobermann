// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-name>: a report's name on its own screen (the design system: src/webviews/design-system).
 * It sits where the screen's top row starts, quiet, and a click makes it a box to type a new one
 * in: Enter keeps it, Esc or leaving puts the old one back. A name not yet given shows in
 * italics ("New query"), so it reads as unnamed and can be named from the first step.
 *
 *   <dbmn-name id="name" label="Query name" max="30"></dbmn-name>
 *   name.value = 'Open orders by item';      // what the screen's controller says it is called
 *   name.unnamed = true;                      // the name is still the one it was given by default
 *   name.addEventListener('dbmn-name-change', e => post({ type: 'query.rename', name: e.detail.name }));
 *       The component only asks: the controller checks the name (unique, not too long) and
 *       answers with the name it kept, which the screen sets as `value` again.
 *
 * A name is cleaned as it is asked for: one line, no control characters, single spaces, at most
 * `max` characters. Renaming elsewhere (the Hub's lists, right-click → Rename) uses the same rules.
 * It draws in the page (no shadow root) and holds no business logic. Needs icons.js; styles in
 * shared/dbmn-name.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-name')) return;

    const clean = (text, max) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

    class DbmnName extends HTMLElement {
        static get observedAttributes() { return ['value', 'unnamed', 'label']; }

        constructor() {
            super();
            this._value = '';
            this._editing = false;
        }

        connectedCallback() {
            if (!this._built) this._build();
            this._draw();
        }
        attributeChangedCallback(name, _old, now) {
            if (name === 'value') this._value = now || '';
            if (this._built) this._draw();
        }

        get value() { return this._value; }
        set value(text) { this._value = String(text || ''); if (this._built && !this._editing) this._draw(); }
        get unnamed() { return this.hasAttribute('unnamed'); }
        set unnamed(on) { this.toggleAttribute('unnamed', !!on); }
        get max() { return Number(this.getAttribute('max')) || 30; }

        _build() {
            this._built = true;
            this._show = document.createElement('button');
            this._show.type = 'button';
            this._show.className = 'dbmn-name-show';
            this._text = document.createElement('span');
            this._text.className = 'dbmn-name-text';
            const pencil = document.createElement('span');
            pencil.className = 'dbmn-name-pencil';
            pencil.setAttribute('aria-hidden', 'true');
            if (window.Icons) window.Icons.setIcon(pencil, 'pencil');
            this._show.append(this._text, pencil);
            this._input = document.createElement('input');
            this._input.type = 'text';
            this._input.className = 'dbmn-name-input';
            this._input.hidden = true;
            this._input.spellcheck = false;
            // Not a sign-in: password managers stay out (as in every DBMN dialog)
            this._input.setAttribute('autocomplete', 'off');
            this._input.setAttribute('data-1p-ignore', 'true');
            this._input.setAttribute('data-lpignore', 'true');
            this._input.setAttribute('data-bwignore', 'true');
            this._input.setAttribute('data-form-type', 'other');
            this.replaceChildren(this._show, this._input);

            this._show.addEventListener('click', () => this._edit());
            this._input.addEventListener('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); this._done(true); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this._done(false); }
            });
            this._input.addEventListener('blur', () => { if (this._editing) this._done(false); });
        }

        _draw() {
            const label = this.getAttribute('label') || 'Name';
            this._text.textContent = this._value;
            this._show.title = `${this._value}\nClick to rename`;
            this._show.setAttribute('aria-label', `${label}: ${this._value}. Rename`);
            this._input.setAttribute('aria-label', label);
            this._input.maxLength = this.max;
        }

        _edit() {
            this._editing = true;
            this._input.value = this._value;
            this._show.hidden = true;
            this._input.hidden = false;
            this._input.focus();
            this._input.select();
        }

        /** Enter asks for the name typed; Esc, or leaving the box, keeps the one it has. */
        _done(keep) {
            if (!this._editing) return;
            this._editing = false;
            const name = clean(this._input.value, this.max);
            this._input.hidden = true;
            this._show.hidden = false;
            if (keep && name && name !== this._value) {
                // Shown at once; the controller's answer (the name it kept) is set as `value`
                this._value = name;
                this.unnamed = false;
                this.dispatchEvent(new CustomEvent('dbmn-name-change', { bubbles: true, detail: { name } }));
            }
            this._draw();
            this._show.focus({ preventScroll: true });
        }
    }

    customElements.define('dbmn-name', DbmnName);
})();
