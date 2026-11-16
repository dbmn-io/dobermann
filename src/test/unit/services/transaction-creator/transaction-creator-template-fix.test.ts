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

describe('TransactionCreator - Template Fix Verification', () => {
    let transactionCreator: TransactionCreator;
    let mockExecutionMetadataService: any;
    let testDir: string;

    beforeEach(() => {
        // Create test directory
        testDir = path.join(__dirname, '..', '..', '..', '..', 'test-output', `template-fix-test-${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });
        
        // Mock services
        mockExecutionMetadataService = {
            createExecution: sinon.stub().resolves('exec_template_test'),
            updateExecution: sinon.stub().resolves()
        };

        // Create TransactionCreator without ExecutionFileService to test fallback
        const mockLogger = createMockLogger();
        transactionCreator = new TransactionCreator(
            mockExecutionMetadataService,
            null, // No ExecutionFileService
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

    describe('CSV Batch Template Fix', () => {
        it('should save the original template with placeholders (not empty objects) to request file', async () => {
            // ARRANGE: Template with placeholders (as it should be from user)
            const templateWithPlaceholders = {
                items: [
                    {
                        id: "{{ITEM_ID}}",
                        sku: "{{SKU}}",
                        description: "{{DESCRIPTION}}",
                        quantity: "{{QUANTITY}}"
                    }
                ],
                requestId: "{{A8:sequence}}",
                timestamp: "{{A8:datetime}}",
                source: "CSV_UPLOAD"
            };

            const mockEndpoint = {
                id: 'batch-with-placeholders',
                name: 'Batch Items Upload',
                method: 'POST' as const,
                path: '/api/items/batch',
                headers: {},
                queryParams: {},
                body: JSON.stringify(templateWithPlaceholders, null, 2), // Original template
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'production',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json',
                batchId: 'batch_template_fix_123'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: File should contain the original template with placeholders
            expect(fs.existsSync(result.requestFilePath)).to.be.true;
            
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            
            // Verify template placeholders are preserved
            expect(parsedContent.items).to.be.an('array');
            expect(parsedContent.items[0]).to.deep.equal({
                id: "{{ITEM_ID}}",
                sku: "{{SKU}}",
                description: "{{DESCRIPTION}}",
                quantity: "{{QUANTITY}}"
            });
            expect(parsedContent.requestId).to.equal("{{A8:sequence}}");
            expect(parsedContent.timestamp).to.equal("{{A8:datetime}}");
            expect(parsedContent.source).to.equal("CSV_UPLOAD");

        });

        it('should save empty object template as-is (current user scenario)', async () => {
            // ARRANGE: Template with empty objects (current user's template)
            const templateWithEmptyObjects = {
                items: [
                    {} // Empty object - no placeholders
                ],
                requestId: "A8:sequence", // Note: No {{ }} brackets
                timestamp: "A8:datetime",
                source: "CSV_UPLOAD"
            };

            const mockEndpoint = {
                id: 'batch-empty-objects',
                name: 'Batch Empty Template',
                method: 'POST' as const,
                path: '/api/items/batch',
                headers: {},
                queryParams: {},
                body: JSON.stringify(templateWithEmptyObjects, null, 2),
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json',
                batchId: 'batch_empty_test_456'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: File should contain the original template as-is
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            
            // Verify empty object is preserved
            expect(parsedContent.items).to.be.an('array');
            expect(parsedContent.items[0]).to.deep.equal({}); // Empty object preserved
            expect(parsedContent.requestId).to.equal("A8:sequence");
            expect(parsedContent.timestamp).to.equal("A8:datetime");

        });

        it('should NOT contain JsonGenerator array-repeated content in request file', async () => {
            // ARRANGE: Simulate what was happening before the fix
            const wrongJsonGeneratorOutput = {
                items: [
                    {}, {}, {}, {}, {} // Multiple empty objects from array repetition
                ],
                requestId: "A8:sequence",
                timestamp: "A8:datetime",
                source: "CSV_UPLOAD"
            };

            const correctTemplate = {
                items: [
                    {} // Single empty object template
                ],
                requestId: "A8:sequence",
                timestamp: "A8:datetime",
                source: "CSV_UPLOAD"
            };

            const mockEndpoint = {
                id: 'verify-not-array-repeated',
                name: 'Verify No Array Repetition',
                method: 'POST' as const,
                path: '/api/verify',
                headers: {},
                queryParams: {},
                body: JSON.stringify(correctTemplate, null, 2), // Should use this
                folder: '',
                tests: []
            };

            const options: TransactionCreationOptions = {
                endpoint: mockEndpoint,
                environment: 'test',
                organization: 'test-org',
                directoryPath: testDir,
                fileName: 'transaction-001.json',
                batchId: 'batch_verify_789'
            };

            // ACT
            const result = await transactionCreator.createTransaction(options);

            // ASSERT: Should NOT have array-repeated content
            const fileContent = fs.readFileSync(result.requestFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent);
            
            // Should have exactly 1 item in array (the template), not multiple
            expect(parsedContent.items).to.have.length(1);
            expect(parsedContent.items).to.not.have.length(5); // Not array-repeated
            
        });
    });
});