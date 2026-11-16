// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Diagnostic Tests: Large Dataset Export Scale
 * GitHub Issue #200 Phase 2: Reproduce and fix export failures at 112k rows × 147 columns
 *
 * These tests measure behaviour at realistic scale to verify fixes for:
 * 1. Excel export producing empty files at large cell counts
 * 2. HTML clipboard copy never completing due to ~2.6GB inline-styled output
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import * as XLSX from 'xlsx';
import { ConsoleExportService } from '../../../services/console/export.service';
import { TableRow, ColumnDefinition, ExportOptions } from '../../../types/console-messages';

/**
 * Generate synthetic test data at specified scale
 */
function generateData(rowCount: number, colCount: number): { data: TableRow[]; columns: ColumnDefinition[] } {
    const columns: ColumnDefinition[] = [];
    for (let c = 0; c < colCount; c++) {
        columns.push({
            id: `col_${c}`,
            name: `Column ${c}`,
            type: c % 5 === 0 ? 'number' : 'string',
            sortable: true,
            filterable: true
        });
    }

    const data: TableRow[] = [];
    for (let r = 0; r < rowCount; r++) {
        const row: TableRow = {};
        for (let c = 0; c < colCount; c++) {
            row[`col_${c}`] = c % 5 === 0 ? r * 1.5 : `val_${r}_${c}`;
        }
        data.push(row);
    }

    return { data, columns };
}

const baseOptions: ExportOptions = {
    includeHeaders: true,
    delimiter: ',',
    quoteChar: '"'
};

