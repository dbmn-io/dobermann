// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { 
    IExecutionCoordinator, 
    ExecutionCoordinatorState, 
    ExecutionEngineType,
    CoordinationResult,
    ExecutionEngineConfig,
    TrackedExecutionState
} from './execution-coordinator.interface';
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { CoreServiceTokens } from '../../container/core-services-registry';


/**
 * Dependencies for ExecutionCoordinator
 */
export interface ExecutionCoordinatorDependencies {
    executionMetadataService: any; // For updating execution statuses
    individualExecutionEngine?: any; // For delegating individual executions
    batchExecutionEngine?: any;     // For delegating batch executions
}

/**
 * ExecutionCoordinator Service
 * 
 * Manages global execution state to ensure only one execution runs at a time.
 * Implements priority-based coordination where individual executions can interrupt batch.
 * Handles startup recovery for executions left in pending state.
 * 
 * Key Principles:
 * - Only one execution runs at a time system-wide
 * - Individual executions (HIGH priority) can interrupt batch executions
 * - Batch executions (NORMAL priority) run sequentially
 * - Clean state management with proper error handling
 */
export class ExecutionCoordinator implements IExecutionCoordinator {
    private dependencies: ExecutionCoordinatorDependencies;
    private state: ExecutionCoordinatorState;
    private engineConfigs: Map<ExecutionEngineType, ExecutionEngineConfig>;

    constructor(
        dependencies: ExecutionCoordinatorDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.dependencies = dependencies;
        
        // Initialize coordinator state (centralized management only)
        this.state = {
            // Centralized status bar management
            activeExecutions: new Map(),
            activeBatchId: null,
            activeIndividualIds: []
        };

        // Initialize engine configurations
        this.engineConfigs = new Map([
            ['individual', {
                maxConcurrent: 1,
                canBeInterrupted: false, // Individual executions cannot be interrupted
                defaultTimeout: 30000,   // 30 seconds
                retryPolicy: {
                    maxRetries: 2,
                    backoffMs: 1000
                }
            }],
            ['batch', {
                maxConcurrent: 1,
                canBeInterrupted: true,  // Batch executions can be interrupted by individual
                defaultTimeout: 300000,  // 5 minutes per batch item
                retryPolicy: {
                    maxRetries: 1,
                    backoffMs: 2000
                }
            }]
        ]);
    }





    /**
     * Notify coordinator that an execution has completed
     * Simplified version that delegates to removeExecution
     */
    async completeExecution(executionId: string): Promise<void> {
        try {
            // Simply remove the execution from tracking
            // All state management is handled by updateExecutionState during execution
            await this.removeExecution(executionId);
        } catch (error) {
            this.logger.error(`[ExecutionCoordinator] Failed to complete execution ${executionId}`, error instanceof Error ? error : undefined, { executionId });
        }
    }


    /**
     * Cancel a specific execution
     */
    async cancelExecution(executionId: string): Promise<CoordinationResult> {
        try {
            // Remove from tracking
            await this.removeExecution(executionId);
            
            // TODO: Delegate actual cancellation to execution engines if needed
            // For now, just remove from our tracking
            
            return {
                success: true,
                executionId,
                action: 'interrupted'
            };

        } catch (error) {
            this.logger.error(`[ExecutionCoordinator] Failed to cancel execution ${executionId}`, error instanceof Error ? error : undefined, { executionId });
            return {
                success: false,
                executionId,
                action: 'failed',
                errorMessage: error instanceof Error ? error.message : 'Unknown cancellation error'
            };
        }
    }

    /**
     * Get current coordination state
     */
    async getState(): Promise<ExecutionCoordinatorState> {
        return { ...this.state }; // Return copy to prevent external mutation
    }

    /**
     * Get queue position for a specific execution
     * Returns null since we no longer use queuing - executions start immediately 
     */
    async getQueuePosition(executionId: string): Promise<number | null> {
        return null; // No queuing in new architecture
    }

    /**
     * Check if system can accept new executions
     */
    async canAcceptExecution(): Promise<boolean> {
        // System can always accept executions (coordinator manages queuing)
        return true;
    }

    // (Issue #313: startup recovery moved to StartupRecoveryService — this one called a
    // getAllExecutions that never existed, so it recovered nothing.)

    /**
     * Get execution engine configuration
     */
    getEngineConfig(engineType: ExecutionEngineType): ExecutionEngineConfig {
        const config = this.engineConfigs.get(engineType);
        if (!config) {
            throw new Error(`No configuration found for engine type: ${engineType}`);
        }
        return { ...config }; // Return copy to prevent mutation
    }

    /**
     * Update execution state and coordinate status bar display
     */
    async updateExecutionState(executionId: string, metadata: ExecutionMetadata): Promise<void> {
        const executionType: ExecutionEngineType = metadata.executionType === 'batch' ? 'batch' : 'individual';
        
        
        // Update or create tracked execution state
        const trackedState: TrackedExecutionState = {
            executionId,
            executionType,
            status: metadata.status,
            metadata,
            startedAt: this.state.activeExecutions!.get(executionId)?.startedAt || new Date(),
            lastUpdated: new Date()
        };

        this.state.activeExecutions!.set(executionId, trackedState);

        // Update active execution lists
        if (executionType === 'batch') {
            if (metadata.status === 'running' || metadata.status === 'pending') {
                this.state.activeBatchId = executionId;
            } else if (this.state.activeBatchId === executionId) {
                this.state.activeBatchId = null;
                // Status bar surface removed; UI updates now flow through the
                // Hub activity chip + per-tab progress (hub-activity.js).
            }
        } else {
            // Individual execution
            if (metadata.status === 'running') {
                if (!this.state.activeIndividualIds!.includes(executionId)) {
                    this.state.activeIndividualIds!.push(executionId);
                }
            } else {
                this.state.activeIndividualIds = this.state.activeIndividualIds!.filter(id => id !== executionId);
            }
        }
    }

    /**
     * Remove execution from tracking
     */
    async removeExecution(executionId: string): Promise<void> {
        const trackedState = this.state.activeExecutions!.get(executionId);
        if (!trackedState) {
            return; // Not tracked, nothing to remove
        }

        // Remove from tracking
        this.state.activeExecutions!.delete(executionId);

        // Update active lists
        if (this.state.activeBatchId === executionId) {
            this.state.activeBatchId = null;
        }
        this.state.activeIndividualIds = this.state.activeIndividualIds!.filter(id => id !== executionId);

        // System state management removed - coordination is now stateless
    }
}