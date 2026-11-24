// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Validate's grid: Ctrl+Z undoes every edit, delete and paste, in order, back to the data as
 * loaded. A delete's Ctrl+Z did nothing (the key listener was on the grid, and deleting the
 * row took the focus with it), and edits were never undoable.
 *
 * The grid is the design system's table (dbmn-table.js, tested in a browser by its own spec);
 * here the grid's side of it: what it does with the table's events and with the rows.
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'icons.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js',
    'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];
const BODY = JSON.stringify({ lines: [{ gtin: '{{gtin:string}}', uom: '{{uom:string|upper}}', qty: '{{qty:number}}' }] });

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body><button id="csvNextBtn">Next</button>
        <div id="csvDataValidationStep"><div class="csv-grid-entry" id="csvGridEntry"></div><div class="grid-hint"></div></div></body>`,
        { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as any;
    w.vscode = { postMessage: () => undefined };
    for (const file of SCRIPTS) { w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    w.CSVHandler.setState({ modalStep: 3, endpointConfig: { id: 'ep', body: BODY } });
    w.DTDataEntryGrid.initializeDataEntryGrid({ body: BODY });
    return w;
}
/** Load rows the way Run Batch does: each variable mapped to its column. */
function loadRows(w: any, rows: string[][]) {
    const vars = w.CSVHandler.csvState.gridTemplateVariables.map((v: any) => ({ ...v, mappedTo: v.name }));
    w.DTDataEntryGrid.populateGridFromMappedData({ headers: ['gtin', 'uom', 'qty'], rows }, vars);
}
const tick = (w: any, ms = 50) => new Promise(resolve => w.setTimeout(resolve, ms));
const ctrlZ = (w: any) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
const model = (w: any) => w.CSVHandler.csvState.gridDataModel;

/** An edit as the table makes one: the grid is told first (and may change the value), then it is written. */
function edit(w: any, place: number, col: number, value: string, kind = 'edit') {
    const row = model(w)[place];
    const changes = [{ row, id: String(col), index: place, value, old: row[col] }];
    const table = w.document.getElementById('validateGrid');
    const ok = table.dispatchEvent(new w.CustomEvent('dbmn-table-edit', { bubbles: true, cancelable: true, detail: { kind, changes, left: 0 } }));
    if (ok) changes.forEach(ch => { ch.row[ch.id] = ch.value; });
}

describe('Run Batch Validate — Ctrl+Z undoes edits and deletes, back to the data as loaded', () => {
    it('the grid is the shared table: a row number column, then a column per variable', () => {
        const w = load();
        const table = w.document.querySelector('#csvGridEntry dbmn-table#validateGrid');
        expect(table.hasAttribute('editable')).to.equal(true);
        expect(table.columns.map((c: any) => c.name)).to.deep.equal(['#', 'Status', 'gtin', 'uom', 'qty'], 'Status after the number (slice 5)');
        expect(model(w)).to.deep.equal([['', '', '']]);   // one empty row to type into
    });

    it('loaded rows: edit, delete, then Ctrl+Z twice restores the original', async () => {
        const w = load();
        const rows = [['00012345600012', 'EA', '1'], ['00012345600043', 'CS', '2'], ['00012345600050', 'PL', '3']];
        loadRows(w, rows);
        await tick(w, 100);
        const original = model(w).map((r: string[]) => r.slice());
        expect(original).to.deep.equal(rows);

        edit(w, 0, 1, 'BOX');
        expect(model(w)[0][1]).to.equal('BOX');
        w.DTDataEntryGrid.deleteGridRow(1);
        expect(model(w)).to.have.length(2);

        ctrlZ(w);   // the delete
        expect(model(w)).to.have.length(3);
        expect(model(w)[1]).to.deep.equal(original[1]);
        ctrlZ(w);   // the edit
        expect(model(w)).to.deep.equal(original);
        ctrlZ(w);   // nothing left: no change
        expect(model(w)).to.deep.equal(original);
    });

    it('typed rows: the same, row positions included', () => {
        const w = load();
        const addRow = () => w.DTDataEntryGrid.addGridRow({ skipFocus: true });
        addRow(); addRow();   // with the row an empty grid starts with: three
        [0, 1, 2].forEach(i => edit(w, i, 0, `G${i + 1}`));
        const typed = model(w).map((r: string[]) => r.slice());

        w.DTDataEntryGrid.deleteGridRow(1);
        expect(model(w).map((r: string[]) => r[0])).to.deep.equal(['G1', 'G3']);
        ctrlZ(w);
        expect(model(w)).to.deep.equal(typed);
        ctrlZ(w); ctrlZ(w); ctrlZ(w);   // the three edits
        expect(model(w).map((r: string[]) => r[0])).to.deep.equal(['', '', '']);
    });

    it('Ctrl+Z in the table is the grid\'s history, not the table\'s own', () => {
        const w = load();
        edit(w, 0, 0, 'A');
        const asked = new w.CustomEvent('dbmn-table-undo', { bubbles: true, cancelable: true, detail: { redo: false } });
        w.document.getElementById('validateGrid').dispatchEvent(asked);
        expect(asked.defaultPrevented).to.equal(true);
        expect(model(w)[0][0]).to.equal('');
    });

    it('what is typed keeps its column\'s rules: upper case, and only digits in a number', () => {
        const w = load();
        edit(w, 0, 1, 'box');
        edit(w, 0, 2, '1,2a0');
        expect(model(w)[0]).to.deep.equal(['', 'BOX', '120']);
    });

    it('a paste from a spreadsheet fills across and down, adding rows; one Ctrl+Z puts it back', () => {
        const w = load();
        w.DTDataEntryGrid.pasteIntoGrid('A1\tea\t5\nA2\tcs\t6', 0, 0);
        expect(model(w)).to.deep.equal([['A1', 'EA', '5'], ['A2', 'CS', '6']]);
        ctrlZ(w);
        expect(model(w)).to.deep.equal([['', '', '']]);
    });

    it('a new load starts a new history', async () => {
        const w = load();
        loadRows(w, [['A', 'EA', '1'], ['B', 'EA', '2']]);
        await tick(w, 100);
        w.DTDataEntryGrid.deleteGridRow(0);
        loadRows(w, [['C', 'CS', '3']]);
        await tick(w, 100);
        ctrlZ(w);
        expect(model(w)).to.deep.equal([['C', 'CS', '3']]);
    });
});
