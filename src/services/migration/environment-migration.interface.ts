// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment Migration Service Interface
 *
 * Handles migration of environments from legacy format to new format:
 * - (#415: a new environment's default headers come from its Standard System now)
 * - Sets `configVersion: 2`
 *
 * GitHub Issues #113 and #126
 */

import { EnvironmentConfig } from '../../environmentManager';

/**
 * Current configuration version
 * Version 1: Legacy format with currentOrg and OrganizationHeaderService
 * Version 2: New format with variables.org and environment-level headers
 */
export const CURRENT_CONFIG_VERSION = 2;


/**
 * Result of migration detection
 */
export interface MigrationDetectionResult {
    /** Environments that need migration */
    environmentsRequiringMigration: EnvironmentConfig[];
    /** Total count of environments */
    totalEnvironments: number;
    /** Whether migration is required */
    migrationRequired: boolean;
}

/**
 * Result of a single environment migration
 */
export interface EnvironmentMigrationResult {
    /** Environment ID */
    environmentId: string;
    /** Whether migration was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Changes made during migration */
    changes: string[];
}

/**
 * Result of migrating all environments
 */
export interface MigrationResult {
    /** Number of environments successfully migrated */
    migratedCount: number;
    /** Number of environments that failed migration */
    failedCount: number;
    /** Number of environments skipped (already migrated) */
    skippedCount: number;
    /** Individual migration results */
    results: EnvironmentMigrationResult[];
    /** Overall success status */
    success: boolean;
}

/**
 * Environment Migration Service interface
 */
export interface IEnvironmentMigrationService {
    /**
     * Detect environments that need migration
     */
    detectMigrationRequired(): Promise<MigrationDetectionResult>;

    /**
     * Check if a specific environment needs migration
     */
    needsMigration(environment: EnvironmentConfig): boolean;

    /**
     * Migrate a single environment
     */
    migrateEnvironment(environment: EnvironmentConfig): Promise<EnvironmentMigrationResult>;

    /**
     * Migrate all environments that need migration
     */
    migrateAllEnvironments(): Promise<MigrationResult>;


    /**
     * Get migration status summary
     */
    getMigrationStatus(): Promise<{
        totalEnvironments: number;
        migratedCount: number;
        pendingCount: number;
    }>;
}
