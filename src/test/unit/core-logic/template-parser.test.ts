// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { 
    TemplateParser, 
    TemplateVariable, 
    ParsedTemplate,
    ArrayInfo
} from '../../../data-loading/template-parser';

describe('TemplateParser', () => {
    let parser: TemplateParser;

    beforeEach(() => {
        parser = new TemplateParser();
    });

    describe('Variable Extraction', () => {
        it('should extract simple variables without data types', () => {
            const template = '{"itemId": "{{SKU}}", "location": "{{BIN_LOCN}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(2);
            
            const skuVar = variables.find(v => v.name === 'SKU');
            expect(skuVar).to.not.be.undefined;
            expect(skuVar?.dataType).to.equal('string');
            expect(skuVar?.hasExplicitType).to.be.false;

            const locationVar = variables.find(v => v.name === 'BIN_LOCN');
            expect(locationVar).to.not.be.undefined;
            expect(locationVar?.dataType).to.equal('string');
        });

        it('should extract variables with explicit data types', () => {
            const template = '{"quantity": "{{QUANTITY:number}}", "active": "{{ACTIVE:boolean}}", "date": "{{LOAD_DATE:date}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(3);

            const quantityVar = variables.find(v => v.name === 'QUANTITY');
            expect(quantityVar?.dataType).to.equal('number');
            expect(quantityVar?.hasExplicitType).to.be.true;

            const activeVar = variables.find(v => v.name === 'ACTIVE');
            expect(activeVar?.dataType).to.equal('boolean');
            expect(activeVar?.hasExplicitType).to.be.true;

            const dateVar = variables.find(v => v.name === 'LOAD_DATE');
            expect(dateVar?.dataType).to.equal('date');
            expect(dateVar?.hasExplicitType).to.be.true;
        });

        it('should handle variables with spaces and special characters', () => {
            const template = '{"field1": "{{SKU WITH SPACES}}", "field2": "{{ITEM-ID}}", "field3": "{{PRICED QTY:number}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(3);
            expect(variables.find(v => v.name === 'SKU WITH SPACES')).to.not.be.undefined;
            expect(variables.find(v => v.name === 'ITEM-ID')).to.not.be.undefined;
            expect(variables.find(v => v.name === 'PRICED QTY')).to.not.be.undefined;
        });

        it('should handle case-sensitive variable names', () => {
            const template = '{"field1": "{{SKU}}", "field2": "{{sku}}", "field3": "{{Sku}}"}';
            const variables = parser.extractVariables(template);

            // With case-sensitive variables, each case variation is distinct
            expect(variables).to.have.length(3);
            const names = variables.map(v => v.name);
            expect(names).to.include.members(['SKU', 'sku', 'Sku']);
            
            // Each should have 1 occurrence
            variables.forEach(v => {
                expect(v.occurrences).to.equal(1);
            });
        });

        it('should handle duplicate variables', () => {
            const template = '{"itemId": "ACAU-{{SKU}}", "description": "Item {{SKU}} details"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(1);
            const skuVar = variables[0];
            expect(skuVar.name).to.equal('SKU');
            expect(skuVar.occurrences).to.equal(2);
        });

        it('should ignore invalid variable formats', () => {
            const template = '{"field1": "{SKU}", "field2": "{{SKU", "field3": "SKU}}", "field4": "{{VALID}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(1);
            expect(variables[0].name).to.equal('VALID');
        });

        it('should handle complex nested JSON structures', () => {
            const template = `{
                "customer": {
                    "name": "{{CUSTOMER_NAME}}",
                    "email": "{{EMAIL:string}}"
                },
                "order": {
                    "items": [
                        {
                            "itemId": "{{SKU}}",
                            "quantity": "{{QUANTITY:number}}",
                            "metadata": {
                                "source": "{{SOURCE}}"
                            }
                        }
                    ]
                }
            }`;
            
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(5);
            expect(variables.map(v => v.name)).to.include.members([
                'CUSTOMER_NAME', 'EMAIL', 'SKU', 'QUANTITY', 'SOURCE'
            ]);
        });
    });

    describe('Array Detection', () => {
        it('should detect simple arrays', () => {
            const template = '{"data": [{"itemId": "{{SKU}}"}]}';
            const arrays = parser.detectArrays(template);

            expect(arrays).to.have.length(1);
            expect(arrays[0].path).to.equal('data');
            expect(arrays[0].isRepeatable).to.be.true;
        });

        it('should detect nested arrays', () => {
            const template = `{
                "orders": [
                    {
                        "orderId": "{{ORDER_ID}}",
                        "items": [
                            {
                                "itemId": "{{SKU}}"
                            }
                        ]
                    }
                ]
            }`;
            
            const arrays = parser.detectArrays(template);

            expect(arrays).to.have.length(2);
            
            const ordersArray = arrays.find(a => a.path === 'orders');
            expect(ordersArray).to.not.be.undefined;
            
            const itemsArray = arrays.find(a => a.path === 'orders[].items');
            expect(itemsArray).to.not.be.undefined;
        });

        it('should detect multiple arrays at same level', () => {
            const template = `{
                "products": [{"name": "{{PRODUCT_NAME}}"}],
                "categories": [{"id": "{{CATEGORY_ID}}"}]
            }`;
            
            const arrays = parser.detectArrays(template);

            expect(arrays).to.have.length(2);
            expect(arrays.map(a => a.path)).to.include.members(['products', 'categories']);
        });

        it('should handle empty arrays', () => {
            const template = '{"data": [], "items": [{"id": "{{ID}}"}]}';
            const arrays = parser.detectArrays(template);

            expect(arrays).to.have.length(2);
            
            const dataArray = arrays.find(a => a.path === 'data');
            expect(dataArray?.isRepeatable).to.be.false; // Empty arrays are not repeatable by default
            
            const itemsArray = arrays.find(a => a.path === 'items');
            expect(itemsArray?.isRepeatable).to.be.true;
        });
    });

    describe('Template Parsing', () => {
        it('should parse complete template with variables and arrays', () => {
            const template = `{
                "data": [
                    {
                        "itemId": "ACAU-{{SKU}}",
                        "quantity": "{{QUANTITY:number}}",
                        "location": "{{LOCATION}}"
                    }
                ],
                "metadata": {
                    "loadDate": "{{LOAD_DATE:date}}"
                }
            }`;

            const parsed = parser.parseTemplate(template);

            expect(parsed.isValid).to.be.true;
            expect(parsed.variables).to.have.length(4);
            expect(parsed.arrays).to.have.length(1);
            expect(parsed.arrays[0].path).to.equal('data');
            
            const variableNames = parsed.variables.map(v => v.name);
            expect(variableNames).to.include.members(['SKU', 'QUANTITY', 'LOCATION', 'LOAD_DATE']);
        });

        it('should handle invalid JSON template', () => {
            const template = '{"invalid": json}';
            const parsed = parser.parseTemplate(template);

            expect(parsed.isValid).to.be.false;
            expect(parsed.error).to.include('Invalid JSON');
            expect(parsed.variables).to.be.empty;
            expect(parsed.arrays).to.be.empty;
        });

        it('should provide validation errors for invalid data types', () => {
            const template = '{"field": "{{VARIABLE:invalidtype}}"}';
            const parsed = parser.parseTemplate(template);

            expect(parsed.isValid).to.be.false;
            expect(parsed.error).to.include('Invalid data type: invalidtype');
        });
    });

    describe('Template Processing', () => {
        it('should replace variables with CSV data', () => {
            const template = '{"itemId": "ACAU-{{SKU}}", "quantity": "{{QUANTITY:number}}"}';
            const csvRow = { 'SKU': 'ABC123', 'QUANTITY': '25' };

            const result = parser.processTemplate(template, csvRow);

            expect(result.success).to.be.true;
            
            const processed = JSON.parse(result.processedJson!);
            expect(processed.itemId).to.equal('ACAU-ABC123');
            expect(processed.quantity).to.equal(25); // Should be converted to number
        });

        it('should handle data type conversions', () => {
            // GitHub Issue #162: date type now outputs YYYYMMDD format by default
            const template = `{
                "stringField": "{{STRING_VAL:string}}",
                "numberField": "{{NUMBER_VAL:number}}",
                "booleanField": "{{BOOLEAN_VAL:boolean}}",
                "dateField": "{{DATE_VAL:date}}"
            }`;

            const csvRow = {
                'STRING_VAL': 'test',
                'NUMBER_VAL': '42.5',
                'BOOLEAN_VAL': 'true',
                'DATE_VAL': '2023-12-25'
            };

            const result = parser.processTemplate(template, csvRow);
            expect(result.success).to.be.true;

            const processed = JSON.parse(result.processedJson!);
            expect(processed.stringField).to.equal('test');
            expect(processed.numberField).to.equal(42.5);
            expect(processed.booleanField).to.equal(true);
            // GitHub Issue #162: :date without modifier now outputs YYYYMMDD
            expect(processed.dateField).to.equal('20231225');
        });

        it('should handle missing CSV columns', () => {
            const template = '{"itemId": "{{SKU}}", "quantity": "{{MISSING_FIELD}}"}';
            const csvRow = { 'SKU': 'ABC123' };

            const result = parser.processTemplate(template, csvRow);

            expect(result.success).to.be.false;
            expect(result.error).to.include('Missing CSV column: MISSING_FIELD');
        });

        it('should handle invalid data type conversions', () => {
            const template = '{"quantity": "{{QUANTITY:number}}"}';
            const csvRow = { 'QUANTITY': 'not-a-number' };

            const result = parser.processTemplate(template, csvRow);

            expect(result.success).to.be.false;
            expect(result.error).to.include('Invalid number value');
        });

        it('should process arrays with repetition', () => {
            const template = `{
                "data": [
                    {
                        "itemId": "{{SKU}}",
                        "quantity": "{{QUANTITY:number}}"
                    }
                ]
            }`;
            
            const csvRow = { 'SKU': 'ABC123', 'QUANTITY': '25' };
            const repeatConfig = { 'data': 3 }; // Repeat data array 3 times

            const result = parser.processTemplate(template, csvRow, repeatConfig);

            expect(result.success).to.be.true;
            
            const processed = JSON.parse(result.processedJson!);
            expect(processed.data).to.have.length(3);
            
            processed.data.forEach((item: any) => {
                expect(item.itemId).to.equal('ABC123');
                expect(item.quantity).to.equal(25);
            });
        });
    });

    describe('Utility Methods', () => {
        it('should suggest data types based on variable names', () => {
            expect(parser.suggestDataType('QUANTITY')).to.equal('number');
            expect(parser.suggestDataType('QTY')).to.equal('number');
            expect(parser.suggestDataType('COUNT')).to.equal('number');
            expect(parser.suggestDataType('AMOUNT')).to.equal('number');
            
            expect(parser.suggestDataType('ACTIVE')).to.equal('boolean');
            expect(parser.suggestDataType('ENABLED')).to.equal('boolean');
            expect(parser.suggestDataType('IS_VALID')).to.equal('boolean');
            expect(parser.suggestDataType('FLAG')).to.equal('boolean');
            
            expect(parser.suggestDataType('DATE')).to.equal('date');
            expect(parser.suggestDataType('LOAD_DATE')).to.equal('date');
            expect(parser.suggestDataType('TIMESTAMP')).to.equal('date');
            expect(parser.suggestDataType('TIME')).to.equal('date');
            
            expect(parser.suggestDataType('SKU')).to.equal('string');
            expect(parser.suggestDataType('NAME')).to.equal('string');
            expect(parser.suggestDataType('UNKNOWN_FIELD')).to.equal('string');
        });

        it('should validate variable names', () => {
            expect(parser.isValidVariableName('SKU')).to.be.true;
            expect(parser.isValidVariableName('ITEM-ID')).to.be.true;
            expect(parser.isValidVariableName('PRICED QTY')).to.be.true;
            expect(parser.isValidVariableName('123INVALID')).to.be.false;
            expect(parser.isValidVariableName('')).to.be.false;
            expect(parser.isValidVariableName('   ')).to.be.false;
        });

        it('should normalize variable names preserving original case', () => {
            expect(parser.normalizeVariableName('SKU')).to.equal('SKU');
            expect(parser.normalizeVariableName('sku')).to.equal('sku');
            expect(parser.normalizeVariableName('Sku')).to.equal('Sku');
            expect(parser.normalizeVariableName('sKu')).to.equal('sKu');
            expect(parser.normalizeVariableName('  LocationId  ')).to.equal('LocationId');
        });
    });

    describe('A8 Variable Support', () => {
        it('should extract A8 sequence variables', () => {
            const template = '{"id": "{{A8:sequence}}", "itemId": "ACAU-{{SKU}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(2);
            
            const sequenceVar = variables.find(v => v.name === 'A8:sequence');
            expect(sequenceVar).to.not.be.undefined;
            expect(sequenceVar?.dataType).to.equal('number');
            expect(sequenceVar?.hasExplicitType).to.be.true;
            expect(sequenceVar?.isA8Variable).to.be.true;

            const skuVar = variables.find(v => v.name === 'SKU');
            expect(skuVar).to.not.be.undefined;
            expect(skuVar?.isA8Variable).to.be.false;
        });

        it('should extract A8 date and datetime variables', () => {
            const template = '{"date": "{{A8:date}}", "timestamp": "{{A8:datetime}}"}';
            const variables = parser.extractVariables(template);

            expect(variables).to.have.length(2);
            
            const dateVar = variables.find(v => v.name === 'A8:date');
            expect(dateVar).to.not.be.undefined;
            expect(dateVar?.dataType).to.equal('string');
            expect(dateVar?.hasExplicitType).to.be.true;
            expect(dateVar?.isA8Variable).to.be.true;

            const datetimeVar = variables.find(v => v.name === 'A8:datetime');
            expect(datetimeVar).to.not.be.undefined;
            expect(datetimeVar?.dataType).to.equal('string');
            expect(datetimeVar?.hasExplicitType).to.be.true;
            expect(datetimeVar?.isA8Variable).to.be.true;
        });

        it('should validate A8 variable names', () => {
            expect(parser.isValidA8Variable('A8:sequence')).to.be.true;
            expect(parser.isValidA8Variable('A8:date')).to.be.true;
            expect(parser.isValidA8Variable('A8:datetime')).to.be.true;
            expect(parser.isValidA8Variable('A8:invalid')).to.be.false;
            expect(parser.isValidA8Variable('SKU')).to.be.false;
            expect(parser.isValidA8Variable('A8:')).to.be.false;
        });

        it('should get required variables for prompt (excluding A8 variables)', () => {
            const template = '{"id": "{{A8:sequence}}", "itemId": "ACAU-{{SKU}}", "date": "{{A8:date}}", "qty": "{{QTY:number}}"}';
            const requiredVars = parser.getRequiredVariablesForPrompt(template);

            expect(requiredVars).to.have.length(2);
            expect(requiredVars.find(v => v.name === 'SKU')).to.not.be.undefined;
            expect(requiredVars.find(v => v.name === 'QTY')).to.not.be.undefined;
            expect(requiredVars.find(v => v.name === 'A8:sequence')).to.be.undefined;
            expect(requiredVars.find(v => v.name === 'A8:date')).to.be.undefined;
        });

        it('should process template with A8 variables', async () => {
            const mockSequenceManager = {
                getNextSequence: async (id: string) => 42
            };

            const template = '{"id": "{{A8:sequence}}", "date": "{{A8:date}}", "timestamp": "{{A8:datetime}}"}';
            const result = await parser.processTemplateAsync(template, {}, undefined, 'test-endpoint', mockSequenceManager);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.not.be.undefined;

            const processed = JSON.parse(result.processedJson!);
            expect(processed.id).to.equal(42);
            expect(processed.date).to.match(/^\d{8}$/); // YYYYMMDD format
            // GitHub Issue #140: Default format is now local (no milliseconds, no Z)
            expect(processed.timestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/); // Local format
        });

        it('should process template with mixed regular and A8 variables', async () => {
            const mockSequenceManager = {
                getNextSequence: async (id: string) => 123
            };

            const template = '{"id": "{{A8:sequence}}", "itemId": "ACAU-{{SKU}}", "date": "{{A8:date}}"}';
            const csvRow = { 'SKU': 'TEST123' };
            const result = await parser.processTemplateAsync(template, csvRow, undefined, 'test-endpoint', mockSequenceManager);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.not.be.undefined;

            const processed = JSON.parse(result.processedJson!);
            expect(processed.id).to.equal(123);
            expect(processed.itemId).to.equal('ACAU-TEST123');
            expect(processed.date).to.match(/^\d{8}$/);
        });

        // GitHub Issue #140: Test datetime format specifiers
        it('should support A8:datetime format specifiers', async () => {
            const mockSequenceManager = {
                getNextSequence: async (id: string) => 1
            };

            const template = JSON.stringify({
                defaultTimestamp: "{{A8:datetime}}",
                isoTimestamp: "{{A8:datetime:iso}}",
                localTimestamp: "{{A8:datetime:local}}",
                dateOnly: "{{A8:datetime:date}}",
                timeOnly: "{{A8:datetime:time}}",
                customFormat: "{{A8:datetime:YYYY-MM-DD}}"
            });

            const result = await parser.processTemplateAsync(template, {}, undefined, 'test-endpoint', mockSequenceManager);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.not.be.undefined;

            const processed = JSON.parse(result.processedJson!);

            // Default format: YYYY-MM-DDTHH:mm:ss (no milliseconds, no Z)
            expect(processed.defaultTimestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

            // ISO format: YYYY-MM-DDTHH:mm:ss.SSSZ
            expect(processed.isoTimestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

            // Local format: same as default
            expect(processed.localTimestamp).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

            // Date only: YYYY-MM-DD
            expect(processed.dateOnly).to.match(/^\d{4}-\d{2}-\d{2}$/);

            // Time only: HH:mm:ss
            expect(processed.timeOnly).to.match(/^\d{2}:\d{2}:\d{2}$/);

            // Custom format: YYYY-MM-DD
            expect(processed.customFormat).to.match(/^\d{4}-\d{2}-\d{2}$/);
        });

        it('should handle template processing with runtime variables', async () => {
            const mockSequenceManager = {
                getNextSequence: async (id: string) => 456
            };

            const template = '{"id": "{{A8:sequence}}", "itemId": "ACAU-{{SKU}}", "quantity": "{{QTY:number}}"}';
            const runtimeVars = { 'SKU': 'RUNTIME123', 'QTY': '50' };
            const result = await parser.processTemplateWithRuntimeVariables(template, runtimeVars, 'test-endpoint', mockSequenceManager);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.not.be.undefined;

            const processed = JSON.parse(result.processedJson!);
            expect(processed.id).to.equal(456);
            expect(processed.itemId).to.equal('ACAU-RUNTIME123');
            expect(processed.quantity).to.equal(50);
        });
    });
});