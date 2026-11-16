// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #354: Execute must send what Step 4 Review showed.
 *
 * The PIX template wraps its repeating array in an object: { "Payload": { "ExportDocuments": [ … ] } }.
 * Review only offered top-level arrays, so it planned one request per row and showed no Rows per
 * request. Execute repeated the endpoint's SAVED array (Payload.ExportDocuments, Reps above 1), and
 * sent every row in one request. Review now offers the wrapped array, and Execute takes its array
 * setting from the same rule (effectiveRepeatableArrays) — never from a saved setting Review ignores.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { planBatch, effectiveRepeatableArrays } from '../../../data-loading/batch-plan';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { RepeatableArray } from '../../../data-loading/zod-schemas';
import { TransactionPreparationService } from '../../../services/transaction-preparation/transaction-preparation.service';
import { ArrayRepetitionHelper } from '../../../services/transaction-preparation/helpers/array-repetition.helper';
import { createMockLogger } from '../../helpers/logging/mock-logger';

// The #354 template, cut down to what matters: an object wrapper, ENV values outside the array,
// and an array of arrays inside each document (not a candidate: it sits inside ExportDocuments[]).
const PIX = JSON.stringify({
    Payload: {
        ContextInformation: { Organization: '840', Location: '{{ENV:org}}' },
        CurrentPage: 1,
        ExportDocuments: [{
            TransactionNumber: '888{{A8:sequence}}',
            ItemDefinition: { ItemId: 'ACAU-{{ItemId}}' },
            PIXFields: {
                Quantity: '{{Quantity}}',
                ConditionCodes: [{ ToConditionCodes: [{ ConditionCodeId: '{{ConditionCodeId:string|2}}' }] }]
            }
        }],
        TotalPages: 1
    }
});
const HEADERS = ['ItemId', 'Quantity', 'ConditionCodeId'];
const ROWS = [['A5516652', '12', 'OD'], ['A5549205', '6', 'SG'], ['A5580155', '1', 'SG'], ['A5641103', '24', 'SG'],
    ['A5677623', '16', 'SG'], ['A9304677', '1', 'SG'], ['A9458828', '18', 'OD']];
const MAPPINGS = HEADERS.map(h => ({ variable: h, column: h, dataType: 'string' }));
const ENV = { org: '840' };
const docs = (body: unknown) => ((body as { Payload: { ExportDocuments: unknown[] } }).Payload.ExportDocuments);

/** What Step 4 shows, given the endpoint's saved setting (as RunBatchWebview.buildPlanForPreview calls it). */
const review = (body: string, saved: RepeatableArray[], headers: string[], rows: string[][]) => {
    const enabled = saved.find(a => a.enabled);
    return planBatch({ endpoint: { method: 'POST', path: '/x', body }, headers, rows,
        mappings: headers.map(h => ({ variable: h, column: h, dataType: 'string' })),
        reps: enabled?.maxRepetitions || 1, arrayPath: enabled?.arrayPath || null, environmentVariables: ENV });
};
/** What Execute's generator builds from the same saved setting. */
const execute = (body: string, saved: RepeatableArray[], headers: string[], rows: string[][]) =>
    new JsonGenerator().generateBatchJsonFiles([headers, ...rows].map(r => r.join(',')).join('\n'), {
        template: body, headers, mappings: headers.map(h => ({ variable: h, column: h, dataType: 'string' })),
        repeatableArrays: effectiveRepeatableArrays(body, saved), environmentVariables: ENV
    } as never);

describe('#354 Review offers an array wrapped in an object', () => {
    it('Payload.ExportDocuments is the repeated array; the arrays inside each document are not', async () => {
        const plan = await review(PIX, [], HEADERS, ROWS);
        expect(plan.shape).to.equal('flat');
        expect(plan.arrayCandidates).to.deep.equal(['Payload.ExportDocuments']);
        expect(plan.arrayPath).to.equal('Payload.ExportDocuments');
        expect(plan.reps).to.deep.equal({ applies: true, label: 'Rows per request', value: 1 });
        expect(plan.totals).to.deep.equal({ rows: 7, requests: 7 });
        expect(plan.requests.every(r => docs(r.body).length === 1)).to.equal(true);
    });

    it('Rows per request 7: one request carrying all seven documents', async () => {
        const plan = await review(PIX, [{ arrayPath: 'Payload.ExportDocuments', enabled: true, maxRepetitions: 7 }], HEADERS, ROWS);
        expect(plan.totals.requests).to.equal(1);
        expect(docs(plan.requests[0].body)).to.have.length(7);
        expect((docs(plan.requests[0].body)[6] as { ItemDefinition: { ItemId: string } }).ItemDefinition.ItemId).to.equal('ACAU-A9458828');
    });

    it('a top-level array still comes before a wrapped one', async () => {
        const body = JSON.stringify({ meta: { docs: [{ a: '{{a}}' }] }, items: [{ b: '{{b}}' }] });
        const plan = await planBatch({ endpoint: { method: 'POST', path: '/x', body }, headers: ['a', 'b'], rows: [['1', '2']],
            mappings: [{ variable: 'a', column: 'a' }, { variable: 'b', column: 'b' }], reps: 1 });
        expect(plan.arrayCandidates).to.deep.equal(['items', 'meta.docs']);
        expect(plan.arrayPath).to.equal('items');
    });
});

