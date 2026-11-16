// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Import/Export Webview Manager
 *
 * Manages the unified import/export webview for endpoints and environments.
 * Provides a landing page with Import/Export choice, checkbox selection,
 * drag & drop file upload, conflict resolution, and progress tracking.
 *
 * GitHub Issue: #90
 * Architecture: Follows WebviewBase patterns from Architecture.md
 */

import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewConfig, WebviewMessage } from '../shared/types';
import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { IImportExportService } from '../../services/import-export/import-export.service.interface';
import {
    ExportOptions,
    ExportResult,
    ImportPackage,
    ValidationResult,
    ConflictDetection,
    ConflictResolution,
    ImportResult
} from '../../services/import-export/import-export.service.interface';
import { APIEndpointManager } from '../../apiEndpointManager';
import { EnvironmentManager } from '../../environmentManager';
import {
    PostmanCollectionParser,
    PostmanParseOptions
} from '../../services/postman-import/postman-collection-parser';

/**
 * Message types for import/export webview
 */
interface ImportExportMessage extends WebviewMessage {
    type: 'ready' | 'loadItems' | 'exportSelected' | 'uploadFile' | 'uploadPostmanFile' |
          'postmanOptionsChanged' | 'confirmIncludeHeaders' | 'validateImport' |
          'resolveConflicts' | 'executeImport' | 'openLocation' | 'cancel';
    payload?: any;
}

/**
 * Import/Export Webview Manager
 * Extends WebviewBase following Architecture.md patterns
 */
export class ImportExportWebviewManager extends WebviewBase {
    private importExportService: IImportExportService;
    private endpointManager: APIEndpointManager;
    private environmentManager: EnvironmentManager;
    private serviceContainer: IServiceContainer;

    // Import workflow state
    private currentImportPackage: ImportPackage | null = null;
    private currentConflicts: ConflictDetection | null = null;

    // Postman import state - cached so options changes can re-parse without re-uploading
    private postmanParser = new PostmanCollectionParser();
    private currentPostmanJson: string | null = null;
    private currentPostmanOptions: PostmanParseOptions = { includeHeaders: false };

    /** When set, replies bypass `this.panel` and go to whichever sink the
     *  caller provides (e.g. the Hub panel hosting this manager as a
     *  delegate). Always send via `postToWebview()` rather than calling
     *  `this.panel.webview.postMessage` directly. */
    private postMessageOverride?: (msg: unknown) => void;

    constructor(
        context: vscode.ExtensionContext,
        serviceContainer: IServiceContainer,
        endpointManager: APIEndpointManager,
        environmentManager: EnvironmentManager,
        postMessageOverride?: (msg: unknown) => void
    ) {
        super(context);
        this.serviceContainer = serviceContainer;
        this.endpointManager = endpointManager;
        this.environmentManager = environmentManager;
        this.postMessageOverride = postMessageOverride;

        // Resolve ImportExportService from DI container
        this.importExportService = serviceContainer.resolve<IImportExportService>(ServiceTokens.ImportExportService);
    }

    /** Single sink for all webview replies. Override is used when this
     *  manager runs as a delegate inside the Hub (no own panel). */
    private postToWebview(message: unknown): void {
        if (this.postMessageOverride) {
            this.postMessageOverride(message);
        } else {
            this.panel?.webview.postMessage(message);
        }
    }

    /**
     * Public entry point for the Hub to send messages into the embedded
     * import/export flow. The Hub forwards webview messages here. Replies
     * are routed via the `postMessageOverride` callback set in the ctor.
     */
    async dispatchHubMessage(message: ImportExportMessage): Promise<void> {
        await this.handleMessage(message);
    }

    /**
     * Public initial-state push for the Hub-embedded version. The standalone
     * webview invokes `initializeWebview()` via WebviewBase's 'ready' shared
     * message; the Hub has no such hook so it calls this directly when its
     * import/export section is first shown.
     */
    async pushInitialStateForHub(): Promise<void> {
        await this.initializeWebview();
    }

