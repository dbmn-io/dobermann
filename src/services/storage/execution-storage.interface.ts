// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata, ExecutionFilters, TableOptions, ExecutionTableResult, ExecutionStats } from '../../storage/execution-metadata';
import { ExecutionLinkInput, ExecutionLinks } from '../chain/chain-types';

/**
 * Interface for execution metadata storage
 * Abstracts the underlying storage mechanism (JSON files, SQLite, etc.)
 *
 * GitHub Issue #102: SQLite migration for performance and reliability
 */
/** Issue #312: one member of a batch, as the Console open path needs it. */
export interface BatchMemberFile {
    id: string;
    status: string;
    responseFile?: string;
    createdAt: Date;
    /** #428: why it is an error, and whether a response test decided it */
    errorMessage?: string;
    testStatus?: string;
}

/**
 * Dobermann issue 7: a batch's request as the Logs screen shows it, one line each: only the columns
 * the line needs, read a slice at a time, so reading thousands never holds the page up.
 */
export interface BatchMemberLogRow {
    id: string;
    status: string;
    environment?: string;
    endpointMethod?: string;
    endpointPath?: string;
    rows?: string;
    startedAt?: Date;
    completedAt?: Date;
    httpStatus?: number;
    httpStatusText?: string;
    errorMessage?: string;
}

export interface IExecutionStorage {
    /**
     * Initialize the storage (create DB, load data, etc.)
     */
    initialize(): Promise<void>;

