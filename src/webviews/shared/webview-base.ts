// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { inlineScriptTags } from './inline-script-tags';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../../utils/path-resolver';
import { WebviewConfig, WebviewMessage, FormState } from './types';
import { confirmUnsavedChanges } from '../../services/ui/dbmn-prompts';
import { DbmnModalResult, DbmnModalSpec } from '../../screens/modal.types';
import { ScreenSession } from '../../screens/screen-session';
import { IToastService } from '../../services/notifications/toast.interface';
import { isAllowedExternalUrl, resolveDocsUrl } from '../../services/dbmn-backend/backend-config';
import { handleClipboardMessage } from '../../services/ui/clipboard-bridge';
import { applyPanelIcon } from '../../services/ui/panel-icon';

/**
 * Bridge that connects an embedded manager's virtual panel to the Hub's
 * real webview. The manager uses `this.panel.webview.postMessage(...)` as
 * normal; the virtual panel hands those messages to `postBack`, which the
 * Hub forwards to the iframe hosting the manager's UI.
 *
 * R1-3: introduced so endpoint / env / console / batch managers can fold
 * into the Hub as tabs without rewriting their postMessage call sites.
 */
export interface IEmbeddedPanelBridge {
    readonly tabId: string;
    /** The Hub's real webview — passed through so the embedded manager's
     *  virtual panel can resolve resource URIs (`asWebviewUri`) against the
     *  same `vscode-webview://hub-guid/...` origin the iframe inherits.
     *  Without this, link/script tags inside the iframe srcdoc point at
     *  `file:///...` URIs that VS Code's webview CSP blocks. */
    readonly hostWebview: vscode.Webview;
    postBack(message: unknown): void;
    /** Fires when the tab is closed by the user or the Hub disposes. */
    onDispose(handler: () => void): void;
    /** Manager-initiated close: asks the host (Hub) to drop the iframe and
     *  dispose this bridge + manager. Use when the manager needs to dismiss
     *  its own tab (e.g. after a delete completes and the report no longer
     *  exists). The bridge's `onDispose` handlers fire as part of teardown. */
    requestClose(): void;
}

export abstract class WebviewBase {
    protected context: vscode.ExtensionContext;
    protected panel: vscode.WebviewPanel | undefined;
    protected currentConfig: WebviewConfig | undefined;
    protected unsavedChangesResolver: ((value: boolean) => void) | undefined;
    protected saveContextResolver: ((value: boolean) => void) | undefined;
    /** Set when this manager was created via `createWebviewEmbedded` and is
     *  living inside a Hub tab body. `this.panel` is a virtual quack-alike of
     *  `WebviewPanel` whose `webview.postMessage` routes through the bridge. */
    protected embeddedBridge: IEmbeddedPanelBridge | undefined;
    /** URI → on-disk file path recorded by `getWebviewUri` when in embedded
     *  mode. The iframe srcdoc origin can't fetch `vscode-webview-resource:`
     *  URIs (cross-origin), so after building HTML we post-process every
     *  `<link href=…>` + `<script src=…>` whose URI is in this map and inline
     *  the file contents directly into the srcdoc. */
    private embeddedUriToFile = new Map<string, string>();
    /** The screen protocol shared with the web app (modals, links, clipboard): core
     *  ScreenSession, posting through whichever panel this manager currently has. */
    private screenSession: ScreenSession | undefined;

