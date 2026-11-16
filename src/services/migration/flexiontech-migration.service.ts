// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointManager } from '../../apiEndpointManager';
import { EnvironmentManager } from '../../environmentManager';

export interface FlexionTechMigrationData {
    version: string;
    endpoints: {
        version: string;
        folders: string[];
        endpoints: Array<Record<string, unknown>>;
    };
    environments: {
        version: string;
        folders: string[];
        environments: Array<Record<string, unknown>>;
    };
}

export interface MigrationResults {
    endpoints: { imported: number; skipped: number };
    environments: { imported: number; skipped: number };
}

/**
 * Imports migration data from FlexionTech (v0.0.51+) into DBMN.
 * Conflict strategy: skip duplicates (matching name + folder, case-insensitive).
 */
export async function performFlexionTechMigration(
    data: FlexionTechMigrationData,
    endpointManager: APIEndpointManager,
    environmentManager: EnvironmentManager
): Promise<MigrationResults> {
    const results: MigrationResults = {
        endpoints: { imported: 0, skipped: 0 },
        environments: { imported: 0, skipped: 0 }
    };

    // Endpoint folders no longer exist as a managed concept — the legacy
    // `folder` field on individual endpoint records is preserved (inert) for
    // back-compat. Imports just write endpoints directly; their folder strings
    // ride along untouched.

    // ── Import endpoints (skip duplicates by name) ──
    const existingEndpoints = await endpointManager.getAllEndpoints();
    const existingEndpointKeys = new Set(
        existingEndpoints.map(ep => (ep.name || '').toLowerCase())
    );

    for (const endpoint of data.endpoints.endpoints) {
        const key = ((endpoint.name as string) || '').toLowerCase();
        if (existingEndpointKeys.has(key)) {
            results.endpoints.skipped++;
            continue;
        }

        try {
            const { id, ...config } = endpoint;
            await endpointManager.addEndpoint(config);
            existingEndpointKeys.add(key);
            results.endpoints.imported++;
        } catch {
            results.endpoints.skipped++;
        }
    }

    // ── Import environment folders ──
    for (const folder of data.environments.folders) {
        try {
            await environmentManager.createFolder(folder);
        } catch {
            // Folder already exists — safe to ignore
        }
    }

    // ── Import environments (skip duplicates by name+folder) ──
    const existingEnvironments = await environmentManager.getAllEnvironments();
    const existingEnvKeys = new Set(
        existingEnvironments.map(env =>
            `${(env.name || '').toLowerCase()}::${(env.folder || '').toLowerCase()}`
        )
    );

    for (const environment of data.environments.environments) {
        const key = `${((environment.name as string) || '').toLowerCase()}::${((environment.folder as string) || '').toLowerCase()}`;
        if (existingEnvKeys.has(key)) {
            results.environments.skipped++;
            continue;
        }

        try {
            const { id, isActive, ...config } = environment;
            await environmentManager.addEnvironment(config);
            existingEnvKeys.add(key);
            results.environments.imported++;
        } catch {
            results.environments.skipped++;
        }
    }

    return results;
}
