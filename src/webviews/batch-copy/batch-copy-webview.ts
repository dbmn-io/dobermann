// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Copy Webview (GitHub Issue #176)
 *
 * Dedicated webview for copying batches between environments.
 * Extends WebviewBase for consistent lifecycle management.
 *
 * Enhancements:
 * - ENV Variables section showing required vars and allowing temporary overrides
 * - Progress feedback during preparation and execution
 * - ENV variable validation before enabling Copy button
 * - targetEnvironmentId passthrough fix
 */

import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { IBatchCopyService } from '../../services/batch-copy/batch-copy.interface';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { PathResolver } from '../../utils/path-resolver';

export interface BatchCopyConfig extends WebviewConfig {
    sourceBatchId: string;
    batchName: string;
    environment: string;
    organization?: string;
    totalMembers: number;
    completedMembers: number;
    failedMembers: number;
    status: string;
    endpointId: string;
    endpointName: string;
}

export interface BatchCopyMessage extends WebviewMessage {
    type: 'validateCopyOperation' | 'executeBatchCopy' | 'getCurrentEnvironment'
        | 'getEndpointTemplate' | 'getEnvironmentVariables' | 'closeWebview' | 'showSuccessMessage';
    includeIncomplete?: boolean;
    sourceBatchId?: string;
    message?: string;
    targetEnvironment?: string;
    targetEnvironmentId?: string;
    targetOrganization?: string;
    environmentVariableOverrides?: Record<string, string>;
}

export class BatchCopyWebview extends WebviewBase {
    private batchCopyService: IBatchCopyService | undefined;
    private serviceContainer: IServiceContainer;

    constructor(context: vscode.ExtensionContext, serviceContainer: IServiceContainer) {
        super(context);
        this.serviceContainer = serviceContainer;

        // Resolve batch copy service
        try {
            this.batchCopyService = serviceContainer.resolve<IBatchCopyService>(ServiceTokens.BatchCopyService);
        } catch (error) {
            console.error('BatchCopyService not available:', error);
        }
    }

    getWebviewType(): string {
        return 'batchCopy';
    }

    protected getWebviewTitle(config: WebviewConfig): string {
        return 'Copy Batch to Environment';
    }

    async getHtmlContent(config: WebviewConfig): Promise<string> {
        const batchConfig = config as BatchCopyConfig;

        // Get webview URIs for resources using PathResolver
        const cssUris = this.getSharedCssUris();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copy Batch to Environment</title>
    <link rel="stylesheet" href="${cssUris.atomic}">
    <link rel="stylesheet" href="${cssUris.core}">
    <link rel="stylesheet" href="${cssUris.modals}">
    <link rel="stylesheet" href="${cssUris.tables}">
    <style>
        .copy-status-summary {
            display: flex;
            gap: 15px;
            align-items: center;
            margin-top: 5px;
        }

        .status-badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
        }

        .status-success {
            background-color: rgba(40, 167, 69, 0.2);
            color: var(--vscode-terminal-ansiGreen);
        }

        .status-failed {
            background-color: rgba(220, 53, 69, 0.2);
            color: var(--vscode-errorForeground);
        }

        .copy-preview {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 15px;
            margin: 10px 0;
        }

        .warning-message {
            background-color: rgba(255, 193, 7, 0.1);
            border: 1px solid var(--vscode-editorWarning-foreground);
            border-radius: 4px;
            padding: 12px;
            margin: 10px 0;
            color: var(--vscode-editorWarning-foreground);
            display: none;
        }

        .warning-message.show {
            display: block;
        }

        .current-environment {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }

