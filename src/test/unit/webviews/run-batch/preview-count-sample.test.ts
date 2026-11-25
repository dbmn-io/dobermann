// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { RunBatchController } from '../../../../screens/run-batch/run-batch.controller';
import { ScreenSession } from '../../../../screens/screen-session';

/**
 * Run Batch Step 4 "Total API calls" counts EVERY row, not the preview sample.
 *
 * A template with a typed variable (Lesson 5's `{{orderedQty:number}}`) previews from a
 * type-converted SAMPLE — the frontend's first 50 rows. The count was taken from the same
 * sample. Puppy School Lesson 5, Step 6: three suppliers, ~540 rows, sorted by supplier; the
 * first 50 are all one supplier, so Review JSON said "Total API calls: 1".
 */
const TEMPLATE = JSON.stringify({
    poNumber: 'PO-{{A8:sequence}}',
    buyerGln: '{{buyerGln:string}}',
    supplierGln: '{{supplierGln:string}}',
    lines: [{ gtin: '{{gtin:string}}', lineNumber: '{{A8:sequence:local}}', orderedQty: '{{orderedQty:number}}' }]
});
const HEADERS = ['gtin', 'location.gln', 'product.supplier.gln', 'reorderQty'];
const SUPPLIERS = ['4012345000030', '4012345000047', '4012345000054'];
// Sorted as the frontend sorts: warehouse, then supplier. 60 rows per supplier.
const ALL_ROWS = SUPPLIERS.flatMap(s => Array.from({ length: 60 }, () => ['00012345600050', '0614141000012', s, '200']));
const SAMPLE = ALL_ROWS.slice(0, 50);
const MAPPINGS = [['buyerGln', 'location.gln'], ['supplierGln', 'product.supplier.gln'], ['gtin', 'gtin'], ['orderedQty', 'reorderQty']]
    .map(([variable, column]) => ({ variable, column, dataType: 'string' }));

async function preview(countData?: { headers: string[]; rows: string[][] }) {
    const posted: any[] = [];
    const services = { getActiveEnvironment: async () => ({ variables: {} }), getNextSequence: async () => 1 };
    const session = new ScreenSession({ post: m => { posted.push(m); } }, { openExternal: () => undefined });
    const webview = new RunBatchController(session, { endpoints: services, environments: services } as any, {
        context: 'runBatch', endpointId: 'ep-1', endpointName: 'ep',
        endpoint: { id: 'ep-1', body: TEMPLATE, dataLoadingConfig: { repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }] } }
    } as any) as any;
    await webview.handleGenerateBulkJson({
        type: 'generateBulkJson', mode: 'preview', mappings: MAPPINGS,
        parsedData: { headers: HEADERS, rows: SAMPLE }, countData,
        uiArrayConfig: { arrayPath: 'lines', maxRepetitions: 1000 }
    });
    return posted[0];
}

describe('Run Batch preview — Total API calls counts every row, not the sample', () => {
    it('the whole file is three orders, though the 50-row sample is one supplier', async () => {
        const message = await preview({ headers: HEADERS, rows: ALL_ROWS });
        expect(message.error, message.error).to.equal(undefined);
        expect(message.nestedMode.totalTransactions).to.equal(3);
        expect(message.nestedMode.estimatedApiCalls).to.equal(3);
        expect(JSON.parse(message.jsonPreview).supplierGln, 'the preview still shows the first request').to.equal(SUPPLIERS[0]);
    });

    it('with no countData (the preview data IS every row) it counts parsedData, as before', async () => {
        expect((await preview()).nestedMode.totalTransactions).to.equal(1);   // 50 rows of one supplier
    });
});

describe('Data Transformer — which rows go to the count', () => {
    const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
    const SCRIPTS = ['json-comment-stripper.js', 'dt-data-entry-grid.js', 'date-read.js', 'dt-type-coercion.js', 'dt-data-ingestion.js',
        'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];
    const csv = [HEADERS.join(','), ...ALL_ROWS.map(r => r.join(','))].join('\n');

    function load() {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
        (dom.window as any).vscode = { postMessage: () => undefined };
        for (const file of SCRIPTS) { dom.window.eval(fs.readFileSync(path.join(SHARED, file), 'utf8')); }
        return dom.window as any;
    }

    it('a type-converted sample in play: every row of the file is sent for counting', () => {
        const win = load();
        win.CSVHandler.setState({ rawCSVContent: csv, fullTransformedCSV: [HEADERS.join(','), ...SAMPLE.map(r => r.join(','))].join('\n') });
        const countData = win.DTDataPreview.getCountDataForBackend();
        expect(countData.headers).to.deep.equal(HEADERS);
        expect(countData.rows).to.have.length(ALL_ROWS.length);
    });

    it('no sample (string-only template): nothing extra is sent', () => {
        const win = load();
        win.CSVHandler.setState({ rawCSVContent: csv, fullTransformedCSV: null });
        expect(win.DTDataPreview.getCountDataForBackend()).to.equal(null);
    });
});
