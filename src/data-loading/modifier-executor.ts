// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Modifier Executor for GitHub Issue #175
 *
 * Applies modifiers to values - both transformations and validations.
 *
 * Execution Order:
 * 1. Pre-transform - Apply transforms on raw string (trim, upper, lower)
 * 2. Type conversion - Convert string to target type (number, date, etc.)
 * 3. Post-transform - Apply type-specific transforms (rnd(2), +2d, floor, ceil)
 * 4. Validate - Apply validation modifiers (>0, 3-50, int)
 */

import { DataType } from './types';
import {
    Modifier,
    ParsedModifiers,
    ModifierResult,
    StringModifier,
    NumberModifier,
    DateMathModifier,
    DateMathUnit
} from './modifier-types';
import { applyLookup } from './template-lookups';

/**
 * Apply all modifiers to a value
 *
 * @param value - The raw string value from CSV
 * @param dataType - The target data type
 * @param modifiers - Parsed modifiers to apply
 * @returns Result with transformed value or error
 */
export function applyModifiers(
    value: string,
    dataType: DataType,
    modifiers: ParsedModifiers
): ModifierResult {
    try {
        // Phase 1: Pre-transform (on raw string)
        let processedValue: string = value;

        // Apply trim by default (unless noTrim)
        if (modifiers.applyTrim) {
            processedValue = processedValue.trim();
        }

        // Check for empty value and apply empty behavior
        const isEmpty = processedValue === '' || processedValue === undefined || processedValue === null;
        if (isEmpty) {
            switch (modifiers.emptyBehavior) {
                case 'opt':
                    // Signal that this key should be omitted entirely
                    return { success: true, value: undefined, omitKey: true };
                case 'null':
                    // Return null value (not undefined, actual null)
                    return { success: true, value: null };
                case 'default':
                    // Continue with normal processing - will result in "" or 0 or error
                    break;
            }
        }

        // Apply string transforms (upper, lower), and lookups (`lu`), in the order written
        for (const mod of modifiers.modifiers) {
            if (mod.kind === 'string') {
                if (mod.type === 'upper') {
                    processedValue = processedValue.toUpperCase();
                } else if (mod.type === 'lower') {
                    processedValue = processedValue.toLowerCase();
                }
            } else if (mod.kind === 'lookup') {
                const looked = applyLookup(processedValue, mod);
                if (!looked.success) return looked;
                processedValue = String(looked.value);
            }
        }

        // Phase 2: Type conversion
        let typedValue: unknown;
        const conversionResult = convertToType(processedValue, dataType);
        if (!conversionResult.success) {
            return conversionResult;
        }
        typedValue = conversionResult.value;

        // Phase 3: Post-transform (type-specific)
        for (const mod of modifiers.modifiers) {
            if (mod.kind === 'number') {
                const result = applyNumberTransform(typedValue as number, mod);
                if (!result.success) {
                    return result;
                }
                typedValue = result.value;
            } else if (mod.kind === 'dateMath') {
                const result = applyDateMath(typedValue as Date, mod);
                if (!result.success) {
                    return result;
                }
                typedValue = result.value;
            }
        }

        // Phase 4: Validate
        for (const mod of modifiers.modifiers) {
            const validationResult = validateWithModifier(typedValue, mod, dataType);
            if (!validationResult.success) {
                return validationResult;
            }
        }

        return { success: true, value: typedValue };
    } catch (error) {
        return {
            success: false,
            error: `Modifier execution error: ${error}`
        };
    }
}

/**
 * Convert a string value to the target type
 */
function convertToType(value: string, dataType: DataType): ModifierResult {
    switch (dataType) {
        case 'string':
            return { success: true, value };

        case 'number':
            const num = Number(value);
            if (isNaN(num)) {
                return {
                    success: false,
                    error: `Invalid number: '${value}'`
                };
            }
            return { success: true, value: num };

        case 'boolean':
            const lowerValue = value.toLowerCase();
            if (['true', 'yes', 'y', '1', 'on'].includes(lowerValue)) {
                return { success: true, value: true };
            }
            if (['false', 'no', 'n', '0', 'off'].includes(lowerValue)) {
                return { success: true, value: false };
            }
            return {
                success: false,
                error: `Invalid boolean: '${value}'`
            };

        case 'date':
        case 'datetime':
            const date = new Date(value);
            if (isNaN(date.getTime())) {
                return {
                    success: false,
                    error: `Invalid date: '${value}'`
                };
            }
            return { success: true, value: date };

        default:
            return { success: true, value };
    }
}

/**
 * Apply number transform modifiers (rnd, floor, ceil)
 */
