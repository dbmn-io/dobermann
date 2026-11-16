// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { parseSharedEndpointText } from '../../../../webviews/endpoint/shared-endpoint-parser';

/**
 * GitHub Issue #278 — the paste round-trip. What Share puts on the clipboard
 * must paste back, in BOTH forms, and the footer must never leak into the body.
 */
describe('parseSharedEndpointText (#278)', () => {
    const BODY = `[
  {
    "gtin": "{{gtin}}",
    "sku": "{{sku}}",
    "description": "{{description:string|null}}",
    "locationGln": "{{locationGln}}",
    "locationName": "{{locationName:string|opt}}",
    "quantityOnHand": "{{quantityOnHand:number|>=0}}",
    "uom": "{{uom}}",
    "status": "{{status}}"
  }
]`;

    const META = `// Name: Bulk Inventory Uploader
// Method: POST
// Path: /inventory`;

    it('parses the rendered-card form (DBMN Endpoint title + ⚡ footer)', () => {
        const text = `DBMN Endpoint\n\n${META}\n\n${BODY}\n⚡ Dobermann | Paste & test instantly → dbmn.io`;
        const ep = parseSharedEndpointText(text);
        expect(ep).to.not.equal(null);
        expect(ep!.name).to.equal('Bulk Inventory Uploader');
        expect(ep!.method).to.equal('POST');
        expect(ep!.path).to.equal('/inventory');
        expect(ep!.body).to.equal(BODY);
        // The footer must not be in the body.
        expect(ep!.body).to.not.match(/⚡|Dobermann|dbmn\.io/);
    });

    it('parses the clean plain-text form (no title, no footer)', () => {
        const text = `${META}\n\n${BODY}`;
        const ep = parseSharedEndpointText(text);
        expect(ep).to.not.equal(null);
        expect(ep!.name).to.equal('Bulk Inventory Uploader');
        expect(ep!.method).to.equal('POST');
        expect(ep!.path).to.equal('/inventory');
        expect(ep!.body).to.equal(BODY);
    });

    it('both forms yield an identical parse', () => {
        const rendered = parseSharedEndpointText(
            `DBMN Endpoint\n\n${META}\n\n${BODY}\n⚡ Dobermann | Paste & test instantly → dbmn.io`
        );
        const clean = parseSharedEndpointText(`${META}\n\n${BODY}`);
        expect(rendered).to.deep.equal(clean);
    });

    it('keeps an object (non-array) body intact', () => {
        const objBody = `{\n  "sku": "{{sku}}"\n}`;
        const ep = parseSharedEndpointText(`${META}\n\n${objBody}`);
        expect(ep!.body).to.equal(objBody);
    });

    it('parses headers and query params from the JSONC comments', () => {
        const text =
            `// Name: X\n// Method: GET\n// Path: /x\n` +
            `// Header: Authorization: Bearer {{token}} [enabled]\n` +
            `// QueryParam: page: {{page}} [disabled]\n\n` +
            `{ "a": 1 }`;
        const ep = parseSharedEndpointText(text);
        expect(ep!.headers).to.deep.equal([{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }]);
        expect(ep!.queryParams).to.deep.equal([{ key: 'page', value: '{{page}}', enabled: false }]);
    });

    it('still accepts the legacy Name:/Method:/Path:/Body: format', () => {
        const text = `Name: Legacy\nMethod: put\nPath: /legacy\nBody:\n{ "x": 1 }`;
        const ep = parseSharedEndpointText(text);
        expect(ep!.name).to.equal('Legacy');
        expect(ep!.method).to.equal('PUT');
        expect(ep!.path).to.equal('/legacy');
        expect(ep!.body).to.equal('{ "x": 1 }');
    });

    it('defaults method to GET when omitted', () => {
        const ep = parseSharedEndpointText(`// Name: N\n// Path: /p\n\n{}`);
        expect(ep!.method).to.equal('GET');
    });

    it('returns null for empty / non-endpoint text', () => {
        expect(parseSharedEndpointText('')).to.equal(null);
        expect(parseSharedEndpointText('just some random text')).to.equal(null);
        // Issue #291: a name without a path still resolves (partial pastes
        // must map whatever they carry) — see the #291 suite below.
        expect(parseSharedEndpointText(`// Name: NoPath\n\n{}`)).to.not.equal(null);
    });
});

/**
 * GitHub Issue #291 — pastes that arrive whitespace-collapsed (Teams/chat
 * flatten the card to one line), on Windows line endings, or with only a
 * few metadata fields must still resolve. These are the exact texts from the
 * issue.
 */
