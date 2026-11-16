// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution Service Registry
 * 
 * Following Architecture.md - Service Registration patterns
 * Configures and registers all execution-related services in the DI container
 */

import { IServiceContainer, ServiceTokens, ServiceRegistrationConfig } from './service-container.interface';

// Service interfaces
import { IExecutionService } from '../services/execution/execution.interface';
import { IExecutionEngine } from '../services/execution/execution-engine.interface';
import { IExecutionQueueManagerService } from '../services/execution/execution-queue-manager.interface';
import { IExecutionStateManagerService } from '../services/execution/execution-state-manager.interface';
import { IExecutionValidationService } from '../services/execution/execution-validation.interface';
import { IExecutionMetadataService } from '../services/execution/execution-metadata.interface';
import { IExecutionFileService } from '../services/execution/execution-file.interface';
import { IExecutionLoggingService } from '../services/logging/execution-logging.interface';
import { IBatchExecutionEngine } from '../services/execution/batch-execution-engine.interface';

// Service implementations
// LEGACY - Removed in Phase 9.4: import { ExecutionService } from '../services/execution/execution.service';
// LEGACY - Removed in Phase 9.4: import { ExecutionEngine } from '../services/execution/execution-engine.service';
// LEGACY - Removed in Phase 9.4: import { ExecutionQueueManagerService } from '../services/execution/execution-queue-manager.service';
import { ExecutionStateManagerService } from '../services/execution/execution-state-manager.service';
import { ExecutionValidationService } from '../services/execution/execution-validation.service';
import { ExecutionMetadataService } from '../services/execution/execution-metadata.service';
import { ExecutionFileService } from '../services/execution/execution-file.service';
import { ExecutionLoggingService } from '../services/logging/execution-logging.service';
import { TransactionCreator } from '../services/transaction-creator/transaction-creator.service';
import { ITransactionCreator } from '../services/transaction-creator/transaction-creator.interface';
import { JsonGenerator } from '../data-loading/json-generator';
import { IFileSystemService } from '../platform/interfaces/filesystem.interface';
import { CoreServiceTokens } from './core-services-registry';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';

// Import types for proper typing
import * as vscode from 'vscode';
import { Dobermann } from '../dobermann';
import { APIEndpointManager } from '../apiEndpointManager';
import { EnvironmentManager } from '../environmentManager';
// GitHub Issue #102: SimpleExecutionMetadataManager kept for type reference only (database storage is now standard)
import { SimpleExecutionMetadataManager } from '../storage/simple-execution-metadata-manager';

// Import Batch Copy Service dependencies for GitHub Issue #68 (rewritten for GitHub Issue #176)
import { BatchCopyService } from '../services/batch-copy/batch-copy.service';
import { IBatchCopyService } from '../services/batch-copy/batch-copy.interface';

// Import UI and Progress service tokens and interfaces
import { ITimeEstimationService } from '../services/time-estimation/time-estimation.interface';
import { IBatchProgressService } from '../services/batch-progress/batch-progress.interface';


/**
 * Register all execution services in the container
 * @param container - Service container instance
 * @param dependencies - External dependencies (DobermannInstance, VSCode API, etc.)
 */
