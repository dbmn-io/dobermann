// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Validate's search (slice 5, #470: Validate in Results' style; James's mock v18/v19, "the toolbar is Results' own":
 * the search with ★ and how many rows it shows). The box searches Validate's table as Query's and the Console's do
 * (dbmn-table searchWith: words, @column=value, the colours and suggestions), on top of what Status and the
 * columns' counts leave. The ★ keeps the same list as the Console's Input tab (it is the same tab, before the run),
 * through the host (runBatch.inputSearches.*). The count by the box: "1,000 rows", or "1 of 1,000 rows" while the
 * box or a filter leaves fewer. And the run heading's Input tab: its amber count, the rows to fix (mock v18: "one amber
 * count on the Input tab that filters to the invalid rows"), a click on it showing only them. Draws nothing of its own.
 *
 * data-transformer.js's showCSVStep calls ValidateSearch.onStep(n). Browser: window.ValidateSearch.
 */
(function () {
    'use strict';
    const post = message => window.vscode && window.vscode.postMessage(message);
    const state = { table: null, asked: false };
    const $ = id => document.getElementById(id);

    /** All the rows Validate holds (its model), whatever is filtered. */
    function allRows() {
        const s = window.CSVHandler && window.CSVHandler.csvState;
        const model = s && s.gridDataModel;
        return Array.isArray(model) ? model.length : 0;
    }
    function count(shown) {
        const label = $('gridRowCount');
        if (!label) return;
        const total = allRows();
        const n = typeof shown === 'number' ? shown : total;
        label.textContent = n === total ? `${total.toLocaleString()} row${total === 1 ? '' : 's'}` : `${n.toLocaleString()} of ${total.toLocaleString()} rows`;
        issues();
    }

    /** The Input tab's amber count: the rows to fix now (none: no count). */
    function issues() {
        const heading = $('run-heading');
        const s = window.CSVHandler && window.CSVHandler.csvState;
        const n = s && s.gridErrorRows ? s.gridErrorRows.size : 0;
        if (heading && typeof heading.setIssues === 'function') heading.setIssues('input', n);
    }
    /** Its click: Validate (from Review, back to it), only the rows to fix. */
    function showInvalid() {
        const s = window.CSVHandler && window.CSVHandler.csvState;
        if (s && s.modalStep !== 3 && window.CSVHandler.goToStep) window.CSVHandler.goToStep(3);
        setTimeout(() => {
            const table = $('validateGrid');
            if (table) table.dispatchEvent(new CustomEvent('dbmn-table-filter', { bubbles: true, detail: { id: '__status', values: ['invalid'] } }));
        }, 0);
    }
    document.addEventListener('dbmn-run-heading-issues', e => { if (e.detail && e.detail.id === 'input') showInvalid(); });

    /** The table Validate has now (made again when Validate starts over): the box, the ★ and the count follow it. */
    function wire() {
        const table = $('validateGrid');
        const input = $('gridSearch');
        if (!table || !input || state.table === table) return;
        state.table = table;
        if (typeof table.searchWith === 'function') table.searchWith(input, $('gridSearchMirror'));
        table.addEventListener('dbmn-table-shown', e => count(e.detail && e.detail.shown));
        const saved = $('gridSaved');
        if (saved && !saved._validateWired) {
            saved._validateWired = true;
            saved.input = input;
            saved.addEventListener('dbmn-saved-change', e => {
                const searches = (e.detail && e.detail.searches) || [];
                saved.searches = searches;
                post({ type: 'runBatch.inputSearches.save', searches });
            });
        }
        if (!state.asked) { state.asked = true; post({ type: 'runBatch.inputSearches.load' }); }
        count();
    }

    window.addEventListener('message', event => {
        const m = event.data;
        if (!m || m.type !== 'runBatch.inputSearches') return;
        const saved = $('gridSaved');
        if (saved) { saved.searches = Array.isArray(m.searches) ? m.searches : []; saved.hidden = false; }
    });

    function onStep(n) {
        if (n === 3) setTimeout(wire, 0);
    }

    window.ValidateSearch = { onStep, wire, count, issues };
})();
