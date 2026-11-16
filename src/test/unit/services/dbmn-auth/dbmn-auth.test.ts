// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as sinon from 'sinon';
import {
    DbmnSession,
    DbmnLicenseStatus,
    DbmnUsageStatus,
    DBMN_STORAGE_KEYS,
    DBMN_CACHE_TTL
} from '../../../../types/dbmn-auth';

/**
 * Unit tests for DBMN Auth types and error classes (GitHub Issue #208)
 *
 * Tests:
 * - Type shape validation (DbmnSession, DbmnLicenseStatus, DbmnUsageStatus)
 * - Storage key constants
 * - Cache TTL constants
 */

describe('DBMN Auth Types', () => {

    describe('DbmnSession', () => {
        it('should have required fields', () => {
            const session: DbmnSession = {
                userId: 'user-123',
                email: 'test@example.com',
                displayName: 'Test User',
                accessToken: 'eyJhbGciOiJIUzI1NiJ9.test', // gitleaks:allow (made-up fixture)
                refreshToken: 'refresh-token-abc',
                expiresAt: Math.floor(Date.now() / 1000) + 3600
            };

            expect(session.userId).to.equal('user-123');
            expect(session.email).to.equal('test@example.com');
            expect(session.displayName).to.equal('Test User');
            expect(session.accessToken).to.be.a('string');
            expect(session.refreshToken).to.be.a('string');
            expect(session.expiresAt).to.be.a('number');
        });

        it('should serialize to/from JSON correctly', () => {
            const session: DbmnSession = {
                userId: 'user-456',
                email: 'user@company.com',
                displayName: 'Company User',
                accessToken: 'token-xyz',
                refreshToken: 'refresh-xyz',
                expiresAt: 1735689600
            };

            const json = JSON.stringify(session);
            const parsed: DbmnSession = JSON.parse(json);

            expect(parsed.userId).to.equal(session.userId);
            expect(parsed.email).to.equal(session.email);
            expect(parsed.accessToken).to.equal(session.accessToken);
            expect(parsed.refreshToken).to.equal(session.refreshToken);
            expect(parsed.expiresAt).to.equal(session.expiresAt);
        });
    });

    describe('DbmnLicenseStatus', () => {
        it('should represent a full-access user license', () => {
            const license: DbmnLicenseStatus = {
                licenseType: 'user',
                accessLevel: 'full',
                status: 'active',
                trialEndsAt: null,
                subscriptionEndsAt: '2027-02-25T00:00:00Z',
                licensedEnvironmentUrls: [],
                isLifetime: false,
                fetchedAt: Date.now()
            };

            expect(license.licenseType).to.equal('user');
            expect(license.accessLevel).to.equal('full');
            expect(license.licensedEnvironmentUrls).to.be.an('array').with.length(0);
        });

        it('should represent a trial license with expiry', () => {
            const license: DbmnLicenseStatus = {
                licenseType: 'trial',
                accessLevel: 'full',
                status: 'active',
                trialEndsAt: '2026-03-27T00:00:00Z',
                subscriptionEndsAt: null,
                licensedEnvironmentUrls: [],
                isLifetime: false,
                fetchedAt: Date.now()
            };

            expect(license.licenseType).to.equal('trial');
            expect(license.trialEndsAt).to.not.be.null;
        });

        it('should represent a free tier license', () => {
            const license: DbmnLicenseStatus = {
                licenseType: 'free',
                accessLevel: 'limited',
                status: 'active',
                trialEndsAt: null,
                subscriptionEndsAt: null,
                licensedEnvironmentUrls: [],
                isLifetime: false,
                fetchedAt: Date.now()
            };

            expect(license.licenseType).to.equal('free');
            expect(license.accessLevel).to.equal('limited');
        });

        it('should represent an environment license with URLs', () => {
            const license: DbmnLicenseStatus = {
                licenseType: 'environment',
                accessLevel: 'full',
                status: 'active',
                trialEndsAt: null,
                subscriptionEndsAt: '2027-02-25T00:00:00Z',
                licensedEnvironmentUrls: ['https://prod.samplewms.test', 'https://dev.samplewms.test'],
                isLifetime: false,
                fetchedAt: Date.now()
            };

            expect(license.licensedEnvironmentUrls).to.have.length(2);
        });
    });

    describe('DbmnUsageStatus', () => {
        it('should represent weekly usage counters', () => {
            const usage: DbmnUsageStatus = {
                weekStart: '2026-02-23',
                batchCount: 7,
                exportCount: 3,
                importCount: 1
            };

            expect(usage.weekStart).to.match(/^\d{4}-\d{2}-\d{2}$/);
            expect(usage.batchCount).to.equal(7);
        });
    });

    describe('Storage Keys', () => {
        it('should have correct storage key constants', () => {
            expect(DBMN_STORAGE_KEYS.session).to.equal('dbmn_session');
            expect(DBMN_STORAGE_KEYS.licenseCache).to.equal('dbmn_license_cache');
            expect(DBMN_STORAGE_KEYS.usageCounters).to.equal('dbmn_usage_counters');
        });
    });

    describe('Cache TTL Constants', () => {
        it('should have 15-minute license TTL', () => {
            expect(DBMN_CACHE_TTL.licenseTtlMs).to.equal(15 * 60 * 1000);
        });

        it('should have a 4-week offline grace period (issue #396)', () => {
            expect(DBMN_CACHE_TTL.offlineGracePeriodMs).to.equal(28 * 24 * 60 * 60 * 1000);
        });

        it('has no usage sync any more (0.4.0)', () => {
            expect(DBMN_CACHE_TTL).to.not.have.property('usageSyncIntervalMs');
        });

        it('should have 5-minute telemetry flush interval', () => {
            expect(DBMN_CACHE_TTL.telemetryFlushIntervalMs).to.equal(5 * 60 * 1000);
        });
    });
});

