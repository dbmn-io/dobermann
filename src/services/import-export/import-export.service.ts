// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Import/Export Service Implementation
 *
 * Handles export and import of Dobermann configurations (endpoints, environments, console settings)
 * to facilitate team collaboration and machine migration.
 *
 * GitHub Issue: #90
 * Architecture: Complies with Architecture.md DI patterns
 *
 * Size (~700 lines): export packaging, parsing/validation and the import
 * preview → execute flow share the same collectors and helpers. Pure logic is
 * already split out (validation-schemas.ts, system-refs.ts).
 */

import * as vscode from 'vscode';
import * as JSZip from 'jszip';
import * as path from 'path';
import { IFileSink } from '../io/file-sink.interface';
import { VsCodeFileSink } from '../io/vscode-file-sink';
import {
    IImportExportService,
    ExportOptions,
    ExportResult,
    ImportPackage,
    ValidationResult,
    ImportPreview,
    ImportItem,
    ImportResult,
    ExportMetadata,
    FolderStructure
} from './import-export.service.interface';
import {
    importPackageSchema,
    validateImportPackage,
    checkVersionCompatibility
} from './validation-schemas';
import { APIEndpointConfig } from '../../apiConfigManager';
import { EnvironmentConfig } from '../../environmentManager';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { LoggerRegistry } from '../../utils/logger-registry';
import { normaliseTag, normaliseTags } from '../../utils/tag-normalizer';
import { SystemManager } from '../../systemManager';
import { SystemRef, ImportedSystemPlan, toExportedSystemRef, planImportedSystems } from './system-refs';
import { planEndpointImports } from './endpoint-import-plan';
import {
    EnvironmentWithRedaction,
    redactEnvironmentForExport,
    redactedEnvironmentNames,
    takeRedactionMarker,
    describeCredentialsNeeded
} from './credential-redaction';

/**
 * Copy a legacy `folder` value into `tags[]` at import time. Idempotent — if
 * the normalised folder is already on the tag list, returns the endpoint
 * unchanged. This is the runtime counterpart to FolderToTagsMigrationService:
 * the migration handles existing endpoints once; this handles every newly
 * imported endpoint forever.
 */
function applyFolderAsTag<T extends { folder?: string; tags?: string[] }>(endpoint: T): T {
    const folderTag = normaliseTag(endpoint.folder ?? '');
    if (!folderTag) return endpoint;
    const existing = normaliseTags(endpoint.tags);
    if (existing.includes(folderTag)) return endpoint;
    return { ...endpoint, tags: [...existing, folderTag] };
}

/**
 * Current export format version (semantic versioning)
 * Increment major version for breaking changes
 */
const CURRENT_EXPORT_VERSION = '1.0.0';

/**
 * Implementation of import/export service
 */
export class ImportExportService implements IImportExportService {
    private fileSink: IFileSink;

    constructor(
        private endpointManager: any, // TODO: Use IEndpointManager when available
        private environmentManager: any, // TODO: Use IEnvironmentManager when available
        private consoleSettingsService: any, // TODO: Use IConsoleSettingsService when available
        private context: vscode.ExtensionContext,
        private logger?: IExtensionDiagnosticLogger,
        // Portability seam (Issue #275): where the export bytes get persisted.
        // Defaults to the VS Code save-dialog sink; the DI composition passes
        // this explicitly so eject can swap it for a browser download.
        fileSink?: IFileSink,
        // Issue #290: Systems travel by name — export needs their names, import
        // creates missing ones. Optional so a store-less service keeps the old
        // behaviour (System fields passed through untouched).
        private systemStore?: Pick<SystemManager, 'getAllSystems' | 'addSystem'>
    ) {
        if (!this.logger) {
            this.logger = LoggerRegistry.getDiagnosticLogger();
        }
        this.fileSink = fileSink ?? new VsCodeFileSink();
    }

    // ========================================================================
    // Export Implementation
    // ========================================================================

