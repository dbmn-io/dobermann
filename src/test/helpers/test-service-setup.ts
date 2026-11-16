// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Test Service Setup Helper
 * 
 * Provides a simple way to set up service containers with all required dependencies
 * for tests that need to resolve services like ExtensionDiagnosticLogger.
 */

import * as vscode from 'vscode';
import { ServiceContainer } from '../../container/service-container';

/**
 * Creates a properly configured service container for testing
 * with all core dependencies registered.
 */
export function createTestServiceContainer(): ServiceContainer {
    const container = new ServiceContainer();
    
    // Create mock extension context
    const mockContext: vscode.ExtensionContext = {
        subscriptions: [],
        extensionPath: '/test/path',
        asAbsolutePath: (path: string) => `/test/path/${path}`,
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            keys: () => []
        },
        workspaceState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            keys: () => []
        }
    } as any;

    // Register core services (includes ExtensionDiagnosticLogger)
    const { registerCoreServices } = require('../../container/core-services-registry');
    registerCoreServices(container, mockContext);
    
    // Register commonly needed services to prevent test failures
    const { ServiceTokens } = require('../../container/service-container.interface');
    
    // Mock EnvironmentManager - needed by many services
    const mockEnvironmentManager = {
        getSelectedEnvironment: () => 'TEST',
        getEnvironments: () => ['TEST'],
        getTokenFromEnvironment: () => 'mock-token',
        getCurrentEnvironment: () => ({ name: 'TEST', baseUrl: 'http://test.api' }),
        getActiveEnvironment: () => ({ name: 'TEST', baseUrl: 'http://test.api' })
    };
    container.registerSingleton(ServiceTokens.EnvironmentManager, mockEnvironmentManager);
    
    return container;
}

/**
 * Creates a test service container with execution services registered
 */
export function createTestServiceContainerWithExecution(): ServiceContainer {
    const container = createTestServiceContainer();
    
    const mockContext: vscode.ExtensionContext = {
        subscriptions: [],
        extensionPath: '/test/path',
        asAbsolutePath: (path: string) => `/test/path/${path}`,
        globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
        workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] }
    } as any;
    
    // Register execution services
    const { registerExecutionServices } = require('../../container/execution-service-registry');
    registerExecutionServices(container, {
        dobermannInstance: {} as any,
        vscodeAPI: {} as any,
        extensionContext: mockContext,
        executionMetadataManager: {} as any,
        environmentManager: {} as any,
        endpointManager: {} as any
    });
    
    return container;
}

/**
 * Creates a comprehensive test service container with all service registries
 * for tests that need complex service dependencies like ExecutionCommands
 */
export function createTestServiceContainerWithAllServices(): ServiceContainer {
    const container = createTestServiceContainer();
    
    const mockContext: vscode.ExtensionContext = {
        subscriptions: [],
        extensionPath: '/test/path',
        asAbsolutePath: (path: string) => `/test/path/${path}`,
        globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
        workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] }
    } as any;
    
    try {
        // Register execution services
        const { registerExecutionServices } = require('../../container/execution-service-registry');
        registerExecutionServices(container, {
            dobermannInstance: {} as any,
            vscodeAPI: {} as any,
            extensionContext: mockContext,
            executionMetadataManager: {} as any,
            environmentManager: {} as any,
            endpointManager: {} as any
        });
        
        // Register progress services
        const { registerProgressServices } = require('../../container/progress-services-registry');
        registerProgressServices(container, { vscodeAPI: vscode, extensionContext: mockContext });
        
        // Register UI services
        const { registerUIServices } = require('../../container/ui-services-registry');
        registerUIServices(container, { vscodeAPI: vscode, extensionContext: mockContext });
        
    } catch (error) {
        console.warn('[TestServiceSetup] Some services failed to register:', error);
        // Continue with whatever services we managed to register
    }
    
    return container;
}