// GitHub Issue #263: authenticateWithPassword removed — magic-link is the only
// sign-in path. The tests that covered the password grant endpoint are gone
// with it.

/**
 * Tests for DbmnAuthService.getCachedLicenseStatus() and isLicenseExpired()
 *
 * These test the logic independently since DbmnAuthService requires vscode.ExtensionContext.
 * We validate the cache lookup and expiry logic patterns used by the service.
 */
describe('DbmnAuthService license caching logic', () => {

    // Helper: simulate the getCachedLicenseStatus logic
    function getCachedLicenseStatus(
        licenseCache: DbmnLicenseStatus | null,
        envLicenseCache: Map<string, DbmnLicenseStatus>,
        environmentUrl?: string
    ): DbmnLicenseStatus | null {
        if (environmentUrl) {
            return envLicenseCache.get(environmentUrl) ?? null;
        }
        return licenseCache;
    }

    // Helper: simulate the isLicenseExpired logic
    function isLicenseExpired(license: DbmnLicenseStatus): boolean {
        const now = new Date().toISOString();
        if (license.trialEndsAt && license.trialEndsAt < now) { return true; }
        if (license.subscriptionEndsAt && license.subscriptionEndsAt < now) { return true; }
        return false;
    }

    function makeLicense(overrides: Partial<DbmnLicenseStatus> = {}): DbmnLicenseStatus {
        return {
            licenseType: 'user',
            accessLevel: 'full',
            status: 'active',
            trialEndsAt: null,
            subscriptionEndsAt: '2027-12-31T00:00:00Z',
            licensedEnvironmentUrls: [],
            isLifetime: false,
            fetchedAt: Date.now(),
            ...overrides
        };
    }

    describe('getCachedLicenseStatus', () => {
        it('should return global license cache when no environmentUrl', () => {
            const license = makeLicense();
            const result = getCachedLicenseStatus(license, new Map());
            expect(result).to.equal(license);
        });

        it('should return null when no global cache and no environmentUrl', () => {
            const result = getCachedLicenseStatus(null, new Map());
            expect(result).to.be.null;
        });

        it('should return env-specific license when environmentUrl matches', () => {
            const envLicense = makeLicense({ licenseType: 'environment' });
            const envCache = new Map<string, DbmnLicenseStatus>();
            envCache.set('https://prod.samplewms.test', envLicense);

            const result = getCachedLicenseStatus(null, envCache, 'https://prod.samplewms.test');
            expect(result).to.equal(envLicense);
        });

        it('should return null when environmentUrl has no cached entry', () => {
            const envCache = new Map<string, DbmnLicenseStatus>();
            const result = getCachedLicenseStatus(makeLicense(), envCache, 'https://unknown.com');
            expect(result).to.be.null;
        });
    });

    describe('isLicenseExpired', () => {
        it('should return false for license with future subscription end date', () => {
            const license = makeLicense({ subscriptionEndsAt: '2027-12-31T00:00:00Z' });
            expect(isLicenseExpired(license)).to.be.false;
        });

        it('should return true for license with past subscription end date', () => {
            const license = makeLicense({ subscriptionEndsAt: '2020-01-01T00:00:00Z' });
            expect(isLicenseExpired(license)).to.be.true;
        });

        it('should return false for license with future trial end date', () => {
            const license = makeLicense({
                licenseType: 'trial',
                trialEndsAt: '2027-06-01T00:00:00Z',
                subscriptionEndsAt: null
            });
            expect(isLicenseExpired(license)).to.be.false;
        });

        it('should return true for license with past trial end date', () => {
            const license = makeLicense({
                licenseType: 'trial',
                trialEndsAt: '2020-01-01T00:00:00Z',
                subscriptionEndsAt: null
            });
            expect(isLicenseExpired(license)).to.be.true;
        });

        it('should return false for free tier with no end dates', () => {
            const license = makeLicense({
                licenseType: 'free',
                accessLevel: 'limited',
                trialEndsAt: null,
                subscriptionEndsAt: null
            });
            expect(isLicenseExpired(license)).to.be.false;
        });

        it('should check trial before subscription when both present', () => {
            // Trial expired but subscription still valid — should return true (trial takes precedence)
            const license = makeLicense({
                trialEndsAt: '2020-01-01T00:00:00Z',
                subscriptionEndsAt: '2027-12-31T00:00:00Z'
            });
            expect(isLicenseExpired(license)).to.be.true;
        });
    });
});

