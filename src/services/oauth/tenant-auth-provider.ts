// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Tenant Authentication Provider: VS Code's AuthenticationProvider for an environment's OAuth
 * sign-in (one session per environment). Which System the environment belongs to decides the
 * sign-in URLs, the token request and the claims (#415); nothing here is any System's.
 *
 * Following Architecture.md - VS Code API integration patterns
 */

import * as vscode from 'vscode';
import { 
    OAuthConfig, 
    OAuthToken, 
    OAuthSession, 
    OAuthStatus,
    TokenPayload,
    PKCEChallenge
} from '../../types/oauth';
import { IOAuthConfigService, IOAuthFlowHandler } from './oauth.interface';
import { runOAuthSignIn, startOAuthSignIn } from './oauth-sign-in';
import { identityOf } from '../systems/system-claims';
import type { OAuthTokenRefresher } from './oauth-refresh';

interface TenantAuthSession extends vscode.AuthenticationSession {
    environmentId: string;
    tokenPayload?: TokenPayload;
}

export class TenantAuthProvider implements vscode.AuthenticationProvider {
    private static readonly PROVIDER_ID = 'dbmn-oauth';
    // Shown in VS Code's Accounts menu. DBMN's own name: no product names in user-facing copy.
    private static readonly PROVIDER_LABEL = 'DBMN OAuth';
    
    private sessions: Map<string, TenantAuthSession> = new Map();
    private sessionToEnvironmentMap: Map<string, string> = new Map();
    private onDidChangeSessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    private sessionsLoadPromise: Promise<void>;
    /** #359: keeps each sign-in's refresh token in the vault (set by the extension). */
    refresher?: OAuthTokenRefresher;
    
    constructor(
        private context: vscode.ExtensionContext,
        private configService: IOAuthConfigService,
        private flowHandler: IOAuthFlowHandler
    ) {
        this.sessionsLoadPromise = this.loadStoredSessions();
    }

    get onDidChangeSessions() {
        return this.onDidChangeSessionsEmitter.event;
    }

    async getSessions(scopes?: string[]): Promise<TenantAuthSession[]> {
        return Array.from(this.sessions.values());
    }

    async createSession(scopes: string[]): Promise<TenantAuthSession> {
        // For this implementation, we need to determine which environment to authenticate for
        // This would typically be passed through a custom scope or determined from context
        const environmentId = await this.determineEnvironmentForAuthentication();
        
        if (!environmentId) {
            throw new Error('No environment selected for authentication');
        }

        const config = await this.configService.getConfig(environmentId);
        if (!config) {
            throw new Error(`No OAuth configuration found for environment: ${environmentId}`);
        }

        // Validate configuration
        const validation = await this.configService.validateConfig(config);
        if (!validation.isValid) {
            throw new Error(`OAuth configuration invalid: ${validation.errors.join(', ')}`);
        }

        return await this.performAuthenticationFlow(environmentId, config, scopes);
    }

    async removeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        // Remove from maps
        this.sessions.delete(sessionId);
        this.sessionToEnvironmentMap.delete(sessionId);

        // Clear stored session
        await this.clearStoredSession(session.environmentId);

        // Notify VS Code of session removal
        this.onDidChangeSessionsEmitter.fire({
            added: [],
            removed: [session],
            changed: []
        });
    }

    /**
     * Get session for a specific environment
     */
    async getSessionForEnvironment(environmentId: string): Promise<TenantAuthSession | undefined> {
        // Wait for sessions to finish loading before checking
        await this.sessionsLoadPromise;
        
        return Array.from(this.sessions.values()).find(session => session.environmentId === environmentId);
    }

    /**
     * Create session for a specific environment (used by OAuth service)
     */
    async createSessionForEnvironment(environmentId: string, scopes: string[] = []): Promise<TenantAuthSession> {
        const config = await this.configService.getConfig(environmentId);
        if (!config) {
            throw new Error(`No OAuth configuration found for environment: ${environmentId}`);
        }

        return await this.performAuthenticationFlow(environmentId, config, scopes);
    }

    /**
     * Force new session (refresh token)
     */
    async forceNewSession(environmentId: string): Promise<TenantAuthSession> {
        // Remove existing session first
        const existingSession = await this.getSessionForEnvironment(environmentId);
        if (existingSession) {
            await this.removeSession(existingSession.id);
        }

        // Create new session
        return await this.createSessionForEnvironment(environmentId);
    }

    /**
     * Request a new token with forced re-authentication (prompt=login).
     * Signs out the existing session first, then triggers a fresh OAuth flow
     * that forces the IdP to require credentials (bypassing browser SSO).
     */
    async requestNewToken(environmentId: string): Promise<TenantAuthSession> {
        // Remove existing session first
        const existingSession = await this.getSessionForEnvironment(environmentId);
        if (existingSession) {
            await this.removeSession(existingSession.id);
        }

        const config = await this.configService.getConfig(environmentId);
        if (!config) {
            throw new Error(`No OAuth configuration found for environment: ${environmentId}`);
        }

        return await this.performAuthenticationFlow(environmentId, config, [], { forceLogin: true });
    }

    private async performAuthenticationFlow(
        environmentId: string,
        config: OAuthConfig,
        scopes: string[],
        options?: { forceLogin?: boolean }
    ): Promise<TenantAuthSession> {

        const environmentName = (await this.configService.getEnvironmentName?.(environmentId)) || 'your environment';

        // The browser does the sign-in; the shared flow (#343) does the rest. Progress (with
        // Cancel) shows while VS Code waits for the browser to come back.
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Signing in to ${environmentName}…`,
            cancellable: true
        }, async (progress, token) => {
            const oauthToken = await runOAuthSignIn(this.flowHandler, {
                environmentId,
                config,
                scopes,
                forceLogin: options?.forceLogin,
                open: async url => {
                    try {
                        await vscode.env.clipboard.writeText(url);   // for manual testing
                    } catch {
                        // Could not copy to clipboard - continue anyway
                    }
                    return vscode.env.openExternal(vscode.Uri.parse(url));
                },
                // #361: the URI handler hands the browser's answer back (state checked), or the
                // sign-in page's error at once instead of a 60-second timeout
                waiting: cancel => {
                    progress.report({ message: 'Waiting for browser authentication...' });
                    token.onCancellationRequested(() => cancel('Authentication cancelled by user'));
                }
            });

            return this.keepSession(environmentId, oauthToken, scopes);
        });
    }

    /** A signed-in token becomes this environment's session: kept, and announced to VS Code. */
    private async keepSession(environmentId: string, oauthToken: OAuthToken, scopes: string[]): Promise<TenantAuthSession> {
        const session = await this.createVSCodeSession(environmentId, oauthToken, scopes, (await this.configService.getConfig(environmentId))?.system);
        // One session per environment: a sign-in replaces whatever was there
        const replaced = Array.from(this.sessions.values()).filter(existing => existing.environmentId === environmentId);
        for (const old of replaced) {
            this.sessions.delete(old.id);
            this.sessionToEnvironmentMap.delete(old.id);
        }
        this.sessions.set(session.id, session);
        this.sessionToEnvironmentMap.set(session.id, environmentId);
        await this.storeSession(session);
        // #359: the provider's refresh token, if it gave one; a sign-in without one drops the old
        if (oauthToken.refresh_token) await this.refresher?.keep(environmentId, oauthToken);
        else await this.refresher?.forget(environmentId);
        this.onDidChangeSessionsEmitter.fire({ added: [session], removed: replaced, changed: [] });
        return session;
    }

    /** #367: a token pasted in: this environment's session from now on (any refresh token goes). */
    async adoptToken(environmentId: string, oauthToken: OAuthToken): Promise<void> {
        await this.sessionsLoadPromise;
        const existing = await this.getSessionForEnvironment(environmentId);
        if (existing) await this.removeSession(existing.id);
        await this.keepSession(environmentId, oauthToken, []);
    }

    /** #359: a refreshed access token replaces the session's (same account, no browser). */
    async replaceAccessToken(environmentId: string, oauthToken: OAuthToken): Promise<void> {
        await this.sessionsLoadPromise;
        const existing = await this.getSessionForEnvironment(environmentId);
        if (!existing) {
            await this.keepSession(environmentId, oauthToken, []);
            return;
        }
        const refreshed = await this.createVSCodeSession(environmentId, oauthToken, existing.scopes as string[], (await this.configService.getConfig(environmentId))?.system);
        const session: TenantAuthSession = { ...existing, accessToken: refreshed.accessToken, tokenPayload: refreshed.tokenPayload ?? existing.tokenPayload };
        this.sessions.set(session.id, session);
        await this.storeSession(session);
        this.onDidChangeSessionsEmitter.fire({ added: [], removed: [], changed: [session] });
    }

    /** #344: browser sign-ins the web app is running for this VS Code (the local agent), by state. */
    private readonly browserSignIns = new Map<string, { environmentId: string; config: OAuthConfig; codeVerifier?: string; expires: number }>();

    /**
     * #344: the local agent's sign-in, first half. The web app opens the provider's page and its
     * callback page gets the code; the verifier, the state and the client secret stay here.
     */
    async startBrowserSignIn(environmentId: string, redirectUri: string, forceLogin = false): Promise<{ url: string; state: string }> {
        const stored = await this.configService.getConfig(environmentId);
        if (!stored) throw new Error(`No OAuth configuration found for environment: ${environmentId}`);
        const config: OAuthConfig = { ...stored, providerConfig: { ...stored.providerConfig, redirectUri } };
        const started = await startOAuthSignIn(this.flowHandler, { config, environmentId, scopes: [], forceLogin });
        const now = Date.now();
        for (const [state, pending] of this.browserSignIns) if (pending.expires < now) this.browserSignIns.delete(state);
        this.browserSignIns.set(started.state, { environmentId, config, codeVerifier: started.codeVerifier, expires: now + 10 * 60_000 });
        return { url: started.url, state: started.state };
    }

    /** #344: second half: the code the web app's callback page got, exchanged here (no CORS in VS Code). */
    async finishBrowserSignIn(environmentId: string, code: string, state: string): Promise<TenantAuthSession> {
        const pending = this.browserSignIns.get(state);
        this.browserSignIns.delete(state);
        if (!pending || pending.environmentId !== environmentId || pending.expires < Date.now()) {
            throw new Error('This sign-in was not started here, or it expired. Sign in again.');
        }
        const oauthToken = await this.flowHandler.exchangeCodeForToken({ config: pending.config, code, state, codeVerifier: pending.codeVerifier, environmentId });
        const existing = await this.getSessionForEnvironment(environmentId);
        if (existing) await this.removeSession(existing.id);
        return this.keepSession(environmentId, oauthToken, []);
    }

    private async createVSCodeSession(
        environmentId: string, 
        oauthToken: OAuthToken, 
        scopes: string[],
        /** #415: the environment's Standard System, for its claim names */
        system?: OAuthConfig['system']
    ): Promise<TenantAuthSession> {
        
        // Decode JWT token to get user information
        let userInfo: any = {};
        let tokenPayload: TokenPayload | undefined;
        
        if (oauthToken.decodedPayload) {
            tokenPayload = oauthToken.decodedPayload;
            // #415: read by the environment's Standard System's claim names
            const identity = identityOf(tokenPayload, system);
            userInfo = { name: identity.name, email: identity.email, username: identity.username };
        }

        return {
            id: this.generateSessionId(),
            accessToken: oauthToken.access_token,
            account: {
                id: userInfo.username || userInfo.email || 'unknown',
                label: userInfo.name || userInfo.email || 'OAuth user'
            },
            scopes,
            environmentId,
            tokenPayload
        };
    }

    private async determineEnvironmentForAuthentication(): Promise<string | undefined> {
        // This is a simplified implementation
        // In practice, you might get this from the current active environment,
        // or prompt the user to select an environment
        
        // For now, we'll try to get it from the extension context or active environment
        // This would be improved with proper context passing
        
        // TODO: Implement proper environment selection logic
        // This could come from:
        // 1. Currently active environment
        // 2. User selection dialog
        // 3. Command parameters
        
        return 'current'; // Placeholder - replace with actual logic
    }

    private generateSessionId(): string {
        return `oauth-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /** Where the sessions live in the vault; `LEGACY_SESSIONS_KEY` is copied here once (#415), so nobody is signed out. */
    private static readonly SESSIONS_KEY = 'dbmn-oauth-sessions';
    private static readonly LEGACY_SESSIONS_KEY = 'manhattan-auth-sessions';

    private async loadStoredSessions(): Promise<void> {
        try {
            let storedSessions = await this.context.secrets.get(TenantAuthProvider.SESSIONS_KEY);
            if (!storedSessions) {
                const legacy = await this.context.secrets.get(TenantAuthProvider.LEGACY_SESSIONS_KEY);
                if (legacy) {
                    await this.context.secrets.store(TenantAuthProvider.SESSIONS_KEY, legacy);
                    await this.context.secrets.delete(TenantAuthProvider.LEGACY_SESSIONS_KEY);
                    storedSessions = legacy;
                }
            }
            
            if (storedSessions) {
                const sessions: TenantAuthSession[] = JSON.parse(storedSessions);
                
                sessions.forEach(session => {
                    this.sessions.set(session.id, session);
                    this.sessionToEnvironmentMap.set(session.id, session.environmentId);
                });
            }
        } catch (error) {
            // Failed to load stored OAuth sessions - silent error handling for production
        }
    }

    private async storeSession(session: TenantAuthSession): Promise<void> {
        try {
            const allSessions = Array.from(this.sessions.values());
            await this.context.secrets.store(TenantAuthProvider.SESSIONS_KEY, JSON.stringify(allSessions));
        } catch (error) {
            // Failed to store OAuth session - silent error handling for production
        }
    }

    private async clearStoredSession(environmentId: string): Promise<void> {
        try {
            // Filter out the session for this environment
            const remainingSessions = Array.from(this.sessions.values())
                .filter(session => session.environmentId !== environmentId);
            
            await this.context.secrets.store(TenantAuthProvider.SESSIONS_KEY, JSON.stringify(remainingSessions));
        } catch (error) {
            // Failed to clear stored OAuth session - silent error handling for production
        }
    }

    /**
     * Get provider ID for registration
     */
    static getProviderId(): string {
        return TenantAuthProvider.PROVIDER_ID;
    }

    /**
     * Get provider label for display
     */
    static getProviderLabel(): string {
        return TenantAuthProvider.PROVIDER_LABEL;
    }
}