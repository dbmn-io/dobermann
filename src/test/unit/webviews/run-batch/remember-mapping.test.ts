// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GitHub Issue #307 — Run Batch remembers the column mapping per endpoint.
 *
 * Loads the REAL src/webviews/shared/data-transformer.js into JSDOM: Step 2's mapping table
 * pre-maps remembered columns, Next on Map & Transform saves the mapping (always — there is
 * no opt-in), and the save Execute makes keeps it.
 *
 * The case is Puppy School Lesson 5: the Console copy heads its columns `location.gln`,
 * `product.supplier.gln`, `reorderQty`, which name-matching cannot pair with `buyerGln`,
 * `supplierGln`, `orderedQty`. Step 5 maps them by hand; Step 6 must not have to.
 */
const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
// The Data Transformer modules, in the order the Run Batch page loads them (run-batch-webview.ts).
const SCRIPTS = ['json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'dt-type-coercion.js', 'dt-data-ingestion.js',
    'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];
const HEADERS = ['gtin', 'uom', 'location.gln', 'product.supplier.gln', 'reorderQty', 'supplierSku'];
const LESSON_MAPPING = { buyerGln: 'location.gln', supplierGln: 'product.supplier.gln', orderedQty: 'reorderQty' };

type Posted = { type: string; endpoint?: { dataLoadingConfig?: Record<string, unknown> } };

function load(dataLoadingConfig: Record<string, unknown>) {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="csvMappingStep"><div id="columnMappingTable"></div>
            <div id="updateTemplateOption" class="hidden"><input type="checkbox" id="updateTemplateCheckbox"><span id="updateTemplateRenames"></span></div>
        </div>
        <select id="batchErrorModeSelect"><option value="continue" selected>Continue processing</option><option value="stopOnFirst">Stop on first error</option></select>
    </body>`, { runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { CSVHandler: any; vscode: { postMessage: (m: Posted) => void } };
    const posted: Posted[] = [];
    win.vscode = { postMessage: (m: Posted) => { posted.push(m); } };
    for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
    const variable = (name: string) => ({ name, dataType: 'string', mapped: false, mappedTo: null, column: null });
    win.CSVHandler.setState({
        endpointId: 'ep-1',
        endpointConfig: { id: 'ep-1', name: 'My Replenishment Orders', dataLoadingConfig: { detectArrays: true, repeatableArrays: [], ...dataLoadingConfig } },
        currentHeaders: HEADERS,
        templateVariables: ['buyerGln', 'supplierGln', 'gtin', 'orderedQty', 'supplierSku', 'uom'].map(variable)
    });
    const mappedTo = () => Object.fromEntries(win.CSVHandler.csvState.templateVariables.map((v: { name: string; mappedTo: string | null }) => [v.name, v.mappedTo]));
    const save = () => { win.CSVHandler.updateEndpointConfiguration(); return posted.filter(m => m.type === 'saveEndpoint').pop()?.endpoint?.dataLoadingConfig; };
    return { win, dom, mappedTo, save };
}

describe('Run Batch — remember the column mapping (#307)', () => {
    it('a remembered column is mapped for you; name matching still fills the rest', () => {
        const { win, mappedTo } = load({ columnMappings: LESSON_MAPPING });
        win.CSVHandler.populateColumnMappingTable();
        expect(mappedTo()).to.deep.equal({
            buyerGln: 'location.gln', supplierGln: 'product.supplier.gln', orderedQty: 'reorderQty',
            gtin: 'gtin', supplierSku: 'supplierSku', uom: 'uom'
        });
    });

    it('without a remembered mapping, the dotted columns are not guessed (the reason for #307)', () => {
        const { win, mappedTo } = load({});
        win.CSVHandler.populateColumnMappingTable();
        expect(mappedTo().orderedQty).to.equal(null);
        expect(mappedTo().gtin).to.equal('gtin');
    });

    it('a remembered column the new file does not have falls back to name matching', () => {
        const { win, mappedTo } = load({ columnMappings: { gtin: 'barcode', buyerGln: 'warehouse' } });
        win.CSVHandler.populateColumnMappingTable();
        expect(mappedTo().gtin).to.equal('gtin');
        expect(mappedTo().buyerGln).to.equal(null);
    });

    it('a save carries the mapping used, merged over the old one', () => {
        const { win, save } = load({ columnMappings: { legacyVar: 'old column', buyerGln: 'somewhere else' } });
        win.CSVHandler.setState({ templateVariables: [
            { name: 'buyerGln', mappedTo: 'location.gln' },
            { name: 'orderedQty', mappedTo: 'reorderQty' },
            { name: 'supplierSku', mappedTo: null }
        ] });
        const cfg = save();
        expect(cfg?.columnMappings).to.deep.equal({ legacyVar: 'old column', buyerGln: 'location.gln', orderedQty: 'reorderQty' });
        expect(cfg?.detectArrays, 'the rest of dataLoadingConfig is kept').to.equal(true);
    });

    it('a data-entry (grid) run leaves the remembered mapping alone', () => {
        const { win, save } = load({ columnMappings: LESSON_MAPPING });
        win.CSVHandler.setState({ sourceType: 'grid', templateVariables: [{ name: 'buyerGln', mappedTo: 'buyerGln' }] });
        expect(save()?.columnMappings).to.deep.equal(LESSON_MAPPING);
    });

    it('the same tab maps the next file from what this run just saved', () => {
        const { win, dom, mappedTo } = load({});
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
            type: 'endpointSaved', success: true,
            endpoint: { id: 'ep-1', dataLoadingConfig: { detectArrays: true, repeatableArrays: [], columnMappings: LESSON_MAPPING } }
        } }));
        win.CSVHandler.setState({ templateVariables: ['buyerGln', 'orderedQty'].map(name => ({ name, mappedTo: null })) });
        win.CSVHandler.populateColumnMappingTable();
        expect(mappedTo()).to.deep.equal({ buyerGln: 'location.gln', orderedQty: 'reorderQty' });
    });

    it('Next on Map & Transform saves the mapping, and only the mapping', () => {
        const { win, dom } = load({ repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 5 }] });
        const posted: Posted[] = [];
        (dom.window as any).vscode = { postMessage: (m: Posted) => { posted.push(m); } };
        win.CSVHandler.setState({ templateVariables: [{ name: 'buyerGln', mappedTo: 'location.gln' }] });
        win.CSVHandler.saveRememberedMapping();
        const cfg = posted.find(m => m.type === 'saveEndpoint')?.endpoint?.dataLoadingConfig;
        expect(cfg?.columnMappings).to.deep.equal({ buyerGln: 'location.gln' });
        expect(cfg?.repeatableArrays, "Step 4's settings are not touched at Step 2").to.deep.equal([{ arrayPath: 'lines', enabled: true, maxRepetitions: 5 }]);
    });

    it('Step 2 Next, then Step 3 makes it grid data, then Execute: the mapping survives', () => {
        const { win, dom } = load({});
        const posted: Posted[] = [];
        (dom.window as any).vscode = { postMessage: (m: Posted) => { posted.push(m); } };
        win.CSVHandler.setState({ modalStep: 2, sourceType: 'paste', rawCSVContent: 'location.gln,reorderQty\n1,4',
            templateVariables: [{ name: 'buyerGln', mapped: true, mappedTo: 'location.gln' }, { name: 'orderedQty', mapped: true, mappedTo: 'reorderQty' }] });
        try { win.CSVHandler.goToNextStep(); } catch { /* coercion validation needs the full page */ }
        const atNext = posted.find(m => m.type === 'saveEndpoint')?.endpoint;
        expect(atNext?.dataLoadingConfig?.columnMappings, 'saved at Step 2 Next').to.deep.equal({ buyerGln: 'location.gln', orderedQty: 'reorderQty' });
        // The extension replies; Step 3 → 4 turns the source into grid data mapped to itself.
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'endpointSaved', success: true, endpoint: atNext } }));
        win.CSVHandler.setState({ sourceType: 'grid', originalSourceType: 'paste',
            templateVariables: [{ name: 'buyerGln', mappedTo: 'buyerGln' }, { name: 'orderedQty', mappedTo: 'orderedQty' }] });
        win.CSVHandler.updateEndpointConfiguration();
        const atExecute = posted.filter(m => m.type === 'saveEndpoint').pop()?.endpoint?.dataLoadingConfig;
        expect(atExecute?.columnMappings, 'kept by the Execute save').to.deep.equal({ buyerGln: 'location.gln', orderedQty: 'reorderQty' });
    });

    it('Next with nothing new to remember saves nothing', () => {
        const { win, dom } = load({ columnMappings: { buyerGln: 'location.gln' } });
        const posted: Posted[] = [];
        (dom.window as any).vscode = { postMessage: (m: Posted) => { posted.push(m); } };
        win.CSVHandler.setState({ templateVariables: [{ name: 'buyerGln', mappedTo: 'location.gln' }] });
        win.CSVHandler.saveRememberedMapping();
        expect(posted.filter(m => m.type === 'saveEndpoint')).to.have.length(0);
    });
});

describe('Run Batch — Update Endpoint Template (#307)', () => {
    const option = (dom: JSDOM) => dom.window.document.getElementById('updateTemplateOption') as HTMLElement;

    it('appears once a variable is mapped to a column with a different name, listing the renames', () => {
        const { win, dom } = load({ columnMappings: LESSON_MAPPING });
        win.CSVHandler.populateColumnMappingTable();
        expect(option(dom).classList.contains('hidden')).to.equal(false);
        expect(dom.window.document.getElementById('updateTemplateRenames')?.textContent)
            .to.equal('buyerGln → location.gln, supplierGln → product.supplier.gln, orderedQty → reorderQty');
        expect((dom.window.document.getElementById('updateTemplateCheckbox') as HTMLInputElement).checked, 'unticked by default').to.equal(false);
    });

    it('stays hidden while every variable maps to a column of its own name', () => {
        const { win, dom } = load({});
        win.CSVHandler.setState({ templateVariables: ['gtin', 'uom'].map(name => ({ name, mappedTo: null })) });
        win.CSVHandler.populateColumnMappingTable();
        expect(option(dom).classList.contains('hidden')).to.equal(true);
    });

    it('ticked at Step 2 Next: the renames ride with the batch; unticked: nothing', () => {
        for (const ticked of [true, false]) {
            const { win, dom } = load({ columnMappings: LESSON_MAPPING });
            win.CSVHandler.populateColumnMappingTable();
            (dom.window.document.getElementById('updateTemplateCheckbox') as HTMLInputElement).checked = ticked;
            win.CSVHandler.setState({ modalStep: 2, sourceType: 'paste', rawCSVContent: HEADERS.join(',') + '\n1,2,3,4,5,6' });
            try { win.CSVHandler.goToNextStep(); } catch { /* coercion validation needs the full page */ }
            expect(win.CSVHandler.csvState.pendingTemplateRenames).to.deep.equal(ticked
                ? { buyerGln: 'location.gln', supplierGln: 'product.supplier.gln', orderedQty: 'reorderQty' }
                : null);
        }
    });

    it('an updated template maps itself, and so does an underscore spelling of a dotted column', () => {
        const { win, mappedTo } = load({});
        win.CSVHandler.setState({ templateVariables: ['location_gln', 'product_supplier_gln', 'reorderQty'].map(name => ({ name, mappedTo: null })) });
        win.CSVHandler.populateColumnMappingTable();
        expect(mappedTo()).to.deep.equal({ location_gln: 'location.gln', product_supplier_gln: 'product.supplier.gln', reorderQty: 'reorderQty' });
    });

    it('after the batch, the endpoint template is renamed and the user is told', async () => {
        let saved: any = null;
        const told: string[] = [];
        const webview = runBatch({
            getEndpoint: async () => ({ id: 'ep-1', name: 'My Replenishment Orders', body: '{"buyerGln":"{{buyerGln:string}}"}',
                bodyWithComments: '{"buyerGln":"{{buyerGln:string}}" //5012345000039\n}', dataLoadingConfig: { columnMappings: LESSON_MAPPING } }),
            updateEndpoint: async (_id: string, data: unknown) => { saved = data; return data; }
        }, { info: (m: string) => told.push(m), warn: (m: string) => told.push('WARN ' + m), error: () => undefined });
        await webview.applyTemplateRenames('ep-1', { buyerGln: 'location_gln' });
        expect(saved.body).to.equal('{"buyerGln":"{{location_gln:string}}"}');
        expect(saved.bodyWithComments).to.equal('{"buyerGln":"{{location_gln:string}}" //5012345000039\n}');
        expect(saved.dataLoadingConfig.columnMappings.location_gln).to.equal('location.gln');
        expect(told).to.deep.equal(['Updated the My Replenishment Orders template: buyerGln → location_gln']);
    });
});

describe('Run Batch save — an endpoint with no dataLoadingConfig yet (#307)', () => {
    it('is saved with the schema defaults filled in, keeping what Run Batch sent', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DataLoadingConfigSchema } = require('../../../../data-loading/zod-schemas');
        let saved: any = null;
        const webview = runBatch({
            getEndpoint: async () => ({ id: 'ep-1', name: 'Fresh endpoint' }),
            updateEndpoint: async (_id: string, data: unknown) => { saved = data; return data; }
        });
        await webview.handleSaveEndpoint({ type: 'saveEndpoint', endpoint: { id: 'ep-1', dataLoadingConfig: { columnMappings: LESSON_MAPPING } } });
        expect(DataLoadingConfigSchema.safeParse(saved.dataLoadingConfig).success).to.equal(true);
        expect(saved.dataLoadingConfig.columnMappings).to.deep.equal(LESSON_MAPPING);
    });
});

/** Run Batch's host logic with this endpoint store (and toasts) behind it. */
function runBatch(endpoints: unknown, toast: unknown = { info: () => undefined, warn: () => undefined, error: () => undefined }): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RunBatchController } = require('../../../../screens/run-batch/run-batch.controller');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScreenSession } = require('../../../../screens/screen-session');
    const session = new ScreenSession({ post: () => undefined }, { openExternal: () => undefined });
    return new RunBatchController(session, { endpoints, toast }, { context: 'runBatch', endpointId: 'ep-1', endpointName: 'ep', endpoint: {} });
}
