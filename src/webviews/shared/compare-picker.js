// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: Compare's Select step: what is compared.
 *
 * Compare the Baseline to: other results from this endpoint (tick up to three), results from any
 * endpoint, or a file from your computer (both Coming soon: shown so the way Compare grows is
 * plain). Each result shows its environment's header values (org 880): its "virtual environment".
 * The first column picks the Baseline (BL; from the Console, the result it showed). The picks
 * are BL first, then C1, C2, C3 in the order ticked: Compare shows them in its slots across the
 * top of the screen (compare-page.js), from onChange's second argument.
 *
 * UI only: the host lists the results and saves the compare. Shared patterns: the modal's radio
 * rows ([role=radiogroup] of labels), the tables' .table-container and .data-table (as every
 * other table), .status-pill-generic, .status-indicator.
 *
 *   ComparePicker.mount(container, { runs, baselineId, picked, max, onChange })
 *     → { choice(): { baselineId, ids } | null }   (ids: the C results, in order; null: not enough picked)
 *   onChange(choice, picks) runs on every change; picks is { baselineId, ids } as they stand,
 *   whether or not there are enough.
 */
(function () {
    'use strict';

    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function when(iso) {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function statusPill(run) {
        const ok = run.status === 'completed';
        const pill = `<span class="status-pill-generic ${ok ? 'success' : 'warning'}">${esc(String(run.status || '').replace(/_/g, ' '))}</span>`;
        const incomplete = run.incomplete
            ? ' <span class="status-pill-generic warning" title="Not every page was fetched. Rows on the pages not fetched will look missing.">Incomplete</span>'
            : '';
        return pill + incomplete;
    }
    /** The Baseline is BL; the others are C1, C2, C3 (as in Compare). */
    function letter(place) { return place === 0 ? 'BL' : `C${place}`; }
    /** A header value's tooltip: "org 840 (Brisbane)". */
    function headerTitle(h) { return `${h.name} ${h.value}${h.label ? ` (${h.label})` : ''}`; }
    /**
     * Where a result ran, as text: its environment and its header values ("DEV 880"). One
     * environment run for two companies is two places to compare.
     */
    function placeName(run) {
        return [run.environment].concat((run.header || []).map(h => h.value)).join(' ');
    }
    /** The same, for a table cell: the header values as pills beside the environment. */
    function placeCell(run) {
        return esc(run.environment) + (run.header || []).map(h => ` <span class="status-pill-generic" title="${esc(headerTitle(h))}">${esc(h.value)}</span>`).join('');
    }

    const CHOICES = [
        { id: 'same', label: 'Other results from this endpoint' },
        { id: 'endpoint', label: 'Other results from any endpoint', soon: true },
        { id: 'file', label: 'A file from your computer', soon: true }
    ];

    function mount(container, opts) {
        const runs = opts.runs || [];
        const byId = new Map(runs.map(r => [r.id, r]));
        const max = opts.max || 4;
        let baselineId = byId.has(opts.baselineId) ? opts.baselineId : (runs[0] && runs[0].id);
        let picked = (opts.picked || []).filter(id => id !== baselineId && byId.has(id));
        let choice = 'same';

        container.innerHTML = `
            <div class="dbmn-modal-field">
                <label id="compare-picker-with">Compare the Baseline to</label>
                <div role="radiogroup" aria-labelledby="compare-picker-with" class="compare-picker-choices">
                    ${CHOICES.map(c => `
                        <label data-choice="${c.id}"><input type="radio" name="compare-with" value="${c.id}" ${c.id === choice ? 'checked' : ''}>
                        <span>${esc(c.label)}</span>
                        ${c.soon ? '<small><span class="compare-soon">Coming soon</span></small>' : ''}</label>`).join('')}
                </div>
            </div>
            <div class="compare-picker-panel" id="compare-picker-panel"></div>`;

        const panel = container.querySelector('#compare-picker-panel');

        function current() {
            return choice === 'same' && !!baselineId && picked.length >= 1 && picked.length < max ? { baselineId, ids: picked.slice() } : null;
        }

        function renderSame() {
            if (runs.length < 2) {
                panel.innerHTML = `<p class="chain-empty"><span class="status-indicator status-warning">⚠ Compare needs another result of this endpoint. Run it again, or in another environment, then compare.</span></p>`;
                return;
            }
            const full = picked.length >= max - 1;
            const rows = runs.map(r => {
                const place = picked.indexOf(r.id);
                const isBase = r.id === baselineId;
                const tick = isBase
                    ? '<td><span class="status-pill-generic success">BL</span></td>'
                    : `<td><input type="checkbox" value="${esc(r.id)}" data-pick ${place >= 0 ? 'checked' : ''} ${place < 0 && full ? 'disabled title="Up to four results, the Baseline included"' : ''} aria-label="Compare ${esc(placeName(r))}, ${esc(when(r.executedAt))}">${place >= 0 ? ` <strong>${letter(place + 1)}</strong>` : ''}</td>`;
                const base = `<td><input type="radio" name="compare-baseline" value="${esc(r.id)}" data-baseline ${isBase ? 'checked' : ''} aria-label="Baseline: ${esc(placeName(r))}, ${esc(when(r.executedAt))}"></td>`;
                return `<tr class="${isBase ? 'is-baseline' : ''}">${base}${tick}<td>${placeCell(r)}</td><td>${esc(when(r.executedAt))}</td><td>${statusPill(r)}</td></tr>`;
            }).join('');
            panel.innerHTML = `
                <div class="table-container compare-picker-runs">
                    <table class="data-table"><thead><tr><th>Baseline</th><th>Compare</th><th>Environment</th><th>Run at</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
                </div>
                <p class="form-hint">Compare up to four results at a time, the Baseline included.</p>`;
        }

        /** Another endpoint and a file: on the way. */
        function renderSoon() {
            panel.innerHTML = '<div class="compare-picker-soon"><span class="compare-soon">Coming soon</span></div>';
        }

        function render() {
            if (choice === 'same') renderSame(); else renderSoon();
            if (opts.onChange) opts.onChange(current(), { baselineId, ids: picked.slice() });
        }

        container.onchange = event => {
            const t = event.target;
            if (t.name === 'compare-with') { choice = t.value; render(); return; }
            if (t.hasAttribute('data-baseline')) {
                baselineId = t.value;
                picked = picked.filter(id => id !== baselineId);
                render();
                return;
            }
            if (t.hasAttribute('data-pick')) {
                picked = t.checked ? picked.concat(t.value).slice(0, max - 1) : picked.filter(id => id !== t.value);
                render();
            }
        };
        render();
        return { choice: current };
    }

    window.ComparePicker = { mount, letter, placeName };
})();
