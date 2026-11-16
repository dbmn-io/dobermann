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
            return Object.assign({}, c, { endpointName: e.name || '', path: e.path || '', method: e.method || '', tags: e.tags || [], systemId: e.systemId || '' });
        });
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
            title: 'Delete compare',
            body: `Delete this compare of ${c.endpointName || 'the endpoint'}? Its results stay in History.`,
            confirmLabel: 'Delete',
            confirmVariant: 'danger'
        });
        if (sure) host.postMessage({ type: 'deleteCompare', compareId: c.id });
    }

    function render() {
        const list = document.getElementById('compareList');
        const empty = document.getElementById('compareEmpty');
        const summary = document.getElementById('compareSummary');
        if (!list || !empty || !lastState) return;
        const all = compares(lastState);
        const shown = all.filter(passes(lastState));
        const words = window.SearchWords ? window.SearchWords.parseWords(window.SearchWords.parseQuery(query).text) : null;
        const marked = text => (words ? window.SearchWords.highlight(text, words) : escapeHtml(text));
        empty.hidden = all.length > 0;
        if (summary) summary.textContent = all.length ? `${shown.length} compare${shown.length === 1 ? '' : 's'}` : '';
        list.replaceChildren(...shown.map(c => {
            const row = document.createElement('div');
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.className = 'catalogue-row tx-row';
            row.dataset.compareId = c.id;
            row.title = 'Open its Results. Right-click to edit, duplicate or delete it.';
            const sub = [found(c), ago(new Date(c.comparedAt || c.createdAt).getTime())].join(' · ');
            row.innerHTML =
                '<span class="tx-status-icon icon" data-icon="scale" title="Compare"></span>' +
                '<span class="tx-row-main">' +
                    '<span class="catalogue-row-name" title="' + escapeHtml(c.endpointName) + '">' + (c.endpointName ? marked(c.endpointName) : '(unnamed)') + '</span>' +
                    '<span class="catalogue-row-path" title="' + escapeHtml(sides(c)) + '">' + marked(`${c.sources[0].view} · ${sides(c)}`) + '</span>' +
                '</span>' +
                '<span class="tx-row-meta"><span class="tx-row-sub">' + escapeHtml(sub) + '</span></span>';
            const open = start => host && host.postMessage({ type: 'openCompare', compareId: c.id, start });
            row.addEventListener('click', () => open('results'));
            row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open('results'); } });
            row.addEventListener('contextmenu', ev => {
                if (!window.DbmnContextMenu) return;
                window.DbmnContextMenu.show(ev, [
                    { id: 'open', label: 'Open', icon: 'circle-play' },
                    { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
                    { separator: true },
                    { id: 'delete', label: 'Delete', icon: 'trash-2', danger: true }
                ], action => {
                    if (action === 'open') open('results');
                    else if (action === 'duplicate') host && host.postMessage({ type: 'duplicateCompare', compareId: c.id });
                    else if (action === 'delete') void remove(c);
                });
            });
            return row;
        }));
        if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(list);
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
            const when = new Date(c.comparedAt || c.createdAt).getTime();
            if (since && !(when >= Date.now() - since)) return false;
            if (range) {
                if (range.from && when < new Date(range.from + 'T00:00:00').getTime()) return false;
                if (range.to && when > new Date(range.to + 'T23:59:59.999').getTime()) return false;
            }
            return W.matches(words, `${c.endpointName}\n${c.path}\n${c.method}\n${c.sources[0].view}\n${sides(c)}\n${found(c)}\n${(c.tags || []).join(' ')}`);
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
