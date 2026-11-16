// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console in VS Code: a Hub tab running the shared ConsoleController (src/screens/console),
 * with VS Code's services, save dialog and editor as its ports.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ServiceAwareWebview, ServiceAwareConfig } from '../../base/service-aware-base';
import { BaseMessage, ResponseMessage } from '../../types/base-message';
import { PathResolver } from '../../utils/path-resolver';
import { CoreServiceTokens } from '../../container/core-services-registry';
import { ExecutionServiceTokens } from '../../container/execution-service-registry';
import { ServiceTokens } from '../../container/service-container.interface';
import { UIServiceTokens } from '../../container/ui-services-registry';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { IBatchExecutionEngine } from '../../services/execution/batch-execution-engine.interface';
import type { IIndividualExecutionEngine } from '../../services/execution/individual-execution-engine.interface';
import type { IExecutionLoggingService } from '../../services/logging/execution-logging.interface';
import type { ITransactionCreator } from '../../services/transaction-creator/transaction-creator.interface';
import type { IEnvironmentAuthGate } from '../../services/environment/environment-auth-gate.service';
import type { IDbmnAuthService } from '../../services/dbmn-auth/dbmn-auth.interface';
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { dbmnSettings } from '../../platform/vscode/vscode-settings';
import { ConfirmationManager } from '../confirmation/confirmation-manager';
import { ConsoleController, ConsoleWebviewConfig } from '../../screens/console/console.controller';
import { ConsolePorts } from '../../screens/console/console.ports';
import { buildConsolePage } from '../../screens/console/console-page';
import { ScreenSession } from '../../screens/screen-session';
import { isAllowedExternalUrl, resolveDocsUrl } from '../../services/dbmn-backend/backend-config';
import { handleClipboardMessage } from '../../services/ui/clipboard-bridge';
import type { IEmbeddedPanelBridge } from '../shared/webview-base';

export type { ConsoleWebviewConfig };

export class ConsoleWebviewManager extends ServiceAwareWebview {
    private controller?: ConsoleController;
    /** Issue #312: open-timeline marks set before the controller exists (the Hub's click). */
    openMarks: Array<[string, number]> = [];

    constructor(config: ServiceAwareConfig) {
        super({ ...config, componentName: config.componentName || 'ConsoleWebviewManager' });
    }

    /** Build the Console's page for a Hub tab; its data follows once the page is ready. */
    async createEmbedded(config: ConsoleWebviewConfig, bridge: IEmbeddedPanelBridge): Promise<{ html: string }> {
        const session = new ScreenSession({ post: message => { void this.webviewPanel?.webview.postMessage(message); } }, {
            openExternal: url => {
                if (isAllowedExternalUrl(url)) void vscode.env.openExternal(vscode.Uri.parse(resolveDocsUrl(url)));
            },
            clipboard: (message, reply) => handleClipboardMessage(message, reply, vscode.env.clipboard).then(() => undefined)
        });
        this.controller = new ConsoleController(session, this.ports(), config);
        this.openMarks.forEach(([label, at]) => this.controller!.mark(label, at));
        return this.createWebviewEmbedded(bridge, async () => buildConsolePage(
            fs.readFileSync(PathResolver.getWebviewsPath(this.extensionContext.extensionPath, 'console', 'console.html'), 'utf8'),
            rel => (this.getWebviewUri(PathResolver.getWebviewsPath(this.extensionContext.extensionPath, rel)) ?? '').toString(),
            config
        ));
    }

    /** The Hub: the Console's page is listening. */
    async onEmbeddedReady(): Promise<void> {
        await this.controller?.onReady();
    }

    mark(label: string): void {
        if (this.controller) this.controller.mark(label);
        else this.openMarks.push([label, Date.now()]);
    }

    /** Every message goes to the controller (its session handles modals, links and the clipboard). */
    protected async handleMessage(message: BaseMessage | Record<string, unknown>): Promise<ResponseMessage | void> {
        await this.controller?.handle(message as Record<string, unknown>);
    }

    protected async processMessage(): Promise<ResponseMessage | void> {
        return undefined;
    }

