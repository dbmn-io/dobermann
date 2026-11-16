// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as sinon from 'sinon';
import { IExtensionDiagnosticLogger } from '../../../services/logging/extension-diagnostic-logger.interface';

/**
 * Creates a mock implementation of IExtensionDiagnosticLogger for testing
 * 
 * This mock logger:
 * - Implements all required methods from IExtensionDiagnosticLogger interface
 * - Uses sinon stubs to track method calls for assertions
 * - Can be configured with custom behavior if needed
 * 
 * @returns Mock logger instance with sinon stubs for all methods
 */
export function createMockLogger(): IExtensionDiagnosticLogger & {
    info: sinon.SinonStub;
    warn: sinon.SinonStub;
    error: sinon.SinonStub;
    debug: sinon.SinonStub;
    trace: sinon.SinonStub;
    show: sinon.SinonStub;
    clear: sinon.SinonStub;
    dispose: sinon.SinonStub;
} {
    const mockLogger = {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        trace: sinon.stub(),
        show: sinon.stub(),
        clear: sinon.stub(),
        dispose: sinon.stub()
    };

    // Add console output for debugging if needed (can be toggled)
    const enableConsoleOutput = process.env.DEBUG_TESTS === 'true';
    
    if (enableConsoleOutput) {
        mockLogger.info.callsFake((message: string, ...args: any[]) => {
            console.log(`[TEST-LOG] INFO: ${message}`, ...args);
        });
        mockLogger.warn.callsFake((message: string, ...args: any[]) => {
            console.log(`[TEST-LOG] WARN: ${message}`, ...args);
        });
        mockLogger.error.callsFake((message: string, ...args: any[]) => {
            console.log(`[TEST-LOG] ERROR: ${message}`, ...args);
        });
        mockLogger.debug.callsFake((message: string, ...args: any[]) => {
            console.log(`[TEST-LOG] DEBUG: ${message}`, ...args);
        });
    }

    return mockLogger;
}

/**
 * Creates a simple mock logger without sinon stubs
 * Useful for tests that don't need to assert on logger calls
 * 
 * @returns Simple mock logger with no-op methods
 */
export function createSimpleMockLogger(): IExtensionDiagnosticLogger {
    return {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        show: () => {},
        clear: () => {},
        dispose: () => {}
    };
}

/**
 * Reset all mock logger stubs
 * Call this in afterEach() to clean up between tests
 * 
 * @param mockLogger The mock logger to reset
 */
export function resetMockLogger(mockLogger: ReturnType<typeof createMockLogger>): void {
    mockLogger.info.reset();
    mockLogger.warn.reset();
    mockLogger.error.reset();
    mockLogger.debug.reset();
    mockLogger.trace.reset();
    mockLogger.show.reset();
    mockLogger.clear.reset();
    mockLogger.dispose.reset();
}

/**
 * Assert that a logger method was called with specific arguments
 * 
 * @param mockLogger The mock logger to check
 * @param method The method name to check
 * @param expectedMessage The expected message (can be partial match)
 * @param expectedArgs Optional additional arguments to check
 */
export function assertLoggerCalled(
    mockLogger: ReturnType<typeof createMockLogger>,
    method: 'info' | 'warn' | 'error' | 'debug',
    expectedMessage: string | RegExp,
    expectedArgs?: any[]
): void {
    const stub = mockLogger[method];
    
    if (!stub.called) {
        throw new Error(`Expected logger.${method} to be called but it wasn't`);
    }

    const calls = stub.getCalls();
    const matchingCall = calls.find(call => {
        const [message, ...args] = call.args;
        
        // Check message match
        const messageMatches = typeof expectedMessage === 'string' 
            ? message.includes(expectedMessage)
            : expectedMessage.test(message);
            
        if (!messageMatches) return false;
        
        // Check additional args if provided
        if (expectedArgs) {
            return expectedArgs.every((expectedArg, index) => {
                const actualArg = args[index];
                return JSON.stringify(actualArg) === JSON.stringify(expectedArg);
            });
        }
        
        return true;
    });

    if (!matchingCall) {
        const actualCalls = calls.map(c => c.args[0]).join('\n  ');
        throw new Error(
            `Expected logger.${method} to be called with message matching "${expectedMessage}"\n` +
            `Actual calls:\n  ${actualCalls}`
        );
    }
}