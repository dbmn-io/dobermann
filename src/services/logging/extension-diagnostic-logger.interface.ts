// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Interface for extension diagnostic logging
 * Provides structured logging for extension diagnostics, errors, and debug information
 * Uses VS Code's LogOutputChannel for proper integration with VS Code logging infrastructure
 */
export interface IExtensionDiagnosticLogger {
    /**
     * Log informational messages for extension diagnostics
     */
    info(message: string, ...args: unknown[]): void;
    
    /**
     * Log warning messages for extension diagnostics
     */
    warn(message: string, ...args: unknown[]): void;
    
    /**
     * Log error messages for extension diagnostics
     */
    error(message: string, error?: Error, ...args: unknown[]): void;
    
    /**
     * Log debug messages for extension diagnostics
     */
    debug(message: string, ...args: unknown[]): void;
    
    /**
     * Log trace messages for detailed debugging
     */
    trace(message: string, ...args: unknown[]): void;
    
    /**
     * Show the diagnostic log output channel to the user
     */
    show(): void;
    
    /**
     * Clear the diagnostic log output channel
     */
    clear(): void;
    
    /**
     * Dispose of the logger and clean up resources
     */
    dispose(): void;
}