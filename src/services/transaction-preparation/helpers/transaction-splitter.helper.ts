// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Transaction Splitter Helper for GitHub Issue #74
 *
 * Handles splitting array transactions into individual single-element transactions
 * for error isolation and debugging purposes.
 */

import { readRunFile, writeRunFile } from '../../run-content/run-content-store';
import * as path from 'path';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { ITransactionCreator } from '../../transaction-creator/transaction-creator.interface';
import { IExecutionMetadataService } from '../../execution/execution-metadata.interface';
import { IExtensionDiagnosticLogger } from '../../logging/extension-diagnostic-logger.interface';
import { IExecutionLoggingService } from '../../logging/execution-logging.interface';

export interface SplitTransactionResult {
    /** IDs of the newly created split transactions */
    splitTransactionIds: string[];
    /** Number of array elements that were split */
    elementsCount: number;
    /** Path to the original transaction file */
    originalFilePath: string;
}

export interface ITransactionSplitter {
    /**
     * Split an array transaction into individual single-element transactions
     * @param originalMemberId - ID of the original failed transaction
     * @param batchId - Batch ID containing the transaction
     * @returns Split result with new transaction IDs
     */
    splitArrayTransaction(originalMemberId: string, batchId: string): Promise<SplitTransactionResult>;

    /**
     * Check if a transaction can be split (contains array data)
     * @param member - The execution metadata to check
     * @returns True if transaction contains splittable array data
     */
    canSplitTransaction(member: ExecutionMetadata): Promise<boolean>;
}

/**
 * Dependencies for TransactionSplitter
 */
export interface TransactionSplitterDependencies {
    transactionCreator: ITransactionCreator;
    executionMetadataService: IExecutionMetadataService;
    executionLoggingService?: IExecutionLoggingService; // Optional for logging to split transaction files
}

/**
 * Issue #304: the input row a split child sent. Only when the parent sent one
 * input row per array element (a flat template); a nested template builds an
 * element from several rows, and no single row can be claimed.
 */
export function splitChildRowStart(parent: ExecutionMetadata, arrayIndex: number, arraySize: number): number | undefined {
    const start = parent.rowStart;
    const rows = parseInt(String(parent.rows ?? ''), 10);
    if (typeof start !== 'number' || rows !== arraySize) {
        return undefined;
    }
    return start + arrayIndex;
}

