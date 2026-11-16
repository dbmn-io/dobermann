// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution-Specific Message Types
 *
 * Defines standardized messages for execution service communication.
 * Relocated from src/messaging/execution-messages.ts (GitHub Issue #194).
 */

import {
    BaseMessage,
    RequestMessage,
    ResponseMessage,
    EventMessage
} from './base-message';
import { APIEndpointConfig } from '../data-loading/types';
import { ExecutionOptions } from '../services/execution/execution.interface';
import { ExecutionMetadata, ExecutionFilters } from '../storage/execution-metadata';

// ============================================================================
// Execution Request Messages
// ============================================================================

/**
 * Execute endpoint request
 */
export interface ExecuteEndpointRequest extends RequestMessage {
    type: 'execution.execute';
    payload: {
        endpointConfig: APIEndpointConfig;
        executionOptions: ExecutionOptions;
        correlationId?: string;
    };
}

/**
 * Validate execution request
 */
export interface ValidateExecutionRequest extends RequestMessage {
    type: 'execution.validate';
    payload: {
        endpointConfig: APIEndpointConfig;
        executionOptions: ExecutionOptions;
    };
}

/**
 * Cancel execution request
 */
export interface CancelExecutionRequest extends RequestMessage {
    type: 'execution.cancel';
    payload: {
        executionId: string;
    };
}

/**
 * Get execution status request
 */
export interface GetExecutionStatusRequest extends RequestMessage {
    type: 'execution.getStatus';
    payload: {
        executionId: string;
    };
}

/**
 * Retry execution request
 */
export interface RetryExecutionRequest extends RequestMessage {
    type: 'execution.retry';
    payload: {
        executionId: string;
        retryOptions?: ExecutionOptions;
    };
}

/**
 * Get execution table request
 */
export interface GetExecutionTableRequest extends RequestMessage {
    type: 'execution.getTable';
    payload: {
        page?: number;
        pageSize?: number;
        filters?: ExecutionFilters;
    };
}

/**
 * Get execution stats request
 */
export interface GetExecutionStatsRequest extends RequestMessage {
    type: 'execution.getStats';
    payload?: {
        dateRange?: {
            start: Date;
            end: Date;
        };
    };
}

/**
 * Delete execution request
 */
export interface DeleteExecutionRequest extends RequestMessage {
    type: 'execution.delete';
    payload: {
        executionId: string;
    };
}

// ============================================================================
// File Operation Request Messages
// ============================================================================

/**
 * Create result files request
 */
export interface CreateResultFilesRequest extends RequestMessage {
    type: 'file.createResults';
    payload: {
        response: Record<string, unknown>;
        endpointConfig: APIEndpointConfig;
        duration: number;
        executionId: string;
    };
}

/**
 * Open files request
 */
export interface OpenFilesRequest extends RequestMessage {
    type: 'file.openFiles';
    payload: {
        filePaths: string[];
        autoOpen: boolean;
    };
}

/**
 * Generate file name request
 */
export interface GenerateFileNameRequest extends RequestMessage {
    type: 'file.generateName';
    payload: {
        endpointConfig: APIEndpointConfig;
        fileType: string;
        executionId: string;
    };
}

// ============================================================================
// Response Messages
// ============================================================================

/**
 * Execution result response
 */
export interface ExecutionResultResponse extends ResponseMessage {
    data?: {
        executionId: string;
        status: string;
        startTime: number;
        endTime?: number;
        duration?: number;
        result?: Record<string, unknown>;
        error?: Record<string, unknown>;
        files?: {
            requestFile?: string;
            responseFile?: string;
        };
    };
}

/**
 * Validation result response
 */
export interface ValidationResultResponse extends ResponseMessage {
    data?: {
        canExecute: boolean;
        jwtValid: boolean;
        orgValid: boolean;
        locValid: boolean;
        environmentValid: boolean;
        error?: string;
        warnings?: string[];
    };
}

/**
 * Execution status response
 */
export interface ExecutionStatusResponse extends ResponseMessage {
    data?: {
        executionId: string;
        status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
        progress?: number;
        startTime?: number;
        endTime?: number;
        error?: string;
    };
}

/**
 * Execution table response
 */
export interface ExecutionTableResponse extends ResponseMessage {
    data?: {
        executions: ExecutionMetadata[];
        totalCount: number;
        page: number;
        pageSize: number;
        totalPages: number;
    };
}

/**
 * Execution stats response
 */
export interface ExecutionStatsResponse extends ResponseMessage {
    data?: {
        total: number;
        completed: number;
        pending: number;
        running: number;
        error: number;
        cancelled: number;
        avgDuration: number;
        successRate: number;
    };
}

/**
 * File creation response
 */
export interface FileCreationResponse extends ResponseMessage {
    data?: {
        requestFile: string;
        responseFile: string;
        success: boolean;
    };
}

/**
 * File name generation response
 */
export interface FileNameResponse extends ResponseMessage {
    data?: {
        fileName: string;
        filePath: string;
    };
}

// ============================================================================
// Event Messages
// ============================================================================

/**
 * Execution started event
 */
export interface ExecutionStartedEvent extends EventMessage {
    type: 'execution.started';
    category: 'execution';
    payload: {
        executionId: string;
        endpointName: string;
        startTime: number;
        correlationId?: string;
    };
}

/**
 * Execution progress event
 */
export interface ExecutionProgressEvent extends EventMessage {
    type: 'execution.progress';
    category: 'execution';
    payload: {
        executionId: string;
        progress: number;
        stage: string;
        message?: string;
    };
}

/**
 * Execution completed event
 */
export interface ExecutionCompletedEvent extends EventMessage {
    type: 'execution.completed';
    category: 'execution';
    payload: {
        executionId: string;
        status: 'completed' | 'error' | 'cancelled';
        duration: number;
        endTime: number;
        success: boolean;
        error?: string;
        files?: {
            requestFile?: string;
            responseFile?: string;
        };
    };
}

/**
 * Execution error event
 */
export interface ExecutionErrorEvent extends EventMessage {
    type: 'execution.error';
    category: 'error';
    severity: 'high';
    payload: {
        executionId: string;
        error: string;
        stage: string;
        timestamp: number;
        details?: Record<string, unknown>;
    };
}

/**
 * Validation warning event
 */
export interface ValidationWarningEvent extends EventMessage {
    type: 'validation.warning';
    category: 'validation';
    severity: 'medium';
    payload: {
        warning: string;
        endpointId: string;
        details?: Record<string, unknown>;
    };
}

/**
 * File operation event
 */
export interface FileOperationEvent extends EventMessage {
    type: 'file.operation';
    category: 'file-operation';
    payload: {
        operation: 'created' | 'opened' | 'deleted';
        fileName: string;
        filePath: string;
        executionId?: string;
        success: boolean;
        error?: string;
    };
}

/**
 * System status event
 */
export interface SystemStatusEvent extends EventMessage {
    type: 'system.status';
    category: 'system';
    payload: {
        status: 'online' | 'offline' | 'busy' | 'error';
        timestamp: number;
        details?: Record<string, unknown>;
    };
}

// ============================================================================
// Message Type Guards
// ============================================================================

export function isExecuteEndpointRequest(message: BaseMessage): message is ExecuteEndpointRequest {
    return message.type === 'execution.execute';
}

export function isValidateExecutionRequest(message: BaseMessage): message is ValidateExecutionRequest {
    return message.type === 'execution.validate';
}

export function isCancelExecutionRequest(message: BaseMessage): message is CancelExecutionRequest {
    return message.type === 'execution.cancel';
}

export function isGetExecutionStatusRequest(message: BaseMessage): message is GetExecutionStatusRequest {
    return message.type === 'execution.getStatus';
}

export function isExecutionStartedEvent(message: BaseMessage): message is ExecutionStartedEvent {
    return message.type === 'execution.started';
}

export function isExecutionCompletedEvent(message: BaseMessage): message is ExecutionCompletedEvent {
    return message.type === 'execution.completed';
}

export function isExecutionErrorEvent(message: BaseMessage): message is ExecutionErrorEvent {
    return message.type === 'execution.error';
}

export function isFileOperationEvent(message: BaseMessage): message is FileOperationEvent {
    return message.type === 'file.operation';
}

export function isGetExecutionTableRequest(message: BaseMessage): message is GetExecutionTableRequest {
    return message.type === 'execution.getTable';
}

// ============================================================================
// Message Constants
// ============================================================================

export const ExecutionMessageTypes = {
    // Request types
    EXECUTE_ENDPOINT: 'execution.execute',
    VALIDATE_EXECUTION: 'execution.validate',
    CANCEL_EXECUTION: 'execution.cancel',
    GET_EXECUTION_STATUS: 'execution.getStatus',
    RETRY_EXECUTION: 'execution.retry',
    GET_EXECUTION_TABLE: 'execution.getTable',
    GET_EXECUTION_STATS: 'execution.getStats',
    DELETE_EXECUTION: 'execution.delete',

    // File operation types
    CREATE_RESULT_FILES: 'file.createResults',
    OPEN_FILES: 'file.openFiles',
    GENERATE_FILE_NAME: 'file.generateName',

    // Event types
    EXECUTION_STARTED: 'execution.started',
    EXECUTION_PROGRESS: 'execution.progress',
    EXECUTION_COMPLETED: 'execution.completed',
    EXECUTION_ERROR: 'execution.error',
    VALIDATION_WARNING: 'validation.warning',
    FILE_OPERATION: 'file.operation',
    SYSTEM_STATUS: 'system.status'
} as const;

export type ExecutionMessageType = typeof ExecutionMessageTypes[keyof typeof ExecutionMessageTypes];
