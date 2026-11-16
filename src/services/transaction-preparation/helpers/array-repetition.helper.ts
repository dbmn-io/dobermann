// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Configuration for array repetition analysis
 */
export interface ArrayRepetitionConfig {
    /** Array configurations from batch config */
    repeatableArrays?: Array<{
        enabled: boolean;
        maxRepetitions: number;
        fieldName: string;
    }>;

    /** Whether to detect and process arrays */
    detectArrays?: boolean;

    /** Override: specific number of rows per transaction */
    rowsPerTransaction?: number;

    /** GitHub Issue #119: CSV grouping by field values */
    groupByColumns?: string[];

    /** Maximum number of rows per group when using CSV grouping */
    maxGroupSize?: number;
}

/**
 * Result of array repetition analysis
 */
export interface ArrayRepetitionAnalysis {
    /** Whether array repetition is enabled/applicable */
    enabled: boolean;
    
    /** Total number of CSV data rows (excluding header) */
    totalRows: number;
    
    /** Number of rows to group per transaction */
    rowsPerTransaction: number;
    
    /** Total number of transactions that will be created */
    transactionCount: number;
    
    /** Maximum repetitions allowed for arrays */
    maxRepetitions?: number;
    
    /** Whether the configuration has array fields */
    hasArrayFields: boolean;
}

/**
 * Helper service for analyzing and calculating array repetition logic
 * Determines how many CSV rows should be grouped into each transaction
 */
export interface IArrayRepetitionHelper {
    /**
     * Analyze CSV data and configuration to determine grouping
     * Returns analysis showing how many transactions will be created
     */
    analyzeArrayRepetition(
        csvData: string[][],
        config?: ArrayRepetitionConfig
    ): Promise<ArrayRepetitionAnalysis>;

    /**
     * Group CSV rows into transaction chunks based on analysis
     * Returns array of row groups, each group becomes one transaction
     */
    groupRowsForTransactions(
        csvData: string[][],
        analysis: ArrayRepetitionAnalysis
    ): string[][][];

    /**
     * GitHub Issue #119: Group CSV rows by field values (denormalized CSV support)
     * Detects when grouping column values change and creates separate groups
     * @param csvData - CSV data including header row
     * @param groupByColumns - Column names to group by (e.g., ["PO", "Store"])
     * @param maxGroupSize - Optional maximum rows per group (splits large groups)
     * @returns Array of row groups, each group becomes one transaction
     */
    groupRowsByFieldValues(
        csvData: string[][],
        groupByColumns: string[],
        maxGroupSize?: number
    ): string[][][];
}

/**
 * Implementation of array repetition helper
 * Reuses logic from existing BatchPreparationService
 */
export class ArrayRepetitionHelper implements IArrayRepetitionHelper {
    
    async analyzeArrayRepetition(
        csvData: string[][],
        config?: ArrayRepetitionConfig
    ): Promise<ArrayRepetitionAnalysis> {
        const totalRows = csvData.length - 1; // Exclude header row


        // Handle empty data
        if (totalRows <= 0) {
            return {
                enabled: false,
                totalRows: 0,
                rowsPerTransaction: 1,
                transactionCount: 0,
                hasArrayFields: this.hasArrayConfig(config)
            };
        }

        // GitHub Issue #119: Check for CSV grouping configuration
        if (config?.groupByColumns && config.groupByColumns.length > 0) {
            const groups = this.groupRowsByFieldValues(
                csvData,
                config.groupByColumns,
                config.maxGroupSize
            );

            return {
                enabled: true,
                totalRows,
                rowsPerTransaction: groups.length > 0 ? Math.ceil(totalRows / groups.length) : 1,
                transactionCount: groups.length,
                hasArrayFields: true,
                maxRepetitions: config.maxGroupSize
            };
        }
        
        // Check if override is provided
        if (config?.rowsPerTransaction && config.rowsPerTransaction > 0) {
            const transactionCount = Math.ceil(totalRows / config.rowsPerTransaction);
            return {
                enabled: true,
                totalRows,
                rowsPerTransaction: config.rowsPerTransaction,
                transactionCount,
                maxRepetitions: config.rowsPerTransaction,
                hasArrayFields: true
            };
        }
        
        // Check if array repetition is configured - FIXED: More permissive condition
        if (!config || (!config.detectArrays && !config.repeatableArrays)) {
            return {
                enabled: false,
                totalRows,
                rowsPerTransaction: 1,
                transactionCount: totalRows,
                hasArrayFields: false
            };
        }
        
        // Check for repeatable arrays
        if (!config.repeatableArrays || config.repeatableArrays.length === 0) {
            return {
                enabled: false,
                totalRows,
                rowsPerTransaction: 1,
                transactionCount: totalRows,
                hasArrayFields: false
            };
        }
        
        const enabledArrays = config.repeatableArrays.filter(arr => 
            arr.enabled && arr.maxRepetitions > 0
        );
        
        
        if (enabledArrays.length === 0) {
            return {
                enabled: false,
                totalRows,
                rowsPerTransaction: 1,
                transactionCount: totalRows,
                hasArrayFields: false
            };
        }
        
        // Use minimum maxRepetitions for most conservative grouping
        const maxRepetitions = Math.min(...enabledArrays.map(arr => arr.maxRepetitions));
        
        // rowsPerTransaction should never exceed available rows
        const rowsPerTransaction = Math.min(totalRows, maxRepetitions);
        const transactionCount = Math.ceil(totalRows / rowsPerTransaction);
        
        return {
            enabled: true,
            totalRows,
            rowsPerTransaction,
            transactionCount,
            maxRepetitions,
            hasArrayFields: true
        };
    }
    
