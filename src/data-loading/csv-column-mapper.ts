// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Column Mapper for Data Loading
 * 
 * This module handles CSV parsing, column mapping to template variables,
 * data validation, and row processing for the data loading feature.
 */

import { DataType } from './types';
import { TemplateVariable } from './template-parser';

export type MappingType = 'csvColumn' | 'static' | 'template';

export interface ColumnMapping {
    variableName: string;
    dataType: DataType;
    mappingType: MappingType;
    csvColumn?: string;        // For csvColumn type
    staticValue?: string;      // For static type
    templateValue?: string;    // For template type
    isRequired: boolean;
}

export interface CSVPreview {
    isValid: boolean;
    headers: string[];
    rows: string[][];
    previewRows: string[][];   // Limited to first 5 rows
    totalRows: number;
    error?: string;
}

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    validRows?: number;
    errorRows?: number;
}

export interface ProcessedRow {
    isValid: boolean;
    values: Record<string, string>;
    error?: string;
}

export class CSVColumnMapper {
    private readonly MAX_PREVIEW_ROWS = 5;

    /**
     * Parse CSV text and create preview
     */
    parseCSVPreview(csvText: string): CSVPreview {
        if (!csvText || csvText.trim() === '') {
            return {
                isValid: false,
                headers: [],
                rows: [],
                previewRows: [],
                totalRows: 0,
                error: 'CSV data is empty'
            };
        }

        try {
            const rows = this.parseCSVText(csvText);
            
            if (rows.length === 0) {
                return {
                    isValid: false,
                    headers: [],
                    rows: [],
                    previewRows: [],
                    totalRows: 0,
                    error: 'CSV data is empty'
                };
            }

            const headers = rows[0];
            const dataRows = rows.slice(1);

            // Validate consistent column count
            const expectedColumns = headers.length;
            for (let i = 0; i < dataRows.length; i++) {
                if (dataRows[i].length !== expectedColumns) {
                    return {
                        isValid: false,
                        headers: [],
                        rows: [],
                        previewRows: [],
                        totalRows: 0,
                        error: `Inconsistent number of columns in row ${i + 2}. Expected ${expectedColumns}, got ${dataRows[i].length}`
                    };
                }
            }

            const previewRows = dataRows.slice(0, this.MAX_PREVIEW_ROWS);

            return {
                isValid: true,
                headers,
                rows: dataRows,
                previewRows,
                totalRows: dataRows.length
            };
        } catch (error) {
            return {
                isValid: false,
                headers: [],
                rows: [],
                previewRows: [],
                totalRows: 0,
                error: `CSV parsing error: ${error}`
            };
        }
    }

    /**
     * Create automatic mapping based on column names and template variables
     */
    createAutoMapping(templateVariables: TemplateVariable[], csvColumns: string[]): ColumnMapping[] {
        const mapping: ColumnMapping[] = [];

        for (const variable of templateVariables) {
            const matchedColumn = this.findBestColumnMatch(variable.name, csvColumns);
            
            if (matchedColumn) {
                mapping.push({
                    variableName: variable.name,
                    dataType: variable.dataType,
                    mappingType: 'csvColumn',
                    csvColumn: matchedColumn,
                    isRequired: true
                });
            } else {
                mapping.push({
                    variableName: variable.name,
                    dataType: variable.dataType,
                    mappingType: 'static',
                    staticValue: '',
                    isRequired: true
                });
            }
        }

        return mapping;
    }

    /**
     * Update mapping configuration
     */
    updateMapping(
        mapping: ColumnMapping[], 
        variableName: string, 
        newType: MappingType, 
        config: Partial<ColumnMapping>
    ): ColumnMapping[] {
        return mapping.map(m => {
            if (m.variableName === variableName) {
                return {
                    ...m,
                    mappingType: newType,
                    csvColumn: newType === 'csvColumn' || newType === 'template' ? config.csvColumn : undefined,
                    staticValue: newType === 'static' ? config.staticValue : undefined,
                    templateValue: newType === 'template' ? config.templateValue : undefined
                };
            }
            return m;
        });
    }

    /**
     * Validate mapping configuration
     */
    validateMapping(mapping: ColumnMapping[], csvColumns: string[]): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Track used CSV columns
        const usedColumns = new Set<string>();