export function registerExecutionServices(
    container: IServiceContainer,
    dependencies: ExecutionServiceDependencies
): void {
    // Register external dependencies as singletons
    container.registerSingleton(ServiceTokens.DobermannInstance, dependencies.dobermannInstance);
    container.registerSingleton(ServiceTokens.VSCodeAPI, dependencies.vscodeAPI);
    container.registerSingleton(ServiceTokens.ExtensionContext, dependencies.extensionContext);

    // Register legacy managers as singletons (for migration period)
    if (dependencies.executionMetadataManager) {
        container.registerSingleton(ServiceTokens.ExecutionMetadataManager, dependencies.executionMetadataManager);
    }
    if (dependencies.environmentManager) {
        container.registerSingleton(ServiceTokens.EnvironmentManager, dependencies.environmentManager);
    }
    if (dependencies.endpointManager) {
        container.registerSingleton(ServiceTokens.EndpointManager, dependencies.endpointManager);
    }
    if (dependencies.systemManager) {
        container.registerSingleton(ServiceTokens.SystemManager, dependencies.systemManager);
    }

    // Register execution services as factories for dependency injection
    // Important: Register dependencies before services that use them
    
    // 1. Register base services first (no internal dependencies)
    container.registerFactory(ServiceTokens.ExecutionValidationService, (c) => {
        return new ExecutionValidationService({
            dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
            environmentManager: c.resolve(ServiceTokens.EnvironmentManager)
        });
    });

    container.registerFactory(ServiceTokens.ExecutionMetadataService, (c) => {
        // Try to get StateBroadcaster from UI services registry
        let stateBroadcaster: any;
        try {
            const { UIServiceTokens } = require('./ui-services-registry');
            stateBroadcaster = c.resolve(UIServiceTokens.StateBroadcaster);
        } catch (error) {
            // StateBroadcaster is optional - no logging needed
            stateBroadcaster = undefined;
        }

        // Get logger from DI container
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        
        return new ExecutionMetadataService({
            executionMetadataManager: c.resolve(ServiceTokens.ExecutionMetadataManager),
            dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
            stateBroadcaster
        }, logger);
    });

    container.registerFactory(ServiceTokens.ExecutionFileService, (c) => {
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        return new ExecutionFileService({
            dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
            vscodeAPI: c.resolve(ServiceTokens.VSCodeAPI),
            logger: logger
        });
    });

    // Create singleton ExecutionLoggingService to ensure all services share the same instance
    // This is critical for live streaming callbacks to work across batch executions
    let executionLoggingServiceSingleton: ExecutionLoggingService | null = null;
    
    container.registerFactory(CoreServiceTokens.ExecutionLoggingService, (c) => {
        // Return the same instance on subsequent calls
        if (executionLoggingServiceSingleton) {
            return executionLoggingServiceSingleton;
        }
        // Get optional dependencies - safe resolution pattern
        let executionMetadataService: IExecutionMetadataService | undefined;
        let fileSystemService: IFileSystemService | undefined;

        try {
            executionMetadataService = c.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService);
        } catch (error) {
            // ExecutionMetadataService is optional
        }

        try {
            fileSystemService = c.resolve<IFileSystemService>(CoreServiceTokens.FileSystemService);
        } catch (error) {
            // FileSystemService is optional
        }

        // Get logger from DI container
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        
        // Create the singleton instance
        executionLoggingServiceSingleton = new ExecutionLoggingService({
            executionMetadataService,
            fileSystemService
        }, logger);
        
        return executionLoggingServiceSingleton;
    });

    // 2. Register state manager (depends on ExecutionMetadataService)
    container.registerFactory(ServiceTokens.ExecutionStateManagerService, (c) => {
        return new ExecutionStateManagerService(
            c.resolve(ServiceTokens.ExecutionMetadataService)
        );
    });

    // 3. LEGACY - Phase 9.4: ExecutionQueueManagerService removed, returning stub
    container.registerFactory(ServiceTokens.ExecutionQueueManagerService, (c) => {
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        const message = '[ExecutionQueueManagerService] Legacy service requested - returning stub.';
        logger.warn(message);
        return {
            addToQueue: async () => { throw new Error('ExecutionQueueManagerService removed - use new architecture'); },
            getQueueStatus: () => ({ length: 0, processing: false })
        };
    });

    // 4. Register ExecutionEngine last (depends on all above services)
    container.registerFactory(ServiceTokens.ExecutionEngine, (c) => {
        // Resolve logger once at the beginning
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        
        // ✅ REQUIRED: Individual service resolution with isolation (per Architecture.md)
        let timeEstimationService: ITimeEstimationService | undefined;
        let batchProgressService: IBatchProgressService | undefined;

        // Try to get ProgressServiceTokens - if this fails, all progress services will be undefined
        let ProgressServiceTokens: typeof import('./progress-services-registry').ProgressServiceTokens | null;
        try {
            ProgressServiceTokens = require('./progress-services-registry').ProgressServiceTokens;
        } catch (error) {
            ProgressServiceTokens = null;
        }

        // Individual progress service resolution - each service can fail independently
        if (ProgressServiceTokens) {
            try {
                timeEstimationService = c.resolve(ProgressServiceTokens.TimeEstimationService);

            } catch (error) {
                timeEstimationService = undefined;
            }

            try {
                batchProgressService = c.resolve(ProgressServiceTokens.BatchProgressService);

            } catch (error) {
                batchProgressService = undefined;
            }
        }



        // LEGACY - Phase 9.4: ExecutionEngine removed, returning stub
        const message = '[ExecutionEngine] Legacy ExecutionEngine requested - returning stub. Use new architecture instead.';
        logger.warn(message);
        return {
            start: async () => { /* ExecutionEngine.start() - removed in Phase 9.4 */ },
            stop: async () => { /* ExecutionEngine.stop() - removed in Phase 9.4 */ },
            scheduleExecution: async () => { throw new Error('ExecutionEngine removed - use new architecture'); },
            onExecutionStateChanged: () => { /* Legacy stub - no-op */ }
        };
    });

    // Register TransactionCreator for batch preparation support
    container.registerFactory(CoreServiceTokens.TransactionCreator, (c) => {
        // Try to get StateBroadcaster from UI services registry
        let stateBroadcaster: any;
        try {
            const { UIServiceTokens } = require('./ui-services-registry');
            stateBroadcaster = c.resolve(UIServiceTokens.StateBroadcaster);
        } catch (error) {
            stateBroadcaster = undefined;
        }

        // Try to get ExecutionLoggingService - optional dependency
        let executionLoggingService: any;
        try {
            executionLoggingService = c.resolve(CoreServiceTokens.ExecutionLoggingService);
        } catch (error) {
            executionLoggingService = undefined;
        }

        // Get logger from DI container
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
        
        return new TransactionCreator(
            c.resolve(ServiceTokens.ExecutionMetadataService),
            c.resolve(ServiceTokens.ExecutionFileService),
            logger,
            stateBroadcaster,
            executionLoggingService
        );
    });


    container.registerFactory(ServiceTokens.ExecutionService, (c) => {
        // Resolve logger once at the beginning
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

        // Resolve Phase4 services individually to prevent cascade failures
        let timeEstimationService: ITimeEstimationService | undefined;
        let batchProgressService: IBatchProgressService | undefined;

        // Try to get Progress Service Tokens - if this fails, all services will be undefined
        let ProgressServiceTokens: typeof import('./progress-services-registry').ProgressServiceTokens | null;
        try {
            ProgressServiceTokens = require('./progress-services-registry').ProgressServiceTokens;
        } catch (error) {
            ProgressServiceTokens = null;
        }

        // Individual service resolution - each service can fail independently
        if (ProgressServiceTokens) {
            // Try TimeEstimationService
            try {
                timeEstimationService = c.resolve(ProgressServiceTokens.TimeEstimationService);

            } catch (error) {
                timeEstimationService = undefined;
            }

            // Try BatchProgressService
            try {
                batchProgressService = c.resolve(ProgressServiceTokens.BatchProgressService);

            } catch (error) {
                batchProgressService = undefined;
            }
        }


        // LEGACY - Phase 9.4: ExecutionService removed, returning stub
        const message = '[ExecutionService] Legacy ExecutionService requested - returning stub. Use new ExecutionService instead.';
        logger.warn(message);
        return {
            execute: async () => { throw new Error('ExecutionService.execute() removed - use executeRecord()'); },
            executeEndpoint: async () => { throw new Error('ExecutionService.executeEndpoint() removed - use executeRecord()'); }
        };
    });

    // Register BatchCopyService for GitHub Issue #68 (rewritten for GitHub Issue #176)
    container.registerFactory(ServiceTokens.BatchCopyService, (c) => {
        try {
            const executionMetadataService = c.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService);

            // Resolve TransactionPreparationService (required for proper batch copy)
            let transactionPreparationService: any;
            try {
                transactionPreparationService = c.resolve(ServiceTokens.TransactionPreparationService);
            } catch (error) {
                console.error('[BatchCopyService] TransactionPreparationService not available:', error);
                throw new Error('TransactionPreparationService is required for BatchCopyService');
            }

            // Resolve managers
            const endpointManager = c.resolve<APIEndpointManager>(ServiceTokens.EndpointManager);
            const environmentManager = c.resolve<EnvironmentManager>(ServiceTokens.EnvironmentManager);

            // Try to get BatchExecutionEngine (optional dependency)
            let batchExecutionEngine: IBatchExecutionEngine | undefined;
            try {
                batchExecutionEngine = c.resolve<IBatchExecutionEngine>(ServiceTokens.BatchExecutionEngine);
            } catch (error) {
                console.warn('[BatchCopyService] BatchExecutionEngine not available - copied batches will remain in pending status');
            }

            // Get logger (optional)
            let logger: any;
            try {
                logger = c.resolve(CoreServiceTokens.ExtensionDiagnosticLogger);
            } catch (error) {
                logger = undefined;
            }

            return new BatchCopyService(
                executionMetadataService,
                transactionPreparationService,
                endpointManager,
                environmentManager,
                batchExecutionEngine,
                logger
            );
        } catch (error) {
            console.error('[BatchCopyService] Registration failed:', error);
            throw error;
        }
    });

}