    groupRowsForTransactions(
        csvData: string[][],
        analysis: ArrayRepetitionAnalysis
    ): string[][][] {
        if (csvData.length <= 1) {
            return []; // No data rows to group
        }

        const header = csvData[0];
        const dataRows = csvData.slice(1);
        const groups: string[][][] = [];

        // Group rows according to analysis
        for (let i = 0; i < dataRows.length; i += analysis.rowsPerTransaction) {
            const rowGroup = dataRows.slice(i, i + analysis.rowsPerTransaction);
            // Include header with each group
            groups.push([header, ...rowGroup]);
        }

        return groups;
    }

    /**
     * GitHub Issue #119: Group CSV rows by field values (denormalized CSV support)
     *
     * This implements a streaming algorithm that detects when grouping column values
     * change and creates separate groups. This allows denormalized CSV data to be
     * normalized into nested JSON structures.
     *
     * Algorithm:
     * 1. Read row 1 - Extract grouping column values (e.g., PO=123, Store=100)
     * 2. Start new group with these values
     * 3. Read row 2 - Compare grouping column values
     * 4. If SAME → Add row to current group
     * 5. If DIFFERENT → Emit current group, start new group
     * 6. Repeat for all rows
     *
     * Example:
     * CSV Input:
     *   PO,Store,Item,Qty
     *   123,100,A,5
     *   123,100,B,3      ← Same PO+Store, add to group
     *   456,200,C,2      ← Different PO, emit group, start new
     *
     * Output: 2 groups
     *   Group 1: [header, row1, row2] (PO=123, Store=100)
     *   Group 2: [header, row3]       (PO=456, Store=200)
     *
     * @param csvData - CSV data including header row
     * @param groupByColumns - Column names to group by (e.g., ["PO", "Store"])
     * @param maxGroupSize - Optional maximum rows per group (splits large groups)
     * @returns Array of row groups, each group becomes one transaction
     */
    groupRowsByFieldValues(
        csvData: string[][],
        groupByColumns: string[],
        maxGroupSize?: number
    ): string[][][] {
        if (csvData.length <= 1) {
            return []; // No data rows to group
        }

        if (!groupByColumns || groupByColumns.length === 0) {
            throw new Error('groupByColumns must be specified for CSV grouping');
        }

        const header = csvData[0];
        const dataRows = csvData.slice(1);

        // Find column indices for grouping columns
        const columnIndices = groupByColumns.map(colName => {
            const index = header.indexOf(colName);
            if (index === -1) {
                throw new Error(`Column '${colName}' not found in CSV header. Available columns: ${header.join(', ')}`);
            }
            return index;
        });

        // Gather rows by key. Equal keys are collected wherever they sit in the file: a group
        // must never depend on its rows happening to be adjacent. (GitHub Issue #147 sorts
        // the data first, which keeps each group's rows contiguous for display — but
        // correctness does not hang on it.) Groups come out in order of first appearance.
        //
        // Values are compared TRIMMED — "Acme " and "Acme" are the same header — but case is
        // kept, so "ACME" becomes its own, visible, group rather than being filed under "Acme".
        const KEY_SEPARATOR = '\u0001'; // cannot occur in a CSV cell, unlike '|'
        const gathered = new Map<string, string[][]>();
        for (const row of dataRows) {
            const rowGroupKey = columnIndices
                .map(idx => (row[idx] ?? '').trim())
                .join(KEY_SEPARATOR);
            const existing = gathered.get(rowGroupKey);
            if (existing) {
                existing.push(row);
            } else {
                gathered.set(rowGroupKey, [row]);
            }
        }

        const groups: string[][][] = [];
        for (const rows of gathered.values()) {
            if (maxGroupSize && maxGroupSize > 0) {
                // Split an over-large group into chunks; each chunk is its own transaction.
                for (let i = 0; i < rows.length; i += maxGroupSize) {
                    groups.push([header, ...rows.slice(i, i + maxGroupSize)]);
                }
            } else {
                groups.push([header, ...rows]);
            }
        }

        return groups;
    }

    /**
     * Check if configuration has array field definitions
     */
    private hasArrayConfig(config?: ArrayRepetitionConfig): boolean {
        return !!(
            config?.detectArrays &&
            config?.repeatableArrays &&
            config.repeatableArrays.some(arr => arr.enabled)
        );
    }
}