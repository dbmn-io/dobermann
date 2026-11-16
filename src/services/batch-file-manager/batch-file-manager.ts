// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { DATA_DIR } from '../workspace/workspace-layout';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ensureDobermannWorkspaceFolder } from '../../utils/workspace-helper';

/**
 * Service for managing batch workspace folders and CSV file copying
 */
export class BatchFileManager {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Create a batch workspace folder and copy the CSV file
     */
    async createBatchWorkspace(batchId: string, originalCsvPath: string, batchName?: string): Promise<{
        batchFolderPath: string;
        csvFileCopyPath: string;
    }> {
        // Get DBMN's folder in the workspace (.dbmn, #344)
        const workspaceUri = await ensureDobermannWorkspaceFolder();
        const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
        
        // Create batch workspace directory structure
        const batchesDir = vscode.Uri.joinPath(dobermannDir, 'batches');
        const batchFolder = vscode.Uri.joinPath(batchesDir, batchId);
        
        // Ensure directories exist
        await vscode.workspace.fs.createDirectory(batchesDir);
        await vscode.workspace.fs.createDirectory(batchFolder);

        // Copy CSV file to batch workspace
        const csvFileName = batchName ? `${this.sanitizeFileName(batchName)}.csv` : 'input.csv';
        const csvFileCopy = vscode.Uri.joinPath(batchFolder, csvFileName);
        
        try {
            // Read original CSV file
            const originalCsvUri = vscode.Uri.file(originalCsvPath);
            const csvContent = await vscode.workspace.fs.readFile(originalCsvUri);
            
            // Write to batch workspace
            await vscode.workspace.fs.writeFile(csvFileCopy, csvContent);
            
            // console.log(`📁 Created batch workspace: ${batchFolder.fsPath}`);
            // console.log(`📄 Copied CSV file: ${originalCsvPath} -> ${csvFileCopy.fsPath}`);
            
            return {
                batchFolderPath: batchFolder.fsPath,
                csvFileCopyPath: csvFileCopy.fsPath
            };
        } catch (error) {
            console.error(`❌ Failed to create batch workspace or copy CSV file:`, error);
            throw new Error(`Failed to create batch workspace: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get the batch workspace folder path
     */
    async getBatchWorkspacePath(batchId: string): Promise<string> {
        const workspaceUri = await ensureDobermannWorkspaceFolder();
        const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
        return path.join(dobermannDir.fsPath, 'batches', batchId);
    }

    /**
     * Get the CSV file copy path in batch workspace
     * Searches for the actual CSV file in the batch directory
     */
    async getBatchCsvPath(batchId: string): Promise<string> {
        const batchWorkspacePath = await this.getBatchWorkspacePath(batchId);
        
        try {
            // List files in batch directory
            const files = await fs.promises.readdir(batchWorkspacePath);
            
            // Find CSV file (should be only one)
            const csvFile = files.find(file => file.endsWith('.csv'));
            
            if (csvFile) {
                return path.join(batchWorkspacePath, csvFile);
            }
            
            // Fallback to default name if no CSV found
            return path.join(batchWorkspacePath, 'input.csv');
        } catch (error) {
            // If directory doesn't exist or error reading, return default path
            return path.join(batchWorkspacePath, 'input.csv');
        }
    }

    /**
     * Check if batch workspace exists
     */
    async batchWorkspaceExists(batchId: string): Promise<boolean> {
        try {
            const batchPath = await this.getBatchWorkspacePath(batchId);
            await fs.promises.access(batchPath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Clean up batch workspace (optional cleanup method)
     */
    async cleanupBatchWorkspace(batchId: string): Promise<void> {
        try {
            const workspaceUri = await ensureDobermannWorkspaceFolder();
            const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
            const batchFolder = vscode.Uri.joinPath(dobermannDir, 'batches', batchId);
            await vscode.workspace.fs.delete(batchFolder, { recursive: true, useTrash: false });
            
            // console.log(`🗑️ Cleaned up batch workspace: ${batchFolder.fsPath}`);
        } catch (error) {
            console.warn(`⚠️ Failed to cleanup batch workspace ${batchId}:`, error);
        }
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