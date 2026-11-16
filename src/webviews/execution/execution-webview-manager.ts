// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service-Aware ExecutionWebviewManager
 * 
 * Following Architecture.md - Service Integration patterns
 * Migrated from legacy WebviewBase to ExecutionServiceAwareWebview
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionServiceAwareWebview } from '../../base/execution-service-aware';
import { ServiceAwareConfig } from '../../base/service-aware-base';
import {
    BaseMessage,
    ResponseMessage,
    createResponseMessage,
    createErrorResponseMessage
} from '../../types/base-message';
import {
    ExecuteEndpointRequest,
    ValidateExecutionRequest,
    CancelExecutionRequest,
    GetExecutionStatusRequest,
    GetExecutionTableRequest,
    OpenFilesRequest,
    DeleteExecutionRequest,
    ExecutionMessageTypes,
    isExecuteEndpointRequest,
    isValidateExecutionRequest,
    isCancelExecutionRequest,
    isGetExecutionStatusRequest,
    isGetExecutionTableRequest
} from '../../types/execution-messages';

export interface ExecutionWebviewConfig {
    endpointId?: string;
    viewType?: 'execution' | 'table';
}

export class ExecutionWebviewManager extends ExecutionServiceAwareWebview {
    private currentExecutionId?: string;

    constructor(config: ServiceAwareConfig) {
        super(config);
    }

