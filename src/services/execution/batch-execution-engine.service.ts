// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    IBatchExecutionEngine,
    BatchExecutionState,
    BatchMemberResult,
    BatchProgressCallback,
    BatchExecutionEngineDependencies,
    ReprocessType
} from './batch-execution-engine.interface';
import { IDbmnAuthService } from '../dbmn-auth/dbmn-auth.interface';
import { UnifiedBatchStatus } from '../batch-status/unified-batch-status.interface';
import { BatchStatus } from '../../storage/execution-metadata';
import { LogEvent } from '../logging/execution-logging.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { ErrorToleranceConfig } from './batch-execution-engine.interface';
import { TransactionSplitter, TransactionSplitterDependencies } from '../transaction-preparation/helpers/transaction-splitter.helper';
import { ProgressToConsoleAdapter } from '../progress-adapter/progress-to-console-adapter';
import { CancellationFlag, IExecutionProgressSink, NO_PROGRESS_SINK } from '../../platform/interfaces/execution-progress-sink.interface';
import { DEFAULT_CONFIGURATION } from '../../platform/interfaces/configuration.interface';
import { formatDuration } from '../../utils/time-formatter';
import { IDbmnTelemetry } from '../dbmn-auth/dbmn-auth.interface';
import { isPaginatedBatch, PaginationDetectorService } from '../pagination/pagination-detector.service';
import { PAGE_RETRY_DELAYS_MS, isTemporaryPageFailure } from '../pagination/page-retry';
import * as path from 'path';
import { readRunFile, readRunFileIfExists, renameRunFile, runFileExists } from '../run-content/run-content-store';

/**
 * BatchExecutionEngine Service
 * 
 * Handles sequential processing of batch executions.
 * Key features:
 * - Sequential member processing (one at a time)
 * - Interruptible by higher priority executions
 * - State persistence across pause/resume cycles
 * - Progress tracking and callbacks
 * - Error handling with batch failure policies
 * 
 * Architecture:
 * - Works with ExecutionCoordinator for priority management
 * - Uses ExecutionService for actual member execution
 * - Maintains batch state for resilience
 * 
 * TIMER LOGIC (startedAt field):
 * - Tracks when the CURRENT process phase began
 * - PREPARING: Set during batch creation (handled by external service)
 * - PENDING: undefined (batch is queued, not actively processing)  
 * - RUNNING: Set to new Date() when execution begins, reset on resume/reprocess
 * - Used for: elapsed time calculation and ETA estimation
 * 
 * Timeline example:
 * 1. Batch created → preparation timer starts (external service)
 * 2. Batch queued (PENDING) → startedAt = undefined
 * 3. Batch starts (RUNNING) → startedAt = new Date() (execution timer)
 * 4. Batch resumed → startedAt = new Date() (reset execution timer)
 */
export class BatchExecutionEngine implements IBatchExecutionEngine {
    /** Issue #320: the Console (in VS Code) or a recorder (in `test:core`); never imported directly. */
    private get progressSink(): IExecutionProgressSink {
        return this.dependencies.progressSink ?? NO_PROGRESS_SINK;
    }

    // GitHub Issue #104: Switched to throughput-based ETA (completions/minute) - no longer need window sizes
    private batchStates: Map<string, BatchExecutionState> = new Map();
    // GitHub Issue #104: Track active parallel executions for continuous thread pool
    private activeExecutionsMap: Map<string, Map<string, Promise<void>>> = new Map();
    // GitHub Issue #110: Track active consumer loops per batch to detect duplicates
    private activeConsumerLoops: Map<string, number> = new Map();
    /** #437: batches resumed behind a running batch, waiting their turn (one wait per batch) */
    private resumeWaits: Set<string> = new Set();
    /** What has already been reported to telemetry per running batch, so completion reports only the rest. */
    private telemetryProgress: Map<string, { apiCalls: number; rows: number; successes: number; failures: number; batchRunRecorded: boolean; clockMs: number }> = new Map();

    constructor(
        private dependencies: BatchExecutionEngineDependencies,
        private readonly logger: IExtensionDiagnosticLogger
    ) {
    }


