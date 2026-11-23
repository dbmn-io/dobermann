// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Parameter Collection Service
 *
 * Collects template variable values from the user before running an endpoint.
 * One DbmnModal with a field per variable, on the host's modal (the Hub). Any host.
 *
 * Issue #130: Now supports {{}} and {{:type}} shorthand syntax for JSON body templates.
 */

import type { ModalHost } from '../../screens/modal.types';
import {
    IParameterCollectionService,
    ParameterCollectionResult,
    TemplateVariable
} from './parameter-collection.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { extractVariablesFromJsonTemplate } from '../../data-loading/json-template-parser';
import { parseModifiers } from '../../data-loading/modifier-parser';
import { applyModifiers } from '../../data-loading/modifier-executor';
import { lookupValuesOf, refreshTemplateLookups } from '../../data-loading/template-lookups';
import { parseLookupModifier } from '../../data-loading/modifier-parser';
import type { LookupModifier } from '../../data-loading/modifier-types';
import type { DataType } from '../../data-loading/types';

/**
 * A list or lookup variable's table spec. Two forms reach here: `{{uom:list|uom:wms}}` read by the
 * text scan (type list, modifier `uom:wms`), and read from a JSON body (type string, modifier
 * `list:uom:wms`).
 */
function lookupOf(variable: TemplateVariable): LookupModifier | undefined {
    const type = (variable.typeHint || '').toLowerCase();
    const first = (variable.formatModifier || '').split('|')[0].trim();
    const token = type === 'list' || type === 'lookup' ? `${type}:${first}` : /^(list|lookup):/i.test(first) ? first : '';
    if (!token) return undefined;
    const mod = parseLookupModifier(token);
    return typeof mod !== 'string' && mod.kind === 'lookup' ? mod : undefined;
}

type DbmnModalField = {
    id: string;
    type?: 'text' | 'email' | 'password' | 'number' | 'textarea' | 'select' | 'radio';
    label?: string;
    value?: string;
    placeholder?: string;
    options?: Array<{ value: string; label: string; description?: string }>;
    /** Values a text field offers as it's typed in (a list or lookup type's valid values). */
    suggestions?: string[];
    /** Declarative validation, evaluated client-side by DbmnModal on submit.
     *  Functions can't cross the postMessage boundary, so rules are pure data.
     *  See dbmn-modal.js `validateField`. */
    validate?: {
        required?: boolean;
        pattern?: string;
        integer?: boolean;
        /** Inclusive numeric bounds (≥, ≤) */
        min?: number;
        max?: number;
        /** Exclusive numeric bounds (>, <) */
        gt?: number;
        lt?: number;
        /** String length bounds */
        minLength?: number;
        maxLength?: number;
        message?: string;
    };
};
type DbmnModalSpec = {
    title?: string;
    body?: string;
    fields?: DbmnModalField[];
    actions: Array<{
        id: string;
        label: string;
        variant?: 'primary' | 'secondary' | 'danger';
        /** Async validation/work run before the modal closes. If it throws
         *  with a `fieldErrors: Record<string, string>` property, the modal
         *  keeps open and paints the messages inline against the field ids —
         *  see webview-base.ts's `dbmnModalActionPending` handler. */
        onSubmit?: (fields: Record<string, string>) => Promise<void>;
    }>;
    dismissible?: boolean;
    size?: 'sm' | 'md' | 'lg';
    /** Two-column field layout when this modal has many inputs (e.g. Run API
     *  with >5 template variables). */
    columns?: 1 | 2;
    /** Issue #302: footer Paste button (and Ctrl+V in any field) fills every
     *  matching field from a copied spreadsheet row, header + data row. */
    rowPaste?: boolean;
    /** In help mode the modal title opens https://dbmn.io/docs/<doc>/#<section>. */
    help?: { doc: string; section?: string; title?: string };
};
type DbmnModalResult = { actionId: string; fields: Record<string, string> };
type ModalBridge = (spec: DbmnModalSpec) => Promise<DbmnModalResult>;

export class ParameterCollectionService implements IParameterCollectionService {
    constructor(
        private logger: IExtensionDiagnosticLogger,
        /** The values form opens here (VS Code: the Hub's modal; the web app: the Hub page's). */
        private readonly modal: () => ModalHost | undefined = () => undefined
    ) {}

