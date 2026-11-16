// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service Bootstrap
 * 
 * Handles service registration for the Dobermann extension.
 * Uses the new architecture by default.
 */

import type { IDbmnAuthService, IDbmnTelemetry } from '../services/dbmn-auth/dbmn-auth.interface';
import type { IToastService } from '../services/notifications/toast.interface';
import { IServiceContainer, ServiceTokens } from './service-container.interface';
import { CoreServiceTokens } from './core-services-registry';
import { ITransactionCreator } from '../services/transaction-creator/transaction-creator.interface';
import { IExecutionMetadataService } from '../services/execution/execution-metadata.interface';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { IExecutionLoggingService } from '../services/logging/execution-logging.interface';

/**
 * Bootstrap services for the Dobermann extension
 */
export class ServiceBootstrap {
    private container: IServiceContainer;

    constructor(
        container: IServiceContainer,
        private readonly logger: IExtensionDiagnosticLogger
    ) {
        this.container = container;
    }

    /**
     * Register execution services using new architecture
     */
    async registerExecutionServices(): Promise<void> {
        // Register all services - new architecture is now the default
        await this.registerOldArchitectureServices();
        await this.registerNewArchitectureServices();
        
        this.logger.debug('[ServiceBootstrap] Service registration complete - using new architecture');
    }

    /**
     * Register old architecture services (always available for fallback)
     */
    private async registerOldArchitectureServices(): Promise<void> {
        // These services are already registered elsewhere - we just ensure they exist
        // The actual registration happens in the main service setup

        this.logger.debug('[ServiceBootstrap] Old architecture services available for fallback');
    }

    /**
     * Register new architecture services (now the default)
     */
    private async registerNewArchitectureServices(): Promise<void> {
        // Register all new architecture services
        await this.registerTransactionPreparationService();
        
        // Always register the ExecutionService (pure executor)
        await this.registerExecutionService();

        // Always register ResponseTestingService for API response testing
        await this.registerResponseTestingService();

        // Register execution engines first to avoid circular dependencies
        await this.registerBatchExecutionEngine();
        await this.registerIndividualExecutionEngine();
        await this.registerExecutionCoordinator();

        this.logger.debug('[ServiceBootstrap] New architecture services registered');
    }

    /**
     * Register TransactionPreparationService with dependencies
     */
    private async registerTransactionPreparationService(): Promise<void> {
        // Lazy imports to avoid loading unless needed
        const { TransactionPreparationService } = await import('../services/transaction-preparation/transaction-preparation.service');
        const { IndividualTransactionHandler } = await import('../services/transaction-preparation/handlers/individual-transaction.handler');
        const { BatchTransactionHandler } = await import('../services/transaction-preparation/handlers/batch-transaction.handler');
        const { BatchMemberTransactionHandler } = await import('../services/transaction-preparation/handlers/batch-member-transaction.handler');
        const { ArrayRepetitionHelper } = await import('../services/transaction-preparation/helpers/array-repetition.helper');
        const { VsCodeConsoleProgressSink } = await import('../platform/vscode/vscode-console-progress-sink');

        this.container.registerFactory(ServiceTokens.TransactionPreparationService, (container) => {
            // Get shared dependencies
                        const transactionCreator = container.resolve(CoreServiceTokens.TransactionCreator) as ITransactionCreator;
            const executionMetadataService = container.resolve(ServiceTokens.ExecutionMetadataService) as IExecutionMetadataService;
            const executionLoggingService = container.resolve(CoreServiceTokens.ExecutionLoggingService) as IExecutionLoggingService;

            // Import additional helper classes
            const { PathGeneratorHelper } = require('../services/transaction-preparation/helpers/path-generator.helper');
            const { JsonGenerator } = require('../data-loading/json-generator');
            const { TemplateParser } = require('../data-loading/template-parser');

            // Get endpoint manager for JsonGenerator
            const endpointManager = container.resolve(ServiceTokens.EndpointManager);

            // Create shared helpers
            const pathGenerator = new PathGeneratorHelper();
            const jsonGenerator = new JsonGenerator(endpointManager);
            const templateParser = new TemplateParser();

            // Create handlers with proper dependencies
            const individualHandler = new IndividualTransactionHandler(
                transactionCreator,
                pathGenerator,
                jsonGenerator
            );

            const batchHandler = new BatchTransactionHandler(
                transactionCreator,
                pathGenerator
            );

            const batchMemberHandler = new BatchMemberTransactionHandler(
                transactionCreator,
                pathGenerator,
                templateParser,
                jsonGenerator
            );

            const arrayRepetitionHelper = new ArrayRepetitionHelper();

            return new TransactionPreparationService({
                individualHandler,
                batchHandler,
                batchMemberHandler,
                arrayRepetitionHelper,
                executionMetadataService,
                executionLoggingService,
                transactionCreator, // GitHub Issue #94: For chunked just-in-time preparation
                jsonGenerator, // GitHub Issue #119: For unified nested array handling
                progressSink: new VsCodeConsoleProgressSink() // Issue #320: Console updates
            }, this.logger);
        });

        this.logger.debug('[ServiceBootstrap] TransactionPreparationService registered');
    }

