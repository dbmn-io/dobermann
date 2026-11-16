// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Google Service Account Authentication Interface
 *
 * Handles machine-to-machine authentication using Google Cloud service accounts.
 * No user interaction required - uses service account JSON key file.
 *
 * GitHub Issue #126 - Phase 2
 */

import { GoogleServiceAccountConfig, GoogleServiceAccountTokenResponse } from '../../types/oauth';

/**
 * Cached token with expiration tracking
 */
export interface CachedServiceAccountToken {
    /** The access token */
    accessToken: string;
    /** When the token expires (Unix timestamp in ms) */
    expiresAt: number;
    /** Scopes this token is valid for */
    scopes: string[];
}

/**
 * Google Service Account Authentication Service Interface
 */
export interface IGoogleServiceAccountService {
    /**
     * Authenticate using a service account and get an access token
     * @param config The service account configuration
     * @param scopes OAuth scopes to request
     * @returns Access token response
     */
    authenticate(
        config: GoogleServiceAccountConfig,
        scopes: string[]
    ): Promise<GoogleServiceAccountTokenResponse>;

    /**
     * Get a valid access token for an environment
     * Returns cached token if still valid, otherwise authenticates fresh
     * @param environmentId The environment ID
     * @returns Access token or null if not configured
     */
    getAccessToken(environmentId: string): Promise<string | null>;

    /**
     * Check if an environment has valid service account credentials
     * @param environmentId The environment ID
     * @returns True if credentials are configured and valid
     */
    hasValidCredentials(environmentId: string): Promise<boolean>;

    /**
     * Clear cached token for an environment
     * @param environmentId The environment ID
     */
    clearCachedToken(environmentId: string): void;

    /**
     * Validate a service account configuration
     * @param config The service account configuration to validate
     * @returns Validation result with any errors
     */
    validateConfig(config: GoogleServiceAccountConfig): {
        valid: boolean;
        errors: string[];
    };
}

/**
 * Default Google OAuth scopes for common use cases
 */
export const GOOGLE_DEFAULT_SCOPES = {
    /** Cloud Pub/Sub full access */
    PUBSUB: 'https://www.googleapis.com/auth/pubsub',
    /** Cloud Storage read/write */
    STORAGE: 'https://www.googleapis.com/auth/devstorage.read_write',
    /** BigQuery full access */
    BIGQUERY: 'https://www.googleapis.com/auth/bigquery',
    /** Cloud Platform general access */
    CLOUD_PLATFORM: 'https://www.googleapis.com/auth/cloud-platform',
};
