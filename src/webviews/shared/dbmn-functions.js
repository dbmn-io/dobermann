// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnFunctions: the functions on a column, as a chain of steps in a dialog (the design system:
 * src/webviews/design-system). Query's Join and Columns use it, so "Upper case" is added, set and
 * tried the same way everywhere.
 *
 * The chain runs top to bottom (James, 2026-11-23: "top to bottom… we chain them together, we don't
 * nest them"): the source column, then a row per step: a grip to drag it up or down, its number, its
 * plain name and its values as short labelled fields (Table, From, To; Count; Replace, With), and ×.
 * At each row's right, one sample value as it leaves that step, so the value is seen passing down the
 * chain; Previous sample and Next sample go through the column's values. No function names and no
 * code anywhere ("we don't need to show it as a function"). + Add a step under the last one.
 *
 *   const applied = await DbmnFunctions.open({
 *       column: 'uom',                        // the source column, in plain words (what "Source column:" says)
 *       functions: [                          // what can be added (the screen's list and order, from its core service)
 *           { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
 *           { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', label: 'Count', number: true }, ')'] },
 *           { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Table', kind: 'lookup',
 *               options: [{ id, name, count, columns: [{ id, name }] }] }, ')'] }
 *               // `sql`: only its value pieces are read here (key, label, number, kind lookup): never shown.
 *               // A lookup piece: the table, then From (the column the value is in) and To (what it
 *               // becomes), from that table's columns: params { table, from, to }, all ids
 *       ],
 *       defaults: { n: 4 },                   // a value's starting value, by key
 *       applied: [{ id: 'trim', params: {} }],// the steps now, in order
 *       baseLabel: 'BL',                      // a column to compare against: "93% agree with BL" (leave out for none)
 *       sample: async (applied, { steps: true }) => ({ rows: [{ before, steps: [out1, …], after, base?,
 *                     missing?, missingAt?, twice?, twiceAt?, looked? }], agree?, error? }),
 *                                             // steps[i]: the value after the first i+1 steps. A lookup that didn't
 *                                             // find it: missing, missingAt (its step), steps only up to there.
 *                                             // Asked each time the steps or values change; an older answer is dropped
 *       onNewLookup: () => …                  // "+ New lookup table…" at the end of a table picker: the dialog
 *                                             // closes first, then the screen makes one (Reporting)
 *       onAddLookupRow: async ({ table, from, to, value, out }) => ({ ok } | { ok: false, error }),
 *                                             // "+ Add" on a value a Translate didn't find: the screen adds the row
 *                                             // (From = value, To = out); then the sample is asked again
 *       onOpenLookup: id => …                 // "Open" beside a table picker: the dialog closes first (a table
 *                                             // that is not among the options shows as missing, never another)
 *   });
 *   // [{ id, params }] in the chain's order, or null when cancelled
 *
 * Since 2026-11-25 (James: one window for Map, the Join and calculated columns; steps in sequence, never nested):
 *   - a function can be in the chain more than once (+ Add a step always lists every one);
 *   - a piece { key: 'other', kind: 'other', label } is another column of the row or a value typed in: a picker of
 *     `columns: [{ id, label }]` (or names) and "A value…"; its step's params are { col } or { value };
 *   - a number piece's `min` is its least (Round's places: 0; else 1);
 *   - a piece { key, label, kind: 'choice', options: [{ id, label }] } is a picker of fixed choices (Read date's Written as);
 *   - a sample row may say a step couldn't read its value: { failedAt, failed } (shown at that step, nothing after);
 *   - `calc: { name, start, starts: [{ id, label }] }` opens it for a calculated column: Name and Start from above
 *     the chain, Apply only with a name; the answer is then { name, start, steps } (steps as above).
 *     `sample(applied, { steps, start })` is asked with the column it starts from.
 *
 *   DbmnFunctions.button({ steps, words, onClick, label })   // the fx button: white "fx" with no steps (add one),
 *                                                            // yellow with some; `words` on hover (e.g. written(…))
 *
 * It draws and asks; it holds no rules about what a function does. Needs dbmn-modal.js and, for
 * + Add a step, dbmn-context-menu.js. Styles: shared/dbmn-functions.css.
 */
(function () {
    'use strict';
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const show = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
    const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

    /** A function's line, written with the column's name and its values: what the dialog shows, and what a chip's hover says. */
    function written(functions, applied, column, columns) {
        const colName = id => { const c = (columns || []).find(x => (x && x.id !== undefined ? x.id : x) === id); return c && c.label !== undefined ? c.label : id; };
        let text = column;
        (applied || []).forEach(a => {
            const def = (functions || []).find(f => f.id === a.id);
            if (!def) return;
            text = def.sql.map(piece => {
                if (piece === 'x') return text;
                if (typeof piece === 'string') return piece;
                const value = a.params ? a.params[piece.key] : '';
                if (piece.kind === 'other') return a.params && a.params.col !== undefined ? colName(a.params.col) : show(a.params ? a.params.value : '');
                if (piece.kind === 'choice') { const c = (piece.options || []).find(x => x.id === value); return c ? c.label : show(value); }
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
        let column = o.column || 'column';
        const withBase = !!o.baseLabel;
        const pieces = def => (def.sql || []).filter(p => p && typeof p === 'object');
        const defOf = id => functions.find(f => f.id === id);
        const tablesOf = def => { const p = pieces(def).find(x => x.kind === 'lookup'); return p ? (p.options || []) : []; };
        // Another column of the row, for a step's `other` value: { id, label } (or a name, as both)
        const columns = (Array.isArray(o.columns) ? o.columns : []).map(c => (c && typeof c === 'object' ? { id: c.id, label: c.label !== undefined ? c.label : c.id } : { id: c, label: c }));
        // A number box's least: Count's 1 unless the piece says (Round's places: 0)
        const least = piece => (piece.min !== undefined ? piece.min : 1);

        /** A step's values to start from: what it had, else the defaults; a lookup's From and To, else the table's first two columns. */
        function startParams(def, had) {
            const params = {};
            pieces(def).forEach(piece => {
                const was = had && had.params ? had.params[piece.key] : undefined;
                if (piece.kind === 'other') {
                    const col = had && had.params ? had.params.col : undefined, value = had && had.params ? had.params.value : undefined;
                    if (col !== undefined) params.col = col;
                    else if (value !== undefined || !columns.length) params.value = value !== undefined ? value : '';
                    else params.col = columns[0].id;
                    return;
                }
                params[piece.key] = was !== undefined ? was : defaults[piece.key] !== undefined ? defaults[piece.key] : '';
                if (piece.kind === 'choice' && !(piece.options || []).some(c => c.id === params[piece.key])) params[piece.key] = ((piece.options || [])[0] || {}).id || '';
                if (piece.kind === 'lookup') {
                    const table = (piece.options || []).find(t => t.id === params[piece.key]);
                    const cols = table && Array.isArray(table.columns) ? table.columns : [];
                    ['from', 'to'].forEach((k, at) => {
                        const saved = had && had.params ? had.params[k] : undefined;
                        params[k] = cols.some(c => c.id === saved) ? saved : cols[Math.min(at, cols.length - 1)] ? cols[Math.min(at, cols.length - 1)].id : (saved || '');
                    });
                }
            });
            return params;
        }
        // The chain: [{ id, params }], in order; a function can be there more than once (James, 2026-11-25), each step its own
        let steps = (o.applied || []).filter(a => a && defOf(a.id)).map(a => ({ id: a.id, params: startParams(defOf(a.id), a) }));
        let at = 0;              // the sample value followed down the chain
        let got = { rows: [] };  // the last answer
        let lookupAsked = null, newLookupAsked = false, dragFrom = null;

        const body = el('div', 'dbmn-modal-field dbmn-fx-form');
        const nav = el('div', 'dbmn-fx-nav');
        const prev = el('button', 'btn btn-secondary btn-sm', '‹ Previous sample');
        const next = el('button', 'btn btn-secondary btn-sm', 'Next sample ›');
        prev.type = next.type = 'button';
        prev.addEventListener('click', () => { at = Math.max(0, at - 1); drawValues(); });
        next.addEventListener('click', () => { at = Math.min(rowsNow().length - 1, at + 1); drawValues(); });
        nav.append(prev, next);
        const chain = el('div', 'dbmn-fx-chain');
        chain.setAttribute('role', 'list');
        chain.setAttribute('aria-label', 'Steps, in order');
        const plus = el('button', 'dbmn-fx-plus', '+ Add a step');
        plus.type = 'button';
        plus.setAttribute('aria-haspopup', 'menu');
        const clear = el('button', 'dbmn-fx-clear', 'Remove all steps');
        clear.type = 'button';
        clear.addEventListener('click', () => { steps = []; draw(); ask(); });
        const under = el('div', 'dbmn-fx-under');
        under.append(plus, clear);
        const agree = el('p', 'form-hint dbmn-fx-agree', '');
        const note = el('p', 'form-hint dbmn-fx-note', '');
        // A calculated column (o.calc: { name, start, starts: [{ id, label }] }): the same window, its Name and Start from
        // above the chain; the chain starts from that column instead of the one clicked (James, 2026-11-25: steps, no formula)
        const calc = o.calc ? { name: o.calc.name || '', start: o.calc.start, starts: Array.isArray(o.calc.starts) ? o.calc.starts : [] } : null;
        const startLabel = () => { const hit = calc && calc.starts.find(c => c.id === calc.start); return hit ? hit.label : column; };
        const okButton = () => { const box = body.closest('.dbmn-modal'); return box && box.querySelector('[data-action-id="ok"]'); };
        const nameNeeded = () => { const b = okButton(); if (b) b.disabled = !!calc && !calc.name.trim(); };
        if (calc) {
            column = startLabel();
            const top = el('div', 'dbmn-fx-calc');
            const nameField = el('label', 'dbmn-fx-field');
            const nameBox = el('input', 'dbmn-modal-input dbmn-fx-value dbmn-fx-calc-name');
            nameBox.value = calc.name;
            nameBox.placeholder = 'e.g. variance';
            nameBox.spellcheck = false;
            nameBox.addEventListener('input', () => { calc.name = nameBox.value; nameNeeded(); });
            nameField.append(el('span', '', 'Name'), nameBox);
            const startField = el('label', 'dbmn-fx-field');
            const startPick = el('select', 'dbmn-modal-input dbmn-fx-value dbmn-fx-calc-start');
            calc.starts.forEach(c => { const op = el('option', '', c.label); op.value = c.id; startPick.appendChild(op); });
            if (calc.start !== undefined) startPick.value = calc.start;
            calc.start = startPick.value;
            startPick.addEventListener('change', () => { calc.start = startPick.value; column = startLabel(); draw(); ask(); });
            startField.append(el('span', '', 'Start from'), startPick);
            top.append(nameField, startField);
            body.append(top);
        }
        body.append(nav, chain, under, agree, note);

        const rowsNow = () => (Array.isArray(got.rows) ? got.rows : []);
        const close = () => { const box = body.closest('.dbmn-modal'); const x = box && box.querySelector('.dbmn-modal-close'); if (x) x.click(); };

        /** A step's fields: a box or a picker per value, each with its short label; a lookup's Table, From and To. */
        function fieldsOf(step, def) {
            const fields = el('div', 'dbmn-fx-fields');
            pieces(def).forEach(piece => {
                if (piece.kind === 'choice') {
                    const field = el('label', 'dbmn-fx-field');
                    const pick = el('select', 'dbmn-modal-input dbmn-fx-choice');
                    (piece.options || []).forEach(c => { const op = el('option', '', c.label); op.value = c.id; pick.appendChild(op); });
                    pick.value = step.params[piece.key];
                    pick.dataset.fnValue = piece.key;
                    pick.addEventListener('change', () => { step.params[piece.key] = pick.value; ask(); });
                    field.append(el('span', '', piece.label || piece.key), pick);
                    fields.append(field);
                    return;
                }
                if (piece.kind === 'other') {
                    const field = el('label', 'dbmn-fx-field');
                    const pick = el('select', 'dbmn-modal-input dbmn-fx-other');
                    columns.forEach(c => { const op = el('option', '', c.label); op.value = 'col:' + c.id; pick.appendChild(op); });
                    const typed = el('option', '', 'A value…');
                    typed.value = 'value';
                    pick.appendChild(typed);
                    const box = el('input', 'dbmn-modal-input dbmn-fx-value');
                    box.type = 'text';
                    box.placeholder = 'value';
                    box.spellcheck = false;
                    box.setAttribute('aria-label', `${piece.label || 'Value'}: the value`);
                    const fit = () => { box.size = Math.min(30, Math.max(5, box.value.length + 1)); };
                    const showMode = () => {
                        const isValue = step.params.col === undefined;
                        pick.value = isValue ? 'value' : 'col:' + step.params.col;
                        box.hidden = !isValue;
                        box.value = isValue ? show(step.params.value) : '';
                        fit();
                    };
                    pick.addEventListener('change', () => {
                        if (pick.value === 'value') { delete step.params.col; step.params.value = ''; showMode(); box.focus(); }
                        else { delete step.params.value; step.params.col = pick.value.slice(4); showMode(); }
                        ask();
                    });
                    box.addEventListener('input', () => { fit(); step.params.value = box.value; ask(); });
                    showMode();
                    field.append(el('span', '', piece.label || 'Value'), pick, box);
                    fields.append(field);
                    return;
                }
                if (piece.kind === 'lookup') {
                    const tableField = el('label', 'dbmn-fx-field');
                    const pick = el('select', 'dbmn-modal-input dbmn-fx-lookup');
                    const none = el('option', '', 'Pick a table');
                    none.value = '';
                    pick.append(none, ...(piece.options || []).map(t => { const op = el('option', '', t.name); op.value = t.id; return op; }));
                    const value = step.params[piece.key];
                    // A table this column used that no longer exists: shown as missing, never another picked for it
                    if (value && !(piece.options || []).some(t => t.id === value)) {
                        const gone = el('option', 'dbmn-fx-missing', 'Missing table (deleted)');
                        gone.value = value;
                        pick.append(gone);
                        pick.classList.add('is-missing');
                        pick.title = 'This lookup table no longer exists: pick another, or remove this step';
                    }
                    if (typeof o.onNewLookup === 'function') {
                        const make = el('option', 'dbmn-fx-new', '+ New lookup table…');
                        make.value = '__new__';
                        pick.append(make);
                    }
                    pick.value = value || '';
                    pick.dataset.fnValue = piece.key;
                    tableField.append(el('span', '', piece.label || 'Table'), pick);
                    const side = (key, label) => {
                        const f = el('label', 'dbmn-fx-field');
                        const select = el('select', 'dbmn-modal-input dbmn-fx-lookup-col');
                        select.dataset.fnValue = key;
                        f.append(el('span', '', label), select);
                        select.addEventListener('change', () => { step.params[key] = select.value; ask(); });
                        return { f, select };
                    };
                    const from = side('from', 'From'), to = side('to', 'To');
                    const fill = () => {
                        const table = (piece.options || []).find(t => t.id === pick.value);
                        const cols = table && Array.isArray(table.columns) ? table.columns : [];
                        [[from.select, 'from', 0], [to.select, 'to', 1]].forEach(([select, key, n]) => {
                            select.replaceChildren(...cols.map(c => { const op = el('option', '', c.name); op.value = c.id; return op; }));
                            select.disabled = !cols.length;
                            const keep = cols.some(c => c.id === step.params[key]) ? step.params[key] : cols[Math.min(n, cols.length - 1)] ? cols[Math.min(n, cols.length - 1)].id : '';
                            select.value = keep;
                            step.params[key] = keep;
                        });
                    };
                    fill();
                    pick.addEventListener('change', () => {
                        if (pick.value === '__new__') { newLookupAsked = true; close(); return; }
                        pick.classList.toggle('is-missing', !!pick.selectedOptions[0] && pick.selectedOptions[0].classList.contains('dbmn-fx-missing'));
                        step.params[piece.key] = pick.value;
                        fill();
                        ask();
                    });
                    fields.append(tableField, from.f, to.f);
                    if (typeof o.onOpenLookup === 'function') {
                        const go = el('button', 'dbmn-fx-open', 'Open');
                        go.type = 'button';
                        go.title = 'Open this lookup table in Reporting';
                        go.addEventListener('click', () => { if (!pick.value || pick.value === '__new__') return; lookupAsked = pick.value; close(); });
                        fields.append(go);
                    }
                    return;
                }
                const field = el('label', 'dbmn-fx-field');
                const input = el('input', 'dbmn-modal-input dbmn-fx-value');
                input.type = piece.number ? 'number' : 'text';
                if (piece.number) input.min = String(least(piece));
                input.value = show(step.params[piece.key]);
                input.dataset.fnValue = piece.key;
                if (piece.key === 'to' && !piece.number) input.placeholder = 'nothing';
                // A box as wide as what is in it
                const fit = () => { if (!piece.number) input.size = Math.min(40, Math.max(16, input.placeholder.length, input.value.length + 1)); };
                fit();
                input.addEventListener('input', () => { fit(); step.params[piece.key] = piece.number ? Math.max(least(piece), parseInt(input.value, 10) || least(piece)) : input.value; ask(); });
                // A value copied from a table comes with a tab or spaces around it, which would match nothing
                input.addEventListener('paste', e => {
                    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
                    if (text === text.trim()) return;
                    e.preventDefault();
                    input.setRangeText(text.trim(), input.selectionStart, input.selectionEnd, 'end');
                    input.dispatchEvent(new Event('input'));
                });
                field.append(el('span', '', piece.label || piece.key), input);
                fields.append(field);
            });
            return fields;
        }

        /** The chain drawn: the source, then each step. Its values come in by drawValues. */
        function draw() {
            const src = el('div', 'dbmn-fx-row is-source');
            src.setAttribute('role', 'listitem');
            src.append(el('span', ''), el('span', ''), (() => { const w = el('div', 'dbmn-fx-what'); w.append(el('span', 'dbmn-fx-name', calc ? `Start from: ${column}` : `Source column: ${column}`)); return w; })(), el('div', 'dbmn-fx-out'), el('span', ''));
            const rows = [src];
            steps.forEach((step, i) => {
                const def = defOf(step.id);
                const row = el('div', 'dbmn-fx-row');
                row.setAttribute('role', 'listitem');
                row.dataset.at = String(i);
                row.dataset.fn = step.id;
                const grip = el('button', 'dbmn-fx-grip');
                grip.type = 'button';
                grip.innerHTML = GRIP;
                grip.title = 'Drag to move (Alt+↑ / Alt+↓)';
                grip.setAttribute('aria-label', `Move ${def.label}: drag, or Alt+Up / Alt+Down`);
                grip.addEventListener('mousedown', () => { row.draggable = true; });
                grip.addEventListener('keydown', e => {
                    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
                    const again = chain.querySelector(`.dbmn-fx-row[data-at="${Math.max(0, Math.min(steps.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))}"] .dbmn-fx-grip`);
                    if (again) again.focus();
                });
                row.addEventListener('dragstart', e => { dragFrom = i; row.classList.add('is-dragging'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } });
                row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('is-dragging'); chain.querySelectorAll('.is-drop-before, .is-drop-after').forEach(x => x.classList.remove('is-drop-before', 'is-drop-after')); dragFrom = null; });
                row.addEventListener('dragover', e => {
                    if (dragFrom === null) return;
                    e.preventDefault();
                    const r = row.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
                    chain.querySelectorAll('.is-drop-before, .is-drop-after').forEach(x => x.classList.remove('is-drop-before', 'is-drop-after'));
                    row.classList.add(before ? 'is-drop-before' : 'is-drop-after');
                });
                row.addEventListener('drop', e => {
                    e.preventDefault();
                    if (dragFrom === null) return;
                    const r = row.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
                    let to = i + (before ? 0 : 1);
                    if (dragFrom < to) to -= 1;
                    move(dragFrom, to);
                });
                const what = el('div', 'dbmn-fx-what');
                what.append(el('span', 'dbmn-fx-name', def.label));
                if (pieces(def).length) what.append(fieldsOf(step, def));
                const rm = el('button', 'dbmn-fx-remove', '×');
                rm.type = 'button';
                rm.title = 'Remove';
                rm.setAttribute('aria-label', `Remove ${def.label}`);
                rm.addEventListener('click', () => { steps.splice(i, 1); draw(); ask(); });
                row.append(grip, el('span', 'dbmn-fx-num', String(i + 1)), what, el('div', 'dbmn-fx-out'), rm);
                rows.push(row);
            });
            // (the line between steps: the chain)
            const linked = [];
            rows.forEach((r, i) => { if (i) linked.push(el('div', 'dbmn-fx-link')); linked.push(r); });
            chain.replaceChildren(...linked);
            plus.disabled = !functions.length;
            clear.hidden = !steps.length;
            drawValues();
        }
        function move(from, to) {
            if (from === to || to < 0 || to >= steps.length) return;
            const moved = steps.splice(from, 1)[0];
            steps.splice(to, 0, moved);
            draw();
            ask();
        }

        /** The followed value at the source and as it leaves each step. */
        function drawValues() {
            const list = rowsNow();
            at = Math.max(0, Math.min(at, list.length - 1));
            prev.disabled = at <= 0;
            next.disabled = at >= list.length - 1;
            const r = list[at];
            const outs = chain.querySelectorAll('.dbmn-fx-out');
            outs.forEach((out, n) => {
                out.replaceChildren();
                if (!r) return;
                if (n === 0) { out.append(value(show(r.before), '')); return; }
                const i = n - 1;
                const stepsOut = Array.isArray(r.steps) ? r.steps : null;
                const before = i === 0 ? show(r.before) : stepsOut ? show(stepsOut[i - 1]) : null;
                if (r.failedAt === i) { out.append(value(show(r.failed) || 'not read', 'is-missing')); return; }
                if (r.failedAt !== undefined && i > r.failedAt) { out.append(value('nothing (stopped above)', 'is-stopped')); return; }
                if (r.missing && (r.missingAt === i || (r.missingAt === undefined && i === steps.length - 1))) {
                    const looked = r.looked === undefined ? (before === null ? show(r.before) : before) : show(r.looked);
                    const names = lookupNamesOf(steps[i]);
                    const said = el('span', 'dbmn-fx-val is-missing', `${looked} · not in ${names ? names.from : 'the table'}`);
                    out.append(said);
                    if (names && typeof o.onAddLookupRow === 'function') out.append(addButton(out, looked, steps[i], names));
                    return;
                }
                if (r.missing && r.missingAt !== undefined && i > r.missingAt) { out.append(value('nothing (stopped above)', 'is-stopped')); return; }
                // (a screen that gives only the end: the last step shows it)
                const v = stepsOut ? stepsOut[i] : i === steps.length - 1 ? r.after : undefined;
                if (v === undefined) { out.append(value('…', 'is-stopped')); return; }
                const text = show(v);
                out.append(value(text, before !== null && text !== before ? 'is-changed' : ''));
                if (r.twice && r.twiceAt === i) {
                    const names = lookupNamesOf(steps[i]);
                    out.append(el('span', 'dbmn-fx-twice', `in ${names ? names.from : 'the table'} twice, first row used`));
                }
            });
            const pct = typeof got.agree === 'number' && isFinite(got.agree) ? Math.round(got.agree * 100) : null;
            agree.textContent = withBase && pct !== null && steps.length ? `${pct}% agree with ${o.baseLabel}` : '';
            agree.className = 'form-hint dbmn-fx-agree' + (pct === null ? '' : pct >= 90 ? ' is-good' : pct < 30 ? ' is-low' : '');
            note.textContent = got.error || (list.length ? '' : 'No values to show yet.');
        }
        function value(text, cls) {
            const v = el('span', 'dbmn-fx-val' + (cls ? ' ' + cls : ''), text);
            v.title = text;
            return v;
        }
        /** A lookup step's table and From/To by name; null for any other step. */
        function lookupNamesOf(step) {
            if (!step) return null;
            const def = defOf(step.id);
            const piece = def && pieces(def).find(p => p.kind === 'lookup');
            if (!piece) return null;
            const table = (piece.options || []).find(t => t.id === step.params[piece.key]);
            const name = id => ((table && table.columns) || []).find(c => c.id === id);
            return { table: table ? table.name : step.params[piece.key], from: (name(step.params.from) || {}).name || step.params.from, to: (name(step.params.to) || {}).name || step.params.to, tableId: step.params[piece.key], fromId: step.params.from, toId: step.params.to };
        }
        /**
         * "+ Add" on a value not found: a box for what it becomes; Enter (or Add) puts the row in the lookup
         * table through the screen, then the sample is asked again; Esc puts the line back.
         */
        function addButton(cell, val, step, names) {
            const b = el('button', 'btn btn-secondary btn-sm dbmn-fx-add', '+ Add');
            b.type = 'button';
            b.title = `Add ${val} to ${names.table}, and say what it becomes in ${names.to}`;
            b.addEventListener('click', () => {
                const was = Array.from(cell.childNodes);
                const box = el('input', 'dbmn-modal-input dbmn-fx-add-box');
                box.placeholder = `${names.to} for ${val}`;
                box.setAttribute('aria-label', `What ${val} becomes in ${names.to}`);
                box.spellcheck = false;
                box.autocomplete = 'off';
                const go = el('button', 'btn btn-primary btn-sm', `Add to ${names.table}`);
                go.type = 'button';
                const said = el('span', 'form-hint dbmn-fx-add-note', '');
                cell.replaceChildren(el('span', '', `${val} → `), box, go, said);
                box.focus();
                const add = async () => {
                    const out = box.value.trim();
                    if (!out) { box.focus(); return; }
                    go.disabled = true;
                    let answer;
                    try { answer = await o.onAddLookupRow({ table: names.tableId, from: names.fromId, to: names.toId, value: val, out }); }
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

        // + Add a step: every function, in the screen's order (one already in the chain can be added again)
        plus.addEventListener('click', () => {
            const left = functions;
            if (!left.length) return;
            const addStep = id => { const def = defOf(id); if (!def) return; steps.push({ id, params: startParams(def, null) }); draw(); ask(); };
            if (window.DbmnContextMenu) window.DbmnContextMenu.show(plus, left.map(f => ({ id: f.id, label: f.label })), addStep);
            else addStep(left[0].id);
        });

        /** What is in the chain, in order, with its values. */
        function picked() {
            return steps.map(s => {
                const def = defOf(s.id);
                const params = {};
                pieces(def).forEach(piece => {
                    if (piece.kind === 'other') { if (s.params.col !== undefined) params.col = s.params.col; else params.value = s.params.value; return; }
                    params[piece.key] = piece.number ? Math.max(least(piece), parseInt(s.params[piece.key], 10) || least(piece)) : s.params[piece.key];
                    if (piece.kind === 'lookup') ['from', 'to'].forEach(k => { params[k] = s.params[k]; });
                });
                return { id: s.id, params };
            });
        }

        let seq = 0;
        function ask() {
            seq += 1;
            const mine = seq;
            if (typeof o.sample !== 'function') return;
            let answer;
            try { answer = o.sample(picked(), calc ? { steps: true, start: calc.start } : { steps: true }); } catch (error) { answer = { error: error && error.message ? error.message : String(error) }; }
            Promise.resolve(answer).then(a => { if (mine === seq && a) { got = a; drawValues(); } },
                error => { if (mine === seq) { got = { rows: [], error: error && error.message ? error.message : String(error) }; drawValues(); } });
        }

        draw();
        ask();
        setTimeout(nameNeeded, 0);
        const answer = await window.DbmnModal.show({
            title: calc ? (o.calc.name ? 'Calculated column' : 'Add a calculated column') : 'Functions',
            body,
            size: 'lg',
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'ok', label: 'Apply', variant: 'primary' }
            ]
        });
        seq += 1;   // (an answer still on its way is for a dialog that has gone)
        if (newLookupAsked) {
            if (typeof o.onNewLookup === 'function') o.onNewLookup();
            return null;
        }
        if (lookupAsked !== null) {
            if (typeof o.onOpenLookup === 'function') o.onOpenLookup(lookupAsked);
            return null;
        }
        if (!answer || answer.actionId !== 'ok') return null;
        return calc ? { name: calc.name.trim(), start: calc.start, steps: picked() } : picked();
    }

    /**
     * The fx button, everywhere a value can have functions (Map's columns, the Join's, Columns' cells): white "fx" to add
     * one, yellow while it has some (the Columns list's calculated-column badge; James, 2026-11-25), which on hover.
     */
    function button(opts) {
        const b = opts || {};
        const on = (b.steps || 0) > 0;
        const fx = el('button', 'dbmn-fx-btn' + (on ? ' is-on' : ''), 'fx');
        fx.type = 'button';
        fx.title = on ? (b.words || 'Functions: click to see or change them') : 'Add a function';
        fx.setAttribute('aria-label', b.label || (on ? 'Functions on this column' : 'Add a function to this column'));
        if (typeof b.onClick === 'function') fx.addEventListener('click', event => { event.stopPropagation(); b.onClick(event); });
        return fx;
    }

    window.DbmnFunctions = { open, written, button };
})();
