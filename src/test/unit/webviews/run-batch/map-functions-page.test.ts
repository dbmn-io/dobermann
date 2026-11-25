// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Run Batch's Map with functions (James, 2026-11-25): the Transform drop-down is gone; each mapped column has the fx
 * button (white to add, yellow with steps); a column with steps shows In above Out in its Sample, worked out by the
 * host (map-functions.ts: answered here as the host would); a column without steps is as before; the steps are
 * remembered with the column.
 *
 * Loads the REAL src/webviews/shared/data-transformer.js and its modules into JSDOM.
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'date-read.js', 'dt-type-coercion.js', 'dt-data-ingestion.js',
    'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'dbmn-functions.js', 'data-transformer.js'];
const HEADERS = ['sku', 'uom', 'qty'];
const ROWS = [['SKU-1', ' ea ', '5'], ['SKU-2', 'CS', '7']];
const UOM_STEPS = [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'ifis', is: 'EA', then: 'EACH', else: '' }];

type Posted = { type: string; seq?: number; variable?: string; fns?: unknown; endpoint?: { dataLoadingConfig?: Record<string, unknown> } };

function load(dataLoadingConfig: Record<string, unknown>) {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="csvMappingStep"><div id="columnMappingTable"></div>
            <div id="updateTemplateOption" class="hidden"><input type="checkbox" id="updateTemplateCheckbox"><span id="updateTemplateRenames"></span></div>
        </div>
        <select id="batchErrorModeSelect"><option value="continue" selected>Continue processing</option></select>
    </body>`, { runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { CSVHandler: any; vscode: { postMessage: (m: Posted) => void } };
    const posted: Posted[] = [];
    win.vscode = { postMessage: (m: Posted) => { posted.push(m); } };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const variable = (name: string) => ({ name, dataType: 'string', mapped: false, mappedTo: null, column: null });
    win.CSVHandler.setState({
        endpointId: 'ep-1',
        endpointConfig: { id: 'ep-1', name: 'Inventory', dataLoadingConfig: { detectArrays: true, repeatableArrays: [], ...dataLoadingConfig } },
        currentHeaders: HEADERS,
        currentParsedData: { headers: HEADERS, rows: ROWS },
        templateVariables: ['sku', 'uom', 'qty'].map(variable)
    });
    const row = (name: string) => dom.window.document.querySelector(`#columnMappingTable tr[data-variable="${name}"]`) as HTMLElement;
    /** The host's answers, as map-functions.ts gives them: the list, then each sample asked for. */
    const answer = async () => {
        await new Promise(r => setTimeout(r, 0));
        if (posted.some(m => m.type === 'map.functions')) {
            win.CSVHandler.handleMessage({ type: 'map.functionsList', functions: [{ id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] }], defaults: {} });
        }
        await new Promise(r => setTimeout(r, 0));
        posted.filter(m => m.type === 'map.functionsSample').forEach(m => {
            win.CSVHandler.handleMessage({ type: 'map.functionsSample', seq: m.seq, variable: m.variable,
                rows: [{ before: ' ea ', steps: ['ea', 'EA', 'EACH'], after: 'EACH' }, { before: 'CS', steps: ['CS', 'CS', 'CS'], after: 'CS' }] });
        });
        await new Promise(r => setTimeout(r, 0));
    };
    const save = () => { win.CSVHandler.updateEndpointConfiguration(); return posted.filter(m => m.type === 'saveEndpoint').pop()?.endpoint?.dataLoadingConfig; };
    return { win, dom, posted, row, answer, save };
}

describe('Run Batch — Map with functions (fx)', () => {
    it('the Transform drop-down is gone; each mapped column has the fx button, white with no steps', () => {
        const { win, row } = load({});
        win.CSVHandler.populateColumnMappingTable();
        expect(row('sku').querySelector('.source-format-select')).to.equal(null);
        const fx = row('sku').querySelector('.map-fx-slot .dbmn-fx-btn') as HTMLElement;
        expect(fx, 'fx on a mapped column').to.not.equal(null);
        expect(fx.textContent).to.equal('fx');
        expect(fx.classList.contains('is-on')).to.equal(false);
        // (no steps: the Sample as before, one value)
        expect(row('sku').querySelector('.map-sample-cell')!.classList.contains('has-fx')).to.equal(false);
    });

    it('steps remembered with the column come back: yellow fx, and the Sample shows In above Out from the host', async () => {
        const { win, row, posted, answer } = load({ columnMappings: { uom: 'uom' }, columnFunctions: { uom: UOM_STEPS } });
        win.CSVHandler.populateColumnMappingTable();
        await answer();
        expect(win.CSVHandler.csvState.functionSteps.uom).to.deep.equal(UOM_STEPS);
        const asked = posted.filter(m => m.type === 'map.functionsSample' && m.variable === 'uom').pop();
        expect(asked?.fns).to.deep.equal(UOM_STEPS);
        const cell = row('uom').querySelector('.map-sample-cell')!;
        expect(cell.classList.contains('has-fx')).to.equal(true);
        expect(cell.querySelector('.source-sample-cell')!.textContent).to.equal('In ea ');
        expect(cell.querySelector('.target-sample-cell')!.textContent).to.equal('OutEACH');
        expect(cell.querySelector('.target-sample-cell .map-io-v')!.classList.contains('is-changed')).to.equal(true);
        expect(row('uom').querySelector('.map-fx-slot .dbmn-fx-btn')!.classList.contains('is-on')).to.equal(true);
        expect(row('uom').querySelector('.status-cell .status-indicator')!.textContent).to.equal('✓');
        // (sku has no steps: no sample asked for it)
        expect(posted.some(m => m.type === 'map.functionsSample' && m.variable === 'sku')).to.equal(false);
    });

    it('a save remembers each mapped variable\'s steps with its column; a variable whose steps were removed forgets them', () => {
        const { win, save } = load({ columnFunctions: { qty: [{ fn: 'readnum', as: 'cobol' }] } });
        win.CSVHandler.setState({ templateVariables: [{ name: 'uom', mappedTo: 'uom' }, { name: 'qty', mappedTo: 'qty' }, { name: 'sku', mappedTo: null }] });
        win.CSVHandler.csvState.functionSteps = { uom: UOM_STEPS, qty: [] };
        const saved = save();
        expect(saved?.columnFunctions).to.deep.equal({ uom: UOM_STEPS });
        expect(saved?.columnMappings).to.deep.equal({ uom: 'uom', qty: 'qty' });
    });
});
