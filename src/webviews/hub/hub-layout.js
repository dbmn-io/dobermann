// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Hub Layout maths (GitHub Issues #292, #349)
 *
 * The Hub is two columns, rail · tab content, with the list panel (L2) as a
 * drawer that slides over the tab content from the rail's edge. The tab
 * content never changes width when the drawer opens or closes.
 *
 * - `clampDrawerWidth` keeps a dragged drawer width usable and leaves a strip
 *   of tab content showing beside it (the scrim the user clicks to close).
 * - `drawerCloseDelay` decides whether a message the lists post to the host
 *   is a "commit" (it opens or focuses a tab) that should close the drawer.
 * - `sectionForTab` maps a tab to the rail item that owns it, for the rail
 *   highlight while the drawer is closed.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and
 * runs in both the webview (window.HubLayoutMath) and Node (module.exports).
 *
 * Used by:
 * - hub.js — applyLayout(), wireColResize(), the drawer
 * - hub-tabs.js — page tab id checks
 */

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.HubLayoutMath = api;
    }
})(this, function () {
    'use strict';

    /** Narrowest usable drawer (endpoint rows: verb + name + path). */
    const MIN_DRAWER_W = 240;
    /** Tab content left showing beside the widest drawer. */
    const DRAWER_GUTTER_W = 48;
    /** Default drawer width when nothing has been persisted. */
    const DEFAULT_DRAWER_W = 360;
    /** A catalogue single click opens a preview tab; the drawer waits this
     *  long before closing so the second click of a double-click (which keeps
     *  the tab) still lands on the row. */
    const PREVIEW_CLOSE_DELAY_MS = 300;

    /** Messages the lists post that open or focus a tab. */
    const COMMIT_TYPES = new Set([
        'openEndpointAsTab',
        'openEnvironmentAsTab',
        'openTransaction',
        'openBatchAsTab',
        'openCompare',
        'duplicateCompare',
        'newQuery',
        'runEndpoint',
        'addEndpoint',
        'addEnvironment'
    ]);

    /** Tab type → the rail section that lists it. */
    const SECTION_BY_TAB_TYPE = {
        endpoint: 'catalogue',
        batch: 'catalogue',
        environment: 'environments',
        console: 'transactions',
        batchConsole: 'transactions',
        compare: 'compare',
        logs: 'logs'
    };

    /**
     * Clamp a requested drawer width to [MIN_DRAWER_W, availW − gutter].
     * When the space is too narrow for both, the minimum wins.
     *
     * @param {number} requestedPx
     * @param {number} availW  Width of the tab content area the drawer covers.
     * @returns {number}
     */
    function clampDrawerWidth(requestedPx, availW) {
        const requested = Number.isFinite(requestedPx) && requestedPx > 0 ? requestedPx : DEFAULT_DRAWER_W;
        const width = Number.isFinite(availW) ? availW : 0;
        const maxAllowed = width - DRAWER_GUTTER_W;
        return Math.max(MIN_DRAWER_W, Math.min(requested, maxAllowed));
    }

    /**
     * How long to wait before closing the drawer after the lists post `msg`.
     *
     * @param {{type?:string, preview?:boolean}} msg
     * @returns {null|number}  null = not a commit, leave the drawer alone.
     */
    function drawerCloseDelay(msg) {
        if (!msg || !COMMIT_TYPES.has(msg.type)) return null;
        if (msg.type === 'openEndpointAsTab' && msg.preview) return PREVIEW_CLOSE_DELAY_MS;
        return 0;
    }

    /**
     * The rail section a tab belongs to.
     *
     * @param {{type?:string, refId?:string}|null|undefined} tab
     * @returns {string|null}
     */
    function sectionForTab(tab) {
        if (!tab) return null;
        if (tab.type === 'page') return tab.refId || null;
        return SECTION_BY_TAB_TYPE[tab.type] || null;
    }

    /** Page tabs (Settings / Account / Import / Export) are hub-native, not iframes. */
    function isPageTabId(id) {
        return typeof id === 'string' && /^page:/.test(id);
    }

    return {
        MIN_DRAWER_W,
        DRAWER_GUTTER_W,
        DEFAULT_DRAWER_W,
        PREVIEW_CLOSE_DELAY_MS,
        clampDrawerWidth,
        drawerCloseDelay,
        sectionForTab,
        isPageTabId
    };
});
