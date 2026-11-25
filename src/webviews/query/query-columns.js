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
 * made in the shared Functions window (calculated columns as steps). With none yet: "Nothing here yet".
 *
 * Below the line, every column not used (never a key), a row per name across the views, like a
 * spreadsheet: a click on a cell brings it up, shown (a run's is named "sku (C1)"); the Compare
 * icon beside a name, where two or more cells are free and one is in the compare, brings the row
 * up, compared. Whatever comes up is lit for a moment; rows that move slide to their new place.
 *
 * Every column taken out of a report with no key leaves the step empty, "Nothing here yet", and
 * sends nothing: isEmpty() says so, and the page refuses Results until a column is put back.
 *
 * Runs are grouped where they are drawn (each run is still its own view underneath: its own
 * entries in what is sent). The page hands its helpers in (ctx). Styles: shared/query-columns.css.
 */
(function () {
    'use strict';

    /**
     * ctx: { el, at, line, views, view, viewAt, colour, post, setBusy, count, state, injectIcons,
     *        openCalc(calc|null), pickFns(ref, done), CALC_VIEW, stepsChanged?() }
     *   stepsChanged(): the step is empty, or not, with no answer from the host (the page's steps redraw)
     *   line(className, cells, says, lead): a .dbmn-lanes-row; cells by view id (or { __span }), a cell each
     *   at(viewId, className): a run's cell in that view's colours
     */
    function create(ctx) {
        const { el, at, line, views, view } = ctx;
        let dragFrom = -1;
        let lastAdded = '';
        /**
         * Every column taken out of a report with no key: the step is empty on the page and nothing
         * is sent (an empty select is "every column" to the host). Held as the host's columns at
         * that moment: once the host has others (a column put back), it is over. The page asks
         * isEmpty() before Results.
         */
        let emptied = null;
        const hostColumns = () => JSON.stringify(ctx.state().columns || []);
        const isEmpty = () => emptied !== null && emptied === hostColumns();

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
            if (isEmpty()) return [];
            // (a column put back: the page's steps hear that Results can be reached again)
            if (emptied !== null) { emptied = null; if (ctx.stepsChanged) ctx.stepsChanged(); }
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
                // No key either: empty here, nothing sent (Results is refused until a column is put back)
                if (!first) { emptied = hostColumns(); render(); if (ctx.stepsChanged) ctx.stepsChanged(); return; }
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
        /** A calculated column in words: where it starts, then its steps (the shared window's way of writing them). */
        function calcWords(calc) {
            if (!calc) return '';
            if (!calc.start) return calc.formula || calc.expr || '';
            const s = ctx.state() || {};
            const vs = ctx.views ? ctx.views() : [];
            const nameOf = id => {
                if (id === undefined) return '';
                if (String(id).startsWith('calc:')) return String(id).slice(5);
                const at = String(id).indexOf('\n');
                const v = vs.find(x => x.id === String(id).slice(0, at));
                return v ? `${v.run || v.name}.${String(id).slice(at + 1)}` : String(id).slice(at + 1);
            };
            const start = calc.start.col !== undefined ? nameOf(calc.start.col) : String(calc.start.value ?? '');
            const columns = vs.flatMap(v => (v.columns || []).map(c => ({ id: `${v.id}\n${c.name}`, label: nameOf(`${v.id}\n${c.name}`) }))).concat((s.calc || []).map(c => ({ id: `calc:${c.name}`, label: c.name })));
            const applied = (calc.steps || []).map(f => { const params = {}; Object.keys(f).forEach(k => { if (k !== 'fn') params[k] = f[k]; }); return { id: f.fn, params }; });
            return window.DbmnFunctions && window.DbmnFunctions.written ? window.DbmnFunctions.written(s.columnFunctions || [], applied, start, columns) : start;
        }
        /** The fx on a cell: on the cell's hover, or yellow where a function is on. Its click opens the functions. */
        function fxButton(entry, list) {
            // The shared fx: white to add, yellow with steps, which ones on hover (James, 2026-11-25: one fx everywhere).
            // Its place on the cell stays this step's (shown on the cell's hover while it has none)
            const has = (entry.fns || []).length;
            const b = window.DbmnFunctions.button({ steps: has, words: has && ctx.fnWords ? ctx.fnWords(entry.fns, entry.column) : 'Functions on this cell', label: `Functions on ${entry.column}`, onClick: () => functions(entry, list) });
            b.classList.add('dbmn-cell-fx', 'query-rep-fx', has ? 'is-on' : 'is-quiet');
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
        /** A compared row whose cells are columns of different names (BL's isSeed against C2's status). */
        function mixedRow(row, list) {
            if (!row.entries || row.entries.length < 2) return false;
            const first = list[row.entries[0]].column;
            return row.entries.some(i => list[i].column !== first);
        }
        /** Another of the cell's view's columns in its place (not the key's, nor one the row has already). */
        function changeColumn(anchor, entry, index, row, list) {
            const v = view(entry.view);
            if (!v || !window.DbmnContextMenu) return;
            const key = keyOf();
            const inRow = new Set(row.entries.map(i => id(list[i])));
            const columns = v.columns.filter(c => !key.refs.has(`${v.id}\u0000${c.name}`) && (c.name === entry.column || !inRow.has(`${v.id}\u0000${c.name}`)));
            window.DbmnContextMenu.show(anchor, [{ id: '\u0000head', label: whose(v), disabled: true }].concat(columns.map(c => ({ id: c.name, label: c.name, detail: sample(v.id, c.name) || ' ', checked: c.name === entry.column }))), column => {
                if (!column || column.charAt(0) === '\u0000' || column === entry.column) return;
                lastAdded = `${v.id}\u0000${column}`;
                send(list.map((e, i) => (i === index ? Object.assign({}, e, { column, fns: [] }) : e)));
            });
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
            // (a cell that differs only by characters you can't see says how, the host's words: James, 2026-11-23, "YES!")
            const hidden = differs && said && said.hidden ? said.hidden : '';
            cell.title = `${who} · ${entry.column}${hidden ? `: ${hidden}` : value !== '' ? `: ${value}` : ''}${(entry.fns || []).length ? ` · ${(entry.fns || []).length} function${entry.fns.length === 1 ? '' : 's'}` : ''}. Right-click for its functions, or to take it out`;
            // Columns of different names compared under one (James, 2026-11-22): each cell says its column, in grey over
            // its value, and a click on it changes the column; the row is taller for it
            if (mixedRow(row, list)) {
                const named = el('button', 'query-rep-colname', entry.column);
                named.type = 'button';
                named.title = `${who}'s ${entry.column}: click to compare another of its columns here`;
                named.addEventListener('click', e => { e.stopPropagation(); changeColumn(named, entry, index, row, list); });
                cell.classList.add('has-colname');
                cell.append(named);
            }
            const shown = el('span', 'dbmn-cell-value', value === '' ? ' ' : value);
            // (and its characters marked, as Results' ¶ marks them: the design system's DbmnTable.showSpecial)
            if (hidden && window.DbmnTable && window.DbmnTable.showSpecial) shown.replaceChildren(window.DbmnTable.showSpecial(value));
            cell.append(shown, fxButton(entry, list));
            cell.addEventListener('contextmenu', e => {
                e.preventDefault();
                window.DbmnContextMenu.show(e, [
                    { id: 'fx', label: 'Functions…', icon: 'variable' },
                    ...(row.entries.length > 1 ? [{ id: 'column', label: 'Change the column…', icon: 'compare-columns' }] : []),
                    { id: 'remove', label: row.entries.length > 1 ? 'Remove from this column' : 'Take it out of the report', icon: 'x' }
                ], choice => {
                    if (choice === 'column') changeColumn(cell, entry, index, row, list);
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

        /**
         * Rows that moved slide from where they were; what just came up is lit (nothing moves for a user who asks for less
         * motion). A column brought up from "Not used" (compared or shown) slides up from its own row there, lifted over the
         * others as it goes: it is the same row, moving (James, 2026-11-22).
         */
        function slide(box, before) {
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            box.querySelectorAll('[data-rep-key]').forEach(row => {
                let was = before.get(row.dataset.repKey);
                const isNew = !!lastAdded && row.dataset.repKey.split('\u0001').includes(lastAdded);
                if (isNew) row.classList.add('is-new');
                // (new up here: where it was below the line, by its column's name)
                const rising = was === undefined && isNew;
                if (rising) was = before.get(`free\u0000${lastAdded.split('\u0000')[1]}`);
                if (was === undefined || reduce) return;
                const delta = was - row.getBoundingClientRect().top;
                if (Math.abs(delta) < 1) return;
                row.style.transform = `translateY(${delta}px)`;
                row.style.transition = 'none';
                if (rising) row.classList.add('is-rising');
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    row.style.transition = `transform ${rising ? 520 : 320}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
                    row.style.transform = '';
                }));
                row.addEventListener('transitionend', () => { row.style.transition = ''; row.classList.remove('is-rising'); }, { once: true });
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

            // (no heading over the report's columns: it is plain what they are; James, 2026-11-22)
            // A calculated column whose columns are gone (its View changed): left out of Results, said here, with Change and Delete
            (s.brokenCalcs || []).forEach(b => {
                const said = document.createElement('dbmn-status');
                said.setAttribute('inline', '');
                said.setAttribute('tone', 'warn');
                said.className = 'query-calc-broken';
                // (a typed formula from before steps: its text, so it can be rebuilt by hand; James, 2026-11-25)
                const was = (s.calc || []).find(c => c.name === b.name) || null;
                const typed = was && !was.start ? (was.formula || was.expr || '') : '';
                said.append(`${b.name} is left out of Results. ${b.error}${typed ? ` It was: ${typed}` : ''} `);
                const change = el('button', 'text-link query-calc-broken-act', typed || (was && !was.start) ? 'Rebuild it' : 'Change it');
                change.type = 'button';
                change.addEventListener('click', () => ctx.openCalc(was));
                const drop = el('button', 'text-link query-calc-broken-act', 'Delete it');
                drop.type = 'button';
                drop.addEventListener('click', () => { ctx.setBusy('Updating…'); ctx.post({ type: 'query.removeCalc', name: b.name }); });
                said.append(change, ' · ', drop);
                lines.push(line('query-rep-broken', { __span: said }, [], []));
            });

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
                // (a calculated column: the yellow fx, its steps on hover; a click opens them)
                if (row.kind === 'calc') {
                    const n = row.calc && row.calc.steps ? row.calc.steps.length : 0;
                    const fx = window.DbmnFunctions.button({ steps: Math.max(1, n), words: calcWords(row.calc), label: `${row.name}: its steps`, onClick: () => ctx.openCalc(row.calc || null) });
                    fx.classList.add('query-rep-what', 'is-calc');
                    lead.push(fx);
                }
                const name = el('input', 'query-rep-name');
                name.value = row.name;
                name.title = row.name;
                name.setAttribute('aria-label', `${row.name}: its heading in Results`);
                name.spellcheck = false;
                name.addEventListener('change', () => {
                    const heading = name.value.trim();
                    if (!heading || heading === row.name) { name.value = row.name; return; }
                    if (row.kind === 'calc') {
                        // (renamed as steps; a typed one isn't run, so it keeps its name until it is rebuilt)
                        if (!row.calc || !row.calc.start) { name.value = row.name; return; }
                        ctx.post({ type: 'query.setCalcSteps', name: heading, was: row.name, start: row.calc.start, steps: row.calc.steps || [] });
                        return;
                    }
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
                    calc.append(el('span', 'dbmn-cell-value', calcWords(row.calc)));
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
                const made = asCells(line('query-rep-row' + (row.kind === 'calc' ? ' is-calc' : row.entries.length > 1 ? ' is-compared' : '') + (mixedRow(row, list) ? ' is-mixed' : ''), cells, [out], lead));
                made.dataset.repKey = row.key;
                // Drag: to another place, a line where it will land (above or below the row under the pointer; the last place
                // too). Only the line: no dropping onto a row (James, 2026-11-22: "unpredictable")
                made.draggable = true;
                made.addEventListener('dragstart', e => { if (e.target.closest('input, button, select')) { e.preventDefault(); return; } dragFrom = r; made.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.name); });
                made.addEventListener('dragend', () => { dragFrom = -1; made.classList.remove('is-dragging'); box.querySelectorAll('.is-drop-before, .is-drop-after').forEach(x => x.classList.remove('is-drop-before', 'is-drop-after')); });
                made.addEventListener('dragover', e => {
                    if (dragFrom < 0 || dragFrom === r || row.kind === 'key') return;
                    e.preventDefault();
                    const rect = made.getBoundingClientRect();
                    const after = e.clientY > rect.top + rect.height / 2;
                    made.classList.toggle('is-drop-after', after);
                    made.classList.toggle('is-drop-before', !after);
                });
                made.addEventListener('dragleave', () => made.classList.remove('is-drop-before', 'is-drop-after'));
                made.addEventListener('drop', e => {
                    e.preventDefault();
                    const from = rows[dragFrom];
                    const after = made.classList.contains('is-drop-after');
                    made.classList.remove('is-drop-before', 'is-drop-after');
                    if (!from || from === row || from.kind === 'key') return;
                    const next = rows.filter(x => x !== from);
                    next.splice(next.indexOf(row) + (after ? 1 : 0), 0, from);
                    send(flatten(next, list));
                });
                lines.push(made);
            });
            if (!shown.length) {
                const none = el('div', 'query-rep-none', compare ? 'Nothing to compare yet' : 'Nothing here yet');
                none.title = compare ? 'Click a cell below to show it, or the Compare icon beside a row’s name to compare the row.' : 'Click a cell below to show it.';
                lines.push(line('query-rep-empty', { __span: none }, [], []));
            }

            // + fx (a calculated column) on a bold line right across; "Not used" just under it, at the left (James, 2026-11-22)
            const calcBtn = el('button', 'query-calc-add', '+ fx');
            calcBtn.type = 'button';
            calcBtn.id = 'queryCalcBtn';
            calcBtn.title = 'Add a calculated column: a column or value, then steps';
            calcBtn.setAttribute('aria-label', 'Add a calculated column');
            calcBtn.addEventListener('click', () => ctx.openCalc(null));
            lines.push(line('query-rep-rule query-rep-rule-full', { __span: el('div', 'dbmn-lanes-rule') }, [], [calcBtn]));
            lines.push(line('query-unused-line', { __span: el('span') }, [], [el('span', 'query-unused-title', 'Not used')]));

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
            box.replaceChildren(...lines);
            ctx.injectIcons(box);
            slide(box, before);
            lastAdded = '';
        }

        return { render, isEmpty };
    }

    window.QueryColumns = { create };
})();
