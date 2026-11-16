// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnToast — the single, standard toast component for all DBMN webviews.
 *
 * Why this exists:
 *   DBMN's notifications were fragmented across a Hub footer, a generic footer,
 *   a data-transformer modal banner, a console "raw-toast", and inline status
 *   elements — several missing styling, all behaving differently. Worse, the
 *   in-flow footer notifications shifted page content and looked broken when
 *   space was tight. This replaces them with ONE fixed-position overlay that
 *   never affects layout.
 *
 * Surface mirrors the backend IToastService (info/warn/error) plus a `success`
 * level and an options bag, so the mental model is identical on both sides.
 *
 *   DbmnToast.info('Saved');
 *   DbmnToast.success('Merged tag across 12 endpoints');
 *   DbmnToast.warn('Some rows were skipped');
 *   DbmnToast.error('Could not reach server', { persistent: true });
 *   DbmnToast.show('info', 'msg', { durationMs, persistent, shake, source, link });
 *
 * Toasts stack (newest nearest the corner), auto-hide on a clock that depends on
 * the level, pause while hovered, and always carry a dismiss button. Pass
 * `source` ONLY for a single-slot status that genuinely supersedes itself (a
 * live progress line) — it replaces the previous toast with the same source, and
 * a result the user might still be reading is not that.
 *
 * Host-origin toasts: the extension host posts
 *   { type: 'dbmnToast', level, message, opts }
 * which this module renders (see IToastService routing). That lets a host-side
 * notification appear in our own toast when the webview is visible, with the
 * host falling back to a native VS Code notification when it is not.
 *
 * Governing principle (enforced by callers, not here): a toast fires only when
 * it tells the user something important that isn't already conveyed by other
 * UX. No double-notification; no toasts for routine, can't-fail actions.
 */
