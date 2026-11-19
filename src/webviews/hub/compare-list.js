// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's Compare list (#298): the saved compares, newest first. A compare starts in a
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
    /** Every report, the newest first. */
    function reports(state) {
        const when = r => new Date(r.updatedAt || r.comparedAt || r.createdAt).getTime();
        return compares(state).concat(queries(state)).sort((a, b) => when(b) - when(a));
    }
    /** "Inventory + Items + Suppliers": a query's views, in the order joined */
    function joined(q) {
        return q.sources.length ? q.sources.map(s => s.name).join(' + ') : 'no views yet';
    }
    /** "BL SIT 880 9 Nov · C1 SIT 840 8 Nov": each result's environment, header values and day */
    function sides(c) {
        return c.sources.map((s, i) => [letter(i), s.environment].concat((s.header || []).map(h => h.value), [day(s.executedAt)]).join(' ')).join(' · ');
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
        const words = window.SearchWords ? window.SearchWords.parseWords(window.SearchWords.parseQuery(query).text) : null;
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
            '</div>';
        addRow.querySelector('button').addEventListener('click', () => host && host.postMessage({ type: 'newQuery' }));
        list.hidden = all.length === 0;
        list.replaceChildren(addRow, ...shown.map(c => {
            const row = document.createElement('div');
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.className = 'catalogue-row tx-row';
            row.dataset.compareId = c.id;
            row.title = c.isQuery ? 'Edit the query. Right-click to run, duplicate or delete it.' : 'Open its Results. Right-click to edit, duplicate or delete it.';
            const sub = c.isQuery
                ? [typeof c.rows === 'number' ? `${c.rows.toLocaleString()} rows` : 'not run yet', ago(new Date(c.updatedAt || c.createdAt).getTime())].join(' · ')
                : [found(c), ago(new Date(c.comparedAt || c.createdAt).getTime())].join(' · ');
            row.innerHTML =
                '<span class="tx-status-icon icon" data-icon="' + (c.isQuery ? 'blend' : 'scale') + '" title="' + (c.isQuery ? 'Query' : 'Compare') + '"></span>' +
                '<span class="tx-row-main">' +
                    '<span class="catalogue-row-name" title="' + escapeHtml(c.endpointName) + '">' + (c.endpointName ? marked(c.endpointName) : '(unnamed)') + '</span>' +
                    '<span class="catalogue-row-path" title="' + escapeHtml(c.isQuery ? joined(c) : sides(c)) + '">' + marked(c.isQuery ? joined(c) : `${c.endpoint && c.endpoint !== c.endpointName ? c.endpoint + ' · ' : ''}${c.sources[0].view} · ${sides(c)}`) + '</span>' +
                '</span>' +
                '<span class="tx-row-meta"><span class="tx-row-sub">' + escapeHtml(sub) + '</span></span>';
            const open = start => host && host.postMessage({ type: 'openCompare', compareId: c.id, start });
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
                if (ev.key === ' ' && selectMode) { ev.preventDefault(); cb.click(); }
                else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(first); }
            });
            row.addEventListener('contextmenu', ev => {
                if (!window.DbmnContextMenu) return;
                window.DbmnContextMenu.show(ev, (c.isQuery ? [
                    { id: 'edit', label: 'Open', icon: 'circle-play' }
                ] : [
                    { id: 'open', label: 'Open', icon: 'circle-play' }
                ]).concat([
                    { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
                    { separator: true },
                    { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
                ]), action => {
                    if (action === 'open') open('results');
                    else if (action === 'edit') open('edit');
                    else if (action === 'duplicate') host && host.postMessage({ type: 'duplicateCompare', compareId: c.id });
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

    /** #444: does a compare pass the query in the box? */
    function passes(state) {
        const W = window.SearchWords;
        if (!W || !query.trim()) return () => true;
        const q = W.parseQuery(query);
        const words = W.parseWords(q.text);
        const lower = list => list.map(v => String(v).toLowerCase());
        const tags = lower(q.tags);
        const activeEnv = (state.environments || []).find(e => e.id === state.activeEnvironmentId);
        const envs = q.envs.map(v => (v ? v.toLowerCase() : String((activeEnv && activeEnv.name) || '\u0000').toLowerCase()));
        const systems = q.systems.map(v => {
            if (!v) return state.activeSystemId || (activeEnv && activeEnv.systemId) || '\u0000';
            const sys = (state.systems || []).find(x => String(x.name || '').toLowerCase() === v.toLowerCase());
            return sys ? sys.id : '\u0000';
        });
        const date = q.dates[0] || '';
        const since = W.sinceMs(date);
        const range = W.between(date);
        return c => {
            if (q.methods.length && q.methods.indexOf(String(c.method).toUpperCase()) === -1) return false;
            if (tags.length && !lower(c.tags).some(t => tags.indexOf(t) !== -1)) return false;
            if (systems.length && systems.indexOf(c.systemId) === -1) return false;
            if (envs.length && !c.sources.some(src => envs.indexOf(String(src.environment || '').toLowerCase()) !== -1)) return false;
            const when = new Date(c.updatedAt || c.comparedAt || c.createdAt).getTime();
            if (since && !(when >= Date.now() - since)) return false;
            if (range) {
                if (range.from && when < new Date(range.from + 'T00:00:00').getTime()) return false;
                if (range.to && when > new Date(range.to + 'T23:59:59.999').getTime()) return false;
            }
            return W.matches(words, c.isQuery
                ? `${c.endpointName}\nquery\n${joined(c)}\n${c.sources.map(src => src.endpointName).join(' ')}`
                : `${c.endpointName}\n${c.endpoint}\n${c.path}\n${c.method}\n${c.sources[0].view}\n${sides(c)}\n${found(c)}\n${(c.tags || []).join(' ')}`);
        };
    }

    /** What the box suggests: the compares' methods, `#tags`, `@Systems` and `~environments`. */
    function candidates() {
        const state = lastState || {};
        const counts = {};
        const count = (sign, value) => {
            if (!value) return;
            const k = sign + '\u0000' + String(value).toLowerCase();
            if (!counts[k]) counts[k] = { sign, value: String(value), count: 0 };
            counts[k].count++;
        };
        const systemName = new Map((state.systems || []).map(x => [x.id, x.name]));
        compares(state).forEach(c => {
            count('method', String(c.method).toUpperCase());
            new Set(c.tags.map(t => String(t).trim().toLowerCase())).forEach(t => count('#', t));
            count('@', systemName.get(c.systemId));
            new Set(c.sources.map(src => src.environment).filter(Boolean)).forEach(env => count('~', env));
        });
        const out = Object.keys(counts).map(k => counts[k]);
        if (state.activeEnvironmentId) {
            const env = (state.environments || []).find(e => e.id === state.activeEnvironmentId);
            out.push({ sign: '~', value: '', label: 'current environment' + (env ? ': ' + env.name : '') });
            out.push({ sign: '@', value: '', label: 'current System' });
        }
        return out;
    }

    function init(h) {
        host = h;
        const add = document.getElementById('newQueryEmpty');
        if (add) add.addEventListener('click', () => host && host.postMessage({ type: 'newQuery' }));
        const select = document.getElementById('compareSelectMode');
        if (select) select.addEventListener('change', () => { selectMode = select.checked; if (!selectMode) selectedIds.clear(); render(); });
        const bulk = document.getElementById('compareBulkDelete');
        if (bulk) bulk.addEventListener('click', () => void removeSelected());
        const search = document.getElementById('compareSearch');
        if (!search) return;
        if (window.SearchWords) window.SearchWords.attach({ input: search, candidates, onText: text => { query = text; render(); } });
        else search.addEventListener('input', () => { query = search.value; render(); });
    }

    function update(state) {
        lastState = state;
        render();
    }

    window.CompareList = { init, update };
})();
