// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's Results when the query compares: Compare's own controls, drawn with Compare's markup and
 * styles (compare.css), so a compare reads the same whichever screen it is on.
 *
 *  - Status, first: DIFF and its places, Missing and its places, or Same. Its heading's arrow opens
 *    the Status filter: a tick per line, Only beside each (the line alone; on the line already
 *    alone, every line back), a funnel after the heading while it filters.
 *  - How each row's key met the others (one to one, one to many, not in every result, not in the
 *    Baseline), when there is more than one kind: its own filter, as Status's.
 *  - Each compared column's heading: a count pill of the rows that differ there; a click shows
 *    only those (a funnel while on).
 *  - The toolbar: Side by side (a column per result under each compared column) or Compact (one
 *    cell, the values that differ in pills); All columns or Diffs (the compared columns no row
 *    differs in hidden); a funnel that clears every filter.
 *  - A row's click (or right-click) opens the record: every column of each result for its key,
 *    side by side, as a table or JSON, with what differs marked.
 *  - A result's slot on Results: Hide it (left out of every status), Make it the Baseline (a run
 *    of the Baseline's view), Open it in the Console.
 *
 * The host works out each row's status and applies the filters (query-status.ts); here, only
 * what is drawn and what the user picks.
 *
 * ctx: { el, ui, post, view, views, colour, count, hasStatus(), reload(), redraw(), renderSlots() }
 */