        for (const map of mapping) {
            // Check required mappings have values
            if (map.isRequired) {
                if (map.mappingType === 'static' && (!map.staticValue || map.staticValue.trim() === '')) {
                    errors.push(`Required variable ${map.variableName} has no value configured`);
                }
                
                if (map.mappingType === 'csvColumn' && !map.csvColumn) {
                    errors.push(`Required variable ${map.variableName} has no CSV column mapped`);
                }
                
                if (map.mappingType === 'template' && (!map.templateValue || !map.csvColumn)) {
                    errors.push(`Required variable ${map.variableName} has incomplete template configuration`);
                }
            }

            // Check CSV columns exist
            if (map.mappingType === 'csvColumn' && map.csvColumn) {
                if (!csvColumns.includes(map.csvColumn)) {
                    errors.push(`CSV column ${map.csvColumn} not found in uploaded file`);
                } else {
                    usedColumns.add(map.csvColumn);
                }
            }

            if (map.mappingType === 'template' && map.csvColumn) {
                if (!csvColumns.includes(map.csvColumn)) {
                    errors.push(`CSV column ${map.csvColumn} not found in uploaded file`);
                } else {
                    usedColumns.add(map.csvColumn);
                }
            }

            // Validate template syntax
            if (map.mappingType === 'template' && map.templateValue) {
                const templateErrors = this.validateTemplateValue(map.templateValue, csvColumns);
                errors.push(...templateErrors.map(err => `Template variable ${err} in ${map.variableName} template not found in CSV columns`));
            }

            // Validate static values for data type compatibility
            if (map.mappingType === 'static' && map.staticValue) {
                if (!this.isValidValueForDataType(map.staticValue, map.dataType)) {
                    errors.push(`Static value "${map.staticValue}" for ${map.variableName} is not a valid ${map.dataType}`);
                }
            }
        }

