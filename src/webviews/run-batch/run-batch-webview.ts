// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch in VS Code: a Hub tab running the shared RunBatchController (src/screens/run-batch),
 * with VS Code's services as its ports.
 */
import type { ReviewHandoff } from '../../screens/run-batch/review-handoff';
import * as vscode from 'vscode';
import { ChainHandoff } from '../../services/chain/chain-types';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { CoreServiceTokens } from '../../container/core-services-registry';
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import type { IDbmnAuthService } from '../../services/dbmn-auth/dbmn-auth.interface';
import { sendDbmnSignInLinkInApp } from '../../services/ui/dbmn-prompts';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { FormatConverterService } from '../../services/format-converter/format-converter.service';
import { dbmnSettings } from '../../platform/vscode/vscode-settings';
import { ExecutionCommands } from '../../commands/execution-commands';
import { RunBatchController, RunBatchConfig, RunBatchMessage } from '../../screens/run-batch/run-batch.controller';
import { buildRunBatchPage } from '../../screens/run-batch/run-batch-page';

export type { RunBatchConfig };

export class RunBatchWebview extends WebviewBase {
    private readonly controller: RunBatchController;

    constructor(context: vscode.ExtensionContext, private readonly serviceContainer: IServiceContainer, config: RunBatchConfig) {
        super(context);
        const container = serviceContainer;
        this.controller = new RunBatchController(this.session, {
            get endpoints() { return container.resolve<APIEndpointManager>(ServiceTokens.EndpointManager); },
            get environments() { return container.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager); },
            get formatConverter() { return container.resolve<FormatConverterService>(CoreServiceTokens.FormatConverterService); },
            settings: dbmnSettings(),
            // (where the Console keeps an endpoint's Views: Validate's ★ shares the Input tab's saved searches, slice 5)
            get state() {
                try {
                    return container.resolve<{ getCatalogueStore(): StoreContext }>(ServiceTokens.DobermannInstance).getCatalogueStore().globalState;
                } catch {
                    return context.globalState;
                }
            },
            toast: {
                info: m => this.toast?.info(m),
                warn: (m, opts) => this.toast?.warn(m, opts),
                error: m => this.toast?.error(m)
            },
            executeBulkLoad: request => new ExecutionCommands(container).executeBulkLoad(request),
            // GitHub Issue #396: a batch refused for want of a DBMN sign-in opens it, over this tab
            promptSignIn: async () => {
                const auth = (globalThis as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
                if (auth && this.toast) {
                    await sendDbmnSignInLinkInApp(auth, this.toast, this);
                }
            },
            host: {
                close: () => this.dispose(),
                openConsole: async (executionId, isBatch) => {
                    await vscode.commands.executeCommand('dbmn.viewTransactionReport', { id: executionId, executionId, isBatch });
                }
            }
        }, config);
    }

    getWebviewType(): string {
        return 'runBatch';
    }

    protected getWebviewTitle(config: WebviewConfig): string {
        return `Run Batch: ${(config as RunBatchConfig).endpointName}`;
    }

    /** Column 2, beside the Hub: not whichever editor happens to be active. */
    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(config: WebviewConfig): Promise<string> {
        return buildRunBatchPage(rel => this.getWebviewUri(rel).toString(), config as RunBatchConfig);
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        await this.controller.handleMessage(message as RunBatchMessage);
    }

    /** GitHub Issue #247: chaining into a Run Batch that is already open replaces its Step 1 data. */
    applyChain(chain: ChainHandoff): void {
        this.controller.applyChain(chain);
    }

    /** #470: Review's view at Execute, for the Console that replaces this tab. */
    handoff(): ReviewHandoff | undefined {
        return this.controller.handoff();
    }

    dispose(): void {
        this.controller.dispose();
        super.dispose();
    }
}
