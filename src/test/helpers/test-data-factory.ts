// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Test Data Factory for Integration Tests
 * 
 * Provides standardized test data creation for integration scenarios.
 * This factory creates realistic test data that mirrors actual user workflows.
 */

export interface TestEndpoint {
    id?: string;
    name: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: string;
    description?: string;
    folder?: string;
    environmentId?: string;
}

export interface TestEnvironment {
    id?: string;
    name: string;
    baseUrl: string;
    description?: string;
    organizationId?: string;
    headers?: Record<string, string>;
    active?: boolean;
}

export interface TestCSVData {
    filename: string;
    content: string;
    headers: string[];
    rows: string[][];
}

export interface TestExecutionResult {
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    startTime: Date;
    endTime?: Date;
    requestData?: any;
    responseData?: any;
    errorMessage?: string;
}

/**
 * Factory for creating test endpoints
 */
export class TestEndpointFactory {
    /**
     * Create a simple REST API endpoint for testing
     */
    static createSimpleAPI(overrides: Partial<TestEndpoint> = {}): TestEndpoint {
        return {
            name: 'Test API Endpoint',
            path: '/api/test',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                name: '{{name}}',
                email: '{{email}}',
                active: true
            }, null, 2),
            description: 'Simple test endpoint for user data',
            folder: 'Test APIs',
            ...overrides
        };
    }

    /**
     * Create a user management endpoint
     */
    static createUserAPI(overrides: Partial<TestEndpoint> = {}): TestEndpoint {
        return {
            name: 'User Management API',
            path: '/api/users',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer {{token}}'
            },
            body: JSON.stringify({
                firstName: '{{firstName}}',
                lastName: '{{lastName}}',
                email: '{{email}}',
                role: '{{role}}',
                department: '{{department}}',
                startDate: '{{startDate}}'
            }, null, 2),
            description: 'Create new user in the system',
            folder: 'User Management',
            ...overrides
        };
    }

    /**
     * Create an inventory management endpoint
     */
    static createInventoryAPI(overrides: Partial<TestEndpoint> = {}): TestEndpoint {
        return {
            name: 'Inventory Update API',
            path: '/api/inventory/items',
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': '{{apiKey}}'
            },
            body: JSON.stringify({
                sku: '{{sku}}',
                quantity: '{{quantity}}',
                location: '{{location}}',
                cost: '{{cost}}',
                supplier: '{{supplier}}'
            }, null, 2),
            description: 'Update inventory item quantities',
            folder: 'Inventory',
            ...overrides
        };
    }

    /**
     * Create an endpoint with authentication headers
     */
    static createAuthenticatedAPI(overrides: Partial<TestEndpoint> = {}): TestEndpoint {
        return {
            name: 'Authenticated API',
            path: '/api/secure/data',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                'X-Client-ID': 'test-client-123'
            },
            body: JSON.stringify({
                data: '{{data}}',
                timestamp: '{{timestamp}}'
            }, null, 2),
            description: 'Secured endpoint requiring authentication',
            folder: 'Secure APIs',
            ...overrides
        };
    }

    /**
     * Create an endpoint that will fail (for error testing)
     */
    static createFailingAPI(overrides: Partial<TestEndpoint> = {}): TestEndpoint {
        return {
            name: 'Failing Test API',
            path: '/api/will-fail',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                invalidField: '{{nonExistentVariable}}'
            }, null, 2),
            description: 'Endpoint designed to fail for error testing',
            folder: 'Error Testing',
            ...overrides
        };
    }
}

/**
 * Factory for creating test environments
 */
export class TestEnvironmentFactory {
    /**
     * Create a development environment
     */
    static createDevelopment(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
        return {
            name: 'Development',
            baseUrl: 'https://api-dev.example.com',
            description: 'Development environment for testing',
            organizationId: 'dev-org-123',
            headers: {
                'X-Environment': 'development',
                'X-Debug': 'true'
            },
            active: true,
            ...overrides
        };
    }

