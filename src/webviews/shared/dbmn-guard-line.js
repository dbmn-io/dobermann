// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-guard-line>: the production guard's line, one component for every window that sends (design system; James,
 * 2026-11-24: "I love that protect warning frequency. As long as that is also there on Run API"). Run Batch's Execute
 * window and Run API's dialog both show it, from the same guard the host works out (production-guard.service.ts,
 * productionGuardFor).
 *
 *   <dbmn-guard-line></dbmn-guard-line>
 *   line.guard = { environment, line, ask, frequency, confirmLabel };   // null: draws nothing
 *   line.minutes      // what was picked in Warning frequency (0: warn every time), or null when nothing was asked
 *
 * guard.frequency: { label: 'Warning frequency', value: '0', options: [{ value: '0' | '15' | '30' | '60', label }] }.
 * With guard.ask false (a frequency picked earlier still runs), the line shows and nothing is asked.
 * It draws only: the window sends { production: { minutes } } with its confirm when line.minutes is not null.
 * In the page (no shadow root); styles in modals.css (dbmn-guard-line).
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.customElements || customElements.get('dbmn-guard-line')) return;

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    class DbmnGuardLine extends HTMLElement {
        constructor() {
            super();
            this._guard = null;
            this._select = null;
        }
        set guard(g) { this._guard = g || null; this._draw(); }
        get guard() { return this._guard; }
        get minutes() { return this._select ? Number(this._select.value) || 0 : null; }
        connectedCallback() { this._draw(); }

        _draw() {
            const g = this._guard;
            this.replaceChildren();
            this._select = null;
            this.hidden = !g;
            if (!g) return;
            const warn = make('div', 'dbmn-guard-warning');
            warn.setAttribute('role', 'note');
            const mark = make('span', 'dbmn-guard-mark', '⚠');
            mark.setAttribute('aria-hidden', 'true');
            warn.append(mark, make('span', '', g.line || `${g.environment || 'This'} is a production environment.`));
            this.append(warn);
            if (!g.ask || !g.frequency || !Array.isArray(g.frequency.options)) return;
            const row = make('label', 'dbmn-guard-frequency');
            row.append(make('span', 'dbmn-guard-frequency-label', g.frequency.label || 'Warning frequency'));
            const select = make('select', 'dbmn-modal-input dbmn-guard-select');
            select.setAttribute('aria-label', g.frequency.label || 'Warning frequency');
            g.frequency.options.forEach(o => {
                const opt = make('option', '', o.label);
                opt.value = String(o.value);
                if (String(o.value) === String(g.frequency.value)) opt.selected = true;
                select.append(opt);
            });
            row.append(select);
            this.append(row);
            this._select = select;
        }
    }
    customElements.define('dbmn-guard-line', DbmnGuardLine);
})();
