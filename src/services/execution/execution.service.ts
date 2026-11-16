// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import {
    IExecutionService,
    ExecutionOptions,
    ExecutionResult
} from './execution.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { ExecutionPriority } from '../../types/execution-state';
import {
    RunAPIResponse,
    createRunAPIResponse,
    fromScheduleExecutionResponse
} from './run-api-response.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { IResponseTestingService } from '../testing/response-testing.interface';
import { EndpointExecutionOptions, IRequestExecutor, RequestEnvironmentLookup } from './request-executor.interface';
import type { BodyProgressListener } from './response-body';
import type { IExecutionProgressSink } from '../../platform/interfaces/execution-progress-sink.interface';
import { isPaginatedBatch } from '../pagination/pagination-detector.service';
import { readRunFile } from '../run-content/run-content-store';
import { fillBaseUrl } from '../../utils/environment-url';

// Dependencies interface for ExecutionService (Pure Executor)
export interface ExecutionServiceDependencies {
    executionValidationService: any;
    executionMetadataService: any;
    executionFileService: any;
    dobermannInstance: any;
    /** Issue #322: sends the request. Falls back to `dobermannInstance.executeEndpoint` when absent. */
    requestExecutor?: IRequestExecutor;
    /** Issue #317: environments, for the logged request URL. */
    environments?: RequestEnvironmentLookup;
    executionCoordinator?: any; // IExecutionCoordinator - for centralized state management
    // Phase 4 services
    timeEstimationService?: any;
    batchProgressService?: any;
    // Execution logging service (optional)
    executionLoggingService?: any; // IExecutionLoggingService
    // Response testing service (optional)
    responseTestingService?: IResponseTestingService;
    /** Issue #115: the Console hears a big response body arrive ("Receiving 12,340 records"). */
    progressSink?: IExecutionProgressSink;
}

/**
 * Issue #115: where a response body's download progress ("Receiving 12,340 records") is shown.
 * A Run API's own Console, and the first page of a paginated run, whose Console has nothing else
 * to show yet. #436: once a paginated run has more than one page it is a batch, and the batch's
 * progress owns that footer: a page's download used to take it over ("Processing data") between
 * the batch's own updates. A real batch's members never report it.
 */
export function bodyProgressConsoleId(
    executionType: string | undefined,
    executionId: string,
    batchContext?: { parentBatch?: { id: string; endpointConfig?: unknown }; memberCount?: number }
): string | undefined {
    if (executionType === 'individual') return executionId;
    const batch = batchContext?.parentBatch;
    if (batch && isPaginatedBatch(batch) && (batchContext?.memberCount ?? 1) <= 1) return batch.id;
    return undefined;
}

/**
 * ExecutionService - Pure Executor Implementation
 * 
 * This service is responsible ONLY for executing existing execution records.
 * It does NOT create execution metadata - that's handled by TransactionPreparationService.
 * 
 * Architecture: Transaction Preparation + Pure Execution
 * - No createExecutionMetadata() calls
 * - executeRecord(executionId) method reads existing metadata
 * - Status updates from 'pending' -> 'running' -> 'completed/error'
 * - Supports parallel execution (individual + batch)
 */
export class ExecutionService implements IExecutionService {
    private dependencies: ExecutionServiceDependencies;
    private runningExecutions: Map<string, { abortController: AbortController; startTime: number; status: string }> = new Map();
    private executionMetadata: Map<string, any> = new Map();

    constructor(
        dependencies: ExecutionServiceDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.dependencies = dependencies;
    }

    /** Issue #317: injected environments, else the ones Dobermann holds (older wiring, tests). */
    private get environments(): RequestEnvironmentLookup | undefined {
        return this.dependencies.environments
            ?? this.dependencies.dobermannInstance?.getEnvironmentManager?.()
            ?? this.dependencies.dobermannInstance?.environmentManager;
    }

