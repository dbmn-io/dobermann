// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Modifier Types for GitHub Issue #175
 *
 * Type definitions for string, number, and date modifiers that validate
 * and transform template variable values.
 *
 * SYNTAX:
 * - Colon (:) = FORMAT (dates only): {{VAR:date:iso}}
 * - Pipe (|) = MODIFIER (all types): {{VAR:string|upper}}
 *
 * Template Format:
 *   {{VAR:type}}                   → Type only
 *   {{VAR:type:format}}            → Type + format (dates only)
 *   {{VAR:type|modifier}}          → Type + modifier
 *   {{VAR:type:format|modifier}}   → Type + format + modifier (dates only)
 *   {{VAR:type|mod1|mod2}}         → Type + chained modifiers
 *
 * Examples:
 *   {{Name:string|3-50}}           → String with 3-50 char length validation
 *   {{Name:string|3-50|upper}}     → String with length + uppercase
 *   {{Amount:number|>0|rnd(2)}}    → Number: positive, round to 2 decimals
 *   {{Qty:number|int|>0}}          → Number: integer, positive
 *   {{Date:date:iso}}              → Date with ISO format (no modifier)
 *   {{Date:date|+2d}}              → Date + add 2 days (default format)
 *   {{Date:date:iso|+2d}}          → Date: ISO format + add 2 days
 *   {{A8:datetime|+7d}}            → A8 datetime + add 1 week
 *   {{uom | lu:uom:tms>wms}}       → uom looked up in lookup table uom: TMS in, WMS out (type string)
 *   {{uom | lu:uom:wms}}           → uom checked to be in table uom's WMS column
 */

import { DataType } from './types';

// ============================================================================
// String Modifiers
// ============================================================================

/**
 * String modifier types
 */
export type StringModifierType =
    | 'trim'        // Default - trim whitespace
    | 'noTrim'      // Keep leading/trailing spaces
    | 'upper'       // Convert to UPPERCASE
    | 'lower'       // Convert to lowercase
    | 'exactLength' // Exact length validation (n)
    | 'minLength'   // Minimum length validation
    | 'maxLength'   // Maximum length validation
    | 'lengthRange'; // Length range validation (min-max)

/**
 * String modifier definition
 */
export interface StringModifier {
    type: StringModifierType;
    /** For exactLength */
    length?: number;
    /** For minLength, maxLength, lengthRange */
    min?: number;
    max?: number;
}

// ============================================================================
// Number Modifiers
// ============================================================================

/**
 * Number modifier types
 */
export type NumberModifierType =
    | 'greaterThan'     // >n
    | 'greaterOrEqual'  // >=n
    | 'lessThan'        // <n
    | 'lessOrEqual'     // <=n
    | 'integer'         // int - whole numbers only
    | 'round'           // rnd(n) - round to n decimals
    | 'floor'           // round down
    | 'ceil';           // round up

/**
 * Number modifier definition
 */
export interface NumberModifier {
    type: NumberModifierType;
    /** For comparison modifiers: the value to compare against */
    value?: number;
    /** For round: number of decimal places */
    decimals?: number;
}

// ============================================================================
// Date Math Modifiers
// ============================================================================

/**
 * Date math modifier types - time unit for arithmetic
 * - d: days
 * - w: weeks
 * - M: months (capital M to distinguish from minutes)
 * - y: years
 * - h: hours
 * - m: minutes (lowercase)
 */
export type DateMathUnit = 'd' | 'w' | 'M' | 'y' | 'h' | 'm';

/**
 * Date math modifier definition
 */
export interface DateMathModifier {
    type: 'dateMath';
    /** Positive for add, negative for subtract */
    amount: number;
    /** Time unit */
    unit: DateMathUnit;
}

// ============================================================================
// Empty Value Behavior Modifiers
// ============================================================================

/**
 * Controls behavior when a value is empty or missing
 *
 * - 'default': Keep current behavior (string→"", number→0)
 * - 'opt': Omit key entirely from JSON if value is empty
 * - 'null': Pass null as value if empty
 */
export type EmptyValueBehavior = 'default' | 'opt' | 'null';

