// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IExecutionProgressSink } from '../../platform/interfaces/execution-progress-sink.interface';
import { IConfiguration } from '../../platform/interfaces/configuration.interface';
import { IDbmnAuthService, IDbmnTelemetry } from '../dbmn-auth/dbmn-auth.interface';
import { IToastService } from '../notifications/toast.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { ExecutionResult, IExecutionService } from './execution.interface';
import { IExecutionMetadataService } from './execution-metadata.interface';
import { IExecutionCoordinator } from './execution-coordinator.interface';
import { IBatchStatusService } from '../batch-status/batch-status.interface';
import { IExecutionLoggingService } from '../logging/execution-logging.interface';
import { ITransactionCreator } from '../transaction-creator/transaction-creator.interface';

/**
 * Error tolerance configuration
 */
export interface ErrorToleranceConfig {
    /** Tolerance limit (absolute number or percentage) */
    limit: number;
    /** Tolerance mode */
    mode: 'absolute' | 'percentage';
}

/**
 * Batch execution state tracking
 */
export interface BatchExecutionState {
    /** Current batch execution ID */
    batchId: string;
    /** Total number of batch members */
    totalMembers: number;
    /** Number of completed members */
    completedMembers: number;
    /** Number of failed members */
    failedMembers: number;
    /** Number of successful members */
    successfulMembers: number;
    /** Number of cancelled members */
    cancelledMembers: number;
    /** Current processing member (if any) */
    currentMemberId: string | null;
    /** Batch execution status */
    status: 'preparing' | 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'stopped' | 'error';
    /** Start time - set when batch actually starts running (not when queued) */
    startedAt?: Date;
    /** Completion time (if completed) */
    completedAt?: Date;
    /** Pause time (if paused) */
    pausedAt?: Date;
    /** Resume time (if resumed) */
    resumedAt?: Date;
    /** Total execution duration in milliseconds (sum of all member execution times) */
    totalExecutionDuration: number;
    /**
     * Issue #311: milliseconds this batch has spent RUNNING in earlier sessions
     * (before the current `startedAt`). Folded in whenever a session ends —
     * pause, stop, cancel, completion — and persisted as the batch's `runTime`
     * so a resume after an extension reload still knows. The Console's elapsed
     * clock is `activeRunMs + (now - startedAt)`: a batch that ran 19 hours,
     * paused overnight and resumed shows 19 hours, not 0 and not 30.
     */
    activeRunMs?: number;
    /**
     * Set while a running batch waits for what it runs on to come back (the web app: DBMN for
     * VS Code closed mid-run): what it waits for. No member starts and the clock stands still.
     */
    awaiting?: string;
    /** Completion timestamps for throughput-based ETA calculation (GitHub Issue #104) */
    completionTimestamps: number[];
    /** Last time ETA was updated (for progressive update frequency) (GitHub Issue #104) */
    lastEtaUpdate?: number;
    /** Progress update timer for per-second updates (GitHub Issue #70) */
    progressTimer?: NodeJS.Timeout;

    // NEW: Error tolerance support (GitHub Issue #47)
    /** Error tolerance configuration (only present when configured) */
    toleranceConfig?: ErrorToleranceConfig;

    // NEW: Parallel processing support (GitHub Issue #78)
    /** Parallel processing configuration (only present when configured) */
    parallelConfig?: { enabled: boolean; maxConcurrency: number };

    // NEW: Session tracking for accurate time estimation during reprocessing
    /** Session start count for time calculations */
    sessionStartCount?: number;

    // NEW: Environment's maximum allowed concurrency (GitHub Issue #156)
    /** Environment's maximum allowed concurrency (UI upper bound for thread control) */
    environmentMaxConcurrency?: number;
}

/**
 * Batch member execution result
 */
export interface BatchMemberResult extends ExecutionResult {
    /** Member index in batch */
    memberIndex: number;
    /** Whether this member caused batch failure */
    causedBatchFailure?: boolean;
}

/**
 * Batch execution progress callback
 */
