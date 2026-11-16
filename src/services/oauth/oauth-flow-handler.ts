// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Flow Handler
 * 
 * Following Architecture.md - Service implementation patterns
 * Implements OAuth 2.0 flow logic including PKCE, token exchange, and refresh
 *
 * Core (#343): both hosts run it. Web Crypto for PKCE and plain base64 helpers, so it needs no
 * Node or VS Code; the host says where the provider sends the browser back (redirectUri).
 */

import { 
    OAuthConfig, 
    OAuthToken, 
    OAuthAuthorizationRequest,
    OAuthTokenRequest,
    OAuthRefreshRequest,
    PKCEChallenge,
    TokenPayload
} from '../../types/oauth';
import { IOAuthFlowHandler } from './oauth.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { clientAuthFor } from './client-auth';

/**
 * A refresh that failed. `refused`: the provider turned the refresh token down (expired, revoked),
 * so it's no use keeping; otherwise (no answer, a server error) it may work next time.
 */
export class OAuthRefreshError extends Error {
    constructor(message: string, readonly refused: boolean) {
        super(message);
        this.name = 'OAuthRefreshError';
    }
}

export class OAuthFlowHandler implements IOAuthFlowHandler {
    private readonly logger?: IExtensionDiagnosticLogger;

    constructor(
        logger?: IExtensionDiagnosticLogger,
        private readonly options: {
            /** The host's callback address: VS Code's setting (or its vscode:// link), the web app's callback page. */
            redirectUri?: () => string | undefined;
            /** #415: our User-Agent on token requests (`Dobermann/<version>`); a browser sets its own and ignores this. */
            userAgent?: () => string | undefined;
        } = {}
    ) {
        this.logger = logger;
    }

    /**
     * #415: the headers a token request carries beyond the form's own: our User-Agent, then what
     * the environment's Standard System asks for (its configuration row), then the environment's
     * own, which win. A browser sets User-Agent itself and ignores ours.
     */
    private tokenRequestHeaders(config: OAuthConfig): Record<string, string> {
        const userAgent = this.options.userAgent?.();
        return { ...(userAgent ? { 'User-Agent': userAgent } : {}), ...config.system?.tokenRequestHeaders, ...config.tokenRequestHeaders };
    }

    /**
     * Resolves a potentially relative URL against a base URL
     */
    private resolveUrl(url: string, baseUrl?: string): string {
        if (!url) {
            return url;
        }
        
        // If URL is already absolute, return as-is
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        
        // If URL is relative and we have a base URL, resolve it
        if (baseUrl && url.startsWith('/')) {
            try {
                const base = new URL(baseUrl);
                return `${base.protocol}//${base.host}${url}`;
            } catch {
                // If base URL is invalid, return original URL
                return url;
            }
        }
        
        return url;
    }

    generateAuthorizationUrl(request: OAuthAuthorizationRequest): string {
        const { config, state, pkceChallenge, scopes } = request;
        
        this.logger?.info('[OAuth] Generating authorization URL', {
            clientId: config.clientId,
            redirectUri: this.getRedirectUri(config),
            scopes: scopes,
            usePKCE: config.usePKCE,
            hasCodeChallenge: !!pkceChallenge
        });
        
        // Resolve authorization URL (might be relative)
        const authUrl = this.resolveUrl(config.authorizationUrl, config.baseUrl);
        
        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: this.getRedirectUri(config),
            response_type: 'code',
            state: state
        });

        // Only add scope parameter if scopes are provided
        const scopeValue = scopes.join(' ');
        if (scopeValue) {
            params.append('scope', scopeValue);
            this.logger?.info('[OAuth] Added scope parameter', { scope: scopeValue });
        } else {
            this.logger?.info('[OAuth] No scopes provided, omitting scope parameter');
        }

        // Add PKCE parameters if using PKCE
        if (config.usePKCE && pkceChallenge) {
            params.append('code_challenge', pkceChallenge.codeChallenge);
            params.append('code_challenge_method', pkceChallenge.codeChallengeMethod);
            this.logger?.info('[OAuth] Added PKCE parameters');
        }

        // Add prompt parameter if specified (e.g., 'login' to force re-authentication)
        if (request.promptParam) {
            params.append('prompt', request.promptParam);
            this.logger?.info('[OAuth] Added prompt parameter', { prompt: request.promptParam });
        }

        const finalUrl = `${authUrl}?${params.toString()}`;
        this.logger?.info('[OAuth] Generated authorization URL', { url: finalUrl });
        
        return finalUrl;
    }

    async exchangeCodeForToken(request: OAuthTokenRequest): Promise<OAuthToken> {
        const { config, code, codeVerifier } = request;
        
        // Resolve token URL (might be relative)
        const tokenUrl = this.resolveUrl(config.tokenUrl, config.baseUrl);

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: this.getRedirectUri(config)
        });

        // Determine authentication method
        let authMethod: 'basic' | 'body' | 'pkce' = 'body';
        
        // Build headers
        const headers: Record<string, string> = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        };

        // #415: the environment's own client authentication, and the headers its Standard System
        // and the environment itself ask for on token requests
        const clientAuth = clientAuthFor(config);
        Object.assign(headers, this.tokenRequestHeaders(config));

        this.logger?.info('[OAuth] Token request', {
            clientAuth,
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            system: config.system?.name
        });

        // Handle different authentication methods
        
        if (config.usePKCE && codeVerifier) {
            // PKCE flow
            body.append('code_verifier', codeVerifier);
            
            if (clientAuth === 'basic' && config.clientSecret) {
                // Basic auth even with PKCE (a confidential client that wants the header)
                const credentials = base64(`${config.clientId}:${config.clientSecret}`);
                headers['Authorization'] = `Basic ${credentials}`;
                authMethod = 'basic';
                // Don't include client_id in body when using Basic Auth
            } else {
                // Standard PKCE: client_id in body. #363: a configured secret goes too (a
                // confidential client, e.g. Azure AD or Okta web apps, needs both); none = public client
                body.append('client_id', config.clientId);
                if (config.clientSecret) {
                    body.append('client_secret', config.clientSecret);
                    authMethod = 'body';
                } else {
                    authMethod = 'pkce';
                }
            }
        } else if (config.clientSecret) {
            // Non-PKCE with client secret
            if (clientAuth === 'basic') {
                const rawCredentials = `${config.clientId}:${config.clientSecret}`;
                const credentials = base64(rawCredentials);
                headers['Authorization'] = `Basic ${credentials}`;
                authMethod = 'basic';
                // Don't include client_id in body when using Basic Auth
            } else {
                // Others (like GitHub): Use body authentication
                body.append('client_id', config.clientId);
                body.append('client_secret', config.clientSecret);
                authMethod = 'body';
            }
        } else {
            // No authentication - just client_id
            body.append('client_id', config.clientId);
        }

        // Log the token exchange request details
        this.logger?.info('[OAuth] Starting token exchange', {
            tokenUrl: tokenUrl,
            grantType: 'authorization_code',
            authMethod: authMethod,
            clientId: config.clientId,
            redirectUri: this.getRedirectUri(config),
            hasClientSecret: !!config.clientSecret,
            useBasicAuth: authMethod === 'basic',
            usePKCE: config.usePKCE,
            hasCodeVerifier: !!codeVerifier,
            codeLength: code.length
        });

        // Create a copy for logging without sensitive data
        const logBody = new URLSearchParams(body);
        if (config.clientSecret && authMethod === 'body') {
            logBody.set('client_secret', '[REDACTED]');
        }
        if (codeVerifier) {
            logBody.set('code_verifier', '[REDACTED]');
        }
        logBody.set('code', `[${code.length} chars]`);
        
        this.logger?.info('[OAuth] Token exchange request body', {
            bodyParams: Object.fromEntries(logBody.entries())
        });

        // #369: never the Authorization header (Basic carries the client secret)
        this.logger?.info('[OAuth] Token exchange request headers', { headers: Object.keys(headers) });

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: headers,
            body: body.toString()
        });

        this.logger?.info('[OAuth] Token exchange response received', {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries())
        });

        if (!response.ok) {
            const errorText = await response.text();
            this.logger?.error('[OAuth] Token exchange failed', undefined, {
                status: response.status,
                statusText: response.statusText,
                errorResponse: errorText
            });
            throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
        }

        const tokenData = await response.json();
        this.logger?.info('[OAuth] Token exchange successful', {
            hasAccessToken: !!tokenData.access_token,
            hasRefreshToken: !!tokenData.refresh_token,
            expiresIn: tokenData.expires_in,
            tokenType: tokenData.token_type,
            scope: tokenData.scope
        });
        
        // Check for OAuth error response
        if (tokenData.error) {
            const errorMessage = tokenData.error_description || tokenData.error;
            const errorDetails = [];
            
            // Provide helpful error messages for common issues
            if (tokenData.error === 'incorrect_client_credentials') {
                errorDetails.push('The client ID or client secret is incorrect.');
                errorDetails.push('Please verify your OAuth configuration.');
                if (config.usePKCE && !config.clientSecret) {
                    errorDetails.push('Note: GitHub requires a client secret (PKCE-only auth is not supported).');
                }
            } else if (tokenData.error === 'invalid_grant') {
                errorDetails.push('The authorization code may have expired or already been used.');
                errorDetails.push('Please try authenticating again.');
            } else if (tokenData.error === 'invalid_client') {
                errorDetails.push('The client authentication failed.');
                errorDetails.push('Check that your client ID and secret are correct.');
            }
            
            const fullError = errorDetails.length > 0 
                ? `${errorMessage}\n\n${errorDetails.join('\n')}`
                : errorMessage;
                
            throw new Error(`OAuth token exchange failed: ${fullError}`);
        }
        
        // Validate required fields
        if (!tokenData.access_token) {
            throw new Error('OAuth server response missing access_token. Response: ' + JSON.stringify(tokenData));
        }

        // Create OAuth token with decoded payload if JWT
        const oauthToken: OAuthToken = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_in: tokenData.expires_in || 3600,
            token_type: tokenData.token_type || 'Bearer',
            scope: tokenData.scope,
            issued_at: Math.floor(Date.now() / 1000)
        };

        // A JWT access token carries claims the environment's System can read (#415)
        try {
            oauthToken.decodedPayload = this.decodeJWT(tokenData.access_token);
        } catch (error) {
            // JWT decoding is optional - some providers might not use JWT format
            this.logger?.info('[OAuth] Could not decode JWT payload (normal for non-JWT tokens)', { error: error instanceof Error ? error.message : String(error) });
        }

        return oauthToken;
    }

    async refreshAccessToken(request: OAuthRefreshRequest): Promise<OAuthToken> {
        const { config, refreshToken } = request;

        this.logger?.info('[OAuth] Starting token refresh', {
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            hasClientSecret: !!config.clientSecret,
            refreshTokenLength: refreshToken.length
        });

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        // #415: the environment's own client authentication, and the headers its Standard System
        // and the environment itself ask for
        const clientAuth = clientAuthFor(config);

        const headers: Record<string, string> = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            ...this.tokenRequestHeaders(config)
        };

        let authMethod: 'basic' | 'body' = 'body';
        
        // Add authentication
        if (config.clientSecret) {
            if (clientAuth === 'basic') {
                const credentials = base64(`${config.clientId}:${config.clientSecret}`);
                headers['Authorization'] = `Basic ${credentials}`;
                authMethod = 'basic';
                // Don't include client_id in body when using Basic Auth
            } else {
                // Others: Use body authentication
                body.append('client_id', config.clientId);
                body.append('client_secret', config.clientSecret);
                authMethod = 'body';
            }
        } else {
            // No secret - just include client_id
            body.append('client_id', config.clientId);
        }

        // Create sanitized version for logging
        const logBody = new URLSearchParams(body);
        logBody.set('refresh_token', `[${refreshToken.length} chars]`);
        if (config.clientSecret && authMethod === 'body') {
            logBody.set('client_secret', '[REDACTED]');
        }

        const logHeaders = { ...headers };
        if (logHeaders['Authorization']) {
            logHeaders['Authorization'] = 'Basic [REDACTED]';
        }

        this.logger?.info('[OAuth] Token refresh request', {
            authMethod: authMethod,
            bodyParams: Object.fromEntries(logBody.entries()),
            headers: logHeaders
        });

        // #359: a relative token URL resolves against the base URL, as in the code exchange
        const response = await fetch(this.resolveUrl(config.tokenUrl, config.baseUrl), {
            method: 'POST',
            headers: headers,
            body: body.toString()
        });

        this.logger?.info('[OAuth] Token refresh response received', {
            status: response.status,
            statusText: response.statusText
        });

        if (!response.ok) {
            const errorText = await response.text();
            this.logger?.error('[OAuth] Token refresh failed', undefined, {
                status: response.status,
                statusText: response.statusText,
                errorResponse: errorText
            });
            // 400/401: the provider refused this refresh token (invalid_grant: expired, revoked)
            throw new OAuthRefreshError(`Token refresh failed (${response.status}): ${errorText}`, response.status === 400 || response.status === 401);
        }

        const tokenData = await response.json();
        this.logger?.info('[OAuth] Token refresh successful', {
            hasAccessToken: !!tokenData.access_token,
            hasRefreshToken: !!tokenData.refresh_token,
            expiresIn: tokenData.expires_in
        });

        if (!tokenData.access_token) {
            throw new Error('No access token received from refresh request');
        }

        const oauthToken: OAuthToken = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || refreshToken, // Use new refresh token or keep existing
            expires_in: tokenData.expires_in || 3600,
            token_type: tokenData.token_type || 'Bearer',
            scope: tokenData.scope,
            issued_at: Math.floor(Date.now() / 1000)
        };

        // Try to decode JWT payload
        try {
            oauthToken.decodedPayload = this.decodeJWT(tokenData.access_token);
        } catch (error) {
            this.logger?.info('[OAuth] Could not decode JWT payload during refresh (normal for non-JWT tokens)', { error: error instanceof Error ? error.message : String(error) });
        }

        return oauthToken;
    }

    async generatePKCEChallenge(): Promise<PKCEChallenge> {
        // A cryptographically secure random code verifier, and its SHA-256 (Web Crypto: both hosts)
        const codeVerifier = base64URL(randomBytes(32));
        const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
        const codeChallenge = base64URL(hash);

        return {
            codeVerifier,
            codeChallenge,
            codeChallengeMethod: 'S256'
        };
    }

    generateState(): string {
        return base64URL(randomBytes(32));
    }

    validateState(receivedState: string, expectedState: string): boolean {
        return receivedState === expectedState;
    }

    /**
     * Get appropriate redirect URI for the OAuth configuration
     */
    private getRedirectUri(config: OAuthConfig): string {
        // Use custom redirect URI if provided in config
        if (config.providerConfig?.redirectUri) {
            return config.providerConfig.redirectUri;
        }

        // The host's callback address (VS Code: the dbmn.oauth.redirectUri setting; the web app: its page)
        const hostUri = this.options.redirectUri?.();
        if (hostUri) {
            return hostUri;
        }

        // Default to lowercase URI
        return 'vscode://dbmn.dobermann/oauth-callback';
    }

    /**
     * Decode a JWT access token's payload (what its claims mean is the System's, #415)
     */
    private decodeJWT(token: string): TokenPayload {
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }

        const payload = parts[1];
        const decoded = fromBase64URL(payload);
        return JSON.parse(decoded) as TokenPayload;
    }

    /**
     * Check if token is expired or expiring soon
     */
    isTokenExpiring(token: OAuthToken, thresholdMinutes: number = 5): boolean {
        if (!token.issued_at || !token.expires_in) {
            return true; // Assume expired if we don't have timing info
        }

        const expiresAt = (token.issued_at + token.expires_in) * 1000; // Convert to milliseconds
        const thresholdTime = Date.now() + (thresholdMinutes * 60 * 1000);
        
        return expiresAt <= thresholdTime;
    }

    /**
     * Get token expiry information
     */
    getTokenExpiry(token: OAuthToken): { expiresAt: Date; expiresInMinutes: number } | undefined {
        if (!token.issued_at || !token.expires_in) {
            return undefined;
        }

        const expiresAt = new Date((token.issued_at + token.expires_in) * 1000);
        const expiresInMinutes = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / (60 * 1000)));

        return { expiresAt, expiresInMinutes };
    }

    /**
     * Validate token format and basic properties
     */
    validateToken(token: OAuthToken): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!token.access_token) {
            errors.push('Missing access token');
        }

        if (!token.token_type) {
            errors.push('Missing token type');
        }

        if (token.token_type && token.token_type.toLowerCase() !== 'bearer') {
            errors.push('Unsupported token type (expected Bearer)');
        }

        if (!token.expires_in || token.expires_in <= 0) {
            errors.push('Invalid or missing expiration time');
        }

        // Check if token is already expired
        if (this.isTokenExpiring(token, 0)) {
            errors.push('Token is already expired');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }
}
function randomBytes(length: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** UTF-8 text as base64 (HTTP Basic credentials). */
function base64(text: string): string {
    return bytesToBase64(new TextEncoder().encode(text));
}

/** Base64URL without padding (PKCE, state). */
function base64URL(bytes: Uint8Array): string {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A base64url segment (a JWT's payload) as UTF-8 text. */
function fromBase64URL(segment: string): string {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
    return new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
}