/**
 * Get execution service registration configuration
 * This can be used with container.registerServices() for bulk registration
 */
export function getExecutionServiceConfig(dependencies: ExecutionServiceDependencies): ServiceRegistrationConfig[] {
    return [
        // External dependencies
        { token: ServiceTokens.DobermannInstance, type: 'singleton', value: dependencies.dobermannInstance },
        { token: ServiceTokens.VSCodeAPI, type: 'singleton', value: dependencies.vscodeAPI },
        { token: ServiceTokens.ExtensionContext, type: 'singleton', value: dependencies.extensionContext },

        // Legacy managers (optional)
        ...(dependencies.executionMetadataManager ? [{
            token: ServiceTokens.ExecutionMetadataManager,
            type: 'singleton' as const,
            value: dependencies.executionMetadataManager
        }] : []),

        ...(dependencies.environmentManager ? [{
            token: ServiceTokens.EnvironmentManager,
            type: 'singleton' as const,
            value: dependencies.environmentManager
        }] : []),

        ...(dependencies.endpointManager ? [{
            token: ServiceTokens.EndpointManager,
            type: 'singleton' as const,
            value: dependencies.endpointManager
        }] : []),

        // Execution services
        {
            token: ServiceTokens.ExecutionValidationService,
            type: 'factory',
            value: (c: IServiceContainer) => new ExecutionValidationService({
                dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
                environmentManager: c.resolve(ServiceTokens.EnvironmentManager)
            })
        },
        {
            token: ServiceTokens.ExecutionMetadataService,
            type: 'factory',
            value: (c: IServiceContainer) => {
                // Try to get StateBroadcaster from UI services registry
                let stateBroadcaster: any;
                try {
                    const { UIServiceTokens } = require('./ui-services-registry');
                    stateBroadcaster = c.resolve(UIServiceTokens.StateBroadcaster);
                } catch (error) {
                    stateBroadcaster = undefined;
                }

                // Get logger from DI container
                const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
                
                return new ExecutionMetadataService({
                    executionMetadataManager: c.resolve(ServiceTokens.ExecutionMetadataManager),
                    dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
                    stateBroadcaster
                }, logger);
            }
        },
        {
            token: ServiceTokens.ExecutionFileService,
            type: 'factory',
            value: (c: IServiceContainer) => {
                const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
                return new ExecutionFileService({
                    dobermannInstance: c.resolve(ServiceTokens.DobermannInstance),
                    vscodeAPI: c.resolve(ServiceTokens.VSCodeAPI),
                    logger: logger
                });
            }
        },
        {
            token: ServiceTokens.ExecutionService,
            type: 'factory',
            value: (c: IServiceContainer) => {
                // LEGACY - Phase 9.4: ExecutionService removed, returning stub
                const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
                const message = '[ExecutionService] Legacy ExecutionService requested - returning stub. Use new ExecutionService instead.';
                logger.warn(message);
                return {
                    execute: async () => { throw new Error('ExecutionService.execute() removed - use executeRecord()'); },
                    executeEndpoint: async () => { throw new Error('ExecutionService.executeEndpoint() removed - use executeRecord()'); }
                };
            }
        }
    ];
}

