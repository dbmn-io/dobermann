// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prettyPrint } = require('../../../../webviews/shared/jsonc-parser');

describe('jsonc-parser prettyPrint — comments stay where they were written (Issue #305)', () => {
    it('keeps a trailing comment after a comma on its line', () => {
        const input = [
            '{',
            '  // "Query": "Volume > 0",',
            '  // "Query": "ItemId = ACAU-{/{SKU:string}}"',
            '  "Size": "{{A8:SIZE:10000}}", //200000',
            '  "Page": "{{A8:PAGE:0}}",',
            '  "Template": {',
            '    "ItemId": null,',
            '    "UnitPrice": null',
            '  }',
            '}'
        ].join('\n');
        expect(prettyPrint(input)).to.equal(input);
    });

    it('keeps a trailing comment after an opening brace or bracket on its line', () => {
        const input = '{\n  "Template": { // what we get back\n    "ItemId": null\n  },\n  "Lines": [ // one per SKU\n    1\n  ]\n}';
        expect(prettyPrint(input)).to.equal(input);
    });

    it('keeps a trailing comment on the last value and on a closing brace', () => {
        const input = '{\n  "a": {\n    "b": null // last\n  } // end of a\n}';
        expect(prettyPrint(input)).to.equal(input);
    });

    it('still gives a full-line comment its own line', () => {
        expect(prettyPrint('{"a": 1,\n// note\n"b": 2}')).to.equal('{\n  "a": 1,\n  // note\n  "b": 2\n}');
    });

    it('still reflows collapsed JSON (Issue #260)', () => {
        expect(prettyPrint('[ { "gtin": "x", "qty": 1 } ]')).to.equal('[\n  {\n    "gtin": "x",\n    "qty": 1\n  }\n]');
    });
});
