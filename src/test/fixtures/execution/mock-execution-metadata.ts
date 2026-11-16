import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { ExecutionStatus } from '../../../types/unified-execution-status';

// Mock execution metadata for testing

export const mockExecutionMetadataPending: ExecutionMetadata = {
    id: 'exec-001',
    environment: 'Development',
    environmentId: 'env_development_001',
    organization: 'ORG001',
    endpointId: 'test-endpoint-001',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: ExecutionStatus.PENDING,
    createdAt: new Date('2024-01-01T10:00:00Z')
};

export const mockExecutionMetadataRunning: ExecutionMetadata = {
    id: 'exec-002',
    environment: 'Development',
    environmentId: 'env_development_001',
    organization: 'ORG001',
    endpointId: 'test-endpoint-001',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: ExecutionStatus.RUNNING,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    startedAt: new Date('2024-01-01T10:00:05Z')
};

export const mockExecutionMetadataCompleted: ExecutionMetadata = {
    id: 'exec-003',
    environment: 'Development',
    organization: 'ORG001',
    endpointId: 'test-endpoint-001',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: ExecutionStatus.COMPLETED,
    runTime: 1500,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    startedAt: new Date('2024-01-01T10:00:05Z'),
    completedAt: new Date('2024-01-01T10:00:06Z'),
    requestFile: '/workspace/test-folder/test-request.json',
    responseFile: '/workspace/test-folder/test-response.json',
    httpStatus: 200,
    httpStatusText: 'OK'
};

export const mockExecutionMetadataError: ExecutionMetadata = {
    id: 'exec-004',
    environment: 'Development',
    environmentId: 'env_development_001',
    organization: 'ORG001',
    endpointId: 'test-endpoint-001',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: ExecutionStatus.ERROR,
    runTime: 500,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    startedAt: new Date('2024-01-01T10:00:05Z'),
    completedAt: new Date('2024-01-01T10:00:05Z'),
    requestFile: '/workspace/test-folder/test-request.json',
    responseFile: '/workspace/test-folder/test-response.json',
    errorMessage: 'Network timeout',
    httpStatus: 408,
    httpStatusText: 'Request Timeout'
};

export const mockExecutionMetadataCancelled: ExecutionMetadata = {
    id: 'exec-005',
    environment: 'Development',
    organization: 'ORG001',
    endpointId: 'test-endpoint-001',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: ExecutionStatus.CANCELLED,
    runTime: 300,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    startedAt: new Date('2024-01-01T10:00:05Z'),
    completedAt: new Date('2024-01-01T10:00:05Z'),
    requestFile: '/workspace/test-folder/test-request.json'
};

export const mockExecutionMetadataBatch: ExecutionMetadata = {
    id: 'exec-006',
    environment: 'Testing',
    organization: 'ORG002',
    endpointId: 'test-endpoint-002',
    endpointName: 'Batch API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/batch',
    batchId: 'batch-001',
    executionType: 'batch_member' as const,
    rows: '1',
    status: ExecutionStatus.COMPLETED,
    runTime: 2500,
    createdAt: new Date('2024-01-01T11:00:00Z'),
    startedAt: new Date('2024-01-01T11:00:05Z'),
    completedAt: new Date('2024-01-01T11:00:07Z'),
    requestFile: '/workspace/batch-folder/batch-request.json',
    responseFile: '/workspace/batch-folder/batch-response.json',
    httpStatus: 201,
    httpStatusText: 'Created'
};

export const mockExecutionMetadataArray: ExecutionMetadata[] = [
    mockExecutionMetadataPending,
    mockExecutionMetadataRunning,
    mockExecutionMetadataCompleted,
    mockExecutionMetadataError,
    mockExecutionMetadataCancelled,
    mockExecutionMetadataBatch
];

// Mock execution options for testing
export interface MockExecutionOptions {
    timeout?: number;
    retries?: number;
    validateBefore?: boolean;
    autoOpenFiles?: boolean;
    correlationId?: string;
}

export const mockExecutionOptionsDefault: MockExecutionOptions = {
    timeout: 30000,
    retries: 3,
    validateBefore: true,
    autoOpenFiles: false
};

export const mockExecutionOptionsNoValidation: MockExecutionOptions = {
    timeout: 30000,
    retries: 0,
    validateBefore: false,
    autoOpenFiles: false
};

export const mockExecutionOptionsQuick: MockExecutionOptions = {
    timeout: 5000,
    retries: 1,
    validateBefore: true,
    autoOpenFiles: true
};

// Mock execution results
export interface MockExecutionResult {
    success: boolean;
    executionId: string;
    duration?: number;
    httpStatus?: number;
    httpStatusText?: string;
    requestFile?: string;
    responseFile?: string;
    errorMessage?: string;
}

export const mockExecutionResultSuccess: MockExecutionResult = {
    success: true,
    executionId: 'exec-success-001',
    duration: 1500,
    httpStatus: 200,
    httpStatusText: 'OK',
    requestFile: '/workspace/test-folder/test-request.json',
    responseFile: '/workspace/test-folder/test-response.json'
};

export const mockExecutionResultError: MockExecutionResult = {
    success: false,
    executionId: 'exec-error-001',
    duration: 500,
    httpStatus: 500,
    httpStatusText: 'Internal Server Error',
    requestFile: '/workspace/test-folder/test-request.json',
    responseFile: '/workspace/test-folder/test-response.json',
    errorMessage: 'Internal server error occurred'
};

export const mockExecutionResultTimeout: MockExecutionResult = {
    success: false,
    executionId: 'exec-timeout-001',
    duration: 30000,
    errorMessage: 'Request timeout after 30 seconds'
};