/**
 * Dependencies required for execution service registration
 *
 * Note: We use 'any' types for flexibility in testing while documenting the expected runtime types
 * In production, these will be the proper typed instances:
 * - dobermannInstance: Dobermann
 * - vscodeAPI: typeof vscode
 * - extensionContext: vscode.ExtensionContext
 * - executionMetadataManager: DatabaseAdapter (GitHub Issue #102: Database storage is now standard)
 * - environmentManager: EnvironmentManager
 * - endpointManager: APIEndpointManager
 */
export interface ExecutionServiceDependencies {
    /** Dobermann instance for API operations */
    dobermannInstance: any; // Dobermann in production, mocked for testing

    /** VS Code API instance */
    vscodeAPI: any; // typeof vscode in production, mocked for testing

    /** Extension context */
    extensionContext: any; // vscode.ExtensionContext in production, mocked for testing

    /** Execution metadata storage manager (GitHub Issue #102: Database storage is now standard) */
    executionMetadataManager?: any; // DatabaseAdapter in production, mocked for testing

    /** Legacy environment manager (optional for migration) */
    environmentManager?: any; // EnvironmentManager in production, mocked for testing

    /** Legacy endpoint manager (optional for migration) */
    endpointManager?: any; // APIEndpointManager in production, mocked for testing

