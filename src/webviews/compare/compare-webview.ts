// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Compare in VS Code (#298): a Hub tab running the shared CompareController
 * (src/screens/compare), with VS Code's services as its ports, the same ones the Console uses.
 */
import { getBackend } from '../../services/dbmn-backend/backend-config';
import { HubPreferencesService } from '../../services/hub-preferences/hub-preferences.service';
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
import type { ComparePorts } from '../../screens/compare/compare.ports';
import { QueryController } from '../../screens/query/query.controller';
import { buildQueryPage } from '../../screens/query/query-page';
import { isQueryId } from '../../services/query/query-store';
import { LookupTablesStore } from '../../services/lookup-tables/lookup-tables';
import { createVsCodeQueryFiles, vsCodeLookupFolder } from '../../platform/vscode/vscode-execution-storage';
import initSqlJs from 'sql.js';
import * as path from 'path';

/** SQLite for queries, started once and shared by every Query tab. */
let sqlEngine: ReturnType<typeof initSqlJs> | undefined;

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
    /** A compare's screen, or a query's (a report of the other kind, in the same kind of tab). */
    private readonly controller: CompareController | QueryController;

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
        const wasm = path.join(context.extensionPath, 'dist', 'sql-wasm.wasm');
        this.controller = isQueryId(config.compareId)
            ? new QueryController(this.session, { ...ports, sql: () => (sqlEngine ??= initSqlJs({ locateFile: () => wasm })), systemName: async id => (await container.resolve<{ getSystem(id: string): Promise<{ name: string } | undefined> }>(ServiceTokens.SystemManager).getSystem(id))?.name, openRunBatch: async (endpoint, chain) => { await vscode.commands.executeCommand('dbmn.runBatch', { endpoint, chain }); }, queryFiles: createVsCodeQueryFiles(), lookups: new LookupTablesStore(vsCodeLookupFolder()), openLookup: async id => { await vscode.commands.executeCommand('dbmn.openLookupTable', id); }, newLookup: async () => { const made = await new LookupTablesStore(vsCodeLookupFolder()).create('Lookup table'); await vscode.commands.executeCommand('dbmn.openLookupTable', made.id); }, newCompareEngine: () => getBackend().isDevBuild && new HubPreferencesService(context.globalState).get().newCompareEngine === true }, { queryId: config.compareId, start: config.start })
            : new CompareController(this.session, ports, config);
    }

    getWebviewType(): string {
        return 'compare';
    }

    protected getWebviewTitle(): string {
        return `${isQueryId(this.config.compareId) ? 'Query' : 'Compare'}: ${this.config.endpointName}`;
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        const asset = (rel: string) => this.getWebviewUri(rel).toString();
        return isQueryId(this.config.compareId)
            ? buildQueryPage(asset, { queryId: this.config.compareId, name: this.config.endpointName })
            : buildComparePage(asset, this.config);
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
