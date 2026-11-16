// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { TemplateParser } from '../../../data-loading/template-parser';
import { JsonGenerator, JsonGenerationOptions } from '../../../data-loading/json-generator';

/**
 * GitHub Issue #218: Leading Zeros Preservation
 *
 * STRING is the DEFAULT type. ALL data is a string unless the user explicitly
 * specifies a format (number, boolean, date, etc.). Identifiers like GTINs,
 * GLNs, SSCCs, and zip codes must NEVER have leading zeros stripped.
 *
 * These tests enforce the principle: STRING values should never enter
 * numeric conversion pipelines.
 */
describe('GitHub Issue #218: Leading Zeros Preservation', () => {
    let parser: TemplateParser;

    beforeEach(() => {
        parser = new TemplateParser();
    });

    // =========================================================================
    // Core principle: STRING template variables preserve leading zeros
    // =========================================================================

    describe('TemplateParser — STRING variables preserve identifiers', () => {

        it('should preserve GTIN with leading zeros in string variable', async () => {
            const template = '{"gtin": "{{gtin}}"}';
            const csvRow: Record<string, string> = { gtin: '00012345600012' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.gtin).to.equal('00012345600012');
        });

        it('should preserve GLN with leading zeros in string variable', async () => {
            const template = '{"gln": "{{gln}}"}';
            const csvRow: Record<string, string> = { gln: '0614141000012' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.gln).to.equal('0614141000012');
        });

        it('should preserve SSCC with leading zeros', async () => {
            const template = '{"sscc": "{{sscc}}"}';
            const csvRow: Record<string, string> = { sscc: '003456789012345678' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.sscc).to.equal('003456789012345678');
        });

        it('should preserve zip codes with leading zeros', async () => {
            const template = '{"zip": "{{zip}}"}';
            const csvRow: Record<string, string> = { zip: '01234' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.zip).to.equal('01234');
        });

        it('should preserve multiple identifier fields simultaneously', async () => {
            const template = '{"gtin": "{{gtin}}", "gln": "{{gln}}", "zip": "{{zip}}"}';
            const csvRow: Record<string, string> = {
                gtin: '00012345600012',
                gln: '0614141000012',
                zip: '07001'
            };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.gtin).to.equal('00012345600012');
            expect(parsed.gln).to.equal('0614141000012');
            expect(parsed.zip).to.equal('07001');
        });

        it('should preserve "007" as a string (not convert to 7)', async () => {
            const template = '{"code": "{{code}}"}';
            const csvRow: Record<string, string> = { code: '007' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.code).to.equal('007');
        });

        it('should preserve "0001" as a string (not convert to 1)', async () => {
            const template = '{"id": "{{id}}"}';
            const csvRow: Record<string, string> = { id: '0001' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.id).to.equal('0001');
        });
    });

    // =========================================================================
    // Explicit :number type should ALSO preserve leading zeros
    // (user may have typed :number by mistake — we protect identifiers)
    // =========================================================================

    describe('TemplateParser — :number type with leading zeros', () => {

        it('should preserve leading zeros even with explicit :number type', async () => {
            const template = '{"gtin": "{{gtin:number}}"}';
            const csvRow: Record<string, string> = { gtin: '00012345600012' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            // Value should be preserved as string, not converted to number
            const json = result.processedJson!;
            expect(json).to.include('00012345600012');
        });
    });

    // =========================================================================
    // Regression: Normal numbers (no leading zeros) must still convert
    // =========================================================================

    describe('Regression — normal numbers still convert correctly', () => {

        it('should convert normal number with :number type', async () => {
            const template = '{"quantity": "{{quantity:number}}"}';
            const csvRow: Record<string, string> = { quantity: '42' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.quantity).to.equal(42);
        });

        it('should convert decimal with :number type', async () => {
            const template = '{"price": "{{price:number}}"}';
            const csvRow: Record<string, string> = { price: '99.99' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.price).to.equal(99.99);
        });

        it('should handle "0" correctly as number (not a leading zero)', async () => {
            const template = '{"count": "{{count:number}}"}';
            const csvRow: Record<string, string> = { count: '0' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.count).to.equal(0);
        });

        it('should handle "0.5" correctly as number', async () => {
            const template = '{"rate": "{{rate:number}}"}';
            const csvRow: Record<string, string> = { rate: '0.5' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.rate).to.equal(0.5);
        });

        it('should still convert COBOL signed numbers', async () => {
            const template = '{"amount": "{{amount:number}}"}';
            const csvRow: Record<string, string> = { amount: '+000000099.9900' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.amount).to.equal(99.99);
        });

        it('should still convert negative COBOL signed numbers', async () => {
            const template = '{"amount": "{{amount:number}}"}';
            const csvRow: Record<string, string> = { amount: '-000000020.0000' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.amount).to.equal(-20);
        });
    });

    // =========================================================================
    // Mixed scenarios: identifiers alongside real numbers
    // =========================================================================

    describe('Mixed scenarios — identifiers and numbers together', () => {

        it('should preserve GTIN string while converting quantity number', async () => {
            const template = '{"gtin": "{{gtin}}", "quantity": "{{quantity:number}}"}';
            const csvRow: Record<string, string> = {
                gtin: '00012345600012',
                quantity: '42'
            };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.gtin).to.equal('00012345600012');
            expect(parsed.quantity).to.equal(42);
        });

        it('should handle all-zeros identifier "0000000000"', async () => {
            const template = '{"code": "{{code}}"}';
            const csvRow: Record<string, string> = { code: '0000000000' };

            const result = await parser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.code).to.equal('0000000000');
        });
    });

    // =========================================================================
    // JsonGenerator pipeline — source format must NOT convert STRING columns
    // This is where the bug manifests: applyMappings() applies convertSourceFormat()
    // to ALL columns regardless of dataType, stripping leading zeros
    // =========================================================================

    describe('JsonGenerator — STRING mappings must skip source format conversion', () => {
        let generator: JsonGenerator;

        beforeEach(() => {
            generator = new JsonGenerator();
        });

        it('should preserve leading zeros when STRING mapping has sourceFormat=standard', async () => {
            // BUG SCENARIO: A string column has sourceFormat='standard' (stale state)
            // applyMappings() should NOT apply convertSourceFormat for string dataType
            const csvRow = '00012345600012';
            const options: JsonGenerationOptions = {
                template: '{"gtin": "{{gtin}}"}',
                mappings: [{
                    variable: 'gtin',
                    column: 'gtin',
                    dataType: 'string',
                    sourceFormat: 'standard'  // This is the stale/wrong format
                }],
                headers: ['gtin']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.gtin).to.equal('00012345600012');
        });

        it('should preserve leading zeros when STRING mapping has sourceFormat=scientific', async () => {
            const csvRow = '007';
            const options: JsonGenerationOptions = {
                template: '{"code": "{{code}}"}',
                mappings: [{
                    variable: 'code',
                    column: 'code',
                    dataType: 'string',
                    sourceFormat: 'scientific'
                }],
                headers: ['code']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.code).to.equal('007');
        });

        it('should preserve leading zeros when STRING mapping has sourceFormat=currency', async () => {
            const csvRow = '0001234';
            const options: JsonGenerationOptions = {
                template: '{"id": "{{id}}"}',
                mappings: [{
                    variable: 'id',
                    column: 'id',
                    dataType: 'string',
                    sourceFormat: 'currency'
                }],
                headers: ['id']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.id).to.equal('0001234');
        });

        it('should preserve leading zeros when STRING mapping has sourceFormat=cobol', async () => {
            const csvRow = '00012345';
            const options: JsonGenerationOptions = {
                template: '{"sku": "{{sku}}"}',
                mappings: [{
                    variable: 'sku',
                    column: 'sku',
                    dataType: 'string',
                    sourceFormat: 'cobol'
                }],
                headers: ['sku']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.sku).to.equal('00012345');
        });

        it('should still apply source format conversion for NUMBER mappings', async () => {
            // Regression: number-typed columns should still get source format conversion
            const csvRow = '1234.56';
            const options: JsonGenerationOptions = {
                template: '{"price": "{{price:number}}"}',
                mappings: [{
                    variable: 'price',
                    column: 'price',
                    dataType: 'number',
                    sourceFormat: 'standard'
                }],
                headers: ['price']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.price).to.equal(1234.56);
        });

        it('should handle mixed STRING and NUMBER columns correctly', async () => {
            const csvRow = '00012345600012,42';
            const options: JsonGenerationOptions = {
                template: '{"gtin": "{{gtin}}", "quantity": "{{quantity:number}}"}',
                mappings: [
                    {
                        variable: 'gtin',
                        column: 'gtin',
                        dataType: 'string',
                        sourceFormat: 'standard'  // Wrong format, but dataType is string so should be ignored
                    },
                    {
                        variable: 'quantity',
                        column: 'quantity',
                        dataType: 'number',
                        sourceFormat: 'standard'
                    }
                ],
                headers: ['gtin', 'quantity']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.gtin).to.equal('00012345600012');
            expect(result.jsonData.quantity).to.equal(42);
        });

        it('should preserve STRING with passthrough sourceFormat (default)', async () => {
            const csvRow = '00012345600012';
            const options: JsonGenerationOptions = {
                template: '{"gtin": "{{gtin}}"}',
                mappings: [{
                    variable: 'gtin',
                    column: 'gtin',
                    dataType: 'string',
                    sourceFormat: 'passthrough'
                }],
                headers: ['gtin']
            };

            const result = await generator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.gtin).to.equal('00012345600012');
        });
    });
});
