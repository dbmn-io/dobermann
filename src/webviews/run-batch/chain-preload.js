// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: a chained Run Batch.
 *
 * The rows come from a Console's Completed tab and ARE the input: there is no Step 1, no file,
 * no paste. They load by themselves (through the same parse the Paste tab uses), then the
 * skip-ahead rule (dt-auto-advance.js) lands on Step 2, 3 or 4. Back stops at Step 2. A banner
 * says where the rows came from, with a link to that run's Console.
 *
 * activeSourceId() is what Execute sends, so the batch is linked to the run its rows came
 * from. Nothing before Execute records anything.
 */
(function () {
    'use strict';

    let chained = null;   // { csv, sourceExecutionId }

    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function banner(message) {
        let el = document.getElementById('chainSourceBanner');
        if (!el) {
            const container = document.getElementById('csvBatchContainer');
            if (!container) return;
            el = document.createElement('div');
            el.id = 'chainSourceBanner';
            el.className = 'info-banner chain-source-banner';
            el.setAttribute('data-help', 'chain#chained-run-batch');
            container.insertBefore(el, container.firstChild);
        }
        const rows = Number(message.rowCount) || 0;
        const view = message.viewName ? ` · view “${esc(message.viewName)}”` : '';
        el.innerHTML = `<span class="info-icon">i</span><span>Chained from
            <a href="#" class="text-link" id="chainSourceLink" title="Open that run's Console">${esc(message.sourceLabel)}</a>${view}
            · ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}</span>`;
        el.querySelector('#chainSourceLink').addEventListener('click', function (event) {
            event.preventDefault();
            if (window.vscode) window.vscode.postMessage({ type: 'openChainSource' });
        });
    }

    function apply(message) {
        const h = window.CSVHandler;
        const area = document.getElementById('csvPasteArea');
        if (!h || !area || !message || !message.csv) return;

        document.body.classList.add('chained-run');
        if (h.resetCSVModal) h.resetCSVModal();
        banner(message);

        // The Paste tab is hidden with the rest of Step 1; it is just the way in.
        if (h.switchTab) h.switchTab('paste');
        area.value = message.csv;
        chained = { csv: message.csv.trim(), sourceExecutionId: message.sourceExecutionId, sourceLabel: message.sourceLabel || '' };
        if (h.handlePasteAreaChange) h.handlePasteAreaChange();

        setTimeout(function () {
            const s = h.csvState || (h.getState && h.getState());
            if (s && s.modalStep === 1 && h.goToNextStep) h.goToNextStep();
        }, 0);
    }

    /** showCSVStep: CSS hides Step 1 and Step 2's Back off this. */
    function onStep(stepNumber) {
        document.body.dataset.csvStep = String(stepNumber);
    }

    /** goToPreviousStep: a chained run never goes back to Step 1. */
    function blocksBack(currentStep) {
        return !!chained && currentStep <= 2;
    }

    function activeSourceId() {
        const area = document.getElementById('csvPasteArea');
        if (!chained || !area) return undefined;
        return area.value.trim() === chained.csv ? chained.sourceExecutionId : undefined;
    }

    window.ChainPreload = { apply, onStep, blocksBack, activeSourceId, isChained: () => !!chained, sourceLabel: () => (chained ? chained.sourceLabel : '') };
})();
