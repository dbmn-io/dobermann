// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { Event, EventEmitter } from './platform/events';
import type { StoreContext } from './platform/interfaces/store-context.interface';
import {
    SystemConfig,
    SystemCollection,
    sanitizeSystemConfig,
    validateSystemConfig,
    generateSystemId,
    isGlobalSystem,
    longestCommonPathPrefix,
    SYSTEM_PREFERENCE_FIELDS,
    SystemPreferences
} from './data-loading/system-schema';
import { APIEndpointManager } from './apiEndpointManager';
import { EnvironmentManager } from './environmentManager';

export class SystemManager {
    private context: StoreContext;
    private readonly STORAGE_KEY = 'apiSystems';
    private readonly CURRENT_VERSION = '1.0.0';
    private _onSystemsChanged = new EventEmitter<void>();
    public readonly onSystemsChanged: Event<void> = this._onSystemsChanged.event;

    /** #342: the store behind this manager changed (the shared catalogue loaded or reloaded). */
    notifyChanged(): void {
        this._onSystemsChanged.fire();
    }

    /** #415: where the global Systems come from (GlobalSystemsService). None: the user's own only. */
    private globalSystems: { getAll(): SystemConfig[] } | undefined;

    constructor(context: StoreContext) {
        this.context = context;
    }

    /**
     * #415: list the global Systems with the user's own, one list, and tell listeners when they
     * change. The user's store never holds them: they come from Supabase.
     */
    setGlobalSystems(source: { getAll(): SystemConfig[]; onChanged(listener: () => void): { dispose(): void } }): { dispose(): void } {
        this.globalSystems = source;
        const subscription = source.onChanged(() => this._onSystemsChanged.fire());
        this._onSystemsChanged.fire();
        return subscription;
    }

    /**
     * The user's own Systems, then the global ones. An item in the user's store with a global
     * System's id holds the user's own settings for it (SYSTEM_PREFERENCE_FIELDS), laid over the
     * global System. Should DBMN withdraw that System, the item is listed as the user's own, so
     * whatever was linked to it still has a System.
     */
    async getAllSystems(): Promise<SystemConfig[]> {
        const stored = await this.getOwnSystems();
        const globals = this.globalSystems?.getAll() ?? [];
        const globalIds = new Set(globals.map(s => s.id));
        const preferences = new Map(stored.filter(s => globalIds.has(s.id)).map(s => [s.id, s]));
        return [
            ...stored.filter(s => !globalIds.has(s.id)),
            ...globals.map(system => withPreferences(system, preferences.get(system.id)))
        ];
    }

    /** What the user's store holds: their own Systems, and their settings for global ones. */
    private async getOwnSystems(): Promise<SystemConfig[]> {
        return (await this.getCollection()).systems;
    }

    /** #415: a global System is maintained by DBMN; the app lists it and changes nothing. */
    private async refuseGlobal(id: string, action: string): Promise<void> {
        const system = (await this.getAllSystems()).find(s => s.id === id);
        if (system && isGlobalSystem(system)) {
            throw new Error(`"${system.name}" is a global System, maintained by DBMN: it can't be ${action}`);
        }
    }

    /** #415: the user's own settings for a global System, kept in their store. */
    private async savePreferences(system: SystemConfig, updates: SystemPreferences): Promise<SystemConfig> {
        const systems = await this.getOwnSystems();
        const index = systems.findIndex(s => s.id === system.id);
        const record = sanitizeSystemConfig({
            ...(index === -1 ? { id: system.id, name: system.name, createdAt: Date.now() } : systems[index]),
            ...updates,
            updatedAt: Date.now()
        });
        if (index === -1) systems.push(record);
        else systems[index] = record;
        await this.saveSystems(systems);
        return withPreferences(system, record);
    }

    async getSystem(id: string): Promise<SystemConfig | undefined> {
        const systems = await this.getAllSystems();
        return systems.find(system => system.id === id);
    }

    async getSystemByName(name: string): Promise<SystemConfig | undefined> {
        const systems = await this.getAllSystems();
        const trimmed = name.trim();
        return systems.find(system => system.name === trimmed);
    }

    async addSystem(config: Partial<SystemConfig>): Promise<SystemConfig> {
        const sanitized = sanitizeSystemConfig(config);
        const validation = validateSystemConfig(sanitized);
        if (!validation.success) {
            throw new Error(`Invalid system configuration: ${(validation.errors || []).join(', ')}`);
        }

        if ((await this.getAllSystems()).some(s => s.name === sanitized.name)) {
            throw new Error(`A system with the name "${sanitized.name}" already exists`);
        }

        // A System the user adds is their own, never global
        const own: SystemConfig = { ...sanitized };
        delete own.scope;
        const systems = await this.getOwnSystems();
        systems.push(own);
        await this.saveSystems(systems);
        return own;
    }

