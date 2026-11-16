// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Page Object Pattern for Webview Testing
 * 
 * Provides high-level abstractions for interacting with webviews in tests.
 * This pattern encapsulates webview DOM interaction details and provides
 * stable, semantic methods for test scenarios.
 */

import * as vscode from 'vscode';

export interface WebviewPageObject {
    /**
     * Wait for webview to be ready
     */
    waitForReady(timeout?: number): Promise<void>;
    
    /**
     * Execute JavaScript in webview and return result
     */
    evaluateScript<T>(script: string): Promise<T>;
    
    /**
     * Send message to webview
     */
    sendMessage(message: any): Promise<void>;
    
    /**
     * Wait for message from webview
     */
    waitForMessage(messageType: string, timeout?: number): Promise<any>;
}

/**
 * Base class for webview page objects
 */
export abstract class BaseWebviewPageObject implements WebviewPageObject {
    protected panel: vscode.WebviewPanel;
    protected messageHandlers: Map<string, Function[]> = new Map();
    protected receivedMessages: any[] = [];

    constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.setupMessageHandling();
    }

    private setupMessageHandling(): void {
        this.panel.webview.onDidReceiveMessage(message => {
            this.receivedMessages.push(message);
            
            const handlers = this.messageHandlers.get(message.type);
            if (handlers) {
                handlers.forEach(handler => handler(message));
            }
        });
    }

    async waitForReady(timeout: number = 5000): Promise<void> {
        const start = Date.now();
        
        while (Date.now() - start < timeout) {
            try {
                const isReady = await this.evaluateScript<boolean>('document.readyState === "complete"');
                if (isReady) {
                    return;
                }
            } catch (err) {
                // Webview might not be ready yet
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        throw new Error(`Webview not ready within ${timeout}ms`);
    }

    async evaluateScript<T>(script: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const correlationId = `script-${Date.now()}-${Math.random()}`;
            
            // Set up one-time message handler for script result
            const cleanup = this.onMessage('scriptResult', (message: any) => {
                if (message.correlationId === correlationId) {
                    cleanup();
                    if (message.error) {
                        reject(new Error(message.error));
                    } else {
                        resolve(message.result);
                    }
                }
            });
            
            // Send script execution request
            this.sendMessage({
                type: 'executeScript',
                correlationId,
                script
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                cleanup();
                reject(new Error('Script execution timeout'));
            }, 5000);
        });
    }

    async sendMessage(message: any): Promise<void> {
        await this.panel.webview.postMessage(message);
    }

    async waitForMessage(messageType: string, timeout: number = 5000): Promise<any> {
        return new Promise((resolve, reject) => {
            // Check if message already received
            const existingMessage = this.receivedMessages.find(msg => msg.type === messageType);
            if (existingMessage) {
                resolve(existingMessage);
                return;
            }
            
            // Set up one-time handler
            const cleanup = this.onMessage(messageType, (message: any) => {
                cleanup();
                resolve(message);
            });
            
            // Timeout
            setTimeout(() => {
                cleanup();
                reject(new Error(`Message ${messageType} not received within ${timeout}ms`));
            }, timeout);
        });
    }

    protected onMessage(messageType: string, handler: Function): () => void {
        if (!this.messageHandlers.has(messageType)) {
            this.messageHandlers.set(messageType, []);
        }
        
        this.messageHandlers.get(messageType)!.push(handler);
        
        // Return cleanup function
        return () => {
            const handlers = this.messageHandlers.get(messageType);
            if (handlers) {
                const index = handlers.indexOf(handler);
                if (index > -1) {
                    handlers.splice(index, 1);
                }
            }
        };
    }
}

/**
 * Page object for Endpoint Management webview
 */
export class EndpointManagerPageObject extends BaseWebviewPageObject {
    /**
     * Open endpoint creation form
     */
    async openCreateEndpointForm(): Promise<void> {
        await this.evaluateScript(`
            const createButton = document.querySelector('[data-testid="create-endpoint-button"]') ||
                                document.querySelector('button:contains("Create")') ||
                                document.querySelector('.create-endpoint');
            if (createButton) {
                createButton.click();
                return true;
            }
            return false;
        `);
    }

