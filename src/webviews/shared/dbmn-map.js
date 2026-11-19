// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * <dbmn-map>: which column in each source is which, a line at a time (the design system:
 * src/webviews/design-system). Compare's Map, Run Batch's Map and, later, Query's Join draw with
 * it, so lining columns up looks and works the same everywhere.
 *
 * A column of each source across the top, a gutter on the left. Each line is one thing lined
 * up: under each source, a box with its column (picked from the source's columns), an example
 * value, the functions on it (chips, and ƒ to change them) and, where the screen says so, how
 * many of its values agree with the first source's. In the gutter, what the line is for (the
 * screen's choices: Key, Strict, Relaxed, Don't compare; or Required, Optional) and × to take it
 * out. Lines of the key mode sit under "Match on" with how many rows each source matches; the
 * rest under the lines' heading. Under it all, each source's columns no line uses: a click
 * starts a line with one.
 *
 *   <dbmn-map id="map" label="Map columns"></dbmn-map>
 *
 *   map.sources = [{ id: 'bl', name: 'BL · GET /items · PROD', short: 'BL', tone: 'compare-r0',   // short: "Not in C1"
 *                    columns: [{ id: 'sku', name: 'sku' }, …] },
 *                  { id: 'tpl', name: 'Template', fixed: true }];   // fixed: the line's own name, no picker (Run Batch's fields)
 *   map.modes = [{ id: 'key', label: 'Key', title: '…' }, { id: 'strict', label: 'Strict' }, …];
 *   map.keyMode = 'key';            // its lines under "Match on"; the last one can't stop being key
 *   map.text = { key: 'Match on', keyNote: '…', lines: 'Compare', linesNote: '…', addKey: '+ Add to the key', left: 'Not mapped' };
 *   map.lines = [{ id: 'l1', mode: 'key', name: 'sku' /* for a fixed source *\/,
 *                  cells: { bl: { column: 'sku', example: 'A-2207', fns: [{ id, label, missing }], title: 'TRIM(sku)', agree: 0.93 } } }];
 *   map.matched = { c1: { text: '1,180 of 1,198 match BL', tone: 'ok' | 'warn' | '' } };   // under the key's lines
 *
 *   map.addEventListener('dbmn-map-pick', e => …e.detail.line, source, column…);   // column null: "not in this source"
 *   map.addEventListener('dbmn-map-mode', e => …e.detail.line, mode…);
 *   map.addEventListener('dbmn-map-fn', e => …e.detail.line, source…);   // the screen opens DbmnFunctions
 *   map.addEventListener('dbmn-map-add', e => …e.detail.mode…);           // "+ Add to the key"
 *   map.addEventListener('dbmn-map-remove', e => …e.detail.line…);
 *   map.addEventListener('dbmn-map-leftover', e => …e.detail.source, column…);   // a column no line uses, clicked
 *
 * It draws what it is given and says what was asked; the screen changes `lines` and gives them
 * back. A source's `tone` is a class the screen owns (Compare's compare-r0…r3 set --compare-c).
 * Styles: shared/dbmn-map.css.
 */
(function () {
    'use strict';

    if (!window.customElements || customElements.get('dbmn-map')) return;

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const TEXT = {
        key: 'Match on',
        keyNote: 'The columns that together say which rows are the same record in every source.',
        lines: 'Compare',
        linesNote: '',
        addKey: '+ Add to the key',
        left: 'Not mapped',
        allMapped: 'All mapped'
    };

    class DbmnMap extends HTMLElement {
        constructor() {
            super();
            this._sources = [];
            this._modes = [];
            this._lines = [];
            this._matched = null;
            this._keyMode = '';
            this._text = Object.assign({}, TEXT);
        }
        connectedCallback() {
            if (!this._built) {
                this._built = true;
                this.setAttribute('role', 'group');
                if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', this.getAttribute('label') || 'Map columns');
            }
            this._draw();
        }

        set sources(list) { this._sources = Array.isArray(list) ? list : []; this._draw(); }
        get sources() { return this._sources; }
        set modes(list) { this._modes = Array.isArray(list) ? list : []; this._draw(); }
        get modes() { return this._modes; }
        set keyMode(id) { this._keyMode = id || ''; this._draw(); }
        get keyMode() { return this._keyMode; }
        set lines(list) { this._lines = Array.isArray(list) ? list : []; this._draw(); }
        get lines() { return this._lines; }
        set matched(map) { this._matched = map && typeof map === 'object' ? map : null; this._draw(); }
        get matched() { return this._matched; }
        set text(words) { this._text = Object.assign({}, TEXT, words || {}); this._draw(); }
        get text() { return this._text; }

        _tell(type, detail) {
            this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
        }
        _keys() { return this._keyMode ? this._lines.filter(l => l.mode === this._keyMode) : []; }
        /** The last line of the key can't leave it: something has to say which rows are the same record. */
        _lastKey(line) { return !!this._keyMode && line.mode === this._keyMode && this._keys().length === 1; }

        _draw() {
            if (!this._built || !this.isConnected) return;
            const sources = this._sources;
            this.style.setProperty('--map-sources', String(Math.max(1, sources.length)));
            const grid = make('div', 'dbmn-map-grid');
            // The sources across the top
            grid.append(make('div', 'dbmn-map-corner'));
            sources.forEach(s => {
                const head = make('div', 'dbmn-map-source' + (s.tone ? ` ${s.tone}` : ''), s.name || s.id);
                head.title = s.name || s.id;
                grid.append(head);
            });
            const keys = this._keys();
            if (this._keyMode) {
                grid.append(this._section(this._text.key, this._text.keyNote, this._text.addKey, () => this._tell('dbmn-map-add', { mode: this._keyMode })));
                keys.forEach(line => this._line(grid, line));
                // How many rows each source matches on the key, all its lines together
                if (this._matched) {
                    grid.append(make('div', 'dbmn-map-lead dbmn-map-matched-lead', 'Matched'));
                    sources.forEach(s => {
                        const m = this._matched[s.id];
                        grid.append(make('div', 'dbmn-map-matched' + (m && m.tone ? ` is-${m.tone}` : ''), m ? m.text : ''));
                    });
                }
            }
            const rest = this._lines.filter(l => !keys.includes(l));
            grid.append(this._section(this._text.lines, this._text.linesNote));
            rest.forEach(line => this._line(grid, line));
            // Each source's columns no line uses
            if (sources.some(s => !s.fixed && (s.columns || []).length)) {
                grid.append(make('div', 'dbmn-map-lead', this._text.left));
                sources.forEach(s => {
                    const box = make('div', 'dbmn-map-left');
                    if (!s.fixed) {
                        const used = new Set(this._lines.map(l => l.cells && l.cells[s.id] && l.cells[s.id].column).filter(Boolean));
                        const left = (s.columns || []).filter(c => !used.has(c.id));
                        if (!left.length) box.append(make('span', 'dbmn-map-quiet', this._text.allMapped));
                        left.forEach(c => {
                            const chip = make('button', 'dbmn-map-leftover', c.name || c.id);
                            chip.type = 'button';
                            chip.title = 'A new line with this column';
                            chip.addEventListener('click', () => this._tell('dbmn-map-leftover', { source: s.id, column: c.id }));
                            box.append(chip);
                        });
                    }
                    grid.append(box);
                });
            }
            this.replaceChildren(grid);
        }

        _section(title, note, action, onAction) {
            const section = make('div', 'dbmn-map-section');
            section.append(make('h3', 'dbmn-map-section-title', title));
            if (note) section.append(make('p', 'dbmn-map-section-note', note));
            if (action) {
                const b = make('button', 'btn btn-secondary dbmn-map-add', action);
                b.type = 'button';
                b.addEventListener('click', onAction);
                section.append(b);
            }
            return section;
        }

        _line(grid, line) {
            // The gutter: what the line is for, and ×
            const lead = make('div', 'dbmn-map-lead');
            lead.dataset.line = line.id;
            if (this._modes.length) {
                const mode = make('div', 'dbmn-map-mode');
                mode.setAttribute('role', 'group');
                mode.setAttribute('aria-label', 'What this line is for');
                this._modes.forEach(m => {
                    const b = make('button', '', m.label);
                    b.type = 'button';
                    b.dataset.mode = m.id;
                    if (m.title) b.title = m.title;
                    b.setAttribute('aria-pressed', String(line.mode === m.id));
                    b.addEventListener('click', () => {
                        if (line.mode === m.id || (this._lastKey(line) && m.id !== this._keyMode)) return;
                        this._tell('dbmn-map-mode', { line: line.id, mode: m.id });
                    });
                    mode.append(b);
                });
                lead.append(mode);
            }
            const x = make('button', 'dbmn-map-x', '×');
            x.type = 'button';
            x.title = this._lastKey(line) ? 'The key needs at least one line' : 'Take this line out';
            x.setAttribute('aria-label', 'Take this line out');
            x.disabled = this._lastKey(line);
            x.addEventListener('click', () => { if (!this._lastKey(line)) this._tell('dbmn-map-remove', { line: line.id }); });
            lead.append(x);
            grid.append(lead);
            const isKey = !!this._keyMode && line.mode === this._keyMode;
            this._sources.forEach((s, i) => grid.append(this._cell(line, s, i, isKey)));
        }

        _cell(line, source, index, isKey) {
            const cell = (line.cells && line.cells[source.id]) || {};
            const box = make('div', 'dbmn-map-cell' + (source.tone ? ` ${source.tone}` : '') + (isKey ? ' is-key' : ''));
            box.dataset.line = line.id;
            box.dataset.source = source.id;
            // A fixed source (Run Batch's template): the line's own name, nothing to pick or change
            if (source.fixed) {
                box.classList.add('is-fixed');
                box.append(make('span', 'dbmn-map-name', line.name || line.id));
                if (cell.example !== undefined && cell.example !== null && cell.example !== '') box.append(make('span', 'dbmn-map-eg', `e.g. ${cell.example}`));
                return box;
            }
            if (!cell.column) box.classList.add('is-empty');
            const pick = make('select', 'dbmn-map-pick');
            pick.setAttribute('aria-label', `Column in ${source.name || source.id}`);
            const none = make('option', '', index === 0 ? 'Pick a column' : `Not in ${source.short || source.name || source.id}`);
            none.value = '';
            pick.append(none, ...(source.columns || []).map(c => {
                const option = make('option', '', c.name || c.id);
                option.value = c.id;
                return option;
            }));
            pick.value = cell.column || '';
            pick.addEventListener('change', () => this._tell('dbmn-map-pick', { line: line.id, source: source.id, column: pick.value || null }));
            box.append(pick);
            if (!cell.column) {
                box.append(make('span', 'dbmn-map-quiet', index === 0 ? 'not in the first source' : 'not in this source'));
                return box;
            }
            if (cell.example !== undefined && cell.example !== null && cell.example !== '') box.append(make('span', 'dbmn-map-eg', `e.g. ${cell.example}`));
            // The functions on it, and ƒ to change them
            const fx = make('div', 'dbmn-map-fx');
            (cell.fns || []).forEach(f => {
                const chip = make('span', 'dbmn-map-fn' + (f.missing ? ' is-missing' : ''), f.label || f.id);
                if (f.missing) chip.title = 'Its lookup table has been deleted: this will not run until it is changed';
                fx.append(chip);
            });
            const b = make('button', 'dbmn-map-fxbtn', (cell.fns || []).length ? `ƒ ${cell.fns.length}` : 'ƒ');
            b.type = 'button';
            b.title = cell.title || 'Functions on this column';
            b.setAttribute('aria-label', `Functions on ${cell.column}`);
            b.addEventListener('click', () => this._tell('dbmn-map-fn', { line: line.id, source: source.id }));
            fx.append(b);
            box.append(fx);
            // How many of its values agree with the first source's (not on the key: the key decides which rows meet)
            if (!isKey && index > 0 && typeof cell.agree === 'number' && isFinite(cell.agree)) {
                const pct = Math.round(cell.agree * 100);
                const agree = make('span', 'dbmn-map-agree' + (pct >= 90 ? ' is-good' : pct < 30 ? ' is-low' : ''), pct < 30 ? `${pct}% of values agree: written differently?` : `${pct}% of values agree`);
                agree.title = 'Of the rows the key matches, how many hold the same value as the first source here (after both sides\' functions)';
                box.append(agree);
            }
            return box;
        }
    }

    customElements.define('dbmn-map', DbmnMap);
    window.DbmnMap = DbmnMap;
})();
