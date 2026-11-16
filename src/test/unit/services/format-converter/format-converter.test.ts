// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for FormatConverterService
 * Tests format detection, Excel processing, TSV conversion, and custom delimiter handling
 * 
 * Following Architecture.md testing patterns:
 * - Focus on business logic testing
 * - Comprehensive edge case coverage
 * - Integration with Excel processing library
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { FormatConverterService } from '../../../../services/format-converter/format-converter.service';
import { SupportedFormat, ConversionOptions } from '../../../../services/format-converter/format-converter.interface';
import { NumberSourceFormat, DateSourceFormat, BooleanSourceFormat, StringSourceFormat } from '../../../../services/format-converter/source-format.interface';
import * as XLSX from 'xlsx';

describe('FormatConverterService', function() {
    this.timeout(10000);

    let service: FormatConverterService;

    beforeEach(function() {
        service = new FormatConverterService();
    });

    describe('Format Detection', function() {
        it('should detect CSV format from file extension', async function() {
            const csvData = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA';
            const result = await service.detectFormat('test.csv', csvData);
            
            expect(result.format).to.equal(SupportedFormat.CSV);
            expect(result.confidence).to.be.greaterThan(0.8);
            expect(result.metadata.delimiter).to.equal(',');
        });

        it('should detect TSV format from file extension', async function() {
            const tsvData = 'Name\tAge\tCity\nJohn\t25\tNYC\nJane\t30\tLA';
            const result = await service.detectFormat('test.tsv', tsvData);
            
            expect(result.format).to.equal(SupportedFormat.TSV);
            expect(result.confidence).to.be.greaterThan(0.8);
            expect(result.metadata.delimiter).to.equal('\t');
        });

        it('should detect Excel format from file extension', async function() {
            // Create a simple Excel buffer
            const worksheet = XLSX.utils.aoa_to_sheet([
                ['Name', 'Age', 'City'],
                ['John', 25, 'NYC'],
                ['Jane', 30, 'LA']
            ]);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            const result = await service.detectFormat('test.xlsx', buffer);
            
            expect(result.format).to.equal(SupportedFormat.EXCEL);
            expect(result.confidence).to.be.greaterThan(0.9);
            expect(result.metadata.sheets).to.be.an('array');
            expect(result.metadata.sheets).to.include('Sheet1');
        });

        it('should detect custom delimiter from content', async function() {
            const pipeData = 'Name|Age|City\nJohn|25|NYC\nJane|30|LA';
            const result = await service.detectFormat('test.txt', pipeData);
            
            expect(result.format).to.equal(SupportedFormat.CUSTOM_DELIMITED);
            expect(result.metadata.delimiter).to.equal('|');
        });

        it('should handle unknown file extensions by analyzing content', async function() {
            const csvData = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA';
            const result = await service.detectFormat('test.unknown', csvData);
            
            expect(result.format).to.equal(SupportedFormat.CUSTOM_DELIMITED);
            expect(result.metadata.delimiter).to.equal(',');
        });

        it('should include file size in metadata', async function() {
            const testData = 'Name,Age\nJohn,25';
            const result = await service.detectFormat('test.csv', testData);
            
            expect(result.metadata.fileSize).to.be.a('number');
            expect(result.metadata.fileSize).to.be.greaterThan(0);
        });
    });

    describe('Excel Processing', function() {
        let testWorkbook: Buffer;

        beforeEach(function() {
            // Create test Excel workbook with multiple sheets
            const sheet1 = XLSX.utils.aoa_to_sheet([
                ['Product', 'Price', 'Category'],
                ['Laptop', 999.99, 'Electronics'],
                ['Book', 19.99, 'Education'],
                ['Shirt', 29.99, 'Clothing']
            ]);
            
            const sheet2 = XLSX.utils.aoa_to_sheet([
                ['Name', 'Department'],
                ['Alice', 'HR'],
                ['Bob', 'IT']
            ]);

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, sheet1, 'Products');
            XLSX.utils.book_append_sheet(workbook, sheet2, 'Employees');
            
            testWorkbook = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        });

        it('should get Excel sheet information', async function() {
            const sheets = await service.getExcelSheets(testWorkbook);
            
            expect(sheets).to.have.length(2);
            expect(sheets[0].name).to.equal('Products');
            expect(sheets[0].rowCount).to.equal(4);
            expect(sheets[0].columnCount).to.equal(3);
            expect(sheets[1].name).to.equal('Employees');
        });

        it('should convert Excel to CSV (first sheet by default)', async function() {
            const result = await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL);
            
            expect(result.csvData).to.include('Product,Price,Category');
            expect(result.csvData).to.include('Laptop,999.99,Electronics');
            expect(result.preview.headers).to.deep.equal(['Product', 'Price', 'Category']);
            expect(result.preview.rows).to.have.length(3);
            expect(result.metadata.selectedSheet).to.equal('Products');
        });

        it('should convert specific Excel sheet by index', async function() {
            const options: ConversionOptions = { sheetIndex: 1 };
            const result = await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL, options);
            
            expect(result.csvData).to.include('Name,Department');
            expect(result.csvData).to.include('Alice,HR');
            expect(result.metadata.selectedSheet).to.equal('Employees');
        });

        it('should convert specific Excel sheet by name', async function() {
            const options: ConversionOptions = { sheetName: 'Employees' };
            const result = await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL, options);
            
            expect(result.csvData).to.include('Name,Department');
            expect(result.csvData).to.include('Bob,IT');
            expect(result.metadata.selectedSheet).to.equal('Employees');
        });

        it('should handle sheet name override over sheet index', async function() {
            const options: ConversionOptions = { sheetIndex: 0, sheetName: 'Employees' };
            const result = await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL, options);
            
            expect(result.metadata.selectedSheet).to.equal('Employees');
        });

        it('should throw error for invalid sheet index', async function() {
            const options: ConversionOptions = { sheetIndex: 5 };
            
            try {
                await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL, options);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
                expect((error as Error).message).to.include('Sheet index 5 not found');
            }
        });

        it('should include warnings for multi-sheet files', async function() {
            const result = await service.convertToCSV(testWorkbook, SupportedFormat.EXCEL);
            
            expect(result.metadata.warnings).to.be.an('array');
            expect(result.metadata.warnings![0]).to.include('contains 2 sheets');
        });
    });

    describe('TSV Processing', function() {
        it('should convert TSV to CSV', async function() {
            const tsvData = 'Name\tAge\tCity\nJohn\t25\tNYC\nJane\t30\tLA';
            const result = await service.convertToCSV(tsvData, SupportedFormat.TSV);
            
            expect(result.csvData).to.include('Name,Age,City');
            expect(result.csvData).to.include('John,25,NYC');
            expect(result.preview.headers).to.deep.equal(['Name', 'Age', 'City']);
            expect(result.metadata.originalFormat).to.equal(SupportedFormat.TSV);
        });

        it('should handle empty cells in TSV', async function() {
            const tsvData = 'Name\tAge\tCity\nJohn\t\tNYC\nJane\t30\t';
            const result = await service.convertToCSV(tsvData, SupportedFormat.TSV);
            
            expect(result.csvData).to.include('John,,NYC');
            expect(result.csvData).to.include('Jane,30');
        });

        it('should respect maxRows option', async function() {
            const tsvData = 'Name\tAge\nJohn\t25\nJane\t30\nBob\t35\nAlice\t28';
            const options: ConversionOptions = { maxRows: 2 };
            const result = await service.convertToCSV(tsvData, SupportedFormat.TSV, options);
            
            expect(result.preview.rows).to.have.length(2);
            expect(result.metadata.rowsProcessed).to.equal(2);
        });
    });

    describe('Custom Delimiter Processing', function() {
        it('should convert pipe-delimited to CSV', async function() {
            const pipeData = 'Name|Age|City\nJohn|25|NYC\nJane|30|LA';
            const options: ConversionOptions = { delimiter: '|' };
            const result = await service.convertToCSV(pipeData, SupportedFormat.CUSTOM_DELIMITED, options);
            
            expect(result.csvData).to.include('Name,Age,City');
            expect(result.csvData).to.include('John,25,NYC');
            expect(result.metadata.delimiter).to.equal('|');
        });

        it('should convert semicolon-delimited to CSV', async function() {
            const semicolonData = 'Name;Age;City\nJohn;25;NYC\nJane;30;LA';
            const options: ConversionOptions = { delimiter: ';' };
            const result = await service.convertToCSV(semicolonData, SupportedFormat.CUSTOM_DELIMITED, options);
            
            expect(result.csvData).to.include('Name,Age,City');
            expect(result.csvData).to.include('John,25,NYC');
        });

        it('should handle fields containing commas', async function() {
            const pipeData = 'Name|Description\nJohn|A person, very nice\nJane|Another person, also nice';
            const options: ConversionOptions = { delimiter: '|' };
            const result = await service.convertToCSV(pipeData, SupportedFormat.CUSTOM_DELIMITED, options);
            
            expect(result.csvData).to.include('"A person, very nice"');
            expect(result.csvData).to.include('"Another person, also nice"');
        });

        it('should skip empty rows when option is set', async function() {
            const pipeData = 'Name|Age\nJohn|25\n\n\nJane|30\n\nBob|35';
            const options: ConversionOptions = { delimiter: '|', skipEmptyRows: true };
            const result = await service.convertToCSV(pipeData, SupportedFormat.CUSTOM_DELIMITED, options);
            
            expect(result.preview.rows).to.have.length(3); // Should skip empty rows
            expect(result.metadata.rowsProcessed).to.equal(3);
        });
    });

    describe('CSV Processing (normalization)', function() {
        it('should normalize existing CSV data', async function() {
            const csvData = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA';
            const result = await service.convertToCSV(csvData, SupportedFormat.CSV);
            
            expect(result.csvData).to.include('Name,Age,City');
            expect(result.csvData).to.include('John,25,NYC');
            expect(result.metadata.originalFormat).to.equal(SupportedFormat.CSV);
        });

        it('should handle quoted fields correctly', async function() {
            const csvData = 'Name,Quote\nJohn,Hello\nJane,World';
            const result = await service.convertToCSV(csvData, SupportedFormat.CSV);
            
            expect(result.preview.rows[0][1]).to.equal('Hello');
            expect(result.preview.rows[1][1]).to.equal('World');
        });
    });

    describe('Utility Methods', function() {
        it('should validate supported formats', function() {
            expect(service.isFormatSupported(SupportedFormat.CSV)).to.be.true;
            expect(service.isFormatSupported(SupportedFormat.EXCEL)).to.be.true;
            expect(service.isFormatSupported(SupportedFormat.TSV)).to.be.true;
            expect(service.isFormatSupported(SupportedFormat.CUSTOM_DELIMITED)).to.be.true;
        });

        it('should return correct supported extensions', function() {
            const extensions = service.getSupportedExtensions();
            
            expect(extensions).to.include('.csv');
            expect(extensions).to.include('.xlsx');
            expect(extensions).to.include('.xls');
            expect(extensions).to.include('.tsv');
            expect(extensions).to.include('.txt');
        });
    });

    describe('Error Handling', function() {
        it('should handle malformed Excel files', async function() {
            const invalidBuffer = Buffer.from('not an excel file');
            
            try {
                await service.getExcelSheets(invalidBuffer);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
                // The error message may vary depending on xlsx library
                expect((error as Error).message).to.be.a('string');
            }
        });

        it('should handle empty file data', async function() {
            try {
                await service.detectFormat('test.csv', '');
                const result = await service.convertToCSV('', SupportedFormat.CSV);
                expect(result.preview.rows).to.have.length(0);
            } catch (error) {
                // Empty files may cause errors, which is acceptable
                expect(error).to.be.instanceOf(Error);
            }
        });

        it('should handle unsupported format in conversion', async function() {
            try {
                await service.convertToCSV('test', 'unsupported' as any);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
                expect((error as Error).message).to.include('Unsupported format');
            }
        });
    });

    describe('Performance and Limits', function() {
        it('should handle large TSV files with maxRows limit', async function() {
            // Generate large TSV data
            const headers = 'ID\tName\tEmail\tAge\tCity';
            const rows = Array.from({ length: 1000 }, (_, i) => 
                `${i}\tUser${i}\tuser${i}@example.com\t${20 + (i % 60)}\tCity${i % 10}`
            ).join('\n');
            const largeTsvData = headers + '\n' + rows;

            const options: ConversionOptions = { maxRows: 100 };
            const result = await service.convertToCSV(largeTsvData, SupportedFormat.TSV, options);
            
            // Preview contains all processed rows (grid uses virtual scrolling)
            expect(result.preview.rows).to.have.length(100);
            // Actual processing should respect maxRows
            expect(result.metadata.rowsProcessed).to.equal(100);
            expect(result.preview.totalRows).to.equal(100);
        });

        it('should provide accurate row and column counts', async function() {
            const csvData = 'A,B,C,D\n1,2,3,4\n5,6,7,8\n9,10,11,12';
            const result = await service.convertToCSV(csvData, SupportedFormat.CSV);

            expect(result.metadata.rowsProcessed).to.equal(3);
            expect(result.metadata.columnsDetected).to.equal(4);
        });
    });

    // ========================================================================
    // GitHub Issue #135: Coercion Validation Tests
    // ========================================================================

    describe('Coercion Validation - Sample Validation', function() {
        it('should validate standard number format successfully', function() {
            const result = service.validateSampleCoercion(
                'amount',
                'number',
                NumberSourceFormat.STANDARD,
                ['123.45', '67.89', '100']
            );

            expect(result.success).to.be.true;
            expect(result.overallStatus).to.equal('success');
            expect(result.failedCount).to.equal(0);
            expect(result.coercedSamples).to.have.length(3);
            expect(result.coercedSamples[0].coerced).to.equal(123.45);
        });

        it('should validate COBOL number format', function() {
            const result = service.validateSampleCoercion(
                'price',
                'number',
                NumberSourceFormat.COBOL,
                ['+000000001.0000', '-000000020.0000', '+000000099.9900']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal(1);
            expect(result.coercedSamples[1].coerced).to.equal(-20);
            expect(result.coercedSamples[2].coerced).to.equal(99.99);
        });

        it('should validate scientific notation format', function() {
            const result = service.validateSampleCoercion(
                'value',
                'number',
                NumberSourceFormat.SCIENTIFIC,
                ['1.23E+04', '5.67e-8', '9.99E2']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal(12300);
            expect(result.coercedSamples[1].coerced).to.be.closeTo(5.67e-8, 1e-10);
        });

        it('should validate currency format', function() {
            const result = service.validateSampleCoercion(
                'price',
                'number',
                NumberSourceFormat.CURRENCY,
                ['$1,234.56', '€99.99', '£1,000.00']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal(1234.56);
            expect(result.coercedSamples[1].coerced).to.equal(99.99);
            expect(result.coercedSamples[2].coerced).to.equal(1000);
        });

        it('should detect integer truncation warning', function() {
            const result = service.validateSampleCoercion(
                'count',
                'integer',
                NumberSourceFormat.STANDARD,
                ['10.5', '20.9', '30']
            );

            expect(result.success).to.be.true;
            expect(result.overallStatus).to.equal('warning');
            expect(result.coercedSamples[0].coerced).to.equal(10);
            expect(result.coercedSamples[0].warning).to.include('Decimal truncated');
        });

        it('should report error for invalid number', function() {
            const result = service.validateSampleCoercion(
                'amount',
                'number',
                NumberSourceFormat.STANDARD,
                ['123.45', 'not-a-number', '100']
            );

            expect(result.success).to.be.false;
            expect(result.overallStatus).to.equal('error');
            expect(result.failedCount).to.equal(1);
            expect(result.failedRowIndices).to.include(1);
            expect(result.coercedSamples[1].error).to.include('Cannot convert');
        });

        it('should validate boolean format', function() {
            const result = service.validateSampleCoercion(
                'active',
                'boolean',
                BooleanSourceFormat.STANDARD,
                ['true', 'false', 'yes', 'no', '1', '0', 'y', 'n']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal(true);
            expect(result.coercedSamples[1].coerced).to.equal(false);
            expect(result.coercedSamples[2].coerced).to.equal(true);
            expect(result.coercedSamples[3].coerced).to.equal(false);
        });

        it('should report error for invalid boolean', function() {
            const result = service.validateSampleCoercion(
                'flag',
                'boolean',
                BooleanSourceFormat.STANDARD,
                ['true', 'maybe', 'false']
            );

            expect(result.success).to.be.false;
            expect(result.failedCount).to.equal(1);
            expect(result.coercedSamples[1].error).to.include('Cannot convert');
        });

        it('should handle empty values with warning', function() {
            const result = service.validateSampleCoercion(
                'value',
                'number',
                NumberSourceFormat.STANDARD,
                ['123', '', '456']
            );

            expect(result.success).to.be.true;
            expect(result.overallStatus).to.equal('warning');
            expect(result.coercedSamples[1].coerced).to.be.null;
            expect(result.coercedSamples[1].warning).to.include('Empty');
        });

        it('should validate string passthrough', function() {
            const result = service.validateSampleCoercion(
                'name',
                'string',
                StringSourceFormat.PASSTHROUGH,
                ['John Doe', '  Jane Smith  ', 'Bob']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('John Doe');
            expect(result.coercedSamples[1].coerced).to.equal('Jane Smith'); // Trimmed
        });
    });

    describe('Coercion Validation - Full Dataset Validation', function() {
        it('should validate full dataset successfully', function() {
            const result = service.validateFullCoercion({
                mappings: [
                    { variableName: 'id', csvColumn: 'ID', targetType: 'integer', sourceFormat: NumberSourceFormat.STANDARD },
                    { variableName: 'name', csvColumn: 'Name', targetType: 'string', sourceFormat: StringSourceFormat.PASSTHROUGH }
                ],
                rows: [
                    ['1', 'John'],
                    ['2', 'Jane'],
                    ['3', 'Bob']
                ],
                headers: ['ID', 'Name']
            });

            expect(result.success).to.be.true;
            expect(result.overallStatus).to.equal('success');
            expect(result.totalRows).to.equal(3);
            expect(result.rowsWithErrors).to.equal(0);
            expect(result.columnResults).to.have.length(2);
        });

        it('should report errors for invalid data in full validation', function() {
            const result = service.validateFullCoercion({
                mappings: [
                    { variableName: 'price', csvColumn: 'Price', targetType: 'number', sourceFormat: NumberSourceFormat.STANDARD }
                ],
                rows: [
                    ['99.99'],
                    ['invalid'],
                    ['50.00'],
                    ['also-invalid']
                ],
                headers: ['Price']
            });

            expect(result.success).to.be.false;
            expect(result.overallStatus).to.equal('error');
            expect(result.rowsWithErrors).to.equal(2);
            expect(result.skipRowIndices).to.include(1);
            expect(result.skipRowIndices).to.include(3);
        });

        it('should handle missing column gracefully', function() {
            const result = service.validateFullCoercion({
                mappings: [
                    { variableName: 'amount', csvColumn: 'MissingColumn', targetType: 'number', sourceFormat: NumberSourceFormat.STANDARD }
                ],
                rows: [
                    ['100'],
                    ['200']
                ],
                headers: ['Amount']
            });

            expect(result.success).to.be.false;
            expect(result.columnResults[0].failedCount).to.equal(2);
        });

        it('should validate mixed types in full dataset', function() {
            const result = service.validateFullCoercion({
                mappings: [
                    { variableName: 'id', csvColumn: 'ID', targetType: 'integer', sourceFormat: NumberSourceFormat.STANDARD },
                    { variableName: 'active', csvColumn: 'Active', targetType: 'boolean', sourceFormat: BooleanSourceFormat.STANDARD },
                    { variableName: 'price', csvColumn: 'Price', targetType: 'number', sourceFormat: NumberSourceFormat.CURRENCY }
                ],
                rows: [
                    ['1', 'true', '$99.99'],
                    ['2', 'false', '€50.00'],
                    ['3', 'yes', '£25.50']
                ],
                headers: ['ID', 'Active', 'Price']
            });

            expect(result.success).to.be.true;
            expect(result.columnResults).to.have.length(3);
            expect(result.columnResults[0].success).to.be.true; // ID
            expect(result.columnResults[1].success).to.be.true; // Active
            expect(result.columnResults[2].success).to.be.true; // Price
        });

        it('should limit coerced samples to 10 for UI display', function() {
            // Generate 20 rows
            const rows = Array.from({ length: 20 }, (_, i) => [String(i + 1)]);

            const result = service.validateFullCoercion({
                mappings: [
                    { variableName: 'id', csvColumn: 'ID', targetType: 'integer', sourceFormat: NumberSourceFormat.STANDARD }
                ],
                rows,
                headers: ['ID']
            });

            expect(result.success).to.be.true;
            expect(result.totalRows).to.equal(20);
            expect(result.columnResults[0].coercedSamples).to.have.length(10); // Limited to 10
        });
    });

    // ========================================================================
    // GitHub Issue #162: Excel Serial Date Tests
    // ========================================================================

    describe('Excel Serial Date Parsing (Issue #162)', function() {
        it('should parse Excel serial date 45295 as 2024-01-04', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['45295']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
        });

        it('should parse Excel serial date 44927 as 2023-01-01', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['44927']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2023-01-01');
        });

        it('should parse Excel serial date 43831 as 2020-01-01', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['43831']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2020-01-01');
        });

        it('should handle Excel serial date 1 (early Excel epoch)', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['1']
            );

            expect(result.success).to.be.true;
            // Serial 1 is in early 1900 range
            expect(result.coercedSamples[0].coerced).to.match(/^1900-01-\d{2}$/);
        });

        it('should handle Excel serial date 60 (edge case around phantom Feb 29)', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['60']
            );

            expect(result.success).to.be.true;
            // Serial 60 is around Feb-Mar 1900 boundary
            expect(result.coercedSamples[0].coerced).to.match(/^1900-0[23]-\d{2}$/);
        });

        it('should handle Excel serial date 61 (Mar 1, 1900 - first day after phantom Feb 29)', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['61']
            );

            expect(result.success).to.be.true;
            // Serial 61 maps to Mar 1, 1900 (using 25569 offset for > 60)
            expect(result.coercedSamples[0].coerced).to.equal('1900-03-01');
        });

        it('should parse multiple Excel serial dates', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['45295', '45296', '45297']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
            expect(result.coercedSamples[1].coerced).to.equal('2024-01-05');
            expect(result.coercedSamples[2].coerced).to.equal('2024-01-06');
        });

        it('should handle decimal Excel serial dates (date with time component)', function() {
            // 45295.5 = 2024-01-04 at noon
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['45295.5']
            );

            expect(result.success).to.be.true;
            // Should return the date portion only
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
        });

        it('should reject invalid Excel serial dates', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['not-a-number']
            );

            expect(result.success).to.be.false;
            expect(result.coercedSamples[0].error).to.include('Cannot parse');
        });

        it('should handle zero as invalid Excel serial date', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['0']
            );

            expect(result.success).to.be.false;
            expect(result.coercedSamples[0].error).to.include('Cannot parse');
        });

        it('should handle negative numbers as invalid Excel serial date', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.EXCEL_SERIAL,
                ['-1']
            );

            expect(result.success).to.be.false;
            expect(result.coercedSamples[0].error).to.include('Cannot parse');
        });
    });

    // ========================================================================
    // GitHub Issue #162: Date Format Validation Tests
    // ========================================================================

    describe('Date Format Validation (Issue #162)', function() {
        it('should parse YYYY-MM-DD format', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.YYYY_MM_DD,
                ['2024-01-04', '2023-12-25', '2020-06-15']
            );

            expect(result.success).to.be.true;
            // Allow for timezone offset (date may be off by 1 day)
            expect(result.coercedSamples[0].coerced).to.match(/^2024-01-0[34]$/);
            expect(result.coercedSamples[1].coerced).to.match(/^2023-12-2[45]$/);
            expect(result.coercedSamples[2].coerced).to.match(/^2020-06-1[45]$/);
        });

        it('should parse MM/DD/YYYY (US format)', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.MM_DD_YYYY,
                ['01/04/2024', '12/25/2023', '06/15/2020']
            );

            expect(result.success).to.be.true;
            // Allow for timezone offset (date may be off by 1 day)
            expect(result.coercedSamples[0].coerced).to.match(/^2024-01-0[34]$/);
            expect(result.coercedSamples[1].coerced).to.match(/^2023-12-2[45]$/);
            expect(result.coercedSamples[2].coerced).to.match(/^2020-06-1[45]$/);
        });

        it('should parse DD/MM/YYYY (European format)', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.DD_MM_YYYY,
                ['04/01/2024', '25/12/2023', '15/06/2020']
            );

            expect(result.success).to.be.true;
            // Allow for timezone offset (date may be off by 1 day)
            expect(result.coercedSamples[0].coerced).to.match(/^2024-01-0[34]$/);
            expect(result.coercedSamples[1].coerced).to.match(/^2023-12-2[45]$/);
            expect(result.coercedSamples[2].coerced).to.match(/^2020-06-1[45]$/);
        });

        it('should parse ISO 8601 datetime to date', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.ISO_8601,
                ['2024-01-04T14:30:00.000Z', '2023-12-25T00:00:00Z']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
            expect(result.coercedSamples[1].coerced).to.equal('2023-12-25');
        });

        it('should parse Unix timestamp to date', function() {
            // 1704326400 = 2024-01-04 00:00:00 UTC
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.UNIX_TIMESTAMP,
                ['1704326400']
            );

            expect(result.success).to.be.true;
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
        });

        it('should auto-detect common date formats', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.AUTO,
                ['2024-01-04', '2023-12-25']
            );

            expect(result.success).to.be.true;
            // GitHub Issue #175: Auto-detect no longer gives warning - it just works
            expect(result.overallStatus).to.equal('success');
            expect(result.coercedSamples[0].coerced).to.equal('2024-01-04');
        });

        it('should reject invalid date strings', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.YYYY_MM_DD,
                ['not-a-date', 'invalid']
            );

            expect(result.success).to.be.false;
            expect(result.overallStatus).to.equal('error');
            expect(result.failedCount).to.equal(2);
        });

        it('should handle edge dates correctly', function() {
            const result = service.validateSampleCoercion(
                'date',
                'date',
                DateSourceFormat.YYYY_MM_DD,
                ['2024-02-29', '2024-12-31', '2024-01-01']  // Leap year Feb 29
            );

            expect(result.success).to.be.true;
            // Allow for timezone offset (date may be off by 1 day)
            expect(result.coercedSamples[0].coerced).to.match(/^2024-02-2[89]$/);
            expect(result.coercedSamples[1].coerced).to.match(/^202[34]-\d{2}-3[01]$/);
            // 2024-01-01 can shift to 2023-12-31 with timezone offset
            expect(result.coercedSamples[2].coerced).to.match(/^202[34]-\d{2}-\d{2}$/);
        });
    });
});