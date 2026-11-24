// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's run on the new top and footer (#464, #465): ⓘ's details in one message, the status
 * box's figures (finished and live), and the run renamed in place: kept where History, Logs and the
 * Console read it, its tab following.
 */
import { expect } from 'chai';
import { checkRunName, runDetails, runFigures, type RunRecord } from '../../../screens/console/run-details';
import { ConsoleController } from '../../../screens/console/console.controller';
import { ScreenSession } from '../../../screens/screen-session';

type Message = Record<string, any>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

const environment = (over: Record<string, unknown> = {}) => ({
    id: 'env-uat', name: 'UAT', baseUrl: 'https://{{host}}.example.test/api/', variables: { host: 'uat', org: 'vic', version: 'v2', apiToken: 'abc', skuPrefix: 'XY' },
    variableSettings: { org: { showInHeader: true }, version: { showInHeader: true } },
    parallelProcessing: { enabled: true, maxConcurrency: 8 }, environmentType: 'staging', ...over
}) as never;

const batch = (over: Partial<RunRecord> = {}): RunRecord => ({
    id: 'b-1', executionType: 'batch', status: 'completed', environment: 'UAT', environmentId: 'env-uat',
    endpointId: 'ep-1', endpointName: 'Put stock', endpointMethod: 'post', endpointPath: '/stock/{{sku}}',
    rows: '4(801)', startedAt: new Date(T0), completedAt: new Date(T0 + 95_000), createdAt: new Date(T0 - 1000),
    batchConfiguration: { name: 'Monday stock', stopOnFirstError: false, parallelProcessing: { enabled: true, maxConcurrency: 4 } },
    environmentVariables: { org: 'vic', version: 'v2', apiToken: 'abc', skuPrefix: 'XY' },
    ...over
});

describe('Console run details (ⓘ, #464)', () => {
    it('a finished batch: what Settings showed, in one shape', () => {
        const d = runDetails({ run: batch(), environment: environment(), endpointExists: true, requestPath: '/stock/A-1' });
        expect(d).to.deep.include({
            name: 'Monday stock', renamable: true, executionId: 'b-1', kind: 'batch',
            environment: { name: 'UAT', id: 'env-uat', production: false },
            endpoint: { name: 'Put stock', id: 'ep-1', method: 'POST' },
            url: 'https://uat.example.test/api/stock/A-1',
            errorHandling: 'continue', errorHandlingEditable: false,
            threads: { current: 4, max: 8, editable: false },
            started: '2026-11-24T09:00:00.000Z', durationMs: 95_000, lineage: null
        });
        expect(d.headers).to.deep.equal([{ name: 'org', value: 'vic' }, { name: 'version', value: 'v2' }]);
        expect(d.variables, 'the other variables, secrets masked').to.deep.equal([{ name: 'apiToken', value: '••••' }, { name: 'skuPrefix', value: 'XY' }]);
    });

    it('while it runs: threads and error handling can be set, no duration yet', () => {
        const d = runDetails({ run: batch({ status: 'running', completedAt: undefined, batchConfiguration: { stopOnFirstError: true, parallelProcessing: { maxConcurrency: 2 } } }), environment: environment(), endpointExists: true });
        expect({ e: d.errorHandling, ee: d.errorHandlingEditable, t: d.threads, ms: d.durationMs, name: d.name }).to.deep.equal({
            e: 'stopOnFirst', ee: true, t: { current: 2, max: 8, editable: true }, ms: null, name: 'Put stock'
        });
    });

    it('a production environment says so; a deleted environment or endpoint is no link', () => {
        expect(runDetails({ run: batch(), environment: environment({ environmentType: 'production' }), endpointExists: true }).environment.production).to.equal(true);
        const gone = runDetails({ run: batch({ baseUrl: 'https://kept.example.test' }), environment: undefined, endpointExists: false });
        expect(gone.environment).to.deep.equal({ name: 'UAT', id: null, production: false });
        expect(gone.endpoint.id).to.equal(null);
        expect(gone.url, 'the base URL the run kept').to.equal('https://kept.example.test/stock/{{sku}}');
    });

    it('an old run with only organization: its header reads as org', () => {
        const d = runDetails({ run: batch({ environmentVariables: undefined, organization: 'nz' }), environment: undefined, endpointExists: true });
        expect(d.headers).to.deep.equal([{ name: 'org', value: 'nz' }]);
    });

    it('lineage: copied from another run', () => {
        const d = runDetails({ run: batch({ copiedFromBatchId: 'b-0', copiedFromEnvironment: 'DEV', copiedAt: new Date(T0 - 60_000) }), environment: environment(), endpointExists: true });
        expect(d.lineage).to.deep.equal({ copiedFrom: { runId: 'b-0', environment: 'DEV', at: '2026-11-24T08:59:00.000Z' } });
    });

    it('a single run: the same details, no threads or error handling', () => {
        const d = runDetails({ run: batch({ executionType: 'individual', rows: '1', batchConfiguration: undefined }), environment: environment(), endpointExists: true });
        expect({ kind: d.kind, t: d.threads, e: d.errorHandling, r: d.renamable, name: d.name }).to.deep.equal({ kind: 'single', t: null, e: null, r: true, name: 'Put stock' });
    });
});

