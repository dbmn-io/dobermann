// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A file Run Batch can't use says so, on Source, in plain words, the same whether it was chosen or
 * dropped, and Import Data is off unless there is something to import (James, 2026-11-24:
 * "something comes up on screen and then it disappears. There's no error message"). Before, a
 * chosen file of the wrong type, or one the host couldn't read, went to the host as 'showError',
 * which nothing took: no word on screen at all.
 *
 * The real Source markup and scripts in JSDOM, fed the host's answers as run-batch.controller.ts
 * sends them; the footer's toasts are recorded. One case per file of the not-tables set.
 */
const ROOT = path.resolve(__dirname, '../../../../..');
const SHARED = path.join(ROOT, 'src/webviews/shared');
const SCRIPTS = ['dbmn-actions.js', 'json-comment-stripper.js', 'template-rename.js', 'batch-explainer.js', 'request-preview.js', 'dt-data-entry-grid.js',
    'date-read.js', 'dt-type-coercion.js', 'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

function sourceMarkup(): string {
    const source = fs.readFileSync(path.join(ROOT, 'src/screens/run-batch/run-batch-page.ts'), 'utf8');
    return source.slice(source.indexOf('<div id="csvUploadStep"'), source.indexOf('<div id="csvMappingStep"'));
}

interface Toast { level: string; text: string; persistent?: boolean; source?: string }
const CHOOSE = 'choose a CSV, Excel, TSV or text file';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function load() {
    // Import Data is the footer's #csvNextBtn
    const dom = new JSDOM(`<!DOCTYPE html><body>${sourceMarkup()}<button id="csvNextBtn" disabled>Import Data</button></body>`, { runScripts: 'outside-only' });
    const win = dom.window as any;
    const posted: any[] = [];
    let toasts: Toast[] = [];
    win.vscode = { postMessage: (m: unknown) => posted.push(m) };
    win.DbmnModal = { show: () => Promise.resolve({}) };
    win.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    win.DbmnToast = {
        show: (level: string, text: string, opts: { persistent?: boolean; source?: string } = {}) => {
            if (opts.source) toasts = toasts.filter(t => t.source !== opts.source);
            toasts.push({ level, text, persistent: opts.persistent, source: opts.source });
            return { dismiss: () => undefined };
        },
        clear: (source: string) => { toasts = toasts.filter(t => t.source !== source); }
    };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const doc = dom.window.document;
    const $ = (id: string) => doc.getElementById(id) as HTMLElement;
    const errors = () => toasts.filter(t => t.level === 'error').map(t => t.text);
    const importOn = () => { win.CSVHandler.updateCSVNavigationButtons?.(); return !($('csvNextBtn') as HTMLButtonElement).disabled; };
    const onSource = () => !$('csvUploadStep').classList.contains('hidden');
    const file = (name: string, content: string | Uint8Array) => new win.File([content], name);

    /** Read until the page asks the host what the file is (nothing to answer when it stops first). */
    async function readUntilDetect(): Promise<any> {
        for (let i = 0; i < 50; i++) {
            const asked = posted.find(m => m.type === 'detectFileFormat');
            if (asked) return asked;
            await wait(10);
        }
        return undefined;
    }
    const choose = (f: unknown) => win.CSVHandler.handleModalCSVUpload({ target: { files: [f] } });
    const drop = (f: unknown) => {
        $('csvDropzone').classList.add('drag-over');
        $('csvDropzone').dispatchEvent(Object.assign(new win.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [f] } }));
    };
    /** The host's answer to detectFileFormat. */
    const detected = (answer: Record<string, unknown>) => win.CSVHandler.handleMessage({ type: 'formatDetected', ...answer });
    return { win, doc, $, posted, errors, importOn, onSource, file, choose, drop, detected, readUntilDetect };
}

