// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { TemplateParser } from '../../../data-loading/template-parser';

/**
 * Diagnostic tests for PubSub template variable issues
 * GitHub Issue #127
 */
describe('PubSub Template Debug', () => {
    let jsonGenerator: JsonGenerator;
    let templateParser: TemplateParser;

    // The actual PubSub template from user
    const pubsubTemplate = {
        messages: [
            {
                attributes: {
                    User: 'admin@company.com',
                    MSG_TYPE: 'ITEM_CREATE',
                    Organization: '888'
                },
                data: {
                    ItemId: '{{ItemId}}',
                    Description: '{{Description}}',
                    Weight: '{{Weight:number}}',
                    WeightUomId: 'kg',
                    ItemCode: [
                        {
                            CodeType: 'GTIN',
                            CodeValue: '{{GTIN}}'
                        }
                    ]
                }
            }
        ]
    };

    beforeEach(() => {
        templateParser = new TemplateParser();
        jsonGenerator = new JsonGenerator();
    });

    describe('Step 1: Variable Extraction', () => {
        it('should extract all variables from the template', () => {
            const templateString = JSON.stringify(pubsubTemplate);
            const variables = templateParser.extractVariables(templateString);

            console.log('Extracted variables:', variables.map(v => ({
                name: v.name,
                dataType: v.dataType,
                hasExplicitType: v.hasExplicitType
            })));

            // Should find all 4 variables
            const names = variables.map(v => v.name);
            expect(names).to.include('ItemId');
            expect(names).to.include('Description');
            expect(names).to.include('Weight');
            expect(names).to.include('GTIN');
        });

        it('should detect Weight has explicit number type', () => {
            const templateString = JSON.stringify(pubsubTemplate);
            const variables = templateParser.extractVariables(templateString);

            const weightVar = variables.find(v => v.name === 'Weight');
            console.log('Weight variable:', weightVar);

            expect(weightVar).to.not.be.undefined;
            expect(weightVar!.dataType).to.equal('number');
            expect(weightVar!.hasExplicitType).to.be.true;
        });
    });

    describe('Step 2: Array Detection', () => {
        it('should detect arrays in template', () => {
            const templateString = JSON.stringify(pubsubTemplate);
            const arrays = templateParser.detectArrays(templateString);

            console.log('Detected arrays:', arrays.map(a => ({
                path: a.path,
                isRepeatable: a.isRepeatable,
                elementCount: a.elementCount
            })));

            // Should detect 'messages' and 'ItemCode'
            expect(arrays.length).to.be.greaterThan(0);

            const messageArray = arrays.find(a => a.path === 'messages');
            expect(messageArray).to.not.be.undefined;

            const itemCodeArray = arrays.find(a => a.path.includes('ItemCode'));
            expect(itemCodeArray).to.not.be.undefined;
            console.log('ItemCode path:', itemCodeArray?.path);
        });
    });

    describe('Step 3: Template Processing with CSV data', () => {
        it('should process template with single CSV row', async () => {
            const templateString = JSON.stringify(pubsubTemplate);
            const csvRow = {
                ItemId: 'ITEM001',
                Description: 'Test Item Description',
                Weight: '10.5',
                GTIN: '1234567890123'
            };

            const result = await templateParser.processTemplateAsync(
                templateString,
                csvRow,
                undefined,
                'test-endpoint'
            );

            console.log('Processing result:', {
                success: result.success,
                error: result.error
            });

            if (result.success) {
                const processed = JSON.parse(result.processedJson!);
                console.log('Processed JSON:', JSON.stringify(processed, null, 2));

                // Verify variable replacement
                expect(processed.messages[0].data.ItemId).to.equal('ITEM001');
                expect(processed.messages[0].data.Description).to.equal('Test Item Description');
                expect(processed.messages[0].data.Weight).to.equal(10.5); // Should be number
                expect(processed.messages[0].data.ItemCode[0].CodeValue).to.equal('1234567890123');
            } else {
                console.error('Processing failed:', result.error);
            }

            expect(result.success).to.be.true;
        });
    });

    describe('Step 4: JSON Generation with Array Repetition', () => {
        it('should generate JSON with multiple CSV rows for ItemCode array', async () => {
            const templateString = JSON.stringify(pubsubTemplate);

            // CSV data: header + 3 data rows (different GTINs for same item)
            const csvRows = [
                'ITEM001,Test Item,10.5,1111111111111',
                'ITEM001,Test Item,10.5,2222222222222',
                'ITEM001,Test Item,10.5,3333333333333'
            ];

            const options = {
                template: templateString,
                mappings: [
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' },
                    { variable: 'Description', column: 'Description', dataType: 'string' },
                    { variable: 'Weight', column: 'Weight', dataType: 'number' },
                    { variable: 'GTIN', column: 'GTIN', dataType: 'string' }
                ],
                headers: ['ItemId', 'Description', 'Weight', 'GTIN'],
                repeatableArrays: [{
                    enabled: true,
                    maxRepetitions: 10,
                    arrayPath: 'messages[].data.ItemCode',
                    fieldName: 'ItemCode'
                }],
                endpointId: 'test-endpoint',
                sequenceStartValue: 1001,
                isBatchExecution: true
            };

            console.log('Calling generateConsolidatedJson...');

            try {
                const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

                console.log('Generation result:', {
                    success: result.success,
                    error: result.error,
                    metadata: result.metadata
                });

                if (result.success) {
                    console.log('Generated JSON:', JSON.stringify(result.jsonData, null, 2));

                    // Verify ItemCode array has 3 elements
                    expect(result.jsonData.messages[0].data.ItemCode).to.have.length(3);
                } else {
                    console.error('Generation failed:', result.error);
                }

                expect(result.success).to.be.true;
            } catch (error) {
                console.error('Exception during generation:', error);
                throw error;
            }
        });

        it('should replace outer variables AND populate inner array', async () => {
            const templateString = JSON.stringify(pubsubTemplate);

            // CSV data: 3 rows with same outer data, different GTINs
            const csvRows = [
                'ITEM001,Test Item,10.5,1111111111111',
                'ITEM001,Test Item,10.5,2222222222222',
                'ITEM001,Test Item,10.5,3333333333333'
            ];

            const options = {
                template: templateString,
                mappings: [
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' },
                    { variable: 'Description', column: 'Description', dataType: 'string' },
                    { variable: 'Weight', column: 'Weight', dataType: 'number' },
                    { variable: 'GTIN', column: 'GTIN', dataType: 'string' }
                ],
                headers: ['ItemId', 'Description', 'Weight', 'GTIN'],
                repeatableArrays: [{
                    enabled: true,
                    maxRepetitions: 10,
                    arrayPath: 'messages[].data.ItemCode',
                    fieldName: 'ItemCode'
                }],
                endpointId: 'test-endpoint',
                sequenceStartValue: 1001,
                isBatchExecution: true
            };

            const result = await jsonGenerator.generateConsolidatedJson(csvRows, options);

            expect(result.success).to.be.true;

            // Verify outer variables are replaced (from first row)
            const data = result.jsonData.messages[0].data;
            expect(data.ItemId).to.equal('ITEM001');
            expect(data.Description).to.equal('Test Item');
            expect(data.Weight).to.equal(10.5); // Should be number type

            // Verify inner array has all 3 GTINs
            expect(data.ItemCode).to.have.length(3);
            expect(data.ItemCode[0].CodeValue).to.equal('1111111111111');
            expect(data.ItemCode[1].CodeValue).to.equal('2222222222222');
            expect(data.ItemCode[2].CodeValue).to.equal('3333333333333');
        });
    });

    describe('Step 5: Nested Array Analysis', () => {
        it('should correctly analyze nested structure', () => {
            const templateString = JSON.stringify(pubsubTemplate);
            const arrays = templateParser.detectArrays(templateString);

            console.log('All array paths:');
            arrays.forEach(a => console.log(`  - ${a.path}`));

            // The nested path should be messages[].data.ItemCode
            const nestedArrays = arrays.filter(arr =>
                arr.path.includes('[]') && arr.path.split('.').length > 1
            );

            console.log('Nested array paths:');
            nestedArrays.forEach(a => console.log(`  - ${a.path}`));

            if (nestedArrays.length > 0) {
                // Find deepest nesting
                const sortedByDepth = nestedArrays.sort((a, b) => {
                    const depthA = (a.path.match(/\[\]/g) || []).length;
                    const depthB = (b.path.match(/\[\]/g) || []).length;
                    return depthB - depthA;
                });

                const nestedPath = sortedByDepth[0].path;
                console.log('Deepest nested path:', nestedPath);

                // Analyze the path
                const arrayMarkers = (nestedPath.match(/\[\]/g) || []).length;
                console.log('Array markers ([] count):', arrayMarkers);
                console.log('Nesting level:', arrayMarkers + 1);

                // Split by []. to see segments
                const segments = nestedPath.split('[].').filter(s => s);
                console.log('Segments:', segments);
            }
        });
    });
});
