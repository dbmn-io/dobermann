// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Import/Export Service Interface
 *
 * Handles export and import of Dobermann configurations (endpoints, environments, console settings)
 * to facilitate team collaboration and machine migration.
 *
 * GitHub Issue: #90
 */

import { APIEndpointConfig } from '../../apiConfigManager';
import { EnvironmentConfig } from '../../environmentManager';

// ============================================================================
// Export Types
// ============================================================================

export interface ExportOptions {
    /** Array of endpoint IDs to export */
    endpoints: string[];

    /** Array of environment IDs to export */
    environments: string[];

    /** Whether to include console settings in export */
    includeConsoleSettings: boolean;

    /**
     * Whether to include environment credentials — the OAuth client secret and
     * the Google service-account private key (#289). Defaults to false: the
     * export carries no credentials unless the user explicitly asks for them.
     */
    includeCredentials?: boolean;

    /** Suggested filename for export (without extension) */
    filename: string;
}

export interface ExportResult {
    /** Whether export succeeded */
    success: boolean;

    /** Path to exported ZIP file (if successful) */
    filePath?: string;

    /** Error message (if failed) */
    error?: string;

    /** Number of items exported */
    itemCount?: {
        endpoints: number;
        environments: number;
        consoleSettings: number;
    };

    /** Whether credentials were written into the file (#289) */
    credentialsIncluded?: boolean;

    /** Names of environments whose credentials were stripped (#289) */
    redactedEnvironments?: string[];
}

// ============================================================================
// Import Types
// ============================================================================

export interface ImportPackage {
    /** Export metadata (version, timestamp, etc.) */
    metadata: ExportMetadata;

    /** Endpoints to import */
    endpoints: {
        version: string;
        folders: string[];
        endpoints: APIEndpointConfig[];
    };

    /** Environments to import */
    environments: {
        version: string;
        folders: string[];
        environments: EnvironmentConfig[];
    };

    /** Folder structure */
    folders: FolderStructure;

    /** Report settings (optional) */
    consoleSettings?: ConsoleSettingsData;
}

export interface ExportMetadata {
    /** Export format version (e.g., "1.0.0") */
    version: string;

    /** Timestamp when export was created */
    exportedAt: string;

    /** Application that created the export */
    exportedBy: string;

    /** Dobermann extension version */
    dobermannVersion: string;

    /** Platform (linux, win32, darwin) */
    platform?: string;

    /** Warnings about export contents */
    warnings?: string[];
}

export interface FolderStructure {
    /** Folder structure version */
    version: string;

    /** Endpoint folders */
    endpoints: {
        folders: string[];
    };

    /** Environment folders */
    environments: {
        folders: string[];
    };
}

export interface ConsoleSettingsData {
    /** Report settings version */
    version: string;

    /** Settings mapped by endpoint ID */
    settings: Record<string, any>;
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationResult {
    /** Whether validation passed */
    valid: boolean;

    /** Validation errors */
    errors: ValidationError[];

    /** Validation warnings */
    warnings: string[];

    /** Export format version compatibility status */
    versionCompatible: boolean;

    /** Export format version from file */
    exportVersion?: string;

    /** Current import format version supported */
    currentVersion?: string;
}

export interface ValidationError {
    /** Error code */
    code: string;

    /** Error message */
    message: string;

    /** Location of error (e.g., "endpoints[2].id") */
    path?: string;
}

// ============================================================================
// Import Preview Types (GitHub Issue #90)
// ============================================================================

/**
 * Import preview showing ALL items that will be imported
 * User can select/deselect items before importing
 */
export interface ImportPreview {
    /** All items being imported with their determined actions */
    items: ImportItem[];

    /** Existing endpoints (for dynamic action checking in UI) */
    existingEndpoints?: APIEndpointConfig[];

    /** Existing environments (for dynamic action checking in UI) */
    existingEnvironments?: EnvironmentConfig[];
}

/**
 * Individual item in import preview
 */
export interface ImportItem {
    /** Item type */
    type: 'endpoint' | 'environment';

