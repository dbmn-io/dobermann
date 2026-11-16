// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Service
 * 
 * Following Architecture.md - Service implementation patterns
 * Main OAuth service that orchestrates authentication flow and integrates with environment system
 */

import * as vscode from 'vscode';
import { EnvironmentManager } from '../../environmentManager';
import {
    OAuthConfig,
    OAuthToken,
    OAuthSession,
    OAuthStatus,
    TokenPayload,
    AuthenticationMethod
} from '../../types/oauth';
import { 
    IOAuthService, 
    IOAuthConfigService, 
    IOAuthTokenService
} from './oauth.interface';
import { TenantAuthProvider } from './tenant-auth-provider';
import { OAuthFlowHandler } from './oauth-flow-handler';
import { OAuthTokenRefresher } from './oauth-refresh';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { identityOf } from '../systems/system-claims';

export class OAuthService implements IOAuthService {
    
    constructor(
        private environmentManager: EnvironmentManager,
        private configService: IOAuthConfigService,
        private tokenService: IOAuthTokenService,
        private authProvider: TenantAuthProvider,
        private flowHandler: OAuthFlowHandler,
        private logger: IExtensionDiagnosticLogger,
        /** #359: where sign-ins keep their refresh tokens (VS Code's SecretStorage). */
        private refresher?: OAuthTokenRefresher
    ) {}

