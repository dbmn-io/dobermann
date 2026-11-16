// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service-Aware Base Classes
 * 
 * Following Architecture.md - Service Integration patterns
 * Provides base classes that bridge legacy components with service architecture
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IEmbeddedPanelBridge } from '../webviews/shared/webview-base';
import { DbmnModalSpec, DbmnModalResult } from '../services/ui/dbmn-prompts';
import {
    IServiceContainer,
    ServiceTokens
} from '../container/service-container.interface';
import { IToastService } from '../services/notifications/toast.interface';
import { handleClipboardMessage } from '../services/ui/clipboard-bridge';
import { applyPanelIcon } from '../services/ui/panel-icon';
import { IExecutionService } from '../services/execution/execution.interface';
import { IExecutionValidationService } from '../services/execution/execution-validation.interface';
import { IExecutionMetadataService } from '../services/execution/execution-metadata.interface';
import { IExecutionFileService } from '../services/execution/execution-file.interface';
import { isAllowedExternalUrl, resolveDocsUrl } from '../services/dbmn-backend/backend-config';
import { inlineScriptTags } from '../webviews/shared/inline-script-tags';
import {
    BaseMessage,
    ResponseMessage,
    EventMessage,
    generateCorrelationId,
    createResponseMessage,
    createErrorResponseMessage,
    createEventMessage
} from '../types/base-message';


/**
 * Service collection interface for type-safe access
 */
export interface ServiceCollection {
    executionService: IExecutionService;
    executionValidationService: IExecutionValidationService;
    executionMetadataService: IExecutionMetadataService;
    executionFileService: IExecutionFileService;
}

/**
 * Base configuration for service-aware components
 */
export interface ServiceAwareConfig {
    /** Service container instance */
    serviceContainer: IServiceContainer;
    
    /** Message dispatcher for communication (legacy, typed as unknown) */
    messageDispatcher?: unknown;
    
    /** Extension context */
    extensionContext: vscode.ExtensionContext;
    
    /** Component name for logging */
    componentName: string;
    
    /** Enable debug logging */
    enableLogging?: boolean;
}

/**
 * Abstract base class for service-aware components
 */
export abstract class ServiceAwareComponent implements vscode.Disposable {
    protected readonly serviceContainer: IServiceContainer;
    protected readonly messageDispatcher?: unknown;
    protected readonly extensionContext: vscode.ExtensionContext;
    protected readonly componentName: string;
    protected readonly enableLogging: boolean;
    private _services?: ServiceCollection;
    private _disposables: vscode.Disposable[] = [];

    constructor(config: ServiceAwareConfig) {
        this.serviceContainer = config.serviceContainer;
        this.messageDispatcher = config.messageDispatcher;
        this.extensionContext = config.extensionContext;
        this.componentName = config.componentName;
        this.enableLogging = config.enableLogging || false;
    }

