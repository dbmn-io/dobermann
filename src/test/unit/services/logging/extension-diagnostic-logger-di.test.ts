// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { ServiceContainer } from '../../../../container/service-container';
import { registerCoreServices, CoreServiceTokens } from '../../../../container/core-services-registry';
import { IExtensionDiagnosticLogger } from '../../../../services/logging/extension-diagnostic-logger.interface';

// Mock VS Code API for testing
const mockVSCode = {
    window: {
        createOutputChannel: (name: string, options?: any) => ({
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {},
            show: () => {},
            clear: () => {},
            dispose: () => {}
        })
    }
};

describe('ExtensionDiagnosticLogger DI Integration Test', () => {
    let container: ServiceContainer;
    let mockContext: any;

    beforeEach(() => {
        container = new ServiceContainer();
        mockContext = {
            subscriptions: [],
            extensionPath: '/test/path',
            asAbsolutePath: (path: string) => `/test/path/${path}`,
            globalState: {
                get: () => undefined,
                update: () => Promise.resolve()
            },
            workspaceState: {
                get: () => undefined, 
                update: () => Promise.resolve()
            }
        };
    });

    afterEach(async () => {
        container.dispose();
        // Clear LoggerRegistry reference  
        const { LoggerRegistry } = await import('../../../../utils/logger-registry');
        LoggerRegistry.reset();
    });

    it('should register ExtensionDiagnosticLogger in DI container', () => {
        // Act
        registerCoreServices(container, {
            vscodeAPI: mockVSCode as any,
            extensionContext: mockContext
        });

        // Assert - Should be able to resolve the logger
        const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        
        expect(logger).to.exist;
        expect(logger).to.have.property('info').that.is.a('function');
        expect(logger).to.have.property('warn').that.is.a('function');
        expect(logger).to.have.property('error').that.is.a('function');
        expect(logger).to.have.property('debug').that.is.a('function');
        expect(logger).to.have.property('trace').that.is.a('function');
        expect(logger).to.have.property('show').that.is.a('function');
        expect(logger).to.have.property('clear').that.is.a('function');
        expect(logger).to.have.property('dispose').that.is.a('function');
    });

    it('should register logger professionally via LoggerRegistry', async () => {
        // Act
        registerCoreServices(container, {
            vscodeAPI: mockVSCode as any,
            extensionContext: mockContext
        });

        // Resolve to trigger singleton creation
        const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

        // Wait for async LoggerRegistry registration
        await new Promise(resolve => setTimeout(resolve, 10));

        // Assert - Logger should be registered in LoggerRegistry
        const { LoggerRegistry } = await import('../../../../utils/logger-registry');
        expect(LoggerRegistry.hasDiagnosticLogger()).to.be.true;
        expect(LoggerRegistry.getDiagnosticLogger()).to.have.property('warn').that.is.a('function');
    });

    it('should provide working logger methods', () => {
        // Arrange
        let loggedMessage = '';
        const mockChannel = {
            info: (msg: string) => { loggedMessage = `INFO: ${msg}`; },
            warn: (msg: string) => { loggedMessage = `WARN: ${msg}`; },
            error: (msg: string) => { loggedMessage = `ERROR: ${msg}`; },
            debug: (msg: string) => { loggedMessage = `DEBUG: ${msg}`; },
            trace: (msg: string) => { loggedMessage = `TRACE: ${msg}`; },
            show: () => {},
            clear: () => {},
            dispose: () => {}
        };

        const customMockVSCode = {
            window: {
                createOutputChannel: (name: string, options?: { log: boolean }) => {
                    if (options?.log) {
                        // Return LogOutputChannel mock
                        return mockChannel;
                    }
                    return mockChannel; // Regular OutputChannel mock
                }
            }
        };

        registerCoreServices(container, {
            vscodeAPI: customMockVSCode as any,
            extensionContext: mockContext
        });

        // Act
        const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        logger.warn('Test warning message');

        // Assert
        expect(loggedMessage).to.equal('WARN: Test warning message');
    });

    it('should handle multiple service registrations without conflict', () => {
        // Act - Register services multiple times
        registerCoreServices(container, {
            vscodeAPI: mockVSCode as any,
            extensionContext: mockContext
        });

        const logger1 = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        const logger2 = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

        // Assert - Should get same singleton instance
        expect(logger1).to.equal(logger2);
    });
});