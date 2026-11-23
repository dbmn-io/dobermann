// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JSON-Aware Template Parser for Issue #130 - Simplified Template Variables
 *
 * This module parses JSON templates while tracking key context,
 * enabling shorthand syntax like `{{}}` and `{{:type}}` that infer
 * variable names from their containing JSON keys.
 *
 * Examples:
 *   "LocationId": "{{}}"       → infers variable name "LocationId"
 *   "IsActive": "{{:boolean}}" → infers variable name "IsActive" with boolean type
 *   "Qty": "{{Quantity:number}}" → explicit name "Quantity" (existing behavior)
 */

import { DataType } from './types';

/**
 * Represents a template variable with inference metadata
 */
export interface InferredVariable {
    /** Original pattern in template: "{{}}", "{{:boolean}}", "{{Name}}", etc. */
    originalPattern: string;
    /** Resolved variable name (inferred from key or explicit) */
    resolvedName: string;
    /** Whether the name was inferred from JSON key */
    isInferred: boolean;
    /** Data type (explicit or default 'string') */
    dataType: DataType;
    /** Whether type was explicitly specified */
    hasExplicitType: boolean;
    /** JSON key that contained this variable (for debugging) */
    jsonKey: string;
    /** Full JSON path: "Data[0].LocationId" */
    jsonPath: string;
    /** Position in template string */
    position: { start: number; end: number };
    /** Whether this is an A8 system variable */
    isA8Variable: boolean;
    /** GitHub Issue #165: Whether this is an ENV environment variable */
    isEnvVariable: boolean;
    /** GitHub Issue #165: ENV variable name (without ENV: prefix) */
    envVariableName?: string;
    /**
     * GitHub Issue #162 & #175: Format/modifier string after the type
     *
     * Syntax (after {{VAR:type}}):
     * - Colon (:) introduces FORMAT (dates only): {{Date:date:iso}}
     * - Pipe (|) introduces MODIFIERS (all types): {{Name:string|upper}}
     * - Can combine (dates): {{Date:date:iso|+2d}}
     *
     * Examples:
     * - {{Name:string|3-50|upper}} - String with length + uppercase modifiers
     * - {{Qty:number|int|>0}} - Number with integer + positive modifiers
     * - {{Date:date:iso}} - Date with ISO format (no modifiers)
     * - {{Date:date:iso|+2d}} - Date with ISO format + add 2 days modifier
     * - {{A8:datetime|+2d}} - A8 datetime + add 2 days modifier
     *
     * The formatModifier field contains everything after the type, including
     * both format (after :) and modifiers (after |).
     */
    formatModifier?: string;
}

/**
 * Result of JSON template parsing
 */
export interface JsonTemplateParseResult {
    /** Whether parsing succeeded */
    success: boolean;
    /** All variable occurrences with positions (for substitution) - GitHub Issue #139 */
    variables: InferredVariable[];
    /** Unique variables by name (for UI display) - GitHub Issue #139 */
    uniqueVariables?: InferredVariable[];
    /** Validation errors */
    errors: TemplateValidationError[];
}

/**
 * Template validation error
 */
export interface TemplateValidationError {
    /** Error type */
    type: 'EMPTY_VARIABLE_OUTSIDE_JSON' | 'INVALID_TYPE' | 'NO_KEY_CONTEXT' | 'PARSE_ERROR';
    /** Human-readable message */
    message: string;
    /** Position in template */
    position?: { start: number; end: number };
    /** The problematic pattern */
    pattern?: string;
}

// Valid data types for explicit type annotation
// GitHub Issue #162: Added 'datetime' type for format modifiers
const VALID_DATA_TYPES: DataType[] = ['string', 'number', 'boolean', 'date', 'datetime'];

// Valid A8 variable types
const VALID_A8_TYPES = ['sequence', 'date', 'datetime'];

