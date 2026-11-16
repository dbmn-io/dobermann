// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for query-param repetition completeness + param merging (GitHub Issue #224)
 *
 * Two regressions were fixed:
 *  1. When a query param repeated (e.g. `query=ItemId={{SKU}}[ or ]`), the
 *     endpoint's OTHER enabled query params (e.g. `size=90`) were dropped, so the
 *     host fell back to its default page size and silently truncated results.
 *     The merge is now done via flattenQueryParams + the repeated value.
 *  2. There was no way to verify every input item was actually queried. The
 *     grouping analysis now reports `includedRowCount`, which is < totalRows when
 *     blank values cause rows to be skipped.
 */

import { expect } from 'chai';
import { QueryParamRepetitionHelper } from '../../../services/transaction-preparation/helpers/query-param-repetition.helper';
import { flattenQueryParams } from '../../../utils/jwt-validation';

/**
 * Mirrors TransactionPreparationService.buildRepetitionQueryParams (private):
 * merge the endpoint's other enabled query params with the computed repeated
 * value, the repeated key overriding any same-key endpoint value.
 */
function buildRepetitionQueryParams(
    queryParams: Record<string, string | { value: string; enabled: boolean }>,
    paramKey: string,
    repeatedValue: string
): Record<string, string> {
    const otherParams = flattenQueryParams(queryParams);
    delete otherParams[paramKey];
    return { ...otherParams, [paramKey]: repeatedValue };
}

describe('Query-param repetition — #224 size param + completeness', () => {
    let helper: QueryParamRepetitionHelper;

    beforeEach(() => {
        helper = new QueryParamRepetitionHelper();
    });

    describe('buildRepetitionQueryParams — other enabled params survive', () => {
        const repeated = 'ItemId=A or ItemId=B';

        it('keeps an enabled size param alongside the repeated query param', () => {
            const result = buildRepetitionQueryParams(
                { query: { value: 'ItemId={{SKU}}[ or ]', enabled: true }, size: { value: '90', enabled: true } },
                'query',
                repeated
            );
            expect(result).to.deep.equal({ size: '90', query: repeated });
        });

        it('drops disabled params and the original repeated-key value', () => {
            const result = buildRepetitionQueryParams(
                {
                    query: { value: 'ItemId={{SKU}}[ or ]', enabled: true },
                    size: { value: '90', enabled: true },
                    debug: { value: 'true', enabled: false }
                },
                'query',
                repeated
            );
            expect(result).to.deep.equal({ size: '90', query: repeated });
            expect(result).to.not.have.property('debug');
        });

        it('supports legacy string-format query params', () => {
            const result = buildRepetitionQueryParams(
                { query: 'ItemId={{SKU}}[ or ]', size: '90' },
                'query',
                repeated
            );
            expect(result).to.deep.equal({ size: '90', query: repeated });
        });
    });

    describe('analyzeQueryParamRepetition — includedRowCount verifies coverage', () => {
        const config = {
            enabled: true,
            paramKey: 'query',
            pattern: 'ItemId={{SKU}}',
            separator: ' or ',
            maxUrlLength: 2048
        };
        const mappings = { SKU: 'SKU' };

        it('includes every row when no values are blank', async () => {
            const csvData = [['SKU'], ['A'], ['B'], ['C']];
            const analysis = await helper.analyzeQueryParamRepetition(csvData, config, mappings);
            expect(analysis.totalRows).to.equal(3);
            expect(analysis.includedRowCount).to.equal(3);
        });

        it('reports a shortfall when some values are blank (dropped items)', async () => {
            const csvData = [['SKU'], ['A'], [''], ['C'], ['   ']];
            const analysis = await helper.analyzeQueryParamRepetition(csvData, config, mappings);
            expect(analysis.totalRows).to.equal(4);
            expect(analysis.includedRowCount).to.equal(2); // A and C only
            expect(analysis.includedRowCount).to.be.lessThan(analysis.totalRows);
        });

        it('returns zero counts when disabled', async () => {
            const analysis = await helper.analyzeQueryParamRepetition(
                [['SKU'], ['A']],
                { ...config, enabled: false },
                mappings
            );
            expect(analysis.enabled).to.equal(false);
            expect(analysis.includedRowCount).to.equal(0);
        });
    });
});
