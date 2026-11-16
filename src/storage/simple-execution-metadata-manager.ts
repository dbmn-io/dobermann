// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { DATA_DIR } from '../services/workspace/workspace-layout';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    ExecutionMetadata,
    ExecutionFilters,
    TableOptions,
    ExecutionTableResult,
    ExecutionStats,
    validateExecutionMetadata,
    BatchConfiguration
} from './execution-metadata';
import { APIEndpointConfig } from '../apiConfigManager';
import { ExecutionStatus } from '../types/unified-execution-status';
import { ensureDobermannWorkspaceFolder } from '../utils/workspace-helper';

// Enhanced database structure with unified model
interface ExecutionDatabase {
    executions: ExecutionMetadata[];
    version: number;
}

/**
 * @deprecated This class is deprecated. Use DatabaseAdapter instead.
 *
 * SimpleExecutionMetadataManager uses JSON file storage which has been replaced
 * by database storage for better performance and reliability (GitHub Issue #102).
 *
 * Active implementation: DatabaseAdapter wrapping SqlJsExecutionStorage
 */
export class SimpleExecutionMetadataManager {
    private context: vscode.ExtensionContext;
    private dbPath: string | null = null;
    private executions: ExecutionMetadata[] = [];
    // Removed separate batches array - now using unified executions array
    private readonly DB_VERSION = 3; // Incremented for request headers/queryParams support
    private _onExecutionChanged: vscode.EventEmitter<ExecutionMetadata> = new vscode.EventEmitter<ExecutionMetadata>();
    public readonly onExecutionChanged: vscode.Event<ExecutionMetadata> = this._onExecutionChanged.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async initialize(): Promise<void> {
        try {
            // Ensure DBMN's folder in the workspace (.dbmn, #344) exists
            const workspaceUri = await ensureDobermannWorkspaceFolder();
            const dobermannDir = vscode.Uri.joinPath(workspaceUri, DATA_DIR);
            await vscode.workspace.fs.createDirectory(dobermannDir);

            // Create database file path in the workspace's .dbmn folder
            this.dbPath = path.join(dobermannDir.fsPath, 'executions.json');

            // Load existing data
            await this.loadDatabase();

            // Run one-time data cleanup to remove corrupted batch execution records
            // Removed cleanupCorruptedBatchExecutions - was incorrectly removing valid batch records

            // Run one-time migration to add executionType fields
            await this.migrateToExecutionTypes();

        } catch (error) {
            console.error('❌ Failed to initialize execution metadata storage:', error);
            throw error;
        }
    }

    private async loadDatabase(): Promise<void> {
        if (!this.dbPath) {
            return;
        }

        try {
            const fileContent = await fs.promises.readFile(this.dbPath, 'utf8');
            const data: ExecutionDatabase = JSON.parse(fileContent);


            // Validate and load executions
            this.executions = data.executions.map(exec => {
                // Convert date strings back to Date objects
                return {
                    ...exec,
                    createdAt: new Date(exec.createdAt),
                    startedAt: exec.startedAt ? new Date(exec.startedAt) : undefined,
                    completedAt: exec.completedAt ? new Date(exec.completedAt) : undefined
                };
            });


            // Batch metadata is now unified with ExecutionMetadata - no separate loading needed

        } catch (error) {
            // File doesn't exist or is corrupted, start with empty database
            this.executions = [];
            // No separate batches array needed - using unified executions array
        }
    }

    private async saveDatabase(): Promise<void> {
        if (!this.dbPath) {
            return;
        }

        try {
            const data: ExecutionDatabase = {
                executions: this.executions,
                version: this.DB_VERSION
            };

            const batchCount = this.executions.filter(exec => exec.executionType === 'batch').length;

            const jsonString = JSON.stringify(data, null, 2);
            await fs.promises.writeFile(this.dbPath, jsonString);


        } catch (error) {
            console.error('Failed to save execution database:', error);
            throw error;
        }
    }

