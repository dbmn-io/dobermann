// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnLanes: the one grid every line of a lanes screen shares (the design system:
 * src/webviews/design-system; Query first). A gutter on the left, a lane per view as wide as its
 * runs, an end column on the right:
 *
 *   var(--gutter, 230px) | minmax(runs × 120px, runs fr) per view | 130px
 *
 * Every row is `display: grid` on the same tracks (dbmn-lanes.css), so lines line up by
 * construction: nothing is measured, nothing is fitted afterwards. This script only works the
 * tracks out from the views and sets them on the screen's container.
 *
 *   DbmnLanes.apply(container, [{ runs: 4 }, { runs: 1 }, { runs: 1 }]);
 *       sets --lanes-tracks (the tracks) and --lanes-min (the narrowest the rows go: below it,
 *       the container scrolls sideways) on the container. Call it again when a view or a run is
 *       added or taken away. A view is { runs: n }, { runs: [...] } or a number.
 *   DbmnLanes.tracks(views)    the tracks alone, as text
 *   DbmnLanes.minWidth(views)  the narrowest width, in px
 *   DbmnLanes.together([header, step])   a fixed slot row above and a step's lines below, in two
 *                              containers, scrolled sideways as one (the header hides its own bar)
 *
 * Options (the same for every call on a screen): { gutter: 230, run: 120, end: 130, gap: 6 }.
 */
(function (root) {
    'use strict';

    var DEFAULTS = { gutter: 230, run: 120, end: 130, gap: 6 };

    function settings(options) {
        var o = {};
        Object.keys(DEFAULTS).forEach(function (k) {
            var v = options && Number(options[k]);
            o[k] = v > 0 || (k === 'gap' && v === 0) ? v : DEFAULTS[k];
        });
        return o;
    }

    /** How many runs a view has (at least one: a view with none still keeps its place). */
    function runsOf(view) {
        var n = typeof view === 'number' ? view
            : view && Array.isArray(view.runs) ? view.runs.length
                : view && typeof view.runs === 'number' ? view.runs : 1;
        return Math.max(1, Math.floor(n) || 1);
    }

    function tracks(views, options) {
        var o = settings(options);
        var lanes = (views || []).map(function (v) {
            var n = runsOf(v);
            return 'minmax(' + n * o.run + 'px, ' + n + 'fr)';
        });
        return [o.gutter + 'px'].concat(lanes, [o.end + 'px']).join(' ');
    }

    function minWidth(views, options) {
        var o = settings(options);
        var list = views || [];
        var lanes = list.reduce(function (sum, v) { return sum + runsOf(v) * o.run; }, 0);
        return o.gutter + lanes + o.end + (list.length + 1) * o.gap;
    }

    function apply(container, views, options) {
        if (!container || !container.style) return;
        var o = settings(options);
        container.style.setProperty('--lanes-tracks', tracks(views, o));
        container.style.setProperty('--lanes-min', minWidth(views, o) + 'px');
        container.style.setProperty('--lanes-gap', o.gap + 'px');
    }


    /**
     * Lanes in two containers that must scroll sideways as one: a fixed slot row above (the
     * screen's header) and a step's lines below. Each container holds the same tracks
     * (DbmnLanes.apply on each, with the same views); whichever is scrolled sideways, the others
     * follow. The one marked `is-following` (the header's) keeps no scrollbar of its own: the
     * step's bar moves both. Returns a function that stops it.
     *
     *   DbmnLanes.apply(top, views); DbmnLanes.apply(step, views);
     *   const stop = DbmnLanes.together([top, step]);   // top gets is-following
     */
    function together(containers) {
        var list = (containers || []).filter(Boolean);
        if (list.length < 2) return function () {};
        list.slice(0, -1).forEach(function (el) { el.classList.add('is-following'); });
        // (setting the same value fires nothing, so they never chase each other)
        var onScroll = function (event) {
            var x = event.currentTarget.scrollLeft;
            list.forEach(function (el) { if (el !== event.currentTarget && el.scrollLeft !== x) el.scrollLeft = x; });
        };
        list.forEach(function (el) { el.addEventListener('scroll', onScroll, { passive: true }); });
        // A new step's lines start where the header is
        var last = list[list.length - 1];
        if (last.scrollLeft !== list[0].scrollLeft) last.scrollLeft = list[0].scrollLeft;
        return function () {
            list.forEach(function (el) { el.removeEventListener('scroll', onScroll); el.classList.remove('is-following'); });
        };
    }

    /**
     * Something moved to another cell (Query's Add a view / Add a file, into the next empty slot): slid there from
     * where it was, so the eye follows it (James, 2026-11-23: "Animate them moving across"). `before`: its box before
     * the move (getBoundingClientRect). Nothing when it hasn't moved, or the viewer asks for less motion.
     *
     *   const was = adds.getBoundingClientRect();  …redraw, the element moved…;  DbmnLanes.glide(adds, was);
     */
    function glide(el, before, ms) {
        if (!el || !before || typeof el.animate !== 'function') return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var now = el.getBoundingClientRect();
        var dx = before.left - now.left, dy = before.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
            { duration: ms || 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }

    var api = { tracks: tracks, minWidth: minWidth, apply: apply, together: together, runsOf: runsOf, glide: glide, DEFAULTS: DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.DbmnLanes = api;
})(typeof window !== 'undefined' ? window : null);
