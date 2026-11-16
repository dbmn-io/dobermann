// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for Modifier Executor (GitHub Issue #175)
 *
 * Tests applying modifiers to values - both transformations and validations.
 */

import { expect } from 'chai';
import {
    applyModifiers,
    applyModifiersAndFormat,
    hasValidationModifiers,
    hasTransformModifiers
} from '../../../data-loading/modifier-executor';
import { parseModifiers } from '../../../data-loading/modifier-parser';

describe('Modifier Executor (GitHub Issue #175)', () => {
    describe('Empty Value Behavior (opt and null)', () => {
        it('should return omitKey=true for empty string with opt modifier', () => {
            const modifiers = parseModifiers('opt', 'string');
            const result = applyModifiers('', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.omitKey).to.be.true;
            expect(result.value).to.be.undefined;
        });

        it('should return omitKey=true for whitespace-only string with opt modifier', () => {
            const modifiers = parseModifiers('opt', 'string');
            const result = applyModifiers('   ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.omitKey).to.be.true;
        });

        it('should return null for empty string with null modifier', () => {
            const modifiers = parseModifiers('null', 'string');
            const result = applyModifiers('', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.be.null;
            expect(result.omitKey).to.be.undefined;
        });

        it('should return null for whitespace-only string with null modifier', () => {
            const modifiers = parseModifiers('null', 'string');
            const result = applyModifiers('   ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.be.null;
        });

        it('should return omitKey=true for empty number with opt modifier', () => {
            const modifiers = parseModifiers('opt', 'number');
            const result = applyModifiers('', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.omitKey).to.be.true;
        });

        it('should return null for empty number with null modifier', () => {
            const modifiers = parseModifiers('null', 'number');
            const result = applyModifiers('', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.be.null;
        });

        it('should process non-empty values normally with opt modifier', () => {
            const modifiers = parseModifiers('opt|upper', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('HELLO');
            expect(result.omitKey).to.be.undefined;
        });

        it('should process non-empty values normally with null modifier', () => {
            const modifiers = parseModifiers('null|>0', 'number');
            const result = applyModifiers('42', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(42);
        });

        it('should handle opt with date type for empty value', () => {
            const modifiers = parseModifiers('opt', 'date');
            const result = applyModifiers('', 'date', modifiers);
            expect(result.success).to.be.true;
            expect(result.omitKey).to.be.true;
        });

        it('should handle null with datetime type for empty value', () => {
            const modifiers = parseModifiers('null', 'datetime');
            const result = applyModifiers('', 'datetime', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.be.null;
        });
    });

    describe('Exact Length Validation', () => {
        it('should pass exact length validation', () => {
            const modifiers = parseModifiers('5', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('hello');
        });

        it('should fail exact length validation (too short)', () => {
            const modifiers = parseModifiers('5', 'string');
            const result = applyModifiers('hi', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be exactly 5 characters');
            expect(result.error).to.include('got 2');
        });

        it('should fail exact length validation (too long)', () => {
            const modifiers = parseModifiers('3', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be exactly 3 characters');
            expect(result.error).to.include('got 5');
        });

        it('should validate exact length after trim', () => {
            const modifiers = parseModifiers('5', 'string');
            const result = applyModifiers('  abc  ', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('got 3');
        });

        it('should chain exact length with transform', () => {
            const modifiers = parseModifiers('5|upper', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('HELLO');
        });
    });

    describe('String Transforms', () => {
        it('should trim whitespace by default', () => {
            const modifiers = parseModifiers('', 'string');
            const result = applyModifiers('  hello  ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('hello');
        });

        it('should preserve whitespace with noTrim', () => {
            const modifiers = parseModifiers('noTrim', 'string');
            const result = applyModifiers('  hello  ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('  hello  ');
        });

        it('should convert to uppercase with upper', () => {
            const modifiers = parseModifiers('upper', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('HELLO');
        });

        it('should convert to lowercase with lower', () => {
            const modifiers = parseModifiers('lower', 'string');
            const result = applyModifiers('HELLO', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('hello');
        });

        it('should apply trim then upper', () => {
            const modifiers = parseModifiers('upper', 'string');
            const result = applyModifiers('  hello  ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('HELLO');
        });
    });

    describe('String Validations', () => {
        it('should pass min length validation', () => {
            const modifiers = parseModifiers('3-', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('hello');
        });

        it('should fail min length validation', () => {
            const modifiers = parseModifiers('3-', 'string');
            const result = applyModifiers('ab', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('minimum length is 3');
        });

        it('should pass max length validation', () => {
            const modifiers = parseModifiers('-5', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail max length validation', () => {
            const modifiers = parseModifiers('-5', 'string');
            const result = applyModifiers('hello world', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('maximum length is 5');
        });

        it('should pass length range validation', () => {
            const modifiers = parseModifiers('3-10', 'string');
            const result = applyModifiers('hello', 'string', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail length range validation (too short)', () => {
            const modifiers = parseModifiers('3-10', 'string');
            const result = applyModifiers('ab', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('minimum length is 3');
        });

        it('should fail length range validation (too long)', () => {
            const modifiers = parseModifiers('3-10', 'string');
            const result = applyModifiers('hello world!', 'string', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('maximum length is 10');
        });

        it('should validate length after trim', () => {
            const modifiers = parseModifiers('3-', 'string');
            // After trim, "  ab  " becomes "ab" which is 2 chars
            const result = applyModifiers('  ab  ', 'string', modifiers);
            expect(result.success).to.be.false;
        });
    });

    describe('Number Transforms', () => {
        it('should round to specified decimals', () => {
            const modifiers = parseModifiers('rnd(2)', 'number');
            const result = applyModifiers('3.14159', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(3.14);
        });

        it('should round to 0 decimals', () => {
            const modifiers = parseModifiers('rnd(0)', 'number');
            const result = applyModifiers('3.7', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(4);
        });

        it('should floor numbers', () => {
            const modifiers = parseModifiers('floor', 'number');
            const result = applyModifiers('3.9', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(3);
        });

        it('should ceil numbers', () => {
            const modifiers = parseModifiers('ceil', 'number');
            const result = applyModifiers('3.1', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(4);
        });
    });

    describe('Number Validations', () => {
        it('should pass greater than validation', () => {
            const modifiers = parseModifiers('>0', 'number');
            const result = applyModifiers('5', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail greater than validation', () => {
            const modifiers = parseModifiers('>0', 'number');
            const result = applyModifiers('0', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be greater than 0');
        });

        it('should pass greater or equal validation', () => {
            const modifiers = parseModifiers('>=0', 'number');
            const result = applyModifiers('0', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail greater or equal validation', () => {
            const modifiers = parseModifiers('>=0', 'number');
            const result = applyModifiers('-1', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be greater than or equal to 0');
        });

        it('should pass less than validation', () => {
            const modifiers = parseModifiers('<100', 'number');
            const result = applyModifiers('50', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail less than validation', () => {
            const modifiers = parseModifiers('<100', 'number');
            const result = applyModifiers('100', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be less than 100');
        });

        it('should pass less or equal validation', () => {
            const modifiers = parseModifiers('<=100', 'number');
            const result = applyModifiers('100', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail less or equal validation', () => {
            const modifiers = parseModifiers('<=100', 'number');
            const result = applyModifiers('101', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be less than or equal to 100');
        });

        it('should pass integer validation', () => {
            const modifiers = parseModifiers('int', 'number');
            const result = applyModifiers('42', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail integer validation', () => {
            const modifiers = parseModifiers('int', 'number');
            const result = applyModifiers('3.14', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('must be an integer');
        });

        it('should validate range with multiple comparisons', () => {
            const modifiers = parseModifiers('>=0|<=100', 'number');
            const result = applyModifiers('50', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should fail range validation (below)', () => {
            const modifiers = parseModifiers('>=0|<=100', 'number');
            const result = applyModifiers('-1', 'number', modifiers);
            expect(result.success).to.be.false;
        });

        it('should fail range validation (above)', () => {
            const modifiers = parseModifiers('>=0|<=100', 'number');
            const result = applyModifiers('101', 'number', modifiers);
            expect(result.success).to.be.false;
        });
    });

    describe('Number Transform + Validation Order', () => {
        it('should transform then validate: rnd(2)|>0', () => {
            const modifiers = parseModifiers('rnd(2)|>0', 'number');
            // 0.001 rounds to 0.00, which should fail >0
            const result = applyModifiers('0.001', 'number', modifiers);
            expect(result.success).to.be.false;
        });

        it('should transform then validate: floor|int', () => {
            const modifiers = parseModifiers('floor|int', 'number');
            // floor(3.9) = 3, which is an integer
            const result = applyModifiers('3.9', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(3);
        });
    });

    describe('Date Math Transforms', () => {
        it('should add days to date', () => {
            const modifiers = parseModifiers('+2d', 'date');
            const result = applyModifiers('2024-01-15', 'date', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.be.instanceOf(Date);
            expect((result.value as Date).getDate()).to.equal(17);
        });

        it('should subtract days from date', () => {
            const modifiers = parseModifiers('-1d', 'date');
            const result = applyModifiers('2024-01-15', 'date', modifiers);
            expect(result.success).to.be.true;
            expect((result.value as Date).getDate()).to.equal(14);
        });

        it('should add hours to datetime', () => {
            const modifiers = parseModifiers('+4h', 'datetime');
            const result = applyModifiers('2024-01-15T10:00:00Z', 'datetime', modifiers);
            expect(result.success).to.be.true;
            expect((result.value as Date).getUTCHours()).to.equal(14);
        });

        it('should add minutes to datetime', () => {
            const modifiers = parseModifiers('+30m', 'datetime');
            const result = applyModifiers('2024-01-15T10:00:00Z', 'datetime', modifiers);
            expect(result.success).to.be.true;
            expect((result.value as Date).getUTCMinutes()).to.equal(30);
        });

        it('should handle date rollover', () => {
            const modifiers = parseModifiers('+1d', 'date');
            const result = applyModifiers('2024-01-31', 'date', modifiers);
            expect(result.success).to.be.true;
            expect((result.value as Date).getMonth()).to.equal(1); // February (0-indexed)
            expect((result.value as Date).getDate()).to.equal(1);
        });
    });

    describe('Type Conversion Errors', () => {
        it('should fail on invalid number', () => {
            const modifiers = parseModifiers('', 'number');
            const result = applyModifiers('not-a-number', 'number', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('Invalid number');
        });

        it('should fail on invalid boolean', () => {
            const modifiers = parseModifiers('', 'boolean');
            const result = applyModifiers('maybe', 'boolean', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('Invalid boolean');
        });

        it('should fail on invalid date', () => {
            const modifiers = parseModifiers('', 'date');
            const result = applyModifiers('not-a-date', 'date', modifiers);
            expect(result.success).to.be.false;
            expect(result.error).to.include('Invalid date');
        });
    });

    describe('applyModifiersAndFormat', () => {
        it('should apply date math and format', () => {
            const modifiers = parseModifiers('+2d', 'datetime');
            const result = applyModifiersAndFormat('2024-01-15T10:00:00Z', 'datetime', modifiers, 'iso');
            expect(result.success).to.be.true;
            expect(result.value).to.match(/2024-01-17/);
            expect(result.value).to.include('Z');
        });

        it('should format date without modifiers', () => {
            const modifiers = parseModifiers('', 'date');
            const result = applyModifiersAndFormat('2024-01-15', 'date', modifiers, 'iso');
            expect(result.success).to.be.true;
            expect(result.value).to.equal('2024-01-15');
        });
    });

    describe('hasValidationModifiers', () => {
        it('should return true for length constraints', () => {
            const modifiers = parseModifiers('3-50', 'string');
            expect(hasValidationModifiers(modifiers)).to.be.true;
        });

        it('should return true for number comparisons', () => {
            const modifiers = parseModifiers('>0', 'number');
            expect(hasValidationModifiers(modifiers)).to.be.true;
        });

        it('should return true for integer check', () => {
            const modifiers = parseModifiers('int', 'number');
            expect(hasValidationModifiers(modifiers)).to.be.true;
        });

        it('should return false for transforms only', () => {
            const modifiers = parseModifiers('upper', 'string');
            expect(hasValidationModifiers(modifiers)).to.be.false;
        });

        it('should return false for rnd only', () => {
            const modifiers = parseModifiers('rnd(2)', 'number');
            expect(hasValidationModifiers(modifiers)).to.be.false;
        });
    });

    describe('hasTransformModifiers', () => {
        it('should return true for upper', () => {
            const modifiers = parseModifiers('upper', 'string');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for lower', () => {
            const modifiers = parseModifiers('lower', 'string');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for noTrim', () => {
            const modifiers = parseModifiers('noTrim', 'string');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for rnd', () => {
            const modifiers = parseModifiers('rnd(2)', 'number');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for floor', () => {
            const modifiers = parseModifiers('floor', 'number');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for ceil', () => {
            const modifiers = parseModifiers('ceil', 'number');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return true for date math', () => {
            const modifiers = parseModifiers('+2d', 'datetime');
            expect(hasTransformModifiers(modifiers)).to.be.true;
        });

        it('should return false for validation-only modifiers', () => {
            const modifiers = parseModifiers('>0', 'number');
            expect(hasTransformModifiers(modifiers)).to.be.false;
        });
    });

    describe('Real-world Examples', () => {
        it('should validate item name: 3-50 chars, trimmed', () => {
            const modifiers = parseModifiers('3-50', 'string');
            const result = applyModifiers('  Valid Item Name  ', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('Valid Item Name');
        });

        it('should validate and round price: >0, 2 decimals', () => {
            const modifiers = parseModifiers('>0|rnd(2)', 'number');
            const result = applyModifiers('19.999', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(20);
        });

        it('should validate quantity: integer, positive', () => {
            const modifiers = parseModifiers('int|>0', 'number');
            const result = applyModifiers('10', 'number', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal(10);
        });

        it('should reject negative quantity', () => {
            const modifiers = parseModifiers('int|>0', 'number');
            const result = applyModifiers('-5', 'number', modifiers);
            expect(result.success).to.be.false;
        });

        it('should validate percentage: 0-100', () => {
            const modifiers = parseModifiers('>=0|<=100', 'number');
            const result = applyModifiers('75', 'number', modifiers);
            expect(result.success).to.be.true;
        });

        it('should calculate ship date: now + 2 days', () => {
            const modifiers = parseModifiers('+2d', 'date');
            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];
            const result = applyModifiers(todayStr, 'date', modifiers);
            expect(result.success).to.be.true;
            const resultDate = result.value as Date;
            // Compare whole dates: day-of-month + 2 is wrong across a month end (30 Sep → 2 Oct).
            const expected = new Date(Date.parse(todayStr) + 2 * 86_400_000).toISOString().split('T')[0];
            expect(resultDate.toISOString().split('T')[0]).to.equal(expected);
        });

        it('should convert code to uppercase', () => {
            const modifiers = parseModifiers('upper', 'string');
            const result = applyModifiers('abc123', 'string', modifiers);
            expect(result.success).to.be.true;
            expect(result.value).to.equal('ABC123');
        });
    });
});
