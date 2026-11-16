// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Format Converter Service Interface
 * Converts multiple file formats (Excel, TSV, custom delimited) to CSV format
 * for integration with existing CSV processing pipeline.
 * 
 * Enhanced with data type detection and transformation capabilities.
 * 
 * Following Architecture.md patterns for service design and DI integration.
 */

import { DetectedDataType, FileTypeDetectionResult } from '../data-type-detection/data-type-detection.interface';

/**
 * Supported file formats for conversion
 */
export enum SupportedFormat {
    CSV = 'csv',
    EXCEL = 'excel',
    TSV = 'tsv',
    CUSTOM_DELIMITED = 'custom'
}

/**
 * Format detection result
 */
export interface FormatDetectionResult {
    /** Detected format type */
    format: SupportedFormat;
    /** Confidence level (0.0 to 1.0) */
    confidence: number;
    /** Additional format-specific metadata */
    metadata: {
        /** For Excel: available sheet names */
        sheets?: string[];
        /** For delimited files: detected delimiter */
        delimiter?: string;
        /** Detected encoding */
        encoding?: string;
        /** File size in bytes */
        fileSize?: number;
        /** Column type detection results */
        columnTypes?: Map<string, DetectedDataType>;
        /** Type detection confidence */
        typeDetectionConfidence?: number;
        /** GitHub Issue #207: Per-sheet table/filter/validation details */
        sheetDetails?: ExcelSheetInfo[];
    };
}

/**
 * Options for format conversion
 */
export interface ConversionOptions {
    /** For Excel files: sheet index to convert (defaults to 0) */
    sheetIndex?: number;
    /** For Excel files: sheet name to convert (overrides sheetIndex) */
    sheetName?: string;
    /** For custom delimited files: delimiter character */
    delimiter?: string;
    /** Text encoding (defaults to 'utf8') */
    encoding?: string;
    /** Maximum rows to include in conversion (for performance) */
    maxRows?: number;
    /** Skip empty rows during conversion */
    skipEmptyRows?: boolean;
    /** Whether to enable data type detection */
    enableTypeDetection?: boolean;
    /** Column type overrides (user-selected types) */
    columnTypeOverrides?: Map<string, DetectedDataType>;
    /** GitHub Issue #207: Whether to skip hidden rows (user's filter choice, default true) */
    skipHidden?: boolean;
    /** GitHub Issue #207: Effective data range from table detection (e.g. "A1:C10") */
    effectiveDataRange?: string;
}

/**
 * Result of format conversion
 */
export interface ConversionResult {
    /** Converted data as CSV string */
    csvData: string;
    /** Preview data for UI display */
    preview: {
        headers: string[];
        rows: string[][];
        totalRows: number;
    };
    /** Conversion metadata */
    metadata: {
        /** Original format that was converted */
        originalFormat: SupportedFormat;
        /** For Excel: which sheet was converted */
        selectedSheet?: string;
        /** Delimiter used in conversion */
        delimiter: string;
        /** Number of rows processed */
        rowsProcessed: number;
        /** Number of columns detected */
        columnsDetected: number;
        /** Any warnings during conversion */
        warnings?: string[];
        /** Type detection results */
        typeDetection?: FileTypeDetectionResult;
        /** Applied data transformations */
        appliedTransformations?: Map<string, DetectedDataType>;
    };
}

/**
 * Excel-specific sheet information
 */
export interface ExcelSheetInfo {
    /** Sheet name */
    name: string;
    /** Sheet index */
    index: number;
    /** Number of rows with data */
    rowCount: number;
    /** Number of columns with data */
    columnCount: number;
    /** Whether this sheet has headers in first row */
    hasHeaders: boolean;
    /** GitHub Issue #207: Number of named tables on this sheet */
    tableCount?: number;
    /** GitHub Issue #207: Named tables found on this sheet */
    tables?: Array<{ name: string; range: string }>;
    /** GitHub Issue #207: Validation status for this sheet */
    validationStatus?: 'valid' | 'error';
    /** GitHub Issue #207: Validation message (null if valid) */
    validationMessage?: string | null;
    /** GitHub Issue #207: Effective data range (from table or full sheet) */
    effectiveDataRange?: string | null;
    /** GitHub Issue #207: Filter/hidden row information */
    filter?: {
        hasAutoFilter: boolean;
        hasHiddenRows: boolean;
        hiddenRowCount: number;
    };
}

/**
 * Service interface for format conversion operations
 */
export interface IFormatConverterService {
    /**
     * Detect file format from filename and content
     * @param fileName - Original filename with extension
     * @param fileData - File content as Buffer or string
     * @returns Promise resolving to format detection result
     */
    detectFormat(fileName: string, fileData: Uint8Array | string): Promise<FormatDetectionResult>;

    /**
     * Get information about Excel sheets
     * @param fileData - Excel file content as Buffer
     * @returns Promise resolving to array of sheet information
     */
    getExcelSheets(fileData: Uint8Array): Promise<ExcelSheetInfo[]>;

    /**
     * Convert file data to CSV format
     * @param fileData - Source file content as Buffer or string
     * @param format - Source format to convert from
     * @param options - Conversion options
     * @returns Promise resolving to conversion result
     */
    convertToCSV(
        fileData: Uint8Array | string,
        format: SupportedFormat,
        options?: ConversionOptions
    ): Promise<ConversionResult>;

    /**
     * Validate that a format is supported for conversion
     * @param format - Format to validate
     * @returns True if format is supported
     */
    isFormatSupported(format: SupportedFormat): boolean;

    /**
     * Get list of supported file extensions
     * @returns Array of supported extensions (e.g., ['.csv', '.xlsx', '.xls', '.tsv'])
     */
    getSupportedExtensions(): string[];

    /**
     * Detect column data types from CSV content
     * @param csvData - CSV content as string
     * @param options - Type detection options
     * @returns Promise resolving to type detection results
     */
    detectColumnTypes(csvData: string, options?: any): Promise<FileTypeDetectionResult>;

    /**
     * Apply data transformations to CSV based on detected/selected types
     * @param csvData - Original CSV content
     * @param typeOverrides - User-selected column types
     * @returns Promise resolving to transformed CSV content
     */
    applyDataTransformations(csvData: string, typeOverrides: Map<string, DetectedDataType>): Promise<string>;

    /**
     * GitHub Issue #223: Get Excel sheet data as row arrays directly from cached workbook.
     * Skips the CSV round-trip (sheet_to_csv → parseDelimitedContent) for Excel sources.
     * @param sheetName - Sheet name to extract
     * @param options - Conversion options (skipHidden, effectiveDataRange, etc.)
     * @returns Promise resolving to headers and row arrays
     */
    getExcelSheetAsArrays?(sheetName: string, options?: ConversionOptions): Promise<{
        headers: string[];
        rows: string[][];
        totalRows: number;
    }>;

    /**
     * GitHub Issue #223: Clear cached XLSX workbook to free memory
     * Called after conversion is complete
     */
    clearWorkbookCache?(): void;
}