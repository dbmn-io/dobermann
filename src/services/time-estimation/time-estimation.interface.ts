// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata } from '../../storage/execution-metadata';

/**
 * Time estimation data for historical analysis
 */
export interface ExecutionTimeData {
  executionId: string;
  startTime: Date;
  endTime: Date;
  duration: number; // milliseconds
  endpointId: string;
  environmentId: string;
  success: boolean;
}

/**
 * Batch time estimation result
 */
export interface BatchTimeEstimate {
  batchId: string;
  totalExecutions: number;
  completedExecutions: number;
  averageExecutionTime: number; // milliseconds
  estimatedCompletionTime: Date;
  estimatedRemainingTime: number; // milliseconds
  estimatedTimeString: string; // formatted string like "Est. 5m 30s remaining"
}

/**
 * Time estimation service interface for Phase 4 progress tracking
 */
export interface ITimeEstimationService {
  /**
   * Record execution time data when an execution completes
   * @param execution - The completed execution metadata
   */
  recordExecutionTime(execution: ExecutionMetadata): Promise<void>;

  /**
   * Get average execution time for a specific endpoint and environment
   * @param endpointId - The endpoint identifier
   * @param environmentId - The environment identifier
   * @returns Average execution time in milliseconds
   */
  getAverageExecutionTime(endpointId: string, environmentId: string): Promise<number>;

  /**
   * Calculate time estimate for a batch based on historical data
   * @param batch - The batch metadata
   * @returns Batch time estimation with completion time and remaining time
   */
  calculateBatchTimeEstimate(batch: ExecutionMetadata): Promise<BatchTimeEstimate>;

  /**
   * Get historical execution time data for analysis
   * @param endpointId - Optional endpoint filter
   * @param environmentId - Optional environment filter
   * @param limit - Optional limit on number of records
   * @returns Array of execution time data
   */
  getHistoricalTimeData(
    endpointId?: string, 
    environmentId?: string, 
    limit?: number
  ): Promise<ExecutionTimeData[]>;

  /**
   * Format time duration into human-readable string
   * @param milliseconds - Duration in milliseconds
   * @returns Formatted string like "5m 30s" or "2h 15m"
   */
  formatDuration(milliseconds: number): string;

  /**
   * Clear historical data older than specified days
   * @param days - Number of days to retain data
   */
  cleanupHistoricalData(days: number): Promise<void>;
}