// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IBatchStatusService, BatchStatusCounts, BatchStatusSummary } from './batch-status.interface';

/**
 * Batch Status Service
 * 
 * Centralized service for calculating and formatting batch execution status summaries.
 * Uses dynamic GROUP BY approach to handle any execution status automatically.
 */
export class BatchStatusService implements IBatchStatusService {

    // Emoji mapping for known statuses - easy to extend
    private readonly STATUS_EMOJIS: Record<string, string> = {
        completed: '✅',
        error: '❌',
        cancelled: '⚠️',
        pending: '⏳',
        running: '🔄',
        timeout: '⏱️',
        retrying: '🔁',
        skipped: '⏭️',
        paused: '⏸️'
    };

    private readonly UNKNOWN_EMOJI = '❓';

    calculateStatusCounts(batchMembers: any[], totalMembers?: number): BatchStatusCounts {
        // Dynamic GROUP BY - count any status that exists
        const counts: BatchStatusCounts = {
            total: totalMembers || batchMembers.length
        };

        // Group by actual status values from batch members
        for (const member of batchMembers) {
            let status = member.status?.toLowerCase();
            
            // Handle legacy 'failed' status mapping
            if (status === 'failed') {
                status = 'error';
            }
            
            if (status) {
                counts[status] = (counts[status] || 0) + 1;
            }
        }

        return counts;
    }

    createStatusSummary(counts: BatchStatusCounts): BatchStatusSummary {
        // Get all status keys (excluding 'total')
        const statusKeys = Object.keys(counts).filter(key => key !== 'total' && counts[key] > 0);
        
        // Status bar format: show all statuses with emojis
        const statusParts: string[] = [];
        for (const status of statusKeys) {
            const count = counts[status];
            const emoji = this.STATUS_EMOJIS[status] || this.UNKNOWN_EMOJI;
            statusParts.push(`${emoji} ${count}`);
        }
        const statusText = statusParts.join(' ') || '⏸️ 0';

        // Completion message format: show all statuses with names
        const completionParts: string[] = [];
        for (const status of statusKeys) {
            const count = counts[status];
            completionParts.push(`${count} ${status}`);
        }
        const completionText = completionParts.join(', ') || 'No results';

        // Tooltip format: each status on separate line with emojis
        const tooltipLines: string[] = [];
        for (const status of statusKeys) {
            const count = counts[status];
            const emoji = this.STATUS_EMOJIS[status] || this.UNKNOWN_EMOJI;
            tooltipLines.push(`${emoji} ${count} ${status}`);
        }

        return {
            counts,
            statusText,
            completionText,
            tooltipLines
        };
    }

    getBatchStatusSummary(batchData: {
        batchMembers?: any[];
        batchMemberProgress?: any;
        totalMembers?: number;
    }): BatchStatusSummary {
        let counts: BatchStatusCounts;

        if (batchData.batchMemberProgress) {
            // Use data from BatchExecutionEngine
            const progress = batchData.batchMemberProgress;
            counts = { total: progress.total || 0 };
            
            // Copy all status counts dynamically (handle both new and legacy formats)
            for (const [key, value] of Object.entries(progress)) {
                if (key !== 'total' && typeof value === 'number' && value > 0) {
                    // Map legacy names to current names
                    let statusKey = key;
                    if (key === 'successful') statusKey = 'completed';
                    if (key === 'failed') statusKey = 'error';
                    
                    counts[statusKey] = value;
                }
            }
        } else if (batchData.batchMembers) {
            // Calculate from batch members
            counts = this.calculateStatusCounts(batchData.batchMembers, batchData.totalMembers);
        } else {
            // No data available
            counts = {
                total: batchData.totalMembers || 0
            };
        }

        return this.createStatusSummary(counts);
    }
}