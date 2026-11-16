// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query Parameter Repetition Helper
 * GitHub Issue #108: Handles grouping CSV rows based on URL length limits
 * for repeated query parameters (e.g., itemId=val1 or val2 or val3)
 */

// Import shared query string builder (single source of truth)
import * as queryParamBuilderScript from '../../../webviews/shared/query-param-builder.js';
import { sharedScript } from '../../../utils/shared-script';
const queryParamBuilder = sharedScript<typeof queryParamBuilderScript>(queryParamBuilderScript, 'queryParamBuilder');

export interface QueryParamRepetitionConfig {
    enabled: boolean;
    paramKey: string;       // Actual URL query param key (e.g., "query")
    pattern: string;        // Value pattern (e.g., "itemId={{item}}")
    separator: string;      // e.g., " or "
    maxUrlLength: number;   // e.g., 2048
    maxPerRequest?: number; // Optional limit on values per request
}

export interface QueryParamRepetitionAnalysis {
    /** Whether query param repetition is enabled */
    enabled: boolean;

    /** Total number of CSV data rows */
    totalRows: number;

    /**
     * GitHub Issue #224: Number of CSV data rows actually placed into a query
     * group. Rows with an empty/blank value for the repeated variable are
     * skipped; when includedRowCount < totalRows some input items were dropped.
     */
    includedRowCount: number;

    /** Variable name extracted from pattern (e.g., "item" from "{{item}}") */
    variableName: string;

    /** Query parameter key for URL (e.g., "query" from config.paramKey) */
    queryParamKey: string;

    /** Total number of transactions that will be created */
    transactionCount: number;

    /** Row groups with their computed query strings */
    rowGroups: Array<{
        rows: string[][];
        queryString: string;  // e.g., "itemId=val1 or itemId=val2 or itemId=val3" (VALUE only, not including paramKey)
    }>;
}

/**
 * Helper for grouping CSV rows based on query parameter URL length limits
 */
export class QueryParamRepetitionHelper {

    /**
     * Analyze CSV data and calculate how to group rows based on URL length
     * @param csvData Full CSV data (header + rows)
     * @param config Query param repetition configuration
     * @param columnMappings Column mappings to find which CSV column contains the values
     * @returns Analysis with row groupings and computed query strings
     */
    async analyzeQueryParamRepetition(
        csvData: string[][],
        config: QueryParamRepetitionConfig,
        columnMappings?: Record<string, string>
    ): Promise<QueryParamRepetitionAnalysis> {

        const totalRows = csvData.length - 1; // Exclude header

        if (!config.enabled || totalRows <= 0) {
            return {
                enabled: false,
                totalRows: 0,
                includedRowCount: 0,
                variableName: '',
                queryParamKey: '',
                transactionCount: 0,
                rowGroups: []
            };
        }

        // GitHub Issue #108: paramKey comes from config, pattern is for VALUE building only
        // Example: paramKey="query", pattern="itemId={{item}}", separator=" or "
        // Result URL: ?query=itemId=ITM001 or itemId=ITM002
        const queryParamKey = config.paramKey;
        const variableName = this.extractVariableName(config.pattern);

        if (!variableName) {
            throw new Error(`Invalid query param pattern: ${config.pattern}. Expected format: "someKey={{variable}}"`);
        }

        // Find which CSV column contains the values for this variable
        const csvColumn = columnMappings?.[variableName];

        if (!csvColumn) {
            throw new Error(`No column mapping found for variable: ${variableName}`);
        }

        const header = csvData[0];
        const columnIndex = header.indexOf(csvColumn);

        if (columnIndex === -1) {
            throw new Error(`CSV column not found: ${csvColumn}`);
        }

        // Group rows based on URL length limits
        const rowGroups = this.groupRowsByUrlLength(
            csvData,
            columnIndex,
            config.pattern,
            variableName,
            config.separator,
            config.maxUrlLength,
            config.maxPerRequest
        );

        // GitHub Issue #224: Count the rows actually grouped (each group is
        // [header, ...dataRows]) so the caller can verify every input item was
        // included and warn when blank values caused rows to be dropped.
        const includedRowCount = rowGroups.reduce((sum, g) => sum + (g.rows.length - 1), 0);

        return {
            enabled: true,
            totalRows,
            includedRowCount,
            variableName,
            queryParamKey,
            transactionCount: rowGroups.length,
            rowGroups
        };
    }

