// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's Compare list (#298): the saved compares, newest first. The Reporting list since:
 * queries too, and the lookup tables a query's Translate values reads (src/screens/lookup). A compare starts in a
 * Console (Compare on the Completed tab) and is saved once Select picks its results
 * (compare-store, state.compares).
 *
 * Click: Open, on Select with its results, key and columns as saved (nothing is read until a
 * later step is asked for). Right-click: Open, Duplicate (a copy to change), Delete (the compare
 * only: results stay in History).
 *
 * #444: the Hub's search, as in Endpoints and History (shared/search-words.js): words in
 * any order, the endpoint's method as a bare word, `#tag`, `@` / `@System`, `~` / `~environment`
 * (any of the compare's results), and `7d` (when it was compared).
 */
(function () {
    'use strict';

    let host = null;
    let query = '';
    let lastState = null;

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function ago(ms) {
        const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} h ago`;
        return `${Math.round(h / 24)} d ago`;
    }
    const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    /** The Baseline is BL; the others are C1, C2, C3. */
    const letter = place => (place === 0 ? 'BL' : `C${place}`);

    /** The compares whose endpoint still exists, under its current name. */
    function compares(state) {
        const byId = new Map((state.endpoints || []).map(e => [e.id, e]));
        return (state.compares || []).filter(c => c.sources && c.sources.length && byId.has(c.sources[0].endpointId)).map(c => {
            const e = byId.get(c.sources[0].endpointId);
            return Object.assign({}, c, { endpointName: c.name || e.name || '', endpoint: e.name || '', path: e.path || '', method: e.method || '', tags: e.tags || [], systemId: e.systemId || '' });
        });
    }
    /** The saved queries, shaped like the compares so one list, one search and one menu serve both. */
    function queries(state) {
        return (state.queries || []).map(q => Object.assign({}, q, {
            isQuery: true, endpointName: q.name || 'Query', path: '', method: '', tags: [], systemId: '',
            sources: (q.sources || []).map(s => Object.assign({}, s, { view: s.name }))
        }));
    }
    /** A query is shown as a query unless it has a Compare join: then it is a compare, with Compare's icon. */
    function asQuery(c) {
        return !!c.isQuery && !(c.joins || []).some(j => j.kind === 'compare');
    }
    /** The lookup tables, shaped like the reports (one list, one search, one Delete). */
    function lookups(state) {
        return (state.lookupTables || []).map(t => ({
            id: t.id, name: t.name, isLookup: true, endpointName: t.name || 'Lookup table', path: '', method: '', tags: [], systemId: '',
            sources: [], columns: t.columns || [], rows: t.rows || 0, updatedAt: t.updatedAt
        }));
    }
    /** Every report and lookup table, the newest first. */
    function reports(state) {
        const when = r => new Date(r.updatedAt || r.comparedAt || r.createdAt).getTime() || 0;
        return compares(state).concat(queries(state), lookups(state)).sort((a, b) => when(b) - when(a));
    }
    /** "code · ERP unit · WMS unit": a lookup table's columns, the key first */
    function lookupColumns(t) {
        const cols = (t.columns || []).slice().sort((a, b) => (b.key ? 1 : 0) - (a.key ? 1 : 0));
        return cols.length ? cols.map(c => c.name).join(' · ') : 'no columns';
    }
    /** "Inventory + Items + Suppliers": a query's views, in the order joined */
    function joined(q) {
        return q.sources.length ? q.sources.map(s => s.name).join(' + ') : 'no views yet';
    }
    /** "BL SIT 880 9 Nov · C1 SIT 840 8 Nov": each result's environment, header values and day */
    function sides(c) {
        return c.sources.map((s, i) => [letter(i), s.environment].concat((s.header || []).map(h => h.value), [day(s.executedAt)]).join(' ')).join(' · ');
    }
    function foundInQuery(f) {
        if (!f.diff && !f.missing) return 'no differences';
        return [f.diff ? `${f.diff.toLocaleString()} DIFF` : '', f.missing ? `${f.missing.toLocaleString()} missing` : ''].filter(Boolean).join(' · ');
    }
    function found(c) {
        if (!c.comparedAt) return 'not compared yet';
        const n = c.counts || {};
        const missing = (n.onlyA || 0) + (n.onlyB || 0) + (n.missing || 0) + (n.notInBaseline || 0);
        if (!n.changed && !missing) return 'no differences';
        return [n.changed ? `${n.changed.toLocaleString()} changed` : '', missing ? `${missing.toLocaleString()} missing` : ''].filter(Boolean).join(' · ');
    }

    async function remove(c) {
        if (!host || !window.DbmnModal) return;
        if (c.isLookup) {
            const yes = await window.DbmnModal.confirm({
                title: 'Delete lookup table',
                body: `Delete the lookup table ${c.endpointName}? A query that uses it can't run until it uses another.`,
                confirmLabel: 'Delete',
                confirmVariant: 'danger'
            });
            if (yes) host.postMessage({ type: 'deleteLookup', id: c.id });
            return;
        }
        const sure = await window.DbmnModal.confirm({
            title: c.isQuery ? 'Delete query' : 'Delete compare',
            body: `Delete the ${c.isQuery ? 'query' : 'compare'} ${c.endpointName}? Only the report is deleted: the data in History stays.`,
            confirmLabel: 'Delete',
            confirmVariant: 'danger'
        });
        if (sure) host.postMessage({ type: 'deleteCompare', compareId: c.id });
    }

    /* ---------- Select, then Delete: as in Endpoints and History ---------- */

    let selectMode = false;
    const selectedIds = new Set();

    function renderBulkBar() {
        const section = document.querySelector('section.hub-section[data-section="compare"]');
        if (section) section.classList.toggle('is-select-mode', selectMode);
        const master = document.getElementById('compareSelectMode');
        if (master && master.checked !== selectMode) master.checked = selectMode;
        const bar = document.getElementById('compareBulkBar');
        const count = document.getElementById('compareBulkCount');
        const del = document.getElementById('compareBulkDelete');
        if (bar) bar.hidden = !selectMode;
        if (count) count.textContent = `${selectedIds.size} selected`;
        if (del) del.disabled = selectedIds.size === 0;
    }

    async function removeSelected() {
        if (!host || !window.DbmnModal || !selectedIds.size) return;
        const n = selectedIds.size;
        const sure = await window.DbmnModal.confirm({
            title: n === 1 ? 'Delete report' : 'Delete reports',
            body: `Delete ${n === 1 ? 'the report selected' : `the ${n} reports selected`}? Only the ${n === 1 ? 'report is' : 'reports are'} deleted: the data in History stays.`,
            confirmLabel: 'Delete',
            confirmVariant: 'danger'
        });
        if (!sure) return;
        host.postMessage({ type: 'deleteCompares', compareIds: Array.from(selectedIds) });
        selectMode = false;
        selectedIds.clear();
        render();
    }

    function render() {
        const list = document.getElementById('compareList');
        const empty = document.getElementById('compareEmpty');
        const summary = document.getElementById('compareSummary');
        if (!list || !empty || !lastState) return;
        const all = reports(lastState);
        const shown = all.filter(passes(lastState));
        const words = window.SearchWords ? window.SearchWords.parseWords(window.SearchWords.parseQuery(query).words) : null;
        const marked = text => (words ? window.SearchWords.highlight(text, words) : escapeHtml(text));
        empty.hidden = all.length > 0;
        if (summary) summary.textContent = all.length ? `${shown.length} report${shown.length === 1 ? '' : 's'}` : '';
        // The add row at the top of the list, the one Endpoints and Environments have
        const addRow = document.createElement('div');
        addRow.className = 'hub-list-row hub-list-row-add hub-add-split';
        addRow.innerHTML =
            '<div class="hub-add-split-group">' +
                '<button type="button" class="hub-add-split-primary" id="newQueryBtn" title="Join results from any endpoints into one table">' +
                    '<span class="icon" data-icon="plus"></span>' +
                    '<span>New Query</span>' +
                '</button>' +
            '</div>' +
            '<div class="hub-add-split-group">' +
                '<button type="button" class="hub-add-split-primary" id="importQueryBtn" title="Paste a query copied with Copy the query (from support, or another computer)">' +
                    '<span class="icon" data-icon="clipboard"></span>' +
                    '<span>Import a query</span>' +
                '</button>' +
            '</div>' +
            '<div class="hub-add-split-group">' +
                '<button type="button" class="hub-add-split-primary" id="newLookupBtn" title="A table of codes and what they stand for, for a query to translate values with">' +
                    '<span class="icon" data-icon="plus"></span>' +
                    '<span>New lookup table</span>' +
                '</button>' +
            '</div>';
        addRow.querySelector('#newQueryBtn').addEventListener('click', () => host && host.postMessage({ type: 'newQuery' }));
        addRow.querySelector('#newLookupBtn').addEventListener('click', () => host && host.postMessage({ type: 'newLookup' }));
        addRow.querySelector('#importQueryBtn').addEventListener('click', () => importQuery());
        list.hidden = all.length === 0;
        list.replaceChildren(addRow, ...shown.map(c => {
            const row = document.createElement('div');
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.className = 'catalogue-row tx-row';
            row.dataset.compareId = c.id;
            row.title = c.isLookup ? 'Edit the lookup table. Right-click to rename, duplicate or delete it.'
                : c.isQuery ? 'Edit the query. Right-click to run, rename, duplicate or delete it.' : 'Open its Results. Right-click to edit, rename, duplicate or delete it.';
            const sub = c.isLookup
                ? [`${c.rows.toLocaleString()} row${c.rows === 1 ? '' : 's'}`, ago(new Date(c.updatedAt).getTime())].join(' · ')
                : c.isQuery
                // (a compare says what it found when Results last counted it: "12 DIFF · 3 missing", "no differences", #11)
                ? [!asQuery(c) && c.found ? foundInQuery(c.found) : typeof c.rows === 'number' ? `${c.rows.toLocaleString()} rows` : 'not run yet', ago(new Date(c.updatedAt || c.createdAt).getTime())].join(' · ')
                : [found(c), ago(new Date(c.comparedAt || c.createdAt).getTime())].join(' · ');
            const glyph = c.isLookup ? 'sheet' : asQuery(c) ? 'blend' : 'scale';
            const kind = c.isLookup ? 'Lookup table' : asQuery(c) ? 'Query' : 'Compare';
            const second = c.isLookup ? lookupColumns(c) : c.isQuery ? joined(c) : null;
            row.innerHTML =
                '<span class="tx-status-icon icon" data-icon="' + glyph + '" title="' + kind + '"></span>' +
                '<span class="tx-row-main">' +
                    '<span class="catalogue-row-name" title="' + escapeHtml(c.endpointName) + '">' + (c.endpointName ? marked(c.endpointName) : '(unnamed)') + '</span>' +
                    '<span class="catalogue-row-path" title="' + escapeHtml(second !== null ? second : sides(c)) + '">' + marked(details(c)) + '</span>' +
                '</span>' +
                '<span class="tx-row-meta"><span class="tx-row-sub">' + escapeHtml(sub) + '</span></span>';
            const open = start => host && host.postMessage(c.isLookup ? { type: 'openLookup', id: c.id } : { type: 'openCompare', compareId: c.id, start });
            // A query always opens on Views, where each view says how old its data is; a compare opens on its Results
            const first = c.isQuery ? 'edit' : 'results';
            // In select mode a click ticks the row and a double-click opens it, as in History
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tx-row-select';
            cb.tabIndex = -1;
            cb.checked = selectedIds.has(c.id);
            cb.setAttribute('aria-label', `Select ${c.endpointName}`);
            cb.addEventListener('click', ev => ev.stopPropagation());
            cb.addEventListener('change', () => {
                if (cb.checked) selectedIds.add(c.id); else selectedIds.delete(c.id);
                row.classList.toggle('is-bulk-selected', cb.checked);
                renderBulkBar();
            });
            row.prepend(cb);
            row.classList.toggle('is-bulk-selected', cb.checked);
            if (selectMode) row.title = 'Click to select · Double-click to open';
            row.addEventListener('click', () => { if (selectMode) cb.click(); else open(first); });
            row.addEventListener('dblclick', ev => { if (selectMode) { ev.preventDefault(); open(first); } });
            row.addEventListener('keydown', ev => {
                if (ev.key === 'F2' && !selectMode) { ev.preventDefault(); rename(c); }
                else if (ev.key === ' ' && selectMode) { ev.preventDefault(); cb.click(); }
                else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(first); }
            });
            row.addEventListener('contextmenu', ev => {
                if (!window.DbmnContextMenu) return;
                window.DbmnContextMenu.show(ev, (c.isQuery || c.isLookup ? [
                    { id: 'edit', label: 'Open', icon: 'circle-play' }
                ] : [
                    { id: 'open', label: 'Open', icon: 'circle-play' }
                ]).concat([
                    { id: 'rename', label: 'Rename', icon: 'pencil' },
                    // (a query copied as text, to send to support or bring to another computer: no rows, nothing secret)
                    ...(c.isQuery ? [{ id: 'copy', label: 'Copy the query', icon: 'clipboard' }] : []),
                    { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
                    { separator: true },
                    { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
                ]), action => {
                    if (action === 'open') open('results');
                    else if (action === 'edit') open('edit');
                    else if (action === 'rename') rename(c);
                    else if (action === 'copy') host && host.postMessage({ type: 'copyQuery', compareId: c.id });
                    else if (action === 'duplicate') host && host.postMessage(c.isLookup ? { type: 'duplicateLookup', id: c.id } : { type: 'duplicateCompare', compareId: c.id });
                    else if (action === 'delete') void remove(c);
                });
            });
            return row;
        }));
        if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(list);
        // A report deleted elsewhere is no longer selected
        const ids = new Set(all.map(c => c.id));
        Array.from(selectedIds).forEach(id => { if (!ids.has(id)) selectedIds.delete(id); });
        renderBulkBar();
    }

    /** Rename a report from the list, open or not (the same dialog as its tab's pencil). */
    function rename(c) {
        if (window.HubTabs && window.HubTabs.renameSavedReport) window.HubTabs.renameSavedReport(c.id, c.name || '');
    }

    /** #444: does a compare pass the query in the box? */
    /** A report's details, as its second line says them: a lookup's columns, a query's views, a compare's View and results. */
    function details(c) {
        return c.isLookup ? lookupColumns(c) : c.isQuery ? joined(c)
            : `${c.endpoint && c.endpoint !== c.endpointName ? c.endpoint + ' · ' : ''}${c.sources[0].view} · ${sides(c)}`;
    }
    /** When a report was last made or changed (what @ran asks). */
    function when(c) {
        const t = new Date(c.updatedAt || c.comparedAt || c.createdAt).getTime();
        return t ? new Date(t).toISOString() : '';
    }
    /**
     * What the search reaches on a report (search-words.js rowTest, the tables' search): its name,
     * kind and details are on the row; the rest is found by @@word or @field.
     */
    function fields(state) {
        const systemName = new Map(((state || {}).systems || []).map(x => [x.id, x.name]));
        const envs = c => Array.from(new Set((c.sources || []).map(src => src.environment).filter(Boolean)));
        return [
            { id: 'name', get: c => c.endpointName || '' },
            { id: 'kind', get: c => (c.isLookup ? 'Lookup table' : asQuery(c) ? 'Query' : 'Compare') },
            { id: 'details', get: details },
            // (a compare's results line: each result's environment, header values and day)
            { id: 'results', get: c => (c.isLookup || c.isQuery ? '' : found(c)) },
            { id: 'endpoint', hidden: true, get: c => (c.isQuery ? (c.sources || []).map(src => src.endpointName).filter(Boolean) : c.endpoint || '') },
            { id: 'method', hidden: true, get: c => (c.method ? String(c.method).toUpperCase() : '') },
            { id: 'path', hidden: true, get: c => c.path || '' },
            { id: 'tag', hidden: true, get: c => (c.tags || []).map(t => String(t).trim()) },
            { id: 'system', hidden: true, get: c => systemName.get(c.systemId) || '' },
            { id: 'env', aliases: ['environment'], hidden: true, get: envs },
            { id: 'view', hidden: true, get: c => (c.sources || []).map(src => src.view).filter(Boolean) },
            { id: 'ran', hidden: true, get: when }
        ];
    }
    /** The current System's and environment's names (what `current` stands for). */
    function current(state) {
        const activeEnv = ((state || {}).environments || []).find(e => e.id === state.activeEnvironmentId);
        const systemId = state.activeSystemId || (activeEnv && activeEnv.systemId);
        const sys = ((state || {}).systems || []).find(x => x.id === systemId);
        return { system: sys ? sys.name : '', env: activeEnv ? activeEnv.name : '' };
    }
    function passes(state) {
        const W = window.SearchWords;
        if (!W || !query.trim()) return () => true;
        return W.rowTest(query, fields(state), current(state));
    }

    /** What `@field=` offers: each field's values, with how many reports have each. */
    function values(heading) {
        const state = lastState || {};
        const field = fields(state).find(f => f.id === String(heading).toLowerCase());
        if (!field) return [];
        const counts = new Map();
        reports(state).forEach(c => {
            const v = field.get(c);
            const list = Array.isArray(v) ? v : [v];
            new Set(list.map(x => String(x || '').trim()).filter(Boolean)).forEach(x => {
                const k = x.toLowerCase();
                const had = counts.get(k);
                counts.set(k, { value: had ? had.value : x, count: (had ? had.count : 0) + 1 });
            });
        });
        const out = Array.from(counts.values());
        const now = current(state);
        if (field.id === 'system' && now.system) out.unshift({ value: 'current', label: 'current System: ' + now.system });
        if (field.id === 'env' && now.env) out.unshift({ value: 'current', label: 'current environment: ' + now.env });
        return field.id === 'ran' ? [] : out;
    }
    /** The box's fields, shown and not, for its colours and `@` list. */
    function boxFields() {
        const all = fields(lastState || {});
        return { headings: all.map(f => f.id), hidden: all.filter(f => f.hidden).map(f => f.id), aliases: all.flatMap(f => f.aliases || []), hiddenAliases: all.filter(f => f.hidden).flatMap(f => f.aliases || []) };
    }

    /** Import a query: paste what Copy the query copied; the host checks it, saves it as a new query and opens it. */
    function importQuery() {
        if (!window.DbmnModal || !host) return;
        window.DbmnModal.show({
            title: 'Import a query',
            body: 'Paste a query copied with Copy the query. Its views read the same runs: a run this computer doesn\'t have says so on its view.',
            fields: [{ id: 'text', type: 'textarea', label: 'The copied query', placeholder: '{ "kind": "dbmn.query", … }', required: true, autoFocus: true }],
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'import', label: 'Import', variant: 'primary' }]
        }).then(result => {
            if (result.actionId !== 'import' || !result.fields || !String(result.fields.text || '').trim()) return;
            host.postMessage({ type: 'importQuery', text: String(result.fields.text) });
        });
    }
    /** The copied query, to the clipboard; where the clipboard is refused, shown to copy by hand. */
    function copied(name, text) {
        const say = msg => { if (window.DbmnToast) window.DbmnToast.info(msg); };
        const byHand = () => window.DbmnModal && window.DbmnModal.show({
            title: `Copy ${name}`,
            body: 'Select all of it and copy it, then paste it into an email or a file.',
            fields: [{ id: 'text', type: 'textarea', label: 'The query', value: text }],
            actions: [{ id: 'ok', label: 'Done', variant: 'primary' }]
        });
        if (!navigator.clipboard || !navigator.clipboard.writeText) { byHand(); return; }
        navigator.clipboard.writeText(text).then(() => say(`Copied ${name}: paste it into an email or a file. No rows or secrets are in it.`), byHand);
    }
    window.addEventListener('message', event => {
        const m = event.data;
        if (m && m.type === 'queryCopy' && typeof m.text === 'string') copied(String(m.name || 'the query'), m.text);
    });

    function init(h) {
        host = h;
        const add = document.getElementById('newQueryEmpty');
        if (add) add.addEventListener('click', () => host && host.postMessage({ type: 'newQuery' }));
        const addLookup = document.getElementById('newLookupEmpty');
        if (addLookup) addLookup.addEventListener('click', () => host && host.postMessage({ type: 'newLookup' }));
        const select = document.getElementById('compareSelectMode');
        if (select) select.addEventListener('change', () => { selectMode = select.checked; if (!selectMode) selectedIds.clear(); render(); });
        const bulk = document.getElementById('compareBulkDelete');
        if (bulk) bulk.addEventListener('click', () => void removeSelected());
        const search = document.getElementById('compareSearch');
        if (!search) return;
        if (window.SearchWords) window.SearchWords.attach({ input: search, fields: boxFields, values, onText: text => { query = text; render(); } });
        else search.addEventListener('input', () => { query = search.value; render(); });
    }

    function update(state) {
        lastState = state;
        render();
    }

    window.CompareList = { init, update };
})();
