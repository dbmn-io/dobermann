// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's host logic (console/console.js and its modules), shared by VS Code and the
 * web app. Moved from ConsoleController (#343): the same handlers, talking to the screen
 * through a ScreenSession and to the host through ConsolePorts.
 */

import { ConsoleStatusUpdate } from '../../platform/interfaces/execution-progress-sink.interface';
import { MissedStatusBuffer } from '../../webviews/console/missed-status-buffer';
import * as fs from 'fs';
import * as path from 'path';
import { readRunFile, readRunFileIfExists, removeRunFile, runFileExists, writeRunFile } from '../../services/run-content/run-content-store';
import type { ScreenSession } from '../screen-session';
import type { ConsolePorts, DeleteConfirmation } from './console.ports';
import type { DbmnModalSpec } from '../modal.types';
import { askBeforeCancellingBatch } from './batch-cancel';
import { applyResumeChoice, askHowToResume } from './batch-resume';
import {
    BaseMessage,
    ResponseMessage,
    createResponseMessage,
    createErrorResponseMessage,
    createEventMessage
} from '../../types/base-message';
import {
    ConsoleMessageTypes,
    StreamingProgress,
    TableRow,
    GetTableDataRequest,
    ExportDataRequest,
    ExportToClipboardRequest,
    UpdateViewStateRequest,
    ChangeTabRequest,
    ChangeRootPathRequest,
    RefreshConsoleRequest,
    StartLogStreamRequest,
    StopLogStreamRequest,
    LoadLogsRequest,
    DatabaseCountRequest,
    GetRawInputFileRequest,
    GetTransactionRawFilesRequest,
    GetRawTabDataRequest,
    GetRawTransactionContentRequest,
    TableDataResponse,
    ExportStartedEvent,
    ExportCompleteResponse,
    ClipboardReadyResponse,
    ConsoleRefreshedResponse,
    LogStreamUpdateEvent,
    LogsChunkLoadedEvent,
    DataLoadingStartedEvent,
    DataLoadingCompletedEvent,
    ExportProgressEvent,
    RawInputFileResponse,
    TransactionRawFilesResponse,
    TransactionRawFile,
    RawTabDataResponse,
    RawTransactionContentResponse,
    RawTransactionSummary,
    RawTransactionContent,
    isGetTableDataRequest,
    isExportDataRequest,
    isExportToClipboardRequest,
    isUpdateViewStateRequest,
    isChangeTabRequest,
    isChangeRootPathRequest,
    isRefreshConsoleRequest,
    isStartLogStreamRequest,
    isStopLogStreamRequest,
    isLoadLogsRequest,
    isDatabaseCountRequest,
    isGetRawInputFileRequest,
    isGetTransactionRawFilesRequest,
    isGetRawTabDataRequest,
    isGetRawTransactionContentRequest,
    isGetTransactionLogRequest,
    GetTransactionLogRequest,
    TransactionLogResponse,
    SaveConsoleSettingsRequest,
    isSaveConsoleSettingsRequest,
    ConsoleConfig,
    ExtractedTableData,
    TabbedConsoleData,
    RawConsoleData,
    ExportFormat,
    ExportOptions,
    ColumnDefinition
} from '../../types/console-messages';
import {
    ResponseDataExtractor,
    IResponseDataExtractor,
    ResponseFileDetail
} from '../../services/console/response-data-extractor';
import {
    ConsoleExportService,
    IConsoleExportService
} from '../../services/console/export.service';
import { IExecutionLoggingService } from '../../services/logging/execution-logging.interface';
import { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { IBatchExecutionEngine } from '../../services/execution/batch-execution-engine.interface';
import { IIndividualExecutionEngine } from '../../services/execution/individual-execution-engine.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { APIEndpointManager } from '../../apiEndpointManager';
import { APIEndpointConfig } from '../../apiConfigManager';
import { ConsoleViewsStore } from '../../services/console/console-views-store';
import { excelSheetExtractions, ExportRequestPayload } from '../../services/console/excel-export-sheets';
import { endpointInputVariableNames } from '../../services/chain/endpoint-input-variables';
import { ConsoleCompareHandler } from './console-compare-handler';
import { keepLockedViews, viewsInQueries } from '../../services/query/query-view-lock';
import { viewsInCompares } from '../../services/compare/compare-store';
import { ConsoleChainHandler } from './console-chain-handler';
import { isEmptyRequestBody } from '../../services/console/request-body';
import { isPaginatedBatch, PaginationDetectorService } from '../../services/pagination/pagination-detector.service';
import { PaginationSetupService } from '../../services/pagination/pagination-setup.service';
import { BatchMemberTransactionHandler } from '../../services/transaction-preparation/handlers/batch-member-transaction.handler';
import { PathGeneratorHelper, batchMemberFileName } from '../../services/transaction-preparation/helpers/path-generator.helper';
import { TemplateParser } from '../../data-loading/template-parser';
import { JsonGenerator } from '../../data-loading/json-generator';
import { flattenHeaders, flattenQueryParams } from '../../utils/jwt-validation';
// GitHub Issue #110: Import shared table builder utility to eliminate code duplication
import * as consoleTableBuilderScript from '../../webviews/shared/console-table-builder.js';
import * as searchMatcherScript from '../../webviews/shared/search-matcher.js';
import * as inputRowStatusScript from '../../webviews/shared/input-row-status.js';
import * as consoleErrorReasonScript from '../../webviews/shared/console-error-reason.js';
import { sharedScript } from '../../utils/shared-script';
const { createConsoleTableBuilder } = sharedScript<typeof consoleTableBuilderScript>(consoleTableBuilderScript, 'ConsoleTableBuilder');
// GitHub Issue #227: Import shared search matcher for multi-term, wildcard, and negation search
const { parseSearchExpression, matchesRow } = sharedScript<typeof searchMatcherScript>(searchMatcherScript, 'SearchMatcher');
// Issue #304: input row → transaction status, shared with the Input tab
const InputRowStatus = sharedScript<typeof inputRowStatusScript>(inputRowStatusScript, 'InputRowStatus');
// #428: the Error tab's Reason column, as the tab draws it (an export writes what the tab shows)
const ConsoleErrorReason = sharedScript<typeof consoleErrorReasonScript>(consoleErrorReasonScript, 'ConsoleErrorReason');

export interface ConsoleWebviewConfig {
    type: 'individual' | 'batch';
    executionId?: string;
    batchId?: string;
    endpointId?: string;
    responseFiles: string[];
    responseFileStatusMap?: Record<string, string>; // Maps responseFile path -> database status for classification
    responseFileDetails?: Record<string, ResponseFileDetail>; // #428: why each one is an error
    inputFile?: string; // CSV file path for batch input data
    requestFile?: string; // Request file path for individual transactions
    logFile?: string; // Log file path for both individual and batch
    title?: string;
    executionSummary?: {
        environment?: string;
        /** #344: the environment runs in DBMN for VS Code (the web app shows it in the title) */
        runsInVsCode?: boolean;
        organization?: string;
        /** The run's header values, each by its own name (the Settings tab, in place of Organization). */
        headers?: Array<{ name: string; value: string }>;
        endpointName?: string;
        /** #445: the batch's own name (batchConfiguration.name) */
        batchName?: string;
        endpointMethod?: string;
        endpointPath?: string;
        baseUrl?: string;
        transactionCount?: number;
        executedAt?: string;
        requestFile?: string;
        records?: number;
        // Enhanced metadata fields
        status?: string;
        statusText?: string;
        httpStatus?: number;
        duration?: number;
        completedAt?: string;
        startedAt?: string;
        hasErrors?: boolean;
        errorMessage?: string;
        // GitHub Issue #101: Request headers and query parameters
        requestHeaders?: Record<string, string>;
        requestQueryParams?: Record<string, string>;
        // GitHub Issue #102: Diagnostic stats - expected vs actual transaction counts
        expectedTransactions?: number;
        actualTransactions?: number;
        // GitHub Issue #102: Concurrency level for batch executions
        concurrency?: number;
        // GitHub Issue #156: Environment's max allowed concurrency
        environmentMaxConcurrency?: number;
        environmentId?: string;
        // GitHub Issue #151: Reprocess tracking fields
        reprocessedFromBatchId?: string;
        reprocessedToBatchId?: string;
        reprocessType?: string;
        // GitHub Issue #176: Batch copy lineage fields
        copiedFromBatchId?: string;
        copiedFromEnvironment?: string;
        copiedAt?: string;
        // ENV variables active at execution time
        environmentVariables?: Record<string, string>;
    };
}

export class ConsoleController {
    // Static map to track all active reports across instances
    private static activeConsoles: Map<string, ConsoleController> = new Map();
    private static missedStatusUpdates = new MissedStatusBuffer<ConsoleStatusUpdate>();

    /**
     * GitHub Issue #217: Close any open Console webview tied to a given executionId or batchId.
     * Called after a tree-view delete so the orphaned webview doesn't keep showing stale data.
     * Safe to call with an id that isn't open — returns false.
     */
    public static closeConsoleForExecution(id: string): boolean {
        const controller = ConsoleController.activeConsoles.get(id);
        if (!controller) return false;
        controller.ports.host.close();
        return true;
    }

    private currentConfig?: ConsoleWebviewConfig;
    private loadedTableData?: ExtractedTableData;
    private loadedTabbedData?: TabbedConsoleData;
    private loadedRawData?: RawConsoleData;
    private responseDataExtractor: IResponseDataExtractor;
    private exportService: IConsoleExportService;
    // GitHub Issue #117: documentationService now provided by ServiceAwareWebview base class

    // GitHub Issue #110: Use shared table builder utility for table generation
    private tableBuilder: any;

    // Track active log streaming callbacks for cleanup
    private activeLogStreamCallbacks: Map<string, () => void> = new Map();

    // GitHub Issue #94: Track pagination state for calculating totalPages
    private paginationState?: {
        config: any; // PaginationConfig from pagination-detector
        endpoint: any; // APIEndpointConfig for extracting pageSize
        totalPages?: number;
        totalRecords?: number;
        pageSize?: number;
        /** #446: the page size has been read from a response once; later pages don't change it (a last page is short). */
        sizeLearned?: boolean;
    };

    // Pending fetch mode from initial pagination execution — auto-trigger after page 1 completes
    // Static: survives across console instances (old individual → new batch console)
    private static pendingFetchModes: Map<string, { mode: 'all' | 'next'; count?: number }> = new Map();

    constructor(private readonly session: ScreenSession, private readonly ports: ConsolePorts, config: ConsoleWebviewConfig) {
        this.currentConfig = config;
        this.responseDataExtractor = new ResponseDataExtractor({
            executionLoggingService: ports.executionLogging,
            executionMetadataService: ports.metadata
        });
        this.exportService = new ConsoleExportService();
        // Issue #229: Views persist on APIEndpointConfig.consoleViews via APIEndpointManager.updateEndpoint.
        // GitHub Issue #110: shared table builder
        this.tableBuilder = createConsoleTableBuilder();
    }

    /** The run this Console shows. */
    get config(): ConsoleWebviewConfig | undefined {
        return this.currentConfig;
    }

    private async post(message: unknown): Promise<boolean> {
        this.session.post(message as Record<string, unknown>);
        return true;
    }

    private log(message: string): void {
        this.ports.logger.log(message);
    }

    private logError(message: string, error?: Error): void {
        this.ports.logger.error(message, error);
    }

    /** A message from the Console's page; replies the way ServiceAwareWebview did. */
    async handle(message: Record<string, unknown>): Promise<void> {
        if (await this.session.handleShared(message)) return;
        if (!message.type) return;
        const response = await this.processMessage({
            correlationId: (message.correlationId as string) || this.generateReportCorrelationId(),
            type: message.type as string,
            timestamp: (message.timestamp as number) || Date.now(),
            source: (message.source as BaseMessage['source']) || 'webview',
            target: (message.target as BaseMessage['target']) || 'extension',
            payload: message.payload
        } as BaseMessage);
        if (response) await this.post(response);
    }

    /**
     * Called by the Hub once the embedded iframe has signalled it is
     * ready to receive messages. This is where post-mount initial state
     * (table data, progress replay) is broadcast — calling it earlier
     * (e.g. from createEmbedded) sends to a listener-less window and
     * leaves the UI stuck on the loading spinner.
     */
    async onReady(): Promise<void> {
        if (!this.currentConfig) return;
        this.mark('page ready');
        // Register for live updates FIRST so any progress_update / status_update
        // that fires during the (potentially slow) loadInitialData lands in
        // activeConsoles and reaches the iframe. Without this, the engine's
        // member-completion events during the load window were silently
        // dropped because the lookup returned undefined.
        try {
            await this.attachLiveUpdates(this.currentConfig);
        } catch (err) {
            console.error('[Console] attachLiveUpdates failed:', err);
        }
        try {
            await this.loadInitialData(this.currentConfig);
        } catch (err) {
            // A failure here used to leave the loading overlay up forever
            // ("blank Console" bug) — surface the error to the frontend so
            // the user sees something and the spinner clears.
            console.error('[Console] loadInitialData failed:', err);
            try {
                await this.post({
                    type: 'console.table_data_response',
                    correlationId: `embed_load_error_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    success: false,
                    payload: {
                        rawData: {
                            responses: [{
                                httpStatus: 'ERROR',
                                data: { error: (err as Error).message, type: 'EMBED_LOAD_ERROR' },
                                metadata: { executionId: this.currentConfig.executionId || 'unknown' }
                            }],
                            metadata: { executionId: this.currentConfig.executionId, batchId: this.currentConfig.batchId },
                            requestHeaders: undefined,
                            requestQueryParams: undefined
                        }
                    }
                });
            } catch { /* swallow */ }
        }
        await this.replayMissedStatusUpdate(this.currentConfig);
    }

    /** A run can finish before the iframe signals ready; the config snapshot
     *  this Console loaded from is then stale. Replay the update it missed,
     *  reloading the data when the run has already ended. */
    private async replayMissedStatusUpdate(config: ConsoleWebviewConfig): Promise<void> {
        const id = config.executionId || config.batchId;
        if (!id) return;
        const missed = ConsoleController.missedStatusUpdates.take(id);
        if (!missed) return;
        const ended = missed.status === 'completed' || missed.status === 'error' || missed.status === 'stopped';
        await ConsoleController.sendStatusUpdate(id, ended ? { ...missed, forceReload: true } : missed);
    }

    /**
     * Wire this Console instance for live updates from the execution engine:
     *
     *  1. If the run is mid-flight, send a synthetic `progress_update` so
     *     the frontend flips out of PENDING into the running phase with the
     *     right progress bar / timer (the batch engine's stream only fires
     *     on the NEXT state change; without this, a freshly-opened console
     *     shows nothing until the next member completes).
     *  2. Register `this` in the static `activeConsoles` map under both
     *     `executionId` and `batchId` — that's the lookup
     *     `ConsoleController.sendStatusUpdate` / `sendProgressUpdate` /
     *     `sendMemberResultUpdate` etc. use to find the right Console
     *     instance and push messages. Without this, every live event is
     *     silently dropped.
     *  3. Tear down the registration when the panel disposes.
     *
     * Both the standalone path (`createWebview`) and the Hub-embedded path
     * (`onEmbeddedReady`) call this. Previously only the standalone path
     * did, so embedded Consoles stayed on PENDING forever — root cause of
     * "console doesn't update during a run".
     */
    private async attachLiveUpdates(config: ConsoleWebviewConfig): Promise<void> {
        const reopenStatus = config.executionSummary?.status?.toLowerCase();
        if (reopenStatus && (reopenStatus === 'running' || reopenStatus === 'paused' || reopenStatus === 'pending') && config.executionSummary) {
            // Count completed members from `responseFiles` (canonical disk
            // truth) rather than `loadedRawData.responses.length`, which
            // includes the *pending stubs* appended by extractRawData and
            // over-counts by the queued-but-unstarted total. Falls back to
            // 0 for runs with no responseFiles yet (correct, not wrong).
            const completedCount = config.responseFiles?.length
                ?? this.loadedRawData?.responses?.length
                ?? 0;
            const totalCount = config.executionSummary.expectedTransactions ?? 0;
            const startTimeMs = config.executionSummary.startedAt
                ? new Date(config.executionSummary.startedAt).getTime()
                : Date.now();

            let estimatedEndTime: number | null = null;
            if (completedCount > 0 && totalCount > completedCount) {
                const elapsedMs = Date.now() - startTimeMs;
                const msPerItem = elapsedMs / completedCount;
                const remainingItems = totalCount - completedCount;
                estimatedEndTime = Date.now() + (msPerItem * remainingItems);
            }

            await this.post({
                type: 'progress_update',
                correlationId: `progress_reopen_${Date.now()}`,
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    status: reopenStatus,
                    current: completedCount,
                    total: totalCount,
                    startTime: startTimeMs,
                    estimatedEndTime
                }
            });
        }

        const reportIds: string[] = [];
        if (config.executionId) reportIds.push(config.executionId);
        if (config.batchId)     reportIds.push(config.batchId);
        if (reportIds.length === 0) return;

        reportIds.forEach(id => ConsoleController.activeConsoles.set(id, this));
    }


    /**
     * Issue #312: an open-path timing line, where the person testing can see it —
     * the Console webview's own console (Developer: Open Webview Developer Tools in
     * the dev host, filter "DBMN timing"), plus the diagnostics output channel and
     * the extension-host console.
     */
    private timing(line: string): void {
        this.log(line);
        void this.post({ type: 'console.timing', line } as unknown as ResponseMessage).catch(() => undefined);
    }

    /**
     * Issue #312: the open timeline — marks set by whoever opens this Console
     * (the Hub) and by this manager, reported as one line once the first data
     * has been posted, so the whole click-to-rows path is visible in one place.
     */
    private openMarks: Array<[string, number]> = [];
    mark(label: string, at = Date.now()): void {
        this.openMarks.push([label, at]);
    }
    private openTimeline(): string {
        if (!this.openMarks.length) return '';
        const t0 = this.openMarks[0][1];
        return this.openMarks.map(([l, t]) => `${l} +${t - t0}ms`).join(' → ');
    }

    /** GitHub Issue #312: the most request/response bodies one Raw content request may ask for. */
    static readonly CONTENT_REQUEST_CAP = 200;
    /** GitHub Issue #312: batches with more members than this stream in chunks. */
    static readonly STREAM_THRESHOLD = 200;
    /** GitHub Issue #312: members per chunk — ~100 files is well under a second to read. */
    static readonly STREAM_CHUNK = 100;
    /** GitHub Issue #312: input rows in the first message; more than this streams. */
    static readonly INPUT_FIRST = 2000;
    /** GitHub Issue #312: input rows per chunk (~1 MB for a typical file). */
    static readonly INPUT_CHUNK = 5000;
    /** GitHub Issue #312: bumped by every load; a stream stops when its load is superseded. */
    private loadGeneration = 0;

    /**
     * GitHub Issue #312: post the rest of a large batch after the first chunk
     * has been drawn — the input rows first (already parsed, cheap, and the
     * Input tab and its row statuses want them whole), then the responses,
     * each chunk read from disk and appended to `loadedRawData` so export and
     * clipboard still see the whole batch. Every chunk carries the running
     * totals; the page's progress bar reads them. Stops quietly if the console
     * reloaded or closed meanwhile.
     */
    private async streamRemaining(config: ConsoleWebviewConfig, allFiles: string[], allInput: TableRow[], progress: StreamingProgress, generation: number): Promise<void> {
        const post = async (payload: Record<string, unknown>): Promise<boolean> => {
            if (generation !== this.loadGeneration || !this.loadedRawData) {
                this.log(`[Console] issue#312 stream for ${config.batchId} superseded at ${progress.loaded}/${progress.total}, input ${progress.inputLoaded}/${progress.inputTotal}`);
                return false;
            }
            try {
                await this.post({
                    ...createResponseMessage(this.generateReportCorrelationId(), true),
                    type: ConsoleMessageTypes.RAW_CHUNK,
                    payload: { ...payload, ...progress }
                } as unknown as ResponseMessage);
            } catch (error) {
                this.log(`[Console] issue#312 stream for ${config.batchId} stopped: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
            // Let the webview breathe between chunks — parsing is its bottleneck, not ours
            await new Promise(resolve => setTimeout(resolve, 15));
            return true;
        };

        for (let start = progress.inputLoaded; start < progress.inputTotal; start += ConsoleController.INPUT_CHUNK) {
            const inputRows = allInput.slice(start, start + ConsoleController.INPUT_CHUNK);
            progress = { ...progress, inputLoaded: Math.min(start + inputRows.length, progress.inputTotal) };
            if (!(await post({ inputRows }))) return;
        }

        let slowest = 0;
        let extractMs = 0, postMs = 0, chunks = 0;
        const streamStart = Date.now();
        for (let start = progress.loaded; start < progress.total; start += ConsoleController.STREAM_CHUNK) {
            const chunkStart = Date.now();
            const files = allFiles.slice(start, start + ConsoleController.STREAM_CHUNK);
            const responses = await this.responseDataExtractor.extractResponses(files, config.responseFileStatusMap, config.responseFileDetails);
            const extracted = Date.now();
            if (!this.loadedRawData) return;
            this.loadedRawData.responses.push(...responses);
            progress = { ...progress, loaded: Math.min(start + files.length, progress.total) };
            if (!(await post({ responses }))) return;
            const posted = Date.now();
            extractMs += extracted - chunkStart; postMs += posted - extracted; chunks++;
            slowest = Math.max(slowest, posted - chunkStart);
            // Where a slow stream spends its time — reading files, or waiting to post
            if (chunks % 50 === 0) {
                this.timing(`[Console] issue#312 stream ${config.batchId}: ${progress.loaded}/${progress.total} after ${Date.now() - streamStart}ms — reading ${extractMs}ms, posting ${postMs}ms, slowest chunk ${slowest}ms`);
            }
        }
        this.timing(`[Console] issue#312 stream ${config.batchId}: ${chunks} chunks — reading ${extractMs}ms, posting ${postMs}ms, slowest chunk ${slowest}ms`);
    }

    private async loadInitialData(config: ConsoleWebviewConfig): Promise<void> {
        try {
            const loadStartTime = Date.now();
            // Emit data loading started event
            const startEvent = createEventMessage(
                ConsoleMessageTypes.DATA_LOADING_STARTED,
                'ui-interaction',
                'medium',
                {
                    executionId: config.executionId,
                    batchId: config.batchId,
                    fileCount: config.responseFiles.length
                }
            ) as DataLoadingStartedEvent;

            await this.post(startEvent);

            // Create default report config
            const reportConfig: ConsoleConfig = {
                viewMode: 'auto',
                maxRows: 10000,
                flattenNested: true,
                arrayStrategy: 'concatenate'
            };

            // Extract data using appropriate service method
            const startTime = Date.now();
            let duration: number;

            // GitHub Issue #312: a large batch is streamed. Reading every response
            // file and posting them as ONE message meant a 750-member batch was a
            // 61 MB message (and thousands of members, hundreds of MB) that the
            // webview had to parse before it could draw a single row — the user
            // saw "loading" for minutes and had no buttons to stop the batch with.
            // Now the first chunk is extracted and shown at once; the rest follow
            // in RAW_CHUNK messages the page appends as they land.
            const allFiles = config.responseFiles || [];
            const streamResponses = config.type === 'batch' && allFiles.length > ConsoleController.STREAM_THRESHOLD;
            const firstConfig = streamResponses
                ? { ...config, responseFiles: allFiles.slice(0, ConsoleController.STREAM_CHUNK) }
                : config;

            // Use raw data extraction for both batch AND individual reports
            // This enables path selection UI for individual reports too (fixes issue #66)
            this.mark('extract start');
            const fullRawData = await this.extractRawData(firstConfig, reportConfig);
            this.mark('extract done');
            if (streamResponses) {
                // The "actual" transaction count the page shows on open is the whole batch
                fullRawData.metadata.totalRows = allFiles.length;
            }
            duration = Date.now() - startTime;

            // Store raw data (the whole input, for export and clipboard)
            this.loadedRawData = fullRawData;
            const generation = ++this.loadGeneration;

            // The input rows stream too: 67,000 rows were 15 MB of a 20 MB first
            // message — three quarters of what the page had to receive and parse
            // before it could draw. The first message carries the first few
            // thousand; the rest follow in RAW_CHUNK messages ahead of the responses.
            const allInput = fullRawData.inputData || [];
            const streamInput = allInput.length > ConsoleController.INPUT_FIRST;
            const streamed = streamResponses || streamInput;
            const rawData = streamInput
                ? { ...fullRawData, inputData: allInput.slice(0, ConsoleController.INPUT_FIRST) }
                : fullRawData;
            const streaming = streamed ? {
                loaded: firstConfig.responseFiles.length, total: allFiles.length,
                inputLoaded: rawData.inputData?.length ?? 0, inputTotal: allInput.length
            } : undefined;

            // Send raw data to webview
            const baseMessage = createResponseMessage(
                this.generateReportCorrelationId(),
                true
            );
            const tableDataMessage: TableDataResponse = {
                ...baseMessage,
                type: ConsoleMessageTypes.TABLE_DATA_RESPONSE,
                payload: {
                    rawData: rawData,
                    streaming
                }
            };

            const sendingStart = Date.now();
            await this.post(tableDataMessage);
            const sendingTime = Date.now() - sendingStart;
            // Issue #312: timings in the diagnostics log — compare a running batch with a finished one
            this.mark('first data posted');
            this.timing(`[Console] issue#312 open ${config.batchId || config.executionId}: first message extracted in ${duration}ms (${firstConfig.responseFiles.length} of ${allFiles.length} responses, ${rawData.inputData?.length ?? 0} of ${allInput.length} input rows), posted in ${sendingTime}ms`);
            this.timing(`[Console] issue#312 open timeline: ${this.openTimeline()}`);

            if (streaming) {
                const streamStart = Date.now();
                await this.streamRemaining(config, allFiles, allInput, streaming, generation);
                this.timing(`[Console] issue#312 open ${config.batchId}: stream finished in ${Date.now() - streamStart}ms`);
            }

            // Note: Data sending handled above based on report type

            // Emit data loading completed event
            const rowCount = config.type === 'batch' && this.loadedTabbedData ?
                (this.loadedTabbedData.input?.count || 0) + (this.loadedTabbedData.success?.count || 0) + (this.loadedTabbedData.errors?.count || 0) :
                this.loadedTableData?.rows.length || 0;

            const completeEvent = createEventMessage(
                ConsoleMessageTypes.DATA_LOADING_COMPLETED,
                'ui-interaction',
                'medium',
                {
                    executionId: config.executionId,
                    batchId: config.batchId,
                    rowCount,
                    duration
                }
            ) as DataLoadingCompletedEvent;

            await this.post(completeEvent);

            // Issue #229: Load views from APIEndpointConfig.consoleViews.
            // Ships with endpoint export/import for free.
            if (config.endpointId) {
                try {
                    const consoleViews = await this.loadConsoleViews(config.endpointId);
                    const settingsMessage = {
                        type: 'REPORT_SETTINGS_LOADED',
                        correlationId: `settings_loaded_${Date.now()}`,
                        source: 'extension' as const,
                        target: 'webview' as const,
                        timestamp: Date.now(),
                        endpointId: config.endpointId,
                        settings: consoleViews // null for new endpoints
                    };
                    await this.post(settingsMessage);
                } catch (settingsError) {
                    const settingsMessage = {
                        type: 'REPORT_SETTINGS_LOADED',
                        correlationId: `settings_loaded_${Date.now()}`,
                        source: 'extension' as const,
                        target: 'webview' as const,
                        timestamp: Date.now(),
                        endpointId: config.endpointId,
                        settings: null
                    };
                    await this.post(settingsMessage);
                    this.log(`Failed to load views for endpoint ${config.endpointId}: ${settingsError instanceof Error ? settingsError.message : String(settingsError)}, but endpointId sent`);
                }
            }

            // GitHub Issue #94: Detect pagination on-the-fly from endpointConfig
            if (config.type === 'batch' && config.batchId) {
                try {
                    const executionMetadataService = this.ports.metadata;
                    if (executionMetadataService) {
                        const batchMetadata = await executionMetadataService.getExecution(config.batchId);

                        // Check if batch has endpointConfig with pagination template
                        if (batchMetadata?.endpointConfig) {
                            const paginationDetector = new PaginationDetectorService();
                            const paginationConfig = paginationDetector.detectPagination(batchMetadata.endpointConfig);

                            if (paginationConfig.enabled) {
                                // GitHub Issue #94: Store pagination state for later totalPages calculation
                                // GitHub Issue #245: read size from the body when pagination lives there
                                const pageSize = paginationConfig.location === 'body'
                                    ? paginationDetector.extractPageSizeFromBody(batchMetadata.endpointConfig.body)
                                    : paginationDetector.extractPageSize(batchMetadata.endpointConfig.queryParams);
                                this.paginationState = {
                                    config: paginationConfig,
                                    endpoint: batchMetadata.endpointConfig,
                                    pageSize
                                };

                                // GitHub Issue #209: For re-opened batches, read a completed member's response
                                // to extract totalCount → totalPages so the existing batch-member scan below works
                                if (!this.paginationState.totalPages && pageSize) {
                                    const batchMembers = await executionMetadataService.getBatchMemberExecutions(config.batchId);
                                    const completedMember = batchMembers.find(m => m.responseFile && m.status === 'completed');
                                    if (completedMember?.responseFile && runFileExists(completedMember.responseFile)) {
                                        try {
                                            const content = readRunFile(completedMember.responseFile);
                                            const parsed = JSON.parse(content);
                                            const responseBody = parsed?.data || parsed;
                                            let totalCountPath = paginationConfig.totalCountPath;
                                            if (totalCountPath?.startsWith('data.')) {
                                                totalCountPath = totalCountPath.substring(5);
                                            }
                                            if (totalCountPath) {
                                                const totalCount = paginationDetector.extractTotalCount(responseBody, totalCountPath);
                                                if (totalCount !== null && totalCount > 0) {
                                                    // #446: the pages as the API sends them, not as asked
                                                    const sizeConfig = paginationDetector.detectSize(batchMetadata.endpointConfig);
                                                    const pages = paginationDetector.pagesFor(totalCount, pageSize, responseBody, sizeConfig.enabled ? sizeConfig.sizePath : undefined);
                                                    if (pages) {
                                                        this.paginationState.sizeLearned = true;
                                                        this.paginationState.totalPages = pages.totalPages;
                                                        this.paginationState.pageSize = pages.pageSize;
                                                    }
                                                    this.paginationState.totalRecords = totalCount;
                                                }
                                            }
                                        } catch (_) { /* non-critical */ }
                                    }
                                }

                                // GitHub Issue #94: Calculate initial button visibility state (R10)
                                // When totalPages is unknown, assume more pages might exist (R4.3)
                                let hasMorePages = true; // Default: assume more pages exist
                                let remainingPages: number | undefined = undefined;
                                let totalPages: number | undefined = undefined;
                                let currentHighestPage = paginationConfig.startValue;

                                // If we can already calculate totalPages (batch already executed), do it now
                                if (this.paginationState.totalPages && pageSize) {
                                    totalPages = this.paginationState.totalPages;

                                    // Calculate remaining pages from existing batch members
                                    try {
                                        const batchMembers = await executionMetadataService.getBatchMemberExecutions(config.batchId);

                                        if (paginationConfig.location === 'body') {
                                            // GitHub Issue #245: page lives in the body — members are one-per-page
                                            currentHighestPage = paginationConfig.startValue + batchMembers.length - 1;
                                        } else {
                                            for (const member of batchMembers) {
                                                if (member.requestQueryParams) {
                                                    const pageValue = member.requestQueryParams[paginationConfig.paramKey];
                                                    if (pageValue) {
                                                        const pageNum = parseInt(String(pageValue), 10);
                                                        if (!isNaN(pageNum) && pageNum > currentHighestPage) {
                                                            currentHighestPage = pageNum;
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        const highestFetchedOffset = currentHighestPage - paginationConfig.startValue;
                                        const fetchedCount = highestFetchedOffset + 1;
                                        remainingPages = totalPages - fetchedCount;
                                        hasMorePages = remainingPages > 0;

                                        this.log(`Initial pagination state: totalPages=${totalPages}, currentHighestPage=${currentHighestPage}, remainingPages=${remainingPages}, hasMorePages=${hasMorePages}`);
                                    } catch (error) {
                                        this.log(`Could not calculate initial remaining pages: ${error instanceof Error ? error.message : String(error)}`);
                                    }
                                }

                                // Send pagination metadata to frontend
                                const paginationMessage = {
                                    type: 'paginationMetadata',
                                    correlationId: `pagination_metadata_${Date.now()}`,
                                    source: 'extension' as const,
                                    target: 'webview' as const,
                                    timestamp: Date.now(),
                                    paginationData: {
                                        enabled: true,
                                        paramKey: paginationConfig.paramKey,
                                        startValue: paginationConfig.startValue,
                                        totalCountPath: paginationConfig.totalCountPath,
                                        templateVariable: paginationConfig.templateVariable,
                                        currentPage: currentHighestPage,
                                        totalPages,
                                        remainingPages,
                                        hasMorePages
                                    }
                                };
                                await this.post(paginationMessage);
                            }
                        }
                    }
                } catch (paginationError) {
                    this.log(`Failed to detect pagination for batch ${config.batchId}: ${paginationError instanceof Error ? paginationError.message : String(paginationError)}`);
                }
            }

        } catch (error) {
            this.logError('Failed to load initial data', error instanceof Error ? error : new Error(String(error)));

            // Send error message to webview
            const errorMessage = createErrorResponseMessage(
                this.generateReportCorrelationId(),
                error instanceof Error ? error : new Error(String(error)),
                'DATA_LOADING_FAILED'
            );

            await this.post(errorMessage);
        }
    }

    /**
     * Extract tabbed data from batch response files using ResponseDataExtractor service
     */
    private async extractTabbedData(config: ConsoleWebviewConfig, reportConfig: ConsoleConfig): Promise<TabbedConsoleData> {
        try {
            // Extract tabbed data using the new method
            return await this.responseDataExtractor.extractTabbedBatchData(config.responseFiles, config.inputFile);
        } catch (error) {
            // If extraction fails, create error data structure
            this.logError('Tabbed data extraction failed', error instanceof Error ? error : new Error(String(error)));

            // Return minimal error structure
            return {
                errors: {
                    type: 'errors',
                    rows: [{
                        __error: error instanceof Error ? error.message : String(error),
                        __executionId: config.executionId || 'unknown',
                        __sourceFiles: config.responseFiles.join(', ')
                    }],
                    columns: [
                        { id: '__error', name: 'Error', type: 'string', sortable: false, filterable: true },
                        { id: '__executionId', name: 'Execution ID', type: 'string', sortable: true, filterable: true },
                        { id: '__sourceFiles', name: 'Source Files', type: 'string', sortable: false, filterable: true }
                    ],
                    count: 1,
                    rootPath: 'root',
                    availablePaths: [{ path: 'root', type: 'object', depth: 0, recommended: true, description: 'Full response (no extraction)' }]
                },
                metadata: {
                    totalRows: 1,
                    executionId: config.executionId,
                    batchId: config.batchId,
                    extractionTime: 0,
                    dataType: config.type
                }
            };
        }
    }

    /**
     * Extract raw data - the RIGHT way for dynamic path selection
     */
    private async extractRawData(config: ConsoleWebviewConfig, reportConfig: ConsoleConfig): Promise<RawConsoleData> {
        try {
            // Determine request file source: use config.requestFile first, then fallback to executionSummary.requestFile
            const requestFile = config.requestFile || config.executionSummary?.requestFile;

            // Execution ID can be either batch or individual - both are execution IDs
            const executionId = config.batchId || config.executionId;

            // Use the new raw data extraction method with request, log file, execution ID, and batch ID support
            // GitHub Issue #102: Pass batchId for diagnostic stats metadata population
            // Pass responseFileStatusMap for status-based classification (HTTP 200 + failed tests = error)
            const rawData = await this.responseDataExtractor.extractRawConsoleData(
                config.responseFiles,
                config.inputFile,
                requestFile,
                config.logFile,
                executionId,
                config.batchId,  // GitHub Issue #102: Pass batchId for diagnostic stats
                config.responseFileStatusMap,  // Maps responseFile -> status for classification
                config.responseFileDetails     // #428: why each one is an error
            );

            // Live DB query: append stub entries for pending/running members without response files
            // This replaces the stale config.pendingMembers snapshot — each call gets fresh DB state
            if (config.type === 'batch' && config.batchId) {
                const executionMetadataService = this.ports.metadata;
                if (executionMetadataService) {
                    const batchMembers = await executionMetadataService.getBatchMemberFiles(config.batchId); // Issue #312: lean rows
                    const existingExecIds = new Set(
                        rawData.responses.map(r => r.metadata?.executionId).filter(Boolean)
                    );
                    const pendingMembers = (batchMembers || []).filter(
                        m => m.status !== 'split' && !m.responseFile && !existingExecIds.has(m.id)
                    );
                    for (const member of pendingMembers) {
                        rawData.responses.push({
                            httpStatus: '-',
                            status: member.status,
                            data: null,
                            metadata: {
                                executionId: member.id,
                                sourceFile: undefined,
                                status: member.status,
                                timestamp: member.createdAt?.toISOString()
                            }
                        });
                    }
                }
            }

            // Issue #248: surface the endpoint's referenced template-variable
            // names so the Console's Input tab can build a "Mapped Columns"
            // auto-view (only those input columns referenced by `{{vars}}`).
            const mappedVariableNames = await this.loadMappedVariableNames(config.endpointId);

            // GitHub Issue #101: Add headers and query params from execution summary
            return {
                ...rawData,
                requestHeaders: config.executionSummary?.requestHeaders,
                requestQueryParams: config.executionSummary?.requestQueryParams,
                mappedVariableNames
            };
        } catch (error) {
            // If extraction fails, create minimal error structure
            this.logError('Raw data extraction failed', error instanceof Error ? error : new Error(String(error)));

            // Return minimal error structure with raw responses
            return {
                responses: [{
                    httpStatus: 'ERROR',
                    data: {
                        error: error instanceof Error ? error.message : String(error),
                        type: 'EXTRACTION_ERROR'
                    },
                    metadata: {
                        executionId: config.executionId || 'unknown',
                        sourceFile: config.responseFiles.join(', ')
                    }
                }],
                availablePaths: [
                    { path: 'root', type: 'object', depth: 0, recommended: true, description: 'Error data' }
                ],
                metadata: {
                    totalRows: 1,
                    executionId: config.executionId,
                    batchId: config.batchId,
                    extractionTime: 0,
                    dataType: 'raw'
                },
                // NEW: Request and Logs tab support
                requestContent: undefined,
                hasValidRequest: false,
                logContent: undefined,
                isStreaming: false,
                lastRefreshed: new Date(),
                // GitHub Issue #101: Add headers and query params even in error case
                requestHeaders: config.executionSummary?.requestHeaders,
                requestQueryParams: config.executionSummary?.requestQueryParams,
                // Issue #248
                mappedVariableNames: []
            };
        }
    }

    /**
     * Extract table data from response files using ResponseDataExtractor service (for individual reports)
     */
    private async extractTableData(config: ConsoleWebviewConfig, reportConfig: ConsoleConfig): Promise<ExtractedTableData> {
        try {
            // Extract data from single individual response file
            const responseFile = config.responseFiles[0];
            if (!responseFile) {
                throw new Error('No response file provided for individual transaction');
            }
            return await this.responseDataExtractor.extractIndividualResponse(responseFile);
        } catch (error) {
            // If extraction fails, create error data structure
            this.logError('Data extraction failed', error instanceof Error ? error : new Error(String(error)));

            return {
                rows: [{
                    __error: error instanceof Error ? error.message : String(error),
                    __executionId: config.executionId || 'unknown',
                    __sourceFiles: config.responseFiles.join(', ')
                }],
                columns: [
                    { id: '__error', name: 'Error', type: 'string', sortable: false, filterable: true },
                    { id: '__executionId', name: 'Execution ID', type: 'string', sortable: true, filterable: true },
                    { id: '__sourceFiles', name: 'Source Files', type: 'string', sortable: false, filterable: true }
                ],
                metadata: {
                    totalRows: 1,
                    executionId: config.executionId,
                    batchId: config.batchId,
                    extractionTime: 0,
                    dataType: config.type
                }
            };
        }
    }

    /**
     * Send individual report data to webview (existing logic)
     */
    private async sendIndividualReportData(extractedData: ExtractedTableData, config: ConsoleWebviewConfig, duration: number): Promise<void> {
        // Analyze structure of the first response file for insights
        let structureAnalysis;
        try {
            const sampleFile = config.responseFiles[0];
            const sampleData = await this.readSampleDataForAnalysis(sampleFile);
            structureAnalysis = this.responseDataExtractor.analyzeDataStructure(sampleData);
        } catch (error) {
            // Fallback structure analysis
            structureAnalysis = {
                type: 'array' as const,
                depth: 1,
                arrayPaths: [],
                objectPaths: [],
                suggestedView: 'table' as const,
                flatteningStrategy: {
                    enabled: true,
                    maxDepth: 3,
                    separator: '.',
                    arrayHandling: 'concatenate' as const
                }
            };
        }

        // Send data to webview
        const baseMessage = createResponseMessage(
            this.generateReportCorrelationId(),
            true
        );
        const tableDataMessage: TableDataResponse = {
            ...baseMessage,
            type: ConsoleMessageTypes.TABLE_DATA_RESPONSE,
            payload: {
                tableData: extractedData,
                structureAnalysis,
                performanceMetrics: {
                    extractionTime: duration,
                    fileCount: config.responseFiles.length,
                    rowCount: extractedData.rows.length,
                    columnCount: extractedData.columns.length
                }
            }
        };

        await this.post(tableDataMessage);
    }

    /**
     * Process report-related messages from webview
     */
    private async processMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        try {
            // The window controls (maximise, close) are the Hub's: it handles them for its tabs.
            // Help links (openExternalUrl) are the ScreenSession's.

            // Issue #229: persist views to APIEndpointConfig.consoleViews.
            if (isSaveConsoleSettingsRequest(message)) {
                try {
                    const actualPayload = (message.payload as any).payload || message.payload;
                    const { endpointId, settings } = actualPayload;
                    await this.saveConsoleViews(endpointId, await this.keepQueryViews(endpointId, settings));
                    return createResponseMessage(
                        message.correlationId,
                        true,
                        { message: 'Views saved successfully' }
                    );
                } catch (error) {
                    this.logError('Failed to save console views', error instanceof Error ? error : new Error(String(error)));
                    return createErrorResponseMessage(
                        message.correlationId,
                        error instanceof Error ? error : new Error(String(error)),
                        'SETTINGS_SAVE_FAILED'
                    );
                }
            }

            // Handle report-specific messages
            if (isGetTableDataRequest(message)) {
                return await this.handleGetTableData(message);
            }

            if (isExportDataRequest(message)) {
                return await this.handleExportData(message);
            }

            // GitHub Issue #120: Handle clipboard export
            if (isExportToClipboardRequest(message)) {
                return await this.handleExportToClipboard(message);
            }

            if (isUpdateViewStateRequest(message)) {
                return await this.handleUpdateViewState(message);
            }

            if (isChangeTabRequest(message)) {
                return await this.handleChangeTab(message);
            }

            if (isChangeRootPathRequest(message)) {
                return await this.handleChangeRootPath(message);
            }

            // NEW: Handle refresh and log streaming messages
            if (isRefreshConsoleRequest(message)) {
                return await this.handleRefreshReport(message);
            }

            if (isStartLogStreamRequest(message)) {
                return await this.handleStartLogStream(message);
            }

            if (isStopLogStreamRequest(message)) {
                return await this.handleStopLogStream(message);
            }

            // GitHub Issue #94: Handle lazy log loading
            if (isLoadLogsRequest(message)) {
                return await this.handleLoadLogsRequest(message);
            }

            // GitHub Issue #102: Handle database count request
            if (isDatabaseCountRequest(message)) {
                return await this.handleDatabaseCountRequest(message);
            }

            // GitHub Issue #166: Raw file request handlers
            if (isGetRawTabDataRequest(message)) {
                return await this.handleGetRawTabData(message);
            }

            if (isGetRawTransactionContentRequest(message)) {
                return await this.handleGetRawTransactionContent(message);
            }

            // GitHub Issue #166: Transaction log modal
            if (isGetTransactionLogRequest(message)) {
                return await this.handleGetTransactionLog(message);
            }

            // Console footer action buttons — direct semantic handlers
            if (message.type === 'pauseBatch') {
                return await this.handlePauseBatch(message);
            }

            // Issue #309: the footer Cancel button. Nothing listened to this
            // message before — a queued batch could not be cancelled at all.
            if (message.type === 'cancel_execution') {
                return await this.handleCancelExecution(message);
            }

            // Issue #312: the Settings tab's Configure controls. These used to go
            // through dbmn.updateBatch* commands, which were removed in June 2026
            // with the toast standardisation — the controls had been dead since.
            if (message.type === 'updateBatchName' || message.type === 'updateBatchErrorMode' || message.type === 'updateBatchConcurrency') {
                return await this.handleUpdateBatchSetting(message);
            }

            if (message.type === 'resumeBatch') {
                return await this.handleResumeBatch(message);
            }

            if (message.type === 'reprocessBatch') {
                return await this.handleReprocessBatch(message);
            }

            if (message.type === 'rerunTransaction') {
                return await this.handleRerunTransaction(message);
            }

            if (message.type === 'deleteTransaction') {
                return await this.handleDeleteTransaction(message);
            }

            // GitHub Issue #94: Handle fetch next page request for pagination
            if (message.type === 'fetchNextPage') {
                return await this.handleFetchNextPage(message);
            }

            // GitHub Issue #94: Handle get all pages request for pagination
            if (message.type === 'getAllPages') {
                return await this.handleGetAllPages(message);
            }

            // GitHub Issue #94: Handle get page range request for pagination
            if (message.type === 'getPageRange') {
                return await this.handleGetPageRange(message);
            }

            // GitHub Issue #198: Handle configure pagination request (opens modal)
            if (message.type === 'configurePagination') {
                return await this.handleConfigurePagination(message);
            }

            // GitHub Issue #198: Handle save pagination config from modal
            if (message.type === 'savePaginationConfig') {
                return await this.handleSavePaginationConfig(message);
            }

            // Per-card retry: reprocess a single member in-batch
            if (message.type === 'retryMember') {
                return await this.handleRetryMember(message);
            }

            // GitHub Issue #151: Handle view original batch request
            if (message.type === 'viewOriginalBatch') {
                return await this.handleViewOriginalBatch(message);
            }

            // Navigation: Open Endpoint or Environment from Settings tab links
            if (message.type === 'console.openEndpoint') {
                const { endpointId } = message.payload as { endpointId: string };
                if (endpointId) {
                    await this.ports.host.openEndpoint(endpointId);
                }
                return createResponseMessage(message.correlationId, true);
            }

            if (message.type === 'console.openEnvironment') {
                const { environmentId } = message.payload as { environmentId: string };
                if (environmentId) {
                    await this.ports.host.openEnvironment(environmentId);
                }
                return createResponseMessage(message.correlationId, true);
            }

            // #298: Compare, from the Completed tab
            if (message.type === 'console.report' || message.type === 'console.compareViews') {
                await this.getCompareHandler().handle(message as { type: string; payload?: unknown });
                return createResponseMessage(message.correlationId, true);
            }

            // GitHub Issue #247: Chain button, Links tab
            if (message.type === 'console.chain' || message.type === 'console.chainConfirm' || message.type === 'console.getLinks' || message.type === 'console.openLinkedRun') {
                await this.getChainHandler().handle(message as { type: string; payload?: unknown });
                return createResponseMessage(message.correlationId, true);
            }

            this.log(`Unhandled message type: ${message.type}`);
            if (message.type.includes('request')) {
                return createErrorResponseMessage(message.correlationId, `Unsupported message type: ${message.type}`, 'UNSUPPORTED_MESSAGE');
            }

        } catch (error) {
            this.logError(`Error processing report message ${message.type}`, error instanceof Error ? error : new Error(String(error)));

            if (message.type.includes('request') || (message as any).expectsResponse) {
                return createErrorResponseMessage(
                    message.correlationId,
                    error instanceof Error ? error : new Error(String(error)),
                    'REPORT_MESSAGE_PROCESSING_ERROR'
                );
            }
        }
    }

    /**
     * Handle get table data request
     */
    private async handleGetTableData(message: GetTableDataRequest): Promise<TableDataResponse> {
        const { executionId, batchId, responseFiles, config } = message.payload;

        try {
            const startTime = Date.now();
            const extractedData = await this.extractTableData({
                type: batchId ? 'batch' : 'individual',
                executionId,
                batchId,
                responseFiles
            }, config);
            const duration = Date.now() - startTime;

            this.loadedTableData = extractedData;

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    tableData: extractedData,
                    structureAnalysis: {
                        type: 'array' as const,
                        depth: 1,
                        arrayPaths: [],
                        objectPaths: [],
                        suggestedView: 'table' as const,
                        flatteningStrategy: {
                            enabled: config.flattenNested || false,
                            maxDepth: 3,
                            separator: '.',
                            arrayHandling: config.arrayStrategy || 'concatenate'
                        }
                    },
                    performanceMetrics: {
                        extractionTime: duration,
                        fileCount: responseFiles.length,
                        rowCount: extractedData.rows.length,
                        columnCount: extractedData.columns.length
                    }
                }
            ) as TableDataResponse;

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'TABLE_DATA_EXTRACTION_FAILED'
            ) as TableDataResponse;
        }
    }

    /**
     * Handle export data request
     * Backend re-extraction: extracts data from loadedRawData using saved settings
     * Eliminates 8MB+ message size limit by only sending tab name (~100 bytes)
     *
     * Excel exports: Multi-sheet workbook (Input, Success, Errors) - filename: {executionId}.xlsx
     * CSV exports: Single tab - filename: {executionId}_{tab}.csv
     */
    private async handleExportData(message: ExportDataRequest): Promise<ExportCompleteResponse> {
        const { format, tab, options = {} } = message.payload;



        try {
            // GitHub Issue #152: Always re-extract data before export to ensure we have latest
            // This ensures export works during live streaming (gets whatever has been written so far)
            if (this.currentConfig) {
                // GitHub Issue #152: Populate responseFiles from batch members BEFORE extraction
                // During running, responseFiles is empty - need to fetch current files from batch engine
                if (this.currentConfig.type === 'batch') {
                    const batchId = this.currentConfig.executionId || this.currentConfig.batchId;

                    try {
                        const batchEngine = (this.ports.batchEngine as unknown) as any;
                        if (batchEngine && typeof batchEngine.getBatchMembers === 'function') {
                            const batchMembers = await batchEngine.getBatchMembers(batchId);
                            const responseFiles = batchMembers
                                .map((member: any) => member.responseFile)
                                .filter((file: string | undefined) => !!file);
                            this.currentConfig.responseFiles = responseFiles;
                        }
                    } catch (batchError) {
                        this.log(`[handleExportData] issue#152 Failed to get batch members: ${batchError}`);
                    }
                }


                const reportConfig = {
                    viewMode: 'auto' as const,
                    maxRows: 10000,
                    flattenNested: true,
                    arrayStrategy: 'concatenate' as const
                };
                this.loadedRawData = await this.extractRawData(this.currentConfig, reportConfig);
            }

            // Validate we have the necessary data
            if (!this.loadedRawData) {
                throw new Error('No report data available for export');
            }

            if (!this.currentConfig?.endpointId) {
                throw new Error('No endpoint ID available for export');
            }

            // Get executionId for filename (batchId for batch reports, executionId for individual)
            const executionId = this.currentConfig.executionId || this.currentConfig.batchId || 'report';

            // Branch on export format
            if (format === 'excel') {
                return await this.handleExcelMultiSheetExport(message, executionId);
            } else {
                return await this.handleSingleTabExport(message, executionId, tab);
            }

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'EXPORT_FAILED'
            ) as ExportCompleteResponse;
        }
    }

    /**
     * GitHub Issue #200: load the run's responses once. For completed executions opened from the
     * Completed tab the data is already in memory — re-extracting every response file from disk
     * is expensive. Shared by Copy (clipboard) and Chain (#247).
     */
    private async ensureRawDataLoaded(): Promise<void> {
        if (this.loadedRawData || !this.currentConfig) return;
        // GitHub Issue #152: Populate responseFiles from batch members BEFORE extraction
        if (this.currentConfig.type === 'batch') {
            const batchId = this.currentConfig.executionId || this.currentConfig.batchId;
            try {
                const batchEngine = (this.ports.batchEngine as unknown) as any;
                if (batchEngine && typeof batchEngine.getBatchMembers === 'function') {
                    const batchMembers = await batchEngine.getBatchMembers(batchId);
                    const responseFiles = batchMembers
                        .map((member: any) => member.responseFile)
                        .filter((file: string | undefined) => !!file);
                    this.currentConfig.responseFiles = responseFiles;
                }
            } catch (batchError) {
                this.log(`[ensureRawDataLoaded] issue#152 Failed to get batch members: ${batchError}`);
            }
        }
        const reportConfig = {
            viewMode: 'auto' as const,
            maxRows: 10000,
            flattenNested: true,
            arrayStrategy: 'concatenate' as const
        };
        this.loadedRawData = await this.extractRawData(this.currentConfig, reportConfig);
    }

    /**
     * GitHub Issue #247: the rows a tab shows right now — its active view, columns and search —
     * with raw values, exactly as Copy CSV takes them.
     */
    async getTabRowsForChain(payload: { tab: 'input' | 'success' | 'errors'; visibleColumnIds?: string[] | null; currentPath?: string; searchTerm?: string; view?: any }): Promise<{ data: any[]; columns: ColumnDefinition[] } | null> {
        await this.ensureRawDataLoaded();
        if (!this.loadedRawData) return null;
        return this.extractTabData(payload.tab, payload.visibleColumnIds, payload.currentPath, payload.searchTerm, payload.view);
    }

    private chainHandler?: ConsoleChainHandler;

    /** GitHub Issue #247: Chain and Links live in console-chain-handler.ts; this file only routes. */
    private getChainHandler(): ConsoleChainHandler {
        if (!this.chainHandler) {
            this.chainHandler = new ConsoleChainHandler({
                getTabRowsForChain: (request) => this.getTabRowsForChain(request),
                getChainSourceRef: () => this.getChainSourceRef(),
                toCsv: (data, columns) => this.exportService.exportToCsvString(data, columns, { includeHeaders: true, delimiter: ',', quoteChar: '"' } as any),
                post: async (msg) => { await this.post(msg as unknown as ResponseMessage); },
                notify: (level, text) => {
                    if (level === 'error') this.ports.toast.error(text);
                    else if (level === 'warn') this.ports.toast.warn(text);
                    else this.ports.toast.info(text);
                },
                store: this.ports.links,
                endpoints: this.ports.endpoints,
                environments: this.ports.environments,
                openConsole: (executionId, isBatch) => this.ports.host.openConsole(executionId, isBatch),
                openRunBatch: (endpoint, chain) => this.ports.host.openRunBatch(endpoint, chain)
            });
        }
        return this.chainHandler;
    }

    private compareHandler?: ConsoleCompareHandler;

    /** #298: Compare lives in console-compare-handler.ts; this file only routes. */
    private getCompareHandler(): ConsoleCompareHandler {
        if (!this.compareHandler) {
            this.compareHandler = new ConsoleCompareHandler({
                getSourceRef: () => this.getChainSourceRef(),
                metadata: this.ports.metadata,
                environments: this.ports.environments,
                endpoints: this.ports.endpoints,
                state: this.ports.state,
                post: async (msg) => { await this.post(msg as unknown as ResponseMessage); },
                notify: (level, text) => {
                    if (level === 'error') this.ports.toast.error(text);
                    else if (level === 'warn') this.ports.toast.warn(text);
                    else this.ports.toast.info(text);
                },
                openCompare: this.ports.host.openCompare ? id => this.ports.host.openCompare!(id) : undefined
            });
        }
        return this.compareHandler;
    }

    /** GitHub Issue #247: which run this Console shows. */
    getChainSourceRef(): { executionId?: string; endpointId?: string } {
        const executionId = this.currentConfig?.executionId || this.currentConfig?.batchId;
        return { executionId, endpointId: this.currentConfig?.endpointId };
    }

    /**
     * Handle clipboard export (multiple formats)
     * GitHub Issue #120: Add capability to copy CSV to clipboard
     * GitHub Issue #174: Support TSV, HTML, Markdown clipboard formats
     */
    private async handleExportToClipboard(message: ExportToClipboardRequest): Promise<ClipboardReadyResponse> {
        const { tab, format = 'csv', options = {}, visibleColumnIds, currentPath, searchTerm, view } = message.payload as any; // GitHub Issue #155, #174, #200, #229

        try {
            // GitHub Issue #200: Only re-extract if data not already loaded
            await this.ensureRawDataLoaded();

            // Validate we have the necessary data
            if (!this.loadedRawData) {
                throw new Error('No report data available for export');
            }

            // Extract data for the requested tab
            // GitHub Issue #155: Pass visibleColumnIds from frontend
            // GitHub Issue #200: Pass currentPath from frontend to avoid settings save race condition
            // Filter-aware export: pass searchTerm to filter rows before export
            // Issue #229: Pass active view directly so export doesn't depend on
            // endpoint-side persistence (covers old executions whose endpoint
            // was deleted/renamed).
            const tabData = await this.extractTabData(tab, visibleColumnIds, currentPath, searchTerm, view, (message.payload as any).inputStatusFilter);

            if (!tabData || tabData.data.length === 0) {
                throw new Error(`No data available in ${tab} tab`);
            }

            // GitHub Issue #200: Pre-export cell count check
            const rowCount = tabData.data.length;
            const colCount = tabData.columns.length;
            const cellCount = rowCount * colCount;
            this.log(`[handleExportToClipboard] issue#200 Exporting ${rowCount.toLocaleString()} rows × ${colCount} columns (${cellCount.toLocaleString()} cells) as ${format}`);

            // GitHub Issue #200: For very large datasets (> 5M cells), HTML is impractical
            // even in lightweight mode — fall back to TSV which pastes well everywhere
            const HTML_CELL_LIMIT = 5_000_000;
            let effectiveFormat = format;
            if (format === 'html' && cellCount > HTML_CELL_LIMIT) {
                this.log(`[handleExportToClipboard] issue#200 HTML too large (${cellCount.toLocaleString()} cells > ${HTML_CELL_LIMIT.toLocaleString()}), falling back to TSV`);
                effectiveFormat = 'tsv';
            }

            // Prepare options
            const exportOptions = {
                ...options,
                includeHeaders: true,
                delimiter: ',',
                quoteChar: '"',
                tab: tab  // GitHub Issue #174: Pass tab context for header colour
            };

            // GitHub Issue #174: Generate content based on requested format
            let content: string;
            switch (effectiveFormat) {
                case 'tsv':
                    content = await this.exportService.exportToTsvString(
                        tabData.data,
                        tabData.columns,
                        exportOptions
                    );
                    break;
                case 'html':
                    content = await this.exportService.exportToHtmlString(
                        tabData.data,
                        tabData.columns,
                        exportOptions
                    );
                    break;
                case 'markdown':
                    content = await this.exportService.exportToMarkdownString(
                        tabData.data,
                        tabData.columns,
                        exportOptions
                    );
                    break;
                case 'csv':
                default:
                    content = await this.exportService.exportToCsvString(
                        tabData.data,
                        tabData.columns,
                        exportOptions
                    );
                    break;
            }

            // GitHub Issue #200: Write clipboard directly from backend for all formats
            // GitHub Issue #225: Generate companion type-aware HTML for dual-format clipboard
            // For HTML with small datasets (< 10k rows), send to webview for rich CF_HTML clipboard
            // For HTML with large datasets, write as plain text to avoid IPC serialization of GB-scale strings
            const HTML_RICH_CLIPBOARD_THRESHOLD = 10000;

            // GitHub Issue #225: For non-HTML formats, generate companion type-aware HTML
            // so spreadsheets preserve string types (leading zeros) via mso-number-format
            if (effectiveFormat !== 'html' && rowCount < HTML_RICH_CLIPBOARD_THRESHOLD) {
                const typeAwareHtml = await this.exportService.exportToTypeAwareHtmlString(
                    tabData.data, tabData.columns, exportOptions
                );

                if (typeAwareHtml) {
                    // Send both text + HTML to webview for dual-format clipboard write
                    const response = createResponseMessage(
                        message.correlationId,
                        true,
                        {
                            content: content,
                            htmlContent: typeAwareHtml,
                            rowCount: rowCount,
                            columnCount: colCount,
                            format: effectiveFormat
                        }
                    ) as ClipboardReadyResponse;
                    response.type = ConsoleMessageTypes.CLIPBOARD_READY;
                    return response;
                }
            }

            // For HTML format with small datasets, send to webview for rich clipboard (CF_HTML)
            const useRichHtml = effectiveFormat === 'html' && rowCount < HTML_RICH_CLIPBOARD_THRESHOLD;

            if (!useRichHtml) {
                // No string columns or large dataset: text-only clipboard from backend
                await this.ports.clipboard.writeText(content);

                const response = createResponseMessage(
                    message.correlationId,
                    true,
                    {
                        rowCount: rowCount,
                        columnCount: colCount,
                        format: effectiveFormat,
                        clipboardWritten: true
                    }
                ) as ClipboardReadyResponse;
                response.type = ConsoleMessageTypes.CLIPBOARD_READY;
                return response;
            }

            // HTML format with small dataset: send to webview for rich clipboard (CF_HTML)
            const response = createResponseMessage(
                message.correlationId,
                true,
                {
                    content: content,
                    rowCount: rowCount,
                    columnCount: colCount,
                    format: effectiveFormat
                }
            ) as ClipboardReadyResponse;
            response.type = ConsoleMessageTypes.CLIPBOARD_READY;

            return response;

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'CLIPBOARD_EXPORT_FAILED'
            ) as ClipboardReadyResponse;
        }
    }

    /**
     * Handle single tab export (CSV, JSON, SQL)
     * Filename: {executionId}_{tab}.{ext}
     */
    private async handleSingleTabExport(
        message: ExportDataRequest,
        executionId: string,
        tab: 'input' | 'success' | 'errors'
    ): Promise<ExportCompleteResponse> {
        const { format, options = {}, visibleColumnIds, currentPath, searchTerm, view, inputStatusFilter } = message.payload as any; // GitHub Issue #155, #200, #229, #304

        // Extract data for the single tab
        // GitHub Issue #155: Pass visibleColumnIds from frontend
        // GitHub Issue #200: Pass currentPath from frontend to avoid settings save race condition
        // Filter-aware export: pass searchTerm to filter rows before export
        // Issue #229: Pass active view from frontend so export works even
        // when the endpoint is missing from globalState.
        const tabData = await this.extractTabData(tab, visibleColumnIds, currentPath, searchTerm, view, inputStatusFilter);

        if (!tabData || tabData.data.length === 0) {
            throw new Error(`No data available in ${tab} tab`);
        }

        // Issue #239: warn for CSV only when a column carries arrays of
        // objects (JSON-stringified, ugly to read). Primitive arrays now
        // serialise as comma-joined values and don't need a warning.
        const columnsWithArrays: string[] = [];
        if (format === 'csv') {
            tabData.columns.forEach((column: ColumnDefinition) => {
                const hasObjectArray = tabData.data.some((row: any) => {
                    const value = row[column.id];
                    return Array.isArray(value)
                        && value.some(v => v !== null && typeof v === 'object');
                });
                if (hasObjectArray) {
                    columnsWithArrays.push(column.id);
                }
            });
        }

        // Show save dialog with new filename format
        const fileExtension = this.getFileExtension(format);
        const defaultFileName = `${executionId}_${tab}`;

        const dialogTitle = `Save ${format.toUpperCase()} Export`;

        const saveTarget = await this.ports.files.chooseSaveTarget(`${defaultFileName}.${fileExtension}`, this.getFileFilters(format), dialogTitle);

        if (!saveTarget) {
            return createErrorResponseMessage(
                message.correlationId,
                new Error('Export cancelled by user'),
                'EXPORT_CANCELLED'
            ) as ExportCompleteResponse;
        }

        // Prepare options
        const updatedOptions = {
            ...options,
            targetUri: saveTarget,
            rootPath: tabData.currentPath,
            hierarchical: true,
            includeHeaders: true,
            arrayWarning: columnsWithArrays.length > 0
                ? `Note: ${columnsWithArrays.length} column(s) contain nested arrays shown as summaries. Use JSON export for complete data.`
                : undefined
        };

        // Send EXPORT_STARTED message to webview (to show overlay with filename)
        const filename = path.basename(saveTarget);
        await this.post({
            type: ConsoleMessageTypes.EXPORT_STARTED,
            correlationId: message.correlationId,
            source: 'extension' as const,
            target: 'webview' as const,
            timestamp: Date.now(),
            payload: {
                filename,
                format,
                rowCount: tabData.data.length
            }
        });

        // Emit export progress event
        const progressEvent = createEventMessage(
            ConsoleMessageTypes.EXPORT_PROGRESS,
            'file-operation',
            'medium',
            {
                format,
                progress: 0,
                rowsProcessed: 0,
                totalRows: tabData.data.length
            }
        ) as ExportProgressEvent;

        await this.post(progressEvent);

        // Generate export file
        const filePath = await this.generateExportFile(format, tabData.data, tabData.columns, updatedOptions);

        // Emit completion progress
        const completeProgressEvent = createEventMessage(
            ConsoleMessageTypes.EXPORT_PROGRESS,
            'file-operation',
            'medium',
            {
                format,
                progress: 100,
                rowsProcessed: tabData.data.length,
                totalRows: tabData.data.length
            }
        ) as ExportProgressEvent;

        await this.post(completeProgressEvent);

        // Send export complete message to webview (retry mechanism for connection timeouts)
        try {
            // Send message multiple times with delays to ensure delivery even if connection is recovering
            for (let attempt = 1; attempt <= 3; attempt++) {
                await this.post({
                    type: ConsoleMessageTypes.EXPORT_COMPLETE,
                    correlationId: message.correlationId,
                    source: 'extension' as const,
                    target: 'webview' as const,
                    timestamp: Date.now(),
                    payload: {
                        filePath,
                        format,
                        rowCount: tabData.data.length,
                        success: true,
                        attempt
                    }
                });

                // Small delay between attempts
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        } catch (error) {
            console.error('Error sending export_complete message:', error);
        }

        // Show notification AFTER sending message
        await this.showExportSuccessNotification(filePath, format, tabData.data.length, updatedOptions.arrayWarning);

        const exportResponse = createResponseMessage(
            message.correlationId,
            true,
            {
                filePath,
                format,
                rowCount: tabData.data.length,
                success: true
            }
        ) as ExportCompleteResponse;
        exportResponse.type = ConsoleMessageTypes.EXPORT_COMPLETE;
        return exportResponse;
    }

    /**
     * Handle Excel multi-sheet export (Input, Success, Errors)
     * Filename: {executionId}.xlsx
     */
    private async handleExcelMultiSheetExport(
        message: ExportDataRequest,
        executionId: string
    ): Promise<ExportCompleteResponse> {
        const { options = {} } = message.payload as any;

        // One sheet per tab. The current tab's sheet is what the user is looking at — their
        // columns (#155), row basis (#200), in-memory view (#229) and search filter — the
        // other two are exported whole. excelSheetExtractions() decides; it is unit-tested,
        // because this branch once forgot the filter and the view while CSV remembered them.
        const sheets: any[] = [];
        let totalRows = 0;
        for (const sheet of excelSheetExtractions(message.payload as ExportRequestPayload)) {
            const tabData = await this.extractTabData(sheet.tab, sheet.visibleColumnIds, sheet.overridePath, sheet.searchTerm, sheet.view, sheet.inputStatusFilter);
            if (tabData && tabData.data.length > 0) {
                sheets.push({ sheetName: sheet.sheetName, data: tabData.data, columns: tabData.columns });
                totalRows += tabData.data.length;
            }
        }

        if (sheets.length === 0) {
            throw new Error('No data available to export');
        }

        // GitHub Issue #200: Backend safety net — prevent OOM from Excel export exceeding cell limit
        const EXCEL_CELL_LIMIT = 2_000_000;
        const totalCells = sheets.reduce((sum, s) => sum + (s.data.length * s.columns.length), 0);
        if (totalCells > EXCEL_CELL_LIMIT) {
            this.log(`[Excel] Cell count ${totalCells.toLocaleString()} exceeds limit ${EXCEL_CELL_LIMIT.toLocaleString()}, blocking export`);
            await this.post({
                type: 'showNotification',
                payload: {
                    level: 'warning',
                    message: `Excel limit exceeded (${totalCells.toLocaleString()} cells). Use CSV export for unlimited rows.`
                }
            });
            throw new Error(`Excel export cancelled: ${totalCells.toLocaleString()} cells exceeds ${EXCEL_CELL_LIMIT.toLocaleString()} cell limit. Use CSV export instead.`);
        }

        // Show save dialog
        const defaultFileName = `${executionId}`;

        const saveTarget = await this.ports.files.chooseSaveTarget(`${defaultFileName}.xlsx`, this.getFileFilters('excel'), 'Save Excel Export');

        if (!saveTarget) {
            return createErrorResponseMessage(
                message.correlationId,
                new Error('Export cancelled by user'),
                'EXPORT_CANCELLED'
            ) as ExportCompleteResponse;
        }

        // Prepare options
        const updatedOptions = {
            ...options,
            targetUri: saveTarget,
            hierarchical: true,
            includeHeaders: true
        };

        // Send EXPORT_STARTED message to webview (to show overlay with filename)
        const filename = path.basename(saveTarget);
        await this.post({
            type: ConsoleMessageTypes.EXPORT_STARTED,
            correlationId: message.correlationId,
            source: 'extension' as const,
            target: 'webview' as const,
            timestamp: Date.now(),
            payload: {
                filename,
                format: 'excel',
                rowCount: totalRows
            }
        });

        // Emit export progress event
        const progressEvent = createEventMessage(
            ConsoleMessageTypes.EXPORT_PROGRESS,
            'file-operation',
            'medium',
            {
                format: 'excel',
                progress: 0,
                rowsProcessed: 0,
                totalRows: totalRows
            }
        ) as ExportProgressEvent;

        await this.post(progressEvent);

        // Generate multi-sheet Excel file
        const filePath = await this.exportService.exportToExcelMultiSheet(sheets, updatedOptions);

        // Emit completion progress
        const completeProgressEvent = createEventMessage(
            ConsoleMessageTypes.EXPORT_PROGRESS,
            'file-operation',
            'medium',
            {
                format: 'excel',
                progress: 100,
                rowsProcessed: totalRows,
                totalRows: totalRows
            }
        ) as ExportProgressEvent;

        await this.post(completeProgressEvent);

        // Send export complete message to webview (retry mechanism for connection timeouts)
        try {
            // Send message multiple times with delays to ensure delivery even if connection is recovering
            for (let attempt = 1; attempt <= 3; attempt++) {
                await this.post({
                    type: ConsoleMessageTypes.EXPORT_COMPLETE,
                    correlationId: message.correlationId,
                    source: 'extension' as const,
                    target: 'webview' as const,
                    timestamp: Date.now(),
                    payload: {
                        filePath,
                        format: 'excel',
                        rowCount: totalRows,
                        success: true,
                        attempt
                    }
                });

                // Small delay between attempts
                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        } catch (error) {
            console.error('Error sending export_complete message:', error);
        }

        // Show notification AFTER sending message
        await this.showExportSuccessNotification(filePath, 'excel', totalRows);

        const exportResponse = createResponseMessage(
            message.correlationId,
            true,
            {
                filePath,
                format: 'excel',
                rowCount: totalRows,
                success: true
            }
        ) as ExportCompleteResponse;
        exportResponse.type = ConsoleMessageTypes.EXPORT_COMPLETE;
        return exportResponse;
    }

    /** Issue #229 / #237 / #298: the endpoint's saved Views, shared with Compare. */
    private get viewsStore(): ConsoleViewsStore {
        this._viewsStore ??= new ConsoleViewsStore({ state: this.ports.state, endpoints: this.ports.endpoints, log: m => this.log(m) });
        return this._viewsStore;
    }
    private _viewsStore: ConsoleViewsStore | undefined;

    private loadConsoleViews(endpointId: string): Promise<Record<string, unknown> | null> {
        return this.viewsStore.load(endpointId);
    }

    /**
     * A View that Reporting reads (a saved query or compare) keeps its columns, row basis and
     * name: a save that takes one away is put back, the page is shown the View as it stays, and
     * the user is told why.
     */
    private async keepQueryViews(endpointId: string, settings: unknown): Promise<unknown> {
        const request = await this.viewsStore.resolveScopeKey(endpointId);
        const locked = [...new Set([
            ...Object.keys(viewsInQueries(this.ports.state, { endpointId, request })),
            ...Object.keys(viewsInCompares(this.ports.state, endpointId)),
        ])];
        if (!locked.length) return settings;
        const kept = keepLockedViews(await this.loadConsoleViews(endpointId), settings, locked);
        if (!kept.reverted.length) return settings;
        this.ports.toast.warn(`${kept.reverted.join(', ')} is used in Reporting, so it can only gain columns. Save it as a new view to change it.`);
        await this.post({ type: 'REPORT_SETTINGS_LOADED', correlationId: `settings_loaded_${Date.now()}`, source: 'extension' as const, target: 'webview' as const, timestamp: Date.now(), endpointId, settings: kept.settings });
        return kept.settings;
    }

    private saveConsoleViews(endpointId: string, views: unknown): Promise<void> {
        return this.viewsStore.save(endpointId, views);
    }

    /**
     * Issue #304: input rows with the Result column the Input tab shows (the
     * status of the transaction that sent each row), filtered to one status.
     * Unchanged when the batch records no row ranges — the tab shows none then.
     */
    private async inputRecordsWithStatus(inputData: any[], filter?: string): Promise<any[]> {
        const batchId = this.currentConfig?.batchId;
        const metadataService = this.ports.metadata;
        if (!batchId || !metadataService || inputData.length === 0) {
            return inputData;
        }
        const members = await metadataService.getBatchMemberExecutions(batchId);
        const transactions = members.map(m => ({ key: m.id, rowStart: m.rowStart, rows: m.rows, status: m.status }));
        if (!transactions.some(t => t.rowStart !== undefined && t.rowStart !== null)) {
            return inputData;
        }
        const { status } = InputRowStatus.rowStatuses(inputData.length, transactions);
        return InputRowStatus.annotate(inputData, status, filter || 'all', InputRowStatus.columnId(inputData[0])).records;
    }

    /**
     * Extract and format data for a specific tab
     * Returns null if tab has no data
     * @param tab - The tab to extract data from
     * @param visibleColumnIds - GitHub Issue #155: Optional array of column IDs to include (from frontend)
     */
    private async extractTabData(tab: 'input' | 'success' | 'errors', visibleColumnIds?: string[] | null, overridePath?: string, searchTerm?: string, explicitView?: any, inputStatusFilter?: string): Promise<{
        data: any[];
        columns: ColumnDefinition[];
        currentPath: string;
    } | null> {
        if (!this.loadedRawData || !this.currentConfig) {
            return null;
        }

        // GitHub Issue #229: view-driven export pipeline. Uses the same
        // extractRowsForView + flattenNestedForExport shared utilities the
        // webview renders from, so CSV/Excel output matches the table.

        // Step 1: Resolve the active view. The frontend passes its in-memory
        // view directly (export-time source of truth). Falls back to the
        // persisted view on the endpoint, then a synthesized Root view —
        // covers the case where an old execution's endpoint no longer exists.
        let activeView: any = null;
        if (explicitView && Array.isArray(explicitView.columns)) {
            activeView = explicitView;
        } else {
            const consoleViews = await this.loadConsoleViews(this.currentConfig.endpointId!);
            if (tab !== 'input' && consoleViews && (consoleViews as any)[tab]) {
                const tabSettings = (consoleViews as any)[tab];
                if (Array.isArray(tabSettings.views) && tabSettings.views.length > 0) {
                    activeView = tabSettings.views.find((v: any) => v.name === tabSettings.activeView) || tabSettings.views[0];
                }
            }
        }

        // Step 2: Get raw data for the requested tab.
        let rawDataForTab: any[];
        if (tab === 'input') {
            rawDataForTab = await this.inputRecordsWithStatus(this.loadedRawData.inputData || [], inputStatusFilter);
        } else {
            const classified = this.responseDataExtractor.classifyResponses(this.loadedRawData.responses);
            rawDataForTab = classified[tab] || [];
        }

        if (rawDataForTab.length === 0) {
            return null;
        }

        // If no saved view (input tab, or first-time endpoint), synthesize a
        // Root view from the first response's top-level scalar fields.
        if (!activeView) {
            activeView = this.synthesizeRootView(rawDataForTab);
        }

        // Allow frontend to override the row basis via overridePath (legacy call
        // path). If provided, shallow-clone the view with the new rowBasis so we
        // don't mutate persisted state.
        if (overridePath && activeView.rowBasis !== overridePath) {
            activeView = { ...activeView, rowBasis: overridePath };
        }

        // Step 3: Extract rows. Phase 1B.19: no separate flatten step — the
        // row's expand-cell arrays travel as raw arrays on the wrapper id
        // and the export adapter (Step 4) terminates at the wrapper, so
        // shape stays in sync with the on-screen render. Users wanting flat
        // rows change rowBasis (Set as Row), which is the natural denormal-
        // isation lever the views model already provides.
        let rows = this.responseDataExtractor.extractRowsForView(rawDataForTab, activeView);

        if (rows.length === 0) {
            return null;
        }

        // Step 4: Build the flat export column list from the view tree.
        // Sample-aware so mis-tagged-array wrappers don't slip through.
        let exportColumns = this.viewColumnsAsExportColumns(activeView, rawDataForTab[0]);

        // Step 5: visibleColumnIds override (GitHub Issue #155) — the frontend's
        // explicit subset wins over the saved view if supplied.
        if (visibleColumnIds && visibleColumnIds.length > 0) {
            exportColumns = exportColumns.filter(col => visibleColumnIds.includes(col.id));
        }

        // Step 5b (#428): the Error tab shows a Reason column first, whatever its View, and its
        // search reads it; the page's visible columns are the View's, so it is added here, before
        // the search, as the tab adds it (2026-11-24: an export writes what the tab shows).
        if (tab === 'errors') {
            exportColumns = ConsoleErrorReason.withReasonColumn(rows, exportColumns) as ColumnDefinition[];
        }

        // Step 6: Apply search filter (GitHub Issue #227) against the flat rows.
        if (searchTerm && searchTerm.trim() !== '') {
            const parsedTerms = parseSearchExpression(searchTerm);
            const beforeCount = rows.length;
            rows = rows.filter((row: Record<string, unknown>) => {
                return matchesRow(parsedTerms, row, exportColumns, (r: Record<string, unknown>, colId: string) => this.extractNestedValue(r, colId));
            });
            this.log(`[extractTabData] searchTerm="${searchTerm}" filtered ${beforeCount} → ${rows.length} rows`);
            if (rows.length === 0) {
                return null;
            }
        }

        // Step 7: Build flat rows for export using the view's column order.
        // Issue #239 (reopen): pass raw values through. The display formatter
        // renders arrays as "[N items]", which is right for the on-screen grid
        // but wrong for clipboard/CSV/Excel/SQL — those need the actual values.
        // Each per-format formatter in ConsoleExportService handles its own
        // serialisation (comma-join for primitive arrays, JSON for objects,
        // native arrays for JSON export, etc.).
        const tableData = rows.map((row: Record<string, unknown>) => {
            const flatRow: Record<string, any> = {};
            exportColumns.forEach((column: ColumnDefinition) => {
                flatRow[column.id] = this.extractNestedValue(row, column.id);
            });
            return flatRow;
        });

        return {
            data: tableData,
            columns: exportColumns,
            currentPath: activeView.rowBasis || 'root'
        };
    }

    /**
     * Issue #248: load the names of `{{template variables}}` referenced by the
     * endpoint's body / path / headers / queryParams. Skips `A8:` and `ENV:`
     * variables (those don't come from the input CSV). Returns an empty array
     * when there's no endpoint or no variables — caller treats empty as "no
     * Mapped Columns view, just show All Columns".
     */
    private async loadMappedVariableNames(endpointId: string | undefined): Promise<string[]> {
        if (!endpointId) return [];
        const endpointManager = this.ports.endpoints;
        if (!endpointManager) return [];
        let endpoint: APIEndpointConfig | undefined;
        try {
            endpoint = await endpointManager.getEndpoint(endpointId);
        } catch {
            return [];
        }
        if (!endpoint) return [];

        // Issue #247: the same rule ranks Chain targets — one implementation.
        return endpointInputVariableNames(endpoint);
    }

    /**
     * GitHub Issue #229: Synthesize a Root view on the fly when no saved view
     * exists (input tab, brand-new endpoint). Pulls top-level scalar fields
     * from the first response so exports have something meaningful.
     */
    private synthesizeRootView(rawDataForTab: any[]): any {
        const first = rawDataForTab[0];
        const cols: Array<{ id: string; source: 'current' }> = [];
        if (first && typeof first === 'object') {
            for (const key of Object.keys(first)) {
                const v = (first as Record<string, unknown>)[key];
                if (v === null || v === undefined) continue;
                const t = typeof v;
                if (t === 'string' || t === 'number' || t === 'boolean') {
                    cols.push({ id: key, source: 'current' });
                }
            }
        }
        return { name: 'Root', rowBasis: 'root', columns: cols, isAutoGenerated: true };
    }

    /**
     * GitHub Issue #229: Flatten a view's recursive column tree into a flat
     * ColumnDefinition list suitable for tabular export. Nested groups are
     * traversed (their children become export leaves); ancestor and current
     * columns are leaves directly.
     */
    private viewColumnsAsExportColumns(view: any, sampleResponse?: unknown): ColumnDefinition[] {
        const out: ColumnDefinition[] = [];
        const rowBasis = view.rowBasis || 'root';
        const isInsideRow = (id: string): boolean => {
            if (rowBasis === 'root') return true;
            return id === rowBasis || id.startsWith(rowBasis + '.');
        };
        const isAtOrAboveBasis = (id: string): boolean => {
            if (rowBasis === 'root') return false;
            if (id === rowBasis) return true;
            return rowBasis.startsWith(id + '.');
        };
        // Phase 1B.19: terminate at inside-row nested+array wrappers — emit
        // the wrapper itself as one export column. Mirrors viewToLegacy-
        // ColumnShape's expand-cell rule so CSV/clipboard output matches the
        // on-screen "▼ N records" cell. Issue #239 (reopen): the cell value
        // is now the raw array; export formatters serialise it per-format
        // (comma-join for primitive arrays, JSON for object arrays).
        const isReallyArray = (col: any): boolean => {
            if (col.groupType !== 'array') return false;
            if (!sampleResponse) return true;
            const kind = (this.responseDataExtractor as any).classifyStructuralKind
                ? (this.responseDataExtractor as any).classifyStructuralKind(sampleResponse, col.id)
                : ((this.tableBuilder as any).classifyStructuralKind?.(sampleResponse, col.id));
            return kind === 'array';
        };
        const walk = (cols: any[]): void => {
            for (const col of (cols || [])) {
                if (!col || !col.id) continue;
                const segs = String(col.id).split('.');
                const lastName = segs[segs.length - 1];
                if (col.source === 'nested') {
                    if (isAtOrAboveBasis(col.id)) {
                        // At or above rowBasis — collapse, recurse children.
                        walk(col.children || []);
                        continue;
                    }
                    if (isInsideRow(col.id) && isReallyArray(col)) {
                        // Genuine expand-cell array inside the row — emit as
                        // a single column; the row carries the raw array at
                        // this id and the export formatters comma-join it.
                        out.push({
                            id: col.id,
                            name: lastName,
                            type: 'string',
                            sortable: false,
                            filterable: false
                        });
                        continue;
                    }
                    // Object wrapper or mis-tagged array — collapse, recurse.
                    walk(col.children || []);
                } else {
                    out.push({
                        id: col.id,
                        name: lastName,
                        type: 'string',
                        sortable: true,
                        filterable: true
                    });
                }
            }
        };
        walk(view.columns || []);
        // Same header rule as the table on screen: leaf names, paths where leaves collide.
        return (this.tableBuilder as any).disambiguateColumnNames(out, rowBasis);
    }

    /**
     * Handle update view state request
     */
    private async handleUpdateViewState(message: UpdateViewStateRequest): Promise<ResponseMessage> {
        const viewState = message.payload;

        try {
            // Store view state for future use

            return createResponseMessage(
                message.correlationId,
                true,
                { updated: true, viewState }
            );

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'VIEW_STATE_UPDATE_FAILED'
            );
        }
    }

    /**
     * Handle change tab request
     */
    private async handleChangeTab(message: ChangeTabRequest): Promise<ResponseMessage> {
        const { tab, config } = message.payload;

        try {

            // Update tabbed data configuration if provided
            if (this.loadedTabbedData && config) {
                // The frontend will handle the actual tab switching
            }

            return createResponseMessage(
                message.correlationId,
                true,
                { tab, updated: true }
            );

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'TAB_CHANGE_FAILED'
            );
        }
    }

    /**
     * Handle change root path request
     */
    private async handleChangeRootPath(message: ChangeRootPathRequest): Promise<ResponseMessage> {
        const { tab, rootPath, refreshData } = message.payload;

        try {

            return createResponseMessage(
                message.correlationId,
                true,
                { tab, rootPath, updated: true }
            );

        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'ROOT_PATH_CHANGE_FAILED'
            );
        }
    }

    /**
     * Handle executeCommand message from footer action buttons
     */
    /**
     * Console footer action: pause a running batch.
     * Ported from the former `dbmn.pauseBatch` command.
     */
    private async handlePauseBatch(message: BaseMessage): Promise<ResponseMessage> {
        const item = message.payload as any;
        try {
            const batchExecutionEngine = this.ports.batchEngine;
            if (!batchExecutionEngine) {
                console.error('[PauseBatch] BatchExecutionEngine not available in container');
                throw new Error('BatchExecutionEngine not available');
            }

            const batchId = item.batchId || item.id;
            if (!batchId) {
                console.error('[PauseBatch] No batch ID found in item:', item);
                throw new Error('No batch ID found');
            }

            // Pause without prompting for reason (footer notification shown in webview)
            await batchExecutionEngine.pauseBatch(batchId, 'User requested pause');
            // Note: Footer notification "Batch is paused" is shown in the report webview

            return createResponseMessage(message.correlationId, true, { success: true, batchId });
        } catch (error) {
            console.error('[PauseBatch] Error occurred:', error);
            this.ports.toast.error(`Failed to pause batch: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'PAUSE_BATCH_FAILED'
            );
        }
    }

    /**
     * Settings tab → Configure (Issue #312): Name, Error Handling, Processing Mode.
     * Name and error mode are persisted; a thread change goes through the engine,
     * which validates against the environment's maximum, persists, updates the
     * running loops, and tells this Console (concurrency_updated). A refused
     * change is reported back the same way so the dropdown snaps to the real value.
     */
    private async handleUpdateBatchSetting(message: BaseMessage): Promise<ResponseMessage> {
        const payload = (message.payload || {}) as { batchId?: string; name?: string; stopOnFirstError?: boolean; concurrency?: number };
        const batchId = payload.batchId || this.currentConfig?.batchId || this.currentConfig?.executionId;
        try {
            if (!batchId) {
                throw new Error('No batch is open in this console');
            }
            if (message.type === 'updateBatchName') {
                const name = (payload.name || '').trim();
                if (!name) throw new Error('A batch name is required');
                const metadataService = this.ports.metadata;
                if (!metadataService) throw new Error('ExecutionMetadataService not available');
                // #445: the batch's own name; endpointName stays the endpoint's, so History still
                // knows which endpoint ran. getExecution first: the other settings are kept.
                const batch = await metadataService.getExecution(batchId);
                if (!batch) throw new Error(`Batch not found: ${batchId}`);
                await metadataService.updateExecution(batchId, {
                    batchConfiguration: {
                        stopOnFirstError: false,
                        errorTolerance: false,
                        maxErrors: 0,
                        ...batch.batchConfiguration,
                        name
                    }
                });
                this.log(`[Settings] issue#312 batch ${batchId} renamed to "${name}"`);
                return createResponseMessage(message.correlationId, true, { success: true });
            }

            const engine = this.ports.batchEngine;
            if (!engine) throw new Error('BatchExecutionEngine not available');

            if (message.type === 'updateBatchErrorMode') {
                if (typeof payload.stopOnFirstError !== 'boolean') throw new Error('stopOnFirstError is required');
                await engine.updateBatchErrorMode(batchId, { stopOnFirstError: payload.stopOnFirstError });
                this.log(`[Settings] issue#312 batch ${batchId} stopOnFirstError=${payload.stopOnFirstError}`);
                return createResponseMessage(message.correlationId, true, { success: true });
            }

            if (typeof payload.concurrency !== 'number') throw new Error('concurrency is required');
            const result = await engine.updateBatchConcurrency(batchId, payload.concurrency);
            this.log(`[Settings] issue#312 batch ${batchId} concurrency → ${payload.concurrency}: ${JSON.stringify(result)}`);
            if (!result.success) {
                this.ports.toast.warn(result.message || 'Processing mode not changed');
                // Snap the dropdown back to what the batch really runs with
                await ConsoleController.sendConcurrencyUpdate(batchId, {
                    currentConcurrency: result.currentConcurrency || 1,
                    maxConcurrency: result.maxConcurrency || 16
                });
            }
            return createResponseMessage(message.correlationId, result.success, result);
        } catch (error) {
            this.ports.toast.error(`Setting not saved: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'UPDATE_BATCH_SETTING_FAILED'
            );
        }
    }

    /**
     * Console footer action: Cancel (Issue #309). For a batch — queued,
     * preparing or running — this is the engine's cancelBatch, which also
     * ends a queue wait so the batch never starts when its turn comes. For an
     * individual execution it aborts the request in flight.
     */
    private async handleCancelExecution(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const config = this.currentConfig;
            const id = config?.batchId || config?.executionId;
            if (!id) {
                throw new Error('No execution is open in this console');
            }

            const metadataService = this.ports.metadata;
            const execution = await metadataService?.getExecution(id);
            const isBatch = config?.type === 'batch' || execution?.executionType === 'batch';

            if (isBatch) {
                const engine = this.ports.batchEngine;
                if (!engine) {
                    throw new Error('BatchExecutionEngine not available');
                }
                // #335: running, it asks first (its requests in flight are cut off)
                const status = (await engine.getBatchState(id))?.status ?? execution?.status;
                const choice = await askBeforeCancellingBatch(status, spec => this.session.showModal(spec));
                if (choice === 'keep') {
                    return createResponseMessage(message.correlationId, true, { success: false, id });
                }
                if (choice === 'pause') {
                    await engine.pauseBatch(id, 'User requested pause');
                    return createResponseMessage(message.correlationId, true, { success: true, id });
                }
                this.log(`[Cancel] issue#309 cancelling batch ${id} (status: ${status ?? 'unknown'})`);
                await engine.cancelBatch(id);
            } else {
                const cancel = this.ports.cancelExecution;
                if (!cancel) {
                    throw new Error('ExecutionService not available');
                }
                this.log(`[Cancel] issue#309 cancelling execution ${id}`);
                await cancel(id);
            }

            return createResponseMessage(message.correlationId, true, { success: true, id });
        } catch (error) {
            this.ports.toast.error(`Cancel failed: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'CANCEL_EXECUTION_FAILED'
            );
        }
    }

    /**
     * Issue #311: run the environment auth gate for a stored batch before it
     * is resumed or reprocessed. False means the user cancelled, or has to
     * finish signing in first — a toast says so and the action stops.
     */
    private async ensureBatchAuthenticated(batch: { environmentId?: string; environment?: string } | null | undefined, action: 'Resume' | 'Reprocess'): Promise<boolean> {
        if (!batch) return true;
        const gate = this.ports.authGate;
        if (!gate) {
            this.log('[AuthGate] issue#311 EnvironmentAuthGate not available — continuing unchecked');
            return true;
        }
        const ok = await gate.ensureAuthenticatedForBatch(batch);
        if (!ok) {
            this.log(`[AuthGate] issue#311 ${action} stopped at the credential check for environment "${batch.environment ?? batch.environmentId}"`);
            this.ports.toast.info(`${action} cancelled — sign in to "${batch.environment ?? 'the environment'}" and ${action.toLowerCase()} again.`);
        }
        return ok;
    }

    /**
     * Console footer action: resume a paused/stopped batch.
     * Ported from the former `dbmn.resumeBatch` command (GitHub Issue #151).
     */
    private async handleResumeBatch(message: BaseMessage): Promise<ResponseMessage> {
        const item = message.payload as any;
        try {
            const batchExecutionEngine = this.ports.batchEngine;
            if (!batchExecutionEngine) {
                console.error('[ResumeBatch] BatchExecutionEngine not available in container');
                throw new Error('BatchExecutionEngine not available');
            }

            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                console.error('[ResumeBatch] ExecutionMetadataService not available in container');
                throw new Error('ExecutionMetadataService not available');
            }

            const batchId = item.batchId || item.id;
            if (!batchId) {
                console.error('[ResumeBatch] No batch ID found in item:', item);
                throw new Error('No batch ID found');
            }

            // GitHub Issue #151, #335: the same question and steps as History's Resume (batch-resume.ts)
            const batchExecution = await executionMetadataService.getExecution(batchId);
            const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);
            const choice = await askHowToResume(batchExecution, batchMembers, spec => this.session.showModal(spec));
            if (!choice) {
                return createResponseMessage(message.correlationId, true); // User cancelled
            }

            // Issue #311: same credential gate as a fresh Run. A batch that stopped
            // because its token expired must not be resumed with that token.
            if (!(await this.ensureBatchAuthenticated(batchExecution, 'Resume'))) {
                return createResponseMessage(message.correlationId, true, { success: false, batchId, reason: 'auth' });
            }

            await applyResumeChoice(batchExecutionEngine, batchId, choice, () => ConsoleController.sendClearErrors(batchId));

            const result = await batchExecutionEngine.resumeBatch(batchId);

            // Note: resumeBatch() is long-running — it resolves only when batch finishes.
            // All status transitions are shown in the report webview via sendStatusUpdateToReport.
            // No VS Code notifications needed here (they'd appear delayed after batch completes).
            console.log(`[ResumeBatch] Batch completed with status: ${result?.status}`);

            return createResponseMessage(message.correlationId, true, { success: true, batchId });
        } catch (error) {
            console.error('[ResumeBatch] Error occurred:', error);
            this.ports.toast.error(`Failed to resume batch: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'RESUME_BATCH_FAILED'
            );
        }
    }

    /**
     * Console footer action: reprocess transactions in a batch.
     * Ported from the former `dbmn.reprocessBatch` command.
     */
    private async handleReprocessBatch(message: BaseMessage): Promise<ResponseMessage> {
        const item = message.payload as any;
        try {
            const batchExecutionEngine = this.ports.batchEngine;
            if (!batchExecutionEngine) {
                console.error('[ReprocessBatch] BatchExecutionEngine not available in container');
                throw new Error('BatchExecutionEngine not available');
            }

            const batchId = item.batchId || item.id;
            if (!batchId) {
                console.error('[ReprocessBatch] No batch ID found in item:', item);
                throw new Error('No batch ID found');
            }

            // Get batch state first to validate reprocessing is allowed
            const batchState = await batchExecutionEngine.getBatchState(batchId);
            if (!batchState) {
                // Try to get from metadata service as fallback
            }

            // A paginated batch reprocesses its pages like any batch, but
            // can't be split (Issue #198) — don't offer Split.
            const metadataService = this.ports.metadata;
            const paginated = isPaginatedBatch(await metadataService?.getExecution(batchId));

            // issue#269: Select reprocess type via a DBMN modal instead of a
            // native quick-pick. (SELECTED option not shown yet - no UI for selection.)
            // #335: Reprocess is for a finished batch. An unfinished one (pending or cut-off
            // transactions, rows not yet sent) is Resumed, which also makes the rest.
            const reprocessLabels: Record<string, string> = {
                ERRORS: 'Reprocess Errors Only',
                SPLIT: 'Split Array Errors',
                ALL: 'Reprocess All'
            };

            const typeChoice = await this.session.showModal({
                title: 'Reprocess Batch',
                fields: [{
                    id: 'type',
                    type: 'radio',
                    value: 'ERRORS',
                    options: [
                        { value: 'ERRORS', label: 'Errors only', description: 'Only failed transactions' },
                        { value: 'SPLIT', label: 'Split array errors', description: 'Split failed array transactions into individual ones' },
                        { value: 'ALL', label: 'All', description: 'Every transaction (complete redo)' }
                    ].filter(opt => !(paginated && opt.value === 'SPLIT'))
                }],
                actions: [
                    { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                    { id: 'next', label: 'Continue', variant: 'primary' }
                ],
                dismissible: true,
                size: 'md'
            });

            if (typeChoice.actionId !== 'next') {
                return createResponseMessage(message.correlationId, true); // User cancelled
            }

            const type = {
                value: typeChoice.fields.type as 'ERRORS' | 'SPLIT' | 'ALL',
                label: reprocessLabels[typeChoice.fields.type] || typeChoice.fields.type
            };

            // Confirm if ALL selected (reprocess completed transactions too)
            if (type.value === 'ALL') {
                const confirm = await this.session.showModal({
                    title: 'Reprocess ALL transactions?',
                    body: 'This will reprocess ALL transactions including completed ones. Continue?',
                    actions: [
                        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                        { id: 'confirm', label: 'Reprocess All', variant: 'danger' }
                    ],
                    dismissible: true,
                    size: 'sm'
                });
                if (confirm.actionId !== 'confirm') {
                    return createResponseMessage(message.correlationId, true);
                }
            }

            // Confirm if SPLIT selected (explain array splitting)
            if (type.value === 'SPLIT') {
                const confirm = await this.session.showModal({
                    title: 'Split array errors?',
                    body: 'This will split failed array transactions into individual transactions for error isolation. Each array element will become a separate transaction. Continue?',
                    actions: [
                        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                        { id: 'confirm', label: 'Split', variant: 'primary' }
                    ],
                    dismissible: true,
                    size: 'sm'
                });
                if (confirm.actionId !== 'confirm') {
                    return createResponseMessage(message.correlationId, true);
                }
            }

            // Execute reprocess — all types now return the same batchId (in-batch)
            // Issue #311: reprocess re-runs requests — gate the credentials like Run and Resume
            if (!(await this.ensureBatchAuthenticated(await metadataService?.getExecution(batchId), 'Reprocess'))) {
                return createResponseMessage(message.correlationId, true, { success: false, batchId, reason: 'auth' });
            }

            await batchExecutionEngine.reprocessBatch(batchId, type.value);

            this.ports.toast.info(`Batch reprocessing started (${type.label})`);

            return createResponseMessage(message.correlationId, true, { success: true, batchId });
        } catch (error) {
            console.error('[ReprocessBatch] Error occurred:', error);

            // Show more specific error messages based on the error type
            let errorMessage = `Failed to reprocess batch: ${error instanceof Error ? error.message : error}`;

            if (error instanceof Error && error.message.includes('Cannot reprocess batch in')) {
                // Extract just the important part for the user
                errorMessage = error.message.split('.')[0]; // Just the first sentence
            }

            this.ports.toast.error(errorMessage);

            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'REPROCESS_BATCH_FAILED'
            );
        }
    }

    /**
     * Console footer action: re-run an individual transaction.
     * Ported from the former `dbmn.rerunTransaction` command.
     */
    private async handleRerunTransaction(message: BaseMessage): Promise<ResponseMessage> {
        const item = message.payload as any;
        try {
            const executionMetadataService = this.ports.metadata;
            const individualExecutionEngine = this.ports.individualEngine;

            if (!executionMetadataService || !individualExecutionEngine) {
                throw new Error('Required services not available');
            }

            const executionId = item.executionId || item.id;
            if (!executionId) {
                throw new Error('No execution ID found');
            }

            // Get execution metadata
            const execution = await executionMetadataService.getExecution(executionId);
            if (!execution) {
                throw new Error('Execution not found');
            }

            // Validate it's an individual transaction (not batch or batch_member)
            if (execution.executionType !== 'individual') {
                throw new Error(`Cannot re-run ${execution.executionType} executions. Only individual transactions can be re-run.`);
            }

            // Check current status - must be completed, error, or cancelled
            const allowedStatuses = ['completed', 'error', 'cancelled'];
            if (!allowedStatuses.includes(execution.status)) {
                throw new Error(`Cannot re-run transaction in '${execution.status}' status. Transaction must be completed, error, or cancelled.`);
            }

            // No progress notification — the console webview reflects the
            // transaction's status live via metadata updates (pending → running
            // → completed), which is the state the user's already watching.
            // A native vscode.window.withProgress overlay on top would be
            // duplicate chrome and the last vscode.window UI call in this
            // manager. Success/error toasts below cover the terminal state.
            await executionMetadataService.updateExecution(executionId, {
                status: 'pending',
                errorMessage: undefined,
                completedAt: undefined
            });
            await individualExecutionEngine.executeIndividual(executionId);

            this.ports.toast.info(`Transaction re-run completed successfully`);

            return createResponseMessage(message.correlationId, true, { success: true, executionId });
        } catch (error) {
            console.error('Failed to re-run transaction:', error);
            this.ports.toast.error(`Failed to re-run transaction: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'RERUN_TRANSACTION_FAILED'
            );
        }
    }

    /** The host's own confirmation (VS Code's panel), or a DbmnModal in the Console. */
    private async confirmDelete(data: DeleteConfirmation): Promise<{ confirmed: boolean; dontAskAgain: boolean }> {
        if (this.ports.host.confirmDelete) {
            return this.ports.host.confirmDelete(data);
        }
        const shown = data.filesToDelete.slice(0, 8).map(f => `• ${f}`).join('\n');
        const more = data.filesToDelete.length > 8 ? `\n…and ${data.filesToDelete.length - 8} more` : '';
        const result = await this.session.showModal({
            title: `Delete ${data.executionLabel}?`,
            body: `${data.message}${shown ? `\n\n${shown}${more}` : ''}`,
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'always', label: "Delete, don't ask again", variant: 'secondary' },
                { id: 'confirm', label: 'Delete', variant: 'danger' }
            ],
            dismissible: true,
            size: 'sm'
        });
        return { confirmed: result.actionId === 'confirm' || result.actionId === 'always', dontAskAgain: result.actionId === 'always' };
    }

    /**
     * Console footer action: delete an individual transaction or batch.
     * Ported from the former `dbmn.deleteTransaction` command. On success the
     * console webview is closed (Issue #265 / #217).
     */
    private async handleDeleteTransaction(message: BaseMessage): Promise<ResponseMessage> {
        const item = message.payload as any;
        try {
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            const executionId = item.executionId || item.id;
            if (!executionId) {
                throw new Error('No execution ID found');
            }

            // Get execution metadata
            let execution = await executionMetadataService.getExecution(executionId);

            // If this is marked as a batch in the tree but the execution says individual,
            // trust the tree data and override the execution type
            if (item.isBatch && execution && execution.executionType === 'individual') {
                execution.executionType = 'batch';
                execution.batchId = execution.id; // For batch parents, id === batchId
            }

            if (!execution) {
                throw new Error('Execution not found after all lookup attempts');
            }

            // Check configuration - skip confirmation if disabled
            const confirmDeletion = this.ports.settings.get('dbmn', 'ui.confirmTransactionDeletion', true);

            let shouldDelete = true;
            let updateConfig = false;

            if (confirmDeletion) {
                const isBatchParent = execution.executionType === 'batch';
                const executionType = execution.executionType || 'execution';
                const label = item.label || executionId;

                // Prepare files list
                const filesToDelete: string[] = [];

                if (isBatchParent) {
                    // For batch deletion, get all batch member files
                    try {
                        const batchId = execution.batchId || executionId;
                        const batchExecutions = await executionMetadataService.getExecutionsByBatch(batchId);

                        // Collect all files from batch members
                        for (const batchExecution of batchExecutions) {
                            if (batchExecution.requestFile) {
                                filesToDelete.push(batchExecution.requestFile);
                            }
                            if (batchExecution.responseFile) {
                                filesToDelete.push(batchExecution.responseFile);
                            }
                        }

                        // The batch folder: where its members' files are
                        const memberFile = batchExecutions.find(m => m.requestFile)?.requestFile;
                        if (memberFile) {
                            filesToDelete.push(`${path.dirname(memberFile)}/ (batch folder)`);
                        }
                    } catch (error) {
                        console.warn('Failed to get batch execution files for confirmation:', error);
                        // Fallback to just showing the main batch files
                        if (execution.requestFile) {
                            filesToDelete.push(execution.requestFile);
                        }
                        if (execution.responseFile) {
                            filesToDelete.push(execution.responseFile);
                        }
                    }
                } else {
                    // Individual execution files
                    if (execution.requestFile) {
                        filesToDelete.push(execution.requestFile);
                    }
                    if (execution.responseFile) {
                        filesToDelete.push(execution.responseFile);
                    }
                }

                const confirmationData: DeleteConfirmation = {
                    message: isBatchParent
                        ? `Are you sure you want to delete this ${executionType}?\n\nThis will permanently delete ALL batch executions, associated files, and the batch folder.`
                        : `Are you sure you want to delete this ${executionType}?`,
                    executionLabel: label,
                    executionType: executionType,
                    executionId: executionId,
                    filesToDelete: filesToDelete
                };

                const response = await this.confirmDelete(confirmationData);
                shouldDelete = response.confirmed;
                updateConfig = response.dontAskAgain;
                if (updateConfig) {
                    await this.ports.settings.update('dbmn', 'ui.confirmTransactionDeletion', false);
                }
            }

            if (shouldDelete) {
                const isBatchParent = execution.executionType === 'batch';

                if (isBatchParent) {
                    // BATCH DELETION LOGIC
                    const batchId = execution.batchId || executionId;
                    let deletionErrors: string[] = [];

                    try {
                        // 1. Delete batch folder and all its contents first
                        try {
                            // Determine batch folder from parent's requestFile, or fall back to a member's requestFile
                            let requestFilePath = execution.requestFile;
                            if (!requestFilePath) {
                                const members = await executionMetadataService.getBatchMemberExecutions(batchId);
                                const memberWithFile = members.find((m: ExecutionMetadata) => m.requestFile);
                                if (memberWithFile) {
                                    // Member requestFile is inside the batch folder, go up one level
                                    requestFilePath = memberWithFile.requestFile;
                                }
                            }

                            if (requestFilePath) {
                                const batchFolder = path.dirname(requestFilePath);
                                await fs.promises.rm(batchFolder, { recursive: true, force: true });
                                if (fs.existsSync(batchFolder)) {
                                    deletionErrors.push(`Batch folder still exists after deletion attempt`);
                                }
                            } else {
                                // No files found — folder may not exist (e.g., old batch with no files)
                                console.warn(`[DeleteTransaction] No requestFile found for batch ${batchId} — skipping folder deletion`);
                            }
                        } catch (folderError) {
                            const errorMsg = `Failed to delete batch folder: ${folderError instanceof Error ? folderError.message : folderError}`;
                            console.error(`[DeleteTransaction] ${errorMsg}`);
                            deletionErrors.push(errorMsg);
                        }

                        // 2. Delete all execution metadata records (single query)
                        const deleteSuccess = await executionMetadataService.deleteBatch(batchId);
                        if (!deleteSuccess) {
                            deletionErrors.push('Failed to delete batch execution metadata');
                        }

                        // 3. GitHub Issue #217: Close any open Console webview for this batch
                        if (deleteSuccess) {
                            ConsoleController.closeConsoleForExecution(batchId);
                        }

                        // 4. Show results to user
                        if (deletionErrors.length === 0) {
                            this.ports.toast.info(`Batch deleted successfully`);
                        } else {
                            this.ports.toast.error(`Batch deletion had errors: ${deletionErrors.join(', ')}`);
                        }

                    } catch (batchError) {
                        this.ports.toast.error(`Failed to delete batch: ${batchError instanceof Error ? batchError.message : batchError}`);
                    }

                } else {
                    // INDIVIDUAL EXECUTION DELETION LOGIC (existing)
                    const filesToDelete: string[] = [];
                    if (execution.requestFile) {
                        filesToDelete.push(execution.requestFile);
                    }
                    if (execution.responseFile) {
                        filesToDelete.push(execution.responseFile);
                    }

                    // Delete files (with better error handling)
                    let deletedFiles = 0;
                    let failedFiles = 0;
                    for (const filePath of filesToDelete) {
                        try {
                            // A file already gone is fine
                            if (runFileExists(filePath)) {
                                removeRunFile(filePath);
                                deletedFiles++;
                            }
                        } catch (fileError) {
                            failedFiles++;
                        }
                    }

                    // Delete the execution metadata
                    const success = await executionMetadataService.deleteExecution(executionId);
                    if (success) {
                        // GitHub Issue #217: Close any open Console webview for this execution
                        ConsoleController.closeConsoleForExecution(executionId);

                        const executionType = execution.executionType || 'execution';
                        const fileMessage = deletedFiles > 0 ? ` and ${deletedFiles} file(s)` : '';
                        const warningMessage = failedFiles > 0 ? ` (${failedFiles} files could not be deleted)` : '';
                        this.ports.toast.info(`${executionType}${fileMessage} deleted successfully${warningMessage}`);
                    } else {
                        const executionType = execution.executionType || 'execution';
                        this.ports.toast.error(`Failed to delete ${executionType}`);
                    }
                }

                // The run is gone: its tab closes (Issue #265)
                this.ports.host.close();
                return undefined as never;
            }

            // User cancelled the confirmation — no-op success
            return createResponseMessage(message.correlationId, true, { success: true, cancelled: true });
        } catch (error) {
            this.ports.toast.error(`Failed to delete transaction: ${error instanceof Error ? error.message : error}`);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'DELETE_TRANSACTION_FAILED'
            );
        }
    }

    // (Copy batch removed from the Console — old, untested, not Hub-aware. The batch-copy
    // service and webview remain for a future, Hub-native version.)

    /**
     * GitHub Issue #151: Handle view original batch request
     * Opens the transaction report for the batch that this batch was reprocessed from
     */
    private async handleViewOriginalBatch(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const { batchId } = message.payload as { batchId: string };

            this.log(`Handling viewOriginalBatch request for batch ${batchId}`);

            // Open the original batch report using the VS Code command
            await this.ports.host.openConsole(batchId, true);

            return createResponseMessage(
                message.correlationId,
                true,
                { success: true, batchId }
            );
        } catch (error) {
            this.logError('Failed to view original batch', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'VIEW_ORIGINAL_BATCH_FAILED'
            );
        }
    }

    /**
     * Handle per-card retry: reprocess a single member in-batch. An individual
     * transaction has no batch to reprocess in, so it is re-run in place.
     */
    private async handleRetryMember(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const { executionId, batchId } = message.payload as { executionId: string; batchId: string };

            this.log(`Handling retryMember request: executionId=${executionId}, batchId=${batchId}`);

            if (!batchId) {
                return this.handleRerunTransaction({ ...message, payload: { executionId } });
            }

            const batchEngine = (this.ports.batchEngine as unknown) as { reprocessMembersInBatch(batchId: string, memberIds: string[]): Promise<number> } | undefined;
            if (!batchEngine) {
                throw new Error('BatchExecutionEngine not available');
            }

            const membersReset = await batchEngine.reprocessMembersInBatch(batchId, [executionId]);

            return createResponseMessage(
                message.correlationId,
                true,
                { success: true, membersReset }
            );
        } catch (error) {
            this.logError('Failed to retry member', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'RETRY_MEMBER_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #94/198: Handle fetch next page request for paginated batches
     * Creates a new batch_member with the next page number using standard handler
     */
    /** #446: batches already warned that their API sends fewer per page than asked. */
    private warnedPageSize = new Set<string>();

    /**
     * #446: the page size the pages after the first ask for. From the first page's response: when
     * the API sent fewer per page than asked (asked for 2,000, it sends 500), ask for what it sends,
     * so an API that works out a page's first row from the size asked for doesn't skip rows. Warns
     * once per batch. Undefined (the template's size) when the API sends what was asked.
     */
    private pageSizeToAsk(batchId: string, endpoint: APIEndpointConfig, members: ReadonlyArray<{ status: string; responseFile?: string; createdAt: Date }>): number | undefined {
        const first = members
            .filter(m => String(m.status).toLowerCase() === 'completed' && m.responseFile)
            .sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime())[0];
        const text = first?.responseFile ? readRunFileIfExists(first.responseFile) : undefined;
        if (!text) return undefined;
        let body: unknown;
        try { body = (JSON.parse(text) as { data?: unknown })?.data; } catch { return undefined; }
        const sizes = new PaginationDetectorService().sizeToAsk(endpoint, body);
        if (!sizes) return undefined;
        if (!this.warnedPageSize.has(batchId)) {
            this.warnedPageSize.add(batchId);
            this.ports.toast.warn(`This API sends ${sizes.sent.toLocaleString()} a page, not the ${sizes.asked.toLocaleString()} asked for. Fetching ${sizes.sent.toLocaleString()} a page.`);
        }
        this.log(`[Pagination] #446 the API sends ${sizes.sent} a page (asked for ${sizes.asked}): later pages ask for ${sizes.sent}`);
        return sizes.sent;
    }

    private async handleFetchNextPage(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const { batchId } = message.payload as { batchId: string };

            this.log(`Handling fetchNextPage request for batch ${batchId}`);

            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            const batchMetadata = await executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                throw new Error(`Batch ${batchId} not found`);
            }

            const endpoint = batchMetadata.endpointConfig;
            if (!endpoint) {
                throw new Error(`No endpoint configuration found for batch ${batchId}`);
            }

            const paginationDetector = new PaginationDetectorService();
            const paginationConfig = paginationDetector.detectPagination(endpoint);

            if (!paginationConfig.enabled) {
                throw new Error(`Batch ${batchId} does not have pagination enabled`);
            }

            this.log(`Pagination detected: ${paginationConfig.paramKey} starting at ${paginationConfig.startValue}`);

            // Find the current highest page number from existing batch_members
            const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);

            let currentHighestPage: number;
            if (paginationConfig.location === 'body') {
                // GitHub Issue #245: page lives in the body, not requestQueryParams.
                // Paginated members are created one-per-sequential-page, so the
                // highest page is startValue + (member count - 1).
                currentHighestPage = paginationConfig.startValue + batchMembers.length - 1;
            } else {
                currentHighestPage = paginationConfig.startValue - 1;
                for (const member of batchMembers) {
                    if (member.requestQueryParams) {
                        const pageValue = member.requestQueryParams[paginationConfig.paramKey];
                        if (pageValue) {
                            const pageNumber = parseInt(pageValue, 10);
                            if (!isNaN(pageNumber) && pageNumber > currentHighestPage) {
                                currentHighestPage = pageNumber;
                            }
                        }
                    }
                }
            }

            const nextPage = currentHighestPage + 1;
            this.log(`Creating next page batch_member: page ${nextPage} (current highest: ${currentHighestPage})`);

            // Get workspace root
            let workspaceRoot = batchMetadata.requestFile ? path.dirname(batchMetadata.requestFile) : '';
            if (!workspaceRoot && batchMembers.length > 0 && batchMembers[0].requestFile) {
                workspaceRoot = path.dirname(batchMembers[0].requestFile);
            }
            if (!workspaceRoot) {
                throw new Error('Could not determine batch folder location');
            }

            // Create single member using standard handler

            const transactionCreator = this.ports.transactionCreator;
            const endpointManager = this.ports.endpoints;
            if (!transactionCreator || !endpointManager) {
                throw new Error('Required services not available');
            }

            // GitHub Issue #245: Resolve the next page in the body or query params.
            // #446: the page size the API sends, when it sends fewer than asked
            const nextPageSize = this.pageSizeToAsk(batchId, endpoint, batchMembers);
            let pagedEndpoint;
            if (paginationConfig.location === 'body') {
                const updatedBody = paginationDetector.replacePaginationInBody(endpoint.body || '', nextPage, nextPageSize);
                pagedEndpoint = { ...endpoint, body: updatedBody };
            } else {
                const updatedQueryParams = paginationDetector.replacePaginationTemplate(
                    endpoint.queryParams || {}, paginationConfig, nextPage, nextPageSize
                );
                pagedEndpoint = { ...endpoint, queryParams: updatedQueryParams };
            }

            const batchMemberHandler = new BatchMemberTransactionHandler(
                transactionCreator, new PathGeneratorHelper(), new TemplateParser(), new JsonGenerator(endpointManager)
            );

            const memberResult = await batchMemberHandler.createTransaction({
                endpoint: pagedEndpoint,
                environment: batchMetadata.environment,
                environmentId: batchMetadata.environmentId,
                environmentFolder: undefined,
                organization: batchMetadata.organization || '',
                workspaceRoot,
                batchId,
                csvRowData: [['page'], [String(nextPage)]],
                transactionIndex: batchMembers.length,
                rowStart: batchMembers.length + 1
            });

            this.log(`Created batch_member ${memberResult.executionId} for page ${nextPage}`);

            // Update batch rows and status
            const newTotalMembers = batchMembers.length + 1;
            await executionMetadataService.updateExecution(batchId, {
                status: 'pending',
                rows: String(newTotalMembers)
            });

            // Clear cache and start execution
            const batchExecutionEngine = (this.ports.batchEngine as unknown) as any;
            if (!batchExecutionEngine) {
                throw new Error('BatchExecutionEngine not available');
            }

            // GitHub Issue #266: do NOT clearBatchState() here — it would delete the running
            // consumer loop's state. executeBatch() is now idempotent: it refreshes totalMembers
            // and, if a loop is already draining this batch, lets that single loop pick up the
            // new page instead of starting a second loop (which broke pause).
            batchExecutionEngine.executeBatch(batchId).catch((error: unknown) => {
                this.logError(`Paginated batch execution failed for ${batchId}`, error instanceof Error ? error : new Error(String(error)));
            });

            this.log(`Started execution for paginated batch ${batchId}`);

            await this.post({
                type: 'nextPageCreated',
                batchId,
                pageNumber: nextPage,
                memberId: memberResult.executionId
            } as any);

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    success: true,
                    batchId,
                    pageNumber: nextPage,
                    memberId: memberResult.executionId,
                    message: `Page ${nextPage} batch_member created and queued for execution`
                }
            );

        } catch (error) {
            this.logError('Failed to fetch next page', error instanceof Error ? error : new Error(String(error)));

            await this.post({
                type: 'nextPageCreated'
            } as any);

            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'FETCH_NEXT_PAGE_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #94: Handle get all pages request
     * Creates all remaining pages upfront (from current highest to totalPages)
     */
    private async handleGetAllPages(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const { batchId } = message.payload as { batchId: string };
            this.log(`Handling getAllPages request for batch ${batchId}`);

            // Check if we have pagination state with totalPages
            if (!this.paginationState || !this.paginationState.totalPages) {
                throw new Error('Cannot get all pages: Total pages not yet determined. Please fetch at least one page first.');
            }

            const totalPages = this.paginationState.totalPages;

            // Get existing batch members to determine current highest page
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);

            // Find highest page number already fetched. Pages are the batch's members, in order, so
            // the count gives it for every kind of pagination (#316: with BODY pagination there are
            // no page query params, so the scan below alone found nothing, and Fetch all asked for
            // the page it already had and one past the end). The query-param scan still wins where
            // it finds a higher page.
            const paginationConfig = this.paginationState.config;
            let currentHighestPage = paginationConfig.startValue + batchMembers.length - 1;

            for (const member of batchMembers) {
                if (member.requestQueryParams) {
                    const pageValue = member.requestQueryParams[paginationConfig.paramKey];
                    if (pageValue) {
                        const pageNumber = parseInt(String(pageValue), 10);
                        if (!isNaN(pageNumber) && pageNumber > currentHighestPage) {
                            currentHighestPage = pageNumber;
                        }
                    }
                }
            }

            // Calculate range: from nextPage to last page
            const fromPage = currentHighestPage + 1;
            // toPage depends on whether pages are 0-indexed or 1-indexed
            // If startValue=0 (0-indexed): last page = totalPages - 1
            // If startValue=1 (1-indexed): last page = totalPages
            const toPage = totalPages - 1 + paginationConfig.startValue;

            if (fromPage > toPage) {
                // All pages already fetched
                return createResponseMessage(
                    message.correlationId,
                    true,
                    {
                        success: true,
                        message: 'All pages have already been fetched',
                        remainingPages: 0
                    }
                );
            }

            const remainingPages = toPage - fromPage + 1;
            this.log(`Get All Pages: Will create pages ${fromPage}-${toPage} (${remainingPages} pages remaining)`);

            // Delegate to handleGetPageRange with calculated range
            // Pass through skipConcurrencyPrompt if present (auto-triggered from initial execution)
            const { skipConcurrencyPrompt } = (message.payload as Record<string, unknown>) || {};
            const rangeMessage = {
                ...message,
                payload: {
                    batchId,
                    fromPage,
                    toPage,
                    ...(skipConcurrencyPrompt ? { skipConcurrencyPrompt: true } : {})
                }
            };

            return await this.handleGetPageRange(rangeMessage);

        } catch (error) {
            this.logError('Failed to get all pages', error instanceof Error ? error : new Error(String(error)));

            // Send error to frontend
            await this.post({
                type: 'getPagesComplete',
                success: false,
                error: error instanceof Error ? error.message : String(error)
            } as any);

            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'GET_ALL_PAGES_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #198: Handle get page range request
     * Fast creation + execute-as-you-create: creates first member, starts execution immediately,
     * then bulk-creates remaining members while execution runs in background.
     * The batch engine's consumer loop picks up new members as they appear (polls every 100ms).
     */
    private async handleGetPageRange(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const { batchId, fromPage: requestedFromPage, toPage: requestedToPage, skipConcurrencyPrompt } = message.payload as { batchId: string; fromPage: number; toPage: number; skipConcurrencyPrompt?: boolean };
            const requestedPageCount = requestedToPage - requestedFromPage + 1;

            // Get required services
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            // Get batch metadata
            const batchMetadata = await executionMetadataService.getExecution(batchId);
            if (!batchMetadata) {
                throw new Error(`Batch ${batchId} not found`);
            }

            // Get endpoint configuration
            const endpoint = batchMetadata.endpointConfig;
            if (!endpoint) {
                throw new Error('Batch does not have endpoint configuration');
            }

            // Detect pagination configuration
            const paginationDetector = new PaginationDetectorService();
            const paginationConfig = paginationDetector.detectPagination(endpoint);

            if (!paginationConfig.enabled) {
                throw new Error('Batch does not have pagination enabled');
            }

            // GitHub Issue #266: never fetch more pages into a paused/cancelled/stopped
            // batch — that would recreate members and restart execution, undoing the pause.
            // (Covers the auto-fetch-after-page path too, which funnels through here.)
            const pageRangeEngine = (this.ports.batchEngine as unknown) as { isPausing?: (id: string) => boolean } | undefined;
            if (pageRangeEngine?.isPausing?.(batchId)
                || batchMetadata.status === 'paused'
                || batchMetadata.status === 'cancelled'
                || batchMetadata.status === 'stopped') {
                this.log(`[Pagination] issue#266 Skipping page fetch — batch ${batchId} is ${batchMetadata.status} (paused). Resume to continue.`);
                return createResponseMessage(message.correlationId, true, {
                    success: false, message: 'Batch is paused — resume to continue fetching pages.'
                });
            }

            // Get workspace root from batch metadata or first member
            const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);

            let workspaceRoot = batchMetadata.requestFile ? path.dirname(batchMetadata.requestFile) : '';
            if (!workspaceRoot && batchMembers.length > 0 && batchMembers[0].requestFile) {
                workspaceRoot = path.dirname(batchMembers[0].requestFile);
            }
            if (!workspaceRoot) {
                throw new Error('Could not determine batch folder location');
            }

            // Compute actual fromPage from database — don't trust frontend's stale currentPage
            // The "Next Page" button may have already fetched pages the frontend doesn't know about
            let currentHighestPage: number;
            if (paginationConfig.location === 'body') {
                // GitHub Issue #245: page lives in the body — members are one-per-page
                currentHighestPage = paginationConfig.startValue + batchMembers.length - 1;
            } else {
                currentHighestPage = paginationConfig.startValue - 1;
                for (const member of batchMembers) {
                    if (member.requestQueryParams) {
                        const pageValue = (member.requestQueryParams as Record<string, string>)[paginationConfig.paramKey];
                        if (pageValue) {
                            const pageNumber = parseInt(String(pageValue), 10);
                            if (!isNaN(pageNumber) && pageNumber > currentHighestPage) {
                                currentHighestPage = pageNumber;
                            }
                        }
                    }
                }
            }

            const fromPage = currentHighestPage + 1;
            const toPage = fromPage + requestedPageCount - 1;

            const pageCount = toPage - fromPage + 1;

            // ServiceTokens is imported at module scope (used by the issue#266 pause guard above)

            // Step 1: Update batch with total expected member count FIRST
            const newTotalMembers = batchMembers.length + pageCount;
            await executionMetadataService.updateExecution(batchId, {
                status: 'pending',
                rows: String(newTotalMembers)
            });

            // Step 1b: Prompt for concurrency (GitHub Issue #198) — skip when auto-triggered
            if (pageCount > 1 && !skipConcurrencyPrompt) {
                // issue#269: collect concurrency via a DBMN modal instead of a native quick-pick
                const threadOptions = [
                    { value: '1', label: '1 (Sequential)' },
                    { value: '2', label: '2 threads' },
                    { value: '4', label: '4 threads' },
                    { value: '8', label: '8 threads' }
                ];

                const choice = await this.session.showModal({
                    title: 'Concurrent page requests',
                    body: 'How many pages to fetch simultaneously?',
                    fields: [{
                        id: 'concurrency',
                        type: 'select',
                        label: 'Threads',
                        value: '1',
                        options: threadOptions
                    }],
                    actions: [
                        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                        { id: 'fetch', label: 'Fetch Pages', variant: 'primary' }
                    ],
                    dismissible: true,
                    size: 'sm'
                });

                if (choice.actionId !== 'fetch') {
                    // User cancelled - revert batch rows
                    await executionMetadataService.updateExecution(batchId, {
                        rows: String(batchMembers.length)
                    });
                    return createResponseMessage(message.correlationId, true, {
                        success: false, message: 'Cancelled by user'
                    });
                }

                const concurrency = parseInt(choice.fields.concurrency, 10) || 1;
                if (concurrency > 1) {
                    // Store concurrency in batch metadata for the execution engine
                    const existingConfig = batchMetadata.batchConfiguration || { stopOnFirstError: false };
                    await executionMetadataService.updateExecution(batchId, {
                        batchConfiguration: {
                            ...existingConfig,
                            parallelProcessing: { enabled: true, maxConcurrency: concurrency as 2 | 4 | 8 }
                        }
                    });
                }
            } else if (pageCount > 1 && skipConcurrencyPrompt) {
                // Auto-triggered fetch: default to 4 concurrent threads
                const defaultConcurrency = 4;
                if (defaultConcurrency > 1) {
                    const existingConfig = batchMetadata.batchConfiguration || { stopOnFirstError: false };
                    await executionMetadataService.updateExecution(batchId, {
                        batchConfiguration: {
                            ...existingConfig,
                            parallelProcessing: { enabled: true, maxConcurrency: defaultConcurrency as 2 | 4 | 8 }
                        }
                    });
                }
            }

            // Step 2: Create first member using existing handler (ensures correct file structure)
            const transactionCreator = this.ports.transactionCreator;
            const endpointManager = this.ports.endpoints;

            if (!transactionCreator || !endpointManager) {
                throw new Error('Required services not available');
            }

            const batchMemberHandler = new BatchMemberTransactionHandler(
                transactionCreator,
                new PathGeneratorHelper(),
                new TemplateParser(),
                new JsonGenerator(endpointManager)
            );

            // GitHub Issue #245: resolve the page in the body or query params per location.
            // #446: the page size the API sends, when it sends fewer than asked
            const rangePageSize = this.pageSizeToAsk(batchId, endpoint, batchMembers);
            const pagedEndpointFor = (pageNumber: number) => {
                if (paginationConfig.location === 'body') {
                    return { ...endpoint, body: paginationDetector.replacePaginationInBody(endpoint.body || '', pageNumber, rangePageSize) };
                }
                return {
                    ...endpoint,
                    queryParams: paginationDetector.replacePaginationTemplate(endpoint.queryParams || {}, paginationConfig, pageNumber, rangePageSize)
                };
            };
            let currentTransactionIndex = batchMembers.length;

            const firstMemberResult = await batchMemberHandler.createTransaction({
                endpoint: pagedEndpointFor(fromPage),
                environment: batchMetadata.environment,
                environmentId: batchMetadata.environmentId,
                environmentFolder: undefined,
                organization: batchMetadata.organization || '',
                workspaceRoot,
                batchId,
                csvRowData: [['page'], [String(fromPage)]],
                transactionIndex: currentTransactionIndex,
                rowStart: currentTransactionIndex + 1
            });
            currentTransactionIndex++;

            // Step 3: Start execution IMMEDIATELY in background (don't wait for remaining members)
            const batchExecutionEngine = (this.ports.batchEngine as unknown) as any;
            if (!batchExecutionEngine) {
                throw new Error('BatchExecutionEngine not available');
            }

            // GitHub Issue #266: do NOT clearBatchState() here — executeBatch() is now idempotent
            // and refreshes totalMembers so the single active consumer loop drains the newly
            // created pages (starting a second loop per fetch is what broke pause).
            batchExecutionEngine.executeBatch(batchId).catch((error: unknown) => {
                this.logError(`Page range batch execution failed for ${batchId}`, error instanceof Error ? error : new Error(String(error)));
            });

            // Step 4: Bulk-create remaining members while execution runs in parallel
            const createdMemberIds: string[] = [firstMemberResult.executionId];

            if (pageCount > 1 && paginationConfig.location === 'body') {
                // GitHub Issue #245: body pagination — each page needs a DIFFERENT body
                // (the bulk "same body, vary query params" optimisation below does not
                // apply). Create each page through the handler so its body is substituted.
                for (let pageNum = fromPage + 1; pageNum <= toPage; pageNum++) {
                    const memberResult = await batchMemberHandler.createTransaction({
                        endpoint: pagedEndpointFor(pageNum),
                        environment: batchMetadata.environment,
                        environmentId: batchMetadata.environmentId,
                        environmentFolder: undefined,
                        organization: batchMetadata.organization || '',
                        workspaceRoot,
                        batchId,
                        csvRowData: [['page'], [String(pageNum)]],
                        transactionIndex: currentTransactionIndex,
                        rowStart: currentTransactionIndex + 1
                    });
                    createdMemberIds.push(memberResult.executionId);
                    currentTransactionIndex++;
                }
            } else if (pageCount > 1) {

                // Get the body content from the first member's request file (works for both GET and POST)
                let bodyContent = '{}';
                if (firstMemberResult.requestFilePath) {
                    try {
                        bodyContent = readRunFile(firstMemberResult.requestFilePath);
                    } catch {
                        // Fall back to empty JSON if file not readable
                    }
                }

                // Build metadata objects and write request files for all remaining members
                const remainingMetadata: Array<Omit<import('../../storage/execution-metadata').ExecutionMetadata, 'id'>> = [];
                const flatHeaders = flattenHeaders(endpoint.headers || {});

                for (let pageNum = fromPage + 1; pageNum <= toPage; pageNum++) {
                    const pageQueryParams = paginationDetector.replacePaginationTemplate(
                        endpoint.queryParams || {}, paginationConfig, pageNum, rangePageSize
                    );
                    const flatQueryParams = flattenQueryParams(pageQueryParams);
                    // Request file beside the first member's, named by the same rule the member
                    // handler used for it (1-based). A hand-built 0-based name here once gave the
                    // first page of this loop the previous page's file: one page lost on disk.
                    const requestFilePath = path.join(firstMemberResult.directoryPath, batchMemberFileName(currentTransactionIndex));

                    // Write request file with body content (same body for all pages, only query params differ)
                    writeRunFile(requestFilePath, bodyContent);

                    remainingMetadata.push({
                        executionType: 'batch_member' as const,
                        status: 'pending',
                        batchId,
                        environment: batchMetadata.environment,
                        environmentId: batchMetadata.environmentId,
                        organization: batchMetadata.organization,
                        endpointId: endpoint.id || '',
                        endpointName: endpoint.name,
                        endpointMethod: endpoint.method || 'GET',
                        endpointPath: endpoint.path,
                        requestHeaders: flatHeaders,
                        requestQueryParams: flatQueryParams,
                        requestFile: requestFilePath,
                        rows: '1',
                        rowStart: currentTransactionIndex + 1,
                        createdAt: new Date()
                    });

                    currentTransactionIndex++;
                }

                // Single bulk DB insert for all remaining members
                const remainingIds = await executionMetadataService.createExecutionBatch(remainingMetadata);
                createdMemberIds.push(...remainingIds);
            }

            // Send completion message to frontend (modal can close immediately)
            await this.post({
                type: 'getPagesComplete',
                success: true,
                pageCount: createdMemberIds.length,
                message: `Created ${createdMemberIds.length} pages and started execution`
            } as any);

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    success: true,
                    batchId,
                    fromPage,
                    toPage,
                    createdPages: createdMemberIds.length,
                    memberIds: createdMemberIds,
                    message: `Created ${createdMemberIds.length} pages (${fromPage}-${toPage}) and started execution`
                }
            );

        } catch (error) {
            this.logError('Failed to get page range', error instanceof Error ? error : new Error(String(error)));

            // Send error to frontend
            await this.post({
                type: 'getPagesComplete',
                success: false,
                error: error instanceof Error ? error.message : String(error)
            } as any);

            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'GET_PAGE_RANGE_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #198: Handle Configure Pagination request from Console
     * Gathers data (execution metadata, response, existing config) and sends
     * paginationSetupData message to the webview to open the in-webview modal.
     */
    private async handleConfigurePagination(message: BaseMessage): Promise<ResponseMessage> {
        try {

            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            const payload = message.payload as { executionId?: string };
            const executionId = payload?.executionId || this.currentConfig?.executionId;
            if (!executionId) {
                throw new Error('No execution selected');
            }

            const executionMeta = await executionMetadataService.getExecution(executionId);
            if (!executionMeta) {
                throw new Error('Execution metadata not found');
            }

            // Load response data for JSON tree
            // Response files wrap API data in an envelope: { executionId, duration, httpStatus, headers, data: <actual API response> }
            // Extract just the API response body (.data) so paths like header.totalCount are correct
            let responseData: Record<string, unknown> | null = null;

            // For batches, the batch record itself has no responseFile — use the most recent member's response
            let responseFilePath = executionMeta.responseFile;
            if (!responseFilePath) {
                // This is likely a batch parent — try to get a member's response file
                const members = await executionMetadataService.getBatchMemberExecutions(executionId);
                if (members.length > 0) {
                    // Use the last member that has a response file
                    for (let i = members.length - 1; i >= 0; i--) {
                        if (members[i].responseFile) {
                            responseFilePath = members[i].responseFile;
                            break;
                        }
                    }
                }
            }

            if (responseFilePath) {
                try {
                    const content = readRunFile(responseFilePath);
                    const parsed = JSON.parse(content);
                    responseData = (parsed && parsed.data) ? parsed.data as Record<string, unknown> : parsed;
                } catch (readErr) {
                    this.logError('[Pagination] Failed to read response file', readErr instanceof Error ? readErr : new Error(String(readErr)));
                }
            }

            // Get endpoint config to check existing pagination
            const endpointManager = this.ports.endpoints;

            let existingConfig: { location?: 'query' | 'body'; paramKey: string; startValue: number; totalCountPath?: string; sizeParamKey?: string; sizeValue?: number; sizePath?: string } | null = null;
            // GitHub Issue #245: detect against the execution's endpoint SNAPSHOT first
            // (same source the pagination engine uses) so body templates are seen even
            // if the saved endpoint was edited. Fall back to the live saved endpoint.
            const detectionEndpoint = (executionMeta.endpointConfig as APIEndpointConfig | undefined)
                ?? (endpointManager ? await endpointManager.getEndpoint(executionMeta.endpointId) : undefined);
            if (detectionEndpoint) {
                const paginationDetector = new PaginationDetectorService();
                const detected = paginationDetector.detectPagination(detectionEndpoint);
                if (detected.enabled) {
                    existingConfig = {
                        location: detected.location, // GitHub Issue #245
                        paramKey: detected.paramKey,
                        startValue: detected.startValue,
                        totalCountPath: detected.totalCountPath
                    };
                }
                // Detect size config
                const sizeDetected = paginationDetector.detectSize(detectionEndpoint);
                if (sizeDetected.enabled) {
                    if (!existingConfig) {
                        // GitHub Issue #245: preserve location so the modal renders body mode
                        existingConfig = { location: sizeDetected.location, paramKey: '', startValue: 1 };
                    }
                    existingConfig.sizeParamKey = sizeDetected.paramKey;
                    existingConfig.sizeValue = sizeDetected.value;
                    existingConfig.sizePath = sizeDetected.sizePath;
                }
            }

            // Build query params with values for dropdowns
            const queryParams = executionMeta.requestQueryParams || {};
            const queryParamsWithValues: { key: string; value: string }[] = [];
            for (const [key, rawValue] of Object.entries(queryParams)) {
                let value = '';
                if (typeof rawValue === 'string') {
                    value = rawValue;
                } else if (rawValue && typeof rawValue === 'object' && 'value' in rawValue) {
                    value = String((rawValue as { value: string }).value);
                }
                queryParamsWithValues.push({ key, value });
            }

            // Build numeric paths from response for Total Record Count dropdown
            const setupService = new PaginationSetupService();
            let numericPaths: { path: string; value: number; suggested: boolean }[] = [];
            if (responseData) {
                const { suggestedFields, otherNumericFields } = setupService.findAllNumericPaths(responseData);
                numericPaths = [
                    ...suggestedFields.map((f: { path: string; value: number }) => ({ path: f.path, value: f.value, suggested: true })),
                    ...otherNumericFields.map((f: { path: string; value: number }) => ({ path: f.path, value: f.value, suggested: false }))
                ];
            }

            // Determine pagination metadata context for Execute tab
            // GitHub Issue #209: Query batch members for actual highest page instead of hardcoding 0
            let metaCurrentPage = 0;
            let metaRemainingPages = 0;
            let metaHasMorePages = false;
            const metaTotalPages = this.paginationState?.totalPages;

            if (this.paginationState && metaTotalPages) {
                const execMetaSvc = this.ports.metadata;
                if (execMetaSvc && this.currentConfig?.batchId) {
                    try {
                        const members = await execMetaSvc.getBatchMemberExecutions(this.currentConfig.batchId);
                        const cfg = this.paginationState.config;
                        let highest: number;
                        if (cfg.location === 'body') {
                            // GitHub Issue #245: body pagination stores the page
                            // in the request body (one member per page), not in
                            // query params. Mirror the fetch-page calc so the
                            // modal reflects the real current page (e.g. 11 of
                            // 2034) instead of always showing 1.
                            highest = cfg.startValue + members.length - 1;
                        } else {
                            highest = cfg.startValue;
                            for (const m of members) {
                                if (m.requestQueryParams) {
                                    const pv = m.requestQueryParams[cfg.paramKey];
                                    if (pv) {
                                        const n = parseInt(String(pv), 10);
                                        if (!isNaN(n) && n > highest) {
                                            highest = n;
                                        }
                                    }
                                }
                            }
                        }
                        metaCurrentPage = highest;
                        const fetchedCount = highest - cfg.startValue + 1;
                        metaRemainingPages = metaTotalPages - fetchedCount;
                        metaHasMorePages = metaRemainingPages > 0;
                    } catch (_) {
                        metaHasMorePages = true;
                    }
                }
            }

            const paginationMetadata = this.paginationState ? {
                enabled: true,
                hasMorePages: metaHasMorePages,
                totalPages: metaTotalPages,
                currentPage: metaCurrentPage,
                startValue: this.paginationState.config.startValue,
                remainingPages: metaRemainingPages
            } : null;

            // Auto-detect first page (0 vs 1) from the response's pagination container
            let detectedStartValue: number | null = null;
            if (responseData) {
                for (const key of ['pagination', 'header', 'meta', 'paging']) {
                    const container = responseData[key];
                    if (container && typeof container === 'object' && !Array.isArray(container) && 'page' in (container as Record<string, unknown>)) {
                        const pageVal = (container as Record<string, unknown>).page;
                        const parsed = typeof pageVal === 'number' ? pageVal : parseInt(String(pageVal), 10);
                        if (parsed === 0 || parsed === 1) {
                            detectedStartValue = parsed;
                        }
                        break;
                    }
                }
            }

            // #446: the pages as the API sends them, worked out here (the window only shows them):
            // asked for 2,000 a page, an API that sends 500 has four times the pages
            let sentPages: { pageSize: number; totalPages: number } | undefined;
            if (existingConfig?.totalCountPath && responseData) {
                const detector = new PaginationDetectorService();
                const path = existingConfig.totalCountPath.startsWith('data.') ? existingConfig.totalCountPath.slice(5) : existingConfig.totalCountPath;
                const total = detector.extractTotalCount(responseData, path) ?? detector.extractTotalCount(responseData, existingConfig.totalCountPath);
                if (total !== null && total > 0) sentPages = detector.pagesFor(total, existingConfig.sizeValue, responseData, existingConfig.sizePath);
            }

            // Send data to webview for modal rendering
            await this.post({
                type: 'paginationSetupData',
                queryParamsWithValues,
                existingConfig,
                sentPages,
                numericPaths,
                endpointId: executionMeta.endpointId,
                isBatch: !!executionMeta.batchId,
                paginationMetadata,
                detectedStartValue
            } as Record<string, unknown>);

            return createResponseMessage(message.correlationId, true, {
                success: true,
                message: 'Pagination setup data sent to webview'
            });

        } catch (error) {
            this.logError('Failed to configure pagination', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'CONFIGURE_PAGINATION_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #198: Handle Save Pagination Config from the in-webview modal.
     * Saves pagination config to the endpoint, optionally triggers execution.
     */
    private async handleSavePaginationConfig(message: BaseMessage): Promise<ResponseMessage> {
        try {

            const payload = message.payload as {
                endpointId: string;
                location?: 'query' | 'body';
                paramKey: string;
                startValue: number;
                totalCountPath?: string;
                sizeParamKey?: string;
                sizeValue?: number;
                sizePath?: string;
                execute?: boolean;
                sizeChanged?: boolean;
                fetchMode?: 'all' | 'next';
                fetchCount?: number;
            };

            // GitHub Issue #245: body pagination edits the body template in place, so
            // a query paramKey isn't required — only query setup needs paramKey.
            if (!payload.endpointId) {
                throw new Error('Missing required field: endpointId');
            }
            if (payload.location !== 'body' && !payload.paramKey) {
                throw new Error('Missing required field: paramKey');
            }

            const endpointManager = this.ports.endpoints;
            if (!endpointManager) {
                throw new Error('EndpointManager not available');
            }

            // If page size changed and a batch exists, clean up old batch data
            let batchCleared = false;
            let deletedMembers = 0;
            if (payload.sizeChanged) {
                const batchId = this.currentConfig?.executionId || this.currentConfig?.batchId;
                if (batchId) {
                    const executionMetadataService = this.ports.metadata;
                    if (executionMetadataService) {

                        // Cancel running batch if active
                        try {
                            const batchEngine = (this.ports.batchEngine as unknown) as
                                { cancelBatch: (id: string) => Promise<void>; clearBatchState: (id: string) => void } | undefined;
                            if (batchEngine) {
                                await batchEngine.cancelBatch(batchId);
                                batchEngine.clearBatchState(batchId);
                            }
                        } catch (cancelErr) {
                            this.log(`[Pagination] cancelBatch non-fatal: ${cancelErr}`);
                        }

                        // Get all records to find files
                        const members = await executionMetadataService.getBatchMemberExecutions(batchId);
                        const parent = await executionMetadataService.getExecution(batchId);
                        const allRecords = parent ? [parent, ...members] : members;
                        deletedMembers = members.length;

                        // Delete response/request/log files from disk
                        for (const record of allRecords) {
                            for (const filePath of [record.responseFile, record.requestFile, record.logPath]) {
                                if (filePath) {
                                    try { removeRunFile(filePath); } catch (_e) { /* file may not exist */ }
                                }
                            }
                        }

                        // The batch's folder, where its files were
                        const batchFile = allRecords.map(r => r.requestFile || r.responseFile).find(Boolean);
                        if (batchFile) {
                            await fs.promises.rm(path.dirname(batchFile), { recursive: true, force: true }).catch(() => undefined);
                        }

                        // Delete DB records — delete all members then the parent
                        for (const member of members) {
                            await executionMetadataService.deleteExecution(member.id);
                        }
                        await executionMetadataService.deleteExecution(batchId);

                        // Clear backend pagination state
                        this.paginationState = undefined;

                        batchCleared = true;
                    }
                }
            }

            const setupService = new PaginationSetupService();
            await setupService.savePaginationConfig(endpointManager, payload.endpointId, {
                location: payload.location, // GitHub Issue #245
                paramKey: payload.paramKey,
                startValue: payload.startValue,
                totalCountPath: payload.totalCountPath,
                sizeParamKey: payload.sizeParamKey,
                sizeValue: payload.sizeValue,
                sizePath: payload.sizePath
            });


            // Verify config was saved
            const updatedEndpoint = await endpointManager.getEndpoint(payload.endpointId);
            if (!updatedEndpoint) {
                throw new Error('Could not load updated endpoint');
            }

            const paginationDetector = new PaginationDetectorService();
            const paginationConfig = paginationDetector.detectPagination(updatedEndpoint);

            if (!paginationConfig.enabled) {
                throw new Error('Pagination configuration failed to save correctly');
            }

            // If execute requested, trigger paginated batch execution
            if (payload.execute) {
                // Store pending fetch mode so we auto-fetch remaining pages after page 1 completes
                if (payload.fetchMode && payload.fetchMode !== 'next' || (payload.fetchMode === 'next' && payload.fetchCount && payload.fetchCount > 1)) {
                    const fetchModeEntry = { mode: payload.fetchMode || 'next' as const, count: payload.fetchCount };
                    ConsoleController.pendingFetchModes.set(payload.endpointId, fetchModeEntry);
                }
                await this.ports.host.runApi(updatedEndpoint);
            }

            // Notify webview of success
            await this.post({
                type: 'paginationConfigSaved',
                success: true,
                executed: !!payload.execute,
                template: setupService.buildPaginationTemplate(payload.startValue, payload.totalCountPath),
                batchCleared,
                deletedMembers
            } as Record<string, unknown>);

            return createResponseMessage(message.correlationId, true, {
                success: true,
                message: payload.execute ? 'Pagination configured and batch started' : 'Pagination settings saved'
            });

        } catch (error) {
            this.logError('Failed to save pagination config', error instanceof Error ? error : new Error(String(error)));

            await this.post({
                type: 'paginationConfigSaved',
                success: false,
                error: error instanceof Error ? error.message : String(error)
            } as Record<string, unknown>);

            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'SAVE_PAGINATION_CONFIG_FAILED'
            );
        }
    }

    /**
     * Help icons now open dbmn.io in external browser via handleOpenExternalUrl() in processMessage().
     */

    /**
     * Generate export file using ExportService
     */
    private async generateExportFile(
        format: ExportFormat,
        tableData: any[],
        columns: any[],
        options: ExportOptions
    ): Promise<string> {
        try {
            switch (format) {
                case 'csv':
                    return await this.exportService.exportToCsv(tableData, columns, options);
                case 'excel':
                    return await this.exportService.exportToExcel(tableData, columns, options);
                case 'json':
                    return await this.exportService.exportToJson(tableData, columns, options);
                case 'sql':
                    return await this.exportService.exportToSql(tableData, columns, options);
                default:
                    throw new Error(`Unsupported export format: ${format}`);
            }
        } catch (error) {
            this.logError(`Export failed for format ${format}`, error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Read sample data for structure analysis
     */
    private async readSampleDataForAnalysis(filePath: string): Promise<any> {
        try {
            const content = readRunFile(filePath);
            return JSON.parse(content);
        } catch (error) {
            // Return simple structure if can't parse
            return { content: 'sample data' };
        }
    }

    /**
     * The export is written. Where the host can open the file (VS Code), offer Open File / Show
     * in Explorer in a DBMN modal; the browser downloads it and says so.
     */
    private async showExportSuccessNotification(filePath: string, format: ExportFormat, rowCount: number, arrayWarning?: string): Promise<void> {
        const fileName = path.basename(filePath);
        const fileSize = await this.getFileSize(filePath);
        const message = `${format.toUpperCase()} export complete! Exported ${rowCount} rows to ${fileName} (${fileSize})`;
        if (arrayWarning && format === 'csv') {
            this.ports.toast.warn(arrayWarning);
        }
        const files = this.ports.files;
        await files.exported?.(filePath);
        if (!files.open && !files.reveal) {
            this.ports.toast.info(message);
            return;
        }
        const choice = await this.session.showModal({
            title: 'Export complete',
            body: message,
            actions: [
                { id: 'dismiss', label: 'Close', variant: 'secondary' },
                ...(files.reveal ? [{ id: 'reveal', label: 'Show in Explorer', variant: 'secondary' as const }] : []),
                ...(files.open ? [{ id: 'open', label: 'Open File', variant: 'primary' as const }] : [])
            ],
            dismissible: true,
            size: 'sm'
        });
        if (choice.actionId === 'open') {
            await files.open?.(filePath);
        } else if (choice.actionId === 'reveal') {
            await files.reveal?.(filePath);
        }
    }

    /** Human-readable file size. */
    private async getFileSize(filePath: string): Promise<string> {
        try {
            const bytes = (await fs.promises.stat(filePath)).size;
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        } catch {
            return 'Unknown size';
        }
    }

    /**
     * Extract nested value from object using dot notation path
     * Used by export to get column values from nested objects
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    private extractNestedValue(obj: any, path: string): any {
        return this.tableBuilder.extractNestedValue(obj, path);
    }

    /**
     * Get file extension for export format
     */
    private getFileExtension(format: ExportFormat): string {
        switch (format) {
            case 'csv': return 'csv';
            case 'excel': return 'xlsx'; // Excel export creates true Excel files
            case 'json': return 'json';
            case 'sql': return 'sql';
            default: return 'txt';
        }
    }

    /**
     * Get file filters for save dialog
     */
    private getFileFilters(format: ExportFormat): Record<string, string[]> {
        switch (format) {
            case 'csv':
                return { 'CSV Files': ['csv'] };
            case 'excel':
                return { 'Excel Files': ['xlsx'] };
            case 'json':
                return { 'JSON Files': ['json'] };
            case 'sql':
                return { 'SQL Files': ['sql'] };
            default:
                return { 'All Files': ['*'] };
        }
    }

    /**
     * NEW: Handle refresh report request
     */
    private async handleRefreshReport(message: RefreshConsoleRequest): Promise<ConsoleRefreshedResponse> {

        if (!this.currentConfig) {
            throw new Error('No report configuration available for refresh');
        }

        try {
            // Extract fresh data using current configuration
            const reportConfig: ConsoleConfig = {
                viewMode: 'auto',
                maxRows: 10000,
                flattenNested: true,
                arrayStrategy: 'concatenate'
            };

            const refreshedData = await this.extractRawData(this.currentConfig, reportConfig);

            // Preserve existing logs if they were already loaded/streamed
            // When status updates to COMPLETED, we don't want to clear the logs
            if (this.loadedRawData?.logContent && !refreshedData.logContent) {
                refreshedData.logContent = this.loadedRawData.logContent;
                this.log('[handleRefreshReport] Preserved existing log content during refresh');
            }

            // Update stored data
            this.loadedRawData = refreshedData;

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    rawData: refreshedData,
                    lastRefreshed: new Date()
                }
            ) as ConsoleRefreshedResponse;

        } catch (error) {
            this.logError('Failed to refresh report', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Check if execution is currently running (vs completed/stopped)
     */
    private async isExecutionRunning(executionId: string): Promise<boolean> {
        try {
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                return false;
            }

            const metadata = await executionMetadataService.getExecution(executionId);
            if (!metadata?.status) {
                return false;
            }

            // Consider RUNNING, PREPARING, QUEUED as "active"
            const activeStatuses = ['RUNNING', 'PREPARING', 'QUEUED', 'PAUSED'];
            return activeStatuses.includes(metadata.status.toUpperCase());
        } catch (error) {
            this.logError(`Failed to check execution status for ${executionId}`, error instanceof Error ? error : new Error(String(error)));
            return false;
        }
    }

    /**
     * Start historical log streaming (for completed executions)
     * Uses disk streaming to progressively load logs from completed files
     */
    private async startHistoricalLogStreaming(executionId: string, batchId?: string): Promise<void> {
        if (!batchId || !this.responseDataExtractor) {
            return;
        }

        this.log(`Starting historical log streaming for batch ${batchId}`);

        // Use existing disk streaming infrastructure
        await this.responseDataExtractor.loadLogsProgressively(
            batchId,
            1000, // chunk size
            async (chunk: string[], progress: { loaded: number; total: number }) => {
                // Send log update event to webview
                const logStreamEvent: LogStreamUpdateEvent = createEventMessage(
                    ConsoleMessageTypes.LOG_STREAM_UPDATE,
                    'file-operation',
                    'high',
                    {
                        content: chunk.join('\n'),
                        isComplete: progress.loaded >= progress.total,
                        executionId: executionId
                    }
                ) as LogStreamUpdateEvent;

                await this.post(logStreamEvent);
            }
        ).catch((error: Error | unknown) => {
            this.logError(`Historical log streaming error for ${batchId}`, error instanceof Error ? error : new Error(String(error)));
        });
    }

    /**
     * Start live log streaming (for running executions)
     * Hybrid approach: load historical logs first, then stream new events
     */
    private async startLiveLogStreaming(executionId: string, batchId?: string): Promise<void> {
        const executionLoggingService = this.ports.executionLogging;
        if (!executionLoggingService) {
            this.logError('ExecutionLoggingService not available', new Error('Service not found'));
            return;
        }

        // Step 1: Load historical logs from disk first (what's already written)
        // Support both batch (batchId) and individual (executionId) transactions
        const idForHistoricalLogs = batchId || executionId;
        if (idForHistoricalLogs && this.responseDataExtractor) {
            await this.responseDataExtractor.loadLogsProgressively(
                idForHistoricalLogs,
                1000,
                async (chunk: string[], progress: { loaded: number; total: number }) => {
                    const logStreamEvent: LogStreamUpdateEvent = createEventMessage(
                        ConsoleMessageTypes.LOG_STREAM_UPDATE,
                        'file-operation',
                        'high',
                        {
                            content: chunk.join('\n'),
                            isComplete: false, // Not complete - will continue with live streaming
                            executionId: executionId
                        }
                    ) as LogStreamUpdateEvent;

                    await this.post(logStreamEvent);
                }
            ).catch((error: Error | unknown) => {
                this.logError(`Error loading historical logs for ${idForHistoricalLogs}`, error instanceof Error ? error : new Error(String(error)));
            });
        }

        // Step 2: Register callback for new log events as they occur
        const unregisterCallback = executionLoggingService.startWebviewLogStreaming(
            async (formattedContent: string) => {
                const logStreamEvent: LogStreamUpdateEvent = createEventMessage(
                    ConsoleMessageTypes.LOG_STREAM_UPDATE,
                    'execution',
                    'high',
                    {
                        content: formattedContent,
                        isComplete: false,
                        executionId: executionId
                    }
                ) as LogStreamUpdateEvent;

                await this.post(logStreamEvent);
            },
            executionId,
            batchId
        );

        // Step 3: Store callback for cleanup
        const sessionKey = batchId || executionId;
        this.activeLogStreamCallbacks.set(sessionKey, unregisterCallback);
    }

    /**
     * NEW: Handle start log stream request (GitHub Issue #94)
     * Unified streaming for both historical and live log viewing
     * Hybrid approach: detects RUNNING vs COMPLETED and uses appropriate method
     */
    private async handleStartLogStream(message: StartLogStreamRequest): Promise<ResponseMessage> {

        const { executionId, batchId } = message.payload;

        try {
            // Mark current data as streaming if available
            if (this.loadedRawData) {
                this.loadedRawData.isStreaming = true;
            }

            // Detect if execution is currently running or completed
            const targetId = batchId || executionId;
            const isRunning = await this.isExecutionRunning(targetId);

            if (isRunning) {
                // RUNNING: Use hybrid streaming (historical + live events)
                await this.startLiveLogStreaming(executionId, batchId);
            } else {
                // COMPLETED: Use disk streaming only
                await this.startHistoricalLogStreaming(executionId, batchId);
            }

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    executionId,
                    batchId,
                    streaming: true,
                    isLiveStreaming: isRunning
                }
            );

        } catch (error) {
            this.logError('Failed to start log stream', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * NEW: Handle stop log stream request
     * Actually unregisters live streaming callbacks
     */
    private async handleStopLogStream(message: StopLogStreamRequest): Promise<ResponseMessage> {

        const { executionId, batchId } = message.payload;

        try {
            this.log(`Stopping log stream for execution ${executionId}`);

            // Unregister callback if exists
            const sessionKey = batchId || executionId;
            const unregisterCallback = this.activeLogStreamCallbacks.get(sessionKey);

            if (unregisterCallback) {
                unregisterCallback(); // Actually call the cleanup function
                this.activeLogStreamCallbacks.delete(sessionKey);
                this.log(`Live streaming stopped for ${sessionKey}`);
            }

            // Mark current data as not streaming if available
            if (this.loadedRawData) {
                this.loadedRawData.isStreaming = false;
            }

            return createResponseMessage(
                message.correlationId,
                true,
                {
                    executionId,
                    streaming: false
                }
            );

        } catch (error) {
            this.logError('Failed to stop log stream', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * GitHub Issue #94: Handle lazy log loading request
     * Loads logs progressively in chunks for better UX
     */
    private async handleLoadLogsRequest(message: LoadLogsRequest): Promise<ResponseMessage> {
        // Handle double-nested payload structure from frontend (same pattern as save settings)
        const actualPayload = (message.payload as any).payload || message.payload;
        const loadStart = Date.now();

        const { batchId, progressiveLoad } = actualPayload;

        try {
            if (!this.responseDataExtractor) {
                throw new Error('Response data extractor not available');
            }

            if (!batchId) {
                throw new Error('No batchId or executionId provided for log loading');
            }

            const chunkSize = 1000; // Load 1000 log entries at a time

            // Load logs with progressive chunking callback
            const allLogs = await this.responseDataExtractor.loadLogsProgressively(
                batchId,
                chunkSize,
                async (chunk, progress) => {
                    // Send chunk to webview as event
                    const chunkEvent: LogsChunkLoadedEvent = createEventMessage(
                        ConsoleMessageTypes.LOGS_CHUNK_LOADED,
                        'file-operation',
                        'low',
                        {
                            chunk,
                            progress: {
                                loaded: progress.loaded,
                                total: progress.total,
                                percentage: Math.round((progress.loaded / progress.total) * 100)
                            },
                            isComplete: progress.loaded >= progress.total
                        }
                    ) as LogsChunkLoadedEvent;

                    await this.post(chunkEvent);
                }
            );

            // Return success response
            return createResponseMessage(
                message.correlationId,
                true,
                {
                    totalLogs: allLogs.length,
                    message: 'Logs loaded successfully'
                }
            );

        } catch (error) {
            this.logError('Failed to load logs', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * GitHub Issue #102: Handle database count request for diagnostic stats
     * Queries database for accurate batch member count
     */
    private async handleDatabaseCountRequest(message: DatabaseCountRequest): Promise<ResponseMessage> {
        const actualPayload = (message.payload as any).payload || message.payload;
        const { batchId } = actualPayload;

        try {
            if (!batchId) {
                throw new Error('No batchId provided for database count request');
            }

            // Get execution metadata service
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            // Query database for batch members
            const allMembers = await executionMetadataService.getBatchMemberExecutions(batchId);

            // Count completed members (completed, error, cancelled statuses)
            const completedCount = allMembers.filter((m: any) =>
                ['completed', 'error', 'cancelled'].includes(m.status)
            ).length;

            // Send response message to webview
            await this.post({
                type: 'report.database_count_response',
                correlationId: message.correlationId,
                source: 'extension',
                target: 'webview',
                timestamp: Date.now(),
                payload: {
                    batchId,
                    count: completedCount
                }
            });

            // Return success response
            return createResponseMessage(
                message.correlationId,
                true,
                {
                    batchId,
                    count: completedCount
                }
            );

        } catch (error) {
            this.logError('Failed to get database count', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'DATABASE_COUNT_FAILED'
            );
        }
    }

    /**
     * GitHub Issue #166: Handle RAW tab data request
     * Returns list of all transactions with metadata only (no file content)
     * Used to render card headers before lazy-loading content
     */
    private async handleGetRawTabData(message: GetRawTabDataRequest): Promise<RawTabDataResponse> {
        const actualPayload = (message.payload as any).payload || message.payload;
        const { batchId, executionId } = actualPayload;
        const started = Date.now();

        try {
            const transactions: RawTransactionSummary[] = [];
            const statusCounts: Record<string, number> = {};

            // Get execution metadata service
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            if (batchId) {
                // Batch report: Get all batch member executions
                const members = await executionMetadataService.getBatchMemberExecutions(batchId);

                for (const member of members) {
                    const status = member.status || 'unknown';
                    const hasRequest = member.requestFile ? runFileExists(member.requestFile) : false;
                    const hasResponse = member.responseFile ? runFileExists(member.responseFile) : false;

                    const memberTimestamp = member.startedAt || member.createdAt;
                    transactions.push({
                        executionId: member.id,
                        status: status,
                        httpStatus: member.httpStatus || '-',
                        timestamp: memberTimestamp instanceof Date ? memberTimestamp.toISOString() : memberTimestamp,
                        hasRequest,
                        hasResponse,
                        requestFile: member.requestFile,
                        responseFile: member.responseFile,
                        // GitHub Issue #166: CSV row mapping for Data toggle
                        rowStart: member.rowStart,
                        rows: member.rows,
                        // GitHub Issue #201: Per-transaction endpoint data for RAW tab Details
                        endpointPath: member.endpointPath,
                        requestHeaders: member.requestHeaders,
                        requestQueryParams: member.requestQueryParams,
                        logPath: member.logPath,
                        reprocessCount: (member as { reprocessCount?: number }).reprocessCount
                    });

                    // Count statuses
                    statusCounts[status] = (statusCounts[status] || 0) + 1;
                }
            } else if (executionId) {
                // Individual transaction: Get single execution
                const execution = await executionMetadataService.getExecution(executionId);
                if (execution) {
                    const status = execution.status || 'unknown';
                    const hasRequest = execution.requestFile ? runFileExists(execution.requestFile) : false;
                    const hasResponse = execution.responseFile ? runFileExists(execution.responseFile) : false;

                    const execTimestamp = execution.startedAt || execution.createdAt;
                    transactions.push({
                        executionId: execution.id,
                        status: status,
                        httpStatus: execution.httpStatus || '-',
                        timestamp: execTimestamp instanceof Date ? execTimestamp.toISOString() : execTimestamp,
                        hasRequest,
                        hasResponse,
                        requestFile: execution.requestFile,
                        responseFile: execution.responseFile,
                        // GitHub Issue #201: Per-transaction endpoint data for RAW tab Details
                        endpointPath: execution.endpointPath,
                        requestHeaders: execution.requestHeaders,
                        requestQueryParams: execution.requestQueryParams,
                        logPath: execution.logPath
                    });

                    statusCounts[status] = 1;
                }
            }

            const response = createResponseMessage(
                message.correlationId,
                true,
                {
                    transactions,
                    totalCount: transactions.length,
                    statusCounts
                }
            ) as RawTabDataResponse;
            response.type = ConsoleMessageTypes.RAW_TAB_DATA_RESPONSE;
            this.timing(`[Console] issue#312 raw summaries for ${batchId || executionId}: ${transactions.length} in ${Date.now() - started}ms`);

            return response;

        } catch (error) {
            this.logError('Failed to get RAW tab data', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'RAW_TAB_DATA_FAILED'
            ) as RawTabDataResponse;
        }
    }

    /**
     * GitHub Issue #166: Handle RAW transaction content request
     * Reads request/response files from disk and returns JSON content
     * Supports batch loading multiple transactions at once
     */
    private async handleGetRawTransactionContent(message: GetRawTransactionContentRequest): Promise<RawTransactionContentResponse> {
        const actualPayload = (message.payload as any).payload || message.payload;
        const { executionIds: requestedIds } = actualPayload;
        // Issue #312: a single request is capped — the page asks per rendered card, and a
        // runaway caller must not make the host read thousands of files for one message.
        const executionIds: string[] = (requestedIds || []).slice(0, ConsoleController.CONTENT_REQUEST_CAP);
        if ((requestedIds || []).length > executionIds.length) {
            this.log(`[Console] issue#312 raw content request for ${requestedIds.length} ids capped at ${executionIds.length}`);
        }

        try {
            const contents: RawTransactionContent[] = [];

            // Get execution metadata service
            const executionMetadataService = this.ports.metadata;
            if (!executionMetadataService) {
                throw new Error('ExecutionMetadataService not available');
            }

            for (const execId of executionIds) {
                try {
                    const execution = await executionMetadataService.getExecution(execId);

                    let requestContent: string | null = null;
                    let responseContent: string | null = null;

                    // Read request file
                    if (execution?.requestFile && runFileExists(execution.requestFile)) {
                        try {
                            requestContent = readRunFile(execution.requestFile);
                            // Try to format JSON
                            try {
                                const parsed = JSON.parse(requestContent);
                                requestContent = JSON.stringify(parsed, null, 2);
                            } catch {
                                // Keep as-is if not valid JSON
                            }
                            // Issue #306: `{}` was never sent — no body
                            if (isEmptyRequestBody(requestContent)) {
                                requestContent = '';
                            }
                        } catch (readError) {
                            this.log(`[handleGetRawTransactionContent] Failed to read request file for ${execId}`);
                        }
                    }

                    // Read response file
                    if (execution?.responseFile && runFileExists(execution.responseFile)) {
                        try {
                            responseContent = readRunFile(execution.responseFile);
                            // Try to format JSON
                            try {
                                const parsed = JSON.parse(responseContent);
                                responseContent = JSON.stringify(parsed, null, 2);
                            } catch {
                                // Keep as-is if not valid JSON (could be JSONL or text)
                            }
                        } catch (readError) {
                            this.log(`[handleGetRawTransactionContent] Failed to read response file for ${execId}`);
                        }
                    }

                    contents.push({
                        executionId: execId,
                        requestContent,
                        responseContent
                    });
                } catch (execError) {
                    contents.push({
                        executionId: execId,
                        requestContent: null,
                        responseContent: null,
                        error: execError instanceof Error ? execError.message : String(execError)
                    });
                }
            }

            const response = createResponseMessage(
                message.correlationId,
                true,
                { contents }
            ) as RawTransactionContentResponse;
            response.type = ConsoleMessageTypes.RAW_TRANSACTION_CONTENT_RESPONSE;

            return response;

        } catch (error) {
            this.logError('Failed to get RAW transaction content', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'RAW_TRANSACTION_CONTENT_FAILED'
            ) as RawTransactionContentResponse;
        }
    }

    /**
     * GitHub Issue #166: Handle get transaction log request
     * Reads log file for a specific transaction and returns formatted content
     * Uses the same formatting as the Logs tab for consistency
     */
    private async handleGetTransactionLog(message: GetTransactionLogRequest): Promise<TransactionLogResponse> {
        const actualPayload = (message.payload as any).payload || message.payload;
        const { logFilePath, executionId, transactionIndex } = actualPayload;

        try {
            let content = '// No log file available';

            // Resolve log file path: use provided path, or derive from execution metadata
            let resolvedLogPath = logFilePath;
            if (!resolvedLogPath && executionId) {
                const executionMetadataService = this.ports.metadata;
                if (executionMetadataService) {
                    const execMeta = await executionMetadataService.getExecution(executionId);
                    if (execMeta?.logPath) {
                        resolvedLogPath = execMeta.logPath;
                    } else if (execMeta?.requestFile) {
                        resolvedLogPath = execMeta.requestFile.replace(/\.[^/.]+$/, '.log');
                    }
                }
            }

            if (resolvedLogPath && runFileExists(resolvedLogPath)) {
                const rawContent = readRunFile(resolvedLogPath);

                // Log files are JSON Lines format - format each event nicely
                const lines = rawContent.trim().split('\n');
                const formattedLines: string[] = [];

                formattedLines.push('═'.repeat(60));
                formattedLines.push(`📋 Transaction Log - ${executionId?.substring(0, 8) || 'unknown'}`);
                formattedLines.push('═'.repeat(60));
                formattedLines.push('');

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const event = JSON.parse(line);
                            // Format using similar style to Logs tab
                            const formatted = this.formatLogEvent(event, executionId);
                            formattedLines.push(...formatted);
                        } catch {
                            // Keep line as-is if not valid JSON
                            formattedLines.push(line);
                        }
                    }
                }

                content = formattedLines.join('\n');
            }

            const response = createResponseMessage(
                message.correlationId,
                true,
                {
                    content,
                    executionId,
                    transactionIndex
                }
            ) as TransactionLogResponse;
            response.type = ConsoleMessageTypes.TRANSACTION_LOG_RESPONSE;

            return response;

        } catch (error) {
            this.logError('Failed to get transaction log', error instanceof Error ? error : new Error(String(error)));
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'TRANSACTION_LOG_FAILED'
            ) as TransactionLogResponse;
        }
    }

    /**
     * GitHub Issue #166: Format a single log event for display
     * Similar to ExecutionLoggingService.formatLogEventForDisplay but simplified
     */
    private formatLogEvent(event: any, executionId: string): string[] {
        const lines: string[] = [];
        const timestamp = event.timestamp ? (() => {
            const d = new Date(event.timestamp);
            const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const time = d.toLocaleTimeString();
            return `${date} ${time}`;
        })() : '';

        // Level emoji
        const levelEmoji: Record<string, string> = {
            'info': '✅',
            'warn': '⚠️',
            'error': '❌',
            'debug': '🔍'
        };
        const emoji = levelEmoji[event.level] || '📝';

        // Phase emoji
        const phaseEmoji: Record<string, string> = {
            'preparation': '📦',
            'execution': '🚀',
            'orchestration': '🎯',
            'completion': '🏁'
        };
        const phase = phaseEmoji[event.phase] || '📋';

        // Main log line
        let logLine = `${timestamp} ${emoji} ${phase} ${event.event || 'unknown'}`;

        // Add HTTP status if available
        if (event.http?.status) {
            const statusCode = event.http.status;
            const statusEmoji = statusCode >= 200 && statusCode < 300 ? '✅' :
                statusCode >= 400 && statusCode < 500 ? '⚠️' : '❌';
            logLine += ` ${statusEmoji} [${statusCode}]`;
        }

        // Add error if present
        if (event.error?.message) {
            logLine += ` ERROR: ${event.error.message}`;
        }

        lines.push(logLine);

        // Add HTTP details (method, url, headers)
        if (event.http) {
            const http = event.http;
            if (http.method && (http.url || http.path)) {
                lines.push(`   🌐 ${http.method} ${http.url || http.path}`);
            }

            // Show headers
            if (http.headers && typeof http.headers === 'object') {
                lines.push(`   📋 Headers:`);
                for (const [key, value] of Object.entries(http.headers)) {
                    // Mask sensitive headers
                    const displayValue = key.toLowerCase() === 'authorization'
                        ? '***'
                        : String(value);
                    lines.push(`      ${key}: ${displayValue}`);
                }
            }
        }

        // Add all data fields (except request/response body which is shown in RAW tab)
        if (event.data && typeof event.data === 'object') {
            const skipFields = ['requestBody', 'responseBody', 'body', 'request', 'response'];

            // #428: a test is shown whole, its script line by line, and each result with why
            // it failed (the generic line below cuts JSON off at 100 characters)
            const testScripts = (event.event === 'test_check' && Array.isArray(event.data.testScripts)) ? event.data.testScripts : undefined;
            const testResults = (event.event === 'tests_completed' && Array.isArray(event.data.results)) ? event.data.results : undefined;

            for (const [key, value] of Object.entries(event.data)) {
                // Skip fields that contain the full request/response JSON
                if (skipFields.includes(key)) continue;
                if ((testScripts && key === 'testScripts') || (testResults && key === 'results')) continue;

                // Skip null/undefined values
                if (value === null || value === undefined) continue;

                // Format the value appropriately
                let displayValue: string;
                if (typeof value === 'object') {
                    // For nested objects, show as compact JSON
                    displayValue = JSON.stringify(value);
                    // Truncate if too long
                    if (displayValue.length > 100) {
                        displayValue = displayValue.substring(0, 97) + '...';
                    }
                } else {
                    displayValue = String(value);
                }

                // Use appropriate emoji based on field name
                let fieldEmoji = '📄';
                if (key.includes('duration') || key.includes('time') || key.includes('Time')) fieldEmoji = '⏱️';
                else if (key.includes('file') || key.includes('File') || key.includes('path') || key.includes('Path')) fieldEmoji = '📁';
                else if (key.includes('endpoint') || key.includes('Endpoint')) fieldEmoji = '📝';
                else if (key.includes('environment') || key.includes('Environment')) fieldEmoji = '🏢';
                else if (key.includes('url') || key.includes('Url') || key.includes('method') || key.includes('Method')) fieldEmoji = '🌐';
                else if (key.includes('status') || key.includes('Status')) fieldEmoji = '📊';
                else if (key.includes('error') || key.includes('Error')) fieldEmoji = '❌';
                else if (key.includes('count') || key.includes('Count') || key.includes('total') || key.includes('Total')) fieldEmoji = '🔢';

                lines.push(`   ${fieldEmoji} ${key}: ${displayValue}`);
            }

            for (const test of (testScripts || []) as Array<{ name?: string; enabled?: boolean; script?: string; scriptLength?: number }>) {
                lines.push(`   🧪 ${test.name || 'Test'} (${test.enabled ? 'on' : 'off'})`);
                if (typeof test.script === 'string') {
                    test.script.split('\n').forEach(line => lines.push(`      ${line}`));
                } else if (test.scriptLength !== undefined) {
                    lines.push(`      (${test.scriptLength} characters; older logs don't keep the script)`);
                }
            }
            for (const result of (testResults || []) as Array<{ name?: string; passed?: boolean; error?: string }>) {
                lines.push(`   ${result.passed ? '✅' : '❌'} ${result.name || 'Test'}${result.passed ? ' passed' : `: ${result.error || 'failed'}`}`);
            }
        }

        // Add error details if present
        if (event.error && typeof event.error === 'object') {
            if (event.error.message) {
                lines.push(`   ❌ Error: ${event.error.message}`);
            }
            if (event.error.code) {
                lines.push(`   🔢 Code: ${event.error.code}`);
            }
            if (event.error.stack) {
                // Show first line of stack trace
                const firstStackLine = event.error.stack.split('\n')[0];
                lines.push(`   📍 ${firstStackLine}`);
            }
        }

        lines.push(''); // Empty line between events
        return lines;
    }

    /**
     * Generate correlation ID for messages
     */
    private generateReportCorrelationId(): string {
        return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /** Whether a Console is open on this run. */
    static hasConsole(id: string): boolean {
        return ConsoleController.activeConsoles.has(id);
    }

    /** A message straight to the Console open on this run, if there is one. */
    static postTo(id: string, message: Record<string, unknown>): void {
        void ConsoleController.activeConsoles.get(id)?.post(message);
    }

    /**
     * Static method to send status updates to any active report
     * GitHub Issue #121: Added responseFile and requestFile for dynamic link updates
     */
    static async sendStatusUpdate(executionId: string, statusUpdate: ConsoleStatusUpdate): Promise<void> {

        const reportManager = ConsoleController.activeConsoles.get(executionId);

        if (!reportManager) {
            ConsoleController.missedStatusUpdates.record(executionId, statusUpdate);
            return;
        }
        // A live update supersedes anything buffered before this Console registered.
        ConsoleController.missedStatusUpdates.take(executionId);

        if (reportManager) {
            try {
                // GitHub Issue #99: Reload backend data when execution completes
                // GitHub Issue #152: Also reload when batch stops due to error
                // This ensures export works for reports opened during PREPARING
                const shouldReloadData = (statusUpdate.forceReload || statusUpdate.status === 'completed' || statusUpdate.status === 'stopped' || statusUpdate.status === 'error') && reportManager.currentConfig;
                if (shouldReloadData) {
                    // currentConfig is guaranteed to be defined here (checked in shouldReloadData condition)
                    const currentConfig = reportManager.currentConfig!;

                    // Get execution metadata to find actual response file paths
                    const executionMetadataService = reportManager.ports.metadata;
                    if (executionMetadataService) {
                        if (currentConfig.type === 'individual') {
                            // Individual execution: Single response file
                            const executionMetadata = await executionMetadataService.getExecution(executionId);
                            if (executionMetadata?.responseFile) {
                                currentConfig.responseFiles = [executionMetadata.responseFile];
                            }
                        } else if (currentConfig.type === 'batch') {
                            // Batch execution: Multiple response files from batch members
                            // Use ServiceTokens directly since BatchExecutionEngine isn't in ExecutionServiceTokens
                            try {
                                const batchEngine = (reportManager.ports.batchEngine as unknown) as any;
                                if (batchEngine && typeof batchEngine.getBatchMembers === 'function') {
                                    const batchMembers = await batchEngine.getBatchMembers(executionId);
                                    const responseFiles = batchMembers
                                        .map((member: any) => member.responseFile)
                                        .filter((file: string | undefined) => !!file);
                                    currentConfig.responseFiles = responseFiles;

                                    // Update status map so classification reflects current member statuses
                                    const responseFileStatusMap: Record<string, string> = {};
                                    const responseFileDetails: Record<string, ResponseFileDetail> = {};
                                    batchMembers.forEach((member: { responseFile?: string; status?: string; errorMessage?: string; testStatus?: string }) => {
                                        if (member.responseFile && member.status) {
                                            responseFileStatusMap[member.responseFile] = member.status;
                                        }
                                        if (member.responseFile && (member.errorMessage || member.testStatus)) {
                                            responseFileDetails[member.responseFile] = { errorMessage: member.errorMessage, testStatus: member.testStatus };
                                        }
                                    });
                                    currentConfig.responseFileStatusMap = responseFileStatusMap;
                                    currentConfig.responseFileDetails = responseFileDetails;
                                }
                            } catch (error) {
                                // Silently handle batch member retrieval errors
                            }
                        }
                    }

                    // Create default report config
                    const reportConfig = {
                        viewMode: 'auto' as const,
                        maxRows: 10000,
                        flattenNested: true,
                        arrayStrategy: 'concatenate' as const
                    };

                    // NOW reload raw data with updated config
                    const refreshedData = await reportManager.extractRawData(currentConfig, reportConfig);
                    reportManager.loadedRawData = refreshedData;

                    // When forceReload, send refreshed data to webview so tables update
                    if (statusUpdate.forceReload && refreshedData) {
                        await reportManager.post({
                            ...createResponseMessage(`refresh_${Date.now()}`, true),
                            type: ConsoleMessageTypes.TABLE_DATA_RESPONSE,
                            payload: { rawData: refreshedData }
                        });
                    }
                }

                await reportManager.post({
                    type: 'status_update',
                    correlationId: `status_update_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: statusUpdate
                });
            } catch (error) {
                reportManager.logError(`Failed to send status update to report ${executionId}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /**
     * Static method to send batch member status updates (e.g. pending → running) to any active Console
     */
    static async sendMemberStatusUpdate(
        batchId: string,
        executionIds: string[],
        status: string,
        memberIndices?: Record<string, number>,
        memberEndpointInfo?: Record<string, { endpointPath?: string; requestHeaders?: Record<string, string>; requestQueryParams?: Record<string, string> }>
    ): Promise<void> {
        const consoleManager = ConsoleController.activeConsoles.get(batchId);
        if (consoleManager) {
            await consoleManager.post({
                type: 'batch_member_status_update',
                correlationId: `member_status_${Date.now()}`,
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: { executionIds, status, batchId, memberIndices, memberEndpointInfo }
            });
        }
    }

    /**
     * Static method to send batch member result updates to any active report
     */
    static async sendMemberResultUpdate(batchId: string, memberResult: {
        result: any; // RawResponse
        classification: 'success' | 'errors';
        memberIndex: number;
        totalMembers: number;
    }): Promise<void> {

        const reportManager = ConsoleController.activeConsoles.get(batchId);

        if (reportManager) {
            try {
                await reportManager.post({
                    type: 'batch_member_result_update',
                    correlationId: `member_result_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: {
                        result: memberResult.result,
                        classification: memberResult.classification,
                        memberIndex: memberResult.memberIndex,
                        totalMembers: memberResult.totalMembers,
                        batchId
                    }
                });

                // GitHub Issue #94: Extract totalPages from first successful response
                // Fix: RawResponse structure uses .data, not .response.body (batch-execution-engine.service.ts:2626)
                if (reportManager.paginationState &&
                    !reportManager.paginationState.totalPages &&
                    memberResult.classification === 'success' &&
                    memberResult.result?.data) {

                    const paginationState = reportManager.paginationState;
                    let totalCountPath = paginationState.config.totalCountPath;
                    const responseBody = memberResult.result.data; // Response body is at .data

                    if (totalCountPath) {
                        // Fix: Template path starts from response file root (e.g., "data.response.total")
                        // But we're passing memberResult.result.data (already extracted data object)
                        // So strip leading "data." prefix if present
                        if (totalCountPath.startsWith('data.')) {
                            totalCountPath = totalCountPath.substring(5); // Remove "data."
                        }

                        const paginationDetector = new PaginationDetectorService();

                        // #446: the page size and pages as the API sends them (it may send fewer per page
                        // than asked), from the response; the size asked for when it says nothing
                        const sizeConfig = paginationDetector.detectSize(paginationState.endpoint);
                        const sizePath = sizeConfig.enabled ? sizeConfig.sizePath : undefined;
                        const totalCountNow = paginationDetector.extractTotalCount(responseBody, totalCountPath);
                        const pages = totalCountNow !== null && totalCountNow > 0
                            ? paginationDetector.pagesFor(totalCountNow, paginationState.pageSize, responseBody, sizePath, !paginationState.sizeLearned)
                            : undefined;
                        if (pages) paginationState.sizeLearned = true;
                        if (pages && pages.pageSize !== paginationState.pageSize) {
                            reportManager.log(`Page size from the response: ${pages.pageSize} (asked for ${paginationState.pageSize ?? 'none'})`);
                            paginationState.pageSize = pages.pageSize;
                        }

                        // Only proceed if we have pageSize (from query params or response)
                        if (paginationState.pageSize && pages) {
                            const totalCount = totalCountNow;

                            if (totalCount !== null && totalCount > 0) {
                                const totalPages = pages.totalPages;

                                // Store in state
                                paginationState.totalPages = totalPages;
                                paginationState.totalRecords = totalCount;


                                // GitHub Issue #94: Calculate remaining pages and hasMorePages (R10)
                                const executionMetadataService = reportManager.ports.metadata;
                                let remainingPages = 0;
                                let hasMorePages = false;
                                let currentHighestPage = paginationState.config.startValue;

                                if (executionMetadataService) {
                                    try {
                                        // Get all batch members to find highest page fetched
                                        const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);

                                        // Find highest page number from query params
                                        for (const member of batchMembers) {
                                            if (member.requestQueryParams) {
                                                const pageValue = member.requestQueryParams[paginationState.config.paramKey];
                                                if (pageValue) {
                                                    const pageNum = parseInt(String(pageValue), 10);
                                                    if (!isNaN(pageNum) && pageNum > currentHighestPage) {
                                                        currentHighestPage = pageNum;
                                                    }
                                                }
                                            }
                                        }

                                        // Calculate remaining pages (R10.2)
                                        // remainingPages = totalPages - (highestPageFetched + 1)
                                        // Adjust for 0-indexed vs 1-indexed
                                        const highestFetchedOffset = currentHighestPage - paginationState.config.startValue; // How many pages from start
                                        const fetchedCount = highestFetchedOffset + 1; // Total fetched (including current)
                                        remainingPages = totalPages - fetchedCount;
                                        hasMorePages = remainingPages > 0;

                                    } catch (error) {
                                        reportManager.logError(`Failed to calculate remaining pages`, error instanceof Error ? error : new Error(String(error)));
                                        // Fallback: assume more pages might exist
                                        remainingPages = totalPages - 1;
                                        hasMorePages = true;
                                    }
                                }

                                // Send updated pagination metadata to frontend
                                await reportManager.post({
                                    type: 'paginationMetadata',
                                    correlationId: `pagination_update_${Date.now()}`,
                                    source: 'extension',
                                    target: 'webview',
                                    timestamp: Date.now(),
                                    paginationData: {
                                        enabled: true,
                                        paramKey: paginationState.config.paramKey,
                                        startValue: paginationState.config.startValue,
                                        totalCountPath: paginationState.config.totalCountPath,
                                        templateVariable: paginationState.config.templateVariable,
                                        currentPage: currentHighestPage,
                                        totalPages,
                                        totalRecords: totalCount,
                                        remainingPages,
                                        hasMorePages
                                    }
                                } as any);

                            } else {
                            }
                        }
                    }
                }

                // Update pagination metadata on every successful page (current page, remaining pages)
                if (reportManager.paginationState?.totalPages &&
                    memberResult.classification === 'success') {
                    const paginationState = reportManager.paginationState;
                    const executionMetadataService = reportManager.ports.metadata;
                    if (executionMetadataService) {
                        try {
                            const batchMembers = await executionMetadataService.getBatchMemberExecutions(batchId);
                            let currentHighestPage = paginationState.config.startValue;
                            for (const member of batchMembers) {
                                if (member.requestQueryParams) {
                                    const pageValue = member.requestQueryParams[paginationState.config.paramKey];
                                    if (pageValue) {
                                        const pageNum = parseInt(String(pageValue), 10);
                                        if (!isNaN(pageNum) && pageNum > currentHighestPage) {
                                            currentHighestPage = pageNum;
                                        }
                                    }
                                }
                            }
                            const highestFetchedOffset = currentHighestPage - paginationState.config.startValue;
                            const fetchedCount = highestFetchedOffset + 1;
                            const remainingPages = paginationState.totalPages! - fetchedCount;
                            const hasMorePages = remainingPages > 0;

                            await reportManager.post({
                                type: 'paginationMetadata',
                                correlationId: `pagination_progress_${Date.now()}`,
                                source: 'extension',
                                target: 'webview',
                                timestamp: Date.now(),
                                paginationData: {
                                    enabled: true,
                                    paramKey: paginationState.config.paramKey,
                                    startValue: paginationState.config.startValue,
                                    totalCountPath: paginationState.config.totalCountPath,
                                    templateVariable: paginationState.config.templateVariable,
                                    currentPage: currentHighestPage,
                                    totalPages: paginationState.totalPages,
                                    totalRecords: paginationState.totalRecords,
                                    remainingPages,
                                    hasMorePages
                                }
                            } as any);
                        } catch (_) {
                            // Non-critical — UI just won't update this tick
                        }
                    }
                }

                // Auto-fetch remaining pages if a pending fetch mode was stored from initial execution
                // Uses static Map (keyed by endpointId) to survive across console instances
                const endpointId = reportManager.currentConfig?.endpointId;
                const pending = endpointId ? ConsoleController.pendingFetchModes.get(endpointId) : undefined;
                // The fetch mode belongs to the first page's first result. If
                // that page failed, drop it — a later reprocess of the page
                // must not quietly fetch the rest (Issue #198).
                if (pending && endpointId) { ConsoleController.pendingFetchModes.delete(endpointId); }
                if (pending && memberResult.classification === 'success') {
                    const pState = reportManager.paginationState;
                    const startVal = pState?.config?.startValue ?? 0;


                    const syntheticMessage: BaseMessage = {
                        type: 'getPageRange',
                        correlationId: `auto_fetch_${Date.now()}`,
                        source: 'extension',
                        target: 'extension',
                        timestamp: Date.now(),
                        payload: { batchId, fromPage: 0, toPage: 0 } // Placeholder, set below
                    };

                    if (pending.mode === 'all' && pState?.totalPages) {
                        // totalPages was successfully calculated — use getAllPages
                        // getAllPages delegates to handleGetPageRange internally
                        syntheticMessage.type = 'getAllPages';
                        syntheticMessage.payload = { batchId, skipConcurrencyPrompt: true };
                        reportManager.handleGetAllPages(syntheticMessage).catch((err: unknown) => {
                            reportManager.logError('Auto-fetch all pages failed', err instanceof Error ? err : new Error(String(err)));
                        });
                    } else {
                        // Either 'next' mode or 'all' without totalPages — use getPageRange
                        const fromPage = startVal + 1; // Page after the first page (startVal)
                        const count = pending.mode === 'all'
                            ? (pState?.totalPages ? pState.totalPages - 1 : 99) // Fallback: fetch up to 99 more
                            : (pending.count || 1);
                        const toPage = fromPage + count - 1;
                        syntheticMessage.payload = { batchId, fromPage, toPage, skipConcurrencyPrompt: true };
                        reportManager.handleGetPageRange(syntheticMessage).catch((err: unknown) => {
                            reportManager.logError('Auto-fetch page range failed', err instanceof Error ? err : new Error(String(err)));
                        });
                    }
                }
            } catch (error) {
                reportManager.logError(`Failed to send member result update to batch report ${batchId}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /**
     * Static method to send progress updates to any active report (GitHub Issue #104)
     * Used by the batch execution engine to send ETA updates to the report webview
     * current/total are optional - progress bar updated by transaction results in frontend
     */
    static async sendProgressUpdate(executionId: string, progressUpdate: {
        status: string;
        current?: number;
        total?: number;
        startTime: number;
        estimatedEndTime: number | null;
        message?: string;
    }): Promise<void> {

        const reportManager = ConsoleController.activeConsoles.get(executionId);

        if (reportManager) {
            try {
                await reportManager.post({
                    type: 'progress_update',
                    correlationId: `progress_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: progressUpdate
                });
            } catch (error) {
                reportManager.logError(`Failed to send progress update to report ${executionId}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /**
     * Static method to send concurrency updates to any active report (GitHub Issue #156)
     * Used by the batch execution engine when thread count is changed dynamically
     */
    static async sendConcurrencyUpdate(batchId: string, concurrencyUpdate: {
        currentConcurrency: number;
        maxConcurrency: number;
        oldConcurrency?: number;
        projectedEtaMs?: number | null;
    }): Promise<void> {

        const reportManager = ConsoleController.activeConsoles.get(batchId);

        if (reportManager) {
            try {
                await reportManager.post({
                    type: 'concurrency_updated',
                    correlationId: `concurrency_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: concurrencyUpdate
                });
            } catch (error) {
                reportManager.logError(`Failed to send concurrency update to report ${batchId}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /**
     * Static method to clear error transactions from webview when reprocessing
     * Called when user chooses to reprocess failed transactions on resume
     */
    static async sendClearErrors(batchId: string): Promise<void> {
        const reportManager = ConsoleController.activeConsoles.get(batchId);

        if (reportManager) {
            try {
                await reportManager.post({
                    type: 'clear_errors',
                    correlationId: `clear_errors_${Date.now()}`,
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: { batchId }
                });
                reportManager.log(`[sendClearErrors] Sent clear_errors message for batch ${batchId}`);
            } catch (error) {
                reportManager.logError(`Failed to send clear_errors to report ${batchId}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /**
     * Clean up on disposal
     */
    dispose(): void {
        // No more live updates for this Console
        for (const [id, controller] of ConsoleController.activeConsoles) {
            if (controller === this) ConsoleController.activeConsoles.delete(id);
        }
        this.session.dismissAll();
        // Clean up all active log streaming callbacks
        for (const [sessionKey, unregisterCallback] of this.activeLogStreamCallbacks) {
            try {
                unregisterCallback();
                this.log(`Cleaned up log streaming for ${sessionKey}`);
            } catch (error) {
                this.logError(`Failed to cleanup log streaming for ${sessionKey}`, error instanceof Error ? error : new Error(String(error)));
            }
        }
        this.activeLogStreamCallbacks.clear();

        this.currentConfig = undefined;
        this.loadedTableData = undefined;
        this.loadedRawData = undefined;
        this.loadedTabbedData = undefined;
    }
}