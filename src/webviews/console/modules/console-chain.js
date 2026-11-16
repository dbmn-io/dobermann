// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: Chain and Links in the Console page.
 *
 *  - Chain button (toolbar, beside Copy and Export): only on the Completed tab of a completed
 *    run. Sends the tab's view + search to the host (console.chain) — the host takes the rows,
 *    with no row limit, and answers with every endpoint mapped (console.chainOptions).
 *  - Chain dialog: search endpoints, suggestions (every required variable has a column), and a
 *    mapping preview of the selected one. Chain → console.chainConfirm → Run Batch opens.
 *  - Links tab (in front of Input, only when the run has links): Came From / Sent To. The first
 *    column is the run's ID, a hyperlink to that run's Console; the endpoint links to its editor, with where it differs (environment, organization,
 *    headers) as warning badges.
 *
 * Reuses shared patterns: DbmnModal (modals.css radio rows), .execution-section cards,
 * .csv-table, .status-indicator badges, .text-link. Business logic stays in the host.
 *
 * Hooks in console.html: createDynamicTabs → decorateTabs, switchTab → onSwitchTab,
 * updateButtonVisibility → onStatus.
 */
(function () {
    'use strict';

    const state = {
        links: null,          // { upstream, downstream } once the host answered
        status: '',           // the run's status (host on load, live updates after)
        currentTab: null,
        requested: false,
        switchTo: null
    };

    function post(type, payload) {
        if (!window.vscode) return;
        window.vscode.postMessage({
            type,
            correlationId: `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: payload || {}
        });
    }

    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function linkCount() {
        return state.links ? state.links.upstream.length + state.links.downstream.length : 0;
    }

    // ---- Links tab ---------------------------------------------------------------------------

    function requestLinks() {
        state.requested = true;
        post('console.getLinks');
    }

    function makeTab() {
        const tab = document.createElement('div');
        tab.className = 'tab-item';
        tab.dataset.tab = 'links';
        tab.title = 'Links';
        tab.innerHTML = `<span class="tab-label">Links</span><span class="tab-count" data-tab="links">${linkCount()}</span>`;
        tab.onclick = () => { if (state.switchTo) state.switchTo('links'); };
        if (state.currentTab === 'links') tab.classList.add('active');
        return tab;
    }

    /** createDynamicTabs, right after it empties the tab bar: Links goes first. */
    function decorateTabs(container, switchTo) {
        state.switchTo = switchTo;
        if (!state.requested) requestLinks();
        if (container && linkCount() > 0) container.appendChild(makeTab());
    }

    function syncTab() {
        const bar = document.getElementById('report-tabs');
        if (!bar) return;
        const existing = bar.querySelector('.tab-item[data-tab="links"]');
        if (linkCount() === 0) {
            if (existing) existing.remove();
            return;
        }
        if (existing) {
            const count = existing.querySelector('.tab-count');
            if (count) count.textContent = String(linkCount());
        } else {
            bar.insertBefore(makeTab(), bar.firstChild);
        }
    }

    function panel() {
        let el = document.getElementById('links-tab-content');
        if (!el) {
            const host = document.querySelector('#report-container .tab-content');
            if (!host) return null;
            el = document.createElement('div');
            el.id = 'links-tab-content';
            el.className = 'links-tab-content hidden';
            host.appendChild(el);
        }
        return el;
    }

    function when(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function statusText(status) {
        const s = String(status || '');
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }

    function differencesCell(diffs) {
        if (!diffs || diffs.length === 0) return '<span class="status-indicator status-ok">Same environment and headers</span>';
        return diffs.map(d => `<span class="status-indicator status-warning" title="Warning only">⚠ ${esc(d.field)} ${esc(d.from)} → ${esc(d.to)}</span>`).join(' ');
    }

    function section(title, ends) {
        if (!ends || ends.length === 0) return '';
        const rows = ends.map(e => `
            <tr>
                <td><a href="#" class="text-link" data-link-run="${esc(e.executionId)}" data-link-batch="${e.isBatch ? '1' : ''}" title="Open this run's Console">${esc(e.executionId)}</a></td>
                <td>${e.endpointId
                    ? `<a href="#" class="text-link" data-link-endpoint="${esc(e.endpointId)}" title="Open this endpoint">${esc(`${e.endpointMethod} ${e.endpointName}`.trim())}</a>`
                    : esc(`${e.endpointMethod} ${e.endpointName}`.trim())}</td>
                <td>${esc(e.environment)}</td>
                <td>${esc(when(e.executionCreatedAt))}</td>
                <td>${e.viewName ? esc(e.viewName) : '—'}</td>
                <td>${e.rowCount != null ? Number(e.rowCount).toLocaleString() : '—'}</td>
                <td>${esc(statusText(e.status))}</td>
                <td>${differencesCell(e.differences)}</td>
            </tr>`).join('');
        // Review 2026-10-04: the way in comes first — the run's ID is the hyperlink.
        // (A single transaction shows its transaction ID.)
        return `
            <div class="execution-section">
                <h3>${esc(title)}</h3>
                <table class="csv-table links-table">
                    <thead><tr><th>Batch</th><th>Endpoint</th><th>Environment</th><th>When</th><th>View</th><th>Rows</th><th>Status</th><th>Differences</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    function renderPanel() {
        const el = panel();
        if (!el || !state.links) return;
        el.innerHTML = section('Came From', state.links.upstream) + section('Sent To', state.links.downstream);
    }

    document.addEventListener('click', function (event) {
        const target = event.target && event.target.closest ? event.target : null;
        const run = target && target.closest('[data-link-run]');
        const endpoint = target && target.closest('[data-link-endpoint]');
        if (run) {
            event.preventDefault();
            post('console.openLinkedRun', { executionId: run.dataset.linkRun, isBatch: run.dataset.linkBatch === '1' });
        } else if (endpoint) {
            // The same message the Settings tab's endpoint link sends.
            event.preventDefault();
            post('console.openEndpoint', { endpointId: endpoint.dataset.linkEndpoint });
        }
    });

    /** switchTab, first thing. Returns true when it handled the tab (Links). */
    function onSwitchTab(tabName) {
        state.currentTab = tabName;
        refreshChainButton();
        const el = panel();
        if (tabName !== 'links') {
            if (el) el.classList.add('hidden');
            return false;
        }
        document.querySelectorAll('.tab-item').forEach(t => t.classList.toggle('active', t.dataset.tab === 'links'));
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        document.getElementById('table-container')?.classList.add('hidden');
        document.getElementById('info-tab-content')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        renderPanel();
        if (el) el.classList.remove('hidden');
        return true;
    }

    // ---- Chain button ------------------------------------------------------------------------

    // Statuses after which no more rows will arrive, so the rows on Completed are final.
    const ENDED = ['completed', 'stopped', 'error', 'cancelled'];
    const CHAIN_TITLE = 'Send these rows to another API as its Run Batch input';

    /**
     * Chain is always on the Completed tab. While the run is still running, queued or
     * paused it is disabled, and its tooltip says why (Can't chain "Paused").
     */
    function refreshChainButton() {
        const btn = document.getElementById('chain-btn');
        if (!btn) return;
        btn.classList.toggle('hidden', state.currentTab !== 'success');
        const ended = ENDED.includes(String(state.status).toLowerCase());
        btn.disabled = !ended;
        btn.title = ended ? CHAIN_TITLE : `Can't chain "${statusText(state.status) || 'Pending'}"`;
        // #298: Compare sits beside Chain and shows with it
        if (window.ConsoleCompare) window.ConsoleCompare.refresh(state.currentTab, state.status);
    }

    function onStatus(status) {
        if (status) state.status = String(status).toLowerCase();
        refreshChainButton();
    }

    function startChain() {
        const mgr = window.dynamicReportManager;
        if (!mgr) return;
        const tab = 'success';
        const visible = mgr.getVisibleColumns ? mgr.getVisibleColumns(tab) : {};
        const visibleColumnIds = Object.keys(visible || {}).filter(id => visible[id] === true);
        const view = mgr.getActiveView ? mgr.getActiveView(tab) : null;
        const search = document.getElementById('search-input');
        post('console.chain', {
            tab,
            visibleColumnIds: visibleColumnIds.length > 0 ? visibleColumnIds : null,
            currentPath: (mgr.getCurrentPath && mgr.getCurrentPath(tab)) || 'root',
            searchTerm: search ? search.value.trim() || undefined : undefined,
            view: view ? JSON.parse(JSON.stringify(view)) : null
        });
    }

    // ---- Chain dialog ------------------------------------------------------------------------

    /**
     * Review 2026-10-04: the template's variables only — mapped ones with their CSV column,
     * then unmapped ones with a blank CSV side. CSV columns no variable takes are not shown, nor
     * A8/ENV variables (they fill themselves). Badges are one word; the tooltip says the rest.
     */
    const BADGE = {
        guess: '<span class="status-indicator status-warning" title="Matched on part of the name. Check it on Run Batch Step 2.">guess</span>',
        missing: '<span class="status-indicator status-warning" title="No column fills it. You map it on Run Batch Step 2.">⚠ missing</span>',
        empty: '<span class="status-indicator status-pending" title="Optional, and no column fills it: it is left out of the request.">empty</span>'
    };

    function previewRows(candidate, firstRow) {
        const variableCell = v => {
            const name = `${esc(v.name)}${v.optional ? ' <small>(optional)</small>' : ''}`;
            if (v.column && v.how === 'partial') return `${name} ${BADGE.guess}`;
            if (v.column) return name;
            return `${name} ${v.optional ? BADGE.empty : BADGE.missing}`;
        };
        const mapped = candidate.variables.filter(v => v.column);
        const unmapped = candidate.variables.filter(v => !v.column);
        return mapped.map(v => `<tr><td>${esc(v.column)}</td><td>${variableCell(v)}</td><td>${esc(firstRow[v.column] ?? '')}</td></tr>`)
            .concat(unmapped.map(v => `<tr><td></td><td>${variableCell(v)}</td><td></td></tr>`))
            .join('');
    }

    /** "5 of 5 mapped", "3 of 6 mapped · 1 guess · 2 missing" */
    function previewSummary(c) {
        const mapped = c.variables.filter(v => v.column).length;
        const guesses = c.variables.filter(v => v.column && v.how === 'partial').length;
        const missing = c.variables.filter(v => !v.column && !v.optional).length;
        const parts = [`${mapped} of ${c.variables.length} variable${c.variables.length === 1 ? '' : 's'} mapped`];
        if (guesses) parts.push(`${guesses} guess${guesses === 1 ? '' : 'es'}`);
        if (missing) parts.push(`${missing} missing`);
        return parts.join(' · ');
    }

    const SEARCH_ICON = '<svg class="search-icon-inset" width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>';
    const MAX_RESULTS = 50;

    function showDialog(options) {
        if (!window.DbmnModal) return;
        const byId = new Map(options.candidates.map(c => [c.endpointId, c]));
        let selected = options.suggestedIds[0] || null;

        const body = document.createElement('div');
        body.className = 'chain-dialog';
        const rows = `${Number(options.rowCount).toLocaleString()} row${options.rowCount === 1 ? '' : 's'}`;
        const where = [
            options.viewName ? `view <strong>${esc(options.viewName)}</strong>` : '',
            options.searchTerm ? `search <code>${esc(options.searchTerm)}</code>` : ''
        ].filter(Boolean).join(', ');
        body.innerHTML = `
            <p class="chain-intro"><strong>${rows}</strong>${where ? ` from ${where}` : ''}.</p>
            ${options.warnings.map(w => `<p><span class="status-indicator status-warning">⚠ ${esc(w)}</span></p>`).join('')}
            <div class="dbmn-modal-field">
                <label for="chain-search">Send them to endpoint:</label>
                <div class="search-input-wrapper chain-search">${SEARCH_ICON}
                    <input id="chain-search" class="dbmn-modal-input" type="text" placeholder="Search by name or path" autocomplete="off">
                </div>
            </div>
            <div class="dbmn-modal-field">
                <label id="chain-list-label"></label>
                <div role="radiogroup" class="chain-target-list" id="chain-target-list"></div>
            </div>
            <div class="dbmn-modal-field chain-preview">
                <label id="chain-preview-label"></label>
                <div class="chain-preview-scroll" id="chain-preview"></div>
            </div>`;

        const search = body.querySelector('#chain-search');
        const list = body.querySelector('#chain-target-list');
        const listLabel = body.querySelector('#chain-list-label');
        const previewLabel = body.querySelector('#chain-preview-label');
        const preview = body.querySelector('#chain-preview');

        /** Chain is only possible when the selected endpoint has something for the rows to fill. */
        function chainable(c) {
            return !!c && c.variableCount > 0;
        }

        function syncChainButton() {
            const btn = document.querySelector('.dbmn-modal [data-action-id="chain"]');
            if (btn) btn.disabled = !chainable(selected && byId.get(selected));
        }

        // The list and the preview have fixed heights and scroll inside themselves, so changing
        // endpoint (or searching) never resizes the dialog.
        function renderPreview() {
            const c = selected && byId.get(selected);
            list.querySelectorAll('label').forEach(l => {
                const input = l.querySelector('input');
                l.classList.toggle('is-selected', !!input && input.value === selected);
            });
            if (!c) {
                previewLabel.textContent = 'Mapping preview';
                preview.innerHTML = '<p class="chain-empty">Pick an endpoint to see how the rows map.</p>';
            } else if (!chainable(c)) {
                previewLabel.textContent = `Mapping preview: ${c.method} ${c.name}`;
                preview.innerHTML = '<p class="chain-empty"><span class="status-indicator status-warning">⚠ Nothing to map. This endpoint has no variables in its URL, query parameters, headers or body.</span></p>';
            } else {
                previewLabel.textContent = `Mapping preview: ${c.method} ${c.name} · ${previewSummary(c)}`;
                preview.innerHTML = `
                    <table class="csv-table chain-preview-table"><thead><tr><th>CSV column</th><th>Template variable</th><th>First row</th></tr></thead>
                    <tbody>${previewRows(c, options.firstRow)}</tbody></table>`;
            }
            preview.scrollTop = 0;
            syncChainButton();
        }

        function describe(c) {
            const parts = [c.path];
            if (c.variableCount > 0) parts.push(`${c.matched.length} of ${c.variableCount} variable${c.variableCount === 1 ? '' : 's'}`);
            else parts.push('no variables');
            if (c.missingRequired.length > 0) parts.push(`${c.missingRequired.length} missing`);
            if (c.sameResource) parts.push('same resource');
            return parts.join(' · ');
        }

        function renderList() {
            const q = search.value.trim().toLowerCase();
            let items;
            if (q) {
                const terms = q.split(/\s+/);
                const hits = options.candidates.filter(c => {
                    const hay = `${c.method} ${c.name} ${c.path}`.toLowerCase();
                    return terms.every(t => hay.includes(t));
                });
                items = hits.slice(0, MAX_RESULTS);
                const shown = search.value.trim();
                listLabel.textContent = hits.length === 0 ? `No endpoint matches “${shown}”`
                    : hits.length > MAX_RESULTS ? `${hits.length} endpoints match “${shown}”: the best ${MAX_RESULTS} are listed, so narrow the search`
                    : `${hits.length} endpoint${hits.length === 1 ? '' : 's'} match${hits.length === 1 ? 'es' : ''} “${shown}”`;
            } else {
                items = options.suggestedIds.map(id => byId.get(id)).filter(Boolean);
                listLabel.textContent = items.length
                    ? 'Suggested: every required variable has a column'
                    : 'No endpoint takes every column. Search for the one you want.';
            }
            if (!items.some(c => c.endpointId === selected)) selected = items.length ? items[0].endpointId : null;
            list.innerHTML = items.map(c => `
                <label><input type="radio" name="chain-target" value="${esc(c.endpointId)}" ${c.endpointId === selected ? 'checked' : ''}>
                <span>${esc(c.method)} ${esc(c.name)}</span><small>${esc(describe(c))}</small></label>`).join('');
            list.scrollTop = 0;
            renderPreview();
        }

        search.addEventListener('input', renderList);
        list.addEventListener('change', (event) => {
            if (event.target && event.target.name === 'chain-target') {
                selected = event.target.value;
                renderPreview();
            }
        });
        renderList();

        window.DbmnModal.show({
            title: options.sourceEndpoint ? `Chain from ${options.sourceEndpoint}` : 'Chain',
            body,
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'chain', label: 'Chain', variant: 'primary' }
            ],
            size: 'lg'
        }).then(result => {
            if (result && result.actionId === 'chain' && chainable(selected && byId.get(selected))) {
                post('console.chainConfirm', { token: options.token, endpointId: selected });
            }
        });
        setTimeout(() => { syncChainButton(); search.focus(); }, 0);
    }

    // ---- messages ----------------------------------------------------------------------------

    // Attached after the page's own script (DOMContentLoaded): in a Hub tab, the shim hands its
    // queue of early messages to the FIRST "message" listener — that must be the Console's.
    function onMessage(event) {
        const message = event.data || {};
        if (message.type === 'console.links') {
            const p = message.payload || {};
            state.links = { upstream: p.upstream || [], downstream: p.downstream || [] };
            if (p.status) state.status = String(p.status).toLowerCase();
            syncTab();
            if (state.currentTab === 'links') renderPanel();
            refreshChainButton();
        } else if (message.type === 'console.chainOptions') {
            showDialog(message.payload);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.addEventListener('message', onMessage); });
    } else {
        window.addEventListener('message', onMessage);
    }

    // Back in this Console after chaining elsewhere: links may have changed.
    window.addEventListener('focus', function () { if (state.requested) requestLinks(); });

    document.addEventListener('DOMContentLoaded', function () {
        const btn = document.getElementById('chain-btn');
        if (btn) btn.addEventListener('click', startChain);
    });

    window.ConsoleChain = { decorateTabs, onSwitchTab, onStatus, refresh: refreshChainButton };
})();