    /**
     * Execute an existing execution record by ID
     * This is the main method for ExecutionService - pure execution only
     *
     * @param executionId - The execution ID to execute
     * @param batchContext - Optional batch context for batch_member executions
     */
    async executeRecord(
        executionId: string,
        batchContext?: { parentBatch: ExecutionMetadata; environmentId?: string; memberCount?: number }
    ): Promise<ExecutionResult> {

        // 🐛 DEBUG: Detect duplicate execution attempts
        if (this.runningExecutions.has(executionId)) {
            const existing = this.runningExecutions.get(executionId);
            const errorDetails = {
                executionId,
                existingStatus: existing?.status,
                existingStartTime: existing?.startTime,
                timeSinceStart: Date.now() - (existing?.startTime || 0),
                batchContext: batchContext?.parentBatch?.id,
                callStack: new Error().stack
            };

            this.logger.error(`[DEBUG-DUPLICATE] PROMISE-CHAIN-v4 DUPLICATE EXECUTION DETECTED`, undefined, errorDetails);

            this.logger.error(
                `[DUPLICATE-EXECUTION] 🔐🔐🔐 PROMISE-CHAIN-v4 🔐🔐🔐 Attempt to execute ${executionId} which is already running!`,
                undefined,
                errorDetails
            );

            // Continue to see what happens, but log it prominently
        }

        // Step 1: Load existing execution metadata
        const executionMetadata = await this.dependencies.executionMetadataService.getExecution(executionId);
        if (!executionMetadata) {
            this.logger.error(`[ExecutionService] Execution record ${executionId} not found`, undefined, { executionId });
            throw new Error(`Execution record ${executionId} not found`);
        }


        // Store the initial execution metadata for later reference
        this.executionMetadata.set(executionId, executionMetadata);

        // Step 2: Validate execution can be run (status should be 'pending' or 'running')
        // Note: 'running' is allowed because batch execution engine claims transactions atomically
        if (executionMetadata.status !== 'pending' && executionMetadata.status !== 'running') {
            throw new Error(`Execution ${executionId} cannot be executed (current status: ${executionMetadata.status}). Expected 'pending' or 'running'.`);
        }

        // Step 3: Reconstruct endpoint from metadata
        // For batch_members, get test scripts from parent batch if available
        let dataLoadingConfig = executionMetadata.dataLoadingConfig;
        if (executionMetadata.executionType === 'batch_member' && batchContext?.parentBatch) {
            // Use parent batch's dataLoadingConfig for test scripts
            dataLoadingConfig = batchContext.parentBatch.endpointConfig?.dataLoadingConfig || dataLoadingConfig;
        }

        // 🔍 DEBUG: Log query params at execution time
        if (executionMetadata.executionType === 'batch_member') {
            this.logger.info(`[ExecutionService] 🔍 Executing batch_member ${executionId}: requestQueryParams=${JSON.stringify(executionMetadata.requestQueryParams)}`);
        }

        const body = await this.loadRequestBodyFromFile(executionMetadata.requestFile);
        const endpoint: APIEndpointConfig = {
            id: executionMetadata.endpointId,
            name: executionMetadata.endpointName,
            method: executionMetadata.endpointMethod,
            path: executionMetadata.endpointPath,
            headers: executionMetadata.requestHeaders || {},
            queryParams: executionMetadata.requestQueryParams || {},
            body,
            dataLoadingConfig: dataLoadingConfig
        };

        // Step 4: Reconstruct options from metadata
        // Use environmentId from batchContext if provided (for cross-environment batch execution)
        const options: ExecutionOptions = {
            environment: batchContext?.environmentId || executionMetadata.environment,
            organization: executionMetadata.organization,
            validateBefore: false, // Already validated during preparation
            executionType: executionMetadata.executionType,
            // #424/#160: a member goes to its batch's base URL, kept when the batch started (an
            // older batch has none: the environment's, as before)
            ...(executionMetadata.executionType === 'batch_member' && batchContext?.parentBatch?.baseUrl
                ? { baseUrl: batchContext.parentBatch.baseUrl } : {})
        };
        // A member that carries a body whose saved body can't be read must never go out empty
        // (seen 2026-10-10: two POSTs sent with no body after a reload, the API said "Invalid JSON")
        const carriesBody = ['POST', 'PUT', 'PATCH'].includes(String(executionMetadata.endpointMethod).toUpperCase());
        if (executionMetadata.executionType === 'batch_member' && executionMetadata.requestFile && carriesBody && body === undefined) {
            options.requestContentMissing = executionMetadata.requestFile;
        }

        const progressConsoleId = bodyProgressConsoleId(executionMetadata.executionType, executionId, batchContext);

        // Step 5: Execute using existing execution logic
        return await this.executeInternal(executionId, endpoint, options, progressConsoleId);
    }

    /**
     * Legacy execute method for backwards compatibility
     * NOTE: This should not be used in new architecture - use executeRecord() instead
     */
    async execute(endpoint: APIEndpointConfig, options?: ExecutionOptions): Promise<ExecutionResult> {
        throw new Error('ExecutionService.execute() is deprecated. Use executeRecord(executionId) instead. Creation should be handled by TransactionPreparationService.');
    }

