// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Template autocomplete for plain text fields: an endpoint's path, query parameter values and
 * header values, and an environment's header values. Typing `{{` opens a short list (the
 * environment's variables as `ENV:name`, the generated ones as `A8:…`, and whatever else the page
 * offers); picking one writes `{{value}}` and puts the caret after it. The body editor has its
 * own, Monaco's (template-completions.js); this is the same idea for an <input>.
 *
 *   TemplateAutocomplete.attach({ selector: '#endpointPath, .header-value', suggestions: () => [
 *       { value: 'ENV:region', detail: 'en', group: 'Environment' }, ...
 *   ], empty: { Environment: 'No environment variables yet' } });
 *
 * Event delegation from the document, so rows added later are covered. No inline handlers (the
 * web app's Content Security Policy refuses them).
 */
(function () {
    'use strict';
    if (window.TemplateAutocomplete) return;

    const POPUP_ID = 'tpl-ac-popup';
    let config = null;
    let active = null;          // the input the list belongs to
    let items = [];             // { value, detail, group } shown, in order
    let selected = 0;
    let measurer = null;

    function popup() {
        let el = document.getElementById(POPUP_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = POPUP_ID;
            el.className = 'tpl-ac hidden';
            el.setAttribute('role', 'listbox');
            // Keep focus in the field while picking with the mouse
            el.addEventListener('mousedown', function (event) { event.preventDefault(); });
            el.addEventListener('click', function (event) {
                const row = event.target.closest('[data-ac-index]');
                if (row) accept(Number(row.dataset.acIndex));
            });
            document.body.appendChild(el);
        }
        return el;
    }

    /** The open `{{` before the caret and what has been typed since, or null. */
    function openTemplate(input) {
        const caret = input.selectionStart;
        if (caret === null || caret !== input.selectionEnd) return null;
        const before = input.value.slice(0, caret);
        const open = before.lastIndexOf('{{');
        if (open < 0) return null;
        const typed = before.slice(open + 2);
        if (typed.indexOf('}}') >= 0 || !/^[\w:.|-]*$/.test(typed)) return null;
        return { open: open, typed: typed, caret: caret };
    }

    function close() {
        const el = document.getElementById(POPUP_ID);
        if (el) el.classList.add('hidden');
        active = null;
        items = [];
    }

    /** Pixel offset of the caret inside the input, so the list sits under what is being typed. */
    function caretX(input, caret) {
        if (!measurer) measurer = document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(input);
        measurer.font = style.font || (style.fontSize + ' ' + style.fontFamily);
        const width = measurer.measureText(input.value.slice(0, caret)).width;
        return parseFloat(style.paddingLeft || '0') + width - input.scrollLeft;
    }

    function render(input, found) {
        const all = (config.suggestions() || []);
        const typed = found.typed.toLowerCase();
        // From the start of the value, or of the part after its colon: "EN" finds ENV:…, "reg"
        // finds ENV:region, and "en" does not pick A8:sequence out of the middle of a word
        items = all.filter(function (s) {
            const value = s.value.toLowerCase();
            const afterColon = value.slice(value.indexOf(':') + 1);
            return !typed || value.indexOf(typed) === 0 || afterColon.indexOf(typed) === 0;
        });
        const el = popup();
        el.innerHTML = '';
        const groups = [];
        all.forEach(function (s) { if (groups.indexOf(s.group) < 0) groups.push(s.group); });
        Object.keys(config.empty || {}).forEach(function (g) { if (groups.indexOf(g) < 0) groups.push(g); });
        let shown = 0;
        groups.forEach(function (group) {
            const rows = items.filter(function (s) { return s.group === group; });
            const emptyText = config.empty && config.empty[group];
            if (rows.length === 0 && !(emptyText && !typed && !all.some(function (s) { return s.group === group; }))) return;
            const head = document.createElement('div');
            head.className = 'tpl-ac-group';
            head.textContent = group;
            el.appendChild(head);
            if (rows.length === 0) {
                const none = document.createElement('div');
                none.className = 'tpl-ac-empty';
                none.textContent = emptyText;
                el.appendChild(none);
                return;
            }
            rows.forEach(function (s) {
                const index = items.indexOf(s);
                const row = document.createElement('div');
                row.className = 'tpl-ac-item' + (index === selected ? ' is-selected' : '');
                row.dataset.acIndex = String(index);
                row.setAttribute('role', 'option');
                const value = document.createElement('span');
                value.className = 'tpl-ac-value';
                value.textContent = '{{' + s.value + '}}';
                row.appendChild(value);
                if (s.detail) {
                    const detail = document.createElement('span');
                    detail.className = 'tpl-ac-detail';
                    detail.textContent = s.detail;
                    row.appendChild(detail);
                }
                el.appendChild(row);
                shown++;
            });
        });
        if (el.childElementCount === 0) { close(); return; }
        if (selected >= items.length) selected = Math.max(0, items.length - 1);
        const rect = input.getBoundingClientRect();
        const x = Math.min(rect.left + caretX(input, found.caret), window.innerWidth - 300);
        el.style.left = Math.max(8, x) + 'px';
        el.style.top = (rect.bottom + 2) + 'px';
        el.classList.remove('hidden');
        active = input;
        return shown;
    }

    function update(input) {
        const found = openTemplate(input);
        if (!found) { close(); return; }
        if (active !== input) selected = 0;
        render(input, found);
    }

    function accept(index) {
        const input = active;
        const choice = items[index];
        if (!input || !choice) return;
        const found = openTemplate(input);
        if (!found) { close(); return; }
        let after = input.value.slice(found.caret);
        // A closing `}}` already typed (or left from an earlier edit) is not doubled
        const closing = after.match(/^[\w:.|-]*\}\}/);
        if (closing) after = after.slice(closing[0].length);
        const inserted = '{{' + choice.value + '}}';
        input.value = input.value.slice(0, found.open) + inserted + after;
        const caret = found.open + inserted.length;
        input.setSelectionRange(caret, caret);
        close();
        // Change tracking and validation see it as typing
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function matches(target) {
        return config && target instanceof HTMLInputElement && target.matches(config.selector);
    }

    function attach(options) {
        config = options;
        document.addEventListener('input', function (event) {
            if (matches(event.target)) update(event.target);
        }, true);
        document.addEventListener('click', function (event) {
            if (matches(event.target)) update(event.target);
        }, true);
        document.addEventListener('keydown', function (event) {
            if (!active || event.target !== active) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (items.length === 0) return;
                selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                update(active);
            } else if ((event.key === 'Enter' || event.key === 'Tab') && items.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                accept(selected);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        }, true);
        document.addEventListener('focusout', function (event) {
            if (event.target === active) close();
        }, true);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
    }

    /** The generated values, the same list the body editor offers. */
    const GENERATED = [
        { value: 'A8:sequence', detail: 'Auto-incrementing sequence number' },
        { value: 'A8:date', detail: 'Current date (YYYYMMDD)' },
        { value: 'A8:datetime', detail: 'Current datetime (ISO 8601)' },
        { value: 'A8:PAGE', detail: 'Pagination page number' },
        { value: 'A8:SIZE', detail: 'Pagination page size' }
    ].map(function (s) { return Object.assign({ group: 'Generated' }, s); });

    window.TemplateAutocomplete = { attach: attach, close: close, GENERATED: GENERATED };
}());
