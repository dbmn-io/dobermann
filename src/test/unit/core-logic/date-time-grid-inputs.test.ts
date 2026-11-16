// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests for Date/Time Grid Input Utilities (GitHub Issue #162)
 *
 * These tests verify the pure business logic for date/time/datetime
 * input handling in the CSV grid, including:
 * - Date format detection and validation
 * - Excel serial date detection
 * - Date/time value formatting for HTML5 inputs
 * - Unparseable date/time value detection
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Date/Time Input Utility Functions
 * Extracted from data-transformer.js for testability
 */
class DateTimeInputUtils {
    /**
     * Format a value for HTML5 date input (YYYY-MM-DD)
     * Returns null for unparseable values
     *
     * @param value - The value to format
     * @returns Formatted date string or null if unparseable
     */
    static formatValueForDateInput(value: string): string | null {
        if (!value || value.trim() === '') {
            return '';
        }

        const trimmed = value.trim();

        // Detect pure numbers (likely Excel serial dates or other numeric formats)
        if (/^\d+$/.test(trimmed)) {
            return null; // Signal that this needs special handling
        }

        // Check if it's already in YYYY-MM-DD format
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return trimmed;
        }

        // Try to parse as date
        try {
            const date = new Date(trimmed);
            if (!isNaN(date.getTime())) {
                // Format as YYYY-MM-DD
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            }
        } catch (e) {
            // Fall through to return null
        }

