// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Response Data Extractor Service
 * 
 * Following Architecture.md - Service Design patterns
 * Backend business logic for extracting table data from API response files
 */

import { readRunFile, runFileExists } from '../run-content/run-content-store';
import * as path from 'path';
import {
    ExtractedTableData,
    ColumnDefinition,
    ResponseMetadata,
    TableRow,
    StructureAnalysis,
    ArrayInfo,
    ObjectInfo,
    FlatteningStrategy,
    TabbedConsoleData,
    RawConsoleData,
    RawResponse,
    TabData,
    PathInfo
} from '../../types/console-messages';
import { ArrayHandlerService, ArrayAnalysis } from './array-handler.service';
import { ExpandableRowRendererService, NestedObjectAnalysis } from './expandable-row-renderer.service';
import { ProgressiveDisclosureManagerService, HierarchyAnalysis } from './progressive-disclosure-manager.service';
import { RootPathAnalyzerService } from './root-path-analyzer.service';
import { IExecutionLoggingService } from '../logging/execution-logging.interface';
// GitHub Issue #110: Import shared table builder utility to eliminate code duplication
import * as consoleTableBuilderScript from '../../webviews/shared/console-table-builder.js';
import { sharedScript } from '../../utils/shared-script';
const { createConsoleTableBuilder } = sharedScript<typeof consoleTableBuilderScript>(consoleTableBuilderScript, 'ConsoleTableBuilder');

/** #428: a batch member's reason for being an error, keyed by its response file. */
export interface ResponseFileDetail {
    errorMessage?: string;
    testStatus?: string;
}

export interface IResponseDataExtractor {
    /**
     * Extract table data from individual transaction response file
     */
    extractIndividualResponse(responseFile: string): Promise<ExtractedTableData>;

    /**
     * Extract and aggregate table data from multiple batch response files
     */
    extractBatchResponses(responseFiles: string[]): Promise<ExtractedTableData>;

    /**
     * Extract tabbed data from batch responses (input, success, errors)
     */
    extractTabbedBatchData(responseFiles: string[], inputFile?: string): Promise<TabbedConsoleData>;

    /** GitHub Issue #312: the per-file half of extractRawConsoleData, for chunked streaming. */
    extractResponses(responseFiles: string[], responseFileStatusMap?: Record<string, string>, responseFileDetails?: Record<string, ResponseFileDetail>): Promise<RawResponse[]>;

    /**
     * Extract raw response data - the RIGHT way for dynamic path selection
     * @param executionId - Execution ID for individual transactions
     * @param batchId - Batch ID for batch reports (GitHub Issue #102)
     * @param responseFileStatusMap - Maps responseFile path -> database status for classification
     */
    extractRawConsoleData(responseFiles: string[], inputFile?: string, requestFile?: string, logFile?: string, executionId?: string, batchId?: string, responseFileStatusMap?: Record<string, string>, responseFileDetails?: Record<string, ResponseFileDetail>): Promise<RawConsoleData>;

    /**
     * Classify responses into success and errors based on HTTP status
     */
    classifyResponses(responses: any[]): { success: any[]; errors: any[] };

    /**
     * Extract data at a specific path from an array of objects
     */
    extractAtPath(data: any[], path: string): any[];

    /**
     * Format cell value for export
     */
    formatCellValue(value: any): string;

    /**
     * Infer columns from data
     */
    inferColumnsFromData(data: any[]): ColumnDefinition[];

    /**
     * GitHub Issue #229: view-driven row extraction for rendering + export.
     */
    extractRowsForView(responses: any[], view: unknown): Array<Record<string, unknown>>;

    /**
     * GitHub Issue #229: cartesian-product flatten of nested-array columns.
     */
    flattenNestedForExport(rows: Array<Record<string, unknown>>, view: unknown): Array<Record<string, unknown>>;
    
    /**
     * Analyze data structure to suggest optimal display strategy
     */
    analyzeDataStructure(data: any): StructureAnalysis;

    /**
     * Lazy load logs progressively (GitHub Issue #94)
     * Loads logs in chunks for better UX
     * Supports both batch and individual transactions
     * @param batchIdOrExecutionId - Batch ID for batch transactions, or execution ID for individual transactions
     */
    loadLogsProgressively(
        batchIdOrExecutionId: string,
        chunkSize?: number,
        onChunk?: (chunk: string[], progress: { loaded: number; total: number }) => Promise<void>
    ): Promise<string[]>;
}

export interface ResponseDataExtractorDependencies {
    executionLoggingService?: IExecutionLoggingService;
    executionMetadataService?: any; // IExecutionMetadataService - using 'any' to avoid circular dependency
}

export class ResponseDataExtractor implements IResponseDataExtractor {
    private arrayHandler: ArrayHandlerService;
    private expandableRenderer: ExpandableRowRendererService;
    private disclosureManager: ProgressiveDisclosureManagerService;
    private rootPathAnalyzer: RootPathAnalyzerService;
    private executionLoggingService?: IExecutionLoggingService;
    private executionMetadataService?: any;
    private fileReadDebugCount = 0;

    // GitHub Issue #110: Use shared table builder utility for table generation
    // Eliminates code duplication between frontend and backend
    private tableBuilder: any;

    constructor(
        private dependencies: ResponseDataExtractorDependencies = {}
    ) {
        // Initialize our nested data handling services
        this.arrayHandler = new ArrayHandlerService();
        this.expandableRenderer = new ExpandableRowRendererService();
        this.disclosureManager = new ProgressiveDisclosureManagerService();
        this.rootPathAnalyzer = new RootPathAnalyzerService();
        this.executionLoggingService = dependencies.executionLoggingService;
        this.executionMetadataService = dependencies.executionMetadataService;

        // Initialize shared table builder (GitHub Issue #110)
        this.tableBuilder = createConsoleTableBuilder();
    }

