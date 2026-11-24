// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    ITransactionPreparationService,
    TransactionPreparationInput,
    TransactionPreparationResult,
    TransactionPreparationOptions
} from './transaction-preparation.interface';
import { ITransactionHandler } from './handlers/transaction-handler.interface';
import { IArrayRepetitionHelper, ArrayRepetitionConfig } from './helpers/array-repetition.helper';
import { QueryParamRepetitionHelper } from './helpers/query-param-repetition.helper';
import { IExecutionMetadataService } from '../execution/execution-metadata.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { IExecutionLoggingService, LogEvent } from '../logging/execution-logging.interface';
import { ITransactionCreator } from '../transaction-creator/transaction-creator.interface';
import { formatDuration } from '../../utils/time-formatter';
import { flattenQueryParams } from '../../utils/jwt-validation';
import { APIEndpointConfig } from '../../data-loading/zod-schemas';
import { effectiveRepeatableArrays } from '../../data-loading/batch-plan';
import { ProgressToConsoleAdapter } from '../progress-adapter/progress-to-console-adapter';
import { IExecutionProgressSink, NO_PROGRESS_SINK } from '../../platform/interfaces/execution-progress-sink.interface';
import { PaginationDetectorService } from '../pagination/pagination-detector.service';
import * as fs from 'fs';
import * as path from 'path';


/**
 * Dependencies for TransactionPreparationService
 * Following Architecture.md dependency injection patterns
 */
export interface TransactionPreparationServiceDependencies {
    /** Issue #320: where Console progress goes; dropped when absent */
    progressSink?: IExecutionProgressSink;

    /** Handler for individual "Run API" transactions */
    individualHandler: ITransactionHandler;

    /** Handler for batch parent transactions */
    batchHandler: ITransactionHandler;

    /** Handler for batch member transactions */
    batchMemberHandler: ITransactionHandler;

    /** Helper for array repetition calculations */
    arrayRepetitionHelper: IArrayRepetitionHelper;

    /** Service for updating execution metadata */
    executionMetadataService: IExecutionMetadataService;

    /** Optional execution logging service for structured logs */
    executionLoggingService?: IExecutionLoggingService;

    /** Optional notification service for user feedback */
    notificationService?: {
        showSuccess(message: string): void;
        showError(message: string): void;
    };

    /** GitHub Issue #94: Transaction creator for chunked just-in-time preparation */
    transactionCreator: ITransactionCreator;

    /** GitHub Issue #119: JSON generator for unified nested array handling */
    jsonGenerator: any; // JsonGenerator from data-loading
}

/**
 * Unified Transaction Preparation Service
 * Implements the Transaction Preparation Architecture with handler pattern
 * Supports preparing → pending status flow for all execution types
 */
export class TransactionPreparationService implements ITransactionPreparationService {

    /**
     * Cancellation signals for JIT preparation
     * Map<batchId, cancelled>
     * GitHub Issue #94 - Just-In-Time preparation cancellation
     */
    private preparationCancelled = new Map<string, boolean>();

    /**
     * GitHub Issue #108: Helper for query parameter repetition
     */
    private queryParamHelper = new QueryParamRepetitionHelper();

    constructor(
        private dependencies: TransactionPreparationServiceDependencies,
        private logger: IExtensionDiagnosticLogger
    ) { }

    /** Issue #320: the Console (in VS Code) or a recorder (in `test:core`); never imported directly. */
    private get progressSink(): IExecutionProgressSink {
        return this.dependencies.progressSink ?? NO_PROGRESS_SINK;
    }

    /**
     * Cancel batch preparation in progress
     * Signals background JIT preparation to stop creating new chunk members
     * GitHub Issue #94 - Just-In-Time preparation cancellation
     */
    public cancelBatchPreparation(batchId: string): void {
        this.preparationCancelled.set(batchId, true);
        this.logger.info(`[JIT] Cancellation signal set for batch ${batchId}`);
    }

    /**
     * Helper method to log batch preparation events to file
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
            this.logger.warn(`[TransactionPreparation] Failed to log event for batch ${batchId}`, error instanceof Error ? error : undefined);
        }
    }

    async prepareIndividualTransaction(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult> {
        const { endpoint, environment, environmentId, environmentFolder, organization } = input;

        // Validate input
        this.validateIndividualInput(input);

        try {
            // Create individual transaction using handler
            // GitHub Issue #145: Pass userParameters for unified JSON generation
            const result = await this.dependencies.individualHandler.createTransaction({
                endpoint,
                environment,
                environmentId,
                environmentFolder,
                organization: organization || '', // Use empty string if no organization is set
                workspaceRoot: input.workspaceRoot,
                userParameters: input.userParameters // Pass user params to handler
            });

            // Update status to 'pending' (ready for ExecutionEngine)
            // #298: and the header variables' values it runs with (Compare shows them)
            await this.dependencies.executionMetadataService.updateExecution(result.executionId, {
                status: 'pending',
                ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {})
            });

            // Auto-open report for individual transaction creation
            try {
                await this.progressSink.openConsole(result.executionId, { isBatch: false });
            } catch (error) {
                this.logger.warn(`[TransactionPreparation] Failed to auto-open report for individual transaction ${result.executionId}`, error instanceof Error ? error : undefined);
            }

            // Show success notification
            this.dependencies.notificationService?.showSuccess(
                `Individual transaction prepared: ${endpoint.name || 'API'}`
            );

            return {
                executionId: result.executionId,
                filePaths: {
                    request: result.requestFilePath
                },
                transactionCount: 1,
                status: 'pending'
            };

        } catch (error) {
            this.dependencies.notificationService?.showError(
                `Failed to prepare individual transaction: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            throw error;
        }
    }

    async prepareBatchTransactions(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult> {
        const { environment, environmentId, environmentFolder, organization, csvData, batchConfig } = input;

        // Validate input
        this.validateBatchInput(input);

        // GitHub Issue #354: the array setting Step 4 showed, not whatever is saved on the endpoint
        const endpoint = this.withPlannedArrays(input.endpoint);

        if (!csvData || csvData.length === 0) {
            throw new Error('CSV data is required for batch transactions');
        }

        // Use workspace root from input

        try {

            // Note: Analysis progress no longer reported to main bar - dedicated batch prep bar handles this

            // GitHub Issue #108: Check if query param repetition is enabled
            const repeatableQueryParam = batchConfig?.repeatableQueryParam;
            let queryParamAnalysis: any = null;

            if (repeatableQueryParam?.enabled) {
                // GitHub Issue #108: Validate paramKey field exists
                if (!repeatableQueryParam.paramKey) {
                    throw new Error('Query param repetition requires paramKey field');
                }

                queryParamAnalysis = await this.queryParamHelper.analyzeQueryParamRepetition(
                    csvData,
                    repeatableQueryParam as any, // Type assertion after validation
                    input.columnMappings
                );
                this.warnOnDroppedRepetitionRows(queryParamAnalysis, endpoint?.name || endpoint?.id || 'batch');
            }

            // Phase 1: Analyze array repetition requirements (fallback if no query param repetition)
            // Extract the actual repeatable arrays configuration from endpoint
            const endpointArrays = endpoint.dataLoadingConfig?.repeatableArrays;

            const arrayConfig: ArrayRepetitionConfig = {
                detectArrays: true,
                repeatableArrays: endpointArrays ? endpointArrays.map(arr => ({
                    enabled: arr.enabled,
                    maxRepetitions: arr.maxRepetitions,
                    fieldName: arr.arrayPath || 'unknown'
                })) : (batchConfig?.rowsPerTransaction ? [{
                    enabled: true,
                    maxRepetitions: batchConfig.rowsPerTransaction,
                    fieldName: 'auto'
                }] : undefined),
                rowsPerTransaction: batchConfig?.rowsPerTransaction
            };


            const arrayAnalysis = await this.dependencies.arrayRepetitionHelper.analyzeArrayRepetition(
                csvData,
                arrayConfig
            );

            // Note: Batch parent creation no longer reported to main bar

            // Phase 2: Create batch parent with 'preparing' status
            const batchResult = await this.dependencies.batchHandler.createTransaction({
                endpoint,
                environment,
                environmentId,
                environmentFolder,
                organization: organization || '', // Use empty string if no organization is set
                workspaceRoot: input.workspaceRoot,
                csvRowData: csvData,
                batchName: input.batchName, // Pass batch name to handler for custom CSV filename
                batchConfig: batchConfig, // GitHub Issue #78: Pass batch configuration including parallel processing
                overrideBatchId: input.overrideBatchId // GitHub Issue #176: Deterministic batch copy ID
            });

            const batchId = batchResult.executionId; // Use executionId as batchId (architecture compliance)

            // Log preparation started
            await this.logBatchEvent(batchId, {
                level: 'info',
                phase: 'preparation',
                event: 'PREPARATION_STARTED',
                data: {
                    csvFile: batchResult.requestFilePath,
                    totalRows: csvData.length,
                    batchName: input.batchName || 'unnamed'
                }
            });

            // GitHub Issue #48: Store column mappings in batch metadata
            if (input.columnMappings && this.dependencies.executionMetadataService) {
                try {
                    await this.dependencies.executionMetadataService.updateExecution(batchId, {
                        columnMappingUsed: Object.entries(input.columnMappings).map(([templateVariable, csvColumn]) => ({
                            templateVariable,
                            csvColumn,
                            mappingType: 'csvColumn',
                            dataType: 'string'
                        }))
                    });
                    this.logger.info(`Stored column mappings for batch ${batchId}`, { mappingCount: Object.keys(input.columnMappings).length });

                    // Log column mappings configured
                    await this.logBatchEvent(batchId, {
                        level: 'info',
                        phase: 'preparation',
                        event: 'COLUMN_MAPPINGS_CONFIGURED',
                        data: {
                            mappings: Object.entries(input.columnMappings).map(([templateVariable, csvColumn]) => ({
                                templateVariable,
                                csvColumn
                            })),
                            mappingCount: Object.keys(input.columnMappings).length
                        }
                    });
                } catch (error) {
                    this.logger.warn(`Failed to store column mappings for batch ${batchId}`, error);
                }
            }

            // GitHub Issue #165: Store environment variables in batch metadata for prepareNextChunk
            // (#424/#160: and the base URL its members go to, fixed now)
            if ((input.environmentVariables && Object.keys(input.environmentVariables).length > 0) || input.baseUrl) {
                try {
                    await this.dependencies.executionMetadataService.updateExecution(batchId, {
                        ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {}),
                        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {})
                    });
                    this.logger.info(`Stored environment variables for batch ${batchId}`, { variableCount: Object.keys(input.environmentVariables ?? {}).length, baseUrl: input.baseUrl });
                } catch (error) {
                    this.logger.warn(`Failed to store environment variables for batch ${batchId}`, error);
                }
            }

            // 🎯 State broadcasting will automatically trigger Active Queue refresh

            // Update batch execution record with correct CSV file path
            await this.dependencies.executionMetadataService.updateExecution(batchId, {
                requestFile: batchResult.requestFilePath
            });

            // ==================================================================
            // GitHub Issue #94 - Just-In-Time Streaming Preparation
            // ==================================================================
            // Prepare FIRST CHUNK synchronously (2-3 seconds)
            // Execution engine will trigger refills via prepareNextChunk() when needed

            const maxParallel = input.batchConfig?.parallelProcessing?.maxConcurrency || 1;

            this.logger.info(`[JIT] Starting first chunk preparation for batch ${batchId}, maxParallel=${maxParallel}`);

            // Prepare first chunk (BLOCKING call, but fast: 2-3 seconds)
            // GitHub Issue #150: Pass preCalculatedTransactions for single source of truth
            // GitHub Issue #165: Pass environmentVariables for {{ENV:varName}} template substitution
            const firstChunkSize = await this.prepareFirstChunk(
                batchId,
                csvData,
                arrayAnalysis,
                maxParallel,
                endpoint,
                environment,
                environmentId,
                environmentFolder,
                organization,
                input.workspaceRoot,
                input.columnMappings,
                queryParamAnalysis, // GitHub Issue #108: Pass query param analysis
                input.preCalculatedTransactions, // GitHub Issue #150: Pre-calculated total from Step 3
                input.environmentVariables // GitHub Issue #165: ENV variable substitution
            );

            // Get updated batch metadata to get totalTransactions
            const updatedBatch = await this.dependencies.executionMetadataService.getExecution(batchId);
            const totalTransactions = updatedBatch?.preparationState?.totalTransactions || 0;

            this.logger.info(`[JIT] First chunk prepared: ${firstChunkSize}/${totalTransactions} transactions ready. Batch status: PENDING`);

            // Log preparation started
            await this.logBatchEvent(batchId, {
                level: 'info',
                phase: 'preparation',
                event: 'PREPARATION_FIRST_CHUNK_COMPLETE',
                data: {
                    firstChunkSize: firstChunkSize,
                    totalTransactions: totalTransactions,
                    csvRows: csvData.length,
                    batchName: input.batchName || 'unnamed'
                }
            });

            // Return immediately - batch is now PENDING and ready for execution
            // Execution engine will trigger refills via prepareNextChunk()
            const result = {
                batchId,
                transactionIds: [], // Not tracked anymore - query from database
                filePaths: {
                    csv: batchResult.requestFilePath,
                    request: batchResult.requestFilePath,
                    batchDirectory: batchResult.directoryPath
                },
                transactionCount: totalTransactions,
                status: 'pending' as const, // Changed from 'preparing' to 'pending'
                arrayAnalysis: {
                    totalRows: arrayAnalysis.totalRows,
                    rowsPerTransaction: arrayAnalysis.rowsPerTransaction,
                    transactionCount: arrayAnalysis.transactionCount,
                    hasArrayFields: arrayAnalysis.hasArrayFields
                }
            };

            return result;

        } catch (error) {
            this.dependencies.notificationService?.showError(
                `Failed to prepare batch transactions: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            throw error;
        }
    }


    /**
     * Update batch parent to 'pending' status
     * Note: Batch members are now created as 'pending' directly, so no need to update them
     * This is critical for preventing race conditions with ExecutionEngine
     */
    private async atomicStatusUpdate(batchId: string, memberIds: string[]): Promise<void> {
        // Batch members are already 'pending' (created that way), just update batch parent
        await this.dependencies.executionMetadataService.updateExecution(batchId, {
            status: 'pending'
        });
        
        this.logger.info(`Batch parent ${batchId} updated to pending. All ${memberIds.length} members were already pending.`);
    }

