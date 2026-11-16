// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../../data-loading/types';

/**
 * Context passed to transaction handlers
 * Contains all information needed for transaction creation
 */
export interface TransactionHandlerContext {
    /** Endpoint configuration containing method, path, body, headers */
    endpoint: APIEndpointConfig;
    
    /** Environment name (e.g., 'production', 'staging') */
    environment: string;

    /** Environment ID (UUID) for proper environment lookups */
    environmentId?: string;

    /** Environment folder (optional - from environment configuration) */
    environmentFolder?: string;
    
    /** Organization identifier */
    organization: string;
    
    /** Workspace root directory for file operations */
    workspaceRoot: string;
    
    /** For batch operations: batch ID to link transactions */
    batchId?: string;
    
    /** For batch member operations: CSV row data for this transaction */
    csvRowData?: string[][];
    
    /** For batch operations: index/sequence number */
    transactionIndex?: number;

    /** For batch operations: starting CSV row index (1-based) for this transaction */
    rowStart?: number;

    /** GitHub Issue #181: For batch operations with pre-generated JSON, explicit row count (overrides csvRowData.length) */
    rows?: string;

    /** For batch operations: column mappings from CSV upload Step 3 (GitHub Issue #48) */
    columnMappings?: Record<string, string>;

    /** GitHub Issue #108: Query parameters for this transaction (e.g., computed from repeatable query param) */
    queryParams?: Record<string, string>;

    /** GitHub Issue #119: Pre-generated JSON from generateBatchJsonFiles() for unified nested array handling */
    preGeneratedJson?: any;

    /** Optional custom batch name for CSV filename */
    batchName?: string;

    /** Batch configuration including parallel processing settings */
    batchConfig?: {
        rowsPerTransaction?: number;
        parallelProcessing?: { enabled: boolean; maxConcurrency: number };
    };

    /** GitHub Issue #176: Override batch ID for deterministic copy IDs */
    overrideBatchId?: string;

    /** GitHub Issue #145: User-provided parameters for Run API (treated as single CSV row) */
    userParameters?: Record<string, any>;
}

/**
 * Result from transaction handler
 * Contains execution ID and file information
 */
export interface TransactionHandlerResult {
    /** Unique execution ID generated for this transaction */
    executionId: string;
    
    /** Full path to the created request file */
    requestFilePath: string;
    
    /** Generated JSON payload that was saved to request file */
    jsonPayload: any;
    
    /** Directory path where the file was created */
    directoryPath: string;
    
    /** Simple filename (without path) */
    fileName: string;
}

/**
 * Base interface for all transaction handlers
 * Implements the handler pattern for different execution types
 */
export interface ITransactionHandler {
    /**
     * Create a transaction (execution record + request file)
     * Each handler type implements this differently:
     * - IndividualHandler: Creates single transaction
     * - BatchHandler: Creates batch parent with CSV
     * - BatchMemberHandler: Creates member transaction with row data
     */
    createTransaction(context: TransactionHandlerContext): Promise<TransactionHandlerResult>;
}