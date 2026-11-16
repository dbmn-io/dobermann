// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    ExecutionState,
    BatchState,
    EnhancedExecutionMetadata,
    StateTransition,
    ExecutionPriority,
    migrateLegacyExecutionState,
    migrateLegacyBatchState
} from '../../types/execution-state';
import { ExecutionMetadata, BatchConfiguration, StatusHelpers } from '../../storage/execution-metadata';
import {
    ExecutionStatusType,
    BatchStatus,
    BatchStatusType,
    StatusCheckers,
    VALID_STATUS_TRANSITIONS,
    ExecutionStatus
} from '../../types/unified-execution-status';
import {
    IExecutionStateManagerService,
    StateTransitionResult,
    ExecutionStateResult,
    BatchCreationResult
} from './execution-state-manager.interface';
import { IExecutionMetadataService } from './execution-metadata.interface';

/**
 * Service for managing execution and batch states
 * 
 * MIGRATION: This service is being updated to use ExecutionStatusType
 * Legacy ExecutionState enum support is maintained for backward compatibility
 */
export class ExecutionStateManagerService implements IExecutionStateManagerService {
    private readonly validTransitions: Map<ExecutionState, ExecutionState[]>;

    // New unified status system - preferred for new code
    private readonly unifiedValidTransitions = VALID_STATUS_TRANSITIONS;

    constructor(private readonly metadataService: IExecutionMetadataService) {
        this.validTransitions = this.initializeValidTransitions();
    }

    /**
     * Initialize valid state transitions
     */
    private initializeValidTransitions(): Map<ExecutionState, ExecutionState[]> {
        const transitions = new Map<ExecutionState, ExecutionState[]>();

        transitions.set(ExecutionState.PENDING, [
            ExecutionState.RUNNING,
            ExecutionState.BLOCKED,
            ExecutionState.CANCELLED,
            ExecutionState.SKIPPED
        ]);

        transitions.set(ExecutionState.RUNNING, [
            ExecutionState.COMPLETED,
            ExecutionState.ERROR,
            ExecutionState.CANCELLED,
            ExecutionState.PAUSED
        ]);

        transitions.set(ExecutionState.BLOCKED, [
            ExecutionState.PENDING,
            ExecutionState.CANCELLED
        ]);

        transitions.set(ExecutionState.PAUSED, [
            ExecutionState.RUNNING,
            ExecutionState.CANCELLED
        ]);

        // Terminal states (no transitions allowed)
        transitions.set(ExecutionState.COMPLETED, []);
        transitions.set(ExecutionState.ERROR, []);
        transitions.set(ExecutionState.CANCELLED, []);
        transitions.set(ExecutionState.SKIPPED, []);

        return transitions;
    }

    /**
     * Validate if a state transition is allowed
     */
    async validateStateTransition(from: ExecutionState, to: ExecutionState): Promise<StateTransition> {
        // Check if from state is known
        if (!this.validTransitions.has(from)) {
            return {
                from,
                to,
                allowed: false,
                reason: `Unknown state: ${from}`
            };
        }

        const allowedTransitions = this.validTransitions.get(from)!;
        const allowed = allowedTransitions.includes(to);

        return {
            from,
            to,
            allowed,
            reason: allowed ? undefined : `Invalid transition from ${from} to ${to}`
        };
    }

    /**
     * @deprecated Use unified status system instead
     * Map ExecutionState to ExecutionStatus - Legacy support
     */
    private mapExecutionStateToStatus(state: ExecutionState): ExecutionStatusType {
        // Direct mapping using unified system
        return migrateLegacyExecutionState(state);
    }

    /**
     * @deprecated Use unified status system instead  
     * Map ExecutionStatus to ExecutionState - Legacy support
     */
    private mapExecutionStatusToState(status: string): ExecutionState {
        // Direct mapping - no complex logic needed with unified system
        return status as ExecutionState;
    }

    /**
     * NEW: Unified status transition validation
     * Replaces complex dual mapping system
     */
    private validateUnifiedStatusTransition(executionType: string, from: string, to: string): boolean {
        // Use context-dependent validation
        const fromValid = StatusHelpers.isValidStatus(executionType as any, from);
        const toValid = StatusHelpers.isValidStatus(executionType as any, to);

        if (!fromValid || !toValid) {
            return false;
        }

        // For now, allow all valid status transitions - can add specific transition rules later
        return true;
    }

