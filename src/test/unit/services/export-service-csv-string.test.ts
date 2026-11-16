// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests: CSV String Generation
 * GitHub Issue #120: Add capability to copy CSV to clipboard
 *
 * Following Architecture.md - Unit tests for pure business logic
 * Tests the exportToCsvString method in isolation
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ConsoleExportService } from '../../../services/console/export.service';
import { TableRow, ColumnDefinition, ExportOptions } from '../../../types/console-messages';

describe('ConsoleExportService - CSV String Generation', () => {
    let exportService: ConsoleExportService;

    beforeEach(() => {
        exportService = new ConsoleExportService();
    });

    describe('Basic CSV Generation', () => {
        it('should generate CSV string with headers', async () => {
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

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID,Name\n1,Test\n');
        });

        it('should generate CSV string without headers', async () => {
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

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('1,Test\n');
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

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID,Name\n1,First\n2,Second\n3,Third\n');
        });
    });

    describe('Special Character Handling', () => {
        it('should escape quotes correctly', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Item "with quotes"' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true,
                delimiter: ',',
                quoteChar: '"'
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            // Quotes inside values should be doubled and the whole value quoted
            expect(result).to.include('"Item ""with quotes"""');
        });

        it('should quote values containing commas', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Item, with comma' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true,
                delimiter: ',',
                quoteChar: '"'
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.include('"Item, with comma"');
        });

        it('should quote values containing newlines', async () => {
            const data: TableRow[] = [
                { id: '1', description: 'Line1\nLine2' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'description', name: 'Description', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true,
                delimiter: ',',
                quoteChar: '"'
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.include('"Line1\nLine2"');
        });
    });

    describe('Custom Delimiters', () => {
        it('should use semicolon as delimiter', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true,
                delimiter: ';',
                quoteChar: '"'
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID;Name\n1;Test\n');
        });

        it('should use tab as delimiter', async () => {
            const data: TableRow[] = [
                { id: '1', name: 'Test' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true,
                delimiter: '\t',
                quoteChar: '"'
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID\tName\n1\tTest\n');
        });
    });

    describe('Data Type Handling', () => {
        it('should handle number types correctly', async () => {
            const data: TableRow[] = [
                { id: 1, value: 123.45 }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'number', sortable: true, filterable: true },
                { id: 'value', name: 'Value', type: 'number', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID,Value\n1,123.45\n');
        });

        it('should handle boolean types correctly', async () => {
            const data: TableRow[] = [
                { id: '1', active: true, deleted: false }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'active', name: 'Active', type: 'boolean', sortable: true, filterable: true },
                { id: 'deleted', name: 'Deleted', type: 'boolean', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID,Active,Deleted\n1,true,false\n');
        });

        it('should serialize arrays as JSON', async () => {
            const data: TableRow[] = [
                { id: '1', tags: ['tag1', 'tag2', 'tag3'] }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'tags', name: 'Tags', type: 'array', sortable: false, filterable: false }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            // Arrays should be JSON stringified and quoted (because of special chars in JSON)
            // The output will have escaped quotes: "[""tag1"",""tag2"",""tag3""]"
            expect(result).to.include('tag1');
            expect(result).to.include('tag2');
            expect(result).to.include('tag3');
        });

        it('should serialize objects as JSON', async () => {
            const data: TableRow[] = [
                { id: '1', metadata: { key: 'value', count: 42 } }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'metadata', name: 'Metadata', type: 'object', sortable: false, filterable: false }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            // Objects should be JSON stringified and quoted (because of special chars)
            expect(result).to.match(/"?\{.*key.*value.*count.*42.*\}"?/);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty datasets', async () => {
            const data: TableRow[] = [];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID\n');
        });

        it('should handle null values', async () => {
            const data: TableRow[] = [
                { id: '1', name: null }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            // Null values should be rendered as empty string
            expect(result).to.equal('ID,Name\n1,\n');
        });

        it('should handle undefined values', async () => {
            const data: TableRow[] = [
                { id: '1', name: undefined }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            // Undefined values should be rendered as empty string
            expect(result).to.equal('ID,Name\n1,\n');
        });

        it('should handle empty strings', async () => {
            const data: TableRow[] = [
                { id: '1', name: '' }
            ];

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const result = await exportService.exportToCsvString(data, columns, options);

            expect(result).to.equal('ID,Name\n1,\n');
        });
    });

    describe('Performance', () => {
        it('should handle large datasets efficiently', async () => {
            // Generate 10,000 rows
            const data: TableRow[] = Array.from({ length: 10000 }, (_, i) => ({
                id: String(i + 1),
                name: `Item ${i + 1}`,
                value: Math.random() * 1000
            }));

            const columns: ColumnDefinition[] = [
                { id: 'id', name: 'ID', type: 'string', sortable: true, filterable: true },
                { id: 'name', name: 'Name', type: 'string', sortable: true, filterable: true },
                { id: 'value', name: 'Value', type: 'number', sortable: true, filterable: true }
            ];

            const options: ExportOptions = {
                includeHeaders: true
            };

            const startTime = Date.now();
            const result = await exportService.exportToCsvString(data, columns, options);
            const duration = Date.now() - startTime;

            // Should complete in reasonable time (< 2 seconds for 10k rows)
            expect(duration).to.be.lessThan(2000);

            // Verify row count
            const lines = result.split('\n').filter(line => line.trim());
            expect(lines.length).to.equal(10001); // 1 header + 10000 data rows
        });

        it('should handle 100k rows x 20 columns in under 2 seconds (GitHub Issue #200)', async () => {
            // GitHub Issue #200: Clipboard export hangs for large datasets
            // This test verifies the O(n) Array.join() fix at production scale
            const colCount = 20;
            const rowCount = 100000;

            const columns: ColumnDefinition[] = Array.from({ length: colCount }, (_, i) => ({
                id: `col_${i}`,
                name: `Column ${i}`,
                type: 'string' as const,
                sortable: true,
                filterable: true
            }));

            const data: TableRow[] = Array.from({ length: rowCount }, (_, i) => {
                const row: TableRow = {};
                for (let c = 0; c < colCount; c++) {
                    row[`col_${c}`] = `value_${i}_${c}`;
                }
                return row;
            });

            const options: ExportOptions = {
                includeHeaders: true
            };

            const startTime = Date.now();
            const result = await exportService.exportToCsvString(data, columns, options);
            const duration = Date.now() - startTime;

            // Must complete in under 2 seconds (was hanging at this scale before fix)
            expect(duration).to.be.lessThan(2000);

            // Verify correctness
            const lines = result.split('\n').filter(line => line.trim());
            expect(lines.length).to.equal(rowCount + 1); // header + data rows
        });
    });
});
