// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Zod Validation Schemas for Import/Export
 *
 * Provides runtime validation and TypeScript type inference for
 * import/export package structure.
 *
 * GitHub Issue: #90
 */

import { z } from 'zod';

// ============================================================================
// Export Metadata Schema
// ============================================================================

export const exportMetadataSchema = z.object({
    /** Export format version (e.g., "1.0.0") */
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver format (e.g., 1.0.0)'),

    /** ISO 8601 timestamp */
    exportedAt: z.string().datetime(),

    /** Application name */
    exportedBy: z.string().min(1),

    /** Dobermann extension version (current) */
    dobermannVersion: z.string().optional(),

    /** Active8 extension version (legacy exports) */
    active8Version: z.string().optional(),

    /** Platform (optional) */
    platform: z.string().optional(),

    /** Warnings (optional) */
    warnings: z.array(z.string()).optional()
}).refine(
    (data) => data.dobermannVersion !== undefined || data.active8Version !== undefined,
    { message: 'Either dobermannVersion or active8Version must be present', path: ['dobermannVersion'] }
);

// ============================================================================
// Folder Structure Schema
// ============================================================================

export const folderStructureSchema = z.object({
    version: z.string(),
    endpoints: z.object({
        folders: z.array(z.string())
    }),
    environments: z.object({
        folders: z.array(z.string())
    })
});

// ============================================================================
// Endpoint Schema (Minimal - Full validation done by APIEndpointManager)
// ============================================================================

/**
 * Minimal endpoint schema for import/export validation
 * Full validation is handled by APIEndpointManager
 */
export const endpointConfigSchema = z.object({
    id: z.string().min(1, 'Endpoint ID is required'),
    name: z.string().min(1, 'Endpoint name is required'),
    description: z.string().optional(),
    path: z.string().min(1, 'Endpoint path is required'),
    method: z.string().min(1, 'HTTP method is required'),
    headers: z.record(z.any()).optional(),
    queryParams: z.record(z.any()).optional(),
    body: z.string().optional(),
    bodyWithComments: z.string().optional(),
    folder: z.string().optional(),
    /** #290: exports carry systemName; systemId only appears in pre-#290 exports */
    systemName: z.string().optional(),
    systemId: z.string().optional(),
    sequenceCounter: z.number().optional(),
    dataLoadingConfig: z.any().optional() // Validated by endpoint manager
}).passthrough();

// ============================================================================
// Environment Schema (Minimal - Full validation done by EnvironmentManager)
// ============================================================================

/**
 * Minimal environment schema for import/export validation
 * Full validation is handled by EnvironmentManager
 */
export const environmentConfigSchema = z.object({
    id: z.string().min(1, 'Environment ID is required'),
    name: z.string().min(1, 'Environment name is required'),
    description: z.string().optional(),
    baseUrl: z.string().optional(),
    isActive: z.boolean().optional(),
    createdAt: z.number().optional(),
    lastUsed: z.number().optional(),
    folder: z.string().optional(),
    environmentType: z.string().optional(),
    authMethod: z.enum(['jwt', 'oauth', 'google-service-account', 'dbmn', 'none']).optional(),
    oauthConfig: z.any().optional(), // Validated by environment manager
    googleServiceAccountConfig: z.any().optional(), // Validated by environment manager
    googleServiceAccountScopes: z.array(z.string()).optional(),
    headers: z.record(z.any()).optional(),
    variables: z.record(z.any()).optional(),
    variableSettings: z.record(z.any()).optional(),   // #424
    targetTimezone: z.string().optional(),
    configVersion: z.number().optional(),
    /** #290: exports carry systemName; systemId only appears in pre-#290 exports */
    systemName: z.string().optional(),
    systemId: z.string().optional(),
    /** #289: set when the export stripped this environment's credentials */
    credentialsRedacted: z.boolean().optional(),
    parallelProcessing: z.object({
        enabled: z.boolean(),
        maxConcurrency: z.number()
    }).optional()
}).passthrough();

// ============================================================================
// Console Settings Schema
// ============================================================================

export const consoleSettingsSchema = z.object({
    version: z.string(),
    settings: z.record(z.any()) // Record<endpointId, settings>
});

// ============================================================================
// Import Package Structure Schema
// ============================================================================

export const endpointsCollectionSchema = z.object({
    version: z.string(),
    folders: z.array(z.string()),
    endpoints: z.array(endpointConfigSchema)
});

export const environmentsCollectionSchema = z.object({
    version: z.string(),
    folders: z.array(z.string()),
    environments: z.array(environmentConfigSchema)
});

export const importPackageSchema = z.object({
    metadata: exportMetadataSchema,
    endpoints: endpointsCollectionSchema,
    environments: environmentsCollectionSchema,
    folders: folderStructureSchema,
    consoleSettings: consoleSettingsSchema.optional()
});

// ============================================================================
// Export Type Inference
// ============================================================================

export type ExportMetadata = z.infer<typeof exportMetadataSchema>;
export type FolderStructure = z.infer<typeof folderStructureSchema>;
export type EndpointConfig = z.infer<typeof endpointConfigSchema>;
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>;
export type ImportPackage = z.infer<typeof importPackageSchema>;

// ============================================================================
// Validation Helper Functions
// ============================================================================

/**
 * Validate import package structure
 * Returns validation errors or undefined if valid
 */
export function validateImportPackage(data: unknown): { errors?: string[]; package?: ImportPackage } {
    try {
        const validated = importPackageSchema.parse(data);
        return { package: validated };
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errors = error.errors.map(err =>
                `${err.path.join('.')}: ${err.message}`
            );
            return { errors };
        }
        return { errors: ['Unknown validation error'] };
    }
}

/**
 * Check export format version compatibility
 * Returns true if import version is compatible with current version
 */
export function checkVersionCompatibility(exportVersion: string, currentVersion: string): boolean {
    const [exportMajor, exportMinor] = exportVersion.split('.').map(Number);
    const [currentMajor, currentMinor] = currentVersion.split('.').map(Number);

    // Major version must match (breaking changes)
    if (exportMajor !== currentMajor) {
        return false;
    }

    // Minor version can be higher or equal (backward compatible)
    return exportMinor <= currentMinor;
}
