// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Compare in VS Code (#298): a Hub tab running the shared CompareController
 * (src/screens/compare), with VS Code's services as its ports, the same ones the Console uses.
 */
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { ExecutionServiceTokens } from '../../container/execution-service-registry';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { CompareController, CompareConfig, CompareMessage } from '../../screens/compare/compare.controller';
import { buildComparePage } from '../../screens/compare/compare-page';

export interface CompareWebviewConfig extends CompareConfig {
    context: 'compare';
    endpointName: string;
    /** A compare has run (the Hub refreshes its Compare list). */
    onCompared?(): void;
}

/**
 * Where Compare keeps its state: the Console's Views live in the account's catalogue while
 * signed in (#365), else in globalState. The Hub reads the compare record from the same place.
 */
export function compareStateStore(container: IServiceContainer, context: vscode.ExtensionContext): vscode.Memento {
    try {
        return container.resolve<{ getCatalogueStore(): StoreContext }>(ServiceTokens.DobermannInstance).getCatalogueStore().globalState as vscode.Memento;
    } catch {
        return context.globalState;
    }
}

export class CompareWebview extends WebviewBase {
    private readonly controller: CompareController;

    constructor(context: vscode.ExtensionContext, serviceContainer: IServiceContainer, private readonly config: CompareWebviewConfig) {
        super(context);
        const container = serviceContainer;
        this.controller = new CompareController(this.session, {
            metadata: container.resolve<IExecutionMetadataService>(ExecutionServiceTokens.ExecutionMetadataService),
            endpoints: container.resolve<APIEndpointManager>(ServiceTokens.EndpointManager),
            environments: container.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager),
            state: compareStateStore(container, context),
            // Exports save where the user picks, as the Console's do
            files: {
                chooseSaveTarget: async (defaultName, filters, title) =>
                    (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName), filters, title }))?.fsPath
            },
            toast: {
                info: m => this.toast?.info(m),
                warn: m => this.toast?.warn(m),
                error: m => this.toast?.error(m)
            },
            host: {
                close: () => this.dispose(),
                openConsole: async (executionId, isBatch) => {
                    await vscode.commands.executeCommand('dbmn.viewTransactionReport', { id: executionId, executionId, isBatch });
                },
                compared: () => config.onCompared?.()
            }
        }, config);
    }

    getWebviewType(): string {
        return 'compare';
    }

    protected getWebviewTitle(): string {
        return `Compare: ${this.config.endpointName}`;
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        return buildComparePage(rel => this.getWebviewUri(rel).toString(), this.config);
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        await this.controller.handleMessage(message as unknown as CompareMessage);
    }

    dispose(): void {
        this.controller.dispose();
        super.dispose();
    }
}

export type { WebviewConfig };