    /**
     * Register ExecutionService (Pure Executor) - NEW ARCHITECTURE
     */
    private async registerExecutionService(): Promise<void> {
        // Lazy import to avoid loading unless needed
        const { ExecutionService } = await import('../services/execution/execution.service');
        const { VsCodeConsoleProgressSink } = await import('../platform/vscode/vscode-console-progress-sink');

        this.container.registerFactory(ServiceTokens.ExecutionService, (container) => {
            // Pure ExecutionService - only executes, doesn't create
            const dependencies = {
                ...this.createExecutionServiceDependencies(container),
                progressSink: new VsCodeConsoleProgressSink() // Issue #115: "Receiving…" in the Console
            };
            return new ExecutionService(dependencies, this.logger);
        });

        this.logger.debug('[ServiceBootstrap] ExecutionService registered');
    }

    /**
     * Register ResponseTestingService for API response testing
     */
    private async registerResponseTestingService(): Promise<void> {
        // Lazy import to avoid loading unless needed
        const { ResponseTestingService } = await import('../services/testing/response-testing.service');

        this.container.registerFactory(ServiceTokens.ResponseTestingService, (container) => {
            return new ResponseTestingService(this.logger);
        });

        this.logger.debug('[ServiceBootstrap] ResponseTestingService registered');
    }

    /**
     * Register ExecutionCoordinator with dependencies
     */
    private async registerExecutionCoordinator(): Promise<void> {
        // Lazy import to avoid loading unless needed
        const { ExecutionCoordinator } = await import('../services/execution/execution-coordinator.service');

        this.container.registerFactory(ServiceTokens.ExecutionCoordinator, (container) => {
            const executionMetadataService = container.resolve(ServiceTokens.ExecutionMetadataService);
            const individualExecutionEngine = container.resolve(ServiceTokens.IndividualExecutionEngine);
            const batchExecutionEngine = container.resolve(ServiceTokens.BatchExecutionEngine);

            const coordinator = new ExecutionCoordinator({
                executionMetadataService,
                individualExecutionEngine,
                batchExecutionEngine
            } as any, this.logger);

            // Now inject the coordinator back into the engines to complete the circular dependency
            this.injectExecutionCoordinatorIntoEngines(container, coordinator);

            return coordinator;
        });
    }

