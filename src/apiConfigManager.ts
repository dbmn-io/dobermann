// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    DataLoadingConfig,
    APIEndpointConfig,
    validateAPIEndpointConfig
} from './data-loading/types';
import { Flavour } from './data-loading/zod-schemas';

// Re-export APIEndpointConfig for backward compatibility
export type { APIEndpointConfig } from './data-loading/types';

export interface APIEndpointCollection {
    endpoints: APIEndpointConfig[];
    folders: string[];
    version: string;
}

export const DEFAULT_ENDPOINT_CONFIG: Partial<APIEndpointConfig> = {
    method: 'GET',
    headers: {},
    queryParams: {},
    description: ''
};

export function createDefaultEndpoint(name: string, path: string): APIEndpointConfig {
    return {
        id: generateEndpointId(),
        name,
        path,
        method: 'GET',
        headers: {},
        queryParams: {},
        description: ''
    };
}

export function generateEndpointId(): string {
    return `endpoint_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function generateFlavourId(): string {
    return `flavour_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Reconcile the legacy `body` field and the new `flavours[]` collection so the
 * record is internally consistent regardless of which path produced it.
 *
 * Rules — applied in this order:
 *   1. If `flavours` is non-empty, the *first* flavour is canonical: copy its
 *      body and bodyWithComments up to the endpoint level so legacy consumers
 *      (editor, console, batch) keep working.
 *   2. Else if a legacy `body` is set, wrap it in a single Default flavour so
 *      every record carries the new shape from this point forward.
 *   3. Else: produce a single empty Default flavour. Every Endpoint always has
 *      at least one Flavour — that keeps callers from having to defend against
 *      `flavours.length === 0`.
 */
export function reconcileFlavours(
    body: string | undefined,
    bodyWithComments: string | undefined,
    flavours: Flavour[] | undefined
): { body: string | undefined; bodyWithComments: string | undefined; flavours: Flavour[] } {
    if (flavours && flavours.length > 0) {
        const normalised: Flavour[] = flavours.map((f, i) => ({
            id: (f.id && f.id.trim()) ? f.id : generateFlavourId(),
            name: (f.name && f.name.trim()) ? f.name.trim() : (i === 0 ? 'Default' : `Flavour ${i + 1}`),
            body: f.body?.trim() || undefined,
            bodyWithComments: f.bodyWithComments?.trim() || undefined,
            queryParams: f.queryParams
        }));

        // Editors that don't yet know about flavours (the current endpoint
        // editor in particular — flavours are P1a schema-only) just pass
        // `body` + `bodyWithComments` on save. Without this sync, the
        // sanitizer would prefer `flavours[0]` from the stored record and
        // silently drop every body edit the user made. Explicit body params
        // win over the stale primary flavour and propagate back into it.
        const bodyProvided = body !== undefined;
        const bwcProvided = bodyWithComments !== undefined;
        if (bodyProvided || bwcProvided) {
            const explicitBody = bodyProvided ? (body!.trim() || undefined) : normalised[0].body;
            const explicitBodyWithComments = bwcProvided
                ? (bodyWithComments!.trim() || undefined)
                : normalised[0].bodyWithComments;
            normalised[0] = {
                ...normalised[0],
                body: explicitBody,
                bodyWithComments: explicitBodyWithComments
            };
        }

        return {
            body: normalised[0].body,
            bodyWithComments: normalised[0].bodyWithComments,
            flavours: normalised
        };
    }
    const trimmedBody = body?.trim() || undefined;
    const trimmedBodyWithComments = bodyWithComments?.trim() || undefined;
    return {
        body: trimmedBody,
        bodyWithComments: trimmedBodyWithComments,
        flavours: [{
            id: generateFlavourId(),
            name: 'Default',
            body: trimmedBody,
            bodyWithComments: trimmedBodyWithComments
        }]
    };
}

export function validateEndpointConfig(config: APIEndpointConfig): string[] {
    // Use Zod validation for comprehensive type checking
    const validation = validateAPIEndpointConfig(config);
    return validation.success ? [] : validation.errors || [];
}

export function sanitizeEndpointConfig(config: Partial<APIEndpointConfig>): APIEndpointConfig {
    const reconciled = reconcileFlavours(config.body, config.bodyWithComments, config.flavours);
    const dedupedTags = config.tags
        ? Array.from(new Set(config.tags.map(t => t.trim()).filter(Boolean)))
        : undefined;
    return {
        id: (config.id && !config.id.startsWith('temp_')) ? config.id : generateEndpointId(),
        name: (config.name || '').trim(),
        path: (config.path || '').trim(),
        method: config.method || 'GET',
        headers: config.headers || {},
        queryParams: config.queryParams || {},
        body: reconciled.body,
        bodyWithComments: reconciled.bodyWithComments,
        description: (config.description || '').trim(),
        folder: config.folder?.trim() || undefined,
        systemId: config.systemId?.trim() || undefined,
        tags: dedupedTags,
        flavours: reconciled.flavours,
        dataLoadingConfig: config.dataLoadingConfig,
        sequenceCounter: config.sequenceCounter || 0,
        // GitHub Issue #153: Preserve array sequence counters
        arraySequenceCounters: config.arraySequenceCounters || {},
        // GitHub Issue #126: Preserve environment headers opt-out setting
        useEnvironmentHeaders: config.useEnvironmentHeaders,
        // GitHub Issue #229: Preserve console views so export/import carries them
        consoleViews: config.consoleViews
    };
}