    /**
     * Helper method to log batch execution events to file (for preparation/finalization)
     */
    private async logBatchEvent(batchId: string, event: Omit<LogEvent, 'timestamp'>): Promise<void> {
        if (!this.dependencies.executionLoggingService) {
            return; // Logging is optional
        }

        try {
            const logEvent: LogEvent = {
                ...event,
                timestamp: new Date().toISOString()
            };

            await this.dependencies.executionLoggingService.logExecutionEvent(batchId, logEvent);
        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to log event for batch ${batchId}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Helper method to broadcast batch orchestration events directly to live streaming
     * (These events don't get written to files, only streamed live)
     */
    private async broadcastBatchEvent(batchId: string, event: Omit<LogEvent, 'timestamp'>): Promise<void> {
        if (!this.dependencies.executionLoggingService) {
            return; // Logging is optional
        }

        try {
            const logEvent: LogEvent = {
                ...event,
                timestamp: new Date().toISOString()
            };

            // Directly notify live streaming callbacks without writing to file
            if ('notifyLogEventCallbacks' in this.dependencies.executionLoggingService) {
                (this.dependencies.executionLoggingService as any).notifyLogEventCallbacks(batchId, logEvent);
            }
        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to broadcast event for batch ${batchId}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Execute a batch by processing all its members sequentially
     */
    async executeBatch(batchId: string, progressCallback?: BatchProgressCallback, vscodeProgress?: any): Promise<BatchExecutionState> {
        const existingState = this.batchStates.get(batchId);

        // If no external progress provided, create our own VS Code progress notification
        if (!vscodeProgress) {

            // Get batch name for progress title
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            const batchName = batchMetadata?.endpointName || 'batch';

            // Read parallel processing config to show concurrency in progress title
            const parallelConfig = await this.readParallelProcessingConfig(batchId);
            const concurrencyIndicator = (parallelConfig && parallelConfig.enabled && parallelConfig.maxConcurrency > 1)
                ? `[${parallelConfig.maxConcurrency}]`
                : '';

            // GitHub Issue #62: Check if another batch is already running before showing progress.
            // Issue #309: a batch of one request (a paginated Run API) neither queues nor holds
            // the queue — see mustQueue().
            const isAnotherBatchRunning = this.mustQueue(batchId, this.parseExpectedMemberCount(batchMetadata?.rows || '1'));

            // Show concurrency in progress title if parallel processing is configured
            const progressTitle = `Batch${concurrencyIndicator}: ${batchName}`;

            // Use ProgressToConsoleAdapter instead of VS Code notifications.
            // Issue #309: a batch that is going to wait opens as 'pending' so
            // the Console shows it queued instead of timing it.
            const progressAdapter = new ProgressToConsoleAdapter(batchId, this.progressSink, {
                title: progressTitle,
                cancellable: true,
                initialStatus: isAnotherBatchRunning ? 'pending' : undefined
            });

            return await progressAdapter.withProgress(async (progress, token) => {
                // GitHub Issue #62: Show queue notification if batch will be queued
                if (isAnotherBatchRunning) {
                    this.dependencies.toast?.()?.info(`Batch "${batchName}" has been queued and will start when the current batch completes.`);
                }

                // Get and set up progress manager for status bar interaction
                let progressManager: any;
                try {
                    // Note: ProgressManager integration would happen here if we had access to service container
                    // For now, ProgressManager is handled by calling code (ExecutionCommands)
                } catch (error) {
                    // Silently handle ProgressManager resolution errors
                }

                try {
                    // Execute batch with progress tracking
                    return await this.doExecuteBatch(batchId, progressCallback, progress, token);
                } finally {
                    // Note: ProgressManager cleanup would happen here if we had access to it
                }
            });
        } else {
            // Use provided external progress
            return await this.doExecuteBatch(batchId, progressCallback, vscodeProgress);
        }
    }

    /**
     * Internal method to execute batch with progress tracking
     */
    private async doExecuteBatch(batchId: string, progressCallback?: BatchProgressCallback, vscodeProgress?: any, token?: CancellationFlag): Promise<BatchExecutionState> {
        try {

            // Get batch metadata and members
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                throw new Error(`Batch execution ${batchId} not found`);
            }

            if (batchMetadata.executionType !== 'batch') {
                throw new Error(`Execution ${batchId} is not a batch execution`);
            }

            // Parse expected member count from batch header (supports streaming preparation)
            const expectedMemberCount = this.parseExpectedMemberCount(batchMetadata.rows);
            if (expectedMemberCount === 0) {
                throw new Error(`No members expected for batch ${batchId} (invalid rows field)`);
            }

            // Initialize or restore batch state
            let batchState = this.batchStates.get(batchId);
            if (!batchState) {
                // Read error tolerance configuration from endpoint (GitHub Issue #47)
                const toleranceConfig = await this.readErrorToleranceConfig(batchId, expectedMemberCount);

                // Read parallel processing configuration from batch metadata (GitHub Issue #78)
                const parallelConfig = await this.readParallelProcessingConfig(batchId);

                // GitHub Issue #156: Read environment's ACTUAL max concurrency (not batch's current setting)
                const environmentMaxConcurrency = await this.readEnvironmentMaxConcurrency(batchId);

                // GitHub Issue #62: Check if another batch is already running (Issue #309: a
                // batch of one request neither queues nor holds the queue — see mustQueue)
                const isAnotherBatchRunning = this.mustQueue(batchId, expectedMemberCount);

                batchState = {
                    batchId,
                    totalMembers: expectedMemberCount,
                    completedMembers: 0,
                    failedMembers: 0,
                    successfulMembers: 0,
                    cancelledMembers: 0,
                    currentMemberId: null,
                    status: BatchStatus.PENDING, // GitHub Issue #94 - JIT: batches always start as PENDING (first chunk created)
                    startedAt: undefined, // Will be set when first member execution starts
                    totalExecutionDuration: 0,
                    completionTimestamps: [], // Throughput-based ETA calculation (GitHub Issue #104)
                    lastEtaUpdate: undefined, // Progressive update frequency (GitHub Issue #104)
                    progressTimer: undefined, // Per-second updates timer (GitHub Issue #70)
                    // NEW: Error tolerance support (Issue #47)
                    toleranceConfig: toleranceConfig,

                    // NEW: Parallel processing support (GitHub Issue #78)
                    parallelConfig: parallelConfig,

                    // NEW: Session tracking for accurate time estimation during reprocessing
                    sessionStartCount: 0,

                    // NEW: GitHub Issue #156 - Store environment's max concurrency for UI thread control
                    // This is the ENVIRONMENT's max, not the batch's current setting
                    environmentMaxConcurrency: environmentMaxConcurrency
                };
                this.batchStates.set(batchId, batchState);

                // If another batch is running, queue this batch and wait
                if (isAnotherBatchRunning) {
                    this.logger.info(`[BatchExecutionEngine] Batch ${batchId} queued - waiting for running batch to complete`);
                    // Wait for the running batch to complete, then continue.
                    // Issue #309: a cancel while queued ends here — the batch
                    // must never start just because its turn came.
                    const turnCame = await this.waitForRunningBatchToComplete(batchId, vscodeProgress, token);
                    if (!turnCame) {
                        this.logger.info(`[BatchExecutionEngine] issue#309 Batch ${batchId} was cancelled while queued — not starting`);
                        await this.cleanupBatchMemory(batchId);
                        return batchState;
                    }

                    // GitHub Issue #62: Update progress message when batch starts executing
                    if (vscodeProgress) {
                        const batchName = batchMetadata?.endpointName || 'batch';
                        vscodeProgress.report({
                            message: `Preparing ${batchName}...`
                        });
                    }

                    // GitHub Issue #94 - Start as 'pending' (first chunk already created)
                    batchState.status = BatchStatus.PENDING;
                    this.batchStates.set(batchId, batchState);
                    this.logger.info(`[BatchExecutionEngine] Batch ${batchId} starting execution after queue wait (first chunk ready)`);

                    // GitHub Issue #123: Update report when queued batch starts
                    await this.sendStatusUpdateToReport(batchId, 'pending');
                }

                // #344: what the batch runs on may not be there yet (DBMN for VS Code): it waits,
                // queued, and a cancel or a declined sign-in ends it here, unstarted
                if (!(await this.waitUntilReady(batchId, batchMetadata.environmentId, vscodeProgress, token))) {
                    await this.cleanupBatchMemory(batchId);
                    return batchState;
                }

                // Broadcast batch preparation started (live streaming only, no file)
                await this.broadcastBatchEvent(batchId, {
                    level: 'info',
                    phase: 'orchestration',
                    event: 'batch_preparation_started',
                    data: {
                        batchId,
                        totalMembers: expectedMemberCount,
                        endpointName: batchMetadata.endpointName,
                        environment: batchMetadata.environment
                    }
                });
            } else {
                // #437: a resumed batch waits its turn behind a running batch, like a new one
                // (resumeBatch leaves it pending). Two paused batches, resumed one after the
                // other, used to run side by side. A pagination fetch that calls in while it
                // waits only refreshes the count: the wait already under way starts it.
                if (this.resumeWaits.has(batchId)) {
                    batchState.totalMembers = expectedMemberCount;
                    return batchState;
                }
                if (batchState.status === BatchStatus.PENDING
                    && !((this.activeConsumerLoops.get(batchId) || 0) > 0)
                    && this.mustQueue(batchId, expectedMemberCount)) {
                    this.logger.info(`[BatchExecutionEngine] issue#437 Resumed batch ${batchId} queued - waiting for running batch to complete`);
                    this.dependencies.toast?.()?.info(`Batch "${batchMetadata.endpointName || 'batch'}" has been queued and will start when the current batch completes.`);
                    this.resumeWaits.add(batchId);
                    let turnCame: boolean;
                    try {
                        turnCame = await this.waitForRunningBatchToComplete(batchId, vscodeProgress, token);
                    } finally {
                        this.resumeWaits.delete(batchId);
                    }
                    // Cancelled or paused again while it waited: it stays as the user left it
                    if (!turnCame || (batchState.status as string) !== BatchStatus.PENDING) {
                        this.logger.info(`[BatchExecutionEngine] issue#437 Resumed batch ${batchId} left the queue (${batchState.status}) — not starting`);
                        return batchState;
                    }
                    await this.sendStatusUpdateToReport(batchId, 'pending');
                }
                // Resuming existing batch
                batchState.status = BatchStatus.RUNNING;
                batchState.startedAt = new Date(); // Reset timer for resumed execution
                batchState.resumedAt = new Date();
                // GitHub Issue #266: refresh the expected member count from the latest batch
                // metadata. Pagination grows `rows` as pages are fetched; previously the console
                // forced a fresh count via clearBatchState() — now we refresh it here so a single
                // consumer loop can keep draining newly-created pages without restarting.
                batchState.totalMembers = expectedMemberCount;

                // Broadcast batch execution resumed (live streaming only, no file)
                await this.broadcastBatchEvent(batchId, {
                    level: 'info',
                    phase: 'orchestration',
                    event: 'batch_execution_resumed',
                    data: {
                        batchId,
                        totalMembers: batchState.totalMembers,
                        completedMembers: batchState.completedMembers,
                        remainingMembers: batchState.totalMembers - batchState.completedMembers
                    }
                });
            }

            // At this point, batchState is guaranteed to be defined (either created or retrieved)
            if (!batchState) {
                throw new Error(`[BatchExecutionEngine] Batch state initialization failed for ${batchId}`);
            }

            // GitHub Issue #266: do NOT auto-(re)start a paused/cancelled/stopped batch.
            // Pagination fetches call executeBatch() to pick up newly-created pages; without
            // this guard a user's pause would be silently undone (executeBatch used to clear
            // the pause signal unconditionally). Resume is the only path that restarts — it
            // resets status to pending and clears the signal first (see resumeBatch).
            // Cast to string so this early-return doesn't narrow batchState.status for the
            // rest of the method (status is mutated to paused/cancelled via `as any` later).
            const startStatus = batchState.status as string;
            if (startStatus === BatchStatus.PAUSED
                || startStatus === BatchStatus.CANCELLED
                || startStatus === BatchStatus.STOPPED) {
                this.logger.info(`[BatchExecutionEngine] executeBatch: batch ${batchId} is '${startStatus}' — not starting; resume required.`);
                return batchState;
            }

            // GitHub Issue #266: re-entrancy guard — run ONE consumer loop per batch.
            // Paginated batches call executeBatch() again on every fetch to pick up the new
            // pages; if a consumer loop is already draining this batch, don't start a second
            // one (overlapping loops defeat pause, which checks a single signal). The member
            // count was just refreshed above, so the existing loop will drain the new pages.
            if ((this.activeConsumerLoops.get(batchId) || 0) > 0) {
                this.logger.info(`[BatchExecutionEngine] executeBatch: batch ${batchId} already has an active consumer loop — refreshed totalMembers=${batchState.totalMembers}, not starting another.`);
                this.batchStates.set(batchId, batchState);
                return batchState;
            }

            // Update batch metadata
            await this.updateBatchMetadata(batchId, {
                status: BatchStatus.RUNNING,
                startedAt: batchState.startedAt,
                resumedAt: batchState.resumedAt
            });

            // Auto-open report for batch execution (similar to individual execution). Not brought
            // forward if already open: a queued batch starting while the user looks at another (#437)
            try {
                await this.progressSink.openConsole(batchId, { isBatch: true, focus: false });

                // Give report time to register
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (reportError) {
                this.logger.error('[BatchExecutionEngine] Failed to open report:', reportError instanceof Error ? reportError : undefined);
                // Continue execution even if report opening fails
            }

            // Send status update to any open report
            await this.sendStatusUpdateToReport(batchId, 'running');

            // Start per-second progress updates (GitHub Issue #70)
            this.startProgressTimer(batchState, expectedMemberCount, vscodeProgress);

            // Check if parallel processing is enabled and configured
            // Determine max concurrency (1 for sequential, >1 for parallel)
            const maxConcurrency = batchState.parallelConfig?.enabled && batchState.parallelConfig.maxConcurrency > 1
                ? batchState.parallelConfig.maxConcurrency
                : 1;

            this.logger.info(`[BatchExecutionEngine] Starting streaming execution with concurrency=${maxConcurrency} (${maxConcurrency === 1 ? 'sequential' : 'parallel'} mode)`);

            // ==================================================================
            // Producer-Consumer Pattern (GitHub Issue #TBD - Fix race condition)
            // ==================================================================
            // PRODUCER: Single thread monitors and prepares chunks (JIT refill)
            // CONSUMERS: Thread pool claims and executes transactions
            // This prevents race conditions where multiple threads call prepareNextChunk()

            // Start producer loop (single thread for JIT preparation)
            const producerPromise = this.runProducerLoop(batchId, batchState, maxConcurrency, token);

            // Start consumer loop (uses parallel execution path for both sequential and parallel modes)
            const consumerPromise = this.runConsumerLoop(
                batchId,
                batchState,
                batchMetadata,
                maxConcurrency,
                progressCallback,
                token,
                vscodeProgress
            );

            // Wait for both producer and consumer to complete (or be cancelled)
            await Promise.race([producerPromise, consumerPromise]);

            // GitHub Issue #266: a consumer loop ending does NOT necessarily mean the batch is
            // finished. Paginated batches fetch more pages under the SAME batchId (`rows` grows)
            // and another consumer loop may still be draining them. If we fall through to mark
            // COMPLETED + cleanupBatchMemory() here, we wipe the shared activeConsumerLoops /
            // batchStates maps for a batch that is still running (the page-0 executeBatch
            // finishing while the Fetch-All loop runs). Re-check the live state and bail if
            // another loop owns the batch or members are still pending.
            {
                const liveMeta = await this.dependencies.executionMetadataService.getExecution(batchId);
                const liveExpected = liveMeta?.rows ? this.parseExpectedMemberCount(liveMeta.rows) : (batchState?.totalMembers ?? 0);
                const liveDone = await this.getCompletedMembersCountFromDatabase(batchId);
                const loopStillActive = (this.activeConsumerLoops.get(batchId) || 0) > 0;
                if (loopStillActive || liveDone < liveExpected) {
                    this.logger.info(`[BatchExecutionEngine] issue#266 executeBatch: a loop for ${batchId} ended but the batch isn't finished (done=${liveDone}/${liveExpected}, activeLoops=${this.activeConsumerLoops.get(batchId) || 0}) — not completing/cleaning up; another loop owns it.`);
                    return batchState;
                }
            }

            // All members processed - complete the batch
            if (!batchState) {
                throw new Error(`[BatchExecutionEngine] Batch state not found for ${batchId}`);
            }

            this.stopProgressTimer(batchState); // Stop per-second updates (GitHub Issue #70)

            // GitHub Issue #151: Check if batch was already terminated (STOPPED/CANCELLED/PAUSED)
            // before setting to COMPLETED - prevents race condition overwrite
            if (batchState.status === BatchStatus.STOPPED || batchState.status === BatchStatus.CANCELLED || batchState.status === BatchStatus.PAUSED) {
                this.logger.info(`[BatchExecutionEngine] issue#151 Batch ${batchId} already terminated with status: ${batchState.status} - skipping COMPLETED transition`, undefined, {
                    batchId,
                    finalStatus: batchState.status,
                    completedMembers: batchState.completedMembers,
                    totalMembers: batchState.totalMembers
                });
                // Record telemetry for any members that did complete before termination
                await this.recordBatchTelemetry(batchId, batchState);
                // Clean up all in-memory data for this batch
                await this.cleanupBatchMemory(batchId);
                return batchState; // Return early - batch already has correct terminal status
            }

            // GitHub Issue #151: Debug - log completion trigger
            this.logger.info(`[BatchExecutionEngine] issue#151 BATCH COMPLETING: ${batchId}`, undefined, {
                completedMembers: batchState.completedMembers,
                totalMembers: batchState.totalMembers,
                previousStatus: batchState.status
            });
            const runTime = this.closeRunSession(batchState); // Issue #311
            batchState.status = BatchStatus.COMPLETED;
            batchState.completedAt = new Date();

            // Clean up active executions map (GitHub Issue #104)
            this.activeExecutionsMap.delete(batchId);

            // Broadcast batch completion (live streaming only, no file)
            await this.broadcastBatchEvent(batchId, {
                level: 'info',
                phase: 'orchestration',
                event: 'batch_execution_completed',
                data: {
                    batchId,
                    totalDuration: batchState.startedAt ? new Date().getTime() - batchState.startedAt.getTime() : 0,
                    finalStats: {
                        total: batchState.totalMembers,
                        completed: batchState.completedMembers,
                        successful: batchState.successfulMembers,
                        failed: batchState.failedMembers,
                        cancelled: batchState.cancelledMembers
                    },
                    successRate: Math.round((batchState.successfulMembers / batchState.totalMembers) * 100)
                }
            });

            // Record telemetry — count each completed batch member as an API call
            await this.recordBatchTelemetry(batchId, batchState);

            const finalBatchMemberProgress = {
                total: batchState.totalMembers,
                completed: batchState.successfulMembers,  // Use correct status
                error: batchState.failedMembers,         // Use correct status
                cancelled: batchState.cancelledMembers,
                pending: 0,
                running: 0
            };

            // #298: a paginated batch that started incomplete may have every page now
            await this.markPagesComplete(batchId).catch(error =>
                this.logger.warn(`[BatchExecutionEngine] Could not tell whether ${batchId} has every page`, error instanceof Error ? error : undefined));

            // Save completion data

            await this.updateBatchMetadata(batchId, {
                runTime, // Issue #311: total active run time, read back on resume after a reload
                status: BatchStatus.COMPLETED,
                completedAt: batchState.completedAt,
                membersProcessed: batchState.completedMembers,
                membersFailed: batchState.failedMembers,
                batchMemberProgress: finalBatchMemberProgress
            });

            // Send status update to any open report
            await this.sendStatusUpdateToReport(batchId, 'completed');

            // Update all UI components with unified status data
            try {
                const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
                if (batchMetadata) {
                    // Create unified status data - SINGLE SOURCE OF TRUTH
                    const unifiedStatus = this.createUnifiedBatchStatus(batchId, batchState, batchMetadata);

                    // Update all UI components with the same data
                    await this.updateUIWithUnifiedStatus(unifiedStatus, batchState);

                    // Route through ExecutionCoordinator if available (new architecture)
                    if (this.dependencies.executionCoordinator) {
                        await this.dependencies.executionCoordinator.updateExecutionState(batchId, batchMetadata);
                    }
                }
            } catch (error) {
                this.logger.warn('[BatchExecutionEngine] Failed to update UI on completion', error instanceof Error ? error : undefined);
            }

            if (progressCallback?.onBatchCompleted) {
                await progressCallback.onBatchCompleted(batchId, batchState);
            }

            // Show persistent batch completion message using unified status
            if (this.dependencies.progressManager?.showBatchCompletionMessage) {
                // Get the unified status we just created
                const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
                if (batchMetadata) {
                    const unifiedStatus = this.createUnifiedBatchStatus(batchId, batchState, batchMetadata);

                    // Focus/open the batch report instead of showing VS Code message
                    try {
                        await this.progressSink.openConsole(batchId, { isBatch: true, focus: true });
                    } catch (focusError) {
                        this.logger.error('[BatchExecutionEngine] Failed to focus report on completion:', focusError instanceof Error ? focusError : undefined);
                        // Fallback to simple info message if focus fails
                        this.dependencies.progressManager.showBatchCompletionMessage(batchId, {
                            completionText: `Batch completed: ${unifiedStatus.totalMembers} transactions`,
                            hasErrors: Object.keys(unifiedStatus.statusCounts).some(statusKey =>
                                (statusKey === 'error' || statusKey === 'failed' || statusKey === 'cancelled' || statusKey === 'stopped') &&
                                unifiedStatus.statusCounts[statusKey] > 0
                            ),
                            total: unifiedStatus.totalMembers
                        });
                    }
                }
            }

            // Note: Batch completion is handled by ExecutionCoordinator
            // No need to notify coordinator here to avoid circular dependency

            // Clean up all in-memory data for this batch
            await this.cleanupBatchMemory(batchId);

            return batchState;

        } catch (error) {
            this.logger.error(`[BatchExecutionEngine] Batch ${batchId} execution failed`, error instanceof Error ? error : undefined);

            // For validation errors (missing batch, wrong type, no members), re-throw
            if (error instanceof Error && (
                error.message.includes('not found') ||
                error.message.includes('not a batch execution') ||
                error.message.includes('No batch members found')
            )) {
                throw error;
            }

            // For other execution errors, return failed state
            const batchState = this.batchStates.get(batchId) || {
                batchId,
                totalMembers: 0,
                completedMembers: 0,
                failedMembers: 0,
                successfulMembers: 0,
                cancelledMembers: 0,
                currentMemberId: null,
                status: 'error',  // Default to ERROR for unexpected failures
                startedAt: new Date(),
                completedAt: new Date(),
                totalExecutionDuration: 0,
                completionTimestamps: [], // Throughput-based ETA calculation (GitHub Issue #104)
                lastEtaUpdate: undefined, // Progressive update frequency (GitHub Issue #104)
                progressTimer: undefined, // Per-second updates timer (GitHub Issue #70)
                // NEW: Error tolerance support (Issue #47) - fallback values
                toleranceConfig: undefined
            };

            // PRESERVE deliberate system decisions: STOPPED (system) vs CANCELLED (user)
            // Note: 'error' is not a valid batch status - use 'stopped' for unexpected failures
            let finalStatus: 'stopped' | 'cancelled';
            if (batchState.status === BatchStatus.STOPPED) {
                finalStatus = BatchStatus.STOPPED;  // System decision - preserve
            } else if (batchState.status === BatchStatus.CANCELLED) {
                finalStatus = BatchStatus.CANCELLED;  // User cancellation - preserve
            } else {
                finalStatus = BatchStatus.STOPPED;  // Unexpected system failure (use STOPPED, not 'error')
            }

            const runTime = this.closeRunSession(batchState); // Issue #311
            batchState.status = finalStatus;
            batchState.completedAt = new Date();
            this.batchStates.set(batchId, batchState);

            await this.updateBatchMetadata(batchId, {
                runTime,
                status: finalStatus,  // STOPPED=system, CANCELLED=user
                completedAt: batchState.completedAt,
                errorMessage: error instanceof Error ? error.message : 'Unknown batch execution error'
            });

            // GitHub Issue #123: Update report when batch fails with error
            await this.sendStatusUpdateToReport(
                batchId,
                finalStatus,
                error instanceof Error ? error.message : 'Unknown batch execution error'
            );

            // Clean up all in-memory data for this batch
            await this.cleanupBatchMemory(batchId);

            return batchState;
        }
    }

    /**
     * Clean up in-memory data after a batch reaches terminal state (memory leak prevention).
     * Deletes batch state, consumer loop tracking, and delegates member-level cleanup
     * to ExecutionService and ExecutionLoggingService.
     */
    private async cleanupBatchMemory(batchId: string): Promise<void> {
        try {
            // Clean up batch-level maps
            this.batchStates.delete(batchId);
            this.activeConsumerLoops.delete(batchId);
            this.activeExecutionsMap.delete(batchId);

            // Get member IDs for member-level cleanup
            const members = await this.getBatchMembers(batchId);
            const memberIds = members.map(m => m.id);

            // Clean up execution-level in-memory data
            if (memberIds.length > 0) {
                this.dependencies.executionService.cleanupExecutionMemory(memberIds);

                if (this.dependencies.executionLoggingService?.clearLogPathCache) {
                    this.dependencies.executionLoggingService.clearLogPathCache(memberIds);
                }
            }

            // Clean up progress manager batch result
            if (this.dependencies.progressManager?.clearBatchResult) {
                this.dependencies.progressManager.clearBatchResult(batchId);
            }

            this.logger.info(`[BatchExecutionEngine] Cleaned up memory for batch ${batchId} (${memberIds.length} members)`);
        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Memory cleanup failed for batch ${batchId}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Producer Loop - Single Thread for JIT Preparation
     * Monitors pending transaction count and triggers prepareNextChunk() when needed
     * This is the ONLY thread that calls prepareNextChunk() - prevents race conditions
     */
    private async runProducerLoop(
        batchId: string,
        batchState: BatchExecutionState,
        maxConcurrency: number,
        token?: any
    ): Promise<void> {
        // GitHub Issue #156: Initial concurrency for logging (dynamic value read inside loop)
        const initialConcurrency = batchState.parallelConfig?.maxConcurrency || maxConcurrency;
        const POLL_INTERVAL_MS = 100;

        this.logger.info(`[Producer] Starting JIT refill monitor for batch ${batchId}, initialConcurrency=${initialConcurrency}`);

        while (batchState.completedMembers < batchState.totalMembers) {
            // GitHub Issue #156: Read concurrency dynamically each iteration (allows runtime adjustment)
            const currentConcurrency = batchState.parallelConfig?.maxConcurrency || 1;
            const REFILL_THRESHOLD = currentConcurrency;

            // Check for pause/cancel/stop (status is the single source of truth — issue #266)
            const producerStatus = batchState.status as string;
            if (token?.isCancellationRequested
                || producerStatus === BatchStatus.PAUSED
                || producerStatus === BatchStatus.CANCELLED
                || producerStatus === BatchStatus.STOPPED) {
                this.logger.info(`[Producer] Stopping due to status='${producerStatus}'/cancel for batch ${batchId}`);
                // Signal JIT preparation to stop
                this.dependencies.transactionCreator?.cancelBatchPreparation?.(batchId);
                return;
            }

            // Check if batch was stopped (error tolerance exceeded)
            if (batchState.status === BatchStatus.STOPPED) {
                this.logger.info(`[Producer] Batch ${batchId} stopped, exiting producer loop`);
                return;
            }

            // Check if we need to trigger preparation of next chunk
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            const preparationState = batchMetadata?.preparationState;

            // GitHub Issue #151: Debug logging for producer loop
            this.logger.debug(`[Producer] issue#151 Checking preparation state for batch ${batchId}:`, undefined, {
                hasPreparationState: !!preparationState,
                isComplete: preparationState?.isComplete,
                preparedTransactions: preparationState?.preparedTransactions,
                totalTransactions: preparationState?.totalTransactions,
                nextCsvRowIndex: preparationState?.nextCsvRowIndex,
                totalRows: preparationState?.totalRows
            });

            if (preparationState && !preparationState.isComplete) {
                // Count pending members
                const pendingCount = await this.getPendingMemberCount(batchId);

                if (pendingCount < REFILL_THRESHOLD) {
                    this.logger.info(`[Producer] issue#151 Triggering chunk preparation: pending=${pendingCount} < threshold=${REFILL_THRESHOLD}, prepared=${preparationState.preparedTransactions}/${preparationState.totalTransactions}`);

                    // THIS IS THE ONLY PLACE prepareNextChunk() IS CALLED
                    // Single producer = no race conditions!
                    if (this.dependencies.transactionPreparationService?.prepareNextChunk) {
                        try {
                            const createdCount = await this.dependencies.transactionPreparationService.prepareNextChunk(batchId);
                            this.logger.info(`[Producer] issue#231 Chunk created: ${createdCount} members for batch ${batchId}, prepared=${preparationState.preparedTransactions}/${preparationState.totalTransactions}`);
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error));
                            this.logger.error(
                                `[Producer] issue#231 Chunk preparation FAILED for batch ${batchId}: ${err.message} | stack=${err.stack ?? '(no stack)'}`,
                                err,
                                {
                                    batchId,
                                    preparedTransactions: preparationState.preparedTransactions,
                                    totalTransactions: preparationState.totalTransactions,
                                    isComplete: preparationState.isComplete
                                }
                            );
                        }
                    }
                }
            }

            // Poll interval
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        this.logger.info(`[Producer] Completed for batch ${batchId}`);
    }

    /**
     * Consumer Loop - Thread Pool Execution
     * Claims and executes transactions using parallel thread pool pattern
     * Works for both sequential (concurrency=1) and parallel (concurrency>1) execution
     * Does NOT check or prepare chunks - that's the producer's job
     */
    private async runConsumerLoop(
        batchId: string,
        batchState: BatchExecutionState,
        batchMetadata: any,
        maxConcurrency: number,
        progressCallback?: BatchProgressCallback,
        token?: any,
        vscodeProgress?: any
    ): Promise<void> {
        // 🐛 DEBUG: Track consumer loop lifecycle
        const loopId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

        // GitHub Issue #110: Track this consumer loop to detect duplicates
        const currentLoopCount = (this.activeConsumerLoops.get(batchId) || 0) + 1;
        this.activeConsumerLoops.set(batchId, currentLoopCount);

        this.logger.info(`[Consumer] Starting execution for batch ${batchId} with concurrency=${maxConcurrency} (loopId: ${loopId}, loopNumber: ${currentLoopCount})`);

        // Main execution loop - continues until all members are completed
        // GitHub Issue #102: Use database count instead of in-memory counter to fix race condition
        let actualCompletedCount = await this.getCompletedMembersCountFromDatabase(batchId);
        let iterationCount = 0;

        // GitHub Issue #151: Debug - log loop entry condition
        this.logger.info(`[Consumer] issue#151 Loop starting: actualCompletedCount=${actualCompletedCount}, totalMembers=${batchState.totalMembers}, loopId=${loopId}`);

        try {
        while (actualCompletedCount < batchState.totalMembers) {
            iterationCount++;
            // GitHub Issue #156: Read concurrency dynamically each iteration (allows runtime adjustment)
            const currentConcurrency = batchState.parallelConfig?.maxConcurrency || 1;

            // Check if batch was stopped (error tolerance exceeded)
            if (batchState.status === BatchStatus.STOPPED) {
                this.logger.info(`[Consumer] Batch ${batchId} already stopped, exiting execution loop`);
                this.activeExecutionsMap.delete(batchId);
                return;
            }

            // GitHub Issue #266: STATUS is the single source of truth. pauseBatch/cancelBatch
            // set batchState.status synchronously on this loop's object, which survives even if
            // the shared maps get cleaned by a sibling executeBatch for the same paginated batch.
            const liveStatus = batchState.status as string;
            if (token?.isCancellationRequested
                || liveStatus === BatchStatus.PAUSED || liveStatus === BatchStatus.CANCELLED) {
                const reason = token?.isCancellationRequested ? 'User cancelled execution' : 'Interrupted by higher priority execution';
                const status = (token?.isCancellationRequested || liveStatus === BatchStatus.CANCELLED)
                    ? BatchStatus.CANCELLED : BatchStatus.PAUSED;

                // Signal JIT preparation to stop
                this.dependencies.transactionCreator?.cancelBatchPreparation?.(batchId);

                this.stopProgressTimer(batchState);
                const runTime = this.closeRunSession(batchState); // Issue #311
                batchState.status = status as any;
                batchState.pausedAt = new Date();
                this.activeExecutionsMap.delete(batchId);

                if (progressCallback?.onBatchPaused) {
                    await progressCallback.onBatchPaused(batchId, reason);
                }

                await this.updateBatchMetadata(batchId, {
                    runTime,
                    status: status,
                    completedAt: new Date(),
                    cancelReason: reason
                });

                return;
            }

            // #344: what it runs on went away mid-run (DBMN for VS Code closed): nothing new starts
            // until it's back; then round the loop, where a Pause or Cancel made meanwhile is seen
            if (await this.holdWhileAway(batchId, batchState, batchMetadata, vscodeProgress, token)) continue;

            // Execute using parallel thread pool (works for both concurrency=1 and concurrency>1)
            // Parallel path with maxConcurrency=1 provides sequential execution with proper streaming
            // GitHub Issue #156: Use currentConcurrency (dynamic) instead of maxConcurrency (static)
            await this.executeParallelBatch(batchId, batchState, batchMetadata, currentConcurrency, progressCallback, token);

            // GitHub Issue #102: Refresh completed count from database at end of loop iteration
            actualCompletedCount = await this.getCompletedMembersCountFromDatabase(batchId);

            // Sync in-memory counter with database for accurate display (status bar, ETA, etc.)
            batchState.completedMembers = actualCompletedCount;
        }

        // GitHub Issue #151: Debug - log WHY consumer loop exited
        const finalCompletedCount = await this.getCompletedMembersCountFromDatabase(batchId);
        this.logger.info(`[Consumer] issue#151 Loop EXITING: loopId=${loopId}, finalCompletedCount=${finalCompletedCount}, totalMembers=${batchState.totalMembers}, iterations=${iterationCount}, batchStatus=${batchState.status}`);
        } finally {
            // GitHub Issue #110/#266: ALWAYS decrement on exit (normal completion, pause, OR
            // stopped early-returns) so executeBatch's re-entrancy guard sees an accurate
            // active-loop count. Previously the pause/stop returns skipped this, leaving a stale
            // count that would wrongly suppress the next real run.
            const remainingLoops = (this.activeConsumerLoops.get(batchId) || 1) - 1;
            this.activeConsumerLoops.set(batchId, remainingLoops);
        }
    }

    /**
     * Execute batch members in parallel (thread pool pattern)
     * GitHub Issue #104: Continuous thread pool execution
     */
    private async executeParallelBatch(
        batchId: string,
        batchState: BatchExecutionState,
        batchMetadata: any,
        maxConcurrency: number,
        progressCallback?: BatchProgressCallback,
        token?: any
    ): Promise<void> {
        const activeExecutions = this.getOrCreateActiveExecutions(batchId);

        // Calculate how many slots are available
        const availableSlots = maxConcurrency - activeExecutions.size;

        if (availableSlots > 0) {
            // Claim multiple pending members atomically
            const pendingMembers = await this.claimPendingMembers(batchId, availableSlots);

            // Launch all fetched members in parallel
            // GitHub Issue #104: Calculate memberIndex BEFORE launching to avoid race condition
            let nextMemberIndex = batchState.completedMembers + 1;
            for (const member of pendingMembers) {
                const executionPromise = this.executeSingleMember(
                    batchId,
                    batchState,
                    batchMetadata,
                    member,
                    progressCallback,
                    token,
                    activeExecutions,
                    nextMemberIndex
                );
                activeExecutions.set(member.id, executionPromise);
                nextMemberIndex++;
            }

            // Notify Console webview that these members are now running
            if (pendingMembers.length > 0) {
                // Build executionId → memberIndex map so webview can display correct transaction numbers
                const memberIndices: Record<string, number> = {};
                // Build per-member endpoint info so RAW tab shows correct query params during live execution
                const memberEndpointInfo: Record<string, { endpointPath?: string; requestHeaders?: Record<string, string>; requestQueryParams?: Record<string, string> }> = {};
                let memberIdx = batchState.completedMembers + 1;
                for (const member of pendingMembers) {
                    memberIndices[member.id] = memberIdx;
                    if (member.endpointPath || member.requestQueryParams || member.requestHeaders) {
                        memberEndpointInfo[member.id] = {
                            endpointPath: member.endpointPath,
                            requestHeaders: member.requestHeaders,
                            requestQueryParams: member.requestQueryParams
                        };
                    }
                    memberIdx++;
                }
                this.sendMemberStatusUpdateToConsole(
                    batchId,
                    pendingMembers.map(m => m.id),
                    'running',
                    memberIndices,
                    memberEndpointInfo
                );
            }
        }

        // Wait for at least one execution to complete
        if (activeExecutions.size > 0) {
            await Promise.race(Array.from(activeExecutions.values()));
        } else {
            // No pending members yet - wait for producer to create more
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }


    /**
     * GitHub Issue #266: Is this batch paused, or pause-requested but not yet
     * settled? Used by the pagination fetch paths so they don't create/run more
     * pages (and overwrite the paused status) while a pause is in flight. Checks
     * the immediate in-memory signal first (set synchronously by pauseBatch before
     * the DB status update lands), then the in-memory batch status.
     */
    public isPausing(batchId: string): boolean {
        const status = this.batchStates.get(batchId)?.status;
        return status === BatchStatus.PAUSED
            || status === BatchStatus.CANCELLED
            || status === BatchStatus.STOPPED;
    }

    /**
     * Pause the currently running batch
     */
    async pauseBatch(batchId: string, reason: string): Promise<void> {
        // GitHub Issue #266: status is the single source of truth. Set it synchronously on the
        // in-memory batchState — the running consumer/producer loops hold this same object and
        // check `status` each iteration, so they stop. (No separate pause-signal map anymore.)
        const batchState = this.batchStates.get(batchId);
        if (batchState && (batchState.status === 'running' || batchState.status === 'pending')) {
            const runTime = this.closeRunSession(batchState); // Issue #311
            batchState.status = 'paused';
            batchState.pausedAt = new Date();

            // Broadcast batch paused (live streaming only, no file)
            await this.broadcastBatchEvent(batchId, {
                level: 'warn',
                phase: 'orchestration',
                event: 'batch_execution_paused',
                data: {
                    batchId,
                    reason,
                    currentMemberId: batchState.currentMemberId,
                    progress: {
                        completed: batchState.completedMembers,
                        total: batchState.totalMembers,
                        successful: batchState.successfulMembers,
                        failed: batchState.failedMembers
                    }
                }
            });

            await this.updateBatchMetadata(batchId, {
                runTime,
                status: 'paused',
                pausedAt: batchState.pausedAt,
                pauseReason: reason
            });

            // Send status update to any open report
            await this.sendStatusUpdateToReport(batchId, 'paused', reason);
        }
    }

    /**
     * Resume a paused or cancelled batch from where it left off
     */
    async resumeBatch(batchId: string): Promise<BatchExecutionState> {
        this.logger.debug(`[BatchExecutionEngine] resumeBatch called for: ${batchId}`);

        let batchState = this.batchStates.get(batchId);

        // If no in-memory state, try to reconstruct from database (happens after extension reload)
        if (!batchState) {
            this.logger.debug(`[BatchExecutionEngine] No in-memory state found, reconstructing from database...`);
            batchState = await this.reconstructBatchState(batchId);
        }

        // GitHub Issue #151: Allow resume for paused, cancelled, AND stopped batches
        // Stopped batches can be resumed via Enhanced Resume dialog
        const resumableStates = ['paused', 'cancelled', 'stopped'];
        if (!resumableStates.includes(batchState.status)) {
            throw new Error(`Batch ${batchId} cannot be resumed (current: ${batchState.status}). Only paused, cancelled, or stopped batches can be resumed.`);
        }

        this.logger.debug(`[BatchExecutionEngine] Resuming ${batchState.status} batch: ${batchId}`, undefined, { batchId, status: batchState.status });
        this.logger.debug(`[BatchExecutionEngine] Progress: ${batchState.completedMembers}/${batchState.totalMembers} members completed`, undefined, {
            batchId,
            completedMembers: batchState.completedMembers,
            totalMembers: batchState.totalMembers
        });

        // GitHub Issue #151: Reset batch status to 'pending' so execution loops don't exit immediately
        // The producer/consumer loops check for 'stopped' status and exit if found
        const previousStatus = batchState.status;
        batchState.status = BatchStatus.PENDING;
        this.batchStates.set(batchId, batchState);

        // Get batch metadata to check preparation state
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
        const preparationState = batchMetadata?.preparationState;

        // GitHub Issue #151: Debug logging - show full preparation state
        this.logger.info(`[BatchExecutionEngine] issue#151 Resume - Current preparationState for batch ${batchId}:`, undefined, {
            preparationState: preparationState,
            isComplete: preparationState?.isComplete,
            preparedTransactions: preparationState?.preparedTransactions,
            totalTransactions: preparationState?.totalTransactions,
            nextCsvRowIndex: preparationState?.nextCsvRowIndex,
            totalRows: preparationState?.totalRows
        });

        // GitHub Issue #151: ALWAYS reset preparationState.isComplete to false for stopped batches
        // This allows the producer loop to continue preparing chunks
        // The producer loop will re-evaluate and set isComplete=true when actually done
        let updatedPreparationState = preparationState;
        if (preparationState && previousStatus === 'stopped') {
            this.logger.info(`[BatchExecutionEngine] issue#151 FORCING preparationState.isComplete=false for stopped batch ${batchId}`);
            updatedPreparationState = {
                ...preparationState,
                isComplete: false
            };
        }

        // Also update database status to 'pending' and reset preparation state
        const metadataUpdate: any = {
            status: 'pending',
            errorMessage: undefined // Clear error message on resume
        };

        if (updatedPreparationState && updatedPreparationState !== preparationState) {
            metadataUpdate.preparationState = updatedPreparationState;
        }

        this.logger.info(`[BatchExecutionEngine] issue#151 Updating batch metadata:`, undefined, metadataUpdate);
        await this.updateBatchMetadata(batchId, metadataUpdate);

        this.logger.info(`[BatchExecutionEngine] Reset batch ${batchId} status from '${previousStatus}' to 'pending' for resume`);

        // Safety net: Reset any orphaned running batch members to pending
        await this.cleanupOrphanedBatchMembers(batchId);

        // Issue #311: the tallies the Console paints its progress count from
        await this.syncCountsFromDatabase(batchId, batchState);

        // Continue execution from where we left off (no progress bar for resume currently)
        return await this.executeBatch(batchId);
    }

    /**
     * Cancel a batch execution (#335). Unlike Pause, which lets the requests in flight finish,
     * Cancel aborts every one of them (all its threads), and no more are sent. Aborted members
     * are recorded as cancelled, never as errors.
     */
    async cancelBatch(batchId: string): Promise<void> {
        this.logger.debug(`[BatchExecutionEngine] cancelBatch called for batch: ${batchId}`);

        const batchState = this.batchStates.get(batchId);
        // Stop first, so no thread starts another member while the running ones are aborted
        if (batchState) batchState.status = BatchStatus.CANCELLED;
        const inFlight = new Set<string>(this.activeExecutionsMap.get(batchId)?.keys() ?? []);
        if (batchState?.currentMemberId) inFlight.add(batchState.currentMemberId);
        for (const memberId of inFlight) {
            try {
                await this.dependencies.executionService.cancel(memberId);
            } catch (error) {
                // Continue with batch cancellation even if a member's cancel fails
                this.logger.warn(`[BatchExecutionEngine] Failed to cancel member ${memberId}`, error instanceof Error ? error : undefined, { batchId, memberId });
            }
        }
        this.logger.debug(`[BatchExecutionEngine] Cancelled ${inFlight.size} request(s) in flight`, undefined, { batchId });

        // GitHub Issue #266: status drives loop termination (set on batchState below); the
        // in-flight member was already aborted above. No separate pause-signal map.

        // Update batch state
        if (batchState) {
            this.logger.debug(`[BatchExecutionEngine] Found batch state, current status: ${batchState.status}`, undefined, {
                batchId,
                status: batchState.status
            });
            this.closeRunSession(batchState); // Issue #311
            batchState.status = 'cancelled';
            batchState.completedAt = new Date();
            batchState.currentMemberId = null; // Clear current member since we cancelled it
            this.logger.debug(`[BatchExecutionEngine] Updated batch state to cancelled`);
        } else {
            this.logger.debug(`[BatchExecutionEngine] No batch state found in memory for batch: ${batchId}`, undefined, { batchId });
        }

        this.logger.debug(`[BatchExecutionEngine] Updating batch metadata in storage...`);
        await this.updateBatchMetadata(batchId, {
            status: 'cancelled',
            completedAt: new Date(),
            runTime: batchState ? batchState.activeRunMs : undefined, // Issue #311
            cancelReason: 'Batch execution cancelled by user - current execution stopped immediately'
        });

        // Send status update to any open report
        await this.sendStatusUpdateToReport(batchId, 'cancelled', 'Batch execution cancelled by user');
        this.logger.debug(`[BatchExecutionEngine] Batch metadata updated successfully`);

        // Note: Don't clean up pause signal here - let execution loop detect it
        // The execution loop will clean up state when it detects the pause signal
    }

    /**
     * Get current state of a batch execution
     */
    async getBatchState(batchId: string): Promise<BatchExecutionState | null> {
        return this.batchStates.get(batchId) || null;
    }

    /**
     * Parse expected member count from batch.rows field
     * Example: "103(300)" → 103 (number of transactions to create)
     */
    private parseExpectedMemberCount(rowsField: string): number {
        // Match pattern: "103(300)" or just "103"
        const match = rowsField.match(/^(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    /**
     * Get count of pending batch members (for JIT refill monitoring)
     * GitHub Issue #94 - Used to determine when to trigger next chunk preparation
     */
    private async getPendingMemberCount(batchId: string): Promise<number> {
        const counts = await this.countMembersByStatus(batchId);
        return counts ? (counts.pending || 0) : 0;
    }

    /**
     * Issue #312: member counts per status from ONE GROUP BY query. The producer
     * (every 100 ms) and the consumer (after every member) used to load every
     * member row as an object to count it — 48,000 rows, hundreds of ms, over
     * and over — which pinned the extension host for the life of a big batch:
     * Console loads crawled, Settings changes lagged, and the moment the batch
     * was paused everything flew. Falls back to the slow way for a storage
     * without the query.
     */
    private async countMembersByStatus(batchId: string): Promise<Record<string, number> | null> {
        const service = this.dependencies.executionMetadataService;
        if (service?.countBatchMembersByStatus) {
            return service.countBatchMembersByStatus(batchId);
        }
        if (!service?.getBatchMemberExecutions) return null;
        const counts: Record<string, number> = {};
        for (const m of await service.getBatchMemberExecutions(batchId)) {
            counts[m.status] = (counts[m.status] || 0) + 1;
        }
        return counts;
    }

    /**
     * Claim pending batch members atomically (GitHub Issue #110: Fix duplicate execution race condition)
     *
     * Delegates to storage service's atomic claim method which uses IMMEDIATE transaction
     * to lock database during entire claim operation (SELECT → UPDATE → RETURN).
     *
     * This makes duplicate execution IMPOSSIBLE by design - no guards, no checks.
     *
     * @param batchId - The batch ID to claim members from
     * @param limit - Maximum number of members to claim
     * @returns Array of claimed members (now marked as 'running' in database)
     */
    private async claimPendingMembers(batchId: string, limit: number): Promise<any[]> {
        if (!this.dependencies.executionMetadataService?.claimPendingBatchMembers) {
            this.logger.error('[BatchExecutionEngine] Storage service does not support atomic claiming!', undefined);
            return [];
        }

        // Use atomic claim method from storage service
        // This performs SELECT-UPDATE-RETURN in a single IMMEDIATE transaction
        const claimedMembers = await this.dependencies.executionMetadataService.claimPendingBatchMembers(batchId, limit);

        // GitHub Issue #110: Filter out members already in activeExecutions (in-memory guard)
        // This prevents database race conditions where UPDATE doesn't prevent duplicate claims
        const activeExecutions = this.getOrCreateActiveExecutions(batchId);
        const filteredMembers = claimedMembers.filter((m: any) => !activeExecutions.has(m.id));
        const removedDuplicates = claimedMembers.length - filteredMembers.length;

        if (removedDuplicates > 0) {
            this.logger.warn(`[BatchExecutionEngine] Filtered ${removedDuplicates} duplicate(s) already in activeExecutions for batch ${batchId}`);
        }

        return filteredMembers;
    }

    /**
     * Get accurate count of completed members from database (GitHub Issue #102 - Race condition fix)
     * Queries database instead of relying on in-memory counter which has race conditions in parallel execution
     *
     * @param batchId - The batch ID to count completed members for
     * @returns Number of completed members (status='completed' or 'error' or 'cancelled')
     */
    private async getCompletedMembersCountFromDatabase(batchId: string): Promise<number> {
        const counts = await this.countMembersByStatus(batchId);
        if (!counts) return 0;
        // Members with terminal statuses (completed, error, cancelled, split)
        return ['completed', 'error', 'cancelled', 'split'].reduce((n, st) => n + (counts[st] || 0), 0);
    }

    /**
     * Get or create active executions map for a batch (GitHub Issue #104)
     */
    private getOrCreateActiveExecutions(batchId: string): Map<string, Promise<void>> {
        let activeExecutions = this.activeExecutionsMap.get(batchId);
        if (!activeExecutions) {
            activeExecutions = new Map<string, Promise<void>>();
            this.activeExecutionsMap.set(batchId, activeExecutions);
        }
        return activeExecutions;
    }

    /**
     * Execute a single batch member in continuous thread pool mode (GitHub Issue #104)
     * Automatically removes itself from activeExecutions map when complete
     */
    private async executeSingleMember(
        batchId: string,
        batchState: any,
        batchMetadata: any,
        member: any,
        progressCallback: BatchProgressCallback | undefined,
        token: CancellationFlag | undefined,
        activeExecutions: Map<string, Promise<void>>,
        memberIndex: number // GitHub Issue #104: Passed from main loop to avoid race condition
    ): Promise<void> {

        try {
            // Transition from 'pending' to 'running' on first member execution (GitHub Issue #94)
            if (batchState.completedMembers === 0) {
                batchState.status = BatchStatus.RUNNING;
                batchState.startedAt = new Date();
                this.logger.info(`[BatchExecutionEngine] Batch ${batchId} transitioning PENDING → RUNNING (first member execution starting)`);

                await this.updateBatchMetadata(batchId, {
                    status: 'running',
                    startedAt: batchState.startedAt
                });

                await this.sendStatusUpdateToReport(batchId, 'running');

                await this.broadcastBatchEvent(batchId, {
                    level: 'info',
                    phase: 'orchestration',
                    event: 'batch_execution_started',
                    data: {
                        batchId,
                        totalMembers: batchState.totalMembers,
                        endpointName: batchMetadata.endpointName,
                        environment: batchMetadata.environment
                    }
                });
            }

            // Check for pause/cancel before starting this member (status is the source of truth — issue #266)
            if (token?.isCancellationRequested
                || batchState?.status === BatchStatus.PAUSED
                || batchState?.status === BatchStatus.CANCELLED
                || batchState?.status === BatchStatus.STOPPED) {
                activeExecutions.delete(member.id);
                return;
            }

            // Broadcast member started
            await this.broadcastBatchEvent(batchId, {
                level: 'info',
                phase: 'orchestration',
                event: 'batch_member_started',
                data: {
                    batchId,
                    memberId: member.id,
                    memberIndex,
                    totalMembers: batchState.totalMembers,
                    endpointName: member.endpointName,
                    rows: member.rows || '1'
                }
            });

            if (progressCallback?.onMemberStarted) {
                await progressCallback.onMemberStarted(batchId, member.id, memberIndex, batchState.totalMembers);
            }

            // Execute the member
            // GitHub Issue #160: Use environmentId (UUID) not environment (name) to prevent
            // batch execution from switching to the currently active environment
            this.logger.debug(`[BatchExecutionEngine] issue#160 Executing member ${member.id} with environment: name="${batchMetadata.environment}", id="${batchMetadata.environmentId}"`);
            let memberResult = await this.dependencies.executionService.executeRecord(member.id, {
                parentBatch: batchMetadata,
                environmentId: batchMetadata.environmentId,
                memberCount: batchState.totalMembers // #436: a page's download progress only while it's the only one
            });

            // Silent refresh on 401: a member that fails with 401 gets new credentials for its
            // environment (the DBMN session; #359: an OAuth refresh token) and runs once more
            // before the batch stops. Mid-batch token expiry needs no one.
            if (!memberResult.success && memberResult.httpStatus === 401) {
                const refreshed = await this.refreshAfterUnauthorized(batchMetadata.environmentId);
                if (refreshed !== undefined) {
                    if (refreshed) {
                        this.logger.info(`[BatchExecutionEngine] credentials refreshed after 401, retrying member ${member.id}`);
                        // Reset member to pending so executeRecord accepts it
                        await this.dependencies.executionMetadataService.updateExecution(member.id, { status: 'pending' });
                        memberResult = await this.dependencies.executionService.executeRecord(member.id, {
                            parentBatch: batchMetadata,
                            environmentId: batchMetadata.environmentId,
                            memberCount: batchState.totalMembers
                        });
                    } else {
                        this.logger.info(`[BatchExecutionEngine] credentials refresh failed after 401 — batch will stop`);
                    }
                }
            }

            // A page of Fetch all / Next pages that failed for a moment (a busy server's 429 or 5xx,
            // the network dropping) is asked for again, twice at most, before it counts as an error.
            // Pages only: they are reads. A batch that writes is never retried (page-retry.ts).
            if (isPaginatedBatch(batchMetadata)) {
                for (const delay of PAGE_RETRY_DELAYS_MS) {
                    if (!isTemporaryPageFailure(memberResult) || this.isMemberRunStopped(batchState, token)) break;
                    this.logger.info(`[BatchExecutionEngine] page ${member.id} failed for a moment (${memberResult.httpStatus ?? 'no answer'}): asking again in ${delay} ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    if (this.isMemberRunStopped(batchState, token)) break;
                    await this.dependencies.executionMetadataService.updateExecution(member.id, { status: 'pending' });
                    memberResult = await this.dependencies.executionService.executeRecord(member.id, {
                        parentBatch: batchMetadata,
                        environmentId: batchMetadata.environmentId,
                        memberCount: batchState.totalMembers
                    });
                }
            }

            const batchMemberResult: BatchMemberResult = {
                ...memberResult,
                memberIndex
            };

            // Update batch state
            if (memberResult.success) {
                batchState.successfulMembers++;
                batchState.completedMembers++;
                this.recordMemberTelemetry(batchId, batchMetadata, batchState, member, true);
                batchState.totalExecutionDuration += memberResult.duration || 0;
                this.trackCompletion(batchState);

                await this.broadcastBatchEvent(batchId, {
                    level: 'info',
                    phase: 'orchestration',
                    event: 'batch_member_completed',
                    data: {
                        batchId,
                        memberId: member.id,
                        memberIndex,
                        success: true,
                        httpStatus: memberResult.httpStatus,
                        duration: memberResult.duration,
                        progress: {
                            completed: batchState.completedMembers,
                            total: batchState.totalMembers,
                            successful: batchState.successfulMembers,
                            failed: batchState.failedMembers
                        }
                    },
                    http: {
                        status: memberResult.httpStatus,
                        statusText: memberResult.httpStatusText,
                        duration: memberResult.duration
                    }
                });
            } else if (memberResult.cancelled) {
                // #335: Cancel aborted it in flight: not a failure, and never a reason to stop.
                // The open Console still shows it Running until it's told.
                this.logger.info(`[BatchExecutionEngine] member ${member.id} cancelled in flight`);
                this.sendMemberStatusUpdateToConsole(batchId, [member.id], 'cancelled');
            } else {
                batchState.failedMembers++;
                batchState.completedMembers++;
                this.recordMemberTelemetry(batchId, batchMetadata, batchState, member, false);
                batchState.totalExecutionDuration += memberResult.duration || 0;
                this.trackCompletion(batchState);

                await this.broadcastBatchEvent(batchId, {
                    level: 'error',
                    phase: 'orchestration',
                    event: 'batch_member_failed',
                    data: {
                        batchId,
                        memberId: member.id,
                        memberIndex,
                        success: false,
                        httpStatus: memberResult.httpStatus,
                        duration: memberResult.duration,
                        progress: {
                            completed: batchState.completedMembers,
                            total: batchState.totalMembers,
                            successful: batchState.successfulMembers,
                            failed: batchState.failedMembers
                        }
                    },
                    error: {
                        message: memberResult.errorMessage || 'Unknown error',
                        httpStatus: memberResult.httpStatus
                    },
                    http: {
                        status: memberResult.httpStatus,
                        statusText: memberResult.httpStatusText,
                        duration: memberResult.duration
                    }
                });

                // Check error tolerance. #344: a request lost when DBMN for VS Code closed counts like
                // any error: it may have half-happened, which is what "stop at the first error" is for.
                // A batch still under its limit waits for VS Code instead (holdWhileAway).
                // Only the first failure stops it: threads failing together (VS Code closing under
                // four requests) would each stop it and say so. Checked after the await, where the
                // stop below is set before anything else can run.
                if (await this.shouldFailBatch(batchId, memberResult) && batchState.status !== BatchStatus.STOPPED) {
                    // GitHub Issue #151: Log STOPPED transition with full context
                    this.logger.info(`[BatchExecutionEngine] issue#151 STOPPING BATCH: ${batchId} - error tolerance exceeded`, undefined, {
                        memberId: member.id,
                        errorMessage: memberResult.errorMessage,
                        currentStatus: batchState.status,
                        failedMembers: batchState.failedMembers,
                        completedMembers: batchState.completedMembers
                    });

                    batchMemberResult.causedBatchFailure = true;
                    const runTime = this.closeRunSession(batchState); // Issue #311
                    batchState.status = BatchStatus.STOPPED;
                    batchState.completedAt = new Date();

                    // GitHub Issue #159: Format error message with transaction context
                    // Note: memberIndex is already 1-based (calculated as completedMembers + 1 in executeParallelBatch)
                    const stopErrorMessage = `Batch stopped: Transaction ${memberIndex} failed - ${memberResult.errorMessage}`;

                    await this.updateBatchMetadata(batchId, {
                        runTime,
                        status: batchState.status,
                        completedAt: batchState.completedAt,
                        errorMessage: stopErrorMessage
                    });

                    await this.sendStatusUpdateToReport(batchId, 'stopped', stopErrorMessage);
                }
            }

            if (progressCallback?.onMemberCompleted) {
                await progressCallback.onMemberCompleted(batchId, batchMemberResult, batchState);
            }

            await this.sendMemberResultToReport(batchId, member.id, memberResult, memberIndex, batchState.totalMembers);
            await this.updateBatchStatusBar(batchId, batchState);

        } catch (error) {
            batchState.failedMembers++;
            batchState.completedMembers++;
            this.recordMemberTelemetry(batchId, batchMetadata, batchState, member, false);

            this.logger.error(`[BatchExecutionEngine] Member ${memberIndex} execution failed`, error instanceof Error ? error : new Error(String(error)));

            const memberResult: BatchMemberResult = {
                success: false,
                executionId: member.id,
                duration: 0,
                errorMessage: error instanceof Error ? error.message : 'Unknown execution error',
                memberIndex
            };

            if (progressCallback?.onMemberCompleted) {
                await progressCallback.onMemberCompleted(batchId, memberResult, batchState);
            }
        } finally {
            // Always remove from active executions when done (GitHub Issue #104)
            activeExecutions.delete(member.id);
        }
    }

    /**
     * Get all batch members for a batch execution
     */
    async getBatchMembers(batchId: string): Promise<any[]> {

        if (!this.dependencies.executionMetadataService?.getBatchMemberExecutions) {
            this.logger.warn(`[BatchExecutionEngine] getBatchMemberExecutions method not available, returning empty array`);
            return [];
        }

        // Use the correct method that exists on the service interface
        const batchMembers = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);

        // Sort by creation time to maintain order (method already returns filtered results)
        return batchMembers.sort((a: any, b: any) => {
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
    }

    /**
     * Reconstruct batch state from database (used after extension reload)
     */
    private async reconstructBatchState(batchId: string): Promise<BatchExecutionState> {
        this.logger.debug(`[BatchExecutionEngine] Reconstructing batch state for: ${batchId}`, undefined, { batchId });

        // Get batch metadata from database
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
        if (!batchMetadata) {
            throw new Error(`Batch execution ${batchId} not found in database`);
        }

        // Verify it's a batch execution
        if (batchMetadata.executionType !== 'batch') {
            throw new Error(`Execution ${batchId} is not a batch execution`);
        }

        // Get all batch members
        const batchMembers = await this.getBatchMembers(batchId);
        if (batchMembers.length === 0) {
            throw new Error(`No batch members found for batch ${batchId}`);
        }

        // Count completed members by checking their status
        let completedMembers = 0;
        let successfulMembers = 0;
        let failedMembers = 0;

        for (const member of batchMembers) {
            if (['completed', 'error', 'cancelled'].includes(member.status)) {
                completedMembers++;
                if (member.status === 'completed') {
                    successfulMembers++;
                } else {
                    failedMembers++;
                }
            }
        }

        // GitHub Issue #151: Use totalTransactions from preparationState for true total
        // When a batch is stopped early, batchMembers.length only reflects prepared members,
        // not the total number of transactions that SHOULD be prepared from CSV rows
        const preparationState = batchMetadata.preparationState;
        let totalMembers = batchMembers.length;

        if (preparationState?.totalTransactions && preparationState.totalTransactions > batchMembers.length) {
            this.logger.info(`[BatchExecutionEngine] issue#151 Using preparationState.totalTransactions (${preparationState.totalTransactions}) instead of batchMembers.length (${batchMembers.length})`);
            totalMembers = preparationState.totalTransactions;
        } else if (preparationState?.totalRows && preparationState.totalRows > batchMembers.length) {
            // Fallback to totalRows if totalTransactions not available
            this.logger.info(`[BatchExecutionEngine] issue#151 Using preparationState.totalRows (${preparationState.totalRows}) instead of batchMembers.length (${batchMembers.length})`);
            totalMembers = preparationState.totalRows;
        }

        // Read error tolerance configuration for reconstructed state
        const toleranceConfig = await this.readErrorToleranceConfig(batchId, totalMembers);

        // Read parallel processing configuration for reconstructed state (GitHub Issue #78)
        const parallelConfig = await this.readParallelProcessingConfig(batchId);

        // GitHub Issue #156: Read environment's ACTUAL max concurrency for reconstructed state
        const environmentMaxConcurrency = await this.readEnvironmentMaxConcurrency(batchId);

        // Reconstruct batch state
        const reconstructedState: BatchExecutionState = {
            batchId,
            totalMembers,
            completedMembers,
            failedMembers,
            successfulMembers,
            cancelledMembers: 0, // We don't track cancelled members separately yet
            currentMemberId: null, // Will be set when execution resumes
            status: batchMetadata.status as any, // Should be 'paused' or 'cancelled'
            startedAt: new Date(batchMetadata.createdAt),
            pausedAt: batchMetadata.completedAt ? new Date(batchMetadata.completedAt) : undefined,
            activeRunMs: batchMetadata.runTime || 0, // Issue #311: run time from before the reload
            totalExecutionDuration: 0, // Reset for reprocessing - will accumulate from actual executions
            completionTimestamps: [], // Throughput-based ETA calculation (GitHub Issue #104)
            lastEtaUpdate: undefined, // Progressive update frequency (GitHub Issue #104)
            progressTimer: undefined, // Per-second updates timer (GitHub Issue #70)
            // NEW: Error tolerance support (Issue #47)
            toleranceConfig: toleranceConfig,

            // NEW: Parallel processing support (GitHub Issue #78)
            parallelConfig: parallelConfig,

            // GitHub Issue #156: Environment's max concurrency for Settings tab validation
            environmentMaxConcurrency: environmentMaxConcurrency
        };

        this.logger.debug(`[BatchExecutionEngine] Reconstructed state`, undefined, { batchId, reconstructedState });

        // Store the reconstructed state in memory
        this.batchStates.set(batchId, reconstructedState);

        return reconstructedState;
    }

    /**
     * Safety net: Clean up any orphaned running batch members
     * This handles cases where startup recovery missed some batch members
     */
    private async cleanupOrphanedBatchMembers(batchId: string): Promise<void> {
        this.logger.debug(`[BatchExecutionEngine] Checking for orphaned running batch members for batch: ${batchId}`, undefined, { batchId });

        try {
            // Get all batch members for this batch
            const batchMembers = await this.getBatchMembers(batchId);
            const runningMembers = batchMembers.filter(member => member.status === 'running');

            if (runningMembers.length === 0) {
                this.logger.debug(`[BatchExecutionEngine] No orphaned running batch members found for batch: ${batchId}`, undefined, { batchId });
                return;
            }

            this.logger.debug(`[BatchExecutionEngine] Found ${runningMembers.length} orphaned running batch members, resetting to pending...`, undefined, {
                batchId,
                orphanedCount: runningMembers.length
            });

            // Reset each running member to pending
            for (const member of runningMembers) {
                this.logger.debug(`[BatchExecutionEngine] Resetting orphaned batch member ${member.id} from 'running' to 'pending'`, undefined, {
                    batchId,
                    memberId: member.id
                });

                await this.dependencies.executionMetadataService.updateExecution(member.id, {
                    status: 'pending'
                });

                this.logger.debug(`[BatchExecutionEngine] Successfully reset batch member ${member.id} to pending`, undefined, {
                    batchId,
                    memberId: member.id
                });
            }

            this.logger.debug(`[BatchExecutionEngine] Completed cleanup of ${runningMembers.length} orphaned batch members`, undefined, {
                batchId,
                cleanedCount: runningMembers.length
            });

        } catch (error) {
            this.logger.error(`[BatchExecutionEngine] Failed to cleanup orphaned batch members for batch ${batchId}`, error instanceof Error ? error : undefined, { batchId });
            // Don't throw - this is a safety net, not critical for resume
        }
    }

    /**
     * Check if a batch is currently running
     */
    async isBatchRunning(batchId: string): Promise<boolean> {
        const batchState = this.batchStates.get(batchId);
        return batchState?.status === 'running' || false;
    }

    /**
     * Get list of all running batches
     */
    async getRunningBatches(): Promise<string[]> {
        const runningBatches: string[] = [];
        for (const [batchId, state] of this.batchStates.entries()) {
            if (state.status === 'running') {
                runningBatches.push(batchId);
            }
        }
        return runningBatches;
    }

    /**
     * Execute record method for consistency with ExecutionService interface
     * Delegates to executeBatch method
     */
    async executeRecord(batchId: string, vscodeProgress?: any): Promise<BatchExecutionState> {
        return await this.executeBatch(batchId, undefined, vscodeProgress);
    }

    /**
     * Update all UI components with unified batch status data
     * Single source of truth - calculated once, used everywhere
     */
    private async updateUIWithUnifiedStatus(
        unifiedStatus: UnifiedBatchStatus,
        batchState: BatchExecutionState
    ): Promise<void> {
        this.logger.debug(`[BatchExecutionEngine] Updating UI with unified status`, undefined, { unifiedStatus });

        // Status bar surface removed; progress is delivered via the Hub
        // activity chip + drawer (see hub-activity.js + hub-manager.ts).

        // Update progress manager if available (for progress bar)
        if (this.dependencies.progressManager) {
            // Progress manager can use the same data to show progress differently
            // e.g., as a percentage bar, pie chart, etc.
        }
    }

    /**
     * Create unified batch status data - single source of truth
     * This data is passed to ALL UI components (status bar, progress bar, tooltips)
     */
    private createUnifiedBatchStatus(
        batchId: string,
        batchState: BatchExecutionState,
        batchMetadata: any
    ): UnifiedBatchStatus {
        // Calculate status counts dynamically
        const statusCounts: Record<string, number> = {};

        // Group by actual member statuses (if available)
        if (batchState) {
            // Use internal state tracking
            if (batchState.successfulMembers > 0) statusCounts['completed'] = batchState.successfulMembers;
            if (batchState.failedMembers > 0) statusCounts['error'] = batchState.failedMembers;
            if (batchState.cancelledMembers > 0) statusCounts['cancelled'] = batchState.cancelledMembers;

            const processed = batchState.completedMembers || 0;
            const pending = batchState.totalMembers - processed;
            if (pending > 0 && batchState.status === 'running') {
                statusCounts['pending'] = pending;
            }
        }

        return {
            // Batch identification
            batchId: batchId,
            endpointId: batchMetadata.endpointId,
            endpointName: batchMetadata.endpointName,
            environment: batchMetadata.environment,

            // Execution counts
            totalMembers: batchState?.totalMembers || batchMetadata.rows || 0,
            statusCounts: statusCounts,

            // Batch state - map legacy 'failed' to 'error' for UI display
            batchStatus: (batchState?.status === 'failed' ? 'error' : batchState?.status) ||
                (batchMetadata.status === 'failed' ? 'error' : batchMetadata.status) as 'preparing' | 'pending' | 'running' | 'completed' | 'paused' | 'cancelled' | 'stopped' | 'error',
            startedAt: batchState?.startedAt || new Date(batchMetadata.createdAt),
            completedAt: batchState?.completedAt,

            // Progress information
            currentMemberIndex: batchState?.completedMembers,
            currentMemberId: batchState?.currentMemberId || undefined,

            // Additional metadata
            rows: batchMetadata.rows,
            organization: batchMetadata.organization
        };
    }

    /**
     * Update batch metadata through the metadata service
     */
    private async updateBatchMetadata(batchId: string, updates: any): Promise<void> {
        // GitHub Issue #151: Debug - trace ALL status updates
        if (updates.status) {
            const stack = new Error().stack?.split('\n').slice(2, 5).join(' <- ');
            this.logger.info(`[BatchExecutionEngine] issue#151 STATUS UPDATE: ${batchId} -> ${updates.status}`, undefined, {
                newStatus: updates.status,
                caller: stack
            });
        }
        this.logger.debug(`[BatchExecutionEngine.updateBatchMetadata] Updating batch ${batchId}`, undefined, { batchId, updates });

        if (this.dependencies.executionMetadataService?.updateExecution) {
            this.logger.debug(`[BatchExecutionEngine.updateBatchMetadata] Calling executionMetadataService.updateExecution...`);
            await this.dependencies.executionMetadataService.updateExecution(batchId, updates);
            this.logger.debug(`[BatchExecutionEngine.updateBatchMetadata] executionMetadataService.updateExecution completed`);
        } else {
            this.logger.error(`[BatchExecutionEngine.updateBatchMetadata] executionMetadataService or updateExecution method not available!`);
        }

        // Update execution state through coordinator (preferred) or status bar directly (fallback)
        if (updates.status) {
            try {
                // Get the updated batch metadata
                const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
                if (batchMetadata) {
                    this.logger.debug(`[BatchExecutionEngine.updateBatchMetadata] Got batch metadata, updating UI services...`);
                    // Route through ExecutionCoordinator if available (new architecture)
                    if (this.dependencies.executionCoordinator) {
                        await this.dependencies.executionCoordinator.updateExecutionState(batchId, batchMetadata);
                    }
                    // NOTE: Status bar updates are now handled by the unified status system
                    // in updateUIWithUnifiedStatus() - no need for fallback updates here
                } else {
                    this.logger.warn(`[BatchExecutionEngine.updateBatchMetadata] Could not retrieve batch metadata after update`);
                }
            } catch (error) {
                this.logger.warn('[BatchExecutionEngine.updateBatchMetadata] Failed to update execution state', error instanceof Error ? error : undefined);
            }
        }

        // Additional state broadcasting for batch-specific events
        if (this.dependencies.stateBroadcaster && updates.status) {
            try {
                await this.dependencies.stateBroadcaster.broadcast(
                    'execution-state-changed',
                    {
                        executionId: batchId,
                        status: updates.status,
                        executionType: 'batch',
                        timestamp: new Date(),
                        source: 'batch-execution-engine'
                    },
                    'batch-execution-engine'
                );
            } catch (error) {
                this.logger.warn('[BatchExecutionEngine] Failed to broadcast batch state change', error instanceof Error ? error : undefined);
            }
        }
    }

    /**
     * Determine if a member failure should cause the entire batch to fail
     * Implements GitHub Issue #47 - Error tolerance support
     * 
     * Logic flow:
     * 1. Critical errors always stop (regardless of settings)
     * 2. Check unified error tolerance (stopOnFirst = limit 0, continue = user limit)
     * 3. Otherwise continue
     */
    private async shouldFailBatch(batchId: string, memberResult: any): Promise<boolean> {
        const batchState = this.batchStates.get(batchId);
        if (!batchState) {
            this.logger.warn(`[BatchExecutionEngine] No batch state found for shouldFailBatch check: ${batchId}`);
            return false;
        }

        // 1. Critical errors always stop immediately (regardless of tolerance settings)
        if (this.isCriticalError(memberResult)) {
            this.logger.info(`[BatchExecutionEngine] Critical error detected, stopping batch immediately: ${memberResult.errorMessage}`);

            // Log critical error event (don't let logging failures break the stop decision)
            try {
                await this.logBatchEvent(batchState.batchId, {
                    level: 'error',
                    phase: 'orchestration',
                    event: 'critical_error_stop',
                    data: {
                        batchId: batchState.batchId,
                        memberId: memberResult.executionId,
                        httpStatus: memberResult.httpStatus,
                        errorMessage: memberResult.errorMessage,
                        reason: 'Critical error - batch stopped immediately'
                    },
                    error: {
                        message: memberResult.errorMessage || 'Critical error occurred',
                        code: `HTTP_${memberResult.httpStatus}`
                    },
                    http: {
                        status: memberResult.httpStatus,
                        statusText: memberResult.httpStatusText
                    }
                });
            } catch (logError) {
                this.logger.warn('[BatchExecutionEngine] Failed to log critical error event', logError instanceof Error ? logError : undefined);
            }

            return true;
        }

        // 2. Check unified error tolerance (handles both stopOnFirst and continue modes)
        if (batchState.toleranceConfig) {
            const { limit, mode } = batchState.toleranceConfig;
            const currentErrorCount = batchState.failedMembers;

            // Calculate percentage for logging
            let percentage: number;
            if (mode === 'percentage') {
                percentage = (currentErrorCount / batchState.totalMembers) * 100;
            } else {
                percentage = (currentErrorCount / limit) * 100;
            }

            // Log tolerance consumption event (don't let logging failures break the logic)
            try {
                await this.logBatchEvent(batchState.batchId, {
                    level: 'warn',
                    phase: 'orchestration',
                    event: 'error_tolerance_consumed',
                    data: {
                        batchId: batchState.batchId,
                        memberId: memberResult.executionId,
                        current: currentErrorCount,
                        limit: limit,
                        mode: mode,
                        percentage: Math.round(percentage),
                        display: this.createToleranceDisplay(currentErrorCount, limit),
                        httpStatus: memberResult.httpStatus,
                        errorMessage: memberResult.errorMessage
                    },
                    error: {
                        message: memberResult.errorMessage || 'Functional error within tolerance',
                        code: `HTTP_${memberResult.httpStatus}`
                    },
                    http: {
                        status: memberResult.httpStatus,
                        statusText: memberResult.httpStatusText
                    }
                });
            } catch (logError) {
                this.logger.warn('[BatchExecutionEngine] Failed to log tolerance consumption event', logError instanceof Error ? logError : undefined);
            }

            // Log approaching warning at 80% threshold
            if (percentage >= 80 && percentage < 100) {
                try {
                    await this.logBatchEvent(batchState.batchId, {
                        level: 'warn',
                        phase: 'orchestration',
                        event: 'error_tolerance_approaching',
                        data: {
                            batchId: batchState.batchId,
                            current: currentErrorCount,
                            limit: limit,
                            percentage: Math.round(percentage),
                            warning: 'Approaching error tolerance limit'
                        }
                    });
                } catch (logError) {
                    this.logger.warn('[BatchExecutionEngine] Failed to log tolerance approaching event', logError instanceof Error ? logError : undefined);
                }
            }

            const isToleranceExceeded = this.checkToleranceExceeded(batchState);

            if (isToleranceExceeded) {
                this.logger.info(`[BatchExecutionEngine] Error tolerance exceeded: ${batchState.failedMembers} errors, limit: ${batchState.toleranceConfig.limit}`);

                // Log tolerance exceeded event (don't let logging failures break the stop decision)
                try {
                    await this.logBatchEvent(batchState.batchId, {
                        level: 'error',
                        phase: 'orchestration',
                        event: 'error_tolerance_exceeded',
                        data: {
                            batchId: batchState.batchId,
                            final: currentErrorCount,
                            limit: limit,
                            mode: mode,
                            percentage: Math.round(percentage),
                            action: 'batch_stopped',
                            display: this.createToleranceDisplay(currentErrorCount, limit)
                        }
                    });
                } catch (logError) {
                    this.logger.warn('[BatchExecutionEngine] Failed to log tolerance exceeded event', logError instanceof Error ? logError : undefined);
                }

                return true;
            } else {
                this.logger.debug(`[BatchExecutionEngine] Error within tolerance: ${batchState.failedMembers}/${batchState.toleranceConfig.limit}`);
            }
        }

        // 3. Otherwise continue processing
        return false;
    }

    /**
     * Check if error is critical (always stops batch regardless of tolerance)
     * Critical errors: authentication failures, network connectivity loss
     * 
     * Phase 2: Reads from VS Code settings for user customization
     * Users can configure which HTTP status codes are critical and whether to treat network errors as critical
     */
    private isCriticalError(memberResult: any): boolean {
        // Read critical error codes from the user's settings (Issue #321: through IConfiguration)
        const config = this.dependencies.configuration ?? DEFAULT_CONFIGURATION;
        const criticalStatusCodes = config.get<number[]>('dbmn.execution', 'criticalErrorCodes', [401, 403]);

        // Check if the HTTP status code is in the critical list
        if (memberResult.httpStatus && criticalStatusCodes.includes(memberResult.httpStatus)) {
            return true;
        }

        // Check if network errors should be treated as critical
        const treatNetworkErrorsAsCritical = config.get<boolean>('dbmn.execution', 'treatNetworkErrorsAsCritical', true);

        if (treatNetworkErrorsAsCritical && !memberResult.httpStatus && memberResult.errorMessage) {
            const networkErrorPatterns = [
                /network.*timeout/i,
                /connection.*refused/i,
                /certificate.*error/i,
                /dns.*resolution/i,
                /connection.*reset/i
            ];

            if (networkErrorPatterns.some(pattern => pattern.test(memberResult.errorMessage))) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if error tolerance has been exceeded
     */
    private checkToleranceExceeded(batchState: any): boolean {
        if (!batchState.toleranceConfig) {
            return false;
        }

        const { limit } = batchState.toleranceConfig;

        // Simple integer comparison - percentage already converted to absolute during batch setup
        return batchState.failedMembers > limit;
    }

    /**
     * Create visual tolerance display for logging
     * Returns simple 5-block progress indicator like: 🧪██░░░
     */
    private createToleranceDisplay(current: number, limit: number): string {
        const percentage = Math.min(100, Math.round((current / limit) * 100));
        const filled = Math.round(percentage / 20); // 5 blocks total (100% / 5 = 20% per block)
        const empty = 5 - filled;

        const blocks = '█'.repeat(filled) + '░'.repeat(empty);
        return `🧪${blocks}`;
    }

    /**
     * Create tolerance progress data for status bar display (GitHub Issue #47)
     * @param batchState - Current batch execution state
     * @returns Tolerance progress data for BatchTooltipData
     */
    private createToleranceProgress(batchState: any): { current: number, limit: number, percentage: number, active: boolean } | undefined {

        if (!batchState.toleranceConfig) {
            return undefined;
        }

        const current = batchState.failedMembers;
        const limit = batchState.toleranceConfig.limit;

        // Simple percentage calculation since tolerance is always absolute now
        const percentage = Math.min(100, Math.round((current / limit) * 100));

        const result = {
            current,
            limit,
            percentage,
            active: true
        };

        return result;
    }

    /**
     * Read error tolerance configuration from batch configuration
     * GitHub Issue #151: Simplified to only use stopOnFirstError
     * - stopOnFirstError=true → return { limit: 0 } (stop on first error)
     * - stopOnFirstError=false/undefined → return undefined (never stop due to errors)
     */
    private async readErrorToleranceConfig(batchId: string, totalMembers: number): Promise<ErrorToleranceConfig | undefined> {
        try {
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                this.logger.debug('[BatchExecutionEngine] No batch metadata found for tolerance config');
                return undefined;
            }

            const batchConfig = (batchMetadata as any).batchConfiguration;

            // GitHub Issue #151: Only check stopOnFirstError - simple binary choice
            if (batchConfig?.stopOnFirstError === true) {
                this.logger.debug('[BatchExecutionEngine] stopOnFirstError=true, setting tolerance limit to 0');
                return {
                    mode: 'absolute',
                    limit: 0
                };
            }

            // stopOnFirstError is false or not set → no tolerance checking → never stop due to errors
            this.logger.debug('[BatchExecutionEngine] stopOnFirstError is false/undefined, no error tolerance limit');
            return undefined;

        } catch (error) {
            this.logger.warn('[BatchExecutionEngine] Failed to read error tolerance config', error instanceof Error ? error : undefined);
            return undefined;
        }
    }

    /**
     * Format runtime duration from start time
     */
    private formatRuntime(startedAt?: Date): string {
        if (!startedAt) {
            return 'Queued'; // No elapsed time for queued batches
        }
        const now = new Date();
        const elapsedMs = now.getTime() - startedAt.getTime();
        const seconds = Math.floor(elapsedMs / 1000);

        if (seconds < 60) {
            return `${seconds}s`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }

    /**
     * Track completion timestamp for throughput-based ETA calculation (GitHub Issue #104)
     * Keeps timestamps for last 60 seconds to calculate transactions per second
     */
    private trackCompletion(batchState: BatchExecutionState): void {
        const now = Date.now();
        batchState.completionTimestamps.push(now);

        // Remove timestamps older than 60 seconds
        const sixtySecondsAgo = now - 60000;
        batchState.completionTimestamps = batchState.completionTimestamps.filter(ts => ts > sixtySecondsAgo);
    }

    /**
     * Start ETA updates with progressive frequency (GitHub Issue #104)
     * Progress bar/count updates happen on every transaction result (real-time in frontend)
     * ETA updates: First at 5s, then every 60s for stability
     */
    private startProgressTimer(batchState: BatchExecutionState, totalMembers: number, vscodeProgress?: any): void {
        // Clear any existing timer
        this.stopProgressTimer(batchState);

        // Check every 5 seconds, but only send updates at specific intervals
        batchState.progressTimer = setInterval(async () => {
            if (batchState.status !== 'running') {
                this.stopProgressTimer(batchState);
                return;
            }

            if (!batchState.startedAt) {
                return; // Not started yet
            }
            // Waiting for VS Code (#344): the Console says so; an estimate would overwrite it
            if (batchState.awaiting) return;

            const elapsedSeconds = (Date.now() - batchState.startedAt.getTime()) / 1000;

            // Issue #336: when to send a new estimate (etaUpdateDue)
            const shouldSendETA = etaUpdateDue(elapsedSeconds, batchState.completionTimestamps.length,
                batchState.lastEtaUpdate ? Date.now() - batchState.lastEtaUpdate : undefined);
            if (shouldSendETA) batchState.lastEtaUpdate = Date.now();

            if (shouldSendETA) {
                const runtime = this.formatRuntime(batchState.startedAt);
                const timeRemaining = await this.calculateTimeRemaining(batchState, totalMembers);

                // Update VS Code progress bar (counts updated by member completions, just update message)
                if (vscodeProgress) {
                    vscodeProgress.report({
                        message: `${batchState.completedMembers}/${totalMembers} - Runtime: ${runtime} | Left: ${timeRemaining}`
                    });
                }

                // Send ETA-only update to report webview (progress bar already updated by transaction results)
                try {
                    const estimatedRemainingMs = this.calculateEstimatedRemainingMs(batchState, totalMembers);
                    const estimatedEndTime = estimatedRemainingMs > 0 ? Date.now() + estimatedRemainingMs : null;

                    await this.progressSink.eta(batchState.batchId, {
                        status: 'running',
                        startTime: this.displayStartTime(batchState), // Issue #311: total run time, not this session's
                        estimatedEndTime: estimatedEndTime,
                        // Don't send current/total - frontend calculates from transaction results
                        message: `Runtime: ${runtime} | Left: ${timeRemaining}`
                    });
                } catch (error) {
                    this.logger.warn('[BatchExecutionEngine] Failed to send ETA update to report', error instanceof Error ? error : undefined);
                }
            }
        }, 5000); // Check every 5 seconds; etaUpdateDue decides whether to send
    }

    /**
     * Stop per-second progress updates (GitHub Issue #70)
     */
    private stopProgressTimer(batchState: BatchExecutionState): void {
        if (batchState.progressTimer) {
            clearInterval(batchState.progressTimer);
            batchState.progressTimer = undefined;
        }
    }

    /**
     * Calculate estimated time remaining using throughput-based approach (GitHub Issue #104)
     * More stable than individual execution times - looks at completions per minute
     */
    private calculateEstimatedRemainingMs(batchState: BatchExecutionState, totalMembers: number): number {
        // If batch is complete, return 0
        if (batchState.completedMembers >= totalMembers) {
            return 0;
        }

        if (!batchState.startedAt) {
            return -1; // Not started yet
        }

        const elapsedSeconds = (Date.now() - batchState.startedAt.getTime()) / 1000;

        // First 5 seconds: not enough data yet
        if (elapsedSeconds < 5) {
            return -1;
        }

        // Count completions in last 60 seconds (or less if batch just started)
        const sixtySecondsAgo = Date.now() - 60000;
        const recentCompletions = batchState.completionTimestamps.filter(ts => ts > sixtySecondsAgo).length;

        // Calculate throughput (transactions per second)
        const timeWindow = Math.min(elapsedSeconds, 60); // Use actual elapsed if < 60s
        const throughput = recentCompletions / timeWindow;

        if (throughput === 0) {
            return -1; // No throughput data yet
        }

        // Calculate remaining time based on throughput
        const remaining = totalMembers - batchState.completedMembers;
        const etaSeconds = remaining / throughput;

        return etaSeconds * 1000; // Convert to milliseconds
    }

    /**
     * Calculate estimated time remaining formatted as string (GitHub Issue #104)
     * Throughput-based: much more stable than tracking individual execution times
     */
    private async calculateTimeRemaining(batchState: BatchExecutionState, totalMembers: number): Promise<string> {
        // If batch is complete, show 0s
        if (batchState.completedMembers >= totalMembers) {
            return '0s';
        }

        // If not started yet (queued), show queue position
        if (!batchState.startedAt) {
            const queuePosition = this.calculateQueuePosition(batchState.batchId);
            return `Queue position ${queuePosition}`;
        }

        const estimatedRemainingMs = this.calculateEstimatedRemainingMs(batchState, totalMembers);

        // Still calculating (< 5s elapsed or no throughput data)
        if (estimatedRemainingMs < 0) {
            return 'calculating...';
        }

        // Log throughput metrics
        const elapsedSeconds = (Date.now() - batchState.startedAt.getTime()) / 1000;
        const timeWindow = Math.min(elapsedSeconds, 60);
        const recentCompletions = batchState.completionTimestamps.length;
        const throughput = recentCompletions / timeWindow;

        // Format the remaining time
        const seconds = Math.floor(estimatedRemainingMs / 1000);

        if (seconds < 60) {
            return `${seconds}s`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }

    /**
     * Update status bar with current batch state
     * DRY method to handle both regular updates and final status updates (STOPPED, COMPLETED, etc.)
     */
    private async updateBatchStatusBar(batchId: string, batchState: BatchExecutionState, forceStatus?: string): Promise<void> {
        if (!this.dependencies.executionCoordinator) {
            return;
        }

        try {
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                return;
            }

            // Use forced status (for STOPPED) or current batch state status
            const statusToUse = forceStatus || batchState.status;

            // For execution coordinator - use the metadata approach
            if (this.dependencies.executionCoordinator) {
                const updatedMetadata = {
                    ...batchMetadata,
                    batchMemberProgress: {
                        total: batchState.totalMembers,
                        successful: batchState.successfulMembers,
                        failed: batchState.failedMembers,
                        cancelled: batchState.cancelledMembers,
                        pending: batchState.totalMembers - batchState.completedMembers
                    },
                    toleranceProgress: this.createToleranceProgress(batchState)
                };

                await this.dependencies.executionCoordinator.updateExecutionState(batchId, updatedMetadata);
            }

        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to update batch status bar${forceStatus ? ' for ' + forceStatus : ''}`, error instanceof Error ? error : undefined);
        }
    }


    /**
     * New credentials after a 401 (#359): the host's refreshCredentials, else the DBMN session.
     * Undefined when there's nothing that could refresh them.
     */
    /** Paused, cancelled or stopped: no member starts, or tries again. */
    private isMemberRunStopped(batchState: { status?: unknown } | undefined, token: CancellationFlag | undefined): boolean {
        return !!token?.isCancellationRequested
            || batchState?.status === BatchStatus.PAUSED
            || batchState?.status === BatchStatus.CANCELLED
            || batchState?.status === BatchStatus.STOPPED;
    }

    private async refreshAfterUnauthorized(environmentId: string | undefined): Promise<boolean | undefined> {
        if (this.dependencies.refreshCredentials) {
            if (!environmentId) return undefined;
            try {
                return await this.dependencies.refreshCredentials(environmentId);
            } catch (error) {
                this.logger.warn('[BatchExecutionEngine] refreshing credentials after a 401 failed', error instanceof Error ? error : undefined);
                return false;
            }
        }
        const dbmnAuth = this.dependencies.dbmnAuth?.();
        if (!dbmnAuth) return undefined;
        return (await dbmnAuth.refreshSession()).status === 'success';
    }
    /**
     * #344: hold the batch, queued, until what it runs on is there (`readiness`), reporting what
     * it waits for. False: cancelled while waiting, or not to be run.
     */
    private async waitUntilReady(batchId: string, environmentId: string | undefined, vscodeProgress?: any, token?: CancellationFlag): Promise<boolean> {
        const readiness = this.dependencies.readiness;
        if (!readiness || !environmentId) return true;
        let waited = false;
        for (let check = 0; ; check++) {
            const state = await readiness(environmentId);
            if (!state) {
                if (waited) {
                    this.logger.info(`[BatchExecutionEngine] Batch ${batchId} ready after waiting: starting`);
                    await this.sendStatusUpdateToReport(batchId, 'pending');
                }
                return true;
            }
            if ('stop' in state) {
                // Paused, not cancelled: nothing was sent, and Resume runs it once that's sorted
                this.logger.info(`[BatchExecutionEngine] Batch ${batchId} paused before starting: ${state.stop}`);
                await this.pauseBatch(batchId, state.stop).catch(() => undefined);
                return false;
            }
            const status = this.batchStates.get(batchId)?.status as string | undefined;
            if (token?.isCancellationRequested || status === BatchStatus.CANCELLED) {
                this.logger.info(`[BatchExecutionEngine] Batch ${batchId} cancelled while waiting for ${state.waitingFor}`);
                return false;
            }
            if (!waited) this.logger.info(`[BatchExecutionEngine] Batch ${batchId} waiting for ${state.waitingFor}`);
            waited = true;
            if (vscodeProgress && check % 5 === 0) {
                vscodeProgress.report({ message: `Waiting for ${state.waitingFor}`, status: 'pending', queued: true, waitingFor: state.waitingFor });
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    /**
     * #344: a running batch whose DBMN for VS Code closed (the web app). No new member starts; the
     * Console says what it waits for, as before the start, with the clock stopped where it was;
     * the requests already sent finish (or fail) as they will. When VS Code is back, the same
     * sign-in check as the start, then on: the clock carries on from where it stopped. Pause and
     * Cancel still work: the wait ends, and the loop sees the status. False: nothing to wait for.
     */
    private async holdWhileAway(batchId: string, batchState: BatchExecutionState, batchMetadata: any, vscodeProgress?: any, token?: CancellationFlag): Promise<boolean> {
        const readiness = this.dependencies.readiness;
        const environmentId = batchMetadata?.environmentId as string | undefined;
        if (!readiness || !environmentId) return false;
        let state = await readiness(environmentId);
        if (!state) return false;
        if ('stop' in state) {
            // VS Code came back but the environment's sign-in there was declined: paused, as at the start
            this.logger.info(`[BatchExecutionEngine] Batch ${batchId} paused mid-run: ${state.stop}`);
            await this.pauseBatch(batchId, state.stop).catch(() => undefined);
            return true;
        }
        const waitingFor = state.waitingFor;
        this.logger.info(`[BatchExecutionEngine] Batch ${batchId} waiting mid-run for ${waitingFor}`);
        batchState.activeRunMs = this.activeRunMs(batchState);
        batchState.awaiting = waitingFor;
        const say = () => {
            const waiting = { status: 'pending', queued: true, waitingFor, midRun: true, startTime: this.displayStartTime(batchState) };
            vscodeProgress?.report({ message: `Waiting for ${waitingFor}`, ...waiting });
        };
        say();
        try {
            for (let check = 1; ; check++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (this.isMemberRunStopped(batchState, token)) return true;
                state = await readiness(environmentId);
                if (!state) break;
                if ('stop' in state) {
                    this.logger.info(`[BatchExecutionEngine] Batch ${batchId} paused mid-run: ${state.stop}`);
                    await this.pauseBatch(batchId, state.stop).catch(() => undefined);
                    return true;
                }
                // Said again now and then: a Console opened during the wait learns it too
                if (check % 5 === 0) say();
            }
        } finally {
            batchState.awaiting = undefined;
            // The clock carries on from where it stopped (a pause during the wait keeps it stopped)
            batchState.startedAt = new Date();
        }
        this.logger.info(`[BatchExecutionEngine] Batch ${batchId} carrying on: ${waitingFor} is back`);
        // Running again: the clock from the run time so far, and the row back to its estimate
        vscodeProgress?.report({ message: 'Running', status: 'running', startTime: this.displayStartTime(batchState) });
        await this.sendStatusUpdateToReport(batchId, 'running');
        return true;
    }

    /**
     * Wait for any running batch to complete (GitHub Issue #62)
     * Called when a batch is queued and needs to wait for its turn
     */
    private async waitForRunningBatchToComplete(waitingBatchId: string, vscodeProgress?: any, token?: CancellationFlag): Promise<boolean> {
        // GitHub Issue #123: Removed timeout - batch will wait indefinitely until previous batch completes
        // Issue #309: the user can cancel a queued batch (Console Cancel → cancelBatch sets its
        // status), and that must end the wait — previously the wait ignored it, overwrote the
        // status with 'pending' when its turn came, and the "cancelled" batch ran anyway.
        const pollInterval = 1000; // Check every 1 second
        const progressUpdateInterval = 5000; // Update progress every 5 seconds
        let waitCount = 0;

        this.logger.info(`[BatchExecutionEngine] Batch ${waitingBatchId} waiting for running batches to complete`);

        while (true) {
            const waitingStatus = this.batchStates.get(waitingBatchId)?.status as string | undefined;
            if (token?.isCancellationRequested || waitingStatus === BatchStatus.CANCELLED) {
                this.logger.info(`[BatchExecutionEngine] issue#309 Batch ${waitingBatchId} cancelled while queued`);
                return false;
            }

            // Check if any other batch is still running (one that holds the queue — Issue #309)
            const runningBatches = this.queueHolders(waitingBatchId);

            if (runningBatches.length === 0) {
                this.logger.info(`[BatchExecutionEngine] Batch ${waitingBatchId} can now start - no other batches running`);
                return true; // Our turn!
            }

            // GitHub Issue #62: Update progress every 5 seconds while waiting.
            // Issue #309: explicit 'pending' plus what the batch is waiting on and when that is
            // expected to finish, so the Console can say "starts in ~4m" rather than run a clock.
            if (vscodeProgress && waitCount * pollInterval % progressUpdateInterval === 0) {
                const waitTimeSeconds = Math.floor((waitCount * pollInterval) / 1000);
                const queuePosition = this.calculateQueuePosition(waitingBatchId);
                const message = queuePosition > 1
                    ? `Waiting in queue (position ${queuePosition})... ${waitTimeSeconds}s elapsed`
                    : `Waiting for current batch to complete... ${waitTimeSeconds}s elapsed`;
                const outlook = await this.queueOutlook(runningBatches[0]);

                vscodeProgress.report({ message, status: 'pending', queued: true, ...outlook });
            }

            // Log queue status occasionally
            if (waitCount % 30 === 0) { // Every 30 seconds
                const runningBatchIds = runningBatches.map(state => state.batchId);
                this.logger.info(`[BatchExecutionEngine] Batch ${waitingBatchId} still waiting for running batches: ${runningBatchIds.join(', ')}`);
            }

            // Wait and try again
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            waitCount++;
        }
    }

    /**
     * Issue #309: the batches whose run holds the queue — running, and more than one
     * member. A batch of one request (a paginated Run API before any further pages are
     * fetched) is a single call: it neither waits for a batch nor makes one wait. If it
     * later grows (Fetch all pages), `totalMembers` grows with it and it holds the queue
     * from then on like any batch.
     */
    private queueHolders(exceptBatchId: string): BatchExecutionState[] {
        return Array.from(this.batchStates.values())
            .filter(state => state.status === BatchStatus.RUNNING && state.batchId !== exceptBatchId && state.totalMembers > 1);
    }

    /** Issue #309: must this batch wait its turn? Only a real batch, behind a real batch. */
    private mustQueue(batchId: string, expectedMemberCount: number): boolean {
        return expectedMemberCount > 1 && this.queueHolders(batchId).length > 0;
    }

    /**
     * Issue #309: what a queued batch is waiting on, and when that batch is expected to finish
     * (the queued batch's expected start). No estimate until the running batch has enough
     * throughput data — the Console then says "starts when X finishes" instead of a time.
     */
    private async queueOutlook(running: BatchExecutionState): Promise<{ queuedBehind?: string; expectedStartTime?: number }> {
        const meta = await this.dependencies.executionMetadataService.getExecution(running.batchId).catch(() => undefined);
        const remainingMs = this.calculateEstimatedRemainingMs(running, running.totalMembers);
        return {
            queuedBehind: meta?.endpointName || undefined,
            expectedStartTime: remainingMs > 0 ? Date.now() + remainingMs : undefined
        };
    }

    /**
     * Calculate queue position for a waiting batch (GitHub Issue #62)
     */
    private calculateQueuePosition(waitingBatchId: string): number {
        const allBatches = Array.from(this.batchStates.values());
        const runningBatches = allBatches.filter(state => state.status === 'running');
        const pendingBatches = allBatches
            .filter(state => state.status === 'pending')
            .sort((a, b) => {
                const aTime = a.startedAt ? a.startedAt.getTime() : 0;
                const bTime = b.startedAt ? b.startedAt.getTime() : 0;
                return aTime - bTime;
            }); // Sort by creation time

        const waitingBatchIndex = pendingBatches.findIndex(state => state.batchId === waitingBatchId);
        return runningBatches.length + waitingBatchIndex + 1; // +1 for 1-based position
    }

    /**
     * Archive a member's response file before re-execution.
     * Renames the existing response file to include the attempt number.
     * Example: exec_123_response.json → exec_123_response_attempt1.json
     */
    private archiveResponseFile(member: { responseFile?: string; reprocessCount?: number }): void {
        if (!member.responseFile) return;

        try {
            if (!runFileExists(member.responseFile)) return;

            const attemptNumber = (member.reprocessCount || 0) > 0 ? member.reprocessCount : 1;
            const ext = path.extname(member.responseFile);
            const base = member.responseFile.slice(0, -ext.length);
            const archivedPath = `${base}_attempt${attemptNumber}${ext}`;

            renameRunFile(member.responseFile, archivedPath);
            this.logger.debug(`[BatchExecutionEngine] Archived response: ${member.responseFile} → ${archivedPath}`);
        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to archive response file: ${member.responseFile}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Reprocess members in-batch: reset to pending and re-execute in place.
     * Works both while the batch is running (consumer loop picks up reset members)
     * and after completion (restarts the batch execution).
     *
     * @param batchId - The batch containing the members
     * @param memberIds - Array of member IDs to reprocess
     * @returns Number of members reset
     */
    async reprocessMembersInBatch(batchId: string, memberIds: string[]): Promise<number> {
        this.logger.info(`[BatchExecutionEngine] In-batch reprocess: ${memberIds.length} members in batch ${batchId}`);

        const allMembers = await this.getBatchMembers(batchId);
        const membersToReset = allMembers.filter(m => memberIds.includes(m.id));

        if (membersToReset.length === 0) {
            this.logger.warn(`[BatchExecutionEngine] No matching members found for in-batch reprocess`);
            return 0;
        }

        // Reset each member: archive response, increment reprocess_count, clear execution state
        for (const member of membersToReset) {
            this.archiveResponseFile(member);

            const currentCount = (member as { reprocessCount?: number }).reprocessCount || 0;
            await this.dependencies.executionMetadataService.updateExecution(member.id, {
                status: 'pending',
                httpStatus: undefined,
                httpStatusText: undefined,
                errorMessage: undefined,
                responseFile: undefined,
                completedAt: undefined,
                reprocessCount: currentCount + 1
            });
        }

        // Log the reprocess event
        await this.logBatchEvent(batchId, {
            level: 'info',
            phase: 'orchestration',
            event: 'members_reprocessed_in_batch',
            data: {
                batchId,
                memberIds,
                membersReset: membersToReset.length
            }
        });

        // Refresh Console so reset members are removed from completed/error tabs
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
        await this.sendStatusUpdateToReport(batchId, batchMetadata?.status || 'pending', undefined, true);

        // Check current batch state to decide whether to restart
        const batchState = this.batchStates.get(batchId);

        if (batchState && batchState.status === BatchStatus.RUNNING) {
            // Batch is actively running — reset members become claimable by the existing consumer loop
            // via claimPendingMembers(). No restart needed.
            this.logger.info(`[BatchExecutionEngine] Batch ${batchId} is running — reset members will be claimed by active consumer loop`);
        } else {
            // Batch is in terminal state — no consumer loop running
            if (membersToReset.length <= 1) {
                // Per-card retry: lightweight direct execution, batch status stays terminal
                this.logger.info(`[BatchExecutionEngine] Batch ${batchId} is terminal — executing 1 member directly`);
                this.executeRetryDirect(batchId, memberIds).catch(error => {
                    this.logger.error(`[BatchExecutionEngine] Direct retry failed for batch ${batchId}`, error instanceof Error ? error : undefined);
                });
            } else {
                // Batch-level reprocess: use full batch engine for parallelism + progress + cancellation
                this.logger.info(`[BatchExecutionEngine] Batch ${batchId} is terminal — restarting batch engine for ${membersToReset.length} members`);

                // Update rows to actual member count so executeBatch's totalMembers is correct
                // (split operations may have changed the member count since the batch was created)
                const currentMembers = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);
                const actualMemberCount = currentMembers.length;

                this.batchStates.delete(batchId);
                await this.updateBatchMetadata(batchId, {
                    status: 'running',
                    completedAt: undefined,
                    startedAt: new Date(),
                    rows: String(actualMemberCount)
                });
                await this.sendStatusUpdateToReport(batchId, 'running');
                this.executeBatch(batchId).catch(error => {
                    this.logger.error(`[BatchExecutionEngine] Reprocessed batch failed for batch ${batchId}`, error instanceof Error ? error : undefined);
                });
            }
        }

        return membersToReset.length;
    }

    /**
     * Execute member(s) directly via ExecutionService.executeRecord() without batch machinery.
     * Only called when batch is in terminal state (no consumer loop to race with).
     * Members already have request files on disk — no JIT preparation needed.
     */
    private async executeRetryDirect(batchId: string, memberIds: string[]): Promise<void> {
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
        if (!batchMetadata) { return; }

        // User-initiated retry: ensure DBMN session is valid before executing.
        // Batch members normally suppress interactive re-login (they run in background),
        // but direct retry IS interactive — refresh the session upfront.
        const dbmnAuth = this.dependencies.dbmnAuth?.();
        if (dbmnAuth) {
            const sessionResult = await dbmnAuth.ensureValidSession();
            if (sessionResult.status !== 'success') {
                // DBMN-branded magic-link prompt. After the link is sent the
                // user must click it from their inbox; the retry can't
                // continue this turn, so we bail out either way.
                const signedIn = await (this.dependencies.promptDbmnAuthExpired?.(dbmnAuth) ?? Promise.resolve(false));
                if (!signedIn) {
                    this.logger.info(`[BatchExecutionEngine] Direct retry cancelled — DBMN auth required`);
                }
                return;
            }
        }

        const allMembers = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);
        const totalMembers = allMembers.length;

        for (const memberId of memberIds) {
            // 1. Notify webview: member is now running
            try {
                await this.progressSink.memberStatus(batchId, [memberId], 'running');
            } catch {
                // Webview may not be open
            }

            // 2. Execute via lightweight path (handles all member metadata updates internally:
            //    status pending→running→completed/error, responseFile, httpStatus, etc.)
            const result = await this.dependencies.executionService.executeRecord(memberId, {
                parentBatch: batchMetadata,
                environmentId: batchMetadata.environmentId,
                memberCount: totalMembers
            });

            // 3. Send result to RAW tab card (reads response file, classifies, updates card)
            const memberIndex = allMembers.findIndex(m => m.id === memberId);
            await this.sendMemberResultToReport(batchId, memberId, result, memberIndex >= 0 ? memberIndex + 1 : 1, totalMembers);

            // 4. Log
            await this.logBatchEvent(batchId, {
                level: result.success ? 'info' : 'error',
                phase: 'orchestration',
                event: 'member_retry_direct',
                data: { batchId, memberId, success: result.success, httpStatus: result.httpStatus }
            });
        }

        // 5. The batch stays terminal, but its totals must follow the retry —
        //    History and the Executions tree summarise from them.
        await this.refreshBatchTotals(batchId);
    }

    /**
     * Recount a batch's member statuses into its stored totals, in the same
     * shape the batch writes when it completes.
     */
    private async refreshBatchTotals(batchId: string): Promise<void> {
        const members = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);
        const count = (...statuses: string[]) => members.filter(m => statuses.includes(m.status)).length;
        const progress = {
            total: members.length,
            completed: count('completed'),
            error: count('error', 'failed'),
            cancelled: count('cancelled'),
            pending: count('pending'),
            running: count('running')
        };
        await this.updateBatchMetadata(batchId, {
            membersProcessed: progress.completed + progress.error,
            membersFailed: progress.error,
            batchMemberProgress: progress
        });
    }

    /**
     * Reprocess batch members based on type (GitHub Issue #67, #74, #151)
     * All reprocessing now happens in-batch — members get reset and re-executed in place.
     * @param batchId - The batch to reprocess
     * @param type - What to reprocess (INCOMPLETE|ERRORS|PENDING|ALL|SELECTED|SPLIT)
     * @param memberIds - Optional array of member IDs when type is SELECTED or SPLIT
     * @throws Error if batch is in active state (preparing, pending, running) — except per-card retry
     * @returns Same batch ID (all reprocessing is in-batch)
     */
    async reprocessBatch(batchId: string, type: ReprocessType, memberIds?: string[]): Promise<string> {
        this.logger.info(`[BatchExecutionEngine] Starting in-batch reprocess for batch ${batchId} with type: ${type}`, undefined, { batchId, type });

        // Validate: batch-level reprocess requires terminal state
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
        if (!batchMetadata) {
            throw new Error(`Batch not found: ${batchId}`);
        }

        // Handle SPLIT type separately (modifies existing batch by splitting array transactions)
        if (type === 'SPLIT') {
            // Splitting adds members, and a paginated batch numbers its next
            // page from its member count — pages would be skipped or repeated.
            if (isPaginatedBatch(batchMetadata)) {
                throw new Error('Paginated batches cannot be split. Reprocess the failed pages instead.');
            }
            await this.splitAndReprocessTransactions(batchId, memberIds);
            return batchId;
        }

        // Paginated batches reprocess like any other: each page member keeps
        // its own request (query params / body), so re-running it re-fetches
        // exactly that page and nothing asks for another (Issue #198).

        // Batch-level reprocess requires terminal state (per-card retry via SELECTED allows running)
        const batchState = this.batchStates.get(batchId);
        const isRunning = batchState?.status === BatchStatus.RUNNING;
        const isPerCardRetry = type === 'SELECTED' && memberIds && memberIds.length > 0;

        if (isRunning && !isPerCardRetry) {
            throw new Error(`Cannot reprocess batch in 'running' state. Use per-card retry for individual members while running.`);
        }

        const allowedTerminalStates = ['completed', 'error', 'cancelled', 'stopped'];
        if (!isRunning && !allowedTerminalStates.includes(batchMetadata.status)) {
            throw new Error(`Cannot reprocess batch in '${batchMetadata.status}' state. Use Resume for paused batches.`);
        }

        // Filter members by reprocess type
        const allMembers = await this.getBatchMembers(batchId);
        let filteredMemberIds: string[];

        switch (type) {
            case 'ERRORS':
                filteredMemberIds = allMembers
                    .filter(m => ['error', 'failed'].includes(m.status))
                    .map(m => m.id);
                break;
            case 'INCOMPLETE':
                filteredMemberIds = allMembers
                    .filter(m => m.status !== 'completed')
                    .map(m => m.id);
                break;
            case 'PENDING':
                filteredMemberIds = allMembers
                    .filter(m => m.status === 'pending')
                    .map(m => m.id);
                break;
            case 'ALL':
                filteredMemberIds = allMembers.map(m => m.id);
                break;
            case 'SELECTED':
                filteredMemberIds = memberIds || [];
                break;
            default:
                filteredMemberIds = [];
        }

        if (filteredMemberIds.length === 0) {
            throw new Error(`No transactions found to reprocess for type: ${type}`);
        }

        // Execute in-batch reprocess
        await this.reprocessMembersInBatch(batchId, filteredMemberIds);

        this.logger.info(`[BatchExecutionEngine] In-batch reprocess completed for batch ${batchId}: ${filteredMemberIds.length} members reset`, undefined, {
            batchId,
            type,
            membersReset: filteredMemberIds.length
        });

        return batchId; // Always returns same batch ID (in-batch)
    }

    /**
     * Reset error/failed batch members to pending status (GitHub Issue #151)
     * Used by Enhanced Resume to retry failed transactions before resuming
     * @param batchId - The batch to reset error members for
     * @returns Promise<number> - Number of members reset
     */
    async resetErrorMembersToPending(batchId: string): Promise<number> {
        return this.resetMembersToPending(batchId, ['error', 'failed']);
    }

    /** #335: Resume sends again the transactions Cancel cut off, if asked to. */
    async resetCancelledMembersToPending(batchId: string): Promise<number> {
        return this.resetMembersToPending(batchId, ['cancelled']);
    }

    private async resetMembersToPending(batchId: string, statuses: string[]): Promise<number> {
        this.logger.info(`[BatchExecutionEngine] Resetting ${statuses.join('/')} members to pending for batch ${batchId}`);

        const members = await this.getBatchMembers(batchId);
        const errorMembers = members.filter(m => statuses.includes(m.status));

        for (const member of errorMembers) {
            // Reset status AND clear http_status so UI doesn't classify as error
            await this.dependencies.executionMetadataService.updateExecution(member.id, {
                status: 'pending',
                httpStatus: undefined,
                httpStatusText: undefined,
                errorMessage: undefined,
                responseFile: undefined,
                completedAt: undefined
            });
        }

        // Clear cached batch state to force reload with updated member statuses
        this.clearBatchState(batchId);

        this.logger.info(`[BatchExecutionEngine] Reset ${errorMembers.length} ${statuses.join('/')} members to pending for batch ${batchId}`);
        return errorMembers.length;
    }

    /**
     * Update batch error handling mode (GitHub Issue #151, #156)
     * Updates both the database AND the in-memory batch state so changes take effect immediately
     * @param batchId - The batch to update
     * @param config - Error handling configuration
     * @returns Promise<void>
     */
    async updateBatchErrorMode(batchId: string, config: { stopOnFirstError: boolean }): Promise<void> {
        this.logger.info(`[BatchExecutionEngine] Updating error mode for batch ${batchId}`, undefined, config);

        const batch = await this.dependencies.executionMetadataService.getExecution(batchId);
        if (!batch) {
            throw new Error(`Batch not found: ${batchId}`);
        }

        // GitHub Issue #151: Simplified - only stopOnFirstError matters now
        const newConfig = {
            ...batch.batchConfiguration,
            stopOnFirstError: config.stopOnFirstError
        };

        await this.dependencies.executionMetadataService.updateExecution(batchId, { batchConfiguration: newConfig });

        // GitHub Issue #156: Update in-memory batch state directly so running execution picks up the change
        const batchState = this.batchStates.get(batchId);
        if (batchState) {
            // Update toleranceConfig based on new stopOnFirstError value
            if (config.stopOnFirstError) {
                batchState.toleranceConfig = { mode: 'absolute', limit: 0 };
                this.logger.info(`[BatchExecutionEngine] Updated in-memory toleranceConfig: stopOnFirstError=true, limit=0`);
            } else {
                batchState.toleranceConfig = undefined;
                this.logger.info(`[BatchExecutionEngine] Updated in-memory toleranceConfig: stopOnFirstError=false, no limit`);
            }
        } else {
            this.logger.debug(`[BatchExecutionEngine] No in-memory batch state to update (batch not currently running)`);
        }

        this.logger.info(`[BatchExecutionEngine] Updated error mode for batch ${batchId}: stopOnFirstError=${config.stopOnFirstError}`);
    }

    /**
     * Clear cached batch state (GitHub Issue #94 - Pagination Support)
     * Forces batch execution engine to reload batch members from database on next executeBatch call
     * Use this when batch members are added/modified outside of normal execution flow
     * @param batchId - The batch to clear state for
     */
    public clearBatchState(batchId: string): void {
        this.batchStates.delete(batchId);
        this.logger.debug(`[BatchExecutionEngine] Cleared cached state for batch ${batchId}`, undefined, { batchId });
    }

    /**
     * Update thread count for a running batch (GitHub Issue #156)
     * Allows dynamic adjustment of concurrency during batch execution.
     * Changes apply at the next iteration of the producer/consumer loops.
     * @param batchId - The batch to update
     * @param newConcurrency - New concurrency level (1, 2, 4, 8, 16)
     * @returns Promise with success status, current and max concurrency values
     */
    async updateBatchConcurrency(batchId: string, newConcurrency: number): Promise<{
        success: boolean;
        currentConcurrency: number;
        maxConcurrency: number;
        message?: string;
    }> {
        const ALLOWED_VALUES = [1, 2, 4, 8, 16];

        // Validate allowed values
        if (!ALLOWED_VALUES.includes(newConcurrency)) {
            return {
                success: false,
                currentConcurrency: 0,
                maxConcurrency: 0,
                message: `Invalid concurrency value. Allowed: ${ALLOWED_VALUES.join(', ')}`
            };
        }

        const batchState = this.batchStates.get(batchId);
        let oldConcurrency = 1;

        // GitHub Issue #156: ALWAYS read environment max from source (not cached value)
        const envMax = await this.readEnvironmentMaxConcurrency(batchId);

        // GitHub Issue #156: Validate against environment maximum BEFORE persisting
        if (newConcurrency > envMax) {
            return {
                success: false,
                currentConcurrency: batchState?.parallelConfig?.maxConcurrency || 1,
                maxConcurrency: envMax,
                message: `Cannot exceed environment maximum of ${envMax} threads`
            };
        }

        // GitHub Issue #156: Persist to database (validation passed)
        // This ensures changes persist even for paused/completed batches
        try {
            const batch = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (batch && batch.batchConfiguration) {
                // Get current values from DB
                oldConcurrency = batch.batchConfiguration.parallelProcessing?.maxConcurrency || 1;

                const updatedBatchConfig = {
                    ...batch.batchConfiguration,
                    parallelProcessing: {
                        enabled: newConcurrency > 1,
                        maxConcurrency: newConcurrency as 1 | 2 | 4 | 8 | 16
                    }
                };
                await this.dependencies.executionMetadataService.updateExecution(batchId, {
                    batchConfiguration: updatedBatchConfig
                });
                this.logger.info(`[BatchExecutionEngine] issue#156 Persisted concurrency to database: ${oldConcurrency} → ${newConcurrency}`);
            } else if (!batch) {
                return {
                    success: false,
                    currentConcurrency: 0,
                    maxConcurrency: 0,
                    message: 'Batch not found in database'
                };
            }
        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to persist concurrency to database`, error instanceof Error ? error : undefined);
            return {
                success: false,
                currentConcurrency: oldConcurrency,
                maxConcurrency: envMax,
                message: 'Failed to persist concurrency to database'
            };
        }

        // If batch is in memory (actively running/paused), update in-memory state too
        if (batchState) {
            // GitHub Issue #156: envMax already read above, validation already done
            oldConcurrency = batchState.parallelConfig?.maxConcurrency || 1;

            // Update the parallelConfig in memory - loops will pick this up on next iteration
            if (!batchState.parallelConfig) {
                batchState.parallelConfig = { enabled: true, maxConcurrency: newConcurrency };
            } else {
                batchState.parallelConfig.maxConcurrency = newConcurrency;
                batchState.parallelConfig.enabled = newConcurrency > 1;
            }

            this.logger.info(`[BatchExecutionEngine] issue#156 Updated in-memory concurrency for batch ${batchId}: ${oldConcurrency} → ${newConcurrency}`, undefined, {
                batchId,
                oldConcurrency,
                newConcurrency,
                envMax,
                status: batchState.status
            });

            // Calculate projected ETA based on linear scaling (only for running batches)
            if (batchState.status === BatchStatus.RUNNING) {
                const estimatedRemainingMs = this.calculateEstimatedRemainingMs(batchState, batchState.totalMembers);
                let projectedEtaMs: number | null = null;

                if (estimatedRemainingMs > 0 && oldConcurrency > 0) {
                    const scalingFactor = oldConcurrency / newConcurrency;
                    projectedEtaMs = Math.round(estimatedRemainingMs * scalingFactor);
                }

                // Broadcast concurrency update to report webview
                try {
                    await this.progressSink.concurrency(batchId, {
                        currentConcurrency: newConcurrency,
                        maxConcurrency: envMax,
                        oldConcurrency,
                        projectedEtaMs
                    });
                } catch (error) {
                    this.logger.warn(`[BatchExecutionEngine] Failed to send concurrency update to report`, error instanceof Error ? error : undefined);
                }
            }
        } else {
            this.logger.info(`[BatchExecutionEngine] issue#156 Batch ${batchId} not in memory, persisted to database only`);
        }

        // GitHub Issue #156: Removed VS Code notification - footer notification in report is sufficient

        return {
            success: true,
            currentConcurrency: newConcurrency,
            maxConcurrency: envMax
        };
    }

    /**
     * Split array transactions into individual transactions (GitHub Issue #74)
     * @param batchId - The batch to process
     * @param memberIds - Optional array of specific member IDs to split
     */
    private async splitAndReprocessTransactions(batchId: string, memberIds?: string[]): Promise<void> {
        this.logger.info(`[BatchExecutionEngine] Starting split and reprocess for batch ${batchId}`, undefined, { batchId, memberIds });

        // Get batch members
        const members = await this.getBatchMembers(batchId);
        if (members.length === 0) {
            throw new Error(`No batch members found for batch ${batchId}`);
        }

        // Filter to specific members if provided, otherwise find all error/failed members
        const membersToSplit = memberIds
            ? members.filter(m => memberIds.includes(m.id))
            : members.filter(m => ['error', 'failed'].includes(m.status));

        if (membersToSplit.length === 0) {
            throw new Error('No failed transactions found to split');
        }

        // Create transaction splitter
        if (!this.dependencies.transactionCreator) {
            throw new Error('TransactionCreator dependency required for split operations');
        }

        const splitterDependencies: TransactionSplitterDependencies = {
            transactionCreator: this.dependencies.transactionCreator,
            executionMetadataService: this.dependencies.executionMetadataService,
            executionLoggingService: this.dependencies.executionLoggingService
        };
        const splitter = new TransactionSplitter(splitterDependencies, this.logger);

        // Log split initiation
        await this.logBatchEvent(batchId, {
            level: 'info',
            phase: 'orchestration',
            event: 'split_reprocess_initiated',
            data: {
                batchId: batchId,
                membersToSplit: membersToSplit.length,
                memberIds: membersToSplit.map(m => m.id)
            }
        });

        let totalSplitTransactions = 0;
        let membersActuallySplit = 0;

        // Process each member for splitting - WITH PROGRESS TO REPORT
        const splittingAdapter = new ProgressToConsoleAdapter(batchId, this.progressSink, {
            title: "Splitting Failed Transactions",
            cancellable: true
        });

        await splittingAdapter.withProgress(async (progress: any, cancellationToken: any) => {
            const startTime = Date.now();
            const totalToSplit = membersToSplit.length;

            for (let i = 0; i < membersToSplit.length; i++) {
                // Check for cancellation
                if (cancellationToken.isCancellationRequested) {
                    this.logger.info(`[BatchExecutionEngine] Split process cancelled by user at ${i}/${totalToSplit}`, undefined, {
                        batchId,
                        splitProgress: i,
                        totalToSplit,
                        membersActuallySplit
                    });
                    await this.logBatchEvent(batchId, {
                        level: 'info',
                        phase: 'orchestration',
                        event: 'split_cancelled',
                        data: {
                            batchId,
                            splitProgress: i,
                            totalToSplit,
                            membersActuallySplit
                        }
                    });
                    throw new Error(`Split process cancelled by user. ${membersActuallySplit} transactions were split.`);
                }

                const member = membersToSplit[i];

                // Calculate ETA for remaining transactions
                let etaText = '';
                if (i > 0) {
                    const avgTime = (Date.now() - startTime) / i;
                    const remaining = totalToSplit - i;
                    const etaSeconds = Math.round((remaining * avgTime) / 1000);
                    etaText = etaSeconds > 0 ? `. ETA ${formatDuration(etaSeconds)}` : '';
                }

                // Update progress BEFORE processing
                progress.report({
                    message: `Processing transaction ${i + 1} of ${totalToSplit}${etaText}`,
                    increment: (100 / totalToSplit)
                });

                try {
                    // Check if member can be split
                    const canSplit = await splitter.canSplitTransaction(member);
                    if (!canSplit) {
                        this.logger.warn(`[BatchExecutionEngine] Member ${member.id} cannot be split (no array data)`, undefined, {
                            memberId: member.id,
                            status: member.status
                        });
                        continue;
                    }

                    // Split the transaction
                    const splitResult = await splitter.splitArrayTransaction(member.id, batchId);
                    totalSplitTransactions += splitResult.splitTransactionIds.length;
                    membersActuallySplit++;

                    // Log successful split
                    await this.logBatchEvent(batchId, {
                        level: 'info',
                        phase: 'orchestration',
                        event: 'transaction_split_completed',
                        data: {
                            batchId: batchId,
                            originalMemberId: member.id,
                            splitTransactionIds: splitResult.splitTransactionIds,
                            elementsCount: splitResult.elementsCount,
                            originalFilePath: splitResult.originalFilePath
                        }
                    });

                } catch (error) {
                    this.logger.error(`[BatchExecutionEngine] Failed to split member ${member.id}`, error instanceof Error ? error : undefined, {
                        memberId: member.id,
                        batchId: batchId
                    });

                    // Log split failure
                    await this.logBatchEvent(batchId, {
                        level: 'error',
                        phase: 'orchestration',
                        event: 'transaction_split_failed',
                        data: {
                            batchId: batchId,
                            originalMemberId: member.id,
                            errorMessage: error instanceof Error ? error.message : 'Unknown error'
                        }
                    });
                }
            }

            // Final progress update
            progress.report({
                message: `Split ${membersActuallySplit} transactions into ${totalSplitTransactions} individual transactions`,
                increment: 0
            });
        });

        if (membersActuallySplit === 0) {
            throw new Error('No transactions could be split (no array data found)');
        }

        // Update batch status and rows count (splitting changes total member count)
        const currentMembers = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);
        const actualMemberCount = currentMembers.length;

        await this.updateBatchMetadata(batchId, {
            status: 'pending',
            completedAt: undefined,
            startedAt: undefined,
            createdAt: new Date(),
            rows: String(actualMemberCount)
        });

        // Clear any in-memory state so it gets reconstructed
        this.batchStates.delete(batchId);

        // Log completion
        await this.logBatchEvent(batchId, {
            level: 'info',
            phase: 'orchestration',
            event: 'split_reprocess_completed',
            data: {
                batchId: batchId,
                membersProcessed: membersToSplit.length,
                membersActuallySplit: membersActuallySplit,
                totalSplitTransactions: totalSplitTransactions,
                newStatus: 'pending'
            }
        });

        // Refresh Console with updated member list (split children added, originals marked as 'split')
        await this.sendStatusUpdateToReport(batchId, 'pending', undefined, true);

        // Start batch execution (in background)
        this.logger.info(`[BatchExecutionEngine] Starting split batch execution for ${batchId}`, undefined, { batchId });
        this.executeBatch(batchId).catch(error => {
            this.logger.error(`[BatchExecutionEngine] Split batch execution failed for ${batchId}`, error instanceof Error ? error : undefined);
        });

        this.logger.info(`[BatchExecutionEngine] Split and reprocess completed for batch ${batchId}. Split ${membersActuallySplit} members into ${totalSplitTransactions} individual transactions.`, undefined, {
            batchId,
            membersActuallySplit,
            totalSplitTransactions
        });
    }

    /**
     * Read parallel processing configuration from batch metadata (GitHub Issue #78)
     * @param batchId - The batch execution ID to read config for
     * @returns Promise<ParallelProcessingConfig | undefined>
     */
    private async readParallelProcessingConfig(batchId: string): Promise<{ enabled: boolean; maxConcurrency: number } | undefined> {
        try {
            // Get batch metadata to find the configuration
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                this.logger.debug('[BatchExecutionEngine] No batch metadata found for parallel processing config');
                return undefined;
            }

            // Check batchConfiguration.parallelProcessing (primary storage location)
            const batchConfig = (batchMetadata as any).batchConfiguration;
            if (batchConfig?.parallelProcessing) {
                const parallelConfig = batchConfig.parallelProcessing;

                // Validate the configuration structure
                if (typeof parallelConfig.enabled === 'boolean' &&
                    [1, 2, 4, 8, 16].includes(parallelConfig.maxConcurrency)) {
                    this.logger.debug(`[BatchExecutionEngine] Loaded parallel processing config: enabled=${parallelConfig.enabled}, maxConcurrency=${parallelConfig.maxConcurrency}`);
                    return {
                        enabled: parallelConfig.enabled,
                        maxConcurrency: parallelConfig.maxConcurrency
                    };
                } else {
                    this.logger.warn('[BatchExecutionEngine] Invalid parallel processing configuration structure', undefined, {
                        batchId,
                        parallelConfig
                    });
                }
            }

            this.logger.debug('[BatchExecutionEngine] No parallel processing configuration found in batch metadata');
            return undefined;
        } catch (error) {
            this.logger.warn('[BatchExecutionEngine] Failed to read parallel processing config', error instanceof Error ? error : undefined);
            return undefined;
        }
    }

    /**
     * GitHub Issue #156: Read environment's max concurrency setting
     *
     * This reads the ENVIRONMENT's parallelProcessing.maxConcurrency, NOT the batch's current setting.
     * The environment max is the ceiling that users cannot exceed when adjusting threads in Settings.
     *
     * @param batchId - The batch ID to get environment config for
     * @returns The environment's max concurrency (defaults to 16 if not found)
     */
    private async readEnvironmentMaxConcurrency(batchId: string): Promise<number> {
        try {
            const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);
            if (!batchMetadata?.environmentId) {
                return 16; // Default if no environment
            }

            // GitHub Issue #156: Use environmentManager from dependencies (injected via DI)
            if (!this.dependencies.environmentManager) {
                return 16;
            }

            const environment = await this.dependencies.environmentManager.getEnvironment(batchMetadata.environmentId);
            if (!environment) {
                return 16;
            }

            return environment.parallelProcessing?.maxConcurrency || 16;
        } catch (error) {
            this.logger.warn('[BatchExecutionEngine] Failed to read environment max concurrency', error instanceof Error ? error : undefined);
            return 16; // Default on error
        }
    }

    /**
     * Send member result to any open batch report for live updates
     */
    /**
     * #298: a paginated batch starts with pagesComplete false when its responses report a total.
     * When a run of it finishes (page 1, Fetch all, a page range), it is complete once as many
     * pages have completed as the latest page's total needs. Here, in the engine, so it holds
     * whether or not a Console is open. One response is read, and only for such a batch.
     */
    private async markPagesComplete(batchId: string): Promise<void> {
        const metadata = this.dependencies.executionMetadataService;
        const batch = await metadata?.getExecution(batchId);
        if (!metadata || !batch?.endpointConfig || batch.batchConfiguration?.pagesComplete !== false) return;
        const pages = (await metadata.getBatchMemberFiles(batchId))
            .filter(m => String(m.status).toLowerCase() === 'completed' && m.responseFile)
            .sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());
        const latest = pages[pages.length - 1];
        const text = latest?.responseFile ? readRunFileIfExists(latest.responseFile) : undefined;
        if (!text) return;
        const needed = new PaginationDetectorService().totalPagesFromResponse(batch.endpointConfig, (JSON.parse(text) as { data?: unknown })?.data);
        if (needed === undefined) {
            // No page size to measure by (not in the request nor the response): how many pages
            // there should be can't be known, so the batch is not flagged (only flag what we know)
            const { pagesComplete: _unknown, ...rest } = batch.batchConfiguration ?? {};
            await metadata.updateExecution(batchId, { batchConfiguration: rest as typeof batch.batchConfiguration });
            return;
        }
        if (pages.length < needed) return;
        await metadata.updateExecution(batchId, { batchConfiguration: { ...batch.batchConfiguration, pagesComplete: true } });
    }

    private async sendMemberResultToReport(
        batchId: string,
        memberId: string,
        memberResult: any,
        memberIndex: number,
        totalMembers: number
    ): Promise<void> {
        try {
            // Get member execution metadata to get response file
            const memberMetadata = await this.dependencies.executionMetadataService?.getExecution(memberId);
            if (!memberMetadata?.responseFile) {
                this.logger.debug(`[BatchExecutionEngine] No response file for member ${memberId}, skipping result update`);
                return;
            }

            // Read and parse response file
            if (!runFileExists(memberMetadata.responseFile)) {
                this.logger.warn(`[BatchExecutionEngine] Response file not found for member ${memberId}: ${memberMetadata.responseFile}`);
                return;
            }

            const responseContent = readRunFile(memberMetadata.responseFile);
            const responseData = JSON.parse(responseContent);

            // Create RawResponse object
            // GitHub Issue #166: Include actual status from database (not derived from classification)
            const rawResponse = {
                httpStatus: responseData.httpStatus || memberResult.httpStatus,
                status: memberMetadata.status,  // Actual status from database: 'completed' or 'error'
                data: responseData.data,
                metadata: {
                    executionId: memberId,
                    sourceFile: memberMetadata.responseFile ? path.basename(memberMetadata.responseFile) : undefined,
                    responseTime: memberResult.duration,
                    timestamp: new Date().toISOString(),
                    status: memberMetadata.status,  // Also in metadata for consistency
                    // #428: why it is an error (a failed test on a 200 says so)
                    ...(memberMetadata.errorMessage ? { errorMessage: memberMetadata.errorMessage } : {}),
                    ...(memberMetadata.testStatus ? { testStatus: memberMetadata.testStatus } : {}),
                    reprocessCount: (memberMetadata as { reprocessCount?: number }).reprocessCount || 0,
                    // Issue #304: which input rows this transaction sent
                    rowStart: memberMetadata.rowStart,
                    rows: memberMetadata.rows
                }
            };

            // #428: the saved status decides, as it does for the Console's tables. A 200 whose
            // test failed is saved as an error; classifying by the HTTP status counted it under
            // Completed live and moved it to Error on the next reload. The HTTP status is only
            // the fallback for a record with no status.
            const httpStatus = typeof rawResponse.httpStatus === 'number' ? rawResponse.httpStatus : 500;
            const savedStatus = String(memberMetadata.status || '').toLowerCase();
            const classification: 'success' | 'errors' = savedStatus === 'completed' ? 'success'
                : (savedStatus === 'error' || savedStatus === 'failed') ? 'errors'
                : (httpStatus >= 200 && httpStatus < 400) ? 'success' : 'errors';

            // Send to report
            await this.progressSink.memberResult(batchId, {
                result: rawResponse,
                classification,
                memberIndex,
                totalMembers
            });

        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to send member result to report for ${memberId}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Send live status update to any open report webview
     */
    /**
     * Issue #311: how long this batch has actually been running, across every
     * session — earlier sessions (`activeRunMs`) plus the live one.
     */
    private activeRunMs(batchState: BatchExecutionState): number {
        const earlier = batchState.activeRunMs || 0;
        // Waiting for VS Code mid-run (#344): the clock stands still
        const live = batchState.status === BatchStatus.RUNNING && batchState.startedAt && !batchState.awaiting
            ? Date.now() - batchState.startedAt.getTime()
            : 0;
        return earlier + live;
    }

    /**
     * Issue #311: the `startTime` the Console's clock counts from. It runs
     * `now - startTime`, so handing it `now - activeRunMs` makes the clock show
     * the total run time and keep counting — never reset by a resume.
     */
    private displayStartTime(batchState: BatchExecutionState): number {
        return Date.now() - this.activeRunMs(batchState);
    }

    /**
     * Issue #311: call BEFORE a status leaves 'running' (pause, stop, cancel,
     * complete). Folds the live session into `activeRunMs`; returns the total,
     * which the caller persists as `runTime`.
     */
    private closeRunSession(batchState: BatchExecutionState): number {
        batchState.activeRunMs = this.activeRunMs(batchState);
        return batchState.activeRunMs;
    }

    /**
     * Issue #311: make the in-memory tallies agree with the database before a
     * resume. The Console's bottom progress count is painted from these on the
     * first status update after Resume; stale values (members cancelled in
     * flight, errors reset to pending) made it disagree with the tab counts.
     */
    private async syncCountsFromDatabase(batchId: string, batchState: BatchExecutionState): Promise<void> {
        const counts = (await this.countMembersByStatus(batchId)) || {};
        batchState.successfulMembers = counts.completed || 0;
        batchState.failedMembers = counts.error || 0;
        batchState.cancelledMembers = counts.cancelled || 0;
        batchState.completedMembers = ['completed', 'error', 'cancelled', 'split'].reduce((n, st) => n + (counts[st] || 0), 0);
    }

    private async sendStatusUpdateToReport(batchId: string, status: string, errorMessage?: string, forceReload?: boolean): Promise<void> {
        try {
            // Get latest execution metadata for response data
            const executionMetadata = await this.dependencies.executionMetadataService?.getExecution(batchId);
            if (!executionMetadata) {
                return;
            }

            // Create status display
            let statusDisplay = '';
            const duration = '';

            switch (status) {
                case 'preparing':
                    statusDisplay = '⏳ Preparing';
                    break;
                case 'running':
                    statusDisplay = '🔄 Running';
                    break;
                case 'completed':
                    statusDisplay = '✅ Completed';
                    break;
                case 'stopped':
                    statusDisplay = '⏹️ Stopped';
                    break;
                case 'paused':
                    statusDisplay = '⏸️ Paused';
                    break;
                case 'cancelled':
                    statusDisplay = '❌ Cancelled';
                    break;
                case 'error':
                    statusDisplay = '❌ Failed';
                    break;
                default:
                    statusDisplay = status;
            }

            // Calculate duration for ALL states (not just completed)
            // Use createdAt for total time (prep + execution)
            let durationSeconds;
            if (executionMetadata.createdAt) {
                const startTime = new Date(executionMetadata.createdAt);
                const endTime = executionMetadata.completedAt
                    ? new Date(executionMetadata.completedAt)  // Completed: use actual end time
                    : new Date();  // Running/Preparing: use current time

                durationSeconds = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
            }

            // Add progress data for all statuses so the frontend can initialise the count/bar
            const batchState = this.batchStates.get(batchId);
            if (batchState) {
                // Issue #311: a batch with live state reports its real run time
                durationSeconds = Math.floor(this.activeRunMs(batchState) / 1000);
            }
            let progress;
            if (batchState && (status === 'completed' || status === 'stopped' || status === 'error')) {
                progress = {
                    completed: batchState.totalMembers, // Show final count, not n-1
                    total: batchState.totalMembers,
                    percentage: 100
                };
            } else if (batchState) {
                // Running/preparing/pending/paused/cancelled — show actual progress
                const completedCount = batchState.completedMembers || 0;
                progress = {
                    completed: completedCount,
                    total: batchState.totalMembers,
                    percentage: batchState.totalMembers > 0 ? Math.round((completedCount / batchState.totalMembers) * 100) : 0
                };
            }

            // Send update to any open report
            await this.progressSink.status(batchId, {
                status,
                statusDisplay,
                errorMessage,
                durationSeconds,
                // Issue #311: the clock counts from here — total run time, resume-proof
                startTime: batchState
                    ? this.displayStartTime(batchState)
                    : (executionMetadata.createdAt ? new Date(executionMetadata.createdAt).getTime() : undefined),
                progress,
                forceReload
            });

        } catch (error) {
            this.logger.warn(`[BatchExecutionEngine] Failed to send status update to report for ${batchId}`, error instanceof Error ? error : undefined, { batchId });
        }
    }

    /**
     * Send member-level status updates to any open Console webview (fire-and-forget)
     * Used to notify when members transition from pending to running
     */
    private sendMemberStatusUpdateToConsole(
        batchId: string,
        executionIds: string[],
        status: string,
        memberIndices?: Record<string, number>,
        memberEndpointInfo?: Record<string, { endpointPath?: string; requestHeaders?: Record<string, string>; requestQueryParams?: Record<string, string> }>
    ): void {
        this.progressSink.memberStatus(batchId, executionIds, status, memberIndices, memberEndpointInfo)
            .catch(error => {
                this.logger.debug('[BatchExecutionEngine] Failed to send member status update',
                    error instanceof Error ? error : undefined);
            });
    }

    private telemetryProgressFor(batchId: string, batchState: BatchExecutionState) {
        let progress = this.telemetryProgress.get(batchId);
        if (!progress) {
            progress = { apiCalls: 0, rows: 0, successes: 0, failures: 0, batchRunRecorded: false, clockMs: batchState.startedAt?.getTime() ?? Date.now() };
            this.telemetryProgress.set(batchId, progress);
        }
        return progress;
    }

    /**
     * Report a member the moment it completes — one API call, its rows, its outcome and the
     * wall-clock time since the previous report — so Weekly Usage moves while a batch (or a
     * Fetch All) is running rather than only at the end. The batch run itself is reported with
     * the first member. Completion then reports only what is left.
     */
    private recordMemberTelemetry(batchId: string, batchMeta: any, batchState: BatchExecutionState, member: any, success: boolean): void {
        const telemetry = this.dependencies.dbmnTelemetry?.();
        if (!telemetry) {
            return;
        }
        const progress = this.telemetryProgressFor(batchId, batchState);
        const now = Date.now();
        const durationMs = Math.max(0, now - progress.clockMs);
        progress.clockMs = now;
        const rows = Math.max(1, this.parseExpectedMemberCount(String(member?.rows ?? '1')) || 1);
        const delta = {
            batchRuns: progress.batchRunRecorded ? 0 : 1,
            rows,
            successes: success ? 1 : 0,
            failures: success ? 0 : 1,
            durationMs
        };
        progress.batchRunRecorded = true;
        progress.apiCalls++;
        progress.rows += rows;
        progress.successes += delta.successes;
        progress.failures += delta.failures;

        telemetry.recordApiCall();
        telemetry.recordBatchProgress(delta);
    }

    /**
     * Record telemetry for a completed batch: whatever recordMemberTelemetry() has not reported
     * yet — the run itself if no member completed through the loop, rows the members did not
     * account for (the CSV row count is authoritative), members completed elsewhere, and the
     * time since the last member report.
     * Called from both normal completion and early termination (stopped/cancelled/paused)
     * so that ALL batch executions (normal, pagination, batch-copy) are captured in one place.
     */
    private async recordBatchTelemetry(batchId: string, batchState: BatchExecutionState): Promise<void> {
        try {
            const telemetry = this.dependencies.dbmnTelemetry?.();
            if (!telemetry || batchState.completedMembers <= 0) {
                return;
            }

            const batchMeta = await this.dependencies.executionMetadataService.getExecution(batchId);

            const progress = this.telemetryProgressFor(batchId, batchState);
            // Use actual CSV row count for "Rows Processed" telemetry, not transaction count
            const csvRowCount = batchMeta?.preparationState?.totalRows || batchState.completedMembers;
            const endMs = batchState.completedAt?.getTime() ?? Date.now();
            telemetry.recordBatchProgress({
                batchRuns: progress.batchRunRecorded ? 0 : 1,
                rows: Math.max(0, csvRowCount - progress.rows),
                successes: Math.max(0, batchState.successfulMembers - progress.successes),
                failures: Math.max(0, batchState.failedMembers - progress.failures),
                durationMs: Math.max(0, endMs - progress.clockMs)
            });
            for (let i = progress.apiCalls; i < batchState.completedMembers; i++) {
                telemetry.recordApiCall();
            }
        } catch (error) {
            this.logger.warn('[BatchExecutionEngine] Failed to record telemetry', error instanceof Error ? error : undefined);
        } finally {
            this.telemetryProgress.delete(batchId);
        }
    }

}

/**
 * GitHub Issue #336: whether the Console is due a new "Remaining" estimate. The first waits for
 * enough to go on (5 completions, or 15 s for a slow API), early ones come every 10 s so a guess
 * from little data is soon corrected, and after the first minute every 60 s.
 */
export function etaUpdateDue(elapsedSeconds: number, completions: number, msSinceLastUpdate: number | undefined): boolean {
    if (elapsedSeconds < 5) return false;
    if (msSinceLastUpdate === undefined) return completions >= 5 || elapsedSeconds >= 15;
    return msSinceLastUpdate >= (elapsedSeconds < 65 ? 10_000 : 60_000);
}
