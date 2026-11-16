// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Sorting Service Interface
 * GitHub Issue #148: Sort CSV After Mapping with Opt-In
 *
 * Handles detection of nested array templates that require sorted CSV data,
 * analysis of sort requirements, and creation of sorted CSV files with backups.
 */

/**
 * Result of analyzing a template for nested array sort requirements
 */
export interface NestedArraySortAnalysis {
    /** Whether the template has nested arrays that require sorted data */
    requiresSorting: boolean;
    /** The column(s) that data should be sorted by for proper nesting */
    sortColumns: string[];
    /** Human-readable explanation of why sorting is needed */
    explanation: string;
    /** The array paths that require grouping (e.g., "orders[].items[]") */
    arrayPaths: string[];
}

/**
 * Result of checking if CSV data is already sorted
 */
export interface SortCheckResult {
    /** Whether the data is already sorted by the required columns */
    isSorted: boolean;
    /** If not sorted, the first row index where sort order is violated */
    firstUnsortedRow?: number;
    /** Sample of the out-of-order values for debugging */
    unsortedSample?: { rowIndex: number; value: string }[];
}

/**
 * Result of sorting CSV data and creating backup
 */
/**
 * Interface for CSV Sorting Service
 * Follows Architecture.md patterns for service design
 */
export interface ICSVSortingService {
    /**
     * Analyze a JSON template body to determine if it has nested arrays
     * that require CSV data to be sorted for proper grouping
     *
     * @param templateBody - The JSON template body string
     * @param mappedColumns - Array of variable names that have been mapped to CSV columns
     * @param variableToColumn - Mapping from variable name to CSV column name (for sorting)
     * @returns Analysis result with sort requirements
     */
    analyzeNestedArrayRequirements(
        templateBody: string,
        mappedColumns: string[],
        variableToColumn?: Record<string, string>
    ): NestedArraySortAnalysis;

    /**
     * Check if CSV content is already sorted by the specified columns
     *
     * @param csvContent - The CSV content as a string (with headers)
     * @param sortColumns - Column names to check sort order for
     * @returns Result indicating if data is sorted
     */
    isDataSorted(
        csvContent: string,
        sortColumns: string[]
    ): SortCheckResult;

    /**
     * Sort CSV data by the specified columns
     *
     * @param csvContent - The CSV content as a string (with headers)
     * @param sortColumns - Column names to sort by (in order of priority)
     * @returns Sorted CSV content as a string
     */
    sortCSVData(
        csvContent: string,
        sortColumns: string[]
    ): string;

    /**
     * Get a human-readable explanation of why sorting is required
     * Used for the "Learn why" tooltip in the UI
     *
     * @param sortColumns - The columns being used for sorting
     * @param arrayPaths - The nested array paths in the template
     * @returns Explanation text
     */
    getSortingExplanation(
        sortColumns: string[],
        arrayPaths: string[]
    ): string;
}
