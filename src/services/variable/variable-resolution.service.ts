// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Variable Resolution Service Implementation
 *
 * Resolves template variables from multiple sources with defined precedence:
 * 1. CSV row data (highest priority)
 * 2. User input
 * 3. Endpoint variables
 * 4. Environment variables
 * 5. Script-set environment variables
 * 6. Script-set request variables
 *
 * GitHub Issues #113 and #126
 */

import {
    IVariableResolutionService,
    IVariableStore,
    ResolvedVariable,
    VariableResolutionContext,
    VariableResolutionResult,
    VariableSource
} from './variable-resolution.interface';

/**
 * Variable pattern for matching {{variableName}} or {{variableName:type}}
 * Also matches system variables like {{A8:uuid}} or {{V8:timestamp}}
 * Group 1 captures the full variable name (including system prefix if present)
 */
const VARIABLE_PATTERN = /\{\{((?:A8:|V8:)?[^}:]+)(?::[^}]+)?\}\}/g;
const SYSTEM_VARIABLE_PREFIXES = ['A8:', 'V8:'];

export class VariableResolutionService implements IVariableResolutionService {
    /**
     * In-memory storage for script-set environment variables
     * Map of environmentId -> variableName -> value
     */
    private scriptEnvironmentVariables: Map<string, Map<string, string>> = new Map();

    /**
     * In-memory storage for script-set request variables
     * Map of requestId -> variableName -> value
     */
    private scriptRequestVariables: Map<string, Map<string, string>> = new Map();

    constructor() {}

    /**
     * Resolve a single variable from all sources
     * Precedence: CSV > User > Script-Request > Endpoint > Environment > Script-Environment
     */
    resolveVariable(
        name: string,
        context: VariableResolutionContext
    ): ResolvedVariable | null {
        // Skip system variables
        if (this.isSystemVariable(name)) {
            return null;
        }

        // 1. Check CSV row (highest priority for batch execution)
        if (context.csvRow && name in context.csvRow && context.csvRow[name] !== '') {
            return {
                name,
                value: context.csvRow[name],
                source: 'csv'
            };
        }

        // 2. Check user input
        if (context.userInput && name in context.userInput && context.userInput[name] !== '') {
            return {
                name,
                value: context.userInput[name],
                source: 'user'
            };
        }

        // 3. Check request-scoped script variables
        if (context.requestId) {
            const requestVars = this.scriptRequestVariables.get(context.requestId);
            if (requestVars && requestVars.has(name)) {
                return {
                    name,
                    value: requestVars.get(name)!,
                    source: 'script-request'
                };
            }
        }

        // 4. Check endpoint variables (from context)
        if (context.endpointVariables && name in context.endpointVariables && context.endpointVariables[name] !== '') {
            return {
                name,
                value: context.endpointVariables[name],
                source: 'endpoint'
            };
        }

        // 5. Check environment variables from config (from context)
        if (context.environmentVariables && name in context.environmentVariables && context.environmentVariables[name] !== '') {
            return {
                name,
                value: context.environmentVariables[name],
                source: 'environment'
            };
        }

        // 6. Check script-set environment variables
        const envScriptVars = this.scriptEnvironmentVariables.get(context.environmentId);
        if (envScriptVars && envScriptVars.has(name)) {
            return {
                name,
                value: envScriptVars.get(name)!,
                source: 'script-environment'
            };
        }

        // Variable not found
        return null;
    }

    /**
     * Resolve all variables in a template string
     */
    async resolveAllVariables(
        template: string,
        context: VariableResolutionContext
    ): Promise<VariableResolutionResult> {
        const variables: Record<string, ResolvedVariable> = {};
        const unresolvedVariables: string[] = [];
        let resolvedTemplate = template;

        // Extract all variable names from template
        const variableNames = this.extractVariableNames(template);

        // Resolve each variable
        for (const name of variableNames) {
            const resolved = this.resolveVariable(name, context);
            if (resolved) {
                variables[name] = resolved;
            } else {
                unresolvedVariables.push(name);
            }
        }

        // Substitute resolved variables in template
        const resolvedValues: Record<string, string> = {};
        for (const [name, resolved] of Object.entries(variables)) {
            resolvedValues[name] = resolved.value;
        }
        resolvedTemplate = this.substituteVariables(template, resolvedValues);

        return {
            resolvedTemplate,
            variables,
            unresolvedVariables
        };
    }

    /**
     * Get list of variables that need user input
     */
    async getRequiredVariables(
        template: string,
        context: VariableResolutionContext
    ): Promise<string[]> {
        const variableNames = this.extractVariableNames(template);
        const required: string[] = [];

        for (const name of variableNames) {
            const resolved = this.resolveVariable(name, context);
            if (!resolved) {
                required.push(name);
            }
        }

        return required;
    }

    /**
     * Set environment-scoped variable
     */
    setEnvironmentVariable(
        environmentId: string,
        name: string,
        value: string
    ): void {
        if (!this.scriptEnvironmentVariables.has(environmentId)) {
            this.scriptEnvironmentVariables.set(environmentId, new Map());
        }
        this.scriptEnvironmentVariables.get(environmentId)!.set(name, value);
    }

