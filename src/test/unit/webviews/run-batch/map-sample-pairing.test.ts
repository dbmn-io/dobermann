// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Map & Transform's Sample cell shows "raw → result" for one sample row.
 *
 * Chaining new rows into a Run Batch that is already open kept the previous run's sample
 * checks, and Step 2 re-applied them: the result line showed the old rows' values beside the
 * new rows' raw values (gtin "EA → 00012345600050", reorderQty "low_stock → 200").
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js', 'dt-data-ingestion.js',
    'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];
const HEADERS = ['gtin', 'uom', 'reorderQty'];

type Posted = { type: string; variableIndex?: number; sampleValues?: string[] };

function load() {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="csvMappingStep"><div id="columnMappingTable"></div>
            <div id="updateTemplateOption" class="hidden"><input type="checkbox" id="updateTemplateCheckbox"><span id="updateTemplateRenames"></span></div>
        </div>
    </body>`, { runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { CSVHandler: any; DTTypeCoercion: any; vscode: { postMessage: (m: Posted) => void } };
    const posted: Posted[] = [];
    win.vscode = { postMessage: (m: Posted) => { posted.push(m); } };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    return { win, posted };
}

/** What the host sends back for a sample check: every value passes through unchanged. */
function answer(win: any, posted: Posted[]) {
    posted.splice(0).filter(m => m.type === 'validateSampleCoercion').forEach(m => {
        win.DTTypeCoercion.handleSampleCoercionResult({
            variableIndex: m.variableIndex, overallStatus: 'success', failedCount: 0,
            coercedSamples: (m.sampleValues || []).map(v => ({ original: v, coerced: v, success: true }))
        });
    });
}

function samples(win: any) {
    const out: Record<string, { raw: string; result: string }> = {};
    win.document.querySelectorAll('#columnMappingTable tr[data-variable]').forEach((row: any) => {
        const ownText = (el: any) => Array.from(el.childNodes as any[]).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('');
        out[row.getAttribute('data-variable')] = {
            raw: ownText(row.querySelector('.source-sample-cell')),
            result: ownText(row.querySelector('.target-sample-cell'))
        };
    });
    return out;
}

describe('Run Batch Map & Transform — sample raw and result are the same row', () => {
    it('a re-chain with new rows shows the new rows, not the previous run\'s checks', () => {
        const { win, posted } = load();
        const variables = () => HEADERS.map(name => ({ name, dataType: name === 'reorderQty' ? 'number' : 'string', mapped: false, mappedTo: null, column: null }));
        win.CSVHandler.setState({
            endpointId: 'ep-1', endpointConfig: { id: 'ep-1', dataLoadingConfig: {} },
            currentHeaders: HEADERS,
            currentParsedData: { headers: HEADERS, rows: [['00012345600050', 'EA', '200'], ['00012345600043', 'EA', '50']] },
            templateVariables: variables()
        });
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);
        expect(samples(win).gtin).to.deep.equal({ raw: '00012345600050', result: '00012345600050' });

        // Chained again into the open Run Batch: Step 1 resets, the new rows load, mappings stay.
        win.CSVHandler.resetCSVModal();
        win.CSVHandler.setState({
            currentHeaders: HEADERS,
            currentParsedData: { headers: HEADERS, rows: [['00012345600081', 'CS', '12'], ['00012345600098', 'EA', '7']] }
        });
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);

        expect(samples(win)).to.deep.equal({
            gtin: { raw: '00012345600081', result: '00012345600081' },
            uom: { raw: 'CS', result: 'CS' },
            reorderQty: { raw: '12', result: '12' }
        });
    });

    it('rows changed without a reset (a sort) get a fresh check instead of the cached one', () => {
        const { win, posted } = load();
        win.CSVHandler.setState({
            endpointId: 'ep-1', endpointConfig: { id: 'ep-1', dataLoadingConfig: {} },
            currentHeaders: HEADERS,
            currentParsedData: { headers: HEADERS, rows: [['A', 'EA', '1'], ['B', 'EA', '2']] },
            templateVariables: HEADERS.map(name => ({ name, dataType: 'string', mapped: false, mappedTo: null, column: null }))
        });
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);
        win.CSVHandler.csvState.currentParsedData.rows = [['B', 'EA', '2'], ['A', 'EA', '1']];
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);
        expect(samples(win).gtin).to.deep.equal({ raw: 'B', result: 'B' });
    });

    it('Back from the grid steps restores Step 2: right samples, Body / lines[] sections', () => {
        // A chained run skips ahead through Step 3 → 4, which makes the grid the source: its
        // columns are the variables, in template order. Back on Step 2 then indexed the Console
        // rows with the grid's column order (gtin showed "EA") and the variables lost their sections.
        const { win, posted } = load();
        const headers = ['gtin', 'description', 'uom', 'location.gln', 'status', 'reorderQty'];
        const rows = [['00012345600012', 'Premium Belly Rub Machine', 'EA', '0614141000012', 'low_stock', '200']];
        const variable = (name: string, bodyPath: string, dataType = 'string') =>
            ({ name, dataType, mapped: false, mappedTo: null, column: null, sources: ['body'], bodyPath });
        win.CSVHandler.setState({
            endpointId: 'ep-1', endpointConfig: { id: 'ep-1', dataLoadingConfig: {} },
            currentHeaders: headers, currentParsedData: { headers, rows }, sourceType: 'paste',
            templateVariables: [variable('location.gln', ''), variable('uom', 'lines[]'), variable('gtin', 'lines[]'), variable('reorderQty', 'lines[]', 'number')],
            gridTemplateVariables: [{ name: 'location.gln', dataType: 'string' }, { name: 'uom', dataType: 'string' },
                { name: 'gtin', dataType: 'string' }, { name: 'reorderQty', dataType: 'number' }]
        });
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);

        win.CSVHandler.useGridAsSource('location.gln,uom,gtin,reorderQty\n0614141000012,EA,00012345600012,200');
        win.CSVHandler.setState({ modalStep: 3 });
        win.CSVHandler.goToPreviousStep();
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);

        expect(win.CSVHandler.csvState.currentHeaders).to.deep.equal(headers);
        expect(samples(win)).to.deep.equal({
            'location.gln': { raw: '0614141000012', result: '0614141000012' },
            uom: { raw: 'EA', result: 'EA' },
            gtin: { raw: '00012345600012', result: '00012345600012' },
            reorderQty: { raw: '200', result: '200' }
        });
        const sections = Array.from(win.document.querySelectorAll('#columnMappingTable tr.map-section-row') as NodeListOf<HTMLElement>)
            .map(tr => tr.textContent?.trim());
        expect(sections).to.deep.equal(['Body', 'lines[]']);
    });

    it('an unmapped variable: no footer warning; Next stays enabled and says what is missing', () => {
        // Next used to be disabled with nothing in the footer saying why. Now it re-checks.
        const { win, posted } = load();
        const shown: Array<{ title: string; body: HTMLElement }> = [];
        (win as unknown as { DbmnModal: unknown }).DbmnModal = { show: (opts: { title: string; body: HTMLElement }) => { shown.push(opts); return Promise.resolve({ actionId: 'fix' }); } };
        win.CSVHandler.setState({
            endpointId: 'ep-1', endpointConfig: { id: 'ep-1', dataLoadingConfig: {} }, modalStep: 2,
            currentHeaders: ['gtin', 'uom'], currentParsedData: { headers: ['gtin', 'uom'], rows: [['00012345600012', 'EA']] },
            templateVariables: ['gtin', 'uom', 'reorderQty'].map(name => ({ name, dataType: 'string', mapped: false, mappedTo: null, column: null }))
        });
        win.CSVHandler.populateColumnMappingTable();
        answer(win, posted);
        expect(win.CSVHandler.csvState.activeNotification).to.equal(undefined);
        win.CSVHandler.goToNextStep();
        expect(shown).to.have.length(1);
        expect(shown[0].title).to.equal("Can't continue yet");
        expect(shown[0].body.textContent).to.contain('Map these variables to a column:').and.to.contain('reorderQty');
        expect(win.CSVHandler.csvState.modalStep).to.equal(2);
        const next = win.document.getElementById('csvNextBtn') as HTMLButtonElement | null;
        if (next) expect(next.disabled).to.equal(false);
    });
});
