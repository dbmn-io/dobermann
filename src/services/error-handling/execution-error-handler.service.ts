// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution Error Handler Service - Phase 8 Stabilization
 * 
 * Provides comprehensive error handling, recovery, and user-friendly error messages
 * for the new architecture execution flows.
 */

import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

export interface ExecutionError {
    code: string;
    message: string;
    userMessage: string;
    originalError?: Error;
    context?: Record<string, any>;
    recoverable: boolean;
    retryable: boolean;
}

export interface ErrorRecoveryResult {
    success: boolean;
    action: 'retry' | 'rollback' | 'abort' | 'continue';
    message: string;
    retryAfterMs?: number;
}

export interface ErrorContext {
    executionId?: string;
    endpointId?: string;
    architecture: 'legacy' | 'new';
    operation: string;
    phase?: 'preparation' | 'execution' | 'coordination';
    metadata?: Record<string, any>;
}

export class ExecutionErrorHandlerService {
    
    constructor(private logger: IExtensionDiagnosticLogger) {}
    
    private retryConfig = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2
    };

    /**
     * Process and categorize an error
     */
    processError(error: Error, context: ErrorContext): ExecutionError {
        const executionError: ExecutionError = {
            code: this.categorizeError(error),
            message: error.message,
            userMessage: this.createUserFriendlyMessage(error, context),
            originalError: error,
            context,
            recoverable: this.isRecoverable(error, context),
            retryable: this.isRetryable(error, context)
        };

        // Log the error with context for debugging
        if (typeof process !== 'undefined' && process.env?.ACTIVE8_PERFORMANCE_MONITORING === 'true') {
            this.logger.error('[ExecutionErrorHandler] Error processed', undefined, {
                    code: executionError.code,
                    message: executionError.message,
                    context: executionError.context,
                    recoverable: executionError.recoverable,
                    retryable: executionError.retryable
                });
        }

        return executionError;
    }

    /**
     * Attempt to recover from an error
     */
    async attemptRecovery(
        executionError: ExecutionError,
        attemptNumber: number = 1
    ): Promise<ErrorRecoveryResult> {

        if (!executionError.recoverable) {
            return {
                success: false,
                action: 'abort',
                message: 'Error is not recoverable'
            };
        }

        if (attemptNumber > this.retryConfig.maxAttempts) {
            return {
                success: false,
                action: 'abort',
                message: `Maximum retry attempts (${this.retryConfig.maxAttempts}) exceeded`
            };
        }

        const recoveryStrategy = this.getRecoveryStrategy(executionError);

        switch (recoveryStrategy) {
            case 'retry':
                const retryDelay = this.calculateRetryDelay(attemptNumber);
                return {
                    success: true,
                    action: 'retry',
                    message: `Retrying after ${retryDelay}ms (attempt ${attemptNumber}/${this.retryConfig.maxAttempts})`,
                    retryAfterMs: retryDelay
                };

            case 'rollback':
                return {
                    success: true,
                    action: 'rollback',
                    message: 'Rolling back to previous state'
                };

            case 'continue':
                return {
                    success: true,
                    action: 'continue',
                    message: 'Continuing with degraded functionality'
                };

            default:
                return {
                    success: false,
                    action: 'abort',
                    message: 'No recovery strategy available'
                };
        }
    }

    /**
     * Create user-friendly error messages
     */
    private createUserFriendlyMessage(error: Error, context: ErrorContext): string {
        const errorCode = this.categorizeError(error);

        switch (errorCode) {
            case 'NETWORK_ERROR':
                return 'Unable to connect to the API. Please check your network connection and try again.';

            case 'AUTHENTICATION_ERROR':
                return 'Authentication failed. Please check your credentials and try again.';

            case 'VALIDATION_ERROR':
                return 'The data provided is invalid. Please check your endpoint configuration and try again.';

            case 'PERMISSION_ERROR':
                return 'You do not have permission to perform this action.';

            case 'SERVICE_UNAVAILABLE':
                return 'The API service is temporarily unavailable. Please try again later.';

            case 'RATE_LIMIT_ERROR':
                return 'Too many requests. Please wait a moment before trying again.';

            case 'CSV_PARSING_ERROR':
                return 'Unable to parse the CSV file. Please check the file format and try again.';

            case 'EXECUTION_CANCELLED':
                return 'The execution was cancelled by the user.';

            case 'EXECUTION_TIMEOUT':
                return 'The execution took too long and was cancelled. Please try with a smaller dataset.';

            case 'TRANSACTION_PREPARATION_ERROR':
                return 'Failed to prepare the transaction. Please check your endpoint configuration.';

            case 'EXECUTION_COORDINATION_ERROR':
                return 'Failed to coordinate the execution. The system may be busy, please try again.';

            case 'FILE_SYSTEM_ERROR':
                return 'Unable to read or write files. Please check file permissions and try again.';

            default:
                return `An unexpected error occurred: ${error.message}`;
        }
    }

    /**
     * Categorize errors by type
     */
    private categorizeError(error: Error): string {
        const message = error.message.toLowerCase();
        const name = error.name.toLowerCase();

        // Network-related errors
        if (message.includes('network') || message.includes('connection') ||
            message.includes('timeout') && !message.includes('execution')) {
            return 'NETWORK_ERROR';
        }

        // Authentication errors
        if (message.includes('unauthorized') || message.includes('authentication') ||
            message.includes('401')) {
            return 'AUTHENTICATION_ERROR';
        }

        // Permission errors
        if (message.includes('forbidden') || message.includes('permission') ||
            message.includes('403')) {
            return 'PERMISSION_ERROR';
        }

        // Validation errors
        if (message.includes('validation') || message.includes('invalid') ||
            message.includes('400') || message.includes('bad request')) {
            return 'VALIDATION_ERROR';
        }

        // Rate limiting
        if (message.includes('rate limit') || message.includes('too many') ||
            message.includes('429')) {
            return 'RATE_LIMIT_ERROR';
        }

        // Service unavailable
        if (message.includes('service unavailable') || message.includes('503') ||
            message.includes('502') || message.includes('500')) {
            return 'SERVICE_UNAVAILABLE';
        }

        // CSV parsing
        if (message.includes('csv') || message.includes('parsing') ||
            message.includes('column') || message.includes('row')) {
            return 'CSV_PARSING_ERROR';
        }

        // Execution-specific errors
        if (message.includes('cancelled') || name === 'aborterror') {
            return 'EXECUTION_CANCELLED';
        }

        if (message.includes('execution') && message.includes('timeout')) {
            return 'EXECUTION_TIMEOUT';
        }

        if (message.includes('transaction preparation') ||
            message.includes('preparation')) {
            return 'TRANSACTION_PREPARATION_ERROR';
        }

        if (message.includes('execution coordinator') ||
            message.includes('coordination')) {
            return 'EXECUTION_COORDINATION_ERROR';
        }

        // File system errors
        if (message.includes('file not found') || message.includes('enoent') ||
            message.includes('permission denied') || message.includes('eacces')) {
            return 'FILE_SYSTEM_ERROR';
        }

        return 'UNKNOWN_ERROR';
    }

    /**
     * Determine if an error is recoverable
     */
    private isRecoverable(error: Error, context: ErrorContext): boolean {
        const errorCode = this.categorizeError(error);

        const recoverableErrors = [
            'NETWORK_ERROR',
            'SERVICE_UNAVAILABLE',
            'RATE_LIMIT_ERROR',
            'EXECUTION_TIMEOUT',
            'EXECUTION_COORDINATION_ERROR'
        ];

        return recoverableErrors.includes(errorCode);
    }

    /**
     * Determine if an error is retryable
     */
    private isRetryable(error: Error, context: ErrorContext): boolean {
        const errorCode = this.categorizeError(error);

        const retryableErrors = [
            'NETWORK_ERROR',
            'SERVICE_UNAVAILABLE',
            'RATE_LIMIT_ERROR',
            'EXECUTION_COORDINATION_ERROR'
        ];

        return retryableErrors.includes(errorCode);
    }

    /**
     * Get recovery strategy for an error
     */
    private getRecoveryStrategy(executionError: ExecutionError): 'retry' | 'rollback' | 'continue' | 'abort' {
        switch (executionError.code) {
            case 'NETWORK_ERROR':
            case 'SERVICE_UNAVAILABLE':
            case 'EXECUTION_COORDINATION_ERROR':
                return 'retry';

            case 'RATE_LIMIT_ERROR':
                return 'retry';

            case 'EXECUTION_TIMEOUT':
                return 'rollback';

            case 'CSV_PARSING_ERROR':
            case 'VALIDATION_ERROR':
                return 'abort';

            case 'EXECUTION_CANCELLED':
                return 'abort';

            default:
                return 'abort';
        }
    }

    /**
     * Calculate retry delay with exponential backoff
     */
    private calculateRetryDelay(attemptNumber: number): number {
        const delay = this.retryConfig.baseDelayMs *
            Math.pow(this.retryConfig.backoffMultiplier, attemptNumber - 1);

        return Math.min(delay, this.retryConfig.maxDelayMs);
    }

    /**
     * Format error for logging
     */
    formatErrorForLogging(executionError: ExecutionError): string {
        return [
            `[${executionError.code}] ${executionError.message}`,
            `Context: ${JSON.stringify(executionError.context)}`,
            `Recoverable: ${executionError.recoverable}`,
            `Retryable: ${executionError.retryable}`
        ].join(' | ');
    }

    /**
     * Get error suggestions for the user
     */
    getErrorSuggestions(executionError: ExecutionError): string[] {
        const suggestions: string[] = [];

        switch (executionError.code) {
            case 'NETWORK_ERROR':
                suggestions.push('Check your internet connection');
                suggestions.push('Verify the API endpoint URL is correct');
                suggestions.push('Try again in a few moments');
                break;

            case 'AUTHENTICATION_ERROR':
                suggestions.push('Check your API credentials');
                suggestions.push('Verify your token is not expired');
                suggestions.push('Ensure you have the correct permissions');
                break;

            case 'CSV_PARSING_ERROR':
                suggestions.push('Ensure the CSV file has headers');
                suggestions.push('Check for special characters in the data');
                suggestions.push('Verify the file is not corrupted');
                break;

            case 'VALIDATION_ERROR':
                suggestions.push('Check your endpoint configuration');
                suggestions.push('Verify required fields are present');
                suggestions.push('Ensure data types match the API specification');
                break;

            case 'RATE_LIMIT_ERROR':
                suggestions.push('Wait a few moments before trying again');
                suggestions.push('Consider processing smaller batches');
                break;
        }

        return suggestions;
    }

    /**
     * Update retry configuration
     */
    updateRetryConfig(config: Partial<typeof this.retryConfig>): void {
        this.retryConfig = { ...this.retryConfig, ...config };
    }

    /**
     * Get current retry configuration
     */
    getRetryConfig(): typeof this.retryConfig {
        return { ...this.retryConfig };
    }
}

// Note: Use dependency injection instead of singleton pattern
// Services should be injected via constructor for proper DI compliance