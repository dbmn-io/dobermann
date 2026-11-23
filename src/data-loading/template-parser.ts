// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Template Parser for JSON variable extraction and processing
 *
 * This module handles parsing JSON templates with variable placeholders,
 * extracting variables, detecting arrays, and processing templates with CSV data.
 *
 * Issue #130: Now supports simplified template syntax:
 *   {{}}        → infers variable name from JSON key
 *   {{:type}}   → infers name from key with explicit type
 */

import { DataType } from './types';
import {
    extractVariablesFromJsonTemplate,
    resolveTemplateVariables,
    InferredVariable,
    validateNonJsonTemplate,
    TemplateValidationError,
    JsonTemplateParseResult
} from './json-template-parser';
import { parseModifiers, extractModifiersFromFormat } from './modifier-parser';
import { applyModifiers, applyModifiersAndFormat } from './modifier-executor';
import { refreshTemplateLookups, templateUsesLookups } from './template-lookups';
import { ParsedModifiers, ModifierResult } from './modifier-types';

// Re-export for use by other modules
export type { TemplateValidationError, InferredVariable, JsonTemplateParseResult };

/**
 * GitHub Issue #153: Sequence modifier types for nested arrays
 *
 * - 'default': One value per object scope — shared across the request root,
 *   and shared within each array element, with each element taking the next (#288)
 * - 'local': Unique within array, resets for each array instance (in-memory only)
 * - 'global': Unique per item, persisted per array path
 * - 'parent': Reuse parent element's sequence value
 */
export type SequenceModifier = 'default' | 'local' | 'global' | 'parent';

/**
 * GitHub Issue #153: Sequence context for tracking state during nested array processing
 *
 * This context is passed through template processing to enable different
 * sequence behaviors at different nesting levels.
 */
export interface SequenceContext {
    /** The parent element's sequence value (for :parent modifier) */
    parentSequence?: number;
    /** Local counters per array path (for :local modifier) - resets per array instance */
    localCounters: Map<string, number>;
    /** Current array path being processed (e.g., "orders[].items") */
    arrayPath?: string;
    /** Instance ID to distinguish between different array instances for :local */
    arrayInstanceId?: string;
}

export interface TemplateVariable {
    name: string;
    dataType: DataType;
    hasExplicitType: boolean;
    occurrences: number;
    isA8Variable?: boolean;
    /** Issue #130: Whether the name was inferred from JSON key */
    isInferred?: boolean;
    /** GitHub Issue #162: Format modifier for date/datetime types */
    formatModifier?: string;
}

/**
 * GitHub Issue #162: Timezone configuration for date/datetime processing
 */
export interface TimezoneConfig {
    /** Source timezone of the CSV data (e.g., 'Australia/Sydney', 'America/New_York') */
    sourceTimezone?: string;
    /** Target timezone for the API (e.g., 'UTC', 'America/Los_Angeles') */
    targetTimezone?: string;
}

/**
 * GitHub Issue #220: Sentinel path for top-level JSON arrays.
 * When the template is `[{...}]` (array at root), findArraysRecursive assigns this
 * constant so downstream code can handle it instead of an empty string.
 */
export const ROOT_ARRAY_PATH = '$root';

export interface ArrayInfo {
    path: string;
    isRepeatable: boolean;
    elementCount?: number;
}

export interface ParsedTemplate {
    isValid: boolean;
    variables: TemplateVariable[];
    arrays: ArrayInfo[];
    error?: string;
}

export interface ProcessingResult {
    success: boolean;
    processedJson?: string;
    error?: string;
}

/**
 * GitHub Issue #153: Extended sequence manager interface
 *
 * Supports both the standard getNextSequence and the new array-specific sequence methods
 */
export interface ExtendedSequenceManager {
    /** Get the next sequence number for an endpoint (standard behavior) */
    getNextSequence: (id: string) => Promise<number>;
    /** Get the next sequence for a specific array path (for :global modifier) */
    getNextArraySequence?: (endpointId: string, arrayPath: string) => Promise<number>;
}

