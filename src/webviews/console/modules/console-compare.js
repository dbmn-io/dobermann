// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare in the Console page, the one way a compare starts.
 *
 *  - Compare button (toolbar, beside Chain): on the Completed tab of a finished run. This result,
 *    through the View the tab shows, is the Baseline (BL). console.compare opens Compare on its
 *    Select step, which picks C1 to C3.
 *  - The View list flags the Views saved compares read (console.compareViews), and the View
 *    editor warns before one is changed (viewsInCompares, read by console-page.js).
 *
 * Shown and enabled with Chain: console-chain.js's refresh calls refresh() here.
 * Business logic stays in the host (console-compare-handler.ts).
 */
(function () {
    'use strict';

    const state = { tab: null, status: '', views: {}, queries: {}, asked: false };
    // Statuses after which no more rows will arrive (as Chain): the result is final
    const ENDED = ['completed', 'stopped', 'error', 'cancelled', 'failed', 'completed_with_errors'];
    const TITLE = 'Compare this result with other results of this endpoint';

    function post(type, payload) {
        if (!window.vscode) return;
        window.vscode.postMessage({
            type,
            correlationId: `compare_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: payload || {}
        });
    }

    /** The View the Completed tab shows: the compare reads every result through it. */
    function viewName() {
        const mgr = window.dynamicReportManager;
        const view = mgr && mgr.getActiveView ? mgr.getActiveView('success') : null;
        return (view && view.name) || 'Root';
    }

    function refresh(tab, status) {
        if (tab !== undefined) state.tab = tab;
        if (status) state.status = String(status).toLowerCase();
        if (!state.asked) { state.asked = true; post('console.compareViews'); }
        const btn = document.getElementById('compare-btn');
        if (!btn) return;
        btn.classList.toggle('hidden', state.tab !== 'success');
        const ended = ENDED.includes(state.status);
        btn.disabled = !ended;
        btn.title = ended ? TITLE : 'Compare can start once this run has finished';
    }

    function start() {
        post('console.compare', { view: viewName() });
    }

    function onMessage(event) {
        const message = event.data || {};
        if (message.type === 'console.compareViews') {
            state.views = (message.payload && message.payload.views) || {};
            state.queries = (message.payload && message.payload.queries) || {};
            refresh();
            if (typeof window.onCompareViewsChanged === 'function') window.onCompareViewsChanged();
        }
    }
    // After the page's own listener (see console-chain.js: the first listener gets the early queue)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.addEventListener('message', onMessage); });
    } else {
        window.addEventListener('message', onMessage);
    }
    document.addEventListener('DOMContentLoaded', function () {
        const btn = document.getElementById('compare-btn');
        if (btn) btn.addEventListener('click', start);
        // A compare saved since (from another Console) shows in the View list: ask again on open
        const views = document.getElementById('view-path-btn');
        if (views) views.addEventListener('click', function () { post('console.compareViews'); });
    });
    // Back in this Console after comparing elsewhere
    window.addEventListener('focus', function () { if (state.asked) post('console.compareViews'); });

    window.ConsoleCompare = {
        refresh,
        /** How many saved compares read this View (0 when none). */
        comparesUsing: name => state.views[name] || 0,
        /** How many saved queries read this View: such a View is locked (columns can only be added). */
        queriesUsing: name => state.queries[name] || 0
    };
})();
