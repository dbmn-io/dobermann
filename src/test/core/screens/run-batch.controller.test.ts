// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's host logic, as both hosts run it (#343), with the real catalogue in memory.
 *
 * GitHub Issue #396: a batch that does not start must say so. The start answered
 * { success: false } and this controller never read it, so the tab sat on "Preparing batch
 * execution…" for ever with nothing on screen. These drive the real Execute message through
 * the real controller.
 */
import { expect } from 'chai';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { EnvironmentManager } from '../../../environmentManager';
import { RunCancelledError } from '../../../errors/run-cancelled-error';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { RunBatchController } from '../../../screens/run-batch/run-batch.controller';
import { createDefaultDataLoadingConfig } from '../../../data-loading/zod-schemas';
import { clearProductionSuppression } from '../../../services/ui/production-guard.service';
import type { RunBatchPorts } from '../../../screens/run-batch/run-batch.ports';
import { ScreenSession } from '../../../screens/screen-session';
import { BulkLoadResult, bulkLoadFailure } from '../../../webviews/run-batch/bulk-load-result';
import { FormatConverterService } from '../../../services/format-converter/format-converter.service';
import * as XLSX from 'xlsx';

type Message = Record<string, unknown>;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function runBatch(answer: BulkLoadResult | (() => Promise<BulkLoadResult>), overrides: Partial<RunBatchPorts> = {}) {
    const context = memoryStoreContext();
    const endpoints = new APIEndpointManager(context);
    const endpoint = await endpoints.addEndpoint({ name: 'Bulk Inventory Upload', method: 'POST', path: '/inventory', body: '{"gtin":"{{gtin}}"}' });
    const posted: Message[] = [];
    const events: string[] = [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: url => events.push(`open ${url}`) });
    const ports = {
        endpoints,
        environments: new EnvironmentManager(context),      // no active environment: no production confirm
        resolvePolicy: async () => ({ managed: false }),
        toast: { info: (m: string) => events.push(`info ${m}`), warn: (m: string) => events.push(`toast ${m}`), error: (m: string) => events.push(`error ${m}`) },
        executeBulkLoad: async () => (typeof answer === 'function' ? answer() : answer),
        host: { close: () => events.push('tab closed'), openConsole: async () => undefined },
        ...overrides
    } as unknown as RunBatchPorts;
    const controller = new RunBatchController(session, ports, { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
    await controller.handleMessage({ type: 'executeBulkLoadCommand', endpointId: endpoint.id, jsonData: [{ gtin: '0614' }], mappings: [{ variable: 'gtin', column: 'gtin' }] } as never);
    await settle();
    const of = (type: string) => posted.filter(m => m.type === type);
    return { controller, posted, events, of };
}

describe('RunBatchController — a batch that does not start says why (#396)', () => {
    it('the user stopped at a sign-in prompt: Execute comes back, and that is not an error', async () => {
        const h = await runBatch(bulkLoadFailure(new RunCancelledError('Sign-in was not completed')));
        expect(h.of('resetExecuteButton')).to.have.length(1);
        expect(h.of('bulkLoadCommandExecuted')).to.deep.equal([]);
        expect(h.events).to.deep.equal([]);
    });

    it('any other failure: its reason on the page, nothing else, and the tab is not closed', async () => {
        const h = await runBatch(bulkLoadFailure(new Error('Endpoint not found: ep-9')));
        expect(h.of('bulkLoadCommandExecuted')).to.deep.equal([{ type: 'bulkLoadCommandExecuted', error: 'Endpoint not found: ep-9' }]);
        await new Promise(resolve => setTimeout(resolve, 2100));    // the success path closes the tab after 2s
        expect(h.events).to.deep.equal([]);
    });

    it('the start could not even be called: still said, never silent', async () => {
        const h = await runBatch(async () => { throw new Error('the run service is gone'); });
        expect(h.of('bulkLoadCommandExecuted')).to.deep.equal([{ type: 'bulkLoadCommandExecuted', error: 'the run service is gone' }]);
    });

    it('a batch that started: no error, and the tab closes once it has run', async () => {
        const h = await runBatch({ success: true, message: 'Bulk execution started successfully' });
        expect(h.of('bulkLoadCommandExecuted')).to.deep.equal([]);
        expect(h.of('resetExecuteButton')).to.deep.equal([]);
        await new Promise(resolve => setTimeout(resolve, 2100));
        expect(h.events).to.deep.equal(['tab closed']);
    });
});

describe('RunBatchController — Review is told whether the environment is production', () => {
    const LOCAL_PLAYGROUND = 'http://127.0.0.1:54321/functions/v1/playground';
    async function environmentData(environmentType: string) {
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"s":"{{s}}"}' });
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const environments = {
            getActiveEnvironment: async () => ({ id: 'local', name: 'Live', baseUrl: LOCAL_PLAYGROUND, environmentType, variables: {} }),
            getHeaderVariables: async () => []
        };
        const controller = new RunBatchController(session, { endpoints, environments } as unknown as RunBatchPorts,
            { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        await controller.handleMessage({ type: 'getCurrentEnvironment' } as never);
        return posted.find(m => m.type === 'currentEnvironmentData');
    }

    it('by the type, as Execute\'s confirmation decides it (the name does not say "prod")', async () => {
        expect((await environmentData('production'))?.isProduction).to.equal(true);
        expect((await environmentData('development'))?.isProduction).to.equal(false);
    });
});

describe('RunBatchController — a problem the page reports is never dropped', () => {
    it('showError and showWarning become toasts', async () => {
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"s":"{{s}}"}' });
        const said: string[] = [];
        const session = new ScreenSession({ post: () => undefined }, { openExternal: () => undefined });
        const toast = { info: (m: string) => said.push(`info ${m}`), warn: (m: string) => said.push(`warn ${m}`), error: (m: string) => said.push(`error ${m}`) };
        const controller = new RunBatchController(session, { endpoints, environments: new EnvironmentManager(context), toast } as unknown as RunBatchPorts,
            { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        await controller.handleMessage({ type: 'showError', message: "DBMN couldn't read stock.xlsx" } as never);
        await controller.handleMessage({ type: 'showWarning', message: 'Careful' } as never);
        expect(said).to.deep.equal(["error DBMN couldn't read stock.xlsx", 'warn Careful']);
    });
});

describe('RunBatchController — what a file is, as Source is told it', () => {
    async function detect(fileName: string, fileData: ArrayBuffer) {
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"s":"{{s}}"}' });
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const controller = new RunBatchController(session, { endpoints, environments: new EnvironmentManager(context), formatConverter: new FormatConverterService() } as unknown as RunBatchPorts,
            { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        await controller.handleMessage({ type: 'detectFileFormat', fileName, fileData, fileSize: fileData.byteLength } as never);
        return posted.find(m => m.type === 'formatDetected') as Message;
    }
    const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

    it('text renamed .xlsx is not an Excel file (the spreadsheet library would read it as a sheet of text)', async () => {
        const answer = await detect('renamed-text.xlsx', bytes('this is not a spreadsheet, just text renamed .xlsx'));
        expect(String(answer.error)).to.match(/Not an Excel workbook/);
    });

    it('a workbook whose first sheet is empty: that sheet is reported as having no rows, the next as usable', async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['sku'], ['A1']]), 'Data');
        const answer = await detect('first-sheet-empty.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
        expect(answer.error).to.equal(undefined);
        const [empty, data] = (answer.metadata as { sheetDetails: Array<{ name: string; rowCount: number; validationStatus: string }> }).sheetDetails;
        expect({ name: empty.name, rows: empty.rowCount <= 1, status: empty.validationStatus }).to.deep.equal({ name: 'Empty', rows: true, status: 'error' });
        expect({ name: data.name, status: data.validationStatus }).to.deep.equal({ name: 'Data', status: 'valid' });
    });
});

describe('RunBatchController — Execute\'s one confirmation, and the tab handed to the Console (#470)', () => {
    afterEach(() => clearProductionSuppression());
    async function harness(environmentType: string) {
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"s":"{{s}}"}' });
        const posted: Message[] = [];
        const events: string[] = [];
        const runs: Array<Record<string, unknown>> = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const environments = {
            getActiveEnvironment: async () => ({ id: `env-${environmentType}`, name: environmentType === 'production' ? 'Prod' : 'Test', baseUrl: 'https://api.example.test', environmentType, variables: {}, parallelProcessing: { enabled: true, maxConcurrency: 4 } }),
            getHeaderVariables: async () => [{ name: 'ORG', value: 'DM1', options: ['DM1'] }]
        };
        const ports = {
            endpoints, environments,
            toast: { info: (m: string) => events.push(`info ${m}`), warn: (m: string) => events.push(`warn ${m}`), error: (m: string) => events.push(`error ${m}`) },
            executeBulkLoad: async (request: Record<string, unknown>) => { runs.push(request); return { success: true, message: 'started' }; },
            host: { close: () => events.push('tab closed'), openConsole: async () => undefined }
        } as unknown as RunBatchPorts;
        const controller = new RunBatchController(session, ports, { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        // (Review drawn: the plan it shows)
        (controller as unknown as { lastPlan: unknown }).lastPlan = { method: 'POST', urlTemplate: '/stock', reps: { applies: false, label: '', value: 1 }, totals: { rows: 3, requests: 3 }, requests: [] };
        const execute = (extra: Record<string, unknown>) => controller.handleMessage({ type: 'executeBulkLoadCommand', endpointId: endpoint.id, jsonData: [{ s: '1' }], mappings: [{ variable: 's', column: 's' }], ...extra } as never);
        return { controller, posted, events, runs, execute, of: (type: string) => posted.filter(m => m.type === type) };
    }

    it('Execute asks: the window gets the rows, requests, environment with its header values, URL, Error handling and Threads', async () => {
        const h = await harness('development');
        await h.controller.handleMessage({ type: 'runBatch.executeAsk' } as never);
        const summary = (h.of('runBatch.executeConfirm')[0] as { summary: Record<string, unknown> }).summary;
        expect(summary).to.include({ rows: 3, requests: 3, method: 'POST', url: 'https://api.example.test/stock', guard: null });
        expect(summary.sentence).to.equal('3 rows as 3 requests to Test (ORG DM1): POST https://api.example.test/stock');
        expect(summary.threads).to.deep.equal({ value: 1, options: [1, 2, 4] });
    });

    it('production: the guard is in the same window; Execute with no yes from it is refused and nothing runs', async () => {
        const h = await harness('production');
        await h.controller.handleMessage({ type: 'runBatch.executeAsk' } as never);
        expect((h.of('runBatch.executeConfirm')[0] as { summary: { guard: { ask: boolean } } }).summary.guard.ask).to.equal(true);
        await h.execute({ confirm: { errorHandling: 'continue', threads: 1 } });
        await settle();
        expect(h.runs, 'not run').to.have.length(0);
        expect(h.of('resetExecuteButton')).to.have.length(1);
        expect(h.events[0]).to.match(/^warn Not run: Prod is production/);
    });

    it('the window\'s choices are what runs: Stop on first error, 2 threads; its production yes with 15 minutes holds for the next', async () => {
        const h = await harness('production');
        await h.execute({ confirm: { errorHandling: 'stop', threads: 2, production: { minutes: 15 } } });
        await settle();
        expect(h.runs).to.have.length(1);
        expect(h.runs[0]).to.deep.include({ stopOnFirstError: true, parallelProcessing: { enabled: true, maxConcurrency: 2 } });
        await h.controller.handleMessage({ type: 'runBatch.executeAsk' } as never);
        const next = (h.of('runBatch.executeConfirm')[0] as { summary: Record<string, { ask?: boolean; value?: unknown }> }).summary;
        expect(next.guard.ask, 'within 15 minutes: the line, no question').to.equal(false);
        expect(next.errorHandling.value, 'last choice kept').to.equal('stop');
        expect(next.threads.value).to.equal(2);
    });

    it('what Review showed at Execute is kept for the Console that takes the tab\'s place', async () => {
        const h = await harness('development');
        await h.execute({ confirm: { errorHandling: 'continue', threads: 1 }, review: { search: 'WOOF', scrollTop: 240.4, selected: 7, extra: 'dropped' } });
        expect(h.controller.handoff()).to.deep.equal({ tab: 'requests', search: 'WOOF', scrollTop: 240, selected: 7 });
    });
});

describe('RunBatchController — the Execute window says the run as it will be sent (#470, 2026-11-24)', () => {
    afterEach(() => clearProductionSuppression());

    it('Rows per request changed just before Execute: the window plans again with the endpoint as saved, 1,000 rows as 100 requests', async () => {
        const context = memoryStoreContext();
        const endpoints = new APIEndpointManager(context);
        const endpoint = await endpoints.addEndpoint({ name: 'Stock', method: 'POST', path: '/stock', body: '{"items":[{"s":"{{s}}"}]}' });
        const posted: Message[] = [];
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const environments = {
            getActiveEnvironment: async () => ({ id: 'env-test', name: 'Test', baseUrl: 'https://api.example.test', environmentType: 'development', variables: {} }),
            getHeaderVariables: async () => []
        };
        const controller = new RunBatchController(session, { endpoints, environments, toast: { info: () => undefined, warn: () => undefined, error: () => undefined } } as unknown as RunBatchPorts,
            { context: 'runBatch', endpointId: endpoint.id, endpointName: endpoint.name, endpoint } as never);
        // Review planned with Rows per request 1 (what the page last drew)…
        const rows = Array.from({ length: 1000 }, (_, i) => [`S${i}`]);
        (controller as unknown as { lastPlanArgs: unknown }).lastPlanArgs = { source: { headers: ['s'], rows }, message: { mappings: [{ variable: 's', column: 's' }] }, environment: { baseUrl: 'https://api.example.test' }, variables: {} };
        // …then Rows per request 10 was typed and saved to the endpoint as Execute was pressed
        await endpoints.updateEndpoint(endpoint.id, { ...endpoint, dataLoadingConfig: { ...createDefaultDataLoadingConfig(), repeatableArrays: [{ arrayPath: 'items', enabled: true, maxRepetitions: 10 }] } } as never);
        await controller.handleMessage({ type: 'runBatch.executeAsk' } as never);
        const summary = (posted.find(m => m.type === 'runBatch.executeConfirm') as { summary: { rows: number; requests: number; sentence: string } }).summary;
        expect(summary).to.include({ rows: 1000, requests: 100 });
        expect(summary.sentence).to.match(/^1,000 rows as 100 requests to Test: POST /);
    });
});