    /**
     * #359: a new access token from the environment's refresh token, without the browser. False
     * when there's none, or the provider refused it (then signing in is the way).
     */
    async adoptPastedToken(environmentId: string, token: string, claims?: TokenPayload): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        await this.authProvider.adoptToken(environmentId, {
            access_token: token,
            token_type: 'Bearer',
            expires_in: claims?.exp ? claims.exp - now : 3600,
            issued_at: now,
            decodedPayload: claims
        });
        await this.refreshTreeViews();
    }

    async refreshSilently(environmentId: string): Promise<boolean> {
        if (!this.refresher) return false;
        const accessToken = await this.refresher.refresh(environmentId);
        if (accessToken) await this.refreshTreeViews();
        return !!accessToken;
    }

    async authenticate(environmentId: string): Promise<string> {
        this.logger.info(`[OAuthService] Authentication initiated for environment ${environmentId}`);
        
        try {
            // Check if environment uses OAuth
            const environment = await this.environmentManager.getEnvironment(environmentId);
            if (!environment) {
                const error = `Environment with ID "${environmentId}" not found`;
                this.logger.error(`[OAuthService] ${error}`);
                throw new Error(error);
            }

            if (environment.authMethod !== 'oauth') {
                const error = `Environment "${environment.name}" is not configured for OAuth authentication`;
                this.logger.warn(`[OAuthService] ${error}`);
                throw new Error(error);
            }

            this.logger.info(`[OAuthService] Starting OAuth flow for environment "${environment.name}" (${environmentId})`);

            // Get or create authentication session
            let session = await this.authProvider.getSessionForEnvironment(environmentId);
            let authAction = '';
            
            if (!session) {
                // Create new session
                this.logger.info(`[OAuthService] No existing session found, creating new session for ${environmentId}`);
                session = await this.authProvider.createSessionForEnvironment(environmentId);
                authAction = 'new_session_created';
            } else if (this.isSessionExpiring(session)) {
                // Refresh existing session
                this.logger.info(`[OAuthService] Session expiring, refreshing session for ${environmentId}`);
                session = await this.refreshSession(environmentId);
                authAction = 'session_refreshed';
            } else {
                this.logger.info(`[OAuthService] Using existing valid session for ${environmentId}`);
                authAction = 'existing_session_reused';
            }

            // Ensure session is not undefined
            if (!session) {
                const error = `Failed to create or refresh session for environment "${environmentId}"`;
                this.logger.error(`[OAuthService] ${error}`);
                throw new Error(error);
            }

            // Store token in environment system for API compatibility
            await this.environmentManager.setEnvironmentToken(environmentId, session.accessToken);

            // Refresh tree views to show updated organizations and authentication status
            await this.refreshTreeViews();

            this.logger.info(`[OAuthService] Authentication successful for ${environmentId}: ${authAction}`, undefined, {
                environmentId,
                environmentName: environment.name,
                action: authAction,
                hasAccessToken: !!session.accessToken,
                accountLabel: session.account?.label
            });

            return session.accessToken;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown authentication error';
            this.logger.error(`[OAuthService] Authentication failed for ${environmentId}: ${errorMessage}`, error instanceof Error ? error : undefined, {
                environmentId
            });
            throw new Error(`OAuth authentication failed for environment "${environmentId}": ${errorMessage}`);
        }
    }

    /** #344: the local agent's sign-in, run in the web app's browser: the provider's page for its callback. */
    async startBrowserSignIn(environmentId: string, redirectUri: string, forceLogin = false): Promise<{ url: string; state: string }> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (environment?.authMethod !== 'oauth') throw new Error(`Environment "${environment?.name ?? environmentId}" is not configured for OAuth authentication`);
        this.logger.info(`[OAuthService] Browser sign-in started for "${environment.name}" (${environmentId}) by the web app`);
        return this.authProvider.startBrowserSignIn(environmentId, redirectUri, forceLogin);
    }

    /** #344: the web app came back with a code: exchanged here, and kept like any sign-in. */
    async finishBrowserSignIn(environmentId: string, code: string, state: string): Promise<void> {
        try {
            const session = await this.authProvider.finishBrowserSignIn(environmentId, code, state);
            await this.environmentManager.setEnvironmentToken(environmentId, session.accessToken);
            await this.refreshTreeViews();
            this.logger.info(`[OAuthService] Browser sign-in finished for ${environmentId}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown authentication error';
            this.logger.error(`[OAuthService] Browser sign-in failed for ${environmentId}: ${errorMessage}`, error instanceof Error ? error : undefined);
            throw new Error(`OAuth authentication failed: ${errorMessage}`);
        }
    }

    async refreshToken(environmentId: string): Promise<string> {
        this.logger.info(`[OAuthService] Token refresh triggered for environment ${environmentId}: automatic refresh`);
        
        try {
            const environment = await this.environmentManager.getEnvironment(environmentId);
            const environmentName = environment?.name || 'Unknown';
            
            this.logger.info(`[OAuthService] Starting token refresh for "${environmentName}" (${environmentId})`);
            
            const session = await this.refreshSession(environmentId);
            
            // Update environment token storage
            await this.environmentManager.setEnvironmentToken(environmentId, session.accessToken);
            
            this.logger.info(`[OAuthService] Token refresh successful for ${environmentId}`, undefined, {
                environmentId,
                environmentName,
                hasNewAccessToken: !!session.accessToken,
                accountLabel: session.account?.label
            });
            
            return session.accessToken;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.warn(`[OAuthService] Token refresh failed for ${environmentId}, signing out user: ${errorMessage}`, error instanceof Error ? error : undefined, {
                environmentId,
                willSignOut: true
            });
            
            // If refresh fails, clear the session and require re-authentication
            await this.signOut(environmentId);
            throw new Error(`Token refresh failed: ${errorMessage}`);
        }
    }

    async signOut(environmentId: string): Promise<void> {
        this.logger.info(`[OAuthService] Sign out initiated for environment ${environmentId}`);
        
        try {
            // #359: the refresh token goes first, before the session: a "signed in?" check in
            // between must find nothing to refresh with (it would sign the user back in)
            await this.refresher?.forget(environmentId);

            const environment = await this.environmentManager.getEnvironment(environmentId);
            const environmentName = environment?.name || 'Unknown';
            
            // Get current session
            const session = await this.authProvider.getSessionForEnvironment(environmentId);
            
            if (session) {
                this.logger.info(`[OAuthService] Clearing OAuth session for "${environmentName}" (${environmentId})`, undefined, {
                    environmentId,
                    environmentName,
                    sessionId: session.id,
                    accountLabel: session.account?.label
                });
                
                // Remove from auth provider
                await this.authProvider.removeSession(session.id);
                
                // Clear token service
                await this.tokenService.clearTokens(environmentId);
                
                this.logger.info(`[OAuthService] OAuth session cleanup completed for ${environmentId}`);
            } else {
                this.logger.info(`[OAuthService] No active session found for ${environmentId}, clearing environment token only`);
            }

            // Clear environment token
            await this.environmentManager.deleteEnvironmentToken(environmentId);
            
            this.logger.info(`[OAuthService] Sign out completed successfully for ${environmentId}`, undefined, {
                environmentId,
                environmentName
            });

        } catch (error) {
            // Error during sign out - continue with cleanup even if some steps fail
            this.logger.warn(`[OAuthService] Error during sign out for ${environmentId}, but cleanup continued`, error instanceof Error ? error : undefined, {
                environmentId
            });
        }
    }

    async isAuthenticated(environmentId: string): Promise<boolean> {
        try {
            const session = await this.authProvider.getSessionForEnvironment(environmentId);
            return session !== undefined && !this.isSessionExpired(session);
        } catch {
            return false;
        }
    }

    async getAuthenticationStatus(environmentId: string): Promise<OAuthStatus> {
        try {
            const session = await this.authProvider.getSessionForEnvironment(environmentId);
            
            if (!session) {
                return OAuthStatus.NotAuthenticated;
            }

            if (this.isSessionExpired(session)) {
                return OAuthStatus.AuthenticationFailed;
            }

            if (this.isSessionExpiring(session)) {
                return OAuthStatus.TokenExpiring;
            }

            return OAuthStatus.Authenticated;

        } catch {
            return OAuthStatus.AuthenticationFailed;
        }
    }

    async getSession(environmentId: string): Promise<OAuthSession | undefined> {
        const session = await this.authProvider.getSessionForEnvironment(environmentId);
        
        if (!session) {
            return undefined;
        }

        return {
            id: session.id,
            environmentId,
            accessToken: session.accessToken,
            account: session.account,
            scopes: [...session.scopes],
            createdAt: Date.now(), // Would be stored in real implementation
            tokenPayload: session.tokenPayload
        };
    }

    async forceReauthentication(environmentId: string): Promise<string> {
        // Clear existing session
        await this.signOut(environmentId);

        // Create new session
        return await this.authenticate(environmentId);
    }

    async requestNewToken(environmentId: string): Promise<string> {
        this.logger.info(`[OAuthService] Request new token initiated for environment ${environmentId} (force login)`);

        try {
            const environment = await this.environmentManager.getEnvironment(environmentId);
            if (!environment) {
                throw new Error(`Environment with ID "${environmentId}" not found`);
            }

            if (environment.authMethod !== 'oauth') {
                throw new Error(`Environment "${environment.name}" is not configured for OAuth authentication`);
            }

            // Sign out old session (clear stale token)
            await this.signOut(environmentId);

            // Trigger fresh OAuth flow with prompt=login
            const session = await this.authProvider.requestNewToken(environmentId);

            if (!session) {
                throw new Error(`Failed to obtain new token for environment "${environmentId}"`);
            }

            // Store new token in environment system
            await this.environmentManager.setEnvironmentToken(environmentId, session.accessToken);

            // Refresh tree views to show updated auth status
            await this.refreshTreeViews();

            this.logger.info(`[OAuthService] New token obtained successfully for ${environmentId}`, undefined, {
                environmentId,
                environmentName: environment.name,
                hasAccessToken: !!session.accessToken,
                accountLabel: session.account?.label
            });

            return session.accessToken;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`[OAuthService] Request new token failed for ${environmentId}: ${errorMessage}`, error instanceof Error ? error : undefined);
            throw new Error(`Request new token failed for environment "${environmentId}": ${errorMessage}`);
        }
    }

    async getUserInfo(environmentId: string): Promise<{ name?: string; email?: string } | undefined> {
        const session = await this.authProvider.getSessionForEnvironment(environmentId);
        
        if (!session?.tokenPayload) {
            return undefined;
        }

        // #415: read by the environment's Standard System's claim names
        const identity = identityOf(session.tokenPayload, (await this.configService.getConfig(environmentId))?.system);
        return { name: identity.name, email: identity.email };
    }

    async hasRefreshToken(environmentId: string): Promise<boolean> {
        return this.refresher ? this.refresher.has(environmentId) : this.tokenService.hasRefreshToken(environmentId);
    }

    /**
     * Initialize OAuth for an environment (auto-configure if possible)
     */
    async initializeOAuthForEnvironment(environmentId: string): Promise<boolean> {
        try {
            const environment = await this.environmentManager.getEnvironment(environmentId);
            if (!environment) {
                return false;
            }

            // If already configured for OAuth, nothing to do
            if (environment.authMethod === 'oauth' && environment.oauthConfig) {
                return true;
            }

            // Try auto-configuration using the method from OAuthConfigService
            const config = await this.configService.getConfig(environmentId);
            const autoConfigured = config !== undefined;
            
            if (autoConfigured) {
                // Switch to OAuth authentication method
                await this.environmentManager.updateEnvironment(environmentId, {
                    authMethod: 'oauth'
                });
                return true;
            }

            return false;
        } catch (error) {
            // Failed to initialize OAuth - return false to indicate failure
            return false;
        }
    }

    /**
     * Switch environment from JWT to OAuth authentication
     */
    async switchToOAuth(environmentId: string, oauthConfig?: Partial<OAuthConfig>): Promise<void> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (!environment) {
            throw new Error(`Environment with ID "${environmentId}" not found`);
        }

        // If OAuth config provided, update it
        if (oauthConfig) {
            await this.configService.updateConfig(environmentId, oauthConfig);
        }

        // Switch authentication method
        await this.environmentManager.updateEnvironment(environmentId, {
            authMethod: 'oauth'
        });
    }

    /**
     * Switch environment from OAuth to JWT authentication
     */
    async switchToJWT(environmentId: string): Promise<void> {
        // Clear OAuth session first
        await this.signOut(environmentId);

        // Switch authentication method
        await this.environmentManager.updateEnvironment(environmentId, {
            authMethod: 'jwt'
        });
    }

    /**
     * Get authentication method for environment
     */
    async getAuthenticationMethod(environmentId: string): Promise<AuthenticationMethod | undefined> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        return environment?.authMethod;
    }

    /**
     * Check if all environments are authenticated
     */
    async getAllAuthenticationStatuses(): Promise<Map<string, OAuthStatus>> {
        const environments = await this.environmentManager.getAllEnvironments();
        const statuses = new Map<string, OAuthStatus>();

        for (const env of environments) {
            if (env.authMethod === 'oauth') {
                const status = await this.getAuthenticationStatus(env.id);
                statuses.set(env.id, status);
            }
        }

        return statuses;
    }

    private async refreshSession(environmentId: string): Promise<any> {
        // #359: the refresh token first; the browser only when there's none or it's refused
        if (await this.refreshSilently(environmentId)) {
            this.logger.info(`[OAuthService] Refreshed ${environmentId} with its refresh token (no browser)`);
            return this.authProvider.getSessionForEnvironment(environmentId);
        }
        this.logger.info(`[OAuthService] Forcing new session creation for ${environmentId}: underlying refresh mechanism`);
        // Force new session which will handle token refresh
        const newSession = await this.authProvider.forceNewSession(environmentId);
        this.logger.info(`[OAuthService] New session created successfully for ${environmentId}`, undefined, {
            environmentId,
            hasAccessToken: !!newSession?.accessToken,
            sessionId: newSession?.id
        });
        return newSession;
    }

    private isSessionExpired(session: any): boolean {
        // Check if we have token payload with expiry
        if (session.tokenPayload?.exp) {
            const currentTime = Math.floor(Date.now() / 1000);
            return session.tokenPayload.exp <= currentTime;
        }
        
        // If no expiry info, assume not expired (should be improved with stored expiry)
        return false;
    }

    private isSessionExpiring(session: any, thresholdMinutes: number = 5): boolean {
        // Check if token expires within threshold
        if (session.tokenPayload?.exp) {
            const currentTime = Math.floor(Date.now() / 1000);
            const thresholdTime = currentTime + (thresholdMinutes * 60);
            return session.tokenPayload.exp <= thresholdTime;
        }
        
        return false;
    }

    /**
     * Handle automatic token refresh for background operations
     */
    async ensureValidToken(environmentId: string): Promise<string> {
        this.logger.debug(`[OAuthService] Ensuring valid token for ${environmentId}: background operation check`);
        
        const isAuthenticated = await this.isAuthenticated(environmentId);
        
        if (!isAuthenticated) {
            this.logger.warn(`[OAuthService] Not authenticated to environment ${environmentId}, cannot ensure valid token`);
            throw new Error(`Not authenticated to environment "${environmentId}"`);
        }

        const session = await this.authProvider.getSessionForEnvironment(environmentId);
        
        if (!session) {
            this.logger.error(`[OAuthService] No active session for environment ${environmentId}, but isAuthenticated returned true`);
            throw new Error(`No active session for environment "${environmentId}"`);
        }

        // Check if token needs refresh
        if (this.isSessionExpiring(session)) {
            // Token expiring - refresh automatically
            this.logger.info(`[OAuthService] Token expiring for ${environmentId}, triggering automatic background refresh`);
            return await this.refreshToken(environmentId);
        }

        this.logger.debug(`[OAuthService] Token still valid for ${environmentId}, no refresh needed`);
        return session.accessToken;
    }

    /**
     * Refresh tree views after OAuth authentication to show updated organizations and status
     */
    private async refreshTreeViews(): Promise<void> {
        try {
            // Refresh both main tree and environment tree
        } catch (error) {
            // Tree refresh failure shouldn't break OAuth flow - just log it
            this.logger.warn(`[OAuthService] Failed to refresh tree views after OAuth authentication: ${String(error)}`);
        }
    }
}