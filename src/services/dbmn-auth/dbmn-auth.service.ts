// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Authentication Service (GitHub Issue #208)
 *
 * Handles DBMN user authentication via browser OAuth-style flow,
 * session management in SecretStorage, the account summary,
 * and usage counter sync.
 *
 * Following Architecture.md:
 * - Browser OAuth flow pattern from tenant-auth-provider.ts
 * - SecretStorage for tokens (same as oauth-token.service.ts)
 * - globalState for the usage week + usage stats
 * - Background timer for usage sync (5min); account summary refreshed on demand
 */

import * as vscode from 'vscode';
import { buildPuppySchoolUrl } from '../badges/badge.service';
import {
    DbmnSession,
    DbmnUsageStatus,
    DbmnTelemetryStats,
    DbmnAuthState,
    DbmnAccountResponse,
    SessionRefreshResult
} from '../../types/dbmn-auth';
import { IDbmnAuthService } from './dbmn-auth.interface';
import { getBackend, dbmnStorageKeys } from '../dbmn-backend/backend-config';

/** Cooldown after the FIRST refresh failure — gives a single retry window for
 *  truly transient causes (sign-in mid-refresh, brief Supabase blip). */
const AUTH_ERROR_COOLDOWN_MS = 30 * 1000;

/** After this many consecutive auth_error refreshes, the refresh_token is
 *  definitively dead (Supabase reuse-detection invalidates the chain on any
 *  double-use, and a dead RT cannot recover on its own). Stop retrying until
 *  either (a) the user signs in, or (b) another process writes a fresh session
 *  to SecretStorage (caught by `onDidChange`). */
const AUTH_ERROR_GIVE_UP_AFTER = 2;

/** Proactive refresh: every interval, refresh the access token if it has less
 *  than this many seconds remaining. Picks up the token before the 60-second
 *  cliff at request time, so transient refresh failures have multiple chances
 *  to recover before the user notices. */
const PROACTIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PROACTIVE_REFRESH_WHEN_REMAINING_S = 10 * 60;

export class DbmnAuthService implements IDbmnAuthService {
    private session: DbmnSession | null = null;
    /** The week the server counts from (the account function). */
    private usageCounters: DbmnUsageStatus | null = null;
    private telemetryStats: { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats } | null = null;

    private proactiveRefreshTimer: ReturnType<typeof setInterval> | null = null;

    private connectivityStatus: 'ok' | 'network_error' | 'auth_error' = 'ok';

    /** When `connectivityStatus` last flipped to `auth_error`. The short-circuit
     *  in `ensureValidSession()` only holds for `AUTH_ERROR_COOLDOWN_MS` after
     *  this timestamp, so a transient refresh failure (interrupted-on-restart,
     *  RT rotation race, brief Supabase blip) doesn't permanently lock the user
     *  out of refresh attempts. */
    private authErrorLatchedAt: number = 0;

    /** Count of consecutive auth_error refreshes. Reset on successful refresh,
     *  sign-in, or adoption of a fresher session from another process. Once it
     *  reaches `AUTH_ERROR_GIVE_UP_AFTER`, we consider the refresh_token dead
     *  and stop retrying entirely — otherwise we'd spam Supabase + the user's
     *  logs every cooldown cycle for a token that cannot recover. */
    private consecutiveAuthErrors: number = 0;

    /** Whether we've already logged the give-up message for the current dead-RT
     *  state. Avoids logging the same line on every short-circuit call. */
    private gaveUpLogged: boolean = false;

    /** In-flight refresh promise — concurrent callers `await` the same
     *  refresh instead of each POSTing their own. Without this, two parallel
     *  callers consume the same refresh_token (Supabase has rotation enabled),
     *  the loser gets 401, and `connectivityStatus` latches to `auth_error`
     *  even though one refresh succeeded. Cleared in `finally`. */
    private inFlightRefresh: Promise<SessionRefreshResult> | null = null;

    private authStateListeners: Array<(state: DbmnAuthState) => void> = [];

