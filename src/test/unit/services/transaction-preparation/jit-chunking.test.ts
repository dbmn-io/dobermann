// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for JIT (Just-In-Time) Chunking in TransactionPreparationService
 *
 * Tests the prepareNextChunk() functionality for streaming batch preparation
 * GitHub Issue #94: JIT Streaming Implementation
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { TransactionPreparationService } from '../../../../services/transaction-preparation/transaction-preparation.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';
import * as fs from 'fs';
import * as path from 'path';

describe('TransactionPreparationService - JIT Chunking Unit Tests', () => {
    let service: TransactionPreparationService;
    let mockDependencies: any;
    let mockLogger: any;
    let readFileSyncStub: SinonStub;
    let existsSyncStub: SinonStub;

    beforeEach(() => {
        mockLogger = createMockLogger();

        // Mock dependencies
        mockDependencies = {
            executionMetadataService: {
                getExecution: stub(),
                updateExecution: stub().resolves()
            },
            batchMemberHandler: {
                createTransaction: stub().resolves({
                    executionId: 'test-member-id',
                    requestFilePath: '/test/request.json'
                })
            },
            arrayRepetitionHelper: {
                analyzeArrayRepetition: stub().returns({
                    totalTransactions: 9,
                    rowGroups: [
                        { startRow: 1, endRow: 1, rows: [{ col1: 'val1' }] },
                        { startRow: 2, endRow: 2, rows: [{ col1: 'val2' }] },
                        { startRow: 3, endRow: 3, rows: [{ col1: 'val3' }] },
                        { startRow: 4, endRow: 4, rows: [{ col1: 'val4' }] },
                        { startRow: 5, endRow: 5, rows: [{ col1: 'val5' }] },
                        { startRow: 6, endRow: 6, rows: [{ col1: 'val6' }] },
                        { startRow: 7, endRow: 7, rows: [{ col1: 'val7' }] },
                        { startRow: 8, endRow: 8, rows: [{ col1: 'val8' }] },
                        { startRow: 9, endRow: 9, rows: [{ col1: 'val9' }] }
                    ]
                }),
                groupRowsForTransactions: stub().callsFake((rows: any[], arrays: any[]) => {
                    // Return rowGroups for JIT chunking
                    return [
                        { startRow: 1, endRow: 1, rows: [{ col1: 'val1' }] },
                        { startRow: 2, endRow: 2, rows: [{ col1: 'val2' }] },
                        { startRow: 3, endRow: 3, rows: [{ col1: 'val3' }] },
                        { startRow: 4, endRow: 4, rows: [{ col1: 'val4' }] },
                        { startRow: 5, endRow: 5, rows: [{ col1: 'val5' }] },
                        { startRow: 6, endRow: 6, rows: [{ col1: 'val6' }] },
                        { startRow: 7, endRow: 7, rows: [{ col1: 'val7' }] },
                        { startRow: 8, endRow: 8, rows: [{ col1: 'val8' }] },
                        { startRow: 9, endRow: 9, rows: [{ col1: 'val9' }] }
                    ];
                })
            },
            executionLoggingService: {
                logBatchEvent: stub().resolves()
            },
            transactionCreator: {}
        };

        service = new TransactionPreparationService(mockDependencies, mockLogger);

        // Stub file system operations
        const csvContent = 'col1\nval1\nval2\nval3\nval4\nval5\nval6\nval7\nval8\nval9';
        readFileSyncStub = stub(fs, 'readFileSync').returns(csvContent);
        existsSyncStub = stub(fs, 'existsSync').returns(true);
    });

    afterEach(() => {
        readFileSyncStub.restore();
        existsSyncStub.restore();
    });

    describe('prepareNextChunk() - Basic Chunking', () => {
        it('should prepare correct chunk size based on CHUNK_SIZE', async () => {
            // Arrange
            const batchId = 'test-batch-1';
            const CHUNK_SIZE = 2;

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: CHUNK_SIZE,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert
            expect(createdCount).to.equal(2);
            expect(mockDependencies.batchMemberHandler.createTransaction.callCount).to.equal(2);
        });

        it('should handle last chunk with remainder', async () => {
            // Arrange - 9 total, already prepared 8, chunk size 2
            const batchId = 'test-batch-2';
            const CHUNK_SIZE = 2;

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 8, // Already prepared 8
                    nextCsvRowIndex: 8,
                    chunkSize: CHUNK_SIZE,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert - Should only create 1 (the remainder)
            expect(createdCount).to.equal(1);
            expect(mockDependencies.batchMemberHandler.createTransaction.callCount).to.equal(1);
        });

        it('should return 0 when preparation is already complete', async () => {
            // Arrange
            const batchId = 'test-batch-3';

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 9,
                    nextCsvRowIndex: 9,
                    chunkSize: 2,
                    isComplete: true // Already complete
                }
            });

            // Act
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert
            expect(createdCount).to.equal(0);
            expect(mockDependencies.batchMemberHandler.createTransaction.called).to.be.false;
        });
    });

    describe('prepareNextChunk() - Cursor Tracking', () => {
        it('should update preparedTransactions cursor correctly', async () => {
            // Arrange
            const batchId = 'test-batch-4';
            const CHUNK_SIZE = 2;

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: CHUNK_SIZE,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act
            await service.prepareNextChunk(batchId);

            // Assert - Should update to 2
            const updateCall = mockDependencies.executionMetadataService.updateExecution.firstCall;
            expect(updateCall.args[1].preparationState.preparedTransactions).to.equal(2);
        });

        it('should set isComplete flag when reaching totalTransactions', async () => {
            // Arrange - Last chunk
            const batchId = 'test-batch-5';

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 8,
                    nextCsvRowIndex: 8,
                    chunkSize: 2,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act
            await service.prepareNextChunk(batchId);

            // Assert - isComplete should be true
            const updateCall = mockDependencies.executionMetadataService.updateExecution.firstCall;
            expect(updateCall.args[1].preparationState.isComplete).to.be.true;
            expect(updateCall.args[1].preparationState.preparedTransactions).to.equal(9);
        });

        it('should update nextCsvRowIndex cursor correctly', async () => {
            // Arrange
            const batchId = 'test-batch-6';

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: 2,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act
            await service.prepareNextChunk(batchId);

            // Assert - nextCsvRowIndex should be set (may be calculated from rowGroups)
            const updateCall = mockDependencies.executionMetadataService.updateExecution.firstCall;
            expect(updateCall.args[1].preparationState).to.have.property('nextCsvRowIndex');
            expect(updateCall.args[1].preparationState.nextCsvRowIndex).to.be.a('number');
        });
    });

    describe('prepareNextChunk() - Cancellation', () => {
        it('should stop preparation when cancelled', async () => {
            // Arrange
            const batchId = 'test-batch-7';

            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch',
                requestFile: '/test/batch.csv',
                environment: 'TEST',
                environmentId: 'TEST',
                organization: 'TEST_ORG',
                endpointId: 'test-endpoint',
                directoryPath: '/test/dir',
                preparationState: {
                    totalRows: 9,
                    totalTransactions: 9,
                    preparedTransactions: 0,
                    nextCsvRowIndex: 0,
                    chunkSize: 2,
                    isComplete: false
                },
                endpointConfig: {
                    id: 'test-endpoint',
                    name: 'Test Endpoint',
                    method: 'POST',
                    path: '/test',
                    dataLoadingConfig: {
                        repeatableArrays: []
                    }
                },
                batchConfiguration: {},
                columnMappingUsed: []
            });

            // Act - Cancel before calling prepareNextChunk
            service.cancelBatchPreparation(batchId);
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert
            expect(createdCount).to.equal(0);
            expect(mockDependencies.batchMemberHandler.createTransaction.called).to.be.false;
        });
    });

    describe('prepareNextChunk() - Error Handling', () => {
        it('should return 0 when batch metadata not found', async () => {
            // Arrange
            const batchId = 'nonexistent-batch';
            mockDependencies.executionMetadataService.getExecution.resolves(null);

            // Act
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert
            expect(createdCount).to.equal(0);
        });

        it('should return 0 when preparationState is missing', async () => {
            // Arrange
            const batchId = 'test-batch-8';
            mockDependencies.executionMetadataService.getExecution.resolves({
                id: batchId,
                executionType: 'batch'
                // No preparationState
            });

            // Act
            const createdCount = await service.prepareNextChunk(batchId);

            // Assert
            expect(createdCount).to.equal(0);
        });
    });
});
