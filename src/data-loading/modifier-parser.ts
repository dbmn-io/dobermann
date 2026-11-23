// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Modifier Parser for GitHub Issue #175
 *
 * Parses modifier strings from template variables into structured modifier objects.
 *
 * SYNTAX:
 * - Colon (:) after type = FORMAT (dates only)
 * - Pipe (|) after type or format = MODIFIER
 *
 * Template Format:
 *   {{VAR:type|modifier1|modifier2}}        → Type + modifiers
 *   {{VAR:type:format|modifier1|modifier2}} → Type + format + modifiers (dates)
 *
 * The modifier portion uses pipe-delimited chains:
 *   "3-50"          → length range 3-50 chars
 *   "3-"            → min length 3 chars
 *   "-50"           → max length 50 chars
 *   ">0|rnd(2)"     → greater than 0, round to 2 decimals
 *   "upper|3-50"    → uppercase, then validate 3-50 chars
 *   "+2d"           → add 2 days (date math)
 *
 * For dates with both format and modifier:
 *   formatModifier = "iso|+2d" → format=iso, modifier=+2d
 */

import { DataType } from './types';
import {
    Modifier,
    ParsedModifiers,
    StringModifier,
    NumberModifier,
    DateMathModifier,
    DateMathUnit,
    EmptyValueBehavior,
    MODIFIER_TYPE_COMPATIBILITY
} from './modifier-types';

/**
 * Parse a modifier string into structured modifier objects
 *
 * @param modifierString - The modifier portion after the type (e.g., "3-50|upper")
 * @param dataType - The data type of the variable
 * @returns Parsed modifiers with any errors
 */