(function () {
    'use strict';

    var LEVELS = { info: 'info', success: 'success', warning: 'warning', error: 'error' };
    var CONTAINER_ID = 'dbmn-toast-container';

    /* How long a toast stays, by level. The old flat 6.5s (and the 2s some
     * callers passed) read as "blink and it's gone", and a message the user
     * might need to act on deserves longer than a confirmation they expected.
     * An explicit `durationMs` still wins, `persistent: true` never auto-hides,
     * hovering holds any of them open, and every toast has a dismiss button —
     * so these are a floor on reading time, not a deadline. */
    var DURATION_BY_LEVEL = {
        info: 8000,
        success: 8000,
        warning: 14000,
        error: 20000
    };
    var FALLBACK_DURATION_MS = 8000;

    /** Most toasts on screen at once. A burst retires its oldest auto-hiding
     *  toasts rather than growing a column past the top of the editor. */
    var MAX_VISIBLE = 4;

    /* ── One stack per window, not per document ──────────────────────────────
     * An editor opened as a Hub tab runs in its own srcdoc iframe (hub-tabs.js)
     * and loads this file again, so it used to grow a SECOND bottom-right stack
     * directly over the Hub's. Neither document could see the other's toasts:
     * a host toast ("Badge earned") and one from the embedded editor ("pasted
     * successfully") landed on the same spot and covered each other instead of
     * stacking. Embedded documents now hand their toasts to the outermost DBMN
     * document, so there is one container and one stack.
     *
     * Embedding is read from a marker the Hub's shim sets, never inferred from
     * `window.parent`: EVERY VS Code webview is itself an iframe, so a
     * standalone panel must keep rendering its own toasts.
     */
    var EMBED_MARKER = '__dbmnEmbeddedTab__';
    var MAX_HOPS = 4; // Hub → tab → nested frame; a guard, not a real depth.

    /** The DbmnToast that owns the visible stack, or null when that's us. */
    function outerToast() {
        try {
            var w = window;
            for (var hop = 0; hop < MAX_HOPS; hop++) {
                if (!w[EMBED_MARKER]) break;
                var up = w.parent;
                if (!up || up === w || !up.DbmnToast) break;
                w = up;
            }
            if (w === window) return null;
            // `show !== show` guards a same-realm alias; delegating to our own
            // implementation would recurse.
            return w.DbmnToast && w.DbmnToast.show !== show ? w.DbmnToast : null;
        } catch (_e) {
            return null; // Cross-origin parent (a standalone webview) — render here.
        }
    }

    /** Retire the oldest auto-hiding toasts until at most `max` remain. Persistent
     *  ones are the user's to dismiss, so they're never retired. */
    function trimTo(container, max) {
        var nodes = container.querySelectorAll('.dbmn-toast:not(.is-leaving)');
        var live = nodes.length;
        for (var i = 0; i < nodes.length && live > max; i++) {
            var node = nodes[i];
            if (node.dataset.persistent === 'true') continue;
            if (typeof node.dbmnDismiss === 'function') node.dbmnDismiss();
            else if (node.parentNode) node.parentNode.removeChild(node);
            live--;
        }
    }

    function ensureContainer() {
        var container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            container.className = 'dbmn-toast-container';
            container.setAttribute('role', 'status');
            container.setAttribute('aria-live', 'polite');
            document.body.appendChild(container);
        }
        return container;
    }

    /* ── Sit above the footer ────────────────────────────────────────────────
     * The footer (.webview-footer) holds the page's controls — Back/Next,
     * Re-run, Delete — and a bottom-right toast used to land straight on
     * them. Lift the stack so its bottom edge clears whichever visible footer
     * touches the bottom of the view. The stack lives in the outermost
     * document, but an embedded Hub tab's footer is in that tab's iframe, so
     * same-origin frames are measured too. Footers come and go (wizard steps,
     * bulk bars), so the lift is re-measured while any toast is on screen.
     */
    var FOOTER_SELECTOR = '.webview-footer';
    var BASE_OFFSET_PX = 16;  // matches toast.css when no footer is present
    var FOOTER_GAP_PX = 8;
    var REMEASURE_MS = 400;
    var remeasureTimer = null;

    /** Highest top edge (in this window's coordinates) of a visible footer
     *  that sits at the bottom of the view, or null when there is none. */
    function footerTop(doc, offsetTop, viewHeight, depth) {
        var top = null;
        var footers = doc.querySelectorAll(FOOTER_SELECTOR);
        for (var i = 0; i < footers.length; i++) {
            var rect = footers[i].getBoundingClientRect();
            if (rect.height <= 0 || rect.width <= 0) continue; // hidden
            var absTop = offsetTop + rect.top;
            var absBottom = offsetTop + rect.bottom;
            if (absBottom < viewHeight - 24 || absTop >= viewHeight) continue; // not a bottom footer
            if (top === null || absTop < top) top = absTop;
        }
        if (depth >= MAX_HOPS) return top;
        var frames = doc.querySelectorAll('iframe');
        for (var f = 0; f < frames.length; f++) {
            var frameRect = frames[f].getBoundingClientRect();
            if (frameRect.height <= 0 || frameRect.width <= 0) continue;
            var inner = null;
            try { inner = frames[f].contentDocument; } catch (_e) { inner = null; }
            if (!inner) continue; // cross-origin
            var t = footerTop(inner, offsetTop + frameRect.top, viewHeight, depth + 1);
            if (t !== null && (top === null || t < top)) top = t;
        }
        return top;
    }

    function positionContainer() {
        var container = document.getElementById(CONTAINER_ID);
        if (!container) return;
        var viewHeight = window.innerHeight || document.documentElement.clientHeight;
        var top = null;
        try { top = footerTop(document, 0, viewHeight, 0); } catch (_e) { top = null; }
        var bottom = top === null
            ? BASE_OFFSET_PX
            : Math.max(BASE_OFFSET_PX, Math.round(viewHeight - top) + FOOTER_GAP_PX);
        container.style.bottom = bottom + 'px';
        if (!container.querySelector('.dbmn-toast') && remeasureTimer) {
            clearInterval(remeasureTimer);
            remeasureTimer = null;
        }
    }

    function trackFooter() {
        positionContainer();
        if (window.requestAnimationFrame) window.requestAnimationFrame(positionContainer);
        if (!remeasureTimer) remeasureTimer = setInterval(positionContainer, REMEASURE_MS);
    }

    window.addEventListener('resize', positionContainer);

    function normaliseLevel(level) {
        if (level === 'warn') return LEVELS.warning;
        return LEVELS[level] || LEVELS.info;
    }

    /**
     * Show a toast. Returns a handle with dismiss().
     * @param {string} level info | success | warning | error (warn alias ok)
     * @param {string} message
     * @param {{durationMs?:number, persistent?:boolean, dismissible?:boolean, shake?:boolean, source?:string,
     *          link?:{text:string, href?:string, onClick?:Function}}} [opts]
     *   `source` gives single-slot semantics: a new toast with the same source
     *   replaces any existing one (e.g. a live "Paused" indicator), and
     *   `DbmnToast.clear(source)` removes only that one. Don't use it for the
     *   result of an action — replacing one result with the next is how a user
     *   loses the first before reading it.
     *   `dismissible` is accepted but redundant: every toast has a close button.
     *   `link` appends one trailing anchor (#268) — the message itself stays
     *   textContent-only, so callers can add a "Read more" without HTML.
     */
    // Recent `level|message` → timestamp, to drop duplicate toasts fired in
    // quick succession (e.g. the same notification emitted twice). 'source'
    // toasts are exempt — they replace by design (single-slot).
    var recentToasts = {};
    var DEDUP_WINDOW_MS = 2000;

    function show(level, message, opts) {
        opts = opts || {};
        if (!message) return { dismiss: function () {} };

        // Embedded in a Hub tab? The outer document owns the stack (see above).
        var outer = outerToast();
        if (outer) return outer.show(level, message, opts);

        var lvl = normaliseLevel(level);

        if (!opts.source) {
            var dkey = lvl + '|' + message;
            var dnow = Date.now();
            if (recentToasts[dkey] && dnow - recentToasts[dkey] < DEDUP_WINDOW_MS) {
                return { dismiss: function () {} };
            }
            recentToasts[dkey] = dnow;
        }

        var container = ensureContainer();

        // Single-slot replacement: drop any existing toast with the same source.
        if (opts.source) clear(opts.source);

        var toast = document.createElement('div');
        toast.className = 'dbmn-toast is-' + lvl + (opts.shake ? ' is-shaking' : '');
        if (opts.source) toast.dataset.source = opts.source;
        toast.setAttribute('role', lvl === LEVELS.error ? 'alert' : 'status');

        var text = document.createElement('span');
        text.className = 'dbmn-toast-message';
        text.textContent = message;
        toast.appendChild(text);

        // #268: optional trailing link. Built with createElement so the message
        // stays injection-safe — no caller ever passes markup.
        if (opts.link && opts.link.text) {
            var link = document.createElement('a');
            link.className = 'dbmn-toast-link';
            link.textContent = opts.link.text;
            link.href = opts.link.href || '#';
            link.addEventListener('click', function (event) {
                if (typeof opts.link.onClick === 'function') {
                    event.preventDefault();
                    opts.link.onClick();
                }
            });
            toast.appendChild(link);
        }

        var hideTimer = null;
        var duration = typeof opts.durationMs === 'number'
            ? opts.durationMs
            : (DURATION_BY_LEVEL[lvl] || FALLBACK_DURATION_MS);

        function stopTimer() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        }
        function startTimer() {
            if (opts.persistent) return;
            stopTimer();
            hideTimer = window.setTimeout(dismiss, duration);
        }
        function dismiss() {
            stopTimer();
            if (!toast.parentNode) return;
            toast.classList.add('is-leaving');
            // Remove after the leave transition; guard if already gone.
            window.setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 200);
        }

        // Every toast carries a dismiss button. Reading speed is the user's, not
        // ours: they clear what they've read instead of waiting out a timer, and
        // a stack of them can be cleared one at a time. (`opts.dismissible` is
        // still accepted — it's now the default, so callers needn't pass it.)
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'dbmn-toast-close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '✕';
        close.addEventListener('click', dismiss);
        toast.appendChild(close);

        if (opts.persistent) toast.dataset.persistent = 'true';
        toast.dbmnDismiss = dismiss;
        container.appendChild(toast);
        trimTo(container, MAX_VISIBLE);
        trackFooter();

        // Hovering holds the toast open: toasts that arrive together share one
        // reading window, and a long message needs longer than a short one.
        // Leaving restarts the full clock.
        toast.addEventListener('mouseenter', stopTimer);
        toast.addEventListener('mouseleave', startTimer);
        startTimer();

        return { dismiss: dismiss };
    }

    /**
     * Remove toasts. With a `source`, removes only the toast tagged with it
     * (and only when it matches — mirrors the console's source-filtered clear).
     * With no source, clears all current toasts.
     */
    function clear(source) {
        var outer = outerToast();
        if (outer) { outer.clear(source); return; }

        var container = document.getElementById(CONTAINER_ID);
        if (!container) return;
        var nodes = container.querySelectorAll('.dbmn-toast');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (source && node.dataset.source !== source) continue;
            if (node.parentNode) node.parentNode.removeChild(node);
        }
    }

    function info(message, opts) { return show(LEVELS.info, message, opts); }
    function success(message, opts) { return show(LEVELS.success, message, opts); }
    function warn(message, opts) { return show(LEVELS.warning, message, opts); }
    function error(message, opts) { return show(LEVELS.error, message, opts); }

    // Render host-origin toasts routed in via postMessage. Defensive: ignore
    // anything that isn't our shape so we don't clash with other handlers.
    window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (!data || data.type !== 'dbmnToast') return;
        show(data.level, data.message, data.opts);
    });

    window.DbmnToast = {
        show: show,
        info: info,
        success: success,
        warn: warn,
        error: error,
        clear: clear
    };
})();
