// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformation Service Implementation
 * Transforms data values between different detected types with comprehensive support
 * 
 * Following Architecture.md patterns:
 * - Service implements interface for DI compatibility
 * - Separation of concerns with specific transformation methods
 * - Comprehensive error handling and logging
 */

import { BOOLEAN_FALSE, BOOLEAN_TRUE } from '../../data-loading/boolean-words';
import { 
    IDataTransformationService,
    ValueTransformationResult,
    BatchTransformationResult,
    ColumnTransformationConfig,
    FileTransformationConfig
} from './data-transformation.interface';
import { DetectedDataType } from '../data-type-detection/data-type-detection.interface';

export class DataTransformationService implements IDataTransformationService {

    /**
     * Transform a single value from source type to target type
     */
    async transformValue(
        value: string,
        sourceType: DetectedDataType,
        targetType: DetectedDataType,
        options: any = {}
    ): Promise<ValueTransformationResult> {
        
        if (!value || !value.trim()) {
            // Empty values typically remain empty
            return {
                originalValue: value,
                transformedValue: '',
                success: true,
                sourceType,
                targetType
            };
        }

        try {
            const trimmedValue = value.trim();
            let transformedValue = '';
            let metadata: any = {};

            // Leading zeros are an identifier (a GTIN, a GLN), kept as written whatever the column was detected as
            // (an unsigned 00012345600012 reads as COBOL): the request's own #218 rule, which this ran ahead of at
            // Execute, so the number 12345600012 was sent (2026-11-25). A signed COBOL value (+000099.99) still converts
            if (targetType === DetectedDataType.NUMBER && /^0\d+/.test(trimmedValue)) {
                return { originalValue: value, transformedValue: trimmedValue, success: true, sourceType, targetType };
            }

            switch (sourceType) {
                case DetectedDataType.COBOL_NUMBER:
                    const cobolResult = await this.transformCobolNumber(trimmedValue, targetType, options);
                    transformedValue = cobolResult.value;
                    metadata = cobolResult.metadata;
                    break;

                case DetectedDataType.CURRENCY:
                    const currencyResult = await this.transformCurrency(trimmedValue, targetType, options);
                    transformedValue = currencyResult.value;
                    metadata = currencyResult.metadata;
                    break;

                case DetectedDataType.SCIENTIFIC:
                    const scientificResult = await this.transformScientific(trimmedValue, targetType, options);
                    transformedValue = scientificResult.value;
                    break;

                case DetectedDataType.BOOLEAN:
                    const booleanResult = await this.transformBoolean(trimmedValue, targetType, options);
                    transformedValue = booleanResult.value;
                    break;

                case DetectedDataType.DATETIME:
                    const dateTimeResult = await this.transformDateTime(trimmedValue, targetType, options);
                    transformedValue = dateTimeResult.value;
                    metadata = dateTimeResult.metadata;
                    break;

                case DetectedDataType.DATE:
                    const dateResult = await this.transformDate(trimmedValue, targetType, options);
                    transformedValue = dateResult.value;
                    break;

                case DetectedDataType.NUMBER:
                    const numberResult = await this.transformNumber(trimmedValue, targetType, options);
                    transformedValue = numberResult.value;
                    break;

                case DetectedDataType.ARRAY:
                    const arrayResult = await this.transformArray(trimmedValue, targetType, options);
                    transformedValue = arrayResult.value;
                    break;

                case DetectedDataType.STRING:
                default:
                    const stringResult = await this.transformString(trimmedValue, targetType, options);
                    transformedValue = stringResult.value;
                    break;
            }

            return {
                originalValue: value,
                transformedValue,
                success: true,
                sourceType,
                targetType,
                metadata: Object.keys(metadata).length > 0 ? metadata : undefined
            };

        } catch (error) {
            return {
                originalValue: value,
                transformedValue: value,
                success: false,
                sourceType,
                targetType,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Transform multiple values for a single column
     */
    async transformColumn(
        values: string[],
        config: ColumnTransformationConfig
    ): Promise<BatchTransformationResult> {
        
        const results: ValueTransformationResult[] = [];
        let successCount = 0;
        let errorCount = 0;

        for (const value of values) {
            const result = await this.transformValue(
                value,
                config.sourceType,
                config.targetType,
                config.options
            );

            results.push(result);

            if (result.success) {
                successCount++;
            } else {
                errorCount++;
            }
        }

        const successRate = values.length > 0 ? successCount / values.length : 1;

        return {
            totalProcessed: values.length,
            successCount,
            errorCount,
            results,
            successRate
        };
    }

    /**
     * Transform entire CSV data based on column configurations
     */
    async transformFile(
        csvData: string,
        config: FileTransformationConfig
    ): Promise<string> {
        
        try {
            // Parse CSV data
            const lines = csvData.split('\n');
            if (lines.length < 2) {
                throw new Error('CSV must contain at least header and data rows');
            }

            const headers = this.parseCSVLine(lines[0]);
            const dataLines = lines.slice(1);

            // Create column mapping for transformations
            const columnTransformMap = new Map<number, ColumnTransformationConfig>();
            config.columns.forEach(columnConfig => {
                const columnIndex = headers.indexOf(columnConfig.columnName);
                if (columnIndex >= 0) {
                    columnTransformMap.set(columnIndex, columnConfig);
                }
            });

            // Transform data rows
            const transformedLines = [lines[0]]; // Keep original header

            for (const line of dataLines) {
                if (!line.trim()) {
                    transformedLines.push(line); // Keep empty lines
                    continue;
                }

                const values = this.parseCSVLine(line);
                const transformedValues: string[] = [];

                for (let i = 0; i < values.length; i++) {
                    const value = values[i];
                    const transformConfig = columnTransformMap.get(i);

                    if (transformConfig) {
                        // Apply transformation
                        const result = await this.transformValue(
                            value,
                            transformConfig.sourceType,
                            transformConfig.targetType,
                            transformConfig.options
                        );

                        if (result.success) {
                            transformedValues.push(result.transformedValue);
                        } else {
                            // Handle transformation errors based on config
                            if (config.globalOptions?.failOnErrors) {
                                throw new Error(`Transformation failed for column ${transformConfig.columnName}: ${result.error}`);
                            } else {
                                // Keep original value on error
                                transformedValues.push(value);
                            }
                        }
                    } else {
                        // No transformation config, keep original value
                        transformedValues.push(value);
                    }
                }

                // Convert back to CSV line
                const transformedLine = this.formatCSVLine(transformedValues);
                transformedLines.push(transformedLine);
            }

            return transformedLines.join('\n');

        } catch (error) {
            throw new Error(`File transformation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Validate if transformation between types is supported
     */
    isTransformationSupported(
        sourceType: DetectedDataType,
        targetType: DetectedDataType
    ): boolean {
        
        // Define supported transformation matrix
        const supportedTransformations = new Map<DetectedDataType, DetectedDataType[]>([
            [DetectedDataType.STRING, [DetectedDataType.STRING, DetectedDataType.NUMBER, DetectedDataType.BOOLEAN, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.NUMBER, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.COBOL_NUMBER, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.CURRENCY, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.SCIENTIFIC, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.BOOLEAN, [DetectedDataType.STRING, DetectedDataType.BOOLEAN, DetectedDataType.NUMBER]],
            [DetectedDataType.DATE, [DetectedDataType.STRING, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.DATETIME, [DetectedDataType.STRING, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.ARRAY, [DetectedDataType.STRING, DetectedDataType.ARRAY]]
        ]);

        const supportedTargets = supportedTransformations.get(sourceType);
        return supportedTargets?.includes(targetType) ?? false;
    }

    /**
     * Get available transformation paths from a source type
     */
    getSupportedTargetTypes(sourceType: DetectedDataType): DetectedDataType[] {
        const supportedTransformations = new Map<DetectedDataType, DetectedDataType[]>([
            [DetectedDataType.STRING, [DetectedDataType.STRING, DetectedDataType.NUMBER, DetectedDataType.BOOLEAN, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.NUMBER, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.COBOL_NUMBER, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.CURRENCY, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.SCIENTIFIC, [DetectedDataType.STRING, DetectedDataType.NUMBER]],
            [DetectedDataType.BOOLEAN, [DetectedDataType.STRING, DetectedDataType.BOOLEAN, DetectedDataType.NUMBER]],
            [DetectedDataType.DATE, [DetectedDataType.STRING, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.DATETIME, [DetectedDataType.STRING, DetectedDataType.DATE, DetectedDataType.DATETIME]],
            [DetectedDataType.ARRAY, [DetectedDataType.STRING, DetectedDataType.ARRAY]]
        ]);

        return supportedTransformations.get(sourceType) ?? [DetectedDataType.STRING];
    }

    /**
     * Preview transformation for a sample value
     */
    async previewTransformation(
        value: string,
        sourceType: DetectedDataType,
        targetType: DetectedDataType,
        options: any = {}
    ): Promise<{ preview: string; error?: string }> {
        
        try {
            const result = await this.transformValue(value, sourceType, targetType, options);
            
            if (result.success) {
                return { preview: result.transformedValue };
            } else {
                return { preview: value, error: result.error };
            }
        } catch (error) {
            return { 
                preview: value, 
                error: error instanceof Error ? error.message : String(error) 
            };
        }
    }

    // Private transformation methods

    private async transformCobolNumber(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string; metadata?: any }> {
        
        // Parse COBOL number format: +000000001.0000
        const sign = value.startsWith('+') ? '+' : value.startsWith('-') ? '-' : '';
        const numberPart = value.replace(/^[+-]/, '');
        
        // Extract integer and decimal parts
        const decimalIndex = numberPart.indexOf('.');
        const integerPart = decimalIndex >= 0 ? numberPart.substring(0, decimalIndex) : numberPart;
        const decimalPart = decimalIndex >= 0 ? numberPart.substring(decimalIndex + 1) : '';

        const metadata = {
            cobolComponents: { sign, integerPart, decimalPart }
        };

        switch (targetType) {
            case DetectedDataType.NUMBER:
                // Convert to clean number
                const numericValue = parseFloat((sign === '-' ? '-' : '') + integerPart + (decimalPart ? '.' + decimalPart : ''));
                return { value: numericValue.toString(), metadata };

            case DetectedDataType.STRING:
            default:
                // Convert to clean string representation
                return { value: (sign === '-' ? '-' : '') + parseFloat(integerPart + '.' + (decimalPart || '0')).toString(), metadata };
        }
    }

    private async transformCurrency(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string; metadata?: any }> {
        
        // Extract numeric value from currency string
        const currencySymbol = value.match(/[\$€£¥₹]/)?.[0] || '';
        const numericString = value.replace(/[\$€£¥₹,\s]/g, '');
        const numericValue = parseFloat(numericString);

        if (isNaN(numericValue)) {
            throw new Error(`Invalid currency format: ${value}`);
        }

        const metadata = { numericValue, currencySymbol };

        switch (targetType) {
            case DetectedDataType.NUMBER:
                return { value: numericValue.toString(), metadata };

            case DetectedDataType.STRING:
            default:
                return { value: numericValue.toString(), metadata };
        }
    }

    private async transformScientific(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {
        
        const numericValue = parseFloat(value);
        
        if (isNaN(numericValue)) {
            throw new Error(`Invalid scientific notation: ${value}`);
        }

        switch (targetType) {
            case DetectedDataType.NUMBER:
                return { value: numericValue.toString() };

            case DetectedDataType.STRING:
            default:
                return { value: numericValue.toString() };
        }
    }

    private async transformBoolean(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {
        
        const lowerValue = value.toLowerCase();
        const trueValues = options.booleanMapping?.trueValues || BOOLEAN_TRUE;
        const falseValues = options.booleanMapping?.falseValues || BOOLEAN_FALSE;

        const isTrue = trueValues.includes(lowerValue);
        const isFalse = falseValues.includes(lowerValue);

        if (!isTrue && !isFalse) {
            throw new Error(`Invalid boolean value: ${value}`);
        }

        switch (targetType) {
            case DetectedDataType.BOOLEAN:
                return { value: isTrue ? 'true' : 'false' };

            case DetectedDataType.NUMBER:
                return { value: isTrue ? '1' : '0' };

            case DetectedDataType.STRING:
            default:
                return { value: isTrue ? 'true' : 'false' };
        }
    }

    private async transformDateTime(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string; metadata?: any }> {
        
        const sourceDate = new Date(value);
        
        if (isNaN(sourceDate.getTime())) {
            throw new Error(`Invalid datetime format: ${value}`);
        }

        let convertedDate = sourceDate;
        const metadata: any = {};

        // Handle timezone conversion
        if (options.sourceTimezone && options.targetTimezone) {
            // This is a simplified timezone conversion - in production, use a library like moment.js or date-fns-tz
            const targetTimezone = options.targetTimezone || 'GMT';
            
            if (targetTimezone === 'GMT' || targetTimezone === 'UTC') {
                convertedDate = new Date(sourceDate.getTime() - (sourceDate.getTimezoneOffset() * 60000));
                metadata.convertedTimezone = 'GMT';
            }
        }

        switch (targetType) {
            case DetectedDataType.DATETIME:
                return { value: convertedDate.toISOString(), metadata };

            case DetectedDataType.DATE:
                return { value: convertedDate.toISOString().split('T')[0], metadata };

            case DetectedDataType.STRING:
            default:
                return { value: convertedDate.toISOString(), metadata };
        }
    }

    private async transformDate(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {

        // DATE FIX: When converting to TEXT, preserve original value (don't parse/reformat)
        // This prevents corruption like "SKU-12345" becoming "+012344-12-31"
        if (targetType === DetectedDataType.STRING) {
            return { value: value }; // Return original value unchanged
        }

        const sourceDate = new Date(value);

        if (isNaN(sourceDate.getTime())) {
            throw new Error(`Invalid date format: ${value}`);
        }

        switch (targetType) {
            case DetectedDataType.DATE:
                return { value: sourceDate.toISOString().split('T')[0] };

            case DetectedDataType.DATETIME:
                return { value: sourceDate.toISOString() };

            default:
                return { value: sourceDate.toISOString().split('T')[0] };
        }
    }

    private async transformNumber(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {

        // GitHub Issue #138: When target is STRING, preserve original value to avoid precision loss
        // Large integers like "7630062687291984715" lose precision when parsed as JavaScript numbers
        if (targetType === DetectedDataType.STRING) {
            return { value: value };
        }

        const numericValue = parseFloat(value.replace(/[,\s]/g, ''));

        if (isNaN(numericValue)) {
            throw new Error(`Invalid number format: ${value}`);
        }

        switch (targetType) {
            case DetectedDataType.NUMBER:
            default:
                return { value: numericValue.toString() };
        }
    }

    private async transformArray(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {
        
        try {
            const parsed = JSON.parse(value);
            
            if (!Array.isArray(parsed)) {
                throw new Error(`Value is not an array: ${value}`);
            }

            switch (targetType) {
                case DetectedDataType.ARRAY:
                    return { value: JSON.stringify(parsed) };

                case DetectedDataType.STRING:
                default:
                    return { value: JSON.stringify(parsed) };
            }
        } catch (error) {
            throw new Error(`Invalid JSON array format: ${value}`);
        }
    }

    private async transformString(
        value: string,
        targetType: DetectedDataType,
        options: any
    ): Promise<{ value: string }> {
        
        switch (targetType) {
            case DetectedDataType.NUMBER:
                const numericValue = parseFloat(value);
                if (isNaN(numericValue)) {
                    throw new Error(`Cannot convert string to number: ${value}`);
                }
                return { value: numericValue.toString() };

            case DetectedDataType.BOOLEAN:
                const lowerValue = value.toLowerCase();
                const trueValues = ['true', 'yes', 'y', '1', 'on'];
                const falseValues = ['false', 'no', 'n', '0', 'off'];
                
                if (trueValues.includes(lowerValue)) {
                    return { value: 'true' };
                } else if (falseValues.includes(lowerValue)) {
                    return { value: 'false' };
                } else {
                    throw new Error(`Cannot convert string to boolean: ${value}`);
                }

            case DetectedDataType.DATE:
                const dateValue = new Date(value);
                if (isNaN(dateValue.getTime())) {
                    throw new Error(`Cannot convert string to date: ${value}`);
                }
                return { value: dateValue.toISOString().split('T')[0] };

            case DetectedDataType.DATETIME:
                const dateTimeValue = new Date(value);
                if (isNaN(dateTimeValue.getTime())) {
                    throw new Error(`Cannot convert string to datetime: ${value}`);
                }
                return { value: dateTimeValue.toISOString() };

            case DetectedDataType.STRING:
            default:
                return { value };
        }
    }

    // Utility methods

    private parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = i < line.length - 1 ? line[i + 1] : null;
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i++; // Skip next quote
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    private formatCSVLine(values: string[]): string {
        return values.map(value => {
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        }).join(',');
    }
}