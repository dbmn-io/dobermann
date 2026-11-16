// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unified Execution Status System
 * 
 * This file replaces the dual enum system (ExecutionStatus + ExecutionState) 
 * with a single, type-safe, standardized status system.
 * 
 * Follows Architecture.md principles:
 * - Single source of truth for status values (Zod-first approach)
 * - Type safety with compile-time checking  
 * - Runtime validation with Zod schemas
 * - Easy to extend and maintain (no duplication)
 */

import { z } from 'zod';

/**
 * PRIMARY SOURCE OF TRUTH: Zod schema for execution status validation
 * 
 * Design principles:
 * - Lowercase string values for consistency with existing data
 * - All possible states included (base + enhanced Phase 2 states)
 * - Maps 1:1 with database storage (no dual mapping needed)
 * - Single definition prevents enum/schema sync issues
 */
export const UnifiedExecutionStatusSchema = z.enum([
    'preparing',  // Being created, not ready for execution (transaction preparation)
    'pending',    // Ready for execution, handed to ExecutionEngine
    'running',    // Currently executing
    'completed',  // Successfully completed
    'error',      // Failed with error
    'cancelled',  // User cancelled
    'warning',    // Completed with warnings
    'skipped',    // Skipped due to batch cancellation/stop-on-error
    'blocked',    // Blocked due to modified request JSON
    'paused',     // Paused during batch processing
    'split'       // GitHub Issue #74: Original transaction split into individual transactions
]);

/**
 * TypeScript type derived from Zod schema
 * Replaces both ExecutionStatus and ExecutionState types
 */
export type ExecutionStatusType = z.infer<typeof UnifiedExecutionStatusSchema>;

/**
 * Const object for enum-like access with IDE autocomplete
 * Provides the benefits of enums without duplication
 * 
 * Usage: ExecutionStatus.PREPARING instead of 'preparing'
 */
export const ExecutionStatus = {
    PREPARING: 'preparing',
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    ERROR: 'error',
    CANCELLED: 'cancelled',
    WARNING: 'warning',
    SKIPPED: 'skipped',
    BLOCKED: 'blocked',
    PAUSED: 'paused',
    SPLIT: 'split'
} as const satisfies Record<string, ExecutionStatusType>;

/**
 * PRIMARY SOURCE OF TRUTH: Zod schema for batch status validation
 * GitHub Issue #94 - 'preparing' removed: batches transition directly to PENDING after first chunk (2-3s)
 *
 * This is the single definition that all other batch status references derive from
 */
export const BatchStatusSchema = z.enum([
    'pending',
    'running',
    'completed',
    'cancelled',
    'stopped',
    'paused'
]);

/**
 * TypeScript type derived from Zod schema
 */
export type BatchStatusType = z.infer<typeof BatchStatusSchema>;

/**
 * Const object for enum-like access with IDE autocomplete
 * Derived from BatchStatusSchema to eliminate duplication
 * GitHub Issue #94 - PREPARING removed
 *
 * Usage: BatchStatus.PENDING instead of 'pending'
 */
export const BatchStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    STOPPED: 'stopped',
    PAUSED: 'paused'
} as const satisfies Record<string, BatchStatusType>;

/**
 * Test execution status - separate domain
 */
export enum TestStatus {
    NO_TESTS = 'no-tests',
    PENDING = 'pending',
    SKIPPED = 'skipped',
    PASSED = 'passed',
    FAILED = 'failed',
    ERROR = 'error'
}

/**
 * Zod schema for test status validation
 */
export const TestStatusSchema = z.enum([
    'no-tests',
    'pending',
    'skipped',
    'passed',
    'failed',
    'error'
]);

export type TestStatusType = z.infer<typeof TestStatusSchema>;

/**
 * Status groups for common filtering and logic
 */
export const StatusGroups = {
    /** States indicating execution is in progress */
    IN_PROGRESS: [
        ExecutionStatus.RUNNING,
        ExecutionStatus.PAUSED
    ] as const,

    /** States indicating execution is waiting */
    WAITING: [
        ExecutionStatus.PENDING,
        ExecutionStatus.BLOCKED
    ] as const,

    /** States indicating execution is finished (terminal states) */
    FINISHED: [
        ExecutionStatus.COMPLETED,
        ExecutionStatus.ERROR,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.SKIPPED,
        ExecutionStatus.WARNING
    ] as const,

    /** States that can be retried */
    RETRYABLE: [
        ExecutionStatus.ERROR,
        ExecutionStatus.BLOCKED,
        ExecutionStatus.CANCELLED
    ] as const,

    /** States that indicate success */
    SUCCESS: [
        ExecutionStatus.COMPLETED,
        ExecutionStatus.WARNING
    ] as const,

    /** States that indicate failure */
    FAILURE: [
        ExecutionStatus.ERROR,
        ExecutionStatus.CANCELLED
    ] as const
} as const;

