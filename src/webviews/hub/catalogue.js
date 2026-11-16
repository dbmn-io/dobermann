// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
(function () {
    'use strict';

    const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const ORPHAN_SYSTEM_KEY = '__unknown__';
    // Mirror of catalogue.service.ts — user-facing label for endpoints with no
    // System. Distinct from any real System name so unassigned endpoints don't
    // render as a twin of an actual System.
    const ORPHAN_SYSTEM_LABEL = 'Unassigned';
    const SEARCH_DEBOUNCE_MS = 150;

    /** @type {{ postMessage: (msg:any) => void, getState: () => any } | null} */
    let host = null;

    /**
     * Current view spec — driven by UI controls. The System scope is `@` in the query (#444);
     * effectiveSystemIds() resolves it against the active environment on every render, so the
     * catalogue tracks environment changes.
     */
    let view = {
        groupBy: 'url',
        showRecent: true,        // Settings → Endpoints → Recent
        recentCollapsed: false,  // header chevron state, remembered in webview state
        // #444: the search box's query, as typed (`system:current method:post bulk`). It is the
        // only filter state: `filters` is worked out from it on every render (deriveFilters).
        query: '',
        filters: { methods: [], search: '', tags: [], systems: [] }
    };

    /** #444: the search box (shared/search-words.js). */
    let chipBox = null;
    /** #444: the typed words, parsed once per render, for the rows' highlights. */
    let searchWords = { include: [], exclude: [] };

    /** How many endpoints the Recent section shows. */
    const RECENT_LIMIT = 5;

    let searchDebounceTimer = null;
    /** The endpoint currently *highlighted* in the list. Updated optimistically
     *  on click so the user gets instant visual feedback. */
    let selectedEndpointId = null;
    /** The endpoint that's actually *committed* — i.e. open in column 2 right
     *  now. Updated only after the host confirms the swap succeeded. If a
     *  swap is cancelled (Cancel in the unsaved-changes prompt), we revert
     *  `selectedEndpointId` back to this so the row highlight matches the
     *  pane that's actually open. */
    let committedEndpointId = null;

    // ── Bulk-select state (Issue #275) ──────────────────────────────────
    // Modal, off by default. The "Select" toggle in the add-row reveals the
    // per-row + per-group checkboxes (CSS-gated by `.is-select-mode` on the
    // section); "Set System…" in the footer applies to the selection.
    const selectedBulkIds = new Set();
    let selectMode = false;
    /** True when Group by was restored from webview state (see update()). */
    let groupByPersisted = false;
    let firstStateSeen = false;

    function init(hostApi) {
        host = hostApi;
        wireControls();
        // Pull persisted settings (Show + Group by live in the Settings
        // section now; the catalogue is a passive consumer of them).
        const initial = (host.getInitialSettings && host.getInitialSettings()) || {};
        if (initial.groupBy) { view.groupBy = initial.groupBy; groupByPersisted = true; }
        if (typeof initial.showRecent === 'boolean') view.showRecent = initial.showRecent;
        if (typeof initial.recentCollapsed === 'boolean') view.recentCollapsed = initial.recentCollapsed;
        syncSettingsControlsToView();
    }

    function update(state) {
        // The first state: Group by defaults to System unless one was kept (Issue: group-by
        // reverting to System on every reload)
        if (!firstStateSeen) {
            firstStateSeen = true;
            if (!groupByPersisted) view.groupBy = 'system';
            syncSettingsControlsToView();
        }
        // Disable run controls when signed out of DBMN — execution requires
        // a signed-in identity for telemetry attribution. CSS dims them in
        // place (kept in layout so the method badge and name don't reflow);
        // `triggerRun` also short-circuits when the body has the class.
        // Browse/edit stay available.
        document.body.classList.toggle('signed-out', state.isSignedIn === false);
        render(state);
    }

    /** Called by hub.js when the user changes a setting in the Settings panel. */
    function applySettings(settings) {
        if (settings.groupBy) view.groupBy = settings.groupBy;
        if (typeof settings.showRecent === 'boolean') view.showRecent = settings.showRecent;
        render(host.getState());
    }

    function acknowledgeSystemCreated() { /* no-op; the catalogue no longer creates Systems */ }

    function wireControls() {
        // Show + Group by live in the Settings section now (hub.js owns
        // their change listeners and calls applySettings()).

        const search = document.getElementById('catalogueSearch');
        if (search && window.SearchWords) {
            chipBox = window.SearchWords.attach({
                input: search,
                candidates: queryCandidates,
                onText: (text) => {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => {
                        view.query = text;
                        render(host.getState());
                    }, SEARCH_DEBOUNCE_MS);
                }
            });
        }

        // Empty-state prompt shown before the catalogue has any endpoints: the same two ways in
        // as the Add row (rendered inside the list once there is one, see render()), so a first
        // endpoint can come from the clipboard too (Puppy School Lesson 1 starts that way).
        const addBtn = document.getElementById('catalogueAddEndpoint');
        addBtn?.addEventListener('click', () => {
            host.postMessage({ type: 'addEndpoint' });
        });
        document.getElementById('catalogueAddFromClipboard')?.addEventListener('click', () => {
            host.postMessage({ type: 'addEndpoint', fromClipboard: true });
        });

        // Bulk-select (Issue #275). The Select toggle is rebuilt inside the
        // list on every render, so we delegate its `change` on the stable
        // list container rather than re-binding each time. The footer button
        // is static, so it's bound directly.
        document.getElementById('catalogueList')?.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t && t.id === 'catalogueSelectMode') onSelectModeChange(ev);
        });
        document.getElementById('catalogueBulkUpdate')?.addEventListener('click', openBulkUpdateModal);
        document.getElementById('catalogueBulkExport')?.addEventListener('click', onBulkExportClick);
        document.getElementById('catalogueBulkDelete')?.addEventListener('click', onBulkDeleteClick);

        // #444: the query builder: it writes the search box's query
        document.getElementById('catalogueFilterBtn')?.addEventListener('click', openFiltersModal);
    }

    /** The System ids `@` / `@name` in the query narrow to (undefined: every System). */
    function effectiveSystemIds(state) {
        // #444: the query is the whole search: `@` / `@name` in the box, nothing hidden.
        // (Settings → Show: Current System starts the box with `@`; see update().)
        if ((view.filters.systems || []).length === 0) return undefined;
        return view.filters.systems.map(id => id !== CURRENT_SYSTEM ? id
            : (state.activeEnvironmentId ? (state.activeSystemId || ORPHAN_SYSTEM_KEY) : '__no-active-env__'));
    }


    function syncSettingsControlsToView() {
        const groupBy = document.getElementById('catalogueGroupBy');
        if (groupBy) groupBy.value = view.groupBy;
        const search = document.getElementById('catalogueSearch');
        if (search) search.value = view.query || '';
        // Method chips
        document.querySelectorAll('.catalogue-chip[data-method]').forEach(chip => {
            const active = (view.filters.methods || []).indexOf(chip.dataset.method) !== -1;
            chip.classList.toggle('is-active', active);
        });
    }

    function render(state) {
        deriveFilters(state);
        searchWords = window.SearchWords ? window.SearchWords.parseWords(view.filters.search || '') : searchWords;
        // Derive systemIds from the user's mode + the current activeSystemId.
        // Rebuilt every render so env switches Just Work.
        const systemIds = effectiveSystemIds(state);
        const filterInput = Object.assign({}, view.filters, { systemIds });

        const filtered = filterEndpoints(state.endpoints, filterInput);
        // #444: while searching, an endpoint Recent shows isn't repeated in its group below
        // (James, 2026-11-12: "I'm getting it twice"); with nothing typed Recent is a shortcut, both stay
        const searching = !!(view.query || '').trim();
        const inRecent = searching && view.showRecent ? new Set(recentEndpoints(state, filtered).map(e => e.id)) : null;
        const tree = inRecent ? filtered.filter(e => !inRecent.has(e.id)) : filtered;
        const grouped = groupEndpoints(tree, state.systems, { groupBy: view.groupBy, filters: filterInput });

        // Prune bulk selection to what's visible (Issue #275) — a filter change
        // or deletion drops now-hidden ids so the footer count and group
        // tri-states can't drift.
        if (selectedBulkIds.size) {
            const visible = new Set(filtered.map(e => e.id));
            Array.from(selectedBulkIds).forEach(id => { if (!visible.has(id)) selectedBulkIds.delete(id); });
        }

        // Scope count = endpoints in the current System scope, ignoring
        // method/search filters.
        const scopeEndpoints = filterEndpoints(state.endpoints, { systemIds });


        const list = document.getElementById('catalogueList');
        const empty = document.getElementById('catalogueEmpty');
        if (!list || !empty) return;

        if (state.endpoints.length === 0) {
            list.hidden = true;
            empty.hidden = false;
            return;
        }

        list.hidden = false;
        empty.hidden = true;
        list.innerHTML = '';

        // Compact action row: icon-only Select toggle on the left, and a
        // grouped "+ Add Endpoint" affordance in the middle where the
        // clipboard variant is glued directly to the primary — same button
        // family, so they read as one unit. The row's click handler only
        // fires on `[data-add-action]` elements, so the Select toggle sits
        // here without hijacking clicks.
        const addRow = document.createElement('div');
        addRow.className = 'hub-list-row hub-list-row-add hub-add-split';
        addRow.innerHTML =
            '<label class="hub-toggle tx-select-switch hub-add-split-select" title="Select endpoints for bulk actions" aria-label="Select endpoints for bulk actions">' +
                '<input type="checkbox" id="catalogueSelectMode">' +
                '<span class="hub-toggle-track"><span class="hub-toggle-thumb"></span></span>' +
            '</label>' +
            '<div class="hub-add-split-group">' +
                '<button type="button" class="hub-add-split-primary" data-add-action="new">' +
                    '<span class="icon" data-icon="plus"></span>' +
                    '<span>Add Endpoint</span>' +
                '</button>' +
                '<button type="button" class="hub-add-split-alt" data-add-action="newFromClipboard" ' +
                    'title="New Endpoint from Clipboard" ' +
                    'aria-label="New Endpoint from Clipboard">' +
                    '<span class="icon" data-icon="clipboard"></span>' +
                '</button>' +
            '</div>' +
            // #444: "7 of 10" here, so the search box has the header's whole width
            '<span class="catalogue-summary catalogue-add-summary" id="catalogueSummary" hidden></span>';
        addRow.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-add-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-add-action');
            host.postMessage({
                type: 'addEndpoint',
                fromClipboard: action === 'newFromClipboard'
            });
        });
        list.appendChild(addRow);
        renderSummary(filtered.length, scopeEndpoints.length, scopeLabel(state, systemIds));

        // Sync select-mode class + footer + the (freshly rebuilt) toggle's
        // checked state. Placed here so it runs on every path below, including
        // the early returns. (Issue #275)
        renderBulkBar();

        if (filtered.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'catalogue-noresults';
            // #444: narrowed to a System by the Settings scope or by `system:` in the query
            const toSystem = !!(systemIds && systemIds.length);
            noResults.textContent =
                toSystem && !state.activeEnvironmentId && systemIds.indexOf('__no-active-env__') !== -1
                    ? 'No active environment — pick one to see endpoints here.'
                    : 'No endpoints match the current filters.';
            list.appendChild(noResults);

            // Discoverability safety net: when the System scope is on and hides
            // everything, but the SAME search/method/tag filters DO match
            // endpoints in other Systems, offer a one-click way out instead of
            // a silent dead-end. (Root cause of the original report: an endpoint
            // left in another/no System is invisible under the SYS filter.)
            if (toSystem) {
                const acrossSystems = filterEndpoints(
                    state.endpoints,
                    Object.assign({}, view.filters, { systemIds: undefined })
                );
                if (acrossSystems.length > 0) {
                    const hint = document.createElement('button');
                    hint.type = 'button';
                    hint.className = 'catalogue-crossscope-hint';
                    const noun = acrossSystems.length === 1 ? 'endpoint' : 'endpoints';
                    hint.textContent =
                        acrossSystems.length + ' matching ' + noun +
                        ' in other Systems — Show all Systems';
                    // `@` out of the query
                    hint.addEventListener('click', () => setQuery(queryFor(Object.assign({}, view.filters, { systems: [] }))));
                    list.appendChild(hint);
                }
            }

            if (window.Icons) window.Icons.injectIcons(list);
            return;
        }

        // Recent: the five endpoints last saved / run, pinned above
        // the tree. Hidden while a search or method/tag filter is active —
        // the user is looking for something specific, and Recent would just
        // be noise. The System scope doesn't hide it: Recent is already
        // scoped to the current System (scopeEndpoints).
        const recentBlock = renderRecent(state, filtered);
        if (recentBlock) list.appendChild(recentBlock);

        if (view.groupBy === 'none') {
            // Flat mode: skip the group header entirely, just render rows.
            // No group prefix → the full path is shown.
            grouped.forEach(group => {
                group.endpoints.forEach(endpoint => list.appendChild(renderEndpointRow(endpoint, '')));
            });
            if (window.Icons) window.Icons.injectIcons(list);
            return;
        }

        grouped.forEach(group => list.appendChild(renderGroup(group, 0, '')));
        // Hydrate the chevron SVGs (and any other [data-icon] placeholders
        // that landed in the newly-built tree).
        if (window.Icons) window.Icons.injectIcons(list);
        syncGroupCheckboxes();
    }

    /**
     * Merge two recency signals into one ranked list:
     *   - `state.recentEndpoints` — save touches recorded by the
     *     extension in globalState (newest first, {id, touchedAt}).
     *   - `state.transactions` — run history, which also covers runs from
     *     before the MRU list existed.
     * Only endpoints in the current System scope qualify. Returns up to
     * RECENT_LIMIT endpoints, most recent first.
     */
    function recentEndpoints(state, scopeEndpoints) {
        const byId = new Map(scopeEndpoints.map(e => [e.id, e]));
        const lastTouch = new Map();
        (state.recentEndpoints || []).forEach(r => {
            if (!r || !byId.has(r.id)) return;
            const t = Number(r.touchedAt) || 0;
            if (t > (lastTouch.get(r.id) || 0)) lastTouch.set(r.id, t);
        });
        (state.transactions || []).forEach(t => {
            if (!t || !t.endpointId || !byId.has(t.endpointId)) return;
            const when = Date.parse(t.completedAt || t.startedAt || t.createdAt || '') || 0;
            if (when > (lastTouch.get(t.endpointId) || 0)) lastTouch.set(t.endpointId, when);
        });
        return Array.from(lastTouch.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, RECENT_LIMIT)
            .map(([id]) => byId.get(id));
    }

    /** #444: Recent stays while searching: the most recent of the endpoints that match. */
    function renderRecent(state, matching) {
        if (!view.showRecent) return null;
        const recent = recentEndpoints(state, matching);
        if (recent.length === 0) return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'catalogue-group catalogue-recent depth-0';
        wrapper.style.setProperty('--depth', 0);
        if (view.recentCollapsed) wrapper.classList.add('is-collapsed');

        const header = document.createElement('div');
        header.className = 'catalogue-group-header';
        header.innerHTML = '<span class="catalogue-group-chevron icon" data-icon="chevron-down"></span>' +
            '<span class="catalogue-recent-icon icon" data-icon="history"></span>' +
            '<span class="catalogue-group-label">Recent</span>';
        header.addEventListener('click', () => {
            view.recentCollapsed = wrapper.classList.toggle('is-collapsed');
            try {
                const prev = (window.vscode?.getState && window.vscode.getState()) || {};
                window.vscode?.setState?.(Object.assign({}, prev, { catalogueRecentCollapsed: view.recentCollapsed }));
            } catch { /* ignore */ }
        });
        wrapper.appendChild(header);

        const body = document.createElement('div');
        body.className = 'catalogue-group-body';
        const bodyInner = document.createElement('div');
        bodyInner.className = 'catalogue-group-body-inner';
        body.appendChild(bodyInner);
        wrapper.appendChild(body);
        // Full path shown (no group prefix to strip) — these rows come from
        // anywhere in the tree.
        recent.forEach(endpoint => bodyInner.appendChild(renderEndpointRow(endpoint, '')));
        return wrapper;
    }

    function renderSummary(visibleCount, scopeCount, _label) {
        const el = document.getElementById('catalogueSummary');
        if (!el) return;
        // Only show a count when it's informative — i.e. when a filter or
        // search is actually hiding something. Unfiltered = the count is
        // just visual noise, and each group already shows its own count.
        const filtersOn = !!(view.query || '').trim();
        if (!filtersOn || scopeCount === 0 || visibleCount === scopeCount) {
            el.textContent = '';
            el.hidden = true;
            return;
        }
        el.hidden = false;
        el.textContent = visibleCount + ' of ' + scopeCount;
    }

    function scopeLabel(state, systemIds) {
        const sid = (systemIds || [])[0];
        if (!sid) return '';
        if (sid === ORPHAN_SYSTEM_KEY) return ORPHAN_SYSTEM_LABEL;
        const system = (state.systems || []).find(s => s.id === sid);
        return system ? system.name : '';
    }

    function updateTagsPill(state, systemIds) {
        const pill = document.getElementById('catalogueTagsPill');
        if (!pill) return;
        const selectedCount = (view.filters.tags || []).length;
        const countEl = pill.querySelector('[data-count]');
        if (countEl) countEl.textContent = selectedCount > 0 ? String(selectedCount) : '';
        pill.classList.toggle('is-active', selectedCount > 0);

        // Hide the pill if no endpoints in scope have any tags.
        const otherFilters = Object.assign({}, view.filters, { systemIds, tags: [] });
        const counts = aggregateTagCounts(state.endpoints, otherFilters);
        const anyTags = counts.size > 0 || selectedCount > 0;
        pill.classList.toggle('is-empty', !anyTags);
    }

    function updateMethodCounts(allEndpoints, filters) {
        // Method chip counts reflect how many endpoints WOULD remain if the
        // user toggled just this method, given the current System + search
        // filters (i.e. ignore the methods filter when counting).
        const filtersExceptMethods = {
            systemIds: filters.systemIds,
            search: filters.search,
            methods: []
        };
        const candidates = filterEndpoints(allEndpoints, filtersExceptMethods);
        const counts = {};
        ALL_METHODS.forEach(m => { counts[m] = 0; });
        candidates.forEach(e => {
            if (counts[e.method] !== undefined) counts[e.method]++;
        });
        ALL_METHODS.forEach(method => {
            const chip = document.querySelector('.catalogue-chip[data-method="' + method + '"]');
            if (!chip) return;
            const count = counts[method] || 0;
            chip.querySelector('[data-count]').textContent = count;
            chip.classList.toggle('is-empty', count === 0);
        });
    }

    function renderGroup(group, depth, urlPrefix) {
        const wrapper = document.createElement('div');
        wrapper.className = 'catalogue-group depth-' + depth;
        wrapper.style.setProperty('--depth', depth);

        // GitHub Issue #274: under URL grouping, accumulate the URL segments as
        // the hierarchy descends so endpoint rows can strip the redundant
        // prefix — the group headers already show it. Other groupings (system,
        // method) leave prefix empty, so endpoint rows fall back to full path.
        // The `(root)` group synthesised in groupByUrl has no URL to add.
        const childUrlPrefix = (view.groupBy === 'url' && group.label && group.label !== '(root)')
            ? urlPrefix + '/' + group.label.replace(/^\/+/, '')
            : urlPrefix;

        const header = document.createElement('div');
        header.className = 'catalogue-group-header';
        header.innerHTML = '<span class="catalogue-group-chevron icon" data-icon="chevron-down"></span>' +
            '<span class="catalogue-group-label">' + escapeHtml(group.label) + '</span>';

        // Group-level bulk checkbox (Issue #275) — toggles every endpoint in
        // the group, including nested sub-groups. Prepended as the first header
        // child; CSS gates its visibility to select mode.
        const groupIds = collectGroupEndpointIds(group);
        const selectedInGroup = groupIds.filter(id => selectedBulkIds.has(id)).length;
        const gcb = document.createElement('input');
        gcb.type = 'checkbox';
        gcb.className = 'catalogue-group-select';
        gcb.dataset.groupIds = groupIds.join('|');
        gcb.checked = groupIds.length > 0 && selectedInGroup === groupIds.length;
        gcb.indeterminate = selectedInGroup > 0 && selectedInGroup < groupIds.length;
        gcb.addEventListener('click', (e) => e.stopPropagation());
        gcb.addEventListener('change', () => toggleGroupSelection(groupIds, gcb.checked));
        header.insertBefore(gcb, header.firstChild);
        wrapper.appendChild(header);

        const body = document.createElement('div');
        body.className = 'catalogue-group-body';
        // Inner wrapper is what the grid-template-rows transition collapses
        // against — gives a symmetric animation in both directions instead
        // of the max-height-capped snap on expand.
        const bodyInner = document.createElement('div');
        bodyInner.className = 'catalogue-group-body-inner';
        body.appendChild(bodyInner);
        wrapper.appendChild(body);

        group.endpoints.forEach(endpoint => bodyInner.appendChild(renderEndpointRow(endpoint, childUrlPrefix)));
        group.children.forEach(child => bodyInner.appendChild(renderGroup(child, depth + 1, childUrlPrefix)));

        header.addEventListener('click', (e) => {
            // Ignore clicks on the group checkbox (it stops propagation, but
            // defend in depth) so selecting a group doesn't also collapse it.
            if (e.target && e.target.closest && e.target.closest('input')) return;
            wrapper.classList.toggle('is-collapsed');
        });

        return wrapper;
    }

    /** Collect every endpoint id under a group, recursing into sub-groups. */
    function collectGroupEndpointIds(group) {
        const ids = (group.endpoints || []).map(e => e.id);
        (group.children || []).forEach(child => {
            ids.push.apply(ids, collectGroupEndpointIds(child));
        });
        return ids;
    }

    function renderEndpointRow(endpoint, urlPrefix) {
        // Row is a <div role="button"> (not a <button>) so it can nest the
        // bulk-select checkbox — a form control inside a <button> is invalid
        // HTML. Keyboard handling is wired explicitly below (Issue #275).
        const row = document.createElement('div');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.className = 'catalogue-row method-' + (endpoint.method || 'GET');
        if (endpoint.id === selectedEndpointId) row.classList.add('is-selected');
        if (selectedBulkIds.has(endpoint.id)) row.classList.add('is-bulk-selected');
        row.dataset.endpointId = endpoint.id;

        // Bulk-select checkbox (Issue #275) — modal, CSS-gated by select mode.
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'catalogue-row-select';
        cb.tabIndex = -1;
        cb.checked = selectedBulkIds.has(endpoint.id);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => applyRowSelection(endpoint.id, row, cb, cb.checked));
        row.appendChild(cb);
        // Endpoints with template variables get TWO run buttons:
        //   play           → Run API (fill in values via the DBMN modal)
        //   folder-tree-play → Run Batch (drive from a CSV)
        // Endpoints without variables get a single play button (Run API).
        // Previously the row forced the batch path when vars existed, so the
        // single-shot modal was unreachable from the catalogue.
        const hasVars = endpointHasUserVariables(endpoint);
        // #418: a DBMN sign-in is not needed to run anything
        const runApiTitle = 'Run API';
        const runBatchTitle = 'Run Batch';
        const runButtons =
            '<span class="catalogue-row-runs">' +
                '<span class="catalogue-row-run-btn catalogue-row-run-api icon" data-icon="play" role="button" tabindex="0" title="' + runApiTitle + '"></span>' +
                (hasVars
                    ? '<span class="catalogue-row-run-btn catalogue-row-run-batch icon" data-icon="folder-tree-play" role="button" tabindex="0" title="' + runBatchTitle + '"></span>'
                    : '') +
            '</span>';
        // GitHub Issue #274: strip the group's URL prefix from the shown path —
        // the hierarchy already displays it, so repeating it just crowds out
        // the endpoint name (which is the more meaningful label). Any query
        // string (`?messageType=…`) is split off into its own inner span so it
        // can be styled as lower-priority and shrunk/hidden first when space
        // is tight. Under non-URL grouping urlPrefix is '' so nothing is
        // stripped — the full path shows as before.
        const fullPath = endpoint.path || '';
        let remainingPath = fullPath;
        if (urlPrefix && fullPath.indexOf(urlPrefix) === 0) {
            remainingPath = fullPath.slice(urlPrefix.length);
        }
        const qIdx = remainingPath.indexOf('?');
        const pathLeaf = qIdx >= 0 ? remainingPath.slice(0, qIdx) : remainingPath;
        const pathQuery = qIdx >= 0 ? remainingPath.slice(qIdx) : '';
        // Tooltip shows the full path (prefix included) since the row clips it.
        const pathHtml = '<span class="catalogue-row-path" title="' + escapeHtml(fullPath) + '">' +
            (pathLeaf ? '<span class="catalogue-row-path-leaf">' + marked(pathLeaf) + '</span>' : '') +
            (pathQuery ? '<span class="catalogue-row-path-query">' + escapeHtml(pathQuery) + '</span>' : '') +
            '</span>';

        // insertAdjacentHTML (not innerHTML) so the prepended checkbox survives.
        row.insertAdjacentHTML('beforeend',
            runButtons +
            '<span class="catalogue-method-badge">' + escapeHtml(endpoint.method || '') + '</span>' +
            '<span class="catalogue-row-name" title="' + escapeHtml(endpoint.name || '') + '">' + (endpoint.name ? marked(endpoint.name) : '(unnamed)') + '</span>' +
            pathHtml);
        if (window.Icons) window.Icons.injectIcons(row);

        const openEndpoint = (preview) => {
            markSelected(endpoint.id);
            host.postMessage({ type: 'openEndpointAsTab', endpointId: endpoint.id, preview });
        };

        // Click rule depends on select mode (Issue #275):
        //   off → single click opens a preview tab, double-click a kept tab
        //         (R1-5 preview-vs-kept discipline)
        //   on  → single click toggles selection (via the native checkbox so
        //         the repaint is reliable); double-click is a no-op
        row.addEventListener('click', () => {
            if (selectMode) { cb.click(); return; }
            openEndpoint(true);
        });
        row.addEventListener('dblclick', () => {
            if (selectMode) return;
            openEndpoint(false);
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === ' ') {
                e.preventDefault();
                if (selectMode) cb.click(); else openEndpoint(true);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                openEndpoint(false);
            }
        });

        const runApiBtn = row.querySelector('.catalogue-row-run-api');
        const runBatchBtn = row.querySelector('.catalogue-row-run-batch');

        // Stop the row-body click handler from also firing (which would
        // open the editor in column 2 *before* the run lands there), then
        // dispatch to the given handler unless we're signed out. Run buttons
        // are hidden in select mode, but guard anyway.
        const trigger = (handler) => (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (selectMode) return;
            markSelected(endpoint.id);
            handler();
        };
        const runApi = trigger(() => host.postMessage({ type: 'runEndpoint', endpointId: endpoint.id }));
        // Batch endpoints open the prep view as an embedded tab in column 3
        // (one tab per endpoint, multi-instance OK).
        const runBatch = trigger(() => host.postMessage({ type: 'openBatchAsTab', endpointId: endpoint.id }));

        runApiBtn?.addEventListener('click', runApi);
        runApiBtn?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { runApi(e); }
        });
        runBatchBtn?.addEventListener('click', runBatch);
        runBatchBtn?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { runBatch(e); }
        });

        // #444: right-click → the row's actions, and its History (James, 2026-11-12: the row is
        // busy enough without another icon)
        row.addEventListener('contextmenu', (ev) => {
            if (!window.DbmnContextMenu || selectMode) return;
            const items = [
                { id: 'open', label: 'Open', icon: 'pencil' },
                { id: 'run', label: 'Run API', icon: 'play' }
            ];
            if (hasVars) items.push({ id: 'batch', label: 'Run Batch', icon: 'folder-tree-play' });
            items.push({ separator: true }, { id: 'history', label: 'Show history', icon: 'history' });
            items.push({ separator: true }, { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true });
            window.DbmnContextMenu.show(ev, items, (action) => {
                if (action === 'open') openEndpoint(false);
                else if (action === 'run') { markSelected(endpoint.id); host.postMessage({ type: 'runEndpoint', endpointId: endpoint.id }); }
                else if (action === 'batch') { markSelected(endpoint.id); host.postMessage({ type: 'openBatchAsTab', endpointId: endpoint.id }); }
                else if (action === 'history') {
                    window.Transactions?.showEndpointHistory?.(endpoint.id);
                    window.HubLayout?.switchSection?.('transactions');
                } else if (action === 'delete') host.postMessage({ type: 'bulkDeleteEndpoints', ids: [endpoint.id] });
            });
        });
        return row;
    }

    /** Mirrors the `dbmn.run` smart-run detection in extension.ts: an endpoint
     *  has user variables if its body, path, or any *enabled* query-param value
     *  contains `{{…}}` placeholders that aren't auto/system tokens (`A8:`,
     *  `A8.`, `ENV:`, `#`, `/`). When true, Run lands on the batch webview;
     *  otherwise the single-call console. Issue #257: query params were not
     *  considered before, so a batch-worthy endpoint showed up as single-Run. */
    function endpointHasUserVariables(endpoint) {
        const queryParamText = Object.values(endpoint.queryParams || {})
            .map((qp) => {
                if (typeof qp === 'string') return qp;
                if (qp && typeof qp === 'object' && 'value' in qp) {
                    return qp.enabled === false ? '' : qp.value;
                }
                return '';
            })
            .join(' ');
        const allText = (endpoint.body || '') + ' ' + (endpoint.path || '') + ' ' + queryParamText;
        const variablePattern = /\{\{([^}]+)\}\}/g;
        let match;
        while ((match = variablePattern.exec(allText)) !== null) {
            const varText = (match[1] || '').trim();
            if (!varText.startsWith('A8:') && !varText.startsWith('A8.') &&
                !varText.startsWith('ENV:') && !varText.startsWith('#') && !varText.startsWith('/')) {
                return true;
            }
        }
        return false;
    }

    function markSelected(endpointId) {
        selectedEndpointId = endpointId;
        document.querySelectorAll('.catalogue-row.is-selected').forEach(r => r.classList.remove('is-selected'));
        if (endpointId) {
            const target = document.querySelector('.catalogue-row[data-endpoint-id="' + endpointId + '"]');
            target?.classList.add('is-selected');
        }
    }

    // ── Bulk-select (Issue #275) ────────────────────────────────────────

    /** Sync the section's select-mode class, the toggle, and the footer
     *  (count + Set System button enablement). Called every render. */
    function renderBulkBar() {
        const section = document.querySelector('section.hub-section[data-section="catalogue"]');
        if (section) section.classList.toggle('is-select-mode', selectMode);

        const master = document.getElementById('catalogueSelectMode');
        if (master && master.checked !== selectMode) master.checked = selectMode;

        const bar = document.getElementById('catalogueBulkBar');
        const count = document.getElementById('catalogueBulkCount');
        const updateBtn = document.getElementById('catalogueBulkUpdate');
        const exportBtn = document.getElementById('catalogueBulkExport');
        const deleteBtn = document.getElementById('catalogueBulkDelete');
        if (bar) bar.hidden = !selectMode;
        if (count) {
            // "selected" drops out when the list panel is narrow (hub.css container query),
            // leaving the number beside the ticked boxes; the label keeps the whole phrase.
            const n = selectedBulkIds.size;
            count.textContent = String(n);
            const word = document.createElement('span');
            word.className = 'tx-bulk-count-word';
            word.textContent = ' selected';
            count.appendChild(word);
            count.setAttribute('aria-label', n + ' selected');
        }
        const none = selectedBulkIds.size === 0;
        if (updateBtn) updateBtn.disabled = none;
        if (exportBtn) exportBtn.disabled = none;
        if (deleteBtn) deleteBtn.disabled = none;
    }

    /** Plain on/off toggle for select mode. Turning it off clears the
     *  selection so the next entry starts clean. */
    function onSelectModeChange(ev) {
        selectMode = !!(ev.target && ev.target.checked);
        if (!selectMode) selectedBulkIds.clear();
        render(host.getState());
    }

    function toggleGroupSelection(groupIds, checked) {
        groupIds.forEach(id => {
            if (checked) selectedBulkIds.add(id); else selectedBulkIds.delete(id);
        });
        render(host.getState());
    }

    function syncGroupCheckboxes() {
        document.querySelectorAll('.catalogue-group-select').forEach(cb => {
            const ids = (cb.dataset.groupIds || '').split('|').filter(Boolean);
            if (ids.length === 0) { cb.checked = false; cb.indeterminate = false; return; }
            const selected = ids.filter(id => selectedBulkIds.has(id)).length;
            cb.checked = selected === ids.length;
            cb.indeterminate = selected > 0 && selected < ids.length;
        });
    }

    /** One place to keep the checkbox, row class, footer, and group
     *  tri-state in lockstep after a row toggle. */
    function applyRowSelection(id, rowEl, cb, checked) {
        if (checked) selectedBulkIds.add(id); else selectedBulkIds.delete(id);
        if (cb) cb.checked = checked;
        rowEl?.classList.toggle('is-bulk-selected', checked);
        renderBulkBar();
        syncGroupCheckboxes();
    }

    // System choices in the Update modal that aren't System ids.
    const KEEP_SYSTEM_VALUE = 'keep';
    const NEW_SYSTEM_VALUE = '__new__';
    const CLEAR_SYSTEM_VALUE = '';

    /** Comma- or newline-separated tags as typed; the host normalises them. */
    function parseTagInput(text) {
        return String(text || '').split(/[,\n]/).map(t => t.trim()).filter(Boolean);
    }

    /**
     * Select mode → Update: one modal for the selection — System (leave as is, any System,
     * + New System…, No System), Add tags, and Remove tags (only the tags the selection
     * carries, with how many of it carry each). Built from the Filters modal's pieces
     * (section(), .dbmn-filter-radio, .dbmn-filter-tags-list). The selection is kept after
     * applying so the user can watch the endpoints move; the rebroadcast re-renders with the
     * ticks intact.
     */
    function openBulkUpdateModal() {
        if (selectedBulkIds.size === 0) return;
        if (!window.DbmnModal) return;
        const state = host.getState();
        const ids = Array.from(selectedBulkIds);
        const selected = (state.endpoints || []).filter(e => selectedBulkIds.has(e.id));

        const body = document.createElement('div');
        body.className = 'dbmn-filters-modal';

        // ── System ──────────────────────────────────────────────────────
        const systems = (state.systems || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const sysSection = section('System');
        const sysGroup = document.createElement('div');
        sysGroup.className = 'dbmn-filter-radio-group';
        [{ value: KEEP_SYSTEM_VALUE, label: 'Leave as is' }]
            .concat(systems.map(s => ({ value: s.id, label: s.name || '(unnamed)' })))
            .concat([{ value: NEW_SYSTEM_VALUE, label: '+ New System…' }, { value: CLEAR_SYSTEM_VALUE, label: 'No System' }])
            .forEach((opt, i) => {
                const row = document.createElement('label');
                row.className = 'dbmn-filter-radio';
                const r = document.createElement('input');
                r.type = 'radio';
                r.name = 'bulk-update-system';
                r.value = opt.value;
                r.checked = i === 0;
                const lbl = document.createElement('span');
                lbl.textContent = opt.label;
                row.appendChild(r);
                row.appendChild(lbl);
                sysGroup.appendChild(row);
            });
        sysSection.appendChild(sysGroup);
        body.appendChild(sysSection);

        // ── Add tags ────────────────────────────────────────────────────
        const addSection = section('Add tags');
        const addInput = document.createElement('input');
        addInput.type = 'text';
        addInput.className = 'dbmn-modal-input';
        addInput.id = 'bulkUpdateAddTags';
        addInput.placeholder = 'puppy-school, training';
        addInput.autocomplete = 'off';
        const addHint = document.createElement('div');
        addHint.className = 'color-description font-size-12 mt-8';
        addHint.textContent = 'Comma-separated. Existing tags are kept.';
        addSection.appendChild(addInput);
        addSection.appendChild(addHint);
        body.appendChild(addSection);

        // ── Remove tags: only those on the selection ────────────────────
        const removeSection = section('Remove tags');
        const counts = new Map();
        selected.forEach(e => new Set((e.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean))
            .forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
        const removeList = document.createElement('div');
        removeList.className = 'dbmn-filter-tags-list';
        removeList.id = 'bulkUpdateRemoveTags';
        if (counts.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'dbmn-filter-tags-empty';
            empty.textContent = 'The selected endpoints have no tags.';
            removeList.appendChild(empty);
        }
        Array.from(counts.entries())
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .forEach(([tag, count]) => {
                const row = document.createElement('label');
                row.className = 'dbmn-filter-tags-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = tag;
                const label = document.createElement('span');
                label.className = 'dbmn-filter-tags-label';
                label.textContent = tag;
                const countEl = document.createElement('span');
                countEl.className = 'dbmn-filter-tags-count';
                countEl.textContent = String(count);
                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(countEl);
                removeList.appendChild(row);
            });
        removeSection.appendChild(removeList);
        body.appendChild(removeSection);

        window.DbmnModal.show({
            title: 'Update ' + (ids.length === 1 ? '1 endpoint' : ids.length + ' endpoints'),
            body,
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'apply', label: 'Update', variant: 'primary' }
            ],
            dismissible: true,
            size: 'md',
            help: { doc: 'hub', section: 'endpoints' }
        }).then(result => {
            if (!result || result.actionId !== 'apply') return;
            const system = (body.querySelector('input[name="bulk-update-system"]:checked') || {}).value ?? KEEP_SYSTEM_VALUE;
            const addTags = parseTagInput(addInput.value);
            const removeTags = Array.from(removeList.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
            if (system === KEEP_SYSTEM_VALUE && addTags.length === 0 && removeTags.length === 0) return;
            host.postMessage({ type: 'bulkUpdateEndpoints', ids, system, addTags, removeTags });
        });
    }

    /** Filters / Update modal section: a heading over its controls. */
    function section(headingText) {
        const s = document.createElement('section');
        s.className = 'dbmn-filter-section';
        const h = document.createElement('h3');
        h.className = 'dbmn-filter-section-title';
        h.textContent = headingText;
        s.appendChild(h);
        return s;
    }

    /** Export the selected endpoints. The backend asks for a filename via a
     *  DBMN modal and writes the ZIP to the Dobermann exports folder (no OS
     *  save dialog). Selection is kept. */
    function onBulkExportClick() {
        if (selectedBulkIds.size === 0) return;
        host.postMessage({
            type: 'bulkExportEndpoints',
            ids: Array.from(selectedBulkIds)
        });
    }

    /** Delete the selected endpoints. The backend confirms (naming them) and deletes; the
     *  re-render then drops them from the list and the visible-prune drops them from the
     *  selection. Cancelling the confirm keeps the selection. */
    function onBulkDeleteClick() {
        if (selectedBulkIds.size === 0) return;
        host.postMessage({
            type: 'bulkDeleteEndpoints',
            ids: Array.from(selectedBulkIds)
        });
    }

    /**
     * Host-driven swap result. Called by hub.js when the host posts
     * `{ type: 'swapResult', ok, endpointId }` after a click on a row /
     * Run icon. On success → the endpoint is now committed in column 2.
     * On failure (user hit Cancel in the unsaved-changes prompt, or save
     * failed) → revert the optimistic row highlight to whatever was open
     * BEFORE the click.
     */
    function handleSwapResult(message) {
        if (message && message.ok) {
            committedEndpointId = message.endpointId || null;
            // selectedEndpointId already matches — no visual update needed.
        } else {
            markSelected(committedEndpointId);
        }
    }

    // ─── #444: the search box's query ───────────────────────────────────

    /** `@` alone: the active environment's System. */
    const CURRENT_SYSTEM = '__current__';

    /**
     * view.filters from the query (search-words.js: `@ get #tag words`). `!status`, `~env` and
     * dates are History's; here they narrow nothing.
     */
    function deriveFilters(state) {
        const q = window.SearchWords ? window.SearchWords.parseQuery(view.query || '') : { methods: [], tags: [], systems: [], text: view.query || '' };
        const systems = state.systems || [];
        view.filters.methods = q.methods.slice();
        view.filters.tags = q.tags.map(t => t.toLowerCase());
        view.filters.systems = q.systems.map(name => {
            const n = name.toLowerCase();
            if (!n) return CURRENT_SYSTEM;
            if (n === ORPHAN_SYSTEM_LABEL.toLowerCase()) return ORPHAN_SYSTEM_KEY;
            const sys = systems.find(x => String(x.name || '').toLowerCase() === n || x.id === name);
            return sys ? sys.id : '__unknown-system__';
        });
        view.filters.search = q.text;
        return q;
    }

    /** The query for a builder's choices, keeping the words already typed. */
    function queryFor(choice) {
        const systems = host.getState().systems || [];
        return window.SearchWords.buildQuery({
            systems: (choice.systems || []).map(id => id === CURRENT_SYSTEM ? ''
                : id === ORPHAN_SYSTEM_KEY ? ORPHAN_SYSTEM_LABEL
                : ((systems.find(x => x.id === id) || {}).name || id)),
            methods: choice.methods || [],
            tags: choice.tags || [],
            text: view.filters.search || ''
        });
    }

    /** Set the search box's query (the builder, Clear) and show what it finds. */
    function setQuery(query) {
        view.query = query || '';
        if (chipBox) chipBox.setText(view.query);
        render(host.getState());
    }

    /** What the box suggests: methods, `#tags`, `@Systems`, with how many endpoints have each. */
    function queryCandidates() {
        const state = host.getState();
        const endpoints = state.endpoints || [];
        const out = [];
        const methods = new Map();
        const systems = new Map();
        endpoints.forEach(e => {
            const m = String(e.method || '').toUpperCase();
            if (m) methods.set(m, (methods.get(m) || 0) + 1);
            if (e.systemId) systems.set(e.systemId, (systems.get(e.systemId) || 0) + 1);
        });
        methods.forEach((count, m) => out.push({ sign: 'method', value: m, count }));
        aggregateTagCounts(endpoints, {}).forEach((count, tag) => out.push({ sign: '#', value: tag, count }));
        if (state.activeEnvironmentId) {
            const current = (state.systems || []).find(x => x.id === state.activeSystemId);
            out.push({ sign: '@', value: '', label: 'current System' + (current ? ': ' + current.name : '') });
        }
        (state.systems || []).forEach(sys => {
            if (systems.has(sys.id)) out.push({ sign: '@', value: sys.name, count: systems.get(sys.id) });
        });
        return out;
    }

    /** #444: the endpoint's name/path with the searched-for words marked. */
    function marked(text) {
        return window.SearchWords ? window.SearchWords.highlight(text, searchWords) : escapeHtml(text);
    }

    // ─── Faceting logic (mirrors src/services/catalogue/catalogue.service.ts) ───

    function filterEndpoints(endpoints, filters) {
        const systemIds = (filters.systemIds && filters.systemIds.length > 0) ? new Set(filters.systemIds) : null;
        const methods = (filters.methods && filters.methods.length > 0) ? new Set(filters.methods) : null;
        // #444: every typed word, anywhere in the endpoint, any order ("phrase", -word)
        const words = filters.search && window.SearchWords ? window.SearchWords.parseWords(filters.search) : null;
        const search = words && (words.include.length || words.exclude.length) ? words : null;
        const tags = (filters.tags && filters.tags.length > 0)
            ? filters.tags.map(t => (t || '').trim().toLowerCase())
            : null;

        return endpoints.filter(e => {
            if (systemIds) {
                const sid = e.systemId || ORPHAN_SYSTEM_KEY;
                if (!systemIds.has(sid)) return false;
            }
            if (methods && !methods.has(e.method)) return false;
            if (tags) {
                const epTags = Array.isArray(e.tags)
                    ? e.tags.map(t => (t || '').trim().toLowerCase())
                    : [];
                // #444: the same sign repeated is any of them (`#a #b`: either tag)
                if (!tags.some(t => epTags.indexOf(t) !== -1)) return false;
            }
            if (search && !window.SearchWords.matches(search, buildSearchHaystack(e))) return false;
            return true;
        });
    }

    /**
     * Count unique tag occurrences across endpoints, scoped by `otherFilters`
     * (everything except `tags`). Mirrors `aggregateTagCounts` in the TS service.
     * Returns a Map<tag, count>.
     */
    function aggregateTagCounts(endpoints, otherFilters) {
        const scope = filterEndpoints(endpoints, Object.assign({}, otherFilters, { tags: [] }));
        const counts = new Map();
        scope.forEach(e => {
            if (!Array.isArray(e.tags)) return;
            const seen = new Set();
            e.tags.forEach(raw => {
                const t = (raw || '').trim().toLowerCase();
                if (!t || seen.has(t)) return;
                seen.add(t);
                counts.set(t, (counts.get(t) || 0) + 1);
            });
        });
        return counts;
    }

    /**
     * Build a single lowercase string containing every searchable field on an
     * endpoint. Mirrors `buildSearchHaystack` in the TS service.
     */
    function buildSearchHaystack(e) {
        const parts = [
            e.name, e.path, e.method, e.description,
            e.body, e.bodyWithComments, e.folder
        ];
        if (Array.isArray(e.tags)) parts.push(e.tags.join(' '));
        addRecordTokens(parts, e.headers);
        addRecordTokens(parts, e.queryParams);
        addRecordTokens(parts, e.environmentVariables);
        // Flavour bodies + queryParams, when present (forward-compat for P1)
        if (Array.isArray(e.flavours)) {
            e.flavours.forEach(f => {
                parts.push(f && f.name);
                parts.push(f && f.body);
                if (f) addRecordTokens(parts, f.queryParams);
            });
        }
        return parts.filter(Boolean).join('\n').toLowerCase();
    }

    function addRecordTokens(parts, record) {
        if (!record || typeof record !== 'object') return;
        Object.keys(record).forEach(key => {
            parts.push(key);
            const val = record[key];
            if (val == null) return;
            if (typeof val === 'string') {
                parts.push(val);
                return;
            }
            // Header/queryParam values are sometimes a HeaderConfig object
            // with { value, defaultValue, ... }. Pull the obvious string bits.
            if (typeof val === 'object') {
                if (typeof val.value === 'string') parts.push(val.value);
                if (typeof val.defaultValue === 'string') parts.push(val.defaultValue);
                if (typeof val.description === 'string') parts.push(val.description);
            }
        });
    }

    function groupEndpoints(endpoints, systems, view) {
        switch (view.groupBy) {
            case 'url': return groupByUrl(endpoints, systems);
            case 'system': return groupBySystem(endpoints, systems);
            case 'method': return groupByMethod(endpoints);
            case 'none':
            default: return [{ key: '__all__', label: 'All endpoints', endpoints: sortEndpoints(endpoints), children: [], count: endpoints.length }];
        }
    }

    function groupBySystem(endpoints, systems) {
        const buckets = bucketBySystem(endpoints);
        const lookup = mapSystems(systems);
        const out = [];
        buckets.forEach((list, systemId) => {
            const system = lookup.get(systemId);
            out.push({
                key: systemId,
                label: system ? system.name : ORPHAN_SYSTEM_LABEL,
                endpoints: sortEndpoints(list),
                children: [],
                count: list.length
            });
        });
        return out.sort((a, b) => a.label.localeCompare(b.label));
    }

    function groupByMethod(endpoints) {
        const byMethod = new Map();
        endpoints.forEach(e => {
            const m = e.method || 'GET';
            const arr = byMethod.get(m) || [];
            arr.push(e);
            byMethod.set(m, arr);
        });
        return ALL_METHODS
            .filter(m => byMethod.has(m))
            .map(m => ({
                key: m,
                label: m,
                endpoints: sortEndpoints(byMethod.get(m)),
                children: [],
                count: byMethod.get(m).length
            }));
    }

    function groupByUrl(endpoints, systems) {
        // No System wrapper layer — pre-trim each endpoint's path using its
        // System's trim prefix, then build one URL tree across all of them.
        // Endpoints from different Systems with the same trimmed segment
        // (e.g. both have "orders") collapse into the same group naturally.
        const lookup = mapSystems(systems);
        const preTrimmed = endpoints.map(e => {
            const trim = (lookup.get(e.systemId) || {}).treeTrimPrefix;
            const path = e.path || '';
            if (!trim || path.indexOf(trim) !== 0) return e;
            // Lightweight clone with the trimmed path; original object untouched.
            return Object.assign({}, e, { path: path.slice(trim.length) });
        });
        // Defensive: ensure clones have leading '/' so tree segmentation works.
        preTrimmed.forEach(e => {
            if (e.path && e.path[0] !== '/') e.path = '/' + e.path;
        });
        const tree = buildCompactUrlTree(preTrimmed, '');
        const groups = [];
        // Endpoints whose post-trim path is "/" attach as methods on the root.
        tree.methods.forEach(variants => variants.forEach(v => {
            groups.push({
                key: '__root__:' + v.id,
                label: '(root)',
                endpoints: [v],
                children: [],
                count: 1
            });
        }));
        tree.children.forEach(child => groups.push(urlNodeToGroup(child)));
        return groups.sort((a, b) => a.label.localeCompare(b.label));
    }

    function urlNodeToGroup(node) {
        const methodEndpoints = [];
        node.methods.forEach(variants => variants.forEach(v => methodEndpoints.push(v)));
        const children = [];
        node.children.forEach(child => children.push(urlNodeToGroup(child)));
        children.sort((a, b) => a.label.localeCompare(b.label));
        const count = methodEndpoints.length + children.reduce((sum, c) => sum + c.count, 0);
        return {
            key: node.fullPath || node.segment,
            label: node.segment,
            endpoints: sortEndpoints(methodEndpoints),
            children,
            count
        };
    }

    // ─── URL-tree (mirrors endpoint-tree-builder.ts) ───

    function buildCompactUrlTree(endpoints, trimPrefix) {
        return compactSingleChildChains(buildUrlTree(endpoints, trimPrefix, 4));
    }

    function buildUrlTree(endpoints, trimPrefix, maxDepth) {
        const root = { segment: '', fullPath: '', children: new Map(), methods: new Map() };
        endpoints.forEach(endpoint => {
            const segments = pathSegmentsAfterTrim(endpoint.path || '', trimPrefix);
            if (segments.length === 0) {
                addMethod(root, endpoint);
                return;
            }
            let node = root;
            const visibleCount = Math.min(segments.length, maxDepth);
            for (let i = 0; i < visibleCount; i++) {
                const isLastVisible = i === visibleCount - 1;
                const label = (isLastVisible && segments.length > maxDepth)
                    ? segments.slice(i).join('/')
                    : segments[i];
                const fullPath = '/' + segments.slice(0, i + 1).join('/');
                let child = node.children.get(label);
                if (!child) {
                    child = { segment: label, fullPath, children: new Map(), methods: new Map() };
                    node.children.set(label, child);
                }
                node = child;
            }
            addMethod(node, endpoint);
        });
        return root;
    }

    function compactSingleChildChains(node) {
        const compactedChildren = new Map();
        node.children.forEach(child => {
            const compacted = compactSingleChildChains(child);
            compactedChildren.set(compacted.segment, compacted);
        });
        if (node.segment !== '' && node.methods.size === 0 && compactedChildren.size === 1) {
            const onlyChild = compactedChildren.values().next().value;
            return {
                segment: node.segment + '/' + onlyChild.segment,
                fullPath: onlyChild.fullPath,
                children: onlyChild.children,
                methods: onlyChild.methods
            };
        }
        return { segment: node.segment, fullPath: node.fullPath, children: compactedChildren, methods: node.methods };
    }

    function pathSegmentsAfterTrim(path, trimPrefix) {
        let working = path;
        if (trimPrefix && trimPrefix.length > 0 && working.indexOf(trimPrefix) === 0) {
            working = working.slice(trimPrefix.length);
        }
        return working.split('/').filter(Boolean);
    }

    function addMethod(node, endpoint) {
        const arr = node.methods.get(endpoint.method) || [];
        arr.push(endpoint);
        node.methods.set(endpoint.method, arr);
    }

    function bucketBySystem(endpoints) {
        const bucket = new Map();
        endpoints.forEach(e => {
            const sid = e.systemId || ORPHAN_SYSTEM_KEY;
            const list = bucket.get(sid) || [];
            list.push(e);
            bucket.set(sid, list);
        });
        return bucket;
    }

    function mapSystems(systems) {
        const m = new Map();
        (systems || []).forEach(s => m.set(s.id, s));
        return m;
    }

    function sortEndpoints(endpoints) {
        return endpoints.slice().sort((a, b) => {
            const byPath = (a.path || '').localeCompare(b.path || '');
            if (byPath !== 0) return byPath;
            const byMethod = (a.method || '').localeCompare(b.method || '');
            if (byMethod !== 0) return byMethod;
            return (a.name || '').localeCompare(b.name || '');
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clearSelection() {
        selectedEndpointId = null;
        committedEndpointId = null;
        document.querySelectorAll('.catalogue-row.is-selected').forEach(r => r.classList.remove('is-selected'));
    }

    // ── Filters modal (SYS + methods + tags all in one place) ───────────
    // The funnel button in the header opens this. Users kept getting
    // confused by SYS-inline (auto-on) and the separate Tags popover, so
    // everything now lives behind the same funnel. Its badge count is the
    // total number of filters applied; the trailing × clears them all.

    /** Method counts per HTTP verb given the current System + search
     *  filters — used inside the modal so chips show "what's available"
     *  before you toggle them. */
    function methodCountsForModal(allEndpoints, filters) {
        const filtersExceptMethods = {
            systemIds: filters.systemIds,
            search: filters.search,
            methods: []
        };
        const candidates = filterEndpoints(allEndpoints, filtersExceptMethods);
        const counts = {};
        ALL_METHODS.forEach(m => { counts[m] = 0; });
        candidates.forEach(e => {
            if (counts[e.method] !== undefined) counts[e.method]++;
        });
        return counts;
    }


    /** Open the unified filters modal. Everything the user changes lives
     *  in a local `working` copy until Apply, so Cancel is truly cancel
     *  and Reset lets them preview a cleared state before committing. */
    function openFiltersModal() {
        if (!window.DbmnModal) return;
        const state = host.getState();
        // #444: start from what the box says now, not from before the typing pause
        const typed = document.getElementById('catalogueSearch');
        if (typed && typed.value !== view.query) {
            clearTimeout(searchDebounceTimer);
            view.query = typed.value;
        }
        deriveFilters(state);
        const systemIds = effectiveSystemIds(state);
        const filterInput = Object.assign({}, view.filters, { systemIds });
        const methodCts = methodCountsForModal(state.endpoints, filterInput);
        // Tag counts respect SYS + methods + search but not `tags` itself
        // (so toggling a tag doesn't zero its own list mid-flight).
        const tagFilters = Object.assign({}, view.filters, { systemIds, tags: [] });
        const tagCounts = aggregateTagCounts(state.endpoints, tagFilters);

        // #444: the builder starts from the query in the box, and writes it back
        const working = {
            systemMode: (view.filters.systems || []).indexOf(CURRENT_SYSTEM) !== -1 ? 'current' : 'all',
            methods: (view.filters.methods || []).slice(),
            tags: (view.filters.tags || []).slice(),
            systems: (view.filters.systems || []).filter(id => id !== CURRENT_SYSTEM)
        };
        const choice = () => Object.assign({}, working, {
            systems: (working.systemMode === 'current' ? [CURRENT_SYSTEM] : []).concat(working.systems)
        });

        const body = document.createElement('div');
        body.className = 'dbmn-filters-modal';

        // #444: the query as it is built, so it can be typed next time
        const queryLine = document.createElement('div');
        queryLine.className = 'dbmn-filter-query';
        queryLine.innerHTML = '<span class="dbmn-filter-query-label">Search</span><code class="dbmn-filter-query-text"></code>';
        body.appendChild(queryLine);
        const showQuery = () => {
            const q = queryFor(choice());
            const code = queryLine.querySelector('code');
            code.textContent = q || 'everything';
            code.classList.toggle('is-empty', !q);
        };
        body.addEventListener('click', () => setTimeout(showQuery, 0));
        body.addEventListener('change', showQuery);

        // ── System scope ────────────────────────────────────────────────
        const sysSection = section('System');
        const sysGroup = document.createElement('div');
        sysGroup.className = 'dbmn-filter-radio-group';
        [
            { key: 'all',     label: 'All Systems' },
            { key: 'current', label: 'Current System only' }
        ].forEach(opt => {
            const row = document.createElement('label');
            row.className = 'dbmn-filter-radio';
            const r = document.createElement('input');
            r.type = 'radio';
            r.name = 'catalogue-systemMode';
            r.value = opt.key;
            if (working.systemMode === opt.key) r.checked = true;
            r.addEventListener('change', () => { if (r.checked) working.systemMode = opt.key; });
            row.appendChild(r);
            const lbl = document.createElement('span');
            lbl.textContent = opt.label;
            row.appendChild(lbl);
            sysGroup.appendChild(row);
        });
        sysSection.appendChild(sysGroup);
        body.appendChild(sysSection);

        // ── HTTP method chips ──────────────────────────────────────────
        const methodSection = section('HTTP method');
        const methodRow = document.createElement('div');
        methodRow.className = 'dbmn-filter-chip-row';
        ALL_METHODS.forEach(method => {
            const n = methodCts[method] || 0;
            if (n === 0 && working.methods.indexOf(method) === -1) return;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'catalogue-chip method-' + method;
            chip.dataset.method = method;
            if (working.methods.indexOf(method) !== -1) chip.classList.add('is-active');
            chip.innerHTML = '<span class="catalogue-chip-label">' + method + '</span>' +
                '<span class="catalogue-chip-count">' + n + '</span>';
            chip.addEventListener('click', () => {
                const idx = working.methods.indexOf(method);
                if (idx === -1) { working.methods.push(method); chip.classList.add('is-active'); }
                else { working.methods.splice(idx, 1); chip.classList.remove('is-active'); }
            });
            methodRow.appendChild(chip);
        });
        methodSection.appendChild(methodRow);
        body.appendChild(methodSection);

        // ── Tags — search + scrollable checkbox list ───────────────────
        const tagsSection = section('Tags');
        const tagsSearchWrap = document.createElement('div');
        tagsSearchWrap.className = 'dbmn-filter-tags-search';
        const tagsSearch = document.createElement('input');
        tagsSearch.type = 'search';
        tagsSearch.placeholder = 'Search tags…';
        tagsSearch.autocomplete = 'off';
        tagsSearchWrap.appendChild(tagsSearch);
        tagsSection.appendChild(tagsSearchWrap);

        const tagsList = document.createElement('div');
        tagsList.className = 'dbmn-filter-tags-list';
        tagsSection.appendChild(tagsList);

        const renderTagRows = () => {
            tagsList.innerHTML = '';
            const term = (tagsSearch.value || '').trim().toLowerCase();
            const selectedSet = new Set(working.tags.map(t => (t || '').trim().toLowerCase()));
            const allTags = new Set([...tagCounts.keys(), ...selectedSet]);
            const rows = Array.from(allTags)
                .map(tag => ({ tag, count: tagCounts.get(tag) || 0 }))
                .filter(r => !term || r.tag.includes(term))
                .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
            if (rows.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'dbmn-filter-tags-empty';
                empty.textContent = term ? 'No matching tags' : 'No tags yet — add tags from the endpoint editor.';
                tagsList.appendChild(empty);
                return;
            }
            rows.forEach(({ tag, count }) => {
                const row = document.createElement('label');
                row.className = 'dbmn-filter-tags-row';
                const depth = Math.min(4, (tag.match(/\//g) || []).length);
                row.style.setProperty('--depth', depth);
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selectedSet.has(tag);
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        if (!working.tags.includes(tag)) working.tags.push(tag);
                    } else {
                        const idx = working.tags.indexOf(tag);
                        if (idx >= 0) working.tags.splice(idx, 1);
                    }
                });
                const label = document.createElement('span');
                label.className = 'dbmn-filter-tags-label';
                label.textContent = tag;
                const countEl = document.createElement('span');
                countEl.className = 'dbmn-filter-tags-count';
                countEl.textContent = String(count);
                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(countEl);
                tagsList.appendChild(row);
            });
        };
        tagsSearch.addEventListener('input', renderTagRows);
        renderTagRows();
        body.appendChild(tagsSection);
        // #444: how to type it, so the box can be used without the builder next time
        if (window.SearchWords) body.insertAdjacentHTML('beforeend', window.SearchWords.legendHtml(false));

        window.DbmnModal.show({
            title: 'Build a search',
            body,
            actions: [
                { id: 'reset',  label: 'Clear',  variant: 'secondary' },
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'apply',  label: 'Use search', variant: 'primary' }
            ],
            size: 'md'
        }).then(res => {
            if (!res || res.actionId === 'cancel' || res.actionId === 'dismiss') return;
            // Clear: the builder's parts go, the words typed stay
            if (res.actionId === 'reset') { setQuery(view.filters.search || ''); return; }
            setQuery(queryFor(choice()));
        });
        showQuery();

    }

    window.Catalogue = { init, update, applySettings, acknowledgeSystemCreated, clearSelection, setSelectedEndpoint: markSelected, handleSwapResult };
})();