    /**
     * Get services with lazy loading and type safety
     */
    protected get services(): ServiceCollection {
        if (!this._services) {
            try {
                this._services = {
                    executionService: this.serviceContainer.resolve(ServiceTokens.ExecutionService),
                    executionValidationService: this.serviceContainer.resolve(ServiceTokens.ExecutionValidationService),
                    executionMetadataService: this.serviceContainer.resolve(ServiceTokens.ExecutionMetadataService),
                    executionFileService: this.serviceContainer.resolve(ServiceTokens.ExecutionFileService)
                };
                this.log('Services resolved successfully');
            } catch (error) {
                this.logError('Failed to resolve services', error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        }
        return this._services;
    }

    /**
     * Send message through dispatcher (legacy - kept for compatibility)
     */
    protected async sendMessage(message: BaseMessage): Promise<void> {
        if (this.messageDispatcher && typeof (this.messageDispatcher as Record<string, unknown>).send === 'function') {
            try {
                await (this.messageDispatcher as { send: (msg: BaseMessage) => Promise<void> }).send(message);
                this.log(`Message sent: ${message.type} (${message.correlationId})`);
            } catch (error) {
                this.logError(`Failed to send message: ${message.type}`, error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        }
    }

    /**
     * Send request and wait for response (legacy - kept for compatibility)
     */
    protected async sendRequest<T = unknown>(request: BaseMessage): Promise<T> {
        if (this.messageDispatcher && typeof (this.messageDispatcher as Record<string, unknown>).sendRequest === 'function') {
            try {
                const response = await (this.messageDispatcher as { sendRequest: (req: BaseMessage) => Promise<T> }).sendRequest(request) as T;
                this.log(`Request completed: ${request.type} (${request.correlationId})`);
                return response;
            } catch (error) {
                this.logError(`Request failed: ${request.type}`, error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        } else {
            throw new Error('Message dispatcher does not support requests');
        }
    }

    /**
     * Broadcast event message (legacy - kept for compatibility)
     */
    protected async broadcastEvent(event: EventMessage): Promise<void> {
        if (this.messageDispatcher && typeof (this.messageDispatcher as Record<string, unknown>).broadcast === 'function') {
            try {
                await (this.messageDispatcher as { broadcast: (evt: EventMessage) => Promise<void> }).broadcast(event);
                this.log(`Event broadcasted: ${event.type} (${event.correlationId})`);
            } catch (error) {
                this.logError(`Failed to broadcast event: ${event.type}`, error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        }
    }

    /**
     * Handle incoming message with minimal conversion
     * Ensures message has required BaseMessage fields before delegating to subclass
     */
    protected async handleMessage(message: BaseMessage | Record<string, unknown>): Promise<ResponseMessage | void> {
        // Ensure minimum BaseMessage fields
        const baseMessage: BaseMessage = {
            correlationId: (message as BaseMessage).correlationId || generateCorrelationId(),
            type: (message as BaseMessage).type,
            timestamp: (message as BaseMessage).timestamp || Date.now(),
            source: (message as BaseMessage).source || 'webview',
            target: (message as BaseMessage).target || 'extension',
            payload: (message as BaseMessage).payload
        };

        if (!baseMessage.type) {
            this.logError('Message missing type field', new Error('No type in message'));
            return;
        }

        // Delegate to subclass implementation
        return this.processMessage(baseMessage);
    }

    /**
     * Process validated message (to be implemented by subclasses)
     */
    protected abstract processMessage(message: BaseMessage): Promise<ResponseMessage | void>;

    /**
     * Register disposable resource
     */
    protected registerDisposable(disposable: vscode.Disposable): void {
        this._disposables.push(disposable);
    }

    /**
     * Portable toast surface. Picked off the global the same way extension.ts
     * publishes it (see Architecture.md → "Accessing IToastService from
     * non-DI code"). Routes to the visible DBMN webview, else a coalesced
     * native nudge — never a raw per-message native popup.
     */
    protected get toast(): IToastService | undefined {
        return (global as Record<string, unknown>).dbmnToastService as IToastService | undefined;
    }

    /**
     * Show error message to user
     */
    protected async showError(message: string, error?: Error): Promise<void> {
        const fullMessage = error ? `${message}: ${error.message}` : message;
        this.toast?.error(fullMessage);
        this.logError(message, error);
    }

    /**
     * Show information message to user
     */
    protected async showInfo(message: string): Promise<void> {
        this.toast?.info(message);
        this.log(`Info shown: ${message}`);
    }

    /**
     * Log message with component context
     */
    protected log(message: string): void {
        if (this.enableLogging) {
            console.log(`[${this.componentName}] ${message}`);
        }
    }

    /**
     * Log error with component context
     */
    protected logError(message: string, error?: Error): void {
        const errorInfo = error ? ` - ${error.message}` : '';
        console.error(`[${this.componentName}] ERROR: ${message}${errorInfo}`);
        if (error?.stack && this.enableLogging) {
            console.error(error.stack);
        }
    }

    /**
     * Create correlation ID for logging
     */
    protected createCorrelationId(): string {
        return generateCorrelationId();
    }

    /**
     * Get component statistics
     */
    protected getStatistics(): ComponentStatistics {
        return {
            componentName: this.componentName,
            servicesResolved: !!this._services,
            hasMessageDispatcher: !!this.messageDispatcher,
            disposablesCount: this._disposables.length
        };
    }

    /**
     * Dispose component and cleanup resources
     */
    dispose(): void {
        this.log('Disposing component');
        
        // Dispose all registered disposables
        for (const disposable of this._disposables) {
            try {
                disposable.dispose();
            } catch (error) {
                this.logError('Error disposing resource', error instanceof Error ? error : new Error(String(error)));
            }
        }
        this._disposables = [];
        
        // Clear services reference
        this._services = undefined;
    }
}

/**
 * Component statistics interface
 */
export interface ComponentStatistics {
    componentName: string;
    servicesResolved: boolean;
    hasMessageDispatcher: boolean;
    disposablesCount: number;
}

/**
 * Service-aware webview base class
 */
export abstract class ServiceAwareWebview extends ServiceAwareComponent {
    protected webviewPanel?: vscode.WebviewPanel;
    /** Embedded-mode bridge — set by createWebviewEmbedded when the
     *  manager is hosted inside a Hub tab body instead of its own VS Code
     *  panel. `this.webviewPanel` is a virtual quack-alike whose
     *  `webview.postMessage` routes through the bridge to the Hub. */
    protected embeddedBridge?: IEmbeddedPanelBridge;
    /** URI → on-disk file path recorded by `getWebviewUri` in embedded
     *  mode. The iframe srcdoc can't fetch `vscode-webview-resource:`
     *  URIs (cross-origin), so after building HTML we post-process
     *  every `<link href=…>` + `<script src=…>` whose URI is in this
     *  map and inline the file contents directly into the srcdoc. */
    private embeddedUriToFile = new Map<string, string>();
    /** issue#269: in-flight DBMN modal requests keyed by requestId, resolved
     *  when the webview posts back a matching `dbmnModalResult`. */
    private pendingModalRequests = new Map<string, (result: DbmnModalResult) => void>();

    constructor(config: ServiceAwareConfig) {
        super(config);
    }

    /**
     * issue#269: resolve in-webview DBMN modal results before the BaseMessage
     * normalizer in the base `handleMessage` strips the top-level requestId /
     * result fields. Covers both standalone panels (onDidReceiveMessage) and
     * embedded Hub tabs (handleEmbeddedMessage) since both route here.
     */
    protected async handleMessage(message: BaseMessage | Record<string, unknown>): Promise<ResponseMessage | void> {
        // Clipboard read/write on the webview's behalf. Handled before the
        // BaseMessage normalizer, and here rather than only in WebviewBase so the
        // Console (which extends this class) is not the one webview whose Paste
        // button silently times out. See services/ui/clipboard-bridge.ts.
        const servedClipboard = await handleClipboardMessage(message, reply => {
            void this.webviewPanel?.webview.postMessage(reply);
        }, vscode.env.clipboard);
        if (servedClipboard) { return; }

        if ((message as { type?: string }).type === 'dbmnModalResult') {
            const requestId = (message as { requestId?: string }).requestId;
            if (requestId) {
                const resolver = this.pendingModalRequests.get(requestId);
                if (resolver) {
                    this.pendingModalRequests.delete(requestId);
                    const result = (message as { result?: DbmnModalResult }).result;
                    resolver(result || { actionId: 'dismiss', fields: {} });
                }
            }
            return;
        }
        return super.handleMessage(message);
    }

    /**
     * issue#269: Open a DbmnModal inside THIS webview's own panel and await the
     * chosen action — the DBMN-branded replacement for `vscode.window`
     * quick-picks / confirms. Requires the webview HTML to load
     * `shared/dbmn-modal.js` (its auto-bridge renders the request and posts
     * the result back). Works in both standalone-panel and embedded-Hub modes
     * because `postMessage` routes through the active (real or virtual) panel.
     *
     * @returns the chosen action id + collected field values. Resolves with
     *          `{ actionId: 'dismiss', fields: {} }` if the webview goes away.
     */
    async showModal(spec: DbmnModalSpec): Promise<DbmnModalResult> {
        if (!this.webviewPanel) {
            return { actionId: 'dismiss', fields: {} };
        }
        return new Promise<DbmnModalResult>((resolve) => {
            const requestId = `modal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.pendingModalRequests.set(requestId, resolve);
            void this.postMessage({ type: 'dbmnModalRequest', requestId, spec } as Record<string, unknown>);
            // Safety: if the webview is closed mid-prompt the result never
            // arrives. Cap the wait at 5 minutes so we don't leak the promise.
            setTimeout(() => {
                if (this.pendingModalRequests.has(requestId)) {
                    this.pendingModalRequests.delete(requestId);
                    resolve({ actionId: 'dismiss', fields: {} });
                }
            }, 5 * 60 * 1000);
        });
    }

    /**
     * Create webview panel
     */
    protected createWebviewPanel(
        viewType: string,
        title: string,
        showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
        options: vscode.WebviewPanelOptions & vscode.WebviewOptions
    ): vscode.WebviewPanel {
        this.webviewPanel = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
        applyPanelIcon(this.webviewPanel, this.extensionContext.extensionUri);
        
        // Register message handling
        this.registerDisposable(
            this.webviewPanel.webview.onDidReceiveMessage(
                async (message) => {
                    try {
                        const response = await this.handleMessage(message);
                        if (response) {
                            await this.webviewPanel!.webview.postMessage(response);
                        }
                    } catch (error) {
                        this.logError('Error handling webview message', error instanceof Error ? error : new Error(String(error)));
                    }
                }
            )
        );

        // Register panel disposal
        this.registerDisposable(
            this.webviewPanel.onDidDispose(() => {
                this.webviewPanel = undefined;
                this.onWebviewDisposed();
            })
        );

        return this.webviewPanel;
    }

    /**
     * Post message to webview
     */
    protected async postMessage(message: BaseMessage | Record<string, unknown>): Promise<boolean> {
        if (this.webviewPanel) {
            try {
                const success = await this.webviewPanel.webview.postMessage(message);
                return success;
            } catch (error) {
                this.logError('Failed to post message to webview', error instanceof Error ? error : new Error(String(error)));
                return false;
            }
        }
        return false;
    }

    /**
     * Called when webview is disposed
     */
    protected onWebviewDisposed(): void {
        this.log('Webview disposed');
    }

    /**
     * Set webview HTML content
     */
    protected setWebviewHtml(html: string): void {
        if (this.webviewPanel) {
            this.webviewPanel.webview.html = html;
        }
    }

    /**
     * Get webview resource URI
     */
    protected getWebviewUri(localPath: string): vscode.Uri | undefined {
        if (this.webviewPanel) {
            const localUri = vscode.Uri.file(localPath);
            const wvUri = this.webviewPanel.webview.asWebviewUri(localUri);
            if (this.embeddedBridge) {
                this.embeddedUriToFile.set(wvUri.toString(), localPath);
            }
            return wvUri;
        }
        return undefined;
    }

    /**
     * Embedded-mode entry: build a virtual webview panel that routes
     * postMessage through the Hub bridge, then call the subclass's
     * `generateHtmlContent()` (or equivalent) and inline external
     * resources for safe srcdoc consumption.
     *
     * Subclasses opting into embedded mode override `getEmbeddedHtml`
     * to produce HTML from a config. The host returns the inlined
     * result to the Hub for iframe mounting.
     */
    async createWebviewEmbedded(
        bridge: IEmbeddedPanelBridge,
        buildHtml: () => Promise<string>
    ): Promise<{ html: string }> {
        this.embeddedBridge = bridge;
        this.embeddedUriToFile = new Map();
        this.webviewPanel = this.buildVirtualPanel(bridge);
        const html = await buildHtml();
        return { html: this.inlineEmbeddedResources(html) };
    }

    /**
     * Route inbound messages from the embedded iframe to the manager.
     * Mirrors what the real panel's `onDidReceiveMessage` dispatcher
     * does in `createWebviewPanel`. Calls the subclass's existing
     * `handleMessage` (typed loosely because the various subclasses
     * already declare it with slightly different signatures).
     */
    async handleEmbeddedMessage(message: unknown): Promise<void> {
        try {
            const fn = (this as unknown as { handleMessage?: (m: unknown) => Promise<unknown> }).handleMessage;
            if (typeof fn !== 'function') return;
            const response = await fn.call(this, message);
            if (response) {
                await this.webviewPanel?.webview.postMessage(response as Record<string, unknown>);
            }
        } catch (error) {
            this.logError('Error handling embedded message', error instanceof Error ? error : new Error(String(error)));
        }
    }

    private buildVirtualPanel(bridge: IEmbeddedPanelBridge): vscode.WebviewPanel {
        const disposeEmitter = new vscode.EventEmitter<void>();
        const stateChangeEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
        const incomingEmitter = new vscode.EventEmitter<unknown>();

        bridge.onDispose(() => {
            disposeEmitter.fire();
            this.onWebviewDisposed();
        });

        const virtualWebview: Partial<vscode.Webview> = {
            postMessage: (message: unknown) => {
                bridge.postBack(message);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: incomingEmitter.event,
            html: '',
            cspSource: bridge.hostWebview.cspSource,
            asWebviewUri: (resource: vscode.Uri) => bridge.hostWebview.asWebviewUri(resource),
            options: { enableScripts: true, localResourceRoots: undefined }
        };

        const virtualPanel: Partial<vscode.WebviewPanel> = {
            webview: virtualWebview as vscode.Webview,
            title: '',
            viewType: 'embedded',
            active: true,
            visible: true,
            viewColumn: vscode.ViewColumn.One,
            reveal: () => undefined,
            dispose: () => disposeEmitter.fire(),
            onDidDispose: disposeEmitter.event,
            onDidChangeViewState: stateChangeEmitter.event,
            options: { retainContextWhenHidden: true }
        };

        return virtualPanel as vscode.WebviewPanel;
    }

    /** Replace `<link rel="stylesheet" href=…>` and `<script src=…>` whose
     *  URIs we recorded with the file contents from disk. Iframe srcdoc
     *  origin can't fetch webview-resource URIs, so this bakes everything
     *  in before the HTML reaches the Hub frontend. */
    private inlineEmbeddedResources(html: string): string {
        if (this.embeddedUriToFile.size === 0) return html;

        let out = html;

        const inlineCssReplacer = (match: string, href: string): string => {
            const filePath = this.embeddedUriToFile.get(href);
            if (!filePath) return match;
            try {
                const css = fs.readFileSync(filePath, 'utf8');
                return `<style data-embedded-from="${path.basename(filePath)}">${css}</style>`;
            } catch {
                return match;
            }
        };

        // Handle both attribute orderings.
        out = out.replace(
            /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi,
            inlineCssReplacer
        );
        out = out.replace(
            /<link\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*\/?>/gi,
            inlineCssReplacer
        );

        // <script src="…"></script> → <script>…</script>, its other attributes kept
        // (inline-script-tags.ts). #433: the Console reads its run's id and the rest from its own
        // tag's data-*; dropped here, a live Console's Logs asked for no run at all.
        out = inlineScriptTags(out, src => {
            const filePath = this.embeddedUriToFile.get(src);
            if (!filePath) return undefined;
            try {
                return { name: path.basename(filePath), js: fs.readFileSync(filePath, 'utf8') };
            } catch {
                return undefined;
            }
        });

        return out;
    }

    /**
     * Handle openExternalUrl messages from webview help icons
     * Opens dbmn.io documentation in the user's external browser
     */
    protected async handleOpenExternalUrl(message: BaseMessage): Promise<ResponseMessage | undefined> {
        if (message.type === 'openExternalUrl') {
            const url = (message as any).payload?.url || (message as any).url;
            if (url && typeof url === 'string' && isAllowedExternalUrl(url)) {
                const vscodeModule = await import('vscode');
                vscodeModule.env.openExternal(vscodeModule.Uri.parse(resolveDocsUrl(url)));
            }
            return createResponseMessage(
                message.correlationId,
                true,
                { message: 'URL opened' }
            );
        }
        return undefined;
    }
}

/**
 * Service-aware tree data provider base class
 */
export abstract class ServiceAwareTreeProvider<T> extends ServiceAwareComponent implements vscode.TreeDataProvider<T> {
    private _onDidChangeTreeData: vscode.EventEmitter<T | undefined | null | void> = new vscode.EventEmitter<T | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<T | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(config: ServiceAwareConfig) {
        super(config);
        this.registerDisposable(this._onDidChangeTreeData);
    }

    /**
     * Refresh tree data
     */
    protected refresh(element?: T): void {
        this.log(`Tree refreshed${element ? ' (partial)' : ' (full)'}`);
        this._onDidChangeTreeData.fire(element);
    }

    /**
     * Abstract methods to be implemented by subclasses
     */
    abstract getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
    abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
}

/**
 * Service-aware command base class
 */
export abstract class ServiceAwareCommand extends ServiceAwareComponent {
    protected readonly commandId: string;

    constructor(config: ServiceAwareConfig, commandId: string) {
        super(config);
        this.commandId = commandId;
    }

    /**
     * Register command
     */
    protected registerCommand(): vscode.Disposable {
        const disposable = vscode.commands.registerCommand(this.commandId, async (...args: any[]) => {
            const correlationId = this.createCorrelationId();
            this.log(`Command executed: ${this.commandId} (${correlationId})`);
            
            try {
                await this.executeCommand(correlationId, ...args);
            } catch (error) {
                this.logError(`Command failed: ${this.commandId}`, error instanceof Error ? error : new Error(String(error)));
                await this.showError(`Command failed: ${this.commandId}`, error instanceof Error ? error : new Error(String(error)));
            }
        });

        this.registerDisposable(disposable);
        this.log(`Command registered: ${this.commandId}`);
        return disposable;
    }

    /**
     * Execute command (to be implemented by subclasses)
     */
    protected abstract executeCommand(correlationId: string, ...args: any[]): Promise<void>;
}