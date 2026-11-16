// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    ICSVSortingService,
    NestedArraySortAnalysis,
    SortCheckResult
} from './csv-sorting.interface';

/**
 * CSV Sorting Service Implementation
 * GitHub Issue #148: Sort CSV After Mapping with Opt-In
 *
 * Handles detection of nested array templates that require sorted CSV data,
 * analysis of sort requirements, and sorting the data (in memory; no host needed).
 */
export class CSVSortingService implements ICSVSortingService {
    /**
     * Analyze a JSON template body to determine if it has nested arrays
     * that require CSV data to be sorted for proper grouping
     */
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

            // If there are nested arrays (depth > 1), sorting may be required
            const nestedArrays = arrayPaths.filter(p => p.includes('[]'));
            if (nestedArrays.length === 0) {
                return result;
            }

            result.arrayPaths = nestedArrays;

            // Find the first-level grouping column
            // This is typically the column that identifies which parent record a row belongs to
            const sortColumns = this.determineSortColumns(parsed, mappedColumns, nestedArrays, variableToColumn);

            if (sortColumns.length > 0) {
                result.requiresSorting = true;
                result.sortColumns = sortColumns;
                result.explanation = this.buildExplanation(sortColumns, nestedArrays);
            }

            return result;
        } catch (error) {
            // Invalid JSON - return no sorting required
            return result;
        }
    }

    /**
     * Check if CSV content is already sorted by the specified columns.
     * Uses hierarchical checking — each column is only checked within its parent group.
     * E.g., PackageID is checked within each ShipmentID group, not globally.
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

            // Check each sort column hierarchically
            for (let colPos = 0; colPos < columnIndices.length; colPos++) {
                const colIndex = columnIndices[colPos];
                const prevValue = rows[i - 1][colIndex] || '';
                const currValue = currRow[colIndex] || '';

                if (prevValue !== currValue) {
                    // Check if currValue appeared in an earlier row within the SAME parent group
                    for (let j = 0; j < i - 1; j++) {
                        // Verify row j shares the same parent group (all preceding sort columns match)
                        let sameParentGroup = true;
                        for (let pk = 0; pk < colPos; pk++) {
                            if (rows[j][columnIndices[pk]] !== currRow[columnIndices[pk]]) {
                                sameParentGroup = false;
                                break;
                            }
                        }

                        if (sameParentGroup && rows[j][colIndex] === currValue) {
                            unsortedSample.push({
                                rowIndex: i + 1, // 1-indexed for user display
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

    /**
     * Sort CSV data by the specified columns
     */
    sortCSVData(csvContent: string, sortColumns: string[]): string {
        if (!csvContent || sortColumns.length === 0) {
            return csvContent;
        }

        const { headers, rows, delimiter } = this.parseCSV(csvContent);
        const columnIndices = sortColumns.map(col => headers.indexOf(col)).filter(i => i >= 0);

        if (columnIndices.length === 0) {
            return csvContent;
        }

        // Sort rows by the specified columns
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

        // Rebuild CSV with sorted rows
        return this.buildCSV(headers, sortedRows, delimiter);
    }

    /**
     * Get a human-readable explanation of why sorting is required
     */
    getSortingExplanation(sortColumns: string[], arrayPaths: string[]): string {
        const columnList = sortColumns.join(', ');
        const arrayList = arrayPaths.join(', ');

        return `Your template contains nested arrays (${arrayList}) that require rows to be grouped together by ${columnList}.

When generating JSON with nested arrays, the system groups consecutive rows with the same ${sortColumns[0]} value into array elements. If your data is not sorted, rows belonging to the same parent may be scattered throughout the file, resulting in:

• Duplicate parent records in the output
• Missing child items that belong together
• Incorrect data relationships

Sorting ensures all rows for each ${sortColumns[0]} are consecutive, allowing proper nesting.

Example:
Before sorting: Order1-Item1, Order2-Item1, Order1-Item2
After sorting:  Order1-Item1, Order1-Item2, Order2-Item1

The sorted data groups Order1's items together for correct JSON generation.`;
    }

    // ============================================
    // Private helper methods
    // ============================================

    /**
     * Find all array paths in a JSON template, including nested arrays
     */
    private findNestedArrayPaths(obj: unknown, currentPath: string = ''): string[] {
        const paths: string[] = [];

        if (Array.isArray(obj)) {
            const arrayPath = currentPath ? `${currentPath}[]` : '[]';
            paths.push(arrayPath);

            // Check first element for nested structures
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
     * Determine which columns should be used for sorting based on template structure
     * Returns the CSV COLUMN names (not variable names) so sorting can be applied to CSV data
     *
     * GitHub Issue #148: Sort by PARENT-level grouping columns, not leaf-level.
     * E.g., for root.packages[].items[], sort by ShipmentID (root) then PackageID (packages level).
     * The leaf array (items[]) doesn't need a sort column — those are individual entries.
     */
    private determineSortColumns(
        template: unknown,
        mappedColumns: string[],
        arrayPaths: string[],
        variableToColumn?: Record<string, string>
    ): string[] {
        const sortColumns: string[] = [];
        const addedColumns = new Set<string>();

        // A new request / array element starts when ANY variable at a level changes (the
        // grouping rule — see JsonGenerator.groupingColumnsFor), so sort on all of them.
        const addLevel = (variables: string[]) => {
            for (const variable of variables) {
                const columnName = variableToColumn?.[variable] || variable;
                if (!addedColumns.has(columnName)) {
                    sortColumns.push(columnName);
                    addedColumns.add(columnName);
                }
            }
        };

        // Step 1: Root-level variables — group rows for the outermost array.
        // Only when the root is an OBJECT: its fields are a header above the arrays inside
        // it. A root ARRAY (`[ { … } ]`) has no header — its element's fields are the rows
        // themselves, so there is nothing to group by and nothing to sort. If that element
        // holds a nested array it is a non-leaf level, and Step 2 picks its fields up.
        // Treating a flat root array's fields as a header is what made a plain bulk upload
        // say "Unsorted data detected. Sorted by: gtin → sku → …" and re-order the file.
        if (!Array.isArray(template)) {
            addLevel(this.findVariablesAtLevel(template, mappedColumns));
        }

        // Step 2: For intermediate arrays (exclude the deepest/leaf),
        // the variable inside that array groups rows for the next nested array
        const nonLeafArrayPaths = arrayPaths.slice(0, -1);
        for (const arrayPath of nonLeafArrayPaths) {
            addLevel(this.findVariablesInArrayPath(template, arrayPath, mappedColumns));
        }

        return sortColumns;
    }

    /**
     * Find every mapped variable within a specific array level of the template
     */
    private findVariablesInArrayPath(
        template: unknown,
        targetArrayPath: string,
        mappedColumns: string[]
    ): string[] {
        // Navigate to the array element at the specified path
        const pathParts = targetArrayPath.split('.');
        let current: unknown = template;

        for (const part of pathParts) {
            if (!current) return [];

            // Remove [] suffix for navigation
            const key = part.replace('[]', '');

            if (key === '') {
                // Root level array
                if (Array.isArray(current) && current.length > 0) {
                    current = current[0];
                } else {
                    return [];
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
                    return [];
                }
            } else {
                return [];
            }
        }

        // Every variable in this array element (but NOT in arrays nested inside it)
        return this.findVariablesAtLevel(current, mappedColumns);
    }

    /**
     * Find every mapped input variable at the current object level, in template order
     * (descends into nested objects, not into nested arrays — those are their own level).
     */
    private findVariablesAtLevel(obj: unknown, mappedColumns: string[]): string[] {
        if (!obj || typeof obj !== 'object') return [];

        const found: string[] = [];
        const variablePattern = /\{\{([^}:]+)(?::[^}]+)?\}\}/g;

        for (const value of Object.values(obj as Record<string, unknown>)) {
            // Skip nested arrays - each is its own level with its own sort columns
            if (Array.isArray(value)) continue;

            if (typeof value === 'string') {
                for (const match of value.matchAll(variablePattern)) {
                    const varName = match[1].trim();
                    // A8 (generated) and ENV (environment) variables are not data columns
                    if (varName.startsWith('A8') || varName.startsWith('ENV')) continue;
                    if (mappedColumns.includes(varName) && !found.includes(varName)) {
                        found.push(varName);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                for (const nested of this.findVariablesAtLevel(value, mappedColumns)) {
                    if (!found.includes(nested)) found.push(nested);
                }
            }
        }

        return found;
    }

    /**
     * Build an explanation message for why sorting is needed
     */
    private buildExplanation(sortColumns: string[], arrayPaths: string[]): string {
        const columnNames = sortColumns.join(' → ');
        return `Data should be sorted by "${columnNames}" to ensure rows are grouped correctly for nested array generation.`;
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

        // Detect delimiter (tab or comma)
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
                    // Escaped quote
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
}
