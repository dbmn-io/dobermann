// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's run heading (#464): wires <dbmn-run-heading> (shared/dbmn-run-heading.js) to the host. Draws nothing.
 *
 *   host → page  console.details { details }   the environment and the name (screens/console/run-details.ts)
 *   page → host  console.rename { name }       → console.named { name }: the name the host kept
 *   page → host  console.openEnvironment { environmentId }   the environment's link
 *   a tab picked → the report manager's switchTab
 *
 * Until the details come, the heading reads the page's own title (console.html's #report-title, hidden), so the
 * name and environment show at once. The tabs are console-page.js's (createDynamicTabs). ⓘ opens <dbmn-run-details>
 * in a window; console.figures (#465) goes to the footer's box (console-page.js paintProgressStats).
 * Browser: window.ConsoleRunHeading.
 */
(function () {
    'use strict';
    const state = { details: null, figures: null };
    const heading = () => document.getElementById('run-heading');
    const post = message => { if (window.vscode) window.vscode.postMessage(message); };

    /** From the page's own title until the host's details come: "DBMN Local: Inventory-Errors 20 Nov 20:14". */
    function fromTitle() {
        const h = heading();
        if (!h || state.details) return;
        const name = document.getElementById('report-title-name');
        const line = name && name.parentElement ? name.parentElement.textContent || '' : '';
        const env = line.slice(0, Math.max(0, line.indexOf(':'))).trim();
        h.environment = env ? { name: env } : null;
        h.name = name ? name.textContent.trim() : '';
    }

    function applyDetails(details) {
        const h = heading();
        if (!h || !details) return;
        state.details = details;
        h.environment = details.environment && details.environment.name ? { name: details.environment.name } : null;
        h.name = details.name || '';
    }

    function named(name) {
        const h = heading();
        if (h) h.name = name || '';
        if (state.details) state.details = { ...state.details, name: name || '' };
        const title = document.getElementById('report-title-name');
        if (title) title.textContent = name || '';
    }

    function wire() {
        const h = heading();
        if (!h || h._consoleWired) return;
        h._consoleWired = true;
        h.addEventListener('dbmn-run-heading-tab', e => {
            const manager = window.dynamicReportManager;
            if (!manager || !e.detail || !e.detail.id) return;
            // (the person picked a tab: the first result no longer moves them to Completed, console-page.js)
            manager._userPickedTab = true;
            manager.switchTab(e.detail.id);
        });
        h.addEventListener('dbmn-name-change', e => {
            const name = e.detail && e.detail.name;
            if (name) post({ type: 'console.rename', name });
        });
        h.addEventListener('dbmn-run-heading-environment', () => {
            const id = state.details && state.details.environment && state.details.environment.id;
            if (id) post({ type: 'console.openEnvironment', payload: { environmentId: id } });
        });
        h.addEventListener('dbmn-run-heading-info', openDetails);
        // The old title's marks move into the heading (the web app's "Runs in DBMN for VS Code")
        const agent = document.querySelector('#report-title .agent-link');
        if (agent) h.marks = [agent];
        fromTitle();
    }

    /** ⓘ: the run's details (<dbmn-run-details>) in a window; kept up to date while it is open. */
    function openDetails() {
        const el = document.createElement('dbmn-run-details');
        el.details = state.details;
        // The Endpoint: opened, the window closed so it is in front
        el.addEventListener('dbmn-run-details-open', event => {
            const { what, id } = event.detail || {};
            if (!id || what !== 'endpoint') return;
            if (window.DbmnModal && window.DbmnModal.requestDismiss) window.DbmnModal.requestDismiss();
            post({ type: 'console.openEndpoint', payload: { endpointId: id } });
        });
        state.open = el;
        if (window.DbmnModal && window.DbmnModal.alert) {
            Promise.resolve(window.DbmnModal.alert({ title: 'This run', body: el, okLabel: 'Close' })).finally(() => { if (state.open === el) state.open = null; });
        }
    }

    window.addEventListener('message', event => {
        const m = event.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'console.details') { applyDetails(m.details); if (state.open) state.open.details = m.details; }
        else if (m.type === 'console.named') named(m.name);
        else if (m.type === 'console.figures') {
            state.figures = m.figures || null;
            // (the footer's box draws them: console-page.js paintProgressStats)
            if (typeof window.paintProgressStats === 'function') window.paintProgressStats();
        }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.ConsoleRunHeading = { details: () => state.details, figures: () => state.figures, named, openDetails };
})();