    /**
     * Create a staging environment
     */
    static createStaging(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
        return {
            name: 'Staging',
            baseUrl: 'https://api-staging.example.com',
            description: 'Staging environment for pre-production testing',
            organizationId: 'staging-org-456',
            headers: {
                'X-Environment': 'staging'
            },
            active: true,
            ...overrides
        };
    }

    /**
     * Create a production environment
     */
    static createProduction(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
        return {
            name: 'Production',
            baseUrl: 'https://api.example.com',
            description: 'Production environment',
            organizationId: 'prod-org-789',
            headers: {
                'X-Environment': 'production'
            },
            active: false, // Usually not active during testing
            ...overrides
        };
    }

    /**
     * Create a local testing environment
     */
    static createLocal(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
        return {
            name: 'Local Testing',
            baseUrl: 'http://localhost:3000',
            description: 'Local development server for testing',
            organizationId: 'local-org-000',
            headers: {
                'X-Environment': 'local',
                'X-Debug': 'true'
            },
            active: true,
            ...overrides
        };
    }
}

/**
 * Factory for creating test CSV data
 */
export class TestCSVFactory {
    /**
     * Create user data CSV
     */
    static createUserDataCSV(rowCount: number = 5): TestCSVData {
        const headers = ['firstName', 'lastName', 'email', 'role', 'department', 'startDate'];
        const rows: string[][] = [];

        for (let i = 1; i <= rowCount; i++) {
            rows.push([
                `User${i}`,
                `LastName${i}`,
                `user${i}@example.com`,
                i % 2 === 0 ? 'Admin' : 'User',
                `Department${Math.ceil(i / 2)}`,
                `2024-01-${String(i).padStart(2, '0')}`
            ]);
        }

        const content = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        return {
            filename: 'user-data.csv',
            content,
            headers,
            rows
        };
    }

    /**
     * Create inventory data CSV
     */
    static createInventoryDataCSV(rowCount: number = 10): TestCSVData {
        const headers = ['sku', 'quantity', 'location', 'cost', 'supplier'];
        const rows: string[][] = [];

        for (let i = 1; i <= rowCount; i++) {
            rows.push([
                `SKU-${String(i).padStart(4, '0')}`,
                String(Math.floor(Math.random() * 100) + 1),
                `Warehouse-${String.fromCharCode(65 + (i % 3))}`,
                (Math.random() * 100 + 10).toFixed(2),
                `Supplier-${Math.ceil(i / 3)}`
            ]);
        }

        const content = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        return {
            filename: 'inventory-data.csv',
            content,
            headers,
            rows
        };
    }

    /**
     * Create simple test data CSV
     */
    static createSimpleDataCSV(rowCount: number = 3): TestCSVData {
        const headers = ['name', 'email', 'active'];
        const rows: string[][] = [];

        for (let i = 1; i <= rowCount; i++) {
            rows.push([
                `Test User ${i}`,
                `test${i}@example.com`,
                i % 2 === 1 ? 'true' : 'false'
            ]);
        }

        const content = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        return {
            filename: 'simple-data.csv',
            content,
            headers,
            rows
        };
    }

    /**
     * Create CSV with special characters (for edge case testing)
     */
    static createSpecialCharacterCSV(): TestCSVData {
        const headers = ['name', 'description', 'notes'];
        const rows = [
            ['User with "quotes"', 'Description, with comma', 'Notes\nwith newline'],
            ['User with, comma', 'Special chars: àáâãäå', 'Unicode: 🚀'],
            ['Empty fields test', '', '']
        ];

        const content = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        return {
            filename: 'special-chars.csv',
            content,
            headers,
            rows
        };
    }

    /**
     * Create large CSV for performance testing
     */
    static createLargeDataCSV(rowCount: number = 1000): TestCSVData {
        const headers = ['id', 'name', 'email', 'department', 'salary', 'startDate'];
        const rows: string[][] = [];
        const departments = ['Engineering', 'Marketing', 'Sales', 'HR', 'Finance'];

        for (let i = 1; i <= rowCount; i++) {
            rows.push([
                String(i),
                `Employee ${i}`,
                `employee${i}@company.com`,
                departments[i % departments.length],
                String(Math.floor(Math.random() * 50000) + 40000),
                `2024-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`
            ]);
        }

        const content = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        return {
            filename: 'large-dataset.csv',
            content,
            headers,
            rows
        };
    }
}

