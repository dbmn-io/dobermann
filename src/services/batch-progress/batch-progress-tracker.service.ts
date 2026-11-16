// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IBatchProgressTracker, BatchProgress } from './batch-progress-tracker.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

/**
 * Lightweight batch progress tracker for real-time progress updates
 * Tracks completion counts without triggering UI events
 */
export class BatchProgressTracker implements IBatchProgressTracker {
  private batches = new Map<string, BatchProgress>();

  constructor(private logger: IExtensionDiagnosticLogger) {}

  /**
   * Initialize batch tracking when batch starts
   */
  initializeBatch(batchId: string, totalMembers: number): void {

    this.batches.set(batchId, {
      batchId,
      completed: 0,
      failed: 0,
      total: totalMembers,
      percentage: 0,
      status: 'running'
    });
  }

  /**
   * Update progress when a batch member completes
   */
  updateBatchMemberProgress(batchId: string, executionId: string, status: string): void {
    const progress = this.batches.get(batchId);
    if (!progress) {
      this.logger.warn(`[BatchProgressTracker] Batch ${batchId} not found for update`, undefined, { batchId });
      return;
    }

    // Update counts based on status
    if (status === 'completed') {
      progress.completed++;
    } else if (status === 'error' || status === 'cancelled') {
      progress.failed++;
    }

    // Update percentage and overall status
    const totalProcessed = progress.completed + progress.failed;
    progress.percentage = Math.round((totalProcessed / progress.total) * 100);

    if (totalProcessed >= progress.total) {
      progress.status = progress.failed > 0 ? 'failed' : 'completed';
    }

  }

  /**
   * Get current progress for a batch
   */
  getBatchProgress(batchId: string): BatchProgress | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Remove batch tracking when batch is complete
   */
  removeBatch(batchId: string): void {
    this.batches.delete(batchId);
  }

  /**
   * Get all active batch IDs
   */
  getActiveBatchIds(): string[] {
    return Array.from(this.batches.keys());
  }

  /**
   * Get formatted progress string for display
   */
  getProgressString(batchId: string): string {
    const progress = this.getBatchProgress(batchId);
    if (!progress) {
      return 'Unknown progress';
    }

    const { completed, failed, total } = progress;
    if (failed > 0) {
      return `${completed}/${total} completed, ${failed} failed`;
    }
    return `${completed}/${total}`;
  }
}