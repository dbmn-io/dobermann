// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #137: Test JSON generation with embedded template variables
 *
 * Tests that variables with prefix, suffix, or both are correctly
 * substituted when generating JSON for preview and execution.
 */

import { expect } from 'chai';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('GitHub Issue #137: JSON Generation with Embedded Variables', () => {

    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        // Create generator with mock endpoint manager
        const mockEndpointManager = {
            getEndpoint: async () => null
        };
        jsonGenerator = new JsonGenerator(mockEndpointManager as any);
    });

    describe('Single Row Generation with Embedded Variables', () => {

        it('should substitute variable with PREFIX: "ACAU-{{SKU}}"', async () => {
            const template = JSON.stringify({
                "ItemId": "ACAU-{{SKU}}"
            });

            const csvRow = 'ABC123';
            const options = {
                template,
                headers: ['SKU'],
                mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.ItemId).to.equal('ACAU-ABC123');
        });

        it('should substitute variable with SUFFIX: "{{SKU}}-SUFFIX"', async () => {
            const template = JSON.stringify({
                "ItemId": "{{SKU}}-SUFFIX"
            });

            const csvRow = 'XYZ789';
            const options = {
                template,
                headers: ['SKU'],
                mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.ItemId).to.equal('XYZ789-SUFFIX');
        });

        it('should substitute variable with PREFIX and SUFFIX: "ACA-{{SW}}-XYZ"', async () => {
            const template = JSON.stringify({
                "Code": "ACA-{{SW}}-XYZ"
            });

            const csvRow = 'MIDDLE';
            const options = {
                template,
                headers: ['SW'],
                mappings: [{ variable: 'SW', column: 'SW', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.Code).to.equal('ACA-MIDDLE-XYZ');
        });

        it('should substitute variable with long numeric prefix', async () => {
            const template = JSON.stringify({
                "OriginalOrderId": "ACAU-ASR376000616616202511051800{{OO_ID}}"
            });

            const csvRow = '999';
            const options = {
                template,
                headers: ['OO_ID'],
                mappings: [{ variable: 'OO_ID', column: 'OO_ID', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.OriginalOrderId).to.equal('ACAU-ASR376000616616202511051800999');
        });

        it('should substitute multiple embedded variables in same string', async () => {
            const template = JSON.stringify({
                "FullCode": "{{PREFIX}}-{{MIDDLE}}-{{SUFFIX}}"
            });

            const csvRow = 'AAA,BBB,CCC';
            const options = {
                template,
                headers: ['PREFIX', 'MIDDLE', 'SUFFIX'],
                mappings: [
                    { variable: 'PREFIX', column: 'PREFIX', dataType: 'string' },
                    { variable: 'MIDDLE', column: 'MIDDLE', dataType: 'string' },
                    { variable: 'SUFFIX', column: 'SUFFIX', dataType: 'string' }
                ]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.FullCode).to.equal('AAA-BBB-CCC');
        });

        it('should handle complex template from Issue #137', async () => {
            const template = JSON.stringify({
                "DestinationFacilityAliasId": "{{STOREID}}",
                "OriginalOrderLine": [
                    {
                        "OrderedQuantity": "{{QTY:number}}",
                        "ItemId": "ACAU-{{SKU}}"
                    }
                ],
                "OriginalOrderId": "ACAU-ASR376{{OO_ID}}"
            });

            const csvRow = 'STORE001,10,ITEM123,ORDER456';
            const options = {
                template,
                headers: ['STOREID', 'QTY', 'SKU', 'OO_ID'],
                mappings: [
                    { variable: 'STOREID', column: 'STOREID', dataType: 'string' },
                    { variable: 'QTY', column: 'QTY', dataType: 'number' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'OO_ID', column: 'OO_ID', dataType: 'string' }
                ]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.DestinationFacilityAliasId).to.equal('STORE001');
            expect(json.OriginalOrderLine[0].ItemId).to.equal('ACAU-ITEM123');
            expect(json.OriginalOrderId).to.equal('ACAU-ASR376ORDER456');
        });

    });

    describe('Nested Array Generation with Embedded Variables', () => {

        it('should substitute embedded variables in nested arrays', async () => {
            const template = JSON.stringify({
                "Orders": [
                    {
                        "OrderId": "ORD-{{ORDER_NUM}}",
                        "Items": [
                            {
                                "ItemCode": "ITEM-{{ITEM_ID}}-V1"
                            }
                        ]
                    }
                ]
            });

            const csvRow = 'O001,I001';
            const options = {
                template,
                headers: ['ORDER_NUM', 'ITEM_ID'],
                mappings: [
                    { variable: 'ORDER_NUM', column: 'ORDER_NUM', dataType: 'string' },
                    { variable: 'ITEM_ID', column: 'ITEM_ID', dataType: 'string' }
                ]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            expect(json.Orders[0].OrderId).to.equal('ORD-O001');
            expect(json.Orders[0].Items[0].ItemCode).to.equal('ITEM-I001-V1');
        });

    });

    describe('Edge Cases in Generation', () => {

        it('should handle empty value for embedded variable', async () => {
            const template = JSON.stringify({
                "Code": "PREFIX-{{VAR}}-SUFFIX"
            });

            const csvRow = '';
            const options = {
                template,
                headers: ['VAR'],
                mappings: [{ variable: 'VAR', column: 'VAR', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            // Should result in "PREFIX--SUFFIX" with empty middle
            expect(json.Code).to.equal('PREFIX--SUFFIX');
        });

        it('should handle special characters in substituted value', async () => {
            const template = JSON.stringify({
                "Code": "PREFIX-{{VAR}}-SUFFIX"
            });

            const csvRow = 'value/with\\special"chars';
            const options = {
                template,
                headers: ['VAR'],
                mappings: [{ variable: 'VAR', column: 'VAR', dataType: 'string' }]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            // CSV parser strips double quotes, so the value becomes value/with\specialchars
            expect(result.jsonData.Code).to.equal('PREFIX-value/with\\specialchars-SUFFIX');
        });

        it('should preserve numeric types when variable is standalone', async () => {
            const template = JSON.stringify({
                "Quantity": "{{QTY:number}}",
                "Code": "PREFIX-{{QTY}}"
            });

            const csvRow = '42,42';
            const options = {
                template,
                headers: ['QTY', 'QTY2'],
                mappings: [
                    { variable: 'QTY', column: 'QTY', dataType: 'number' }
                ]
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            const json = typeof result.jsonData === 'string'
                ? JSON.parse(result.jsonData)
                : result.jsonData;

            // Standalone number should be numeric
            expect(json.Quantity).to.equal(42);
            // Embedded in string should remain string
            expect(json.Code).to.equal('PREFIX-42');
        });

    });

});