/**
 * Extracts variables from a JSON template with key inference support
 *
 * @param jsonTemplate - JSON string with {{variable}} placeholders
 * @returns Parse result with variables and any errors
 */
export function extractVariablesFromJsonTemplate(jsonTemplate: string): JsonTemplateParseResult {
    const variables: InferredVariable[] = [];
    const errors: TemplateValidationError[] = [];
    const variableMap = new Map<string, InferredVariable>();

    try {
        // Find all variable patterns with their positions
        const variableRegex = /\{\{([^}]*)\}\}/g;
        let match;

        while ((match = variableRegex.exec(jsonTemplate)) !== null) {
            const fullMatch = match[0];
            const content = match[1].trim();
            const startPos = match.index;
            const endPos = startPos + fullMatch.length;

            // Find the JSON key context for this variable
            const keyContext = findJsonKeyContext(jsonTemplate, startPos);

            // Parse the variable content
            const parsed = parseVariableContent(content, keyContext);

            if (parsed.error) {
                errors.push({
                    type: parsed.errorType!,
                    message: parsed.error,
                    position: { start: startPos, end: endPos },
                    pattern: fullMatch
                });
                continue;
            }

            const variable: InferredVariable = {
                originalPattern: fullMatch,
                resolvedName: parsed.name!,
                isInferred: parsed.isInferred!,
                dataType: parsed.dataType!,
                hasExplicitType: parsed.hasExplicitType!,
                jsonKey: keyContext.key || '',
                jsonPath: keyContext.path || jsonPathAt(jsonTemplate, startPos),
                position: { start: startPos, end: endPos },
                isA8Variable: parsed.isA8Variable!,
                // GitHub Issue #165: Include ENV variable info
                isEnvVariable: parsed.isEnvVariable || false,
                envVariableName: parsed.envVariableName,
                // GitHub Issue #162: Include format modifier for date/datetime types
                formatModifier: parsed.formatModifier
            };

            // GitHub Issue #139: Keep ALL occurrences for position-based substitution
            // Also track unique names for UI display
            if (!variableMap.has(variable.resolvedName)) {
                variableMap.set(variable.resolvedName, variable);
            }

            variables.push(variable);
        }

        return {
            success: errors.length === 0,
            // GitHub Issue #139: Return ALL occurrences (with positions) for substitution
            // The template processor needs every occurrence to replace them all
            variables: variables,
            // GitHub Issue #139: Also provide unique variables for UI display
            uniqueVariables: Array.from(variableMap.values()),
            errors
        };
    } catch (error) {
        return {
            success: false,
            variables: [],
            errors: [{
                type: 'PARSE_ERROR',
                message: `Failed to parse template: ${error}`
            }]
        };
    }
}

/**
 * Context about the JSON key containing a variable
 */
interface KeyContext {
    /** The immediate key name, e.g., "LocationId" */
    key: string | null;
    /** Full path, e.g., "Data[0].LocationId" */
    path: string | null;
    /** Whether this is in a valid JSON value position */
    isInValuePosition: boolean;
}

/**
 * Finds the JSON key context for a variable at a given position
 *
 * This parses backwards from the variable position to find the
 * containing key, handling nested objects and arrays.
 *
 * Pattern we're looking for: "keyName": "...{{...}}..."
 * The variable is inside a JSON string value, so we need to:
 * 1. Find the opening quote of the value (going backward)
 * 2. Find the colon
 * 3. Find the key (also quoted)
 */
