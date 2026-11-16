// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Management Service Registry
 *
 * Following Architecture.md - Service Registration patterns
 * Configures and registers data management services (import/export, migrations, etc.)
 */

import { IServiceContainer, ServiceTokens } from './service-container.interface';
import { CoreServiceTokens } from './core-services-registry';
import { ImportExportService } from '../services/import-export/import-export.service';
import { VsCodeFileSink } from '../services/io/vscode-file-sink';
import { IImportExportService } from '../services/import-export/import-export.service.interface';
import { IExtensionDiagnosticLogger } from '../services/logging/extension-diagnostic-logger.interface';
import { SystemManager } from '../systemManager';
import * as vscode from 'vscode';

/**
 * Dependencies required for data management services
 */
export interface DataManagementServiceDependencies {
    extensionContext: vscode.ExtensionContext;
}

/**
 * Register all data management services in the container
 * NOTE: Must be called AFTER registerExecutionServices since it depends on managers
 *
 * @param container - Service container instance
 * @param dependencies - External dependencies
 */
export function registerDataManagementServices(
    container: IServiceContainer,
    dependencies: DataManagementServiceDependencies
): void {
    // Register ImportExportService as a factory
    container.registerFactory(ServiceTokens.ImportExportService, (c) => {
        // Get logger from DI container
        const logger = c.resolve<IExtensionDiagnosticLogger>(CoreServiceTokens.ExtensionDiagnosticLogger);

        // Resolve dependencies from container
        const endpointManager = c.resolve(ServiceTokens.EndpointManager);
        const environmentManager = c.resolve(ServiceTokens.EnvironmentManager);

        // TODO: Add ConsoleSettingsService when available
        const consoleSettingsService = undefined;

        // Issue #290: Systems travel by name in exports; import creates missing ones.
        const systemManager = c.isRegistered(ServiceTokens.SystemManager)
            ? c.resolve<SystemManager>(ServiceTokens.SystemManager)
            : undefined;

        logger.debug('[DataManagementRegistry] Registering ImportExportService');

        // Portability seam (Issue #275): the file sink is composed here so eject
        // can swap VsCodeFileSink for a browser-download sink without touching
        // the export logic.
        return new ImportExportService(
            endpointManager,
            environmentManager,
            consoleSettingsService,
            dependencies.extensionContext,
            logger,
            new VsCodeFileSink(),
            systemManager
        );
    });

    // Future: Add other data management services here
    // - DataMigrationService
    // - BackupService
    // - etc.
}
