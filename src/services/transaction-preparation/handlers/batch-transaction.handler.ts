// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ITransactionHandler, TransactionHandlerContext, TransactionHandlerResult } from './transaction-handler.interface';
import { ITransactionCreator } from '../../transaction-creator/transaction-creator.interface';
import { IPathGeneratorHelper } from '../helpers/path-generator.helper';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Handler for batch parent transactions
 * Creates batch directory, saves CSV file, and creates batch execution record
 */
export class BatchTransactionHandler implements ITransactionHandler {
    constructor(
        private transactionCreator: ITransactionCreator,
        private pathGenerator: IPathGeneratorHelper
    ) {}

    async createTransaction(context: TransactionHandlerContext): Promise<TransactionHandlerResult> {
        const { endpoint, environment, environmentId, organization, workspaceRoot, csvRowData } = context;

        if (!csvRowData || csvRowData.length === 0) {
            throw new Error('CSV row data is required for batch transactions');
        }

        // ARCHITECTURE COMPLIANCE: Create execution record FIRST, then use executionId as batchId
        // This aligns with the architecture document: lines 137-142
        
        // Step 1: Create a temporary directory to get the structure, then create execution record
        // Generate a temporary batchId for initial directory/file creation
        const tempBatchId = `temp_${Date.now()}`;
        
        // Generate directory path structure using temporary ID
        const directoryPath = this.pathGenerator.generateDirectoryPath({
            workspaceRoot,
            environment,
            environmentFolder: context.environmentFolder, // Optional from environment config
            endpointName: endpoint.name || 'unknown-endpoint',
            endpointFolder: endpoint.folder, // Optional from endpoint config
            executionType: 'batch',
            batchId: tempBatchId
        });

        // Create batch directory
        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }

        // Save CSV file with custom name if provided, otherwise use input.csv
        const csvFileName = context.batchName ? `${this.sanitizeFileName(context.batchName)}.csv` : 'input.csv';
        // Use direct path joining instead of generateFullPath to preserve custom filename
        const csvFilePath = path.join(directoryPath, csvFileName);

        // Convert CSV data to CSV string and save
        const csvContent = this.convertArrayToCsv(csvRowData);
        fs.writeFileSync(csvFilePath, csvContent);

        // Step 2: Create batch execution record with TransactionCreator
        // Initialize JIT preparation cursor (GitHub Issue #94)
        const maxParallel = context.batchConfig?.parallelProcessing?.maxConcurrency || 1;
        const chunkSize = maxParallel * 2;

        const result = await this.transactionCreator.createTransaction({
            endpoint,
            environment,
            environmentId,
            organization,
            directoryPath,
            fileName: csvFileName,
            batchId: '', // Leave empty, will be set to executionId
            executionType: 'batch',
            status: 'pending', // GitHub Issue #94: Batches start as PENDING (no PREPARING state)
            rows: String(csvRowData.length - 1), // Exclude header row, convert to string
            // GitHub Issue #78: batch configuration including parallel processing; #445: and the batch's name
            batchConfig: context.batchName ? { ...context.batchConfig, name: context.batchName } : context.batchConfig,
            overrideBatchId: context.overrideBatchId, // GitHub Issue #176: Deterministic batch copy ID
            preparationState: {
                totalRows: csvRowData.length - 1,  // Exclude header row
                totalTransactions: 0,              // Will be updated after array repetition analysis
                preparedTransactions: 0,           // No transactions created yet
                nextCsvRowIndex: 0,                // Start from first data row (after header)
                chunkSize: chunkSize,              // Based on parallel config (maxParallel × 2)
                isComplete: false                  // Preparation not started yet
            }
        });

        // Step 3: Use executionId as batchId and rename directory to match
        const batchId = result.executionId;

        // Rename directory from temp name to actual executionId
        const finalDirectoryPath = directoryPath.replace(tempBatchId, batchId);
        if (directoryPath !== finalDirectoryPath) {
            fs.renameSync(directoryPath, finalDirectoryPath);
        }
        
        // Update file path to reflect new directory
        const finalCsvFilePath = path.join(finalDirectoryPath, csvFileName);

        return {
            executionId: result.executionId,
            requestFilePath: finalCsvFilePath, // CSV file path with correct batchId
            jsonPayload: {
                batchId, // Now equals executionId
                csvRowCount: csvRowData.length - 1, // Exclude header
                csvFile: csvFileName,
                endpoint: {
                    name: endpoint.name,
                    method: endpoint.method,
                    path: endpoint.path
                }
            },
            directoryPath: finalDirectoryPath,
            fileName: csvFileName
        };
    }


    /**
     * Convert 2D array to CSV string
     */
    private convertArrayToCsv(data: string[][]): string {
        return data.map(row => 
            row.map(cell => {
                // Escape cells containing commas, quotes, or newlines
                if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                    return `"${cell.replace(/"/g, '""')}"`;
                }
                return cell;
            }).join(',')
        ).join('\n');
    }

    /**
     * Sanitize filename to be safe for file system
     */
    private sanitizeFileName(name: string): string {
        if (!name || typeof name !== 'string') return 'batch';
        // Remove file system unsafe characters and replace with underscore
        return name.replace(/[/\\:*?"<>|]/g, '_')
                   .replace(/\s+/g, '_')
                   .trim()
                   .substring(0, 100) || 'batch';
    }
}