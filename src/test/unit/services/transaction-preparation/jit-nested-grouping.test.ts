// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JIT chunking of a nested template groups rows on EVERY header field, not the first.
 *
 * Puppy School Lesson 5, Step 6: the template's header is buyerGln then supplierGln, and the
 * file is one warehouse ordering from three suppliers. buyerGln is the same on every row.
 * Chunk planning keyed on the first header field alone, so it saw ONE root element: the
 * totals, the chunk cursor and the "is it complete" check were all worked out on the wrong
 * key, and the Run Batch preview's count (also first-field only) said one API call.
 */

import { expect } from 'chai';
import { stub } from 'sinon';
import { TransactionPreparationService } from '../../../../services/transaction-preparation/transaction-preparation.service';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

const TEMPLATE = JSON.stringify({
    poNumber: 'PO-REPLEN-{{A8:sequence}}',
    buyerGln: '{{buyerGln:string}}',
    supplierGln: '{{supplierGln:string}}',
    status: 'draft',
    lines: [{
        gtin: '{{gtin:string}}',
        lineNumber: '{{A8:sequence:local}}',
        orderedQty: '{{orderedQty:number}}'
    }]
}, null, 2);

const BUYER = '0614141000012';
// Sorted as the frontend sorts it: on every grouping column, buyer then supplier.
const CSV: string[][] = [
    ['buyerGln', 'supplierGln', 'gtin', 'orderedQty'],
    [BUYER, '4012345000030', '00012345600081', '100'],
    [BUYER, '4012345000030', '00012345600081', '100'],
    [BUYER, '4012345000047', '00012345600043', '50'],
    [BUYER, '4012345000054', '00012345600050', '200'],
    [BUYER, '4012345000054', '00012345600050', '200']
];

describe('TransactionPreparationService — nested JIT chunks group on every header field', () => {
    it('one buyer, three suppliers: three orders across two chunks, complete only after the last', async () => {
        const sent: any[] = [];
        let state: any = {};
        const endpoint = { id: 'ep-1', body: TEMPLATE, dataLoadingConfig: { repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }] } };
        const deps: any = {
            jsonGenerator: new JsonGenerator(),
            batchMemberHandler: {
                createTransaction: stub().callsFake(async (args: any) => { sent.push(args.preGeneratedJson); return { executionId: `m${sent.length}`, requestFilePath: '/ws/b/r.json' }; })
            },
            executionMetadataService: {
                updateExecution: stub().callsFake(async (_id: string, update: any) => {
                    if (update.preparationState) { state = { ...state, ...update.preparationState }; }
                }),
                getExecution: stub().callsFake(async () => ({
                    preparationState: state, requestFile: '/ws/b/input.csv', endpointConfig: endpoint, batchConfiguration: {},
                    environment: 'local', columnMappingUsed: undefined
                }))
            },
            arrayRepetitionHelper: {}, executionLoggingService: { logBatchEvent: stub().resolves() }, transactionCreator: {}
        };
        const service = new TransactionPreparationService(deps, createMockLogger());
        (service as any).readCsvFromFile = async () => CSV;

        // maxParallel 1 → CHUNK_SIZE 2: the first chunk takes two orders, the next the third.
        // preCalculatedTransactions 1 is what the old Run Batch preview sent for this file.
        const first = await service.prepareFirstChunk('b', CSV, {}, 1, endpoint, 'local', undefined, undefined, '', '/ws', undefined, undefined, 1, {});

        expect(first).to.equal(2);
        expect(state.totalGroups, 'three suppliers, three root elements').to.equal(3);
        expect(state.totalTransactions).to.equal(3);
        expect(state.isComplete, 'two of three prepared is not complete').to.equal(false);

        const next = await service.prepareNextChunk('b');
        expect(next).to.equal(1);
        expect(sent.map(o => [o.supplierGln, o.lines.length])).to.deep.equal([
            ['4012345000030', 2], ['4012345000047', 1], ['4012345000054', 2]
        ]);
        expect(sent.every(o => o.buyerGln === BUYER)).to.equal(true);
    });

    it('a batch prepared before groupingColumns existed still chunks on its one groupingColumn', async () => {
        const sent: any[] = [];
        const endpoint = { id: 'ep-1', body: TEMPLATE, dataLoadingConfig: { repeatableArrays: [{ arrayPath: 'lines', enabled: true, maxRepetitions: 1000 }] } };
        const legacyState = { totalRows: 6, totalTransactions: 3, preparedTransactions: 1, nextCsvRowIndex: 2, chunkSize: 2, isComplete: false,
            groupingColumn: 'supplierGln', totalGroups: 3, preparedGroups: 1, groupsPerFile: 1 };
        const deps: any = {
            jsonGenerator: new JsonGenerator(),
            batchMemberHandler: { createTransaction: stub().callsFake(async (args: any) => { sent.push(args.preGeneratedJson); return { executionId: 'm', requestFilePath: '/ws/b/r.json' }; }) },
            executionMetadataService: {
                updateExecution: stub().resolves(),
                getExecution: stub().resolves({ preparationState: legacyState, requestFile: '/ws/b/input.csv', endpointConfig: endpoint, batchConfiguration: {}, environment: 'local' })
            },
            arrayRepetitionHelper: {}, executionLoggingService: { logBatchEvent: stub().resolves() }, transactionCreator: {}
        };
        const service = new TransactionPreparationService(deps, createMockLogger());
        (service as any).readCsvFromFile = async () => CSV;

        expect(await service.prepareNextChunk('b')).to.equal(2);
        expect(sent.map(o => o.supplierGln)).to.deep.equal(['4012345000047', '4012345000054']);
    });
});
