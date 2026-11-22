// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionOptions } from './execution.interface';
import { ExecutionMetadata, ExecutionStatus, StatusHelpers } from '../../storage/execution-metadata';
import type { BatchMemberLogRow } from '../storage/execution-storage.interface';
import { 
    IExecutionMetadataService, 
    ExecutionTableOptions, 
    ExecutionTableResult, 
    ExecutionStats,
    ExecutionResults,
    ExecutionChangedEvent
} from './execution-metadata.interface';
import { IStateBroadcaster } from '../state-broadcaster/state-broadcaster.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { CoreServiceTokens } from '../../container/core-services-registry';


// Dependencies interface for ExecutionMetadataService
export interface ExecutionMetadataServiceDependencies {
    executionMetadataManager: {
        initialize?: () => Promise<void>;
        createExecutionFromEndpoint: (endpointConfig: APIEndpointConfig, environment: string, organization?: string, batchId?: string, executionType?: 'individual' | 'batch' | 'batch_member', rowStart?: number, rows?: string) => Promise<string>;
        updateExecution: (id: string, updates: Partial<ExecutionMetadata>) => Promise<void>;
        getExecution: (id: string) => Promise<ExecutionMetadata | null>;
        getExecutions: (filters?: any) => Promise<ExecutionMetadata[]>;
        getExecutionTable: (options?: any) => Promise<any>;
        getExecutionStats: () => Promise<any>;
        deleteExecution: (id: string) => Promise<void>;
        deleteExecutions?: (ids: string[]) => Promise<number>;
        searchExecutionBodies?: (ids: string[], term: string) => Promise<string[]>;
        getExecutionsByEndpoint?: (endpointId: string, options?: { runsOnly?: boolean }) => Promise<ExecutionMetadata[]>;
        onExecutionChanged: any;
        storeBatchExecution?: (batchExecution: ExecutionMetadata) => Promise<{ success: boolean; errorMessage?: string }>;
        getBatchExecution?: (batchId: string) => Promise<ExecutionMetadata | null>;
        updateBatchExecution?: (batchId: string, updates: Partial<ExecutionMetadata>) => Promise<void>;
        getBatchResumptionData: (batchId: string) => Promise<any>;
        storeBatchResumptionData: (batchId: string, resumptionData: any) => Promise<void>;
        getBatches: () => Promise<ExecutionMetadata[]>;
        getBatchExecutions_Legacy: (batchId: string) => Promise<ExecutionMetadata[]>;
        createBatch: (metadata: Omit<ExecutionMetadata, 'batchId'>) => Promise<string>;
        updateBatch: (batchId: string, updates: Partial<ExecutionMetadata>) => Promise<void>;
        deleteBatch: (batchId: string) => Promise<void>;
        // NEW: Dedicated query methods for clean data separation
        getIndividualExecutions: () => Promise<ExecutionMetadata[]>;
        getBatchExecutions: () => Promise<ExecutionMetadata[]>;
        getBatchMemberExecutions: (batchId: string) => Promise<ExecutionMetadata[]>;
        countBatchMembersByStatus?: (batchId: string) => Promise<Record<string, number>>;
        getBatchMemberFiles?: (batchId: string) => Promise<Array<{ id: string; status: string; responseFile?: string; createdAt: Date; errorMessage?: string; testStatus?: string }>>;
        getBatchMemberLogRows?: (batchId: string, offset: number, limit: number) => Promise<BatchMemberLogRow[]>;
        getActiveQueue: () => Promise<ExecutionMetadata[]>;
        getAllTransactions: () => Promise<ExecutionMetadata[]>;
        // GitHub Issue #67 - Bulk update method to prevent file corruption
        bulkUpdateExecutions?: (updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>) => Promise<void>;
        // GitHub Issue #110 - Atomic claim method to prevent duplicate execution race condition
        claimPendingBatchMembers?: (batchId: string, limit: number) => Promise<ExecutionMetadata[]>;
        // GitHub Issue #198 - Bulk-create execution records for fast pagination member creation
        createExecutionBatch?: (metadataArray: Array<Omit<ExecutionMetadata, 'id'>>) => Promise<string[]>;
    };
    dobermannInstance: {
        getActiveEnvironment?: () => Promise<{ name?: string; id?: string } | undefined>;
        getDecodedToken?: () => Promise<{ organization?: string; org?: string } | undefined>;
    };
    stateBroadcaster?: IStateBroadcaster;
}

