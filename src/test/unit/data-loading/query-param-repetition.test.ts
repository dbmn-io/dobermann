// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for Query Parameter Repetition Helper (GitHub Issue #108)
 *
 * Tests the parsing of repeatable query parameter syntax: pattern[ separator ]
 * and calculation of URL length constraints for batching.
 */

import { expect } from 'chai';
import { QueryParamRepetitionHelper } from '../../../data-loading/query-param-repetition.helper';

describe('QueryParamRepetitionHelper', () => {
    let helper: QueryParamRepetitionHelper;

    beforeEach(() => {
        helper = new QueryParamRepetitionHelper();
    });

    describe('parseQueryParamPattern', () => {
        it('should parse basic repeatable pattern with "or" separator', () => {
            const result = helper.parseQueryParamPattern('ItemId={{ITEM}}[ or ]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('ItemId={{ITEM}}');
            expect(result.separator).to.equal(' or ');
        });

        it('should parse pattern with ampersand separator', () => {
            const result = helper.parseQueryParamPattern('ItemId={{ITEM}}[&]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('ItemId={{ITEM}}');
            expect(result.separator).to.equal('&');
        });

        it('should parse pattern with comma separator', () => {
            const result = helper.parseQueryParamPattern('status={{STATUS}}[,]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('status={{STATUS}}');
            expect(result.separator).to.equal(',');
        });

        it('should parse pattern with pipe separator', () => {
            const result = helper.parseQueryParamPattern('id={{ID}}[ | ]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('id={{ID}}');
            expect(result.separator).to.equal(' | ');
        });

        it('should parse empty brackets as default ampersand separator', () => {
            const result = helper.parseQueryParamPattern('ItemId={{ITEM}}[]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('ItemId={{ITEM}}');
            expect(result.separator).to.equal('&');
        });

        it('should handle pattern without brackets as non-repeatable', () => {
            const result = helper.parseQueryParamPattern('ItemId={{ITEM}}');

            expect(result.isRepeatable).to.be.false;
            expect(result.pattern).to.be.undefined;
            expect(result.separator).to.be.undefined;
        });

        it('should preserve spaces in separator', () => {
            const result = helper.parseQueryParamPattern('ItemId={{ITEM}}[  or  ]');

            expect(result.separator).to.equal('  or  ');
        });

        it('should handle complex pattern with prefix', () => {
            const result = helper.parseQueryParamPattern('ItemId=ACAU-{{ITEM}}[ or ]');

            expect(result.isRepeatable).to.be.true;
            expect(result.pattern).to.equal('ItemId=ACAU-{{ITEM}}');
            expect(result.separator).to.equal(' or ');
        });
    });

    describe('extractTemplateVariables', () => {
        it('should extract single template variable', () => {
            const variables = helper.extractTemplateVariables('ItemId={{ITEM}}');

            expect(variables).to.deep.equal(['ITEM']);
        });

        it('should extract multiple template variables', () => {
            const variables = helper.extractTemplateVariables('ItemId={{ITEM}}&status={{STATUS}}');

            expect(variables).to.deep.equal(['ITEM', 'STATUS']);
        });

        it('should handle pattern without variables', () => {
            const variables = helper.extractTemplateVariables('ItemId=static-value');

            expect(variables).to.deep.equal([]);
        });

        it('should trim whitespace from variable names', () => {
            const variables = helper.extractTemplateVariables('ItemId={{ ITEM }}');

            expect(variables).to.deep.equal(['ITEM']);
        });
    });

    describe('calculateUrlLength', () => {
        it('should calculate URL length for single item', () => {
            const length = helper.calculateUrlLength(
                'https://api.example.com/items',
                'ItemId={{ITEM}}',
                ' or ',
                ['SKU-001']
            );

            // https://api.example.com/items?query=ItemId=SKU-001
            expect(length).to.be.greaterThan(0);
            expect(length).to.equal('https://api.example.com/items?query=ItemId=SKU-001'.length);
        });

        it('should calculate URL length for multiple items', () => {
            const length = helper.calculateUrlLength(
                'https://api.example.com/items',
                'ItemId={{ITEM}}',
                ' or ',
                ['SKU-001', 'SKU-002', 'SKU-003']
            );

            // https://api.example.com/items?query=ItemId=SKU-001 or ItemId=SKU-002 or ItemId=SKU-003
            const expected = 'https://api.example.com/items?query=ItemId=SKU-001 or ItemId=SKU-002 or ItemId=SKU-003'.length;
            expect(length).to.equal(expected);
        });

        it('should calculate URL length with ampersand separator', () => {
            const length = helper.calculateUrlLength(
                'https://api.example.com/items',
                'ItemId={{ITEM}}',
                '&',
                ['SKU-001', 'SKU-002']
            );

            const expected = 'https://api.example.com/items?query=ItemId=SKU-001&ItemId=SKU-002'.length;
            expect(length).to.equal(expected);
        });
    });

    describe('calculateMaxItemsPerRequest', () => {
        it('should calculate max items for 2000 char limit', () => {
            const maxItems = helper.calculateMaxItemsPerRequest(
                'https://api.example.com/items',
                'ItemId=ACAU-{{ITEM}}',
                ' or ',
                'SKU-12345', // Sample value
                2000
            );

            expect(maxItems).to.be.greaterThan(0);
            expect(maxItems).to.be.lessThan(200); // Reasonable upper bound
        });

        it('should return at least 1 item even if pattern is long', () => {
            const maxItems = helper.calculateMaxItemsPerRequest(
                'https://api.example.com/very-long-base-url-that-takes-up-space',
                'ItemId=ACAU-VERY-LONG-PREFIX-{{ITEM}}',
                ' or ',
                'SKU-12345-LONG-VALUE',
                100 // Very small limit
            );

            expect(maxItems).to.be.at.least(1);
        });

        it('should calculate fewer items for longer patterns', () => {
            const shortPatternItems = helper.calculateMaxItemsPerRequest(
                'https://api.example.com/items',
                'id={{ITEM}}',
                '&',
                '123',
                2000
            );

            const longPatternItems = helper.calculateMaxItemsPerRequest(
                'https://api.example.com/items',
                'ItemId=ACAU-{{ITEM}}&type=SKU',
                ' or ',
                'SKU-12345',
                2000
            );

            expect(shortPatternItems).to.be.greaterThan(longPatternItems);
        });
    });

    describe('buildRepeatingQueryString', () => {
        it('should build query string with "or" separator', () => {
            const queryString = helper.buildRepeatingQueryString(
                'ItemId={{ITEM}}',
                ' or ',
                ['SKU-001', 'SKU-002', 'SKU-003']
            );

            expect(queryString).to.equal('ItemId=SKU-001 or ItemId=SKU-002 or ItemId=SKU-003');
        });

        it('should build query string with ampersand separator', () => {
            const queryString = helper.buildRepeatingQueryString(
                'ItemId={{ITEM}}',
                '&',
                ['ABC', 'DEF']
            );

            expect(queryString).to.equal('ItemId=ABC&ItemId=DEF');
        });

        it('should handle single value', () => {
            const queryString = helper.buildRepeatingQueryString(
                'ItemId={{ITEM}}',
                ' or ',
                ['SKU-001']
            );

            expect(queryString).to.equal('ItemId=SKU-001');
        });

        it('should handle complex pattern', () => {
            const queryString = helper.buildRepeatingQueryString(
                'ItemId=ACAU-{{ITEM}}&type=SKU',
                ' or ',
                ['001', '002']
            );

            expect(queryString).to.equal('ItemId=ACAU-001&type=SKU or ItemId=ACAU-002&type=SKU');
        });

        it('should handle empty array', () => {
            const queryString = helper.buildRepeatingQueryString(
                'ItemId={{ITEM}}',
                ' or ',
                []
            );

            expect(queryString).to.equal('');
        });
    });

    describe('groupCsvRowsForQueryParams', () => {
        it('should group rows based on max items per request', () => {
            const csvRows = [
                ['SKU-001'],
                ['SKU-002'],
                ['SKU-003'],
                ['SKU-004'],
                ['SKU-005']
            ];

            const groups = helper.groupCsvRowsForQueryParams(
                csvRows,
                2 // Max 2 items per request
            );

            expect(groups).to.have.lengthOf(3);
            expect(groups[0]).to.deep.equal([['SKU-001'], ['SKU-002']]);
            expect(groups[1]).to.deep.equal([['SKU-003'], ['SKU-004']]);
            expect(groups[2]).to.deep.equal([['SKU-005']]);
        });

        it('should handle exact division', () => {
            const csvRows = [
                ['SKU-001'],
                ['SKU-002'],
                ['SKU-003'],
                ['SKU-004']
            ];

            const groups = helper.groupCsvRowsForQueryParams(csvRows, 2);

            expect(groups).to.have.lengthOf(2);
            expect(groups[0]).to.have.lengthOf(2);
            expect(groups[1]).to.have.lengthOf(2);
        });

        it('should handle single row', () => {
            const csvRows = [['SKU-001']];

            const groups = helper.groupCsvRowsForQueryParams(csvRows, 10);

            expect(groups).to.have.lengthOf(1);
            expect(groups[0]).to.deep.equal([['SKU-001']]);
        });

        it('should handle max items larger than total rows', () => {
            const csvRows = [['SKU-001'], ['SKU-002']];

            const groups = helper.groupCsvRowsForQueryParams(csvRows, 100);

            expect(groups).to.have.lengthOf(1);
            expect(groups[0]).to.have.lengthOf(2);
        });
    });
});
