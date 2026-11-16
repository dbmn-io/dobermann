// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Tests for multiple {{}} shorthand patterns in nested JSON templates
 *
 * Issue: Templates with multiple {{}} shorthand patterns fail to generate JSON,
 * while templates with only one {{}} pattern work correctly.
 *
 * Working template:
 *   "po": "{{}}",
 *   "store": "{{location}}"
 *
 * Failing template:
 *   "po": "{{}}",
 *   "store": "{{}}"
 */

import { expect } from 'chai';
import { extractVariablesFromJsonTemplate } from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('Multiple {{}} Shorthand Patterns', () => {
    describe('extractVariablesFromJsonTemplate', () => {
        it('should extract single {{}} shorthand from nested template', () => {
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{location}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.errors).to.have.lengthOf(0);

            // Should have 4 variables: po (inferred), location, item, qty
            expect(result.variables).to.have.lengthOf(4);

            const varNames = result.variables.map(v => v.resolvedName);
            expect(varNames).to.include('po');
            expect(varNames).to.include('location');
            expect(varNames).to.include('item');
            expect(varNames).to.include('qty');

            // po should be inferred from key
            const poVar = result.variables.find(v => v.resolvedName === 'po');
            expect(poVar?.isInferred).to.be.true;
            expect(poVar?.jsonKey).to.equal('po');
        });

        it('should extract multiple {{}} shorthand patterns from nested template', () => {
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.errors).to.have.lengthOf(0);

            // Should have 4 variables: po (inferred), store (inferred), item, qty
            expect(result.variables).to.have.lengthOf(4);

            const varNames = result.variables.map(v => v.resolvedName);
            expect(varNames).to.include('po');
            expect(varNames).to.include('store');
            expect(varNames).to.include('item');
            expect(varNames).to.include('qty');

            // Both po and store should be inferred from their keys
            const poVar = result.variables.find(v => v.resolvedName === 'po');
            expect(poVar?.isInferred).to.be.true;
            expect(poVar?.jsonKey).to.equal('po');

            const storeVar = result.variables.find(v => v.resolvedName === 'store');
            expect(storeVar?.isInferred).to.be.true;
            expect(storeVar?.jsonKey).to.equal('store');
        });

        it('should handle multiple {{}} at same nesting level', () => {
            const template = `{
  "field1": "{{}}",
  "field2": "{{}}",
  "field3": "{{}}"
}`;
            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.errors).to.have.lengthOf(0);

            expect(result.variables).to.have.lengthOf(3);

            const varNames = result.variables.map(v => v.resolvedName);
            expect(varNames).to.include('field1');
            expect(varNames).to.include('field2');
            expect(varNames).to.include('field3');

            // All should be inferred
            for (const v of result.variables) {
                expect(v.isInferred).to.be.true;
            }
        });

        it('should handle {{}} in deeply nested array items', () => {
            const template = `{
  "shipments": [
    {
      "shipmentId": "{{}}",
      "packages": [
        {
          "packageId": "{{}}",
          "items": [
            {
              "itemId": "{{}}",
              "qty": "{{:number}}"
            }
          ]
        }
      ]
    }
  ]
}`;
            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.errors).to.have.lengthOf(0);

            expect(result.variables).to.have.lengthOf(4);

            const varNames = result.variables.map(v => v.resolvedName);
            expect(varNames).to.include('shipmentId');
            expect(varNames).to.include('packageId');
            expect(varNames).to.include('itemId');
            expect(varNames).to.include('qty');
        });
    });

    describe('TemplateParser with multiple {{}} patterns', () => {
        let parser: TemplateParser;

        beforeEach(() => {
            parser = new TemplateParser();
        });

        it('should process template with single {{}} shorthand', async () => {
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{location}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const csvRow = {
                'po': 'PO-001',
                'location': 'STORE-A',
                'item': 'ITEM-123',
                'qty': '5'
            };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.exist;

            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.orders[0].po).to.equal('PO-001');
            expect(parsed.orders[0].store).to.equal('STORE-A');
            expect(parsed.orders[0].items[0].item).to.equal('ITEM-123');
            expect(parsed.orders[0].items[0].qty).to.equal(5);
        });

        it('should process template with multiple {{}} shorthand patterns', async () => {
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const csvRow = {
                'po': 'PO-001',
                'store': 'STORE-A',
                'item': 'ITEM-123',
                'qty': '5'
            };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.exist;

            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.orders[0].po).to.equal('PO-001');
            expect(parsed.orders[0].store).to.equal('STORE-A');
            expect(parsed.orders[0].items[0].item).to.equal('ITEM-123');
            expect(parsed.orders[0].items[0].qty).to.equal(5);
        });

        it('should process simple flat template with multiple {{}} patterns', async () => {
            const template = `{
  "field1": "{{}}",
  "field2": "{{}}",
  "field3": "{{}}"
}`;
            const csvRow = {
                'field1': 'value1',
                'field2': 'value2',
                'field3': 'value3'
            };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            expect(result.processedJson).to.exist;

            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.field1).to.equal('value1');
            expect(parsed.field2).to.equal('value2');
            expect(parsed.field3).to.equal('value3');
        });
    });

    describe('JsonGenerator.analyzeNestedArrays with {{}} shorthand', () => {
        let jsonGenerator: any;

        beforeEach(() => {
            // Create JsonGenerator with minimal mock
            const mockEndpointManager = {
                getEndpoint: () => null,
                updateDataLoadingConfig: () => Promise.resolve()
            };
            jsonGenerator = new JsonGenerator(mockEndpointManager as any);
        });

        it('should identify outer variables with single {{}} and one explicit variable', () => {
            // This template WORKS - one {{}} and one explicit {{location}}
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{location}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const analysis = jsonGenerator.analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(2);
            expect(analysis.outerVariables).to.be.an('array');
            // Should include 'po' (inferred) and 'location' (explicit)
            expect(analysis.outerVariables).to.include('po');
            expect(analysis.outerVariables).to.include('location');
        });

        it('should identify outer variables with multiple {{}} shorthand patterns', () => {
            // This template FAILS - multiple {{}} shorthand patterns
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            const analysis = jsonGenerator.analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(2);
            expect(analysis.outerVariables).to.be.an('array');
            // Should include both 'po' and 'store' (both inferred from keys)
            expect(analysis.outerVariables).to.include('po');
            expect(analysis.outerVariables).to.include('store');
        });

        it('should identify inner variables with {{}} shorthand patterns', () => {
            const template = `{
  "orders": [
    {
      "po": "{{po}}",
      "items": [
        {
          "item": "{{}}",
          "qty": "{{}}"
        }
      ]
    }
  ]
}`;
            const analysis = jsonGenerator.analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.true;
            expect(analysis.nestingLevel).to.equal(2);
            expect(analysis.innerVariables).to.be.an('array');
            // Should include 'item' and 'qty' (both inferred from keys)
            expect(analysis.innerVariables).to.include('item');
            expect(analysis.innerVariables).to.include('qty');
        });
    });

    describe('Mapping translation (template variable -> CSV column)', () => {
        let jsonGenerator: JsonGenerator;

        beforeEach(() => {
            const mockEndpointManager = {
                getEndpoint: () => null,
                updateDataLoadingConfig: () => Promise.resolve()
            };
            jsonGenerator = new JsonGenerator(mockEndpointManager as any);
        });

        it('should generate JSON with mapped columns for 2-level nested arrays', async () => {
            // Template uses lowercase "po" but CSV has uppercase "PO"
            const template = `{
  "orders": [
    {
      "po": "{{}}",
      "store": "{{}}",
      "items": [
        {
          "item": "{{item}}",
          "qty": "{{qty:number}}"
        }
      ]
    }
  ]
}`;
            // CSV with uppercase column names
            const csvData = `PO,Store,item,qty
111,100,A1234,5
111,100,A5678,3
222,200,B1234,10`;

            const options = {
                template,
                mappings: [
                    { variable: 'po', column: 'PO', dataType: 'string' },
                    { variable: 'store', column: 'Store', dataType: 'string' },
                    { variable: 'item', column: 'item', dataType: 'string' },
                    { variable: 'qty', column: 'qty', dataType: 'number' }
                ],
                repeatableArrays: [],
                headers: ['PO', 'Store', 'item', 'qty'],
                endpointId: 'test-endpoint'
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.length.greaterThan(0);

            // Verify the JSON was generated correctly
            const jsonContent = result.files[0].content;
            expect(jsonContent.orders).to.be.an('array');
            expect(jsonContent.orders.length).to.equal(2); // 2 unique PO values: 111, 222

            // First order (PO=111) should have 2 items
            const order1 = jsonContent.orders[0];
            expect(order1.po).to.equal('111');
            expect(order1.store).to.equal('100');
            expect(order1.items).to.have.lengthOf(2);

            // Second order (PO=222) should have 1 item
            const order2 = jsonContent.orders[1];
            expect(order2.po).to.equal('222');
            expect(order2.store).to.equal('200');
            expect(order2.items).to.have.lengthOf(1);
        });

        it('should generate JSON with explicit variable names mapped to different CSV columns', async () => {
            // Template uses "{{purchaseOrder}}" but CSV column is "PO"
            const template = `{
  "orders": [
    {
      "po": "{{purchaseOrder}}",
      "store": "{{location}}",
      "items": [
        {
          "item": "{{sku}}",
          "qty": "{{quantity:number}}"
        }
      ]
    }
  ]
}`;
            const csvData = `PO,Store,SKU,QTY
111,100,A1234,5
111,100,A5678,3`;

            const options = {
                template,
                mappings: [
                    { variable: 'purchaseOrder', column: 'PO', dataType: 'string' },
                    { variable: 'location', column: 'Store', dataType: 'string' },
                    { variable: 'sku', column: 'SKU', dataType: 'string' },
                    { variable: 'quantity', column: 'QTY', dataType: 'number' }
                ],
                repeatableArrays: [],
                headers: ['PO', 'Store', 'SKU', 'QTY'],
                endpointId: 'test-endpoint'
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.length.greaterThan(0);

            const jsonContent = result.files[0].content;
            expect(jsonContent.orders).to.be.an('array');
            expect(jsonContent.orders[0].po).to.equal('111');
            expect(jsonContent.orders[0].store).to.equal('100');
            expect(jsonContent.orders[0].items[0].item).to.equal('A1234');
            expect(jsonContent.orders[0].items[0].qty).to.equal(5);
        });

        it('should handle case-insensitive column matching with shorthand', async () => {
            // Template infers "po" (lowercase) but CSV has "PO" (uppercase)
            const template = `{
  "data": [
    {
      "po": "{{}}"
    }
  ]
}`;
            const csvData = `PO
ABC123
DEF456`;

            const options = {
                template,
                mappings: [
                    { variable: 'po', column: 'PO', dataType: 'string' }
                ],
                repeatableArrays: [{ enabled: true, maxRepetitions: 10, arrayPath: 'data' }],
                headers: ['PO'],
                endpointId: 'test-endpoint'
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.length.greaterThan(0);

            const jsonContent = result.files[0].content;
            expect(jsonContent.data).to.be.an('array');
            expect(jsonContent.data[0].po).to.equal('ABC123');
            expect(jsonContent.data[1].po).to.equal('DEF456');
        });
    });
});
