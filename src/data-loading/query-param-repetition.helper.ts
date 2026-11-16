// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query Parameter Repetition Helper (GitHub Issue #108)
 *
 * Handles parsing and processing of repeatable query parameter syntax for bulk data extraction.
 * Syntax: pattern[ separator ]
 *
 * Examples:
 * - ItemId={{ITEM}}[ or ] → ItemId=val1 or ItemId=val2 or ItemId=val3
 * - ItemId={{ITEM}}[&]    → ItemId=val1&ItemId=val2&ItemId=val3
 * - status={{STATUS}}[,]  → status=active,status=pending,status=complete
 */

export interface ParsedQueryParam {
    isRepeatable: boolean;
    pattern?: string;
    separator?: string;
}

export interface IQueryParamRepetitionHelper {
    /**
     * Parse query parameter value to detect repeatable pattern syntax
     * @param value - Query parameter value (e.g., "ItemId={{ITEM}}[ or ]")
     * @returns Parsed pattern and separator, or isRepeatable=false
     */
    parseQueryParamPattern(value: string): ParsedQueryParam;

    /**
     * Extract template variables from a pattern
     * @param pattern - Pattern containing {{VAR}} placeholders
     * @returns Array of variable names
     */
    extractTemplateVariables(pattern: string): string[];

    /**
     * Calculate actual URL length for given parameters
     * @param baseUrl - Full base URL including path
     * @param pattern - Query parameter pattern with {{VAR}} placeholders
     * @param separator - Separator between repeated parameters
     * @param values - Array of values to substitute
     * @returns Total URL length in characters
     */
    calculateUrlLength(
        baseUrl: string,
        pattern: string,
        separator: string,
        values: string[]
    ): number;

    /**
     * Calculate maximum items per request based on URL length limit
     * @param baseUrl - Full base URL including path
     * @param pattern - Query parameter pattern
     * @param separator - Separator between items
     * @param sampleValue - Sample value from CSV for length calculation
     * @param maxUrlLength - Maximum allowed URL length (default: 2000)
     * @returns Maximum number of items that fit in URL length limit
     */
    calculateMaxItemsPerRequest(
        baseUrl: string,
        pattern: string,
        separator: string,
        sampleValue: string,
        maxUrlLength: number
    ): number;

    /**
     * Build repeating query string from pattern and values
     * @param pattern - Query parameter pattern with {{VAR}} placeholder
     * @param separator - Separator between repeated items
     * @param values - Array of values to substitute
     * @returns Built query string
     */
    buildRepeatingQueryString(
        pattern: string,
        separator: string,
        values: string[]
    ): string;

    /**
     * Group CSV rows into batches for batch execution
     * @param csvRows - Array of CSV row data
     * @param maxItemsPerRequest - Maximum items per request
     * @returns Array of row groups
     */
    groupCsvRowsForQueryParams(
        csvRows: string[][],
        maxItemsPerRequest: number
    ): string[][][];
}

export class QueryParamRepetitionHelper implements IQueryParamRepetitionHelper {

    parseQueryParamPattern(value: string): ParsedQueryParam {
        // Match pattern: anything[ separator ]
        // Regex: ^(.+?)\[([^\]]*)\]$
        // Group 1: pattern (everything before [)
        // Group 2: separator (everything between [ and ])
        const match = value.match(/^(.+?)\[([^\]]*)\]$/);

        if (!match) {
            return { isRepeatable: false };
        }

        const pattern = match[1].trim();
        const separator = match[2] || '&'; // Default to & if empty brackets

        return {
            isRepeatable: true,
            pattern,
            separator
        };
    }

    extractTemplateVariables(pattern: string): string[] {
        const regex = /\{\{([^}]+)\}\}/g;
        const variables: string[] = [];
        let match;

        while ((match = regex.exec(pattern)) !== null) {
            variables.push(match[1].trim());
        }

        return variables;
    }

    calculateUrlLength(
        baseUrl: string,
        pattern: string,
        separator: string,
        values: string[]
    ): number {
        if (values.length === 0) {
            return baseUrl.length + '?query='.length;
        }

        const queryString = this.buildRepeatingQueryString(pattern, separator, values);
        const fullUrl = `${baseUrl}?query=${queryString}`;

        return fullUrl.length;
    }

    calculateMaxItemsPerRequest(
        baseUrl: string,
        pattern: string,
        separator: string,
        sampleValue: string,
        maxUrlLength: number
    ): number {
        // Start with base URL overhead
        const baseLength = baseUrl.length + '?query='.length;
        const availableSpace = maxUrlLength - baseLength;

        // Calculate single item length (pattern with sample value + separator)
        // Extract template variable to replace
        const variables = this.extractTemplateVariables(pattern);
        let processedPattern = pattern;

        // Replace all template variables with sample value
        for (const variable of variables) {
            const regex = new RegExp(`\\{\\{${this.escapeRegex(variable)}\\}\\}`, 'g');
            processedPattern = processedPattern.replace(regex, sampleValue);
        }

        const singleItemLength = processedPattern.length + separator.length;

        // Calculate max items (accounting for last item not having separator)
        // Formula: (availableSpace + separator.length) / singleItemLength
        const maxItems = Math.floor((availableSpace + separator.length) / singleItemLength);

        // Always return at least 1 item
        return Math.max(1, maxItems);
    }

    buildRepeatingQueryString(
        pattern: string,
        separator: string,
        values: string[]
    ): string {
        if (values.length === 0) {
            return '';
        }

        // Extract template variables
        const variables = this.extractTemplateVariables(pattern);

        // Build query parts for each value
        const queryParts = values.map(value => {
            let processedPattern = pattern;

            // Replace all template variables with the value
            // For simplicity, we assume single variable or all variables get same value
            // TODO: Support multiple variables with column mapping
            for (const variable of variables) {
                const regex = new RegExp(`\\{\\{${this.escapeRegex(variable)}\\}\\}`, 'g');
                processedPattern = processedPattern.replace(regex, value);
            }

            return processedPattern;
        });

        // Join with separator
        return queryParts.join(separator);
    }

    groupCsvRowsForQueryParams(
        csvRows: string[][],
        maxItemsPerRequest: number
    ): string[][][] {
        const groups: string[][][] = [];

        for (let i = 0; i < csvRows.length; i += maxItemsPerRequest) {
            const group = csvRows.slice(i, i + maxItemsPerRequest);
            groups.push(group);
        }

        return groups;
    }

    /**
     * Escape special regex characters for safe string replacement
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
