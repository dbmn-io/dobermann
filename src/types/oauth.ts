// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Authentication Types
 * 
 * Type definitions for OAuth 2.0 authentication flow implementation
 * Following Architecture.md - Interface-first design patterns
 */

export enum OAuthFlowType {
    AuthorizationCode = 'authorization_code',
    AuthorizationCodePKCE = 'authorization_code_pkce', 
    ClientCredentials = 'client_credentials',
    Implicit = 'implicit',
    ResourceOwnerPassword = 'password'
}

export enum OAuthProvider {
    GitHub = 'github',
    Custom = 'custom'
}

export type OAuthClientAuth = 'basic' | 'body';

export interface OAuthConfig {
    /** OAuth provider type */
    provider: OAuthProvider;
    
    /** Base URL for the API (e.g., https://api.github.com) */
    baseUrl?: string;
    
    /** OAuth authorization endpoint URL (can be relative if baseUrl is provided) */
    authorizationUrl: string;
    
    /** OAuth token endpoint URL (can be relative if baseUrl is provided) */
    tokenUrl: string;
    
    /** OAuth client ID */
    clientId: string;
    
    /** OAuth client secret (stored securely in VS Code secrets) */
    clientSecret?: string;
    
    /** OAuth scopes to request (optional; a Standard System may supply them) */
    scopes?: string[];
    
    /** OAuth flow type to use. #415: absent when the Standard System's configuration supplies it. */
    flowType?: OAuthFlowType;
    
    /** Whether to use PKCE for additional security. #415: absent when the Standard System supplies it. */
    usePKCE?: boolean;

    /**
     * #415: how the client identifies itself at the token endpoint: `basic` is an HTTP Basic
     * header (client_secret_basic), `body` puts client_id and client_secret in the form
     * (client_secret_post). Each environment keeps its own choice; a Standard System only
     * supplies the default. Absent on environments saved before the setting existed:
     * `clientAuthFor()` decides for those.
     */
    clientAuth?: OAuthClientAuth;

    /** #415: headers sent with every token request, the environment's own; the System's are in `system`. */
    tokenRequestHeaders?: Record<string, string>;

    /**
     * #415: what the environment's Standard System says, resolved for this request only
     * (resolveOAuthConfig). Never stored: ownOAuthValues strips it.
     */
    system?: {
        name: string;
        tokenRequestHeaders?: Record<string, string>;
        requiredPaths?: { authorize?: string; token?: string };
        claims?: { name?: string; email?: string; username?: string };
    };
    
    /** Provider-specific configuration */
    providerConfig?: {
        /** The tenant, when the System has one */
        tenantId?: string;
        /** Realm for Keycloak-based systems */
        realm?: string;
        /** Custom redirect URI override */
        redirectUri?: string;
    };
}

export interface OAuthToken {
    /** Access token for API requests */
    access_token: string;
    
    /** Refresh token for renewing access (optional) */
    refresh_token?: string;
    
    /** Token expiration time in seconds */
    expires_in: number;
    
    /** Token type (usually 'Bearer') */
    token_type: string;
    
    /** Granted scopes */
    scope?: string;
    
    /** Token issue timestamp */
    issued_at?: number;
    
    /** The decoded access token, when it is a JWT */
    decodedPayload?: TokenPayload;
}

/**
 * #415: a decoded access token, as it comes. Which claims mean what is the Standard System's
 * configuration (`claims`), read through identityOf(); the core names no System's claims.
 */
export interface TokenPayload {
    exp?: number;
    iat?: number;
    iss?: string;
    sub?: string;
    [claim: string]: unknown;
}

export interface OAuthSession {
    /** Unique session identifier */
    id: string;
    
    /** Environment ID this session belongs to */
    environmentId: string;
    
    /** OAuth access token */
    accessToken: string;
    
    /** User account information */
    account: {
        id: string;
        label: string;
        email?: string;
    };
    