    /**
     * Set request-scoped variable
     */
    setRequestVariable(
        requestId: string,
        name: string,
        value: string
    ): void {
        if (!this.scriptRequestVariables.has(requestId)) {
            this.scriptRequestVariables.set(requestId, new Map());
        }
        this.scriptRequestVariables.get(requestId)!.set(name, value);
    }

    /**
     * Get all variables for an environment (script-set only)
     * Note: Config variables should be passed via context
     */
    getEnvironmentVariables(
        environmentId: string
    ): Record<string, ResolvedVariable> {
        const result: Record<string, ResolvedVariable> = {};

        // Get script-set variables
        const scriptVars = this.scriptEnvironmentVariables.get(environmentId);
        if (scriptVars) {
            for (const [name, value] of scriptVars.entries()) {
                result[name] = { name, value, source: 'script-environment' };
            }
        }

        return result;
    }

    /**
     * Get all variables for an environment including config variables
     */
    getAllEnvironmentVariables(
        environmentId: string,
        configVariables?: Record<string, string>
    ): Record<string, ResolvedVariable> {
        const result: Record<string, ResolvedVariable> = {};

        // Get config variables
        if (configVariables) {
            for (const [name, value] of Object.entries(configVariables)) {
                result[name] = { name, value, source: 'environment' };
            }
        }

        // Get script-set variables (override config)
        const scriptVars = this.scriptEnvironmentVariables.get(environmentId);
        if (scriptVars) {
            for (const [name, value] of scriptVars.entries()) {
                result[name] = { name, value, source: 'script-environment' };
            }
        }

        return result;
    }

    /**
     * Clear script-set variables for an environment
     */
    clearScriptVariables(environmentId: string): void {
        this.scriptEnvironmentVariables.delete(environmentId);
    }

    /**
     * Clear request-scoped variables
     */
    clearRequestVariables(requestId: string): void {
        this.scriptRequestVariables.delete(requestId);
    }

    /**
     * Create a variable store for script context
     */
    createVariableStore(
        context: VariableResolutionContext
    ): IVariableStore {
        const service = this;

        return {
            get(name: string): string | undefined {
                const resolved = service.resolveVariable(name, context);
                return resolved?.value;
            },

            setEnvironment(name: string, value: string): void {
                service.setEnvironmentVariable(context.environmentId, name, value);
            },

            setRequest(name: string, value: string): void {
                if (context.requestId) {
                    service.setRequestVariable(context.requestId, name, value);
                }
            },

            getAll(): Record<string, { value: string; source: VariableSource }> {
                const result: Record<string, { value: string; source: VariableSource }> = {};

                // Collect from all sources (in reverse precedence order so higher precedence overwrites)

                // Script environment variables
                const envScriptVars = service.scriptEnvironmentVariables.get(context.environmentId);
                if (envScriptVars) {
                    for (const [name, value] of envScriptVars.entries()) {
                        result[name] = { value, source: 'script-environment' };
                    }
                }

                // Environment config variables (from context)
                if (context.environmentVariables) {
                    for (const [name, value] of Object.entries(context.environmentVariables)) {
                        result[name] = { value, source: 'environment' };
                    }
                }

                // Endpoint variables (from context)
                if (context.endpointVariables) {
                    for (const [name, value] of Object.entries(context.endpointVariables)) {
                        result[name] = { value, source: 'endpoint' };
                    }
                }

                // Request script variables
                if (context.requestId) {
                    const requestVars = service.scriptRequestVariables.get(context.requestId);
                    if (requestVars) {
                        for (const [name, value] of requestVars.entries()) {
                            result[name] = { value, source: 'script-request' };
                        }
                    }
                }

                // User input
                if (context.userInput) {
                    for (const [name, value] of Object.entries(context.userInput)) {
                        if (value !== '') {
                            result[name] = { value, source: 'user' };
                        }
                    }
                }

                // CSV row (highest priority)
                if (context.csvRow) {
                    for (const [name, value] of Object.entries(context.csvRow)) {
                        if (value !== '') {
                            result[name] = { value, source: 'csv' };
                        }
                    }
                }

                return result;
            },

            isDefined(name: string): boolean {
                return service.resolveVariable(name, context) !== null;
            }
        };
    }

    /**
     * Substitute variables in a string
     */
    substituteVariables(
        template: string,
        variables: Record<string, string>
    ): string {
        return template.replace(VARIABLE_PATTERN, (match, varName) => {
            const name = varName.trim();
            if (name in variables) {
                return variables[name];
            }
            return match; // Keep original if not found
        });
    }

    /**
     * Extract variable names from a template
     */
    private extractVariableNames(template: string): string[] {
        const names: string[] = [];
        let match;

        // Reset regex lastIndex
        VARIABLE_PATTERN.lastIndex = 0;

        while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
            const name = match[1].trim();
            if (!this.isSystemVariable(name) && !names.includes(name)) {
                names.push(name);
            }
        }

        return names;
    }

    /**
     * Check if a variable is a system variable (A8:, V8:)
     */
    private isSystemVariable(name: string): boolean {
        return SYSTEM_VARIABLE_PREFIXES.some(prefix => name.startsWith(prefix));
    }
}