export function parseModifiers(modifierString: string, dataType: DataType): ParsedModifiers {
    const result: ParsedModifiers = {
        raw: modifierString,
        modifiers: [],
        applyTrim: true, // Default: apply trim
        emptyBehavior: 'default', // Default: normal empty handling
        outputAsString: false, // Default: use type's native JSON output
        errors: []
    };

    if (!modifierString || modifierString.trim() === '') {
        return result;
    }

    // Split by pipe to get individual modifiers
    const modifierParts = modifierString.split('|').map(s => s.trim()).filter(s => s.length > 0);

    for (const part of modifierParts) {
        const partLower = part.toLowerCase();

        // Handle empty value behavior modifiers (work with all types)
        if (partLower === 'opt') {
            result.emptyBehavior = 'opt';
            continue;
        }
        if (partLower === 'null') {
            result.emptyBehavior = 'null';
            continue;
        }
        // Handle output format directive (work with all types)
        if (partLower === 'asstring') {
            result.outputAsString = true;
            continue;
        }

        // `ifblank:text`: what a blank becomes (any type; quotes around the text are taken off)
        if (partLower.startsWith('ifblank:')) {
            result.ifBlank = part.slice('ifblank:'.length).trim().replace(/^(['"])(.*)\1$/, '$2');
            continue;
        }

        // `list:table[:column]` / `lookup:table:from>to`: the list and lookup types' spec, as the
        // template readers give it (json-template-parser: {{uom:list|uom:wms}} → list:uom:wms)
        if (partLower.startsWith('list:') || partLower.startsWith('lookup:')) {
            const lookup = parseLookupModifier(part);
            if (typeof lookup === 'string') result.errors.push(lookup);
            else result.modifiers.push(lookup);
            continue;
        }
        // (`lu` was never released: said what it is now, never quietly ignored)
        if (partLower.startsWith('lu:')) {
            result.errors.push(LU_REPLACED);
            continue;
        }

        const parsed = parseSingleModifier(part, dataType);

        if (parsed.error) {
            result.errors.push(parsed.error);
        } else if (parsed.modifier) {
            // Check for noTrim
            if (parsed.modifier.kind === 'string' && parsed.modifier.type === 'noTrim') {
                result.applyTrim = false;
            }
            result.modifiers.push(parsed.modifier);
        }
    }

    return result;
}

/** What `lu` is now (it was never in a release). */
export const LU_REPLACED = 'lu is now a type: {{name:list|table:column}} checks a value is in a column, {{name:lookup|table:from>to}} sends another';

/**
 * `list:table[:column]` or `lookup:table:from>to` as a lookup modifier, or what is wrong with it.
 * A list names the column the value must be in (a table of one column needs none); a lookup names
 * the column it's found in and the one sent.
 */
export function parseLookupModifier(token: string): Modifier | string {
    const parts = token.split(':').map(p => p.trim());
    const kind = parts[0].toLowerCase();
    const table = parts[1] || '';
    const columns = parts.slice(2).join(':');
    const [from, to, ...more] = columns.split('>').map(c => c.trim());
    if (kind === 'lookup') {
        if (!table || !from || !to || more.length) return `lookup needs a table and two columns: {{name:lookup|table:from>to}}`;
        return { kind: 'lookup', type: 'lookup', table, from, to };
    }
    if (!table || to !== undefined || more.length) return `list needs a table, and the column if it has more than one: {{name:list|table:column}}`;
    return { kind: 'lookup', type: 'lookup', table, from: from || '' };
}

/**
 * Parse a single modifier token
 */
function parseSingleModifier(
    token: string,
    dataType: DataType
): { modifier?: Modifier; error?: string } {
    const tokenLower = token.toLowerCase();

    // =========================================================================
    // String Modifiers
    // =========================================================================
    if (dataType === 'string') {
        // noTrim
        if (tokenLower === 'notrim') {
            return { modifier: { kind: 'string', type: 'noTrim' } };
        }

        // upper
        if (tokenLower === 'upper') {
            return { modifier: { kind: 'string', type: 'upper' } };
        }

        // lower
        if (tokenLower === 'lower') {
            return { modifier: { kind: 'string', type: 'lower' } };
        }

        // Exact length: just a number (e.g., "3" means exactly 3 characters)
        const exactLengthMatch = token.match(/^(\d+)$/);
        if (exactLengthMatch) {
            const len = parseInt(exactLengthMatch[1], 10);
            return {
                modifier: {
                    kind: 'string',
                    type: 'exactLength',
                    length: len
                }
            };
        }

        // Length constraints: n- (min), -n (max), n-m (range)
        const lengthMatch = token.match(/^(\d+)?-(\d+)?$/);
        if (lengthMatch) {
            const minStr = lengthMatch[1];
            const maxStr = lengthMatch[2];

            const min = minStr ? parseInt(minStr, 10) : undefined;
            const max = maxStr ? parseInt(maxStr, 10) : undefined;

            // Validate the range
            if (min !== undefined && max !== undefined) {
                if (min > max) {
                    return { error: `Invalid length range: min (${min}) cannot be greater than max (${max})` };
                }
                return {
                    modifier: {
                        kind: 'string',
                        type: 'lengthRange',
                        min,
                        max
                    }
                };
            } else if (min !== undefined) {
                return {
                    modifier: {
                        kind: 'string',
                        type: 'minLength',
                        min
                    }
                };
            } else if (max !== undefined) {
                return {
                    modifier: {
                        kind: 'string',
                        type: 'maxLength',
                        max
                    }
                };
            }
        }

        return { error: `Unknown string modifier: ${token}` };
    }

    // =========================================================================
    // Number Modifiers
    // =========================================================================
    if (dataType === 'number') {
        // int - integer validation
        if (tokenLower === 'int') {
            return { modifier: { kind: 'number', type: 'integer' } };
        }

        // floor
        if (tokenLower === 'floor') {
            return { modifier: { kind: 'number', type: 'floor' } };
        }

        // ceil
        if (tokenLower === 'ceil') {
            return { modifier: { kind: 'number', type: 'ceil' } };
        }

        // rnd(n) - round to n decimals
        const rndMatch = token.match(/^rnd\((\d+)\)$/i);
        if (rndMatch) {
            const decimals = parseInt(rndMatch[1], 10);
            if (decimals < 0 || decimals > 15) {
                return { error: `Round decimals must be between 0 and 15, got: ${decimals}` };
            }
            return {
                modifier: {
                    kind: 'number',
                    type: 'round',
                    decimals
                }
            };
        }

        // >= (greater or equal)
        const geMatch = token.match(/^>=(-?\d+(?:\.\d+)?)$/);
        if (geMatch) {
            return {
                modifier: {
                    kind: 'number',
                    type: 'greaterOrEqual',
                    value: parseFloat(geMatch[1])
                }
            };
        }

        // > (greater than)
        const gtMatch = token.match(/^>(-?\d+(?:\.\d+)?)$/);
        if (gtMatch) {
            return {
                modifier: {
                    kind: 'number',
                    type: 'greaterThan',
                    value: parseFloat(gtMatch[1])
                }
            };
        }

        // <= (less or equal)
        const leMatch = token.match(/^<=(-?\d+(?:\.\d+)?)$/);
        if (leMatch) {
            return {
                modifier: {
                    kind: 'number',
                    type: 'lessOrEqual',
                    value: parseFloat(leMatch[1])
                }
            };
        }

        // < (less than)
        const ltMatch = token.match(/^<(-?\d+(?:\.\d+)?)$/);
        if (ltMatch) {
            return {
                modifier: {
                    kind: 'number',
                    type: 'lessThan',
                    value: parseFloat(ltMatch[1])
                }
            };
        }

        return { error: `Unknown number modifier: ${token}` };
    }

    // =========================================================================
    // Date/Datetime Modifiers
    // =========================================================================
    if (dataType === 'date' || dataType === 'datetime') {
        // Date math: +2d, -1d, +1w, +2M, +1y, +4h, +30m
        // Units: d=days, w=weeks, M=months (capital), y=years, h=hours, m=minutes (lowercase)
        const dateMathMatch = token.match(/^([+-])(\d+)([dwMyhm])$/i);
        if (dateMathMatch) {
            const sign = dateMathMatch[1] === '+' ? 1 : -1;
            const amount = parseInt(dateMathMatch[2], 10) * sign;
            // Preserve M (months) vs m (minutes) distinction, normalize others to lowercase
            const rawUnit = dateMathMatch[3];
            const unit = (rawUnit === 'M' ? 'M' : rawUnit.toLowerCase()) as DateMathUnit;

            return {
                modifier: {
                    kind: 'dateMath',
                    type: 'dateMath',
                    amount,
                    unit
                }
            };
        }

        // For date/datetime, other tokens are treated as format modifiers
        // and handled by the existing formatModifier system
        // We don't parse them here - they get passed through
        return { error: `Unknown date modifier: ${token}. Use +2d, -1w, +2M, +1y, +4h, +30m for date math.` };
    }

    // =========================================================================
    // Boolean - No modifiers supported
    // =========================================================================
    if (dataType === 'boolean') {
        return { error: `Boolean type does not support modifiers: ${token}` };
    }

    return { error: `Unknown modifier for type ${dataType}: ${token}` };
}

/**
 * Extract modifiers from a format modifier string
 *
 * The existing formatModifier in InferredVariable can contain both:
 * - Traditional format strings (iso, YYYY-MM-DD, etc.)
 * - New modifiers (+2d, 3-50, >0, etc.)
 *
 * This function separates them so we can handle both.
 *
 * @param formatModifier - The format modifier string from existing parser
 * @param dataType - The data type of the variable
 * @returns Object with separated format and modifiers
 */
export function extractModifiersFromFormat(
    formatModifier: string | undefined,
    dataType: DataType
): { formatOnly?: string; modifiers: ParsedModifiers } {
    if (!formatModifier || formatModifier.trim() === '') {
        return {
            modifiers: {
                raw: '',
                modifiers: [],
                applyTrim: true,
                emptyBehavior: 'default',
                outputAsString: false,
                errors: []
            }
        };
    }

    // Split by pipe
    const parts = formatModifier.split('|').map(s => s.trim()).filter(s => s.length > 0);

    // Separate format parts from modifier parts
    const formatParts: string[] = [];
    const modifierParts: string[] = [];

    for (const part of parts) {
        if (isModifierToken(part, dataType)) {
            modifierParts.push(part);
        } else {
            formatParts.push(part);
        }
    }

    // Parse the modifier parts
    const modifierString = modifierParts.join('|');
    const parsedModifiers = parseModifiers(modifierString, dataType);

    // Reconstruct format string (if any format parts remain)
    const formatOnly = formatParts.length > 0 ? formatParts.join('|') : undefined;

    return {
        formatOnly,
        modifiers: parsedModifiers
    };
}

/**
 * Check if a token is a modifier (vs a format string)
 */
function isModifierToken(token: string, dataType: DataType): boolean {
    const tokenLower = token.toLowerCase();

    // Empty value behavior modifiers (work with all types)
    if (tokenLower === 'opt' || tokenLower === 'null') {
        return true;
    }
    // Output format directive (work with all types)
    if (tokenLower === 'asstring') {
        return true;
    }
    // A list or lookup's spec, `lu` (to be said what it is now), and what a blank becomes (all types)
    if (tokenLower.startsWith('list:') || tokenLower.startsWith('lookup:') || tokenLower.startsWith('lu:') || tokenLower.startsWith('ifblank:')) {
        return true;
    }

    // String modifiers
    if (dataType === 'string') {
        if (tokenLower === 'notrim' || tokenLower === 'upper' || tokenLower === 'lower') {
            return true;
        }
        // Exact length (just a number)
        if (/^\d+$/.test(token)) {
            return true;
        }
        // Length constraints
        if (/^\d+-$/.test(token) || /^-\d+$/.test(token) || /^\d+-\d+$/.test(token)) {
            return true;
        }
    }

    // Number modifiers
    if (dataType === 'number') {
        if (tokenLower === 'int' || tokenLower === 'floor' || tokenLower === 'ceil') {
            return true;
        }
        if (/^rnd\(\d+\)$/i.test(token)) {
            return true;
        }
        if (/^[><]=?-?\d+/.test(token)) {
            return true;
        }
    }

    // Date math modifiers
    if (dataType === 'date' || dataType === 'datetime') {
        // Match d=days, w=weeks, M=months, y=years, h=hours, m=minutes
        if (/^[+-]\d+[dwMyhm]$/.test(token)) {
            return true;
        }
    }

    return false;
}

/**
 * Validate that modifiers are compatible with the data type
 *
 * @param modifiers - Parsed modifiers to validate
 * @param dataType - The data type to check against
 * @returns Array of error messages (empty if valid)
 */
export function validateModifierCompatibility(
    modifiers: ParsedModifiers,
    dataType: DataType
): string[] {
    const errors: string[] = [];
    const allowedTypes = MODIFIER_TYPE_COMPATIBILITY[dataType];

    for (const modifier of modifiers.modifiers) {
        // (a lookup goes with any type: the value is looked up as text)
        if (modifier.kind === 'lookup') continue;
        const modifierType = modifier.kind === 'dateMath' ? 'dateMath' : modifier.type;
        if (!allowedTypes.includes(modifierType)) {
            errors.push(`Modifier '${modifierType}' is not valid for type '${dataType}'`);
        }
    }

    return errors;
}

/**
 * Serialize modifiers back to string format
 *
 * Useful for debugging and displaying parsed modifiers
 */
export function serializeModifiers(modifiers: ParsedModifiers): string {
    if (modifiers.modifiers.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (const mod of modifiers.modifiers) {
        parts.push(serializeSingleModifier(mod));
    }

    return parts.join('|');
}

function serializeSingleModifier(modifier: Modifier): string {
    switch (modifier.kind) {
        case 'lookup':
            return modifier.to !== undefined ? `lookup:${modifier.table}:${modifier.from}>${modifier.to}` : `list:${modifier.table}${modifier.from ? ':' + modifier.from : ''}`;
        case 'string':
            switch (modifier.type) {
                case 'trim':
                    return 'trim';
                case 'noTrim':
                    return 'noTrim';
                case 'upper':
                    return 'upper';
                case 'lower':
                    return 'lower';
                case 'exactLength':
                    return `${modifier.length}`;
                case 'minLength':
                    return `${modifier.min}-`;
                case 'maxLength':
                    return `-${modifier.max}`;
                case 'lengthRange':
                    return `${modifier.min}-${modifier.max}`;
            }
            break;

        case 'number':
            switch (modifier.type) {
                case 'greaterThan':
                    return `>${modifier.value}`;
                case 'greaterOrEqual':
                    return `>=${modifier.value}`;
                case 'lessThan':
                    return `<${modifier.value}`;
                case 'lessOrEqual':
                    return `<=${modifier.value}`;
                case 'integer':
                    return 'int';
                case 'round':
                    return `rnd(${modifier.decimals})`;
                case 'floor':
                    return 'floor';
                case 'ceil':
                    return 'ceil';
            }
            break;

        case 'dateMath':
            const sign = modifier.amount >= 0 ? '+' : '';
            return `${sign}${modifier.amount}${modifier.unit}`;
    }

    return '';
}
