// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Test for GitHub Issue #136: BASE64 Encoding Not Applied to Run API
 *
 * Root cause: IndividualTransactionHandler was missing the encodeBase64Fields
 * logic that BatchMemberTransactionHandler had.
 *
 * This test verifies that BASE64 encoding is correctly applied for individual
 * (Run API) transactions when the template contains :BASE64 markers.
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import { IndividualTransactionHandler } from '../../../../services/transaction-preparation/handlers/individual-transaction.handler';
import { TransactionHandlerContext } from '../../../../services/transaction-preparation/handlers/transaction-handler.interface';

describe('IndividualTransactionHandler - BASE64 Encoding (Issue #136)', () => {
    let handler: IndividualTransactionHandler;
    let mockTransactionCreator: any;
    let mockPathGenerator: any;
    let mockJsonGenerator: any;

    // Helper to create valid endpoint structure
    function createEndpoint(body: string): any {
        return {
            id: 'test-endpoint',
            name: 'Test Endpoint',
            path: '/api/test',
            method: 'POST' as const,
            headers: {},
            queryParams: {},
            body: body,
            dataLoadingConfig: {
                enabled: false,
                repeatableArrays: []
            }
        };
    }

    // Helper to create valid context
    function createContext(endpoint: any): TransactionHandlerContext {
        return {
            endpoint,
            environment: 'TEST',
            organization: 'test-org',
            workspaceRoot: '/workspace'
        };
    }

    beforeEach(() => {
        // Mock TransactionCreator
        mockTransactionCreator = {
            createTransaction: sinon.stub().resolves({
                executionId: 'test-exec-123',
                requestFilePath: '/path/to/request.json'
            })
        };

        // Mock PathGenerator
        mockPathGenerator = {
            generateDirectoryPath: sinon.stub().returns('/workspace/env/endpoint'),
            generateFileName: sinon.stub().returns('transaction-123.json')
        };

        // Mock JsonGenerator
        mockJsonGenerator = {
            generateSingleRowJson: sinon.stub()
        };

        handler = new IndividualTransactionHandler(
            mockTransactionCreator,
            mockPathGenerator,
            mockJsonGenerator
        );
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('BASE64 Encoding Application', () => {
        it('should apply BASE64 encoding when template has :BASE64 marker', async () => {
            // This is the Pub/Sub template structure from Issue #136
            const jsonPayload = {
                messages: [
                    {
                        attributes: {
                            User: "admin@company.com"
                        },
                        "Data:BASE64": [
                            {
                                PurchaseOrderId: "PO-001",
                                PurchaseOrderLine: [
                                    { ItemId: "ITEM001" }
                                ]
                            }
                        ]
                    }
                ]
            };

            mockJsonGenerator.generateSingleRowJson.resolves({
                success: true,
                jsonData: jsonPayload
            });

            const endpoint = createEndpoint(JSON.stringify(jsonPayload));
            const context = createContext(endpoint);

            await handler.createTransaction(context);

            // Verify createTransaction was called with encoded body
            expect(mockTransactionCreator.createTransaction.calledOnce).to.be.true;

            const callArgs = mockTransactionCreator.createTransaction.firstCall.args[0];

            // Should have encodedBody parameter (Issue #136 fix)
            expect(callArgs.encodedBody).to.exist;
            expect(callArgs.encodedBody).to.be.a('string');

            // The endpoint body should be the encoded version
            expect(callArgs.endpoint.body).to.equal(callArgs.encodedBody);

            // Verify the :BASE64 marker was processed (key renamed to Data)
            expect(callArgs.encodedBody).to.include('"Data"');
            expect(callArgs.encodedBody).not.to.include('Data:BASE64');

            // Verify BASE64 encoding was applied (look for base64 pattern)
            const parsed = JSON.parse(callArgs.encodedBody);
            expect(parsed.messages[0].Data).to.be.a('string');
            // BASE64 encoded content should be a string, not an array
        });

        it('should NOT apply encoding when no :BASE64 markers present', async () => {
            const jsonPayload = {
                items: [
                    { id: "ITEM001", name: "Test Item" }
                ]
            };

            mockJsonGenerator.generateSingleRowJson.resolves({
                success: true,
                jsonData: jsonPayload
            });

            const endpoint = createEndpoint(JSON.stringify(jsonPayload));
            const context = createContext(endpoint);

            await handler.createTransaction(context);

            const callArgs = mockTransactionCreator.createTransaction.firstCall.args[0];

            // encodedBody should be undefined when no markers
            expect(callArgs.encodedBody).to.be.undefined;

            // Body should be plain JSON
            const parsed = JSON.parse(callArgs.endpoint.body);
            expect(parsed.items).to.be.an('array');
            expect(parsed.items[0].id).to.equal('ITEM001');
        });

        it('should handle nested :BASE64 markers correctly', async () => {
            const jsonPayload = {
                wrapper: {
                    "payload:BASE64": {
                        innerData: "test value",
                        nested: { key: "value" }
                    }
                }
            };

            mockJsonGenerator.generateSingleRowJson.resolves({
                success: true,
                jsonData: jsonPayload
            });

            const endpoint = createEndpoint(JSON.stringify(jsonPayload));
            const context = createContext(endpoint);

            await handler.createTransaction(context);

            const callArgs = mockTransactionCreator.createTransaction.firstCall.args[0];

            expect(callArgs.encodedBody).to.exist;
            expect(callArgs.encodedBody).to.include('"payload"');
            expect(callArgs.encodedBody).not.to.include('payload:BASE64');
        });
    });

    describe('Error Handling', () => {
        it('should handle JsonGenerator failure gracefully', async () => {
            mockJsonGenerator.generateSingleRowJson.resolves({
                success: false,
                error: 'Generation failed'
            });

            const endpoint = createEndpoint('{"simple": "json"}');
            const context = createContext(endpoint);

            // Should throw or handle error appropriately
            try {
                await handler.createTransaction(context);
                // If it doesn't throw, verify fallback was used
                expect(mockTransactionCreator.createTransaction.calledOnce).to.be.true;
            } catch (error: any) {
                expect(error.message).to.include('JSON generation failed');
            }
        });

        it('should handle empty body gracefully', async () => {
            mockJsonGenerator.generateSingleRowJson.resolves({
                success: true,
                jsonData: {}
            });

            const endpoint = createEndpoint('');
            const context = createContext(endpoint);

            await handler.createTransaction(context);

            const callArgs = mockTransactionCreator.createTransaction.firstCall.args[0];
            expect(callArgs.endpoint.body).to.equal('{}');
            expect(callArgs.encodedBody).to.be.undefined;
        });
    });
});
