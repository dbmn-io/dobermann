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
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'icons.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js',
    'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];
const BODY = JSON.stringify({ lines: [{ gtin: '{{gtin:string}}', uom: '{{uom:string}}' }] });

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body><button id="csvNextBtn">Next</button><button id="gridErrorFilterBtn">Filter Errors</button>
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
    w.DTDataEntryGrid.populateGridFromMappedData({ headers: ['gtin', 'uom'], rows }, vars);
}
const tick = (w: any, ms = 50) => new Promise(resolve => w.setTimeout(resolve, ms));
const ctrlZ = (w: any) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

/** Edit a cell the way a user does: focus it, type, leave it. */
function editCell(w: any, td: HTMLElement, value: string) {
    td.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
    td.textContent = value;
    td.dispatchEvent(new w.Event('input', { bubbles: true }));
    td.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
}

describe('Run Batch Validate — Ctrl+Z undoes edits and deletes, back to the data as loaded', () => {
    it('loaded rows (large-grid mode): edit, delete, then Ctrl+Z twice restores the original', async () => {
        const w = load();
        const rows = [['00012345600012', 'EA'], ['00012345600043', 'CS'], ['00012345600050', 'PL']];
        loadRows(w, rows);
        await tick(w, 100);
        const s = w.CSVHandler.csvState;
        const original = s.gridDataModel.map((r: string[]) => r.slice());
        expect(original).to.deep.equal(rows);

        const uomOfRow0 = w.document.querySelector('#vanillaGridBody tr[data-vs-row-index="0"]').querySelectorAll('.grid-cell')[1];
        editCell(w, uomOfRow0, 'BOX');
        expect(s.gridDataModel[0][1]).to.equal('BOX');
        w.document.querySelector('#vanillaGridBody tr[data-vs-row-index="1"] .row-delete-btn').click();
        expect(s.gridDataModel).to.have.length(2);

        ctrlZ(w);   // the delete
        expect(s.gridDataModel).to.have.length(3);
        expect(s.gridDataModel[1]).to.deep.equal(original[1]);
        ctrlZ(w);   // the edit
        expect(s.gridDataModel).to.deep.equal(original);
        ctrlZ(w);   // nothing left: no change
        expect(s.gridDataModel).to.deep.equal(original);
    });

    it('typed rows (small-grid mode): the same, row positions included', () => {
        const w = load();
        const addRow = () => w.DTDataEntryGrid.addGridRow({ skipFocus: true });
        addRow(); addRow();   // with the row an empty grid starts with: three
        const cells = () => Array.from(w.document.querySelectorAll('#vanillaGridBody tr')).map((tr: any) =>
            Array.from(tr.querySelectorAll('.grid-cell')).map((td: any) => td.textContent));
        const trs = w.document.querySelectorAll('#vanillaGridBody tr');
        trs.forEach((tr: any, i: number) => editCell(w, tr.querySelectorAll('.grid-cell')[0], `G${i + 1}`));
        const typed = cells();

        w.document.querySelectorAll('#vanillaGridBody tr')[1].querySelector('.row-delete-btn').click();
        expect(cells().map(r => r[0])).to.deep.equal(['G1', 'G3']);
        ctrlZ(w);
        expect(cells()).to.deep.equal(typed);
        expect(Array.from(w.document.querySelectorAll('#vanillaGridBody .row-num')).map((n: any) => n.textContent)).to.deep.equal(['1', '2', '3']);
        ctrlZ(w); ctrlZ(w); ctrlZ(w);   // the three edits
        expect(cells().map(r => r[0])).to.deep.equal(['', '', '']);
    });

    it('Ctrl+Z while typing in a cell puts that cell back first', async () => {
        const w = load();
        loadRows(w, [['00012345600012', 'EA']]);
        await tick(w, 100);
        const td = w.document.querySelector('#vanillaGridBody tr[data-vs-row-index="0"]').querySelectorAll('.grid-cell')[1];
        td.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
        td.textContent = 'BO';
        td.dispatchEvent(new w.Event('input', { bubbles: true }));
        ctrlZ(w);
        expect(w.CSVHandler.csvState.gridDataModel[0][1]).to.equal('EA');
    });

    it('a new load starts a new history', async () => {
        const w = load();
        loadRows(w, [['A', 'EA'], ['B', 'EA']]);
        await tick(w, 100);
        w.document.querySelector('#vanillaGridBody tr[data-vs-row-index="0"] .row-delete-btn').click();
        loadRows(w, [['C', 'CS']]);
        await tick(w, 100);
        ctrlZ(w);
        expect(w.CSVHandler.csvState.gridDataModel).to.deep.equal([['C', 'CS']]);
    });
});
