// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';

export class GeneralWebviewManager extends WebviewBase {
    constructor(context: vscode.ExtensionContext) {
        super(context);
    }

    getWebviewType(): string {
        return 'general';
    }

    async getHtmlContent(config: WebviewConfig): Promise<string> {
        const template = this.loadTemplate('general.html');
        const cssUris = this.getSharedCssUris();
        const cssLinks = `
            <link rel="stylesheet" href="${cssUris.atomic}">
            <link rel="stylesheet" href="${cssUris.core}">
            <link rel="stylesheet" href="${cssUris.modals}">
            <link rel="stylesheet" href="${cssUris.tables}">
        `;
        const scriptUri = this.getWebviewUri('general/general.js');

        return this.substituteTemplate(template, {
            SHARED_STYLES: cssLinks,
            GENERAL_SCRIPT: scriptUri.toString()
        });
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        // General webview doesn't handle any specific messages
        // All shared messages are handled by the base class
    }
}