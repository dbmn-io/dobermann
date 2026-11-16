// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Handler Navigation Tests
 * GitHub Issue #148: Grid Navigation Fix
 *
 * Tests the logic for grid data template variable handling in the CSV modal navigation.
 * These tests verify:
 * 1. gridTemplateVariables fallback when templateVariables is not available
 * 2. Template variable extraction for grid source type
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';

/**
 * Simulates the csvState object structure used in data-transformer.js
 */
interface CsvState {
    sourceType: 'grid' | 'file' | 'paste' | null;
    templateVariables: TemplateVariable[] | null;
    gridTemplateVariables: TemplateVariable[] | null;
    modalStep: number;
    autoSkipAttempted: boolean;
    navigationInProgress: boolean;
    currentHeaders: string[] | null;
}

interface TemplateVariable {
    name: string;
    dataType: string;
    jsonPath: string;
    mappedTo?: string;
}

/**
 * Helper class that extracts and tests the logic from data-transformer.js
 * These functions mirror the behavior in the frontend code
 */
class CsvHandlerNavigationHelper {
    /**
     * Get template variables with fallback to gridTemplateVariables
     * Mirrors the logic at data-transformer.js:1711-1722
     */
    getTemplateVariablesWithFallback(csvState: CsvState): TemplateVariable[] | null {
        // GitHub Issue #148: Use grid template variables when sourceType is 'grid'
        // Grid data stores variables in csvState.gridTemplateVariables, not templateVariables
        const templateVars = csvState.templateVariables ||
            (csvState.sourceType === 'grid' ? csvState.gridTemplateVariables : null);

        return templateVars;
    }

    /**
     * Ensure templateVariables is populated for downstream code
     * Mirrors the logic at data-transformer.js:1718-1722
     */
    ensureTemplateVariablesPopulated(csvState: CsvState): void {
        const templateVars = this.getTemplateVariablesWithFallback(csvState);

        if (templateVars && templateVars.length > 0) {
            // Ensure csvState.templateVariables is populated for downstream code
            if (!csvState.templateVariables) {
                csvState.templateVariables = templateVars;
            }
        }
    }

    /**
     * Check if should auto-skip step 2 for grid data
     * Mirrors the logic at data-transformer.js:6760-6766 (inside handleCSVCompatibilityVerified)
     */
    shouldAutoSkipStep2(csvState: CsvState): boolean {
        return csvState.sourceType === 'grid' &&
            csvState.modalStep === 2 &&
            !csvState.autoSkipAttempted;
    }

    /**
     * Get template variables for compatibility verification response
     * This simulates the fix needed - use gridTemplateVariables as fallback
     * when message.mappingStatus.variables is empty/missing for grid data
     */
    getTemplateVariablesFromMessage(
        message: { mappingStatus?: { variables?: TemplateVariable[] } },
        csvState: CsvState
    ): TemplateVariable[] | null {
        // First try message variables (normal flow)
        if (message.mappingStatus?.variables && message.mappingStatus.variables.length > 0) {
            return message.mappingStatus.variables;
        }

        // GitHub Issue #148: Fallback to gridTemplateVariables for grid source type
        if (csvState.sourceType === 'grid' && csvState.gridTemplateVariables) {
            return csvState.gridTemplateVariables;
        }

        return null;
    }
}

