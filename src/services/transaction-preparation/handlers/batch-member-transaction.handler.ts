// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ITransactionHandler, TransactionHandlerContext, TransactionHandlerResult } from './transaction-handler.interface';
import { ITransactionCreator } from '../../transaction-creator/transaction-creator.interface';
import { IPathGeneratorHelper } from '../helpers/path-generator.helper';
import { TemplateParser } from '../../../data-loading/template-parser';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { encodeBase64Fields } from '../../../utils/encoding';

/**
 * Handler for batch member transactions
 * Creates individual transaction files within a batch directory
 * Uses JsonGenerator for array repetition and template processing
 */
export class BatchMemberTransactionHandler implements ITransactionHandler {
    constructor(
        private transactionCreator: ITransactionCreator,
        private pathGenerator: IPathGeneratorHelper,
        private templateParser: TemplateParser,
        private jsonGenerator: JsonGenerator
    ) {}

    async createTransaction(context: TransactionHandlerContext): Promise<TransactionHandlerResult> {
        const {
            endpoint,
            environment,
            environmentId, // GitHub Issue #160: Capture environmentId for proper environment lookups during execution
            organization,
            workspaceRoot,
            batchId,
            csvRowData,
            transactionIndex,
            rowStart
        } = context;

        if (!batchId) {
            throw new Error('Batch ID is required for batch member transactions');
        }

        if (!csvRowData || csvRowData.length === 0) {
            throw new Error('CSV row data is required for batch member transactions');
        }

        if (transactionIndex === undefined) {
            throw new Error('Transaction index is required for batch member transactions');
        }

        // For batch members during JIT preparation, workspaceRoot may already be the batch directory
        // Check if workspaceRoot ends with the batchId - if so, use it directly
        const isBatchDirectory = batchId && workspaceRoot.endsWith(batchId);

        let directoryPath: string;
        if (isBatchDirectory) {
            // workspaceRoot is already the batch directory, use it directly
            directoryPath = workspaceRoot;
        } else {
            // Generate directory path: {workspace}/{environmentFolder}/{ENV}/{endpointFolder}/{ENDPOINT}/batch/{batchId}/
            directoryPath = this.pathGenerator.generateDirectoryPath({
                workspaceRoot,
                environment,
                environmentFolder: context.environmentFolder, // Optional from environment config
                endpointName: endpoint.name || 'unknown-endpoint',
                endpointFolder: endpoint.folder, // Optional from endpoint config
                executionType: 'batch_member',
                batchId
            });
        }

        // Generate filename: transaction-001.json, transaction-002.json, etc.
        const fileName = this.pathGenerator.generateFileName({
            executionType: 'batch_member',
            transactionIndex
        });

        // GitHub Issue #119: Use pre-generated JSON if provided (from unified generateBatchJsonFiles())
        // Otherwise fall back to generating from CSV (backward compatibility)
        let jsonPayload: any;
        if (context.preGeneratedJson !== undefined) {
            // Use pre-generated JSON from unified generator
            jsonPayload = context.preGeneratedJson;
        } else {
            // Fall back to generating from CSV data (backward compatibility)
            // GitHub Issue #48: Pass column mappings to JSON generation
            jsonPayload = await this.generateRequestFromCsvData(endpoint, csvRowData, context.columnMappings);
        }

        // Create member execution record with TransactionCreator
        // GitHub Issue #127: Apply BASE64 encoding and save both files
        const jsonString = JSON.stringify(jsonPayload);
        const encodingResult = encodeBase64Fields(jsonString);

        // GitHub Issue #138: Substitute URL path variables from CSV data
        // Extract header and data rows to create parameter mapping
        const [header, ...dataRows] = csvRowData;
        const firstDataRow = dataRows[0] || [];

        // Create parameters map from CSV data using column mappings if available
        const urlParameters: Record<string, string> = {};
        if (context.columnMappings) {
            // Use explicit column mappings
            for (const [templateVariable, csvColumn] of Object.entries(context.columnMappings)) {
                const columnIndex = header.indexOf(csvColumn);
                if (columnIndex >= 0 && columnIndex < firstDataRow.length) {
                    urlParameters[templateVariable] = firstDataRow[columnIndex];
                }
            }
        } else {
            // Fallback: map header names directly to values
            header.forEach((colName, index) => {
                if (index < firstDataRow.length) {
                    urlParameters[colName] = firstDataRow[index];
                }
            });
        }

        // Replace URL path variables with CSV values
        const processedPath = this.replaceVariablesInUrl(endpoint.path, urlParameters);

        const result = await this.transactionCreator.createTransaction({
            endpoint: {
                ...endpoint,
                // GitHub Issue #138: Override path with substituted URL variables
                path: processedPath,
                // Override body with UNENCODED JSON (saved to request-{id}.json for debugging)
                body: jsonString,
                // GitHub Issue #108: Override query params with computed query string if provided
                ...(context.queryParams && { queryParams: context.queryParams })
            },
            environment,
            environmentId, // GitHub Issue #160: Store environmentId for proper environment lookups during execution
            organization,
            directoryPath,
            fileName,
            batchId, // Link to parent batch
            // NEW: Set execution type and initial status
            executionType: 'batch_member',
            status: 'pending', // Batch members are ready to execute immediately
            rowStart, // Starting CSV row index for this transaction
            // GitHub Issue #181: Use explicit rows from context when available (pre-generated JSON path),
            // otherwise calculate from csvRowData (standard path)
            rows: context.rows || String(csvRowData.length - 1),
            // GitHub Issue #127: Pass encoded body for .encoded.json file (only if encoding markers exist)
            encodedBody: encodingResult.hasEncodingMarkers ? encodingResult.encodedJson : undefined
        });

        return {
            executionId: result.executionId,
            requestFilePath: result.requestFilePath,
            jsonPayload,
            directoryPath,
            fileName
        };
    }

