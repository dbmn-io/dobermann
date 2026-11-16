// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Integration tests for String and Number Modifiers (GitHub Issue #175)
 *
 * Tests the complete flow from template parsing to value conversion
 * for string and number type modifiers.
 *
 * SYNTAX:
 * - Colon (:) after type = FORMAT (dates only)
 * - Pipe (|) after type = MODIFIER (all types)
 *
 * Examples:
 *   {{Name:string|3-50}}         → String with length validation
 *   {{Amount:number|>0|rnd(2)}}  → Number with validation + transform
 *   {{Date:date:iso|+2d}}        → Date with format + modifier
 */

import { expect } from 'chai';
import {
    extractVariablesFromJsonTemplate,
    InferredVariable
} from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';

describe('String and Number Modifiers - Template Integration (GitHub Issue #175)', () => {
    const parser = new TemplateParser();

    describe('JSON Template Parsing with Modifiers', () => {
        describe('String Type with Modifiers', () => {
            it('should parse {{:string|3-50}} (inferred name with length range)', () => {
                const template = `{
                    "ItemName": "{{:string|3-50}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);

                const variable = result.variables[0];
                expect(variable.resolvedName).to.equal('ItemName');
                expect(variable.dataType).to.equal('string');
                expect(variable.formatModifier).to.equal('3-50');
                expect(variable.isInferred).to.be.true;
            });

            it('should parse {{Name:string|3-50|upper}} (explicit name with chained modifiers)', () => {
                const template = `{
                    "ItemCode": "{{Name:string|3-50|upper}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);

                const variable = result.variables[0];
                expect(variable.resolvedName).to.equal('Name');
                expect(variable.dataType).to.equal('string');
                expect(variable.formatModifier).to.equal('3-50|upper');
                expect(variable.isInferred).to.be.false;
            });

            it('should parse {{:string|-10|lower}} (max length and lowercase)', () => {
                const template = `{
                    "Code": "{{:string|-10|lower}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.dataType).to.equal('string');
                expect(variable.formatModifier).to.equal('-10|lower');
            });
        });

        describe('Number Type with Modifiers', () => {
            it('should parse {{:number|>0|rnd(2)}} (validation and rounding)', () => {
                const template = `{
                    "Price": "{{:number|>0|rnd(2)}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.resolvedName).to.equal('Price');
                expect(variable.dataType).to.equal('number');
                expect(variable.formatModifier).to.equal('>0|rnd(2)');
            });

            it('should parse {{Qty:number|int|>0}} (integer and positive)', () => {
                const template = `{
                    "Quantity": "{{Qty:number|int|>0}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.resolvedName).to.equal('Qty');
                expect(variable.dataType).to.equal('number');
                expect(variable.formatModifier).to.equal('int|>0');
            });

            it('should parse {{:number|>=0|<=100}} (range validation)', () => {
                const template = `{
                    "Percentage": "{{:number|>=0|<=100}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.formatModifier).to.equal('>=0|<=100');
            });
        });

        describe('Date/DateTime with Date Math Modifiers', () => {
            it('should parse {{:datetime:iso|+2d}} (format then date math)', () => {
                const template = `{
                    "ShipDate": "{{:datetime:iso|+2d}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.dataType).to.equal('datetime');
                expect(variable.formatModifier).to.equal('iso|+2d');
            });

            it('should parse {{ExpireDate:date|-1d}} (subtract days)', () => {
                const template = `{
                    "Expiry": "{{ExpireDate:date|-1d}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                const variable = result.variables[0];
                expect(variable.dataType).to.equal('date');
                expect(variable.formatModifier).to.equal('-1d');
            });
        });

        describe('Mixed Variables in Template', () => {
            it('should parse template with multiple variables and modifiers', () => {
                const template = `{
                    "Data": [
                        {
                            "ItemId": "ACAU-{{:string|5-50}}",
                            "ItemName": "{{Name:string|3-100|upper}}",
                            "Quantity": "{{Qty:number|int|>0}}",
                            "Price": "{{:number|>=0|rnd(2)}}",
                            "ShipDate": "{{:datetime:iso|+2d}}",
                            "IsActive": "{{:boolean}}",
                            "Seq": "{{A8:sequence}}"
                        }
                    ]
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(7);

                const varMap = new Map(result.variables.map(v => [v.resolvedName, v]));

                // String with length validation (pipe syntax)
                expect(varMap.get('ItemId')!.formatModifier).to.equal('5-50');

                // String with chained modifiers
                expect(varMap.get('Name')!.formatModifier).to.equal('3-100|upper');

                // Number with integer and positive
                expect(varMap.get('Qty')!.formatModifier).to.equal('int|>0');

                // Number with range and rounding
                expect(varMap.get('Price')!.formatModifier).to.equal('>=0|rnd(2)');

                // Datetime with format (colon) + date math modifier (pipe)
                expect(varMap.get('ShipDate')!.formatModifier).to.equal('iso|+2d');

                // Boolean without modifiers
                expect(varMap.get('IsActive')!.dataType).to.equal('boolean');
                expect(varMap.get('IsActive')!.formatModifier).to.be.undefined;

                // A8 variable
                expect(varMap.get('A8:sequence')!.isA8Variable).to.be.true;
            });
        });
    });

    describe('TemplateParser.parseTemplate with Modifiers', () => {
        it('should parse template with string modifiers (pipe syntax)', () => {
            const template = `{
                "Name": "{{ItemName:string|3-50}}"
            }`;

            const result = parser.parseTemplate(template);

            expect(result.isValid).to.be.true;
            expect(result.variables).to.have.length(1);
            expect(result.variables[0].name).to.equal('ItemName');
            expect(result.variables[0].dataType).to.equal('string');
            expect(result.variables[0].formatModifier).to.equal('3-50');
        });

        it('should parse template with number modifiers (pipe syntax)', () => {
            const template = `{
                "Price": "{{Amount:number|>0|rnd(2)}}"
            }`;

            const result = parser.parseTemplate(template);

            expect(result.isValid).to.be.true;
            expect(result.variables[0].formatModifier).to.equal('>0|rnd(2)');
        });
    });

    describe('Template Processing with Modifiers (Sync)', () => {
        it('should apply string trim by default', () => {
            const template = `{
                "Name": "{{ItemName:string}}"
            }`;

            const result = parser.processTemplate(template, {
                'ItemName': '  Test Item  '
            });

            expect(result.success).to.be.true;
            expect(result.processedJson).to.include('"Test Item"');
        });

        it('should apply string upper modifier (pipe syntax)', () => {
            const template = `{
                "Code": "{{ItemCode:string|upper}}"
            }`;

            const result = parser.processTemplate(template, {
                'ItemCode': 'test123'
            });

            expect(result.success).to.be.true;
            expect(result.processedJson).to.include('"TEST123"');
        });

        it('should apply number rounding modifier (pipe syntax)', () => {
            const template = `{
                "Price": "{{Amount:number|rnd(2)}}"
            }`;

            const result = parser.processTemplate(template, {
                'Amount': '19.999'
            });

            expect(result.success).to.be.true;
            // Should be 20 after rounding
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.Price).to.equal(20);
        });

        it('should fail validation when value exceeds max length (pipe syntax)', () => {
            const template = `{
                "Code": "{{ItemCode:string|-5}}"
            }`;

            const result = parser.processTemplate(template, {
                'ItemCode': 'TOOLONG123'
            });

            // Should fail because "TOOLONG123" is longer than 5 chars
            expect(result.success).to.be.false;
        });

        it('should fail validation when number is not positive (pipe syntax)', () => {
            const template = `{
                "Qty": "{{Quantity:number|>0}}"
            }`;

            const result = parser.processTemplate(template, {
                'Quantity': '-5'
            });

            // Should fail because -5 is not > 0
            expect(result.success).to.be.false;
        });
    });

    describe('Real-world Template Examples', () => {
        it('should process the System Item Create template with modifiers (pipe syntax)', () => {
            const template = `{
                "Data": [
                    {
                        "ItemId": "{{:string|5-50|upper}}",
                        "Description": "{{Desc:string|-500}}",
                        "StandardUOMCode": "{{UOM:string|2-10|upper}}",
                        "ItemWeight": "{{Weight:number|>=0|rnd(3)}}",
                        "ItemCost": "{{Cost:number|>=0|rnd(2)}}"
                    }
                ]
            }`;

            const result = parser.parseTemplate(template);

            expect(result.isValid).to.be.true;
            expect(result.variables).to.have.length(5);

            // Verify modifiers are preserved
            const varMap = new Map(result.variables.map(v => [v.name, v]));
            expect(varMap.get('ItemId')!.formatModifier).to.equal('5-50|upper');
            expect(varMap.get('Desc')!.formatModifier).to.equal('-500');
            expect(varMap.get('UOM')!.formatModifier).to.equal('2-10|upper');
            expect(varMap.get('Weight')!.formatModifier).to.equal('>=0|rnd(3)');
            expect(varMap.get('Cost')!.formatModifier).to.equal('>=0|rnd(2)');
        });

        it('should process Order Create template with date math (pipe syntax)', () => {
            const template = `{
                "OrderId": "{{:string|10-}}",
                "OrderDate": "{{A8:datetime}}",
                "ShipByDate": "{{A8:datetime:iso|+2d}}",
                "ExpireDate": "{{A8:date|+30d}}"
            }`;

            const result = parser.parseTemplate(template);

            expect(result.isValid).to.be.true;

            // A8 datetime with date math
            const a8Vars = result.variables.filter(v => v.isA8Variable);
            expect(a8Vars).to.have.length(3);
        });
    });
});
