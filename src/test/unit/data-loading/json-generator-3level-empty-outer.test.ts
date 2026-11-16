// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Test for GitHub Issue #134: JSON Preview not working
 *
 * Root cause: 3-level nested arrays with no outer variables (static wrapper)
 * causes undefined column error in groupRowsByColumn.
 *
 * Template structure:
 * - messages[] - static wrapper with NO variables
 * - Data[] - contains {{PurchaseOrderId}}
 * - PurchaseOrderLine[] - static inner array
 */

import { expect } from 'chai';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator - 3-Level Nesting with Empty Outer Variables (Issue #134)', () => {
    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        // Create JsonGenerator with minimal mock
        const mockEndpointManager = {
            getEndpoint: () => null
        };
        jsonGenerator = new JsonGenerator(mockEndpointManager as any);
    });

    describe('analyzeNestedArrays', () => {
        it('should correctly identify 3-level nesting with middle-level variable', () => {
            const template = `{
                "messages": [
                    {
                        "attributes": {
                            "User": "admin@company.com"
                        },
                        "Data": [
                            {
                                "PurchaseOrderId": "{{PurchaseOrderId}}",
                                "PurchaseOrderLine": [
                                    {
                                        "ItemId": "ITEM001"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }`;

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(3);
            expect(analysis.outerArray).to.equal('messages');
            expect(analysis.middleArray).to.equal('Data');
            expect(analysis.innerArray).to.equal('PurchaseOrderLine');
            expect(analysis.outerVariables).to.deep.equal([]); // Empty - no variables at messages level
            expect(analysis.middleVariables).to.include('PurchaseOrderId'); // Variable at Data level
        });
    });

    describe('generate3LevelNestedArrayJson', () => {
        it('should handle empty outerVariables by using middleVariables for grouping', async () => {
            const template = `{
                "messages": [
                    {
                        "attributes": {
                            "User": "admin@company.com"
                        },
                        "Data": [
                            {
                                "PurchaseOrderId": "{{PurchaseOrderId}}",
                                "PurchaseOrderLine": [
                                    {
                                        "ItemId": "ITEM001"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }`;

            const csvData = [
                ['PurchaseOrderId'],
                ['PO-001'],
                ['PO-002']
            ];

            const options = {
                template,
                mappings: [
                    { variable: 'PurchaseOrderId', column: 'PurchaseOrderId', dataType: 'string' }
                ],
                headers: ['PurchaseOrderId'],
                repeatableArrays: [],
                endpointId: 'test-endpoint'
            };

            // This should NOT throw "Column 'undefined' not found" error
            const result = await jsonGenerator.generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;
            expect(result.error).to.be.undefined;
            expect(result.jsonData).to.exist;
        });

        it('should group rows by middleVariable when outerVariables is empty', async () => {
            const template = `{
                "messages": [
                    {
                        "Data": [
                            {
                                "PurchaseOrderId": "{{PurchaseOrderId}}",
                                "Closed": false,
                                "PurchaseOrderLine": [
                                    {
                                        "LineId": "{{LineId}}",
                                        "ItemId": "{{ItemId}}"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }`;

            const csvData = [
                ['PurchaseOrderId', 'LineId', 'ItemId'],
                ['PO-001', '10', 'ITEM-A'],
                ['PO-001', '20', 'ITEM-B'],
                ['PO-002', '10', 'ITEM-C']
            ];

            const options = {
                template,
                mappings: [
                    { variable: 'PurchaseOrderId', column: 'PurchaseOrderId', dataType: 'string' },
                    { variable: 'LineId', column: 'LineId', dataType: 'string' },
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' }
                ],
                headers: ['PurchaseOrderId', 'LineId', 'ItemId'],
                repeatableArrays: [],
                endpointId: 'test-endpoint'
            };

            const result = await jsonGenerator.generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;

            // Verify structure: should have 2 Data entries (PO-001 and PO-002)
            const json = result.jsonData;
            expect(json.messages).to.be.an('array').with.lengthOf(1);
            expect(json.messages[0].Data).to.be.an('array').with.lengthOf(2);

            // PO-001 should have 2 line items
            const po001 = json.messages[0].Data.find((d: any) => d.PurchaseOrderId === 'PO-001');
            expect(po001).to.exist;
            expect(po001.PurchaseOrderLine).to.be.an('array').with.lengthOf(2);

            // PO-002 should have 1 line item
            const po002 = json.messages[0].Data.find((d: any) => d.PurchaseOrderId === 'PO-002');
            expect(po002).to.exist;
            expect(po002.PurchaseOrderLine).to.be.an('array').with.lengthOf(1);
        });
    });

    describe('generateBatchJsonFiles (Execution Path)', () => {
        it('should handle empty outerVariables in 3-level nesting', async () => {
            const template = `{
                "messages": [
                    {
                        "attributes": {
                            "User": "admin@company.com"
                        },
                        "Data": [
                            {
                                "PurchaseOrderId": "{{PurchaseOrderId}}",
                                "PurchaseOrderLine": [
                                    {
                                        "ItemId": "ITEM001"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }`;

            const csvData = 'PurchaseOrderId\nPO-001\nPO-002';

            const options = {
                template,
                mappings: [
                    { variable: 'PurchaseOrderId', column: 'PurchaseOrderId', dataType: 'string' }
                ],
                headers: ['PurchaseOrderId'],
                repeatableArrays: [],
                endpointId: 'test-endpoint'
            };

            // This should NOT throw "Column 'undefined' not found" error
            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.error).to.be.undefined;
            expect(result.files).to.be.an('array');
            expect(result.files.length).to.be.greaterThan(0);
        });

        it('should group by middleVariable when outerVariables is empty', async () => {
            const template = `{
                "messages": [
                    {
                        "Data": [
                            {
                                "PurchaseOrderId": "{{PurchaseOrderId}}",
                                "PurchaseOrderLine": [
                                    {
                                        "LineId": "{{LineId}}"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }`;

            const csvData = 'PurchaseOrderId,LineId\nPO-001,10\nPO-001,20\nPO-002,10';

            const options = {
                template,
                mappings: [
                    { variable: 'PurchaseOrderId', column: 'PurchaseOrderId', dataType: 'string' },
                    { variable: 'LineId', column: 'LineId', dataType: 'string' }
                ],
                headers: ['PurchaseOrderId', 'LineId'],
                repeatableArrays: [{ arrayPath: 'messages', enabled: true, maxRepetitions: 10 }],
                endpointId: 'test-endpoint'
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.be.an('array');

            // Should have grouped by PurchaseOrderId (middleVariable)
            // With 2 unique POs, should create file(s) with proper grouping
            const firstFile = result.files[0];
            expect(firstFile.content).to.exist;
            expect(firstFile.content.messages).to.be.an('array');
        });
    });
});
