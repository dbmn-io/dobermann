// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Run Batch's Source step with a workbook of several sheets: the sheet picker sits inside the file
 * drop zone, and a click on the drop zone opens the file chooser. Markup actions run from one
 * capture-phase listener on <html> (shared/dbmn-actions.js), before any listener on the picker, so
 * the picker's own stopPropagation came too late: clicking it to change sheet opened the file
 * chooser again. The real Source markup, the real action listener and the real scripts, in JSDOM.
 * The chooser is the same <input type=file> in VS Code and the web app.
 */
const ROOT = path.resolve(__dirname, '../../../../..');
const SHARED = path.join(ROOT, 'src/webviews/shared');
const SCRIPTS = ['dbmn-actions.js', 'json-comment-stripper.js', 'template-rename.js', 'batch-explainer.js', 'request-preview.js', 'dt-data-entry-grid.js',
    'dt-type-coercion.js', 'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

function sourceMarkup(): string {
    const source = fs.readFileSync(path.join(ROOT, 'src/screens/run-batch/run-batch-page.ts'), 'utf8');
    return source.slice(source.indexOf('<div id="csvUploadStep"'), source.indexOf('<div id="csvMappingStep"'));
}

const SHEETS = ['Stores', 'Items', 'Prices'];

function load(sheetDetails?: unknown[]) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${sourceMarkup()}</body>`, { runScripts: 'outside-only' });
    const win = dom.window as any;
    const posted: any[] = [];
    win.vscode = { postMessage: (m: unknown) => posted.push(m) };
    win.DbmnModal = { show: () => Promise.resolve({}) };
    win.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const doc = dom.window.document;
    let chooserOpened = 0;
    (doc.getElementById('csvModalFileInput') as any).click = () => { chooserOpened++; };
    // A three-sheet workbook has been chosen and read: the host's answer
    win.currentCSVFileName = 'three-sheets.xlsx';
    win.currentCSVFileSize = 20480;
    win.CSVHandler.handleMessage({ type: 'formatDetected', format: 'excel', metadata: { sheets: SHEETS, sheetDetails } });
    const click = (el: Element) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const select = () => doc.getElementById('excelSheetSelect') as HTMLSelectElement;
    return { win, doc, posted, click, select, opened: () => chooserOpened };
}

describe('Run Batch Source: changing the sheet of a workbook', () => {
    it('the sheet picker is drawn inside the drop zone, one choice per sheet', () => {
        const { doc, select } = load();
        expect(select(), 'the picker').to.not.equal(null);
        expect(doc.getElementById('csvDropzone')!.contains(select())).to.equal(true);
        expect(Array.from(select().options).map(o => o.text)).to.deep.equal(SHEETS);
    });

    it('a click on the sheet picker does not open the file chooser', () => {
        const { click, select, opened } = load();
        click(select());
        click(select().options[1]);
        expect(opened()).to.equal(0);
    });

    it('nor does a click on its label', () => {
        const { doc, click, opened } = load();
        click(doc.querySelector('#csvDropzone .sheet-selector label')!);
        click(doc.querySelector('#csvDropzone .sheet-selector')!);
        expect(opened()).to.equal(0);
    });

    it('choosing another sheet reads that sheet', () => {
        const { win, posted, click, select, opened } = load();
        click(select());
        select().value = '1';
        select().dispatchEvent(new win.Event('change', { bubbles: true }));
        expect(opened()).to.equal(0);
        const state = win.CSVHandler.getState();
        expect(state.selectedSheetIndex).to.equal(1);
        expect(state.sourceSheetName).to.equal('Items');
        win.DTDataIngestion.startFileConversion();
        const convert = posted.find(m => m.type === 'convertFileFormat');
        expect(convert?.options?.sheetIndex).to.equal(1);
    });

    it('a click on the hidden-rows choice does not open the file chooser either', () => {
        const hidden = { rowCount: 11, validationStatus: 'ok', filter: { hasHiddenRows: true, hiddenRowCount: 3 } };
        const { doc, click, opened } = load([hidden, hidden, hidden]);
        const radio = doc.querySelector('#csvDropzone #filterChoiceContainer input[type=radio]') as HTMLInputElement;
        expect(radio, 'the hidden-rows choice').to.not.equal(null);
        click(radio);
        click(radio.closest('label') ?? radio.parentElement!);
        expect(opened()).to.equal(0);
    });

    it('the rest of the drop zone and Change File still open the chooser', () => {
        const { doc, click, opened } = load();
        click(doc.querySelector('#csvDropzone .dropzone-file-name')!);
        expect(opened()).to.equal(1);
        click(Array.from(doc.querySelectorAll('#csvDropzone button')).find(b => b.textContent === 'Change File')!);
        expect(opened()).to.equal(2);
    });
});
