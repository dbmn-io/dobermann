// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A column with Map's functions (steps), from Map to what is sent: Map's Out (the host's sample), Next to Validate
 * (the translated input: the steps once, on the host), Validate's grid, Execute and the request build. What Map shows
 * is what Validate holds is what is sent; nothing converts the column again (its Source format is never applied on
 * top). The page is the REAL data-transformer.js and its modules; the host's answers are the REAL map-functions.ts.
 * what-is-sent.test.ts covers the columns without steps, unchanged.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { FormatConverterService } from '../../../../services/format-converter/format-converter.service';
import { DataTypeDetectionService } from '../../../../services/data-type-detection/data-type-detection.service';
import { DataTransformationService } from '../../../../services/data-transformation/data-transformation.service';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { mapSample, mapTranslate } from '../../../../screens/run-batch/map-functions';
import type { ColumnFn } from '../../../../services/column-functions/column-functions';

const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
const SCRIPTS = ['dbmn-toast.js', 'json-comment-stripper.js', 'template-rename.js', 'dt-data-entry-grid.js', 'date-read.js', 'dt-type-coercion.js',
    'dt-data-ingestion.js', 'dt-data-preview.js', 'dt-mismatch-repair.js', 'dt-batch-config.js', 'data-transformer.js'];

/** format: the column's Transform default for its type, which a column with steps must never get on top */
interface Case { type: string; format: string; value: string; steps: ColumnFn[]; zones?: { from: string; to: string } }