    /** Item being imported from file */
    importItem: APIEndpointConfig | EnvironmentConfig;

    /** Determined action for this item */
    action: 'create' | 'update' | 'conflict';

    /**
     * Name in the import file, when the preview renamed the endpoint because
     * that name is already taken (endpoint names are unique across the install)
     */
    renamedFrom?: string;

    /** Existing item (if update or conflict) */
    existingItem?: APIEndpointConfig | EnvironmentConfig;

    /** Whether user has selected this item for import (default true) */
    selected: boolean;

    /** Resolution for conflicts (required if action='conflict') */
    resolution?: 'replace' | 'rename' | 'skip';

    /** New name if resolution='rename' */
    newName?: string;
}

// ============================================================================
// Legacy Conflict Types (deprecated - use ImportPreview instead)
// ============================================================================

export interface ConflictDetection {
    /** Detected conflicts */
    conflicts: Conflict[];
}

export interface Conflict {
    /** Item type (endpoint or environment) */
    type: 'endpoint' | 'environment';

    /** Item being imported */
    importItem: APIEndpointConfig | EnvironmentConfig;

    /** Existing item with same name */
    existingItem: APIEndpointConfig | EnvironmentConfig;

    /** Suggested resolution */
    suggestedResolution: 'replace' | 'rename' | 'skip';

    /** Suggested new name (for rename action) */
    suggestedName?: string;
}

export interface ConflictResolution {
    /** ID of import item */
    itemId: string;

    /** Item type */
    type: 'endpoint' | 'environment';

    /** Resolution action */
    action: 'replace' | 'rename' | 'skip';

    /** New name (for rename action) */
    newName?: string;

    /** Destination folder */
    destinationFolder?: string;
}

// ============================================================================
// Result Types
// ============================================================================

export interface ImportResult {
    /** Whether import succeeded overall */
    success: boolean;

    /** IDs of successfully imported items */
    imported: string[];

    /** IDs of items that replaced existing items */
    replaced: string[];

    /** IDs of items that were skipped */
    skipped: string[];

    /** Errors that occurred during import */
    errors: string[];

    /**
     * Non-fatal notices — e.g. environments imported without credentials
     * because the export stripped them (#289).
     */
    warnings?: string[];

    /** Detailed results by type */
    details?: {
        endpoints: {
            created: number;
            updated: number;
            skipped: number;
        };
        environments: {
            created: number;
            updated: number;
            skipped: number;
        };
        consoleSettings: {
            imported: number;
        };
    };
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Service for importing and exporting Dobermann configurations
 */
export interface IImportExportService {
    /**
     * Export selected endpoints, environments, and console settings to a ZIP file
     *
     * @param options Export options (items to export, filename)
     * @returns Export result with file path or error
     */
    exportToZip(options: ExportOptions): Promise<ExportResult>;

    /**
     * Parse and extract contents of an import ZIP file
     *
     * @param fileBuffer ZIP file buffer
     * @returns Parsed import package
     * @throws Error if ZIP file is invalid or corrupted
     */
    parseImportFile(fileBuffer: Buffer): Promise<ImportPackage>;

    /**
     * Validate an import package for correctness and compatibility
     *
     * @param package Import package to validate
     * @returns Validation result with errors and warnings
     */
    validateImportPackage(importPackage: ImportPackage): Promise<ValidationResult>;

    /**
     * Prepare import preview showing ALL items with their actions
     * This replaces detectConflicts - shows create/update/conflict for every item
     *
     * @param package Import package
     * @returns Import preview with all items and their determined actions
     */
    prepareImport(importPackage: ImportPackage): Promise<ImportPreview>;

    /**
     * Execute import with user-selected items (GitHub Issue #90)
     * Only imports items that user has selected in the preview UI
     *
     * @param selectedItems Array of ImportItem objects with user selections
     * @returns Import result with success/failure details
     */
    executeImportWithSelection(selectedItems: ImportItem[]): Promise<ImportResult>;
}
