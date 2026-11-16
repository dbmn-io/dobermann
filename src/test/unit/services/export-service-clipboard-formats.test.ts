// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests: Clipboard Format Generation
 * GitHub Issue #174: Add multiple copy formats (TSV, HTML, Markdown)
 *
 * Following Architecture.md - Unit tests for pure business logic
 * Tests the exportToTsvString, exportToHtmlString, and exportToMarkdownString methods
 */

import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { ConsoleExportService } from '../../../services/console/export.service';
import { TableRow, ColumnDefinition, ExportOptions } from '../../../types/console-messages';

describe('ConsoleExportService - Clipboard Format Generation (GitHub Issue #174)', () => {
    let exportService: ConsoleExportService;

    beforeEach(() => {
        exportService = new ConsoleExportService();
    });

    describe('TSV String Generation', () => {
        it('should generate TSV string with headers', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToTsvString(data, columns, options);

            expect(result).to.equal('ID\tName\n1\tTest\n');
        });

        it('should generate TSV string without headers', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: false
            };

            const result = await exportService.exportToTsvString(data, columns, options);

            expect(result).to.equal('1\tTest\n');
        });

        it('should replace tabs in values with spaces', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Value\twith\ttabs' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToTsvString(data, columns, options);

            // Tabs should be replaced with spaces
            expect(result).to.include('Value with tabs');
            expect(result).to.not.include('Value\twith\ttabs');
        });

        it('should replace newlines in values with spaces', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Line1\nLine2' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToTsvString(data, columns, options);

            // Newlines should be replaced with spaces
            expect(result).to.include('Line1 Line2');
        });

        it('should handle commas in values without escaping', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Value, with comma' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToTsvString(data, columns, options);

            // Commas should be preserved as-is (not quoted)
            expect(result).to.include('Value, with comma');
        });
    });

    describe('HTML String Generation', () => {
        it('should generate HTML table with headers', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            expect(result).to.include('<table');
            expect(result).to.include('<thead>');
            expect(result).to.include('<th');
            expect(result).to.include('>ID</th>');
            expect(result).to.include('>Name</th>');
            expect(result).to.include('<tbody>');
            expect(result).to.include('<td');
            expect(result).to.include('>1</td>');
            expect(result).to.include('>Test</td>');
            expect(result).to.include('</table>');
        });

        it('should generate HTML table without headers', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: false
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            expect(result).to.include('<table');
            expect(result).to.not.include('<thead>');
            expect(result).to.include('<tbody>');
            expect(result).to.include('>1</td>');
        });

        it('should include a style block with table + header styling (GitHub Issue #225)', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            // Should use a class-based <style> block (cleaner, smaller, user wants zero body styling)
            expect(result).to.include('<style>');
            expect(result).to.include('border-collapse:collapse');
            // Header row styling preserved
            expect(result).to.include('table.export th{');
            expect(result).to.include('border:1px solid');
        });

        it('should escape HTML special characters', async () => {
            const data: TableRow[] = [
                { id: '1', name: '<script>alert("XSS")</script>' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            // HTML special characters should be escaped
            expect(result).to.include('&lt;script&gt;');
            expect(result).to.not.include('<script>');
        });

        it('body <td> cells should be bare with no styling (GitHub Issue #225)', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'First' },
                { id: '2', name: 'Second' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            // Data cells (<td>) must have NO inline style, NO border, NO padding, NO background
            const tdTags = result.match(/<td[^>]*>/g) || [];
            expect(tdTags.length).to.be.greaterThan(0);
            for (const td of tdTags) {
                expect(td).to.not.include('style=');
                expect(td).to.not.include('background-color');
                expect(td).to.not.include('border');
                expect(td).to.not.include('padding');
            }
            // String cells get class="x" which carries the mso-number-format hint via style block
            expect(result).to.include('<td class="x">');
            expect(result).to.include('mso-number-format:"\\@"');
        });

        it('number column cells should be bare (GitHub Issue #225 — no body formatting)', async () => {
            const data: TableRow[] = [
                { id: '1', value: 123.45 }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'value', name: 'Value', type: 'number', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToHtmlString(data, columns, options);

            // Number cell should be bare <td>123.45</td> — no class, no style
            expect(result).to.include('<td>123.45</td>');
        });
    });

    describe('Excel-safe Text Prefix (GitHub Issue #225)', () => {
        const data: TableRow[] = [
            { gln: '0012345000015', qty: 42, name: 'Goodest Boy' }
        ];
        const columns: ColumnDefinition[] = [
            { id: 'gln', name: 'gln', type: 'string', sortable: true, filterable: true },
            { id: 'qty', name: 'qty', type: 'number', sortable: true, filterable: true },
            { id: 'name', name: 'name', type: 'string', sortable: true, filterable: true }
        ];

        it('CSV: excelSafeStrings prefixes string columns with apostrophe', async () => {
            const result = await exportService.exportToCsvString(data, columns, {
                includeHeaders: true,
                excelSafeStrings: true
            });
            expect(result).to.include("'0012345000015");
            expect(result).to.include("'Goodest Boy");
            // Number column must NOT get the prefix
            expect(result).to.not.include("'42");
        });

        it('CSV: excelSafeStrings false (default) produces clean output', async () => {
            const result = await exportService.exportToCsvString(data, columns, {
                includeHeaders: true
            });
            expect(result).to.include('0012345000015');
            expect(result).to.not.include("'0012345000015");
        });

        it('TSV: excelSafeStrings prefixes string columns with apostrophe', async () => {
            const result = await exportService.exportToTsvString(data, columns, {
                includeHeaders: true,
                excelSafeStrings: true
            });
            expect(result).to.include("'0012345000015");
            expect(result).to.not.include("'42");
        });

        it('CSV: empty string values are NOT prefixed', async () => {
            const result = await exportService.exportToCsvString(
                [{ gln: '', qty: 42, name: 'x' }],
                columns,
                { includeHeaders: true, excelSafeStrings: true }
            );
            // gln is empty — no apostrophe added (no value to protect)
            // Column separator comes right after the header line
            const lines = result.split('\n');
            expect(lines[1].startsWith(',')).to.equal(true);  // empty gln, then ,
        });
    });

    describe('Markdown String Generation', () => {
        it('should generate Markdown table with headers', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToMarkdownString(data, columns, options);

            // Should have header row
            expect(result).to.include('| ID');
            expect(result).to.include('| Name');
            // Should have separator row (with padding)
            expect(result).to.include('| ---');
            // Should have data row
            expect(result).to.include('| 1');
            expect(result).to.include('| Test');
        });

        it('should escape pipe characters in values', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Value|with|pipes' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToMarkdownString(data, columns, options);

            // Pipes should be escaped
            expect(result).to.include('Value\\|with\\|pipes');
        });

        it('should right-align number columns in separator', async () => {
            const data: TableRow[] = [
                { id: '1', value: 123 }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'value', name: 'Value', type: 'number', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToMarkdownString(data, columns, options);
            const lines = result.split('\n');

            // Find the separator line
            const separatorLine = lines.find(line => line.includes('---'));
            expect(separatorLine).to.exist;

            // Number column separator should end with : for right alignment
            expect(separatorLine).to.include('-:');
        });

        it('should replace newlines in values with spaces', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Line1\nLine2' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToMarkdownString(data, columns, options);

            // Newlines should be replaced with spaces to preserve table structure
            expect(result).to.include('Line1 Line2');
        });

        it('should handle multiple rows', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'First' },
                { id: '2', name: 'Second' },
                { id: '3', name: 'Third' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToMarkdownString(data, columns, options);

            const lines = result.split('\n').filter(line => line.trim());

            // Should have 5 lines: header, separator, 3 data rows
            expect(lines.length).to.equal(5);
        });
    });

    describe('Performance (GitHub Issue #200)', () => {
        // Shared large dataset for performance tests
        const colCount = 20;
        const rowCount = 100000;
        let largeColumns: ColumnDefinition[];
        let largeData: TableRow[];

        before(() => {
            largeColumns = Array.from({ length: colCount }, (_, i) => ({
                id: `col_${i}`,
                name: `Column ${i}`,
                type: (i % 4 === 0 ? 'number' : 'string') as 'number' | 'string',
                sortable: true,
                filterable: true
            }));

            largeData = Array.from({ length: rowCount }, (_, i) => {
                const row: TableRow = {};
                for (let c = 0; c < colCount; c++) {
                    row[`col_${c}`] = c % 4 === 0 ? i * 1.5 : `value_${i}_${c}`;
                }
                return row;
            });
        });

        it('TSV: 100k rows x 20 columns in under 2 seconds', async () => {
            const options: ExportOptions = { includeHeaders: true };

            const startTime = Date.now();
            const result = await exportService.exportToTsvString(largeData, largeColumns, options);
            const duration = Date.now() - startTime;

            expect(duration).to.be.lessThan(2000);
            const lines = result.split('\n').filter(line => line.trim());
            expect(lines.length).to.equal(rowCount + 1);
        });

        it('HTML: 100k rows x 20 columns in under 5 seconds', async () => {
            const options: ExportOptions = { includeHeaders: true };

            const startTime = Date.now();
            const result = await exportService.exportToHtmlString(largeData, largeColumns, options);
            const duration = Date.now() - startTime;

            // HTML is larger per-row due to inline styles, allow more time
            expect(duration).to.be.lessThan(5000);
            expect(result).to.include('<table');
            expect(result).to.include('</table>');
        });

        it('Markdown: 100k rows x 20 columns in under 2 seconds', async () => {
            const options: ExportOptions = { includeHeaders: true };

            const startTime = Date.now();
            const result = await exportService.exportToMarkdownString(largeData, largeColumns, options);
            const duration = Date.now() - startTime;

            expect(duration).to.be.lessThan(2000);
            const lines = result.split('\n').filter(line => line.trim());
            // header + separator + data rows
            expect(lines.length).to.equal(rowCount + 2);
        });
    });

    describe('Edge Cases', () => {
        it('TSV should handle empty datasets', async () => {
            const data: TableRow[] = [];
            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];
            const options: ExportOptions = { includeHeaders: true };

            const result = await exportService.exportToTsvString(data, columns, options);
            expect(result).to.equal('ID\n');
        });

        it('HTML should handle empty datasets', async () => {
            const data: TableRow[] = [];
            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];
            const options: ExportOptions = { includeHeaders: true };

            const result = await exportService.exportToHtmlString(data, columns, options);
            expect(result).to.include('<table');
            expect(result).to.include('<thead>');
            expect(result).to.include('</table>');
        });

        it('Markdown should handle empty datasets', async () => {
            const data: TableRow[] = [];
            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];
            const options: ExportOptions = { includeHeaders: true };

            const result = await exportService.exportToMarkdownString(data, columns, options);
            expect(result).to.include('| ID');
            expect(result).to.include('| ---');
        });

        it('all formats should handle null values', async () => {
            const data: TableRow[] = [
                { id: '1', name: null }
            ];
            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];
            const options: ExportOptions = { includeHeaders: true };

            const tsvResult = await exportService.exportToTsvString(data, columns, options);
            const htmlResult = await exportService.exportToHtmlString(data, columns, options);
            const markdownResult = await exportService.exportToMarkdownString(data, columns, options);

            // All should handle null gracefully (as empty string)
            expect(tsvResult).to.include('1\t\n');
            expect(htmlResult).to.include('></td>');
            expect(markdownResult).to.match(/\| 1\s+\|/);
        });
    });
});
