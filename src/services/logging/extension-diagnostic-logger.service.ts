// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IExtensionDiagnosticLogger } from './extension-diagnostic-logger.interface';

/**
 * Extension diagnostic logger implementation using VS Code's LogOutputChannel with console fallback
 * Provides structured logging for extension diagnostics, errors, and debug information
 * 
 * Features:
 * - VS Code LogOutputChannel integration (primary)
 * - Console fallback when VS Code APIs unavailable
 * - Automatic log rotation handled by VS Code
 * - User-configurable log levels via VS Code settings
 * - Storage in ~/.config/Code/logs/ (managed by VS Code)
 * - Integration with VS Code's logging infrastructure
 */
export class ExtensionDiagnosticLogger implements IExtensionDiagnosticLogger {
    private readonly outputChannel: vscode.LogOutputChannel | null;
    private readonly fallbackMode: boolean;
    
    constructor(channelName: string = 'Dobermann Extension') {
        try {
            this.outputChannel = vscode.window.createOutputChannel(channelName, { log: true });
            // Additional check: ensure the output channel has the expected methods
            if (!this.outputChannel || typeof this.outputChannel.warn !== 'function') {
                throw new Error('Invalid output channel');
            }
            this.fallbackMode = false;
        } catch (error) {
            // Fallback when VS Code APIs are unavailable (tests, etc.)
            this.outputChannel = null;
            this.fallbackMode = true;
        }
    }
    
    /**
     * Log informational messages for extension diagnostics
     */
    info(message: string, ...args: unknown[]): void {
        if (this.fallbackMode) {
            // eslint-disable-next-line no-restricted-syntax -- Centralized console fallback in logger service
            console.info(`[EXTENSION-DIAGNOSTICS] ${this.formatMessage(message, args)}`);
        } else {
            this.outputChannel!.info(this.formatMessage(message, args));
        }
    }
    
    /**
     * Log warning messages for extension diagnostics  
     */
    warn(message: string, ...args: unknown[]): void {
        if (this.fallbackMode) {
            // eslint-disable-next-line no-restricted-syntax -- Centralized console fallback in logger service
            console.warn(`[EXTENSION-DIAGNOSTICS] ${this.formatMessage(message, args)}`);
        } else {
            this.outputChannel!.warn(this.formatMessage(message, args));
        }
    }
    
    /**
     * Log error messages for extension diagnostics
     */
    error(message: string, error?: Error, ...args: unknown[]): void {
        let errorMessage = this.formatMessage(message, args);
        
        if (error) {
            errorMessage += `\nError: ${error.message}`;
            if (error.stack) {
                errorMessage += `\nStack: ${error.stack}`;
            }
        }
        
        if (this.fallbackMode) {
            // eslint-disable-next-line no-restricted-syntax -- Centralized console fallback in logger service
            console.error(`[EXTENSION-DIAGNOSTICS] ${errorMessage}`);
        } else {
            this.outputChannel!.error(errorMessage);
        }
    }
    
    /**
     * Log debug messages for extension diagnostics
     */
    debug(message: string, ...args: unknown[]): void {
        if (this.fallbackMode) {
            console.debug(`[EXTENSION-DIAGNOSTICS] ${this.formatMessage(message, args)}`);
        } else {
            this.outputChannel!.debug(this.formatMessage(message, args));
        }
    }
    
    /**
     * Log trace messages for detailed debugging
     */
    trace(message: string, ...args: unknown[]): void {
        if (this.fallbackMode) {
            console.trace(`[EXTENSION-DIAGNOSTICS] ${this.formatMessage(message, args)}`);
        } else {
            this.outputChannel!.trace(this.formatMessage(message, args));
        }
    }
    
    /**
     * Show the diagnostic log output channel to the user
     */
    show(): void {
        if (!this.fallbackMode) {
            this.outputChannel!.show();
        }
        // No-op in fallback mode
    }
    
    /**
     * Clear the diagnostic log output channel
     */
    clear(): void {
        if (!this.fallbackMode) {
            this.outputChannel!.clear();
        }
        // No-op in fallback mode
    }
    
    /**
     * Dispose of the logger and clean up resources
     */
    dispose(): void {
        if (!this.fallbackMode) {
            this.outputChannel!.dispose();
        }
        // No-op in fallback mode
    }
    
    /**
     * Format message with arguments for consistent logging
     */
    private formatMessage(message: string, args: unknown[]): string {
        if (args.length === 0) {
            return message;
        }
        
        // Format arguments as JSON for structured logging
        const formattedArgs = args.map(arg => {
            if (typeof arg === 'string') {
                return arg;
            }
            try {
                return JSON.stringify(arg, null, 2);
            } catch (error) {
                return String(arg);
            }
        }).join(' ');
        
        return `${message} ${formattedArgs}`;
    }
}