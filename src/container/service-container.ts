// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service Container Implementation
 * 
 * Following Architecture.md - Dependency Injection Container patterns
 * Provides service registration, resolution, and lifecycle management
 */

import { 
    IServiceContainer, 
    ServiceToken, 
    ServiceFactory, 
    ServiceConstructor, 
    ServiceRegistration,
    ServiceRegistrationConfig,
    ServiceContainerOptions 
} from './service-container.interface';

export class ServiceContainer implements IServiceContainer {
    private services = new Map<ServiceToken, ServiceRegistration>();
    private resolving = new Set<ServiceToken>();
    private options: Required<ServiceContainerOptions>;

    constructor(options: ServiceContainerOptions = {}) {
        this.options = {
            autoDispose: true,
            detectCycles: true,
            maxDepth: 10,
            ...options
        };
    }

    /**
     * Register a singleton service instance
     */
    registerSingleton<T>(token: ServiceToken<T>, instance: T): void {
        this.services.set(token, {
            type: 'singleton',
            value: instance,
            instance
        });
    }

    /**
     * Register a factory function for creating service instances
     */
    registerFactory<T>(token: ServiceToken<T>, factory: ServiceFactory<T>): void {
        this.services.set(token, {
            type: 'factory',
            value: factory
        });
    }

    /**
     * Register a transient service (new instance on each resolve)
     */
    registerTransient<T>(token: ServiceToken<T>, constructor: ServiceConstructor<T>): void {
        this.services.set(token, {
            type: 'transient',
            value: constructor
        });
    }

    /**
     * Resolve a service instance
     */
    resolve<T>(token: ServiceToken<T>): T {
        const registration = this.services.get(token);
        
        if (!registration) {
            throw new Error(`Service not registered: ${this.tokenToString(token)}`);
        }

        // Cycle detection
        if (this.options.detectCycles && this.resolving.has(token)) {
            throw new Error(`Circular dependency detected for service: ${this.tokenToString(token)}`);
        }

        // Depth protection
        if (this.resolving.size >= this.options.maxDepth) {
            throw new Error(`Maximum dependency resolution depth exceeded: ${this.options.maxDepth}`);
        }

        try {
            this.resolving.add(token);
            return this.createInstance<T>(registration);
        } finally {
            this.resolving.delete(token);
        }
    }

    /**
     * Check if a service is registered
     */
    isRegistered<T>(token: ServiceToken<T>): boolean {
        return this.services.has(token);
    }

    /**
     * Clear all registered services
     */
    clear(): void {
        if (this.options.autoDispose) {
            // Dispose all disposable services
            for (const registration of this.services.values()) {
                if (registration.instance && typeof registration.instance.dispose === 'function') {
                    try {
                        registration.instance.dispose();
                    } catch (error) {
                        console.warn('Error disposing service:', error);
                    }
                }
            }
        }
        
        this.services.clear();
        this.resolving.clear();
    }

    /**
     * Dispose container and cleanup resources
     */
    dispose(): void {
        this.clear();
    }

    /**
     * Create service instance based on registration type
     */
    private createInstance<T>(registration: ServiceRegistration): T {
        switch (registration.type) {
            case 'singleton':
                return registration.instance as T;

            case 'factory':
                if (!registration.instance) {
                    registration.instance = (registration.value as ServiceFactory<T>)(this);
                }
                return registration.instance;

            case 'transient':
                const Constructor = registration.value as ServiceConstructor<T>;
                return new Constructor(this.createDependencies(Constructor));

            default:
                throw new Error(`Unknown registration type: ${registration.type}`);
        }
    }

    /**
     * Create dependencies object for constructor injection
     */
    private createDependencies(Constructor: ServiceConstructor<any>): any {
        // For now, return the container itself for manual resolution
        // This can be enhanced with automatic parameter injection in the future
        return {
            container: this,
            resolve: <T>(token: ServiceToken<T>) => this.resolve(token)
        };
    }

    /**
     * Convert service token to string for error messages
     */
    private tokenToString(token: ServiceToken): string {
        if (typeof token === 'string') {
            return token;
        }
        if (typeof token === 'symbol') {
            return token.toString();
        }
        if (typeof token === 'function') {
            return token.name || 'Anonymous';
        }
        return String(token);
    }

    /**
     * Get registration details for debugging
     */
    getRegistrations(): Map<string, { type: string; hasInstance: boolean }> {
        const result = new Map<string, { type: string; hasInstance: boolean }>();
        
        for (const [token, registration] of this.services.entries()) {
            result.set(this.tokenToString(token), {
                type: registration.type,
                hasInstance: !!registration.instance
            });
        }
        
        return result;
    }

    /**
     * Register multiple services from configuration
     */
    registerServices(services: ServiceRegistrationConfig[]): void {
        for (const config of services) {
            switch (config.type) {
                case 'singleton':
                    this.registerSingleton(config.token, config.value);
                    break;
                case 'factory':
                    this.registerFactory(config.token, config.value);
                    break;
                case 'transient':
                    this.registerTransient(config.token, config.value);
                    break;
                default:
                    throw new Error(`Unknown service registration type: ${(config as any).type}`);
            }
        }
    }
}


/**
 * Create a new service container with default configuration
 */
export function createServiceContainer(options?: ServiceContainerOptions): IServiceContainer {
    return new ServiceContainer(options);
}

/**
 * Global service container instance (optional singleton pattern)
 */
let globalContainer: IServiceContainer | undefined;

/**
 * Get or create global service container
 */
export function getGlobalContainer(): IServiceContainer {
    if (!globalContainer) {
        globalContainer = createServiceContainer();
    }
    return globalContainer;
}

/**
 * Set global service container
 */
export function setGlobalContainer(container: IServiceContainer): void {
    globalContainer = container;
}

/**
 * Clear global service container
 */
export function clearGlobalContainer(): void {
    if (globalContainer) {
        globalContainer.dispose();
        globalContainer = undefined;
    }
}