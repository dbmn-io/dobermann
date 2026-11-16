// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A batch member whose saved request body can't be read must fail, never go out empty.
 * Seen 2026-10-10: a web app tab reloaded mid-batch; on Resume the batch's archive wasn't
 * loaded yet, the first two members' bodies read as missing, and two POSTs went out with no
 * body ("Invalid JSON body"). The engine used to log a warning and send them anyway.
 */
import { expect } from 'chai';
import { stub } from 'sinon';
import { ExecutionService } from '../../../services/execution/execution.service';
import { createMockLogger } from '../../helpers/logging/mock-logger';

function service(method: string) {
    const member = {
        id: 'm-1', executionType: 'batch_member', status: 'pending', endpointId: 'ep', endpointName: 'Upload',
        endpointMethod: method, endpointPath: '/inventory', environment: 'env-1',
        requestFile: '/nowhere/batch/b1/transaction-001.json', requestHeaders: {}, requestQueryParams: {}
    };
    const executeEndpoint = stub().resolves({ success: true, status: 200, statusText: 'OK', data: {}, duration: 1, url: 'x' });
    const svc = new ExecutionService({
        executionMetadataService: {
            getExecution: stub().resolves(member),
            updateExecution: stub().resolves(),
            updateExecutionMetadata: stub().resolves()
        },
        executionFileService: {},
        executionValidationService: {},
        requestExecutor: { executeEndpoint }
    } as never, createMockLogger());
    return { svc, executeEndpoint };
}

describe('A batch member\'s request body that can\'t be read', () => {
    it('POST: fails the member and sends nothing', async () => {
        const { svc, executeEndpoint } = service('POST');
        const result = await svc.executeRecord('m-1');
        expect(executeEndpoint.called, 'nothing sent').to.equal(false);
        expect(result.success).to.equal(false);
        expect(result.errorMessage).to.contain('transaction-001.json');
        expect(result.errorMessage).to.contain('nothing was sent');
    });

    it('GET (no body to send): goes ahead as before', async () => {
        const { svc, executeEndpoint } = service('GET');
        await svc.executeRecord('m-1');
        expect(executeEndpoint.called).to.equal(true);
    });
});
