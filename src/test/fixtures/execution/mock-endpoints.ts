import { APIEndpointConfig } from '../../../data-loading/types';

export const mockEndpointConfig: APIEndpointConfig = {
    id: 'test-endpoint-001',
    name: 'Test API Endpoint',
    path: '/api/test',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer {{token}}'
    },
    queryParams: {},
    body: '{"testField": "testValue", "userId": "{{userId}}"}',
    folder: 'test-folder',
    description: 'Test endpoint for unit testing',
    dataLoadingConfig: {
        detectArrays: false,
        repeatableArrays: [],
        testScripts: [{
            name: 'Test Script',
            script: `
                // Test script
                if (response.status === 200) {
                    console.log('Test passed');
                } else {
                    throw new Error('Test failed');
                }
            `,
            enabled: true,
            priority: 0
        }],
        errorHandling: {
            mode: 'stopOnFirst',
            retryConfig: {
                maxAttempts: 3,
                delaySeconds: 1,
                retryConditions: {
                    networkErrors: true,
                    serverErrors: true,
                    rateLimiting: true,
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

export const mockEndpointConfigMinimal: APIEndpointConfig = {
    id: 'test-endpoint-002',
    name: 'Minimal Test Endpoint',
    path: '/api/minimal',
    method: 'GET',
    headers: {},
    queryParams: {},
    dataLoadingConfig: {
        detectArrays: false,
        repeatableArrays: [],
        testScripts: [],
        errorHandling: {
            mode: 'stopOnFirst',
            retryConfig: {
                maxAttempts: 0,
                delaySeconds: 1,
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

export const mockEndpointConfigWithValidation: APIEndpointConfig = {
    id: 'test-endpoint-003',
    name: 'Validation Test Endpoint',
    path: '/api/validation',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    queryParams: {},
    body: '{"name": "{{name}}", "email": "{{email}}"}',
    dataLoadingConfig: {
        detectArrays: true,
        repeatableArrays: [],
        testScripts: [],
        errorHandling: {
            mode: 'continue',
            retryConfig: {
                maxAttempts: 2,
                delaySeconds: 1,
                retryConditions: {
                    networkErrors: true,
                    serverErrors: true,
                    rateLimiting: true,
                    clientErrors: false
                }
            }
        },
        dataValidation: {
            enforceDataTypes: true,
            variableDataTypes: {
                name: 'string',
                email: 'string'
            }
        }
    }
};

export const mockEndpoints = [
    mockEndpointConfig,
    mockEndpointConfigMinimal,
    mockEndpointConfigWithValidation
];