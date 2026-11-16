// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Variable Resolution Service Interface
 *
 * Handles resolution of template variables from multiple sources with defined precedence.
 * Supports environment-level and endpoint-level variables, CSV data, user input,
 * and script-set variables.
 *
 * GitHub Issues #113 and #126
 */

/**
 * Source of a resolved variable value
 */
export type VariableSource = 'csv' | 'user' | 'endpoint' | 'environment' | 'script-environment' | 'script-request' | 'system';

/**
 * A resolved variable with its value and source
 */
export interface ResolvedVariable {
    /** Variable name */
    name: string;
    /** Resolved value */
    value: string;
    /** Source of the value */
    source: VariableSource;
}

/**
 * Context for variable resolution
 */
export interface VariableResolutionContext {
    /** Environment ID for looking up environment variables */
    environmentId: string;
    /** Endpoint ID for looking up endpoint variables */
    endpointId: string;
    /** Environment variables from config (pre-fetched for efficiency) */
    environmentVariables?: Record<string, string>;
    /** Endpoint variables from config (pre-fetched for efficiency) */
    endpointVariables?: Record<string, string>;
    /** CSV row data for batch execution (optional) */
    csvRow?: Record<string, string>;
    /** User-provided input values (optional) */
    userInput?: Record<string, string>;
    /** Unique request ID for request-scoped variables (optional) */
    requestId?: string;
}

/**
 * Result of resolving all variables in a template
 */
export interface VariableResolutionResult {
    /** Template with all variables substituted */
    resolvedTemplate: string;
    /** Map of variable name to resolved variable info */
    variables: Record<string, ResolvedVariable>;
    /** Variable names that could not be resolved (need user input) */
    unresolvedVariables: string[];
}

/**
 * Variable store for managing script-set variables
 */
export interface IVariableStore {
    /** Get variable value from any source */
    get(name: string): string | undefined;
    /** Set environment-scoped variable (persists across requests in session) */
    setEnvironment(name: string, value: string): void;
    /** Set request-scoped variable (only for current request) */
    setRequest(name: string, value: string): void;
    /** Get all variables with their sources */
    getAll(): Record<string, { value: string; source: VariableSource }>;
    /** Check if variable is defined at any level */
    isDefined(name: string): boolean;
}

/**
 * Service interface for variable resolution
 */
export interface IVariableResolutionService {
    /**
     * Resolve a single variable from all sources
     * Precedence: CSV > User Input > Endpoint > Environment > Script-Environment
     */
    resolveVariable(
        name: string,
        context: VariableResolutionContext
    ): ResolvedVariable | null;

    /**
     * Resolve all variables in a template string
     * Returns the resolved template and information about each variable
     */
    resolveAllVariables(
        template: string,
        context: VariableResolutionContext
    ): Promise<VariableResolutionResult>;

    /**
     * Get list of variables that need user input (not resolvable from other sources)
     */
    getRequiredVariables(
        template: string,
        context: VariableResolutionContext
    ): Promise<string[]>;

    /**
     * Set environment-scoped variable (persists in memory for VS Code session)
     * Used by pre-request scripts via context.variables.setEnvironment()
     */
    setEnvironmentVariable(
        environmentId: string,
        name: string,
        value: string
    ): void;

    /**
     * Set request-scoped variable (cleared after request completes)
     * Used by pre-request scripts via context.variables.setRequest()
     */
    setRequestVariable(
        requestId: string,
        name: string,
        value: string
    ): void;

    /**
     * Get all script-set variables for an environment
     */
    getEnvironmentVariables(
        environmentId: string
    ): Record<string, ResolvedVariable>;

    /**
     * Get all variables for an environment (config + script-set)
     */
    getAllEnvironmentVariables(
        environmentId: string,
        configVariables?: Record<string, string>
    ): Record<string, ResolvedVariable>;

    /**
     * Clear script-set variables for an environment
     * Called when environment is deactivated or VS Code restarts
     */
    clearScriptVariables(environmentId: string): void;

    /**
     * Clear request-scoped variables for a request
     * Called after request completes
     */
    clearRequestVariables(requestId: string): void;

    /**
     * Create a variable store for script context
     * Used to provide the variables object to pre-request scripts
     */
    createVariableStore(
        context: VariableResolutionContext
    ): IVariableStore;

    /**
     * Substitute variables in a string using the resolved values
     */
    substituteVariables(
        template: string,
        variables: Record<string, string>
    ): string;
}
