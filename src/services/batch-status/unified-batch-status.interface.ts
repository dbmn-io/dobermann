// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unified Batch Status Data
 * 
 * Single source of truth for batch execution status.
 * Calculated ONCE and passed to all UI components (status bar, progress bar, tooltips, etc.)
 */

export interface UnifiedBatchStatus {
    // Batch identification
    batchId: string;
    endpointId: string;
    endpointName: string;
    environment: string;
    
    // Execution counts - dynamic status grouping
    totalMembers: number;
    statusCounts: Record<string, number>;  // e.g., { completed: 5, error: 2, timeout: 1 }
    
    // Batch state
    batchStatus: 'preparing' | 'pending' | 'running' | 'completed' | 'paused' | 'cancelled' | 'stopped' | 'error';
    startedAt: Date;
    completedAt?: Date;
    
    // Progress information
    currentMemberIndex?: number;
    currentMemberId?: string;
    estimatedTimeRemaining?: string;
    
    // Additional metadata
    rows?: number;  // Original batch size
    organization?: string;
}