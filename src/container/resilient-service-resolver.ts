// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Resilient Service Resolver for Integration Tests
 * 
 * Reduces service registration retry loops by providing:
 * - Optional service resolution (no errors for missing services)
 * - Service availability checking
 * - Graceful fallback patterns
 * - Reduced logging noise during testing
 */

import { IServiceContainer, ServiceToken } from './service-container.interface';

export interface ResilientResolverOptions {
  /** Log warnings when services are not available (default: false for tests) */
  logWarnings?: boolean;
  /** Maximum retry attempts before giving up (default: 0 for tests) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 0 for tests) */
  retryDelay?: number;
}

export class ResilientServiceResolver {
  private container: IServiceContainer;
  private options: Required<ResilientResolverOptions>;

  constructor(container: IServiceContainer, options: ResilientResolverOptions = {}) {
    this.container = container;
    this.options = {
      logWarnings: false,
      maxRetries: 0,
      retryDelay: 0,
      ...options
    };
  }

  /**
   * Try to resolve a service, return undefined if not available
   */
  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    try {
      return this.container.resolve(token);
    } catch (error) {
      if (this.options.logWarnings) {
        console.warn(`Service not available: ${this.tokenToString(token)}`);
      }
      return undefined;
    }
  }

  /**
   * Resolve service with retries and fallback
   */
  async resolveWithFallback<T>(
    token: ServiceToken<T>, 
    fallback?: () => T
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const service = this.tryResolve(token);
      if (service) {
        return service;
      }

      if (attempt < this.options.maxRetries) {
        await this.delay(this.options.retryDelay);
      }
    }

    if (fallback) {
      try {
        return fallback();
      } catch (error) {
        if (this.options.logWarnings) {
          console.warn(`Fallback failed for ${this.tokenToString(token)}:`, error);
        }
      }
    }

    return undefined;
  }

  /**
   * Check if service is available without throwing errors
   */
  isServiceAvailable<T>(token: ServiceToken<T>): boolean {
    return this.container.isRegistered(token);
  }

  /**
   * Get multiple services with graceful handling of missing ones
   */
  resolveMany<T>(tokens: ServiceToken<T>[]): (T | undefined)[] {
    return tokens.map(token => this.tryResolve(token));
  }

  /**
   * Resolve service with timeout to prevent hanging
   */
  async resolveWithTimeout<T>(
    token: ServiceToken<T>, 
    timeoutMs: number = 1000
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.options.logWarnings) {
          console.warn(`Service resolution timeout: ${this.tokenToString(token)}`);
        }
        resolve(undefined);
      }, timeoutMs);

      try {
        const service = this.container.resolve(token);
        clearTimeout(timeout);
        resolve(service);
      } catch (error) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private tokenToString(token: ServiceToken<any>): string {
    if (typeof token === 'symbol') {
      return token.toString();
    }
    return String(token);
  }
}

/**
 * Helper for creating resilient service resolution in tests
 */
export function createTestServiceResolver(container: IServiceContainer): ResilientServiceResolver {
  return new ResilientServiceResolver(container, {
    logWarnings: false,  // Quiet during tests
    maxRetries: 0,       // No retries in tests for fast failure
    retryDelay: 0        // No delays in tests
  });
}

/**
 * Helper for creating resilient service resolution in production
 */
export function createProductionServiceResolver(container: IServiceContainer): ResilientServiceResolver {
  return new ResilientServiceResolver(container, {
    logWarnings: true,   // Log warnings in production
    maxRetries: 3,       // Allow retries in production
    retryDelay: 100      // Small delay between retries
  });
}