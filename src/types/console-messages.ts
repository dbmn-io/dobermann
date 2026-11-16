// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Console Message Types
 *
 * Defines console-specific message types for webview communication.
 * Relocated from src/messaging/console-messages.ts (GitHub Issue #194).
 */

import {
    BaseMessage,
    RequestMessage,
    ResponseMessage,
    EventMessage
} from './base-message';

// Console Message Types
export const ConsoleMessageTypes = {
    // Data requests
    GET_TABLE_DATA: 'console.get_table_data',
    EXPORT_DATA: 'console.export_data',
    EXPORT_TO_CLIPBOARD: 'console.export_to_clipboard',  // GitHub Issue #120: Copy CSV to clipboard
    UPDATE_VIEW_STATE: 'console.update_view_state',
    CHANGE_TAB: 'console.change_tab',
    CHANGE_ROOT_PATH: 'console.change_root_path',

    // NEW: Request and Logs tab support
    REFRESH_REPORT: 'console.refresh_report',
    START_LOG_STREAM: 'console.start_log_stream',
    STOP_LOG_STREAM: 'console.stop_log_stream',
    LOAD_LOGS: 'console.load_logs',  // GitHub Issue #94: Lazy load logs

    // GitHub Issue #102: Diagnostic stats
    REQUEST_DATABASE_COUNT: 'console.request_database_count',
    DATABASE_COUNT_RESPONSE: 'console.database_count_response',

    // GitHub Issue #166: Raw file viewing
    GET_RAW_INPUT_FILE: 'console.get_raw_input_file',
    GET_TRANSACTION_RAW_FILES: 'console.get_transaction_raw_files',
    RAW_INPUT_FILE_RESPONSE: 'console.raw_input_file_response',
    TRANSACTION_RAW_FILES_RESPONSE: 'console.transaction_raw_files_response',
    // GitHub Issue #166: RAW tab data loading
    GET_RAW_TAB_DATA: 'console.get_raw_tab_data',
    GET_RAW_TRANSACTION_CONTENT: 'console.get_raw_transaction_content',
    RAW_TAB_DATA_RESPONSE: 'console.raw_tab_data_response',
    RAW_TRANSACTION_CONTENT_RESPONSE: 'console.raw_transaction_content_response',
    // GitHub Issue #166: Transaction logs modal
    GET_TRANSACTION_LOG: 'console.get_transaction_log',
    TRANSACTION_LOG_RESPONSE: 'console.transaction_log_response',

    // Settings management
    SAVE_REPORT_SETTINGS: 'console.save_settings',

    // Response messages
    TABLE_DATA_RESPONSE: 'console.table_data_response',
    // GitHub Issue #312: a large batch streams in — the first chunk rides in
    // TABLE_DATA_RESPONSE (payload.streaming set), the rest arrive as these
    RAW_CHUNK: 'console.raw_chunk',
    EXPORT_STARTED: 'console.export_started',
    EXPORT_COMPLETE: 'console.export_complete',
    CLIPBOARD_READY: 'console.clipboard_ready',  // GitHub Issue #120: CSV ready for clipboard
    REPORT_REFRESHED: 'console.report_refreshed',
    LOG_STREAM_UPDATE: 'console.log_stream_update',

    // Events
    DATA_LOADING_STARTED: 'console.data_loading_started',
    DATA_LOADING_COMPLETED: 'console.data_loading_completed',
    EXPORT_PROGRESS: 'console.export_progress',
    LOGS_CHUNK_LOADED: 'console.logs_chunk_loaded',  // GitHub Issue #94: Progressive log loading
    BATCH_MEMBER_RESULT_UPDATE: 'console.batch_member_result_update'  // Live batch member result streaming
} as const;

// Request message interfaces
export interface GetTableDataRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_TABLE_DATA;
    payload: {
        executionId?: string;
        batchId?: string;
        responseFiles: string[];
        config: ConsoleConfig;
    };
}

