// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * System references in .dbmn.zip exports (GitHub Issue #290).
 *
 * A System is effectively just its name, and System IDs are generated per
 * install — two people who each create "acmewms" get different IDs. So exports
 * carry `systemName` instead of `systemId`, and import matches (or creates)
 * Systems by name. Matching on ID would duplicate Systems across installs.
 *
 * Exports written before #290 carry only `systemId`. Import keeps an ID the
 * install already knows; for an unknown ID it creates a System that reuses the
 * ID (so re-importing the same file lands on the same System) and names it
 * with the System migration's heuristic.
 *
 * Pure planning only — the service performs the writes.
 */

import { APIEndpointConfig } from '../../apiConfigManager';
import { EnvironmentConfig } from '../../environmentManager';
import { SystemConfig, SHORT_NAME_MAX_LENGTH, generateSystemId } from '../../data-loading/system-schema';
import { pickSystemNameFromCluster } from '../migration/system-migration.service';

/** A System reference on an exported or imported endpoint/environment. */
export interface SystemRef {
    systemId?: string;
    systemName?: string;
}

/**
 * Swap an item's `systemId` for its System's name. An ID that points at no
 * System is dropped rather than exported as a dangling reference.
 */
export function toExportedSystemRef<T extends SystemRef>(item: T, systems: SystemConfig[]): T {
    const { systemId, systemName: _staleName, ...rest } = item;
    const name = systemId ? systems.find(s => s.id === systemId)?.name : undefined;
    return (name ? { ...rest, systemName: name } : rest) as T;
}

export interface ImportedSystemPlan {
    /** Systems this install doesn't have yet — add them before writing items. */
    systemsToCreate: Array<Pick<SystemConfig, 'id' | 'name'>>;
    /** The item with `systemId` pointing at a local System and `systemName` removed. */
    resolve<T extends SystemRef>(item: T): T;
}

/**
 * Work out which local System each imported item belongs to, and which
 * Systems must be created first. `endpoints` and `environments` must be every
 * item that will be written, so legacy naming sees the whole cluster.
 */
export function planImportedSystems(
    endpoints: Array<APIEndpointConfig & SystemRef>,
    environments: Array<EnvironmentConfig & SystemRef>,
    existingSystems: SystemConfig[]
): ImportedSystemPlan {
    const idByName = new Map<string, string>(); // lowercased name → local System ID
    const knownIds = new Set<string>();
    for (const existing of existingSystems) {
        idByName.set(existing.name.toLowerCase(), existing.id);
        knownIds.add(existing.id);
    }

    const systemsToCreate: Array<Pick<SystemConfig, 'id' | 'name'>> = [];
    const addSystem = (id: string, name: string): void => {
        systemsToCreate.push({ id, name });
        idByName.set(name.toLowerCase(), id);
        knownIds.add(id);
    };

    // 1. Named references — match case-insensitively, otherwise create.
    for (const item of [...endpoints, ...environments]) {
        const name = nameOf(item);
        if (name && !idByName.has(name.toLowerCase())) {
            addSystem(generateSystemId(), name);
        }
    }

    // 2. Legacy ID-only references to Systems this install doesn't have.
    const isLegacyRefTo = (id: string) => (item: SystemRef) => !nameOf(item) && item.systemId === id;
    const unknownIds = new Set(
        [...endpoints, ...environments]
            .filter(item => !nameOf(item) && item.systemId && !knownIds.has(item.systemId))
            .map(item => item.systemId as string)
    );
    let fallbackIndex = 1;
    for (const id of unknownIds) {
        const picked = pickSystemNameFromCluster(
            endpoints.filter(isLegacyRefTo(id)),
            environments.filter(isLegacyRefTo(id)),
            fallbackIndex
        );
        // Same counter rule as the System migration: "sysa", "sysb", …
        if (picked.startsWith('sys')) fallbackIndex++;
        addSystem(id, uniqueName(picked, idByName));
    }

    return {
        systemsToCreate,
        resolve: <T extends SystemRef>(item: T): T => {
            const { systemId, systemName: _name, ...rest } = item;
            const name = nameOf(item);
            const resolvedId = name ? idByName.get(name.toLowerCase()) : systemId;
            return (resolvedId ? { ...rest, systemId: resolvedId } : rest) as T;
        }
    };
}

function nameOf(item: SystemRef): string | undefined {
    return item.systemName?.trim() || undefined;
}

/** `base`, or `base2`, `base3`… trimmed to the System name length limit. */
function uniqueName(base: string, taken: Map<string, string>): string {
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const suffix = String(n);
        const candidate = base.slice(0, SHORT_NAME_MAX_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}