        .checkbox-container {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 15px 0;
            padding: 10px;
            background-color: var(--vscode-input-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
        }

        .checkbox-container input[type="checkbox"] {
            width: auto;
            margin: 0;
        }

        .checkbox-container label {
            margin: 0;
            font-weight: normal;
            cursor: pointer;
        }

        .env-vars-table {
            width: 100%;
            border-collapse: collapse;
            margin: 8px 0;
        }

        .env-vars-table th,
        .env-vars-table td {
            padding: 6px 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .env-vars-table th {
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }

        .env-vars-table td input {
            width: 100%;
            padding: 4px 6px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }

        .env-vars-table td input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .env-var-missing {
            color: var(--vscode-errorForeground);
            font-weight: bold;
        }

        .env-var-override {
            border-color: var(--vscode-editorWarning-foreground) !important;
        }

        .env-vars-note {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 6px;
            font-style: italic;
        }

        .env-vars-warning {
            background-color: rgba(220, 53, 69, 0.1);
            border: 1px solid var(--vscode-errorForeground);
            border-radius: 4px;
            padding: 8px 12px;
            margin: 8px 0;
            color: var(--vscode-errorForeground);
            font-size: 12px;
            display: none;
        }

        .env-vars-warning.show {
            display: block;
        }

        .progress-container {
            display: none;
            margin: 10px 0;
            padding: 12px;
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }

        .progress-container.show {
            display: block;
        }

        .progress-text {
            font-size: 12px;
            color: var(--vscode-foreground);
            margin-bottom: 6px;
        }

        .progress-bar-track {
            width: 100%;
            height: 4px;
            background: var(--vscode-progressBar-background, rgba(255,255,255,0.1));
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-bar-fill {
            height: 100%;
            background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
            border-radius: 2px;
            transition: width 0.3s ease;
            width: 0%;
        }
    </style>
</head>
<body>
    <h2>Copy Batch to Environment</h2>

    <!-- Source Batch Information -->
    <div class="section">
        <h3>Source Batch</h3>
        <div class="execution-summary">
            <div class="summary-item">
                <span class="summary-label">Name:</span>
                <span id="sourceBatchName">${batchConfig.batchName}</span>
            </div>
            <div class="summary-item">
                <span class="summary-label">Environment:</span>
                <span id="sourceEnvironment">${batchConfig.environment}</span>
            </div>
            <div class="summary-item">
                <span class="summary-label">Organization:</span>
                <span id="sourceOrganization">${batchConfig.organization || 'None'}</span>
            </div>
            <div class="summary-item">
                <span class="summary-label">Total Transactions:</span>
                <span id="sourceTransactionCount">${batchConfig.totalMembers}</span>
            </div>
            <div class="summary-item">
                <span class="summary-label">Status Summary:</span>
                <div class="copy-status-summary">
                    <span class="status-badge status-success">${batchConfig.completedMembers} Completed</span>
                    <span class="status-badge status-failed">${batchConfig.failedMembers} Failed</span>
                </div>
            </div>
        </div>
    </div>

    <!-- Target Environment (Current Active) -->
    <div class="section">
        <h3>Copy To</h3>
        <div class="summary-item">
            <span class="summary-label">Target Environment:</span>
            <span id="targetEnvironment" class="current-environment">Loading current environment...</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Target Organization:</span>
            <span id="targetOrganization" class="current-environment">Loading...</span>
        </div>
    </div>

    <!-- ENV Variables Section (GitHub Issue #176) -->
    <div class="section" id="envVarsSection" style="display: none;">
        <h3>Environment Variables</h3>
        <div id="envVarsContent">
            <table class="env-vars-table">
                <thead>
                    <tr>
                        <th>Variable</th>
                        <th>Value (from target environment)</th>
                    </tr>
                </thead>
                <tbody id="envVarsTableBody">
                </tbody>
            </table>
            <div id="envVarsMissing" class="env-vars-warning">
                Missing required ENV variables. Copy cannot proceed until all variables have values.
            </div>
            <p class="env-vars-note">Editing here applies to this copy only. Environment configuration is not modified.</p>
        </div>
    </div>

    <!-- Copy Options -->
    <div class="section">
        <h3>Copy Options</h3>
        <div class="checkbox-container">
            <input type="checkbox" id="includeIncompleteCheckbox" checked>
            <label for="includeIncompleteCheckbox">
                Include incomplete transactions (failed/cancelled will be reset to pending)
            </label>
        </div>
    </div>

    <!-- Copy Preview -->
    <div class="section">
        <h3>What Will Be Copied</h3>
        <div class="copy-preview">
            <p><strong>Batch:</strong> ${batchConfig.batchName}</p>
            <p><strong>Transactions:</strong> <span id="transactionsToInclude">${batchConfig.totalMembers}</span> will be copied</p>
            <p><strong>Data:</strong> CSV data will be re-processed with target environment variables</p>
            <p><strong>Status:</strong> All copied transactions will be reset to "pending" for fresh execution</p>
            <p><strong>Target:</strong> <span id="targetPreview">Loading...</span></p>
        </div>

        <div id="warningMessage" class="warning-message">
            <strong>Warning:</strong> <span id="warningText"></span>
        </div>
    </div>

    <!-- Progress Container (GitHub Issue #176) -->
    <div id="progressContainer" class="progress-container">
        <div id="progressText" class="progress-text">Preparing...</div>
        <div class="progress-bar-track">
            <div id="progressBarFill" class="progress-bar-fill"></div>
        </div>
    </div>

    <!-- Footer with action buttons -->
    <div class="webview-footer">
        <div class="footer-content">
            <div class="footer-button-group">
                <button id="copyBtn" class="btn btn-primary" disabled>Copy Batch</button>
                <button id="cancelBtn" class="btn btn-danger">Cancel</button>
            </div>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let currentEnvironment = null;
            let currentEnvironmentId = null;
            let currentOrganization = null;
            let validationResult = null;
            let requiredEnvVars = [];
            let envVarValues = {};
            let envVarOverrides = {};
            let hasMissingEnvVars = false;

            // Configuration from backend
            const config = {
                sourceBatchId: '${batchConfig.sourceBatchId}',
                endpointId: '${batchConfig.endpointId}',
                totalMembers: ${batchConfig.totalMembers},
                completedMembers: ${batchConfig.completedMembers},
                failedMembers: ${batchConfig.failedMembers}
            };

            // Load current environment on startup
            loadCurrentEnvironment();

            // Handle messages from extension
            window.addEventListener('message', event => {
                const message = event.data;

                switch(message.type) {
                    case 'currentEnvironmentData':
                        handleEnvironmentData(message);
                        break;

                    case 'endpointTemplateData':
                        handleEndpointTemplate(message);
                        break;

                    case 'environmentVariablesData':
                        handleEnvironmentVariables(message);
                        break;

                    case 'batchCopyValidation':
                        handleValidationResult(message);
                        break;

                    case 'batchCopyComplete':
                        handleCopyComplete(message);
                        break;

                    case 'batchCopyError':
                        handleCopyError(message);
                        break;

                    case 'copyProgress':
                        handleCopyProgress(message);
                        break;
                }
            });

            // Event listeners
            document.getElementById('includeIncompleteCheckbox').addEventListener('change', updateTransactionCount);
            document.getElementById('cancelBtn').addEventListener('click', () => {
                vscode.postMessage({ type: 'closeWebview' });
            });
            document.getElementById('copyBtn').addEventListener('click', executeCopy);

            function loadCurrentEnvironment() {
                vscode.postMessage({ type: 'getCurrentEnvironment' });
            }

            function handleEnvironmentData(message) {
                if (message.environment) {
                    currentEnvironment = message.environment.name || 'Unknown';
                    currentEnvironmentId = message.environment.id || undefined;
                    // #424: the environment's org variable, if it keeps one
                    currentOrganization = (message.environment.variables && message.environment.variables.org) || null;

                    document.getElementById('targetEnvironment').textContent = currentEnvironment;
                    document.getElementById('targetOrganization').textContent = currentOrganization || 'None';

                    updateTargetPreview();

                    // Load endpoint template to extract required ENV vars
                    vscode.postMessage({
                        type: 'getEndpointTemplate',
                        endpointId: config.endpointId
                    });

                    // Load target environment variables
                    if (currentEnvironmentId) {
                        vscode.postMessage({
                            type: 'getEnvironmentVariables',
                            targetEnvironmentId: currentEnvironmentId
                        });
                    }

                    validateCopyOperation();
                }
            }

            function handleEndpointTemplate(message) {
                if (message.template) {
                    // Extract {{ENV:varName}} patterns from template
                    const envPattern = /\\{\\{ENV:([^}:]+)\\}\\}/g;
                    const matches = [];
                    let match;
                    while ((match = envPattern.exec(message.template)) !== null) {
                        if (!matches.includes(match[1])) {
                            matches.push(match[1]);
                        }
                    }
                    requiredEnvVars = matches;
                    renderEnvVarsTable();
                }
            }

            function handleEnvironmentVariables(message) {
                envVarValues = message.variables || {};
                renderEnvVarsTable();
            }

            function renderEnvVarsTable() {
                const section = document.getElementById('envVarsSection');
                const tbody = document.getElementById('envVarsTableBody');
                const missingWarning = document.getElementById('envVarsMissing');

                if (requiredEnvVars.length === 0) {
                    section.style.display = 'none';
                    hasMissingEnvVars = false;
                    updateCopyButtonState();
                    return;
                }

                section.style.display = 'block';
                tbody.innerHTML = '';
                hasMissingEnvVars = false;

                for (const varName of requiredEnvVars) {
                    const currentValue = envVarOverrides[varName] !== undefined
                        ? envVarOverrides[varName]
                        : (envVarValues[varName] || '');
                    const isMissing = !currentValue;
                    const isOverridden = envVarOverrides[varName] !== undefined;

                    if (isMissing) {
                        hasMissingEnvVars = true;
                    }

                    const tr = document.createElement('tr');

                    const tdName = document.createElement('td');
                    tdName.textContent = varName;
                    if (isMissing) {
                        tdName.classList.add('env-var-missing');
                    }

                    const tdValue = document.createElement('td');
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = currentValue;
                    input.placeholder = isMissing ? '(missing - required)' : '';
                    input.dataset.varName = varName;
                    if (isOverridden) {
                        input.classList.add('env-var-override');
                    }
                    input.addEventListener('input', function() {
                        const name = this.dataset.varName;
                        const originalValue = envVarValues[name] || '';
                        if (this.value !== originalValue) {
                            envVarOverrides[name] = this.value;
                            this.classList.add('env-var-override');
                        } else {
                            delete envVarOverrides[name];
                            this.classList.remove('env-var-override');
                        }
                        // Re-check missing vars
                        checkMissingVars();
                    });
                    tdValue.appendChild(input);

                    tr.appendChild(tdName);
                    tr.appendChild(tdValue);
                    tbody.appendChild(tr);
                }

                if (hasMissingEnvVars) {
                    missingWarning.classList.add('show');
                } else {
                    missingWarning.classList.remove('show');
                }

                updateCopyButtonState();
            }

            function checkMissingVars() {
                hasMissingEnvVars = false;
                for (const varName of requiredEnvVars) {
                    const currentValue = envVarOverrides[varName] !== undefined
                        ? envVarOverrides[varName]
                        : (envVarValues[varName] || '');
                    if (!currentValue) {
                        hasMissingEnvVars = true;
                        break;
                    }
                }

                const missingWarning = document.getElementById('envVarsMissing');
                if (hasMissingEnvVars) {
                    missingWarning.classList.add('show');
                } else {
                    missingWarning.classList.remove('show');
                }

                updateCopyButtonState();
            }

            function updateCopyButtonState() {
                const copyBtn = document.getElementById('copyBtn');
                if (hasMissingEnvVars) {
                    copyBtn.disabled = true;
                } else if (validationResult && validationResult.isValid) {
                    copyBtn.disabled = false;
                }
            }

            function updateTargetPreview() {
                const target = currentOrganization ?
                    currentEnvironment + '/' + currentOrganization :
                    currentEnvironment;
                document.getElementById('targetPreview').textContent = target;
            }

            function updateTransactionCount() {
                const includeIncomplete = document.getElementById('includeIncompleteCheckbox').checked;
                const count = includeIncomplete ? config.totalMembers : config.completedMembers;
                document.getElementById('transactionsToInclude').textContent = count;

                validateCopyOperation();
            }

            function validateCopyOperation() {
                if (!currentEnvironment) return;

                const includeIncomplete = document.getElementById('includeIncompleteCheckbox').checked;

                vscode.postMessage({
                    type: 'validateCopyOperation',
                    sourceBatchId: config.sourceBatchId,
                    includeIncomplete: includeIncomplete,
                    targetEnvironment: currentEnvironment,
                    targetEnvironmentId: currentEnvironmentId,
                    targetOrganization: currentOrganization
                });
            }

            function handleValidationResult(message) {
                validationResult = message.validation;

                const copyBtn = document.getElementById('copyBtn');
                const warningDiv = document.getElementById('warningMessage');
                const warningText = document.getElementById('warningText');

                if (validationResult.isValid) {
                    if (!hasMissingEnvVars) {
                        copyBtn.disabled = false;
                    }

                    if (validationResult.warningMessage) {
                        warningText.textContent = validationResult.warningMessage;
                        warningDiv.classList.add('show');
                    } else {
                        warningDiv.classList.remove('show');
                    }
                } else {
                    copyBtn.disabled = true;
                    warningText.textContent = validationResult.errorMessage;
                    warningDiv.classList.add('show');
                }
            }

            function executeCopy() {
                if (!validationResult || !validationResult.isValid || hasMissingEnvVars) {
                    return;
                }

                const includeIncomplete = document.getElementById('includeIncompleteCheckbox').checked;

                // Disable button and show progress
                const copyBtn = document.getElementById('copyBtn');
                copyBtn.disabled = true;
                copyBtn.textContent = 'Preparing...';

                const progressContainer = document.getElementById('progressContainer');
                progressContainer.classList.add('show');
                document.getElementById('progressText').textContent = 'Preparing batch copy...';
                document.getElementById('progressBarFill').style.width = '0%';

                // Build overrides - only include vars that were actually overridden
                const overrides = Object.keys(envVarOverrides).length > 0 ? envVarOverrides : undefined;

                vscode.postMessage({
                    type: 'executeBatchCopy',
                    sourceBatchId: config.sourceBatchId,
                    includeIncomplete: includeIncomplete,
                    targetEnvironment: currentEnvironment,
                    targetEnvironmentId: currentEnvironmentId,
                    targetOrganization: currentOrganization,
                    environmentVariableOverrides: overrides
                });
            }

            function handleCopyProgress(message) {
                const progressText = document.getElementById('progressText');
                const progressBarFill = document.getElementById('progressBarFill');

                if (message.message) {
                    progressText.textContent = message.message;
                }
                if (message.percent !== undefined) {
                    progressBarFill.style.width = message.percent + '%';
                }
            }

            function handleCopyComplete(message) {
                // Update progress to 100%
                document.getElementById('progressText').textContent = 'Copy complete! Starting execution...';
                document.getElementById('progressBarFill').style.width = '100%';

                // Show success message
                vscode.postMessage({
                    type: 'showSuccessMessage',
                    message: 'Batch copied successfully! ' + message.result.membersCopied + ' transactions copied to ' + currentEnvironment
                });

                // Close webview after brief delay
                setTimeout(() => {
                    vscode.postMessage({ type: 'closeWebview' });
                }, 500);
            }

            function handleCopyError(message) {
                // Re-enable button and hide progress
                const copyBtn = document.getElementById('copyBtn');
                copyBtn.disabled = false;
                copyBtn.textContent = 'Copy Batch';

                document.getElementById('progressContainer').classList.remove('show');

                // Show error in warning area
                const warningDiv = document.getElementById('warningMessage');
                const warningText = document.getElementById('warningText');
                warningText.textContent = 'Copy failed: ' + message.error;
                warningDiv.classList.add('show');
            }

            // Initial setup
            updateTransactionCount();

        })();
    </script>
</body>
</html>`;
    }

    async handleMessage(message: BatchCopyMessage): Promise<void> {
        switch (message.type) {
            case 'getCurrentEnvironment':
                await this.handleGetCurrentEnvironment();
                break;

            case 'getEndpointTemplate':
                await this.handleGetEndpointTemplate(message);
                break;

            case 'getEnvironmentVariables':
                await this.handleGetEnvironmentVariables(message);
                break;

            case 'validateCopyOperation':
                await this.handleValidateCopyOperation(message);
                break;

            case 'executeBatchCopy':
                await this.handleExecuteBatchCopy(message);
                break;

            case 'closeWebview':
                this.dispose();
                break;

            case 'showSuccessMessage':
                if (message.message) {
                    this.toast?.info(message.message);
                }
                break;
        }
    }

    private async handleGetCurrentEnvironment(): Promise<void> {
        try {
            // Get environment manager from service container
            const environmentManager = this.serviceContainer.resolve<any>(ServiceTokens.EnvironmentManager);
            const activeEnvironment = await environmentManager.getActiveEnvironment();

            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'currentEnvironmentData',
                    environment: activeEnvironment
                });
            }
        } catch (error) {
            console.error('Failed to get current environment:', error);
            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'currentEnvironmentData',
                    environment: { name: 'Unknown' }
                });
            }
        }
    }

    private async handleGetEndpointTemplate(message: BatchCopyMessage): Promise<void> {
        try {
            const endpointManager = this.serviceContainer.resolve<any>(ServiceTokens.EndpointManager);
            const endpointId = (message as any).endpointId;

            if (!endpointId) {
                return;
            }

            const endpoint = await endpointManager.getEndpoint(endpointId);
            const template = endpoint?.body || '{}';

            // Also check headers and query params for ENV vars
            const headersStr = JSON.stringify(endpoint?.headers || {});
            const queryParamsStr = JSON.stringify(endpoint?.queryParams || {});
            const fullTemplate = template + headersStr + queryParamsStr;

            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'endpointTemplateData',
                    template: fullTemplate
                });
            }
        } catch (error) {
            console.error('Failed to get endpoint template:', error);
        }
    }

    private async handleGetEnvironmentVariables(message: BatchCopyMessage): Promise<void> {
        try {
            const environmentManager = this.serviceContainer.resolve<any>(ServiceTokens.EnvironmentManager);
            const envId = message.targetEnvironmentId;

            if (!envId) {
                return;
            }

            const environment = await environmentManager.getEnvironment(envId);
            const variables = environment?.variables || {};

            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'environmentVariablesData',
                    variables
                });
            }
        } catch (error) {
            console.error('Failed to get environment variables:', error);
        }
    }

    private async handleValidateCopyOperation(message: BatchCopyMessage): Promise<void> {
        if (!this.batchCopyService) {
            console.error('[BatchCopyWebview] batchCopyService is not available');
            return;
        }

        if (!message.sourceBatchId) {
            console.error('[BatchCopyWebview] sourceBatchId is missing');
            return;
        }

        try {
            const validation = await this.batchCopyService.validateCopyOperation(
                message.sourceBatchId,
                {
                    includeIncomplete: message.includeIncomplete || false,
                    targetEnvironment: message.targetEnvironment || 'unknown',
                    targetEnvironmentId: message.targetEnvironmentId,
                    targetOrganization: message.targetOrganization
                }
            );

            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'batchCopyValidation',
                    validation
                });
            }
        } catch (error) {
            console.error('Validation failed:', error);
            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'batchCopyValidation',
                    validation: {
                        isValid: false,
                        errorMessage: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }
                });
            }
        }
    }

    private async handleExecuteBatchCopy(message: BatchCopyMessage): Promise<void> {
        if (!this.batchCopyService || !message.sourceBatchId) {
            return;
        }

        // Send initial progress
        if (this.panel) {
            this.panel.webview.postMessage({
                type: 'copyProgress',
                message: 'Preparing batch transactions...',
                percent: 10
            });
        }

        try {
            const result = await this.batchCopyService.copyBatch(
                message.sourceBatchId,
                {
                    includeIncomplete: message.includeIncomplete || false,
                    targetEnvironment: message.targetEnvironment || 'unknown',
                    targetEnvironmentId: message.targetEnvironmentId,
                    targetOrganization: message.targetOrganization,
                    environmentVariableOverrides: message.environmentVariableOverrides
                }
            );

            // Send completion progress
            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'copyProgress',
                    message: 'Starting execution...',
                    percent: 90
                });
            }

            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'batchCopyComplete',
                    result
                });
            }

            // Refresh the transaction tree to show the new batch
        } catch (error) {
            console.error('Batch copy failed:', error);
            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'batchCopyError',
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }
    }
}