    /**
     * Clean up a failed or cancelled batch by deleting all created transactions
     */
    private async cleanupFailedBatch(batchId: string, memberIds: string[]): Promise<void> {
        try {
            this.logger.info(`Starting cleanup of failed batch: ${batchId} with ${memberIds.length} members`);
            
            let deletedMembers = 0;
            let deletedBatch = false;
            
            // Delete all created batch members
            for (const memberId of memberIds) {
                try {
                    const deleted = await this.dependencies.executionMetadataService.deleteExecution(memberId);
                    if (deleted) {
                        deletedMembers++;
                    }
                } catch (memberError) {
                    this.logger.error(`Failed to delete batch member ${memberId}:`, memberError instanceof Error ? memberError : new Error(String(memberError)));
                }
            }
            
            // Delete the batch parent
            try {
                deletedBatch = await this.dependencies.executionMetadataService.deleteExecution(batchId);
            } catch (batchError) {
                this.logger.error(`Failed to delete batch parent ${batchId}:`, batchError instanceof Error ? batchError : new Error(String(batchError)));
            }
            
            this.logger.info(`Cleanup complete: deleted ${deletedMembers}/${memberIds.length} members, batch parent: ${deletedBatch ? 'deleted' : 'failed'}`);
        } catch (error) {
            this.logger.error(`Critical error during batch cleanup for ${batchId}:`, error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Validate input for individual transactions
     */
    private validateIndividualInput(input: TransactionPreparationInput): void {
        if (!input.endpoint) {
            throw new Error('Endpoint configuration is required');
        }
        if (!input.environment) {
            throw new Error('Environment is required');
        }
        // Organization is now optional - no validation needed
    }

    /**
     * Trigger UI refresh to show new batch in Active Queue immediately
     */
    private async triggerUIRefresh(): Promise<void> {
        try {
            // 1. Refresh tree view (Active Queue) - multiple approaches to force VS Code to update
            // 2. Force immediate tree view refresh with delay to overcome VS Code batching
            await new Promise(resolve => setTimeout(resolve, 100));

            // 3. Trigger a second refresh to ensure VS Code processes the change
        } catch (error) {
            this.logger.warn(`[TransactionPreparation] UI refresh failed (non-critical)`, error);
            // Don't throw - UI refresh failure shouldn't stop batch execution
        }
    }

    /**
     * Prepare batch members in background (for streaming execution)
     * Runs preparation asynchronously while execution engine polls for pending members
     */
    private async prepareBatchMembersInBackground(
        rowGroups: string[][][],
        batchId: string,
        endpoint: any,
        environment: string,
        environmentId: string | undefined,
        environmentFolder: string | undefined,
        organization: string | undefined,
        workspaceRoot: string,
        memberTransactionIds: string[],
        columnMappings?: Record<string, string>,
        options?: TransactionPreparationOptions,
        csvRowCount?: number
    ): Promise<void> {
        try {
            await this.prepareBatchWithSingleProgress(
                rowGroups,
                batchId,
                endpoint,
                environment,
                environmentId,
                environmentFolder,
                organization,
                workspaceRoot,
                memberTransactionIds,
                columnMappings,
                options
            );

            this.logger.info(`Completed batch preparation: ${memberTransactionIds.length} transactions ready`);

            // Log preparation completed
            await this.logBatchEvent(batchId, {
                level: 'info',
                phase: 'preparation',
                event: 'PREPARATION_COMPLETED',
                data: {
                    transactionCount: memberTransactionIds.length,
                    totalRows: csvRowCount || 0
                }
            });

            // Show success notification
            this.dependencies.notificationService?.showSuccess(
                `Batch prepared! ${memberTransactionIds.length} transactions ready for execution`
            );

        } catch (error) {
            // Error already logged by caller's catch block
            throw error;
        }
    }

    /**
     * Prepare batch with single progress bar - KISS approach
     * Creates batch members as "pending" directly, shows real readiness progress
     */
    private async prepareBatchWithSingleProgress(
        rowGroups: string[][][],
        batchId: string,
        endpoint: any,
        environment: string,
        environmentId: string | undefined,
        environmentFolder: string | undefined,
        organization: string | undefined,
        workspaceRoot: string,
        memberTransactionIds: string[],
        columnMappings?: Record<string, string>, // GitHub Issue #48: Column mappings parameter
        options?: TransactionPreparationOptions
    ): Promise<void> {
        // Use ProgressToConsoleAdapter instead of VS Code notifications
        const preparationAdapter = new ProgressToConsoleAdapter(batchId, this.progressSink, {
            title: "Batch Preparation",
            cancellable: true
        });

        await preparationAdapter.withProgress(async (progress: any, cancellationToken: any) => {
            const startTime = Date.now();
            const totalTransactions = rowGroups.length;
            
            // Create all batch member transactions (they're created as "pending" directly)
            for (let i = 0; i < rowGroups.length; i++) {
                // Check for cancellation
                if (cancellationToken.isCancellationRequested) {
                    this.logger.info(`Batch preparation cancelled by user at ${i}/${rowGroups.length}`);
                    await this.cleanupFailedBatch(batchId, memberTransactionIds);
                    throw new Error(`Batch preparation cancelled by user. Batch ${batchId} has been removed.`);
                }
                
                const rowGroup = rowGroups[i];

                const memberResult = await this.dependencies.batchMemberHandler.createTransaction({
                    endpoint,
                    environment,
                    environmentId,
                    environmentFolder,
                    organization: organization || '', // Use the actual organization from input
                    workspaceRoot,
                    batchId,
                    csvRowData: rowGroup,
                    transactionIndex: i,
                    columnMappings: columnMappings // GitHub Issue #48: Pass column mappings to handler
                });

                memberTransactionIds.push(memberResult.executionId);

                // Calculate ETA for remaining transactions
                let etaText = '';
                if (i > 0) {
                    const avgTime = (Date.now() - startTime) / (i + 1);
                    const remaining = totalTransactions - (i + 1);
                    const etaSeconds = Math.round((remaining * avgTime) / 1000);
                    etaText = etaSeconds > 0 ? `. ETA ${formatDuration(etaSeconds)}` : '';
                }

                // Progress shows real readiness - how many transactions are now "pending" (ready)
                progress.report({
                    message: `Preparing ${i + 1}/${totalTransactions} transactions${etaText}`,
                    increment: (100 / (totalTransactions + 1)) // +1 for final batch parent update
                });

                // Yield control to event loop - allows execution engine to poll and start executing
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            
            // Final step: Update batch parent to "pending" (all members are already "pending")
            progress.report({ 
                message: `${totalTransactions} transactions ready`,
                increment: (100 / (totalTransactions + 1)) // Final increment for batch parent
            });
            
            // Update batch parent to pending - batch is now ready for execution
            await this.dependencies.executionMetadataService.updateExecution(batchId, {
                status: 'pending'
            });
            
            this.logger.info(`Batch preparation complete: ${totalTransactions} members pending, batch parent pending`);
        });
    }

    // ========================================================================
    // Just-In-Time Chunk-Based Preparation Methods
    // GitHub Issue #94 - Streaming preparation with chunk-based refill
    // ========================================================================

    /**
     * Prepare first chunk of batch members synchronously (CREATED → PENDING)
     * Creates first CHUNK_SIZE transactions and returns immediately
     * Execution engine will trigger refills via prepareNextChunk()
     *
     * @param batchId - Batch execution ID
     * @param csvData - Full CSV data (including header)
     * @param arrayAnalysis - Array repetition analysis result
     * @param maxParallel - Max parallel executions from batch config
     * @param endpoint - Endpoint configuration
     * @param environment - Environment name
     * @param environmentId - Environment UUID
     * @param environmentFolder - Environment folder path
     * @param organization - Organization name
     * @param workspaceRoot - Workspace root path
     * @param columnMappings - CSV column to template variable mappings
     * @param queryParamAnalysis - GitHub Issue #108: Optional query param repetition analysis
     * @param preCalculatedTransactions - GitHub Issue #150: Pre-calculated total from Step 3 (single source of truth)
     * @param environmentVariables - GitHub Issue #165: Environment variables for {{ENV:varName}} template substitution
     * @returns Number of transactions created in first chunk
     */

    /**
     * GitHub Issue #224: Build the query params for a query-param-repetition
     * transaction. The repetition helper produces the repeated param value
     * (e.g. `query=ItemId=A or ItemId=B`), but the endpoint's OTHER enabled
     * query params (e.g. `size=90`) were being dropped — so the host fell back
     * to its default page size (20) and silently truncated results. Merge the
     * other enabled params with the computed repeated value so every param is
     * sent. The repeated param is supplied separately and overrides any
     * same-key endpoint value.
     */
    private buildRepetitionQueryParams(
        endpoint: APIEndpointConfig,
        paramKey: string,
        repeatedValue: string
    ): Record<string, string> {
        const otherParams = flattenQueryParams(endpoint.queryParams || {});
        delete otherParams[paramKey];
        return { ...otherParams, [paramKey]: repeatedValue };
    }

    /**
     * GitHub Issue #224: Verify every input item made it into a query group.
     * Rows whose repeated value is blank are skipped during grouping; when that
     * happens the user has no way to know some items were silently dropped.
     * Log a warning (issue#224) with the exact shortfall so it can be verified.
     */
    private warnOnDroppedRepetitionRows(
        analysis: { enabled?: boolean; totalRows?: number; includedRowCount?: number } | null,
        contextLabel: string
    ): void {
        if (!analysis?.enabled) {
            return;
        }
        const totalRows = analysis.totalRows ?? 0;
        const includedRowCount = analysis.includedRowCount ?? 0;
        if (includedRowCount < totalRows) {
            const dropped = totalRows - includedRowCount;
            this.logger.warn(
                `[QueryParamRepetition] issue#224 ${contextLabel}: ${dropped} of ${totalRows} input ` +
                `row(s) were skipped (blank value for the repeated parameter) — ` +
                `${includedRowCount} item(s) included across query groups.`
            );
        } else {
            this.logger.info(
                `[QueryParamRepetition] issue#224 ${contextLabel}: all ${totalRows} input item(s) ` +
                `included across query groups.`
            );
        }
    }

    public async prepareFirstChunk(
        batchId: string,
        csvData: string[][],
        arrayAnalysis: any,
        maxParallel: number,
        endpoint: any,
        environment: string,
        environmentId: string | undefined,
        environmentFolder: string | undefined,
        organization: string | undefined,
        workspaceRoot: string,
        columnMappings?: Record<string, string>,
        queryParamAnalysis?: any,
        preCalculatedTransactions?: number,
        environmentVariables?: Record<string, string>
    ): Promise<number> {
        endpoint = this.withPlannedArrays(endpoint);
        const CHUNK_SIZE = maxParallel * 2;

        this.logger.info(`[JIT] Starting first chunk preparation for batch ${batchId}: CHUNK_SIZE=${CHUNK_SIZE}, maxParallel=${maxParallel}`);

        // GitHub Issue #108: Use query param row groups if available, otherwise use array repetition
        let allRowGroups: string[][][];
        let queryStrings: string[] = [];
        let totalTransactions: number;

        // GitHub Issue #147: Use jsonGenerator.analyzeNestedArrays for CONSISTENT nesting detection
        // Previously used local hasNestedArrays() which missed some cases (e.g., messages[].data:BASE64.ItemCode[])
        const nestingAnalysis = this.dependencies.jsonGenerator.analyzeNestedArrays(endpoint.body || '{}');
        const hasNestedArrays = nestingAnalysis.hasNestedArrays;

        // Track group-based cursor state for nested arrays
        let groupTrackingState: {
            groupingColumn: string;
            groupingColumns: string[];
            totalGroups: number;
            groupsPerFile: number;
        } | undefined;

        if (hasNestedArrays) {
            // NESTED ARRAYS: GitHub Issue #147 - JIT chunking by root elements
            // 1. Grouping columns from template analysis: EVERY outer variable, mapped to its
            // column. A new root element starts when ANY of them changes — the same rule as
            // JsonGenerator.groupingColumnsFor. Keying on the first alone put a whole file in
            // one group whenever the first header field was constant (Lesson 5: buyerGln is
            // one warehouse on every row), so totals and chunk cursors were wrong.
            const groupByColumns = [...new Set((nestingAnalysis.outerVariables ?? [])
                .map((v: string) => this.mapVariableToColumn(v, columnMappings)).filter(Boolean))] as string[];
            const groupByColumn = groupByColumns[0] ?? '';
            const maxRepetitions = this.getMaxRepetitions(endpoint.dataLoadingConfig?.repeatableArrays);

            this.logger.info(`[JIT] Nested arrays detected (level ${nestingAnalysis.nestingLevel}), outerVariables: ${nestingAnalysis.outerVariables}, groupByColumns: ${groupByColumns}, maxReps: ${maxRepetitions}`);

            if (groupByColumn) {
                // 2. GitHub Issue #148: Backend auto-sort removed - frontend handles sorting
                // CSV data arrives pre-sorted from the frontend (on all grouping columns)
                const header = csvData[0];
                const dataRows = csvData.slice(1);
                const rootKey = this.rootKeyFor(header, groupByColumns);

                // 3. Count unique root elements to calculate total transactions
                const uniqueRootElements = new Set(dataRows.map(rootKey));
                const totalRootElements = uniqueRootElements.size;

                // GitHub Issue #150: Use pre-calculated total from Step 3 if available (single source of truth)
                // Otherwise, calculate based on nesting level. At nesting level 1 the count is
                // exact — one request per root element — so it wins over any estimate.
                if (nestingAnalysis.nestingLevel !== 1 && preCalculatedTransactions !== undefined && preCalculatedTransactions > 0) {
                    totalTransactions = preCalculatedTransactions;
                    this.logger.info(`[JIT] Using pre-calculated totalTransactions: ${totalTransactions} (from Step 3 preview)`);
                } else if (nestingAnalysis.nestingLevel === 1) {
                    // nestingLevel=1: Each root element = 1 transaction (maxReps applies to nested items, not root grouping)
                    totalTransactions = totalRootElements;
                    this.logger.info(`[JIT] nestingLevel=1: ${totalRootElements} root elements = ${totalRootElements} transactions`);
                } else {
                    // nestingLevel=2+: Root elements are grouped by maxRepetitions
                    totalTransactions = Math.ceil(totalRootElements / maxRepetitions);
                    this.logger.info(`[JIT] nestingLevel=${nestingAnalysis.nestingLevel}: ${totalRootElements} root elements / ${maxRepetitions} maxReps = ${totalTransactions} transactions`);
                }

                // 4. Grab rows for CHUNK_SIZE transactions
                // GitHub Issue #150: For nestingLevel=1, each root element = 1 transaction
                // For nestingLevel=2+, CHUNK_SIZE transactions = CHUNK_SIZE * maxRepetitions root elements
                const rootElementsForFirstChunk = nestingAnalysis.nestingLevel === 1
                    ? CHUNK_SIZE
                    : CHUNK_SIZE * maxRepetitions;
                const rowsForFirstChunk: string[][] = [];
                let rootElementCount = 0;
                let lastRootValue = '';

                for (const row of dataRows) {
                    const rootValue = rootKey(row);
                    if (rootValue !== lastRootValue) {
                        rootElementCount++;
                        lastRootValue = rootValue;
                        if (rootElementCount > rootElementsForFirstChunk) {
                            break; // Got enough root elements for first chunk
                        }
                    }
                    rowsForFirstChunk.push(row);
                }

                this.logger.info(`[JIT] First chunk: ${rowsForFirstChunk.length} rows covering ${Math.min(rootElementCount, rootElementsForFirstChunk)} root elements`);

                // 5. Pass to generateBatchJsonFiles - it handles batching internally
                const csvString = [header.join(','), ...rowsForFirstChunk.map(r => r.join(','))].join('\n');
                const mappings = columnMappings
                    ? Object.entries(columnMappings).map(([templateVariable, csvColumn]) => ({
                        variable: templateVariable,
                        column: csvColumn,
                        dataType: 'string'
                    }))
                    : header.map(columnName => ({
                        variable: columnName,
                        column: columnName,
                        dataType: 'string'
                    }));

                const jsonGeneratorOptions = {
                    template: endpoint.body || '{}',
                    repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
                    mappings,
                    headers: header,
                    endpointId: endpoint.id,
                    sequenceStartValue: 1001,
                    environmentVariables // GitHub Issue #165: ENV variable substitution
                };

                const filesResult = await this.dependencies.jsonGenerator.generateBatchJsonFiles(csvString, jsonGeneratorOptions);

                if (!filesResult.success) {
                    throw new Error(`Failed to generate JSON: ${filesResult.error}`);
                }

                this.logger.info(`[JIT] generateBatchJsonFiles returned ${filesResult.files.length} files for first chunk`);

                // 6. Create batch_members for each file
                for (let fileIndex = 0; fileIndex < filesResult.files.length; fileIndex++) {
                    const file = filesResult.files[fileIndex];
                    await this.dependencies.batchMemberHandler.createTransaction({
                        endpoint,
                        environment,
                        environmentId,
                        environmentFolder,
                        organization: organization || '',
                        workspaceRoot,
                        batchId,
                        csvRowData: [header], // Minimal - actual data is in preGeneratedJson
                        preGeneratedJson: file.content,
                        transactionIndex: fileIndex,
                        rowStart: file.rowRange?.start || fileIndex + 1,
                        // GitHub Issue #181: Pass actual row count from rowRange for nested arrays
                        rows: file.rowRange ? String(file.rowRange.end - file.rowRange.start + 1) : undefined,
                        columnMappings
                    });
                }

                // 7. Store cursor state for prepareNextChunk
                // GitHub Issue #150: For nestingLevel=1, groupsPerFile=1 (each root element = 1 file)
                const effectiveGroupsPerFile = nestingAnalysis.nestingLevel === 1 ? 1 : maxRepetitions;
                groupTrackingState = {
                    groupingColumn: groupByColumn,
                    groupingColumns: groupByColumns,
                    totalGroups: totalRootElements,
                    groupsPerFile: effectiveGroupsPerFile
                };

                // 8. Update preparation state and return
                const actualBatchMembersCreated = filesResult.files.length;
                const preparedGroups = Math.min(rootElementCount, rootElementsForFirstChunk);

                // Root-variable grouping fix: generateBatchJsonFiles may produce more files
                // than initially estimated (e.g., root CSV variables create separate files).
                // Use the actual count as the source of truth for totalTransactions.
                if (actualBatchMembersCreated > totalTransactions) {
                    this.logger.info(`[JIT] Root-variable grouping: updating totalTransactions from ${totalTransactions} to ${actualBatchMembersCreated} (actual files generated)`);
                    totalTransactions = actualBatchMembersCreated;
                }

                // GitHub Issue #150: With correct totalTransactions, simple transaction-based completion works
                const isComplete = actualBatchMembersCreated >= totalTransactions;

                this.logger.info(`[JIT] Completion check: ${actualBatchMembersCreated}/${totalTransactions} transactions, isComplete=${isComplete}`);

                await this.dependencies.executionMetadataService.updateExecution(batchId, {
                    preparationState: {
                        totalRows: csvData.length,
                        totalTransactions: totalTransactions,
                        preparedTransactions: actualBatchMembersCreated,
                        nextCsvRowIndex: rowsForFirstChunk.length,
                        chunkSize: CHUNK_SIZE,
                        isComplete: isComplete,
                        groupingColumn: groupByColumn,
                        groupingColumns: groupByColumns,
                        totalGroups: totalRootElements,
                        preparedGroups: preparedGroups,
                        groupsPerFile: effectiveGroupsPerFile
                    },
                    rows: `${totalTransactions}(${csvData.length})`
                });

                await this.dependencies.executionMetadataService.updateExecution(batchId, { status: 'pending' });
                this.logger.info(`[JIT] Batch ${batchId} PENDING. First chunk: ${actualBatchMembersCreated}/${totalTransactions} transactions`);
                return actualBatchMembersCreated;
            } else {
                // No grouping column found - fall back to flat array processing
                this.logger.warn(`[JIT] No grouping column found for nested arrays, using flat array path`);
                allRowGroups = this.dependencies.arrayRepetitionHelper.groupRowsForTransactions(csvData, arrayAnalysis);
                totalTransactions = allRowGroups.length;
            }
        } else if (queryParamAnalysis?.enabled) {
            // Use query param repetition row groups
            allRowGroups = queryParamAnalysis.rowGroups.map((g: any) => g.rows);
            queryStrings = queryParamAnalysis.rowGroups.map((g: any) => g.queryString);
            totalTransactions = queryParamAnalysis.transactionCount;

            this.logger.info(`[JIT] Using query param repetition: ${totalTransactions} transactions with repeated query params`);
        } else {
            // Use array repetition (existing logic)
            allRowGroups = this.dependencies.arrayRepetitionHelper.groupRowsForTransactions(
                csvData,
                arrayAnalysis
            );
            totalTransactions = allRowGroups.length;
        }

        this.logger.info(`[JIT] Total transactions calculated: ${totalTransactions} from ${csvData.length} CSV rows`);

        // Take first chunk
        const firstChunk = allRowGroups.slice(0, CHUNK_SIZE);
        const firstChunkQueryStrings = queryStrings.slice(0, CHUNK_SIZE);
        const actualChunkSize = firstChunk.length; // May be less than CHUNK_SIZE if total < CHUNK_SIZE

        this.logger.info(`[JIT] Preparing first chunk: ${actualChunkSize} row groups`);

        // GitHub Issue #119: Use unified JSON generation for all scenarios
        // Call generateBatchJsonFiles() for each row group to handle nested arrays correctly
        let globalTransactionIndex = 0;

        // GitHub Issue #171: Check if this is query param repetition WITHOUT body generation
        // For GET requests with query param repetition, each rowGroup = ONE transaction
        // We don't need to call generateBatchJsonFiles() which creates one file per row
        const isQueryParamOnlyMode = queryParamAnalysis?.enabled &&
            endpoint.method === 'GET' &&
            (!endpoint.body || endpoint.body.trim() === '' || endpoint.body.trim() === '{}');

        if (isQueryParamOnlyMode) {
            this.logger.info(`[JIT] GitHub Issue #171: Query param repetition mode - one transaction per rowGroup`);
        }

        // Create batch members for first chunk
        for (let i = 0; i < firstChunk.length; i++) {
            // Check cancellation
            if (this.preparationCancelled.get(batchId)) {
                this.logger.info(`[JIT] First chunk preparation cancelled at ${i}/${firstChunk.length}`);
                throw new Error(`Batch preparation cancelled during first chunk`);
            }

            const rowGroup = firstChunk[i];

            // Calculate rowStart: which CSV row (1-based) this row group starts at
            // Sum up all data rows consumed by previous row groups
            let rowStart = 1; // Start after header row
            for (let j = 0; j < i && j < allRowGroups.length; j++) {
                // Each rowGroup has [header, ...dataRows]
                // Count data rows only (exclude header at index 0)
                rowStart += (allRowGroups[j].length - 1);
            }

            // GitHub Issue #171: For query param repetition without body, create ONE transaction per rowGroup
            if (isQueryParamOnlyMode) {
                const paramKey = queryParamAnalysis!.queryParamKey;
                const queryStringValue = firstChunkQueryStrings[i];
                // GitHub Issue #224: merge other enabled query params (e.g. size=90)
                const queryParams = this.buildRepetitionQueryParams(endpoint, paramKey, queryStringValue);

                await this.dependencies.batchMemberHandler.createTransaction({
                    endpoint,
                    environment,
                    environmentId,
                    environmentFolder,
                    organization: organization || '',
                    workspaceRoot,
                    batchId,
                    csvRowData: rowGroup,
                    preGeneratedJson: {}, // Empty body for GET request
                    transactionIndex: globalTransactionIndex++,
                    rowStart,
                    columnMappings,
                    queryParams
                });
                continue; // Skip the generateBatchJsonFiles path
            }

            // GitHub Issue #119: Call generateBatchJsonFiles() to get files for this row group
            // This handles all scenarios: no nesting, 2-level, 3-level nesting
            const csvString = this.convertRowGroupToCsvString(rowGroup);

            // GitHub Issue #119: Convert columnMappings Record to array format for JsonGenerator
            const mappings = columnMappings
                ? Object.entries(columnMappings).map(([templateVariable, csvColumn]) => ({
                    variable: templateVariable,
                    column: csvColumn,
                    dataType: 'string' // Default to string, JsonGenerator will handle conversions
                }))
                : rowGroup[0].map(columnName => ({
                    variable: columnName,
                    column: columnName,
                    dataType: 'string' // Fallback: map column names to themselves
                }));

            const jsonGeneratorOptions = {
                template: endpoint.body || '{}',
                repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
                mappings, // Now an array, not an object!
                headers: rowGroup[0], // First row is header
                endpointId: endpoint.id,
                sequenceStartValue: 1001,
                environmentVariables // GitHub Issue #165: ENV variable substitution
            };

            const filesResult = await this.dependencies.jsonGenerator.generateBatchJsonFiles(
                csvString,
                jsonGeneratorOptions
            );

            if (!filesResult.success) {
                throw new Error(`Failed to generate JSON: ${filesResult.error}`);
            }

            if (!filesResult.files || !Array.isArray(filesResult.files)) {
                throw new Error(`generateBatchJsonFiles returned invalid files array: ${typeof filesResult.files}`);
            }

            // Create one batch_member per file returned
            for (let fileIndex = 0; fileIndex < filesResult.files.length; fileIndex++) {
                const file = filesResult.files[fileIndex];

                // GitHub Issue #108: Build query params object using paramKey from analysis
                let queryParams: Record<string, string> | undefined;
                if (queryParamAnalysis?.enabled && firstChunkQueryStrings[i]) {
                    const paramKey = queryParamAnalysis.queryParamKey;
                    const queryStringValue = firstChunkQueryStrings[i];
                    // GitHub Issue #224: merge other enabled query params (e.g. size=90)
                    queryParams = this.buildRepetitionQueryParams(endpoint, paramKey, queryStringValue);
                }

                await this.dependencies.batchMemberHandler.createTransaction({
                    endpoint,
                    environment,
                    environmentId,
                    environmentFolder,
                    organization: organization || '',
                    workspaceRoot,
                    batchId,
                    csvRowData: rowGroup, // Still pass row group for backward compatibility
                    preGeneratedJson: file.content, // GitHub Issue #119: Pass pre-generated JSON
                    transactionIndex: globalTransactionIndex++,
                    rowStart, // Starting CSV row index for this row group (1-based)
                    columnMappings,
                    queryParams // GitHub Issue #108: Pass computed query params
                });
            }
        }

        // GitHub Issue #119: For nested arrays, globalTransactionIndex is the ACTUAL count of batch members created
        // (not firstChunk.length which is just row groups)
        const actualBatchMembersCreated = globalTransactionIndex;

        this.logger.info(`[JIT] First chunk created: ${actualBatchMembersCreated} batch members from ${actualChunkSize} row groups`);

        // GitHub Issue #119: Update totalTransactions for nested arrays based on actual files generated
        if (hasNestedArrays && actualBatchMembersCreated > 0) {
            // For nested arrays, the actual transaction count is determined by generateBatchJsonFiles
            // Set totalTransactions to actual count (may need adjustment if more chunks needed)
            totalTransactions = actualBatchMembersCreated;
            this.logger.info(`[JIT] Updated totalTransactions for nested arrays: ${totalTransactions}`);
        }

        // Update preparation cursor with group tracking state if nested arrays
        const preparationStateUpdate: any = {
            totalRows: csvData.length,
            totalTransactions: totalTransactions,
            preparedTransactions: actualBatchMembersCreated,
            nextCsvRowIndex: this.calculateNextCsvRowIndex(csvData, allRowGroups, actualChunkSize),
            chunkSize: CHUNK_SIZE,
            isComplete: actualBatchMembersCreated >= totalTransactions
        };

        // GitHub Issue #147: Add group tracking for nested arrays (used by prepareNextChunk)
        if (groupTrackingState) {
            preparationStateUpdate.groupingColumn = groupTrackingState.groupingColumn;
            preparationStateUpdate.groupingColumns = groupTrackingState.groupingColumns;
            preparationStateUpdate.totalGroups = groupTrackingState.totalGroups;
            preparationStateUpdate.preparedGroups = actualChunkSize; // Groups processed in first chunk
            preparationStateUpdate.groupsPerFile = groupTrackingState.groupsPerFile;
        }

        await this.dependencies.executionMetadataService.updateExecution(batchId, {
            preparationState: preparationStateUpdate,
            rows: `${totalTransactions}(${csvData.length})` // Update rows display: "transactions(csvRows)"
        });

        // Update batch status to PENDING (ready for execution)
        await this.dependencies.executionMetadataService.updateExecution(batchId, {
            status: 'pending'
        });

        this.logger.info(`[JIT] Batch ${batchId} transitioned to PENDING. First chunk ready: ${actualBatchMembersCreated}/${totalTransactions} batch members`);

        return actualBatchMembersCreated;
    }

    /**
     * Prepare next chunk in background (called during execution)
     * Triggered by execution engine when pending member count drops below threshold
     * Regenerates rowGroups from cursor position and creates next CHUNK_SIZE members
     *
     * @param batchId - Batch execution ID
     * @returns Number of transactions created in this chunk (0 if complete or cancelled)
     */
    public async prepareNextChunk(batchId: string): Promise<number> {
        // Check cancellation signal
        if (this.preparationCancelled.get(batchId)) {
            this.logger.debug(`[JIT] Preparation cancelled for batch ${batchId}`);
            this.preparationCancelled.delete(batchId); // Cleanup
            return 0;
        }

        // Load batch metadata to get cursor and config
        const batchMetadata = await this.dependencies.executionMetadataService.getExecution(batchId);

        if (!batchMetadata) {
            this.logger.error(`[JIT] Batch ${batchId} not found`);
            return 0;
        }

        const preparationState = batchMetadata.preparationState;

        if (!preparationState) {
            this.logger.error(`[JIT] No preparation state for batch ${batchId}`);
            return 0;
        }

        if (preparationState.isComplete) {
            return 0;
        }

        const startIndex = preparationState.preparedTransactions;
        // Issue #312: the chunk follows the batch's CURRENT thread count, not the one it
        // was created with. `preparationState.chunkSize` is fixed at creation (2 × the
        // concurrency then), so a batch started sequential prepared two transactions at a
        // time for ever — and however many threads Settings asked for, only two could be
        // running, because the producer never had more ready. Each chunk also re-reads
        // the whole input file, so small chunks were slow as well as narrow.
        const currentConcurrency = batchMetadata.batchConfiguration?.parallelProcessing?.maxConcurrency || 1;
        const CHUNK_SIZE = Math.max(preparationState.chunkSize, currentConcurrency * 2);
        if (CHUNK_SIZE !== preparationState.chunkSize) {
            this.logger.info(`[JIT] issue#312 chunk size ${preparationState.chunkSize} → ${CHUNK_SIZE} for batch ${batchId} (threads now ${currentConcurrency})`);
        }

        // Re-read CSV from file
        const csvFilePath = batchMetadata.requestFile;
        if (!csvFilePath) {
            this.logger.error(`[JIT] No CSV file path for batch ${batchId}`);
            return 0;
        }

        const csvData = await this.readCsvFromFile(csvFilePath);

        // Re-analyze arrays and generate rowGroups
        // Note: We could optimize this by storing rowGroups, but regenerating is safer for resume after restart
        if (!batchMetadata.endpointConfig) {
            this.logger.error(`[JIT] No endpoint config for batch ${batchId}`);
            return 0;
        }
        // GitHub Issue #354: a batch stored before the fix still sends what Step 4 showed
        const endpoint = this.withPlannedArrays(batchMetadata.endpointConfig);

        const endpointArrays = endpoint.dataLoadingConfig?.repeatableArrays;
        const batchConfig = batchMetadata.batchConfiguration;

        // GitHub Issue #147: Use jsonGenerator.analyzeNestedArrays for CONSISTENT nesting detection
        const nestingAnalysis = this.dependencies.jsonGenerator.analyzeNestedArrays(endpoint.body || '{}');
        const hasNestedArrays = nestingAnalysis.hasNestedArrays;

        // GitHub Issue #108: Check if query param repetition is enabled
        const repeatableQueryParam = batchConfig?.repeatableQueryParam;
        let queryParamAnalysis: any = null;
        let allRowGroups: string[][][];
        let queryStrings: string[] = [];

        if (hasNestedArrays) {
            // NESTED ARRAYS: GitHub Issue #147 - JIT chunking by root elements
            const groupingColumn = (preparationState as any).groupingColumn;
            const preparedGroups = (preparationState as any).preparedGroups || 0;
            const groupsPerFile = (preparationState as any).groupsPerFile || 8;
            const totalGroups = (preparationState as any).totalGroups || 0;

            if (groupingColumn && preparedGroups < totalGroups) {
                this.logger.debug(`[JIT] Nested arrays next chunk, groupingColumn: ${groupingColumn}, preparedGroups: ${preparedGroups}/${totalGroups}`);

                // GitHub Issue #148: Backend auto-sort removed - CSV arrives pre-sorted from frontend
                const header = csvData[0];
                const dataRows = csvData.slice(1);
                // Batches prepared before groupingColumns existed carry only groupingColumn.
                const rootKey = this.rootKeyFor(header, (preparationState as any).groupingColumns ?? [groupingColumn]);

                // Skip to where we left off (preparedGroups root elements)
                const rootElementsForThisChunk = CHUNK_SIZE * groupsPerFile;
                const rowsForChunk: string[][] = [];
                let rootElementCount = 0;
                let lastRootValue = '';
                let collecting = false;

                for (const row of dataRows) {
                    const rootValue = rootKey(row);
                    if (rootValue !== lastRootValue) {
                        rootElementCount++;
                        lastRootValue = rootValue;

                        // Start collecting after we pass preparedGroups
                        if (rootElementCount > preparedGroups && !collecting) {
                            collecting = true;
                        }

                        // Stop after we have enough for this chunk
                        if (collecting && rootElementCount > preparedGroups + rootElementsForThisChunk) {
                            break;
                        }
                    }
                    if (collecting) {
                        rowsForChunk.push(row);
                    }
                }

                if (rowsForChunk.length === 0) {
                    this.logger.debug(`[JIT] No more rows for nested arrays, marking complete`);
                    await this.dependencies.executionMetadataService.updateExecution(batchId, {
                        preparationState: { ...preparationState, isComplete: true }
                    });
                    return 0;
                }

                const newPreparedGroups = Math.min(rootElementCount, preparedGroups + rootElementsForThisChunk);
                this.logger.info(`[JIT] Next chunk: ${rowsForChunk.length} rows, root elements ${preparedGroups + 1} to ${newPreparedGroups}`);

                // Pass to generateBatchJsonFiles
                const csvString = [header.join(','), ...rowsForChunk.map(r => r.join(','))].join('\n');
                const mappings = batchMetadata.columnMappingUsed
                    ? batchMetadata.columnMappingUsed.map((m: any) => ({
                        variable: m.templateVariable,
                        column: m.csvColumn,
                        dataType: 'string'
                    }))
                    : header.map(columnName => ({
                        variable: columnName,
                        column: columnName,
                        dataType: 'string'
                    }));

                const jsonGeneratorOptions = {
                    template: endpoint.body || '{}',
                    repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
                    mappings,
                    headers: header,
                    endpointId: endpoint.id,
                    sequenceStartValue: 1001,
                    environmentVariables: batchMetadata.environmentVariables // GitHub Issue #165: ENV variable substitution
                };

                const filesResult = await this.dependencies.jsonGenerator.generateBatchJsonFiles(csvString, jsonGeneratorOptions);

                if (!filesResult.success) {
                    throw new Error(`Failed to generate JSON: ${filesResult.error}`);
                }

                this.logger.info(`[JIT] generateBatchJsonFiles returned ${filesResult.files.length} files for next chunk`);

                // Create batch_members
                const baseIndex = preparationState.preparedTransactions;
                // issue#231: derive workspaceRoot once + log it for diagnostic correlation
                const jitWorkspaceRoot = csvFilePath.substring(0, csvFilePath.lastIndexOf('/'));
                this.logger.info(`[JIT] issue#231 nested-arrays JIT chunk: batchId=${batchId}, csvFilePath=${csvFilePath}, derivedWorkspaceRoot="${jitWorkspaceRoot}", endsWithBatchId=${jitWorkspaceRoot.endsWith(batchId)}, baseIndex=${baseIndex}, files=${filesResult.files.length}`);
                for (let fileIndex = 0; fileIndex < filesResult.files.length; fileIndex++) {
                    const file = filesResult.files[fileIndex];
                    const transactionIndex = baseIndex + fileIndex;
                    try {
                        const result = await this.dependencies.batchMemberHandler.createTransaction({
                            endpoint: batchMetadata.endpointConfig!,
                            environment: batchMetadata.environment,
                            environmentId: batchMetadata.environmentId,
                            environmentFolder: undefined,
                            organization: batchMetadata.organization || '',
                            workspaceRoot: jitWorkspaceRoot,
                            batchId,
                            csvRowData: [header],
                            preGeneratedJson: file.content,
                            transactionIndex,
                            rowStart: file.rowRange?.start || baseIndex + fileIndex + 1,
                            // GitHub Issue #181: Pass actual row count from rowRange for nested arrays
                            rows: file.rowRange ? String(file.rowRange.end - file.rowRange.start + 1) : undefined,
                            columnMappings: batchMetadata.columnMappingUsed ? this.convertColumnMappingToRecord(batchMetadata.columnMappingUsed) : undefined
                        });
                        // issue#231: confirm the file landed where we expect
                        this.logger.info(`[JIT] issue#231 created batch_member ${result.executionId}: transactionIndex=${transactionIndex}, requestFilePath=${result.requestFilePath}, directoryPath=${result.directoryPath}`);
                    } catch (createError) {
                        const err = createError instanceof Error ? createError : new Error(String(createError));
                        this.logger.error(
                            `[JIT] issue#231 batchMemberHandler.createTransaction FAILED for batch ${batchId}, transactionIndex=${transactionIndex}: ${err.message} | stack=${err.stack ?? '(no stack)'}`,
                            err,
                            { batchId, transactionIndex, jitWorkspaceRoot, csvFilePath }
                        );
                        throw err;
                    }
                }

                // Update cursor
                const newPreparedTransactions = preparationState.preparedTransactions + filesResult.files.length;
                const isComplete = newPreparedGroups >= totalGroups;

                await this.dependencies.executionMetadataService.updateExecution(batchId, {
                    preparationState: {
                        ...preparationState,
                        preparedTransactions: newPreparedTransactions,
                        preparedGroups: newPreparedGroups,
                        isComplete: isComplete
                    }
                });

                if (isComplete) {
                    this.logger.info(`[JIT] Batch ${batchId} preparation complete: ${newPreparedTransactions} transactions`);
                }

                return filesResult.files.length;
            } else {
                // No more work or no grouping column
                this.logger.debug(`[JIT] Nested arrays complete or no groupingColumn`);
                return 0;
            }
        } else if (repeatableQueryParam?.enabled) {
            // Use query param repetition
            queryParamAnalysis = await this.queryParamHelper.analyzeQueryParamRepetition(
                csvData,
                repeatableQueryParam as any,
                batchMetadata.columnMappingUsed ? this.convertColumnMappingToRecord(batchMetadata.columnMappingUsed) : undefined
            );

            allRowGroups = queryParamAnalysis.rowGroups.map((g: any) => g.rows);
            queryStrings = queryParamAnalysis.rowGroups.map((g: any) => g.queryString);

            this.logger.debug(`[JIT] Using query param repetition for next chunk: ${allRowGroups.length} transactions`);
        } else {
            // Use array repetition (existing logic)
            const arrayConfig = {
                detectArrays: true,
                repeatableArrays: endpointArrays ? endpointArrays.map((arr: any) => ({
                    enabled: arr.enabled,
                    maxRepetitions: arr.maxRepetitions,
                    fieldName: arr.arrayPath || 'unknown'
                })) : undefined,
                rowsPerTransaction: undefined // Not stored in BatchConfiguration
            };

            const arrayAnalysis = await this.dependencies.arrayRepetitionHelper.analyzeArrayRepetition(
                csvData,
                arrayConfig
            );

            allRowGroups = this.dependencies.arrayRepetitionHelper.groupRowsForTransactions(
                csvData,
                arrayAnalysis
            );
        }

        // Calculate chunk slice
        const endIndex = Math.min(startIndex + CHUNK_SIZE, allRowGroups.length);
        const chunk = allRowGroups.slice(startIndex, endIndex);
        const chunkQueryStrings = queryStrings.slice(startIndex, endIndex);

        if (chunk.length === 0) {
            this.logger.debug(`[JIT] Preparation complete for batch ${batchId}`);
            // Mark as complete
            await this.dependencies.executionMetadataService.updateExecution(batchId, {
                preparationState: {
                    ...preparationState,
                    isComplete: true
                }
            });
            return 0;
        }

        this.logger.debug(`[JIT] Creating chunk for batch ${batchId}: ${chunk.length} row groups (${startIndex}-${endIndex}/${allRowGroups.length})`);

        // GitHub Issue #119: Use unified JSON generation for all scenarios
        // Call generateBatchJsonFiles() for each row group to handle nested arrays correctly
        let globalTransactionIndex = startIndex;

        // GitHub Issue #171: Check if this is query param repetition WITHOUT body generation
        const isQueryParamOnlyMode = queryParamAnalysis?.enabled &&
            endpoint.method === 'GET' &&
            (!endpoint.body || endpoint.body.trim() === '' || endpoint.body.trim() === '{}');

        // Create batch members for this chunk
        for (let i = 0; i < chunk.length; i++) {
            // Check cancellation in loop
            if (this.preparationCancelled.get(batchId)) {
                this.logger.debug(`[JIT] Cancelled during chunk creation for batch ${batchId}`);
                this.preparationCancelled.delete(batchId); // Cleanup
                break;
            }

            const rowGroup = chunk[i];

            // Calculate rowStart: which CSV row (1-based) this row group starts at
            // Sum up all data rows consumed by previous row groups
            let rowStart = 1; // Start after header row
            for (let j = 0; j < (startIndex + i) && j < allRowGroups.length; j++) {
                // Each rowGroup has [header, ...dataRows]
                // Count data rows only (exclude header at index 0)
                rowStart += (allRowGroups[j].length - 1);
            }

            // Extract batch directory from CSV file path
            const batchDirectory = batchMetadata.requestFile ? path.dirname(batchMetadata.requestFile) : '';

            // GitHub Issue #171: For query param repetition without body, create ONE transaction per rowGroup
            if (isQueryParamOnlyMode) {
                const paramKey = queryParamAnalysis!.queryParamKey;
                const queryStringValue = chunkQueryStrings[i];
                // GitHub Issue #224: merge other enabled query params (e.g. size=90)
                const queryParams = this.buildRepetitionQueryParams(batchMetadata.endpointConfig!, paramKey, queryStringValue);

                await this.dependencies.batchMemberHandler.createTransaction({
                    endpoint: batchMetadata.endpointConfig!,
                    environment: batchMetadata.environment,
                    environmentId: batchMetadata.environmentId,
                    environmentFolder: undefined,
                    organization: batchMetadata.organization || '',
                    workspaceRoot: batchDirectory,
                    batchId,
                    csvRowData: rowGroup,
                    preGeneratedJson: {},
                    transactionIndex: globalTransactionIndex++,
                    rowStart,
                    columnMappings: batchMetadata.columnMappingUsed ? this.convertColumnMappingToRecord(batchMetadata.columnMappingUsed) : undefined,
                    queryParams
                });
                continue;
            }

            // GitHub Issue #119: Call generateBatchJsonFiles() to get files for this row group
            // This handles all scenarios: no nesting, 2-level, 3-level nesting
            const csvString = this.convertRowGroupToCsvString(rowGroup);

            // GitHub Issue #119: Convert columnMappings to array format for JsonGenerator
            // batchMetadata.columnMappingUsed has structure: { templateVariable, csvColumn, mappingType, dataType }[]
            let mappings: Array<{ variable: string; column: string; dataType: string }>;
            if (Array.isArray(batchMetadata.columnMappingUsed)) {
                // Convert from batch metadata format to JsonGenerator format
                mappings = batchMetadata.columnMappingUsed.map((m: any) => ({
                    variable: m.templateVariable,
                    column: m.csvColumn,
                    dataType: m.dataType || 'string'
                }));
            } else if (batchMetadata.columnMappingUsed && typeof batchMetadata.columnMappingUsed === 'object') {
                // Convert Record to array (for backward compatibility)
                mappings = Object.entries(batchMetadata.columnMappingUsed).map(([templateVariable, csvColumn]) => ({
                    variable: templateVariable,
                    column: csvColumn as string,
                    dataType: 'string'
                }));
            } else {
                // Fallback: map column names to themselves
                mappings = rowGroup[0].map(columnName => ({
                    variable: columnName,
                    column: columnName,
                    dataType: 'string'
                }));
            }

            const jsonGeneratorOptions = {
                template: endpoint.body || '{}',
                repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
                mappings, // Now guaranteed to be an array
                headers: rowGroup[0], // First row is header
                endpointId: batchMetadata.endpointId,
                sequenceStartValue: 1001,
                environmentVariables: batchMetadata.environmentVariables // GitHub Issue #165: ENV variable substitution
            };

            const filesResult = await this.dependencies.jsonGenerator.generateBatchJsonFiles(
                csvString,
                jsonGeneratorOptions
            );

            if (!filesResult.success) {
                this.logger.error(`[JIT] Failed to generate JSON for row group ${i}: ${filesResult.error}`);
                throw new Error(`Failed to generate JSON: ${filesResult.error}`);
            }

            this.logger.debug(`[JIT] Row group ${i} generated ${filesResult.files.length} transaction files`);

            // Create one batch_member per file returned
            for (let fileIndex = 0; fileIndex < filesResult.files.length; fileIndex++) {
                const file = filesResult.files[fileIndex];

                // GitHub Issue #108: Build query params object using paramKey from analysis
                let queryParams: Record<string, string> | undefined;
                if (queryParamAnalysis?.enabled && chunkQueryStrings[i]) {
                    const paramKey = queryParamAnalysis.queryParamKey;
                    const queryStringValue = chunkQueryStrings[i];
                    // GitHub Issue #224: merge other enabled query params (e.g. size=90)
                    queryParams = this.buildRepetitionQueryParams(batchMetadata.endpointConfig!, paramKey, queryStringValue);
                }

                await this.dependencies.batchMemberHandler.createTransaction({
                    endpoint: batchMetadata.endpointConfig!,
                    environment: batchMetadata.environment,
                    environmentId: batchMetadata.environmentId,
                    environmentFolder: undefined, // Not stored in metadata
                    organization: batchMetadata.organization || '',
                    workspaceRoot: batchDirectory, // Pass batch directory directly to handler
                    batchId,
                    csvRowData: rowGroup, // Still pass row group for backward compatibility
                    preGeneratedJson: file.content, // GitHub Issue #119: Pass pre-generated JSON
                    transactionIndex: globalTransactionIndex++,
                    rowStart, // Starting CSV row index for this row group (1-based)
                    columnMappings: batchMetadata.columnMappingUsed ? this.convertColumnMappingToRecord(batchMetadata.columnMappingUsed) : undefined,
                    queryParams // GitHub Issue #108: Pass computed query params for query param repetition
                });
            }
        }

        const actualChunkSize = chunk.length;

        // Update preparation cursor
        const newPreparedTransactions = startIndex + actualChunkSize;
        const isComplete = newPreparedTransactions >= allRowGroups.length;

        // GitHub Issue #147: Build preparation state update, including group tracking if present
        const prepStateUpdate: any = {
            ...preparationState,
            preparedTransactions: newPreparedTransactions,
            nextCsvRowIndex: this.calculateNextCsvRowIndex(csvData, allRowGroups, newPreparedTransactions),
            isComplete: isComplete
        };

        // Update preparedGroups for nested array group tracking
        if ((preparationState as any).groupingColumn) {
            prepStateUpdate.preparedGroups = newPreparedTransactions; // Groups and transactions aligned
        }

        await this.dependencies.executionMetadataService.updateExecution(batchId, {
            preparationState: prepStateUpdate
        });

        if (isComplete) {
            this.logger.info(`[JIT] Batch ${batchId} preparation complete: ${newPreparedTransactions} transactions prepared`);
        }

        return actualChunkSize;
    }

    /**
     * Read CSV from file and parse into array
     */
    private async readCsvFromFile(csvFilePath: string): Promise<string[][]> {
        const csvContent = fs.readFileSync(csvFilePath, 'utf-8');

        // Simple CSV parsing (split by newline and comma)
        // TODO: Use proper CSV parser for production (handles quotes, escapes, etc.)
        const lines = csvContent.split('\n').filter((line: string) => line.trim() !== '');
        const rows = lines.map((line: string) => line.split(',').map((cell: string) => cell.trim()));

        return rows;
    }

    /**
     * Convert row group (array of arrays) to CSV string format for generateBatchJsonFiles()
     * GitHub Issue #119: Helper for unified JSON generation
     */
    private convertRowGroupToCsvString(rowGroup: string[][]): string {
        return rowGroup.map(row => row.join(',')).join('\n');
    }

    /**
     * GitHub Issue #119: Detect if template has nested array structure
     * Returns true if template contains nested arrays (e.g., orders[].items[])
     *
     * CRITICAL: When nested arrays are detected, we must group by outer object count (maxRepetitions),
     * NOT by CSV row count (rowsPerTransaction). Otherwise the same outer object (e.g., PO)
     * gets split across multiple files.
     */
    private hasNestedArrays(template: string | undefined): boolean {
        if (!template) {
            return false;
        }

        try {
            const parsed = JSON.parse(template);
            const analysis = this.analyzeNestedArrayStructure(parsed);
            return analysis.hasNestedArrays;
        } catch (error) {
            return false;
        }
    }

    /**
     * Analyze template for nested array structure
     *
     * GitHub Issue #140: Distinguishes between:
     * 1. ROOT-GROUPED NESTING: { "toLoc": "{{toLoc}}", "items": [...] }
     *    - Has root-level variables OUTSIDE the array that drive grouping
     *    - Should use nested array path (one file per unique root variable value)
     *
     * 2. FLAT ARRAY REPETITION: { "data": [{ "id": "{{id}}" }] } or [{ "id": "{{id}}" }]
     *    - No root-level grouping variables
     *    - Should use flat array repetition path (N rows per file based on maxRepetitions)
     */
    private analyzeNestedArrayStructure(obj: any): { hasNestedArrays: boolean; nestingLevel: number; hasRootGroupingVariables: boolean } {
        const findArrays = (obj: any, depth: number = 0): number => {
            if (Array.isArray(obj)) {
                if (obj.length > 0 && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
                    // Found an array of objects - check if any properties contain arrays
                    const itemObj = obj[0];
                    for (const value of Object.values(itemObj)) {
                        if (Array.isArray(value)) {
                            // Found nested array
                            const nestedDepth = findArrays(value, depth + 1);
                            return Math.max(depth + 1, nestedDepth);
                        }
                    }
                }
                return depth;
            } else if (obj && typeof obj === 'object') {
                let maxDepth = depth;
                for (const value of Object.values(obj)) {
                    if (Array.isArray(value)) {
                        const arrayDepth = findArrays(value, depth + 1);
                        maxDepth = Math.max(maxDepth, arrayDepth);
                    }
                }
                return maxDepth;
            }
            return depth;
        };

        // Check for root-level variables (outside any array) that drive grouping
        const hasRootGroupingVariables = this.hasRootLevelVariables(obj);

        const nestingLevel = findArrays(obj);
        return {
            // Only treat as "nested arrays" if:
            // 1. Has 2+ levels of nesting (orders[].items[]), OR
            // 2. Has 1 level BUT with root-level grouping variables (toLoc outside array)
            //
            // Flat array repetition (no root variables) should NOT use nested path
            hasNestedArrays: nestingLevel >= 2 || (nestingLevel === 1 && hasRootGroupingVariables),
            nestingLevel,
            hasRootGroupingVariables
        };
    }

    /**
     * Check if template has root-level variables outside any array
     * These variables drive grouping (e.g., toLoc in { "toLoc": "{{toLoc}}", "items": [...] })
     */
    private hasRootLevelVariables(obj: any): boolean {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return false;
        }

        // Check each root-level property
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string') {
                // Check if this string contains a template variable {{...}}
                if (/\{\{[^}]+\}\}/.test(value)) {
                    return true;
                }
            }
            // Don't recurse into arrays - we only want ROOT level variables
        }

        return false;
    }

