// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment Migration Service Implementation
 *
 * Migrates environments from legacy format (v1) to new format (v2):
 * - (#415: a new environment's default headers come from its Standard System now)
 * - Sets `configVersion: 2`
 *
 * GitHub Issues #113 and #126
 */

import { EnvironmentManager, EnvironmentConfig } from '../../environmentManager';
import { HeaderConfig } from '../../data-loading/zod-schemas';
import {
    IEnvironmentMigrationService,
    MigrationDetectionResult,
    EnvironmentMigrationResult,
    MigrationResult,
    CURRENT_CONFIG_VERSION
} from './environment-migration.interface';
import { clientAuthFor, isClientAuth } from '../oauth/client-auth';

/**
 * #424: until 0.4.0 an environment with an organisation chosen (`variables.org`) had these four
 * headers added to every request, each carrying the organisation, unless the environment or the
 * endpoint set one itself. 0.4.0 adds nothing: an environment sends the headers it lists. So an
 * environment from 0.3.x lists them, as `{{ENV:org}}`, and keeps sending what it sent.
 */
export const LEGACY_ORG_HEADERS = ['Organization', 'SelectedOrganization', 'Location', 'SelectedLocation'] as const;

/**
 * An environment from 0.3.x with an organisation: `org` has a value and no settings. Every
 * environment 0.4.0 has touched has settings for `org` if it has one (a Standard System gives
 * them at creation, the editor and the header write them), and this upgrade writes them too,
 * so it runs once.
 */
export function needsOrgHeaders(environment: Pick<EnvironmentConfig, 'variables' | 'variableSettings'>): boolean {
    return !!environment.variables?.org?.trim() && !environment.variableSettings?.org;
}

/**
 * The environment's headers with each of LEGACY_ORG_HEADERS it doesn't already list (by name,
 * any case, on or off: its own row always won), and `org` in the Hub header with its value as
 * its one option, as 0.3.x's organisation picker showed it.
 */
export function withOrgHeaders(environment: Pick<EnvironmentConfig, 'variables' | 'variableSettings' | 'headers'>): {
    headers: Record<string, HeaderConfig>;
    variableSettings: NonNullable<EnvironmentConfig['variableSettings']>;
    added: string[];
} {
    const headers: Record<string, HeaderConfig> = { ...(environment.headers ?? {}) };
    const listed = new Set(Object.keys(headers).map(name => name.toLowerCase()));
    const added = LEGACY_ORG_HEADERS.filter(name => !listed.has(name.toLowerCase()));
    for (const name of added) headers[name] = { value: '{{ENV:org}}', enabled: true };
    const org = environment.variables!.org!.trim();
    return {
        headers,
        variableSettings: { ...(environment.variableSettings ?? {}), org: { showInHeader: true, options: [org] } },
        added: [...added]
    };
}

export class EnvironmentMigrationService implements IEnvironmentMigrationService {
    constructor(
        private environmentManager: EnvironmentManager
    ) {}

    /**
     * Detect environments that need migration
     */
    async detectMigrationRequired(): Promise<MigrationDetectionResult> {
        const environments = await this.environmentManager.getAllEnvironments();
        const environmentsRequiringMigration = environments.filter(env => this.needsMigration(env));

        return {
            environmentsRequiringMigration,
            totalEnvironments: environments.length,
            migrationRequired: environmentsRequiringMigration.length > 0
        };
    }

    /**
     * Check if a specific environment needs migration
     */
    needsMigration(environment: EnvironmentConfig): boolean {
        // #415: an OAuth environment saved before client authentication was a setting
        if (this.needsClientAuth(environment)) {
            return true;
        }

        // #424: an organisation chosen in 0.3.x, whose headers DBMN used to add by itself
        if (needsOrgHeaders(environment)) {
            return true;
        }

        // Already migrated
        if (environment.configVersion === CURRENT_CONFIG_VERSION) {
            return false;
        }

        // No version set but has data - needs version stamp
        if (environment.configVersion === undefined) {
            return true;
        }

        return false;
    }

    /**
     * Migrate a single environment
     */
    async migrateEnvironment(environment: EnvironmentConfig): Promise<EnvironmentMigrationResult> {
        const changes: string[] = [];

        try {
            // Start with current environment config
            const updatedEnv: EnvironmentConfig = { ...environment };

            // 1. (#424: the old currentOrg field is gone; the org is an ordinary variable.)
            // 2. (#415: default headers are the Standard System's, given at creation; no URL rule here)

            // 3. Set config version
            if (updatedEnv.configVersion !== CURRENT_CONFIG_VERSION) {
                updatedEnv.configVersion = CURRENT_CONFIG_VERSION;
                changes.push(`Set configVersion to ${CURRENT_CONFIG_VERSION}`);
            }

            // 4. #415: the client authentication this environment has been using becomes its own
            // setting, so the rule that chose it can leave the code (phase 3)
            const oauthConfig = this.needsClientAuth(environment) && environment.oauthConfig
                ? { ...environment.oauthConfig, clientAuth: clientAuthFor(environment.oauthConfig) }
                : undefined;
            if (oauthConfig) {
                updatedEnv.oauthConfig = oauthConfig;
                changes.push(`Set OAuth client authentication to ${oauthConfig.clientAuth}`);
            }

            // 5. #424: the organisation headers 0.3.x added to every request by itself become the
            // environment's own, so an upgrade sends what it sent before
            const org = needsOrgHeaders(environment) ? withOrgHeaders(environment) : undefined;
            if (org) {
                updatedEnv.headers = org.headers;
                updatedEnv.variableSettings = org.variableSettings;
                if (org.added.length > 0) changes.push(`Added ${org.added.join(', ')}: {{ENV:org}}`);
                changes.push('The org variable is in the Hub header');
            }

            // Save the updated environment
            if (changes.length > 0) {
                await this.environmentManager.updateEnvironment(environment.id, {
                    variables: updatedEnv.variables,
                    headers: updatedEnv.headers,
                    configVersion: updatedEnv.configVersion,
                    ...(oauthConfig ? { oauthConfig } : {}),
                    ...(org ? { variableSettings: updatedEnv.variableSettings } : {})
                });
            }

            return {
                environmentId: environment.id,
                success: true,
                changes
            };
        } catch (error) {
            return {
                environmentId: environment.id,
                success: false,
                error: error instanceof Error ? error.message : String(error),
                changes
            };
        }
    }

    /**
     * Migrate all environments that need migration
     */
    async migrateAllEnvironments(): Promise<MigrationResult> {
        const environments = await this.environmentManager.getAllEnvironments();
        const results: EnvironmentMigrationResult[] = [];

        let migratedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        for (const env of environments) {
            if (!this.needsMigration(env)) {
                skippedCount++;
                results.push({
                    environmentId: env.id,
                    success: true,
                    changes: ['Already migrated - skipped']
                });
                continue;
            }

            const result = await this.migrateEnvironment(env);
            results.push(result);

            if (result.success) {
                migratedCount++;
            } else {
                failedCount++;
            }
        }

        return {
            migratedCount,
            failedCount,
            skippedCount,
            results,
            success: failedCount === 0
        };
    }

    /** #415: OAuth, with a configuration that doesn't yet say how the client authenticates. */
    private needsClientAuth(environment: EnvironmentConfig): boolean {
        return environment.authMethod === 'oauth' && !!environment.oauthConfig && !isClientAuth(environment.oauthConfig.clientAuth);
    }

    /**
     * Get migration status summary
     */
    async getMigrationStatus(): Promise<{
        totalEnvironments: number;
        migratedCount: number;
        pendingCount: number;
    }> {
        const environments = await this.environmentManager.getAllEnvironments();
        const migratedCount = environments.filter(env =>
            env.configVersion === CURRENT_CONFIG_VERSION
        ).length;

        return {
            totalEnvironments: environments.length,
            migratedCount,
            pendingCount: environments.length - migratedCount
        };
    }
}
