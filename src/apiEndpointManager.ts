// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { Event, EventEmitter } from './platform/events';
import type { StoreContext } from './platform/interfaces/store-context.interface';
import { APIEndpointConfig, APIEndpointCollection, validateEndpointConfig, sanitizeEndpointConfig, createDefaultEndpoint, generateEndpointId } from './apiConfigManager';

export class APIEndpointManager {
    private context: StoreContext;
    private readonly STORAGE_KEY = 'apiEndpoints';
    private readonly CURRENT_VERSION = '1.1.0';
    private _onEndpointsChanged: EventEmitter<void> = new EventEmitter<void>();
    public readonly onEndpointsChanged: Event<void> = this._onEndpointsChanged.event;

    /** #342: the store behind this manager changed (the shared catalogue loaded or reloaded). */
    notifyChanged(): void {
        this._onEndpointsChanged.fire();
    }
    private suppressEvents: boolean = false;

    constructor(context: StoreContext) {
        this.context = context;
    }

    /**
     * Enable batch mode to suppress tree refresh events during bulk operations
     */
    enableBatchMode(): void {
        this.suppressEvents = true;
    }

    /**
     * Disable batch mode and fire a single refresh event
     */
    disableBatchMode(): void {
        this.suppressEvents = false;
        // Fire a single refresh event to update tree after batch operations
        this._onEndpointsChanged.fire();
    }

    async getAllEndpoints(): Promise<APIEndpointConfig[]> {
        const collection = await this.getEndpointCollection();
        return collection.endpoints;
    }

    async getEndpoint(id: string): Promise<APIEndpointConfig | undefined> {
        const endpoints = await this.getAllEndpoints();
        return endpoints.find(endpoint => endpoint.id === id);
    }

    async addEndpoint(config: Partial<APIEndpointConfig>): Promise<APIEndpointConfig> {
        const sanitizedConfig = sanitizeEndpointConfig(config);
        const validationErrors = validateEndpointConfig(sanitizedConfig);

        if (validationErrors.length > 0) {
            throw new Error(`Invalid endpoint configuration: ${validationErrors.join(', ')}`);
        }

        const endpoints = await this.getAllEndpoints();

        if (endpoints.some(endpoint => endpoint.name === sanitizedConfig.name)) {
            throw new Error(`An endpoint with the name "${sanitizedConfig.name}" already exists`);
        }

        endpoints.push(sanitizedConfig);
        await this.saveEndpoints(endpoints);

        return sanitizedConfig;
    }

    async updateEndpoint(id: string, updates: Partial<APIEndpointConfig>, suppressEvents = false): Promise<APIEndpointConfig> {
        // Standard pattern for updating a single endpoint:
        // 1. Load ALL endpoints from storage
        const endpoints = await this.getAllEndpoints();

        // 2. Find the ONE to update
        const index = endpoints.findIndex(endpoint => endpoint.id === id);

        if (index === -1) {
            throw new Error(`Endpoint with ID "${id}" not found`);
        }

        // 3. Merge updates with existing endpoint
        const updatedConfig = sanitizeEndpointConfig({
            ...endpoints[index],
            ...updates,
            id // Ensure ID doesn't change
        });

        const validationErrors = validateEndpointConfig(updatedConfig);
        if (validationErrors.length > 0) {
            throw new Error(`Invalid endpoint configuration: ${validationErrors.join(', ')}`);
        }

        if (endpoints.some(endpoint =>
            endpoint.id !== id &&
            endpoint.name === updatedConfig.name
        )) {
            throw new Error(`An endpoint with the name "${updatedConfig.name}" already exists`);
        }

        // 4. Update the endpoint in the array
        endpoints[index] = updatedConfig;

        // 5. Save ALL endpoints back (this is how VS Code globalState works)
        // VS Code's globalState.update() replaces the entire value, so we must
        // load all, modify one, and save all back to preserve other endpoints
        await this.saveEndpoints(endpoints, undefined, suppressEvents);

        return updatedConfig;
    }

