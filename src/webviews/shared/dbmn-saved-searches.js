// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-saved-searches>: a search box's saved searches, a ★ drop-down beside the box (the design
 * system: src/webviews/design-system). James, 2026-11-23: "drop down beside the box, for sure", and
 * "that saved search should be everywhere where we have a search box".
 *
 * A saved search is the box's text and a name: nothing else (the box is the whole search). Picking
 * one fills the box and searches as if it were typed, so an @column the table doesn't show is added
 * as typing it adds it; a saved search never takes a column away.
 *
 *   <dbmn-saved-searches id="saved"></dbmn-saved-searches>      placed beside the search box
 *   <dbmn-saved-searches compact>             inside the box's right end, where a toolbar is tight (Query): the
 *                                             star and the caret only, the saved search's name in the hover text
 *   saved.input = $('querySearch');           // the box it follows (its typing; refresh() after setting it from script)
 *   saved.searches = [{ name: 'Late orders', text: '@status=late' }];   // the screen's list, kept where its table is kept
 *   saved.addEventListener('dbmn-saved-change', e => …e.detail.searches…);   // after a save, rename or delete:
 *       the whole new list, for the screen to keep (and give back as `searches`)
 *   saved.addEventListener('dbmn-saved-pick', e => …e.detail.name, e.detail.text…);   // one picked: unless the
 *       screen calls e.preventDefault(), the box is given the text and its `input` event fires
 *   saved.current = '@status=late';           // a screen without `input`: the box's text, told
 *   saved.refresh();                          // the box was set from script: the button follows it
 *
 * The button names the saved search the box holds now, else says "Saved". The menu: + Save this
 * search (named in a box in the menu), then each saved one, its name over its text; a click searches
 * it, ✎ renames it, × deletes it after a Delete / Keep. A name is needed, at most 30 characters,
 * and no two alike (letter case aside); at most 50 are kept.
 *
 * It draws in the page (no shadow root), only shows what it is given and says what is asked: it
 * keeps nothing itself. Needs icons.js; styles in shared/search.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-saved-searches')) return;

    const MAX_NAME = 30;
    const MAX_SEARCHES = 50;
    const clean = text => String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
    const icon = name => (window.Icons && window.Icons.icon ? window.Icons.icon(name) : '');
    const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    class DbmnSavedSearches extends HTMLElement {
        constructor() {
            super();
            this._searches = [];
            this._current = '';
            this._mode = null;          // null | { kind: 'save' } | { kind: 'rename', index } | { kind: 'delete', index }
            this._problem = '';
            this._onInput = () => this.refresh();
            this._onOutside = e => { if (!this.contains(e.target)) this.close(); };
        }

        connectedCallback() {
            if (!this._built) this._build();
            this._drawButton();
        }
        disconnectedCallback() { document.removeEventListener('mousedown', this._onOutside, true); }

        /** The screen's list: [{ name, text }], in its order. */
        get searches() { return this._searches.map(s => ({ name: s.name, text: s.text })); }
        set searches(list) {
            this._searches = (Array.isArray(list) ? list : []).filter(s => s && clean(s.name) && clean(s.text)).map(s => ({ name: clean(s.name), text: String(s.text).trim() }));
            this._read();
            if (this._built) { this._drawButton(); if (this.isOpen) this._redrawMenu(); }
        }
        /** The menu drawn again where the keys were in it: they stay in it (Esc still closes it). */
        _redrawMenu() {
            const had = this._menu.contains(document.activeElement);
            this._drawMenu();
            if (!had || this._mode) return;
            const next = this._menu.querySelector('button:not([disabled])');
            if (next) next.focus(); else this._button.focus();
        }
        /** The box it follows; its typing moves the button's name. */
        get input() { return this._input || null; }
        set input(box) {
            if (this._input === box) return;
            if (this._input) this._input.removeEventListener('input', this._onInput);
            this._input = box || null;
            if (this._input) this._input.addEventListener('input', this._onInput);
            this.refresh();
        }
        /** The box's text (told, by a screen that gives no `input`). */
        get current() { return this._current; }
        set current(text) { this._current = String(text == null ? '' : text).trim(); if (this._built) { this._drawButton(); if (this.isOpen && !this._mode) this._drawMenu(); } }
        /** The box was set from script: read it again. */
        refresh() {
            this._read();
            if (this._built) { this._drawButton(); if (this.isOpen && !this._mode) this._drawMenu(); }
        }
        get isOpen() { return !!(this._menu && !this._menu.hidden); }

        /** The saved search the box holds now, if any. */
        get matching() { return this._current ? this._searches.find(s => s.text === this._current) || null : null; }

        open() {
            if (!this._built) return;
            this._read();
            this._mode = null;
            this._problem = '';
            this._menu.hidden = false;
            this._button.setAttribute('aria-expanded', 'true');
            this._drawMenu();
            document.addEventListener('mousedown', this._onOutside, true);
            const first = this._menu.querySelector('button:not([disabled])');
            if (first) first.focus();
        }
        close(focusButton) {
            if (!this._built || this._menu.hidden) return;
            this._menu.hidden = true;
            this._mode = null;
            this._button.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', this._onOutside, true);
            if (focusButton) this._button.focus();
        }

        _read() { if (this._input) this._current = String(this._input.value || '').trim(); }

        _build() {
            this._built = true;
            this.classList.add('dbmn-saved-searches');
            this._button = make('button', 'dbmn-saved-btn');
            this._button.type = 'button';
            this._button.setAttribute('aria-haspopup', 'true');
            this._button.setAttribute('aria-expanded', 'false');
            this._button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
            this._menu = make('div', 'dbmn-saved-menu');
            this._menu.hidden = true;
            this._menu.setAttribute('role', 'dialog');
            this._menu.setAttribute('aria-label', 'Saved searches');
            this._menu.addEventListener('keydown', e => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (this._mode) { this._mode = null; this._problem = ''; this._drawMenu(); } else this.close(true); }
            });
            this.append(this._button, this._menu);
        }

        _drawButton() {
            const now = this.matching;
            this._button.innerHTML = '';
            const star = make('span', 'dbmn-saved-star', now ? '★' : '☆');
            star.setAttribute('aria-hidden', 'true');
            const label = make('span', 'dbmn-saved-label', now ? now.name : 'Saved');
            const caret = make('span', 'dbmn-saved-caret');
            caret.innerHTML = icon('chevron-down');
            this._button.append(star, label, caret);
            this._button.classList.toggle('is-saved', !!now);
            this._button.title = now ? `Saved search: ${now.name}` : 'Saved searches: save this search, or pick one';
            // (compact: the name isn't shown, so it is the button's name for a screen reader)
            this._button.setAttribute('aria-label', now ? `Saved search: ${now.name}` : 'Saved searches');
        }

        _drawMenu() {
            const menu = this._menu;
            menu.innerHTML = '';
            const top = make('div', 'dbmn-saved-top');
            const now = this.matching;
            if (this._mode && this._mode.kind === 'save') {
                top.append(this._nameForm(this._suggestName(), 'Save', name => this._save(name)));
            } else {
                const save = make('button', 'dbmn-saved-add', '+ Save this search');
                save.type = 'button';
                const full = this._searches.length >= MAX_SEARCHES;
                save.disabled = !this._current || !!now || full;
                save.addEventListener('click', () => { this._mode = { kind: 'save' }; this._problem = ''; this._drawMenu(); });
                top.append(save);
                const why = !this._current ? 'Type a search first' : now ? `Saved as ${now.name}` : full ? `${MAX_SEARCHES} saved: delete one first` : '';
                if (why) top.append(make('div', 'dbmn-saved-note', why));
            }
            menu.append(top);

            const list = make('div', 'dbmn-saved-list');
            if (!this._searches.length) list.append(make('div', 'dbmn-saved-empty', 'No saved searches yet'));
            this._searches.forEach((s, index) => {
                const row = make('div', 'dbmn-saved-row');
                if (now && now === s) row.classList.add('is-current');
                if (this._mode && this._mode.kind === 'rename' && this._mode.index === index) {
                    row.append(this._nameForm(s.name, 'Save', name => this._rename(index, name), index));
                } else if (this._mode && this._mode.kind === 'delete' && this._mode.index === index) {
                    row.classList.add('is-deleting');
                    row.append(make('span', 'dbmn-saved-ask', `Delete ${s.name}?`));
                    const yes = make('button', 'dbmn-saved-confirm is-danger', 'Delete');
                    yes.type = 'button';
                    yes.addEventListener('click', () => this._delete(index));
                    const no = make('button', 'dbmn-saved-confirm', 'Keep');
                    no.type = 'button';
                    no.addEventListener('click', () => { this._mode = null; this._drawMenu(); });
                    row.append(yes, no);
                    setTimeout(() => no.focus(), 0);
                } else {
                    const pick = make('button', 'dbmn-saved-pick');
                    pick.type = 'button';
                    pick.append(make('span', 'dbmn-saved-name', s.name), make('span', 'dbmn-saved-text', s.text));
                    pick.title = `Search ${s.text}`;
                    pick.addEventListener('click', () => this._pick(s));
                    const edit = make('button', 'dbmn-saved-icon');
                    edit.type = 'button';
                    edit.innerHTML = icon('pencil');
                    edit.title = `Rename ${s.name}`;
                    edit.setAttribute('aria-label', `Rename ${s.name}`);
                    edit.addEventListener('click', () => { this._mode = { kind: 'rename', index }; this._problem = ''; this._drawMenu(); });
                    const del = make('button', 'dbmn-saved-icon');
                    del.type = 'button';
                    del.innerHTML = icon('x');
                    del.title = `Delete ${s.name}`;
                    del.setAttribute('aria-label', `Delete ${s.name}`);
                    del.addEventListener('click', () => { this._mode = { kind: 'delete', index }; this._drawMenu(); });
                    row.append(pick, edit, del);
                }
                list.append(row);
            });
            menu.append(list);
        }

        /** A name box with its button: Enter keeps, Esc goes back; a problem is said under it. */
        _nameForm(value, label, done, skip) {
            const form = make('form', 'dbmn-saved-form');
            const box = make('input', 'dbmn-saved-name-input');
            box.type = 'text';
            box.value = value || '';
            box.maxLength = MAX_NAME;
            box.placeholder = 'Name';
            box.setAttribute('aria-label', 'Name');
            box.setAttribute('autocomplete', 'off');
            box.setAttribute('data-1p-ignore', 'true');
            box.setAttribute('data-lpignore', 'true');
            box.spellcheck = false;
            const ok = make('button', 'dbmn-saved-confirm is-primary', label);
            ok.type = 'submit';
            const problem = make('div', 'dbmn-saved-problem', this._problem);
            problem.setAttribute('role', 'alert');
            form.append(box, ok, problem);
            form.addEventListener('submit', e => {
                e.preventDefault();
                const name = clean(box.value);
                const why = !name ? 'Give it a name'
                    : name.length > MAX_NAME ? `At most ${MAX_NAME} characters`
                    : this._searches.some((s, i) => i !== skip && same(s.name, name)) ? `A search called ${name} is saved already`
                    : '';
                if (why) { this._problem = why; problem.textContent = why; box.focus(); return; }
                this._problem = '';
                done(name);
            });
            setTimeout(() => { box.focus(); box.select(); }, 0);
            return form;
        }

        /** A name to start from: the search's first words. */
        _suggestName() {
            return clean(this._current.replace(/[@"]/g, ' ')).slice(0, MAX_NAME).trim();
        }

        _changed(list) {
            this._searches = list;
            this._mode = null;
            this._drawButton();
            this._drawMenu();
            // (the box it was typed in is gone: the keys stay in the menu, so Esc still closes it)
            const next = this._menu.querySelector('button:not([disabled])');
            if (next) next.focus(); else this._button.focus();
            this.dispatchEvent(new CustomEvent('dbmn-saved-change', { bubbles: true, detail: { searches: this.searches } }));
        }
        _save(name) {
            if (!this._current || this._searches.length >= MAX_SEARCHES) return;
            this._changed(this._searches.concat([{ name, text: this._current }]));
        }
        _rename(index, name) {
            this._changed(this._searches.map((s, i) => (i === index ? { name, text: s.text } : s)));
        }
        _delete(index) {
            this._changed(this._searches.filter((_s, i) => i !== index));
        }
        _pick(search) {
            const asked = new CustomEvent('dbmn-saved-pick', { bubbles: true, cancelable: true, detail: { name: search.name, text: search.text } });
            const go = this.dispatchEvent(asked);
            this.close(false);
            if (go && this._input) {
                this._input.value = search.text;
                this._input.dispatchEvent(new Event('input', { bubbles: true }));
                this._input.focus();
            } else if (!this._input) {
                this.current = search.text;
            }
        }
    }

    customElements.define('dbmn-saved-searches', DbmnSavedSearches);
})();
