// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The design system's page in VS Code: a Hub tab showing the shared components
 * (src/screens/design-system/design-system-page.ts). A development build's reference; the
 * page runs nothing, so there is no controller and no message to answer.
 */
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewMessage } from '../shared/types';
import { buildDesignSystemPage } from '../../screens/design-system/design-system-page';

export class DesignSystemWebview extends WebviewBase {
    getWebviewType(): string {
        return 'designSystem';
    }

    protected getWebviewTitle(): string {
        return 'Design system';
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        return buildDesignSystemPage(rel => this.getWebviewUri(rel).toString());
    }

    async handleMessage(_message: WebviewMessage): Promise<void> {
        // Nothing to do: the page holds no data
    }
}