function findJsonKeyContext(json: string, varPosition: number): KeyContext {
    // Step 1: Go backward to find the opening quote of the value string
    // The variable {{...}} is inside a string value like "prefix{{}}suffix"
    let pos = varPosition - 1;
    let foundValueQuote = false;

    // Skip backward past any characters in the value until we find the opening quote
    while (pos >= 0) {
        const char = json[pos];

        if (char === '"') {
            // Check if this quote is escaped
            if (!isEscaped(json, pos)) {
                foundValueQuote = true;
                pos--;
                break;
            }
        }

        pos--;
    }

    if (!foundValueQuote) {
        return { key: null, path: null, isInValuePosition: false };
    }

    // Step 2: Skip whitespace and find the colon
    while (pos >= 0 && /\s/.test(json[pos])) {
        pos--;
    }

    if (pos < 0 || json[pos] !== ':') {
        return { key: null, path: null, isInValuePosition: false };
    }

    pos--; // Skip the colon

    // Step 3: Skip whitespace and find the closing quote of the key
    while (pos >= 0 && /\s/.test(json[pos])) {
        pos--;
    }

    if (pos < 0 || json[pos] !== '"') {
        return { key: null, path: null, isInValuePosition: false };
    }

    const keyEnd = pos;
    pos--;

    // Step 4: Find the opening quote of the key
    while (pos >= 0) {
        const char = json[pos];

        if (char === '"' && !isEscaped(json, pos)) {
            const keyStart = pos + 1;
            const key = json.substring(keyStart, keyEnd);

            // Build the full path (simplified - just the immediate key for now)
            const path = buildJsonPath(json, varPosition, key);

            return {
                key,
                path,
                isInValuePosition: true
            };
        }

        pos--;
    }

    return { key: null, path: null, isInValuePosition: false };
}

/**
 * Check if a character at a position is escaped (preceded by odd number of backslashes)
 */
function isEscaped(str: string, pos: number): boolean {
    let escapeCount = 0;
    let checkPos = pos - 1;
    while (checkPos >= 0 && str[checkPos] === '\\') {
        escapeCount++;
        checkPos--;
    }
    return escapeCount % 2 === 1;
}

/**
 * Build the JSON path of the value at a position, e.g. "lines[0].sku".
 *
 * Scans forward from the start, keeping a stack of open objects/arrays. Bare {{...}}
 * placeholders (unquoted numbers/booleans) are skipped as values, so the template need
 * not be valid JSON.
 */
export function jsonPathAt(json: string, position: number): string {
    type Frame = { type: 'obj'; key: string | null; expectKey: boolean } | { type: 'arr'; index: number };
    const stack: Frame[] = [];
    let lastString: string | null = null;
    let i = 0;

    while (i < position) {
        const char = json[i];
        if (char === '"') {
            let end = i + 1;
            while (end < json.length && (json[end] !== '"' || isEscaped(json, end))) {
                end++;
            }
            if (end >= position) {
                break; // the position is inside this string (a value; its key is already set)
            }
            lastString = json.substring(i + 1, end);
            i = end + 1;
            continue;
        }
        if (char === '{' && json[i + 1] === '{') {
            const close = json.indexOf('}}', i + 2);
            if (close < 0 || close >= position) {
                break;
            }
            i = close + 2;
            continue;
        }
        const top = stack[stack.length - 1];
        if (char === '{') {
            stack.push({ type: 'obj', key: null, expectKey: true });
        } else if (char === '[') {
            stack.push({ type: 'arr', index: 0 });
        } else if (char === '}' || char === ']') {
            stack.pop();
        } else if (char === ':' && top?.type === 'obj') {
            top.key = lastString;
            top.expectKey = false;
        } else if (char === ',' && top) {
            if (top.type === 'obj') {
                top.key = null;
                top.expectKey = true;
            } else {
                top.index++;
            }
        }
        i++;
    }

    let path = '';
    for (const frame of stack) {
        if (frame.type === 'arr') {
            path += `[${frame.index}]`;
        } else if (frame.key !== null && !frame.expectKey) {
            path += path ? `.${frame.key}` : frame.key;
        }
    }
    return path;
}

/**
 * Build a JSON path for debugging/display purposes
 */
function buildJsonPath(json: string, position: number, immediateKey: string): string {
    return jsonPathAt(json, position) || immediateKey;
}

/**
 * Result of parsing variable content
 */
