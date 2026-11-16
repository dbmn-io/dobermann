// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata } from '../../storage/execution-metadata';

/**
 * Execution engine types supported by the coordinator
 */
export type ExecutionEngineType = 'individual' | 'batch';

/**
 * Priority levels for execution coordination
 * Individual executions have higher priority and can interrupt batch
 */
export enum ExecutionPriority {
    HIGH = 'high',      // Individual executions - can interrupt batch
    NORMAL = 'normal'   // Batch executions - sequential processing
}

/**
 * Individual execution state tracked by coordinator
 */
export interface TrackedExecutionState {
    /** Execution ID */
    executionId: string;
    /** Execution type */
    executionType: ExecutionEngineType;
    /** Current status */
    status: string;
    /** Full execution metadata */
    metadata: ExecutionMetadata;
    /** When this execution started */
    startedAt: Date;
    /** When this execution was last updated */
    lastUpdated: Date;
}

/**
 * Global execution state tracked by coordinator (centralized management only)
 */
export interface ExecutionCoordinatorState {
    /** Map of all currently tracked executions for centralized status bar */
    activeExecutions: Map<string, TrackedExecutionState>;
    /** Current batch execution ID (if any) for status bar coordination */
    activeBatchId: string | null;
    /** Current individual executions for status bar coordination */
    activeIndividualIds: string[];
}

/**
 * Configuration for execution engines
 */
export interface ExecutionEngineConfig {
    /** Maximum concurrent executions (always 1 for coordinator pattern) */
    maxConcurrent: number;
    /** Whether this engine can be interrupted by higher priority */
    canBeInterrupted: boolean;
    /** Default timeout for executions */
    defaultTimeout: number;
    /** Retry configuration */
    retryPolicy: {
        maxRetries: number;
        backoffMs: number;
    };
}

/**
 * Result from coordination operations
 */
export interface CoordinationResult {
    /** Whether the operation was successful */
    success: boolean;
    /** The execution ID that was processed */
    executionId: string;
    /** Action taken by coordinator */
    action: 'queued' | 'started' | 'interrupted' | 'resumed' | 'completed' | 'failed';
    /** Position in queue (if queued) */
    queuePosition?: number;
    /** Error message if operation failed */
    errorMessage?: string;
}

/**
 * Execution Coordinator Interface
 * 
 * Manages global execution state to ensure only one execution runs at a time.
 * Handles priority-based interruption (individual can interrupt batch).
 * Coordinates between different execution engines.
 */
export interface IExecutionCoordinator {

    /**
     * Notify coordinator that an execution has completed
     * @param executionId - The completed execution ID
     * @returns Promise<void>
     */
    completeExecution(executionId: string): Promise<void>;

    /**
     * Cancel a specific execution (remove from queue or interrupt if running)
     * @param executionId - The execution to cancel
     * @returns Promise<CoordinationResult>
     */
    cancelExecution(executionId: string): Promise<CoordinationResult>;

    /**
     * Get current coordination state
     * @returns Promise<ExecutionCoordinatorState>
     */
    getState(): Promise<ExecutionCoordinatorState>;

    /**
     * Update execution state and trigger status bar updates
     * @param executionId - The execution being updated
     * @param metadata - Current execution metadata
     * @returns Promise<void>
     */
    updateExecutionState(executionId: string, metadata: ExecutionMetadata): Promise<void>;

    /**
     * Remove execution from tracking (when completed/cancelled)
     * @param executionId - The execution to stop tracking
     * @returns Promise<void>
     */
    removeExecution(executionId: string): Promise<void>;

    /**
     * Get queue position for a specific execution
     * @param executionId - The execution to check
     * @returns Promise<number | null> - Position in queue or null if not queued
     */
    getQueuePosition(executionId: string): Promise<number | null>;

    /**
     * Check if system can accept new executions
     * @returns Promise<boolean>
     */
    canAcceptExecution(): Promise<boolean>;


    /**
     * Get execution engine configuration
     * @param engineType - The engine type to get config for
     * @returns ExecutionEngineConfig
     */
    getEngineConfig(engineType: ExecutionEngineType): ExecutionEngineConfig;
}