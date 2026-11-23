// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Join step's rules (James, 2026-11-23: "I enjoyed blocks but I must be able to delete it and play around with
 * it. So unjoined or unselected columns should block"):
 *  - Next (and the Columns and Results steps) wait while a view on show isn't joined: a join with no column, or a
 *    pair with a side still to pick. The words name the view. A hidden view holds nothing up (that is the way on
 *    without it; removing it on Views is the other).
 *  - Delete join is there for any join with something to delete; on a view not joined yet it is greyed and says so,
 *    and Hide this view is beside it.
 *  - Reset joins is there while any join has a column picked (it keeps each join's kind, so there is nothing else).
 *
 * Pure: no page, no host. Loaded by the page (window.QueryJoinRules) and by the core tests (module.exports).
 */
(function () {
    const picked = side => !!(side && side.column);
    /** A join that joins: at least one pair, every pair with both its columns. */
    const joins = join => !!join && (join.on || []).length > 0 && join.on.every(p => picked(p.left) && picked(p.right));
    /** A join with something to delete: a column picked anywhere in it, or a kind other than the plain one. */
    const hasAny = join => !!join && (join.kind !== 'left' || (join.on || []).some(p => picked(p.left) || picked(p.right)));

    /**
     * Why Next waits, in words, or '' when nothing does.
     * @param {{views: {id: string, name: string, off?: boolean}[], joins: {view: string, kind: string, on: object[]}[]}} state
     */
    function notJoined(state) {
        if (!state) return '';
        const shown = (state.views || []).filter(v => !v.off);
        if (shown.length < 2) return '';
        const waiting = shown.slice(1).find(v => !joins((state.joins || []).find(j => j.view === v.id)));
        return waiting ? `${waiting.name} isn't joined: pick the columns it joins on, or hide it.` : '';
    }

    /** A join's menu: Delete join, Reset joins, and whether Hide this view is offered (a view not joined). */
    function menu(state, join) {
        const view = (state.views || []).find(v => v.id === join.view) || { name: 'This view' };
        const any = (state.joins || []).some(j => (j.on || []).some(p => picked(p.left) || picked(p.right)));
        const can = hasAny(join);
        return {
            remove: { disabled: !can, detail: can ? '' : `${view.name} isn't joined yet: nothing to delete` },
            reset: { disabled: !any, detail: any ? 'Every join back to "Pick a column"' : 'No join has a column picked yet' },
            hide: !joins(join)
        };
    }

    const api = { notJoined, menu };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.QueryJoinRules = api;
})();
