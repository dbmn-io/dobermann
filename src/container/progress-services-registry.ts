// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IServiceContainer } from './service-container.interface';

// Import progress tracking services
import { TimeEstimationService } from '../services/time-estimation/time-estimation.service';
import { ITimeEstimationService } from '../services/time-estimation/time-estimation.interface';
import { BatchProgressService } from '../services/batch-progress/batch-progress.service';
import { IBatchProgressService } from '../services/batch-progress/batch-progress.interface';
import { TimerManagerService } from '../services/timer-manager/timer-manager.service';
import { ITimerManager } from '../services/timer-manager/timer-manager.interface';
import { BatchStatusService } from '../services/batch-status/batch-status.service';
import { IBatchStatusService } from '../services/batch-status/batch-status.interface';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { CoreServiceTokens } from './core-services-registry';

/**
 * Progress service tokens for dependency injection
 */
export const ProgressServiceTokens = {
  TimeEstimationService: Symbol('TimeEstimationService'),
  BatchProgressService: Symbol('BatchProgressService'),
  TimerManager: Symbol('TimerManager'),
  BatchStatusService: Symbol('BatchStatusService')
} as const;

/**
 * Register all progress tracking services with the service container
 * Following the Architecture.md service isolation patterns
 */
export function registerProgressServices(
  container: IServiceContainer,
  context: {
    vscodeAPI: typeof vscode;
    extensionContext: vscode.ExtensionContext;
  }
): void {
  const { extensionContext } = context;

  // Register TimeEstimationService
  container.registerFactory(ProgressServiceTokens.TimeEstimationService, () => {
    return new TimeEstimationService(extensionContext);
  });

  // Register BatchProgressService (depends on TimeEstimationService)
  container.registerFactory(ProgressServiceTokens.BatchProgressService, (container: IServiceContainer) => {
    return new BatchProgressService(
      extensionContext,
      container.resolve<ITimeEstimationService>(ProgressServiceTokens.TimeEstimationService)
    );
  });

  // Register TimerManagerService with logger dependency
  container.registerFactory(ProgressServiceTokens.TimerManager, (container) => {
    const logger = container.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);
    return new TimerManagerService(logger);
  });

  // Register BatchStatusService (standalone service for status formatting)
  container.registerFactory(ProgressServiceTokens.BatchStatusService, () => {
    return new BatchStatusService();
  });

  // All progress tracking services registered successfully
}