    dispose(): void {
        this.controller?.dispose();
        this.controller = undefined;
        super.dispose();
    }

    private ports(): ConsolePorts {
        const container = this.serviceContainer;
        const optional = <T>(token: symbol): T | undefined => {
            try {
                return container.resolve<T>(token);
            } catch {
                return undefined;
            }
        };
        const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);
        return {
            metadata: container.resolve<IExecutionMetadataService>(ExecutionServiceTokens.ExecutionMetadataService),
            links: optional(ServiceTokens.ExecutionMetadataManager),
            batchEngine: optional<IBatchExecutionEngine>(ServiceTokens.BatchExecutionEngine),
            individualEngine: optional<IIndividualExecutionEngine>(ServiceTokens.IndividualExecutionEngine),
            cancelExecution: async id => {
                const service = container.resolve<{ cancel(executionId: string): Promise<void> }>(ServiceTokens.ExecutionService);
                await service.cancel(id);
            },
            executionLogging: optional<IExecutionLoggingService>(CoreServiceTokens.ExecutionLoggingService),
            transactionCreator: optional<ITransactionCreator>(CoreServiceTokens.TransactionCreator),
            endpoints: container.resolve<APIEndpointManager>(ServiceTokens.EndpointManager),
            environments: container.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager),
            authGate: optional<IEnvironmentAuthGate>(UIServiceTokens.EnvironmentAuthGate),
            get dbmnAuth() {
                return (globalThis as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
            },
            // #365: views live in the account's catalogue while signed in (the catalogue store
            // switches on sign-in); signed out, in globalState as before.
            state: optional<{ getCatalogueStore(): StoreContext }>(ServiceTokens.DobermannInstance)?.getCatalogueStore().globalState
                ?? this.extensionContext.globalState,
            settings: dbmnSettings(),   // #281: the account's while signed in, else VS Code's
            clipboard: vscode.env.clipboard,
            logger: { log: message => this.log(message), error: (message, error) => this.logError(message, error) },
            toast: {
                info: m => this.toast?.info(m),
                warn: m => this.toast?.warn(m),
                error: m => this.toast?.error(m)
            },
            files: {
                chooseSaveTarget: async (defaultName, filters, title) =>
                    (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultName), filters, title }))?.fsPath,
                open: async filePath => { await run('vscode.open', vscode.Uri.file(filePath)); },
                openContent: async (name, content) => {
                    const language = name.endsWith('.json') ? 'json' : name.endsWith('.log') ? 'log' : 'plaintext';
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language }));
                },
                // GitHub Issue #124: a folder in the workspace shows in the Explorer, anything else in the OS
                reveal: async target => {
                    const uri = vscode.Uri.file(target);
                    if (vscode.workspace.getWorkspaceFolder(uri) && fs.statSync(target).isDirectory()) {
                        await run('revealInExplorer', uri);
                        return;
                    }
                    try {
                        await run('revealFileInOS', uri);
                    } catch {
                        await vscode.env.openExternal(uri);
                    }
                }
            },
            host: {
                close: () => {
                    if (this.embeddedBridge) this.embeddedBridge.requestClose();
                    else this.webviewPanel?.dispose();
                },
                openEndpoint: async id => { await run('dbmn.openEndpointFromTree', id); },
                openEnvironment: async id => { await run('dbmn.openEnvironmentFromTree', id); },
                openConsole: async (executionId, isBatch) => { await run('dbmn.viewTransactionReport', { id: executionId, executionId, isBatch }); },
                openRunBatch: async (endpoint, chain) => { await run('dbmn.runBatch', { endpoint, chain }); },
                openCompare: async compareId => { await run('dbmn.openCompare', { compareId }); },
                runApi: async endpoint => { await run('dbmn.runApiEndpoint', endpoint); },
                confirmDelete: async data => {
                    const confirmation = new ConfirmationManager(this.extensionContext);
                    try {
                        return await confirmation.showConfirmation(data);
                    } finally {
                        confirmation.dispose();
                    }
                }
            }
        };
    }
}