    /**
     * Generate request JSON from CSV data using JsonGenerator for array repetition support
     * GitHub Issue #48: Accept column mappings for proper CSV column mapping
     */
    private async generateRequestFromCsvData(
        endpoint: any, 
        csvRowData: string[][],
        columnMappings?: Record<string, string>
    ): Promise<any> {
        if (!endpoint.body) {
            return {}; // No template body
        }

        // Extract header and data rows
        const [header, ...dataRows] = csvRowData;
        
        if (dataRows.length === 0) {
            throw new Error('No data rows provided for template processing');
        }

        try {
            // Check if endpoint has array repetition configuration
            const hasArrayRepetition = endpoint.dataLoadingConfig?.repeatableArrays && 
                endpoint.dataLoadingConfig.repeatableArrays.length > 0 &&
                endpoint.dataLoadingConfig.repeatableArrays.some((arr: any) => arr.enabled);

            if (hasArrayRepetition && dataRows.length > 1) {
                // Use JsonGenerator.generateConsolidatedJson for multi-row array consolidation
                return await this.generateConsolidatedArrayJson(endpoint, header, dataRows, columnMappings);
            } else {
                // Use JsonGenerator.generateSingleRowJson for single-row processing
                return await this.generateSingleRowJson(endpoint, header, dataRows[0], columnMappings);
            }
        } catch (error) {
            throw new Error(`Failed to process template with JsonGenerator: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Generate consolidated JSON for multiple CSV rows (array repetition)
     * GitHub Issue #48: Accept column mappings for proper CSV column mapping
     */
    private async generateConsolidatedArrayJson(
        endpoint: any,
        header: string[],
        dataRows: string[][],
        columnMappings?: Record<string, string>
    ): Promise<any> {
        // Create mappings for JsonGenerator
        // GitHub Issue #48: Use user-provided column mappings if available
        const mappings = columnMappings 
            ? Object.entries(columnMappings).map(([templateVariable, csvColumn]) => ({
                variable: templateVariable,
                column: csvColumn,
                dataType: 'string' // Default to string, JsonGenerator will handle conversions
            }))
            : header.map(columnName => ({
                variable: columnName,
                column: columnName,
                dataType: 'string' // Fallback: map column names to themselves
            }));

        const options = {
            template: endpoint.body,
            mappings,
            headers: header,
            repeatableArrays: endpoint.dataLoadingConfig.repeatableArrays || [],
            endpointId: endpoint.id,
            sequenceStartValue: 1001,
            isBatchExecution: true
        };

        // Convert dataRows to CSV string format that JsonGenerator expects
        const csvRows = dataRows.map(row => row.join(','));
        
        const result = await this.jsonGenerator.generateConsolidatedJson(csvRows, options);

        if (!result.success) {
            throw new Error(`Consolidated JSON generation failed: ${result.error}`);
        }

        return result.jsonData;
    }

    /**
     * Generate JSON for single CSV row
     */
    private async generateSingleRowJson(
        endpoint: any,
        header: string[],
        dataRow: string[],
        columnMappings?: Record<string, string> // GitHub Issue #48: Accept column mappings
    ): Promise<any> {
        // Create mappings for JsonGenerator
        // GitHub Issue #48: Use user-provided column mappings if available
        const mappings = columnMappings 
            ? Object.entries(columnMappings).map(([templateVariable, csvColumn]) => ({
                variable: templateVariable,
                column: csvColumn,
                dataType: 'string' // Default to string, JsonGenerator will handle conversions
            }))
            : header.map(columnName => ({
                variable: columnName,
                column: columnName,
                dataType: 'string' // Fallback: map column names to themselves
            }));

        const options = {
            template: endpoint.body,
            mappings,
            headers: header,
            repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
            endpointId: endpoint.id,
            sequenceStartValue: 1001,
            isBatchExecution: true
        };

        // Convert dataRow to CSV string format
        const csvRowString = dataRow.join(',');
        
        const result = await this.jsonGenerator.generateSingleRowJson(csvRowString, options);

        if (!result.success) {
            throw new Error(`Single row JSON generation failed: ${result.error}`);
        }

        return result.jsonData;
    }

    /**
     * GitHub Issue #138: Replace URL path variables with CSV values
     * Handles {{variableName}} and {{variableName:type}} patterns
     */
    private replaceVariablesInUrl(url: string, parameters: Record<string, any>): string {
        if (!url || !parameters) {
            return url;
        }

        let result = url;

        for (const [key, value] of Object.entries(parameters)) {
            // Replace all occurrences of {{key}} or {{key:type}} with URL encoded values
            const pattern = new RegExp(`\\{\\{${this.escapeRegExp(key)}(?::[^}]+)?\\}\\}`, 'g');
            result = result.replace(pattern, encodeURIComponent(String(value)));
        }

        return result;
    }

    /**
     * Escape special regex characters in a string
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}