export interface ExportDataRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.EXPORT_DATA;
    payload: {
        format: ExportFormat;
        tab: 'input' | 'success' | 'errors';
        searchTerm?: string;
        options?: ExportOptions;
    };
}

export interface ExportToClipboardRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.EXPORT_TO_CLIPBOARD;
    payload: {
        tab: 'input' | 'success' | 'errors';
        format?: ClipboardFormat;  // GitHub Issue #174: Support multiple clipboard formats
        searchTerm?: string;
        options?: ExportOptions;
    };
}

export interface UpdateViewStateRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.UPDATE_VIEW_STATE;
    payload: {
        sortColumn?: string;
        sortDirection?: 'asc' | 'desc';
        filters?: Record<string, unknown>;
        visibleColumns?: string[];
    };
}

export interface ChangeTabRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.CHANGE_TAB;
    payload: {
        tab: 'request' | 'logs' | 'input' | 'success' | 'errors';
        config?: TabConfig;
    };
}

export interface ChangeRootPathRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.CHANGE_ROOT_PATH;
    payload: {
        tab: 'request' | 'logs' | 'input' | 'success' | 'errors';
        rootPath: string;
        refreshData: boolean;
    };
}

// Response message interfaces
/** GitHub Issue #312: how much of a large batch the page holds so far. */
export interface StreamingProgress {
    loaded: number;
    total: number;
    inputLoaded: number;
    inputTotal: number;
}

export interface TableDataResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.TABLE_DATA_RESPONSE;
    payload: {
        // New raw data format (the RIGHT way)
        rawData?: RawConsoleData;
        // GitHub Issue #312: set when rawData holds only the first chunk of a
        // large batch — of its responses (loaded/total) and/or of its input
        // rows (inputLoaded/inputTotal); RAW_CHUNK messages bring the rest
        streaming?: StreamingProgress;
        // Legacy individual report format
        tableData?: ExtractedTableData;
        structureAnalysis?: StructureAnalysis;
        performanceMetrics?: PerformanceMetrics;
        // Legacy tabbed report format
        input?: TabData;
        success?: TabData;
        errors?: TabData;
        metadata?: ResponseMetadata;
    };
}

export interface ExportStartedEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.EXPORT_STARTED;
    payload: {
        filename: string;
        format: ExportFormat;
        rowCount: number;
    };
}

export interface ExportCompleteResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.EXPORT_COMPLETE;
    payload: {
        filePath: string;
        format: ExportFormat;
        rowCount: number;
        success: boolean;
    };
}

export interface ClipboardReadyResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.CLIPBOARD_READY;
    payload: {
        content?: string;  // GitHub Issue #200: Optional when clipboardWritten is true
        htmlContent?: string;  // GitHub Issue #225: Type-aware HTML for dual-format clipboard
        rowCount: number;
        columnCount: number;
        format?: ClipboardFormat;  // GitHub Issue #174: Include format in response
        clipboardWritten?: boolean;  // GitHub Issue #200: Backend wrote clipboard directly
    };
}

// Event message interfaces
export interface DataLoadingStartedEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.DATA_LOADING_STARTED;
    payload: {
        executionId?: string;
        batchId?: string;
        fileCount: number;
    };
}

export interface DataLoadingCompletedEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.DATA_LOADING_COMPLETED;
    payload: {
        executionId?: string;
        batchId?: string;
        rowCount: number;
        duration: number;
    };
}

export interface ExportProgressEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.EXPORT_PROGRESS;
    payload: {
        format: ExportFormat;
        progress: number;
        rowsProcessed: number;
        totalRows: number;
    };
}

// Type definitions
export interface ConsoleConfig {
    viewMode: 'auto' | 'table' | 'tree' | 'modal';
    maxRows?: number;
    flattenNested?: boolean;
    arrayStrategy?: 'concatenate' | 'inline' | 'modal';
    activeTab?: 'input' | 'success' | 'errors';
    tabConfigs?: {
        input?: TabConfig;
        success?: TabConfig;
        errors?: TabConfig;
    };
}

