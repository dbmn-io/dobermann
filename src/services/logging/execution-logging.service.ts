// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { appendRunFile, readRunFileIfExists, runFileExists } from '../run-content/run-content-store';
import { 
    IExecutionLoggingService, 
    LogEvent, 
    LogQueryFilters, 
    ExecutionLoggingServiceDependencies 
} from './execution-logging.interface';
import { IExtensionDiagnosticLogger } from './extension-diagnostic-logger.interface';

/**
 * Extended LogEvent for internal batch processing with source tagging
 */
interface TaggedLogEvent extends LogEvent {
    _sourceExecutionId?: string;
    _sourceMemberInfo?: {
        id: string;
        endpointName?: string;
        memberIndex: number;
        totalMembers: number;
    };
}


/**
 * Implementation of execution logging service using JSON Lines format
 * Stores structured logs alongside request/response files for comprehensive execution history
 */
export class ExecutionLoggingService implements IExecutionLoggingService {
    private dependencies: ExecutionLoggingServiceDependencies;
    private logPathCache = new Map<string, string>();
    private logEventCallbacks: Set<(executionId: string, event: LogEvent) => void> = new Set();

    constructor(
        dependencies: ExecutionLoggingServiceDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.dependencies = dependencies;
    }

    async createLogFile(executionId: string, requestFile: string): Promise<string> {
        try {
            // Generate log file path based on request file naming convention
            // Example: timestamp-endpoint-hash.json -> timestamp-endpoint-hash.log
            const logPath = this.generateLogPath(requestFile);

            // Create empty log file with initial metadata
            const initialLogEvent: LogEvent = {
                timestamp: new Date().toISOString(),
                level: 'info',
                phase: 'preparation',
                event: 'log_file_created',
                data: {
                    executionId,
                    requestFile,
                    logPath
                }
            };
            
            // Write initial log event
            await this.writeLogEvent(logPath, initialLogEvent);
            
            // Cache the log path for future lookups
            this.logPathCache.set(executionId, logPath);
            
            return logPath;
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to create log file for ${executionId}`, error instanceof Error ? error : undefined, { executionId });
            throw new Error(`Failed to create log file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async logEvent(logPath: string, event: LogEvent): Promise<void> {
        try {
            await this.writeLogEvent(logPath, event);
        } catch (error) {
            // Don't throw errors from logging - just log to console to prevent cascade failures
            this.logger.error(`[ExecutionLoggingService] Failed to log event to ${logPath}`, error instanceof Error ? error : undefined, { logPath, event });
        }
    }

    async logExecutionEvent(executionId: string, event: LogEvent): Promise<void> {
        try {

            // Ensure the event data always includes the execution ID
            const eventWithExecutionId = {
                ...event,
                data: {
                    ...event.data,
                    executionId: event.data?.executionId || executionId || 'unknown'
                }
            };

            // Always notify live streaming callbacks (even if no log file exists)
            this.notifyLogEventCallbacks(executionId || 'unknown', eventWithExecutionId);

            // Determine the target execution ID for logging (original transaction for splits)
            const targetExecutionId = await this.resolveTargetExecutionId(executionId);

            // Try to write to file if log path exists
            const logPath = await this.getLogPath(targetExecutionId);
            if (!logPath) {
                // For batch executions without log files, skip file write but streaming still works
                return;
            }

            await this.logEvent(logPath, eventWithExecutionId);
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to log execution event for ${executionId}`, error instanceof Error ? error : undefined, { executionId });
        }
    }

    async getExecutionLogs(executionId: string, filters?: LogQueryFilters): Promise<LogEvent[]> {
        try {
            const logPath = await this.getLogPath(executionId);
            if (!logPath) {
                return [];
            }

            return await this.getLogsFromFile(logPath, filters);
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to get logs for execution ${executionId}`, error instanceof Error ? error : undefined, { executionId });
            return [];
        }
    }

    /**
     * Stream a log's events, a line at a time (GitHub Issue #94). The log is in the run
     * folder's content archive (#358): one execution's log, read whole.
     */
    private async streamLogsFromFile(
        logPath: string,
        onEvent: (event: LogEvent) => Promise<void>,
        filters?: LogQueryFilters
    ): Promise<number> {
        let eventCount = 0;

        try {
            const content = readRunFileIfExists(logPath);
            if (content === undefined) return 0;

            for (const line of content.split('\n')) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                try {
                    const event = JSON.parse(trimmedLine) as LogEvent;

                    // Apply filters
                    if (this.matchesFilters(event, filters)) {
                        await onEvent(event);
                        eventCount++;
                    }
                } catch (parseError) {
                    this.logger.warn(`[ExecutionLoggingService] Failed to parse log line: ${trimmedLine}`, parseError instanceof Error ? parseError : undefined, { line: trimmedLine });
                }
            }

            return eventCount;
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to stream logs from ${logPath}`, error instanceof Error ? error : undefined, { logPath });
            return eventCount;
        }
    }

    /**
     * Stream aggregated batch logs from disk (GitHub Issue #94)
     * Reads log files incrementally and sends chunks as they're read
     */
    private async streamBatchAggregatedLogsFromDisk(
        batchId: string,
        onChunk: (events: TaggedLogEvent[]) => Promise<void>,
        chunkSize: number = 1000,
        filters?: LogQueryFilters
    ): Promise<number> {
        let totalEvents = 0;
        let eventBuffer: TaggedLogEvent[] = [];

        const sendChunk = async () => {
            if (eventBuffer.length > 0) {
                await onChunk([...eventBuffer]);
                totalEvents += eventBuffer.length;
                eventBuffer = [];
            }
        };

        try {
            // 1. Stream batch-level logs first
            const batchLogPath = await this.getLogPath(batchId);
            if (batchLogPath) {
                await this.streamLogsFromFile(
                    batchLogPath,
                    async (event) => {
                        eventBuffer.push(event as TaggedLogEvent);
                        if (eventBuffer.length >= chunkSize) {
                            await sendChunk();
                        }
                    },
                    filters
                );
            }

            // 2. Get all batch members
            if (this.dependencies.executionMetadataService) {
                const batchMembers = await this.getBatchMembers(batchId);

                // 3. Stream logs from each batch member
                for (let i = 0; i < batchMembers.length; i++) {
                    const member = batchMembers[i];
                    const memberLogPath = await this.getLogPath(member.id);

                    if (memberLogPath) {
                        await this.streamLogsFromFile(
                            memberLogPath,
                            async (event) => {
                                // Tag with member information
                                const taggedEvent: TaggedLogEvent = {
                                    ...event,
                                    _sourceExecutionId: member.id,
                                    _sourceMemberInfo: {
                                        id: member.id,
                                        endpointName: member.endpointName,
                                        memberIndex: i + 1,
                                        totalMembers: batchMembers.length
                                    }
                                };

                                eventBuffer.push(taggedEvent);
                                if (eventBuffer.length >= chunkSize) {
                                    await sendChunk();
                                }
                            },
                            filters
                        );
                    }
                }
            }

            // Send any remaining events
            await sendChunk();

            return totalEvents;
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to stream batch logs for ${batchId}`, error instanceof Error ? error : undefined, { batchId });
            // Send any buffered events before throwing
            await sendChunk();
            throw error;
        }
    }

    async getLogsFromFile(logPath: string, filters?: LogQueryFilters): Promise<LogEvent[]> {
        try {
            const fileContent = readRunFileIfExists(logPath);
            if (fileContent === undefined) return [];

            // Parse JSON Lines format
            const lines = fileContent.trim().split('\n').filter(line => line.trim());
            const events: LogEvent[] = [];
            
            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as LogEvent;
                    
                    // Apply filters
                    if (this.matchesFilters(event, filters)) {
                        events.push(event);
                    }
                } catch (parseError) {
                    this.logger.warn(`[ExecutionLoggingService] Failed to parse log line: ${line}`, parseError, { line });
                }
            }
            
            // Apply pagination
            let filteredEvents = events;
            if (filters?.offset) {
                filteredEvents = filteredEvents.slice(filters.offset);
            }
            if (filters?.limit) {
                filteredEvents = filteredEvents.slice(0, filters.limit);
            }
            
            return filteredEvents;
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to read logs from ${logPath}`, error instanceof Error ? error : undefined, { logPath });
            return [];
        }
    }

    async getLogPath(executionId: string): Promise<string | undefined> {
        try {
            // Check cache first
            if (this.logPathCache.has(executionId)) {
                return this.logPathCache.get(executionId);
            }

            // Try to get from execution metadata if service is available
            if (this.dependencies.executionMetadataService) {
                const execution = await this.dependencies.executionMetadataService.getExecution(executionId);

                if (execution) {
                    // Try using stored logPath first
                    if (execution.logPath && runFileExists(execution.logPath)) {
                        this.logPathCache.set(executionId, execution.logPath);
                        return execution.logPath;
                    }
                    
                    // Fallback to generating from requestFile
                    if (execution.requestFile) {
                        const generatedLogPath = this.generateLogPath(execution.requestFile);
                        
                        if (runFileExists(generatedLogPath)) {
                            this.logPathCache.set(executionId, generatedLogPath);
                            return generatedLogPath;
                        }
                    }
                }
            }
            
            return undefined;
        } catch (error) {
            this.logger.error(`[ExecutionLoggingService] Failed to get log path for ${executionId}`, error instanceof Error ? error : undefined, { executionId });
            return undefined;
        }
    }

    /**
     * Clear log path cache entries for given execution IDs (memory cleanup after batch completion)
     */
    clearLogPathCache(executionIds: string[]): void {
        for (const id of executionIds) {
            this.logPathCache.delete(id);
        }
    }

    private generateLogPath(requestFilePath: string): string {
        // Convert request file path to log file path
        // Example: /path/to/timestamp-endpoint-hash.json -> /path/to/timestamp-endpoint-hash.log
        const basePath = requestFilePath.replace(/\.[^/.]+$/, ''); // Remove extension
        return `${basePath}.log`;
    }

    private async writeLogEvent(logPath: string, event: LogEvent): Promise<void> {
        // Ensure timestamp is set
        if (!event.timestamp) {
            event.timestamp = new Date().toISOString();
        }
        
        // Convert to JSON Lines format (single line JSON)
        const logLine = JSON.stringify(event) + '\n';
        
        // Into the run folder's content archive (#358): one record per line
        appendRunFile(logPath, logLine);
    }

    private matchesFilters(event: LogEvent, filters?: LogQueryFilters): boolean {
        if (!filters) {
            return true;
        }
        
        // Level filter
        if (filters.level) {
            const levels = Array.isArray(filters.level) ? filters.level : [filters.level];
            if (!levels.includes(event.level)) {
                return false;
            }
        }
        
        // Phase filter
        if (filters.phase) {
            const phases = Array.isArray(filters.phase) ? filters.phase : [filters.phase];
            if (!phases.includes(event.phase)) {
                return false;
            }
        }
        
        // Event filter
        if (filters.event) {
            const events = Array.isArray(filters.event) ? filters.event : [filters.event];
            if (!events.includes(event.event)) {
                return false;
            }
        }
        
        // Timestamp range filters
        if (filters.fromTimestamp && new Date(event.timestamp) < filters.fromTimestamp) {
            return false;
        }
        
        if (filters.toTimestamp && new Date(event.timestamp) > filters.toTimestamp) {
            return false;
        }
        
        return true;
    }


    /**
     * Resolve the target execution ID for logging - redirects split transactions to their original parent
     * GitHub Issue #74: All split transaction logs should write to original transaction's log file
     */
    private async resolveTargetExecutionId(executionId: string): Promise<string> {
        try {
            // Check if we have metadata service to look up transaction details
            if (!this.dependencies.executionMetadataService) {
                return executionId; // No metadata service, use original ID
            }

            // Get execution metadata to check if this is a split transaction
            const execution = await this.dependencies.executionMetadataService.getExecution(executionId);

            if (execution && execution.isSplitTransaction && execution.splitFromMemberId) {
                // This is a split transaction - log to the original transaction's log file
                this.logger.debug(`[ExecutionLoggingService] Routing split transaction ${executionId} logs to original ${execution.splitFromMemberId}`, undefined, {
                    splitTransactionId: executionId,
                    originalTransactionId: execution.splitFromMemberId,
                    arrayIndex: execution.arrayIndex,
                    splitReason: execution.splitReason
                });

                return execution.splitFromMemberId;
            }

            // Not a split transaction, use original execution ID
            return executionId;
        } catch (error) {
            // If we can't resolve, fall back to original execution ID
            this.logger.warn(`[ExecutionLoggingService] Failed to resolve target execution ID for ${executionId}, using original`, error instanceof Error ? error : undefined, { executionId });
            return executionId;
        }
    }

    /**
     * Helper method to get batch members
     */
    private async getBatchMembers(batchId: string): Promise<any[]> {
        if (!this.dependencies.executionMetadataService) {
            return [];
        }

        try {
            // Use the correct method: getBatchMemberExecutions instead of getAllExecutions
            if (!this.dependencies.executionMetadataService.getBatchMemberExecutions) {
                return [];
            }
            
            const batchMembers = await this.dependencies.executionMetadataService.getBatchMemberExecutions(batchId);
            return batchMembers;
        } catch (error) {
            this.logger.warn(`[ExecutionLoggingService] Failed to get batch members for ${batchId}`, error instanceof Error ? error : undefined, { batchId });
            return [];
        }
    }

    /**
     * Register a callback to be called when new log events are written
     */
    onLogEvent(callback: (executionId: string, event: LogEvent) => void): () => void {
        this.logEventCallbacks.add(callback);
        
        // Return unregister function
        return () => {
            this.logEventCallbacks.delete(callback);
        };
    }

    /**
     * Start live log streaming to a webview via callback
     * Similar to startLiveLogStreaming but sends to callback instead of output channel
     * Filters to specific execution/batch IDs
     */
    startWebviewLogStreaming(
        onLogUpdate: (formattedContent: string) => void,
        executionId?: string,
        batchId?: string
    ): () => void {
        // Register callback for new log events with filtering
        const unregisterCallback = this.onLogEvent((logExecutionId: string, event: LogEvent) => {
            // Filter to specific execution or batch
            // For batch: show batch-level logs + all member logs
            const isBatchLog = batchId && (logExecutionId === batchId || event.data?.batchId === batchId);
            const isExecutionLog = executionId && logExecutionId === executionId;

            if (isBatchLog || isExecutionLog) {
                // Use unified formatter for consistent display
                const formattedLines = this.formatLogEventForDisplay(logExecutionId, event);
                const formattedContent = formattedLines.join('\n');

                // Send to webview via callback
                onLogUpdate(formattedContent);
            }
        });

        // Return function to stop streaming
        return unregisterCallback;
    }

    /**
     * Helper method to notify all registered callbacks
     * Made public so BatchExecutionEngine can broadcast orchestration events directly
     */
    public notifyLogEventCallbacks(executionId: string, event: LogEvent): void {
        for (const callback of this.logEventCallbacks) {
            try {
                callback(executionId, event);
            } catch (error) {
                this.logger.error('[ExecutionLoggingService] Error in log event callback', error instanceof Error ? error : undefined);
            }
        }
    }

    /**
     * Format individual transaction logs for display
     * Simpler than batch logs - just formats events for a single execution
     */
    async formatIndividualTransactionLogs(executionId: string): Promise<string[]> {
        const formattedLines: string[] = [];

        try {
            // Get logs for this individual execution
            const logs = await this.getExecutionLogs(executionId);

            if (logs.length === 0) {
                formattedLines.push('⚠️ No logs found for this execution.');
                formattedLines.push('This may be an older execution created before logging was implemented.');
                return formattedLines;
            }

            // Format each log event
            for (const logEvent of logs) {
                const eventLines = this.formatLogEventForDisplay(executionId, logEvent);
                formattedLines.push(...eventLines);
            }

        } catch (error) {
            formattedLines.push(`❌ Error loading execution logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        return formattedLines;
    }

    /**
     * Stream batch logs progressively to webview with chunked delivery (GitHub Issue #94)
     * Enables immediate chunk delivery and progressive loading instead of waiting for all logs
     */
    async streamBatchLogsToWebview(
        batchId: string,
        onChunk: (chunk: string[], progress: { loaded: number; total: number }) => Promise<void>,
        chunkSize: number = 1000
    ): Promise<void> {
        try {
            const loadStart = Date.now();

            let currentSource = '';
            let formattedLineBuffer: string[] = [];
            let totalEventsProcessed = 0;
            let totalEventsEstimate = 0; // Updated as we discover files
            let hasSeenEvents = false;

            // Adaptive estimation tracking (GitHub Issue #94)
            let totalMembers = 0;
            let membersProcessed = 0;
            let currentMemberIndex = -1;
            let currentMemberEventCount = 0;
            let totalEventsFromCompletedMembers = 0;

            // Stream from disk and format as we read
            const eventCount = await this.streamBatchAggregatedLogsFromDisk(
                batchId,
                async (events: TaggedLogEvent[]) => {
                    hasSeenEvents = true;

                    // Format each event
                    for (const logEvent of events) {
                        // Determine log source for section grouping
                        const isBatchLog = logEvent.data?.batchId === batchId &&
                                          (logEvent.event.startsWith('batch_') || logEvent.phase === 'orchestration');

                        let source: string;
                        if (isBatchLog) {
                            source = 'BATCH ORCHESTRATION';
                        } else if (logEvent._sourceMemberInfo) {
                            const memberInfo = logEvent._sourceMemberInfo;
                            source = `MEMBER ${memberInfo.memberIndex}/${memberInfo.totalMembers} [${memberInfo.endpointName || 'unknown'}]`;

                            // Adaptive estimation: track member completion and calculate average
                            if (totalMembers === 0 && memberInfo.totalMembers > 0) {
                                totalMembers = memberInfo.totalMembers;
                            }

                            // Detect when we've moved to a new member (previous member is complete)
                            if (memberInfo.memberIndex !== currentMemberIndex) {
                                if (currentMemberIndex !== -1) {
                                    // Previous member is complete
                                    membersProcessed++;
                                    totalEventsFromCompletedMembers += currentMemberEventCount;

                                    // Calculate average and update estimate
                                    const avgEventsPerMember = totalEventsFromCompletedMembers / membersProcessed;
                                    const remainingMembers = totalMembers - membersProcessed;
                                    totalEventsEstimate = totalEventsFromCompletedMembers + Math.ceil(avgEventsPerMember * remainingMembers);

                                }

                                // Start tracking new member
                                currentMemberIndex = memberInfo.memberIndex;
                                currentMemberEventCount = 0;
                            }

                            currentMemberEventCount++;
                        } else {
                            source = `MEMBER ${logEvent.data?.memberId || logEvent.data?.executionId?.substring(0, 8) || 'unknown'}`;
                        }

                        // Add section header when source changes
                        if (source !== currentSource) {
                            currentSource = source;
                            formattedLineBuffer.push('');
                            formattedLineBuffer.push('═'.repeat(75));
                            formattedLineBuffer.push(`📄 ${source} - Status: ${logEvent._sourceMemberInfo ? 'Processing' : 'Unknown'}`);
                            formattedLineBuffer.push('─'.repeat(75));
                        }

                        // Format the event using existing formatter
                        const executionIdForDisplay = logEvent._sourceExecutionId || logEvent.data?.executionId || batchId;
                        const eventLines = this.formatLogEventForDisplay(executionIdForDisplay, logEvent);
                        formattedLineBuffer.push(...eventLines);

                        totalEventsProcessed++;
                    }

                    // Send chunk if buffer is large enough
                    if (formattedLineBuffer.length >= chunkSize) {
                        const chunkToSend = [...formattedLineBuffer];

                        // Use conservative estimate until we have data from at least 2 members
                        let effectiveEstimate = totalEventsEstimate;
                        if (membersProcessed < 2 && totalMembers > 0) {
                            // Conservative: just show current count until we have enough data for good estimate
                            effectiveEstimate = totalEventsProcessed;
                        }

                        const progress = {
                            loaded: totalEventsProcessed,
                            total: Math.max(totalEventsProcessed, effectiveEstimate)
                        };

                        await onChunk(chunkToSend, progress);

                        formattedLineBuffer = [];
                    }
                },
                chunkSize
            );

            // Send any remaining formatted lines
            if (formattedLineBuffer.length > 0) {
                const progress = {
                    loaded: totalEventsProcessed,
                    total: totalEventsProcessed  // Final count is accurate
                };

                await onChunk(formattedLineBuffer, progress);
            }

            // Send empty chunk if no logs found - allows frontend to complete loading
            if (!hasSeenEvents) {
                await onChunk([], { loaded: 0, total: 0 });
            }


        } catch (error) {
            const errorMessage = `❌ Error loading batch logs: ${error instanceof Error ? error.message : 'Unknown error'}`;
            await onChunk([errorMessage], { loaded: 0, total: 0 });
            throw error;
        }
    }

    /**
     * Unified formatter for log events - produces rich emoji-based display
     * Used by both live streaming and file-based log viewing for consistency
     */
    private formatLogEventForDisplay(logExecutionId: string, event: LogEvent): string[] {
        const lines: string[] = [];
        const timestamp = new Date(event.timestamp).toLocaleTimeString();

        // Use emojis for log levels
        const levelEmoji = {
            'info': '✅',
            'warn': '⚠️',
            'error': '❌',
            'debug': '🔍'
        }[event.level] || '📝';

        // Use emojis for phases
        const phaseEmoji = {
            'preparation': '📦',
            'execution': '🚀',
            'orchestration': '🎯',
            'completion': '🏁',
            'test': '🧪',
            'testing': '🧪',  // Add testing phase
            'general': '📋'
        }[event.phase] || '📋';

        // Try to get execution ID from multiple sources
        let finalExecutionId = logExecutionId;
        if (!finalExecutionId || finalExecutionId === 'unknown') {
            // Try to get from event data
            finalExecutionId = event.data?.executionId || 'unknown';
        }

        // Create a more meaningful short ID that preserves important info
        const execIdShort = this.createShortExecutionId(finalExecutionId);
        
        let logLine = `${timestamp} [${execIdShort}] ${levelEmoji} ${phaseEmoji} ${event.event}`;
        
        // Add HTTP status with appropriate emoji if available
        if (event.http?.status) {
            const statusEmoji = this.getHttpStatusEmoji(event.http.status);
            logLine += ` ${statusEmoji} [${event.http.status}]`;
        }
        
        // Add error details if it's an error
        if (event.error) {
            logLine += ` ERROR: ${event.error.message}`;
            if (event.error.code) {
                logLine += ` (${event.error.code})`;
            }
        }
        
        // Add progress information for batch events
        if (event.data?.progress) {
            const progress = event.data.progress;
            logLine += ` [${progress.completed}/${progress.total}]`;
        }
        
        lines.push(logLine);
        
        // Add additional context for specific events with emojis
        if (event.data) {
            if (event.event === 'batch_execution_started') {
                lines.push(`  💫 Batch: ${event.data.endpointName} (${event.data.totalMembers} members)`);
            } else if (event.event === 'batch_member_started') {
                lines.push(`  🔄 Member ${event.data.memberIndex}/${event.data.totalMembers}: ${event.data.endpointName || 'Processing'}`);
            } else if (event.event === 'transaction_created') {
                lines.push(`  📝 Transaction: ${event.data.endpointName || event.data.executionId}`);

                // Show execution metadata
                if (event.data?.executionType) {
                    lines.push(`     📊 Type: ${event.data.executionType}`);
                }
                if (event.data?.endpointMethod && event.data?.endpointPath) {
                    lines.push(`     🌐 Endpoint: ${event.data.endpointMethod} ${event.data.endpointPath}`);
                }
                if (event.data?.environment) {
                    const envDisplay = event.data.organization
                        ? `${event.data.environment} (${event.data.organization})`
                        : event.data.environment;
                    lines.push(`     🏢 Environment: ${envDisplay}`);
                }
                if (event.data?.batchId) {
                    const batchInfo = event.data.rowStart
                        ? `${event.data.batchId} (row ${event.data.rowStart}, count: ${event.data.rows})`
                        : event.data.batchId;
                    lines.push(`     📦 Batch: ${batchInfo}`);
                }

                // Show request headers and query params
                if (event.data?.requestHeaders && Object.keys(event.data.requestHeaders).length > 0) {
                    lines.push(`     🔑 Headers: ${JSON.stringify(event.data.requestHeaders)}`);
                }
                if (event.data?.requestQueryParams && Object.keys(event.data.requestQueryParams).length > 0) {
                    lines.push(`     🔍 Query Params: ${JSON.stringify(event.data.requestQueryParams)}`);
                }

                // Show file paths if available
                if (event.data?.fileName && event.data?.directoryPath) {
                    lines.push(`     📁 Request File: ${event.data.directoryPath}/${event.data.fileName}`);
                }
                if (event.data?.logPath) {
                    lines.push(`     📄 Log File: ${event.data.logPath}`);
                }
            } else if (event.event === 'execution_started') {
                lines.push(`  🏃 Starting: ${event.data.endpointName || 'API call'}`);
                // Show request file if available
                if (event.data?.requestFile) {
                    lines.push(`     📁 Request File: ${event.data.requestFile}`);
                }
            } else if (event.event === 'http_request_sent') {
                const method = event.http?.method || 'HTTP';
                // Use the complete URL if available, otherwise fall back to path
                const fullUrl = event.http?.url || event.data?.actualUrl || event.http?.path || '';
                const isMock = event.data?.isMockExecution ? '🎭 MOCK' : '🌐 LIVE';
                lines.push(`  ${isMock} ${method} ${fullUrl}`);
                
                // Environment and organization info
                if (event.data?.environment) {
                    lines.push(`     🏢 Env: ${event.data.environment}${event.data.organization ? ` | Org: ${event.data.organization}` : ''}`);
                }
                
                // Show actual headers (sanitized)
                if (event.http?.headers && Object.keys(event.http.headers).length > 0) {
                    lines.push(`     📋 Headers:`);
                    for (const [key, value] of Object.entries(event.http.headers)) {
                        lines.push(`        ${key}: ${value}`);
                    }
                }
                
                // Show actual query parameters
                if (event.http?.queryParams && Object.keys(event.http.queryParams).length > 0) {
                    lines.push(`     🔍 Query Params:`);
                    for (const [key, value] of Object.entries(event.http.queryParams)) {
                        lines.push(`        ${key}: ${value}`);
                    }
                }
                
                // Show request file link if available
                if (event.data?.requestFile) {
                    lines.push(`     📁 Request File: ${event.data.requestFile}`);
                }
                
                // Show request body (truncated if large) - moved to generic helper
                this.formatHttpBody(event, lines, 'request', event.data?.requestFile);
                
                // Retry attempt info
                if (event.data?.attempt > 1) {
                    lines.push(`     🔄 Retry attempt ${event.data.attempt}`);
                }
            } else if (event.event === 'http_response_received') {
                const duration = event.http?.duration ? ` ⏱️ ${event.http.duration}ms` : '';
                const status = event.http?.status || '';
                const statusText = event.http?.statusText ? ` ${event.http.statusText}` : '';
                const statusEmoji = status ? this.getHttpStatusEmoji(status) : '';
                const size = event.http?.size ? ` (${Math.round(event.http.size / 1024)}KB)` : '';
                lines.push(`  ${statusEmoji} Response: ${status}${statusText}${duration}${size}`);
                
                // Show response data preview if available - moved to generic helper
                if (event.data?.responseData) {
                    this.formatHttpBody({ ...event, http: { ...event.http, body: event.data.responseData } }, lines, 'response');
                }
                
                // Show retry attempt info for responses
                if (event.data?.attempt > 1) {
                    lines.push(`     🔄 Attempt ${event.data.attempt} response`);
                }
            } else if (event.event === 'execution_completed') {
                const duration = event.data?.totalDuration ? ` in ${event.data.totalDuration}ms` : '';
                const status = event.data?.executionStatus || 'completed';
                const statusEmoji = status === 'completed' ? '✅' : status === 'error' ? '❌' : '⚠️';
                lines.push(`  ${statusEmoji} Execution ${status}${duration}`);
                
                // Show response file if available
                if (event.data?.responseFile) {
                    lines.push(`     📄 Response File: ${event.data.responseFile}`);
                }
                if (event.data?.hasResponseFile === false) {
                    lines.push(`     ⚠️ No response file created`);
                }
            } else if (event.event === 'batch_member_completed') {
                const success = event.data?.success ? '✅' : '❌';
                lines.push(`  ${success} Member ${event.data.memberIndex}/${event.data.totalMembers} done`);
            } else if (event.event === 'batch_execution_completed') {
                const stats = event.data.finalStats;
                const duration = Math.round(event.data.totalDuration / 1000);
                const successEmoji = event.data.successRate > 80 ? '🎉' : event.data.successRate > 50 ? '✅' : '⚠️';
                lines.push(`  ${successEmoji} Batch Complete: ${stats.successful}/${stats.total} success (${event.data.successRate}%) in ${duration}s`);
            } else if (event.event === 'message') {
                // Simple message events from the convenience API
                lines.push(`  💬 ${event.data?.message || 'Message'}`);
            } else if (event.event === 'test_check') {
                // Test configuration check
                lines.push(`  🔍 Test Configuration Check:`);
                lines.push(`     Testing Service: ${event.data?.hasTestingService ? '✅ Available' : '❌ Not Available'}`);
                lines.push(`     Data Loading Config: ${event.data?.hasDataLoadingConfig ? '✅ Present' : '❌ Missing'}`);
                lines.push(`     Test Scripts: ${event.data?.testScriptCount || 0} (${event.data?.enabledTestCount || 0} enabled)`);
                if (event.data?.testScripts && event.data.testScripts.length > 0) {
                    lines.push(`     Scripts:`);
                    event.data.testScripts.forEach((script: { name: string; enabled: boolean; script?: string; scriptLength?: number }) => {
                        const status = script.enabled ? '✅' : '⏸️';
                        // #428: the script itself (logs written before it carry only its length)
                        if (typeof script.script === 'string') {
                            lines.push(`       ${status} ${script.name}`);
                            script.script.split('\n').forEach(line => lines.push(`          ${line}`));
                        } else {
                            lines.push(`       ${status} ${script.name} (${script.scriptLength} chars)`);
                        }
                    });
                }
            } else if (event.event === 'tests_started') {
                lines.push(`  🧪 Starting ${event.data?.testCount || 0} tests (${event.data?.enabledTests || 0} enabled)`);
            } else if (event.event === 'tests_completed') {
                const success = event.data?.success ? '✅' : '❌';
                lines.push(`  🧪 Tests ${success}: ${event.data?.passedTests || 0}/${event.data?.totalTests || 0} passed`);
                if (event.data?.failedTests > 0) {
                    lines.push(`     Failed: ${event.data.failedTests} tests`);
                }
                // #428: which test, and why
                (event.data?.results || []).forEach((r: { name: string; passed: boolean; error?: string }) => {
                    lines.push(`     ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? `: ${r.error}` : ''}`);
                });
                if (event.data?.functionalErrorCount > 0) {
                    lines.push(`     Functional Errors: ${event.data.functionalErrorCount}`);
                }
            } else if (event.event === 'tests_skipped') {
                lines.push(`  ⏭️ Tests skipped: ${event.data?.reason || 'Unknown reason'}`);
            } else if (event.event === 'test_execution_error') {
                lines.push(`  ❌ Test execution error: ${event.data?.errorMessage || 'Unknown error'}`);
                if (event.data?.errorStack) {
                    const stackLines = event.data.errorStack.split('\n').slice(0, 3);
                    stackLines.forEach((line: string) => {
                        lines.push(`     ${line.trim()}`);
                    });
                }
            }
        }
        
        // Generic HTTP body formatting for any event with HTTP data (catches edge cases)
        if (event.http?.body && !lines.some(line => line.includes('Request Body') || line.includes('Response Data'))) {
            this.formatHttpBody(event, lines, 'request');
        }
        
        return lines;
    }

    /**
     * Simple logging API - Convenience methods for easy logging
     * These methods provide a simple interface while using the rich LogEvent structure internally
     */
    async log(executionId: string, level: 'info' | 'warn' | 'error' | 'debug', message: string): Promise<void> {
        await this.logExecutionEvent(executionId, {
            timestamp: new Date().toISOString(),
            level,
            phase: 'general',
            event: 'message',
            data: { message }
        });
    }

    async info(executionId: string, message: string): Promise<void> {
        await this.log(executionId, 'info', message);
    }

    async warn(executionId: string, message: string): Promise<void> {
        await this.log(executionId, 'warn', message);
    }

    async error(executionId: string, message: string): Promise<void> {
        await this.log(executionId, 'error', message);
    }

    async debug(executionId: string, message: string): Promise<void> {
        await this.log(executionId, 'debug', message);
    }

    /**
     * Get appropriate emoji for HTTP status code
     */
    private getHttpStatusEmoji(status: number): string {
        if (status >= 200 && status < 300) return '✅';
        if (status >= 400) return '❌';
        return '⚠️'; // 3xx redirects and other status codes
    }

    /**
     * Format HTTP body (request or response) with truncation for large content
     */
    private formatHttpBody(event: LogEvent, lines: string[], type: 'request' | 'response', requestFile?: string): void {
        if (!event.http?.body) return;

        const bodyStr = typeof event.http.body === 'object' ?
            JSON.stringify(event.http.body, null, 2) :
            String(event.http.body);

        const maxSize = type === 'request' ? 500 : 300; // Different limits for request vs response
        const icon = type === 'request' ? '📦' : '📄';
        const label = type === 'request' ? 'Request Body' : 'Response Data';

        if (bodyStr.length > maxSize) {
            // Show truncated preview for large bodies
            lines.push(`     ${icon} ${label} Preview (${bodyStr.length} chars total):`);
            lines.push(`        ${bodyStr.substring(0, maxSize)}...`);
            if (type === 'request' && requestFile) {
                lines.push(`        [See full body in request file above]`);
            }
        } else {
            // Show full body for small content
            lines.push(`     ${icon} ${label}:`);
            bodyStr.split('\n').forEach((line: string) => {
                lines.push(`        ${line}`);
            });
        }
    }

    /**
     * Create a meaningful short execution ID for display in logs
     * @param executionId - Full execution ID
     * @returns Shortened ID that preserves important information
     */
    public createShortExecutionId(executionId: string): string {
        if (!executionId || executionId === 'unknown') {
            return 'unknown';
        }

        // If it looks like a timestamp format (YYYY-MM-DD-HH-MM-SS), show time part
        const timestampMatch = executionId.match(/(\d{4}-\d{2}-\d{2}-)?(\d{2}-\d{2}-\d{2})/);
        if (timestampMatch && timestampMatch[2]) {
            // Show the time part (HH-MM-SS) for timestamp-based IDs
            return timestampMatch[2];
        }

        // If it's a UUID-like format, show first 8 characters
        if (executionId.includes('-') && executionId.length > 16) {
            return executionId.substring(0, 8);
        }

        // For other formats, show first 12 characters to be more generous
        return executionId.length > 12 ? executionId.substring(0, 12) : executionId;
    }
}