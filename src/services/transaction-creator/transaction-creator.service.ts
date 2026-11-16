// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as path from 'path';
import { writeRunFile } from '../run-content/run-content-store';
import { APIEndpointConfig } from '../../data-loading/types';
import { ITransactionCreator, TransactionCreationOptions, TransactionCreationResult, BatchInitializationOptions, BatchInitializationResult } from './transaction-creator.interface';
import { flattenHeaders, flattenQueryParams } from '../../utils/jwt-validation';
import { IExecutionLoggingService } from '../logging/execution-logging.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { stripJsonCommentsSafe } from '../../utils/json-comment-stripper';
import { BatchPreparationState } from '../../storage/execution-metadata';


/**
 * TransactionCreator Service
 * 
 * Extracts and centralizes the transaction creation logic from ExecutionService
 * to eliminate duplication between individual "Run API" calls and batch processing.
 * 
 * This service creates:
 * 1. Execution metadata record with unique ID
 * 2. JSON request payload (same logic as Dobermann.executeEndpoint)
 * 3. Request file saved to specified location
 * 4. Links to batch if batchId provided
 */
export class TransactionCreator implements ITransactionCreator {
    // GitHub Issue #94: Cache CSV data during batch execution for chunked preparation
    private activeBatchData: Map<string, {
        csvData: any[][];
        batchConfig: any;
        endpoint: APIEndpointConfig;
        environment: string;
        environmentId?: string;
        organization: string;
        workspaceRoot: string;
        environmentFolder?: string;
        nextRowIndex: number;
        directoryPath: string;
    }> = new Map();

    // Configuration for memory management
    private readonly CSV_MEMORY_THRESHOLD = 10000; // Keep in memory if < 10k rows

    constructor(
        private executionMetadataService: any,
        private executionFileService: any,
        private logger: IExtensionDiagnosticLogger,
        private stateBroadcaster?: any,
        private executionLoggingService?: IExecutionLoggingService
    ) { }