/**
 * Tests for offline/network-failure graceful fallback behaviour.
 *
 * Validates the logic patterns from DbmnAuthService that prevent
 * auto sign-out when the network is down. These test the decision
 * logic independently since DbmnAuthService requires vscode.ExtensionContext.
 */
describe('DbmnAuthService offline fallback logic', () => {

    function makeLicense(overrides: Partial<DbmnLicenseStatus> = {}): DbmnLicenseStatus {
        return {
            licenseType: 'user',
            accessLevel: 'full',
            status: 'active',
            trialEndsAt: null,
            subscriptionEndsAt: '2027-12-31T00:00:00Z',
            licensedEnvironmentUrls: [],
            isLifetime: false,
            fetchedAt: Date.now(),
            ...overrides
        };
    }

    describe('fetchLicenseStatus token refresh fallback', () => {
        // Simulates the token-refresh-failed path in fetchLicenseStatus()
        function fetchLicenseOnRefreshFailure(
            licenseCache: DbmnLicenseStatus | null,
            envLicenseCache: Map<string, DbmnLicenseStatus>,
            environmentUrl?: string
        ): { result: DbmnLicenseStatus | null; signedOut: boolean } {
            // After fix: return cached license, don't sign out
            if (environmentUrl) {
                return { result: envLicenseCache.get(environmentUrl) ?? null, signedOut: false };
            }
            return { result: licenseCache, signedOut: false };
        }

        it('should return global cached license when token refresh fails (no env URL)', () => {
            const cached = makeLicense();
            const { result, signedOut } = fetchLicenseOnRefreshFailure(cached, new Map());
            expect(result).to.equal(cached);
            expect(signedOut).to.be.false;
        });

        it('should return env-specific cached license when token refresh fails', () => {
            const envLicense = makeLicense({ licenseType: 'environment' });
            const envCache = new Map<string, DbmnLicenseStatus>();
            envCache.set('https://prod.samplewms.test', envLicense);

            const { result, signedOut } = fetchLicenseOnRefreshFailure(null, envCache, 'https://prod.samplewms.test');
            expect(result).to.equal(envLicense);
            expect(signedOut).to.be.false;
        });

        it('should return null (not sign out) when no cache exists and token refresh fails', () => {
            const { result, signedOut } = fetchLicenseOnRefreshFailure(null, new Map());
            expect(result).to.be.null;
            expect(signedOut).to.be.false;
        });

        it('should return null for unknown env URL when token refresh fails', () => {
            const { result, signedOut } = fetchLicenseOnRefreshFailure(
                makeLicense(), new Map(), 'https://unknown.samplewms.test'
            );
            expect(result).to.be.null;
            expect(signedOut).to.be.false;
        });
    });

    describe('getLicenseStatus stale cache fallback', () => {
        // Simulates the generic (non-env) path in getLicenseStatus()
        // when fetchLicenseStatus returns null (network failure)
        function getLicenseStatusGenericPath(
            licenseCache: DbmnLicenseStatus | null,
            fetchResult: DbmnLicenseStatus | null
        ): DbmnLicenseStatus | null {
            // After fix: fall back to stale cache instead of returning null
            if (fetchResult) {
                return fetchResult;
            }
            return licenseCache;
        }

        it('should return fresh license when fetch succeeds', () => {
            const stale = makeLicense({ fetchedAt: Date.now() - 86400000 });
            const fresh = makeLicense({ fetchedAt: Date.now() });
            const result = getLicenseStatusGenericPath(stale, fresh);
            expect(result).to.equal(fresh);
        });

        it('should fall back to stale cache when fetch returns null', () => {
            const stale = makeLicense({ fetchedAt: Date.now() - 86400000 });
            const result = getLicenseStatusGenericPath(stale, null);
            expect(result).to.equal(stale);
        });

        it('should return null only when both fetch and cache are null', () => {
            const result = getLicenseStatusGenericPath(null, null);
            expect(result).to.be.null;
        });
    });

    describe('initialize session preservation on refresh failure', () => {
        // Simulates the session handling in initialize() when token is expired
        // and refresh fails
        function initializeSessionOnRefreshFailure(
            session: DbmnSession,
            refreshSucceeded: boolean
        ): DbmnSession | null {
            // After fix: keep session even if refresh fails (network may be down)
            if (session.expiresAt < Date.now() / 1000) {
                if (!refreshSucceeded) {
                    // Before fix: return null (session cleared)
                    // After fix: return session (kept for cached license serving)
                    return session;
                }
            }
            return session;
        }

        it('should keep session when token is expired and refresh fails', () => {
            const expiredSession: DbmnSession = {
                userId: 'user-123',
                email: 'test@example.com',
                displayName: 'Test User',
                accessToken: 'expired-token',
                refreshToken: 'refresh-token',
                expiresAt: Math.floor(Date.now() / 1000) - 3600 // expired 1 hour ago
            };

            const result = initializeSessionOnRefreshFailure(expiredSession, false);
            expect(result).to.not.be.null;
            expect(result!.userId).to.equal('user-123');
            expect(result!.email).to.equal('test@example.com');
        });

        it('should keep session when refresh succeeds', () => {
            const session: DbmnSession = {
                userId: 'user-456',
                email: 'user@example.com',
                displayName: 'User',
                accessToken: 'valid-token',
                refreshToken: 'refresh-token',
                expiresAt: Math.floor(Date.now() / 1000) + 3600
            };

            const result = initializeSessionOnRefreshFailure(session, true);
            expect(result).to.not.be.null;
            expect(result!.userId).to.equal('user-456');
        });

        it('should allow isAuthenticated to return true with stale session', () => {
            const expiredSession: DbmnSession = {
                userId: 'user-789',
                email: 'stale@example.com',
                displayName: 'Stale User',
                accessToken: 'stale-token',
                refreshToken: 'refresh-token',
                expiresAt: Math.floor(Date.now() / 1000) - 7200 // expired 2 hours ago
            };

            const keptSession = initializeSessionOnRefreshFailure(expiredSession, false);
            // isAuthenticated() checks session !== null
            const isAuthenticated = keptSession !== null;
            expect(isAuthenticated).to.be.true;
        });
    });

    describe('confirmed 401 still triggers sign-out', () => {
        // Validates that the 401 sign-out path is preserved (lines 677-684 in service)
        function handleLicenseCheckResponse(
            responseStatus: number,
            licenseCache: DbmnLicenseStatus | null
        ): { result: DbmnLicenseStatus | null; shouldSignOut: boolean } {
            if (responseStatus === 401) {
                // Server confirmed token invalid — sign out
                return { result: null, shouldSignOut: true };
            }
            // Other non-ok status — fall back to cache
            return { result: licenseCache, shouldSignOut: false };
        }

        it('should sign out on confirmed 401 from license endpoint', () => {
            const cached = makeLicense();
            const { result, shouldSignOut } = handleLicenseCheckResponse(401, cached);
            expect(shouldSignOut).to.be.true;
            expect(result).to.be.null;
        });

        it('should fall back to cache on 500 server error', () => {
            const cached = makeLicense();
            const { result, shouldSignOut } = handleLicenseCheckResponse(500, cached);
            expect(shouldSignOut).to.be.false;
            expect(result).to.equal(cached);
        });

        it('should fall back to cache on 503 service unavailable', () => {
            const cached = makeLicense();
            const { result, shouldSignOut } = handleLicenseCheckResponse(503, cached);
            expect(shouldSignOut).to.be.false;
            expect(result).to.equal(cached);
        });
    });
});

