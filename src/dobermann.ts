// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { LoggerRegistry as AppLogRegistry } from './utils/logger-registry';
import * as vscode from 'vscode';
import type { StartupRecoverySummary } from './services/execution/startup-recovery.service';
import { getToast } from './services/notifications/get-toast';
// Removed axios dependency - using native fetch
import * as jwt from 'jsonwebtoken';
import { APIEndpointConfig } from './apiConfigManager';
import { APIEndpointManager } from './apiEndpointManager';
import { EnvironmentConfig, EnvironmentManager } from './environmentManager';
import { SystemManager } from './systemManager';
import { SystemMigrationService } from './services/migration/system-migration.service';
import { FolderToTagsMigrationService, FolderToTagsSummary } from './services/migration/folder-to-tags-migration.service';
import { EnvironmentWebviewManager } from './webviews/environment/environment-manager';
import { EndpointWebviewManager } from './webviews/endpoint/endpoint-manager';
import { ExecutionWebviewManager } from './webviews/execution/execution-webview-manager';
import { GeneralWebviewManager } from './webviews/general/general-manager';
import { WebviewConfig } from './webviews/shared/types';
import { DataLoadingOrchestrator } from './data-loading/data-loading-orchestrator';
import { DataLoadingConfig, ColumnMapping, ProgressUpdate, DataLoadingResult } from './data-loading/types';
import { JsonGenerator } from './data-loading/json-generator';
import { ExecutionMigrationManager, MigrationResult } from './storage/execution-migration';
import { DatabaseAdapter } from './services/storage/database-adapter';
import { createVsCodeExecutionStorage } from './platform/vscode/vscode-execution-storage';
import { IExecutionStorage } from './services/storage/execution-storage.interface';
import { stripJsonCommentsSafe } from './utils/json-comment-stripper';
import { FetchRequestExecutor } from './services/execution/fetch-request-executor';
import type { EndpointExecutionOptions, EndpointResponse, RequestEnvironment } from './services/execution/request-executor.interface';
import { promptDbmnAuthExpired } from './services/ui/dbmn-prompts';
import { IDbmnAuthService } from './services/dbmn-auth/dbmn-auth.interface';
import { flattenHeaders, flattenQueryParams, JWTPayload } from './utils/jwt-validation';
import { GoogleServiceAccountService } from './services/oauth/google-service-account.service';
import type { IOAuthService } from './services/oauth/oauth.interface';
import { decodeJwtPayload } from './utils/jwt-payload';
import { ServiceContainer } from './container/service-container';
import { IServiceContainer, ServiceTokens } from './container/service-container.interface';
import { registerExecutionServices } from './container/execution-service-registry';
import { IExecutionEngine } from './services/execution/execution-engine.interface';
import { registerCoreServices, CoreServiceTokens } from './container/core-services-registry';
import { IExtensionDiagnosticLogger } from './services/logging/extension-diagnostic-logger.interface';
import { registerProgressServices } from './container/progress-services-registry';
import { registerUIServices } from './container/ui-services-registry';
import { registerDataManagementServices } from './container/data-management-service-registry';
// Legacy message-dispatcher removed (GitHub Issue #194)
import { ensureDobermannWorkspaceFolder } from './utils/workspace-helper';
import { SwitchableStoreContext } from './services/catalogue/switchable-store-context';
import type { StoreContext } from './platform/interfaces/store-context.interface';
// import { registerPhase3Services } from './container/phase3-service-registry';

// Re-export interfaces for backward compatibility
export type { JWTPayload } from './utils/jwt-validation';

export interface APIConfiguration {
    baseUrl: string;
    path: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    queryParams: Record<string, string>;
    body?: string;
}

export class Dobermann {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private endpointManager: APIEndpointManager;
    private environmentManager: EnvironmentManager;
    private systemManager: SystemManager;
    private catalogueStore: SwitchableStoreContext;
    private dataLoadingOrchestrator: DataLoadingOrchestrator;
    private executionMetadataManager: IExecutionStorage;

    // Service architecture
    public serviceContainer: IServiceContainer;
    /** Issue #313: what startup recovery did this activation; the Hub shows it once. */
    public startupRecovery?: StartupRecoverySummary;
    // messageDispatcher removed (GitHub Issue #194)
    private _logger?: IExtensionDiagnosticLogger;

    // Webview managers — public so the Hub can coordinate close-with-unsaved
    // prompts when the user switches Hub sections.
    public environmentWebview: EnvironmentWebviewManager;
    public endpointWebview: EndpointWebviewManager;
    private executionWebview: ExecutionWebviewManager;
    private generalWebview: GeneralWebviewManager;

    private currentContext: 'environment' | 'endpoint' | 'execution' | 'general' = 'general';
    private currentItemId: string | undefined;

    // Legacy properties for public API compatibility
    private currentToken: string | undefined;
    private decodedToken: JWTPayload | undefined;

    // Data loading state management
    private activeDataLoadingSession: {
        orchestrator: DataLoadingOrchestrator;
        abortController: AbortController;
        isPaused: boolean;
    } | null = null;

    // Initialization state
    private isInitialized: boolean = false;
    private initializationPromise: Promise<void> | null = null;

    /** `deviceStore`: this device's own store (#362: its environments' secrets in the vault); `context` when not given. */
    constructor(context: vscode.ExtensionContext, deviceStore: StoreContext = context) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('DBMN Logs');
        // #342: the managers work on whichever store is current: this device's own, or the
        // account's shared catalogue once signed in to DBMN (VsCodeCatalogue switches it)
        this.catalogueStore = new SwitchableStoreContext(deviceStore);
        this.endpointManager = new APIEndpointManager(this.catalogueStore);
        this.environmentManager = new EnvironmentManager(this.catalogueStore);
        // Dobermann issue 7: the environments' secrets are never written to the log
        const appLogForSecrets = AppLogRegistry.getAppLog();
        if (appLogForSecrets) this.environmentManager.setSecretSink(value => appLogForSecrets.addSecret(value));
        this.systemManager = new SystemManager(this.catalogueStore);

        // GitHub Issue #102: Storage creation moved to async initialize() method
        this.executionMetadataManager = null as any; // Will be initialized in initialize()