    /**
     * Update several endpoints in ONE storage write (GitHub Issue #310).
     *
     * `updateEndpoint` loads the whole collection and writes the whole
     * collection back for every call — `globalState.update` replaces the
     * value, so there is no cheaper write. Looping it over a selection of
     * thirty endpoints meant thirty full-collection round trips to the
     * extension host's storage, each one queued behind whatever a running
     * batch was doing: the user watched endpoints change one per second.
     *
     * This does the same load → merge → validate → save, once. An endpoint
     * whose merged config fails validation (or whose id is unknown) is
     * reported in `skipped` rather than thrown, so one bad row can't abort
     * the other twenty-nine the way the loop did.
     */
    async updateEndpoints(
        changes: Array<{ id: string; updates: Partial<APIEndpointConfig> }>
    ): Promise<{ updated: APIEndpointConfig[]; skipped: Array<{ id: string; name?: string; reason: string }> }> {
        const updated: APIEndpointConfig[] = [];
        const skipped: Array<{ id: string; name?: string; reason: string }> = [];
        if (!changes.length) return { updated, skipped };

        const endpoints = await this.getAllEndpoints();
        const byId = new Map(endpoints.map((endpoint, index) => [endpoint.id, index]));

        for (const { id, updates } of changes) {
            const index = byId.get(id);
            if (index === undefined) {
                skipped.push({ id, reason: `Endpoint with ID "${id}" not found` });
                continue;
            }

            const merged = sanitizeEndpointConfig({ ...endpoints[index], ...updates, id });
            const validationErrors = validateEndpointConfig(merged);
            if (validationErrors.length > 0) {
                skipped.push({ id, name: endpoints[index].name, reason: validationErrors.join(', ') });
                continue;
            }
            if (endpoints.some(other => other.id !== id && other.name === merged.name)) {
                skipped.push({ id, name: endpoints[index].name, reason: `An endpoint with the name "${merged.name}" already exists` });
                continue;
            }

            endpoints[index] = merged;
            updated.push(merged);
        }

        if (updated.length > 0) {
            await this.saveEndpoints(endpoints);
        }
        return { updated, skipped };
    }

    async deleteEndpoint(id: string): Promise<boolean> {
        const endpoints = await this.getAllEndpoints();
        const initialLength = endpoints.length;
        const filteredEndpoints = endpoints.filter(endpoint => endpoint.id !== id);

        if (filteredEndpoints.length === initialLength) {
            return false; // Endpoint not found
        }

        await this.saveEndpoints(filteredEndpoints);
        return true;
    }

    /**
     * Delete several endpoints in ONE storage write (API Catalogue Select mode → Delete).
     * Same reason as updateEndpoints (#310): globalState.update replaces the whole collection,
     * so a loop of deleteEndpoint would rewrite it once per endpoint. Unknown ids come back in
     * `missing`; nothing matched means nothing is written.
     */
    async deleteEndpoints(ids: string[]): Promise<{ deleted: APIEndpointConfig[]; missing: string[] }> {
        const wanted = new Set(ids);
        const endpoints = await this.getAllEndpoints();
        const deleted = endpoints.filter(endpoint => wanted.has(endpoint.id));
        const found = new Set(deleted.map(endpoint => endpoint.id));
        const missing = ids.filter(id => !found.has(id));

        if (deleted.length > 0) {
            await this.saveEndpoints(endpoints.filter(endpoint => !wanted.has(endpoint.id)));
        }
        return { deleted, missing };
    }

    async duplicateEndpoint(id: string, newName?: string): Promise<APIEndpointConfig> {
        const originalEndpoint = await this.getEndpoint(id);
        if (!originalEndpoint) {
            throw new Error(`Endpoinort with ID "${id}" not found`);
        }

        const duplicatedConfig: Partial<APIEndpointConfig> = {
            ...originalEndpoint,
            name: newName || `${originalEndpoint.name} (Copy)`,
            id: undefined // Will be generated by sanitizeEndpointConfig
        };

        return await this.addEndpoint(duplicatedConfig);
    }