/**
 * Tests for the auth_error connectivity latch.
 *
 * Previously, once `connectivityStatus` flipped to `auth_error` (a single failed
 * refresh — RT rotation race after debug-restart, brief Supabase blip, etc.) the
 * latch was permanent until the user manually re-signed-in. The fix introduces a
 * 30-second cooldown so transient causes recover without forcing re-auth.
 */
describe('DbmnAuthService auth_error latch cooldown + give-up', () => {
    const AUTH_ERROR_COOLDOWN_MS = 30 * 1000;
    const AUTH_ERROR_GIVE_UP_AFTER = 2;

    type Status = 'ok' | 'network_error' | 'auth_error';
    interface LatchState {
        connectivityStatus: Status;
        authErrorLatchedAt: number;
        consecutiveAuthErrors: number;
    }

    /** Mirrors the short-circuit decision in ensureValidSession(). */
    function shouldShortCircuit(state: LatchState, now: number): { shortCircuit: boolean; reason: 'ok' | 'cooldown' | 'gave_up' } {
        if (state.connectivityStatus !== 'auth_error') {
            return { shortCircuit: false, reason: 'ok' };
        }
        if (state.consecutiveAuthErrors >= AUTH_ERROR_GIVE_UP_AFTER) {
            return { shortCircuit: true, reason: 'gave_up' };
        }
        if (now - state.authErrorLatchedAt < AUTH_ERROR_COOLDOWN_MS) {
            return { shortCircuit: true, reason: 'cooldown' };
        }
        return { shortCircuit: false, reason: 'ok' };
    }

    function applyRefreshResult(
        state: LatchState,
        result: 'success' | 'auth_error' | 'network_error',
        now: number
    ): LatchState {
        if (result === 'success') {
            return { connectivityStatus: 'ok', authErrorLatchedAt: 0, consecutiveAuthErrors: 0 };
        }
        if (result === 'auth_error') {
            return {
                connectivityStatus: 'auth_error',
                authErrorLatchedAt: now,
                consecutiveAuthErrors: state.consecutiveAuthErrors + 1
            };
        }
        // network_error: leave counter and timestamp alone
        return { ...state, connectivityStatus: 'network_error' };
    }

    it('short-circuits while inside the 30s cooldown after the FIRST failure', () => {
        const latchedAt = 1_000_000;
        const state: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: latchedAt, consecutiveAuthErrors: 1 };
        const r = shouldShortCircuit(state, latchedAt + 15_000);
        expect(r.shortCircuit).to.be.true;
        expect(r.reason).to.equal('cooldown');
    });

    it('allows ONE retry after the cooldown expires (first failure only)', () => {
        const latchedAt = 1_000_000;
        const state: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: latchedAt, consecutiveAuthErrors: 1 };
        const r = shouldShortCircuit(state, latchedAt + 31_000);
        expect(r.shortCircuit).to.be.false;
    });

    it('gives up after 2 consecutive auth_errors — no further retries, ever, until reset', () => {
        const latchedAt = 1_000_000;
        const state: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: latchedAt, consecutiveAuthErrors: 2 };
        // Even an hour later, still short-circuits — RT is definitively dead.
        const r1 = shouldShortCircuit(state, latchedAt + 60 * 60 * 1000);
        expect(r1.shortCircuit).to.be.true;
        expect(r1.reason).to.equal('gave_up');
    });

    it('clears all auth-error state on successful refresh', () => {
        const initial: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: 1_000_000, consecutiveAuthErrors: 1 };
        const next = applyRefreshResult(initial, 'success', 1_031_000);
        expect(next.connectivityStatus).to.equal('ok');
        expect(next.authErrorLatchedAt).to.equal(0);
        expect(next.consecutiveAuthErrors).to.equal(0);
    });

    it('escalates from cooldown to gave-up after a second consecutive auth_error', () => {
        const firstLatch = 1_000_000;
        const initial: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: firstLatch, consecutiveAuthErrors: 1 };
        // After cooldown elapses, retry — and it fails again
        const afterRetry = applyRefreshResult(initial, 'auth_error', firstLatch + 31_000);
        expect(afterRetry.consecutiveAuthErrors).to.equal(2);
        // Now permanently latched, no further retries
        expect(shouldShortCircuit(afterRetry, firstLatch + 10 * 60 * 1000).reason).to.equal('gave_up');
    });

    it('network_error does not increment the consecutive counter (RT may still be valid)', () => {
        const initial: LatchState = { connectivityStatus: 'auth_error', authErrorLatchedAt: 1_000_000, consecutiveAuthErrors: 1 };
        const next = applyRefreshResult(initial, 'network_error', 1_005_000);
        expect(next.consecutiveAuthErrors).to.equal(1);
    });

    it('never short-circuits when status is ok', () => {
        const r = shouldShortCircuit({ connectivityStatus: 'ok', authErrorLatchedAt: 0, consecutiveAuthErrors: 0 }, 1_000_000);
        expect(r.shortCircuit).to.be.false;
    });
});

