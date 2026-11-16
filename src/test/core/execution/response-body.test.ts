// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #115: JSON Lines responses. One body, one transaction; its lines become records.
 */
import { expect } from 'chai';
import { parseResponseBody } from '../../../services/execution/response-body';

const JSONL = '{"id":1,"sku":"A"}\n{"id":2,"sku":"B"}\n{"id":3,"sku":"C"}\n';

describe('parseResponseBody (Issue #115)', () => {
    it('declared JSONL: every line is a record; blank lines and CRLF are fine', () => {
        const { data, format } = parseResponseBody('{"id":1}\r\n\r\n{"id":2}\r\n', 'application/x-ndjson; charset=utf-8');
        expect(data).to.deep.equal([{ id: 1 }, { id: 2 }]);
        expect(format).to.deep.equal({ kind: 'jsonl', records: 2, invalid: [], invalidCount: 0 });
    });

    for (const type of ['application/jsonl', 'application/x-jsonlines', 'application/ndjson', 'text/jsonl']) {
        it(`${type} is JSONL`, () => {
            expect(parseResponseBody(JSONL, type).format?.records).to.equal(3);
        });
    }

    it('a .jsonl URL is JSONL whatever the content type (files served as text or octet-stream)', () => {
        const { format } = parseResponseBody(JSONL, 'application/octet-stream', 'https://api.cafe/feed/allocation.jsonl');
        expect(format?.records).to.equal(3);
    });

    it('a line that is not JSON (a stream cut off mid-line) is kept as invalid, the rest are records', () => {
        const { data, format } = parseResponseBody('{"id":1}\n{"id":2}\n{"id":3,"sk', 'application/x-ndjson');
        expect(data).to.deep.equal([{ id: 1 }, { id: 2 }]);
        expect(format?.invalidCount).to.equal(1);
        expect(format?.invalid).to.deep.equal([{ line: 3, text: '{"id":3,"sk' }]);
    });

    it('labelled JSONL but a pretty-printed JSON document: read as JSON', () => {
        const pretty = JSON.stringify({ data: [{ id: 1 }] }, null, 2);
        expect(parseResponseBody(pretty, 'application/x-ndjson')).to.deep.equal({ data: { data: [{ id: 1 }] } });
    });

    it('JSON is still JSON', () => {
        expect(parseResponseBody('{"data":[{"id":1}]}', 'application/json')).to.deep.equal({ data: { data: [{ id: 1 }] } });
        expect(parseResponseBody('{"a":1}', 'application/vnd.api+json')).to.deep.equal({ data: { a: 1 } });
    });

    it('JSONL sent as application/json is JSONL (it used to fail the transaction and lose the body)', () => {
        const { data, format } = parseResponseBody(JSONL, 'application/json');
        expect(format?.kind).to.equal('jsonl');
        expect((data as unknown[]).length).to.equal(3);
    });

    it('a JSON content type with an empty or non-JSON body keeps the text', () => {
        expect(parseResponseBody('', 'application/json')).to.deep.equal({ data: '' });
        expect(parseResponseBody('<html>Bad Gateway</html>', 'application/json')).to.deep.equal({ data: '<html>Bad Gateway</html>' });
    });

    it('text that happens to be JSONL (two or more object lines) is JSONL; other text stays text', () => {
        expect(parseResponseBody(JSONL, 'text/plain').format?.records).to.equal(3);
        expect(parseResponseBody('{"id":1}', 'text/plain')).to.deep.equal({ data: '{"id":1}' });
        expect(parseResponseBody('{"id":1}\nnot json', 'text/plain')).to.deep.equal({ data: '{"id":1}\nnot json' });
        expect(parseResponseBody('created', 'text/plain')).to.deep.equal({ data: 'created' });
        expect(parseResponseBody('1\n2\n3', undefined)).to.deep.equal({ data: '1\n2\n3' });
    });
});
