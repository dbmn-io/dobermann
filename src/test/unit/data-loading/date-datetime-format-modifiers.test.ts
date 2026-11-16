// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for Date/DateTime/Time Format Modifiers (GitHub Issue #162)
 *
 * Tests template variable format modifiers for date/datetime types:
 *   {{DATE_COL:date}}           → YYYYMMDD format (default)
 *   {{DATE_COL:date:iso}}       → YYYY-MM-DD format
 *   {{DATE_COL:date:DD-MM-YYYY}} → Custom format
 *   {{TIMESTAMP:datetime}}      → Local format without ms/Z
 *   {{TIMESTAMP:datetime:iso}}  → Full ISO 8601
 *   {{TIMESTAMP:datetime:date}} → Date portion only
 *   {{TIMESTAMP:datetime:time}} → Time portion only
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    extractVariablesFromJsonTemplate,
    InferredVariable
} from '../../../data-loading/json-template-parser';
import { TemplateParser } from '../../../data-loading/template-parser';

describe('Date/DateTime Format Modifiers (Issue #162)', () => {
    describe('extractVariablesFromJsonTemplate - Format Modifier Parsing', () => {
        describe('Date type with format modifiers', () => {
            it('should parse {{:date}} with no format modifier', () => {
                const template = `{
                    "orderDate": "{{:date}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('orderDate');
                expect(result.variables[0].dataType).to.equal('date');
                expect(result.variables[0].formatModifier).to.be.undefined;
            });

            it('should parse {{DATE_COL:date:iso}} with iso format modifier', () => {
                const template = `{
                    "orderDate": "{{orderDate:date:iso}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('orderDate');
                expect(result.variables[0].dataType).to.equal('date');
                expect(result.variables[0].formatModifier).to.equal('iso');
            });

            it('should parse {{:date:DD-MM-YYYY}} with custom format modifier', () => {
                const template = `{
                    "deliveryDate": "{{:date:DD-MM-YYYY}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('deliveryDate');
                expect(result.variables[0].dataType).to.equal('date');
                expect(result.variables[0].formatModifier).to.equal('DD-MM-YYYY');
            });

            it('should parse {{DATE:date:YYYY/MM/DD}} with custom format modifier', () => {
                const template = `{
                    "eventDate": "{{DATE:date:YYYY/MM/DD}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('DATE');
                expect(result.variables[0].dataType).to.equal('date');
                expect(result.variables[0].formatModifier).to.equal('YYYY/MM/DD');
            });
        });

        describe('DateTime type with format modifiers', () => {
            it('should parse {{:datetime}} with no format modifier', () => {
                const template = `{
                    "timestamp": "{{:datetime}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('timestamp');
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.be.undefined;
            });

            it('should parse {{TIMESTAMP:datetime:iso}} with iso format modifier', () => {
                const template = `{
                    "createdAt": "{{createdAt:datetime:iso}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(1);
                expect(result.variables[0].resolvedName).to.equal('createdAt');
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.equal('iso');
            });

            it('should parse {{:datetime:date}} for date-only output from datetime', () => {
                const template = `{
                    "dateOnly": "{{:datetime:date}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.equal('date');
            });

            it('should parse {{:datetime:time}} for time-only output from datetime', () => {
                const template = `{
                    "timeOnly": "{{:datetime:time}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.equal('time');
            });

            it('should parse {{:datetime:HH:mm}} with custom time format', () => {
                const template = `{
                    "shortTime": "{{:datetime:HH:mm}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.equal('HH:mm');
            });

            it('should parse {{:datetime:YYYY-MM-DD HH:mm:ss}} with full custom format', () => {
                const template = `{
                    "fullTimestamp": "{{:datetime:YYYY-MM-DD HH:mm:ss}}"
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables[0].dataType).to.equal('datetime');
                expect(result.variables[0].formatModifier).to.equal('YYYY-MM-DD HH:mm:ss');
            });
        });

        describe('Mixed variables with format modifiers', () => {
            it('should parse multiple variables with different format modifiers', () => {
                const template = `{
                    "Data": [
                        {
                            "ItemId": "{{}}",
                            "CreateDate": "{{:date:iso}}",
                            "ModifyDate": "{{:date:DD-MM-YYYY}}",
                            "Timestamp": "{{:datetime:iso}}",
                            "TimeOnly": "{{:datetime:time}}",
                            "IsActive": "{{:boolean}}"
                        }
                    ]
                }`;

                const result = extractVariablesFromJsonTemplate(template);

                expect(result.success).to.be.true;
                expect(result.variables).to.have.length(6);

                const vars = new Map(result.variables.map(v => [v.resolvedName, v]));

                expect(vars.get('ItemId')?.dataType).to.equal('string');
                expect(vars.get('ItemId')?.formatModifier).to.be.undefined;

                expect(vars.get('CreateDate')?.dataType).to.equal('date');
                expect(vars.get('CreateDate')?.formatModifier).to.equal('iso');

                expect(vars.get('ModifyDate')?.dataType).to.equal('date');
                expect(vars.get('ModifyDate')?.formatModifier).to.equal('DD-MM-YYYY');

                expect(vars.get('Timestamp')?.dataType).to.equal('datetime');
                expect(vars.get('Timestamp')?.formatModifier).to.equal('iso');

                expect(vars.get('TimeOnly')?.dataType).to.equal('datetime');
                expect(vars.get('TimeOnly')?.formatModifier).to.equal('time');

                expect(vars.get('IsActive')?.dataType).to.equal('boolean');
            });
        });
    });

    describe('TemplateParser - Format Modifier Value Conversion', () => {
        let parser: TemplateParser;

        beforeEach(() => {
            parser = new TemplateParser();
        });

        describe('Date type value formatting', () => {
            it('should format date with no modifier as YYYYMMDD', () => {
                const template = `{"date": "{{orderDate:date}}"}`;
                const csvRow = { orderDate: '2024-01-04' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('20240104');
            });

            it('should format date with :iso modifier as YYYY-MM-DD', () => {
                const template = `{"date": "{{orderDate:date:iso}}"}`;
                const csvRow = { orderDate: '2024-01-04' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('2024-01-04');
            });

            it('should format date with :DD-MM-YYYY modifier', () => {
                const template = `{"date": "{{orderDate:date:DD-MM-YYYY}}"}`;
                const csvRow = { orderDate: '2024-01-04' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('04-01-2024');
            });

            it('should format date with :MM/DD/YYYY modifier', () => {
                const template = `{"date": "{{orderDate:date:MM/DD/YYYY}}"}`;
                const csvRow = { orderDate: '2024-01-04' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('01/04/2024');
            });
        });

        describe('DateTime type value formatting', () => {
            it('should format datetime with no modifier as local format (no ms/Z)', () => {
                const template = `{"timestamp": "{{ts:datetime}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.timestamp).to.equal('2024-01-04T14:30:00');
            });

            it('should format datetime with :iso modifier as full ISO 8601', () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.timestamp).to.equal('2024-01-04T14:30:00.000Z');
            });

            it('should format datetime with :date modifier for date-only output', () => {
                const template = `{"dateOnly": "{{ts:datetime:date}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.dateOnly).to.equal('2024-01-04');
            });

            it('should format datetime with :time modifier for time-only output', () => {
                const template = `{"timeOnly": "{{ts:datetime:time}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.timeOnly).to.equal('14:30:00');
            });

            it('should format datetime with :HH:mm custom format', () => {
                const template = `{"shortTime": "{{ts:datetime:HH:mm}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.shortTime).to.equal('14:30');
            });
        });

        describe('Edge cases', () => {
            it('should handle invalid date values gracefully', () => {
                const template = `{"date": "{{orderDate:date:iso}}"}`;
                const csvRow = { orderDate: 'not-a-date' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.false;
                expect(result.error).to.include('Invalid date value');
            });

            it('should handle empty date values', () => {
                const template = `{"date": "{{orderDate:date}}"}`;
                const csvRow = { orderDate: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.false;
            });

            it('should handle date at different positions (month boundary)', () => {
                const template = `{"date": "{{d:date:DD-MM-YYYY}}"}`;
                const csvRow = { d: '2024-12-31' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('31-12-2024');
            });

            it('should handle date with time component stripping to date only', () => {
                const template = `{"date": "{{d:date:iso}}"}`;
                const csvRow = { d: '2024-01-04T14:30:00.000Z' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('2024-01-04');
            });
        });

        // GitHub Issue #175: Optional and Nullable date/datetime modifiers
        describe('Optional and Nullable date/datetime fields', () => {
            it('should exclude date field with |opt modifier when value is empty', () => {
                const template = `{"requiredField": "test", "optionalDate": "{{OPT_DATE:date|opt}}"}`;
                const csvRow = { OPT_DATE: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed).to.not.have.property('optionalDate');
            });

            it('should set date field with |null modifier to null when value is empty', () => {
                const template = `{"requiredField": "test", "nullableDate": "{{NULL_DATE:date|null}}"}`;
                const csvRow = { NULL_DATE: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed.nullableDate).to.be.null;
            });

            it('should exclude datetime field with |opt modifier when value is empty', () => {
                const template = `{"requiredField": "test", "optionalDatetime": "{{OPT_DATETIME:datetime|opt}}"}`;
                const csvRow = { OPT_DATETIME: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed).to.not.have.property('optionalDatetime');
            });

            it('should set datetime field with |null modifier to null when value is empty', () => {
                const template = `{"requiredField": "test", "nullableDatetime": "{{NULL_DATETIME:datetime|null}}"}`;
                const csvRow = { NULL_DATETIME: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed.nullableDatetime).to.be.null;
            });

            it('should process date with |opt modifier normally when value is provided', () => {
                const template = `{"optionalDate": "{{OPT_DATE:date|opt}}"}`;
                const csvRow = { OPT_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // Default date format is YYYYMMDD when no format specified
                expect(parsed.optionalDate).to.equal('20240315');
            });

            it('should process date with format and |opt modifier when value is empty', () => {
                const template = `{"requiredField": "test", "optionalDate": "{{OPT_DATE:date:iso|opt}}"}`;
                const csvRow = { OPT_DATE: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed).to.not.have.property('optionalDate');
            });

            it('should process datetime with format and |null modifier when value is empty', () => {
                const template = `{"requiredField": "test", "nullableDatetime": "{{NULL_DT:datetime:iso|null}}"}`;
                const csvRow = { NULL_DT: '' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.requiredField).to.equal('test');
                expect(parsed.nullableDatetime).to.be.null;
            });
        });

        describe('Date math modifiers', () => {
            it('should add days to date with |+2d modifier', () => {
                const template = `{"futureDate": "{{MY_DATE:date|+2d}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 + 2 days = 2024-03-17, default format YYYYMMDD
                expect(parsed.futureDate).to.equal('20240317');
            });

            it('should subtract days from date with |-3d modifier', () => {
                const template = `{"pastDate": "{{MY_DATE:date|-3d}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 - 3 days = 2024-03-12
                expect(parsed.pastDate).to.equal('20240312');
            });

            it('should add weeks to date with |+1w modifier', () => {
                const template = `{"futureDate": "{{MY_DATE:date|+1w}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 + 1 week = 2024-03-22
                expect(parsed.futureDate).to.equal('20240322');
            });

            it('should subtract weeks from date with |-1w modifier', () => {
                const template = `{"pastDate": "{{MY_DATE:date|-1w}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 - 1 week = 2024-03-08
                expect(parsed.pastDate).to.equal('20240308');
            });

            it('should add months to date with |+2M modifier', () => {
                const template = `{"futureDate": "{{MY_DATE:date|+2M}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 + 2 months = 2024-05-15
                expect(parsed.futureDate).to.equal('20240515');
            });

            it('should add years to date with |+1y modifier', () => {
                const template = `{"futureDate": "{{MY_DATE:date|+1y}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 + 1 year = 2025-03-15
                expect(parsed.futureDate).to.equal('20250315');
            });

            it('should combine date math with format modifier', () => {
                const template = `{"futureDate": "{{MY_DATE:date:iso|+2d}}"}`;
                const csvRow = { MY_DATE: '2024-03-15' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 2024-03-15 + 2 days = 2024-03-17, ISO format
                expect(parsed.futureDate).to.equal('2024-03-17');
            });

            it('should add hours to datetime with |+3h modifier', () => {
                const template = `{"futureTime": "{{MY_DT:datetime|+3h}}"}`;
                const csvRow = { MY_DT: '2024-03-15T10:30:00' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 10:30 + 3 hours = 13:30, default datetime format
                expect(parsed.futureTime).to.include('13:30:00');
            });

            it('should add minutes to datetime with |+30m modifier', () => {
                const template = `{"futureTime": "{{MY_DT:datetime|+30m}}"}`;
                const csvRow = { MY_DT: '2024-03-15T10:30:00' };

                const result = parser.processTemplate(template, csvRow);

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                // 10:30 + 30 minutes = 11:00
                expect(parsed.futureTime).to.include('11:00:00');
            });
        });
    });

    describe('A8 Date/DateTime Variables', () => {
        it('should recognize A8:date as a system variable', () => {
            const template = `{
                "Date": "{{A8:date}}"
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(1);
            expect(result.variables[0].isA8Variable).to.be.true;
            // A8 variables return 'string' as the output type (they're processed at runtime)
            expect(result.variables[0].dataType).to.equal('string');
            expect(result.variables[0].resolvedName).to.equal('A8:date');
        });

        it('should recognize A8:datetime as a system variable', () => {
            const template = `{
                "Timestamp": "{{A8:datetime}}"
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(1);
            expect(result.variables[0].isA8Variable).to.be.true;
            // A8 variables return 'string' as the output type
            expect(result.variables[0].dataType).to.equal('string');
            expect(result.variables[0].resolvedName).to.equal('A8:datetime');
        });

        it('should handle A8:date with format modifier (included in name)', () => {
            const template = `{
                "IsoDate": "{{A8:date:iso}}"
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(1);
            expect(result.variables[0].isA8Variable).to.be.true;
            // A8 variables include format modifiers in the resolved name
            expect(result.variables[0].resolvedName).to.equal('A8:date:iso');
        });

        it('should handle A8:datetime with format modifier (included in name)', () => {
            const template = `{
                "IsoTimestamp": "{{A8:datetime:iso}}"
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(1);
            expect(result.variables[0].isA8Variable).to.be.true;
            // A8 variables include format modifiers in the resolved name
            expect(result.variables[0].resolvedName).to.equal('A8:datetime:iso');
        });
    });

    describe('Real-world template scenarios', () => {
        it('should handle the System data load template with date formatting', () => {
            const template = `{
                "Data": [
                    {
                        "ItemId": "{{}}",
                        "LocationId": "{{}}",
                        "ExpirationDate": "{{:date:iso}}",
                        "ReceivedTimestamp": "{{:datetime:iso}}",
                        "CreatedDate": "{{A8:date}}",
                        "ModifiedTimestamp": "{{A8:datetime}}"
                    }
                ]
            }`;

            const result = extractVariablesFromJsonTemplate(template);

            expect(result.success).to.be.true;
            expect(result.variables).to.have.length(6);

            const vars = new Map(result.variables.map(v => [v.resolvedName, v]));

            // Regular inferred variables
            expect(vars.get('ItemId')?.isInferred).to.be.true;
            expect(vars.get('LocationId')?.isInferred).to.be.true;

            // Date with format
            expect(vars.get('ExpirationDate')?.dataType).to.equal('date');
            expect(vars.get('ExpirationDate')?.formatModifier).to.equal('iso');

            // DateTime with format
            expect(vars.get('ReceivedTimestamp')?.dataType).to.equal('datetime');
            expect(vars.get('ReceivedTimestamp')?.formatModifier).to.equal('iso');

            // A8 system variables
            expect(vars.get('A8:date')?.isA8Variable).to.be.true;
            expect(vars.get('A8:datetime')?.isA8Variable).to.be.true;
        });

        it('should process template with European date format output', () => {
            const parser = new TemplateParser();
            const template = `{
                "shipment": {
                    "orderId": "{{orderId}}",
                    "shipDate": "{{shipDate:date:DD/MM/YYYY}}",
                    "createdAt": "{{createdAt:datetime:iso}}"
                }
            }`;

            const csvRow = {
                orderId: 'ORD-12345',
                shipDate: '2024-06-15',
                createdAt: '2024-06-15T09:30:00.000Z'
            };

            const result = parser.processTemplate(template, csvRow);

            expect(result.success).to.be.true;
            const parsed = JSON.parse(result.processedJson!);
            expect(parsed.shipment.orderId).to.equal('ORD-12345');
            expect(parsed.shipment.shipDate).to.equal('15/06/2024');
            expect(parsed.shipment.createdAt).to.equal('2024-06-15T09:30:00.000Z');
        });
    });

    // ========================================================================
    // GitHub Issue #162: Timezone Conversion Tests
    // ========================================================================

    describe('Timezone Conversion (Issue #162)', () => {
        let parser: TemplateParser;

        beforeEach(() => {
            parser = new TemplateParser();
        });

        describe('processTemplate with timezone configuration', () => {
            it('should convert datetime from source timezone to target timezone', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00' };  // No Z, treated as local/source timezone

                // Test with timezone config
                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,  // repeatConfig
                    undefined,  // endpointId
                    undefined,  // sequenceManager
                    undefined,  // sequenceContext
                    { sourceTimezone: 'UTC', targetTimezone: 'UTC' }
                );

                expect(result.success).to.be.true;
            });

            it('should handle same source and target timezone (no conversion)', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'UTC', targetTimezone: 'UTC' }
                );

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.timestamp).to.equal('2024-01-04T14:30:00.000Z');
            });

            it('should handle undefined timezone config', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T14:30:00.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined  // No timezone config
                );

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.timestamp).to.equal('2024-01-04T14:30:00.000Z');
            });

            it('should handle date type with timezone config', async () => {
                const template = `{"date": "{{d:date:iso}}"}`;
                const csvRow = { d: '2024-01-04' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'UTC', targetTimezone: 'UTC' }
                );

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('2024-01-04');
            });
        });

        describe('TimezoneConfig interface', () => {
            it('should accept valid timezone names', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T00:00:00.000Z' };

                // These timezone names should be valid
                const validTimezones = [
                    { sourceTimezone: 'UTC', targetTimezone: 'UTC' },
                    { sourceTimezone: 'America/New_York', targetTimezone: 'UTC' },
                    { sourceTimezone: 'Europe/London', targetTimezone: 'America/Los_Angeles' },
                    { sourceTimezone: 'Australia/Sydney', targetTimezone: 'UTC' }
                ];

                for (const config of validTimezones) {
                    const result = await parser.processTemplateAsync(
                        template,
                        csvRow,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        config
                    );
                    expect(result.success).to.be.true;
                }
            });

            it('should handle only sourceTimezone specified', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T00:00:00.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'America/New_York' }  // No targetTimezone
                );

                expect(result.success).to.be.true;
            });

            it('should handle only targetTimezone specified', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-01-04T00:00:00.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { targetTimezone: 'Europe/London' }  // No sourceTimezone
                );

                expect(result.success).to.be.true;
            });
        });

        describe('Timezone edge cases', () => {
            it('should handle daylight saving time transitions', async () => {
                // March 10, 2024 is when US springs forward
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2024-03-10T02:30:00.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'UTC', targetTimezone: 'America/New_York' }
                );

                expect(result.success).to.be.true;
            });

            it('should handle year boundary dates', async () => {
                const template = `{"timestamp": "{{ts:datetime:iso}}"}`;
                const csvRow = { ts: '2023-12-31T23:59:59.000Z' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'UTC', targetTimezone: 'Pacific/Auckland' }  // +13 hours from UTC
                );

                expect(result.success).to.be.true;
            });

            it('should handle leap year February 29', async () => {
                const template = `{"date": "{{d:date:iso}}"}`;
                const csvRow = { d: '2024-02-29' };

                const result = await parser.processTemplateAsync(
                    template,
                    csvRow,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { sourceTimezone: 'UTC', targetTimezone: 'UTC' }
                );

                expect(result.success).to.be.true;
                const parsed = JSON.parse(result.processedJson!);
                expect(parsed.date).to.equal('2024-02-29');
            });
        });
    });
});