    /**
     * NEW: Transition execution using unified status system
     * Preferred method for new code
     */
    async transitionExecutionStatusType(executionId: string, newStatus: ExecutionStatusType): Promise<StateTransitionResult> {
        try {
            // Get current execution metadata
            const currentMetadata = await this.metadataService.getExecution(executionId);
            if (!currentMetadata) {
                return {
                    success: false,
                    errorMessage: `Execution not found: ${executionId}`
                };
            }

            // Validate status transition using unified system
            const currentStatus = currentMetadata.status;
            if (!this.validateUnifiedStatusTransition(currentMetadata.executionType, currentStatus, newStatus)) {
                return {
                    success: false,
                    errorMessage: `Invalid status transition from ${currentStatus} to ${newStatus}`
                };
            }

            // Update execution status directly (no mapping needed)
            const updates: Partial<ExecutionMetadata> = {
                status: newStatus,
                ...(newStatus === ExecutionStatus.RUNNING && { startedAt: new Date() }),
                ...(StatusCheckers.isFinished(newStatus) && { completedAt: new Date() })
            };

            await this.metadataService.updateExecution(executionId, updates);

            return {
                success: true,
                previousState: currentStatus as ExecutionState, // Legacy compatibility
                newState: newStatus as ExecutionState // Legacy compatibility
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to transition status: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Transition execution from one state to another
     */
    /**
     * @deprecated Use transitionExecutionStatusType instead
     * Legacy method maintained for backward compatibility
     */
    async transitionExecutionState(executionId: string, newState: ExecutionState): Promise<StateTransitionResult> {
        // Delegate to unified status method
        return this.transitionExecutionStatusType(executionId, migrateLegacyExecutionState(newState));
    }

    /**
     * @deprecated Legacy implementation - kept for reference
     * Use transitionExecutionStatusType for new code
     */
    private async legacyTransitionExecutionState(executionId: string, newState: ExecutionState): Promise<StateTransitionResult> {
        try {
            // Get current execution metadata
            const currentMetadata = await this.metadataService.getExecution(executionId);
            if (!currentMetadata) {
                return {
                    success: false,
                    errorMessage: `Execution not found: ${executionId}`
                };
            }

            // Map current status to state for validation
            const currentState = this.mapExecutionStatusToState(currentMetadata.status);

            // Validate state transition
            const transitionValidation = await this.validateStateTransition(currentState, newState);
            if (!transitionValidation.allowed) {
                return {
                    success: false,
                    errorMessage: `Invalid state transition: ${transitionValidation.reason}`
                };
            }

            // Map new state to status for storage
            const newStatus = this.mapExecutionStateToStatus(newState);

            // Update execution state
            const updates: Partial<ExecutionMetadata> = {
                status: newStatus,
                ...(newState === ExecutionState.RUNNING && { startedAt: new Date() }),
                ...(newState === ExecutionState.COMPLETED && { completedAt: new Date() })
            };

            await this.metadataService.updateExecution(executionId, updates);

            return {
                success: true,
                previousState: currentState,
                newState: newState
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to transition state: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Get current execution state
     */
    async getExecutionState(executionId: string): Promise<ExecutionStateResult> {
        try {
            const metadata = await this.metadataService.getExecution(executionId);
            return {
                state: metadata ? this.mapExecutionStatusToState(metadata.status) : undefined,
                metadata: metadata
            };
        } catch (error) {
            return {
                state: undefined,
                metadata: null
            };
        }
    }

    /**
     * Create a new batch execution
     */
    async createBatchExecution(
        batchId: string,
        environmentId: string,
        organizationId: string,
        batchConfig: BatchConfiguration
    ): Promise<BatchCreationResult> {
        try {
            // For now, we'll create a simple batch execution record
            // In a real implementation, this would be stored in a separate batch table
            const batchEndpointConfig = {
                id: batchId,
                name: `Batch ${batchId}`,
                path: '/batch',
                method: 'POST' as const,
                headers: {},
                body: JSON.stringify(batchConfig),
                queryParams: {},
                folder: 'batch'
            };

            const executionId = await this.metadataService.createExecution(batchEndpointConfig);

            return {
                success: true,
                batchId: executionId
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to create batch: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Update batch state
     */
    async updateBatchState(batchId: string, newState: BatchState): Promise<StateTransitionResult> {
        try {
            const batchMetadata = await this.metadataService.getExecution(batchId);
            if (!batchMetadata) {
                return {
                    success: false,
                    errorMessage: `Batch not found: ${batchId}`
                };
            }

            // Map BatchState to ExecutionState
            const executionState = this.mapBatchStateToExecutionState(newState);
            const currentState = this.mapExecutionStatusToState(batchMetadata.status);

            // Validate transition
            const transitionValidation = await this.validateStateTransition(currentState, executionState);
            if (!transitionValidation.allowed) {
                return {
                    success: false,
                    errorMessage: `Invalid batch state transition: ${transitionValidation.reason}`
                };
            }

            // Update batch state
            const updates: Partial<ExecutionMetadata> = {
                status: this.mapExecutionStateToStatus(executionState)
            };

            await this.metadataService.updateExecution(batchId, updates);

            return {
                success: true,
                previousState: this.mapExecutionStateToBatchState(currentState),
                newState: newState
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to update batch state: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Get all executions in a specific state
     */
    async getExecutionsByState(state: ExecutionState): Promise<ExecutionMetadata[]> {
        try {
            // This would need to be implemented based on the metadata service capabilities
            // For now, returning empty array as placeholder
            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Get all executions for a specific batch
     */
    async getBatchExecutions(batchId: string): Promise<ExecutionMetadata[]> {
        try {
            // This would need to be implemented based on the metadata service capabilities
            // For now, returning empty array as placeholder
            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Mark execution as blocked due to modified request JSON
     */
    async markExecutionAsBlocked(executionId: string, reason: string): Promise<StateTransitionResult> {
        try {
            const result = await this.transitionExecutionState(executionId, ExecutionState.BLOCKED);
            if (result.success) {
                // Update error message with block reason
                const updates: Partial<ExecutionMetadata> = {
                    errorMessage: `BLOCKED: ${reason}`
                };
                await this.metadataService.updateExecution(executionId, updates);
            }
            return result;
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to mark as blocked: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Clear blocked state and allow execution to proceed
     */
    async clearBlockedState(executionId: string): Promise<StateTransitionResult> {
        try {
            const result = await this.transitionExecutionState(executionId, ExecutionState.PENDING);
            if (result.success) {
                // Clear error message
                const updates: Partial<ExecutionMetadata> = {
                    errorMessage: undefined
                };
                await this.metadataService.updateExecution(executionId, updates);
            }
            return result;
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to clear blocked state: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Generate hash for batch configuration
     */
    private generateBatchHash(batchId: string, batchConfig: BatchConfiguration): string {
        // Simple hash generation - in real implementation, use proper hashing
        return `batch-${batchId}-${JSON.stringify(batchConfig)}`;
    }

    /**
     * Map BatchState to ExecutionState
     */
    private mapBatchStateToExecutionState(batchState: BatchState): ExecutionState {
        switch (batchState) {
            case BatchState.PENDING:
                return ExecutionState.PENDING;
            case BatchState.RUNNING:
                return ExecutionState.RUNNING;
            case BatchState.COMPLETED:
                return ExecutionState.COMPLETED;
            case BatchState.CANCELLED:
                return ExecutionState.CANCELLED;
            case BatchState.STOPPED:
                return ExecutionState.ERROR;
            case BatchState.PAUSED:
                return ExecutionState.PAUSED;
            default:
                return ExecutionState.PENDING;
        }
    }

    /**
     * Map ExecutionState to BatchState
     */
    private mapExecutionStateToBatchState(executionState: ExecutionState): BatchState {
        switch (executionState) {
            case ExecutionState.PENDING:
                return BatchState.PENDING;
            case ExecutionState.RUNNING:
                return BatchState.RUNNING;
            case ExecutionState.COMPLETED:
                return BatchState.COMPLETED;
            case ExecutionState.CANCELLED:
                return BatchState.CANCELLED;
            case ExecutionState.ERROR:
                return BatchState.STOPPED;
            case ExecutionState.PAUSED:
                return BatchState.PAUSED;
            default:
                return BatchState.PENDING;
        }
    }
}