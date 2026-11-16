// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Interface for batch file management operations
 */
export interface IBatchFileManager {
    /**
     * Create a batch workspace folder and copy the CSV file
     */
    createBatchWorkspace(batchId: string, originalCsvPath: string, batchName?: string): Promise<{
        batchFolderPath: string;
        csvFileCopyPath: string;
    }>;

    /**
     * Get the batch workspace folder path
     */
    getBatchWorkspacePath(batchId: string): Promise<string>;

    /**
     * Get the CSV file copy path in batch workspace
     */
    getBatchCsvPath(batchId: string): Promise<string>;

    /**
     * Check if batch workspace exists
     */
    batchWorkspaceExists(batchId: string): Promise<boolean>;

    /**
     * Clean up batch workspace (optional cleanup method)
     */
    cleanupBatchWorkspace(batchId: string): Promise<void>;
}