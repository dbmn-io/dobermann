// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's Requests tab (#466): the shared Requests table (shared/dbmn-requests.js, the same one Run Batch's
 * Review shows) on the stored run (console.controller.ts handleRequests). What is the Console's own is here: the
 * tab (createDynamicTabs lists it, switchTab → onSwitchTab), its count on the heading, the logs window (the Raw
 * tab's), Reprocess, the input rows from the Input tab's data, and a single run opening its one request at once.
 * Raw stays beside it until the transaction window has its card's views.
 */
(function () {
    /** A single run's request opening by itself: on once Raw is gone (B22). Off while Raw is beside Requests. */
    const OPEN_SINGLE_RUN = false;
    'use strict';

    const post = message => window.vscode && window.vscode.postMessage(message);
    const pad = n => String(n ?? '').padStart(3, '0');
    const state = { requests: null, total: 0, openedSingle: false, onTab: false };

    function panel() {
        let node = document.getElementById('requests-tab-content');
        if (!node) {
            const host = document.querySelector('#report-container .tab-content');
            if (!host) return null;
            node = document.createElement('div');
            node.className = 'requests-tab-content hidden';
            node.id = 'requests-tab-content';
            host.appendChild(node);
        }
        return node;
    }

    /** A Run API's Console (no batch), not a batch of one page. */
    function isSingleRun() {
        const raw = window.dynamicReportManager && window.dynamicReportManager.rawData;
        return !(raw && raw.metadata && raw.metadata.batchId) && !window.currentBatchId;
    }

    /** Its input rows, from the Input tab's data: columns and values. */
    function inputOf(row) {
        const data = window.dynamicReportManager && window.dynamicReportManager.rawData && window.dynamicReportManager.rawData.inputData;
        if (!Array.isArray(data) || row.rowStart === null || row.rowStart === undefined) return null;
        const slice = data.slice(row.rowStart - 1, (row.rowEnd ?? row.rowStart));
        if (!slice.length) return null;
        const first = slice[0];
        if (Array.isArray(first)) return { columns: first.map((_, i) => `Column ${i + 1}`), rows: slice };
        const names = Object.keys(first || {});
        return { columns: names, rows: slice.map(r => names.map(n => (r && r[n] !== undefined && r[n] !== null ? String(r[n]) : ''))) };
    }

    function viewLogs(row) {
        post({ type: 'console.get_transaction_log', correlationId: `log_${Date.now()}`, timestamp: Date.now(), source: 'webview', target: 'extension',
            payload: { logFilePath: null, executionId: row.id, transactionIndex: row.n } });
        // (the Raw tab's logs window shows the answer: console-page.js routes console.transaction_log_response to it)
        if (window.rawTabHandler && window.rawTabHandler.showLogsModal) window.rawTabHandler.showLogsModal(`Request #${pad(row.n)}`, '// Loading logs...');
    }
    function reprocess(row) {
        if (!window.currentBatchId) return;
        post({ type: 'retryMember', correlationId: `retry_${Date.now()}`, timestamp: Date.now(), source: 'webview', target: 'extension',
            payload: { executionId: row.id, batchId: window.currentBatchId } });
        if (window.DbmnToast) window.DbmnToast.info(`Reprocessing request #${pad(row.n)}`);
    }

    function onCounts({ total }) {
        state.total = total;
        const heading = document.getElementById('run-heading');
        if (heading && heading.has && heading.has('requests') && heading.setCount) heading.setCount('requests', total);
        // A single run: its one request opens at once, as Raw showed its card (design system, 2026-11-24)
        // (only once Raw is gone, B22: while Raw is still beside Requests it shows the single run's card, and a window
        //  opening over the Console by itself would cover it)
        if (OPEN_SINGLE_RUN && !state.openedSingle && total === 1 && isSingleRun()) {
            state.openedSingle = true;
            requests().open(0);
        }
    }

    /** The table: made the first time it is needed (the tab, or a single run's request), inside the tab's panel. */
    function requests() {
        if (state.requests) return state.requests;
        const node = panel();
        if (!node || !window.DbmnRequests) return null;
        state.requests = window.DbmnRequests.mount(node, {
            post, input: inputOf, logs: viewLogs, counts: onCounts,
            // (the Console's Monaco in the window's panes: it loads it itself, design system)
            editor: window.ConsoleEditor ? window.ConsoleEditor.make : null,
            whenEditorReady: window.ConsoleEditor ? window.ConsoleEditor.whenReady : null,
            reprocess: row => reprocess(row), canReprocess: row => ['error', 'test_failed', 'cancelled'].includes(row.status) && !!window.currentBatchId
        });
        return state.requests;
    }

    /** switchTab: the Requests tab is this module's; any other hides it. */
    function onSwitchTab(tabName) {
        const node = panel();
        state.onTab = tabName === 'requests';
        if (!state.onTab) {
            if (node) node.classList.add('hidden');
            if (state.requests) state.requests.shown(false);
            return false;
        }
        const heading = document.getElementById('run-heading');
        if (heading) heading.active = 'requests';
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        document.getElementById('table-container')?.classList.add('hidden');
        document.getElementById('console-table')?.classList.add('hidden');
        document.getElementById('info-tab-content')?.classList.add('hidden');
        document.getElementById('links-tab-content')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        const r = requests();
        if (node) node.classList.remove('hidden');
        if (r) r.shown(true);
        return true;
    }

    // The Console hidden (another Hub tab, a minimised window): no reloads until it is seen again
    document.addEventListener('visibilitychange', () => {
        if (state.requests) state.requests.shown(document.visibilityState === 'visible' && state.onTab);
    });

    // The tab's count from the start, and live from then on: the table is made (unseen) to hear it.
    // On load: this script comes before console-page.js, which holds the host's messenger (window.vscode)
    window.addEventListener('load', () => { requests(); post({ type: 'console.requests.counts' }); });

    /**
     * The full transaction for a request seen on another tab (an Input, Completed or Error row's right-click, "View
     * full transaction"): its window from the Console's own record of it, the bodies from the host. No ↑ ↓ there.
     * (design system, for Raw's retirement, B22)
     */
    function openFor(response) {
        const meta = (response && response.metadata) || {};
        const id = meta.executionId;
        const r = requests();
        if (!id || !r) return false;
        const status = String(response.status || meta.status || '').toLowerCase();
        r.openRow({
            id, n: (meta.memberIndex !== undefined ? meta.memberIndex : 0), status: status === 'success' ? 'completed' : status,
            http: typeof response.httpStatus === 'number' ? response.httpStatus : null, httpText: response.httpStatusText || '',
            timeMs: meta.responseTime !== undefined ? meta.responseTime : null, sent: meta.timestamp || null,
            reason: null, method: null, url: null, query: {}, requestHeaders: [], response: { contentType: '' }, responseHeaders: [], hasLogs: true
        });
        return true;
    }

    window.ConsoleRequests = { onSwitchTab, openFor, get state() { return { total: state.total, shown: !!(state.requests && state.requests.state.shown) }; } };
})();
