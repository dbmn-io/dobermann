// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformation Service Interface
 * Transforms data values between different detected types
 * 
 * Following Architecture.md patterns:
 * - Service implements interface for DI compatibility
 * - Separation of concerns with transformation logic
 * - Integration with type detection and validation pipeline
 */

import { DetectedDataType } from '../data-type-detection/data-type-detection.interface';

/**
 * Transformation result for a single value
 */
export interface ValueTransformationResult {
    /** Original value */
    originalValue: string;
    /** Transformed value */
    transformedValue: string;
    /** Whether transformation was successful */
    success: boolean;
    /** Source data type */
    sourceType: DetectedDataType;
    /** Target data type */
    targetType: DetectedDataType;
    /** Error message if transformation failed */
    error?: string;
    /** Additional transformation metadata */
    metadata?: {
        /** For currency: extracted numeric value */
        numericValue?: number;
        /** For datetime: converted timezone */
        convertedTimezone?: string;
        /** For COBOL: parsed components */
        cobolComponents?: {
            sign: '+' | '-' | '';
            integerPart: string;
            decimalPart: string;
        };
    };
}

/**
 * Batch transformation result for multiple values
 */
export interface BatchTransformationResult {
    /** Number of values processed */
    totalProcessed: number;
    /** Number of successful transformations */
    successCount: number;
    /** Number of failed transformations */
    errorCount: number;
    /** Individual transformation results */
    results: ValueTransformationResult[];
    /** Overall success rate */
    successRate: number;
}

/**
 * Column transformation configuration
 */
export interface ColumnTransformationConfig {
    /** Column name */
    columnName: string;
    /** Source data type (detected) */
    sourceType: DetectedDataType;
    /** Target data type (user selected or mapped) */
    targetType: DetectedDataType;
    /** Transformation options */
    options?: {
        /** For timezone conversion: source timezone */
        sourceTimezone?: string;
        /** For timezone conversion: target timezone (default: GMT) */
        targetTimezone?: string;
        /** For currency: remove formatting and convert to number */
        stripCurrencyFormatting?: boolean;
        /** For number formatting: decimal places to preserve */
        decimalPlaces?: number;
        /** For boolean: custom true/false mapping */
        booleanMapping?: {
            trueValues: string[];
            falseValues: string[];
        };
    };
}

/**
 * File-level transformation configuration
 */
export interface FileTransformationConfig {
    /** Column transformation configurations */
    columns: ColumnTransformationConfig[];
    /** Global transformation options */
    globalOptions?: {
        /** Default timezone for datetime conversions */
        defaultTimezone?: string;
        /** Whether to preserve original values in metadata */
        preserveOriginalValues?: boolean;
        /** Whether to fail on any transformation error */
        failOnErrors?: boolean;
    };
}

/**
 * Service interface for data transformation operations
 */
export interface IDataTransformationService {
    /**
     * Transform a single value from source type to target type
     * @param value - Value to transform
     * @param sourceType - Source data type
     * @param targetType - Target data type
     * @param options - Transformation options
     * @returns Promise resolving to transformation result
     */
    transformValue(
        value: string,
        sourceType: DetectedDataType,
        targetType: DetectedDataType,
        options?: any
    ): Promise<ValueTransformationResult>;

    /**
     * Transform multiple values for a single column
     * @param values - Array of values to transform
     * @param config - Column transformation configuration
     * @returns Promise resolving to batch transformation result
     */
    transformColumn(
        values: string[],
        config: ColumnTransformationConfig
    ): Promise<BatchTransformationResult>;

    /**
     * Transform entire CSV data based on column configurations
     * @param csvData - Raw CSV content
     * @param config - File transformation configuration
     * @returns Promise resolving to transformed CSV content
     */
    transformFile(
        csvData: string,
        config: FileTransformationConfig
    ): Promise<string>;

    /**
     * Validate if transformation between types is supported
     * @param sourceType - Source data type
     * @param targetType - Target data type
     * @returns True if transformation is supported
     */
    isTransformationSupported(
        sourceType: DetectedDataType,
        targetType: DetectedDataType
    ): boolean;

    /**
     * Get available transformation paths from a source type
     * @param sourceType - Source data type
     * @returns Array of supported target types
     */
    getSupportedTargetTypes(sourceType: DetectedDataType): DetectedDataType[];

    /**
     * Preview transformation for a sample value
     * @param value - Sample value to preview
     * @param sourceType - Source data type
     * @param targetType - Target data type
     * @param options - Transformation options
     * @returns Preview of transformed value or error message
     */
    previewTransformation(
        value: string,
        sourceType: DetectedDataType,
        targetType: DetectedDataType,
        options?: any
    ): Promise<{ preview: string; error?: string }>;
}