/**
 * Helper functions for status checking
 * Replaces string literal comparisons throughout codebase
 */
export const StatusCheckers = {
    isInProgress: (status: ExecutionStatusType): boolean =>
        StatusGroups.IN_PROGRESS.includes(status as any),

    isWaiting: (status: ExecutionStatusType): boolean =>
        StatusGroups.WAITING.includes(status as any),

    isFinished: (status: ExecutionStatusType): boolean =>
        StatusGroups.FINISHED.includes(status as any),

    isRetryable: (status: ExecutionStatusType): boolean =>
        StatusGroups.RETRYABLE.includes(status as any),

    isSuccess: (status: ExecutionStatusType): boolean =>
        StatusGroups.SUCCESS.includes(status as any),

    isFailure: (status: ExecutionStatusType): boolean =>
        StatusGroups.FAILURE.includes(status as any),

    canTransitionTo: (from: ExecutionStatusType, to: ExecutionStatusType): boolean => {
        const transitions = VALID_STATUS_TRANSITIONS.get(from);
        return transitions ? transitions.includes(to) : false;
    }
};

/**
 * Valid status transitions - replaces state transition logic in execution-state-manager
 */
export const VALID_STATUS_TRANSITIONS = new Map<ExecutionStatusType, ExecutionStatusType[]>([
    [ExecutionStatus.PENDING, [
        ExecutionStatus.RUNNING,
        ExecutionStatus.BLOCKED,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.SKIPPED
    ]],
    [ExecutionStatus.RUNNING, [
        ExecutionStatus.COMPLETED,
        ExecutionStatus.ERROR,
        ExecutionStatus.WARNING,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.PAUSED
    ]],
    [ExecutionStatus.BLOCKED, [
        ExecutionStatus.PENDING,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.SKIPPED
    ]],
    [ExecutionStatus.PAUSED, [
        ExecutionStatus.RUNNING,
        ExecutionStatus.CANCELLED,
        ExecutionStatus.SKIPPED
    ]],
    [ExecutionStatus.ERROR, [
        ExecutionStatus.PENDING  // For retries
    ]],
    [ExecutionStatus.CANCELLED, [
        ExecutionStatus.PENDING  // For retries
    ]],
    // Terminal states - generally no transitions allowed
    [ExecutionStatus.COMPLETED, []],
    [ExecutionStatus.WARNING, []],
    [ExecutionStatus.SKIPPED, []]
]);

/**
 * Migration helpers for transitioning from old dual enum system
 * These can be removed after migration is complete
 */
export const MigrationHelpers = {
    /**
     * Maps old ExecutionState enum values to new unified status
     */
    fromExecutionState: (state: string): ExecutionStatusType => {
        const mapping: Record<string, ExecutionStatusType> = {
            'PENDING': ExecutionStatus.PENDING,
            'RUNNING': ExecutionStatus.RUNNING,
            'COMPLETED': ExecutionStatus.COMPLETED,
            'ERROR': ExecutionStatus.ERROR,
            'CANCELLED': ExecutionStatus.CANCELLED,
            'WARNING': ExecutionStatus.WARNING,
            'SKIPPED': ExecutionStatus.SKIPPED,
            'BLOCKED': ExecutionStatus.BLOCKED,
            'PAUSED': ExecutionStatus.PAUSED
        };
        return mapping[state] || ExecutionStatus.PENDING;
    },

    /**
     * Maps old ExecutionStatus string values to new unified status
     */
    fromExecutionStatus: (status: string): ExecutionStatusType => {
        // ExecutionStatus was already lowercase strings, so direct mapping
        if (UnifiedExecutionStatusSchema.safeParse(status).success) {
            return status as ExecutionStatusType;
        }
        return ExecutionStatus.PENDING;
    }
};

/**
 * Validation function for unified status
 */
export function validateUnifiedExecutionStatus(status: unknown): ExecutionStatusType {
    return UnifiedExecutionStatusSchema.parse(status);
}

/**
 * Type guard for unified execution status
 */
export function isValidUnifiedExecutionStatus(status: string): status is ExecutionStatusType {
    return UnifiedExecutionStatusSchema.safeParse(status).success;
}