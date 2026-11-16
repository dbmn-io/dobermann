// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Source Format Types for Coercion Validation
 *
 * Defines source data formats that can be coerced to target types.
 * Used in the merged Map & Transform step (GitHub Issue #135).
 */

/**
 * Source formats for number coercion
 */
export enum NumberSourceFormat {
    /** Standard decimal format (e.g., "123.45", "-99.9") */
    STANDARD = 'standard',
    /** COBOL packed decimal format (e.g., "+000000001.0000", "-000000020.0000") */
    COBOL = 'cobol',
    /** Scientific notation (e.g., "1.23E+04", "5.67e-8") */
    SCIENTIFIC = 'scientific',
    /** Currency format with symbols (e.g., "$1,234.56", "€99.99") */
    CURRENCY = 'currency'
}

/**
 * Source formats for date coercion
 */
export enum DateSourceFormat {
    /** Auto-detect from common patterns */
    AUTO = 'auto',
    /** ISO format: YYYY-MM-DD */
    YYYY_MM_DD = 'yyyy-mm-dd',
    /** US format: MM/DD/YYYY */
    MM_DD_YYYY = 'mm-dd-yyyy',
    /** European format: DD/MM/YYYY */
    DD_MM_YYYY = 'dd-mm-yyyy',
    /** Unix timestamp (seconds since epoch) */
    UNIX_TIMESTAMP = 'unix_timestamp',
    /** ISO 8601 with time: YYYY-MM-DDTHH:MM:SS */
    ISO_8601 = 'iso_8601',
    /** GitHub Issue #162: Excel serial date (days since January 1, 1900) */
    EXCEL_SERIAL = 'excel_serial'
}

/**
 * Source formats for boolean coercion
 */
export enum BooleanSourceFormat {
    /** Standard: true/false, yes/no, 1/0, y/n */
    STANDARD = 'standard'
}

/**
 * Source formats for string (passthrough)
 */
export enum StringSourceFormat {
    /** No transformation needed */
    PASSTHROUGH = 'passthrough'
}

/**
 * Union type for all source formats
 */
export type SourceFormat =
    | NumberSourceFormat
    | DateSourceFormat
    | BooleanSourceFormat
    | StringSourceFormat;

/**
 * Target data types (from template variables)
 */
export type TargetDataType = 'string' | 'number' | 'boolean' | 'date' | 'integer' | 'int' | 'bool';

/**
 * Get available source formats for a target type
 * @param targetType - The target type from template variable
 * @returns Array of available source formats
 */
export function getSourceFormatsForType(targetType: TargetDataType): SourceFormat[] {
    switch (targetType) {
        case 'number':
        case 'integer':
        case 'int':
            return [
                NumberSourceFormat.STANDARD,
                NumberSourceFormat.COBOL,
                NumberSourceFormat.SCIENTIFIC,
                NumberSourceFormat.CURRENCY
            ];
        case 'date':
            return [
                DateSourceFormat.AUTO,
                DateSourceFormat.YYYY_MM_DD,
                DateSourceFormat.MM_DD_YYYY,
                DateSourceFormat.DD_MM_YYYY,
                DateSourceFormat.UNIX_TIMESTAMP,
                DateSourceFormat.ISO_8601,
                // GitHub Issue #162: Excel serial date support
                DateSourceFormat.EXCEL_SERIAL
            ];
        case 'boolean':
        case 'bool':
            return [BooleanSourceFormat.STANDARD];
        case 'string':
        default:
            return [StringSourceFormat.PASSTHROUGH];
    }
}

/**
 * Get human-readable label for a source format
 * @param format - The source format
 * @returns Display label
 */
export function getSourceFormatLabel(format: SourceFormat): string {
    const labels: Record<string, string> = {
        // Numbers
        [NumberSourceFormat.STANDARD]: 'Standard',
        [NumberSourceFormat.COBOL]: 'COBOL',
        [NumberSourceFormat.SCIENTIFIC]: 'Scientific',
        [NumberSourceFormat.CURRENCY]: 'Currency',
        // Dates
        [DateSourceFormat.AUTO]: 'Auto-detect',
        [DateSourceFormat.YYYY_MM_DD]: 'YYYY-MM-DD',
        [DateSourceFormat.MM_DD_YYYY]: 'MM/DD/YYYY',
        [DateSourceFormat.DD_MM_YYYY]: 'DD/MM/YYYY',
        [DateSourceFormat.UNIX_TIMESTAMP]: 'Unix Timestamp',
        [DateSourceFormat.ISO_8601]: 'ISO 8601',
        // GitHub Issue #162: Excel serial date support
        [DateSourceFormat.EXCEL_SERIAL]: 'Excel Serial Date',
        // Boolean
        [BooleanSourceFormat.STANDARD]: 'Standard',
        // String
        [StringSourceFormat.PASSTHROUGH]: 'No Transform'
    };
    return labels[format] || format;
}

/**
 * Get default source format for a target type
 * @param targetType - The target type from template variable
 * @returns Default source format
 */
export function getDefaultSourceFormat(targetType: TargetDataType): SourceFormat {
    switch (targetType) {
        case 'number':
        case 'integer':
        case 'int':
            return NumberSourceFormat.STANDARD;
        case 'date':
            return DateSourceFormat.AUTO;
        case 'boolean':
        case 'bool':
            return BooleanSourceFormat.STANDARD;
        case 'string':
        default:
            return StringSourceFormat.PASSTHROUGH;
    }
}

/**
 * Result of coercing a single value
 */
export interface CoercionResult {
    /** Whether coercion was successful */
    success: boolean;
    /** Original value before coercion */
    original: string;
    /** Coerced value (undefined if failed) */
    coerced?: string | number | boolean | null;
    /** Warning message (e.g., precision loss) */
    warning?: string;
    /** Error message if coercion failed */
    error?: string;
}

/**
 * Result of validating column coercion
 */
export interface ColumnCoercionResult {
    /** Column/variable name */
    columnName: string;
    /** Whether all samples coerced successfully */
    success: boolean;
    /** Individual sample results */
    coercedSamples: CoercionResult[];
    /** Overall status for UI display */
    overallStatus: 'success' | 'warning' | 'error';
    /** Count of failed rows */
    failedCount: number;
    /** Row indices that failed (for error reporting) */
    failedRowIndices: number[];
}

/**
 * Request for full dataset validation
 */
export interface FullValidationRequest {
    /** Mapping of template variable to CSV column */
    mappings: Array<{
        variableName: string;
        csvColumn: string;
        targetType: TargetDataType;
        sourceFormat: SourceFormat;
    }>;
    /** All CSV data rows */
    rows: string[][];
    /** CSV headers */
    headers: string[];
}

/**
 * Result of full dataset validation
 */
export interface FullValidationResult {
    /** Whether all validations passed */
    success: boolean;
    /** Overall status */
    overallStatus: 'success' | 'warning' | 'error';
    /** Total rows validated */
    totalRows: number;
    /** Rows with at least one error */
    rowsWithErrors: number;
    /** Per-column results */
    columnResults: ColumnCoercionResult[];
    /** Indices of rows that should be skipped */
    skipRowIndices: number[];
}
