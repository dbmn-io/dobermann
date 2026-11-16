// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Copy Service Implementation (GitHub Issue #176)
 *
 * Handles the complete workflow of copying batches between environments:
 * 1. Validation and source batch analysis
 * 2. Generating deterministic batch ID with lineage traceability
 * 3. Reading source CSV and delegating to TransactionPreparationService
 * 4. Updating lineage metadata on the new batch
 * 5. Triggering execution of the new batch
 *
 * Key change: Instead of file-level copying (which created empty DB records),
 * we delegate to prepareBatchTransactions() which regenerates JSON request files
 * with the target environment's {{ENV:...}} variables correctly resolved.
 */

import { IBatchCopyService, BatchCopyOptions, BatchCopyResult, BatchCopyValidation } from './batch-copy.interface';
import { IExecutionMetadataService } from '../execution/execution-metadata.interface';
import { ITransactionPreparationService } from '../transaction-preparation/transaction-preparation.interface';
import { IBatchExecutionEngine } from '../execution/batch-execution-engine.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import * as fs from 'fs';
import { fillBaseUrl } from '../../utils/environment-url';

export class BatchCopyService implements IBatchCopyService {
    constructor(
        private executionMetadataService: IExecutionMetadataService,
        private transactionPreparationService: ITransactionPreparationService,
        private endpointManager: { getEndpoint(id: string): Promise<any | undefined> },
        private environmentManager: { getEnvironment(id: string): Promise<any | undefined> },
        private batchExecutionEngine?: IBatchExecutionEngine,
        private logger?: IExtensionDiagnosticLogger
    ) {}

    async validateCopyOperation(sourceBatchId: string, options: BatchCopyOptions): Promise<BatchCopyValidation> {
        try {
            // Get source batch metadata
            const sourceBatch = await this.executionMetadataService.getExecution(sourceBatchId);

            if (!sourceBatch) {
                return {
                    isValid: false,
                    errorMessage: 'Source batch not found',
                    sourceBatch: null as any
                };
            }

            // Validate batch type
            if (sourceBatch.executionType !== 'batch') {
                return {
                    isValid: false,
                    errorMessage: 'Selected execution is not a batch',
                    sourceBatch: null as any
                };
            }

            // Validate batch status - only allow copying completed batches
            if (!['completed', 'stopped', 'cancelled'].includes(sourceBatch.status)) {
                return {
                    isValid: false,
                    errorMessage: `Cannot copy batch with status "${sourceBatch.status}". Only completed batches can be copied.`,
                    sourceBatch: null as any
                };
            }

            // Block copying reprocessed batches (they don't have their own CSV)
            if (sourceBatch.reprocessedFromBatchId) {
                return {
                    isValid: false,
                    errorMessage: 'Cannot copy a reprocessed batch. Copy the original batch instead.',
                    sourceBatch: null as any
                };
            }

            // Block copying batches that are themselves copies
            if (sourceBatch.copiedFromBatchId) {
                return {
                    isValid: false,
                    errorMessage: 'Cannot copy a batch that is itself a copy. Copy the original batch instead.',
                    sourceBatch: null as any
                };
            }

            // Get batch members for statistics
            const batchMembers = await this.executionMetadataService.getBatchMemberExecutions(sourceBatchId);
            const completedMembers = batchMembers.filter((member: ExecutionMetadata) => member.status === 'completed').length;
            const failedMembers = batchMembers.filter((member: ExecutionMetadata) =>
                ['error', 'cancelled', 'stopped'].includes(member.status)
            ).length;

            // Check if target environment is different from source
            let warningMessage: string | undefined;
            if (options.targetEnvironment === sourceBatch.environment) {
                if (options.targetOrganization === sourceBatch.organization) {
                    warningMessage = 'Target environment and organization are the same as source. This will create a duplicate batch.';
                }
            }

            // Check organization compatibility
            if (sourceBatch.organization && !options.targetOrganization) {
                warningMessage = 'Source batch has an organization but target does not. Organization-specific data may not work correctly.';
            }

            return {
                isValid: true,
                warningMessage,
                sourceBatch: {
                    id: sourceBatch.id,
                    name: this.extractBatchName(sourceBatch.requestFile),
                    environment: sourceBatch.environment,
                    organization: sourceBatch.organization,
                    totalMembers: batchMembers.length,
                    completedMembers,
                    failedMembers,
                    status: sourceBatch.status
                }
            };

        } catch (error) {
            return {
                isValid: false,
                errorMessage: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                sourceBatch: null as any
            };
        }
    }

