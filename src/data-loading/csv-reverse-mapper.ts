// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Reverse Mapper
 * 
 * Maps failed API response records back to original CSV rows using stored column mappings.
 * Supports array repetition scenarios where multiple CSV rows become single API transactions.
 * 
 * GitHub Issue #48: Enable tracing failed records back to CSV for batch error reporting.
 */

export interface ColumnMappingUsed {
    templateVariable: string;
    csvColumn: string;
    mappingType: 'csvColumn' | 'static' | 'template';
    dataType?: string;
}

export interface FailedRecord {
    [key: string]: any;
}

export interface ArrayRepetitionInfo {
    rowsPerTransaction: number;
    arrayPath?: string;
    enabled: boolean;
}

export interface CSVRowMapping {
    csvRowIndex: number;
    csvRowData: Record<string, string>;
    confidence: 'high' | 'medium' | 'low';
    matchedFields: string[];
    failedRecord: FailedRecord;
}

export interface ReverseMapResult {
    success: boolean;
    mappings: CSVRowMapping[];
    unmatchedRecords: FailedRecord[];
    errorMessage?: string;
}

/**
 * CSV Reverse Mapper Service
 * Maps failed API response records back to original CSV rows
 */
export class CSVReverseMapper {
    
    /**
     * Map failed records back to CSV rows using stored column mappings
     */
    public mapFailedRecordsToCSVRows(
        failedRecords: FailedRecord[],
        columnMappingsUsed: ColumnMappingUsed[],
        csvData: string[][],
        arrayRepetition?: ArrayRepetitionInfo
    ): ReverseMapResult {
        try {
            if (!failedRecords || failedRecords.length === 0) {
                return {
                    success: true,
                    mappings: [],
                    unmatchedRecords: []
                };
            }

            if (!csvData || csvData.length <= 1) {
                return {
                    success: false,
                    mappings: [],
                    unmatchedRecords: failedRecords,
                    errorMessage: 'No CSV data available for reverse mapping'
                };
            }

            // Extract headers and data rows
            const [headers, ...dataRows] = csvData;
            const csvRowObjects = this.convertCSVToObjects(headers, dataRows);

            // Create mapping lookup from template variables to CSV columns
            const mappingLookup = this.createMappingLookup(columnMappingsUsed);

            const mappings: CSVRowMapping[] = [];
            const unmatchedRecords: FailedRecord[] = [];

            // Process each failed record
            for (const failedRecord of failedRecords) {
                const csvMatches = this.findMatchingCSVRows(
                    failedRecord,
                    csvRowObjects,
                    mappingLookup,
                    arrayRepetition
                );

                if (csvMatches.length > 0) {
                    mappings.push(...csvMatches);
                } else {
                    unmatchedRecords.push(failedRecord);
                }
            }

            return {
                success: true,
                mappings,
                unmatchedRecords
            };

        } catch (error) {
            return {
                success: false,
                mappings: [],
                unmatchedRecords: failedRecords,
                errorMessage: error instanceof Error ? error.message : 'Unknown error in reverse mapping'
            };
        }
    }

    /**
     * Convert CSV arrays to objects with headers as keys
     */
    private convertCSVToObjects(headers: string[], dataRows: string[][]): Array<{ index: number; data: Record<string, string> }> {
        return dataRows.map((row, index) => ({
            index: index + 1, // +1 because we exclude header row
            data: headers.reduce((obj, header, i) => {
                obj[header] = row[i] || '';
                return obj;
            }, {} as Record<string, string>)
        }));
    }

    /**
     * Create lookup map from template variables to CSV columns
     */
    private createMappingLookup(columnMappingsUsed: ColumnMappingUsed[]): Record<string, string> {
        const lookup: Record<string, string> = {};
        
        for (const mapping of columnMappingsUsed) {
            if (mapping.mappingType === 'csvColumn' && mapping.csvColumn) {
                lookup[mapping.templateVariable] = mapping.csvColumn;
            }
        }
        
        return lookup;
    }

