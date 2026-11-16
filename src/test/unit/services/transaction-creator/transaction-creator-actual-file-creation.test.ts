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

describe('TransactionCreator - Actual File Creation Verification', () => {
    let transactionCreator: TransactionCreator;
    let mockExecutionMetadataService: any;
    let testDir: string;

    beforeEach(() => {
        // Create test directory
        testDir = path.join(__dirname, '..', '..', '..', '..', 'test-output', `transaction-file-test-${Date.now()}`);
        
        // Mock services
        mockExecutionMetadataService = {
            createExecution: sinon.stub().resolves('exec_file_test_123'),
            updateExecution: sinon.stub().resolves()
        };

        // Create TransactionCreator without ExecutionFileService to test fallback file creation
        const mockLogger = createMockLogger();
        transactionCreator = new TransactionCreator(
            mockExecutionMetadataService,
            null, // No ExecutionFileService - use fallback file creation
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

    describe('File Creation at Specified Path', () => {
        it('should create actual request file at the specified filePath for batch execution', async () => {
            // ARRANGE
            const csvInputPath = path.join(testDir, 'input.csv');
            
            // Ensure parent directory exists
            fs.mkdirSync(testDir, { recursive: true });
            
            // Create a mock CSV file to simulate batch processing
            fs.writeFileSync(csvInputPath, 'name,age\\nJohn,25\\nJane,30');

            const mockEndpoint = {
                id: 'batch-endpoint',
                name: 'Batch Test Endpoint',
                method: 'POST' as const,
                path: '/api/batch',
                headers: {},
                queryParams: {},
                body: '{"users": [{"name": "{{name}}", "age": "{{age}}"}]}', // Batch JSON template
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json', // Files should be created in this directory
                batchId: 'batch_file_test_456'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Verify file was actually created
            expect(result.requestFilePath).to.exist;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;
            
            // Verify file is in the correct directory
            expect(result.requestFilePath.startsWith(testDir)).to.be.true;
            
            // Verify file content
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            expect(parsedContent).to.deep.equal({
                users: [{ name: "{{name}}", age: "{{age}}" }]
            });

            // Verify filename pattern
            const filename = path.basename(result.requestFilePath);
            expect(filename).to.include('batch-test-endpoint-request');
            expect(filename).to.include('exec_file_test_123'); // Full execution ID now used
            expect(filename).to.include('.json');

            console.log(`✅ Created request file: ${result.requestFilePath}`);
        });

        it('should create request file in same directory as CSV for batch processing workflow', async () => {
            // ARRANGE: Simulate the actual batch processing scenario
            const batchDir = path.join(testDir, 'batch-processing');
            const csvFile = path.join(batchDir, 'orders.csv');
            
            // Create batch directory and CSV file
            fs.mkdirSync(batchDir, { recursive: true });
            fs.writeFileSync(csvFile, 'item,qty\\nLaptop,5\\nMouse,10');

            const mockEndpoint = {
                id: 'order-endpoint',
                name: 'Order Processing',
                method: 'POST' as const,
                path: '/api/orders',
                headers: {},
                queryParams: {},
                body: '{"order": {"item": "{{item}}", "quantity": "{{qty}}"}}',
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'production',
                organization: 'acme-corp',
                directoryPath: batchDir,
                fileName: 'transaction-002.json', // Same directory as CSV file
                batchId: 'batch_orders_789'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Request file should be created in same directory as CSV
            expect(result.requestFilePath).to.exist;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;
            expect(path.dirname(result.requestFilePath)).to.equal(batchDir);

            // Verify both CSV and request file exist in the same directory
            expect(fs.existsSync(csvFile)).to.be.true;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;

            // List all files in the directory
            const filesInDir = fs.readdirSync(batchDir);
            console.log(`📁 Files in batch directory: ${filesInDir.join(', ')}`);
            
            expect(filesInDir).to.include('orders.csv');
            expect(filesInDir.some(f => f.includes('order-processing-request') && f.endsWith('.json'))).to.be.true;
        });

        it('should handle nested directory creation when filePath does not exist', async () => {
            // ARRANGE: Deep nested path that doesn't exist
            const deepPath = path.join(testDir, 'level1', 'level2', 'level3', 'batch-files');
            
            const mockEndpoint = {
                id: 'deep-endpoint',
                name: 'Deep Directory Test',
                method: 'POST' as const,
                path: '/api/deep',
                headers: {},
                queryParams: {},
                body: '{"test": "deep directory creation"}',
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: deepPath,
                fileName: 'transaction-003.json', // Deep nested path
                batchId: 'batch_deep_test'
            };

            // Verify path doesn't exist initially
            expect(fs.existsSync(deepPath)).to.be.false;

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Directory should be created recursively
            expect(fs.existsSync(deepPath)).to.be.true;
            expect(fs.existsSync(result.requestFilePath)).to.be.true;
            expect(result.requestFilePath.startsWith(deepPath)).to.be.true;

            // Verify file content
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            expect(parsedContent).to.deep.equal({ test: "deep directory creation" });
        });

        it('should create multiple request files for multiple transaction calls without conflict', async () => {
            // ARRANGE: Multiple transaction creation calls
            const batchDir = path.join(testDir, 'multi-transaction');
            fs.mkdirSync(batchDir, { recursive: true });

            const mockEndpoint = {
                id: 'multi-endpoint',
                name: 'Multi Transaction Test',
                method: 'POST' as const,
                path: '/api/multi',
                headers: {},
                queryParams: {},
                body: '{"data": "transaction"}',
                folder: '',
                tests: []
            };

            // Reset mock to allow multiple calls
            mockExecutionMetadataService.createExecution.reset();
            mockExecutionMetadataService.createExecution.onCall(0).resolves('exec_multi_1');
            mockExecutionMetadataService.createExecution.onCall(1).resolves('exec_multi_2');
            mockExecutionMetadataService.createExecution.onCall(2).resolves('exec_multi_3');

            // Create multiple transactions
            const transactions = [];
            for (let i = 1; i <= 3; i++) {
                const options: TransactionCreationOptions = {
                    endpoint: { ...mockEndpoint, body: `{"data": "transaction${i}"}` },
                    environment: 'test',
                    organization: 'test-org',
                    directoryPath: batchDir,
                fileName: 'transaction-002.json',
                    batchId: `batch_multi_${i}`
                };

                transactions.push(options);
            }

            // ACT: Create all transactions
            const results = await Promise.all(
                transactions.map(options => transactionCreator.createTransaction(options))
            );

            // ASSERT: All files should be created without conflict
            expect(results).to.have.length(3);
            
            results.forEach((result, index) => {
                expect(fs.existsSync(result.requestFilePath)).to.be.true;
                
                const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
                const parsedContent = JSON.parse(fileContent);
                // The content should match what was set for each transaction
                expect(parsedContent.data).to.include('transaction');
            });

            // Verify all files have unique names
            const filePaths = results.map(r => r.requestFilePath);
            const uniquePaths = [...new Set(filePaths)];
            expect(uniquePaths).to.have.length(3);

            // List files created
            const filesInDir = fs.readdirSync(batchDir);
            console.log(`📁 Created ${filesInDir.length} request files: ${filesInDir.join(', ')}`);
        });
    });
});