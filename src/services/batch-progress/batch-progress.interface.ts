// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata } from '../../storage/execution-metadata';

/**
 * Batch progress information
 * 
 * Following Architecture.md patterns:
 * - Backend provides raw data (times in milliseconds, percentages)
 * - Frontend handles all display formatting
 * - progressText is deprecated - frontend should format display
 */
export interface BatchProgress {
  batchId: string;
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  skippedExecutions: number;
  pendingExecutions: number;
  currentExecutionIndex: number;
  completionPercentage: number;
  estimatedRemainingTime: number; // milliseconds - frontend formats to "5m 30s"
  estimatedCompletionTime: Date;
  progressText: string; // @deprecated - frontend should format display text
  averageExecutionTime: number; // milliseconds - calculated from current batch
  elapsedTime: number; // milliseconds since batch started
  isPaused: boolean;
  isComplete: boolean;
}

/**
 * Individual execution progress within a batch
 */
export interface ExecutionProgress {
  executionId: string;
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled' | 'skipped';
  startTime?: Date;
  endTime?: Date;
  duration?: number; // milliseconds
  estimatedDuration?: number; // milliseconds
  progressPercentage?: number; // 0-100 for running executions
}

/**
 * Batch progress service interface for Phase 4 progress tracking
 */
export interface IBatchProgressService {
  /**
   * Calculate current progress for a batch
   * @param batch - The batch metadata
   * @returns Current batch progress information
   */
  calculateBatchProgress(batch: ExecutionMetadata): Promise<BatchProgress>;

  /**
   * Get progress for a specific execution within a batch
   * @param executionId - The execution identifier
   * @param batchId - The batch identifier
   * @returns Execution progress information
   */
  getExecutionProgress(executionId: string, batchId: string): Promise<ExecutionProgress>;

  /**
   * Update progress when an execution starts
   * @param executionId - The execution identifier
   * @param batchId - The batch identifier
   */
  startExecution(executionId: string, batchId: string): Promise<void>;

  /**
   * Update progress when an execution completes
   * @param executionId - The execution identifier
   * @param batchId - The batch identifier
   * @param execution - The completed execution metadata
   */
  completeExecution(executionId: string, batchId: string, execution: ExecutionMetadata): Promise<void>;

  /**
   * Update progress when an execution fails
   * @param executionId - The execution identifier
   * @param batchId - The batch identifier
   * @param execution - The failed execution metadata
   */
  failExecution(executionId: string, batchId: string, execution: ExecutionMetadata): Promise<void>;

  /**
   * Update progress when batch is paused
   * @param batchId - The batch identifier
   */
  pauseBatch(batchId: string): Promise<void>;

  /**
   * Update progress when batch is resumed
   * @param batchId - The batch identifier
   */
  resumeBatch(batchId: string): Promise<void>;

  /**
   * Clear progress data for a completed batch
   * @param batchId - The batch identifier
   */
  clearBatchProgress(batchId: string): Promise<void>;

  /**
   * Get all active batch progress data
   * @returns Array of batch progress for all active batches
   */
  getActiveBatches(): Promise<BatchProgress[]>;

  /**
   * Format batch progress into display string
   * @param progress - The batch progress
   * @returns Formatted string like "Batch 3/10 running - Est. 5m 30s remaining"
   */
  formatProgressText(progress: BatchProgress): string;
}