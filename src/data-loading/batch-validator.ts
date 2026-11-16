// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Batch Validator Service for GitHub Issue #175
 *
 * Validates entire CSV dataset against template modifiers.
 * This runs between Step 2 (mapping) and Step 3 (execution) to provide
 * a fail-fast validation gate.
 *
 * Validation Timing:
 * 1. User maps CSV columns → Template variables (Step 2)
 * 2. VALIDATION GATE: All rows validated against modifiers
 * 3. If ANY row fails → Show errors, BLOCK execution
 * 4. Only when ALL rows pass → Allow execution to proceed (Step 3)
 */

import { DataType } from './types';
import {
    ParsedModifiers,
    BatchValidationResult,
    RowValidationError,
    VariableWithModifiers
} from './modifier-types';
import { parseModifiers, extractModifiersFromFormat } from './modifier-parser';
import { applyModifiers, hasValidationModifiers } from './modifier-executor';
import { InferredVariable } from './json-template-parser';

/**
 * Interface for a mapped variable (variable + CSV column mapping)
 */
export interface MappedVariable {
    /** The template variable */
    variable: InferredVariable;
    /** The CSV column it's mapped to (or static value) */
    csvColumn?: string;
    /** Static value (if not mapped to CSV column) */
    staticValue?: string;
    /** Whether this is mapped to a CSV column */
    isCsvMapped: boolean;
}

/**
 * Validate all rows in a CSV dataset against template variable modifiers
 *
 * @param csvData - Array of CSV row objects (header → value)
 * @param mappedVariables - Template variables with their CSV column mappings
 * @returns Validation result with all errors
 */
export function validateBatch(
    csvData: Record<string, string>[],
    mappedVariables: MappedVariable[]
): BatchValidationResult {
    const errors: RowValidationError[] = [];
    const totalRows = csvData.length;
    let passedRows = 0;

    // Parse modifiers for each variable that has them
    const variablesWithModifiers = prepareVariablesForValidation(mappedVariables);

    // Check if any variables actually have validation modifiers
    const hasAnyValidation = variablesWithModifiers.some(v =>
        v.modifiers && hasValidationModifiers(v.modifiers)
    );

    // If no validation modifiers, all rows pass automatically
    if (!hasAnyValidation) {
        return {
            success: true,
            totalRows,
            passedRows: totalRows,
            failedRows: 0,
            errors: []
        };
    }

    // Validate each row
    for (let rowIndex = 0; rowIndex < csvData.length; rowIndex++) {
        const row = csvData[rowIndex];
        const rowNumber = rowIndex + 1; // 1-indexed for display

        let rowPassed = true;

        for (const { mapping, modifiers, variable } of variablesWithModifiers) {
            // Skip if no modifiers or no validation modifiers
            if (!modifiers || !hasValidationModifiers(modifiers)) {
                continue;
            }

            // Get the value to validate
            let value: string;
            if (mapping.isCsvMapped && mapping.csvColumn) {
                value = row[mapping.csvColumn] ?? '';
            } else if (mapping.staticValue !== undefined) {
                value = mapping.staticValue;
            } else {
                // No value to validate
                continue;
            }

            // Apply modifiers and check for validation errors
            const result = applyModifiers(value, variable.dataType, modifiers);

            if (!result.success && result.error) {
                rowPassed = false;
                errors.push({
                    rowNumber,
                    variableName: variable.resolvedName,
                    value,
                    modifier: modifiers.raw,
                    message: result.error
                });
            }
        }

        if (rowPassed) {
            passedRows++;
        }
    }

    const failedRows = totalRows - passedRows;

    return {
        success: errors.length === 0,
        totalRows,
        passedRows,
        failedRows,
        errors
    };
}

/**
 * Prepare variables for validation by parsing their modifiers
 */
