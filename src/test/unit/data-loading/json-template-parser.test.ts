// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for JSON-aware template parser (Issue #130)
 *
 * Tests the simplified template variable syntax:
 *   {{}}        → infers variable name from JSON key
 *   {{:type}}   → infers name from key with explicit type
 */

import { expect } from 'chai';
import {
    extractVariablesFromJsonTemplate,
    validateNonJsonTemplate,
    resolveTemplateVariables,
    jsonPathAt,
    InferredVariable,
    TemplateValidationError
} from '../../../data-loading/json-template-parser';

describe('JSON Template Parser (Issue #130)', () => {
    describe('extractVariablesFromJsonTemplate', () => {
        describe('Empty variable inference: {{}}', () => {
            it('should infer variable name from JSON key for {{}}', () => {
                const template = `{
                    "LocationId": "{{}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('LocationId');
                expect(result.variables[0].isInferred).to.be.true;
                expect(result.variables[0].dataType).to.equal('string');
                expect(result.variables[0].hasExplicitType).to.be.false;
            });

            it('should infer multiple variables from different keys', () => {
                const template = `{
                    "LocationId": "{{}}",
                    "PickAllocationZoneId": "{{}}",
                    "PickExecutionZoneId": "{{}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(3);

                const names = result.variables.map(v => v.resolvedName);
                expect(names).to.include('LocationId');
                expect(names).to.include('PickAllocationZoneId');
                expect(names).to.include('PickExecutionZoneId');
            });

            it('should handle nested objects', () => {
                const template = `{
                    "Data": [
                        {
                            "ItemId": "{{}}"
                        }
                    ]
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('ItemId');
                expect(result.variables[0].isInferred).to.be.true;
            });
        });

        describe('Type-only inference: {{:type}}', () => {
            it('should infer name and use explicit type for {{:type}}', () => {
                const template = `{
                    "IsActive": "{{:boolean}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('IsActive');
                expect(result.variables[0].isInferred).to.be.true;
                expect(result.variables[0].dataType).to.equal('boolean');
                expect(result.variables[0].hasExplicitType).to.be.true;
            });

            it('should support all valid types', () => {
                const template = `{
                    "Name": "{{:string}}",
                    "Quantity": "{{:number}}",
                    "Active": "{{:boolean}}",
                    "Created": "{{:date}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(4);

                const vars = new Map(result.variables.map(v => [v.resolvedName, v]));

                expect(vars.get('Name')?.dataType).to.equal('string');
                expect(vars.get('Quantity')?.dataType).to.equal('number');
                expect(vars.get('Active')?.dataType).to.equal('boolean');
                expect(vars.get('Created')?.dataType).to.equal('date');
            });

            it('should reject invalid types', () => {
                const template = `{
                    "Value": "{{:INVALID}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.false;
                expect(result.errors).to.have.length(1);
                expect(result.errors[0].type).to.equal('INVALID_TYPE');
                expect(result.errors[0].message.toLowerCase()).to.include('invalid');
            });

            it('should be case-insensitive for types', () => {
                const template = `{
                    "Value": "{{:NUMBER}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].dataType).to.equal('number');
            });
        });

        describe('Explicit names (existing behavior)', () => {
            it('should preserve explicit names when provided', () => {
                const template = `{
                    "LocationId": "{{LocId}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('LocId');
                expect(result.variables[0].isInferred).to.be.false;
            });

            it('should handle explicit name with type', () => {
                const template = `{
                    "Quantity": "{{Qty:number}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('Qty');
                expect(result.variables[0].dataType).to.equal('number');
                expect(result.variables[0].isInferred).to.be.false;
            });
        });

        describe('Mixed explicit and inferred variables', () => {
            it('should work with mixed explicit and inferred variables', () => {
                const template = `{
                    "Data": [
                        {
                            "LocationId": "{{}}",
                            "PickAllocationZoneId": "{{}}",
                            "PickExecutionZoneId": "{{CustomZone}}",
                            "ClearLiaItemAttributeForEmptyLocation": true,
                            "IsActive": "{{:boolean}}"
                        }
                    ]
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(4);

                const vars = new Map(result.variables.map(v => [v.resolvedName, v]));

                // Inferred
                expect(vars.get('LocationId')?.isInferred).to.be.true;
                expect(vars.get('PickAllocationZoneId')?.isInferred).to.be.true;
                expect(vars.get('IsActive')?.isInferred).to.be.true;
                expect(vars.get('IsActive')?.dataType).to.equal('boolean');

                // Explicit
                expect(vars.get('CustomZone')?.isInferred).to.be.false;
            });
        });

        describe('A8 system variables', () => {
            it('should handle A8:sequence', () => {
                const template = `{
                    "Seq": "{{A8:sequence}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('A8:sequence');
                expect(result.variables[0].isA8Variable).to.be.true;
                expect(result.variables[0].dataType).to.equal('number');
            });

            it('should handle A8:date and A8:datetime', () => {
                const template = `{
                    "Date": "{{A8:date}}",
                    "Timestamp": "{{A8:datetime}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(2);

                const vars = new Map(result.variables.map(v => [v.resolvedName, v]));
                expect(vars.get('A8:date')?.isA8Variable).to.be.true;
                expect(vars.get('A8:datetime')?.isA8Variable).to.be.true;
            });

            it('should be case-insensitive for A8 prefix', () => {
                const template = `{
                    "Seq": "{{a8:sequence}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].isA8Variable).to.be.true;
            });

            it('should reject invalid A8 types', () => {
                const template = `{
                    "Bad": "{{A8:invalid}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.false;
                expect(result.errors[0].type).to.equal('INVALID_TYPE');
            });
        });

        describe('Deduplication', () => {
            it('should deduplicate variables by resolved name', () => {
                const template = `{
                    "First": "{{ItemId}}",
                    "Second": "{{ItemId}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                // GitHub Issue #139: variables contains ALL occurrences (for substitution)
                expect(result.variables).to.have.length(2);
                // uniqueVariables contains deduplicated list (for UI display)
                expect(result.uniqueVariables).to.have.length(1);
                expect(result.uniqueVariables![0].resolvedName).to.equal('ItemId');
            });
        });

        describe('Edge cases', () => {
            it('should handle whitespace in {{  }}', () => {
                const template = `{
                    "Name": "{{  }}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].resolvedName).to.equal('Name');
                expect(result.variables[0].isInferred).to.be.true;
            });

            it('should handle whitespace in {{ :number }}', () => {
                const template = `{
                    "Qty": "{{  :number  }}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].resolvedName).to.equal('Qty');
                expect(result.variables[0].dataType).to.equal('number');
            });

            it('should handle keys with special characters', () => {
                const template = `{
                    "Item-Id": "{{}}",
                    "user_name": "{{}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(2);

                const names = result.variables.map(v => v.resolvedName);
                expect(names).to.include('Item-Id');
                expect(names).to.include('user_name');
            });

            it('should handle concatenated values', () => {
                const template = `{
                    "FullId": "PREFIX-{{}}-SUFFIX"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].resolvedName).to.equal('FullId');
            });
        });
    });

    describe('validateNonJsonTemplate', () => {
        it('should reject {{}} in URL templates', () => {
            const template = '/api/items/{{}}/details';

            const errors = validateNonJsonTemplate(template, 'URL path');

            expect(errors).to.have.length(1);
            expect(errors[0].type).to.equal('EMPTY_VARIABLE_OUTSIDE_JSON');
            expect(errors[0].message).to.include('URL path');
        });

        it('should reject {{:type}} in query params', () => {
            const template = '{{:number}}';

            const errors = validateNonJsonTemplate(template, 'Query parameter');

            expect(errors).to.have.length(1);
            expect(errors[0].type).to.equal('EMPTY_VARIABLE_OUTSIDE_JSON');
        });

        it('should allow explicit names in non-JSON contexts', () => {
            const template = '/api/items/{{itemId}}/details';

            const errors = validateNonJsonTemplate(template, 'URL path');

            expect(errors).to.have.length(0);
        });

        it('should allow typed explicit names in non-JSON contexts', () => {
            const template = '{{itemId:number}}';

            const errors = validateNonJsonTemplate(template, 'Query parameter');

            expect(errors).to.have.length(0);
        });
    });

    describe('resolveTemplateVariables', () => {
        it('should return map of resolved variable names', () => {
            const template = `{
                "LocationId": "{{}}",
                "Qty": "{{:number}}",
                "Name": "{{ItemName}}"
            }`;

            const resolved = resolveTemplateVariables(template);

            expect(resolved.size).to.equal(3);
            expect(resolved.has('LocationId')).to.be.true;
            expect(resolved.has('Qty')).to.be.true;
            expect(resolved.has('ItemName')).to.be.true;

            expect(resolved.get('LocationId')?.isInferred).to.be.true;
            expect(resolved.get('Qty')?.isInferred).to.be.true;
            expect(resolved.get('ItemName')?.isInferred).to.be.false;
        });

        it('should exclude A8 variables', () => {
            const template = `{
                "ItemId": "{{}}",
                "Seq": "{{A8:sequence}}"
            }`;

            const resolved = resolveTemplateVariables(template);

            expect(resolved.size).to.equal(1);
            expect(resolved.has('ItemId')).to.be.true;
            expect(resolved.has('A8:sequence')).to.be.false;
        });
    });

    describe('Real-world templates', () => {
        it('should parse Issue #130 example template', () => {
            const template = `{
                "Data": [
                    {
                        "LocationId": "{{}}",
                        "PickAllocationZoneId": "{{}}",
                        "PickExecutionZoneId": "{{PickExecutionZoneId}}",
                        "ClearLiaItemAttributeForEmptyLocation": true,
                        "IsActive": "{{:boolean}}"
                    }
                ]
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(4);

            const vars = new Map(result.variables.map(v => [v.resolvedName, v]));

            // Inferred from keys
            expect(vars.get('LocationId')?.isInferred).to.be.true;
            expect(vars.get('PickAllocationZoneId')?.isInferred).to.be.true;
            expect(vars.get('IsActive')?.isInferred).to.be.true;
            expect(vars.get('IsActive')?.dataType).to.equal('boolean');

            // Explicit name
            expect(vars.get('PickExecutionZoneId')?.isInferred).to.be.false;
        });

        it('should handle typical the System template', () => {
            const template = `{
                "Data": [
                    {
                        "ItemId": "ACAU-{{}}",
                        "Quantity": "{{:number}}",
                        "LocationId": "{{}}",
                        "TransactionReference": "{{A8:sequence}}",
                        "Timestamp": "{{A8:datetime}}"
                    }
                ]
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;

            // Should have 3 regular variables (excluding A8)
            const regularVars = result.variables.filter(v => !v.isA8Variable);
            expect(regularVars).to.have.length(3);

            const names = regularVars.map(v => v.resolvedName);
            expect(names).to.include('ItemId');
            expect(names).to.include('Quantity');
            expect(names).to.include('LocationId');
        });
    });
});

describe('jsonPathAt', () => {
    const pathOf = (template: string, name: string) =>
        extractVariablesFromJsonTemplate(template).variables.find(v => v.resolvedName === name)?.jsonPath;

    it('gives the full path of quoted and bare placeholders, through objects and arrays', () => {
        const template = `{
            "buyerGln": "{{buyerGln}}",
            "order": { "shipTo": { "gln": "{{shipGln}}" } },
            "lines": [
                { "sku": "{{sku}}", "qty": {{qty:number}}, "flags": [ "{{flag}}" ] }
            ],
            "after": {{after:boolean}}
        }`;
        expect(pathOf(template, 'buyerGln')).to.equal('buyerGln');
        expect(pathOf(template, 'shipGln')).to.equal('order.shipTo.gln');
        expect(pathOf(template, 'sku')).to.equal('lines[0].sku');
        expect(pathOf(template, 'qty')).to.equal('lines[0].qty');
        expect(pathOf(template, 'flag')).to.equal('lines[0].flags[0]');
        expect(pathOf(template, 'after')).to.equal('after');
    });

    it('counts array elements and ignores braces inside strings', () => {
        const template = `[{ "note": "a } ] , b", "x": "{{x}}" }, { "y": "{{y}}" }]`;
        expect(jsonPathAt(template, template.indexOf('{{x}}'))).to.equal('[0].x');
        expect(jsonPathAt(template, template.indexOf('{{y}}'))).to.equal('[1].y');
    });
});
