// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for top-level JSON array detection and processing (GitHub Issue #220)
 *
 * When a JSON template is a top-level array `[{...}]`, the array repetition logic
 * must detect and process it using the `$root` sentinel path.
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { TemplateParser, ROOT_ARRAY_PATH } from '../../../data-loading/template-parser';

describe('JsonGenerator - Top-Level Array Support (GitHub Issue #220)', () => {
    let jsonGenerator: JsonGenerator;
    let templateParser: TemplateParser;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
        templateParser = new TemplateParser();
    });

    describe('ROOT_ARRAY_PATH constant', () => {
        it('should be exported as $root', () => {
            expect(ROOT_ARRAY_PATH).to.equal('$root');
        });
    });

    describe('detectArrays - top-level array detection', () => {
        it('should return $root path for top-level array template', () => {
            const template = JSON.stringify([
                { gtin: '{{gtin}}', sku: '{{sku}}' }
            ]);

            const arrays = templateParser.detectArrays(template);

            expect(arrays.length).to.be.greaterThan(0);
            expect(arrays[0].path).to.equal('$root');
            expect(arrays[0].isRepeatable).to.be.true;
            expect(arrays[0].elementCount).to.equal(1);
        });

        it('should still detect nested arrays within top-level array', () => {
            const template = JSON.stringify([
                { name: '{{name}}', items: [{ sku: '{{sku}}' }] }
            ]);

            const arrays = templateParser.detectArrays(template);

            // Should have $root and $root[].items
            const rootArray = arrays.find(a => a.path === '$root');
            expect(rootArray).to.not.be.undefined;
        });

        it('should not use $root for object-wrapped arrays', () => {
            const template = JSON.stringify({
                data: [{ gtin: '{{gtin}}' }]
            });

            const arrays = templateParser.detectArrays(template);

            expect(arrays[0].path).to.equal('data');
            expect(arrays[0].path).to.not.equal('$root');
        });
    });

    describe('analyzeNestedArrays - top-level array', () => {
        it('should return hasNestedArrays=false for top-level array', () => {
            const template = JSON.stringify([
                { gtin: '{{gtin}}', sku: '{{sku}}' }
            ]);

            const analysis = (jsonGenerator as any).analyzeNestedArrays(template);

            expect(analysis.hasNestedArrays).to.be.false;
        });
    });

    describe('extractArrayItemTemplate - $root path', () => {
        it('should return first element for $root path', () => {
            const template = JSON.stringify([
                { gtin: '{{gtin}}', sku: '{{sku}}' }
            ]);

            const itemTemplate = (jsonGenerator as any).extractArrayItemTemplate(template, ROOT_ARRAY_PATH);

            const parsed = JSON.parse(itemTemplate);
            expect(parsed).to.have.property('gtin', '{{gtin}}');
            expect(parsed).to.have.property('sku', '{{sku}}');
        });

        it('should throw for empty top-level array', () => {
            const template = JSON.stringify([]);

            expect(() => {
                (jsonGenerator as any).extractArrayItemTemplate(template, ROOT_ARRAY_PATH);
            }).to.throw('Top-level array template is empty or not an array');
        });

        it('should throw for non-array template with $root path', () => {
            const template = JSON.stringify({ data: 'value' });

            expect(() => {
                (jsonGenerator as any).extractArrayItemTemplate(template, ROOT_ARRAY_PATH);
            }).to.throw('Top-level array template is empty or not an array');
        });
    });

    describe('buildArrayJson - $root path', () => {
        it('should return arrayItems directly for $root path', () => {
            const arrayItems = [
                { gtin: '1234', sku: 'A' },
                { gtin: '5678', sku: 'B' }
            ];

            const result = (jsonGenerator as any).buildArrayJson('[]', ROOT_ARRAY_PATH, arrayItems);

            expect(result).to.deep.equal(arrayItems);
            expect(Array.isArray(result)).to.be.true;
        });

        it('should still wrap items in object for non-$root path', () => {
            const template = JSON.stringify({ data: [{ placeholder: true }] });
            const arrayItems = [{ gtin: '1234' }, { gtin: '5678' }];

            const result = (jsonGenerator as any).buildArrayJson(template, 'data', arrayItems);

            expect(result).to.have.property('data');
            expect(result.data).to.deep.equal(arrayItems);
        });
    });

    describe('generateConsolidatedJson - end-to-end with top-level array', () => {
        it('should produce correct array output from CSV rows', async () => {
            const template = JSON.stringify([
                { gtin: '{{gtin}}', sku: '{{sku}}' }
            ]);

            const options = {
                template,
                mappings: [
                    { variable: 'gtin', column: 'gtin', dataType: 'string' },
                    { variable: 'sku', column: 'sku', dataType: 'string' }
                ],
                headers: ['gtin', 'sku'],
                repeatableArrays: [
                    { arrayPath: '$root', enabled: true, maxRepetitions: 10 }
                ],
                endpointId: 'test-endpoint'
            };

            const csvRows = [
                'G001,SKU-A',
                'G002,SKU-B',
                'G003,SKU-C'
            ];

            const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

            expect(result.success).to.be.true;
            expect(result.metadata.isConsolidated).to.be.true;
            expect(result.metadata.arrayRepetitionUsed).to.be.true;
            expect(result.metadata.rowsProcessed).to.equal(3);

            // The result should be a plain array, not wrapped in an object
            const jsonData = result.jsonData;
            expect(Array.isArray(jsonData)).to.be.true;
            expect(jsonData).to.have.length(3);
            expect(jsonData[0]).to.have.property('gtin', 'G001');
            expect(jsonData[0]).to.have.property('sku', 'SKU-A');
            expect(jsonData[2]).to.have.property('gtin', 'G003');
            expect(jsonData[2]).to.have.property('sku', 'SKU-C');
        });

        it('should handle number types in top-level array', async () => {
            const template = JSON.stringify([
                { qty: '{{qty:number}}', name: '{{name}}' }
            ]);

            const options = {
                template,
                mappings: [
                    { variable: 'qty', column: 'qty', dataType: 'number' },
                    { variable: 'name', column: 'name', dataType: 'string' }
                ],
                headers: ['qty', 'name'],
                repeatableArrays: [
                    { arrayPath: '$root', enabled: true, maxRepetitions: 10 }
                ],
                endpointId: 'test-endpoint'
            };

            const csvRows = [
                '5,Widget',
                '10,Gadget'
            ];

            const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

            expect(result.success).to.be.true;
            const jsonData = result.jsonData;
            expect(Array.isArray(jsonData)).to.be.true;
            expect(jsonData[0]).to.have.property('qty', 5);
            expect(jsonData[1]).to.have.property('qty', 10);
        });
    });

    describe('generateBatchJsonFiles - chunking with top-level array', () => {
        it('should chunk correctly with top-level array', async () => {
            const template = JSON.stringify([
                { gtin: '{{gtin}}' }
            ]);

            const options = {
                template,
                mappings: [
                    { variable: 'gtin', column: 'gtin', dataType: 'string' }
                ],
                headers: ['gtin'],
                repeatableArrays: [
                    { arrayPath: '$root', enabled: true, maxRepetitions: 2 }
                ],
                endpointId: 'test-endpoint'
            };

            const csvData = 'gtin\nG001\nG002\nG003\nG004\nG005';

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // 5 rows with maxRepetitions=2 should produce 3 files: [2, 2, 1]
            expect(result.files).to.have.length(3);

            // First batch should have 2 items
            const batch1 = result.files[0].content;
            expect(Array.isArray(batch1)).to.be.true;
            expect(batch1).to.have.length(2);

            // Last batch should have 1 item
            const batch3 = result.files[2].content;
            expect(Array.isArray(batch3)).to.be.true;
            expect(batch3).to.have.length(1);
        });
    });
});
