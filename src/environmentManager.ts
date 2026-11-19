// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { Event, EventEmitter } from './platform/events';
import type { StoreContext } from './platform/interfaces/store-context.interface';
import { decodeJwtPayload } from './utils/jwt-payload';
import { AuthenticationMethod, OAuthConfig, GoogleServiceAccountConfig } from './types/oauth';
import { HeaderConfig } from './data-loading/zod-schemas';
import { clearProductionSuppression } from './services/ui/production-guard.service';
import { refreshTokenKey } from './services/oauth/oauth-refresh';
import type { SystemConfig } from './data-loading/system-schema';
import { systemConfiguration, type SystemConfiguration } from './services/systems/system-configuration';
import { identityOf, type TokenIdentity } from './services/systems/system-claims';
import { environmentSecretValues } from './services/catalogue/catalogue-safe-form';
import { headerVariablesOf, variableOptions, type HeaderVariable, type VariableSettings, type VariableSettingsMap } from './services/environment/variable-options';

/**
 * Environment Type - SDLC-based categorization
 * Determines the icon, color, and priority sorting in tree view
 */
export type EnvironmentType =
    | 'production'
    | 'staging'
    | 'uat'
    | 'qa'
    | 'development'
    | 'sandbox'
    | 'training'
    | 'integration'
    | 'performance'
    | 'local';

/**
 * Environment Type Configuration
 * Defines visual appearance and priority for each environment type
 * Issue #107 - Tree View Improvements
 */
export interface EnvironmentTypeConfig {
    icon: string;           // VS Code codicon name
    color: string;          // ThemeColor name
    label: string;          // Display label
    description: string;    // Description for dropdown
    priority: number;       // Lower number = higher priority in tree view
}

/**
 * Environment Type Priority Mapping
 * Lower numbers appear first in tree view (production at top, local at bottom)
 */
export const ENVIRONMENT_TYPE_PRIORITY: Record<EnvironmentType, number> = {
    production: 1,
    staging: 2,
    uat: 3,
    performance: 4,
    integration: 5,
    qa: 6,
    development: 7,
    sandbox: 8,
    training: 9,
    local: 10
};

/**
 * Environment Type Visual Configuration
 * Maps each type to its icon, color, and metadata
 */
export const ENVIRONMENT_TYPE_CONFIG: Record<EnvironmentType, EnvironmentTypeConfig> = {
    production: {
        icon: 'rocket',
        color: 'charts.red',
        label: 'Production',
        description: 'Live production systems',
        priority: 1
    },
    staging: {
        icon: 'vm',
        color: 'charts.orange',
        label: 'Staging',
        description: 'Pre-production testing',
        priority: 2
    },
    uat: {
        icon: 'verified',
        color: 'charts.purple',
        label: 'UAT',
        description: 'User acceptance testing',
        priority: 3
    },
    qa: {
        icon: 'beaker',
        color: 'charts.blue',
        label: 'QA/Testing',
        description: 'Quality assurance',
        priority: 6
    },
    development: {
        icon: 'code',
        color: 'charts.green',
        label: 'Development',
        description: 'Active development',
        priority: 7
    },
    sandbox: {
        icon: 'package',
        color: 'charts.yellow',
        label: 'Sandbox',
        description: 'Experimental/demo',
        priority: 8
    },
    training: {
        icon: 'mortar-board',
        color: 'charts.pink',
        label: 'Training',
        description: 'Training environment',
        priority: 9
    },
    integration: {
        icon: 'plug',
        color: 'charts.blue',
        label: 'Integration',
        description: 'Integration testing',
        priority: 5
    },
    performance: {
        icon: 'dashboard',
        color: 'charts.orange',
        label: 'Performance',
        description: 'Performance testing',
        priority: 4
    },
    local: {
        icon: 'home',
        color: 'charts.gray',
        label: 'Local',
        description: 'Local development',
        priority: 10
    }
};