    async exportToZip(options: ExportOptions): Promise<ExportResult> {
        try {
            // #289: credentials are left out unless the user explicitly asked
            const includeCredentials = options.includeCredentials === true;

            this.logger!.info('[ImportExportService.exportToZip] Export options:', {
                endpointIds: options.endpoints,
                environmentIds: options.environments,
                includeConsoleSettings: options.includeConsoleSettings,
                includeCredentials
            });

            // 1. Collect data to export — Systems travel by name (#290),
            //    credentials are stripped unless opted in (#289)
            const endpoints = await this.withSystemNames(await this.collectEndpoints(options.endpoints));
            const environments = await this.withSystemNames(
                await this.collectEnvironments(options.environments, includeCredentials)
            );
            const redactedEnvironments = redactedEnvironmentNames(environments);

            this.logger!.info('[ImportExportService.exportToZip] Collected items:', {
                endpointsCount: endpoints.length,
                endpoints: endpoints.map(e => ({ id: e.id, name: e.name, folder: e.folder })),
                environmentsCount: environments.length,
                environments: environments.map(e => ({ id: e.id, name: e.name, folder: e.folder }))
            });

            const consoleSettings = options.includeConsoleSettings
                ? await this.collectConsoleSettings(endpoints.map(e => e.id))
                : undefined;

            // 2. Create ZIP archive
            const zip = new JSZip();

            // 3. Add metadata
            const metadata = this.createMetadata(endpoints, environments, includeCredentials, consoleSettings);
            zip.file('metadata.json', JSON.stringify(metadata, null, 2));

            // 4. Add endpoints
            // 1.2.0 (#290): systemName replaces systemId
            const endpointsData = {
                version: '1.2.0',
                folders: this.extractFolders(endpoints.map(e => e.folder)),
                endpoints: endpoints
            };
            zip.file('endpoints.json', JSON.stringify(endpointsData, null, 2));

            // 5. Add environments — 1.3.0 (#290): systemName replaces systemId
            const environmentsData = {
                version: '1.3.0',
                folders: this.extractFolders(environments.map(e => e.folder)),
                environments: environments
            };
            zip.file('environments.json', JSON.stringify(environmentsData, null, 2));

            // 6. Add folder structure
            const folderStructure: FolderStructure = {
                version: '1.0.0',
                endpoints: {
                    folders: endpointsData.folders
                },
                environments: {
                    folders: environmentsData.folders
                }
            };
            zip.file('folders.json', JSON.stringify(folderStructure, null, 2));

            // 7. Add console settings (if included)
            if (consoleSettings) {
                const consoleData = {
                    version: '1.0.0',
                    settings: consoleSettings
                };
                zip.file('report-settings.json', JSON.stringify(consoleData, null, 2));
            }

            // 8. Generate ZIP buffer
            const zipBuffer = await zip.generateAsync({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 }
            });

            // 9. Persist via the file sink (portability seam — Issue #275). The
            // VS Code sink shows the OS save dialog + writes; eject swaps it.
            const saveResult = await this.fileSink.save({
                suggestedName: `${options.filename}.dbmn.zip`,
                data: zipBuffer,
                filters: { 'Dobermann Export': ['dbmn.zip', 'zip'] }
            });

            if (!saveResult.saved) {
                return {
                    success: false,
                    error: 'Export cancelled by user'
                };
            }

            return {
                success: true,
                filePath: saveResult.path,
                itemCount: {
                    endpoints: endpoints.length,
                    environments: environments.length,
                    consoleSettings: consoleSettings ? Object.keys(consoleSettings).length : 0
                },
                credentialsIncluded: includeCredentials,
                redactedEnvironments
            };

        } catch (error) {
            this.logger!.error('[ImportExportService] Export failed:', error instanceof Error ? error : undefined);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    // ========================================================================
    // Import Implementation
    // ========================================================================

    async parseImportFile(fileBuffer: Buffer): Promise<ImportPackage> {
        try {
            // 1. Load ZIP file
            const zip = await JSZip.loadAsync(fileBuffer);

            // 2. Extract files
            const metadata = await this.extractJsonFile(zip, 'metadata.json');
            const endpoints = await this.extractJsonFile(zip, 'endpoints.json');
            const environments = await this.extractJsonFile(zip, 'environments.json');
            const folders = await this.extractJsonFile(zip, 'folders.json');
            const consoleSettings = await this.extractJsonFile(zip, 'report-settings.json', true); // optional

            this.logger!.info('[ImportExportService.parseImportFile] Parsed data:', {
                metadata,
                endpointsStructure: {
                    version: endpoints.version,
                    foldersCount: endpoints.folders?.length,
                    endpointsCount: endpoints.endpoints?.length,
                    endpointsArray: endpoints.endpoints
                },
                environmentsStructure: {
                    version: environments.version,
                    foldersCount: environments.folders?.length,
                    environmentsCount: environments.environments?.length
                }
            });

            // 3. Build import package
            // Note: endpoints and environments are already full objects with { version, folders, endpoints/environments }
            const importPackage: ImportPackage = {
                metadata: metadata,
                endpoints: endpoints,
                environments: environments,
                folders: folders,
                consoleSettings: consoleSettings
            };

            this.logger!.info('[ImportExportService.parseImportFile] Final importPackage:', {
                endpointCount: importPackage.endpoints.endpoints?.length || 0,
                environmentCount: importPackage.environments.environments?.length || 0
            });

            return importPackage;

        } catch (error) {
            this.logger!.error('[ImportExportService] Failed to parse import file:', error instanceof Error ? error : undefined);
            throw new Error(`Invalid import file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async validateImportPackage(importPackage: ImportPackage): Promise<ValidationResult> {
        try {
            // 1. Schema validation
            const validation = validateImportPackage(importPackage);

            if (validation.errors) {
                this.logger!.error('[ImportExportService] Schema validation errors:', undefined, validation.errors);
                return {
                    valid: false,
                    errors: validation.errors.map(err => ({
                        code: 'SCHEMA_ERROR',
                        message: err
                    })),
                    warnings: [],
                    versionCompatible: false
                };
            }

            // 2. Version compatibility check
            const exportVersion = importPackage.metadata.version;
            const compatible = checkVersionCompatibility(exportVersion, CURRENT_EXPORT_VERSION);

            const warnings: string[] = [];
            if (!compatible) {
                warnings.push(`Export version ${exportVersion} may not be fully compatible with current version ${CURRENT_EXPORT_VERSION}`);
            }

            return {
                valid: true,
                errors: [],
                warnings,
                versionCompatible: compatible,
                exportVersion,
                currentVersion: CURRENT_EXPORT_VERSION
            };

        } catch (error) {
            this.logger!.error('[ImportExportService] Validation failed:', error instanceof Error ? error : undefined);
            return {
                valid: false,
                errors: [{
                    code: 'VALIDATION_ERROR',
                    message: error instanceof Error ? error.message : 'Unknown validation error'
                }],
                warnings: [],
                versionCompatible: false
            };
        }
    }

    /**
     * Prepare import preview showing ALL items with their determined actions
     * GitHub Issue #90: User must see and approve all items before importing
     */
    async prepareImport(importPackage: ImportPackage): Promise<ImportPreview> {
        const items: ImportItem[] = [];

        try {
            // 1. Flatten nested folders
            const flattenedEndpoints = this.flattenFolderStructure(importPackage.endpoints.endpoints);
            const flattenedEnvironments = this.flattenFolderStructure(importPackage.environments.environments);

            // 2. Get existing items
            const existingEndpoints = await this.endpointManager.getAllEndpoints();
            const existingEnvironments = await this.environmentManager.getAllEnvironments();

            // 3. Process endpoints - determine action for EACH
            // UPDATE on a folder+name match, otherwise CREATE. Endpoint names are unique
            // across the install, so a taken name is renamed — see endpoint-import-plan.ts
            items.push(...planEndpointImports(flattenedEndpoints, existingEndpoints));

            // 4. Process environments - same logic
            // Only UPDATE if folder+name match, otherwise CREATE (duplicate names allowed in different folders)
            for (const importEnv of flattenedEnvironments) {
                const existing = existingEnvironments.find(
                    (e: EnvironmentConfig) =>
                        e.name.toLowerCase() === importEnv.name.toLowerCase() &&
                        (e.folder || '') === (importEnv.folder || '')
                );

                if (!existing) {
                    // No folder+name match → CREATE
                    items.push({
                        type: 'environment',
                        importItem: importEnv,
                        action: 'create',
                        selected: true
                    });
                } else {
                    // Folder+name match → UPDATE
                    items.push({
                        type: 'environment',
                        importItem: importEnv,
                        action: 'update',
                        existingItem: existing,
                        selected: true
                    });
                }
            }

            this.logger!.info('[ImportExportService.prepareImport] Prepared items:', {
                total: items.length,
                create: items.filter(i => i.action === 'create').length,
                update: items.filter(i => i.action === 'update').length
            });

            return {
                items,
                existingEndpoints,
                existingEnvironments
            };

        } catch (error) {
            this.logger!.error('[ImportExportService.prepareImport] Failed:', error instanceof Error ? error : undefined);
            return { items: [], existingEndpoints: [], existingEnvironments: [] };
        }
    }

    /**
     * Execute import with user-selected items (GitHub Issue #90)
     * Only imports items that user has selected in the preview UI
     */
    async executeImportWithSelection(selectedItems: ImportItem[]): Promise<ImportResult> {
        try {
            this.logger!.info('[ImportExportService.executeImportWithSelection] Starting import with selected items:', {
                total: selectedItems.length,
                create: selectedItems.filter(i => i.action === 'create').length,
                update: selectedItems.filter(i => i.action === 'update').length,
                conflict: selectedItems.filter(i => i.action === 'conflict').length
            });

            // 1. Create snapshot for rollback
            const snapshot = await this.createSnapshot();

            try {
                // 2. Separate items by type and action
                const endpointsToCreate: APIEndpointConfig[] = [];
                const endpointsToUpdate: { existing: APIEndpointConfig; updated: APIEndpointConfig }[] = [];
                const environmentsToCreate: EnvironmentConfig[] = [];
                const environmentsToUpdate: { existing: EnvironmentConfig; updated: EnvironmentConfig }[] = [];

                const imported: string[] = [];
                const replaced: string[] = [];
                const skipped: string[] = [];
                /** #289: environments whose export stripped their credentials */
                const credentialsNeeded: string[] = [];

                // 3. Process each selected item
                for (const item of selectedItems) {
                    if (item.type === 'endpoint') {
                        const endpoint = item.importItem as APIEndpointConfig;

                        switch (item.action) {
                            case 'create':
                                // CREATE: Will generate new ID
                                // Uses edited name/folder from UI if changed
                                endpointsToCreate.push(endpoint);
                                break;

                            case 'update':
                                // UPDATE: Keep existing ID
                                // Uses edited name/folder from UI if changed
                                if (item.existingItem) {
                                    endpointsToUpdate.push({
                                        existing: item.existingItem as APIEndpointConfig,
                                        updated: endpoint
                                    });
                                }
                                break;
                        }
                    } else if (item.type === 'environment') {
                        const environment = item.importItem as EnvironmentConfig;

                        // #289: the marker describes the file, not the environment —
                        // note it and strip it so it never reaches the store
                        if (takeRedactionMarker(environment)) {
                            credentialsNeeded.push(environment.name);
                        }

                        switch (item.action) {
                            case 'create':
                                // CREATE: Will generate new ID
                                // Uses edited name/folder from UI if changed
                                environmentsToCreate.push(environment);
                                break;

                            case 'update':
                                // UPDATE: Keep existing ID
                                // Uses edited name/folder from UI if changed
                                if (item.existingItem) {
                                    environmentsToUpdate.push({
                                        existing: item.existingItem as EnvironmentConfig,
                                        updated: environment
                                    });
                                }
                                break;
                        }
                    }
                }

                // 3b. Resolve Systems by name (or legacy ID), creating any this
                // install lacks, before items that reference them are written (#290)
                const systems = await this.planSystems(
                    [...endpointsToCreate, ...endpointsToUpdate.map(u => u.updated)],
                    [...environmentsToCreate, ...environmentsToUpdate.map(u => u.updated)]
                );

                // 4. Execute creates, then 5. updates. A failing item is recorded in
                // `errors` and the rest still import — it used to abandon everything after it.
                const errors: string[] = [];

                const endpointsCreated = await this.writeEach(endpointsToCreate, e => `Endpoint "${e.name}"`, async endpoint =>
                    (await this.endpointManager.addEndpoint({
                        ...applyFolderAsTag(systems.resolve(endpoint)),
                        id: undefined // Force generation of new ID
                    })).id, imported, errors);

                const environmentsCreated = await this.writeEach(environmentsToCreate, e => `Environment "${e.name}"`, async environment =>
                    (await this.environmentManager.addEnvironment({
                        ...systems.resolve(environment),
                        id: undefined // Force generation of new ID
                    })).id, imported, errors);

                const endpointsUpdated = await this.writeEach(endpointsToUpdate, u => `Endpoint "${u.updated.name}"`, async ({ existing, updated }) => {
                    await this.endpointManager.updateEndpoint(existing.id, {
                        ...systems.resolve(updated),
                        id: existing.id // Keep existing ID
                    });
                    return existing.id;
                }, imported, errors);

                const environmentsUpdated = await this.writeEach(environmentsToUpdate, u => `Environment "${u.updated.name}"`, async ({ existing, updated }) => {
                    await this.environmentManager.updateEnvironment(existing.id, {
                        ...systems.resolve(updated),
                        id: existing.id // Keep existing ID
                    });
                    return existing.id;
                }, imported, errors);

                const credentialsWarning = describeCredentialsNeeded(credentialsNeeded);

                // 6. Refresh tree views
                this.logger!.info('[ImportExportService.executeImportWithSelection] Import completed:', {
                    imported: imported.length,
                    failed: errors.length,
                    replaced: replaced.length,
                    skipped: skipped.length
                });

                return {
                    success: errors.length === 0,
                    imported,
                    replaced,
                    skipped,
                    errors,
                    warnings: credentialsWarning ? [credentialsWarning] : undefined,
                    details: {
                        endpoints: {
                            created: endpointsCreated,
                            updated: endpointsUpdated,
                            skipped: skipped.filter(id =>
                                selectedItems.some(i => i.type === 'endpoint' && (i.importItem as APIEndpointConfig).id === id)
                            ).length
                        },
                        environments: {
                            created: environmentsCreated,
                            updated: environmentsUpdated,
                            skipped: skipped.filter(id =>
                                selectedItems.some(i => i.type === 'environment' && (i.importItem as EnvironmentConfig).id === id)
                            ).length
                        },
                        consoleSettings: {
                            imported: 0 // Not handled in selection-based import yet
                        }
                    }
                };

            } catch (error) {
                // Rollback on failure
                this.logger!.error('[ImportExportService.executeImportWithSelection] Import failed, rolling back...', error instanceof Error ? error : undefined);
                await this.restoreFromSnapshot(snapshot);
                throw error;
            }

        } catch (error) {
            this.logger!.error('[ImportExportService.executeImportWithSelection] Execution failed:', error instanceof Error ? error : undefined);
            return {
                success: false,
                imported: [],
                replaced: [],
                skipped: [],
                errors: [error instanceof Error ? error.message : 'Unknown error']
            };
        }
    }

    // ========================================================================
    // Private Helper Methods
    // ========================================================================

    /**
     * Write each item, carrying on past failures. Written IDs go to `imported`,
     * failures to `errors` as `<label>: <reason>`. Returns how many were written.
     */
    private async writeEach<T>(
        items: T[],
        label: (item: T) => string,
        write: (item: T) => Promise<string>,
        imported: string[],
        errors: string[]
    ): Promise<number> {
        let written = 0;
        for (const item of items) {
            try {
                const id = await write(item);
                imported.push(id);
                written++;
                this.logger!.info(`[ImportExportService] Imported ${label(item)} (${id})`);
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'Unknown error';
                errors.push(`${label(item)}: ${reason}`);
                this.logger!.warn(`[ImportExportService] ${label(item)} not imported: ${reason}`);
            }
        }
        return written;
    }

    private async collectEndpoints(endpointIds: string[]): Promise<APIEndpointConfig[]> {
        const allEndpoints = await this.endpointManager.getAllEndpoints();
        const selected = allEndpoints.filter((e: APIEndpointConfig) => endpointIds.includes(e.id));

        // Exclude sensitive data (none for endpoints currently)
        return selected;
    }

    private async collectEnvironments(
        environmentIds: string[],
        includeCredentials: boolean
    ): Promise<EnvironmentWithRedaction[]> {
        const allEnvironments = await this.environmentManager.getAllEnvironments();
        const selected = allEnvironments.filter((e: EnvironmentConfig) => environmentIds.includes(e.id));

        // Exclude sensitive data (FR-DATA-3). Session tokens always go; the
        // OAuth client secret and service-account private key go too unless
        // the user opted into including them (#289).
        return selected.map((env: EnvironmentConfig) => redactEnvironmentForExport(env, includeCredentials));
    }

    /** #290: swap each item's systemId for its System's name. No store → unchanged. */
    private async withSystemNames<T extends SystemRef>(items: T[]): Promise<T[]> {
        if (!this.systemStore) return items;
        const systems = await this.systemStore.getAllSystems();
        return items.map(item => toExportedSystemRef(item, systems));
    }

    /**
     * #290: work out each imported item's local System and create the Systems
     * this install lacks. Pass every item that will be written. No store →
     * items pass through unchanged.
     */
    private async planSystems(
        endpoints: Array<APIEndpointConfig & SystemRef>,
        environments: Array<EnvironmentConfig & SystemRef>
    ): Promise<Pick<ImportedSystemPlan, 'resolve'>> {
        if (!this.systemStore) {
            return { resolve: <T extends SystemRef>(item: T): T => item };
        }
        const plan = planImportedSystems(endpoints, environments, await this.systemStore.getAllSystems());
        for (const system of plan.systemsToCreate) {
            await this.systemStore.addSystem(system);
            this.logger!.info(`[ImportExportService] issue#290 Created System "${system.name}" (${system.id})`);
        }
        return plan;
    }

    private async collectConsoleSettings(endpointIds: string[]): Promise<Record<string, any>> {
        const settings: Record<string, any> = {};

        // Report settings service is optional
        if (!this.consoleSettingsService) {
            return settings;
        }

        for (const endpointId of endpointIds) {
            try {
                const endpointSettings = await this.consoleSettingsService.getSettings(endpointId);
                if (endpointSettings) {
                    settings[endpointId] = endpointSettings;
                }
            } catch (error) {
                this.logger!.warn(`[ImportExportService] Failed to get console settings for endpoint ${endpointId}:`, error);
            }
        }

        return settings;
    }

    private createMetadata(
        endpoints: any[],
        environments: any[],
        includeCredentials: boolean,
        consoleSettings?: Record<string, any>
    ): ExportMetadata {
        return {
            version: CURRENT_EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            exportedBy: 'Dobermann VS Code Extension',
            dobermannVersion: this.context.extension.packageJSON.version,
            platform: process.platform,
            // #289: the warning has to match what the file actually contains
            warnings: [
                'JWT tokens not included - re-authenticate after import',
                includeCredentials
                    ? 'Contains OAuth client secrets and Google service-account private keys - treat this file as a secret and keep it out of source control'
                    : 'OAuth client secrets and Google service-account private keys removed - recipients supply their own credentials'
            ]
        };
    }

    private extractFolders(folders: (string | undefined)[]): string[] {
        const uniqueFolders = new Set<string>();

        for (const folder of folders) {
            if (folder) {
                uniqueFolders.add(folder);
            }
        }

        return Array.from(uniqueFolders).sort();
    }

    private async extractJsonFile(
        zip: JSZip,
        filename: string,
        optional: boolean = false
    ): Promise<any> {
        const file = zip.file(filename);

        if (!file) {
            if (optional) {
                return undefined;
            }
            throw new Error(`Missing required file: ${filename}`);
        }

        const content = await file.async('string');
        return JSON.parse(content);
    }

    /**
     * Flatten nested folder structures (FR-IMP-16)
     * Converts "Parent/Child" to "Parent-Child"
     */
    private flattenFolderStructure<T extends { folder?: string }>(items: T[]): T[] {
        return items.map(item => {
            if (!item.folder) {
                return item;
            }

            // Replace folder separators with hyphens
            const flattenedFolder = item.folder.replace(/\//g, '-');

            return {
                ...item,
                folder: flattenedFolder
            };
        });
    }

    /**
     * Create snapshot of current state for rollback (FR-SEC-5)
     */
    private async createSnapshot(): Promise<any> {
        return {
            endpoints: await this.endpointManager.getAllEndpoints(),
            environments: await this.environmentManager.getAllEnvironments(),
            timestamp: Date.now()
        };
    }

    /**
     * Restore state from snapshot (FR-ERR-4)
     */
    private async restoreFromSnapshot(snapshot: any): Promise<void> {
        // TODO: Implement actual rollback logic
        this.logger!.info('[ImportExportService] Restoring from snapshot:', snapshot.timestamp);

        // This would need to:
        // 1. Clear all items
        // 2. Re-import items from snapshot
        // 3. Refresh tree views
    }
}