function applyNumberTransform(value: number, mod: NumberModifier): ModifierResult {
    switch (mod.type) {
        case 'round':
            if (mod.decimals !== undefined) {
                const factor = Math.pow(10, mod.decimals);
                return { success: true, value: Math.round(value * factor) / factor };
            }
            return { success: true, value: Math.round(value) };

        case 'floor':
            return { success: true, value: Math.floor(value) };

        case 'ceil':
            return { success: true, value: Math.ceil(value) };

        default:
            // Not a transform modifier, just pass through
            return { success: true, value };
    }
}

/**
 * Apply date math modifiers (+2d, -1w, +2M, +1y, +4h, +30m)
 */
function applyDateMath(date: Date, mod: DateMathModifier): ModifierResult {
    const result = new Date(date.getTime());

    switch (mod.unit) {
        case 'd': // days
            result.setUTCDate(result.getUTCDate() + mod.amount);
            break;
        case 'w': // weeks (7 days)
            result.setUTCDate(result.getUTCDate() + (mod.amount * 7));
            break;
        case 'M': // months
            result.setUTCMonth(result.getUTCMonth() + mod.amount);
            break;
        case 'y': // years
            result.setUTCFullYear(result.getUTCFullYear() + mod.amount);
            break;
        case 'h': // hours
            result.setUTCHours(result.getUTCHours() + mod.amount);
            break;
        case 'm': // minutes
            result.setUTCMinutes(result.getUTCMinutes() + mod.amount);
            break;
    }

    return { success: true, value: result };
}

/**
 * GitHub Issue #175: Apply date math modifier string to a Date
 * Exported utility for use by template-parser.ts for A8 variables
 *
 * @param date - The base date to modify
 * @param modifierString - The modifier string (e.g., "+4h", "-2d", "+1w")
 * @returns Modified date (returns original if modifier is invalid)
 */
export function applyDateMathToDate(date: Date, modifierString: string): Date {
    // Parse modifier string: "+4h", "-2d", "+1w", "+2M", "+1y", "+30m"
    // Case-sensitive: M = months, m = minutes
    const match = modifierString.match(/^([+-])(\d+)([dwMyhm])$/);
    if (!match) {
        return date;
    }

    const sign = match[1] === '+' ? 1 : -1;
    const amount = parseInt(match[2], 10) * sign;
    const unit = match[3] as DateMathUnit;

    const mod: DateMathModifier = {
        type: 'dateMath',
        amount,
        unit
    };

    const result = applyDateMath(date, mod);
    return result.success ? result.value as Date : date;
}

/**
 * Validate a value against a modifier
 */
function validateWithModifier(
    value: unknown,
    mod: Modifier,
    dataType: DataType
): ModifierResult {
    if (mod.kind === 'string') {
        return validateString(value as string, mod);
    }

    if (mod.kind === 'number') {
        return validateNumber(value as number, mod);
    }

    // dateMath modifiers are transforms, not validations
    return { success: true, value };
}

/**
 * Validate string against string modifiers
 */
function validateString(value: string, mod: StringModifier): ModifierResult {
    const length = value.length;

    switch (mod.type) {
        case 'exactLength':
            if (mod.length !== undefined && length !== mod.length) {
                return {
                    success: false,
                    error: `must be exactly ${mod.length} characters (got ${length})`
                };
            }
            break;

        case 'minLength':
            if (mod.min !== undefined && length < mod.min) {
                return {
                    success: false,
                    error: `minimum length is ${mod.min} characters (got ${length})`
                };
            }
            break;

        case 'maxLength':
            if (mod.max !== undefined && length > mod.max) {
                return {
                    success: false,
                    error: `maximum length is ${mod.max} characters (got ${length})`
                };
            }
            break;

        case 'lengthRange':
            if (mod.min !== undefined && length < mod.min) {
                return {
                    success: false,
                    error: `minimum length is ${mod.min} characters (got ${length})`
                };
            }
            if (mod.max !== undefined && length > mod.max) {
                return {
                    success: false,
                    error: `maximum length is ${mod.max} characters (got ${length})`
                };
            }
            break;

        // trim, noTrim, upper, lower are transforms, not validations
        default:
            break;
    }

    return { success: true, value };
}

/**
 * Validate number against number modifiers
 */
