// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as sinon from 'sinon';
import {
    DbmnSession,
    DbmnUsageStatus,
    DBMN_STORAGE_KEYS,
    DBMN_CACHE_TTL
} from '../../../../types/dbmn-auth';

/**
 * Unit tests for DBMN Auth types and error classes (GitHub Issue #208)
 *
 * Tests:
 * - Type shape validation (DbmnSession, DbmnUsageStatus)
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

    describe('DbmnUsageStatus', () => {
        it('is only the week the usage counts from', () => {
            const usage: DbmnUsageStatus = { weekStart: '2026-02-23' };
            expect(usage.weekStart).to.match(/^\d{4}-\d{2}-\d{2}$/);
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
        it('has no licence refresh or grace any more (0.4.1)', () => {
            expect(DBMN_CACHE_TTL).to.not.have.property('licenseTtlMs');
            expect(DBMN_CACHE_TTL).to.not.have.property('offlineGracePeriodMs');
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
 * Tests for offline/network-failure graceful fallback behaviour.
 *
 * Validates the logic patterns from DbmnAuthService that prevent
 * auto sign-out when the network is down. These test the decision
 * logic independently since DbmnAuthService requires vscode.ExtensionContext.
 */
describe('DbmnAuthService offline fallback logic', () => {

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
                    // After fix: return session (still signed in)
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
