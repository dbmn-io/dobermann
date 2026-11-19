// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Batch Configuration
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Contains batch execution configuration:
 * - Format conversion UI (Excel sheet selection, delimiter selection)
 * - Batch naming (default generation, sanitization)
 * - Execution summary population
 * - Processing mode (sequential/parallel) (GitHub Issue #78)
 * - Progress context menu for mode changes during execution
 */
(function () {
    'use strict';

    // Module-level references (set via init)
    let csvState = null;
    let getVscode = null;

    // =========================================================================
    // Format Conversion Functions
    // =========================================================================

    function showFormatConversionUI() {
        const conversionContainer = document.getElementById('formatConversionContainer');
        if (!conversionContainer) {
            console.error('Format conversion container not found');
            return;
        }

        // Clear previous content
        conversionContainer.innerHTML = '';

        if (!csvState.fileFormat || !csvState.formatMetadata) {
            conversionContainer.innerHTML = '<p class="error-message">No format information available</p>';
            return;
        }

        let conversionHTML = `
            <div class="format-info">
                <h4>File Format Detected: ${csvState.fileFormat.toUpperCase()}</h4>
                <p><strong>File:</strong> ${window.currentCSVFileName}</p>
                <p><strong>Size:</strong> ${formatFileSize(window.currentCSVFileSize)}</p>
            </div>
        `;

        // Add format-specific options
        if (csvState.fileFormat === 'excel' && csvState.formatMetadata.sheets && csvState.formatMetadata.sheets.length > 1) {
            conversionHTML += `
                <div class="excel-options">
                    <h4>Excel Sheet Selection</h4>
                    <p>This Excel file contains multiple sheets. Please select which sheet to convert:</p>
                    <select id="excelSheetSelect" data-change="csv:updateSelectedSheet">
                        ${csvState.formatMetadata.sheets.map((sheet, index) =>
                `<option value="${index}">${sheet}</option>`
            ).join('')}
                    </select>
                </div>
            `;
        }

        if (csvState.fileFormat === 'custom') {
            const detectedDelimiter = csvState.formatMetadata.delimiter || ',';
            conversionHTML += `
                <div class="delimiter-options">
                    <h4>Delimiter Selection</h4>
                    <p>Select the delimiter used in your file:</p>
                    <select id="delimiterSelect" data-change="batchConfig:updateSelectedDelimiter">
                        <option value="," ${detectedDelimiter === ',' ? 'selected' : ''}>Comma (,)</option>
                        <option value="\\t" ${detectedDelimiter === '\t' ? 'selected' : ''}>Tab</option>
                        <option value=";" ${detectedDelimiter === ';' ? 'selected' : ''}>Semicolon (;)</option>
                        <option value="|" ${detectedDelimiter === '|' ? 'selected' : ''}>Pipe (|)</option>
                        <option value=":" ${detectedDelimiter === ':' ? 'selected' : ''}>Colon (:)</option>
                    </select>
                </div>
            `;
        }

        conversionHTML += `
            <div class="conversion-actions">
                <button id="startConversionBtn" data-click="batchConfig:startFormatConversion" class="primary-btn">
                    Convert to CSV Format
                </button>
                <div id="conversionProgress" class="hidden">
                    <p>Converting file format...</p>
                </div>
            </div>
            <div id="conversionResult" class="hidden">
                <!-- Conversion result will be shown here -->
            </div>
        `;

        conversionContainer.innerHTML = conversionHTML;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
        return Math.round(bytes / 1048576) + ' MB';
    }

    function updateSelectedSheet() {
        const sheetSelect = document.getElementById('excelSheetSelect');
        if (sheetSelect) {
            csvState.selectedSheetIndex = parseInt(sheetSelect.value);
            // Track sheet name for batch naming
            csvState.sourceSheetName = sheetSelect.options[sheetSelect.selectedIndex]?.text || null;
            // Don't start conversion here - wait for user to click "Read File"

            // GitHub Issue #207: Reset filter choice and re-validate for new sheet
            csvState.filterChoice = null;
            if (window.DTDataIngestion && window.DTDataIngestion.showExcelValidation) {
                window.DTDataIngestion.showExcelValidation(csvState.selectedSheetIndex);
            }
        }
    }

    function updateSelectedDelimiter() {
        const delimiterSelect = document.getElementById('delimiterSelect');
        if (delimiterSelect) {
            csvState.selectedDelimiter = delimiterSelect.value === '\\t' ? '\t' : delimiterSelect.value;
        }
    }

    // =========================================================================
    // Batch Naming Functions
    // =========================================================================

    /**
     * The name a batch gets unless the user gives one: where its rows came from and when, as
     * "inventory-67k 12 Nov 16:30". The file's name (its sheet beside it, unless it is the only
     * "Sheet1"), or the endpoint's for pasted, typed or chained rows. James, 2026-11-12: every run
     * was "batch_<date>" (by Review the source is the grid, so the file was never seen).
     */
    function generateDefaultBatchName(now) {
        const when = now && typeof now.getTime === 'function' ? now : new Date();
        const time = `${when.getDate()} ${when.toLocaleString('en-GB', { month: 'short' })} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
        const origin = csvState.originalSourceType || csvState.sourceType;
        const chained = !!(window.ChainPreload && window.ChainPreload.isChained && window.ChainPreload.isChained());
        const fileName = csvState.sourceFileName || window.currentCSVFileName;
        let source;
        if (!chained && origin === 'file' && fileName) {
            source = fileName.replace(/\.[^/.]+$/, '');
            if (csvState.sourceSheetName && csvState.sourceSheetName !== 'Sheet1') source += ` (${csvState.sourceSheetName})`;
        } else {
            source = (csvState.endpointConfig && csvState.endpointConfig.name)
                || (document.body && document.body.dataset.endpointName)
                || window.currentEndpointName || 'Batch';
        }
        return sanitizeBatchName(`${source} ${time}`);
    }

    /** Tidy, not file-safe: the run's file name is made safe where it is written (batch-file-manager.ts). */
    function sanitizeBatchName(name) {
        if (!name || typeof name !== 'string') return 'Batch';
        return name.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().substring(0, 100) || 'Batch';
    }

    /**
     * The batch's name, typed in Review's settings (Name, beside Error Handling). The user's own name
     * stays; emptied, it goes back to the default. Its tab says it as it is typed.
     */
    function updateBatchName() {
        const input = document.getElementById('batchNameInput');
        if (!input || !csvState) return;
        csvState.batchNameEdited = input.value.trim().length > 0;
        csvState.batchName = csvState.batchNameEdited ? sanitizeBatchName(input.value) : generateDefaultBatchName();
        tellTab();
    }

    /**
     * Until the user names it, a batch is named after its file (or its endpoint) and the time, made
     * again as the steps go; Review's Name shows it and its tab says it. Once it has run it is
     * renamed in History (right-click → Rename) or its Console's Settings → Name.
     */
    function refreshBatchName() {
        if (!csvState) return;
        if (!csvState.batchNameEdited) csvState.batchName = generateDefaultBatchName();
        const input = document.getElementById('batchNameInput');
        if (input && document.activeElement !== input) input.value = csvState.batchName || '';
        tellTab();
    }
    /** The tab says the batch's name (tab-frame.js; outside the Hub there is no tab to say it). */
    function tellTab() {
        if (csvState && csvState.batchName && typeof window.dbmnSetTabName === 'function') window.dbmnSetTabName(csvState.batchName);
    }

    function startFormatConversion() {
        const progressDiv = document.getElementById('conversionProgress');
        const resultDiv = document.getElementById('conversionResult');
        const convertBtn = document.getElementById('startConversionBtn');

        if (progressDiv) progressDiv.classList.remove('hidden');
        if (resultDiv) resultDiv.classList.add('hidden');
        if (convertBtn) convertBtn.disabled = true;

        // Prepare conversion options
        const conversionOptions = {};

        if (csvState.fileFormat === 'excel' && csvState.selectedSheetIndex !== undefined) {
            conversionOptions.sheetIndex = csvState.selectedSheetIndex;
        }

        if (csvState.selectedDelimiter) {
            conversionOptions.delimiter = csvState.selectedDelimiter;
        }

        // Send conversion request to backend
        getVscode().postMessage({
            type: 'convertFileFormat',
            fileData: csvState.rawFileData,
            fileName: window.currentCSVFileName,
            fileFormat: csvState.fileFormat,
            options: conversionOptions
        });
    }

    // =========================================================================
    // Execution Summary Population
    // =========================================================================

    function populateExecutionSummary() {
        // #435: on Review, beside its Summary (which counts the rows and API calls): the run's
        // name, error handling and processing mode, its source, and where it is sent
        // Populate summary fields
        const populateField = (id, value) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = value;
            } else {
                console.warn(`Element not found: ${id}`);
            }
        };

        // Request the current active environment from backend
        getVscode().postMessage({
            type: 'getCurrentEnvironment'
        });

        // Populate source information. By Execute the grid is the source (useGridAsSource), so
        // name where the rows came from: the file, pasted text, or the run they were chained from.
        const origin = csvState.originalSourceType || csvState.sourceType;
        const sourceEl = document.getElementById('executionSource');
        if (window.ChainPreload && window.ChainPreload.isChained && window.ChainPreload.isChained() && sourceEl) {
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'text-link';
            link.textContent = 'Prev Batch';
            link.title = window.ChainPreload.sourceLabel ? window.ChainPreload.sourceLabel() : 'Open the run these rows came from';
            link.addEventListener('click', function (event) {
                event.preventDefault();
                getVscode().postMessage({ type: 'openChainSource' });
            });
            sourceEl.replaceChildren(link);
        } else {
            let sourceText = 'Entered data';
            if (origin === 'file') {
                sourceText = csvState.sourceFileName || window.currentCSVFileName || 'File';
                if (csvState.sourceSheetName && csvState.sourceSheetName !== 'Sheet1') {
                    sourceText += ` (${csvState.sourceSheetName})`;
                }
            } else if (origin === 'paste') {
                sourceText = 'Pasted text';
            }
            populateField('executionSource', sourceText);
        }

        // The default name, made each time Review opens (its time is now) until the user names it
        refreshBatchName();

        // Get endpoint method and path from config (preferred) or form elements
        const endpointMethod = csvState.endpointConfig?.method || document.getElementById('endpointMethod')?.value || 'POST';
        const endpointPath = csvState.endpointConfig?.path || document.getElementById('endpointPath')?.value || '/api/endpoint';

        // Initially show loading state for environment data (the reply fills it in)
        populateField('executionEnvironment', 'Loading...');
        populateField('executionFullUrl', `${endpointMethod} Loading...`);

        // Initialize error handling UI from saved preferences
        window.CSVHandler.initializeErrorHandlingUI();

        // Initialize batch naming UI
        initializeBatchNameInput();
    }

    function initializeBatchNameInput() {
        const batchNameInput = document.getElementById('batchNameInput');
        const batchSourceInfo = document.getElementById('batchSourceInfo');

        if (batchNameInput) {
            if (!csvState.batchName) csvState.batchName = generateDefaultBatchName();
            batchNameInput.value = csvState.batchName;
        }

        if (batchSourceInfo) {
            // Update source information display
            let sourceText = '';
            if (csvState.sourceType === 'file' && csvState.sourceFileName) {
                sourceText = `Source: ${csvState.sourceFileName}`;
                if (csvState.sourceSheetName) {
                    sourceText += ` (${csvState.sourceSheetName})`;
                }
            } else {
                sourceText = 'Source: Pasted data';
            }
            batchSourceInfo.textContent = sourceText;
        }
    }

    // =========================================================================
    // Processing Mode Functions (GitHub Issue #78)
    // =========================================================================

    /**
     * Populate processing mode dropdown based on environment configuration
     * GitHub Issue #78: Allow users to select processing mode at execution time
     */
    function populateProcessingModeDropdown(parallelConfig) {
        const dropdown = document.getElementById('processingModeDropdown');
        const detailsSpan = document.getElementById('executionConcurrencyDetails');

        if (!dropdown) return;

        // Clear existing options
        dropdown.innerHTML = '';

        // Always add Sequential option (default)
        const sequentialOption = document.createElement('option');
        sequentialOption.value = '1';
        sequentialOption.textContent = 'Sequential (Safest)';
        dropdown.appendChild(sequentialOption);

        // Add parallel options if enabled in environment
        if (parallelConfig && parallelConfig.enabled) {
            const maxAllowed = parallelConfig.maxConcurrency || 16;
            const parallelOptions = [2, 4, 8, 16].filter(n => n <= maxAllowed);

            parallelOptions.forEach(concurrency => {
                const option = document.createElement('option');
                option.value = concurrency.toString();
                option.textContent = `${concurrency} concurrent requests`;
                dropdown.appendChild(option);
            });

            // Set details text based on capabilities
            detailsSpan.textContent = `(up to ${maxAllowed} concurrent requests available)`;
        } else {
            // Parallel processing not enabled
            detailsSpan.textContent = '(parallel processing not enabled in environment)';
        }

        // Default to Sequential
        dropdown.value = '1';
        updateProcessingModeDetails();
    }

    /**
     * Handle processing mode dropdown change
     * GitHub Issue #78: Update UI and store selected mode
     */
    function onProcessingModeChange() {
        updateProcessingModeDetails();
    }

    /**
     * Update processing mode details text
     */
    function updateProcessingModeDetails() {
        const dropdown = document.getElementById('processingModeDropdown');
        const detailsSpan = document.getElementById('executionConcurrencyDetails');

        if (!dropdown || !detailsSpan) return;

        const selectedConcurrency = parseInt(dropdown.value);
        if (selectedConcurrency === 1) {
            detailsSpan.textContent = '(transactions processed one at a time)';
        } else {
            detailsSpan.textContent = `(${selectedConcurrency} API calls run simultaneously)`;
        }
    }

    /**
     * Get selected processing mode configuration
     * Returns the configuration to pass to execution
     */
    function getSelectedProcessingMode() {
        const dropdown = document.getElementById('processingModeDropdown');
        if (!dropdown) return { enabled: false, maxConcurrency: 1 };

        const selectedConcurrency = parseInt(dropdown.value);
        return {
            enabled: selectedConcurrency > 1,
            maxConcurrency: selectedConcurrency
        };
    }

    /**
     * Show context menu for progress bar to change parallel processing mode
     * GitHub Issue #78: Allow switching processing mode during execution
     */
    function showProgressContextMenu(event, stageId) {
        event.preventDefault();
        event.stopPropagation();

        // Remove any existing context menu
        const existingMenu = document.getElementById('progress-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // Get current environment config
        const parallelConfig = csvState.currentEnvironment?.parallelProcessing;
        if (!parallelConfig || !parallelConfig.enabled) {
            // Show notification that parallel processing is not enabled
            getVscode().postMessage({
                type: 'showInfo',
                message: 'Parallel processing is not enabled in the current environment. Configure it in Environment settings to use this feature.'
            });
            return;
        }

        // Create context menu
        const contextMenu = document.createElement('div');
        contextMenu.id = 'progress-context-menu';
        contextMenu.className = 'progress-context-menu';
        contextMenu.style.position = 'fixed';
        contextMenu.style.left = `${event.clientX}px`;
        contextMenu.style.top = `${event.clientY}px`;
        contextMenu.style.zIndex = '10000';

        // Build menu items
        const menuItems = [
            { value: '1', label: 'Sequential (Safest)', icon: '🔄' },
            { value: '2', label: 'Low Parallel (2 concurrent)', icon: '⚡' },
            { value: '4', label: 'Medium Parallel (4 concurrent)', icon: '⚡⚡' },
            { value: '8', label: 'High Parallel (8 concurrent)', icon: '⚡⚡⚡' },
            { value: '16', label: 'Maximum Parallel (16 concurrent)', icon: '⚡⚡⚡⚡' }
        ];

        // Filter based on environment limits
        const maxAllowed = parallelConfig.maxConcurrency || 16;
        const availableItems = menuItems.filter(item => parseInt(item.value) <= maxAllowed);

        // Get current mode
        const currentMode = getCurrentProcessingMode();

        contextMenu.innerHTML = `
            <div class="context-menu-header">
                <span class="context-menu-title">Processing Mode</span>
                <span class="context-menu-stage">${stageId.toUpperCase()}</span>
            </div>
            ${availableItems.map(item => `
                <div class="context-menu-item ${currentMode === item.value ? 'active' : ''}"
                     data-click="changeProcessingMode" data-arg="${item.value}" data-stage="${stageId}">
                    <span class="menu-icon">${item.icon}</span>
                    <span class="menu-label">${item.label}</span>
                    ${currentMode === item.value ? '<span class="current-indicator">●</span>' : ''}
                </div>
            `).join('')}
            <div class="context-menu-separator"></div>
            <div class="context-menu-item info-item">
                <span class="menu-icon">ℹ️</span>
                <span class="menu-label">Right-click progress bar to change</span>
            </div>
        `;

        document.body.appendChild(contextMenu);

        // Position menu to avoid going off-screen
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${event.clientX - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${event.clientY - rect.height}px`;
        }

        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!contextMenu.contains(e.target)) {
                contextMenu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 100);
    }

    /**
     * Get current processing mode from dropdown or stored state
     */
    function getCurrentProcessingMode() {
        const dropdown = document.getElementById('processingModeDropdown');
        if (dropdown) {
            return dropdown.value;
        }
        // Fallback to sequential if dropdown not available
        return '1';
    }

    /**
     * Change processing mode and update UI indicators
     */
    function changeProcessingMode(newMode, stageId) {
        const modeValue = parseInt(newMode);

        // Update dropdown if available
        const dropdown = document.getElementById('processingModeDropdown');
        if (dropdown) {
            dropdown.value = newMode;
            // Trigger change event to update details
            if (window.CSVHandler?.onProcessingModeChange) {
                window.CSVHandler.onProcessingModeChange();
            }
        }

        // Update progress bar indicator
        updateProgressModeIndicator(stageId, modeValue);

        // Send message to backend about mode change
        getVscode().postMessage({
            type: 'processingModeChanged',
            mode: {
                enabled: modeValue > 1,
                maxConcurrency: modeValue
            },
            stageId: stageId
        });

        // Show confirmation
        const modeLabel = modeValue === 1 ? 'Sequential' : `${modeValue} Concurrent`;
        getVscode().postMessage({
            type: 'showInfo',
            message: `Processing mode changed to: ${modeLabel}`
        });

        // Remove context menu
        const contextMenu = document.getElementById('progress-context-menu');
        if (contextMenu) {
            contextMenu.remove();
        }
    }

    /**
     * Update progress bar mode indicator
     */
    function updateProgressModeIndicator(stageId, concurrency) {
        const indicator = document.getElementById(`mode-indicator-${stageId}`);
        if (!indicator) return;

        // Set indicator class and content based on concurrency
        indicator.className = 'progress-mode-indicator';
        if (concurrency === 1) {
            indicator.classList.add('mode-sequential');
            indicator.textContent = '🔄';
            indicator.title = 'Sequential Processing';
        } else if (concurrency <= 4) {
            indicator.classList.add('mode-parallel-low');
            indicator.textContent = '⚡';
            indicator.title = `Parallel Processing (${concurrency} concurrent)`;
        } else if (concurrency <= 8) {
            indicator.classList.add('mode-parallel-medium');
            indicator.textContent = '⚡⚡';
            indicator.title = `High Parallel Processing (${concurrency} concurrent)`;
        } else {
            indicator.classList.add('mode-parallel-high');
            indicator.textContent = '⚡⚡⚡';
            indicator.title = `Maximum Parallel Processing (${concurrency} concurrent)`;
        }
    }

    // =========================================================================
    // Module Public API
    // =========================================================================

    function init(sharedState, vscodeFn) {
        csvState = sharedState;
        getVscode = vscodeFn;
    }

    // Expose globals for onclick handlers in HTML
    window.populateProcessingModeDropdown = function(parallelConfig) {
        populateProcessingModeDropdown(parallelConfig);
    };
    window.showProgressContextMenu = function(event, stageId) {
        showProgressContextMenu(event, stageId);
    };
    window.changeProcessingMode = function(newMode, stageId) {
        changeProcessingMode(newMode, stageId);
    };

    window.DTBatchConfig = {
        init: init,

        // Format conversion
        showFormatConversionUI: showFormatConversionUI,
        updateSelectedSheet: updateSelectedSheet,
        updateSelectedDelimiter: updateSelectedDelimiter,
        startFormatConversion: startFormatConversion,

        // Batch naming
        generateDefaultBatchName: generateDefaultBatchName,
        sanitizeBatchName: sanitizeBatchName,
        updateBatchName: updateBatchName,
        refreshBatchName: refreshBatchName,

        // Execution summary
        populateExecutionSummary: populateExecutionSummary,
        initializeBatchNameInput: initializeBatchNameInput,

        // Processing mode
        populateProcessingModeDropdown: populateProcessingModeDropdown,
        onProcessingModeChange: onProcessingModeChange,
        getSelectedProcessingMode: getSelectedProcessingMode,
        showProgressContextMenu: showProgressContextMenu,
        changeProcessingMode: changeProcessingMode,
        updateProgressModeIndicator: updateProgressModeIndicator,
        getCurrentProcessingMode: getCurrentProcessingMode
    };
})();