    /**
     * Import endpoints into storage.
     *
     * ⚠️ CRITICAL WARNING ABOUT replaceExisting PARAMETER:
     *
     * When replaceExisting=true:
     *   - This REPLACES ALL ENDPOINTS IN STORAGE with ONLY the endpoints in the array
     *   - If you call importEndpoints([singleEndpoint], true), it will DELETE all other endpoints!
     *   - Use case: Restoring from a complete backup/snapshot
     *   - DO NOT use this in a loop with single endpoints
     *
     * When replaceExisting=false (DEFAULT - SAFE):
     *   - This MERGES new endpoints with existing ones
     *   - Skips endpoints with duplicate names
     *   - Safe for incremental imports
     *
     * COMPARISON TO updateEndpoint():
     *   - updateEndpoint(id, data) is for updating a SINGLE existing endpoint by ID (safe)
     *   - importEndpoints([...], false) is for ADDING multiple new endpoints (safe)
     *   - importEndpoints([...], true) is for REPLACING ALL endpoints (dangerous!)
     *
     * @example Safe usage - merge new endpoints:
     * ```typescript
     * const newEndpoints = [...]; // Array of new endpoints
     * await manager.importEndpoints(newEndpoints, false); // Adds to existing
     * ```
     *
     * @example Dangerous usage - replace all (snapshot restore):
     * ```typescript
     * const snapshotEndpoints = [...]; // Complete backup
     * await manager.importEndpoints(snapshotEndpoints, true); // DELETES all others!
     * ```
     *
     * @example WRONG - causes data loss:
     * ```typescript
     * // ❌ DO NOT DO THIS - it will delete all other endpoints!
     * for (const endpoint of endpoints) {
     *     await manager.importEndpoints([endpoint], true); // DANGER!
     * }
     *
     * // ✅ Instead, use this pattern:
     * await manager.importEndpoints(endpoints, false); // Safe merge
     * ```
     *
     * @param endpoints - Array of endpoints to import
     * @param replaceExisting - If true, REPLACES ALL endpoints with this array (DANGEROUS!)
     *                          If false, MERGES with existing endpoints (SAFE)
     * @returns Number of endpoints imported
     * @see updateEndpoint() for updating a single existing endpoint
     * @see addEndpoint() for adding a single new endpoint
     */
    async importEndpoints(endpoints: APIEndpointConfig[], replaceExisting: boolean = false): Promise<number> {
        if (replaceExisting) {
            // ⚠️ NUCLEAR OPTION: This REPLACES ALL ENDPOINTS IN STORAGE
            // If endpoints = [A, B] and storage has [X, Y, Z], storage will become [A, B]
            // Endpoints X, Y, Z are PERMANENTLY DELETED
            // Only use this for complete snapshot restore, never in a loop!
            await this.saveEndpoints(endpoints);
            return endpoints.length;
        }

        // ✅ SAFE PATH: Merge new endpoints with existing ones
        const existingEndpoints = await this.getAllEndpoints();
        const validEndpoints: APIEndpointConfig[] = [];
        let importedCount = 0;

        for (const endpoint of endpoints) {
            try {
                const sanitizedConfig = sanitizeEndpointConfig(endpoint);
                const validationErrors = validateEndpointConfig(sanitizedConfig);

                if (validationErrors.length > 0) {
                    console.warn(`Skipping invalid endpoint "${endpoint.name}": ${validationErrors.join(', ')}`);
                    continue;
                }

                // Check for duplicate names
                if (existingEndpoints.some(existing => existing.name === sanitizedConfig.name) ||
                    validEndpoints.some(valid => valid.name === sanitizedConfig.name)) {
                    console.warn(`Skipping duplicate endpoint name: "${sanitizedConfig.name}"`);
                    continue;
                }

                validEndpoints.push(sanitizedConfig);
                importedCount++;
            } catch (error) {
                console.warn(`Skipping endpoint "${endpoint.name}": ${error}`);
            }
        }

        if (validEndpoints.length > 0) {
            const allEndpoints = [...existingEndpoints, ...validEndpoints];
            await this.saveEndpoints(allEndpoints);
        }

        return importedCount;
    }

    async exportEndpoints(): Promise<APIEndpointConfig[]> {
        return await this.getAllEndpoints();
    }

    async clearAllEndpoints(): Promise<void> {
        await this.saveEndpoints([], []);
    }

    async createQuickEndpoint(name: string, path: string): Promise<APIEndpointConfig> {
        const defaultEndpoint = createDefaultEndpoint(name, path);
        return await this.addEndpoint(defaultEndpoint);
    }

    // Folder management methods were removed — endpoints group by System +
    // URL-segment tree now. The `folder?` field on individual endpoints is
    // retained as inert legacy data (see APIEndpointConfigSchema).
    // `getFolders` is kept as a read-only helper for legacy code paths.
    async getFolders(): Promise<string[]> {
        const collection = await this.getEndpointCollection();
        const folders = new Set<string>();
        collection.folders.forEach(folder => folders.add(folder));
        collection.endpoints.forEach(endpoint => {
            if (endpoint.folder && endpoint.folder.trim() !== '') {
                folders.add(endpoint.folder.trim());
            }
        });
        return Array.from(folders).sort();
    }

    // Sequence management methods
    async getNextSequence(endpointId: string): Promise<number> {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) {
            throw new Error(`Endpoint with ID "${endpointId}" not found`);
        }

        // #366: signed in, the counter is the account's (atomic across devices)
        const counters = this.context.runCounters;
        if (counters) return counters.next(endpointId);

        const nextSequence = (endpoint.sequenceCounter || 0) + 1;

        // Update the endpoint with the new sequence counter (suppress events for operational changes)
        await this.updateEndpoint(endpointId, {
            sequenceCounter: nextSequence
        }, true);

