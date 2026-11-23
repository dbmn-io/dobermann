// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnFunctions: functions on a column, ticked from a list, in a dialog (the design system:
 * src/webviews/design-system). Query's Join and Columns, Compare's Map and Run Batch's Map use
 * it, so "Upper case" is ticked, written and tried the same way everywhere.
 *
 * Each function is written as it works, around the column's own name, with its values typed in
 * place ("SUBSTR(sku, 1, [4])"). They apply in the order ticked (each ticked line says its place
 * when there is more than one). Beside the list: what they make together, and a few of the
 * column's values as they are and as the functions leave them; with a column to compare against
 * (Compare's BL), its values on the same rows too, and how many agree.
 *
 *   const applied = await DbmnFunctions.open({
 *       column: 'C1.sku',                     // the column, as the line writes it
 *       functions: [                          // what can be ticked (the screen's list, from its core service)
 *           { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
 *           { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', label: 'How many characters', number: true }, ')'] },
 *           { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup',
 *               options: [{ id, name, count, columns: [{ id, name }] }] }, ')'] }
 *               // a lookup piece: the table, then From (the column the value is in) and To (what it
 *               // becomes), from that table's columns: params { table, from, to }, all ids
 *       ],
 *       defaults: { n: 4 },                   // a value's starting value, by key
 *       applied: [{ id: 'trim', params: {} }],// what is ticked now, in order
 *       asLabel: 'Compares as',               // the heading over the values the functions make
 *       baseLabel: 'BL',                      // a column to compare against: its heading (leave out for none)
 *       sample: async applied => ({ rows: [{ before, after, base }], agree: 0.93, error }),
 *                                             // or, for a lookup, the whole table to show in their place:
 *                                             // { table: { columns: [{ id, name }], rows: [{ [id]: value }] }, value }
 *                                             // (the row whose From is `value`, this record's, is lit)
 *                                             // asked each time the ticks or values change; an answer
 *                                             // to an older ask is dropped; null: nothing to show
 *       onNewLookup: () => …                  // "+ New lookup table…" at the end of the table picker: the
 *                                             // dialog closes first, then the screen makes one (Reporting)
 *       onAddLookupRow: async ({ table, from, to, value, out }) => ({ ok } | { ok: false, error }),
 *                                             // "+ Add" on a value a Translate didn't find (James, 2026-11-23:
 *                                             // "option to ADD value for Group and DZ here too"): the screen adds
 *                                             // the row (From = value, To = out); then the sample is asked again.
 *                                             // A sample says which values weren't found: rows: [{ before, after,
 *                                             // missing?: true, twice?: true, looked? }], lookup: { table, from, to }
 *                                             // (ids; `looked`: the value as it reached Translate, when functions
 *                                             // before it changed it: that is what is said and added)
 *       onOpenLookup: id => …                 // "Open" beside a lookup table: the dialog closes first
 *                                             // (an applied table that is not among the options shows as
 *                                             // missing: never quietly another; the screen refuses to run it)
 *   });
 *   // [{ id, params }] in the order ticked, or null when cancelled
 *
 * It draws and asks; it holds no rules about what a function does. Needs dbmn-modal.js.
 * Styles: shared/dbmn-functions.css.
 */
