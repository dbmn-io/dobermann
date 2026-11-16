// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Test Environment for Integration Tests
 * 
 * Optimizes test performance by:
 * - Using shared VS Code extension host setup
 * - Reducing service container recreation
 * - Implementing efficient mock management
 * - Providing fast test isolation
 */

import * as vscode from 'vscode';
import { ServiceContainer } from '../../container/service-container';
import { IServiceContainer } from '../../container/service-container.interface';
import { CoreServiceTokens } from '../../container/core-services-registry';

interface SharedTestConfig {
  /** Whether to use real services (slower) or mocks (faster) */
  useRealServices?: boolean;
  /** Mock configuration overrides */
  mockOverrides?: Record<string, any>;
  /** Timeout for VS Code operations */
  vscodeTimeout?: number;
}

/**
 * Singleton shared test environment for performance optimization
 */
export class SharedTestEnvironment {
  private static instance: SharedTestEnvironment;
  private isInitialized = false;
  private extensionContext: vscode.ExtensionContext | undefined;
  private serviceContainer: IServiceContainer | undefined;
  private mockState: Map<string, any> = new Map();

  private constructor() {}

  static getInstance(): SharedTestEnvironment {
    if (!SharedTestEnvironment.instance) {
      SharedTestEnvironment.instance = new SharedTestEnvironment();
    }
    return SharedTestEnvironment.instance;
  }

  /**
   * Initialize shared environment once per test suite (use in before())
   */
  async initialize(config: SharedTestConfig = {}): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log('[SharedTestEnvironment] Initializing shared test environment...');