    async createTransaction(options: TransactionCreationOptions): Promise<TransactionCreationResult> {
        const {
            endpoint,
            environment,
            environmentId,
            organization,
            directoryPath,
            fileName,
            batchId,
            executionType = 'individual',
            status = 'preparing',
            rowStart,
            rows = '1',
            batchConfig,
            encodedBody // GitHub Issue #127: BASE64 encoded body for dual file creation
        } = options;

        // Debug: Log incoming endpoint headers and parallel processing config
        this.logger.debug(`[TransactionCreator] Incoming endpoint headers`, {
            hasHeaders: !!endpoint.headers,
            headerCount: Object.keys(endpoint.headers || {}).length,
            headers: endpoint.headers
        });

        // Debug: Log parallel processing configuration (GitHub Issue #78)
        this.logger.debug(`[TransactionCreator] Parallel processing config received`, {
            hasBatchConfig: !!batchConfig,
            hasParallelProcessing: !!batchConfig?.parallelProcessing,
            parallelConfig: batchConfig?.parallelProcessing,
            executionType: executionType
        });


        // Step 1: Create execution metadata record with new unified model parameters
        let executionId: string;


        if (executionType === 'batch') {
            // For batch parent transactions, use storeBatchExecution method which accepts metadata directly
            const metadata: any = {
                executionType: 'batch',
                rows: rows !== undefined ? String(rows) : '1',
                environment,
                environmentId,
                organization,
                endpointId: endpoint.id,
                endpointName: endpoint.name,
                endpointMethod: endpoint.method || 'POST',
                endpointPath: endpoint.path,
                batchId, // Will be updated later to match executionId
                status: status,
                createdAt: new Date(),
                // GitHub Issue #47: Store full endpoint config for tree view tolerance display
                endpointConfig: endpoint
            };

            // GitHub Issue #47: Extract error tolerance configuration from endpoint
            // Fixed logic: Handle stopOnFirst mode and proper percentage calculation

            const errorHandling = endpoint.dataLoadingConfig?.errorHandling;
            if (errorHandling?.mode === 'stopOnFirst') {
                // Always create batch config for stop on first error
                metadata.batchConfiguration = {
                    stopOnFirstError: true,
                    errorTolerance: true,
                    maxErrors: 0  // Stop on any error
                };
            } else if (errorHandling?.enableErrorTolerance) {
                // Calculate the actual error limit based on tolerance mode
                let maxErrors: number;

                if (errorHandling.toleranceMode === 'percentage' && errorHandling.percentageErrorLimit) {
                    // Convert percentage to absolute count based on TRANSACTIONS
                    // For batches: rows = "39(300)" means 39 transactions from 300 CSV rows
                    const totalTransactions = parseInt(rows.split('(')[0]) || 1; // Extract "39" from "39(300)"
                    maxErrors = Math.floor((errorHandling.percentageErrorLimit / 100) * totalTransactions);
                } else {
                    // Use absolute limit (no fallback - UI must validate)
                    maxErrors = errorHandling.absoluteErrorLimit || 0; // Fallback to 0 if undefined
                }

                metadata.batchConfiguration = {
                    stopOnFirstError: false,
                    errorTolerance: true,
                    maxErrors: maxErrors
                };
            }
            // else: "Continue indefinitely" - no batch config = no limits

            // Add parallel processing configuration if provided (GitHub Issue #78)
            if (batchConfig?.parallelProcessing) {
                if (!metadata.batchConfiguration) {
                    // Create batchConfiguration with required defaults for schema validation
                    metadata.batchConfiguration = {
                        stopOnFirstError: false,
                        errorTolerance: false,
                        maxErrors: 0
                    };
                }
                metadata.batchConfiguration.parallelProcessing = batchConfig.parallelProcessing;
                this.logger.debug(`[TransactionCreator] Added parallel processing config to batchConfiguration: enabled=${batchConfig.parallelProcessing.enabled}, maxConcurrency=${batchConfig.parallelProcessing.maxConcurrency}`);
            }

            // GitHub Issue #108: Add query param repetition configuration if provided
            if (batchConfig?.repeatableQueryParam) {
                if (!metadata.batchConfiguration) {
                    // Create batchConfiguration with required defaults for schema validation
                    metadata.batchConfiguration = {
                        stopOnFirstError: false,
                        errorTolerance: false,
                        maxErrors: 0
                    };
                }
                metadata.batchConfiguration.repeatableQueryParam = batchConfig.repeatableQueryParam;
                this.logger.debug(`[TransactionCreator] Added query param repetition config to batchConfiguration: enabled=${batchConfig.repeatableQueryParam.enabled}`);
            }

            // #445: the batch's name, shown in History and the Console's Settings
            const batchName = typeof batchConfig?.name === 'string' ? batchConfig.name.trim() : '';
            if (batchName) {
                if (!metadata.batchConfiguration) {
                    metadata.batchConfiguration = { stopOnFirstError: false, errorTolerance: false, maxErrors: 0 };
                }
                metadata.batchConfiguration.name = batchName;
            }

            // GitHub Issue #176: Use overrideBatchId if provided (deterministic batch copy IDs)
            if (options.overrideBatchId) {
                executionId = options.overrideBatchId;
            } else {
                // Generate execution ID first (following the same pattern as SimpleExecutionMetadataManager.generateExecutionId)
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                executionId = `${timestamp}_${Math.random().toString(36).slice(2, 5)}`;
            }

            // Add the generated ID to metadata
            const fullMetadata = { id: executionId, ...metadata };

            // Use storeBatchExecution which handles batch records properly
            const result = await this.executionMetadataService.storeBatchExecution(fullMetadata);
            if (!result.success) {
                throw new Error(`Failed to create batch execution: ${result.errorMessage}`);
            }
        } else {
            // For individual and batch_member transactions, use service interface method

            // DEBUG: Log what we're passing to createExecution
            this.logger.debug(`[TransactionCreator] Calling createExecution with:`, {
                executionType,
                rowStart,
                rows,
                batchId,
                environment,
                environmentId,
                organization
            });

            executionId = await this.executionMetadataService.createExecution(
                endpoint,
                {
                    batchId,
                    executionType,
                    rowStart,
                    rows,
                    environment,
                    environmentId,
                    organization
                } // Pass all context as options
            );

            // DEBUG: Verify what was created
            const createdExecution = await this.executionMetadataService.getExecution(executionId);
            this.logger.debug(`[TransactionCreator] Created execution result:`, {
                executionId,
                rowStart: createdExecution?.rowStart,
                rows: createdExecution?.rows,
                executionType: createdExecution?.executionType
            });
        }

        let requestFilePath: string;
        let jsonPayload: any;

        if (executionType === 'batch') {
            // For batch executions, don't create JSON request files
            // The BatchTransactionHandler already created the CSV file as the request file

            // Create a placeholder request file path for log file generation
            // This ensures batch executions get log files for preparation/finalization events
            requestFilePath = path.join(directoryPath, `${fileName}.batch`); // Placeholder for log file creation
            jsonPayload = {
                batchId: executionId,
                note: 'Batch execution - CSV file is the request file'
            };

            // Update batchId to match executionId for architecture compliance
            await this.executionMetadataService.updateExecution(executionId, {
                batchId: executionId
            });
        } else {
            // Step 2: Use pre-processed JSON payload from JsonGenerator (via handlers)
            // Strip comments before parsing to support JSONC in templates
            const cleanBody = endpoint.body ? stripJsonCommentsSafe(endpoint.body) : '{}';
            jsonPayload = JSON.parse(cleanBody);

            // Step 3: Create request file with provided filename (no complex generation needed)
            // GitHub Issue #127: Save UNENCODED version for debugging
            const unencodedFilePath = await this.createRequestFile(
                jsonPayload,
                fileName,
                directoryPath
            );

            // GitHub Issue #127: If encodedBody provided, also save .encoded.json file
            if (encodedBody) {
                const encodedFileName = fileName.replace('.json', '.encoded.json');
                const encodedPayload = JSON.parse(encodedBody);
                requestFilePath = await this.createRequestFile(
                    encodedPayload,
                    encodedFileName,
                    directoryPath
                );
                this.logger.debug(`[TransactionCreator] Created both files: ${fileName} (unencoded) and ${encodedFileName} (encoded)`);
            } else {
                // No encoding - use unencoded file for execution
                requestFilePath = unencodedFilePath;
            }

            // Step 4: Create log file alongside request file
            let logPath: string | undefined;
            if (this.executionLoggingService && requestFilePath) {
                try {
                    logPath = await this.executionLoggingService.createLogFile(executionId, requestFilePath);

                    // Log the transaction creation event with full execution metadata
                    await this.executionLoggingService.logEvent(logPath, {
                        timestamp: new Date().toISOString(),
                        level: 'info',
                        phase: 'preparation',
                        event: 'transaction_created',
                        data: {
                            executionId,
                            executionType,
                            endpointId: endpoint.id,
                            endpointName: endpoint.name,
                            endpointMethod: endpoint.method,
                            endpointPath: endpoint.path,
                            environment,
                            environmentId: environmentId,
                            organization,
                            batchId: batchId,
                            rowStart: rowStart,
                            rows: rows,
                            status: status,
                            requestFile: requestFilePath,
                            logPath,
                            fileName,
                            directoryPath,
                            requestHeaders: flattenQueryParams(endpoint.headers || {}),
                            requestQueryParams: flattenQueryParams(endpoint.queryParams || {}),
                            createdAt: new Date().toISOString()
                        }
                    });
                } catch (error) {
                    this.logger.warn(`[TransactionCreator] Failed to create log file for ${executionId}`, error, { executionId });
                }
            }

            // Step 5: Update execution metadata with request file path, log path, status, and request metadata
            const updateData: any = {
                requestFile: requestFilePath,
                logPath, // NEW: Store log file path
                status: status, // Use the provided status (preparing/pending)
                // Store headers and query params for individual and batch_member executions
                // GitHub Issue #101: Flatten query params to only include enabled ones
                requestHeaders: flattenHeaders(endpoint.headers || {}),
                requestQueryParams: flattenQueryParams(endpoint.queryParams || {})
            };


            await this.executionMetadataService.updateExecution(executionId, updateData
            );
        }

        // NEW: Broadcast execution creation for immediate UI feedback
        if (this.stateBroadcaster) {
            try {
                // Get the execution details to broadcast
                const execution = await this.executionMetadataService.getExecution(executionId);
                if (execution) {
                    await this.stateBroadcaster.broadcast(
                        'execution-state-changed',
                        {
                            executionId,
                            status: execution.status,
                            execution,
                            executionType: execution.executionType
                        },
                        'TransactionCreator'
                    );
                }
            } catch (error) {
                this.logger.warn('[TransactionCreator] Failed to broadcast execution creation', error);
            }
        }

        return {
            executionId,
            requestFilePath,
            jsonPayload
        };
    }

