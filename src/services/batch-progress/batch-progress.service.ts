// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IBatchProgressService, BatchProgress, ExecutionProgress } from './batch-progress.interface';
import { ITimeEstimationService } from '../time-estimation/time-estimation.interface';
import { ExecutionMetadata, StatusHelpers } from '../../storage/execution-metadata';

/**
 * TODO (Issue #104): This service appears to be legacy/unused for ETA calculations.
 * The actual ETA for report display comes from batch-execution-engine.service.ts
 * (calculateTimeRemaining method).
 *
 * After testing confirms this is unused, consider:
 * - Removing this entire service
 * - Removing batch-progress/ directory
 * - Removing BatchProgressService from container registrations
 * - Removing related interfaces and types
 */
export class BatchProgressService implements IBatchProgressService {
  private static readonly BATCH_PROGRESS_KEY = 'batchProgress';
  private static readonly EXECUTION_PROGRESS_KEY = 'batchExecutionProgress';

  constructor(
    private context: vscode.ExtensionContext,
    private timeEstimationService: ITimeEstimationService
  ) {}

  async calculateBatchProgress(batch: ExecutionMetadata): Promise<BatchProgress> {
    const { batchId, batchResumptionData, status, createdAt } = batch;
    
    // Calculate total executions from batchResumptionData arrays
    const totalExecutions = (batchResumptionData?.completedExecutions.length || 0) + 
                            (batchResumptionData?.failedExecutions.length || 0) + 
                            (batchResumptionData?.skippedExecutions.length || 0) + 
                            Math.max(0, batchResumptionData?.currentExecutionIndex || 0);
    const completedExecutions = batchResumptionData?.completedExecutions.length || 0;
    const failedExecutions = batchResumptionData?.failedExecutions.length || 0;
    const skippedExecutions = batchResumptionData?.skippedExecutions.length || 0;
    const currentExecutionIndex = batchResumptionData?.currentExecutionIndex || 0;
    const pendingExecutions = totalExecutions - completedExecutions - failedExecutions - skippedExecutions;
    
    const completionPercentage = totalExecutions > 0 
      ? Math.round(((completedExecutions + failedExecutions + skippedExecutions) / totalExecutions) * 100)
      : 0;

    const isComplete = StatusHelpers.isFinished(batch.executionType, status);

    // Get batch timing information
    const batchTimingData = await this.getBatchTimingData(batchId || batch.id);
    const isPaused = batchTimingData.isPaused;
    
    // Calculate elapsed time
    const elapsedTime = this.calculateElapsedTime(batchTimingData, createdAt);

    // Calculate average execution time from current batch's completed executions
    const averageExecutionTime = await this.calculateBatchAverageExecutionTime(batch);

    // Calculate remaining time based on actual performance in this batch (issue#104)
    // Account for parallel execution: divide by maxConcurrentExecutions
    const maxConcurrent = batch.batchConfiguration?.maxConcurrentExecutions || 1;
    const remainingExecutions = totalExecutions - currentExecutionIndex;
    const estimatedRemainingTime = isComplete ? 0 :
      (remainingExecutions * averageExecutionTime) / maxConcurrent;
    const estimatedCompletionTime = new Date(Date.now() + estimatedRemainingTime);

    const progress: BatchProgress = {
      batchId: batchId || batch.id,
      totalExecutions,
      completedExecutions,
      failedExecutions,
      skippedExecutions,
      pendingExecutions,
      currentExecutionIndex,
      completionPercentage,
      estimatedRemainingTime,
      estimatedCompletionTime,
      progressText: '',
      averageExecutionTime,
      elapsedTime,
      isPaused,
      isComplete
    };

    progress.progressText = this.formatProgressText(progress);

    return progress;
  }

  async getExecutionProgress(executionId: string, batchId: string): Promise<ExecutionProgress> {
    const progressData = await this.getExecutionProgressData();
    const key = `${batchId}:${executionId}`;
    const data = progressData[key];

    if (!data) {
      return {
        executionId,
        batchId,
        status: 'pending'
      };
    }

    const progress: ExecutionProgress = {
      executionId,
      batchId,
      status: data.status,
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      estimatedDuration: data.estimatedDuration
    };

    // Calculate progress percentage for running executions
    if (data.status === 'running' && data.startTime && data.estimatedDuration) {
      const elapsed = Date.now() - data.startTime.getTime();
      progress.progressPercentage = Math.min(Math.round((elapsed / data.estimatedDuration) * 100), 99);
    }

    return progress;
  }

