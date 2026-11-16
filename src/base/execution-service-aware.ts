// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution-Specific Service-Aware Components
 * 
 * Following Architecture.md - Execution Integration patterns
 * Provides specialized base classes for execution-related components
 */

import * as vscode from 'vscode';
import { ServiceAwareComponent, ServiceAwareWebview, ServiceAwareTreeProvider, ServiceAwareConfig } from './service-aware-base';
import {
    BaseMessage,
    ResponseMessage,
    EventMessage,
    createResponseMessage,
    createErrorResponseMessage,
    createEventMessage
} from '../types/base-message';
import { ExecutionStatus } from '../types/unified-execution-status';
import {
    ExecuteEndpointRequest,
    ValidateExecutionRequest,
    CancelExecutionRequest,
    GetExecutionStatusRequest,
    ExecutionResultResponse,
    ValidationResultResponse,
    ExecutionStartedEvent,
    ExecutionCompletedEvent,
    ExecutionErrorEvent,
    ExecutionMessageTypes,
    isExecuteEndpointRequest,
    isValidateExecutionRequest,
    isCancelExecutionRequest,
    isGetExecutionStatusRequest
} from '../types/execution-messages';
import { APIEndpointConfig } from '../data-loading/types';
import { ExecutionOptions, ExecutionResult } from '../services/execution/execution.interface';
import { ValidationResult } from '../services/execution/execution-validation.interface';
import { ExecutionTableResult } from '../services/execution/execution-metadata.interface';
import { ExecutionMetadata } from '../storage/execution-metadata';

/**
 * Base class for execution-related components
 */
export abstract class ExecutionServiceAware extends ServiceAwareComponent {
    constructor(config: ServiceAwareConfig) {
        super({ ...config, componentName: config.componentName || 'ExecutionComponent' });
    }

    /**
     * Execute endpoint with service
     */
    protected async executeEndpoint(
        endpointConfig: APIEndpointConfig,
        executionOptions: ExecutionOptions,
        correlationId?: string
    ): Promise<ExecutionResult> {
        try {
            this.log(`Executing endpoint: ${endpointConfig.name || 'unnamed'}`);
            
            if (!this.services.executionService.execute) {
                throw new Error('ExecutionService.execute() method not available. Use executeRecord() instead.');
            }
            
            const result = await this.services.executionService.execute(
                endpointConfig,
                executionOptions
            );

            // Broadcast execution started event
            const startedEvent = createEventMessage(
                ExecutionMessageTypes.EXECUTION_STARTED,
                'execution',
                'medium',
                {
                    executionId: result.executionId,
                    endpointName: endpointConfig.name || 'unnamed',
                    startTime: Date.now(),
                    correlationId
                }
            );
            await this.broadcastEvent(startedEvent);

            return result;
        } catch (error) {
            this.logError('Execution failed', error instanceof Error ? error : new Error(String(error)));
            
            // Broadcast execution error event
            const errorEvent = createEventMessage(
                ExecutionMessageTypes.EXECUTION_ERROR,
                'error',
                'high',
                {
                    executionId: 'unknown',
                    error: error instanceof Error ? error.message : String(error),
                    stage: 'execution',
                    timestamp: Date.now()
                }
            );
            await this.broadcastEvent(errorEvent);
            
            throw error;
        }
    }

