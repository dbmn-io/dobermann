// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared source format conversion utility
 *
 * Single source of truth for converting values based on source format
 * (COBOL, Currency, Scientific, Excel Serial, Standard).
 *
 * GitHub Issue #218: STRING is default — string-typed values NEVER enter
 * numeric conversion pipelines. The STRING guard lives HERE.
 *
 * GitHub Issue #135: Original source format conversion feature.
 */

/**
 * Convert a single value based on its source format.
 *
 * STRING guard: If dataType is 'string' (or undefined, since STRING is default),
 * the value is returned unchanged — no conversion is ever applied to strings.
 */
export function convertValueBySourceFormat(
    value: string,
    sourceFormat: string,
    dataType: string = 'string'
): string {
    // GitHub Issue #218: STRING is default — never apply conversion to string-typed values
    if (!dataType || dataType === 'string') {
        return value;
    }

    if (!value || value.trim() === '') {
        return value;
    }

    const trimmed = value.trim();

    switch (sourceFormat.toLowerCase()) {
        case 'excel_serial': {
            // Excel serial date (days since 1899-12-30)
            const serialNum = parseFloat(trimmed);
            if (!isNaN(serialNum) && serialNum >= 1) {
                // Excel's epoch quirk: serial <= 60 uses 25567, > 60 uses 25569
                const daysOffset = serialNum <= 60 ? 25567 : 25569;
                const date = new Date((serialNum - daysOffset) * 86400000);
                return date.toISOString().split('T')[0];
            }
            return value;
        }

        case 'cobol': {
            // COBOL format: +000000099.9900 or -000000001.0000
            let cobolValue = trimmed;
            const isNegative = cobolValue.startsWith('-');
            cobolValue = cobolValue.replace(/^[+-]/, ''); // Remove sign
            cobolValue = cobolValue.replace(/^0+/, '') || '0'; // Remove leading zeros
            const cobolNum = parseFloat(cobolValue);
            if (!isNaN(cobolNum)) {
                return isNegative ? `-${cobolNum}` : String(cobolNum);
            }
            return value;
        }

        case 'currency': {
            // Currency format: $1,234.56 or €1.234,56 or -$500.00 or ($500.00)
            let currencyValue = trimmed;
            const currencyNegative = currencyValue.includes('-') || currencyValue.includes('(');
            // Remove currency symbols, parentheses, and whitespace (NOT commas — needed for format detection)
            currencyValue = currencyValue.replace(/[$€£¥₹\s()]/g, '');
            // Handle European format (1.234,56) — comma after last dot means European
            if (currencyValue.includes(',') && currencyValue.lastIndexOf(',') > currencyValue.lastIndexOf('.')) {
                currencyValue = currencyValue.replace(/\./g, '').replace(',', '.');
            } else {
                currencyValue = currencyValue.replace(/,/g, '');
            }
            const currencyNum = parseFloat(currencyValue);
            if (!isNaN(currencyNum)) {
                return currencyNegative ? `-${Math.abs(currencyNum)}` : String(currencyNum);
            }
            return value;
        }

        case 'scientific': {
            // Scientific notation: 1.23E+04 or 1.23e-02
            const sciNum = parseFloat(trimmed);
            if (!isNaN(sciNum)) {
                return String(sciNum);
            }
            return value;
        }

        case 'standard': {
            // Standard number — remove thousand separators
            const cleanedStandard = trimmed.replace(/,/g, '');
            const stdNum = parseFloat(cleanedStandard);
            if (!isNaN(stdNum)) {
                return String(stdNum);
            }
            return value;
        }

        case 'passthrough':
        default:
            return value;
    }
}

/**
 * Apply source format conversions to data rows based on column mappings.
 *
 * Builds a column-index-to-format map from mappings, then converts each
 * cell value. STRING-typed mappings are automatically skipped via
 * convertValueBySourceFormat's STRING guard.
 */
export function applySourceFormatConversions(
    dataRows: string[][],
    headers: string[],
    mappings: Array<{ variable: string; column: string | null; dataType: string; sourceFormat?: string }>
): string[][] {
    // Build column index -> format map, skipping string-typed mappings
    const columnFormatMap = new Map<number, { format: string; dataType: string }>();

    for (const mapping of mappings) {
        if (mapping.sourceFormat && mapping.column && mapping.dataType !== 'string') {
            const columnIndex = headers.indexOf(mapping.column);
            if (columnIndex !== -1) {
                columnFormatMap.set(columnIndex, {
                    format: mapping.sourceFormat,
                    dataType: mapping.dataType
                });
            }
        }
    }

    // No conversions needed — return original data
    if (columnFormatMap.size === 0) {
        return dataRows;
    }

    // Apply conversions to each row
    return dataRows.map(row => {
        return row.map((value, colIndex) => {
            const formatInfo = columnFormatMap.get(colIndex);
            if (formatInfo) {
                return convertValueBySourceFormat(value, formatInfo.format, formatInfo.dataType);
            }
            return value;
        });
    });
}