    /**
     * Extract table data from individual transaction response file
     */
    async extractIndividualResponse(responseFile: string): Promise<ExtractedTableData> {
        try {
            // Read response file
            const rawData = await this.readResponseFile(responseFile);
            
            // Extract execution metadata from file path/name
            const executionId = this.extractExecutionIdFromPath(responseFile);
            
            // Analyze and flatten data structure
            const structureAnalysis = this.analyzeDataStructure(rawData);
            const { rows, columns } = this.processDataForTable(rawData, structureAnalysis);
            
            // Create metadata
            const metadata: ResponseMetadata = {
                totalRows: rows.length,
                executionId,
                extractionTime: Date.now(), // Will be calculated by caller
                dataType: 'individual'
            };

            return {
                rows,
                columns,
                metadata
            };

        } catch (error) {
            throw new Error(`Failed to extract individual response from ${responseFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Extract and aggregate table data from multiple batch response files
     */
    async extractBatchResponses(responseFiles: string[]): Promise<ExtractedTableData> {
        try {
            const allRows: TableRow[] = [];
            const columnMap = new Map<string, ColumnDefinition>();
            let totalExtractionTime = 0;
            
            // Extract batch ID from first file path
            const batchId = responseFiles.length > 0 ? this.extractBatchIdFromPath(responseFiles[0]) : undefined;

            // Process each response file
            for (const responseFile of responseFiles) {
                const startTime = Date.now();
                
                try {
                    const rawData = await this.readResponseFile(responseFile);
                    const executionId = this.extractExecutionIdFromPath(responseFile);
                    
                    // Add execution metadata to each row
                    const structureAnalysis = this.analyzeDataStructure(rawData);
                    const { rows, columns } = this.processDataForTable(rawData, structureAnalysis);
                    
                    // Add execution context to each row
                    const enrichedRows = rows.map(row => ({
                        ...row,
                        __executionId: executionId,
                        __sourceFile: path.basename(responseFile),
                        __httpStatus: this.extractHttpStatusFromResponse(rawData),
                        __responseTime: this.extractResponseTimeFromResponse(rawData)
                    }));
                    
                    allRows.push(...enrichedRows);
                    
                    // Merge column definitions
                    columns.forEach(column => {
                        if (!columnMap.has(column.id)) {
                            columnMap.set(column.id, column);
                        }
                    });
                    
                    totalExtractionTime += Date.now() - startTime;
                    
                } catch (fileError) {
                    // Add error row for failed file processing
                    allRows.push({
                        __executionId: this.extractExecutionIdFromPath(responseFile),
                        __sourceFile: path.basename(responseFile),
                        __error: fileError instanceof Error ? fileError.message : String(fileError),
                        __httpStatus: 'ERROR',
                        __responseTime: 0
                    });
                }
            }
            
            // Add execution metadata columns
            this.addExecutionMetadataColumns(columnMap);
            
            // Create metadata
            const metadata: ResponseMetadata = {
                totalRows: allRows.length,
                batchId,
                extractionTime: totalExtractionTime,
                dataType: 'batch'
            };

            return {
                rows: allRows,
                columns: Array.from(columnMap.values()),
                metadata
            };

        } catch (error) {
            throw new Error(`Failed to extract batch responses: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Extract tabbed data from batch responses (input, success, errors)
     */
    async extractTabbedBatchData(responseFiles: string[], inputFile?: string): Promise<TabbedConsoleData> {
        try {
            const result: TabbedConsoleData = {
                metadata: {
                    totalRows: 0,
                    extractionTime: 0,
                    dataType: 'batch'
                }
            };

            let totalExtractionTime = 0;
            const startTime = Date.now();

            // Extract input CSV if provided
            if (inputFile && await this.fileExists(inputFile)) {
                try {
                    const inputData = await this.parseCSVFile(inputFile);
                    const inputPaths = this.rootPathAnalyzer.discoverPaths(inputData);
                    
                    result.input = {
                        type: 'input',
                        rows: inputData,
                        columns: this.inferColumnsFromData(inputData),
                        count: inputData.length,
                        rootPath: 'root',
                        availablePaths: inputPaths
                    };
                } catch (error) {
                    console.warn('[ResponseDataExtractor] Could not parse input CSV:', error);
                }
            }

            // Process response files and separate by status
            const successResponses: any[] = [];
            const errorResponses: any[] = [];

            for (const responseFile of responseFiles) {
                try {
                    const rawData = await this.readResponseFile(responseFile);
                    const httpStatus = this.extractHttpStatusFromResponse(rawData);
                    
                    // Add execution metadata
                    const enrichedData = {
                        ...rawData,
                        __executionId: this.extractExecutionIdFromPath(responseFile),
                        __sourceFile: path.basename(responseFile),
                        __httpStatus: httpStatus,
                        __responseTime: this.extractResponseTimeFromResponse(rawData)
                    };

                    if (httpStatus >= 200 && httpStatus < 400) {
                        successResponses.push(enrichedData);
                    } else if (httpStatus >= 400) {
                        errorResponses.push(enrichedData);
                    }
                } catch (error) {
                    // Add to errors with error info
                    errorResponses.push({
                        __executionId: this.extractExecutionIdFromPath(responseFile),
                        __sourceFile: path.basename(responseFile),
                        __error: error instanceof Error ? error.message : String(error),
                        __httpStatus: 'ERROR',
                        __responseTime: 0
                    });
                }
            }

            // Create success tab data
            if (successResponses.length > 0) {
                const sampleSuccess = successResponses[0];
                const successPaths = this.rootPathAnalyzer.discoverPaths(sampleSuccess);
                const defaultPath = this.findBestDefaultPath(successPaths, 'success');

                result.success = {
                    type: 'success',
                    rows: successResponses,
                    columns: this.inferColumnsFromData(successResponses),
                    count: successResponses.length,
                    rootPath: defaultPath,
                    availablePaths: successPaths
                };
            }

            // Create errors tab data
            if (errorResponses.length > 0) {
                const sampleError = errorResponses[0];
                const errorPaths = this.rootPathAnalyzer.discoverPaths(sampleError);
                const defaultPath = this.findBestDefaultPath(errorPaths, 'errors');

                result.errors = {
                    type: 'errors',
                    rows: errorResponses,
                    columns: this.inferColumnsFromData(errorResponses),
                    count: errorResponses.length,
                    rootPath: defaultPath,
                    availablePaths: errorPaths
                };
            }

            // Update metadata
            totalExtractionTime = Date.now() - startTime;
            result.metadata = {
                totalRows: (result.input?.count || 0) + (result.success?.count || 0) + (result.errors?.count || 0),
                extractionTime: totalExtractionTime,
                dataType: 'batch',
                batchId: responseFiles.length > 0 ? this.extractBatchIdFromPath(responseFiles[0]) : undefined
            };

            return result;

        } catch (error) {
            throw new Error(`Failed to extract tabbed batch data: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Extract raw response data - the RIGHT way for dynamic path selection
     * @param executionId - Execution ID (can be batch or individual transaction ID)
     * @param batchId - Batch ID for batch reports (GitHub Issue #102)
     * @param responseFileStatusMap - Maps responseFile path -> database status for classification
     */
    /**
     * Read and parse a set of response files into Console rows (GitHub Issue #312).
     * The per-file half of extractRawConsoleData, on its own so the Console
     * host can stream a large batch in chunks instead of reading every file
     * before the webview sees anything. A file that cannot be read still
     * yields a row — an error row with the reason — so the count stays honest.
     */
    async extractResponses(responseFiles: string[], responseFileStatusMap?: Record<string, string>, responseFileDetails?: Record<string, ResponseFileDetail>): Promise<RawResponse[]> {
        // All of a chunk's files are read in parallel (one await), not one after another
        // (a hundred). Each sequential await yields to the event loop, and with a batch
        // running that loop is busy — 100 files that read in 25 ms on an idle host took
        // seconds per chunk, which is why a Console load crawled until the batch was
        // paused (Issue #312).
        return Promise.all(responseFiles.map(async (responseFile): Promise<RawResponse> => {
            // Get database status from map (for classification)
            // This is the authoritative status: completed, error, pending, etc.
            const dbStatus = responseFileStatusMap?.[responseFile];
            // #428: why it is an error, and whether a response test decided it
            const detail = responseFileDetails?.[responseFile];
            const why = {
                ...(detail?.errorMessage ? { errorMessage: detail.errorMessage } : {}),
                ...(detail?.testStatus ? { testStatus: detail.testStatus } : {})
            };
            try {
                const rawData = await this.readResponseFile(responseFile);

                // The response file already has the correct structure, don't double-wrap it
                // Add metadata directly to the existing structure instead of wrapping
                return {
                    ...rawData, // Use the existing structure (already has httpStatus, headers, data, etc.)
                    status: dbStatus, // Database status for classification (completed, error, etc.)
                    metadata: {
                        ...rawData.metadata, // Preserve any existing metadata
                        executionId: this.extractExecutionIdFromPath(responseFile),
                        sourceFile: path.basename(responseFile),
                        responseTime: this.extractResponseTimeFromResponse(rawData),
                        timestamp: this.extractTimestampFromResponse(rawData),
                        status: dbStatus, // Also in metadata for consistency
                        ...why
                    }
                };
            } catch (error) {
                // Add error responses too - they're still valuable data
                return {
                    httpStatus: 'ERROR',
                    status: dbStatus || 'error', // Use DB status or default to error
                    data: {
                        error: error instanceof Error ? error.message : String(error),
                        type: 'EXTRACTION_ERROR'
                    },
                    metadata: {
                        executionId: this.extractExecutionIdFromPath(responseFile),
                        sourceFile: path.basename(responseFile),
                        responseTime: 0,
                        status: dbStatus || 'error'
                    }
                };
            }
        }));
    }

    async extractRawConsoleData(responseFiles: string[], inputFile?: string, requestFile?: string, logFile?: string, executionId?: string, batchId?: string, responseFileStatusMap?: Record<string, string>, responseFileDetails?: Record<string, ResponseFileDetail>): Promise<RawConsoleData> {
        try {
            const startTime = Date.now();
            const responses = await this.extractResponses(responseFiles, responseFileStatusMap, responseFileDetails);

            // Parse input CSV if provided
            let inputData: TableRow[] | undefined;
            if (inputFile && await this.fileExists(inputFile)) {
                try {
                    inputData = await this.parseCSVFile(inputFile);
                } catch (error) {
                    console.warn('[ResponseDataExtractor] Could not parse input CSV:', error);
                }
            }

            // Discover all available paths from the full response structure
            // Now responses are not double-wrapped, so analyze the response directly
            const sampleResponse = responses.find(r => r && typeof r === 'object');
            const availablePaths = sampleResponse ? this.rootPathAnalyzer.discoverPaths(sampleResponse) : [
                { path: 'root', type: 'object' as const, depth: 0, recommended: true, description: 'Full response' }
            ];

            // Extract request content if provided and valid
            let requestContent: string | undefined;
            let hasValidRequest = false;
            if (requestFile && await this.fileExists(requestFile)) {
                try {
                    const requestData = await this.readRequestFile(requestFile);
                    if (this.isValidRequestContent(requestData)) {
                        requestContent = typeof requestData === 'string' ? requestData : JSON.stringify(requestData, null, 2);
                        hasValidRequest = true;
                    }
                } catch (error) {
                    console.warn('[ResponseDataExtractor] Could not read request file:', error);
                }
            }

            // LAZY LOADING: Skip log loading during initial report open (GitHub Issue #94)
            // Logs will be loaded on-demand when user clicks the Logs tab
            // This saves 12+ seconds on initial load for large batches
            let logContent: string[] | undefined = undefined;

            const extractionTime = Date.now() - startTime;

            // GitHub Issue #102: Query batch metadata to populate diagnostic stats
            let batchRows: string | undefined;
            if (batchId && this.executionMetadataService) {
                try {
                    const batchMetadata = await this.executionMetadataService.getBatchExecution(batchId);
                    if (batchMetadata) {
                        batchRows = batchMetadata.rows; // Format: "77(308)" = 77 transactions from 308 CSV rows
                    }
                } catch (error) {
                    console.warn('[ResponseDataExtractor] Could not load batch metadata for diagnostic stats:', error);
                }
            }

            return {
                responses,
                inputData,
                availablePaths,
                metadata: {
                    totalRows: responses.length,
                    extractionTime,
                    dataType: 'raw',
                    // Execution ID - works for both batch and individual transactions
                    executionId: executionId,
                    // GitHub Issue #102: Batch ID and rows for diagnostic stats
                    batchId: batchId,
                    rows: batchRows
                },
                // NEW: Request and Logs tab support
                requestContent,
                hasValidRequest,
                logContent,
                isStreaming: false, // Will be set to true for batch operations with active streaming
                lastRefreshed: new Date()
            };

        } catch (error) {
            throw new Error(`Failed to extract raw report data: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Lazy load logs progressively (GitHub Issue #94 + stack overflow fix)
     * Loads logs in chunks for better UX
     * Supports both batch and individual transactions
     * Uses streaming approach to avoid loading all logs into memory at once
     */
    async loadLogsProgressively(
        batchIdOrExecutionId: string,
        chunkSize: number = 1000,
        onChunk?: (chunk: string[], progress: { loaded: number; total: number }) => Promise<void>
    ): Promise<string[]> {
        if (!this.executionLoggingService) {
            console.warn('[ResponseDataExtractor] No execution logging service available for lazy log loading');
            return [];
        }

        try {
            // Collect all chunks to return as complete array (for backward compatibility)
            const allLogs: string[] = [];

            // Detect if this is a batch or individual transaction
            // Strategy: Check both batch and individual metadata to determine type
            let isBatch = false;
            if (this.executionMetadataService) {
                // First check if it's a batch
                const batchMetadata = await this.executionMetadataService.getBatchExecution(batchIdOrExecutionId);
                if (batchMetadata) {
                    isBatch = true;
                } else {
                    // Not a batch - check if it's an individual execution
                    const individualMetadata = await this.executionMetadataService.getExecution(batchIdOrExecutionId);
                    if (individualMetadata) {
                        isBatch = false;
                    } else {
                        console.warn(`[ResponseDataExtractor] No metadata found for ID: ${batchIdOrExecutionId} - will attempt individual log loading`);
                        isBatch = false;
                    }
                }
            } else {
                console.warn('[ResponseDataExtractor] No metadata service available for batch detection - defaulting to individual');
                isBatch = false;
            }

            if (isBatch) {
                // It's a batch - use STREAMING approach to avoid loading all logs at once
                // This prevents stack overflow for large batches
                await this.executionLoggingService.streamBatchLogsToWebview(
                    batchIdOrExecutionId,
                    async (chunk: string[], progress: { loaded: number; total: number }) => {
                        // Collect chunk for return value
                        allLogs.push(...chunk);

                        // Forward to caller's callback if provided
                        if (onChunk) {
                            await onChunk(chunk, progress);
                        }
                    },
                    chunkSize
                );
            } else {
                // Individual transaction - load individual logs (these are typically small)
                const logs = await this.executionLoggingService.formatIndividualTransactionLogs(batchIdOrExecutionId);
                allLogs.push(...logs);

                // If callback provided, send all logs as a single chunk
                if (onChunk) {
                    await onChunk(logs, { loaded: logs.length, total: logs.length });
                }
            }

            return allLogs;

        } catch (error) {
            console.error('[ResponseDataExtractor] Failed to load logs progressively:', error);
            throw new Error(`Failed to load logs for ${batchIdOrExecutionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Analyze data structure to suggest optimal display strategy
     */
    analyzeDataStructure(data: any): StructureAnalysis {
        // Use ProgressiveDisclosureManager for overall hierarchy analysis
        const hierarchyAnalysis = this.disclosureManager.analyzeHierarchy(data);
        
        // Analyze arrays within the data
        const arrayAnalyses: ArrayAnalysis[] = [];
        const arrayPaths = this.findArrayPaths(data);
        
        arrayPaths.forEach(arrayPath => {
            const arrayData = this.getValueByPath(data, arrayPath.path);
            if (Array.isArray(arrayData)) {
                const analysis = this.arrayHandler.analyzeArray(arrayPath.path, arrayData);
                arrayAnalyses.push(analysis);
            }
        });
        
        // Analyze nested objects
        const objectAnalyses: NestedObjectAnalysis[] = [];
        const objectPaths = this.findObjectPaths(data);
        
        objectPaths.forEach(objectPath => {
            const objectData = this.getValueByPath(data, objectPath.path);
            if (typeof objectData === 'object' && objectData !== null && !Array.isArray(objectData)) {
                const analysis = this.expandableRenderer.analyzeNestedObject(objectPath.path, objectData);
                objectAnalyses.push(analysis);
            }
        });
        
        // Convert analyses to message format
        const arrayInfos: ArrayInfo[] = arrayAnalyses.map(analysis => ({
            path: analysis.path,
            length: analysis.length,
            strategy: analysis.displayStrategy.type,
            itemType: analysis.itemType
        }));
        
        const objectInfos: ObjectInfo[] = objectAnalyses.map(analysis => ({
            path: analysis.path,
            properties: analysis.properties.map(p => p.key),
            depth: analysis.depth
        }));
        
        // Determine overall suggested view based on intelligent analysis
        let suggestedView: 'table' | 'tree' | 'modal' = 'table';
        
        if (hierarchyAnalysis.maxDepth > 4 || hierarchyAnalysis.totalItems > 100) {
            suggestedView = 'tree';
        }
        
        // If we have large arrays that need modal display, suggest modal
        if (arrayAnalyses.some(analysis => analysis.displayStrategy.type === 'modal')) {
            suggestedView = 'modal';
        }
        
        // Determine smart flattening strategy - ALWAYS enable for table view
        // Only disable flattening when explicitly using tree/modal views
        const hasVeryComplexStructures = hierarchyAnalysis.maxDepth > 4 || 
                                         arrayAnalyses.some(a => a.displayStrategy.type === 'modal');
        
        const flatteningStrategy: FlatteningStrategy = {
            enabled: true, // Always enable flattening for table view
            maxDepth: hasVeryComplexStructures ? 3 : 4, // Increase max depth
            separator: '.',
            arrayHandling: this.determineOverallArrayStrategy(arrayAnalyses)
        };
        
        return {
            type: this.determineDataType(data),
            depth: hierarchyAnalysis.maxDepth,
            arrayPaths: arrayInfos,
            objectPaths: objectInfos,
            suggestedView,
            flatteningStrategy
        };
    }

    /**
     * Classify responses into success and errors based on HTTP status
     * Used by export functionality to split responses by status
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    classifyResponses(responses: any[]): { success: any[]; errors: any[] } {
        return this.tableBuilder.classifyResponses(responses);
    }

    /**
     * Extract data at a specific path from an array of objects
     * Supports nested paths like 'data.items' or 'response.data'
     * Used by export functionality to navigate to the correct data level
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    extractAtPath(data: any[], path: string): any[] {
        return this.tableBuilder.extractAtPath(data, path);
    }

    /**
     * Format cell value for export
     * Arrays → "[N items]", Objects → JSON, null/undefined → "", primitives → String
     * Used by export functionality to format values consistently
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    formatCellValue(value: any): string {
        return this.tableBuilder.formatCellValue(value);
    }

    /**
     * GitHub Issue #229: view-driven extraction. Produces flat row objects
     * keyed by absolute column id. The view is the authoritative column spec —
     * no column discovery or visibility filtering needed at extract time.
     */
    extractRowsForView(responses: any[], view: unknown): Array<Record<string, unknown>> {
        return this.tableBuilder.extractRowsForView(responses, view);
    }

    /**
     * GitHub Issue #229: flatten nested-array columns into cartesian-product
     * rows for CSV/Excel exports (preserves legacy flatten-on-export behaviour).
     */
    flattenNestedForExport(rows: Array<Record<string, unknown>>, view: unknown): Array<Record<string, unknown>> {
        return this.tableBuilder.flattenNestedForExport(rows, view);
    }

    /**
     * Determine overall array handling strategy based on individual analyses
     */
    private determineOverallArrayStrategy(arrayAnalyses: ArrayAnalysis[]): 'concatenate' | 'expand' | 'modal' {
        if (arrayAnalyses.length === 0) return 'concatenate';
        
        // If any array needs modal, use modal
        if (arrayAnalyses.some(a => a.displayStrategy.type === 'modal')) {
            return 'modal';
        }
        
        // If any array needs inline (expand), use expand
        if (arrayAnalyses.some(a => a.displayStrategy.type === 'inline')) {
            return 'expand';
        }
        
        // Otherwise concatenate
        return 'concatenate';
    }
    
    /**
     * Get value from object using dot notation path
     */
    private getValueByPath(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => {
            if (current && typeof current === 'object') {
                return current[key];
            }
            return undefined;
        }, obj);
    }

    /**
     * Read and parse response file
     */
    private async readResponseFile(filePath: string): Promise<any> {
        try {
            const startTime = Date.now();
            const content = readRunFile(filePath);
            const readTime = Date.now() - startTime;

            // Try to parse as JSON first
            try {
                const parsed = JSON.parse(content);
                return parsed;
            } catch (jsonError) {
                // If not JSON, return as plain text with structure
                return {
                    content: content.trim(),
                    contentType: 'text/plain',
                    originalFile: path.basename(filePath)
                };
            }
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Process raw data into table format
     */
    private processDataForTable(rawData: any, analysis: StructureAnalysis): { rows: TableRow[]; columns: ColumnDefinition[] } {
        if (Array.isArray(rawData)) {
            return this.processArrayData(rawData, analysis);
        } else if (typeof rawData === 'object' && rawData !== null) {
            return this.processObjectData(rawData, analysis);
        } else {
            return this.processPrimitiveData(rawData);
        }
    }

    /**
     * Process array data into table format
     */
    private processArrayData(data: any[], analysis: StructureAnalysis): { rows: TableRow[]; columns: ColumnDefinition[] } {
        if (data.length === 0) {
            return { rows: [], columns: [] };
        }

        // Get all unique keys from all objects in array
        const allKeys = new Set<string>();
        data.forEach(item => {
            if (typeof item === 'object' && item !== null) {
                this.extractAllKeys(item, '', allKeys, analysis.flatteningStrategy.maxDepth);
            }
        });

        // Generate column definitions
        const columns: ColumnDefinition[] = Array.from(allKeys).map(key => ({
            id: key,
            name: this.formatColumnName(key),
            type: this.inferColumnType(data, key),
            sortable: true,
            filterable: true,
            nested: key.includes('.')
        }));

        // Generate rows with flattened data
        const rows: TableRow[] = data.map((item, index) => {
            const flattened = this.flattenObject(item, '', analysis.flatteningStrategy);
            return {
                __index: index,
                ...flattened
            };
        });

        return { rows, columns };
    }

    /**
     * Process single object data into table format
     */
    private processObjectData(data: any, analysis: StructureAnalysis): { rows: TableRow[]; columns: ColumnDefinition[] } {
        // Priority 1: Find the first "data" property containing an array (breadth-first search)
        const firstDataArray = this.findFirstDataArray(data);
        if (firstDataArray) {
            return this.processArrayData(firstDataArray, analysis);
        }
        
        // Priority 2: Check for any array properties if no "data" array found
        const arrayProperties = Object.entries(data).filter(([key, value]) => Array.isArray(value));
        
        // If there are array properties, use the largest one
        if (arrayProperties.length > 0) {
            const largestArray = arrayProperties.reduce((prev, current) => 
                (current[1] as any[]).length > (prev[1] as any[]).length ? current : prev
            );
            return this.processArrayData(largestArray[1] as any[], analysis);
        }
        
        // Priority 3: If there's a "data" property (but not an array), process it
        if (data.data && typeof data.data === 'object' && data.data !== null) {
            // Check if the data object contains arrays
            const nestedDataArray = this.findFirstDataArray(data.data);
            if (nestedDataArray) {
                return this.processArrayData(nestedDataArray, analysis);
            }
            
            // Treat data object as single-row table
            const flattened = this.flattenObject(data.data, '', analysis.flatteningStrategy);
            
            const columns: ColumnDefinition[] = Object.keys(flattened).map(key => ({
                id: key,
                name: this.formatColumnName(key),
                type: this.inferDataType(flattened[key]),
                sortable: true,
                filterable: true,
                nested: key.includes('.')
            }));

            const rows: TableRow[] = [{ __index: 0, ...flattened }];
            return { rows, columns };
        }
        
        // Priority 4: Fallback to original object flattening behavior
        const flattened = this.flattenObject(data, '', analysis.flatteningStrategy);
        
        const columns: ColumnDefinition[] = Object.keys(flattened).map(key => ({
            id: key,
            name: this.formatColumnName(key),
            type: this.inferDataType(flattened[key]),
            sortable: true,
            filterable: true,
            nested: key.includes('.')
        }));

        const rows: TableRow[] = [{ __index: 0, ...flattened }];

        return { rows, columns };
    }

    /**
     * Find the first "data" property that contains an array (breadth-first search)
     * This addresses issue #66 where the actual data array is nested in data.data
     */
    private findFirstDataArray(obj: any, visited: Set<any> = new Set()): any[] | null {
        // Prevent circular reference issues
        if (!obj || typeof obj !== 'object' || visited.has(obj)) {
            return null;
        }
        visited.add(obj);

        // Check direct properties first (breadth-first)
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'data' && Array.isArray(value) && value.length > 0) {
                return value;
            }
        }
        
        // Then check nested objects
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
                const nestedArray = this.findFirstDataArray(value, visited);
                if (nestedArray) {
                    return nestedArray;
                }
            }
        }
        
        return null;
    }

    /**
     * Process primitive data into table format
     */
    private processPrimitiveData(data: any): { rows: TableRow[]; columns: ColumnDefinition[] } {
        const columns: ColumnDefinition[] = [
            {
                id: 'value',
                name: 'Value',
                type: this.inferDataType(data),
                sortable: true,
                filterable: true
            }
        ];

        const rows: TableRow[] = [{ __index: 0, value: data }];

        return { rows, columns };
    }

    /**
     * Flatten nested object using dot notation
     */
    private flattenObject(obj: any, prefix: string, strategy: FlatteningStrategy, currentDepth = 0): any {
        const result: any = {};

        if (!strategy.enabled) {
            result[prefix || 'data'] = obj;
            return result;
        }

        // If we've reached max depth, handle arrays and objects gracefully
        if (currentDepth >= strategy.maxDepth) {
            if (Array.isArray(obj)) {
                result[prefix || 'data'] = `${obj.length} items`;
            } else if (typeof obj === 'object' && obj !== null) {
                result[prefix || 'data'] = `{${Object.keys(obj).length} properties}`;
            } else {
                result[prefix || 'data'] = obj;
            }
            return result;
        }

        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const newKey = prefix ? `${prefix}${strategy.separator}${key}` : key;
                const value = obj[key];

                if (Array.isArray(value)) {
                    result[newKey] = this.handleArrayValue(value, strategy);
                } else if (typeof value === 'object' && value !== null) {
                    if (currentDepth < strategy.maxDepth - 1) {
                        Object.assign(result, this.flattenObject(value, newKey, strategy, currentDepth + 1));
                    } else {
                        result[newKey] = JSON.stringify(value);
                    }
                } else {
                    result[newKey] = value;
                }
            }
        }

        return result;
    }

    /**
     * Handle array values based on strategy
     * Return the actual array for frontend to render intelligently
     */
    private handleArrayValue(array: any[], strategy: FlatteningStrategy): any {
        // Pass arrays through to frontend - let the frontend handle display
        // The frontend has logic to render based on strategy and array size
        return array;
    }

    /**
     * Extract all keys from nested object structure
     */
    private extractAllKeys(obj: any, prefix: string, keySet: Set<string>, maxDepth: number, currentDepth = 0): void {
        if (currentDepth >= maxDepth) return;

        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const fullKey = prefix ? `${prefix}.${key}` : key;
                const value = obj[key];

                if (Array.isArray(value)) {
                    keySet.add(fullKey);
                } else if (typeof value === 'object' && value !== null) {
                    if (currentDepth < maxDepth - 1) {
                        this.extractAllKeys(value, fullKey, keySet, maxDepth, currentDepth + 1);
                    } else {
                        keySet.add(fullKey);
                    }
                } else {
                    keySet.add(fullKey);
                }
            }
        }
    }

    /**
     * Infer column data type from sample data
     */
    private inferColumnType(data: any[], columnKey: string): 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' {
        const samples = data
            .map(item => this.getNestedValue(item, columnKey))
            .filter(val => val !== null && val !== undefined)
            .slice(0, 10); // Sample first 10 non-null values

        if (samples.length === 0) return 'string';

        // Check for consistent type
        const types = samples.map(val => this.inferDataType(val));
        const mostCommonType = this.getMostCommonType(types);

        return mostCommonType;
    }

    /**
     * Infer data type from single value
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    private inferDataType(value: any): 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' {
        return this.tableBuilder.inferDataType(value);
    }

    /**
     * Get most common type from array of types
     */
    private getMostCommonType(types: string[]): 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' {
        const counts = types.reduce((acc, type) => {
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        return Object.entries(counts).reduce((a, b) => counts[a[0]] > counts[b[0]] ? a : b)[0] as any;
    }

    /**
     * Get nested value from object using dot notation
     */
    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    /**
     * Format column name for display
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    private formatColumnName(key: string): string {
        return this.tableBuilder.formatColumnName(key);
    }

    /**
     * Determine primary data type
     */
    private determineDataType(data: any): 'array' | 'object' | 'primitive' {
        if (Array.isArray(data)) return 'array';
        if (typeof data === 'object' && data !== null) return 'object';
        return 'primitive';
    }

    /**
     * Calculate maximum nesting depth
     */
    private calculateNestingDepth(obj: any, currentDepth = 0): number {
        if (typeof obj !== 'object' || obj === null) return currentDepth;

        let maxDepth = currentDepth;
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const depth = this.calculateNestingDepth(obj[key], currentDepth + 1);
                maxDepth = Math.max(maxDepth, depth);
            }
        }
        return maxDepth;
    }

    /**
     * Find all array paths in data structure
     */
    private findArrayPaths(obj: any, currentPath = ''): ArrayInfo[] {
        const arrays: ArrayInfo[] = [];

        if (Array.isArray(obj)) {
            arrays.push({
                path: currentPath || 'root',
                length: obj.length,
                strategy: obj.length <= 5 ? 'concatenate' : obj.length <= 20 ? 'inline' : 'modal',
                itemType: obj.length > 0 ? typeof obj[0] : 'unknown'
            });
            
            // Recursively check array items
            obj.forEach((item, index) => {
                if (typeof item === 'object' && item !== null) {
                    const itemArrays = this.findArrayPaths(item, `${currentPath}[${index}]`);
                    arrays.push(...itemArrays);
                }
            });
        } else if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const newPath = currentPath ? `${currentPath}.${key}` : key;
                    const childArrays = this.findArrayPaths(obj[key], newPath);
                    arrays.push(...childArrays);
                }
            }
        }

        return arrays;
    }

    /**
     * Find all object paths in data structure
     */
    private findObjectPaths(obj: any, currentPath = ''): ObjectInfo[] {
        const objects: ObjectInfo[] = [];

        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
            const properties = Object.keys(obj);
            objects.push({
                path: currentPath || 'root',
                properties,
                depth: this.calculateNestingDepth(obj)
            });

            // Recursively check nested objects
            for (const key in obj) {
                if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
                    const newPath = currentPath ? `${currentPath}.${key}` : key;
                    const childObjects = this.findObjectPaths(obj[key], newPath);
                    objects.push(...childObjects);
                }
            }
        }

        return objects;
    }

    /**
     * Extract execution ID from file path
     */
    private extractExecutionIdFromPath(filePath: string): string {
        const basename = path.basename(filePath, path.extname(filePath));
        // Assuming format like "response_exec123" or similar
        const match = basename.match(/(?:response_)?(.+)/);
        return match ? match[1] : basename;
    }

    /**
     * Extract batch ID from file path
     */
    private extractBatchIdFromPath(filePath: string): string | undefined {
        // Look for batch indicator in path
        const pathParts = filePath.split(path.sep);
        const batchPart = pathParts.find(part => part.startsWith('batch_'));
        return batchPart ? batchPart.replace('batch_', '') : undefined;
    }

    /**
     * Extract HTTP status from response data
     */
    private extractHttpStatusFromResponse(data: any): number | string {
        if (typeof data === 'object' && data !== null) {
            return data.status || data.statusCode || data.httpStatus || 200;
        }
        return 200;
    }

    /**
     * Extract response time from response data
     */
    private extractResponseTimeFromResponse(data: any): number {
        if (typeof data === 'object' && data !== null) {
            return data.responseTime || data.duration || data.executionTime || 0;
        }
        return 0;
    }

    /**
     * Extract timestamp from response data
     */
    private extractTimestampFromResponse(data: any): string | undefined {
        if (typeof data === 'object' && data !== null) {
            return data.timestamp || data.time || data.createdAt || data.date;
        }
        return undefined;
    }

    /**
     * Add execution metadata columns for batch processing
     */
    private addExecutionMetadataColumns(columnMap: Map<string, ColumnDefinition>): void {
        // Add execution context columns at the beginning
        const metadataColumns: ColumnDefinition[] = [
            {
                id: '__executionId',
                name: 'Execution ID',
                type: 'string',
                sortable: true,
                filterable: true
            },
            {
                id: '__httpStatus',
                name: 'HTTP Status',
                type: 'number',
                sortable: true,
                filterable: true
            },
            {
                id: '__responseTime',
                name: 'Response Time (ms)',
                type: 'number',
                sortable: true,
                filterable: true
            },
            {
                id: '__sourceFile',
                name: 'Source File',
                type: 'string',
                sortable: true,
                filterable: true
            }
        ];

        // Add metadata columns if they don't exist
        metadataColumns.forEach(column => {
            if (!columnMap.has(column.id)) {
                columnMap.set(column.id, column);
            }
        });
    }

    /**
     * Helper methods for tabbed data extraction
     */

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            if (!runFileExists(filePath)) throw new Error(`ENOENT: ${filePath}`);
            return true;
        } catch {
            return false;
        }
    }

    private async parseCSVFile(filePath: string): Promise<TableRow[]> {
        try {
            const content = readRunFile(filePath);
            const lines = content.trim().split('\n');
            
            if (lines.length === 0) {
                return [];
            }

            // Parse header row
            const headers = this.parseCSVLine(lines[0]);
            const rows: TableRow[] = [];

            // Parse data rows
            for (let i = 1; i < lines.length; i++) {
                const values = this.parseCSVLine(lines[i]);
                const row: TableRow = { __index: i - 1 };
                
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                
                rows.push(row);
            }

            return rows;
        } catch (error) {
            throw new Error(`Failed to parse CSV file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++; // Skip next quote
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    /**
     * Infer columns from data
     *
     * GitHub Issue #110: Delegate to shared table builder utility
     */
    inferColumnsFromData(data: any[]): ColumnDefinition[] {
        return this.tableBuilder.inferColumnsFromData(data);
    }

    private findBestDefaultPath(paths: PathInfo[], tabType: 'success' | 'errors'): string {
        // Look for recommended paths first
        const recommended = paths.filter(p => p.recommended);
        if (recommended.length > 0) {
            // Prefer specific path names based on tab type
            if (tabType === 'success') {
                const dataPath = recommended.find(p => 
                    p.path.toLowerCase().includes('data') || 
                    p.path.toLowerCase().includes('response')
                );
                if (dataPath) return dataPath.path;
            } else if (tabType === 'errors') {
                const errorPath = recommended.find(p => 
                    p.path.toLowerCase().includes('error') || 
                    p.path.toLowerCase().includes('message')
                );
                if (errorPath) return errorPath.path;
            }
            
            // Fall back to first recommended path
            return recommended[0].path;
        }

        // No recommended paths, return root
        return 'root';
    }

    /**
     * Read and parse request file content
     */
    private async readRequestFile(filePath: string): Promise<any> {
        try {
            const content = readRunFile(filePath);

            // Try to parse as JSON first
            try {
                return JSON.parse(content);
            } catch (jsonError) {
                // If not JSON, return as plain text
                return content.trim();
            }
        } catch (error) {
            throw new Error(`Failed to read request file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Validate request content to determine if Request tab should be shown
     * Skip empty GET requests (just "{}")
     */
    private isValidRequestContent(requestData: any): boolean {
        // If it's a string, check if it's not empty or just whitespace
        if (typeof requestData === 'string') {
            const trimmed = requestData.trim();
            return trimmed.length > 0 && trimmed !== '{}';
        }

        // If it's an object, check if it's not just an empty object
        if (typeof requestData === 'object' && requestData !== null) {
            // Check if it's an empty object {}
            if (Object.keys(requestData).length === 0) {
                return false;
            }

            // Check if it's an object with only empty/null values
            const hasNonEmptyValues = Object.values(requestData).some(value => {
                if (value === null || value === undefined || value === '') {
                    return false;
                }
                if (typeof value === 'string' && value.trim() === '') {
                    return false;
                }
                return true;
            });

            return hasNonEmptyValues;
        }

        // For other primitive types, consider them valid if not null/undefined
        return requestData !== null && requestData !== undefined;
    }

    /**
     * Read log file content
     */
    private async readLogFile(filePath: string): Promise<string> {
        try {
            const content = readRunFile(filePath);
            return content; // Return raw log content as string
        } catch (error) {
            throw new Error(`Failed to read log file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}