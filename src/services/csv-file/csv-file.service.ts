// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import * as path from 'path';
import { ICSVFileService } from './csv-file.interface';
import { APIEndpointConfig } from '../../apiConfigManager';
import { ensureDobermannWorkspaceFolder } from '../../utils/workspace-helper';

/**
 * CSV File Service - Backend service for CSV file management
 * Follows Architecture.md patterns for service design and workspace structure
 */
export class CSVFileService implements ICSVFileService {
    
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Create CSV file from data array and save to workspace
     * Uses same workspace structure as createWorkspaceResultFile: {environment}/{endpoint}/batches/{batchId}/input.csv
     */
    async createCSVFile(
        csvData: string[][], 
        endpoint: APIEndpointConfig, 
        environment: string
    ): Promise<{ filePath: string; batchId: string; workspaceDir: string }> {
        
        // console.log('📁 [CSVFileService] Starting CSV file creation process');
        
        // Generate unique batch ID
        const batchId = this.generateBatchId();
        // console.log(`📁 [CSVFileService] Generated batch ID: ${batchId}`);
        
        // Convert CSV data to string format
        const csvContent = this.convertCsvArrayToString(csvData);
        // console.log(`📁 [CSVFileService] CSV content length: ${csvContent.length} characters`);
        
        // Get Dobermann workspace folder
        const workspaceUri = await ensureDobermannWorkspaceFolder();
        // console.log(`📁 [CSVFileService] Workspace folder: ${workspaceUri.fsPath}`);
        
        // Create workspace directory structure: {environment}/{endpoint}/batches/{batchId}/
        const environmentFolder = vscode.Uri.joinPath(workspaceUri, environment);
        const sanitizedEndpointName = this.sanitizeEndpointName(endpoint.name || endpoint.id);
        const endpointFolder = vscode.Uri.joinPath(environmentFolder, sanitizedEndpointName);
        const batchesDir = vscode.Uri.joinPath(endpointFolder, 'batches');
        const batchDir = vscode.Uri.joinPath(batchesDir, batchId);
        
        // console.log(`📁 [CSVFileService] Creating directory structure: ${batchDir.fsPath}`);
        
        // Ensure directories exist
        await vscode.workspace.fs.createDirectory(batchesDir);
        await vscode.workspace.fs.createDirectory(batchDir);
        
        // Save CSV file to batch workspace
        const csvFileName = 'input.csv';
        const csvFilePath = vscode.Uri.joinPath(batchDir, csvFileName);
        
        // console.log(`📁 [CSVFileService] Writing CSV file to: ${csvFilePath.fsPath}`);
        await vscode.workspace.fs.writeFile(csvFilePath, Buffer.from(csvContent, 'utf8'));
        
        // console.log(`📁 [CSVFileService] CSV file created successfully: ${csvFilePath.fsPath} (${csvData.length} rows)`);
        
        return {
            filePath: csvFilePath.fsPath,
            batchId,
            workspaceDir: batchDir.fsPath
        };
    }

    /**
     * Generate unique batch ID for workspace creation
     */
    generateBatchId(): string {
        return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    /**
     * Convert CSV data array to CSV string format with proper escaping
     */
    convertCsvArrayToString(csvData: string[][]): string {
        return csvData.map(row => {
            return row.map(cell => {
                // Escape cells that contain commas, quotes, or newlines
                if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                    // Escape quotes by doubling them and wrap in quotes
                    return `"${cell.replace(/"/g, '""')}"`;
                }
                return cell;
            }).join(',');
        }).join('\n');
    }

    /**
     * Sanitize endpoint name for folder creation (same as Dobermann)
     */
    sanitizeEndpointName(endpoint: string): string {
        if (!endpoint || endpoint.trim() === '') {
            return 'unknown-endpoint';
        }

        const step1 = endpoint.replace(/^\/+/g, ''); // Remove leading slash
        const step2 = step1.replace(/\{[^}]*\}/g, 'id'); // Replace {id} with 'id'
        const step3 = step2.replace(/\?.*$/g, ''); // Remove query parameters
        const step4 = step3.replace(/[^a-zA-Z0-9]/g, '-'); // Replace special chars with dashes
        const step5 = step4.replace(/-+/g, '-'); // Replace multiple dashes with single
        const final = step5.replace(/^-|-$/g, ''); // Remove leading/trailing dashes

        return final;
    }
}