    /**
     * Create a new execution record
     * @param metadata - Execution metadata without ID
     * @returns Generated execution ID
     */
    createExecution(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string>;

    /**
     * Update an existing execution record
     * @param id - Execution ID
     * @param updates - Partial updates to apply
     */
    updateExecution(id: string, updates: Partial<ExecutionMetadata>): Promise<void>;

    /**
     * Bulk update multiple execution records
     * GitHub Issue #67: Prevent file corruption with batched writes
     * @param updates - Array of execution updates
     */
    bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void>;

    /**
     * Get a single execution by ID
     * @param id - Execution ID
     * @returns Execution metadata or null if not found
     */
    getExecution(id: string): Promise<ExecutionMetadata | null>;

    /**
     * Get all executions with optional filters
     * @param filters - Optional filters to apply
     * @returns Array of execution metadata
     */
    getExecutions(filters?: ExecutionFilters): Promise<ExecutionMetadata[]>;

    /**
     * Get paginated table of executions
     * @param options - Pagination and sorting options
     * @returns Paginated execution results
     */
    getExecutionTable(options?: TableOptions): Promise<ExecutionTableResult>;

    /**
     * Get execution statistics (counts by status)
     * @returns Execution statistics
     */
    getExecutionStats(): Promise<ExecutionStats>;

    /**
     * Delete an execution record
     * @param id - Execution ID
     */
    deleteExecution(id: string): Promise<void>;

    /**
     * Delete multiple execution records in a single transaction
     * (GitHub Issue #246: bulk delete from Hub transactions tab)
     * @param ids - Execution IDs to delete
     * @returns Number of rows deleted
     */
    deleteExecutions(ids: string[]): Promise<number>;

    /**
     * Search executions where the request/response body contains the term.
     * Restricts the scan to the candidate id set so it stays bounded
     * (GitHub Issue #246: content search for Hub transactions tab).
     * @param ids - Candidate execution IDs to search within
     * @param term - Substring to look for (case-insensitive)
     * @returns IDs of executions whose request OR response body contains the term
     */
    searchExecutionBodies(ids: string[], term: string): Promise<string[]>;

    // Batch-specific methods

    /**
     * Create a new batch execution
     * @param metadata - Batch metadata without batchId
     * @returns Generated batch ID
     */
    createBatch(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string>;

    /**
     * Update a batch execution
     * @param batchId - Batch ID
     * @param updates - Partial updates to apply
     */
    updateBatch(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void>;

    /**
     * Get a batch execution by ID
     * @param batchId - Batch ID
     * @returns Batch metadata or null if not found
     */
    getBatchExecution(batchId: string): Promise<ExecutionMetadata | null>;

    /**
     * Delete a batch and all its members
     * @param batchId - Batch ID
     */
    deleteBatch(batchId: string): Promise<void>;

    /**
     * Store batch execution (legacy method for compatibility)
     */
    storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }>;

    /**
     * Update batch execution (legacy method for compatibility)
     */
    updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void>;

    // Batch resumption data

    /**
     * Store batch resumption data
     * @param batchId - Batch ID
     * @param resumptionData - Resumption state data
     */
    storeBatchResumptionData(batchId: string, resumptionData: any): Promise<void>;

    /**
     * Get batch resumption data
     * @param batchId - Batch ID
     * @returns Resumption data or null if not found
     */
    getBatchResumptionData(batchId: string): Promise<any | null>;

    // Filtered query methods

    /**
     * Get all individual executions (executionType: 'individual')
     * @returns Array of individual executions
     */
    getIndividualExecutions(): Promise<ExecutionMetadata[]>;

    /**
     * Get all batch executions (executionType: 'batch')
     * @returns Array of batch executions
     */
    getBatchExecutions(): Promise<ExecutionMetadata[]>;

    /**
     * Get all batch member executions for a specific batch
     * @param batchId - Parent batch ID
     * @returns Array of batch member executions
     */
    getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Issue #312: how many members of a batch are in each status — one GROUP BY
     * query. The engine's loops used to load every member row (48,000 of them)
     * as objects just to count them, every 100 ms, which pinned the extension
     * host for as long as a big batch ran.
     */
    countBatchMembersByStatus(batchId: string): Promise<Record<string, number>>;

    /**
     * Issue #312: the little the Console needs about every member to open —
     * id, status, response file, creation time — without mapping whole rows
     * (fromRow parses several JSON columns per row; on 50,000 members that is
     * a second per call, and the open path made two).
     */
    getBatchMemberFiles(batchId: string): Promise<BatchMemberFile[]>;

    /** Dobermann issue 7: `limit` of a batch's requests from `offset`, in the order they were made, with only what a log line needs. */
    getBatchMemberLogRows?(batchId: string, offset: number, limit: number): Promise<BatchMemberLogRow[]>;

    /** GitHub Issue #247: record that one run's rows became another run's input. */
    addExecutionLink(link: ExecutionLinkInput): Promise<string>;

    /** GitHub Issue #247: runs this one came from and runs it fed. */
    getExecutionLinks(executionId: string): Promise<ExecutionLinks>;

    /**
     * Get active queue (pending/running individual and batch executions)
     * Excludes batch_member executions
     * @returns Array of active executions
     */
    getActiveQueue(): Promise<ExecutionMetadata[]>;

    /**
     * Get all transactions (individual + batch + batch_member)
     * Optimized single query for performance
     * @returns Array of all executions
     */
    getAllTransactions(): Promise<ExecutionMetadata[]>;

    /**
     * Get executions by endpoint ID
     * @param endpointId - Endpoint ID
     * @param options - `runsOnly`: its runs (singles and batches), never a batch's requests
     * @returns Array of executions for the endpoint
     */
    getExecutionsByEndpoint(endpointId: string, options?: { runsOnly?: boolean }): Promise<ExecutionMetadata[]>;

    /**
     * Get all batches (alias for getBatchExecutions)
     * @returns Array of batch executions
     */
    getBatches(): Promise<ExecutionMetadata[]>;

    /**
     * Get batch executions for a batch ID (legacy method)
     */
    getBatchExecutions_Legacy(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Atomically claim pending batch members (GitHub Issue #110: Fix duplicate execution race condition)
     * Updates status from 'pending' to 'running' in a single atomic database operation
     * This prevents race conditions where multiple threads claim the same transactions
     *
     * @param batchId - Parent batch ID
     * @param limit - Maximum number of members to claim
     * @returns Array of claimed executions (now marked as 'running')
     */
    claimPendingBatchMembers(batchId: string, limit: number): Promise<ExecutionMetadata[]>;

    /**
     * Bulk-create multiple execution records in a single transaction (GitHub Issue #198)
     * Optimized for pagination: inserts all members in one DB transaction with single disk write
     *
     * @param metadataArray - Array of execution metadata without IDs
     * @returns Array of generated execution IDs
     */
    createExecutionBatch(metadataArray: Array<Omit<ExecutionMetadata, 'id'>>): Promise<string[]>;
}