    constructor(
        private context: vscode.ExtensionContext
    ) {
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    async initialize(): Promise<void> {
        // Restore session from SecretStorage
        try {
            const sessionJson = await this.context.secrets.get(dbmnStorageKeys().session);
            if (sessionJson) {
                this.session = JSON.parse(sessionJson);

                if (this.session) {
                    const result = await this.ensureValidSession();
                    if (result.status !== 'success') {
                        // Network may be down or token revoked — keep session so isAuthenticated() returns true.
                        console.warn(`[DbmnAuth] Token expired and refresh failed on startup (${result.status}) — keeping session`);
                    }
                }
            }
        } catch (error) {
            console.error('[DbmnAuth] Failed to restore session:', error);
            this.session = null;
        }

        // Restore usage counters from globalState
        const cachedUsage = this.context.globalState.get<DbmnUsageStatus>(dbmnStorageKeys().usageCounters);
        if (cachedUsage) {
            this.usageCounters = cachedUsage;
        }

        // Restore telemetry stats from globalState so the Account view can show
        // the last-known usage numbers immediately (and offline) instead of
        // zeros. Fresh values overwrite this on the next successful fetch.
        const cachedTelemetryStats = this.context.globalState.get<{ weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats }>(
            dbmnStorageKeys().telemetryStatsCache
        );
        if (cachedTelemetryStats) {
            this.telemetryStats = cachedTelemetryStats;
        }

        // No licences from 0.4.0. Older versions kept the account's licence, and every
        // environment address they had checked with the server and its answer: none is used now.
        void this.context.secrets.delete(dbmnStorageKeys().licenseCache);
        void this.context.secrets.delete(dbmnStorageKeys().envLicenseCache);
        void this.context.globalState.update(dbmnStorageKeys().verifiedEnvironments, undefined);

        // Watch for cross-process session updates: another extension host
        // (other VS Code window, or this process before a debug restart) can
        // rotate the refresh_token and write a fresher session to SecretStorage.
        // Pick it up so we don't try to use a stale (consumed) refresh_token.
        this.context.subscriptions.push(
            this.context.secrets.onDidChange(e => {
                if (e.key === dbmnStorageKeys().session) {
                    this.adoptFreshestStoredSession().catch(err => {
                        console.warn('[DbmnAuth] Failed to adopt cross-process session update:', err);
                    });
                }
            })
        );

        // Start background timers if authenticated
        if (this.session) {
            this.startBackgroundTimers();

            // Always do one fire-and-forget background fetch on startup to ensure fresh data
            this.refreshAccount().catch(err => {
                console.warn('[DbmnAuth] Background account fetch failed:', err);
            });
        }

        this.notifyListeners();
    }

    /** Reset all auth-error tracking — call when we have positive evidence that
     *  the current session is good (successful sign-in, successful refresh, or
     *  adoption of a fresher RT from another process). */
    private clearAuthErrorState(): void {
        this.connectivityStatus = 'ok';
        this.authErrorLatchedAt = 0;
        this.consecutiveAuthErrors = 0;
        this.gaveUpLogged = false;
    }

    /**
     * GitHub Issue #396: the server refused this session's access token. Shown as an expired
     * sign-in (the Hub header, Account); nothing is signed out or deleted.
     */
    private markSessionRejected(): void {
        if (this.connectivityStatus === 'auth_error') {
            return;
        }
        this.connectivityStatus = 'auth_error';
        this.authErrorLatchedAt = Date.now();
        this.notifyListeners();
    }

    /** Read the session from SecretStorage and adopt it if it's fresher than
     *  the in-memory copy (newer `expiresAt` or a different `refreshToken`).
     *  Used (a) at the top of `performRefreshSession` to avoid the rotation
     *  race, (b) from the `onDidChange` subscription so cross-window updates
     *  propagate without waiting for a refresh attempt. */
    private async adoptFreshestStoredSession(): Promise<void> {
        let storedJson: string | undefined;
        try {
            storedJson = await this.context.secrets.get(dbmnStorageKeys().session);
        } catch (err) {
            console.warn('[DbmnAuth] Failed to read stored session for adoption:', err);
            return;
        }
        if (!storedJson) {
            return;
        }
        let stored: DbmnSession;
        try {
            stored = JSON.parse(storedJson) as DbmnSession;
        } catch (err) {
            console.warn('[DbmnAuth] Stored session is not valid JSON:', err);
            return;
        }
        if (!stored?.refreshToken || !stored.accessToken) {
            return;
        }
        const current = this.session;
        const isFresher = !current
            || stored.refreshToken !== current.refreshToken
            || stored.expiresAt > current.expiresAt;
        if (!isFresher) {
            return;
        }
        const suffix = stored.refreshToken.slice(-6);
        const rotated = !current || current.refreshToken !== stored.refreshToken;
        console.log(`[DbmnAuth] adopting fresher session from SecretStorage (rt:...${suffix}, rotated:${rotated})`);
        this.session = stored;
        // A rotated RT is a fresh start — clear any latch and reset the failure
        // counter, because the new RT may genuinely be valid. If only expiresAt
        // moved (same RT, refresh succeeded elsewhere), the latch was already
        // wrong-headed too: clear it.
        this.clearAuthErrorState();
        this.notifyListeners();
    }

    dispose(): void {
        this.stopBackgroundTimers();
    }

    // =========================================================================
    // Authentication Flow
    // =========================================================================
    //
    // GitHub Issue #263: browser-redirect and password sign-in were removed.
    // Magic-link OTP is now the only sign-in path; the same call creates new
    // accounts and signs returning users in (issue #258). Sign-in is driven
    // from `sendDbmnSignInLinkInApp` (see services/ui/dbmn-prompts.ts).

    async sendMagicLink(email: string): Promise<void> {
        // Supabase OTP REST endpoint. create_user=true → same link signs in existing users
        // and registers new ones (issue #258). emailRedirectTo points at the auth-callback
        // page used by dbmn.io magic links; it detects ?redirect=vscode and hands the
        // session back via redirectToVSCode().
        const redirectTo = `${getBackend().siteUrl}/account/auth-callback.html?redirect=vscode`;
        const url = `${getBackend().apiUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': getBackend().anonKey
            },
            body: JSON.stringify({ email, create_user: true })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const raw = (errorData as Record<string, string>).msg
                || (errorData as Record<string, string>).error_description
                || (errorData as Record<string, string>).error
                || `Magic link request failed (${response.status})`;
            throw new Error(`${raw} (HTTP ${response.status})`);
        }

        // GitHub Issue #263: remember the email so future sign-in prompts can pre-fill it.
        await this.context.globalState.update(dbmnStorageKeys().lastEmail, email);
    }

    getLastEmail(): string | undefined {
        // GitHub Issue #263: persisted via sendMagicLink and handleAuthCallback,
        // survives sign-out and token expiry.
        return this.context.globalState.get<string>(dbmnStorageKeys().lastEmail);
    }

    async handleAuthCallback(accessToken: string, refreshToken: string): Promise<void> {
        // GitHub Issue #263: only path now — user clicked the magic link in their
        // inbox, dbmn.io/account/auth-callback.html bounced through vscode:// and
        // landed us here with tokens.
        const payload = this.decodeJwtPayload(accessToken);

        const session: DbmnSession = {
            userId: payload.sub,
            email: payload.email,
            displayName: payload.displayName,
            accessToken,
            refreshToken,
            expiresAt: payload.exp
        };

        await this.finalizeSignIn(session);
    }

    /**
     * Direct email + password sign-in (issue #263 removed this; restored for
     * work machines with no inbox access — magic-link needs email, this doesn't).
     * Calls the Supabase password grant and, on success, establishes the session
     * exactly like the magic-link callback.
     */
    async authenticateWithPassword(email: string, password: string): Promise<DbmnSession> {
        const response = await fetch(`${getBackend().apiUrl}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': getBackend().anonKey
            },
            body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const message = (errorData as Record<string, string>).error_description
                || (errorData as Record<string, string>).msg
                || `Sign-in failed (${response.status})`;
            throw new Error(`${message} (HTTP ${response.status})`);
        }