export interface TabConfig {
    rootPath: string;
    visibleColumns?: string[];
    sortColumns?: SortConfig[];
    filters?: FilterConfig[];
}

export interface SortConfig {
    columnId: string;
    direction: 'asc' | 'desc';
    priority: number;
}

export interface FilterConfig {
    columnId: string;
    value: string;
    operator: 'equals' | 'contains' | 'startsWith' | 'endsWith';
}

export interface ExtractedTableData {
    rows: TableRow[];
    columns: ColumnDefinition[];
    metadata: ResponseMetadata;
}

// Raw response data structure - the RIGHT way
export interface RawConsoleData {
    responses: RawResponse[];
    inputData?: TableRow[];
    availablePaths: PathInfo[];
    metadata: ResponseMetadata;
    // NEW: Request and Logs tab support
    requestContent?: string;      // For individual request JSON content
    hasValidRequest?: boolean;    // Flag to show/hide Request tab
    logContent?: string[];        // For formatted log content (array of display lines)
    isStreaming?: boolean;        // Flag for active log streaming
    lastRefreshed?: Date;         // Track last refresh time
    // GitHub Issue #101: Request headers and query parameters
    requestHeaders?: Record<string, string>;
    requestQueryParams?: Record<string, string>;
    // Issue #248: names of {{template variables}} referenced by the endpoint
    // (body / path / headers / queryParams). Drives the Input tab's auto-generated
    // "Mapped Columns" view. Empty when the endpoint has no template variables.
    mappedVariableNames?: string[];
}

export interface RawResponse {
    httpStatus: number | string;
    httpStatusText?: string; // GitHub Issue #2: HTTP status text (e.g., "OK", "Created")
    status?: string; // Database status for classification (completed, error, etc.)
    data: unknown; // The actual response body
    headers?: Record<string, string>; // GitHub Issue #2: Response headers from stored response files
    metadata: {
        executionId?: string;
        sourceFile?: string;
        responseTime?: number;
        timestamp?: string;
        status?: string; // Also in metadata for consistency
    };
}

// Legacy interfaces - will be phased out
export interface TabbedConsoleData {
    input?: TabData;
    success?: TabData;
    errors?: TabData;
    metadata: ResponseMetadata;
}

export interface TabData {
    type: 'request' | 'logs' | 'input' | 'success' | 'errors';
    rows: TableRow[];
    columns: ColumnDefinition[];
    count: number;
    rootPath: string;
    availablePaths: PathInfo[];
}

export interface PathInfo {
    path: string;
    type: 'object' | 'array' | 'primitive';
    depth: number;
    itemCount?: number;
    recommended: boolean;
    description: string;
}

export interface TableRow {
    [key: string]: unknown;
}

export interface ColumnDefinition {
    id: string;
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array';
    sortable: boolean;
    filterable: boolean;
    nested?: boolean;
    arrayInfo?: ArrayInfo;
}

export interface ResponseMetadata {
    totalRows: number;
    executionId?: string;
    batchId?: string;
    rows?: string;  // GitHub Issue #102: Expected transaction count format "77(308)" = 77 transactions from 308 CSV rows
    extractionTime: number;
    dataType: 'individual' | 'batch' | 'raw';
}

export interface StructureAnalysis {
    type: 'array' | 'object' | 'primitive';
    depth: number;
    arrayPaths: ArrayInfo[];
    objectPaths: ObjectInfo[];
    suggestedView: 'table' | 'tree' | 'modal';
    flatteningStrategy: FlatteningStrategy;
}

export interface ArrayInfo {
    path: string;
    length: number;
    strategy: 'concatenate' | 'inline' | 'modal';
    itemType: string;
}

export interface ObjectInfo {
    path: string;
    properties: string[];
    depth: number;
}

export interface FlatteningStrategy {
    enabled: boolean;
    maxDepth: number;
    separator: string;
    arrayHandling: 'concatenate' | 'expand' | 'modal';
}

export interface PerformanceMetrics {
    extractionTime: number;
    fileCount: number;
    rowCount: number;
    columnCount: number;
    memoryUsage?: number;
}

