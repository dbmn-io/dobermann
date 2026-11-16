// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { countNestedCalls, groupingColumnsForPreview } from '../../../../webviews/run-batch/nested-call-count';
import { ArrayRepetitionHelper } from '../../../../services/transaction-preparation/helpers/array-repetition.helper';

// Run Batch Step 4 "Total API calls" for a nested template. Puppy School Lesson 5, Step 6:
// one warehouse (buyerGln) ordering from three suppliers. The count keyed on the first
// header variable alone and said ONE call; Execute sends one per supplier.

const helper = new ArrayRepetitionHelper();
const groupRows = (csv: string[][], columns: string[]) => helper.groupRowsByFieldValues(csv, columns);

const CSV = [
    ['gtin', 'reorderQty', 'location.gln', 'product.supplier.gln'],
    ['00012345600081', '100', '0614141000012', '4012345000030'],
    ['00012345600043', '50', '0614141000012', '4012345000047'],
    ['00012345600050', '200', '0614141000012', '4012345000054'],
    ['00012345600050', '200', '0614141000012', '4012345000054']
];
const MAPPINGS = [
    { variable: 'buyerGln', column: 'location.gln' },
    { variable: 'supplierGln', column: 'product.supplier.gln' },
    { variable: 'gtin', column: 'gtin' },
    { variable: 'orderedQty', column: 'reorderQty' }
];
const LESSON_5 = { nestingLevel: 1, outerVariables: ['buyerGln', 'supplierGln'] };

describe('Run Batch preview — nested API-call count', () => {
    it('one buyer, three suppliers: three calls, whichever header field comes first', () => {
        for (const outerVariables of [['buyerGln', 'supplierGln'], ['supplierGln', 'buyerGln']]) {
            const count = countNestedCalls({ analysis: { ...LESSON_5, outerVariables }, csvData: CSV, mappings: MAPPINGS, rootVariables: [], maxGroupsShown: 1000, groupRows });
            expect(count.totalTransactions, outerVariables.join(', ')).to.equal(3);
            expect(count.totalGroups).to.equal(3);
        }
    });

    it('two variables mapped to the same column group on it once', () => {
        expect(groupingColumnsForPreview(['buyerGln', 'supplierGln'], [
            { variable: 'buyerGln', column: 'gln' }, { variable: 'supplierGln', column: 'gln' }
        ])).to.deep.equal(['gln']);
    });

    it('an unmapped variable groups on the column of its own name', () => {
        expect(groupingColumnsForPreview(['supplierGln'], undefined)).to.deep.equal(['supplierGln']);
    });

    it('no variables at the level: every row in one call', () => {
        const count = countNestedCalls({ analysis: { nestingLevel: 1, outerVariables: [] }, csvData: CSV, mappings: MAPPINGS, rootVariables: [], maxGroupsShown: 3, groupRows });
        expect(count).to.deep.equal({ groupingVariable: '_static', groupingVariables: [], totalGroups: 1, totalTransactions: 1 });
    });

    it('nesting level 2 packs Reps groups into a call', () => {
        const count = countNestedCalls({ analysis: { nestingLevel: 2, outerVariables: ['supplierGln'] }, csvData: CSV, mappings: MAPPINGS, rootVariables: [], maxGroupsShown: 2, groupRows });
        expect(count.totalTransactions).to.equal(2);   // three suppliers, two per call
    });

    it('nesting level 2: root variables split calls on every one of them', () => {
        const count = countNestedCalls({
            analysis: { nestingLevel: 2, outerVariables: ['gtin'] }, csvData: CSV, mappings: MAPPINGS,
            rootVariables: ['buyerGln', 'supplierGln'], maxGroupsShown: 1000, groupRows
        });
        expect(count.totalTransactions).to.equal(3);   // one per supplier, not one per (constant) buyer
    });
});