describe('Console run figures (the status box, #465)', () => {
    it('finished, with errors: what its menu lists', () => {
        const f = runFigures({ run: batch(), environment: environment(), counts: { completed: 3, error: 1 }, rowsSent: 800, reprocessed: 1, now: T0 + 200_000 });
        expect(f).to.deep.equal({
            state: 'completed', withErrors: true, requests: { total: 4, done: 4 }, rows: { sent: 800, total: 800 }, completed: 3, errors: 1,
            reprocessed: 1, started: '2026-11-24T09:00:00.000Z', tookMs: 95_000, elapsedMs: null, etaMs: null,
            threads: { current: 4, max: 8 }, errorHandling: 'continue'
        });
    });

    it('live: done so far, time so far, the engine\'s estimate', () => {
        const f = runFigures({ run: batch({ status: 'running', completedAt: undefined }), environment: environment(), counts: { completed: 2, running: 1, pending: 1 }, progress: { estimatedEndTime: T0 + 60_000 }, now: T0 + 40_000 });
        expect({ req: f.requests, el: f.elapsedMs, eta: f.etaMs, took: f.tookMs, we: f.withErrors, rows: f.rows }).to.deep.equal({
            req: { total: 4, done: 2 }, el: 40_000, eta: 20_000, took: null, we: false, rows: { sent: null, total: 800 }
        });
    });

    it('a single run', () => {
        const f = runFigures({ run: batch({ executionType: 'individual', status: 'error', rows: '1' }), counts: { error: 1 }, rowsSent: 1, reprocessed: 0, now: T0 });
        expect({ req: f.requests, errors: f.errors, we: f.withErrors, t: f.threads, rows: f.rows }).to.deep.equal({ req: { total: 1, done: 1 }, errors: 1, we: true, t: null, rows: { sent: 1, total: 1 } });
    });

    it('a name: trimmed, at most 100 characters, never empty', () => {
        expect(checkRunName('  Monday   stock ', 'Old')).to.deep.equal({ name: 'Monday stock' });
        expect(checkRunName('   ', 'Old')).to.have.property('refused').that.is.not.equal('');
        expect(checkRunName('x'.repeat(101), 'Old')).to.have.property('refused');
        expect(checkRunName('Old', 'Old')).to.deep.equal({ refused: '' });
    });
});

