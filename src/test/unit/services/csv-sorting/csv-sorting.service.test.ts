// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Sorting Service Tests
 * GitHub Issue #148: Sort CSV After Mapping with Opt-In
 *
 * Tests pure business logic of CSV sorting - excludes file system operations
 * which require vscode module (tested via integration tests)
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { NestedArraySortAnalysis, SortCheckResult } from '../../../../services/csv-sorting/csv-sorting.interface';

/**
 * Pure function implementations extracted for testing
 * These match the CSVSortingService methods but without vscode dependencies
 */
class CSVSortingTestHelper {
    /**
     * Find all array paths in a JSON template, including nested arrays
     */
    private findNestedArrayPaths(obj: unknown, currentPath: string = ''): string[] {
        const paths: string[] = [];

        if (Array.isArray(obj)) {
            const arrayPath = currentPath ? `${currentPath}[]` : '[]';
            paths.push(arrayPath);

            if (obj.length > 0) {
                paths.push(...this.findNestedArrayPaths(obj[0], arrayPath));
            }
        } else if (obj && typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj)) {
                const newPath = currentPath ? `${currentPath}.${key}` : key;
                paths.push(...this.findNestedArrayPaths(value, newPath));
            }
        }

        return paths;
    }

    /**
     * Find the first mapped variable at the current object level (not descending into arrays)
     */
    private findFirstVariableAtLevel(obj: unknown, mappedColumns: string[]): string | null {
        if (!obj || typeof obj !== 'object') return null;

        const variablePattern = /\{\{([^}:]+)(?::[^}]+)?\}\}/;

        for (const [, value] of Object.entries(obj as Record<string, unknown>)) {
            if (Array.isArray(value)) continue;

            if (typeof value === 'string') {
                const match = value.match(variablePattern);
                if (match) {
                    const varName = match[1].trim();
                    if (!varName.startsWith('A8:') && !varName.startsWith('ENV:') && mappedColumns.includes(varName)) {
                        return varName;
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                const found = this.findFirstVariableAtLevel(value, mappedColumns);
                if (found) return found;
            }
        }

        return null;
    }

    /**
     * Find the first mapped variable within a specific array level of the template
     */
    private findFirstVariableInArrayPath(
        template: unknown,
        targetArrayPath: string,
        mappedColumns: string[]
    ): string | null {
        const pathParts = targetArrayPath.split('.');
        let current: unknown = template;

        for (const part of pathParts) {
            if (!current) return null;

            const key = part.replace('[]', '');

            if (key === '') {
                if (Array.isArray(current) && current.length > 0) {
                    current = current[0];
                } else {
                    return null;
                }
            } else if (typeof current === 'object' && current !== null) {
                const obj = current as Record<string, unknown>;
                if (key in obj) {
                    const value = obj[key];
                    if (Array.isArray(value) && value.length > 0) {
                        current = value[0];
                    } else {
                        current = value;
                    }
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }

        return this.findFirstVariableAtLevel(current, mappedColumns);
    }

    /**
     * Determine which columns should be used for sorting based on template structure.
     * Uses parent-level grouping columns, excludes leaf-level variables.
     */
    private determineSortColumns(
        template: unknown,
        mappedColumns: string[],
        arrayPaths: string[],
        variableToColumn?: Record<string, string>
    ): string[] {
        const sortColumns: string[] = [];
        const addedColumns = new Set<string>();

        // Step 1: Root-level variable — groups rows for the outermost array
        const rootVariable = this.findFirstVariableAtLevel(template, mappedColumns);
        if (rootVariable) {
            const columnName = variableToColumn?.[rootVariable] || rootVariable;
            if (!addedColumns.has(columnName)) {
                sortColumns.push(columnName);
                addedColumns.add(columnName);
            }
        }

        // Step 2: For intermediate arrays (exclude the deepest/leaf),
        // the variable inside that array groups rows for the next nested array
        const nonLeafArrayPaths = arrayPaths.slice(0, -1);
        for (const arrayPath of nonLeafArrayPaths) {
            const firstVariable = this.findFirstVariableInArrayPath(template, arrayPath, mappedColumns);
            if (firstVariable) {
                const columnName = variableToColumn?.[firstVariable] || firstVariable;
                if (!addedColumns.has(columnName)) {
                    sortColumns.push(columnName);
                    addedColumns.add(columnName);
                }
            }
        }

        return sortColumns;
    }

    analyzeNestedArrayRequirements(
        templateBody: string,
        mappedColumns: string[],
        variableToColumn?: Record<string, string>
    ): NestedArraySortAnalysis {
        const result: NestedArraySortAnalysis = {
            requiresSorting: false,
            sortColumns: [],
            explanation: '',
            arrayPaths: []
        };

        if (!templateBody || templateBody.trim() === '') {
            return result;
        }

        try {
            const parsed = JSON.parse(templateBody);
            const arrayPaths = this.findNestedArrayPaths(parsed);

            const nestedArrays = arrayPaths.filter(p => p.includes('[]'));
            if (nestedArrays.length === 0) {
                return result;
            }

            result.arrayPaths = nestedArrays;

            const sortColumns = this.determineSortColumns(parsed, mappedColumns, nestedArrays, variableToColumn);

            if (sortColumns.length > 0) {
                result.requiresSorting = true;
                result.sortColumns = sortColumns;
                result.explanation = `Data should be sorted by "${sortColumns.join(' → ')}" to ensure rows are grouped correctly.`;
            }

            return result;
        } catch {
            return result;
        }
    }

    /**
     * Parse CSV content into headers and rows
     */
    private parseCSV(csvContent: string): {
        headers: string[];
        rows: string[][];
        delimiter: string;
    } {
        const lines = csvContent.split('\n').filter(line => line.trim().length > 0);

        if (lines.length === 0) {
            return { headers: [], rows: [], delimiter: ',' };
        }

        const firstLine = lines[0];
        const tabCount = (firstLine.match(/\t/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        const delimiter = tabCount > 0 && tabCount >= commaCount ? '\t' : ',';

        const headers = this.parseCSVLine(firstLine, delimiter);
        const rows = lines.slice(1).map(line => this.parseCSVLine(line, delimiter));

        return { headers, rows, delimiter };
    }

    /**
     * Parse a single CSV line handling quoted values
     */
    private parseCSVLine(line: string, delimiter: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());

        return result;
    }

    /**
     * Build CSV content from headers and rows
     */
    private buildCSV(headers: string[], rows: string[][], delimiter: string): string {
        const escapeCell = (cell: string): string => {
            if (cell.includes(delimiter) || cell.includes('"') || cell.includes('\n')) {
                return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
        };

        const headerLine = headers.map(escapeCell).join(delimiter);
        const dataLines = rows.map(row => row.map(escapeCell).join(delimiter));

        return [headerLine, ...dataLines].join('\n');
    }

    /**
     * Check if CSV content is already sorted by the specified columns.
     * Uses hierarchical checking — each column is only checked within its parent group.
     */
    isDataSorted(csvContent: string, sortColumns: string[]): SortCheckResult {
        if (!csvContent || sortColumns.length === 0) {
            return { isSorted: true };
        }

        const { headers, rows } = this.parseCSV(csvContent);
        const columnIndices = sortColumns.map(col => headers.indexOf(col)).filter(i => i >= 0);

        if (columnIndices.length === 0) {
            return { isSorted: true };
        }

        const unsortedSample: { rowIndex: number; value: string }[] = [];

        for (let i = 1; i < rows.length; i++) {
            const currRow = rows[i];

            for (let colPos = 0; colPos < columnIndices.length; colPos++) {
                const colIndex = columnIndices[colPos];
                const prevValue = rows[i - 1][colIndex] || '';
                const currValue = currRow[colIndex] || '';

                if (prevValue !== currValue) {
                    // Check if currValue appeared in an earlier row within the SAME parent group
                    for (let j = 0; j < i - 1; j++) {
                        let sameParentGroup = true;
                        for (let pk = 0; pk < colPos; pk++) {
                            if (rows[j][columnIndices[pk]] !== currRow[columnIndices[pk]]) {
                                sameParentGroup = false;
                                break;
                            }
                        }

                        if (sameParentGroup && rows[j][colIndex] === currValue) {
                            unsortedSample.push({
                                rowIndex: i + 1,
                                value: currValue
                            });

                            if (unsortedSample.length >= 3) {
                                return {
                                    isSorted: false,
                                    firstUnsortedRow: i + 1,
                                    unsortedSample
                                };
                            }
                            break;
                        }
                    }
                }
            }
        }

        if (unsortedSample.length > 0) {
            return {
                isSorted: false,
                firstUnsortedRow: unsortedSample[0].rowIndex,
                unsortedSample
            };
        }

        return { isSorted: true };
    }

    sortCSVData(csvContent: string, sortColumns: string[]): string {
        if (!csvContent || sortColumns.length === 0) {
            return csvContent;
        }

        const { headers, rows, delimiter } = this.parseCSV(csvContent);
        const columnIndices = sortColumns.map(col => headers.indexOf(col)).filter(i => i >= 0);

        if (columnIndices.length === 0) {
            return csvContent;
        }

        const sortedRows = [...rows].sort((a, b) => {
            for (const colIndex of columnIndices) {
                const aVal = a[colIndex] || '';
                const bVal = b[colIndex] || '';
                const comparison = aVal.localeCompare(bVal);
                if (comparison !== 0) {
                    return comparison;
                }
            }
            return 0;
        });

        return this.buildCSV(headers, sortedRows, delimiter);
    }

    getSortingExplanation(sortColumns: string[], arrayPaths: string[]): string {
        const columnList = sortColumns.join(', ');
        return `Data should be sorted by "${columnList}" to ensure rows are grouped correctly for nested array generation.`;
    }
}

describe('CSVSortingService', () => {
    let service: CSVSortingTestHelper;

    beforeEach(() => {
        service = new CSVSortingTestHelper();
    });

    describe('analyzeNestedArrayRequirements', () => {
        it('should return no sorting required for simple template', () => {
            const template = `{
                "name": "{{NAME}}",
                "value": "{{VALUE:number}}"
            }`;
            const mappedColumns = ['NAME', 'VALUE'];

            const result = service.analyzeNestedArrayRequirements(template, mappedColumns);

            expect(result.requiresSorting).to.be.false;
            expect(result.sortColumns).to.deep.equal([]);
        });

        it('should detect nested arrays requiring sorting', () => {
            const template = `{
                "orderId": "{{ORDER_ID}}",
                "items": [
                    {
                        "sku": "{{SKU}}",
                        "qty": "{{QTY:number}}"
                    }
                ]
            }`;
            const mappedColumns = ['ORDER_ID', 'SKU', 'QTY'];

            const result = service.analyzeNestedArrayRequirements(template, mappedColumns);

            expect(result.requiresSorting).to.be.true;
            expect(result.sortColumns).to.include('ORDER_ID');
            expect(result.sortColumns).to.not.include('SKU');
            expect(result.arrayPaths.length).to.be.greaterThan(0);
        });

        it('should use variableToColumn mapping to return CSV column name', () => {
            const template = `{
                "orderId": "{{ORDER_ID}}",
                "items": [
                    {
                        "sku": "{{SKU}}",
                        "qty": "{{QTY:number}}"
                    }
                ]
            }`;
            const mappedColumns = ['ORDER_ID', 'SKU', 'QTY'];
            const variableToColumn = {
                'ORDER_ID': 'ShipmentID',
                'SKU': 'ItemSKU',
                'QTY': 'Quantity'
            };

            const result = service.analyzeNestedArrayRequirements(template, mappedColumns, variableToColumn);

            expect(result.requiresSorting).to.be.true;
            // Should return the CSV column name, not the variable name
            expect(result.sortColumns).to.include('ShipmentID');
            expect(result.sortColumns).to.not.include('ORDER_ID');
        });

        it('should return no sorting for empty template', () => {
            const result = service.analyzeNestedArrayRequirements('', []);

            expect(result.requiresSorting).to.be.false;
        });

        it('should handle invalid JSON gracefully', () => {
            const result = service.analyzeNestedArrayRequirements('not valid json', ['COL']);

            expect(result.requiresSorting).to.be.false;
        });

        it('should exclude leaf-level variables from sort columns (3-level template)', () => {
            const template = `{
                "shipmentId": "{{ShipmentID}}",
                "carrier": "{{Carrier}}",
                "packages": [
                    {
                        "packageId": "{{PackageID}}",
                        "weight": "{{Weight}}",
                        "items": [
                            {
                                "sku": "{{SKU}}",
                                "qty": "{{Qty}}"
                            }
                        ]
                    }
                ]
            }`;
            const mappedColumns = ['ShipmentID', 'Carrier', 'PackageID', 'Weight', 'SKU', 'Qty'];

            const result = service.analyzeNestedArrayRequirements(template, mappedColumns);

            expect(result.requiresSorting).to.be.true;
            expect(result.sortColumns).to.include('ShipmentID');
            expect(result.sortColumns).to.include('PackageID');
            expect(result.sortColumns).to.not.include('SKU');
            expect(result.sortColumns).to.not.include('Qty');
        });

        it('should return sort columns in hierarchical order (root first)', () => {
            const template = `{
                "shipmentId": "{{ShipmentID}}",
                "packages": [
                    {
                        "packageId": "{{PackageID}}",
                        "items": [
                            {
                                "sku": "{{SKU}}"
                            }
                        ]
                    }
                ]
            }`;
            const mappedColumns = ['ShipmentID', 'PackageID', 'SKU'];

            const result = service.analyzeNestedArrayRequirements(template, mappedColumns);

            expect(result.sortColumns).to.deep.equal(['ShipmentID', 'PackageID']);
        });
    });

    describe('isDataSorted', () => {
        it('should return true for already sorted data', () => {
            const csvContent = `ORDER_ID,SKU,QTY
ORD001,SKU-A,5
ORD001,SKU-B,3
ORD002,SKU-C,2
ORD002,SKU-D,1`;

            const result = service.isDataSorted(csvContent, ['ORDER_ID']);

            expect(result.isSorted).to.be.true;
        });

        it('should detect unsorted data', () => {
            const csvContent = `ORDER_ID,SKU,QTY
ORD001,SKU-A,5
ORD002,SKU-B,3
ORD001,SKU-C,2
ORD002,SKU-D,1`;

            const result = service.isDataSorted(csvContent, ['ORDER_ID']);

            expect(result.isSorted).to.be.false;
            expect(result.firstUnsortedRow).to.exist;
        });

        it('should return true for empty content', () => {
            const result = service.isDataSorted('', ['COL']);

            expect(result.isSorted).to.be.true;
        });

        it('should return true when sort columns not in headers', () => {
            const csvContent = `COL_A,COL_B
val1,val2
val3,val4`;

            const result = service.isDataSorted(csvContent, ['NONEXISTENT']);

            expect(result.isSorted).to.be.true;
        });

        it('should check hierarchically — same child value in different parent groups is OK', () => {
            // CARTON1 appears under both ABC and XYZ — this is correctly grouped
            const csvContent = `ShipmentID,Carrier,PackageID,Weight,SKU,Qty
ABC,TOLL,CARTON1,12,A,12
ABC,TOLL,CARTON1,12,B,11
ABC,TOLL,CARTON2,1,AA,1
ABC,TOLL,CARTON2,1,BB,1
ABC,TOLL,CARTON2,1,C,1
XYZ,LINFOX,CARTON1,33,A,1
XYZ,LINFOX,CARTON1,33,B,2
XYZ,LINFOX,CARTON1,33,C,3
XYZ,LINFOX,CARTON1,33,D,2`;

            const result = service.isDataSorted(csvContent, ['ShipmentID', 'PackageID']);

            expect(result.isSorted).to.be.true;
        });

        it('should detect unsorted data within a parent group', () => {
            // CARTON1, CARTON2, CARTON1 under the same ShipmentID — ungrouped
            const csvContent = `ShipmentID,PackageID,SKU,Qty
ABC,CARTON1,A,12
ABC,CARTON2,AA,1
ABC,CARTON1,B,11
XYZ,CARTON1,A,1`;

            const result = service.isDataSorted(csvContent, ['ShipmentID', 'PackageID']);

            expect(result.isSorted).to.be.false;
        });

        it('should detect unsorted root-level grouping', () => {
            // ABC, XYZ, ABC — root level is ungrouped
            const csvContent = `ShipmentID,PackageID,SKU
ABC,CARTON1,A
XYZ,CARTON1,B
ABC,CARTON2,C`;

            const result = service.isDataSorted(csvContent, ['ShipmentID', 'PackageID']);

            expect(result.isSorted).to.be.false;
        });
    });

    describe('sortCSVData', () => {
        it('should sort CSV by specified column', () => {
            const csvContent = `ORDER_ID,SKU,QTY
ORD002,SKU-B,3
ORD001,SKU-A,5
ORD002,SKU-D,1
ORD001,SKU-C,2`;

            const result = service.sortCSVData(csvContent, ['ORDER_ID']);

            const lines = result.split('\n').filter(l => l.trim());
            expect(lines[0]).to.include('ORDER_ID');
            expect(lines[1]).to.include('ORD001');
            expect(lines[2]).to.include('ORD001');
            expect(lines[3]).to.include('ORD002');
            expect(lines[4]).to.include('ORD002');
        });

        it('should handle tab-delimited content', () => {
            const csvContent = `ORDER_ID\tSKU\tQTY
ORD002\tSKU-B\t3
ORD001\tSKU-A\t5`;

            const result = service.sortCSVData(csvContent, ['ORDER_ID']);

            const lines = result.split('\n').filter(l => l.trim());
            expect(lines[1]).to.include('ORD001');
            expect(lines[2]).to.include('ORD002');
        });

        it('should return original content when sort column not found', () => {
            const csvContent = `COL_A,COL_B
val2,b
val1,a`;

            const result = service.sortCSVData(csvContent, ['NONEXISTENT']);

            expect(result).to.equal(csvContent);
        });

        it('should handle quoted values with commas', () => {
            const csvContent = `ORDER_ID,DESCRIPTION,QTY
ORD002,"Item, with comma",3
ORD001,"Simple item",5`;

            const result = service.sortCSVData(csvContent, ['ORDER_ID']);

            const lines = result.split('\n').filter(l => l.trim());
            expect(lines[1]).to.include('ORD001');
            expect(lines[2]).to.include('ORD002');
            expect(lines[2]).to.include('"Item, with comma"');
        });
    });

    describe('getSortingExplanation', () => {
        it('should return explanation text', () => {
            const explanation = service.getSortingExplanation(
                ['ORDER_ID'],
                ['items[]']
            );

            expect(explanation).to.include('ORDER_ID');
            expect(explanation.length).to.be.greaterThan(20);
        });

        it('should handle multiple sort columns', () => {
            const explanation = service.getSortingExplanation(
                ['CUSTOMER', 'ORDER_ID'],
                ['orders[]', 'orders[].items[]']
            );

            expect(explanation).to.include('CUSTOMER');
            expect(explanation).to.include('ORDER_ID');
        });
    });
});