export class TransactionSplitter implements ITransactionSplitter {
    constructor(
        private dependencies: TransactionSplitterDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {}

    async splitArrayTransaction(originalMemberId: string, batchId: string): Promise<SplitTransactionResult> {
        this.logger.info(`[TransactionSplitter] Starting split for transaction ${originalMemberId}`, undefined, { originalMemberId, batchId });

        // Get original transaction metadata
        const originalMember = await this.dependencies.executionMetadataService.getExecution(originalMemberId);
        if (!originalMember) {
            throw new Error(`Original transaction ${originalMemberId} not found`);
        }

        // Validate it's a batch member
        if (originalMember.executionType !== 'batch_member') {
            throw new Error(`Transaction ${originalMemberId} is not a batch member`);
        }

        // Check if it can be split
        const canSplit = await this.canSplitTransaction(originalMember);
        if (!canSplit) {
            throw new Error(`Transaction ${originalMemberId} cannot be split - no array data found`);
        }

        // Read the original request file to get the array data and detect format
        const { arrayData, wrapperKey } = await this.readArrayDataWithFormat(originalMember.requestFile);
        if (!arrayData || arrayData.length <= 1) {
            throw new Error(`Transaction ${originalMemberId} does not contain multiple array elements to split`);
        }

        this.logger.info(`[TransactionSplitter] Found ${arrayData.length} array elements to split (format: ${wrapperKey ?? 'root array'})`, undefined, {
            originalMemberId,
            elementsCount: arrayData.length,
            wrapperKey
        });

        // Create individual transactions for each array element
        const splitTransactionIds: string[] = [];
        const originalRequestDir = path.dirname(originalMember.requestFile || '');

        for (let i = 0; i < arrayData.length; i++) {
            const elementData = arrayData[i];
            const splitId = await this.createSplitTransaction(
                originalMember,
                batchId,
                [elementData], // Single element array
                i,
                arrayData.length,
                originalRequestDir,
                wrapperKey
            );
            splitTransactionIds.push(splitId);
        }

        // Mark original transaction as split
        await this.markOriginalAsSplit(originalMemberId, splitTransactionIds.length);

        this.logger.info(`[TransactionSplitter] Split completed: created ${splitTransactionIds.length} individual transactions`, undefined, {
            originalMemberId,
            splitTransactionIds,
            elementsCount: arrayData.length
        });

        return {
            splitTransactionIds,
            elementsCount: arrayData.length,
            originalFilePath: originalMember.requestFile || ''
        };
    }

    async canSplitTransaction(member: ExecutionMetadata): Promise<boolean> {
        // Must be a batch member with a request file
        if (member.executionType !== 'batch_member' || !member.requestFile) {
            return false;
        }

        // Check if already split
        if (member.isSplitTransaction) {
            return false; // Don't split already split transactions
        }

        try {
            // Try to read array data from request file
            const arrayData = await this.readArrayDataFromRequestFile(member.requestFile);
            return arrayData !== null && arrayData.length > 1;
        } catch (error) {
            this.logger.warn(`[TransactionSplitter] Failed to check if transaction can be split`, error instanceof Error ? error : undefined, {
                memberId: member.id,
                requestFile: member.requestFile
            });
            return false;
        }
    }

    /**
     * Read array data from the request file (used by canSplitTransaction)
     */
    private async readArrayDataFromRequestFile(requestFile: string | undefined): Promise<any[] | null> {
        const result = await this.readArrayDataWithFormat(requestFile);
        return result.arrayData;
    }

    /**
     * Read array data from the request file and detect the wrapper format.
     * Returns { arrayData, wrapperKey } where wrapperKey is null for root arrays
     * or the key name (e.g. 'Data') for wrapped objects.
     */
    private async readArrayDataWithFormat(requestFile: string | undefined): Promise<{ arrayData: any[] | null; wrapperKey: string | null }> {
        if (!requestFile) {
            return { arrayData: null, wrapperKey: null };
        }

        try {
            const fileContent = readRunFile(requestFile);
            const jsonContent = JSON.parse(fileContent);

            // Root-level array: [...]
            if (Array.isArray(jsonContent)) {
                return { arrayData: jsonContent, wrapperKey: null };
            }

            // Look for Data array (from the GitHub issue example)
            if (jsonContent.Data && Array.isArray(jsonContent.Data)) {
                return { arrayData: jsonContent.Data, wrapperKey: 'Data' };
            }

            // Also check for other common array field names
            const arrayFields = ['data', 'items', 'records', 'transactions'];
            for (const field of arrayFields) {
                if (jsonContent[field] && Array.isArray(jsonContent[field])) {
                    return { arrayData: jsonContent[field], wrapperKey: field };
                }
            }

            return { arrayData: null, wrapperKey: null };
        } catch (error) {
            this.logger.warn(`[TransactionSplitter] Failed to read array data from request file`, error instanceof Error ? error : undefined, {
                requestFile
            });
            return { arrayData: null, wrapperKey: null };
        }
    }

    /**
     * Create a single split transaction from an array element
     */
    private async createSplitTransaction(
        originalMember: ExecutionMetadata,
        batchId: string,
        singleElementArray: any[],
        arrayIndex: number,
        originalArraySize: number,
        originalRequestDir: string,
        wrapperKey: string | null
    ): Promise<string> {
        // Generate split transaction ID
        const splitId = globalThis.crypto.randomUUID();

        // Extract original filename without extension for consistent naming
        const originalFileName = path.basename(originalMember.requestFile || 'transaction', '.json');

        // Create split filename with padded index for proper sorting
        const splitIndex = String(arrayIndex + 1).padStart(3, '0');
        const splitFileName = `${originalFileName}-${splitIndex}.json`;

        // Store in same directory as original transaction (no subdirectory)
        const splitRequestPath = path.join(originalRequestDir, splitFileName);

        // Create JSON payload preserving original format
        // wrapperKey=null means root array [...], otherwise wrap in { [key]: [...] }
        const splitPayload = wrapperKey
            ? { [wrapperKey]: singleElementArray }
            : singleElementArray;

        // Write split request file
        const splitContent = JSON.stringify(splitPayload, null, 2);
        writeRunFile(splitRequestPath, splitContent);

        // Create split transaction metadata
        const splitMetadata: Omit<ExecutionMetadata, 'id'> = {
            environment: originalMember.environment,
            environmentId: originalMember.environmentId,
            organization: originalMember.organization,
            endpointId: originalMember.endpointId,
            endpointName: originalMember.endpointName,
            endpointMethod: originalMember.endpointMethod,
            endpointPath: originalMember.endpointPath,
            batchId: batchId,
            executionType: 'batch_member',
            status: 'pending', // Ready for execution
            rows: '1', // Single element
            // Issue #304: which input row this element came from, so the Input
            // tab's Result and the Raw card's input rows follow the child.
            rowStart: splitChildRowStart(originalMember, arrayIndex, originalArraySize),
            createdAt: new Date(),
            requestFile: splitRequestPath,
            requestHeaders: originalMember.requestHeaders,
            requestQueryParams: originalMember.requestQueryParams,
            endpointConfig: originalMember.endpointConfig,
            columnMappingUsed: originalMember.columnMappingUsed,

            // Split tracking
            splitFromMemberId: originalMember.id,
            isSplitTransaction: true,
            splitReason: `Array transaction split for error isolation (element ${arrayIndex + 1} of ${originalArraySize})`,
            arrayIndex: arrayIndex,
            originalArraySize: originalArraySize
        };

        // Store split transaction
        const result = await this.dependencies.executionMetadataService.storeBatchExecution({
            ...splitMetadata,
            id: splitId
        });

        if (!result.success) {
            throw new Error(`Failed to create split transaction: ${result.errorMessage}`);
        }

        // Create log file for the split child (same pattern as transaction-creator)
        if (this.dependencies.executionLoggingService && splitRequestPath) {
            try {
                const logPath = await this.dependencies.executionLoggingService.createLogFile(splitId, splitRequestPath);
                await this.dependencies.executionMetadataService.updateExecution(splitId, { logPath });
            } catch (error) {
                this.logger.warn(`[TransactionSplitter] Failed to create log file for split ${splitId}`, error instanceof Error ? error : undefined);
            }
        }

        // Log split details to the ORIGINAL transaction's log file for consolidated view
        await this.logSplitDetails(originalMember.id, {
            splitTransactionId: splitId,
            arrayIndex: arrayIndex,
            totalArraySize: originalArraySize,
            splitRequestFile: splitRequestPath,
            splitFileName: splitFileName,
            arrayElement: singleElementArray[0]
        });

        return splitId;
    }

    /**
     * Mark the original transaction as split and update its status
     */
    private async markOriginalAsSplit(originalMemberId: string, splitCount: number): Promise<void> {
        await this.dependencies.executionMetadataService.updateExecution(originalMemberId, {
            status: 'split', // Custom status for split transactions
            splitReason: `Split into ${splitCount} individual transactions for error isolation`,
            completedAt: new Date(),
            errorMessage: undefined // Clear any error message since we're investigating via splits
        });
    }

    /**
     * Log split transaction details to the original transaction's log file
     * GitHub Issue #74: All split-related logging should go to the original transaction's log
     */
    private async logSplitDetails(originalMemberId: string, splitDetails: {
        splitTransactionId: string;
        arrayIndex: number;
        totalArraySize: number;
        splitRequestFile: string;
        splitFileName: string;
        arrayElement: any;
    }): Promise<void> {
        // Only log if we have the execution logging service
        if (!this.dependencies.executionLoggingService) {
            return;
        }

        try {
            await this.dependencies.executionLoggingService.logExecutionEvent(originalMemberId, {
                timestamp: new Date().toISOString(),
                level: 'info',
                phase: 'preparation',
                event: 'transaction_split_created',
                data: {
                    originalTransactionId: originalMemberId,
                    splitTransactionId: splitDetails.splitTransactionId,
                    splitFileName: splitDetails.splitFileName,
                    splitRequestFile: splitDetails.splitRequestFile,
                    arrayIndex: splitDetails.arrayIndex + 1, // 1-based for display
                    totalArraySize: splitDetails.totalArraySize,
                    arrayElement: splitDetails.arrayElement,
                    splitReason: `Array transaction split for error isolation (element ${splitDetails.arrayIndex + 1} of ${splitDetails.totalArraySize})`
                }
            });
        } catch (error) {
            this.logger.warn(`[TransactionSplitter] Failed to log split details for ${originalMemberId}`, error instanceof Error ? error : undefined, {
                originalMemberId,
                splitTransactionId: splitDetails.splitTransactionId
            });
        }
    }
}