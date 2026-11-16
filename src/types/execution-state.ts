// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution state management types for Phase 2
 * Enhanced execution states with queue management and batch processing
 * 
 * MIGRATION NOTE: ExecutionState enum is DEPRECATED - use ExecutionStatusType instead
 */

import { ExecutionMetadata as BaseExecutionMetadata } from '../storage/execution-metadata';
import {
    ExecutionStatusType,
    BatchStatusType,
} from './unified-execution-status';

/**
 * @deprecated Use ExecutionStatusType from './unified-execution-status' instead
 * This enum is kept for backward compatibility during migration
 * 
 * Enhanced execution states including new states for Phase 2
 * Extends the existing ExecutionStatus enum
 */
export enum ExecutionState {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    WARNING = 'warning',      // New: API responded with 3xx status
    ERROR = 'error',
    CANCELLED = 'cancelled',
    SKIPPED = 'skipped',      // New: Skipped due to batch cancellation/stop-on-error
    BLOCKED = 'blocked',      // New: Blocked due to modified request JSON
    PAUSED = 'paused'         // New: Paused during batch processing
}

/**
 * @deprecated Use ExecutionStatusType from './unified-execution-status' instead
 * Migration helper to convert ExecutionState to ExecutionStatusType
 */
export function migrateLegacyExecutionState(state: ExecutionState): ExecutionStatusType {
    // Direct mapping since values are the same
    return state as ExecutionStatusType;
}

/**
 * @deprecated Use BatchStatus from './unified-execution-status' instead
 * This enum is kept for backward compatibility during migration
 * 
 * Batch execution states
 */
export enum BatchState {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    CANCELLED = 'cancelled',
    STOPPED = 'stopped',      // Stopped due to error
    PAUSED = 'paused'         // Paused for individual execution
}

/**
 * @deprecated Use BatchStatus from './unified-execution-status' instead
 * Migration helper to convert BatchState to BatchStatus
 */
export function migrateLegacyBatchState(state: BatchState): BatchStatusType {
    return state as BatchStatusType;
}

/**
 * Execution priority levels for queue management
 */
export enum ExecutionPriority {
    LOW = 'low',
    NORMAL = 'normal',
    HIGH = 'high',
    URGENT = 'urgent'         // For individual executions that jump the queue
}

/**
 * REMOVED: BatchMetadata, BatchConfiguration, and BatchResumptionData
 * 
 * These types have been replaced by the unified ExecutionMetadata model.
 * See /src/storage/execution-metadata.ts for the new Zod schemas:
 * - BatchConfigurationSchema
 * - BatchResumptionDataSchema
 * - ExecutionMetadataSchema (with executionType, rows, batchConfiguration, batchResumptionData)
 */

/**
 * Enhanced execution metadata with hash validation
 * Extends the existing ExecutionMetadata with Phase 2 fields
 */
export interface EnhancedExecutionMetadata extends BaseExecutionMetadata {
    priority: ExecutionPriority;
    requestHash: string;        // Hash of request JSON for validation
    requestFilePath: string;
    responseFilePath?: string;
    updatedAt: Date;
    organizationId?: string;    // Make it optional to match base type
}

/**
 * Queue item for execution processing
 */
export interface ExecutionQueueItem {
    executionId: string;
    priority: ExecutionPriority;
    queuedAt: Date;
    scheduledAt?: Date;
    metadata: EnhancedExecutionMetadata;
}

/**
 * State transition validation
 */
export interface StateTransition {
    from: ExecutionState;
    to: ExecutionState;
    allowed: boolean;
    reason?: string;
}

/**
 * Queue management events
 */
export interface QueueEvent {
    type: 'added' | 'removed' | 'prioritized' | 'executed' | 'failed';
    executionId: string;
    timestamp: Date;
    details?: any;
}