    /**
     * Create execution webview - overloaded to handle both WebviewConfig and ExecutionWebviewConfig
     */
    async createWebview(webviewConfig: ExecutionWebviewConfig | any): Promise<vscode.WebviewPanel> {
        // Convert WebviewConfig to ExecutionWebviewConfig if needed
        const config: ExecutionWebviewConfig = {
            endpointId: webviewConfig.itemId || webviewConfig.endpointId,
            viewType: webviewConfig.data?.viewType || 'execution'
        };
        const title = config.viewType === 'table' 
            ? 'API Execution History' 
            : `API Execution - ${config.endpointId || 'New Execution'}`;

        const panel = this.createWebviewPanel(
            'execution',
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.extensionContext.extensionPath, 'dist', 'webviews'))
                ]
            }
        );

        // Set HTML content
        const html = await this.generateHtmlContent(config);
        this.setWebviewHtml(html);

        return panel;
    }

    /**
     * Generate HTML content for webview
     */
    private async generateHtmlContent(config: ExecutionWebviewConfig): Promise<string> {
        const htmlFileName = config.viewType === 'table' ? 'execution-table.html' : 'execution.html';
        const htmlPath = path.join(this.extensionContext.extensionPath, 'dist', 'webviews', 'execution', htmlFileName);
        
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Get CSS URIs for linked stylesheets
        const getCssUri = (fileName: string) => {
            const cssPath = path.join(this.extensionContext.extensionPath, 'dist', 'webviews', 'shared', fileName);
            return this.getWebviewUri(cssPath);
        };

        const cssLinks = `
            <link rel="stylesheet" href="${getCssUri('atomic.css')}">
            <link rel="stylesheet" href="${getCssUri('core.css')}">
            <link rel="stylesheet" href="${getCssUri('modals.css')}">
            <link rel="stylesheet" href="${getCssUri('tables.css')}">
        `;
        
        // Get endpoint details if provided
        let endpointName = 'API Execution';
        let endpointMethod = 'POST';
        let endpointPath = '/api/endpoint';
        
        if (config.endpointId) {
            try {
                // Get endpoint details from service container if needed
                // For now, use defaults
                endpointName = `Endpoint ${config.endpointId}`;
            } catch (error) {
                this.logError('Error getting endpoint details', error instanceof Error ? error : new Error(String(error)));
            }
        }
        
        // Get environment name (simplified)
        const environmentName = 'Active Environment';
        
        // Replace placeholders
        html = html.replace(/{{SHARED_STYLES}}/g, cssLinks);
        html = html.replace(/{{ENDPOINT_ID}}/g, config.endpointId || 'new-execution');
        html = html.replace(/{{ENDPOINT_NAME}}/g, endpointName);
        html = html.replace(/{{ENDPOINT_METHOD}}/g, endpointMethod);
        html = html.replace(/{{ENDPOINT_PATH}}/g, endpointPath);
        html = html.replace(/{{ENVIRONMENT_NAME}}/g, environmentName);
        
        return html;
    }

    /**
     * Process execution-related messages from webview
     */
    protected async processMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        this.log(`Processing message: ${message.type}`);

        try {
            // Handle execution-specific messages
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
            
            if (isGetExecutionTableRequest(message)) {
                return await this.handleGetExecutionTable(message);
            }

            // Handle legacy message types for backward compatibility
            return await this.handleLegacyMessage(message);

        } catch (error) {
            this.logError(`Error processing message ${message.type}`, error instanceof Error ? error : new Error(String(error)));
            
            if (message.type.includes('request') || (message as any).expectsResponse) {
                return createErrorResponseMessage(
                    message.correlationId,
                    error instanceof Error ? error : new Error(String(error)),
                    'MESSAGE_PROCESSING_ERROR'
                );
            }
        }
    }

    /**
     * Handle execute endpoint request
     */
    private async handleExecuteEndpoint(message: ExecuteEndpointRequest): Promise<ResponseMessage> {
        const { endpointConfig, executionOptions } = message.payload;
        
        try {
            // Execute endpoint using service
            if (!this.services.executionService.execute) {
                throw new Error('ExecutionService.execute() method not available. Use executeRecord() instead.');
            }
            const result = await this.services.executionService.execute(endpointConfig, executionOptions);
            
            // Store current execution ID for cancellation
            this.currentExecutionId = result.executionId;
            
            // Show execution progress
            if (result.executionId) {
                await this.showExecutionProgress(result.executionId);
            }
            
            return createResponseMessage(
                message.correlationId,
                true,
                {
                    executionId: result.executionId,
                    status: 'started',
                    startTime: Date.now()
                }
            );
            
        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'EXECUTION_FAILED'
            );
        }
    }

    /**
     * Handle validate execution request
     */
    private async handleValidateExecution(message: ValidateExecutionRequest): Promise<ResponseMessage> {
        const { endpointConfig, executionOptions } = message.payload;
        
        try {
            const validationResult = await this.services.executionValidationService.validateExecution(endpointConfig, executionOptions);
            
            return createResponseMessage(
                message.correlationId,
                true,
                validationResult
            );
            
        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'VALIDATION_FAILED'
            );
        }
    }

    /**
     * Handle cancel execution request
     */
    private async handleCancelExecution(message: CancelExecutionRequest): Promise<ResponseMessage> {
        const { executionId } = message.payload;
        
        try {
            await this.services.executionService.cancel(executionId);
            
            if (this.currentExecutionId === executionId) {
                this.currentExecutionId = undefined;
            }
            
            return createResponseMessage(
                message.correlationId,
                true,
                { executionId, cancelled: true }
            );
            
        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'CANCELLATION_FAILED'
            );
        }
    }

    /**
     * Handle get execution status request
     */
    private async handleGetExecutionStatus(message: GetExecutionStatusRequest): Promise<ResponseMessage> {
        const { executionId } = message.payload;
        
        try {
            const status = await this.services.executionService.getExecutionStatus(executionId);
            
            return createResponseMessage(
                message.correlationId,
                true,
                status
            );
            
        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'STATUS_RETRIEVAL_FAILED'
            );
        }
    }

    /**
     * Handle get execution table request
     */
    private async handleGetExecutionTable(message: GetExecutionTableRequest): Promise<ResponseMessage> {
        const { page, pageSize, filters } = message.payload;
        
        try {
            
            // Use unified execution history to combine batches and executions
            const unifiedHistory = await this.services.executionMetadataService.getUnifiedExecutionHistory();
            
            // Apply pagination
            const startIndex = ((page || 1) - 1) * (pageSize || 25);
            const endIndex = startIndex + (pageSize || 25);
            const paginatedExecutions = unifiedHistory.slice(startIndex, endIndex);
            
            // Convert to expected table format
            const tableData = {
                executions: paginatedExecutions,
                totalCount: unifiedHistory.length,
                page: page || 1,
                pageSize: pageSize || 25,
                totalPages: Math.ceil(unifiedHistory.length / (pageSize || 25))
            };
            
            
            return createResponseMessage(
                message.correlationId,
                true,
                tableData
            );
            
        } catch (error) {
            console.error('[ExecutionWebview] Error getting unified execution table:', error);
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'TABLE_RETRIEVAL_FAILED'
            );
        }
    }

    /**
     * Handle legacy message types for backward compatibility
     */
    private async handleLegacyMessage(message: BaseMessage): Promise<ResponseMessage | void> {
        const legacyType = message.type;

        switch (legacyType) {
            case 'validateExecution':
                return await this.handleLegacyValidation(message);
                
            case 'startExecution':
            case 'executeAfterValidation':
                return await this.handleLegacyExecution(message);
                
            case 'cancelExecution':
                return await this.handleLegacyCancellation(message);
                
            case 'loadExecutionTable':
                return await this.handleLegacyTableLoad(message);
                
            case 'loadExecutionStats':
                return await this.handleLegacyStatsLoad(message);
                
            case 'viewRequestFile':
            case 'viewResponseFile':
            case 'viewFile':
                return await this.handleLegacyFileView(message);
                
            case 'deleteExecution':
                return await this.handleLegacyDelete(message);
                
            default:
                this.log(`Unknown legacy message type: ${legacyType}`);
                return createErrorResponseMessage(
                    message.correlationId,
                    `Unsupported message type: ${legacyType}`,
                    'UNSUPPORTED_MESSAGE'
                );
        }
    }

    /**
     * Handle legacy validation message
     */
    private async handleLegacyValidation(message: BaseMessage): Promise<ResponseMessage> {
        const payload = message.payload as Record<string, unknown> | undefined;
        const endpointId = payload?.endpointId as string | undefined;
        
        try {
            // Create basic endpoint config from legacy message
            const endpointConfig = {
                id: endpointId || 'unknown',
                name: `Legacy Endpoint ${endpointId}`,
                path: '/api/legacy',
                method: 'POST' as const,
                headers: {},
                queryParams: {},
                body: '',
                folder: '',
                description: ''
            };
            const executionOptions = {};

            const validationResult = await this.services.executionValidationService.validateExecution(endpointConfig, executionOptions);
            
            // Post legacy format message to webview
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'validationResult',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    environment: { name: 'Active Environment' },
                    validation: validationResult
                }
            });
            
            return createResponseMessage(message.correlationId, true, validationResult);
            
        } catch (error) {
            // Post legacy error message
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'validationResult',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    environment: { name: 'ERROR' },
                    validation: {
                        jwtValid: false,
                        orgValid: false,
                        locValid: false,
                        canExecute: false,
                        error: error instanceof Error ? error.message : String(error)
                    }
                }
            });
            
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'LEGACY_VALIDATION_FAILED'
            );
        }
    }

    /**
     * Handle legacy execution message
     */
    private async handleLegacyExecution(message: BaseMessage): Promise<ResponseMessage> {
        const payload = message.payload as Record<string, unknown> | undefined;
        const endpointId = payload?.endpointId as string | undefined;
        
        try {
            // Create basic endpoint config from legacy message
            const endpointConfig = {
                id: endpointId || 'unknown',
                name: `Legacy Endpoint ${endpointId}`,
                path: '/api/legacy',
                method: 'POST' as const,
                headers: {},
                queryParams: {},
                body: '',
                folder: '',
                description: ''
            };
            const executionOptions = {};

            if (!this.services.executionService.execute) {
                throw new Error('ExecutionService.execute() method not available. Use executeRecord() instead.');
            }
            const result = await this.services.executionService.execute(endpointConfig, executionOptions);
            this.currentExecutionId = result.executionId;
            
            // Post legacy format messages
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'executionStarted',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    endpointId,
                    timestamp: Date.now()
                }
            });
            
            return createResponseMessage(message.correlationId, true, result);
            
        } catch (error) {
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'executionError',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'LEGACY_EXECUTION_FAILED'
            );
        }
    }

    /**
     * Handle legacy cancellation message
     */
    private async handleLegacyCancellation(message: BaseMessage): Promise<ResponseMessage> {
        if (this.currentExecutionId) {
            try {
                await this.services.executionService.cancel(this.currentExecutionId);
                
                await this.postMessage({
                    correlationId: message.correlationId,
                    type: 'executionCancelled',
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: {
                        endpointId: 'unknown',
                        timestamp: Date.now()
                    }
                });
                
                this.currentExecutionId = undefined;
                return createResponseMessage(message.correlationId, true, { cancelled: true });
                
            } catch (error) {
                return createErrorResponseMessage(
                    message.correlationId,
                    error instanceof Error ? error : new Error(String(error)),
                    'LEGACY_CANCELLATION_FAILED'
                );
            }
        }
        
        return createResponseMessage(message.correlationId, true, { cancelled: false, reason: 'No active execution' });
    }

    /**
     * Handle legacy table load message
     */
    private async handleLegacyTableLoad(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const payload = message.payload as Record<string, unknown> | undefined;
            const options = (payload?.options as Record<string, unknown>) || {};
            
            // Use unified execution history for legacy support too
            const unifiedHistory = await this.services.executionMetadataService.getUnifiedExecutionHistory();
            
            // Apply pagination from options
            const page = (options.page as number) || 1;
            const pageSize = (options.pageSize as number) || 25;
            const startIndex = (page - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const paginatedExecutions = unifiedHistory.slice(startIndex, endIndex);
            
            const tableData = {
                executions: paginatedExecutions,
                totalCount: unifiedHistory.length,
                page: page,
                pageSize: pageSize,
                totalPages: Math.ceil(unifiedHistory.length / pageSize)
            };
            
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'executionTableData',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    data: tableData  // Wrap in payload, but webview expects message.data
                }
            });
            
            return createResponseMessage(message.correlationId, true, tableData);
            
        } catch (error) {
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'loadingError',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'LEGACY_TABLE_LOAD_FAILED'
            );
        }
    }

    /**
     * Handle legacy stats load message
     */
    private async handleLegacyStatsLoad(message: BaseMessage): Promise<ResponseMessage> {
        try {
            const stats = await this.services.executionMetadataService.getExecutionStats();
            
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'executionStats',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    data: stats
                }
            });
            
            return createResponseMessage(message.correlationId, true, stats);
            
        } catch (error) {
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'loadingError',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    error: error instanceof Error ? error.message : 'Unknown error loading execution stats'
                }
            });
            
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'LEGACY_STATS_LOAD_FAILED'
            );
        }
    }

    /**
     * Handle legacy file view message
     */
    private async handleLegacyFileView(message: BaseMessage): Promise<ResponseMessage> {
        const payload = message.payload as Record<string, unknown> | undefined;
        const filePath = payload?.filePath as string | undefined;
        
        if (filePath) {
            try {
                const uri = vscode.Uri.file(filePath);
                await vscode.window.showTextDocument(uri, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Beside
                });
                
                await this.postMessage({
                    correlationId: message.correlationId,
                    type: 'fileOpened',
                    timestamp: Date.now(),
                    source: 'extension',
                    target: 'webview',
                    payload: {
                        filePath,
                        fileType: (payload?.fileType as string) || 'unknown'
                    }
                });
                
                return createResponseMessage(message.correlationId, true, { opened: true, filePath });
                
            } catch (error) {
                return createErrorResponseMessage(
                    message.correlationId,
                    error instanceof Error ? error : new Error(String(error)),
                    'FILE_OPEN_FAILED'
                );
            }
        }
        
        return createErrorResponseMessage(
            message.correlationId,
            'No file path provided',
            'INVALID_FILE_PATH'
        );
    }

    /**
     * Handle legacy delete message
     */
    private async handleLegacyDelete(message: BaseMessage): Promise<ResponseMessage> {
        const payload = message.payload as Record<string, unknown> | undefined;
        const executionId = payload?.executionId as string;
        
        try {
            await this.services.executionMetadataService.deleteExecution(executionId);
            
            await this.postMessage({
                correlationId: message.correlationId,
                type: 'executionDeleted',
                timestamp: Date.now(),
                source: 'extension',
                target: 'webview',
                payload: {
                    executionId
                }
            });
            
            return createResponseMessage(message.correlationId, true, { deleted: true, executionId });
            
        } catch (error) {
            return createErrorResponseMessage(
                message.correlationId,
                error instanceof Error ? error : new Error(String(error)),
                'LEGACY_DELETE_FAILED'
            );
        }
    }

    /**
     * Cancel any running execution on disposal
     */
    dispose(): void {
        if (this.currentExecutionId) {
            this.services.executionService.cancel(this.currentExecutionId).catch(error => {
                this.logError('Error cancelling execution during disposal', error instanceof Error ? error : new Error(String(error)));
            });
        }
        
        super.dispose();
    }
    
    /**
     * Override postMessage to convert BaseMessage to legacy format for webview compatibility
     */
    protected async postMessage(message: BaseMessage | Record<string, unknown>): Promise<boolean> {
        // Convert BaseMessage to legacy format that webview JavaScript expects
        const legacyMessage: Record<string, unknown> = {
            correlationId: (message as BaseMessage).correlationId,
            type: (message as BaseMessage).type,
            timestamp: (message as BaseMessage).timestamp,
            source: (message as BaseMessage).source,
            target: (message as BaseMessage).target
        };

        // For legacy compatibility, move specific payload data to top level
        const messagePayload = (message as BaseMessage).payload as Record<string, unknown> | undefined;
        if (messagePayload) {
            if (messagePayload.data) {
                legacyMessage.data = messagePayload.data;
            }
            if (messagePayload.error) {
                legacyMessage.error = messagePayload.error;
            }
            // Copy other payload fields to top level
            Object.keys(messagePayload).forEach(key => {
                if (key !== 'data' && key !== 'error') {
                    legacyMessage[key] = messagePayload[key];
                }
            });
        }
        
        // Send the legacy-formatted message to webview
        return await super.postMessage(legacyMessage);
    }
    
    /**
     * Check for unsaved changes (compatibility method for Dobermann)
     */
    async checkForUnsavedChanges(): Promise<boolean> {
        // ExecutionWebviewManager doesn't have unsaved changes concept
        // Always return false for compatibility
        return false;
    }
    
    /**
     * Show unsaved changes dialog (compatibility method for Dobermann)
     */
    async showUnsavedChangesDialog(): Promise<'save' | 'discard' | 'cancel'> {
        // ExecutionWebviewManager doesn't have unsaved changes concept
        // Always return 'discard' for compatibility
        return 'discard';
    }
    
    /**
     * Save current context (compatibility method for Dobermann)
     */
    async saveCurrentContext(): Promise<boolean> {
        // ExecutionWebviewManager doesn't have save concept
        // Always return true for compatibility
        return true;
    }
}

/**
 * Factory function to create ExecutionWebviewManager
 */
export function createExecutionWebviewManager(config: ServiceAwareConfig): ExecutionWebviewManager {
    return new ExecutionWebviewManager(config);
}