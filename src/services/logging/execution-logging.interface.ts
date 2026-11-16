// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd

/**
 * Structured log event for execution lifecycle tracking
 */
export interface LogEvent {
    /** ISO timestamp of the log event */
    timestamp: string;
    
    /** Log severity level */
    level: 'info' | 'warn' | 'error' | 'debug';
    
    /** Execution phase being logged */
    phase: 'preparation' | 'execution' | 'test' | 'completion' | 'orchestration' | 'general';
    
    /** Specific event name within the phase */
    event: string;
    
    /** Optional structured data associated with the event */
    data?: Record<string, any>;
    
    /** Error information if level is 'error' */
    error?: {
        message: string;
        stack?: string;
        code?: string;
        httpStatus?: number;
    };
    
    /** Request/response metadata for HTTP operations */
    http?: {
        method?: string;
        path?: string;
        url?: string;  // Full URL including base URL
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        queryParams?: Record<string, string>;
        body?: string | any;  // Request body
        duration?: number;
        size?: number;
    };
}

/**
 * Log query filters for retrieving execution logs
 */
export interface LogQueryFilters {
    /** Filter by log level */
    level?: LogEvent['level'] | LogEvent['level'][];
    
    /** Filter by execution phase */
    phase?: LogEvent['phase'] | LogEvent['phase'][];
    
    /** Filter by event name */
    event?: string | string[];
    
    /** Filter by timestamp range */
    fromTimestamp?: Date;
    toTimestamp?: Date;
    
    /** Limit number of results */
    limit?: number;
    
    /** Skip number of results (for pagination) */
    offset?: number;
}

/**
 * Service interface for execution logging operations
 * Provides structured logging capabilities for the execution lifecycle
 */
export interface IExecutionLoggingService {
    /**
     * Create a log file for an execution and return the file path
     * @param executionId - Unique execution identifier
     * @param requestFile - Path to the associated request file
     * @returns Promise resolving to the log file path
     */
    createLogFile(executionId: string, requestFile: string): Promise<string>;
    
    /**
     * Log a structured event to the specified log file
     * @param logPath - File path to write the log event
     * @param event - Structured log event to write
     */
    logEvent(logPath: string, event: LogEvent): Promise<void>;
    
    /**
     * Convenience method to log an event directly by execution ID
     * @param executionId - Unique execution identifier
     * @param event - Structured log event to write
     */
    logExecutionEvent(executionId: string, event: LogEvent): Promise<void>;
    
    /**
     * Retrieve all log events for a specific execution
     * @param executionId - Unique execution identifier
     * @param filters - Optional filters to apply
     * @returns Promise resolving to array of log events
     */
    getExecutionLogs(executionId: string, filters?: LogQueryFilters): Promise<LogEvent[]>;
    
    /**
     * Retrieve log events from a specific log file
     * @param logPath - File path to read log events from
     * @param filters - Optional filters to apply
     * @returns Promise resolving to array of log events
     */
    getLogsFromFile(logPath: string, filters?: LogQueryFilters): Promise<LogEvent[]>;
    
    /**
     * Get the log file path for a given execution ID
     * @param executionId - Unique execution identifier
     * @returns Promise resolving to the log file path, or undefined if not found
     */
    getLogPath(executionId: string): Promise<string | undefined>;
    
    /**
     * Start live log streaming to a webview via callback
     * Similar to startLiveLogStreaming but sends formatted content to callback instead of output channel
     * Filters to specific execution or batch IDs
     * @param onLogUpdate - Callback invoked with formatted log content when new events occur
     * @param executionId - Optional specific execution ID to filter
     * @param batchId - Optional batch ID to filter (includes batch + all member logs)
     * @returns Function to stop streaming and unregister callback
     */
    startWebviewLogStreaming(
        onLogUpdate: (formattedContent: string) => void,
        executionId?: string,
        batchId?: string
    ): () => void;

    /**
     * Register a callback to be called when new log events are written
     * @param callback - Function to call with new log events
     * @returns Function to unregister the callback
     */
    onLogEvent(callback: (executionId: string, event: LogEvent) => void): () => void;
    
    /**
     * Format individual transaction logs for display
     * @param executionId - Individual execution identifier
     * @returns Promise resolving to array of formatted log lines
     */
    formatIndividualTransactionLogs(executionId: string): Promise<string[]>;

    /**
     * Stream batch logs progressively to webview with chunked delivery (GitHub Issue #94)
     * Enables immediate first chunk delivery (~0.1s) instead of loading all logs first (14s+)
     * @param batchId - Batch execution identifier
     * @param onChunk - Callback invoked for each chunk of formatted log entries
     * @param chunkSize - Number of log entries per chunk (default: 1000)
     * @returns Promise resolving when streaming is complete
     */
    streamBatchLogsToWebview(
        batchId: string,
        onChunk: (chunk: string[], progress: { loaded: number; total: number }) => Promise<void>,
        chunkSize?: number
    ): Promise<void>;

    /**
     * Simple logging API - Convenience methods for easy logging
     */
    log(executionId: string, level: 'info' | 'warn' | 'error' | 'debug', message: string): Promise<void>;
    info(executionId: string, message: string): Promise<void>;
    warn(executionId: string, message: string): Promise<void>;
    error(executionId: string, message: string): Promise<void>;
    debug(executionId: string, message: string): Promise<void>;

    /**
     * Clear log path cache entries for given execution IDs (memory cleanup after batch completion)
     * @param executionIds - Array of execution IDs to clear from cache
     */
    clearLogPathCache(executionIds: string[]): void;
}

/**
 * Dependencies required by ExecutionLoggingService
 */
export interface ExecutionLoggingServiceDependencies {
    /** File system operations for log file management */
    fileSystemService?: any; // IFileSystemService when available
    
    /** Execution metadata for retrieving execution details */
    executionMetadataService?: any; // IExecutionMetadataService when available
}