// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for CSV Grouping functionality (GitHub Issue #119)
 * Tests the ArrayRepetitionHelper.groupRowsByFieldValues() method
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { ArrayRepetitionHelper } from '../../../services/transaction-preparation/helpers/array-repetition.helper';

describe('CSV Grouping (GitHub Issue #119)', () => {
    let helper: ArrayRepetitionHelper;

    beforeEach(() => {
        helper = new ArrayRepetitionHelper();
    });

    describe('groupRowsByFieldValues()', () => {
        it('should group by single column (PO)', () => {
            const csvData = [
                ['PO', 'Store', 'Item', 'Qty'],
                ['123', '100', 'A1234567', '5'],
                ['123', '100', 'A2345678', '3'],
                ['123', '100', 'A2345679', '4'],
                ['222', '200', 'A1234566', '15'],
                ['222', '200', 'A2345678', '12']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO']);

            expect(groups).to.have.length(2);

            // Group 1: PO=123 (3 rows)
            expect(groups[0]).to.have.length(4); // header + 3 rows
            expect(groups[0][0]).to.deep.equal(['PO', 'Store', 'Item', 'Qty']); // header
            expect(groups[0][1][0]).to.equal('123'); // PO
            expect(groups[0][2][0]).to.equal('123'); // PO
            expect(groups[0][3][0]).to.equal('123'); // PO

            // Group 2: PO=222 (2 rows)
            expect(groups[1]).to.have.length(3); // header + 2 rows
            expect(groups[1][0]).to.deep.equal(['PO', 'Store', 'Item', 'Qty']); // header
            expect(groups[1][1][0]).to.equal('222'); // PO
            expect(groups[1][2][0]).to.equal('222'); // PO
        });

        it('should group by multiple columns (PO + Store)', () => {
            const csvData = [
                ['PO', 'Store', 'Item', 'Qty'],
                ['123', '100', 'A1234567', '5'],
                ['123', '100', 'A2345678', '3'],
                ['123', '200', 'A2345679', '4'], // Different Store
                ['123', '200', 'A1234566', '15'],
                ['222', '200', 'A2345678', '12']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO', 'Store']);

            expect(groups).to.have.length(3);

            // Group 1: PO=123, Store=100 (2 rows)
            expect(groups[0]).to.have.length(3);
            expect(groups[0][1]).to.deep.equal(['123', '100', 'A1234567', '5']);
            expect(groups[0][2]).to.deep.equal(['123', '100', 'A2345678', '3']);

            // Group 2: PO=123, Store=200 (2 rows)
            expect(groups[1]).to.have.length(3);
            expect(groups[1][1]).to.deep.equal(['123', '200', 'A2345679', '4']);
            expect(groups[1][2]).to.deep.equal(['123', '200', 'A1234566', '15']);

            // Group 3: PO=222, Store=200 (1 row)
            expect(groups[2]).to.have.length(2);
            expect(groups[2][1]).to.deep.equal(['222', '200', 'A2345678', '12']);
        });

        it('should handle exact data from GitHub Issue #119', () => {
            const csvData = [
                ['PO', 'Store', 'Item', 'Qty'],
                ['123', '100', 'A1234567', '5'],
                ['123', '100', 'A2345678', '3'],
                ['123', '100', 'A2345679', '4'],
                ['222', '200', 'A1234566', '15'],
                ['222', '200', 'A2345678', '12'],
                ['222', '200', 'A2345679', '6'],
                ['333', '300', 'A4455667', '1'],
                ['333', '300', 'A4455668', '12'],
                ['333', '300', 'A4455669', '33'],
                ['333', '300', 'A4455670', '55']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO', 'Store']);

            expect(groups).to.have.length(3);

            // Group 1: PO=123, Store=100 (3 items)
            expect(groups[0]).to.have.length(4); // header + 3 rows
            expect(groups[0][1][2]).to.equal('A1234567'); // Item
            expect(groups[0][2][2]).to.equal('A2345678'); // Item
            expect(groups[0][3][2]).to.equal('A2345679'); // Item

            // Group 2: PO=222, Store=200 (3 items)
            expect(groups[1]).to.have.length(4); // header + 3 rows
            expect(groups[1][1][2]).to.equal('A1234566'); // Item
            expect(groups[1][2][2]).to.equal('A2345678'); // Item
            expect(groups[1][3][2]).to.equal('A2345679'); // Item

            // Group 3: PO=333, Store=300 (4 items)
            expect(groups[2]).to.have.length(5); // header + 4 rows
            expect(groups[2][1][2]).to.equal('A4455667'); // Item
            expect(groups[2][2][2]).to.equal('A4455668'); // Item
            expect(groups[2][3][2]).to.equal('A4455669'); // Item
            expect(groups[2][4][2]).to.equal('A4455670'); // Item
        });

        it('should respect maxGroupSize and split large groups', () => {
            const csvData = [
                ['PO', 'Item', 'Qty'],
                ['123', 'A', '5'],
                ['123', 'B', '3'],
                ['123', 'C', '4'],
                ['123', 'D', '2'],
                ['123', 'E', '1'], // 5 items for PO=123
                ['456', 'F', '7']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO'], 2); // Max 2 rows per group

            expect(groups).to.have.length(4); // PO=123 split into 3 chunks + PO=456

            // Chunk 1: PO=123, rows 1-2
            expect(groups[0]).to.have.length(3); // header + 2 rows
            expect(groups[0][1][1]).to.equal('A');
            expect(groups[0][2][1]).to.equal('B');

            // Chunk 2: PO=123, rows 3-4
            expect(groups[1]).to.have.length(3); // header + 2 rows
            expect(groups[1][1][1]).to.equal('C');
            expect(groups[1][2][1]).to.equal('D');

            // Chunk 3: PO=123, row 5 (partial chunk)
            expect(groups[2]).to.have.length(2); // header + 1 row
            expect(groups[2][1][1]).to.equal('E');

            // Chunk 4: PO=456, row 1
            expect(groups[3]).to.have.length(2); // header + 1 row
            expect(groups[3][1][1]).to.equal('F');
        });

        it('should handle single-row groups', () => {
            const csvData = [
                ['PO', 'Item'],
                ['123', 'A'],
                ['456', 'B'],
                ['789', 'C']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO']);

            expect(groups).to.have.length(3);
            expect(groups[0]).to.have.length(2); // header + 1 row
            expect(groups[1]).to.have.length(2); // header + 1 row
            expect(groups[2]).to.have.length(2); // header + 1 row
        });

        it('gathers unsorted rows: the same value is ONE group wherever its rows sit', () => {
            // Until 2026-09 this helper detected group BREAKS, so PO=123 appearing again after
            // PO=456 produced a second, separate PO=123 group ("separate group!"). That was a
            // limitation, not intent — GitHub Issue #147 added an auto-sort upstream so the real
            // batch flow never hit it. Grouping now gathers by key, so it is right on its own.
            const csvData = [
                ['PO', 'Item'],
                ['123', 'A'],
                ['123', 'B'],
                ['456', 'C'],
                ['123', 'D'], // PO=123 appears again (not sorted)
                ['123', 'E']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO']);

            // Two groups, in order of first appearance; file order kept inside each.
            expect(groups).to.have.length(2);
            expect(groups[0].slice(1).map(r => r.join(':'))).to.deep.equal(['123:A', '123:B', '123:D', '123:E']);
            expect(groups[1].slice(1).map(r => r.join(':'))).to.deep.equal(['456:C']);
        });

        it('groups on several columns: a new group when ANY of them changes', () => {
            const csvData = [
                ['PO', 'Site', 'Item'],
                ['123', 'Atlanta', 'A'],
                ['123', 'Boston', 'B'],
                ['123', 'Atlanta ', 'C'] // trailing space: same header as row 1
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO', 'Site']);

            expect(groups).to.have.length(2);
            expect(groups[0].slice(1).map(r => r[2])).to.deep.equal(['A', 'C']);
            expect(groups[1].slice(1).map(r => r[2])).to.deep.equal(['B']);
        });

        it('still splits an over-large group into chunks of maxGroupSize', () => {
            const csvData = [['PO', 'Item'], ['1', 'A'], ['2', 'X'], ['1', 'B'], ['1', 'C']];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO'], 2);

            expect(groups.map(g => g.slice(1).map(r => r.join(':')).join(','))).to.deep.equal(['1:A,1:B', '1:C', '2:X']);
        });

        it('should handle empty CSV data', () => {
            const csvData = [
                ['PO', 'Item', 'Qty'] // Header only
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO']);

            expect(groups).to.have.length(0);
        });

        it('should throw error if grouping column not found', () => {
            const csvData = [
                ['PO', 'Item', 'Qty'],
                ['123', 'A', '5']
            ];

            expect(() => {
                helper.groupRowsByFieldValues(csvData, ['InvalidColumn']);
            }).to.throw("Column 'InvalidColumn' not found");
        });

        it('should throw error if no grouping columns specified', () => {
            const csvData = [
                ['PO', 'Item', 'Qty'],
                ['123', 'A', '5']
            ];

            expect(() => {
                helper.groupRowsByFieldValues(csvData, []);
            }).to.throw('groupByColumns must be specified');
        });

        it('should handle empty values in grouping columns', () => {
            const csvData = [
                ['PO', 'Store', 'Item'],
                ['123', '100', 'A'],
                ['123', '100', 'B'],
                ['123', '', 'C'], // Empty Store
                ['123', '', 'D'],
                ['456', '200', 'E']
            ];

            const groups = helper.groupRowsByFieldValues(csvData, ['PO', 'Store']);

            expect(groups).to.have.length(3);

            // Group 1: PO=123, Store=100
            expect(groups[0]).to.have.length(3);

            // Group 2: PO=123, Store='' (empty)
            expect(groups[1]).to.have.length(3);
            expect(groups[1][1][1]).to.equal('');
            expect(groups[1][2][1]).to.equal('');

            // Group 3: PO=456, Store=200
            expect(groups[2]).to.have.length(2);
        });
    });

    describe('analyzeArrayRepetition() with CSV grouping', () => {
        it('should analyze CSV grouping correctly', async () => {
            const csvData = [
                ['PO', 'Store', 'Item', 'Qty'],
                ['123', '100', 'A1234567', '5'],
                ['123', '100', 'A2345678', '3'],
                ['123', '100', 'A2345679', '4'],
                ['222', '200', 'A1234566', '15'],
                ['222', '200', 'A2345678', '12'],
                ['333', '300', 'A4455667', '1']
            ];

            const analysis = await helper.analyzeArrayRepetition(csvData, {
                groupByColumns: ['PO', 'Store'],
                detectArrays: true
            });

            expect(analysis.enabled).to.equal(true);
            expect(analysis.totalRows).to.equal(6);
            expect(analysis.transactionCount).to.equal(3); // 3 groups
            expect(analysis.hasArrayFields).to.equal(true);
        });

        it('should use maxGroupSize when analyzing', async () => {
            const csvData = [
                ['PO', 'Item'],
                ['123', 'A'],
                ['123', 'B'],
                ['123', 'C'],
                ['123', 'D'],
                ['123', 'E'] // 5 items for PO=123
            ];

            const analysis = await helper.analyzeArrayRepetition(csvData, {
                groupByColumns: ['PO'],
                maxGroupSize: 2,
                detectArrays: true
            });

            expect(analysis.enabled).to.equal(true);
            expect(analysis.totalRows).to.equal(5);
            expect(analysis.transactionCount).to.equal(3); // Split into 3 chunks: [A,B], [C,D], [E]
            expect(analysis.maxRepetitions).to.equal(2);
        });

        it('should fall back to regular array repetition when groupByColumns not specified', async () => {
            const csvData = [
                ['PO', 'Item'],
                ['123', 'A'],
                ['123', 'B'],
                ['456', 'C']
            ];

            const analysis = await helper.analyzeArrayRepetition(csvData, {
                detectArrays: true,
                repeatableArrays: [{
                    enabled: true,
                    maxRepetitions: 10,
                    fieldName: 'items'
                }]
            });

            expect(analysis.enabled).to.equal(true);
            expect(analysis.transactionCount).to.equal(1); // All rows in one transaction
            expect(analysis.rowsPerTransaction).to.equal(3);
        });
    });

    describe('Integration: Full workflow with sample data', () => {
        it('should process GitHub Issue #119 example end-to-end', async () => {
            const csvData = [
                ['PO', 'Store', 'Item', 'Qty'],
                ['123', '100', 'A1234567', '5'],
                ['123', '100', 'A2345678', '3'],
                ['123', '100', 'A2345679', '4'],
                ['222', '200', 'A1234566', '15'],
                ['222', '200', 'A2345678', '12'],
                ['222', '200', 'A2345679', '6'],
                ['333', '300', 'A4455667', '1'],
                ['333', '300', 'A4455668', '12'],
                ['333', '300', 'A4455669', '33'],
                ['333', '300', 'A4455670', '55']
            ];

            // Step 1: Analyze
            const analysis = await helper.analyzeArrayRepetition(csvData, {
                groupByColumns: ['PO', 'Store'],
                detectArrays: true
            });

            expect(analysis.transactionCount).to.equal(3);

            // Step 2: Group rows
            const groups = helper.groupRowsByFieldValues(csvData, ['PO', 'Store']);

            expect(groups).to.have.length(3);

            // Verify each group structure
            const verifyGroup = (group: string[][], expectedPO: string, expectedStore: string, expectedItemCount: number) => {
                expect(group[0]).to.deep.equal(['PO', 'Store', 'Item', 'Qty']); // Header
                expect(group).to.have.length(expectedItemCount + 1); // header + items

                // All rows in group should have same PO and Store
                for (let i = 1; i < group.length; i++) {
                    expect(group[i][0]).to.equal(expectedPO); // PO
                    expect(group[i][1]).to.equal(expectedStore); // Store
                }
            };

            verifyGroup(groups[0], '123', '100', 3);
            verifyGroup(groups[1], '222', '200', 3);
            verifyGroup(groups[2], '333', '300', 4);

            // This data structure is now ready to be passed to JsonGenerator
            // which will create consolidated JSON with the items array populated
        });
    });
});
