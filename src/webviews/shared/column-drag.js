// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Column Drag: move a table's column by dragging its heading.
 *
 * The whole column lifts and follows the pointer, the columns it passes slide aside to show
 * where it will land, and on release it settles into the gap. Nothing is redrawn: the cells
 * already on screen are moved, so a table that renders a window of its rows moves a few dozen
 * cells however many rows it has. The caller is told the move afterwards (`onMove`) and keeps
 * its own data in step.
 *
 * While the pointer moves, only one CSS variable on the table changes (--col-dx); the cells
 * take their place from classes (column-drag.css).
 *
 * UI only — no VS Code API. Used by: Query's Results, Compare's Results, the Console.
 */
(function () {
    'use strict';

    const THRESHOLD = 5;      // px the pointer travels before a press is a drag (less is a click)
    const EDGE = 48;          // px from the scroller's side where it starts to scroll
    const SETTLE_MS = 140;
    const OUTSIDE = 60;       // px past the last place it can take before a release counts as "tried to leave"

    /**
     * @param {{ table: HTMLTableElement, scroller: HTMLElement,
     *           canDrag?: (th: HTMLTableCellElement, event: PointerEvent) => boolean,
     *           fixed?: (th: HTMLTableCellElement) => boolean,   a heading that never moves, and nothing moves past
     *           units?: (th) => { head: HTMLElement, cells: Element[], index?: number, last?: number, left?: number, width?: number }[],
     *                the places the pressed column can take, when not every heading is one (grouped or
     *                fixed columns). A unit can be several columns wide (a group the column moves past):
     *                it then gives its `left` and `width`. With `index` (and `last`, its last column) the
     *                cells are moved here, as by default; without, the table draws itself again in `onMove`.
     *           onOutside?: () => void,   the column was let go well outside the places it can take
     *           onMove: (from: number, to: number) => void,
     *           onEnd?: () => void }} opts
     * @returns {{ isDragging: () => boolean }}
     */
    function attach(opts) {
        const { table, scroller } = opts;
        let press = null;   // a heading held down, not yet a drag
        let drag = null;    // the drag under way

        /** Every row with a cell per column (a spacer row has one wide cell: left alone). */
        function rows(count) {
            return Array.from(table.rows).filter(r => r.cells.length === count);
        }

        /** The columns that can move, in order: each its heading and every cell on screen. By default every heading of the row pressed. */
        function unitsFor(th) {
            if (opts.units) return opts.units(th);
            const ths = Array.from(th.parentElement.cells);
            const all = rows(ths.length);
            // A heading the table says stays put (`fixed`) is no place to move to, or from
            return ths.map((head, i) => ({ head, index: i, cells: all.map(r => r.cells[i]) })).filter(u => !(opts.fixed && opts.fixed(u.head)));
        }

        function begin(event) {
            const units = unitsFor(press.th);
            // (pressed on a heading inside a unit, a column under a group's name: the whole unit moves)
            let from = units.findIndex(u => u.head === press.th);
            if (from < 0) from = units.findIndex(u => u.cells && u.cells.includes(press.th));
            if (from < 0 || units.length < 2) { press = null; return; }
            const lefts = units.map(u => (u.left === undefined ? u.head.offsetLeft : u.left));
            const widths = units.map(u => (u.width === undefined ? u.head.offsetWidth : u.width));
            // Headings that are no place for this column are dimmed while it is held
            const inPlay = new Set();
            units.forEach(u => { inPlay.add(u.head); u.cells.forEach(c => inPlay.add(c)); });
            const out = Array.from(press.th.parentElement.cells).filter(h => !inPlay.has(h));
            drag = {
                from, to: from, lefts, widths, units,
                startX: press.x, startScroll: scroller.scrollLeft, x: event.clientX,
                shifts: units.map(() => 0), frame: 0, pointerId: press.pointerId, out, outside: false,
                count: press.th.parentElement.cells.length
            };
            // The drag goes on when the pointer leaves the table, or the frame it is in
            try { press.th.setPointerCapture(press.pointerId); } catch (error) { /* a pointer already gone */ }
            press = null;
            table.style.setProperty('--col-w', `${widths[from]}px`);
            table.style.setProperty('--col-dx', '0px');
            table.classList.add('col-dragging');
            units[from].cells.forEach(c => c.classList.add('col-lift'));
            out.forEach(h => h.classList.add('col-out'));
            document.body.classList.add('col-drag-on');
            drag.frame = requestAnimationFrame(tick);
        }

        /** Where the dragged column is, and which place that makes it. */
        function place() {
            const d = drag;
            const w = d.widths[d.from];
            const last = d.lefts.length - 1;
            const min = -d.lefts[d.from];
            const max = d.lefts[last] + d.widths[last] - d.lefts[d.from] - w;
            const asked = d.x - d.startX + scroller.scrollLeft - d.startScroll;
            const dx = Math.min(max, Math.max(min, asked));
            d.outside = Math.abs(asked - dx) > OUTSIDE;
            table.style.setProperty('--col-dx', `${dx}px`);
            // Its place: after every other column whose middle its own middle has passed
            const centre = d.lefts[d.from] + dx + w / 2;
            let to = 0;
            d.lefts.forEach((left, j) => { if (j !== d.from && left + d.widths[j] / 2 < centre) to++; });
            // Held against either end, it takes the end place: a column wider than its neighbour
            // never gets its middle past theirs, and could not be made first (or last)
            if (dx <= min) to = 0;
            else if (dx >= max) to = last;
            if (to === d.to) return;
            d.to = to;
            d.shifts.forEach((was, j) => {
                const now = j === d.from ? 0 : j > d.from && j <= to ? -1 : j < d.from && j >= to ? 1 : 0;
                if (now === was) return;
                d.shifts[j] = now;
                d.units[j].cells.forEach(c => {
                    c.classList.toggle('col-shift-left', now === -1);
                    c.classList.toggle('col-shift-right', now === 1);
                });
            });
        }

        /** Each frame: scroll sideways near an edge, and keep the column under the pointer. */
        function tick() {
            if (!drag || drag.settling) return;
            const box = scroller.getBoundingClientRect();
            const near = drag.x < box.left + EDGE ? drag.x - (box.left + EDGE) : drag.x > box.right - EDGE ? drag.x - (box.right - EDGE) : 0;
            if (near) scroller.scrollLeft += Math.max(-24, Math.min(24, near / 2));
            place();
            drag.frame = requestAnimationFrame(tick);
        }

        function clear() {
            const d = drag;
            cancelAnimationFrame(d.frame);
            // Classes off with no slide back: the cells are where they belong now
            table.classList.add('col-still');
            table.classList.remove('col-dragging', 'col-settling');
            d.units.forEach(u => u.cells.forEach(c => c.classList.remove('col-lift', 'col-shift-left', 'col-shift-right')));
            d.out.forEach(h => h.classList.remove('col-out'));
            table.style.removeProperty('--col-dx');
            table.style.removeProperty('--col-w');
            document.body.classList.remove('col-drag-on');
            void table.offsetWidth;
            table.classList.remove('col-still');
            drag = null;
        }

        /**
         * The column goes to its place. By default its cells are moved here, in every row on screen
         * (and its <col>, when there is one); a table that names its own columns (`units`) draws
         * itself again in `onMove`.
         */
        function commit() {
            const { from, to, units, count, outside } = drag;
            // A table that names its units without saying which columns they are moves them itself
            const own = units[from].index === undefined;
            const a = units[from].index;
            const b = to > from && units[to].last !== undefined ? units[to].last : units[to].index;
            const move = parent => {
                const kids = parent.children;
                if (kids.length <= Math.max(a, b)) return;
                parent.insertBefore(kids[a], b > a ? kids[b].nextSibling : kids[b]);
            };
            if (to !== from && !own) {
                rows(count).forEach(move);
                Array.from(table.querySelectorAll('colgroup')).forEach(move);
            }
            clear();
            if (to !== from) opts.onMove(from, to);
            if (outside && opts.onOutside) opts.onOutside();
            if (opts.onEnd) opts.onEnd();
        }

        function release(cancelled) {
            const d = drag;
            if (!d || d.settling) return;
            cancelAnimationFrame(d.frame);
            // A quick flick can end before a frame has placed it
            if (!cancelled) place();
            d.settling = true;
            if (cancelled) { d.to = d.from; d.outside = false; }
            // Settle into the gap, then make it real
            let dx = 0;
            for (let j = d.from + 1; j <= d.to; j++) dx += d.widths[j];
            for (let j = d.to; j < d.from; j++) dx -= d.widths[j];
            if (cancelled) d.shifts.forEach((s, j) => { if (s) d.units[j].cells.forEach(c => c.classList.remove('col-shift-left', 'col-shift-right')); });
            table.classList.add('col-settling');
            table.style.setProperty('--col-dx', `${dx}px`);
            setTimeout(commit, SETTLE_MS);
        }

        table.addEventListener('pointerdown', event => {
            if (event.button !== 0 || drag) return;
            const th = event.target.closest && event.target.closest('thead th');
            if (!th || !table.contains(th) || event.target.closest('button, input, select, a')) return;
            // Which part of a heading drags is the table's to say (canDrag)
            if (opts.canDrag && !opts.canDrag(th, event)) return;
            press = { th, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        });
        window.addEventListener('pointermove', event => {
            if (press && event.pointerId === press.pointerId) {
                if (Math.abs(event.clientX - press.x) < THRESHOLD) return;
                begin(event);
            }
            if (drag && event.pointerId === drag.pointerId) {
                drag.x = event.clientX;
                event.preventDefault();
            }
        });
        window.addEventListener('pointerup', () => {
            press = null;
            if (!drag) return;
            // The release ends a drag: it is not also a click on the heading
            const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
            release(false);
        });
        window.addEventListener('pointercancel', () => { press = null; release(true); });
        window.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.preventDefault(); release(true); } });
        // A drag is the column's, never a text selection or the browser's own drag
        table.addEventListener('dragstart', event => { if (event.target.closest && event.target.closest('thead')) event.preventDefault(); });

        return { isDragging: () => !!drag };
    }

    window.ColumnDrag = { attach };
})();
