// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Virtual Window (GitHub Issue #287)
 *
 * Windowing maths for the console Report table's virtual scroll: which rows to
 * render for a scroll position, when a re-render is needed, and how tall the
 * spacers above/below the rendered rows must be.
 *
 * Overscan is sized in PIXELS, not rows. The old row-count buffer assumed a
 * 30px row; real rows render ~19px, so almost no buffer existed below the
 * viewport and scrolling showed blank space until the next render.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and can
 * run in both the webview (window global) and Node (module.exports).
 *
 * Used by:
 * - Frontend (console.html) — updateVirtualRows()
 */

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.VirtualWindow = api;
    }
})(this, function () {
    'use strict';

    // Guard against an unmeasured (0) or invalid row height.
    function safeRowHeight(rowHeight) {
        return rowHeight > 0 ? rowHeight : 1;
    }

    function clampScrollTop(scrollTop, viewportHeight, rowHeight, totalRows) {
        const maxScrollTop = Math.max(0, totalRows * rowHeight - viewportHeight);
        return Math.min(Math.max(0, scrollTop || 0), maxScrollTop);
    }

    /**
     * Row range to render for a scroll position. The larger overscan goes in
     * the direction of travel; with no known direction it goes on both sides.
     *
     * @param {{ scrollTop: number, viewportHeight: number, rowHeight: number, totalRows: number,
     *           overscanAhead: number, overscanBehind: number, direction: number }} opts
     * @returns {{ start: number, end: number }} end is exclusive
     */
    function computeWindow(opts) {
        const totalRows = opts.totalRows;
        if (!(totalRows > 0)) return { start: 0, end: 0 };
        const rowHeight = safeRowHeight(opts.rowHeight);
        const viewportHeight = Math.max(0, opts.viewportHeight || 0);
        const top = clampScrollTop(opts.scrollTop, viewportHeight, rowHeight, totalRows);
        const above = opts.direction > 0 ? opts.overscanBehind : opts.overscanAhead;
        const below = opts.direction < 0 ? opts.overscanBehind : opts.overscanAhead;
        return {
            start: Math.max(0, Math.floor((top - above) / rowHeight)),
            end: Math.min(totalRows, Math.ceil((top + viewportHeight + below) / rowHeight)),
        };
    }

    /**
     * Whether the rendered rows no longer leave at least `marginPx` of content
     * beyond either edge of the viewport. Edges that are already the start or
     * end of the data never need more rows.
     *
     * @param {{ rendered: { start: number, end: number }, scrollTop: number, viewportHeight: number,
     *           rowHeight: number, totalRows: number, marginPx: number }} opts
     * @returns {boolean}
     */
    function needsRender(opts) {
        const rendered = opts.rendered;
        if (!rendered || rendered.start < 0 || rendered.end < 0) return true;
        const totalRows = Math.max(0, opts.totalRows || 0);
        const rowHeight = safeRowHeight(opts.rowHeight);
        const viewportHeight = Math.max(0, opts.viewportHeight || 0);
        const top = clampScrollTop(opts.scrollTop, viewportHeight, rowHeight, totalRows);
        const bottom = top + viewportHeight;
        const nearTop = rendered.start > 0 && top - rendered.start * rowHeight < opts.marginPx;
        const nearBottom = rendered.end < totalRows && rendered.end * rowHeight - bottom < opts.marginPx;
        return nearTop || nearBottom;
    }

    /**
     * Spacer heights that stand in for the unrendered rows above and below.
     *
     * @param {{ start: number, end: number, totalRows: number, rowHeight: number }} opts
     * @returns {{ top: number, bottom: number }}
     */
    function paddings(opts) {
        const rowHeight = safeRowHeight(opts.rowHeight);
        return {
            top: Math.max(0, opts.start) * rowHeight,
            bottom: Math.max(0, opts.totalRows - opts.end) * rowHeight,
        };
    }

    /**
     * Mean of measured row heights, ignoring rows that measured 0 or NaN
     * (detached or hidden). Returns `fallback` when nothing usable remains.
     *
     * @param {number[]} heights
     * @param {number} fallback
     * @returns {number}
     */
    function averageRowHeight(heights, fallback) {
        const usable = (heights || []).filter(h => Number.isFinite(h) && h > 0);
        if (usable.length === 0) return fallback;
        return usable.reduce((sum, h) => sum + h, 0) / usable.length;
    }

    return { computeWindow, needsRender, paddings, averageRowHeight };
});