    /**
     * Find CSV rows that match a failed record
     */
    private findMatchingCSVRows(
        failedRecord: FailedRecord,
        csvRowObjects: Array<{ index: number; data: Record<string, string> }>,
        mappingLookup: Record<string, string>,
        arrayRepetition?: ArrayRepetitionInfo
    ): CSVRowMapping[] {
        const matches: CSVRowMapping[] = [];

        // Get mappable fields from mapping lookup - these may include nested paths
        const mappableFields = Object.keys(mappingLookup);

        if (mappableFields.length === 0) {
            // No mappable fields, can't match
            return matches;
        }

        // For each CSV row, calculate match score
        for (const csvRow of csvRowObjects) {
            const matchResult = this.calculateMatchScore(
                failedRecord,
                csvRow.data,
                mappableFields,
                mappingLookup
            );

            if (matchResult.score > 0) {
                matches.push({
                    csvRowIndex: csvRow.index,
                    csvRowData: csvRow.data,
                    confidence: this.determineConfidence(matchResult.score, mappableFields.length),
                    matchedFields: matchResult.matchedFields,
                    failedRecord
                });
            }
        }

        // Sort by confidence and match score
        matches.sort((a, b) => {
            const confidenceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
            return confidenceOrder[b.confidence] - confidenceOrder[a.confidence];
        });

        // If array repetition is enabled, limit to expected rows per transaction
        if (arrayRepetition?.enabled && arrayRepetition.rowsPerTransaction > 0) {
            return matches.slice(0, arrayRepetition.rowsPerTransaction);
        }

        return matches;
    }

    /**
     * Calculate how well a CSV row matches a failed record
     */
    private calculateMatchScore(
        failedRecord: FailedRecord,
        csvRowData: Record<string, string>,
        mappableFields: string[],
        mappingLookup: Record<string, string>
    ): { score: number; matchedFields: string[] } {
        let score = 0;
        const matchedFields: string[] = [];

        for (const field of mappableFields) {
            const csvColumn = mappingLookup[field];
            // Support nested field access (e.g., 'Data.ItemId')
            const failedValue = this.normalizeValue(this.getNestedValue(failedRecord, field));
            const csvValue = this.normalizeValue(csvRowData[csvColumn]);

            if (failedValue === csvValue) {
                score += 1;
                matchedFields.push(field);
            } else if (this.isPartialMatch(failedValue, csvValue)) {
                score += 0.5;
                matchedFields.push(`${field}~`); // ~ indicates partial match
            }
        }

        return { score, matchedFields };
    }

    /**
     * Get value from nested object path (e.g., 'Data.ItemId' from { Data: { ItemId: 'SKU123' } })
     */
    private getNestedValue(obj: any, path: string): any {
        // Handle array notation like 'Data.Allocations[0].Location'
        const cleanPath = path.replace(/\[(\d+)\]/g, '.$1');
        const parts = cleanPath.split('.');
        
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined) {
                return undefined;
            }
            current = current[part];
        }
        
        return current;
    }

    /**
     * Normalize values for comparison
     */
    private normalizeValue(value: any): string {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value).trim().toLowerCase();
    }

    /**
     * Check for partial matches (useful for formatted numbers, dates, etc.)
     */
    private isPartialMatch(value1: string, value2: string): boolean {
        if (!value1 || !value2) {
            return false;
        }

        // Remove common formatting characters
        const clean1 = value1.replace(/[,\s\-:]/g, '');
        const clean2 = value2.replace(/[,\s\-:]/g, '');

        // Check if one contains the other
        return clean1.includes(clean2) || clean2.includes(clean1);
    }

    /**
     * Determine confidence level based on match score
     */
    private determineConfidence(score: number, totalFields: number): 'high' | 'medium' | 'low' {
        const matchRatio = score / totalFields;

        if (matchRatio >= 0.8) {
            return 'high';
        } else if (matchRatio >= 0.5) {
            return 'medium';
        } else {
            return 'low';
        }
    }

    /**
     * Generate human-readable mapping report
     */
    public generateMappingReport(result: ReverseMapResult): string {
        if (!result.success) {
            return `❌ Reverse mapping failed: ${result.errorMessage}`;
        }

        const lines: string[] = [];
        
        lines.push(`📊 CSV Reverse Mapping Report`);
        lines.push(`═══════════════════════════════`);
        lines.push(`✅ Successfully mapped: ${result.mappings.length}`);
        lines.push(`❌ Unmatched records: ${result.unmatchedRecords.length}`);
        lines.push('');

        if (result.mappings.length > 0) {
            lines.push('📍 Failed Record → CSV Row Mappings:');
            lines.push('');

            for (const mapping of result.mappings) {
                const confidence = mapping.confidence.toUpperCase();
                const emoji = mapping.confidence === 'high' ? '🎯' : mapping.confidence === 'medium' ? '🔶' : '🔸';
                
                lines.push(`${emoji} CSV Row ${mapping.csvRowIndex} (${confidence} confidence)`);
                lines.push(`   Matched fields: ${mapping.matchedFields.join(', ')}`);
                lines.push(`   CSV data: ${JSON.stringify(mapping.csvRowData)}`);
                lines.push('');
            }
        }

        if (result.unmatchedRecords.length > 0) {
            lines.push('❓ Unmatched Failed Records:');
            lines.push('');
            for (const record of result.unmatchedRecords) {
                lines.push(`   ${JSON.stringify(record)}`);
            }
        }

        return lines.join('\n');
    }
}