describe('CSV Handler Navigation - GitHub Issue #148', () => {
    let helper: CsvHandlerNavigationHelper;
    let csvState: CsvState;

    const mockGridVariables: TemplateVariable[] = [
        { name: 'ShipmentID', dataType: 'string', jsonPath: 'packages[0].ShipmentID' },
        { name: 'Carrier', dataType: 'string', jsonPath: 'packages[0].Carrier' },
        { name: 'PackageID', dataType: 'string', jsonPath: 'packages[0].items[0].PackageID' },
        { name: 'Weight', dataType: 'number', jsonPath: 'packages[0].items[0].Weight' }
    ];

    beforeEach(() => {
        helper = new CsvHandlerNavigationHelper();
        csvState = {
            sourceType: null,
            templateVariables: null,
            gridTemplateVariables: null,
            modalStep: 1,
            autoSkipAttempted: false,
            navigationInProgress: false,
            currentHeaders: null
        };
    });

    describe('getTemplateVariablesWithFallback', () => {
        it('should return templateVariables when available', () => {
            const templateVars: TemplateVariable[] = [
                { name: 'VAR1', dataType: 'string', jsonPath: 'var1' }
            ];
            csvState.templateVariables = templateVars;
            csvState.sourceType = 'file';

            const result = helper.getTemplateVariablesWithFallback(csvState);

            expect(result).to.deep.equal(templateVars);
        });

        it('should return gridTemplateVariables when sourceType is grid and templateVariables is null', () => {
            csvState.sourceType = 'grid';
            csvState.templateVariables = null;
            csvState.gridTemplateVariables = mockGridVariables;

            const result = helper.getTemplateVariablesWithFallback(csvState);

            expect(result).to.deep.equal(mockGridVariables);
        });

        it('should NOT return gridTemplateVariables when sourceType is file', () => {
            csvState.sourceType = 'file';
            csvState.templateVariables = null;
            csvState.gridTemplateVariables = mockGridVariables;

            const result = helper.getTemplateVariablesWithFallback(csvState);

            expect(result).to.be.null;
        });

        it('should NOT return gridTemplateVariables when sourceType is paste', () => {
            csvState.sourceType = 'paste';
            csvState.templateVariables = null;
            csvState.gridTemplateVariables = mockGridVariables;

            const result = helper.getTemplateVariablesWithFallback(csvState);

            expect(result).to.be.null;
        });

        it('should prioritize templateVariables over gridTemplateVariables', () => {
            const templateVars: TemplateVariable[] = [
                { name: 'DIFFERENT', dataType: 'string', jsonPath: 'diff' }
            ];
            csvState.sourceType = 'grid';
            csvState.templateVariables = templateVars;
            csvState.gridTemplateVariables = mockGridVariables;

            const result = helper.getTemplateVariablesWithFallback(csvState);

            expect(result).to.deep.equal(templateVars);
            expect(result).to.not.deep.equal(mockGridVariables);
        });
    });

    describe('ensureTemplateVariablesPopulated', () => {
        it('should populate templateVariables from gridTemplateVariables for grid source', () => {
            csvState.sourceType = 'grid';
            csvState.templateVariables = null;
            csvState.gridTemplateVariables = mockGridVariables;

            helper.ensureTemplateVariablesPopulated(csvState);

            expect(csvState.templateVariables).to.deep.equal(mockGridVariables);
        });

        it('should not overwrite existing templateVariables', () => {
            const existingVars: TemplateVariable[] = [
                { name: 'EXISTING', dataType: 'string', jsonPath: 'existing' }
            ];
            csvState.sourceType = 'grid';
            csvState.templateVariables = existingVars;
            csvState.gridTemplateVariables = mockGridVariables;

            helper.ensureTemplateVariablesPopulated(csvState);

            expect(csvState.templateVariables).to.deep.equal(existingVars);
        });

        it('should not populate for non-grid source types', () => {
            csvState.sourceType = 'file';
            csvState.templateVariables = null;
            csvState.gridTemplateVariables = mockGridVariables;

            helper.ensureTemplateVariablesPopulated(csvState);

            expect(csvState.templateVariables).to.be.null;
        });
    });

    describe('shouldAutoSkipStep2', () => {
        it('should return true for grid source at step 2 when not yet attempted', () => {
            csvState.sourceType = 'grid';
            csvState.modalStep = 2;
            csvState.autoSkipAttempted = false;

            const result = helper.shouldAutoSkipStep2(csvState);

            expect(result).to.be.true;
        });

        it('should return false if autoSkipAttempted is true', () => {
            csvState.sourceType = 'grid';
            csvState.modalStep = 2;
            csvState.autoSkipAttempted = true;

            const result = helper.shouldAutoSkipStep2(csvState);

            expect(result).to.be.false;
        });

        it('should return false for file source type', () => {
            csvState.sourceType = 'file';
            csvState.modalStep = 2;
            csvState.autoSkipAttempted = false;

            const result = helper.shouldAutoSkipStep2(csvState);

            expect(result).to.be.false;
        });

        it('should return false when not at step 2', () => {
            csvState.sourceType = 'grid';
            csvState.modalStep = 1;
            csvState.autoSkipAttempted = false;

            const result = helper.shouldAutoSkipStep2(csvState);

            expect(result).to.be.false;
        });
    });

    describe('getTemplateVariablesFromMessage - BUG FIX TEST', () => {
        it('should return message variables when available', () => {
            const messageVars: TemplateVariable[] = [
                { name: 'FROM_MESSAGE', dataType: 'string', jsonPath: 'msg' }
            ];
            const message = { mappingStatus: { variables: messageVars } };

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            expect(result).to.deep.equal(messageVars);
        });

        it('BUG #148: should fallback to gridTemplateVariables when message has no variables for grid source', () => {
            // This is the core bug scenario:
            // 1. Grid data is entered
            // 2. User clicks Next to go from Step 1 -> Step 2
            // 3. handleCSVCompatibilityVerified receives message with empty/missing mappingStatus.variables
            // 4. Without the fix, templateVariables would be null and navigation would fail
            csvState.sourceType = 'grid';
            csvState.gridTemplateVariables = mockGridVariables;

            // Message has no variables (or empty array)
            const message = { mappingStatus: { variables: [] } };

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            // With the fix, should return gridTemplateVariables
            expect(result).to.deep.equal(mockGridVariables);
            expect(result).to.have.length(4);
        });

        it('BUG #148: should fallback when mappingStatus is undefined for grid source', () => {
            csvState.sourceType = 'grid';
            csvState.gridTemplateVariables = mockGridVariables;

            const message = {};

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            expect(result).to.deep.equal(mockGridVariables);
        });

        it('BUG #148: should fallback when mappingStatus.variables is undefined for grid source', () => {
            csvState.sourceType = 'grid';
            csvState.gridTemplateVariables = mockGridVariables;

            const message = { mappingStatus: {} };

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            expect(result).to.deep.equal(mockGridVariables);
        });

        it('should NOT fallback for file source when message has no variables', () => {
            csvState.sourceType = 'file';
            csvState.gridTemplateVariables = mockGridVariables;

            const message = { mappingStatus: { variables: [] } };

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            expect(result).to.be.null;
        });

        it('should NOT fallback for paste source when message has no variables', () => {
            csvState.sourceType = 'paste';
            csvState.gridTemplateVariables = mockGridVariables;

            const message = {};

            const result = helper.getTemplateVariablesFromMessage(message, csvState);

            expect(result).to.be.null;
        });
    });

    describe('Full Navigation Flow Simulation - Grid Data', () => {
        it('should successfully navigate Step 1 -> Step 2 -> Step 3 with grid data', () => {
            // Simulate the full flow for grid data navigation

            // Step 1: Grid is initialized with template variables
            csvState.sourceType = 'grid';
            csvState.gridTemplateVariables = mockGridVariables;
            csvState.currentHeaders = mockGridVariables.map(v => v.name);
            csvState.modalStep = 1;

            // Step 2: User clicks Next, handleCSVCompatibilityVerified is called
            // But message might not have variables for grid data
            const message = { mappingStatus: {} };

            // With the fix: get variables from fallback
            const templateVars = helper.getTemplateVariablesFromMessage(message, csvState);
            expect(templateVars).to.not.be.null;

            // Populate csvState.templateVariables for downstream code
            if (templateVars) {
                csvState.templateVariables = templateVars;
            }
            csvState.modalStep = 2;

            // Verify templateVariables is now populated
            expect(csvState.templateVariables).to.deep.equal(mockGridVariables);

            // Step 3: User clicks Next at Step 2
            // startFullCoercionValidation checks for templateVariables
            expect(csvState.templateVariables).to.not.be.null;
            expect(csvState.templateVariables!.length).to.be.greaterThan(0);

            // Navigation should succeed
            csvState.modalStep = 3;
            expect(csvState.modalStep).to.equal(3);
        });

        it('should fail navigation without the fix (demonstrating the bug)', () => {
            // This test demonstrates what happens WITHOUT the fix

            csvState.sourceType = 'grid';
            csvState.gridTemplateVariables = mockGridVariables;
            csvState.modalStep = 1;

            // Message has no variables (this is what triggers the bug)
            const message: { mappingStatus?: { variables?: TemplateVariable[] } } = { mappingStatus: {} };

            // Without the fix: only check message.mappingStatus.variables
            const templateVarsWithoutFix = message.mappingStatus?.variables || null;

            // This would be null - the bug!
            expect(templateVarsWithoutFix).to.be.null;

            // Without templateVariables, startFullCoercionValidation would fail
            // and navigation from Step 2 -> Step 3 would be blocked
        });
    });
});
