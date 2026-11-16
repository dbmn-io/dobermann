// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #359: OAuth refresh tokens, the same in every host. Sign-in keeps the provider's refresh token
 * in the vault (ISecretStore: VS Code's SecretStorage, the web app's encrypted vault, later a
 * desktop app's keychain), never in the catalogue or plain state. When the access token has
 * expired, or a request comes back 401, the refresh token gets a new one without a browser; only
 * when the provider refuses it (expired, revoked) does the user sign in again.
 *
 *   keep(id, token)   after a sign-in or refresh: the refresh token (a rotated one replaces it)
 *   refresh(id)       a new access token, saved where the environment's token lives; undefined
 *                     when there's no refresh token or it didn't work (then: sign in)
 *   forget(id)        sign-out, environment deleted
 *
 * One refresh per environment at a time: a batch running eight at once that all get a 401
 * shares one refresh, rather than spending a rotated refresh token eight times.
 *
 * A refresh never undoes a sign-out. Sign out (`forget`) or sign in again (`keep`) while a
 * refresh is on its way, and that refresh's answer is dropped: nothing is saved, so a "signed
 * in?" check that happened to start one can't sign the user back in. Callers forget FIRST when
 * signing out, before removing the session, so no check in between finds a token to use.
 *
 * And a forgotten token stays forgotten here, whatever the vault says: VS Code's SecretStorage
 * can hand a deleted secret back for a moment (measured 2026-10-11: store, delete 150 ms later,
 * and a get 100 ms after that returned the stored value; gone for good half a second on). So
 * `forget` is remembered in memory until the next `keep`.
 */
import type { ISecretStore } from '../../platform/interfaces/secret-store.interface';
import type { OAuthConfig, OAuthRefreshRequest, OAuthToken } from '../../types/oauth';
import { OAuthRefreshError } from './oauth-flow-handler';

/** The vault key; VS Code's OAuthTokenService has always used this name. */
export const refreshTokenKey = (environmentId: string) => `oauth_refresh_${environmentId}`;

export interface OAuthRefreshPorts {
    vault: ISecretStore;
    flow: { refreshAccessToken(request: OAuthRefreshRequest): Promise<OAuthToken> };
    /** The environment's OAuth settings, client secret included (from the vault). */
    config(environmentId: string): Promise<OAuthConfig | undefined>;
    /** Save the new access token where the environment's token lives. */
    saveAccessToken(environmentId: string, token: OAuthToken): Promise<void>;
    log?: (message: string, error?: unknown) => void;
}

export class OAuthTokenRefresher {
    private readonly inFlight = new Map<string, Promise<string | undefined>>();
    /** Counts each environment's sign-ins and sign-outs: a refresh begun before one is stale after it. */
    private readonly changes = new Map<string, number>();
    /** Forgotten since the last keep: the vault isn't asked (it can still answer for a moment). */
    private readonly forgotten = new Set<string>();

    private changed(environmentId: string): void {
        this.changes.set(environmentId, (this.changes.get(environmentId) ?? 0) + 1);
    }

    constructor(private readonly ports: OAuthRefreshPorts) {}

    async keep(environmentId: string, token: Pick<OAuthToken, 'refresh_token'>): Promise<void> {
        this.changed(environmentId);
        if (!token.refresh_token) return;
        this.forgotten.delete(environmentId);
        await this.ports.vault.store(refreshTokenKey(environmentId), token.refresh_token);
    }

    async has(environmentId: string): Promise<boolean> {
        return !this.forgotten.has(environmentId) && !!(await this.ports.vault.get(refreshTokenKey(environmentId)));
    }

    async forget(environmentId: string): Promise<void> {
        this.changed(environmentId);
        this.forgotten.add(environmentId);
        await this.ports.vault.delete(refreshTokenKey(environmentId));
    }

    /** A new access token from the refresh token, or undefined (none, refused, or no answer). */
    refresh(environmentId: string): Promise<string | undefined> {
        const running = this.inFlight.get(environmentId);
        if (running) return running;
        const attempt = this.attempt(environmentId).finally(() => this.inFlight.delete(environmentId));
        this.inFlight.set(environmentId, attempt);
        return attempt;
    }

    private async attempt(environmentId: string): Promise<string | undefined> {
        if (this.forgotten.has(environmentId)) return undefined;
        const before = this.changes.get(environmentId) ?? 0;
        const refreshToken = await this.ports.vault.get(refreshTokenKey(environmentId));
        if (!refreshToken) return undefined;
        const config = await this.ports.config(environmentId);
        if (!config?.tokenUrl) return undefined;
        try {
            const token = await this.ports.flow.refreshAccessToken({ config, refreshToken, environmentId });
            if ((this.changes.get(environmentId) ?? 0) !== before) {
                // Signed out (or in again) while this was on its way: its answer is nobody's now
                this.ports.log?.(`[OAuth] dropped a refresh for ${environmentId}: it was signed out or in again meanwhile`);
                return undefined;
            }
            await this.ports.saveAccessToken(environmentId, token);
            if (token.refresh_token && token.refresh_token !== refreshToken) await this.ports.vault.store(refreshTokenKey(environmentId), token.refresh_token);
            this.ports.log?.(`[OAuth] refreshed the access token for ${environmentId} without signing in`);
            return token.access_token;
        } catch (error) {
            if (error instanceof OAuthRefreshError && error.refused) {
                // Expired or revoked: no use keeping it; the next step is signing in
                await this.forget(environmentId);
                this.ports.log?.(`[OAuth] the provider refused the refresh token for ${environmentId}: sign in again`, error);
            } else {
                this.ports.log?.(`[OAuth] could not refresh the access token for ${environmentId}`, error);
            }
            return undefined;
        }
    }
}
