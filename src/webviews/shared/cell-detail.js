// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The cell value window (Issue #271), shared by the Console and Compare: one long or structured
 * value in full, with smart, overridable formatting (Auto with nested values expanded, Auto,
 * JSON, Escaped JSON, BASE64, ZPL, Raw) and a copy button. Needs value-formatter.js,
 * dbmn-modal.js, icons.js and dbmn-clipboard.js; its styles are console.css's .cell-detail.
 *
 *   window.CellDetail.open(value, { title })   // title: 'Cell value' unless given
 *   window.CellDetail.worthOpening(value)      // structured (JSON, BASE64, ZPL...), not plain text
 */
(function () {
    'use strict';

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    function worthOpening(value) {
        const VF = window.ValueFormatter;
        const str = value != null ? String(value) : '';
        return !!str && !!VF && VF.detectValueType(str) !== 'text';
    }

    /**
     * JSON coloured as the editor colours it (keys, strings, numbers, true/false/null): the cell window and the
     * transaction window's panes before Monaco (James, 2026-11-25: "syntax highlighting needed here").
     * Anything not JSON, or past 400k characters, stays plain text.
     */
    function tok(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
    function paint(pre, text, language) {
        if (!text) { pre.textContent = ''; return; }
        if (language !== 'json' || text.length > 400000) { pre.textContent = text; return; }
        const out = document.createDocumentFragment();
        const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
        let at = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > at) out.append(document.createTextNode(text.slice(at, m.index)));
            if (m[1]) {
                out.append(tok(m[2] ? 'dbmn-tok-key' : 'dbmn-tok-str', m[1]));
                if (m[2]) out.append(document.createTextNode(m[2]));
            } else if (m[3]) out.append(tok('dbmn-tok-num', m[3]));
            else out.append(tok('dbmn-tok-lit', m[4]));
            at = re.lastIndex;
        }
        if (at < text.length) out.append(document.createTextNode(text.slice(at)));
        pre.replaceChildren(out);
    }

    function open(rawValue, opts) {
        const options = opts || {};
        const VF = window.ValueFormatter;
        const detected = VF ? VF.detectValueType(rawValue) : 'text';

        const body = document.createElement('div');
        body.className = 'cell-detail';

        const toolbar = document.createElement('div');
        toolbar.className = 'cell-detail-toolbar';
        const label = document.createElement('label');
        label.className = 'cell-detail-label';
        label.textContent = 'Format:';
        const select = document.createElement('select');
        select.className = 'cell-detail-select';
        const formats = [
            { id: 'deep', label: `Auto (${detected}, nested expanded)` },
            { id: 'auto', label: `Auto (${detected})` },
            { id: 'json', label: 'JSON' },
            { id: 'escaped-json', label: 'Escaped JSON' },
            { id: 'base64', label: 'BASE64' },
            { id: 'zpl', label: 'ZPL' },
            { id: 'text', label: 'Raw' }
        ];
        for (const f of formats) {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.label;
            select.appendChild(opt);
        }
        select.value = 'deep';

        toolbar.appendChild(label);
        toolbar.appendChild(select);

        const errLine = document.createElement('div');
        errLine.className = 'cell-detail-error';
        errLine.hidden = true;

        // The text sits in a relative wrapper so the copy affordance can
        // float inside its top-right corner (icon-only, reveals on hover).
        const preWrap = document.createElement('div');
        preWrap.className = 'cell-detail-prewrap';
        const pre = document.createElement('pre');
        pre.className = 'cell-detail-pre';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'cell-detail-copy';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy to clipboard';
        copyBtn.setAttribute('aria-label', 'Copy to clipboard');
        const setCopyIcon = (name) => {
            copyBtn.innerHTML = window.Icons.icon(name);
        };
        setCopyIcon('copy');
        preWrap.appendChild(pre);
        preWrap.appendChild(copyBtn);

        const render = () => {
            const res = VF
                ? VF.formatValue(rawValue, select.value)
                : { text: String(rawValue == null ? '' : rawValue), type: 'text' };
            // (coloured when it reads as JSON: Auto, Deep and JSON give JSON; Escaped JSON too once unescaped)
            const json = !res.error && /^\s*[[{]/.test(res.text || '') && ['auto', 'deep', 'json', 'escaped-json'].includes(select.value);
            paint(pre, res.text, json ? 'json' : 'text');
            if (res.error) {
                errLine.innerHTML = window.Icons.label('triangle-alert', escapeHtml(res.error));
                errLine.hidden = false;
            } else {
                errLine.textContent = '';
                errLine.hidden = true;
            }
        };
        select.addEventListener('change', render);
        copyBtn.addEventListener('click', () => {
            const text = pre.textContent || '';
            if (window.DbmnClipboard) {
                window.DbmnClipboard.writeText(text);
            }
            setCopyIcon('check');
            copyBtn.classList.add('is-copied');
            setTimeout(() => { setCopyIcon('copy'); copyBtn.classList.remove('is-copied'); }, 1200);
        });
        render();

        body.appendChild(toolbar);
        body.appendChild(errLine);
        body.appendChild(preWrap);

        if (window.DbmnModal && window.DbmnModal.show) {
            window.DbmnModal.show({
                title: options.title || 'Cell value',
                body,
                size: 'cell-detail',
                dismissible: true,
                // Over a dialog it was opened from (a view's rows): closing it goes back to that one
                over: true,
                // No footer — header ×, Escape, and Ctrl/Cmd+W all close it.
                actions: []
            });
        }
    }

    /**
     * The cell window holding rows, not a value (James, 2026-11-25: "If I hit input rows… I only wanna see the input
     * rows"): the same window, size and keys as open(), with the rows in a searchable <dbmn-table>.
     *   window.CellDetail.openRows({ columns: ['gtin', …], rows: [['0001…', …], …] }, { title: '#001 · Input' });
     */
    function openRows(data, opts) {
        const options = opts || {};
        const columns = data && Array.isArray(data.columns) ? data.columns : [];
        const rows = data && Array.isArray(data.rows) ? data.rows : [];
        const body = document.createElement('div');
        body.className = 'cell-detail cell-detail-rows';
        if (!rows.length || !customElements.get('dbmn-table')) {
            const none = document.createElement('p');
            none.className = 'cell-detail-none';
            none.textContent = rows.length ? `${rows.length} rows` : (options.empty || 'No rows.');
            body.appendChild(none);
        } else {
            const table = document.createElement('dbmn-table');
            table.setAttribute('searchable', '');
            table.setAttribute('label', options.title || 'Rows');
            body.appendChild(table);
            table.columns = columns.map((name, i) => ({ id: String(i), name: String(name) }));
            table.rows = rows.map(row => columns.map((c, i) => String(row[i] ?? '')));
        }
        if (window.DbmnModal && window.DbmnModal.show) {
            window.DbmnModal.show({ title: options.title || 'Rows', body, size: 'cell-detail', dismissible: true, over: true, actions: [] });
        }
    }

    window.CellDetail = { open, openRows, worthOpening, paint };
})();
