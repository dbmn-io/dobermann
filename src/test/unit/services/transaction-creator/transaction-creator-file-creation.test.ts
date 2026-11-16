// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { TransactionCreator } from '../../../../services/transaction-creator/transaction-creator.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';
import { TransactionCreationOptions } from '../../../../services/transaction-creator/transaction-creator.interface';

describe('TransactionCreator - File Creation (TDD RED Phase)', () => {
    let transactionCreator: TransactionCreator;
    let mockExecutionMetadataService: any;
    let mockExecutionFileService: any;
    let testDir: string;

    beforeEach(() => {
        // Create test directory
        testDir = path.join(__dirname, '..', '..', '..', '..', 'test-output', `transaction-test-${Date.now()}`);
        
        // Mock services
        mockExecutionMetadataService = {
            createExecution: sinon.stub().resolves('exec_test_123'),
            updateExecution: sinon.stub().resolves()
        };

        mockExecutionFileService = {
            generateFileName: sinon.stub().resolves('test-endpoint-2024-01-01T12-00-00_abc-request.json'),
            createFileAtPath: sinon.stub().resolves('/path/to/created/file.json')
        };

        const mockLogger = createMockLogger();
        transactionCreator = new TransactionCreator(
            mockExecutionMetadataService,
            mockExecutionFileService,
            mockLogger
        );
    });

    afterEach(() => {
        // Clean up test directory
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        sinon.restore();
    });

    describe('File Creation with ExecutionFileService', () => {
        it('should create request file using ExecutionFileService when available', async () => {
            // ARRANGE
            const mockEndpoint = {
                id: 'test-endpoint-123',
                name: 'Test Endpoint',
                method: 'POST' as const,
                path: '/api/test',
                headers: {},
                queryParams: {},
                body: '{"testField": "testValue", "timestamp": "2024-01-01"}',
                folder: 'test-folder',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test-env',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json',
                batchId: 'batch_test_456'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Check that ExecutionFileService was used
            expect(mockExecutionFileService.createFileAtPath.calledOnce).to.be.true;
            
            // Verify the JSON payload was correctly parsed
            expect(result.jsonPayload).to.deep.equal({
                testField: "testValue",
                timestamp: "2024-01-01"
            });

            // Verify execution metadata creation
            expect(mockExecutionMetadataService.createExecution.calledOnce).to.be.true;
            expect(mockExecutionMetadataService.updateExecution.calledOnce).to.be.true;

            // Verify execution ID returned
            expect(result.executionId).to.equal('exec_test_123');
            expect(result.requestFilePath).to.equal('/path/to/created/file.json');
        });

        it('should call ExecutionFileService.createFileAtPath with correct parameters', async () => {
            // ARRANGE
            const mockEndpoint = {
                id: 'detailed-test',
                name: 'Detailed Test Endpoint',
                method: 'PUT' as const,
                path: '/api/detailed',
                headers: {},
                queryParams: {},
                body: '{"complexObject": {"nested": "value"}, "array": [1, 2, 3]}',
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'production',
                organization: 'acme-corp',
                directoryPath: '/custom/batch/folder',
                fileName: 'transaction-002.json',
                batchId: 'batch_production_789'
            };

            // ACT
            await transactionCreator.createTransaction(options);

            // ASSERT: Verify ExecutionFileService was called with expected parameters
            expect(mockExecutionFileService.createFileAtPath.calledOnce).to.be.true;
            
            const createFileCall = mockExecutionFileService.createFileAtPath.getCall(0);
            expect(createFileCall.args[0]).to.be.a('string'); // JSON string
            expect(createFileCall.args[1]).to.equal('test-endpoint-2024-01-01T12-00-00_abc-request.json'); // filename
            expect(createFileCall.args[2]).to.equal('/custom/batch/folder'); // filepath

            // Verify the JSON content
            const jsonContent = JSON.parse(createFileCall.args[0]);
            expect(jsonContent).to.deep.equal({
                complexObject: { nested: "value" },
                array: [1, 2, 3]
            });
        });
    });

    describe('Fallback File Creation without ExecutionFileService', () => {
        beforeEach(() => {
            // Remove ExecutionFileService to test fallback
            const mockLogger2 = createMockLogger();
            transactionCreator = new TransactionCreator(
                mockExecutionMetadataService,
                null, // No ExecutionFileService
                mockLogger2
            );
        });

        it('should create request file using fallback fs.writeFileSync when ExecutionFileService unavailable', async () => {
            // ARRANGE
            const mockEndpoint = {
                id: 'fallback-test',
                name: 'Fallback Test',
                method: 'POST' as const,
                path: '/api/fallback',
                headers: {},
                queryParams: {},
                body: '{"fallbackData": "test"}',
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json',
                batchId: 'batch_fallback_123'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Check that file was created using fallback method
            expect(result.requestFilePath).to.exist;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;

            // Verify file content
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            expect(parsedContent).to.deep.equal({ fallbackData: "test" });

            // Verify directory was created
            expect(fs.existsSync(testDir)).to.be.true;

            // Verify filename pattern (more flexible regex for actual implementation)
            const filename = path.basename(result.requestFilePath);
            expect(filename).to.include('fallback-test-request');
            expect(filename).to.include('exec_test_123'); // Full execution ID now used
            expect(filename).to.include('.json');
        });

        it('should handle GET requests with empty body correctly', async () => {
            // ARRANGE
            const mockEndpoint = {
                id: 'get-endpoint',
                name: 'GET Test',
                method: 'GET' as const,
                path: '/api/get-data',
                headers: {},
                queryParams: {},
                body: '', // Empty body for GET request
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-003.json'
                // No batchId for individual execution
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Should create file with empty object for GET request
            expect(result.jsonPayload).to.deep.equal({});
            
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            expect(parsedContent).to.deep.equal({});

            // Verify no batchId in execution creation
            const createExecutionCall = mockExecutionMetadataService.createExecution.getCall(0);
            expect(createExecutionCall.args[1].batchId).to.be.undefined;
        });

        it('should handle directory creation when filePath does not exist', async () => {
            // ARRANGE
            const nonExistentDir = path.join(testDir, 'nested', 'deep', 'directory');
            
            const mockEndpoint = {
                id: 'dir-test',
                name: 'Directory Test',
                method: 'POST' as const,
                path: '/api/dir-test',
                headers: {},
                queryParams: {},
                body: '{"dirTest": true}',
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: nonExistentDir,
                fileName: 'transaction-004.json',
                batchId: 'batch_dir_test'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Directory should be created recursively
            expect(fs.existsSync(nonExistentDir)).to.be.true;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;
            
            // Verify file is in the correct nested directory
            expect(result.requestFilePath.startsWith(nonExistentDir)).to.be.true;
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid JSON in endpoint body gracefully', async () => {
            // ARRANGE
            const mockEndpoint = {
                id: 'invalid-json',
                name: 'Invalid JSON Test',
                method: 'POST' as const,
                path: '/api/invalid',
                headers: {},
                queryParams: {},
                body: '{invalid json}', // Invalid JSON
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-003.json'
            };

            // ACT & ASSERT: Should throw error for invalid JSON
            try {
                await transactionCreator.createTransaction(options);
                expect.fail('Should have thrown error for invalid JSON');
            } catch (error: any) {
                expect(error).to.be.an.instanceOf(Error);
                expect((error as Error).message).to.include('JSON');
            }
        });
    });
});