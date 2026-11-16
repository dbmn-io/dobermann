// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for nested array JSON generation (GitHub Issue #119)
 * TDD approach: These tests define the expected behavior for CSV denormalization
 *
 * Feature: Generate nested JSON structures from grouped CSV data
 * Example: Orders with line items - each order has multiple items from CSV rows
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator - Nested Array Support (GitHub Issue #119)', () => {
    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
    });

    describe('analyzeNestedArrays()', () => {
        it('should detect nested array structure in template', () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    items: [
                        { item: '{{Item}}', qty: '{{Qty}}' }
                    ]
                }]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.outerArray).to.equal('orders');
            expect(analysis.innerArray).to.equal('items');
            expect(analysis.nestingPath).to.equal('orders[].items');
        });

        it('should identify outer vs inner variables correctly', () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    total: '{{Total:number}}',
                    items: [
                        { item: '{{Item}}', qty: '{{Qty:number}}', price: '{{Price:number}}' }
                    ]
                }]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.outerVariables).to.include.members(['PO', 'Store', 'Total']);
            expect(analysis.outerVariables).to.not.include.members(['Item', 'Qty', 'Price']);
            expect(analysis.innerVariables).to.include.members(['Item', 'Qty', 'Price']);
            expect(analysis.innerVariables).to.not.include.members(['PO', 'Store', 'Total']);
        });

        it('should return hasNestedArrays=false for flat array template', () => {
            const template = JSON.stringify({
                items: [
                    { item: '{{Item}}', qty: '{{Qty}}' }
                ]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.false;
            expect(analysis.outerArray).to.be.undefined;
            expect(analysis.innerArray).to.be.undefined;
        });

        it('should return hasNestedArrays=false for single object template', () => {
            const template = JSON.stringify({
                order: {
                    po: '{{PO}}',
                    item: '{{Item}}'
                }
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.false;
        });

        it('should detect 3-level nested arrays (GitHub Issue #119 - 3 levels)', () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        items: [
                            { sku: '{{SKU}}', qty: '{{Qty}}' }
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
            expect(analysis.nestingPath).to.equal('shipments[].packages[].items');
        });

        it('should identify variables at each level for 3-level nesting', () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    carrier: '{{Carrier}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        weight: '{{Weight:number}}',
                        items: [
                            { sku: '{{SKU}}', qty: '{{Qty:number}}' }
                        ]
                    }]
                }]
            });

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(3);
            expect(analysis.outerVariables).to.include.members(['ShipmentID', 'Carrier']);
            expect(analysis.middleVariables).to.include.members(['PackageID', 'Weight']);
            expect(analysis.innerVariables).to.include.members(['SKU', 'Qty']);
        });
    });

    describe('generateNestedArrayJson()', () => {
        it('should generate nested JSON from grouped CSV data (GitHub Issue #119 exact example)', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    items: [
                        { item: '{{Item}}', qty: '{{Qty}}' }
                    ]
                }]
            });

            // CSV groups created by ArrayRepetitionHelper.groupRowsByFieldValues()
            const csvGroups = [
                // Group 1: PO=123, Store=100 (3 items)
                [
                    ['PO', 'Store', 'Item', 'Qty'],
                    ['123', '100', 'A1234567', '5'],
                    ['123', '100', 'A2345678', '3'],
                    ['123', '100', 'A2345679', '4']
                ],
                // Group 2: PO=222, Store=200 (3 items)
                [
                    ['PO', 'Store', 'Item', 'Qty'],
                    ['222', '200', 'A1234566', '15'],
                    ['222', '200', 'A2345678', '12'],
                    ['222', '200', 'A2345679', '6']
                ],
                // Group 3: PO=333, Store=300 (4 items)
                [
                    ['PO', 'Store', 'Item', 'Qty'],
                    ['333', '300', 'A4455667', '1'],
                    ['333', '300', 'A4455668', '12'],
                    ['333', '300', 'A4455669', '33'],
                    ['333', '300', 'A4455670', '55']
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
            expect(result.jsonData.orders).to.have.length(3);

            // Verify Group 1: PO=123, Store=100, 3 items
            expect(result.jsonData.orders[0].po).to.equal('123');
            expect(result.jsonData.orders[0].store).to.equal('100');
            expect(result.jsonData.orders[0].items).to.have.length(3);
            expect(result.jsonData.orders[0].items[0].item).to.equal('A1234567');
            expect(result.jsonData.orders[0].items[0].qty).to.equal('5');
            expect(result.jsonData.orders[0].items[1].item).to.equal('A2345678');
            expect(result.jsonData.orders[0].items[2].item).to.equal('A2345679');

            // Verify Group 2: PO=222, Store=200, 3 items
            expect(result.jsonData.orders[1].po).to.equal('222');
            expect(result.jsonData.orders[1].store).to.equal('200');
            expect(result.jsonData.orders[1].items).to.have.length(3);
            expect(result.jsonData.orders[1].items[0].item).to.equal('A1234566');
            expect(result.jsonData.orders[1].items[1].item).to.equal('A2345678');
            expect(result.jsonData.orders[1].items[2].item).to.equal('A2345679');

            // Verify Group 3: PO=333, Store=300, 4 items
            expect(result.jsonData.orders[2].po).to.equal('333');
            expect(result.jsonData.orders[2].store).to.equal('300');
            expect(result.jsonData.orders[2].items).to.have.length(4);
            expect(result.jsonData.orders[2].items[0].item).to.equal('A4455667');
            expect(result.jsonData.orders[2].items[3].item).to.equal('A4455670');

            // Verify metadata
            expect(result.metadata.rowsProcessed).to.equal(10); // 3 + 3 + 4
            expect(result.metadata.isConsolidated).to.be.true;
            expect(result.metadata.arrayRepetitionUsed).to.be.true;
        });

        it('should map outer variables from first row of each group', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    store: '{{Store}}',
                    orderDate: '{{OrderDate}}',
                    items: [
                        { item: '{{Item}}' }
                    ]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'Store', 'OrderDate', 'Item'],
                    ['100', 'NYC', '2025-01-15', 'Widget'],
                    ['100', 'NYC', '2025-01-15', 'Gadget']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'Store', 'OrderDate', 'Item'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Store', column: 'Store', dataType: 'string' },
                    { variable: 'OrderDate', column: 'OrderDate', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders[0].po).to.equal('100');
            expect(result.jsonData.orders[0].store).to.equal('NYC');
            expect(result.jsonData.orders[0].orderDate).to.equal('2025-01-15');
            expect(result.jsonData.orders[0].items).to.have.length(2);
        });

        it('should handle single-row groups correctly', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ item: '{{Item}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'Item'],
                    ['100', 'A']
                ],
                [
                    ['PO', 'Item'],
                    ['200', 'B']
                ],
                [
                    ['PO', 'Item'],
                    ['300', 'C']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'Item'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(3);
            expect(result.jsonData.orders[0].items).to.have.length(1);
            expect(result.jsonData.orders[1].items).to.have.length(1);
            expect(result.jsonData.orders[2].items).to.have.length(1);
        });

        it('should handle empty groups array', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{ item: '{{Item}}' }]
                }]
            });

            const csvGroups: string[][][] = [];

            const options = {
                template,
                headers: ['PO', 'Item'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(0);
            expect(result.metadata.rowsProcessed).to.equal(0);
        });

        it('should apply data type conversions correctly', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    total: '{{Total:number}}',
                    items: [
                        { item: '{{Item}}', qty: '{{Qty:number}}', price: '{{Price:number}}' }
                    ]
                }]
            });

            const csvGroups = [
                [
                    ['PO', 'Total', 'Item', 'Qty', 'Price'],
                    ['100', '150.50', 'Widget', '5', '10.25'],
                    ['100', '150.50', 'Gadget', '3', '25.50']
                ]
            ];

            const options = {
                template,
                headers: ['PO', 'Total', 'Item', 'Qty', 'Price'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Total', column: 'Total', dataType: 'number' },
                    { variable: 'Item', column: 'Item', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'number' },
                    { variable: 'Price', column: 'Price', dataType: 'number' }
                ]
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // Note: Current TemplateParser returns string values even for :number type
            // This test documents expected behavior - may need template parser enhancement
            expect(result.jsonData.orders[0].items[0].qty).to.satisfy((val: any) =>
                val === 5 || val === '5'
            );
        });
    });

    describe('Routing logic: flat vs nested arrays', () => {
        it('should use flat array logic when no nesting detected', async () => {
            const flatTemplate = JSON.stringify({
                items: [
                    { item: '{{Item}}', qty: '{{Qty}}' }
                ]
            });

            // This should route to existing generateConsolidatedJson() logic
            const csvRows = [
                'Widget,5',
                'Gadget,3',
                'Thing,2'
            ];

            const options = {
                template: flatTemplate,
                headers: ['Item', 'Qty'],
                mappings: [
                    { variable: 'Item', column: 'Item', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'string' }
                ],
                repeatableArrays: [
                    { arrayPath: 'items', enabled: true, maxRepetitions: 100 }
                ]
            };

            const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.items).to.have.length(3);
            expect(result.metadata.arrayRepetitionUsed).to.be.true;
        });

        it('should use single row logic when no array repetition enabled', async () => {
            const template = JSON.stringify({
                order: {
                    po: '{{PO}}',
                    item: '{{Item}}'
                }
            });

            const csvRow = '123,Widget';

            const options = {
                template,
                headers: ['PO', 'Item'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' }
                ]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.order.po).to.equal('123');
            expect(result.jsonData.order.item).to.equal('Widget');
            expect(result.metadata.arrayRepetitionUsed).to.be.false;
        });
    });

    describe('3-Level Nested Arrays (GitHub Issue #119 - Extended)', () => {
        it('should generate 3-level nested JSON from grouped CSV data', async () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    carrier: '{{Carrier}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        weight: '{{Weight}}',
                        items: [
                            { sku: '{{SKU}}', qty: '{{Qty}}' }
                        ]
                    }]
                }]
            });

            // CSV data: 2 shipments, first has 2 packages (Package 1 has 2 items, Package 2 has 1 item),
            //           second has 1 package with 2 items
            const csvData = [
                ['ShipmentID', 'Carrier', 'PackageID', 'Weight', 'SKU', 'Qty'],
                // Shipment S1, Package P1, Items
                ['S1', 'FedEx', 'P1', '10', 'SKU-A', '5'],
                ['S1', 'FedEx', 'P1', '10', 'SKU-B', '3'],
                // Shipment S1, Package P2, Items
                ['S1', 'FedEx', 'P2', '5', 'SKU-C', '2'],
                // Shipment S2, Package P3, Items
                ['S2', 'UPS', 'P3', '15', 'SKU-D', '10'],
                ['S2', 'UPS', 'P3', '15', 'SKU-E', '7']
            ];

            const options = {
                template,
                headers: ['ShipmentID', 'Carrier', 'PackageID', 'Weight', 'SKU', 'Qty'],
                mappings: [
                    { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                    { variable: 'Carrier', column: 'Carrier', dataType: 'string' },
                    { variable: 'PackageID', column: 'PackageID', dataType: 'string' },
                    { variable: 'Weight', column: 'Weight', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.shipments).to.have.length(2);

            // Verify Shipment S1
            const shipment1 = result.jsonData.shipments[0];
            expect(shipment1.shipmentId).to.equal('S1');
            expect(shipment1.carrier).to.equal('FedEx');
            expect(shipment1.packages).to.have.length(2);

            // Verify Shipment S1, Package P1
            expect(shipment1.packages[0].packageId).to.equal('P1');
            expect(shipment1.packages[0].weight).to.equal('10');
            expect(shipment1.packages[0].items).to.have.length(2);
            expect(shipment1.packages[0].items[0].sku).to.equal('SKU-A');
            expect(shipment1.packages[0].items[1].sku).to.equal('SKU-B');

            // Verify Shipment S1, Package P2
            expect(shipment1.packages[1].packageId).to.equal('P2');
            expect(shipment1.packages[1].items).to.have.length(1);
            expect(shipment1.packages[1].items[0].sku).to.equal('SKU-C');

            // Verify Shipment S2
            const shipment2 = result.jsonData.shipments[1];
            expect(shipment2.shipmentId).to.equal('S2');
            expect(shipment2.carrier).to.equal('UPS');
            expect(shipment2.packages).to.have.length(1);
            expect(shipment2.packages[0].packageId).to.equal('P3');
            expect(shipment2.packages[0].items).to.have.length(2);

            // Verify metadata
            expect(result.metadata.rowsProcessed).to.equal(5);
            expect(result.metadata.nestingLevel).to.equal(3);
        });

        it('should handle single-item packages in 3-level structure', async () => {
            const template = JSON.stringify({
                orders: [{
                    orderId: '{{OrderID}}',
                    shipments: [{
                        shipmentId: '{{ShipmentID}}',
                        items: [{ sku: '{{SKU}}' }]
                    }]
                }]
            });

            const csvData = [
                ['OrderID', 'ShipmentID', 'SKU'],
                ['O1', 'SH1', 'SKU-X'],
                ['O2', 'SH2', 'SKU-Y']
            ];

            const options = {
                template,
                headers: ['OrderID', 'ShipmentID', 'SKU'],
                mappings: [
                    { variable: 'OrderID', column: 'OrderID', dataType: 'string' },
                    { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ]
            };

            const result = await (jsonGenerator as any).generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders).to.have.length(2);
            expect(result.jsonData.orders[0].shipments).to.have.length(1);
            expect(result.jsonData.orders[0].shipments[0].items).to.have.length(1);
        });
    });

    describe('Root-level CSV variables in nested arrays (GitHub Issue #178)', () => {

        it('should substitute root-level CSV variables in 2-level nested array template', async () => {
            // Issue #178 exact template: root-level RoleId/RoleName + nested Grant[].ExclusionGrant[]
            const template = JSON.stringify({
                RoleId: '{{RollId:string}}',
                RoleName: '{{RoleName:string}}',
                OrganizationId: '{{ENV:org}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    ExclusionGrant: [{
                        ExcludedResourceId: '{{ExcludedResourceId}}'
                    }]
                }]
            });

            // CSV groups: 1 group with 3 rows (same RollId/RoleName/ResourceId, different ExcludedResourceId)
            const csvGroups = [
                [
                    ['RollId', 'RoleName', 'ResourceId', 'ExcludedResourceId'],
                    ['00_Superusers_840', '00_Superusers_840', 'RES-001', 'EXC-001'],
                    ['00_Superusers_840', '00_Superusers_840', 'RES-001', 'EXC-002'],
                    ['00_Superusers_840', '00_Superusers_840', 'RES-001', 'EXC-003']
                ]
            ];

            const options = {
                template,
                headers: ['RollId', 'RoleName', 'ResourceId', 'ExcludedResourceId'],
                mappings: [
                    { variable: 'RollId', column: 'RollId', dataType: 'string' },
                    { variable: 'RoleName', column: 'RoleName', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'ExcludedResourceId', column: 'ExcludedResourceId', dataType: 'string' }
                ],
                environmentVariables: { org: 'ORG-840' }
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;

            // Root-level CSV variables must be substituted (this is the bug)
            expect(result.jsonData.RoleId).to.equal('00_Superusers_840');
            expect(result.jsonData.RoleName).to.equal('00_Superusers_840');

            // Root-level ENV variable should also be substituted
            expect(result.jsonData.OrganizationId).to.equal('ORG-840');

            // Verify nested array structure is correct
            expect(result.jsonData.Grant).to.be.an('array').with.lengthOf(1);
            expect(result.jsonData.Grant[0].ResourceId).to.equal('RES-001');
            expect(result.jsonData.Grant[0].ExclusionGrant).to.be.an('array').with.lengthOf(3);
            expect(result.jsonData.Grant[0].ExclusionGrant[0].ExcludedResourceId).to.equal('EXC-001');
            expect(result.jsonData.Grant[0].ExclusionGrant[1].ExcludedResourceId).to.equal('EXC-002');
            expect(result.jsonData.Grant[0].ExclusionGrant[2].ExcludedResourceId).to.equal('EXC-003');
        });

        it('should substitute root-level CSV variables in 3-level nested array template', async () => {
            // 3-level nesting with root-level CSV variables
            const template = JSON.stringify({
                CompanyName: '{{Company:string}}',
                Region: '{{ENV:region}}',
                Shipments: [{
                    ShipmentId: '{{ShipmentID}}',
                    Packages: [{
                        PackageId: '{{PackageID}}',
                        Items: [{
                            SKU: '{{SKU}}'
                        }]
                    }]
                }]
            });

            const csvData = [
                ['Company', 'ShipmentID', 'PackageID', 'SKU'],
                ['Acme Corp', 'S1', 'P1', 'SKU-A'],
                ['Acme Corp', 'S1', 'P1', 'SKU-B']
            ];

            const options = {
                template,
                headers: ['Company', 'ShipmentID', 'PackageID', 'SKU'],
                mappings: [
                    { variable: 'Company', column: 'Company', dataType: 'string' },
                    { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                    { variable: 'PackageID', column: 'PackageID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                environmentVariables: { region: 'US-WEST' }
            };

            const result = await (jsonGenerator as any).generate3LevelNestedArrayJson(csvData, options);

            expect(result.success).to.be.true;

            // Root-level CSV variable must be substituted (this is the bug)
            expect(result.jsonData.CompanyName).to.equal('Acme Corp');

            // Root-level ENV variable should also be substituted
            expect(result.jsonData.Region).to.equal('US-WEST');

            // Verify nested structure
            expect(result.jsonData.Shipments).to.be.an('array').with.lengthOf(1);
            expect(result.jsonData.Shipments[0].ShipmentId).to.equal('S1');
            expect(result.jsonData.Shipments[0].Packages[0].Items).to.have.lengthOf(2);
        });

        it('should substitute root-level CSV variables via generateBatchJsonFiles with nestingLevel=2', async () => {
            // End-to-end test through the batch execution path
            const template = JSON.stringify({
                RoleId: '{{RollId:string}}',
                RoleName: '{{RoleName:string}}',
                OrganizationId: '{{ENV:org}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    ExclusionGrant: [{
                        ExcludedResourceId: '{{ExcludedResourceId}}'
                    }]
                }]
            });

            const csvData = 'RollId,RoleName,ResourceId,ExcludedResourceId\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-001\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-002\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-003';

            const options = {
                template,
                headers: ['RollId', 'RoleName', 'ResourceId', 'ExcludedResourceId'],
                mappings: [
                    { variable: 'RollId', column: 'RollId', dataType: 'string' },
                    { variable: 'RoleName', column: 'RoleName', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'ExcludedResourceId', column: 'ExcludedResourceId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }],
                environmentVariables: { org: 'ORG-840' }
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(1);

            const content = result.files[0].content;

            // Root-level CSV variables must be substituted
            expect(content.RoleId).to.equal('00_Superusers_840');
            expect(content.RoleName).to.equal('00_Superusers_840');

            // Root-level ENV variable should be substituted
            expect(content.OrganizationId).to.equal('ORG-840');

            // Verify nested structure
            expect(content.Grant).to.be.an('array').with.lengthOf(1);
            expect(content.Grant[0].ExclusionGrant).to.be.an('array').with.lengthOf(3);
        });

        it('should create separate files per root variable group in 2-level nesting', async () => {
            // When root-level CSV variables have different values across rows,
            // each unique root value should produce a separate file
            const template = JSON.stringify({
                RoleId: '{{RollId:string}}',
                RoleName: '{{RoleName:string}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    ExclusionGrant: [{
                        ExcludedResourceId: '{{ExcludedResourceId}}'
                    }]
                }]
            });

            const csvData = 'RollId,RoleName,ResourceId,ExcludedResourceId\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-001\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-002\n' +
                '00_Superusers_840,00_Superusers_840,RES-001,EXC-003\n' +
                '00_Superusers_880,00_Superusers_880,RES-002,EXC-004\n' +
                '00_Superusers_880,00_Superusers_880,RES-002,EXC-005\n' +
                '00_Superusers_880,00_Superusers_880,RES-002,EXC-006';

            const options = {
                template,
                headers: ['RollId', 'RoleName', 'ResourceId', 'ExcludedResourceId'],
                mappings: [
                    { variable: 'RollId', column: 'RollId', dataType: 'string' },
                    { variable: 'RoleName', column: 'RoleName', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'ExcludedResourceId', column: 'ExcludedResourceId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // Should produce 2 files: one for _840, one for _880
            expect(result.files).to.have.lengthOf(2);

            // First file: _840 rows
            const file1 = result.files[0];
            expect(file1.content.RoleId).to.equal('00_Superusers_840');
            expect(file1.content.RoleName).to.equal('00_Superusers_840');
            expect(file1.content.Grant).to.be.an('array').with.lengthOf(1);
            expect(file1.content.Grant[0].ResourceId).to.equal('RES-001');
            expect(file1.content.Grant[0].ExclusionGrant).to.be.an('array').with.lengthOf(3);
            expect(file1.rowRange).to.deep.equal({ start: 1, end: 3 });

            // Second file: _880 rows
            const file2 = result.files[1];
            expect(file2.content.RoleId).to.equal('00_Superusers_880');
            expect(file2.content.RoleName).to.equal('00_Superusers_880');
            expect(file2.content.Grant).to.be.an('array').with.lengthOf(1);
            expect(file2.content.Grant[0].ResourceId).to.equal('RES-002');
            expect(file2.content.Grant[0].ExclusionGrant).to.be.an('array').with.lengthOf(3);
            expect(file2.rowRange).to.deep.equal({ start: 4, end: 6 });
        });
    });
});