    /**
     * Extract variable name from pattern
     * GitHub Issue #108: Pattern is for VALUE building only, paramKey comes from config
     * Example: "itemId={{item}}" → "item"
     */
    private extractVariableName(pattern: string): string {
        // Pattern format: "anything{{variableName}}anything"
        const match = pattern.match(/{{([^}]+)}}/);

        if (!match) {
            return '';
        }

        return match[1].trim();
    }

    /**
     * Group CSV rows based on URL length limits
     * Each group will become one transaction with repeated query param values
     *
     * GitHub Issue #170: Optimized with incremental length calculation
     * Instead of rebuilding the query string for every row (O(n²)), we calculate
     * the length mathematically and only build the final string when needed.
     */
    private groupRowsByUrlLength(
        csvData: string[][],
        columnIndex: number,
        pattern: string,
        variableName: string,
        separator: string,
        maxUrlLength: number,
        maxPerRequest?: number
    ): Array<{ rows: string[][]; queryString: string }> {

        const header = csvData[0];
        const dataRows = csvData.slice(1);
        const groups: Array<{ rows: string[][]; queryString: string }> = [];

        let currentGroup: string[][] = [];
        let currentValues: string[] = [];

        // GitHub Issue #170: Pre-calculate pattern base length for O(1) length estimation
        // Pattern "itemId={{item}}" with variable "item" → base is "itemId=" (pattern minus "{{item}}")
        const variablePlaceholder = `{{${variableName}}}`;
        const patternBaseLength = pattern.length - variablePlaceholder.length;
        const separatorLength = separator.length;

        // Track current estimated length instead of rebuilding string each time
        let currentEstimatedLength = 0;

        for (const row of dataRows) {
            const value = row[columnIndex];

            if (!value || value.trim() === '') {
                continue; // Skip empty values
            }

            // GitHub Issue #170: O(1) length calculation instead of O(n) string rebuild
            // Each entry adds: separator (if not first) + patternBase + valueLength
            const valueLength = value.length;
            const addedLength = (currentValues.length === 0 ? 0 : separatorLength) + patternBaseLength + valueLength;
            const newEstimatedLength = currentEstimatedLength + addedLength;

            // Check if adding this value would exceed limits
            const wouldExceedUrlLength = newEstimatedLength > maxUrlLength;
            const wouldExceedMaxPerRequest = maxPerRequest && (currentValues.length + 1) > maxPerRequest;

            if ((wouldExceedUrlLength || wouldExceedMaxPerRequest) && currentGroup.length > 0) {
                // Finalize current group - only build query string when needed
                const queryString = this.buildQueryString(pattern, variableName, currentValues, separator);
                groups.push({
                    rows: [header, ...currentGroup],
                    queryString
                });

                // Start new group with this row
                currentGroup = [row];
                currentValues = [value];
                // Reset length to just this first entry (no separator)
                currentEstimatedLength = patternBaseLength + valueLength;
            } else {
                // Add to current group
                currentGroup.push(row);
                currentValues.push(value);
                currentEstimatedLength = newEstimatedLength;
            }
        }

        // Add final group if it has data
        if (currentGroup.length > 0) {
            const queryString = this.buildQueryString(pattern, variableName, currentValues, separator);
            groups.push({
                rows: [header, ...currentGroup],
                queryString
            });
        }

        return groups;
    }

    /**
     * Build query string from values by applying pattern to each value
     * GitHub Issue #108: Uses shared query-param-builder module for consistency with frontend
     * Example: buildQueryString("itemId={{item}}", "item", ["val1", "val2"], " or ")
     *          → "itemId=val1 or itemId=val2"
     */
    private buildQueryString(pattern: string, variableName: string, values: string[], separator: string): string {
        // Use shared builder to ensure frontend and backend produce same results
        return queryParamBuilder.buildQueryString(pattern, variableName, values, separator);
    }
}