    /**
     * Internal execution logic (extracted from original execute method)
     * Modified to work with existing execution metadata
     */
    private async executeInternal(executionId: string, endpoint: APIEndpointConfig, options?: ExecutionOptions, progressConsoleId?: string): Promise<ExecutionResult> {
        const startTime = Date.now();

        // Log execution start
        await this.logExecutionEvent(executionId, {
            timestamp: new Date().toISOString(),
            level: 'info',
            phase: 'execution',
            event: 'execution_started',
            data: {
                executionId,
                endpointName: endpoint.name,
                method: endpoint.method,
                path: endpoint.path,
                options: {
                    timeout: options?.timeout,
                    environment: options?.environment,
                    organization: options?.organization
                }
            },
            http: {
                method: endpoint.method,
                path: endpoint.path
            }
        });

        // Create abort controller for this execution
        const abortController = new AbortController();

        // Track this execution
        this.runningExecutions.set(executionId, {
            abortController,
            startTime,
            status: 'running'
        });

        // Update status from 'pending' to 'running' (if not already claimed atomically)
        // Note: Batch execution engine claims transactions atomically, so they may already be 'running'
        const currentMetadata = this.executionMetadata.get(executionId);
        if (currentMetadata && currentMetadata.status === 'pending') {
            await this.updateExecutionMetadata(executionId, {
                status: 'running',
                startedAt: new Date()
            });
        } else if (currentMetadata && currentMetadata.status === 'running' && !currentMetadata.startedAt) {
            // Status is already 'running' but startedAt might be missing (edge case)
            await this.updateExecutionMetadata(executionId, {
                startedAt: new Date()
            });
        }

        try {
            if (options?.requestContentMissing) {
                const name = options.requestContentMissing.split(/[\\/]/).pop();
                throw new Error(`The request's saved content (${name}) couldn't be read, so nothing was sent. Reprocess it to try again.`);
            }

            // Set up timeout if specified
            if (options?.timeout) {
                setTimeout(() => {
                    if (this.runningExecutions.has(executionId)) {
                        abortController.abort();
                    }
                }, options.timeout);
            }

            // Build a pre-request URL estimate (may be incomplete if dependencies unavailable)
            let actualUrl = await this.buildActualRequestUrl(endpoint, executionId, options?.baseUrl);
            await this.logExecutionEvent(executionId, {
                timestamp: new Date().toISOString(),
                level: 'info',
                phase: 'execution',
                event: 'http_request_sent',
                data: {
                    headers: this.sanitizeHeaders(endpoint.headers),
                    queryParams: endpoint.queryParams,
                    actualUrl
                },
                http: {
                    method: endpoint.method,
                    path: endpoint.path,
                    url: actualUrl,
                    headers: this.sanitizeHeaders(endpoint.headers),
                    queryParams: endpoint.queryParams
                }
            });

            // Execute the endpoint once (no retries)
            const requestStartTime = Date.now();
            const response = await this.executeEndpoint(endpoint, {
                ...options,
                abortSignal: abortController.signal
            }, executionId, this.bodyProgressTo(progressConsoleId));
            const requestDuration = Date.now() - requestStartTime;

            // Use the actual URL from the response if available (authoritative from dobermann.ts)
            if (response.url) {
                actualUrl = response.url;
            }

            // Log successful response
            await this.logExecutionEvent(executionId, {
                timestamp: new Date().toISOString(),
                level: 'info',
                phase: 'execution',
                event: 'http_response_received',
                data: {
                    responseData: this.sanitizeResponseData(response.data),
                    actualUrl
                },
                http: {
                    method: endpoint.method,
                    path: endpoint.path,
                    url: actualUrl,
                    status: response.status,
                    statusText: response.statusText,
                    duration: requestDuration,
                    size: JSON.stringify(response.data || {}).length
                }
            });

            const duration = Date.now() - startTime;

            // Get current execution metadata to get existing requestFile path
            const currentExecution = await this.dependencies.executionMetadataService.getExecution(executionId);

            // Create response file only if we have a requestFile and the service is available
            let responseFile: string | undefined;
            if (currentExecution?.requestFile && this.dependencies.executionFileService?.createResponseFile) {
                responseFile = await this.dependencies.executionFileService.createResponseFile(
                    response,
                    endpoint,
                    duration,
                    executionId,
                    currentExecution.requestFile
                );
            } else {
                this.logger.warn(`[ExecutionService] Cannot create response file for ${executionId}`, undefined, {
                    executionId,
                    hasRequestFile: !!currentExecution?.requestFile,
                    hasFileService: !!this.dependencies.executionFileService?.createResponseFile
                });
            }

            // Execute response tests if configured
            let testExecutionResult: any = null;
            let testErrorMessage: string | undefined;

            // Log test configuration check
            await this.logExecutionEvent(executionId, {
                timestamp: new Date().toISOString(),
                level: 'info',
                phase: 'testing',
                event: 'test_check',
                data: {
                    hasTestingService: !!this.dependencies.responseTestingService,
                    hasDataLoadingConfig: !!endpoint.dataLoadingConfig,
                    hasTestScripts: !!endpoint.dataLoadingConfig?.testScripts,
                    testScriptCount: endpoint.dataLoadingConfig?.testScripts?.length || 0,
                    enabledTestCount: endpoint.dataLoadingConfig?.testScripts?.filter(t => t.enabled).length || 0,
                    testScripts: endpoint.dataLoadingConfig?.testScripts ?
                        endpoint.dataLoadingConfig.testScripts.map(t => ({
                            name: t.name,
                            enabled: t.enabled,
                            // #428: the script itself, so the log shows what ran
                            script: t.script || ''
                        })) : []
                }
            });

            // Only run tests for HTTP success responses (2xx/3xx)
            if (this.dependencies.responseTestingService &&
                endpoint.dataLoadingConfig?.testScripts?.length &&
                response.status >= 200 && response.status < 400) {
                try {
                    await this.logExecutionEvent(executionId, {
                        timestamp: new Date().toISOString(),
                        level: 'info',
                        phase: 'testing',
                        event: 'tests_started',
                        data: {
                            testCount: endpoint.dataLoadingConfig.testScripts.length,
                            enabledTests: endpoint.dataLoadingConfig.testScripts.filter(t => t.enabled).length
                        }
                    });

                    testExecutionResult = await this.dependencies.responseTestingService.executeTests(
                        executionId,
                        response,
                        endpoint.dataLoadingConfig.testScripts,
                        {
                            request: {
                                method: endpoint.method,
                                url: endpoint.path,
                                headers: endpoint.headers,
                                body: endpoint.body
                            },
                            csvRow: {}, // TODO: Get actual CSV row data for batch executions
                            rowIndex: 0,
                            totalRows: 1
                        }
                    );

                    await this.logExecutionEvent(executionId, {
                        timestamp: new Date().toISOString(),
                        level: testExecutionResult.success ? 'info' : 'error',
                        phase: 'testing',
                        event: 'tests_completed',
                        data: {
                            success: testExecutionResult.success,
                            totalTests: testExecutionResult.testResults.totalTests,
                            passedTests: testExecutionResult.testResults.passedTests,
                            failedTests: testExecutionResult.testResults.failedTests,
                            functionalErrorCount: testExecutionResult.functionalErrors.length,
                            // #428: each test's outcome, and why one failed
                            results: (testExecutionResult.testResults.results || []).map((r: { testName: string; success: boolean; error?: string }) => ({
                                name: r.testName,
                                passed: r.success,
                                ...(r.error ? { error: r.error } : {})
                            }))
                        }
                    });

                    if (!testExecutionResult.success) {
                        testErrorMessage = testExecutionResult.errorMessage;
                    }

                } catch (error) {
                    await this.logExecutionEvent(executionId, {
                        timestamp: new Date().toISOString(),
                        level: 'error',
                        phase: 'testing',
                        event: 'test_execution_error',
                        data: {
                            errorMessage: error instanceof Error ? error.message : 'Unknown error',
                            errorStack: error instanceof Error ? error.stack : undefined
                        }
                    });
                    this.logger.error(`[ExecutionService] Test execution failed for ${executionId}`, error instanceof Error ? error : undefined);
                    testErrorMessage = `Test execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            } else {
                // Log why tests were skipped
                await this.logExecutionEvent(executionId, {
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    phase: 'testing',
                    event: 'tests_skipped',
                    data: {
                        reason: !this.dependencies.responseTestingService ? 'No testing service available' :
                            !endpoint.dataLoadingConfig ? 'No data loading config' :
                                !endpoint.dataLoadingConfig.testScripts ? 'No test scripts array' :
                                    endpoint.dataLoadingConfig.testScripts.length === 0 ? 'Test scripts array is empty' :
                                        'Unknown reason'
                    }
                });
            }

            // Determine execution status based on HTTP status code AND test results
            let executionStatus: string;
            let testStatus: string;
            let finalErrorMessage: string | undefined;

            if (!response.status || response.status >= 400) {
                // HTTP errors (status >= 400), or no answer at all (no status: the network, or
                // DBMN for VS Code closing mid-request): an error, saying why when the executor said
                executionStatus = 'error';
                testStatus = testExecutionResult ? 'skipped' : 'no-tests';
                finalErrorMessage = !response.status
                    ? (response.error || 'Network error: Request failed to complete')
                    : `HTTP ${response.status}: ${response.statusText}`;
            } else if (response.status >= 200 && response.status < 400) {
                // HTTP success (2xx) or redirect (3xx) - check test results
                if (testExecutionResult) {
                    if (testExecutionResult.success) {
                        executionStatus = 'completed';
                        testStatus = 'passed';
                    } else {
                        executionStatus = 'error';
                        testStatus = 'failed';
                        finalErrorMessage = testErrorMessage;
                    }
                } else {
                    executionStatus = 'completed';
                    testStatus = 'no-tests';
                }
            } else {
                // Unexpected status code - treat as error
                executionStatus = 'error';
                testStatus = testExecutionResult ? 'skipped' : 'no-tests';
                finalErrorMessage = `Unexpected HTTP status: ${response.status}`;
            }

            // Log execution completion
            await this.logExecutionEvent(executionId, {
                timestamp: new Date().toISOString(),
                level: executionStatus === 'completed' ? 'info' : 'error',
                phase: 'completion',
                event: 'execution_completed',
                data: {
                    executionStatus,
                    testStatus,
                    totalDuration: duration,
                    responseFile,
                    hasResponseFile: !!responseFile,
                    hasTests: !!testExecutionResult,
                    testResults: testExecutionResult ? {
                        totalTests: testExecutionResult.testResults.totalTests,
                        passedTests: testExecutionResult.testResults.passedTests,
                        failedTests: testExecutionResult.testResults.failedTests
                    } : null
                },
                http: {
                    status: response.status,
                    statusText: response.statusText,
                    duration: duration
                },
                error: finalErrorMessage ? {
                    message: finalErrorMessage,
                    code: testExecutionResult && !testExecutionResult.success ? 'FUNCTIONAL_ERROR' : 'HTTP_ERROR'
                } : undefined
            });

            // Update execution metadata with completion status
            await this.updateExecutionMetadata(executionId, {
                status: executionStatus,
                completedAt: new Date(),
                httpStatus: response.status,
                httpStatusText: response.statusText,
                responseFile: responseFile,
                testStatus: testStatus,
                errorMessage: finalErrorMessage
            });


            // 🔍 DEBUG: Verify query params survived execution
            if (this.executionMetadata.get(executionId)?.executionType === 'batch_member') {
                const postExec = await this.dependencies.executionMetadataService.getExecution(executionId);
                this.logger.info(`[ExecutionService] 🔍 Post-execution ${executionId}: requestQueryParams=${JSON.stringify(postExec?.requestQueryParams)}`);
            }

            // Remove from running executions
            this.runningExecutions.delete(executionId);

            return {
                success: executionStatus === 'completed',
                executionId,
                duration,
                httpStatus: response.status,
                httpStatusText: response.statusText,
                requestFile: currentExecution?.requestFile,
                responseFile: responseFile,
                errorMessage: finalErrorMessage
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            // Check if this is an HTTP error with response data
            const errorResponse = (error as any)?.response;
            let httpStatus: number | undefined;
            let httpStatusText: string | undefined;
            let responseFile: string | undefined;

            // Determine error message for AbortError cases first
            let errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            // #335: aborted by Cancel (not a timeout): recorded as cancelled, never as an error
            const cancelled = error instanceof Error && error.name === 'AbortError' && !(options?.timeout && duration >= options.timeout);
            if (error instanceof Error && error.name === 'AbortError') {
                if (options?.timeout && duration >= options.timeout) {
                    errorMessage = 'Execution timeout';
                } else {
                    errorMessage = 'Cancelled: the request was stopped before it finished';
                }
            }

            // Log execution error
            await this.logExecutionEvent(executionId, {
                timestamp: new Date().toISOString(),
                level: 'error',
                phase: 'completion',
                event: 'execution_failed',
                data: {
                    totalDuration: duration,
                    hasErrorResponse: !!errorResponse,
                    isTimeout: error instanceof Error && error.name === 'AbortError' && options?.timeout && duration >= options.timeout,
                    isCancelled: error instanceof Error && error.name === 'AbortError' && (!options?.timeout || duration < options.timeout)
                },
                error: {
                    message: errorMessage,
                    code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
                    stack: error instanceof Error ? error.stack : undefined,
                    httpStatus: errorResponse?.status
                },
                http: {
                    method: endpoint.method,
                    path: endpoint.path,
                    status: errorResponse?.status,
                    statusText: errorResponse?.statusText,
                    duration: duration
                }
            });

            // If we have an HTTP error response, save it and capture status
            if (errorResponse) {
                httpStatus = errorResponse.status;
                httpStatusText = errorResponse.statusText;

                // Save error response to file using the same service
                try {
                    const currentExecution = this.executionMetadata.get(executionId);
                    if (currentExecution?.requestFile && this.dependencies.executionFileService?.createResponseFile) {
                        // We need to get the endpoint config - let's try to reconstruct it or use a minimal one
                        const endpoint = {
                            name: currentExecution.endpointName || 'Unknown',
                            method: currentExecution.endpointMethod as any || 'GET',
                            path: currentExecution.endpointPath || '/unknown',
                            headers: {},
                            queryParams: {},
                            body: '',
                            dataLoadingConfig: undefined
                        };

                        responseFile = await this.dependencies.executionFileService.createResponseFile(
                            errorResponse,
                            endpoint,
                            duration,
                            executionId,
                            currentExecution.requestFile
                        );
                    }
                } catch (responseError) {
                    this.logger.warn('[ExecutionService] Failed to save error response', responseError);
                }
            }

            // Update execution metadata with error (including HTTP status if available)
            await this.updateExecutionMetadata(executionId, {
                status: cancelled ? 'cancelled' : 'error',
                completedAt: new Date(),
                errorMessage: errorMessage,
                httpStatus: httpStatus,
                httpStatusText: httpStatusText,
                responseFile: responseFile,
                testStatus: 'skipped' // Tests skipped due to execution failure
            });

            // Remove from running executions
            this.runningExecutions.delete(executionId);

            return {
                success: false,
                executionId,
                duration,
                httpStatus: httpStatus,
                httpStatusText: httpStatusText,
                responseFile: responseFile,
                errorMessage,
                ...(cancelled ? { cancelled: true } : {})
            };
        }
    }

    /**
     * Clean up in-memory data for completed executions (memory leak prevention)
     */
    cleanupExecutionMemory(executionIds: string[]): void {
        for (const id of executionIds) {
            this.executionMetadata.delete(id);
            this.runningExecutions.delete(id);
        }
    }

    async cancel(executionId: string): Promise<void> {
        const execution = this.runningExecutions.get(executionId);
        if (!execution) {
            // Try to get execution metadata to check if it exists
            const metadata = await this.dependencies.executionMetadataService.getExecution(executionId);
            if (metadata) {
                // Execution exists but is not running - no action needed
            }

            // Don't throw error for non-existent executions - just log and return
            return;
        }

        execution.abortController.abort();
        this.runningExecutions.delete(executionId);

        // Update execution metadata
        await this.updateExecutionMetadata(executionId, {
            status: 'cancelled',
            completedAt: new Date()
        });
    }

    async getExecutionStatus(executionId: string): Promise<string> {
        // Check if execution is currently running
        const execution = this.runningExecutions.get(executionId);
        if (execution) {
            return execution.status;
        }

        // Check execution metadata for completed executions
        const metadata = this.executionMetadata.get(executionId);
        if (metadata) {
            return metadata.status;
        }

        // Not found
        throw new Error(`Execution ${executionId} not found`);
    }

    async isExecutionRunning(executionId: string): Promise<boolean> {
        return this.runningExecutions.has(executionId);
    }

    async getRunningExecutions(): Promise<string[]> {
        return Array.from(this.runningExecutions.keys());
    }

    /**
     * Load request body from the request file created during preparation
     */
    private async loadRequestBodyFromFile(requestFilePath: string): Promise<string | undefined> {
        if (!requestFilePath) {
            this.logger.warn(`[ExecutionService] issue#231 loadRequestBodyFromFile called with empty/undefined requestFilePath — batch_member will execute with body=undefined`);
            return undefined;
        }

        try {
            const fileContent = readRunFile(requestFilePath);

            // For JSON files, return the content as-is (it's already a JSON string)
            // For CSV files (batch operations), we don't need body content
            return fileContent;
        } catch (error) {
            this.logger.warn(`[ExecutionService] issue#231 Failed to load request file ${requestFilePath} — batch_member will execute with body=undefined`, error, { requestFilePath });
            return undefined;
        }
    }

    /**
     * Build the actual URL that will be sent in the HTTP request
     * This matches the logic in dobermann.ts executeEndpoint method
     */
    private async buildActualRequestUrl(endpoint: APIEndpointConfig, executionId: string, fixedBaseUrl?: string): Promise<string> {
        try {
            // Get the execution metadata to find the environment
            const metadata = await this.dependencies.executionMetadataService.getExecution(executionId);
            if (!metadata) {
                return `${endpoint.path}${this.buildQueryString(endpoint.queryParams)}`;
            }

            // Issue #317: the injected environments (same lookup the request executor uses)
            const environments = this.environments;
            if (!environments) {
                return `${endpoint.path}${this.buildQueryString(endpoint.queryParams)}`;
            }

            const environment = await environments.getEnvironment(metadata.environmentId);
            if (!environment?.baseUrl) {
                // GitHub Issue #160: Log warning when environment lookup fails for URL building
                // This is just for logging, not execution, but it's still misleading
                this.logger.warn(`[ExecutionService] issue#160 Environment lookup failed for '${metadata.environmentId}' - URL may be incomplete`);
                return `${endpoint.path}${this.buildQueryString(endpoint.queryParams)}`;
            }

            // Build the complete URL similar to dobermann.ts logic (#424: the base URL's variables filled)
            const filledBaseUrl = fixedBaseUrl || fillBaseUrl(environment.baseUrl, environment.variables);
            const baseUrl = filledBaseUrl.endsWith('/') ? filledBaseUrl.slice(0, -1) : filledBaseUrl;
            const path = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
            const fullUrl = `${baseUrl}${path}`;

            // Add query parameters for GET requests or when queryParams exist
            if (endpoint.method === 'GET' || (endpoint.queryParams && Object.keys(endpoint.queryParams).length > 0)) {
                const queryString = this.buildQueryString(endpoint.queryParams);
                return `${fullUrl}${queryString}`;
            }

            return fullUrl;
        } catch (error) {
            // If anything fails, return basic path with query params
            this.logger.debug('[ExecutionService] Failed to build actual URL, using fallback', error instanceof Error ? error : undefined);
            return `${endpoint.path}${this.buildQueryString(endpoint.queryParams)}`;
        }
    }

    /**
     * Build query string from query parameters object
     * GitHub Issue #108: Handle both legacy string format and new HeaderConfig format
     * Only includes enabled query params
     */
    private buildQueryString(queryParams?: Record<string, string | any>): string {
        if (!queryParams || Object.keys(queryParams).length === 0) {
            return '';
        }

        // Extract enabled query params only, converting to Record<string, string>
        const enabledParams: Record<string, string> = {};
        for (const [key, value] of Object.entries(queryParams)) {
            if (typeof value === 'string') {
                // Legacy format - always enabled
                enabledParams[key] = value;
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                // New format - check enabled state
                if (value.enabled !== false) {
                    enabledParams[key] = value.value;
                }
            }
        }

        if (Object.keys(enabledParams).length === 0) {
            return '';
        }

        // GitHub Issue #108: Check if this is a repeatable query param
        // Pattern: value contains "key=" (e.g., "ITM001 or itemId=ITM002")
        const entries = Object.entries(enabledParams);
        if (entries.length === 1) {
            const [key, value] = entries[0];
            // If value contains the key followed by =, it's a repeatable query param
            // Example: key="itemId", value="ITM001 or itemId=ITM002 or itemId=ITM003"
            if (value.includes(`${key}=`)) {
                // This is a repeatable query param - append raw (only encode spaces)
                const encodedValue = value.replace(/ /g, '%20');
                return `?${key}=${encodedValue}`;
            }
        }

        // Standard query params - use URLSearchParams for proper encoding
        const params = new URLSearchParams(enabledParams);
        return `?${params.toString()}`;
    }

    /**
     * Execute endpoint - same logic as original ExecutionService
     */
    /** Issue #115: a listener that tells a Console how much of a response body has arrived. */
    private bodyProgressTo(consoleId: string | undefined): BodyProgressListener | undefined {
        const sink = this.dependencies.progressSink;
        if (!consoleId || !sink) return undefined;
        const startTime = Date.now();
        return (receiving) => sink.progress(consoleId, {
            executionId: consoleId,
            title: 'Receiving',
            status: 'running',
            totalProgress: receiving.totalRecords ? Math.round((receiving.lines / receiving.totalRecords) * 100)
                : receiving.totalBytes ? Math.round((receiving.bytes / receiving.totalBytes) * 100) : 0,
            startTime,
            timestamp: Date.now(),
            receiving
        });
    }

    private async executeEndpoint(endpoint: APIEndpointConfig, options?: ExecutionOptions, executionId?: string, onBodyProgress?: BodyProgressListener): Promise<any> {
        // Issue #322: the request executor (respects environment mock settings)
        const executor: IRequestExecutor | undefined = this.dependencies.requestExecutor
            ?? (this.dependencies.dobermannInstance?.executeEndpoint ? this.dependencies.dobermannInstance : undefined);
        if (executor) {
            const executorOptions: EndpointExecutionOptions = {
                ...(options?.executionType === 'batch_member' ? { isBatchMember: true } : {}),
                ...(onBodyProgress ? { onBodyProgress } : {}),
                // #344: the run's Console shows when its request waits for VS Code
                ...(executionId ? { executionId } : {}),
                ...(options?.baseUrl ? { baseUrl: options.baseUrl } : {})
            };
            return await executor.executeEndpoint(
                endpoint, options?.abortSignal, options?.environment,
                Object.keys(executorOptions).length ? executorOptions : undefined
            );
        }

        // Fallback error if Dobermann instance is not available
        throw new Error('Dobermann instance not available for endpoint execution');
    }

    /**
     * Update execution metadata - same logic as original ExecutionService
     */
    private async updateExecutionMetadata(executionId: string, updates: any): Promise<void> {

        // Store updates in local metadata for status tracking
        const existingMetadata = this.executionMetadata.get(executionId) || {};
        const updatedMetadata = { ...existingMetadata, ...updates };
        this.executionMetadata.set(executionId, updatedMetadata);

        // Also call the dependency service if available
        if (this.dependencies.executionMetadataService?.updateExecution) {
            await this.dependencies.executionMetadataService.updateExecution(executionId, updates);
        } else {
            this.logger.warn(`[ExecutionService] executionMetadataService.updateExecution not available for ${executionId}`, undefined, { executionId });
        }

        // Route execution-state updates through ExecutionCoordinator (if
        // available) so concurrent batch+individual state stays consistent.
        // Skip batch_member updates — they fire too rapidly and the
        // coordinator only cares about parent batch transitions.
        if (updates.status && this.dependencies.executionCoordinator
            && updatedMetadata.executionType !== 'batch_member') {
            try {
                const coordinatorMetadata = {
                    id: executionId,
                    executionType: updatedMetadata.executionType || 'individual' as const,
                    rows: updatedMetadata.rows || 1,
                    status: updates.status,
                    createdAt: updatedMetadata.createdAt || new Date(),
                    startedAt: updatedMetadata.startedAt,
                    completedAt: updatedMetadata.completedAt,
                    environment: updatedMetadata.environment || 'unknown',
                    organization: updatedMetadata.organization,
                    endpointId: updatedMetadata.endpointId || 'unknown',
                    endpointName: updatedMetadata.endpointName || 'Unknown Endpoint',
                    endpointMethod: updatedMetadata.endpointMethod || 'POST',
                    endpointPath: updatedMetadata.endpointPath || '/unknown',
                    errorMessage: updatedMetadata.errorMessage,
                    httpStatus: updatedMetadata.httpStatus,
                    httpStatusText: updatedMetadata.httpStatusText,
                    runTime: updatedMetadata.runTime,
                    requestFile: updatedMetadata.requestFile,
                    responseFile: updatedMetadata.responseFile,
                    requestHash: updatedMetadata.requestHash
                };
                await this.dependencies.executionCoordinator.updateExecutionState(executionId, coordinatorMetadata);
            } catch (error) {
                this.logger.warn('[ExecutionService] Failed to update execution state', error);
            }
        }

        // Tree refresh now happens automatically via event-driven architecture
        // Note: Removed auto-expand/focus behavior - user prefers manual control of tree expansion
    }

    /**
     * Legacy schedule execution method - not used in new architecture
     */
    async scheduleExecution(endpoint: APIEndpointConfig, options?: ExecutionOptions, priority: ExecutionPriority = ExecutionPriority.URGENT): Promise<RunAPIResponse> {
        throw new Error('ExecutionService.scheduleExecution() is deprecated. Use TransactionPreparationService + executeRecord() instead.');
    }

    /**
     * Legacy get active execution method - not used in new architecture  
     */
    async getActiveExecutionForEndpoint(endpointId: string): Promise<RunAPIResponse | null> {
        return null;
    }

    /**
     * Log an execution event using the ExecutionLoggingService
     */
    private async logExecutionEvent(executionId: string, event: any): Promise<void> {
        try {
            if (this.dependencies.executionLoggingService) {
                await this.dependencies.executionLoggingService.logExecutionEvent(executionId, event);
            }
        } catch (error) {
            // Don't let logging failures break execution - just log to console
            this.logger.warn(`[ExecutionService] Failed to log event for ${executionId}`, error, { executionId });
        }
    }

    /**
     * Sanitize headers by removing sensitive information
     */
    private sanitizeHeaders(headers: Record<string, any> | undefined): Record<string, any> | undefined {
        if (!headers) return undefined;

        const sanitized = { ...headers };

        // List of header names that should be redacted
        const sensitiveHeaders = ['authorization', 'x-api-key', 'x-auth-token', 'cookie', 'set-cookie'];

        for (const key of Object.keys(sanitized)) {
            if (sensitiveHeaders.includes(key.toLowerCase())) {
                sanitized[key] = '[REDACTED]';
            }
        }

        return sanitized;
    }

    /**
     * Sanitize response data by limiting size and removing sensitive information
     */
    private sanitizeResponseData(data: any): any {
        if (!data) return data;

        try {
            const dataStr = JSON.stringify(data);
            // Limit response data size in logs to prevent huge log files
            const maxSize = 10000; // 10KB

            if (dataStr.length > maxSize) {
                return {
                    _truncated: true,
                    _originalSize: dataStr.length,
                    _preview: dataStr.substring(0, maxSize - 100) + '...[truncated]'
                };
            }

            return data;
        } catch (error) {
            return { _error: 'Failed to sanitize response data', _type: typeof data };
        }
    }

}