export interface EnvironmentConfig {
    id: string;
    name: string;
    description?: string;
    baseUrl?: string; // Base URL for API requests (required for execution)
    isActive: boolean;
    createdAt: number;
    lastUsed?: number;
    folder?: string; // Optional folder for organization

    // Environment Type (added for tree view improvements - Issue #107)
    /** Environment type for visual categorization and priority sorting */
    environmentType?: EnvironmentType;

    // OAuth Authentication Support (added for OAuth implementation)
    /** Authentication method: 'jwt' (default) or 'oauth' */
    authMethod?: AuthenticationMethod;
    /** OAuth configuration (only used when authMethod is 'oauth') */
    oauthConfig?: OAuthConfig;
    /** Google Service Account configuration (only used when authMethod is 'google-service-account') */
    googleServiceAccountConfig?: GoogleServiceAccountConfig;
    /** Google Service Account scopes (only used when authMethod is 'google-service-account') */
    googleServiceAccountScopes?: string[];

    // Parallel Processing Support (added for batch processing)
    /** Parallel processing configuration */
    parallelProcessing?: {
        enabled: boolean;
        maxConcurrency: 1 | 2 | 4 | 8 | 16;
    };

    // Environment-Level Headers (Issue #113)
    /** Shared headers applied to all endpoints in this environment */
    headers?: Record<string, HeaderConfig>;

    // Environment-Level Variables (Issue #113 & #126)
    /** Variables that pre-populate template values, bypassing user prompts */
    variables?: Record<string, string>;
    /** #424: a variable's options, where they come from, and whether the header shows it. Beside the values, so templates are untouched. */
    variableSettings?: VariableSettingsMap;

    // Target Timezone (GitHub Issue #162)
    /** Target timezone for datetime values sent to API. Default: 'UTC' */
    targetTimezone?: string;

    /**
     * Where its runs happen (#344): the browser (the web app itself; the default), or the
     * local agent (DBMN for VS Code), for systems a browser can't reach. VS Code always runs
     * locally. 'cloud' is reserved for a cloud worker (coming).
     */
    runOn?: 'browser' | 'local-agent' | 'cloud';

    /**
     * Where its execution data is kept (#344): local storage (the workspace folder, or the browser
     * without one). The only choice for now; 'cloud' is reserved for cloud storage (coming).
     */
    storeResultsIn?: 'local' | 'cloud';

    // Migration Tracking (Issue #113 & #126)
    /** Configuration version for migration tracking (2 = current format) */
    configVersion?: number;

    /** Owning System for this environment. Optional during rollout; populated by migration. */
    systemId?: string;
}

export interface EnvironmentCollection {
    environments: EnvironmentConfig[];
    folders: string[];
    activeEnvironmentId?: string;
    version: string;
}

export const DEFAULT_ENVIRONMENT_CONFIG: Partial<EnvironmentConfig> = {
    description: '',
    isActive: false,
    createdAt: Date.now(),
    authMethod: 'jwt', // Default to JWT for backward compatibility
    environmentType: 'development' // Default to development for new environments
};

export function createDefaultEnvironment(name: string): EnvironmentConfig {
    return {
        id: generateEnvironmentId(),
        name,
        description: '',
        isActive: false,
        createdAt: Date.now(),
        authMethod: 'jwt', // Default to JWT for backward compatibility
        environmentType: 'development' // Default to development for new environments
    };
}