describe('Console run: through the controller', () => {
    function consoleOf(run: RunRecord, counts: Record<string, number> = { completed: 3, error: 1 }) {
        const posted: Message[] = [];
        const toasts: string[] = [];
        const updates: Array<[string, Message]> = [];
        let current = { ...run };
        const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
        const ports = {
            metadata: {
                getExecution: async () => current,
                updateExecution: async (id: string, u: Message) => { updates.push([id, u]); current = { ...current, ...u }; },
                countBatchMembersByStatus: async () => counts,
                getBatchMemberLogRows: async () => [{ endpointPath: '/stock/A-1' }],
                getBatchMemberRequestRows: async () => [
                    { id: 'm1', status: 'completed', rows: '200', reprocessCount: 0 }, { id: 'm2', status: 'completed', rows: '200', reprocessCount: 1 },
                    { id: 'm3', status: 'completed', rows: '200' }, { id: 'm4', status: 'error', rows: '200' }
                ]
            },
            environments: { getEnvironment: async () => environment(), getAllEnvironments: async () => [environment()] },
            endpoints: { getEndpoint: async () => ({ id: 'ep-1' }) },
            state: { get: () => undefined, update: async () => undefined },
            logger: { log: () => undefined, error: () => undefined },
            toast: { info: () => undefined, warn: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) }
        };
        const controller = new ConsoleController(session, ports as never, { type: 'batch', batchId: run.id, responseFiles: [] } as never);
        (ConsoleController as unknown as { activeConsoles: Map<string, ConsoleController> }).activeConsoles.set(run.id, controller);
        const of = (type: string) => posted.filter(m => m.type === type);
        return { controller, posted, toasts, updates, of, done: () => controller.dispose(), set: (u: Partial<RunRecord>) => { current = { ...current, ...u }; } };
    }

    it('on opening: the details, and the figures that read every request', async () => {
        const h = consoleOf(batch());
        try {
            await h.controller.tellRun(true);
            expect(h.of('console.details')[0].details).to.deep.include({ name: 'Monday stock', url: 'https://uat.example.test/api/stock/A-1' });
            expect(h.of('console.figures')[0].figures).to.deep.include({ rows: { sent: 800, total: 800 }, reprocessed: 1, completed: 3, errors: 1 });
        } finally { h.done(); }
    });

    it('rename: kept as the run\'s name, answered with it, and the details say it', async () => {
        const h = consoleOf(batch());
        try {
            await h.controller.handle({ type: 'console.rename', name: '  Tuesday   stock ' });
            expect(h.updates).to.have.length(1);
            expect(h.updates[0][1].batchConfiguration).to.deep.include({ name: 'Tuesday stock', stopOnFirstError: false, parallelProcessing: { enabled: true, maxConcurrency: 4 } });
            expect(h.of('console.named')).to.deep.equal([{ type: 'console.named', name: 'Tuesday stock' }]);
            await wait(20);
            expect(h.of('console.details').at(-1)!.details.name).to.equal('Tuesday stock');
        } finally { h.done(); }
    });

    it('rename refused: nothing kept, the name it has comes back, and why', async () => {
        const h = consoleOf(batch());
        try {
            await h.controller.handle({ type: 'console.rename', name: '   ' });
            expect(h.updates).to.have.length(0);
            expect(h.of('console.named')).to.deep.equal([{ type: 'console.named', name: 'Monday stock' }]);
            expect(h.toasts).to.deep.equal(['A run needs a name.']);
        } finally { h.done(); }
    });

    it('a single run can be renamed too', async () => {
        const h = consoleOf(batch({ id: 's-1', executionType: 'individual', rows: '1', batchConfiguration: undefined }));
        try {
            await h.controller.handle({ type: 'console.rename', name: 'Probe' });
            expect(h.updates[0][1].batchConfiguration).to.deep.include({ name: 'Probe' });
        } finally { h.done(); }
    });

    it('live: figures every 250 ms from the count; the run\'s end tells everything at once', async () => {
        const h = consoleOf(batch({ status: 'running', completedAt: undefined }), { completed: 1, running: 1, pending: 2 });
        try {
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-1'], 'running');
            await ConsoleController.sendMemberStatusUpdate('b-1', ['m-2'], 'running');
            await wait(320);
            const live = h.of('console.figures');
            expect(live).to.have.length(1);
            expect(live[0].figures).to.deep.include({ requests: { total: 4, done: 1 }, rows: { sent: null, total: 800 }, reprocessed: null });
            h.set({ status: 'completed', completedAt: new Date(T0 + 95_000) });
            await ConsoleController.sendStatusUpdate('b-1', { status: 'completed' } as never);
            await wait(40);
            expect(h.of('console.figures').at(-1)!.figures).to.deep.include({ state: 'completed', tookMs: 95_000, rows: { sent: 800, total: 800 } });
            expect(h.of('console.details').at(-1)!.details.durationMs).to.equal(95_000);
        } finally { h.done(); }
    });

    it('the rows: a file of 1,000 rows is 1,000, not the 1,001 lines its record counts with the header (lesson 3)', async () => {
        const { rowsTotal } = await import('../../../screens/console/run-details');
        expect(rowsTotal('5(1001)')).to.equal(1000);
        expect(rowsTotal('1(2)')).to.equal(1);
        expect(rowsTotal('1'), 'a paged run says nothing of rows').to.equal(null);
        expect(runFigures({ run: batch({ rows: '5(1001)' }), counts: { completed: 5 }, rowsSent: 1000, now: T0 }).rows).to.deep.equal({ sent: 1000, total: 1000 });
    });
});
