// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnLanes: the one grid every line of a lanes screen shares (the design system:
 * src/webviews/design-system; Query first). A gutter on the left, a lane per view as wide as its
 * runs, an end column on the right:
 *
 *   var(--gutter, 230px) | runs × 120px per view | 130px
 *
 * A lane is exactly as wide as its runs, never stretched to fill the screen (James, 2026-11-23: "These are also way
 * too wide on this screen… I've got no room for anything"); more lanes than fit scroll the row sideways. A lane added
 * at the end grows from nothing to its width, so what comes after it (Query's Add a view / Add a file) is carried
 * across as it opens ("The view needs to expand… These buttons need to move across as the view comes in").
 *
 * Every row is `display: grid` on the same tracks (dbmn-lanes.css), so lines line up by
 * construction: nothing is measured, nothing is fitted afterwards. This script only works the
 * tracks out from the views and sets them on the screen's container.
 *
 *   DbmnLanes.apply(container, [{ runs: 4 }, { runs: 1 }, { runs: 1 }]);
 *       sets --lanes-tracks (the tracks) and --lanes-min (the rows' width: wider than the
 *       container, it scrolls sideways) on the container. Call it again when a view or a run is
 *       added or taken away. A view is { runs: n }, { runs: [...] } or a number. One lane more
 *       than the last call: the new last lane grows open (--lanes-grow, 320ms; .is-growing on the
 *       container meanwhile; none when the viewer asks for less motion).
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

    // growLast: the last lane's width is var(--lanes-grow), the one apply() animates open
    function tracks(views, options, growLast) {
        var o = settings(options);
        var list = views || [];
        var lanes = list.map(function (v, i) {
            var w = runsOf(v) * o.run + 'px';
            return growLast && i === list.length - 1 ? 'var(--lanes-grow, ' + w + ')' : w;
        });
        return [o.gutter + 'px'].concat(lanes, [o.end + 'px']).join(' ');
    }

    var GROW_MS = 320;
    var registered = false;
    /** --lanes-grow as a length, so it animates (and every row under the container, drawn now or later, follows it). */
    function registerGrow() {
        if (registered) return true;
        try {
            if (typeof CSS === 'undefined' || !CSS.registerProperty) return false;
            CSS.registerProperty({ name: '--lanes-grow', syntax: '<length>', inherits: true, initialValue: '0px' });
        } catch (e) { /* already registered (another script, or a reload): fine */ }
        registered = true;
        return true;
    }
    function lessMotion() {
        return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
        var list = views || [];
        var before = container.dataset ? Number(container.dataset.lanes) : NaN;
        if (container.dataset) container.dataset.lanes = String(list.length);
        var grow = list.length > 0 && list.length === before + 1 && typeof container.animate === 'function'
            && !lessMotion() && registerGrow();
        // (redrawn while a lane is still opening, the same views: it keeps opening, never jumps to its width)
        var opening = !grow && list.length === before && container.classList && container.classList.contains('is-growing');
        container.style.setProperty('--lanes-tracks', tracks(list, o, grow || opening));
        container.style.setProperty('--lanes-min', minWidth(list, o) + 'px');
        container.style.setProperty('--lanes-gap', o.gap + 'px');
        if (!grow) return;
        var width = runsOf(list[list.length - 1]) * o.run;
        container.style.setProperty('--lanes-grow', width + 'px');
        container.classList.add('is-growing');
        var animation = container.animate([{ '--lanes-grow': '0px' }, { '--lanes-grow': width + 'px' }],
            { duration: GROW_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        var done = function () {
            container.classList.remove('is-growing');
            // (the tracks without the variable once it is open: nothing left to follow)
            if (container.style.getPropertyValue('--lanes-tracks') === tracks(list, o, true)) container.style.setProperty('--lanes-tracks', tracks(list, o));
        };
        animation.onfinish = done;
        animation.oncancel = done;
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
     *   DbmnLanes.glide(adds, was, { axis: 'x' })   sideways only
     */
    // opts: a duration in ms, or { ms, axis: 'x' } to slide sideways only (the slots row's pair: James, 2026-11-23,
    // "they look flying from the top": a moment's change in the row's height must never make it come from above)
    function glide(el, before, opts) {
        if (!el || !before || typeof el.animate !== 'function') return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var o = typeof opts === 'number' ? { ms: opts } : (opts || {});
        var now = el.getBoundingClientRect();
        var dx = before.left - now.left, dy = o.axis === 'x' ? 0 : before.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
            { duration: o.ms || 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }

    var api = { tracks: tracks, minWidth: minWidth, apply: apply, together: together, runsOf: runsOf, glide: glide, DEFAULTS: DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.DbmnLanes = api;
})(typeof window !== 'undefined' ? window : null);
