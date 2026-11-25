// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Validate stops on required cells left empty, like any other row problem.
 *
 * A chained Inventory Report had three rows (SKU-BAD-001..003) with no product.supplier.gln
 * and no reorderQty. The warning said only "6 empty fields detected", Filter Errors could not
 * show them among 28,396 rows, the step bar let Review be clicked, and Next stayed on
 * "Processing…".
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'date-read.js', 'dt-type-coercion.js',
    'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body><button id="csvNextBtn">Next</button>
        <div id="csvDataValidationStep"><div class="grid-hint"></div></div><table><tbody id="vanillaGridBody"></tbody></table></body>`,
        { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as any;
    w.vscode = { postMessage: () => undefined };
    for (const file of SCRIPTS) { w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    // Modifiers as the grid builds them from the template ({{supplierSku:string|opt}})
    const v = (name: string, optional = false) => ({ name, dataType: 'string', modifiers: w.DTDataEntryGrid.parseModifiersForGrid(optional ? 'opt' : '', 'string') });
    w.CSVHandler.setState({
        modalStep: 3, gridInitialized: true, gridUndoStack: [], gridRowsLoaded: true,
        virtualScrollActive: true, virtualScroll: { lastRenderedStart: -1, lastRenderedEnd: -1 },
        gridValidationErrors: new Map(),
        gridTemplateVariables: [v('location.gln'), v('product.supplier.gln'), v('reorderQty'), v('supplierSku', true)],
        gridDataModel: [
            ['0614141000012', '4012345000016', '200', ''],
            ['0614141000012', '', '', ''],          // SKU-BAD-001
            ['0614141000012', '4012345000016', '50', 'WAG-1'],
            ['0614141000012', '', '', ''],          // SKU-BAD-002
            ['0614141000012', '', '', 'WAG-2']      // SKU-BAD-003
        ]
    });
    return w;
}

describe('Run Batch Validate — required cells left empty', () => {
    it('names the empty columns and rows, and never counts an optional one', () => {
        const w = load();
        const result = w.DTDataEntryGrid.validateGridForBlankCells();
        expect(result.valid).to.equal(false);
        expect(result.message).to.equal('6 empty fields in 3 rows: product.supplier.gln (3), reorderQty (3)');
    });

    it('one check of every row: the rows to fix are Status\'s INVALID filter (on), the hint says so, the modal lines name each column', () => {
        const w = load();
        const issues = w.DTDataEntryGrid.refreshGridIssues();
        const s = w.CSVHandler.csvState;
        expect(issues).to.deep.include({ valid: false, rowCount: 3 });
        expect(issues.lines).to.deep.equal(['product.supplier.gln — empty in 3 rows', 'reorderQty — empty in 3 rows']);
        expect(Array.from(s.gridErrorRows)).to.deep.equal([1, 3, 4]);
        expect(s.gridErrorFilterActive).to.equal(true);
        expect(s.gridStatusFilter, 'Status: INVALID only').to.deep.equal(['invalid']);
        expect(w.document.querySelector('.grid-hint').textContent).to.match(/^Showing the 3 rows that need fixing, of 5\./);
    });

    it('one row to fix reads "the 1 row that needs fixing"', () => {
        const w = load();
        const s = w.CSVHandler.csvState;
        s.gridDataModel = s.gridDataModel.filter((_: unknown, i: number) => i !== 3 && i !== 4);
        w.DTDataEntryGrid.refreshGridIssues();
        expect(w.document.querySelector('.grid-hint').textContent).to.match(/^Showing the 1 row that needs fixing, of 3\./);
    });

    it('deleting a row checks every row again: delete all three and nothing is left to fix', () => {
        const w = load();
        w.DTDataEntryGrid.refreshGridIssues();
        w.DTDataEntryGrid.deleteGridRow(4);
        w.DTDataEntryGrid.deleteGridRow(3);
        expect(w.CSVHandler.csvState.gridErrorRows.size).to.equal(1);
        w.DTDataEntryGrid.deleteGridRow(1);
        const s = w.CSVHandler.csvState;
        expect(s.gridDataModel).to.have.length(2);
        expect(s.gridErrorRows).to.equal(null);
        expect(s.gridErrorFilterActive).to.equal(false);
        expect(w.document.querySelector('.grid-hint').textContent).to.match(/^2 rows\./);
    });

    it('Next with rows to fix: a "Can\'t continue yet" modal, Next released, still on Validate', async () => {
        const w = load();
        const shown: Array<{ title: string; body: HTMLElement }> = [];
        w.DbmnModal = { show: (opts: { title: string; body: HTMLElement }) => { shown.push(opts); return Promise.resolve({ actionId: 'fix' }); } };
        w.CSVHandler.goToNextStep();
        await new Promise(resolve => w.setTimeout(resolve, 50));
        expect(shown).to.have.length(1);
        expect(shown[0].body.textContent).to.contain('3 rows need fixing:').and.to.contain('reorderQty — empty in 3 rows');
        const next = w.document.getElementById('csvNextBtn');
        expect(next.disabled).to.equal(false);
        expect(next.textContent).to.equal('Next');
        expect(w.CSVHandler.csvState.modalStep).to.equal(3);
    });

    it('when the walk pressed Next, it stops quietly: no modal (the grid and step bar say why)', async () => {
        const w = load();
        const shown: unknown[] = [];
        w.DbmnModal = { show: (opts: unknown) => { shown.push(opts); return Promise.resolve({ actionId: 'fix' }); } };
        let cancelled = false;
        w.DTAutoAdvance = { status: () => ({ walking: true, checkingStep: 3 }), cancel: () => { cancelled = true; }, onStep: () => undefined, onWarning: () => undefined };
        w.CSVHandler.goToNextStep();
        await new Promise(resolve => w.setTimeout(resolve, 50));
        expect(shown).to.have.length(0);
        expect(cancelled).to.equal(true);
        expect(w.document.getElementById('csvNextBtn').disabled).to.equal(false);
    });

    it('with the bad rows deleted, Next goes on to Review with no modal', async () => {
        const w = load();
        const shown: unknown[] = [];
        w.DbmnModal = { show: (opts: unknown) => { shown.push(opts); return Promise.resolve({ actionId: 'fix' }); } };
        [4, 3, 1].forEach(i => w.DTDataEntryGrid.deleteGridRow(i));
        w.CSVHandler.goToNextStep();
        await new Promise(resolve => w.setTimeout(resolve, 300));
        expect(shown).to.have.length(0);
        expect(w.CSVHandler.csvState.modalStep).to.equal(4);
    });
});
