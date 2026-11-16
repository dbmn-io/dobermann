// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { EnvironmentManager } from '../../environmentManager';
import { confirmDestructive } from '../../services/ui/dbmn-prompts';
import { GoogleServiceAccountService } from '../../services/oauth/google-service-account.service';
import { getGlobalContainer } from '../../container/service-container';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import type { SystemManager } from '../../systemManager';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import { EnvironmentEditorController, JWTPayload } from '../../screens/environment/environment-editor.controller';
import { DbmnAccount, EnvironmentEditorPorts, OAuthActions } from '../../screens/environment/environment-editor.ports';
import { buildEnvironmentPage } from '../../screens/pages';

export type { JWTPayload };

/** The parts of Dobermann the environment editor reaches for. */
interface DobermannLike {
    serviceContainer?: IServiceContainer;
    updateCurrentItemId?(itemId: string): void;
}

interface OAuthServiceLike {
    adoptPastedToken(environmentId: string, token: string, claims?: JWTPayload): Promise<void>;
}

/**
 * The environment editor in VS Code: a panel (or Hub tab) running the shared
 * EnvironmentEditorController, with VS Code's stores, OAuth commands and DBMN auth as its ports.
 */
export class EnvironmentWebviewManager extends WebviewBase {
    private controller: EnvironmentEditorController | undefined;

    constructor(
        context: vscode.ExtensionContext,
        private readonly environmentManager: EnvironmentManager,
        private readonly dobermannInstance?: DobermannLike
    ) {
        super(context);
    }

    getWebviewType(): string {
        return 'environment';
    }

    /**
     * Re-seed the form when the panel is reused for another new environment.
     *
     * `WebviewBase.createWebview` treats two "new environment" configs as the same item (both
     * have an empty `itemId`), so it reveals the existing panel and calls `updateWebview`. That
     * assigns byte-identical HTML, and VS Code skips reloading a webview whose HTML hasn't
     * changed: no `load`, no `ready`, and the previous environment's DOM stays on screen.
     *
     * Posting the reset is safe either way: a reloaded document has already reset itself.
     */
    async updateWebview(config: WebviewConfig): Promise<void> {
        await super.updateWebview(config);
        if (!config.itemId) {
            this.panel?.webview.postMessage({ type: 'resetForNewEnvironment' });
        }
    }

    async getHtmlContent(config: WebviewConfig): Promise<string> {
        this.controller?.dispose();
        this.controller = undefined;
        const environment = config.itemId ? await this.environmentManager.getEnvironment(config.itemId) : undefined;
        return buildEnvironmentPage(this.loadTemplate('environment.html'), rel => this.getWebviewUri(rel).toString(), {
            id: config.itemId,
            folder: environment?.folder || config.defaultFolder
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
        if (!this.panel) return;
        await this.screen().onReady();
    }

    protected async handleSaveCurrentContext(): Promise<void> {
        if (this.panel) {
            this.panel.webview.postMessage({ type: 'saveCurrentEnvironment' });
        } else {
            this.resolveSaveContext(false);
        }
    }

    dispose(): void {
        this.controller?.dispose();
        this.controller = undefined;
        super.dispose();
    }

    private screen(): EnvironmentEditorController {
        if (!this.controller) {
            this.controller = new EnvironmentEditorController(this.session, this.ports(), this.getCurrentConfig()?.itemId || undefined, this.getCurrentConfig()?.draft);
        }
        return this.controller;
    }

    private resolveSaveContext(saved: boolean): void {
        this.saveContextResolver?.(saved);
        this.saveContextResolver = undefined;
    }

    /** Prefer the Dobermann instance's container: the only one with SystemManager registered. */
    private container(): IServiceContainer | undefined {
        return this.dobermannInstance?.serviceContainer ?? getGlobalContainer();
    }

    private ports(): EnvironmentEditorPorts {
        const manager = this;
        const environments = this.environmentManager;
        return {
            environments,
            get systems() {
                try {
                    return manager.container()?.resolve<SystemManager>(ServiceTokens.SystemManager);
                } catch {
                    return undefined;
                }
            },
            confirmDestructive,
            toast: {
                info: message => this.toast?.info(message),
                error: message => this.toast?.error(message)
            },
            oauth: this.oauthActions(),
            testServiceAccount: async (config, scopes) => {
                const service = new GoogleServiceAccountService(environments);
                const validation = service.validateConfig(config);
                if (!validation.valid) {
                    throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
                }
                const token = await service.authenticate(config, scopes);
                return { expiresIn: token.expires_in };
            },
            // GitHub Issue #165: variables the endpoint editor queued for this environment
            takePendingVariables: async environmentId => {
                const key = `pendingEnvVariables_${environmentId}`;
                const pending = this.context.workspaceState.get<string[]>(key);
                if (pending?.length) {
                    await this.context.workspaceState.update(key, undefined);
                }
                return pending;
            },
            get account() {
                return (global as Record<string, unknown>).dbmnAuthService as DbmnAccount | undefined;
            },
            countTransactions: async environmentId => {
                const container = this.container();
                if (!container?.isRegistered(ServiceTokens.ExecutionMetadataService)) return 0;
                const metadata = container.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService);
                return (await metadata.getAllTransactions()).filter(t => t.environmentId === environmentId).length;
            },
            host: {
                maximize: () => { void vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup'); },
                close: () => this.dispose(),
                saved: (environment, wasNew) => {
                    if (this.currentConfig) {
                        this.currentConfig.itemId = environment.id;
                    }
                    if (wasNew) {
                        this.dobermannInstance?.updateCurrentItemId?.(environment.id);
                    }
                    this.resolveSaveContext(true);
                },
                saveFailed: () => this.resolveSaveContext(false)
            }
        };
    }

    private oauthActions(): OAuthActions {
        const run = (command: string, environmentId: string) => vscode.commands.executeCommand(command, { environmentId });
        return {
            signIn: async id => { await run('dbmn.oauth.signIn', id); },
            signOut: async id => Boolean(await run('dbmn.oauth.signOut', id)),
            refresh: async id => { await run('dbmn.oauth.refresh', id); },
            requestNewToken: async id => { await run('dbmn.oauth.requestNewToken', id); },
            hasRefreshToken: async id => Boolean(await run('dbmn.oauth.hasRefreshToken', id)),
            // #367: the session goes in the vault with the rest (VS Code's OAuth sessions)
            adoptPastedToken: async (environmentId, token, claims?: JWTPayload) => {
                const oauthService = this.dobermannInstance?.serviceContainer?.resolve<OAuthServiceLike>('IOAuthService');
                await oauthService?.adoptPastedToken(environmentId, token, claims);
            }
        };
    }
}
