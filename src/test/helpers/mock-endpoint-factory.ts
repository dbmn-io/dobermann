// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointConfig } from '../../data-loading/types';

/**
 * Factory for creating mock API endpoints for testing
 * Ensures all required properties are included
 */
export function createMockEndpoint(overrides: Partial<APIEndpointConfig> = {}): APIEndpointConfig {
    return {
        id: 'test-endpoint-1',
        name: 'Test Endpoint',
        method: 'POST',
        path: '/api/test',
        headers: {},
        queryParams: {},
        body: JSON.stringify({
            name: '{{userName}}',
            email: '{{userEmail}}',
            timestamp: new Date().toISOString()
        }),
        ...overrides
    };
}

/**
 * Create a mock endpoint for individual execution
 */
export function createIndividualMockEndpoint(overrides: Partial<APIEndpointConfig> = {}): APIEndpointConfig {
    return createMockEndpoint({
        id: 'individual-endpoint-1',
        name: 'Individual Test Endpoint',
        body: JSON.stringify({
            action: 'individual',
            data: 'test-data'
        }),
        ...overrides
    });
}

/**
 * Create a mock endpoint for batch execution with template variables
 */
export function createBatchMockEndpoint(overrides: Partial<APIEndpointConfig> = {}): APIEndpointConfig {
    return createMockEndpoint({
        id: 'batch-endpoint-1',
        name: 'Batch Test Endpoint',
        body: JSON.stringify({
            name: '{{userName}}',
            email: '{{userEmail}}',
            data: '{{csvData}}'
        }),
        ...overrides
    });
}

/**
 * Create a mock endpoint for integration testing
 */
export function createIntegrationMockEndpoint(overrides: Partial<APIEndpointConfig> = {}): APIEndpointConfig {
    return createMockEndpoint({
        id: 'integration-endpoint-1',
        name: 'Integration Test Endpoint',
        path: '/api/integration/test',
        body: JSON.stringify({
            name: '{{userName}}',
            email: '{{userEmail}}',
            timestamp: new Date().toISOString()
        }),
        ...overrides
    });
}