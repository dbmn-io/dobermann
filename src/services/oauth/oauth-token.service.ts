// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Token Service
 * 
 * Following Architecture.md - Service implementation patterns
 * Handles secure OAuth token storage and expiry management
 */

import * as vscode from 'vscode';
import { OAuthToken } from '../../types/oauth';
import { IOAuthTokenService } from './oauth.interface';

export class OAuthTokenService implements IOAuthTokenService {
    
    private readonly TOKEN_PREFIX = 'oauth_tokens_';
    private readonly REFRESH_TOKEN_PREFIX = 'oauth_refresh_';
    
    constructor(private context: vscode.ExtensionContext) {}

    async storeTokens(environmentId: string, tokens: OAuthToken): Promise<void> {
        try {
            // Store main token data
            const tokenData = {
                access_token: tokens.access_token,
                token_type: tokens.token_type,
                expires_in: tokens.expires_in,
                scope: tokens.scope,
                issued_at: tokens.issued_at || Math.floor(Date.now() / 1000),
                decodedPayload: tokens.decodedPayload
            };

            await this.context.secrets.store(
                `${this.TOKEN_PREFIX}${environmentId}`, 
                JSON.stringify(tokenData)
            );

            // Store refresh token separately if present
            if (tokens.refresh_token) {
                await this.context.secrets.store(
                    `${this.REFRESH_TOKEN_PREFIX}${environmentId}`,
                    tokens.refresh_token
                );
            }

        } catch (error) {
            throw new Error(`Failed to store OAuth tokens for environment "${environmentId}": ${error}`);
        }
    }

    async getStoredTokens(environmentId: string): Promise<OAuthToken | undefined> {
        try {
            // Get main token data
            const tokenDataStr = await this.context.secrets.get(`${this.TOKEN_PREFIX}${environmentId}`);
            if (!tokenDataStr) {
                return undefined;
            }

            const tokenData = JSON.parse(tokenDataStr);

            // Get refresh token if present
            const refreshToken = await this.context.secrets.get(`${this.REFRESH_TOKEN_PREFIX}${environmentId}`);

            return {
                access_token: tokenData.access_token,
                refresh_token: refreshToken,
                token_type: tokenData.token_type,
                expires_in: tokenData.expires_in,
                scope: tokenData.scope,
                issued_at: tokenData.issued_at,
                decodedPayload: tokenData.decodedPayload
            };

        } catch (error) {
            // Token retrieval failed - return undefined to indicate no tokens available
            return undefined;
        }
    }

    async clearTokens(environmentId: string): Promise<void> {
        try {
            await this.context.secrets.delete(`${this.TOKEN_PREFIX}${environmentId}`);
            await this.context.secrets.delete(`${this.REFRESH_TOKEN_PREFIX}${environmentId}`);
        } catch (error) {
            // Token clearing failed - this is a cleanup operation, safe to ignore
        }
    }

    async areTokensExpiring(environmentId: string, thresholdMinutes: number = 5): Promise<boolean> {
        const tokens = await this.getStoredTokens(environmentId);
        
        if (!tokens) {
            return true; // No tokens = expired
        }

        return this.isTokenExpiring(tokens, thresholdMinutes);
    }

    async getTokenExpiry(environmentId: string): Promise<{ expiresAt: Date; expiresInMinutes: number } | undefined> {
        const tokens = await this.getStoredTokens(environmentId);
        
        if (!tokens || !tokens.issued_at || !tokens.expires_in) {
            return undefined;
        }

        const expiresAt = new Date((tokens.issued_at + tokens.expires_in) * 1000);
        const expiresInMinutes = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / (60 * 1000)));

        return { expiresAt, expiresInMinutes };
    }

    /**
     * Check if refresh token is available for an environment
     */
    async hasRefreshToken(environmentId: string): Promise<boolean> {
        const refreshToken = await this.context.secrets.get(`${this.REFRESH_TOKEN_PREFIX}${environmentId}`);
        return !!refreshToken;
    }

    /**
     * Get refresh token for an environment
     */
    async getRefreshToken(environmentId: string): Promise<string | undefined> {
        return await this.context.secrets.get(`${this.REFRESH_TOKEN_PREFIX}${environmentId}`);
    }

    /**
     * Update only the access token (used during refresh)
     */
    async updateAccessToken(environmentId: string, newTokens: OAuthToken): Promise<void> {
        const existingTokens = await this.getStoredTokens(environmentId);
        
        if (!existingTokens) {
            // If no existing tokens, store new ones
            await this.storeTokens(environmentId, newTokens);
            return;
        }

        // Update with new token data while preserving other fields
        const updatedTokens: OAuthToken = {
            ...existingTokens,
            access_token: newTokens.access_token,
            expires_in: newTokens.expires_in,
            issued_at: newTokens.issued_at || Math.floor(Date.now() / 1000),
            token_type: newTokens.token_type || existingTokens.token_type,
            scope: newTokens.scope || existingTokens.scope,
            decodedPayload: newTokens.decodedPayload || existingTokens.decodedPayload
        };

        // Update refresh token if provided
        if (newTokens.refresh_token) {
            updatedTokens.refresh_token = newTokens.refresh_token;
        }

        await this.storeTokens(environmentId, updatedTokens);
    }

    /**
     * Get all environments with stored OAuth tokens
     * Note: VS Code SecretStorage doesn't expose a keys() method,
     * so we'll track environment IDs differently in a real implementation
     */
    async getEnvironmentsWithTokens(): Promise<string[]> {
        // For now, return empty array
        // In a full implementation, we'd track environment IDs separately
        // or use the environment manager to check which environments have OAuth tokens
        return [];
    }

    /**
     * Clean up expired tokens
     */
    async cleanupExpiredTokens(): Promise<number> {
        const environmentsWithTokens = await this.getEnvironmentsWithTokens();
        let cleanedCount = 0;

        for (const environmentId of environmentsWithTokens) {
            const tokens = await this.getStoredTokens(environmentId);
            
            if (!tokens || this.isTokenExpired(tokens)) {
                await this.clearTokens(environmentId);
                cleanedCount++;
            }
        }

        return cleanedCount;
    }

    private isTokenExpiring(tokens: OAuthToken, thresholdMinutes: number): boolean {
        if (!tokens.issued_at || !tokens.expires_in) {
            return true; // Assume expired if no timing info
        }

        const expiresAt = (tokens.issued_at + tokens.expires_in) * 1000;
        const thresholdTime = Date.now() + (thresholdMinutes * 60 * 1000);
        
        return expiresAt <= thresholdTime;
    }

    private isTokenExpired(tokens: OAuthToken): boolean {
        return this.isTokenExpiring(tokens, 0);
    }
}