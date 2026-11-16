// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionState, BatchState, EnhancedExecutionMetadata, StateTransition } from '../../types/execution-state';
import { ExecutionMetadata, BatchConfiguration } from '../../storage/execution-metadata';

/**
 * Result of state transition operation
 */
export interface StateTransitionResult {
    success: boolean;
    previousState?: ExecutionState | BatchState;
    newState?: ExecutionState | BatchState;
    errorMessage?: string;
}

/**
 * Result of execution state query
 */
export interface ExecutionStateResult {
    state?: ExecutionState;
    metadata: ExecutionMetadata | null;
}

/**
 * Result of batch creation
 */
export interface BatchCreationResult {
    success: boolean;
    batchId?: string;
    errorMessage?: string;
}

/**
 * Service for managing execution and batch states
 */
export interface IExecutionStateManagerService {
    /**
     * Validate if a state transition is allowed
     */
    validateStateTransition(from: ExecutionState, to: ExecutionState): Promise<StateTransition>;

    /**
     * Transition execution from one state to another
     */
    transitionExecutionState(executionId: string, newState: ExecutionState): Promise<StateTransitionResult>;

    /**
     * Get current execution state
     */
    getExecutionState(executionId: string): Promise<ExecutionStateResult>;

    /**
     * Create a new batch execution
     */
    createBatchExecution(
        batchId: string,
        environmentId: string,
        organizationId: string,
        batchConfig: BatchConfiguration
    ): Promise<BatchCreationResult>;

    /**
     * Update batch state
     */
    updateBatchState(batchId: string, newState: BatchState): Promise<StateTransitionResult>;

    /**
     * Get all executions in a specific state
     */
    getExecutionsByState(state: ExecutionState): Promise<ExecutionMetadata[]>;

    /**
     * Get all executions for a specific batch
     */
    getBatchExecutions(batchId: string): Promise<ExecutionMetadata[]>;

    /**
     * Mark execution as blocked due to modified request JSON
     */
    markExecutionAsBlocked(executionId: string, reason: string): Promise<StateTransitionResult>;

    /**
     * Clear blocked state and allow execution to proceed
     */
    clearBlockedState(executionId: string): Promise<StateTransitionResult>;
}