describe('Run Batch Source: a file it can\'t use says so (the not-tables set)', () => {
    for (const [name, content] of [['dog.png', '\x89PNG'], ['dog.pdf', '%PDF-1.4'], ['kennel.zip', 'PK'], ['letter.docx', 'PK'], ['dogs.json', '[{"sku":"J-1"}]']]) {
        for (const how of ['chosen', 'dropped'] as const) {
            it(`${name}, ${how}: "isn't a table", and Import Data stays off`, () => {
                const h = load();
                h[how === 'chosen' ? 'choose' : 'drop'](h.file(name, content));
                expect(h.errors()).to.deep.equal([`${name} isn't a table: ${CHOOSE}.`]);
                expect(h.importOn(), 'Import Data').to.equal(false);
                expect(h.posted.filter(m => m.type === 'showError' || m.type === 'detectFileFormat')).to.deep.equal([]);
                expect(h.onSource()).to.equal(true);
            });
        }
    }

    for (const how of ['chosen', 'dropped'] as const) {
        it(`renamed-text.xlsx, ${how}: "isn't an Excel file DBMN can read", said once the drop zone is back; Import Data off`, async () => {
            const h = load();
            h[how === 'chosen' ? 'choose' : 'drop'](h.file('renamed-text.xlsx', 'this is not a spreadsheet, just text renamed .xlsx'));
            expect(await h.readUntilDetect(), 'asked the host').to.not.equal(undefined);
            h.detected({ error: 'Failed to detect file format: Not an Excel workbook (an .xlsx file is a zip)' });
            await wait(600);
            expect(h.errors()).to.deep.equal(["renamed-text.xlsx isn't an Excel file DBMN can read."]);
            expect(h.importOn(), 'Import Data').to.equal(false);
            expect(h.onSource()).to.equal(true);
            expect(h.$('csvDropzone').classList.contains('drag-over'), 'no drag highlight left').to.equal(false);
            expect((h.$('csvModalFileInput') as HTMLInputElement).value, 'the same file can be chosen again').to.equal('');
        });
    }

    it('empty.csv: "is empty", Import Data off', async () => {
        const h = load();
        h.choose(h.file('empty.csv', ''));
        await h.readUntilDetect();
        h.detected({ format: 'csv', metadata: {} });
        await wait(600);
        expect(h.errors()).to.deep.equal(['empty.csv is empty.']);
        expect(h.importOn()).to.equal(false);
    });

    it('header-only.csv: "has a header and no rows", Import Data off', async () => {
        const h = load();
        h.choose(h.file('header-only.csv', 'sku,uom,note\n'));
        await h.readUntilDetect();
        h.detected({ format: 'csv', metadata: {} });
        await wait(600);
        expect(h.errors()).to.deep.equal(['header-only.csv has a header and no rows.']);
        expect(h.importOn()).to.equal(false);
    });

    it('no-delimiters.txt: taken, as one column (a list of values)', async () => {
        const h = load();
        h.choose(h.file('no-delimiters.txt', 'Sit.\nStay.\nGood dog have a treat\n'));
        await h.readUntilDetect();
        h.detected({ format: 'custom', metadata: { delimiter: ',' } });
        expect(h.errors()).to.deep.equal([]);
        expect(h.importOn()).to.equal(true);
    });

    describe('first-sheet-empty.xlsx (sheets Empty, Data)', () => {
        const sheets = {
            format: 'excel',
            metadata: {
                sheets: ['Empty', 'Data'],
                sheetDetails: [
                    { name: 'Empty', rowCount: 1, validationStatus: 'error', validationMessage: 'No table found. Define a named table in Excel, or ensure data starts at cell A1.' },
                    { name: 'Data', rowCount: 2, validationStatus: 'valid' }
                ]
            }
        };
        async function opened() {
            const h = load();
            h.choose(h.file('first-sheet-empty.xlsx', 'PK'));
            await h.readUntilDetect();
            h.detected(sheets);
            return h;
        }

        it('opens on Data, the first sheet with rows, and can import it', async () => {
            const h = await opened();
            const picker = h.$('excelSheetSelect') as HTMLSelectElement;
            expect(picker.value).to.equal('1');
            expect(h.win.CSVHandler.getState().sourceSheetName).to.equal('Data');
            expect(h.errors()).to.deep.equal([]);
            expect(h.importOn()).to.equal(true);
        });

        it('picking Empty says so and turns Import Data off; picking Data again clears it', async () => {
            const h = await opened();
            const picker = h.$('excelSheetSelect') as HTMLSelectElement;
            picker.value = '0';
            picker.dispatchEvent(new h.win.Event('change', { bubbles: true }));
            expect(h.errors()).to.deep.equal(['Sheet Empty has no rows: pick another sheet.']);
            expect(h.importOn()).to.equal(false);
            picker.value = '1';
            picker.dispatchEvent(new h.win.Event('change', { bubbles: true }));
            expect(h.errors()).to.deep.equal([]);
            expect(h.importOn()).to.equal(true);
        });
    });

    it('rows that can\'t be read after Import Data: the reason, without the host\'s prefix; the file is let go', () => {
        const h = load();
        h.win.currentCSVFileName = 'stock.xlsx';
        h.win.CSVHandler.handleMessage({ type: 'formatConversionError', error: 'Failed to convert file format: Sheet "Returns" is empty' });
        expect(h.errors()).to.deep.equal(["DBMN couldn't read the rows in stock.xlsx: Sheet \"Returns\" is empty."]);
        expect(h.importOn()).to.equal(false);
    });

    it('stays until dismissed, and choosing another file clears it', async () => {
        const h = load();
        h.choose(h.file('dog.png', 'x'));
        expect(h.errors()).to.have.length(1);
        h.choose(h.file('stock.csv', 'sku\nA1\n'));
        expect(h.errors()).to.deep.equal([]);
    });
});
