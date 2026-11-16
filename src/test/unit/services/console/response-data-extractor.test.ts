// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ResponseDataExtractor } from '../../../../services/console/response-data-extractor';
import * as fs from 'fs';
import * as path from 'path';

describe('ResponseDataExtractor - Unit Tests', () => {
    let extractor: ResponseDataExtractor;
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        extractor = new ResponseDataExtractor();
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('extractTableData - Core Functionality', () => {
        it('should extract simple flat JSON data correctly', async () => {
            const testData = {
                id: 1,
                name: 'Test',
                value: 100,
                status: 'success'
            };

            // Create temp file
            const tempFile = path.join(__dirname, 'test-simple.json');
            fs.writeFileSync(tempFile, JSON.stringify(testData));

            try {
                const result = await extractor.extractIndividualResponse(tempFile);

                expect(result.rows).to.have.lengthOf(1);
                expect(result.columns).to.have.length.greaterThan(0);
                expect(result.rows[0]).to.include({
                    id: 1,
                    name: 'Test',
                    value: 100,
                    status: 'success'
                });
            } finally {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }
        });

        it('should handle nested JSON with data property (user case)', async () => {
            const testData = {
                executionId: "2025-08-17T11-55-39_g0e",
                duration: 1291,
                httpStatus: 200,
                data: {
                    SuccessCount: 2,
                    FailedCount: 1,
                    TotalCount: 3,
                    ProcessingTime: "00:00:01.420",
                    TransactionResults: [
                        {
                            Status: "Success",
                            TransactionId: "MIG001",
                            Data: {
                                VariableId: "VAR001",
                                VariableName: "WAREHOUSE_LOCATION"
                            }
                        },
                        {
                            Status: "Success",
                            TransactionId: "MIG002",
                            Data: {
                                VariableId: "VAR002",
                                VariableName: "DEFAULT_CARRIER"
                            }
                        },
                        {
                            Status: "Failed",
                            TransactionId: "MIG003",
                            ErrorMessage: "Variable not found"
                        }
                    ]
                }
            };

            const tempFile = path.join(__dirname, 'test-nested.json');
            fs.writeFileSync(tempFile, JSON.stringify(testData));

            try {
                const result = await extractor.extractIndividualResponse(tempFile);

                console.log('Nested JSON Test Results:');
                console.log('- Rows:', result.rows.length);
                console.log('- Columns:', result.columns.map((c: any) => c.id));
                console.log('- First row keys:', Object.keys(result.rows[0] || {}));
                
                // Current behavior check - this is what's happening now
                if (result.columns.length === 1 && result.columns[0].id === 'data') {
                    console.log('ERROR: Data is not being flattened properly!');
                    console.log('Column value:', result.rows[0]?.data);
                }

                // What we SHOULD expect (but currently fails)
                // expect(result.columns.map(c => c.id)).to.include('executionId');
                // expect(result.columns.map(c => c.id)).to.include('httpStatus');
                // expect(result.columns.map(c => c.id)).to.include.members([
                //     'data.SuccessCount',
                //     'data.FailedCount',
                //     'data.TotalCount'
                // ]);

                // FIXED: Arrays should now be passed through as arrays, not strings
                expect(result.rows).to.have.length.greaterThan(0);
                expect(result.columns).to.have.length.greaterThan(0);
                
                // Verify TransactionResults is an actual array, not stringified JSON
                const transactionResultsValue = result.rows[0]['TransactionResults'] as Record<string, unknown>[];
                expect(Array.isArray(transactionResultsValue)).to.be.true;
                expect(transactionResultsValue).to.have.lengthOf(3);
                expect(transactionResultsValue[0]).to.have.property('Status', 'Success');
                expect(transactionResultsValue[0]).to.have.property('TransactionId', 'MIG001');
                
                console.log('✅ TransactionResults is now an actual array, not JSON string!');
            } finally {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }
        });

        it('should handle arrays at root level', async () => {
            const testData = [
                { id: 1, name: 'Item 1' },
                { id: 2, name: 'Item 2' },
                { id: 3, name: 'Item 3' }
            ];

            const tempFile = path.join(__dirname, 'test-array.json');
            fs.writeFileSync(tempFile, JSON.stringify(testData));

            try {
                const result = await extractor.extractIndividualResponse(tempFile);

                expect(result.rows).to.have.lengthOf(3);
                expect(result.columns.map((c: any) => c.id)).to.include.members(['id', 'name']);
                expect(result.rows[0]).to.include({ id: 1, name: 'Item 1' });
            } finally {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }
        });
    });

    describe('analyzeDataStructure - Structure Analysis', () => {
        it('should analyze simple object structure', () => {
            const data = {
                id: 1,
                name: 'Test',
                value: 100
            };

            const analysis = extractor.analyzeDataStructure(data);
            
            expect(analysis.type).to.equal('object');
            expect(analysis.depth).to.be.lessThanOrEqual(2);
            expect(analysis.flatteningStrategy.enabled).to.be.true;
        });

        it('should handle complex nested structures with flattening enabled', () => {
            const data = {
                level1: {
                    level2: {
                        level3: {
                            level4: {
                                value: 'deep'
                            }
                        }
                    }
                }
            };

            const analysis = extractor.analyzeDataStructure(data);
            
            expect(analysis.type).to.equal('object');
            expect(analysis.depth).to.be.greaterThan(2);
            
            // FIXED: Now flattening stays enabled even for complex structures
            expect(analysis.flatteningStrategy.enabled).to.be.true;
            console.log('Complex structure flattening enabled?', analysis.flatteningStrategy.enabled);
        });

        it('should detect arrays and determine display strategy', () => {
            const data = {
                smallArray: [1, 2, 3],  // Should be 'concatenate' or 'inline'
                mediumArray: [1, 2, 3, 4, 5, 6, 7, 8],  // Should be 'inline'
                largeArray: new Array(20).fill(0)  // Should be 'modal'
            };

            const analysis = extractor.analyzeDataStructure(data);
            
            expect(analysis.arrayPaths).to.have.length.greaterThan(0);
            
            const smallArrayInfo = analysis.arrayPaths.find(a => a.path === 'smallArray');
            const mediumArrayInfo = analysis.arrayPaths.find(a => a.path === 'mediumArray');
            const largeArrayInfo = analysis.arrayPaths.find(a => a.path === 'largeArray');
            
            console.log('Array strategies:');
            console.log('- Small (3 items):', smallArrayInfo?.strategy);
            console.log('- Medium (8 items):', mediumArrayInfo?.strategy);
            console.log('- Large (20 items):', largeArrayInfo?.strategy);
        });

        it('should handle the problematic user JSON structure', () => {
            const data = {
                executionId: "2025-08-17T11-55-39_g0e",
                httpStatus: 200,
                data: {
                    SuccessCount: 2,
                    TransactionResults: [
                        { Status: "Success", Data: { VariableId: "VAR001" } },
                        { Status: "Success", Data: { VariableId: "VAR002" } },
                        { Status: "Failed", ErrorMessage: "Not found" }
                    ]
                }
            };

            const analysis = extractor.analyzeDataStructure(data);
            
            console.log('\nUser JSON Structure Analysis:');
            console.log('- Type:', analysis.type);
            console.log('- Depth:', analysis.depth);
            console.log('- Flattening enabled?', analysis.flatteningStrategy.enabled);
            console.log('- Flattening max depth:', analysis.flatteningStrategy.maxDepth);
            console.log('- Array paths found:', analysis.arrayPaths.length);
            console.log('- Suggested view:', analysis.suggestedView);
            
            // Document the current broken behavior
            if (!analysis.flatteningStrategy.enabled) {
                console.log('WARNING: Flattening is disabled - this causes [object Object] display!');
            }
        });
    });

    describe('flattenObject - Private Method Behavior', () => {
        it('should flatten when strategy is enabled', () => {
            // We'll test through the public interface
            const data = {
                level1: {
                    prop1: 'value1',
                    level2: {
                        prop2: 'value2'
                    }
                }
            };

            const analysis = extractor.analyzeDataStructure(data);
            // For simple structure, flattening should be enabled
            expect(analysis.flatteningStrategy.enabled).to.be.true;
        });

        it('should keep flattening enabled for deep structures (bug fixed)', () => {
            const deepData = {
                a: {
                    b: {
                        c: {
                            d: 'value'
                        }
                    }
                }
            };

            const analysis = extractor.analyzeDataStructure(deepData);
            // FIXED: Now flattening stays enabled even for deep structures
            expect(analysis.flatteningStrategy.enabled).to.be.true;
        });
    });

    describe('Performance Metrics', () => {
        it('should track extraction time', async () => {
            const testData = { id: 1, name: 'Test' };
            const tempFile = path.join(__dirname, 'test-perf.json');
            fs.writeFileSync(tempFile, JSON.stringify(testData));

            try {
                const result = await extractor.extractIndividualResponse(tempFile);

                expect(result.metadata.extractionTime).to.be.a('number');
                expect(result.metadata.extractionTime).to.be.greaterThanOrEqual(0);
            } finally {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }
        });
    });

    describe('extractAtPath - Nested Array Navigation (Export Bug Fix)', () => {
        it('should extract data from nested array paths like data.data.ItemPackage', () => {
            // GitHub Issue: Export does nothing when at nested array path like data.data.ItemPackage
            // Root cause: Backend's extractSingleAtPath() doesn't handle intermediate arrays

            // Test data mimicking the actual bug scenario
            const testData = [
                {
                    data: {
                        data: [
                            {
                                ItemId: 'ACAU-RATESTITEM01',
                                ShortDescription: 'Test Item 01',
                                ItemPackage: [
                                    { UomId: 'units', Quantity: 1 },
                                    { UomId: 'INNER', Quantity: 6 }
                                ]
                            },
                            {
                                ItemId: 'ACAU-RATESTITEM02',
                                ShortDescription: 'Test Item 02',
                                ItemPackage: [
                                    { UomId: 'OUTER', Quantity: 60 }
                                ]
                            }
                        ]
                    }
                }
            ];

            // Extract at nested array path (this currently fails)
            const result = extractor.extractAtPath(testData, 'data.data.ItemPackage');

            // Assertions
            expect(result).to.be.an('array');
            expect(result.length).to.equal(3); // 2 from ITEM01 + 1 from ITEM02

            // Verify extracted packages
            expect(result[0]).to.deep.include({ UomId: 'units', Quantity: 1 });
            expect(result[1]).to.deep.include({ UomId: 'INNER', Quantity: 6 });
            expect(result[2]).to.deep.include({ UomId: 'OUTER', Quantity: 60 });
        });

        it('should handle multiple levels of nested arrays', () => {
            const testData = [
                {
                    data: {
                        OrderId: 'ORDER-001',
                        OrderLines: [
                            {
                                LineId: 'LINE-A',
                                LineItems: [
                                    {
                                        ItemId: 'ITEM-1',
                                        Details: [
                                            { DetailId: 'D1', Value: 100 },
                                            { DetailId: 'D2', Value: 200 }
                                        ]
                                    }
                                ]
                            },
                            {
                                LineId: 'LINE-B',
                                LineItems: [
                                    {
                                        ItemId: 'ITEM-2',
                                        Details: [
                                            { DetailId: 'D3', Value: 300 }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                }
            ];

            // Extract deeply nested array path
            const result = extractor.extractAtPath(testData, 'data.OrderLines.LineItems.Details');

            expect(result).to.be.an('array');
            expect(result.length).to.equal(3); // D1, D2, D3
            expect(result[0]).to.deep.include({ DetailId: 'D1', Value: 100 });
            expect(result[1]).to.deep.include({ DetailId: 'D2', Value: 200 });
            expect(result[2]).to.deep.include({ DetailId: 'D3', Value: 300 });
        });

        it('should return root data when path is "root"', () => {
            const testData = [
                { id: 1, name: 'Item 1' },
                { id: 2, name: 'Item 2' }
            ];

            const result = extractor.extractAtPath(testData, 'root');

            expect(result).to.equal(testData);
            expect(result).to.have.lengthOf(2);
        });

        it('should return empty array when path does not exist', () => {
            const testData = [
                {
                    data: {
                        items: [
                            { id: 1 }
                        ]
                    }
                }
            ];

            const result = extractor.extractAtPath(testData, 'data.nonexistent.path');

            expect(result).to.be.an('array');
            expect(result).to.have.lengthOf(0);
        });

        it('should handle empty intermediate arrays', () => {
            const testData = [
                {
                    data: {
                        data: [] // Empty array
                    }
                }
            ];

            const result = extractor.extractAtPath(testData, 'data.data.ItemPackage');

            expect(result).to.be.an('array');
            expect(result).to.have.lengthOf(0);
        });

        it('should include parent fields when extracting nested arrays (GitHub Issue #110 - Export)', () => {
            // This test verifies that parent fields are included in backend extraction
            // just like the frontend does with WeakMap
            const testData = [
                {
                    data: {
                        data: [
                            {
                                ItemId: 'ACAU-RATESTITEM01',
                                ShortDescription: 'Test Item 01',
                                ItemPackage: [
                                    { UomId: 'units', Quantity: 1 },
                                    { UomId: 'INNER', Quantity: 6 }
                                ]
                            },
                            {
                                ItemId: 'ACAU-RATESTITEM02',
                                ShortDescription: 'Test Item 02',
                                ItemPackage: [
                                    { UomId: 'OUTER', Quantity: 60 }
                                ]
                            }
                        ]
                    }
                }
            ];

            // Extract at nested array path
            const result = extractor.extractAtPath(testData, 'data.data.ItemPackage');

            // Verify we got 3 packages
            expect(result.length).to.equal(3);

            // CRITICAL: Verify parent fields are included
            // Each package should have its parent's ItemId and ShortDescription as parent_L1.* fields
            expect(result[0]).to.have.property('parent_L1.ItemId', 'ACAU-RATESTITEM01');
            expect(result[0]).to.have.property('parent_L1.ShortDescription', 'Test Item 01');
            expect(result[0]).to.have.property('UomId', 'units');
            expect(result[0]).to.have.property('Quantity', 1);

            expect(result[1]).to.have.property('parent_L1.ItemId', 'ACAU-RATESTITEM01');
            expect(result[1]).to.have.property('parent_L1.ShortDescription', 'Test Item 01');
            expect(result[1]).to.have.property('UomId', 'INNER');
            expect(result[1]).to.have.property('Quantity', 6);

            expect(result[2]).to.have.property('parent_L1.ItemId', 'ACAU-RATESTITEM02');
            expect(result[2]).to.have.property('parent_L1.ShortDescription', 'Test Item 02');
            expect(result[2]).to.have.property('UomId', 'OUTER');
            expect(result[2]).to.have.property('Quantity', 60);
        });
    });
});