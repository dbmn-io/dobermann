// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * IndividualExecutionEngine Interface
 * 
 * Handles individual execution processing with priority support.
 * Unlike batch executions, individual executions are non-interruptible and
 * have high priority for system responsiveness.
 */

export interface IndividualExecutionState {
    executionId: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    startedAt: Date;
    completedAt?: Date;
    priority: 'HIGH' | 'URGENT';
    errorMessage?: string;
}

export interface IndividualProgressCallback {
    onExecutionStarted?: (executionId: string, priority: string) => Promise<void>;
    onExecutionCompleted?: (executionId: string, result: IndividualExecutionResult) => Promise<void>;
}

export interface IndividualExecutionResult {
    success: boolean;
    executionId: string;
    duration: number;
    httpStatus?: number;
    httpStatusText?: string;
    errorMessage?: string;
}

import type { IExecutionProgressSink } from '../../platform/interfaces/execution-progress-sink.interface';

export interface IndividualExecutionEngineDependencies {
    executionMetadataService: {
        getExecution: (executionId: string) => Promise<any>;
        updateExecution: (executionId: string, updates: any) => Promise<void>;
    };
    executionService: {
        executeRecord: (executionId: string) => Promise<any>;
    };
    executionCoordinator?: {
        completeExecution: (executionId: string) => Promise<void>;
    };
    /** Issue #320: opens the run's Console and sends it status updates. */
    progressSink: Pick<IExecutionProgressSink, 'openConsole' | 'status'>;
    /** #359: after a 401, new credentials for the environment (its id, or a single run's name for it) without asking (true: send again). */
    refreshCredentials?: (environmentId: string) => Promise<boolean>;
}

export interface IIndividualExecutionEngine {
    /**
     * Execute an individual execution with high priority
     */
    executeIndividual(executionId: string, progressCallback?: IndividualProgressCallback): Promise<IndividualExecutionResult>;

    /**
     * Get current state of an individual execution
     */
    getExecutionState(executionId: string): Promise<IndividualExecutionState | null>;

    /**
     * Check if an execution is currently running
     */
    isExecutionRunning(executionId: string): Promise<boolean>;

    /**
     * Get all currently running individual executions
     */
    getRunningExecutions(): Promise<string[]>;
}