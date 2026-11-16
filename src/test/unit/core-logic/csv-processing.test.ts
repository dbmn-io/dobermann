// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Unit Tests for CSV Processing Utilities
 * 
 * These tests verify pure business logic for CSV file processing,
 * validation, and data transformation without DOM dependencies.
 */

// CSV Processing Utility Functions
class CsvProcessor {
    /**
     * Validates CSV file type based on extension and MIME type
     */
    static validateCsvFile(fileName: string, mimeType: string): boolean {
        const hasValidExtension = fileName.toLowerCase().endsWith('.csv');
        const hasValidMimeType = mimeType === 'text/csv' || mimeType === 'application/csv';
        return hasValidExtension && hasValidMimeType;
    }

    /**
     * Parses CSV content into headers and rows
     */
    static parseCsvContent(csvContent: string): { headers: string[], rows: string[][] } {
        const trimmed = csvContent.trim();
        if (trimmed === '') {
            return { headers: [], rows: [] };
        }

        const lines = trimmed.split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        const rows = lines.slice(1).map(line => 
            line.split(',').map(cell => cell.trim())
        );

        return { headers, rows };
    }

    /**
     * Creates preview data structure for CSV display
     */
    static createCsvPreview(headers: string[], rows: string[][], maxRows: number = 5): {
        headers: string[],
        previewRows: string[][],
        totalRows: number,
        isPreview: boolean
    } {
        const previewRows = rows.slice(0, maxRows);
        return {
            headers,
            previewRows,
            totalRows: rows.length,
            isPreview: rows.length > maxRows
        };
    }

    /**
     * Determines if CSV has no data
     */
    static isEmpty(headers: string[], rows: string[][]): boolean {
        return headers.length === 0 || rows.length === 0;
    }

    /**
     * Generates row count display message
     */
    static getRowCountMessage(totalRows: number, previewRows: number): string {
        if (totalRows <= previewRows) {
            return `Showing all ${totalRows} rows`;
        }
        return `Showing ${previewRows} of ${totalRows} rows`;
    }
}

describe('CSV Processing Utilities', () => {
    
    describe('validateCsvFile', () => {
        it('should validate files with correct extension and MIME type', () => {
            expect(CsvProcessor.validateCsvFile('data.csv', 'text/csv')).to.be.true;
            expect(CsvProcessor.validateCsvFile('data.csv', 'application/csv')).to.be.true;
        });

        it('should reject files with incorrect extension', () => {
            expect(CsvProcessor.validateCsvFile('data.txt', 'text/csv')).to.be.false;
            expect(CsvProcessor.validateCsvFile('data.xlsx', 'text/csv')).to.be.false;
        });

        it('should reject files with incorrect MIME type', () => {
            expect(CsvProcessor.validateCsvFile('data.csv', 'text/plain')).to.be.false;
            expect(CsvProcessor.validateCsvFile('data.csv', 'application/json')).to.be.false;
        });

        it('should handle mixed case extensions', () => {
            expect(CsvProcessor.validateCsvFile('data.CSV', 'text/csv')).to.be.true;
            expect(CsvProcessor.validateCsvFile('DATA.csv', 'text/csv')).to.be.true;
        });
    });

    describe('parseCsvContent', () => {
        it('should parse simple CSV content', () => {
            const csvContent = 'Name,Age,City\nJohn,25,NYC\nJane,30,LA';
            const result = CsvProcessor.parseCsvContent(csvContent);
            
            expect(result.headers).to.deep.equal(['Name', 'Age', 'City']);
            expect(result.rows).to.deep.equal([
                ['John', '25', 'NYC'],
                ['Jane', '30', 'LA']
            ]);
        });

        it('should handle empty CSV content', () => {
            const result = CsvProcessor.parseCsvContent('');
            expect(result.headers).to.deep.equal([]);
            expect(result.rows).to.deep.equal([]);
        });

        it('should handle CSV with headers only', () => {
            const csvContent = 'Name,Age,City';
            const result = CsvProcessor.parseCsvContent(csvContent);
            
            expect(result.headers).to.deep.equal(['Name', 'Age', 'City']);
            expect(result.rows).to.deep.equal([]);
        });

        it('should trim whitespace from headers and cells', () => {
            const csvContent = ' Name , Age , City \n John , 25 , NYC ';
            const result = CsvProcessor.parseCsvContent(csvContent);
            
            expect(result.headers).to.deep.equal(['Name', 'Age', 'City']);
            expect(result.rows).to.deep.equal([['John', '25', 'NYC']]);
        });
    });

    describe('createCsvPreview', () => {
        it('should create preview with limited rows', () => {
            const headers = ['Name', 'Age'];
            const rows = [
                ['John', '25'],
                ['Jane', '30'], 
                ['Bob', '35'],
                ['Alice', '28'],
                ['Charlie', '32'],
                ['Diana', '27']
            ];
            
            const preview = CsvProcessor.createCsvPreview(headers, rows, 3);
            
            expect(preview.headers).to.deep.equal(headers);
            expect(preview.previewRows).to.have.length(3);
            expect(preview.totalRows).to.equal(6);
            expect(preview.isPreview).to.be.true;
        });

        it('should show all rows when total is less than max', () => {
            const headers = ['Name', 'Age'];
            const rows = [['John', '25'], ['Jane', '30']];
            
            const preview = CsvProcessor.createCsvPreview(headers, rows, 5);
            
            expect(preview.previewRows).to.have.length(2);
            expect(preview.totalRows).to.equal(2);
            expect(preview.isPreview).to.be.false;
        });
    });

    describe('isEmpty', () => {
        it('should detect empty CSV with no headers', () => {
            expect(CsvProcessor.isEmpty([], [])).to.be.true;
        });

        it('should detect CSV with headers but no data', () => {
            expect(CsvProcessor.isEmpty(['Name', 'Age'], [])).to.be.true;
        });

        it('should detect non-empty CSV', () => {
            expect(CsvProcessor.isEmpty(['Name'], [['John']])).to.be.false;
        });
    });

    describe('getRowCountMessage', () => {
        it('should show "all rows" message when no preview needed', () => {
            const message = CsvProcessor.getRowCountMessage(3, 5);
            expect(message).to.equal('Showing all 3 rows');
        });

        it('should show "X of Y rows" message when preview is limited', () => {
            const message = CsvProcessor.getRowCountMessage(10, 5);
            expect(message).to.equal('Showing 5 of 10 rows');
        });

        it('should handle edge case when counts are equal', () => {
            const message = CsvProcessor.getRowCountMessage(5, 5);
            expect(message).to.equal('Showing all 5 rows');
        });
    });
});