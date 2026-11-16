// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for TemplateParser A8:sequence consistency
 * Tests that A8:sequence uses the same value within a single request
 */

import { assert } from 'chai';
import { TemplateParser } from '../../../data-loading/template-parser';

describe('TemplateParser A8:sequence consistency', () => {
    let parser: TemplateParser;
    let mockSequenceManager: { getNextSequence: (id: string) => Promise<number> };
    let sequenceCounter: number;

    beforeEach(() => {
        parser = new TemplateParser();
        sequenceCounter = 1000;
        
        mockSequenceManager = {
            getNextSequence: async (id: string) => {
                return ++sequenceCounter;
            }
        };
    });

    describe('sequence consistency within single request', () => {
        it('should use same sequence value for multiple occurrences in same request', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                referenceId: '{{A8:sequence}}',
                tracking: {
                    requestId: '{{A8:sequence}}'
                },
                meta: {
                    transactionId: '{{A8:sequence}}'
                }
            });

            const csvRow = {};
            const result = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                mockSequenceManager
            );

            assert.isTrue(result.success);
            assert.isDefined(result.processedJson);

            const processedData = JSON.parse(result.processedJson!);
            
            // All sequence values should be the same within this request
            assert.equal(processedData.id, processedData.referenceId);
            assert.equal(processedData.id, processedData.tracking.requestId);
            assert.equal(processedData.id, processedData.meta.transactionId);
            
            // Should be 1001 (first increment from 1000)
            assert.equal(processedData.id, 1001);
        });

        it('should use different sequence values for separate requests', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                referenceId: '{{A8:sequence}}'
            });

            const csvRow = {};

            // First request
            const result1 = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                mockSequenceManager
            );

            // Second request (new parser instance to simulate separate request)
            const parser2 = new TemplateParser();
            const result2 = await parser2.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                mockSequenceManager
            );

            assert.isTrue(result1.success);
            assert.isTrue(result2.success);

            const data1 = JSON.parse(result1.processedJson!);
            const data2 = JSON.parse(result2.processedJson!);

            // Within each request, values should be consistent
            assert.equal(data1.id, data1.referenceId);
            assert.equal(data2.id, data2.referenceId);

            // Between requests, sequence values should be different
            assert.notEqual(data1.id, data2.id);
            
            // First request gets 1001, second gets 1002
            assert.equal(data1.id, 1001);
            assert.equal(data2.id, 1002);
        });

        it('should handle mixed A8 variables consistently', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                created: '{{A8:datetime}}',
                referenceId: '{{A8:sequence}}',
                date: '{{A8:date}}',
                trackingId: '{{A8:sequence}}'
            });

            const csvRow = {};
            const result = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                mockSequenceManager
            );

            assert.isTrue(result.success);
            const processedData = JSON.parse(result.processedJson!);

            // All sequence values should be the same
            assert.equal(processedData.id, processedData.referenceId);
            assert.equal(processedData.id, processedData.trackingId);

            // Date and datetime should be different from sequence
            assert.notEqual(processedData.created, processedData.id);
            assert.notEqual(processedData.date, processedData.id);

            // Date and datetime should be strings, sequence should be number
            assert.isNumber(processedData.id);
            assert.isString(processedData.created);
            assert.isString(processedData.date);
        });

        it('should handle sequence with regular variables', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                userName: '{{userName}}',
                referenceId: '{{A8:sequence}}',
                userAge: '{{userAge:number}}'
            });

            const csvRow = {
                userName: 'John Doe',
                userAge: '30'
            };

            const result = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                mockSequenceManager
            );

            assert.isTrue(result.success);
            const processedData = JSON.parse(result.processedJson!);

            // Sequence values should be consistent
            assert.equal(processedData.id, processedData.referenceId);
            assert.equal(processedData.id, 1001);

            // Regular variables should be processed normally
            assert.equal(processedData.userName, 'John Doe');
            assert.equal(processedData.userAge, 30);
        });

        it('should clear cache between different endpoint contexts', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                ref: '{{A8:sequence}}'
            });

            const csvRow = {};

            // Process for first endpoint
            const result1 = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'endpoint-1',
                mockSequenceManager
            );

            // Process for second endpoint (same parser instance)
            const result2 = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'endpoint-2',
                mockSequenceManager
            );

            assert.isTrue(result1.success);
            assert.isTrue(result2.success);

            const data1 = JSON.parse(result1.processedJson!);
            const data2 = JSON.parse(result2.processedJson!);

            // Each request should have consistent internal values
            assert.equal(data1.id, data1.ref);
            assert.equal(data2.id, data2.ref);

            // Different endpoints should get different sequence values
            assert.notEqual(data1.id, data2.id);
        });
    });

    describe('error handling', () => {
        it('should keep A8 pattern when no sequence manager provided (for later processing)', async () => {
            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                name: '{{userName}}'
            });

            const csvRow = { userName: 'John' };

            const result = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint'
                // No sequence manager provided
            );

            // When no sequence manager is provided, A8 variables are kept as-is
            // so they can be processed later in the pipeline
            assert.isTrue(result.success);
            assert.isDefined(result.processedJson);

            const data = JSON.parse(result.processedJson!);
            // A8:sequence pattern is preserved for later processing
            assert.equal(data.id, '{{A8:sequence}}');
            // Regular variables are still processed
            assert.equal(data.name, 'John');
        });

        it('should handle sequence manager errors gracefully', async () => {
            const failingSequenceManager = {
                getNextSequence: async (id: string) => {
                    throw new Error('Sequence generation failed');
                }
            };

            const template = JSON.stringify({
                id: '{{A8:sequence}}',
                name: '{{userName}}'
            });

            const csvRow = { userName: 'John' };

            const result = await parser.processTemplateAsync(
                template,
                csvRow,
                undefined,
                'test-endpoint',
                failingSequenceManager
            );

            assert.isFalse(result.success);
            assert.isDefined(result.error);
        });
    });

    /**
     * GitHub Issue #153: Sequence Modifiers for Nested Arrays
     * Tests for :local, :global, and :parent modifiers
     */
    describe('sequence modifiers (GitHub Issue #153)', () => {
        describe(':local modifier', () => {
            it('should increment locally within a sequence context', async () => {
                const template = JSON.stringify({
                    lineId: '{{A8:sequence:local}}'
                });

                // Create sequence context with an array path
                const context = parser.createSequenceContext({
                    arrayPath: 'items',
                    arrayInstanceId: 'items_instance_1'
                });

                // First call within this context
                const result1 = await parser.processTemplateAsync(
                    template,
                    {},
                    undefined,
                    'test-endpoint',
                    mockSequenceManager,
                    context
                );

                // Second call within same context
                const result2 = await parser.processTemplateAsync(
                    template,
                    {},
                    undefined,
                    'test-endpoint',
                    mockSequenceManager,
                    context
                );

                assert.isTrue(result1.success);
                assert.isTrue(result2.success);

                const data1 = JSON.parse(result1.processedJson!);
                const data2 = JSON.parse(result2.processedJson!);

                // Local sequence should increment: 1, 2
                assert.equal(data1.lineId, 1);
                assert.equal(data2.lineId, 2);
            });

            it('should reset local counter for new array instance', async () => {
                const template = JSON.stringify({
                    lineId: '{{A8:sequence:local}}'
                });

                // First array instance
                const context1 = parser.createSequenceContext({
                    arrayPath: 'items',
                    arrayInstanceId: 'items_order_1'
                });

                const result1 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context1
                );
                const result2 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context1
                );

                // Second array instance (different order)
                const context2 = parser.createSequenceContext({
                    arrayPath: 'items',
                    arrayInstanceId: 'items_order_2'
                });

                const result3 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context2
                );

                assert.isTrue(result1.success);
                assert.isTrue(result2.success);
                assert.isTrue(result3.success);

                const data1 = JSON.parse(result1.processedJson!);
                const data2 = JSON.parse(result2.processedJson!);
                const data3 = JSON.parse(result3.processedJson!);

                // First instance: 1, 2
                assert.equal(data1.lineId, 1);
                assert.equal(data2.lineId, 2);
                // Second instance resets: 1
                assert.equal(data3.lineId, 1);
            });

            it('should return 1 when no context provided', async () => {
                const template = JSON.stringify({
                    lineId: '{{A8:sequence:local}}'
                });

                const result = await parser.processTemplateAsync(
                    template,
                    {},
                    undefined,
                    'test-endpoint',
                    mockSequenceManager
                    // No context provided
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);
                assert.equal(data.lineId, 1);
            });
        });

        describe(':global modifier', () => {
            let globalSequenceManager: {
                getNextSequence: (id: string) => Promise<number>;
                getNextArraySequence: (endpointId: string, arrayPath: string) => Promise<number>;
            };
            let arraySequenceCounters: Record<string, number>;

            beforeEach(() => {
                arraySequenceCounters = {};
                globalSequenceManager = {
                    getNextSequence: async (id: string) => ++sequenceCounter,
                    getNextArraySequence: async (endpointId: string, arrayPath: string) => {
                        const key = `${endpointId}:${arrayPath}`;
                        arraySequenceCounters[key] = (arraySequenceCounters[key] || 0) + 1;
                        return arraySequenceCounters[key];
                    }
                };
            });

            it('should use array-specific sequence counter', async () => {
                const template = JSON.stringify({
                    itemSequence: '{{A8:sequence:global}}'
                });

                const context = parser.createSequenceContext({
                    arrayPath: 'OriginalOrderLine'
                });

                const result1 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', globalSequenceManager, context
                );
                const result2 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', globalSequenceManager, context
                );

                assert.isTrue(result1.success);
                assert.isTrue(result2.success);

                const data1 = JSON.parse(result1.processedJson!);
                const data2 = JSON.parse(result2.processedJson!);

                // Global array sequence should increment: 1, 2
                assert.equal(data1.itemSequence, 1);
                assert.equal(data2.itemSequence, 2);
            });

            it('should maintain separate counters for different array paths', async () => {
                const template = JSON.stringify({
                    seq: '{{A8:sequence:global}}'
                });

                const contextItems = parser.createSequenceContext({ arrayPath: 'items' });
                const contextPackages = parser.createSequenceContext({ arrayPath: 'packages' });

                // Process items
                const itemResult1 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', globalSequenceManager, contextItems
                );
                const itemResult2 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', globalSequenceManager, contextItems
                );

                // Process packages
                const pkgResult1 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', globalSequenceManager, contextPackages
                );

                assert.isTrue(itemResult1.success);
                assert.isTrue(itemResult2.success);
                assert.isTrue(pkgResult1.success);

                const itemData1 = JSON.parse(itemResult1.processedJson!);
                const itemData2 = JSON.parse(itemResult2.processedJson!);
                const pkgData1 = JSON.parse(pkgResult1.processedJson!);

                // Items should have: 1, 2
                assert.equal(itemData1.seq, 1);
                assert.equal(itemData2.seq, 2);
                // Packages should start fresh: 1
                assert.equal(pkgData1.seq, 1);
            });
        });

        describe(':parent modifier', () => {
            it('should inherit parent sequence value', async () => {
                const template = JSON.stringify({
                    orderId: '{{A8:sequence:parent}}'
                });

                const parentSequence = 555;
                const context = parser.createSequenceContext({
                    parentSequence: parentSequence,
                    arrayPath: 'orderLines'
                });

                const result = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);
                assert.equal(data.orderId, parentSequence);
            });

            it('should use same parent value for all items in array', async () => {
                const template = JSON.stringify({
                    parentOrderId: '{{A8:sequence:parent}}'
                });

                const parentSequence = 999;
                const context = parser.createSequenceContext({
                    parentSequence: parentSequence,
                    arrayPath: 'items'
                });

                const result1 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );
                const result2 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );
                const result3 = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );

                assert.isTrue(result1.success);
                assert.isTrue(result2.success);
                assert.isTrue(result3.success);

                const data1 = JSON.parse(result1.processedJson!);
                const data2 = JSON.parse(result2.processedJson!);
                const data3 = JSON.parse(result3.processedJson!);

                // All should have the same parent sequence
                assert.equal(data1.parentOrderId, parentSequence);
                assert.equal(data2.parentOrderId, parentSequence);
                assert.equal(data3.parentOrderId, parentSequence);
            });

            it('should return 0 when no parent sequence available', async () => {
                const template = JSON.stringify({
                    parentId: '{{A8:sequence:parent}}'
                });

                // Context without parent sequence
                const context = parser.createSequenceContext({
                    arrayPath: 'items'
                });

                const result = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);
                // Should return 0 when no parent
                assert.equal(data.parentId, 0);
            });
        });

        describe('createChildSequenceContext', () => {
            it('should create child context with parent sequence', () => {
                const parentContext = parser.createSequenceContext({
                    arrayPath: 'orders'
                });

                const childContext = parser.createChildSequenceContext(
                    parentContext,
                    123, // Parent's sequence value
                    'orders[].items',
                    'items_order_1'
                );

                assert.equal(childContext.parentSequence, 123);
                assert.equal(childContext.arrayPath, 'orders[].items');
                assert.equal(childContext.arrayInstanceId, 'items_order_1');
                assert.instanceOf(childContext.localCounters, Map);
                assert.equal(childContext.localCounters.size, 0); // Fresh counters
            });
        });

        describe('mixed modifiers', () => {
            it('should handle multiple modifier types in same template', async () => {
                const template = JSON.stringify({
                    orderId: '{{A8:sequence}}',
                    lineNumber: '{{A8:sequence:local}}',
                    parentRef: '{{A8:sequence:parent}}'
                });

                const context = parser.createSequenceContext({
                    parentSequence: 500,
                    arrayPath: 'orderLines',
                    arrayInstanceId: 'lines_order_1'
                });

                const result = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);

                // Default sequence (should be 1001)
                assert.equal(data.orderId, 1001);
                // Local sequence (first in this context)
                assert.equal(data.lineNumber, 1);
                // Parent sequence
                assert.equal(data.parentRef, 500);
            });
        });

        describe('modifier parsing', () => {
            it('should parse modifier without type correctly', async () => {
                const template = JSON.stringify({
                    seq: '{{A8:sequence:local}}'
                });

                const context = parser.createSequenceContext({ arrayPath: 'test' });
                const result = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager, context
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);
                assert.equal(data.seq, 1);
                assert.isNumber(data.seq); // Should be number by default
            });

            it('should preserve backward compatibility with A8:sequence without modifier', async () => {
                const template = JSON.stringify({
                    id: '{{A8:sequence}}',
                    ref: '{{A8:sequence}}'
                });

                const result = await parser.processTemplateAsync(
                    template, {}, undefined, 'test-endpoint', mockSequenceManager
                );

                assert.isTrue(result.success);
                const data = JSON.parse(result.processedJson!);

                // Both should have same value (default behavior)
                assert.equal(data.id, data.ref);
                assert.equal(data.id, 1001);
            });
        });
    });
});