        // Initialize service container and message dispatcher
        this.serviceContainer = new ServiceContainer();
        // messageDispatcher removed (GitHub Issue #194)

        // Register services in proper dependency order (foundation -> specific)

        // 1. Core Services (foundation - FileSystem, TemplateEngine)
        registerCoreServices(this.serviceContainer, {
            vscodeAPI: vscode,
            extensionContext: context
        });

        // 2. Progress Services (Phase 4 - TimeEstimation, BatchProgress)
        registerProgressServices(this.serviceContainer, {
            vscodeAPI: vscode,
            extensionContext: context
        });

        // 3. Execution Services (business logic)
        // NOTE: executionMetadataManager is registered AFTER initialize() creates SQLite storage
        // See initialize() method for the actual registration

        // 4. UI Services (depend on above services - StatusBar, ExecutionTree)
        registerUIServices(this.serviceContainer, {
            vscodeAPI: vscode,
            extensionContext: context,
            executionService: undefined, // Will be resolved from service container
            environmentManager: this.environmentManager
        });

        // console.log('[Dobermann] All service registrations completed successfully');

        // Create DataLoadingOrchestrator with properly injected services
        this.dataLoadingOrchestrator = this.createDataLoadingOrchestratorWithServices();

        // Initialize webview managers
        this.environmentWebview = new EnvironmentWebviewManager(context, this.environmentManager, this);

        // Pass service container to endpoint webview for Phase 3 integration
        // Note: serviceContainer is now public, so this will work
        this.endpointWebview = new EndpointWebviewManager(context, this.endpointManager, this);
        this.endpointWebview.serviceContainer = this.serviceContainer;

        this.executionWebview = new ExecutionWebviewManager({
            serviceContainer: this.serviceContainer,
            extensionContext: context,
            componentName: 'ExecutionWebviewManager',
            enableLogging: true
        });
        this.generalWebview = new GeneralWebviewManager(context);

