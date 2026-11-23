// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Join step's rules (James, 2026-11-23: "I enjoyed blocks but I must be able to delete it and play around with
 * it. So unjoined or unselected columns should block"):
 *  - Next (and the Columns and Results steps) wait while a view on show isn't joined: a join with no column, or a
 *    pair with a side still to pick. The words name the view. A hidden view holds nothing up (that is the way on
 *    without it; removing it on Views is the other).
 *  - Delete join is there on every line: a join with something in it goes back to not joined; an empty line goes
 *    (it was brought up by + Add join, or was the first). Hide this view is beside it on a view not joined.
 *  - Reset joins is there while any join has a column picked (it keeps each join's kind, so there is nothing else).
 *  - Which lines show (James, 2026-11-23: "an add join button… stop flipping and adding and removing the second
 *    join"): nothing appears or goes by itself. A line shows when its join is made, or when it was brought up
 *    (+ Add join) and not taken away. With nothing joined and nothing yet added or taken away, the first view not
 *    joined has its line, there being nothing else to do.
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
        return waiting ? `${waiting.name} isn't joined: add a join for it, or hide it.` : '';
    }

    /** A join's menu: Delete join, Reset joins, and whether Hide this view is offered (a view not joined). */
    function menu(state, join) {
        const any = (state.joins || []).some(j => (j.on || []).some(p => picked(p.left) || picked(p.right)));
        // (an empty line: Delete join takes the line itself away, `line`; the page does that, the host has nothing to delete)
        const empty = !hasAny(join);
        return {
            remove: { disabled: false, detail: empty ? 'Takes this line away' : '', line: empty },
            reset: { disabled: !any, detail: any ? 'Every join back to "Pick a column"' : 'No join has a column picked yet' },
            hide: !joins(join)
        };
    }

    /**
     * The plain join lines the step shows, in the views' order, and the view + Add join brings up next ('' when every view
     * on show has its line: no button). `shown`: the lines brought up and not taken away; `touched`: a line was added or
     * taken away, so the first line no longer comes by itself. A compare's views are in its band, not here.
     */
    function joinLines(state, shown, touched) {
        const joinOf = id => (state.joins || []).find(j => j.view === id);
        const plain = (state.views || []).slice(1).filter(v => { const j = joinOf(v.id); return !!j && j.kind !== 'compare'; });
        const lines = plain.filter(v => joins(joinOf(v.id)) || (shown && shown.has(v.id))).map(v => v.id);
        const anyJoined = (state.joins || []).some(j => j.kind === 'compare' || joins(j));
        if (!lines.length && !anyJoined && !touched) {
            const first = plain.find(v => !v.off);
            if (first) lines.push(first.id);
        }
        const next = plain.find(v => !v.off && !lines.includes(v.id));
        return { lines, next: next ? next.id : '' };
    }

    const api = { notJoined, menu, joinLines };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.QueryJoinRules = api;
})();
