// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Type Coercion
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Contains type detection, coercion validation, and source format conversion:
 * - Type detection and selection (Step 2)
 * - Type transformation preview
 * - Coercion validation (sample and full)
 * - Nested array sorting analysis (GitHub Issue #148)
 * - Source format options and conversion (GitHub Issue #135)
 * - CSV line parsing
 */
(function () {
    'use strict';

    const TYPE_ERRORS_MESSAGE = 'Type errors detected. Fix in the source file and re-upload, or click Next to fix errors directly in the grid.';

    // Module-level references (set via init)
    let csvState = null;
    let getVscode = null;

    // =========================================================================
    // Type Detection and Selection Functions
    // =========================================================================

    async function detectAndDisplayColumnTypes() {

        if (!csvState.currentParsedData || !csvState.currentParsedData.headers) {
            console.warn('⚠️ [CSV Handler] No CSV data available for type detection');
            return;
        }

        // Skip type detection if already completed and we have saved selections (GitHub Issue #106)
        if (csvState.typeDetectionCompleted && csvState.selectedColumnTypes && Object.keys(csvState.selectedColumnTypes).length > 0) {
            restoreSavedTypeSelections();
            return;
        }

        // Create CSV string for type detection
        const csvData = csvState.rawCSVContent || createCSVStringFromData(csvState.currentParsedData);

        try {
            // Send type detection request to backend

            getVscode().postMessage({
                type: 'detectColumnTypes',
                csvData: csvData,
                options: {
                    sampleSize: 100, // Analyze first 100 rows for performance
                    confidenceThreshold: 0.7
                }
            });

        } catch (error) {
            console.error('❌ [CSV Handler] Error requesting type detection:', error);

            // Fallback to default types
            populateTypeSelectorsWithDefaults();
        }
    }

    function handleTypeDetectionResult(message) {

        if (!message.result || !message.result.columnTypes) {
            console.error('❌ [CSV Handler] Type detection failed:', message.error || 'No result data');
            populateTypeSelectorsWithDefaults();
            return;
        }

        const detectionResult = message.result;
        populateTypeSelectors(detectionResult.columnTypes, detectionResult.overallConfidence);

        // Mark type detection as completed (GitHub Issue #106)
        csvState.typeDetectionCompleted = true;

        // After populating selectors, apply transformations to show converted values
        applyTransformationsToPreview(detectionResult.columnTypes);
    }

    function populateTypeSelectors(columnTypes, confidence) {
        const typeSelectors = document.querySelectorAll('.type-selector');

        // Available type options for dropdowns
        const typeOptions = {
            'string': { label: 'Text', description: 'Plain text values' },
            'number': { label: 'Number', description: 'Numeric values (detects COBOL format automatically)' },
            'currency': { label: 'Currency', description: 'Monetary values with currency symbols' },
            'scientific': { label: 'Scientific', description: 'Scientific notation (1.23E+04)' },
            'boolean': { label: 'Boolean', description: 'True/false, yes/no values' },
            'date': { label: 'Date', description: 'Date values (YYYY-MM-DD)' },
            'datetime': { label: 'Date/Time', description: 'Date and time values with timezone' },
            'array': { label: 'Array', description: 'Multiple values separated by delimiters' }
        };

        typeSelectors.forEach((select, index) => {
            const columnName = select.getAttribute('data-column-name');

            // Handle array of column type objects from backend
            let typeDetection = null;
            if (Array.isArray(columnTypes)) {
                typeDetection = columnTypes.find(col => col.name === columnName);
            } else if (columnTypes.get) {
                typeDetection = columnTypes.get(columnName);
            } else {
                typeDetection = columnTypes[columnName];
            }

            const detectedType = typeDetection ? typeDetection.type : 'string';
            const confidenceScore = typeDetection ? typeDetection.confidence : (confidence || 0.5);

            // Clear existing options
            select.innerHTML = '';

            // Create options with detected type first
            Object.entries(typeOptions).forEach(([typeValue, typeInfo]) => {
                const option = document.createElement('option');
                option.value = typeValue;
                option.textContent = typeInfo.label;
                option.title = typeInfo.description;

                // Mark detected type as selected (no confidence rating shown)
                if (typeValue === detectedType) {
                    option.selected = true;
                }

                select.appendChild(option);
            });

            // Clean styling for all selectors
            select.className = 'type-selector type-selector-default';
            select.title = typeOptions[detectedType] ? typeOptions[detectedType].description : 'Select data type';

            // Apply initial alignment based on detected type
            updateColumnAlignment(index, detectedType);
        });

        // Initialize selectedColumnTypes with detected types
        csvState.selectedColumnTypes = {};
        typeSelectors.forEach(select => {
            const columnName = select.getAttribute('data-column-name');
            const selectedType = select.value;
            if (columnName && selectedType) {
                csvState.selectedColumnTypes[columnName] = selectedType;
            }
        });

    }

    function populateTypeSelectorsWithDefaults() {
        const typeSelectors = document.querySelectorAll('.type-selector');
        const defaultOptions = `
            <option value="string" selected>Text</option>
            <option value="number">Number</option>
            <option value="currency">Currency</option>
            <option value="boolean">Boolean</option>
            <option value="date">Date</option>
            <option value="datetime">Date/Time</option>
            <option value="array">Array</option>
        `;

        typeSelectors.forEach(select => {
            select.innerHTML = defaultOptions;
            select.className = 'type-selector type-selector-default';
            select.title = 'Type detection not available - please select manually';
        });
    }

    /**
     * Restore previously saved type selections when navigating back to Step 2
     * This preserves user's manual type selections (GitHub Issue #106)
     */
    function restoreSavedTypeSelections() {
        const typeSelectors = document.querySelectorAll('.type-selector');

        // Available type options for dropdowns
        const typeOptions = {
            'string': { label: 'Text', description: 'Plain text values' },
            'number': { label: 'Number', description: 'Numeric values (detects COBOL format automatically)' },
            'currency': { label: 'Currency', description: 'Monetary values with currency symbols' },
            'scientific': { label: 'Scientific', description: 'Scientific notation (1.23E+04)' },
            'boolean': { label: 'Boolean', description: 'True/false, yes/no values' },
            'date': { label: 'Date', description: 'Date values (YYYY-MM-DD)' },
            'datetime': { label: 'Date/Time', description: 'Date and time values with timezone' },
            'array': { label: 'Array', description: 'Multiple values separated by delimiters' }
        };

        typeSelectors.forEach((select, index) => {
            const columnName = select.getAttribute('data-column-name');
            const savedType = csvState.selectedColumnTypes[columnName];

            // Clear existing options
            select.innerHTML = '';

            // Create options with saved type selected
            Object.entries(typeOptions).forEach(([typeValue, typeInfo]) => {
                const option = document.createElement('option');
                option.value = typeValue;
                option.textContent = typeInfo.label;
                option.title = typeInfo.description;

                // Mark saved type as selected
                if (typeValue === savedType) {
                    option.selected = true;
                }

                select.appendChild(option);
            });

            // Apply styling
            select.className = 'type-selector type-selector-valid';
            select.title = `Restored selection: ${savedType}`;

            // Apply column alignment based on restored type
            updateColumnAlignment(index, savedType);
        });

        // Apply transformations to show converted values with restored types
        applyTransformationsToPreview(null);
    }

    function handleTypeSelection(columnName, selectedType, columnIndex) {

        // Store the selection in state for cross-step persistence
        csvState.selectedColumnTypes[columnName] = selectedType;

        // Update visual feedback
        const selector = document.querySelector(`.type-selector[data-column-index="${columnIndex}"]`);
        if (selector) {
            selector.className = 'type-selector type-selector-valid';
            selector.title = `Manually selected: ${selectedType}`;
        }

        // Apply cell alignment based on type selection
        updateColumnAlignment(columnIndex, selectedType);

        // Apply transformation immediately using backend service (fixes DATE↔TEXT live updates)
        requestTransformationPreview(columnName, selectedType, columnIndex);
    }

    function updateColumnAlignment(columnIndex, dataType) {
        // Find all cells in this column and apply appropriate alignment
        const cells = document.querySelectorAll(`td[data-column-index="${columnIndex}"]`);
        cells.forEach(cell => {
            // Remove existing alignment classes
            cell.classList.remove('numeric-cell', 'text-cell');

            // Apply new alignment based on data type
            if (dataType === 'number' || dataType === 'integer' || dataType === 'decimal' || dataType === 'currency') {
                cell.classList.add('numeric-cell');
            } else {
                cell.classList.add('text-cell');
            }
        });
    }

    function requestTransformationPreview(columnName, selectedType, columnIndex) {
        // Get sample values from the column for preview
        const sampleValues = getSampleValuesForColumn(columnIndex, 3); // Get first 3 values

        if (sampleValues.length === 0) {
            console.warn('⚠️ [CSV Handler] No sample values available for transformation preview');
            return;
        }

        // Request transformation of sample values to show preview
        const columnTypes = new Map();
        columnTypes.set(columnName, selectedType);

        // LEADING ZERO FIX: Use raw CSV content instead of parsed data
        // Parsed data loses leading zeros (e.g., "000123" becomes 123)
        // Raw CSV preserves original values for transformation
        const csvDataForTransformation = csvState.rawCSVContent || createCSVStringFromCurrentData();

        getVscode().postMessage({
            type: 'applyTypeTransformations',
            csvData: csvDataForTransformation,
            columnTypes: Object.fromEntries([[columnName, selectedType]]) // Convert to object for JSON serialization
        });
    }

    function getSampleValuesForColumn(columnIndex, maxSamples = 3) {
        if (!csvState.currentParsedData || !csvState.currentParsedData.rows) {
            return [];
        }

        const sampleValues = [];
        const maxRows = Math.min(csvState.currentParsedData.rows.length, maxSamples);

        for (let i = 0; i < maxRows; i++) {
            const row = csvState.currentParsedData.rows[i];
            if (row && row[columnIndex] !== undefined && row[columnIndex] !== null) {
                sampleValues.push(row[columnIndex].toString());
            }
        }

        return sampleValues;
    }

    function createCSVStringFromCurrentData() {
        if (!csvState.currentParsedData || !csvState.currentParsedData.headers || !csvState.currentParsedData.rows) {
            return '';
        }

        const headers = csvState.currentParsedData.headers;
        const rows = csvState.currentParsedData.rows;

        // Create CSV string from current data
        const csvLines = [];
        csvLines.push(headers.join(','));

        rows.forEach(row => {
            const escapedRow = row.map(cell => {
                const cellStr = cell || '';
                // Escape commas and quotes in CSV
                if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                    return `"${cellStr.replace(/"/g, '""')}"`;
                }
                return cellStr;
            });
            csvLines.push(escapedRow.join(','));
        });

        return csvLines.join('\n');
    }

    function createCSVStringFromData(parsedData) {
        if (!parsedData || !parsedData.headers || !parsedData.rows) {
            return '';
        }

        const csvLines = [];

        // Add headers
        csvLines.push(parsedData.headers.join(','));

        // Add data rows
        parsedData.rows.forEach(row => {
            const escapedRow = row.map(cell => {
                const cellStr = cell ? cell.toString() : '';
                // Escape cells containing commas, quotes, or newlines
                if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                    return `"${cellStr.replace(/"/g, '""')}"`;
                }
                return cellStr;
            });
            csvLines.push(escapedRow.join(','));
        });

        return csvLines.join('\n');
    }

    function applyTransformationsToPreview(columnTypes) {

        if (!csvState.currentParsedData) {
            console.warn('⚠️ [CSV Handler] No parsed data available for transformation');
            return;
        }

        // Get all data cells (not headers or type selectors)
        const dataRows = document.querySelectorAll('#csvPreviewTableBody tr');

        dataRows.forEach((row, rowIndex) => {
            const cells = row.querySelectorAll('td');

            cells.forEach((cell, columnIndex) => {
                const columnName = csvState.currentHeaders[columnIndex];

                // Use the SELECTED type from dropdown, not the detected type
                const selector = document.querySelector(`.type-selector[data-column-name="${columnName}"]`);
                const selectedType = selector ? selector.value : 'string';

                const originalValue = cell.getAttribute('data-original-value') || cell.textContent;

                // Store original value if not already stored
                if (!cell.getAttribute('data-original-value')) {
                    cell.setAttribute('data-original-value', originalValue);
                }

                const convertedValue = transformValueForDisplay(originalValue, selectedType);

                if (convertedValue !== originalValue) {
                    // CRITICAL FIX: Show transformation preview with visual indicator
                    cell.textContent = convertedValue;
                    cell.title = `Original: ${originalValue} → Transformed: ${convertedValue}`;
                    cell.classList.add('transformed-cell'); // Add visual indicator
                } else {
                    // Reset to original if no transformation needed
                    cell.textContent = originalValue;
                    cell.title = '';
                    cell.classList.remove('transformed-cell'); // Remove indicator
                }

                // Apply alignment based on selected type
                if (selectedType === 'number' || selectedType === 'currency' || selectedType === 'scientific') {
                    cell.className = cell.className + ' text-right';
                } else {
                    cell.className = cell.className + ' text-left';
                }
            });
        });
    }

    function transformValueForDisplay(value, detectedType) {
        if (!value || typeof value !== 'string') {
            return value;
        }

        try {
            switch (detectedType) {
                case 'string':
                    // For text type, always return original value (no transformation)
                    return value;

                case 'number':
                    // CRITICAL FIX: Show live preview of number transformation
                    // If value contains mixed text/numbers (e.g., "999ASC"), parseFloat truncates to "999"
                    // This preview shows the user EXACTLY what will happen
                    const trimmed = value.trim();

                    // Handle COBOL numbers like +000000001.0000 or -000000020.0000
                    if (/^[+-]\d+\.?\d*$/.test(trimmed)) {
                        const sign = trimmed.startsWith('-') ? '-' : '';
                        const numberPart = trimmed.replace(/^[+-]/, '');
                        const numericValue = parseFloat(sign + numberPart);
                        return isNaN(numericValue) ? value : numericValue.toString();
                    }

                    // Handle regular numbers and mixed content (e.g., "999ASC" -> "999")
                    // Remove commas and spaces (thousand separators)
                    const cleanedValue = trimmed.replace(/[,\s]/g, '');
                    const numericValue = parseFloat(cleanedValue);

                    if (!isNaN(numericValue) && isFinite(numericValue)) {
                        // SHOW PREVIEW: This is what parseFloat will extract
                        // User will see "999ASC" -> "999" and can decide if acceptable
                        return numericValue.toString();
                    }

                    return value; // Can't parse as number, keep original

                case 'boolean':
                    // Transform common boolean representations to 'true'/'false'
                    const lowerValue = value.toLowerCase().trim();
                    const trueValues = ['true', 'yes', 'y', '1', 'on'];
                    const falseValues = ['false', 'no', 'n', '0', 'off'];

                    if (trueValues.includes(lowerValue)) {
                        return 'true';
                    } else if (falseValues.includes(lowerValue)) {
                        return 'false';
                    }
                    return value; // Return original if not recognized
                    break;

                case 'currency':
                    // Convert COBOL currency format
                    if (/^[+-]\d+\.?\d*$/.test(value.trim())) {
                        const sign = value.trim().startsWith('-') ? '-' : '';
                        const numberPart = value.trim().replace(/^[+-]/, '');
                        const numericValue = parseFloat(sign + numberPart);
                        return isNaN(numericValue) ? value : `$${numericValue.toFixed(2)}`;
                    }
                    break;

                case 'date':
                case 'datetime':
                    // Basic date transformation - could be enhanced
                    const dateFormats = [/^\d{4}-\d{2}-\d{2}/, /^\d{2}\/\d{2}\/\d{4}/];
                    if (dateFormats.some(format => format.test(value.trim()))) {
                        return value.trim();
                    }
                    break;

                default:
                    return value;
            }
        } catch (error) {
            console.warn('⚠️ [CSV Handler] Error transforming value:', error);
        }

        return value; // Return original if transformation fails
    }

    function handleTypeConversionValidation(message) {

        if (!message.success) {
            console.error('❌ [CSV Handler] Type conversion validation failed:', message.error);
            // Show validation error in UI
            showTypeValidationError(message.columnName, message.error);
            return;
        }

        // Show validation success with preview of converted value
        const result = message.validationResult;
        if (result && result.isValid) {
            updateCellPreview(message.columnName, result.originalValue, result.convertedValue);
        } else {
            console.warn(`⚠️ [CSV Handler] Type conversion warning for column "${message.columnName}": ${result.error}`);
            showTypeValidationWarning(message.columnName, result.error);
        }
    }

    function handleTypeTransformationResult(message) {

        if (message.error) {
            console.error('❌ [CSV Handler] Type transformation failed:', message.error);
            return;
        }

        // Update the preview table with transformed values
        const transformedData = message.transformedData;
        if (transformedData) {
            // LEADING ZERO FIX: Store the full transformed CSV string from backend
            // This preserves proper CSV quoting (e.g., "000123" stays quoted)
            // Don't rebuild CSV from parsed arrays - that loses quoting!
            csvState.fullTransformedCSV = transformedData;

            // Parse the transformed CSV data for UI display only
            // Parse transformed CSV data (GitHub Issue #106: Only sample data returned from backend)
            const lines = transformedData.split('\n').filter(line => line.trim());
            if (lines.length < 2) return; // Need at least headers and one data row

            const headers = lines[0].split(',');
            // GitHub Issue #106: Backend returns sampled data, parse only what we receive
            const transformedRows = lines.slice(1).map(line => parseCSVLine(line));

            // IMPORTANT: Store transformed data in csvState for use in Step 3 sample values
            csvState.transformedHeaders = headers;
            csvState.transformedRows = transformedRows;
            csvState.transformationInProgress = false; // Clear transformation flag

            // Update the table body with transformed values (showing originals as tooltips)
            // GitHub Issue #106: Only updates table with sampled data
            updateTableWithTransformations(headers, transformedRows);

            // IMPORTANT: If we're on Step 3, populate/refresh the mapping table with transformed data
            if (csvState.modalStep === 3) {
                window.CSVHandler.populateColumnMappingTable();
            }

            // IMPORTANT: If we're waiting to generate JSON after transformation, do it now
            if (csvState.generateJsonAfterTransform) {
                csvState.generateJsonAfterTransform = false; // Reset flag
                window.DTDataPreview.generateJSONPreview();
            }

            // GitHub Issue #106: If we're waiting to execute after FULL transformation, do it now
            if (csvState.executeAfterTransform) {
                csvState.executeAfterTransform = false; // Reset flag

                // Now execute with the FULL transformed data
                const endpointId = csvState.executionEndpointId;
                csvState.executionEndpointId = null;

                if (endpointId) {
                    // LEADING ZERO FIX: Use full transformed CSV from backend (don't rebuild!)
                    // Safety check: Ensure transformed data exists
                    if (!csvState.fullTransformedCSV) {
                        console.error('❌ [CSV Execution] Transformed CSV not available!');
                        window.CSVHandler.showCSVError('Transformation data is missing. Please try again.');

                        // Reset execute button (GitHub Issue #106)
                        const executeBtn = document.getElementById('csvExecuteBtn');
                        if (executeBtn) {
                            executeBtn.disabled = false;
                            executeBtn.innerHTML = 'Execute';
                        }
                        return;
                    }

                    // Use the full transformed CSV string from backend (preserves proper quoting)
                    const csvDataForExecution = csvState.fullTransformedCSV;

                    // Prepare the column mappings for backend
                    const mappings = csvState.templateVariables ? csvState.templateVariables.map(variable => ({
                        variable: variable.name,
                        column: variable.mappedTo || null,
                        dataType: variable.dataType || 'string'
                    })) : [];

                    // LEADING ZERO FIX: Parse CSV using proper parseCSVLine() function
                    // This respects CSV quoting rules (unlike simple split which strips quotes)
                    const lines = csvDataForExecution.split('\n').filter(line => line.trim().length > 0);
                    if (lines.length < 2) {
                        console.error('❌ [CSV Execution] Invalid CSV data!');
                        window.CSVHandler.showCSVError('CSV data is invalid. Please try again.');
                        return;
                    }

                    const headers = parseCSVLine(lines[0]); // Use proper parser for headers too!

                    // GitHub Issue #135: Build header -> source format map for conversion
                    const headerFormatMap = {};
                    if (csvState.templateVariables && csvState.sourceTypes) {
                        csvState.templateVariables.forEach(variable => {
                            if (variable.mappedTo && csvState.sourceTypes[variable.name]) {
                                headerFormatMap[variable.mappedTo] = csvState.sourceTypes[variable.name];
                            }
                        });
                    }

                    const jsonData = lines.slice(1)
                        .map(line => {
                            const values = parseCSVLine(line); // Preserves "000123" correctly
                            const obj = {};
                            headers.forEach((header, i) => {
                                let value = values[i] || '';
                                // Apply source format conversion if this column has one
                                const sourceFormat = headerFormatMap[header];
                                if (sourceFormat && sourceFormat !== 'passthrough') {
                                    value = convertValueBySourceFormat(value, sourceFormat);
                                }
                                obj[header] = value;
                            });
                            return obj;
                        });

                    // Ensure batch name is set
                    if (!csvState.batchName) {
                        csvState.batchName = window.DTBatchConfig.generateDefaultBatchName();
                    }

                    // GitHub Issue #108: Include query param repetition config if detected
                    // GitHub Issue #162: Include source timezone for datetime conversion
                    const executionMessage = {
                        type: 'executeBulkLoadCommand',
                        endpointId: endpointId,
                        jsonData: jsonData,
                        mappings: mappings,
                        batchName: csvState.batchName,
                        sourceType: csvState.sourceType,
                        sourceFileName: csvState.sourceFileName,
                        sourceSheetName: csvState.sourceSheetName,
                        parallelProcessing: window.DTBatchConfig.getSelectedProcessingMode(),
                        // GitHub Issue #162: Source timezone for datetime values
                        sourceTimezone: csvState.sourceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                        // GitHub Issue #307: "Update Endpoint Template", applied after this batch has run
                        templateRenames: csvState.pendingTemplateRenames || undefined,
                        // GitHub Issue #247: links this batch to the run its rows were chained from
                        chainSourceExecutionId: window.ChainPreload ? window.ChainPreload.activeSourceId() : undefined
                    };

                    // Add repeatable query param config if detected
                    if (csvState.queryParamRepetition && csvState.queryParamRepetition.detected) {
                        executionMessage.repeatableQueryParam = {
                            enabled: true,
                            paramKey: csvState.queryParamRepetition.paramKey,
                            pattern: csvState.queryParamRepetition.pattern,
                            separator: csvState.queryParamRepetition.separator,
                            maxUrlLength: csvState.queryParamRepetition.maxUrlLength || 2000,
                            maxPerRequest: csvState.queryParamRepetition.maxPerRequest
                        };
                    }

                    getVscode().postMessage(executionMessage);
                }
            }
        }
    }

    // =========================================================================
    // CSV Line Parsing
    // =========================================================================

    function parseCSVLine(line) {
        // Simple CSV line parser - handles quoted values
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++; // Skip next quote
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current);
        return result;
    }

    // =========================================================================
    // Transformation Preview Update Functions
    // =========================================================================

    function updateTableWithTransformations(transformedHeaders, transformedRows) {
        const tbody = document.getElementById('csvPreviewTableBody');
        if (!tbody || !csvState.currentParsedData || !csvState.currentParsedData.rows) {
            console.warn('⚠️ [CSV Handler] Cannot update table - missing elements or data');
            return;
        }

        const originalRows = csvState.currentParsedData.rows;
        const minRows = Math.min(transformedRows.length, originalRows.length);

        // Update each row in the table
        const tableRows = tbody.querySelectorAll('tr');

        for (let rowIndex = 0; rowIndex < Math.min(minRows, tableRows.length); rowIndex++) {
            const tableRow = tableRows[rowIndex];
            const transformedRow = transformedRows[rowIndex];
            const originalRow = originalRows[rowIndex];
            const tableCells = tableRow.querySelectorAll('td');

            for (let colIndex = 0; colIndex < tableCells.length && colIndex < transformedRow.length; colIndex++) {
                const cell = tableCells[colIndex];
                const transformedValue = transformedRow[colIndex];
                const originalValue = originalRow[colIndex];

                // Update cell with transformed value
                cell.textContent = transformedValue;

                // Add tooltip showing original value if different
                if (transformedValue !== originalValue) {
                    cell.title = `Original: ${originalValue}`;
                    cell.classList.add('transformed-cell'); // Highlight transformed cells
                }
            }
        }
    }

    function showTypeValidationError(columnName, errorMessage) {
        // Find the type selector for this column and add error styling
        const selector = document.querySelector(`.type-selector[data-column-name="${columnName}"]`);
        if (selector) {
            selector.className = 'type-selector type-selector-error';
            selector.title = `Validation Error: ${errorMessage}`;

            // Add error message below selector
            let errorDiv = selector.parentElement.querySelector('.type-error');
            if (!errorDiv) {
                errorDiv = document.createElement('div');
                errorDiv.className = 'type-error inline-error-message';
                selector.parentElement.appendChild(errorDiv);
            }
            errorDiv.textContent = errorMessage;
        }
    }

    function showTypeValidationWarning(columnName, warningMessage) {
        // Find the type selector for this column and add warning styling
        const selector = document.querySelector(`.type-selector[data-column-name="${columnName}"]`);
        if (selector) {
            selector.className = 'type-selector type-selector-warning';
            selector.title = `Validation Warning: ${warningMessage}`;
        }
    }

    function updateCellPreview(columnName, originalValue, convertedValue) {
        // Find cells in this column and update their previews
        const columnIndex = csvState.currentHeaders ? csvState.currentHeaders.indexOf(columnName) : -1;
        if (columnIndex >= 0) {
            const cells = document.querySelectorAll(`td[data-column-index="${columnIndex}"]`);
            cells.forEach((cell, rowIndex) => {
                if (rowIndex < 3) { // Only update first few rows for preview
                    const originalCellValue = cell.getAttribute('data-original-value');
                    if (originalCellValue === originalValue) {
                        // Update cell content with converted value but keep original in tooltip
                        cell.textContent = convertedValue;
                        cell.title = `Original: ${originalValue} → Converted: ${convertedValue}`;
                        cell.classList.add('highlight-cell');
                    }
                }
            });
        }
    }

    function updatePreviewToShowErrors() {
        if (!csvState.errorDetails || csvState.errorDetails.length === 0) {
            return;
        }

        if (!csvState.rawCSVContent) {
            return;
        }

        // Parse the full CSV to get all rows
        const lines = csvState.rawCSVContent.split('\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const dataLines = lines.slice(1).filter(line => line.trim().length > 0);

        // Get unique error row numbers (1-based from error details, need to convert to 0-based for array)
        const errorRowNumbers = [...new Set(csvState.errorDetails.map(e => e.row))].sort((a, b) => a - b);
        // Extract the error rows from the full CSV data
        const errorRows = errorRowNumbers.map(rowNumber => {
            const rowIndex = rowNumber - 2; // Convert from 1-based (including header) to 0-based data array
            if (rowIndex >= 0 && rowIndex < dataLines.length) {
                return dataLines[rowIndex].split(',').map(v => v.trim().replace(/"/g, ''));
            }
            return null;
        }).filter(row => row !== null);

        // Create enhanced preview with error context
        const errorPreview = {
            headers: headers,
            rows: errorRows,
            totalRows: csvState.validationStatistics?.totalRows || dataLines.length,
            fileName: window.currentCSVFileName,
            fileSize: window.currentCSVFileSize,
            isErrorPreview: true,
            errorRowNumbers: errorRowNumbers
        };

        // Store normal preview for toggle functionality
        if (!csvState.originalPreview) {
            csvState.originalPreview = {
                headers: headers,
                rows: dataLines.slice(0, 10).map(line => line.split(',').map(v => v.trim().replace(/"/g, ''))),
                totalRows: csvState.validationStatistics?.totalRows || dataLines.length,
                fileName: window.currentCSVFileName,
                fileSize: window.currentCSVFileSize,
                isErrorPreview: false
            };
        }

        // Update the preview display
        window.DTDataPreview.displayCSVModalPreview(errorPreview);
    }

    // =========================================================================
    // GitHub Issue #135: Coercion Validation Functions
    // =========================================================================

    // State for coercion validation
    let coercionValidationCancelled = false;

    /**
     * Handle sample coercion result from backend
     * Updates the status indicator for a specific variable
     */
    function handleSampleCoercionResult(message) {
        if (!message || message.variableIndex === undefined) return;

        const variableIndex = message.variableIndex;
        const variable = csvState.templateVariables?.[variableIndex];
        if (!variable) return;

        // GitHub Issue #175: Check if this variable has |opt or |null modifiers
        // These make empty values intentional, not warnings
        // Get modifiers - either pre-parsed or parse on-the-fly from modifierString/formatModifier
        let mods = variable.modifiers;
        if (!mods) {
            // Try to parse from modifierString (grid data) or formatModifier (backend data)
            const modString = variable.modifierString || variable.formatModifier;
            if (modString) {
                mods = window.DTDataEntryGrid.parseModifiersForGrid(modString, variable.dataType || 'string');
            }
        }
        const isOptional = mods?.isOptional || false;
        const isNullable = mods?.isNullable || false;
        const hasEmptyBehaviorModifier = isOptional || isNullable;

        // GitHub Issue #175: Filter out "Empty value" warnings for fields with |opt or |null modifiers
        // These are intentional behaviors, not problems
        if (hasEmptyBehaviorModifier && message.coercedSamples) {
            message.coercedSamples = message.coercedSamples.map(sample => {
                if (sample.warning && sample.warning.toLowerCase().includes('empty value')) {
                    // Remove the warning - this is expected behavior
                    return { ...sample, warning: undefined };
                }
                return sample;
            });

            // Recalculate overall status if all warnings were about empty values
            const hasRealWarnings = message.coercedSamples.some(s => s.warning);
            const hasErrors = message.coercedSamples.some(s => !s.success);
            if (!hasRealWarnings && !hasErrors && message.overallStatus === 'warning') {
                message.overallStatus = 'success';
            }
        }

        // Store the coercion result for this variable
        if (!csvState.coercionResults) {
            csvState.coercionResults = {};
        }
        csvState.coercionResults[variable.name] = message;

        // Update the row status indicator
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (!mappingTable) return;

        const row = mappingTable.querySelector(`tr[data-variable="${variable.name}"]`);
        if (!row) return;

        const statusCell = row.querySelector('.status-cell');
        // GitHub Issue #162: Use target sample cell for coerced values display
        const targetSampleCell = row.querySelector('.target-sample-cell');
        if (!statusCell) return;

        // Clear previous status
        statusCell.innerHTML = '';
        statusCell.className = 'status-cell';
        row.classList.remove('has-warning', 'has-error', 'has-coercion-error');

        // GitHub Issue #135: Clear previous Source Format dropdown highlights
        const sourceFormatSelect = row.querySelector('.source-format-select');
        if (sourceFormatSelect) {
            sourceFormatSelect.classList.remove('warning-highlight', 'error-highlight');
        }

        // Remove previous issue text and coerced value if exists
        const existingIssue = targetSampleCell?.querySelector('.issue-text');
        if (existingIssue) {
            existingIssue.remove();
        }
        const existingCoerced = targetSampleCell?.querySelector('.coerced-value');
        if (existingCoerced) {
            existingCoerced.remove();
        }

        // GitHub Issue #162: Update target sample with the coerced value
        // GitHub Issue #175: Apply modifiers (transforms) to show final value
        if (targetSampleCell && message.coercedSamples?.length > 0) {
            // GitHub Issue #175: Handle |opt and |null modifiers for empty values
            // Check if we have an empty value with opt/null modifier
            const firstSample = message.coercedSamples[0];
            const isEmptyOriginal = !firstSample?.original || firstSample.original.trim() === '';

            if (isEmptyOriginal && isOptional) {
                // |opt with empty value - show "excluded" indicator
                targetSampleCell.textContent = '(excluded)';
                targetSampleCell.title = 'Empty value with |opt modifier - key will be excluded from JSON';
                targetSampleCell.classList.add('sample-excluded');
            } else if (isEmptyOriginal && isNullable) {
                // |null with empty value - show "null" indicator
                targetSampleCell.textContent = 'null';
                targetSampleCell.title = 'Empty value with |null modifier - value will be JSON null';
                targetSampleCell.classList.add('sample-null');
            } else {
                // Normal case - find first successful coercion with a value
                const firstSuccess = message.coercedSamples.find(s => s.success && s.coerced !== null && s.coerced !== undefined);
                if (firstSuccess) {
                    // Raw and result are the same sample row, so "raw → result" always pairs up
                    const sourceSampleCell = row.querySelector('.source-sample-cell');
                    if (sourceSampleCell) {
                        const rawText = Array.from(sourceSampleCell.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
                        const original = firstSuccess.original === undefined || firstSuccess.original === '' ? '-' : String(firstSuccess.original);
                        if (rawText) rawText.textContent = original;
                        else sourceSampleCell.insertBefore(document.createTextNode(original), sourceSampleCell.firstChild);
                    }
                    // Apply modifiers to the coerced value for display
                    const targetType = variable.dataType || 'string';
                    let displayValue = String(firstSuccess.coerced);
                    const finalValue = window.CSVHandler.applyModifiersForDisplay(displayValue, variable.name, targetType);

                    targetSampleCell.textContent = finalValue;
                    // Show transformation chain in tooltip
                    if (finalValue !== displayValue) {
                        targetSampleCell.title = `Original: "${firstSuccess.original}" → Coerced: "${displayValue}" → Final: "${finalValue}"`;
                    } else {
                        targetSampleCell.title = `Original: "${firstSuccess.original}" → Converted: "${firstSuccess.coerced}"`;
                    }
                }
            }
        }

        if (message.overallStatus === 'success') {
            // All samples validated successfully
            const successCount = message.coercedSamples?.length || 0;
            statusCell.innerHTML = `<span class="status-indicator status-ok" title="All ${successCount} samples validated successfully">✓</span>`;

            // Clear the type-error notification once no error columns remain — only that one:
            // the footer may be saying something else ("1 unmapped: reorderQty") that still holds.
            const mappingTable = document.querySelector('#columnMappingTable tbody');
            const showing = csvState.activeNotification && csvState.activeNotification.message;
            if (mappingTable && !mappingTable.querySelector('.has-coercion-error')
                && showing && showing.indexOf(TYPE_ERRORS_MESSAGE) === 0) {
                if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
                    window.CSVHandler.clearModalNotification();
                }
            }
        } else if (message.overallStatus === 'warning') {
            // Some samples have warnings (e.g., precision loss)
            const warningCount = message.coercedSamples?.filter(s => s.warning).length || 0;
            const totalCount = message.coercedSamples?.length || 0;
            const firstWarning = message.coercedSamples?.find(s => s.warning)?.warning || 'Warning';
            statusCell.innerHTML = `<span class="status-indicator status-warning" title="${firstWarning} (${totalCount - warningCount}/${totalCount} samples OK)">!</span>`;
            row.classList.add('has-warning');

            // GitHub Issue #135: Highlight Source Format dropdown for warnings
            if (sourceFormatSelect) {
                sourceFormatSelect.classList.add('warning-highlight');
            }

            // Add warning text below target sample value
            if (targetSampleCell && firstWarning) {
                const issueText = document.createElement('div');
                issueText.className = 'issue-text';
                issueText.textContent = firstWarning;
                targetSampleCell.appendChild(issueText);
            }
        } else if (message.overallStatus === 'error') {
            // Some samples failed coercion
            const failedCount = message.failedCount || 0;
            const totalCount = message.coercedSamples?.length || 0;
            const firstError = message.coercedSamples?.find(s => !s.success)?.error || 'Coercion failed';
            statusCell.innerHTML = `<span class="status-indicator status-error" title="${firstError} (${totalCount - failedCount}/${totalCount} samples OK)">✕</span>`;
            row.classList.add('has-error', 'has-coercion-error');

            // GitHub Issue #135: Highlight Source Format dropdown for errors
            if (sourceFormatSelect) {
                sourceFormatSelect.classList.add('error-highlight');
            }

            // Add error text below target sample value
            if (targetSampleCell) {
                const issueText = document.createElement('div');
                issueText.className = 'issue-text';
                issueText.textContent = firstError;
                targetSampleCell.appendChild(issueText);
            }

            // Show footer notification guiding the user
            if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                window.CSVHandler.showModalNotification('warning',
                    TYPE_ERRORS_MESSAGE,
                    { persistent: true }
                );
            }
        }
    }

    /**
     * Handle full coercion result from backend
     * Called when user clicks "Next" from Step 2
     */
    function handleFullCoercionResult(message) {
        hideCoercionProgress();
        coercionValidationCancelled = false;

        if (message.error) {
            window.CSVHandler.showCSVError(`Validation error: ${message.error}`);
            resetNavBtn();
            return;
        }

        if (!message.success) {
            // Coercion issues found — show as warnings in mapping table, but proceed to Step 3
            // User must fix the data in the grid (Step 3) before advancing to Step 4
            showValidationErrors(message);

            const errorCount = message.rowsWithErrors || 0;
            window.CSVHandler.showModalNotification('warning',
                `${errorCount} row${errorCount !== 1 ? 's have' : ' has'} type issues. Fix in the source file and re-upload, or click Next to fix errors directly in the grid.`,
                { persistent: true }
            );
        }

        // Proceed — check for nested array sorting, then advance to Step 3
        checkNestedArraySorting();
    }

    /**
     * GitHub Issue #148: Check if template has nested arrays that require sorted data
     * Called after coercion validation passes, before proceeding to step 3
     */
    function checkNestedArraySorting() {
        // Get template body from endpoint config
        const templateBody = csvState.endpointConfig?.body || csvState.endpointConfig?.bodyWithComments || '';

        // Skip if no template body (query-only endpoints, etc.)
        if (!templateBody || templateBody.trim() === '') {
            proceedToNextStep();
            return;
        }

        // Build variable-to-column mapping and variable names list
        // mappedColumns = variable NAMES (what backend looks for in template)
        // variableToColumn = mapping from variable name to CSV column name (for sorting)
        const variableToColumn = {};
        csvState.templateVariables?.forEach(v => {
            if (v.mappedTo) {
                variableToColumn[v.name] = v.mappedTo;
            }
        });

        // For grid data: columns ARE the variables (same name)
        if (csvState.sourceType === 'grid' && csvState.gridTemplateVariables) {
            csvState.gridTemplateVariables.forEach(v => {
                variableToColumn[v.name] = v.name;
            });
        }

        const mappedColumns = Object.keys(variableToColumn);

        if (mappedColumns.length === 0) {
            proceedToNextStep();
            return;
        }

        // Send request to backend to analyze sorting requirements (template only — no CSV data)
        getVscode().postMessage({
            type: 'analyzeNestedArraySorting',
            templateBody: templateBody,
            mappedColumns: mappedColumns,
            variableToColumn: variableToColumn
        });
        // Response will be handled by handleSortingAnalysisResult
    }

    /**
     * GitHub Issue #148: Handle sorting analysis result from backend
     */
    function handleSortingAnalysisResult(message) {
        if (message.error) {
            csvState.sortingStageResult = { label: 'Sort check skipped (error)' };
            proceedToNextStep();
            return;
        }

        if (!message.requiresSorting) {
            csvState.sortingStageResult = { label: 'No sorting needed' };
            proceedToNextStep();
            return;
        }

        var sortColumns = message.sortColumns || [];
        csvState.sortingInfo = {
            sortColumns: sortColumns,
            arrayPaths: message.arrayPaths || [],
            explanation: message.explanation || ''
        };

        // GitHub Issue #223: Sort check + sort done locally (no CSV sent to backend)
        var sorted = isDataSortedFrontend(sortColumns);
        if (sorted) {
            csvState.sortingStageResult = { label: 'Already sorted by ' + sortColumns.join(', ') };
            proceedToNextStep();
            return;
        }

        // Auto-sort in memory
        sortCSVDataInMemory(sortColumns);
        csvState.sortingDecision = 'sorted';
        csvState.sortingStageResult = { label: 'Sorted by ' + sortColumns.join(', ') };

        proceedToNextStep();
    }

    // GitHub Issue #148: showSortingOptInModal() removed - auto-sort replaces the modal flow

    /**
     * GitHub Issue #148: Request detailed explanation from backend
     */
    function requestSortingExplanation(event) {
        event.preventDefault();

        const sortColumns = csvState.sortingInfo?.sortColumns || [];
        const arrayPaths = csvState.sortingInfo?.arrayPaths || [];

        getVscode().postMessage({
            type: 'getSortingExplanation',
            sortColumns: sortColumns,
            arrayPaths: arrayPaths
        });
    }

    // Expose for onclick handler
    window.requestSortingExplanation = requestSortingExplanation;

    /**
     * GitHub Issue #148: Handle explanation response from backend
     */
    function handleSortingExplanation(message) {
        const explanation = message.explanation || 'No explanation available.';

        // Show in a simple alert or update the modal
        getVscode().postMessage({
            type: 'showInfo',
            message: explanation
        });
    }

    // GitHub Issue #148: skipSorting() removed - auto-sort replaces the modal flow

    // GitHub Issue #148: applySorting() removed - auto-sort replaces the modal flow

    /**
     * GitHub Issue #223: Check if in-memory parsed data is already sorted by the specified columns.
     * Replicates the hierarchical check from csv-sorting.service.ts:isDataSorted()
     * using csvState.currentHeaders and csvState.currentParsedData.rows.
     */
    function isDataSortedFrontend(sortColumns) {
        var headers = csvState.currentHeaders;
        var rows = csvState.currentParsedData && csvState.currentParsedData.rows;
        if (!headers || !rows || rows.length <= 1 || sortColumns.length === 0) {
            return true;
        }

        var columnIndices = sortColumns.map(function (col) { return headers.indexOf(col); }).filter(function (i) { return i >= 0; });
        if (columnIndices.length === 0) {
            return true;
        }

        for (var i = 1; i < rows.length; i++) {
            var currRow = rows[i];
            for (var colPos = 0; colPos < columnIndices.length; colPos++) {
                var colIndex = columnIndices[colPos];
                var prevValue = rows[i - 1][colIndex] || '';
                var currValue = currRow[colIndex] || '';

                if (prevValue !== currValue) {
                    // Check if currValue appeared earlier within the same parent group
                    for (var j = 0; j < i - 1; j++) {
                        var sameParentGroup = true;
                        for (var pk = 0; pk < colPos; pk++) {
                            if (rows[j][columnIndices[pk]] !== currRow[columnIndices[pk]]) {
                                sameParentGroup = false;
                                break;
                            }
                        }
                        if (sameParentGroup && rows[j][colIndex] === currValue) {
                            return false;
                        }
                    }
                }
            }
        }

        return true;
    }

    /**
     * GitHub Issue #148: Sort CSV data in memory and update state
     */
    function sortCSVDataInMemory(sortColumns) {
        if (!csvState.currentHeaders || !csvState.currentParsedData?.rows) {
            return;
        }

        const headers = csvState.currentHeaders;
        const rows = csvState.currentParsedData.rows;

        // Get column indices for sorting
        const columnIndices = sortColumns.map(col => headers.indexOf(col)).filter(i => i >= 0);

        if (columnIndices.length === 0) {
            return;
        }

        // Sort rows by the specified columns
        const sortedRows = [...rows].sort((a, b) => {
            for (const colIndex of columnIndices) {
                const aVal = a[colIndex] || '';
                const bVal = b[colIndex] || '';
                const comparison = String(aVal).localeCompare(String(bVal));
                if (comparison !== 0) {
                    return comparison;
                }
            }
            return 0;
        });

        // Update state with sorted data
        csvState.currentParsedData.rows = sortedRows;

        // Rebuild raw CSV content if we have it
        if (csvState.rawCSVContent) {
            csvState.rawCSVContent = rebuildCSVContent(headers, sortedRows);
        }

        // Update transformed rows if present
        if (csvState.transformedRows) {
            csvState.transformedRows = sortedRows;
        }

        // Mark data as sorted
        csvState.dataSorted = true;
        csvState.sortedByColumns = sortColumns;
    }

    /**
     * GitHub Issue #148: Rebuild CSV string from headers and rows
     */
    function rebuildCSVContent(headers, rows) {
        const delimiter = csvState.detectedDelimiter || ',';

        const escapeCell = (cell) => {
            const str = String(cell || '');
            if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const headerLine = headers.map(escapeCell).join(delimiter);
        const dataLines = rows.map(row => row.map(escapeCell).join(delimiter));

        return [headerLine, ...dataLines].join('\n');
    }

    // GitHub Issue #148: closeSortingModal() removed - auto-sort replaces the modal flow

    /**
     * Apply source format conversions to parsed CSV rows before grid population.
     * Step 2 validates and previews conversions — Step 3 should show converted values.
     * Uses the frontend convertValueBySourceFormat() for each mapped column.
     */
    function applySourceFormatToRows(headers, rows, templateVars) {
        if (!rows || rows.length === 0 || !templateVars || !csvState.sourceTypes) {
            return rows;
        }

        // Build column-index → {sourceFormat, dataType} map for non-string columns
        const columnConversions = new Map();
        templateVars.forEach(v => {
            if (!v.mappedTo) return;
            const dataType = v.dataType || 'string';
            if (dataType === 'string') return; // STRING never gets converted

            const sourceFormat = csvState.sourceTypes[v.name] || getDefaultSourceFormat(dataType);
            if (sourceFormat === 'passthrough') return; // No conversion needed

            const colIdx = headers.indexOf(v.mappedTo);
            if (colIdx >= 0) {
                columnConversions.set(colIdx, sourceFormat);
            }
        });

        if (columnConversions.size === 0) return rows;

        return rows.map(row => {
            const converted = [...row];
            columnConversions.forEach((sourceFormat, colIdx) => {
                if (colIdx < converted.length && converted[colIdx]) {
                    converted[colIdx] = convertValueBySourceFormat(converted[colIdx], sourceFormat);
                }
            });
            return converted;
        });
    }

    /**
     * GitHub Issue #223: Batched version of applySourceFormatToRows — 5000 rows per rAF.
     * @param {string[]} headers
     * @param {string[][]} rows
     * @param {Array} templateVars
     * @param {Function} onProgress - (processed, total)
     * @param {Function} onComplete - (convertedRows)
     */
    function applySourceFormatToRowsBatchedImpl(headers, rows, templateVars, onProgress, onComplete) {
        if (!rows || rows.length === 0 || !templateVars || !csvState.sourceTypes) {
            if (onProgress) onProgress(rows ? rows.length : 0, rows ? rows.length : 0);
            if (onComplete) onComplete(rows || []);
            return;
        }

        // Build column-index → sourceFormat map (same as sync version)
        var columnConversions = new Map();
        templateVars.forEach(function (v) {
            if (!v.mappedTo) return;
            var dataType = v.dataType || 'string';
            if (dataType === 'string') return;
            var sourceFormat = csvState.sourceTypes[v.name] || getDefaultSourceFormat(dataType);
            if (sourceFormat === 'passthrough') return;
            var colIdx = headers.indexOf(v.mappedTo);
            if (colIdx >= 0) {
                columnConversions.set(colIdx, sourceFormat);
            }
        });

        if (columnConversions.size === 0) {
            if (onProgress) onProgress(rows.length, rows.length);
            if (onComplete) onComplete(rows);
            return;
        }

        var BATCH_SIZE = 5000;
        var totalRows = rows.length;
        var result = new Array(totalRows);
        var offset = 0;

        function processBatch() {
            var end = Math.min(offset + BATCH_SIZE, totalRows);
            for (var r = offset; r < end; r++) {
                var converted = rows[r].slice();
                columnConversions.forEach(function (sourceFormat, colIdx) {
                    if (colIdx < converted.length && converted[colIdx]) {
                        converted[colIdx] = convertValueBySourceFormat(converted[colIdx], sourceFormat);
                    }
                });
                result[r] = converted;
            }
            offset = end;
            if (onProgress) onProgress(offset, totalRows);

            if (offset < totalRows) {
                requestAnimationFrame(processBatch);
            } else {
                if (onComplete) onComplete(result);
            }
        }

        requestAnimationFrame(processBatch);
    }

    /**
     * GitHub Issue #148: Proceed to the next step after sorting check
     * GitHub Issue #223: Stacked progress bars + button gradient fill during Step 2→3 transition
     *
     * Flow: Show progress UI → rAF (so UI renders) → parse CSV (sync, blocking) →
     *       batch convert → batch build grid → batch validate → show step 3
     */
    function proceedToNextStep() {
        csvState.sortingPending = false;

        // GitHub Issue #202/#223: When advancing from Step 2 to Step 3, populate grid with mapped data
        if (csvState.modalStep === 2 && window.DTDataEntryGrid && window.DTDataEntryGrid.populateGridFromMappedData) {
            var nextBtn = document.getElementById('csvNextBtn');
            var templateVars = csvState.templateVariables || csvState.gridTemplateVariables || [];
            var DTGrid = window.DTDataEntryGrid;

            // Check if batched functions are available
            var useBatched = DTGrid.showStepTransitionProgress &&
                DTGrid.populateGridFromMappedDataBatched;

            // Issue #312: Next is disabled while the grid builds, but keeps its label — "Processing..."
            // widened it and wrapped the footer under the progress bar, shifting the buttons.
            if (!useBatched) {
                if (nextBtn) nextBtn.disabled = true;
                requestAnimationFrame(function () {
                    var parsedData = getParsedDataForStep3();
                    parsedData.rows = applySourceFormatToRows(parsedData.headers, parsedData.rows, templateVars);
                    DTGrid.populateGridFromMappedData(parsedData, templateVars);
                    window.CSVHandler.showCSVStep(csvState.modalStep + 1);
                    csvState.navigationInProgress = false;
                });
                return;
            }

            // Progress for the Step 2→3 transition, in the step bar
            var fpUpdate = window.DTDataIngestion.updateFileProgress;
            if (nextBtn) nextBtn.disabled = true;

            // Stage ranges: sorting(0-10%), parsing(10-30%), converting(30-60%), building(60-85%), validating(85-100%)
            function footerPct(stageStart, stageEnd, stagePct) {
                return Math.round(stageStart + (stagePct / 100) * (stageEnd - stageStart));
            }

            // Stage 1: Sorting — already completed
            fpUpdate(10, 'Checking sort...');

            // Stage 2: Parsing — rAF so UI paints before blocking parse
            fpUpdate(10, 'Parsing data...');

            requestAnimationFrame(function () {
                var parsedData = getParsedDataForStep3();
                fpUpdate(30, 'Parsing data...');

                // Stage 3: Converting formats (batched, non-blocking)
                fpUpdate(30, 'Converting formats...');

                applySourceFormatToRowsBatchedImpl(parsedData.headers, parsedData.rows, templateVars,
                    function (processed, total) {
                        var pct = total > 0 ? Math.round((processed / total) * 100) : 100;
                        fpUpdate(footerPct(30, 60, pct), 'Converting formats...');
                    },
                    function (convertedRows) {
                        fpUpdate(60, 'Converting formats...');
                        parsedData.rows = convertedRows;

                        // Stage 4: Building grid (batched, non-blocking)
                        fpUpdate(60, 'Building grid...');

                        DTGrid.populateGridFromMappedDataBatched(parsedData, templateVars,
                            function (processed, total) {
                                var pct = total > 0 ? Math.round((processed / total) * 100) : 100;
                                fpUpdate(footerPct(60, 85, pct), 'Building grid...');
                            },
                            function () {
                                fpUpdate(85, 'Building grid...');

                                // Stage 5: Validating data (batched, non-blocking)
                                fpUpdate(85, 'Validating data...');

                                DTGrid.validateDataModelInBackgroundBatched(
                                    function (processed, total) {
                                        var pct = total > 0 ? Math.round((processed / total) * 100) : 100;
                                        fpUpdate(footerPct(85, 100, pct), 'Validating data...');
                                    },
                                    function () {
                                        // Complete
                                        fpUpdate(100, 'Complete');
                                        setTimeout(function () {
                                            fpUpdate(0, '');
                                        }, 1000);
                                        window.CSVHandler.showCSVStep(csvState.modalStep + 1);
                                        csvState.navigationInProgress = false;
                                    }
                                );
                            }
                        );
                    }
                );
            });

            return;
        }

        window.CSVHandler.showCSVStep(csvState.modalStep + 1);
        csvState.navigationInProgress = false;
    }

    /**
     * GitHub Issue #223: Get parsed data for Step 3 grid population
     */
    function getParsedDataForStep3() {
        if (csvState.rawCSVContent && window.CSVHandler && window.CSVHandler.parseDelimitedContent) {
            var fullParsed = window.CSVHandler.parseDelimitedContent(csvState.rawCSVContent, csvState.detectedDelimiter);
            return { headers: fullParsed.headers, rows: fullParsed.rows };
        }
        return csvState.currentParsedData || { headers: csvState.currentHeaders || [], rows: window.currentParsedCsvData || [] };
    }

    // GitHub Issue #223: Excel fast path (getExcelSheetAsArrays) was removed —
    // serializing 111k×56 cells through postMessage IPC caused multi-minute freezes.
    // All sources now use the CSV parsing path with batched progress.

    /**
     * Show validation errors in the mapping table
     */
    function showValidationErrors(result) {
        if (!result.columnResults) return;

        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (!mappingTable) return;

        result.columnResults.forEach(colResult => {
            if (colResult.overallStatus === 'error') {
                const row = mappingTable.querySelector(`tr[data-variable="${colResult.columnName}"]`);
                if (row) {
                    row.classList.add('has-coercion-error');
                    const statusCell = row.querySelector('.status-cell');
                    if (statusCell) {
                        statusCell.innerHTML = `<span class="status-indicator status-error" title="${colResult.failedCount} rows failed coercion">✕</span>`;
                    }
                }
            }
        });

        // Show error summary
        const errorsContainer = document.getElementById('mappingErrors');
        if (errorsContainer) {
            errorsContainer.classList.remove('hidden');
            let errorHtml = '<h5 class="color-error">Validation Errors:</h5><ul class="m-0">';
            result.columnResults.filter(c => c.overallStatus === 'error').forEach(col => {
                errorHtml += `<li class="mb-8 font-size-13">${col.columnName}: ${col.failedCount} rows failed</li>`;
            });
            errorHtml += '</ul>';
            errorsContainer.innerHTML = errorHtml;
        }
    }

    /**
     * Show coercion progress modal
     */
    function showCoercionProgress() {
        const modal = document.getElementById('coercionValidationProgress');
        if (modal) {
            modal.classList.remove('hidden');
            updateCoercionProgress(0, 0, 0);
        }
    }

    /**
     * Hide coercion progress modal
     */
    function hideCoercionProgress() {
        const modal = document.getElementById('coercionValidationProgress');
        if (modal) {
            modal.classList.add('hidden');
        }
        const errorCountEl = document.getElementById('coercionErrorCount');
        if (errorCountEl) {
            errorCountEl.classList.add('hidden');
        }
    }

    /**
     * Update coercion progress display
     */
    function updateCoercionProgress(percentage, current, total) {
        const progressBar = document.getElementById('coercionProgressBar');
        const progressText = document.getElementById('coercionProgressText');

        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
        }
        if (progressText) {
            progressText.textContent = `${Math.round(percentage)}% (${current}/${total})`;
        }
    }

    /**
     * Cancel coercion validation
     */
    function cancelCoercionValidation() {
        coercionValidationCancelled = true;
        hideCoercionProgress();
        resetNavBtn();
    }

    /**
     * GitHub Issue #223: Reset Next button after navigation failure
     */
    function resetNavBtn() {
        csvState.navigationInProgress = false;
        var btn = document.getElementById('csvNextBtn');
        if (btn && btn.dataset.loadingProgress !== 'true') {
            btn.disabled = false;
            btn.textContent = 'Next';
        }
    }

    // Expose cancelCoercionValidation globally for onclick handler
    window.cancelCoercionValidation = cancelCoercionValidation;

    /**
     * Start full coercion validation
     * Builds mappings from current state and sends to backend
     */
    function startFullCoercionValidation() {
        if (!csvState.templateVariables || !csvState.currentHeaders) {
            resetNavBtn();
            return;
        }

        // Build validation mappings
        // GitHub Issue #137, #165: Filter out A8 system variables and ENV variables
        const mappings = [];
        const userVariables = csvState.templateVariables.filter(v => {
            const name = v.name || '';
            if (name.toUpperCase().startsWith('A8:')) return false;
            if (name.toUpperCase().startsWith('ENV:')) return false;
            return true;
        });

        userVariables.forEach(variable => {
            if (variable.mappedTo) {
                mappings.push({
                    variableName: variable.name,
                    csvColumn: variable.mappedTo,
                    targetType: variable.dataType || 'string',
                    sourceFormat: csvState.sourceTypes?.[variable.name] || getDefaultSourceFormat(variable.dataType || 'string')
                });
            }
        });

        if (mappings.length === 0) {
            // No mappings to validate - proceed directly
            window.CSVHandler.showCSVStep(csvState.modalStep + 1);
            resetNavBtn();
            return;
        }

        // Get all rows for validation
        let rows = [];
        if (csvState.currentParsedData && csvState.currentParsedData.rows) {
            rows = csvState.currentParsedData.rows;
        } else if (window.currentParsedCsvData) {
            rows = window.currentParsedCsvData;
        }

        if (rows.length === 0) {
            // No data to validate - proceed directly
            window.CSVHandler.showCSVStep(csvState.modalStep + 1);
            resetNavBtn();
            return;
        }

        // Show progress modal
        showCoercionProgress();
        updateCoercionProgress(0, 0, rows.length);

        // Send validation request to backend
        getVscode().postMessage({
            type: 'validateFullCoercion',
            validationMappings: mappings,
            rows: rows,
            headers: csvState.currentHeaders
        });
    }

    /**
     * Trigger sample coercion validation for a variable
     * Collects sample values and sends to backend
     */
    function triggerSampleCoercionValidation(variableName, variableIndex) {
        const variable = csvState.templateVariables?.[variableIndex];
        if (!variable || !variable.mappedTo) return;

        // Get sample values - up to 10 rows
        const sampleValues = [];
        const columnIndex = csvState.currentHeaders.indexOf(variable.mappedTo);

        if (columnIndex >= 0) {
            let rows = [];
            if (csvState.currentParsedData && csvState.currentParsedData.rows) {
                rows = csvState.currentParsedData.rows;
            } else if (window.currentParsedCsvData) {
                rows = window.currentParsedCsvData;
            }

            // Collect up to 10 sample values
            const sampleCount = Math.min(10, rows.length);
            for (let i = 0; i < sampleCount; i++) {
                const value = rows[i][columnIndex];
                sampleValues.push(value !== undefined ? String(value) : '');
            }
        }

        if (sampleValues.length === 0) return;

        // Store sample values for re-validation when format changes
        if (!csvState.sampleValues) {
            csvState.sampleValues = {};
        }
        csvState.sampleValues[variableName] = sampleValues;

        // Send validation request to backend
        getVscode().postMessage({
            type: 'validateSampleCoercion',
            variableIndex: variableIndex,
            columnName: variable.name,
            targetType: variable.dataType || 'string',
            sourceFormat: csvState.sourceTypes?.[variableName] || getDefaultSourceFormat(variable.dataType || 'string'),
            sampleValues: sampleValues
        });
    }

    // =========================================================================
    // Column Mapping Functions
    // GitHub Issue #135: Source Format options for data transformation
    // Source formats are available for ALL target types - user may want to transform
    // COBOL/Scientific/Currency data even when storing as string
    // =========================================================================

    const SOURCE_FORMAT_OPTIONS = [
        { value: 'passthrough', label: 'No Transform', group: 'general' },
        { value: 'standard', label: 'Standard Number', group: 'number' },
        { value: 'cobol', label: 'COBOL', group: 'number' },
        { value: 'scientific', label: 'Scientific', group: 'number' },
        { value: 'currency', label: 'Currency', group: 'number' },
        { value: 'auto_date', label: 'Auto-detect Date', group: 'date' },
        { value: 'yyyy-mm-dd', label: 'YYYY-MM-DD', group: 'date' },
        { value: 'mm-dd-yyyy', label: 'MM/DD/YYYY', group: 'date' },
        { value: 'dd-mm-yyyy', label: 'DD/MM/YYYY', group: 'date' },
        { value: 'unix_timestamp', label: 'Unix Timestamp', group: 'date' },
        { value: 'iso_8601', label: 'ISO 8601', group: 'date' },
        // GitHub Issue #162: Excel serial date support
        { value: 'excel_serial', label: 'Excel Serial Date', group: 'date' },
        { value: 'boolean', label: 'Boolean (true/false/1/0)', group: 'boolean' }
    ];

    // Get all source format options (available for any target type)
    function getSourceFormatOptions(targetType) {
        // Return all options - user can choose any source format regardless of target type
        return SOURCE_FORMAT_OPTIONS;
    }

    // Get default source format - suggest based on target type but don't restrict
    function getDefaultSourceFormat(targetType) {
        const normalizedType = (targetType || 'string').toLowerCase();
        switch (normalizedType) {
            case 'number':
            case 'integer':
            case 'int':
                return 'standard';
            case 'date':
                return 'auto_date';
            case 'boolean':
            case 'bool':
                return 'boolean';
            case 'string':
            default:
                return 'passthrough';
        }
    }

    /**
     * GitHub Issue #135: Convert value based on source format
     * Applies source format transformation in frontend before sending to backend
     * This is necessary because backend uses naive CSV parsing that breaks quoted values
     */
    function convertValueBySourceFormat(value, sourceFormat) {
        if (value === null || value === undefined || value === '') {
            return value;
        }

        const trimmed = String(value).trim();

        switch (sourceFormat) {
            case 'cobol':
                // COBOL format: +000000099.9900 or -000000020.0000
                const sign = trimmed.startsWith('-') ? -1 : 1;
                const numberPart = trimmed.replace(/^[+-]/, '');
                const cobolNum = parseFloat(numberPart) * sign;
                return isNaN(cobolNum) ? value : cobolNum.toString();

            case 'currency':
                // Currency format: $1,234.56 or €99.99 or £1,000.00
                const cleanedCurrency = trimmed.replace(/[$€£¥₹,\s]/g, '');
                const currencyNum = parseFloat(cleanedCurrency);
                return isNaN(currencyNum) ? value : currencyNum.toString();

            case 'scientific':
                // Scientific notation: 1.23E+04 - JavaScript handles natively
                const sciNum = parseFloat(trimmed);
                return isNaN(sciNum) ? value : sciNum.toString();

            case 'standard':
                // Standard number - remove thousand separators
                const cleanedStandard = trimmed.replace(/,/g, '');
                const stdNum = parseFloat(cleanedStandard);
                return isNaN(stdNum) ? value : stdNum.toString();

            case 'excel_serial':
                // GitHub Issue #162: Excel serial date (days since 1899-12-30)
                // Convert to ISO date string (YYYY-MM-DD)
                const serialNum = parseFloat(trimmed);
                if (!isNaN(serialNum) && serialNum >= 1) {
                    // Excel's epoch quirk: serial <= 60 uses 25567, > 60 uses 25569
                    const daysOffset = serialNum <= 60 ? 25567 : 25569;
                    const date = new Date((serialNum - daysOffset) * 86400000);
                    return date.toISOString().split('T')[0];
                }
                return value;

            case 'passthrough':
            default:
                return value;
        }
    }

    /**
     * GitHub Issue #135: Apply source format conversions to CSV data
     * Converts values based on user-selected source formats before sending to backend
     */
    function applySourceFormatConversions(csvContent) {
        // Grid data is already in target format — source format conversion was applied
        // during Step 2→3 transition. Don't double-convert.
        if (csvState.sourceType === 'grid') {
            return csvContent;
        }

        if (!csvContent || !csvState.sourceTypes || Object.keys(csvState.sourceTypes).length === 0) {
            return csvContent;
        }

        try {
            const lines = csvContent.split('\n');
            if (lines.length < 2) return csvContent;

            const headers = parseCSVLine(lines[0]);
            const convertedLines = [lines[0]]; // Keep original header

            // Build column index to source format map
            // GitHub Issue #218: Only include non-string columns — STRING never gets format conversion
            const columnFormatMap = {};
            for (const [varName, format] of Object.entries(csvState.sourceTypes)) {
                // Find which CSV column maps to this variable
                const variable = csvState.templateVariables?.find(v => v.name === varName);
                if (variable && variable.mappedTo) {
                    // Skip string-typed variables — STRING is default, never convert
                    const varDataType = variable.dataType || 'string';
                    if (varDataType === 'string') continue;

                    const colIndex = headers.indexOf(variable.mappedTo);
                    if (colIndex >= 0) {
                        columnFormatMap[colIndex] = format;
                    }
                }
            }

            // Convert each data row
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const values = parseCSVLine(line);
                const convertedValues = values.map((val, idx) => {
                    const format = columnFormatMap[idx];
                    if (format && format !== 'passthrough') {
                        return convertValueBySourceFormat(val, format);
                    }
                    return val;
                });

                // Rebuild CSV line - simple join since converted values won't have commas
                convertedLines.push(convertedValues.join(','));
            }

            return convertedLines.join('\n');
        } catch (error) {
            console.error('[CSV Handler] Error applying source format conversions:', error);
            return csvContent;
        }
    }

    // =========================================================================
    // GitHub Issue #218: STRING filter helper
    // =========================================================================

    /**
     * Filter out STRING columns from a column types object.
     * STRING is default — string columns never need transformation.
     * Returns a new object containing only non-string column types.
     */
    function filterNonStringTypes(columnTypes) {
        const filtered = {};
        Object.entries(columnTypes).forEach(([col, type]) => {
            if (type !== 'string') {
                filtered[col] = type;
            }
        });
        return filtered;
    }

    // =========================================================================
    // Module Public API
    // =========================================================================

    function init(sharedState, vscodeFn) {
        csvState = sharedState;
        getVscode = vscodeFn;
    }

    window.DTTypeCoercion = {
        init: init,

        // Type detection
        detectAndDisplayColumnTypes: detectAndDisplayColumnTypes,
        handleTypeDetectionResult: handleTypeDetectionResult,
        handleTypeSelection: handleTypeSelection,
        populateTypeSelectors: populateTypeSelectors,
        populateTypeSelectorsWithDefaults: populateTypeSelectorsWithDefaults,
        restoreSavedTypeSelections: restoreSavedTypeSelections,

        // Transformation preview
        applyTransformationsToPreview: applyTransformationsToPreview,
        transformValueForDisplay: transformValueForDisplay,
        handleTypeConversionValidation: handleTypeConversionValidation,
        handleTypeTransformationResult: handleTypeTransformationResult,
        updatePreviewToShowErrors: updatePreviewToShowErrors,

        // CSV utilities
        parseCSVLine: parseCSVLine,
        createCSVStringFromData: createCSVStringFromData,
        createCSVStringFromCurrentData: createCSVStringFromCurrentData,

        // Coercion validation
        handleSampleCoercionResult: handleSampleCoercionResult,
        handleFullCoercionResult: handleFullCoercionResult,
        startFullCoercionValidation: startFullCoercionValidation,
        triggerSampleCoercionValidation: triggerSampleCoercionValidation,
        cancelCoercionValidation: cancelCoercionValidation,
        showCoercionProgress: showCoercionProgress,
        hideCoercionProgress: hideCoercionProgress,
        updateCoercionProgress: updateCoercionProgress,

        // Sorting (GitHub Issue #148)
        checkNestedArraySorting: checkNestedArraySorting,
        handleSortingAnalysisResult: handleSortingAnalysisResult,
        handleSortingExplanation: handleSortingExplanation,
        sortCSVDataInMemory: sortCSVDataInMemory,

        // Source format conversion (GitHub Issue #135)
        SOURCE_FORMAT_OPTIONS: SOURCE_FORMAT_OPTIONS,
        getSourceFormatOptions: getSourceFormatOptions,
        getDefaultSourceFormat: getDefaultSourceFormat,
        convertValueBySourceFormat: convertValueBySourceFormat,
        applySourceFormatConversions: applySourceFormatConversions,

        // GitHub Issue #218: STRING filter
        filterNonStringTypes: filterNonStringTypes,

        // GitHub Issue #223: Batched source format conversion
        applySourceFormatToRows: applySourceFormatToRows,
        applySourceFormatToRowsBatched: applySourceFormatToRowsBatchedImpl
    };
})();