    /** System manager - owns Systems (groupings of endpoints + environments) */
    systemManager?: any; // SystemManager in production, mocked for testing
}

/**
 * Create and configure a container with execution services
 * @param dependencies - Required dependencies
 * @returns Configured service container
 */
export function createExecutionContainer(dependencies: ExecutionServiceDependencies): IServiceContainer {
    const { createServiceContainer } = require('./service-container');
    const container = createServiceContainer({
        autoDispose: true,
        detectCycles: true,
        maxDepth: 10
    });

    // Register core services first (required dependency for execution services)
    const { registerCoreServices } = require('./core-services-registry');
    const mockContext = {
        subscriptions: [],
        extensionPath: '/test/path',
        asAbsolutePath: (path: string) => `/test/path/${path}`,
        globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
        workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] }
    } as any;
    registerCoreServices(container, mockContext);

    registerExecutionServices(container, dependencies);
    return container;
}

/**
 * Helper function to resolve all execution services from container
 */
export function resolveExecutionServices(container: IServiceContainer) {
    return {
        executionService: container.resolve<IExecutionService>(ServiceTokens.ExecutionService),
        executionEngine: container.resolve<IExecutionEngine>(ServiceTokens.ExecutionEngine),
        executionQueueManagerService: container.resolve<IExecutionQueueManagerService>(ServiceTokens.ExecutionQueueManagerService),
        executionStateManagerService: container.resolve<IExecutionStateManagerService>(ServiceTokens.ExecutionStateManagerService),
        executionValidationService: container.resolve<IExecutionValidationService>(ServiceTokens.ExecutionValidationService),
        executionMetadataService: container.resolve<IExecutionMetadataService>(ServiceTokens.ExecutionMetadataService),
        executionFileService: container.resolve<IExecutionFileService>(ServiceTokens.ExecutionFileService)
    };
}

/**
 * ExecutionServiceTokens - Alias for ServiceTokens to maintain compatibility
 * UI services expect ExecutionServiceTokens.ExecutionEngine but we use ServiceTokens.ExecutionEngine
 * This export provides the expected interface for UI service resolution
 */
export const ExecutionServiceTokens = {
    ExecutionEngine: ServiceTokens.ExecutionEngine,
    ExecutionService: ServiceTokens.ExecutionService,
    ExecutionQueueManagerService: ServiceTokens.ExecutionQueueManagerService,
    ExecutionStateManagerService: ServiceTokens.ExecutionStateManagerService,
    ExecutionValidationService: ServiceTokens.ExecutionValidationService,
    ExecutionMetadataService: ServiceTokens.ExecutionMetadataService,
    ExecutionFileService: ServiceTokens.ExecutionFileService
};

/**
 * Service health check - verify all execution services can be resolved
 */
export function verifyExecutionServices(container: IServiceContainer): { success: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
        const services = resolveExecutionServices(container);

        // Verify each service is properly instantiated
        if (!services.executionService) {
            errors.push('ExecutionService not resolved');
        }
        if (!services.executionEngine) {
            errors.push('ExecutionEngine not resolved');
        }
        if (!services.executionQueueManagerService) {
            errors.push('ExecutionQueueManagerService not resolved');
        }
        if (!services.executionStateManagerService) {
            errors.push('ExecutionStateManagerService not resolved');
        }
        if (!services.executionValidationService) {
            errors.push('ExecutionValidationService not resolved');
        }
        if (!services.executionMetadataService) {
            errors.push('ExecutionMetadataService not resolved');
        }
        if (!services.executionFileService) {
            errors.push('ExecutionFileService not resolved');
        }

    } catch (error) {
        errors.push(`Service resolution failed: ${error}`);
    }

    return {
        success: errors.length === 0,
        errors
    };
}