interface ParsedVariableContent {
    name?: string;
    dataType?: DataType;
    hasExplicitType?: boolean;
    isInferred?: boolean;
    isA8Variable?: boolean;
    /** GitHub Issue #165: Whether this is an ENV variable */
    isEnvVariable?: boolean;
    /** GitHub Issue #165: ENV variable name (without ENV: prefix) */
    envVariableName?: string;
    /** GitHub Issue #162: Format modifier for date/datetime types */
    formatModifier?: string;
    error?: string;
    errorType?: TemplateValidationError['type'];
}

/**
 * GitHub Issue #175: Parse type, format, and modifiers from the suffix after variable name
 *
 * Syntax:
 * - "type" - type only (e.g., "string", "number", "date")
 * - "type:format" - type + format (dates only, e.g., "date:iso")
 * - "type|modifier" - type + modifier (e.g., "string|upper", "number|>0")
 * - "type:format|modifier" - type + format + modifier (dates only, e.g., "date:iso|+2d")
 *
 * @param suffix - Everything after the variable name's colon (e.g., "string|3-50|upper")
 * @returns Parsed type, format modifier string, and any error
 */
function parseTypeFormatModifier(suffix: string): {
    dataType: DataType;
    formatModifier?: string;
    parseError?: string;
} {
    // Check for pipe (modifier separator)
    const pipeIndex = suffix.indexOf('|');

    if (pipeIndex === -1) {
        // No pipe - could be "type" or "type:format"
        const colonIndex = suffix.indexOf(':');

        if (colonIndex === -1) {
            // Just "type"
            const typeStr = suffix.toLowerCase();
            if (!VALID_DATA_TYPES.includes(typeStr as DataType)) {
                return {
                    dataType: 'string',
                    parseError: `Unknown type '${suffix}'. Valid types: ${VALID_DATA_TYPES.join(', ')}`
                };
            }
            return { dataType: typeStr as DataType };
        }

        // "type:format" - format is only valid for date/datetime
        const typeStr = suffix.substring(0, colonIndex).toLowerCase();
        const format = suffix.substring(colonIndex + 1);

        if (!VALID_DATA_TYPES.includes(typeStr as DataType)) {
            return {
                dataType: 'string',
                parseError: `Unknown type '${typeStr}'. Valid types: ${VALID_DATA_TYPES.join(', ')}`
            };
        }

        // Only date/datetime types can have format after colon
        if (typeStr === 'date' || typeStr === 'datetime') {
            return {
                dataType: typeStr as DataType,
                formatModifier: format && format.length > 0 ? format : undefined
            };
        }

        // For string/number/boolean, colon after type is still supported for backward compatibility
        // but the preferred syntax is pipe
        return {
            dataType: typeStr as DataType,
            formatModifier: format && format.length > 0 ? format : undefined
        };
    }

    // Has pipe - split into type part and modifier part
    const beforePipe = suffix.substring(0, pipeIndex);
    const afterPipe = suffix.substring(pipeIndex + 1);

    // beforePipe could be "type" or "type:format"
    const colonIndex = beforePipe.indexOf(':');

    if (colonIndex === -1) {
        // "type|modifier"
        const typeStr = beforePipe.toLowerCase();
        if (!VALID_DATA_TYPES.includes(typeStr as DataType)) {
            return {
                dataType: 'string',
                parseError: `Unknown type '${beforePipe}'. Valid types: ${VALID_DATA_TYPES.join(', ')}`
            };
        }
        return {
            dataType: typeStr as DataType,
            formatModifier: afterPipe && afterPipe.length > 0 ? afterPipe : undefined
        };
    }

    // "type:format|modifier"
    const typeStr = beforePipe.substring(0, colonIndex).toLowerCase();
    const format = beforePipe.substring(colonIndex + 1);

    if (!VALID_DATA_TYPES.includes(typeStr as DataType)) {
        return {
            dataType: 'string',
            parseError: `Unknown type '${typeStr}'. Valid types: ${VALID_DATA_TYPES.join(', ')}`
        };
    }

    // Combine format and modifier with pipe
    const combined = format && format.length > 0
        ? `${format}|${afterPipe}`
        : afterPipe;

    return {
        dataType: typeStr as DataType,
        formatModifier: combined && combined.length > 0 ? combined : undefined
    };
}

