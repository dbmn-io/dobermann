// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Loading Configuration Types
 * 
 * These types are now inferred from Zod schemas to provide both TypeScript 
 * type safety and runtime validation. This ensures a single source of truth
 * between TypeScript backend and JavaScript frontend.
 */

// Import all types from Zod schemas for consistency
export type {
    DataType,
    ErrorHandlingMode,
    ErrorToleranceType,
    RepeatableArray,
    RepeatableQueryParam,
    TestScript,
    RetryConditions,
    RetryConfig,
    ErrorTolerance,
    ErrorHandlingConfig,
    DataValidationConfig,
    DataLoadingConfig,
    HeaderConfig,
    APIEndpointConfig,
    Flavour
} from './zod-schemas';

// Re-export all validation and factory functions
export {
    createDefaultRetryConfig,
    createDefaultErrorHandling,
    createDefaultDataValidation,
    createDefaultDataLoadingConfig,
    validateDataLoadingConfig,
    validateAPIEndpointConfig
} from './zod-schemas';

// Legacy validation function for backward compatibility
// New code should use validateDataLoadingConfig from zod-schemas directly
import type { DataLoadingConfig } from './zod-schemas';
import { validateDataLoadingConfig as zodValidateDataLoadingConfig } from './zod-schemas';

export function validateDataLoadingConfigLegacy(config: DataLoadingConfig): string[] {
    const validation = zodValidateDataLoadingConfig(config);
    return validation.success ? [] : validation.errors || [];
}

// Additional types needed for Phase 3 implementation
export interface ColumnMapping {
    templateVariable: string;
    mappingType: 'csvColumn' | 'static' | 'template';
    csvColumn?: string;
    staticValue?: string;
    templateValue?: string;
}

export interface ProgressUpdate {
    percentage: number;
    processedRows: number;
    successfulRows: number;
    failedRows: number;
    totalRows: number;
    status: string;
    errors?: Array<{
        rowIndex: number;
        message: string;
        details?: any;
    }>;
}

export interface RowProcessingResult {
    rowIndex: number;
    success: boolean;
    processedTemplate?: string;
    apiResponse?: any;
    errorMessage?: string;
    testResults?: Array<{
        name: string;
        passed: boolean;
        error?: string;
    }>;
    retryAttempts?: number;
    processingTimeMs?: number;
}

export interface DataLoadingResult {
    totalRows: number;
    processedRows: number;
    successfulRows: number;
    failedRows: number;
    duration: number;
    stopped: boolean;
    stoppedReason?: string;
    rowResults: RowProcessingResult[];
    summary: {
        successRate: number;
        averageProcessingTime: number;
        totalTestsRun: number;
        totalTestsPassed: number;
        totalTestsFailed: number;
    };
}