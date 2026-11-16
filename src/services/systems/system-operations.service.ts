// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { APIEndpointManager } from '../../apiEndpointManager';
import { EnvironmentManager } from '../../environmentManager';
import { SystemManager } from '../../systemManager';
import { normaliseTags } from '../../utils/tag-normalizer';

/**
 * Host-side bulk operations on Systems (GitHub Issue #275):
 *   - setEndpointsSystem: reassign a chosen set of endpoints to one System
 *     (the "bulk Set System" action in the API Catalogue's select mode)
 *   - mergeSystems: fold one or more source Systems into a target, moving
 *     everything that referenced a source (endpoints AND environments) onto
 *     the target, then deleting the now-empty source Systems.
 *
 * Endpoints and environments reference a System by its stable `systemId`
 * (never by name), so every operation here is a `systemId` rewrite routed
 * through the owning manager — `updateEndpoints` (one storage write for the
 * whole selection, GitHub Issue #310) and `updateEnvironment` — so the same
 * persistence + reactivity path fires that a manual edit would.
 *
 * This is the structural analogue of TagManagerService.mergeTags, adapted from
 * a `string[]` tag rewrite to a scalar `systemId` rewrite that also has to keep
 * environments in step (tags never lived on environments).
 */
export interface SetSystemResult {
    /** Endpoints in the selection that now carry the target System. */
    touched: number;
    /** Endpoints the manager refused to write (validation), with why. */
    skipped: Array<{ id: string; name?: string; reason: string }>;
}

export interface SystemMergeSummary {
    endpointsTouched: number;
    environmentsTouched: number;
    deletedSystemIds: string[];
    targetSystemId: string;
}

export class SystemOperationsService {
    constructor(
        private readonly systemManager: SystemManager,
        private readonly endpointManager: APIEndpointManager,
        private readonly environmentManager: EnvironmentManager
    ) {}

    /**
     * Reassign the given endpoints to `targetSystemId`. Pass `null`/empty to
     * clear the System (endpoints become unassigned). `touched` is how many
     * of the selected endpoints now carry the target System — the count the
     * user selected (that still exist and were not skipped), NOT just the
     * ones that needed a write.
     *
     * One `updateEndpoints` call for the whole selection: the old
     * per-endpoint `updateEndpoint` loop rewrote the entire collection once
     * per endpoint and crawled while a batch was running (GitHub Issue #310).
     */
    async setEndpointsSystem(endpointIds: string[], targetSystemId: string | null): Promise<SetSystemResult> {
        const target = (targetSystemId || '').trim() || undefined;

        // A real (non-clear) target must exist — guard against a stale picker.
        if (target && !(await this.systemManager.getSystem(target))) {
            throw new Error(`System "${target}" no longer exists`);
        }

        const ids = new Set((endpointIds || []).filter(Boolean));
        if (ids.size === 0) return { touched: 0, skipped: [] };

        const matching = (await this.endpointManager.getAllEndpoints())
            .filter(e => ids.has(e.id))
            .map(e => ({ id: e.id, systemId: e.systemId }));
        if (matching.length === 0) return { touched: 0, skipped: [] };

        const changes = matching
            .filter(endpoint => (endpoint.systemId || undefined) !== target) // already there
            .map(endpoint => ({ id: endpoint.id, updates: { systemId: target } }));

        const { skipped } = changes.length
            ? await this.endpointManager.updateEndpoints(changes)
            : { skipped: [] };
        return { touched: matching.length - skipped.length, skipped };
    }

    /**
     * API Catalogue Select mode → Update: on every selected endpoint, set the System
     * (`systemId`: an id sets it, `null` clears it, absent leaves it), remove `removeTags`, then
     * add `addTags`. Tags are normalised as the Tag Manager does. One `updateEndpoints` call
     * (#310), carrying only the endpoints that actually change; `touched` counts those.
     */
    async updateSelection(
        endpointIds: string[],
        update: { systemId?: string | null; addTags?: string[]; removeTags?: string[] }
    ): Promise<SetSystemResult> {
        const setSystem = update.systemId !== undefined;
        const target = setSystem ? ((update.systemId || '').trim() || undefined) : undefined;
        if (target && !(await this.systemManager.getSystem(target))) {
            throw new Error(`System "${target}" no longer exists`);
        }
        const add = normaliseTags(update.addTags);
        const remove = new Set(normaliseTags(update.removeTags));

        const ids = new Set((endpointIds || []).filter(Boolean));
        const changes: Array<{ id: string; updates: { systemId?: string; tags?: string[] } }> = [];
        for (const endpoint of await this.endpointManager.getAllEndpoints()) {
            if (!ids.has(endpoint.id)) continue;
            const updates: { systemId?: string; tags?: string[] } = {};
            if (setSystem && (endpoint.systemId || undefined) !== target) updates.systemId = target;
            if (add.length || remove.size) {
                const before = normaliseTags(endpoint.tags);
                const after = normaliseTags([...before.filter(t => !remove.has(t)), ...add]);
                if (after.join('\n') !== (endpoint.tags || []).join('\n')) updates.tags = after;
            }
            if (Object.keys(updates).length) changes.push({ id: endpoint.id, updates });
        }

        const { skipped } = changes.length ? await this.endpointManager.updateEndpoints(changes) : { skipped: [] };
        return { touched: changes.length - skipped.length, skipped };
    }

    /**
     * Merge every `sourceIds` System into `targetSystemId`: move all endpoints
     * and environments off the sources and onto the target, then delete the
     * source Systems. The target is dropped from the source set so a system
     * can't be merged into itself.
     */
    async mergeSystems(sourceIds: string[], targetSystemId: string): Promise<SystemMergeSummary> {
        const target = (targetSystemId || '').trim();
        if (!target) throw new Error('A target System is required to merge into');
        if (!(await this.systemManager.getSystem(target))) {
            throw new Error('Target System no longer exists');
        }

        const sources = new Set((sourceIds || []).filter(Boolean));
        sources.delete(target); // never merge a system into itself
        if (sources.size === 0) {
            return { endpointsTouched: 0, environmentsTouched: 0, deletedSystemIds: [], targetSystemId: target };
        }

        // 1. Reassign endpoints — one storage write for all of them (#310).
        const endpoints = await this.endpointManager.getAllEndpoints();
        const changes = endpoints
            .filter(endpoint => !!endpoint.systemId && sources.has(endpoint.systemId))
            .map(endpoint => ({ id: endpoint.id, updates: { systemId: target } }));
        const endpointsTouched = changes.length
            ? (await this.endpointManager.updateEndpoints(changes)).updated.length
            : 0;

        // 2. Reassign environments. Must happen before deleting the source
        //    Systems, otherwise environments would be left pointing at a
        //    System id that no longer exists.
        const environments = await this.environmentManager.getAllEnvironments();
        let environmentsTouched = 0;
        for (const env of environments) {
            if (!env.systemId || !sources.has(env.systemId)) continue;
            await this.environmentManager.updateEnvironment(env.id, { systemId: target });
            environmentsTouched++;
        }

        // 3. Delete the now-orphaned source Systems.
        const deletedSystemIds: string[] = [];
        for (const sourceId of sources) {
            if (await this.systemManager.deleteSystem(sourceId)) {
                deletedSystemIds.push(sourceId);
            }
        }

        return { endpointsTouched, environmentsTouched, deletedSystemIds, targetSystemId: target };
    }
}
