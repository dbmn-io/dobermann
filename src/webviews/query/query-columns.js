// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's Columns step: what the report is made of, on the slots' grid (dbmn-lanes: a gutter, a
 * lane per view with a cell per run, an end column; the cells are .dbmn-cells).
 *
 * "In the report", in Results' order: first the Key (the columns the views are matched on, its
 * value in every run and view it joins), then the report's columns. A report column is its name
 * and its cells, each cell a view's column under that view's slot (a run's under its run): one
 * cell and the column is shown, two or more and they are compared (a value that differs from the
 * first cell's, after its functions, in amber). An empty place where a view can take part has a +
 * (that view's or that run's columns to put in it); a right-click on a cell gives its functions or
 * takes it out of the column; × takes the whole column back below. A row is dragged to another
 * place, or onto another row to compare them as one column. Calculated columns sit among them,
 * made in the calculation builder (query-calc.js). With none yet: "Nothing here yet".
 *
 * Below the line, every column not used (never a key), a row per name across the views, like a
 * spreadsheet: a click on a cell brings it up, shown (a run's is named "sku (C1)"); the Compare
 * icon beside a name, where two or more cells are free and one is in the compare, brings the row
 * up, compared. Whatever comes up is lit for a moment; rows that move slide to their new place.
 *
 * Runs are grouped where they are drawn (each run is still its own view underneath: its own
 * entries in what is sent). The page hands its helpers in (ctx). Styles: shared/query-columns.css.
 */
(function () {
    'use strict';

    /**
     * ctx: { el, at, line, views, view, viewAt, colour, post, setBusy, count, state, injectIcons,
     *        openCalc(calc|null), pickFns(ref, done), CALC_VIEW }
     *   line(className, cells, says, lead): a .dbmn-lanes-row; cells by view id (or { __span }), a cell each
     *   at(viewId, className): a run's cell in that view's colours
     */
    function create(ctx) {
        const { el, at, line, views, view } = ctx;
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
        /** A view's place among its lane's runs: 'BL', 'C1'… when its lane has several, else ''. */
        function runOf(v) {
            if (!v) return '';
            const head = v.runOf || v.id;
            const lane = views().filter(x => (x.runOf || x.id) === head);
            return lane.length > 1 ? (v.run || 'BL') : '';
        }
        /** Whose columns these are, for a menu's heading: "C1's columns", "Counts' columns". */
        function whose(v) {
            const who = runOf(v) || v.name;
            return `${who}${/s$/i.test(who) ? '’' : '’s'} columns`;
        }

        /* ---------- The key: what the views are matched on ---------- */

        /**
         * The key's columns, by view: a compare's (its Baseline's and each view's in it, the runs
         * sharing BL's), else the plain joins' (each join's two sides). { name, byView: Map, refs: Set }.
         */
        function keyOf() {
            const s = ctx.state();
            const byView = new Map();
            const names = [];
            const add = (viewId, column) => {
                if (!viewId || !column) return;
                if (!byView.has(viewId)) byView.set(viewId, column);
            };
            const compareJoins = (s.joins || []).filter(j => j.kind === 'compare');
            if (s.compare && compareJoins.length) {
                const first = compareJoins[0];
                (first.on || []).forEach((p, i) => {
                    if (p.left && p.left.column) names.push(p.left.column);
                    if (i === 0) add(p.left && p.left.view, p.left && p.left.column);
                });
                compareJoins.forEach(j => add(j.view, j.on && j.on[0] && j.on[0].right && j.on[0].right.column));
            } else {
                (s.keyColumns || []).forEach(k => {
                    add(k.sameView, k.sameColumn);
                    add(k.view, k.column);
                    if (k.sameColumn && !names.includes(k.sameColumn)) names.push(k.sameColumn);
                });
            }
            const refs = new Set();
            (s.joins || []).forEach(j => (j.on || []).forEach(p => {
                if (p.left && p.left.column) refs.add(`${p.left.view}\u0000${p.left.column}`);
                if (p.right && p.right.column) refs.add(`${j.view}\u0000${p.right.column}`);
            }));
            (s.keyColumns || []).forEach(k => { refs.add(`${k.view}\u0000${k.column}`); refs.add(`${k.sameView}\u0000${k.sameColumn}`); });
            return { name: names.join(', '), byView, refs };
        }

        /* ---------- The report's columns, as the host has them ---------- */

        /** The report's columns as the host has them, every entry a copy. */
        function entries() {
            return (ctx.state().columns || []).map(c => Object.assign({}, c, { fns: (c.fns || []).slice() }));
        }
        /** Entries as report columns: a compared column is the entries side by side with one group. The key's entries are the Key row's. */
        function reportRows(list, key) {
            const rows = [];
            list.forEach((c, index) => {
                if (c.view === ctx.CALC_VIEW) {
                    const calc = (ctx.state().calc || []).find(x => x.name === c.column);
                    rows.push({ kind: 'calc', name: c.column, calc, entries: [index] });
                    return;
                }
                if (!c.group && key.refs.has(id(c))) { rows.push({ kind: 'key', name: c.column, entries: [index] }); return; }
                const last = rows[rows.length - 1];
                if (c.group && last && last.kind === 'cells' && last.group === c.group) { last.entries.push(index); return; }
                rows.push({ kind: 'cells', group: c.group || '', name: c.group || c.column, entries: [index] });
            });
            rows.forEach(r => { r.key = r.kind === 'calc' ? `calc\u0000${r.name}` : r.entries.map(i => id(list[i])).join('\u0001'); });
            return rows;
        }
        /**
         * Send the report's columns (as entries, in order: the key's first). With nothing but the
         * key it is the key alone; with nothing at all, the key's own columns go (an empty select
         * is "every column" to the host, never an empty report).
         */
        function send(list) {
            const key = keyOf();
            const keys = list.filter(c => !c.group && key.refs.has(id(c)));
            let out = keys.concat(list.filter(c => !keys.includes(c)));
            if (!out.length) {
                const first = [...key.byView.entries()][0];
                if (!first) { if (window.DbmnToast) window.DbmnToast.info('A report needs one column at least.'); render(); return; }
                out = [{ view: first[0], column: first[1], fns: [] }];
            }
            ctx.setBusy('Updating…');
            ctx.post({ type: 'query.setSelect', select: out.map(c => Object.assign({ view: c.view, column: c.column }, c.fns && c.fns.length ? { fns: c.fns } : {}, c.group ? { group: c.group } : {})) });
        }
        /** Entries rebuilt from report rows (after a move, a merge or a removal). */
        function flatten(rows, list) {
            return rows.flatMap(r => r.entries.map(i => {
                const c = Object.assign({}, list[i]);
                if (r.kind === 'cells' && r.entries.length > 1) c.group = r.name;
                else if (r.kind === 'cells' && r.group) c.group = r.group;
                else delete c.group;
                return c;
            }));
        }

        /* ---------- Cells ---------- */

        /** A run's cell on a row: the view's colours, the spreadsheet's look. */
        function cellOf(viewId, more) {
            const cell = at(viewId, `dbmn-cell${more ? ' ' + more : ''}`);
            return cell;
        }
        /** The ƒ on a cell: on the cell's hover, or ƒ1 where a function is on. Its click opens the functions. */
        function fxButton(entry, list) {
            const has = (entry.fns || []).length;
            const b = el('button', 'dbmn-cell-fx query-rep-fx' + (has ? ' is-on' : ' is-quiet'), has ? `ƒ${has}` : 'ƒ');
            b.type = 'button';
            b.title = has ? 'Functions on this cell: click to see or change them' : 'Functions on this cell';
            b.setAttribute('aria-label', `Functions on ${entry.column}`);
            b.addEventListener('click', e => { e.stopPropagation(); functions(entry, list); });
            return b;
        }
        function functions(entry, list) {
            ctx.pickFns(entry, () => send(list));
        }
        /** Whether a view can take a cell in a row: in the compare (a plain query: every view), or the row has its cell already. */
        function canTakePart(v, row, list) {
            const compare = ctx.state().compare;
            if (!compare) return true;
            return (compare.views || []).includes(v.id) || row.entries.some(i => list[i].view === v.id);
        }

        /** An empty place on a report row: a + (on the row's hover) that lists the view's (the run's) columns to put in it. */
        function emptyPlace(v, row, rows, list, key) {
            if (!canTakePart(v, row, list)) return cellOf(v.id, 'is-blank');
            const add = cellOf(v.id, 'is-add query-rep-add');
            const cell = el('button', add.className);
            cell.type = 'button';
            cell.title = `Put one of ${whose(v).replace(/ columns$/, '')} columns in ${row.name}`;
            cell.setAttribute('aria-label', `Add a column of ${runOf(v) || v.name} to ${row.name}`);
            cell.addEventListener('click', e => {
                e.stopPropagation();
                // Its columns but the key's, and none this row has already
                const inRow = new Set(row.entries.map(i => id(list[i])));
                const columns = v.columns.filter(c => !key.refs.has(`${v.id}\u0000${c.name}`) && !inRow.has(`${v.id}\u0000${c.name}`));
                const items = [{ id: '\u0000head', label: whose(v), disabled: true }]
                    .concat(columns.map(c => ({ id: c.name, label: c.name, detail: sample(v.id, c.name) || ' ' })));
                if (!columns.length) items.push({ id: '\u0000none', label: 'Every column is in use', disabled: true });
                window.DbmnContextMenu.show(cell, items, column => {
                    if (!column || column.charAt(0) === '\u0000') return;
                    // Put in the row: it is one column now, compared under the row's name
                    const list2 = list.slice();
                    list2.push({ view: v.id, column, fns: [] });
                    row.entries = row.entries.concat(list2.length - 1);
                    row.group = row.name.replace(/ \([^)]*\)$/, '');
                    row.name = row.group;
                    lastAdded = `${v.id}\u0000${column}`;
                    send(flatten(rows, list2));
                });
            });
            return cell;
        }
        /** A cell of a report row: its value after its functions and amber where it differs from the
         * first cell in slot order (both the host's, columnCells), ƒ, and a right-click menu. */
        function reportCell(entry, index, row, list) {
            const said = (ctx.state().columnCells || [])[index];
            const value = said ? said.value : sample(entry.view, entry.column);
            const differs = row.entries.length > 1 && !!(said && said.differs);
            const cell = cellOf(entry.view, 'query-rep-cell' + (differs ? ' is-diff' : ''));
            cell.dataset.entry = String(index);
            const v = view(entry.view);
            const who = v ? (runOf(v) ? `${runOf(v)} · ${v.name}` : v.name) : '';
            cell.title = `${who} · ${entry.column}${value !== '' ? `: ${value}` : ''}${(entry.fns || []).length ? ` · ${(entry.fns || []).length} function${entry.fns.length === 1 ? '' : 's'}` : ''}. Right-click for its functions, or to take it out`;
            cell.append(el('span', 'dbmn-cell-value', value === '' ? ' ' : value), fxButton(entry, list));
            cell.addEventListener('contextmenu', e => {
                e.preventDefault();
                window.DbmnContextMenu.show(e, [
                    { id: 'fx', label: 'Functions…', icon: 'variable' },
                    { id: 'remove', label: row.entries.length > 1 ? 'Remove from this column' : 'Take it out of the report', icon: 'x' }
                ], choice => {
                    if (choice === 'fx') functions(entry, list);
                    if (choice === 'remove') {
                        const out = list.filter((_, i) => i !== index);
                        // One cell left: shown, under the column's name still; none: back below
                        send(out);
                    }
                });
            });
            return cell;
        }
        /** Every lane of a line drawn as spreadsheet cells (lines that only head or divide keep plain lanes). */
        function asCells(made) {
            made.querySelectorAll('.dbmn-lane').forEach(lane => lane.classList.add('dbmn-cells'));
            return made;
        }

        /** Rows that moved slide from where they were; what just came up is lit (nothing moves for a user who asks for less motion). */
        function slide(box, before) {
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            box.querySelectorAll('[data-rep-key]').forEach(row => {
                const was = before.get(row.dataset.repKey);
                if (lastAdded && row.dataset.repKey.split('\u0001').includes(lastAdded)) row.classList.add('is-new');
                if (was === undefined || reduce) return;
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

        /** The Compare icon: the Hub's scale (RelationGlyph), one colour wherever it is. */
        function scale() {
            if (window.RelationGlyph && window.RelationGlyph.join) return window.RelationGlyph.join('compare');
            const i = el('span', 'icon');
            i.dataset.icon = 'scale';
            return i;
        }

        function render() {
            const box = document.getElementById('queryColumns');
            const s = ctx.state && ctx.state();
            if (!box || !s) return;
            const before = new Map();
            box.querySelectorAll('[data-rep-key]').forEach(row => before.set(row.dataset.repKey, row.getBoundingClientRect().top));
            const key = keyOf();
            const list = entries();
            const rows = reportRows(list, key);
            const used = new Set(list.filter(c => c.view !== ctx.CALC_VIEW).map(id));
            const compare = s.compare;
            const lines = [];

            // In the report, in Results' order
            const head = el('div', 'query-rep-heading');
            head.append(el('span', 'query-rep-title', 'In the report'),
                el('span', 'query-rep-hint', compare
                    ? 'In Results’ order. A + in an empty place adds a column to it: one cell is shown, two or more are compared'
                    : 'In Results’ order. A + in an empty place adds a column to it: one cell is shown, two or more side by side'));
            lines.push(line('query-rep-head', { __span: head }, [], []));

            // The key first: its value in every run and view it joins
            if (key.byView.size) {
                const cells = {};
                liveViews().forEach(v => {
                    const column = key.byView.get(v.id) || (v.runOf && key.byView.get(v.runOf));
                    if (!column) { cells[v.id] = cellOf(v.id, 'is-blank'); return; }
                    const value = sample(v.id, column);
                    const c = cellOf(v.id, 'query-key-cell');
                    c.title = `${runOf(v) ? runOf(v) + ' · ' : ''}${v.name} · ${column}: the key (set on Join)`;
                    c.append(el('span', 'dbmn-cell-value', value === '' ? ' ' : value));
                    cells[v.id] = c;
                });
                const badge = el('span', 'query-rep-what is-key', 'Key');
                const name = el('span', 'query-rep-label', key.name);
                name.title = `${key.name}: what the views are matched on (Join). Always first in Results`;
                const made = asCells(line('query-rep-row query-rep-key', cells, [], [badge, name, el('span', 'query-rep-icon-space')]));
                made.dataset.repKey = 'key';
                lines.push(made);
            }

            const shown = rows.filter(r => r.kind !== 'key');
            shown.forEach(row => {
                const r = rows.indexOf(row);
                const lead = [];
                const grip = el('span', 'query-rep-grip', '⋮⋮');
                grip.title = 'Drag to another place, or onto another column to compare them as one';
                lead.push(grip);
                if (row.kind === 'calc') lead.push(el('span', 'query-rep-what is-calc', 'fx'));
                const name = el('input', 'query-rep-name');
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
                lead.push(name, el('span', 'query-rep-icon-space'));
                const cells = {};
                if (row.kind === 'calc') {
                    // The calculation, across the lanes: a click opens it in the builder
                    const calc = el('button', 'dbmn-cell is-calc query-rep-calc');
                    calc.type = 'button';
                    calc.title = 'Click to change the calculation';
                    calc.append(el('span', 'dbmn-cell-value', row.calc ? (row.calc.expr || row.calc.formula || '') : ''));
                    calc.addEventListener('click', () => ctx.openCalc(row.calc || null));
                    cells.__span = calc;
                } else {
                    liveViews().forEach(v => {
                        const index = row.entries.find(i => list[i].view === v.id);
                        cells[v.id] = index !== undefined ? reportCell(list[index], index, row, list) : emptyPlace(v, row, rows, list, key);
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
                const made = asCells(line('query-rep-row' + (row.kind === 'calc' ? ' is-calc' : row.entries.length > 1 ? ' is-compared' : ''), cells, [out], lead));
                made.dataset.repKey = row.key;
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
                    if (!from || from === row || from.kind === 'key') return;
                    const viewsOf = x => x.entries.map(i => list[i].view);
                    const clash = viewsOf(from).some(v => viewsOf(row).includes(v));
                    const next = rows.filter(x => x !== from);
                    if (onto && from.kind !== 'calc' && row.kind !== 'calc' && !clash) {
                        // One column now: the row dropped on keeps its name and place, and is lit
                        row.entries = row.entries.concat(from.entries);
                        row.name = row.name.replace(/ \([^)]*\)$/, '');
                        row.group = row.name;
                        lastAdded = id(list[from.entries[0]]);
                    } else next.splice(next.indexOf(row), 0, from);
                    send(flatten(next, list));
                });
                lines.push(made);
            });
            if (!shown.length) {
                const none = el('div', 'query-rep-none');
                none.append(el('b', '', 'Nothing here yet.'), el('span', '', compare
                    ? ' Click a cell below to show it, or the Compare icon beside a row’s name to compare the row.'
                    : ' Click a cell below to show it.'));
                lines.push(line('query-rep-empty', { __span: none }, [], []));
            }

            // The line: + Calculated sits on it
            const calcBtn = el('button', 'btn btn-secondary query-calc-add', '+ Calculated');
            calcBtn.type = 'button';
            calcBtn.id = 'queryCalcBtn';
            calcBtn.title = 'A column worked out from others: IF, ROUND, CONCAT… over @columns';
            calcBtn.addEventListener('click', () => ctx.openCalc(null));
            lines.push(line('query-rep-rule', { __span: el('div', 'dbmn-lanes-rule') }, [], [calcBtn]));

            // Below: every column not used (never a key's), a row per name across the views, like a spreadsheet
            const names = [];
            const byName = new Map();
            liveViews().forEach(v => v.columns.forEach(c => {
                if (key.refs.has(`${v.id}\u0000${c.name}`)) return;
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
                    if (!free.includes(v.id)) { cells[v.id] = cellOf(v.id, 'is-blank'); return; }
                    const shownName = runOf(v) ? `${name} (${runOf(v)})` : name;
                    const b = el('button', cellOf(v.id, 'query-free-cell').className);
                    b.type = 'button';
                    b.append(el('span', 'dbmn-cell-value', sample(v.id, name) || ' '));
                    b.title = `${runOf(v) ? runOf(v) + ' · ' : ''}${v.name} · ${name}: click to show it in the report${runOf(v) ? `, as ${shownName}` : ''}`;
                    b.dataset.freeKey = `${v.id}\u0000${name}`;
                    b.setAttribute('aria-label', `Show ${runOf(v) || v.name}'s ${name}`);
                    b.addEventListener('click', () => {
                        const list2 = entries();
                        // A run's cell is named for its run: two runs' sku shown apart read "sku (BL)", "sku (C1)"
                        list2.push(Object.assign({ view: v.id, column: name, fns: [] }, runOf(v) ? { group: shownName } : {}));
                        lastAdded = `${v.id}\u0000${name}`;
                        send(list2);
                    });
                    cells[v.id] = b;
                });
                const lead = [];
                if (firstFree) lead.push(el('span', 'query-free-title', 'Not used'));
                const label = el('span', 'query-rep-label', name);
                label.title = name;
                lead.push(label);
                // Compare: two or more free cells, one of them in the compare (a plain query compares by + or a drag)
                const inCompare = compare && free.some(v => (compare.views || []).includes(v));
                if (free.length > 1 && inCompare) {
                    const cmp = el('button', 'query-free-compare');
                    cmp.type = 'button';
                    cmp.append(scale());
                    const where = free.map(v => runOf(view(v)) || (view(v) || {}).name);
                    cmp.title = `Compare ${name} across ${where.join(', ')}: one column in the report`;
                    cmp.setAttribute('aria-label', `Compare ${name}`);
                    cmp.addEventListener('click', () => {
                        const list2 = entries();
                        free.forEach(v => list2.push({ view: v, column: name, fns: [], group: name }));
                        lastAdded = `${free[0]}\u0000${name}`;
                        send(list2);
                    });
                    lead.push(cmp);
                } else lead.push(el('span', 'query-rep-icon-space'));
                const row = asCells(line('query-free-row' + (firstFree ? ' is-first' : ''), cells, [], lead));
                row.dataset.repKey = `free\u0000${name}`;
                lines.push(row);
                firstFree = false;
            });
            if (firstFree) lines.push(line('query-free-none', { __span: el('span', 'form-hint', 'Every column is in the report.') }, [], []));
            lines.push(el('p', 'form-hint query-cols-note', 'Each value is from one row of the report: the first where every view matched.'));
            box.replaceChildren(...lines);
            ctx.injectIcons(box);
            slide(box, before);
            lastAdded = '';
        }

        return { render };
    }

    window.QueryColumns = { create };
})();