        return nextSequence;
    }

    async resetSequence(endpointId: string): Promise<void> {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) {
            throw new Error(`Endpoint with ID "${endpointId}" not found`);
        }

        const counters = this.context.runCounters;
        if (counters) {
            await counters.reset(endpointId);
            return;
        }

        await this.updateEndpoint(endpointId, {
            sequenceCounter: 0
        });
    }

    /**
     * GitHub Issue #153: Get next sequence number for a specific array path
     * Used by the :global sequence modifier in nested arrays
     *
     * @param endpointId - The endpoint ID
     * @param arrayPath - The array path (e.g., "orders[].items" or "OriginalOrderLine")
     * @returns The next sequence number for this array path
     */
    async getNextArraySequence(endpointId: string, arrayPath: string): Promise<number> {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) {
            throw new Error(`Endpoint with ID "${endpointId}" not found`);
        }

        const counters = this.context.runCounters;
        if (counters) return counters.next(endpointId, arrayPath);

        // Get current counters or initialize
        const arrayCounters = endpoint.arraySequenceCounters || {};
        const currentValue = arrayCounters[arrayPath] || 0;
        const nextValue = currentValue + 1;

        // Update the endpoint with the new counter
        await this.updateEndpoint(endpointId, {
            arraySequenceCounters: {
                ...arrayCounters,
                [arrayPath]: nextValue
            }
        }, true); // Suppress events for operational changes

        return nextValue;
    }

    /**
     * GitHub Issue #153: Reset sequence counter for a specific array path
     * If no arrayPath provided, resets all array sequence counters
     *
     * @param endpointId - The endpoint ID
     * @param arrayPath - Optional specific array path to reset
     */
    async resetArraySequence(endpointId: string, arrayPath?: string): Promise<void> {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) {
            throw new Error(`Endpoint with ID "${endpointId}" not found`);
        }

        const counters = this.context.runCounters;
        if (counters) {
            await (arrayPath ? counters.reset(endpointId, arrayPath) : counters.resetArrays(endpointId));
            return;
        }

        if (arrayPath) {
            // Reset specific array path
            const arrayCounters = { ...(endpoint.arraySequenceCounters || {}) };
            delete arrayCounters[arrayPath];

            await this.updateEndpoint(endpointId, {
                arraySequenceCounters: arrayCounters
            });
        } else {
            // Reset all array sequence counters
            await this.updateEndpoint(endpointId, {
                arraySequenceCounters: {}
            });
        }
    }


    private async getEndpointCollection(): Promise<APIEndpointCollection> {
        const stored = await this.context.globalState.get<APIEndpointCollection>(this.STORAGE_KEY);

        if (!stored) {
            return {
                endpoints: [],
                folders: [],
                version: this.CURRENT_VERSION
            };
        }

        // Handle version migrations if needed
        if (stored.version !== this.CURRENT_VERSION) {
            return await this.migrateEndpointCollection(stored);
        }

        return stored;
    }

    /**
     * Save endpoints to VS Code global state storage.
     *
     * IMPORTANT: This method REPLACES the entire endpoint collection in storage.
     * VS Code's globalState.update() does not merge - it replaces the whole value.
     *
     * Always ensure you pass ALL endpoints you want to keep, not just the ones you're adding/updating.
     *
     * @param endpoints - Complete array of ALL endpoints to store
     * @param folders - Optional folder list (preserves current if not provided)
     * @param suppressEvents - If true, don't fire change events
     */
    private async saveEndpoints(endpoints: APIEndpointConfig[], folders?: string[], suppressEvents = false): Promise<void> {
        const currentCollection = await this.getEndpointCollection();
        const collection: APIEndpointCollection = {
            endpoints,  // This REPLACES all endpoints in storage
            folders: folders || currentCollection.folders,
            version: this.CURRENT_VERSION
        };

        // REPLACES entire collection - does not merge!
        await this.context.globalState.update(this.STORAGE_KEY, collection);

        // Only fire events if not suppressed
        if (!suppressEvents && !this.suppressEvents) {
            this._onEndpointsChanged.fire();
        }
    }

    private async migrateEndpointCollection(collection: APIEndpointCollection): Promise<APIEndpointCollection> {

        const migrated: APIEndpointCollection = {
            endpoints: collection.endpoints || [],
            folders: collection.folders || [],
            version: this.CURRENT_VERSION
        };

        // Save directly to storage without triggering events to avoid migration loop
        await this.context.globalState.update(this.STORAGE_KEY, migrated);

        return migrated;
    }
}