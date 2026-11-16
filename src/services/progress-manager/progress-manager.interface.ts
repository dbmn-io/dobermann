// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Progress Manager Interface
 * 
 * Manages VS Code progress notifications for batch execution.
 * Allows reopening progress notifications from status bar clicks.
 */

export interface IProgressManager {
    /**
     * Check if a batch has an active progress notification
     */
    hasActiveProgress(batchId: string): boolean;

    /**
     * Store reference to active batch execution
     */
    setActiveBatch(batchId: string): void;

    /**
     * Get the active batch ID
     */
    getActiveBatchId(): string | null;

    /**
     * Clear active batch reference
     */
    clearActiveBatch(): void;

    /**
     * Show message when progress is closed but batch is still running
     */
    showProgressClosedMessage(): void;

    /**
     * Show persistent batch completion message with summary
     */
    showBatchCompletionMessage(batchId: string, summary: {
        completionText: string;
        hasErrors: boolean;
        total: number;
    }): void;

    /**
     * Show batch logs in output channel (callable from progress bar or tree view)
     */
    showBatchLogs(batchId: string, summary: {
        completionText: string;
        total: number;
    }): Promise<void>;

    /**
     * Clear stored batch result data (memory cleanup after batch completion)
     */
    clearBatchResult(batchId: string): void;
}