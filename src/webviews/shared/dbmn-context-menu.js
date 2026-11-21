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
 *
 * Opened from a button instead of a right-click: pass the button (an Element) for the event, and
 * the menu opens under it (above it when there is no room below), the first item focused.
 * An item may show a picture (`glyph`: an Element, in place of `icon`), a quieter second line
 * (`detail`: the label is then bold), and be the one chosen now (`checked`):
 *
 *   DbmnContextMenu.show(button, [
 *       { id: 'left', label: 'Left join', detail: 'All of Stock; Counts where it matches',
 *         glyph: RelationGlyph.join('left'), checked: true }, …
 *   ], id => …);
 *
 * What the menu is about can come first (`summary`): a title, then names and values in two columns,
 * read only (arrows and Enter skip it). A line with `tone: 'warn'` (set on the pair) shows in the warning colour:
 *
 *   const ran = ['Read', '13 Nov · 9 days ago']; ran.tone = 'warn';
 *   DbmnContextMenu.show(slot, [
 *       { summary: { title: 'BL · inventory', lines: [['Request', 'GET /inventory'], ran, ['Rows', '105,010']] } },
 *       { separator: true },
 *       { id: 'refresh', label: 'Read again', icon: 'refresh-cw' }, …
 *   ], id => …);
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

    /** What the menu is about: a title, then names and values in two columns. Read, never chosen (not focusable). */
    function summaryOf(summary) {
        const box = document.createElement('div');
        box.className = 'dbmn-context-menu-summary' + (summary.tone === 'warn' ? ' is-warn' : '');
        box.setAttribute('role', 'presentation');
        if (summary.title) {
            const title = document.createElement('div');
            title.className = 'dbmn-context-menu-summary-title';
            title.textContent = summary.title;
            box.appendChild(title);
        }
        const list = document.createElement('dl');
        list.className = 'dbmn-context-menu-summary-lines';
        (summary.lines || []).forEach(line => {
            if (!Array.isArray(line)) return;
            const name = document.createElement('dt');
            name.textContent = line[0] == null ? '' : String(line[0]);
            const value = document.createElement('dd');
            value.textContent = line[1] == null ? '' : String(line[1]);
            // (a line to notice: the data's age when it is over a week)
            if (line.tone === 'warn') { name.classList.add('is-warn'); value.classList.add('is-warn'); }
            list.append(name, value);
        });
        box.appendChild(list);
        return box;
    }

    function show(event, items, onChoose) {
        close();
        // (opened from a button: the button, not an event)
        const anchor = event instanceof Element ? event : null;
        if (anchor) event = null;
        if (event && event.preventDefault) event.preventDefault();
        const menu = document.createElement('div');
        menu.className = 'dbmn-context-menu';
        menu.setAttribute('role', 'menu');
        items.forEach(item => {
            if (item.summary) { menu.appendChild(summaryOf(item.summary)); return; }
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'dbmn-context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'dbmn-context-menu-item' + (item.danger ? ' is-danger' : '') + (item.detail ? ' has-detail' : '');
            el.dataset.action = item.id;
            if (typeof item.checked === 'boolean') {
                el.setAttribute('role', 'menuitemradio');
                el.setAttribute('aria-checked', String(item.checked));
            } else el.setAttribute('role', 'menuitem');
            if (item.disabled) el.setAttribute('aria-disabled', 'true');
            if (item.title) el.title = item.title;
            const icon = item.icon && window.Icons ? '<span class="dbmn-context-menu-icon">' + window.Icons.icon(item.icon) + '</span>' : '';
            el.innerHTML = icon + '<span class="dbmn-context-menu-label"></span>';
            el.querySelector('.dbmn-context-menu-label').textContent = item.label;
            if (item.glyph instanceof Element) {
                const pic = document.createElement('span');
                pic.className = 'dbmn-context-menu-glyph';
                pic.appendChild(item.glyph);
                el.prepend(pic);
            }
            if (item.detail) {
                const text = document.createElement('span');
                text.className = 'dbmn-context-menu-text';
                const detail = document.createElement('span');
                detail.className = 'dbmn-context-menu-detail';
                detail.textContent = item.detail;
                const label = el.querySelector('.dbmn-context-menu-label');
                label.replaceWith(text);
                text.append(label, detail);
            }
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

        // At the pointer, or under the button it was opened from (above it with no room below); on screen
        const rect = menu.getBoundingClientRect();
        let x, y;
        if (anchor) {
            const at = anchor.getBoundingClientRect();
            x = at.left;
            y = at.bottom + 4 + rect.height <= window.innerHeight - 4 ? at.bottom + 4 : at.top - 4 - rect.height;
            menu.classList.add('is-anchored');
        } else {
            x = event && typeof event.clientX === 'number' ? event.clientX : 0;
            y = event && typeof event.clientY === 'number' ? event.clientY : 0;
        }
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';

        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', close);
        window.addEventListener('scroll', close, true);
        (menu.querySelector('.dbmn-context-menu-item[aria-checked="true"]') || menu.querySelector('.dbmn-context-menu-item'))?.focus();
        return menu;
    }

    // (`takesSummary`: a screen may send a `{ summary }` item first; one that checks for it draws nothing empty before)
    window.DbmnContextMenu = { show, close, takesSummary: true, get isOpen() { return !!current; } };
})();
