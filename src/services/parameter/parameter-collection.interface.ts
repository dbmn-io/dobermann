// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Parameter Collection Service Interface
 * 
 * Handles collection of template variable values from users
 * when executing API endpoints with parameterized bodies.
 */

export interface IParameterCollectionService {
    /**
     * Collect parameter values for template variables from all sources
     * @param template The template string containing variables (request body)
     * @param endpointName Name of the endpoint for context in prompts
     * @param url Optional URL path that may contain variables
     * @param queryParams Optional query parameters that may contain variables
     * @param headers Optional headers that may contain variables
     * @returns Collected parameters or cancellation
     */
    collectParameters(
        template: string,
        endpointName: string,
        url?: string,
        queryParams?: Record<string, string | any>,
        headers?: Record<string, any>
    ): Promise<ParameterCollectionResult>;

    /**
     * Collect parameter values, skipping variables that are already resolved
     * Used when environment/endpoint variables are pre-populated
     * @param template The template string containing variables (request body)
     * @param endpointName Name of the endpoint for context in prompts
     * @param preResolvedVariables Variables already resolved (from env/endpoint)
     * @param url Optional URL path that may contain variables
     * @param queryParams Optional query parameters that may contain variables
     * @param headers Optional headers that may contain variables
     * @returns Collected parameters (combined with pre-resolved) or cancellation
     *
     * Issue #113 & #126: Environment/endpoint variable support
     */
    collectParametersWithPreResolved(
        template: string,
        endpointName: string,
        preResolvedVariables: Record<string, string>,
        url?: string,
        queryParams?: Record<string, string | any>,
        headers?: Record<string, any>
    ): Promise<ParameterCollectionResult>;

    /**
     * Extract template variables that need user input
     * Filters out auto-generated variables (A8:*, V8:*)
     * @param template The template string
     * @returns Array of variable names that need values
     */
    extractUserVariables(template: string): string[];

    /**
     * Replace template variables with collected values
     * @param template The template string
     * @param parameters The parameter values to substitute
     * @returns Template with variables replaced
     */
    replaceVariables(
        template: string,
        parameters: Record<string, any>
    ): string;

    /**
     * Extract template variables from URL path
     * @param url The URL path that may contain variables
     * @returns Array of template variables found in URL
     */
    extractVariablesFromUrl(url: string): TemplateVariable[];

    /**
     * Extract template variables from query parameters
     * @param queryParams The query parameters that may contain variables
     * @returns Array of template variables found in query parameters
     */
    extractVariablesFromQueryParams(queryParams: Record<string, string | any>): TemplateVariable[];

    /**
     * Extract template variables from headers
     * @param headers The headers that may contain variables
     * @returns Array of template variables found in headers
     */
    extractVariablesFromHeaders(headers: Record<string, any>): TemplateVariable[];

    /**
     * Replace template variables in URL path with proper URL encoding
     * @param url The URL path containing variables
     * @param parameters The parameter values to substitute
     * @returns URL with variables replaced and encoded
     */
    replaceVariablesInUrl(url: string, parameters: Record<string, any>): string;

    /**
     * Replace template variables in query parameters with proper URL encoding
     * @param queryParams The query parameters containing variables
     * @param parameters The parameter values to substitute
     * @returns Query parameters with variables replaced and encoded
     */
    replaceVariablesInQueryParams(
        queryParams: Record<string, string | any>,
        parameters: Record<string, any>
    ): Record<string, string>;

    /**
     * Replace template variables in headers (no encoding)
     * @param headers The headers containing variables
     * @param parameters The parameter values to substitute
     * @returns Headers with variables replaced
     */
    replaceVariablesInHeaders(
        headers: Record<string, any>,
        parameters: Record<string, any>
    ): Record<string, any>;
}

export interface ParameterCollectionResult {
    /**
     * Whether the user cancelled the operation
     */
    cancelled: boolean;

    /**
     * Collected parameter values (if not cancelled)
     */
    parameters?: Record<string, any>;

    /**
     * Error message if collection failed
     */
    error?: string;
}

export interface TemplateVariable {
    /**
     * Variable name (without the {{ }})
     */
    name: string;

    /**
     * Whether this is an auto-generated variable
     */
    isAutoGenerated: boolean;

    /**
     * Type hint if available (e.g., from {{variable:type}})
     */
    typeHint?: string;

    /**
     * Everything after the type in the template — the same string batch prep
     * feeds to `parseModifiers` (e.g. `int|>0`, `3-50|upper`, `iso|+2d`). Used
     * by the Run API modal to derive validation rules from the template's own
     * declared constraints instead of a made-up per-type default.
     */
    formatModifier?: string;

    /**
     * Sources where this variable was found
     * e.g., ['url', 'header:Authorization', 'query_param:page']
     */
    sources?: string[];
}