// Implementation of ExecutionMetadataService that wraps the existing SimpleExecutionMetadataManager
export class ExecutionMetadataService implements IExecutionMetadataService {
    private dependencies: ExecutionMetadataServiceDependencies;

    constructor(
        dependencies: ExecutionMetadataServiceDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.dependencies = dependencies;
    }

    async initialize(): Promise<void> {
        if (this.dependencies.executionMetadataManager?.initialize) {
            await this.dependencies.executionMetadataManager.initialize();
        }
    }

    async createExecution(endpoint: APIEndpointConfig, options?: ExecutionOptions): Promise<string> {
        if (this.dependencies.executionMetadataManager?.createExecutionFromEndpoint) {
            // Use environmentId from options if provided (UUID), otherwise fall back to environment name
            let environment = (options as any)?.environmentId || options?.environment || 'default';
            let organization = options?.organization;

            // Only get from active instance if not provided in options
            if (!environment || environment === 'default') {
                if (this.dependencies.dobermannInstance?.getActiveEnvironment) {
                    const activeEnv = await this.dependencies.dobermannInstance.getActiveEnvironment();
                    environment = activeEnv?.id || activeEnv?.name || 'default';
                }
            }

            // Only get organization from JWT if not provided in options
            if (!options?.organization && this.dependencies.dobermannInstance?.getDecodedToken) {
                const token = await this.dependencies.dobermannInstance.getDecodedToken();
                organization = token?.organization || token?.org;
            }

            // Extract unified execution model fields from options
            const executionType = options?.executionType;
            const rowStart = options?.rowStart;
            const rows = options?.rows;

            // DEBUG: Log what we received and are passing
            this.logger.debug(`[ExecutionMetadataService] createExecution called with:`, {
                executionType,
                rowStart,
                rows,
                batchId: options?.batchId,
                environment,
                organization
            });

            const executionId = await this.dependencies.executionMetadataManager.createExecutionFromEndpoint(
                endpoint,
                environment,
                organization,
                options?.batchId, // batchId - links execution to batch if provided
                executionType, // executionType - 'individual', 'batch', or 'batch_member'
                rowStart, // rowStart - starting CSV row index (1-based)
                rows // rows - row information string
            );

            // DEBUG: Log the created execution ID
            this.logger.debug(`[ExecutionMetadataService] Created execution:`, { executionId });

            // 🎯 BROADCAST STATE CHANGE for new executions to update Active Queue immediately
            if (this.dependencies.stateBroadcaster) {
                try {
                    const execution = await this.getExecution(executionId);
                    if (execution) {
                        await this.dependencies.stateBroadcaster.broadcast(
                            'execution-state-changed',
                            {
                                executionId,
                                status: execution.status,
                                execution,
                                executionType: execution.executionType
                            },
                            'ExecutionMetadataService'
                        );
                    }
                } catch (error) {
                    this.logger.warn('[ExecutionMetadataService] Failed to broadcast execution creation', error);
                }
            }

            return executionId;
        }
        
        // Fallback - generate a unique ID if service is not available
        return `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async updateExecution(executionId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        if (this.dependencies.executionMetadataManager?.updateExecution) {
            await this.dependencies.executionMetadataManager.updateExecution(executionId, updates);
        }
        
        // Fire execution changed event
        if (this.dependencies.executionMetadataManager?.onExecutionChanged?.fire) {
            // Get the updated execution to fire the event
            const execution = await this.getExecution(executionId);
            if (execution) {
                this.dependencies.executionMetadataManager.onExecutionChanged.fire(execution);
            }
        }

        // NEW: Broadcast state change for event-driven UI updates
        if (this.dependencies.stateBroadcaster && updates.status) {
            try {
                const execution = await this.getExecution(executionId);
                if (execution) {
                    await this.dependencies.stateBroadcaster.broadcast(
                        'execution-state-changed',
                        {
                            executionId,
                            status: updates.status,
                            execution,
                            timestamp: new Date()
                        },
                        'execution-metadata-service'
                    );
                }
            } catch (error) {
                this.logger.warn('[ExecutionMetadataService] Failed to broadcast state change', error);
            }
        }
    }

    async updateExecutionStatus(executionId: string, status: ExecutionStatus): Promise<void> {
        await this.updateExecution(executionId, { status });
    }

    async updateExecutionResults(executionId: string, results: ExecutionResults): Promise<void> {
        await this.updateExecution(executionId, results);
    }

    /**
     * Bulk update multiple executions (GitHub Issue #67 - prevent corruption)
     * @param updates - Array of execution updates to apply
     * @returns Promise that resolves when all updates are complete
     */
    async bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void> {
        if (this.dependencies.executionMetadataManager?.bulkUpdateExecutions) {
            await this.dependencies.executionMetadataManager.bulkUpdateExecutions(updates);
            
            // Fire execution changed events for all updated executions
            if (this.dependencies.executionMetadataManager?.onExecutionChanged?.fire) {
                for (const update of updates) {
                    const execution = await this.getExecution(update.id);
                    if (execution) {
                        this.dependencies.executionMetadataManager.onExecutionChanged.fire(execution);
                    }
                }
            }

            // NEW: Broadcast state changes for all updated executions
            if (this.dependencies.stateBroadcaster) {
                try {
                    for (const update of updates) {
                        if (update.updates.status) {
                            const execution = await this.getExecution(update.id);
                            if (execution) {
                                await this.dependencies.stateBroadcaster.broadcast(
                                    'execution-state-changed',
                                    {
                                        executionId: update.id,
                                        status: update.updates.status,
                                        execution,
                                        timestamp: new Date()
                                    },
                                    'execution-metadata-service'
                                );
                            }
                        }
                    }
                } catch (error) {
                    this.logger.warn('[ExecutionMetadataService] Failed to broadcast bulk state changes', error);
                }
            }
            
            return;
        }
        
        // Fallback: Use individual updates if bulk method not available
        // This is not ideal for performance but maintains functionality
        this.logger.warn('[ExecutionMetadataService] bulkUpdateExecutions not available, falling back to individual updates');
        for (const update of updates) {
            await this.updateExecution(update.id, update.updates);
        }
    }

    async getExecution(executionId: string): Promise<ExecutionMetadata | null> {
        if (this.dependencies.executionMetadataManager?.getExecution) {
            return await this.dependencies.executionMetadataManager.getExecution(executionId);
        }
        
        return null;
    }

    async deleteExecution(executionId: string): Promise<boolean> {
        if (this.dependencies.executionMetadataManager?.deleteExecution) {
            try {
                await this.dependencies.executionMetadataManager.deleteExecution(executionId);
                // If no error was thrown, the deletion was successful
                return true;
            } catch (error) {
                // If deletion fails (e.g., execution doesn't exist), return false
                return false;
            }
        }

        return false;
    }

    async deleteExecutions(ids: string[]): Promise<number> {
        if (!this.dependencies.executionMetadataManager?.deleteExecutions) {
            // Adapter doesn't implement bulk delete — fall back to per-row
            // so we never silently drop the operation.
            let deleted = 0;
            for (const id of ids) {
                try {
                    await this.dependencies.executionMetadataManager?.deleteExecution(id);
                    deleted++;
                } catch (err) {
                    this.logger.warn(`[ExecutionMetadataService] deleteExecutions fallback: ${id} failed`, err instanceof Error ? { message: err.message } : undefined);
                }
            }
            return deleted;
        }
        return this.dependencies.executionMetadataManager.deleteExecutions(ids);
    }

    async searchExecutionBodies(ids: string[], term: string): Promise<string[]> {
        if (!this.dependencies.executionMetadataManager?.searchExecutionBodies) {
            return [];
        }
        return this.dependencies.executionMetadataManager.searchExecutionBodies(ids, term);
    }

    async deleteBatch(batchId: string): Promise<boolean> {
        if (this.dependencies.executionMetadataManager?.deleteBatch) {
            try {
                await this.dependencies.executionMetadataManager.deleteBatch(batchId);
                return true;
            } catch (error) {
                this.logger.error('[ExecutionMetadataService] Failed to delete batch', error instanceof Error ? error : undefined);
                return false;
            }
        }
        return false;
    }

    async getExecutionTable(options?: ExecutionTableOptions): Promise<ExecutionTableResult> {
        if (this.dependencies.executionMetadataManager?.getExecutionTable) {
            // Transform interface parameters to implementation parameters
            const tableOptions = {
                limit: options?.pageSize || 25,
                offset: ((options?.page || 1) - 1) * (options?.pageSize || 25),
                sortBy: options?.sortBy as keyof ExecutionMetadata || 'created_at',
                sortOrder: options?.sortOrder || 'desc',
                filters: options?.filters
            };
            
            const result = await this.dependencies.executionMetadataManager.getExecutionTable(tableOptions);
            
            // Transform implementation result to interface result
            const page = options?.page || 1;
            const pageSize = options?.pageSize || 25;
            const totalPages = Math.ceil(result.totalCount / pageSize);
            
            return {
                executions: result.executions,
                totalCount: result.totalCount,
                page: page,
                pageSize: pageSize,
                totalPages: totalPages
            };
        }
        
        // Fallback empty table
        return {
            executions: [],
            totalCount: 0,
            page: options?.page || 1,
            pageSize: options?.pageSize || 25,
            totalPages: 0
        };
    }

    async getExecutionStats(): Promise<ExecutionStats> {
        if (this.dependencies.executionMetadataManager?.getExecutionStats) {
            return await this.dependencies.executionMetadataManager.getExecutionStats();
        }
        
        // Fallback empty stats
        return {
            total: 0,
            completed: 0,
            pending: 0,
            running: 0,
            error: 0,
            cancelled: 0
        };
    }

    get onExecutionChanged(): ExecutionChangedEvent {
        if (this.dependencies.executionMetadataManager?.onExecutionChanged) {
            // Handle VS Code Event<ExecutionMetadata> type
            if (typeof this.dependencies.executionMetadataManager.onExecutionChanged === 'function') {
                return {
                    event: this.dependencies.executionMetadataManager.onExecutionChanged,
                    fire: (execution: ExecutionMetadata) => {
                        // Fire via the private _onExecutionChanged emitter if available
                        if ((this.dependencies.executionMetadataManager as any)._onExecutionChanged?.fire) {
                            (this.dependencies.executionMetadataManager as any)._onExecutionChanged.fire(execution);
                        }
                    }
                };
            }
            // Handle object with event/fire methods
            return this.dependencies.executionMetadataManager.onExecutionChanged;
        }
        
        // Fallback event emitter
        return {
            event: (listener: (execution: ExecutionMetadata) => void) => {
                // No-op for fallback
            },
            fire: (execution: ExecutionMetadata) => {
                // No-op for fallback
            }
        };
    }

    // Batch-related methods (Phase 2)
    async storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }> {
        if (this.dependencies.executionMetadataManager?.storeBatchExecution) {
            return await this.dependencies.executionMetadataManager.storeBatchExecution(batchExecution);
        }
        
        // Fallback: If storeBatchExecution is not implemented, return error
        this.logger.error(`[ExecutionMetadataService] ERROR: storeBatchExecution not implemented in execution metadata manager`);
        return { success: false, errorMessage: 'storeBatchExecution not implemented in storage layer' };
    }

    async getBatchExecution(batchId: string): Promise<ExecutionMetadata | null> {
        if (this.dependencies.executionMetadataManager?.getBatchExecution) {
            return await this.dependencies.executionMetadataManager.getBatchExecution(batchId);
        }
        
        // Fallback implementation
        return null;
    }

    async updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<{ success: boolean; errorMessage?: string }> {
        try {
            if (this.dependencies.executionMetadataManager?.updateBatchExecution) {
                await this.dependencies.executionMetadataManager.updateBatchExecution(batchId, updates);
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, errorMessage: error instanceof Error ? error.message : 'Unknown error' };
        }
    }


    async storeBatchResumptionData(batchId: string, resumptionData: any): Promise<{ success: boolean; errorMessage?: string }> {
        try {
            if (this.dependencies.executionMetadataManager?.storeBatchResumptionData) {
                await this.dependencies.executionMetadataManager.storeBatchResumptionData(batchId, resumptionData);
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, errorMessage: error instanceof Error ? error.message : 'Unknown error' };
        }
    }

    async getBatchResumptionData(batchId: string): Promise<any | null> {
        if (this.dependencies.executionMetadataManager?.getBatchResumptionData) {
            return await this.dependencies.executionMetadataManager.getBatchResumptionData(batchId);
        }
        
        // Fallback implementation
        return null;
    }

    async getBatches(): Promise<ExecutionMetadata[]> {
        if (this.dependencies.executionMetadataManager?.getBatchExecutions) {
            // Use the unified method that filters for executionType: 'batch'
            return await this.dependencies.executionMetadataManager.getBatchExecutions();
        }
        
        // Fallback implementation - filter from getExecutions if available
        if (this.dependencies.executionMetadataManager?.getExecutions) {
            const allExecutions = await this.dependencies.executionMetadataManager.getExecutions();
            return allExecutions.filter(exec => exec.executionType === 'batch');
        }
        
        return [];
    }

    async getExecutionsByBatch(batchId: string): Promise<ExecutionMetadata[]> {
        // Alias for getBatchMemberExecutions to maintain compatibility
        if (this.dependencies.executionMetadataManager?.getBatchMemberExecutions) {
            return await this.dependencies.executionMetadataManager.getBatchMemberExecutions(batchId);
        }
        
        // Fallback implementation
        return [];
    }

    async createBatch(metadata: Omit<ExecutionMetadata, 'batchId'>): Promise<string> {
        if (this.dependencies.executionMetadataManager?.createBatch) {
            return await this.dependencies.executionMetadataManager.createBatch(metadata);
        }
        
        throw new Error('Batch creation not supported by current storage implementation');
    }

    async getExecutionsByEndpoint(endpointId: string, options?: { runsOnly?: boolean }): Promise<ExecutionMetadata[]> {
        if (this.dependencies.executionMetadataManager?.getExecutionsByEndpoint) {
            return await this.dependencies.executionMetadataManager.getExecutionsByEndpoint(endpointId, options);
        }
        
        // Fallback: get all executions and filter by endpoint
        const table = await this.getExecutionTable();
        return table.executions.filter(exec => exec.endpointId === endpointId && (!options?.runsOnly || exec.executionType !== 'batch_member'));
    }

    async getUnifiedExecutionHistory(): Promise<Array<ExecutionMetadata & { isBatch?: boolean, batchId?: string }>> {
        try {
            // The app's one list of runs (DatabaseAdapter.getAllTransactions, kept until the history changes), or the two reads
            const shared = this.dependencies.executionMetadataManager?.getAllTransactions
                ? await this.dependencies.executionMetadataManager.getAllTransactions()
                : undefined;
            const batches = shared ? shared.filter(e => e.executionType === 'batch') : await this.getBatches();
            const individuals = shared ? shared.filter(e => e.executionType === 'individual') : await this.getIndividualExecutions();
            
            // Batches are already in ExecutionMetadata format, just mark them
            const batchItems = batches.map((batch: ExecutionMetadata) => ({
                ...batch,
                isBatch: true
            }));
            
            // Individual executions are already in ExecutionMetadata format, just mark them  
            const executionItems = individuals.map((exec: ExecutionMetadata) => ({
                ...exec,
                isBatch: false
            }));
            
            // Combine and sort by completion time
            const allItems = [...batchItems, ...executionItems];
            
            // Filter to only show completed items in execution history
            const completedItems = allItems.filter(item => {
                return StatusHelpers.isFinished(item.executionType, item.status);
            });
            
            // Sort by completion time (newest first)
            return completedItems.sort((a, b) => {
                const aTime = a.completedAt ? a.completedAt.getTime() : 0;
                const bTime = b.completedAt ? b.completedAt.getTime() : 0;
                return bTime - aTime; // Newest first
            });
            
        } catch (error) {
            this.logger.error('[ExecutionMetadataService] Failed to get unified execution history', error instanceof Error ? error : undefined);
            return [];
        }
    }

    // NEW: Dedicated query methods for clean data separation
    /**
     * @deprecated Use getActiveQueue() for active executions and getUnifiedExecutionHistory() for history
     */
    async getIndividualExecutions(): Promise<ExecutionMetadata[]> {
        if (this.dependencies.executionMetadataManager?.getIndividualExecutions) {
            return await this.dependencies.executionMetadataManager.getIndividualExecutions();
        }
        
        // Fallback implementation
        return [];
    }

    /**
     * @deprecated Use getActiveQueue() for active executions and getUnifiedExecutionHistory() for history
     */
    async getBatchExecutions(): Promise<ExecutionMetadata[]> {
        if (this.dependencies.executionMetadataManager?.getBatchExecutions) {
            return await this.dependencies.executionMetadataManager.getBatchExecutions();
        }
        
        // Fallback implementation
        return [];
    }

    /** Dobermann issue 7: a slice of a batch's requests, only what a log line needs (whole rows, cut, where the store has no lean query). */
    async getBatchMemberLogRows(batchId: string, offset: number, limit: number): Promise<BatchMemberLogRow[]> {
        if (this.dependencies.executionMetadataManager?.getBatchMemberLogRows) {
            return this.dependencies.executionMetadataManager.getBatchMemberLogRows(batchId, offset, limit);
        }
        return (await this.getBatchMemberExecutions(batchId)).slice(offset, offset + limit);
    }

    async getBatchMemberFiles(batchId: string): Promise<Array<{ id: string; status: string; responseFile?: string; createdAt: Date; errorMessage?: string; testStatus?: string }>> {
        if (this.dependencies.executionMetadataManager?.getBatchMemberFiles) {
            return this.dependencies.executionMetadataManager.getBatchMemberFiles(batchId);
        }
        return (await this.getBatchMemberExecutions(batchId)).map(m => ({ id: m.id, status: m.status, responseFile: m.responseFile, createdAt: m.createdAt, errorMessage: m.errorMessage, testStatus: m.testStatus }));
    }

    async countBatchMembersByStatus(batchId: string): Promise<Record<string, number>> {
        if (this.dependencies.executionMetadataManager?.countBatchMembersByStatus) {
            return this.dependencies.executionMetadataManager.countBatchMembersByStatus(batchId);
        }
        // Fallback for a manager without the query: count the rows the slow way
        const counts: Record<string, number> = {};
        for (const member of await this.getBatchMemberExecutions(batchId)) {
            counts[member.status] = (counts[member.status] || 0) + 1;
        }
        return counts;
    }

    async getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]> {
        
        if (this.dependencies.executionMetadataManager?.getBatchMemberExecutions) {
            const result = await this.dependencies.executionMetadataManager.getBatchMemberExecutions(batchId);
            return result;
        }
        
        // Fallback implementation
        this.logger.warn(`[ExecutionMetadataService] getBatchMemberExecutions method not available on manager, returning empty array`);
        return [];
    }

    /**
     * Get active queue executions (unified approach)
     * Returns both individual and batch executions with active status
     * Excludes batch_member executions (managed by BatchExecutionEngine)
     * @returns Promise resolving to active executions sorted by type then date
     */
    async getActiveQueue(): Promise<ExecutionMetadata[]> {
        if (this.dependencies.executionMetadataManager?.getActiveQueue) {
            return await this.dependencies.executionMetadataManager.getActiveQueue();
        }
        
        // Fallback implementation using individual methods if getActiveQueue not available
        try {
            const individuals = await this.getIndividualExecutions();
            const batches = await this.getBatchExecutions();
            
            // Filter for active statuses (pending, running, preparing)
            const activeIndividuals = individuals.filter(exec => 
                exec.status === 'pending' || 
                exec.status === 'running' || 
                exec.status === 'preparing'
            );
            
            const activeBatches = batches.filter(exec => 
                exec.status === 'pending' || 
                exec.status === 'running' || 
                exec.status === 'preparing'
            );
            
            // Combine all active executions
            const allActive = [...activeIndividuals, ...activeBatches];
            
            // Sort by execution type (individual first) then by createdAt date
            return allActive.sort((a, b) => {
                // Primary sort: execution type (individual first)
                if (a.executionType !== b.executionType) {
                    if (a.executionType === 'individual') return -1;
                    if (b.executionType === 'individual') return 1;
                    return 0;
                }
                
                // Secondary sort: createdAt date (oldest first)
                const aTime = a.createdAt ? a.createdAt.getTime() : 0;
                const bTime = b.createdAt ? b.createdAt.getTime() : 0;
                return aTime - bTime;
            });
            
        } catch (error) {
            this.logger.error('[ExecutionMetadataService] Failed to get active queue', error instanceof Error ? error : undefined);
            return [];
        }
    }

    /**
     * Get all transactions (active + completed) in a single optimized call
     */
    async getAllTransactions(): Promise<ExecutionMetadata[]> {
        try {
            // FULLY OPTIMIZED: Single storage call - no fallback needed
            if (this.dependencies.executionMetadataManager?.getAllTransactions) {
                return await this.dependencies.executionMetadataManager.getAllTransactions();
            }

            // This should never happen in current architecture
            throw new Error('getAllTransactions method not available on storage manager');

        } catch (error) {
            this.logger.error('[ExecutionMetadataService] Error getting all transactions', error instanceof Error ? error : undefined);
            return [];
        }
    }

    /**
     * Atomically claim pending batch members (GitHub Issue #110: Fix duplicate execution race condition)
     * Delegates to storage manager's atomic claim method
     */
    async claimPendingBatchMembers(batchId: string, limit: number): Promise<ExecutionMetadata[]> {
        try {
            if (this.dependencies.executionMetadataManager?.claimPendingBatchMembers) {
                return await this.dependencies.executionMetadataManager.claimPendingBatchMembers(batchId, limit);
            }

            // Fallback to old read-filter-update pattern if storage doesn't support atomic claiming
            this.logger.warn('[ExecutionMetadataService] Storage does not support atomic claiming, falling back to legacy method');
            const allMembers = await this.getBatchMemberExecutions(batchId);
            const pending = allMembers
                .filter(m => m.status === 'pending')
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .slice(0, limit);

            // Update to running (not atomic!)
            await Promise.all(pending.map(m => this.updateExecution(m.id, { status: 'running', startedAt: new Date() })));
            return pending;

        } catch (error) {
            this.logger.error('[ExecutionMetadataService] Error claiming pending batch members', error instanceof Error ? error : undefined);
            return [];
        }
    }

    /**
     * GitHub Issue #198: Bulk-create execution records in a single transaction
     * Optimized for pagination member creation - single DB transaction with one disk write
     */
    async createExecutionBatch(metadataArray: Array<Omit<ExecutionMetadata, 'id'>>): Promise<string[]> {
        if (this.dependencies.executionMetadataManager?.createExecutionBatch) {
            return await this.dependencies.executionMetadataManager.createExecutionBatch(metadataArray);
        }

        // Fallback: create one at a time
        this.logger.warn('[ExecutionMetadataService] Storage does not support bulk creation, falling back to sequential inserts');
        const ids: string[] = [];
        for (const metadata of metadataArray) {
            const endpoint: APIEndpointConfig = {
                id: metadata.endpointId,
                name: metadata.endpointName,
                method: metadata.endpointMethod as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
                path: metadata.endpointPath,
                headers: metadata.requestHeaders || {},
                queryParams: metadata.requestQueryParams || {}
            };
            const id = await this.createExecution(endpoint, {
                batchId: metadata.batchId,
                executionType: metadata.executionType as 'batch_member',
                rowStart: metadata.rowStart,
                rows: metadata.rows,
                environment: metadata.environment,
                organization: metadata.organization
            });
            ids.push(id);
        }
        return ids;
    }
}