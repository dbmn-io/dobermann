// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run API and batch runs: what happens between a Run click and the engine (#343). Moved from
 * ExecutionCommands so VS Code and the web app run the same path: the environment and its
 * production guard, ENV variables, the values form, headers, sign-in, then the transaction
 * and the engine. Hosts supply RunOrchestratorDeps; VS Code's ExecutionCommands builds them
 * from its container.
 */
import { ExecutionLinkInput } from '../chain/chain-types';
import { APIEndpointConfig } from '../../apiConfigManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { APIEndpointManager } from '../../apiEndpointManager';
import { PerformanceMonitorService } from '../monitoring/performance-monitor.service';
import { ColumnMapping } from '../../data-loading/types';
import { ExecutionErrorHandlerService } from '../error-handling/execution-error-handler.service';
import { ensureHeaderVariables } from '../environment/header-variable-check';
import { headerVariableNames, VariableBearer } from '../environment/variable-options';
import { ExecutionHeaderPreparationService, IExecutionHeaderPreparationService } from '../headers/execution-header-preparation.service';
import { IParameterCollectionService } from '../parameter/parameter-collection.interface';
import { ParameterCollectionService } from '../parameter/parameter-collection.service';
import { IVariableResolutionService } from '../variable/variable-resolution.interface';
import { VariableResolutionService } from '../variable/variable-resolution.service';
import { extractVariablesFromJsonTemplate } from '../../data-loading/json-template-parser';
import { IDbmnTelemetry } from '../dbmn-auth/dbmn-auth.interface';
import { RunCancelledError } from '../../errors/run-cancelled-error';
import { BulkLoadResult, bulkLoadFailure } from '../../webviews/run-batch/bulk-load-result';
import { PaginationDetectorService } from '../pagination/pagination-detector.service';
import type { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import type { ITransactionPreparationService } from '../transaction-preparation/transaction-preparation.interface';
import type { ModalHost } from '../../screens/modal.types';
import { substituteEnvDeep, substituteEnvVariables } from '../environment/env-template';
import { unresolvedVariables } from './unresolved-variables';
import { fillBaseUrl } from '../../utils/environment-url';

/** #424: an environment's base URL with its variables filled; undefined without one. */
function filledBaseUrlOf(environment: { baseUrl?: string; variables?: Record<string, string> } | undefined): string | undefined {
    return environment?.baseUrl ? fillBaseUrl(environment.baseUrl, environment.variables) : undefined;
}

/** The preparation service and the batch engine (VS Code: its ServiceBootstrap). */
export interface RunPipeline {
    getTransactionPreparationService(): ITransactionPreparationService | undefined | null;
    getBatchExecutionEngine(): { executeRecord(executionId: string): Promise<unknown>; updateBatchErrorMode(batchId: string, config: { stopOnFirstError: boolean }): Promise<void> } | undefined | null;
}

/** What Run Batch's Execute sends. */
export interface BulkLoadRequest {
    endpointId: string;
    jsonData: Array<Record<string, unknown>>;
    mappings: Array<{ variable: string; column: string | null }>;
    batchName?: string;
    parallelProcessing?: { enabled: boolean; maxConcurrency: number };
    repeatableQueryParam?: { enabled: boolean; paramKey: string; pattern: string; separator: string; maxUrlLength: number; maxPerRequest?: number | null };
    totalTransactions?: number | null;
    nestingLevel?: number | null;
    chainedFrom?: Omit<ExecutionLinkInput, 'targetExecutionId'>;
    /** #470: Error handling chosen in Execute's confirmation: stop at the first failed request (else keep going). */
    stopOnFirstError?: boolean;
    [key: string]: unknown;
}

/** What the commands pass: a catalogue item ({ itemType: 'endpoint', endpoint }) or the endpoint itself. */
type EndpointCommandInput = { itemType?: string; endpoint?: APIEndpointConfig };

export interface RunOrchestratorDeps {
    logger: IExtensionDiagnosticLogger;
    environments: EnvironmentManager;
    endpoints: Pick<APIEndpointManager, 'getEndpoint'>;
    pipeline: RunPipeline;
    /** Runs one prepared individual transaction and opens its Console. */
    individualEngine(): { executeIndividual(executionId: string): Promise<{ duration: number; success?: boolean; httpStatus?: number }> } | undefined;
    /** Where the values form opens (the Hub). */
    modal(): ModalHost | undefined;
    /** Issue #65/#311: the environment's credentials, asked for just in time. False when the user cancelled. */
    ensureAuthenticated(environment: unknown): Promise<boolean>;
    /**
     * Issue #396: whether the environment's own sign-in is usable right now, without asking.
     * Lets a batch that needs the DBMN account as well name both sign-ins at once.
     */
    isEnvironmentSignedIn?(environment: unknown): Promise<boolean>;
    telemetry?(): IDbmnTelemetry | undefined;
    /** The DBMN in-app sign-in, when a run needs a DBMN identity. */
    promptSignIn(): Promise<void>;
    /** GitHub Issue #273: confirm a live run against production. False when cancelled. */
    confirmProduction(environment: unknown, action: string): Promise<boolean>;
    /** The DBMN workspace folder runs write their files under. */
    workspaceRoot(): Promise<string>;
    /** GitHub Issue #247: links between runs. */
    links?(): { addExecutionLink?(link: ExecutionLinkInput): Promise<unknown> } | undefined;
    toast: { error(message: string): void };
}

export class RunOrchestrator {
    protected pipeline: RunPipeline;
    /** The endpoint a bulk load runs (VS Code: APIEndpointManager). */
    private get endpoints() {
        return this.deps.endpoints;
    }
    private performanceMonitor: PerformanceMonitorService;
    private executionErrorHandler: ExecutionErrorHandlerService;
    private headerPreparationService: IExecutionHeaderPreparationService | null = null;
    private parameterCollectionService: IParameterCollectionService;
    private variableResolutionService: IVariableResolutionService;
    private logger: IExtensionDiagnosticLogger;

    constructor(protected readonly deps: RunOrchestratorDeps) {
        this.logger = deps.logger;
        this.pipeline = deps.pipeline;
        this.performanceMonitor = new PerformanceMonitorService(this.logger);
        this.executionErrorHandler = new ExecutionErrorHandlerService(this.logger);
        this.parameterCollectionService = new ParameterCollectionService(this.logger, () => deps.modal());
        // Issue #113 & #126
        this.variableResolutionService = new VariableResolutionService();
        this.initializeHeaderPreparationService();
    }

    /**
     * Initialize header preparation service with service isolation
     * Following Architecture.md patterns - optional services don't break core functionality
     */
    private initializeHeaderPreparationService(): void {
        try {
            this.headerPreparationService = new ExecutionHeaderPreparationService();

            this.logger.debug('[ExecutionCommands] Header preparation service initialized successfully');
        } catch (error) {
            // Graceful degradation - execution continues without auto-headers if service fails
            this.logger.error('[ExecutionCommands] Failed to initialize header preparation service', error instanceof Error ? error : undefined);
            this.headerPreparationService = null;

        }
    }

    /**
     * Prepares endpoint headers by merging environment headers with endpoint headers
     * and substituting variables (Issues #113 and #126)
     * Following Architecture.md service isolation - graceful degradation if service unavailable
     */
    private async prepareEndpointHeaders(
        endpoint: APIEndpointConfig,
        environmentId: string
    ): Promise<{
        enhancedEndpoint: APIEndpointConfig;
        headerMetadata: string
    }> {
        // If header preparation service is not available, return original endpoint
        if (!this.headerPreparationService) {
            return {
                enhancedEndpoint: endpoint,
                headerMetadata: 'Header preparation service unavailable - using original headers'
            };
        }

        try {
            // Get environment config for headers and variables (Issue #126)
            const environmentManager = this.deps.environments;
            const environment = await environmentManager.getEnvironment(environmentId);

            if (!environment) {
                return {
                    enhancedEndpoint: endpoint,
                    headerMetadata: `Environment ${environmentId} not found - using original headers`
                };
            }

            // Build resolved variables from environment.variables (Issue #126)
            const resolvedVariables: Record<string, string> = {};
            if (environment.variables) {
                for (const [key, value] of Object.entries(environment.variables)) {
                    if (typeof value === 'string') {
                        resolvedVariables[key] = value;
                    }
                }
            }
            // Prepare headers using the new method with variable substitution
            // Note: DBMN tokens are injected at execution time via authMethod='dbmn' in dobermann.ts.
            // System variables ({{A8:sequence}}, {{A8:date}}, {{A8:datetime}}) are resolved via data-loading layer.
            const enhancedEndpoint = await this.headerPreparationService.prepareHeadersWithVariables(
                endpoint,
                environment,
                resolvedVariables
            );

            // Build metadata for logging
            const envHeaderCount = environment.headers ? Object.keys(environment.headers).filter(
                k => environment.headers![k].enabled
            ).length : 0;
            const endpointHeaderCount = endpoint.headers ? Object.keys(endpoint.headers).length : 0;
            const useEnvHeaders = endpoint.useEnvironmentHeaders !== false;

            const headerMetadata = `Headers: ${envHeaderCount} env (${useEnvHeaders ? 'enabled' : 'disabled'}), ${endpointHeaderCount} endpoint | Variables: ${Object.keys(resolvedVariables).join(', ') || 'none'}`;

            return {
                enhancedEndpoint,
                headerMetadata
            };

        } catch (error) {
            // Graceful degradation - use original endpoint if header preparation fails
            console.warn('[ExecutionCommands] Header preparation failed, using original headers:', error);

            return {
                enhancedEndpoint: endpoint,
                headerMetadata: `Header preparation failed: ${(error as Error).message}`
            };
        }
    }

    /**
     * Run API Endpoint Command
     * Can be called from tree view, command palette, or webview
     */
    async runApiEndpointCommand(item?: EndpointCommandInput | APIEndpointConfig): Promise<void> {
        // Extract endpoint from different input types (outside try block for error handler access)
        const endpoint = this.extractEndpoint(item);
        if (!endpoint) {
            this.deps.toast.error('No endpoint selected for execution');
            return;
        }

        try {
            // STEP 1: Get active environment and its organization (if set)
            const environmentManager = this.deps.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();

            if (!activeEnvironment) {
                this.deps.toast.error('No active environment. Please select an environment before executing API calls.');
                return;
            }

            // GitHub Issue #273: guard live execution against a production environment.
            // No-op for non-production environments and while a suppression window is active.
            if (!(await this.deps.confirmProduction(activeEnvironment, 'Run API'))) {
                return; // user cancelled the production confirmation
            }

            // #424: every header variable (the org among them) holds one of its options, asked for if not
            if (!(await ensureHeaderVariables(activeEnvironment, environmentManager, { modal: () => this.deps.modal(), toast: this.deps.toast }))) {
                return; // cancelled, or nowhere to ask
            }
            // What the prompt saved is in the stored environment, not in the copy read before it:
            // everything from here on uses this one, or the first run after a pick sends it empty
            const settledEnvironment = (await environmentManager.getActiveEnvironment()) ?? activeEnvironment;

            // Recorded with the run: the `org` variable, if the environment keeps one
            const selectedOrganization = settledEnvironment.variables?.org;

            // GitHub Issue #165: Validate ENV variables are present in environment before execution
            const missingEnvVars = this.validateEnvVariables(endpoint, settledEnvironment.variables || {});
            if (missingEnvVars.length > 0) {
                this.deps.toast.error(
                    `Missing environment variables: ${missingEnvVars.join(', ')}. ` +
                    `Please add these variables to the "${settledEnvironment.name}" environment before executing.`
                );
                return;
            }

            // STEP 2: Get pre-resolved variables from environment and endpoint (Issue #113 & #126)
            const preResolvedVariables: Record<string, string> = {};

            // Add environment variables
            if (settledEnvironment.variables) {
                for (const [key, value] of Object.entries(settledEnvironment.variables)) {
                    preResolvedVariables[key] = String(value);
                }
            }

            // Add endpoint variables (override environment)
            if (endpoint.variables) {
                for (const [key, value] of Object.entries(endpoint.variables)) {
                    preResolvedVariables[key] = String(value);
                }
            }

            this.logger.debug('[ExecutionCommands] Pre-resolved variables from environment/endpoint', undefined, {
                endpointId: endpoint.id,
                preResolvedCount: Object.keys(preResolvedVariables).length,
                preResolvedKeys: Object.keys(preResolvedVariables)
            });

            // STEP 3: Collect parameters for template variables, skipping pre-resolved ones
            let enhancedEndpoint = endpoint;
            const collectionResult = await this.parameterCollectionService.collectParametersWithPreResolved(
                endpoint.body || '',
                endpoint.name,
                preResolvedVariables,
                endpoint.path,
                endpoint.queryParams as Record<string, string>,
                endpoint.headers
            );

            if (collectionResult.cancelled) {
                this.logger.debug('[ExecutionCommands] User cancelled parameter collection');
                return;
            }

            if (collectionResult.error) {
                this.deps.toast.error(`Failed to collect parameters: ${collectionResult.error}`);
                return;
            }

            // GitHub Issue #162: Apply timezone conversion for datetime parameters
            // User enters datetime in system timezone, convert to environment's target timezone
            if (collectionResult.parameters && settledEnvironment.targetTimezone) {
                const targetTimezone = settledEnvironment.targetTimezone;
                const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

                // Only convert if target is different from system timezone
                if (targetTimezone !== systemTimezone && targetTimezone !== 'UTC') {
                    this.applyTimezoneConversionToParameters(collectionResult.parameters, systemTimezone, targetTimezone);
                }
            }

            // Apply variable replacements to URL, query params, and headers
            // GitHub Issue #145: Body is NOT replaced here - it's passed to JsonGenerator with userParameters
            // This ensures Run API uses the SAME code path as Run Batch
            if (collectionResult.parameters && Object.keys(collectionResult.parameters).length > 0) {
                // NOTE: Body is intentionally NOT replaced - JsonGenerator handles it with userParameters
                const updatedPath = endpoint.path ?
                    this.parameterCollectionService.replaceVariablesInUrl(endpoint.path, collectionResult.parameters) :
                    endpoint.path;

                const updatedQueryParams = endpoint.queryParams ?
                    this.parameterCollectionService.replaceVariablesInQueryParams(endpoint.queryParams, collectionResult.parameters) :
                    endpoint.queryParams;

                const updatedHeaders = endpoint.headers ?
                    this.parameterCollectionService.replaceVariablesInHeaders(endpoint.headers, collectionResult.parameters) :
                    endpoint.headers;

                // Create a new endpoint object - body stays as original template
                enhancedEndpoint = {
                    ...endpoint,
                    // body: NOT changed - template with {{}} patterns goes to JsonGenerator
                    path: updatedPath,
                    queryParams: updatedQueryParams,
                    headers: updatedHeaders
                };

                this.logger.debug('[ExecutionCommands] Parameters collected - body passed to JsonGenerator, URL/headers replaced', undefined, {
                    endpointId: endpoint.id,
                    parameterCount: Object.keys(collectionResult.parameters).length,
                    bodyHandledByJsonGenerator: true, // GitHub Issue #145: Body uses same path as Run Batch
                    hasUrlVariables: !!endpoint.path && this.parameterCollectionService.extractVariablesFromUrl(endpoint.path).length > 0,
                    hasQueryParamVariables: !!endpoint.queryParams && this.parameterCollectionService.extractVariablesFromQueryParams(endpoint.queryParams).length > 0,
                    hasHeaderVariables: !!endpoint.headers && this.parameterCollectionService.extractVariablesFromHeaders(endpoint.headers).length > 0
                });
            }

            // {{ENV:name}} in the path, the query parameters and the headers: the environment's
            // values, before the check below (the values form skips them on purpose, so until
            // here they were still templates and a path such as /{{ENV:region}}/orders was refused)
            enhancedEndpoint = {
                ...enhancedEndpoint,
                path: enhancedEndpoint.path ? substituteEnvVariables(enhancedEndpoint.path, settledEnvironment.variables) : enhancedEndpoint.path,
                queryParams: substituteEnvDeep(enhancedEndpoint.queryParams, settledEnvironment.variables),
                headers: substituteEnvDeep(enhancedEndpoint.headers, settledEnvironment.variables)
            };

            // Validate no unresolved template variables remain before execution
            const unresolvedVars = unresolvedVariables(enhancedEndpoint);
            if (unresolvedVars.length > 0) {
                const varList = unresolvedVars.slice(0, 5).join(', ');
                const suffix = unresolvedVars.length > 5 ? ` and ${unresolvedVars.length - 5} more` : '';
                this.deps.toast.error(
                    `Cannot execute API: Unresolved template variables found: ${varList}${suffix}. ` +
                    `Please provide values for these variables or remove them from the endpoint configuration.`
                );
                return;
            }

            this.logger.debug('[ExecutionCommands] Running API endpoint', undefined, {
                endpointId: endpoint.id,
                selectedOrganization
            });

            // GitHub Issue #94: Detect pagination configuration
            const paginationDetectorService = new PaginationDetectorService();
            const paginationConfig = paginationDetectorService.detectPagination(enhancedEndpoint);

            if (paginationConfig.enabled) {
                // Route to paginated execution (creates batch + batch_member)
                this.logger.debug('[ExecutionCommands] Pagination detected, routing to paginated execution', undefined, {
                    endpointId: endpoint.id,
                    paginationConfig
                });

                const { duration } = await this.performanceMonitor.timeOperation(
                    'paginated-execution',
                    () => this.executePaginatedAPI(enhancedEndpoint, selectedOrganization, paginationConfig),
                    { endpointId: endpoint.id }
                );
            } else {
                // Execute using Transaction Preparation + Pure Execution architecture
                // GitHub Issue #145: Pass user parameters so JsonGenerator handles body (same as Run Batch)
                const { duration } = await this.performanceMonitor.timeOperation(
                    'individual-execution',
                    () => this.executeIndividualAPI(enhancedEndpoint, selectedOrganization, collectionResult.parameters || {}),
                    { endpointId: endpoint.id }
                );
            }

        } catch (error) {
            // Process error through error handler
            const executionError = this.executionErrorHandler.processError(
                error instanceof Error ? error : new Error(String(error)),
                {
                    endpointId: endpoint?.id || 'unknown',
                    architecture: 'new',
                    operation: 'individual-api-execution',
                    phase: 'execution'
                }
            );

            // Show user-friendly error message
            this.deps.toast.error(`API execution failed: ${executionError.userMessage}`);

            // Provide suggestions if available
            const suggestions = this.executionErrorHandler.getErrorSuggestions(executionError);
            if (suggestions.length > 0) {
                const suggestionText = suggestions.join('\n• ');
            }

            this.logger.error('[ExecutionCommands] API execution error', undefined, this.executionErrorHandler.formatErrorForLogging(executionError));
        }
    }

    /**
     * Execute individual API endpoint
     * Creates transaction files and executes the API call once
     * GitHub Issue #145: userParameters passed to JsonGenerator for unified processing (same as Run Batch)
     */
    private async executeIndividualAPI(
        endpoint: APIEndpointConfig,
        selectedOrganization: string | undefined,
        userParameters: Record<string, any>
    ): Promise<void> {
        // Get Dobermann workspace
        const workspaceRoot = await this.deps.workspaceRoot();

        // Use Transaction Preparation + Pure Execution architecture
        const transactionService = this.pipeline.getTransactionPreparationService();
        if (!transactionService) {
            throw new Error('Transaction preparation service not available');
        }

        // Get current environment from environment manager
        const environmentManager = this.deps.environments;
        const activeEnvironment = await environmentManager.getActiveEnvironment();
        const environmentName = activeEnvironment?.name || 'default';
        const environmentFolder = activeEnvironment?.folder; // Optional folder from environment config

        // Step 0: Prepare headers: the environment's and the endpoint's, variables filled in
        const { enhancedEndpoint, headerMetadata } = await this.prepareEndpointHeaders(
            endpoint,
            activeEnvironment?.id || 'unknown'
        );

        this.logger.debug('[ExecutionCommands] Header preparation result', undefined, {
            endpointId: endpoint.id,
            headerMetadata,
            originalHeaderCount: Object.keys(endpoint.headers || {}).length,
            enhancedHeaderCount: Object.keys(enhancedEndpoint.headers || {}).length
        });

        // Check authentication before creating transaction (GitHub Issue #65)
        const shouldContinue = await this.checkAndPromptAuthentication(activeEnvironment);
        if (!shouldContinue) {
            this.logger.debug('[ExecutionCommands] Authentication check cancelled by user');
            return; // User cancelled authentication or execution
        }

        // #418: no DBMN account is needed to run. Telemetry counts a run only for a signed-in
        // account (telemetry-payload.ts); signed out, nothing is sent and nothing is asked for.

        // Step 1: Prepare transaction using TransactionPreparationService
        // GitHub Issue #145: Pass userParameters so JsonGenerator handles body (same as Run Batch)
        const preparationResult = await transactionService.prepareIndividualTransaction({
            endpoint: enhancedEndpoint,
            environment: environmentName,
            environmentId: activeEnvironment?.id,   // the Console looks the environment up by this (its base URL)
            environmentFolder,
            organization: selectedOrganization, // the `org` variable, recorded with the run
            workspaceRoot,
            userParameters, // GitHub Issue #145: Pass to JsonGenerator for unified processing
            // #298: the header variables' values (org 880), kept with the run: Compare tells runs apart by them
            environmentVariables: activeEnvironment ? headerValuesOfEnvironment(activeEnvironment) : undefined
        });

        // Step 2: Execute using IndividualExecutionEngine (with status updates and report auto-opening)

        const individualExecutionEngine = this.deps.individualEngine();
        if (!individualExecutionEngine) {
            throw new Error('IndividualExecutionEngine not available');
        }

        if (!preparationResult.executionId) {
            throw new Error('Transaction preparation returned no execution id');
        }
        const result = await individualExecutionEngine.executeIndividual(preparationResult.executionId);

        // Record telemetry (GitHub Issue #211) — individual calls are unlimited, no usage recording
        const telemetry = this.deps.telemetry?.();
        if (telemetry) {
            telemetry.recordApiCall();
            telemetry.recordExecutionTime(result.duration);
        }

        // Error is already handled by the execution engine (status update + console report)
        // No throw needed - avoids redundant VS Code error popup
    }

    /**
     * Execute paginated API endpoint (GitHub Issue #94)
     * Creates a batch with pagination metadata and one batch_member for the first page
     * Opens report immediately with "Next Page" button
     */
    private async executePaginatedAPI(
        endpoint: APIEndpointConfig,
        selectedOrganization: string | undefined,
        paginationConfig: any
    ): Promise<void> {
        this.logger.debug('[ExecutionCommands] Starting paginated API execution', undefined, {
            endpointId: endpoint.id,
            paginationConfig
        });

        // Get Dobermann workspace
        const workspaceRoot = await this.deps.workspaceRoot();

        // Use Transaction Preparation service to create paginated batch
        const transactionService = this.pipeline.getTransactionPreparationService();
        if (!transactionService) {
            throw new Error('Transaction preparation service not available');
        }

        // Get current environment from environment manager
        const environmentManager = this.deps.environments;
        const activeEnvironment = await environmentManager.getActiveEnvironment();
        const environmentName = activeEnvironment?.name || 'default';
        const environmentFolder = activeEnvironment?.folder;

        // Prepare headers: the environment's and the endpoint's, variables filled in
        const { enhancedEndpoint, headerMetadata } = await this.prepareEndpointHeaders(
            endpoint,
            activeEnvironment?.id || 'unknown'
        );

        this.logger.debug('[ExecutionCommands] Paginated execution header preparation result', undefined, {
            endpointId: endpoint.id,
            headerMetadata
        });

        // Check authentication before creating transaction
        const shouldContinue = await this.checkAndPromptAuthentication(activeEnvironment);
        if (!shouldContinue) {
            this.logger.debug('[ExecutionCommands] Authentication check cancelled by user');
            return;
        }

        // Paginated first page is just an individual call — no DBMN gate check needed
        // Pagination limits enforced at "Fetch Next Page" / "Fetch All" in console

        // GitHub Issue #94: Prepare paginated batch with ORIGINAL endpoint (template intact)
        // The transaction preparation service will handle replacing the template for the first batch_member
        const preparationResult = await transactionService.preparePaginatedBatch({
            endpoint: enhancedEndpoint, // Store original endpoint with {{A8:PAGE:}} template
            environment: environmentName,
            // Without the id the batch cannot be tied back to an environment, and its
            // telemetry (every page is an API call) was silently dropped on completion.
            environmentId: activeEnvironment?.id,
            environmentFolder,
            organization: selectedOrganization,
            workspaceRoot,
            paginationConfig, // Used to create first batch_member with replaced template
            baseUrl: filledBaseUrlOf(activeEnvironment) // #424/#160: fixed for every page
        });

        this.logger.debug('[ExecutionCommands] Paginated batch prepared', undefined, {
            batchId: preparationResult.batchId,
            firstPageNumber: paginationConfig.startValue
        });

        // Execute first page using BatchExecutionEngine
        const batchExecutionEngine = this.pipeline.getBatchExecutionEngine();
        if (!batchExecutionEngine) {
            throw new Error('BatchExecutionEngine not available');
        }

        if (!preparationResult.batchId) throw new Error('Transaction preparation returned no batch id');
        const paginatedBatchState = await batchExecutionEngine.executeRecord(preparationResult.batchId);

        // Telemetry (API calls, execution time) is recorded inside BatchExecutionEngine on completion

        this.logger.info('[ExecutionCommands] Paginated execution complete - first page executed', undefined, {
            batchId: preparationResult.batchId,
            endpointId: endpoint.id
        });
    }

    // REMOVED: executeWithOldArchitecture - Legacy architecture deprecated in favor of new Transaction Preparation + Pure Execution pattern

    /**
     * Execute batch with CSV data using new architecture (for webview integration)
     * Creates batch and executes immediately - currently used by bulk load functionality
     * GitHub Issue #48: Accept column mappings from CSV upload Step 3
     * GitHub Issue #108: Accept repeatableQueryParam for query param repetition
     * GitHub Issue #150: Accept preCalculatedTransactions for single source of truth
     */
    public async executeBatchWithCsvData(
        endpoint: APIEndpointConfig,
        csvData: string[][],
        columnMappings?: ColumnMapping[],
        batchName?: string,
        parallelProcessing?: { enabled: boolean; maxConcurrency: number },
        repeatableQueryParam?: { enabled: boolean; paramKey: string; pattern: string; separator: string; maxUrlLength: number; maxPerRequest?: number },
        preCalculatedTransactions?: { totalTransactions: number | null; nestingLevel: number | null },
        chainedFrom?: Omit<ExecutionLinkInput, 'targetExecutionId'>,
        runOptions?: { stopOnFirstError?: boolean }
    ): Promise<void> {
        const environmentManager = this.deps.environments;
        const activeEnvironment = await environmentManager.getActiveEnvironment();

        if (!activeEnvironment) {
            throw new Error('No active environment. Please select an environment before batch execution.');
        }

        // Recorded with the run: the `org` variable, if the environment keeps one
        const selectedOrganization = activeEnvironment.variables?.org;
        // Create progress notification for the entire batch process (preparation + execution)
        // Preparation phase - no progress bar shown (dedicated prep progress handles this)
        await this.doExecuteBatchWithCsvData(endpoint, csvData, columnMappings, selectedOrganization, batchName, parallelProcessing, repeatableQueryParam, preCalculatedTransactions, chainedFrom, runOptions);
    }

    /**
     * Internal method to execute batch with CSV data (no progress during preparation)
     * GitHub Issue #48: Accept column mappings from CSV upload Step 3
     * GitHub Issue #108: Accept repeatableQueryParam for query param repetition
     * GitHub Issue #150: Accept preCalculatedTransactions for single source of truth
     */
    private async doExecuteBatchWithCsvData(
        endpoint: APIEndpointConfig,
        csvData: string[][],
        columnMappings: ColumnMapping[] | undefined,
        selectedOrganization: string | undefined,
        batchName?: string,
        parallelProcessing?: { enabled: boolean; maxConcurrency: number },
        repeatableQueryParam?: { enabled: boolean; paramKey: string; pattern: string; separator: string; maxUrlLength: number; maxPerRequest?: number },
        preCalculatedTransactions?: { totalTransactions: number | null; nestingLevel: number | null },
        chainedFrom?: Omit<ExecutionLinkInput, 'targetExecutionId'>,
        runOptions?: { stopOnFirstError?: boolean }
    ): Promise<void> {
        try {
            // Get Dobermann workspace
            const workspaceRoot = await this.deps.workspaceRoot();

            // Step 1: Prepare batch transactions (uses dedicated preparation progress bar)
            const transactionService = this.pipeline.getTransactionPreparationService();
            if (!transactionService) {
                throw new Error('Transaction preparation service not available');
            }

            // Get current environment from environment manager
            const environmentManager = this.deps.environments;
            const activeEnvironment = await environmentManager.getActiveEnvironment();
            const environmentName = activeEnvironment?.name || 'default';
            const environmentFolder = activeEnvironment?.folder;

            // {{ENV:name}} the environment lacks: refused before anything is made or sent, as
            // Run API refuses it. Before, the batch sent the template as typed (every request a
            // 404 at …/{{ENV:version}}/…). Only ENV names: the path and query of a batch may
            // hold {{column}} templates, which each row fills.
            const missingEnvVars = this.validateEnvVariables(endpoint, activeEnvironment?.variables || {});
            if (missingEnvVars.length > 0) {
                throw new Error(
                    `Missing environment variables: ${missingEnvVars.join(', ')}. ` +
                    `Add them to the "${environmentName}" environment, then run again.`
                );
            }

            // Step 0: Prepare headers: the environment's and the endpoint's, variables filled in
            const { enhancedEndpoint: preparedEndpoint, headerMetadata } = await this.prepareEndpointHeaders(
                endpoint,
                activeEnvironment?.id || 'unknown'
            );
            // {{ENV:name}} in the path, the query parameters and the headers: the environment's
            // values, the same for every member (the body's are the JSON generator's). Nothing
            // later fills the path, so without this a batch sent the template as typed.
            const enhancedEndpoint: APIEndpointConfig = {
                ...preparedEndpoint,
                path: preparedEndpoint.path ? substituteEnvVariables(preparedEndpoint.path, activeEnvironment?.variables) : preparedEndpoint.path,
                queryParams: substituteEnvDeep(preparedEndpoint.queryParams, activeEnvironment?.variables),
                headers: substituteEnvDeep(preparedEndpoint.headers, activeEnvironment?.variables)
            };

            this.logger.debug('[ExecutionCommands] Batch header preparation result', undefined, {
                endpointId: endpoint.id,
                headerMetadata,
                csvRowCount: csvData.length,
                originalHeaderCount: Object.keys(endpoint.headers || {}).length,
                enhancedHeaderCount: Object.keys(enhancedEndpoint.headers || {}).length
            });

            // Check authentication before creating batch transactions (GitHub Issue #65)
            const shouldContinue = await this.checkAndPromptAuthentication(activeEnvironment);
            if (!shouldContinue) {
                this.logger.debug('[ExecutionCommands] Authentication check cancelled by user for batch execution');
                // Not a failure: the user closed the prompt or is signing in. Run Batch
                // gives Execute back without an error.
                throw new RunCancelledError('Sign-in was not completed');
            }

            // GitHub Issue #48: Convert ColumnMapping[] to Record<string, string> format
            let columnMappingRecord: Record<string, string> | undefined;
            if (columnMappings && columnMappings.length > 0) {
                columnMappingRecord = {};
                for (const mapping of columnMappings) {
                    // Only include mappings that have a valid CSV column
                    if (mapping.csvColumn && mapping.mappingType === 'csvColumn') {
                        columnMappingRecord[mapping.templateVariable] = mapping.csvColumn;
                    }
                }
            }

            // Preparation phase (status = "preparing") - uses dedicated progress bar
            // GitHub Issue #108: Pass repeatableQueryParam config to transaction preparation
            // GitHub Issue #150: Pass preCalculatedTransactions for single source of truth
            // GitHub Issue #165: Pass environment variables for {{ENV:varName}} template substitution
            const preparationResult = await transactionService.prepareBatchTransactions({
                endpoint: enhancedEndpoint,
                environment: environmentName,
                environmentId: activeEnvironment?.id,
                environmentFolder,
                organization: selectedOrganization, // the `org` variable, recorded with the run
                workspaceRoot,
                csvData,
                columnMappings: columnMappingRecord, // GitHub Issue #48: Pass user's Step 3 column mappings
                batchConfig: {
                    rowsPerTransaction: this.getArrayRepetitionConfig(endpoint),
                    parallelProcessing: parallelProcessing,
                    repeatableQueryParam: repeatableQueryParam // GitHub Issue #108: Query param repetition config
                },
                batchName, // Pass batch name for custom CSV filename
                preCalculatedTransactions: preCalculatedTransactions?.totalTransactions || undefined, // GitHub Issue #150
                environmentVariables: activeEnvironment?.variables, // GitHub Issue #165: ENV variable substitution
                baseUrl: filledBaseUrlOf(activeEnvironment) // #424/#160: fixed for the whole batch
            });

            // GitHub Issue #247: the batch exists now — link it to the run its rows came from,
            // before it runs, so its Console shows the link from the start.
            if (chainedFrom?.sourceExecutionId && preparationResult.batchId) {
                await this.recordChainLink({ ...chainedFrom, targetExecutionId: preparationResult.batchId });
            }

            // Step 2: Execute batch (status = "running") - will use execution progress bar
            const batchExecutionEngine = this.pipeline.getBatchExecutionEngine();
            if (!batchExecutionEngine) {
                throw new Error('BatchExecutionEngine not available');
            }

            // Execution phase - BatchExecutionEngine will create its own progress bar
            if (!preparationResult.batchId) throw new Error('Transaction preparation returned no batch id');
            // #470: Error handling as chosen in Execute's confirmation, set before the first request goes, either way. Without
            // a choice (today's Review) the batch keeps what it was created with: the endpoint's saved mode
            // (transaction-creator: dataLoadingConfig.errorHandling.mode 'stopOnFirst')
            if (typeof runOptions?.stopOnFirstError === 'boolean') await batchExecutionEngine.updateBatchErrorMode(preparationResult.batchId, { stopOnFirstError: runOptions.stopOnFirstError });
            const batchState = await batchExecutionEngine.executeRecord(preparationResult.batchId);

            // Telemetry (batch runs, API calls, execution time) is now recorded
            // inside BatchExecutionEngine on completion — covers both normal batches
            // and pagination page batches in a single place.

        } catch (error) {
            console.error('❌ [ExecutionCommands] Batch CSV data execution failed:', error);
            throw error; // Re-throw for webview error handling
        }
    }

    /**
     * Run Batch's Execute: its rows (objects keyed by column) and mappings, run as a batch.
     * Moved from the `dbmn.internal.executeBulkLoad` command. Failures come back as a
     * BulkLoadResult for Run Batch to show: it keeps why the batch did not start,
     * and whether the user simply stopped at a prompt (GitHub Issue #396).
     */
    async executeBulkLoad(request: BulkLoadRequest): Promise<BulkLoadResult> {
        try {
            const { endpointId, jsonData, mappings, batchName, parallelProcessing, repeatableQueryParam, totalTransactions, nestingLevel, chainedFrom, stopOnFirstError } = request;
            if (!endpointId || !Array.isArray(jsonData) || jsonData.length === 0) {
                throw new Error('Invalid bulk load data provided');
            }
            const endpoint = await this.endpoints.getEndpoint(endpointId);
            if (!endpoint) {
                throw new Error(`Endpoint not found: ${endpointId}`);
            }
            // executeBatchWithCsvData takes rows with the headers first
            const headers = Object.keys(jsonData[0]);
            const csvArray = [headers, ...jsonData.map(row => headers.map(header => String(row[header] || '')))];
            const columnMappings = (mappings || [])
                .filter(m => m.column && m.column.trim() !== '')
                .map(m => ({ templateVariable: m.variable, csvColumn: m.column as string, mappingType: 'csvColumn' as const, dataType: 'string' as const }));
            const queryParam = repeatableQueryParam ? { ...repeatableQueryParam, maxPerRequest: repeatableQueryParam.maxPerRequest ?? undefined } : undefined;
            await this.executeBatchWithCsvData(endpoint, csvArray, columnMappings as ColumnMapping[], batchName, parallelProcessing, queryParam,
                { totalTransactions: totalTransactions ?? null, nestingLevel: nestingLevel ?? null }, chainedFrom, typeof stopOnFirstError === 'boolean' ? { stopOnFirstError } : undefined);
            return { success: true, message: 'Bulk execution started successfully' };
        } catch (error) {
            console.error('❌ Bulk load execution failed:', error);
            return bulkLoadFailure(error);
        }
    }

    /** GitHub Issue #247: a failed link must never stop the batch it describes. */
    private async recordChainLink(link: ExecutionLinkInput): Promise<void> {
        try {
            const store = this.deps.links?.();
            if (store && typeof store.addExecutionLink === 'function') {
                await store.addExecutionLink(link);
            }
        } catch (error) {
            this.logger.warn('[ExecutionCommands] Could not record the chain link', undefined, {
                source: link.sourceExecutionId, target: link.targetExecutionId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Extract array repetition configuration from endpoint
     * Returns maxRepetitions if array repetition is enabled, otherwise undefined
     */
    private getArrayRepetitionConfig(endpoint: APIEndpointConfig): number | undefined {
        const repeatableArrays = endpoint.dataLoadingConfig?.repeatableArrays;

        if (!repeatableArrays || repeatableArrays.length === 0) {
            return undefined;
        }

        const enabledArrays = repeatableArrays.filter(arr => arr.enabled);
        if (enabledArrays.length === 0) {
            return undefined;
        }

        // Use minimum maxRepetitions for most conservative grouping
        return Math.min(...enabledArrays.map(arr => arr.maxRepetitions));
    }

    // REMOVED: executeBatchWithOldArchitecture - Legacy architecture deprecated in favor of new Transaction Preparation + Pure Execution pattern

    /**
     * Extract endpoint configuration from various input types
     */
    private extractEndpoint(item?: EndpointCommandInput | APIEndpointConfig): APIEndpointConfig | null {
        if (!item) {
            return null;
        }

        // Handle tree item
        if ('itemType' in item && item.itemType === 'endpoint') {
            return item.endpoint || null;
        }

        // Handle direct endpoint config
        if ('id' in item && 'name' in item && 'path' in item) {
            return item as APIEndpointConfig;
        }

        return null;
    }

    /**
     * GitHub Issue #165: Validate that all ENV variables in the endpoint are present in the environment
     * @param endpoint - The endpoint configuration
     * @param environmentVariables - The environment variables from the active environment
     * @returns Array of missing ENV variable names (empty if all are present)
     */
    private validateEnvVariables(endpoint: APIEndpointConfig, environmentVariables: Record<string, string>): string[] {
        const missingVars: string[] = [];
        const envVarNames = new Set<string>();

        // Extract ENV variables from body template
        if (endpoint.body) {
            const bodyStr = typeof endpoint.body === 'string' ? endpoint.body : JSON.stringify(endpoint.body);
            const jsonResult = extractVariablesFromJsonTemplate(bodyStr);
            for (const v of jsonResult.variables) {
                if (v.isEnvVariable && v.envVariableName) {
                    envVarNames.add(v.envVariableName);
                }
            }
        }

        // Extract ENV variables from path, headers, queryParams using regex
        const envRegex = /\{\{ENV:([^}:]+)\}\}/gi;
        const sources = [
            endpoint.path || '',
            JSON.stringify(endpoint.headers || {}),
            JSON.stringify(endpoint.queryParams || {})
        ];

        for (const source of sources) {
            let match;
            while ((match = envRegex.exec(source)) !== null) {
                envVarNames.add(match[1].trim());
            }
        }

        // Check which ENV variables are missing from environment
        for (const varName of envVarNames) {
            if (!(varName in environmentVariables)) {
                missingVars.push(varName);
            }
        }

        return missingVars;
    }

    /**
     * Check authentication status and prompt user if token is expired
     * GitHub Issue #65: Just-in-time authentication with three-option modal.
     * Issue #311: the check itself lives in EnvironmentAuthGateService so
     * Resume and Reprocess go through the same gate as a fresh Run.
     */
    private async checkAndPromptAuthentication(environment: any): Promise<boolean> {
        return this.deps.ensureAuthenticated(environment);
    }

    /**
     * GitHub Issue #162: Apply timezone conversion to datetime parameters
     * Converts datetime values from source timezone to target timezone
     *
     * @param parameters - The collected parameters (modified in place)
     * @param sourceTimezone - The source timezone (typically system timezone)
     * @param targetTimezone - The target timezone (from environment settings)
     */
    private applyTimezoneConversionToParameters(
        parameters: Record<string, any>,
        sourceTimezone: string,
        targetTimezone: string
    ): void {
        // Datetime pattern: YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD HH:mm:ss
        const datetimePattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

        for (const [key, value] of Object.entries(parameters)) {
            if (typeof value !== 'string') continue;
            if (!datetimePattern.test(value)) continue;

            try {
                // Parse the datetime as if it's in the source timezone
                const [datePart, timePart] = value.includes('T') ? value.split('T') : value.split(' ');
                const [year, month, day] = datePart.split('-').map(Number);
                const timeParts = timePart.split(':').map(Number);
                const [hours, minutes, seconds = 0] = timeParts;

                // Create a date object interpreting the time as source timezone
                // We need to calculate the offset between source and target timezones
                const testDate = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));

                const sourceFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: sourceTimezone,
                    hour: 'numeric',
                    hour12: false
                });
                const targetFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: targetTimezone,
                    hour: 'numeric',
                    hour12: false
                });

                const sourceHour = parseInt(sourceFormatter.format(testDate));
                const targetHour = parseInt(targetFormatter.format(testDate));

                // Calculate offset: if source shows 23 and target shows 12, offset is 11 hours
                // To convert from source to target, we need to adjust by (target - source)
                let offsetHours = targetHour - sourceHour;
                if (offsetHours > 12) offsetHours -= 24;
                if (offsetHours < -12) offsetHours += 24;

                // Apply offset to get target timezone time
                const adjustedDate = new Date(Date.UTC(
                    year, month - 1, day,
                    hours + offsetHours, minutes, seconds
                ));

                // Format the result
                const convertedValue = `${adjustedDate.getUTCFullYear()}-${String(adjustedDate.getUTCMonth() + 1).padStart(2, '0')}-${String(adjustedDate.getUTCDate()).padStart(2, '0')}T${String(adjustedDate.getUTCHours()).padStart(2, '0')}:${String(adjustedDate.getUTCMinutes()).padStart(2, '0')}:${String(adjustedDate.getUTCSeconds()).padStart(2, '0')}`;

                parameters[key] = convertedValue;

                this.logger.debug('[ExecutionCommands] Converted datetime parameter timezone', undefined, {
                    parameter: key,
                    original: value,
                    converted: convertedValue,
                    sourceTimezone,
                    targetTimezone
                });
            } catch (error) {
                // If conversion fails, keep original value
                this.logger.warn('[ExecutionCommands] Failed to convert datetime timezone', undefined, {
                    parameter: key,
                    value,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }


}

/** #298: the environment's header variables and their values now (none: undefined). */
function headerValuesOfEnvironment(environment: VariableBearer): Record<string, string> | undefined {
    const values: Record<string, string> = {};
    for (const name of headerVariableNames(environment)) {
        const value = environment.variables?.[name];
        if (value) values[name] = value;
    }
    return Object.keys(values).length ? values : undefined;
}
