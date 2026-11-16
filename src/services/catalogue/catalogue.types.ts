// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #339: the API Catalogue as it is shared between VS Code and the web app (#338): endpoint
 * templates, systems and environments. No secrets and no per-device state. Produce these with
 * `catalogue-safe-form.ts`, never by hand.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { EnvironmentConfig } from '../../environmentManager';
import type { SystemConfig } from '../../data-loading/system-schema';

/** Counters that change on every run: shared through `CatalogStore.nextSequence`, not the template. */
export type EndpointCounterField = 'sequenceCounter' | 'arraySequenceCounters';

/** Which environment is selected right now, and what this device last did with it. Never shared. */
export const DEVICE_LOCAL_ENVIRONMENT_FIELDS = ['isActive', 'lastUsed'] as const;
export type DeviceLocalEnvironmentField = typeof DEVICE_LOCAL_ENVIRONMENT_FIELDS[number];

export type CatalogueEndpoint = Omit<APIEndpointConfig, EndpointCounterField>;

export type CatalogueEnvironment = Omit<EnvironmentConfig, DeviceLocalEnvironmentField> & {
    /** Credentials were held back; each device enters them into its own vault. */
    credentialsRequired?: boolean;
    /** Names of `variables` whose values are secret: shared as names only, values stay local. */
    secretVariables?: string[];
};

export type CatalogueSystem = SystemConfig;

/**
 * #365: one scope's Console views (#237), shared like the rest of the catalogue. The id is the
 * scope key (`getEndpointViewScopeKey`: method + path, or `orphan:<endpointId>`).
 */
export interface CatalogueConsoleViews {
    id: string;
    /** Per Console tab (`success`, `errors`): its views, active and default view. */
    views: Record<string, unknown>;
}

export type CatalogueKind = 'endpoints' | 'systems' | 'environments' | 'views';

/** A stored item with the version a write must name to replace it (optimistic concurrency). */
export interface Versioned<T> {
    item: T;
    version: number;
    updatedAt: number;
}
