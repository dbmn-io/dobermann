// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IExecutionStorage } from '../services/storage/execution-storage.interface';
import { ExecutionMetadata } from './execution-metadata';
import { ensureDobermannWorkspaceFolder } from '../utils/workspace-helper';

export interface MigrationResult {
    success: boolean;
    migratedCount: number;
    skippedCount: number;
    errorCount: number;
    errors: string[];
}

export class ExecutionMigrationManager {
    private context: vscode.ExtensionContext;
    private executionMetadataManager: IExecutionStorage;

    constructor(context: vscode.ExtensionContext, executionMetadataManager: IExecutionStorage) {
        this.context = context;
        this.executionMetadataManager = executionMetadataManager;
    }

    async migrateWorkspaceExecutionFiles(): Promise<MigrationResult> {
        const result: MigrationResult = {
            success: true,
            migratedCount: 0,
            skippedCount: 0,
            errorCount: 0,
            errors: []
        };

        try {
            // Get Dobermann workspace
            const workspaceUri = await ensureDobermannWorkspaceFolder();
            console.log('🔄 Starting migration of workspace execution files...');

            // Find all JSON files in the workspace that might be execution results
            const jsonFiles = await this.findExecutionFiles(workspaceUri);
            console.log(`📁 Found ${jsonFiles.length} potential execution files`);

            // Process each file
            for (const filePath of jsonFiles) {
                try {
                    const migrationFileResult = await this.migrateExecutionFile(filePath);
                    if (migrationFileResult.success) {
                        result.migratedCount++;
                    } else {
                        result.skippedCount++;
                        if (migrationFileResult.error) {
                            result.errors.push(`${filePath}: ${migrationFileResult.error}`);
                        }
                    }
                } catch (error) {
                    result.errorCount++;
                    result.errors.push(`${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    console.error(`❌ Error migrating file ${filePath}:`, error);
                }
            }

            console.log(`✅ Migration completed: ${result.migratedCount} migrated, ${result.skippedCount} skipped, ${result.errorCount} errors`);
        } catch (error) {
            result.success = false;
            result.errors.push(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('❌ Migration failed:', error);
        }

        return result;
    }

    private async findExecutionFiles(workspaceUri: vscode.Uri): Promise<string[]> {
        const jsonFiles: string[] = [];
        
        try {
            // Look for files in environment folders that follow the pattern:
            // {environment}/{endpointFolder?}/{endpointName}/results/{method}-{name}-{timestamp}.json
            const entries = await vscode.workspace.fs.readDirectory(workspaceUri);
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory) {
                    // This might be an environment folder
                    const envPath = vscode.Uri.joinPath(workspaceUri, name);
                    const envFiles = await this.findExecutionFilesInDirectory(envPath, name);
                    jsonFiles.push(...envFiles);
                }
            }
        } catch (error) {
            console.warn('Warning: Could not read workspace directory:', error);
        }

        return jsonFiles;
    }

    private async findExecutionFilesInDirectory(dirUri: vscode.Uri, environment: string): Promise<string[]> {
        const jsonFiles: string[] = [];
        
        try {
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory) {
                    const subDirUri = vscode.Uri.joinPath(dirUri, name);
                    
                    // Check if this directory contains a "results" folder
                    try {
                        const subEntries = await vscode.workspace.fs.readDirectory(subDirUri);
                        for (const [subName, subType] of subEntries) {
                            if (subType === vscode.FileType.Directory && subName === 'results') {
                                const resultsUri = vscode.Uri.joinPath(subDirUri, 'results');
                                const resultFiles = await this.findJsonFilesInResults(resultsUri);
                                jsonFiles.push(...resultFiles);
                            } else if (subType === vscode.FileType.Directory) {
                                // Recursively search subdirectories
                                const deepFiles = await this.findExecutionFilesInDirectory(subDirUri, environment);
                                jsonFiles.push(...deepFiles);
                            }
                        }
                    } catch (error) {
                        // Skip directories we can't read
                    }
                }
            }
        } catch (error) {
            console.warn(`Warning: Could not read directory ${dirUri.fsPath}:`, error);
        }

        return jsonFiles;
    }

    private async findJsonFilesInResults(resultsUri: vscode.Uri): Promise<string[]> {
        const jsonFiles: string[] = [];
        
        try {
            const entries = await vscode.workspace.fs.readDirectory(resultsUri);
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    // Check if this looks like an execution result file
                    // Pattern: {method}-{name}-{timestamp}.json
                    if (this.isExecutionResultFile(name)) {
                        jsonFiles.push(vscode.Uri.joinPath(resultsUri, name).fsPath);
                    }
                }
            }
        } catch (error) {
            console.warn(`Warning: Could not read results directory ${resultsUri.fsPath}:`, error);
        }

        return jsonFiles;
    }

    private isExecutionResultFile(filename: string): boolean {
        // Check if filename matches pattern: {method}-{name}-{timestamp}.json
        const pattern = /^(GET|POST|PUT|DELETE|PATCH)-.*-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/;
        return pattern.test(filename);
    }

    private async migrateExecutionFile(filePath: string): Promise<{success: boolean, error?: string}> {
        try {
            // Read the file
            const fileContent = await fs.promises.readFile(filePath, 'utf8');
            const data = JSON.parse(fileContent);

            // Check if file has _meta section (our format)
            if (!data._meta) {
                return { success: false, error: 'No _meta section found - not an execution result file' };
            }

            const meta = data._meta;
            
            // Check if this execution already exists in database
            const existingExecution = await this.findExistingExecution(meta);
            if (existingExecution) {
                return { success: false, error: 'Execution already exists in database' };
            }

            // Extract metadata from file
            const metadata: Omit<ExecutionMetadata, 'id'> = {
                executionType: meta.batchId ? 'batch_member' as const : 'individual' as const, // Required field
                rows: '1', // Required field with default
                environment: meta.environment || 'default',
                organization: meta.organization,
                endpointId: meta.endpointId || 'unknown',
                endpointName: meta.endpointName || this.extractEndpointNameFromPath(filePath),
                endpointMethod: meta.method || 'POST',
                endpointPath: meta.endpoint || '/api/endpoint',
                batchId: meta.batchId,
                status: this.mapStatusFromMeta(meta),
                runTime: this.parseDurationFromMeta(meta.duration),
                createdAt: this.parseTimestampFromMeta(meta.timestamp),
                startedAt: this.parseTimestampFromMeta(meta.timestamp), // Assume same as created for legacy data
                completedAt: this.parseTimestampFromMeta(meta.timestamp), // Assume same as created for legacy data
                requestFile: undefined, // We don't have request files in old format
                responseFile: filePath,
                errorMessage: meta.error,
                httpStatus: meta.status || this.extractHttpStatusFromData(data),
                httpStatusText: meta.statusText || this.extractHttpStatusTextFromData(data)
            };

            // Create execution record
            const executionId = await this.executionMetadataManager.createExecution(metadata);
            
            console.log(`📊 Migrated execution file: ${filePath} -> ${executionId}`);
            return { success: true };

        } catch (error) {
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error parsing file' 
            };
        }
    }

    private async findExistingExecution(meta: any): Promise<boolean> {
        // Try to find existing execution by timestamp and environment
        if (meta.timestamp && meta.environment) {
            try {
                const executions = await this.executionMetadataManager.getExecutions({
                    environment: meta.environment,
                    startDate: new Date(meta.timestamp),
                    endDate: new Date(new Date(meta.timestamp).getTime() + 1000) // 1 second window
                });
                return executions.length > 0;
            } catch (error) {
                // If we can't check, assume it doesn't exist
                return false;
            }
        }
        return false;
    }

    private extractEndpointNameFromPath(filePath: string): string {
        // Extract endpoint name from file path structure
        // Path: {environment}/{endpointFolder?}/{endpointName}/results/{file}
        const pathParts = filePath.split(path.sep);
        const resultsIndex = pathParts.findIndex(part => part === 'results');
        if (resultsIndex > 0) {
            return pathParts[resultsIndex - 1];
        }
        return 'unknown-endpoint';
    }

    private mapStatusFromMeta(meta: any): 'pending' | 'running' | 'completed' | 'cancelled' | 'error' {
        if (meta.error) {
            return 'error';
        }
        if (meta.status && meta.status >= 200 && meta.status < 300) {
            return 'completed';
        }
        if (meta.status && meta.status >= 400) {
            return 'error';
        }
        return 'completed'; // Default for legacy data
    }

    private parseDurationFromMeta(duration: any): number | undefined {
        if (typeof duration === 'number') {
            return duration;
        }
        if (typeof duration === 'string') {
            // Parse duration string like "1234ms" or "1.234s"
            const match = duration.match(/(\d+(?:\.\d+)?)(ms|s)/);
            if (match) {
                const value = parseFloat(match[1]);
                const unit = match[2];
                return unit === 's' ? value * 1000 : value;
            }
        }
        return undefined;
    }

    private parseTimestampFromMeta(timestamp: any): Date {
        if (timestamp) {
            const date = new Date(timestamp);
            if (!isNaN(date.getTime())) {
                return date;
            }
        }
        // Default to current time if timestamp is invalid
        return new Date();
    }

    private extractHttpStatusFromData(data: any): number | undefined {
        // Try to extract HTTP status from various places in the data
        if (data._meta && data._meta.status) {
            return data._meta.status;
        }
        if (data.status) {
            return data.status;
        }
        if (data.response && data.response.status) {
            return data.response.status;
        }
        return undefined;
    }

    private extractHttpStatusTextFromData(data: any): string | undefined {
        // Try to extract HTTP status text from various places in the data
        if (data._meta && data._meta.statusText) {
            return data._meta.statusText;
        }
        if (data.statusText) {
            return data.statusText;
        }
        if (data.response && data.response.statusText) {
            return data.response.statusText;
        }
        return undefined;
    }

    async clearAllExecutionMetadata(): Promise<void> {
        // This is a utility method for testing/development
        // In production, you might want to add more safeguards
        console.log('🗑️ Clearing all execution metadata...');
        const executions = await this.executionMetadataManager.getExecutions();
        
        for (const execution of executions) {
            await this.executionMetadataManager.deleteExecution(execution.id);
        }
        
        console.log(`✅ Cleared ${executions.length} execution records`);
    }
}