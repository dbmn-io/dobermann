// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Column-Mismatch Repair Editor
 * GitHub Issue #226: Detect rows whose column count differs from the header
 * and let the user fix them by hand. Inline click-to-edit per row, nothing
 * else. If the file has too many bad rows, fix the source and re-upload.
 */
(function () {
    'use strict';

    let csvState = null;
    let getVscode = null;

    let mounted = null;
    // mounted = {
    //   panelEl, rowsEl, headingEl, totalEl, continueEl, cancelEl,
    //   fileName,
    //   lines: string[],
    //   expectedColumns: number,
    //   delimiter: ',' | '\t' | '|',
    //   badIndices: Set<number>,
    //   viewFilter: 'all' | 'flagged',
    //   rowEls: Map<number, HTMLElement>,
    //   editingIdx: number | null,
    // }

    function init(state, vscodeAccessor) {
        csvState = state;
        getVscode = vscodeAccessor;
    }

    function findContainer() {
        return document.getElementById('csvMismatchRepairContainer')
            || document.getElementById('csvModalPreview')
            || null;
    }

    function countColumns(line, delimiter) {
        if (!window.CSVHandler || !window.CSVHandler.parseCSVLine) {
            return line.split(delimiter).length;
        }
        return window.CSVHandler.parseCSVLine(line, delimiter).length;
    }

    function rebuildContent(state) {
        return state.lines.join('\n');
    }

    // -------------------------------------------------------- DOM construction

    function makeRowEl(state, idx) {
        const line = state.lines[idx];
        const isHeader = idx === 0;
        const cols = countColumns(line, state.delimiter);
        const isBad = !isHeader && cols !== state.expectedColumns;

        const row = document.createElement('div');
        row.className = 'mismatch-edit-row' + (isHeader ? ' is-header' : '') + (isBad ? ' is-bad' : '');
        row.dataset.idx = String(idx);

        const num = document.createElement('span');
        num.className = 'mismatch-edit-row-num';
        num.textContent = String(idx + 1);
        row.appendChild(num);

        const text = document.createElement('span');
        text.className = 'mismatch-edit-row-text';
        text.textContent = line;
        if (!isHeader) {
            text.title = 'Click to edit';
            text.addEventListener('click', function () { startEdit(state, idx); });
        }
        row.appendChild(text);

        const pill = document.createElement('span');
        pill.className = 'mismatch-edit-row-pill' + (isBad ? ' is-bad' : '');
        pill.textContent = `${cols} cols`;
        row.appendChild(pill);

        return row;
    }

    function startEdit(state, idx) {
        if (idx === 0) return; // header is read-only
        const row = state.rowEls.get(idx);
        if (!row) return;
        if (state.editingIdx !== null) commitEdit(state);

        state.editingIdx = idx;
        const text = row.querySelector('.mismatch-edit-row-text');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mismatch-edit-row-input';
        input.value = state.lines[idx];
        input.spellcheck = false;
        input.autocomplete = 'off';
        text.replaceWith(input);

        function liveUpdate() {
            const cols = countColumns(input.value, state.delimiter);
            const pill = row.querySelector('.mismatch-edit-row-pill');
            const isBad = cols !== state.expectedColumns;
            pill.textContent = `${cols} cols`;
            pill.classList.toggle('is-bad', isBad);
            row.classList.toggle('is-bad', isBad);
        }

        input.addEventListener('input', liveUpdate);
        input.addEventListener('blur', function () { commitEdit(state); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') {
                state.editingIdx = null;
                renderSingleRow(state, idx);
            }
        });
        input.focus();
        input.setSelectionRange(0, 0);
    }

    function commitEdit(state) {
        if (state.editingIdx === null) return;
        const idx = state.editingIdx;
        const row = state.rowEls.get(idx);
        if (!row) { state.editingIdx = null; return; }

        const input = row.querySelector('.mismatch-edit-row-input');
        if (!input) { state.editingIdx = null; return; }

        const newText = input.value;
        state.editingIdx = null;

        if (newText === state.lines[idx]) {
            renderSingleRow(state, idx);
            return;
        }

        state.lines[idx] = newText;

        const cols = countColumns(newText, state.delimiter);
        if (cols === state.expectedColumns) {
            state.badIndices.delete(idx);
        } else {
            state.badIndices.add(idx);
        }
        renderSingleRow(state, idx);

        updateContinue(state);
    }

    function renderSingleRow(state, idx) {
        const oldEl = state.rowEls.get(idx);
        if (!oldEl) return;
        const newEl = makeRowEl(state, idx);
        oldEl.replaceWith(newEl);
        state.rowEls.set(idx, newEl);
        applyViewFilter(state, idx, newEl);
    }

    function recomputeAll(state) {
        const bad = new Set();
        for (let i = 1; i < state.lines.length; i++) {
            const cols = countColumns(state.lines[i], state.delimiter);
            if (cols !== state.expectedColumns) bad.add(i);
        }
        state.badIndices = bad;
    }

    function applyViewFilter(state, idx, el) {
        if (state.viewFilter === 'flagged' && idx !== 0 && !state.badIndices.has(idx)) {
            el.classList.add('is-hidden');
        } else {
            el.classList.remove('is-hidden');
        }
    }

    function applyViewFilterAll(state) {
        state.rowEls.forEach(function (el, idx) { applyViewFilter(state, idx, el); });
    }

    function updateContinue(state) {
        state.continueEl.disabled = state.badIndices.size > 0;
    }

    function onViewToggle(state) {
        state.viewFilter = state.viewFilter === 'all' ? 'flagged' : 'all';
        applyViewFilterAll(state);
        if (state.viewBtn) {
            state.viewBtn.textContent = state.viewFilter === 'all' ? 'Show flagged only' : 'Show all';
        }
    }

    function onContinue(state) {
        if (state.badIndices.size > 0) return;
        const repaired = rebuildContent(state);
        csvState.rawCSVContent = repaired;
        if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
            window.CSVHandler.clearModalNotification();
        }
        getVscode().postMessage({
            type: 'parseCSVForModal',
            csvData: repaired,
            fileName: state.fileName,
            fileSize: repaired.length
        });
    }

    function onCancel(state) {
        csvState.rawCSVContent = '';
        if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
            window.CSVHandler.clearModalNotification();
        }
        const paste = document.getElementById('csvPasteArea');
        if (paste) paste.value = '';
        const file = document.getElementById('csvModalFileInput');
        if (file) file.value = '';
        hide();
    }

    // -------------------------------------------------------------- public API

    function show(columnMismatch, options) {
        if (!columnMismatch || !columnMismatch.rows || columnMismatch.rows.length === 0) {
            hide();
            return;
        }

        const container = findContainer();
        if (!container) return;

        const prior = container.querySelector('.mismatch-edit-panel');
        if (prior) prior.remove();

        const step1 = document.getElementById('csvUploadStep');
        if (step1) step1.classList.add('csv-upload-step--repairing');

        container.classList.remove('hidden');

        const fullContent = (csvState && csvState.rawCSVContent) || '';
        const lines = fullContent.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

        const state = {
            panelEl: null,
            rowsEl: null,
            viewBtn: null,
            continueEl: null,
            cancelEl: null,
            fileName: (options && options.fileName) || 'pasted-data.csv',
            lines: lines,
            expectedColumns: columnMismatch.expectedColumns,
            delimiter: columnMismatch.delimiter || ',',
            badIndices: new Set(),
            viewFilter: 'all',
            rowEls: new Map(),
            editingIdx: null
        };

        recomputeAll(state);

        // Build DOM
        const panel = document.createElement('div');
        panel.className = 'mismatch-edit-panel';
        state.panelEl = panel;

        // No heading bar — the blocking notification at the bottom of the
        // modal already reports the count. Sticky row 1 sits flush at the top.

        // Row list
        const rowsContainer = document.createElement('div');
        rowsContainer.className = 'mismatch-edit-rows';
        state.rowsEl = rowsContainer;

        for (let i = 0; i < state.lines.length; i++) {
            const rowEl = makeRowEl(state, i);
            rowsContainer.appendChild(rowEl);
            state.rowEls.set(i, rowEl);
        }
        panel.appendChild(rowsContainer);

        // Footer (view toggle | Cancel + Continue)
        const footer = document.createElement('div');
        footer.className = 'mismatch-edit-footer';

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-secondary mismatch-edit-view-btn';
        viewBtn.textContent = 'Show flagged only';
        viewBtn.addEventListener('click', function () { onViewToggle(state); });
        footer.appendChild(viewBtn);
        state.viewBtn = viewBtn;

        const footerActions = document.createElement('div');
        footerActions.className = 'mismatch-edit-footer-actions';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn btn-secondary mismatch-edit-cancel';
        cancel.textContent = 'Cancel & change source';
        cancel.addEventListener('click', function () { onCancel(state); });
        footerActions.appendChild(cancel);
        state.cancelEl = cancel;

        const cont = document.createElement('button');
        cont.type = 'button';
        cont.className = 'btn btn-primary mismatch-edit-continue';
        cont.textContent = 'Continue';
        cont.addEventListener('click', function () { onContinue(state); });
        footerActions.appendChild(cont);
        state.continueEl = cont;

        footer.appendChild(footerActions);
        panel.appendChild(footer);

        container.appendChild(panel);
        mounted = state;

        updateContinue(state);
    }

    function hide() {
        const container = findContainer();

        if (mounted) {
            if (mounted.panelEl && mounted.panelEl.parentNode) {
                mounted.panelEl.parentNode.removeChild(mounted.panelEl);
            }
            mounted = null;
        }

        const step1 = document.getElementById('csvUploadStep');
        if (step1) step1.classList.remove('csv-upload-step--repairing');

        if (container && container.id === 'csvMismatchRepairContainer') {
            container.classList.add('hidden');
        }
    }

    function isActive() {
        return mounted !== null;
    }

    window.DTMismatchRepair = {
        init: init,
        show: show,
        hide: hide,
        isActive: isActive
    };
})();