export class TemplateParser {
    // Issue #130: Updated regex to allow empty content inside {{}}
    private readonly VARIABLE_REGEX = /\{\{([^}]*)\}\}/g;
    private readonly A8_VARIABLE_REGEX = /\{\{A8:([^}]+)\}\}/gi;
    // GitHub Issue #162: Added 'datetime' type for format modifiers
    private readonly VALID_DATA_TYPES: DataType[] = ['string', 'number', 'boolean', 'date', 'datetime'];
    private readonly VALID_A8_VARIABLES = ['sequence', 'date', 'datetime'];
    // GitHub Issue #153: Valid sequence modifiers
    private readonly VALID_SEQUENCE_MODIFIERS: SequenceModifier[] = ['local', 'global', 'parent'];

    // Cache for A8:sequence value within a single request
    private sequenceCache: Map<string, number> = new Map();

    /**
     * Extract variables from a JSON body template with key inference support (Issue #130)
     *
     * This method uses JSON-aware parsing to infer variable names from keys
     * when using {{}} or {{:type}} syntax.
     *
     * @param jsonTemplate - JSON template string
     * @returns Array of template variables with resolved names
     */
    extractVariablesFromJson(jsonTemplate: string): TemplateVariable[] {
        const result = extractVariablesFromJsonTemplate(jsonTemplate);

        // Convert InferredVariable to TemplateVariable
        // GitHub Issue #162: Include formatModifier for date/datetime types
        return result.variables.map(v => ({
            name: v.resolvedName,
            dataType: v.dataType,
            hasExplicitType: v.hasExplicitType,
            occurrences: 1, // JSON-aware parser deduplicates
            isA8Variable: v.isA8Variable,
            isInferred: v.isInferred,
            formatModifier: v.formatModifier
        }));
    }

    /**
     * Validate a non-JSON template (URL, query params, headers)
     *
     * Returns errors if {{}} or {{:type}} syntax is used outside JSON context.
     *
     * @param template - Template string (URL path, query param value, header value)
     * @param contextName - Context for error messages (e.g., "URL path")
     * @returns Array of validation errors
     */
    validateNonJsonContext(template: string, contextName: string): TemplateValidationError[] {
        return validateNonJsonTemplate(template, contextName);
    }

    /**
     * Extract variables from a template (legacy method - regex-based)
     *
     * For JSON body templates, prefer extractVariablesFromJson() which
     * supports the {{}} and {{:type}} shorthand syntax.
     */
    extractVariables(template: string): TemplateVariable[] {
        const variableMap = new Map<string, TemplateVariable>();
        const matches = template.matchAll(this.VARIABLE_REGEX);

        for (const match of matches) {
            const variableDeclaration = match[1].trim();
            const { name, dataType, hasExplicitType, isA8Variable } = this.parseVariableDeclaration(variableDeclaration);
            
            if (!isA8Variable && !this.isValidVariableName(name)) {
                continue;
            }

            if (isA8Variable && !this.isValidA8Variable(name)) {
                continue;
            }

            const normalizedName = isA8Variable ? name : this.normalizeVariableName(name);
            
            if (variableMap.has(normalizedName)) {
                const existing = variableMap.get(normalizedName)!;
                existing.occurrences++;
            } else {
                variableMap.set(normalizedName, {
                    name: normalizedName,
                    dataType,
                    hasExplicitType,
                    occurrences: 1,
                    isA8Variable
                });
            }
        }

        return Array.from(variableMap.values());
    }

    /**
     * Detect arrays in a JSON template
     */
    detectArrays(template: string): ArrayInfo[] {
        try {
            const parsed = JSON.parse(template);
            const arrays: ArrayInfo[] = [];
            
            this.findArraysRecursive(parsed, arrays);
            
            return arrays;
        } catch (error) {
            return [];
        }
    }

    /**
     * Parse a complete JSON template
     *
     * Issue #130: Now uses JSON-aware parsing to support {{}} and {{:type}} syntax
     */
    parseTemplate(template: string): ParsedTemplate {
        // Validate JSON structure
        try {
            JSON.parse(template);
        } catch (error) {
            return {
                isValid: false,
                variables: [],
                arrays: [],
                error: `Invalid JSON: ${error}`
            };
        }

        // Issue #130: Use JSON-aware extraction for full support of {{}} syntax
        const jsonResult = extractVariablesFromJsonTemplate(template);

        // Check for validation errors from JSON-aware parser
        if (jsonResult.errors.length > 0) {
            const firstError = jsonResult.errors[0];
            // Format error message to match expected format for backward compatibility
            let errorMessage = firstError.message;
            if (firstError.type === 'INVALID_TYPE' && firstError.pattern) {
                // Extract the invalid type from the error message for backward compatibility
                const typeMatch = firstError.message.match(/Unknown type '([^']+)'/);
                if (typeMatch) {
                    errorMessage = `Invalid data type: ${typeMatch[1]}. Supported types: ${this.VALID_DATA_TYPES.join(', ')}`;
                }
            }
            return {
                isValid: false,
                variables: [],
                arrays: [],
                error: errorMessage
            };
        }

        // Convert to TemplateVariable format
        // GitHub Issue #162: Include formatModifier for date/datetime types
        const variables = jsonResult.variables.map(v => ({
            name: v.resolvedName,
            dataType: v.dataType,
            hasExplicitType: v.hasExplicitType,
            occurrences: 1,
            isA8Variable: v.isA8Variable,
            isInferred: v.isInferred,
            formatModifier: v.formatModifier
        }));
        
        // Check for invalid data types
        const invalidTypes = variables
            .filter(v => v.hasExplicitType && !this.VALID_DATA_TYPES.includes(v.dataType))
            .map(v => v.dataType);
            
        if (invalidTypes.length > 0) {
            return {
                isValid: false,
                variables: [],
                arrays: [],
                error: `Invalid data type: ${invalidTypes[0]}. Supported types: ${this.VALID_DATA_TYPES.join(', ')}`
            };
        }

        // Detect arrays
        const arrays = this.detectArrays(template);

        return {
            isValid: true,
            variables,
            arrays
        };
    }

    /**
     * Process a template with CSV data
     */
    /**
     * Get required variables for runtime prompting (excluding A8 variables)
     */
    getRequiredVariablesForPrompt(template: string): TemplateVariable[] {
        const parsed = this.parseTemplate(template);
        if (!parsed.isValid) {
            return [];
        }
        
        // Return only non-A8 variables that need user input
        return parsed.variables.filter(variable => !variable.isA8Variable);
    }

    /**
     * Process template with runtime variables when no CSV file is provided
     * GitHub Issue #153: Added sequenceContext parameter for nested array sequence modifiers
     */
    async processTemplateWithRuntimeVariables(
        template: string,
        runtimeVariables: Record<string, string>,
        endpointId?: string,
        sequenceManager?: ExtendedSequenceManager,
        sequenceContext?: SequenceContext
    ): Promise<ProcessingResult> {
        return this.processTemplateAsync(template, runtimeVariables, undefined, endpointId, sequenceManager, sequenceContext);
    }

    /**
     * Synchronous version for backwards compatibility (no A8 variables)
     * GitHub Issue #162: Added timezoneConfig parameter
     */
    processTemplate(
        template: string,
        csvRow: Record<string, string>,
        repeatConfig?: Record<string, number>,
        timezoneConfig?: TimezoneConfig
    ): ProcessingResult {
        try {
            // Parse the template to get structure
            const parsed = this.parseTemplate(template);
            if (!parsed.isValid) {
                return {
                    success: false,
                    error: parsed.error
                };
            }

            // Check for missing CSV columns (excluding A8 variables)
            const missingColumns = parsed.variables
                .filter(v => !v.isA8Variable)
                .map(v => v.name)
                .filter(name => !(name in csvRow));
                
            if (missingColumns.length > 0) {
                return {
                    success: false,
                    error: `Missing CSV column: ${missingColumns[0]}`
                };
            }

            // Process the template
            let processedTemplate = template;
            
            // Replace variables with CSV values (skip A8 variables in sync mode)
            for (const variable of parsed.variables) {
                if (variable.isA8Variable) {
                    // Skip A8 variables in synchronous mode
                    continue;
                }

                // GitHub Issue #162: Pass formatModifier and timezoneConfig for date/datetime types
                const value = csvRow[variable.name];
                const convertedValue = this.convertValue(value, variable.dataType, variable.formatModifier, timezoneConfig);

                // GitHub Issue #175: Handle omitKey for |opt modifier
                if (convertedValue && typeof convertedValue === 'object' && convertedValue.__omitKey) {
                    // For |opt modifier with empty value: remove the entire key-value pair
                    // This requires JSON manipulation after initial processing
                    // Mark for later removal with a special placeholder
                    const omitMarker = `"__OMIT_KEY_${variable.name}__"`;
                    if (variable.hasExplicitType) {
                        // Build regex that matches the original template pattern
                        // For dates: ":iso" or ":iso|+2d" or "|opt" (modifier only)
                        // For others: "|modifier"
                        let formatPart = '';
                        if (variable.formatModifier) {
                            if (variable.dataType === 'date' || variable.dataType === 'datetime') {
                                // Date types: check if formatModifier is purely a pipe modifier
                                const isPipeModifierOnly = /^([+-]\d+[dhwmy]|opt|null)$/i.test(variable.formatModifier);
                                if (isPipeModifierOnly) {
                                    formatPart = `\\|${this.escapeRegex(variable.formatModifier)}`;
                                } else {
                                    // Has format component (like "iso|opt")
                                    formatPart = `:${this.escapeRegex(variable.formatModifier)}`;
                                }
                            } else {
                                formatPart = `\\|${this.escapeRegex(variable.formatModifier)}`;
                            }
                        }
                        const regexWithType = new RegExp(`"\\{\\{${this.escapeRegex(variable.name)}:${variable.dataType}${formatPart}\\}\\}"`, 'gi');
                        processedTemplate = processedTemplate.replace(regexWithType, omitMarker);
                    }
                    const regexWithoutType = new RegExp(`\\{\\{${this.escapeRegex(variable.name)}\\}\\}`, 'gi');
                    processedTemplate = processedTemplate.replace(regexWithoutType, omitMarker);
                    continue;
                }

                // GitHub Issue #175: Handle intentional null from |null modifier
                // __nullValue marker means the modifier system intentionally returned null
                let actualConvertedValue = convertedValue;
                if (convertedValue && typeof convertedValue === 'object' && convertedValue.__nullValue) {
                    // Convert marker back to actual null for JSON serialization
                    actualConvertedValue = null;
                }
                // GitHub Issue #175: Check for actual conversion errors (null without marker)
                else if (convertedValue === null && (variable.dataType !== 'string' || variable.formatModifier)) {
                    return {
                        success: false,
                        error: `Invalid ${variable.dataType} value: ${value} for variable ${variable.name}`
                    };
                }

                // For explicit type variables, replace with type-specific format
                // GitHub Issue #162: Handle format modifiers for date/datetime types
                // GitHub Issue #175: Updated for pipe-delimited modifiers syntax
                // Syntax: {{VAR:type|modifier}} for string/number/boolean
                // Syntax: {{VAR:type:format}} or {{VAR:type:format|modifier}} for date/datetime
                // Syntax: {{VAR:type|modifier}} for date/datetime with modifier only (no format)
                if (variable.hasExplicitType) {
                    // Build regex that includes the format modifier if present
                    // GitHub Issue #175: Need to reconstruct the original template pattern
                    // - For string/number/boolean: modifiers use pipe: "|upper" or "|3-50"
                    // - For date/datetime:
                    //   - Format uses colon: ":iso" or ":YYYY-MM-DD"
                    //   - Modifier only uses pipe: "|+2d" or "|-1d" or "|opt" or "|null"
                    //   - Format+modifier: ":iso|+2d" or ":iso|opt"
                    let formatPart = '';
                    if (variable.formatModifier) {
                        if (variable.dataType === 'date' || variable.dataType === 'datetime') {
                            // Date types: check if formatModifier is purely a pipe modifier
                            // - Date math: +2d, -1w, etc.
                            // - Empty behavior: opt, null
                            const isPipeModifierOnly = /^([+-]\d+[dhwmy]|opt|null)$/i.test(variable.formatModifier);
                            if (isPipeModifierOnly) {
                                // Just a pipe modifier, original uses pipe: "|+2d" or "|opt"
                                formatPart = `\\|${this.escapeRegex(variable.formatModifier)}`;
                            } else {
                                // Has format component, original uses colon: ":iso" or ":iso|+2d"
                                formatPart = `:${this.escapeRegex(variable.formatModifier)}`;
                            }
                        } else {
                            // String/Number/Boolean: modifiers use pipe: "|upper" or "|3-50"
                            formatPart = `\\|${this.escapeRegex(variable.formatModifier)}`;
                        }
                    }
                    const regexWithType = new RegExp(`"\\{\\{${this.escapeRegex(variable.name)}:${variable.dataType}${formatPart}\\}\\}"`, 'gi');
                    // GitHub Issue #185: |asString forces string output regardless of type
                    const hasAsString = variable.formatModifier && variable.formatModifier.split('|').some(p => p.toLowerCase() === 'asstring');
                    const outputValue = hasAsString ? String(actualConvertedValue) : actualConvertedValue;
                    processedTemplate = processedTemplate.replace(regexWithType, JSON.stringify(outputValue));
                }

                // Replace variables without explicit types (treat as template strings)
                const regexWithoutType = new RegExp(`\\{\\{${this.escapeRegex(variable.name)}\\}\\}`, 'gi');
                const stringValue = actualConvertedValue === null ? '' : String(actualConvertedValue);
                const escapedValue = stringValue
                    .replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"');
                processedTemplate = processedTemplate.replace(regexWithoutType, escapedValue);
            }

            // Handle array repetition if configured
            if (repeatConfig) {
                processedTemplate = this.processArrayRepetition(processedTemplate, repeatConfig);
            }

            // GitHub Issue #175: Post-process to remove keys with __OMIT_KEY__ markers
            processedTemplate = this.removeOmittedKeys(processedTemplate);

            // Validate the final JSON
            JSON.parse(processedTemplate);

            return {
                success: true,
                processedJson: processedTemplate
            };
        } catch (error) {
            return {
                success: false,
                error: `Template processing error: ${error}`
            };
        }
    }

    /**
     * GitHub Issue #175: Remove keys with __OMIT_KEY__ markers from JSON
     *
     * This handles the |opt modifier by removing entire key-value pairs
     * where the value was empty.
     */
    private removeOmittedKeys(jsonString: string): string {
        // Pattern to match: "keyName": "__OMIT_KEY_xxx__" with optional trailing comma
        // Also handles: "__OMIT_KEY_xxx__" with optional trailing comma (for values in arrays)
        const omitPattern = /,?\s*"[^"]+"\s*:\s*"__OMIT_KEY_[^"]+__"\s*,?/g;

        let result = jsonString.replace(omitPattern, (match) => {
            // If the match has comma on both sides, keep one comma
            const hasLeadingComma = match.trimStart().startsWith(',');
            const hasTrailingComma = match.trimEnd().endsWith(',');

            if (hasLeadingComma && hasTrailingComma) {
                return ',';
            }
            return '';
        });

        // Clean up any double commas or trailing commas before } or ]
        result = result.replace(/,\s*,/g, ',');
        result = result.replace(/,\s*}/g, '}');
        result = result.replace(/,\s*]/g, ']');
        result = result.replace(/{\s*,/g, '{');
        result = result.replace(/\[\s*,/g, '[');

        return result;
    }

    /**
     * Asynchronous version with A8 variable support
     *
     * Issue #130: Now supports {{}} and {{:type}} syntax through JSON-aware parsing
     * GitHub Issue #153: Added sequenceContext parameter for nested array sequence modifiers
     */
    async processTemplateAsync(
        template: string,
        csvRow: Record<string, string>,
        repeatConfig?: Record<string, number>,
        endpointId?: string,
        sequenceManager?: ExtendedSequenceManager,
        sequenceContext?: SequenceContext,
        timezoneConfig?: TimezoneConfig
    ): Promise<ProcessingResult> {
        try {
            // Clear sequence cache for new request (only if no context - context means nested processing)
            if (!sequenceContext) {
                this.sequenceCache.clear();
            }

            // `lu`: the lookup tables read again, so an edit made a moment ago counts
            if (templateUsesLookups(template)) await refreshTemplateLookups();

            // Issue #130: Use JSON-aware parsing for full {{}} support
            const jsonResult = extractVariablesFromJsonTemplate(template);

            // Check for parsing errors
            if (jsonResult.errors.length > 0) {
                return {
                    success: false,
                    error: jsonResult.errors[0].message
                };
            }

            // Check for missing CSV columns (excluding A8 variables and ENV variables)
            // GitHub Issue #165: ENV variables are resolved from environment, not CSV
            const missingColumns = jsonResult.variables
                .filter(v => !v.isA8Variable && !v.isEnvVariable)
                .map(v => v.resolvedName)
                .filter(name => !(name in csvRow));

            if (missingColumns.length > 0) {
                return {
                    success: false,
                    error: `Missing CSV column: ${missingColumns[0]}`
                };
            }

            // Issue #130: Replace variables using position-based replacement
            // Sort by position ascending to build result string from start to end
            const sortedVars = [...jsonResult.variables].sort((a, b) => a.position.start - b.position.start);

            // First, compute all converted values
            const conversions: { variable: InferredVariable; value: any }[] = [];

            // GitHub Issue #153: Determine if we're in an array context
            const isInArray = sequenceContext?.arrayPath !== undefined;

            // GitHub Issue #288: the number every plain {{A8:sequence}} in this
            // call shares when it runs inside an array element. The generators
            // make one call per element, so this scopes it to the element.
            const elementSequence: { value?: number } = {};

            for (const variable of sortedVars) {
                let convertedValue: any;

                if (variable.isA8Variable) {
                    // Process A8 variables - only if sequenceManager is provided
                    // If no sequenceManager, leave A8 variables unchanged for later processing
                    if (!sequenceManager) {
                        // Keep the original pattern - will be processed later
                        convertedValue = variable.originalPattern;
                    } else {
                        // GitHub Issue #153: Pass sequence context for modifier support
                        convertedValue = await this.processA8Variable(
                            variable.resolvedName,
                            endpointId,
                            sequenceManager,
                            isInArray,
                            sequenceContext,
                            elementSequence
                        );
                        if (convertedValue === null) {
                            return {
                                success: false,
                                error: `Failed to process A8 variable: ${variable.resolvedName}`
                            };
                        }
                    }
                } else if (variable.isEnvVariable) {
                    // GitHub Issue #165: Process ENV variables - look up from environment variables in csvRow
                    // ENV variables are passed through csvRow with ENV: prefix during batch execution
                    const envKey = `ENV:${variable.envVariableName}`;
                    if (envKey in csvRow) {
                        convertedValue = csvRow[envKey];
                    } else if (variable.envVariableName && variable.envVariableName in csvRow) {
                        // Fallback: check if the env variable name itself is in csvRow
                        convertedValue = csvRow[variable.envVariableName];
                    } else {
                        // ENV variable not found - this should have been caught before execution
                        return {
                            success: false,
                            error: `Missing environment variable: ${variable.envVariableName}`
                        };
                    }
                } else {
                    // Process regular CSV variables - use resolved name to look up value
                    // GitHub Issue #162: Pass formatModifier and timezoneConfig for date/datetime types
                    const value = csvRow[variable.resolvedName];
                    convertedValue = this.convertValue(value, variable.dataType, variable.formatModifier, timezoneConfig);

                    // GitHub Issue #175: Handle intentional null from |null modifier
                    // __nullValue marker means the modifier system intentionally returned null
                    if (convertedValue && typeof convertedValue === 'object' && convertedValue.__nullValue) {
                        // Convert marker back to actual null for JSON serialization
                        convertedValue = null;
                    }
                    // GitHub Issue #175: Handle actual conversion errors (null without marker)
                    else if (convertedValue === null && (variable.dataType !== 'string' || variable.formatModifier)) {
                        return {
                            success: false,
                            error: this.lastConvertError
                                ? `${variable.resolvedName}: ${this.lastConvertError}`
                                : `Invalid ${variable.dataType} value: ${value} for variable ${variable.resolvedName}`
                        };
                    }
                }

                conversions.push({ variable, value: convertedValue });
            }

            // Build the result string in a single pass using ORIGINAL template positions
            let processedTemplate = '';
            let lastEnd = 0;

            for (const { variable, value } of conversions) {
                // Add the part of original template before this variable
                processedTemplate += template.substring(lastEnd, variable.position.start);

                // GitHub Issue #175: Handle omitKey marker for |opt modifier
                if (value && typeof value === 'object' && value.__omitKey) {
                    // Use a special marker that we'll clean up later
                    const omitMarker = `__OMIT_KEY_${variable.resolvedName}__`;
                    processedTemplate += omitMarker;
                    lastEnd = variable.position.end;
                    continue;
                }

                // Check if the pattern is the ENTIRE quoted value: `": "{{...}}"`
                // This means: the character before is `"`, the character after is `"`,
                // AND the `"` before is immediately after `: ` (allowing whitespace)
                const charBefore = variable.position.start > 0 ? template[variable.position.start - 1] : '';
                const charAfter = variable.position.end < template.length ? template[variable.position.end] : '';
                const isDirectlyQuoted = charBefore === '"' && charAfter === '"';

                // Check if this is the entire value (not concatenated with other text)
                // Look backwards from the opening quote to find `:` followed by optional whitespace
                let isEntireValue = false;
                if (isDirectlyQuoted) {
                    let checkPos = variable.position.start - 2; // Skip the opening quote
                    // Skip whitespace
                    while (checkPos >= 0 && /\s/.test(template[checkPos])) {
                        checkPos--;
                    }
                    // Check if we find a colon
                    isEntireValue = checkPos >= 0 && template[checkPos] === ':';
                }

                // GitHub Issue #175: Handle null values from |null modifier
                // null must be output as JSON null, not the string "null"
                if (value === null) {
                    // Check if we're in a simple quoted context: "{{VAR}}" where we can output JSON null
                    // processedTemplate should end with " and the next char should be "
                    if (processedTemplate.endsWith('"') && charAfter === '"') {
                        // Remove the opening quote and output JSON null
                        processedTemplate = processedTemplate.slice(0, -1);
                        processedTemplate += 'null';
                        // Skip the closing quote
                        lastEnd = variable.position.end + 1;
                    } else {
                        // Concatenated context - output string "null" (edge case)
                        processedTemplate += 'null';
                        lastEnd = variable.position.end;
                    }
                } else if (isEntireValue && variable.hasExplicitType && variable.dataType !== 'string'
                    // GitHub Issue #185: |asString forces string output — skip raw JSON path
                    && !(variable.formatModifier && variable.formatModifier.split('|').some((p: string) => p.toLowerCase() === 'asstring'))
                ) {
                    // For typed non-string values that are the entire value: replace "{{...}}" with raw JSON value
                    // e.g., "{{A8:sequence}}" -> 123 (number)
                    // Remove the opening quote by trimming processedTemplate
                    processedTemplate = processedTemplate.slice(0, -1);
                    processedTemplate += JSON.stringify(value);
                    // Skip the closing quote by advancing lastEnd
                    lastEnd = variable.position.end + 1;
                } else {
                    // For string values, concatenated values, or untyped values:
                    // Just replace {{...}} with the raw string value
                    // e.g., "ACAU-{{SKU}}" -> "ACAU-TEST123"
                    // Escape special JSON characters since value is inside a JSON string context
                    const escapedValue = String(value)
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"');
                    processedTemplate += escapedValue;
                    lastEnd = variable.position.end;
                }
            }

            // Add any remaining part of the template after the last variable
            processedTemplate += template.substring(lastEnd);

            // Handle array repetition if configured
            if (repeatConfig) {
                processedTemplate = this.processArrayRepetition(processedTemplate, repeatConfig);
            }

            // GitHub Issue #175: Post-process to remove keys with __OMIT_KEY__ markers
            processedTemplate = this.removeOmittedKeys(processedTemplate);

            // Validate the final JSON
            JSON.parse(processedTemplate);

            return {
                success: true,
                processedJson: processedTemplate
            };
        } catch (error) {
            return {
                success: false,
                error: `Template processing error: ${error}`
            };
        }
    }

    /**
     * Suggest data type based on variable name
     */
    suggestDataType(variableName: string): DataType {
        const name = variableName.toUpperCase();
        
        // Number patterns
        if (name.includes('QUANTITY') || name.includes('QTY') || 
            name.includes('COUNT') || name.includes('AMOUNT') ||
            name.includes('PRICE') || name.includes('COST') ||
            name.includes('TOTAL') || name.includes('SUM')) {
            return 'number';
        }
        
        // Boolean patterns
        if (name.includes('ACTIVE') || name.includes('ENABLED') || 
            name.includes('FLAG') || name.includes('IS_') ||
            name.includes('HAS_') || name.includes('CAN_')) {
            return 'boolean';
        }
        
        // Date patterns
        if (name.includes('DATE') || name.includes('TIME') ||
            name.includes('TIMESTAMP') || name.includes('CREATED') ||
            name.includes('UPDATED') || name.includes('MODIFIED')) {
            return 'date';
        }
        
        // Default to string
        return 'string';
    }

    /**
     * Validate variable name
     */
    isValidVariableName(name: string): boolean {
        if (!name || name.trim() === '') {
            return false;
        }
        
        const trimmed = name.trim();
        
        // Variable names cannot start with a number or a dot
        if (/^[0-9.]/.test(trimmed)) {
            return false;
        }
        
        // Variable names can contain alphanumeric characters, spaces, hyphens, underscores and
        // dots — a variable may be named after a dotted source column, `{{location.gln}}`
        // (Run Batch "Update Endpoint Template", GitHub Issue #308).
        const validPattern = /^[a-zA-Z0-9\s\-_.]+$/;
        return validPattern.test(trimmed);
    }

    /**
     * Normalize variable name - preserves original case
     */
    normalizeVariableName(name: string): string {
        return name.trim(); // Preserve original case for accurate matching
    }

    /**
     * Check if A8 variable name is valid
     */
    isValidA8Variable(name: string): boolean {
        if (!name.startsWith('A8:')) {
            return false;
        }
        
        const variableType = name.substring(3).toLowerCase();
        return this.VALID_A8_VARIABLES.includes(variableType);
    }

    /**
     * Get data type for A8 variable
     */
    private getA8VariableType(variableType: string): DataType {
        const type = variableType.toLowerCase();
        switch (type) {
            case 'sequence':
                return 'number';
            case 'date':
            case 'datetime':
                return 'string';
            default:
                return 'string';
        }
    }

    /**
     * Process A8 variable and return its value
     * GitHub Issue #140: Support format specifiers like A8:datetime:iso or A8:datetime:YYYY-MM-DD
     * GitHub Issue #153: Support sequence modifiers like A8:sequence:local, A8:sequence:global, A8:sequence:parent
     * GitHub Issue #175: Support date math modifiers like A8:datetime|+4h, A8:date|+2d
     */
    private async processA8Variable(
        variableName: string,
        endpointId?: string,
        sequenceManager?: ExtendedSequenceManager,
        isInArray: boolean = false,
        sequenceContext?: SequenceContext,
        elementSequence?: { value?: number }
    ): Promise<any> {
        if (!variableName.startsWith('A8:')) {
            return null;
        }

        // GitHub Issue #175: Extract pipe-separated date math modifier first
        // e.g., "A8:datetime|+4h" → fullType="datetime", dateMathMod="+4h"
        // e.g., "A8:datetime:iso|+2d" → fullType="datetime:iso", dateMathMod="+2d"
        let fullType = variableName.substring(3); // Remove "A8:" prefix
        let dateMathMod: string | undefined;

        const pipeIndex = fullType.indexOf('|');
        if (pipeIndex !== -1) {
            dateMathMod = fullType.substring(pipeIndex + 1);
            fullType = fullType.substring(0, pipeIndex);
        }

        const parts = fullType.split(':');
        const baseType = parts[0].toLowerCase();

        let now = new Date();

        // GitHub Issue #175: Apply date math modifier using shared utility
        if (dateMathMod && (baseType === 'date' || baseType === 'datetime')) {
            const { applyDateMathToDate } = await import('./modifier-executor');
            now = applyDateMathToDate(now, dateMathMod);
        }

        switch (baseType) {
            case 'sequence':
                return await this.processSequenceVariable(
                    parts,
                    endpointId,
                    sequenceManager,
                    isInArray,
                    sequenceContext,
                    elementSequence
                );

            case 'date':
                // GitHub Issue #140: Support format specifiers for date
                const dateFormat = parts.length > 1 ? parts.slice(1).join(':') : undefined;
                if (dateFormat) {
                    return this.formatDateTime(now, dateFormat);
                }
                // Default: Return date in YYYYMMDD format
                return now.getUTCFullYear().toString() +
                       (now.getUTCMonth() + 1).toString().padStart(2, '0') +
                       now.getUTCDate().toString().padStart(2, '0');

            case 'datetime':
                // GitHub Issue #140: Support format specifiers for datetime
                // NEW DEFAULT: UTC time without milliseconds and Z
                const datetimeFormat = parts.length > 1 ? parts.slice(1).join(':') : undefined;
                if (datetimeFormat) {
                    return this.formatDateTime(now, datetimeFormat);
                }
                // Default: Local format (UTC time without ms and Z)
                return now.toISOString().replace(/\.\d{3}Z$/, '');

            default:
                return null;
        }
    }

    /**
     * GitHub Issue #153: Process sequence variable with modifier support
     *
     * Modifiers:
     * - (none/default): One value per object scope — the request root, or one array element (#288)
     * - :local - Unique within array, resets for each array instance
     * - :global - Unique per item, persisted per array path
     * - :parent - Reuse parent element's sequence value
     */
    private async processSequenceVariable(
        parts: string[],
        endpointId?: string,
        sequenceManager?: ExtendedSequenceManager,
        isInArray: boolean = false,
        sequenceContext?: SequenceContext,
        elementSequence?: { value?: number }
    ): Promise<number | null> {
        if (!endpointId || !sequenceManager) {
            return null;
        }

        // Parse modifier and optional type from parts
        // Format: sequence[:modifier][:type]
        // Examples: "sequence", "sequence:local", "sequence:global:number"
        const { modifier, outputType } = this.parseSequenceModifier(parts);

        let sequenceValue: number;

        switch (modifier) {
            case 'local':
                // GitHub Issue #153: Local modifier - unique within array, resets per array instance
                sequenceValue = this.getLocalSequence(sequenceContext);
                break;

            case 'global':
                // GitHub Issue #153: Global modifier - persisted per array path
                sequenceValue = await this.getGlobalArraySequence(
                    endpointId,
                    sequenceManager,
                    sequenceContext
                );
                break;

            case 'parent':
                // GitHub Issue #153: Parent modifier - inherit parent's sequence
                sequenceValue = this.getParentSequence(sequenceContext, endpointId);
                break;

            default:
                // Default behavior - one value per scope: the request at the
                // root, each array element inside an array (#288)
                sequenceValue = await this.getDefaultSequence(
                    endpointId,
                    sequenceManager,
                    isInArray,
                    elementSequence
                );
        }

        return sequenceValue;
    }

    /**
     * GitHub Issue #153: Parse sequence modifier from variable parts
     *
     * Handles formats like:
     * - ["sequence"] -> { modifier: 'default', outputType: undefined }
     * - ["sequence", "local"] -> { modifier: 'local', outputType: undefined }
     * - ["sequence", "global", "number"] -> { modifier: 'global', outputType: 'number' }
     */
    private parseSequenceModifier(parts: string[]): { modifier: SequenceModifier; outputType?: string } {
        if (parts.length === 1) {
            return { modifier: 'default' };
        }

        const secondPart = parts[1].toLowerCase();

        // Check if second part is a modifier
        if (this.VALID_SEQUENCE_MODIFIERS.includes(secondPart as SequenceModifier)) {
            return {
                modifier: secondPart as SequenceModifier,
                outputType: parts.length > 2 ? parts[2] : undefined
            };
        }

        // Second part is not a modifier, it might be a type (backward compatibility)
        return {
            modifier: 'default',
            outputType: parts[1]
        };
    }

    /**
     * GitHub Issue #153: Get local sequence value (resets per array instance)
     */
    private getLocalSequence(sequenceContext?: SequenceContext): number {
        if (!sequenceContext) {
            // No context - return 1 as first local sequence
            return 1;
        }

        // Build a key that includes the array instance ID to track local counter
        const localKey = sequenceContext.arrayInstanceId || sequenceContext.arrayPath || 'default';

        // Get and increment the local counter for this array instance
        const currentValue = sequenceContext.localCounters.get(localKey) || 0;
        const nextValue = currentValue + 1;
        sequenceContext.localCounters.set(localKey, nextValue);

        return nextValue;
    }

    /**
     * GitHub Issue #153: Get global array sequence value (persisted per array path)
     */
    private async getGlobalArraySequence(
        endpointId: string,
        sequenceManager: ExtendedSequenceManager,
        sequenceContext?: SequenceContext
    ): Promise<number> {
        const arrayPath = sequenceContext?.arrayPath || 'default';

        // Use the extended method if available
        if (sequenceManager.getNextArraySequence) {
            return await sequenceManager.getNextArraySequence(endpointId, arrayPath);
        }

        // Fallback: use regular sequence with array path suffix in cache
        const cacheKey = `${endpointId}:arraySeq:${arrayPath}`;

        // For global, we don't cache - each call gets a new sequence
        // The persistence happens in the sequenceManager
        return await sequenceManager.getNextSequence(endpointId);
    }

    /**
     * GitHub Issue #153: Get parent sequence value (inherit from parent)
     */
    private getParentSequence(sequenceContext?: SequenceContext, endpointId?: string): number {
        if (sequenceContext?.parentSequence !== undefined) {
            return sequenceContext.parentSequence;
        }

        // Fallback: If no parent sequence, try to get from cache (global sequence)
        if (endpointId && this.sequenceCache.has(endpointId)) {
            return this.sequenceCache.get(endpointId)!;
        }

        // Last resort: return 0 to indicate no parent
        return 0;
    }

    /**
     * GitHub Issue #153 / #288: plain {{A8:sequence}} — one number per scope.
     *
     * - At the root of a request, every occurrence shares the request's number.
     * - Inside an array, every occurrence in ONE element shares that element's
     *   number, and each element draws a fresh one:
     *     OriginalOrderId 22, GPCMessageID 22   (root)
     *     Line 1: both fields 23
     *     Line 2: both fields 24
     *
     * This used to draw a new number at every occurrence inside an array, so
     * two fields on the same line got two different numbers.
     * `elementSequence` lives for one processTemplateAsync call, and the
     * generators make one call per array element.
     */
    private async getDefaultSequence(
        endpointId: string,
        sequenceManager: ExtendedSequenceManager,
        isInArray: boolean,
        elementSequence?: { value?: number }
    ): Promise<number> {
        if (isInArray) {
            if (elementSequence?.value !== undefined) {
                return elementSequence.value;
            }
            const elementValue = await sequenceManager.getNextSequence(endpointId);
            if (elementSequence) {
                elementSequence.value = elementValue;
            }
            return elementValue;
        }

        // Root: shared across the whole request (may be pre-seeded by the generator)
        if (this.sequenceCache.has(endpointId)) {
            return this.sequenceCache.get(endpointId)!;
        }

        const sequenceValue = await sequenceManager.getNextSequence(endpointId);
        this.sequenceCache.set(endpointId, sequenceValue);
        return sequenceValue;
    }

    /**
     * GitHub Issue #153: Create a new sequence context for nested array processing
     */
    public createSequenceContext(options?: Partial<SequenceContext>): SequenceContext {
        return {
            parentSequence: options?.parentSequence,
            localCounters: options?.localCounters || new Map<string, number>(),
            arrayPath: options?.arrayPath,
            arrayInstanceId: options?.arrayInstanceId
        };
    }

    /**
     * GitHub Issue #153: Clear the sequence cache
     * Used when processing nested arrays to reset per-request caching
     */
    public clearSequenceCache(): void {
        this.sequenceCache.clear();
    }

    /**
     * GitHub Issue #153: Set a value in the sequence cache
     * Used to pre-cache parent sequence values so root-level {{A8:sequence}} matches :parent
     */
    public setSequenceCache(key: string, value: number): void {
        this.sequenceCache.set(key, value);
    }

    /**
     * GitHub Issue #153: Create a child sequence context for nested arrays
     *
     * @param parentContext - The parent context to inherit from
     * @param parentSequenceValue - The parent's sequence value to pass down
     * @param arrayPath - The current array path
     * @param instanceId - Unique identifier for this array instance
     */
    public createChildSequenceContext(
        parentContext: SequenceContext | undefined,
        parentSequenceValue: number,
        arrayPath: string,
        instanceId?: string
    ): SequenceContext {
        return {
            parentSequence: parentSequenceValue,
            // Create fresh local counters for this array instance
            localCounters: new Map<string, number>(),
            arrayPath,
            arrayInstanceId: instanceId || `${arrayPath}_${Date.now()}`
        };
    }

    /**
     * GitHub Issue #140: Format datetime with named presets or custom format strings
     */
    private formatDateTime(date: Date, format: string): string {
        // Check for named presets first (case-insensitive)
        switch (format.toLowerCase()) {
            case 'local':
                // UTC time without milliseconds and Z suffix
                return date.toISOString().replace(/\.\d{3}Z$/, '');
            case 'iso':
                // Full ISO 8601 with milliseconds and Z
                return date.toISOString();
            case 'date':
                // Date only: YYYY-MM-DD
                return date.toISOString().split('T')[0];
            case 'time':
                // Time only: HH:mm:ss
                return date.toISOString().split('T')[1].replace(/\.\d{3}Z$/, '');
        }

        // Check if it's a custom format string (contains format tokens)
        if (/YYYY|YY|MM|DD|HH|hh|mm|ss|SSS/.test(format)) {
            return this.applyFormatString(date, format);
        }

        // Unknown format - return default local format
        return date.toISOString().replace(/\.\d{3}Z$/, '');
    }

    /**
     * GitHub Issue #140: Apply custom format string to date
     * Tokens: YYYY, YY, MM, DD, HH, hh, mm, ss, SSS, A, Z
     */
    private applyFormatString(date: Date, format: string): string {
        const tokens: Record<string, string> = {
            'YYYY': date.getUTCFullYear().toString(),
            'YY': date.getUTCFullYear().toString().slice(-2),
            'MM': (date.getUTCMonth() + 1).toString().padStart(2, '0'),
            'DD': date.getUTCDate().toString().padStart(2, '0'),
            'HH': date.getUTCHours().toString().padStart(2, '0'),
            'hh': ((date.getUTCHours() % 12) || 12).toString().padStart(2, '0'),
            'mm': date.getUTCMinutes().toString().padStart(2, '0'),
            'ss': date.getUTCSeconds().toString().padStart(2, '0'),
            'SSS': date.getUTCMilliseconds().toString().padStart(3, '0'),
            'A': date.getUTCHours() >= 12 ? 'PM' : 'AM',
            'Z': 'Z'
        };

        let result = format;
        // Replace longest tokens first to avoid partial matches (e.g., YYYY before YY)
        const sortedTokens = Object.entries(tokens).sort((a, b) => b[0].length - a[0].length);
        for (const [token, value] of sortedTokens) {
            result = result.split(token).join(value);
        }
        return result;
    }

    /**
     * Escape special regex characters in variable names
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private parseVariableDeclaration(declaration: string): {
        name: string;
        dataType: DataType;
        hasExplicitType: boolean;
        isA8Variable: boolean;
    } {
        // {{Name | modifiers}}: a text value with modifiers (lu…), its name before the pipe
        const pipeAt = declaration.indexOf('|');
        const colonAt = declaration.indexOf(':');
        if (pipeAt > 0 && (colonAt === -1 || pipeAt < colonAt)) {
            return { name: declaration.substring(0, pipeAt).trim(), dataType: 'string', hasExplicitType: false, isA8Variable: false };
        }
        const colonIndex = declaration.indexOf(':');
        
        if (colonIndex === -1) {
            // No explicit type specified
            return {
                name: declaration.trim(),
                dataType: 'string',
                hasExplicitType: false,
                isA8Variable: false
            };
        }
        
        const prefix = declaration.substring(0, colonIndex).trim();
        const suffix = declaration.substring(colonIndex + 1).trim();
        
        // Check if it's an A8 variable
        if (prefix.toUpperCase() === 'A8') {
            return {
                name: `A8:${suffix}`,
                dataType: this.getA8VariableType(suffix),
                hasExplicitType: true,
                isA8Variable: true
            };
        }
        
        // list and lookup: a value in a lookup table, sent as text (its spec is the modifier chain's)
        if (/^\s*(list|lookup)\s*(\||$)/i.test(suffix)) {
            return { name: prefix, dataType: 'string', hasExplicitType: true, isA8Variable: false };
        }

        // Regular variable with explicit type
        return {
            name: prefix,
            dataType: suffix as DataType,
            hasExplicitType: true,
            isA8Variable: false
        };
    }

    private findArraysRecursive(
        obj: any, 
        arrays: ArrayInfo[], 
        currentPath: string = ''
    ): void {
        if (Array.isArray(obj)) {
            // GitHub Issue #220: Use ROOT_ARRAY_PATH sentinel for top-level arrays
            const effectivePath = currentPath || ROOT_ARRAY_PATH;
            arrays.push({
                path: effectivePath,
                isRepeatable: obj.length > 0, // Empty arrays are not repeatable by default
                elementCount: obj.length
            });

            // Process array elements
            if (obj.length > 0) {
                this.findArraysRecursive(obj[0], arrays, `${effectivePath}[]`);
            }
        } else if (obj && typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj)) {
                const newPath = currentPath ? `${currentPath}.${key}` : key;
                this.findArraysRecursive(value, arrays, newPath);
            }
        }
    }

    /**
     * Convert a value to the target data type
     * GitHub Issue #162: Added formatModifier and timezoneConfig parameters for date/datetime types
     * GitHub Issue #175: Added modifier support for string and number types
     *
     * @param value - The string value from CSV
     * @param dataType - Target data type
     * @param formatModifier - Optional format/modifier string (e.g., '3-50|upper', '>0|rnd(2)')
     * @param timezoneConfig - Optional timezone configuration for source/target conversion
     * @returns The converted value, or { value, omitKey } for opt modifier, or null for errors
     */
    /** Why the last value convertValue gave back null could not be converted, when the modifiers said (lu). */
    private lastConvertError?: string;

    private convertValue(value: string, dataType: DataType, formatModifier?: string, timezoneConfig?: TimezoneConfig): any {
        this.lastConvertError = undefined;
        // GitHub Issue #175: Use modifier system if modifiers are present
        if (formatModifier && (dataType === 'string' || dataType === 'number')) {
            const result = this.applyModifiersToValue(value, dataType, formatModifier);
            if (result.success) {
                // If omitKey is set (|opt modifier), return a special marker
                if (result.omitKey) {
                    return { __omitKey: true };
                }
                // If value is null (from |null modifier on empty value), return a special marker
                // to distinguish intentional null from error null
                if (result.value === null) {
                    return { __nullValue: true };
                }
                return result.value;
            }
            // If modifier application fails, return null to trigger error handling (its words kept: "EA isn't in uom's TMS column")
            this.lastConvertError = result.error;
            return null;
        }

        // GitHub Issue #175: Handle opt/null modifiers for date/datetime types with empty values
        // Check BEFORE attempting date parsing to avoid "Invalid date" errors
        if (formatModifier && (dataType === 'date' || dataType === 'datetime')) {
            const trimmedValue = value?.trim() ?? '';
            const isEmpty = trimmedValue === '';

            if (isEmpty) {
                // Check for opt or null modifier in formatModifier string
                const modifierParts = formatModifier.toLowerCase().split('|');
                const hasOpt = modifierParts.includes('opt');
                const hasNull = modifierParts.includes('null');

                if (hasOpt) {
                    return { __omitKey: true };
                }
                if (hasNull) {
                    return { __nullValue: true };
                }
            }
        }

        switch (dataType) {
            case 'string':
                // GitHub Issue #175: Default trim behavior for strings
                return value.trim();

            case 'number':
                // GitHub Issue #218: Values with leading zeros are identifiers, not numbers
                // Protect GTINs, GLNs, SSCCs, zip codes — even if user typed :number
                const trimmedNum = value.trim();
                if (/^0\d+/.test(trimmedNum) && !trimmedNum.startsWith('+') && !trimmedNum.startsWith('-')) {
                    return trimmedNum; // Preserve as string — these are identifiers
                }
                const num = Number(value);
                return isNaN(num) ? null : num;

            case 'boolean':
                const lowerValue = value.toLowerCase();
                if (['true', 'yes', 'y', '1', 'on'].includes(lowerValue)) {
                    return true;
                }
                if (['false', 'no', 'n', '0', 'off'].includes(lowerValue)) {
                    return false;
                }
                return null;

            case 'date':
                // GitHub Issue #162: date type with format modifiers and timezone conversion
                // GitHub Issue #175: Apply date math modifiers (+2d, -1w, etc.)
                try {
                    let date = new Date(value);
                    if (isNaN(date.getTime())) {
                        return null;
                    }
                    // Apply timezone conversion if configured
                    date = this.convertTimezone(
                        date,
                        timezoneConfig?.sourceTimezone,
                        timezoneConfig?.targetTimezone
                    );
                    // Apply date math modifiers if present
                    const strippedModifier = this.stripEmptyBehaviorModifiers(formatModifier);
                    if (strippedModifier) {
                        const mathResult = this.applyDateMathModifiers(date, strippedModifier, dataType);
                        if (mathResult.modifiedDate) {
                            date = mathResult.modifiedDate;
                        }
                        // Format is what remains after removing date math modifiers
                        return this.formatDateValue(date, mathResult.formatOnly);
                    }
                    return this.formatDateValue(date, undefined);
                } catch {
                    return null;
                }

            case 'datetime':
                // GitHub Issue #162: datetime type with format modifiers and timezone conversion
                // GitHub Issue #175: Apply date math modifiers (+3h, +30m, etc.)
                try {
                    // Normalize datetime to UTC if no timezone specified
                    // This ensures the time is treated as-entered (not local time)
                    let dateValue = value;
                    if (dateValue && !dateValue.endsWith('Z') && !dateValue.match(/[+-]\d{2}:?\d{2}$/)) {
                        dateValue = dateValue + 'Z';
                    }
                    let date = new Date(dateValue);
                    if (isNaN(date.getTime())) {
                        return null;
                    }
                    // Apply timezone conversion if configured
                    date = this.convertTimezone(
                        date,
                        timezoneConfig?.sourceTimezone,
                        timezoneConfig?.targetTimezone
                    );
                    // Apply date math modifiers if present
                    const strippedModifier = this.stripEmptyBehaviorModifiers(formatModifier);
                    if (strippedModifier) {
                        const mathResult = this.applyDateMathModifiers(date, strippedModifier, dataType);
                        if (mathResult.modifiedDate) {
                            date = mathResult.modifiedDate;
                        }
                        // Format is what remains after removing date math modifiers
                        return this.formatDateTimeValue(date, mathResult.formatOnly);
                    }
                    return this.formatDateTimeValue(date, undefined);
                } catch {
                    return null;
                }

            default:
                return value;
        }
    }

    /**
     * GitHub Issue #175: Strip empty-value behavior modifiers (opt, null) from format string
     * These modifiers affect empty value handling, not formatting of actual values.
     *
     * @param formatModifier - The full modifier string (e.g., 'iso|opt', 'opt', '+2d')
     * @returns The format string without opt/null modifiers, or undefined if nothing remains
     */
    private stripEmptyBehaviorModifiers(formatModifier?: string): string | undefined {
        if (!formatModifier) {
            return undefined;
        }

        // Split by pipe and filter out opt/null
        const parts = formatModifier.split('|').filter(part => {
            const lower = part.toLowerCase().trim();
            return lower !== 'opt' && lower !== 'null';
        });

        if (parts.length === 0) {
            return undefined;
        }

        return parts.join('|');
    }

    /**
     * GitHub Issue #175: Apply modifiers to a value
     *
     * This method parses and applies modifiers from the formatModifier string
     * for string and number types.
     *
     * @param value - The raw string value from CSV
     * @param dataType - Target data type
     * @param formatModifier - The modifier string (e.g., '3-50|upper', '>0|rnd(2)')
     * @returns Result with transformed value or error, plus omitKey flag for |opt modifier
     */
    private applyModifiersToValue(
        value: string,
        dataType: DataType,
        formatModifier: string
    ): { success: boolean; value?: any; error?: string; omitKey?: boolean } {
        try {
            // Extract modifiers from the format string
            const { formatOnly, modifiers } = extractModifiersFromFormat(formatModifier, dataType);

            // A broken list or lookup (or an old lu) never falls back: a code sent unchecked is worse than a row that stops
            const luError = modifiers.errors.find(e => /^(list needs|lookup needs|lu is now|Put the text in quotes|ifblank needs)/.test(e));
            if (luError) return { success: false, error: luError };

            // If there are parse errors, log and fall back to simple conversion
            if (modifiers.errors.length > 0) {
                console.warn(`[TemplateParser] Modifier parse errors: ${modifiers.errors.join(', ')}`);
                // Fall back to simple conversion without modifiers
                if (dataType === 'string') {
                    return { success: true, value: value.trim() };
                }
                if (dataType === 'number') {
                    const num = Number(value);
                    return isNaN(num) ? { success: false, error: `Invalid number: ${value}` } : { success: true, value: num };
                }
            }

            // Apply modifiers
            const result = applyModifiers(value, dataType, modifiers);

            if (!result.success) {
                return { success: false, error: result.error };
            }

            // Pass through the omitKey flag for |opt modifier
            return { success: true, value: result.value, omitKey: result.omitKey };
        } catch (error) {
            console.error(`[TemplateParser] Error applying modifiers:`, error);
            return { success: false, error: `Modifier error: ${error}` };
        }
    }

    /**
     * GitHub Issue #162: Convert date from source timezone to target timezone
     *
     * @param date - The Date object (representing a moment in time)
     * @param sourceTimezone - The timezone the original value was in (e.g., 'Australia/Sydney')
     * @param targetTimezone - The timezone to convert to (e.g., 'UTC')
     * @returns Date object adjusted for the target timezone
     */
    private convertTimezone(date: Date, sourceTimezone?: string, targetTimezone?: string): Date {
        // If no timezone conversion needed, return as-is
        if (!sourceTimezone && !targetTimezone) {
            return date;
        }

        // Default to UTC if not specified
        const source = sourceTimezone || 'UTC';
        const target = targetTimezone || 'UTC';

        // If source and target are the same, no conversion needed
        if (source === target) {
            return date;
        }

        try {
            // Get the offset for source timezone at this date
            // This approach works by getting the formatted date string in each timezone
            // and calculating the difference

            // Format the date in the source timezone to get its local representation
            const sourceFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: source,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });

            // Format the date in the target timezone
            const targetFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: target,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });

            // Get the parts in target timezone
            const targetParts = targetFormatter.formatToParts(date);
            const getPart = (parts: Intl.DateTimeFormatPart[], type: string) =>
                parts.find(p => p.type === type)?.value || '0';

            const year = parseInt(getPart(targetParts, 'year'));
            const month = parseInt(getPart(targetParts, 'month')) - 1; // JS months are 0-indexed
            const day = parseInt(getPart(targetParts, 'day'));
            const hour = parseInt(getPart(targetParts, 'hour'));
            const minute = parseInt(getPart(targetParts, 'minute'));
            const second = parseInt(getPart(targetParts, 'second'));

            // Create a new date representing the same moment in the target timezone
            // We use UTC to avoid double-conversion
            return new Date(Date.UTC(year, month, day, hour, minute, second));
        } catch (error) {
            // If timezone conversion fails (e.g., invalid timezone name), return original
            console.warn(`[TemplateParser] Timezone conversion failed from ${source} to ${target}:`, error);
            return date;
        }
    }

    /**
     * GitHub Issue #175: Apply date math modifiers to a date
     *
     * Parses the modifier string, extracts date math operations (+2d, -1w, etc.),
     * applies them to the date, and returns the modified date plus any remaining
     * format string.
     *
     * @param date - The Date object to modify
     * @param modifierString - The modifier string (e.g., "+2d", "iso|+2d", "+1w")
     * @param dataType - The data type ('date' or 'datetime')
     * @returns Object with modified date and format-only string
     */
    private applyDateMathModifiers(
        date: Date,
        modifierString: string,
        dataType: DataType
    ): { modifiedDate: Date | null; formatOnly?: string } {
        // Use the modifier parser to extract date math modifiers
        const { formatOnly, modifiers } = extractModifiersFromFormat(modifierString, dataType);

        // Apply each date math modifier
        let result = date;
        for (const mod of modifiers.modifiers) {
            if (mod.kind === 'dateMath') {
                const newDate = new Date(result.getTime());
                switch (mod.unit) {
                    case 'd': // days
                        newDate.setUTCDate(newDate.getUTCDate() + mod.amount);
                        break;
                    case 'w': // weeks
                        newDate.setUTCDate(newDate.getUTCDate() + (mod.amount * 7));
                        break;
                    case 'M': // months
                        newDate.setUTCMonth(newDate.getUTCMonth() + mod.amount);
                        break;
                    case 'y': // years
                        newDate.setUTCFullYear(newDate.getUTCFullYear() + mod.amount);
                        break;
                    case 'h': // hours
                        newDate.setUTCHours(newDate.getUTCHours() + mod.amount);
                        break;
                    case 'm': // minutes
                        newDate.setUTCMinutes(newDate.getUTCMinutes() + mod.amount);
                        break;
                }
                result = newDate;
            }
        }

        return {
            modifiedDate: result,
            formatOnly
        };
    }

    /**
     * GitHub Issue #162: Format a date value according to the format modifier
     *
     * @param date - The Date object to format
     * @param formatModifier - Optional format modifier
     * @returns Formatted date string
     *
     * Default (no modifier): YYYYMMDD (e.g., "20240104")
     * :iso - YYYY-MM-DD (e.g., "2024-01-04")
     * Custom format - Uses applyFormatString (e.g., "DD-MM-YYYY" -> "04-01-2024")
     */
    private formatDateValue(date: Date, formatModifier?: string): string {
        if (!formatModifier) {
            // Default: YYYYMMDD format (matches A8:date)
            return date.getUTCFullYear().toString() +
                   (date.getUTCMonth() + 1).toString().padStart(2, '0') +
                   date.getUTCDate().toString().padStart(2, '0');
        }

        // Named preset: iso
        if (formatModifier.toLowerCase() === 'iso') {
            return date.toISOString().split('T')[0]; // YYYY-MM-DD
        }

        // Custom format string
        return this.applyFormatString(date, formatModifier);
    }

    /**
     * GitHub Issue #162: Format a datetime value according to the format modifier
     *
     * @param date - The Date object to format
     * @param formatModifier - Optional format modifier
     * @returns Formatted datetime string
     *
     * Default (no modifier): Local format without ms/Z (e.g., "2024-01-04T14:30:00")
     * :iso - Full ISO 8601 (e.g., "2024-01-04T14:30:00.000Z")
     * :date - Date portion only (e.g., "2024-01-04")
     * :time - Time portion only (e.g., "14:30:00")
     * Custom format - Uses applyFormatString
     */
    private formatDateTimeValue(date: Date, formatModifier?: string): string {
        if (!formatModifier) {
            // Default: Local format without milliseconds and Z
            return date.toISOString().replace(/\.\d{3}Z$/, '');
        }

        const modifierLower = formatModifier.toLowerCase();

        switch (modifierLower) {
            case 'iso':
                // Full ISO 8601 with milliseconds and Z
                return date.toISOString();

            case 'date':
                // Date portion only: YYYY-MM-DD
                return date.toISOString().split('T')[0];

            case 'time':
                // Time portion only: HH:mm:ss
                return date.toISOString().split('T')[1].replace(/\.\d{3}Z$/, '');

            case 'local':
                // Explicit local format (same as default)
                return date.toISOString().replace(/\.\d{3}Z$/, '');

            default:
                // Custom format string
                return this.applyFormatString(date, formatModifier);
        }
    }

    private processArrayRepetition(template: string, repeatConfig: Record<string, number>): string {
        try {
            const parsed = JSON.parse(template);
            
            for (const [arrayPath, repetitions] of Object.entries(repeatConfig)) {
                this.repeatArrayAtPath(parsed, arrayPath, repetitions);
            }
            
            return JSON.stringify(parsed, null, 2);
        } catch (error) {
            throw new Error(`Array repetition processing failed: ${error}`);
        }
    }

    private repeatArrayAtPath(obj: any, path: string, repetitions: number): void {
        const pathParts = path.split('.');
        let current = obj;
        
        // Navigate to the parent of the array
        for (let i = 0; i < pathParts.length - 1; i++) {
            const part = pathParts[i].replace('[]', '');
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
                if (Array.isArray(current) && current.length > 0) {
                    current = current[0];
                }
            } else {
                return; // Path not found
            }
        }
        
        // Get the array to repeat
        const arrayKey = pathParts[pathParts.length - 1];
        if (current && typeof current === 'object' && arrayKey in current) {
            const array = current[arrayKey];
            if (Array.isArray(array) && array.length > 0) {
                const originalElement = array[0];
                const repeatedElements = Array(repetitions).fill(null).map(() => 
                    JSON.parse(JSON.stringify(originalElement))
                );
                current[arrayKey] = repeatedElements;
            }
        }
    }
}