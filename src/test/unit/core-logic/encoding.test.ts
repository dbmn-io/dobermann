// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for BASE64 encoding utility (Issue #127)
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    encodeBase64Fields,
    decodeBase64Fields,
    calculateJsonSize,
    formatFileSize
} from '../../../utils/encoding';

describe('encodeBase64Fields', () => {
    describe('Marker Detection', () => {
        it('should detect encoding marker in simple object', () => {
            const input = JSON.stringify({
                'data:BASE64': { ItemId: 'TEST1' }
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(true);
            expect(result.keysEncoded).to.deep.equal(['data']);
        });

        it('should return false when no encoding markers present', () => {
            const input = JSON.stringify({
                data: { ItemId: 'TEST1' }
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(false);
            expect(result.keysEncoded).to.deep.equal([]);
        });

        it('should detect multiple encoding markers', () => {
            const input = JSON.stringify({
                'payload1:BASE64': { type: 'A' },
                'payload2:BASE64': { type: 'B' }
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(true);
            expect(result.keysEncoded).to.have.length(2);
            expect(result.keysEncoded).to.include('payload1');
            expect(result.keysEncoded).to.include('payload2');
        });

        it('should detect encoding markers in nested objects', () => {
            const input = JSON.stringify({
                outer: {
                    'inner:BASE64': { value: 'nested' }
                }
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(true);
            expect(result.keysEncoded).to.deep.equal(['inner']);
        });

        it('should detect encoding markers in array elements', () => {
            const input = JSON.stringify({
                messages: [
                    { 'data:BASE64': { type: 'A' } },
                    { 'data:BASE64': { type: 'B' } }
                ]
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(true);
            expect(result.keysEncoded).to.deep.equal(['data', 'data']);
        });
    });

    describe('BASE64 Encoding Correctness', () => {
        it('should correctly BASE64 encode simple object', () => {
            const input = JSON.stringify({
                'data:BASE64': { ItemId: 'TEST1', Qty: 5 }
            }, null, 2);

            const result = encodeBase64Fields(input);

            const encoded = JSON.parse(result.encodedJson);
            expect(encoded).to.have.property('data');
            expect(typeof encoded.data).to.equal('string');

            // Decode to verify correctness
            const decoded = Buffer.from(encoded.data, 'base64').toString('utf-8');
            const decodedObj = JSON.parse(decoded);
            expect(decodedObj).to.deep.equal({ ItemId: 'TEST1', Qty: 5 });
        });

        it('should encode array values correctly', () => {
            const input = JSON.stringify({
                'data:BASE64': [{ id: 1 }, { id: 2 }]
            });

            const result = encodeBase64Fields(input);

            const encoded = JSON.parse(result.encodedJson);
            const decoded = Buffer.from(encoded.data, 'base64').toString('utf-8');
            const decodedArray = JSON.parse(decoded);

            expect(Array.isArray(decodedArray)).to.equal(true);
            expect(decodedArray).to.have.length(2);
            expect(decodedArray[0]).to.deep.equal({ id: 1 });
        });

        it('should handle special characters in encoded content', () => {
            const input = JSON.stringify({
                'data:BASE64': {
                    message: 'Hello "World" with \'quotes\' and \nnewlines',
                    emoji: '🎉',
                    unicode: 'Café'
                }
            });

            const result = encodeBase64Fields(input);

            const encoded = JSON.parse(result.encodedJson);
            const decoded = Buffer.from(encoded.data, 'base64').toString('utf-8');
            const decodedObj = JSON.parse(decoded);

            expect(decodedObj.message).to.equal('Hello "World" with \'quotes\' and \nnewlines');
            expect(decodedObj.emoji).to.equal('🎉');
            expect(decodedObj.unicode).to.equal('Café');
        });

        it('should encode nested objects within marked field', () => {
            const input = JSON.stringify({
                'data:BASE64': {
                    level1: {
                        level2: {
                            level3: 'deep value'
                        }
                    }
                }
            });

            const result = encodeBase64Fields(input);

            const encoded = JSON.parse(result.encodedJson);
            const decoded = Buffer.from(encoded.data, 'base64').toString('utf-8');
            const decodedObj = JSON.parse(decoded);

            expect(decodedObj.level1.level2.level3).to.equal('deep value');
        });
    });

    describe('Dual Output (Encoded + Unencoded)', () => {
        it('should return both encoded and unencoded versions', () => {
            const input = JSON.stringify({
                attributes: { user: 'admin' },
                'data:BASE64': { ItemId: 'TEST1' }
            }, null, 2);

            const result = encodeBase64Fields(input);

            // Unencoded should have original structure
            const unencoded = JSON.parse(result.unencodedJson);
            expect(unencoded.attributes).to.deep.equal({ user: 'admin' });
            expect(unencoded['data:BASE64']).to.deep.equal({ ItemId: 'TEST1' });

            // Encoded should have BASE64 string
            const encoded = JSON.parse(result.encodedJson);
            expect(encoded.attributes).to.deep.equal({ user: 'admin' });
            expect(typeof encoded.data).to.equal('string');
            expect(encoded.data).to.match(/^[A-Za-z0-9+/=]+$/); // BASE64 pattern
        });

        it('should preserve non-encoded fields in both versions', () => {
            const input = JSON.stringify({
                wrapper: {
                    attributes: { type: 'test', version: 2 },
                    'payload:BASE64': { data: 'content' }
                }
            });

            const result = encodeBase64Fields(input);

            const unencoded = JSON.parse(result.unencodedJson);
            const encoded = JSON.parse(result.encodedJson);

            // Both should have identical attributes
            expect(unencoded.wrapper.attributes).to.deep.equal({ type: 'test', version: 2 });
            expect(encoded.wrapper.attributes).to.deep.equal({ type: 'test', version: 2 });
        });

        it('should handle template with no encoding markers (passthrough)', () => {
            const input = JSON.stringify({
                simple: { key: 'value', number: 42 }
            }, null, 2);

            const result = encodeBase64Fields(input);

            // Both versions should be identical
            expect(result.encodedJson).to.equal(result.unencodedJson);
            expect(result.hasEncodingMarkers).to.equal(false);
        });
    });

    describe('Error Handling', () => {
        it('should throw error for invalid JSON', () => {
            const invalidJson = '{ invalid json }';

            expect(() => encodeBase64Fields(invalidJson)).to.throw('Invalid JSON');
        });

        it('should throw error for encoding marker on primitive value', () => {
            const input = JSON.stringify({
                'data:BASE64': 'string value'
            });

            expect(() => encodeBase64Fields(input)).to.throw(
                'Encoding marker on primitive value'
            );
        });

        it('should throw error for encoding marker on number', () => {
            const input = JSON.stringify({
                'data:BASE64': 123
            });

            expect(() => encodeBase64Fields(input)).to.throw(
                'Encoding markers can only be applied to objects or arrays'
            );
        });

        it('should throw error for encoding marker on null', () => {
            const input = JSON.stringify({
                'data:BASE64': null
            });

            expect(() => encodeBase64Fields(input)).to.throw(
                'Encoding marker on primitive value'
            );
        });
    });

    describe('Complex Scenarios', () => {
        it('should handle PubSub message wrapper (real-world example)', () => {
            const input = JSON.stringify({
                messages: [
                    {
                        attributes: {
                            User: 'admin@company.com',
                            MSG_TYPE: 'ITEM_CREATE',
                            Organization: 'ORG-123'
                        },
                        'data:BASE64': {
                            ItemId: 'TESTITEM1',
                            Description: 'Test Item',
                            Weight: 1.5,
                            WeightUomId: 'kg',
                            ItemCode: [
                                {
                                    CodeType: 'GTIN',
                                    CodeValue: '12345678'
                                }
                            ]
                        }
                    }
                ]
            });

            const result = encodeBase64Fields(input);

            expect(result.hasEncodingMarkers).to.equal(true);
            expect(result.keysEncoded).to.deep.equal(['data']);

            const encoded = JSON.parse(result.encodedJson);
            expect(encoded.messages[0].attributes.User).to.equal('admin@company.com');
            expect(typeof encoded.messages[0].data).to.equal('string');

            // Verify encoded content
            const decoded = Buffer.from(encoded.messages[0].data, 'base64').toString('utf-8');
            const decodedData = JSON.parse(decoded);
            expect(decodedData.ItemId).to.equal('TESTITEM1');
            expect(decodedData.ItemCode).to.have.length(1);
            expect(decodedData.ItemCode[0].CodeType).to.equal('GTIN');
        });

        it('should handle multiple messages with individual encoding', () => {
            const input = JSON.stringify({
                messages: [
                    { id: 1, 'payload:BASE64': { type: 'A', value: 100 } },
                    { id: 2, 'payload:BASE64': { type: 'B', value: 200 } },
                    { id: 3, 'payload:BASE64': { type: 'C', value: 300 } }
                ]
            });

            const result = encodeBase64Fields(input);

            expect(result.keysEncoded).to.have.length(3);

            const encoded = JSON.parse(result.encodedJson);
            expect(encoded.messages).to.have.length(3);

            // Verify each message encoded independently
            for (let i = 0; i < 3; i++) {
                expect(encoded.messages[i].id).to.equal(i + 1);
                expect(typeof encoded.messages[i].payload).to.equal('string');

                const decoded = Buffer.from(encoded.messages[i].payload, 'base64').toString('utf-8');
                const decodedPayload = JSON.parse(decoded);
                expect(decodedPayload.value).to.equal((i + 1) * 100);
            }
        });

        it('should preserve JSON formatting (2-space indentation)', () => {
            const input = JSON.stringify({
                'data:BASE64': { test: 'value' }
            }, null, 2);

            const result = encodeBase64Fields(input);

            // Check that output has proper indentation
            expect(result.encodedJson).to.include('  '); // Has indentation
            expect(result.unencodedJson).to.include('  ');
        });
    });
});

describe('decodeBase64Fields', () => {
    it('should decode BASE64 encoded fields back to objects', () => {
        const original = { ItemId: 'TEST1', Qty: 5 };
        const base64 = Buffer.from(JSON.stringify(original)).toString('base64');

        const input = JSON.stringify({ data: base64 });

        const result = decodeBase64Fields(input);
        const decoded = JSON.parse(result);

        expect(decoded.data).to.deep.equal(original);
    });

    it('should handle nested BASE64 fields', () => {
        const payload1 = { type: 'A' };
        const payload2 = { type: 'B' };

        const input = JSON.stringify({
            messages: [
                { payload: Buffer.from(JSON.stringify(payload1)).toString('base64') },
                { payload: Buffer.from(JSON.stringify(payload2)).toString('base64') }
            ]
        });

        const result = decodeBase64Fields(input);
        const decoded = JSON.parse(result);

        expect(decoded.messages[0].payload).to.deep.equal(payload1);
        expect(decoded.messages[1].payload).to.deep.equal(payload2);
    });

    it('should leave non-BASE64 strings unchanged', () => {
        const input = JSON.stringify({
            normalString: 'hello world',
            number: 42,
            data: Buffer.from(JSON.stringify({ test: 'value' })).toString('base64')
        });

        const result = decodeBase64Fields(input);
        const decoded = JSON.parse(result);

        expect(decoded.normalString).to.equal('hello world');
        expect(decoded.number).to.equal(42);
        expect(decoded.data).to.deep.equal({ test: 'value' });
    });
});

describe('calculateJsonSize', () => {
    it('should calculate size in bytes correctly', () => {
        const json = '{"test":"value"}';
        const size = calculateJsonSize(json);

        expect(size).to.equal(Buffer.from(json, 'utf-8').length);
    });

    it('should handle empty JSON', () => {
        const size = calculateJsonSize('{}');
        expect(size).to.equal(2); // 2 bytes for '{}'
    });

    it('should handle unicode characters', () => {
        const json = '{"emoji":"🎉"}';
        const size = calculateJsonSize(json);

        // Emoji takes 4 bytes in UTF-8
        expect(size).to.be.greaterThan(json.length);
    });
});

describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
        expect(formatFileSize(0)).to.equal('0 B');
        expect(formatFileSize(100)).to.equal('100.0 B');
        expect(formatFileSize(512)).to.equal('512.0 B');
    });

    it('should format kilobytes correctly', () => {
        expect(formatFileSize(1024)).to.equal('1.0 KB');
        expect(formatFileSize(2048)).to.equal('2.0 KB');
        expect(formatFileSize(1536)).to.equal('1.5 KB');
    });

    it('should format megabytes correctly', () => {
        expect(formatFileSize(1024 * 1024)).to.equal('1.0 MB');
        expect(formatFileSize(3 * 1024 * 1024)).to.equal('3.0 MB');
        expect(formatFileSize(1.5 * 1024 * 1024)).to.equal('1.5 MB');
    });

    it('should use appropriate unit for size', () => {
        expect(formatFileSize(500)).to.include('B');
        expect(formatFileSize(5000)).to.include('KB');
        expect(formatFileSize(5000000)).to.include('MB');
    });
});