    async updateSystem(id: string, updates: Partial<SystemConfig>): Promise<SystemConfig> {
        const global = (await this.getAllSystems()).find(s => s.id === id && isGlobalSystem(s));
        if (global && isPreferencesOnly(updates)) {
            return this.savePreferences(global, updates);
        }
        await this.refuseGlobal(id, 'changed');
        const systems = await this.getOwnSystems();
        const index = systems.findIndex(s => s.id === id);
        if (index === -1) {
            throw new Error(`System with ID "${id}" not found`);
        }

        const updated = sanitizeSystemConfig({
            ...systems[index],
            ...updates,
            id
        });

        const validation = validateSystemConfig(updated);
        if (!validation.success) {
            throw new Error(`Invalid system configuration: ${(validation.errors || []).join(', ')}`);
        }

        if ((await this.getAllSystems()).some(s => s.id !== id && s.name === updated.name)) {
            throw new Error(`A system with the name "${updated.name}" already exists`);
        }

        systems[index] = updated;
        await this.saveSystems(systems);
        return updated;
    }

    async deleteSystem(id: string): Promise<boolean> {
        await this.refuseGlobal(id, 'deleted');
        const systems = await this.getOwnSystems();
        const filtered = systems.filter(s => s.id !== id);
        if (filtered.length === systems.length) {
            return false;
        }
        await this.saveSystems(filtered);
        return true;
    }

    /**
     * Suggest a tree-trim prefix for a System by computing the longest common path
     * prefix across all of the System's endpoints' paths.
     */
    async suggestTrimPrefix(
        systemId: string,
        endpointManager: APIEndpointManager
    ): Promise<string> {
        const endpoints = await endpointManager.getAllEndpoints();
        const systemEndpoints = endpoints.filter(e => e.systemId === systemId);
        if (systemEndpoints.length === 0) return '';
        return longestCommonPathPrefix(systemEndpoints.map(e => e.path));
    }

    /**
     * Apply (or clear) the trim prefix on a System. Pass undefined/empty to clear.
     */
    async setTrimPrefix(systemId: string, prefix: string | undefined): Promise<SystemConfig> {
        return this.updateSystem(systemId, { treeTrimPrefix: prefix });
    }

    async getActiveSystem(environmentManager: EnvironmentManager): Promise<SystemConfig | undefined> {
        const activeEnv = await environmentManager.getActiveEnvironment();
        if (!activeEnv?.systemId) return undefined;
        return this.getSystem(activeEnv.systemId);
    }

    async ensureDefaultSystem(): Promise<SystemConfig> {
        const systems = (await this.getAllSystems()).filter(s => !isGlobalSystem(s));
        if (systems.length > 0) return systems[0];
        return this.addSystem({
            id: generateSystemId(),
            name: 'Default',
            description: 'Default System (auto-created)',
            createdAt: Date.now()
        });
    }

    private async getCollection(): Promise<SystemCollection> {
        const stored = await this.context.globalState.get<SystemCollection>(this.STORAGE_KEY);
        if (!stored) {
            return { systems: [], version: this.CURRENT_VERSION };
        }
        return stored;
    }

    private async saveSystems(systems: SystemConfig[]): Promise<void> {
        const collection: SystemCollection = {
            systems,
            version: this.CURRENT_VERSION
        };
        await this.context.globalState.update(this.STORAGE_KEY, collection);
        this._onSystemsChanged.fire();
    }
}

/** Only the user's own settings (SYSTEM_PREFERENCE_FIELDS), nothing of the System itself. */
function isPreferencesOnly(updates: Partial<SystemConfig>): updates is SystemPreferences {
    const keys = Object.keys(updates).filter(key => key !== 'id');
    return keys.length > 0 && keys.every(key => (SYSTEM_PREFERENCE_FIELDS as readonly string[]).includes(key));
}

/** A global System with the user's own settings for it laid over. */
function withPreferences(system: SystemConfig, record: SystemConfig | undefined): SystemConfig {
    if (!record) return system;
    const merged: SystemConfig = { ...system };
    for (const field of SYSTEM_PREFERENCE_FIELDS) {
        if (record[field] !== undefined) merged[field] = record[field];
    }
    return merged;
}