        // Check for unused CSV columns
        for (const column of csvColumns) {
            if (!usedColumns.has(column)) {
                warnings.push(`CSV column ${column} is not used in mapping`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Validate CSV data against mapping configuration
     */
    validateCSVData(csvData: string[][], mapping: ColumnMapping[]): ValidationResult {
        if (csvData.length === 0) {
            return {
                isValid: false,
                errors: ['No CSV data to validate'],
                warnings: [],
                validRows: 0,
                errorRows: 0
            };
        }

        const headers = csvData[0];
        const dataRows = csvData.slice(1);
        const errors: string[] = [];
        let validRows = 0;
        let errorRows = 0;

        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
            const row = dataRows[rowIndex];
            const rowData: Record<string, string> = {};
            
            // Convert row to object
            headers.forEach((header, colIndex) => {
                rowData[header] = row[colIndex] || '';
            });

            let hasRowError = false;

            // Validate each mapping for this row
            for (const map of mapping) {
                if (map.mappingType === 'csvColumn' && map.csvColumn) {
                    const value = rowData[map.csvColumn];
                    if (!this.isValidValueForDataType(value, map.dataType)) {
                        errors.push(`Row ${rowIndex + 1}, Column ${map.csvColumn}: Invalid ${map.dataType} value "${value}"`);
                        hasRowError = true;
                    }
                }
            }

            if (hasRowError) {
                errorRows++;
            } else {
                validRows++;
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings: [],
            validRows,
            errorRows
        };
    }

    /**
     * Process a single CSV row according to mapping configuration
     */
    processCSVRow(csvRow: Record<string, string>, mapping: ColumnMapping[]): ProcessedRow {
        const values: Record<string, string> = {};

        for (const map of mapping) {
            try {
                let value: string;

                switch (map.mappingType) {
                    case 'csvColumn':
                        if (!map.csvColumn) {
                            return { isValid: false, values: {}, error: `No CSV column configured for ${map.variableName}` };
                        }
                        if (!(map.csvColumn in csvRow)) {
                            if (map.isRequired) {
                                return { isValid: false, values: {}, error: `Missing required column: ${map.csvColumn}` };
                            }
                            value = '';
                        } else {
                            value = csvRow[map.csvColumn];
                        }
                        break;

                    case 'static':
                        value = map.staticValue || '';
                        break;

                    case 'template':
                        if (!map.templateValue || !map.csvColumn) {
                            return { isValid: false, values: {}, error: `Incomplete template configuration for ${map.variableName}` };
                        }
                        if (!(map.csvColumn in csvRow)) {
                            return { isValid: false, values: {}, error: `Missing template column: ${map.csvColumn}` };
                        }
                        value = this.processTemplate(map.templateValue, csvRow);
                        break;

                    default:
                        return { isValid: false, values: {}, error: `Unknown mapping type for ${map.variableName}` };
                }

                values[map.variableName] = value;
            } catch (error) {
                return { isValid: false, values: {}, error: `Error processing ${map.variableName}: ${error}` };
            }
        }

        return { isValid: true, values };
    }

    private parseCSVText(csvText: string): string[][] {
        const rows: string[][] = [];
        const lines = csvText.split('\n');

        for (const line of lines) {
            if (line.trim() === '') continue;

            const row: string[] = [];
            let currentField = '';
            let inQuotes = false;
            let i = 0;

            while (i < line.length) {
                const char = line[i];

                if (char === '"' && !inQuotes) {
                    inQuotes = true;
                } else if (char === '"' && inQuotes) {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        // Escaped quote
                        currentField += '"';
                        i++; // Skip next quote
                    } else {
                        inQuotes = false;
                    }
                } else if (char === ',' && !inQuotes) {
                    row.push(currentField.trim());
                    currentField = '';
                } else {
                    currentField += char;
                }

                i++;
            }

            // Add the last field
            row.push(currentField.trim());
            rows.push(row);
        }

        return rows;
    }

    private findBestColumnMatch(variableName: string, csvColumns: string[]): string | undefined {
        const normalizedVariable = variableName.toUpperCase();

        // Exact match (case-insensitive)
        for (const column of csvColumns) {
            if (column.toUpperCase() === normalizedVariable) {
                return column;
            }
        }

        // Partial match
        for (const column of csvColumns) {
            const normalizedColumn = column.toUpperCase();
            if (normalizedColumn.includes(normalizedVariable) || normalizedVariable.includes(normalizedColumn)) {
                return column;
            }
        }

        // Similar patterns
        const variablePatterns = this.getSearchPatterns(normalizedVariable);
        for (const column of csvColumns) {
            const columnPatterns = this.getSearchPatterns(column.toUpperCase());
            for (const vPattern of variablePatterns) {
                if (columnPatterns.includes(vPattern)) {
                    return column;
                }
            }
        }

        return undefined;
    }

    private getSearchPatterns(name: string): string[] {
        const patterns = [name];
        
        // Remove common separators and try variations
        const withoutSeparators = name.replace(/[-_\s]/g, '');
        if (withoutSeparators !== name) {
            patterns.push(withoutSeparators);
        }

        // Add common abbreviations
        if (name.includes('QUANTITY') || name.includes('QTY')) {
            patterns.push('QTY', 'QUANTITY');
        }
        if (name.includes('LOCATION') || name.includes('LOC')) {
            patterns.push('LOC', 'LOCATION');
        }
        if (name.includes('SKU') || name.includes('ITEM')) {
            patterns.push('SKU', 'ITEM', 'ITEMID');
        }

        return patterns;
    }

    private validateTemplateValue(templateValue: string, csvColumns: string[]): string[] {
        const variables: string[] = [];
        const regex = /\{\{([^}]+)\}\}/g;
        let match;

        while ((match = regex.exec(templateValue)) !== null) {
            const variable = match[1].trim();
            if (!csvColumns.includes(variable)) {
                variables.push(variable);
            }
        }

        return variables;
    }

    private isValidValueForDataType(value: string, dataType: DataType): boolean {
        if (!value || value.trim() === '') {
            return true; // Empty values are allowed (will be handled as required/optional)
        }

        switch (dataType) {
            case 'string':
                return true;

            case 'number':
                const num = Number(value);
                return !isNaN(num) && isFinite(num);

            case 'boolean':
                const lowerValue = value.toLowerCase();
                return ['true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 'on', 'off'].includes(lowerValue);

            case 'date':
                try {
                    const date = new Date(value);
                    return !isNaN(date.getTime());
                } catch {
                    return false;
                }

            default:
                return true;
        }
    }

    private processTemplate(templateValue: string, csvRow: Record<string, string>): string {
        let result = templateValue;
        const regex = /\{\{([^}]+)\}\}/g;
        
        result = result.replace(regex, (match, variable) => {
            const trimmedVariable = variable.trim();
            return csvRow[trimmedVariable] || match; // Keep original if not found
        });

        return result;
    }
}