describe('#354 Execute sends the requests Review showed', () => {
    const cases: Array<{ name: string; body: string; saved: RepeatableArray[]; headers: string[]; rows: string[][]; requests: number }> = [
        { name: 'wrapped array, nothing saved', body: PIX, saved: [], headers: HEADERS, rows: ROWS, requests: 7 },
        { name: 'wrapped array, saved Reps 100 (the issue)', body: PIX,
            saved: [{ arrayPath: 'Payload.ExportDocuments', enabled: true, maxRepetitions: 100 }], headers: HEADERS, rows: ROWS, requests: 1 },
        { name: 'wrapped array, a saved array Review does not offer', body: PIX,
            saved: [{ arrayPath: 'Payload.ExportDocuments[].PIXFields.ConditionCodes', enabled: true, maxRepetitions: 3 }], headers: HEADERS, rows: ROWS, requests: 3 },
        { name: 'no array, a stale saved array', body: JSON.stringify({ gtin: '{{gtin}}' }),
            saved: [{ arrayPath: 'items', enabled: true, maxRepetitions: 5 }], headers: ['gtin'], rows: [['a'], ['b'], ['c']], requests: 3 },
        { name: 'top-level array, saved Reps 2', body: JSON.stringify([{ gtin: '{{gtin}}' }]),
            saved: [{ arrayPath: '$root', enabled: true, maxRepetitions: 2 }], headers: ['gtin'], rows: [['a'], ['b'], ['c']], requests: 2 }
    ];
    for (const c of cases) {
        it(c.name, async () => {
            const plan = await review(c.body, c.saved, c.headers, c.rows);
            const sent = await execute(c.body, c.saved, c.headers, c.rows);
            expect(plan.totals.requests, 'Review').to.equal(c.requests);
            expect(sent.files.length, 'Execute').to.equal(plan.totals.requests);
            expect(sent.files.slice(0, plan.requests.length).map(f => f.rowRange.end - f.rowRange.start + 1), 'rows per request (the samples)')
                .to.deep.equal(plan.requests.map(r => r.rowCount));
        });
    }

    it('the batch Execute prepares from the endpoint has Review\'s requests', async () => {
        // Saved: an array Review does not offer. Review plans 3 requests of ExportDocuments (3, 3, 1).
        const saved = [{ arrayPath: 'Payload.ExportDocuments[].PIXFields.ConditionCodes', enabled: true, maxRepetitions: 3 }];
        const endpoint = { id: 'ep-354', name: 'PIX', method: 'POST', path: '/pix', body: PIX, dataLoadingConfig: { repeatableArrays: saved } };
        const sent: unknown[] = [];
        let state: Record<string, unknown> = {};
        const deps: any = {
            jsonGenerator: new JsonGenerator(),
            arrayRepetitionHelper: new ArrayRepetitionHelper(),
            batchHandler: { createTransaction: stub().resolves({ executionId: 'b', requestFilePath: '/ws/b/input.csv', directoryPath: '/ws/b' }) },
            batchMemberHandler: {
                createTransaction: stub().callsFake(async (args: { preGeneratedJson: unknown }) => { sent.push(args.preGeneratedJson); return { executionId: `m${sent.length}`, requestFilePath: '/ws/b/r.json' }; })
            },
            executionMetadataService: {
                updateExecution: stub().callsFake(async (_id: string, update: { preparationState?: Record<string, unknown> }) => {
                    if (update.preparationState) { state = { ...state, ...update.preparationState }; }
                }),
                getExecution: stub().callsFake(async () => ({ preparationState: state, requestFile: '/ws/b/input.csv', endpointConfig: endpoint, batchConfiguration: {} }))
            },
            executionLoggingService: { logBatchEvent: stub().resolves() }, transactionCreator: {}
        };
        const service = new TransactionPreparationService(deps, createMockLogger());
        await service.prepareBatchTransactions({
            endpoint, environment: 'local', organization: '', workspaceRoot: '/ws', csvData: [HEADERS, ...ROWS],
            columnMappings: Object.fromEntries(MAPPINGS.map(m => [m.variable, m.column])), environmentVariables: ENV,
            batchConfig: { parallelProcessing: { enabled: true, maxConcurrency: 5 } }
        } as never);

        const plan = await review(PIX, saved, HEADERS, ROWS);
        expect(plan.requests.map(r => docs(r.body).length)).to.deep.equal([3, 3, 1]);
        expect(sent.map(body => docs(body).length)).to.deep.equal([3, 3, 1]);
        expect(state.totalTransactions).to.equal(3);
    });
});
