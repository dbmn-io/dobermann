// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Data Preview
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Contains CSV/JSON/query-string preview and data refresh:
 * - CSV preview display (simple and modal)
 * - JSON preview with Monaco editor
 * - Query string preview (GitHub Issue #108)
 * - URL sample preview for query-param-only endpoints
 * - Data refresh for Steps 3/4/5
 * - Sampled CSV data helper
 */
(function () {
    'use strict';

    // Module-level references (set via init)
    let csvState = null;
    let getVscode = null;

    // Constants (mirrored from orchestrator)
    const PREVIEW_SAMPLE_SIZE = 50; // Number of rows to process for preview/validation

    // =========================================================================
    // CSV Preview and Display
    // =========================================================================

    function displayCSVPreview(preview) {

        const previewContainer = document.getElementById('csvPreview');
        if (!previewContainer) {
            return;
        }

        // Clear previous preview
        previewContainer.innerHTML = '';
        if (!preview) {
            previewContainer.innerHTML = '<p class="no-data">No data provided for preview</p>';
            return;
        }
        if (!preview.headers || !Array.isArray(preview.headers) || preview.headers.length === 0) {
            previewContainer.innerHTML = '<p class="no-data">No column headers found in data</p>';
            return;
        }

        if (!preview.rows || !Array.isArray(preview.rows)) {
            previewContainer.innerHTML = '<p class="no-data">No data rows found to preview</p>';
            return;
        }

        // Create table
        const table = document.createElement('table');
        table.className = 'csv-preview-table';

        // Create header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        preview.headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Create body
        const tbody = document.createElement('tbody');
        if (preview.rows && Array.isArray(preview.rows)) {
            preview.rows.forEach(row => {
                const tr = document.createElement('tr');
                if (Array.isArray(row)) {
                    row.forEach(cell => {
                        const td = document.createElement('td');
                        td.textContent = cell;
                        td.title = cell; // Tooltip for long values
                        tr.appendChild(td);
                    });
                }
                tbody.appendChild(tr);
            });
        }
        table.appendChild(tbody);

        previewContainer.appendChild(table);

        // Add row count message
        if (preview.totalRows > preview.rows.length) {
            const message = document.createElement('p');
            message.className = 'preview-message';
            message.textContent = `Showing ${preview.rows.length} of ${preview.totalRows} rows`;
            previewContainer.appendChild(message);
        }
    }

    function displayCSVModalPreview(preview) {

        const previewContainer = document.getElementById('csvModalPreview');
        if (!previewContainer) return;

        // IMPORTANT: Hide the simple CSV preview to avoid showing two tables
        const simplePreview = document.getElementById('csvPreview');
        if (simplePreview) {
            simplePreview.classList.add('hidden');
        }

        // Create compact file info at the very top first
        const fileInfo = document.createElement('div');
        fileInfo.className = 'csv-file-info file-info-box';
        fileInfo.innerHTML = `
            <span class="file-label">File:</span> <strong>${window.currentCSVFileName || 'Uploaded CSV'}</strong>
            <span class="file-label">Columns:</span> <strong>${preview.headers.length}</strong>
            <span class="file-label">Rows:</span> <strong>${preview.totalRows}</strong>
        `;

        // Clear container and add file info first
        previewContainer.innerHTML = '';
        previewContainer.appendChild(fileInfo);

        if (!preview || !preview.headers || preview.headers.length === 0) {
            previewContainer.innerHTML += '<p class="no-data">No CSV data to preview</p>';
            return;
        }

        // Create table for preview
        const table = document.createElement('table');
        table.className = 'csv-preview-table';

        // Header
        const thead = document.createElement('thead');

        // Original header row
        const headerRow = document.createElement('tr');
        preview.headers.forEach((header, index) => {
            const th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);

        // Add type selector row to thead
        const typeRow = document.createElement('tr');
        typeRow.className = 'type-selector-row';
        typeRow.id = 'typeSelectorsRow';
        preview.headers.forEach((header, index) => {
            const th = document.createElement('th');

            // Create type selector dropdown
            const select = document.createElement('select');
            select.className = 'type-selector';
            select.setAttribute('data-column-index', index);
            select.setAttribute('data-column-name', header);

            // Add default options - will be populated by type detection
            select.innerHTML = `
                <option value="string">Detecting...</option>
            `;

            // Add event listener for type changes
            select.addEventListener('change', function () {
                window.DTTypeCoercion.handleTypeSelection(header, this.value, index);
            });

            th.appendChild(select);
            typeRow.appendChild(th);
        });
        thead.appendChild(typeRow);

        table.appendChild(thead);

        // Body (limited rows) - will show transformed values
        const tbody = document.createElement('tbody');
        tbody.id = 'csvPreviewTableBody';
        preview.rows.forEach(row => {
            const tr = document.createElement('tr');
            row.forEach((cell, cellIndex) => {
                const td = document.createElement('td');
                td.textContent = cell;
                td.title = `Original: ${cell}`;
                td.setAttribute('data-original-value', cell);
                td.setAttribute('data-column-index', cellIndex);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        previewContainer.appendChild(table);


        // Add preview info message
        if (preview.totalRows > preview.rows.length && !preview.isErrorPreview) {
            const message = document.createElement('p');
            message.className = 'preview-message';
            message.textContent = `Preview showing first ${preview.rows.length} rows`;
            previewContainer.appendChild(message);
        }

        // Trigger automatic type detection (only if not already completed)
        setTimeout(() => {
            window.DTTypeCoercion.detectAndDisplayColumnTypes();
        }, 100);
    }

    // =========================================================================
    // JSON Preview Functions
    // =========================================================================

    // Prepare mapped CSV data
    function prepareMappedCSVData() {
        if (!window.currentParsedCsvData || !csvState.templateVariables) {
            console.error('No CSV data or template variables available');
            return null;
        }

        // Apply column mapping to each row
        const mappedData = window.currentParsedCsvData.map(row => {
            const mappedRow = {};

            csvState.templateVariables.forEach(variable => {
                if (variable.mappedTo && row.hasOwnProperty(variable.mappedTo)) {
                    // Use the template variable name as the key
                    mappedRow[variable.name] = row[variable.mappedTo];
                }
            });

            return mappedRow;
        });

        return mappedData;
    }


    // Initialize Monaco Editor for JSON Preview
    function initializeJsonPreviewEditor() {
        const editorContainer = document.getElementById('jsonPreviewEditor');
        if (!editorContainer || csvState.jsonPreviewEditor) {
            return; // Already initialized or container not found
        }


        // Use Monaco editor if available (loaded by main endpoint)
        if (typeof monaco !== 'undefined' && monaco.editor) {
            try {
                if (typeof window.defineVSCodeTheme === 'function') {
                    window.defineVSCodeTheme();
                }
                // Create Monaco editor instance
                csvState.jsonPreviewEditor = monaco.editor.create(editorContainer, {
                    value: '// Generating JSON preview...',
                    language: 'json',
                    theme: 'vscode-current',
                    stickyScroll: window.DBMN_STICKY_SCROLL,
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    automaticLayout: true,
                    contextmenu: false,
                    selectOnLineNumbers: false,
                    lineNumbers: 'on',
                    renderLineHighlight: 'none',
                    folding: true,
                    bracketMatching: 'always',
                    scrollbar: {
                        vertical: 'hidden',
                        horizontal: 'visible',
                        useShadows: false,
                        verticalHasArrows: false,
                        horizontalHasArrows: false,
                        handleMouseWheel: false,
                        alwaysConsumeMouseWheel: false
                    }
                });

                // Auto-size editor container to content height so the page scrolls
                csvState.jsonPreviewEditor.onDidContentSizeChange(() => {
                    const contentHeight = Math.max(200, csvState.jsonPreviewEditor.getContentHeight());
                    if (editorContainer) {
                        editorContainer.style.height = contentHeight + 'px';
                        csvState.jsonPreviewEditor.layout();
                    }
                });

                // Force layout update to ensure editor renders properly
                setTimeout(() => {
                    if (csvState.jsonPreviewEditor) {
                        csvState.jsonPreviewEditor.layout();
                    }
                }, 100);

            } catch (error) {
                console.error('Failed to initialize Monaco editor:', error);
                // Fallback to regular div
                editorContainer.innerHTML = '<div class="loading-message">Loading JSON preview...</div>';
            }
        } else {
            // Monaco not available, use fallback
            editorContainer.innerHTML = '<div class="loading-message">Loading JSON preview...</div>';
        }
    }

    // Generate JSON Preview for Step 4 using backend JsonGenerator service
    function generateJSONPreview() {
        if (!csvState.endpointId) {
            console.error('❌ [JSON Preview] No endpoint ID available for preview');
            displayJsonPreviewError('No endpoint ID available');
            return;
        }

        // Initialize Monaco editor if not already done
        initializeJsonPreviewEditor();

        // Show loading state
        if (csvState.jsonPreviewEditor) {
            csvState.jsonPreviewEditor.setValue('// Generating JSON preview...');
        } else {
            const previewContainer = document.getElementById('jsonPreviewEditor');
            if (previewContainer) {
                previewContainer.innerHTML = `<div class="placeholder-text">
                    <span>Generating JSON preview...</span>
                </div>`;
            }
        }

        // GitHub Issue #135: Send parsed data instead of CSV string to avoid parsing issues
        // This ensures values with commas (like "$1,234.56") are handled correctly
        const parsedData = getParsedDataForBackend();
        if (!parsedData || !parsedData.headers || parsedData.rows.length === 0) {
            console.error('❌ [JSON Preview] No parsed CSV data available');
            displayJsonPreviewError('No CSV data available for preview');
            return;
        }

        // Prepare column mappings for backend - include sourceFormat for type coercion
        const mappings = csvState.templateVariables ? csvState.templateVariables.map(variable => {
            const columnName = variable.mappedTo || variable.column;
            return {
                variable: variable.name,
                column: columnName,
                dataType: variable.dataType || 'string',
                sourceFormat: csvState.sourceTypes?.[variable.name] || window.DTTypeCoercion.getDefaultSourceFormat(variable.dataType || 'string')
            };
        }).filter(mapping => mapping.column) : [];

        // Create UI array config from current state
        const uiArrayConfig = (csvState.selectedArrayPath && csvState.arrayRepetition) ? {
            arrayPath: csvState.selectedArrayPath,
            maxRepetitions: csvState.arrayRepetition
        } : null;

        getVscode().postMessage({
            type: 'generateBulkJson',
            endpointId: csvState.endpointId,
            parsedData: parsedData,  // Send parsed data instead of CSV string
            countData: getCountDataForBackend(),  // every row, when parsedData is a sample
            queryParamRepetition: getQueryRepetitionForBackend(),
            mappings: mappings,
            mode: 'preview',
            includeArrayDetection: true,
            uiArrayConfig: uiArrayConfig,
            // GitHub Issue #162: Include source timezone for preview timezone conversion
            sourceTimezone: csvState.sourceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        });
    }

    /**
     * GitHub Issue #135: Get properly parsed CSV data for backend
     * Parses CSV using proper quote-aware parsing to handle values with commas
     * Returns { headers: string[], rows: string[][] }
     */
    function getParsedDataForBackend() {
        // First try: Use transformed data if available (already processed by backend)
        if (csvState.fullTransformedCSV) {
            const lines = csvState.fullTransformedCSV.split('\n').filter(line => line.trim());
            if (lines.length > 0) {
                return {
                    headers: window.DTTypeCoercion.parseCSVLine(lines[0]),
                    rows: lines.slice(1).map(line => window.DTTypeCoercion.parseCSVLine(line))
                };
            }
        }

        // Second try: Parse from raw CSV content using proper parser
        if (csvState.rawCSVContent) {
            const lines = csvState.rawCSVContent.split('\n').filter(line => line.trim());
            if (lines.length > 0) {
                return {
                    headers: window.DTTypeCoercion.parseCSVLine(lines[0]),
                    rows: lines.slice(1).map(line => window.DTTypeCoercion.parseCSVLine(line))
                };
            }
        }

        // Third try: Use already parsed data if available
        if (window.currentParsedCsvData && csvState.currentHeaders) {
            return {
                headers: csvState.currentHeaders,
                rows: window.currentParsedCsvData
            };
        }

        return null;
    }

    /**
     * Every row, for COUNTING requests — or null when the preview data already is every row.
     *
     * getParsedDataForBackend() prefers the type-converted rows, and those are only a sample
     * (getSampledCSVData: PREVIEW_SAMPLE_SIZE rows). A sample is fine for showing the first
     * request and wrong for counting them all: sorted by supplier, the first 50 rows are one
     * supplier, so a nested template's "Total API calls" said 1 for a file of three orders
     * (Puppy School Lesson 5, Step 6). Execute sends csvState.rawCSVContent; so does this.
     */
    function getCountDataForBackend() {
        if (!csvState.fullTransformedCSV || !csvState.rawCSVContent) return null;
        const lines = csvState.rawCSVContent.split('\n').filter(line => line.trim());
        if (lines.length < 2) return null;
        return {
            headers: window.DTTypeCoercion.parseCSVLine(lines[0]),
            rows: lines.slice(1).map(line => window.DTTypeCoercion.parseCSVLine(line))
        };
    }

    /**
     * GitHub Issue #308: the URL query-parameter repetition settings (#108), in the shape
     * Execute sends them (repeatableQueryParam), so the Step 4 plan packs URLs exactly as
     * the run will. Null when the endpoint has no repeating parameter.
     */
    function getQueryRepetitionForBackend() {
        const q = csvState.queryParamRepetition;
        if (!q || !q.detected) return null;
        return {
            enabled: true,
            paramKey: q.paramKey,
            pattern: q.pattern,
            separator: q.separator,
            maxUrlLength: q.maxUrlLength || 2000,
            maxPerRequest: q.maxPerRequest ?? undefined
        };
    }

    // Helper function to convert parsed CSV data back to CSV string format
    function convertParsedDataToCSVString() {
        try {
            if (!window.currentParsedCsvData || window.currentParsedCsvData.length === 0) {
                return null;
            }

            // Get headers from first row keys
            const firstRow = window.currentParsedCsvData[0];
            const headers = Object.keys(firstRow);

            // Create CSV string with headers
            const csvLines = [headers.join(',')];

            // Add data rows
            window.currentParsedCsvData.forEach(row => {
                const values = headers.map(header => {
                    const value = row[header] || '';
                    // Simple CSV escaping - wrap in quotes if contains comma or quote
                    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                        return `"${value.replace(/"/g, '""')}"`;
                    }
                    return value;
                });
                csvLines.push(values.join(','));
            });

            return csvLines.join('\n');
        } catch (error) {
            console.error('Error converting CSV data:', error);
            return null;
        }
    }

    // Helper function to display JSON preview errors
    function displayJsonPreviewError(message) {
        if (csvState.jsonPreviewEditor) {
            // Use Monaco editor for error display
            csvState.jsonPreviewEditor.setValue(`/* JSON Preview Error */\n// ${message}\n// Please check your CSV data and column mappings`);
        } else {
            // Fallback to HTML
            const previewContainer = document.getElementById('jsonPreviewEditor');
            if (previewContainer) {
                previewContainer.innerHTML = `<div class="error-message">${message}</div>`;
            }
        }
    }

    // =========================================================================
    // Query String Preview Functions (GitHub Issue #108)
    // Also handles query-param-only templates (UX improvement)
    // =========================================================================

    function generateQueryStringPreview() {
        // Check if this is a query-param-only template (no repeatable pattern)
        const hasQueryParamRepetition = csvState.queryParamRepetition && csvState.queryParamRepetition.detected;
        const hasJsonBody = csvState.endpointConfig?.body?.trim();
        const hasQueryParams = csvState.endpointConfig?.queryParams &&
            Object.keys(csvState.endpointConfig.queryParams).length > 0;

        // If no repeatable pattern but has query params without body, use URL sample preview
        if (!hasQueryParamRepetition && hasQueryParams && !hasJsonBody) {
            generateUrlSamplePreview();
            return;
        }

        if (!hasQueryParamRepetition) {
            console.error('[Query Preview] No query param repetition config available');
            displayQueryPreviewError('Query parameter repetition not configured');
            return;
        }

        if (!csvState.transformedRows || csvState.transformedRows.length === 0) {
            console.error('[Query Preview] No transformed CSV data available');
            displayQueryPreviewError('No CSV data available for preview');
            return;
        }

        // Get the mapped column for the query param variable
        const queryVarName = csvState.queryParamVariables ? csvState.queryParamVariables[0] : null;
        if (!queryVarName) {
            console.error('[Query Preview] No query parameter variable found');
            displayQueryPreviewError('No query parameter variable found in pattern');
            return;
        }

        // Find the template variable mapping (same as JSON preview uses)
        if (!csvState.templateVariables || csvState.templateVariables.length === 0) {
            console.error('[Query Preview] No template variables available');
            displayQueryPreviewError('Template variables not loaded. Please go back and retry.');
            return;
        }

        const templateVar = csvState.templateVariables.find(v => v.name === queryVarName);
        if (!templateVar) {
            console.error('[Query Preview] Template variable not found:', queryVarName);
            displayQueryPreviewError(`Template variable not found: ${queryVarName}`);
            return;
        }

        const mappedColumn = templateVar.mappedTo || templateVar.column;
        if (!mappedColumn) {
            console.error('[Query Preview] Variable not mapped:', queryVarName);
            displayQueryPreviewError(`Variable "${queryVarName}" is not mapped to a CSV column. Please complete the column mapping in Step 3.`);
            return;
        }

        // Get column index from the mapped column name
        const columnIndex = csvState.currentHeaders ? csvState.currentHeaders.indexOf(mappedColumn) : -1;
        if (columnIndex === -1) {
            console.error('[Query Preview] Mapped column not found:', mappedColumn);
            displayQueryPreviewError(`CSV column "${mappedColumn}" not found in headers.`);
            return;
        }

        // Extract values from transformed data
        const values = csvState.transformedRows.map(row => row[columnIndex]).filter(v => v != null && v !== '');

        // Get current batch configuration
        const itemsPerRequest = getItemsPerRequest(values);
        const pattern = csvState.queryParamRepetition.pattern;
        const separator = csvState.queryParamRepetition.separator;

        // Build preview query string (show first batch only)
        const previewValues = values.slice(0, Math.min(itemsPerRequest, values.length));
        const queryString = window.CSVHandler.buildQueryStringPreview(pattern, separator, previewValues, itemsPerRequest);

        // Calculate stats
        const totalBatches = Math.ceil(values.length / itemsPerRequest);
        const estimatedUrlLength = calculateUrlLength(pattern, separator, previewValues);

        // Update UI
        updateQueryPreviewStats(totalBatches, estimatedUrlLength);
        displayQueryPreview(queryString, previewValues.length, values.length);
    }

    function getItemsPerRequest(sampleValues) {
        const select = document.getElementById('itemsPerRequestSelect');
        if (!select) return 50; // Default

        const value = select.value;

        if (value === 'auto') {
            // Auto-calculate based on URL length
            const pattern = csvState.queryParamRepetition.pattern;
            const separator = csvState.queryParamRepetition.separator;
            const maxUrlLength = csvState.queryParamRepetition.maxUrlLength || 2000;
            const sampleValue = sampleValues[0] || 'SAMPLE';
            return window.CSVHandler.calculateMaxItemsPerRequest(pattern, separator, sampleValue, maxUrlLength);
        } else if (value === 'custom') {
            const customInput = document.getElementById('customItemsInput');
            return customInput ? parseInt(customInput.value, 10) || 50 : 50;
        } else {
            return parseInt(value, 10) || 50;
        }
    }

    function calculateUrlLength(pattern, separator, values) {
        // Build full query string
        const queryString = window.CSVHandler.buildQueryStringPreview(pattern, separator, values, values.length);
        // Assume base URL length (will be more accurate with actual endpoint URL)
        const baseUrl = 'https://api.example.com/endpoint?query=';
        return baseUrl.length + encodeURIComponent(queryString).length;
    }

    function updateQueryPreviewStats(batchCount, urlLength) {
        // Update batch count
        const batchCountEl = document.getElementById('queryBatchCount');
        if (batchCountEl) {
            batchCountEl.textContent = batchCount.toString();
        }

        // Update URL length with color coding
        const urlLengthEl = document.getElementById('queryUrlLength');
        if (urlLengthEl) {
            urlLengthEl.textContent = `${urlLength} chars`;

            // Color code based on length
            if (urlLength > 2000) {
                urlLengthEl.className = 'font-bold font-size-14 color-warning';
            } else {
                urlLengthEl.className = 'font-bold font-size-14 color-success';
            }
        }

        // Show/hide warning
        const warningEl = document.getElementById('queryUrlWarning');
        if (warningEl) {
            if (urlLength > 2000) {
                warningEl.classList.remove('hidden');
            } else {
                warningEl.classList.add('hidden');
            }
        }
    }

    function displayQueryPreview(queryString, previewCount, totalCount) {
        const previewContainer = document.getElementById('queryStringPreview');
        if (!previewContainer) return;

        const previewInfo = previewCount < totalCount
            ? `<div class="preview-info">Showing first ${previewCount} of ${totalCount} items</div>`
            : `<div class="preview-info">All ${totalCount} items</div>`;

        previewContainer.innerHTML = `
            ${previewInfo}
            <pre class="query-preview-pre">${escapeHtml(queryString)}</pre>
        `;
    }

    function displayQueryPreviewError(message) {
        const previewContainer = document.getElementById('queryStringPreview');
        if (previewContainer) {
            previewContainer.innerHTML = `
                <div class="error-message">
                    <strong>Preview Error</strong><br>
                    ${escapeHtml(message)}
                </div>
            `;
        }
    }

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Generate URL sample preview for query-param-only templates
     * Shows individual URLs with substituted values (UX improvement)
     */
    function generateUrlSamplePreview() {
        if (!csvState.transformedRows || csvState.transformedRows.length === 0) {
            displayQueryPreviewError('No CSV data available for preview');
            return;
        }

        if (!csvState.templateVariables || csvState.templateVariables.length === 0) {
            displayQueryPreviewError('Template variables not loaded. Please go back and retry.');
            return;
        }

        // Get endpoint configuration
        const method = csvState.endpointConfig?.method || 'GET';
        const path = csvState.endpointConfig?.path || '/api/endpoint';
        const queryParams = csvState.endpointConfig?.queryParams || {};

        // Build URL samples for first few rows (show up to 5 samples)
        const sampleCount = Math.min(5, csvState.transformedRows.length);
        const urlSamples = [];

        for (let rowIndex = 0; rowIndex < sampleCount; rowIndex++) {
            const row = csvState.transformedRows[rowIndex];

            // Build query string by substituting template variables
            const queryParts = [];
            for (const [paramKey, paramValue] of Object.entries(queryParams)) {
                // Handle both string format and {value, enabled} format
                const valueTemplate = typeof paramValue === 'string' ? paramValue : paramValue?.value;
                if (!valueTemplate) continue;

                // Check if param is enabled (if it has the enabled property)
                if (typeof paramValue === 'object' && paramValue.enabled === false) continue;

                // Substitute template variables in the value
                let substitutedValue = valueTemplate;
                const varMatches = valueTemplate.match(/\{\{([^}]+)\}\}/g) || [];

                for (const match of varMatches) {
                    const varName = match.replace(/\{\{|\}\}/g, '').trim();
                    const templateVar = csvState.templateVariables.find(v => v.name === varName);

                    if (templateVar) {
                        const mappedColumn = templateVar.mappedTo || templateVar.column;
                        if (mappedColumn && csvState.currentHeaders) {
                            const colIndex = csvState.currentHeaders.indexOf(mappedColumn);
                            if (colIndex >= 0 && row[colIndex] != null) {
                                substitutedValue = substitutedValue.replace(match, String(row[colIndex]));
                            }
                        }
                    }
                }

                queryParts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(substitutedValue)}`);
            }

            const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
            urlSamples.push(`${method} ${path}${queryString}`);
        }

        // Display the URL samples
        const totalCount = csvState.transformedRows.length;
        const previewContainer = document.getElementById('queryStringPreview');
        if (previewContainer) {
            const previewInfo = sampleCount < totalCount
                ? `<div class="preview-info">Showing first ${sampleCount} of ${totalCount} requests</div>`
                : `<div class="preview-info">All ${totalCount} requests</div>`;

            previewContainer.innerHTML = `
                ${previewInfo}
                <pre class="query-preview-pre">${escapeHtml(urlSamples.join('\n'))}</pre>
            `;
        }

        // Update stats display
        const batchCountEl = document.getElementById('queryBatchCount');
        if (batchCountEl) {
            batchCountEl.textContent = totalCount.toString();
        }

        const urlLengthEl = document.getElementById('queryUrlLength');
        if (urlLengthEl) {
            const avgLength = urlSamples.length > 0
                ? Math.round(urlSamples.reduce((sum, url) => sum + url.length, 0) / urlSamples.length)
                : 0;
            urlLengthEl.textContent = `~${avgLength} chars avg`;
            urlLengthEl.className = 'font-bold font-size-14 color-success';
        }

        // Hide URL length warning for single-request URLs
        const warningEl = document.getElementById('queryUrlWarning');
        if (warningEl) {
            warningEl.classList.add('hidden');
        }
    }

    function onItemsPerRequestChange() {
        const select = document.getElementById('itemsPerRequestSelect');
        const customContainer = document.getElementById('customItemsContainer');

        if (!select || !customContainer) return;

        // Show/hide custom input
        customContainer.classList.toggle('hidden', select.value !== 'custom');

        // Update query param config in state
        if (csvState.queryParamRepetition) {
            if (select.value === 'auto') {
                csvState.queryParamRepetition.maxPerRequest = null; // Will auto-calculate
            } else if (select.value === 'custom') {
                const customInput = document.getElementById('customItemsInput');
                csvState.queryParamRepetition.maxPerRequest = customInput ? parseInt(customInput.value, 10) : 50;
            } else {
                csvState.queryParamRepetition.maxPerRequest = parseInt(select.value, 10);
            }
        }

        // GitHub Issue #308: a setting changed — the Step 4 samples rebuild for it (a select: at once)
        window.CSVHandler?.schedulePreviewRebuild?.(true);
    }

    function onCustomItemsChange(value) {
        const numValue = parseInt(value, 10);

        // Update state
        if (csvState.queryParamRepetition) {
            csvState.queryParamRepetition.maxPerRequest = numValue || 50;
        }

        window.CSVHandler?.schedulePreviewRebuild?.(false);     // typed: debounced
    }

    function copyQueryPreview() {
        const previewPre = document.querySelector('#queryStringPreview .query-preview-pre');
        if (!previewPre) return;

        const queryString = previewPre.textContent;

        // Clipboard API with an execCommand fallback — see shared/dbmn-clipboard.js.
        window.DbmnClipboard.writeText(queryString).then(ok => {
            if (ok) showCopyFeedback('copyQueryBtn');
            else if (window.DbmnToast) window.DbmnToast.error('Failed to copy the query string');
        });
    }

    function showCopyFeedback(buttonId) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        const originalText = button.textContent;
        button.textContent = '✓ Copied!';
        button.disabled = true;

        setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
        }, 2000);
    }

    // =========================================================================
    // Data Refresh and Sampling Functions
    // =========================================================================

    /**
     * GitHub Issue #106: Helper function to sample CSV data for preview/validation
     * Returns first PREVIEW_SAMPLE_SIZE rows + headers for performance
     */
    function getSampledCSVData(fullCSVData) {
        if (!fullCSVData) return null;

        const lines = fullCSVData.split('\n');
        if (lines.length <= 1) return fullCSVData; // Only headers or empty

        const headers = lines[0];
        const dataLines = lines.slice(1).filter(line => line.trim().length > 0);

        // Store total row count for accurate API estimation
        csvState.totalRowCount = dataLines.length;

        // Return headers + first PREVIEW_SAMPLE_SIZE rows
        const sampleLines = dataLines.slice(0, PREVIEW_SAMPLE_SIZE);
        const sampledCSV = [headers, ...sampleLines].join('\n');

        return sampledCSV;
    }

    // Function to update sample values in mapping table with fresh transformed data
    // GitHub Issue #162: Updated to use Source/Target layout
    function updateStep3SampleValues() {

        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (!mappingTable || !csvState.templateVariables) {
            console.warn('⚠️ [CSV Handler] Cannot update samples - missing table or variables');
            return;
        }

        // Update each variable's sample values (both source and target)
        csvState.templateVariables.forEach((variable) => {
            if (variable.mappedTo) {
                const row = mappingTable.querySelector(`tr[data-variable="${variable.name}"]`);
                if (row) {
                    const sourceSampleCell = row.querySelector('.source-sample-cell');
                    const targetSampleCell = row.querySelector('.target-sample-cell');
                    const columnIndex = csvState.currentHeaders.indexOf(variable.mappedTo);

                    if (columnIndex >= 0) {
                        // Get raw value for source sample
                        let rawValue = '-';
                        if (csvState.currentParsedData && csvState.currentParsedData.rows && csvState.currentParsedData.rows.length > 0) {
                            rawValue = csvState.currentParsedData.rows[0][columnIndex] || '-';
                        }
                        if (sourceSampleCell) {
                            sourceSampleCell.textContent = rawValue;
                        }

                        // Get transformed value for target sample
                        if (targetSampleCell) {
                            if (csvState.transformedRows && csvState.transformedRows.length > 0) {
                                const transformedValue = csvState.transformedRows[0][columnIndex] || '-';
                                targetSampleCell.textContent = transformedValue;
                            } else {
                                // Compute target sample if no transformed rows
                                const targetType = variable.dataType || 'string';
                                const targetValue = window.CSVHandler.computeTargetSample(rawValue, variable.name, targetType);
                                targetSampleCell.textContent = targetValue;
                            }
                        }
                    }
                }
            }
        });
    }

    // Function to refresh transformed data when navigating to Step 4
    function refreshTransformedDataForStep4() {

        // Use stored column type selections instead of querying DOM (which may be hidden)
        if (!csvState.selectedColumnTypes || Object.keys(csvState.selectedColumnTypes).length === 0) {
            console.warn('⚠️ [JSON Preview] No stored column types found, generating JSON with raw data');
            generateJSONPreview();
            return;
        }

        // GitHub Issue #218: Filter out STRING columns — STRING is default, no transformation needed
        const nonStringTypes = window.DTTypeCoercion.filterNonStringTypes(csvState.selectedColumnTypes);

        // Request transformation only for non-string column types
        if (Object.keys(nonStringTypes).length > 0) {

            // Set flag to generate JSON after transformation completes
            csvState.generateJsonAfterTransform = true;

            // GitHub Issue #106: Send sampled data for preview transformation
            // GitHub Issue #135: Apply source format conversions before sending to backend
            const rawCsvData = getSampledCSVData(csvState.rawCSVContent) || window.DTTypeCoercion.createCSVStringFromCurrentData();
            const convertedCsvData = window.DTTypeCoercion.applySourceFormatConversions(rawCsvData);
            getVscode().postMessage({
                type: 'applyTypeTransformations',
                csvData: convertedCsvData,
                columnTypes: nonStringTypes
            });
        } else {
            generateJSONPreview();
        }
    }

    // Function to refresh transformed data when navigating to Step 3
    function refreshTransformedDataForStep3() {

        // Use stored column type selections instead of querying DOM (which may be hidden)
        if (!csvState.selectedColumnTypes || Object.keys(csvState.selectedColumnTypes).length === 0) {
            console.warn('⚠️ [CSV Handler] No stored column types found, populating table with raw data');
            // No type transformations needed - populate table directly with raw data
            csvState.transformationInProgress = false;

            // Clear the loading message before populating
            const mappingTable = document.getElementById('columnMappingTable');
            if (mappingTable) {
                mappingTable.innerHTML = '';
            }

            window.CSVHandler.populateColumnMappingTable();
            return;
        }

        // GitHub Issue #218: Filter out STRING columns — STRING is default, no transformation needed
        const nonStringTypes = window.DTTypeCoercion.filterNonStringTypes(csvState.selectedColumnTypes);

        // Request transformation only for non-string column types
        if (Object.keys(nonStringTypes).length > 0) {

            // GitHub Issue #106: Send sampled data for preview transformation
            getVscode().postMessage({
                type: 'applyTypeTransformations',
                csvData: getSampledCSVData(csvState.rawCSVContent) || window.DTTypeCoercion.createCSVStringFromCurrentData(),
                columnTypes: nonStringTypes
            });
        } else {
            // No transformation needed — populate directly
            csvState.transformationInProgress = false;
            const mappingTable = document.getElementById('columnMappingTable');
            if (mappingTable) {
                mappingTable.innerHTML = '';
            }
            window.CSVHandler.populateColumnMappingTable();
        }
    }

    // =========================================================================
    // GitHub Issue #204: Body/Details Toggle + Input Columns
    // =========================================================================

    /**
     * Toggle between Body and Details view in Step 4
     * @param {string} mode - 'body' or 'details'
     */
    function setPreviewViewMode(mode) {
        csvState.previewViewMode = mode;

        // Toggle active class on buttons
        const bodyBtn = document.getElementById('previewModeBody');
        const detailsBtn = document.getElementById('previewModeDetails');
        if (bodyBtn) bodyBtn.classList.toggle('active', mode === 'body');
        if (detailsBtn) detailsBtn.classList.toggle('active', mode === 'details');

        // Show/hide editor vs details
        const editorEl = document.getElementById('jsonPreviewEditor');
        const detailsEl = document.getElementById('jsonPreviewDetails');
        if (editorEl) editorEl.classList.toggle('hidden', mode !== 'body');
        if (detailsEl) detailsEl.classList.toggle('hidden', mode !== 'details');

        // Hide array config bar in Details mode (irrelevant)
        const arrayConfigBar = document.getElementById('arrayConfigBar');
        if (arrayConfigBar) arrayConfigBar.classList.toggle('hidden', mode !== 'body');

        // Build details content when switching to details
        if (mode === 'details') {
            buildPreviewDetailsContent();
        }
    }

    /**
     * Build details text from endpoint config, matching RAW tab format
     */
    function buildPreviewDetailsContent() {
        const detailsEl = document.getElementById('jsonPreviewDetails');
        if (!detailsEl) return;

        const config = csvState.endpointConfig;
        if (!config) {
            detailsEl.innerHTML = '<pre class="preview-details-pre">// No endpoint configuration available</pre>';
            return;
        }

        const parts = [];

        // ENDPOINT section
        const method = config.method || 'GET';
        let path = config.path || '/api/endpoint';

        // Substitute template variables in path using first row data
        path = substituteTemplateVars(path);

        parts.push('// ENDPOINT');
        parts.push(`${method} ${path}`);

        // QUERY PARAMETERS section
        const queryParams = config.queryParams;
        if (queryParams && Object.keys(queryParams).length > 0) {
            const enabledParams = getEnabledParams(queryParams);
            if (enabledParams.length > 0) {
                parts.push('');
                parts.push('// QUERY PARAMETERS');
                for (const [key, value] of enabledParams) {
                    parts.push(`${key}: ${substituteTemplateVars(value)}`);
                }
            }
        }

        // HEADERS section
        const headers = config.headers;
        if (headers && Object.keys(headers).length > 0) {
            const enabledHeaders = getEnabledParams(headers);
            if (enabledHeaders.length > 0) {
                parts.push('');
                parts.push('// HEADERS');
                for (const [key, value] of enabledHeaders) {
                    parts.push(`${key}: ${substituteTemplateVars(value)}`);
                }
            }
        }

        const text = parts.length > 0 ? parts.join('\n') : '// No request details available';
        detailsEl.innerHTML = `<pre class="preview-details-pre">${escapeHtml(text)}</pre>`;
    }

    /**
     * Substitute {{template}} variables using first row of transformed data
     * Leaves A8/ENV variables (like {{A8_SEQ}}) as-is since they resolve at execution time
     */
    function substituteTemplateVars(template) {
        if (!template || typeof template !== 'string') return template || '';

        const varMatches = template.match(/\{\{([^}]+)\}\}/g);
        if (!varMatches) return template;

        let result = template;
        for (const match of varMatches) {
            const varName = match.replace(/\{\{|\}\}/g, '').trim();

            // Skip A8/ENV variables - they resolve at execution time
            if (varName.startsWith('A8_') || varName.startsWith('ENV_')) continue;

            const templateVar = csvState.templateVariables
                ? csvState.templateVariables.find(v => v.name === varName)
                : null;

            if (templateVar) {
                const mappedColumn = templateVar.mappedTo || templateVar.column;
                if (mappedColumn && csvState.currentHeaders && csvState.transformedRows && csvState.transformedRows.length > 0) {
                    const colIndex = csvState.currentHeaders.indexOf(mappedColumn);
                    if (colIndex >= 0 && csvState.transformedRows[0][colIndex] != null) {
                        result = result.replace(match, String(csvState.transformedRows[0][colIndex]));
                    }
                }
            }
        }
        return result;
    }

    /**
     * Filter params/headers to enabled entries, handling both string and {value, enabled} formats
     * @returns {Array<[string, string]>} Array of [key, valueString] pairs
     */
    function getEnabledParams(params) {
        const result = [];
        for (const [key, paramValue] of Object.entries(params)) {
            if (typeof paramValue === 'string') {
                result.push([key, paramValue]);
            } else if (paramValue && typeof paramValue === 'object') {
                if (paramValue.enabled === false) continue;
                result.push([key, paramValue.value || '']);
            }
        }
        return result;
    }

    /**
     * Toggle input data visibility via checkbox
     */
    function togglePreviewInput(checked) {
        csvState.previewShowInput = checked;
        const section = document.getElementById('previewInputSection');
        if (!section) return;

        if (checked) {
            buildPreviewInputTable();
        } else {
            section.classList.add('hidden');
        }
    }

    /**
     * Build input columns table showing CSV data used in this batch.
     * Only shows when the Input checkbox is checked.
     */
    function buildPreviewInputTable() {
        const section = document.getElementById('previewInputSection');
        if (!section) return;

        // Only render if the user has toggled input on
        if (!csvState.previewShowInput) {
            section.classList.add('hidden');
            return;
        }

        const headers = csvState.currentHeaders;
        const rows = csvState.transformedRows;

        if (!headers || !rows || rows.length === 0) {
            section.classList.add('hidden');
            return;
        }

        const maxRows = 5;
        const displayRows = rows.slice(0, maxRows);

        let html = '<div class="preview-input-table-wrapper"><table class="preview-input-table">';

        // Header row
        html += '<thead><tr>';
        for (const h of headers) {
            html += `<th>${escapeHtml(h)}</th>`;
        }
        html += '</tr></thead>';

        // Data rows
        html += '<tbody>';
        for (const row of displayRows) {
            html += '<tr>';
            for (let i = 0; i < headers.length; i++) {
                const val = row[i] != null ? String(row[i]) : '';
                html += `<td title="${escapeHtml(val)}">${escapeHtml(val)}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';

        // Footer
        if (rows.length > maxRows) {
            html += `<div class="preview-input-footer">Showing ${maxRows} of ${rows.length} rows</div>`;
        }

        section.innerHTML = html;
        section.classList.remove('hidden');
    }

    // =========================================================================
    // Module Public API
    // =========================================================================

    function init(sharedState, vscodeFn) {
        csvState = sharedState;
        getVscode = vscodeFn;
    }

    window.DTDataPreview = {
        init: init,

        // CSV preview
        displayCSVPreview: displayCSVPreview,
        displayCSVModalPreview: displayCSVModalPreview,

        // JSON preview
        prepareMappedCSVData: prepareMappedCSVData,
        initializeJsonPreviewEditor: initializeJsonPreviewEditor,
        generateJSONPreview: generateJSONPreview,
        getParsedDataForBackend: getParsedDataForBackend,
        getCountDataForBackend: getCountDataForBackend,
        getQueryRepetitionForBackend: getQueryRepetitionForBackend,
        convertParsedDataToCSVString: convertParsedDataToCSVString,
        displayJsonPreviewError: displayJsonPreviewError,

        // Query string preview
        generateQueryStringPreview: generateQueryStringPreview,
        onItemsPerRequestChange: onItemsPerRequestChange,
        onCustomItemsChange: onCustomItemsChange,
        copyQueryPreview: copyQueryPreview,

        // Data refresh
        getSampledCSVData: getSampledCSVData,
        updateStep3SampleValues: updateStep3SampleValues,
        refreshTransformedDataForStep4: refreshTransformedDataForStep4,
        refreshTransformedDataForStep3: refreshTransformedDataForStep3,

        // GitHub Issue #204: Body/Details toggle + Input columns
        setPreviewViewMode: setPreviewViewMode,
        buildPreviewDetailsContent: buildPreviewDetailsContent,
        buildPreviewInputTable: buildPreviewInputTable,
        togglePreviewInput: togglePreviewInput
    };
})();