    /**
     * Fill endpoint form with data
     */
    async fillEndpointForm(endpointData: {
        name: string;
        path: string;
        method: string;
        body?: string;
    }): Promise<void> {
        await this.evaluateScript(`
            const nameInput = document.querySelector('input[name="name"]') ||
                            document.querySelector('#endpoint-name');
            if (nameInput) nameInput.value = "${endpointData.name}";
            
            const pathInput = document.querySelector('input[name="path"]') ||
                            document.querySelector('#endpoint-path');
            if (pathInput) pathInput.value = "${endpointData.path}";
            
            const methodSelect = document.querySelector('select[name="method"]') ||
                               document.querySelector('#endpoint-method');
            if (methodSelect) methodSelect.value = "${endpointData.method}";
            
            ${endpointData.body ? `
                const bodyTextarea = document.querySelector('textarea[name="body"]') ||
                                   document.querySelector('#endpoint-body');
                if (bodyTextarea) bodyTextarea.value = \`${endpointData.body}\`;
            ` : ''}
            
            // Trigger change events
            [nameInput, pathInput, methodSelect].forEach(input => {
                if (input) {
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        `);
    }

    /**
     * Save endpoint
     */
    async saveEndpoint(): Promise<void> {
        await this.evaluateScript(`
            const saveButton = document.querySelector('[data-testid="save-endpoint-button"]') ||
                             document.querySelector('button:contains("Save")') ||
                             document.querySelector('.save-endpoint');
            if (saveButton) {
                saveButton.click();
                return true;
            }
            return false;
        `);
    }

    /**
     * Select an endpoint from the list
     */
    async selectEndpoint(endpointName: string): Promise<void> {
        await this.evaluateScript(`
            const endpoints = Array.from(document.querySelectorAll('[data-testid^="endpoint-item"]'));
            const targetEndpoint = endpoints.find(el => 
                el.textContent && el.textContent.includes("${endpointName}")
            );
            if (targetEndpoint) {
                targetEndpoint.click();
                return true;
            }
            return false;
        `);
    }

    /**
     * Upload CSV file for batch execution
     */
    async uploadCSVFile(csvContent: string): Promise<void> {
        // Create a blob with CSV content and simulate file upload
        await this.evaluateScript(`
            const csvData = \`${csvContent}\`;
            const blob = new Blob([csvData], { type: 'text/csv' });
            const file = new File([blob], 'test-data.csv', { type: 'text/csv' });
            
            const fileInput = document.querySelector('input[type="file"]') ||
                            document.querySelector('[data-testid="csv-upload"]');
            
            if (fileInput) {
                // Create a custom event to simulate file selection
                const event = new Event('change', { bubbles: true });
                Object.defineProperty(event, 'target', {
                    value: { files: [file] },
                    enumerable: true
                });
                fileInput.dispatchEvent(event);
                return true;
            }
            return false;
        `);
    }

    /**
     * Start batch execution
     */
    async startBatchExecution(): Promise<void> {
        await this.evaluateScript(`
            const startButton = document.querySelector('[data-testid="start-batch-button"]') ||
                              document.querySelector('button:contains("Start")') ||
                              document.querySelector('.start-batch');
            if (startButton) {
                startButton.click();
                return true;
            }
            return false;
        `);
    }

    /**
     * Wait for batch execution to complete
     */
    async waitForBatchCompletion(timeout: number = 30000): Promise<any> {
        return this.waitForMessage('batchCompleted', timeout);
    }

    /**
     * Get execution results
     */
    async getExecutionResults(): Promise<any> {
        return this.evaluateScript(`
            const resultsContainer = document.querySelector('[data-testid="execution-results"]') ||
                                   document.querySelector('.execution-results');
            if (resultsContainer) {
                return {
                    total: resultsContainer.querySelector('.total-count')?.textContent,
                    completed: resultsContainer.querySelector('.completed-count')?.textContent,
                    failed: resultsContainer.querySelector('.failed-count')?.textContent,
                    details: Array.from(resultsContainer.querySelectorAll('.result-item')).map(item => ({
                        status: item.querySelector('.status')?.textContent,
                        message: item.querySelector('.message')?.textContent
                    }))
                };
            }
            return null;
        `);
    }
}

/**
 * Page object for Execution Management webview
 */
export class ExecutionManagerPageObject extends BaseWebviewPageObject {
    /**
     * Get list of executions
     */
    async getExecutionList(): Promise<any[]> {
        return this.evaluateScript(`
            const executionRows = Array.from(document.querySelectorAll('[data-testid^="execution-row"]'));
            return executionRows.map(row => ({
                id: row.getAttribute('data-execution-id'),
                status: row.querySelector('.status')?.textContent,
                endpoint: row.querySelector('.endpoint')?.textContent,
                timestamp: row.querySelector('.timestamp')?.textContent
            }));
        `);
    }

    /**
     * Select an execution
     */
    async selectExecution(executionId: string): Promise<void> {
        await this.evaluateScript(`
            const executionRow = document.querySelector('[data-execution-id="${executionId}"]');
            if (executionRow) {
                executionRow.click();
                return true;
            }
            return false;
        `);
    }

    /**
     * View execution details
     */
    async viewExecutionDetails(executionId: string): Promise<any> {
        await this.selectExecution(executionId);
        
        return this.evaluateScript(`
            const detailsPanel = document.querySelector('[data-testid="execution-details"]');
            if (detailsPanel) {
                return {
                    request: detailsPanel.querySelector('.request-data')?.textContent,
                    response: detailsPanel.querySelector('.response-data')?.textContent,
                    status: detailsPanel.querySelector('.execution-status')?.textContent,
                    duration: detailsPanel.querySelector('.execution-duration')?.textContent
                };
            }
            return null;
        `);
    }

    /**
     * Cancel running execution
     */
    async cancelExecution(executionId: string): Promise<void> {
        await this.selectExecution(executionId);
        
        await this.evaluateScript(`
            const cancelButton = document.querySelector('[data-testid="cancel-execution-button"]');
            if (cancelButton) {
                cancelButton.click();
                return true;
            }
            return false;
        `);
    }
}

/**
 * Factory for creating page objects
 */
export class WebviewPageObjectFactory {
    /**
     * Create endpoint manager page object
     */
    static createEndpointManager(panel: vscode.WebviewPanel): EndpointManagerPageObject {
        return new EndpointManagerPageObject(panel);
    }

    /**
     * Create execution manager page object
     */
    static createExecutionManager(panel: vscode.WebviewPanel): ExecutionManagerPageObject {
        return new ExecutionManagerPageObject(panel);
    }

    /**
     * Wait for webview panel to be created and return appropriate page object
     */
    static async waitForWebviewPanel(
        title: string, 
        timeout: number = 10000
    ): Promise<vscode.WebviewPanel> {
        const start = Date.now();
        
        while (Date.now() - start < timeout) {
            // Check for existing panels
            const extension = vscode.extensions.getExtension('dobermann');
            if (extension?.isActive) {
                // Access webview panels through extension API
                const api = extension.exports;
                if (api?.getWebviewPanel) {
                    const panel = api.getWebviewPanel(title);
                    if (panel) {
                        return panel;
                    }
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        throw new Error(`Webview panel "${title}" not found within ${timeout}ms`);
    }
}

/**
 * Test helper for webview scenarios
 */
export class WebviewTestHelper {
    /**
     * Execute a complete endpoint creation and execution scenario
     */
    static async executeEndpointScenario(
        endpointData: {
            name: string;
            path: string;
            method: string;
            body?: string;
        },
        csvData: string
    ): Promise<any> {
        // Open endpoint manager
        await vscode.commands.executeCommand('dbmn.openEndpointManager');
        
        // Wait for webview and create page object
        const panel = await WebviewPageObjectFactory.waitForWebviewPanel('Endpoint Manager');
        const endpointManager = WebviewPageObjectFactory.createEndpointManager(panel);
        
        // Wait for webview to be ready
        await endpointManager.waitForReady();
        
        // Create endpoint
        await endpointManager.openCreateEndpointForm();
        await endpointManager.fillEndpointForm(endpointData);
        await endpointManager.saveEndpoint();
        
        // Upload CSV and execute
        await endpointManager.uploadCSVFile(csvData);
        await endpointManager.startBatchExecution();
        
        // Wait for completion and get results
        await endpointManager.waitForBatchCompletion();
        const results = await endpointManager.getExecutionResults();
        
        return results;
    }

    /**
     * Verify execution results in execution manager
     */
    static async verifyExecutionInManager(executionId: string): Promise<any> {
        // Open execution manager
        await vscode.commands.executeCommand('dbmn.openExecutionManager');
        
        // Wait for webview and create page object
        const panel = await WebviewPageObjectFactory.waitForWebviewPanel('Execution Manager');
        const executionManager = WebviewPageObjectFactory.createExecutionManager(panel);
        
        // Wait for webview to be ready
        await executionManager.waitForReady();
        
        // Get execution details
        const details = await executionManager.viewExecutionDetails(executionId);
        
        return details;
    }
}