// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { ITimeEstimationService, ExecutionTimeData, BatchTimeEstimate } from './time-estimation.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';

export class TimeEstimationService implements ITimeEstimationService {
  private static readonly STORAGE_KEY = 'timeEstimationData';
  private static readonly DEFAULT_EXECUTION_TIME = 30000; // 30 seconds
  private static readonly MAX_HISTORICAL_RECORDS = 1000;

  constructor(private context: vscode.ExtensionContext) {}

  async recordExecutionTime(execution: ExecutionMetadata): Promise<void> {
    // Only record data for completed executions
    if (!execution.completedAt || !execution.startedAt) {
      return;
    }

    const timeData: ExecutionTimeData = {
      executionId: execution.id,
      startTime: execution.startedAt,
      endTime: execution.completedAt,
      duration: execution.runTime || (execution.completedAt.getTime() - execution.startedAt.getTime()),
      endpointId: execution.endpointId,
      environmentId: execution.environment || 'unknown',
      success: execution.status === 'completed' || execution.status === 'warning'
    };

    // Get existing data
    const existingData = await this.getStoredTimeData();
    
    // Add new data
    existingData.push(timeData);

    // Keep only the most recent records to prevent unbounded growth
    if (existingData.length > TimeEstimationService.MAX_HISTORICAL_RECORDS) {
      existingData.splice(0, existingData.length - TimeEstimationService.MAX_HISTORICAL_RECORDS);
    }

    // Save updated data
    await this.context.workspaceState.update(TimeEstimationService.STORAGE_KEY, existingData);
  }

  async getAverageExecutionTime(endpointId: string, environmentId: string): Promise<number> {
    const timeData = await this.getStoredTimeData();
    
    // Filter for matching endpoint and environment
    const filteredData = timeData.filter(data => 
      data.endpointId === endpointId && 
      data.environmentId === environmentId
    );

    if (filteredData.length === 0) {
      return TimeEstimationService.DEFAULT_EXECUTION_TIME;
    }

    // Apply weighted average with recent executions having more weight
    const sortedData = filteredData.sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
    
    let totalWeightedTime = 0;
    let totalWeight = 0;
    
    sortedData.forEach((data, index) => {
      // More recent executions get higher weight (exponential decay)
      const weight = Math.exp(-index * 0.1);
      totalWeightedTime += data.duration * weight;
      totalWeight += weight;
    });

    return Math.round(totalWeightedTime / totalWeight);
  }

  async calculateBatchTimeEstimate(batch: ExecutionMetadata): Promise<BatchTimeEstimate> {
    const { batchResumptionData } = batch;
    // Calculate total executions from batchResumptionData
    const totalExecutions = (batchResumptionData?.completedExecutions.length || 0) + 
                            (batchResumptionData?.failedExecutions.length || 0) + 
                            (batchResumptionData?.skippedExecutions.length || 0) + 
                            Math.max(0, batchResumptionData?.currentExecutionIndex || 0);
    const completedExecutions = batchResumptionData?.completedExecutions.length || 0;
    const remainingExecutions = totalExecutions - completedExecutions;

    if (remainingExecutions <= 0) {
      return {
        batchId: batch.id,
        totalExecutions: totalExecutions,
        completedExecutions,
        averageExecutionTime: 0,
        estimatedCompletionTime: new Date(),
        estimatedRemainingTime: 0,
        estimatedTimeString: 'Completing...'
      };
    }

    // Calculate average time based on the batch endpoint/environment
    const endpointId = batch.endpointId || 'unknown';
    const environmentId = batch.environment;
    
    const averageExecutionTime = await this.getAverageExecutionTime(endpointId, environmentId);
    const estimatedRemainingTime = remainingExecutions * averageExecutionTime;
    const estimatedCompletionTime = new Date(Date.now() + estimatedRemainingTime);
    
    return {
      batchId: batch.id,
      totalExecutions: totalExecutions,
      completedExecutions,
      averageExecutionTime,
      estimatedCompletionTime,
      estimatedRemainingTime,
      estimatedTimeString: this.formatEstimatedTime(estimatedRemainingTime)
    };
  }

  async getHistoricalTimeData(
    endpointId?: string,
    environmentId?: string,
    limit?: number
  ): Promise<ExecutionTimeData[]> {
    const timeData = await this.getStoredTimeData();
    
    let filteredData = timeData;

    // Apply filters
    if (endpointId) {
      filteredData = filteredData.filter(data => data.endpointId === endpointId);
    }
    
    if (environmentId) {
      filteredData = filteredData.filter(data => data.environmentId === environmentId);
    }

    // Sort by most recent first
    filteredData.sort((a, b) => b.endTime.getTime() - a.endTime.getTime());

    // Apply limit
    if (limit && limit > 0) {
      filteredData = filteredData.slice(0, limit);
    }

    return filteredData;
  }

  formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const remainingSeconds = seconds % 60;
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
      if (remainingMinutes > 0 && remainingSeconds > 0) {
        return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
      } else if (remainingMinutes > 0) {
        return `${hours}h ${remainingMinutes}m`;
      } else {
        return `${hours}h`;
      }
    } else if (minutes > 0) {
      if (remainingSeconds > 0) {
        return `${minutes}m ${remainingSeconds}s`;
      } else {
        return `${minutes}m`;
      }
    } else {
      return `${seconds}s`;
    }
  }

  async cleanupHistoricalData(days: number): Promise<void> {
    const timeData = await this.getStoredTimeData();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const filteredData = timeData.filter(data => data.endTime >= cutoffDate);
    
    await this.context.workspaceState.update(TimeEstimationService.STORAGE_KEY, filteredData);
  }

  private async getStoredTimeData(): Promise<ExecutionTimeData[]> {
    const data = await this.context.workspaceState.get<ExecutionTimeData[]>(
      TimeEstimationService.STORAGE_KEY,
      []
    );
    
    // Convert stored date strings back to Date objects
    return data.map(item => ({
      ...item,
      startTime: new Date(item.startTime),
      endTime: new Date(item.endTime)
    }));
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
}