        // Start initialization process
        this.initializationPromise = this.initialize();
    }

    /**
     * Lazy-loading getter for diagnostic logger
     * Resolves once from service container and caches the instance
     */
    private get logger(): IExtensionDiagnosticLogger {
        if (!this._logger) {
            this._logger = this.serviceContainer.resolve<IExtensionDiagnosticLogger>(
                CoreServiceTokens.ExtensionDiagnosticLogger
            );
        }
        return this._logger;
    }

    /**
     * Create execution storage manager - always uses database storage
     * GitHub Issue #102: Database storage is now the standard (JSON deprecated)
     */
    private async createExecutionStorageManager(context: vscode.ExtensionContext): Promise<any> {
        console.log('[Dobermann] 🗄️  Using database execution storage (standard)');

        const databaseStorage = new DatabaseAdapter(createVsCodeExecutionStorage(context));
        await databaseStorage.initialize();

        // Auto-migrate from JSON if exists
        await this.migrateJsonToSqlite(context, databaseStorage);

        return databaseStorage;
    }

    /**
     * One-time migration from JSON to database storage
     * GitHub Issue #102: Automatic migration for users upgrading
     */
    private async migrateJsonToSqlite(context: vscode.ExtensionContext, databaseStorage: any): Promise<void> {
        const fs = require('fs');
        const path = require('path');

        const jsonPath = path.join(context.globalStoragePath, 'execution.json');
        const backupPath = path.join(context.globalStoragePath, 'execution.json.backup');

        // Check if JSON file exists and hasn't been migrated
        if (!fs.existsSync(jsonPath) || fs.existsSync(backupPath)) {
            return; // Already migrated or no JSON file
        }

        try {
            console.log('[Dobermann] 📦 Migrating execution history from JSON to database...');

            // Read JSON file
            const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
            const executions = JSON.parse(jsonContent);

            if (Array.isArray(executions) && executions.length > 0) {
                // Bulk insert into database
                for (const execution of executions) {
                    try {
                        await databaseStorage.createExecution(execution);
                    } catch (error) {
                        console.warn('[Dobermann] ⚠️  Failed to migrate execution:', execution.id, error);
                    }
                }

                console.log(`[Dobermann] ✅ Migrated ${executions.length} executions to database`);
            }

            // Backup JSON file (don't delete - keep as safety net)
            fs.renameSync(jsonPath, backupPath);
            console.log('[Dobermann] 💾 Original JSON backed up to execution.json.backup');

        } catch (error) {
            console.error('[Dobermann] ❌ Migration failed:', error);
            // Don't throw - continue with empty SQLite DB
        }
    }

    private async initialize(): Promise<void> {
        try {
            // GitHub Issue #102: Create and initialize database storage (with auto-migration from JSON)
            this.executionMetadataManager = await this.createExecutionStorageManager(this.context);

            // NOW register execution services with the initialized database storage
            registerExecutionServices(this.serviceContainer, {
                dobermannInstance: this,
                vscodeAPI: vscode,
                extensionContext: this.context,
                executionMetadataManager: this.executionMetadataManager,
                environmentManager: this.environmentManager,
                endpointManager: this.endpointManager,
                systemManager: this.systemManager
            });

            // Register data management services (import/export, etc.)
            // Must be called AFTER execution services since it depends on managers
            registerDataManagementServices(this.serviceContainer, {
                extensionContext: this.context
            });

            // Perform migration on startup
            await this.migrateToEnvironments();

            // Assign existing endpoints + environments to Systems (one-off).
            try {
                const systemMigration = new SystemMigrationService(
                    this.context,
                    this.endpointManager,
                    this.environmentManager,
                    this.systemManager,
                    this.executionMetadataManager
                );
                const summary = await systemMigration.migrateIfNeeded();
                if (summary.ran && summary.systemsCreated > 0) {
                    this.outputChannel.appendLine(
                        `[Systems] Migration created ${summary.systemsCreated} System(s), ` +
                        `assigned ${summary.endpointsAssigned} endpoint(s) and ` +
                        `${summary.environmentsAssigned} environment(s).`
                    );
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.outputChannel.appendLine(`[Systems] Migration failed: ${msg}`);
            }

            // Copy legacy endpoint.folder values into endpoint.tags[] (one-off).
            try {
                const folderToTagsMigration = new FolderToTagsMigrationService(
                    this.context,
                    this.endpointManager
                );
                const summary = await folderToTagsMigration.migrateIfNeeded();
                logFolderToTagsSummary(this.outputChannel, summary);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.outputChannel.appendLine(`[Tags] Migration failed: ${msg}`);
            }

            // Update current token from active environment
            await this.updateCurrentToken();

            // Note: Storage manager already initialized in createExecutionStorageManager()
            // No need to call .initialize() again

            // Start ExecutionEngine to process queued executions
            await this.startExecutionEngine();

            // 3.1. Feature Flag and Service Bootstrap (Phase 4 - new architecture support)
            try {
                const { ServiceBootstrap } = await import('./container/service-bootstrap');
                const serviceBootstrap = new ServiceBootstrap(this.serviceContainer, this.logger as any);
                await serviceBootstrap.registerExecutionServices();

                // (Issue #313: startup recovery is StartupRecoveryService, run from extension.ts)

                // console.log('[Dobermann] Service bootstrap registered successfully');
            } catch (error) {
                this.logger.warn('[Dobermann] Could not register service bootstrap:', error);
            }

            this.isInitialized = true;
        } catch (error) {
            throw error;
        }
    }

    public async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        if (!this.isInitialized) {
            throw new Error('Dobermann failed to initialize');
        }
    }

    /**
     * Start ExecutionEngine to process queued executions
     */
    private async startExecutionEngine(): Promise<void> {
        try {
            const executionEngine = this.serviceContainer.resolve<IExecutionEngine>(ServiceTokens.ExecutionEngine);
            await executionEngine.start();
            // console.log('[Dobermann] ExecutionEngine started successfully');
        } catch (error) {
            this.logger.error('[Dobermann] Failed to start ExecutionEngine:', error instanceof Error ? error : new Error(String(error)));
        }
    }

    public setCurrentContext(context: 'environment' | 'endpoint' | 'execution' | 'general', itemId?: string): void {
        this.currentContext = context;
        this.currentItemId = itemId;
    }

    // Token Status Method
    public getTokenStatus(): { isValid: boolean; userInfo?: string } {
        try {
            if (!this.currentToken || !this.decodedToken) {
                return { isValid: false, userInfo: undefined };
            }

            // Check if token is expired
            const currentTime = Math.floor(Date.now() / 1000);
            if (this.decodedToken.exp && this.decodedToken.exp < currentTime) {
                return { isValid: false, userInfo: 'Token expired' };
            }

            // This synchronous status says only that the token is valid
            const userInfo = 'Valid token';

            return { isValid: true, userInfo };
        } catch (error) {
            return { isValid: false, userInfo: 'Error checking token' };
        }
    }

    private async updateCurrentToken(): Promise<void> {
        try {
            const activeEnvironment = await this.environmentManager.getActiveEnvironment();
            if (activeEnvironment) {
                const token = await this.environmentManager.getEnvironmentToken(activeEnvironment.id);
                if (token) {
                    this.currentToken = token;
                    this.decodedToken = jwt.decode(token) as JWTPayload;
                }
            }
        } catch (error) {
            // Silent fail for token update
        }
    }

    // Workspace File Management Methods
    public async createWorkspaceResultFile(
        response: any,
        method: string,
        endpoint: string,
        duration: number,
        endpointFolder?: string,
        endpointName?: string,
        autoOpen: boolean = false,
        executionId?: string
    ): Promise<{
        success: boolean;
        filePath?: string;
        filename?: string;
        folderName?: string;
        content?: string;
        autoOpened?: boolean;
        error?: string;
    }> {

        try {
            // Check if workspace exists
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                this.logger.warn('❌ No workspace folder open');
                return {
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceUri = await ensureDobermannWorkspaceFolder();

            // Get active environment
            // console.log('🌍 Getting active environment...');
            const activeEnvironment = await this.environmentManager.getActiveEnvironment();
            const environmentName = activeEnvironment?.name || 'default';
            // console.log('🌍 Active environment:', environmentName);

            // Use endpoint name for folder, fallback to sanitized path if name not available
            const nameToUse = endpointName || endpoint;
            const folderName = this.sanitizeEndpointName(nameToUse);

            // Generate filename with timestamp
            const timestamp = this.generateTimestamp();
            const filename = `${method.toUpperCase()}-${folderName}-${timestamp}.json`;
            // console.log('📝 Generated filename:', filename);

            // Create folder structure: {environment}/[{endpointFolder}/]{sanitized-endpoint}/results/
            const environmentFolder = vscode.Uri.joinPath(workspaceUri, environmentName);

            // Add endpoint folder if specified
            let baseFolder = environmentFolder;
            if (endpointFolder && endpointFolder.trim() !== '') {
                const sanitizedEndpointFolder = this.sanitizeEndpointName(endpointFolder);
                baseFolder = vscode.Uri.joinPath(environmentFolder, sanitizedEndpointFolder);
            }

            const endpointNameFolder = vscode.Uri.joinPath(baseFolder, folderName);
            const resultsFolder = vscode.Uri.joinPath(endpointNameFolder, 'results');

            if (endpointFolder && endpointFolder.trim() !== '') {
                // console.log('  - Endpoint category folder:', baseFolder.fsPath);
            }
            await vscode.workspace.fs.createDirectory(resultsFolder);

            // Create file content with metadata
            const fileContent = this.createFileContentWithMetadata(
                response,
                method,
                endpoint,
                duration,
                environmentName
            );

            // Write file
            const filePath = vscode.Uri.joinPath(resultsFolder, filename);

            await vscode.workspace.fs.writeFile(filePath, Buffer.from(fileContent));

            // Auto-open file if requested
            let autoOpened = false;
            if (autoOpen) {
                const document = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(document);
                autoOpened = true;
            }

            // Update execution metadata in database if executionId provided
            if (executionId) {
                try {
                    await this.executionMetadataManager.updateExecution(executionId, {
                        status: 'completed',
                        runTime: duration,
                        completedAt: new Date(),
                        responseFile: filePath.fsPath,
                        httpStatus: response.status,
                        httpStatusText: response.statusText
                    });
                    // console.log(`📊 Updated execution metadata for ${executionId}`);
                } catch (error) {
                    this.logger.error('❌ Failed to update execution metadata:', error instanceof Error ? error : new Error(String(error)));
                    // Don't fail the entire operation if metadata update fails
                }
            }

            return {
                success: true,
                filePath: filePath.fsPath,
                filename,
                folderName,
                content: fileContent,
                autoOpened
            };

        } catch (error) {
            this.logger.error('💥 createWorkspaceResultFile failed:', error instanceof Error ? error : new Error(String(error)));
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // New method for ExecutionFileService - accepts pre-generated filename and content
    public async createWorkspaceFile(
        fileName: string,
        content: string,
        folderName?: string
    ): Promise<{
        success: boolean;
        filePath?: string;
        filename?: string;
        folderName?: string;
        content?: string;
        autoOpened?: boolean;
        error?: string;
    }> {
        try {
            // Check if workspace exists
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                this.logger.warn('❌ No workspace folder open');
                return {
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            // Get active environment
            const activeEnvironment = await this.environmentManager.getActiveEnvironment();
            const environmentName = activeEnvironment ? activeEnvironment.name : 'default';

            // Use provided folder name or default
            const targetFolder = folderName || 'results';

            // Build the directory path: workspace/environment/folder/
            const workspaceUri = await ensureDobermannWorkspaceFolder();
            const environmentDir = vscode.Uri.joinPath(workspaceUri, environmentName);
            const targetDir = vscode.Uri.joinPath(environmentDir, targetFolder);

            // Ensure directories exist
            await vscode.workspace.fs.createDirectory(environmentDir);
            await vscode.workspace.fs.createDirectory(targetDir);

            // Create the file path
            const fileUri = vscode.Uri.joinPath(targetDir, fileName);

            // Write the file
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));

            // Don't auto-open files - user will open manually from execution history
            let autoOpened = false;

            return {
                success: true,
                filePath: fileUri.fsPath,
                filename: fileName,
                folderName: targetFolder,
                content: content,
                autoOpened: autoOpened
            };

        } catch (error) {
            this.logger.error('💥 createWorkspaceFile failed:', error instanceof Error ? error : new Error(String(error)));
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private sanitizeEndpointName(endpoint: string): string {

        if (!endpoint || endpoint.trim() === '') {
            return 'unknown-endpoint';
        }

        const step1 = endpoint.replace(/^\/+/g, ''); // Remove leading slash

        const step2 = step1.replace(/\{([^}]*)\}/g, '$1'); // Extract parameter names from {param}

        const step3 = step2.replace(/\?.*$/g, ''); // Remove query parameters

        const step4 = step3.replace(/[^a-zA-Z0-9]/g, '-'); // Replace special chars with dashes

        const step5 = step4.replace(/-+/g, '-'); // Replace multiple dashes with single

        const final = step5.replace(/^-|-$/g, ''); // Remove leading/trailing dashes

        return final;
    }

    private generateTimestamp(): string {
        const now = new Date();
        return now.toISOString()
            .replace(/T/, '-')
            .replace(/:/g, '-')
            .replace(/\\..*$/, '')
            .substring(0, 19); // YYYY-MM-DD-HH-MM-SS
    }

    private formatDuration(duration: number): string {
        return `${duration}ms`;
    }

    private createFileContentWithMetadata(
        response: any,
        method: string,
        endpoint: string,
        duration: number,
        environment: string
    ): string {
        // Create minimal metadata for the main response file
        const minimalMeta = {
            status: response.status,
            statusText: response.statusText,
            method: method.toUpperCase(),
            endpoint,
            timestamp: new Date().toISOString(),
            duration: this.formatDuration(duration),
            environment,
            responseHeaders: response.headers || {}
        };

        // Main response file structure (hybrid approach)
        let fileContent: any;

        if (response.data && typeof response.data === 'object') {
            // If response.data is an object, merge minimal meta with the response data
            fileContent = {
                _meta: minimalMeta,
                ...response.data
            };
        } else {
            // If response.data is not an object, wrap it
            fileContent = {
                _meta: minimalMeta,
                data: response.data
            };
        }

        return JSON.stringify(fileContent, null, 2);
    }

    async openDobermann(context: 'environment' | 'endpoint' | 'execution' | 'general' = 'general', itemId?: string, defaultFolder?: string) {
        // Handle context switching with unsaved changes detection
        const currentWebview = this.getCurrentWebview();

        if (currentWebview && (this.currentContext !== context || this.currentItemId !== itemId)) {
            const hasUnsavedChanges = await currentWebview.checkForUnsavedChanges();

            if (hasUnsavedChanges) {
                const choice = await currentWebview.showUnsavedChangesDialog();

                switch (choice) {
                    case 'save':
                        const saveSuccess = await currentWebview.saveCurrentContext();
                        if (!saveSuccess) {
                            return; // Don't switch if save failed
                        }
                        break;
                    case 'discard':
                        // Continue with context switch, discarding changes
                        break;
                    case 'cancel':
                        // Don't switch contexts
                        return;
                }
            }
        }

        // Store context for this session
        this.currentContext = context;
        this.currentItemId = itemId;


        // Route to appropriate webview manager
        const config: WebviewConfig = {
            context,
            itemId,
            defaultFolder: defaultFolder
        };

        switch (context) {
            case 'environment':
                await this.environmentWebview.createWebview(config);
                break;
            case 'endpoint':
                await this.endpointWebview.createWebview(config);
                break;
            case 'execution':
                await this.executionWebview.createWebview(config);
                break;
            default:
                await this.generalWebview.createWebview(config);
                break;
        }
    }

    private getCurrentWebview() {
        switch (this.currentContext) {
            case 'environment':
                return this.environmentWebview;
            case 'endpoint':
                return this.endpointWebview;
            case 'execution':
                return this.executionWebview;
            case 'general':
                return this.generalWebview;
            default:
                return null;
        }
    }

    // Update current item ID (used by webview managers after saving new items)
    public updateCurrentItemId(itemId: string): void {
        this.currentItemId = itemId;
    }

    // Handle webview disposal notification
    public handleWebviewClosed(context: string, itemId?: string): void {
        // Only clear context tracking if the closed webview matches the current context
        if (this.currentContext === context && this.currentItemId === itemId) {
            this.currentContext = 'general'; // Reset to default
            this.currentItemId = undefined;
        }
        // Fan-out to whoever is listening — the Hub uses this to clear row
        // highlights and switch its visible section back to the source.
        this._onEditorClosed.fire({ context, itemId });
    }

    /** Fires whenever an editor-style webview (endpoint / environment / console
     *  / transaction) is disposed. Public so the Hub can react. */
    private readonly _onEditorClosed = new vscode.EventEmitter<{ context: string; itemId?: string }>();
    public readonly onEditorClosed: vscode.Event<{ context: string; itemId?: string }> = this._onEditorClosed.event;

    /** Called from the console webview command site when its panel disposes
     *  (the console doesn't extend WebviewBase, so it can't notify via the
     *  internal command path the editor webviews use). */
    public notifyConsoleClosed(itemId?: string): void {
        this._onEditorClosed.fire({ context: 'transaction', itemId });
    }

    // Public methods for external API compatibility
    public async getCurrentToken(): Promise<string | undefined> {
        // Get token from active environment
        const activeEnv = await this.environmentManager.getActiveEnvironment();
        if (activeEnv) {
            return await this.environmentManager.getEnvironmentToken(activeEnv.id);
        }
        return undefined;
    }

    public async getActiveEnvironment(): Promise<any> {
        return await this.environmentManager.getActiveEnvironment();
    }

    public async getDecodedToken(): Promise<JWTPayload | undefined> {
        const token = await this.getCurrentToken();
        if (token) {
            try {
                return jwt.decode(token) as JWTPayload;
            } catch (error) {
                return undefined;
            }
        }
        return undefined;
    }

    public async getBaseUrl(): Promise<string> {
        const decoded = await this.getDecodedToken();
        if (!decoded?.iss) {
            return '';
        }
        return this.extractBaseUrlFromIss(decoded.iss);
    }

    public async isTokenValid(): Promise<boolean> {
        const token = await this.getCurrentToken();
        if (!token) return false;

        const decoded = await this.getDecodedToken();
        if (!decoded || !decoded.exp) return false;

        const currentTime = Math.floor(Date.now() / 1000);
        return decoded.exp >= currentTime;
    }

    public getEndpointManager(): APIEndpointManager {
        return this.endpointManager;
    }

    /** The "DBMN Logs" output channel. */
    public getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }

    /** #342: the store behind the catalogue managers (switched to the shared catalogue on sign-in). */
    public getCatalogueStore(): SwitchableStoreContext {
        return this.catalogueStore;
    }

    public getSystemManager(): SystemManager {
        return this.systemManager;
    }

    public getEndpointWebviewManager(): EndpointWebviewManager {
        return this.endpointWebview;
    }

    public getEnvironmentManager(): EnvironmentManager {
        return this.environmentManager;
    }

    /**
     * @deprecated DataLoadingOrchestrator is deprecated (Phase 3.1 OLD architecture)
     * Use NEW architecture services (BatchExecutionEngine) via ServiceContainer instead
     * Will be removed in future version after further testing
     */
    public getDataLoadingOrchestrator(): DataLoadingOrchestrator {
        this.logger.warn('[DEPRECATION] getDataLoadingOrchestrator() is deprecated - OLD Phase 3.1 architecture. Use NEW BatchExecutionEngine via ServiceContainer.');
        return this.dataLoadingOrchestrator;
    }

    public getExecutionMetadataManager(): IExecutionStorage {
        return this.executionMetadataManager;
    }

    /**
     * Dispose resources — flush pending DB writes to prevent data loss on extension deactivation.
     */
    public dispose(): void {
        if (this.executionMetadataManager && typeof (this.executionMetadataManager as DatabaseAdapter).close === 'function') {
            (this.executionMetadataManager as DatabaseAdapter).close();
        }
    }

    public async openExecutionHistory(): Promise<void> {
        await this.waitForInitialization();

        const config: WebviewConfig = {
            context: 'execution',
            itemId: 'execution-history',
            data: { viewType: 'table' }
        };

        // console.log(`[Dobermann] Opening execution history table with config:`, config);

        // Store context for this session
        this.currentContext = 'execution';
        this.currentItemId = 'execution-history';

        await this.executionWebview.createWebview(config);
    }

    public async migrateExecutionFiles(): Promise<MigrationResult> {
        const migrationManager = new ExecutionMigrationManager(this.context, this.executionMetadataManager);
        return migrationManager.migrateWorkspaceExecutionFiles();
    }

    // Helper function to convert headers to flat format for API requests
    private flattenHeaders(headers: Record<string, string | { value: string; enabled: boolean }>): Record<string, string> {
        return flattenHeaders(headers);
    }

    // Helper function to convert query params to flat format for API requests (GitHub Issue #101)
    private flattenQueryParams(queryParams: Record<string, string | { value: string; enabled: boolean }>): Record<string, string> {
        return flattenQueryParams(queryParams);
    }

    // Execute API request using endpoint configuration
    // @deprecated Use ExecutionCommands.runApiEndpointCommand() with new Transaction Preparation + Pure Execution architecture instead
    // Issue #322: the request itself is FetchRequestExecutor's; this keeps the VS Code side
    // (environments and tokens).
    public async executeEndpoint(endpointConfig: APIEndpointConfig, abortSignal?: AbortSignal, environmentId?: string, options?: EndpointExecutionOptions): Promise<EndpointResponse> {
        return this.getRequestExecutor().executeEndpoint(endpointConfig, abortSignal, environmentId, options);
    }

    private requestExecutor?: FetchRequestExecutor;

    /** Issue #322: the portable executor over this extension's environments and tokens. */
    public getRequestExecutor(): FetchRequestExecutor {
        if (!this.requestExecutor) {
            this.requestExecutor = new FetchRequestExecutor({
                environments: this.environmentManager,
                getToken: (environment, environmentId, options) => this.acquireRequestToken(environment, environmentId, options),
                secretSink: value => AppLogRegistry.getAppLog()?.addSecret(value),
                logger: this.logger
            });
        }
        return this.requestExecutor;
    }

    /**
     * Issue #126: the bearer token for a request, by the environment's auth method.
     * Issue #322: FetchRequestExecutor's RequestTokenProvider in the extension.
     */
    private async acquireRequestToken(activeEnvironment: RequestEnvironment | undefined, environmentId: string | undefined, options?: EndpointExecutionOptions): Promise<string | undefined> {
        const targetEnvironment = activeEnvironment as EnvironmentConfig | undefined;
        let token: string | undefined;

        if (activeEnvironment?.authMethod === 'google-service-account') {
            // Use Google Service Account authentication
            if (targetEnvironment?.googleServiceAccountConfig) {
                try {
                    const googleAuthService = new GoogleServiceAccountService(this.environmentManager);
                    const accessToken = await googleAuthService.getAccessToken(targetEnvironment.id);
                    if (accessToken) {
                        token = accessToken;
                        this.logger.info(`🔐 [Dobermann.executeEndpoint] Got Google Service Account token for ${activeEnvironment.name}`);
                    } else {
                        throw new Error('Failed to get access token from Google Service Account');
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error(`Google Service Account authentication failed: ${errorMessage}`);
                }
            } else {
                throw new Error('Google Service Account configuration is missing. Please configure service account in environment settings.');
            }
        } else if (activeEnvironment?.authMethod === 'dbmn') {
            const dbmnAuth = (global as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
            if (!dbmnAuth) {
                throw new Error('DBMN authentication service not available.');
            }
            const result = await dbmnAuth.ensureValidSession();
            if (result.status === 'success' && result.session?.accessToken) {
                token = result.session.accessToken;
            } else if (!options?.isBatchMember) {
                // Interactive: prompt re-login via the DBMN-branded modal.
                // The in-app magic-link flow runs inside the helper; the user
                // must click the link in their inbox to actually sign in, then
                // re-trigger the execution. We always throw here because the
                // current run can't proceed with an expired session.
                const toast = (global as Record<string, unknown>).dbmnToastService as import('./services/notifications/toast.interface').IToastService;
                const signedIn = await promptDbmnAuthExpired(dbmnAuth, toast);
                if (!signedIn) {
                    throw new Error('Execution cancelled — DBMN authentication required');
                }
                throw new Error('Sign-in link sent — click the link in your inbox, then run again');
            }
            // Batch members: leave token undefined → 401 → batch engine retry handles it
        } else if (activeEnvironment?.authMethod === 'none') {
            // No authentication required
            token = undefined;
        } else {
            // Standard JWT or OAuth authentication
            token = environmentId && targetEnvironment
                ? await this.environmentManager.getEnvironmentToken(targetEnvironment.id)
                : await this.getCurrentToken();
            // #359: an OAuth token that has expired is refreshed before it's sent (no browser),
            // so a long batch, or the web app's run through the local agent, carries on
            if (targetEnvironment?.authMethod === 'oauth' && token && this.tokenHasExpired(token)) {
                const oauth = this.serviceContainer.resolve<IOAuthService>('IOAuthService');
                if (await oauth.refreshSilently(targetEnvironment.id)) {
                    token = await this.environmentManager.getEnvironmentToken(targetEnvironment.id);
                }
            }
        }
        return token;
    }

    /** #359: a JWT whose `exp` has passed (a token that isn't a JWT: the API judges it). */
    private tokenHasExpired(token: string): boolean {
        const exp = decodeJwtPayload<{ exp?: number }>(token)?.exp;
        return typeof exp === 'number' && exp <= Math.floor(Date.now() / 1000);
    }

    // Data Loading API Integration
    public async executeDataLoading(
        config: DataLoadingConfig,
        csvData: string[][],
        columnMapping: ColumnMapping[],
        onProgress: (progress: ProgressUpdate) => void
    ): Promise<DataLoadingResult> {
        // Create abort controller for this session
        const abortController = new AbortController();

        this.activeDataLoadingSession = {
            orchestrator: this.dataLoadingOrchestrator,
            abortController,
            isPaused: false
        };

        try {
            // Create API executor that uses this Dobermann instance
            const apiExecutor = this.createDataLoadingApiExecutor();

            // Try to get current environment and endpoint for batch creation
            let enhancedConfig: any = config;

            try {
                const activeEnvironment = await this.environmentManager.getActiveEnvironment();
                // console.log(`[Dobermann] Current context: ${this.currentContext}, currentItemId: ${this.currentItemId}`);
                // console.log(`[Dobermann] Active environment:`, activeEnvironment);

                // If we have current endpoint context, try to get endpoint info
                if (this.currentContext === 'endpoint' && this.currentItemId) {
                    const endpoint = await this.endpointManager.getEndpoint(this.currentItemId);
                    // console.log(`[Dobermann] Retrieved endpoint:`, endpoint);
                    if (endpoint && activeEnvironment) {
                        enhancedConfig = {
                            ...config,
                            environment: activeEnvironment.name,
                            endpoint: {
                                id: endpoint.id,
                                name: endpoint.name,
                                method: endpoint.method,
                                path: endpoint.path
                            },
                            csvFile: '/tmp/csv-batch-upload.csv' // Placeholder since we don't have the actual file path
                        };

                        // console.log('[Dobermann] Using enhanced config for batch creation');

                        // Call executeDataLoadingWithBatch to create batches
                        const result = await this.dataLoadingOrchestrator.executeDataLoadingWithBatch(
                            enhancedConfig,
                            csvData,
                            columnMapping,
                            onProgress,
                            apiExecutor
                        );

                        // Display summary in output channel
                        this.displayDataLoadingResults(result);

                        return result;
                    }
                }
            } catch (enhancementError) {
                // console.log('[Dobermann] Could not enhance config for batch creation, falling back to standard execution');
            }

            // Fallback to standard execution without batch creation
            const result = await this.dataLoadingOrchestrator.executeDataLoading(
                config,
                csvData,
                columnMapping,
                onProgress,
                apiExecutor
            );

            // Display summary in output channel
            this.displayDataLoadingResults(result);

            return result;
        } finally {
            // Clean up session
            this.activeDataLoadingSession = null;
        }
    }

    public pauseDataLoading(): boolean {
        if (this.activeDataLoadingSession) {
            this.activeDataLoadingSession.isPaused = true;
            return true;
        }
        return false;
    }

    public resumeDataLoading(): boolean {
        if (this.activeDataLoadingSession) {
            this.activeDataLoadingSession.isPaused = false;
            return true;
        }
        return false;
    }

    public cancelDataLoading(): boolean {
        if (this.activeDataLoadingSession) {
            this.activeDataLoadingSession.abortController.abort();
            this.activeDataLoadingSession = null;
            return true;
        }
        return false;
    }

    public isDataLoadingActive(): boolean {
        return this.activeDataLoadingSession !== null;
    }

    private createDataLoadingApiExecutor() {
        return async (url: string, options: any) => {
            // Check if session is aborted
            if (this.activeDataLoadingSession?.abortController.signal.aborted) {
                throw new Error('Data loading cancelled');
            }

            // Handle pause functionality
            while (this.activeDataLoadingSession?.isPaused) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (this.activeDataLoadingSession?.abortController.signal.aborted) {
                    throw new Error('Data loading cancelled');
                }
            }

            // Create a synthetic endpoint config for the API call
            const endpointConfig: APIEndpointConfig = {
                id: 'data-loading-temp',
                name: 'Data Loading Request',
                method: options.method || 'POST',
                path: url,
                headers: options.headers || {},
                queryParams: {},
                body: options.body || '',
                dataLoadingConfig: undefined // Not needed for individual requests
            };

            // Execute using existing Dobermann API execution logic
            const response = await this.executeEndpoint(endpointConfig);

            // Convert Dobermann response format to fetch-like response expected by orchestrator
            return {
                ok: response.success,
                status: response.status || (response.success ? 200 : 500),
                statusText: response.statusText || (response.success ? 'OK' : 'Error'),
                headers: response.headers || {},
                json: async () => response.data,
                text: async () => JSON.stringify(response.data)
            };
        };
    }

    private displayDataLoadingResults(result: DataLoadingResult) {
        this.outputChannel.clear();
        this.outputChannel.appendLine('=== Data Loading Results ===');
        this.outputChannel.appendLine(`Total Rows: ${result.totalRows}`);
        this.outputChannel.appendLine(`Processed: ${result.processedRows}`);
        this.outputChannel.appendLine(`Successful: ${result.successfulRows}`);
        this.outputChannel.appendLine(`Failed: ${result.failedRows}`);
        this.outputChannel.appendLine(`Success Rate: ${result.summary.successRate.toFixed(1)}%`);
        this.outputChannel.appendLine(`Duration: ${result.duration}ms`);
        this.outputChannel.appendLine('');

        if (result.summary.totalTestsRun > 0) {
            this.outputChannel.appendLine('Test Results:');
            this.outputChannel.appendLine(`Tests Run: ${result.summary.totalTestsRun}`);
            this.outputChannel.appendLine(`Tests Passed: ${result.summary.totalTestsPassed}`);
            this.outputChannel.appendLine(`Tests Failed: ${result.summary.totalTestsFailed}`);
            this.outputChannel.appendLine('');
        }

        if (result.stopped) {
            this.outputChannel.appendLine(`Processing stopped: ${result.stoppedReason}`);
            this.outputChannel.appendLine('');
        }

        // Show first few errors if any
        const errorResults = result.rowResults.filter(r => !r.success).slice(0, 5);
        if (errorResults.length > 0) {
            this.outputChannel.appendLine('Recent Errors:');
            errorResults.forEach(error => {
                this.outputChannel.appendLine(`Row ${error.rowIndex}: ${error.errorMessage}`);
            });
            if (result.failedRows > 5) {
                this.outputChannel.appendLine(`... and ${result.failedRows - 5} more errors`);
            }
        }

        this.outputChannel.show();
    }

    private async displayResponse(response: any) {

        // Try workspace file creation first
        const workspaceResult = await this.createWorkspaceResultFile(
            response,
            response.method || 'GET',
            response.path || '/api/unknown',
            response.duration || 0,
            response.endpointFolder,
            response.endpointName
        );

        if (workspaceResult.success) {

            // Successfully created workspace file - show brief summary in output channel
            this.outputChannel.clear();
            this.outputChannel.appendLine(`✅ ${response.method || 'GET'} ${response.path || '/api/unknown'} → ${response.status} ${response.statusText || 'OK'} (${response.duration || 0}ms)`);
            this.outputChannel.appendLine(`📁 Response saved to: ${workspaceResult.filename}`);
            this.outputChannel.appendLine(`📂 Full path: ${workspaceResult.filePath}`);
            this.outputChannel.show();
            return;
        }

        this.logger.warn('⚠️ Workspace file creation failed, falling back to output channel:', workspaceResult.error);

        // Fall back to output channel if workspace file creation failed
        // console.log('📺 Falling back to output channel display');
        this.outputChannel.clear();
        this.outputChannel.appendLine('=== API Response ===');
        this.outputChannel.appendLine(`Status: ${response.status || 'Error'} ${response.statusText || ''}`);
        this.outputChannel.appendLine('');

        if (response.headers) {
            this.outputChannel.appendLine('Headers:');
            Object.entries(response.headers).forEach(([key, value]) => {
                this.outputChannel.appendLine(`  ${key}: ${value}`);
            });
            this.outputChannel.appendLine('');
        }

        this.outputChannel.appendLine('Response Body:');
        this.outputChannel.appendLine(JSON.stringify(response.data, null, 2));

        if (workspaceResult.error) {
            this.outputChannel.appendLine('');
            this.outputChannel.appendLine(`Note: Workspace file creation failed: ${workspaceResult.error}`);
        }

        this.outputChannel.show();
        // console.log('📺 Output channel display completed');
    }

    private extractBaseUrlFromIss(iss: string): string {
        try {
            const url = new URL(iss);
            // Remove '-auth' from hostname and remove path
            const hostname = url.hostname.replace('-auth', '');
            return `${url.protocol}//${hostname}`;
        } catch (error) {
            return '';
        }
    }

    private async migrateToEnvironments(): Promise<void> {
        try {
            // Check if we already have environments
            const environments = await this.environmentManager.getAllEnvironments();
            if (environments.length > 0) {
                return; // Migration already done
            }

            // Check if there's a legacy JWT token
            const legacyToken = await this.context.secrets.get('jwt_token');
            if (legacyToken) {
                // Create a default environment with the legacy token
                const defaultEnv = await this.environmentManager.addEnvironment({
                    name: 'Default',
                    description: 'Migrated from legacy JWT storage',
                    isActive: true
                });

                // Store the legacy token in the new environment
                await this.environmentManager.setEnvironmentToken(defaultEnv.id, legacyToken);

                // Try to extract base URL from the token
                try {
                    const decoded = jwt.decode(legacyToken) as JWTPayload;
                    if (decoded && decoded.iss) {
                        const baseUrl = this.extractBaseUrlFromIss(decoded.iss);
                        if (baseUrl) {
                            await this.environmentManager.updateEnvironment(defaultEnv.id, { baseUrl });
                        }
                    }
                } catch (error) {
                    this.logger.warn('Failed to decode legacy token during migration:', error);
                }

                // Clear the legacy token storage
                await this.context.secrets.delete('jwt_token');

                // console.log('Successfully migrated legacy JWT token to default environment');
            } else {
                // No legacy token, create a default environment anyway
                await this.environmentManager.addEnvironment({
                    name: 'Default',
                    description: 'Default environment',
                    isActive: true
                });

                // console.log('Created default environment for new installation');
            }
        } catch (error) {
            this.logger.error('Failed to migrate to environments:', error instanceof Error ? error : new Error(String(error)));
            // Don't throw - we don't want to break the extension if migration fails
        }
    }

    /**
     * @deprecated Creating DataLoadingOrchestrator is deprecated (Phase 3.1 OLD architecture)
     * Use NEW architecture services (BatchExecutionEngine) via ServiceContainer instead
     */
    private createDataLoadingOrchestratorWithServices(): DataLoadingOrchestrator {
        this.logger.warn('[DEPRECATION] createDataLoadingOrchestratorWithServices() is deprecated - OLD Phase 3.1 architecture. Use NEW BatchExecutionEngine.');
        try {
            // Resolve services from the service container
            const { ProgressServiceTokens } = require('./container/progress-services-registry');
            const { ServiceTokens } = require('./container/service-container.interface');

            // Resolve Phase 4 services
            const timeEstimationService = this.serviceContainer.resolve(ProgressServiceTokens.TimeEstimationService);
            const batchProgressService = this.serviceContainer.resolve(ProgressServiceTokens.BatchProgressService);

            // Resolve execution service
            const executionMetadataService = this.serviceContainer.resolve(ServiceTokens.ExecutionMetadataService);

            // Resolve core services - FileSystemService can act as batchFileManager
            const fileSystemService = this.serviceContainer.resolve(CoreServiceTokens.FileSystemService) as any;

            // Create a batch file manager adapter from FileSystemService
            const batchFileManager = {
                createBatchWorkspace: async () => {
                    const workspaceDir = `${this.context.extensionPath}/workspace/batch-${Date.now()}`;
                    await fileSystemService.createDirectory(workspaceDir);
                    return workspaceDir;
                },
                copyCsvFile: async (sourcePath: string, workspaceDir: string) => {
                    const fileName = sourcePath.split('/').pop() || 'input.csv';
                    const destPath = `${workspaceDir}/${fileName}`;
                    const content = await fileSystemService.readFile(sourcePath);
                    await fileSystemService.writeFile(destPath, content);
                    return destPath;
                }
            };

            // Create JsonGenerator instance
            const jsonGenerator = new JsonGenerator(this.endpointManager);

            // DEPRECATED: TransactionCreator removed in Phase 9.4 cleanup
            // console.log('[Dobermann] Creating notDataLoadingOrchestrator with injected services');
            // console.log('[Dobermann] JsonGenerator created and will be injected');
            return new DataLoadingOrchestrator(
                timeEstimationService,
                batchProgressService,
                executionMetadataService,
                batchFileManager,
                jsonGenerator
            );
        } catch (error) {
            this.logger.error('[Dobermann] Failed to create DataLoadingOrchestrator with services:', error instanceof Error ? error : new Error(String(error)));
            // console.log('[Dobermann] Falling back to DataLoadingOrchestrator without services');
            return new DataLoadingOrchestrator();
        }
    }
}

/**
 * Always-log the folder→tags migration summary so users can tell at a glance
 * whether it ran, was skipped, or just had nothing to migrate. The original
 * "only log on touches" rule made successful-but-noop runs invisible.
 */
export function logFolderToTagsSummary(out: vscode.OutputChannel, summary: FolderToTagsSummary): void {
    if (!summary.ran) {
        out.appendLine(`[Tags] Migration skipped — ${summary.reason || 'unknown reason'}.`);
        return;
    }
    if (summary.reason === 'no-data') {
        out.appendLine('[Tags] Migration ran but the endpoint collection is empty.');
        return;
    }
    const sample = summary.sampleFolders.length > 0
        ? ` Sample folders: ${summary.sampleFolders.map(s => `"${s}"`).join(', ')}.`
        : '';
    out.appendLine(
        `[Tags] Migration ran. Endpoints total: ${summary.endpointsTotal}, ` +
        `with non-empty folder: ${summary.endpointsWithFolder}, ` +
        `touched: ${summary.endpointsTouched} (${summary.tagsAdded} tag(s) added).${sample}`
    );
    if (summary.endpointsWithFolder === 0) {
        out.appendLine(
            '[Tags] No endpoints carried a folder value — nothing to migrate. ' +
            'If you expected legacy folder data, it may have been cleared during the System migration. ' +
            'Use the endpoint editor Tags field to add tags manually.'
        );
    } else if (summary.endpointsTouched === 0 && summary.endpointsWithFolder > 0) {
        out.appendLine(
            '[Tags] All folder values were already present as tags — nothing new to add.'
        );
    }
}