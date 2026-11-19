// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionOptions } from './execution.interface';
import { ExecutionMetadata, ExecutionStatus } from '../../storage/execution-metadata';
import type { BatchMemberLogRow } from '../storage/execution-storage.interface';
import { BatchResumptionData } from '../../storage/execution-metadata';

// Table pagination options
export interface ExecutionTableOptions {
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    filters?: Record<string, any>;
}

// Table result interface
export interface ExecutionTableResult {
    executions: ExecutionMetadata[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

// Statistics interface
export interface ExecutionStats {
    total: number;
    completed: number;
    pending: number;
    running: number;
    error: number;
    cancelled: number;
}

// Execution results interface
export interface ExecutionResults {
    httpStatus?: number;
    httpStatusText?: string;
    runTime?: number;
    completedAt?: Date;
    requestFile?: string;
    responseFile?: string;
    errorMessage?: string;
}

// Event emitter interface
export interface ExecutionChangedEvent {
    event: (listener: (execution: ExecutionMetadata) => void) => void;
    fire: (execution: ExecutionMetadata) => void;
}

// Main interface for execution metadata service
export interface IExecutionMetadataService {
    /**
     * Initialize the metadata service
     * @returns Promise that resolves when initialization is complete
     */
    initialize(): Promise<void>;

    /**
     * Create a new execution metadata entry
     * @param endpoint - The API endpoint configuration
     * @param options - Execution options
     * @returns Promise resolving to the execution ID
     */
    createExecution(endpoint: APIEndpointConfig, options?: ExecutionOptions): Promise<string>;

    /**
     * Update execution metadata
     * @param executionId - The execution ID to update
     * @param updates - The updates to apply
     * @returns Promise that resolves when update is complete
     */
    updateExecution(executionId: string, updates: Partial<ExecutionMetadata>): Promise<void>;

    /**
     * Update execution status
     * @param executionId - The execution ID to update
     * @param status - The new status
     * @returns Promise that resolves when update is complete
     */
    updateExecutionStatus(executionId: string, status: ExecutionStatus): Promise<void>;

    /**
     * Update execution results
     * @param executionId - The execution ID to update
     * @param results - The execution results
     * @returns Promise that resolves when update is complete
     */
    updateExecutionResults(executionId: string, results: ExecutionResults): Promise<void>;

    /**
     * Bulk update multiple executions (GitHub Issue #67 - prevent corruption)
     * @param updates - Array of execution updates to apply
     * @returns Promise that resolves when all updates are complete
     */
    bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void>;

    /**
     * Get execution metadata by ID
     * @param executionId - The execution ID
     * @returns Promise resolving to execution metadata or null if not found
     */
    getExecution(executionId: string): Promise<ExecutionMetadata | null>;

    /**
     * Delete execution metadata
     * @param executionId - The execution ID to delete
     * @returns Promise resolving to true if deleted, false if not found
     */
    deleteExecution(executionId: string): Promise<boolean>;

    /**
     * Delete many execution records in a single transaction
     * (GitHub Issue #246: bulk delete from Hub transactions tab).
     * @param ids - Execution IDs to delete (deduped + bounded by the impl)
     * @returns Number of rows deleted (includes cascaded batch members)
     */
    deleteExecutions(ids: string[]): Promise<number>;

    /**
     * Search request/response bodies of the given executions for `term`.
     * Bodies are file-backed; this reads them off disk with bounded
     * concurrency. Caller must constrain `ids` to a sane working set.
     * @returns IDs whose request or response body contains `term`
     */
    searchExecutionBodies(ids: string[], term: string): Promise<string[]>;

    /**
     * Delete a batch and all its member executions in a single query
     * @param batchId - The batch ID to delete
     * @returns Promise resolving to true if deleted, false on failure
     */
    deleteBatch(batchId: string): Promise<boolean>;

    /**
     * Get paginated execution table
     * @param options - Table options for pagination and sorting
     * @returns Promise resolving to execution table result
     */
    getExecutionTable(options?: ExecutionTableOptions): Promise<ExecutionTableResult>;

    /**
     * Get execution statistics
     * @returns Promise resolving to execution statistics
     */
    getExecutionStats(): Promise<ExecutionStats>;

    /**
     * Event emitter for execution changes
     */
    onExecutionChanged: ExecutionChangedEvent;

    /**
     * Store batch execution metadata (unified model)
     * @param batchExecution - The batch execution metadata to store
     * @returns Promise resolving to success result
     */
    storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }>;

    /**
     * Get active queue executions (unified approach)
     * Returns both individual and batch executions with active status
     * Excludes batch_member executions (managed by BatchExecutionEngine)
     * @returns Promise resolving to active executions sorted by type then date
     */
    getActiveQueue(): Promise<ExecutionMetadata[]>;

    /**
     * Get batch execution by ID
     * @param batchId - The batch ID
     * @returns Promise resolving to batch execution or null if not found
     */
    getBatchExecution(batchId: string): Promise<ExecutionMetadata | null>;

    /**
     * Update batch execution
     * @param batchId - The batch ID to update
     * @param updates - The updates to apply
     * @returns Promise resolving to success result
     */
    updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<{ success: boolean; errorMessage?: string }>;

    /**
     * Get executions for a specific batch
     * @param batchId - The batch ID
     * @returns Promise resolving to array of execution metadata
     */
    getBatchExecutions(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Get executions for a specific batch (alias for getBatchExecutions)
     * @param batchId - The batch ID
     * @returns Promise resolving to array of execution metadata
     */
    getExecutionsByBatch(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Store batch resumption data
     * @param batchId - The batch ID
     * @param resumptionData - The resumption data to store
     * @returns Promise resolving to success result
     */
    storeBatchResumptionData(batchId: string, resumptionData: BatchResumptionData): Promise<{ success: boolean; errorMessage?: string }>;

    /**
     * Get batch resumption data
     * @param batchId - The batch ID
     * @returns Promise resolving to resumption data or null if not found
     */
    getBatchResumptionData(batchId: string): Promise<BatchResumptionData | null>;

    /**
     * Get all batches
     * @returns Promise resolving to array of batch metadata
     */
    getBatches(): Promise<any[]>;

    /**
     * Get executions for a specific endpoint
     * @param endpointId - The endpoint ID
     * @returns Promise resolving to array of execution metadata
     */
    getExecutionsByEndpoint(endpointId: string): Promise<ExecutionMetadata[]>;

    /**
     * Get unified execution history combining both batches and individual executions
     * Sorted by completion time in descending order (most recent first)
     * @returns Promise resolving to array of unified execution items
     */
    getUnifiedExecutionHistory(): Promise<Array<ExecutionMetadata & { isBatch?: boolean, batchId?: string }>>;

    /**
     * Get individual executions (non-batch executions)
     * Sorted by completion date (newest first)
     * @deprecated Use getActiveQueue() for active executions and getUnifiedExecutionHistory() for history
     * @returns Promise resolving to array of individual execution metadata
     */
    getIndividualExecutions(): Promise<ExecutionMetadata[]>;

    /**
     * Get batch executions (batch metadata as execution records)
     * Sorted by completion date (newest first)
     * @deprecated Use getActiveQueue() for active executions and getUnifiedExecutionHistory() for history
     * @returns Promise resolving to array of batch execution metadata
     */
    getBatchExecutions(): Promise<ExecutionMetadata[]>;

    /**
     * Get batch member executions for a specific batch
     * Sorted by creation order
     * @param batchId - The batch ID
     * @returns Promise resolving to array of batch member execution metadata
     */
    getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]>;

    /** Issue #312: members of a batch counted per status, without loading them. */
    countBatchMembersByStatus(batchId: string): Promise<Record<string, number>>;

    /** Issue #312: id / status / response file / created time per member, without whole rows. */
    getBatchMemberFiles(batchId: string): Promise<Array<{ id: string; status: string; responseFile?: string; createdAt: Date; errorMessage?: string; testStatus?: string }>>;

    /** Dobermann issue 7: `limit` of a batch's requests from `offset`, only what a log line needs. */
    getBatchMemberLogRows?(batchId: string, offset: number, limit: number): Promise<BatchMemberLogRow[]>;

    /**
     * Get all transactions (active + completed) in a single call
     * Combines active queue with unified execution history
     * Sorted by createdAt (newest first) for consistent chronological ordering
     * @returns Promise resolving to all execution metadata
     */
    getAllTransactions(): Promise<ExecutionMetadata[]>;

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