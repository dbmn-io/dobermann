// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { ExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.service';

// Type for the simplified global execution logger
interface ISimpleExecutionLogger {
    log: (executionId: string, level: 'info' | 'warn' | 'error' | 'debug', message: string) => Promise<void>;
    info: (executionId: string, message: string) => Promise<void>;
    warn: (executionId: string, message: string) => Promise<void>;
    error: (executionId: string, message: string) => Promise<void>;
    debug: (executionId: string, message: string) => Promise<void>;
    logExecution: (executionId: string, event: any) => Promise<void>;
}

/**
 * Professional logger registry to replace (global as any) patterns
 * Provides type-safe access to logger instances throughout the extension
 * Maintains fallback behavior for graceful degradation
 */
class LoggerRegistry {
    private static executionLogger: ISimpleExecutionLogger | undefined;
    private static diagnosticLogger: IExtensionDiagnosticLogger | undefined;

    /**
     * Register the execution logger instance (simplified version)
     * Called during extension activation
     */
    static setExecutionLogger(logger: ISimpleExecutionLogger): void {
        this.executionLogger = logger;
    }

    /**
     * Register the diagnostic logger instance
     * Called during service container initialization
     */
    static setDiagnosticLogger(logger: IExtensionDiagnosticLogger): void {
        this.diagnosticLogger = logger;
    }

    /**
     * Get the execution logger instance
     * Returns undefined if not registered (graceful degradation)
     */
    static getExecutionLogger(): ISimpleExecutionLogger | undefined {
        return this.executionLogger;
    }

    /**
     * Get the diagnostic logger instance
     * Creates fallback instance if not registered (maintains existing behavior)
     */
    static getDiagnosticLogger(): IExtensionDiagnosticLogger {
        if (this.diagnosticLogger) {
            return this.diagnosticLogger;
        }

        // Fallback: create new instance with same channel name as DI container
        return new ExtensionDiagnosticLogger('Dobermann Extension Diagnostics');
    }

    /**
     * Check if execution logger is available
     */
    static hasExecutionLogger(): boolean {
        return this.executionLogger !== undefined;
    }

    /**
     * Check if diagnostic logger is available
     */
    static hasDiagnosticLogger(): boolean {
        return this.diagnosticLogger !== undefined;
    }

    /**
     * Clear all logger references (for testing purposes)
     */
    static reset(): void {
        this.executionLogger = undefined;
        if (this.diagnosticLogger && typeof this.diagnosticLogger.dispose === 'function') {
            this.diagnosticLogger.dispose();
        }
        this.diagnosticLogger = undefined;
    }

    /**
     * Dispose of diagnostic logger resources
     * Called during extension deactivation
     */
    static dispose(): void {
        if (this.diagnosticLogger && typeof this.diagnosticLogger.dispose === 'function') {
            this.diagnosticLogger.dispose();
        }
    }
}

export { LoggerRegistry };