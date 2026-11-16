// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Authentication & Licensing Service Interfaces (GitHub Issue #208)
 *
 * Interface definitions for DBMN registration, licensing, and telemetry services.
 * Following Architecture.md: interface-first design with DI pattern.
 */

import {
    DbmnBatchProgressDelta,
    DbmnTelemetryStats,
    DbmnSession,
    DbmnLicenseStatus,
    DbmnUsageStatus,
    DbmnAuthState,
    DbmnTelemetryEntry,
    SessionRefreshResult
} from '../../types/dbmn-auth';

// =============================================================================
// IDbmnAuthService — Main authentication and licensing orchestrator
// =============================================================================

/**
 * Main DBMN authentication service.
 * Handles browser OAuth flow, session storage, license fetching, and usage sync.
 */
export interface IDbmnAuthService {
    /**
     * Send a magic-link sign-in email. Sign-in completes asynchronously when the user
     * clicks the link in their inbox — the link lands on dbmn.io's auth-callback page,
     * which redirects back into VS Code via the registered URI handler.
     *
     * Uses create_user=true so the same call covers new-user signup and returning
     * sign-in (issue #258). On success persists the email via globalState so future
     * prompts can pre-fill it after sign-out or token expiry (issue #263).
     *
     * @param email - User email to send the magic link to
     */
    sendMagicLink(email: string): Promise<void>;

    /**
     * Direct email + password sign-in via the Supabase password grant. Restored
     * for environments with no inbox access (e.g. locked-down work machines)
     * where the magic-link flow isn't usable. On success the session is
     * established exactly like the magic-link callback and the promise resolves
     * with the new session; on failure it throws with the provider's message.
     *
     * @param email - User email
     * @param password - User password
     */
    authenticateWithPassword(email: string, password: string): Promise<DbmnSession>;

    /**
     * GitHub Issue #263: Get the last email used for sign-in, persisted across
     * sign-out and token expiry. Used by sign-in prompts to pre-fill the email
     * field when there's no active session. Undefined on a fresh install.
     */
    getLastEmail(): string | undefined;

    /**
     * Sign out — clears session from SecretStorage and resets state.
     */
    signOut(): Promise<void>;

    /**
     * Check if the user is currently authenticated (has valid session).
     */
    isAuthenticated(): boolean;

    /**
     * Get the current session (from SecretStorage cache).
     * Returns null if not authenticated.
     */
    getSession(): DbmnSession | null;

    /**
     * Refresh the session tokens using the refresh token.
     * Called automatically when access token expires.
     */
    refreshSession(): Promise<SessionRefreshResult>;

    /**
     * Ensure the DBMN session has a valid (non-expired) access token.
     * If expired, silently attempts refresh. Returns the result status.
     * Callers can use this to decide whether to prompt re-authentication.
     */
    ensureValidSession(): Promise<SessionRefreshResult>;

    /**
     * Get the current license status.
     * Fetches fresh data only when the cached license has expired (trial/subscription end date passed).
     */
    getLicenseStatus(): Promise<DbmnLicenseStatus | null>;

    /**
     * Get cached license status synchronously (no network calls).
     * Returns whatever is in the in-memory cache (restored from SecretStorage on startup).
     * Use this for non-blocking UI rendering (e.g., tree views).
     */
    getCachedLicenseStatus(): DbmnLicenseStatus | null;

    /**
     * The week the server counts usage from (labels Weekly Usage). 0.4.0 records nothing
     * into it: the counts are telemetry's (IDbmnTelemetry).
     */
    getUsageStatus(): DbmnUsageStatus | null;

    /**
     * Get full auth state (session + license + usage).
     */
    getAuthState(): DbmnAuthState;

    /**
     * Fetch fresh license status from the server.
     * Also updates displayName from the user profile. Never sends an environment address.
     * @param includeStats - When true, fetches telemetry stats (for Account dashboard)
     */
    fetchLicenseStatus(includeStats?: boolean): Promise<DbmnLicenseStatus | null>;

    /**
     * Initialize the service — restore session from SecretStorage, start background timers.
     * Called during extension activation.
     */
    initialize(): Promise<void>;

    /**
     * Dispose the service — stop background timers, flush pending usage.
     */
    dispose(): void;

    /**
     * Event fired when auth state changes (login, logout, license update).
     * @param listener - Callback receiving the new auth state
     * @returns Disposable to unregister the listener
     */
    onAuthStateChanged(listener: (state: DbmnAuthState) => void): { dispose: () => void };

    /**
     * Open the account/upgrade page in the browser.
     */
    openAccountPage(): Promise<void>;

    /**
     * Open Puppy School on dbmn.io in the browser, sign-in email prefilled.
     */
    openPuppySchool(): Promise<void>;

    /**
     * Handle the URI callback from the browser auth flow.
     * Called by the URI handler in extension.ts.
     * @param accessToken - Supabase access token
     * @param refreshToken - Supabase refresh token
     */
    handleAuthCallback(accessToken: string, refreshToken: string): Promise<void>;
}

// =============================================================================
// IDbmnStatusBar — License status display in VS Code status bar
// =============================================================================

/**
 * Status bar service for DBMN license status display.
 * Shows at priority 110 (leftmost, before environment status at 100).
 */
export interface IDbmnStatusBar {
    /**
     * Update the status bar display based on current auth state.
     * @param state - Current DBMN auth state
     */
    update(state: DbmnAuthState): void;

    /**
     * Dispose the status bar item.
     */
    dispose(): void;
}

// =============================================================================
// IDbmnTelemetry — Privacy-safe usage telemetry
// =============================================================================

/**
 * Telemetry service — buffers usage events and flushes to Supabase.
 * Privacy-safe: only aggregate counters, never request/response content.
 */
export interface IDbmnTelemetry {
    /** Record one API call (0.4.0: counted per day, nothing about which environment or endpoint). */
    recordApiCall(): void;

    /**
     * Record a batch run.
     * @param recordCount - Total records in the batch
     * @param successCount - Successful records
     * @param failureCount - Failed records
     */
    recordBatchRun(recordCount: number, successCount: number, failureCount: number): void;

    /**
     * Record part of a batch while it runs: the run itself once, then rows, outcomes and
     * elapsed time per completed member. recordBatchRun() is the same thing in one call.
     */
    recordBatchProgress(delta: DbmnBatchProgressDelta): void;

    /**
     * Record an export operation.
     * @param recordCount - Number of records exported
     */
    recordExport(recordCount: number): void;

    /**
     * Record an import operation.
     * @param recordCount - Number of records imported
     */
    recordImport(recordCount: number): void;

    /**
     * Record a feature usage flag.
     * @param featureFlag - The feature flag name
     */
    recordFeatureUsage(featureFlag: string): void;

    /**
     * Record execution duration.
     * @param durationMs - Execution duration in milliseconds
     */
    recordExecutionTime(durationMs: number): void;

    /**
     * Flush buffered telemetry events to Supabase.
     * Called every 5 minutes and on extension deactivation.
     */
    flush(): Promise<void>;

    /**
     * Counters recorded on this machine that the last stats fetched from the server do not
     * include yet: still buffered, or flushed since markStatsSynced(). The Account view adds
     * them to the server numbers so usage moves while a run is in progress.
     */
    getUnsyncedStats(): { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats };

    /**
     * Fresh server stats have arrived: everything flushed before now is in them.
     */
    markStatsSynced(): void;

    /**
     * Fires after every record and after every successful flush.
     */
    onDidChange(listener: () => void): { dispose(): void };

    /**
     * Dispose — flush and stop background timer.
     */
    dispose(): void;
}
