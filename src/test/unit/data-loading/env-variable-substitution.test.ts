// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for ENV variable substitution (GitHub Issue #165)
 *
 * Tests {{ENV:varName}} pattern substitution across all template processing paths:
 * - Flat templates (single row)
 * - Nested array templates (2-level, 3-level)
 * - Root-level properties
 * - Outer array properties
 * - Inner array properties
 *
 * TDD: These tests define expected behavior. Some will FAIL until refactor is complete.
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { extractVariablesFromJsonTemplate } from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';

describe('ENV Variable Substitution (GitHub Issue #165)', () => {
    let jsonGenerator: JsonGenerator;
    let templateParser: TemplateParser;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
        templateParser = new TemplateParser();
    });

    describe('ENV Variable Detection', () => {
        it('should detect ENV variable in template', () => {
            const template = '{"org": "{{ENV:org}}", "name": "{{itemName}}"}';
            const result = extractVariablesFromJsonTemplate(template);

            expect(result.variables).to.have.length(2);

            const envVar = result.variables.find(v => v.resolvedName === 'ENV:org');
            expect(envVar).to.not.be.undefined;
            expect(envVar?.isEnvVariable).to.be.true;
            expect(envVar?.envVariableName).to.equal('org');

            const regularVar = result.variables.find(v => v.resolvedName === 'itemName');
            expect(regularVar).to.not.be.undefined;
            expect(regularVar?.isEnvVariable).to.be.false;
        });

        it('should detect multiple ENV variables', () => {
            const template = '{"org": "{{ENV:org}}", "host": "{{ENV:host}}", "item": "{{SKU}}"}';
            const result = extractVariablesFromJsonTemplate(template);

            const envVars = result.variables.filter(v => v.isEnvVariable);
            expect(envVars).to.have.length(2);
            expect(envVars.map(v => v.envVariableName)).to.include.members(['org', 'host']);
        });

        it('should handle ENV variable with various name formats', () => {
            const template = '{"a": "{{ENV:myVar}}", "b": "{{ENV:MY_VAR}}", "c": "{{ENV:my-var}}"}';
            const result = extractVariablesFromJsonTemplate(template);

            const envVars = result.variables.filter(v => v.isEnvVariable);
            expect(envVars).to.have.length(3);
        });
    });

    describe('Flat Template - ENV Substitution', () => {
        it('should substitute ENV variable in simple flat template', async () => {
            const template = '{"organization": "{{ENV:org}}", "item": "{{SKU}}"}';
            const csvRow = 'SKU1';
            const options = {
                template,
                mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }],
                headers: ['SKU'],
                environmentVariables: { org: '840-DEV' }
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.organization).to.equal('840-DEV');
            expect(result.jsonData.item).to.equal('SKU1');
        });

        it('should substitute multiple ENV variables in flat template', async () => {
            const template = '{"org": "{{ENV:org}}", "host": "{{ENV:host}}", "sku": "{{SKU}}"}';
            const csvRow = 'ABC123';
            const options = {
                template,
                mappings: [{ variable: 'SKU', column: 'SKU', dataType: 'string' }],
                headers: ['SKU'],
                environmentVariables: { org: '840-DEV', host: 'DBMN' }
            };

            const result = await jsonGenerator.generateSingleRowJson(csvRow, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.org).to.equal('840-DEV');
            expect(result.jsonData.host).to.equal('DBMN');
            expect(result.jsonData.sku).to.equal('ABC123');
        });
    });

    describe('Nested Template - Root Level ENV Substitution', () => {
        it('should substitute ENV variable at root level of nested template', async () => {
            // Template with ENV at root level, outside the array
            const template = JSON.stringify({
                organization: '{{ENV:org}}',
                orders: [{
                    orderId: '{{OrderID}}',
                    items: [{ sku: '{{SKU}}', qty: '{{Qty:number}}' }]
                }]
            });

            // CSV with grouped data
            const csvGroups = [
                [
                    ['OrderID', 'SKU', 'Qty'],
                    ['ORD001', 'ABC', '10'],
                    ['ORD001', 'DEF', '20']
                ]
            ];

            const options = {
                template,
                mappings: [
                    { variable: 'OrderID', column: 'OrderID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'number' }
                ],
                headers: ['OrderID', 'SKU', 'Qty'],
                environmentVariables: { org: '840-DEV' }
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            // ROOT LEVEL ENV should be substituted
            expect(result.jsonData.organization).to.equal('840-DEV');
            expect(result.jsonData.orders).to.have.length(1);
        });
    });

    describe('Nested Template - Outer Array Level ENV Substitution', () => {
        it('should substitute ENV variable in outer array element', async () => {
            const template = JSON.stringify({
                orders: [{
                    orderId: '{{OrderID}}',
                    org: '{{ENV:org}}',  // ENV at outer array level
                    items: [{ sku: '{{SKU}}', qty: '{{Qty:number}}' }]
                }]
            });

            const csvGroups = [
                [
                    ['OrderID', 'SKU', 'Qty'],
                    ['ORD001', 'ABC', '10'],
                    ['ORD001', 'DEF', '20']
                ]
            ];

            const options = {
                template,
                mappings: [
                    { variable: 'OrderID', column: 'OrderID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'number' }
                ],
                headers: ['OrderID', 'SKU', 'Qty'],
                environmentVariables: { org: '840-DEV' }
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders[0].org).to.equal('840-DEV');
            expect(result.jsonData.orders[0].orderId).to.equal('ORD001');
        });
    });

    describe('Nested Template - Inner Array Level ENV Substitution', () => {
        it('should substitute ENV variable in inner array items', async () => {
            const template = JSON.stringify({
                orders: [{
                    orderId: '{{OrderID}}',
                    items: [{
                        sku: '{{SKU}}',
                        qty: '{{Qty:number}}',
                        warehouse: '{{ENV:warehouse}}'  // ENV at inner array level
                    }]
                }]
            });

            const csvGroups = [
                [
                    ['OrderID', 'SKU', 'Qty'],
                    ['ORD001', 'ABC', '10'],
                    ['ORD001', 'DEF', '20']
                ]
            ];

            const options = {
                template,
                mappings: [
                    { variable: 'OrderID', column: 'OrderID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'number' }
                ],
                headers: ['OrderID', 'SKU', 'Qty'],
                environmentVariables: { warehouse: 'WH-EAST' }
            };

            const result = await (jsonGenerator as any).generateNestedArrayJson(csvGroups, options);

            expect(result.success).to.be.true;
            expect(result.jsonData.orders[0].items[0].warehouse).to.equal('WH-EAST');
            expect(result.jsonData.orders[0].items[1].warehouse).to.equal('WH-EAST');
        });
    });

    describe('processNestedObject - ENV Variable Handling', () => {
        it('should substitute ENV:varName pattern correctly', async () => {
            const template = { org: '{{ENV:org}}', name: '{{name}}' };
            const mappedData = {
                name: 'Test Item',
                'ENV:org': '840-DEV'  // Injected by applyMappings
            };

            const result = await (jsonGenerator as any).processNestedObject(template, mappedData);

            expect(result.org).to.equal('840-DEV');
            expect(result.name).to.equal('Test Item');
        });

        it('should handle mixed ENV and regular variables', async () => {
            const template = {
                org: '{{ENV:org}}',
                host: '{{ENV:host}}',
                sku: '{{SKU}}',
                qty: '{{Qty:number}}'
            };
            const mappedData = {
                SKU: 'ABC123',
                Qty: '50',
                'ENV:org': '840-DEV',
                'ENV:host': 'DBMN'
            };

            const result = await (jsonGenerator as any).processNestedObject(template, mappedData);

            expect(result.org).to.equal('840-DEV');
            expect(result.host).to.equal('DBMN');
            expect(result.sku).to.equal('ABC123');
            expect(result.qty).to.equal(50);
        });
    });

    describe('applyMappings - ENV Variable Injection', () => {
        it('should inject environment variables with ENV: prefix', () => {
            const rowData = { SKU: 'ABC123', Qty: '10' };
            const mappings = [
                { variable: 'SKU', column: 'SKU', dataType: 'string' },
                { variable: 'Qty', column: 'Qty', dataType: 'string' }
            ];
            const environmentVariables = { org: '840-DEV', host: 'DBMN' };

            const result = (jsonGenerator as any).applyMappings(rowData, mappings, environmentVariables);

            expect(result['ENV:org']).to.equal('840-DEV');
            expect(result['ENV:host']).to.equal('DBMN');
            expect(result.SKU).to.equal('ABC123');
        });

        it('should handle empty environment variables', () => {
            const rowData = { SKU: 'ABC123' };
            const mappings = [{ variable: 'SKU', column: 'SKU', dataType: 'string' }];

            const result = (jsonGenerator as any).applyMappings(rowData, mappings, {});

            expect(result.SKU).to.equal('ABC123');
            expect(Object.keys(result).filter(k => k.startsWith('ENV:'))).to.have.length(0);
        });

        it('should handle undefined environment variables', () => {
            const rowData = { SKU: 'ABC123' };
            const mappings = [{ variable: 'SKU', column: 'SKU', dataType: 'string' }];

            const result = (jsonGenerator as any).applyMappings(rowData, mappings, undefined);

            expect(result.SKU).to.equal('ABC123');
        });
    });

    describe('TemplateParser.processTemplateAsync - ENV Variables', () => {
        it('should substitute ENV variable via processTemplateAsync', async () => {
            const template = '{"org": "{{ENV:org}}", "item": "{{SKU}}"}';
            const csvRow = {
                SKU: 'ABC123',
                'ENV:org': '840-DEV'
            };

            const result = await templateParser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.org).to.equal('840-DEV');
            expect(parsed.item).to.equal('ABC123');
        });

        it('should fail gracefully when ENV variable is missing', async () => {
            const template = '{"org": "{{ENV:org}}", "item": "{{SKU}}"}';
            const csvRow = {
                SKU: 'ABC123'
                // ENV:org is missing
            };

            const result = await templateParser.processTemplateAsync(template, csvRow);

            expect(result.success).to.be.false;
            expect(result.error).to.include('Missing environment variable');
        });
    });

    describe('Complete Workflow - Batch JSON Generation with ENV', () => {
        it('should substitute ENV variables in generateBatchJsonFiles', async () => {
            const template = JSON.stringify({
                organization: '{{ENV:org}}',
                items: [{ sku: '{{SKU}}', qty: '{{Qty:number}}' }]
            });

            const csvContent = 'SKU,Qty\nABC,10\nDEF,20';

            const options = {
                template,
                mappings: [
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'number' }
                ],
                headers: ['SKU', 'Qty'],
                environmentVariables: { org: '840-DEV' },
                repeatableArrays: [{ arrayPath: 'items', enabled: true, maxRepetitions: 10 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvContent, options);

            expect(result.success).to.be.true;
            expect(result.files.length).to.be.greaterThan(0);

            const content = typeof result.files[0].content === 'string'
                ? JSON.parse(result.files[0].content)
                : result.files[0].content;

            expect(content.organization).to.equal('840-DEV');
        });
    });
});
