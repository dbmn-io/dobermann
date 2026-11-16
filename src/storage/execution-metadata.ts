// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { z } from 'zod';
import {
    UnifiedExecutionStatusSchema,
    ExecutionStatusType,
    BatchStatusSchema,
    BatchStatusType,
    TestStatusSchema as UnifiedTestStatusSchema,
    TestStatusType,
    StatusCheckers
} from '../types/unified-execution-status';
import { RepeatableQueryParamSchema } from '../data-loading/zod-schemas';
import { APIEndpointConfig } from '../data-loading/types';

// Re-export unified schemas for backward compatibility
export const ExecutionStatusSchema = UnifiedExecutionStatusSchema;
export const BatchStatus = {
    // GitHub Issue #94 - PREPARING removed: batches transition directly to PENDING after first chunk
    PENDING: 'pending' as const,
    RUNNING: 'running' as const,
    COMPLETED: 'completed' as const,
    STOPPED: 'stopped' as const,
    CANCELLED: 'cancelled' as const,
    PAUSED: 'paused' as const
};
export const TestStatusSchema = UnifiedTestStatusSchema;

// Execution type schema for data structure alignment
export const ExecutionTypeSchema = z.enum(['individual', 'batch', 'batch_member']);
export type ExecutionType = z.infer<typeof ExecutionTypeSchema>;

// Batch preparation state schema for chunked just-in-time preparation
// GitHub Issue #94 - Just-In-Time streaming preparation with chunk-based refill
export const BatchPreparationStateSchema = z.object({
    totalRows: z.number(),                          // Total CSV rows (excluding header)
    totalTransactions: z.number(),                  // Total transactions after array repetition analysis
    preparedTransactions: z.number(),               // Number of batch_member transactions created so far
    nextCsvRowIndex: z.number(),                    // Cursor: next CSV row to process (for resume/pause)
    chunkSize: z.number().default(32),              // Transactions per chunk (maxParallel × 2)
    isComplete: z.boolean().default(false),         // True when all transactions have been prepared
    // GitHub Issue #147: Nested array group tracking
    groupingColumn: z.string().optional(),          // Column name for grouping (e.g., "LocationId")
    groupingColumns: z.array(z.string()).optional(), // All grouping columns: a new root element when ANY changes
    totalGroups: z.number().optional(),             // Total unique root elements in CSV
    preparedGroups: z.number().optional(),          // Root elements processed so far
    groupsPerFile: z.number().optional()            // maxRepetitions setting
});
export type BatchPreparationState = z.infer<typeof BatchPreparationStateSchema>;

// Batch configuration schema for unified model
export const BatchConfigurationSchema = z.object({
    stopOnFirstError: z.boolean(),
    // #445: the name typed in Run Batch (Review → Name), renamed in the Console's Settings.
    // History and the Console show it; endpointName stays the endpoint's. Not set: a run from
    // before, shown by its endpoint's name.
    name: z.string().optional(),
    maxConcurrentExecutions: z.number().optional(),
    retryFailedExecutions: z.boolean().optional(),
    maxRetryAttempts: z.number().optional(),
    errorTolerance: z.boolean().optional(), // GitHub Issue #47 - Error tolerance support
    maxErrors: z.number().optional(), // GitHub Issue #47 - Maximum allowed errors for tolerance

    // GitHub Issue #78 - Parallel processing configuration stored in batch metadata
    parallelProcessing: z.object({
        enabled: z.boolean(),
        maxConcurrency: z.union([
            z.literal(1),
            z.literal(2),
            z.literal(4),
            z.literal(8),
            z.literal(16)
        ])
    }).optional(),

    // GitHub Issue #108 - Query param repetition configuration stored in batch metadata
    repeatableQueryParam: RepeatableQueryParamSchema.optional(),

    // GitHub Issue #94 - Chunked preparation settings
    chunkedPreparation: z.object({
        enabled: z.boolean().default(true),
        chunkSize: z.number().min(1).max(100).default(8)
    }).optional(),

    // #298: a paginated batch whose responses report a total starts false, and turns true once
    // every page has come back. Not set (older batches, and pagination with no total): complete.
    // Compare flags a result that is false, since rows on the pages not fetched look missing.
    pagesComplete: z.boolean().optional()
});
export type BatchConfiguration = z.infer<typeof BatchConfigurationSchema>;