    /**
     * Convert column mapping array to record (for backwards compatibility)
     */
    private convertColumnMappingToRecord(columnMappingArray: any[]): Record<string, string> {
        const record: Record<string, string> = {};
        for (const mapping of columnMappingArray) {
            if (mapping.templateVariable && mapping.csvColumn) {
                record[mapping.templateVariable] = mapping.csvColumn;
            }
        }
        return record;
    }

    // ========================================================================
    // GitHub Issue #147 - Auto-Sort Helper Methods for Nested Arrays
    // ========================================================================

    /**
     * Map template variable to CSV column name
     * GitHub Issue #147: Used to find grouping column for nested arrays
     *
     * @param templateVariable - Template variable name (e.g., "ItemId")
     * @param columnMappings - Record of templateVar -> csvColumn mappings
     * @returns CSV column name
     */
    private mapVariableToColumn(
        templateVariable: string | undefined,
        columnMappings?: Record<string, string>
    ): string {
        if (!templateVariable) {
            return '';
        }

        if (columnMappings) {
            // columnMappings is { templateVariable: csvColumn }
            // We need to find which csvColumn maps to our templateVariable
            const csvColumn = columnMappings[templateVariable];
            if (csvColumn) {
                return csvColumn;
            }
        }

        // Fallback: assume template variable name matches CSV column name
        return templateVariable;
    }

