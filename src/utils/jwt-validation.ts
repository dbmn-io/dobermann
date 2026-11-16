// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Pure helpers for a request's headers and query parameters, and the decoded token's shape.
 * (Organisation and location headers are no longer checked against the token: they are
 * environment variables the user keeps, #424.)
 */

/** A decoded token as it comes; what its claims mean is the Standard System's (identityOf). */
export interface JWTPayload {
    exp?: number; // Token expiration timestamp (seconds since epoch)
    iat?: number; // Token issued at timestamp (seconds since epoch)
    [key: string]: any;
}

export interface HeaderConfig {
    value: string;
    enabled: boolean;
}

/**
 * Flattens headers from mixed format to simple key-value pairs for API requests
 * Only includes enabled headers
 */
export function flattenHeaders(headers: Record<string, string | HeaderConfig>): Record<string, string> {
    const flattened: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
            // Legacy format - include directly
            flattened[key] = value;
        } else if (value && typeof value === 'object' && value.enabled) {
            // New format - only include if enabled
            flattened[key] = value.value;
        }
        // Skip disabled headers
    }

    return flattened;
}

/**
 * Flattens query params from mixed format to simple key-value pairs for API requests
 * Only includes enabled query params (GitHub Issue #101)
 */
export function flattenQueryParams(queryParams: Record<string, string | HeaderConfig>): Record<string, string> {
    const flattened: Record<string, string> = {};

    for (const [key, value] of Object.entries(queryParams)) {
        if (typeof value === 'string') {
            // Legacy format - include directly
            flattened[key] = value;
        } else if (value && typeof value === 'object' && value.enabled) {
            // New format - only include if enabled
            flattened[key] = value.value;
        }
        // Skip disabled query params
    }

    return flattened;
}
