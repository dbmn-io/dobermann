// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #226: Unit tests for column-mismatch detection.
 *
 * Verifies the bug the user hit ("the ,99 is ignored") is now caught by the
 * detector, and exercises the supported delimiters. The detector feeds the
 * inline-repair panel that blocks Step 1 -> Step 2 of the Run Batch flow.
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    detectDelimiter,
    parseCSVLine,
    parseCSVContent,
    detectColumnMismatches
} from '../../../utils/csv-mismatch';

describe('csv-mismatch detector (Issue #226)', function () {
    describe('detectDelimiter', function () {
        it('returns comma for plain CSV', function () {
            expect(detectDelimiter('a,b,c\n1,2,3')).to.equal(',');
        });

        it('returns tab when tabs dominate the first line', function () {
            expect(detectDelimiter('a\tb\tc\n1\t2\t3')).to.equal('\t');
        });

        it('returns pipe when pipes dominate the first line', function () {
            expect(detectDelimiter('a|b|c|d\n1|2|3|4')).to.equal('|');
        });

        it('falls back to comma when no delimiter is present', function () {
            expect(detectDelimiter('singlecolumn')).to.equal(',');
        });

        it('prefers tab over pipe and comma when counts tie at the max', function () {
            // tab=2, pipe=2, comma=2 — tab wins per implementation order
            expect(detectDelimiter('a\tb|c,d')).to.equal('\t');
        });
    });

    describe('parseCSVLine', function () {
        it('respects quoted fields containing the delimiter', function () {
            expect(parseCSVLine('a,"b,c",d', ',')).to.deep.equal(['a', 'b,c', 'd']);
        });

        it('handles escaped quotes inside a quoted field', function () {
            expect(parseCSVLine('a,"He said ""hi""",b', ',')).to.deep.equal(['a', 'He said "hi"', 'b']);
        });

        it('parses pipe-delimited lines', function () {
            expect(parseCSVLine('one|two|three', '|')).to.deep.equal(['one', 'two', 'three']);
        });

        it('parses tab-delimited lines', function () {
            expect(parseCSVLine('one\ttwo\tthree', '\t')).to.deep.equal(['one', 'two', 'three']);
        });
    });

    describe('detectColumnMismatches — comma', function () {
        it('flags a row with an unquoted comma in an early column (the user\'s exact case)', function () {
            const csv = [
                'gtin,sku,description,unitPrice',
                '00000000000000,SKU-FIX-002,Quantum Fetch Ball,14.99',
                '11111111111111,SKU-FIX-003,Self-Walking Leash,29.99',
                '55555555555555,SKU,FIX-004,Teleportation Dog Bed,199.99'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.expectedColumns).to.equal(4);
            expect(result.delimiter).to.equal(',');
            expect(result.headerLine).to.equal('gtin,sku,description,unitPrice');
            expect(result.rows).to.have.lengthOf(1);
            expect(result.rows[0].lineNumber).to.equal(4);
            expect(result.rows[0].actualColumns).to.equal(5);
            expect(result.rows[0].rawText).to.equal('55555555555555,SKU,FIX-004,Teleportation Dog Bed,199.99');
        });

        it('flags the trailing-comma "99,99" case (silent data loss before #226)', function () {
            // This is the exact symptom the user reported: a numeric value
            // written with a European decimal separator splits the last column
            // into two fields, and the surplus field used to be silently dropped.
            const csv = [
                'gtin,sku,description,unitPrice',
                '00000000000000,SKU-A,Item A,14.99',
                '99999999999999,SKU-B,Item B,99,99'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.rows).to.have.lengthOf(1);
            expect(result.rows[0].lineNumber).to.equal(3);
            expect(result.rows[0].actualColumns).to.equal(5);
        });

        it('returns no mismatches when rows align with the header', function () {
            const csv = [
                'a,b,c',
                '1,2,3',
                '4,5,6'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.rows).to.have.lengthOf(0);
            expect(result.expectedColumns).to.equal(3);
        });

        it('treats a quoted field containing the delimiter as a single column (no false positive)', function () {
            const csv = [
                'gtin,sku,description,unitPrice',
                '00000000000000,"SKU,FIX-004",Teleportation Dog Bed,199.99'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.rows).to.have.lengthOf(0);
        });

        it('reports multiple bad rows independently', function () {
            const csv = [
                'a,b,c',
                '1,2,3',
                '4,5,6,7',
                '8,9',
                '10,11,12'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.rows).to.have.lengthOf(2);
            expect(result.rows[0].lineNumber).to.equal(3);
            expect(result.rows[0].actualColumns).to.equal(4);
            expect(result.rows[1].lineNumber).to.equal(4);
            expect(result.rows[1].actualColumns).to.equal(2);
        });
    });

    describe('detectColumnMismatches — tab', function () {
        it('flags a tab-delimited row with extra columns', function () {
            const csv = [
                'gtin\tsku\tdescription\tunitPrice',
                '00000000000000\tSKU-A\tItem A\t14.99',
                '99999999999999\tSKU\tFIX-004\tItem B\t199.99'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.delimiter).to.equal('\t');
            expect(result.rows).to.have.lengthOf(1);
            expect(result.rows[0].lineNumber).to.equal(3);
            expect(result.rows[0].actualColumns).to.equal(5);
        });
    });

    describe('detectColumnMismatches — pipe', function () {
        it('flags a pipe-delimited row with extra columns', function () {
            const csv = [
                'gtin|sku|description|unitPrice',
                '00000000000000|SKU-A|Item A|14.99',
                '99999999999999|SKU|FIX-004|Item B|199.99'
            ].join('\n');

            const result = detectColumnMismatches(csv);

            expect(result.delimiter).to.equal('|');
            expect(result.rows).to.have.lengthOf(1);
            expect(result.rows[0].lineNumber).to.equal(3);
            expect(result.rows[0].actualColumns).to.equal(5);
        });
    });

    describe('repair round-trip', function () {
        it('a quoted edit re-parses to the expected column count', function () {
            // The repair UI lets the user wrap the broken field in quotes
            // and we revalidate locally. This test confirms the repaired
            // line cleanly returns to the header column count.
            const repaired = '55555555555555,"SKU,FIX-004",Teleportation Dog Bed,199.99';
            expect(parseCSVLine(repaired, ',')).to.have.lengthOf(4);

            const fullCsv = [
                'gtin,sku,description,unitPrice',
                repaired
            ].join('\n');

            expect(detectColumnMismatches(fullCsv).rows).to.have.lengthOf(0);
        });

        it('parseCSVContent returns rawLines aligned with header + rows', function () {
            const csv = [
                'a,b,c',
                '1,2,3',
                '4,5,6'
            ].join('\n');

            const result = parseCSVContent(csv);

            expect(result.rawLines).to.have.lengthOf(3);
            expect(result.rawLines[0]).to.equal('a,b,c');
            expect(result.rawLines[1]).to.equal('1,2,3');
        });
    });
});