/**
 * Parse the content inside {{...}}
 *
 * Formats:
 *   ""           → infer name from key, type = string
 *   ":number"    → infer name from key, type = number
 *   "Name"       → explicit name, type = string
 *   "Name:type"  → explicit name, explicit type
 *   "A8:seq"     → A8 system variable
 */
function parseVariableContent(content: string, keyContext: KeyContext): ParsedVariableContent {
    // Empty content: {{}} - infer from key
    if (content === '') {
        if (!keyContext.key) {
            return {
                error: "Empty variable `{{}}` can only be used in JSON body templates where key context exists",
                errorType: 'NO_KEY_CONTEXT'
            };
        }
        return {
            name: keyContext.key,
            dataType: 'string',
            hasExplicitType: false,
            isInferred: true,
            isA8Variable: false,
            isEnvVariable: false
        };
    }

    // Starts with colon: {{:type}} or {{:type:format}} or {{:type|modifier}} - infer name, explicit type
    if (content.startsWith(':')) {
        if (!keyContext.key) {
            return {
                error: "Empty variable `{{:type}}` can only be used in JSON body templates where key context exists",
                errorType: 'NO_KEY_CONTEXT'
            };
        }

        const afterColon = content.substring(1).trim();

        // GitHub Issue #175: Parse type, format (colon), and modifiers (pipe)
        // Syntax: {{:type}}, {{:type:format}}, {{:type|modifier}}, {{:type:format|modifier}}
        const { dataType, formatModifier, parseError } = parseTypeFormatModifier(afterColon);

        if (parseError) {
            return {
                error: parseError,
                errorType: 'INVALID_TYPE'
            };
        }

        return {
            name: keyContext.key,
            dataType: dataType as DataType,
            hasExplicitType: true,
            isInferred: true,
            isA8Variable: false,
            isEnvVariable: false,
            formatModifier: formatModifier
        };
    }

    // A pipe before any colon: {{Name | modifiers}}, a text value with modifiers (James, 2026-11-23:
    // {{uom | lu:uom:tms>wms}}), as {{Name:string|modifiers}}
    const pipeAt = content.indexOf('|');
    const colonAt = content.indexOf(':');
    if (pipeAt > 0 && (colonAt === -1 || pipeAt < colonAt)) {
        const name = content.substring(0, pipeAt).trim();
        const { dataType, formatModifier, parseError } = parseTypeFormatModifier('string|' + content.substring(pipeAt + 1).trim());
        if (parseError) return { error: parseError, errorType: 'INVALID_TYPE' };
        return {
            name,
            dataType: dataType as DataType,
            hasExplicitType: false,
            isInferred: false,
            isA8Variable: false,
            isEnvVariable: false,
            formatModifier
        };
    }

    // Check for colon (could be A8 variable or typed variable)
    const colonIndex = content.indexOf(':');

    if (colonIndex === -1) {
        // No colon: {{Name}} - explicit name, default type
        return {
            name: content.trim(),
            dataType: 'string',
            hasExplicitType: false,
            isInferred: false,
            isA8Variable: false,
            isEnvVariable: false
        };
    }

    const prefix = content.substring(0, colonIndex).trim();
    const suffix = content.substring(colonIndex + 1).trim();

    // Check for A8 variable
    if (prefix.toUpperCase() === 'A8') {
        // GitHub Issue #140: Support format specifiers like datetime:iso or datetime:YYYY-MM-DD
        // GitHub Issue #175: Support modifiers with pipe syntax like date|+30d
        // Extract base type (first part before : or |) for validation
        // suffix could be: "date", "date:iso", "date|+30d", "datetime:iso|+2d"

        // First check for pipe (modifier separator) - take part before pipe as type/format
        const pipeIndex = suffix.indexOf('|');
        const beforePipe = pipeIndex === -1 ? suffix : suffix.substring(0, pipeIndex);

        // Now split by colon to get type and optional format
        const a8Parts = beforePipe.split(':');
        const baseType = a8Parts[0].toLowerCase();

        if (!VALID_A8_TYPES.includes(baseType)) {
            return {
                error: `Unknown A8 variable type '${baseType}'. Valid types: ${VALID_A8_TYPES.join(', ')}`,
                errorType: 'INVALID_TYPE'
            };
        }

        return {
            name: `A8:${suffix}`, // Keep full suffix including format specifier and modifiers
            dataType: getA8DataType(baseType),
            hasExplicitType: true,
            isInferred: false,
            isA8Variable: true,
            isEnvVariable: false
        };
    }

    // GitHub Issue #165: Check for ENV variable
    if (prefix.toUpperCase() === 'ENV') {
        if (!suffix || suffix.trim() === '') {
            return {
                error: "ENV variable requires a variable name, e.g., {{ENV:host}}",
                errorType: 'INVALID_TYPE'
            };
        }

        return {
            name: `ENV:${suffix}`, // Keep full pattern for reference
            dataType: 'string', // ENV variables are always strings
            hasExplicitType: false,
            isInferred: false,
            isA8Variable: false,
            isEnvVariable: true,
            envVariableName: suffix.trim() // Store the actual variable name
        };
    }

    // GitHub Issue #175: Use unified parsing for type, format, and modifiers
    // Syntax: {{Name:type}}, {{Name:type:format}}, {{Name:type|modifier}}, {{Name:type:format|modifier}}
    const { dataType, formatModifier, parseError } = parseTypeFormatModifier(suffix);

    if (parseError) {
        return {
            error: parseError,
            errorType: 'INVALID_TYPE'
        };
    }

    return {
        name: prefix,
        dataType: dataType as DataType,
        hasExplicitType: true,
        isInferred: false,
        isA8Variable: false,
        isEnvVariable: false,
        formatModifier: formatModifier
    };
}

