// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's Review as the Requests table (#466/#470, slice 4; James, 2026-11-24: "When we're in the review we're
 * showing the request tab and then when you start executing you see the same request tab there"): the shared
 * Requests table (shared/dbmn-requests.js, the Console's) on Ready rows, made from the batch plan a page at a time
 * (run-batch.controller.ts handlePlannedRequests → console/requests/planned-batch-requests.ts). It takes the
 * request cards' place in Review's Requests section. Nothing is sent yet: Response, HTTP, Time and Sent are '—';
 * the menu offers View full transaction only; the input rows in the window come from the plan.
 *
 * data-transformer.js calls ReviewRequests.drawn() after Review's plan is drawn, and onStep(n) as the steps change.
 */
(function () {
    'use strict';
    const state = { requests: null, step: 0 };
    const post = message => window.vscode && window.vscode.postMessage(message);

    function section() { return document.querySelector('#csvJsonPreviewStep .review-requests'); }

    function mount() {
        if (state.requests) return state.requests;
        const where = section();
        if (!where || !window.DbmnRequests) return null;
        const box = document.createElement('div');
        box.className = 'review-requests-table';
        where.appendChild(box);
        state.requests = window.DbmnRequests.mount(box, {
            post,
            // (the window's panes in Run Batch's Monaco: JSON coloured and folding, as the Console's)
            editor: window.DbmnCodePane ? window.DbmnCodePane.make : null,
            whenEditorReady: window.DbmnCodePane ? window.DbmnCodePane.whenReady : null,
            // (the run heading's Requests tab counts them: its own count reads Review's totals)
            counts: () => { if (window.RunBatchHeading) window.RunBatchHeading.refresh(); }
        });
        return state.requests;
    }

    /** Review's plan was drawn: the table in the cards' place, asked again (other rows, mappings, Reps). */
    function drawn() {
        const where = section();
        if (!where) return;
        const first = !state.requests;
        const r = mount();
        if (!r) return;
        where.classList.add('has-requests-table');
        // (every request is in the table, not samples)
        const title = document.getElementById('requestPreviewTitle');
        if (title) title.textContent = 'Requests';
        r.shown(true);
        if (!first) r.reload();
    }

    function onStep(n) {
        state.step = n;
        if (state.requests) state.requests.shown(n === 4);
    }

    window.ReviewRequests = { drawn, onStep, get mounted() { return !!state.requests; } };
})();