    /**
     * Generate request file name using same pattern as ExecutionFileService
     * Pattern: {endpoint}-request-{timestamp}-{executionId}.json
     */
    private async generateRequestFileName(endpoint: APIEndpointConfig, executionId: string): Promise<string> {
        if (this.executionFileService?.generateFileName) {
            return await this.executionFileService.generateFileName(endpoint, 'request', executionId);
        }

        // Fallback: create filename using same pattern
        const sanitizedEndpointName = (endpoint.name || 'endpoint')
            .toLowerCase()
            .replace(/[^a-z0-9-_.]/g, '-')
            .substring(0, 20);

        const timestamp = new Date().toISOString()
            .substring(0, 19)
            .replace(/[T:]/g, '-');

        const shortExecutionId = executionId.substring(0, 8);

        return `${sanitizedEndpointName}-request-${timestamp}-${shortExecutionId}.json`;
    }

    /**
     * Create and save request file in specified directory with given filename
     */
    private async createRequestFile(jsonPayload: any, fileName: string, directoryPath: string): Promise<string> {
        // In the run folder's content archive (#358); the path stays the request's identifier
        const fullPath = path.join(directoryPath, fileName);
        writeRunFile(fullPath, JSON.stringify(jsonPayload, null, 2));
        return fullPath;
    }
    // ==================================================================================
    // GitHub Issue #94: Chunked Just-In-Time Preparation Methods
    // ==================================================================================