    /** Granted scopes */
    scopes: string[];
    
    /** Session creation timestamp */
    createdAt: number;
    
    /** Session last used timestamp */
    lastUsed?: number;
    
    /** Decoded token payload */
    tokenPayload?: TokenPayload;
}

export interface OAuthError extends Error {
    /** OAuth error code */
    code?: string;
    
    /** OAuth error description */
    description?: string;
    
    /** Error URI for more information */
    uri?: string;
    
    /** HTTP status code if applicable */
    status?: number;
}

export interface PKCEChallenge {
    /** Code verifier for PKCE */
    codeVerifier: string;
    
    /** Code challenge for PKCE */
    codeChallenge: string;
    
    /** Code challenge method (S256) */
    codeChallengeMethod: string;
}

export interface OAuthAuthorizationRequest {
    /** OAuth configuration */
    config: OAuthConfig;

    /** State parameter for CSRF protection */
    state: string;

    /** PKCE challenge if using PKCE */
    pkceChallenge?: PKCEChallenge;

    /** Requested scopes */
    scopes: string[];

    /** Environment ID for this request */
    environmentId: string;

    /** Optional prompt parameter for authorization URL (e.g., 'login' to force re-authentication) */
    promptParam?: string;
}

export interface OAuthTokenRequest {
    /** OAuth configuration */
    config: OAuthConfig;
    
    /** Authorization code from callback */
    code: string;
    
    /** State parameter for validation */
    state: string;
    
    /** PKCE verifier if using PKCE */
    codeVerifier?: string;
    
    /** Environment ID for this request */
    environmentId: string;
}

export interface OAuthRefreshRequest {
    /** OAuth configuration */
    config: OAuthConfig;
    
    /** Refresh token */
    refreshToken: string;
    
    /** Environment ID for this request */
    environmentId: string;
}

/**
 * OAuth authentication method type for environment configuration
 * - 'jwt': Manual JWT token authentication (default)
 * - 'oauth': OAuth 2.0 authentication flow
 * - 'google-service-account': Google Service Account authentication (Issue #126)
 * - 'none': No authentication - use static headers (Issue #113)
 */
export type AuthenticationMethod = 'jwt' | 'oauth' | 'google-service-account' | 'dbmn' | 'none';

/**
 * Google Service Account configuration
 * Contains the credentials from a Google Cloud service account JSON key file
 */
export interface GoogleServiceAccountConfig {
    /** Service account type (should be 'service_account') */
    type: string;
    /** Project ID */
    project_id: string;
    /** Private key ID */
    private_key_id: string;
    /** Private key (PEM format) */
    private_key: string;
    /** Service account email */
    client_email: string;
    /** Client ID */
    client_id: string;
    /** Auth URI */
    auth_uri: string;
    /** Token URI for exchanging JWT for access token */
    token_uri: string;
    /** Auth provider certificate URL */
    auth_provider_x509_cert_url: string;
    /** Client certificate URL */
    client_x509_cert_url: string;
    /** Universe domain (optional, defaults to googleapis.com) */
    universe_domain?: string;
}

/**
 * Google Service Account authentication request
 */
export interface GoogleServiceAccountAuthRequest {
    /** The service account configuration */
    config: GoogleServiceAccountConfig;
    /** OAuth scopes to request */
    scopes: string[];
}

/**
 * Google Service Account token response
 */
export interface GoogleServiceAccountTokenResponse {
    /** Access token */
    access_token: string;
    /** Token type (usually 'Bearer') */
    token_type: string;
    /** Expires in seconds */
    expires_in: number;
}

/**
 * OAuth authentication status for UI display
 */
export enum OAuthStatus {
    NotAuthenticated = 'not_authenticated',
    Authenticating = 'authenticating', 
    Authenticated = 'authenticated',
    TokenExpiring = 'token_expiring',
    AuthenticationFailed = 'authentication_failed',
    TokenRefreshing = 'token_refreshing'
}