    /**
     * A row's root-element key: its values in every grouping column, trimmed like
     * ArrayRepetitionHelper.groupRowsByFieldValues. Columns missing from the header are ignored.
     */
    private rootKeyFor(header: string[], columns: string[]): (row: string[]) => string {
        const indices = columns.map(c => header.indexOf(c)).filter(i => i !== -1);
        return (row: string[]) => indices.map(i => (row[i] ?? '').trim()).join('\u0001');
    }

    // GitHub Issue #148: sortCsvByColumn() removed - frontend handles sorting

    /**
     * Get maxRepetitions from repeatable arrays config
     * GitHub Issue #147: Used to batch groups into files
     *
     * @param repeatableArrays - Repeatable arrays config from endpoint
     * @returns maxRepetitions value (defaults to 8)
     */
    /**
     * GitHub Issue #354: the endpoint with the array setting Run Batch Step 4 plans with
     * (effectiveRepeatableArrays). A saved array the plan does not use — a stale one, or one
     * Review never offered — is never applied behind Review's back.
     */
    private withPlannedArrays<T extends { body?: string; dataLoadingConfig?: { repeatableArrays?: Array<{ arrayPath: string; enabled: boolean; maxRepetitions: number }> } }>(endpoint: T): T {
        const saved = endpoint?.dataLoadingConfig?.repeatableArrays;
        if (!endpoint || !endpoint.dataLoadingConfig || !saved) { return endpoint; }
        const planned = effectiveRepeatableArrays(endpoint.body, saved);
        if (JSON.stringify(planned) === JSON.stringify(saved)) { return endpoint; }
        this.logger.info(`[#354] Array setting ${JSON.stringify(saved)} sent as ${JSON.stringify(planned)}, as Run Batch Review plans it`);
        return { ...endpoint, dataLoadingConfig: { ...endpoint.dataLoadingConfig, repeatableArrays: planned } };
    }

