// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Copy Service Interface
 * 
 * Handles copying completed batches to different environments with lineage tracking.
 * Supports promoting batches through dev lifecycle (DEV → SIT → UAT → PROD).
 */

export interface BatchCopyOptions {
    /** Include failed/incomplete batch members in the copy */
    includeIncomplete: boolean;
    /** Target environment name (for display) */
    targetEnvironment: string;
    /** Target environment ID (UUID) for proper lookups */
    targetEnvironmentId?: string;
    /** Target organization (optional) */
    targetOrganization?: string;
    /** GitHub Issue #176: Temporary ENV variable overrides for this copy only */
    environmentVariableOverrides?: Record<string, string>;
}

export interface BatchCopyResult {
    /** New batch ID created in target environment */
    newBatchId: string;
    /** Number of batch members copied */
    membersCopied: number;
    /** Number of members excluded (if includeIncomplete=false) */
    membersExcluded: number;
    /** Path to new batch workspace */
    newBatchPath: string;
    /** Original filename preserved */
    csvFileName: string;
}

export interface BatchCopyValidation {
    /** Whether the copy operation is valid */
    isValid: boolean;
    /** Validation error message if invalid */
    errorMessage?: string;
    /** Warning message (operation can proceed but user should be aware) */
    warningMessage?: string;
    /** Source batch information */
    sourceBatch: {
        id: string;
        name: string;
        environment: string;
        organization?: string;
        totalMembers: number;
        completedMembers: number;
        failedMembers: number;
        status: string;
    };
}

/**
 * Batch Copy Service Interface
 * 
 * Main service for copying batches between environments
 */
export interface IBatchCopyService {
    /**
     * Validate that a batch copy operation can be performed
     * @param sourceBatchId - Source batch to copy
     * @param options - Copy options including target environment
     * @returns Validation result with batch information
     */
    validateCopyOperation(sourceBatchId: string, options: BatchCopyOptions): Promise<BatchCopyValidation>;

    /**
     * Copy a completed batch to a target environment
     * @param sourceBatchId - Source batch to copy
     * @param options - Copy options
     * @returns Copy result with new batch information
     */
    copyBatch(sourceBatchId: string, options: BatchCopyOptions): Promise<BatchCopyResult>;

    /**
     * Get copy lineage for a batch (what it was copied from, what was copied from it)
     * @param batchId - Batch to get lineage for
     * @returns Lineage information
     */
    getBatchLineage(batchId: string): Promise<{
        copiedFrom?: string;
        copiedTo: string[];
        generation: number;
    }>;
}