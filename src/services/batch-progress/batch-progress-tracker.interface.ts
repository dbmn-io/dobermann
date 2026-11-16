// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Interface for tracking batch execution progress in real-time
 * Provides lightweight progress tracking without triggering UI events
 */
export interface IBatchProgressTracker {
  /**
   * Update progress for a batch when a member completes
   * @param batchId - The batch ID
   * @param executionId - The batch member execution ID that completed
   * @param status - The completion status
   */
  updateBatchMemberProgress(batchId: string, executionId: string, status: string): void;

  /**
   * Get current progress for a batch
   * @param batchId - The batch ID
   * @returns Progress info like { completed: 5, total: 10, percentage: 50 }
   */
  getBatchProgress(batchId: string): BatchProgress | undefined;

  /**
   * Initialize batch tracking when batch starts
   * @param batchId - The batch ID
   * @param totalMembers - Total number of batch members
   */
  initializeBatch(batchId: string, totalMembers: number): void;

  /**
   * Remove batch tracking when batch is complete
   * @param batchId - The batch ID
   */
  removeBatch(batchId: string): void;

  /**
   * Get all active batch IDs
   */
  getActiveBatchIds(): string[];
}

export interface BatchProgress {
  batchId: string;
  completed: number;
  failed: number;
  total: number;
  percentage: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}