    /**
     * Register BatchExecutionEngine
     */
    private async registerBatchExecutionEngine(): Promise<void> {
        const { BatchExecutionEngine } = await import('../services/execution/batch-execution-engine.service');
        const { VsCodeConsoleProgressSink } = await import('../platform/vscode/vscode-console-progress-sink');
        const { dbmnSettings } = await import('../platform/vscode/vscode-settings');
        const { promptDbmnAuthExpired } = await import('../services/ui/dbmn-prompts');
        const { getToast } = await import('../services/notifications/get-toast');

        this.container.registerFactory(ServiceTokens.BatchExecutionEngine, (container) => {
            const executionMetadataService = container.resolve(ServiceTokens.ExecutionMetadataService);
            // Use ExecutionService (pure executor)
            const executionService = container.resolve(ServiceTokens.ExecutionService);
            // Remove executionCoordinator to avoid circular dependency

            // Try to get UI services from registry
            let stateBroadcaster: any;
            let progressManager: any;

            try {
                const { UIServiceTokens } = require('./ui-services-registry');

                // Try to resolve each UI service individually
                try {
                    stateBroadcaster = container.resolve(UIServiceTokens.StateBroadcaster);
                } catch (error) {
                            this.logger.debug('[ServiceBootstrap] StateBroadcaster not available for BatchExecutionEngine');
                    stateBroadcaster = undefined;
                }

                try {
                    progressManager = container.resolve(UIServiceTokens.ProgressManager);
                } catch (error) {
                            this.logger.debug('[ServiceBootstrap] ProgressManager not available for BatchExecutionEngine');
                    progressManager = undefined;
                }
            } catch (error) {
                    this.logger.debug('[ServiceBootstrap] UIServiceTokens not available for BatchExecutionEngine');
                stateBroadcaster = undefined;
                progressManager = undefined;
            }

            // Try to get ExecutionLoggingService
            let executionLoggingService: any;
            try {
                                executionLoggingService = container.resolve(CoreServiceTokens.ExecutionLoggingService);
            } catch (error) {
                    this.logger.debug('[ServiceBootstrap] ExecutionLoggingService not available for BatchExecutionEngine');
                executionLoggingService = undefined;
            }


            // Get TransactionCreator for split operations (GitHub Issue #74)
            const transactionCreator = container.resolve(CoreServiceTokens.TransactionCreator);

            // Get TransactionPreparationService for JIT chunk preparation (GitHub Issue #94)
            let transactionPreparationService: any;
            try {
                transactionPreparationService = container.resolve(ServiceTokens.TransactionPreparationService);
            } catch (error) {
                this.logger.debug('[ServiceBootstrap] TransactionPreparationService not available for BatchExecutionEngine');
                transactionPreparationService = undefined;
            }

            // GitHub Issue #156: Get EnvironmentManager for reading environment's max concurrency
            let environmentManager: any;
            try {
                environmentManager = container.resolve(ServiceTokens.EnvironmentManager);
            } catch (error) {
                this.logger.debug('[ServiceBootstrap] EnvironmentManager not available for BatchExecutionEngine');
                environmentManager = undefined;
            }

            return new BatchExecutionEngine({
                executionMetadataService,
                executionService,
                stateBroadcaster,
                progressManager,
                executionLoggingService,
                transactionCreator,
                transactionPreparationService, // GitHub Issue #94: For JIT streaming preparation
                environmentManager, // GitHub Issue #156: For reading environment's max concurrency
                progressSink: new VsCodeConsoleProgressSink(), // Issue #320: Console updates
                // Issue #321: what the engine used to read from vscode and `global` itself
                configuration: dbmnSettings(),   // #281: the account's settings while signed in
                dbmnAuth: () => (global as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined,
                // #359: after a 401, OAuth environments use their refresh token; the rest the DBMN session
                refreshCredentials: (environmentId: string) => this.refreshCredentials(container, environmentId),
                dbmnTelemetry: () => (global as Record<string, unknown>).dbmnTelemetryService as IDbmnTelemetry | undefined,
                toast: getToast,
                promptDbmnAuthExpired: (dbmnAuth: IDbmnAuthService) =>
                    promptDbmnAuthExpired(dbmnAuth, (global as Record<string, unknown>).dbmnToastService as IToastService)
                // executionCoordinator will be injected separately to avoid circular dependency
            } as any, this.logger);
        });
    }

    /**
     * #359: new credentials after a 401, without asking: an OAuth environment's refresh token, a
     * DBMN environment's session. A JWT environment has nothing to refresh. Takes the
     * environment's id, or a single run's name for it.
     */
    private async refreshCredentials(container: IServiceContainer, idOrName: string): Promise<boolean> {
        try {
            const environments = container.resolve<{ getEnvironment(id: string): Promise<{ id: string; authMethod?: string } | undefined>; getAllEnvironments(): Promise<Array<{ id: string; name: string; authMethod?: string }>> }>(ServiceTokens.EnvironmentManager);
            const environment = await environments.getEnvironment(idOrName) ?? (await environments.getAllEnvironments()).find(e => e.name === idOrName);
            if (environment?.authMethod === 'oauth') {
                return await container.resolve<{ refreshSilently(id: string): Promise<boolean> }>('IOAuthService').refreshSilently(environment.id);
            }
            if (environment && environment.authMethod !== 'dbmn') return false;   // a JWT is pasted: nothing to refresh
            const dbmnAuth = (global as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
            return !!dbmnAuth && (await dbmnAuth.refreshSession()).status === 'success';
        } catch (error) {
            this.logger.warn('[ServiceBootstrap] refreshing credentials after a 401 failed', error instanceof Error ? error : undefined);
            return false;
        }
    }

    /**
     * Register IndividualExecutionEngine
     */
    private async registerIndividualExecutionEngine(): Promise<void> {
        const { IndividualExecutionEngine } = await import('../services/execution/individual-execution-engine.service');
        const { VsCodeConsoleProgressSink } = await import('../platform/vscode/vscode-console-progress-sink');

        this.container.registerFactory(ServiceTokens.IndividualExecutionEngine, (container) => {
            const executionMetadataService = container.resolve(ServiceTokens.ExecutionMetadataService);
            // Use ExecutionService (pure executor)
            const executionService = container.resolve(ServiceTokens.ExecutionService);
            // Remove executionCoordinator to avoid circular dependency

            return new IndividualExecutionEngine({
                executionMetadataService,
                executionService,
                // executionCoordinator removed to prevent circular dependency
                progressSink: new VsCodeConsoleProgressSink(),
                refreshCredentials: (environmentId: string) => this.refreshCredentials(container, environmentId)
            } as any, this.logger);
        });
    }

    /**
     * Create standard execution service dependencies
     */
    private createExecutionServiceDependencies(container: IServiceContainer): any {
        // Core dependencies (required)
        const coreDependencies = {
            executionValidationService: container.resolve(ServiceTokens.ExecutionValidationService),
            executionMetadataService: container.resolve(ServiceTokens.ExecutionMetadataService),
            executionFileService: container.resolve(ServiceTokens.ExecutionFileService),
            dobermannInstance: container.resolve(ServiceTokens.DobermannInstance)
        };
        // Issue #322: requests go through the portable executor; Dobermann supplies its host parts
        const dobermann = coreDependencies.dobermannInstance as { getRequestExecutor?: () => unknown } | undefined;
        const requestExecutor = typeof dobermann?.getRequestExecutor === 'function' ? dobermann.getRequestExecutor() : undefined;

        // Optional ExecutionLoggingService - graceful resolution
        let executionLoggingService;
        try {
                        executionLoggingService = container.resolve(CoreServiceTokens.ExecutionLoggingService);
        } catch (error) {
            this.logger.debug('[ServiceBootstrap] ExecutionLoggingService not available for ExecutionService', { error: error instanceof Error ? error.message : String(error) });
            executionLoggingService = undefined;
        }

        // Optional ResponseTestingService - graceful resolution
        let responseTestingService;
        try {
            responseTestingService = container.resolve(ServiceTokens.ResponseTestingService);
        } catch (error) {
            this.logger.debug('[ServiceBootstrap] ResponseTestingService not available for ExecutionService', { error: error instanceof Error ? error.message : String(error) });
            responseTestingService = undefined;
        }

        // Issue #317: what ExecutionService used to reach through Dobermann and `global`
        let environments: unknown;
        try {
            environments = container.resolve(ServiceTokens.EnvironmentManager);
        } catch {
            environments = undefined;
        }

        return {
            ...coreDependencies,
            requestExecutor,
            environments,
            executionLoggingService,
            responseTestingService
            // executionCoordinator will be injected separately to avoid circular dependency
        };
    }

    /**
     * Inject ExecutionCoordinator into engines and services to complete circular dependency
     */
    private injectExecutionCoordinatorIntoEngines(container: IServiceContainer, coordinator: any): void {
        try {
            // Inject into ExecutionService (for individual executions routing)
            const executionService = container.resolve(ServiceTokens.ExecutionService) as any;
            if (executionService && executionService.dependencies) {
                executionService.dependencies.executionCoordinator = coordinator;
                    this.logger.debug('[ServiceBootstrap] ExecutionCoordinator injected into ExecutionService');
            }

            // Inject into BatchExecutionEngine
            const batchEngine = container.resolve(ServiceTokens.BatchExecutionEngine) as any;
            if (batchEngine && typeof batchEngine.setExecutionCoordinator === 'function') {
                batchEngine.setExecutionCoordinator(coordinator);
            } else {
                // Fallback: directly set the dependency
                if (batchEngine && batchEngine.dependencies) {
                    batchEngine.dependencies.executionCoordinator = coordinator;
                }
            }

            // Inject into IndividualExecutionEngine if needed
            const individualEngine = container.resolve(ServiceTokens.IndividualExecutionEngine) as any;
            if (individualEngine && typeof individualEngine.setExecutionCoordinator === 'function') {
                individualEngine.setExecutionCoordinator(coordinator);
            } else {
                // Fallback: directly set the dependency
                if (individualEngine && individualEngine.dependencies) {
                    individualEngine.dependencies.executionCoordinator = coordinator;
                }
            }

            this.logger.debug('[ServiceBootstrap] ExecutionCoordinator injected into all services');
        } catch (error) {
            this.logger.error('[ServiceBootstrap] Failed to inject ExecutionCoordinator into services', error instanceof Error ? error : undefined);
        }
    }

    /**
     * Get the execution service (pure executor)
     */
    getExecutionService(): any {
        return this.container.resolve(ServiceTokens.ExecutionService);
    }

    /**
     * Get the transaction preparation service
     */
    getTransactionPreparationService(): any {
        return this.container.resolve(ServiceTokens.TransactionPreparationService);
    }

    /**
     * Get the execution coordinator
     */
    getExecutionCoordinator(): any {
        return this.container.resolve(ServiceTokens.ExecutionCoordinator);
    }

    /**
     * Get the batch execution engine
     */
    getBatchExecutionEngine(): any {
        return this.container.resolve(ServiceTokens.BatchExecutionEngine);
    }

}