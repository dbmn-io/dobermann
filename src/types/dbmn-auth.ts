// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Authentication & Licensing Types (GitHub Issue #208)
 *
 * Type definitions for DBMN user registration, licensing, and usage tracking.
 * These are separate from the environments' OAuth types — the extension manages two
 * independent auth contexts.
 */

// =============================================================================
// Session Types
// =============================================================================

/**
 * DBMN user session stored in VS Code SecretStorage.
 * Contains Supabase JWT tokens for authenticated API calls.
 */
export interface DbmnSession {
    userId: string;
    email: string;
    displayName: string; // from Supabase user_metadata (full_name / display_name)
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix timestamp (seconds)
}

// =============================================================================
// License Types
// =============================================================================

/** License tier types matching Supabase user_licenses.license_type */
export type DbmnLicenseType = 'trial' | 'free' | 'user' | 'environment';

/** License status matching Supabase user_licenses.status */
export type DbmnLicenseStatusValue = 'active' | 'expired' | 'cancelled' | 'suspended';

/** Access level returned by get_effective_license() */
export type DbmnAccessLevel = 'full' | 'limited';

/**
 * License status fetched from Supabase (cached locally).
 * NOT embedded in JWT — fetched separately to avoid reissue on license changes.
 */
export interface DbmnLicenseStatus {
    licenseType: DbmnLicenseType;
    accessLevel: DbmnAccessLevel;
    status: DbmnLicenseStatusValue;
    trialEndsAt: string | null; // ISO 8601
    subscriptionEndsAt: string | null; // ISO 8601
    licensedEnvironmentUrls: string[];
    isLifetime: boolean;
    fetchedAt: number; // Unix timestamp (ms) for cache TTL
}

// =============================================================================
// Usage Types
// =============================================================================

/**
 * Current week's usage counters.
 * The week the server counts from (check-license); 0.4.0 records nothing into it.
 */
export interface DbmnUsageStatus {
    weekStart: string; // ISO date (YYYY-MM-DD)
    batchCount: number;
    exportCount: number;
    importCount: number;
}

/**
 * Cache TTL constants
 */
export const DBMN_CACHE_TTL = {
    licenseTtlMs: 15 * 60 * 1000, // 15 minutes — in-memory license refresh
    // Issue #396: 4 weeks — how long the last known licence is trusted when it cannot be
    // confirmed (offline, or the DBMN session can no longer refresh). After that the user
    // signs in again. This is the default; read `getBackend().licenseGraceMs`, which a dev
    // build can shorten with DBMN_LICENSE_GRACE_MINUTES to test the lapse.
    offlineGracePeriodMs: 28 * 24 * 60 * 60 * 1000,
    telemetryFlushIntervalMs: 5 * 60 * 1000 // 5 minutes — telemetry buffer flush
} as const;

// =============================================================================
// Session Refresh Result
// =============================================================================

/**
 * Discriminated result from refreshSession() — distinguishes auth errors
 * (expired/revoked token) from network errors (API unreachable).
 */
export type SessionRefreshResult =
    | { status: 'success'; session: DbmnSession }
    | { status: 'auth_error'; httpStatus: number }
    | { status: 'network_error'; error: string };

// =============================================================================
// Auth State
// =============================================================================

/**
 * Combined auth state exposed to the extension.
 * Represents the full picture: session + license + usage.
 */
export interface DbmnAuthState {
    isAuthenticated: boolean;
    session: DbmnSession | null;
    /** The account's licence (0.4.0: no environment licences; nothing is gated on it) */
    license: DbmnLicenseStatus | null;
    /** The same: kept for the screens that read it by this name */
    userLicense: DbmnLicenseStatus | null;
    usage: DbmnUsageStatus | null;
    telemetryStats: { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats } | null;
    connectivityStatus?: 'ok' | 'network_error' | 'auth_error';
}

// =============================================================================
// License Gate Results
// =============================================================================

// =============================================================================
// Telemetry Types
// =============================================================================

/**
 * Telemetry event buffer entry — aggregated per day (0.4.0: no environment).
 * Privacy-safe: only counters, never request/response content.
 */
export interface DbmnTelemetryEntry {
    eventDate: string; // ISO date (YYYY-MM-DD)
    apiCalls: number;
    batchRuns: number;
    batchRecords: number;
    batchSuccesses: number;
    batchFailures: number;
    exportRecords: number;
    importRecords: number;
    executionTimeMs: number;
    featuresUsed: Record<string, boolean>;
}

/**
 * Aggregated telemetry stats returned by get_telemetry_stats DB function.
 * Used for the Account dashboard metrics display.
 */
export interface DbmnTelemetryStats {
    apiCalls: number;
    batchRuns: number;
    rowsProcessed: number;
    totalExecutionTimeMs: number;
}

// =============================================================================
// Storage Keys
// =============================================================================

/** Keys used for SecretStorage and globalState */
export const DBMN_STORAGE_KEYS = {
    session: 'dbmn_session',
    licenseCache: 'dbmn_license_cache',
    envLicenseCache: 'dbmn_env_license_cache',
    usageCounters: 'dbmn_usage_counters',
    // Cached weekly + all-time telemetry stats. Persisted so the Account view
    // can show the last-known usage numbers when offline instead of zeros /
    // an endless "Playing Fetch..." placeholder.
    telemetryStatsCache: 'dbmn_telemetry_stats_cache',
    // Telemetry entries recorded but not yet flushed. Persisted on every record so a
    // window reload (the dev loop: build, reload) or a crash cannot lose a batch run.
    telemetryPending: 'dbmn_telemetry_pending',
    // #370: per-endpoint usage recorded but not yet flushed (same rule as telemetryPending).
    telemetryEndpointPending: 'dbmn_telemetry_endpoint_pending',
    verifiedEnvironments: 'dbmn_verified_environments',
    // GitHub Issue #263: last email used for sign-in, persisted across sign-out
    // and token expiry so the sign-in modal can pre-fill it.
    lastEmail: 'dbmn_last_email',
    // #415: the global Systems last fetched, so they stay listed offline and signed out
    globalSystems: 'dbmn_global_systems'
} as const;

// =============================================================================
// Supabase Edge Function Payloads
// =============================================================================

/** Response from check-license Edge Function */
export interface DbmnCheckLicenseResponse {
    license: DbmnLicenseStatus;
    usage: DbmnUsageStatus;
    displayName: string;
    telemetryStats?: { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats };
}

/** Increments recorded while a batch runs, so usage moves member by member (all optional). */
export interface DbmnBatchProgressDelta {
    batchRuns?: number;
    rows?: number;
    successes?: number;
    failures?: number;
    durationMs?: number;
}

