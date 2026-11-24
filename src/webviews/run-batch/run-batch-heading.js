// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's run heading (#470; James, 2026-11-24: "Run Batch builds the Console in one tab"): the same
 * <dbmn-run-heading> as the Console's, so the tab that becomes the run's Console already wears its line. Draws nothing.
 *
 *   the environment   from currentEnvironmentData (its name; a click shows "Sending To")
 *   the name          Review's Name field (#batchNameInput), kept in step both ways
 *   the tabs          Input from Validate on (its rows), Requests on Review (its requests); a tab goes to its step
 *   ⓘ                 Review's "Sending To", where the rows go
 *
 * data-transformer.js's showCSVStep calls RunBatchHeading.onStep(n). Browser: window.RunBatchHeading.
 */
(function () {
    'use strict';
    const state = { step: 1, reviewed: false, environment: null, rows: null, requests: null };
    const heading = () => document.getElementById('run-heading');
    const nameBox = () => document.getElementById('batchNameInput');

    function rowCount() {
        const data = window.currentParsedCsvData;
        return Array.isArray(data) ? data.length : null;
    }
    function requestCount() {
        const el = document.getElementById('totalApiCallsDisplay');
        const n = el ? Number(String(el.textContent || '').replace(/[^0-9]/g, '')) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function draw() {
        const h = heading();
        if (!h) return;
        h.hidden = state.step < 3;
        const tabs = [];
        if (state.step >= 3) tabs.push({ id: 'input', label: 'Input', count: rowCount() === null ? undefined : rowCount() });
        // (Requests stays once Review has made them, Back or not: James, 2026-11-25; a new file starts again)
        if (state.step >= 4 || state.reviewed) tabs.push({ id: 'requests', label: 'Requests', count: requestCount() === null ? undefined : requestCount() });
        h.tabs = tabs;
        h.active = state.step === 4 ? 'requests' : 'input';
        const box = nameBox();
        h.name = box && box.value ? box.value : (box && box.placeholder) || '';
        h.unnamed = !(box && box.value);
        h.environment = state.environment ? { name: state.environment.name } : null;
    }

    function wire() {
        const h = heading();
        if (!h || h._runBatchWired) return;
        h._runBatchWired = true;
        h.addEventListener('dbmn-run-heading-tab', e => {
            const to = e.detail && e.detail.id === 'requests' ? 4 : 3;
            const run = window.CSVHandler;
            if (to !== state.step && run && typeof run.goToStep === 'function') run.goToStep(to);
        });
        h.addEventListener('dbmn-name-change', e => {
            const box = nameBox();
            if (!box || !e.detail) return;
            box.value = e.detail.name || '';
            box.dispatchEvent(new Event('input', { bubbles: true }));
            box.dispatchEvent(new Event('change', { bubbles: true }));
            draw();
        });
        h.addEventListener('dbmn-run-heading-info', () => {
            const where = document.querySelector('#csvJsonPreviewStep .execution-section');
            if (where && state.step === 4) where.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        // (the environment's link: Run Batch's host opens nothing yet, so it shows where the run goes)
        h.addEventListener('dbmn-run-heading-environment', () => h.dispatchEvent(new CustomEvent('dbmn-run-heading-info', { bubbles: true })));
        const box = nameBox();
        if (box) box.addEventListener('input', draw);
        draw();
    }

    window.addEventListener('message', event => {
        const m = event.data;
        if (m && m.type === 'currentEnvironmentData' && m.environment) { state.environment = m.environment; draw(); }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.RunBatchHeading = {
        onStep(n) {
            state.step = n;
            if (n >= 4) state.reviewed = true;
            if (n === 1) state.reviewed = false;
            draw();
        },
        refresh: draw
    };
})();
