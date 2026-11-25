// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-transaction>: one request in full, the same window wherever a request is opened (design system; James,
 * 2026-11-24, the Console and Run Batch mock, #467). The Console's Requests table opens it on a row (View full
 * transaction); Run Batch's Review opens it on a Ready request, before anything is sent. It replaces the request card
 * that was built twice (the Raw tab's card, Review's preview).
 *
 *   <dbmn-transaction window></dbmn-transaction>     `window`: drawn as a window over the screen, ✕ / Esc close it
 *   tx.transaction = {
 *       id, n,                                // its number: "Transaction #002" ("Request #002" with no response yet)
 *       status, http, httpText, timeMs, sent, // the row's figures, as the Requests rows carry them
 *       rowStart, rowEnd,                     // the input rows behind it (1-based)
 *       reason, testFailed,                   // why it is an error; a 2xx failed by the endpoint's own test
 *       method, url, query: [{ name, value }],
 *       requestHeaders: [{ name, value }], responseHeaders: [{ name, value }] | null,
 *       requestBody, responseBody,            // text as sent / received (JSON is shown indented); responseBody
 *                                             // undefined: nothing sent yet (Response greyed out)
 *       contentType,
 *       reprocess: true,                      // offer Reprocess (a failed request that can be tried again)
 *       logs: true,                           // offer Logs
 *       previous: true, next: true            // ↑ ↓ can move
 *   };
 *   tx.input = { columns: ['gtin', …], rows: [['000123…', …], …] };   // its input rows (may come later)
 *   tx.editor = (container, { pane, text, language }) => ({ search(text) {}, dispose() {} }) | null;
 *       // optional: the screen's code editor (Monaco) in a pane (folding, find); null or none: the text as <pre>
 *
 * A response body reads as Raw's card did: JSON Lines as Lines (as received) or Pretty, "RESPONSE (JSONL · n records)";
 * HTML as Raw, Render (its scripts taken out) or Text. A request with no body (a GET) starts with Request off.
 *
 *   dbmn-transaction-move { by: -1 | 1 }  ↑ ↓ or the buttons; the screen gives the next transaction
 *   dbmn-transaction-close                ✕ or Esc (window only)
 *   dbmn-transaction-logs { id }          dbmn-transaction-reprocess { id }
 *   dbmn-transaction-copied { what, ok }  Copy All / a pane's copy (it copies itself, through dbmn-clipboard.js)
 *
 * Every part there is shows side by side (its input rows, the request, the response once sent); ⤢ fills the window
 * with one, and that is how one is looked at alone (James, 2026-11-25: no Show buttons, no Copy All; one line across
 * the top with the search). The panes slide to their new places. Each pane's mode (Body / Details, Body / Headers)
 * and the search stay as they were when it moves to another transaction; Esc puts a filled pane back.
 * Draws in the page (no shadow root); no business logic, no messages. Needs icons.js and dbmn-table.js
 * (dbmn-clipboard.js to copy); styles in transaction-card.css (dbmn-transaction).
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.customElements || customElements.get('dbmn-transaction')) return;

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }
    function iconButton(className, icon, title, text) {
        const b = make('button', className);
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        const glyph = make('span', 'dbmn-tx-glyph');
        glyph.setAttribute('aria-hidden', 'true');
        if (window.Icons) window.Icons.setIcon(glyph, icon);
        b.append(glyph);
        if (text) b.append(make('span', '', text));
        return b;
    }
    const pad = n => String(n ?? '').padStart(3, '0');
    const statusClass = s => ({ completed: 'status-completed', error: 'status-error', test_failed: 'status-test-failed', running: 'status-running',
        split: 'status-split', cancelled: 'status-cancelled' }[s] || 'status-pending');
    const httpClass = code => {
        const c = Number(code);
        if (!c) return 'http-other';
        return c < 300 ? 'http-2xx' : c < 400 ? 'http-3xx' : c < 500 ? 'http-4xx' : 'http-5xx';
    };
    /** JSON shown indented, anything else as it came. */
    function shown(text) {
        if (text === undefined || text === null) return { text: '', language: 'plaintext' };
        const raw = String(text);
        try { return { text: JSON.stringify(JSON.parse(raw), null, 2), language: 'json' }; }
        catch { return { text: raw, language: /^\s*</.test(raw) ? 'html' : 'plaintext' }; }
    }
    /** What a response body is: JSON Lines (its records, its lines), HTML, or anything else; and the ways it reads. */
    function bodyKind(t) {
        const raw = t && t.responseBody !== undefined && t.responseBody !== null ? String(t.responseBody) : '';
        const type = String((t && t.contentType) || '').toLowerCase();
        if (/html/.test(type) || /^\s*<(!doctype|html)/i.test(raw)) return { kind: 'html', formats: [['raw', 'Raw'], ['render', 'Render'], ['text', 'Text']] };
        let whole = true;
        try { JSON.parse(raw); } catch { whole = false; }
        const rows = raw.split(/\r?\n/).filter(l => l.trim());
        if (!whole && rows.length > 1 || /ndjson|jsonl|json-seq/.test(type)) {
            const records = []; let bad = 0;
            rows.forEach(l => { try { records.push(JSON.parse(l)); } catch { bad++; } });
            if (records.length) return { kind: 'jsonl', lines: rows, records, bad, formats: [['lines', 'Lines', 'One record per line, as received'], ['pretty', 'Pretty', 'The records as one indented JSON array']] };
        }
        return { kind: 'other', formats: [] };
    }
    function htmlText(html) { const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('script,style').forEach(n => n.remove()); return (d.textContent || '').replace(/\n\s*\n+/g, '\n\n').trim(); }
    /** JSON coloured as the editor colours it while Monaco is not there (the cell window's painter: one look). */
    function paint(pre, text, language) {
        if (!text) { pre.textContent = '—'; return; }
        if (window.CellDetail && typeof window.CellDetail.paint === 'function') window.CellDetail.paint(pre, text, language);
        else pre.textContent = text;
    }
    const lines = list => (Array.isArray(list) ? list : []).map(h => `${h.name}: ${h.value}`).join('\n');
    function detailsText(t) {
        const query = Array.isArray(t.query) ? t.query : [];
        const parts = [`${t.method || ''} ${t.url || ''}`.trim()];
        if (query.length) parts.push('', 'Query parameters', ...query.map(q => `  ${q.name} = ${q.value}`));
        if (Array.isArray(t.requestHeaders) && t.requestHeaders.length) parts.push('', 'Headers', ...t.requestHeaders.map(h => `  ${h.name}: ${h.value}`));
        return parts.join('\n');
    }

    class DbmnTransaction extends HTMLElement {
        constructor() {
            super();
            this._tx = null;
            this._input = null;
            this._editor = null;
            this._mode = { request: 'body', response: 'body', format: null };   // format: lines/pretty (JSONL), raw/render/text (HTML)
            this._search = '';
            this._max = null;
            this._editors = [];
            this._onKey = e => this._key(e);
            this._onPageKey = e => this._pageKey(e);
        }
        set transaction(t) { this._tx = t || null; this._max = null; this._draw(); }
        get transaction() { return this._tx; }
        set input(i) {
            const had = !!this._inputTable;
            this._input = i || null;
            if (had) this._fillInput(); else this._drawPanes();
        }
        get input() { return this._input; }
        set editor(fn) { this._editor = typeof fn === 'function' ? fn : null; this._draw(); }
        /** The screen's editor has become ready: the panes drawn again in it (what is shown and the search kept). */
        refreshEditors() { this._drawPanes(); }

        connectedCallback() {
            this.setAttribute('role', this.hasAttribute('window') ? 'dialog' : 'region');
            this.setAttribute('aria-label', 'Transaction');
            if (!this.hasAttribute('tabindex')) this.tabIndex = -1;
            this.addEventListener('keydown', this._onKey);
            // As a window, Esc from anywhere on the page: focus is often left on the row clicked to open it, or on the
            // page after a redraw, and the window's own keydown never heard it (Esc failed 18 times in 20, 2026-11-25)
            if (this.hasAttribute('window')) document.addEventListener('keydown', this._onPageKey, true);
            this._backdropFor();
            this._draw();
        }
        disconnectedCallback() {
            this.removeEventListener('keydown', this._onKey);
            document.removeEventListener('keydown', this._onPageKey, true);
            this._dropEditors();
            this._backdropFor(true);
        }

        /**
         * As a window it is a modal (James, 2026-11-25: "modal has gotta be a modal and block all the under buttons"):
         * a dim layer over the whole page, its footer too, takes every click outside the window and closes it, as the
         * app's other windows do. Gone with the window (removed, or no longer a window).
         */
        _backdropFor(gone) {
            const want = !gone && this.isConnected && this.hasAttribute('window');
            if (!want) { if (this._backdrop) { this._backdrop.remove(); this._backdrop = null; } return; }
            if (this._backdrop && this._backdrop.isConnected) return;
            this._backdrop = make('div', 'dbmn-tx-backdrop');
            this._backdrop.setAttribute('aria-hidden', 'true');
            this._backdrop.addEventListener('mousedown', e => e.preventDefault());
            this._backdrop.addEventListener('click', () => this._say('dbmn-transaction-close'));
            this.before(this._backdrop);
        }

        /** Focus inside the window (a button about to be drawn again)? Then it stays in the window, so Esc and ↑ ↓
            still reach it (a redrawn button takes focus away to the page: Esc did nothing after a Show toggle). */
        _holdsFocus() { const a = document.activeElement; return !!a && a !== this && this.contains(a); }
        _keepFocus(had) { if (had && !this.contains(document.activeElement)) this.focus({ preventScroll: true }); }
        _say(type, detail) { this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: detail || {} })); }
        get _sent() { return !!this._tx && this._tx.responseBody !== undefined; }
        /** Every part there is, side by side (James, 2026-11-25: no Show buttons; ⤢ zooms one, and that hides the
            others): its input rows when it has any, the request, the response once it is sent. */
        _showing(part) {
            if (!this._tx) return false;
            if (part === 'response') return this._sent;
            if (part === 'input') return !!(this._input && Array.isArray(this._input.rows) && this._input.rows.length) || !!this._tx.rowStart;
            return true;
        }

        /**
         * Esc, heard on the page before anything else while this is a window: a full-window pane goes back first (the
         * docs say so), then the window closes. Not when a window opened over this one has it (a modal, a cell's detail:
         * Esc closes the one on top), nor in the editor's own find box (Esc closes that first).
         */
        _pageKey(e) {
            if (e.key !== 'Escape' || !this.isConnected || !this.hasAttribute('window')) return;
            const at = e.target && e.target.closest ? e.target : null;
            if (at && !this.contains(at) && at.closest('[role="dialog"], [aria-modal="true"]')) return;
            if (at && at.closest('.find-widget')) return;
            if (document.querySelector('[aria-modal="true"]:not(dbmn-transaction)')) return;
            e.preventDefault();
            e.stopPropagation();
            if (this._max) { this._zoom(null); return; }
            this._say('dbmn-transaction-close');
        }

        _key(e) {
            const typing = e.target && (e.target.closest('input, textarea, select, [contenteditable="true"]') || e.target.closest('.dbmn-tx-editor'));
            if (e.key === 'Escape') {
                // (a window hears Esc on the page: _pageKey)
                if (this.hasAttribute('window')) return;
                if (this._max) { this._zoom(null); e.stopPropagation(); }
                return;
            }
            // (Tab stays in the window: it never walks out to the page's buttons under it)
            if (e.key === 'Tab' && this.hasAttribute('window')) {
                const stops = [...this.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
                if (stops.length) {
                    const at = stops.indexOf(document.activeElement);
                    const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === -1 || at === stops.length - 1 ? 0 : at + 1);
                    if ((e.shiftKey && at <= 0) || (!e.shiftKey && (at === -1 || at === stops.length - 1))) { e.preventDefault(); stops[next].focus(); }
                }
                return;
            }
            if (typing) return;
            if (e.key === 'ArrowUp' && this._tx && this._tx.previous) { e.preventDefault(); this._say('dbmn-transaction-move', { by: -1 }); }
            if (e.key === 'ArrowDown' && this._tx && this._tx.next) { e.preventDefault(); this._say('dbmn-transaction-move', { by: 1 }); }
        }

        _draw() {
            if (!this.isConnected) return;
            const had = this._holdsFocus() || document.activeElement === this;
            this._dropEditors();
            this.replaceChildren();
            const t = this._tx;
            if (!t) return;
            this.append(this._header(t));
            if (t.reason) {
                const why = make('div', 'raw-card-reason dbmn-tx-reason' + (t.testFailed ? ' raw-card-reason-test' : ''));
                const mark = make('span', 'dbmn-tx-glyph');
                if (window.Icons) window.Icons.setIcon(mark, 'triangle-alert');
                why.append(mark, make('span', 'raw-card-reason-text', t.reason));
                if (t.testFailed && t.http) why.append(make('span', 'raw-card-reason-note', `The server answered ${t.http}; this result comes from the endpoint's test.`));
                this.append(why);
            }
            this._panesEl = make('div', 'dbmn-tx-panes');
            this.append(this._panesEl);
            this._drawPanes();
            this._keepFocus(had);
        }

        _header(t) {
            const head = make('div', 'dbmn-tx-head');
            head.append(make('b', 'dbmn-tx-title', `${this._sent ? 'Transaction' : 'Request'} #${pad(t.n)}`));
            const st = t.testFailed ? 'test_failed' : (t.status || 'ready');
            head.append(make('span', `raw-status-badge ${statusClass(st)}`, st === 'test_failed' ? 'TEST FAILED' : String(st).toUpperCase()));
            if (t.http) {
                const http = make('span', `raw-http-status ${httpClass(t.http)}`, String(t.http));
                if (t.httpText) http.title = t.httpText;
                head.append(http);
            }
            const facts = [];
            if (t.timeMs !== undefined && t.timeMs !== null) facts.push(`${t.timeMs}ms`);
            if (t.sent) facts.push(t.sent);
            if (t.rowStart) facts.push(`input rows ${Number(t.rowStart).toLocaleString()}–${Number(t.rowEnd || t.rowStart).toLocaleString()}`);
            if (!this._sent && t.method) facts.push(`${t.method} ${t.url || ''}`.trim());
            const said = make('span', 'dbmn-tx-facts', facts.join(' · '));
            said.title = facts.join(' · ');
            head.append(said);
            head.append(make('span', 'dbmn-tx-spacer'));
            // (the search, on the same one line: what it finds is marked in every pane)
            const find = make('input', 'dbmn-modal-input dbmn-tx-search');
            find.type = 'search';
            find.placeholder = 'Search this transaction…';
            find.setAttribute('aria-label', 'Search this transaction');
            find.value = this._search;
            find.addEventListener('input', () => { this._search = find.value; this._searchPanes(); });
            this._foundEl = make('span', 'dbmn-tx-found');
            this._foundEl.setAttribute('role', 'status');
            head.append(find, this._foundEl);
            const nav = make('span', 'dbmn-tx-nav');
            const up = iconButton('dbmn-tx-btn dbmn-tx-prev', 'chevron-up', 'Previous request (↑)');
            const down = iconButton('dbmn-tx-btn dbmn-tx-next', 'chevron-down', 'Next request (↓)');
            up.disabled = !t.previous;
            down.disabled = !t.next;
            up.addEventListener('click', () => this._say('dbmn-transaction-move', { by: -1 }));
            down.addEventListener('click', () => this._say('dbmn-transaction-move', { by: 1 }));
            nav.append(up, down);
            head.append(nav);
            if (t.reprocess) {
                const b = iconButton('btn btn-secondary dbmn-tx-action dbmn-tx-reprocess', 'refresh-cw', 'Reprocess this request', 'Reprocess');
                b.addEventListener('click', () => this._say('dbmn-transaction-reprocess', { id: t.id }));
                head.append(b);
            }
            if (t.logs) {
                const b = iconButton('btn btn-secondary dbmn-tx-action dbmn-tx-logs', 'scroll-text', 'This request\'s logs', 'Logs');
                b.addEventListener('click', () => this._say('dbmn-transaction-logs', { id: t.id }));
                head.append(b);
            }
            if (this.hasAttribute('window')) {
                const x = iconButton('dbmn-tx-btn dbmn-tx-close', 'x', 'Close (Esc)');
                x.addEventListener('click', () => this._say('dbmn-transaction-close'));
                head.append(x);
            }
            return head;
        }

        _drawPanes() {
            const box = this._panesEl;
            if (!box || !this._tx) return;
            const had = this._holdsFocus();
            this._dropEditors();
            box.replaceChildren();
            box.classList.toggle('has-max', !!this._max);
            const t = this._tx;
            if (this._showing('input')) {
                const pane = this._pane('input', 'INPUT', null);
                const table = document.createElement('dbmn-table');
                table.className = 'dbmn-tx-input';
                table.setAttribute('label', 'Input rows');
                pane.append(table);
                box.append(pane);
                this._inputTable = table;
                this._fillInput();
            } else {
                this._inputTable = null;
            }
            if (this._showing('request')) {
                const details = this._mode.request === 'details' || !t.requestBody;
                const body = details ? { text: detailsText(t), language: 'plaintext' } : shown(t.requestBody);
                box.append(this._pane('request', 'REQUEST', t.requestBody ? [['body', 'Body'], ['details', 'Details']] : null, body));
            }
            if (this._showing('response')) {
                const headers = this._mode.response === 'headers';
                const kind = bodyKind(t);
                const fmt = this._mode.format && kind.formats.some(f => f[0] === this._mode.format) ? this._mode.format : (kind.formats[0] || [])[0];
                let body;
                if (headers) body = { text: lines(t.responseHeaders), language: 'plaintext' };
                else if (kind.kind === 'jsonl') body = fmt === 'pretty' ? { text: JSON.stringify(kind.records, null, 2), language: 'json' } : { text: kind.lines.join('\n'), language: 'plaintext' };
                else if (kind.kind === 'html') body = fmt === 'render' ? { html: String(t.responseBody), text: String(t.responseBody) } : fmt === 'text' ? { text: htmlText(String(t.responseBody)), language: 'plaintext' } : { text: String(t.responseBody), language: 'html' };
                else body = shown(t.responseBody);
                const modes = Array.isArray(t.responseHeaders) && t.responseHeaders.length ? [['body', 'Body'], ['headers', `Headers (${t.responseHeaders.length})`]] : null;
                const title = kind.kind === 'jsonl' ? `RESPONSE (JSONL · ${kind.records.length.toLocaleString()} record${kind.records.length === 1 ? '' : 's'}${kind.bad ? ` · ${kind.bad.toLocaleString()} line${kind.bad === 1 ? '' : 's'} not JSON` : ''})` : 'RESPONSE';
                box.append(this._pane('response', title, modes, body, headers ? null : kind.formats, fmt));
            }
            if (!box.children.length) box.append(make('p', 'dbmn-tx-none', 'Nothing shown: pick Input, Request or Response above.'));
            this._searchPanes();
            this._keepFocus(had);
        }

        _pane(part, title, modes, body, formats, format) {
            const pane = make('section', 'dbmn-tx-pane' + (this._max === part ? ' is-max' : ''));
            pane.dataset.part = part;
            if (this._max && this._max !== part) pane.hidden = true;
            const head = make('div', 'dbmn-tx-pane-head');
            head.append(make('b', 'dbmn-tx-pane-title', title));
            if (part === 'input') {
                const n = this._input && Array.isArray(this._input.rows) ? this._input.rows.length : null;
                if (n !== null) head.append(make('span', 'dbmn-tx-pane-note', `${n.toLocaleString()} row${n === 1 ? '' : 's'}`));
            }
            if (modes) {
                const seg = make('span', 'raw-view-mode-group dbmn-tx-modes');
                modes.forEach(([mode, label]) => {
                    const b = make('button', 'raw-view-mode-btn' + (this._mode[part] === mode ? ' active' : ''), label);
                    b.type = 'button';
                    b.dataset.mode = mode;
                    b.setAttribute('aria-pressed', String(this._mode[part] === mode));
                    b.addEventListener('click', () => { this._mode[part] = mode; this._drawPanes(); });
                    seg.append(b);
                });
                head.append(seg);
            }
            // (how the body reads: Lines / Pretty for JSON Lines, Raw / Render / Text for HTML, as Raw's card)
            if (formats && formats.length) {
                const seg = make('span', 'raw-view-mode-group dbmn-tx-formats');
                formats.forEach(([id, label, hint]) => {
                    const b = make('button', 'raw-view-mode-btn' + (format === id ? ' active' : ''), label);
                    b.type = 'button';
                    b.dataset.format = id;
                    if (hint) b.title = hint;
                    b.setAttribute('aria-pressed', String(format === id));
                    b.addEventListener('click', () => { this._mode.format = id; this._drawPanes(); });
                    seg.append(b);
                });
                head.append(seg);
            }
            head.append(make('span', 'dbmn-tx-spacer'));
            if (body) {
                const copy = iconButton('dbmn-tx-btn dbmn-tx-copy', 'copy', `Copy the ${title.toLowerCase()}`);
                copy.addEventListener('click', () => this._copy(part, body.text));
                head.append(copy);
            }
            const max = iconButton('dbmn-tx-btn dbmn-tx-max', this._max === part ? 'minimize-2' : 'maximize-2', this._max === part ? 'Put it back (Esc)' : 'Fill the window');
            max.setAttribute('aria-pressed', String(this._max === part));
            // (focus kept on the window: the panes are drawn again, and Esc must still reach it)
            max.addEventListener('click', () => this._zoom(this._max === part ? null : part));
            head.append(max);
            pane.append(head);
            if (body) {
                const holder = make('div', 'dbmn-tx-editor');
                const ed = !body.html && this._editor ? this._editor(holder, { pane: part, text: body.text, language: body.language }) : null;
                if (body.html) {
                    // (rendered as the page would show it, its scripts taken out, in its own shadow root)
                    const view = make('div', 'dbmn-tx-render');
                    const shadow = view.attachShadow({ mode: 'open' });
                    shadow.innerHTML = '<style>:host{display:block;padding:12px;color:inherit}*{background:transparent!important;color:inherit!important}img{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid rgba(128,128,128,.4);padding:4px 8px}</style>' + body.html;
                    shadow.querySelectorAll('script').forEach(n => n.remove());
                    holder.append(view);
                } else if (ed) {
                    this._editors.push(ed);
                    holder._dbmnEditor = ed;
                    holder.dataset.editor = 'monaco';
                } else {
                    holder.dataset.editor = 'text';
                    const pre = make('pre', 'dbmn-tx-code');
                    pre.dataset.language = body.language;
                    pre._dbmnText = body.text;
                    paint(pre, body.text, body.language);
                    holder.append(pre);
                }
                pane.append(holder);
            }
            return pane;
        }

        /**
         * One part fills the window (⤢), or they go back side by side: the panes move to their new places, not jump
         * (James, 2026-11-25: "animate that at least a little bit"). Each pane slides and grows from where it was.
         */
        _zoom(part) {
            const before = new Map();
            (this._panesEl ? [...this._panesEl.querySelectorAll('.dbmn-tx-pane:not([hidden])')] : []).forEach(el => before.set(el.dataset.part, el.getBoundingClientRect()));
            this._max = part;
            this._drawPanes();
            if (!this._panesEl || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
            this._panesEl.querySelectorAll('.dbmn-tx-pane:not([hidden])').forEach(el => {
                const was = before.get(el.dataset.part);
                const now = el.getBoundingClientRect();
                if (!was || !now.width || typeof el.animate !== 'function') return;
                const dx = was.left - now.left, dy = was.top - now.top, sx = was.width / now.width, sy = was.height / now.height;
                el.animate([
                    { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.85 },
                    { transformOrigin: 'top left', transform: 'none', opacity: 1 }
                ], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
            });
        }

        _fillInput() {
            const table = this._inputTable;
            const got = this._input;
            if (!table || !got) return;
            const columns = Array.isArray(got.columns) ? got.columns : [];
            table.columns = columns.map((name, i) => ({ id: String(i), name: String(name) }));
            table.rows = (got.rows || []).map(row => columns.map((c, i) => String(row[i] ?? '')));
            if (this._search) table.search = this._search;
        }

        /** The search marked in each pane (or given to the screen's editor), and how many it found. */
        _searchPanes() {
            const needle = this._search.trim().toLowerCase();
            let found = 0;
            (this._panesEl ? this._panesEl.querySelectorAll('.dbmn-tx-editor') : []).forEach(holder => {
                if (holder._dbmnEditor) { if (holder._dbmnEditor.search) holder._dbmnEditor.search(this._search); return; }
                const pre = holder.querySelector('pre');
                if (!pre) return;
                const text = pre._dbmnText || '';
                if (!needle) { paint(pre, text, pre.dataset.language); return; }
                const low = text.toLowerCase();
                const parts = [];
                let at = 0;
                for (let i = low.indexOf(needle); i !== -1 && found < 5000; i = low.indexOf(needle, i + needle.length)) {
                    parts.push(document.createTextNode(text.slice(at, i)), make('mark', 'dbmn-tx-hit', text.slice(i, i + needle.length)));
                    at = i + needle.length;
                    found++;
                }
                parts.push(document.createTextNode(text.slice(at)));
                pre.replaceChildren(...parts);
            });
            if (this._inputTable) this._inputTable.search = this._search;
            if (this._foundEl) this._foundEl.textContent = needle && !this._editor ? `${found.toLocaleString()} found` : '';
            const first = this._panesEl && this._panesEl.querySelector('mark.dbmn-tx-hit');
            if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
        }

        _copy(what, text) {
            const t = this._tx;
            if (what === 'all') {
                const req = t.requestBody ? shown(t.requestBody).text : '';
                text = [detailsText(t), req, this._sent ? `\nResponse ${t.http || ''}\n${lines(t.responseHeaders)}\n\n${shown(t.responseBody).text}` : ''].filter(Boolean).join('\n\n');
            }
            const done = ok => this._say('dbmn-transaction-copied', { what, ok: !!ok });
            if (window.DbmnClipboard && window.DbmnClipboard.writeText) Promise.resolve(window.DbmnClipboard.writeText(text)).then(done, () => done(false));
            else done(false);
        }

        _dropEditors() {
            this._editors.forEach(ed => { try { if (ed && ed.dispose) ed.dispose(); } catch { /* the editor is gone */ } });
            this._editors = [];
        }
    }
    customElements.define('dbmn-transaction', DbmnTransaction);
})();
