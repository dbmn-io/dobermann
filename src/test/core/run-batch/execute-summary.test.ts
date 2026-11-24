// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #470: the Execute confirmation's data, said in plain words: N rows as M requests to <environment> with its header
 * values, the URL; Error handling and Threads to choose; on production, the shared guard folded in.
 */
import { expect } from 'chai';
import { executeSummary } from '../../../screens/run-batch/execute-summary';
import { cleanExecuteChoices } from '../../../screens/run-batch/execute-choices';
import { clearProductionSuppression, applyProductionChoice } from '../../../services/ui/production-guard.service';

const plan = (over: Record<string, unknown> = {}) => ({
    method: 'POST', urlTemplate: '/items/{{site}}', reps: { applies: true, label: 'Rows per request', value: 5 },
    totals: { rows: 105, requests: 21 },
    requests: [{ url: 'https://api.example.test/items/S1' }],
    ...over
});
const env = (over: Record<string, unknown> = {}) => ({ id: 'e1', name: 'Test', baseUrl: 'https://api.example.test', environmentType: 'development', ...over });

describe('Run Batch: the Execute confirmation (#470)', () => {
    afterEach(() => clearProductionSuppression());

    it('says the rows, the requests and where they go, in one sentence', () => {
        const s = executeSummary({ plan: plan(), environment: env(), headers: [{ name: 'ORG', value: 'DM1' }], current: {} });
        expect(s.rows).to.equal(105);
        expect(s.requests).to.equal(21);
        expect(s.rowsPerRequest).to.deep.equal({ label: 'Rows per request', value: 5 });
        expect(s.method).to.equal('POST');
        expect(s.url).to.equal('https://api.example.test/items/{{site}}');
        expect(s.environment).to.deep.equal({ name: 'Test', production: false, headers: [{ name: 'ORG', value: 'DM1' }] });
        expect(s.sentence).to.equal('105 rows as 21 requests to Test (ORG DM1): POST https://api.example.test/items/{{site}}');
        expect(s.guard).to.equal(null);
    });

    it('one row, one request: said in the singular; no Rows per request where it does not apply', () => {
        const s = executeSummary({ plan: plan({ totals: { rows: 1, requests: 1 }, reps: { applies: false, label: '', value: 1 } }), environment: env(), headers: [], current: {} });
        expect(s.sentence).to.equal('1 row as 1 request to Test: POST https://api.example.test/items/{{site}}');
        expect(s.rowsPerRequest).to.equal(null);
    });

    it('Error handling: Continue processing or Stop on first error (Review\'s words), Continue unless chosen before', () => {
        expect(executeSummary({ plan: plan(), environment: env(), headers: [], current: {} }).errorHandling).to.deep.equal({
            value: 'continue', options: [{ value: 'continue', label: 'Continue processing' }, { value: 'stop', label: 'Stop on first error' }]
        });
        expect(executeSummary({ plan: plan(), environment: env(), headers: [], current: { stopOnFirstError: true } }).errorHandling.value).to.equal('stop');
    });

    it('Threads: 1 always; 2, 4, 8, 16 up to what the environment allows, when it runs in parallel', () => {
        expect(executeSummary({ plan: plan(), environment: env(), headers: [], current: {} }).threads).to.deep.equal({ value: 1, options: [1] });
        const parallel = env({ parallelProcessing: { enabled: true, maxConcurrency: 8 } });
        expect(executeSummary({ plan: plan(), environment: parallel, headers: [], current: { threads: 4 } }).threads).to.deep.equal({ value: 4, options: [1, 2, 4, 8] });
        expect(executeSummary({ plan: plan(), environment: parallel, headers: [], current: { threads: 16 } }).threads.value, 'more than allowed: one').to.equal(1);
    });

    it('production: the shared guard in the same window; while a Warning frequency runs, the line without the choice', () => {
        const prod = env({ id: 'p1', name: 'Prod', environmentType: 'production' });
        const s = executeSummary({ plan: plan(), environment: prod, headers: [], current: {} });
        expect(s.environment.production).to.equal(true);
        expect(s.guard).to.include({ environment: 'Prod', ask: true });
        applyProductionChoice(prod, 30);
        expect(executeSummary({ plan: plan(), environment: prod, headers: [], current: {} }).guard).to.include({ ask: false });
    });

    it('no plan yet (Review not drawn): nothing to confirm', () => {
        expect(() => executeSummary({ plan: undefined, environment: env(), headers: [], current: {} })).to.throw(/Review/);
    });
});

describe('Run Batch: what the confirmation sends back (#470)', () => {
    it('Error handling, Threads within what is allowed, and the production yes with its minutes', () => {
        expect(cleanExecuteChoices({ errorHandling: 'stop', threads: 4, production: { minutes: 15 } }, [1, 2, 4])).to.deep.equal({ stopOnFirstError: true, threads: 4, productionMinutes: 15 });
        expect(cleanExecuteChoices({ errorHandling: 'continue', threads: 1 }, [1])).to.deep.equal({ stopOnFirstError: false, threads: 1 });
    });

    it('Threads the environment does not allow run one at a time; an odd Warning frequency warns every time', () => {
        expect(cleanExecuteChoices({ threads: 16 }, [1, 2]).threads).to.equal(1);
        expect(cleanExecuteChoices({ threads: '4' }, [1, 2, 4]).threads).to.equal(1);
        expect(cleanExecuteChoices({ production: { minutes: 7 } }, [1]).productionMinutes).to.equal(0);
    });

    it('nothing sent: keep going, one thread, no production yes', () => {
        expect(cleanExecuteChoices(undefined, [1, 2])).to.deep.equal({ stopOnFirstError: false, threads: 1 });
    });
});
