// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IServiceContainer, ServiceTokens } from './service-container.interface';
import { IExecutionMetadataService } from '../services/execution/execution-metadata.interface';

// Import UI-focused services
import { StateBroadcaster } from '../services/state-broadcaster/state-broadcaster.service';
import { IStateBroadcaster } from '../services/state-broadcaster/state-broadcaster.interface';
import { EnvironmentStatusService } from '../services/environment/environment-status.service';
import { IEnvironmentStatusService } from '../services/environment/environment-status.service';
import { IOAuthService } from '../services/oauth/oauth.interface';
import { TokenExpiryService } from '../services/token/token-expiry.service';
import { EnvironmentAuthGateService } from '../services/environment/environment-auth-gate.service';
import { ITokenExpiryService } from '../services/token/token-expiry.service';
import { ProgressManagerService } from '../services/progress-manager/progress-manager.service';
import { IProgressManager } from '../services/progress-manager/progress-manager.interface';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { CoreServiceTokens } from './core-services-registry';
import { WebviewRegistryService } from '../services/webview/webview-registry.service';
import { IWebviewRegistryService } from '../services/webview/webview-registry.interface';
import { VSCodeToastService } from '../services/notifications/vscode-toast.service';
import { IToastService } from '../services/notifications/toast.interface';

// Platform interfaces
import { IFileSystemService } from '../platform/interfaces/filesystem.interface';

/**
 * UI service tokens for dependency injection
 */
export const UIServiceTokens = {
StateBroadcaster: Symbol('StateBroadcaster'),
  ProgressManager: Symbol('ProgressManager'),
  EnvironmentStatusService: Symbol('EnvironmentStatusService'),
  TokenExpiryService: Symbol('TokenExpiryService'),
  WebviewRegistryService: Symbol('WebviewRegistryService'),
  // GitHub Issue #263: portable toast layer — first step of the VS Code eject
  ToastService: Symbol('ToastService'),
  // GitHub Issue #311: one credential check for Run, Resume and Reprocess
  EnvironmentAuthGate: Symbol('EnvironmentAuthGate')
} as const;

/**
 * Register all UI services with the service container
 */
export function registerUIServices(
  container: IServiceContainer,
  context: {
    vscodeAPI: typeof vscode;
    extensionContext: vscode.ExtensionContext;
    executionService?: any;
    environmentManager?: any;
  }
): void {
  const { vscodeAPI, extensionContext, executionService, environmentManager } = context;

  // Register core UI services
  container.registerFactory(UIServiceTokens.StateBroadcaster, (container: IServiceContainer) => {
    // Inject logger from DI container
    const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

    return new StateBroadcaster();
  });

  container.registerFactory(UIServiceTokens.ProgressManager, (container: IServiceContainer) => {
    // Use resilient service resolution to avoid retry loops
    const { createTestServiceResolver } = require('./resilient-service-resolver');
    const resolver = createTestServiceResolver(container);

    let executionMetadataService: IExecutionMetadataService | undefined;

    // Resolve ExecutionMetadataService for detailed batch logs
    try {
      const { ServiceTokens } = require('./service-container.interface');
      executionMetadataService = resolver.tryResolve(ServiceTokens.ExecutionMetadataService);
    } catch (error) {
      // ExecutionMetadataService not available - continue without it
      console.log('[UIServiceRegistry] ExecutionMetadataService not available for ProgressManager');
      executionMetadataService = undefined;
    }

    // Inject logger from DI container
    const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

    return new ProgressManagerService(extensionContext, logger, executionMetadataService);
  });

  // Register Token Expiry Service
  container.registerFactory(UIServiceTokens.TokenExpiryService, (container: IServiceContainer) => {
    return new TokenExpiryService();
  });

  // GitHub Issue #311: Environment auth gate (resolves its collaborators lazily — OAuth is optional)
  container.registerFactory(UIServiceTokens.EnvironmentAuthGate, (container: IServiceContainer) => {
    const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
    return new EnvironmentAuthGateService(container, logger);
  });

  // Register Environment Status Service
  container.registerFactory(UIServiceTokens.EnvironmentStatusService, (container: IServiceContainer) => {
    if (!environmentManager) {
      throw new Error('EnvironmentManager is required for EnvironmentStatusService');
    }
    const tokenExpiryService = container.resolve<ITokenExpiryService>(UIServiceTokens.TokenExpiryService);

    // Resolve OAuth service if available
    let oauthService: IOAuthService | undefined;
    try {
      oauthService = container.resolve<IOAuthService>('IOAuthService'); // Use the same token as registered in extension.ts
    } catch (error) {
      // OAuth service not available - this is fine for JWT-only environments
      oauthService = undefined;
    }

    return new EnvironmentStatusService(
      extensionContext,
      environmentManager,
      tokenExpiryService,
      oauthService
    );
  });

  // Register WebviewRegistry service for centralized duplicate prevention (GitHub Issue #83)
  container.registerFactory(UIServiceTokens.WebviewRegistryService, (container: IServiceContainer) => {
    return new WebviewRegistryService();
  });

  // GitHub Issue #263: portable toast layer. VS Code impl now; web build will swap.
  container.registerFactory(UIServiceTokens.ToastService, (_container: IServiceContainer) => {
    return new VSCodeToastService() as IToastService;
  });

  // All UI services registered successfully
}