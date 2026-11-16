// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig, RepeatableQueryParam } from '../../data-loading/types';

/**
 * Options for creating a transaction (execution record with request file)
 * Extended to support unified execution model with execution types and status
 */
export interface TransactionCreationOptions {
    /** Endpoint configuration containing method, path, body, headers */
    endpoint: APIEndpointConfig;
    
    /** Environment name (e.g., 'production', 'staging') */
    environment: string;

    /** Environment ID (UUID) for proper environment lookups */
    environmentId?: string;

    /** Organization identifier */
    organization: string;
    
    /** Directory path where request file should be saved */
    directoryPath: string;
    
    /** Simple filename for the request file (e.g., 'transaction-001.json') */
    fileName: string;
    
    /** Optional batch ID to link execution to parent batch */
    batchId?: string;
    
    /** NEW: Execution type for unified ExecutionMetadata model */
    executionType?: 'individual' | 'batch' | 'batch_member';
    
    /** NEW: Initial status for execution record */
    status?: 'preparing' | 'pending';

    /** NEW: Starting CSV row index for batch members (1-based, NULL for individual/batch) */
    rowStart?: number;

    /** NEW: Row information for batch operations - string format */
    rows?: string;

    /** NEW: Batch configuration including parallel processing settings */
    batchConfig?: {
        /** #445: the batch's name from Run Batch; kept as batchConfiguration.name */
        name?: string;
        rowsPerTransaction?: number;
        parallelProcessing?: { enabled: boolean; maxConcurrency: number };
        repeatableQueryParam?: RepeatableQueryParam; // GitHub Issue #108
    };

    /** NEW: GitHub Issue #94 - JIT preparation state for batches */
    preparationState?: {
        totalRows: number;
        totalTransactions: number;
        preparedTransactions: number;
        nextCsvRowIndex: number;
        chunkSize: number;
        isComplete: boolean;
    };

    /** GitHub Issue #127: BASE64 encoded body for APIs requiring encoding */
    encodedBody?: string;

    /** GitHub Issue #176: Override execution ID for deterministic batch copy IDs */
    overrideBatchId?: string;
}

/**
 * Result of transaction creation
 */
export interface TransactionCreationResult {
    /** Unique execution ID generated for this transaction */
    executionId: string;
    
    /** Full path to the created request file */
    requestFilePath: string;
    
    /** Generated JSON payload that was saved to request file */
    jsonPayload: any;
}

/**
 * Result of batch initialization
 * GitHub Issue #94 - Chunked just-in-time preparation
 */
export interface BatchInitializationResult {
    /** Batch execution ID */
    batchId: string;

    /** Total number of rows to process */
    totalRows: number;

    /** Chunk size for preparation */
    chunkSize: number;

    /** Whether CSV data was stored (memory or disk) */
    csvDataStored: boolean;

    /** Storage mechanism used */
    storageMechanism?: 'memory' | 'disk';
}

/**
 * Options for batch initialization
 * GitHub Issue #94 - Chunked just-in-time preparation
 */
export interface BatchInitializationOptions {
    /** Batch execution ID */
    batchId: string;

    /** CSV data rows */
    csvData: any[][];

    /** Batch configuration */
    batchConfig: any;

    /** Endpoint configuration */
    endpoint: APIEndpointConfig;

    /** Environment name */
    environment: string;

    /** Environment ID (UUID) */
    environmentId?: string;

    /** Organization identifier */
    organization: string;

    /** Workspace root directory for file operations */
    workspaceRoot: string;

    /** Environment folder (optional - from environment configuration) */
    environmentFolder?: string;
}

/**
 * Service for creating transaction records with request files
 * Extracts and reuses the exact logic from "Run API" individual executions
 */
export interface ITransactionCreator {
    /**
     * Create a transaction (execution record + request file)
     * Uses same logic as individual "Run API" calls for consistency
     */
    createTransaction(options: TransactionCreationOptions): Promise<TransactionCreationResult>;

    // NEW: GitHub Issue #94 - Chunked just-in-time preparation methods

    /**
     * Initialize a batch without preparing transactions upfront
     * Stores CSV data for chunked access during execution
     */
    initializeBatch(options: BatchInitializationOptions): Promise<BatchInitializationResult>;

    /**
     * Prepare next chunk of transactions for a batch
     * GitHub Issue #94 - JIT streaming preparation
     * Returns number of transactions created in this chunk
     */
    prepareNextChunk(batchId: string): Promise<number>;

    /**
     * Cancel ongoing batch preparation
     * GitHub Issue #94 - Signal JIT preparation to stop
     */
    cancelBatchPreparation(batchId: string): void;

    /**
     * Check if batch has more rows to prepare
     */
    hasMoreRows(batchId: string): Promise<boolean>;

    /**
     * Get current preparation state for a batch
     */
    getPreparationState(batchId: string): Promise<{
        totalRows: number;
        preparedRows: number;
        nextRowIndex: number;
    }>;

    /**
     * Cleanup batch data after execution completes
     */
    cleanupBatch(batchId: string): Promise<void>;
}