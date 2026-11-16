// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { convertValueBySourceFormat, applySourceFormatConversions } from '../../../utils/source-format-converter';

/**
 * Unit tests for shared source format converter utility.
 *
 * GitHub Issue #218: STRING is default — string-typed values must NEVER
 * enter numeric conversion pipelines.
 */
describe('source-format-converter (shared utility)', () => {

    // =========================================================================
    // STRING guard — the core #218 principle
    // =========================================================================

    describe('STRING guard', () => {

        it('should return value unchanged when dataType is "string"', () => {
            expect(convertValueBySourceFormat('00012345', 'standard', 'string')).to.equal('00012345');
        });

        it('should return value unchanged when dataType is undefined (defaults to string)', () => {
            expect(convertValueBySourceFormat('00012345', 'standard')).to.equal('00012345');
        });

        it('should return value unchanged when dataType is empty string (defaults to string)', () => {
            expect(convertValueBySourceFormat('00012345', 'standard', '')).to.equal('00012345');
        });

        it('should preserve leading zeros for string + cobol format', () => {
            expect(convertValueBySourceFormat('00012345', 'cobol', 'string')).to.equal('00012345');
        });

        it('should preserve leading zeros for string + currency format', () => {
            expect(convertValueBySourceFormat('007', 'currency', 'string')).to.equal('007');
        });

        it('should preserve leading zeros for string + scientific format', () => {
            expect(convertValueBySourceFormat('0001', 'scientific', 'string')).to.equal('0001');
        });

        it('should preserve leading zeros for string + excel_serial format', () => {
            expect(convertValueBySourceFormat('00045000', 'excel_serial', 'string')).to.equal('00045000');
        });
    });

    // =========================================================================
    // Number conversions — should still work for non-string types
    // =========================================================================

    describe('COBOL format conversion', () => {

        it('should convert positive COBOL number', () => {
            expect(convertValueBySourceFormat('+000000099.9900', 'cobol', 'number')).to.equal('99.99');
        });

        it('should convert negative COBOL number', () => {
            expect(convertValueBySourceFormat('-000000020.0000', 'cobol', 'number')).to.equal('-20');
        });

        it('should handle zero', () => {
            expect(convertValueBySourceFormat('+000000000.0000', 'cobol', 'number')).to.equal('0');
        });
    });

    describe('Currency format conversion', () => {

        it('should convert USD currency', () => {
            expect(convertValueBySourceFormat('$1,234.56', 'currency', 'number')).to.equal('1234.56');
        });

        it('should convert European currency (comma decimal)', () => {
            expect(convertValueBySourceFormat('€1.234,56', 'currency', 'number')).to.equal('1234.56');
        });

        it('should handle negative with parentheses', () => {
            expect(convertValueBySourceFormat('($500.00)', 'currency', 'number')).to.equal('-500');
        });

        it('should handle negative with minus sign', () => {
            expect(convertValueBySourceFormat('-$500.00', 'currency', 'number')).to.equal('-500');
        });
    });

    describe('Scientific notation conversion', () => {

        it('should convert scientific notation', () => {
            expect(convertValueBySourceFormat('1.23E+04', 'scientific', 'number')).to.equal('12300');
        });

        it('should convert small scientific notation', () => {
            expect(convertValueBySourceFormat('5e-2', 'scientific', 'number')).to.equal('0.05');
        });
    });

    describe('Standard number conversion', () => {

        it('should remove thousand separators', () => {
            expect(convertValueBySourceFormat('1,234.56', 'standard', 'number')).to.equal('1234.56');
        });

        it('should handle plain number', () => {
            expect(convertValueBySourceFormat('42', 'standard', 'number')).to.equal('42');
        });
    });

    describe('Excel serial date conversion', () => {

        it('should convert Excel serial to ISO date', () => {
            // 44927 = 2023-01-01
            expect(convertValueBySourceFormat('44927', 'excel_serial', 'date')).to.equal('2023-01-01');
        });
    });

    describe('Passthrough and edge cases', () => {

        it('should pass through with passthrough format', () => {
            expect(convertValueBySourceFormat('hello', 'passthrough', 'number')).to.equal('hello');
        });

        it('should pass through with unknown format', () => {
            expect(convertValueBySourceFormat('hello', 'unknown_format', 'number')).to.equal('hello');
        });

        it('should return empty string unchanged', () => {
            expect(convertValueBySourceFormat('', 'standard', 'number')).to.equal('');
        });

        it('should return whitespace-only string unchanged', () => {
            expect(convertValueBySourceFormat('   ', 'standard', 'number')).to.equal('   ');
        });
    });

    // =========================================================================
    // applySourceFormatConversions — batch conversion with STRING guard
    // =========================================================================

    describe('applySourceFormatConversions', () => {

        it('should skip string-typed mappings', () => {
            const dataRows = [['00012345', '42']];
            const headers = ['gtin', 'quantity'];
            const mappings = [
                { variable: 'gtin', column: 'gtin', dataType: 'string', sourceFormat: 'standard' },
                { variable: 'quantity', column: 'quantity', dataType: 'number', sourceFormat: 'standard' }
            ];

            const result = applySourceFormatConversions(dataRows, headers, mappings);
            expect(result[0][0]).to.equal('00012345'); // STRING preserved
            expect(result[0][1]).to.equal('42');       // NUMBER converted (no change for plain 42)
        });

        it('should return original data when all mappings are string', () => {
            const dataRows = [['00012345', '007']];
            const headers = ['gtin', 'code'];
            const mappings = [
                { variable: 'gtin', column: 'gtin', dataType: 'string', sourceFormat: 'standard' },
                { variable: 'code', column: 'code', dataType: 'string', sourceFormat: 'standard' }
            ];

            const result = applySourceFormatConversions(dataRows, headers, mappings);
            expect(result).to.equal(dataRows); // Same reference — no copy needed
        });

        it('should convert COBOL for number-typed mapping', () => {
            const dataRows = [['+000000099.9900']];
            const headers = ['amount'];
            const mappings = [
                { variable: 'amount', column: 'amount', dataType: 'number', sourceFormat: 'cobol' }
            ];

            const result = applySourceFormatConversions(dataRows, headers, mappings);
            expect(result[0][0]).to.equal('99.99');
        });
    });
});