(function () {
    'use strict';

    const ORDINAL = ['1st', '2nd', '3rd'];

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const show = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));

    /** A function's line, written with the column's name and its values: what the dialog shows, and what a chip's hover says. */
    function written(functions, applied, column) {
        let text = column;
        (applied || []).forEach(a => {
            const def = (functions || []).find(f => f.id === a.id);
            if (!def) return;
            text = def.sql.map(piece => {
                if (piece === 'x') return text;
                if (typeof piece === 'string') return piece;
                const value = a.params ? a.params[piece.key] : '';
                if (piece.kind === 'lookup') {
                    const option = (piece.options || []).find(o => o.id === value);
                    // (a table that has gone is said to be missing: nothing is looked up in its place)
                    if (!option) return value ? 'missing table' : '…';
                    const named = id => { const c = (option.columns || []).find(col => col.id === id); return c ? c.name : ''; };
                    const from = named(a.params ? a.params.from : ''), to = named(a.params ? a.params.to : '');
                    return from && to ? `${option.name}: ${from} → ${to}` : option.name;
                }
                return value === undefined ? '' : String(value);
            }).join('');
        });
        return text;
    }

    async function open(opts) {
        const o = opts || {};
        const functions = Array.isArray(o.functions) ? o.functions : [];
        const defaults = o.defaults || {};
        const column = o.column || 'column';
        const withBase = !!o.baseLabel;

        const body = el('div', 'dbmn-modal-field dbmn-fx-form');
        const group = el('div', 'dbmn-fx-list');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Functions');
        const made = el('code', 'dbmn-fx-sql', column);
        const clear = el('button', 'dbmn-fx-clear', 'Clear all');
        clear.type = 'button';
        const table = el('table', 'data-table dbmn-fx-sample');
        const headRow = el('tr');
        headRow.append(el('th', '', column), el('th', '', o.asLabel || 'Becomes'));
        if (withBase) headRow.append(el('th', '', o.baseLabel));
        const thead = el('thead');
        thead.append(headRow);
        const rows = el('tbody');
        table.append(thead, rows);
        const sampleBox = el('div', 'table-container dbmn-fx-sample-box');
        sampleBox.append(table);
        const agree = el('p', 'form-hint dbmn-fx-agree', '');
        const note = el('p', 'form-hint dbmn-fx-note', '');

        // The ticked ones, in the order they were ticked
        let order = (o.applied || []).map(a => a.id).filter(id => functions.some(f => f.id === id));
        let lookupAsked = null;
        let newLookupAsked = false;
        const lines = functions.map(def => {
            const had = (o.applied || []).find(a => a.id === def.id);
            const row = el('label', 'dbmn-fx-line');
            const box = el('input');
            box.type = 'checkbox';
            box.value = def.id;
            box.checked = !!had;
            const code = el('small', 'dbmn-fx-code');
            const inputs = {};
            const tick = on => {
                box.checked = on;
                order = order.filter(id => id !== def.id);
                if (on) order.push(def.id);
                ask();
            };
            (def.sql || []).forEach(piece => {
                if (piece === 'x') { code.append(el('strong', '', column)); return; }
                if (typeof piece === 'string') { code.append(document.createTextNode(piece)); return; }
                const start = had && had.params && had.params[piece.key] !== undefined ? had.params[piece.key] : defaults[piece.key];
                if (piece.kind === 'lookup') {
                    // A lookup table: picked from the ones saved, and opened in Reporting from here
                    const pick = el('select', 'dbmn-modal-input dbmn-fx-lookup');
                    pick.setAttribute('aria-label', piece.label || 'Lookup table');
                    const none = el('option', '', 'Pick a table');
                    none.value = '';
                    pick.append(none, ...(piece.options || []).map(t => {
                        const option = el('option', '', `${t.name}${t.count !== undefined ? ` (${Number(t.count).toLocaleString()})` : ''}`);
                        option.value = t.id;
                        return option;
                    }));
                    // A table this column used that no longer exists: shown as missing, never another picked for it
                    if (start && !(piece.options || []).some(t => t.id === start)) {
                        const gone = el('option', 'dbmn-fx-missing', 'Missing table (deleted)');
                        gone.value = start;
                        pick.append(gone);
                        pick.classList.add('is-missing');
                        pick.title = 'This lookup table no longer exists: pick another, or untick Translate values';
                    }
                    // A new table, made in Reporting: picking it closes the dialog (as Open does)
                    if (typeof o.onNewLookup === 'function') {
                        const make = el('option', 'dbmn-fx-new', '+ New lookup table…');
                        make.value = '__new__';
                        pick.append(make);
                        pick.addEventListener('change', () => {
                            if (pick.value !== '__new__') return;
                            newLookupAsked = true;
                            const close = body.closest('.dbmn-modal') && body.closest('.dbmn-modal').querySelector('.dbmn-modal-close');
                            if (close) close.click();
                        });
                    }
                    pick.value = start || '';
                    pick.addEventListener('change', () => { pick.classList.toggle('is-missing', !!pick.selectedOptions[0] && pick.selectedOptions[0].classList.contains('dbmn-fx-missing')); });
                    pick.dataset.fnValue = piece.key;
                    pick.addEventListener('click', e => e.preventDefault());
                    inputs[piece.key] = pick;
                    code.append(pick);
                    // From (the column this value is in) and To (what it becomes): the picked table's columns
                    const saved = had && had.params ? had.params : {};
                    const side = (key, label) => {
                        const select = el('select', 'dbmn-modal-input dbmn-fx-lookup-col');
                        select.setAttribute('aria-label', label);
                        select.dataset.fnValue = key;
                        select.addEventListener('click', e => e.preventDefault());
                        select.addEventListener('change', () => { if (box.checked) ask(); else tick(true); });
                        inputs[key] = select;
                        return select;
                    };
                    const fromPick = side('from', 'From: the column the value is in');
                    const toPick = side('to', 'To: what it becomes');
                    const fill = keep => {
                        const table = (piece.options || []).find(t => t.id === pick.value);
                        const cols = table && Array.isArray(table.columns) ? table.columns : [];
                        [[fromPick, 0], [toPick, 1]].forEach(([select, at]) => {
                            const was = keep ? select.value : '';
                            select.replaceChildren(...cols.map(c => { const option = el('option', '', c.name); option.value = c.id; return option; }));
                            select.disabled = cols.length === 0;
                            // (kept when the new table has that column; else the first, and the second for To)
                            const value = cols.some(c => c.id === was) ? was : cols[Math.min(at, cols.length - 1)] ? cols[Math.min(at, cols.length - 1)].id : '';
                            select.value = value;
                        });
                    };
                    fill(false);
                    if (saved.from && Array.from(fromPick.options).some(x => x.value === saved.from)) fromPick.value = saved.from;
                    if (saved.to && Array.from(toPick.options).some(x => x.value === saved.to)) toPick.value = saved.to;
                    pick.addEventListener('change', () => { fill(true); if (box.checked) ask(); else tick(true); });
                    code.append(el('span', 'dbmn-fx-word', ' from '), fromPick, el('span', 'dbmn-fx-word', ' to '), toPick);
                    if (typeof o.onOpenLookup === 'function') {
                        const go = el('button', 'dbmn-fx-open', 'Open');
                        go.type = 'button';
                        go.title = 'Open this lookup table in Reporting';
                        go.addEventListener('click', e => {
                            e.preventDefault();
                            if (!pick.value) return;
                            lookupAsked = pick.value;
                            const close = body.closest('.dbmn-modal') && body.closest('.dbmn-modal').querySelector('.dbmn-modal-close');
                            if (close) close.click();
                        });
                        code.append(go);
                    }
                    return;
                }
                const input = el('input', 'dbmn-modal-input');
                input.type = piece.number ? 'number' : 'text';
                if (piece.number) input.min = '1';
                input.value = start === undefined ? '' : String(start);
                input.setAttribute('aria-label', piece.label || piece.key);
                input.dataset.fnValue = piece.key;
                // A text box is as wide as what is in it, so a saved value is in sight when the dialog opens
                const fit = () => { if (!piece.number) input.size = Math.min(40, Math.max(6, input.value.length + 1)); };
                fit();
                // Typing a value ticks its function; a click in the box is not a click on the line
                input.addEventListener('input', () => { fit(); if (box.checked) ask(); else tick(true); });
                // A value copied from a table comes with a tab or spaces around it, which would match nothing
                input.addEventListener('paste', e => {
                    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
                    if (text === text.trim()) return;
                    e.preventDefault();
                    input.setRangeText(text.trim(), input.selectionStart, input.selectionEnd, 'end');
                    input.dispatchEvent(new Event('input'));
                });
                input.addEventListener('click', e => e.preventDefault());
                inputs[piece.key] = input;
                code.append(input);
            });
            box.addEventListener('change', () => tick(box.checked));
            const label = el('span', 'dbmn-fx-label', def.label);
            const place = el('b', 'dbmn-fx-order', '');
            label.append(place);
            row.append(box, label, code);
            group.append(row);
            return { def, box, inputs, place };
        });
        clear.addEventListener('click', () => { lines.forEach(l => { l.box.checked = false; }); order = []; ask(); });

        /** What is ticked, in order, with its values. */
        function picked() {
            return order.map(id => {
                const line = lines.find(l => l.def.id === id);
                const params = {};
                (line.def.sql || []).forEach(piece => {
                    if (!piece || typeof piece !== 'object') return;
                    const input = line.inputs[piece.key];
                    if (!input) return;
                    params[piece.key] = piece.number ? Math.max(1, parseInt(input.value, 10) || 1) : input.value;
                    if (piece.kind === 'lookup') ['from', 'to'].forEach(k => { if (line.inputs[k]) params[k] = line.inputs[k].value; });
                });
                return { id, params };
            });
        }

        let seq = 0;
        function ask() {
            seq += 1;
            const mine = seq;
            const applied = picked();
            made.textContent = written(functions, applied, column);
            clear.disabled = !applied.length;
            // With more than one ticked, each says when it applies
            lines.forEach(l => {
                const at = order.indexOf(l.def.id);
                l.place.textContent = order.length > 1 && at >= 0 ? (ORDINAL[at] || `${at + 1}th`) : '';
            });
            if (typeof o.sample !== 'function') return;
            let answer;
            try { answer = o.sample(applied); } catch (error) { answer = { error: error && error.message ? error.message : String(error) }; }
            Promise.resolve(answer).then(got => { if (mine === seq && got) draw(got); }, error => { if (mine === seq) draw({ error: error && error.message ? error.message : String(error) }); });
        }
        /** The values as they are and as the functions leave them (and the column compared with, beside them). */
        function draw(got) {
            if (got.table && Array.isArray(got.table.columns)) { drawLookup(got); return; }
            sampleBox.hidden = false;
            lutBox.hidden = true;
            const list = Array.isArray(got.rows) ? got.rows : [];
            const names = lookupNames(got.lookup);
            rows.replaceChildren(...list.map(r => {
                const tr = el('tr');
                const before = show(r.before), after = show(r.after);
                const changed = before !== after;
                // A value the lookup didn't find (or found twice): left as it was, and said so; one not found can be added
                if (names && (r.missing || r.twice)) {
                    // (`looked`: the value as it reached Translate, after any function before it; what is added)
                    const looked = r.looked === undefined ? before : show(r.looked);
                    const said = el('td', 'font-mono dbmn-fx-missing', `${looked} · ${r.twice ? `in ${names.from} twice` : `not in ${names.from}`}`);
                    tr.append(el('td', 'font-mono', before), said);
                    if (r.missing && typeof o.onAddLookupRow === 'function') said.append(' ', addButton(said, looked, got.lookup, names));
                    if (withBase) tr.append(el('td', 'font-mono', r.base === undefined ? '' : show(r.base)));
                    return tr;
                }
                tr.append(el('td', 'font-mono', before), el('td', 'font-mono' + (changed ? ' dbmn-fx-changed' : ''), after));
                if (withBase) {
                    const base = r.base === undefined ? '' : show(r.base);
                    tr.append(el('td', 'font-mono' + (r.base !== undefined && base === after ? ' dbmn-fx-agrees' : ''), base));
                }
                // A value too long for its column is cut short: the whole of it on hover
                Array.from(tr.cells).forEach(td => { td.title = td.textContent; });
                return tr;
            }));
            const pct = typeof got.agree === 'number' && isFinite(got.agree) ? Math.round(got.agree * 100) : null;
            agree.textContent = withBase && pct !== null ? `${pct}% agree with ${o.baseLabel}` : '';
            agree.className = 'form-hint dbmn-fx-agree' + (pct === null ? '' : pct >= 90 ? ' is-good' : pct < 30 ? ' is-low' : '');
            note.textContent = got.error || (list.length ? '' : 'No values to show yet.');
        }

        /** A lookup's table and From/To columns by name, from the table picker's options; null without one. */
        function lookupNames(lookup) {
            if (!lookup || lookup.table === undefined) return null;
            const tables = functions.flatMap(f => (f.sql || []).filter(p => p && typeof p === 'object' && p.kind === 'lookup').flatMap(p => p.options || []));
            const table = tables.find(t => t.id === lookup.table);
            const name = id => ((table && table.columns || []).find(c => c.id === id) || {}).name || id;
            return { table: table ? table.name : lookup.table, from: name(lookup.from), to: name(lookup.to) };
        }
        /**
         * "+ Add" on a value not found: a box on its line for what it becomes; Enter (or Add) puts the
         * row in the lookup table through the screen, then the sample is asked again; Esc puts the line back.
         */
        function addButton(cell, value, lookup, names) {
            const b = el('button', 'btn btn-secondary btn-sm dbmn-fx-add', '+ Add');
            b.type = 'button';
            b.title = `Add ${value} to ${names.table}, and say what it becomes in ${names.to}`;
            b.addEventListener('click', () => {
                const was = Array.from(cell.childNodes);
                const box = el('input', 'dbmn-modal-input dbmn-fx-add-box');
                box.placeholder = `${names.to} for ${value}`;
                box.setAttribute('aria-label', `What ${value} becomes in ${names.to}`);
                box.spellcheck = false;
                box.autocomplete = 'off';
                const go = el('button', 'btn btn-primary btn-sm', `Add to ${names.table}`);
                go.type = 'button';
                const said = el('span', 'form-hint dbmn-fx-add-note', '');
                cell.replaceChildren(el('span', '', `${value} → `), box, ' ', go, ' ', said);
                box.focus();
                const add = async () => {
                    const out = box.value.trim();
                    if (!out) { box.focus(); return; }
                    go.disabled = true;
                    let answer;
                    try { answer = await o.onAddLookupRow({ table: lookup.table, from: lookup.from, to: lookup.to, value, out }); }
                    catch (error) { answer = { ok: false, error: error && error.message ? error.message : String(error) }; }
                    if (answer && answer.ok) { ask(); return; }
                    go.disabled = false;
                    said.textContent = (answer && answer.error) || "It couldn't be added.";
                };
                go.addEventListener('click', add);
                box.addEventListener('keydown', event => {
                    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); add(); }
                    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cell.replaceChildren(...was); }
                });
            });
            return b;
        }

        /**
         * A lookup: the whole table, scrolling, From and To marked (the other columns quieter), and
         * the row this record's value is in lit and in view.
         */
        const lutBox = el('div', 'table-container dbmn-fx-lut-box');
        lutBox.hidden = true;
        function drawLookup(got) {
            sampleBox.hidden = true;
            lutBox.hidden = false;
            const applied = picked();
            const lookup = applied.map(a => a.params).find(p => p && p.table !== undefined) || {};
            const columns = got.table.columns;
            const rowsOf = Array.isArray(got.table.rows) ? got.table.rows : [];
            const value = got.value === undefined || got.value === null ? null : show(got.value).trim();
            const lut = el('table', 'data-table dbmn-fx-lut');
            const head = el('tr');
            columns.forEach(c => {
                const th = el('th', c.id === lookup.from ? 'is-from' : c.id === lookup.to ? 'is-to' : '', c.name);
                if (c.id === lookup.from) th.append(el('small', '', ' from'));
                if (c.id === lookup.to) th.append(el('small', '', ' to'));
                head.append(th);
            });
            const thead = el('thead');
            thead.append(head);
            const tbody = el('tbody');
            let lit = null;
            rowsOf.forEach(r => {
                const tr = el('tr');
                const used = value !== null && show(r[lookup.from]).trim() === value;
                if (used) { tr.className = 'is-used'; if (!lit) lit = tr; }
                columns.forEach(c => {
                    const td = el('td', 'font-mono' + (c.id === lookup.from ? ' is-from' : c.id === lookup.to ? ' is-to' : ''), show(r[c.id]));
                    td.title = td.textContent;
                    tr.append(td);
                });
                tbody.append(tr);
            });
            lut.append(thead, tbody);
            lutBox.replaceChildren(lut);
            if (lit && lit.scrollIntoView) lit.scrollIntoView({ block: 'nearest' });
            agree.textContent = '';
            note.textContent = got.error || (rowsOf.length === 0 ? 'The table has no rows yet.'
                : value === null ? '' : lit ? '' : `${value} isn't in ${(columns.find(c => c.id === lookup.from) || {}).name || 'From'}.`);
        }

        const side = el('div', 'dbmn-fx-side');
        const top = el('p', 'form-hint dbmn-fx-top');
        top.append(el('span', '', 'Tick any. They apply in the order you tick them.'), clear);
        side.append(top, group);
        const result = el('div', 'dbmn-fx-side');
        result.append(el('p', 'form-hint', o.asLabel ? `The column ${o.asLabel.charAt(0).toLowerCase()}${o.asLabel.slice(1)}` : 'It becomes'), made, sampleBox, lutBox, agree, note);
        body.append(side, result);
        ask();

        const answer = await window.DbmnModal.show({
            title: o.title || `Functions on ${column}`,
            body,
            size: 'lg',
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'ok', label: 'Apply', variant: 'primary' }]
        });
        seq += 1;   // (an answer still on its way is for a dialog that has gone)
        if (newLookupAsked) {
            o.onNewLookup();
            return null;
        }
        if (lookupAsked !== null) {
            if (typeof o.onOpenLookup === 'function') o.onOpenLookup(lookupAsked);
            return null;
        }
        if (!answer || answer.actionId !== 'ok') return null;
        return picked();
    }

    window.DbmnFunctions = { open, written };
})();
