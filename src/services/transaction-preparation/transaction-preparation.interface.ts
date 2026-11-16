// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionMetadata } from '../../storage/execution-metadata';

/**
 * Input for unified transaction preparation service
 * Replaces separate configurations for individual and batch operations
 */
export interface TransactionPreparationInput {
    /** Endpoint configuration containing method, path, body, headers */
    endpoint: APIEndpointConfig;
    
    /** Environment name (e.g., 'production', 'staging') */
    environment: string;

    /** Environment ID (UUID) for proper environment lookups */
    environmentId?: string;
    
    /** Environment folder (optional - from environment configuration) */
    environmentFolder?: string;
    
    /** The environment's `org` variable, recorded with the run (optional) */
    organization?: string;
    
    /** Workspace root directory for file operations */
    workspaceRoot: string;
    
    /** For batch operations: CSV data as 2D array */
    csvData?: string[][];
    
    /** For batch operations: Column mappings for template substitution */
    columnMappings?: Record<string, string>;
    
    /** For batch operations: Configuration options */
    batchConfig?: {
        /** Stop processing if any transaction fails */
        stopOnError?: boolean;
        /** Number of rows to group per transaction (array repetition) */
        rowsPerTransaction?: number;
        /** Parallel processing configuration */
        parallelProcessing?: { enabled: boolean; maxConcurrency: number };
        /** GitHub Issue #94: Chunked just-in-time preparation settings */
        chunkedPreparation?: { enabled: boolean; chunkSize: number };
        /** GitHub Issue #108: Query parameter repetition configuration */
        repeatableQueryParam?: { enabled: boolean; paramKey: string; pattern: string; separator: string; maxUrlLength: number; maxPerRequest?: number };
    };
    
    /** Optional custom batch name for CSV filename */
    batchName?: string;

    /** GitHub Issue #150: Pre-calculated total transactions from Step 3 preview (single source of truth) */
    preCalculatedTransactions?: number;

    /** GitHub Issue #94: Pagination configuration for paginated API calls */
    paginationConfig?: {
        enabled: boolean;
        /** GitHub Issue #245: where the page template lives ('query' default for back-compat) */
        location?: 'query' | 'body';
        paramKey: string;
        startValue: number;
        totalCountPath?: string;
        templateVariable: string;
    };

    /** GitHub Issue #145: User-provided parameters for Run API (treated as single CSV row) */
    userParameters?: Record<string, any>;

    /** GitHub Issue #165: Environment variables for {{ENV:varName}} template substitution */
    environmentVariables?: Record<string, string>;

    /** #424/#160: the environment's base URL with its variables filled, kept on the batch: its members go there, whatever changes after */
    baseUrl?: string;

    /** GitHub Issue #176: Override batch ID for deterministic copy IDs (e.g., {originalId}_v2) */
    overrideBatchId?: string;
}

/**
 * Result from transaction preparation service
 * Contains execution IDs, file paths, and status information
 */
export interface TransactionPreparationResult {
    /** For individual transactions: the execution ID */
    executionId?: string;
    
    /** For batch operations: the batch ID */
    batchId?: string;
    
    /** For batch operations: array of member transaction IDs */
    transactionIds?: string[];
    
    /** File paths created during preparation */
    filePaths: {
        /** Request file for individual, or CSV file for batch parent */
        request: string;
        /** For batch: path to CSV input file */
        csv?: string;
        /** For batch: directory containing all member files */
        batchDirectory?: string;
    };
    
    /** Number of transactions created (1 for individual, N for batch) */
    transactionCount: number;
    
    /** Current status after preparation */
    status: 'preparing' | 'pending';
    
    /** Array repetition analysis for batch operations */
    arrayAnalysis?: {
        totalRows: number;
        rowsPerTransaction: number;
        transactionCount: number;
        hasArrayFields: boolean;
    };
}

/**
 * Options for transaction preparation operations
 */
export interface TransactionPreparationOptions {
    /** Override default file naming patterns */
    fileNaming?: {
        prefix?: string;
        includeTimestamp?: boolean;
    };
    
    /** Override default directory structure */
    directoryOverride?: string;
    
    /** Skip validation steps (for testing) */
    skipValidation?: boolean;
    
    /** Progress reporter for long-running batch preparation */
    progress?: {
        report(update: { message?: string; increment?: number }): void;
    };
}

/**
 * Unified service for preparing all types of transactions
 * Follows the Transaction Preparation Architecture requirements
 */
export interface ITransactionPreparationService {
    /**
     * Prepare a single individual transaction
     * Creates execution metadata and request file
     * Status flow: preparing → pending
     */
    prepareIndividualTransaction(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult>;
    
    /**
     * Prepare batch transactions with atomic activation
     * Creates batch parent, member transactions, and all files
     * Status flow: preparing → pending (atomic for all transactions)
     */
    prepareBatchTransactions(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult>;

    /**
     * Prepare paginated batch (GitHub Issue #94)
     * Creates batch parent with pagination metadata and one batch_member for first page
     * Status flow: preparing → pending
     */
    preparePaginatedBatch(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult>;
}