    /**
     * Validate execution with service
     */
    protected async validateExecution(
        endpointConfig: APIEndpointConfig,
        executionOptions: ExecutionOptions
    ): Promise<ValidationResult> {
        try {
            this.log(`Validating execution for: ${endpointConfig.name || 'unnamed'}`);
            
            const result = await this.services.executionValidationService.validateExecution(
                endpointConfig,
                executionOptions
            );

            if (!result.canExecute && result.error) {
                this.logError('Validation failed', new Error(result.error));
            }

            return result;
        } catch (error) {
            this.logError('Validation error', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Cancel execution with service
     */
    public async cancelExecution(executionId: string): Promise<void> {
        try {
            this.log(`Cancelling execution: ${executionId}`);
            await this.services.executionService.cancel(executionId);
        } catch (error) {
            this.logError(`Failed to cancel execution: ${executionId}`, error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Get execution status with service
     */
    public async getExecutionStatus(executionId: string): Promise<string> {
        try {
            return await this.services.executionService.getExecutionStatus(executionId);
        } catch (error) {
            this.logError(`Failed to get execution status: ${executionId}`, error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Get execution table with service
     */
    public async getExecutionTable(options?: Record<string, unknown>): Promise<ExecutionTableResult> {
        try {
            this.log('Getting execution table');
            return await this.services.executionMetadataService.getExecutionTable(options);
        } catch (error) {
            this.logError('Failed to get execution table', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Create result files with service
     * @deprecated This method is deprecated. Use createResponseFile instead.
     */
    protected async createResultFiles(
        response: Record<string, unknown>,
        endpointConfig: APIEndpointConfig,
        duration: number,
        executionId: string
    ): Promise<{requestFile: string, responseFile: string}> {
        throw new Error('createResultFiles is deprecated. Individual executions should pre-create request files and use createResponseFile instead.');
    }

    /**
     * Process execution-related messages
     */
    protected async processMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        try {
            if (isExecuteEndpointRequest(message)) {
                return await this.handleExecuteEndpoint(message);
            }
            
            if (isValidateExecutionRequest(message)) {
                return await this.handleValidateExecution(message);
            }
            
            if (isCancelExecutionRequest(message)) {
                return await this.handleCancelExecution(message);
            }
            
            if (isGetExecutionStatusRequest(message)) {
                return await this.handleGetExecutionStatus(message);
            }

            // Delegate to subclass for custom message handling
            return await this.handleCustomMessage(message);
        } catch (error) {
            this.logError('Message processing failed', error instanceof Error ? error : new Error(String(error)));
            
            if (message.type.includes('request')) {
                return createErrorResponseMessage(
                    message.correlationId,
                    error instanceof Error ? error : new Error(String(error)),
                    'PROCESSING_ERROR'
                );
            }
        }
    }

    /**
     * Handle execute endpoint request
     */
    private async handleExecuteEndpoint(message: ExecuteEndpointRequest): Promise<ExecutionResultResponse> {
        const { endpointConfig, executionOptions, correlationId } = message.payload;
        
        const result = await this.executeEndpoint(endpointConfig, executionOptions, correlationId);
        
        return createResponseMessage(
            message.correlationId,
            true,
            result
        ) as ExecutionResultResponse;
    }

    /**
     * Handle validate execution request
     */
    private async handleValidateExecution(message: ValidateExecutionRequest): Promise<ValidationResultResponse> {
        const { endpointConfig, executionOptions } = message.payload;
        
        const result = await this.validateExecution(endpointConfig, executionOptions);
        
        return createResponseMessage(
            message.correlationId,
            true,
            result
        ) as ValidationResultResponse;
    }

    /**
     * Handle cancel execution request
     */
    private async handleCancelExecution(message: CancelExecutionRequest): Promise<ResponseMessage> {
        const { executionId } = message.payload;
        
        await this.cancelExecution(executionId);
        
        return createResponseMessage(
            message.correlationId,
            true,
            { executionId, cancelled: true }
        );
    }

    /**
     * Handle get execution status request
     */
    private async handleGetExecutionStatus(message: GetExecutionStatusRequest): Promise<ResponseMessage> {
        const { executionId } = message.payload;
        
        const status = await this.getExecutionStatus(executionId);
        
        return createResponseMessage(
            message.correlationId,
            true,
            status
        );
    }

    /**
     * Handle custom messages (to be overridden by subclasses)
     */
    protected async handleCustomMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        this.log(`Unhandled message type: ${message.type}`);
        
        if (message.type.includes('request')) {
            return createErrorResponseMessage(
                message.correlationId,
                `Unsupported message type: ${message.type}`,
                'UNSUPPORTED_MESSAGE'
            );
        }
    }
}

/**
 * Service-aware webview for execution operations
 */
export abstract class ExecutionServiceAwareWebview extends ServiceAwareWebview {
    constructor(config: ServiceAwareConfig) {
        super({ ...config, componentName: config.componentName || 'ExecutionWebview' });
    }

    /**
     * Process execution-related messages from webview
     */
    protected async processMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        const executionAware = createExecutionServiceAware({
            serviceContainer: this.serviceContainer,
            messageDispatcher: this.messageDispatcher,
            extensionContext: this.extensionContext,
            componentName: this.componentName,
            enableLogging: this.enableLogging
        });

        return await executionAware['processMessage'](message);
    }

    /**
     * Show execution progress to user
     */
    protected async showExecutionProgress(executionId: string): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Execution ${executionId}`,
                cancellable: true
            },
            async (progress, token) => {
                progress.report({ message: 'Starting execution...' });
                
                // Monitor execution status
                const checkStatus = async (): Promise<void> => {
                    try {
                        const status = await this.getExecutionStatus(executionId);
                        
                        if (status === ExecutionStatus.COMPLETED) {
                            progress.report({ message: 'Execution completed', increment: 100 });
                            return;
                        }
                        
                        if (status === ExecutionStatus.ERROR) {
                            throw new Error('Execution failed');
                        }
                        
                        // For running executions, just show status
                        progress.report({ 
                            message: `Status: ${status}`
                        });
                        
                        // Check cancellation
                        if (token.isCancellationRequested) {
                            await this.cancelExecution(executionId);
                            throw new Error('Execution cancelled by user');
                        }
                        
                        // Continue monitoring
                        setTimeout(checkStatus, 1000);
                    } catch (error) {
                        this.logError('Progress monitoring failed', error instanceof Error ? error : new Error(String(error)));
                        throw error;
                    }
                };
                
                await checkStatus();
            }
        );
    }

    /**
     * Get execution status (delegates to execution service)
     */
    private async getExecutionStatus(executionId: string): Promise<string> {
        return await this.services.executionService.getExecutionStatus(executionId);
    }

    /**
     * Cancel execution (delegates to execution service)
     */
    private async cancelExecution(executionId: string): Promise<void> {
        await this.services.executionService.cancel(executionId);
    }
}

/**
 * Service-aware tree provider for execution data
 */
export abstract class ExecutionServiceAwareTreeProvider<T> extends ServiceAwareTreeProvider<T> {
    constructor(config: ServiceAwareConfig) {
        super({ ...config, componentName: config.componentName || 'ExecutionTreeProvider' });
    }

    /**
     * Process execution-related messages
     */
    protected async processMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        const executionAware = createExecutionServiceAware({
            serviceContainer: this.serviceContainer,
            messageDispatcher: this.messageDispatcher,
            extensionContext: this.extensionContext,
            componentName: this.componentName,
            enableLogging: this.enableLogging
        });

        const result = await executionAware['processMessage'](message);
        
        // Refresh tree after execution operations
        if (message.type.startsWith('execution.') && result && 'success' in result && result.success) {
            this.refresh();
        }
        
        return result;
    }

    /**
     * Get execution data for tree
     */
    protected async getExecutionData(options?: Record<string, unknown>): Promise<ExecutionMetadata[]> {
        try {
            const table = await this.services.executionMetadataService.getExecutionTable(options);
            return table.executions || [];
        } catch (error) {
            this.logError('Failed to get execution data', error instanceof Error ? error : new Error(String(error)));
            return [];
        }
    }
}

/**
 * Factory functions for creating execution service-aware components
 */
export function createExecutionServiceAware(config: ServiceAwareConfig): ExecutionServiceAware {
    return new (class ConcreteExecutionServiceAware extends ExecutionServiceAware {
        protected async handleCustomMessage(message: BaseMessage): Promise<ResponseMessage | void> {
            // Default implementation
            return super.handleCustomMessage(message);
        }
    })(config);
}

export function createExecutionWebview(config: ServiceAwareConfig): ExecutionServiceAwareWebview {
    return new (class ConcreteExecutionWebview extends ExecutionServiceAwareWebview {
        // Can be extended with specific webview implementation
    })(config);
}

export function createExecutionTreeProvider<T>(config: ServiceAwareConfig): ExecutionServiceAwareTreeProvider<T> {
    return new (class ConcreteExecutionTreeProvider extends ExecutionServiceAwareTreeProvider<T> {
        getTreeItem(element: T): vscode.TreeItem {
            // Default implementation - should be overridden
            return new vscode.TreeItem('Item', vscode.TreeItemCollapsibleState.None);
        }
        
        getChildren(element?: T): vscode.ProviderResult<T[]> {
            // Default implementation - should be overridden
            return [];
        }
    })(config);
}