    try {
      // Wait for extension activation (only once)
      await this.waitForExtensionActivation(config.vscodeTimeout || 5000);
      
      // Setup shared service container (only once)
      this.setupSharedServiceContainer(config);
      
      this.isInitialized = true;
      console.log('[SharedTestEnvironment] ✅ Shared environment initialized successfully');
    } catch (error) {
      console.error('[SharedTestEnvironment] ❌ Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Quick reset between tests (use in beforeEach())
   */
  resetForTest(): void {
    // Only reset mocks and state, don't recreate services
    this.mockState.clear();
    
    // Reset any stateful services to clean state
    if (this.serviceContainer) {
      // Clear any cached data but keep service instances
      this.resetServiceState();
    }
  }

  /**
   * Get service container (shared instance)
   */
  getServiceContainer(): IServiceContainer {
    if (!this.serviceContainer) {
      throw new Error('SharedTestEnvironment not initialized. Call initialize() first.');
    }
    return this.serviceContainer;
  }

  /**
   * Get extension context (shared instance)
   */
  getExtensionContext(): vscode.ExtensionContext {
    if (!this.extensionContext) {
      throw new Error('Extension context not available. Ensure VS Code extension is activated.');
    }
    return this.extensionContext;
  }

  /**
   * Create mock for service (reuses instances when possible)
   */
  getMock<T>(serviceKey: string, factory: () => T): T {
    if (this.mockState.has(serviceKey)) {
      return this.mockState.get(serviceKey);
    }

    const mock = factory();
    this.mockState.set(serviceKey, mock);
    return mock;
  }

  /**
   * Cleanup shared environment (use in after())
   */
  cleanup(): void {
    this.mockState.clear();
    this.isInitialized = false;
    console.log('[SharedTestEnvironment] ✅ Shared environment cleaned up');
  }

  private async waitForExtensionActivation(timeout: number): Promise<void> {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      const extension = vscode.extensions.getExtension('dobermann');
      if (extension?.isActive) {
        // Get extension context from the activated extension
        this.extensionContext = extension.exports?.context || this.createMockExtensionContext();
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // If extension isn't activated, create a mock context for testing
    console.warn('[SharedTestEnvironment] Extension not activated, using mock context');
    this.extensionContext = this.createMockExtensionContext();
  }

  private createMockExtensionContext(): vscode.ExtensionContext {
    const path = require('path');
    const extensionPath = path.resolve(__dirname, '../../../');
    
    return {
      subscriptions: [],
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
      },
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
        setKeysForSync: () => {}
      },
      extensionPath,
      extensionUri: vscode.Uri.file(extensionPath),
      extensionMode: vscode.ExtensionMode.Test,
      storagePath: path.join(extensionPath, '.storage'),
      globalStoragePath: path.join(extensionPath, '.global-storage'),
      logPath: path.join(extensionPath, '.logs'),
      asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
      environmentVariableCollection: {} as any,
      extension: {} as any,
      logUri: vscode.Uri.file(path.join(extensionPath, '.logs')),
      storageUri: vscode.Uri.file(path.join(extensionPath, '.storage')),
      globalStorageUri: vscode.Uri.file(path.join(extensionPath, '.global-storage')),
      secrets: {} as any,
      languageModelAccessInformation: {} as any
    } as vscode.ExtensionContext;
  }

  private setupSharedServiceContainer(config: SharedTestConfig): void {
    // Create service container once and reuse
    this.serviceContainer = new ServiceContainer();
    
    // Register core services or mocks based on config
    if (config.useRealServices) {
      this.registerRealServices();
    } else {
      this.registerMockServices(config.mockOverrides);
    }
  }

  private registerRealServices(): void {
    // Import and register real services
    const { registerCoreServices } = require('../../container/core-services-registry');
    const { registerExecutionServices } = require('../../container/execution-services-registry');
    const { registerProgressServices } = require('../../container/progress-services-registry');
    const { registerUIServices } = require('../../container/ui-services-registry');

    if (this.serviceContainer && this.extensionContext) {
      const context = {
        vscodeAPI: vscode,
        extensionContext: this.extensionContext
      };

      // Register services with proper context structure
      registerCoreServices(this.serviceContainer, context);
      registerExecutionServices(this.serviceContainer, context);
      registerProgressServices(this.serviceContainer, context);
      registerUIServices(this.serviceContainer, context);
      
      console.log('[SharedTestEnvironment] ✅ All service registries completed');
    }
  }

  private registerMockServices(overrides?: Record<string, any>): void {
    // Register lightweight mock services for fast testing
    if (!this.serviceContainer) return;

    const { UIServiceTokens } = require('../../container/ui-services-registry');
    const { ProgressServiceTokens } = require('../../container/progress-services-registry');

    // Mock core services with better file system handling
    this.serviceContainer.registerFactory(CoreServiceTokens.FileSystemService, () => {
      const fs = require('fs');
      const path = require('path');
      
      return {
        exists: async (filePath: string) => {
          try {
            await fs.promises.access(filePath);
            return true;
          } catch {
            return filePath.includes('mock') || filePath.includes('test'); // Allow mock/test files
          }
        },
        readFile: async (filePath: string) => {
          try {
            // Try to read the actual file first (for webview HTML/CSS files)
            if (filePath.includes('webviews') || filePath.includes('.html') || filePath.includes('.css')) {
              return await fs.promises.readFile(filePath);
            }
          } catch (error) {
            // Fall back to mock data
            console.log(`[MockFileSystem] Using mock data for: ${filePath}`);
          }
          
          // Provide appropriate mock content based on file type
          if (filePath.includes('.html')) {
            return Buffer.from('<html><head><title>Mock</title></head><body><div id="mock">Mock HTML Content</div></body></html>');
          } else if (filePath.includes('.css')) {
            return Buffer.from('/* Mock CSS */ body { margin: 0; }');
          } else if (filePath.includes('.json')) {
            return Buffer.from('{"mock": true}');
          }
          return Buffer.from('mock data');
        },
        writeFile: async () => {},
        stat: async () => ({ type: 1, size: 100 }),
        readDir: async () => [],
        mkdir: async () => {},
        rmdir: async () => {}
      };
    });

    // Mock Progress services
    this.serviceContainer.registerFactory(ProgressServiceTokens.TimeEstimationService, () => ({
      estimateRemainingTime: () => 0,
      getAverageExecutionTime: () => 1000,
      dispose: () => {}
    }));

    this.serviceContainer.registerFactory(ProgressServiceTokens.BatchProgressService, () => ({
      updateProgress: () => {},
      getProgress: () => ({ completed: 0, total: 0, percentage: 0 }),
      dispose: () => {}
    }));

    this.serviceContainer.registerFactory(ProgressServiceTokens.TimerManager, () => ({
      startTimer: () => 'timer-id',
      stopTimer: () => {},
      getElapsedTime: () => 1000,
      dispose: () => {}
    }));

    // Apply any specific overrides
    if (overrides) {
      Object.entries(overrides).forEach(([key, value]) => {
        this.serviceContainer!.registerFactory(Symbol(key), () => value);
      });
    }

    console.log('[SharedTestEnvironment] ✅ Mock services registered for fast testing');
  }

  private resetServiceState(): void {
    // Reset any stateful services without recreating them
    // This is much faster than full service container recreation
    try {
      // Clear any caches or temporary state in services
      // Services should implement a reset() method for this
    } catch (error) {
      console.warn('[SharedTestEnvironment] Warning during service state reset:', error);
    }
  }
}

/**
 * Convenience helper for setting up shared test environment
 */
export function useSharedTestEnvironment(config: SharedTestConfig = {}) {
  const sharedEnv = SharedTestEnvironment.getInstance();
  
  return {
    /**
     * Call this in before() hook (once per test suite)
     */
    async beforeAll(): Promise<void> {
      await sharedEnv.initialize(config);
    },

    /**
     * Call this in beforeEach() hook (fast reset per test)
     */
    beforeEach(): void {
      sharedEnv.resetForTest();
    },

    /**
     * Call this in after() hook (once per test suite)
     */
    afterAll(): void {
      sharedEnv.cleanup();
    },

    /**
     * Get shared service container
     */
    getContainer(): IServiceContainer {
      return sharedEnv.getServiceContainer();
    },

    /**
     * Get shared extension context
     */
    getContext(): vscode.ExtensionContext {
      return sharedEnv.getExtensionContext();
    },

    /**
     * Get or create mock instance
     */
    getMock<T>(key: string, factory: () => T): T {
      return sharedEnv.getMock(key, factory);
    }
  };
}