describe('parseSharedEndpointText (#291) — flattened / partial pastes', () => {
    it('parses the issue\'s one-line POST card (name, method, path AND body)', () => {
        const text = 'DBMN Endpoint  // Name: Search nventory by Location // Method: POST ' +
            '// Path: /dcinventory/api/dcinventory/inventory/search  ' +
            '{   "Size" : 500,   "Query": "LocationId = {{LocationId}}" } ' +
            '⚡ Dobermann | Paste & test instantly → dbmn.io';
        const ep = parseSharedEndpointText(text);
        expect(ep, 'one-line card must be recognised').to.not.equal(null);
        expect(ep!.name).to.equal('Search nventory by Location');
        expect(ep!.method).to.equal('POST');
        expect(ep!.path).to.equal('/dcinventory/api/dcinventory/inventory/search');
        expect(ep!.body).to.equal('{   "Size" : 500,   "Query": "LocationId = {{LocationId}}" }');
        expect(JSON.parse(ep!.body!.replace('{{LocationId}}', 'X'))).to.deep.equal({ Size: 500, Query: 'LocationId = X' });
    });

    it('parses the issue\'s GET card with query params and a markdown-link footer', () => {
        const text = 'DBMN Endpoint\n\n' +
            '// Name: Get Locations\n// Method: GET\n// Path: /dcinventory/api/dcinventory/location\n' +
            '// QueryParam: page: {{A8:PAGE:0:header.totalCount}} [enabled]\n' +
            '// QueryParam: size: {{A8:SIZE:1000:header.size}} [enabled]\n' +
            '⚡ Dobermann | Paste & test instantly → [dbmn.io](https://dbmn.io/)';
        const ep = parseSharedEndpointText(text);
        expect(ep).to.not.equal(null);
        expect(ep!.name).to.equal('Get Locations');
        expect(ep!.method).to.equal('GET');
        expect(ep!.path).to.equal('/dcinventory/api/dcinventory/location');
        expect(ep!.queryParams).to.deep.equal([
            { key: 'page', value: '{{A8:PAGE:0:header.totalCount}}', enabled: true },
            { key: 'size', value: '{{A8:SIZE:1000:header.size}}', enabled: true }
        ]);
        expect(ep!.body).to.equal(undefined);
    });

    it('parses the GET card when it has been flattened to one line (query params keep their {{A8}} values)', () => {
        const text = 'DBMN Endpoint // Name: Get Locations // Method: GET // Path: /dcinventory/api/dcinventory/location ' +
            '// QueryParam: page: {{A8:PAGE:0:header.totalCount}} [enabled] ' +
            '// QueryParam: size: {{A8:SIZE:1000:header.size}} [enabled] ⚡ Dobermann | Paste & test instantly → dbmn.io';
        const ep = parseSharedEndpointText(text);
        expect(ep).to.not.equal(null);
        expect(ep!.path).to.equal('/dcinventory/api/dcinventory/location');
        expect(ep!.queryParams).to.deep.equal([
            { key: 'page', value: '{{A8:PAGE:0:header.totalCount}}', enabled: true },
            { key: 'size', value: '{{A8:SIZE:1000:header.size}}', enabled: true }
        ]);
        expect(ep!.body).to.equal(undefined);
    });

    it('parses a flattened header line followed by a body', () => {
        const text = '// Name: H // Method: POST // Path: /h // Header: X-Trace: {{trace}} [disabled] { "a": 1 }';
        const ep = parseSharedEndpointText(text);
        expect(ep!.headers).to.deep.equal([{ key: 'X-Trace', value: '{{trace}}', enabled: false }]);
        expect(ep!.body).to.equal('{ "a": 1 }');
    });

    it('handles Windows CRLF line endings and non-breaking spaces from rich-text pastes', () => {
        const text = 'DBMN Endpoint\r\n\r\n// Name: CRLF\r\n// Method: PUT\r\n// Path: /crlf\r\n\r\n{\r\n  "a": 1\r\n}\r\n⚡ Dobermann | Paste & test instantly → dbmn.io';
        const ep = parseSharedEndpointText(text);
        expect(ep).to.not.equal(null);
        expect(ep!.name).to.equal('CRLF');
        expect(ep!.method).to.equal('PUT');
        expect(ep!.path).to.equal('/crlf');
        expect(ep!.body).to.equal('{\n  "a": 1\n}');
    });

    it('does not let a body that shares the Path line pollute the path', () => {
        const ep = parseSharedEndpointText('// Name: N\n// Method: POST\n// Path: /p { "x": 1 }');
        expect(ep!.path).to.equal('/p');
        expect(ep!.body).to.equal('{ "x": 1 }');
    });

    it('still resolves when only some metadata is present (name only, path only)', () => {
        const nameOnly = parseSharedEndpointText('// Name: Just a name\n\n{ "a": 1 }');
        expect(nameOnly).to.not.equal(null);
        expect(nameOnly!.name).to.equal('Just a name');
        expect(nameOnly!.method).to.equal('GET');
        expect(nameOnly!.body).to.equal('{ "a": 1 }');

        const pathOnly = parseSharedEndpointText('// Path: /only/path');
        expect(pathOnly).to.not.equal(null);
        expect(pathOnly!.path).to.equal('/only/path');
    });

    it('still rejects text with no endpoint metadata at all', () => {
        expect(parseSharedEndpointText('{ "a": 1 }')).to.equal(null);
        expect(parseSharedEndpointText('// just a comment\n{ "a": 1 }')).to.equal(null);
        expect(parseSharedEndpointText('https://example.com//Name: not metadata')).to.equal(null);
    });

    it('multi-line rendered card and its flattened twin parse to the same endpoint (body whitespace aside)', () => {
        const meta = '// Name: Twin\n// Method: POST\n// Path: /twin\n// QueryParam: q: {{q}} [enabled]';
        const multi = parseSharedEndpointText(`DBMN Endpoint\n\n${meta}\n\n{ "a": 1 }\n⚡ Dobermann | Paste & test instantly → dbmn.io`);
        const flat = parseSharedEndpointText(`DBMN Endpoint ${meta.replace(/\n/g, ' ')} { "a": 1 } ⚡ Dobermann | Paste & test instantly → dbmn.io`);
        expect(flat).to.deep.equal(multi);
    });
    describe('cards from other versions', () => {
        it('reads a Tags line, normalised like the tag editor', () => {
            const ep = parseSharedEndpointText('// Name: T\n// Method: GET\n// Path: /t\n// Tags: Puppy-School, reporting , puppy-school\n');
            expect(ep!.tags).to.deep.equal(['puppy-school', 'reporting']);
        });

        it('treats a header or query param without a flag as enabled', () => {
            const ep = parseSharedEndpointText(
                '// Name: T\n// Method: GET\n// Path: /t\n' +
                '// QueryParam: page: {{A8:PAGE:0:totalCount}}\n// QueryParam: order: desc [disabled]\n// Header: X-Trace: on\n');
            expect(ep!.queryParams).to.deep.equal([
                { key: 'page', value: '{{A8:PAGE:0:totalCount}}', enabled: true },
                { key: 'order', value: 'desc', enabled: false }
            ]);
            expect(ep!.headers).to.deep.equal([{ key: 'X-Trace', value: 'on', enabled: true }]);
        });

        it('ignores metadata keys it does not know, in a multi-line card', () => {
            const ep = parseSharedEndpointText(
                '// Name: T\n// Method: POST\n// Path: /t\n// Colour: blue\n// QueryParam: q: 1\n// Retry-Policy: 3x\n\n{ "a": 1 }');
            expect(ep!.name).to.equal('T');
            expect(ep!.queryParams).to.deep.equal([{ key: 'q', value: '1', enabled: true }]);
            expect(ep!.body).to.equal('{ "a": 1 }');
            expect(ep).to.not.have.property('colour');
        });

        it('ignores unknown keys in a flattened card without bleeding them into the value before', () => {
            const ep = parseSharedEndpointText(
                'DBMN Endpoint // Name: T // Method: GET // Path: /t // Description: enter the matrix // Tags: puppy-school ' +
                '// Colour: blue // QueryParam: page: {{A8:PAGE:0:totalCount}} // QueryParam: size: 100 ⚡ Dobermann | Paste & test instantly → dbmn.io');
            expect(ep!.description).to.equal('enter the matrix');
            expect(ep!.tags).to.deep.equal(['puppy-school']);
            expect(ep!.queryParams).to.deep.equal([
                { key: 'page', value: '{{A8:PAGE:0:totalCount}}', enabled: true },
                { key: 'size', value: '100', enabled: true }
            ]);
        });

        it('separates a body glued onto an unflagged query param in a flattened card', () => {
            const ep = parseSharedEndpointText(
                '// Name: T // Method: POST // Path: /t // QueryParam: page: {{A8:PAGE:0:totalCount}} { "a": 1 } ⚡ Dobermann | Paste & test instantly → dbmn.io');
            expect(ep!.queryParams).to.deep.equal([{ key: 'page', value: '{{A8:PAGE:0:totalCount}}', enabled: true }]);
            expect(ep!.body).to.equal('{ "a": 1 }');
        });
    });
});