export function generateEnvironmentId(): string {
    return `env_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function validateEnvironmentConfig(config: EnvironmentConfig): string[] {
    const errors: string[] = [];

    if (!config.id || config.id.trim() === '') {
        errors.push('Environment ID is required');
    }

    if (!config.name || config.name.trim() === '') {
        errors.push('Environment name is required');
    }

    if (config.name && config.name.length > 50) {
        errors.push('Environment name must be 50 characters or less');
    }

    return errors;
}

export function sanitizeEnvironmentConfig(config: Partial<EnvironmentConfig>): EnvironmentConfig {
    return {
        id: config.id || generateEnvironmentId(),
        name: (config.name || '').trim(),
        description: (config.description || '').trim(),
        baseUrl: config.baseUrl?.trim(),
        isActive: config.isActive || false,
        createdAt: config.createdAt || Date.now(),
        lastUsed: config.lastUsed,
        folder: config.folder?.trim() || undefined,
        // Environment type with backward-compatible default (Issue #107)
        environmentType: config.environmentType || 'development',
        // OAuth fields with backward-compatible defaults
        authMethod: config.authMethod || 'jwt',
        oauthConfig: config.oauthConfig || undefined,
        // Google Service Account fields (Issue #126 Phase 2)
        googleServiceAccountConfig: config.googleServiceAccountConfig || undefined,
        googleServiceAccountScopes: config.googleServiceAccountScopes || undefined,
        // Parallel processing with backward-compatible defaults
        parallelProcessing: config.parallelProcessing || undefined,
        // Environment-level headers and variables (Issue #113 & #126)
        headers: config.headers || undefined,
        variables: config.variables || undefined,
        variableSettings: config.variableSettings || undefined,
        // Target timezone for datetime values (GitHub Issue #162)
        targetTimezone: config.targetTimezone || 'UTC',
        runOn: config.runOn === 'local-agent' ? 'local-agent' : undefined,
        configVersion: config.configVersion || undefined,
        systemId: config.systemId?.trim() || undefined
    };
}

export class EnvironmentManager {
    private context: StoreContext;
    private readonly STORAGE_KEY = 'environments';
    private readonly CURRENT_VERSION = '1.2.0'; // Updated for environmentType field (Issue #107)
    private _onEnvironmentsChanged: EventEmitter<void> = new EventEmitter<void>();
    public readonly onEnvironmentsChanged: Event<void> = this._onEnvironmentsChanged.event;

    /** #342: the store behind this manager changed (the shared catalogue loaded or reloaded). */
    notifyChanged(): void {
        this._onEnvironmentsChanged.fire();
    }

    constructor(context: StoreContext) {
        this.context = context;
    }

    /** #415: where an environment's Standard System comes from (its configuration: claims, org levels). */
    private systemLookup?: (systemId: string) => Promise<SystemConfig | undefined>;

    setSystemLookup(lookup: (systemId: string) => Promise<SystemConfig | undefined>): void {
        this.systemLookup = lookup;
    }

    /**
     * Dobermann issue 7: every secret this manager hands out (an environment's secret headers and
     * variables, its client secret, key and tokens) is told to the app's log, which then never
     * writes it, whatever the header is called.
     */
    private secretSink?: (value: string) => void;

    setSecretSink(sink: (value: string) => void): void {
        this.secretSink = sink;
    }

    private tellSecrets(environments: readonly EnvironmentConfig[]): void {
        if (!this.secretSink) return;
        for (const environment of environments) {
            for (const value of environmentSecretValues(environment)) this.secretSink(value);
        }
    }

    /** #415: the environment's Standard System's configuration, or undefined (own System, no lookup, not found). */
    async systemConfigurationFor(environmentId: string): Promise<SystemConfiguration | undefined> {
        const environment = await this.getEnvironment(environmentId);
        if (!environment?.systemId || !this.systemLookup) return undefined;
        try {
            return systemConfiguration(await this.systemLookup(environment.systemId));
        } catch {
            return undefined;
        }
    }

    /** #415: what the environment's token says about the person, by its System's claim names; undefined without a JWT. */
    async tokenIdentityFor(environmentId: string): Promise<TokenIdentity | undefined> {
        const token = await this.getEnvironmentToken(environmentId);
        const payload = token && token.split('.').length === 3 ? decodeJwtPayload<Record<string, unknown>>(token) : null;
        if (!payload) return undefined;
        return identityOf(payload, await this.systemConfigurationFor(environmentId));
    }

    async getAllEnvironments(): Promise<EnvironmentConfig[]> {
        const collection = await this.getEnvironmentCollection();
        // Sanitize all environments to ensure they have IDs
        const sanitizedEnvironments = collection.environments.map(sanitizeEnvironmentConfig);

        // If any environments were missing IDs, save the updated collection
        const hasChanges = sanitizedEnvironments.some((env, index) =>
            env.id !== collection.environments[index]?.id
        );

        if (hasChanges) {
            await this.saveEnvironments(sanitizedEnvironments);
        }

        return sanitizedEnvironments;
    }

    async getEnvironment(id: string): Promise<EnvironmentConfig | undefined> {
        const environments = await this.getAllEnvironments();

        // First try to find by ID (UUID)
        let environment = environments.find(env => env.id === id);

        // If not found and the id doesn't look like a UUID, check if active environment name matches
        // This provides backward compatibility for batches that stored environment names
        if (!environment && !id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
            const activeEnvironment = await this.getActiveEnvironment();
            if (activeEnvironment && activeEnvironment.name === id) {
                environment = activeEnvironment;
            }
            // If no match and we only have a name, return undefined
            // (calling code will handle fallback)
        }

        return environment;
    }

    async getActiveEnvironment(): Promise<EnvironmentConfig | undefined> {
        const collection = await this.getEnvironmentCollection();
        if (collection.activeEnvironmentId) {
            return this.getEnvironment(collection.activeEnvironmentId);
        }

        // Fallback to any active environment
        const environments = await this.getAllEnvironments();
        return environments.find(env => env.isActive);
    }

    async setActiveEnvironment(id: string): Promise<EnvironmentConfig> {
        const environments = await this.getAllEnvironments();
        const targetEnv = environments.find(env => env.id === id);

        if (!targetEnv) {
            throw new Error(`Environment with ID "${id}" not found`);
        }

        // GitHub Issue #273: switching environments is a conscious re-entry, so
        // any production-warning suppression window is dropped — returning to a
        // production environment (even within the suppression window) re-warns.
        // Guarded on a genuine change so redundant re-activation of the already
        // active env doesn't defeat suppression.
        const previouslyActive = environments.find(env => env.isActive);
        if (previouslyActive?.id !== id) {
            clearProductionSuppression();
        }

        // Deactivate all environments
        environments.forEach(env => env.isActive = false);

        // Activate the target environment
        targetEnv.isActive = true;
        targetEnv.lastUsed = Date.now();

        await this.saveEnvironments(environments, id);
        return targetEnv;
    }

    async addEnvironment(config: Partial<EnvironmentConfig>): Promise<EnvironmentConfig> {
        const sanitizedConfig = sanitizeEnvironmentConfig(config);
        const validationErrors = validateEnvironmentConfig(sanitizedConfig);

        if (validationErrors.length > 0) {
            throw new Error(`Invalid environment configuration: ${validationErrors.join(', ')}`);
        }

        const environments = await this.getAllEnvironments();

        // Check for duplicate names in the SAME folder only
        // Allow duplicate names in different folders
        const duplicateInFolder = environments.find(env =>
            env.name === sanitizedConfig.name &&
            (env.folder || '') === (sanitizedConfig.folder || '')
        );
        if (duplicateInFolder) {
            throw new Error(`An environment with the name "${sanitizedConfig.name}" already exists in this folder`);
        }

        environments.push(sanitizedConfig);

        // If this is the first environment or marked as active, make it active
        if (environments.length === 1 || sanitizedConfig.isActive) {
            // Deactivate all other environments first
            environments.forEach(env => env.isActive = env.id === sanitizedConfig.id);
            sanitizedConfig.isActive = true;
            await this.saveEnvironments(environments, sanitizedConfig.id);
        } else {
            await this.saveEnvironments(environments);
        }

        return sanitizedConfig;
    }

    async updateEnvironment(id: string, updates: Partial<EnvironmentConfig>): Promise<EnvironmentConfig> {
        const environments = await this.getAllEnvironments();
        const index = environments.findIndex(env => env.id === id);

        if (index === -1) {
            throw new Error(`Environment with ID "${id}" not found`);
        }

        const updatedConfig = sanitizeEnvironmentConfig({
            ...environments[index],
            ...updates,
            id // Ensure ID doesn't change
        });

        const validationErrors = validateEnvironmentConfig(updatedConfig);
        if (validationErrors.length > 0) {
            throw new Error(`Invalid environment configuration: ${validationErrors.join(', ')}`);
        }

        // Check for duplicate names in the SAME folder only (excluding current environment)
        // Allow duplicate names in different folders
        if (environments.some(env =>
            env.id !== id &&
            env.name === updatedConfig.name &&
            (env.folder || '') === (updatedConfig.folder || '')
        )) {
            throw new Error(`An environment with the name "${updatedConfig.name}" already exists in this folder`);
        }

        environments[index] = updatedConfig;
        await this.saveEnvironments(environments);

        return updatedConfig;
    }

    async deleteEnvironment(id: string): Promise<boolean> {
        const environments = await this.getAllEnvironments();
        const envToDelete = environments.find(env => env.id === id);

        if (!envToDelete) {
            return false;
        }

        const filteredEnvironments = environments.filter(env => env.id !== id);

        // If we're deleting the active environment and there are other environments, activate another one
        if (envToDelete.isActive && filteredEnvironments.length > 0) {
            filteredEnvironments[0].isActive = true;
            filteredEnvironments[0].lastUsed = Date.now();
            await this.saveEnvironments(filteredEnvironments, filteredEnvironments[0].id);
        } else {
            await this.saveEnvironments(filteredEnvironments);
        }

        // Its tokens go with it: the session token, and the OAuth refresh token (#359, #362)
        await this.deleteEnvironmentToken(id);
        await this.context.secrets.delete(refreshTokenKey(id));
        await this.context.secrets.delete(`oauth_tokens_${id}`);

        return true;
    }

    /**
     * Tokens deleted since they were last set. VS Code's SecretStorage can hand a deleted secret
     * back for a moment (see oauth-refresh.ts), which would show a signed-out environment as
     * signed in: a deleted token stays deleted here until one is set again.
     */
    private readonly deletedTokens = new Set<string>();

    async getEnvironmentToken(environmentId: string): Promise<string | undefined> {
        if (this.deletedTokens.has(environmentId)) return undefined;
        const token = await this.context.secrets.get(`env_token_${environmentId}`);
        if (token) this.secretSink?.(token);
        return token;
    }

    async setEnvironmentToken(environmentId: string, token: string): Promise<void> {
        this.deletedTokens.delete(environmentId);
        this.secretSink?.(token);
        await this.context.secrets.store(`env_token_${environmentId}`, token);
    }

    async deleteEnvironmentToken(environmentId: string): Promise<void> {
        this.deletedTokens.add(environmentId);
        await this.context.secrets.delete(`env_token_${environmentId}`);
    }

    async clearEnvironmentToken(environmentId: string): Promise<void> {
        // Clear the stored token
        this.deletedTokens.add(environmentId);
        await this.context.secrets.delete(`env_token_${environmentId}`);

        // Fire environments changed event to notify listeners (like status service)
        this._onEnvironmentsChanged.fire();
    }

    async getActiveEnvironmentToken(): Promise<string | undefined> {
        const activeEnv = await this.getActiveEnvironment();
        if (!activeEnv) return undefined;
        return await this.getEnvironmentToken(activeEnv.id);
    }

    // ---- #424: variables with options and a place in the header

    /** Set one variable's value (the header picker, a run's prompt). */
    async setVariable(environmentId: string, name: string, value: string): Promise<void> {
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error(`A value for ${name} is required`);
        }
        const environments = await this.getAllEnvironments();
        const env = environments.find(e => e.id === environmentId);
        if (!env) {
            throw new Error(`Environment with ID "${environmentId}" not found`);
        }
        env.variables = { ...(env.variables ?? {}), [name]: trimmed };
        await this.saveEnvironments(environments);
    }

    /** The values a variable may take, as the user typed them. */
    async getVariableOptions(environmentId: string, name: string): Promise<string[]> {
        const environment = await this.getEnvironment(environmentId);
        return environment ? variableOptions(environment, name) : [];
    }

    /** What the header shows for an environment: each header variable with its value and options. */
    async getHeaderVariables(environmentId: string): Promise<HeaderVariable[]> {
        const environment = await this.getEnvironment(environmentId);
        return environment ? headerVariablesOf(environment) : [];
    }

    /** A new option from the header's "Add" (or a run asking for one): appended to the variable's options, with its label if given, and made its value. */
    async addVariableOption(environmentId: string, name: string, value: string, label?: string): Promise<void> {
        const trimmed = value.trim();
        if (!trimmed) throw new Error(`A value for ${name} is required`);
        const environments = await this.getAllEnvironments();
        const env = environments.find(e => e.id === environmentId);
        if (!env) throw new Error(`Environment with ID "${environmentId}" not found`);
        const settings = env.variableSettings?.[name] ?? {};
        const options = settings.options ?? [];
        const named = label?.trim();
        const next: VariableSettings = { ...settings, options: options.includes(trimmed) ? options : [...options, trimmed] };
        if (named && named !== trimmed) next.labels = { ...(settings.labels ?? {}), [trimmed]: named };
        env.variableSettings = { ...(env.variableSettings ?? {}), [name]: next };
        env.variables = { ...(env.variables ?? {}), [name]: trimmed };
        await this.saveEnvironments(environments);
    }

    // Folder management methods
    async createFolder(folderName: string): Promise<void> {
        const trimmedName = folderName.trim();
        if (!trimmedName) {
            throw new Error('Folder name cannot be empty');
        }

        const collection = await this.getEnvironmentCollection();

        // Check if folder already exists (either explicitly or implicitly)
        const existingExplicitFolder = collection.folders.includes(trimmedName);
        const existingImplicitFolder = collection.environments.some(environment => environment.folder === trimmedName);

        if (existingExplicitFolder || existingImplicitFolder) {
            throw new Error(`Folder "${trimmedName}" already exists`);
        }

        // Add folder to explicit folders list
        const updatedFolders = [...collection.folders, trimmedName].sort();
        await this.saveEnvironments(collection.environments, collection.activeEnvironmentId, updatedFolders);
    }

    async deleteFolder(folderName: string): Promise<void> {
        const collection = await this.getEnvironmentCollection();

        // Remove folder from explicit folders list
        const updatedFolders = collection.folders.filter(folder => folder !== folderName);

        // Remove folder assignment from environments, move to root level
        const modifiedEnvironments = collection.environments.map(environment => {
            if (environment.folder === folderName) {
                const { folder, ...environmentWithoutFolder } = environment;
                return environmentWithoutFolder as EnvironmentConfig;
            }
            return environment;
        });

        await this.saveEnvironments(modifiedEnvironments, collection.activeEnvironmentId, updatedFolders);
    }

    async renameFolder(oldName: string, newName: string): Promise<void> {
        const trimmedNewName = newName.trim();
        if (!trimmedNewName) {
            throw new Error('New folder name cannot be empty');
        }

        if (oldName === trimmedNewName) {
            return; // No change needed
        }

        const collection = await this.getEnvironmentCollection();

        // Check if new folder name already exists (either explicitly or implicitly)
        const existingExplicitFolder = collection.folders.includes(trimmedNewName);
        const existingImplicitFolder = collection.environments.some(environment => environment.folder === trimmedNewName);

        if (existingExplicitFolder || existingImplicitFolder) {
            throw new Error(`Folder "${trimmedNewName}" already exists`);
        }

        // Update explicit folders list
        const updatedFolders = collection.folders.map(folder =>
            folder === oldName ? trimmedNewName : folder
        ).sort();

        // Update environments that reference this folder
        const modifiedEnvironments = collection.environments.map(environment => {
            if (environment.folder === oldName) {
                return { ...environment, folder: trimmedNewName };
            }
            return environment;
        });

        await this.saveEnvironments(modifiedEnvironments, collection.activeEnvironmentId, updatedFolders);
    }

    async getFolders(): Promise<string[]> {
        const callId = `getFolders-${Date.now()}`;

        const collection = await this.getEnvironmentCollection();

        const folders = new Set<string>();

        // Add explicit folders (created but may be empty)
        collection.folders.forEach(folder => folders.add(folder));

        // Add implicit folders (from environments with folder property)
        collection.environments.forEach(environment => {
            if (environment.folder && environment.folder.trim() !== '') {
                folders.add(environment.folder.trim());
            }
        });

        const result = Array.from(folders).sort();
        return result;
    }

    async getEnvironmentsInFolder(folderName: string): Promise<EnvironmentConfig[]> {
        const environments = await this.getAllEnvironments();
        return environments.filter(environment => environment.folder === folderName);
    }

    async moveEnvironmentToFolder(environmentId: string, folderName?: string): Promise<EnvironmentConfig> {
        const trimmedFolderName = folderName?.trim() || undefined;
        return await this.updateEnvironment(environmentId, { folder: trimmedFolderName });
    }

    private async getEnvironmentCollection(): Promise<EnvironmentCollection> {
        const stored = await this.context.globalState.get<EnvironmentCollection>(this.STORAGE_KEY);

        if (!stored) {
            return {
                environments: [],
                folders: [],
                version: this.CURRENT_VERSION
            };
        }

        // Handle version migrations if needed
        const collection = stored.version !== this.CURRENT_VERSION ? await this.migrateEnvironmentCollection(stored) : stored;
        this.tellSecrets(collection.environments ?? []);
        return collection;
    }

    private async saveEnvironments(environments: EnvironmentConfig[], activeEnvironmentId?: string, folders?: string[]): Promise<void> {
        const currentCollection = await this.getEnvironmentCollection();
        const collection: EnvironmentCollection = {
            environments,
            folders: folders || currentCollection.folders,
            activeEnvironmentId: activeEnvironmentId || currentCollection.activeEnvironmentId,
            version: this.CURRENT_VERSION
        };

        await this.context.globalState.update(this.STORAGE_KEY, collection);
        this._onEnvironmentsChanged.fire();
    }

    private async migrateEnvironmentCollection(collection: EnvironmentCollection): Promise<EnvironmentCollection> {
        // Migrate environments to add missing fields
        const migratedEnvironments = collection.environments.map(env => {
            // Add environmentType to existing environments if missing (Issue #107 migration)
            if (!env.environmentType) {
                // Smart default: guess type based on name if possible
                const nameLower = env.name.toLowerCase();
                if (nameLower.includes('prod')) {
                    env.environmentType = 'production';
                } else if (nameLower.includes('staging') || nameLower.includes('stage')) {
                    env.environmentType = 'staging';
                } else if (nameLower.includes('uat')) {
                    env.environmentType = 'uat';
                } else if (nameLower.includes('qa') || nameLower.includes('test')) {
                    env.environmentType = 'qa';
                } else if (nameLower.includes('sandbox')) {
                    env.environmentType = 'sandbox';
                } else if (nameLower.includes('local')) {
                    env.environmentType = 'local';
                } else if (nameLower.includes('perf')) {
                    env.environmentType = 'performance';
                } else if (nameLower.includes('integration') || nameLower.includes('int')) {
                    env.environmentType = 'integration';
                } else if (nameLower.includes('training') || nameLower.includes('train')) {
                    env.environmentType = 'training';
                } else {
                    // Default to development for unknown
                    env.environmentType = 'development';
                }
            }
            return env;
        });

        const migrated: EnvironmentCollection = {
            environments: migratedEnvironments,
            folders: collection.folders || [],
            activeEnvironmentId: collection.activeEnvironmentId,
            version: this.CURRENT_VERSION
        };

        // Save directly to storage without triggering events to avoid migration loop
        await this.context.globalState.update(this.STORAGE_KEY, migrated);

        return migrated;
    }
}