export interface BatchProgressCallback {
    /** Called when a batch member starts */
    onMemberStarted?: (batchId: string, memberId: string, memberIndex: number, total: number) => Promise<void>;
    /** Called when a batch member completes */
    onMemberCompleted?: (batchId: string, result: BatchMemberResult, progress: BatchExecutionState) => Promise<void>;
    /** Called when batch is paused */
    onBatchPaused?: (batchId: string, reason: string) => Promise<void>;
    /** Called when batch is resumed */
    onBatchResumed?: (batchId: string) => Promise<void>;
    /** Called when entire batch completes */
    onBatchCompleted?: (batchId: string, state: BatchExecutionState) => Promise<void>;
}

/**
 * Dependencies for BatchExecutionEngine
 */
export interface BatchExecutionEngineDependencies {
    executionMetadataService: IExecutionMetadataService;
    executionService: IExecutionService; // Pure executor
    executionCoordinator?: IExecutionCoordinator; // For coordination (optional to avoid circular dependency)
    stateBroadcaster?: any; // IStateBroadcaster (optional to avoid circular imports)
    progressManager?: any; // IProgressManager (for batch completion messages)
    batchStatusService?: IBatchStatusService; // For batch status formatting
    executionLoggingService?: IExecutionLoggingService; // For batch-level logging
    transactionCreator?: ITransactionCreator; // For split transaction creation (GitHub Issue #74)
    transactionPreparationService?: any; // ITransactionPreparationService - For JIT chunk preparation (GitHub Issue #94)
    environmentManager?: any; // GitHub Issue #156: For reading environment's max concurrency
    progressSink?: IExecutionProgressSink; // Issue #320: Console updates; dropped when absent
    // Issue #321: host services, injected instead of read from VS Code or `global`. Providers are
    // called at the moment of use, as the globals were, so services wired after activation count.
    configuration?: IConfiguration; // dbmn.execution.* settings; defaults when absent
    dbmnAuth?: () => IDbmnAuthService | undefined;
    /**
     * #359: a member came back 401: new credentials for its environment without asking (DBMN's
     * session, an OAuth refresh token). True: they're new, so the member runs again. Absent: the
     * DBMN session is refreshed (dbmnAuth), as before.
     */
    refreshCredentials?: (environmentId: string) => Promise<boolean>;
    dbmnTelemetry?: () => IDbmnTelemetry | undefined;
    toast?: () => IToastService | undefined;
    /** Ask the user to sign in to DBMN again; resolves true if they chose to. */
    promptDbmnAuthExpired?: (dbmnAuth: IDbmnAuthService) => Promise<boolean>;
    /**
     * #344: can a batch in this environment run now? Undefined: yes. `waitingFor`: not yet, it
     * waits queued (the web app: DBMN for VS Code isn't running). `stop`: don't run it (the user
     * declined to sign in once VS Code came). Absent: always ready (VS Code). Asked before the
     * batch starts, and again before each member while it runs (VS Code can close mid-run).
     */
    readiness?: (environmentId: string) => Promise<{ waitingFor: string } | { stop: string } | undefined>;
}

/**
 * Reprocess type for batch reprocessing operations (GitHub Issue #67, #74)
 */
export type ReprocessType = 'INCOMPLETE' | 'ERRORS' | 'PENDING' | 'ALL' | 'SELECTED' | 'SPLIT';

/**
 * Batch Execution Engine Interface
 * 
 * Handles sequential processing of batch executions.
 * Can be interrupted by higher priority individual executions.
 * Maintains state across pause/resume cycles.
 */
export interface IBatchExecutionEngine {
    /**
     * Execute a batch by processing all its members sequentially
     * @param batchId - The batch execution ID to process
     * @param progressCallback - Optional progress callbacks
     * @param vscodeProgress - Optional VS Code progress for visual progress bar
     * @returns Promise<BatchExecutionState>
     */
    executeBatch(batchId: string, progressCallback?: BatchProgressCallback, vscodeProgress?: any): Promise<BatchExecutionState>;

