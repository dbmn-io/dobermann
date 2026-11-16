// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { ExecutionPriority } from '../../types/execution-state';

/**
 * Response from scheduling an execution or batch
 */
export interface ScheduleExecutionResponse {
    executionId: string;
    status: 'running' | 'queued' | 'completed' | 'error';
    queuePosition?: number;
    estimatedWait?: string;
    execution: ExecutionMetadata;
}

/**
 * Response from scheduling a batch
 */
export interface ScheduleBatchResponse {
    batchId: string;
    status: 'running' | 'queued' | 'completed' | 'error';
    queuePosition?: number;
    estimatedWait?: string;
    batchMetadata: ExecutionMetadata;
    transactionCount: number;
}

/**
 * Queue status information
 */
export interface QueueStatus {
    totalItems: number;
    urgentItems: number;
    highItems: number;
    normalItems: number;
    lowItems: number;
    isProcessing: boolean;
    currentExecution?: {
        executionId: string;
        type: 'individual' | 'batch';
        progress?: number;
        estimatedCompletion?: string;
    };
    queuedItems: Array<{
        executionId: string;
        type: 'individual' | 'batch';
        priority: ExecutionPriority;
        queuedAt: Date;
        estimatedStart?: string;
    }>;
}

/**
 * Batch operation result
 */
export interface BatchOperationResult {
    success: boolean;
    batchId: string;
    previousState?: string;
    newState?: string;
    errorMessage?: string;
}

/**
 * ExecutionEngine manages the unified execution queue and processing
 * of both individual transactions and batch operations
 */
export interface IExecutionEngine {
    /**
     * Start the execution engine
     * Begins processing pending transactions from the queue
     * @returns Promise<void>
     */
    start(): Promise<void>;

    /**
     * Stop the execution engine gracefully
     * Completes current transaction then stops
     * @returns Promise<void>
     */
    stop(): Promise<void>;

    /**
     * Check if the engine is currently running
     * @returns Promise<boolean>
     */
    isRunning(): Promise<boolean>;

    /**
     * Check if the engine is idle (no active executions)
     * @returns Promise<boolean>
     */
    isIdle(): Promise<boolean>;

    /**
     * Schedule an individual execution
     * @param executionId - The execution ID to schedule
     * @param priority - Priority level (defaults to URGENT for individual)
     * @returns Promise<ScheduleExecutionResponse>
     */
    scheduleExecution(executionId: string, priority?: ExecutionPriority): Promise<ScheduleExecutionResponse>;

    /**
     * Schedule a batch for execution
     * @param batchId - The batch ID to schedule
     * @param priority - Priority level (defaults to NORMAL for batch)
     * @returns Promise<ScheduleBatchResponse>
     */
    scheduleBatch(batchId: string, priority?: ExecutionPriority): Promise<ScheduleBatchResponse>;

    /**
     * Cancel an execution or batch
     * @param executionId - The execution/batch ID to cancel
     * @returns Promise<void>
     */
    cancel(executionId: string): Promise<void>;

    /**
     * Pause a batch execution
     * @param batchId - The batch ID to pause
     * @returns Promise<BatchOperationResult>
     */
    pauseBatch(batchId: string): Promise<BatchOperationResult>;

    /**
     * Resume a paused batch execution
     * @param batchId - The batch ID to resume
     * @returns Promise<BatchOperationResult>
     */
    resumeBatch(batchId: string): Promise<BatchOperationResult>;

    /**
     * Cancel an entire batch
     * @param batchId - The batch ID to cancel
     * @returns Promise<BatchOperationResult>
     */
    cancelBatch(batchId: string): Promise<BatchOperationResult>;

    /**
     * Get current queue status
     * @returns Promise<QueueStatus>
     */
    getQueueStatus(): Promise<QueueStatus>;

    /**
     * Get queue position for a specific execution
     * @param executionId - The execution ID
     * @returns Promise<number> - Position in queue (0 if not found)
     */
    getQueuePosition(executionId: string): Promise<number>;

    /**
     * Get execution details by ID
     * @param executionId - The execution ID
     * @returns Promise<ExecutionMetadata | null>
     */
    getExecutionDetails(executionId: string): Promise<ExecutionMetadata | null>;

    /**
     * Prioritize an execution (move to front of queue)
     * @param executionId - The execution ID to prioritize
     * @returns Promise<ScheduleExecutionResponse>
     */
    prioritizeExecution(executionId: string): Promise<ScheduleExecutionResponse>;

    /**
     * Get all executions for a specific endpoint
     * @param endpointId - The endpoint ID
     * @returns Promise<ExecutionMetadata[]>
     */
    getExecutionsForEndpoint(endpointId: string): Promise<ExecutionMetadata[]>;

    /**
     * Get active execution for a specific endpoint
     * @param endpointId - The endpoint ID
     * @returns Promise<ExecutionMetadata | null>
     */
    getActiveExecutionForEndpoint(endpointId: string): Promise<ExecutionMetadata | null>;

    /**
     * Event emitter for execution state changes
     * Other services can subscribe to these events
     */
    onExecutionStateChanged: (callback: (event: ExecutionStateChangeEvent) => void) => void;
}

/**
 * Event emitted when execution state changes
 */
export interface ExecutionStateChangeEvent {
    executionId: string;
    previousState: string;
    newState: string;
    timestamp: Date;
    execution: ExecutionMetadata;
    result?: any;
    batchId?: string;
    isIndividual: boolean;
    isBatch: boolean;
}

/**
 * ExecutionEngine dependencies
 */
export interface ExecutionEngineDependencies {
    executionMetadataService: any; // IExecutionMetadataService for metadata operations
    executionQueueManager: any; // IExecutionQueueManagerService for queue operations
    dobermannInstance: any; // For API calls
    executionFileService?: any; // IExecutionFileService for file creation (optional to avoid circular dependency)
    // Optional services for UI updates
    timeEstimationService?: any;
    batchProgressService?: any;
}