    private getMaxRepetitions(repeatableArrays?: Array<{ enabled: boolean; maxRepetitions: number; arrayPath?: string }>): number {
        if (!repeatableArrays || repeatableArrays.length === 0) {
            return 8; // Default
        }

        const enabled = repeatableArrays.find(arr => arr.enabled);
        return enabled?.maxRepetitions || 8;
    }

    /**
     * Combine multiple row groups into single CSV string
     * GitHub Issue #147: Used to batch groups for generateBatchJsonFiles
     *
     * @param groups - Array of row groups (each group is string[][])
     * @returns CSV string with header and all data rows
     */
    private combineGroupsToCsv(groups: string[][][]): string {
        if (groups.length === 0) {
            return '';
        }

        const header = groups[0][0];
        const allDataRows = groups.flatMap(g => g.slice(1)); // Skip header from each group
        return [header.join(','), ...allDataRows.map(r => r.join(','))].join('\n');
    }

    /**
     * Calculate next CSV row index for cursor tracking
     * Needed to resume preparation from correct CSV row
     */
    private calculateNextCsvRowIndex(csvData: string[][], allRowGroups: string[][][], preparedTransactionCount: number): number {
        // Calculate how many CSV rows were consumed by prepared transactions
        let rowsConsumed = 0;
        for (let i = 0; i < preparedTransactionCount && i < allRowGroups.length; i++) {
            // Each rowGroup contains the CSV rows used for that transaction
            // rowGroup[0] is the header, subsequent rows are data
            rowsConsumed += allRowGroups[i].length - 1; // Subtract header row
        }

        return rowsConsumed;
    }

