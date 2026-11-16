// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #226: Column-mismatch detection for CSV / TSV / pipe-delimited
 * content.
 *
 * Pure functions extracted from run-batch-webview.ts so they can be unit-tested
 * directly. The detection feeds the inline-repair panel that blocks Step 1 ->
 * Step 2 of the Run Batch flow when any data row has a different column count
 * than the header.
 *
 * Earlier fix-attempts (#135) lived inside the webview controller and were
 * silently bypassed by the file-upload code path; centralising the logic here
 * means every entry point uses the same detector.
 */

export type CsvDelimiter = ',' | '\t' | '|';

export interface ColumnMismatchRow {
    lineNumber: number; // 1-based (header is line 1, first data row is line 2)
    rawText: string;
    actualColumns: number;
}

export interface ColumnMismatchResult {
    expectedColumns: number;
    delimiter: CsvDelimiter;
    headerLine: string;
    rows: ColumnMismatchRow[];
}

export function detectDelimiter(content: string): CsvDelimiter {
    const firstLine = content.split('\n')[0] || '';
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const pipeCount = (firstLine.match(/\|/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;

    const max = Math.max(tabCount, pipeCount, commaCount);
    if (max === 0) return ',';
    if (tabCount === max) return '\t';
    if (pipeCount === max) return '|';
    return ',';
}

export function parseCSVLine(line: string, delimiter: CsvDelimiter = ','): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

export function parseCSVContent(csvContent: string, delimiter?: CsvDelimiter): {
    headers: string[];
    rows: string[][];
    rawLines: string[];
    delimiter: CsvDelimiter;
} {
    const rawLines = csvContent.split('\n').filter(line => line.trim().length > 0);
    if (rawLines.length === 0) {
        return { headers: [], rows: [], rawLines: [], delimiter: ',' };
    }

    const detected = delimiter || detectDelimiter(csvContent);
    const headers = parseCSVLine(rawLines[0], detected);
    const rows = rawLines.slice(1).map(line => parseCSVLine(line, detected));

    return { headers, rows, rawLines, delimiter: detected };
}

export function detectColumnMismatches(csvData: string): ColumnMismatchResult {
    const { headers, rows, rawLines, delimiter } = parseCSVContent(csvData);
    const expectedColumns = headers.length;
    const headerLine = rawLines[0] || '';

    const mismatched: ColumnMismatchRow[] = [];
    rows.forEach((row, index) => {
        if (row.length !== expectedColumns) {
            mismatched.push({
                lineNumber: index + 2,
                rawText: rawLines[index + 1] || '',
                actualColumns: row.length
            });
        }
    });

    return { expectedColumns, delimiter, headerLine, rows: mismatched };
}
