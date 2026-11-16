// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionPriority, ExecutionQueueItem } from '../../types/execution-state';

/**
 * Result of adding execution to queue
 */
export interface QueueAddResult {
    success: boolean;
    queuePosition?: number;
    priority?: ExecutionPriority;
    errorMessage?: string;
}

/**
 * Result of removing execution from queue
 */
export interface QueueRemoveResult {
    success: boolean;
    removedFromPosition?: number;
    errorMessage?: string;
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
}

/**
 * Result of batch operations
 */
export interface BatchOperationResult {
    success: boolean;
    errorMessage?: string;
}

/**
 * Service for managing execution queue with priority handling
 */
export interface IExecutionQueueManagerService {
    /**
     * Add execution to queue with specified priority
     */
    addToQueue(executionId: string, priority: ExecutionPriority): Promise<QueueAddResult>;

    /**
     * Remove execution from queue
     */
    removeFromQueue(executionId: string): Promise<QueueRemoveResult>;

    /**
     * Get next execution from queue (highest priority first)
     */
    getNextExecution(): Promise<ExecutionQueueItem | null>;

    /**
     * Get current queue status
     */
    getQueueStatus(): Promise<QueueStatus>;

    /**
     * Pause batch execution (for individual execution priority)
     */
    pauseBatch(batchId: string): Promise<BatchOperationResult>;

    /**
     * Resume batch execution
     */
    resumeBatch(batchId: string): Promise<BatchOperationResult>;

    /**
     * Clear all items from queue
     */
    clearQueue(): Promise<void>;

    /**
     * Get queue position for specific execution
     */
    getQueuePosition(executionId: string): Promise<number>;

    /**
     * Prioritize execution (move to front of queue)
     */
    prioritizeExecution(executionId: string): Promise<QueueAddResult>;

    /**
     * Set processing state
     */
    setProcessing(isProcessing: boolean): void;
}