    /**
     * Validate input for batch transactions
     */
    private validateBatchInput(input: TransactionPreparationInput): void {
        this.validateIndividualInput(input); // Base validation

        if (!input.csvData || input.csvData.length === 0) {
            throw new Error('CSV data is required for batch transactions');
        }

        if (input.csvData.length < 2) {
            throw new Error('CSV data must contain at least header and one data row');
        }

        // Validate consistent row lengths
        const headerLength = input.csvData[0].length;
        const inconsistentRows = input.csvData.slice(1).some(row => row.length !== headerLength);
        if (inconsistentRows) {
            throw new Error('CSV rows have inconsistent column counts');
        }
    }

    /**
     * Prepare paginated batch (GitHub Issue #94)
     * Creates batch parent with pagination metadata and one batch_member for first page
     * Much simpler than prepareBatchTransactions - no CSV, just one member for first page
     */
    async preparePaginatedBatch(
        input: TransactionPreparationInput,
        options?: TransactionPreparationOptions
    ): Promise<TransactionPreparationResult> {
        const { endpoint, environment, environmentId, environmentFolder, organization, paginationConfig } = input;

        // Validate input
        this.validateIndividualInput(input);

        if (!paginationConfig || !paginationConfig.enabled) {
            throw new Error('Pagination configuration is required for paginated batches');
        }

        try {
            this.logger.info('[TransactionPreparation] Creating paginated batch', {
                endpointId: endpoint.id,
                endpointName: endpoint.name,
                environment,
                organization,
                paginationConfig
            });

            // GitHub Issue #94: Add "continue processing" error handling for paginated batches
            // This ensures pagination continues fetching pages even if some pages fail
            const endpointWithErrorHandling: any = {
                ...endpoint,
                dataLoadingConfig: {
                    ...(endpoint.dataLoadingConfig || {}),
                    errorHandling: {
                        mode: 'continue',
                        enableErrorTolerance: true,
                        toleranceMode: 'absolute',
                        absoluteErrorLimit: 999999 // High limit = continue processing all pages
                    }
                }
            };

            // Create batch parent with pagination metadata (status = 'preparing')
            // Use empty CSV data array to satisfy the batch handler interface
            const batchResult = await this.dependencies.batchHandler.createTransaction({
                endpoint: endpointWithErrorHandling as typeof endpoint, // Use endpoint with error tolerance
                environment,
                environmentId,
                environmentFolder,
                organization: organization || '',
                workspaceRoot: input.workspaceRoot,
                csvRowData: [['placeholder']], // Dummy CSV data for batch creation
                batchName: `${endpoint.name}_paginated`
            });

            const batchId = batchResult.executionId;

            this.logger.info('[TransactionPreparation] Batch parent created for pagination', {
                batchId,
                requestFilePath: batchResult.requestFilePath,
                directoryPath: batchResult.directoryPath
            });

            // GitHub Issue #94: Set rows for execution (pagination detected on-the-fly from endpointConfig)
            // #298: with a total to measure by, the batch is incomplete until every page is in
            const created = paginationConfig.totalCountPath
                ? await this.dependencies.executionMetadataService.getExecution(batchId)
                : null;
            await this.dependencies.executionMetadataService.updateExecution(batchId, {
                rows: '1', // Start with 1 batch_member (execution engine counts actual members)
                // #424/#160: every page goes to the base URL as it was when the run started
                ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
                ...(created ? { batchConfiguration: { stopOnFirstError: false, ...created.batchConfiguration, pagesComplete: false } } : {})
            });

            this.logger.info('[TransactionPreparation] Paginated batch created with 1 initial member', {
                batchId,
                pageNumber: paginationConfig.startValue
            });

            // GitHub Issue #94: Replace pagination template with first page number for batch_member
            const paginationDetectorService = new PaginationDetectorService();

            // GitHub Issue #245: the first page, in the body and the query params alike: wherever
            // the endpoint asks for it (an endpoint may ask in both)
            const endpointWithFirstPage = paginationDetectorService.endpointForPage(endpoint, paginationConfig.startValue);

            // Create first batch_member with startValue page (status = 'pending')
            // Use minimal CSV data for the member
            const firstPageCsvData = [['page'], [String(paginationConfig.startValue)]];

            const memberResult = await this.dependencies.batchMemberHandler.createTransaction({
                endpoint: endpointWithFirstPage, // Use endpoint with replaced template for batch_member
                environment,
                environmentId,
                environmentFolder,
                organization: organization || '',
                workspaceRoot: input.workspaceRoot,
                batchId,
                csvRowData: firstPageCsvData,
                transactionIndex: 0,
                rowStart: 1
            });

            this.logger.info('[TransactionPreparation] First page batch_member created', {
                batchId,
                memberId: memberResult.executionId,
                pageNumber: paginationConfig.startValue
            });

            // Update batch status to 'pending' (ready for execution)
            await this.dependencies.executionMetadataService.updateExecution(batchId, {
                status: 'pending'
            });

            this.logger.info('[TransactionPreparation] Paginated batch ready for execution', { batchId });

            // Auto-open report for paginated batch
            try {
                await this.progressSink.openConsole(batchId, { isBatch: true });
            } catch (error) {
                this.logger.warn(`[TransactionPreparation] Failed to auto-open report for paginated batch ${batchId}`, error instanceof Error ? error : undefined);
            }

            // Show success notification
            this.dependencies.notificationService?.showSuccess(
                `Paginated batch prepared: ${endpoint.name || 'API'} (page ${paginationConfig.startValue})`
            );

            return {
                batchId,
                transactionIds: [memberResult.executionId],
                filePaths: {
                    request: batchResult.requestFilePath,
                    batchDirectory: batchResult.directoryPath
                },
                transactionCount: 1,
                status: 'pending'
            };

        } catch (error) {
            this.dependencies.notificationService?.showError(
                `Failed to prepare paginated batch: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            throw error;
        }
    }
}