  async startExecution(executionId: string, batchId: string): Promise<void> {
    const progressData = await this.getExecutionProgressData();
    const key = `${batchId}:${executionId}`;
    
    // Get estimated duration for this execution
    const estimatedDuration = await this.timeEstimationService.getAverageExecutionTime(
      'unknown', // We don't have endpoint info here
      'unknown'
    );

    progressData[key] = {
      status: 'running',
      startTime: new Date(),
      estimatedDuration
    };

    await this.saveExecutionProgressData(progressData);
  }

  async completeExecution(executionId: string, batchId: string, execution: ExecutionMetadata): Promise<void> {
    const progressData = await this.getExecutionProgressData();
    const key = `${batchId}:${executionId}`;
    
    const existingData = progressData[key] || {};
    
    progressData[key] = {
      ...existingData,
      status: 'completed',
      endTime: execution.completedAt || new Date(),
      duration: execution.runTime || (execution.completedAt && execution.startedAt 
        ? execution.completedAt.getTime() - execution.startedAt.getTime()
        : undefined)
    };

    await this.saveExecutionProgressData(progressData);
  }

  async failExecution(executionId: string, batchId: string, execution: ExecutionMetadata): Promise<void> {
    const progressData = await this.getExecutionProgressData();
    const key = `${batchId}:${executionId}`;
    
    const existingData = progressData[key] || {};
    
    progressData[key] = {
      ...existingData,
      status: 'error',
      endTime: execution.completedAt || new Date(),
      duration: execution.runTime || (execution.completedAt && execution.startedAt 
        ? execution.completedAt.getTime() - execution.startedAt.getTime()
        : undefined)
    };

    await this.saveExecutionProgressData(progressData);
  }

  async pauseBatch(batchId: string): Promise<void> {
    const batchData = await this.getBatchProgressData();
    
    if (!batchData[batchId]) {
      batchData[batchId] = {
        startTime: new Date(),
        pausedTime: 0,
        isPaused: false
      };
    }

    batchData[batchId].isPaused = true;
    batchData[batchId].pausedAt = new Date();

    await this.saveBatchProgressData(batchData);
  }

  async resumeBatch(batchId: string): Promise<void> {
    const batchData = await this.getBatchProgressData();
    
    if (batchData[batchId] && batchData[batchId].isPaused && batchData[batchId].pausedAt) {
      const pauseDuration = Date.now() - batchData[batchId].pausedAt!.getTime();
      batchData[batchId].pausedTime += pauseDuration;
      batchData[batchId].isPaused = false;
      delete batchData[batchId].pausedAt;

      await this.saveBatchProgressData(batchData);
    }
  }

  async clearBatchProgress(batchId: string): Promise<void> {
    // Clear batch progress data
    const batchData = await this.getBatchProgressData();
    delete batchData[batchId];
    await this.saveBatchProgressData(batchData);

    // Clear execution progress data
    const executionData = await this.getExecutionProgressData();
    const keysToDelete = Object.keys(executionData).filter(key => key.startsWith(`${batchId}:`));
    keysToDelete.forEach(key => delete executionData[key]);
    await this.saveExecutionProgressData(executionData);
  }

  async getActiveBatches(): Promise<BatchProgress[]> {
    const batchData = await this.getBatchProgressData();
    const batchIds = Object.keys(batchData);
    
    // Note: In a real implementation, we would need access to BatchMetadata
    // For now, return empty array as we can't construct BatchProgress without BatchMetadata
    // This would be resolved when integrating with the actual batch management system
    return [];
  }

  formatProgressText(progress: BatchProgress): string {
    const { batchId, currentExecutionIndex, totalExecutions, isPaused, isComplete } = progress;

    if (isComplete) {
      return `Batch ${batchId} completed`;
    }

    if (isPaused) {
      const remainingTimeText = this.formatEstimatedTime(progress.estimatedRemainingTime);
      return `Batch ${currentExecutionIndex}/${totalExecutions} paused - ${remainingTimeText}`;
    }

    const remainingTimeText = this.formatEstimatedTime(progress.estimatedRemainingTime);
    return `Batch ${currentExecutionIndex}/${totalExecutions} running - ${remainingTimeText}`;
  }

  private async getBatchProgressData(): Promise<any> {
    return await this.context.workspaceState.get(BatchProgressService.BATCH_PROGRESS_KEY, {});
  }

  private async saveBatchProgressData(data: any): Promise<void> {
    await this.context.workspaceState.update(BatchProgressService.BATCH_PROGRESS_KEY, data);
  }

