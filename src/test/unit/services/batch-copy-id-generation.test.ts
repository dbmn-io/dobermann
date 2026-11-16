// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Copy ID Generation Unit Tests (GitHub Issue #176)
 *
 * Tests the deterministic batch ID generation:
 * - original-uuid → original-uuid_v2
 * - original-uuid_v2 → original-uuid_v3
 * - When _v2 and _v3 exist → _v4
 * - Strips _vN suffix to find root ID
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { BatchCopyService } from '../../../services/batch-copy/batch-copy.service';

describe('Batch Copy ID Generation (GitHub Issue #176)', () => {
    let batchCopyService: BatchCopyService;
    let mockExecutionMetadataService: any;
    let mockTransactionPreparationService: any;
    let mockEndpointManager: any;
    let mockEnvironmentManager: any;

    beforeEach(() => {
        mockExecutionMetadataService = {
            getExecution: sinon.stub(),
            getBatchMemberExecutions: sinon.stub(),
            getExecutionTable: sinon.stub(),
            updateExecution: sinon.stub()
        };

        mockTransactionPreparationService = {
            prepareBatchTransactions: sinon.stub()
        };

        mockEndpointManager = {
            getEndpoint: sinon.stub()
        };

        mockEnvironmentManager = {
            getEnvironment: sinon.stub()
        };

        batchCopyService = new BatchCopyService(
            mockExecutionMetadataService,
            mockTransactionPreparationService,
            mockEndpointManager,
            mockEnvironmentManager
        );
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('generateCopyBatchId', () => {
        it('should generate _v2 for an original batch with no existing copies', async () => {
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [],
                totalCount: 0,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid');
            expect(newId).to.equal('original-uuid_v2');
        });

        it('should generate _v3 when _v2 already exists', async () => {
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: 'original-uuid_v2' }
                ],
                totalCount: 1,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid');
            expect(newId).to.equal('original-uuid_v3');
        });

        it('should generate _v4 when _v2 and _v3 exist', async () => {
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: 'original-uuid_v2' },
                    { id: 'original-uuid_v3' }
                ],
                totalCount: 2,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid');
            expect(newId).to.equal('original-uuid_v4');
        });

        it('should strip _vN suffix from source ID and use root ID', async () => {
            // Copying from a copy: original-uuid_v2 → should use root "original-uuid"
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: 'original-uuid_v2' }
                ],
                totalCount: 1,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid_v2');
            expect(newId).to.equal('original-uuid_v3');
        });

        it('should handle _v3 source with _v2 and _v3 existing', async () => {
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: 'original-uuid_v2' },
                    { id: 'original-uuid_v3' }
                ],
                totalCount: 2,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid_v3');
            expect(newId).to.equal('original-uuid_v4');
        });

        it('should handle timestamp-style IDs', async () => {
            const timestampId = '2024-01-01T10-00-00_abc';

            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [],
                totalCount: 0,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId(timestampId);
            expect(newId).to.equal('2024-01-01T10-00-00_abc_v2');
        });

        it('should handle timestamp-style IDs with existing versions', async () => {
            const timestampId = '2024-01-01T10-00-00_abc';

            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: '2024-01-01T10-00-00_abc_v2' },
                    { id: '2024-01-01T10-00-00_abc_v3' }
                ],
                totalCount: 2,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId(timestampId);
            expect(newId).to.equal('2024-01-01T10-00-00_abc_v4');
        });

        it('should not be confused by unrelated batches', async () => {
            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [
                    { id: 'other-batch_v2' },
                    { id: 'original-uuid_v2' },
                    { id: 'another-batch_v5' }
                ],
                totalCount: 3,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId('original-uuid');
            expect(newId).to.equal('original-uuid_v3');
        });

        it('should handle IDs with special regex characters', async () => {
            // IDs could contain characters that are special in regex
            const specialId = 'batch.test+123';

            mockExecutionMetadataService.getExecutionTable.resolves({
                executions: [],
                totalCount: 0,
                page: 1,
                pageSize: 1000,
                totalPages: 1
            });

            const newId = await batchCopyService.generateCopyBatchId(specialId);
            expect(newId).to.equal('batch.test+123_v2');
        });
    });
});
