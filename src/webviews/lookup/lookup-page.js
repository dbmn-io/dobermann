// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's script (src/screens/lookup): the table as a data-entry grid, kept a moment
 * after each change (no Save button: a query that uses the table reads it as it is now).
 *
 * The table's own pieces do the editing (shared/dbmn-table.js: add-row, row-delete,
 * edit-columns, a key column); this says which column is the key, pastes a block from a
 * spreadsheet as rows (adding them), and says in the footer whether what shows is kept, or why not.
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const table = $('lookupTable');
    const status = $('lookupStatus');
    const keyPick = $('lookupKey');
    const count = n => Number(n || 0).toLocaleString();
    const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

    /** What the controller said: the limits, whether the table is gone, the save asked for last. */
    const ui = { limits: { columns: 50, rows: 1000 }, gone: false, seq: 0, timer: null };

    function say(text, tone) {
        status.textContent = text;
        if (tone) status.setAttribute('tone', tone); else status.removeAttribute('tone');
    }

    /** The data columns (not the row numbers), as kept: id, name, key. */
    function columnsNow() {
        return table.columns.map(c => ({ id: c.id, name: c.name || c.id, ...(c.key ? { key: true } : {}) }));
    }

    /** The key picker: each column, or none. */
    function drawKeyPick() {
        const columns = table.columns;
        const key = columns.find(c => c.key);
        keyPick.replaceChildren(...[{ id: '', name: 'No key' }, ...columns].map(c => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.name || c.id;
            return option;
        }));
        keyPick.value = key ? key.id : '';
    }

    /** Why what shows can't be kept yet, or ''. */
    function problem() {
        if (table.columns.length > ui.limits.columns) return `A lookup table has up to ${count(ui.limits.columns)} columns.`;
        if (table.rows.length > ui.limits.rows) return `A lookup table has up to ${count(ui.limits.rows)} rows.`;
        const problems = table.keyProblems;
        if (!problems.length) return '';
        const rows = new Set(problems.map(p => p.row)).size;
        return `${plural(rows, 'row')} to fix before it is kept: a key is in one row only, and every row needs one.`;
    }

    /** A change: kept a moment later, once it can be (several changes in a row are kept once). */
    function changed() {
        if (ui.gone) return;
        clearTimeout(ui.timer);
        ui.timer = setTimeout(save, 400);
    }
    function save() {
        const why = problem();
        if (why) { say(`Not kept: ${why}`, 'warn'); return; }
        ui.seq += 1;
        say('Keeping…');
        vscode.postMessage({ type: 'lookup.save', seq: ui.seq, table: { columns: columnsNow(), rows: table.rows } });
    }

    function load(kept, limits) {
        if (limits) ui.limits = limits;
        ui.gone = false;
        table.hidden = false;
        $('lookupGone').hidden = true;
        table.columns = kept.columns.map(c => ({ id: c.id, name: c.name, ...(c.key ? { key: true } : {}) }));
        table.rows = kept.rows.map(row => Object.assign({}, row));
        drawKeyPick();
        const why = problem();
        say(why ? `Not kept: ${why}` : `${plural(kept.rows.length, 'row')} · kept`, why ? 'warn' : '');
    }

    function gone() {
        ui.gone = true;
        clearTimeout(ui.timer);
        table.hidden = true;
        $('lookupGone').hidden = false;
        keyPick.disabled = true;
        say('Deleted', 'warn');
    }

    table.emptyText = ({ searched }) => (searched ? 'No rows match the search.' : 'No rows yet: add one below, or paste a block from a spreadsheet.');
    // Every change the table makes: a cell (typed, pasted, undone), a row added or deleted, a column renamed, added or deleted
    table.addEventListener('dbmn-table-edit', () => setTimeout(changed, 0));
    table.addEventListener('dbmn-table-rows', changed);
    table.addEventListener('dbmn-table-columns', event => {
        // (a column added past the limit: refused, and said why)
        if (event.detail.kind === 'add' && table.columns.length >= ui.limits.columns) {
            event.preventDefault();
            say(`A lookup table has up to ${count(ui.limits.columns)} columns.`, 'warn');
            return;
        }
        setTimeout(() => { drawKeyPick(); changed(); }, 0);
    });

    /** A block from a spreadsheet: across from the cell, and down, adding rows as it needs them. */
    table.addEventListener('dbmn-table-paste', event => {
        event.preventDefault();
        const held = table.held;
        if (!held) return;
        const columns = table.columns;
        const at = Math.max(0, columns.findIndex(c => c.id === held.id));
        const lines = String(event.detail.text).replace(/\r\n?/g, '\n').split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const rows = table.rows;
        let start = rows.indexOf(held.row);
        if (start < 0) start = rows.length;
        const room = ui.limits.rows - rows.length;
        const needed = Math.max(0, start + lines.length - rows.length);
        const adding = Math.min(needed, Math.max(0, room));
        for (let i = 0; i < adding; i++) {
            const row = {};
            columns.forEach(c => { row[c.id] = ''; });
            rows.push(row);
        }
        table.rows = rows;
        const changes = [];
        let left = 0;
        lines.forEach((line, r) => {
            const row = rows[start + r];
            line.split('\t').forEach((value, c) => {
                const column = columns[at + c];
                if (!row || !column) { left += 1; return; }
                changes.push({ row, id: column.id, value });
            });
        });
        if (changes.length) table.write(changes, 'paste');
        if (left) say(`${plural(left, 'value')} had no column or row to go in.`, 'warn');
        changed();
    });

    window.DbmnActions.register({
        'lookup:key': () => {
            const id = keyPick.value;
            table.columns.forEach(c => { c.key = c.id === id; });
            table.redrawHeads();
            table.rows = table.rows;   // (the key's marks drawn again)
            changed();
        }
    });

    window.addEventListener('message', event => {
        const message = event.data || {};
        switch (message.type) {
            case 'lookup.load': load(message.table, message.limits); break;
            case 'lookup.missing': gone(); break;
            case 'lookup.saved':
                if (message.seq === ui.seq) say(`${plural(message.rows, 'row')} · kept`);
                break;
            case 'lookup.notSaved':
                if (message.seq === ui.seq) say(`Not kept: ${message.reason}`, 'error');
                break;
            default: break;
        }
    });

    if (window.Icons) window.Icons.injectIcons(document.body);
    vscode.postMessage({ type: 'lookup.ready' });
})();