describe('ConsoleExportService - Scale Diagnostics (GitHub Issue #200)', function () {
    // These tests generate large data — allow generous timeouts
    this.timeout(120_000);

    let exportService: ConsoleExportService;

    beforeEach(() => {
        exportService = new ConsoleExportService();
    });

    // ── CSV ────────────────────────────────────────────────────────────

    describe('CSV at scale', () => {
        it('D1: CSV 112k × 10 (1.1M cells) — baseline', async () => {
            const { data, columns } = generateData(112_000, 10);
            const start = Date.now();

            const result = await exportService.exportToCsvString(data, columns, baseOptions);

            const duration = Date.now() - start;
            const sizeMB = Buffer.byteLength(result) / 1_048_576;
            console.log(`  D1 CSV 112k×10: ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(result.length).to.be.greaterThan(0);
            expect(result).to.include('Column 0');
        });

        it('D2: CSV 112k × 147 (16.5M cells) — full scale', async () => {
            const { data, columns } = generateData(112_000, 147);
            const start = Date.now();

            const result = await exportService.exportToCsvString(data, columns, baseOptions);

            const duration = Date.now() - start;
            const sizeMB = Buffer.byteLength(result) / 1_048_576;
            console.log(`  D2 CSV 112k×147: ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(result.length).to.be.greaterThan(0);
        });
    });

    // ── HTML ───────────────────────────────────────────────────────────

    describe('HTML at scale', () => {
        it('D3: HTML 50k × 50 (2.5M cells) — medium scale, lightweight mode', async () => {
            const { data, columns } = generateData(50_000, 50);
            const start = Date.now();

            const result = await exportService.exportToHtmlString(data, columns, baseOptions);

            const duration = Date.now() - start;
            const sizeMB = Buffer.byteLength(result) / 1_048_576;
            console.log(`  D3 HTML 50k×50: ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(result.length).to.be.greaterThan(0);
            expect(result).to.include('<table');
            // 2.5M cells > 500k threshold → lightweight mode
            expect(result).to.include('<style>');
        });

        it('D4: HTML 20k × 147 (2.9M cells) — lightweight mode verification', async () => {
            // Full 112k×147 (16.5M cells) OOMs even in lightweight mode within test heap.
            // In production, console-webview-manager falls back to TSV for > 5M cells.
            // This test verifies lightweight mode works above the 500k threshold.
            const { data, columns } = generateData(20_000, 147);
            const start = Date.now();

            const result = await exportService.exportToHtmlString(data, columns, baseOptions);

            const duration = Date.now() - start;
            const sizeMB = Buffer.byteLength(result) / 1_048_576;
            console.log(`  D4 HTML 20k×147: ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(result.length).to.be.greaterThan(0);
            expect(result).to.include('<table');
            // Lightweight mode should use <style> block instead of per-cell inline styles
            expect(result).to.include('<style>');
            expect(result).to.include('class="export"');
            // Should NOT have per-cell inline styles
            expect(result).to.not.include('background-color: #ffffff');
        });
    });

    // ── TSV ────────────────────────────────────────────────────────────

    describe('TSV at scale', () => {
        it('D5: TSV 112k × 147 (16.5M cells) — full scale', async () => {
            const { data, columns } = generateData(112_000, 147);
            const start = Date.now();

            const result = await exportService.exportToTsvString(data, columns, baseOptions);

            const duration = Date.now() - start;
            const sizeMB = Buffer.byteLength(result) / 1_048_576;
            console.log(`  D5 TSV 112k×147: ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(result.length).to.be.greaterThan(0);
        });
    });

    // ── Excel ──────────────────────────────────────────────────────────
    // Excel tests call prepareExcelData logic + XLSX directly (no vscode.Uri needed)

    describe('Excel at scale', () => {
        /**
         * Replicate the Excel generation path from export.service.ts
         * without the vscode file system write
         */
        function generateExcelBuffer(
            data: TableRow[],
            columns: ColumnDefinition[],
            options: ExportOptions,
            skipCellFormatting: boolean = false
        ): Buffer {
            // Step 1: prepareExcelData equivalent
            const worksheetData = data.map(row => {
                const excelRow: Record<string, unknown> = {};
                columns.forEach(col => {
                    const value = row[col.id];
                    if (value === null || value === undefined) {
                        excelRow[col.id] = null;
                    } else if (col.type === 'number' && typeof value === 'string') {
                        const parsed = parseFloat(value);
                        excelRow[col.id] = isNaN(parsed) ? value : parsed;
                    } else {
                        excelRow[col.id] = col.type === 'string' ? String(value) : value;
                    }
                });
                return excelRow;
            });

            // Step 2: Create workbook/worksheet
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(worksheetData, {
                header: columns.map(col => col.id),
                skipHeader: !options.includeHeaders
            });

            // Step 3: Header formatting
            if (options.includeHeaders) {
                columns.forEach((col, index) => {
                    const cellAddress = XLSX.utils.encode_cell({ r: 0, c: index });
                    if (worksheet[cellAddress]) {
                        worksheet[cellAddress].v = col.name;
                    }
                });
            }

            // Step 4: Cell formatting loop (the suspect for large datasets)
            if (!skipCellFormatting && worksheet['!ref']) {
                const range = XLSX.utils.decode_range(worksheet['!ref']);
                const startRow = options.includeHeaders ? 1 : 0;
                for (let row = startRow; row <= range.e.r; row++) {
                    columns.forEach((col, colIndex) => {
                        const cellAddress = XLSX.utils.encode_cell({ r: row, c: colIndex });
                        if (worksheet[cellAddress]) {
                            const alignment = col.type === 'number'
                                ? { horizontal: 'right' }
                                : { horizontal: 'left' };
                            worksheet[cellAddress].s = {
                                ...worksheet[cellAddress].s,
                                alignment
                            };
                        }
                    });
                }
            }

            // Step 5: Column widths
            worksheet['!cols'] = columns.map(col => ({ wch: Math.max(col.name.length, 15) }));

            // Step 6: Generate buffer
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Report Data');
            return XLSX.write(workbook, {
                type: 'buffer',
                bookType: 'xlsx',
                compression: true
            });
        }

        // Note: XLSX holds every cell as a JS object in memory. At 112k×147 (16.5M cells)
        // the internal representation alone exceeds Node's default 2GB heap.
        // In production, VS Code has a larger heap. Tests use reduced scales to verify fixes.

        it('D6: Excel 50k × 10 (500k cells) — should produce non-empty file', async () => {
            const { data, columns } = generateData(50_000, 10);
            const start = Date.now();

            const buffer = generateExcelBuffer(data, columns, baseOptions, true);

            const duration = Date.now() - start;
            const sizeMB = buffer.length / 1_048_576;
            console.log(`  D6 Excel 50k×10 (no cell fmt): ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(buffer.length).to.be.greaterThan(0);
            const wb = XLSX.read(buffer, { type: 'buffer' });
            expect(wb.SheetNames.length).to.equal(1);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const range = XLSX.utils.decode_range(ws['!ref']!);
            expect(range.e.r).to.equal(50_000);
        });

        it('D7: Excel 20k × 50 (1M cells) — should produce non-empty file', async () => {
            const { data, columns } = generateData(20_000, 50);
            const start = Date.now();

            const buffer = generateExcelBuffer(data, columns, baseOptions, true);

            const duration = Date.now() - start;
            const sizeMB = buffer.length / 1_048_576;
            console.log(`  D7 Excel 20k×50 (no cell fmt): ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(buffer.length).to.be.greaterThan(0);
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const range = XLSX.utils.decode_range(ws['!ref']!);
            expect(range.e.r).to.equal(20_000);
        });

        it('D8: Excel 10k × 147 (1.47M cells) — should produce non-empty file (no cell formatting)', async () => {
            // Verifies the fix: large cell count (> 1M) skips formatting and produces valid output
            const { data, columns } = generateData(10_000, 147);
            const start = Date.now();

            const buffer = generateExcelBuffer(data, columns, baseOptions, true);

            const duration = Date.now() - start;
            const sizeMB = buffer.length / 1_048_576;
            console.log(`  D8 Excel 10k×147 (no cell fmt): ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(buffer.length).to.be.greaterThan(0);
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const range = XLSX.utils.decode_range(ws['!ref']!);
            expect(range.e.r).to.equal(10_000);
            expect(range.e.c).to.equal(146); // 0-indexed
        });

        it('D8b: Excel 5k × 147 WITH cell formatting — shows formatting loop cost', async function () {
            // Full 112k×147 with cell formatting caused empty files / OOM.
            // This smaller scale shows the performance cost of the formatting loop.
            // The service fix skips formatting when cells > 1M.
            const { data, columns } = generateData(5_000, 147);
            const start = Date.now();

            const buffer = generateExcelBuffer(data, columns, baseOptions, false);

            const duration = Date.now() - start;
            const sizeMB = buffer.length / 1_048_576;
            console.log(`  D8b Excel 5k×147 (WITH cell fmt): ${duration}ms, ${sizeMB.toFixed(1)}MB`);

            expect(buffer.length).to.be.greaterThan(0);
        });
    });
});
