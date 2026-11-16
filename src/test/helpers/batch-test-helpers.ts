// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { ExecutionMetadata, BatchConfiguration, BatchResumptionData } from '../../storage/execution-metadata';
import { BatchStatus } from '../../types/unified-execution-status';
import { APIEndpointConfig } from '../../data-loading/zod-schemas';

/**
 * Test helper to create valid ExecutionMetadata objects for batch executions
 * Ensures all required fields are populated with sensible defaults
 */
export function createTestBatchExecution(overrides: Partial<ExecutionMetadata> = {}): ExecutionMetadata {
    const defaultBatch: ExecutionMetadata = {
        // Core Identity & State
        id: 'test-batch-123',
        executionType: 'batch' as const,
        rows: '10', // Default number of rows in the batch
        status: BatchStatus.PENDING,
        
        // Environment & Execution Context
        environment: 'test-env',
        organization: 'test-org',
        endpointId: 'test-endpoint',
        endpointName: 'Test Endpoint',
        endpointMethod: 'POST',
        endpointPath: '/api/test',
        
        // Batch-specific fields
        batchConfiguration: {
            stopOnFirstError: false
        } as BatchConfiguration,
        batchResumptionData: {
            currentExecutionIndex: 0,
            completedExecutions: [],
            failedExecutions: [],
            skippedExecutions: []
        } as BatchResumptionData,
        
        // Timestamps
        createdAt: new Date('2025-01-01T10:00:00Z'),
        
        // File references (optional)
        requestFile: '/test/batch.csv',
    };

    return { ...defaultBatch, ...overrides };
}

/**
 * Create a batch member execution for testing
 */
export function createTestBatchMemberExecution(batchId: string, overrides: Partial<ExecutionMetadata> = {}): ExecutionMetadata {
    const defaultMember: ExecutionMetadata = {
        id: `${batchId}-member-${Date.now()}`,
        executionType: 'batch_member' as const,
        rows: '1',
        status: 'pending',
        batchId,
        
        // Copy environment info from batch
        environment: 'test-env',
        organization: 'test-org',
        endpointId: 'test-endpoint',
        endpointName: 'Test Endpoint',
        endpointMethod: 'POST',
        endpointPath: '/api/test',
        
        createdAt: new Date()
    };

    return { ...defaultMember, ...overrides };
}

/**
 * Create an individual execution for testing
 */
export function createTestIndividualExecution(overrides: Partial<ExecutionMetadata> = {}): ExecutionMetadata {
    const defaultIndividual: ExecutionMetadata = {
        id: `test-individual-${Date.now()}`,
        executionType: 'individual' as const,
        rows: '1',
        status: 'pending',
        
        environment: 'test-env',
        organization: 'test-org',
        endpointId: 'test-endpoint',
        endpointName: 'Test Endpoint',
        endpointMethod: 'POST',
        endpointPath: '/api/test',
        
        createdAt: new Date()
    };

    return { ...defaultIndividual, ...overrides };
}

/**
 * Legacy helper for backward compatibility
 * Creates a batch execution using the unified model
 */
export function createTestBatchMetadata(overrides: Partial<ExecutionMetadata> = {}): ExecutionMetadata {
    return createTestBatchExecution(overrides);
}

/**
 * Legacy helper for backward compatibility
 * Creates batch data without an ID
 */
export function createTestBatchCreate(overrides: Partial<Omit<ExecutionMetadata, 'id'>> = {}): Omit<ExecutionMetadata, 'id'> {
    const fullBatch = createTestBatchExecution(overrides);
    const { id, ...batchCreate } = fullBatch;
    return batchCreate;
}

/**
 * Legacy helper for backward compatibility
 */
export function createTestBatchData(overrides: any = {}): any {
    const baseBatch = createTestBatchCreate(overrides);
    return { ...baseBatch, ...overrides };
}

/**
 * Helper function to create test endpoint with error tolerance configuration
 * Used for testing error tolerance functionality
 */
export function createTestEndpointWithTolerance(toleranceConfig: {
    mode: 'continue' | 'stopOnFirst';
    enableErrorTolerance?: boolean;
    toleranceMode?: 'absolute' | 'percentage';
    absoluteErrorLimit?: number;
    percentageErrorLimit?: number;
}): APIEndpointConfig {
    return {
        id: 'test-endpoint-tolerance',
        name: 'Test Endpoint with Tolerance',
        path: '/api/test',
        method: 'POST',
        headers: {},
        queryParams: {},
        body: '{}',
        dataLoadingConfig: {
            jsonTemplate: '',
            detectArrays: true,
            repeatableArrays: [],
            testScripts: [],
            errorHandling: {
                mode: toleranceConfig.mode === 'continue' ? 'continue' : 'stopOnFirst',
                enableErrorTolerance: toleranceConfig.enableErrorTolerance || false,
                toleranceMode: toleranceConfig.toleranceMode || 'absolute',
                absoluteErrorLimit: toleranceConfig.absoluteErrorLimit || 10,
                percentageErrorLimit: toleranceConfig.percentageErrorLimit || 10,
                maxErrorTolerance: {
                    enabled: toleranceConfig.enableErrorTolerance || false,
                    type: toleranceConfig.toleranceMode || 'absolute',
                    value: toleranceConfig.toleranceMode === 'percentage' 
                        ? (toleranceConfig.percentageErrorLimit || 10)
                        : (toleranceConfig.absoluteErrorLimit || 10)
                },
                retryConfig: {
                    maxAttempts: 1,
                    delaySeconds: 5,
                    retryConditions: {
                        networkErrors: false,
                        serverErrors: false,
                        rateLimiting: false,
                        clientErrors: false
                    }
                }
            },
            dataValidation: {
                enforceDataTypes: false,
                variableDataTypes: {}
            }
        }
    };
}