(function () {
    'use strict';

    const RELATIONS = ['oneToOne', 'oneToMany', 'onlyBase', 'onlyOther'];
    const RELATION_NAMES = { oneToOne: 'One to one', oneToMany: 'One to many: the key is on more than one row, each compared', onlyBase: 'Not in every result', onlyOther: 'Not in BL' };

    function create(ctx) {
        const { el, ui } = ctx;
        const $ = id => document.getElementById(id);
        const places = () => (ui.state && ui.state.statusPlaces) || [];
        const shownPlaces = () => places().filter(p => !ui.filter.hidden.includes(p));
        /** A place's colour: a view's (its lane's), else a COMPARE side's by its number. */
        function tone(place) {
            const v = ctx.views().find(x => (x.run || x.name) === place);
            if (v) return ctx.colour(v.id);
            return `dbmn-run-${Math.max(0, (Number(place) || 1) - 1) % 4}`;
        }
        const tag = p => el('span', `compare-tag ${tone(p)}`, p);

        /* ---------- Filters ---------- */

        /** The Status menu's lines: Same, DIFF, Missing in each place that has any. */
        function statusOptions() {
            const c = ui.counts || { missing: {} };
            const all = ui.countsAll || { missing: {} };
            const out = [];
            if (c.same || all.same) out.push({ value: 'same', n: c.same || 0, of: c.same || 0 });
            if (c.diff || all.diff) out.push({ value: 'diff', n: c.diff || 0, of: all.diff || 0 });
            shownPlaces().forEach(p => { const n = (c.missing || {})[p] || 0; const of = (all.missing || {})[p] || 0; if (n || of) out.push({ value: `missing:${p}`, place: p, n, of }); });
            return out;
        }
        const ticked = value => !ui.filter.kinds || ui.filter.kinds.includes(value);
        const statusFiltered = () => statusOptions().some(o => !ticked(o.value));
        const anyFilter = () => statusFiltered() || ui.filter.columns.length > 0 || !!ui.filter.relations;
        function setFilter(change) {
            Object.assign(ui.filter, change);
            // Every line ticked is no filter at all
            if (ui.filter.kinds && statusOptions().every(o => ui.filter.kinds.includes(o.value))) ui.filter.kinds = null;
            if (ui.filter.relations && RELATIONS.filter(k => relationCount(k)).every(k => ui.filter.relations.includes(k))) ui.filter.relations = null;
            closeMenus();
            renderTools();
            // (a result hidden or shown again: its slot says so, and its cells leave or come back)
            if ('hidden' in change) { ctx.renderSlots(); ctx.redraw(); return; }
            ctx.reload();
        }
        function relationCount(k) { return ((ui.counts || {}).relations || {})[k] || 0; }
        function showRelations() { return !!ui.filter.relations || RELATIONS.filter(k => relationCount(k) > 0).length > 1; }

        /** A dropdown under the button that opened it, outside the table's scroll box. */
        function openMenu(id, button) {
            const menu = $(id);
            const opening = !menu.classList.contains('show');
            closeMenus();
            if (!opening) return false;
            const r = button.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = `${r.bottom + 4}px`;
            menu.style.left = `${Math.max(8, r.left - 8)}px`;
            menu.style.right = 'auto';
            menu.classList.add('show');
            button.setAttribute('aria-expanded', 'true');
            return true;
        }
        function closeMenus() {
            ['queryStatusMenu', 'queryRelationMenu'].forEach(id => { const m = $(id); if (m) m.classList.remove('show'); });
            document.querySelectorAll('#queryTable [aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        }
        document.addEventListener('mousedown', e => { if (!e.target.closest('.compare-status-menu, .compare-head-btn')) closeMenus(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

        /** A menu of tick lines (Status's and the relationship's): Show, Only, the pill or picture, the count. */
        function tickMenu(id, options, isOn, toggle, only, pillOf, countOf, nameOf) {
            const on = options.filter(o => isOn(o)).length;
            const head = el('div', 'compare-status-line compare-status-heading');
            head.append(el('span', '', 'Show'), el('span', '', 'Only'));
            const lines = options.map((o, i) => {
                const alone = on === 1 && isOn(o);
                const row = el('div', 'compare-status-line');
                const tickCell = el('label', 'compare-status-control compare-status-tick');
                tickCell.title = `Show ${nameOf(o)}`;
                const box = el('input');
                box.type = 'checkbox';
                box.id = `${id}Tick${i}`;
                box.checked = isOn(o);
                box.addEventListener('change', () => toggle(o, box.checked));
                tickCell.appendChild(box);
                const onlyCell = el('label', alone ? 'compare-status-control compare-status-only is-alone' : 'compare-status-control compare-status-only');
                onlyCell.title = alone ? 'Show every line again' : `Only ${nameOf(o)}`;
                const radio = el('input');
                radio.type = 'radio';
                radio.name = `${id}Only`;
                radio.checked = alone;
                radio.setAttribute('aria-label', onlyCell.title);
                radio.addEventListener('click', () => only(o, alone));
                onlyCell.appendChild(radio);
                const label = el('label', 'compare-status-name');
                label.htmlFor = box.id;
                label.title = tickCell.title;
                label.appendChild(pillOf(o));
                row.append(tickCell, onlyCell, label, el('span', 'compare-status-count', countOf(o)));
                return row;
            });
            $(id).replaceChildren(head, ...lines);
        }
        function renderStatusMenu() {
            const options = statusOptions();
            const nameOf = o => (o.place === undefined ? (o.value === 'diff' ? 'DIFF' : 'Same') : `Missing ${o.place}`);
            const pillOf = o => {
                if (o.place === undefined) return el('span', `status-pill-generic compare-${o.value}`, o.value === 'diff' ? 'DIFF' : 'Same');
                const box = el('span', 'compare-status');
                box.append(el('span', 'status-pill-generic compare-missing', 'Missing'), tag(o.place));
                return box;
            };
            // Hiding only ever adds Same, so only DIFF and Missing say "of"
            const countOf = o => (o.n === o.of ? ctx.count(o.n) : `${ctx.count(o.n)} of ${ctx.count(o.of)}`);
            const current = () => ui.filter.kinds || options.map(o => o.value);
            tickMenu('queryStatusMenu', options, o => ticked(o.value),
                (o, on) => setFilter({ kinds: on ? current().concat(o.value) : current().filter(v => v !== o.value) }),
                (o, alone) => setFilter({ kinds: alone ? null : [o.value] }), pillOf, countOf, nameOf);
        }
        function renderRelationMenu() {
            const kinds = RELATIONS.filter(k => relationCount(k) > 0).map(value => ({ value }));
            const current = () => ui.filter.relations || kinds.map(k => k.value);
            const isOn = o => !ui.filter.relations || ui.filter.relations.includes(o.value);
            tickMenu('queryRelationMenu', kinds, isOn,
                (o, on) => setFilter({ relations: on ? current().concat(o.value) : current().filter(v => v !== o.value) }),
                (o, alone) => setFilter({ relations: alone ? null : [o.value] }),
                o => { const l = el('span', 'compare-relation-option'); l.appendChild(window.RelationGlyph.svg(o.value)); return l; },
                o => ctx.count(relationCount(o.value)), o => RELATION_NAMES[o.value]);
        }
        function funnel(clear) {
            const b = el('button', 'compare-funnel icon');
            b.type = 'button';
            b.dataset.icon = 'funnel';
            b.title = 'Clear this filter';
            b.setAttribute('aria-label', b.title);
            b.addEventListener('click', e => { e.stopPropagation(); clear(); });
            return b;
        }
        /** A heading's filter arrow (a spreadsheet's), a funnel after it while it filters. */
        function headButton(th, label, on, menuId, render, clear) {
            const b = el('button', 'compare-head-btn icon');
            b.type = 'button';
            b.dataset.icon = 'chevron-down';
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-expanded', 'false');
            b.setAttribute('aria-label', on ? `Filter ${label} (active filter)` : `Filter ${label}`);
            b.title = b.getAttribute('aria-label');
            b.addEventListener('click', e => { e.stopPropagation(); render(); openMenu(menuId, b); });
            const actions = th.querySelector('.header-actions') || th;
            actions.appendChild(b);
            if (on) actions.appendChild(funnel(clear));
        }

        /* ---------- Results' columns ---------- */

        /** A row's status as Compare shows it. */
        function statusNode(st) {
            const box = el('span', 'compare-status');
            if (!st) return box;
            const many = shownPlaces().length > 2;
            if (st.diff.length) {
                const g = el('span', 'compare-status-group');
                g.appendChild(el('span', 'status-pill-generic compare-diff', 'DIFF'));
                if (many) st.diff.forEach(p => g.appendChild(tag(p)));
                box.appendChild(g);
            }
            if (st.missing.length) {
                const g = el('span', 'compare-status-group');
                g.appendChild(el('span', 'status-pill-generic compare-missing', 'Missing'));
                st.missing.forEach(p => g.appendChild(tag(p)));
                box.appendChild(g);
            }
            if (!st.diff.length && !st.missing.length) box.appendChild(el('span', 'status-pill-generic compare-same', 'Same'));
            return box;
        }
        /** Status (and how each row's key met the others), pinned first. */
        function leadColumns() {
            const out = [{
                id: '__status', name: 'Status', pinned: true, sortable: false, className: 'compare-status-cell',
                render: (_v, row) => statusNode(row.__status),
                head: th => { th.classList.add('compare-status-head'); headButton(th, 'Status', statusFiltered(), 'queryStatusMenu', renderStatusMenu, () => setFilter({ kinds: null })); }
            }];
            if (showRelations()) {
                out.push({
                    id: '__relation', name: 'Relation', pinned: true, sortable: false,
                    render: (_v, row) => (row.__status && row.__status.relation ? window.RelationGlyph.svg(row.__status.relation) : el('span')),
                    cell: (td, _v, row) => { if (row.__status && row.__status.relation) td.title = RELATION_NAMES[row.__status.relation] + (row.__status.repeated ? `: repeated in ${row.__status.repeated.join(', ')}` : ''); },
                    head: th => {
                        th.classList.add('compare-relation-head');
                        th.title = 'How each row’s key meets the results';
                        const name = th.querySelector('.column-name');
                        if (name) name.replaceChildren(window.RelationGlyph.svg('oneToMany'));
                        headButton(th, 'relationship', !!ui.filter.relations, 'queryRelationMenu', renderRelationMenu, () => setFilter({ relations: null }));
                    }
                });
            }
            return out;
        }
        /** A compared column's heading: its count pill, which shows only the rows that differ there (a funnel while on). */
        function groupHead(th, name) {
            th.classList.add('compare-field-head');
            const n = ((ui.counts || {}).columns || {})[name] || 0;
            const on = ui.filter.columns.includes(name);
            if (!n && !on) return;
            const box = el('span', 'compare-col-filter');
            const pill = el('button', `tab-count compare-col-count${on ? ' is-active' : ''}`, ctx.count(n));
            pill.type = 'button';
            pill.title = on ? `Showing the rows that differ in ${name}: click to show every row` : `${ctx.count(n)} rows differ in ${name}: click to show only them`;
            pill.addEventListener('click', e => {
                e.stopPropagation();
                setFilter({ columns: on ? ui.filter.columns.filter(c => c !== name) : ui.filter.columns.concat(name) });
            });
            box.appendChild(pill);
            if (on) box.appendChild(funnel(() => setFilter({ columns: ui.filter.columns.filter(c => c !== name) })));
            (th.querySelector('.column-name') || th).appendChild(box);
        }
        /** Compact: a compared column in one cell; one value when every result agrees, else each value in a pill naming who holds it. */
        function compactCell(td, row, cells, placeOf, colId) {
            const st = row.__status;
            const list = [];
            cells.forEach(c => {
                const p = placeOf(c);
                if (ui.filter.hidden.includes(p) || (st && st.missing.includes(p))) return;
                const v = row[colId(c)];
                const t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                const found = list.find(x => x.t === t);
                if (found) found.who.push(p); else list.push({ t, who: [p] });
            });
            if (!list.length) return;
            if (list.length === 1) { td.textContent = list[0].t; return; }
            const pair = cells.length === 2;
            list.forEach((item, i) => {
                if (i === 0) { td.appendChild(el('span', 'compare-compact-plain', item.t)); return; }
                const box = el('span', `compare-pill ${tone(item.who[0])}${pair ? ' is-bare' : ''}`);
                if (!pair) { const who = el('span', 'compare-pill-who'); item.who.forEach(p => who.appendChild(tag(p))); box.appendChild(who); }
                box.appendChild(el('span', '', item.t));
                td.appendChild(box);
            });
        }

        /* ---------- The toolbar ---------- */

        function renderTools() {
            const box = $('queryStatusTools');
            if (!box) return;
            box.hidden = !ctx.hasStatus();
            if (box.hidden) return;
            [['queryViewSide', ui.resultsView !== 'compact'], ['queryViewCompact', ui.resultsView === 'compact'],
                ['queryColsAll', !ui.diffsOnly], ['queryColsChanged', !!ui.diffsOnly]].forEach(([id, on]) => {
                $(id).classList.toggle('active', on);
                $(id).setAttribute('aria-pressed', String(on));
            });
            const clear = $('queryClearFilters');
            clear.disabled = !anyFilter();
            clear.title = clear.disabled ? 'No filters on' : 'Clear all filters';
            clear.classList.toggle('is-active', !clear.disabled);
        }
        [['queryViewSide', 'side'], ['queryViewCompact', 'compact']].forEach(([id, view]) => $(id).addEventListener('click', () => { if (ui.resultsView === view) return; ui.resultsView = view; renderTools(); ctx.redraw(); }));
        [['queryColsAll', false], ['queryColsChanged', true]].forEach(([id, on]) => $(id).addEventListener('click', () => { if (!!ui.diffsOnly === on) return; ui.diffsOnly = on; renderTools(); ctx.redraw(); }));
        $('queryClearFilters').addEventListener('click', () => setFilter({ kinds: null, columns: [], relations: null }));

        /* ---------- The record ---------- */

        function openRecord(row) {
            if (!row || row.__index === undefined) return;
            ctx.post({ type: 'query.record', index: row.__index, hidden: ui.filter.hidden });
        }
        function recordDetail(m) {
            const wrap = el('div', 'compare-record');
            const toggle = el('div', 'toggle-group compare-record-toggle');
            toggle.setAttribute('role', 'group');
            toggle.setAttribute('aria-label', 'Show the record as');
            const box = el('div', 'table-container');
            const text = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
            const asTable = () => {
                const table = el('table', 'data-table');
                const head = el('tr');
                head.appendChild(el('th', '', 'Column'));
                m.places.forEach(p => { const th = el('th', `compare-sub compare-record-head ${tone(p)}`); th.appendChild(el('strong', '', p)); head.appendChild(th); });
                const thead = el('thead');
                thead.appendChild(head);
                const body = el('tbody');
                m.fields.forEach(f => {
                    const tr = el('tr');
                    tr.appendChild(el('td', 'font-mono', f.name));
                    f.values.forEach(values => {
                        const td = el('td', f.differs ? 'highlight-cell font-mono' : 'font-mono');
                        if (!values.length) td.appendChild(el('span', 'color-description', 'no row'));
                        values.forEach((v, i) => { if (i) td.appendChild(el('br')); td.appendChild(document.createTextNode(text(v))); });
                        tr.appendChild(td);
                    });
                    body.appendChild(tr);
                });
                table.append(thead, body);
                return table;
            };
            const asJson = () => {
                const table = el('table', 'data-table');
                const head = el('tr');
                m.places.forEach(p => { const th = el('th', `compare-sub compare-record-head ${tone(p)}`); th.appendChild(el('strong', '', p)); head.appendChild(th); });
                const thead = el('thead');
                thead.appendChild(head);
                const tr = el('tr');
                m.places.forEach((_, i) => {
                    const record = {};
                    m.fields.forEach(f => { if (f.values[i] && f.values[i].length) record[f.name] = f.values[i][0]; });
                    tr.appendChild(el('td', 'compare-json-line font-mono', Object.keys(record).length ? JSON.stringify(record, null, 2) : 'no record'));
                });
                const body = el('tbody');
                body.appendChild(tr);
                table.append(thead, body);
                return table;
            };
            const show = view => {
                ui.recordView = view;
                toggle.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
                box.replaceChildren(view === 'json' ? asJson() : asTable());
            };
            [['table', 'Table', 'The View’s columns'], ['json', 'JSON', 'Each record as one']].forEach(([view, label, title]) => {
                const b = el('button', 'toggle-btn', label);
                b.type = 'button';
                b.title = title;
                b.dataset.view = view;
                b.addEventListener('click', () => show(view));
                toggle.appendChild(b);
            });
            const bar = el('div', 'compare-record-bar');
            bar.appendChild(toggle);
            wrap.append(bar, box);
            show(ui.recordView || 'table');
            const key = (m.fields[0] && m.fields[0].values.map(v => v[0]).find(v => v !== undefined && v !== null)) || 'Record';
            const said = m.status ? (m.status.diff.length ? `DIFF ${m.status.diff.join(' ')}` : m.status.missing.length ? `Missing ${m.status.missing.join(' ')}` : 'Same') : '';
            window.DbmnModal.show({ title: `${key}${said ? `: ${said}` : ''}`, body: wrap, size: 'large', maximisable: true, actions: [{ id: 'close', label: 'Close', variant: 'secondary' }] });
        }

        /* ---------- A result's slot on Results ---------- */

        /** Hide it, make it the Baseline (a run of the Baseline's view), open it in the Console. */
        function slotMenu(event, v) {
            const place = v.run || v.name;
            const hidden = ui.filter.hidden.includes(place);
            const items = [];
            if (places().includes(place)) {
                const last = shownPlaces().length <= 2 && !hidden;
                items.push({ id: 'toggle', label: hidden ? `Show ${place}` : `Hide ${place}`, icon: hidden ? 'eye' : 'eye-off', disabled: last, title: last ? 'Two results stay compared' : 'It is not compared while hidden' });
            }
            if (v.runOf) items.push({ id: 'baseline', label: `Make ${place} the Baseline`, icon: 'scale' });
            if (!v.file) items.push({ id: 'console', label: 'Open in the Console', icon: 'external-link' });
            if (!items.length) return;
            window.DbmnContextMenu.show(event, items, id => {
                if (id === 'toggle') setFilter({ hidden: hidden ? ui.filter.hidden.filter(p => p !== place) : ui.filter.hidden.concat(place) });
                else if (id === 'baseline') { ctx.post({ type: 'query.makeBaseline', id: v.id }); }
                else if (id === 'console') ctx.post({ type: 'query.openConsole', id: v.id });
            });
        }

        return { leadColumns, groupHead, compactCell, renderTools, openRecord, recordDetail, slotMenu, closeMenus };
    }

    window.QueryCompareResults = { create };
})();
