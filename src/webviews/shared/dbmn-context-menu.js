// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnContextMenu — a small right-click menu for DBMN webviews (Issue #314).
 *
 *   DbmnContextMenu.show(event, [
 *       { id: 'open', label: 'Open', icon: 'circle-play' },
 *       { separator: true },
 *       { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
 *   ], (id) => { ... });
 *
 * One menu at a time; closes on choice, Escape, outside click, scroll or blur.
 * Keyboard: arrows move, Enter chooses. Icons come from window.Icons.
 */
(function () {
    'use strict';
    let current = null;

    function close() {
        if (!current) return;
        current.remove();
        current = null;
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('scroll', close, true);
    }
    function onOutside(e) { if (current && !current.contains(e.target)) close(); }
    function onKey(e) {
        if (!current) return;
        const items = Array.from(current.querySelectorAll('.dbmn-context-menu-item:not([aria-disabled="true"])'));
        const at = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (items[at + 1] || items[0])?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (items[at - 1] || items[items.length - 1])?.focus(); }
        else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); items[at].click(); }
    }

    function show(event, items, onChoose) {
        close();
        if (event && event.preventDefault) event.preventDefault();
        const menu = document.createElement('div');
        menu.className = 'dbmn-context-menu';
        menu.setAttribute('role', 'menu');
        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'dbmn-context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'dbmn-context-menu-item' + (item.danger ? ' is-danger' : '');
            el.setAttribute('role', 'menuitem');
            el.dataset.action = item.id;
            if (item.disabled) el.setAttribute('aria-disabled', 'true');
            if (item.title) el.title = item.title;
            const icon = item.icon && window.Icons ? '<span class="dbmn-context-menu-icon">' + window.Icons.icon(item.icon) + '</span>' : '';
            el.innerHTML = icon + '<span class="dbmn-context-menu-label"></span>';
            el.querySelector('.dbmn-context-menu-label').textContent = item.label;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.disabled) return;
                close();
                if (typeof onChoose === 'function') onChoose(item.id);
            });
            menu.appendChild(el);
        });
        document.body.appendChild(menu);
        current = menu;

        // Position at the pointer, kept on screen
        const x = event && typeof event.clientX === 'number' ? event.clientX : 0;
        const y = event && typeof event.clientY === 'number' ? event.clientY : 0;
        const rect = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';

        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', close);
        window.addEventListener('scroll', close, true);
        menu.querySelector('.dbmn-context-menu-item')?.focus();
        return menu;
    }

    window.DbmnContextMenu = { show, close, get isOpen() { return !!current; } };
})();
