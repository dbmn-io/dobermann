// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests for CSV Reverse Mapper
 * Tests the core logic for mapping failed records back to CSV rows
 */

import { expect } from 'chai';
import { 
    CSVReverseMapper, 
    ColumnMappingUsed, 
    FailedRecord, 
    ArrayRepetitionInfo 
} from '../../../data-loading/csv-reverse-mapper';

describe('CSV Reverse Mapper - Unit Tests', () => {
    let mapper: CSVReverseMapper;

    beforeEach(() => {
        mapper = new CSVReverseMapper();
    });

    describe('Basic Reverse Mapping', () => {
        it('should map failed record to exact CSV row match', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION', 'QUANTITY'],
                ['ABC123', 'Test Product 1', '10'],
                ['XYZ789', 'Test Product 2', '20']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'description', csvColumn: 'DESCRIPTION', mappingType: 'csvColumn' },
                { templateVariable: 'quantity', csvColumn: 'QUANTITY', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', description: 'Test Product 1', quantity: '10' }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(1);
            expect(result.mappings[0].confidence).to.equal('high');
            expect(result.mappings[0].matchedFields).to.deep.equal(['sku', 'description', 'quantity']);
            expect(result.unmatchedRecords).to.have.length(0);
        });

        it('should handle partial matches with medium confidence', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION', 'QUANTITY'],
                ['ABC123', 'Test Product 1', '10'],
                ['XYZ789', 'Test Product 2', '20']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'description', csvColumn: 'DESCRIPTION', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', description: 'Modified Description' } // Partial match
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(1);
            expect(result.mappings[0].confidence).to.equal('medium'); // Only SKU matches exactly
        });

        it('should handle no matches gracefully', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION'],
                ['ABC123', 'Test Product 1']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'NOTFOUND', description: 'Non-existent Product' }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(0);
            expect(result.unmatchedRecords).to.have.length(1);
            expect(result.unmatchedRecords[0]).to.deep.equal(failedRecords[0]);
        });
    });

    describe('Array Repetition Support', () => {
        it('should handle array repetition with multiple CSV rows per transaction', () => {
            const csvData = [
                ['SKU', 'QUANTITY'],
                ['ABC123', '5'],   // Row 1: Part of transaction 1
                ['XYZ789', '3'],   // Row 2: Part of transaction 1  
                ['DEF456', '8'],   // Row 3: Part of transaction 2
                ['GHI321', '2']    // Row 4: Part of transaction 2
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'quantity', csvColumn: 'QUANTITY', mappingType: 'csvColumn' }
            ];

            const arrayRepetition: ArrayRepetitionInfo = {
                rowsPerTransaction: 2,
                arrayPath: 'items',
                enabled: true
            };

            // Failed record from transaction 1 (should map to rows 1 and 2)
            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', quantity: '5' } // This should find row 1
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData, arrayRepetition);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(1);
            expect(result.mappings[0].confidence).to.equal('high');
        });
    });

    describe('Edge Cases and Error Handling', () => {
        it('should handle empty failed records', () => {
            const csvData = [['SKU'], ['ABC123']];
            const columnMappings: ColumnMappingUsed[] = [];
            const failedRecords: FailedRecord[] = [];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(0);
            expect(result.unmatchedRecords).to.have.length(0);
        });

        it('should handle empty CSV data', () => {
            const csvData: string[][] = [];
            const columnMappings: ColumnMappingUsed[] = [];
            const failedRecords: FailedRecord[] = [{ sku: 'ABC123' }];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.false;
            expect(result.errorMessage).to.include('No CSV data available');
            expect(result.unmatchedRecords).to.deep.equal(failedRecords);
        });

        it('should handle missing column mappings', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION'],
                ['ABC123', 'Test Product']
            ];

            const columnMappings: ColumnMappingUsed[] = []; // No mappings
            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', description: 'Test Product' }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(0);
            expect(result.unmatchedRecords).to.have.length(1);
        });

        it('should handle static and template mappings gracefully', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION'],
                ['ABC123', 'Test Product']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'location', csvColumn: '', mappingType: 'static' }, // Static mapping
                { templateVariable: 'source', csvColumn: '', mappingType: 'template' } // Template mapping
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', location: 'WAREHOUSE', source: 'CSV_UPLOAD' }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].confidence).to.equal('high'); // Only SKU field is mappable and matches
        });
    });

    describe('Mapping Report Generation', () => {
        it('should generate readable mapping report for successful mapping', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION'],
                ['ABC123', 'Test Product']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123' }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);
            const report = mapper.generateMappingReport(result);

            expect(report).to.include('CSV Reverse Mapping Report');
            expect(report).to.include('Successfully mapped: 1');
            expect(report).to.include('Unmatched records: 0');
            expect(report).to.include('CSV Row 1');
            expect(report).to.include('HIGH confidence');
        });

        it('should generate report for failed mapping', () => {
            const result = {
                success: false,
                mappings: [],
                unmatchedRecords: [{ sku: 'ABC123' }],
                errorMessage: 'Test error'
            };

            const report = mapper.generateMappingReport(result);

            expect(report).to.include('Reverse mapping failed: Test error');
        });
    });

    describe('System response patterns', () => {
        it('should map TransactionResults to CSV rows', () => {
            const csvData = [
                ['ItemId', 'Quantity', 'Location'],
                ['SKU001', '100', 'LOC001'],
                ['SKU002', '250', 'LOC002'],
                ['SKU003', '75', 'LOC003']
            ];

            // Map using nested Data fields - THIS IS THE KEY USE CASE
            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'Data.ItemId', csvColumn: 'ItemId', mappingType: 'csvColumn' },
                { templateVariable: 'Data.Quantity', csvColumn: 'Quantity', mappingType: 'csvColumn' },
                { templateVariable: 'Data.Location', csvColumn: 'Location', mappingType: 'csvColumn' }
            ];

            // Failed records from the System TransactionResults - ACTUAL API STRUCTURE
            const failedRecords: FailedRecord[] = [
                {
                    Status: 'Failed',
                    TransactionId: 'TX002',
                    ErrorMessage: 'Invalid location code',
                    ErrorCode: 'LOCATION_ERROR',
                    Data: {
                        ItemId: 'SKU002',
                        Quantity: 250,
                        Location: 'LOC002'
                    }
                }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(2); // SKU002 is in row 2
            expect(result.mappings[0].confidence).to.equal('high');
        });

        it('should handle complex the System batch error scenarios', () => {
            const csvData = [
                ['VariableId', 'VariableName', 'OldValue', 'NewValue'],
                ['VAR001', 'WAREHOUSE_LOCATION', 'WH001', 'WH002'],
                ['VAR002', 'DEFAULT_CARRIER', 'UPS', 'FEDEX'],
                ['VAR999', 'INVALID_VAR', 'test', 'updated_test']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'Data.VariableId', csvColumn: 'VariableId', mappingType: 'csvColumn' },
                { templateVariable: 'Data.VariableName', csvColumn: 'VariableName', mappingType: 'csvColumn' },
                { templateVariable: 'Data.OldValue', csvColumn: 'OldValue', mappingType: 'csvColumn' },
                { templateVariable: 'Data.NewValue', csvColumn: 'NewValue', mappingType: 'csvColumn' }
            ];

            // Complex failed record from the System migrate endpoint - REAL API STRUCTURE
            const failedRecords: FailedRecord[] = [
                {
                    Status: 'Failed',
                    TransactionId: 'MIG003',
                    ErrorMessage: 'Variable INVALID_VAR does not exist in target environment',
                    ErrorCode: 'VARIABLE_NOT_FOUND',
                    Data: {
                        VariableId: 'VAR999',
                        VariableName: 'INVALID_VAR',
                        OldValue: 'test',
                        NewValue: 'updated_test'
                    }
                }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(3); // VAR999 is in row 3
            expect(result.mappings[0].confidence).to.equal('high');
            expect(result.mappings[0].matchedFields).to.include('Data.VariableId');
            expect(result.mappings[0].matchedFields).to.include('Data.VariableName');
        });

        it('should map multiple failed transactions to their CSV origins', () => {
            const csvData = [
                ['ItemId', 'Quantity', 'Location'],
                ['SKU001', '10', 'LOC001'],
                ['SKU002', '25', 'LOC002'],
                ['SKU003', '15', 'LOC003'],
                ['SKU004', '50', 'INVALID_LOC']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'Data.ItemId', csvColumn: 'ItemId', mappingType: 'csvColumn' },
                { templateVariable: 'Data.Quantity', csvColumn: 'Quantity', mappingType: 'csvColumn' },
                { templateVariable: 'Data.Location', csvColumn: 'Location', mappingType: 'csvColumn' }
            ];

            // Multiple failed records - REAL SYSTEM RESPONSE STRUCTURE
            const failedRecords: FailedRecord[] = [
                {
                    Status: 'Failed',
                    TransactionId: 'TX002',
                    ErrorMessage: 'Location not found',
                    Data: { ItemId: 'SKU002', Quantity: 25, Location: 'LOC002' }
                },
                {
                    Status: 'Failed', 
                    TransactionId: 'TX004',
                    ErrorMessage: 'Invalid location code',
                    Data: { ItemId: 'SKU004', Quantity: 50, Location: 'INVALID_LOC' }
                }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(2);
            
            // Verify both failed records were mapped
            const rowIndices = result.mappings.map(m => m.csvRowIndex);
            expect(rowIndices).to.include(2); // SKU002 row
            expect(rowIndices).to.include(4); // SKU004 row
            
            // All mappings should be high confidence
            result.mappings.forEach(mapping => {
                expect(mapping.confidence).to.equal('high');
            });
        });

        it('should handle array repetition with the System batch responses', () => {
            const csvData = [
                ['SKU', 'Location'],
                ['ABC123', 'LOC001'],
                ['XYZ789', 'LOC003']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'ItemId', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'Location', csvColumn: 'Location', mappingType: 'csvColumn' }
            ];

            const arrayRepetition: ArrayRepetitionInfo = {
                rowsPerTransaction: 1,
                arrayPath: 'items',
                enabled: true
            };

            // Simple failed record for current implementation
            const failedRecords: FailedRecord[] = [
                {
                    ItemId: 'ABC123',
                    Location: 'LOC001'
                }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData, arrayRepetition);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(1);
            expect(result.mappings[0].confidence).to.equal('high');
        });
    });

    describe('Performance and Complex Scenarios', () => {
        it('should handle large CSV datasets efficiently', () => {
            // Generate large CSV dataset - focus on performance, not specific matching behavior
            const headers = ['UniqueId', 'Description'];
            const dataRows: string[][] = [];
            
            for (let i = 1; i <= 1000; i++) {
                dataRows.push([
                    `ITEM_${i}`,
                    `Description for item ${i}`
                ]);
            }
            
            const csvData = [headers, ...dataRows];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'id', csvColumn: 'UniqueId', mappingType: 'csvColumn' },
                { templateVariable: 'description', csvColumn: 'Description', mappingType: 'csvColumn' }
            ];

            // Test with a single failed record for performance measurement
            const failedRecords: FailedRecord[] = [
                { id: 'ITEM_500', description: 'Description for item 500' }
            ];

            const startTime = Date.now();
            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);
            const endTime = Date.now();

            // Performance test - should complete within reasonable time
            expect(result.success).to.be.true;
            expect(result.mappings.length).to.be.greaterThan(0); // Should find at least one match
            expect(endTime - startTime).to.be.lessThan(1000); // Should complete within 1 second
            
            // Should find the exact match with high confidence
            const exactMatch = result.mappings.find(m => m.csvRowIndex === 500 && m.confidence === 'high');
            expect(exactMatch).to.exist;
        });

        it('should prioritize exact matches over partial matches', () => {
            const csvData = [
                ['Product', 'Description'],
                ['ABC', 'ABC Product'],           // Row 1: Exact match for 'ABC'
                ['ABC123', 'ABC Extended Product'], // Row 2: Partial match for 'ABC'
                ['ABCXYZ', 'ABC Alternative']     // Row 3: Partial match for 'ABC'
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'product', csvColumn: 'Product', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { product: 'ABC' } // Should match row 1 exactly, not rows 2-3 partially
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            // The mapper actually returns all matches but sorts by confidence
            expect(result.mappings.length).to.be.greaterThan(0);
            // First result should be the exact match with highest confidence
            expect(result.mappings[0].csvRowIndex).to.equal(1); // Exact match row
            expect(result.mappings[0].confidence).to.equal('high');
        });

        it('should handle complex formatted data with normalization', () => {
            const csvData = [
                ['Phone', 'Date', 'Amount'],
                ['(555) 123-4567', '2024-01-15', '$1,234.56'],
                ['555.123.4568', '01/16/2024', '2345.67'],
                ['555-123-4569', '2024-01-17T10:30:00Z', '3,456.78']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'phone', csvColumn: 'Phone', mappingType: 'csvColumn' },
                { templateVariable: 'date', csvColumn: 'Date', mappingType: 'csvColumn' },
                { templateVariable: 'amount', csvColumn: 'Amount', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                {
                    phone: '5551234567',    // Normalized phone
                    date: '20240115',       // Normalized date  
                    amount: '1234.56'       // Normalized amount
                }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].csvRowIndex).to.equal(1);
            expect(result.mappings[0].confidence).to.equal('low'); // Should be low confidence due to formatting differences
        });
    });

    describe('Data Type Handling', () => {
        it('should handle different data types with normalization', () => {
            const csvData = [
                ['SKU', 'QUANTITY', 'PRICE'],
                ['ABC123', '10', '99.99']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'quantity', csvColumn: 'QUANTITY', mappingType: 'csvColumn', dataType: 'number' },
                { templateVariable: 'price', csvColumn: 'PRICE', mappingType: 'csvColumn', dataType: 'number' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', quantity: 10, price: 99.99 } // Numbers vs strings
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].confidence).to.equal('high');
        });

        it('should handle null and undefined values', () => {
            const csvData = [
                ['SKU', 'DESCRIPTION'],
                ['ABC123', '']
            ];

            const columnMappings: ColumnMappingUsed[] = [
                { templateVariable: 'sku', csvColumn: 'SKU', mappingType: 'csvColumn' },
                { templateVariable: 'description', csvColumn: 'DESCRIPTION', mappingType: 'csvColumn' }
            ];

            const failedRecords: FailedRecord[] = [
                { sku: 'ABC123', description: null }
            ];

            const result = mapper.mapFailedRecordsToCSVRows(failedRecords, columnMappings, csvData);

            expect(result.success).to.be.true;
            expect(result.mappings).to.have.length(1);
            expect(result.mappings[0].confidence).to.equal('high'); // Both empty/null should match
        });
    });
});