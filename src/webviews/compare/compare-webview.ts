// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A query's tab in VS Code: the shared QueryController (src/screens/query), with VS Code's services
 * as its ports, the same ones the Console uses. (Old Compare's screen ran here too until 2026-11-23;
 * a saved compare now opens as the query made from it.)
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
import type { ComparePorts } from '../../screens/compare/compare.ports';
import { QueryController } from '../../screens/query/query.controller';
import { buildQueryPage } from '../../screens/query/query-page';
import { LookupTablesStore } from '../../services/lookup-tables/lookup-tables';
import { createVsCodeQueryFiles, vsCodeLookupFolder } from '../../platform/vscode/vscode-execution-storage';


export interface CompareWebviewConfig {
    /** The saved query. */
    compareId: string;
    start?: 'results' | 'match' | 'edit';
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
    /** A compare's screen, or a query's (a report of the other kind, in the same kind of tab). */
    private readonly controller: QueryController;

    constructor(context: vscode.ExtensionContext, serviceContainer: IServiceContainer, private readonly config: CompareWebviewConfig) {
        super(context);
        const container = serviceContainer;
        const ports: ComparePorts = {
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
        };
        this.controller = new QueryController(this.session, { ...ports, systemName: async id => (await container.resolve<{ getSystem(id: string): Promise<{ name: string } | undefined> }>(ServiceTokens.SystemManager).getSystem(id))?.name, openRunBatch: async (endpoint, chain) => { await vscode.commands.executeCommand('dbmn.runBatch', { endpoint, chain }); }, queryFiles: createVsCodeQueryFiles(), lookups: new LookupTablesStore(vsCodeLookupFolder()), openLookup: async id => { await vscode.commands.executeCommand('dbmn.openLookupTable', id); }, newLookup: async (name, columns) => { const made = await new LookupTablesStore(vsCodeLookupFolder()).create(name ?? 'Lookup table', columns); await vscode.commands.executeCommand('dbmn.openLookupTable', made.id); } }, { queryId: config.compareId, start: config.start });
    }

    getWebviewType(): string {
        return 'compare';
    }

    protected getWebviewTitle(): string {
        return `Query: ${this.config.endpointName}`;
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        const asset = (rel: string) => this.getWebviewUri(rel).toString();
        return buildQueryPage(asset, { queryId: this.config.compareId, name: this.config.endpointName });
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        await this.controller.handleMessage(message as never);
    }

    dispose(): void {
        this.controller.dispose();
        super.dispose();
    }
}

export type { WebviewConfig };
