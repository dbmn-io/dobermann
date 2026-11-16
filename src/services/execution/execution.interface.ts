// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution result interface
 */
export interface ExecutionResult {
    success: boolean;
    executionId: string;
    duration: number;
    httpStatus?: number;
    httpStatusText?: string;
    requestFile?: string;
    responseFile?: string;
    errorMessage?: string;
    /** #335: Cancel aborted it in flight: neither a success nor a failure. */
    cancelled?: boolean;
}

/**
 * Execution options interface
 */
export interface ExecutionOptions {
    environment?: string;
    organization?: string;
    validateBefore?: boolean;
    timeout?: number;
    abortSignal?: AbortSignal;
    batchId?: string; // Links execution to batch if provided

    // NEW: Unified execution model fields
    executionType?: 'individual' | 'batch' | 'batch_member';
    rowStart?: number; // Starting CSV row index for batch members (1-based)
    rows?: string; // Row information (e.g., "8" for members, "39(300)" for batch)
    /** The member's saved request body couldn't be read (this path): fail it, send nothing. */
    requestContentMissing?: string;
    /** #424: a batch member's base URL, the batch's own, filled when it started (#160); left out, the environment's. */
    baseUrl?: string;
}

/**
 * Interface for ExecutionService - Pure Executor
 * 
 * This interface defines the contract for the pure execution service.
 * This service does NOT create execution records.
 * All creation is handled by TransactionPreparationService.
 */
export interface IExecutionService {
    /**
     * Execute an existing execution record by ID
     * This is the main method - executes records created by TransactionPreparationService
     * 
     * @param executionId - The ID of the execution record to execute
     * @param batchContext - Optional batch context for batch_member executions
     * @returns Promise<ExecutionResult> - The result of the execution
     * @throws Error if execution record not found or not in 'pending' status
     */
    executeRecord(executionId: string, batchContext?: { parentBatch: any; environmentId?: string; memberCount?: number }): Promise<ExecutionResult>;

    /**
     * Cancel a running execution
     * 
     * @param executionId - The ID of the execution to cancel
     */
    cancel(executionId: string): Promise<void>;

    /**
     * Get the current status of an execution
     * 
     * @param executionId - The ID of the execution
     * @returns Promise<string> - The current status ('pending', 'running', 'completed', 'error', 'cancelled')
     * @throws Error if execution not found
     */
    getExecutionStatus(executionId: string): Promise<string>;

    /**
     * Check if an execution is currently running
     * 
     * @param executionId - The ID of the execution
     * @returns Promise<boolean> - True if execution is running
     */
    isExecutionRunning(executionId: string): Promise<boolean>;

    /**
     * Get list of currently running execution IDs
     * 
     * @returns Promise<string[]> - Array of execution IDs that are currently running
     */
    getRunningExecutions(): Promise<string[]>;

    /**
     * Clean up in-memory data for completed executions (memory leak prevention)
     * @param executionIds - Array of execution IDs to clean up
     */
    cleanupExecutionMemory(executionIds: string[]): void;

    /**
     * Legacy execute method for backwards compatibility
     * NOTE: This should not be used in new architecture - use executeRecord() instead
     * @deprecated Use executeRecord() instead
     */
    execute?(endpoint: any, options?: ExecutionOptions): Promise<ExecutionResult>;

    /**
     * Legacy schedule execution method - not used in new architecture
     * @deprecated Use TransactionPreparationService + executeRecord() instead
     */
    scheduleExecution?(endpoint: any, options?: ExecutionOptions, priority?: any): Promise<any>;

    /**
     * Legacy get active execution method - not used in new architecture  
     * @deprecated 
     */
    getActiveExecutionForEndpoint?(endpointId: string): Promise<any>;
}