// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { 
    CSVColumnMapper,
    ColumnMapping,
    MappingType,
    ValidationResult,
    CSVPreview
} from '../../../data-loading/csv-column-mapper';
import { TemplateVariable } from '../../../data-loading/template-parser';

describe('CSVColumnMapper', () => {
    let mapper: CSVColumnMapper;
    let sampleCSVData: string[][];
    let templateVariables: TemplateVariable[];

    beforeEach(() => {
        mapper = new CSVColumnMapper();
        
        sampleCSVData = [
            ['SKU', 'BIN_LOCN', 'PRICED_QTY', 'ACTIVE_FLAG'],
            ['ABC123', 'LOC001', '25', 'true'],
            ['DEF456', 'LOC002', '50', 'false'],
            ['GHI789', 'LOC003', '75', 'true']
        ];

        templateVariables = [
            { name: 'SKU', dataType: 'string', hasExplicitType: false, occurrences: 1 },
            { name: 'BIN_LOCN', dataType: 'string', hasExplicitType: false, occurrences: 1 },
            { name: 'PRICED_QTY', dataType: 'number', hasExplicitType: true, occurrences: 1 },
            { name: 'ACTIVE_FLAG', dataType: 'boolean', hasExplicitType: true, occurrences: 1 }
        ];
    });

    describe('CSV Parsing and Preview', () => {
        it('should parse CSV data and create preview', () => {
            const csvText = 'SKU,BIN_LOCN,PRICED_QTY\nABC123,LOC001,25\nDEF456,LOC002,50';
            const preview = mapper.parseCSVPreview(csvText);

            expect(preview.isValid).to.be.true;
            expect(preview.headers).to.deep.equal(['SKU', 'BIN_LOCN', 'PRICED_QTY']);
            expect(preview.rows).to.have.length(2);
            expect(preview.previewRows).to.have.length(2); // All rows shown for small dataset
            expect(preview.totalRows).to.equal(2);
        });

        it('should limit preview rows to 5', () => {
            const largeCSV = 'SKU,QTY\n' + Array.from({length: 10}, (_, i) => `SKU${i},${i+1}`).join('\n');
            const preview = mapper.parseCSVPreview(largeCSV);

            expect(preview.previewRows).to.have.length(5);
            expect(preview.totalRows).to.equal(10);
        });

        it('should handle CSV with quoted fields', () => {
            const csvText = 'Name,Description\n"John Doe","A person with, comma"\n"Jane Smith","Another person"';
            const preview = mapper.parseCSVPreview(csvText);

            expect(preview.isValid).to.be.true;
            expect(preview.headers).to.deep.equal(['Name', 'Description']);
            expect(preview.rows[0]).to.deep.equal(['John Doe', 'A person with, comma']);
        });

        it('should handle malformed CSV', () => {
            const csvText = 'SKU,QTY\nABC123\nDEF456,50,extra'; // Inconsistent columns
            const preview = mapper.parseCSVPreview(csvText);

            expect(preview.isValid).to.be.false;
            expect(preview.error).to.include('Inconsistent number of columns');
        });

        it('should handle empty CSV', () => {
            const preview = mapper.parseCSVPreview('');

            expect(preview.isValid).to.be.false;
            expect(preview.error).to.include('CSV data is empty');
        });
    });

    describe('Auto-Mapping', () => {
        it('should auto-map exact column name matches', () => {
            const mapping = mapper.createAutoMapping(templateVariables, ['SKU', 'BIN_LOCN', 'PRICED_QTY', 'EXTRA_COL']);

            expect(mapping).to.have.length(4); // 4 template variables
            
            const skuMapping = mapping.find(m => m.variableName === 'SKU');
            expect(skuMapping?.mappingType).to.equal('csvColumn');
            expect(skuMapping?.csvColumn).to.equal('SKU');

            const extraVarMapping = mapping.find(m => m.variableName === 'ACTIVE_FLAG');
            expect(extraVarMapping?.mappingType).to.equal('static');
            expect(extraVarMapping?.csvColumn).to.be.undefined;
        });

        it('should handle case-insensitive column matching', () => {
            const mapping = mapper.createAutoMapping(templateVariables, ['sku', 'bin_locn', 'priced_qty']);

            const skuMapping = mapping.find(m => m.variableName === 'SKU');
            expect(skuMapping?.mappingType).to.equal('csvColumn');
            expect(skuMapping?.csvColumn).to.equal('sku');
        });

        it('should handle similar column name matching', () => {
            const mapping = mapper.createAutoMapping(templateVariables, ['ITEM-SKU', 'LOCATION', 'QUANTITY']);

            const skuMapping = mapping.find(m => m.variableName === 'SKU');
            expect(skuMapping?.mappingType).to.equal('csvColumn');
            expect(skuMapping?.csvColumn).to.equal('ITEM-SKU');

            const locMapping = mapping.find(m => m.variableName === 'BIN_LOCN');
            expect(locMapping?.mappingType).to.equal('csvColumn');
            expect(locMapping?.csvColumn).to.equal('LOCATION');
        });

        it('should create static mappings for unmatched variables', () => {
            const mapping = mapper.createAutoMapping(templateVariables, ['SKU']);

            const unmatchedMapping = mapping.find(m => m.variableName === 'ACTIVE_FLAG');
            expect(unmatchedMapping?.mappingType).to.equal('static');
            expect(unmatchedMapping?.staticValue).to.equal('');
        });
    });

    describe('Manual Mapping Configuration', () => {
        it('should update mapping type and values', () => {
            let mapping: ColumnMapping[] = [
                {
                    variableName: 'SKU',
                    dataType: 'string',
                    mappingType: 'static',
                    staticValue: 'DEFAULT-SKU',
                    isRequired: true
                }
            ];

            mapping = mapper.updateMapping(mapping, 'SKU', 'csvColumn', { csvColumn: 'ITEM_ID' });

            const updated = mapping.find(m => m.variableName === 'SKU');
            expect(updated?.mappingType).to.equal('csvColumn');
            expect(updated?.csvColumn).to.equal('ITEM_ID');
            expect(updated?.staticValue).to.be.undefined;
        });

        it('should handle template mapping configuration', () => {
            let mapping: ColumnMapping[] = [
                {
                    variableName: 'ITEM_ID',
                    dataType: 'string',
                    mappingType: 'static',
                    staticValue: '',
                    isRequired: true
                }
            ];

            mapping = mapper.updateMapping(mapping, 'ITEM_ID', 'template', { 
                templateValue: 'ACAU-{{SKU}}',
                csvColumn: 'SKU'
            });

            const updated = mapping.find(m => m.variableName === 'ITEM_ID');
            expect(updated?.mappingType).to.equal('template');
            expect(updated?.templateValue).to.equal('ACAU-{{SKU}}');
            expect(updated?.csvColumn).to.equal('SKU');
        });

        it('should validate required mappings', () => {
            const mapping: ColumnMapping[] = [
                {
                    variableName: 'SKU',
                    dataType: 'string',
                    mappingType: 'static',
                    staticValue: '',
                    isRequired: true
                }
            ];

            const validation = mapper.validateMapping(mapping, ['OTHER_COLUMN']);

            expect(validation.isValid).to.be.false;
            expect(validation.errors).to.include('Required variable SKU has no value configured');
        });
    });

    describe('Mapping Validation', () => {
        let validMapping: ColumnMapping[];

        beforeEach(() => {
            validMapping = [
                {
                    variableName: 'SKU',
                    dataType: 'string',
                    mappingType: 'csvColumn',
                    csvColumn: 'SKU',
                    isRequired: true
                },
                {
                    variableName: 'QUANTITY',
                    dataType: 'number',
                    mappingType: 'csvColumn',
                    csvColumn: 'PRICED_QTY',
                    isRequired: true
                }
            ];
        });

        it('should validate correct mapping', () => {
            const validation = mapper.validateMapping(validMapping, ['SKU', 'PRICED_QTY']);

            expect(validation.isValid).to.be.true;
            expect(validation.errors).to.be.empty;
            expect(validation.warnings).to.be.empty;
        });

        it('should detect missing CSV columns', () => {
            const validation = mapper.validateMapping(validMapping, ['SKU']); // Missing PRICED_QTY

            expect(validation.isValid).to.be.false;
            expect(validation.errors).to.include('CSV column PRICED_QTY not found in uploaded file');
        });

        it('should warn about unused CSV columns', () => {
            const validation = mapper.validateMapping(validMapping, ['SKU', 'PRICED_QTY', 'EXTRA_COLUMN']);

            expect(validation.isValid).to.be.true;
            expect(validation.warnings).to.include('CSV column EXTRA_COLUMN is not used in mapping');
        });

        it('should validate template syntax', () => {
            const templateMapping: ColumnMapping[] = [
                {
                    variableName: 'ITEM_ID',
                    dataType: 'string',
                    mappingType: 'template',
                    templateValue: 'ACAU-{{INVALID_VAR}}',
                    csvColumn: 'SKU',
                    isRequired: true
                }
            ];

            const validation = mapper.validateMapping(templateMapping, ['SKU']);

            expect(validation.isValid).to.be.false;
            expect(validation.errors).to.include('Template variable INVALID_VAR in ITEM_ID template not found in CSV columns');
        });

        it('should validate data type compatibility', () => {
            const mapping: ColumnMapping[] = [
                {
                    variableName: 'QUANTITY',
                    dataType: 'number',
                    mappingType: 'static',
                    staticValue: 'not-a-number',
                    isRequired: true
                }
            ];

            const validation = mapper.validateMapping(mapping, []);

            expect(validation.isValid).to.be.false;
            expect(validation.errors).to.include('Static value "not-a-number" for QUANTITY is not a valid number');
        });
    });

    describe('Data Type Validation', () => {
        it('should validate CSV data against mapping configuration', () => {
            const mapping: ColumnMapping[] = [
                {
                    variableName: 'SKU',
                    dataType: 'string',
                    mappingType: 'csvColumn',
                    csvColumn: 'SKU',
                    isRequired: true
                },
                {
                    variableName: 'QUANTITY',
                    dataType: 'number',
                    mappingType: 'csvColumn',
                    csvColumn: 'PRICED_QTY',
                    isRequired: true
                }
            ];

            const validation = mapper.validateCSVData(sampleCSVData, mapping);

            expect(validation.isValid).to.be.true;
            expect(validation.validRows).to.equal(3); // 3 data rows
            expect(validation.errorRows).to.equal(0);
        });

        it('should detect invalid data type values', () => {
            const invalidData = [
                ['SKU', 'PRICED_QTY'],
                ['ABC123', '25'],
                ['DEF456', 'invalid-number']
            ];

            const mapping: ColumnMapping[] = [
                {
                    variableName: 'QUANTITY',
                    dataType: 'number',
                    mappingType: 'csvColumn',
                    csvColumn: 'PRICED_QTY',
                    isRequired: true
                }
            ];

            const validation = mapper.validateCSVData(invalidData, mapping);

            expect(validation.isValid).to.be.false;
            expect(validation.errorRows).to.equal(1);
            expect(validation.errors).to.have.length(1);
            expect(validation.errors[0]).to.include('Row 2');
            expect(validation.errors[0]).to.include('Invalid number');
        });

        it('should validate boolean values', () => {
            const booleanData = [
                ['ACTIVE'],
                ['true'],
                ['false'],
                ['yes'],
                ['no'],
                ['maybe'] // Invalid
            ];

            const mapping: ColumnMapping[] = [
                {
                    variableName: 'ACTIVE',
                    dataType: 'boolean',
                    mappingType: 'csvColumn',
                    csvColumn: 'ACTIVE',
                    isRequired: true
                }
            ];

            const validation = mapper.validateCSVData(booleanData, mapping);

            expect(validation.isValid).to.be.false;
            expect(validation.validRows).to.equal(4);
            expect(validation.errorRows).to.equal(1);
        });

        it('should validate date values', () => {
            const dateData = [
                ['LOAD_DATE'],
                ['2023-12-25'],
                ['12/25/2023'],
                ['invalid-date']
            ];

            const mapping: ColumnMapping[] = [
                {
                    variableName: 'LOAD_DATE',
                    dataType: 'date',
                    mappingType: 'csvColumn',
                    csvColumn: 'LOAD_DATE',
                    isRequired: true
                }
            ];

            const validation = mapper.validateCSVData(dateData, mapping);

            expect(validation.isValid).to.be.false;
            expect(validation.validRows).to.equal(2);
            expect(validation.errorRows).to.equal(1);
        });
    });

    describe('Row Processing', () => {
        it('should process CSV row according to mapping configuration', () => {
            const mapping: ColumnMapping[] = [
                {
                    variableName: 'SKU',
                    dataType: 'string',
                    mappingType: 'csvColumn',
                    csvColumn: 'SKU',
                    isRequired: true
                },
                {
                    variableName: 'STATIC_FIELD',
                    dataType: 'string',
                    mappingType: 'static',
                    staticValue: 'FIXED_VALUE',
                    isRequired: false
                },
                {
                    variableName: 'ITEM_ID',
                    dataType: 'string',
                    mappingType: 'template',
                    templateValue: 'ACAU-{{SKU}}',
                    csvColumn: 'SKU',
                    isRequired: true
                }
            ];

            const csvRow = { 'SKU': 'ABC123', 'OTHER': 'unused' };
            const processed = mapper.processCSVRow(csvRow, mapping);

            expect(processed.isValid).to.be.true;
            expect(processed.values['SKU']).to.equal('ABC123');
            expect(processed.values['STATIC_FIELD']).to.equal('FIXED_VALUE');
            expect(processed.values['ITEM_ID']).to.equal('ACAU-ABC123');
        });

        it('should handle missing required columns', () => {
            const mapping: ColumnMapping[] = [
                {
                    variableName: 'REQUIRED_FIELD',
                    dataType: 'string',
                    mappingType: 'csvColumn',
                    csvColumn: 'MISSING_COLUMN',
                    isRequired: true
                }
            ];

            const csvRow = { 'OTHER': 'value' };
            const processed = mapper.processCSVRow(csvRow, mapping);

            expect(processed.isValid).to.be.false;
            expect(processed.error).to.include('Missing required column: MISSING_COLUMN');
        });
    });
});