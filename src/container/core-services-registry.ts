// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { IServiceContainer } from './service-container.interface';

// Import core foundation services
import { TemplateEngine } from '../services/template-engine/template-engine.service';
import { ITemplateEngine } from '../services/template-engine/template-engine.interface';
import { FileAccessService } from '../services/file-access/file-access.service';
import { IFileAccessService } from '../services/file-access/file-access.interface';
import { CSVFileService } from '../services/csv-file/csv-file.service';
import { ICSVFileService } from '../services/csv-file/csv-file.interface';
import { TransactionCreator } from '../services/transaction-creator/transaction-creator.service';
import { ITransactionCreator } from '../services/transaction-creator/transaction-creator.interface';
import { ExecutionLoggingService } from '../services/logging/execution-logging.service';
import { IExecutionLoggingService } from '../services/logging/execution-logging.interface';
import { ExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.service';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { DataTypeDetectionService } from '../services/data-type-detection/data-type-detection.service';
import { IDataTypeDetectionService } from '../services/data-type-detection/data-type-detection.interface';
import { DataTransformationService } from '../services/data-transformation/data-transformation.service';
import { IDataTransformationService } from '../services/data-transformation/data-transformation.interface';
import { FormatConverterService } from '../services/format-converter/format-converter.service';
import { IFormatConverterService } from '../services/format-converter/format-converter.interface';
// Note: BatchPreparationService imports moved to execution-service-registry.ts

// Platform interfaces and services
import { IFileSystemService } from '../platform/interfaces/filesystem.interface';
import { VSCodeFileSystemService } from '../platform/services/filesystem.service';
import { IOutputServiceFactory } from '../platform/interfaces/output.interface';
import { VSCodeOutputServiceFactory, MockOutputServiceFactory } from '../platform/services/output.service';

/**
 * Core service tokens for dependency injection
 */
export const CoreServiceTokens = {
  TemplateEngine: Symbol('TemplateEngine'),
  FileAccessService: Symbol('FileAccessService'),
  FileSystemService: Symbol('FileSystemService'),
  OutputServiceFactory: Symbol('OutputServiceFactory'),
  CSVFileService: Symbol('CSVFileService'),
  TransactionCreator: Symbol('TransactionCreator'),
  ExecutionLoggingService: Symbol('ExecutionLoggingService'),
  ExtensionDiagnosticLogger: Symbol('ExtensionDiagnosticLogger'),
  DataTypeDetectionService: Symbol('DataTypeDetectionService'),
  DataTransformationService: Symbol('DataTransformationService'),
  FormatConverterService: Symbol('FormatConverterService')
  // Note: BatchPreparationService moved to execution-service-registry.ts
} as const;

/**
 * Register all core foundation services with the service container
 */
export function registerCoreServices(
  container: IServiceContainer,
  context: {
    vscodeAPI: typeof vscode;
    extensionContext: vscode.ExtensionContext;
  }
): void {
  const { vscodeAPI, extensionContext } = context;

  // Register platform services first
  container.registerFactory(CoreServiceTokens.FileSystemService, () => {
    return new VSCodeFileSystemService(vscodeAPI);
  });

  // Register output service factory (handles both VS Code and mock environments)
  container.registerFactory(CoreServiceTokens.OutputServiceFactory, () => {
    // Use mock factory if VS Code API is not available (e.g., during testing)
    if (typeof vscodeAPI === 'undefined' || !vscodeAPI.window) {
      return new MockOutputServiceFactory();
    }
    return new VSCodeOutputServiceFactory(vscodeAPI);
  });

  // Register template engine
  container.registerFactory(CoreServiceTokens.TemplateEngine, () => {
    return new TemplateEngine();
  });

  // Register file access service with abstracted dependencies
  container.registerFactory(CoreServiceTokens.FileAccessService, (container: IServiceContainer) => {
    const outputServiceFactory = container.resolve<IOutputServiceFactory>(CoreServiceTokens.OutputServiceFactory);
    const outputService = outputServiceFactory.createOutputService('DBMN Execution Logs');
    
    // Get workspace root, fallback to extension storage if no workspace
    const workspaceRoot = vscodeAPI?.workspace?.workspaceFolders?.[0]?.uri.fsPath || 
                         extensionContext?.storageUri?.fsPath || 
                         '/workspace';
    
    return new FileAccessService({
      fileSystem: container.resolve<IFileSystemService>(CoreServiceTokens.FileSystemService),
      outputService: outputService,
      workspaceRoot: workspaceRoot
    });
  });

  // Register CSV file service for batch processing
  container.registerFactory(CoreServiceTokens.CSVFileService, () => {
    return new CSVFileService(extensionContext);
  });

  // Register extension diagnostic logger for non-execution related logs
  container.registerFactory(CoreServiceTokens.ExtensionDiagnosticLogger, () => {
    const logger = new ExtensionDiagnosticLogger('DBMN Extension Diagnostics');
    // Register professionally via LoggerRegistry
    import('../utils/logger-registry').then(({ LoggerRegistry }) => {
      LoggerRegistry.setDiagnosticLogger(logger);
    }).catch(() => {
      console.warn('LoggerRegistry import failed for diagnostic logger registration');
    });
    return logger;
  });

  // Note: TransactionCreator registration is deferred to execution service registry
  // because it depends on ExecutionMetadataService and ExecutionFileService
  // which are registered in execution-service-registry.ts

  // Note: BatchPreparationService registration moved to execution-service-registry.ts
  // to resolve dependency order issues (it depends on ExecutionMetadataService)

  // Register data type detection service
  container.registerFactory(CoreServiceTokens.DataTypeDetectionService, () => {
    return new DataTypeDetectionService();
  });

  // Register data transformation service
  container.registerFactory(CoreServiceTokens.DataTransformationService, () => {
    return new DataTransformationService();
  });

  // Register format converter service with dependencies
  container.registerFactory(CoreServiceTokens.FormatConverterService, (container: IServiceContainer) => {
    const dataTypeDetectionService = container.resolve<IDataTypeDetectionService>(CoreServiceTokens.DataTypeDetectionService);
    const dataTransformationService = container.resolve<IDataTransformationService>(CoreServiceTokens.DataTransformationService);
    
    return new FormatConverterService(dataTypeDetectionService, dataTransformationService);
  });

  // Core services registered successfully
}