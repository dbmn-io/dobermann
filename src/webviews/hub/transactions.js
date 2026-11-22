// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
(function () {
    'use strict';

    /** Canonical execution statuses from src/types/unified-execution-status.ts.
     *  Source of truth — no bucket translation. Chips with count 0 hide via
     *  the shared `.catalogue-chip.is-empty` rule, so the row naturally
     *  trims to whatever's actually present in the current scope. */
    const STATUS_CHIPS = [
        { key: 'preparing', label: 'Preparing' },
        { key: 'pending',   label: 'Pending'   },
        { key: 'running',   label: 'Running'   },
        { key: 'paused',    label: 'Paused'    },
        { key: 'completed', label: 'Completed' },
        { key: 'warning',   label: 'Warning'   },
        { key: 'error',     label: 'Error'     },
        { key: 'cancelled', label: 'Cancelled' },
        { key: 'stopped',   label: 'Stopped'   },
        { key: 'skipped',   label: 'Skipped'   },
        { key: 'blocked',   label: 'Blocked'   },
        { key: 'split',     label: 'Split'     }
    ];

    const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

    const SEARCH_DEBOUNCE_MS = 150;

    /** Date-range presets used by the filters modal. `any` means unbounded,
     *  `custom` reveals the two date inputs so the user can pick absolute
     *  From/To values. The relative windows compute their `from` fresh on
     *  every applyFilters() call so "Last 7 days" always means the last 7
     *  days from *now*, not from when the preset was picked. */
    const DATE_PRESETS = [
        { key: 'any',    label: 'Any time',     ms: null },
        { key: '24h',    label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
        { key: '7d',     label: 'Last 7 days',   ms: 7 * 24 * 60 * 60 * 1000 },
        { key: '30d',    label: 'Last 30 days',  ms: 30 * 24 * 60 * 60 * 1000 },
        { key: 'custom', label: 'Custom range',  ms: null }
    ];

    /** @type {{ postMessage: (msg:any) => void, getState: () => any, getInitialSettings?: () => any } | null} */
    let host = null;

    let view = {
        groupBy: 'date',                  // 'date' | 'endpoint' | 'environment' | 'status' | 'none'
        showMode: undefined,              // 'current' | 'all' — kept for Settings parity; derived from envFilter
        envFilter: undefined,             // boolean — scope to current environment
        sysFilter: undefined,             // boolean — scope to current System (env's systemId)
        // #444: the search box's query, as typed (`env:current status:error 404`). It is the only
        // filter state: `filters` and the two scopes are worked out from it on every render.
        query: '',
        filters: {
            statuses: [],                 // canonical status keys (see STATUS_CHIPS)
            methods: [],                  // HTTP methods (GET, POST, …)
            endpointId: '',               // '' = all endpoints
            environments: [],             // #444: ~name (~ alone is envFilter)
            systemNames: [],              // #444: @name (@ alone is sysFilter)
            sinceMs: null,                // #444: 24h, 7d, 2w
            tags: [],                     // #444: tag:<tag>, the run's endpoint's tags
            search: '',
            datePreset: 'any',            // 'any' | '24h' | '7d' | '30d' | 'custom'
            dateFrom: '',                 // YYYY-MM-DD; only used when datePreset === 'custom'
            dateTo: ''                    // YYYY-MM-DD; only used when datePreset === 'custom'
        }
    };

    let searchDebounceTimer = null;
    let selectedTxId = null;
    // Bulk-select state — Set of currently-ticked transaction ids.
    // Issue #246: filter → select all (incl. by group) → bulk delete.
    const selectedIds = new Set();
    // Selection is MODAL — off by default. The user enters select mode via
    // the "Select" toggle above the list; row + group checkboxes only
    // appear in this mode (CSS-gated by `.is-select-mode` on the section).
    let selectMode = false;
    // Last full filtered set rendered — used by "select all in view" and
    // bulk-delete to know what's currently in scope.
    let lastFiltered = [];
    // Last scoped (pre-filter) set — cached so the filters modal can build
    // its endpoint list and chip counts without repeating scopeToCurrentEnv.
    let lastScoped = [];
    // Content search is always on (the user didn't want a toggle for it):
    // ids that the backend matched against request/response body files
    // for the current search term. null = nothing matched / no search yet.
    // #444: per word: word → Set of ids whose bodies hold it
    let contentMatchIds = null;
    let contentSearchInflight = 0;
    /** #444: the search box (shared/search-words.js). */
    let chipBox = null;
    let searchWords = { include: [], exclude: [] };
    /** An endpoint filter kept from before the query, named once the endpoints are known. */
    let pendingEndpointId = '';

    function init(hostApi) {
        host = hostApi;
        // SYS + ENV toggles now live in the filters modal; nothing to build inline.
        wireControls();
        const initial = (host.getInitialSettings && host.getInitialSettings()) || {};
        if (initial.transactionsShow) view.showMode = initial.transactionsShow;
        if (initial.transactionsGroupBy) view.groupBy = initial.transactionsGroupBy;
        if (typeof initial.transactionsQuery === 'string') {
            view.query = initial.transactionsQuery;
        } else {
            // #444: the filters kept before there was a query become one, once
            const old = {
                statuses: Array.isArray(initial.transactionsStatusFilters) ? initial.transactionsStatusFilters : [],
                methods: Array.isArray(initial.transactionsMethodFilters) ? initial.transactionsMethodFilters : [],
                datePreset: typeof initial.transactionsDatePreset === 'string' && DATE_PRESETS.some(p => p.key === initial.transactionsDatePreset)
                    ? initial.transactionsDatePreset
                    : (initial.transactionsDateFrom || initial.transactionsDateTo ? 'custom' : 'any'),
                dateFrom: initial.transactionsDateFrom || '',
                dateTo: initial.transactionsDateTo || ''
            };
            view.query = queryFor({
                envs: initial.transactionsEnvFilter === true || initial.transactionsShow === 'current' ? [''] : [],
                systems: initial.transactionsSysFilter === true ? [''] : [],
                statuses: old.statuses,
                methods: old.methods,
                dates: old.datePreset === 'custom' ? [(old.dateFrom || '') + '..' + (old.dateTo || '')] : old.datePreset !== 'any' ? [old.datePreset] : [],
                text: ''
            });
            if (typeof initial.transactionsEndpointFilter === 'string') pendingEndpointId = initial.transactionsEndpointFilter;
        }
        syncSettingsControlsToView();
    }

    function update(state) {
        // Default all scope filters OFF — SYS/ENV auto-on confused users
        // who saw fewer transactions than expected just because they had
        // an active env. They can flip either on via the filters modal.
        if (view.showMode === undefined) view.showMode = 'all';
        if (pendingEndpointId && (state.endpoints || []).length) {
            const ep = state.endpoints.find(e => e.id === pendingEndpointId);
            pendingEndpointId = '';
            if (ep && ep.name) {
                const q = window.SearchWords.parseQuery(view.query);
                setQuery(queryFor(Object.assign(q, { text: ('"' + ep.name.replace(/"/g, '') + '" ' + q.text).trim() })), false);
            }
        }
        syncSettingsControlsToView();
        render(state);
    }

    function applySettings(settings) {
        if (settings.showMode) {
            view.showMode = settings.showMode;
            // Settings "Show: Current Environment" is `~` in the query
            const q = deriveFilters(host.getState());
            const envs = q.envs.filter(Boolean).concat(settings.showMode === 'current' ? [''] : []);
            setQuery(queryFor(Object.assign({}, q, { envs })), false);
        }
        if (settings.groupBy) view.groupBy = settings.groupBy;
        render(host.getState());
    }

    function wireControls() {
        const search = document.getElementById('transactionsSearch');
        if (search && window.SearchWords) {
            chipBox = window.SearchWords.attach({
                input: search,
                fields: boxFields,
                values: fieldValues,
                onText: (text) => {
                    clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(() => {
                        view.query = text;
                        persistChip('transactionsQuery', view.query);
                        deriveFilters(host.getState());
                        maybeRequestContentSearch();
                        render(host.getState());
                    }, SEARCH_DEBOUNCE_MS);
                }
            });
        }

        // #444: the query builder: it writes the search box's query
        document.getElementById('transactionsFilterBtn')?.addEventListener('click', () => openFiltersModal());

        // Bulk-select controls (Issue #246). The "Select" toggle is a plain
        // on/off switch — flipping it on reveals the per-row + per-group
        // checkboxes; users tick whichever rows they want and hit Delete
        // in the footer. No cycle-to-select-all magic — keeps the UI
        // predictable.
        document.getElementById('transactionsSelectMode')?.addEventListener('change', onSelectModeChange);
        document.getElementById('transactionsBulkDelete')?.addEventListener('click', onBulkDeleteClick);
    }

    // ─── Every run, not only the newest ──────────────────────────────────
    // The Hub's state carries the newest runs (it is sent several times a second while a batch
    // runs). A search, or Show all, asks the host for every run once; the newest from each state
    // then go over them, so statuses stay current. A run deleted since makes the count fall:
    // everything is asked for again.
    let allRuns = null;
    let allRunsAsked = false;
    let showAll = false;

    // ─── Rows drawn as they are scrolled to ──────────────────────────────
    // A search, or Show all, can match thousands of runs: the first ROWS_AT_ONCE are drawn, the
    // next as the list is scrolled near its end. And while a batch runs the Hub's state comes
    // several times a second: the list is drawn again only when what it shows has changed.
    const ROWS_AT_ONCE = 200;
    let rowLimit = ROWS_AT_ONCE;
    let drawnFor = '';      // the query the limit counts for: a new one starts again at the top
    let drawnSig = '';      // what the list showed when last drawn
    let scrollWired = false;

    /** The groups cut to the first `limit` runs, keeping each group's heading. */
    function firstOfGroups(groups, limit) {
        const out = [];
        let left = limit;
        for (const group of groups) {
            if (left <= 0) break;
            const items = group.items.slice(0, left);
            left -= items.length;
            out.push(Object.assign({}, group, { items }));
        }
        return out;
    }

    /** What a drawn list depends on: if it is the same, nothing is drawn again. */
    function listSig(rows) {
        return [view.groupBy, rowLimit, selectMode ? 1 : 0, selectedTxId || '', Array.from(selectedIds).join(','),
            rows.map(t => [t.id, t.status, t.httpStatus, t.runTime, t.environment, txTitle(t), t.completedAt].join('~')).join('|')].join('#');
    }

    function wireListScroll(list) {
        if (scrollWired) return;
        scrollWired = true;
        list.addEventListener('scroll', () => {
            if (list.scrollHeight - list.scrollTop - list.clientHeight > 400) return;
            if (!lastFiltered || lastFiltered.length <= rowLimit) return;
            rowLimit += ROWS_AT_ONCE;
            render(host.getState());
        }, { passive: true });
    }

    function wantsAll() {
        return showAll || !!(view.query && String(view.query).trim());
    }

    function runsOf(state) {
        const newest = (state && state.transactions) || [];
        const total = state && typeof state.transactionsTotal === 'number' ? state.transactionsTotal : newest.length;
        if (!wantsAll() || total <= newest.length) return newest;
        if (!allRuns) {
            if (!allRunsAsked) { allRunsAsked = true; host.postMessage({ type: 'historyAll' }); }
            return newest;
        }
        const seen = new Set(newest.map(t => t.id));
        const runs = newest.concat(allRuns.filter(t => !seen.has(t.id)));
        if (runs.length > total) { allRuns = null; allRunsAsked = false; return runsOf(state); }
        return runs;
    }

    function onHistoryAll(message) {
        allRuns = (message && message.transactions) || [];
        render(host.getState());
        // A word in a body: look through the older runs' bodies too
        maybeRequestContentSearch();
    }

    function maybeRequestContentSearch() {
        // Content search is always on — the host reads the body files of the runs the chips
        // leave, for each typed word. Tiny words (< 2 chars) match too much to be worth a disk
        // scan; the details still find them.
        // Only `@@word`s reach the bodies: a plain word looks in what the list shows (James, 2026-11-21)
        const words = window.SearchWords ? window.SearchWords.deepWords(view.query || '').filter(w => w.length >= 2) : [];
        if (words.length === 0) {
            contentMatchIds = null;
            return;
        }
        const candidates = applyFilters(scopeToCurrentEnv(runsOf(host.getState()).filter(t => t.executionType !== 'batch_member'), host.getState()),
            Object.assign({}, view.filters, { search: '' }));
        const candidateIds = candidates.map(t => t.id);
        if (candidateIds.length === 0) return;
        contentSearchInflight++;
        host.postMessage({
            type: 'searchTransactionContent',
            terms: words,
            ids: candidateIds,
            requestId: contentSearchInflight
        });
    }

    function onContentSearchResult(message) {
        if (!message || message.requestId !== contentSearchInflight) return;
        const byTerm = message.matchedByTerm || {};
        contentMatchIds = new Map(Object.keys(byTerm).map(w => [String(w).toLowerCase(), new Set(byTerm[w] || [])]));
        render(host.getState());
    }

    // #444: the query (`transactionsQuery`) is kept with persistChip; the builder writes it.

    function persistChip(key, value) {
        try {
            const prev = (window.vscode?.getState && window.vscode.getState()) || {};
            window.vscode?.setState?.(Object.assign({}, prev, { [key]: value }));
        } catch { /* ignore */ }
    }

    function syncSettingsControlsToView() {
        const show = document.getElementById('transactionsShow');
        if (show) show.value = view.showMode || 'all';
        const group = document.getElementById('transactionsGroupBy');
        if (group) group.value = view.groupBy;
        const search = document.getElementById('transactionsSearch');
        if (search && search.value !== view.query) search.value = view.query || '';
    }

    function render(state) {
        const list = document.getElementById('transactionsList');
        const empty = document.getElementById('transactionsEmpty');
        if (!list || !empty) return;

        deriveFilters(state);
        searchWords = window.SearchWords ? window.SearchWords.parseWords(view.filters.words || '') : searchWords;
        // Strip batch members from the visible set — surface batches as a single
        // row; clicking opens the batch report which shows the members.
        const all = runsOf(state).filter(t => t.executionType !== 'batch_member');
        const scoped = scopeToCurrentEnv(all, state);
        const filtered = applyFilters(scoped, view.filters);
        const grouped = groupTransactions(filtered, view.groupBy, state);

        lastFiltered = filtered;
        // Prune selections that fell out of the current filtered view so
        // the bulk-action bar count never lies. (User can re-tick after
        // widening the filter.)
        const visibleIds = new Set(filtered.map(t => t.id));
        for (const id of Array.from(selectedIds)) {
            if (!visibleIds.has(id)) selectedIds.delete(id);
        }

        // Cache scoped set for the filters modal so it can build the
        // endpoint list + chip counts without repeating scopeToCurrentEnv.
        lastScoped = scoped;
        renderSummary(filtered.length, scoped.length, state);
        renderBulkBar();

        if (all.length === 0) {
            list.hidden = true;
            empty.hidden = false;
            drawnSig = '';
            return;
        }
        list.hidden = false;
        empty.hidden = true;
        wireListScroll(list);

        // A new search or filter starts again with the first rows
        const forQuery = [view.query || '', view.groupBy, view.sysFilter ? 1 : 0, view.envFilter ? 1 : 0, view.showMode || '', showAll ? 1 : 0].join('|');
        if (forQuery !== drawnFor) { drawnFor = forQuery; rowLimit = ROWS_AT_ONCE; list.scrollTop = 0; }
        const drawn = filtered.slice(0, rowLimit);
        const sig = listSig(drawn) + '#' + filtered.length;
        if (sig === drawnSig) return;
        drawnSig = sig;
        list.innerHTML = '';

        if (filtered.length === 0) {
            const none = document.createElement('div');
            none.className = 'catalogue-noresults';
            none.textContent = ((view.sysFilter || view.envFilter) && !state.activeEnvironmentId)
                ? 'No active environment — pick one to use the SYS / ENV filters.'
                : 'No transactions match the current filters.';
            list.appendChild(none);
            return;
        }

        if (view.groupBy === 'none') {
            drawn.forEach(tx => list.appendChild(renderTxRow(tx, state)));
        } else {
            firstOfGroups(grouped, rowLimit).forEach(group => list.appendChild(renderGroup(group, state)));
        }
        if (filtered.length > drawn.length) {
            const more = document.createElement('div');
            more.className = 'catalogue-noresults tx-list-more';
            more.textContent = drawn.length.toLocaleString() + ' of ' + filtered.length.toLocaleString() + ' shown · scroll for more';
            list.appendChild(more);
        }

        if (window.Icons) window.Icons.injectIcons(list);
    }

    function renderBulkBar() {
        // Scope to .hub-section — the nav-button rail ALSO has
        // data-section="transactions", so the bare selector matched the
        // wrong element (made the section's `is-select-mode` class land
        // on the rail button).
        const section = document.querySelector('section.hub-section[data-section="transactions"]');
        if (section) section.classList.toggle('is-select-mode', selectMode);

        // Toggle just mirrors the boolean. We DON'T `preventDefault` on
        // change events — the toggle's `.checked` is the truth source
        // for `selectMode` (kept in sync via `onSelectModeChange`).
        const master = document.getElementById('transactionsSelectMode');
        if (master && master.checked !== selectMode) master.checked = selectMode;

        // Footer mirrors select mode — present whenever the user is
        // selecting (even at 0) so the Delete affordance is reachable.
        const bar = document.getElementById('transactionsBulkBar');
        const count = document.getElementById('transactionsBulkCount');
        const del = document.getElementById('transactionsBulkDelete');
        if (bar) bar.hidden = !selectMode;
        if (count) {
            const n = selectedIds.size;
            count.textContent = n === 1 ? '1 selected' : (n + ' selected');
        }
        if (del) del.disabled = selectedIds.size === 0;
    }

    /**
     * Plain on/off toggle for select mode. Flipping off clears the
     * current selection so the user lands in a clean state next time
     * they flip back on.
     */
    function onSelectModeChange(ev) {
        selectMode = !!ev.target.checked;
        if (!selectMode) selectedIds.clear();
        render(host.getState());
    }

    function toggleGroupSelection(groupItems, checked) {
        groupItems.forEach(t => {
            if (checked) selectedIds.add(t.id); else selectedIds.delete(t.id);
        });
        // Re-render the rows in the group so their checkboxes reflect
        // the new state; cheap because group bodies are local DOM.
        render(host.getState());
    }

    function syncGroupCheckboxes() {
        document.querySelectorAll('.tx-group-select').forEach(cb => {
            const ids = (cb.dataset.groupIds || '').split('|').filter(Boolean);
            if (ids.length === 0) return;
            const selected = ids.filter(id => selectedIds.has(id)).length;
            cb.checked = selected === ids.length;
            cb.indeterminate = selected > 0 && selected < ids.length;
        });
    }

    function onBulkDeleteClick() {
        if (selectedIds.size === 0) return;
        // Hub-manager runs the confirmation flow (respects
        // ui.confirmTransactionDeletion). After delete, the state
        // broadcaster pushes a fresh transaction list; rows drop out
        // and we exit select mode so the user lands in a clean view.
        host.postMessage({
            type: 'bulkDeleteTransactions',
            ids: Array.from(selectedIds)
        });
        // Optimistically exit select mode — the backend will push a
        // fresh state shortly that confirms the deletion.
        selectMode = false;
        selectedIds.clear();
    }

    function scopeToCurrentEnv(transactions, state) {
        // Two independent scope chips. SYS narrows to the System the
        // active env belongs to; ENV narrows further to that specific
        // env. Both off = no scope filter.
        if (!view.sysFilter && !view.envFilter) return transactions;
        if (!state.activeEnvironmentId) return [];

        const envs = state.environments || [];
        const activeEnv = envs.find(e => e.id === state.activeEnvironmentId);
        const activeEnvName = activeEnv?.name;

        let scoped = transactions;

        if (view.sysFilter) {
            // Transactions don't carry systemId directly — resolve via env.
            // Build the set of env ids + names that belong to the active System.
            const activeSysId = state.activeSystemId || activeEnv?.systemId;
            const sysEnvIds = new Set();
            const sysEnvNames = new Set();
            envs.forEach(e => {
                if ((e.systemId || null) === (activeSysId || null)) {
                    sysEnvIds.add(e.id);
                    if (e.name) sysEnvNames.add(e.name);
                }
            });
            scoped = scoped.filter(t =>
                (t.environmentId && sysEnvIds.has(t.environmentId)) ||
                (t.environment && sysEnvNames.has(t.environment))
            );
        }

        if (view.envFilter) {
            scoped = scoped.filter(t =>
                t.environmentId === state.activeEnvironmentId ||
                (activeEnvName && t.environment === activeEnvName)
            );
        }

        return scoped;
    }

    function applyFilters(transactions, filters) {
        const statuses = filters.statuses && filters.statuses.length > 0 ? filters.statuses : null;
        const methods = filters.methods && filters.methods.length > 0 ? filters.methods : null;
        const endpointId = filters.endpointId || '';
        const environments = filters.environments && filters.environments.length ? filters.environments.map(e => String(e).toLowerCase()) : null;
        // @tag=: each its own group (all of them), `a|b` either; a builder's list of tags, any of them
        const tagGroups = filters.tagGroups && filters.tagGroups.length ? filters.tagGroups
            : filters.tags && filters.tags.length ? [filters.tags.map(t => String(t).toLowerCase())] : null;
        const hubState = (host && host.getState && host.getState()) || {};
        const endpointsById = new Map((hubState.endpoints || []).map(e => [e.id, e]));
        // The rest of the query: the tables' search over the run's fields (plain words in what its row shows)
        const search = filters.search && String(filters.search).trim() && window.SearchWords && window.SearchWords.rowTest
            ? window.SearchWords.rowTest(filters.search, runFields(endpointsById))
            : null;
        // `@name`: runs in that System's environments (a run knows its environment, not its System)
        let systemEnvs = null;
        if (filters.systemNames && filters.systemNames.length) {
            const ids = new Set((hubState.systems || []).filter(x => filters.systemNames.indexOf(String(x.name || '').toLowerCase()) !== -1).map(x => x.id));
            systemEnvs = new Set();
            (hubState.environments || []).forEach(e => { if (e.systemId && ids.has(e.systemId)) { systemEnvs.add(e.id); if (e.name) systemEnvs.add(e.name); } });
        }
        const bounds = computeDateBounds(filters);
        const dateFrom = bounds.from;
        const dateTo = bounds.to;
        return transactions.filter(t => {
            if (statuses) {
                const s = String(t.status || '').toLowerCase();
                if (statuses.indexOf(s) === -1) return false;
            }
            if (methods) {
                const m = String(t.endpointMethod || '').toUpperCase();
                if (methods.indexOf(m) === -1) return false;
            }
            if (endpointId && t.endpointId !== endpointId) return false;
            if (environments && environments.indexOf(String(t.environment || '').toLowerCase()) === -1) return false;
            if (systemEnvs && !systemEnvs.has(t.environmentId) && !systemEnvs.has(t.environment)) return false;
            if (tagGroups) {
                const ep = endpointsById.get(t.endpointId);
                const epTags = (ep && Array.isArray(ep.tags) ? ep.tags : []).map(x => String(x).trim().toLowerCase());
                if (!tagGroups.every(g => g.some(x => epTags.indexOf(x) !== -1))) return false;
            }
            if (dateFrom != null || dateTo != null) {
                const ts = txTimestamp(t);
                if (dateFrom != null && (!ts || ts < dateFrom)) return false;
                if (dateTo != null && (!ts || ts > dateTo)) return false;
            }
            if (search && !search(t)) return false;
            return true;
        });
    }

    function dateBoundMs(yyyyMmDd, edge) {
        // Local-day bounds — the inputs are date-only so we compare in
        // the user's timezone, not UTC.
        const parts = String(yyyyMmDd).split('-');
        if (parts.length !== 3) return null;
        const y = Number(parts[0]);
        const m = Number(parts[1]) - 1;
        const d = Number(parts[2]);
        if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
        const dt = edge === 'end' ? new Date(y, m, d, 23, 59, 59, 999) : new Date(y, m, d, 0, 0, 0, 0);
        return dt.getTime();
    }

    /** #445: a batch's own name (Run Batch → Name), else its endpoint's. */
    function txTitle(t) {
        const name = t.batchConfiguration && typeof t.batchConfiguration.name === 'string' ? t.batchConfiguration.name.trim() : '';
        return name || t.endpointName || '';
    }

    /** #445: under a named batch, which endpoint it ran, then the path. */
    function txSubtitle(t) {
        const named = txTitle(t) !== (t.endpointName || '');
        return named && t.endpointName
            ? t.endpointName + (t.endpointPath ? ' · ' + t.endpointPath : '')
            : (t.endpointPath || '');
    }

    /**
     * What the search reaches on a run (the tables' search): its title, endpoint and path, status,
     * method, environment and HTTP status are on its row; the rest (the endpoint's current name and
     * tags, organisation, error, when it ran) is found by @@word or @field. Its bodies are searched
     * by the host for `@@word`s: `body` reads as the words found in this run's.
     */
    function runFields(endpointsById) {
        const ep = t => endpointsById && endpointsById.get(t.endpointId);
        // A run knows its environment, not its System: the environment's System
        const state = (host && host.getState && host.getState()) || {};
        const systemName = new Map((state.systems || []).map(x => [x.id, x.name]));
        const envSystem = new Map();
        (state.environments || []).forEach(e => { const n = systemName.get(e.systemId); if (n) { envSystem.set(e.id, n); if (e.name) envSystem.set(e.name, n); } });
        return [
            { id: 'title', get: t => txTitle(t) },
            { id: 'endpoint', get: t => txSubtitle(t) },
            { id: 'status', get: t => String(t.status || '').toLowerCase() },
            { id: 'method', get: t => t.endpointMethod || '' },
            { id: 'env', get: t => t.environment || '' },
            { id: 'http', get: t => (t.httpStatus != null ? String(t.httpStatus) : '') },
            { id: 'name', hidden: true, get: t => (ep(t) && ep(t).name) || t.endpointName || '' },
            { id: 'path', hidden: true, get: t => t.endpointPath || '' },
            { id: 'tag', hidden: true, get: t => (ep(t) && Array.isArray(ep(t).tags) ? ep(t).tags : []) },
            { id: 'system', hidden: true, get: t => envSystem.get(t.environmentId) || envSystem.get(t.environment) || '' },
            { id: 'organization', hidden: true, get: t => t.organization || '' },
            { id: 'error', hidden: true, get: t => [t.errorMessage, t.httpStatusText].filter(Boolean).join('\n') },
            { id: 'ran', hidden: true, get: t => { const ms = txTimestamp(t); return ms ? new Date(ms).toISOString() : ''; } },
            { id: 'body', hidden: true, get: t => (contentMatchIds ? Array.from(contentMatchIds.keys()).filter(w => contentMatchIds.get(w).has(t.id)).join('\n') : '') }
        ];
    }
    /** The box's fields, shown and not, for its colours and `@` list. */
    function boxFields() {
        const all = runFields(null);
        return { headings: all.map(f => f.id), hidden: all.filter(f => f.hidden).map(f => f.id) };
    }

    // ─── #444: the search box's query ───────────────────────────────────

    /**
     * view.filters and the two scopes from the query (search-words.js): @system=current|name,
     * @env=current|name, @status, @method, @tag, @ran>7d or @ran=2026-11-01..2026-11-12; the rest
     * (words, @@words, other @fields) is `search`, read by the tables' search over a run's fields.
     */
    function deriveFilters(state) {
        const W = window.SearchWords;
        const q = W ? W.parseQuery(view.query || '') : { methods: [], tags: [], tagGroups: [], systems: [], statuses: [], envs: [], dates: [], text: view.query || '', words: view.query || '' };
        const f = view.filters;
        f.methods = q.methods.slice();
        f.statuses = q.statuses.map(x => x.toLowerCase());
        f.tags = q.tags.map(x => x.toLowerCase());
        // each @tag= its own (all of them), `a|b` in one either
        f.tagGroups = q.tagGroups.map(g => g.map(x => x.toLowerCase()));
        f.words = q.words;
        f.endpointId = '';
        view.envFilter = q.envs.indexOf('') !== -1;
        f.environments = q.envs.filter(Boolean);
        view.sysFilter = q.systems.indexOf('') !== -1;
        f.systemNames = q.systems.filter(Boolean).map(x => x.toLowerCase());
        const date = q.dates[0] || '';
        const range = W && W.between(date);
        const since = W && W.sinceMs(date);
        f.dateFrom = range ? range.from : '';
        f.dateTo = range ? range.to : '';
        f.sinceMs = since || null;
        f.datePreset = range ? 'custom' : since ? (DATE_PRESETS.some(p => p.key === date) ? date : 'since') : 'any';
        f.dateToken = date;
        f.search = q.text;
        return q;
    }

    /** The query for a builder's choices (a parseQuery shape), keeping the words typed. */
    function queryFor(c) {
        return window.SearchWords ? window.SearchWords.buildQuery(Object.assign({
            systems: [], envs: [], statuses: [], methods: [], tags: [], dates: []
        }, c, { text: c.text !== undefined ? c.text : (view.filters.search || '') })) : (view.filters.search || '');
    }

    /** Set the box's query (the builder, Show history), keep it, and show what it finds. */
    function setQuery(query, draw) {
        view.query = query || '';
        persistChip('transactionsQuery', view.query);
        if (chipBox) chipBox.setText(view.query);
        if (host && host.getState) deriveFilters(host.getState());
        maybeRequestContentSearch();
        if (draw !== false) render(host.getState());
    }

    /** What `@field=` offers: methods, statuses, environments and Systems (the current ones first), tags, with how many runs have each. */
    function fieldValues(heading) {
        const state = host.getState();
        const all = runsOf(state).filter(t => t.executionType !== 'batch_member');
        const endpointsById = new Map((state.endpoints || []).map(e => [e.id, e]));
        const field = String(heading).toLowerCase();
        const tally = pick => {
            const counts = new Map();
            all.forEach(t => new Set([].concat(pick(t)).map(v => String(v || '').trim()).filter(Boolean)).forEach(v => {
                const had = counts.get(v.toLowerCase());
                counts.set(v.toLowerCase(), { value: had ? had.value : v, count: (had ? had.count : 0) + 1 });
            }));
            return Array.from(counts.values());
        };
        const env = (state.environments || []).find(e => e.id === state.activeEnvironmentId);
        const sys = (state.systems || []).find(x => x.id === (state.activeSystemId || (env && env.systemId)));
        if (field === 'method') return tally(t => String(t.endpointMethod || '').toLowerCase());
        if (field === 'status') return tally(t => String(t.status || '').toLowerCase());
        if (field === 'tag') return tally(t => { const ep = endpointsById.get(t.endpointId); return ep && Array.isArray(ep.tags) ? ep.tags : []; });
        if (field === 'env') {
            const out = tally(t => t.environment);
            if (env) out.unshift({ value: 'current', label: 'current environment: ' + env.name });
            return out;
        }
        if (field === 'system') {
            const out = (state.systems || []).filter(x => x && x.name).map(x => ({ value: x.name }));
            if (sys) out.unshift({ value: 'current', label: 'current System: ' + sys.name });
            return out;
        }
        return [];
    }

    /** #444: the Catalogue's right-click → Show history: that endpoint's runs, nothing else. */
    function showEndpointHistory(endpointId) {
        const state = host.getState();
        const ep = (state.endpoints || []).find(e => e.id === endpointId);
        const tx = runsOf(state).find(t => t.endpointId === endpointId);
        const name = (ep && ep.name) || (tx && tx.endpointName) || endpointId;
        contentMatchIds = null;
        // its name as a phrase: the runs of that endpoint
        setQuery('"' + String(name).replace(/"/g, '') + '"');
    }

    function marked(text) {
        return window.SearchWords ? window.SearchWords.highlight(text, searchWords) : escapeHtml(text);
    }

    /** Endpoints present in the current scoped set, plus the currently-
     *  selected endpoint even if scoped out (otherwise picking SYS would
     *  blind-clear the user's endpoint pick). Returns [{ id, name }]
     *  sorted by name. Used by the filters modal to build its endpoint
     *  select. */
    function buildEndpointOptions(scoped, state) {
        const endpointsById = new Map();
        (state.endpoints || []).forEach(e => endpointsById.set(e.id, e));

        const present = new Map();
        (scoped || []).forEach(t => {
            if (!t.endpointId) return;
            if (present.has(t.endpointId)) return;
            const ep = endpointsById.get(t.endpointId);
            present.set(t.endpointId, {
                id: t.endpointId,
                name: (ep && ep.name) || t.endpointName || '(unnamed)'
            });
        });

        const selectedId = view.filters.endpointId || '';
        if (selectedId && !present.has(selectedId)) {
            const ep = endpointsById.get(selectedId);
            present.set(selectedId, { id: selectedId, name: (ep && ep.name) || '(missing)' });
        }

        return Array.from(present.values()).sort((a, b) =>
            (a.name || '').localeCompare(b.name || '')
        );
    }

    /** Effective [from, to] millisecond bounds from the current filter
     *  state, honouring datePreset. Relative windows ('24h', '7d', '30d')
     *  compute from *now* so they self-refresh; 'custom' uses the user's
     *  From/To inputs; 'any' returns nulls. */
    function computeDateBounds(filters) {
        const preset = filters.datePreset || 'any';
        if (preset === 'custom') {
            return {
                from: filters.dateFrom ? dateBoundMs(filters.dateFrom, 'start') : null,
                to:   filters.dateTo   ? dateBoundMs(filters.dateTo,   'end')   : null
            };
        }
        // #444: `24h`, `7d`, `2w` in the query
        if (preset === 'since' && filters.sinceMs) return { from: Date.now() - filters.sinceMs, to: null };
        const spec = DATE_PRESETS.find(p => p.key === preset);
        if (!spec || spec.ms == null) return { from: null, to: null };
        return { from: Date.now() - spec.ms, to: null };
    }

    /** Build and open the DbmnModal filter sheet. Everything the user
     *  changes lives in a local `working` copy until they hit Apply; that
     *  way Cancel truly cancels. Reset zeros the working copy in place so
     *  the user can see the cleared state before committing. */
    function openFiltersModal() {
        if (!window.DbmnModal) return;
        const state = host.getState();
        // #444: start from what the box says now, not from before the typing pause
        const typed = document.getElementById('transactionsSearch');
        if (typed && typed.value !== view.query) {
            clearTimeout(searchDebounceTimer);
            view.query = typed.value;
        }
        deriveFilters(state);
        // The modal uses the scoped set for chip counts + endpoint list so
        // its picker only offers what's actually visible in the current
        // SYS/ENV scope. Falling back to full transactions covers the
        // first-open-before-first-render case.
        const scoped = lastScoped.length > 0 ? lastScoped
            : scopeToCurrentEnv(runsOf(state)
                .filter(t => t.executionType !== 'batch_member'), state);
        const endpointOptions = buildEndpointOptions(scoped, state);

        // #444: the builder starts from the query in the box, and writes it back
        // An endpoint named as a phrase in the words ("Get Carriers") is the builder's endpoint
        const typedWords = view.filters.search || '';
        const startEndpoint = endpointOptions.find(ep => typedWords.toLowerCase().indexOf('"' + String(ep.name).toLowerCase() + '"') !== -1);
        const startQuery = window.SearchWords.parseQuery(view.query || '');
        const working = {
            sysFilter: !!view.sysFilter,
            envFilter: !!view.envFilter,
            endpointId: startEndpoint ? startEndpoint.id : '',
            datePreset: view.filters.datePreset || 'any',
            dateFrom: view.filters.dateFrom || '',
            dateTo: view.filters.dateTo || '',
            statuses: (view.filters.statuses || []).slice(),
            methods: (view.filters.methods || []).slice(),
            tags: (view.filters.tags || []).slice()
        };

        const body = document.createElement('div');
        body.className = 'dbmn-filters-modal';

        // What the builder's choices make; the parts it has no control for are kept
        const choice = () => {
            const picked = endpointOptions.find(ep => ep.id === working.endpointId);
            let words = typedWords;
            if (startEndpoint) words = words.replace(new RegExp('"' + String(startEndpoint.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i'), '').trim();
            if (picked) words = ('"' + String(picked.name).replace(/"/g, '') + '" ' + words).trim();
            let dates = [];
            if (working.datePreset === 'custom' && (working.dateFrom || working.dateTo)) dates = [(working.dateFrom || '') + '..' + (working.dateTo || '')];
            else if (working.datePreset === view.filters.datePreset && view.filters.dateToken) dates = [view.filters.dateToken];
            else if (working.datePreset !== 'any' && working.datePreset !== 'custom') dates = [working.datePreset];
            return {
                systems: (working.sysFilter ? [''] : []).concat(startQuery.systems.filter(Boolean)),
                envs: (working.envFilter ? [''] : []).concat(startQuery.envs.filter(Boolean)),
                statuses: working.statuses,
                methods: working.methods,
                tags: working.tags,
                dates,
                text: words
            };
        };
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
        body.addEventListener('input', showQuery);

        // ── Scope (SYS + ENV) ─────────────────────────────────────────────
        // Two independent checkboxes because SYS + ENV are genuinely
        // orthogonal — you can narrow by System without narrowing by
        // Environment and vice versa. Both default OFF now to avoid the
        // "why are there no transactions?" surprise on first load.
        const scopeSection = section('Scope');
        const scopeRow = document.createElement('div');
        scopeRow.className = 'dbmn-filter-check-row';
        [
            { key: 'sysFilter', label: 'Current System only',      title: 'Show only transactions from environments in the active System' },
            { key: 'envFilter', label: 'Current Environment only', title: 'Show only transactions from the active Environment' }
        ].forEach(spec => {
            const row = document.createElement('label');
            row.className = 'dbmn-filter-check';
            row.title = spec.title;
            const c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = !!working[spec.key];
            c.addEventListener('change', () => { working[spec.key] = c.checked; });
            row.appendChild(c);
            const lbl = document.createElement('span');
            lbl.textContent = spec.label;
            row.appendChild(lbl);
            scopeRow.appendChild(row);
        });
        scopeSection.appendChild(scopeRow);
        body.appendChild(scopeSection);

        // ── Date range section (radios + collapsed custom inputs) ────────
        const dateSection = section('When');
        const dateGroup = document.createElement('div');
        dateGroup.className = 'dbmn-filter-radio-group';
        DATE_PRESETS.forEach(p => {
            const row = document.createElement('label');
            row.className = 'dbmn-filter-radio';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'dbmn-filter-datePreset';
            radio.value = p.key;
            if (working.datePreset === p.key) radio.checked = true;
            radio.addEventListener('change', () => {
                if (radio.checked) {
                    working.datePreset = p.key;
                    customWrap.hidden = p.key !== 'custom';
                }
            });
            row.appendChild(radio);
            const lbl = document.createElement('span');
            lbl.textContent = p.label;
            row.appendChild(lbl);
            dateGroup.appendChild(row);
        });
        dateSection.appendChild(dateGroup);

        const customWrap = document.createElement('div');
        customWrap.className = 'dbmn-filter-daterange';
        customWrap.hidden = working.datePreset !== 'custom';
        const fromLabel = document.createElement('label');
        fromLabel.innerHTML = '<span>From</span>';
        const fromInput = document.createElement('input');
        fromInput.type = 'date';
        fromInput.value = working.dateFrom;
        fromInput.addEventListener('input', () => { working.dateFrom = fromInput.value; });
        fromLabel.appendChild(fromInput);
        const toLabel = document.createElement('label');
        toLabel.innerHTML = '<span>To</span>';
        const toInput = document.createElement('input');
        toInput.type = 'date';
        toInput.value = working.dateTo;
        toInput.addEventListener('input', () => { working.dateTo = toInput.value; });
        toLabel.appendChild(toInput);
        customWrap.appendChild(fromLabel);
        customWrap.appendChild(toLabel);
        dateSection.appendChild(customWrap);
        body.appendChild(dateSection);

        // ── Endpoint section (native select — long lists fit here better
        //     than a chip strip) ──────────────────────────────────────────
        const epSection = section('Endpoint');
        const epSelect = document.createElement('select');
        epSelect.className = 'dbmn-filter-select';
        const anyOpt = document.createElement('option');
        anyOpt.value = '';
        anyOpt.textContent = 'All endpoints';
        epSelect.appendChild(anyOpt);
        endpointOptions.forEach(ep => {
            const opt = document.createElement('option');
            opt.value = ep.id;
            opt.textContent = ep.name;
            if (working.endpointId === ep.id) opt.selected = true;
            epSelect.appendChild(opt);
        });
        epSelect.addEventListener('change', () => { working.endpointId = epSelect.value || ''; });
        epSection.appendChild(epSelect);
        body.appendChild(epSection);

        // ── Status chips (multi-select) ─────────────────────────────────
        // Live counts inside a filter modal help pick "the one with results"
        // — same trick the previous inline chips used. Ignore the status
        // filter when counting so toggling a chip doesn't zero its own
        // neighbours mid-flight.
        const statusSection = section('Status');
        const statusRow = document.createElement('div');
        statusRow.className = 'dbmn-filter-chip-row';
        const statusCountBase = applyFilters(scoped, Object.assign({}, view.filters, { statuses: [] }));
        STATUS_CHIPS.forEach(spec => {
            const count = statusCountBase.filter(t => String(t.status || '').toLowerCase() === spec.key).length;
            if (count === 0 && working.statuses.indexOf(spec.key) === -1) return; // hide impossible chips
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'catalogue-chip status-' + spec.key;
            chip.dataset.status = spec.key;
            if (working.statuses.indexOf(spec.key) !== -1) chip.classList.add('is-active');
            chip.innerHTML = '<span class="catalogue-chip-label">' + spec.label + '</span>' +
                '<span class="catalogue-chip-count">' + count + '</span>';
            chip.addEventListener('click', () => {
                const idx = working.statuses.indexOf(spec.key);
                if (idx === -1) { working.statuses.push(spec.key); chip.classList.add('is-active'); }
                else { working.statuses.splice(idx, 1); chip.classList.remove('is-active'); }
            });
            statusRow.appendChild(chip);
        });
        statusSection.appendChild(statusRow);
        body.appendChild(statusSection);

        // ── Method chips (multi-select) ─────────────────────────────────
        const methodSection = section('HTTP method');
        const methodRow = document.createElement('div');
        methodRow.className = 'dbmn-filter-chip-row';
        const methodCountBase = applyFilters(scoped, Object.assign({}, view.filters, { methods: [] }));
        ALL_METHODS.forEach(method => {
            const count = methodCountBase.filter(t => String(t.endpointMethod || '').toUpperCase() === method).length;
            if (count === 0 && working.methods.indexOf(method) === -1) return;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'catalogue-chip method-' + method;
            chip.dataset.method = method;
            if (working.methods.indexOf(method) !== -1) chip.classList.add('is-active');
            chip.innerHTML = '<span class="catalogue-chip-label">' + method + '</span>' +
                '<span class="catalogue-chip-count">' + count + '</span>';
            chip.addEventListener('click', () => {
                const idx = working.methods.indexOf(method);
                if (idx === -1) { working.methods.push(method); chip.classList.add('is-active'); }
                else { working.methods.splice(idx, 1); chip.classList.remove('is-active'); }
            });
            methodRow.appendChild(chip);
        });
        methodSection.appendChild(methodRow);
        body.appendChild(methodSection);

        // ── Tags (#444): the runs' endpoints' tags ─────────────────────
        const tagCounts = new Map();
        const endpointsById = new Map((state.endpoints || []).map(e => [e.id, e]));
        scoped.forEach(t => {
            const ep = endpointsById.get(t.endpointId);
            new Set((ep && Array.isArray(ep.tags) ? ep.tags : []).map(x => String(x).trim().toLowerCase()).filter(Boolean))
                .forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1));
        });
        working.tags.forEach(tag => { if (!tagCounts.has(tag)) tagCounts.set(tag, 0); });
        if (tagCounts.size) {
            const tagsSection = section('Tags');
            const tagsList = document.createElement('div');
            tagsList.className = 'dbmn-filter-tags-list';
            Array.from(tagCounts.entries()).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).forEach(([tag, n]) => {
                const row = document.createElement('label');
                row.className = 'dbmn-filter-tags-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = working.tags.indexOf(tag) !== -1;
                cb.addEventListener('change', () => {
                    working.tags = working.tags.filter(x => x !== tag).concat(cb.checked ? [tag] : []);
                });
                const label = document.createElement('span');
                label.className = 'dbmn-filter-tags-label';
                label.textContent = tag;
                const countEl = document.createElement('span');
                countEl.className = 'dbmn-filter-tags-count';
                countEl.textContent = String(n);
                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(countEl);
                tagsList.appendChild(row);
            });
            tagsSection.appendChild(tagsList);
            body.appendChild(tagsSection);
        }
        // How to type it, so the box can be used without the builder next time
        if (window.SearchWords) body.insertAdjacentHTML('beforeend', window.SearchWords.legendHtml(true));

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

        if (window.Icons) window.Icons.injectIcons(body);
        showQuery();

        function section(headingText) {
            const s = document.createElement('section');
            s.className = 'dbmn-filter-section';
            const h = document.createElement('h3');
            h.className = 'dbmn-filter-section-title';
            h.textContent = headingText;
            s.appendChild(h);
            return s;
        }
    }

    function renderSummary(visibleCount, scopeCount, state) {
        const el = document.getElementById('transactionsSummary');
        if (!el) return;
        if (scopeCount === 0) { el.textContent = ''; return; }
        const noun = scopeCount === 1 ? 'transaction' : 'transactions';
        const within = view.showMode === 'current'
            ? (() => {
                const env = (state.environments || []).find(e => e.id === state.activeEnvironmentId);
                return env ? ' in ' + env.name : '';
            })()
            : '';
        el.textContent = visibleCount === scopeCount
            ? scopeCount + ' ' + noun + within
            : visibleCount + ' of ' + scopeCount + ' ' + noun + within;
        // Only the newest are listed until a search, or Show all, brings the rest
        const total = typeof state.transactionsTotal === 'number' ? state.transactionsTotal : 0;
        const listed = (state.transactions || []).length;
        if (!wantsAll() && total > listed) {
            el.textContent += ' · the newest ' + listed.toLocaleString() + ' of ' + total.toLocaleString() + ' runs';
            const all = document.createElement('button');
            all.type = 'button';
            all.className = 'transactions-show-all';
            all.textContent = 'Show all';
            all.title = 'List every run. A search always looks through every run.';
            all.addEventListener('click', () => { showAll = true; render(host.getState()); });
            el.append(' ', all);
        } else if (wantsAll() && total > listed && !allRuns) {
            el.textContent += ' · reading every run…';
        }
    }

    function groupTransactions(transactions, groupBy, state) {
        switch (groupBy) {
            case 'endpoint':    return groupByEndpoint(transactions);
            case 'environment': return groupByEnv(transactions);
            case 'status':      return groupByStatus(transactions);
            case 'date':
            default:            return groupByDate(transactions);
        }
    }

    function groupByDate(transactions) {
        const today = startOfDay(new Date());
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 7);
        const buckets = new Map();
        const ORDER = ['Today', 'Yesterday', 'This week', 'Older'];
        ORDER.forEach(label => buckets.set(label, []));
        transactions.forEach(t => {
            const ts = txTimestamp(t);
            if (!ts) { buckets.get('Older').push(t); return; }
            if (ts >= today.getTime())            { buckets.get('Today').push(t); return; }
            if (ts >= yesterday.getTime())        { buckets.get('Yesterday').push(t); return; }
            if (ts >= sevenDaysAgo.getTime())     { buckets.get('This week').push(t); return; }
            buckets.get('Older').push(t);
        });
        const out = [];
        ORDER.forEach(label => {
            const list = buckets.get(label);
            if (list.length === 0) return;
            out.push({ key: label, label, items: sortByCreatedDesc(list), count: list.length });
        });
        return out;
    }

    function groupByEndpoint(transactions) {
        const buckets = new Map();
        transactions.forEach(t => {
            const k = t.endpointName || t.endpointPath || '(unknown)';
            const arr = buckets.get(k) || [];
            arr.push(t);
            buckets.set(k, arr);
        });
        return Array.from(buckets.entries())
            .map(([k, arr]) => ({ key: k, label: k, items: sortByCreatedDesc(arr), count: arr.length }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    function groupByEnv(transactions) {
        const buckets = new Map();
        transactions.forEach(t => {
            const k = t.environment || '(unknown)';
            const arr = buckets.get(k) || [];
            arr.push(t);
            buckets.set(k, arr);
        });
        return Array.from(buckets.entries())
            .map(([k, arr]) => ({ key: k, label: k, items: sortByCreatedDesc(arr), count: arr.length }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    function groupByStatus(transactions) {
        const out = [];
        STATUS_CHIPS.forEach(spec => {
            const arr = transactions.filter(t => String(t.status || '').toLowerCase() === spec.key);
            if (arr.length === 0) return;
            out.push({ key: spec.key, label: spec.label, items: sortByCreatedDesc(arr), count: arr.length });
        });
        return out;
    }

    function sortByCreatedDesc(arr) {
        return arr.slice().sort((a, b) => (txTimestamp(b) || 0) - (txTimestamp(a) || 0));
    }

    function txTimestamp(t) {
        const d = t.completedAt || t.startedAt || t.createdAt;
        if (!d) return 0;
        const ms = (d instanceof Date) ? d.getTime() : Date.parse(d);
        return isNaN(ms) ? 0 : ms;
    }

    function startOfDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function renderGroup(group, state) {
        const wrapper = document.createElement('div');
        wrapper.className = 'catalogue-group depth-0';
        wrapper.style.setProperty('--depth', 0);

        const header = document.createElement('div');
        header.className = 'catalogue-group-header';

        // Group-level checkbox — toggles every member id (Issue #246).
        // The `data-group-ids` attribute is the truth source for
        // `syncGroupCheckboxes()` after row-level toggles.
        const groupIds = group.items.map(t => t.id);
        const selectedInGroup = groupIds.filter(id => selectedIds.has(id)).length;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tx-group-select';
        cb.dataset.groupIds = groupIds.join('|');
        cb.checked = selectedInGroup === groupIds.length && groupIds.length > 0;
        cb.indeterminate = selectedInGroup > 0 && selectedInGroup < groupIds.length;
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => toggleGroupSelection(group.items, cb.checked));
        header.appendChild(cb);

        const labelHtml = document.createElement('span');
        labelHtml.innerHTML = '<span class="catalogue-group-chevron icon" data-icon="chevron-down"></span>' +
            '<span class="catalogue-group-label">' + escapeHtml(group.label) + '</span>';
        header.appendChild(labelHtml);
        wrapper.appendChild(header);

        const body = document.createElement('div');
        body.className = 'catalogue-group-body';
        const bodyInner = document.createElement('div');
        bodyInner.className = 'catalogue-group-body-inner';
        body.appendChild(bodyInner);
        wrapper.appendChild(body);

        group.items.forEach(tx => bodyInner.appendChild(renderTxRow(tx, state)));

        // Only toggle collapse when the click was NOT on the checkbox
        // (its own handler stops propagation, but defend in depth).
        header.addEventListener('click', (e) => {
            if (e.target && (e.target).closest && (e.target).closest('input')) return;
            wrapper.classList.toggle('is-collapsed');
        });
        return wrapper;
    }

    function renderTxRow(tx, state) {
        // Row used to be a <button> so the whole strip was clickable.
        // With a checkbox inside it, a nested interactive control inside
        // a button is invalid HTML — switch to <div role="button"> and
        // wire keyboard handling explicitly.
        const row = document.createElement('div');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const statusBucket = bucketFor(tx.status);
        row.className = 'catalogue-row tx-row tx-' + statusBucket;
        if (tx.id === selectedTxId) row.classList.add('is-selected');
        if (selectedIds.has(tx.id)) row.classList.add('is-bulk-selected');
        row.dataset.txId = tx.id;

        // Row-level select checkbox (Issue #246). Both code paths (clicking
        // the row body or clicking the checkbox itself) funnel through the
        // browser's native toggle: the row click handler synthesises a
        // click on the cb, and the cb's `change` event then drives state.
        // Setting `cb.checked` programmatically from inside the row click
        // didn't trigger a visual repaint reliably in the VS Code webview,
        // so we let the browser do the toggle for us.
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tx-row-select';
        cb.tabIndex = -1;
        cb.checked = selectedIds.has(tx.id);
        // Stop clicks on the checkbox from bubbling into the row's click
        // handler — otherwise a direct cb click would toggle once for the
        // browser default + once again via the row handler.
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
            applyRowSelection(tx.id, row, cb, cb.checked);
        });
        row.appendChild(cb);

        const isBatch = tx.executionType === 'batch';
        // Status as a themed icon on the LEFT, picked via the shared
        // Icons.statusIcon resolver so tab strip + activity drawer + this
        // list all speak the same visual language. Colour comes from
        // `data-bucket` (see hub.css).
        const statusSpec = (window.Icons?.statusIcon)
            ? window.Icons.statusIcon(tx.status)
            : { icon: 'clock', bucket: statusBucket, title: String(tx.status || 'UNKNOWN').toUpperCase() };

        // Method only — BATCH is implied by the tab-icon path and the
        // user explicitly didn't want it cluttering the meta line.
        const methodInfo = tx.endpointMethod || '';
        const httpInfo = tx.httpStatus != null ? String(tx.httpStatus) : '';
        const runTime = tx.runTime != null ? formatDuration(tx.runTime) : '';
        const ago = relativeTime(txTimestamp(tx));
        const envName = tx.environment || '';
        const subParts = [methodInfo, ago, envName, httpInfo, runTime].filter(Boolean).join(' · ');

        // Build the rest of the row via insertAdjacentHTML so we don't
        // wipe the prepended checkbox.
        row.insertAdjacentHTML('beforeend',
            '<span class="tx-status-icon icon" data-icon="' + statusSpec.icon
                + '" data-bucket="' + (statusSpec.bucket || statusBucket) + '"'
                + ' title="' + escapeHtml(statusSpec.title) + '"></span>' +
            '<span class="tx-row-main">' +
                '<span class="catalogue-row-name" title="' + escapeHtml(txTitle(tx)) + '">' + (txTitle(tx) ? marked(txTitle(tx)) : '(unnamed)') + '</span>' +
                '<span class="catalogue-row-path" title="' + escapeHtml(txSubtitle(tx)) + '">' + marked(txSubtitle(tx)) + '</span>' +
            '</span>' +
            '<span class="tx-row-meta">' +
                '<span class="tx-row-sub">' + escapeHtml(subParts) + '</span>' +
            '</span>'
        );

        // Issue #314: right-click → the same actions the Console footer offers for this
        // state (shared rule set), without opening the Console.
        row.addEventListener('contextmenu', (ev) => {
            if (!window.DbmnContextMenu || !window.ExecutionActions) return;
            const actions = window.ExecutionActions.visibleActions(tx.status, isBatch);
            const labels = window.ExecutionActions.LABELS;
            const items = [{ id: 'open', label: 'Open', icon: 'circle-play' }];
            // A batch has a name of its own (a single run is its endpoint's): the one Rename dialog
            if (isBatch) items.push({ id: 'rename', label: 'Rename', icon: 'pencil' });
            if (actions.length) items.push({ separator: true });
            actions.forEach(id => items.push({ id, ...labels[id] }));
            window.DbmnContextMenu.show(ev, items, (action) => {
                if (action === 'open') { open(); return; }
                if (action === 'rename') {
                    window.HubTabs?.askRename?.(txTitle(tx), 100).then(name => { if (name) host.postMessage({ type: 'renameRun', id: tx.id, name }); });
                    return;
                }
                host.postMessage({ type: 'transactionAction', action, id: tx.id, isBatch, status: tx.status });
            });
        });

        const open = () => {
            selectedTxId = tx.id;
            document.querySelectorAll('.tx-row.is-selected').forEach(r => r.classList.remove('is-selected'));
            row.classList.add('is-selected');
            host.postMessage({ type: 'openTransaction', id: tx.id, isBatch });
        };

        // Click rule depends on select mode:
        //   off → single click opens (existing behaviour)
        //   on  → single click toggles selection; double-click opens
        // The double-click sequence fires two single clicks first, so the
        // row's selection state ends up where it started (toggle twice) and
        // the dblclick then opens — net effect: console opens, selection
        // unchanged.
        row.addEventListener('click', (e) => {
            if (selectMode) {
                // Drive the toggle through the native cb so the visual
                // repaints reliably. The cb's `change` handler then runs
                // `applyRowSelection` to sync state + footer.
                cb.click();
                return;
            }
            open();
        });
        row.addEventListener('dblclick', (e) => {
            if (!selectMode) return; // single click already opened
            e.preventDefault();
            open();
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === ' ') {
                // Space matches checkbox semantics — toggle in select mode,
                // open when not.
                e.preventDefault();
                if (selectMode) {
                    cb.click();
                } else {
                    open();
                }
            } else if (e.key === 'Enter') {
                // Enter always opens — the keyboard equivalent of double-click.
                e.preventDefault();
                open();
            }
        });
        row.title = selectMode
            ? 'Click to select · Double-click to open'
            : '';

        return row;
    }

    // Apply selection state in one place — keeps the checkbox, row class,
    // group-header tri-state, and footer count in lockstep.
    function applyRowSelection(id, rowEl, cb, checked) {
        if (checked) selectedIds.add(id); else selectedIds.delete(id);
        if (cb) cb.checked = checked;
        rowEl?.classList.toggle('is-bulk-selected', checked);
        renderBulkBar();
        syncGroupCheckboxes();
    }

    function bucketFor(status) {
        // Single source of truth — shared Icons.statusIcon resolver
        // returns the bucket the tab strip + activity drawer use, so
        // status → colour stays consistent across the Hub.
        return window.Icons?.statusIcon?.(status)?.bucket || 'pending';
    }

    function formatDuration(ms) {
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return Math.round(ms / 1000) + 's';
    }

    function relativeTime(ms) {
        if (!ms) return '—';
        const diff = Date.now() - ms;
        if (diff < 60_000) return 'just now';
        if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
        if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
        if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago';
        try {
            return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } catch {
            return new Date(ms).toISOString().slice(0, 10);
        }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function clearSelection() {
        selectedTxId = null;
        document.querySelectorAll('.tx-row.is-selected').forEach(r => r.classList.remove('is-selected'));
    }

    window.Transactions = { init, update, applySettings, clearSelection, onContentSearchResult, onHistoryAll, showEndpointHistory };
})();
