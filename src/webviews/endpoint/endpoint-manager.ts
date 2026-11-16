// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { APIEndpointManager } from '../../apiEndpointManager';
import { APIEndpointConfig } from '../../apiConfigManager';
import { JavaScriptTestRunner } from '../../data-loading/javascript-test-runner';
import { EnvironmentManager } from '../../environmentManager';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { getGlobalContainer } from '../../container/service-container';
import { confirmDestructive } from '../../services/ui/dbmn-prompts';
import type { SystemManager } from '../../systemManager';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { EndpointEditorController } from '../../screens/endpoint/endpoint-editor.controller';
import { EndpointEditorPorts, TestScripts } from '../../screens/endpoint/endpoint-editor.ports';
import { buildEndpointPage } from '../../screens/pages';

/** The parts of Dobermann the endpoint editor reaches for. */
interface IDobermannInstance {
    updateCurrentItemId(itemId: string): void;
    getEnvironmentManager(): EnvironmentManager;
    serviceContainer?: IServiceContainer;
}

/**
 * The endpoint editor in VS Code: a panel (or Hub tab) running the shared
 * EndpointEditorController, with VS Code's stores, execution and file system as its ports.
 */
export class EndpointWebviewManager extends WebviewBase {
    private controller: EndpointEditorController | undefined;
    /** Set by Dobermann and the Hub: the container with the execution services registered. */
    serviceContainer?: IServiceContainer;

    constructor(
        context: vscode.ExtensionContext,
        private readonly endpointManager: APIEndpointManager,
        private readonly dobermannInstance?: IDobermannInstance
    ) {
        super(context);
    }

    getWebviewType(): string {
        return 'endpoint';
    }

    /** Beside the active editor, so browsing in the Hub and editing happen side by side. */
    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Beside;
    }

    async getHtmlContent(config: WebviewConfig): Promise<string> {
        this.controller?.dispose();
        this.controller = undefined;
        const endpoint = config.itemId ? await this.endpointManager.getEndpoint(config.itemId) : undefined;
        if (this.panel && endpoint?.name) {
            this.panel.title = endpoint.name;
        }
        return buildEndpointPage(this.loadTemplate('endpoint.html'), rel => this.getWebviewUri(rel).toString(), endpoint, {
            itemId: config.itemId,
            defaultFolder: config.defaultFolder
        });
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        // The base class handles these (ready → initializeWebview)
        if (message.type === 'ready' || message.type === 'unsavedChangesResponse' || message.type === 'saveCurrentContext') {
            return;
        }
        await this.screen().handle(message);
    }

    protected async initializeWebview(): Promise<void> {
        await this.screen().onReady();
    }

    protected async handleSaveCurrentContext(): Promise<void> {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'saveCurrentEndpoint' });
        } else {
            this.resolveSaveContext(false);
        }
    }

    dispose(): void {
        this.controller?.dispose();
        this.controller = undefined;
        super.dispose();
    }

    private screen(): EndpointEditorController {
        if (!this.controller) {
            const config = this.getCurrentConfig();
            this.controller = new EndpointEditorController(this.session, this.ports(), {
                itemId: config?.itemId,
                duplicateFromId: config?.duplicateFromId
            });
        }
        return this.controller;
    }

    private resolveSaveContext(saved: boolean): void {
        this.saveContextResolver?.(saved);
        this.saveContextResolver = undefined;
    }

    private container(): IServiceContainer | undefined {
        return this.serviceContainer ?? this.dobermannInstance?.serviceContainer ?? getGlobalContainer();
    }

    private ports(): EndpointEditorPorts {
        const manager = this;
        const environments = (): EnvironmentManager =>
            this.dobermannInstance?.getEnvironmentManager() ?? new EnvironmentManager(this.context);
        return {
            endpoints: this.endpointManager,
            environments: {
                getActiveEnvironment: () => environments().getActiveEnvironment(),
                getEnvironmentToken: id => environments().getEnvironmentToken(id),
                onEnvironmentsChanged: listener => environments().onEnvironmentsChanged(listener)
            },
            get systems() {
                try {
                    return manager.container()?.resolve<SystemManager>(ServiceTokens.SystemManager);
                } catch {
                    return undefined;   // Pre-System installs: the dropdown is just empty
                }
            },
            confirmDestructive,
            toast: {
                info: message => this.toast?.info(message),
                warn: message => this.toast?.warn(message),
                error: message => this.toast?.error(message)
            },
            readClipboard: async () => vscode.env.clipboard.readText(),
            runApi: async endpoint => {
                const container = this.container();
                if (!container) throw new Error('Service container not available');
                const { ExecutionCommands } = await import('../../commands/execution-commands');
                await new ExecutionCommands(container).runApiEndpointCommand(endpoint);
            },
            openRunBatch: async endpoint => { await vscode.commands.executeCommand('dbmn.runBatch', { endpoint }); },
            // GitHub Issue #165: the environment editor picks these up on load (takePendingVariables)
            openEnvironmentWithVariables: async (environmentId, variables) => {
                await this.context.workspaceState.update(`pendingEnvVariables_${environmentId}`, variables);
                await vscode.commands.executeCommand('dbmn.openEnvironmentFromTree', environmentId);
            },
            countTransactions: async endpointId => {
                const container = this.container();
                if (!container?.isRegistered(ServiceTokens.ExecutionMetadataService)) return 0;
                const metadata = container.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService);
                return (await metadata.getExecutionsByEndpoint(endpointId)).length;
            },
            tests: testScripts(),
            saveFile: async (suggestedName, bytes, filters) => {
                const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(suggestedName), filters });
                if (!uri) return undefined;
                await vscode.workspace.fs.writeFile(uri, bytes);
                return uri.path.split('/').pop();
            },
            host: {
                maximize: () => { void vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup'); },
                close: () => this.dispose(),
                saved: (endpoint: APIEndpointConfig, wasNew: boolean) => {
                    if (this.currentConfig) {
                        this.currentConfig.itemId = endpoint.id;
                    }
                    if (wasNew) {
                        this.dobermannInstance?.updateCurrentItemId(endpoint.id);
                    }
                    if (this.panel && endpoint.name) {
                        this.panel.title = endpoint.name;
                    }
                    this.resolveSaveContext(true);
                },
                saveFailed: () => this.resolveSaveContext(false)
            }
        };
    }
}

/** Response test scripts in Node's vm sandbox. */
function testScripts(): TestScripts {
    const runner = new JavaScriptTestRunner();
    return {
        validate: script => runner.validateTestScript(script),
        preview: async (tests, sample) => {
            const context = runner.createTestContext(
                runner.createResponseContext(sample.response.status, sample.response.headers, sample.response.body),
                runner.createRequestContext(sample.request.method, sample.request.url, sample.request.headers, sample.request.body),
                sample.csvRow,
                0,
                1,
                'test-execution',
                undefined
            );
            const results = [];
            for (const test of tests) {
                try {
                    const result = await runner.executeTest(test.name, test.script, context);
                    results.push({ testName: result.testName, success: result.success, error: result.error });
                } catch (error) {
                    results.push({ testName: test.name, success: false, error: error instanceof Error ? error.message : String(error) });
                }
            }
            return results;
        }
    };
}