function validateNumber(value: number, mod: NumberModifier): ModifierResult {
    switch (mod.type) {
        case 'greaterThan':
            if (mod.value !== undefined && value <= mod.value) {
                return {
                    success: false,
                    error: `must be greater than ${mod.value}`
                };
            }
            break;

        case 'greaterOrEqual':
            if (mod.value !== undefined && value < mod.value) {
                return {
                    success: false,
                    error: `must be greater than or equal to ${mod.value}`
                };
            }
            break;

        case 'lessThan':
            if (mod.value !== undefined && value >= mod.value) {
                return {
                    success: false,
                    error: `must be less than ${mod.value}`
                };
            }
            break;

        case 'lessOrEqual':
            if (mod.value !== undefined && value > mod.value) {
                return {
                    success: false,
                    error: `must be less than or equal to ${mod.value}`
                };
            }
            break;

        case 'integer':
            if (!Number.isInteger(value)) {
                return {
                    success: false,
                    error: `must be an integer`
                };
            }
            break;

        // round, floor, ceil are transforms, not validations
        default:
            break;
    }

    return { success: true, value };
}

/**
 * Apply modifiers and return the final formatted value for JSON output
 *
 * This is a convenience function that combines modifier application with
 * final formatting for JSON template substitution.
 *
 * @param value - Raw string value from CSV
 * @param dataType - Target data type
 * @param modifiers - Parsed modifiers
 * @param formatModifier - Optional format modifier for date/datetime
 * @returns Result with final value ready for JSON substitution
 */
export function applyModifiersAndFormat(
    value: string,
    dataType: DataType,
    modifiers: ParsedModifiers,
    formatModifier?: string
): ModifierResult {
    // First apply all modifiers
    const result = applyModifiers(value, dataType, modifiers);
    if (!result.success) {
        return result;
    }

    // For date/datetime, apply format if specified
    if ((dataType === 'date' || dataType === 'datetime') && result.value instanceof Date) {
        const formatted = formatDateValue(result.value, dataType, formatModifier);
        return { success: true, value: formatted };
    }

    return result;
}

/**
 * Format a date value according to data type and format modifier
 */
function formatDateValue(date: Date, dataType: DataType, formatModifier?: string): string {
    if (dataType === 'date') {
        if (!formatModifier) {
            // Default: YYYYMMDD
            return date.getUTCFullYear().toString() +
                   (date.getUTCMonth() + 1).toString().padStart(2, '0') +
                   date.getUTCDate().toString().padStart(2, '0');
        }
        if (formatModifier.toLowerCase() === 'iso') {
            return date.toISOString().split('T')[0];
        }
        return applyFormatString(date, formatModifier);
    }

    if (dataType === 'datetime') {
        if (!formatModifier) {
            // Default: Local format without ms and Z
            return date.toISOString().replace(/\.\d{3}Z$/, '');
        }

        const modifierLower = formatModifier.toLowerCase();
        switch (modifierLower) {
            case 'iso':
                return date.toISOString();
            case 'date':
                return date.toISOString().split('T')[0];
            case 'time':
                return date.toISOString().split('T')[1].replace(/\.\d{3}Z$/, '');
            case 'local':
                return date.toISOString().replace(/\.\d{3}Z$/, '');
            default:
                return applyFormatString(date, formatModifier);
        }
    }

    return date.toISOString();
}

/**
 * Apply custom format string to date
 */
function applyFormatString(date: Date, format: string): string {
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
    // Replace longest tokens first to avoid partial matches
    const sortedTokens = Object.entries(tokens).sort((a, b) => b[0].length - a[0].length);
    for (const [token, value] of sortedTokens) {
        result = result.split(token).join(value);
    }
    return result;
}

/**
 * Check if modifiers contain any validation modifiers
 *
 * This is useful to determine if we need to run the batch validation gate.
 */
export function hasValidationModifiers(modifiers: ParsedModifiers): boolean {
    for (const mod of modifiers.modifiers) {
        // (a lookup fails a value that isn't in its table)
        if (mod.kind === 'lookup') return true;
        if (mod.kind === 'string') {
            if (['exactLength', 'minLength', 'maxLength', 'lengthRange'].includes(mod.type)) {
                return true;
            }
        }
        if (mod.kind === 'number') {
            if (['greaterThan', 'greaterOrEqual', 'lessThan', 'lessOrEqual', 'integer'].includes(mod.type)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Check if modifiers contain any transform modifiers
 */
export function hasTransformModifiers(modifiers: ParsedModifiers): boolean {
    if (!modifiers.applyTrim) {
        // noTrim is a transform (opt-out of default trim)
        return true;
    }

    for (const mod of modifiers.modifiers) {
        if (mod.kind === 'string') {
            if (['upper', 'lower'].includes(mod.type)) {
                return true;
            }
        }
        if (mod.kind === 'number') {
            if (['round', 'floor', 'ceil'].includes(mod.type)) {
                return true;
            }
        }
        if (mod.kind === 'dateMath' || mod.kind === 'lookup') {
            return true;
        }
    }
    return false;
}
