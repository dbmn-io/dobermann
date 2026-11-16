// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Phase 1B.17 + Issue #237 — the saved Console Views of an endpoint. Moved out of
 * ConsoleController (#298) so Compare reads and writes the very same Views: a View changed in
 * either screen is the endpoint's View.
 *
 * Storage: a registry in small persistent state, scoped by URL+method, so endpoints sharing a
 * URL+method share one View library. Orphan executions (endpoint deleted) keep their own scope
 * under `orphan:<endpointId>`. The endpoint's `consoleViews` carries a mirror so an endpoint
 * export takes its Views along. In the web app the registry syncs as catalogue items (#365).
 */
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { APIEndpointConfig } from '../../apiConfigManager';
import {
    getEndpointViewScopeKey,
    isV2ConsoleViewsRegistry,
    migrateConsoleViewsRegistry,
    stripAutoDefaultForMirror,
    ConsoleViewsRegistryV2
} from './view-scope-key';

export const VIEWS_REGISTRY_KEY = 'consoleViewsRegistry';

export interface ConsoleViewsStoreDeps {
    state: Pick<IKeyValueStore, 'get' | 'update'>;
    endpoints?: {
        getEndpoint(id: string): Promise<APIEndpointConfig | undefined>;
        updateEndpoint(id: string, updates: Partial<APIEndpointConfig>, suppressEvents?: boolean): Promise<unknown>;
    };
    log?: (message: string) => void;
}

export class ConsoleViewsStore {
    constructor(private readonly deps: ConsoleViewsStoreDeps) {}

    private log(message: string): void {
        this.deps.log?.(message);
    }

    private async getOrMigrateRegistry(): Promise<ConsoleViewsRegistryV2> {
        const raw = this.deps.state.get(VIEWS_REGISTRY_KEY);
        if (isV2ConsoleViewsRegistry(raw)) {
            return raw;
        }
        if (!raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) {
            return { schemaVersion: 2, scopes: {} };
        }
        const { registry, migrated, renamed } = await migrateConsoleViewsRegistry(
            raw as Record<string, unknown>,
            endpointId => this.resolveScopeKey(endpointId)
        );
        await this.deps.state.update(VIEWS_REGISTRY_KEY, registry);
        this.log(`[ConsoleViews] Migrated ${migrated} legacy entries → ${Object.keys(registry.scopes).length} scopes (${renamed} renamed for collision)`);
        return registry;
    }

    /**
     * The scope key for an endpoint: its method+path, or a stable `orphan:<id>` key so the
     * views of a deleted endpoint remain reachable for that execution.
     */
    async resolveScopeKey(endpointId: string): Promise<string> {
        const endpointManager = this.deps.endpoints;
        if (!endpointManager) return `orphan:${endpointId}`;
        try {
            const endpoint = await endpointManager.getEndpoint(endpointId);
            if (endpoint) return getEndpointViewScopeKey(endpoint.method, endpoint.path);
        } catch {
            // fall through to orphan
        }
        return `orphan:${endpointId}`;
    }

    private async writeViewsToRegistry(scopeKey: string, views: unknown): Promise<void> {
        const registry = await this.getOrMigrateRegistry();
        registry.scopes[scopeKey] = views;
        await this.deps.state.update(VIEWS_REGISTRY_KEY, registry);
    }

    /**
     * Issue #229 / #237: Load views for an endpoint.
     * 1. Registry (canonical) keyed by URL+method scope.
     * 2. Fall back to endpoint.consoleViews (legacy embedded + recently-imported endpoints).
     *    On hit, materialize into the registry so future loads stay canonical.
     * Returns null when neither has anything; caller synthesises a Root view.
     */
    async load(endpointId: string): Promise<Record<string, unknown> | null> {
        const scopeKey = await this.resolveScopeKey(endpointId);
        const registry = await this.getOrMigrateRegistry();
        const fromRegistry = registry.scopes[scopeKey];
        if (fromRegistry && typeof fromRegistry === 'object') {
            return fromRegistry as Record<string, unknown>;
        }
        const endpointManager = this.deps.endpoints;
        if (!endpointManager) return null;
        const endpoint = await endpointManager.getEndpoint(endpointId).catch(() => undefined);
        if (!endpoint || !endpoint.consoleViews) return null;
        // Materialize legacy embedded views into the URL-keyed scope so the
        // registry becomes canonical for this URL+method on next load.
        try {
            await this.writeViewsToRegistry(scopeKey, endpoint.consoleViews);
        } catch (err) {
            this.log(`[loadConsoleViews] materialize from endpoint.consoleViews failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return endpoint.consoleViews as unknown as Record<string, unknown>;
    }

    /**
     * Issue #229 / #237: Persist views.
     * - Always write to the registry under the URL+method scope (canonical,
     *   survives endpoint deletion, shared across endpoints with same URL+method).
     * - When the endpoint exists, also mirror to endpoint.consoleViews so
     *   endpoint export/import keeps carrying views to recipients.
     * - Issue #242: auto-generated DEFAULT views are stripped from the mirror
     *   so they don't travel with endpoint export — recipients regenerate
     *   from their own first response.
     */
    async save(endpointId: string, views: unknown): Promise<void> {
        const scopeKey = await this.resolveScopeKey(endpointId);
        await this.writeViewsToRegistry(scopeKey, views);

        const endpointManager = this.deps.endpoints;
        if (!endpointManager) return;
        try {
            const endpoint = await endpointManager.getEndpoint(endpointId);
            if (!endpoint) return; // orphan — registry is enough
            const mirrorViews = stripAutoDefaultForMirror(views);
            await endpointManager.updateEndpoint(
                endpointId,
                { consoleViews: mirrorViews as APIEndpointConfig['consoleViews'] },
                /* suppressEvents */ true
            );
        } catch (err) {
            this.log(`[saveConsoleViews] endpoint mirror skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
