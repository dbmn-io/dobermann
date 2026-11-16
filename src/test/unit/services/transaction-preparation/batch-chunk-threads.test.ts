// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #312: changing the thread count in the Console's Settings tab must change
 * how many transactions can run at once — immediately.
 *
 * The engine's loop did read the new count, but the just-in-time preparation
 * chunk was frozen at creation (`preparationState.chunkSize` = 2 × the concurrency
 * then). A batch started sequential prepared two transactions at a time for ever,
 * so with 8 threads only two were ever ready to run.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { TransactionPreparationService } from '../../../../services/transaction-preparation/transaction-preparation.service';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

const TEMPLATE = JSON.stringify({ sku: '{{sku:string}}', quantity: '{{quantity:number}}' });
const CSV: string[][] = [['sku', 'quantity'], ...Array.from({ length: 20 }, (_, i) => [`SKU-${i + 1}`, String(i + 1)])];

function serviceWith(batchConfiguration: unknown) {
    const sent: unknown[] = [];
    const deps: any = {
        jsonGenerator: new JsonGenerator(),
        batchMemberHandler: { createTransaction: stub().callsFake(async (args: any) => { sent.push(args.preGeneratedJson); return { executionId: `m${sent.length}`, requestFilePath: '/ws/b/r.json' }; }) },
        executionMetadataService: {
            updateExecution: stub().resolves(),
            getExecution: stub().resolves({
                // Created sequential: a chunk of two
                preparationState: { totalRows: 20, totalTransactions: 20, preparedTransactions: 0, nextCsvRowIndex: 1, chunkSize: 2, isComplete: false },
                requestFile: '/ws/b/input.csv', endpointConfig: { id: 'ep-1', body: TEMPLATE, dataLoadingConfig: { repeatableArrays: [] } },
                batchConfiguration, environment: 'local'
            })
        },
        arrayRepetitionHelper: {
            analyzeArrayRepetition: stub().resolves({}),
            groupRowsForTransactions: stub().callsFake((rows: string[][]) => rows.slice(1).map(r => [r]))
        },
        executionLoggingService: { logBatchEvent: stub().resolves() }, transactionCreator: {}
    };
    const service = new TransactionPreparationService(deps, createMockLogger());
    (service as any).readCsvFromFile = async () => CSV;
    return { service, sent };
}

describe('JIT chunk follows the batch\'s current thread count (Issue #312)', () => {
    it('still sequential: the chunk it was created with', async () => {
        const { service } = serviceWith({ parallelProcessing: { enabled: false, maxConcurrency: 1 } });
        expect(await service.prepareNextChunk('b')).to.equal(2);
    });

    it('Settings → 8 threads: the next chunk is sixteen, so eight can run at once', async () => {
        const { service } = serviceWith({ parallelProcessing: { enabled: true, maxConcurrency: 8 } });
        expect(await service.prepareNextChunk('b')).to.equal(16);
    });

    it('never below the chunk it was created with', async () => {
        const { service } = serviceWith({ parallelProcessing: { enabled: true, maxConcurrency: 1 } });
        expect(await service.prepareNextChunk('b')).to.equal(2);
    });
});