/**
 * Get the data type for an A8 variable
 */
function getA8DataType(a8Type: string): DataType {
    switch (a8Type) {
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
 * Validates that a template doesn't have empty variables in invalid contexts
 *
 * Call this for URL, query params, and headers to ensure {{}} isn't used there.
 */
export function validateNonJsonTemplate(template: string, contextName: string): TemplateValidationError[] {
    const errors: TemplateValidationError[] = [];
    const emptyVarRegex = /\{\{(\s*|\s*:[^}]*)\}\}/g;
    let match;

    while ((match = emptyVarRegex.exec(template)) !== null) {
        const content = match[1].trim();

        // Empty or starts with colon (type-only)
        if (content === '' || content.startsWith(':')) {
            errors.push({
                type: 'EMPTY_VARIABLE_OUTSIDE_JSON',
                message: `Empty variable \`${match[0]}\` can only be used in JSON body templates. ${contextName} requires explicit variable names.`,
                position: { start: match.index, end: match.index + match[0].length },
                pattern: match[0]
            });
        }
    }

    return errors;
}

/**
 * Resolve variables from a JSON template, replacing shorthand with full names
 *
 * This is used at runtime to get the final variable names for CSV mapping
 * and value substitution.
 */
export function resolveTemplateVariables(jsonTemplate: string): Map<string, InferredVariable> {
    const result = extractVariablesFromJsonTemplate(jsonTemplate);
    const resolved = new Map<string, InferredVariable>();

    for (const variable of result.variables) {
        if (!variable.isA8Variable) {
            resolved.set(variable.resolvedName, variable);
        }
    }

    return resolved;
}