    async collectParameters(
        template: string,
        endpointName: string,
        url?: string,
        queryParams?: Record<string, string>,
        headers?: Record<string, any>
    ): Promise<ParameterCollectionResult> {
        try {
            // Extract variables with type information from all sources
            const bodyVariables = this.extractUserVariablesWithTypes(template).map(v => ({ ...v, sources: ['body'] }));
            const urlVariables = url ? this.extractVariablesFromUrl(url) : [];
            const queryParamVariables = queryParams ? this.extractVariablesFromQueryParams(queryParams) : [];
            const headerVariables = headers ? this.extractVariablesFromHeaders(headers) : [];

            // Combine and deduplicate variables
            const allVariables = this.deduplicateVariables([
                ...bodyVariables,
                ...urlVariables,
                ...queryParamVariables,
                ...headerVariables
            ]);

            if (allVariables.length === 0) {
                // No user variables to collect
                return {
                    cancelled: false,
                    parameters: {}
                };
            }

            this.logger.debug('[ParameterCollectionService] Collecting parameters', undefined, {
                endpointName,
                variableCount: allVariables.length,
                variables: allVariables.map(v => ({ name: v.name, type: v.typeHint, sources: v.sources }))
            });

            // Preferred path: one DbmnModal with a field per variable.
            return await this.collectViaModal(allVariables, endpointName);

        } catch (error) {
            this.logger.error('[ParameterCollectionService] Error collecting parameters', error instanceof Error ? error : undefined, {
                endpointName,
                template: template.substring(0, 200) // Log first 200 chars
            });

            return {
                cancelled: false,
                error: error instanceof Error ? error.message : 'Failed to collect parameters'
            };
        }
    }

    /**
     * Collect parameters with pre-resolved variables (Issues #113 & #126)
     * Skips prompting for variables that are already resolved from environment/endpoint
     */
    async collectParametersWithPreResolved(
        template: string,
        endpointName: string,
        preResolvedVariables: Record<string, string>,
        url?: string,
        queryParams?: Record<string, string>,
        headers?: Record<string, any>
    ): Promise<ParameterCollectionResult> {
        try {
            // Extract variables with type information from all sources
            const bodyVariables = this.extractUserVariablesWithTypes(template).map(v => ({ ...v, sources: ['body'] }));
            const urlVariables = url ? this.extractVariablesFromUrl(url) : [];
            const queryParamVariables = queryParams ? this.extractVariablesFromQueryParams(queryParams) : [];
            const headerVariables = headers ? this.extractVariablesFromHeaders(headers) : [];

            // Combine and deduplicate variables
            const allVariables = this.deduplicateVariables([
                ...bodyVariables,
                ...urlVariables,
                ...queryParamVariables,
                ...headerVariables
            ]);

            // Filter out variables that are already resolved
            const unresolvedVariables = allVariables.filter(v => !(v.name in preResolvedVariables));

            this.logger.debug('[ParameterCollectionService] Collecting parameters with pre-resolved', undefined, {
                endpointName,
                totalVariables: allVariables.length,
                preResolvedCount: Object.keys(preResolvedVariables).length,
                unresolvedCount: unresolvedVariables.length,
                preResolvedNames: Object.keys(preResolvedVariables),
                unresolvedNames: unresolvedVariables.map(v => v.name)
            });

            // Start with pre-resolved variables
            const parameters: Record<string, any> = { ...preResolvedVariables };

            // If no unresolved variables, return pre-resolved
            if (unresolvedVariables.length === 0) {
                return {
                    cancelled: false,
                    parameters
                };
            }

            // Preferred path: one DbmnModal with a field per unresolved variable.
            const modalResult = await this.collectViaModal(unresolvedVariables, endpointName);
            if (modalResult.cancelled || modalResult.error) return modalResult;
            return {
                cancelled: false,
                parameters: { ...parameters, ...(modalResult.parameters || {}) }
            };

        } catch (error) {
            this.logger.error('[ParameterCollectionService] Error collecting parameters with pre-resolved', error instanceof Error ? error : undefined, {
                endpointName,
                preResolvedCount: Object.keys(preResolvedVariables).length
            });

            return {
                cancelled: false,
                error: error instanceof Error ? error.message : 'Failed to collect parameters'
            };
        }
    }

    extractUserVariables(template: string): string[] {
        if (!template || template.trim() === '') {
            return [];
        }

        const variables: Set<string> = new Set();
        
        // Match template variables: {{variableName}} or {{variableName:type}}
        const variablePattern = /\{\{([^}]+)\}\}/g;
        let match;

        while ((match = variablePattern.exec(template)) !== null) {
            const fullVariable = match[1].trim();
            
            // Extract variable name (everything before optional :type, or a pipe's modifiers: {{note | ifblank:'none'}})
            const variableName = fullVariable.split(/[:|]/)[0].trim();
            
            // Skip auto-generated variables (check the full variable string)
            if (this.isAutoGeneratedVariable(fullVariable) || this.isAutoGeneratedVariable(variableName)) {
                continue;
            }

            // Skip conditional and loop syntax
            if (variableName.startsWith('#') || variableName.startsWith('/')) {
                continue;
            }

            variables.add(variableName);
        }

