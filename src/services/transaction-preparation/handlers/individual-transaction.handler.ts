// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ITransactionHandler, TransactionHandlerContext, TransactionHandlerResult } from './transaction-handler.interface';
import { ITransactionCreator } from '../../transaction-creator/transaction-creator.interface';
import { IPathGeneratorHelper } from '../helpers/path-generator.helper';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { stripJsonCommentsSafe } from '../../../utils/json-comment-stripper';
import { encodeBase64Fields } from '../../../utils/encoding';

/**
 * Handler for individual "Run API" transactions
 * Creates single execution with timestamp-based naming
 * Uses JsonGenerator for universal JSON generation with A8 support
 */
export class IndividualTransactionHandler implements ITransactionHandler {
    constructor(
        private transactionCreator: ITransactionCreator,
        private pathGenerator: IPathGeneratorHelper,
        private jsonGenerator: JsonGenerator
    ) {}

    async createTransaction(context: TransactionHandlerContext): Promise<TransactionHandlerResult> {
        const { endpoint, environment, organization, workspaceRoot } = context;

        // Generate directory path: {workspace}/{environmentFolder}/{ENV}/{endpointFolder}/{ENDPOINT}/
        const directoryPath = this.pathGenerator.generateDirectoryPath({
            workspaceRoot,
            environment,
            environmentFolder: context.environmentFolder, // Optional from environment config
            endpointName: endpoint.name || 'unknown-endpoint',
            endpointFolder: endpoint.folder, // Optional from endpoint config
            executionType: 'individual'
        });

        // Generate filename: transaction-{timestamp}.json
        const fileName = this.pathGenerator.generateFileName({
            executionType: 'individual',
            timestamp: new Date()
            // No endpointName - individual files don't have endpoint prefix per architecture docs
        });

        // Generate JSON payload using JsonGenerator (supports A8 variables and template processing)
        // GitHub Issue #145: Pass user parameters to use same code path as Run Batch
        const jsonPayload = await this.generateJsonPayload(endpoint, context.userParameters || {});

        // Convert to JSON string and apply BASE64 encoding if needed (Issue #136)
        const jsonString = JSON.stringify(jsonPayload);
        const encodingResult = encodeBase64Fields(jsonString);

        // Create modified endpoint with processed JSON body (use encoded if applicable)
        const processedEndpoint = {
            ...endpoint,
            body: encodingResult.hasEncodingMarkers ? encodingResult.encodedJson : jsonString
        };

        // Use existing TransactionCreator to create execution record and file
        const result = await this.transactionCreator.createTransaction({
            endpoint: processedEndpoint,
            environment,
            organization,
            directoryPath,
            fileName,
            // No batchId for individual transactions
            batchId: undefined,
            // NEW: Set execution type and initial status
            executionType: 'individual',
            status: 'preparing',
            rows: '1',
            // Issue #136: Pass encoded body for BASE64 marker processing
            encodedBody: encodingResult.hasEncodingMarkers ? encodingResult.encodedJson : undefined
        });

        return {
            executionId: result.executionId,
            requestFilePath: result.requestFilePath,
            jsonPayload, // Use our generated JSON payload
            directoryPath,
            fileName
        };
    }

    /**
     * Generate JSON payload using JsonGenerator for full template processing and A8 support
     * GitHub Issue #145: Uses SAME code path as BatchMemberTransactionHandler for unified processing
     *
     * @param endpoint - Endpoint configuration with body template
     * @param userParameters - User-provided parameter values (treated as single CSV row)
     */
    private async generateJsonPayload(
        endpoint: any,
        userParameters: Record<string, any>
    ): Promise<any> {
        if (!endpoint.body) {
            return {}; // No template body
        }

        try {
            // GitHub Issue #145: Convert user parameters to CSV-style format
            // This makes Run API use the EXACT SAME code path as Run Batch
            const header = Object.keys(userParameters);
            const dataRow = Object.values(userParameters).map(v => String(v));

            // Create mappings (SAME as BatchMemberTransactionHandler.generateSingleRowJson)
            const mappings = header.map(columnName => ({
                variable: columnName,
                column: columnName,
                dataType: 'string' // Default to string, JsonGenerator handles type conversion
            }));

            const options = {
                template: endpoint.body,
                mappings,
                headers: header,
                repeatableArrays: endpoint.dataLoadingConfig?.repeatableArrays || [],
                endpointId: endpoint.id,
                sequenceStartValue: 1001,
                // #288: sequences advance on every draw now, so this no longer
                // controls incrementing. It suppresses array repetition, which a
                // single-row execution must not apply.
                isBatchExecution: true
            };

            // Convert user parameters to CSV row string (SAME as BatchMemberTransactionHandler)
            const csvRowString = dataRow.join(',');
            const result = await this.jsonGenerator.generateSingleRowJson(csvRowString, options);

            if (!result.success) {
                throw new Error(`JSON generation failed: ${result.error}`);
            }

            return result.jsonData;
        } catch (error) {
            // Fallback to simple JSON.parse if JsonGenerator fails
            console.warn(`[IndividualTransactionHandler] JsonGenerator failed, falling back to simple JSON.parse:`, error);
            // Strip comments before parsing to support JSONC in templates
            const cleanBody = stripJsonCommentsSafe(endpoint.body);
            return JSON.parse(cleanBody);
        }
    }
}