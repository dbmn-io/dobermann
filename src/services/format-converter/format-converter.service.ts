// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Format Converter Service Implementation
 * Converts multiple file formats (Excel, TSV, custom delimited) to CSV format
 * 
 * Following Architecture.md patterns:
 * - Service implements interface for DI compatibility
 * - Separation of concerns with specific parsing methods
 * - Comprehensive error handling and logging
 * - Integration with existing CSV processing pipeline
 */

import * as XLSX from 'xlsx';
import {
    IFormatConverterService,
    SupportedFormat,
    FormatDetectionResult,
    ConversionOptions,
    ConversionResult,
    ExcelSheetInfo
} from './format-converter.interface';
import { ExcelTableDetector } from './excel-table-detector';
import {
    SourceFormat,
    TargetDataType,
    NumberSourceFormat,
    DateSourceFormat,
    BooleanSourceFormat,
    CoercionResult,
    ColumnCoercionResult,
    FullValidationRequest,
    FullValidationResult
} from './source-format.interface';
import { DetectedDataType, FileTypeDetectionResult, IDataTypeDetectionService, ColumnTypeDetection } from '../data-type-detection/data-type-detection.interface';
import { IDataTransformationService, FileTransformationConfig, ColumnTransformationConfig } from '../data-transformation/data-transformation.interface';

export class FormatConverterService implements IFormatConverterService {

    private tableDetector = new ExcelTableDetector();

    // GitHub Issue #223: Cache XLSX workbook to avoid redundant parsing
    // FormatConverterService is a singleton — same instance handles getExcelSheets() then convertExcelToCSV()
    private cachedWorkbook: XLSX.WorkBook | null = null;
    private cachedBufferFingerprint: string | null = null;

    constructor(
        private dataTypeDetectionService?: IDataTypeDetectionService,
        private dataTransformationService?: IDataTransformationService
    ) {
    }

    /**
     * GitHub Issue #223: Compute a fast fingerprint for a buffer
     * Uses length + hex of first 256 + last 256 bytes (avoids hashing entire 39MB)
     */
    private computeBufferFingerprint(buffer: Uint8Array): string {
        const len = buffer.length;
        const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        const head = hex(buffer.subarray(0, Math.min(256, len)));
        const tail = hex(buffer.subarray(len - Math.min(256, len)));
        return `${len}:${head}:${tail}`;
    }

    /**
     * GitHub Issue #223: Clear cached workbook to free memory
     */
    clearWorkbookCache(): void {
        this.cachedWorkbook = null;
        this.cachedBufferFingerprint = null;
    }