// Batch resumption data schema for unified model
export const BatchResumptionDataSchema = z.object({
    currentExecutionIndex: z.number(),
    completedExecutions: z.array(z.string()),
    failedExecutions: z.array(z.string()),
    skippedExecutions: z.array(z.string()),
    pausedAt: z.date().optional()
});
export type BatchResumptionData = z.infer<typeof BatchResumptionDataSchema>;

export const ExecutionMetadataSchema = z.object({
    id: z.string(),
    environment: z.string(),
    environmentId: z.string().optional(), // UUID of environment (for proper lookups) - TODO: make mandatory after migration
    organization: z.string().optional(),
    endpointId: z.string(),
    endpointName: z.string(),
    endpointMethod: z.string(),
    endpointPath: z.string(),
    batchId: z.string().optional(),
    executionType: ExecutionTypeSchema.default('individual'), // Mandatory with default
    rowStart: z.number().optional(), // Starting CSV row index for batch members (1-based, NULL for individual/batch)
    rows: z.string().default('1'), // Mandatory with default - for batches: "X(Y)" format, for individuals: "1"
    status: z.string(), // Context-dependent validation - see refinement below
    // Issue #311: for a batch, total milliseconds spent RUNNING across sessions
    // (pauses excluded) — what the Console's elapsed clock resumes from after a
    // reload. (The column predates this and had no writer.)
    runTime: z.number().optional(),
    createdAt: z.date(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
    requestFile: z.string().optional(),
    responseFile: z.string().optional(),
    errorMessage: z.string().optional(),
    httpStatus: z.number().optional(),
    httpStatusText: z.string().optional(),
    requestHash: z.string().optional(),
    // NEW: Request metadata fields for individual and batch_member executions
    requestHeaders: z.record(z.string(), z.string()).optional(), // Headers used in HTTP request
    requestQueryParams: z.record(z.string(), z.string()).optional(), // Query parameters used in HTTP request
    // NEW: Unified model fields for batch support
    batchConfiguration: BatchConfigurationSchema.optional(), // BatchConfiguration when executionType is 'batch'
    batchResumptionData: BatchResumptionDataSchema.optional(), // BatchResumptionData for batch progress tracking

    // GitHub Issue #94: Chunked just-in-time preparation state
    preparationState: BatchPreparationStateSchema.optional(), // Track preparation progress during execution

    // Test-related fields
    testStatus: UnifiedTestStatusSchema.optional(),
    testsPassed: z.number().optional(),
    testsFailed: z.number().optional(),
    testResults: z.any().optional(), // Will store TestExecutionResult when implemented
    
    // NEW: Execution logging support
    logPath: z.string().optional(), // Path to the execution log file (.log format)
    
    // GitHub Issue #47: Store complete endpoint configuration for tolerance display
    endpointConfig: z.custom<APIEndpointConfig>().optional(), // Complete endpoint configuration including dataLoadingConfig
    
    // GitHub Issue #48: Store actual column mapping used during CSV batch execution
    columnMappingUsed: z.array(z.object({
        templateVariable: z.string(),
        csvColumn: z.string(),
        mappingType: z.enum(['csvColumn', 'static', 'template']),
        dataType: z.string().optional()
    })).optional(), // Column mapping actually used during execution (may differ from endpoint default)

    // GitHub Issue #165: Store environment variables for {{ENV:varName}} template substitution
    environmentVariables: z.record(z.string()).optional(), // Environment variables used during batch execution
    // #424/#160: the batch's base URL with its variables filled, fixed when it started; its members go there
    baseUrl: z.string().optional(),

    // GitHub Issue #68: Batch copy lineage tracking
    copiedFromBatchId: z.string().optional(), // ID of the batch this was copied from
    copiedFromEnvironment: z.string().optional(), // Environment this was copied from
    copiedFromOrganization: z.string().optional(), // Organization this was copied from
    copiedAt: z.preprocess((val) => {
        if (typeof val === 'string') return new Date(val);
        return val;
    }, z.date()).optional(), // When this copy was created
    copyGeneration: z.number().optional(), // Copy depth (1 = original, 2 = first copy, etc.)

    // GitHub Issue #74: Split transaction tracking
    splitFromMemberId: z.string().optional(), // ID of the original member this was split from
    isSplitTransaction: z.boolean().optional(), // Whether this is a split transaction
    splitReason: z.string().optional(), // Reason for splitting (e.g., "Array transaction split for error isolation")
    arrayIndex: z.number().optional(), // Which element in the original array this represents (0-based)
    originalArraySize: z.number().optional(), // Total size of the original array that was split

    // GitHub Issue #151: Reprocess tracking fields (cross-batch fields deprecated — kept for backward compat)
    reprocessedFromBatchId: z.string().optional(), // DEPRECATED: unused after in-batch reprocess overhaul
    reprocessedToBatchId: z.string().optional(), // DEPRECATED: unused after in-batch reprocess overhaul
    reprocessType: z.enum(['INCOMPLETE', 'ERRORS', 'PENDING', 'ALL', 'SELECTED', 'SPLIT']).optional(), // Type of reprocessing performed

    // In-batch reprocess tracking
    reprocessCount: z.number().optional() // Number of times this member has been retried

    // GitHub Issue #94: Pagination detected on-the-fly from endpointConfig.queryParams (no storage needed)
}).refine((data) => {
    // Context-dependent status validation based on executionType
    if (data.executionType === 'batch') {
        return BatchStatusSchema.safeParse(data.status).success;
    } else {
        // For 'individual' and 'batch_member' executions
        return UnifiedExecutionStatusSchema.safeParse(data.status).success;
    }
}, {
    message: "Status must be valid for the execution type (batch status for batch executions, individual status for individual/batch_member executions)"
});

// Use unified types
export type ExecutionStatus = ExecutionStatusType;
export type TestStatus = TestStatusType;
export type ExecutionMetadata = z.infer<typeof ExecutionMetadataSchema>;

// Context-dependent status helpers for unified ExecutionMetadata
export const StatusHelpers = {
    /**
     * Get valid status values for the given execution type
     */
    getValidStatuses: (executionType: ExecutionType) =>
        executionType === 'batch' ? BatchStatusSchema.options : UnifiedExecutionStatusSchema.options,

    /**
     * Validate if a status is valid for the given execution type
     */
    isValidStatus: (executionType: ExecutionType, status: string): boolean => {
        if (executionType === 'batch') {
            return BatchStatusSchema.safeParse(status).success;
        } else {
            return UnifiedExecutionStatusSchema.safeParse(status).success;
        }
    },

    /**
     * Check if execution is finished based on execution type and status
     */
    isFinished: (executionType: ExecutionType, status: string): boolean => {
        if (executionType === 'batch') {
            return ['completed', 'cancelled', 'stopped'].includes(status);
        } else {
            return StatusCheckers.isFinished(status as ExecutionStatusType);
        }
    },

    /**
     * Check if execution is in progress based on execution type and status
     */
    isInProgress: (executionType: ExecutionType, status: string): boolean => {
        if (executionType === 'batch') {
            return ['running', 'paused'].includes(status);
        } else {
            return StatusCheckers.isInProgress(status as ExecutionStatusType);
        }
    },

    /**
     * Check if execution can be retried based on execution type and status
     */
    isRetryable: (executionType: ExecutionType, status: string): boolean => {
        if (executionType === 'batch') {
            return ['stopped', 'cancelled'].includes(status);
        } else {
            return StatusCheckers.isRetryable(status as ExecutionStatusType);
        }
    }
};

// Database row interface (with string dates from SQLite)
export interface ExecutionRow {
    id: string;
    environment: string;
    environment_id: string | null; // UUID of environment
    organization: string | null;
    endpoint_id: string;
    endpoint_name: string;
    endpoint_method: string;
    endpoint_path: string;
    batch_id: string | null;
    execution_type: ExecutionType;
    row_start: number | null; // Starting CSV row index for batch members (1-based, NULL for individual/batch)
    rows: string;
    status: ExecutionStatus;
    run_time: number | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    request_file: string | null;
    response_file: string | null;
    error_message: string | null;
    http_status: number | null;
    http_status_text: string | null;
    request_hash: string | null;
    // Request metadata database fields
    request_headers: string | null; // JSON string
    request_query_params: string | null; // JSON string
    // Test-related database fields
    test_status: TestStatus | null;
    tests_passed: number | null;
    tests_failed: number | null;
    test_results: string | null; // JSON string
    // Execution logging field
    log_path: string | null; // Path to execution log file
    // GitHub Issue #94: Batch preparation state field
    preparation_state: string | null; // JSON string - Batch preparation progress tracking
    // GitHub Issue #47: Endpoint configuration field
    endpoint_config: string | null; // JSON string - Complete endpoint configuration including dataLoadingConfig
    // GitHub Issue #48: Column mapping field
    column_mapping_used: string | null; // JSON string - Actual column mapping used during execution
    // GitHub Issue #165: Environment variables field
    environment_variables: string | null; // JSON string - Environment variables for {{ENV:varName}} substitution
    base_url?: string | null; // #424: the batch's filled base URL
    // GitHub Issue #68: Batch copy lineage fields
    copied_from_batch_id: string | null; // ID of the batch this was copied from
    copied_from_environment: string | null; // Environment this was copied from
    copied_from_organization: string | null; // Organization this was copied from
    copied_at: string | null; // When this copy was created (ISO string)
    copy_generation: number | null; // Copy depth (1 = original, 2 = first copy, etc.)
    // GitHub Issue #151: Reprocess tracking fields
    reprocessed_from_batch_id: string | null; // Links to original batch that was reprocessed (on child)
    reprocessed_to_batch_id: string | null; // Links to new batch created from reprocess (on parent)
    reprocess_type: string | null; // Type of reprocessing performed ('INCOMPLETE' | 'ERRORS' | 'PENDING' | 'ALL' | 'SELECTED' | 'SPLIT')
    // In-batch reprocess tracking
    reprocess_count: number | null; // Number of times this member has been retried
    // GitHub Issue #94: Pagination detected on-the-fly from endpointConfig (no storage needed)
}

// Query interfaces
export interface ExecutionFilters {
    environment?: string;
    status?: ExecutionStatus;
    batchId?: string;
    endpointId?: string;
    startDate?: Date;
    endDate?: Date;
}

export interface TableOptions {
    limit?: number;
    offset?: number;
    sortBy?: keyof ExecutionMetadata;
    sortOrder?: 'asc' | 'desc';
    filters?: ExecutionFilters;
}

export interface ExecutionTableResult {
    executions: ExecutionMetadata[];
    totalCount: number;
    hasMore: boolean;
}

export interface ExecutionStats {
    totalExecutions: number;
    pendingExecutions: number;
    runningExecutions: number;
    completedExecutions: number;
    cancelledExecutions: number;
    errorExecutions: number;
    averageRunTime: number | null;
}

// Helper functions for data conversion
export function rowToMetadata(row: ExecutionRow): ExecutionMetadata {
    return {
        id: row.id,
        environment: row.environment,
        organization: row.organization || undefined,
        endpointId: row.endpoint_id,
        endpointName: row.endpoint_name,
        endpointMethod: row.endpoint_method,
        endpointPath: row.endpoint_path,
        batchId: row.batch_id || undefined,
        executionType: row.execution_type || 'individual', // Use database value or default
        rowStart: row.row_start || undefined,
        rows: row.rows || '1', // Use database value or default
        status: row.status,
        runTime: row.run_time || undefined,
        createdAt: new Date(row.created_at),
        startedAt: row.started_at ? new Date(row.started_at) : undefined,
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
        requestFile: row.request_file || undefined,
        responseFile: row.response_file || undefined,
        errorMessage: row.error_message || undefined,
        httpStatus: row.http_status || undefined,
        httpStatusText: row.http_status_text || undefined,
        requestHash: row.request_hash || undefined,
        // Request metadata fields
        requestHeaders: row.request_headers ? JSON.parse(row.request_headers) : undefined,
        requestQueryParams: row.request_query_params ? JSON.parse(row.request_query_params) : undefined,
        // Test-related fields
        testStatus: row.test_status || undefined,
        testsPassed: row.tests_passed || undefined,
        testsFailed: row.tests_failed || undefined,
        testResults: row.test_results ? JSON.parse(row.test_results) : undefined,
        // Execution logging field
        logPath: row.log_path || undefined,
        // GitHub Issue #94: Batch preparation state field
        preparationState: row.preparation_state ? JSON.parse(row.preparation_state) : undefined,
        // GitHub Issue #47: Endpoint configuration field
        endpointConfig: row.endpoint_config ? JSON.parse(row.endpoint_config) : undefined,
        // GitHub Issue #48: Column mapping field
        columnMappingUsed: row.column_mapping_used ? JSON.parse(row.column_mapping_used) : undefined,
        // GitHub Issue #165: Environment variables field
        environmentVariables: row.environment_variables ? JSON.parse(row.environment_variables) : undefined,
        baseUrl: row.base_url || undefined,
        // GitHub Issue #68: Batch copy lineage fields
        copiedFromBatchId: row.copied_from_batch_id || undefined,
        copiedFromEnvironment: row.copied_from_environment || undefined,
        copiedFromOrganization: row.copied_from_organization || undefined,
        copiedAt: row.copied_at ? new Date(row.copied_at) : undefined,
        copyGeneration: row.copy_generation || undefined,
        // GitHub Issue #151: Reprocess tracking fields
        reprocessedFromBatchId: row.reprocessed_from_batch_id || undefined,
        reprocessedToBatchId: row.reprocessed_to_batch_id || undefined,
        reprocessType: row.reprocess_type as ExecutionMetadata['reprocessType'] || undefined,
        // In-batch reprocess tracking
        reprocessCount: row.reprocess_count || undefined
        // GitHub Issue #94: Pagination detected on-the-fly from endpointConfig (no storage needed)
    };
}

export function metadataToRow(metadata: ExecutionMetadata): Omit<ExecutionRow, 'id'> {
    return {
        environment: metadata.environment,
        environment_id: metadata.environmentId || null,
        organization: metadata.organization || null,
        endpoint_id: metadata.endpointId,
        endpoint_name: metadata.endpointName,
        endpoint_method: metadata.endpointMethod,
        endpoint_path: metadata.endpointPath,
        batch_id: metadata.batchId || null,
        execution_type: metadata.executionType,
        row_start: metadata.rowStart || null,
        rows: metadata.rows,
        status: metadata.status as ExecutionStatus,
        run_time: metadata.runTime || null,
        created_at: metadata.createdAt.toISOString(),
        started_at: metadata.startedAt?.toISOString() || null,
        completed_at: metadata.completedAt?.toISOString() || null,
        request_file: metadata.requestFile || null,
        response_file: metadata.responseFile || null,
        error_message: metadata.errorMessage || null,
        http_status: metadata.httpStatus || null,
        http_status_text: metadata.httpStatusText || null,
        request_hash: metadata.requestHash || null,
        // Request metadata fields
        request_headers: metadata.requestHeaders ? JSON.stringify(metadata.requestHeaders) : null,
        request_query_params: metadata.requestQueryParams ? JSON.stringify(metadata.requestQueryParams) : null,
        // Test-related fields
        test_status: metadata.testStatus || null,
        tests_passed: metadata.testsPassed || null,
        tests_failed: metadata.testsFailed || null,
        test_results: metadata.testResults ? JSON.stringify(metadata.testResults) : null,
        // Execution logging field
        log_path: metadata.logPath || null,
        // GitHub Issue #94: Batch preparation state field
        preparation_state: metadata.preparationState ? JSON.stringify(metadata.preparationState) : null,
        // GitHub Issue #47: Endpoint configuration field
        endpoint_config: metadata.endpointConfig ? JSON.stringify(metadata.endpointConfig) : null,
        // GitHub Issue #48: Column mapping field
        column_mapping_used: metadata.columnMappingUsed ? JSON.stringify(metadata.columnMappingUsed) : null,
        // GitHub Issue #165: Environment variables field
        environment_variables: metadata.environmentVariables ? JSON.stringify(metadata.environmentVariables) : null,
        base_url: metadata.baseUrl || null,
        // GitHub Issue #68: Batch copy lineage fields
        copied_from_batch_id: metadata.copiedFromBatchId || null,
        copied_from_environment: metadata.copiedFromEnvironment || null,
        copied_from_organization: metadata.copiedFromOrganization || null,
        copied_at: metadata.copiedAt?.toISOString() || null,
        copy_generation: metadata.copyGeneration || null,
        // GitHub Issue #151: Reprocess tracking fields
        reprocessed_from_batch_id: metadata.reprocessedFromBatchId || null,
        reprocessed_to_batch_id: metadata.reprocessedToBatchId || null,
        reprocess_type: metadata.reprocessType || null,
        // In-batch reprocess tracking
        reprocess_count: metadata.reprocessCount || null
        // GitHub Issue #94: Pagination detected on-the-fly from endpointConfig (no storage needed)
    };
}

// Validation functions
export function validateExecutionMetadata(data: unknown): ExecutionMetadata {
    return ExecutionMetadataSchema.parse(data);
}

export function isValidExecutionStatus(status: string): status is ExecutionStatus {
    return ExecutionStatusSchema.safeParse(status).success;
}