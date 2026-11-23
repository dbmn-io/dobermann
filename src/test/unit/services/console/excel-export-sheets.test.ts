// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { excelSheetExtractions } from '../../../../services/console/excel-export-sheets';

/**
 * Reported 2026-09-23: Completed tab filtered to "991 of 74,979 rows", Export → Excel wrote
 * 74,979 rows. CSV and Copy honoured the filter; only the Excel branch dropped it.
 */
describe('Excel export: what each sheet is extracted with', () => {
    const view = { name: 'LowStock', rowBasis: 'data.data', columns: [{ id: 'data.data.sku' }] };
    const fromCompleted = {
        tab: 'success',
        visibleColumnIds: ['data.data.sku', 'data.data.status'],
        currentPath: 'data.data',
        searchTerm: 'low_stock +Golden',
        view
    };

    it('the current tab\'s sheet gets the search term and the in-memory view, exactly as CSV does', () => {
        const [input, success, errors] = excelSheetExtractions(fromCompleted);
        expect(success).to.deep.equal({
            sheetName: 'Success', tab: 'success',
            visibleColumnIds: ['data.data.sku', 'data.data.status'], overridePath: 'data.data',
            searchTerm: 'low_stock +Golden', view, inputStatusFilter: undefined
        });
        // The other sheets are exported whole.
        expect(errors).to.deep.equal({ sheetName: 'Errors', tab: 'errors', visibleColumnIds: null, overridePath: undefined, searchTerm: undefined, view: undefined, inputStatusFilter: undefined });
        expect(input).to.deep.equal({ sheetName: 'Input', tab: 'input', visibleColumnIds: null, overridePath: undefined, searchTerm: undefined, view: undefined, inputStatusFilter: undefined });
    });

    it('a filter typed on the Error tab narrows the Errors sheet, not Success', () => {
        const [, success, errors] = excelSheetExtractions({ ...fromCompleted, tab: 'errors' });
        expect(errors.searchTerm).to.equal('low_stock +Golden');
        expect(errors.view).to.equal(view);
        expect(success.searchTerm).to.equal(undefined);
        expect(success.view).to.equal(undefined);
    });

    it('a blank search box filters nothing', () => {
        const [, success] = excelSheetExtractions({ ...fromCompleted, searchTerm: '   ' });
        expect(success.searchTerm).to.equal(undefined);
        expect(success.visibleColumnIds, 'column choice still applies').to.deep.equal(fromCompleted.visibleColumnIds);
    });

    it('exported from the Input tab, the Input sheet keeps its search (@Result=Error: the rows to send back), never its columns', () => {
        const [input, success] = excelSheetExtractions({ ...fromCompleted, tab: 'input', searchTerm: '@Result=Error' });
        expect(input).to.deep.equal({ sheetName: 'Input', tab: 'input', visibleColumnIds: null, overridePath: undefined, searchTerm: '@Result=Error', view: undefined, inputStatusFilter: undefined });
        expect(success.searchTerm, 'the other sheets whole').to.equal(undefined);
        // exported from another tab, Input is whole
        expect(excelSheetExtractions({ ...fromCompleted, tab: 'success', searchTerm: '@Result=Error' })[0].searchTerm).to.equal(undefined);
    });

    it('the Input sheet keeps the Input tab\'s Result filter (Issue #304)', () => {
        const [input, success] = excelSheetExtractions({ ...fromCompleted, tab: 'input', inputStatusFilter: 'error' });
        expect(input.inputStatusFilter).to.equal('error');
        expect(success.inputStatusFilter).to.equal(undefined);
        // "All" filters nothing, and another tab's export leaves Input whole.
        expect(excelSheetExtractions({ ...fromCompleted, tab: 'input', inputStatusFilter: 'all' })[0].inputStatusFilter).to.equal(undefined);
        expect(excelSheetExtractions({ ...fromCompleted, tab: 'errors', inputStatusFilter: 'error' })[0].inputStatusFilter).to.equal(undefined);
    });

    it('always three sheets, in workbook order', () => {
        expect(excelSheetExtractions({}).map(s => s.sheetName)).to.deep.equal(['Input', 'Success', 'Errors']);
    });
});