    /**
     * GitHub Issue #223: Get Excel sheet data as row arrays directly from cached workbook.
     * Uses XLSX.utils.sheet_to_json with header:1 to produce string[][] without CSV round-trip.
     * This skips the ~20s sheet_to_csv → parseDelimitedContent cycle for large files.
     */
    getExcelSheetAsArrays(sheetName: string, options?: ConversionOptions): Promise<{
        headers: string[];
        rows: string[][];
        totalRows: number;
    }> {
        if (!this.cachedWorkbook) {
            return Promise.reject(new Error('No cached workbook available. Call getExcelSheets() or convertToCSV() first.'));
        }

        const worksheet = this.cachedWorkbook.Sheets[sheetName];
        if (!worksheet) {
            return Promise.reject(new Error(`Sheet '${sheetName}' not found in cached workbook`));
        }

        // Apply effective data range if provided
        const originalRef = worksheet['!ref'];
        if (options?.effectiveDataRange) {
            worksheet['!ref'] = options.effectiveDataRange;
        }

        // sheet_to_json with header:1 returns array of arrays, raw:false gives formatted strings
        const rawData: string[][] = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            raw: false,
            defval: ''
        });

        // Restore original ref
        if (options?.effectiveDataRange && originalRef) {
            worksheet['!ref'] = originalRef;
        }

        if (rawData.length === 0) {
            return Promise.resolve({ headers: [], rows: [], totalRows: 0 });
        }

        // First row is headers, rest are data rows
        const headers = rawData[0].map(h => String(h || '').trim());
        const rows: string[][] = [];

        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            // Ensure each cell is a trimmed string, pad to header length
            const normalized = new Array(headers.length).fill('');
            for (let c = 0; c < headers.length && c < row.length; c++) {
                normalized[c] = String(row[c] ?? '').trim();
            }
            // Skip fully empty rows if requested
            if (options?.skipEmptyRows && normalized.every(v => v === '')) {
                continue;
            }
            rows.push(normalized);
        }

        // Do NOT clear cache here — let the caller decide when to clear
        return Promise.resolve({ headers, rows, totalRows: rows.length });
    }

    /**
     * Detect file format from filename and content analysis
     */
    async detectFormat(fileName: string, fileData: Uint8Array | string): Promise<FormatDetectionResult> {
        const extension = this.getFileExtension(fileName).toLowerCase();
        
        // Primary detection based on file extension
        let format: SupportedFormat;
        let confidence = 0.8; // Start with high confidence for extension-based detection
        const metadata: any = {};

        switch (extension) {
            case '.xlsx':
            case '.xls':
                format = SupportedFormat.EXCEL;
                confidence = 0.95;
                // Get Excel sheet information
                if (fileData instanceof Uint8Array) {
                    try {
                        const sheets = await this.getExcelSheets(fileData);
                        metadata.sheets = sheets.map(s => s.name);
                        // GitHub Issue #207: Include full sheet details for frontend validation
                        metadata.sheetDetails = sheets;
                        confidence = 1.0; // Perfect confidence if we can read Excel structure
                    } catch (error) {
                        // Still assume Excel but lower confidence
                        confidence = 0.7;
                    }
                }
                break;

            case '.tsv':
                format = SupportedFormat.TSV;
                metadata.delimiter = '\t';
                confidence = 0.95;
                break;

            case '.csv':
                format = SupportedFormat.CSV;
                metadata.delimiter = ',';
                confidence = 0.95;
                break;

            case '.txt':
                // Analyze content to determine delimiter
                format = SupportedFormat.CUSTOM_DELIMITED;
                if (typeof fileData === 'string' || fileData instanceof Uint8Array) {
                    const content = fileData instanceof Uint8Array ? new TextDecoder().decode(fileData) : fileData;
                    const detectedDelimiter = this.detectDelimiter(content);
                    metadata.delimiter = detectedDelimiter;
                    confidence = detectedDelimiter ? 0.8 : 0.4;
                }
                break;

            default:
                // Unknown extension, try to detect from content
                if (typeof fileData === 'string' || fileData instanceof Uint8Array) {
                    const content = fileData instanceof Uint8Array ? new TextDecoder().decode(fileData) : fileData;
                    
                    // Check if it looks like Excel binary format
                    if (fileData instanceof Uint8Array && this.isExcelBinaryFormat(fileData)) {
                        format = SupportedFormat.EXCEL;
                        confidence = 0.7;
                    } else {
                        // Assume delimited text
                        format = SupportedFormat.CUSTOM_DELIMITED;
                        const detectedDelimiter = this.detectDelimiter(content);
                        metadata.delimiter = detectedDelimiter;
                        confidence = detectedDelimiter ? 0.6 : 0.3;
                    }
                } else {
                    throw new Error(`Unsupported file format: ${extension}`);
                }
        }

        // Add file size to metadata
        if (fileData instanceof Uint8Array) {
            metadata.fileSize = fileData.length;
        } else {
            metadata.fileSize = new TextEncoder().encode(fileData).length;
        }

        // Set default encoding
        metadata.encoding = 'utf8';

        return {
            format,
            confidence,
            metadata
        };
    }

    /**
     * Get information about Excel sheets
     * GitHub Issue #207: Enhanced with table detection and filter awareness
     */
    async getExcelSheets(fileData: Uint8Array): Promise<ExcelSheetInfo[]> {
        try {
            // GitHub Issue #223: Check cache before parsing
            const fingerprint = this.computeBufferFingerprint(fileData);
            let workbook: XLSX.WorkBook;

            if (this.cachedWorkbook && this.cachedBufferFingerprint === fingerprint) {
                workbook = this.cachedWorkbook;
                // cached
            } else {
                // GitHub Issue #207: cellStyles: true is required for !rows hidden row detection
                workbook = XLSX.read(fileData, { type: 'array', cellStyles: true });

                // Cache for reuse by convertExcelToCSV()
                this.cachedWorkbook = workbook;
                this.cachedBufferFingerprint = fingerprint;
            }

            // GitHub Issue #207: Detect named tables via ZIP parsing
            const tablesMap = await this.tableDetector.detectTables(fileData);

            const sheets: ExcelSheetInfo[] = [];
            let totalRows = 0;
            let totalCols = 0;

            workbook.SheetNames.forEach((sheetName, index) => {
                const worksheet = workbook.Sheets[sheetName];
                const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');

                // Calculate row and column counts
                const rowCount = range.e.r + 1;
                const columnCount = range.e.c + 1;
                totalRows += rowCount;
                totalCols = Math.max(totalCols, columnCount);

                // Simple heuristic to detect headers
                const hasHeaders = this.detectExcelHeaders(worksheet);

                // GitHub Issue #207: Validate sheet (tables + A1 + filters)
                const sheetTables = tablesMap.get(index) || [];
                const validation = this.tableDetector.validateSheet(sheetTables, worksheet);

                sheets.push({
                    name: sheetName,
                    index,
                    rowCount,
                    columnCount,
                    hasHeaders,
                    tableCount: validation.tableCount,
                    tables: validation.tables.map(t => ({ name: t.displayName, range: t.range })),
                    validationStatus: validation.validationStatus,
                    validationMessage: validation.validationMessage,
                    effectiveDataRange: validation.effectiveDataRange,
                    filter: {
                        hasAutoFilter: validation.filter.hasAutoFilter,
                        hasHiddenRows: validation.filter.hasHiddenRows,
                        hiddenRowCount: validation.filter.hiddenRowCount
                    }
                });
            });
            return sheets;
        } catch (error) {
            throw new Error(`Failed to read Excel file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Convert file data to CSV format
     */
    async convertToCSV(
        fileData: Uint8Array | string,
        format: SupportedFormat,
        options: ConversionOptions = {}
    ): Promise<ConversionResult> {
        
        let csvData: string;
        let headers: string[] = [];
        let rows: string[][] = [];
        const metadata: any = {
            originalFormat: format,
            delimiter: ',',
            rowsProcessed: 0,
            columnsDetected: 0,
            warnings: []
        };

        try {
            switch (format) {
                case SupportedFormat.EXCEL:
                    const excelResult = await this.convertExcelToCSV(fileData as Uint8Array, options);
                    csvData = excelResult.csvData;
                    headers = excelResult.headers;
                    rows = excelResult.rows;
                    metadata.selectedSheet = excelResult.selectedSheet;
                    metadata.rowsProcessed = excelResult.rowsProcessed;
                    metadata.columnsDetected = excelResult.columnsDetected;
                    if (excelResult.warnings) {
                        metadata.warnings.push(...excelResult.warnings);
                    }
                    break;

                case SupportedFormat.TSV:
                    const tsvResult = this.convertDelimitedToCSV(fileData as string, '\t', options);
                    csvData = tsvResult.csvData;
                    headers = tsvResult.headers;
                    rows = tsvResult.rows;
                    metadata.delimiter = '\t';
                    metadata.rowsProcessed = tsvResult.rowsProcessed;
                    metadata.columnsDetected = tsvResult.columnsDetected;
                    break;

                case SupportedFormat.CUSTOM_DELIMITED:
                    const delimiter = options.delimiter || this.detectDelimiter(fileData as string) || ',';
                    const customResult = this.convertDelimitedToCSV(fileData as string, delimiter, options);
                    csvData = customResult.csvData;
                    headers = customResult.headers;
                    rows = customResult.rows;
                    metadata.delimiter = delimiter;
                    metadata.rowsProcessed = customResult.rowsProcessed;
                    metadata.columnsDetected = customResult.columnsDetected;
                    break;

                case SupportedFormat.CSV:
                    // CSV is already in the right format, but we might need to normalize it
                    const csvResult = this.convertDelimitedToCSV(fileData as string, ',', options);
                    csvData = csvResult.csvData;
                    headers = csvResult.headers;
                    rows = csvResult.rows;
                    metadata.rowsProcessed = csvResult.rowsProcessed;
                    metadata.columnsDetected = csvResult.columnsDetected;
                    break;

                default:
                    throw new Error(`Unsupported format: ${format}`);
            }

            return {
                csvData,
                preview: {
                    headers,
                    rows, // Send all rows — grid uses virtual scrolling
                    totalRows: metadata.rowsProcessed
                },
                metadata
            };

        } catch (error) {
            throw new Error(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Check if format is supported
     */
    isFormatSupported(format: SupportedFormat): boolean {
        return Object.values(SupportedFormat).includes(format);
    }

    /**
     * Get supported file extensions
     */
    getSupportedExtensions(): string[] {
        return ['.csv', '.xlsx', '.xls', '.tsv', '.txt'];
    }

    // Private helper methods

    private getFileExtension(fileName: string): string {
        const lastDotIndex = fileName.lastIndexOf('.');
        return lastDotIndex >= 0 ? fileName.substring(lastDotIndex) : '';
    }

    private isExcelBinaryFormat(fileData: Uint8Array): boolean {
        // Check for Excel magic numbers
        if (fileData.length < 8) return false;
        
        // XLSX/XLSM files are ZIP archives
        const zipSignature = fileData.subarray(0, 4);
        if (zipSignature[0] === 0x50 && zipSignature[1] === 0x4B) {
            return true;
        }
        
        // XLS files have specific OLE signatures
        const oleSignature = fileData.subarray(0, 8);
        return oleSignature[0] === 0xD0 && oleSignature[1] === 0xCF && 
               oleSignature[2] === 0x11 && oleSignature[3] === 0xE0;
    }

    private detectDelimiter(content: string): string | null {
        const lines = content.split('\n').slice(0, 10); // Check first 10 lines
        const delimiters = [',', '\t', ';', '|', ':'];
        
        let bestDelimiter = null;
        let bestScore = 0;

        for (const delimiter of delimiters) {
            let score = 0;
            let consistentColumnCount = true;
            let expectedColumns = 0;

            for (const line of lines) {
                if (line.trim()) {
                    const columns = line.split(delimiter);
                    if (expectedColumns === 0) {
                        expectedColumns = columns.length;
                    } else if (columns.length !== expectedColumns) {
                        consistentColumnCount = false;
                        break;
                    }
                    score += columns.length;
                }
            }

            if (consistentColumnCount && expectedColumns > 1 && score > bestScore) {
                bestDelimiter = delimiter;
                bestScore = score;
            }
        }

        return bestDelimiter;
    }

    private detectExcelHeaders(worksheet: XLSX.WorkSheet): boolean {
        try {
            const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
            if (range.e.r < 1) return false; // Need at least 2 rows to detect headers

            // Check first row vs second row - if first row is all strings and second has mixed types, likely headers
            let firstRowAllStrings = true;
            let secondRowHasNumbers = false;

            for (let col = range.s.c; col <= Math.min(range.e.c, range.s.c + 10); col++) { // Check up to 10 columns
                const firstCellAddr = XLSX.utils.encode_cell({ r: 0, c: col });
                const secondCellAddr = XLSX.utils.encode_cell({ r: 1, c: col });

                const firstCell = worksheet[firstCellAddr];
                const secondCell = worksheet[secondCellAddr];

                if (firstCell && firstCell.t !== 's') { // 's' = string type
                    firstRowAllStrings = false;
                }

                if (secondCell && (secondCell.t === 'n' || secondCell.t === 'd')) { // 'n' = number, 'd' = date
                    secondRowHasNumbers = true;
                }
            }

            return firstRowAllStrings && secondRowHasNumbers;
        } catch {
            return true; // Default to assuming headers
        }
    }

    private async convertExcelToCSV(fileData: Uint8Array, options: ConversionOptions): Promise<{
        csvData: string;
        headers: string[];
        rows: string[][];
        selectedSheet?: string;
        rowsProcessed: number;
        columnsDetected: number;
        warnings?: string[];
    }> {
        // GitHub Issue #223: Reuse cached workbook from getExcelSheets() if available
        const fingerprint = this.computeBufferFingerprint(fileData);
        let workbook: XLSX.WorkBook;

        if (this.cachedWorkbook && this.cachedBufferFingerprint === fingerprint) {
            workbook = this.cachedWorkbook;
        } else {
            workbook = XLSX.read(fileData, { type: 'array', cellStyles: true });
        }

        // GitHub Issue #223: Do NOT clear cache here — getExcelSheetAsArrays() may need it
        // in the Step 2→3 transition. The cache is cleared by handleGetExcelSheetAsArrays
        // or when a new file is loaded (getExcelSheets overwrites it).

        let sheetName: string;
        if (options.sheetName && workbook.SheetNames.includes(options.sheetName)) {
            sheetName = options.sheetName;
        } else {
            const sheetIndex = options.sheetIndex || 0;
            if (sheetIndex >= workbook.SheetNames.length) {
                throw new Error(`Sheet index ${sheetIndex} not found. Available sheets: ${workbook.SheetNames.join(', ')}`);
            }
            sheetName = workbook.SheetNames[sheetIndex];
        }

        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) {
            throw new Error(`Sheet '${sheetName}' not found`);
        }

        // GitHub Issue #207: Apply effective data range from table detection
        const originalRef = worksheet['!ref'];
        if (options.effectiveDataRange) {
            worksheet['!ref'] = options.effectiveDataRange;
        }

        // GitHub Issue #207: Use skipHidden option (defaults to true for backward compat)
        const skipHidden = options.skipHidden !== undefined ? options.skipHidden : true;

        // Convert to CSV using XLSX library
        let csvData = XLSX.utils.sheet_to_csv(worksheet, {
            skipHidden,
            blankrows: !options.skipEmptyRows
        });
        // Restore original ref
        if (options.effectiveDataRange && originalRef) {
            worksheet['!ref'] = originalRef;
        }

        // GitHub Issue #256: sheet_to_csv with blankrows:false does NOT skip rows
        // whose cells are typed empty strings (e.g. {t:'s', v:''}) — these come
        // from endpoint-generated templates with reserved blank rows, and they
        // serialise as lines like ",,,,,". Strip them here so the header line
        // (which is also all-comma-safe because it has real header content)
        // survives but phantom data rows do not.
        if (options.skipEmptyRows) {
            const lines = csvData.split('\n');
            const isBlank = (line: string): boolean => /^[\s,]*$/.test(line);
            const kept: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (i === 0 || !isBlank(lines[i])) {
                    kept.push(lines[i]);
                }
            }
            csvData = kept.join('\n');
        }

        // GitHub Issue #223: Only parse first rows for preview — frontend re-parses rawCSVContent independently
        // Count total rows via fast newline count instead of splitting entire string
        const PREVIEW_ROWS = 20;
        let totalRowCount = 0;
        for (let i = 0; i < csvData.length; i++) {
            if (csvData.charCodeAt(i) === 10) totalRowCount++;
        }

        // Parse only the first few lines for preview
        const previewLines: string[] = [];
        let searchFrom = 0;
        const linesToParse = PREVIEW_ROWS + 1; // +1 for header
        for (let i = 0; i < linesToParse && searchFrom < csvData.length; i++) {
            const nextNewline = csvData.indexOf('\n', searchFrom);
            if (nextNewline === -1) {
                previewLines.push(csvData.substring(searchFrom));
                break;
            }
            previewLines.push(csvData.substring(searchFrom, nextNewline));
            searchFrom = nextNewline + 1;
        }

        const headers = this.parseCSVLine(previewLines[0] || '');
        const rows: string[][] = [];

        const maxRows = options.maxRows || Number.MAX_SAFE_INTEGER;
        const maxProcessRows = Math.min(previewLines.length - 1, maxRows, PREVIEW_ROWS);

        for (let i = 1; i <= maxProcessRows; i++) {
            if (i >= previewLines.length) break;
            const line = previewLines[i].trim();
            if (line || !options.skipEmptyRows) {
                const row = this.parseCSVLine(line);
                if (row.length > 0) {
                    rows.push(row);
                }
            }
        }
        return {
            csvData,
            headers,
            rows,
            selectedSheet: sheetName,
            rowsProcessed: totalRowCount, // GitHub Issue #223: Report actual total, not just preview count
            columnsDetected: headers.length,
            warnings: workbook.SheetNames.length > 1 ? [`Excel file contains ${workbook.SheetNames.length} sheets. Only '${sheetName}' was converted.`] : undefined
        };
    }

    private convertDelimitedToCSV(fileData: string, delimiter: string, options: ConversionOptions): {
        csvData: string;
        headers: string[];
        rows: string[][];
        rowsProcessed: number;
        columnsDetected: number;
    } {
        const lines = fileData.split('\n');
        const headers = this.parseDelimitedLine(lines[0] || '', delimiter);
        const rows: string[][] = [];
        const csvLines: string[] = [this.escapeCSVLine(headers)];

        const maxRows = options.maxRows || Number.MAX_SAFE_INTEGER;
        const maxProcessRows = Math.min(lines.length - 1, maxRows);

        for (let i = 1; i < lines.length && rows.length < maxProcessRows; i++) {
            const line = lines[i].trim();
            if (line || !options.skipEmptyRows) {
                const row = this.parseDelimitedLine(line, delimiter);
                if (row.length > 0) {
                    rows.push(row);
                    csvLines.push(this.escapeCSVLine(row));
                }
            }
        }

        return {
            csvData: csvLines.join('\n'),
            headers,
            rows,
            rowsProcessed: rows.length,
            columnsDetected: headers.length
        };
    }

    private parseCSVLine(line: string): string[] {
        // Simple CSV parser - handles quoted fields
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = i < line.length - 1 ? line[i + 1] : null;
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i++; // Skip next quote
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    private parseDelimitedLine(line: string, delimiter: string): string[] {
        if (!line) return [];
        return line.split(delimiter).map(field => field.trim());
    }

    private escapeCSVLine(fields: string[]): string {
        return fields.map(field => {
            if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                return `"${field.replace(/"/g, '""')}"`;
            }
            return field;
        }).join(',');
    }

    /**
     * Detect column data types from CSV content
     */
    async detectColumnTypes(csvData: string, options: any = {}): Promise<FileTypeDetectionResult> {

        if (!this.dataTypeDetectionService) {
            
            // Parse CSV to get headers for fallback
            const lines = csvData.split('\n').filter(line => line.trim().length > 0);
            const headers = lines.length > 0 ? lines[0].split(',').map(h => h.trim().replace(/"/g, '')) : [];
            
            // Create fallback result - assume all columns are strings
            const columnTypes = new Map<string, ColumnTypeDetection>();
            
            headers.forEach(header => {
                columnTypes.set(header, {
                    type: DetectedDataType.STRING,
                    confidence: 0.5, // Low confidence for fallback
                    samples: [],
                    metadata: {}
                });
            });

            return {
                columnTypes,
                overallConfidence: 0.5,
                rowsAnalyzed: Math.min(lines.length - 1, 5),
                warnings: ['Type detection service unavailable - all columns defaulted to string type']
            };
        }

        try {
            const result = await this.dataTypeDetectionService.detectColumnTypes(csvData, options);
            return result;
        } catch (error) {
            throw new Error(`Column type detection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Apply data transformations to CSV based on detected/selected types
     */
    async applyDataTransformations(csvData: string, typeOverrides: Map<string, DetectedDataType>): Promise<string> {
        if (!this.dataTransformationService) {
            throw new Error('Data transformation service not available');
        }

        if (!typeOverrides || typeOverrides.size === 0) {
            return csvData; // No transformations to apply
        }

        try {
            // First, detect current types to create transformation configuration
            let detectionResult: FileTypeDetectionResult;
            if (this.dataTypeDetectionService) {
                detectionResult = await this.dataTypeDetectionService.detectColumnTypes(csvData);
            } else {
                // Fallback: assume all source types are strings
                const lines = csvData.split('\n');
                const headers = this.parseCSVLine(lines[0] || '');
                const columnTypes = new Map<string, any>();
                
                headers.forEach(header => {
                    columnTypes.set(header, {
                        type: DetectedDataType.STRING,
                        confidence: 1.0,
                        samples: []
                    });
                });

                detectionResult = {
                    columnTypes,
                    overallConfidence: 1.0,
                    rowsAnalyzed: Math.min(lines.length - 1, 10)
                };
            }

            // Create transformation configuration
            const transformationConfig: FileTransformationConfig = {
                columns: [],
                globalOptions: {
                    preserveOriginalValues: false,
                    failOnErrors: false
                }
            };

            // Build column transformation configs
            for (const [columnName, targetType] of typeOverrides.entries()) {
                const detectedType = detectionResult.columnTypes.get(columnName);
                if (detectedType) {
                    transformationConfig.columns.push({
                        columnName,
                        sourceType: detectedType.type,
                        targetType,
                        options: {
                            sourceTimezone: detectedType.metadata?.timezone,
                            targetTimezone: targetType === DetectedDataType.DATETIME ? 'GMT' : undefined
                        }
                    });
                }
            }

            // Apply transformations
            return await this.dataTransformationService.transformFile(csvData, transformationConfig);

        } catch (error) {
            throw new Error(`Data transformation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // ========================================================================
    // Coercion Validation Methods (GitHub Issue #135)
    // ========================================================================

    /**
     * Validate sample values can be coerced to target type
     * Used for instant feedback when user selects a column mapping
     */
    validateSampleCoercion(
        columnName: string,
        targetType: TargetDataType,
        sourceFormat: SourceFormat,
        sampleValues: string[]
    ): ColumnCoercionResult {
        const coercedSamples: CoercionResult[] = [];
        const failedRowIndices: number[] = [];
        let hasErrors = false;
        let hasWarnings = false;

        sampleValues.forEach((value, index) => {
            const result = this.coerceValue(value, targetType, sourceFormat);
            coercedSamples.push(result);

            if (!result.success) {
                hasErrors = true;
                failedRowIndices.push(index);
            } else if (result.warning) {
                hasWarnings = true;
            }
        });

        let overallStatus: 'success' | 'warning' | 'error' = 'success';
        if (hasErrors) {
            overallStatus = 'error';
        } else if (hasWarnings) {
            overallStatus = 'warning';
        }

        return {
            columnName,
            success: !hasErrors,
            coercedSamples,
            overallStatus,
            failedCount: failedRowIndices.length,
            failedRowIndices
        };
    }

    /**
     * Validate all rows in dataset can be coerced
     * Used when user clicks "Next" to proceed to next step
     * Processes in batches to avoid blocking UI
     */
    validateFullCoercion(request: FullValidationRequest): FullValidationResult {
        const columnResults: ColumnCoercionResult[] = [];
        const allFailedRowIndices = new Set<number>();
        let hasErrors = false;
        let hasWarnings = false;

        // Build column index map for quick lookup
        const headerIndexMap = new Map<string, number>();
        request.headers.forEach((header, index) => {
            headerIndexMap.set(header, index);
        });

        // Validate each mapping
        for (const mapping of request.mappings) {
            const columnIndex = headerIndexMap.get(mapping.csvColumn);
            if (columnIndex === undefined) {
                // Column not found - add error result
                columnResults.push({
                    columnName: mapping.variableName,
                    success: false,
                    coercedSamples: [],
                    overallStatus: 'error',
                    failedCount: request.rows.length,
                    failedRowIndices: request.rows.map((_, i) => i)
                });
                hasErrors = true;
                continue;
            }

            // Extract column values and validate
            const coercedSamples: CoercionResult[] = [];
            const failedRowIndices: number[] = [];
            let columnHasErrors = false;
            let columnHasWarnings = false;

            for (let rowIndex = 0; rowIndex < request.rows.length; rowIndex++) {
                const row = request.rows[rowIndex];
                const value = row[columnIndex] || '';
                const result = this.coerceValue(value, mapping.targetType, mapping.sourceFormat);

                // Only store first 10 samples for UI display
                if (coercedSamples.length < 10) {
                    coercedSamples.push(result);
                }

                if (!result.success) {
                    columnHasErrors = true;
                    failedRowIndices.push(rowIndex);
                    allFailedRowIndices.add(rowIndex);
                } else if (result.warning) {
                    columnHasWarnings = true;
                }
            }

            let columnStatus: 'success' | 'warning' | 'error' = 'success';
            if (columnHasErrors) {
                columnStatus = 'error';
                hasErrors = true;
            } else if (columnHasWarnings) {
                columnStatus = 'warning';
                hasWarnings = true;
            }

            columnResults.push({
                columnName: mapping.variableName,
                success: !columnHasErrors,
                coercedSamples,
                overallStatus: columnStatus,
                failedCount: failedRowIndices.length,
                failedRowIndices
            });
        }

        let overallStatus: 'success' | 'warning' | 'error' = 'success';
        if (hasErrors) {
            overallStatus = 'error';
        } else if (hasWarnings) {
            overallStatus = 'warning';
        }

        return {
            success: !hasErrors,
            overallStatus,
            totalRows: request.rows.length,
            rowsWithErrors: allFailedRowIndices.size,
            columnResults,
            skipRowIndices: Array.from(allFailedRowIndices).sort((a, b) => a - b)
        };
    }

    /**
     * Coerce a single value to the target type
     */
    private coerceValue(value: string, targetType: TargetDataType, sourceFormat: SourceFormat): CoercionResult {
        // Handle empty values
        if (value === '' || value === null || value === undefined) {
            return {
                success: true,
                original: value || '',
                coerced: null,
                warning: 'Empty value will be null'
            };
        }

        const trimmedValue = value.trim();

        switch (targetType) {
            case 'number':
            case 'integer':
            case 'int':
                return this.coerceToNumber(trimmedValue, sourceFormat as NumberSourceFormat, targetType === 'integer' || targetType === 'int');

            case 'boolean':
            case 'bool':
                return this.coerceToBoolean(trimmedValue);

            case 'date':
                return this.coerceToDate(trimmedValue, sourceFormat as DateSourceFormat);

            case 'string':
            default:
                return {
                    success: true,
                    original: value,
                    coerced: trimmedValue
                };
        }
    }

    /**
     * Coerce value to number
     */
    private coerceToNumber(value: string, sourceFormat: NumberSourceFormat, isInteger: boolean): CoercionResult {
        let numValue: number;
        let warning: string | undefined;

        try {
            switch (sourceFormat) {
                case NumberSourceFormat.COBOL:
                    numValue = this.parseCOBOLNumber(value);
                    break;

                case NumberSourceFormat.SCIENTIFIC:
                    numValue = parseFloat(value);
                    if (!value.toLowerCase().includes('e')) {
                        warning = 'Value parsed as standard number (no scientific notation found)';
                    }
                    break;

                case NumberSourceFormat.CURRENCY:
                    // Remove currency symbols and thousands separators
                    const cleanedCurrency = value.replace(/[$€£¥₹,\s]/g, '');
                    numValue = parseFloat(cleanedCurrency);
                    break;

                case NumberSourceFormat.STANDARD:
                default:
                    numValue = parseFloat(value);
                    break;
            }

            if (isNaN(numValue)) {
                return {
                    success: false,
                    original: value,
                    error: `Cannot convert "${value}" to number`
                };
            }

            // Check for integer truncation
            if (isInteger && !Number.isInteger(numValue)) {
                const truncated = Math.trunc(numValue);
                return {
                    success: true,
                    original: value,
                    coerced: truncated,
                    warning: `Decimal truncated: ${numValue} → ${truncated}`
                };
            }

            return {
                success: true,
                original: value,
                coerced: numValue,
                warning
            };

        } catch (error) {
            return {
                success: false,
                original: value,
                error: `Failed to parse number: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Parse COBOL packed decimal format
     * Format: +000000001.0000 or -000000020.0000
     */
    private parseCOBOLNumber(value: string): number {
        // Remove leading sign and zeros
        const cleaned = value.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
        const sign = value.startsWith('-') ? -1 : 1;
        return sign * parseFloat(cleaned);
    }

    /**
     * Coerce value to boolean
     */
    private coerceToBoolean(value: string): CoercionResult {
        const lowerValue = value.toLowerCase().trim();

        // True values
        const trueValues = ['true', 'yes', 'y', '1', 'on', 'active', 'enabled'];
        if (trueValues.includes(lowerValue)) {
            return {
                success: true,
                original: value,
                coerced: true
            };
        }

        // False values
        const falseValues = ['false', 'no', 'n', '0', 'off', 'inactive', 'disabled', ''];
        if (falseValues.includes(lowerValue)) {
            return {
                success: true,
                original: value,
                coerced: false
            };
        }

        return {
            success: false,
            original: value,
            error: `Cannot convert "${value}" to boolean. Expected: true/false, yes/no, 1/0, y/n`
        };
    }

    /**
     * Coerce value to date (ISO format YYYY-MM-DD)
     */
    private coerceToDate(value: string, sourceFormat: DateSourceFormat): CoercionResult {
        let dateObj: Date | null = null;
        let warning: string | undefined;

        try {
            switch (sourceFormat) {
                case DateSourceFormat.YYYY_MM_DD:
                    // Parse YYYY-MM-DD or YYYY/MM/DD
                    dateObj = this.parseDateYYYYMMDD(value);
                    break;

                case DateSourceFormat.MM_DD_YYYY:
                    // Parse MM/DD/YYYY or MM-DD-YYYY
                    dateObj = this.parseDateMMDDYYYY(value);
                    break;

                case DateSourceFormat.DD_MM_YYYY:
                    // Parse DD/MM/YYYY or DD-MM-YYYY
                    dateObj = this.parseDateDDMMYYYY(value);
                    break;

                case DateSourceFormat.UNIX_TIMESTAMP:
                    const timestamp = parseInt(value, 10);
                    if (!isNaN(timestamp)) {
                        // Assume seconds if < 10 billion (before year 2286 in ms)
                        dateObj = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
                    }
                    break;

                case DateSourceFormat.ISO_8601:
                    dateObj = new Date(value);
                    break;

                case DateSourceFormat.EXCEL_SERIAL:
                    // GitHub Issue #162: Excel serial date (days since 1899-12-30)
                    // Excel's epoch is December 30, 1899, but it incorrectly treats 1900 as a leap year
                    // Serial numbers 1-60 are off by 1 day, serial 60 is Feb 29, 1900 (doesn't exist)
                    const serialNum = parseFloat(value);
                    if (!isNaN(serialNum) && serialNum >= 1) {
                        // Days to subtract from serial to get Unix epoch offset
                        // For serial <= 60 (before the phantom Feb 29), use 25567
                        // For serial > 60, use 25569 to account for the phantom day
                        const daysOffset = serialNum <= 60 ? 25567 : 25569;
                        dateObj = new Date((serialNum - daysOffset) * 86400000);
                    }
                    break;

                case DateSourceFormat.AUTO:
                default:
                    // Try multiple formats
                    dateObj = this.autoDetectDate(value);
                    // GitHub Issue #175: Don't warn for successful auto-detect
                    // If it parses correctly, it works. Any issues will be visible in JSON preview.
                    break;
            }

            if (!dateObj || isNaN(dateObj.getTime())) {
                return {
                    success: false,
                    original: value,
                    error: `Cannot parse "${value}" as date with format ${sourceFormat}`
                };
            }

            // Return ISO date string (YYYY-MM-DD)
            const isoDate = dateObj.toISOString().split('T')[0];
            return {
                success: true,
                original: value,
                coerced: isoDate,
                warning
            };

        } catch (error) {
            return {
                success: false,
                original: value,
                error: `Failed to parse date: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    private parseDateYYYYMMDD(value: string): Date | null {
        const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (!match) return null;
        return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    }

    private parseDateMMDDYYYY(value: string): Date | null {
        const match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
        if (!match) return null;
        return new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
    }

    private parseDateDDMMYYYY(value: string): Date | null {
        const match = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
        if (!match) return null;
        return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
    }

    private autoDetectDate(value: string): Date | null {
        // Try ISO format first
        let date = new Date(value);
        if (!isNaN(date.getTime())) return date;

        // Try YYYY-MM-DD
        date = this.parseDateYYYYMMDD(value) as Date;
        if (date && !isNaN(date.getTime())) return date;

        // Try MM/DD/YYYY (US format - common)
        date = this.parseDateMMDDYYYY(value) as Date;
        if (date && !isNaN(date.getTime())) return date;

        // Try DD/MM/YYYY (European format)
        date = this.parseDateDDMMYYYY(value) as Date;
        if (date && !isNaN(date.getTime())) return date;

        return null;
    }
}