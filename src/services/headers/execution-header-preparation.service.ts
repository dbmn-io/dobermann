// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Execution Header Preparation Service
 *
 * Prepares headers for execution by merging environment-level headers
 * with endpoint headers, and substituting variables.
 *
 * Updated for Issues #113 and #126:
 * - Support environment-level headers
 * - Variable substitution in headers ({{variableName}})
 * - useEnvironmentHeaders flag for endpoint opt-out
 *
 * #424: organisation headers are no longer injected: an environment's headers carry `{{org}}`
 * (a Standard System's defaultHeaders start them so), filled from its variables like any other.
 *
 * Following Architecture.md patterns:
 * - Service isolation (graceful degradation if services unavailable)
 * - Interface-driven design
 * - Proper error handling and logging
 */

import { APIEndpointConfig } from '../../data-loading/zod-schemas';
import { EnvironmentConfig } from '../../environmentManager';
import { IExecutionLoggingService } from '../logging/execution-logging.interface';
import { substituteEnvVariables } from '../environment/env-template';

export interface IExecutionHeaderPreparationService {
    /**
     * Prepares headers for execution with variable substitution
     * @param endpoint The endpoint configuration
     * @param environment The environment configuration (pre-fetched)
     * @param variables Resolved variables for substitution
     * @param systemVariables Optional A8 system variables (e.g., sequence, date, datetime) resolved before user variables
     * @returns Enhanced endpoint with merged headers and variables substituted
     */
    prepareHeadersWithVariables(
        endpoint: APIEndpointConfig,
        environment: EnvironmentConfig,
        variables: Record<string, string>,
        systemVariables?: Record<string, string>
    ): Promise<APIEndpointConfig>;
}

/** Variable pattern for substitution */
const VARIABLE_PATTERN = /\{\{([^}:]+)(?::[^}]+)?\}\}/g;

export class ExecutionHeaderPreparationService implements IExecutionHeaderPreparationService {
    /** Matches {{A8:VARIABLE_NAME}} system variable placeholders */
    private static readonly A8_SYSTEM_PATTERN = /\{\{A8:([^}]+)\}\}/gi;

    constructor(private logger?: IExecutionLoggingService) {}

    /**
     * Pre-pass: resolve A8 system variables (e.g., {{A8:sequence}}, {{A8:date}}, {{A8:datetime}})
     * before user variable substitution. Unrecognised system variables are left as-is.
     */
    private resolveSystemVariables(
        template: string,
        systemVariables: Record<string, string>
    ): string {
        return template.replace(
            ExecutionHeaderPreparationService.A8_SYSTEM_PATTERN,
            (match, varName) => {
                const key = varName.trim().toLowerCase();
                if (key in systemVariables) {
                    return systemVariables[key];
                }
                return match; // Keep original if not recognized
            }
        );
    }

    /**
     * New method: Prepares headers with environment headers and variable substitution
     * This is the recommended method for new implementations (Issues #113 and #126)
     */
    async prepareHeadersWithVariables(
        endpoint: APIEndpointConfig,
        environment: EnvironmentConfig,
        variables: Record<string, string>,
        systemVariables?: Record<string, string>
    ): Promise<APIEndpointConfig> {
        try {
            const mergedHeaders: Record<string, string> = {};

            // 1. Start with environment headers if useEnvironmentHeaders is not false
            const useEnvHeaders = endpoint.useEnvironmentHeaders !== false;

            if (useEnvHeaders && environment.headers) {
                for (const [key, headerConfig] of Object.entries(environment.headers)) {
                    if (headerConfig.enabled) {
                        let value = headerConfig.value;
                        if (systemVariables) {
                            value = this.resolveSystemVariables(value, systemVariables);
                        }
                        mergedHeaders[key] = this.substituteVariables(value, variables);
                    }
                }
            }

            // 2. Overlay endpoint headers (endpoint takes precedence over environment)
            const endpointHeaders = this.normalizeEndpointHeaders(endpoint.headers);
            for (const [key, value] of Object.entries(endpointHeaders)) {
                // Substitute system variables first, then user variables
                let resolved = value;
                if (systemVariables) {
                    resolved = this.resolveSystemVariables(resolved, systemVariables);
                }
                mergedHeaders[key] = this.substituteVariables(resolved, variables);
            }

            // Return endpoint with merged headers
            return {
                ...endpoint,
                headers: mergedHeaders
            };

        } catch (error) {
            // Graceful degradation - return original endpoint if header preparation fails
            this.logger?.warn('execution-headers', `[ExecutionHeaderPreparation] Failed to prepare headers with variables: ${String(error)}`);
            return endpoint;
        }
    }

    /**
     * Substitute variables in a string
     */
    private substituteVariables(template: string, variables: Record<string, string>): string {
        // {{ENV:org}} and {{org}} both name the environment's variable here (the endpoint's
        // path says ENV:, so the same spelling works in an environment header)
        return substituteEnvVariables(template, variables).replace(VARIABLE_PATTERN, (match, varName) => {
            const name = varName.trim();
            if (name in variables) {
                return variables[name];
            }
            return match; // Keep original if not found
        });
    }

    /**
     * Normalizes endpoint headers to a consistent string format
     * Handles both legacy format (Record<string, string>) and new format (Record<string, HeaderConfig>)
     */
    private normalizeEndpointHeaders(headers: APIEndpointConfig['headers']): Record<string, string> {
        if (!headers) {
            return {};
        }

        const normalizedHeaders: Record<string, string> = {};

        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === 'string') {
                // Legacy format: direct string value
                normalizedHeaders[key] = value;
            } else if (typeof value === 'object' && value !== null) {
                // New format: HeaderConfig with value and enabled properties
                if ('value' in value && typeof value.value === 'string') {
                    // Only include enabled headers
                    if (!('enabled' in value) || value.enabled) {
                        normalizedHeaders[key] = value.value;
                    }
                }
            }
        }

        return normalizedHeaders;
    }
}