        const data = await response.json();
        const payload = this.decodeJwtPayload(data.access_token);

        const session: DbmnSession = {
            userId: payload.sub,
            email: payload.email,
            displayName: payload.displayName,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: payload.exp
        };

        await this.finalizeSignIn(session);
        return session;
    }

    /**
     * Establish a freshly-obtained session: persist it, reset auth-error state,
     * set the auth context, start timers, refresh the account, notify listeners,
     * and confirm via the portable toast layer. Shared by the magic-link callback
     * and password sign-in so both paths behave identically.
     */
    private async finalizeSignIn(session: DbmnSession): Promise<void> {
        await this.context.secrets.store(dbmnStorageKeys().session, JSON.stringify(session));
        // Remember the email so future sign-in prompts pre-fill it.
        await this.context.globalState.update(dbmnStorageKeys().lastEmail, session.email);
        this.session = session;
        this.clearAuthErrorState();

        await vscode.commands.executeCommand('setContext', 'dbmn.isDbmnAuthenticated', true);
        this.startBackgroundTimers();
        await this.refreshAccount();
        this.notifyListeners();

        // Confirmation via the portable toast layer (issue #263). The auth
        // service isn't constructor-injected with IToastService yet, so we
        // pick it off the global the same way extension.ts publishes it.
        // Falls back to the native VS Code channel only if the toast service
        // isn't wired yet (shouldn't happen post-activation, but safe).
        const toast = (global as Record<string, unknown>).dbmnToastService as
            | { info?: (msg: string) => void }
            | undefined;
        if (toast?.info) {
            toast.info(`Signed in to DBMN as ${session.email}`);
        } else {
            vscode.window.showInformationMessage(`Signed in to DBMN as ${session.email}`);
        }
    }

    async signOut(): Promise<void> {
        this.stopBackgroundTimers();

        // Clear SecretStorage
        await this.context.secrets.delete(dbmnStorageKeys().session);
        // Clear globalState caches
        await this.context.globalState.update(dbmnStorageKeys().usageCounters, undefined);
        await this.context.globalState.update(dbmnStorageKeys().telemetryStatsCache, undefined);

        // Reset in-memory state
        this.session = null;
        this.usageCounters = null;
        this.telemetryStats = null;

        // Update VS Code context
        await vscode.commands.executeCommand('setContext', 'dbmn.isDbmnAuthenticated', false);

        this.notifyListeners();
    }

    isAuthenticated(): boolean {
        return this.session !== null;
    }

    getSession(): DbmnSession | null {
        return this.session;
    }

    async ensureValidSession(): Promise<SessionRefreshResult> {
        if (!this.session) {
            return { status: 'auth_error', httpStatus: 0 };
        }

        const now = Date.now() / 1000;
        const tokenSuffix = this.session.refreshToken ? this.session.refreshToken.slice(-6) : 'none';

        // Token still valid (more than 60s remaining)
        if (this.session.expiresAt >= now + 60) {
            return { status: 'success', session: this.session };
        }

        if (this.connectivityStatus === 'auth_error') {
            // Definitively dead: Supabase has rejected this refresh_token N times
            // in a row. Reuse-detection invalidates the chain on any double-use,
            // so a dead RT cannot recover. Stop retrying until sign-in or until
            // another process writes a fresh session (caught by onDidChange).
            if (this.consecutiveAuthErrors >= AUTH_ERROR_GIVE_UP_AFTER) {
                if (!this.gaveUpLogged) {
                    console.warn(`[DbmnAuth] refresh_token rejected ${this.consecutiveAuthErrors}x in a row — giving up until sign-in (rt:...${tokenSuffix})`);
                    this.gaveUpLogged = true;
                }
                return { status: 'auth_error', httpStatus: 0 };
            }

            // First failure: brief cooldown for transient causes (RT rotation
            // race, sign-in mid-refresh). After cooldown, ONE more attempt is
            // allowed — if it also fails, we hit the give-up threshold above.
            const sinceLatch = Date.now() - this.authErrorLatchedAt;
            if (sinceLatch < AUTH_ERROR_COOLDOWN_MS) {
                return { status: 'auth_error', httpStatus: 0 };
            }
        }

        console.log(`[DbmnAuth] ensureValidSession: attempting refresh (expired ${Math.round(now - this.session.expiresAt)}s ago, rt:...${tokenSuffix}, prior fails: ${this.consecutiveAuthErrors})`);
        // Expired or near-expiry — attempt silent refresh
        const statusBefore = this.connectivityStatus;
        const result = await this.refreshSession();
        if (result.status === 'success') {
            this.clearAuthErrorState();
        } else if (result.status === 'auth_error') {
            this.connectivityStatus = 'auth_error';
            this.authErrorLatchedAt = Date.now();
            this.consecutiveAuthErrors += 1;
        } else {
            this.connectivityStatus = 'network_error';
            // network_error doesn't reflect on the RT's validity — leave the
            // consecutive counter alone so a brief outage isn't mistaken for
            // a dead token.
        }
        // GitHub Issue #396: the Hub header shows an expired sign-in. Tell it when that
        // changes, not only when someone next opens Account.
        if ((statusBefore === 'auth_error') !== (this.connectivityStatus === 'auth_error')) {
            this.notifyListeners();
        }
        return result;
    }

    async refreshSession(): Promise<SessionRefreshResult> {
        // Coalesce concurrent refresh attempts onto a single Supabase call.
        // Each successful refresh rotates the refresh_token; parallel callers
        // would race for the same one and the loser gets 401, which then
        // latches `connectivityStatus` to `auth_error` and locks the user out
        // until they re-sign-in. With this gate, the second caller awaits
        // the first refresh's result and uses the new session.
        if (this.inFlightRefresh) {
            return this.inFlightRefresh;
        }

        this.inFlightRefresh = this.performRefreshSession()
            .finally(() => { this.inFlightRefresh = null; });
        return this.inFlightRefresh;
    }

    private async performRefreshSession(): Promise<SessionRefreshResult> {
        // Adopt freshest session from SecretStorage first. Another extension host
        // (other VS Code window, or this process pre-restart) may have rotated
        // the refresh_token and written RT-N+1 there; the in-memory copy could
        // still hold the now-consumed RT-N. Using a consumed RT here would 401
        // and latch — kill the race by always sourcing from SecretStorage.
        await this.adoptFreshestStoredSession();

        if (!this.session?.refreshToken) {
            return { status: 'auth_error', httpStatus: 0 };
        }

        // If the storage copy was fresher and the access token is now valid,
        // skip the refresh entirely — no need to hit Supabase.
        const now = Date.now() / 1000;
        if (this.session.expiresAt >= now + 60) {
            return { status: 'success', session: this.session };
        }

        try {
            const response = await fetch(`${getBackend().apiUrl}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': getBackend().anonKey
                },
                body: JSON.stringify({ refresh_token: this.session.refreshToken })
            });

            if (!response.ok) {
                // Capture Supabase's response body — the description (e.g.
                // "Invalid Refresh Token: Already Used") is the single richest
                // signal for postmortems. Keep it bounded in case of HTML/etc.
                let body = '';
                try {
                    body = (await response.text()).slice(0, 500);
                } catch {
                    // ignore — body unreadable, status alone still useful
                }
                if (response.status === 400 || response.status === 401) {
                    console.warn(`[DbmnAuth] Token refresh auth error: ${response.status} — ${body}`);
                    return { status: 'auth_error', httpStatus: response.status };
                }
                console.warn(`[DbmnAuth] Token refresh failed: ${response.status} — ${body}`);
                return { status: 'network_error', error: `HTTP ${response.status}` };
            }

            const data = await response.json();
            const payload = this.decodeJwtPayload(data.access_token);

            const newSession: DbmnSession = {
                userId: payload.sub,
                email: payload.email,
                displayName: payload.displayName,
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: payload.exp
            };

            await this.context.secrets.store(dbmnStorageKeys().session, JSON.stringify(newSession));
            this.session = newSession;

            return { status: 'success', session: newSession };
        } catch (error) {
            console.warn('[DbmnAuth] Token refresh error:', error);
            return { status: 'network_error', error: (error as Error).message };
        }
    }

    // =========================================================================
    // Usage
    // =========================================================================

    getUsageStatus(): DbmnUsageStatus | null {
        return this.usageCounters;
    }

    // =========================================================================
    // Auth State
    // =========================================================================

    getAuthState(): DbmnAuthState {
        return {
            isAuthenticated: this.isAuthenticated(),
            session: this.session,
            usage: this.usageCounters,
            telemetryStats: this.telemetryStats,
            connectivityStatus: this.connectivityStatus
        };
    }

    onAuthStateChanged(listener: (state: DbmnAuthState) => void): { dispose: () => void } {
        this.authStateListeners.push(listener);
        return {
            dispose: () => {
                const index = this.authStateListeners.indexOf(listener);
                if (index >= 0) {
                    this.authStateListeners.splice(index, 1);
                }
            }
        };
    }

    // =========================================================================
    // Browser Navigation
    // =========================================================================

    async openAccountPage(): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse(`${getBackend().siteUrl}/account/`));
    }

    /**
     * Puppy School lives on dbmn.io only (decided 2026-09-17) — the extension links to it.
     * The learner signs in there separately; their email rides in the URL fragment so the
     * form is prefilled. See buildPuppySchoolUrl for why a fragment.
     */
    async openPuppySchool(): Promise<void> {
        const email = this.session?.email ?? this.getLastEmail();
        await vscode.env.openExternal(vscode.Uri.parse(buildPuppySchoolUrl(email, getBackend().siteUrl), true));
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    async refreshAccount(includeStats?: boolean): Promise<boolean> {
        if (!this.session) {
            return false;
        }

        try {
            // Ensure token is fresh
            const refreshResult = await this.ensureValidSession();
            if (refreshResult.status !== 'success') {
                // Can't refresh: keep the last known values instead of signing out.
                return false;
            }

            if (!this.session) {
                return false;
            }

            const params = includeStats ? '?include_stats=true' : '';
            const response = await fetch(`${getBackend().apiUrl}/functions/v1/account${params}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.session.accessToken}`,
                    'apikey': getBackend().anonKey
                }
            });

            if (!response.ok) {
                console.error('[DbmnAuth] Account fetch failed:', response.status);
                if (response.status === 401) {
                    // GitHub Issue #396: the server no longer accepts this session (it was
                    // ended elsewhere while the access token still looked valid). That is an
                    // expired sign-in, not a sign-out: keep the session and say so in the Hub.
                    console.warn('[DbmnAuth] Account fetch rejected (401) — sign-in has expired; keeping the session');
                    this.markSessionRejected();
                }
                return false;
            }

            const data: DbmnAccountResponse = await response.json();

            // The server accepted the session: any "expired sign-in" a rejected fetch raised is over.
            if (this.connectivityStatus === 'auth_error') {
                this.clearAuthErrorState();
                this.notifyListeners();
            }

            // The week the server counts from (labels Weekly Usage)
            this.usageCounters = { weekStart: data.weekStart };
            this.persistUsageCounters();

            // Update displayName from server profile (more reliable than JWT metadata)
            if (data.displayName && this.session) {
                this.session.displayName = data.displayName;
                await this.context.secrets.store(dbmnStorageKeys().session, JSON.stringify(this.session));
            }

            // Store telemetry stats if returned (only when include_stats=true).
            // Persist so they survive a reload and can serve the Account view
            // offline (last-known usage instead of zeros).
            if (data.telemetryStats) {
                this.telemetryStats = data.telemetryStats;
                this.persistTelemetryStats();
            }

            this.notifyListeners();
            return true;
        } catch (error) {
            console.warn('[DbmnAuth] Account fetch error (keeping last known values):', error);
            return false;
        }
    }

    private persistUsageCounters(): void {
        if (this.usageCounters) {
            this.context.globalState.update(dbmnStorageKeys().usageCounters, this.usageCounters);
        }
    }

    private persistTelemetryStats(): void {
        if (this.telemetryStats) {
            this.context.globalState.update(dbmnStorageKeys().telemetryStatsCache, this.telemetryStats);
        }
    }

    private startBackgroundTimers(): void {
        this.stopBackgroundTimers();

        // Proactive token refresh — runs every 5 minutes and refreshes the
        // access token if it has less than 10 minutes remaining. Moves recovery
        // off the request-time critical path so transient refresh failures have
        // multiple chances to recover before the user notices.
        this.proactiveRefreshTimer = setInterval(() => {
            const session = this.session;
            if (!session) {
                return;
            }
            // If we've already given up on this RT, don't keep poking — sign-in
            // (or a fresh session adopted from another process) will reset state.
            if (this.consecutiveAuthErrors >= AUTH_ERROR_GIVE_UP_AFTER) {
                return;
            }
            const now = Date.now() / 1000;
            if (session.expiresAt >= now + PROACTIVE_REFRESH_WHEN_REMAINING_S) {
                return;
            }
            this.ensureValidSession().catch(err => {
                console.warn('[DbmnAuth] Proactive token refresh failed:', err);
            });
        }, PROACTIVE_REFRESH_INTERVAL_MS);
    }

    private stopBackgroundTimers(): void {
        if (this.proactiveRefreshTimer) {
            clearInterval(this.proactiveRefreshTimer);
            this.proactiveRefreshTimer = null;
        }
    }

    private notifyListeners(): void {
        const state = this.getAuthState();
        for (const listener of this.authStateListeners) {
            try {
                listener(state);
            } catch (error) {
                console.error('[DbmnAuth] Auth state listener error:', error);
            }
        }
    }

    /**
     * Decode a JWT payload without verification (token was already verified by Supabase).
     */
    private decodeJwtPayload(token: string): { sub: string; email: string; displayName: string; exp: number } {
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }

        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const meta = payload.user_metadata || {};
        return {
            sub: payload.sub,
            email: payload.email || '',
            displayName: meta.full_name || meta.display_name || '',
            exp: payload.exp
        };
    }
}
