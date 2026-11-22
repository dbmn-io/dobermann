// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { BatchMemberFile, BatchMemberLogRow } from './execution-storage.interface';
import { Event, EventEmitter } from '../../platform/events';
import { SqlJsExecutionStorage } from './sqljs-execution-storage.service';
import { ExecutionMetadata, ExecutionFilters, TableOptions, ExecutionStats } from '../../storage/execution-metadata';
import { APIEndpointConfig } from '../../data-loading/types';
import { ExecutionLinkInput, ExecutionLinks } from '../chain/chain-types';

/**
 * Adapter to make database storage compatible with SimpleExecutionMetadataManager interface
 * GitHub Issue #102: Database migration - Phase 1 integration
 * GitHub Issue #109: Migrated to sql.js for cross-platform compatibility
 *
 * This adapter allows database storage to be used as a drop-in replacement
 * for SimpleExecutionMetadataManager without changing existing code.
 */
export class DatabaseAdapter {
    private storage: SqlJsExecutionStorage;
    private _onExecutionChanged: EventEmitter<ExecutionMetadata>;
    public readonly onExecutionChanged: Event<ExecutionMetadata>;

    /** Issue #324: takes the storage (in VS Code, `createVsCodeExecutionStorage(context)`). */
    constructor(storage: SqlJsExecutionStorage) {
        this.storage = storage;
        this._onExecutionChanged = new EventEmitter<ExecutionMetadata>();
        this.onExecutionChanged = this._onExecutionChanged.event;
    }

    async initialize(): Promise<void> {
        await this.storage.initialize();
    }

    async createExecution(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string> {
        const id = await this.storage.createExecution(metadata);

        // Fire event for compatibility
        const execution = await this.storage.getExecution(id);
        if (execution) {
            this._onExecutionChanged.fire(execution);
        }

        return id;
    }

    async createExecutionFromEndpoint(
        endpointConfig: APIEndpointConfig,
        environment: string,
        organization?: string,
        batchId?: string,
        executionType?: 'individual' | 'batch' | 'batch_member',
        rowStart?: number,
        rows?: string
    ): Promise<string> {
        // Convert endpoint config to execution metadata
        const metadata: Omit<ExecutionMetadata, 'id'> = {
            // Use provided executionType, or infer from batchId (fallback logic)
            executionType: executionType || (batchId ? 'batch_member' as const : 'individual' as const),
            // Use provided rows value, or default to '1'
            rows: rows || '1',
            environment,
            environmentId: environment, // Always populate environmentId (matches JSON version)
            organization,
            endpointId: endpointConfig.id || `endpoint-${Date.now()}`,
            endpointName: endpointConfig.name,
            endpointMethod: endpointConfig.method || 'POST',
            endpointPath: endpointConfig.path,
            batchId,
            // NEW: Add rowStart field if provided (1-based CSV row index)
            rowStart: rowStart,
            // GitHub Issue #110: INSERT with 'preparing' to prevent race condition
            // Status will be updated to 'pending' after files are created
            status: 'preparing',
            createdAt: new Date()
        };

        const id = await this.createExecution(metadata);
        return id;
    }

    async updateExecution(id: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        await this.storage.updateExecution(id, updates);

        // Fire event for compatibility
        const execution = await this.storage.getExecution(id);
        if (execution) {
            this._onExecutionChanged.fire(execution);
        }
    }

    async bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void> {
        await this.storage.bulkUpdateExecutions(updates);

        // Fire events for all updated executions
        for (const update of updates) {
            const execution = await this.storage.getExecution(update.id);
            if (execution) {
                this._onExecutionChanged.fire(execution);
            }
        }
    }

    async getExecution(id: string): Promise<ExecutionMetadata | null> {
        return this.storage.getExecution(id);
    }

    async getExecutions(filters?: ExecutionFilters): Promise<ExecutionMetadata[]> {
        return this.storage.getExecutions(filters);
    }

    async getExecutionTable(options?: TableOptions): Promise<any> {
        return this.storage.getExecutionTable(options);
    }

    async getExecutionStats(): Promise<ExecutionStats> {
        return this.storage.getExecutionStats();
    }

    async deleteExecution(id: string): Promise<void> {
        await this.storage.deleteExecution(id);
    }

    async deleteExecutions(ids: string[]): Promise<number> {
        return this.storage.deleteExecutions(ids);
    }

    async searchExecutionBodies(ids: string[], term: string): Promise<string[]> {
        return this.storage.searchExecutionBodies(ids, term);
    }

    // Batch-specific methods
    async createBatch(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string> {
        return this.storage.createBatch(metadata);
    }

    async updateBatch(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        return this.storage.updateBatch(batchId, updates);
    }

    async getBatchExecution(batchId: string): Promise<ExecutionMetadata | null> {
        return this.storage.getBatchExecution(batchId);
    }

    async deleteBatch(batchId: string): Promise<void> {
        return this.storage.deleteBatch(batchId);
    }

    async storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }> {
        return this.storage.storeBatchExecution(batchExecution);
    }

    async updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        return this.storage.updateBatchExecution(batchId, updates);
    }

