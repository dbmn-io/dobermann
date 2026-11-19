// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service Container Interface
 * 
 * Following Architecture.md - Dependency Injection Container patterns
 * This interface defines the contract for service registration and resolution
 */

export interface IServiceContainer {
    /**
     * Register a singleton service instance
     * @param token - Service identifier
     * @param instance - Service instance
     */
    registerSingleton<T>(token: ServiceToken<T>, instance: T): void;

    /**
     * Register a factory function for creating service instances
     * @param token - Service identifier
     * @param factory - Factory function
     */
    registerFactory<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): void;

    /**
     * Register a transient service (new instance on each resolve)
     * @param token - Service identifier
     * @param constructor - Service constructor
     */
    registerTransient<T>(token: ServiceToken<T>, constructor: ServiceConstructor<T>): void;

    /**
     * Resolve a service instance
     * @param token - Service identifier
     * @returns Service instance
     */
    resolve<T>(token: ServiceToken<T>): T;

    /**
     * Check if a service is registered
     * @param token - Service identifier
     * @returns True if service is registered
     */
    isRegistered<T>(token: ServiceToken<T>): boolean;

    /**
     * Clear all registered services
     */
    clear(): void;

    /**
     * Register multiple services from configuration
     * @param services - Array of service registration configurations
     */
    registerServices(services: ServiceRegistrationConfig[]): void;

    /**
     * Get registration details for debugging
     * @returns Map of service registrations
     */
    getRegistrations(): Map<string, { type: string; hasInstance: boolean }>;

    /**
     * Dispose container and cleanup resources
     */
    dispose(): void;
}

/**
 * Service token type for type-safe service registration and resolution
 */
export type ServiceToken<T = any> = string | symbol | (new (...args: any[]) => T);

/**
 * Factory function type for creating service instances
 */
export type ServiceFactory<T> = (container: IServiceContainer) => T;

/**
 * Service constructor type
 */
export type ServiceConstructor<T> = new (dependencies: any) => T;

/**
 * Service registration type
 */
export type ServiceRegistration = {
    type: 'singleton' | 'factory' | 'transient';
    value: any;
    instance?: any;
};

/**
 * Service registration configuration for bulk registration
 */
export interface ServiceRegistrationConfig {
    token: ServiceToken;
    type: 'singleton' | 'factory' | 'transient';
    value: any;
}

/**
 * Pre-defined service tokens for execution services
 */
export const ServiceTokens = {
    // Core execution services
    ExecutionService: Symbol('ExecutionService'),
    ExecutionEngine: Symbol('ExecutionEngine'),
    ExecutionQueueManagerService: Symbol('ExecutionQueueManagerService'),
    ExecutionStateManagerService: Symbol('ExecutionStateManagerService'),
    ExecutionValidationService: Symbol('ExecutionValidationService'), 
    ExecutionMetadataService: Symbol('ExecutionMetadataService'),
    ExecutionFileService: Symbol('ExecutionFileService'),
    BatchPreparationService: Symbol('BatchPreparationService'),
    
    // New architecture services (Phase 2+3)
    TransactionPreparationService: Symbol('TransactionPreparationService'),
    // ExecutionService is now the default implementation
    ExecutionCoordinator: Symbol('ExecutionCoordinator'),
    BatchExecutionEngine: Symbol('BatchExecutionEngine'),
    IndividualExecutionEngine: Symbol('IndividualExecutionEngine'),
    ResponseTestingService: Symbol('ResponseTestingService'),
    BatchCopyService: Symbol('BatchCopyService'),

    // Data management services
    ImportExportService: Symbol('ImportExportService'),

    // Infrastructure dependencies
    DobermannInstance: Symbol('DobermannInstance'),
    VSCodeAPI: Symbol('VSCodeAPI'),
    ExtensionContext: Symbol('ExtensionContext'),
    
    
    // Managers (legacy integration)
    ExecutionMetadataManager: Symbol('ExecutionMetadataManager'),
    EnvironmentManager: Symbol('EnvironmentManager'),
    EndpointManager: Symbol('EndpointManager'),
    SystemManager: Symbol('SystemManager'),
    
    // UI Components

    // DBMN Authentication (GitHub Issue #208)
    // Primary tokens defined in DbmnServiceTokens (src/container/dbmn-services-registry.ts)
    DbmnAuthService: Symbol('DbmnAuthService'),
    DbmnStatusBar: Symbol('DbmnStatusBar'),
    DbmnTelemetry: Symbol('DbmnTelemetry')
} as const;

/**
 * Container configuration options
 */
export interface ServiceContainerOptions {
    /** Enable automatic disposal of disposable services */
    autoDispose?: boolean;
    /** Enable dependency cycle detection */
    detectCycles?: boolean;
    /** Maximum dependency resolution depth */
    maxDepth?: number;
}