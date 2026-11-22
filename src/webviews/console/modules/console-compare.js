// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Reporting from the Console page: its database button (toolbar, beside Chain), on the Completed tab of a
 * finished run. This result, through the View the tab shows, goes into (2026-11-22, James):
 *  - New Query: a new query with it as its first view;
 *  - New Compare: a new compare with it as the Baseline, its other runs offered at once;
 *  - Add to Compare: a saved compare, picked from a second menu (a run of its view joins the compare).
 * console.report does it on the host (console-compare-handler.ts), which opens the query.
 *  - The View list flags the Views saved compares read (console.compareViews), and the View
 *    editor warns before one is changed (viewsInCompares, read by console-page.js).
 *
 * Shown and enabled with Chain: console-chain.js's refresh calls refresh() here.
 * Business logic stays in the host (console-compare-handler.ts).
 */
(function () {
    'use strict';

    const state = { tab: null, status: '', views: {}, queries: {}, compares: [], asked: false };
    // Statuses after which no more rows will arrive (as Chain): the result is final
    const ENDED = ['completed', 'stopped', 'error', 'cancelled', 'failed', 'completed_with_errors'];
    const TITLE = 'Query or compare this result';

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
        btn.title = ended ? TITLE : 'This result can go in a query once its run has finished';
    }

    /**
     * The button's menu: New Query, New Compare, Add to Compare (its saved compares in a second menu).
     * The saved compares are asked for again first, so one made in another tab is in the list (a
     * compare made since this Console last asked); the menu opens when they come, or from what is
     * held if they take longer than half a second.
     */
    let menuFor = null;
    let menuTimer = 0;
    function start(event) {
        const btn = event.currentTarget;
        if (!window.DbmnContextMenu) { post('console.report', { view: viewName(), kind: 'query' }); return; }
        menuFor = btn;
        clearTimeout(menuTimer);
        menuTimer = setTimeout(openMenu, 500);
        post('console.compareViews');
    }
    function openMenu() {
        clearTimeout(menuTimer);
        const btn = menuFor;
        menuFor = null;
        if (!btn) return;
        const none = !state.compares.length;
        window.DbmnContextMenu.show(btn, [
            { id: 'query', label: 'New Query', icon: 'database' },
            { id: 'compare', label: 'New Compare', icon: 'scale' },
            { id: 'add', label: 'Add to Compare', icon: 'plus', disabled: none, ...(none ? { detail: 'No saved compares yet' } : {}) }
        ], id => {
            if (id === 'query' || id === 'compare') post('console.report', { view: viewName(), kind: id });
            else if (id === 'add') {
                window.DbmnContextMenu.show(btn, state.compares.map(c => ({ id: c.id, label: c.name, icon: 'scale' })), queryId => {
                    if (queryId) post('console.report', { view: viewName(), kind: 'add', queryId });
                });
            }
        });
    }

    function onMessage(event) {
        const message = event.data || {};
        if (message.type === 'console.compareViews') {
            state.views = (message.payload && message.payload.views) || {};
            state.queries = (message.payload && message.payload.queries) || {};
            state.compares = (message.payload && message.payload.compares) || [];
            refresh();
            if (typeof window.onCompareViewsChanged === 'function') window.onCompareViewsChanged();
            if (menuFor) openMenu();
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
