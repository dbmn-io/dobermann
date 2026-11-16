// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #396: Run Batch on a GET endpoint whose query params carry a pagination
 * template ({{A8:PAGE:0:data.header.totalCount}}) sat on "Preparing batch execution…".
 * The cause was the DBMN sign-in, not preparation: these pin that preparing the issue's
 * endpoint finishes, and leaves the page template for run time.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { TransactionPreparationService, TransactionPreparationServiceDependencies } from '../../../../services/transaction-preparation/transaction-preparation.service';
import { TransactionPreparationInput } from '../../../../services/transaction-preparation/transaction-preparation.interface';
import { APIEndpointConfig } from '../../../../data-loading/types';
import { JsonGenerator } from '../../../../data-loading/json-generator';
import { ArrayRepetitionHelper } from '../../../../services/transaction-preparation/helpers/array-repetition.helper';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

const PAGE = '{{A8:PAGE:0:data.header.totalCount}}';
const ENDPOINT = {
    id: 'ep-396', name: 'Inventory by Item', method: 'GET',
    path: '/dcinventory/api/dcinventory/inventory', body: '',
    queryParams: {
        query: { value: 'ItemId=ACAU-{{ItemId}}[ or ]', enabled: true },
        page: { value: PAGE, enabled: true },
        size: { value: '50', enabled: true }
    },
    dataLoadingConfig: { repeatableArrays: [] }
} as unknown as APIEndpointConfig;
const ITEMS = ['A5397739', 'A5437233', 'A5437254', 'A5566452', 'A5747249', 'A5759443', 'A9339663', 'A9617664'];
const CSV: string[][] = [['ItemId'], ...ITEMS.map(item => [item])];

/** What preparation hands the member handler, as far as these tests look. */
interface PreparedMember {
    queryParams?: Record<string, string>;
    endpoint?: { queryParams?: Record<string, { value: string }> };
}

function harness() {
    const members: PreparedMember[] = [];
    let state: Record<string, unknown> = {};
    const deps = {
        jsonGenerator: new JsonGenerator(),
        arrayRepetitionHelper: new ArrayRepetitionHelper(),
        batchHandler: { createTransaction: stub().resolves({ executionId: 'batch-396', requestFilePath: '/ws/b/input.csv', directoryPath: '/ws/b' }) },
        batchMemberHandler: {
            createTransaction: stub().callsFake(async (member: PreparedMember) => {
                members.push(member);
                return { executionId: `m${members.length}`, requestFilePath: '/ws/b/r.json' };
            })
        },
        executionMetadataService: {
            updateExecution: stub().callsFake(async (_id: string, update: Record<string, unknown>) => { state = { ...state, ...update }; }),
            getExecution: stub().callsFake(async () => ({ ...state, requestFile: '/ws/b/input.csv', endpointConfig: ENDPOINT, batchConfiguration: {}, environment: 'local' }))
        },
        executionLoggingService: { logBatchEvent: stub().resolves(), logExecutionEvent: stub().resolves() },
        transactionCreator: {},
        notificationService: { showError: stub(), showSuccess: stub() }
    } as unknown as TransactionPreparationServiceDependencies;
    return { service: new TransactionPreparationService(deps, createMockLogger()), members };
}

const BASE: TransactionPreparationInput = {
    endpoint: ENDPOINT, environment: 'PROD', environmentId: 'env-1', organization: '840', workspaceRoot: '/ws',
    csvData: CSV, columnMappings: { ItemId: 'ItemId' }, batchName: 'batch-396'
};

/** The bug looked like a hang: fail fast instead of waiting for mocha's timeout. */
const withinFiveSeconds = <T>(work: Promise<T>) => Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('preparation hung for 5s')), 5000))
]);

describe('Issue #396: Run Batch with a paginated query param', () => {
    it('a repeated [ or ] param prepares one request carrying every item, the page template untouched', async () => {
        const { service, members } = harness();
        const result = await withinFiveSeconds(service.prepareBatchTransactions({
            ...BASE,
            batchConfig: { repeatableQueryParam: { enabled: true, paramKey: 'query', pattern: 'ItemId=ACAU-{{ItemId}}', separator: ' or ', maxUrlLength: 2000, maxPerRequest: 100 } },
            preCalculatedTransactions: 1
        }));

        expect(result.status).to.equal('pending');
        expect(members).to.have.length(1);
        expect(members[0].queryParams).to.deep.equal({
            page: PAGE,
            size: '50',
            query: ITEMS.map(item => `ItemId=ACAU-${item}`).join(' or ')
        });
    });

    it('without repetition, preparation finishes and every request keeps the page template', async () => {
        const { service, members } = harness();
        const result = await withinFiveSeconds(service.prepareBatchTransactions({
            ...BASE,
            endpoint: { ...ENDPOINT, queryParams: { ...ENDPOINT.queryParams, query: { value: 'ItemId=ACAU-{{ItemId}}', enabled: true } } } as APIEndpointConfig,
            batchConfig: {}
        }));

        expect(result.status).to.equal('pending');
        expect(members).to.not.be.empty;
        for (const member of members) expect(member.endpoint?.queryParams?.page?.value).to.equal(PAGE);
    });
});
