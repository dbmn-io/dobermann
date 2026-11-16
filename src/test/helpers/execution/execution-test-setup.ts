// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { beforeEach, afterEach } from 'mocha';
import { 
    createMockExecutionSetup, 
    resetAllMocks 
} from './execution-mocks';

// Test setup utility for execution tests
export class ExecutionTestSetup {
    public mocks: ReturnType<typeof createMockExecutionSetup>;

    constructor() {
        this.mocks = createMockExecutionSetup();
    }

    // Setup method to be called in beforeEach
    setup() {
        this.mocks = createMockExecutionSetup();
    }

    // Cleanup method to be called in afterEach
    cleanup() {
        resetAllMocks();
    }

    // Get specific mock instances
    getDobermannInstance() {
        return this.mocks.dobermannInstance;
    }

    getEnvironmentManager() {
        return this.mocks.environmentManager;
    }

    getEndpointManager() {
        return this.mocks.endpointManager;
    }

    getExecutionMetadataManager() {
        return this.mocks.executionMetadataManager;
    }

    getVSCodeAPI() {
        return this.mocks.vscodeAPI;
    }

    getWebviewPanel() {
        return this.mocks.webviewPanel;
    }

    getExtensionContext() {
        return this.mocks.extensionContext;
    }

    getLogger() {
        return this.mocks.logger;
    }
}

// Global test setup for execution tests
export const setupExecutionTests = () => {
    const testSetup = new ExecutionTestSetup();

    beforeEach(() => {
        testSetup.setup();
    });

    afterEach(() => {
        testSetup.cleanup();
    });

    return testSetup;
};

// Common test patterns for execution services
export const testPatterns = {
    // Pattern for testing service method calls
    testServiceMethodCall: (methodName: string, expectedArgs: any[]) => {
        return {
            description: `should call ${methodName} with correct arguments`,
            test: (mockService: any, actualArgs: any[]) => {
                return mockService[methodName].calledWith(...actualArgs);
            }
        };
    },

    // Pattern for testing async service methods
    testAsyncServiceMethod: (methodName: string, expectedResult: any) => {
        return {
            description: `should resolve ${methodName} with expected result`,
            test: async (mockService: any, ...args: any[]) => {
                const result = await mockService[methodName](...args);
                return result === expectedResult;
            }
        };
    },

    // Pattern for testing error handling
    testErrorHandling: (methodName: string, errorMessage: string) => {
        return {
            description: `should handle ${methodName} errors correctly`,
            test: async (mockService: any, ...args: any[]) => {
                mockService[methodName].rejects(new Error(errorMessage));
                try {
                    await mockService[methodName](...args);
                    return false; // Should not reach here
                } catch (error: any) {
                    return error instanceof Error && error.message === errorMessage;
                }
            }
        };
    },

    // Pattern for testing validation
    testValidation: (validateFn: Function, validInput: any, invalidInput: any) => {
        return {
            description: 'should validate input correctly',
            test: () => {
                const validResult = validateFn(validInput);
                const invalidResult = validateFn(invalidInput);
                return validResult === true && invalidResult === false;
            }
        };
    }
};

// Common assertions for execution tests
export const executionAssertions = {
    // Assert execution metadata is correctly formatted
    assertExecutionMetadata: (metadata: any) => {
        return metadata &&
            typeof metadata.id === 'string' &&
            typeof metadata.environment === 'string' &&
            typeof metadata.endpointId === 'string' &&
            typeof metadata.status === 'string' &&
            metadata.createdAt instanceof Date;
    },

    // Assert execution result is correctly formatted
    assertExecutionResult: (result: any) => {
        return result &&
            typeof result.success === 'boolean' &&
            typeof result.executionId === 'string';
    },

    // Assert validation result is correctly formatted
    assertValidationResult: (result: any) => {
        return result &&
            typeof result.jwtValid === 'boolean' &&
            typeof result.orgValid === 'boolean' &&
            typeof result.locValid === 'boolean' &&
            typeof result.canExecute === 'boolean';
    },

    // Assert file operation result is correctly formatted
    assertFileResult: (result: any) => {
        return result &&
            typeof result.success === 'boolean' &&
            (result.success === false || typeof result.filePath === 'string');
    }
};

// Test data generators
export const testDataGenerators = {
    // Generate unique execution ID
    generateExecutionId: () => {
        return `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    },

    // Generate unique correlation ID
    generateCorrelationId: () => {
        return `corr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    },

    // Generate test timestamp
    generateTimestamp: () => {
        return new Date();
    },

    // Generate test file path
    generateFilePath: (folder: string, filename: string) => {
        return `/workspace/${folder}/${filename}`;
    }
};