/**
 * Tests for adoptFreshestStoredSession() decision logic.
 *
 * Cross-process scenario: another extension host rotated the refresh_token and
 * wrote a fresher session to SecretStorage. Before using the in-memory copy for
 * a refresh, we must adopt the stored one if it's fresher — otherwise we'd send
 * a consumed refresh_token to Supabase and get a 401 that latches auth_error.
 */
describe('DbmnAuthService adoptFreshestStoredSession decision', () => {

    function makeSession(refreshToken: string, expiresAt: number): DbmnSession {
        return {
            userId: 'u',
            email: 'e',
            displayName: 'd',
            accessToken: 'a',
            refreshToken,
            expiresAt
        };
    }

    function shouldAdopt(current: DbmnSession | null, stored: DbmnSession): boolean {
        if (!current) {
            return true;
        }
        return stored.refreshToken !== current.refreshToken
            || stored.expiresAt > current.expiresAt;
    }

    it('adopts when in-memory session is null', () => {
        const stored = makeSession('RT-2', 2000);
        expect(shouldAdopt(null, stored)).to.be.true;
    });

    it('adopts when stored refresh_token differs (rotation by other process)', () => {
        const current = makeSession('RT-1', 1000);
        const stored = makeSession('RT-2', 1000);
        expect(shouldAdopt(current, stored)).to.be.true;
    });

    it('adopts when stored expiresAt is newer', () => {
        const current = makeSession('RT-1', 1000);
        const stored = makeSession('RT-1', 2000);
        expect(shouldAdopt(current, stored)).to.be.true;
    });

    it('does not adopt when stored is identical', () => {
        const current = makeSession('RT-1', 1000);
        const stored = makeSession('RT-1', 1000);
        expect(shouldAdopt(current, stored)).to.be.false;
    });

    it('does not adopt when stored is older', () => {
        const current = makeSession('RT-1', 2000);
        const stored = makeSession('RT-1', 1000);
        expect(shouldAdopt(current, stored)).to.be.false;
    });
});
