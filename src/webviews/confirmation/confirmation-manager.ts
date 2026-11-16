// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import * as path from 'path';
import { applyPanelIcon } from '../../services/ui/panel-icon';

export interface ConfirmationData {
    message: string;
    executionLabel: string;
    executionType: string;
    executionId: string;
    filesToDelete: string[];
}

export interface ConfirmationResponse {
    confirmed: boolean;
    dontAskAgain: boolean;
}

/**
 * Manager for the confirmation modal webview
 */
export class ConfirmationManager {
    private panel: vscode.WebviewPanel | undefined;
    private resolvePromise: ((response: ConfirmationResponse) => void) | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Show confirmation dialog and return user response
     */
    async showConfirmation(data: ConfirmationData): Promise<ConfirmationResponse> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.createWebviewPanel(data);
        });
    }

    private createWebviewPanel(data: ConfirmationData) {
        // Create webview panel - modal style
        this.panel = vscode.window.createWebviewPanel(
            'dbmn.confirmation',
            'Confirm Deletion',
            {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false
            },
            {
                enableScripts: true,
                enableFindWidget: false,
                retainContextWhenHidden: false,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webviews')
                ]
            }
        );

        applyPanelIcon(this.panel, this.context.extensionUri);

        // Set HTML content
        this.panel.webview.html = this.getWebviewContent();

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            (message) => {
                switch (message.type) {
                    case 'confirmationResponse':
                        this.handleConfirmationResponse(message);
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                // If panel is closed without response, treat as cancel
                if (this.resolvePromise) {
                    this.resolvePromise({ confirmed: false, dontAskAgain: false });
                    this.resolvePromise = undefined;
                }
            },
            null,
            this.context.subscriptions
        );

        // Send data to webview after creation
        setTimeout(() => {
            if (this.panel) {
                this.panel.webview.postMessage({
                    type: 'setConfirmationData',
                    data: data
                });
            }
        }, 100);
    }

    private handleConfirmationResponse(message: any) {
        if (this.resolvePromise) {
            const response: ConfirmationResponse = {
                confirmed: message.response === 'delete',
                dontAskAgain: message.dontAskAgain || false
            };
            
            this.resolvePromise(response);
            this.resolvePromise = undefined;
        }

        // Close the panel
        if (this.panel) {
            this.panel.dispose();
        }
    }

    private getWebviewContent(): string {
        const webviewUri = vscode.Uri.joinPath(
            this.context.extensionUri,
            'out',
            'webviews',
            'confirmation',
            'confirmation.html'
        );

        try {
            // Read the HTML file content
            const fs = require('fs');
            const htmlPath = path.join(this.context.extensionPath, 'out', 'webviews', 'confirmation', 'confirmation.html');
            
            if (fs.existsSync(htmlPath)) {
                let htmlContent = fs.readFileSync(htmlPath, 'utf8');
                
                // Replace relative paths with webview URIs for split CSS files
                const getCssUri = (fileName: string) => this.panel!.webview.asWebviewUri(
                    vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webviews', 'shared', fileName)
                );

                // No shared CSS — confirmation modal is self-contained to avoid core.css !important conflicts
                const cssLinks = ``;

                htmlContent = htmlContent.replace(
                    'href="../shared/styles.css"',
                    cssLinks
                );
                
                return htmlContent;
            }
        } catch (error) {
            console.error('Error reading confirmation HTML:', error);
        }

        // Fallback inline HTML if file reading fails
        return this.getFallbackHtml();
    }

    private getFallbackHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirm Action</title>
    <!-- No shared CSS — self-contained modal -->
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            min-height: 100vh;
        }

        .modal-container {
            max-width: 500px;
            margin: 0 auto;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .modal-header {
            display: flex;
            align-items: center;
            margin-bottom: 16px;
        }

        .modal-icon {
            width: 24px;
            height: 24px;
            margin-right: 12px;
            color: var(--vscode-notificationsWarningIcon-foreground);
        }

        .modal-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin: 0;
        }

        .modal-content {
            margin-bottom: 24px;
        }

        .warning-message {
            background: var(--vscode-editorWarning-background);
            border-left: 4px solid var(--vscode-notificationsWarningIcon-foreground);
            padding: 12px 16px;
            margin: 16px 0;
            border-radius: 4px;
        }

        .execution-details {
            background: var(--vscode-editor-inactiveSelectionBackground);
            padding: 12px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            border: 1px solid var(--vscode-input-border);
            margin: 12px 0;
        }

        .checkbox-container {
            display: flex;
            align-items: center;
            margin: 16px 0;
            padding: 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }

        .checkbox-container input[type="checkbox"] {
            margin-right: 8px;
            accent-color: var(--vscode-button-background);
        }

        .checkbox-container label {
            font-size: 14px;
            cursor: pointer;
            user-select: none;
        }

        .modal-actions {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
        }

        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            min-width: 80px;
            transition: all 0.2s ease;
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-danger {
            background: var(--vscode-errorList-errorForeground);
            color: var(--vscode-editor-background);
        }

        .btn-danger:hover {
            opacity: 0.9;
        }

        .files-list {
            max-height: 120px;
            overflow-y: auto;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            margin: 8px 0;
        }

        .file-item {
            padding: 4px 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .file-item:last-child {
            border-bottom: none;
        }
    </style>
</head>
<body>
    <div class="modal-container">
        <div class="modal-header">
            <svg class="modal-icon" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8.982 1.566a1.13 1.13 0 0 0-1.964 0L.165 13.233c-.457.778.091 1.767.982 1.767h13.706c.89 0 1.438-.99.982-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
            </svg>
            <h2 class="modal-title">Confirm Deletion</h2>
        </div>

        <div class="modal-content">
            <p id="confirmation-message">Are you sure you want to delete this transaction?</p>
            
            <div class="warning-message">
                <strong>⚠️ Warning:</strong> This action cannot be undone. The transaction record and all associated files will be permanently deleted.
            </div>

            <div class="execution-details" id="execution-details">
                <!-- Execution details will be populated here -->
            </div>

            <div id="files-section" style="display: none;">
                <p><strong>Files to be deleted:</strong></p>
                <div class="files-list" id="files-list">
                    <!-- Files list will be populated here -->
                </div>
            </div>

            <div class="checkbox-container">
                <input type="checkbox" id="dont-ask-again" />
                <label for="dont-ask-again">Don't ask me again for transaction deletions</label>
            </div>
        </div>

        <div class="modal-actions">
            <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
            <button class="btn btn-danger" id="delete-btn">Delete</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Get DOM elements
        const confirmationMessage = document.getElementById('confirmation-message');
        const executionDetails = document.getElementById('execution-details');
        const filesSection = document.getElementById('files-section');
        const filesList = document.getElementById('files-list');
        const dontAskAgain = document.getElementById('dont-ask-again');
        const cancelBtn = document.getElementById('cancel-btn');
        const deleteBtn = document.getElementById('delete-btn');

        // Handle incoming messages
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.type === 'setConfirmationData') {
                populateConfirmationData(message.data);
            }
        });

        function populateConfirmationData(data) {
            // Update confirmation message
            confirmationMessage.textContent = data.message || 'Are you sure you want to delete this transaction?';
            
            // Update execution details
            if (data.executionLabel) {
                executionDetails.innerHTML = 
                    '<strong>Transaction:</strong> ' + escapeHtml(data.executionLabel) + '<br>' +
                    '<strong>Type:</strong> ' + escapeHtml(data.executionType || 'execution') + '<br>' +
                    (data.executionId ? '<strong>ID:</strong> ' + escapeHtml(data.executionId) + '<br>' : '');
            }
            
            // Update files list
            if (data.filesToDelete && data.filesToDelete.length > 0) {
                filesSection.style.display = 'block';
                filesList.innerHTML = data.filesToDelete.map(file => 
                    '<div class="file-item">📄 ' + escapeHtml(getFileName(file)) + '</div>'
                ).join('');
            } else {
                filesSection.style.display = 'none';
            }
        }

        function escapeHtml(text) {
            const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return text.replace(/[&<>"']/g, function(m) { return map[m]; });
        }

        function getFileName(filePath) {
            return filePath.split('/').pop() || filePath.split('\\\\').pop() || filePath;
        }

        // Event handlers
        cancelBtn.addEventListener('click', function() {
            vscode.postMessage({
                type: 'confirmationResponse',
                response: 'cancel'
            });
        });

        deleteBtn.addEventListener('click', function() {
            vscode.postMessage({
                type: 'confirmationResponse',
                response: 'delete',
                dontAskAgain: dontAskAgain.checked
            });
        });

        // Handle keyboard shortcuts
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                cancelBtn.click();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                deleteBtn.click();
            }
        });

        // Focus management
        deleteBtn.focus();
    </script>
</body>
</html>`;
    }

    /**
     * Dispose of the manager
     */
    dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
    }
}