    /**
     * Get webview type identifier
     */
    getWebviewType(): string {
        return 'import-export';
    }

    /**
     * Override title for import/export webview
     */
    protected getWebviewTitle(config: WebviewConfig): string {
        return 'Dobermann - Import/Export';
    }

    /**
     * Open in the active editor column. The Hub is the active editor when
     * the user clicks Import/Export from its nav, so the import-export
     * webview opens as a sibling tab in the same column — replacing the
     * visible Hub content rather than splitting beside it. The Hub tab is
     * still there; closing import-export drops the user back onto it.
     */
    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Active;
    }

    /**
     * Get CSS links for webview
     */
    protected getCssLinks(): string {
        const cssUris = this.getSharedCssUris();
        const importExportCssUri = this.getWebviewUri('import-export/import-export.css');

        return `
            <link rel="stylesheet" href="${cssUris.atomic}">
            <link rel="stylesheet" href="${cssUris.core}">
            <link rel="stylesheet" href="${cssUris.modals}">
            <link rel="stylesheet" href="${cssUris.tables}">
            <link rel="stylesheet" href="${cssUris.toast}">
            <link rel="stylesheet" href="${importExportCssUri}">
        `;
    }

    /**
     * Get HTML content for webview
     */
    async getHtmlContent(config: WebviewConfig): Promise<string> {
        const template = this.loadTemplate('import-export.html');
        const cssLinks = this.getCssLinks();
        const scriptUri = this.getWebviewUri('import-export/import-export.js');
        const documentationHelpersUri = this.getWebviewUri('shared/documentation-helpers.js');
        const dbmnToastUri = this.getWebviewUri('shared/dbmn-toast.js');
        const dbmnClipboardUri = this.getWebviewUri('shared/dbmn-clipboard.js');

        return this.substituteTemplate(template, {
            SHARED_STYLES: cssLinks,
            SCRIPT_URI: scriptUri.toString(),
            DOCUMENTATION_HELPERS_SCRIPT: documentationHelpersUri.toString(),
            HELP_MODE_SCRIPT: this.getWebviewUri('shared/help-mode.js').toString(),   // DBMN-wide help mode
            BUTTON_CONTRAST_SCRIPT: this.getWebviewUri('shared/button-contrast.js').toString(),
            DBMN_TOAST_SCRIPT: dbmnToastUri.toString(),
            DBMN_CLIPBOARD_SCRIPT: dbmnClipboardUri.toString(),
            cspSource: this.panel!.webview.cspSource
        });
    }

    /**
     * Initialize webview when ready
     */
    protected async initializeWebview(): Promise<void> {
        // Load available endpoints and environments for selection
        const endpoints = await this.endpointManager.getAllEndpoints();
        const environments = await this.environmentManager.getAllEnvironments();

        console.log('[ImportExportManager.initializeWebview] Loaded endpoints:', {
            count: endpoints.length,
            endpoints: endpoints.map(e => ({ id: e.id, name: e.name, folder: e.folder }))
        });
        console.log('[ImportExportManager.initializeWebview] Loaded environments:', {
            count: environments.length,
            environments: environments.map(e => ({ id: e.id, name: e.name, folder: e.folder }))
        });

        // Group by folders
        const endpointFolders = this.groupByFolder(endpoints);
        const environmentFolders = this.groupByFolder(environments);

        // Send initial data to webview. If the caller hinted a startMode
        // (e.g. opened via Hub > Import or Hub > Export), the JS will jump
        // straight to that page and skip the landing chooser.
        const startMode = (this.currentConfig?.data as { startMode?: 'import' | 'export' } | undefined)?.startMode;
        this.postToWebview({
            type: 'initialized',
            payload: {
                endpoints: endpointFolders,
                environments: environmentFolders,
                startMode
            }
        });
    }

    /**
     * Handle messages from webview
     */
    async handleMessage(message: ImportExportMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                // Handled by base class (WebviewBase.handleSharedMessages)
                break;

            case 'exportSelected':
                await this.handleExport(message.payload);
                break;

            case 'uploadFile':
                await this.handleFileUpload(message.payload);
                break;

            case 'uploadPostmanFile':
                await this.handlePostmanUpload(message.payload);
                break;

            case 'postmanOptionsChanged':
                await this.handlePostmanOptionsChanged(message.payload);
                break;

            case 'confirmIncludeHeaders':
                await this.handleConfirmIncludeHeaders();
                break;

            case 'resolveConflicts':
                await this.handleConflictResolution(message.payload);
                break;

            case 'executeImport':
                await this.handleExecuteImport(message.payload);
                break;

            case 'openLocation':
                await this.handleOpenLocation(message.payload);
                break;

            case 'cancel':
                this.dispose();
                break;

            default:
                console.warn('[ImportExportWebview] Unknown message type:', message.type);
        }
    }

    /**
     * Handle export request from webview
     */
    private async handleExport(payload: {
        selectedEndpoints: string[];
        selectedEnvironments: string[];
        includeConsoleSettings: boolean;
        /** #289: opt-in, absent on older frontends — treated as false */
        includeCredentials?: boolean;
        filename: string;
    }): Promise<void> {
        try {
            console.log('[ImportExportManager.handleExport] Received payload:', {
                selectedEndpoints: payload.selectedEndpoints,
                selectedEnvironments: payload.selectedEnvironments,
                includeConsoleSettings: payload.includeConsoleSettings,
                includeCredentials: payload.includeCredentials === true,
                filename: payload.filename
            });

            // Show progress notification
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Exporting Dobermann Configuration',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: 'Collecting items...' });

                    const exportOptions: ExportOptions = {
                        endpoints: payload.selectedEndpoints,
                        environments: payload.selectedEnvironments,
                        includeConsoleSettings: payload.includeConsoleSettings,
                        includeCredentials: payload.includeCredentials === true,
                        filename: payload.filename || 'dbmn-export'
                    };

                    progress.report({ message: 'Creating ZIP file...' });
                    const result: ExportResult = await this.importExportService.exportToZip(exportOptions);

                    if (result.success && result.filePath) {
                        progress.report({ message: 'Export complete!' });

                        // Notify webview of success with full details
                        this.postToWebview({
                            type: 'exportComplete',
                            payload: {
                                success: true,
                                result: {
                                    ...result,
                                    filePath: result.filePath
                                }
                            }
                        });

                        // Don't auto-close - let user close when ready
                    } else {
                        throw new Error(result.error || 'Export failed');
                    }
                }
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            this.postToWebview({
                type: 'exportError',
                payload: { error: errorMessage }
            });
        }
    }

    /**
     * Handle file upload from webview
     */
    private async handleFileUpload(payload: { fileData: ArrayBuffer; fileName: string }): Promise<void> {
        try {
            // Convert ArrayBuffer to Buffer
            const buffer = Buffer.from(payload.fileData);

            // Parse import file
            const importPackage: ImportPackage = await this.importExportService.parseImportFile(buffer);
            this.currentImportPackage = importPackage;

            // Validate import package
            const validation: ValidationResult = await this.importExportService.validateImportPackage(importPackage);

            if (!validation.valid) {
                // Show validation errors
                this.postToWebview({
                    type: 'validationError',
                    payload: {
                        errors: validation.errors,
                        warnings: validation.warnings
                    }
                });
                return;
            }

            // Prepare import preview - show ALL items with their actions
            const importPreview = await this.importExportService.prepareImport(importPackage);

            console.log('[ImportExportManager.handleFileUpload] Import preview:', {
                totalItems: importPreview.items.length,
                create: importPreview.items.filter(i => i.action === 'create').length,
                update: importPreview.items.filter(i => i.action === 'update').length,
                conflict: importPreview.items.filter(i => i.action === 'conflict').length
            });

            // Send to webview for user selection
            this.postToWebview({
                type: 'importPreview',
                payload: {
                    validation,
                    importPreview: importPreview,
                    metadata: importPackage.metadata
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            this.postToWebview({
                type: 'importError',
                payload: { error: `Import file parsing failed: ${errorMessage}` }
            });
        }
    }

    /**
     * Handle Postman collection upload (issue #189).
     * Parses the JSON, builds a synthetic ImportPackage, and runs the existing
     * preview pipeline. Caches the JSON so option toggles can re-parse cheaply.
     */
    private async handlePostmanUpload(payload: { jsonText: string; fileName: string }): Promise<void> {
        try {
            this.currentPostmanJson = payload.jsonText;
            this.currentPostmanOptions = { includeHeaders: false };

            await this.runPostmanPreview(this.currentPostmanOptions, true);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.postToWebview({
                type: 'importError',
                payload: { error: `Postman import failed: ${errorMessage}` }
            });
        }
    }

    /**
     * Re-parse the cached Postman JSON with new options and push a fresh preview.
     */
    private async handlePostmanOptionsChanged(payload: PostmanParseOptions): Promise<void> {
        if (!this.currentPostmanJson) {
            this.postToWebview({
                type: 'importError',
                payload: { error: 'No Postman collection loaded. Please upload a file first.' }
            });
            return;
        }
        this.currentPostmanOptions = {
            includeHeaders: !!payload.includeHeaders,
            targetFolder: payload.targetFolder
        };
        try {
            await this.runPostmanPreview(this.currentPostmanOptions, false);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.postToWebview({
                type: 'importError',
                payload: { error: `Postman re-parse failed: ${errorMessage}` }
            });
        }
    }

    /**
     * User just ticked the "include headers" checkbox. Pop a warning modal first.
     * Confirm → re-parse with headers; cancel → tell webview to revert the box.
     */
    private async handleConfirmIncludeHeaders(): Promise<void> {
        if (!this.currentPostmanJson) {
            this.postToWebview({
                type: 'importError',
                payload: { error: 'No Postman collection loaded. Please upload a file first.' }
            });
            return;
        }

        const choice = await this.showModal({
            title: 'Import headers?',
            body: 'DBMN inherits headers from the Environment. Are you sure you want to import headers for these endpoints?',
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'include', label: 'Yes, include headers', variant: 'primary' }
            ],
            dismissible: true,
            size: 'sm'
        });

        if (choice.actionId === 'include') {
            this.currentPostmanOptions = {
                ...this.currentPostmanOptions,
                includeHeaders: true
            };
            await this.runPostmanPreview(this.currentPostmanOptions, false);
        } else {
            this.postToWebview({
                type: 'postmanIncludeHeadersReverted'
            });
        }
    }

    /**
     * Run parser → prepareImport → push importPreview to webview.
     * `firstUpload` distinguishes between initial upload (where we want to
     * include the postmanOptions panel definition) and option changes (where
     * the panel is already on screen).
     */
    private async runPostmanPreview(
        options: PostmanParseOptions,
        firstUpload: boolean
    ): Promise<void> {
        const dobermannVersion = this.context.extension?.packageJSON?.version ?? '0.0.0';
        const result = this.postmanParser.parse(this.currentPostmanJson!, options, dobermannVersion);

        this.currentImportPackage = result.importPackage;

        const importPreview = await this.importExportService.prepareImport(result.importPackage);

        // Existing endpoint folders for the target-folder dropdown
        const existingEndpoints = await this.endpointManager.getAllEndpoints();
        const existingFolders = Array.from(
            new Set(existingEndpoints.map((e: any) => e.folder).filter((f: any) => typeof f === 'string' && f.length > 0))
        ).sort();

        this.postToWebview({
            type: 'importPreview',
            payload: {
                validation: { valid: true, errors: [], warnings: [], versionCompatible: true },
                importPreview,
                metadata: result.importPackage.metadata,
                postmanOptions: {
                    showPanel: true,
                    firstUpload,
                    includeHeaders: options.includeHeaders,
                    targetFolder: options.targetFolder ?? null,
                    collectionName: result.collectionName,
                    endpointCount: result.endpointCount,
                    headerCount: result.headerCount,
                    detectedFolders: result.folders,
                    existingFolders,
                    unsupportedFeatures: result.unsupportedFeatures,
                    lostByEndpointId: result.lostByEndpointId
                }
            }
        });
    }

    /**
     * Handle conflict resolution from webview
     */
    private async handleConflictResolution(payload: { resolutions: ConflictResolution[] }): Promise<void> {
        if (!this.currentImportPackage) {
            this.postToWebview({
                type: 'importError',
                payload: { error: 'No import package loaded. Please upload a file first.' }
            });
            return;
        }

        // Update UI to show resolutions accepted
        this.postToWebview({
            type: 'resolutionsAccepted',
            payload: { resolutions: payload.resolutions }
        });
    }

    /**
     * Handle execute import from webview
     * GitHub Issue #90: Only import items user has selected
     */
    private async handleExecuteImport(payload: { selectedItems: any[] }): Promise<void> {
        if (!this.currentImportPackage) {
            this.postToWebview({
                type: 'importError',
                payload: { error: 'No import package loaded. Please upload a file first.' }
            });
            return;
        }

        console.log('[ImportExportManager.handleExecuteImport] Selected items:', {
            total: payload.selectedItems.length,
            create: payload.selectedItems.filter((i: any) => i.action === 'create').length,
            update: payload.selectedItems.filter((i: any) => i.action === 'update').length,
            conflict: payload.selectedItems.filter((i: any) => i.action === 'conflict').length
        });

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Importing Dobermann Configuration',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: 'Importing items...' });

                    const result: ImportResult = await this.importExportService.executeImportWithSelection(
                        payload.selectedItems
                    );

                    // Partial import: show the summary, which lists what failed —
                    // an error alone hid the items that did import
                    if (result.success || result.imported.length > 0) {
                        progress.report({ message: result.success ? 'Import complete!' : 'Import finished with errors' });

                        // Auto-refresh tree views (FR-UI-6)
                        // Notify webview with full import details
                        this.postToWebview({
                            type: 'importComplete',
                            payload: { success: result.success, result }
                        });

                        // Don't auto-close - let user close when ready
                    } else {
                        throw new Error(result.errors.join(', ') || 'Import failed');
                    }
                }
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            this.postToWebview({
                type: 'importError',
                payload: { error: `Import failed: ${errorMessage}` }
            });
        }
    }

    /**
     * Handle request to open exported file location
     */
    private async handleOpenLocation(payload: any): Promise<void> {
        try {
            if (payload && payload.filePath) {
                const folderPath = payload.filePath.substring(0, payload.filePath.lastIndexOf('/'));
                const folderUri = vscode.Uri.file(folderPath);
                await vscode.commands.executeCommand('revealFileInOS', folderUri);
            }
        } catch (error) {
            console.error('[ImportExportManager.handleOpenLocation] Error:', error);
            this.toast?.error('Failed to open folder location');
        }
    }

    /**
     * Group items by folder for tree display
     */
    private groupByFolder(items: any[]): Record<string, any[]> {
        // Check for duplicates in input
        const itemIds = items.map(i => i.id);
        const uniqueIds = new Set(itemIds);
        if (itemIds.length !== uniqueIds.size) {
            console.warn('[ImportExportManager.groupByFolder] Duplicate items detected!', {
                totalItems: itemIds.length,
                uniqueItems: uniqueIds.size,
                items: items.map(i => ({ id: i.id, name: i.name, folder: i.folder }))
            });
        }

        const grouped: Record<string, any[]> = {
            '': [] // Root folder
        };

        for (const item of items) {
            const folder = item.folder || '';
            if (!grouped[folder]) {
                grouped[folder] = [];
            }
            grouped[folder].push(item);
        }

        console.log('[ImportExportManager.groupByFolder] Grouped items by folder:',
            Object.entries(grouped).map(([folder, items]) => ({
                folder,
                count: items.length,
                items: items.map(i => ({ id: i.id, name: i.name }))
            }))
        );

        return grouped;
    }
}
