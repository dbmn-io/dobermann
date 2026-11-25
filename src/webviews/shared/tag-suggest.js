// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #432: suggestions as a tag is typed, the way GitHub labels and Jira work (the WAI-ARIA
 * combobox pattern). Up to five tags already in use that match what's typed: ones that start
 * with it first, then ones that contain it. A tag already on the item isn't offered. "New tag"
 * is the last option while nothing in use matches it exactly.
 *
 * Keys: ↓/↑ move through the list (it opens on ↓ with nothing typed: the most used tags),
 * Enter or Tab picks the highlighted one, Escape closes the list. The first option is
 * highlighted, so Enter picks the closest match. Comma still adds exactly what's typed. A typed
 * tag that matches one in use, whatever its case, takes that tag's spelling.
 *
 * The tags in use come from the host (the endpoint editor's `tagsList`, most used first).
 */
(function () {
    'use strict';

    const LIMIT = 5;

    /** What to offer for `typed`: `{ tags: string[], create: string | null }`. Pure, for tests. */
    function suggest(known, typed, current, limit = LIMIT) {
        const query = String(typed || '').trim();
        const q = query.toLowerCase();
        const taken = new Set((current || []).map(t => String(t).toLowerCase()));
        const available = (known || []).filter(t => !taken.has(String(t).toLowerCase()));
        let tags;
        if (!q) {
            tags = available.slice(0, limit);
        } else {
            const starts = available.filter(t => t.toLowerCase().startsWith(q));
            const contains = available.filter(t => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q));
            tags = starts.concat(contains).slice(0, limit);
        }
        const exists = (known || []).some(t => t.toLowerCase() === q) || taken.has(q);
        return { tags, create: q && !exists ? query : null };
    }

    /** `typed` in the spelling of a tag already in use, if one matches whatever its case. */
    function canonical(known, typed) {
        const q = String(typed || '').trim();
        const match = (known || []).find(t => t.toLowerCase() === q.toLowerCase());
        return match || q;
    }

    let nextId = 1;

    /**
     * Turn `input` into a combobox. `getKnown()` → tags in use, `getCurrent()` → tags on the item,
     * `onPick(tag)` adds one (and clears the input). Returns `{ close }`.
     */
    function attach(input, { getKnown, getCurrent, onPick }) {
        const listId = `tag-suggest-${nextId++}`;
        const list = document.createElement('ul');
        list.id = listId;
        list.className = 'tag-suggest hidden';
        list.setAttribute('role', 'listbox');
        input.parentElement.appendChild(list);
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', listId);
        input.setAttribute('aria-expanded', 'false');

        let options = []; // { value, create }
        let active = -1;

        function close() {
            list.classList.add('hidden');
            list.textContent = '';
            options = [];
            active = -1;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        function highlight(index) {
            active = index;
            Array.from(list.children).forEach((li, i) => {
                const on = i === index;
                li.classList.toggle('active', on);
                li.setAttribute('aria-selected', on ? 'true' : 'false');
                if (on) {
                    input.setAttribute('aria-activedescendant', li.id);
                    if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        /** The tag as the chip it becomes (.tag-chip, as in the field), the typed text bold where it matches (text nodes, never HTML). */
        function chip(tag, query) {
            const el = document.createElement('span');
            el.className = 'tag-chip tag-suggest-chip';
            const at = query ? tag.toLowerCase().indexOf(query.toLowerCase()) : -1;
            if (at < 0) { el.textContent = tag; return el; }
            const b = document.createElement('strong');
            b.textContent = tag.slice(at, at + query.length);
            el.append(tag.slice(0, at), b, tag.slice(at + query.length));
            return el;
        }

        function open(showWhenEmpty) {
            const typed = input.value;
            if (!typed.trim() && !showWhenEmpty) { close(); return; }
            const { tags, create } = suggest(getKnown(), typed, getCurrent());
            options = tags.map(value => ({ value, create: false }));
            if (create) options.push({ value: create, create: true });
            if (options.length === 0) { close(); return; }
            list.textContent = '';
            options.forEach((option, i) => {
                const li = document.createElement('li');
                li.id = `${listId}-${i}`;
                li.className = option.create ? 'tag-suggest-option tag-suggest-create' : 'tag-suggest-option';
                li.setAttribute('role', 'option');
                if (option.create) {
                    const what = document.createElement('span');
                    what.className = 'tag-suggest-hint';
                    what.textContent = 'New tag ';
                    li.append(what, chip(option.value, ''));
                } else {
                    li.append(chip(option.value, typed.trim()));
                }
                // mousedown, not click: the input keeps focus (a blur would commit the typing)
                li.addEventListener('mousedown', e => { e.preventDefault(); pick(i); });
                list.appendChild(li);
            });
            list.classList.remove('hidden');
            input.setAttribute('aria-expanded', 'true');
            highlight(0);
        }

        function pick(index) {
            const option = options[index];
            if (!option) return;
            close();
            onPick(option.create ? canonical(getKnown(), option.value) : option.value);
        }

        input.addEventListener('input', () => open(false));
        input.addEventListener('keydown', e => {
            const isOpen = !list.classList.contains('hidden');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!isOpen) { open(true); return; }
                highlight((active + 1) % options.length);
            } else if (e.key === 'ArrowUp') {
                if (!isOpen) return;
                e.preventDefault();
                highlight((active - 1 + options.length) % options.length);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && isOpen && active >= 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pick(active);
            } else if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        });
        input.addEventListener('blur', close);
        // refresh(): the tags in use changed while the list is open (they arrive from the host after the field got
        // focus, and a fast typist's first letters come first): drawn again from them. A closed list stays closed
        const refresh = () => { if (!list.classList.contains('hidden')) open(true); };
        return { close, refresh };
    }

    const api = { suggest, canonical, attach, LIMIT };
    if (typeof window !== 'undefined') window.TagSuggest = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
