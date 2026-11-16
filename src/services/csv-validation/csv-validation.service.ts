// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { 
    ICSVValidationService, 
    ValidationResult, 
    DetailedValidationResult, 
    CellValidationResult, 
    ErrorDetail, 
    ValidationStatistics, 
    ValidationOptions, 
    TemplateVariable,
    ColumnTypeInfo,
    SourceTypeValidationResult,
    ColumnValidationResult
} from './csv-validation.interface';

export class CSVValidationService implements ICSVValidationService {

    /**
     * Validate basic CSV structure (headers, format, etc.)
     */
    async validateStructure(csvData: string): Promise<ValidationResult> {
        try {
            // Check if data is empty
            if (!csvData || csvData.trim().length === 0) {
                return { isValid: false, error: 'CSV file is empty. Please provide a valid CSV file with headers and data.' };
            }

            // Split into lines
            const lines = csvData.trim().split('\n');
            
            if (lines.length < 2) {
                return { isValid: false, error: 'CSV file must contain at least a header row and one data row.' };
            }

            // Validate header row
            const headerRow = lines[0];
            if (!headerRow || headerRow.trim().length === 0) {
                return { isValid: false, error: 'CSV file must have a valid header row.' };
            }

            const headers = headerRow.split(',').map(h => h.trim().replace(/"/g, ''));
            if (headers.length === 0) {
                return { isValid: false, error: 'CSV header row must contain at least one column.' };
            }

            // Check for duplicate headers
            const uniqueHeaders = new Set(headers);
            if (uniqueHeaders.size !== headers.length) {
                return { isValid: false, error: 'CSV headers must be unique. Found duplicate column names.' };
            }

            // Parse data rows and validate structure
            const dataLines = lines.slice(1).filter(line => line.trim().length > 0);
            const expectedColumnCount = headers.length;
            
            // Check first 10 rows for structural consistency (performance optimization)
            for (let i = 0; i < Math.min(dataLines.length, 10); i++) {
                const row = dataLines[i];
                const values = row.split(',');
                
                if (values.length !== expectedColumnCount) {
                    return {
                        isValid: false,
                        error: `CSV structure error at row ${i + 2}: Expected ${expectedColumnCount} columns, found ${values.length}. Please ensure all rows have the same number of columns as the header.`
                    };
                }
            }

            // Check for minimum data requirement
            if (dataLines.length === 0) {
                return { isValid: false, error: 'CSV file must contain at least one data row.' };
            }

            // Additional validation for very large files
            // GitHub Issue #123: Use configurable max CSV rows setting
            const { dbmnSettings } = await import('../../platform/vscode/vscode-settings');
            const maxCsvRows = dbmnSettings().get<number>('dbmn.execution', 'maxCsvRows', 100000);   // #281

            if (dataLines.length > maxCsvRows) {
                return {
                    isValid: false,
                    error: `CSV file is too large (${dataLines.length.toLocaleString()} rows). Please limit to ${maxCsvRows.toLocaleString()} rows or fewer. You can adjust this limit in Settings > Dobermann > Execution > Max CSV Rows.`
                };
            }

            return { isValid: true };
            
        } catch (error) {
            return {
                isValid: false,
                error: `Failed to parse CSV structure: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * STAGE 1: Validate source data consistency within each column
     * Validates that all values in each column are consistent with the selected type
     * GitHub Issue #106: Supports sampling for preview mode to improve performance
     */
    validateSourceTypes(
        csvData: string,
        columnTypes: ColumnTypeInfo[],
        options: ValidationOptions = {}
    ): SourceTypeValidationResult {
        try {

            const opts = {
                maxRows: undefined,
                stopOnFirstError: false,
                collectAllErrors: true,
                maxErrorsToReport: 100,
                useSamplingForPreview: false, // GitHub Issue #106: Enable sampling for preview mode
                ...options
            };

            // Parse CSV data
            const lines = csvData.split('\n');
            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const dataLines = lines.slice(1).filter(line => line.trim().length > 0);

            if (dataLines.length === 0) {
                return { isValid: true, columnResults: [] };
            }

            // Validate each column's type consistency
            const columnResults: ColumnValidationResult[] = [];
            const warnings: string[] = [];
            let overallValid = true;

            // GitHub Issue #106: Use sampling if enabled (50 rows for preview, all rows for execution)
            const rowsToValidate = opts.useSamplingForPreview && !opts.maxRows
                ? Math.min(dataLines.length, 50)
                : (opts.maxRows ? Math.min(dataLines.length, opts.maxRows) : dataLines.length);

            for (const columnType of columnTypes) {
                const columnIndex = headers.indexOf(columnType.columnName);
                if (columnIndex === -1) {
                    continue;
                }

                const inconsistentRows: number[] = [];
                const sampleErrors: string[] = [];
                let errorCount = 0;

                // Validate each cell in this column
                for (let rowIndex = 0; rowIndex < rowsToValidate; rowIndex++) {
                    const row = dataLines[rowIndex];
                    const values = row.split(',').map(v => v.trim().replace(/"/g, ''));
                    const cellValue = values[columnIndex]?.trim() || '';
                    
                    // Skip empty values
                    if (!cellValue) continue;

                    const validationResult = this.validateCell(
                        cellValue, 
                        columnType.selectedType, 
                        columnType.columnName, 
                        rowIndex + 2
                    );
                    
                    if (!validationResult.isValid) {
                        inconsistentRows.push(rowIndex + 2);
                        errorCount++;
                        
                        if (sampleErrors.length < 3) {
                            sampleErrors.push(validationResult.error!);
                        }

                        if (opts.stopOnFirstError) {
                            break;
                        }
                    }
                }

                const isConsistent = errorCount === 0;
                if (!isConsistent) {
                    overallValid = false;
                }

                columnResults.push({
                    columnName: columnType.columnName,
                    selectedType: columnType.selectedType,
                    isConsistent,
                    inconsistentRows: inconsistentRows.length > 0 ? inconsistentRows : undefined,
                    errorCount,
                    sampleErrors: sampleErrors.length > 0 ? sampleErrors : undefined
                });

                if (opts.stopOnFirstError && !isConsistent) {
                    break;
                }
            }

            // Generate error message if there are inconsistencies
            let errorMessage: string | undefined;
            if (!overallValid) {
                const failedColumns = columnResults.filter(r => !r.isConsistent);
                const totalErrors = failedColumns.reduce((sum, col) => sum + (col.errorCount || 0), 0);
                
                errorMessage = `Source data type inconsistencies found in ${failedColumns.length} column(s) with ${totalErrors} total error(s):\n\n`;
                
                failedColumns.slice(0, 3).forEach(col => {
                    errorMessage += `Column '${col.columnName}' (${col.selectedType}): ${col.errorCount} error(s)\n`;
                    if (col.sampleErrors && col.sampleErrors.length > 0) {
                        errorMessage += `  Sample: ${col.sampleErrors[0]}\n`;
                    }
                });
                
                if (failedColumns.length > 3) {
                    errorMessage += `\n... and ${failedColumns.length - 3} more column(s) with errors.`;
                }
                
                errorMessage += '\nPlease review your type selections or fix the source data.';
            }

            
            return {
                isValid: overallValid,
                error: errorMessage,
                warnings: warnings.length > 0 ? warnings : undefined,
                columnResults
            };

        } catch (error) {
            return {
                isValid: false,
                error: `Source type validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                columnResults: []
            };
        }
    }

    /**
     * STAGE 2: Validate mapping compatibility between column types and template variables
     */
    validateMappingCompatibility(
        columnTypes: ColumnTypeInfo[],
        variables: TemplateVariable[]
    ): DetailedValidationResult {
        try {
            
            const errors: string[] = [];
            const warnings: string[] = [];
            const errorDetails: ErrorDetail[] = [];
            
            // Check only mapped variables that require specific data types
            const mappedVariables = variables.filter(v => v.mapped && v.column && v.dataType !== 'string');
            
            if (mappedVariables.length === 0) {
                return { isValid: true };
            }

            for (const variable of mappedVariables) {
                const columnType = columnTypes.find(ct => ct.columnName === variable.column);
                
                if (!columnType) {
                    warnings.push(`Template variable '${variable.name}' mapped to column '${variable.column}' but no type information found`);
                    continue;
                }

                // Check type compatibility
                const isCompatible = this.isTypeCompatible(columnType.selectedType, variable.dataType);
                
                if (!isCompatible) {
                    const errorMsg = `Template variable '${variable.name}' expects type '${variable.dataType}' but column '${variable.column}' has selected type '${columnType.selectedType}'`;
                    errors.push(errorMsg);
                    
                    errorDetails.push({
                        row: -1, // Not row-specific
                        column: variable.column!,
                        value: columnType.selectedType,
                        expectedType: variable.dataType,
                        error: errorMsg
                    });
                }
            }

            const isValid = errors.length === 0;
            
            // Generate error summary
            let errorMessage: string | undefined;
            if (!isValid) {
                if (errors.length === 1) {
                    errorMessage = `Mapping compatibility error:\n\n${errors[0]}\n\nPlease adjust your column type selection or endpoint template.`;
                } else {
                    errorMessage = `Found ${errors.length} mapping compatibility error(s):\n\n`;
                    errorMessage += errors.slice(0, 3).join('\n\n');
                    
                    if (errors.length > 3) {
                        errorMessage += `\n\n... and ${errors.length - 3} more error(s).`;
                    }
                    
                    errorMessage += '\n\nPlease adjust your column type selections or endpoint template.';
                }
            }

            
            return {
                isValid,
                error: errorMessage,
                warnings: warnings.length > 0 ? warnings : undefined,
                errorDetails: errorDetails.length > 0 ? errorDetails : undefined
            };

        } catch (error) {
            return {
                isValid: false,
                error: `Mapping compatibility validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Check if a selected column type is compatible with a template variable type
     */
    private isTypeCompatible(selectedType: string, templateType: string): boolean {
        const selected = selectedType.toLowerCase();
        const template = templateType.toLowerCase();
        
        // Exact match
        if (selected === template) {
            return true;
        }
        
        // String can be converted to anything
        if (selected === 'string') {
            return true;
        }
        
        // Numeric type compatibility
        if (template === 'number' && (selected === 'currency' || selected === 'scientific')) {
            return true;
        }
        
        // Date/time compatibility
        if (template === 'date' && selected === 'datetime') {
            return true;
        }
        if (template === 'datetime' && selected === 'date') {
            return true; // Can be extended
        }
        
        return false;
    }

    /**
     * LEGACY: Validate data types against template variables with comprehensive error reporting
     * @deprecated Use validateSourceTypes + validateMappingCompatibility instead
     */
    validateDataTypes(
        csvData: string, 
        variables: TemplateVariable[], 
        headers: string[], 
        options: ValidationOptions = {}
    ): DetailedValidationResult {
        try {
            // Set default options
            const opts = {
                maxRows: undefined, // Validate ALL rows by default (removed 20-row limit!)
                stopOnFirstError: false,
                collectAllErrors: true,
                includeWarnings: true,
                maxErrorsToReport: 100, // Still limit UI display for performance
                ...options
            };

            // Parse CSV data
            const lines = csvData.split('\n');
            const dataLines = lines.slice(1).filter(line => line.trim().length > 0);
            
            if (dataLines.length === 0) {
                return { isValid: true }; // No data to validate
            }

            const warnings: string[] = [];
            const errors: string[] = [];
            const errorDetails: ErrorDetail[] = [];
            const errorsByColumn: Record<string, number> = {};
            const affectedRows: Set<number> = new Set();

            // Check only mapped variables that require specific data types
            const mappedVariables = variables.filter(v => v.mapped && v.column && v.dataType !== 'string');
            
            if (mappedVariables.length === 0) {
                return { isValid: true }; // No type-specific validation needed
            }

            // Determine how many rows to validate (ALL by default!)
            const rowsToValidate = opts.maxRows ? Math.min(dataLines.length, opts.maxRows) : dataLines.length;

            // Validate rows
            for (let rowIndex = 0; rowIndex < rowsToValidate; rowIndex++) {
                const row = dataLines[rowIndex];
                const values = row.split(',').map(v => v.trim().replace(/"/g, ''));

                for (const variable of mappedVariables) {
                    const columnIndex = headers.indexOf(variable.column!);
                    if (columnIndex === -1) continue;

                    const cellValue = values[columnIndex]?.trim() || '';
                    
                    // Skip empty values - they'll be handled during actual processing
                    if (!cellValue) continue;

                    const validationResult = this.validateCell(cellValue, variable.dataType, variable.name, rowIndex + 2);
                    
                    if (!validationResult.isValid) {
                        errors.push(validationResult.error!);
                        affectedRows.add(rowIndex + 2);
                        
                        // Track errors by column
                        if (!errorsByColumn[variable.column!]) {
                            errorsByColumn[variable.column!] = 0;
                        }
                        errorsByColumn[variable.column!]++;

                        // Store structured error details
                        errorDetails.push({
                            row: rowIndex + 2, // +2 because we're 0-based and skipping header
                            column: variable.column!,
                            value: cellValue,
                            expectedType: variable.dataType,
                            error: validationResult.error!
                        });

                        // Stop early if requested
                        if (opts.stopOnFirstError) {
                            break;
                        }

                        // Limit error collection for performance
                        if (errors.length >= opts.maxErrorsToReport!) {
                            break;
                        }
                        
                    } else if (validationResult.warning && opts.includeWarnings) {
                        warnings.push(validationResult.warning);
                    }
                }

                // Break out of row loop if stopping on first error
                if (opts.stopOnFirstError && errors.length > 0) {
                    break;
                }

                // Break if we've hit the max errors to collect
                if (errors.length >= opts.maxErrorsToReport!) {
                    break;
                }
            }

            // Create statistics
            const statistics: ValidationStatistics = {
                totalRows: dataLines.length,
                validatedRows: rowsToValidate,
                errorCount: errorDetails.length,
                warningCount: warnings.length,
                errorsByColumn,
                affectedRows: Array.from(affectedRows).sort((a, b) => a - b)
            };

            // Return results
            if (errors.length > 0) {
                const errorSummary = this.generateErrorSummary(errors, errorDetails, statistics);

                return {
                    isValid: false,
                    error: errorSummary,
                    errorDetails: errorDetails,
                    statistics: statistics,
                    warnings: warnings.length > 0 ? warnings : undefined
                };
            }

            return {
                isValid: true,
                warnings: warnings.length > 0 ? warnings : undefined,
                statistics: statistics
            };

        } catch (error) {
            return {
                isValid: false,
                error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Generate a comprehensive error summary message
     */
    private generateErrorSummary(errors: string[], errorDetails: ErrorDetail[], statistics: ValidationStatistics): string {
        const totalErrors = errorDetails.length;
        const affectedRows = statistics.affectedRows.length;
        const columnsWithErrors = Object.keys(statistics.errorsByColumn);
        
        if (totalErrors === 1) {
            return `Data type validation error:\n\n${errors[0]}\n\nPlease fix this data type mismatch before proceeding.`;
        }

        const displayedErrors = Math.min(errors.length, 3);
        const hiddenErrors = Math.max(0, totalErrors - displayedErrors);
        
        let summary = `Found ${totalErrors} data type validation error${totalErrors > 1 ? 's' : ''} in ${affectedRows} row${affectedRows > 1 ? 's' : ''} across ${columnsWithErrors.length} column${columnsWithErrors.length > 1 ? 's' : ''}:\n\n`;
        
        // Show first few errors
        summary += errors.slice(0, displayedErrors).join('\n\n');
        
        if (hiddenErrors > 0) {
            summary += `\n\n... and ${hiddenErrors} more error${hiddenErrors > 1 ? 's' : ''}.`;
        }
        
        if (statistics.validatedRows < statistics.totalRows) {
            summary += `\n\nNote: Validated first ${statistics.validatedRows} of ${statistics.totalRows} rows.`;
        }
        
        summary += '\n\nPlease fix these data type mismatches before proceeding.';
        
        return summary;
    }

    /**
     * Validate a single cell value against expected data type
     */
    validateCell(value: string, expectedType: string, variableName: string, rowNumber: number): CellValidationResult {
        switch (expectedType.toLowerCase()) {
            case 'number':
                const num = Number(value);
                if (isNaN(num)) {
                    return {
                        isValid: false,
                        error: `Row ${rowNumber}: Variable "${variableName}" expects a number, but found "${value}". Please ensure all values in this column are valid numbers.`
                    };
                }
                return { isValid: true };

            case 'boolean':
                const booleanValue = value.toLowerCase();
                const validBooleans = ['true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 'on', 'off'];
                if (!validBooleans.includes(booleanValue)) {
                    return {
                        isValid: false,
                        error: `Row ${rowNumber}: Variable "${variableName}" expects a boolean value (true/false, yes/no, 1/0), but found "${value}". Valid values: ${validBooleans.join(', ')}.`
                    };
                }
                return { isValid: true };

            case 'date':
                try {
                    const date = new Date(value);
                    if (isNaN(date.getTime())) {
                        return {
                            isValid: false,
                            error: `Row ${rowNumber}: Variable "${variableName}" expects a valid date, but found "${value}". Please use a standard date format (e.g., YYYY-MM-DD, MM/DD/YYYY).`
                        };
                    }

                    // Check for reasonable date range (1900-2100)
                    const year = date.getFullYear();
                    if (year < 1900 || year > 2100) {
                        return {
                            isValid: false,
                            error: `Row ${rowNumber}: Variable "${variableName}" has an unreasonable date "${value}". Please use dates between 1900 and 2100.`
                        };
                    }

                    return { isValid: true };
                } catch (error) {
                    return {
                        isValid: false,
                        error: `Row ${rowNumber}: Variable "${variableName}" expects a valid date, but found "${value}". Please use a standard date format.`
                    };
                }

            default:
                // For 'string' type or unknown types, everything is valid
                return { isValid: true };
        }
    }

    /**
     * Parse CSV data and return row count and structure info
     */
    parseCSVInfo(csvData: string): { totalRows: number; headers: string[]; hasData: boolean; isEmpty: boolean } {
        if (!csvData || csvData.trim().length === 0) {
            return { totalRows: 0, headers: [], hasData: false, isEmpty: true };
        }

        const lines = csvData.trim().split('\n');
        const headers = lines.length > 0 ? lines[0].split(',').map(h => h.trim().replace(/"/g, '')) : [];
        const dataLines = lines.slice(1).filter(line => line.trim().length > 0);

        return {
            totalRows: dataLines.length,
            headers: headers,
            hasData: dataLines.length > 0,
            isEmpty: false
        };
    }
}