    /**
     * Pause the currently running batch
     * @param batchId - The batch to pause
     * @param reason - Reason for pausing
     * @returns Promise<void>
     */
    pauseBatch(batchId: string, reason: string): Promise<void>;

    /**
     * Resume a paused batch from where it left off
     * @param batchId - The batch to resume
     * @returns Promise<BatchExecutionState>
     */
    resumeBatch(batchId: string): Promise<BatchExecutionState>;

    /**
     * Cancel a batch execution (running or paused)
     * @param batchId - The batch to cancel
     * @returns Promise<void>
     */
    cancelBatch(batchId: string): Promise<void>;

    /**
     * Get current state of a batch execution
     * @param batchId - The batch to check
     * @returns Promise<BatchExecutionState | null>
     */
    getBatchState(batchId: string): Promise<BatchExecutionState | null>;

    /**
     * Get all batch members for a batch execution
     * @param batchId - The batch to get members for
     * @returns Promise<ExecutionMetadata[]>
     */
    getBatchMembers(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Check if a batch is currently running
     * @param batchId - The batch to check
     * @returns Promise<boolean>
     */
    isBatchRunning(batchId: string): Promise<boolean>;

    /**
     * Get list of all running batches
     * @returns Promise<string[]>
     */
    getRunningBatches(): Promise<string[]>;

    /**
     * Reprocess batch members based on type.
     * All reprocessing now happens in-batch — members get reset and re-executed in place.
     * @param batchId - The batch to reprocess
     * @param type - What to reprocess (INCOMPLETE|ERRORS|PENDING|ALL|SELECTED|SPLIT)
     * @param memberIds - Optional array of member IDs when type is SELECTED or SPLIT
     * @returns Promise<string> - Same batch ID (all reprocessing is in-batch)
     */
    reprocessBatch(batchId: string, type: ReprocessType, memberIds?: string[]): Promise<string>;

    /**
     * Reprocess specific members in-batch: reset to pending and re-execute in place.
     * Works both while the batch is running and after completion.
     * @param batchId - The batch containing the members
     * @param memberIds - Array of member IDs to reprocess
     * @returns Promise<number> - Number of members reset
     */
    reprocessMembersInBatch(batchId: string, memberIds: string[]): Promise<number>;

    /**
     * Reset error/failed batch members to pending status (GitHub Issue #151)
     * Used by Enhanced Resume to retry failed transactions before resuming
     * @param batchId - The batch to reset error members for
     * @returns Promise<number> - Number of members reset
     */
    resetErrorMembersToPending(batchId: string): Promise<number>;

    /** #335: reset the members Cancel cut off to pending, so a Resume sends them again. */
    resetCancelledMembersToPending(batchId: string): Promise<number>;

    /**
     * Update batch error handling mode (GitHub Issue #151)
     * Used by Enhanced Resume to change stop-on-error setting before resuming
     * @param batchId - The batch to update
     * @param config - Error handling configuration
     * @returns Promise<void>
     */
    updateBatchErrorMode(batchId: string, config: { stopOnFirstError: boolean }): Promise<void>;

    /**
     * Clear cached batch state (GitHub Issue #94 - Pagination Support)
     * Forces batch execution engine to reload batch members from database on next executeBatch call
     * Use this when batch members are added/modified outside of normal execution flow
     * @param batchId - The batch to clear state for
     * @returns void
     */
    clearBatchState(batchId: string): void;

    /**
     * Update thread count for a running batch (GitHub Issue #156)
     * Allows dynamic adjustment of concurrency during batch execution.
     * Changes apply at the next iteration of the producer/consumer loops.
     * @param batchId - The batch to update
     * @param newConcurrency - New concurrency level (1, 2, 4, 8, 16)
     * @returns Promise with success status, current and max concurrency values
     */
    updateBatchConcurrency(batchId: string, newConcurrency: number): Promise<{
        success: boolean;
        currentConcurrency: number;
        maxConcurrency: number;
        message?: string;
    }>;
}