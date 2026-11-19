// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { ExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.service';
import type { AppLog } from '../services/logging/app-log';
import { teeLogger } from '../services/logging/tee-logger';

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
    private static appLog: AppLog | undefined;

    /** Dobermann issue 7: the app's one log, made first thing in activate(). */
    static setAppLog(log: AppLog): void {
        this.appLog = log;
    }

    static getAppLog(): AppLog | undefined {
        return this.appLog;
    }

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

        // Fallback: the app's log when there is one (and, until Logs shows everything, the old
        // Output channel beside it)
        const channel = new ExtensionDiagnosticLogger('Dobermann Extension Diagnostics');
        return this.appLog ? teeLogger(this.appLog.logger(), channel) : channel;
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