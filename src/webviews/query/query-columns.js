// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's Columns step: what the report is made of, on the slots' grid.
 *
 * Above the line, the report's columns in Results' order. A report column is its name and its
 * cells, each cell a view's column under that view's slot: one cell and the column is shown, two
 * or more and they are compared (their values side by side, a value that differs in amber). An
 * empty place on a row has a + (a view's columns to put in it); a right-click on a cell gives its
 * functions or takes it out of the column; × takes the whole column back below. A row is dragged
 * to another place, or onto another row to compare them as one column. Calculated columns sit
 * among them, made in the calculation builder (query-calc.js).
 *
 * Below the line, every column not used, a row per name across the views, like a spreadsheet: a
 * click on a cell brings it up, shown; the Compare icon beside a name brings the row up, compared.
 *
 * Nothing comes up on its own. Rows that move slide to their new place.
 *
 * The page hands its helpers in (ctx): the screen's own lanes, cells and messages.
 */
(function () {
    'use strict';

    /**
     * ctx: { el, at, line, views, view, viewAt, colour, post, setBusy, count, state, injectIcons,
     *        openCalc(calc|null), pickFns(ref, done), CALC_VIEW }
     */
    function create(ctx) {
        const { el, at, line, views, view, colour } = ctx;
        let dragFrom = -1;
        let lastAdded = '';

        const id = c => `${c.view}\u0000${c.column}`;
        /** A value of a view's column: from the report's sample row (the first where every view matched), else the view's own first. */
        function sample(viewId, column) {
            const s = ctx.state();
            const hit = (s.sampleRow || []).find(c => c.view === viewId && c.column === column);
            if (hit) return hit.value;
            const v = view(viewId);
            const c = v && v.columns.find(x => x.name === column);
            return c ? c.sample || '' : '';
        }
        /** The views a column can come from: read, shown, not failed. */
        function liveViews() { return views().filter(v => !v.waiting && !v.off && !v.error); }

        /** The report's columns as the host has them, every entry a copy. */
        function entries() {
            return (ctx.state().columns || []).map(c => Object.assign({}, c, { fns: (c.fns || []).slice() }));
        }
        /** Entries as report columns: a compared column is the entries side by side with one group. */
        function reportRows(list) {
            const rows = [];
            list.forEach((c, index) => {
                if (c.view === ctx.CALC_VIEW) {
                    const calc = (ctx.state().calc || []).find(x => x.name === c.column);
                    rows.push({ kind: 'calc', name: c.column, calc, entries: [index] });
                    return;
                }
                const last = rows[rows.length - 1];
                if (c.group && last && last.kind !== 'calc' && last.group === c.group) { last.entries.push(index); return; }
                rows.push({ kind: 'cells', group: c.group || '', name: c.group || c.column, entries: [index] });
            });
            rows.forEach(r => { r.key = r.kind === 'calc' ? `calc\u0000${r.name}` : r.entries.map(i => id(list[i])).join('\u0001'); });
            return rows;
        }
        /** Send the report's columns (as entries, in order). A report needs one at least. */
        function send(list) {
            if (!list.length) { if (window.DbmnToast) window.DbmnToast.info('A report needs one column at least.'); render(); return; }
            ctx.setBusy('Updating…');
            ctx.post({ type: 'query.setSelect', select: list.map(c => Object.assign({ view: c.view, column: c.column }, c.fns && c.fns.length ? { fns: c.fns } : {}, c.group ? { group: c.group } : {})) });
        }
        /** Entries rebuilt from report rows (after a move, a merge or a removal). */
        function flatten(rows, list) {
            return rows.flatMap(r => r.entries.map(i => {
                const c = Object.assign({}, list[i]);
                if (r.kind !== 'calc' && r.entries.length > 1) c.group = r.name;
                else if (r.kind !== 'calc' && r.group) c.group = r.group;
                else delete c.group;
                return c;
            }));
        }

        /** The ƒ on a cell: on hover, or ƒ1 where a function is on. Its click opens the functions. */
        function fxButton(entry, list) {
            const has = (entry.fns || []).length;
            const b = el('button', 'query-rep-fx' + (has ? ' is-on' : ''), has ? `ƒ${has}` : 'ƒ');
            b.type = 'button';
            b.title = has ? 'Functions on this cell: click to see or change them' : 'Functions on this cell';
            b.setAttribute('aria-label', `Functions on ${entry.column}`);
            b.addEventListener('click', e => { e.stopPropagation(); functions(entry, list); });
            return b;
        }
        function functions(entry, list) {
            ctx.pickFns(entry, () => send(list));
        }

        /** An empty place on a report row: a + that lists the view's columns to put in it. */
        function emptyPlace(v, row, rows, list) {
            const cell = at(v.id, 'query-rep-cell query-rep-empty');
            const add = el('button', 'query-rep-add', '+');
            add.type = 'button';
            add.title = `Put one of ${v.name}'s columns in ${row.name}`;
            add.setAttribute('aria-label', `Add a column of ${v.name} to ${row.name}`);
            add.addEventListener('click', e => {
                e.stopPropagation();
                const items = v.columns.map(c => ({ id: c.name, label: c.name, detail: sample(v.id, c.name) || ' ' }));
                window.DbmnContextMenu.show(add, items, column => {
                    // Put in the row: it is one column now, compared under the row's name
                    const list2 = list.slice();
                    list2.push({ view: v.id, column, fns: [] });
                    row.entries = row.entries.concat(list2.length - 1);
                    row.group = row.name;
                    lastAdded = `${v.id}\u0000${column}`;
                    send(flatten(rows, list2));
                });
            });
            cell.appendChild(add);
            return cell;
        }
        /** A cell of a report row: its value (amber where it differs from the first), ƒ, and a right-click menu. */
        function reportCell(entry, index, row, list, first) {
            const value = sample(entry.view, entry.column);
            const differs = row.entries.length > 1 && first !== null && String(value) !== String(first);
            const cell = at(entry.view, 'query-rep-cell' + (differs ? ' is-diff' : ''));
            cell.dataset.entry = String(index);
            const v = view(entry.view);
            cell.title = `${v ? v.name : ''} · ${entry.column}${(entry.fns || []).length ? ` · ${(entry.fns || []).length} function${entry.fns.length === 1 ? '' : 's'}` : ''}. Right-click for its functions, or to take it out`;
            cell.append(el('span', 'query-rep-value font-mono', value === '' ? ' ' : value), fxButton(entry, list));
            cell.addEventListener('contextmenu', e => {
                e.preventDefault();
                window.DbmnContextMenu.show(e, [
                    { id: 'fx', label: 'Functions…', icon: 'variable' },
                    { id: 'remove', label: row.entries.length > 1 ? 'Remove from this column' : 'Take it out of the report', icon: 'x' }
                ], choice => {
                    if (choice === 'fx') functions(entry, list);
                    if (choice === 'remove') {
                        const out = list.filter((_, i) => i !== index);
                        // One cell left: shown, under the column's name still
                        send(out);
                    }
                });
            });
            return cell;
        }

        /** Rows that moved slide from where they were (and nothing slides for a user who asks for less motion). */
        function slide(box, before) {
            if (!before.size || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
            box.querySelectorAll('[data-rep-key]').forEach(row => {
                const was = before.get(row.dataset.repKey);
                if (was === undefined) {
                    if (row.dataset.repKey === lastAdded || row.querySelector(`[data-free-key="${CSS.escape(lastAdded)}"]`)) row.classList.add('is-new');
                    return;
                }
                const delta = was - row.getBoundingClientRect().top;
                if (Math.abs(delta) < 1) return;
                row.style.transform = `translateY(${delta}px)`;
                row.style.transition = 'none';
                requestAnimationFrame(() => {
                    row.style.transition = 'transform 160ms ease-out';
                    row.style.transform = '';
                });
                row.addEventListener('transitionend', () => { row.style.transition = ''; }, { once: true });
            });
        }

        function render() {
            const box = document.getElementById('queryColumns');
            const s = ctx.state && ctx.state();
            if (!box || !s) return;
            const before = new Map();
            box.querySelectorAll('[data-rep-key]').forEach(row => before.set(row.dataset.repKey, row.getBoundingClientRect().top));
            const list = entries();
            const rows = reportRows(list);
            const used = new Set(list.filter(c => c.view !== ctx.CALC_VIEW).map(id));
            const lines = [];

            lines.push(line('query-rep-head', {}, [], [el('span', 'query-lead-text query-rep-title', 'In the report')]));
            rows.forEach((row, r) => {
                const lead = [];
                const grip = el('span', 'query-rep-grip', '⋮⋮');
                grip.title = 'Drag to another place, or onto another column to compare them as one';
                lead.push(grip);
                if (row.kind === 'calc') lead.push(el('span', 'query-rep-badge', 'fx'));
                const name = el('input', 'query-rep-name font-mono');
                name.value = row.name;
                name.title = row.name;
                name.setAttribute('aria-label', `${row.name}: its heading in Results`);
                name.spellcheck = false;
                name.addEventListener('change', () => {
                    const heading = name.value.trim();
                    if (!heading || heading === row.name) { name.value = row.name; return; }
                    if (row.kind === 'calc') { ctx.post({ type: 'query.setCalc', name: heading, formula: row.calc && row.calc.formula !== undefined ? row.calc.formula : undefined, expr: row.calc ? row.calc.expr : '', was: row.name }); return; }
                    row.name = heading;
                    row.group = heading;
                    send(flatten(rows, list));
                });
                lead.push(name);
                const cells = {};
                if (row.kind === 'calc') {
                    // The calculation, across the lanes: a click opens it in the builder
                    const calc = el('button', 'query-rep-calc font-mono');
                    calc.type = 'button';
                    calc.title = 'Click to change the calculation';
                    calc.append(el('span', 'query-rep-formula', row.calc ? (row.calc.expr || row.calc.formula || '') : ''));
                    calc.addEventListener('click', () => ctx.openCalc(row.calc || null));
                    const first = liveViews()[0];
                    if (first) {
                        const c = at(first.id, 'query-rep-cell query-rep-calc-cell');
                        // (across every lane)
                        c.style.setProperty('--query-span', String(views().length));
                        c.appendChild(calc);
                        cells[first.id] = c;
                    }
                } else {
                    const firstValue = sample(list[row.entries[0]].view, list[row.entries[0]].column);
                    liveViews().forEach(v => {
                        const index = row.entries.find(i => list[i].view === v.id);
                        cells[v.id] = index !== undefined ? reportCell(list[index], index, row, list, firstValue) : emptyPlace(v, row, rows, list);
                    });
                }
                const out = el('button', 'compare-tool-btn icon');
                out.type = 'button';
                out.dataset.icon = 'x';
                out.title = row.kind === 'calc' ? 'Delete this calculated column' : 'Take the whole column out of the report: back below the line';
                out.setAttribute('aria-label', `Take ${row.name} out of the report`);
                out.addEventListener('click', () => {
                    if (row.kind === 'calc') { ctx.setBusy('Updating…'); ctx.post({ type: 'query.removeCalc', name: row.name }); return; }
                    send(flatten(rows.filter(x => x !== row), list));
                });
                const made = line('query-rep-row' + (row.kind === 'calc' ? ' is-calc' : row.entries.length > 1 ? ' is-compared' : ''), cells, [out], lead);
                made.dataset.repKey = row.key;
                if (row.kind === 'calc') made.querySelector('.query-cells').classList.add('query-rep-span');
                // Drag: to another place, or onto another row to compare them as one column
                made.draggable = true;
                made.addEventListener('dragstart', e => { if (e.target.closest('input, button, select')) { e.preventDefault(); return; } dragFrom = r; made.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.name); });
                made.addEventListener('dragend', () => { dragFrom = -1; made.classList.remove('is-dragging'); box.querySelectorAll('.is-drop-on, .is-drop-before').forEach(x => x.classList.remove('is-drop-on', 'is-drop-before')); });
                made.addEventListener('dragover', e => {
                    if (dragFrom < 0 || dragFrom === r) return;
                    e.preventDefault();
                    const rect = made.getBoundingClientRect();
                    const onto = e.clientY > rect.top + rect.height * 0.3 && e.clientY < rect.bottom - rect.height * 0.3;
                    made.classList.toggle('is-drop-on', onto);
                    made.classList.toggle('is-drop-before', !onto);
                });
                made.addEventListener('dragleave', () => made.classList.remove('is-drop-on', 'is-drop-before'));
                made.addEventListener('drop', e => {
                    e.preventDefault();
                    const from = rows[dragFrom];
                    const onto = made.classList.contains('is-drop-on');
                    made.classList.remove('is-drop-on', 'is-drop-before');
                    if (!from || from === row) return;
                    const viewsOf = x => x.entries.map(i => list[i].view);
                    const clash = viewsOf(from).some(v => viewsOf(row).includes(v));
                    const next = rows.filter(x => x !== from);
                    if (onto && from.kind !== 'calc' && row.kind !== 'calc' && !clash) {
                        // One column now: the row dropped on keeps its name and place
                        row.entries = row.entries.concat(from.entries);
                        row.group = row.name;
                    } else next.splice(next.indexOf(row), 0, from);
                    send(flatten(next, list));
                });
                lines.push(made);
            });

            // The line: + Calculated sits on it
            const calcBtn = el('button', 'btn btn-secondary query-calc-add', '+ Calculated');
            calcBtn.type = 'button';
            calcBtn.id = 'queryCalcBtn';
            calcBtn.title = 'A column worked out from others: IF, ROUND, CONCAT… over @columns';
            calcBtn.addEventListener('click', () => ctx.openCalc(null));
            const rule = line('query-rep-rule', {}, [], [calcBtn]);
            lines.push(rule);

            // Below: every column not used, a row per name across the views
            const keys = s.keyColumns || [];
            const hidden = c => keys.some(k => k.view === c.view && k.column === c.column);
            const names = [];
            const byName = new Map();
            liveViews().forEach(v => v.columns.forEach(c => {
                if (hidden({ view: v.id, column: c.name })) return;
                if (!byName.has(c.name)) { byName.set(c.name, {}); names.push(c.name); }
                byName.get(c.name)[v.id] = c.name;
            }));
            let firstFree = true;
            names.forEach(name => {
                const has = byName.get(name);
                const free = Object.keys(has).filter(v => !used.has(`${v}\u0000${name}`));
                if (!free.length) return;
                const cells = {};
                liveViews().forEach(v => {
                    if (!has[v.id]) return;
                    const isFree = free.includes(v.id);
                    const cell = at(v.id, 'query-free-cell' + (isFree ? '' : ' is-used'));
                    if (isFree) {
                        const b = el('button', 'query-free-btn font-mono', sample(v.id, name) || ' ');
                        b.type = 'button';
                        b.title = `${v.name} · ${name}: click to show it in the report`;
                        b.dataset.freeKey = `${v.id}\u0000${name}`;
                        b.setAttribute('aria-label', `Show ${v.name}'s ${name}`);
                        b.addEventListener('click', () => {
                            const list2 = entries();
                            list2.push({ view: v.id, column: name, fns: [] });
                            lastAdded = `${v.id}\u0000${name}`;
                            send(list2);
                        });
                        cell.appendChild(b);
                    }
                    cells[v.id] = cell;
                });
                const lead = [];
                if (firstFree) { lines.push(line('query-rep-head query-free-head', {}, [], [el('span', 'query-lead-text query-rep-title', 'Not used')])); firstFree = false; }
                const label = el('span', 'query-free-name font-mono', name);
                label.title = name;
                lead.push(label);
                if (free.length > 1) {
                    const cmp = el('button', 'query-free-compare');
                    cmp.type = 'button';
                    cmp.dataset.icon = 'scale';
                    cmp.title = `Compare ${name} across ${free.map(v => (view(v) || {}).name).join(', ')}: one column in the report`;
                    cmp.setAttribute('aria-label', `Compare ${name}`);
                    cmp.addEventListener('click', () => {
                        const list2 = entries();
                        free.forEach(v => list2.push({ view: v, column: name, fns: [], group: name }));
                        lastAdded = `${free[0]}\u0000${name}`;
                        send(list2);
                    });
                    lead.push(cmp);
                } else lead.push(el('span', 'query-free-compare-space'));
                const row = line('query-free-row', cells, [], lead);
                row.dataset.repKey = `free\u0000${name}`;
                lines.push(row);
            });
            if (firstFree) lines.push(el('p', 'form-hint query-free-none', 'Every column is in the report.'));
            lines.push(el('p', 'form-hint', 'Each value is from one row of the report: the first where every view matched. A row with two or more cells compares them; Results orders the columns as here.'));
            box.replaceChildren(...lines);
            ctx.injectIcons(box);
            slide(box, before);
            lastAdded = '';
        }

        return { render };
    }

    window.QueryColumns = { create };
})();