  private async getExecutionProgressData(): Promise<any> {
    return await this.context.workspaceState.get(BatchProgressService.EXECUTION_PROGRESS_KEY, {});
  }

  private async saveExecutionProgressData(data: any): Promise<void> {
    await this.context.workspaceState.update(BatchProgressService.EXECUTION_PROGRESS_KEY, data);
  }

  private async getBatchTimingData(batchId: string): Promise<any> {
    const batchData = await this.getBatchProgressData();
    return batchData[batchId] || {
      startTime: new Date(),
      pausedTime: 0,
      isPaused: false
    };
  }

  private calculateElapsedTime(batchTimingData: any, createdAt: Date): number {
    const now = Date.now();
    const startTime = batchTimingData.startTime ? batchTimingData.startTime.getTime() : createdAt.getTime();
    const totalElapsed = now - startTime;
    const pausedTime = batchTimingData.pausedTime || 0;
    
    // If currently paused, add the current pause duration
    if (batchTimingData.isPaused && batchTimingData.pausedAt) {
      const currentPauseDuration = now - batchTimingData.pausedAt.getTime();
      return totalElapsed - pausedTime - currentPauseDuration;
    }
    
    return totalElapsed - pausedTime;
  }

  private formatEstimatedTime(milliseconds: number): string {
    if (milliseconds < 1000) {
      return 'Completing...';
    }

    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const remainingSeconds = seconds % 60;
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
      if (remainingMinutes > 0) {
        return `Est. ${hours}h ${remainingMinutes}m remaining`;
      } else {
        return `Est. ${hours}h remaining`;
      }
    } else if (minutes > 0) {
      if (remainingSeconds > 0) {
        return `Est. ${minutes}m ${remainingSeconds}s remaining`;
      } else {
        return `Est. ${minutes}m remaining`;
      }
    } else {
      return `Est. ${seconds}s remaining`;
    }
  }

  /**
   * Calculate average execution time based on completed executions within the current batch
   * This provides more accurate estimates as it adapts to current conditions
   *
   * Fix for issue#104 - Scale sample size by parallel factor:
   * - With parallel=10, use 50 samples (10 parallel waves × 5 base samples)
   * - This captures a representative time window across multiple parallel execution waves
   */
  private async calculateBatchAverageExecutionTime(batch: ExecutionMetadata): Promise<number> {
    const batchId = batch.batchId || batch.id;
    const executionData = await this.getExecutionProgressData();

    // Filter executions for this batch that have completed
    const batchExecutions = Object.entries(executionData)
      .filter(([key]) => key.startsWith(`${batchId}:`))
      .map(([_, data]) => data as any)
      .filter((data: any) => data.status === 'completed' && data.duration);

    // If no completed executions yet, use a default estimate
    if (batchExecutions.length === 0) {
      // Default to 5 seconds per execution as a reasonable starting estimate
      return 5000;
    }

    // Calculate average from completed executions
    const totalDuration = batchExecutions.reduce((sum: number, exec: any) => sum + (exec.duration || 0), 0);
    const averageDuration = totalDuration / batchExecutions.length;

    // Scale sample size by parallel factor (issue#104)
    // With parallel=10, we need 50 samples to capture multiple parallel waves
    const maxConcurrent = batch.batchConfiguration?.maxConcurrentExecutions || 1;
    const baseSampleSize = 5;
    const scaledSampleSize = baseSampleSize * maxConcurrent;
    const sampleSize = Math.min(
      Math.max(scaledSampleSize, 20), // Minimum 20 samples for stability
      batchExecutions.length // Don't exceed available data
    );

    // Apply median instead of mean for stability (issue#104)
    // Median is resistant to outliers (slow error executions vs fast successes)
    // This provides stable ETA even when error/success ratio fluctuates
    if (batchExecutions.length >= 20) {
      // Use recent executions for median calculation
      const recentExecutions = batchExecutions.slice(-sampleSize);

      // Sort durations to find median
      const sortedDurations = recentExecutions
        .map((exec: any) => exec.duration)
        .sort((a: number, b: number) => a - b);

      // Calculate median (middle value)
      const midpoint = Math.floor(sortedDurations.length / 2);
      const medianTime = sortedDurations.length % 2 === 0
        ? (sortedDurations[midpoint - 1] + sortedDurations[midpoint]) / 2
        : sortedDurations[midpoint];

      return Math.round(medianTime);
    }

    // Fallback for small samples: use simple average
    return Math.round(averageDuration);
  }
}