// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Handler Hierarchical Mapping UI Tests
 * GitHub Issue #148: Hierarchical Mapping Table UI
 *
 * Tests the logic for displaying JSON hierarchy in the mapping table:
 * 1. Calculate nesting depth from jsonPath
 * 2. Group variables by array level
 * 3. Extract array paths for nested box rendering
 * 4. Source column sort badge rendering
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';

/**
 * Template variable structure from data-transformer.js
 */
interface TemplateVariable {
    name: string;
    dataType: string;
    jsonPath: string;
    mappedTo?: string;
}

/**
 * Nesting analysis result from backend
 */
interface NestingAnalysis {
    requiresSorting: boolean;
    sortColumns: string[];
    explanation: string;
    arrayPaths: string[];
}

/**
 * Helper class that implements the hierarchy logic for testing
 * These functions will be implemented in data-transformer.js
 */
class CsvHandlerHierarchyHelper {
    /**
     * Get nesting depth from a jsonPath
     * "orders[0].items[0].id" → depth 2
     * "orderId" → depth 0
     * "packages[0].weight" → depth 1
     */
    getVariableNestingDepth(jsonPath: string): number {
        if (!jsonPath) return 0;
        const arrayMatches = jsonPath.match(/\[\d+\]/g) || [];
        return arrayMatches.length;
    }

    /**
     * Extract the array path from a jsonPath
     * "packages[0].items[0].id" → "packages[].items[]"
     * "packages[0].weight" → "packages[]"
     * "orderId" → "" (no array)
     */
    extractArrayPath(jsonPath: string): string {
        if (!jsonPath) return '';

        // Replace array indices with []
        const normalized = jsonPath.replace(/\[\d+\]/g, '[]');

        // Get everything up to and including the last []
        const lastBracket = normalized.lastIndexOf('[]');
        if (lastBracket === -1) return '';

        return normalized.substring(0, lastBracket + 2);
    }

    /**
     * Get the parent array path (one level up)
     * "packages[].items[]" → "packages[]"
     * "packages[]" → ""
     * "" → ""
     */
    getParentArrayPath(arrayPath: string): string {
        if (!arrayPath || !arrayPath.includes('[]')) return '';

        // Find the second-to-last []
        const lastIndex = arrayPath.lastIndexOf('[]');
        const pathBeforeLast = arrayPath.substring(0, lastIndex);
        const secondLastIndex = pathBeforeLast.lastIndexOf('[]');

        if (secondLastIndex === -1) return '';

        return pathBeforeLast.substring(0, secondLastIndex + 2);
    }

    /**
     * Get nesting info for a variable
     */
    getVariableNestingInfo(variable: TemplateVariable): {
        depth: number;
        arrayPath: string;
        parentArrayPath: string;
    } {
        const depth = this.getVariableNestingDepth(variable.jsonPath);
        const arrayPath = this.extractArrayPath(variable.jsonPath);
        const parentArrayPath = this.getParentArrayPath(arrayPath);

        return { depth, arrayPath, parentArrayPath };
    }

    /**
     * Group variables by their array level
     * Returns a map of arrayPath -> variables
     */
    groupVariablesByArrayLevel(variables: TemplateVariable[]): Map<string, TemplateVariable[]> {
        const groups = new Map<string, TemplateVariable[]>();

        variables.forEach(variable => {
            const arrayPath = this.extractArrayPath(variable.jsonPath);

            if (!groups.has(arrayPath)) {
                groups.set(arrayPath, []);
            }
            groups.get(arrayPath)!.push(variable);
        });

        return groups;
    }

    /**
     * Get unique array paths from variables, sorted by depth
     */
    getUniqueArrayPaths(variables: TemplateVariable[]): string[] {
        const paths = new Set<string>();

        variables.forEach(variable => {
            const arrayPath = this.extractArrayPath(variable.jsonPath);
            if (arrayPath) {
                paths.add(arrayPath);
            }
        });

        // Sort by depth (shorter paths first)
        return Array.from(paths).sort((a, b) => {
            const depthA = (a.match(/\[\]/g) || []).length;
            const depthB = (b.match(/\[\]/g) || []).length;
            return depthA - depthB;
        });
    }