// ============================================================================
// Unified Modifier Type
// ============================================================================

/**
 * Union type for all modifier kinds
 */
export type Modifier =
    | ({ kind: 'string' } & StringModifier)
    | ({ kind: 'number' } & NumberModifier)
    | ({ kind: 'dateMath' } & DateMathModifier)
    | ({ kind: 'lookup' } & LookupModifier);

/**
 * `lu`: a value looked up in a lookup table (James, 2026-11-23). `{{uom | lu:uom:tms>wms}}` finds the
 * value in table uom's TMS column and sends that row's WMS; `{{uom | lu:uom:wms}}` only checks it is
 * in WMS and sends it as it is. Not there, there twice, or blank (the value, or the To it finds): a
 * failure, in Validate and in the run. Table and columns by name, any case (lookup-tables.ts).
 */
export interface LookupModifier {
    type: 'lookup';
    table: string;
    from: string;
    /** Left out: only checked against `from`'s values. */
    to?: string;
}

/**
 * Parsed modifier chain for a variable
 */
export interface ParsedModifiers {
    /** Original modifier string (everything after type) */
    raw: string;
    /** Parsed modifier objects */
    modifiers: Modifier[];
    /** Whether default trim should be applied (true unless noTrim specified) */
    applyTrim: boolean;
    /** Behavior when value is empty: 'default', 'opt' (omit key), or 'null' (pass null) */
    emptyBehavior: EmptyValueBehavior;
    /** Forces JSON string output regardless of type (e.g., number 1 → "1") */
    outputAsString: boolean;
    /** Any parse errors encountered */
    errors: string[];
}

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Result of applying modifiers to a single value
 */
export interface ModifierResult {
    /** Whether validation passed */
    success: boolean;
    /** Transformed value (if success) */
    value?: unknown;
    /** Error message (if failed) */
    error?: string;
    /** If true, the key should be omitted entirely from the JSON output (for |opt modifier) */
    omitKey?: boolean;
}

/**
 * Result of validating a single row value
 */
export interface RowValidationError {
    /** 1-indexed row number from CSV */
    rowNumber: number;
    /** Variable name that failed */
    variableName: string;
    /** The value that failed validation */
    value: string;
    /** The modifier that caused the failure */
    modifier: string;
    /** Human-readable error message */
    message: string;
}

/**
 * Result of batch validation
 */
export interface BatchValidationResult {
    /** Whether all rows passed validation */
    success: boolean;
    /** Total number of rows validated */
    totalRows: number;
    /** Number of rows that passed */
    passedRows: number;
    /** Number of rows that failed */
    failedRows: number;
    /** All validation errors */
    errors: RowValidationError[];
}

// ============================================================================
// Extended Variable Interface
// ============================================================================

/**
 * Extended InferredVariable with modifier support
 *
 * This extends the existing InferredVariable interface from json-template-parser.ts
 */
export interface VariableWithModifiers {
    /** Original pattern in template */
    originalPattern: string;
    /** Resolved variable name */
    resolvedName: string;
    /** Data type */
    dataType: DataType;
    /** Whether this is an A8 system variable */
    isA8Variable: boolean;
    /** Whether this is an ENV environment variable */
    isEnvVariable: boolean;
    /** Parsed modifiers (if any) */
    modifiers?: ParsedModifiers;
    /** Format modifier for date/datetime (preserved from existing implementation) */
    formatModifier?: string;
}

// ============================================================================
// Modifier Compatibility
// ============================================================================

/**
 * Map of which modifier types are valid for which data types
 */
export const MODIFIER_TYPE_COMPATIBILITY: Record<DataType, readonly string[]> = {
    'string': ['trim', 'noTrim', 'upper', 'lower', 'exactLength', 'minLength', 'maxLength', 'lengthRange'],
    'number': ['greaterThan', 'greaterOrEqual', 'lessThan', 'lessOrEqual', 'integer', 'round', 'floor', 'ceil'],
    'boolean': [], // No modifiers for boolean
    'date': ['dateMath'],
    'datetime': ['dateMath']
} as const;