export type ExportFormat = 'csv' | 'excel' | 'json' | 'sql';

// GitHub Issue #174: Clipboard format types for copy operations
export type ClipboardFormat = 'csv' | 'tsv' | 'html' | 'markdown';

export interface ExportOptions {
    fileName?: string;
    targetUri?: string; // User-selected file path via save dialog (for backward compatibility)
    includeHeaders: boolean;
    encoding?: 'utf8' | 'utf16le';
    delimiter?: string;
    quoteChar?: string;
    escapeChar?: string;
    preserveNesting?: boolean;
    multipleSheets?: boolean; // Excel only
    jsonFormat?: 'formatted' | 'minified'; // JSON only - formatted (pretty-printed) or minified (compact)
    arrayWarning?: string; // Warning message about nested arrays in CSV export
    tab?: 'input' | 'success' | 'errors'; // GitHub Issue #174: Tab context for header colour
    /**
     * GitHub Issue #225: When true, prefix string-typed values with ' so Excel
     * preserves them as text (leading zeros, large numbers). Only affects clipboard
     * CSV copies — never file exports. Default false.
     */
    excelSafeStrings?: boolean;
}

// NEW: Request and Logs message interfaces
export interface RefreshConsoleRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.REFRESH_REPORT;
    payload: {
        executionId: string;
        batchId?: string;
    };
}

export interface StartLogStreamRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.START_LOG_STREAM;
    payload: {
        executionId: string;
        batchId?: string;
    };
}

export interface StopLogStreamRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.STOP_LOG_STREAM;
    payload: {
        executionId: string;
        batchId?: string;
    };
}

export interface SaveConsoleSettingsRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.SAVE_REPORT_SETTINGS;
    payload: {
        endpointId: string;
        settings: {
            success: {
                rootPath: string;
                visibleColumns: string[];
            };
            errors: {
                rootPath: string;
                visibleColumns: string[];
            };
        };
    };
}

export interface LoadLogsRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.LOAD_LOGS;
    payload: {
        batchId: string;
        progressiveLoad: boolean;
    };
}

export interface DatabaseCountRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.REQUEST_DATABASE_COUNT;
    payload: {
        batchId: string;
    };
}

export interface DatabaseCountResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.DATABASE_COUNT_RESPONSE;
    payload: {
        batchId: string;
        count: number;
    };
}

export interface ConsoleRefreshedResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.REPORT_REFRESHED;
    payload: {
        rawData: RawConsoleData;
        lastRefreshed: Date;
    };
}

export interface LogStreamUpdateEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.LOG_STREAM_UPDATE;
    payload: {
        content: string;
        isComplete?: boolean;
        executionId: string;
    };
}

export interface LogsChunkLoadedEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.LOGS_CHUNK_LOADED;
    payload: {
        chunk: string[];
        progress: {
            loaded: number;
            total: number;
            percentage: number;
        };
        isComplete: boolean;
    };
}

export interface BatchMemberResultEvent extends EventMessage {
    type: typeof ConsoleMessageTypes.BATCH_MEMBER_RESULT_UPDATE;
    payload: {
        result: RawResponse;
        classification: 'success' | 'errors';
        memberIndex: number;
        totalMembers: number;
        batchId: string;
    };
}

// GitHub Issue #166: Raw file viewing request/response interfaces
export interface GetRawInputFileRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_RAW_INPUT_FILE;
    payload: {
        batchId: string;
    };
}

export interface RawInputFileResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.RAW_INPUT_FILE_RESPONSE;
    payload: {
        content: string;
        fileName: string;
        lineCount: number;
    };
}

export interface GetTransactionRawFilesRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_TRANSACTION_RAW_FILES;
    payload: {
        executionId: string;
        batchId?: string;
    };
}

export interface TransactionRawFile {
    executionId: string;
    httpStatus: number | string;
    requestJson: string;
    responseJson: string;
    isSuccess: boolean;
    timestamp?: string;
}

