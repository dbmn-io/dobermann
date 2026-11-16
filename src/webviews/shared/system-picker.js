// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * SystemPicker — shared, console-styled dropdown for choosing a System
 * (and inline-creating a new one) inside the endpoint and environment editors.
 *
 * Matches the visual pattern of the console's "+ Create View…" dropdown:
 * a button that shows the current selection, a div-based popup with one row
 * per System, a divider line, then an "+ Add new System…" footer row.
 *
 * Why not a native <select>?
 *   A native <select> cannot show a separator between regular options and an
 *   action ("Add"). The action ends up looking like just another item.
 *
 * Usage
 *   const picker = SystemPicker.render(container, {
 *       onSelect:        (systemId) => { … },     // user picked a real System
 *       onAddRequested:  ()         => { … },     // user clicked the footer
 *       placeholder:     '-- Select System --'    // shown when no value
 *   });
 *   picker.setSystems([{id, name, scope?}, …], 'sys-1');  // populate / re-render; scope 'global': a Standard System
 *   picker.setSelected('sys-1');                  // change current selection
 *   picker.getSelected();                         // → 'sys-1' or undefined
 *   picker.setLocked(true);                       // shown, not changeable (#415: an environment's System after creation)
 */
(function () {
    'use strict';

    function render(container, opts) {
        opts = opts || {};
        const placeholder = opts.placeholder || '-- Select System --';

        // Each picker instance gets a unique id so multiple pickers on the
        // same page (e.g. future bulk-edit panes) don't clash.
        const id = 'system-picker-' + Math.random().toString(36).slice(2, 9);

        container.classList.add('system-picker');
        container.dataset.systemPickerId = id;
        container.innerHTML = `
            <button type="button" class="system-picker-button" aria-haspopup="listbox">
                <span class="system-picker-label">${escapeHtml(placeholder)}</span>
                <span class="system-picker-caret">▼</span>
            </button>
            <div class="system-picker-dropdown hidden" role="listbox"></div>
        `;

        const button = container.querySelector('.system-picker-button');
        const label = container.querySelector('.system-picker-label');
        const dropdown = container.querySelector('.system-picker-dropdown');

        // --- State -----------------------------------------------------------
        let systems = [];
        let selectedId;
        let locked = false;

        function open() {
            if (locked) return;
            dropdown.classList.remove('hidden');
            button.setAttribute('aria-expanded', 'true');
            // Close on outside click — bound once per open so we don't leak listeners.
            setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 0);
        }
        function close() {
            dropdown.classList.add('hidden');
            button.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', outsideClickHandler);
        }
        function outsideClickHandler(e) {
            if (!container.contains(e.target)) close();
        }

        button.addEventListener('click', (e) => {
            e.preventDefault();
            if (dropdown.classList.contains('hidden')) open();
            else close();
        });

        // --- Rendering -------------------------------------------------------
        // #415: the Standard Systems (set up by DBMN, scope 'global') under their own heading,
        // first; the user's own under "Your Systems". With no Standard Systems, no headings.
        function groupHeading(text) {
            const heading = document.createElement('div');
            heading.className = 'system-picker-group';
            heading.setAttribute('role', 'presentation');
            heading.textContent = text;
            dropdown.appendChild(heading);
        }

        function renderItems() {
            dropdown.innerHTML = '';

            const standard = systems.filter(s => s.scope === 'global');
            const own = systems.filter(s => s.scope !== 'global');
            if (standard.length) groupHeading('Standard Systems');
            standard.forEach(renderItem);
            if (standard.length && own.length) groupHeading('Your Systems');
            own.forEach(renderItem);
            renderFooter();
        }

        function renderItem(system) {
            const item = document.createElement('div');
            item.className = 'system-picker-item' + (system.id === selectedId ? ' current' : '');
            item.dataset.systemId = system.id;
            item.setAttribute('role', 'option');
            item.innerHTML = `
                <div class="system-picker-item-name">${escapeHtml(system.name)}</div>
            `;
            item.addEventListener('click', () => {
                selectedId = system.id;
                updateLabel();
                close();
                if (typeof opts.onSelect === 'function') opts.onSelect(system.id);
                renderItems();   // refresh '.current' highlight for next open
            });
            dropdown.appendChild(item);
        }

        function renderFooter() {
            // Divider — visible separator between System list and the action.
            const divider = document.createElement('div');
            divider.className = 'system-picker-divider';
            dropdown.appendChild(divider);

            const addRow = document.createElement('div');
            addRow.className = 'system-picker-item system-picker-add';
            addRow.setAttribute('role', 'option');
            addRow.innerHTML = `
                <div class="system-picker-item-name">+ Add new System…</div>
            `;
            addRow.addEventListener('click', () => {
                close();
                if (typeof opts.onAddRequested === 'function') opts.onAddRequested();
            });
            dropdown.appendChild(addRow);
        }

        function updateLabel() {
            const current = systems.find(s => s.id === selectedId);
            label.textContent = current ? current.name : placeholder;
            container.classList.toggle('system-picker-empty', !current);
        }

        // --- Public API ------------------------------------------------------
        const api = {
            setSystems(list, selectedSystemId) {
                systems = Array.isArray(list) ? list.slice() : [];
                if (selectedSystemId !== undefined) selectedId = selectedSystemId;
                if (selectedId && !systems.some(s => s.id === selectedId)) {
                    // Previously-selected System was removed — fall back to empty.
                    selectedId = undefined;
                }
                updateLabel();
                renderItems();
            },
            setSelected(systemId) {
                selectedId = systemId;
                updateLabel();
                renderItems();
            },
            getSelected() {
                return selectedId;
            },
            setLocked(value) {
                locked = !!value;
                if (locked) close();
                button.disabled = locked;
                container.classList.toggle('system-picker-locked', locked);
            }
        };

        renderItems();
        updateLabel();
        return api;
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    window.SystemPicker = { render };
})();
