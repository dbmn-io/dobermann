// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Authentication Types (GitHub Issue #208)
 *
 * Type definitions for DBMN user registration, the account and usage tracking.
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
// Usage Types
// =============================================================================

/** The week the Account page's weekly numbers count from (the server's week, Monday UTC). */
export interface DbmnUsageStatus {
    weekStart: string; // ISO date (YYYY-MM-DD)
}

/**
 * Cache TTL constants
 */
export const DBMN_CACHE_TTL = {
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
 * Represents the full picture: session + usage.
 */
export interface DbmnAuthState {
    isAuthenticated: boolean;
    session: DbmnSession | null;
    usage: DbmnUsageStatus | null;
    telemetryStats: { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats } | null;
    connectivityStatus?: 'ok' | 'network_error' | 'auth_error';
}

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
    // Older versions kept the account's licence and each environment's under these keys.
    // Nothing reads them now; startup deletes them.
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

/** Response from the account Edge Function */
export interface DbmnAccountResponse {
    displayName: string;
    weekStart: string; // ISO date (YYYY-MM-DD)
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

