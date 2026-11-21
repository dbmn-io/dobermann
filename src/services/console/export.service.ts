// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Console Export Service
 *
 * Following Architecture.md - Service Design patterns
 * Backend business logic for exporting table data to various formats
 */

import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { 
    ExportFormat, 
    ExportOptions,
    TableRow,
    ColumnDefinition 
} from '../../types/console-messages';

export interface SheetDefinition {
    sheetName: string;
    data: TableRow[];
    columns: ColumnDefinition[];
}

export interface IConsoleExportService {
    /**
     * Export table data to CSV format
     */
    exportToCsv(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to CSV string (for clipboard)
     * GitHub Issue #120: Add capability to copy CSV to clipboard
     */
    exportToCsvString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to TSV string (for clipboard - spreadsheet paste)
     * GitHub Issue #174: Add multiple copy formats
     */
    exportToTsvString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to HTML table string (for clipboard - email paste)
     * GitHub Issue #174: Add multiple copy formats
     */
    exportToHtmlString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to Markdown table string (for clipboard - Jira/docs paste)
     * GitHub Issue #174: Add multiple copy formats
     */
    exportToMarkdownString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to Excel format
     */
    exportToExcel(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export multiple sheets to Excel format
     */
    exportToExcelMultiSheet(sheets: SheetDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to JSON format
     */
    exportToJson(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Export table data to SQL INSERT statements
     */
    exportToSql(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;

    /**
     * Generate type-aware HTML for dual-format clipboard (spreadsheet type preservation)
     * GitHub Issue #225: Preserve string types (leading zeros) in clipboard copy
     * Returns empty string if no string columns exist (caller should skip dual-format)
     */
    exportToTypeAwareHtmlString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string>;
}

export interface ConsoleExportServiceDependencies {
    fileSystemService?: any; // Future: Add proper file system service interface
    notificationService?: any; // Future: Add notification service interface
}

export class ConsoleExportService implements IConsoleExportService {
    constructor(
        private dependencies: ConsoleExportServiceDependencies = {}
    ) {}

    /**
     * Export table data to CSV format
     */
    async exportToCsv(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            // Generate CSV content using shared logic
            const csvContent = await this.exportToCsvString(data, columns, options);

            // The path the user chose to save to
            const filePath = options.targetUri;
            if (!filePath) {
                throw new Error('No save path provided for export');
            }
            const encoding = options.encoding || 'utf8';

            await fs.promises.writeFile(filePath, csvContent, { encoding: encoding as BufferEncoding });

            return filePath;

        } catch (error) {
            throw new Error(`CSV export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to CSV string (for clipboard)
     * GitHub Issue #120: Add capability to copy CSV to clipboard
     */
    async exportToCsvString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            const delimiter = options.delimiter || ',';
            const quoteChar = options.quoteChar || '"';
            const excelSafe = options.excelSafeStrings === true;

            const lines: string[] = [];

            // Add headers if requested
            if (options.includeHeaders) {
                const headers = columns.map(col => this.escapeValue(col.name, delimiter, quoteChar));
                lines.push(headers.join(delimiter));
            }

            // Add data rows
            for (const row of data) {
                const values = columns.map(col => {
                    const value = row[col.id];
                    let formatted = this.formatValueForCsv(value, col.type);
                    // GitHub Issue #225: Excel-safe text — prefix string columns with '
                    // so Excel preserves leading zeros / large numbers as text on paste.
                    if (excelSafe && col.type === 'string' && formatted !== '') {
                        formatted = "'" + formatted;
                    }
                    return this.escapeValue(formatted, delimiter, quoteChar);
                });
                lines.push(values.join(delimiter));
            }

            return lines.join('\n') + '\n';

        } catch (error) {
            throw new Error(`CSV string generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to TSV string (for clipboard - spreadsheet paste)
     * GitHub Issue #174: Add multiple copy formats
     * TSV pastes directly into Excel/Google Sheets with correct column alignment
     */
    async exportToTsvString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            const delimiter = '\t';
            const excelSafe = options.excelSafeStrings === true;
            const lines: string[] = [];

            // Add headers if requested
            if (options.includeHeaders) {
                const headers = columns.map(col => this.escapeValueForTsv(col.name));
                lines.push(headers.join(delimiter));
            }

            // Add data rows
            for (const row of data) {
                const values = columns.map(col => {
                    const value = row[col.id];
                    let formatted = this.formatValueForCsv(value, col.type);
                    // GitHub Issue #225: Excel-safe text — see exportToCsvString
                    if (excelSafe && col.type === 'string' && formatted !== '') {
                        formatted = "'" + formatted;
                    }
                    return this.escapeValueForTsv(formatted);
                });
                lines.push(values.join(delimiter));
            }

            return lines.join('\n') + '\n';

        } catch (error) {
            throw new Error(`TSV string generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to HTML table string (for clipboard - email paste)
     * GitHub Issue #174: Add multiple copy formats
     * HTML with inline styles works in Outlook, Gmail, Word, etc.
     */
    async exportToHtmlString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            // GitHub Issue #174: Tab-contextual header colour
            const headerColor = this.getHeaderColorForTab(options.tab);

            // GitHub Issue #200/#225: Always use class-based style block (lightweight by default).
            // Previously alternated to per-cell inline styles below 500k cells, but bare <td> with
            // a single <style> block is simpler, cleaner, and handles all sizes efficiently.
            const parts: string[] = [];

            // GitHub Issue #225: User wants NO body cell formatting. Header row keeps styling.
            // Body cells are bare <td>value</td>. String-typed cells get class="x" which carries
            // only mso-number-format:"\@" (text-format hint for Excel HTML paste).
            //
            // IMPORTANT: Body cells MUST explicitly set color + background, otherwise Excel's
            // clipboard paste inherits the webview's VS Code theme colours (dark bg, light text).
            // Setting color:#000;background:#fff forces light-theme defaults regardless of VS
            // Code theme. Excel applies these as cell fill/font colour on paste — which matches
            // a standard light-mode Excel cell.
            parts.push(`<style>
table.export{border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px}
table.export th{border:1px solid #ddd;padding:8px;background:${headerColor};color:#fff;text-align:left}
table.export td{color:#000;background:#fff}
table.export td.x{mso-number-format:"\\@"}
</style>`);
            parts.push('<table class="export">');

            // Add header row if requested
            if (options.includeHeaders) {
                parts.push('  <thead>\n    <tr>');
                for (const col of columns) {
                    parts.push(`      <th>${this.escapeHtml(col.name)}</th>`);
                }
                parts.push('    </tr>\n  </thead>');
            }

            // Add data rows — bare <td>, class="x" on string cells for mso-number-format hint
            parts.push('  <tbody>');
            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                parts.push('    <tr>');
                for (const col of columns) {
                    const value = row[col.id];
                    const formattedValue = this.formatValueForCsv(value, col.type);
                    const cls = col.type === 'string' ? ' class="x"' : '';
                    parts.push(`      <td${cls}>${this.escapeHtml(formattedValue)}</td>`);
                }
                parts.push('    </tr>');
            }
            parts.push('  </tbody>\n</table>');

            return parts.join('\n');

        } catch (error) {
            throw new Error(`HTML string generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to Markdown table string (for clipboard - Jira/docs paste)
     * GitHub Issue #174: Add multiple copy formats
     * GitHub Flavored Markdown tables work in Jira, Confluence, GitHub, Slack, etc.
     */
    async exportToMarkdownString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            const lines: string[] = [];

            // GitHub Issue #200: Sample-based column width calculation for large datasets
            // Scanning all rows is O(rows * cols) which is expensive at 100k+ rows
            const COLUMN_WIDTH_SAMPLE_SIZE = 100;
            const sampleLimit = Math.min(data.length, COLUMN_WIDTH_SAMPLE_SIZE);
            const colWidths = columns.map(col => {
                let maxWidth = col.name.length;
                for (let r = 0; r < sampleLimit; r++) {
                    const value = this.formatValueForCsv(data[r][col.id], col.type);
                    maxWidth = Math.max(maxWidth, value.length);
                }
                return Math.max(maxWidth, 3);
            });

            // Add header row
            if (options.includeHeaders) {
                const headers = columns.map((col, i) => this.escapeMarkdown(col.name).padEnd(colWidths[i]));
                lines.push('| ' + headers.join(' | ') + ' |');

                // Add separator row with alignment
                const separators = columns.map((col, i) => {
                    const width = colWidths[i];
                    if (col.type === 'number') {
                        return '-'.repeat(width - 1) + ':'; // Right align numbers
                    }
                    return '-'.repeat(width);
                });
                lines.push('| ' + separators.join(' | ') + ' |');
            }

            const excelSafe = options.excelSafeStrings === true;
            // Add data rows
            for (const row of data) {
                const values = columns.map((col, i) => {
                    const value = row[col.id];
                    let formatted = this.formatValueForCsv(value, col.type);
                    // GitHub Issue #225: Excel-safe text — prefix string cells with '
                    if (excelSafe && col.type === 'string' && formatted !== '') {
                        formatted = "'" + formatted;
                    }
                    return this.escapeMarkdown(formatted).padEnd(colWidths[i]);
                });
                lines.push('| ' + values.join(' | ') + ' |');
            }

            return lines.join('\n') + '\n';

        } catch (error) {
            throw new Error(`Markdown string generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to Excel format (.xlsx)
     * Creates a true Excel workbook with proper data types and formatting
     */
    async exportToExcel(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            // Prepare data for Excel export
            const worksheetData = this.prepareExcelData(data, columns, options);

            // Create workbook and worksheet
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(worksheetData, {
                header: columns.map(col => col.id),
                skipHeader: !options.includeHeaders
            });

            // Add column headers if requested
            if (options.includeHeaders) {
                // Replace column IDs with display names in the header row and apply formatting
                const headerRow = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']).s.r : 0;
                columns.forEach((col, index) => {
                    const cellAddress = XLSX.utils.encode_cell({ r: headerRow, c: index });
                    if (worksheet[cellAddress]) {
                        worksheet[cellAddress].v = col.name;
                        // Apply header formatting
                        worksheet[cellAddress].s = {
                            font: { bold: true, color: { rgb: 'FFFFFF' } },
                            fill: { fgColor: { rgb: '4472C4' } },
                            alignment: { horizontal: 'center', vertical: 'center' },
                            border: {
                                top: { style: 'thin', color: { rgb: '000000' } },
                                bottom: { style: 'thin', color: { rgb: '000000' } },
                                left: { style: 'thin', color: { rgb: '000000' } },
                                right: { style: 'thin', color: { rgb: '000000' } }
                            }
                        };
                    }
                });
            }
            
            // GitHub Issue #200: Skip per-cell formatting for large datasets (cosmetic only)
            // The loop touches every cell — at 16.5M cells it causes empty file / OOM
            const CELL_FORMAT_THRESHOLD = 1_000_000;
            const cellCount = data.length * columns.length;

            if (worksheet['!ref'] && cellCount <= CELL_FORMAT_THRESHOLD) {
                const range = XLSX.utils.decode_range(worksheet['!ref']);
                const startRow = options.includeHeaders ? 1 : 0;

                for (let row = startRow; row <= range.e.r; row++) {
                    columns.forEach((col, colIndex) => {
                        const cellAddress = XLSX.utils.encode_cell({ r: row, c: colIndex });
                        if (worksheet[cellAddress]) {
                            const cellFormat = this.getCellFormat(col.type);
                            if (cellFormat) {
                                worksheet[cellAddress].s = {
                                    ...worksheet[cellAddress].s,
                                    ...cellFormat
                                };
                            }
                        }
                    });
                }
            }

            // Set column widths for better readability
            const columnWidths = columns.map(col => ({ wch: Math.max(col.name.length, 15) }));
            worksheet['!cols'] = columnWidths;
            
            // Create Excel table for professional formatting
            if (worksheetData.length > 0 && options.includeHeaders) {
                const range = worksheet['!ref'];
                if (range) {
                    // Define table range
                    const tableRange = XLSX.utils.decode_range(range);
                    
                    // Create table definition
                    const tableDef = {
                        ref: range,
                        name: 'ReportTable',
                        displayName: 'Report Data',
                        headerRowCount: 1,
                        totalsRowCount: 0,
                        columns: columns.map((col, index) => ({
                            id: index + 1,
                            name: col.name,
                            totalsRowFunction: 'none'
                        })),
                        autoFilter: {
                            ref: range
                        },
                        tableStyleInfo: {
                            name: 'TableStyleMedium2',
                            showFirstColumn: false,
                            showLastColumn: false,
                            showRowStripes: true,
                            showColumnStripes: false
                        }
                    };
                    
                    // Add table to worksheet
                    if (!worksheet['!tables']) {
                        worksheet['!tables'] = [];
                    }
                    worksheet['!tables'].push(tableDef);
                    
                    // Set autofilter on the range
                    worksheet['!autofilter'] = { ref: range };
                }
            }
            
            // Add worksheet to workbook
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Report Data');
            
            // Generate Excel buffer with error handling
            let excelBuffer: Uint8Array;
            try {
                excelBuffer = new Uint8Array(XLSX.write(workbook, {
                    type: 'array',
                    bookType: 'xlsx',
                    compression: true
                }) as ArrayBuffer);
            } catch (xlsxError) {
                throw new Error(`XLSX.write failed (${data.length} rows × ${columns.length} cols): ${xlsxError instanceof Error ? xlsxError.message : String(xlsxError)}`);
            }

            // GitHub Issue #200: Verify buffer is non-empty before writing
            if (!excelBuffer || excelBuffer.length === 0) {
                throw new Error(`Excel buffer is empty (${data.length} rows × ${columns.length} cols = ${cellCount} cells)`);
            }

            // The path the user chose to save to
            const filePath = options.targetUri;
            if (!filePath) {
                throw new Error('No save path provided for export');
            }

            await fs.promises.writeFile(filePath, excelBuffer);

            return filePath;

        } catch (error) {
            throw new Error(`Excel export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Sheets given as a heading row and row arrays, built as rows (SheetJS dense) and written as
     * exportToExcelMultiSheet writes them (widths, a filter on the headings, compressed). Large
     * results: no object a row, no cell objects kept apart (Query's export).
     */
    async exportArraysToExcel(sheets: { sheetName: string; header: string[]; rows: unknown[][] }[], options: { targetUri?: string }): Promise<string> {
        const workbook = XLSX.utils.book_new();
        for (const sheet of sheets) {
            // (every value as the text columns of exportToExcelMultiSheet have it: formatValueForExcel's, a number as text)
            const rows = sheet.rows.map(row => row.map(value => this.formatValueForExcel(value, 'string')));
            const worksheet = XLSX.utils.aoa_to_sheet([sheet.header, ...rows], { dense: true } as XLSX.AOA2SheetOpts);
            worksheet['!cols'] = sheet.header.map(name => ({ wch: Math.max(name.length, 15) }));
            if (sheet.rows.length && worksheet['!ref']) worksheet['!autofilter'] = { ref: worksheet['!ref'] };
            XLSX.utils.book_append_sheet(workbook, worksheet, sheet.sheetName);
        }
        const excelBuffer = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
        if (!options.targetUri) throw new Error('No save path provided for export');
        await fs.promises.writeFile(options.targetUri, excelBuffer);
        return options.targetUri;
    }

    /**
     * Export multiple sheets to Excel format (.xlsx)
     * Creates a workbook with multiple worksheets
     */
    async exportToExcelMultiSheet(sheets: SheetDefinition[], options: ExportOptions): Promise<string> {
        try {
            if (sheets.length === 0) {
                throw new Error('No sheets provided for export');
            }

            // Create workbook
            const workbook = XLSX.utils.book_new();

            // Add each sheet to the workbook
            for (const sheet of sheets) {
                const { sheetName, data, columns } = sheet;

                // Skip empty sheets
                if (data.length === 0) {
                    continue;
                }

                // Prepare data for this sheet
                const worksheetData = this.prepareExcelData(data, columns, options);

                // Create worksheet
                const worksheet = XLSX.utils.json_to_sheet(worksheetData, {
                    header: columns.map(col => col.id),
                    skipHeader: !options.includeHeaders
                });

                // Add column headers if requested
                if (options.includeHeaders) {
                    const headerRow = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']).s.r : 0;
                    columns.forEach((col, index) => {
                        const cellAddress = XLSX.utils.encode_cell({ r: headerRow, c: index });
                        if (worksheet[cellAddress]) {
                            worksheet[cellAddress].v = col.name;
                            worksheet[cellAddress].s = {
                                font: { bold: true, color: { rgb: 'FFFFFF' } },
                                fill: { fgColor: { rgb: '4472C4' } },
                                alignment: { horizontal: 'center', vertical: 'center' },
                                border: {
                                    top: { style: 'thin', color: { rgb: '000000' } },
                                    bottom: { style: 'thin', color: { rgb: '000000' } },
                                    left: { style: 'thin', color: { rgb: '000000' } },
                                    right: { style: 'thin', color: { rgb: '000000' } }
                                }
                            };
                        }
                    });
                }

                // GitHub Issue #200: Skip per-cell formatting for large datasets
                const sheetCellCount = data.length * columns.length;
                if (worksheet['!ref'] && sheetCellCount <= 1_000_000) {
                    const range = XLSX.utils.decode_range(worksheet['!ref']);
                    const startRow = options.includeHeaders ? 1 : 0;

                    for (let row = startRow; row <= range.e.r; row++) {
                        columns.forEach((col, colIndex) => {
                            const cellAddress = XLSX.utils.encode_cell({ r: row, c: colIndex });
                            if (worksheet[cellAddress]) {
                                const cellFormat = this.getCellFormat(col.type);
                                if (cellFormat) {
                                    worksheet[cellAddress].s = {
                                        ...worksheet[cellAddress].s,
                                        ...cellFormat
                                    };
                                }
                            }
                        });
                    }
                }

                // Set column widths
                const columnWidths = columns.map(col => ({ wch: Math.max(col.name.length, 15) }));
                worksheet['!cols'] = columnWidths;

                // Add autofilter
                if (worksheetData.length > 0 && options.includeHeaders && worksheet['!ref']) {
                    worksheet['!autofilter'] = { ref: worksheet['!ref'] };
                }

                // Add worksheet to workbook
                XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
            }

            // Check that we added at least one sheet
            if (workbook.SheetNames.length === 0) {
                throw new Error('No non-empty sheets to export');
            }

            // Generate Excel buffer
            let excelBuffer: Uint8Array;
            try {
                excelBuffer = new Uint8Array(XLSX.write(workbook, {
                    type: 'array',
                    bookType: 'xlsx',
                    compression: true
                }) as ArrayBuffer);
            } catch (xlsxError) {
                throw new Error(`XLSX.write failed (multi-sheet, ${sheets.length} sheets): ${xlsxError instanceof Error ? xlsxError.message : String(xlsxError)}`);
            }

            // The path the user chose to save to
            const filePath = options.targetUri;
            if (!filePath) {
                throw new Error('No save path provided for export');
            }

            // Write Excel file
            await fs.promises.writeFile(filePath, excelBuffer);

            return filePath;

        } catch (error) {
            throw new Error(`Multi-sheet Excel export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to JSON format
     */
    async exportToJson(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            let jsonData: any;
            
            if (options.preserveNesting) {
                // Try to preserve original nested structure
                jsonData = data.map(row => this.unflattenRow(row, columns));
            } else {
                // Export flattened structure
                jsonData = data.map(row => {
                    const cleanRow: any = {};
                    columns.forEach(col => {
                        if (row[col.id] !== undefined) {
                            cleanRow[col.id] = this.formatValueForJson(row[col.id], col.type);
                        }
                    });
                    return cleanRow;
                });
            }
            
            // Format JSON based on options (formatted with indentation or minified)
            const jsonContent = options.jsonFormat === 'minified' 
                ? JSON.stringify(jsonData)
                : JSON.stringify(jsonData, null, 2);
            
            const filePath = options.targetUri;
            if (!filePath) {
                throw new Error('No save path provided for export');
            }
            
            await fs.promises.writeFile(filePath, jsonContent, 'utf8');
            
            return filePath;
            
        } catch (error) {
            throw new Error(`JSON export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Export table data to SQL INSERT statements
     */
    async exportToSql(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        try {
            const tableName = this.sanitizeTableName(options.fileName || 'report_data');
            const lines: string[] = [];

            // Generate CREATE TABLE statement
            lines.push(`-- Generated SQL INSERT statements`);
            lines.push(`-- Table: ${tableName}`);
            lines.push(`-- Generated: ${new Date().toISOString()}`);
            lines.push('');

            if (options.includeHeaders) {
                lines.push(this.generateCreateTableStatement(tableName, columns));
                lines.push('');
            }

            // Generate INSERT statements
            if (data.length > 0) {
                const columnNames = columns.map(col => this.sanitizeColumnName(col.id));
                lines.push(`-- Data INSERT statements`);

                for (const row of data) {
                    const values = columns.map(col => {
                        const value = row[col.id];
                        return this.formatValueForSql(value, col.type);
                    });

                    lines.push(`INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${values.join(', ')});`);
                }
            }
            
            const filePath = options.targetUri;
            if (!filePath) {
                throw new Error('No save path provided for export');
            }
            
            const sqlContent = lines.join('\n') + '\n';
            await fs.promises.writeFile(filePath, sqlContent, 'utf8');
            
            return filePath;
            
        } catch (error) {
            throw new Error(`SQL export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Prepare data for Excel export with proper data types
     */
    private prepareExcelData(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): any[] {
        return data.map(row => {
            const excelRow: any = {};
            columns.forEach(col => {
                const value = row[col.id];
                excelRow[col.id] = this.formatValueForExcel(value, col.type);
            });
            return excelRow;
        });
    }

    /**
     * Get Excel cell formatting based on data type
     */
    private getCellFormat(columnType: string): any {
        switch (columnType) {
            case 'number':
                return {
                    numFmt: '#,##0.00',
                    alignment: { horizontal: 'right' }
                };
            case 'date':
                return {
                    numFmt: 'mm/dd/yyyy',
                    alignment: { horizontal: 'center' }
                };
            case 'boolean':
                return {
                    alignment: { horizontal: 'center' }
                };
            case 'string':
            default:
                return {
                    alignment: { horizontal: 'left' }
                };
        }
    }

    /**
     * Escape value for CSV format
     */
    private escapeValue(value: string, delimiter: string, quoteChar: string): string {
        const strValue = String(value || '');

        // Quote if contains delimiter, quote char, or newline
        if (strValue.includes(delimiter) || strValue.includes(quoteChar) || strValue.includes('\n')) {
            return quoteChar + strValue.replace(new RegExp(quoteChar, 'g'), quoteChar + quoteChar) + quoteChar;
        }

        return strValue;
    }

    /**
     * Escape value for TSV format
     * GitHub Issue #174: TSV clipboard support
     * Replace tabs and newlines which would break TSV structure
     */
    private escapeValueForTsv(value: string): string {
        const strValue = String(value || '');
        // Replace tabs with spaces and newlines with spaces to preserve single-line structure
        return strValue.replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ');
    }

    /**
     * Escape value for HTML format
     * GitHub Issue #174: HTML clipboard support
     */
    private escapeHtml(value: string): string {
        const strValue = String(value || '');
        return strValue
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Get header background colour based on report tab
     * GitHub Issue #174: Tab-contextual header colours
     * Brand blue (#0078d4) for input, green for success, red for errors
     */
    private getHeaderColorForTab(tab?: string): string {
        switch (tab) {
            case 'success':
                return '#107C10';
            case 'errors':
                return '#D13438';
            default:
                return '#0078d4';
        }
    }

    /**
     * Escape value for Markdown format
     * GitHub Issue #174: Markdown clipboard support
     * Escape pipe characters which would break table structure
     */
    private escapeMarkdown(value: string): string {
        const strValue = String(value || '');
        // Escape pipes and replace newlines to preserve table structure
        return strValue.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    }

    /**
     * Issue #239 (reopen): serialise arrays/objects to a single string for
     * flat formats (CSV/TSV/Excel/Markdown/HTML/SQL). Arrays of primitives
     * comma-join (e.g. ["ABC","EFG"] → "ABC,EFG"); arrays containing objects
     * and plain objects fall back to JSON. Returns null for non-complex
     * values so callers can fall through to type-based formatting.
     */
    private serializeComplexValue(value: any): string | null {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) {
            const allPrimitive = value.every(v =>
                v === null || v === undefined || typeof v !== 'object'
            );
            if (allPrimitive) {
                return value.map(v => (v === null || v === undefined ? '' : String(v))).join(',');
            }
            return JSON.stringify(value);
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return null;
    }

    /**
     * Format value for CSV export
     */
    private formatValueForCsv(value: any, type: string): string {
        if (value === null || value === undefined) return '';

        const complex = this.serializeComplexValue(value);
        if (complex !== null) return complex;

        switch (type) {
            case 'date':
                return value instanceof Date ? value.toISOString() : String(value);
            case 'number':
                return typeof value === 'number' ? value.toString() : String(value);
            case 'boolean':
                return typeof value === 'boolean' ? value.toString() : String(value);
            case 'object':
            case 'array':
                return typeof value === 'object' ? JSON.stringify(value) : String(value);
            default:
                return String(value);
        }
    }

    /**
     * Format value for Excel export with proper data types
     */
    private formatValueForExcel(value: any, type: string): any {
        if (value === null || value === undefined) return null;

        // Issue #239: arrays of primitives → comma-joined string;
        // arrays of objects / plain objects → JSON. Excel cells can't hold
        // arrays natively, so we always serialise to a single string.
        const complex = this.serializeComplexValue(value);
        if (complex !== null) return complex;

        switch (type) {
            case 'number':
                if (typeof value === 'string') {
                    const parsed = parseFloat(value);
                    return isNaN(parsed) ? value : parsed;
                }
                return typeof value === 'number' ? value : value;
            case 'boolean':
                if (typeof value === 'string') {
                    return value.toLowerCase() === 'true';
                }
                return Boolean(value);
            case 'date':
                if (typeof value === 'string') {
                    const date = new Date(value);
                    return isNaN(date.getTime()) ? value : date;
                }
                return value instanceof Date ? value : value;
            case 'object':
            case 'array':
                // For Excel, serialize complex objects as JSON strings
                return typeof value === 'object' ? JSON.stringify(value) : value;
            default:
                return String(value);
        }
    }

    /**
     * Format value for JSON export
     */
    private formatValueForJson(value: any, type: string): any {
        if (value === null || value === undefined) return null;
        
        switch (type) {
            case 'number':
                return typeof value === 'string' ? parseFloat(value) || value : value;
            case 'boolean':
                return typeof value === 'string' ? value === 'true' : Boolean(value);
            case 'date':
                return value instanceof Date ? value.toISOString() : value;
            case 'object':
            case 'array':
                // Handle formatted array/object strings like "[3 items]" or JSON strings
                if (typeof value === 'string') {
                    // Check if it's a formatted array summary
                    if (/^\[\d+ items\]$/.test(value)) {
                        return value; // Keep as string - it's a summary, not parseable JSON
                    }
                    // Try to parse as JSON, but fallback to string if it fails
                    try {
                        return JSON.parse(value);
                    } catch {
                        return value; // Keep as string if not valid JSON
                    }
                }
                return value;
            default:
                return value;
        }
    }

    /**
     * Format value for SQL export
     */
    private formatValueForSql(value: any, type: string): string {
        if (value === null || value === undefined) return 'NULL';

        // Issue #239: arrays of primitives → comma-joined; objects / mixed
        // arrays → JSON. Quote and escape just like a string literal.
        const complex = this.serializeComplexValue(value);
        if (complex !== null) {
            return `'${complex.replace(/'/g, "''")}'`;
        }

        switch (type) {
            case 'string':
            case 'date':
                return `'${String(value).replace(/'/g, "''")}'`;
            case 'number':
                return typeof value === 'number' ? value.toString() : (parseFloat(String(value)) || 0).toString();
            case 'boolean':
                return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : 'FALSE';
            case 'object':
            case 'array':
                return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
            default:
                return `'${String(value).replace(/'/g, "''")}'`;
        }
    }

    /**
     * Generate CREATE TABLE statement
     */
    private generateCreateTableStatement(tableName: string, columns: ColumnDefinition[]): string {
        const columnDefs = columns.map(col => {
            const sqlType = this.getSqlType(col.type);
            const columnName = this.sanitizeColumnName(col.id);
            return `  ${columnName} ${sqlType}`;
        });
        
        return `CREATE TABLE ${tableName} (\n${columnDefs.join(',\n')}\n);`;
    }

    /**
     * Get SQL data type from column type
     */
    private getSqlType(type: string): string {
        switch (type) {
            case 'number':
                return 'DECIMAL(10,2)';
            case 'boolean':
                return 'BOOLEAN';
            case 'date':
                return 'DATETIME';
            case 'object':
            case 'array':
                return 'TEXT';
            default:
                return 'VARCHAR(255)';
        }
    }

    /**
     * Sanitize table name for SQL
     */
    private sanitizeTableName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    }

    /**
     * Sanitize column name for SQL
     */
    private sanitizeColumnName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    }

    /**
     * Attempt to unflatten a row to restore nesting
     */
    private unflattenRow(row: TableRow, columns: ColumnDefinition[]): any {
        const result: any = {};
        
        columns.forEach(col => {
            const value = row[col.id];
            if (value !== undefined && col.nested) {
                this.setNestedValue(result, col.id, value);
            } else if (value !== undefined) {
                result[col.id] = value;
            }
        });
        
        return result;
    }

    /**
     * Set nested value in object using dot notation
     */
    private setNestedValue(obj: any, path: string, value: any): void {
        const keys = path.split('.');
        let current = obj;
        
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        
        current[keys[keys.length - 1]] = value;
    }

    /**
     * GitHub Issue #225: Generate minimal type-aware HTML for dual-format clipboard.
     *
     * This is the HIDDEN companion HTML that rides alongside text/plain for CSV/TSV copies.
     * Carries a class-based mso-number-format:"\@" text-format hint for Excel (defence-in-depth
     * — Excel 365 clipboard paste is unreliable about honouring it, but it's free insurance).
     *
     * The real Excel-safe path is the text/plain apostrophe-prefix (options.excelSafeStrings)
     * applied by exportToCsvString/exportToTsvString — not this HTML. This HTML is no longer
     * the load-bearing part of the Excel-safety story.
     *
     * Returns empty string if no string columns exist.
     */
    async exportToTypeAwareHtmlString(data: TableRow[], columns: ColumnDefinition[], options: ExportOptions): Promise<string> {
        const hasStringColumns = columns.some(col => col.type === 'string');
        if (!hasStringColumns) {
            return '';
        }

        const parts: string[] = [];
        parts.push('<style>td{color:#000;background:#fff}td.x{mso-number-format:"\\@"}</style>');
        parts.push('<table>');

        // Header row
        if (options.includeHeaders) {
            parts.push('<tr>');
            for (const col of columns) {
                parts.push(`<th>${this.escapeHtml(col.name)}</th>`);
            }
            parts.push('</tr>');
        }

        // Data rows — bare <td>, class="x" only on string cells
        for (const row of data) {
            parts.push('<tr>');
            for (const col of columns) {
                const value = row[col.id];
                const formattedValue = this.formatValueForCsv(value, col.type);
                const cls = col.type === 'string' ? ' class="x"' : '';
                parts.push(`<td${cls}>${this.escapeHtml(formattedValue)}</td>`);
            }
            parts.push('</tr>');
        }

        parts.push('</table>');
        return parts.join('');
    }

    /**
     * Ensure directory exists
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            await fs.promises.access(dirPath);
        } catch {
            await fs.promises.mkdir(dirPath, { recursive: true });
        }
    }
}