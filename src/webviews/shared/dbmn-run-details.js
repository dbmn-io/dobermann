// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-run-details>: where a run went and how it ran, the window ⓘ opens on the run heading (design system; James,
 * 2026-11-24, the Console mock, #464: "Settings as a modal", no Organization: the header values by name). The Console
 * shows it in a DbmnModal; Run Batch's ⓘ ("Sending to") can show the same before a run starts.
 *
 *   <dbmn-run-details></dbmn-run-details>
 *   el.details = {                                  // screens/console/run-details.ts RunDetails, as the host sends it
 *       name, environment: { name, production }, endpoint: { name, method }, url,
 *       kind: 'batch' | 'single', executionId, started, durationMs,
 *       threads: { current, max } | null, errorHandling: 'continue' | 'stopOnFirst' | null,
 *       headers: [{ name, value }], variables: [{ name, value }],   // secret values come masked from the host
 *       lineage: { copiedFrom?: { runId, environment, at }, reprocessedFrom? } | null
 *   };
 *
 *   el.more = 'Files and every setting';         // a link at the end: fires dbmn-run-details-more (none when unset)
 *
 * It only draws: what may change while a run goes (Threads, Stop on next error) is changed in the footer's box, and
 * the name on the heading. Every value can be selected and copied. Draws in the page (no shadow root); styles in
 * modals.css (dbmn-run-details).
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.customElements || customElements.get('dbmn-run-details')) return;

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }
    const when = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(); };
    function took(ms) {
        if (ms === null || ms === undefined) return '';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s} s`;
        const m = Math.floor(s / 60);
        return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
    }

    class DbmnRunDetails extends HTMLElement {
        set details(d) { this._d = d || null; this._draw(); }
        set more(text) { this._more = text || ''; this._draw(); }
        get details() { return this._d; }
        connectedCallback() { this._draw(); }

        _draw() {
            if (!this.isConnected) return;
            const d = this._d;
            this.replaceChildren();
            if (!d) { this.append(make('p', 'dbmn-run-details-none', 'Loading the run’s details…')); return; }
            const where = make('dl', 'dbmn-run-details-list');
            const row = (label, value, extra) => {
                if (value === undefined || value === null || value === '') return;
                where.append(make('dt', '', label));
                const dd = make('dd', '', value);
                if (extra) dd.append(extra);
                where.append(dd);
            };
            const prod = d.environment && d.environment.production ? make('span', 'dbmn-run-details-prod', 'production') : null;
            row('Environment', d.environment && d.environment.name, prod);
            row('Endpoint', d.endpoint ? `${d.endpoint.method ? d.endpoint.method + ' ' : ''}${d.endpoint.name || ''}`.trim() : '');
            row('URL', d.url);
            row('Run', d.kind === 'single' ? 'One request' : `Batch${d.requests ? ` of ${Number(d.requests).toLocaleString()} requests` : ''}`);
            row('Started', when(d.started));
            row('Took', took(d.durationMs));
            if (d.threads) row('Threads', `${d.threads.current}${d.threads.max ? ` (this environment allows ${d.threads.max})` : ''}`);
            if (d.errorHandling) row('Error handling', d.errorHandling === 'stopOnFirst' ? 'Stop on first error' : 'Continue processing');
            const l = d.lineage || {};
            if (l.copiedFrom) row('Copied from', `a run${l.copiedFrom.environment ? ` on ${l.copiedFrom.environment}` : ''}${l.copiedFrom.at ? `, ${when(l.copiedFrom.at)}` : ''}`);
            if (l.reprocessedFrom) row('Reprocessed from', 'an earlier run');
            row('Run id', d.executionId);
            this.append(where);
            this._pairs('Headers', d.headers, 'No header values were sent with this run.');
            if (Array.isArray(d.variables) && d.variables.length) this._pairs('Variables', d.variables);
            if (this._more) {
                const more = make('button', 'dbmn-run-details-more', this._more);
                more.type = 'button';
                more.addEventListener('click', () => this.dispatchEvent(new CustomEvent('dbmn-run-details-more', { bubbles: true })));
                this.append(more);
            }
        }

        _pairs(title, list, none) {
            const items = Array.isArray(list) ? list : [];
            if (!items.length && !none) return;
            this.append(make('h4', 'dbmn-run-details-heading', title));
            if (!items.length) { this.append(make('p', 'dbmn-run-details-none', none)); return; }
            const dl = make('dl', 'dbmn-run-details-list dbmn-run-details-pairs');
            items.forEach(p => { dl.append(make('dt', '', p.name), make('dd', 'dbmn-run-details-value', p.value)); });
            this.append(dl);
        }
    }
    customElements.define('dbmn-run-details', DbmnRunDetails);
})();
