// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Google Service Account Authentication Service
 *
 * Implements machine-to-machine authentication using Google Cloud service accounts.
 * Creates signed JWTs and exchanges them for access tokens.
 *
 * GitHub Issue #126 - Phase 2
 */

import * as jwt from 'jsonwebtoken';
import { EnvironmentManager } from '../../environmentManager';
import { GoogleServiceAccountConfig, GoogleServiceAccountTokenResponse } from '../../types/oauth';
import {
    IGoogleServiceAccountService,
    CachedServiceAccountToken,
    GOOGLE_DEFAULT_SCOPES
} from './google-service-account.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { LoggerRegistry } from '../../utils/logger-registry';

export class GoogleServiceAccountService implements IGoogleServiceAccountService {
    /** Token cache by environment ID */
    private tokenCache: Map<string, CachedServiceAccountToken> = new Map();

    /** Buffer time before expiration to refresh token (5 minutes) */
    private readonly EXPIRY_BUFFER_MS = 5 * 60 * 1000;

    private readonly logger: IExtensionDiagnosticLogger;

    constructor(
        private environmentManager: EnvironmentManager
    ) {
        this.logger = LoggerRegistry.getDiagnosticLogger();
    }

    /**
     * Authenticate using a service account and get an access token
     */
    async authenticate(
        config: GoogleServiceAccountConfig,
        scopes: string[]
    ): Promise<GoogleServiceAccountTokenResponse> {
        // Validate config
        const validation = this.validateConfig(config);
        if (!validation.valid) {
            throw new Error(`Invalid service account config: ${validation.errors.join(', ')}`);
        }

        // Create the JWT assertion
        const now = Math.floor(Date.now() / 1000);
        const jwtPayload = {
            iss: config.client_email,
            sub: config.client_email,
            aud: config.token_uri,
            iat: now,
            exp: now + 3600, // 1 hour
            scope: scopes.join(' ')
        };

        // Sign the JWT with the private key
        const signedJwt = jwt.sign(jwtPayload, config.private_key, {
            algorithm: 'RS256'
        });

        // Exchange JWT for access token
        const response = await fetch(config.token_uri, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: signedJwt
            }).toString()
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const tokenResponse: GoogleServiceAccountTokenResponse = await response.json();
        return tokenResponse;
    }

    /**
     * Get a valid access token for an environment
     */
    async getAccessToken(environmentId: string): Promise<string | null> {
        // Check cache first
        const cached = this.tokenCache.get(environmentId);
        if (cached && this.isTokenValid(cached)) {
            return cached.accessToken;
        }

        // Get environment config
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (!environment) {
            return null;
        }

        if (environment.authMethod !== 'google-service-account') {
            return null;
        }

        if (!environment.googleServiceAccountConfig) {
            return null;
        }

        // Get scopes (default to cloud-platform if not specified)
        const scopes = environment.googleServiceAccountScopes || [GOOGLE_DEFAULT_SCOPES.CLOUD_PLATFORM];

        try {
            // Authenticate and get new token
            const tokenResponse = await this.authenticate(
                environment.googleServiceAccountConfig,
                scopes
            );

            // Cache the token
            const cachedToken: CachedServiceAccountToken = {
                accessToken: tokenResponse.access_token,
                expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
                scopes
            };
            this.tokenCache.set(environmentId, cachedToken);

            return tokenResponse.access_token;
        } catch (error) {
            this.logger.error('[GoogleServiceAccount] Authentication failed:', error instanceof Error ? error : undefined);
            throw error;
        }
    }

    /**
     * Check if an environment has valid service account credentials
     */
    async hasValidCredentials(environmentId: string): Promise<boolean> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (!environment) {
            return false;
        }

        if (environment.authMethod !== 'google-service-account') {
            return false;
        }

        if (!environment.googleServiceAccountConfig) {
            return false;
        }

        const validation = this.validateConfig(environment.googleServiceAccountConfig);
        return validation.valid;
    }

    /**
     * Clear cached token for an environment
     */
    clearCachedToken(environmentId: string): void {
        this.tokenCache.delete(environmentId);
    }

    /**
     * Validate a service account configuration
     */
    validateConfig(config: GoogleServiceAccountConfig): {
        valid: boolean;
        errors: string[];
    } {
        const errors: string[] = [];

        if (!config) {
            return { valid: false, errors: ['Configuration is required'] };
        }

        if (config.type !== 'service_account') {
            errors.push(`Invalid type: expected 'service_account', got '${config.type}'`);
        }

        if (!config.client_email) {
            errors.push('Missing client_email');
        } else if (!config.client_email.endsWith('.iam.gserviceaccount.com')) {
            errors.push('Invalid client_email: must be a Google service account email');
        }

        if (!config.private_key) {
            errors.push('Missing private_key');
        } else if (!config.private_key.includes('-----BEGIN')) {
            errors.push('Invalid private_key: must be in PEM format');
        }

        if (!config.token_uri) {
            errors.push('Missing token_uri');
        }

        if (!config.project_id) {
            errors.push('Missing project_id');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Check if a cached token is still valid
     */
    private isTokenValid(cached: CachedServiceAccountToken): boolean {
        return cached.expiresAt > (Date.now() + this.EXPIRY_BUFFER_MS);
    }
}
