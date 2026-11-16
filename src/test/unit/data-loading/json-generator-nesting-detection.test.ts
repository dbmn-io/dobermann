// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for nested array detection and A8 variable processing fixes
 * GitHub Issue #140: Bug fixes for 1-level nesting detection and A8 variables
 *
 * Key fixes tested:
 * 1. analyzeNestedArrays() - detects nested array structure and outer/inner variables
 * 2. A8 variables processing in nested templates (2-level and 3-level)
 * 3. Flat array repetition still works correctly
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator - Nesting Detection Fixes (GitHub Issue #140)', () => {
    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
    });

    describe('Nested Array Structure Detection', () => {
        /**
         * 2-level nesting: orders[].items[]
         * This is the standard nested array structure
         */
        it('should detect 2-level nested array structure', () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    items: [
                        { sku: '{{SKU}}', qty: '{{Qty:number}}' }
                    ]
                }]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(2);
            expect(analysis.outerArray).to.equal('orders');
            expect(analysis.innerArray).to.equal('items');
            // Outer variables should be detected
            expect(analysis.outerVariables).to.include('PO');
            expect(analysis.outerVariables).to.include('Store');
            // Inner variables should be detected
            expect(analysis.innerVariables).to.include('SKU');
            expect(analysis.innerVariables).to.include('Qty');
        });

        it('should detect 3-level nested array structure', () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        items: [
                            { sku: '{{SKU}}' }
                        ]
                    }]
                }]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(3);
            expect(analysis.outerArray).to.equal('shipments');
            expect(analysis.middleArray).to.equal('packages');
            expect(analysis.innerArray).to.equal('items');
        });

        /**
         * Flat array: { "data": [{ "id": "{{id}}" }] }
         * No nested arrays - uses maxRepetitions chunking
         */
        it('should detect flat array template as NOT nested', () => {
            const template = JSON.stringify({
                data: [
                    { id: '{{id}}', name: '{{name}}' }
                ]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            // Flat array should not be detected as nested
            expect(analysis.hasNestedArrays).to.be.false;
            // nestingLevel may or may not be present depending on implementation
        });

        it('should detect bare array template as NOT nested', () => {
            const template = JSON.stringify([
                { item: '{{Item}}', qty: '{{Qty}}' }
            ]);

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.false;
        });

        it('should handle template with no arrays', () => {
            const template = JSON.stringify({
                order: {
                    po: '{{PO}}',
                    item: '{{Item}}'
                }
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.false;
            // Template with no arrays should not be detected as nested
        });
    });

    describe('2-Level Nested Array JSON Generation', () => {
        /**
         * GitHub Issue #119: Generate nested JSON from grouped CSV data
         * Each CSV group becomes one outer array element
         */
        it('should generate nested JSON from grouped CSV data', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    items: [
                        { item: '{{Item}}', qty: '{{Qty}}' }
                    ]
                }]
            });

            // Two groups: PO=123 with 2 items, PO=456 with 1 item
            const csvGroups = [
                [
                    ['PO', 'Store', 'Item', 'Qty'],
                    ['123', '100', 'SKU-A', '5'],
                    ['123', '100', 'SKU-B', '3']
                ],
                [
                    ['PO', 'Store', 'Item', 'Qty'],
                    ['456', '200', 'SKU-C', '10']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'Store', 'Item', 'Qty'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Store', column: 'Store', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(2);

            // First order: PO=123, 2 items
            expect(result.jsonData.orders[0].po).to.equal('123');
            expect(result.jsonData.orders[0].store).to.equal('100');
            expect(result.jsonData.orders[0].items).to.have.length(2);
            expect(result.jsonData.orders[0].items[0].item).to.equal('SKU-A');
            expect(result.jsonData.orders[0].items[1].item).to.equal('SKU-B');

            // Second order: PO=456, 1 item
            expect(result.jsonData.orders[1].po).to.equal('456');
            expect(result.jsonData.orders[1].items).to.have.length(1);
        });

        it('should handle single group with multiple items', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'A'],
                    ['123', 'B'],
                    ['123', 'C']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(1);
            expect(result.jsonData.orders[0].items).to.have.length(3);
        });

        it('should handle empty groups array', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups: string[][][] = [];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(0);
        });
    });

    describe('Flat Array Repetition (Should Still Work)', () => {
        /**
         * Flat array templates (no nested arrays) should use maxRepetitions chunking
         * Template: { "data": [{ "id": "{{id}}" }] }
         */
        it('should process all rows for flat array template', async () => {
            const template = JSON.stringify({
                data: [
                    { id: '{{id}}', name: '{{name}}' }
                ]
            });

            const csvRows = [
                'id1,name1',
                'id2,name2',
                'id3,name3',
                'id4,name4',
                'id5,name5'
            ];

            const options = {
                template,
                headers: ['id', 'name'],
                mappings: [
                    { variable: 'id', column: 'id', dataType: 'string' },
                    { variable: 'name', column: 'name', dataType: 'string' }
                ],
                repeatableArrays: [
                    { arrayPath: 'data', enabled: true, maxRepetitions: 100 } // High limit
                ]
            };

            const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

            expect(result.success).to.be.true;
            // All 5 rows should be in the array
            expect(result.jsonData.data).to.have.length(5);
            expect(result.jsonData.data[0].id).to.equal('id1');
            expect(result.jsonData.data[4].id).to.equal('id5');
        });
    });

    describe('A8 Variable Processing in Nested Templates', () => {
        /**
         * GitHub Issue #140: A8 variables weren't being replaced in nested templates
         * generateNestedArrayJson() and generate3LevelNestedArrayJson() now call processA8VariablesInJson()
         */
        it('should process A8:date in 2-level nested template', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    orderDate: '{{A8:date}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint'
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // A8:date should be replaced with YYYYMMDD format
            expect(result.jsonData.orders[0].orderDate).to.match(/^\d{8}$/);
            expect(result.jsonData.orders[0].orderDate).to.not.equal('{{A8:date}}');
        });

        it('should process A8:datetime in 2-level nested template', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    timestamp: '{{A8:datetime}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint'
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // A8:datetime should be replaced with ISO datetime
            expect(result.jsonData.orders[0].timestamp).to.match(/^\d{4}-\d{2}-\d{2}T/);
            expect(result.jsonData.orders[0].timestamp).to.not.equal('{{A8:datetime}}');
        });

        it('should process A8:datetime:local format in nested template', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    localTime: '{{A8:datetime:local}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint'
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // A8:datetime:local should be ISO without milliseconds and Z
            expect(result.jsonData.orders[0].localTime).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
            expect(result.jsonData.orders[0].localTime).to.not.include('Z');
            expect(result.jsonData.orders[0].localTime).to.not.include('.');
        });

        it('should process A8:SEQUENCE in nested template', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    orderId: 'ORD-{{A8:SEQUENCE}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint',
                sequenceStartValue: 1001
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // A8:SEQUENCE should be replaced with a number
            expect(result.jsonData.orders[0].orderId).to.match(/^ORD-\d+$/);
            expect(result.jsonData.orders[0].orderId).to.not.include('{{A8:SEQUENCE}}');
        });

        it('should process multiple A8 variables in same template', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    orderId: 'ORD-{{A8:date}}-{{A8:SEQUENCE}}',
                    createdAt: '{{A8:datetime:iso}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint',
                sequenceStartValue: 1001
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // All A8 variables should be replaced
            expect(result.jsonData.orders[0].orderId).to.not.include('{{A8:');
            expect(result.jsonData.orders[0].createdAt).to.not.include('{{A8:');
            // Verify orderId has correct format: ORD-YYYYMMDD-SEQUENCE
            expect(result.jsonData.orders[0].orderId).to.match(/^ORD-\d{8}-\d+$/);
        });

        it('should process A8 variables in 3-level nested template', async () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    shipDate: '{{A8:datetime:local}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        items: [
                            { sku: '{{SKU}}' }
                        ]
                    }]
                }]
            });

            const csvData = [
                ['ShipmentID', 'PackageID', 'SKU'],
                ['S1', 'P1', 'SKU-X'],
                ['S1', 'P1', 'SKU-Y']
            ];

            const options = {
                template,
                headers: ['ShipmentID', 'PackageID', 'SKU'],
                mappings: [
                    { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                    { variable: 'PackageID', column: 'PackageID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint'
            };

            const result = await (jsonGenerator as any).generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;
            // A8:datetime:local should be replaced
            expect(result.jsonData.shipments[0].shipDate).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
            expect(result.jsonData.shipments[0].shipDate).to.not.include('{{A8:');
        });

        it('should process A8:datetime with custom format string', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    formattedDate: '{{A8:datetime:YYYY-MM-DD}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['123', 'SKU-001']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                endpointId: 'test-endpoint'
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // Should match YYYY-MM-DD format
            expect(result.jsonData.orders[0].formattedDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
        });
    });

    describe('Edge Cases', () => {
        it('should handle single-row groups correctly', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'SKU'],
                    ['100', 'A']
                ],
                [
                    ['PO', 'SKU'],
                    ['200', 'B']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(2);
            expect(result.jsonData.orders[0].items).to.have.length(1);
            expect(result.jsonData.orders[1].items).to.have.length(1);
        });

        it('should handle groups with different sizes', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ sku: '{{SKU}}' }]
                }]
            });

            const csvGroups = [
                // Group 1: 3 items
                [
                    ['PO', 'SKU'],
                    ['100', 'A'],
                    ['100', 'B'],
                    ['100', 'C']
                ],
                // Group 2: 1 item
                [
                    ['PO', 'SKU'],
                    ['200', 'D']
                ],
                // Group 3: 5 items
                [
                    ['PO', 'SKU'],
                    ['300', 'E'],
                    ['300', 'F'],
                    ['300', 'G'],
                    ['300', 'H'],
                    ['300', 'I']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'SKU'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(3);
            expect(result.jsonData.orders[0].items).to.have.length(3);
            expect(result.jsonData.orders[1].items).to.have.length(1);
            expect(result.jsonData.orders[2].items).to.have.length(5);
            expect(result.metadata.rowsProcessed).to.equal(9);
        });
    });
});