/**
 * Factory for creating test execution results
 */
export class TestExecutionResultFactory {
    /**
     * Create successful execution result
     */
    static createSuccessResult(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
        return {
            id: `exec-${Date.now()}`,
            status: 'completed',
            startTime: new Date(Date.now() - 5000),
            endTime: new Date(),
            requestData: { name: 'Test User', email: 'test@example.com' },
            responseData: { id: 123, created: true, message: 'Success' },
            ...overrides
        };
    }

    /**
     * Create failed execution result
     */
    static createFailureResult(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
        return {
            id: `exec-${Date.now()}`,
            status: 'failed',
            startTime: new Date(Date.now() - 3000),
            endTime: new Date(),
            requestData: { name: 'Test User', email: 'invalid-email' },
            errorMessage: 'Validation failed: Invalid email format',
            ...overrides
        };
    }

    /**
     * Create pending execution result
     */
    static createPendingResult(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
        return {
            id: `exec-${Date.now()}`,
            status: 'pending',
            startTime: new Date(),
            requestData: { name: 'Test User', email: 'test@example.com' },
            ...overrides
        };
    }

    /**
     * Create running execution result
     */
    static createRunningResult(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
        return {
            id: `exec-${Date.now()}`,
            status: 'running',
            startTime: new Date(Date.now() - 2000),
            requestData: { name: 'Test User', email: 'test@example.com' },
            ...overrides
        };
    }
}

/**
 * Complete scenario factory for integration tests
 */
export class TestScenarioFactory {
    /**
     * Create a complete user onboarding scenario
     */
    static createUserOnboardingScenario() {
        return {
            environment: TestEnvironmentFactory.createDevelopment(),
            endpoint: TestEndpointFactory.createUserAPI(),
            csvData: TestCSVFactory.createUserDataCSV(5),
            expectedResults: Array.from({ length: 5 }, () => 
                TestExecutionResultFactory.createSuccessResult()
            )
        };
    }

    /**
     * Create an inventory update scenario
     */
    static createInventoryUpdateScenario() {
        return {
            environment: TestEnvironmentFactory.createStaging(),
            endpoint: TestEndpointFactory.createInventoryAPI(),
            csvData: TestCSVFactory.createInventoryDataCSV(10),
            expectedResults: Array.from({ length: 10 }, () => 
                TestExecutionResultFactory.createSuccessResult()
            )
        };
    }

    /**
     * Create a mixed success/failure scenario
     */
    static createMixedResultsScenario() {
        const csvData = TestCSVFactory.createUserDataCSV(6);
        
        return {
            environment: TestEnvironmentFactory.createDevelopment(),
            endpoint: TestEndpointFactory.createUserAPI(),
            csvData,
            expectedResults: [
                TestExecutionResultFactory.createSuccessResult(),
                TestExecutionResultFactory.createSuccessResult(),
                TestExecutionResultFactory.createFailureResult(),
                TestExecutionResultFactory.createSuccessResult(),
                TestExecutionResultFactory.createFailureResult(),
                TestExecutionResultFactory.createSuccessResult()
            ]
        };
    }

    /**
     * Create a performance testing scenario
     */
    static createPerformanceTestScenario() {
        return {
            environment: TestEnvironmentFactory.createLocal(),
            endpoint: TestEndpointFactory.createSimpleAPI(),
            csvData: TestCSVFactory.createLargeDataCSV(100),
            expectedResults: Array.from({ length: 100 }, () => 
                TestExecutionResultFactory.createSuccessResult()
            )
        };
    }

    /**
     * Create an error handling scenario
     */
    static createErrorHandlingScenario() {
        return {
            environment: TestEnvironmentFactory.createDevelopment(),
            endpoint: TestEndpointFactory.createFailingAPI(),
            csvData: TestCSVFactory.createSimpleDataCSV(3),
            expectedResults: Array.from({ length: 3 }, () => 
                TestExecutionResultFactory.createFailureResult()
            )
        };
    }
}