    /**
     * Get the array name for display (last segment)
     * "packages[].items[]" → "items[]"
     * "packages[]" → "packages[]"
     */
    getArrayDisplayName(arrayPath: string): string {
        if (!arrayPath) return '';

        const lastDotIndex = arrayPath.lastIndexOf('.');
        if (lastDotIndex === -1) return arrayPath;

        return arrayPath.substring(lastDotIndex + 1);
    }

    /**
     * Render source column with sort badge
     * Returns HTML for the column name with sort indicator
     */
    renderSourceColumnWithBadge(columnName: string, sortColumns: string[]): string {
        const sortIndex = sortColumns.indexOf(columnName);
        if (sortIndex >= 0) {
            const badges = ['⓵', '⓶', '⓷', '⓸'];
            const badge = sortIndex < badges.length ? badges[sortIndex] : `(${sortIndex + 1})`;
            return `${columnName} ${badge}`;
        }
        return columnName;
    }

    /**
     * Build the sort warning banner text
     */
    buildSortWarningBanner(sortColumns: string[]): string {
        if (sortColumns.length === 0) return '';
        return `CSV will be sorted by: ${sortColumns.join(' → ')}`;
    }
}

describe('CSV Handler Hierarchy - GitHub Issue #148', () => {
    let helper: CsvHandlerHierarchyHelper;

    // Mock nested template variables (packages with nested items)
    const mockNestedVariables: TemplateVariable[] = [
        { name: 'ShipmentID', dataType: 'string', jsonPath: 'packages[0].ShipmentID' },
        { name: 'Carrier', dataType: 'string', jsonPath: 'packages[0].Carrier' },
        { name: 'PackageID', dataType: 'string', jsonPath: 'packages[0].items[0].PackageID' },
        { name: 'Weight', dataType: 'number', jsonPath: 'packages[0].items[0].Weight' },
        { name: 'SKU', dataType: 'string', jsonPath: 'packages[0].items[0].SKU' },
        { name: 'Qty', dataType: 'number', jsonPath: 'packages[0].items[0].Qty' }
    ];

    // Flat template variables (no nesting)
    const mockFlatVariables: TemplateVariable[] = [
        { name: 'OrderID', dataType: 'string', jsonPath: 'orderId' },
        { name: 'Customer', dataType: 'string', jsonPath: 'customer' },
        { name: 'Total', dataType: 'number', jsonPath: 'total' }
    ];

    // Single-level array variables
    const mockSingleLevelVariables: TemplateVariable[] = [
        { name: 'ItemID', dataType: 'string', jsonPath: 'items[0].itemId' },
        { name: 'Name', dataType: 'string', jsonPath: 'items[0].name' },
        { name: 'Price', dataType: 'number', jsonPath: 'items[0].price' }
    ];

    beforeEach(() => {
        helper = new CsvHandlerHierarchyHelper();
    });

    describe('getVariableNestingDepth', () => {
        it('should return 0 for flat paths', () => {
            expect(helper.getVariableNestingDepth('orderId')).to.equal(0);
            expect(helper.getVariableNestingDepth('customer.name')).to.equal(0);
        });

        it('should return 1 for single-level array paths', () => {
            expect(helper.getVariableNestingDepth('items[0].id')).to.equal(1);
            expect(helper.getVariableNestingDepth('packages[0].weight')).to.equal(1);
        });

        it('should return 2 for nested array paths', () => {
            expect(helper.getVariableNestingDepth('packages[0].items[0].id')).to.equal(2);
            expect(helper.getVariableNestingDepth('orders[0].items[0].qty')).to.equal(2);
        });

        it('should return 3 for deeply nested paths', () => {
            expect(helper.getVariableNestingDepth('orders[0].packages[0].items[0].sku')).to.equal(3);
        });

        it('should handle empty or undefined paths', () => {
            expect(helper.getVariableNestingDepth('')).to.equal(0);
            expect(helper.getVariableNestingDepth(undefined as unknown as string)).to.equal(0);
        });
    });

    describe('extractArrayPath', () => {
        it('should return empty string for flat paths', () => {
            expect(helper.extractArrayPath('orderId')).to.equal('');
            expect(helper.extractArrayPath('customer.name')).to.equal('');
        });

        it('should extract single-level array path', () => {
            expect(helper.extractArrayPath('items[0].id')).to.equal('items[]');
            expect(helper.extractArrayPath('packages[0].weight')).to.equal('packages[]');
        });

        it('should extract nested array path', () => {
            expect(helper.extractArrayPath('packages[0].items[0].id')).to.equal('packages[].items[]');
            expect(helper.extractArrayPath('orders[0].items[0].qty')).to.equal('orders[].items[]');
        });

        it('should handle deeply nested paths', () => {
            expect(helper.extractArrayPath('orders[0].packages[0].items[0].sku')).to.equal('orders[].packages[].items[]');
        });
    });

    describe('getParentArrayPath', () => {
        it('should return empty for single-level array', () => {
            expect(helper.getParentArrayPath('packages[]')).to.equal('');
        });

        it('should return parent for two-level array', () => {
            expect(helper.getParentArrayPath('packages[].items[]')).to.equal('packages[]');
        });

        it('should return parent for three-level array', () => {
            expect(helper.getParentArrayPath('orders[].packages[].items[]')).to.equal('orders[].packages[]');
        });

        it('should handle empty path', () => {
            expect(helper.getParentArrayPath('')).to.equal('');
        });
    });

    describe('getVariableNestingInfo', () => {
        it('should return correct info for nested variable', () => {
            const variable = mockNestedVariables[2]; // PackageID
            const info = helper.getVariableNestingInfo(variable);

            expect(info.depth).to.equal(2);
            expect(info.arrayPath).to.equal('packages[].items[]');
            expect(info.parentArrayPath).to.equal('packages[]');
        });

        it('should return correct info for parent-level variable', () => {
            const variable = mockNestedVariables[0]; // ShipmentID
            const info = helper.getVariableNestingInfo(variable);

            expect(info.depth).to.equal(1);
            expect(info.arrayPath).to.equal('packages[]');
            expect(info.parentArrayPath).to.equal('');
        });
    });

    describe('groupVariablesByArrayLevel', () => {
        it('should group nested variables correctly', () => {
            const groups = helper.groupVariablesByArrayLevel(mockNestedVariables);

            // Should have 2 groups: packages[] and packages[].items[]
            expect(groups.size).to.equal(2);

            const packagesVars = groups.get('packages[]');
            expect(packagesVars).to.not.be.undefined;
            expect(packagesVars!.length).to.equal(2); // ShipmentID, Carrier

            const itemsVars = groups.get('packages[].items[]');
            expect(itemsVars).to.not.be.undefined;
            expect(itemsVars!.length).to.equal(4); // PackageID, Weight, SKU, Qty
        });

        it('should group flat variables at empty path', () => {
            const groups = helper.groupVariablesByArrayLevel(mockFlatVariables);

            expect(groups.size).to.equal(1);
            const flatVars = groups.get('');
            expect(flatVars).to.not.be.undefined;
            expect(flatVars!.length).to.equal(3);
        });

        it('should group single-level array variables', () => {
            const groups = helper.groupVariablesByArrayLevel(mockSingleLevelVariables);

            expect(groups.size).to.equal(1);
            const itemsVars = groups.get('items[]');
            expect(itemsVars).to.not.be.undefined;
            expect(itemsVars!.length).to.equal(3);
        });
    });

    describe('getUniqueArrayPaths', () => {
        it('should return unique array paths sorted by depth', () => {
            const paths = helper.getUniqueArrayPaths(mockNestedVariables);

            expect(paths).to.deep.equal(['packages[]', 'packages[].items[]']);
        });

        it('should return empty array for flat variables', () => {
            const paths = helper.getUniqueArrayPaths(mockFlatVariables);

            expect(paths).to.deep.equal([]);
        });

        it('should return single path for single-level array', () => {
            const paths = helper.getUniqueArrayPaths(mockSingleLevelVariables);

            expect(paths).to.deep.equal(['items[]']);
        });
    });

    describe('getArrayDisplayName', () => {
        it('should return full name for single-level array', () => {
            expect(helper.getArrayDisplayName('packages[]')).to.equal('packages[]');
        });

        it('should return last segment for nested array', () => {
            expect(helper.getArrayDisplayName('packages[].items[]')).to.equal('items[]');
        });

        it('should handle deeply nested arrays', () => {
            expect(helper.getArrayDisplayName('orders[].packages[].items[]')).to.equal('items[]');
        });

        it('should handle empty path', () => {
            expect(helper.getArrayDisplayName('')).to.equal('');
        });
    });

    describe('renderSourceColumnWithBadge', () => {
        const sortColumns = ['ShipmentID', 'PackageID'];

        it('should add sort badge for first sort column', () => {
            const result = helper.renderSourceColumnWithBadge('ShipmentID', sortColumns);
            expect(result).to.equal('ShipmentID ⓵');
        });

        it('should add sort badge for second sort column', () => {
            const result = helper.renderSourceColumnWithBadge('PackageID', sortColumns);
            expect(result).to.equal('PackageID ⓶');
        });

        it('should return plain column name when not a sort column', () => {
            const result = helper.renderSourceColumnWithBadge('Weight', sortColumns);
            expect(result).to.equal('Weight');
        });

        it('should handle more than 4 sort columns', () => {
            const manySortColumns = ['A', 'B', 'C', 'D', 'E'];
            const result = helper.renderSourceColumnWithBadge('E', manySortColumns);
            expect(result).to.equal('E (5)');
        });

        it('should handle empty sort columns', () => {
            const result = helper.renderSourceColumnWithBadge('ShipmentID', []);
            expect(result).to.equal('ShipmentID');
        });
    });

    describe('buildSortWarningBanner', () => {
        it('should build banner for single sort column', () => {
            const result = helper.buildSortWarningBanner(['ShipmentID']);
            expect(result).to.equal('CSV will be sorted by: ShipmentID');
        });

        it('should build banner for multiple sort columns', () => {
            const result = helper.buildSortWarningBanner(['ShipmentID', 'PackageID']);
            expect(result).to.equal('CSV will be sorted by: ShipmentID → PackageID');
        });

        it('should return empty string for no sort columns', () => {
            const result = helper.buildSortWarningBanner([]);
            expect(result).to.equal('');
        });
    });

    describe('Full Hierarchy Rendering Scenario', () => {
        it('should correctly structure nested shipment data for rendering', () => {
            // Simulates the full flow of preparing data for hierarchical rendering

            // 1. Get unique array paths (for nested box containers)
            const arrayPaths = helper.getUniqueArrayPaths(mockNestedVariables);
            expect(arrayPaths).to.have.length(2);

            // 2. Group variables by array level
            const groups = helper.groupVariablesByArrayLevel(mockNestedVariables);

            // 3. Build the rendering structure
            const structure: { arrayPath: string; displayName: string; variables: TemplateVariable[] }[] = [];

            arrayPaths.forEach(path => {
                structure.push({
                    arrayPath: path,
                    displayName: helper.getArrayDisplayName(path),
                    variables: groups.get(path) || []
                });
            });

            // Verify structure
            expect(structure[0].arrayPath).to.equal('packages[]');
            expect(structure[0].displayName).to.equal('packages[]');
            expect(structure[0].variables.map(v => v.name)).to.deep.equal(['ShipmentID', 'Carrier']);

            expect(structure[1].arrayPath).to.equal('packages[].items[]');
            expect(structure[1].displayName).to.equal('items[]');
            expect(structure[1].variables.map(v => v.name)).to.deep.equal(['PackageID', 'Weight', 'SKU', 'Qty']);
        });

        it('should handle sorting analysis integration', () => {
            const sortingAnalysis: NestingAnalysis = {
                requiresSorting: true,
                sortColumns: ['ShipmentID', 'PackageID'],
                explanation: 'Data should be sorted to group items by shipment',
                arrayPaths: ['packages[]', 'packages[].items[]']
            };

            // Build sort banner
            const banner = helper.buildSortWarningBanner(sortingAnalysis.sortColumns);
            expect(banner).to.include('ShipmentID');
            expect(banner).to.include('PackageID');

            // Render columns with badges
            const sourceColumns = mockNestedVariables.map(v => v.name);
            const renderedColumns = sourceColumns.map(col =>
                helper.renderSourceColumnWithBadge(col, sortingAnalysis.sortColumns)
            );

            expect(renderedColumns[0]).to.equal('ShipmentID ⓵');
            expect(renderedColumns[1]).to.equal('Carrier');
            expect(renderedColumns[2]).to.equal('PackageID ⓶');
            expect(renderedColumns[3]).to.equal('Weight');
        });
    });
});
