// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Type Detection Service Implementation
 * Automatically detects data types from CSV column samples with smart parsing
 * 
 * Following Architecture.md patterns:
 * - Service implements interface for DI compatibility
 * - Separation of concerns with specific detection methods
 * - Comprehensive error handling and logging
 */

import { 
    IDataTypeDetectionService,
    DetectedDataType,
    ColumnTypeDetection,
    FileTypeDetectionResult,
    TypeDetectionOptions
} from './data-type-detection.interface';

export class DataTypeDetectionService implements IDataTypeDetectionService {

    /**
     * Detect data types for all columns in CSV data
     */
    async detectColumnTypes(csvData: string, options: TypeDetectionOptions = {}): Promise<FileTypeDetectionResult> {
        const opts = {
            maxSampleRows: 20,
            minConfidence: 0.6,
            detectTimezone: true,
            detectCurrency: true,
            detectCobolNumbers: true,
            ...options
        };

        try {
            // Parse CSV data
            const lines = csvData.split('\n').filter(line => line.trim().length > 0);
            if (lines.length < 2) {
                throw new Error('CSV must contain at least a header row and one data row');
            }

            const headers = this.parseCSVLine(lines[0]);
            const dataLines = lines.slice(1, Math.min(lines.length, opts.maxSampleRows! + 1));
            
            if (dataLines.length === 0) {
                throw new Error('CSV must contain at least one data row');
            }

            // Extract sample values for each column
            const columnSamples = new Map<string, string[]>();
            headers.forEach(header => {
                columnSamples.set(header, []);
            });

            // Collect samples from data rows
            for (const line of dataLines) {
                const values = this.parseCSVLine(line);
                headers.forEach((header, index) => {
                    if (index < values.length && values[index].trim()) {
                        columnSamples.get(header)?.push(values[index].trim());
                    }
                });
            }

            // Detect type for each column
            const columnTypes = new Map<string, ColumnTypeDetection>();
            let totalConfidence = 0;
            let validColumns = 0;

            for (const [columnName, samples] of columnSamples.entries()) {
                if (samples.length > 0) {
                    const detection = await this.detectColumnType(columnName, samples, opts);
                    if (detection.confidence >= opts.minConfidence!) {
                        columnTypes.set(columnName, detection);
                        totalConfidence += detection.confidence;
                        validColumns++;
                    } else {
                        // Fallback to string type for low confidence
                        columnTypes.set(columnName, {
                            type: DetectedDataType.STRING,
                            confidence: 1.0,
                            samples: samples.slice(0, 3)
                        });
                        totalConfidence += 1.0;
                        validColumns++;
                    }
                }
            }

            const overallConfidence = validColumns > 0 ? totalConfidence / validColumns : 0;

            return {
                columnTypes,
                overallConfidence,
                rowsAnalyzed: dataLines.length,
                warnings: overallConfidence < 0.7 ? ['Some column types detected with low confidence'] : undefined
            };

        } catch (error) {
            throw new Error(`Type detection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Detect data type for a specific column from sample values
     */
    async detectColumnType(columnName: string, samples: string[], options: TypeDetectionOptions = {}): Promise<ColumnTypeDetection> {
        const opts = {
            detectTimezone: true,
            detectCurrency: true,
            detectCobolNumbers: true,
            ...options
        };

        // Test each type in order of specificity
        // Put regular number detection before COBOL - if it matches COBOL format, it should be detected as NUMBER
        const detectionMethods = [
            () => this.detectCurrency(samples, opts.detectCurrency!),
            () => this.detectScientific(samples),
            () => this.detectBoolean(samples),
            () => this.detectDateTime(samples, opts.detectTimezone!),
            () => this.detectDate(samples),
            () => this.detectNumber(samples), // This will now catch COBOL numbers
            () => this.detectCobolNumber(samples, opts.detectCobolNumbers!), // Fallback for pure COBOL types
            () => this.detectArray(samples)
        ];

        // Try each detection method
        for (const detect of detectionMethods) {
            const result = detect();
            if (result && result.confidence > 0.6) {
                return result;
            }
        }

        // Fallback to string type
        return {
            type: DetectedDataType.STRING,
            confidence: 1.0,
            samples: samples.slice(0, 3)
        };
    }

    /**
     * Validate if a value can be converted to a specific type
     */
    canConvertToType(value: string, targetType: DetectedDataType): boolean {
        if (!value || !value.trim()) return true; // Empty values are generally convertible

        try {
            switch (targetType) {
                case DetectedDataType.NUMBER:
                    return this.canParseNumber(value);
                case DetectedDataType.COBOL_NUMBER:
                    return this.canParseCobolNumber(value);
                case DetectedDataType.CURRENCY:
                    return this.canParseCurrency(value);
                case DetectedDataType.SCIENTIFIC:
                    return this.canParseScientific(value);
                case DetectedDataType.BOOLEAN:
                    return this.canParseBoolean(value);
                case DetectedDataType.DATE:
                    return this.canParseDate(value);
                case DetectedDataType.DATETIME:
                    return this.canParseDateTime(value);
                case DetectedDataType.ARRAY:
                    return this.canParseArray(value);
                case DetectedDataType.STRING:
                default:
                    return true;
            }
        } catch {
            return false;
        }
    }

    /**
     * Get supported data types for detection
     */
    getSupportedTypes(): DetectedDataType[] {
        return Object.values(DetectedDataType);
    }

    /**
     * Get human-readable description for a data type
     */
    getTypeDescription(type: DetectedDataType): string {
        switch (type) {
            case DetectedDataType.STRING:
                return 'Text';
            case DetectedDataType.NUMBER:
                return 'Number';
            case DetectedDataType.COBOL_NUMBER:
                return 'COBOL Number (padded with +/-)';
            case DetectedDataType.CURRENCY:
                return 'Currency ($1,234.56)';
            case DetectedDataType.SCIENTIFIC:
                return 'Scientific Notation (1.23E+5)';
            case DetectedDataType.BOOLEAN:
                return 'Boolean (true/false, yes/no)';
            case DetectedDataType.DATE:
                return 'Date (YYYY-MM-DD)';
            case DetectedDataType.DATETIME:
                return 'Date & Time';
            case DetectedDataType.ARRAY:
                return 'JSON Array';
            default:
                return 'Unknown';
        }
    }

    // Private detection methods

    private detectCobolNumber(samples: string[], enabled: boolean): ColumnTypeDetection | null {
        if (!enabled) return null;

        let matches = 0;
        const cobolSamples: string[] = [];

        for (const sample of samples) {
            if (this.canParseCobolNumber(sample)) {
                matches++;
                cobolSamples.push(sample);
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.7) {
            // Analyze format from first sample
            const formatSample = cobolSamples[0];
            const metadata = this.analyzeCobolFormat(formatSample);

            return {
                type: DetectedDataType.COBOL_NUMBER,
                confidence,
                samples: cobolSamples.slice(0, 3),
                metadata: { cobolFormat: metadata }
            };
        }

        return null;
    }

    private detectCurrency(samples: string[], enabled: boolean): ColumnTypeDetection | null {
        if (!enabled) return null;

        let matches = 0;
        const currencySamples: string[] = [];
        let detectedSymbol = '';
        let detectedFormat: 'US' | 'EU' | 'OTHER' = 'US';

        for (const sample of samples) {
            const currencyInfo = this.parseCurrencyInfo(sample);
            if (currencyInfo.valid) {
                matches++;
                currencySamples.push(sample);
                if (!detectedSymbol) {
                    detectedSymbol = currencyInfo.symbol;
                    detectedFormat = currencyInfo.format;
                }
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.7) {
            return {
                type: DetectedDataType.CURRENCY,
                confidence,
                samples: currencySamples.slice(0, 3),
                metadata: {
                    currencySymbol: detectedSymbol,
                    currencyFormat: detectedFormat
                }
            };
        }

        return null;
    }

    private detectScientific(samples: string[]): ColumnTypeDetection | null {
        let matches = 0;
        const scientificSamples: string[] = [];

        for (const sample of samples) {
            if (this.canParseScientific(sample)) {
                matches++;
                scientificSamples.push(sample);
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.8) {
            return {
                type: DetectedDataType.SCIENTIFIC,
                confidence,
                samples: scientificSamples.slice(0, 3)
            };
        }

        return null;
    }

    private detectBoolean(samples: string[]): ColumnTypeDetection | null {
        let matches = 0;
        const booleanSamples: string[] = [];

        for (const sample of samples) {
            if (this.canParseBoolean(sample)) {
                matches++;
                booleanSamples.push(sample);
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.9) { // High threshold for boolean detection
            return {
                type: DetectedDataType.BOOLEAN,
                confidence,
                samples: booleanSamples.slice(0, 3)
            };
        }

        return null;
    }

    private detectDateTime(samples: string[], detectTimezone: boolean): ColumnTypeDetection | null {
        let matches = 0;
        const dateTimeSamples: string[] = [];
        let detectedTimezone = '';

        for (const sample of samples) {
            const dateTimeInfo = this.parseDateTimeInfo(sample, detectTimezone);
            if (dateTimeInfo.valid && dateTimeInfo.hasTime) {
                matches++;
                dateTimeSamples.push(sample);
                if (detectTimezone && dateTimeInfo.timezone && !detectedTimezone) {
                    detectedTimezone = dateTimeInfo.timezone;
                }
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.7) {
            return {
                type: DetectedDataType.DATETIME,
                confidence,
                samples: dateTimeSamples.slice(0, 3),
                metadata: detectedTimezone ? { timezone: detectedTimezone } : undefined
            };
        }

        return null;
    }

    private detectDate(samples: string[]): ColumnTypeDetection | null {
        let matches = 0;
        const dateSamples: string[] = [];
        let detectedFormat = '';

        for (const sample of samples) {
            const dateInfo = this.parseDateInfo(sample);
            if (dateInfo.valid) {
                matches++;
                dateSamples.push(sample);
                if (!detectedFormat) {
                    detectedFormat = dateInfo.format;
                }
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.7) {
            return {
                type: DetectedDataType.DATE,
                confidence,
                samples: dateSamples.slice(0, 3),
                metadata: { dateFormat: detectedFormat }
            };
        }

        return null;
    }

    private detectNumber(samples: string[]): ColumnTypeDetection | null {
        let matches = 0;
        const numberSamples: string[] = [];

        for (const sample of samples) {
            if (this.canParseNumber(sample)) {
                matches++;
                numberSamples.push(sample);
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.8) {
            return {
                type: DetectedDataType.NUMBER,
                confidence,
                samples: numberSamples.slice(0, 3)
            };
        }

        return null;
    }

    private detectArray(samples: string[]): ColumnTypeDetection | null {
        let matches = 0;
        const arraySamples: string[] = [];

        for (const sample of samples) {
            if (this.canParseArray(sample)) {
                matches++;
                arraySamples.push(sample);
            }
        }

        const confidence = samples.length > 0 ? matches / samples.length : 0;
        
        if (confidence > 0.9) { // High threshold for array detection
            return {
                type: DetectedDataType.ARRAY,
                confidence,
                samples: arraySamples.slice(0, 3)
            };
        }

        return null;
    }

    // Private validation methods

    private canParseCobolNumber(value: string): boolean {
        // COBOL pattern: optional +/- followed by padded digits with decimal
        const cobolPattern = /^[+-]?\d+\.?\d*$/;
        const trimmed = value.trim();
        
        // Must match pattern and have leading zeros or consistent length
        if (!cobolPattern.test(trimmed)) return false;
        
        // Check for COBOL characteristics: leading zeros or signs
        return trimmed.includes('+') || 
               trimmed.includes('-') || 
               (trimmed.length > 3 && trimmed.startsWith('0'));
    }

    private canParseNumber(value: string): boolean {
        const trimmed = value.trim();
        if (!trimmed) return true; // Empty values can be numbers

        // Handle COBOL format numbers - they should be detected as regular numbers
        const cobolPattern = /^[+-]?\d+\.?\d*$/;
        if (cobolPattern.test(trimmed)) {
            // LEADING ZERO FIX: Check for leading zeros without sign
            // Values like "000123", "0001" should be TEXT (PO IDs, SKUs, zip codes)
            // But "+000123" or "-000123" (COBOL signed) should still be NUMBER
            if (/^0\d+/.test(trimmed) && !trimmed.startsWith('+') && !trimmed.startsWith('-')) {
                return false; // Leading zeros without sign = STRING identifier
            }
            // This covers both regular numbers AND COBOL format numbers
            return true;
        }

        // Allow thousand separators and negative numbers
        const cleanedValue = trimmed.replace(/[,\s]/g, '');
        const num = parseFloat(cleanedValue);

        // CRITICAL FIX: Ensure parseFloat consumed the ENTIRE string
        // parseFloat("999ASC") returns 999, but we need to reject mixed content
        // Convert number back to string and compare with cleaned input
        if (isNaN(num) || !isFinite(num)) {
            return false;
        }

        // Check if parseFloat consumed the entire string
        // Handle both integer and decimal numbers correctly
        const numStr = num.toString();
        const expectedStr = cleanedValue.replace(/^[+-]/, ''); // Remove sign for comparison

        // If the cleaned value has non-numeric characters after the number, reject it
        // Example: "999ASC" -> cleanedValue="999ASC", num=999, numStr="999"
        // The cleanedValue still contains "ASC" which parseFloat ignored
        if (cleanedValue !== num.toString() &&
            cleanedValue !== ('+' + num.toString()) &&
            cleanedValue !== ('-' + num.toString())) {
            // Additional check: ensure no trailing non-numeric characters
            const numericPattern = /^[+-]?\d+\.?\d*$/;
            return numericPattern.test(cleanedValue);
        }

        return true;
    }

    private canParseCurrency(value: string): boolean {
        // Common currency patterns: $1,234.56, €1.234,56, £1234.56
        const currencyPatterns = [
            /^[\$€£¥₹]\s*[\d,.']+$/,  // Symbol first
            /^[\d,.']+\s*[\$€£¥₹]$/,  // Symbol last
        ];
        
        return currencyPatterns.some(pattern => pattern.test(value.trim()));
    }

    private canParseScientific(value: string): boolean {
        const scientificPattern = /^-?\d+\.?\d*[eE][+-]?\d+$/;
        return scientificPattern.test(value.trim());
    }

    private canParseBoolean(value: string): boolean {
        const booleanValues = ['true', 'false', 'yes', 'no', 'y', 'n', 'on', 'off'];
        return booleanValues.includes(value.toLowerCase().trim());
    }

    private canParseDate(value: string): boolean {
        if (!value.trim()) return false;

        const trimmed = value.trim();

        // DATE FIX: Conservative date detection - only accept common date formats
        // JavaScript's Date() accepts almost anything (e.g., "SKU-12345" parses as year 12345)
        // Only detect values that match standard date patterns
        const commonDatePatterns = [
            /^\d{4}-\d{2}-\d{2}$/,           // YYYY-MM-DD (ISO)
            /^\d{4}\/\d{2}\/\d{2}$/,         // YYYY/MM/DD
            /^\d{2}\/\d{2}\/\d{4}$/,         // MM/DD/YYYY or DD/MM/YYYY
            /^\d{2}-\d{2}-\d{4}$/,           // MM-DD-YYYY or DD-DD-YYYY
            /^\d{2}\.\d{2}\.\d{4}$/,         // DD.MM.YYYY (European)
            /^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/i, // 15-Jan-2024
            /^[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}$/i // Jan 15, 2024
        ];

        // Reject values with letters before numbers (like "SKU-12345", "ID-001")
        // These are identifiers, not dates!
        if (/^[A-Z]+[-\/]/.test(trimmed)) {
            return false;
        }

        // Must match at least one common date pattern
        if (!commonDatePatterns.some(pattern => pattern.test(trimmed))) {
            return false;
        }

        try {
            const date = new Date(trimmed);
            return !isNaN(date.getTime());
        } catch {
            return false;
        }
    }

    private canParseDateTime(value: string): boolean {
        if (!value.trim()) return false;
        
        try {
            const trimmed = value.trim();
            // Must contain time indicators
            const hasTime = /\d{1,2}:\d{2}/.test(trimmed) || /\d{2}:\d{2}:\d{2}/.test(trimmed);
            if (!hasTime) return false;
            
            const date = new Date(trimmed);
            return !isNaN(date.getTime());
        } catch {
            return false;
        }
    }

    private canParseArray(value: string): boolean {
        try {
            const parsed = JSON.parse(value.trim());
            return Array.isArray(parsed);
        } catch {
            return false;
        }
    }

    // Private analysis methods

    private analyzeCobolFormat(sample: string): { totalLength: number; decimalPlaces: number; hasSign: boolean } {
        const trimmed = sample.trim();
        const hasSign = trimmed.startsWith('+') || trimmed.startsWith('-');
        const decimalIndex = trimmed.indexOf('.');
        const decimalPlaces = decimalIndex >= 0 ? trimmed.length - decimalIndex - 1 : 0;
        
        return {
            totalLength: trimmed.length,
            decimalPlaces,
            hasSign
        };
    }

    private parseCurrencyInfo(value: string): { valid: boolean; symbol: string; format: 'US' | 'EU' | 'OTHER' } {
        const trimmed = value.trim();
        
        // Check for common currency symbols
        const symbols = ['$', '€', '£', '¥', '₹'];
        for (const symbol of symbols) {
            if (trimmed.includes(symbol)) {
                const format = symbol === '€' && trimmed.includes(',') && !trimmed.includes('.') ? 'EU' : 'US';
                return { valid: true, symbol, format };
            }
        }
        
        return { valid: false, symbol: '', format: 'OTHER' };
    }

    private parseDateTimeInfo(value: string, detectTimezone: boolean): { 
        valid: boolean; 
        hasTime: boolean; 
        timezone?: string 
    } {
        try {
            const trimmed = value.trim();
            const hasTime = /\d{1,2}:\d{2}/.test(trimmed);
            
            if (!hasTime) {
                return { valid: false, hasTime: false };
            }
            
            const date = new Date(trimmed);
            const valid = !isNaN(date.getTime());
            
            let timezone = '';
            if (detectTimezone && valid) {
                // Simple timezone detection
                const timezonePatterns = [
                    /([A-Z]{3,4})$/,  // GMT, UTC, EST, etc.
                    /([+-]\d{2}:?\d{2})$/,  // +05:30, -08:00
                    /Z$/  // ISO format
                ];
                
                for (const pattern of timezonePatterns) {
                    const match = trimmed.match(pattern);
                    if (match) {
                        timezone = match[1];
                        break;
                    }
                }
            }
            
            return { valid, hasTime, timezone: timezone || undefined };
        } catch {
            return { valid: false, hasTime: false };
        }
    }

    private parseDateInfo(value: string): { valid: boolean; format: string } {
        try {
            const trimmed = value.trim();
            const date = new Date(trimmed);
            const valid = !isNaN(date.getTime()) && trimmed.length >= 8;
            
            // Detect common date formats
            let format = 'Unknown';
            if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) format = 'YYYY-MM-DD';
            else if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) format = 'MM/DD/YYYY';
            else if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed)) format = 'MM-DD-YYYY';
            else if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) format = 'DD.MM.YYYY';
            
            return { valid, format };
        } catch {
            return { valid: false, format: 'Unknown' };
        }
    }

    private parseCSVLine(line: string): string[] {
        // Simple CSV parser - handles quoted fields
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
}