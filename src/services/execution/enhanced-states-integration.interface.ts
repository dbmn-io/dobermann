// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Enhanced execution states integration service interface
 * Coordinates the use of new execution states (blocked, paused, skipped) across the system
 */

import { ExecutionState, ExecutionPriority } from '../../types/execution-state';
import { APIEndpointConfig } from '../../data-loading/types';

export interface StateTransitionContext {
    executionId: string;
    fromState: ExecutionState;
    toState: ExecutionState;
    reason?: string;
    timestamp: Date;
    userId?: string;
    batchId?: string;
}

export interface BlockedExecutionInfo {
    executionId: string;
    blockReason: string;
    blockedAt: Date;
    originalContent?: string;
    modifiedContent?: string;
    hashMismatch?: boolean;
    canResolve: boolean;
    resolutionOptions: string[];
}

export interface SkippedExecutionInfo {
    executionId: string;
    skipReason: string;
    skippedAt: Date;
    batchId?: string;
    wasManual: boolean;
    skipType: 'user' | 'error' | 'dependency' | 'condition';
}

export interface PausedExecutionInfo {
    executionId: string;
    pausedAt: Date;
    pauseReason: string;
    batchId?: string;
    canResume: boolean;
    estimatedResumeTime?: Date;
}

export interface StateIntegrationResult {
    success: boolean;
    executionId: string;
    newState: ExecutionState;
    previousState?: ExecutionState;
    actionsTaken: string[];
    errorMessage?: string;
    requiresUserAction?: boolean;
    nextSteps?: string[];
}

export interface IEnhancedStatesIntegrationService {
    /**
     * Handle transition to blocked state with appropriate actions
     */
    handleBlockedTransition(
        executionId: string, 
        blockReason: string, 
        context?: any
    ): Promise<StateIntegrationResult>;

    /**
     * Handle transition to paused state
     */
    handlePausedTransition(
        executionId: string, 
        pauseReason: string, 
        batchId?: string
    ): Promise<StateIntegrationResult>;

    /**
     * Handle transition to skipped state
     */
    handleSkippedTransition(
        executionId: string, 
        skipReason: string, 
        skipType: 'user' | 'error' | 'dependency' | 'condition',
        batchId?: string
    ): Promise<StateIntegrationResult>;

    /**
     * Resolve a blocked execution by regenerating hash or accepting changes
     */
    resolveBlockedExecution(
        executionId: string, 
        resolution: 'regenerate_hash' | 'accept_changes' | 'cancel'
    ): Promise<StateIntegrationResult>;

    /**
     * Resume a paused execution
     */
    resumePausedExecution(executionId: string): Promise<StateIntegrationResult>;

    /**
     * Get all executions in enhanced states
     */
    getExecutionsInEnhancedStates(): Promise<{
        blocked: BlockedExecutionInfo[];
        paused: PausedExecutionInfo[];
        skipped: SkippedExecutionInfo[];
    }>;

    /**
     * Get detailed information about a blocked execution
     */
    getBlockedExecutionInfo(executionId: string): Promise<BlockedExecutionInfo | null>;

    /**
     * Get detailed information about a paused execution
     */
    getPausedExecutionInfo(executionId: string): Promise<PausedExecutionInfo | null>;

    /**
     * Get detailed information about a skipped execution
     */
    getSkippedExecutionInfo(executionId: string): Promise<SkippedExecutionInfo | null>;

    /**
     * Bulk resolve multiple blocked executions
     */
    bulkResolveBlockedExecutions(
        executionIds: string[], 
        resolution: 'regenerate_hash' | 'accept_changes' | 'cancel'
    ): Promise<Map<string, StateIntegrationResult>>;

    /**
     * Auto-resolve blocked executions based on rules
     */
    autoResolveBlockedExecutions(
        rules: {
            maxAge?: number; // milliseconds
            autoAcceptMinorChanges?: boolean;
            autoRegenerateHashOnWhitespaceChanges?: boolean;
        }
    ): Promise<StateIntegrationResult[]>;

    /**
     * Validate state transition is allowed
     */
    validateStateTransition(
        executionId: string, 
        fromState: ExecutionState, 
        toState: ExecutionState
    ): Promise<{ allowed: boolean; reason?: string }>;

    /**
     * Get state transition history for an execution
     */
    getStateTransitionHistory(executionId: string): Promise<StateTransitionContext[]>;

    /**
     * Handle batch-level state changes
     */
    handleBatchStateChange(
        batchId: string,
        newState: ExecutionState,
        affectedExecutions: string[]
    ): Promise<StateIntegrationResult[]>;

    /**
     * Clear transition history for given execution IDs (memory cleanup after batch completion)
     */
    clearHistory(executionIds: string[]): void;
}