    async storeBatchResumptionData(batchId: string, resumptionData: any): Promise<void> {
        return this.storage.storeBatchResumptionData(batchId, resumptionData);
    }

    async getBatchResumptionData(batchId: string): Promise<any | null> {
        return this.storage.getBatchResumptionData(batchId);
    }

    // Filtered query methods
    async getIndividualExecutions(): Promise<ExecutionMetadata[]> {
        return this.storage.getIndividualExecutions();
    }

    async getBatchExecutions(): Promise<ExecutionMetadata[]> {
        return this.storage.getBatchExecutions();
    }

    async getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]> {
        return this.storage.getBatchMemberExecutions(batchId);
    }

    async countBatchMembersByStatus(batchId: string): Promise<Record<string, number>> {
        return this.storage.countBatchMembersByStatus(batchId);
    }

    async getBatchMemberFiles(batchId: string): Promise<BatchMemberFile[]> {
        return this.storage.getBatchMemberFiles(batchId);
    }

    /** Dobermann issue 7: a slice of a batch's requests, as the Logs screen shows them. */
    async getBatchMemberLogRows(batchId: string, offset: number, limit: number): Promise<BatchMemberLogRow[]> {
        return this.storage.getBatchMemberLogRows(batchId, offset, limit);
    }

    /** GitHub Issue #247 */
    async addExecutionLink(link: ExecutionLinkInput): Promise<string> {
        return this.storage.addExecutionLink(link);
    }

    /** GitHub Issue #247 */
    async getExecutionLinks(executionId: string): Promise<ExecutionLinks> {
        return this.storage.getExecutionLinks(executionId);
    }

    async getActiveQueue(): Promise<ExecutionMetadata[]> {
        return this.storage.getActiveQueue();
    }

    async getAllTransactions(): Promise<ExecutionMetadata[]> {
        return this.storage.getAllTransactions();
    }

    async getExecutionsByEndpoint(endpointId: string, options?: { runsOnly?: boolean }): Promise<ExecutionMetadata[]> {
        return this.storage.getExecutionsByEndpoint(endpointId, options);
    }

    async getBatches(): Promise<ExecutionMetadata[]> {
        return this.storage.getBatches();
    }

    async getBatchExecutions_Legacy(batchId: string): Promise<ExecutionMetadata[]> {
        return this.storage.getBatchExecutions_Legacy(batchId);
    }

    // GitHub Issue #110: Atomic claim delegation for race condition fix
    async claimPendingBatchMembers(batchId: string, limit: number): Promise<ExecutionMetadata[]> {
        return this.storage.claimPendingBatchMembers(batchId, limit);
    }

    // GitHub Issue #198: Bulk-create execution records in a single transaction
    async createExecutionBatch(metadataArray: Array<Omit<ExecutionMetadata, 'id'>>): Promise<string[]> {
        return this.storage.createExecutionBatch(metadataArray);
    }

    /**
     * Close database connection — flushes pending writes and releases resources.
     * Called during extension deactivation to prevent data loss from debounced saves.
     */
    close(): void {
        this.storage.close();
    }
}