    protected get session(): ScreenSession {
        if (!this.screenSession) {
            this.screenSession = new ScreenSession(
                { post: message => { void this.panel?.webview.postMessage(message); } },
                {
                    openExternal: url => {
                        if (isAllowedExternalUrl(url)) {
                            vscode.env.openExternal(vscode.Uri.parse(resolveDocsUrl(url)));
                        }
                    },
                    clipboard: (message, reply) => handleClipboardMessage(message, reply, vscode.env.clipboard).then(() => undefined)
                }
            );
        }
        return this.screenSession;
    }

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Portable toast surface. Picked off the global the same way extension.ts
     * publishes it (see Architecture.md → "Accessing IToastService from
     * non-DI code"). Routes to the visible DBMN webview, else a coalesced
     * native nudge — never a raw per-message native popup. Use for
     * fire-and-forget notifications; use DbmnModal for confirms/actions.
     */
    protected get toast(): IToastService | undefined {
        return (global as Record<string, unknown>).dbmnToastService as IToastService | undefined;
    }

    abstract getWebviewType(): string;
    abstract handleMessage(message: WebviewMessage): Promise<void>;
    abstract getHtmlContent(config: WebviewConfig): Promise<string>;

    /**
     * Embedded-mode entry point used by the Hub to host this manager inside
     * a tab body instead of its own VS Code panel. Build the virtual panel,
     * generate the HTML, and hand it back for the Hub to mount in an iframe.
     *
     * The manager keeps using `this.panel?.webview.postMessage(...)` as
     * usual — those calls land on the virtual panel, which forwards via the
     * bridge's `postBack`. Incoming messages from the iframe arrive via
     * `handleEmbeddedMessage`, which mirrors what `onDidReceiveMessage`
     * would dispatch on a real panel.
     */
    async createWebviewEmbedded(
        config: WebviewConfig,
        bridge: IEmbeddedPanelBridge
    ): Promise<{ html: string }> {
        this.currentConfig = config;
        this.embeddedBridge = bridge;
        this.embeddedUriToFile = new Map();
        this.panel = this.buildVirtualPanel(config, bridge);

        const html = await this.getHtmlContent(config);
        const inlined = this.inlineEmbeddedResources(html);
        return { html: inlined };
    }

    /**
     * Replace every `<link rel="stylesheet" href="vscode-webview-resource:…">`
     * and `<script src="vscode-webview-resource:…"></script>` in the HTML
     * with their on-disk file contents (as `<style>` and `<script>` blocks).
     * The iframe srcdoc origin can't fetch the webview-resource URIs, so we
     * bake everything in before sending the HTML to the Hub frontend.
     *
     * URIs we don't recognise (foreign CDNs, etc.) are left alone — they'll
     * still attempt to fetch externally, which can work for HTTPS-allowed
     * hosts but not for VS Code-scoped URIs.
     */
    private inlineEmbeddedResources(html: string): string {
        if (this.embeddedUriToFile.size === 0) return html;

        let out = html;

        // <link rel="stylesheet" href="…"> → <style>…</style>
        out = out.replace(
            /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi,
            (match, href) => {
                const filePath = this.embeddedUriToFile.get(href);
                if (!filePath) return match;
                try {
                    const css = fs.readFileSync(filePath, 'utf8');
                    return `<style data-embedded-from="${path.basename(filePath)}">${css}</style>`;
                } catch (e) {
                    console.error(`[webview-base] failed to inline CSS ${filePath}:`, e);
                    return match;
                }
            }
        );
        out = out.replace(
            /<link\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*\/?>/gi,
            (match, href) => {
                const filePath = this.embeddedUriToFile.get(href);
                if (!filePath) return match;
                try {
                    const css = fs.readFileSync(filePath, 'utf8');
                    return `<style data-embedded-from="${path.basename(filePath)}">${css}</style>`;
                } catch (e) {
                    console.error(`[webview-base] failed to inline CSS ${filePath}:`, e);
                    return match;
                }
            }
        );

        // <script src="…"></script> → <script>…</script>, its other attributes kept (inline-script-tags.ts)
        out = inlineScriptTags(out, src => {
            const filePath = this.embeddedUriToFile.get(src);
            if (!filePath) return undefined;
            try {
                return { name: path.basename(filePath), js: fs.readFileSync(filePath, 'utf8') };
            } catch (e) {
                console.error(`[webview-base] failed to inline JS ${filePath}:`, e);
                return undefined;
            }
        });

        return out;
    }

    /**
     * Route an inbound message from the embedded iframe to the manager's
     * own handlers. Mirrors the dispatch loop the real panel's
     * `onDidReceiveMessage` listener performs.
     */
    async handleEmbeddedMessage(message: WebviewMessage): Promise<void> {
        await this.handleSharedMessages(message);
        await this.handleMessage(message);
    }

    private buildVirtualPanel(config: WebviewConfig, bridge: IEmbeddedPanelBridge): vscode.WebviewPanel {
        const disposeEmitter = new vscode.EventEmitter<void>();
        const stateChangeEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
        const incomingEmitter = new vscode.EventEmitter<unknown>();

        bridge.onDispose(() => disposeEmitter.fire());

        const virtualWebview: Partial<vscode.Webview> = {
            postMessage: (message: unknown) => {
                bridge.postBack(message);
                return Promise.resolve(true);
            },
            // The manager's own onDidReceiveMessage listener (if any) is bound
            // by createWebview's standalone path — embedded managers receive
            // messages via handleEmbeddedMessage instead. Expose the emitter
            // anyway so consumers that probe for it don't crash.
            onDidReceiveMessage: incomingEmitter.event,
            html: '',
            cspSource: bridge.hostWebview.cspSource,
            // Delegate to the Hub's real webview so all CSS / JS / image URIs
            // resolve against the `vscode-webview://hub-guid/...` origin the
            // iframe inherits. Critical for the iframe's <link> + <script>
            // tags to load — without it, asWebviewUri returns the raw file
            // URI which the webview CSP blocks.
            asWebviewUri: (resource: vscode.Uri) => bridge.hostWebview.asWebviewUri(resource),
            options: { enableScripts: true, localResourceRoots: undefined }
        };

        const virtualPanel: Partial<vscode.WebviewPanel> = {
            webview: virtualWebview as vscode.Webview,
            title: this.getWebviewTitle(config),
            viewType: this.getWebviewType(),
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

    async createWebview(config: WebviewConfig): Promise<void> {
        if (this.panel) {
            // Check if we're switching to a different item BEFORE updating current config
            if (this.isDifferentItem(config)) {
                // Dispose the current panel to force a fresh webview creation
                this.dispose();
            } else {
                // Same item, just reveal and update
                this.panel.reveal();
                await this.updateWebview(config);
                return;
            }
        }

        
        // Store the current config for later use (after the isDifferent check)
        this.currentConfig = config;

        this.panel = vscode.window.createWebviewPanel(
            this.getWebviewType(),
            this.getWebviewTitle(config),
            this.getViewColumn(),
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(PathResolver.getWebviewsPath(this.context.extensionPath, '..'))]
            }
        );

        applyPanelIcon(this.panel, this.context.extensionUri);

        this.panel.webview.html = await this.getHtmlContent(config);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleSharedMessages(message);
                await this.handleMessage(message);
            },
            undefined,
            this.context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;

            // Notify extension host that this webview was closed
            // This allows Dobermann to clear its context tracking
            if (this.currentConfig) {
                vscode.commands.executeCommand('dbmn.internal.webviewClosed', {
                    context: this.currentConfig.context,
                    itemId: this.currentConfig.itemId
                });
            }

            this.currentConfig = undefined;
        });
    }

    async updateWebview(config: WebviewConfig): Promise<void> {
        // Store the updated config
        this.currentConfig = config;
        
        if (this.panel) {
            this.panel.title = this.getWebviewTitle(config);
            this.panel.webview.html = await this.getHtmlContent(config);
            
            // Note: initializeWebview() will be called when the webview sends the 'ready' message
            // after the new HTML loads, so we don't need to call it here
        }
    }

    /**
     * View column for the webview panel. Default = `ViewColumn.One` (legacy
     * behaviour). Subclasses can override to open beside the active editor,
     * which is the right call for editor-style webviews invoked from the Hub.
     */
    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.One;
    }

    protected getWebviewTitle(config: WebviewConfig): string {
        switch (config.context) {
            case 'environment':
                return config.itemId ? 'Edit Environment' : 'Create Environment';
            case 'endpoint':
                return config.itemId ? 'Edit Endpoint' : 'Create Endpoint';
            default:
                return 'Dobermann';
        }
    }

    protected async handleSharedMessages(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.initializeWebview();
                break;
            case 'unsavedChangesResponse':
                if (this.unsavedChangesResolver) {
                    this.unsavedChangesResolver(message.hasUnsavedChanges);
                    this.unsavedChangesResolver = undefined;
                }
                break;
            case 'saveCurrentContext':
                await this.handleSaveCurrentContext();
                break;
            default:
                await this.session.handleShared(message as unknown as Record<string, unknown>);
                break;
        }
    }

    protected async handleSaveCurrentContext(): Promise<void> {
        // Override in subclasses to handle specific save logic
        // Default implementation resolves with false (no save functionality)
        if (this.saveContextResolver) {
            this.saveContextResolver(false);
            this.saveContextResolver = undefined;
        }
    }

    protected async initializeWebview(): Promise<void> {
        // Override in subclasses for specific initialization
    }

    protected getCurrentConfig(): WebviewConfig | undefined {
        return this.currentConfig;
    }

    protected loadTemplate(templateName: string): string {
        const templatePath = PathResolver.getWebviewsPath(this.context.extensionPath, this.getWebviewType(), templateName);
        return fs.readFileSync(templatePath, 'utf8');
    }

    protected loadSharedStyles(): string {
        const stylesPath = PathResolver.getWebviewsPath(this.context.extensionPath, 'shared', 'styles.css');
        return fs.readFileSync(stylesPath, 'utf8');
    }

    protected getSharedCssUris(): {
        atomic: vscode.Uri; core: vscode.Uri; modals: vscode.Uri;
        tables: vscode.Uri; tabs: vscode.Uri; toast: vscode.Uri
    } {
        return {
            atomic: this.getWebviewUri('shared/atomic.css'),
            core: this.getWebviewUri('shared/core.css'),
            modals: this.getWebviewUri('shared/modals.css'),
            tables: this.getWebviewUri('shared/tables.css'),
            tabs: this.getWebviewUri('shared/tabs.css'),
            toast: this.getWebviewUri('shared/toast.css')
        };
    }

    protected getWebviewUri(relativePath: string): vscode.Uri {
        const filePath = PathResolver.getWebviewsPath(this.context.extensionPath, relativePath);
        const uri = this.panel!.webview.asWebviewUri(vscode.Uri.file(filePath));
        if (this.embeddedBridge) {
            this.embeddedUriToFile.set(uri.toString(), filePath);
        }
        return uri;
    }

    protected substituteTemplate(template: string, variables: Record<string, any>): string {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            const placeholder = `{{${key}}}`;
            result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(value));
        }
        return result;
    }

    async checkForUnsavedChanges(): Promise<boolean> {
        if (!this.panel) return false;
        
        return new Promise((resolve) => {
            this.unsavedChangesResolver = resolve;
            
            this.panel?.webview.postMessage({ type: 'checkUnsavedChanges' });
            
            setTimeout(() => {
                if (this.unsavedChangesResolver) {
                    this.unsavedChangesResolver(false);
                    this.unsavedChangesResolver = undefined;
                }
            }, 1000);
        });
    }

    async showUnsavedChangesDialog(): Promise<'save' | 'discard' | 'cancel'> {
        // Pass `this` so the modal renders inside the EDITOR's own webview
        // (the panel the user was actually working in), not the Hub. The
        // backdrop then covers the correct surface and the save flow stays
        // local to this webview (no cross-webview round-trip races).
        return await confirmUnsavedChanges(this);
    }

    /**
     * Open a DbmnModal inside THIS webview's own panel and await the chosen
     * action. Used by editor-local prompts (unsaved changes, delete confirm,
     * etc.) so the modal appears on top of the editor — not the Hub. Requires
     * the webview HTML to load `shared/dbmn-modal.js` (its auto-bridge will
     * pick up the `dbmnModalRequest` message and render).
     */
    async showModal(spec: DbmnModalSpec): Promise<DbmnModalResult> {
        if (!this.panel) {
            return { actionId: 'dismiss', fields: {} };
        }
        return this.session.showModal(spec);
    }

    async saveCurrentContext(): Promise<boolean> {
        if (!this.panel) return false;

        return new Promise((resolve) => {
            this.saveContextResolver = resolve;

            // Invoke the subclass hook directly so it can post the editor's
            // own save trigger (saveCurrentEndpoint / saveCurrentEnvironment).
            // Posting `saveCurrentContext` to the webview wouldn't work — no
            // frontend listens for it, so Save-and-Continue silently timed out.
            void this.handleSaveCurrentContext();

            // 15s margin: large endpoints with many headers + templates can
            // take a beat to validate + persist; the previous 5s threshold
            // was tight enough that legitimate saves sometimes timed out.
            setTimeout(() => {
                if (this.saveContextResolver) {
                    this.saveContextResolver(false);
                    this.saveContextResolver = undefined;
                }
            }, 15000);
        });
    }

    private isDifferentItem(newConfig: WebviewConfig): boolean {
        // If no current config, it's not different (shouldn't happen)
        if (!this.currentConfig) {
            return false;
        }

        // Same context but different itemId means we're switching to a different item
        return this.currentConfig.context === newConfig.context &&
               this.currentConfig.itemId !== newConfig.itemId;
    }

    dispose(): void {
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
        
        // Clear config and resolvers when disposing
        this.currentConfig = undefined;
        if (this.unsavedChangesResolver) {
            this.unsavedChangesResolver(false);
            this.unsavedChangesResolver = undefined;
        }
        if (this.saveContextResolver) {
            this.saveContextResolver(false);
            this.saveContextResolver = undefined;
        }
        // Resolve any in-flight modal prompts so callers awaiting them don't
        // deadlock when the webview disappears mid-dialog.
        this.screenSession?.dismissAll();
    }
}