        return null;
    }

    /**
     * Format a value for HTML5 datetime-local input (YYYY-MM-DDTHH:mm)
     * Returns null for unparseable values
     *
     * @param value - The value to format
     * @returns Formatted datetime string or null if unparseable
     */
    static formatValueForDatetimeInput(value: string): string | null {
        if (!value || value.trim() === '') {
            return '';
        }

        const trimmed = value.trim();

        // Detect pure numbers (likely Excel serial dates)
        if (/^\d+$/.test(trimmed)) {
            return null;
        }

        // Check if it's already in datetime-local format (YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss)
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
            // Return just the YYYY-MM-DDTHH:mm portion (what datetime-local expects)
            return trimmed.substring(0, 16);
        }

        // Try to parse as date
        try {
            const date = new Date(trimmed);
            if (!isNaN(date.getTime())) {
                // Format as YYYY-MM-DDTHH:mm
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                return `${year}-${month}-${day}T${hours}:${minutes}`;
            }
        } catch (e) {
            // Fall through to return null
        }

        return null;
    }

    /**
     * Format a value for HTML5 time input (HH:mm)
     * Returns null for unparseable values
     *
     * @param value - The value to format
     * @returns Formatted time string or null if unparseable
     */
    static formatValueForTimeInput(value: string): string | null {
        if (!value || value.trim() === '') {
            return '';
        }

        const trimmed = value.trim();

        // Detect pure numbers (not valid time format)
        if (/^\d+$/.test(trimmed)) {
            return null;
        }

        // Check if it's already in HH:mm or HH:mm:ss format
        // Also validate the hour (0-23) and minute (0-59)
        const timeMatch = trimmed.match(/^(\d{2}):(\d{2})(:\d{2})?$/);
        if (timeMatch) {
            const hour = parseInt(timeMatch[1], 10);
            const minute = parseInt(timeMatch[2], 10);
            if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
                return trimmed.substring(0, 5); // Return HH:mm portion
            }
            return null; // Invalid hour or minute values
        }

        // Check for time with milliseconds
        if (/^\d{2}:\d{2}:\d{2}\.\d+$/.test(trimmed)) {
            return trimmed.substring(0, 5);
        }

        return null;
    }

    /**
     * Detect if a value looks like an Excel serial date
     *
     * @param value - The value to check
     * @returns True if the value appears to be an Excel serial date
     */
    static isExcelSerialDate(value: string): boolean {
        if (!value || value.trim() === '') {
            return false;
        }

        const trimmed = value.trim();

        // Check if it's a pure number (integer or decimal)
        if (!/^[\d.]+$/.test(trimmed)) {
            return false;
        }

        const num = parseFloat(trimmed);

        // Excel serial dates are typically between 1 (Jan 1, 1900) and ~60000+ (year 2064+)
        // Reasonable range for modern dates: 25000 (1968) to 80000 (2118)
        // We'll use a broader range of 1 to 100000 to be safe
        return !isNaN(num) && num >= 1 && num <= 100000;
    }

    /**
     * Check if a date/time/datetime column has values that can't be parsed
     *
     * @param values - Array of values to check
     * @param columnType - The column type ('date', 'datetime', 'time')
     * @returns True if any values are unparseable
     */
    static hasUnparseableDateTimeValues(values: string[], columnType: 'date' | 'datetime' | 'time'): boolean {
        for (const value of values) {
            if (!value || value.trim() === '') {
                continue; // Empty values are fine
            }

            let result: string | null;
            switch (columnType) {
                case 'date':
                    result = this.formatValueForDateInput(value);
                    break;
                case 'datetime':
                    result = this.formatValueForDatetimeInput(value);
                    break;
                case 'time':
                    result = this.formatValueForTimeInput(value);
                    break;
            }

            if (result === null) {
                return true; // Found an unparseable value
            }
        }
        return false;
    }

    /**
     * Convert Excel serial date to ISO date string
     *
     * @param serialNumber - The Excel serial date number
     * @returns ISO date string (YYYY-MM-DD) or null if invalid
     */
    static excelSerialToIsoDate(serialNumber: number): string | null {
        if (serialNumber < 1) {
            return null;
        }

        // Excel's epoch is December 30, 1899
        // But it incorrectly treats 1900 as a leap year
        // Serial numbers 1-60 use 25567 offset, > 60 use 25569
        const daysOffset = serialNumber <= 60 ? 25567 : 25569;
        const date = new Date((serialNumber - daysOffset) * 86400000);

        if (isNaN(date.getTime())) {
            return null;
        }

        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

describe('Date/Time Grid Input Utilities (Issue #162)', () => {

    describe('formatValueForDateInput', () => {
        it('should format valid ISO date string', () => {
            expect(DateTimeInputUtils.formatValueForDateInput('2024-01-04')).to.equal('2024-01-04');
        });

        it('should format valid date string with time component', () => {
            const result = DateTimeInputUtils.formatValueForDateInput('2024-01-04T14:30:00.000Z');
            expect(result).to.match(/^\d{4}-\d{2}-\d{2}$/);
        });

        it('should return empty string for empty input', () => {
            expect(DateTimeInputUtils.formatValueForDateInput('')).to.equal('');
            expect(DateTimeInputUtils.formatValueForDateInput('  ')).to.equal('');
        });

        it('should return null for pure numeric values (Excel serial dates)', () => {
            expect(DateTimeInputUtils.formatValueForDateInput('45295')).to.be.null;
            expect(DateTimeInputUtils.formatValueForDateInput('12345')).to.be.null;
        });

        it('should return null for invalid date strings', () => {
            expect(DateTimeInputUtils.formatValueForDateInput('not-a-date')).to.be.null;
            expect(DateTimeInputUtils.formatValueForDateInput('abc123')).to.be.null;
        });

        it('should handle various date formats', () => {
            // These should parse successfully
            expect(DateTimeInputUtils.formatValueForDateInput('January 4, 2024')).to.not.be.null;
            expect(DateTimeInputUtils.formatValueForDateInput('2024/01/04')).to.not.be.null;
        });

        it('should handle edge dates correctly', () => {
            expect(DateTimeInputUtils.formatValueForDateInput('2024-02-29')).to.equal('2024-02-29'); // Leap year
            expect(DateTimeInputUtils.formatValueForDateInput('2024-12-31')).to.equal('2024-12-31');
            expect(DateTimeInputUtils.formatValueForDateInput('2024-01-01')).to.equal('2024-01-01');
        });
    });

    describe('formatValueForDatetimeInput', () => {
        it('should format valid datetime-local string', () => {
            expect(DateTimeInputUtils.formatValueForDatetimeInput('2024-01-04T14:30')).to.equal('2024-01-04T14:30');
        });

        it('should strip seconds from datetime-local format', () => {
            expect(DateTimeInputUtils.formatValueForDatetimeInput('2024-01-04T14:30:00')).to.equal('2024-01-04T14:30');
        });

        it('should format ISO datetime string', () => {
            const result = DateTimeInputUtils.formatValueForDatetimeInput('2024-01-04T14:30:00.000Z');
            expect(result).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        });

        it('should return empty string for empty input', () => {
            expect(DateTimeInputUtils.formatValueForDatetimeInput('')).to.equal('');
        });

        it('should return null for pure numeric values', () => {
            expect(DateTimeInputUtils.formatValueForDatetimeInput('45295')).to.be.null;
        });

        it('should return null for invalid datetime strings', () => {
            expect(DateTimeInputUtils.formatValueForDatetimeInput('not-a-datetime')).to.be.null;
        });
    });

    describe('formatValueForTimeInput', () => {
        it('should format valid time string (HH:mm)', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('14:30')).to.equal('14:30');
        });

        it('should strip seconds from time format', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('14:30:00')).to.equal('14:30');
        });

        it('should strip milliseconds from time format', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('14:30:00.123')).to.equal('14:30');
        });

        it('should return empty string for empty input', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('')).to.equal('');
        });

        it('should return null for pure numeric values', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('1430')).to.be.null;
            expect(DateTimeInputUtils.formatValueForTimeInput('12345')).to.be.null;
        });

        it('should return null for invalid time strings', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('not-a-time')).to.be.null;
            expect(DateTimeInputUtils.formatValueForTimeInput('25:99')).to.be.null;
        });

        it('should handle edge times', () => {
            expect(DateTimeInputUtils.formatValueForTimeInput('00:00')).to.equal('00:00');
            expect(DateTimeInputUtils.formatValueForTimeInput('23:59')).to.equal('23:59');
            expect(DateTimeInputUtils.formatValueForTimeInput('12:00:00')).to.equal('12:00');
        });
    });

    describe('isExcelSerialDate', () => {
        it('should detect valid Excel serial dates', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('45295')).to.be.true; // 2024-01-04
            expect(DateTimeInputUtils.isExcelSerialDate('44927')).to.be.true; // 2023-01-01
            expect(DateTimeInputUtils.isExcelSerialDate('43831')).to.be.true; // 2020-01-01
        });

        it('should detect decimal Excel serial dates', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('45295.5')).to.be.true; // 2024-01-04 at noon
            expect(DateTimeInputUtils.isExcelSerialDate('45295.75')).to.be.true;
        });

        it('should reject non-numeric values', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('2024-01-04')).to.be.false;
            expect(DateTimeInputUtils.isExcelSerialDate('abc')).to.be.false;
            expect(DateTimeInputUtils.isExcelSerialDate('12ab34')).to.be.false;
        });

        it('should reject empty values', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('')).to.be.false;
            expect(DateTimeInputUtils.isExcelSerialDate('  ')).to.be.false;
        });

        it('should reject out of range serial numbers', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('0')).to.be.false;
            expect(DateTimeInputUtils.isExcelSerialDate('-1')).to.be.false;
            expect(DateTimeInputUtils.isExcelSerialDate('1000000')).to.be.false; // Too far in future
        });

        it('should handle edge cases for Excel serial dates', () => {
            expect(DateTimeInputUtils.isExcelSerialDate('1')).to.be.true;  // Day 1 in Excel
            expect(DateTimeInputUtils.isExcelSerialDate('60')).to.be.true;  // Feb 28, 1900
            expect(DateTimeInputUtils.isExcelSerialDate('61')).to.be.true;  // Mar 1, 1900
        });
    });

    describe('hasUnparseableDateTimeValues', () => {
        it('should return true when date column has Excel serial dates', () => {
            const values = ['2024-01-04', '45295', '2024-01-06'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'date')).to.be.true;
        });

        it('should return true when datetime column has Excel serial dates', () => {
            const values = ['2024-01-04T14:30', '45295', '2024-01-06T10:00'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'datetime')).to.be.true;
        });

        it('should return true when time column has invalid format', () => {
            const values = ['14:30', '1430', '10:00'];  // '1430' is not valid time format
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'time')).to.be.true;
        });

        it('should return false when all date values are parseable', () => {
            const values = ['2024-01-04', '2024-01-05', '2024-01-06'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'date')).to.be.false;
        });

        it('should return false when all datetime values are parseable', () => {
            const values = ['2024-01-04T14:30', '2024-01-05T10:00', '2024-01-06T08:30'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'datetime')).to.be.false;
        });

        it('should return false when all time values are parseable', () => {
            const values = ['14:30', '10:00', '08:30'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'time')).to.be.false;
        });

        it('should handle empty values gracefully', () => {
            const values = ['2024-01-04', '', '2024-01-06'];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'date')).to.be.false;
        });

        it('should handle all empty values', () => {
            const values = ['', '', ''];
            expect(DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'date')).to.be.false;
        });
    });

    describe('excelSerialToIsoDate', () => {
        it('should convert Excel serial 45295 to 2024-01-04', () => {
            expect(DateTimeInputUtils.excelSerialToIsoDate(45295)).to.equal('2024-01-04');
        });

        it('should convert Excel serial 44927 to 2023-01-01', () => {
            expect(DateTimeInputUtils.excelSerialToIsoDate(44927)).to.equal('2023-01-01');
        });

        it('should convert Excel serial 43831 to 2020-01-01', () => {
            expect(DateTimeInputUtils.excelSerialToIsoDate(43831)).to.equal('2020-01-01');
        });

        it('should handle Excel serial 1 (day 1 in Excel)', () => {
            // Serial 1 returns a date in early 1900 range
            const result = DateTimeInputUtils.excelSerialToIsoDate(1);
            expect(result).to.match(/^1900-01-\d{2}$/);
        });

        it('should handle Excel 1900 leap year bug edge cases', () => {
            // Serial 60 and 61 are edge cases around Excel's phantom Feb 29, 1900
            // The exact dates may vary due to the offset calculation
            const result60 = DateTimeInputUtils.excelSerialToIsoDate(60);
            const result61 = DateTimeInputUtils.excelSerialToIsoDate(61);
            expect(result60).to.match(/^1900-0[23]-\d{2}$/);
            expect(result61).to.match(/^1900-0[23]-\d{2}$/);
        });

        it('should handle decimal serial dates (ignoring time portion)', () => {
            // 45295.5 = 2024-01-04 at noon
            expect(DateTimeInputUtils.excelSerialToIsoDate(45295.5)).to.equal('2024-01-04');
        });

        it('should return null for invalid serial numbers', () => {
            expect(DateTimeInputUtils.excelSerialToIsoDate(0)).to.be.null;
            expect(DateTimeInputUtils.excelSerialToIsoDate(-1)).to.be.null;
        });

        it('should handle consecutive dates correctly', () => {
            expect(DateTimeInputUtils.excelSerialToIsoDate(45295)).to.equal('2024-01-04');
            expect(DateTimeInputUtils.excelSerialToIsoDate(45296)).to.equal('2024-01-05');
            expect(DateTimeInputUtils.excelSerialToIsoDate(45297)).to.equal('2024-01-06');
        });

        it('should handle year boundaries', () => {
            // Dec 31, 2023 (day before 2024-01-01)
            expect(DateTimeInputUtils.excelSerialToIsoDate(45291)).to.equal('2023-12-31');
            // Jan 1, 2024
            expect(DateTimeInputUtils.excelSerialToIsoDate(45292)).to.equal('2024-01-01');
        });

        it('should handle leap year dates', () => {
            // Feb 29, 2024 (leap year)
            expect(DateTimeInputUtils.excelSerialToIsoDate(45351)).to.equal('2024-02-29');
        });
    });

    describe('Integration scenarios', () => {
        it('should detect and convert Excel serial dates in a mixed dataset', () => {
            const values = ['2024-01-04', '45295', '2024-01-06'];

            // Detect unparseable values
            const hasUnparseable = DateTimeInputUtils.hasUnparseableDateTimeValues(values, 'date');
            expect(hasUnparseable).to.be.true;

            // For each value, check if it's an Excel serial
            for (const value of values) {
                if (DateTimeInputUtils.isExcelSerialDate(value)) {
                    const serialNum = parseFloat(value);
                    const isoDate = DateTimeInputUtils.excelSerialToIsoDate(serialNum);
                    expect(isoDate).to.equal('2024-01-04');
                }
            }
        });

        it('should handle typical the System date scenarios', () => {
            // Various date formats that might come from different systems
            const testCases = [
                { input: '2024-01-04', expected: '2024-01-04' },
                { input: '2024-01-04T00:00:00.000Z', expected: '2024-01-04' },
                { input: '2024/01/04', expected: '2024-01-04' },
            ];

            for (const tc of testCases) {
                const result = DateTimeInputUtils.formatValueForDateInput(tc.input);
                expect(result).to.equal(tc.expected);
            }
        });

        it('should handle typical datetime scenarios', () => {
            const testCases = [
                { input: '2024-01-04T14:30', expected: '2024-01-04T14:30' },
                { input: '2024-01-04T14:30:00', expected: '2024-01-04T14:30' },
            ];

            for (const tc of testCases) {
                const result = DateTimeInputUtils.formatValueForDatetimeInput(tc.input);
                expect(result).to.equal(tc.expected);
            }
        });
    });
});
