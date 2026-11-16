// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata } from '../../storage/execution-metadata';
import { ExecutionPriority } from '../../types/execution-state';
import { ExecutionStatusType, ExecutionStatus } from '../../types/unified-execution-status';

/**
 * Unified response interface for both individual "Run API" and "Run with CSV" operations
 * Following execution-user-flows.md - provides consistent UX pattern
 */
export interface RunAPIResponse {
    /** 
     * Execution ID for individual executions or batch ID for batch executions
     */
    executionId: string;

    /**
     * Current execution status - using unified status system
     */
    status: ExecutionStatusType;

    /**
     * Position in execution queue (if queued)
     */
    queuePosition?: number;

    /**
     * Estimated wait time (human readable)
     */
    estimatedWait?: string;

    /**
     * Full execution metadata record
     */
    execution: ExecutionMetadata;

    /**
     * Priority level assigned to this execution
     */
    priority?: ExecutionPriority;
}

/**
 * Unified response interface for batch operations ("Run with CSV")
 * Extends RunAPIResponse with batch-specific information
 */
export interface RunBatchResponse extends RunAPIResponse {
    /**
     * Batch ID (same as executionId for batch operations)
     */
    batchId: string;

    /**
     * Number of transactions in the batch
     */
    transactionCount: number;

    /**
     * Batch preparation metadata
     */
    batchMetadata: ExecutionMetadata;

    /**
     * Progress information for batch execution
     */
    progress?: {
        completed: number;
        total: number;
        failed: number;
        percentage: number;
    };
}

/**
 * Factory function to create RunAPIResponse for individual executions
 */
export function createRunAPIResponse(
    executionId: string,
    status: ExecutionStatusType,
    execution: ExecutionMetadata,
    options?: {
        queuePosition?: number;
        estimatedWait?: string;
        priority?: ExecutionPriority;
    }
): RunAPIResponse {
    return {
        executionId,
        status,
        execution,
        queuePosition: options?.queuePosition,
        estimatedWait: options?.estimatedWait,
        priority: options?.priority
    };
}

/**
 * Factory function to create RunBatchResponse for batch executions
 */
export function createRunBatchResponse(
    batchId: string,
    status: ExecutionStatusType,
    execution: ExecutionMetadata,
    transactionCount: number,
    batchMetadata: ExecutionMetadata,
    options?: {
        queuePosition?: number;
        estimatedWait?: string;
        priority?: ExecutionPriority;
        progress?: {
            completed: number;
            total: number;
            failed: number;
            percentage: number;
        };
    }
): RunBatchResponse {
    return {
        executionId: batchId,
        batchId,
        status,
        execution,
        transactionCount,
        batchMetadata,
        queuePosition: options?.queuePosition,
        estimatedWait: options?.estimatedWait,
        priority: options?.priority,
        progress: options?.progress
    };
}

/**
 * Button state calculation from RunAPIResponse
 * Following execution-user-flows.md button state management patterns
 */
export interface ButtonState {
    text: string;
    enabled: boolean;
    variant: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
    showDropdown: boolean;
    dropdownActions: ButtonAction[];
}

export interface ButtonAction {
    id: string;
    label: string;
    enabled: boolean;
    icon?: string;
}

/**
 * Calculate button state from RunAPIResponse
 * Implements unified button state management from execution-user-flows.md
 */
export function calculateButtonState(
    response: RunAPIResponse,
    buttonType: 'run-api' | 'run-with-csv' = 'run-api'
): ButtonState {
    const baseText = buttonType === 'run-api' ? 'Run API' : 'Run with CSV';

    switch (response.status) {
        case ExecutionStatus.RUNNING:
            return {
                text: 'Cancel',
                enabled: true,
                variant: 'danger',
                showDropdown: true,
                dropdownActions: [
                    { id: 'cancel', label: 'Cancel', enabled: true, icon: 'stop' },
                    { id: 'view-execution', label: 'View Execution', enabled: true, icon: 'eye' }
                ]
            };

        case ExecutionStatus.PENDING: // 'queued' maps to PENDING
            return {
                text: response.queuePosition ? `Queued (${response.queuePosition})` : 'Queued',
                enabled: true,
                variant: 'warning',
                showDropdown: true,
                dropdownActions: [
                    { id: 'cancel', label: 'Cancel', enabled: true, icon: 'stop' },
                    { id: 'view-execution', label: 'View Execution', enabled: true, icon: 'eye' },
                    { id: 'prioritize', label: 'Prioritize', enabled: true, icon: 'arrow-up' }
                ]
            };

        case ExecutionStatus.COMPLETED:
            return {
                text: baseText,
                enabled: true,
                variant: 'success',
                showDropdown: true,
                dropdownActions: [
                    { id: 'rerun', label: 'Rerun', enabled: true, icon: 'refresh' },
                    { id: 'view-execution', label: 'View Execution', enabled: true, icon: 'eye' },
                    { id: 'delete', label: 'Delete', enabled: true, icon: 'trash' }
                ]
            };

        case ExecutionStatus.ERROR:
            return {
                text: baseText,
                enabled: true,
                variant: 'danger',
                showDropdown: true,
                dropdownActions: [
                    { id: 'rerun', label: 'Rerun', enabled: true, icon: 'refresh' },
                    { id: 'view-execution', label: 'View Execution', enabled: true, icon: 'eye' },
                    { id: 'delete', label: 'Delete', enabled: true, icon: 'trash' }
                ]
            };

        default:
            return {
                text: baseText,
                enabled: true,
                variant: 'primary',
                showDropdown: true,
                dropdownActions: [
                    { id: 'run', label: 'Run', enabled: true, icon: 'play' }
                ]
            };
    }
}

/**
 * Convert ExecutionEngine responses to RunAPIResponse
 * Bridges ExecutionEngine interface with unified response format
 */
export function fromScheduleExecutionResponse(
    response: any,
    priority: ExecutionPriority = ExecutionPriority.URGENT
): RunAPIResponse {
    return createRunAPIResponse(
        response.executionId,
        response.status,
        response.execution,
        {
            queuePosition: response.queuePosition,
            estimatedWait: response.estimatedWait,
            priority
        }
    );
}

/**
 * Convert ExecutionEngine batch responses to RunBatchResponse
 */
export function fromScheduleBatchResponse(
    response: any,
    priority: ExecutionPriority = ExecutionPriority.NORMAL
): RunBatchResponse {
    return createRunBatchResponse(
        response.batchId,
        response.status,
        response.batchMetadata,
        response.transactionCount,
        response.batchMetadata,
        {
            queuePosition: response.queuePosition,
            estimatedWait: response.estimatedWait,
            priority
        }
    );
}