export interface TransactionRawFilesResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.TRANSACTION_RAW_FILES_RESPONSE;
    payload: {
        transaction: TransactionRawFile;
    };
}

// GitHub Issue #166: RAW tab data interfaces
export interface GetRawTabDataRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_RAW_TAB_DATA;
    payload: {
        batchId?: string;
        executionId?: string;  // For individual transactions
    };
}

export interface RawTransactionSummary {
    executionId: string;
    status: string;
    httpStatus: number | string;
    timestamp?: string;
    hasRequest: boolean;
    hasResponse: boolean;
    requestFile?: string;
    responseFile?: string;
    // GitHub Issue #166: CSV row mapping for Data toggle
    rowStart?: number;  // 1-based starting row index
    rows?: string;      // Number of rows (e.g., "3" for 3 CSV rows)
    // GitHub Issue #201: Per-transaction endpoint data for RAW tab Details
    endpointPath?: string;
    requestHeaders?: Record<string, string>;
    requestQueryParams?: Record<string, string>;
    logPath?: string;
    // In-batch reprocess tracking
    reprocessCount?: number;
}

export interface RawTabDataResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.RAW_TAB_DATA_RESPONSE;
    payload: {
        transactions: RawTransactionSummary[];
        totalCount: number;
        statusCounts: Record<string, number>;
    };
}

export interface GetRawTransactionContentRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_RAW_TRANSACTION_CONTENT;
    payload: {
        executionIds: string[];  // Batch load multiple at once
    };
}

export interface RawTransactionContent {
    executionId: string;
    requestContent: string | null;
    responseContent: string | null;
    error?: string;
}

export interface RawTransactionContentResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.RAW_TRANSACTION_CONTENT_RESPONSE;
    payload: {
        contents: RawTransactionContent[];
    };
}

// GitHub Issue #166: Transaction log modal
export interface GetTransactionLogRequest extends RequestMessage {
    type: typeof ConsoleMessageTypes.GET_TRANSACTION_LOG;
    payload: {
        logFilePath: string;
        executionId: string;
        transactionIndex: number;
    };
}

export interface TransactionLogResponse extends ResponseMessage {
    type: typeof ConsoleMessageTypes.TRANSACTION_LOG_RESPONSE;
    payload: {
        content: string;
        executionId: string;
        transactionIndex: number;
        error?: string;
    };
}

// Type guards
export function isGetTableDataRequest(message: BaseMessage): message is GetTableDataRequest {
    return message.type === ConsoleMessageTypes.GET_TABLE_DATA;
}

export function isExportDataRequest(message: BaseMessage): message is ExportDataRequest {
    return message.type === ConsoleMessageTypes.EXPORT_DATA;
}

export function isExportToClipboardRequest(message: BaseMessage): message is ExportToClipboardRequest {
    return message.type === ConsoleMessageTypes.EXPORT_TO_CLIPBOARD;
}

export function isUpdateViewStateRequest(message: BaseMessage): message is UpdateViewStateRequest {
    return message.type === ConsoleMessageTypes.UPDATE_VIEW_STATE;
}

export function isChangeTabRequest(message: BaseMessage): message is ChangeTabRequest {
    return message.type === ConsoleMessageTypes.CHANGE_TAB;
}

export function isChangeRootPathRequest(message: BaseMessage): message is ChangeRootPathRequest {
    return message.type === ConsoleMessageTypes.CHANGE_ROOT_PATH;
}

export function isTableDataResponse(message: BaseMessage): message is TableDataResponse {
    return message.type === ConsoleMessageTypes.TABLE_DATA_RESPONSE;
}

export function isExportCompleteResponse(message: BaseMessage): message is ExportCompleteResponse {
    return message.type === ConsoleMessageTypes.EXPORT_COMPLETE;
}

export function isClipboardReadyResponse(message: BaseMessage): message is ClipboardReadyResponse {
    return message.type === ConsoleMessageTypes.CLIPBOARD_READY;
}

