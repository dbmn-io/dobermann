// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnRequests: a run's requests as one table, a row per request (#466; James, 2026-11-24: "Requests makes more
 * sense… When we're in the review we're showing the request tab and then when you start executing you see the
 * same request tab there"). The same piece in the Console's Requests tab and in Run Batch's Review (Ready rows
 * from the batch plan). A shared module, not a component: it talks to the host, a page at a time.
 *
 *   const requests = DbmnRequests.mount(container, {
 *       post: message => vscode.postMessage(message),   // to the host (console.controller / run-batch.controller)
 *       input: row => ({ columns, rows }) | null,        // its input rows, when the page holds them (else the detail's)
 *       logs: row => …,  reprocess: row => …,            // offered in the menu and the window when given
 *       canReprocess: row => boolean,                    // which rows offer Reprocess (default: a failed one)
 *       counts: ({ total, counts }) => …,                // the host's counts as they come (a tab's count)
 *       label: 'Requests'
 *   });
 *   requests.shown(true | false)   // on screen or not: off screen the host tells no reloads
 *   requests.open(index)           // the request at this place, in the transaction window
 *
 * Host messages (src/screens/console/requests):
 *   → console.requests.page { seq, offset, limit, search, sort, columns, statuses }   ← console.requests.rows
 *   → console.requests.detail { seq, id }                                              ← console.requests.detail
 *   → console.requests.counts {}   ← console.requests.counts { total, counts }   (the Status filter's counts)
 *   → console.requests.shown { shown }      ← console.requests.changed { total, counts }: the table asks again
 * Clicks: a plain cell opens the shared transaction window (<dbmn-transaction window>); a Request, Response or
 * Input rows cell opens just that piece in the cell window. Right-click: View full transaction, then what was given.
 * Only what it is given: no ids outside its container, so it moves as one line.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.DbmnRequests) return;

    const pad = n => String(n ?? '').padStart(3, '0');
    const FAILED = new Set(['error', 'test_failed', 'cancelled']);
    const STATUS_LABEL = { ready: 'Ready', pending: 'Pending', running: 'Running', completed: 'Completed', error: 'Error', test_failed: 'Test failed', cancelled: 'Cancelled', split: 'Split' };
    /** Where a cell's click goes: its piece in the cell window; any other opens the transaction. */
    const PIECES = { request: 'Request', response: 'Response', rowStart: 'Input' };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }
    function badge(status) {
        return el('span', `raw-status-badge status-${String(status || 'pending').replace(/_/g, '-')}`, STATUS_LABEL[status] || status || 'Pending');
    }
    function httpBadge(code) {
        if (code === null || code === undefined || code === '') return el('span', 'requests-none', '—');
        const c = Number(code);
        const tone = !c ? 'http-other' : c < 300 ? 'http-2xx' : c < 400 ? 'http-3xx' : c < 500 ? 'http-4xx' : 'http-5xx';
        return el('span', `raw-http-status ${tone}`, String(code));
    }
    function body(summary) {
        if (!summary) return el('span', 'requests-none', '—');
        const wrap = el('span', 'requests-body');
        wrap.append(el('span', 'requests-preview', summary.preview || '(no body)'));
        if (summary.items !== null && summary.items !== undefined) wrap.append(el('span', 'requests-items', `${summary.items.toLocaleString()} item${summary.items === 1 ? '' : 's'}`));
        return wrap;
    }
    const sentAt = iso => {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    };
    const time = ms => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
    const headers = id => ({ noun: 'header', count: row => (row[id] || []).length, rows: row => (row[id] || []).map(h => ({ name: h.name, value: h.value })) });

    function mount(container, opts) {
        const o = Object.assign({ label: 'Requests', canReprocess: row => FAILED.has(row.status) }, opts || {});
        const post = message => { if (typeof o.post === 'function') o.post(message); };
        const state = {
            shown: false, seq: 0, waiting: new Map(), details: new Map(),
            /** The rows the table has, by their place in its order (for ↑ ↓ in the transaction window). */
            at: new Map(), total: 0, counts: {}, statuses: null, tx: null, txIndex: -1, txRow: null, txSettled: true
        };

        function statusFilter() {
            const items = Object.keys(state.counts).sort().map(status => ({
                value: status, label: STATUS_LABEL[status] || status, count: state.counts[status],
                on: !state.statuses || state.statuses.includes(status)
            }));
            return items.length ? { label: 'Status', items } : undefined;
        }
        function columns() {
            return [
                { id: 'n', name: '#', render: v => pad(v) },
                { id: 'status', name: 'Status', render: v => badge(v), filter: statusFilter() },
                { id: 'http', name: 'HTTP', render: v => httpBadge(v) },
                { id: 'timeMs', name: 'Time', render: v => time(v) },
                { id: 'sent', name: 'Sent', render: v => sentAt(v) },
                { id: 'rowStart', name: 'Input rows', render: (v, row) => (v === null || v === undefined ? '—' : v === row.rowEnd ? String(v) : `${v}–${row.rowEnd}`) },
                { id: 'request', name: 'Request', render: v => body(v), sortable: false },
                { id: 'response', name: 'Response', render: v => body(v), sortable: false },
                // (no headers yet, a Ready request's response: '—', not the empty list)
                { id: 'requestHeaders', name: 'Request headers', sortable: false, nested: headers('requestHeaders'), render: v => (Array.isArray(v) && v.length ? undefined : '—') },
                { id: 'responseHeaders', name: 'Response headers', sortable: false, nested: headers('responseHeaders'), render: v => (Array.isArray(v) && v.length ? undefined : '—') },
                { id: 'reprocessCount', name: 'Reprocessed', render: v => (v ? String(v) : '') }
            ];
        }

        const table = document.createElement('dbmn-table');
        table.id = o.id || 'requests-table';
        table.className = 'requests-table';
        table.setAttribute('label', o.label);
        table.setAttribute('searchable', '');
        container.appendChild(table);
        table.rowKey = row => row.id;
        table.emptyText = ({ searched }) => (searched ? 'No requests match the search.' : 'No requests yet.');
        table.columns = columns();
        table.source = { total: 0, page: (offset, limit, opt) => askPage(offset, limit, opt) };
        table.addEventListener('dbmn-table-filter', event => {
            if (!event.detail || event.detail.id !== 'status') return;
            state.statuses = Array.isArray(event.detail.values) ? event.detail.values.slice() : null;
            table.columns = columns();
            table.reload();
        });
        table.addEventListener('dbmn-table-row', event => onRowClick(event.detail));
        table.addEventListener('dbmn-table-row-menu', event => { event.preventDefault(); onRowMenu(event.detail); });

        function askPage(offset, limit, opt) {
            return new Promise(resolve => {
                const seq = ++state.seq;
                state.waiting.set(seq, { resolve, offset });
                const shownColumns = (Array.isArray(table.columns) ? table.columns : columns()).map(c => ({ id: c.id, name: c.name, hidden: !!c.hidden }));
                post({ type: 'console.requests.page', seq, offset, limit, search: (opt && opt.search) || '', sort: (opt && opt.sort) || null, columns: shownColumns, statuses: state.statuses });
            });
        }
        function onRows(message) {
            const asked = state.waiting.get(message.seq);
            if (!asked) return;
            state.waiting.delete(message.seq);
            const rows = Array.isArray(message.rows) ? message.rows : [];
            if (asked.offset === 0) state.at.clear();
            rows.forEach((row, i) => state.at.set(asked.offset + i, row));
            state.total = message.total || 0;
            if (message.error && window.DbmnToast) window.DbmnToast.warn(message.error);
            asked.resolve({ rows, total: message.total || 0, of: message.of || 0 });
        }

        /** Which column a click was in (every cell names its column). */
        function cellOf(event) {
            const td = event && event.target && event.target.closest ? event.target.closest('td') : null;
            if (!td) return '';
            if (td.dataset.col) return td.dataset.col;
            const order = table.layout && Array.isArray(table.layout.order) ? table.layout.order : [];
            const tds = Array.from(td.parentElement ? td.parentElement.children : []).filter(c => c.tagName === 'TD');
            return order[tds.indexOf(td)] || '';
        }
        function indexOf(row) {
            for (const [i, r] of state.at) if (r && r.id === row.id) return i;
            return -1;
        }
        function onRowClick(detail) {
            if (!detail || !detail.row) return;
            const piece = PIECES[cellOf(detail.event)];
            if (piece) openPiece(detail.row, piece);
            else openTransaction(detail.row, detail.index ?? indexOf(detail.row));
        }
        function onRowMenu(detail) {
            if (!detail || !detail.row || !window.DbmnContextMenu) return;
            const row = detail.row;
            const items = [{ id: 'open', label: 'View full transaction', icon: 'maximize-2' }];
            if (o.logs) items.push({ id: 'logs', label: 'View logs', icon: 'scroll-text', disabled: !row.hasLogs });
            if (o.reprocess && o.canReprocess(row)) items.push({ separator: true }, { id: 'reprocess', label: 'Reprocess', icon: 'rotate-ccw' });
            window.DbmnContextMenu.show(detail.event, items, id => {
                if (id === 'open') openTransaction(row, detail.index ?? indexOf(row));
                else if (id === 'logs') o.logs(row);
                else if (id === 'reprocess') o.reprocess(row);
            });
        }

        function detailOf(id) {
            return new Promise(resolve => {
                const seq = ++state.seq;
                state.details.set(seq, resolve);
                post({ type: 'console.requests.detail', seq, id });
            });
        }
        async function inputFor(row) {
            const given = typeof o.input === 'function' ? o.input(row) : null;
            if (given) return given;
            const detail = await detailOf(row.id);
            return detail && detail.input ? detail.input : null;
        }

        async function openPiece(row, piece) {
            if (!window.CellDetail) return;
            const title = `#${pad(row.n)} · ${piece}`;
            if (piece === 'Input') {
                const input = await inputFor(row);
                window.CellDetail.open(input ? JSON.stringify(input.rows.map(values => Object.fromEntries(input.columns.map((c, i) => [c, values[i]]))), null, 2) : 'No input rows for this request.', { title });
                return;
            }
            const detail = await detailOf(row.id);
            const text = detail ? (piece === 'Request' ? detail.requestBody : detail.responseBody) : null;
            window.CellDetail.open(text === null || text === undefined ? `No ${piece.toLowerCase()} yet.` : text, { title });
        }

        function windowFor() {
            if (state.tx && document.body.contains(state.tx)) return state.tx;
            const tx = document.createElement('dbmn-transaction');
            tx.setAttribute('window', '');
            tx.addEventListener('dbmn-transaction-close', () => { tx.remove(); state.tx = null; });
            tx.addEventListener('dbmn-transaction-move', event => move(event.detail && event.detail.by));
            // (the request the window holds: one opened from another tab has no place in the table, -1)
            tx.addEventListener('dbmn-transaction-logs', () => { const r = state.txRow || state.at.get(state.txIndex); if (r && o.logs) o.logs(r); });
            tx.addEventListener('dbmn-transaction-reprocess', () => { const r = state.txRow || state.at.get(state.txIndex); if (r && o.reprocess) o.reprocess(r); });
            // (the page's code editor in the panes, when it has one: folding and find, as Raw's card did; plain text
            //  until it has loaded, then drawn again in it)
            if (o.editor) tx.editor = o.editor;
            if (typeof o.whenEditorReady === 'function') o.whenEditorReady(() => { if (state.tx === tx && tx.refreshEditors) tx.refreshEditors(); });
            document.body.appendChild(tx);
            state.tx = tx;
            // (focused, so Esc and ↑ ↓ work at once: its keys are its own)
            setTimeout(() => tx.focus(), 0);
            return tx;
        }
        /** A request still to settle: not finished, or its response not read yet. */
        const SETTLED = new Set(['completed', 'error', 'test_failed', 'cancelled', 'split', 'ready']);
        async function openTransaction(row, index) {
            const tx = windowFor();
            state.txIndex = index;
            state.txRow = row;
            state.txSettled = false;
            const base = {
                // (Sent as the table shows it: the window shows what it is given)
                id: row.id, n: row.n, status: row.status, http: row.http, httpText: row.httpText, timeMs: row.timeMs, sent: row.sent ? sentAt(row.sent) : null,
                rowStart: row.rowStart, rowEnd: row.rowEnd, reason: row.reason, testFailed: row.status === 'test_failed',
                method: row.method, url: row.url, query: Object.entries(row.query || {}).map(([name, value]) => ({ name, value })),
                requestHeaders: row.requestHeaders || [], responseHeaders: row.response ? row.responseHeaders : null,
                contentType: row.response ? row.response.contentType : undefined,
                reprocess: !!o.reprocess && o.canReprocess(row), logs: !!o.logs && !!row.hasLogs,
                previous: index > 0, next: index >= 0 && index < state.total - 1
            };
            // (the window opens at once from the row; the bodies follow)
            tx.transaction = base;
            const given = typeof o.input === 'function' ? o.input(row) : null;
            if (given) tx.input = given;
            const detail = await detailOf(row.id);
            if (!detail || state.txIndex !== index || state.tx !== tx) return;
            if (!given && detail.input) tx.input = detail.input;
            tx.transaction = Object.assign({}, base, {
                requestHeaders: detail.requestHeaders, responseHeaders: row.response || detail.responseBody !== null ? detail.responseHeaders : null,
                requestBody: detail.requestBody, responseBody: detail.responseBody === null ? undefined : detail.responseBody
            });
            // (Ready rows are Review's, never sent from there: settled as they are)
            state.txSettled = row.status === 'ready' || (SETTLED.has(row.status) && detail.responseBody !== null);
            // A finished request whose response isn't in yet (written a moment after it ends): asked again by
            // itself, sooner then slower, for up to ~20 s, as no more word of the run may come
            clearTimeout(state.txRetry);
            if (!state.txSettled && SETTLED.has(row.status) && detail.responseBody === null) {
                const tries = state.txTries = (state.txRowId === row.id ? (state.txTries || 0) : 0) + 1;
                state.txRowId = row.id;
                if (tries <= 6) state.txRetry = setTimeout(() => { refreshing = 0; refreshOpen(); }, Math.min(8000, 500 * 2 ** (tries - 1)));
            } else {
                state.txTries = 0;
            }
        }
        /**
         * The run moved on while a window is open on a request still to settle (a single run's window opens as it
         * starts, before its response is written): the request asked again, and its window drawn from it, what it
         * shows kept. At most once a second.
         */
        let refreshing = 0;
        async function refreshOpen() {
            if (!state.tx || !document.body.contains(state.tx) || state.txSettled || !state.txRow) return;
            const now = Date.now();
            if (now - refreshing < 1000) return;
            refreshing = now;
            const index = state.txIndex;
            let row = state.txRow;
            if (index >= 0) row = (await askPage(index, 1, {})).rows[0] || row;
            if (state.txIndex !== index || !state.tx) return;
            await openTransaction(row, index);
        }
        async function move(by) {
            const next = state.txIndex + (by > 0 ? 1 : -1);
            if (next < 0 || next >= state.total) return;
            let row = state.at.get(next);
            if (!row) row = (await askPage(next, 1, { search: (table.search || '').trim(), sort: null })).rows[0];
            if (row) openTransaction(row, next);
        }

        function setCounts(message) {
            state.total = message.total || 0;
            state.counts = message.counts || {};
            if (typeof o.counts === 'function') o.counts({ total: state.total, counts: state.counts });
            // (the Status filter's counts: its heading drawn again)
            const status = (table.columns || []).find(c => c.id === 'status');
            if (status) { status.filter = statusFilter(); table.redrawHeads(); }
        }

        window.addEventListener('message', event => {
            const message = event.data || {};
            switch (message.type) {
                case 'console.requests.rows': onRows(message); break;
                case 'console.requests.detail': {
                    const resolve = state.details.get(message.seq);
                    if (resolve) { state.details.delete(message.seq); resolve(message.detail || null); }
                    break;
                }
                case 'console.requests.counts': setCounts(message); refreshOpen(); break;
                case 'console.requests.changed':
                    setCounts(message);
                    if (state.shown) table.reload({ keep: true, total: message.total });
                    refreshOpen();
                    break;
                default: break;
            }
        });

        return {
            table, state,
            shown(on) {
                const value = !!on;
                if (state.shown === value) return;
                state.shown = value;
                post({ type: 'console.requests.shown', shown: value });
            },
            open(index) {
                return askPage(index, 1, {}).then(got => { if (got.rows[0]) openTransaction(got.rows[0], index); });
            },
            /** A row the page already holds (seen on another tab), in the window: its bodies from the host; no ↑ ↓. */
            openRow(row) { return openTransaction(row, -1); },
            reload() { table.reload(); }
        };
    }

    window.DbmnRequests = { mount, STATUS_LABEL };
})();
