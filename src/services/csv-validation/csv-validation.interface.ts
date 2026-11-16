// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
export interface ValidationResult {
    isValid: boolean;
    error?: string;
}

export interface CellValidationResult {
    isValid: boolean;
    error?: string;
    warning?: string;
}

export interface ErrorDetail {
    row: number;
    column: string;
    value: string;
    expectedType: string;
    error: string;
}

export interface ValidationStatistics {
    totalRows: number;
    validatedRows: number;
    errorCount: number;
    warningCount: number;
    errorsByColumn: Record<string, number>;
    affectedRows: number[];
}

export interface DetailedValidationResult {
    isValid: boolean;
    error?: string;
    warnings?: string[];
    errorDetails?: ErrorDetail[];
    statistics?: ValidationStatistics;
}

export interface ValidationOptions {
    maxRows?: number;
    stopOnFirstError?: boolean;
    collectAllErrors?: boolean;
    includeWarnings?: boolean;
    maxErrorsToReport?: number;
    useSamplingForPreview?: boolean; // GitHub Issue #106: Enable sampling (50 rows) for preview mode
}

export interface TemplateVariable {
    name: string;
    dataType: string;
    mapped?: boolean;
    column?: string | null;
}

/**
 * Column type information for dual-stage validation
 */
export interface ColumnTypeInfo {
    columnName: string;
    selectedType: string; // The type selected by user in UI
    detectedType?: string; // The type detected by type detection service
}

/**
 * Source type validation result
 */
export interface SourceTypeValidationResult {
    isValid: boolean;
    error?: string;
    warnings?: string[];
    columnResults: ColumnValidationResult[];
}

/**
 * Individual column validation result
 */
export interface ColumnValidationResult {
    columnName: string;
    selectedType: string;
    isConsistent: boolean;
    inconsistentRows?: number[];
    errorCount?: number;
    sampleErrors?: string[];
}

export interface ICSVValidationService {
    /**
     * Validate basic CSV structure (headers, format, etc.)
     */
    validateStructure(csvData: string): Promise<ValidationResult>;

    /**
     * STAGE 1: Validate source data consistency within each column
     * Validates that all values in each column are consistent with the selected type
     */
    validateSourceTypes(
        csvData: string,
        columnTypes: ColumnTypeInfo[],
        options?: ValidationOptions
    ): SourceTypeValidationResult;

    /**
     * STAGE 2: Validate mapping compatibility between column types and template variables
     * Validates that selected column types are compatible with endpoint template variables
     */
    validateMappingCompatibility(
        columnTypes: ColumnTypeInfo[],
        variables: TemplateVariable[]
    ): DetailedValidationResult;

    /**
     * LEGACY: Validate data types against template variables with comprehensive error reporting
     * @deprecated Use validateSourceTypes + validateMappingCompatibility instead
     */
    validateDataTypes(
        csvData: string, 
        variables: TemplateVariable[], 
        headers: string[], 
        options?: ValidationOptions
    ): DetailedValidationResult;

    /**
     * Validate a single cell value against expected data type
     */
    validateCell(
        value: string, 
        expectedType: string, 
        variableName: string, 
        rowNumber: number
    ): CellValidationResult;

    /**
     * Parse CSV data and return row count and structure info
     */
    parseCSVInfo(csvData: string): {
        totalRows: number;
        headers: string[];
        hasData: boolean;
        isEmpty: boolean;
    };
}