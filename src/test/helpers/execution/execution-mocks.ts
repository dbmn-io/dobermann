// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as sinon from 'sinon';
import { 
    mockEndpointConfig, 
    mockEndpointConfigMinimal 
} from '../../fixtures/execution/mock-endpoints';
import { 
    mockEnvironmentDev, 
    mockEnvironmentMock 
} from '../../fixtures/execution/mock-environments';
import { 
    mockValidJWTPayload, 
    mockTokenStatusValid 
} from '../../fixtures/execution/mock-jwt-tokens';
import { 
    mockExecutionMetadataCompleted, 
    mockExecutionResultSuccess 
} from '../../fixtures/execution/mock-execution-metadata';
import { createMockLogger } from '../logging/mock-logger';

// Mock Dobermann Instance
export const createMockDobermannInstance = () => {
    return {
        executeEndpoint: sinon.stub().callsFake(async () => {
            // Add realistic timing for mock executions (0.5-3 seconds)
            const mockDelay = Math.random() * 2500 + 500; // 0.5-3 seconds
            await new Promise(resolve => setTimeout(resolve, mockDelay));
            return {
                status: 200,
                statusText: 'OK',
                data: { 
                    message: 'Success',
                    timestamp: new Date().toISOString(),
                    executionTime: `${mockDelay.toFixed(0)}ms`
                }
            };
        }),
        createWorkspaceFile: sinon.stub().resolves({
            success: true,
            filePath: '/workspace/test-folder/test-response.json',
            filename: 'test-response.json',
            folderName: 'test-folder',
            content: '{"message": "Success"}',
            autoOpened: false
        }),
        waitForInitialization: sinon.stub().resolves(),
        getTokenStatus: sinon.stub().returns(mockTokenStatusValid),
        getDecodedToken: sinon.stub().resolves(mockValidJWTPayload),
        getEnvironmentManager: sinon.stub().returns({
            getActiveEnvironment: sinon.stub().resolves(mockEnvironmentDev),
            getEnvironments: sinon.stub().resolves([mockEnvironmentDev, mockEnvironmentMock])
        }),
        getExecutionMetadataManager: sinon.stub().returns({
            createExecutionFromEndpoint: sinon.stub().resolves('exec-001'),
            updateExecution: sinon.stub().resolves(),
            getExecution: sinon.stub().resolves(mockExecutionMetadataCompleted),
            deleteExecution: sinon.stub().resolves(),
            getExecutionTable: sinon.stub().resolves({
                executions: [mockExecutionMetadataCompleted],
                totalCount: 1,
                page: 1,
                pageSize: 25,
                totalPages: 1
            }),
            getExecutionStats: sinon.stub().resolves({
                total: 1,
                completed: 1,
                pending: 0,
                running: 0,
                error: 0,
                cancelled: 0
            })
        }),
        openDobermann: sinon.stub().resolves()
    };
};

// Mock Environment Manager
export const createMockEnvironmentManager = () => {
    return {
        getActiveEnvironment: sinon.stub().resolves(mockEnvironmentDev),
        getEnvironments: sinon.stub().resolves([mockEnvironmentDev, mockEnvironmentMock]),
        setActiveEnvironment: sinon.stub().resolves(),
        saveEnvironment: sinon.stub().resolves(),
        deleteEnvironment: sinon.stub().resolves()
    };
};

// Mock Endpoint Manager
export const createMockEndpointManager = () => {
    return {
        getEndpoint: sinon.stub().resolves(mockEndpointConfig),
        getEndpoints: sinon.stub().resolves([mockEndpointConfig, mockEndpointConfigMinimal]),
        saveEndpoint: sinon.stub().resolves(),
        deleteEndpoint: sinon.stub().resolves(),
        createEndpoint: sinon.stub().resolves(mockEndpointConfig)
    };
};