    async copyBatch(sourceBatchId: string, options: BatchCopyOptions): Promise<BatchCopyResult> {
        // Step 1: Validate the operation
        const validation = await this.validateCopyOperation(sourceBatchId, options);
        if (!validation.isValid) {
            throw new Error(validation.errorMessage || 'Batch copy validation failed');
        }

        // Step 2: Load source batch metadata + members
        const sourceBatch = await this.executionMetadataService.getExecution(sourceBatchId);
        if (!sourceBatch) {
            throw new Error('Source batch not found');
        }

        const sourceBatchMembers = await this.executionMetadataService.getBatchMemberExecutions(sourceBatchId);

        // Step 3: Generate deterministic batch ID
        const newBatchId = await this.generateCopyBatchId(sourceBatchId);
        this.logger?.info(`[BatchCopy] Generated deterministic batch ID: ${newBatchId}`);

        // Step 4: Load endpoint template
        let endpoint = await this.endpointManager.getEndpoint(sourceBatch.endpointId);
        if (!endpoint && sourceBatch.endpointConfig) {
            // Fallback to stored config if endpoint was deleted
            endpoint = sourceBatch.endpointConfig;
            this.logger?.info(`[BatchCopy] Using stored endpointConfig (endpoint may have been deleted)`);
        }
        if (!endpoint) {
            throw new Error(`Endpoint not found: ${sourceBatch.endpointId}. The endpoint may have been deleted and no stored config is available.`);
        }

        // Step 5: Read CSV from source batch requestFile
        if (!sourceBatch.requestFile) {
            throw new Error('Source batch has no CSV file path');
        }

        let csvData: string[][];
        try {
            const csvContent = fs.readFileSync(sourceBatch.requestFile, 'utf-8');
            const lines = csvContent.split('\n').filter((line: string) => line.trim() !== '');
            csvData = lines.map((line: string) => line.split(',').map((cell: string) => cell.trim()));
        } catch (error) {
            throw new Error(`Failed to read source CSV: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // If includeIncomplete=false, filter CSV rows using source members' rowStart/rows
        if (!options.includeIncomplete) {
            const completedMembers = sourceBatchMembers.filter(
                (member: ExecutionMetadata) => member.status === 'completed'
            );

            if (completedMembers.length === 0) {
                throw new Error('No completed batch members to copy');
            }

            // Build set of included CSV row indices from completed members
            const includedRowIndices = new Set<number>();
            for (const member of completedMembers) {
                const rowStart = member.rowStart || 0;
                const rowCount = parseInt(member.rows || '1', 10);
                for (let r = rowStart; r < rowStart + rowCount; r++) {
                    includedRowIndices.add(r);
                }
            }

            // Filter: keep header (index 0) + included data rows
            const header = csvData[0];
            const filteredDataRows = csvData.slice(1).filter((_, index) => includedRowIndices.has(index + 1));

            if (filteredDataRows.length === 0) {
                throw new Error('No CSV rows to copy after filtering incomplete members');
            }

            csvData = [header, ...filteredDataRows];
        }

        const membersExcluded = options.includeIncomplete ? 0 :
            sourceBatchMembers.length - sourceBatchMembers.filter((m: ExecutionMetadata) => m.status === 'completed').length;

        // Step 6: Load target environment and extract variables
        let environmentVariables: Record<string, string> = {};
        let environmentFolder: string | undefined;
        let baseUrlTemplate: string | undefined;
        const targetEnvId = options.targetEnvironmentId;

        if (targetEnvId) {
            const targetEnv = await this.environmentManager.getEnvironment(targetEnvId);
            if (targetEnv) {
                environmentVariables = targetEnv.variables || {};
                environmentFolder = targetEnv.folder;
                baseUrlTemplate = targetEnv.baseUrl;
            }
        }

        // Apply temporary overrides from the copy modal
        if (options.environmentVariableOverrides) {
            environmentVariables = { ...environmentVariables, ...options.environmentVariableOverrides };
        }

        // Step 7: Convert columnMappingUsed array → Record<string,string>
        let columnMappings: Record<string, string> | undefined;
        if (Array.isArray(sourceBatch.columnMappingUsed)) {
            columnMappings = {};
            for (const mapping of sourceBatch.columnMappingUsed) {
                if (mapping.templateVariable && mapping.csvColumn) {
                    columnMappings[mapping.templateVariable] = mapping.csvColumn;
                }
            }
        }

        // Determine workspace root from source batch path
        const path = require('path');
        let workspaceRoot = '';
        if (sourceBatch.requestFile) {
            const sourcePath = path.dirname(sourceBatch.requestFile);
            const pathParts = sourcePath.split(path.sep);
            for (let i = pathParts.length - 1; i >= 0; i--) {
                if (['batch', 'individual'].includes(pathParts[i])) {
                    workspaceRoot = pathParts.slice(0, i).join(path.sep);
                    break;
                }
            }
        }
        if (!workspaceRoot) {
            throw new Error('Could not determine workspace root from source batch path');
        }

        // Step 8: Delegate to preparation pipeline
        try {
            const batchName = this.extractBatchName(sourceBatch.requestFile);

            const prepResult = await this.transactionPreparationService.prepareBatchTransactions({
                endpoint,
                environment: options.targetEnvironment,
                environmentId: options.targetEnvironmentId,
                environmentFolder,
                organization: options.targetOrganization,
                workspaceRoot,
                csvData,
                columnMappings,
                batchConfig: sourceBatch.batchConfiguration ? {
                    stopOnError: sourceBatch.batchConfiguration.stopOnFirstError,
                    parallelProcessing: sourceBatch.batchConfiguration.parallelProcessing,
                    repeatableQueryParam: sourceBatch.batchConfiguration.repeatableQueryParam ? {
                        ...sourceBatch.batchConfiguration.repeatableQueryParam,
                        maxPerRequest: sourceBatch.batchConfiguration.repeatableQueryParam.maxPerRequest ?? undefined
                    } : undefined
                } : undefined,
                batchName: batchName.replace('.csv', ''),
                environmentVariables,
                // #424/#160: the target's base URL with the copy's variables, fixed for the copy
                baseUrl: baseUrlTemplate ? fillBaseUrl(baseUrlTemplate, environmentVariables) : undefined,
                overrideBatchId: newBatchId
            });

            const actualBatchId = prepResult.batchId || newBatchId;

            // Step 9: Update new batch with lineage metadata
            await this.executionMetadataService.updateExecution(actualBatchId, {
                copiedFromBatchId: sourceBatchId,
                copiedFromEnvironment: sourceBatch.environment,
                copiedFromOrganization: sourceBatch.organization,
                copiedAt: new Date(),
                copyGeneration: await this.calculateCopyGeneration(sourceBatchId)
            });

            // Step 10: Fire-and-forget executeBatch
            if (this.batchExecutionEngine) {
                this.batchExecutionEngine.executeBatch(actualBatchId).catch((error: any) => {
                    this.logger?.error(`Failed to auto-execute copied batch ${actualBatchId}:`, error instanceof Error ? error : new Error(String(error)));
                    this.executionMetadataService.updateExecution(actualBatchId, {
                        status: 'error'
                    }).catch((updateError: any) => {
                        this.logger?.error('Failed to update batch status after execution error:', updateError instanceof Error ? updateError : new Error(String(updateError)));
                    });
                });

                this.logger?.info(`[BatchCopy] Auto-executing copied batch: ${actualBatchId}`);
            } else {
                this.logger?.warn(`[BatchCopy] BatchExecutionEngine not available - batch ${actualBatchId} will remain in pending status`);
            }

            // Step 11: Return result
            const csvFileName = this.extractBatchName(sourceBatch.requestFile);
            const newBatchPath = prepResult.filePaths.batchDirectory || prepResult.filePaths.request;

            this.logger?.info(`[BatchCopy] Copy completed: ${sourceBatchId} -> ${actualBatchId}, transactions: ${prepResult.transactionCount}`);

            return {
                newBatchId: actualBatchId,
                membersCopied: prepResult.transactionCount,
                membersExcluded,
                newBatchPath: newBatchPath || '',
                csvFileName
            };

        } catch (error) {
            throw new Error(`Batch copy failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async getBatchLineage(batchId: string): Promise<{
        copiedFrom?: string;
        copiedTo: string[];
        generation: number;
    }> {
        const batch = await this.executionMetadataService.getExecution(batchId);
        if (!batch) {
            throw new Error('Batch not found');
        }

        // Get what this batch was copied from
        const copiedFrom = (batch as any).copiedFromBatchId;

        // Find all batches that were copied from this one
        const allBatchesResult = await this.executionMetadataService.getExecutionTable({
            pageSize: 1000, // Reasonable limit for lineage tracking
            filters: {}
        });

        const copiedTo = allBatchesResult.executions
            .filter((b: ExecutionMetadata) => (b as any).copiedFromBatchId === batchId)
            .map((b: ExecutionMetadata) => b.id);

        // Calculate generation (how many copies deep this is)
        let generation = 1; // Original batch
        if (copiedFrom) {
            try {
                const parentLineage = await this.getBatchLineage(copiedFrom);
                generation = parentLineage.generation + 1;
            } catch {
                generation = 2; // At least a first-generation copy
            }
        }

        return {
            copiedFrom,
            copiedTo,
            generation
        };
    }

    /**
     * Generate deterministic batch ID: {rootId}_v{N}
     * Strips existing _vN suffix and finds the next available version.
     */
    async generateCopyBatchId(sourceBatchId: string): Promise<string> {
        // Strip existing _vN suffix to find the root ID
        const rootId = sourceBatchId.replace(/_v\d+$/, '');

        // Scan existing batches for highest _vN version of this root
        const allBatchesResult = await this.executionMetadataService.getExecutionTable({
            pageSize: 1000,
            filters: {}
        });

        let maxVersion = 1; // The source itself is implicitly v1
        const versionPattern = new RegExp(`^${this.escapeRegex(rootId)}_v(\\d+)$`);

        for (const batch of allBatchesResult.executions) {
            const match = batch.id.match(versionPattern);
            if (match) {
                const version = parseInt(match[1], 10);
                if (version > maxVersion) {
                    maxVersion = version;
                }
            }
        }

        return `${rootId}_v${maxVersion + 1}`;
    }

    /**
     * Calculate the copy generation (1 = original, 2 = first copy, etc.)
     */
    private async calculateCopyGeneration(sourceBatchId: string): Promise<number> {
        try {
            const lineage = await this.getBatchLineage(sourceBatchId);
            return lineage.generation + 1;
        } catch {
            return 2; // At least a first-generation copy
        }
    }

    /**
     * Extract batch name from request file path
     */
    private extractBatchName(requestFile: string | undefined): string {
        if (!requestFile) {
            return 'unknown_batch.csv';
        }

        const path = require('path');
        const fileName = path.basename(requestFile);

        // If it's the generic "input.csv", use a more descriptive name
        if (fileName === 'input.csv' || !fileName.endsWith('.csv')) {
            return 'batch_data.csv';
        }

        return fileName;
    }

    /**
     * Escape special regex characters in a string
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
