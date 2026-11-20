// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Column Head: what a results table's heading does, the same in every table.
 *
 *   the name      drags the column to another place (column-drag.js)
 *   the sort icon sorts: A to Z / Z to A for text, 0 to 1 / 1 to 0 for numbers; a clock while
 *                 the sorted rows are on their way
 *   x             takes the column out
 *   the right edge resizes the column; a double-click fits it to what is on screen
 *   a right-click lists all of it by name
 *
 * This file makes the controls and wires the edge and the menu; what a sort, a move or a width
 * *does* is the table's own (callbacks). Styles: column-head.css. Needs icons.js, and
 * dbmn-context-menu.js for the menu.
 *
 * UI only — no VS Code API. Used by: Query's Results, Compare's Results, the Console.
 */
(function () {
    'use strict';

    const MIN_WIDTH = 40;
    /** The room a heading's two icons take (sort and x), when they cannot be measured. */
    const ICONS_WIDTH = 40;
    const MAX_FIT = 900;

    function el(tagName, className, content) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
    }
    function inject(node) { if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(node); }

    /** The order's words for a column of numbers, or of text. */
    function words(numbers) { return numbers ? ['smallest first', 'largest first'] : ['A to Z', 'Z to A']; }
    function sortIconName(dir, numbers) {
        return dir === 'desc' ? (numbers ? 'arrow-down-1-0' : 'arrow-down-z-a') : (numbers ? 'arrow-down-0-1' : 'arrow-down-a-z');
    }

    /**
     * The sort button. Its icon says the order the rows are in; unsorted, the one a click gives.
     * @param {{ label: string, numbers?: boolean, dir?: 'asc'|'desc'|'' }} opts
     */
    function sortButton(opts) {
        const button = el('button', 'col-sort-btn');
        button.type = 'button';
        button.dataset.label = opts.label || '';
        setSort(button, opts.dir || '', !!opts.numbers);
        return button;
    }
    /** Set (or change) what a sort button shows. */
    function setSort(button, dir, numbers) {
        const icon = el('span', 'col-sort-icon');
        icon.dataset.icon = sortIconName(dir, numbers);
        button.replaceChildren(icon);
        const w = words(numbers);
        button.title = dir === 'asc' ? `Sorted ${w[0]}. Click for ${w[1]}` : dir === 'desc' ? `Sorted ${w[1]}. Click to clear the sort` : `Sort ${w[0]}`;
        button.setAttribute('aria-label', `${button.title}: ${button.dataset.label}`);
        button.classList.toggle('is-sorted', !!dir);
        // Drawn again: a sort that was on its way has arrived
        button.classList.remove('is-sorting');
        inject(button);
    }
    /** The click is answered at once: the icon is a ticking clock until the heading is drawn again. */
    function wait(button, dir) {
        if (!button) return;
        const clock = el('span', 'col-sort-wait');
        clock.dataset.icon = dir === 'desc' ? 'clock-arrow-down' : 'clock-arrow-up';
        button.appendChild(clock);
        button.classList.add('is-sorting');
        const th = button.closest('th');
        if (th) th.classList.add('is-sorting');
        inject(button);
    }

    /** x: takes the column out. */
    function hideButton(opts) {
        const button = el('button', 'col-hide-btn');
        button.type = 'button';
        if (window.Icons && window.Icons.setIcon) window.Icons.setIcon(button, 'x'); else button.dataset.icon = 'x';
        button.title = opts.title || 'Remove this column';
        button.setAttribute('aria-label', `Remove ${opts.label || 'this column'}`);
        return button;
    }

    /** The right edge of a heading: a wide place to take hold of. Goes last in the th. */
    function edge() {
        const node = el('span', 'col-edge');
        node.title = 'Drag to resize. Double-click to fit what is on screen';
        return node;
    }

    /** How wide some text is, drawn as a node draws it. */
    let pen = null;
    function textWidth(node, text) {
        pen = pen || document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(node);
        pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return Math.ceil(pen.measureText(String(text == null ? '' : text)).width);
    }

    /**
     * Before a column is resized in a table that fits its columns to what they hold: every
     * column is held at the width it has now, and the table stops stretching to fill its
     * window. Without this, a table narrower than its window shares the spare room out again
     * and the columns beside the one being resized change too. The table's own redraw of its
     * headings lets go (it clears `table.style.width`).
     */
    function holdWidths(table) {
        if (table.dataset.widthsHeld === '1' && table.style.width === 'auto') return;
        const set = [];
        table.querySelectorAll(':scope > thead th').forEach(th => {
            if (th.colSpan !== 1 || th.style.maxWidth) return;
            const css = getComputedStyle(th);
            set.push([th, th.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)]);
        });
        set.forEach(([th, w]) => { th.style.minWidth = `${Math.max(0, w)}px`; });
        table.style.width = 'auto';
        table.dataset.widthsHeld = '1';
    }

    /** The line being pulled, lit the whole height of the table while a column is resized. */
    function guideFor(grip) {
        const guide = el('div', 'col-size-guide');
        document.body.appendChild(guide);
        placeGuide(guide, grip);
        return guide;
    }
    function placeGuide(guide, grip) {
        const edge = grip.getBoundingClientRect();
        const table = grip.closest('table');
        // As far down as the table shows: its own foot, or the foot of the box it scrolls in
        let bottom = table ? table.getBoundingClientRect().bottom : edge.bottom;
        for (let box = table && table.parentElement; box && box !== document.body; box = box.parentElement) {
            const flow = getComputedStyle(box).overflowY;
            if (flow === 'auto' || flow === 'scroll' || flow === 'hidden') bottom = Math.min(bottom, box.getBoundingClientRect().bottom);
        }
        bottom = Math.min(bottom, window.innerHeight);
        guide.style.left = `${Math.round(edge.right) - 1}px`;
        guide.style.top = `${Math.round(edge.top)}px`;
        guide.style.height = `${Math.max(0, Math.round(bottom - edge.top))}px`;
    }

    /** A heading too narrow for its name and its icons is marked (col-narrow), as its width changes and as headings are redrawn. */
    function watchNarrow(head) {
        if (typeof ResizeObserver !== 'function' || head.dataset.narrowWatched) return;
        head.dataset.narrowWatched = '1';
        // Narrow: the name does not fit beside the icons. Then the name has the room, and the
        // right-click menu has what the icons did
        const sizes = new ResizeObserver(entries => entries.forEach(entry => {
            const th = entry.target;
            const name = th.querySelector('.column-name');
            if (!name || !th.clientWidth) return;
            const css = getComputedStyle(th);
            // The icons' own width, measured while they are there (hidden, they have none) and kept
            const shown = Array.from(th.querySelectorAll('.col-sort-btn, .col-hide-btn')).reduce((sum, b) => sum + b.offsetWidth, 0);
            if (shown > (Number(th.dataset.iconsWidth) || 0)) th.dataset.iconsWidth = String(shown);
            const icons = Number(th.dataset.iconsWidth) || ICONS_WIDTH;
            const estimate = textWidth(name, name.textContent) + icons + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
            if (!th.classList.contains('col-narrow')) {
                // The icons go before any of the name does: as soon as the name is cut short
                // (measured), or would be by the estimate. (A few pixels' grace: a column sized to
                // what it holds is never called narrow)
                const cut = name.scrollWidth - name.clientWidth;
                if (cut > 0 || th.clientWidth + 4 < estimate) {
                    // The width at which name and icons both fit again
                    th.dataset.wholeAt = String(Math.max(estimate, th.clientWidth + Math.max(0, cut)));
                    th.classList.add('col-narrow');
                }
            } else if (th.clientWidth >= (Number(th.dataset.wholeAt) || estimate)) {
                th.classList.remove('col-narrow');
            }
        }));
        const watch = () => head.querySelectorAll('th').forEach(th => sizes.observe(th));
        new MutationObserver(watch).observe(head, { childList: true, subtree: true });
        watch();
    }

    /**
     * The edges of a heading row resize their columns.
     * @param {HTMLElement} head  the thead
     * @param {{ canResize?: (th) => boolean,
     *           hold?: HTMLTableElement,                 a table that fits its columns to their content: see holdWidths
     *           widthOf: (th) => number,                 the column's width now
     *           setWidth: (th, width) => number,         set it (live, while dragging); returns the width set
     *           done?: (th, width) => void,              the drag ended: keep it
     *           fit?: (th) => void }} opts               double-click
     */
    function attachResize(head, opts) {
        let sizing = null;
        watchNarrow(head);
        head.addEventListener('pointerdown', event => {
            const grip = event.target.closest && event.target.closest('.col-edge');
            if (!grip || event.button !== 0) return;
            const th = grip.closest('th');
            if (!th || (opts.canResize && !opts.canResize(th))) return;
            event.preventDefault();
            event.stopPropagation();
            if (opts.hold) holdWidths(opts.hold);
            sizing = { th, x: event.clientX, from: opts.widthOf(th), width: 0, grip, guide: guideFor(grip) };
            try { grip.setPointerCapture(event.pointerId); } catch (error) { /* a pointer already gone */ }
            grip.classList.add('is-sizing');
            document.body.classList.add('col-sizing');
        });
        head.addEventListener('pointermove', event => {
            if (!sizing) return;
            sizing.width = opts.setWidth(sizing.th, Math.max(MIN_WIDTH, Math.round(sizing.from + event.clientX - sizing.x)));
            placeGuide(sizing.guide, sizing.grip);
        });
        const end = () => {
            if (!sizing) return;
            sizing.grip.classList.remove('is-sizing');
            sizing.guide.remove();
            document.body.classList.remove('col-sizing');
            if (sizing.width && opts.done) opts.done(sizing.th, sizing.width);
            sizing = null;
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
        head.addEventListener('dblclick', event => {
            const grip = event.target.closest && event.target.closest('.col-edge');
            const th = grip && grip.closest('th');
            if (th && opts.fit && (!opts.canResize || opts.canResize(th))) {
                if (opts.hold) holdWidths(opts.hold);
                // Fitted with its icons there: a narrow heading comes back whole
                th.classList.remove('col-narrow');
                opts.fit(th);
            }
        });
        // The edge is never a click on the heading (a sort, a drag)
        head.addEventListener('click', event => {
            if (event.target.closest && event.target.closest('.col-edge')) event.stopPropagation();
        }, true);
    }

    /**
     * Right-click a heading: everything it can do, by name. Leave a callback out and its items
     * are not offered.
     * @param {Event} event
     * @param {{ numbers?: boolean, dir?: string, sorted?: boolean, first?: boolean, last?: boolean,
     *           sort?: (dir: 'asc'|'desc'|null) => void, move?: (where: 'start'|'end') => void,
     *           fit?: () => void, remove?: () => void, removeLabel?: string }} opts
     */
    function menu(event, opts) {
        if (!window.DbmnContextMenu) return;
        const w = words(!!opts.numbers);
        const items = [];
        const part = list => { if (list.length) { if (items.length) items.push({ separator: true }); items.push(...list); } };
        if (opts.sort) part([
            { id: 'asc', label: `Sort ${w[0]}`, icon: sortIconName('asc', opts.numbers), disabled: opts.dir === 'asc' },
            { id: 'desc', label: `Sort ${w[1]}`, icon: sortIconName('desc', opts.numbers), disabled: opts.dir === 'desc' },
            { id: 'clear', label: 'Clear the sort', icon: 'x', disabled: !opts.sorted }
        ]);
        const place = [];
        if (opts.move) place.push({ id: 'start', label: 'Move to start', icon: 'chevrons-left', disabled: !!opts.first }, { id: 'end', label: 'Move to end', icon: 'chevrons-right', disabled: !!opts.last });
        if (opts.fit) place.push({ id: 'fit', label: 'Fit width', icon: 'move-horizontal' });
        part(place);
        // The screen's own (an editable table's Rename, Add a column, Delete): { id, label, icon, danger, run }
        const extra = Array.isArray(opts.extra) ? opts.extra : [];
        part(extra.map(({ id, label, icon, danger }) => ({ id: `extra:${id}`, label, icon, danger })));
        if (opts.remove) part([{ id: 'remove', label: opts.removeLabel || 'Remove column', icon: 'x', danger: true }]);
        if (!items.length) return;
        window.DbmnContextMenu.show(event, items, id => {
            const own = extra.find(item => `extra:${item.id}` === id);
            if (own) { own.run(); return; }
            if (id === 'asc' || id === 'desc') opts.sort(id);
            else if (id === 'clear') opts.sort(null);
            else if (id === 'start' || id === 'end') opts.move(id);
            else if (id === 'fit') opts.fit();
            else if (id === 'remove') opts.remove();
        });
    }

    window.ColumnHead = { sortButton, setSort, wait, hideButton, edge, textWidth, holdWidths, attachResize, menu, MIN_WIDTH, MAX_FIT };
})();
