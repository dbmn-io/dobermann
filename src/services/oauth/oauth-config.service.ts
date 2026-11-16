// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Configuration Service
 *
 * An environment's OAuth settings as a sign-in or a token request needs them. #415 phase 3:
 * an environment on a Standard System gets its defaults from the System's configuration, read
 * live (resolveOAuthConfig); the environment stores only what the user changed. The service
 * itself knows no System's values.
 */

import { EnvironmentManager } from '../../environmentManager';
import type { SystemConfig } from '../../data-loading/system-schema';
import { OAuthConfig, OAuthFlowType } from '../../types/oauth';
import { resolveOAuthConfig, systemOAuthDefaults } from '../systems/system-oauth';
import { IOAuthConfigService } from './oauth.interface';
import { fillBaseUrl } from '../../utils/environment-url';

export interface OAuthSystems {
    getSystem(id: string): Promise<SystemConfig | undefined>;
}

export class OAuthConfigService implements IOAuthConfigService {
    
    constructor(
        private environmentManager: EnvironmentManager,
        /** #415: where the environment's Standard System comes from; without it, no defaults. */
        private readonly systems?: OAuthSystems
    ) {}

    async getConfig(environmentId: string): Promise<OAuthConfig | undefined> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (!environment?.oauthConfig) {
            return undefined;
        }
        const system = environment.systemId && this.systems ? await this.systems.getSystem(environment.systemId) : undefined;
        const resolved = resolveOAuthConfig(environment.oauthConfig, systemOAuthDefaults(environment, system));
        // Include the base URL from the environment in the OAuth config (#424: its variables filled,
        // so a relative sign-in URL resolves against the address requests go to)
        return { ...(resolved ?? environment.oauthConfig), baseUrl: environment.baseUrl ? fillBaseUrl(environment.baseUrl, environment.variables) : environment.baseUrl };
    }

    async getEnvironmentName(environmentId: string): Promise<string | undefined> {
        return (await this.environmentManager.getEnvironment(environmentId))?.name;
    }

    async updateConfig(environmentId: string, config: Partial<OAuthConfig>): Promise<void> {
        const environment = await this.environmentManager.getEnvironment(environmentId);
        if (!environment) {
            throw new Error(`Environment with ID "${environmentId}" not found`);
        }

        const updatedOAuthConfig: OAuthConfig = {
            ...environment.oauthConfig,
            ...config
        } as OAuthConfig;

        await this.environmentManager.updateEnvironment(environmentId, {
            oauthConfig: updatedOAuthConfig
        });
    }

    async validateConfig(config: OAuthConfig): Promise<{ isValid: boolean; errors: string[] }> {
        const errors: string[] = [];

        // Required fields validation
        if (!config.authorizationUrl?.trim()) {
            errors.push('Authorization URL is required');
        }

        if (!config.tokenUrl?.trim()) {
            errors.push('Token URL is required');
        }

        if (!config.clientId?.trim()) {
            errors.push('Client ID is required');
        }

        // URL format validation
        if (config.authorizationUrl && !this.isValidUrl(config.authorizationUrl)) {
            errors.push('Authorization URL must be a valid HTTPS URL');
        }

        if (config.tokenUrl && !this.isValidUrl(config.tokenUrl)) {
            errors.push('Token URL must be a valid HTTPS URL');
        }

        // #415: what the environment's Standard System says its URLs must contain
        const required = config.system?.requiredPaths;
        if (required?.authorize && !config.authorizationUrl?.includes(required.authorize)) {
            errors.push(`The authorization URL should contain ${required.authorize} (${config.system?.name})`);
        }
        if (required?.token && !config.tokenUrl?.includes(required.token)) {
            errors.push(`The token URL should contain ${required.token} (${config.system?.name})`);
        }

        // Flow type validation
        if (config.flowType === OAuthFlowType.ClientCredentials && !config.clientSecret) {
            errors.push('Client Credentials flow requires a client secret');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    async testConnectivity(config: OAuthConfig): Promise<{ success: boolean; error?: string }> {
        try {
            // Test authorization URL accessibility
            const authResponse = await fetch(config.authorizationUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000) // 5 second timeout
            });

            if (!authResponse.ok) {
                return {
                    success: false,
                    error: `Authorization URL returned ${authResponse.status}: ${authResponse.statusText}`
                };
            }

            // Test token URL accessibility
            const tokenResponse = await fetch(config.tokenUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000) // 5 second timeout
            });

            if (!tokenResponse.ok) {
                return {
                    success: false,
                    error: `Token URL returned ${tokenResponse.status}: ${tokenResponse.statusText}`
                };
            }

            return { success: true };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown connectivity error'
            };
        }
    }

    /**
     * Validate URL format (must be HTTPS for security)
     * @param url - URL to validate
     * @returns Whether URL is valid and HTTPS
     */
    private isValidUrl(url: string): boolean {
        try {
            const parsedUrl = new URL(url);
            return parsedUrl.protocol === 'https:';
        } catch {
            return false;
        }
    }
}