// NEW: Type guards for Request and Logs messages
export function isRefreshConsoleRequest(message: BaseMessage): message is RefreshConsoleRequest {
    return message.type === ConsoleMessageTypes.REFRESH_REPORT;
}

export function isStartLogStreamRequest(message: BaseMessage): message is StartLogStreamRequest {
    return message.type === ConsoleMessageTypes.START_LOG_STREAM;
}

export function isStopLogStreamRequest(message: BaseMessage): message is StopLogStreamRequest {
    return message.type === ConsoleMessageTypes.STOP_LOG_STREAM;
}

export function isSaveConsoleSettingsRequest(message: BaseMessage): message is SaveConsoleSettingsRequest {
    return message.type === ConsoleMessageTypes.SAVE_REPORT_SETTINGS;
}

export function isConsoleRefreshedResponse(message: BaseMessage): message is ConsoleRefreshedResponse {
    return message.type === ConsoleMessageTypes.REPORT_REFRESHED;
}

export function isLogStreamUpdateEvent(message: BaseMessage): message is LogStreamUpdateEvent {
    return message.type === ConsoleMessageTypes.LOG_STREAM_UPDATE;
}

export function isLoadLogsRequest(message: BaseMessage): message is LoadLogsRequest {
    return message.type === ConsoleMessageTypes.LOAD_LOGS;
}

export function isLogsChunkLoadedEvent(message: BaseMessage): message is LogsChunkLoadedEvent {
    return message.type === ConsoleMessageTypes.LOGS_CHUNK_LOADED;
}

export function isBatchMemberResultEvent(message: BaseMessage): message is BatchMemberResultEvent {
    return message.type === ConsoleMessageTypes.BATCH_MEMBER_RESULT_UPDATE;
}

export function isDatabaseCountRequest(message: BaseMessage): message is DatabaseCountRequest {
    return message.type === ConsoleMessageTypes.REQUEST_DATABASE_COUNT;
}

export function isDatabaseCountResponse(message: BaseMessage): message is DatabaseCountResponse {
    return message.type === ConsoleMessageTypes.DATABASE_COUNT_RESPONSE;
}

// GitHub Issue #166: Type guards for raw file viewing
export function isGetRawInputFileRequest(message: BaseMessage): message is GetRawInputFileRequest {
    return message.type === ConsoleMessageTypes.GET_RAW_INPUT_FILE;
}

export function isRawInputFileResponse(message: BaseMessage): message is RawInputFileResponse {
    return message.type === ConsoleMessageTypes.RAW_INPUT_FILE_RESPONSE;
}

export function isGetTransactionRawFilesRequest(message: BaseMessage): message is GetTransactionRawFilesRequest {
    return message.type === ConsoleMessageTypes.GET_TRANSACTION_RAW_FILES;
}

export function isTransactionRawFilesResponse(message: BaseMessage): message is TransactionRawFilesResponse {
    return message.type === ConsoleMessageTypes.TRANSACTION_RAW_FILES_RESPONSE;
}

// GitHub Issue #166: Type guards for RAW tab data
export function isGetRawTabDataRequest(message: BaseMessage): message is GetRawTabDataRequest {
    return message.type === ConsoleMessageTypes.GET_RAW_TAB_DATA;
}

export function isRawTabDataResponse(message: BaseMessage): message is RawTabDataResponse {
    return message.type === ConsoleMessageTypes.RAW_TAB_DATA_RESPONSE;
}

export function isGetRawTransactionContentRequest(message: BaseMessage): message is GetRawTransactionContentRequest {
    return message.type === ConsoleMessageTypes.GET_RAW_TRANSACTION_CONTENT;
}

export function isGetTransactionLogRequest(message: BaseMessage): message is GetTransactionLogRequest {
    return message.type === ConsoleMessageTypes.GET_TRANSACTION_LOG;
}

export function isRawTransactionContentResponse(message: BaseMessage): message is RawTransactionContentResponse {
    return message.type === ConsoleMessageTypes.RAW_TRANSACTION_CONTENT_RESPONSE;
}