    async createExecution(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string> {
        const id = this.generateExecutionId();
        const fullMetadata: ExecutionMetadata = {
            id,
            ...metadata
        };

        // Validate the metadata
        const validatedMetadata = validateExecutionMetadata(fullMetadata);

        // Add to executions array
        this.executions.push(validatedMetadata);

        // Save to file
        await this.saveDatabase();

        this._onExecutionChanged.fire(validatedMetadata);

        return id;
    }

    async updateExecution(id: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        const index = this.executions.findIndex(exec => exec.id === id);
        if (index === -1) {
            throw new Error(`Execution with ID "${id}" not found`);
        }

        // Merge updates with current data
        const updatedMetadata = { ...this.executions[index], ...updates };

        // Validate the updated metadata
        const validatedMetadata = validateExecutionMetadata(updatedMetadata);

        // Update in array
        this.executions[index] = validatedMetadata;

        // Save to file
        await this.saveDatabase();

        this._onExecutionChanged.fire(validatedMetadata);
    }

    async bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void> {
        if (updates.length === 0) {
            return;
        }

        let updatedCount = 0;
        const updatedExecutions: ExecutionMetadata[] = [];

        // Apply all updates in memory first
        for (const { id, updates: executionUpdates } of updates) {
            const index = this.executions.findIndex(exec => exec.id === id);
            if (index === -1) {
                console.warn(`Execution with ID "${id}" not found during bulk update`);
                continue;
            }

            // Merge updates with current data
            const updatedMetadata = { ...this.executions[index], ...executionUpdates };

            // Validate the updated metadata
            const validatedMetadata = validateExecutionMetadata(updatedMetadata);

            // Update in array
            this.executions[index] = validatedMetadata;
            updatedExecutions.push(validatedMetadata);
            updatedCount++;
        }

        // Save to file only once after all updates
        if (updatedCount > 0) {
            await this.saveDatabase();

            // Fire change events for all updated executions
            for (const execution of updatedExecutions) {
                this._onExecutionChanged.fire(execution);
            }
        }
    }

    async deleteExecution(id: string): Promise<void> {
        const index = this.executions.findIndex(exec => exec.id === id);
        if (index === -1) {
            throw new Error(`Execution with ID "${id}" not found`);
        }

        // Remove from array
        this.executions.splice(index, 1);

        // Save to file
        await this.saveDatabase();
    }

    async getExecution(id: string): Promise<ExecutionMetadata | null> {
        const execution = this.executions.find(exec => exec.id === id);
        return execution || null;
    }

    async getExecutions(filters?: ExecutionFilters): Promise<ExecutionMetadata[]> {
        let filtered = [...this.executions];

        if (filters) {
            if (filters.environment) {
                filtered = filtered.filter(exec => exec.environment === filters.environment);
            }
            if (filters.status) {
                filtered = filtered.filter(exec => exec.status === filters.status);
            }
            if (filters.batchId) {
                filtered = filtered.filter(exec => exec.batchId === filters.batchId);
            }
            if (filters.endpointId) {
                filtered = filtered.filter(exec => exec.endpointId === filters.endpointId);
            }
            if (filters.startDate) {
                filtered = filtered.filter(exec => exec.createdAt >= filters.startDate!);
            }
            if (filters.endDate) {
                filtered = filtered.filter(exec => exec.createdAt <= filters.endDate!);
            }
        }

        // Sort by created date (newest first)
        filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        return filtered;
    }

    async getExecutionsByBatch(batchId: string): Promise<ExecutionMetadata[]> {
        return this.getExecutions({ batchId });
    }

    // NEW: Dedicated query methods for clean data separation
    async getIndividualExecutions(): Promise<ExecutionMetadata[]> {
        const filtered = this.executions.filter(exec =>
            exec.executionType === 'individual' || (!exec.executionType && !exec.batchId)
        );
        // Sort using the same sophisticated logic as getExecutionTable (completedAt priority)
        return filtered.sort((a, b) => {
            const aCompleted = a.completedAt !== undefined && a.completedAt !== null;
            const bCompleted = b.completedAt !== undefined && b.completedAt !== null;

            if (aCompleted && !bCompleted) return -1; // a (completed) comes before b (incomplete)
            if (!aCompleted && bCompleted) return 1;  // b (completed) comes before a (incomplete)
            if (!aCompleted && !bCompleted) {
                // Both incomplete - sort by createdAt as fallback (newest first)
                return b.createdAt.getTime() - a.createdAt.getTime();
            }
            // Both completed - sort by completedAt (newest first)
            return b.completedAt!.getTime() - a.completedAt!.getTime();
        });
    }

    async getBatchExecutions(): Promise<ExecutionMetadata[]> {
        // Return only batch executions from unified model
        const batchExecutions = this.executions.filter(exec => exec.executionType === 'batch');


        // Sort using the same sophisticated logic as getExecutionTable (completedAt priority)
        return batchExecutions.sort((a, b) => {
            const aCompleted = a.completedAt !== undefined && a.completedAt !== null;
            const bCompleted = b.completedAt !== undefined && b.completedAt !== null;

            if (aCompleted && !bCompleted) return -1; // a (completed) comes before b (incomplete)
            if (!aCompleted && bCompleted) return 1;  // b (completed) comes before a (incomplete)
            if (!aCompleted && !bCompleted) {
                // Both incomplete - sort by createdAt as fallback (newest first)
                return b.createdAt.getTime() - a.createdAt.getTime();
            }
            // Both completed - sort by completedAt (newest first)
            return b.completedAt!.getTime() - a.completedAt!.getTime();
        });
    }

    async getBatchMemberFiles(batchId: string): Promise<Array<{ id: string; status: string; responseFile?: string; createdAt: Date; errorMessage?: string; testStatus?: string }>> {
        return (await this.getBatchMemberExecutions(batchId)).map(m => ({ id: m.id, status: m.status, responseFile: m.responseFile, createdAt: m.createdAt, errorMessage: m.errorMessage, testStatus: m.testStatus }));
    }

    async countBatchMembersByStatus(batchId: string): Promise<Record<string, number>> {
        const counts: Record<string, number> = {};
        for (const member of await this.getBatchMemberExecutions(batchId)) {
            counts[member.status] = (counts[member.status] || 0) + 1;
        }
        return counts;
    }

    async getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]> {
        const filtered = this.executions.filter(exec =>
            (exec.executionType === 'batch_member' && exec.batchId === batchId) ||
            (!exec.executionType && exec.batchId === batchId)
        );
        // Sort by creation order
        return filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    /**
     * Get active queue executions (unified approach)
     * Returns both individual and batch executions with active status
     * Excludes batch_member executions (managed by BatchExecutionEngine)
     * @returns Promise resolving to active executions sorted by type then date
     */
    async getActiveQueue(): Promise<ExecutionMetadata[]> {
        try {
            // Filter for individual and batch executions with active statuses
            const activeExecutions = this.executions.filter(exec => {
                // Only include individual and batch executions (exclude batch_member)
                const isIncludedType = exec.executionType === 'individual' ||
                    exec.executionType === 'batch' ||
                    (!exec.executionType && !exec.batchId); // Legacy individual executions

                // Only include active statuses
                const isActiveStatus = exec.status === 'pending' ||
                    exec.status === 'running' ||
                    exec.status === 'preparing';

                return isIncludedType && isActiveStatus;
            });

            // Sort by execution type (individual first) then by createdAt date (oldest first)
            return activeExecutions.sort((a, b) => {
                // Primary sort: execution type (individual first)
                const aType = a.executionType || 'individual'; // Legacy fallback
                const bType = b.executionType || 'individual';

                if (aType !== bType) {
                    if (aType === 'individual') return -1;
                    if (bType === 'individual') return 1;
                    return 0;
                }

                // Secondary sort: createdAt date (oldest first for queue processing order)
                return a.createdAt.getTime() - b.createdAt.getTime();
            });

        } catch (error) {
            console.error('[SimpleExecutionMetadataManager] Failed to get active queue:', error);
            return [];
        }
    }

    /**
     * Get all transactions (active + completed) in a single optimized query
     * Replaces the need for separate getActiveQueue + getUnifiedExecutionHistory calls
     * @returns All executions sorted by createdAt (newest first)
     */
    async getAllTransactions(): Promise<ExecutionMetadata[]> {
        try {
            // Single in-memory filter and sort operation - most efficient possible
            const allTransactions = this.executions.filter(exec =>
                // Include both individual and batch executions (exclude batch_member to avoid duplication)
                exec.executionType === 'individual' ||
                exec.executionType === 'batch'
            );

            // Sort by createdAt (newest first) for consistent chronological ordering
            return allTransactions.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
        } catch (error) {
            console.error('[SimpleExecutionMetadataManager] Failed to get all transactions:', error);
            return [];
        }
    }

    async getExecutionTable(options: TableOptions = {}): Promise<ExecutionTableResult> {
        const { limit = 50, offset = 0, sortBy = 'createdAt', sortOrder = 'desc', filters } = options;

        // Get filtered executions
        const filtered = await this.getExecutions(filters);

        // Sort results with special handling for completedAt
        filtered.sort((a, b) => {
            const aValue = a[sortBy];
            const bValue = b[sortBy];

            // Special handling for completedAt sorting
            if (sortBy === 'completedAt') {
                // If sorting by completedAt, completed items should come before incomplete ones
                const aCompleted = aValue !== undefined && aValue !== null;
                const bCompleted = bValue !== undefined && bValue !== null;

                if (aCompleted && !bCompleted) return -1; // a (completed) comes before b (incomplete)
                if (!aCompleted && bCompleted) return 1;  // b (completed) comes before a (incomplete)
                if (!aCompleted && !bCompleted) {
                    // Both incomplete - sort by createdAt as fallback
                    const aCreated = a.createdAt;
                    const bCreated = b.createdAt;
                    if (aCreated && bCreated) {
                        return sortOrder === 'desc'
                            ? (bCreated > aCreated ? 1 : -1)
                            : (aCreated > bCreated ? 1 : -1);
                    }
                    return 0;
                }
                // Both completed - continue with normal date comparison below
            }

            // Handle undefined/null values for other fields
            if (aValue === undefined || aValue === null || bValue === undefined || bValue === null) {
                if (aValue === bValue) return 0;
                if (aValue === undefined || aValue === null) return 1;  // undefined/null goes to end
                if (bValue === undefined || bValue === null) return -1; // undefined/null goes to end
            }

            // Normal comparison for dates and other values
            if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        // Paginate results
        const totalCount = filtered.length;
        const executions = filtered.slice(offset, offset + limit);
        const hasMore = offset + executions.length < totalCount;

        return {
            executions,
            totalCount,
            hasMore
        };
    }

    async getExecutionStats(): Promise<ExecutionStats> {
        const totalExecutions = this.executions.length;
        const pendingExecutions = this.executions.filter(exec => exec.status === ExecutionStatus.PENDING).length;
        const runningExecutions = this.executions.filter(exec => exec.status === ExecutionStatus.RUNNING).length;
        const completedExecutions = this.executions.filter(exec => exec.status === ExecutionStatus.COMPLETED).length;
        const cancelledExecutions = this.executions.filter(exec => exec.status === ExecutionStatus.CANCELLED).length;
        const errorExecutions = this.executions.filter(exec => exec.status === ExecutionStatus.ERROR).length;

        // Calculate average run time for completed executions
        const completedWithRunTime = this.executions.filter(exec =>
            exec.status === ExecutionStatus.COMPLETED && exec.runTime !== undefined
        );
        const averageRunTime = completedWithRunTime.length > 0
            ? completedWithRunTime.reduce((sum, exec) => sum + (exec.runTime || 0), 0) / completedWithRunTime.length
            : null;

        return {
            totalExecutions,
            pendingExecutions,
            runningExecutions,
            completedExecutions,
            cancelledExecutions,
            errorExecutions,
            averageRunTime
        };
    }

    /**
     * @deprecated Use DatabaseAdapter.createExecutionFromEndpoint() instead.
     * This JSON-based implementation is no longer used in production.
     */
    async createExecutionFromEndpoint(
        endpointConfig: APIEndpointConfig,
        environment: string,
        organization?: string,
        batchId?: string,
        executionType?: 'individual' | 'batch' | 'batch_member',
        rowStart?: number,
        rows?: string
    ): Promise<string> {
        const metadata: Omit<ExecutionMetadata, 'id'> = {
            // Use provided executionType, or infer from batchId (fallback logic)
            executionType: executionType || (batchId ? 'batch_member' as const : 'individual' as const),
            // Use provided rows value, or default to '1'
            rows: rows || '1',
            environment, // Keep for backward compatibility
            environmentId: environment, // Always populate environmentId with the passed value (now an ID)
            organization,
            endpointId: endpointConfig.id,
            endpointName: endpointConfig.name,
            endpointMethod: endpointConfig.method || 'POST',
            endpointPath: endpointConfig.path,
            batchId,
            // NEW: Add rowStart field if provided (1-based CSV row index)
            rowStart: rowStart,
            status: 'pending',
            createdAt: new Date()
        };

        return this.createExecution(metadata);
    }

    private generateExecutionId(): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        return `${timestamp}_${Math.random().toString(36).slice(2, 5)}`;
    }

    private generateBatchId(): string {
        return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    // Removed - BatchMetadata no longer exists in unified model

    // Removed - BatchMetadata no longer exists in unified model

    // Removed - BatchMetadata no longer exists in unified model

    // Removed - BatchMetadata no longer exists in unified model

    // Removed - BatchMetadata no longer exists in unified model

    async getBatchExecutions_Legacy(batchId: string): Promise<ExecutionMetadata[]> {
        // Legacy method: Return executions that belong to the specified batch
        return this.executions.filter(execution => (execution as any).batchId === batchId);
    }

    // Removed - BatchMetadata no longer exists in unified model

    async getBatchResumptionData(batchId: string): Promise<any> {
        // Get batch execution from unified model
        const batchExecution = this.executions.find(exec => exec.id === batchId && exec.executionType === 'batch');
        if (!batchExecution) {
            return null;
        }

        // Get execution records for this batch
        const executions = await this.getExecutionsByBatch(batchId);

        // Calculate resumption data from execution records
        const completedExecutions = executions.filter(exec =>
            exec.status === ExecutionStatus.COMPLETED || exec.status === ExecutionStatus.ERROR || exec.status === ExecutionStatus.CANCELLED
        );

        const currentExecutionIndex = completedExecutions.length;
        const completedIds = executions.filter(exec => exec.status === ExecutionStatus.COMPLETED).map(exec => exec.id);
        const failedIds = executions.filter(exec => exec.status === ExecutionStatus.ERROR).map(exec => exec.id);

        return {
            currentExecutionIndex,
            completedExecutions: completedIds,
            failedExecutions: failedIds
        };
    }

    async storeBatchResumptionData(batchId: string, resumptionData: any): Promise<void> {
        // Store resumption data by updating batch execution
        await this.updateExecution(batchId, {
            batchResumptionData: resumptionData
        });
    }

    // ONE-TIME DATA MIGRATION: Add executionType field to existing data
    async migrateToExecutionTypes(): Promise<void> {
        // Check if migration already completed (prevent multiple runs)
        const alreadyMigrated = this.executions.some(exec => exec.executionType !== undefined);
        if (alreadyMigrated) {
            return;
        }


        let migrationNeeded = false;
        let migratedCount = 0;

        // Migrate existing executions
        this.executions = this.executions.map(exec => {
            if (!exec.executionType) {
                migrationNeeded = true;
                migratedCount++;
                return {
                    ...exec,
                    executionType: exec.batchId ? 'batch_member' : 'individual'
                };
            }
            return exec;
        });

        // NOTE: We do NOT convert batch metadata to execution records
        // Batches should remain as batches, executions should remain as executions
        // The tree view and dedicated queries handle the separation correctly

        // Save migrated data if changes were made
        if (migrationNeeded) {
            await this.saveDatabase();
        } else {
        }
    }

    async storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }> {
        try {
            // Validate the execution metadata
            const validatedMetadata = validateExecutionMetadata(batchExecution);

            // Store the validated metadata

            // Add to executions array (batch executions are stored as regular ExecutionMetadata with executionType: 'batch')
            this.executions.push(validatedMetadata);

            // Save to file
            await this.saveDatabase();

            this._onExecutionChanged.fire(validatedMetadata);

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error storing batch execution';
            return { success: false, errorMessage };
        }
    }

    /**
     * Get batch execution by ID (unified model)
     */
    async getBatchExecution(batchId: string): Promise<ExecutionMetadata | null> {
        try {
            // Find the batch execution record (executionType: 'batch')
            const batchExecution = this.executions.find(exec =>
                exec.id === batchId && exec.executionType === 'batch'
            );

            return batchExecution || null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error getting batch execution';
            console.error(`[SimpleExecutionMetadataManager] ERROR: Failed to get batch execution:`, errorMessage);
            return null;
        }
    }

    /**
     * Update existing batch execution - MISSING IMPLEMENTATION RESTORED
     * This method was accidentally removed during unified model migration
     */
    async updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        try {

            // Find the batch execution record (executionType: 'batch')
            const batchIndex = this.executions.findIndex(exec =>
                exec.id === batchId && exec.executionType === 'batch'
            );

            if (batchIndex === -1) {
                throw new Error(`Batch not found: ${batchId}`);
            }


            // Update the batch record with new values
            const updatedBatch = {
                ...this.executions[batchIndex],
                ...updates
            };

            // Validate the updated metadata
            this.executions[batchIndex] = validateExecutionMetadata(updatedBatch);

            // Save to storage
            await this.saveDatabase();


            // Fire change event for UI updates
            this._onExecutionChanged.fire(this.executions[batchIndex]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error updating batch metadata';
            console.error(`🔍 [CORRUPTION DEBUG] updateBatchExecution() FAILED for ${batchId}:`, errorMessage, error);
            throw error;
        }
    }

    dispose(): void {
        // Clean up if needed
    }
}