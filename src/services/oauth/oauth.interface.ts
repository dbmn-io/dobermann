// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Service Interfaces
 * 
 * Following Architecture.md - Interface-first design patterns
 * These interfaces define the contract for OAuth authentication services
 */

import { 
    OAuthConfig, 
    OAuthToken, 
    OAuthSession, 
    OAuthAuthorizationRequest,
    OAuthTokenRequest,
    OAuthRefreshRequest,
    OAuthStatus,
    PKCEChallenge,
    TokenPayload
} from '../../types/oauth';

/**
 * Main OAuth authentication service interface
 * Handles OAuth flows, token management, and session lifecycle
 */
export interface IOAuthService {
    /**
     * Authenticate a user for a specific environment using OAuth
     * @param environmentId - Environment to authenticate for
     * @returns Promise resolving to access token
     */
    authenticate(environmentId: string): Promise<string>;

    /**
     * Refresh an existing OAuth token
     * @param environmentId - Environment to refresh token for
     * @returns Promise resolving to new access token
     */
    refreshToken(environmentId: string): Promise<string>;

    /** #359: a new access token from the refresh token, without the browser; false if that can't be done. */
    refreshSilently(environmentId: string): Promise<boolean>;

    /** #367: a token pasted into an OAuth environment becomes its session (kept in the vault). */
    adoptPastedToken(environmentId: string, token: string, claims?: TokenPayload): Promise<void>;

    /**
     * Revoke OAuth tokens and sign out
     * @param environmentId - Environment to sign out from
     */
    signOut(environmentId: string): Promise<void>;

    /**
     * Check if user is authenticated for an environment
     * @param environmentId - Environment to check
     * @returns Promise resolving to authentication status
     */
    isAuthenticated(environmentId: string): Promise<boolean>;

    /**
     * Get current authentication status for an environment
     * @param environmentId - Environment to check
     * @returns Promise resolving to OAuth status
     */
    getAuthenticationStatus(environmentId: string): Promise<OAuthStatus>;

    /**
     * Get the current OAuth session for an environment
     * @param environmentId - Environment to get session for
     * @returns Promise resolving to session or undefined
     */
    getSession(environmentId: string): Promise<OAuthSession | undefined>;

    /**
     * Force re-authentication (useful for expired sessions)
     * @param environmentId - Environment to re-authenticate
     * @returns Promise resolving to new access token
     */
    forceReauthentication(environmentId: string): Promise<string>;

    /**
     * Get user information from current session
     * @param environmentId - Environment to get user info for
     * @returns Promise resolving to user info or undefined
     */
    getUserInfo(environmentId: string): Promise<{ name?: string; email?: string } | undefined>;

    /**
     * Check if a refresh token is available for the environment
     * @param environmentId - Environment to check refresh capability for
     * @returns Promise resolving to true if refresh token is available
     */
    hasRefreshToken(environmentId: string): Promise<boolean>;

    /**
     * Request a brand new token by forcing IdP re-authentication (prompt=login).
     * Clears the existing session and opens a fresh OAuth flow that bypasses
     * the browser's SSO session, ensuring updated roles/grants.
     * @param environmentId - Environment to request new token for
     * @returns Promise resolving to new access token
     */
    requestNewToken(environmentId: string): Promise<string>;
}

/**
 * OAuth configuration management service interface
 * Handles OAuth provider configuration and URL detection
 */
export interface IOAuthConfigService {
    /**
     * Get OAuth configuration for an environment
     * @param environmentId - Environment to get config for
     * @returns Promise resolving to OAuth config or undefined
     */
    getConfig(environmentId: string): Promise<OAuthConfig | undefined>;

    /** The environment's name, for what the user sees while signing in (#361). */
    getEnvironmentName?(environmentId: string): Promise<string | undefined>;

    /**
     * Update OAuth configuration for an environment
     * @param environmentId - Environment to update
     * @param config - Partial OAuth config to update
     */
    updateConfig(environmentId: string, config: Partial<OAuthConfig>): Promise<void>;

    /**
     * Validate OAuth configuration
     * @param config - OAuth config to validate
     * @returns Promise resolving to validation result
     */
    validateConfig(config: OAuthConfig): Promise<{ isValid: boolean; errors: string[] }>;

    /**
     * Test OAuth provider connectivity
     * @param config - OAuth config to test
     * @returns Promise resolving to connectivity test result
     */
    testConnectivity(config: OAuthConfig): Promise<{ success: boolean; error?: string }>;

}

/**
 * OAuth token management service interface
 * Handles secure token storage and refresh logic
 */
export interface IOAuthTokenService {
    /**
     * Store OAuth tokens securely
     * @param environmentId - Environment ID
     * @param tokens - OAuth tokens to store
     */
    storeTokens(environmentId: string, tokens: OAuthToken): Promise<void>;

    /**
     * Retrieve stored OAuth tokens
     * @param environmentId - Environment ID
     * @returns Promise resolving to stored tokens or undefined
     */
    getStoredTokens(environmentId: string): Promise<OAuthToken | undefined>;

    /**
     * Clear stored tokens for an environment
     * @param environmentId - Environment ID
     */
    clearTokens(environmentId: string): Promise<void>;

    /**
     * Check if tokens are expired or expiring soon
     * @param environmentId - Environment ID
     * @param thresholdMinutes - Minutes before expiry to consider "expiring soon"
     * @returns Promise resolving to expiry status
     */
    areTokensExpiring(environmentId: string, thresholdMinutes?: number): Promise<boolean>;

    /**
     * Get token expiry information
     * @param environmentId - Environment ID
     * @returns Promise resolving to expiry info or undefined
     */
    getTokenExpiry(environmentId: string): Promise<{ expiresAt: Date; expiresInMinutes: number } | undefined>;

    /**
     * Check if a refresh token is available for the environment
     * @param environmentId - Environment ID
     * @returns Promise resolving to true if refresh token is available
     */
    hasRefreshToken(environmentId: string): Promise<boolean>;
}

/**
 * OAuth flow handler interface
 * Handles different OAuth flow implementations
 */
export interface IOAuthFlowHandler {
    /**
     * Generate authorization URL for OAuth flow
     * @param request - Authorization request parameters
     * @returns Authorization URL
     */
    generateAuthorizationUrl(request: OAuthAuthorizationRequest): string;

    /**
     * Exchange authorization code for access token
     * @param request - Token request parameters
     * @returns Promise resolving to OAuth tokens
     */
    exchangeCodeForToken(request: OAuthTokenRequest): Promise<OAuthToken>;

    /**
     * Refresh access token using refresh token
     * @param request - Refresh request parameters
     * @returns Promise resolving to new OAuth tokens
     */
    refreshAccessToken(request: OAuthRefreshRequest): Promise<OAuthToken>;

    /**
     * Generate PKCE challenge for enhanced security
     * @returns PKCE challenge parameters
     */
    generatePKCEChallenge(): Promise<PKCEChallenge>;

    /**
     * Generate secure state parameter for CSRF protection
     * @returns Random state string
     */
    generateState(): string;

    /**
     * Validate state parameter to prevent CSRF attacks
     * @param receivedState - State received from OAuth callback
     * @param expectedState - Expected state value
     * @returns Whether state is valid
     */
    validateState(receivedState: string, expectedState: string): boolean;
}