        return Array.from(variables);
    }

    /**
     * Extract user variables with their type information
     *
     * Issue #130: Now uses JSON-aware parsing to support {{}} and {{:type}} shorthand syntax.
     * The JSON parser infers variable names from JSON keys when using shorthand.
     */
    extractUserVariablesWithTypes(template: string): TemplateVariable[] {
        if (!template || template.trim() === '') {
            return [];
        }

        // Issue #130: Try JSON-aware parsing first (for body templates with key inference)
        const trimmedTemplate = template.trim();
        if (trimmedTemplate.startsWith('{') || trimmedTemplate.startsWith('[')) {
            try {
                const jsonResult = extractVariablesFromJsonTemplate(template);

                // If JSON parsing succeeded (even with errors), use its results
                // This handles {{}} and {{:type}} patterns with key inference
                const variables: TemplateVariable[] = [];
                const variableSet = new Set<string>();

                for (const v of jsonResult.variables) {
                    // Skip A8 auto-generated variables
                    if (v.isA8Variable) {
                        continue;
                    }

                    // GitHub Issue #165: Skip ENV variables (they come from environment, not user input)
                    if (v.isEnvVariable) {
                        continue;
                    }

                    // Avoid duplicates
                    if (variableSet.has(v.resolvedName)) {
                        continue;
                    }

                    variableSet.add(v.resolvedName);
                    const tv: TemplateVariable = {
                        name: v.resolvedName,
                        isAutoGenerated: false,
                        typeHint: v.hasExplicitType ? v.dataType : undefined
                    };
                    // Only attach when the template actually declared one, so the
                    // returned shape matches the pre-modifier behaviour for callers
                    // (and tests) that don't care about modifiers.
                    if (v.formatModifier) tv.formatModifier = v.formatModifier;
                    variables.push(tv);
                }

                return variables;
            } catch {
                // Fall back to regex-based parsing if JSON parsing fails
            }
        }

        // Fallback: regex-based extraction for non-JSON templates
        const variables: TemplateVariable[] = [];
        const variableSet = new Set<string>();

        // Match template variables: {{variableName}} or {{variableName:type}}
        // Note: This doesn't support {{}} shorthand (only valid in JSON context)
        const variablePattern = /\{\{([^}]+)\}\}/g;
        let match;

        while ((match = variablePattern.exec(template)) !== null) {
            const fullVariable = match[1].trim();

            // Split on the FIRST colon: everything before is the name, everything
            // after is `type[:format][|mods]`. Pull the bare type off first, then
            // preserve anything else as the batch-style formatModifier so the
            // Run API modal can derive validation from `|>0`, `|int`, `|3-50`, etc.
            const colonIdx = fullVariable.indexOf(':');
            // A pipe before any colon: {{note | ifblank:'none'}}, a text value and its modifiers
            const namePipeIdx = fullVariable.indexOf('|');
            const pipeFirst = namePipeIdx > 0 && (colonIdx === -1 || namePipeIdx < colonIdx);
            const variableName = pipeFirst ? fullVariable.substring(0, namePipeIdx).trim()
                : colonIdx === -1 ? fullVariable.trim() : fullVariable.substring(0, colonIdx).trim();
            let typeHint: string | undefined;
            let formatModifier: string | undefined;
            if (pipeFirst) {
                typeHint = 'string';
                formatModifier = fullVariable.substring(namePipeIdx + 1).trim() || undefined;
            } else if (colonIdx !== -1) {
                const suffix = fullVariable.substring(colonIdx + 1);
                const pipeIdx = suffix.indexOf('|');
                const colonIdx2 = suffix.indexOf(':');
                // Type ends at whichever of pipe/colon comes first (or end of string).
                let typeEnd = suffix.length;
                if (pipeIdx !== -1) typeEnd = Math.min(typeEnd, pipeIdx);
                if (colonIdx2 !== -1) typeEnd = Math.min(typeEnd, colonIdx2);
                typeHint = suffix.substring(0, typeEnd).trim() || undefined;
                const rest = suffix.substring(typeEnd);
                // Strip the leading `|` or `:` before storing.
                formatModifier = rest.length > 1 ? rest.substring(1).trim() : undefined;
            }

            // Skip auto-generated variables
            if (this.isAutoGeneratedVariable(fullVariable) || this.isAutoGeneratedVariable(variableName)) {
                continue;
            }

            // GitHub Issue #165: Skip ENV variables (they come from environment, not user input)
            if (variableName.toUpperCase().startsWith('ENV:') || variableName.toUpperCase() === 'ENV') {
                continue;
            }

            // Skip conditional and loop syntax
            if (variableName.startsWith('#') || variableName.startsWith('/')) {
                continue;
            }

            // Avoid duplicates
            if (variableSet.has(variableName)) {
                continue;
            }

            variableSet.add(variableName);
            const tv: TemplateVariable = {
                name: variableName,
                isAutoGenerated: false,
                typeHint
            };
            if (formatModifier) tv.formatModifier = formatModifier;
            variables.push(tv);
        }

        return variables;
    }

    /**
     * Get example value for a data type with context-aware suggestions
     */
    private getExampleValue(type?: string, variableName?: string): string | undefined {
        if (!type) return undefined;

        const lowerType = type.toLowerCase();
        const lowerName = variableName?.toLowerCase() || '';

        switch (lowerType) {
            case 'string':
                // Context-aware string examples
                if (lowerName.includes('name')) return 'John Doe';
                if (lowerName.includes('email')) return 'john@example.com';
                if (lowerName.includes('phone')) return '+1-555-123-4567';
                if (lowerName.includes('city')) return 'New York';
                if (lowerName.includes('country')) return 'USA';
                if (lowerName.includes('code') || lowerName.includes('id')) return 'ABC123';
                return 'Hello World';
                
            case 'number':
                // Context-aware number examples (order matters - more specific first)
                if (lowerName.includes('percent')) return '85';
                if (lowerName.includes('price') || lowerName.includes('cost')) return '99.99';
                if (lowerName.includes('quantity') || lowerName.includes('count')) return '10';
                if (lowerName.includes('year')) return '2024';
                if (lowerName.includes('age')) return '25';
                return '123';
                
            case 'boolean':
                // Context-aware boolean examples with more options
                if (lowerName.includes('active') || lowerName.includes('enabled')) return 'true';
                if (lowerName.includes('deleted') || lowerName.includes('disabled')) return 'false';
                return 'true (or false, 1, 0, yes, no)';
                
            case 'date':
                // More flexible date examples
                return '2024-01-15 (or Jan 15 2024, 01/15/2024)';
                
            default:
                return undefined;
        }
    }

    /**
     * Validate a value for a specific data type with enhanced validation
     */
    private validateValueForType(value: string, type?: string, variableName?: string): { valid: boolean; error?: string } {
        if (!type) {
            return { valid: true };
        }

        const trimmed = value.trim();
        const lowerName = variableName?.toLowerCase() || '';

        switch (type.toLowerCase()) {
            case 'number':
                if (!/^-?\d*\.?\d+$/.test(trimmed)) {
                    return { valid: false, error: 'Please enter a valid number (e.g., 123, -45, 3.14)' };
                }
                
                // Additional number validation based on context
                const numValue = parseFloat(trimmed);
                if (lowerName.includes('percent') && (numValue < 0 || numValue > 100)) {
                    return { valid: false, error: 'Percentage should be between 0 and 100' };
                }
                if (lowerName.includes('age') && (numValue < 0 || numValue > 150)) {
                    return { valid: false, error: 'Age should be between 0 and 150' };
                }
                break;

            case 'boolean':
                const lowerValue = trimmed.toLowerCase();
                if (!['true', 'false', '1', '0', 'yes', 'no', 'y', 'n'].includes(lowerValue)) {
                    return { valid: false, error: 'Please enter: true/false, yes/no, y/n, or 1/0' };
                }
                break;

            case 'date':
                // Accept various date formats
                const dateValue = new Date(trimmed);
                if (isNaN(dateValue.getTime())) {
                    return { valid: false, error: 'Please enter a valid date (2024-01-15, Jan 15 2024, 01/15/2024)' };
                }
                
                // Warn about dates that might be too far in the future or past
                const now = new Date();
                const yearDiff = dateValue.getFullYear() - now.getFullYear();
                if (yearDiff > 10) {
                    return { valid: false, error: 'Date seems too far in the future. Please check the year.' };
                }
                if (yearDiff < -100) {
                    return { valid: false, error: 'Date seems too far in the past. Please check the year.' };
                }
                break;

            case 'string':
                // Enhanced string validation based on variable name context
                if (lowerName.includes('email')) {
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(trimmed)) {
                        return { valid: false, error: 'Please enter a valid email address (e.g., user@example.com)' };
                    }
                }
                
                if (lowerName.includes('phone')) {
                    // Basic phone number validation - allow various formats
                    const phoneRegex = /^[\d\s\-\+\(\)\.]+$/;
                    if (!phoneRegex.test(trimmed) || trimmed.length < 7) {
                        return { valid: false, error: 'Please enter a valid phone number' };
                    }
                }
                
                if (lowerName.includes('url') || lowerName.includes('link')) {
                    try {
                        new URL(trimmed);
                    } catch {
                        return { valid: false, error: 'Please enter a valid URL (e.g., https://example.com)' };
                    }
                }
                break;

            default:
                // Unknown type - no special validation
                break;
        }

        return { valid: true };
    }

    /**
     * Convert a string value to the appropriate type
     */
    private convertValueToType(value: string, type?: string): any {
        if (!type) {
            return value;
        }

        const trimmed = value.trim();

        switch (type.toLowerCase()) {
            case 'number':
                return parseFloat(trimmed);

            case 'boolean':
                const lowerValue = trimmed.toLowerCase();
                return ['true', '1', 'yes', 'y'].includes(lowerValue);

            case 'date':
                // Return as ISO date string (date portion only)
                const dateObj = new Date(trimmed);
                return dateObj.toISOString().split('T')[0]; // YYYY-MM-DD

            case 'datetime':
            case 'timestamp':
                // GitHub Issue #162: Return as ISO datetime string
                // Note: Timezone conversion happens in execution-commands.ts
                return trimmed; // Already in proper format from input

            case 'time':
                // GitHub Issue #162: Return time string as-is (HH:mm:ss)
                // Normalize to HH:mm:ss format
                const parts = trimmed.split(':');
                if (parts.length === 2) {
                    return `${parts[0]}:${parts[1]}:00`;
                }
                return trimmed;

            case 'string':
            default:
                return value;
        }
    }

    replaceVariables(
        template: string,
        parameters: Record<string, any>
    ): string {
        if (!template || !parameters) {
            return template;
        }

        // Replace each parameter in the template
        let result = template;

        for (const [key, value] of Object.entries(parameters)) {
            // Replace all occurrences of {{key}} or {{key:type}}
            const pattern = new RegExp(`\\{\\{${this.escapeRegExp(key)}(?::[^}]+)?\\}\\}`, 'g');
            result = result.replace(pattern, String(value));
        }

        return result;
    }

    /**
     * Replace variables in URL path with proper URL encoding
     */
    replaceVariablesInUrl(
        url: string,
        parameters: Record<string, any>
    ): string {
        if (!url || !parameters) {
            return url;
        }

        let result = url;

        for (const [key, value] of Object.entries(parameters)) {
            // Replace all occurrences of {{key}} or {{key:type}} with URL encoded values
            const pattern = new RegExp(`\\{\\{${this.escapeRegExp(key)}(?::[^}]+)?\\}\\}`, 'g');
            result = result.replace(pattern, encodeURIComponent(String(value)));
        }

        return result;
    }

    /**
     * Replace variables in query parameters with proper URL encoding
     * Supports both legacy string format and new HeaderConfig format (GitHub Issue #108)
     * Only includes enabled query params in the result
     */
    replaceVariablesInQueryParams(
        queryParams: Record<string, string | any>,
        parameters: Record<string, any>
    ): Record<string, string> {
        if (!queryParams || !parameters) {
            return queryParams as Record<string, string>;
        }

        const result: Record<string, string> = {};

        for (const [key, value] of Object.entries(queryParams)) {
            // Handle both string format (legacy) and object format (new with enabled state)
            let paramValue: string;
            let isEnabled = true;

            if (typeof value === 'string') {
                paramValue = value;
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                paramValue = value.value;
                isEnabled = value.enabled !== false;
            } else {
                continue; // Skip invalid formats
            }

            // Only include enabled query params
            if (isEnabled) {
                let processedValue = paramValue;

                // GitHub Issue #108: Strip repeatable pattern syntax for individual executions
                // Pattern: "itemId={{item}}[ or ]" → "itemId={{item}}"
                // This removes the [ separator ] part meant for batch operations
                const bracketMatch = processedValue.match(/^(.+?)\[([^\]]*)\]$/);
                if (bracketMatch) {
                    processedValue = bracketMatch[1]; // Extract pattern without [ separator ]
                }

                for (const [paramKey, paramValue] of Object.entries(parameters)) {
                    // Replace all occurrences of {{paramKey}} or {{paramKey:type}} with URL encoded values
                    const pattern = new RegExp(`\\{\\{${this.escapeRegExp(paramKey)}(?::[^}]+)?\\}\\}`, 'g');
                    processedValue = processedValue.replace(pattern, encodeURIComponent(String(paramValue)));
                }

                result[key] = processedValue;
            }
        }

        return result;
    }

    /**
     * Replace variables in headers (no encoding needed)
     * Supports both legacy string format and new HeaderConfig format
     * Only includes enabled headers in the result
     */
    replaceVariablesInHeaders(
        headers: Record<string, any>,
        parameters: Record<string, any>
    ): Record<string, any> {
        if (!headers || !parameters) {
            return headers;
        }

        const result: Record<string, any> = {};

        for (const [key, value] of Object.entries(headers)) {
            // Handle both string format (legacy) and object format (new with enabled state)
            let headerValue: string;
            let isEnabled = true;

            if (typeof value === 'string') {
                headerValue = value;
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                headerValue = value.value;
                isEnabled = value.enabled !== false;
            } else {
                continue; // Skip invalid formats
            }

            // Only include enabled headers
            if (isEnabled) {
                let processedValue = headerValue;

                for (const [paramKey, paramValue] of Object.entries(parameters)) {
                    // Replace all occurrences of {{paramKey}} or {{paramKey:type}} without encoding
                    const pattern = new RegExp(`\\{\\{${this.escapeRegExp(paramKey)}(?::[^}]+)?\\}\\}`, 'g');
                    processedValue = processedValue.replace(pattern, String(paramValue));
                }

                result[key] = processedValue;
            }
        }

        return result;
    }

    /**
     * Check if a variable is auto-generated (A8:*, V8:*, etc.)
     */
    private isAutoGeneratedVariable(variableName: string): boolean {
        // Check for A8: prefix (Dobermann auto-generated)
        if (variableName.startsWith('A8:')) {
            return true;
        }

        // Check for V8: prefix (V8 auto-generated, like sequence)
        if (variableName.startsWith('V8:')) {
            return true;
        }

        // Add other auto-generated patterns as needed
        return false;
    }

    /**
     * One DbmnModal with a field per template variable, submitted in a single
     * Run click. Returns:
     *   - `{ error }` when there is no modal host (no Hub open).
     *   - `{ cancelled: true }` if the user dismissed the modal.
     *   - `{ cancelled: false, parameters }` on submit, with values coerced
     *     via `convertValueToType` so downstream code sees typed values.
     */
    private async collectViaModal(
        variables: TemplateVariable[],
        endpointName: string
    ): Promise<ParameterCollectionResult> {
        const host = this.modal();
        if (!host) {
            return { cancelled: false, error: 'Open the DBMN Hub to run with values.' };
        }
        const bridge: ModalBridge = spec => host.showModal(spec as never) as Promise<DbmnModalResult>;

        // (a list or lookup type offers its table's values: the tables read first)
        if (variables.some(v => lookupOf(v))) await refreshTemplateLookups();
        const fields: DbmnModalField[] = variables.map(v => this.buildModalField(v));

        try {
            const useTwoColumns = variables.length > 5;
            const result = await bridge({
                title: `Run: ${endpointName}`,
                body: `Fill in ${variables.length} template variable${variables.length === 1 ? '' : 's'}.`,
                fields,
                // No Cancel button: ×, Escape and a backdrop click all dismiss,
                // and anything other than 'run' is treated as cancelled below.
                actions: [
                    {
                        id: 'run',
                        label: 'Run',
                        variant: 'primary',
                        // Run each field through the batch-prep validator so
                        // Run API enforces IDENTICAL rules to Run Batch — no
                        // duplicated validation logic. On per-field failure
                        // we throw with `fieldErrors` so the modal paints
                        // inline messages and stays open (see webview-base
                        // `dbmnModalActionPending` handler + dbmn-modal.js
                        // paintFieldErrors).
                        onSubmit: async (fields) => {
                            // (`lu`: the lookup tables read now, so the check sees them as they are)
                            if (variables.some(v => lookupOf(v))) await refreshTemplateLookups();
                            const fieldErrors = this.validateFieldsWithBatchPrep(variables, fields);
                            if (Object.keys(fieldErrors).length > 0) {
                                const err = new Error('Some fields need attention') as Error & { fieldErrors?: Record<string, string> };
                                err.fieldErrors = fieldErrors;
                                throw err;
                            }
                        }
                    }
                ],
                dismissible: true,
                size: useTwoColumns || variables.length > 4 ? 'lg' : 'md',
                columns: useTwoColumns ? 2 : 1,
                // Issue #302: a row copied from the source spreadsheet fills the
                // form — the fastest way to smoke-test a template on real data.
                rowPaste: true,
                help: { doc: 'run-api', title: 'Run API help' }
            });

            if (result.actionId !== 'run') {
                return { cancelled: true };
            }

            // Return raw strings — matches how batch prep hands CSV cells to
            // the downstream JsonGenerator, which applies the template's own
            // type conversions + modifiers. Coercing here would compete with
            // that (e.g. `|asString` would already have been lost to a `Number()`).
            const parameters: Record<string, any> = {};
            for (const variable of variables) {
                parameters[variable.name] = (result.fields[variable.name] ?? '').toString();
            }
            return { cancelled: false, parameters };
        } catch (error) {
            this.logger.error('[ParameterCollectionService] Modal collection failed', error instanceof Error ? error : undefined, { endpointName });
            return { cancelled: false, error: error instanceof Error ? error.message : 'Modal collection failed' };
        }
    }

    /** Build the DbmnModal field spec for a single template variable.
     *
     *  Validation is NOT declared client-side — we run every field through
     *  batch prep's `applyModifiers` on the Run action's onSubmit callback,
     *  so Run API and Run Batch share the exact same rule engine. Field
     *  specs only pick the input type (select for boolean, number input for
     *  number, text for the rest) and set a sensible pre-fill for date/time. */
    private buildModalField(variable: TemplateVariable): DbmnModalField {
        const type = (variable.typeHint || '').toLowerCase();
        const label = variable.name;

        // list / lookup (James, 2026-11-23: "we actually give an options list"): the table's valid values
        const lookup = lookupOf(variable);
        if (lookup) {
            const values = lookupValuesOf(lookup);
            return { id: variable.name, type: 'text', label, placeholder: values.length ? 'Pick, or type to filter' : undefined, suggestions: values };
        }

        if (type === 'boolean') {
            return {
                id: variable.name,
                type: 'select',
                label,
                value: 'true',
                options: [
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' }
                ]
            };
        }

        if (type === 'number') {
            return { id: variable.name, type: 'number', label };
        }

        const now = new Date();
        if (type === 'date') {
            return {
                id: variable.name,
                type: 'text',
                label,
                value: now.toISOString().split('T')[0]
            };
        }
        if (type === 'datetime' || type === 'timestamp') {
            const iso = now.toISOString();
            const t = iso.split('T')[1].substring(0, 8);
            return {
                id: variable.name,
                type: 'text',
                label,
                value: `${iso.split('T')[0]}T${t}`
            };
        }
        if (type === 'time') {
            const t = now.toTimeString().split(' ')[0]; // HH:mm:ss
            return { id: variable.name, type: 'text', label, value: t };
        }

        return { id: variable.name, type: 'text', label };
    }

    /** Batch prep stores the format modifier as `format|mods` for date types
     *  (e.g. `iso|+2d`). parseModifiers expects only the modifier portion, so
     *  strip the leading format token for date/datetime. Non-date types don't
     *  have a format prefix — pass through as-is. */
    private stripDateFormatPrefix(formatModifier: string | undefined, dataType: DataType): string | undefined {
        if (!formatModifier) return undefined;
        if (dataType !== 'date' && dataType !== 'datetime') return formatModifier;
        const pipeIdx = formatModifier.indexOf('|');
        if (pipeIdx === -1) {
            // Whole string is either the format or a single modifier. Preset
            // format names (iso/local/date/time) have no modifier chain; math
            // modifiers (+2d, -1w) start with +/-. Treat +/- as a modifier;
            // anything else as a format with no modifiers.
            return /^[+-]/.test(formatModifier.trim()) ? formatModifier : undefined;
        }
        return formatModifier.substring(pipeIdx + 1) || undefined;
    }

    /** Run every user-typed value through batch prep's own `applyModifiers`
     *  and return a map of per-field error messages. Empty map ⇒ everything
     *  passed. Called from the Run action's onSubmit so failures paint inline
     *  in the modal without dismissing (see dbmn-modal.js paintFieldErrors).
     *
     *  This deliberately uses the SAME code path Run Batch runs against each
     *  CSV row — no separate rule set to keep in sync. */
    private validateFieldsWithBatchPrep(
        variables: TemplateVariable[],
        fields: Record<string, string>
    ): Record<string, string> {
        const errors: Record<string, string> = {};
        for (const variable of variables) {
            const type = (variable.typeHint || '').toLowerCase();
            const dataType: DataType =
                type === 'number' || type === 'boolean' || type === 'date' || type === 'datetime'
                    ? (type as DataType)
                    : 'string';
            const value = (fields[variable.name] ?? '').toString();
            // list / lookup: the first part is the table's spec, given to the chain as list:… / lookup:…
            const listSpec = (type === 'list' || type === 'lookup') && variable.formatModifier
                ? [`${type}:${variable.formatModifier.split('|')[0].trim()}`, ...variable.formatModifier.split('|').slice(1)].join('|')
                : undefined;
            const modifierChain = listSpec ?? this.stripDateFormatPrefix(variable.formatModifier, dataType);
            const parsed = modifierChain
                ? parseModifiers(modifierChain, dataType)
                : parseModifiers('', dataType);

            // An ifblank whose text isn't in quotes: said on the field, as the editor and Validate say it
            const quoteError = parsed.errors.find(e => /^(Put the text in quotes|ifblank needs)/.test(e));
            if (quoteError) {
                errors[variable.name] = quoteError;
                continue;
            }

            // Batch prep treats every mapping as isRequired: true by default
            // (csv-column-mapper.ts). The template opts out per-variable only
            // with `|opt` or `|null`. For non-string types, applyModifiers
            // would naturally trip on empty (NaN / invalid date), but strings
            // silently pass empty through — this gate keeps the modal's
            // enforcement consistent with the template's declared intent.
            if (value.trim() === '' && parsed.emptyBehavior === 'default' && parsed.ifBlank === undefined) {
                errors[variable.name] = 'Required';
                continue;
            }

            const result = applyModifiers(value, dataType, parsed);
            if (!result.success && result.error) {
                errors[variable.name] = result.error;
            }
        }
        return errors;
    }

    /**
     * Extract variables from URL path
     */
    extractVariablesFromUrl(url: string): TemplateVariable[] {
        if (!url || url.trim() === '') {
            return [];
        }

        const variables = this.extractUserVariablesWithTypes(url);
        return variables.map(v => ({ ...v, sources: ['url'] }));
    }

    /**
     * Extract variables from query parameters
     * Supports both legacy string format and new HeaderConfig format (GitHub Issue #108)
     */
    extractVariablesFromQueryParams(queryParams: Record<string, string | any>): TemplateVariable[] {
        const variables: TemplateVariable[] = [];
        if (!queryParams) return variables;

        for (const [key, value] of Object.entries(queryParams)) {
            // Handle both string format (legacy) and object format (new with enabled state)
            let paramValue: string | undefined;
            let isEnabled = true;

            if (typeof value === 'string') {
                paramValue = value;
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                paramValue = value.value;
                isEnabled = value.enabled !== false;
            }

            // Only extract variables from enabled query params
            if (paramValue && isEnabled) {
                const paramVariables = this.extractUserVariablesWithTypes(paramValue);
                paramVariables.forEach(v => {
                    variables.push({ ...v, sources: [`query_param:${key}`] });
                });
            }
        }

        return variables;
    }

    /**
     * Extract variables from headers
     * Supports both legacy string format and new HeaderConfig format
     */
    extractVariablesFromHeaders(headers: Record<string, any>): TemplateVariable[] {
        const variables: TemplateVariable[] = [];
        if (!headers) return variables;

        for (const [key, value] of Object.entries(headers)) {
            // Handle both string format (legacy) and object format (new with enabled state)
            let headerValue: string | undefined;
            let isEnabled = true;

            if (typeof value === 'string') {
                headerValue = value;
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                headerValue = value.value;
                isEnabled = value.enabled !== false;
            }

            // Only extract variables from enabled headers
            if (headerValue && isEnabled) {
                const headerVariables = this.extractUserVariablesWithTypes(headerValue);
                headerVariables.forEach(v => {
                    variables.push({ ...v, sources: [`header:${key}`] });
                });
            }
        }

        return variables;
    }

    /**
     * Deduplicate variables by name, merging source information
     */
    private deduplicateVariables(variables: TemplateVariable[]): TemplateVariable[] {
        const variableMap = new Map<string, TemplateVariable>();

        for (const variable of variables) {
            const existing = variableMap.get(variable.name);
            if (existing) {
                // Merge sources and keep the most specific type hint
                existing.sources = [...(existing.sources || []), ...(variable.sources || [])];
                if (!existing.typeHint && variable.typeHint) {
                    existing.typeHint = variable.typeHint;
                }
            } else {
                variableMap.set(variable.name, { ...variable });
            }
        }

        return Array.from(variableMap.values());
    }

    /**
     * Format variable sources for user-friendly prompts
     */
    private formatSourcesForPrompt(sources?: string[]): string {
        if (!sources || sources.length === 0) {
            return '';
        }

        const formattedSources = sources.map(source => {
            if (source === 'url') {
                return 'URL path';
            } else if (source.startsWith('query_param:')) {
                return `query parameter "${source.split(':')[1]}"`;
            } else if (source.startsWith('header:')) {
                return `header "${source.split(':')[1]}"`;
            } else {
                return 'request body';
            }
        });

        return ` (used in: ${formattedSources.join(', ')})`;
    }

    /**
     * Escape special regex characters in a string
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}