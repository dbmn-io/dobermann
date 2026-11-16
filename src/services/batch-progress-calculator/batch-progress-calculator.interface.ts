// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { BatchState } from '../../types/execution-state';

/**
 * Calculated batch progress information derived from execution records
 */
export interface BatchProgressInfo {
    batchId: string;
    state: BatchState;
    
    // Counts from storage
    csvRows: number;
    totalExecutions: number;
    
    // Calculated progress
    pendingExecutions: number;
    runningExecutions: number;
    completedExecutions: number;
    errorExecutions: number;
    cancelledExecutions: number;
    skippedExecutions: number;
    warningExecutions: number;
    
    // Progress percentages
    progressPercent: number;
    successPercent: number;
    errorPercent: number;
    
    // Timing information (derived from execution records)
    averageExecutionTime?: number;
    estimatedTimeRemaining?: number;
    
    // Status summary
    hasErrors: boolean;
    hasWarnings: boolean;
    isCompleted: boolean;
    isPaused: boolean;
    isCancelled: boolean;
}

/**
 * Interface for calculating batch progress from execution records
 */
export interface IBatchProgressCalculator {
    /**
     * Calculate comprehensive batch progress from stored metadata and execution records
     */
    calculateProgress(
        batchMetadata: ExecutionMetadata, 
        executions: ExecutionMetadata[]
    ): BatchProgressInfo;
    
    /**
     * Determine what the batch state should be based on execution states
     */
    calculateBatchState(executions: ExecutionMetadata[], currentState: BatchState): BatchState;
    
    /**
     * Get a human-readable progress summary
     */
    getProgressSummary(progress: BatchProgressInfo): string;
}