async function run({ type, format, value, steps, zones }: Case) {
    const dom = new JSDOM('<!DOCTYPE html><body><button id="csvExecuteBtn">Execute</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as any;
    const posted: any[] = [];
    w.vscode = { postMessage: (m: any) => posted.push(m) };
    for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
    const body = JSON.stringify({ v: `{{v:${type}}}` });
    const variable = { name: 'v', dataType: type, mappedTo: 'v', formatModifier: '' };
    w.CSVHandler.setState({
        modalStep: 2, rawCSVContent: `v\n${JSON.stringify(value)}`, templateVariables: [variable], sourceTypes: { v: format },
        selectedColumnTypes: { v: type }, batchName: 'Test', currentHeaders: ['v'], currentParsedData: { headers: ['v'], rows: [[value]] }
    });
    w.CSVHandler.csvState.functionSteps = { v: steps };
    if (zones) { w.CSVHandler.csvState.sourceTimezone = zones.from; w.CSVHandler.csvState.currentEnvironment = { targetTimezone: zones.to }; }
    // 1. Map: the Sample's Out (the host's answer for the first row)
    const hostOut = mapSample(steps, 'v', ['v'], [[value]])[0];
    const mapOut = { ...hostOut, after: w.DTTypeCoercion.stepOutAsSent(variable, hostOut.after) };
    // 2. Next to Validate: the translated input (the page asks; the host answers), then the per-cell pass
    const parsedData = { headers: ['v'], rows: [[value]] };
    const translated = await new Promise<any>(done => {
        w.DTTypeCoercion.translateStepColumns(parsedData, [variable], (out: any) => done(out));
        const ask = posted.filter(m => m.type === 'map.translate').pop();
        w.DTTypeCoercion.handleMapTranslated({ type: 'map.translated', seq: ask.seq, ...mapTranslate(ask) });
    });
    const at = translated.data.headers.indexOf(translated.vars[0].mappedTo);
    const validateHolds = String(w.DTTypeCoercion.applySourceFormatToRows(translated.data.headers, translated.data.rows, translated.vars)[0][at]);
    // (the file's own row is still the file's)
    expect(parsedData.rows[0][0]).to.equal(value);
    // 3. Next to Review: the grid is the data from here on
    const gridCSV = `v\n${JSON.stringify(validateHolds)}`;
    w.CSVHandler.setState({ modalStep: 4, rawCSVContent: gridCSV, sourceType: 'grid', executeAfterTransform: true, executionEndpointId: 'ep-1' });
    // 4. Execute: the host's type transform, then the page's send
    const converter = new FormatConverterService(new DataTypeDetectionService(), new DataTransformationService());
    const nonString = w.DTTypeCoercion.filterNonStringTypes({ v: type });
    const transformed = await converter.applyDataTransformations(gridCSV, new Map(Object.entries(nonString)) as never);
    w.DTTypeCoercion.handleTypeTransformationResult({ transformedData: transformed });
    const execute = posted.find(m => m.type === 'executeBulkLoadCommand');
    const row = execute.jsonData[0] as Record<string, string>;
    const generated = await new JsonGenerator().generateSingleRowJson(String(row.v ?? ''), {
        template: body, mappings: [{ variable: 'v', column: 'v', dataType: 'string' }], headers: ['v'], repeatableArrays: [],
        endpointId: 'ep-1', sequenceStartValue: 1001, isBatchExecution: true
    } as never);
    const json = generated.jsonData as unknown;
    const first = (Array.isArray(json) ? json[0] : json) as Record<string, unknown>;
    // (what the host's second pass would be told: a column with steps is passthrough)
    const mappings = w.CSVHandler.getCurrentMappings();
    return { mapOut, validateHolds, sent: first.v, mappings, translateAsked: posted.filter(m => m.type === 'map.translate').length };
}

describe('What Run Batch sends: a column with Map\'s functions (steps)', function () {
    this.timeout(30_000);


    it('a day-first date read by Read date: Map\'s Out is what Validate holds, and the day sent is that day', async () => {
        const r = await run({ type: 'date', format: 'auto_date', value: '05/01/2026', steps: [{ fn: 'readdate', as: 'dd-mm-yyyy' }] });
        expect(r.mapOut.after).to.equal('2026-01-05');
        expect(r.validateHolds).to.equal('2026-01-05');
        expect(String(r.sent).replace(/\D/g, '').slice(0, 8)).to.equal('20260105');
    });

    it('text through several steps (one twice): Map\'s Out is what is sent', async () => {
        const steps: ColumnFn[] = [{ fn: 'trim' }, { fn: 'upper' }, { fn: 'replace', from: '-', to: '' }, { fn: 'replace', from: 'WOOF', to: 'DOG' }];
        const r = await run({ type: 'string', format: 'passthrough', value: ' sku-woof-001 ', steps });
        expect(r.mapOut.after).to.equal('SKUDOG001');
        expect(r.validateHolds).to.equal('SKUDOG001');
        expect(r.sent).to.equal('SKUDOG001');
    });

    it('spaces at the ends, with and without a Trim spaces step, plain or non-breaking: Map\'s Out = Validate = what is sent (every cell is trimmed on its way out)', async () => {
        for (const [value, steps, out] of [
            [' ea', [{ fn: 'upper' }], 'EA'],
            ['cs ', [{ fn: 'upper' }], 'CS'],
            [' ea ', [{ fn: 'trim' }, { fn: 'upper' }], 'EA'],
            [' EA ', [{ fn: 'trim' }], 'EA'],
            ['pl', [{ fn: 'jointext', between: ' ', value: '' }], 'pl']
        ] as [string, ColumnFn[], string][]) {
            const r = await run({ type: 'string', format: 'passthrough', value, steps });
            expect([r.mapOut.after, r.validateHolds, r.sent], JSON.stringify(value)).to.deep.equal([out, out, out]);
        }
    });

    it('a datetime column with steps: after its steps its time is still moved from the file\'s timezone to the Target\'s, once (TZ-independent)', async () => {
        // (James, 2026-11-25: "map from Computers Timezone, to Environment Timezone". Steps read the value; they don't
        // stand in for the move. Sydney 08:00 on 5 Jan (UTC+11) is 21:00 on 4 Jan in UTC.)
        const r = await run({ type: 'datetime', format: 'iso_8601', value: ' 2026-01-05T08:00:00 ', steps: [{ fn: 'trim' }],
            zones: { from: 'Australia/Sydney', to: 'UTC' } });
        expect(r.mapOut.after).to.equal('2026-01-04T21:00:00');
        expect(r.validateHolds).to.equal('2026-01-04T21:00:00');
        expect(String(r.sent)).to.contain('2026-01-04T21:00');
    });

    it('a datetime column with steps, file and Target in one timezone: the time sent is the time in the file', async () => {
        const r = await run({ type: 'datetime', format: 'iso_8601', value: ' 2026-01-05T08:00:00 ', steps: [{ fn: 'trim' }],
            zones: { from: 'UTC', to: 'UTC' } });
        expect(r.mapOut.after).to.equal('2026-01-05T08:00:00');
        expect(r.validateHolds).to.equal('2026-01-05T08:00:00');
        expect(String(r.sent)).to.contain('08:00');
    });

    it('the host\'s second pass is told a column with steps is passthrough', async () => {
        const r = await run({ type: 'number', format: 'cobol', value: '+000000001.0000', steps: [{ fn: 'readnum', as: 'cobol' }] });
        expect(r.mappings[0].sourceFormat).to.equal('passthrough');
        expect(r.sent).to.equal(1);
    });

    /* ---------- The file's rows are never written to; one column, two variables; no answer (review, 2026-11-26) ---------- */

    function page() {
        const dom = new JSDOM('<!DOCTYPE html><body><button id="csvNextBtn">Next</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
        const w = dom.window as any;
        const posted: any[] = [];
        w.vscode = { postMessage: (m: any) => posted.push(m) };
        for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(SHARED, file), 'utf8'));
        return { w, posted };
    }
    /** Next to Validate's translation, answered by the real host code; the data it hands on. */
    function translate(w: any, posted: any[], parsedData: any, vars: any[]) {
        return new Promise<any>(done => {
            w.DTTypeCoercion.translateStepColumns(parsedData, vars, (out: any) => done(out));
            const ask = posted.filter(m => m.type === 'map.translate').pop();
            if (ask) w.DTTypeCoercion.handleMapTranslated({ type: 'map.translated', seq: ask.seq, ...mapTranslate(ask) });
        });
    }

    it('Next, Back, Next: the steps run once on the file\'s values; the file\'s rows and Map\'s In are never the translated ones', async () => {
        const { w, posted } = page();
        const rows = [['5'], ['7']];
        const file = { headers: ['qty'], rows };
        const variable = { name: 'qty', dataType: 'number', mappedTo: 'qty' };
        w.CSVHandler.setState({ templateVariables: [variable], sourceTypes: { qty: 'standard' }, currentHeaders: ['qty'], currentParsedData: file });
        w.CSVHandler.csvState.functionSteps = { qty: [{ fn: 'plus', value: 1 }] };
        const first = await translate(w, posted, file, [variable]);
        const second = await translate(w, posted, file, [variable]);
        const at = (out: any) => out.data.headers.indexOf(out.vars[0].mappedTo);
        expect(first.data.rows.map((r: string[]) => r[at(first)])).to.deep.equal(['6', '8']);
        expect(second.data.rows.map((r: string[]) => r[at(second)])).to.deep.equal(['6', '8']);
        expect(rows).to.deep.equal([['5'], ['7']]);
        expect(w.CSVHandler.csvState.inputOriginals.qty).to.deep.equal(['5', '7']);
    });

    it('two variables on one column, one with steps: each keeps its own value', async () => {
        const { w, posted } = page();
        const file = { headers: ['sku'], rows: [['sku-1'], ['sku-2']] };
        const stepped = { name: 'sku', dataType: 'string', mappedTo: 'sku' };
        const plain = { name: 'skuCopy', dataType: 'string', mappedTo: 'sku' };
        w.CSVHandler.setState({ templateVariables: [stepped, plain], sourceTypes: {}, currentHeaders: ['sku'], currentParsedData: file });
        w.CSVHandler.csvState.functionSteps = { sku: [{ fn: 'upper' }] };
        const out = await translate(w, posted, file, [stepped, plain]);
        const valueOf = (name: string, r: number) => out.data.rows[r][out.data.headers.indexOf(out.vars.find((v: any) => v.name === name).mappedTo)];
        expect([valueOf('sku', 0), valueOf('sku', 1)]).to.deep.equal(['SKU-1', 'SKU-2']);
        expect([valueOf('skuCopy', 0), valueOf('skuCopy', 1)]).to.deep.equal(['sku-1', 'sku-2']);
        // (the mapping itself is untouched: Map still shows sku → sku)
        expect(w.CSVHandler.csvState.templateVariables.map((v: any) => v.mappedTo)).to.deep.equal(['sku', 'sku']);
    });

    it('the host answers with an error, or not at all: Next is let go and the error is said', async () => {
        const { w, posted } = page();
        const file = { headers: ['qty'], rows: [['5']] };
        const variable = { name: 'qty', dataType: 'number', mappedTo: 'qty' };
        w.CSVHandler.setState({ templateVariables: [variable], sourceTypes: {}, currentHeaders: ['qty'], currentParsedData: file });
        w.CSVHandler.csvState.functionSteps = { qty: [{ fn: 'plus', value: 1 }] };
        const failed = await new Promise<any>(done => {
            w.DTTypeCoercion.translateStepColumns(file, [variable], () => done({ went: true }), (error: string) => done({ error }));
            const ask = posted.filter(m => m.type === 'map.translate').pop();
            w.DTTypeCoercion.handleMapTranslated({ type: 'map.translated', seq: ask.seq, error: 'boom' });
        });
        expect(failed.error).to.match(/couldn't be applied: boom/);
        // no answer: the time limit (shortened here) says so
        w.DTTypeCoercion.translateTimeLimit(20);
        const silent = await new Promise<any>(done => {
            w.DTTypeCoercion.translateStepColumns(file, [variable], () => done({ went: true }), (error: string) => done({ error }));
        });
        expect(silent.error).to.match(/didn't answer/);
    });
});
