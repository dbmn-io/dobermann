// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Status Service Interface
 * 
 * Centralized service for calculating and formatting batch execution status summaries.
 * Provides consistent status information to status bar, progress notifications, and completion messages.
 */

export interface BatchStatusCounts {
    [status: string]: number;  // Dynamic status counts
    total: number;             // Keep total separate
}

export interface BatchStatusSummary {
    counts: BatchStatusCounts;
    statusText: string;        // e.g., "✅ 5 ❌ 2 ⚠️ 1"
    completionText: string;    // e.g., "5 completed, 2 error, 1 cancelled"
    tooltipLines: string[];    // Each status on separate line for tooltip
}

export interface IBatchStatusService {
    /**
     * Calculate status counts from batch member executions
     */
    calculateStatusCounts(batchMembers: any[], totalMembers?: number): BatchStatusCounts;

    /**
     * Create formatted status summary from counts
     */
    createStatusSummary(counts: BatchStatusCounts): BatchStatusSummary;

    /**
     * Get complete batch status summary from batch data
     */
    getBatchStatusSummary(batchData: {
        batchMembers?: any[];
        batchMemberProgress?: any;
        totalMembers?: number;
    }): BatchStatusSummary;
}