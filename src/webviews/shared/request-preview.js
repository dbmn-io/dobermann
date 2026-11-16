// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Request Preview
 *
 * Run Batch Step 4 → the first requests the batch will send (GitHub Issue #308), each as the
 * Console Raw tab's transaction card (shared/transaction-card.css): header, the INPUT rows
 * behind it, and the REQUEST — Body, or Details (method, URL, query parameters, headers).
 * No response: nothing has been sent yet.
 *
 * Pure: plan in, HTML / text out, everything from the plan or the data escaped. The page
 * wires the clicks (shared/data-transformer.js) and fills the editors.
 * Browser: window.RequestPreview. Node: module.exports (tests, standalone renders).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    if (root && typeof root === 'object') { root.RequestPreview = api; }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    const esc = (text) => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const MAX_INPUT_ROWS = 25;

    function formatSize(bytes) {
        if (!bytes && bytes !== 0) return '-';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function readable(url) {
        try { return decodeURIComponent(url); } catch { return url; }
    }

    /** The REQUEST pane's Details text — the same layout as the Raw tab's. */
    function detailsText(request, endpointHeaders) {
        const lines = ['// ENDPOINT', `${request.method} ${readable(request.url)}`];
        const params = Object.entries(request.queryParams || {});
        if (params.length) {
            lines.push('', '// QUERY PARAMETERS', ...params.map(([k, v]) => `${k}: ${v}`));
        }
        const headers = Object.entries(endpointHeaders || {});
        if (headers.length) {
            lines.push('', '// HEADERS', ...headers.map(([k, v]) => `${k}: ${v}`));
        }
        return lines.join('\n');
    }

    function keyText(request) {
        return (request.key || []).map(k => `${k.variable} ${k.value}`).join(' · ');
    }

    function inputTable(request, columns) {
        if (!request.inputRows || request.inputRows.length === 0 || !columns || columns.length === 0) return '';
        const shown = request.inputRows.slice(0, MAX_INPUT_ROWS);
        const more = request.inputRows.length - shown.length;
        return `<div class="raw-csv-data-wrapper"><div class="raw-csv-data-section">
            <div class="raw-csv-header"><span>INPUT (${request.inputRows.length.toLocaleString()} row${request.inputRows.length === 1 ? '' : 's'}${more > 0 ? `, first ${MAX_INPUT_ROWS} shown` : ''})</span></div>
            <div class="raw-csv-table-wrapper"><table class="raw-csv-table">
                <thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                <tbody>${shown.map(row => `<tr>${columns.map((c, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
            </table></div>
        </div></div>`;
    }

    /**
     * One card per previewed request, collapsed except the first.
     * @param {Object} plan       data-loading/batch-plan.ts BatchPlan (requests carry bodyText)
     * @param {string[]} columns  the CSV header row, for the INPUT tables
     */
    function renderCards(plan, columns) {
        if (!plan || !plan.requests || plan.requests.length === 0) {
            return '<div class="raw-compact-view">No requests to preview.</div>';
        }
        const cards = plan.requests.map((request, i) => {
            const expanded = i === 0;
            const hasBody = request.body !== null && request.body !== undefined;
            const toggle = hasBody
                ? `<div class="raw-view-mode-group">
                       <button type="button" class="raw-view-mode-btn active" data-action="mode" data-mode="body">Body</button>
                       <button type="button" class="raw-view-mode-btn" data-action="mode" data-mode="details">Details</button>
                   </div>`
                : '';
            const key = keyText(request);
            return `<div class="raw-card ${expanded ? 'expanded' : 'collapsed'}" data-request-index="${i}">
                <div class="raw-card-header" data-action="toggle">
                    <span class="raw-card-toggle">${expanded ? '▼' : '▶'}</span>
                    <span class="raw-card-title">Request #${request.index}</span>
                    ${key ? `<span class="raw-timestamp">${esc(key)}</span>` : ''}
                    <span class="raw-response-time">${request.rowCount.toLocaleString()} row${request.rowCount === 1 ? '' : 's'} · ${formatSize(request.size)}</span>
                </div>
                <div class="raw-card-body"><div class="raw-card-body-inner">
                    ${inputTable(request, columns)}
                    <div class="raw-panes-section"><div class="raw-panes-wrapper"><div class="raw-panes-container response-hidden">
                        <div class="raw-pane raw-request-pane">
                            <div class="raw-pane-header">
                                <span class="raw-pane-title">REQUEST</span>
                                ${toggle}
                                <div class="raw-pane-header-actions">
                                    <button type="button" class="raw-pane-copy-btn" data-action="copy" title="Copy Request">
                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                                    </button>
                                    <button type="button" class="raw-pane-fullscreen-btn" data-action="fullscreen" title="Toggle full window (Esc to exit)" aria-pressed="false" aria-label="Toggle full window">
                                        <svg class="icon-enter" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h4v1H3v3H2V2zm12 0h-4v1h3v3h1V2zM2 14h4v-1H3v-3H2v4zm12 0h-4v-1h3v-3h1v4z"/></svg>
                                        <svg class="icon-exit" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6 2v4H2V5h3V2h1zm4 0v4h4V5h-3V2h-1zm0 12v-4h4v1h-3v3h-1zm-4 0v-4H2v1h3v3h1z"/></svg>
                                    </button>
                                </div>
                            </div>
                            <div class="raw-monaco-container" data-request-mode="${hasBody ? 'body' : 'details'}"></div>
                        </div>
                    </div></div></div>
                </div></div>
            </div>`;
        }).join('');
        const more = plan.totals.requests - plan.requests.length;
        return cards + (more > 0 ? `<div class="raw-compact-view">… and ${more.toLocaleString()} more request${more === 1 ? '' : 's'}</div>` : '');
    }

    /** What a card's editor shows in a mode: the body as sent (or unencoded), or the details. */
    function contentFor(request, mode, endpointHeaders, unencoded) {
        if (mode === 'details' || request.body === null || request.body === undefined) {
            return { text: detailsText(request, endpointHeaders), language: 'plaintext' };
        }
        const text = unencoded && request.unencodedBodyText ? request.unencodedBodyText : (request.bodyText || JSON.stringify(request.body, null, 2));
        return { text, language: 'json' };
    }

    return { renderCards, contentFor, detailsText, formatSize };
}));
