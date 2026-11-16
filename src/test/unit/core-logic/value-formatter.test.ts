// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { detectValueType, formatValue } = require('../../../webviews/shared/value-formatter.js');

// GitHub Issue #271: smart formatting for long cell values (JSON, escaped JSON,
// BASE64, ZPL) shown in the cell-detail modal.

describe('value-formatter — detectValueType', () => {
    it('detects plain JSON objects and arrays', () => {
        expect(detectValueType('{"a":1,"b":[2,3]}')).to.equal('json');
        expect(detectValueType('[{"x":1}]')).to.equal('json');
    });

    it('detects escaped JSON (backslash-quoted)', () => {
        expect(detectValueType('{\\"Description\\":\\"hello\\",\\"n\\":1}')).to.equal('escaped-json');
    });

    it('detects ZPL label markup', () => {
        expect(detectValueType('^XA^FO50,50^FDHello^FS^XZ')).to.equal('zpl');
    });

    it('detects BASE64 blobs', () => {
        const b64 = Buffer.from('The quick brown fox jumps over').toString('base64');
        expect(detectValueType(b64)).to.equal('base64');
    });

    it('falls back to text for plain strings and short ids', () => {
        expect(detectValueType('ACAU-A5692931')).to.equal('text');
        expect(detectValueType('InventoryTransfer')).to.equal('text');
        expect(detectValueType('')).to.equal('text');
        expect(detectValueType(42)).to.equal('text');
        expect(detectValueType(null)).to.equal('text');
    });
});

describe('value-formatter — formatValue', () => {
    it('pretty-prints JSON', () => {
        const out = formatValue('{"a":1,"b":2}');
        expect(out.type).to.equal('json');
        expect(out.text).to.equal('{\n  "a": 1,\n  "b": 2\n}');
        expect(out.error).to.equal(undefined);
    });

    it('unescapes and pretty-prints escaped JSON', () => {
        const out = formatValue('{\\"a\\":1}');
        expect(out.type).to.equal('escaped-json');
        expect(out.text).to.equal('{\n  "a": 1\n}');
    });

    it('decodes BASE64 to its plain text', () => {
        const b64 = Buffer.from('The quick brown fox jumps over').toString('base64');
        const out = formatValue(b64);
        expect(out.type).to.equal('base64');
        expect(out.text).to.equal('The quick brown fox jumps over');
    });

    it('decodes BASE64 that wraps JSON and pretty-prints it', () => {
        const b64 = Buffer.from('{"wrapped":true}').toString('base64');
        const out = formatValue(b64);
        expect(out.type).to.equal('base64');
        expect(out.text).to.equal('{\n  "wrapped": true\n}');
    });

    it('passes ZPL through, normalising CRLF', () => {
        const out = formatValue('^XA\r\n^FDx^FS\r\n^XZ', 'zpl');
        expect(out.type).to.equal('zpl');
        expect(out.text).to.equal('^XA\n^FDx^FS\n^XZ');
    });

    it('honours an explicit format override', () => {
        const out = formatValue('{"a":1}', 'text');
        expect(out.type).to.equal('text');
        expect(out.text).to.equal('{"a":1}');
    });

    it('returns an error (never throws) on malformed JSON', () => {
        const out = formatValue('{not json', 'json');
        expect(out.error).to.be.a('string');
        expect(out.text).to.equal('{not json');
    });

    it('coerces null/undefined to empty text', () => {
        expect(formatValue(null).text).to.equal('');
        expect(formatValue(undefined).text).to.equal('');
    });
});

// Issue #271 (follow-up): deeply-nested payloads — a JSON field that is itself
// escaped JSON or a BASE64-of-JSON blob — should fully expand in 'deep' mode.
describe('value-formatter — deep expansion', () => {
    it('expands a nested escaped-JSON string field into a real object', () => {
        const header = '{"ADDITIONAL_ATTRIBUTES":"{\\"TXN\\":\\"7836\\"}","flag":"false"}';
        const out = formatValue(header, 'deep');
        expect(out.type).to.equal('deep');
        const parsed = JSON.parse(out.text);
        expect(parsed.ADDITIONAL_ATTRIBUTES).to.deep.equal({ TXN: '7836' });
        expect(parsed.flag).to.equal('false');
    });

    it('single-level JSON mode leaves the nested string escaped', () => {
        const header = '{"ADDITIONAL_ATTRIBUTES":"{\\"TXN\\":\\"7836\\"}"}';
        const out = formatValue(header, 'json');
        expect(JSON.parse(out.text).ADDITIONAL_ATTRIBUTES).to.equal('{"TXN":"7836"}');
    });

    it('decodes a BASE64-of-JSON field nested inside JSON', () => {
        const inner = Buffer.from('[{"ItemId":"A12313"}]').toString('base64');
        const outer = `{"messages":[{"data":"${inner}"}]}`;
        const out = formatValue(outer, 'deep');
        const parsed = JSON.parse(out.text);
        expect(parsed.messages[0].data).to.deep.equal([{ ItemId: 'A12313' }]);
    });

    it('never mangles an encrypted/opaque token that only looks like base64', () => {
        const token = 'NOTaREALtoken0000000+111111111111111111111/222222222222222222222333333333333333333=';
        const out = formatValue(`{"tok":"${token}"}`, 'deep');
        expect(JSON.parse(out.text).tok).to.equal(token);
    });

    it('deep on plain text falls back to text', () => {
        const out = formatValue('just some text', 'deep');
        expect(out.type).to.equal('text');
        expect(out.text).to.equal('just some text');
    });

    it('deep does not loop on self-referential-looking strings (depth-capped)', () => {
        // A string that always re-parses to another string should terminate.
        const nested = '"' + '\\"'.repeat(2) + 'x' + '\\"'.repeat(2) + '"';
        expect(() => formatValue(nested, 'deep')).to.not.throw();
    });
});
