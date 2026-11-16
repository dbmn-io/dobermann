// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { LoggerRegistry } from '../../utils/logger-registry';
import { IExtensionDiagnosticLogger } from './extension-diagnostic-logger.interface';

/**
 * Factory function to get the diagnostic logger instance
 * Uses professional LoggerRegistry instead of global pollution
 * 
 * @returns IExtensionDiagnosticLogger instance with VS Code integration and console fallback
 */
export function getDiagnosticLogger(): IExtensionDiagnosticLogger {
    return LoggerRegistry.getDiagnosticLogger();
}

/**
 * Reset the diagnostic logger (for testing purposes)
 */
export function resetDiagnosticLogger(): void {
    LoggerRegistry.reset();
}