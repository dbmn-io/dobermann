// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Type Detection Service Interface
 * Automatically detects data types from CSV column samples
 * 
 * Following Architecture.md patterns:
 * - Service implements interface for DI compatibility
 * - Separation of concerns with type detection logic
 * - Integration with format conversion pipeline
 */

/**
 * Supported data types for automatic detection
 */
export enum DetectedDataType {
    STRING = 'string',
    NUMBER = 'number',
    COBOL_NUMBER = 'cobol_number',
    CURRENCY = 'currency', 
    SCIENTIFIC = 'scientific',
    BOOLEAN = 'boolean',
    DATE = 'date',
    DATETIME = 'datetime',
    ARRAY = 'array'
}

/**
 * Column type detection result
 */
export interface ColumnTypeDetection {
    /** Detected data type */
    type: DetectedDataType;
    /** Confidence level (0.0 to 1.0) */
    confidence: number;
    /** Sample values that led to detection */
    samples: string[];
    /** Type-specific metadata */
    metadata?: {
        /** For currency: detected symbol and format */
        currencySymbol?: string;
        currencyFormat?: 'US' | 'EU' | 'OTHER';
        /** For dates: detected format pattern */
        dateFormat?: string;
        /** For datetime: detected timezone */
        timezone?: string;
        /** For COBOL: detected padding and sign format */
        cobolFormat?: {
            totalLength: number;
            decimalPlaces: number;
            hasSign: boolean;
        };
        /** For arrays: detected element type */
        elementType?: DetectedDataType;
    };
}

/**
 * File-level type detection result
 */
export interface FileTypeDetectionResult {
    /** Column name to type detection mapping */
    columnTypes: Map<string, ColumnTypeDetection>;
    /** Overall detection confidence */
    overallConfidence: number;
    /** Number of rows analyzed */
    rowsAnalyzed: number;
    /** Any warnings during detection */
    warnings?: string[];
}

/**
 * Type detection configuration options
 */
export interface TypeDetectionOptions {
    /** Maximum number of rows to sample for detection (default: 20) */
    maxSampleRows?: number;
    /** Minimum confidence threshold for type detection (default: 0.6) */
    minConfidence?: number;
    /** Whether to detect timezone in datetime fields (default: true) */
    detectTimezone?: boolean;
    /** Whether to detect currency formats (default: true) */
    detectCurrency?: boolean;
    /** Whether to detect COBOL number patterns (default: true) */
    detectCobolNumbers?: boolean;
}

/**
 * Service interface for data type detection operations
 */
export interface IDataTypeDetectionService {
    /**
     * Detect data types for all columns in CSV data
     * @param csvData - Raw CSV content as string
     * @param options - Detection configuration options
     * @returns Promise resolving to file-level detection result
     */
    detectColumnTypes(csvData: string, options?: TypeDetectionOptions): Promise<FileTypeDetectionResult>;

    /**
     * Detect data type for a specific column from sample values
     * @param columnName - Name of the column
     * @param samples - Array of sample values from the column
     * @param options - Detection configuration options
     * @returns Promise resolving to column type detection result
     */
    detectColumnType(columnName: string, samples: string[], options?: TypeDetectionOptions): Promise<ColumnTypeDetection>;

    /**
     * Validate if a value can be converted to a specific type
     * @param value - Value to validate
     * @param targetType - Target data type to validate against
     * @returns True if value can be converted to target type
     */
    canConvertToType(value: string, targetType: DetectedDataType): boolean;

    /**
     * Get supported data types for detection
     * @returns Array of supported data types
     */
    getSupportedTypes(): DetectedDataType[];

    /**
     * Get human-readable description for a data type
     * @param type - Data type to describe
     * @returns Human-readable description
     */
    getTypeDescription(type: DetectedDataType): string;
}