// Mock Execution Metadata Manager
export const createMockExecutionMetadataManager = () => {
    return {
        initialize: sinon.stub().resolves(),
        createExecution: sinon.stub().resolves('exec-001'),
        createExecutionFromEndpoint: sinon.stub().resolves('exec-001'),
        updateExecution: sinon.stub().resolves(),
        getExecution: sinon.stub().resolves(mockExecutionMetadataCompleted),
        deleteExecution: sinon.stub().resolves(),
        getExecutionTable: sinon.stub().resolves({
            executions: [mockExecutionMetadataCompleted],
            totalCount: 1,
            page: 1,
            pageSize: 25,
            totalPages: 1
        }),
        getExecutionStats: sinon.stub().resolves({
            total: 1,
            completed: 1,
            pending: 0,
            running: 0,
            error: 0,
            cancelled: 0
        }),
        onExecutionChanged: {
            event: sinon.stub(),
            fire: sinon.stub()
        }
    };
};

// Mock Execution Validation Service
export const createMockExecutionValidationService = () => {
    return {
        validateExecution: sinon.stub().resolves({
            canExecute: true,
            jwtValid: true,
            orgValid: true,
            locValid: true,
            error: null
        })
    };
};

// Mock Execution File Service
export const createMockExecutionFileService = () => {
    return {
        createResultFiles: sinon.stub().resolves({
            requestFile: '/workspace/test-folder/test-request.json',
            responseFile: '/workspace/test-folder/test-response.json'
        })
    };
};

// Mock VS Code API
export const createMockVSCodeAPI = () => {
    return {
        window: {
            showInformationMessage: sinon.stub().resolves(),
            showErrorMessage: sinon.stub().resolves(),
            showWarningMessage: sinon.stub().resolves(),
            showTextDocument: sinon.stub().resolves(),
            createWebviewPanel: sinon.stub().returns({
                webview: {
                    html: '',
                    postMessage: sinon.stub(),
                    onDidReceiveMessage: sinon.stub()
                },
                onDidDispose: sinon.stub(),
                dispose: sinon.stub(),
                reveal: sinon.stub()
            })
        },
        workspace: {
            fs: {
                createDirectory: sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile: sinon.stub().resolves(Buffer.from('{"test": "data"}')),
                delete: sinon.stub().resolves()
            }
        },
        Uri: {
            file: sinon.stub().returns({ fsPath: '/test/path' })
        },
        ViewColumn: {
            One: 1,
            Two: 2,
            Beside: -2
        }
    };
};

// Mock Webview Panel
export const createMockWebviewPanel = () => {
    return {
        webview: {
            html: '',
            postMessage: sinon.stub(),
            onDidReceiveMessage: sinon.stub(),
            asWebviewUri: sinon.stub().returns('webview://test')
        },
        onDidDispose: sinon.stub(),
        dispose: sinon.stub(),
        reveal: sinon.stub(),
        title: 'Test Webview'
    };
};

// Mock Extension Context
export const createMockExtensionContext = () => {
    return {
        extensionPath: '/test/extension/path',
        storageUri: {
            fsPath: '/test/storage/path'
        },
        subscriptions: [],
        globalState: {
            get: sinon.stub().returns(undefined),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        },
        workspaceState: {
            get: sinon.stub().returns(undefined),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        }
    };
};

// Reset all mocks
export const resetAllMocks = () => {
    sinon.restore();
};

// Create a complete mock setup for execution tests
export const createMockExecutionSetup = () => {
    const dobermannInstance = createMockDobermannInstance();
    const environmentManager = createMockEnvironmentManager();
    const endpointManager = createMockEndpointManager();
    const executionMetadataManager = createMockExecutionMetadataManager();
    const executionValidationService = createMockExecutionValidationService();
    const executionFileService = createMockExecutionFileService();
    const vscodeAPI = createMockVSCodeAPI();
    const webviewPanel = createMockWebviewPanel();
    const extensionContext = createMockExtensionContext();
    const logger = createMockLogger();

    return {
        dobermannInstance,
        environmentManager,
        endpointManager,
        executionMetadataManager,
        executionValidationService,
        executionFileService,
        vscodeAPI,
        webviewPanel,
        extensionContext,
        logger
    };
};