    /**
     * Initialize a batch without preparing transactions upfront
     * Stores CSV data for chunked access during execution
     */
    async initializeBatch(options: BatchInitializationOptions): Promise<BatchInitializationResult> {
        const { batchId, csvData, batchConfig, endpoint, environment, environmentId, organization, workspaceRoot, environmentFolder } = options;

        this.logger.info(`[TransactionCreator] Initializing batch ${batchId} with ${csvData.length} rows for chunked preparation`);

        // Store CSV data and workspace context for chunked access
        // Directory paths will be calculated per-chunk in prepareNextChunk()
        this.activeBatchData.set(batchId, {
            csvData,
            batchConfig,
            endpoint,
            environment,
            environmentId,
            organization,
            workspaceRoot,
            environmentFolder,
            nextRowIndex: 0,
            directoryPath: '' // Deprecated - paths calculated in prepareNextChunk()
        });

        // Get chunk size from config or use default
        const chunkSize = batchConfig?.chunkedPreparation?.chunkSize || 8;

        // Initialize batch metadata with preparation state
        const preparationState: BatchPreparationState = {
            totalRows: csvData.length,
            totalTransactions: 0, // Will be updated after analysis
            preparedTransactions: 0,
            nextCsvRowIndex: 0,
            chunkSize,
            isComplete: false
        };

        await this.executionMetadataService.updateExecution(batchId, {
            preparationState
        });

        this.logger.info(`[TransactionCreator] Batch ${batchId} initialized - totalRows: ${csvData.length}, chunkSize: ${chunkSize}`);

        return {
            batchId,
            totalRows: csvData.length,
            chunkSize,
            csvDataStored: true,
            storageMechanism: csvData.length <= this.CSV_MEMORY_THRESHOLD ? 'memory' : 'memory' // Future: implement disk storage
        };
    }

    /**
     * Prepare next chunk of transactions for a batch
     * GitHub Issue #94: Deprecated - use TransactionPreparationService.prepareNextChunk instead
     */
    async prepareNextChunk(batchId: string): Promise<number> {
        // DEPRECATED: This implementation is no longer used
        // The real JIT implementation is in TransactionPreparationService
        throw new Error('[TransactionCreator] prepareNextChunk is deprecated. Use TransactionPreparationService instead.');
    }

    /**
     * Cancel ongoing batch preparation
     * GitHub Issue #94: Deprecated - use TransactionPreparationService.cancelBatchPreparation instead
     */
    cancelBatchPreparation(batchId: string): void {
        // DEPRECATED: This implementation is no longer used
        this.logger.warn('[TransactionCreator] cancelBatchPreparation is deprecated. Use TransactionPreparationService instead.');
    }

    /**
     * Check if batch has more rows to prepare
     */
    async hasMoreRows(batchId: string): Promise<boolean> {
        const batchData = this.activeBatchData.get(batchId);
        if (!batchData) {
            return false;
        }

        return batchData.nextRowIndex < batchData.csvData.length;
    }

    /**
     * Get current preparation state for a batch
     */
    async getPreparationState(batchId: string): Promise<{
        totalRows: number;
        preparedRows: number;
        nextRowIndex: number;
    }> {
        const execution = await this.executionMetadataService.getExecution(batchId);

        if (!execution || !execution.preparationState) {
            throw new Error(`[TransactionCreator] No preparation state found for batch ${batchId}`);
        }

        return {
            totalRows: execution.preparationState.totalRows,
            preparedRows: execution.preparationState.preparedTransactions || 0,
            nextRowIndex: execution.preparationState.nextCsvRowIndex || 0
        };
    }

    /**
     * Cleanup batch data after execution completes
     */
    async cleanupBatch(batchId: string): Promise<void> {
        this.logger.info(`[TransactionCreator] Cleaning up batch data for ${batchId}`);
        this.activeBatchData.delete(batchId);
    }

    /**
     * Update preparation state in database (private helper)
     */
    private async updatePreparationState(batchId: string, preparedCount: number): Promise<void> {
        const execution = await this.executionMetadataService.getExecution(batchId);

        if (!execution || !execution.preparationState) {
            throw new Error(`[TransactionCreator] Cannot update preparation state - no state found for batch ${batchId}`);
        }

        const updatedState: BatchPreparationState = {
            ...execution.preparationState,
            preparedTransactions: execution.preparationState.preparedTransactions + preparedCount,
            nextCsvRowIndex: execution.preparationState.nextCsvRowIndex + preparedCount
        };

        await this.executionMetadataService.updateExecution(batchId, {
            preparationState: updatedState
        });
    }
}