function prepareVariablesForValidation(
    mappedVariables: MappedVariable[]
): Array<{
    mapping: MappedVariable;
    variable: InferredVariable;
    modifiers: ParsedModifiers | undefined;
}> {
    return mappedVariables.map(mapping => {
        const variable = mapping.variable;

        // Skip A8 variables and ENV variables - they don't come from CSV
        if (variable.isA8Variable || variable.isEnvVariable) {
            return { mapping, variable, modifiers: undefined };
        }

        // Parse modifiers from formatModifier field
        if (variable.formatModifier) {
            const { modifiers } = extractModifiersFromFormat(
                variable.formatModifier,
                variable.dataType
            );
            return { mapping, variable, modifiers };
        }

        // No modifiers
        return { mapping, variable, modifiers: undefined };
    });
}

/**
 * Format validation errors for display
 *
 * @param result - Batch validation result
 * @returns Formatted error messages
 */
export function formatValidationErrors(result: BatchValidationResult): string[] {
    return result.errors.map(error =>
        `Row ${error.rowNumber}: Variable '${error.variableName}' value '${error.value}' failed validation: ${error.message}`
    );
}

/**
 * Group validation errors by row
 *
 * @param result - Batch validation result
 * @returns Map of row number to errors for that row
 */
export function groupErrorsByRow(
    result: BatchValidationResult
): Map<number, RowValidationError[]> {
    const grouped = new Map<number, RowValidationError[]>();

    for (const error of result.errors) {
        const existing = grouped.get(error.rowNumber) || [];
        existing.push(error);
        grouped.set(error.rowNumber, existing);
    }

    return grouped;
}

/**
 * Group validation errors by variable
 *
 * @param result - Batch validation result
 * @returns Map of variable name to errors for that variable
 */
export function groupErrorsByVariable(
    result: BatchValidationResult
): Map<string, RowValidationError[]> {
    const grouped = new Map<string, RowValidationError[]>();

    for (const error of result.errors) {
        const existing = grouped.get(error.variableName) || [];
        existing.push(error);
        grouped.set(error.variableName, existing);
    }

    return grouped;
}

/**
 * Get a summary of validation results
 */
export function getValidationSummary(result: BatchValidationResult): string {
    if (result.success) {
        return `All ${result.totalRows} rows passed validation.`;
    }

    const uniqueVariables = new Set(result.errors.map(e => e.variableName)).size;
    const uniqueRows = new Set(result.errors.map(e => e.rowNumber)).size;

    return `Validation failed: ${result.errors.length} error(s) across ${uniqueRows} row(s) affecting ${uniqueVariables} variable(s). ` +
           `${result.passedRows}/${result.totalRows} rows passed.`;
}

/**
 * Create a validation gate that blocks execution if validation fails
 *
 * This is the main entry point for the validation gate between Step 2 and Step 3.
 *
 * @param csvData - CSV data to validate
 * @param mappedVariables - Mapped variables from Step 2
 * @returns Object with validation result and execution decision
 */
export function createValidationGate(
    csvData: Record<string, string>[],
    mappedVariables: MappedVariable[]
): {
    canProceed: boolean;
    result: BatchValidationResult;
    summary: string;
    formattedErrors: string[];
} {
    const result = validateBatch(csvData, mappedVariables);
    const summary = getValidationSummary(result);
    const formattedErrors = formatValidationErrors(result);

    return {
        canProceed: result.success,
        result,
        summary,
        formattedErrors
    };
}

/**
 * Validate a single value against a variable's modifiers
 *
 * Useful for real-time validation in the UI (e.g., Run API form)
 *
 * @param value - The value to validate
 * @param variable - The template variable
 * @returns Validation result
 */
export function validateSingleValue(
    value: string,
    variable: InferredVariable
): { valid: boolean; error?: string; transformedValue?: unknown } {
    // Parse modifiers if present
    if (!variable.formatModifier) {
        // No modifiers - just return success
        return { valid: true };
    }

    const { modifiers } = extractModifiersFromFormat(
        variable.formatModifier,
        variable.dataType
    );

    // Apply modifiers
    const result = applyModifiers(value, variable.dataType, modifiers);

    if (result.success) {
        return { valid: true, transformedValue: result.value };
    }

    return { valid: false, error: result.error };
}
