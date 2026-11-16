// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Services Registry (GitHub Issue #208)
 *
 * DI registration for DBMN authentication and telemetry services.
 * Following Architecture.md: service registry pattern from core-services-registry.ts.
 */

import * as vscode from 'vscode';
import { IServiceContainer } from './service-container.interface';
import { DbmnAuthService } from '../services/dbmn-auth/dbmn-auth.service';
import { DbmnTelemetryService } from '../services/dbmn-auth/dbmn-telemetry.service';

/**
 * DBMN service tokens for dependency injection
 */
export const DbmnServiceTokens = {
    DbmnAuthService: Symbol('DbmnAuthService'),
    DbmnTelemetry: Symbol('DbmnTelemetry')
} as const;

/**
 * Register all DBMN services with the service container.
 * Called during extension activation, BEFORE Dobermann initialization.
 */
export function registerDbmnServices(
    container: IServiceContainer,
    context: {
        extensionContext: vscode.ExtensionContext;
    }
): void {
    const { extensionContext } = context;

    // Register auth service (depends on extension context for SecretStorage/globalState)
    container.registerFactory(DbmnServiceTokens.DbmnAuthService, () => {
        return new DbmnAuthService(extensionContext);
    });

    // Register telemetry service
    container.registerFactory(DbmnServiceTokens.DbmnTelemetry, () => {
        return new DbmnTelemetryService(extensionContext);
    });
}
