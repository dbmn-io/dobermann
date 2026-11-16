// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #359: refresh tokens kept in the vault and used before signing in again.
 */
import { expect } from 'chai';
import { OAuthRefreshError } from '../../../services/oauth/oauth-flow-handler';
import { OAuthTokenRefresher, refreshTokenKey } from '../../../services/oauth/oauth-refresh';
import type { ISecretStore } from '../../../platform/interfaces/secret-store.interface';
import type { OAuthConfig, OAuthRefreshRequest, OAuthToken } from '../../../types/oauth';

class MemoryVault implements ISecretStore {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

const config = { tokenUrl: 'https://login.example/token', clientId: 'app' } as OAuthConfig;
const token = (access: string, refresh?: string): OAuthToken =>
    ({ access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer', issued_at: 0 } as OAuthToken);

function setUp(refreshAccessToken: (request: OAuthRefreshRequest) => Promise<OAuthToken>) {
    const vault = new MemoryVault();
    const saved: Array<[string, string]> = [];
    const requests: OAuthRefreshRequest[] = [];
    const refresher = new OAuthTokenRefresher({
        vault,
        flow: { refreshAccessToken: request => { requests.push(request); return refreshAccessToken(request); } },
        config: async () => config,
        saveAccessToken: async (id, t) => { saved.push([id, t.access_token]); }
    });
    return { vault, saved, requests, refresher };
}

describe('OAuthTokenRefresher (#359)', () => {
    it('keeps the refresh token from a sign-in in the vault, and nothing when there is none', async () => {
        const { vault, refresher } = setUp(async () => token('new'));
        await refresher.keep('env-1', token('a'));
        expect(await refresher.has('env-1')).to.equal(false);
        await refresher.keep('env-1', token('a', 'rt-1'));
        expect(vault.values.get(refreshTokenKey('env-1'))).to.equal('rt-1');
        expect(await refresher.has('env-1')).to.equal(true);
    });

    it('refreshes: the new access token is saved and returned; a rotated refresh token replaces the old', async () => {
        const { vault, saved, requests, refresher } = setUp(async () => token('access-2', 'rt-2'));
        await refresher.keep('env-1', token('access-1', 'rt-1'));
        expect(await refresher.refresh('env-1')).to.equal('access-2');
        expect(requests[0].refreshToken).to.equal('rt-1');
        expect(requests[0].config).to.equal(config);
        expect(saved).to.deep.equal([['env-1', 'access-2']]);
        expect(vault.values.get(refreshTokenKey('env-1'))).to.equal('rt-2');
    });

    it('without a refresh token there is nothing to try', async () => {
        const { requests, refresher } = setUp(async () => token('x'));
        expect(await refresher.refresh('env-1')).to.equal(undefined);
        expect(requests).to.have.length(0);
    });

    it('a refused refresh token (expired, revoked) is forgotten: the next step is signing in', async () => {
        const { vault, refresher } = setUp(async () => { throw new OAuthRefreshError('Token refresh failed (400): invalid_grant', true); });
        await refresher.keep('env-1', token('a', 'rt-1'));
        expect(await refresher.refresh('env-1')).to.equal(undefined);
        expect(vault.values.has(refreshTokenKey('env-1'))).to.equal(false);
    });

    it('no answer from the provider keeps the refresh token for next time', async () => {
        const { vault, refresher } = setUp(async () => { throw new TypeError('Failed to fetch'); });
        await refresher.keep('env-1', token('a', 'rt-1'));
        expect(await refresher.refresh('env-1')).to.equal(undefined);
        expect(vault.values.get(refreshTokenKey('env-1'))).to.equal('rt-1');
    });

    it('eight requests that all got a 401 share one refresh', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { requests, refresher } = setUp(async () => { await gate; return token('access-2', 'rt-2'); });
        await refresher.keep('env-1', token('a', 'rt-1'));
        const all = Promise.all(Array.from({ length: 8 }, () => refresher.refresh('env-1')));
        release();
        expect(await all).to.deep.equal(Array(8).fill('access-2'));
        expect(requests).to.have.length(1);
        // Done: the next expiry refreshes again
        expect(await refresher.refresh('env-1')).to.equal('access-2');
        expect(requests).to.have.length(2);
    });

    it('signing out while a refresh is on its way: its answer is dropped, nobody is signed back in', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { vault, saved, refresher } = setUp(async () => { await gate; return token('access-2', 'rt-2'); });
        await refresher.keep('env-1', token('a', 'rt-1'));
        const refreshing = refresher.refresh('env-1');   // a "signed in?" check started it
        await new Promise(resolve => setTimeout(resolve, 0));
        await refresher.forget('env-1');                 // Sign Out
        release();
        expect(await refreshing).to.equal(undefined);
        expect(saved, 'no access token saved').to.deep.equal([]);
        expect(vault.values.has(refreshTokenKey('env-1')), 'no refresh token kept').to.equal(false);
    });

    it('signing in again while a refresh is on its way: the new sign-in stands', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { vault, saved, refresher } = setUp(async () => { await gate; return token('stale-access', 'stale-rt'); });
        await refresher.keep('env-1', token('a', 'rt-1'));
        const refreshing = refresher.refresh('env-1');
        await new Promise(resolve => setTimeout(resolve, 0));
        await refresher.keep('env-1', token('fresh-access', 'fresh-rt'));   // New Token
        release();
        expect(await refreshing).to.equal(undefined);
        expect(saved).to.deep.equal([]);
        expect(vault.values.get(refreshTokenKey('env-1'))).to.equal('fresh-rt');
    });

    it('a vault that still hands back a deleted secret for a moment (VS Code does): forgotten stays forgotten', async () => {
        const { vault, requests, refresher } = setUp(async () => token('access-2', 'rt-2'));
        await refresher.keep('env-1', token('a', 'rt-1'));
        vault.delete = async () => undefined;             // the delete hasn't landed yet
        await refresher.forget('env-1');                  // Sign Out
        expect(await refresher.has('env-1')).to.equal(false);
        expect(await refresher.refresh('env-1'), 'no refresh with a token that was signed out').to.equal(undefined);
        expect(requests).to.have.length(0);
        // Signing in again keeps a new one, and that one is used
        await refresher.keep('env-1', token('b', 'rt-new'));
        expect(await refresher.refresh('env-1')).to.equal('access-2');
        expect(requests[0].refreshToken).to.equal('rt-new');
    });

    it('forget removes it (sign-out, environment deleted)', async () => {
        const { refresher } = setUp(async () => token('x'));
        await refresher.keep('env-1', token('a', 'rt-1'));
        await refresher.forget('env-1');
        expect(await refresher.has('env-1')).to.equal(false);
    });
});
