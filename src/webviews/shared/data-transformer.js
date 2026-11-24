// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * CSV Handler Module
 * Handles all CSV upload, parsing, validation, and modal functionality
 */
(function () {
    // Get vscode API from window (set by bridge)
    const getVscode = () => window.vscode;
    // Performance Optimization Constants (GitHub Issue #106)
    const PREVIEW_SAMPLE_SIZE = 50; // Number of rows to process for preview/validation
    const TABLE_DISPLAY_ROWS = 10; // Number of rows to show in preview tables

    // Module state
    const csvState = {
        currentFile: null,
        currentParsedData: null,
        currentHeaders: [],
        modalStep: 1,
        verificationPassed: false,
        templateVariables: [],
        apiCallEstimation: null,
        executionInfo: null,
        rawCSVContent: null,
        jsonPreviewEditor: null, // Monaco editor instance for JSON preview
        arrayRepetition: null, // Store array repetition value from endpoint config
        selectedArrayPath: null, // Store selected array path for repetition
        arraysAlreadyDetected: false, // Flag to prevent dropdown re-population on slider changes
        endpointConfig: null, // Store full endpoint configuration for execution
        fileFormat: null, // Detected file format
        formatMetadata: null, // Format-specific metadata (sheets, delimiters, etc.)
        fileDetailsShown: false, // Track if file details are displayed
        originalDropzoneContent: null, // Store original dropzone content for restoration
        isProcessing: false, // Track if file processing is in progress
        selectedColumnTypes: {}, // Store user-selected column types for cross-step persistence
        transformationInProgress: false, // Track if data transformation is in progress
        // Batch naming support
        sourceType: null, // 'file' or 'paste' - how data was provided
        originalSourceType: null, // Preserved across Step 3→4 sourceType overwrite
        step2State: null, // Step 2's variables/headers/source, kept while Steps 3-4 run on the grid's
        sourceFileName: null, // Original filename (if uploaded)
        sourceSheetName: null, // Excel sheet name (if Excel file)
        batchName: null, // User-defined or generated batch name
        // Parallel processing configuration from current environment
        currentEnvironment: null, // Store current environment data including parallel processing config
        // Query param repetition (GitHub Issue #108)
        queryParamRepetition: null, // Detected repeatable query param configuration
        queryParamVariables: null, // Template variables extracted from query param pattern
        // Performance optimization (GitHub Issue #106)
        totalRowCount: 0, // Store total row count for accurate API estimation while using sampled data
        executeAfterTransform: false, // Flag to execute after full transformation completes
        executionEndpointId: null, // Store endpoint ID for execution after transformation
        // Leading zero fix: Store full transformed CSV string from backend
        fullTransformedCSV: null, // Backend's properly formatted CSV string (preserves quoting)
        transformedHeaders: null, // Parsed headers from transformed data (for UI display)
        transformedRows: null, // Parsed rows from transformed data (for UI display)
        // Grid progressive copy state (Enhanced Data Entry - Fast Keyboard-Driven Entry)
        progressiveCopyState: {
            active: false,           // Is progressive copy mode active?
            currentLevel: 0,         // Which nesting level we're at (0=none, 1=L1, 2=L2, 3=L3)
            newRowIndex: -1          // Index of the newly added row
        },
        gridNestingInfo: null, // { l1Fields: [colIndex], l2Fields: [...], l3Fields: [...] }
        gridInitialized: false, // Track if grid is initialized
        gridUndoStack: [], // GitHub Issue #162: Stack of grid states for undo (Ctrl+Z)
        // GitHub Issue #172: Tab delimiter support
        detectedDelimiter: ',', // ',' for CSV, '\t' for TSV (Excel paste)
        // GitHub Issue #202: Tab UI state (file/paste tabs in Step 1)
        activeTab: 'file', // 'file' | 'paste'
        dataEntryMode: false, // true when user clicked "Enter Data" (skips Step 2)
        tabData: {
            file: { hasData: false, fileName: null },
            paste: { hasData: false, content: '' }
        },
        // GitHub Issue #148: CSV Sorting for Nested Arrays
        sortingPending: false, // Whether we're waiting for user to respond to sorting prompt
        sortingInfo: null, // { sortColumns: [], arrayPaths: [], explanation: '' }
        sortingDecision: null, // null | 'sorted' | 'unsorted' - tracks user's sorting choice for footer notification
    };

    // GitHub Issue #195: Initialize extracted modules with shared state
    // Modules are loaded via <script> tags BEFORE this orchestrator
    if (window.DTDataEntryGrid) { window.DTDataEntryGrid.init(csvState, getVscode); }
    if (window.DTTypeCoercion) { window.DTTypeCoercion.init(csvState, getVscode); }
    if (window.DTDataIngestion) { window.DTDataIngestion.init(csvState, getVscode); }
    if (window.DTDataPreview) { window.DTDataPreview.init(csvState, getVscode); }
    if (window.DTMismatchRepair) { window.DTMismatchRepair.init(csvState, getVscode); }
    if (window.DTBatchConfig) { window.DTBatchConfig.init(csvState, getVscode); }

    // File Processing Stages Configuration
    const FILE_PROCESSING_STAGES = [
        { id: 'reading', label: 'Reading file', percentage: 0 },
        { id: 'parsing', label: 'Parsing data', percentage: 0 },
        { id: 'analyzing', label: 'Analyzing content', percentage: 0 },
        { id: 'preparing', label: 'Preparing preview', percentage: 0 }
    ];

    // Query Parameter Repetition Detection (GitHub Issue #108)
    // Detects pattern[ separator ] syntax for bulk extraction
    function detectRepeatableQueryParam(endpointConfig) {
        if (!endpointConfig || !endpointConfig.queryParams) {
            return { detected: false };
        }

        // Check each query param for [ ] syntax
        for (const [key, value] of Object.entries(endpointConfig.queryParams)) {
            // Handle both string format and {value, enabled} format (GitHub Issue #108)
            const paramValue = typeof value === 'string' ? value : value?.value;
            if (!paramValue) continue;

            const match = paramValue.match(/^(.+?)\[([^\]]*)\]$/);
            if (match) {
                return {
                    detected: true,
                    paramKey: key,
                    pattern: match[1].trim(),
                    separator: match[2] || '&' // Default to & if empty brackets
                };
            }
        }

        return { detected: false };
    }

    /**
     * GitHub Issue #172: Detect delimiter in content (tab vs comma)
     * Returns '\t' for tab-delimited data (e.g., Excel paste), ',' for CSV
     */
    function detectDelimiter(content) {
        const firstLine = content.split('\n')[0] || '';
        const tabCount = (firstLine.match(/\t/g) || []).length;
        const commaCount = (firstLine.match(/,/g) || []).length;
        // GitHub Issue #178: Detect pipe-delimited data (e.g., " | " or "|")
        const pipeCount = (firstLine.match(/\|/g) || []).length;

        // If tabs are present AND more tabs than commas/pipes, it's tab-delimited
        // This handles Excel paste which uses tabs
        if (tabCount > 0 && tabCount >= commaCount && tabCount >= pipeCount) {
            return '\t';
        }
        // If pipes are present AND more pipes than commas, it's pipe-delimited
        if (pipeCount > 0 && pipeCount > commaCount) {
            return '|';
        }
        return ',';
    }

    /**
     * GitHub Issue #172: Parse delimited line (supports tab and comma)
     * Handles quoted values and escaped quotes
     */
    function parseDelimitedLine(line, delimiter) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    // Escaped quote inside quoted string
                    current += '"';
                    i++; // Skip next quote
                } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                // Field separator (only when not inside quotes)
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        // Don't forget the last field
        result.push(current.trim());
        return result;
    }

    /**
     * GitHub Issue #172: Parse delimited content into headers and rows
     * Auto-detects delimiter if not specified
     */
    function parseDelimitedContent(content, delimiter) {
        const lines = content.split('\n').filter(line => line.trim().length > 0);
        if (lines.length === 0) {
            return { headers: [], rows: [], delimiter: ',' };
        }

        // Auto-detect delimiter if not provided
        const detectedDelimiter = delimiter || detectDelimiter(content);

        const headers = parseDelimitedLine(lines[0], detectedDelimiter);
        const rows = lines.slice(1).map(line => parseDelimitedLine(line, detectedDelimiter));

        return { headers, rows, delimiter: detectedDelimiter };
    }

    // Extract template variables from pattern (e.g., {{ITEM}} from "ItemId={{ITEM}}")
    function extractTemplateVariables(pattern) {
        const regex = /\{\{([^}]+)\}\}/g;
        const variables = [];
        let match;

        while ((match = regex.exec(pattern)) !== null) {
            variables.push(match[1].trim());
        }

        return variables;
    }

    // Calculate max items per request based on URL length limit
    function calculateMaxItemsPerRequest(pattern, separator, sampleValue, maxUrlLength = 2000) {
        const baseUrl = 50; // Rough estimate for base URL + query param key
        const availableSpace = maxUrlLength - baseUrl;

        // Replace template variables with sample value
        let processedPattern = pattern;
        const variables = extractTemplateVariables(pattern);
        variables.forEach(variable => {
            const regex = new RegExp(`\\{\\{${variable}\\}\\}`, 'g');
            processedPattern = processedPattern.replace(regex, sampleValue);
        });

        const singleItemLength = processedPattern.length + separator.length;
        const maxItems = Math.floor((availableSpace + separator.length) / singleItemLength);

        return Math.max(1, maxItems); // At least 1 item
    }

    // Build preview query string
    // GitHub Issue #108: Use shared query-param-builder module for consistency
    function buildQueryStringPreview(pattern, separator, values, maxItems) {
        const previewValues = values.slice(0, Math.min(maxItems, values.length));

        // Extract variable name from pattern
        const variables = extractTemplateVariables(pattern);
        const variableName = variables[0]; // Use first variable

        // Use shared builder to create the VALUE portion (e.g., "itemId=ITM001 or itemId=ITM002")
        const valueString = window.queryParamBuilder.buildQueryString(pattern, variableName, previewValues, separator);

        // Prepend the paramKey to show full query string (e.g., "query=itemId=ITM001 or itemId=ITM002")
        const paramKey = csvState.queryParamRepetition?.paramKey || 'query';
        return `${paramKey}=${valueString}`;
    }

    // File Processing Progress Functions
    function formatFileSize(...args) {
        return window.DTDataIngestion.formatFileSize(...args);
    }

    function showProgressInDropzone(...args) {
        return window.DTDataIngestion.showProgressInDropzone(...args);
    }

    function updateFileProgress(...args) {
        return window.DTDataIngestion.updateFileProgress(...args);
    }

    function completeProgressAndRestore(...args) {
        return window.DTDataIngestion.completeProgressAndRestore(...args);
    }

    function handleProgressError(...args) {
        return window.DTDataIngestion.handleProgressError(...args);
    }

    // Multi-Format File Processing
    function handleCSVUpload(...args) {
        return window.DTDataIngestion.handleCSVUpload(...args);
    }

    function processMultiFormatFile(...args) {
        return window.DTDataIngestion.processMultiFormatFile(...args);
    }

    function processCSVFile(...args) {
        return window.DTDataIngestion.processCSVFile(...args);
    }

    function handleCSVDrop(...args) {
        return window.DTDataIngestion.handleCSVDrop(...args);
    }

    function handleCSVDragOver(...args) {
        return window.DTDataIngestion.handleCSVDragOver(...args);
    }

    function handleCSVDragLeave(...args) {
        return window.DTDataIngestion.handleCSVDragLeave(...args);
    }

    function createCSVStringFromCurrentData(...args) {
        return window.DTTypeCoercion.createCSVStringFromCurrentData(...args);
    }

    function createCSVStringFromData(...args) {
        return window.DTTypeCoercion.createCSVStringFromData(...args);
    }

    function handleTypeTransformationResult(...args) {
        return window.DTTypeCoercion.handleTypeTransformationResult(...args);
    }

    function parseCSVLine(...args) {
        return window.DTTypeCoercion.parseCSVLine(...args);
    }

    function resetCSVModal() {
        csvState.currentFile = null;
        csvState.currentParsedData = null;
        csvState.currentHeaders = [];
        csvState.modalStep = 1;
        csvState.verificationPassed = false;
        csvState.fileFormat = null; // Reset format detection
        csvState.formatMetadata = null; // Reset format metadata
        csvState.fileDetailsShown = false; // Reset file details state
        csvState.arraysAlreadyDetected = false; // Reset array detection flag for next modal use
        csvState.activeNotification = null; // GitHub Issue #135: Clear unified notification
        csvState.autoSkipAttempted = false; // Reset auto-skip flag for fresh modal
        csvState.sortingDecision = null; // GitHub Issue #148: Reset sorting decision
        csvState.originalSourceType = null; // Reset original source type tracking
        csvState.step2State = null;
        csvState.maxStepReached = 1;
        // Results checked against the previous rows: a re-chain into an open Run Batch kept
        // these, and Step 2 showed the old run's values beside the new rows.
        csvState.coercionResults = null;
        csvState.sampleValues = null;
        csvState.transformedRows = null;

        // Clean up Monaco editor instance
        if (csvState.jsonPreviewEditor) {
            csvState.jsonPreviewEditor.dispose();
            csvState.jsonPreviewEditor = null;
        }

        // Restore modal scrolling
        const modalBody = document.querySelector('#csvUploadModal .modal-body');
        if (modalBody) {
            modalBody.classList.remove('modal-body-scroll-hidden', 'modal-body-scroll-auto');
        }

        // Clear global state
        window.currentParsedCsvData = null;
        window.currentCSVFileName = null;
        window.currentCSVFileSize = null;
        window.currentMappings = null;

        // Reset file input
        const fileInput = document.getElementById('csvModalFileInput');
        if (fileInput) fileInput.value = '';

        // Reset paste area
        const pasteArea = document.getElementById('csvPasteArea');
        if (pasteArea) pasteArea.value = '';

        // GitHub Issue #135: Clear unified notification
        clearModalNotification();

        // Show upload UI elements
        showUploadUI();

        // GitHub Issue #162: Request environment data early for timezone conversion
        getVscode().postMessage({
            type: 'getCurrentEnvironment'
        });

        // Reset to step 1
        showCSVStep(1);
    }

    function showCSVStep(stepNumber) {
        // Track current step for transformation updates
        csvState.currentStep = stepNumber;

        // Cancel any in-progress chunked grid render when navigating AWAY from Step 3
        if (csvState.modalStep === 3 && window.DTDataEntryGrid?.cancelChunkedRender) {
            window.DTDataEntryGrid.cancelChunkedRender();
        }

        // Step 1: Source, Step 2: Map, Step 3: Validate, Step 4: Review — the last: Execute is its
        // button (#435; there was a Step 5 for the run's settings, now on Review's Configure)
        // Hide all steps
        const steps = ['csvUploadStep', 'csvMappingStep', 'csvDataValidationStep', 'csvJsonPreviewStep'];
        steps.forEach(stepId => {
            const step = document.getElementById(stepId);
            if (step) step.classList.add('hidden');
        });

        // GitHub Issue #308: one Step 4 for every endpoint — body, URL parameters or both.
        // The batch plan says which; the URL-only preview step is gone.
        const step4Id = 'csvJsonPreviewStep';

        const stepIds = {
            1: 'csvUploadStep',
            2: 'csvMappingStep',            // Map & Transform
            3: 'csvDataValidationStep',     // Review & Edit Data
            4: step4Id                       // Review: the requests, the run's settings, Execute
        };

        // Show current step
        const currentStepId = stepIds[stepNumber];
        const currentStep = document.getElementById(currentStepId);
        if (currentStep) {
            currentStep.classList.remove('hidden');
        }

        csvState.modalStep = stepNumber;
        // (#470: the run heading follows the steps: Input from Validate on, Requests on Review)
        if (window.RunBatchHeading) window.RunBatchHeading.onStep(stepNumber);
        // (#466/#470: Review's Requests table tells the host whether it is on screen)
        if (window.ReviewRequests) window.ReviewRequests.onStep(stepNumber);
        // (slice 5: Validate's search box, ★ and row count follow its table)
        if (window.ValidateSearch) window.ValidateSearch.onStep(stepNumber);
        // The step bar lets the user click back to any step reached since the data loaded
        csvState.maxStepReached = stepNumber === 1 ? 1 : Math.max(csvState.maxStepReached || 1, stepNumber);
        csvState.navigationInProgress = false;
        updateCSVModalTitle(stepNumber);

        // Special handling for step 1 - ensure correct UI state
        if (stepNumber === 1) {
            if (csvState.fileDetailsShown && csvState.fileFormat && window.currentCSVFileName) {
                // File is selected, show file details
                const mockFormatMessage = {
                    format: csvState.fileFormat,
                    metadata: csvState.formatMetadata || {},
                    confidence: 1.0
                };
                showFileDetails(mockFormatMessage);

                // GitHub Issue #207: Re-validate the selected sheet on Back navigation
                if (csvState.fileFormat === 'excel' && csvState.sheetDetails && window.DTDataIngestion?.showExcelValidation) {
                    const savedChoice = csvState.filterChoice;
                    window.DTDataIngestion.showExcelValidation(csvState.selectedSheetIndex || 0);
                    // Restore radio selection and filterChoice from before navigation
                    if (savedChoice) {
                        csvState.filterChoice = savedChoice;
                        const radio = document.querySelector(`input[name="filterMode"][value="${savedChoice}"]`);
                        if (radio) radio.checked = true;
                        if (window.CSVHandler?.clearModalNotification) {
                            window.CSVHandler.clearModalNotification();
                        }
                        if (window.CSVHandler?.updateReadButtonState) {
                            window.CSVHandler.updateReadButtonState();
                        }
                    }
                }
            } else {
                // No file selected, show upload UI
                showUploadUI();
            }
        }

        updateCSVNavigationButtons();

        // Step 2 - Map & Transform
        if (stepNumber === 2) {
            if (csvState.rawCSVContent && !csvState.currentHeaders) {
                getVscode().postMessage({
                    type: 'parseCSVForModal',
                    csvData: csvState.rawCSVContent,
                    fileName: window.currentCSVFileName,
                    fileSize: window.currentCSVFileSize
                });
            }

            const templateVars = csvState.templateVariables ||
                (csvState.sourceType === 'grid' ? csvState.gridTemplateVariables : null);

            if (templateVars && templateVars.length > 0) {
                if (!csvState.templateVariables) {
                    csvState.templateVariables = templateVars;
                }
                if (csvState.currentHeaders && !csvState.transformationInProgress) {
                    populateColumnMappingTable();
                }
            } else {
                console.warn('No template variables available for mapping');
            }
        }

        // GitHub Issue #202: Step 3 - Review & Edit Data (NEW)
        if (stepNumber === 3) {
            // Grid is already initialized from endpoint config.
            // For dataEntryMode (Enter Data path), grid is empty and ready.
            // For file/paste path, grid has been populated by populateGridFromMappedData().

            // Hide add/delete row controls for file/paste sources (structural changes not allowed)
            // Use originalSourceType because sourceType gets overwritten to 'grid' during Step 3→4 transition
            const container = document.getElementById('gridEntryContainer');
            if (container) {
                const origin = csvState.originalSourceType || csvState.sourceType;
                if (origin === 'file' || origin === 'paste') {
                    container.classList.add('grid-readonly-structure');
                } else {
                    container.classList.remove('grid-readonly-structure');
                }
            }
        }

        // GitHub Issue #202: Step 4 - Review JSON/URLs (was Step 3)
        if (stepNumber === 4) {
            const modalBody = document.querySelector('#csvUploadModal .modal-body');
            if (modalBody) {
                modalBody.classList.add('modal-body-scroll-hidden');
            }

            // GitHub Issue #148/#308: a sort for nested JSON is explained in the ⓘ on API
            // calls (BatchExplainer), where the grouping it serves is — not in a toast.

            if (csvState.currentHeaders) {
                refreshTransformedDataForStep4();
            } else {
                generateJSONPreview();
            }
            // #435: the run's settings and where it is sent (name, error handling, processing
            // mode, environment) fill in here, beside Execute
            populateExecutionSummary();
        } else {
            const modalBody = document.querySelector('#csvUploadModal .modal-body');
            if (modalBody) {
                modalBody.classList.remove('modal-body-scroll-hidden');
            }
        }

        // GitHub Issue #247: the walk forward — each passed step presses its own Next
        if (window.DTAutoAdvance) window.DTAutoAdvance.onStep(stepNumber);
        // GitHub Issue #247: a chained Run Batch hides Step 1
        if (window.ChainPreload) window.ChainPreload.onStep(stepNumber);
        // The batch's name is in the footer on every step: until the user names it, it follows the source
        if (window.DTBatchConfig && window.DTBatchConfig.refreshBatchName) window.DTBatchConfig.refreshBatchName();
        if (window.BatchStepper) window.BatchStepper.refresh();
    }

    function updateCSVModalTitle(stepNumber) {
        const modalTitle = document.getElementById('csvModalTitle');
        if (!modalTitle) return;

        // #308: one Step 4 for body and URL endpoints alike
        const titles = {
            1: 'Step 1: Source',
            2: 'Step 2: Map',
            3: 'Step 3: Validate',
            4: 'Step 4: Review'
        };

        modalTitle.textContent = titles[stepNumber] || 'Batch Data Loading';
    }

    function updateCSVNavigationButtons() {
        const prevBtn = document.getElementById('csvBackBtn');
        const nextBtn = document.getElementById('csvNextBtn');
        const executeBtn = document.getElementById('csvExecuteBtn');
        const enterDataBtn = document.getElementById('csvEnterDataBtn');

        if (prevBtn) {
            // Always there, as in every stepped screen's footer: on the first step it has nowhere to go
            prevBtn.classList.remove('hidden');
            prevBtn.disabled = csvState.modalStep <= 1;
        }

        if (nextBtn) {
            // Review is the last step: Execute in Next's place
            if (csvState.modalStep < 4) {
                nextBtn.classList.remove('hidden');
            } else {
                nextBtn.classList.add('hidden');
            }
            // Don't override disabled/text while grid is loading
            if (nextBtn.dataset.loadingProgress !== 'true') {
                nextBtn.disabled = !isStepValid(csvState.modalStep);
            }

            // Update button text based on step (skip if grid loading owns the button)
            if (nextBtn.dataset.loadingProgress !== 'true') {
                if (csvState.modalStep === 1) {
                    updateReadButtonState();
                } else {
                    // Next says where it goes (Review's own button is Execute)
                    nextBtn.textContent = csvState.modalStep === 2 ? 'Next: Validate' : csvState.modalStep === 3 ? 'Next: Review' : 'Next';
                }
            }
        }

        // GitHub Issue #202: Enter Data button - visible only on Step 1
        // GitHub Issue #204: Disable when file/paste data is loaded (mutually exclusive with Read)
        if (enterDataBtn) {
            if (csvState.modalStep === 1) {
                enterDataBtn.classList.remove('hidden');
                enterDataBtn.disabled = hasCSVDataSelected();
            } else {
                enterDataBtn.classList.add('hidden');
            }
        }

        if (executeBtn) {
            // #435: Execute on Review, the settings beside it (no step of their own to scroll through)
            if (csvState.modalStep === 4) {
                executeBtn.classList.remove('hidden');
                if (!executeBtn.querySelector('.btn-spinner')) {
                    executeBtn.textContent = 'Execute';
                    executeBtn.disabled = false;
                }
                executeBtn.title = '';
            } else {
                executeBtn.classList.add('hidden');
                executeBtn.disabled = false;
                executeBtn.title = '';
            }
        }

    }

    function updateReadButtonState() {
        const nextBtn = document.getElementById('csvNextBtn');
        if (!nextBtn || csvState.modalStep !== 1) return;

        // GitHub Issue #204: Label reflects active tab
        nextBtn.textContent = 'Import Data';

        // Enable when data is available from file or paste
        const hasData = hasCSVDataSelected();

        if (csvState.sourceType === 'file') {
            nextBtn.disabled = !(hasData && csvState.fileDetailsShown);
        } else {
            // Paste just needs data present
            nextBtn.disabled = !hasData;
        }

        // GitHub Issue #207: Disable Read File if sheet has validation errors or no filter choice
        if (!nextBtn.disabled && csvState.sheetDetails && csvState.fileFormat === 'excel') {
            const selectedIndex = csvState.selectedSheetIndex || 0;
            const sheet = csvState.sheetDetails[selectedIndex];
            if (sheet && sheet.validationStatus === 'error') {
                nextBtn.disabled = true;
            }
            if (!nextBtn.disabled && sheet?.filter?.hasHiddenRows && !csvState.filterChoice) {
                nextBtn.disabled = true;
            }
        }

        // GitHub Issue #204: Enter Data is mutually exclusive with Read
        const enterDataBtn = document.getElementById('csvEnterDataBtn');
        if (enterDataBtn) {
            enterDataBtn.disabled = hasData;
        }
    }

    function isStepValid(stepNumber) {
        // GitHub Issue #202: 5-step workflow
        switch (stepNumber) {
            case 1:
                const hasData = hasCSVDataSelected();
                if (csvState.sourceType === 'file') {
                    if (!hasData || !csvState.fileDetailsShown) return false;
                    // GitHub Issue #207: Block if sheet has validation errors or no filter choice
                    if (csvState.sheetDetails && csvState.fileFormat === 'excel') {
                        const selectedIndex = csvState.selectedSheetIndex || 0;
                        const sheet = csvState.sheetDetails[selectedIndex];
                        if (sheet && sheet.validationStatus === 'error') return false;
                        if (sheet?.filter?.hasHiddenRows && !csvState.filterChoice) return false;
                    }
                    return true;
                }
                return hasData;
            case 2:
                // Map: Next is always enabled — pressing it re-checks the mapping and says what
                // is missing (stopOnStepIssues). The step bar holds the later steps meanwhile.
                return true;
            case 3:
                // Step 3: Review & Edit Data - grid must have data
                return hasGridData();
            default:
                return true;
        }
    }

    function hasCSVDataSelected() {
        // GitHub Issue #202: Check file or paste data (grid moved to Step 3)

        // Check if file is selected via click-to-browse
        const fileInput = document.getElementById('csvModalFileInput');
        if (fileInput && fileInput.files.length > 0) return true;

        // GitHub Issue #111: Check csvState.currentFile for drag-and-drop files
        if (csvState.currentFile) return true;

        // Check file tab data
        if (csvState.tabData.file.hasData) return true;

        // Check paste area
        const pasteArea = document.getElementById('csvPasteArea');
        if (pasteArea && pasteArea.value.trim()) return true;

        // Check if we have parsed data
        return window.currentParsedCsvData && window.currentParsedCsvData.length > 0;
    }

    /**
     * `|opt` means the value is not required (an empty one drops the key/value pair from the
     * JSON) and `|null` sends null — so neither needs a column in the file. An optional
     * variable may stay unmapped; JsonGenerator.addEmptyColumnsForUnmappedOptionals gives
     * it an empty value at generation time. Same detection the mapping table uses for its
     * "optional" ○ indicator.
     */
    function isOptionalTemplateVariable(variable) {
        if (!variable) return false;
        let mods = variable.modifiers;
        if (!mods && variable.formatModifier) {
            try {
                mods = parseModifiersForGrid(variable.formatModifier, variable.dataType || 'string');
            } catch (e) {
                mods = null;
            }
        }
        return !!(mods && (mods.isOptional || mods.isNullable));
    }

    /** Variables the user must map: not A8 (generated), not ENV (from the environment), not optional. */
    function getVariablesThatNeedMapping() {
        return (csvState.templateVariables || []).filter(v => {
            const name = v.name || '';
            // GitHub Issue #137: A8 system variables don't need mapping
            if (name.toUpperCase().startsWith('A8:')) return false;
            // GitHub Issue #165: ENV variables come from the environment, not user input
            if (name.toUpperCase().startsWith('ENV:')) return false;
            if (isOptionalTemplateVariable(v)) return false;
            return true;
        });
    }

    function areAllRequiredVariablesMapped() {
        if (!csvState.templateVariables || csvState.templateVariables.length === 0) {
            return false;
        }

        const userVariables = getVariablesThatNeedMapping();

        // If only A8 variables exist, consider it valid (no user mapping needed)
        if (userVariables.length === 0) {
            return true;
        }

        // Check if all user variables are mapped
        const allMapped = userVariables.every(variable => variable.mapped);
        if (!allMapped) {
            return false;
        }

        // GitHub Issue #140: Don't block on type mismatches - data will be coerced during transformation
        // Removed type mismatch check that was blocking navigation even when coercion is possible
        // (e.g., string "11" can be coerced to number 11)
        return true;
    }

    // Format Conversion Functions
    function showFormatConversionUI(...args) {
        return window.DTBatchConfig.showFormatConversionUI(...args);
    }

    function formatFileSize(...args) {
        return window.DTDataIngestion.formatFileSize(...args);
    }

    function updateSelectedSheet(...args) {
        return window.DTBatchConfig.updateSelectedSheet(...args);
    }

    function updateSelectedDelimiter(...args) {
        return window.DTBatchConfig.updateSelectedDelimiter(...args);
    }

    // Batch Naming Functions
    function generateDefaultBatchName(...args) {
        return window.DTBatchConfig.generateDefaultBatchName(...args);
    }


    function sanitizeBatchName(...args) {
        return window.DTBatchConfig.sanitizeBatchName(...args);
    }

    function updateBatchName(...args) {
        return window.DTBatchConfig.updateBatchName(...args);
    }

    function startFormatConversion(...args) {
        return window.DTBatchConfig.startFormatConversion(...args);
    }

    // Prepare mapped CSV data
    function prepareMappedCSVData(...args) {
        return window.DTDataPreview.prepareMappedCSVData(...args);
    }


    // Initialize Monaco Editor for JSON Preview
    function initializeJsonPreviewEditor(...args) {
        return window.DTDataPreview.initializeJsonPreviewEditor(...args);
    }

    // Generate JSON Preview for Step 4 using backend JsonGenerator service
    function generateJSONPreview(...args) {
        return window.DTDataPreview.generateJSONPreview(...args);
    }

    /**
     * GitHub Issue #135: Get properly parsed CSV data for backend
     * Parses CSV using proper quote-aware parsing to handle values with commas
     * Returns { headers: string[], rows: string[][] }
     */
    function getParsedDataForBackend(...args) {
        return window.DTDataPreview.getParsedDataForBackend(...args);
    }

    // Helper function to convert parsed CSV data back to CSV string format
    function convertParsedDataToCSVString(...args) {
        return window.DTDataPreview.convertParsedDataToCSVString(...args);
    }

    // Helper function to display JSON preview errors
    function displayJsonPreviewError(...args) {
        return window.DTDataPreview.displayJsonPreviewError(...args);
    }

    // Query String Preview Functions (GitHub Issue #108)
    // Also handles query-param-only templates (UX improvement)
    function generateQueryStringPreview(...args) {
        return window.DTDataPreview.generateQueryStringPreview(...args);
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
            return calculateMaxItemsPerRequest(pattern, separator, sampleValue, maxUrlLength);
        } else if (value === 'custom') {
            const customInput = document.getElementById('customItemsInput');
            return customInput ? parseInt(customInput.value, 10) || 50 : 50;
        } else {
            return parseInt(value, 10) || 50;
        }
    }

    function calculateUrlLength(pattern, separator, values) {
        // Build full query string
        const queryString = buildQueryStringPreview(pattern, separator, values, values.length);
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

    function onItemsPerRequestChange(...args) {
        return window.DTDataPreview.onItemsPerRequestChange(...args);
    }

    function onCustomItemsChange(...args) {
        return window.DTDataPreview.onCustomItemsChange(...args);
    }

    function copyQueryPreview(...args) {
        return window.DTDataPreview.copyQueryPreview(...args);
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

    // Execution Summary Population
    function populateExecutionSummary(...args) {
        return window.DTBatchConfig.populateExecutionSummary(...args);
    }

    function initializeBatchNameInput(...args) {
        return window.DTBatchConfig.initializeBatchNameInput(...args);
    }

    // Error Handling
    function showCSVError(message) {
        if (window.DTAutoAdvance) window.DTAutoAdvance.cancel();   // GitHub Issue #247: show the step
        // Inline error display (context-specific)
        const errorContainer = document.getElementById('csvErrorMessage');
        if (errorContainer) {
            errorContainer.textContent = message;
            errorContainer.classList.remove('hidden');
            setTimeout(() => {
                errorContainer.classList.add('hidden');
            }, 5000);
        }

        // GitHub Issue #135: Also show in unified notification area (general awareness)
        showModalNotification('error', message, { persistent: false });
    }

    function showCSVVerificationError(message) {
        if (window.DTAutoAdvance) window.DTAutoAdvance.cancel();   // GitHub Issue #247: show the step
        // Inline error display (context-specific)
        const errorElement = document.getElementById('csvVerificationError');
        if (errorElement) {
            errorElement.innerHTML = message; // Use innerHTML to support HTML content
            errorElement.classList.remove('hidden');
        }

        const successElement = document.getElementById('csvVerificationSuccess');
        if (successElement) {
            successElement.classList.add('hidden');
        }

        csvState.verificationPassed = false;
        updateCSVNavigationButtons();

        // GitHub Issue #135: Also show in unified notification area (general awareness)
        // Strip HTML for the notification display
        const plainMessage = message.replace(/<[^>]*>/g, '');
        showModalNotification('error', plainMessage, { persistent: true });
    }

    // ================================================
    // GitHub Issue #135: Unified Modal Notification System
    // ================================================

    /**
     * GitHub Issue #268: single-slot source, so a new CSV notification replaces
     * the previous one exactly as the old in-modal banner did. Source toasts are
     * also exempt from DbmnToast's 2s dedup, so a repeated message still shows.
     */
    const CSV_TOAST_SOURCE = 'csv-data-transformer';

    /**
     * Show a unified notification via the shared DbmnToast (#268).
     *
     * Previously rendered into a `#csvNotificationArea` banner that only existed
     * in the Run Batch webview — so every one of these silently vanished in the
     * endpoint editor, which hosts the same data-transformer.
     *
     * @param {string} type - 'error' | 'warning' | 'info'
     * @param {string} message - The message to display (plain text)
     * @param {object} options - { blocking: false, persistent: false, link: {text, onClick} }
     *   - blocking: If true, user must fix the issue before proceeding
     *   - persistent: If true, notification won't auto-hide
     *   - link: Optional trailing anchor, e.g. a "Read more" documentation link
     */
    function showModalNotification(type, message, options = {}) {
        // GitHub Issue #247: a warning from Step 3's own checks stops skipping and shows Step 3.
        // (Not every warning: Map & Transform raises "N unmapped" for a moment while it
        // auto-maps one variable at a time; the Step 2 decision is made once it has finished.)
        if (type !== 'info' && window.DTAutoAdvance) window.DTAutoAdvance.onWarning();
        if (!window.DbmnToast) {
            console.warn('[CSV Handler] DbmnToast not loaded');
            return;
        }

        // Same rule the banner used: blocking never auto-hides, explicit
        // persistent never auto-hides, and errors stay unless told otherwise.
        const persistent = options.blocking === true ||
            options.persistent === true ||
            (options.persistent !== false && type === 'error');

        window.DbmnToast.show(type, message, {
            source: CSV_TOAST_SOURCE,
            persistent,
            // No durationMs: the shared per-level clock applies. The old 5s was
            // inherited from the banner this replaced and read too fast.
            link: options.link
        });

        // Store in state - blocking notifications prevent step advancement
        csvState.activeNotification = {
            type,
            message,
            blocking: options.blocking || false
        };

        // Drop the state alongside the toast, so callers that inspect
        // activeNotification (e.g. the column-mismatch check) don't read a
        // message the user can no longer see.
        if (!persistent) {
            setTimeout(() => {
                if (csvState.activeNotification?.message === message) {
                    csvState.activeNotification = null;
                }
            }, 5000);
        }
    }

    /**
     * Clear the modal notification
     */
    function clearModalNotification() {
        if (window.DbmnToast) {
            window.DbmnToast.clear(CSV_TOAST_SOURCE);
        }
        csvState.activeNotification = null;
    }

    /**
     * Check if there's a blocking notification that prevents navigation
     */
    function hasBlockingNotification() {
        return csvState.activeNotification?.blocking === true;
    }

    /**
     * Shake the notification to emphasize it (used when user tries to proceed with blocking notification)
     */
    function shakeNotification() {
        const active = csvState.activeNotification;
        if (!active || !window.DbmnToast) {
            return;
        }
        // #268: DbmnToast applies the shake class at creation, so re-show the
        // same toast through its source slot to replay the animation. Only
        // blocking notifications shake, and those are always persistent.
        window.DbmnToast.show(active.type, active.message, {
            source: CSV_TOAST_SOURCE,
            persistent: true,
            shake: true
        });
    }

    // Verification
    function verifyCSVCompatibility() {
        const currentEndpointId = window.currentEndpointId || document.body.getAttribute('data-endpoint-id');
        if (!currentEndpointId || currentEndpointId === 'NEW') {
            showCSVVerificationError('Please save the endpoint before verifying CSV compatibility');
            return;
        }

        // Use the full raw CSV content, not just the preview rows
        if (!csvState.rawCSVContent) {
            showCSVVerificationError('No CSV data available for verification');
            return;
        }

        getVscode().postMessage({
            type: 'verifyCSVCompatibility',
            csvData: csvState.rawCSVContent, // Send full CSV string instead of preview rows
            endpointId: currentEndpointId
        });
    }

    // File Dialog Functions

    function openComputerFileDialog() {
        // Use native HTML file input for computer file browsing
        const fileInput = document.getElementById('csvModalFileInput');
        if (fileInput) {
            fileInput.click();
        }
    }

    function handleModalCSVUpload(event) {
        // Use the multi-format handler instead of the old CSV-only handler
        handleCSVUpload(event);
    }

    // Navigation
    /**
     * GitHub Issue #223: Reset navigation state and restore Next button text
     * Called on early returns / failures during goToNextStep()
     */
    /**
     * Next found something to fix on this step. Release Next (it re-checks when pressed
     * again) and say what — in a "Can't continue yet" modal when the user pressed Next, or
     * silently when the walk pressed it (the step bar and the step itself show why).
     */
    function stopOnStepIssues(intro, lines) {
        resetNavigationState();
        const walking = window.DTAutoAdvance && window.DTAutoAdvance.status && window.DTAutoAdvance.status().walking;
        if (walking) {
            window.DTAutoAdvance.cancel();
            return;
        }
        if (!window.DbmnModal || !window.DbmnModal.show) return;
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = intro;
        body.appendChild(p);
        const list = document.createElement('ul');
        list.className = 'cannot-continue-list';
        lines.forEach(line => {
            const li = document.createElement('li');
            li.textContent = line;
            list.appendChild(li);
        });
        body.appendChild(list);
        window.DbmnModal.show({
            title: 'Can\'t continue yet',
            body,
            actions: [{ id: 'fix', label: 'Fix them', variant: 'primary' }]
        });
    }

    /** Validate's rows to fix: the grid already shows them (refreshGridIssues). */
    function stopOnGridIssues(issues) {
        const rows = issues.rowCount === 1 ? '1 row needs' : `${issues.rowCount.toLocaleString()} rows need`;
        stopOnStepIssues(`${rows} fixing:`, issues.lines);
    }

    function resetNavigationState() {
        csvState.navigationInProgress = false;
        var btn = document.getElementById('csvNextBtn');
        if (btn && btn.dataset.loadingProgress !== 'true') {
            btn.disabled = false;
            if (csvState.modalStep === 1) {
                btn.textContent = 'Import Data';
            } else {
                btn.textContent = 'Next';
            }
        }
    }

    function goToNextStep() {

        // Prevent multiple simultaneous calls
        if (csvState.navigationInProgress) {
            return;
        }

        // Review (4) is the last step: Execute, not Next, goes on from there
        if (csvState.modalStep < 4) {
            csvState.navigationInProgress = true;

            // GitHub Issue #223: Immediate button feedback on press
            var nextBtn = document.getElementById('csvNextBtn');
            if (nextBtn) {
                nextBtn.disabled = true;
                nextBtn.textContent = 'Processing\u2026';
            }

            // Step 1 → Step 2: Process file/paste data
            if (csvState.modalStep === 1) {
                if (hasBlockingNotification()) {
                    shakeNotification();
                    resetNavigationState();
                    return;
                }

                const activeTab = csvState.activeTab || 'file';

                if (!hasCurrentTabData()) {
                    showModalNotification('warning', 'No data available. Upload a file or paste content.');
                    resetNavigationState();
                    return;
                }

                // Flash radio buttons if filter choice required but not made
                if (csvState.fileFormat === 'excel' && csvState.sheetDetails) {
                    const selectedIndex = csvState.selectedSheetIndex || 0;
                    const sheet = csvState.sheetDetails[selectedIndex];
                    if (sheet?.filter?.hasHiddenRows && !csvState.filterChoice) {
                        const container = document.getElementById('filterChoiceContainer');
                        if (container) {
                            container.classList.remove('filter-choice-flash');
                            void container.offsetWidth;
                            container.classList.add('filter-choice-flash');
                        }
                        shakeNotification();
                        resetNavigationState();
                        return;
                    }
                }

                // GitHub Issue #247: from here Dobermann presses Next while nothing needs the user
                if (window.DTAutoAdvance) window.DTAutoAdvance.begin();

                // Handle file source
                if (csvState.sourceType === 'file' && csvState.fileFormat && !csvState.conversionInProgress) {
                    startFileConversion();
                    return;
                }

                // Handle PASTE tab
                if (activeTab === 'paste') {
                    const pasteArea = document.getElementById('csvPasteArea');
                    if (pasteArea && pasteArea.value.trim()) {
                        const csvContent = pasteArea.value.trim();

                        const delimiter = detectDelimiter(csvContent);
                        let normalizedContent = csvContent;
                        if (delimiter !== ',') {
                            const parsed = parseDelimitedContent(csvContent, delimiter);
                            const csvLines = [parsed.headers.join(',')];
                            parsed.rows.forEach(row => {
                                const quotedFields = row.map(field => {
                                    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                                        return '"' + field.replace(/"/g, '""') + '"';
                                    }
                                    return field;
                                });
                                csvLines.push(quotedFields.join(','));
                            });
                            normalizedContent = csvLines.join('\n');
                        }

                        csvState.rawCSVContent = normalizedContent;
                        // GitHub Issue #240: detectedDelimiter must match the delimiter of
                        // rawCSVContent. The branch above normalizes any non-comma input to
                        // CSV, so the stored delimiter is always ',' from this point on.
                        csvState.detectedDelimiter = ',';
                        csvState.sourceType = 'paste';
                        csvState.fileDetailsShown = true;

                        getVscode().postMessage({
                            type: 'parseCSVForModal',
                            csvData: normalizedContent,
                            fileName: delimiter === '\t' ? 'pasted-data.tsv' : delimiter === '|' ? 'pasted-data.psv' : 'pasted-data.csv',
                            fileSize: normalizedContent.length
                        });
                    }
                }

                // Handle FILE tab with already-processed file data (non-Excel CSV)
                if (activeTab === 'file' && csvState.rawCSVContent && !csvState.fileFormat) {
                    csvState.sourceType = 'file';
                    csvState.fileDetailsShown = true;

                    getVscode().postMessage({
                        type: 'parseCSVForModal',
                        csvData: csvState.rawCSVContent,
                        fileName: window.currentCSVFileName || 'uploaded-data.csv',
                        fileSize: csvState.rawCSVContent.length
                    });
                }

                // Navigation handled by backend response handlers
                return;
            }

            // Step 2 → Step 3: Trigger full coercion validation, then populate grid
            if (csvState.modalStep === 2) {
                // Next is always enabled: it re-checks the mapping and says what is missing
                if (!areAllRequiredVariablesMapped()) {
                    const missing = getVariablesThatNeedMapping().filter(v => !v.mapped).map(v => v.name);
                    stopOnStepIssues('Map these variables to a column:',
                        missing.length > 0 ? missing : ['The template has no variables to map.']);
                    return;
                }
                saveRememberedMapping();   // GitHub Issue #307: the mapping is confirmed here
                // "Update Endpoint Template": decided here, applied once the batch has run —
                // the rest of this run keeps the names it started with.
                const updateBox = document.getElementById('updateTemplateCheckbox');
                csvState.pendingTemplateRenames = updateBox && updateBox.checked ? currentTemplateRenames() : null;
                startFullCoercionValidation();
                return;
            }

            // GitHub Issue #202/#223: Step 3 → Step 4: Validate grid, extract CSV, generate JSON preview
            // Uses batched pipeline with stacked progress bars + button gradient for large datasets
            if (csvState.modalStep === 3) {
                requestAnimationFrame(function () {
                    var DTGrid = window.DTDataEntryGrid;
                    var hasBatched = DTGrid && DTGrid.getGridDataAsCSVBatched;

                    // Auto-remove completely empty rows (fast, stays sync)
                    removeEmptyGridRows();

                    // Helper to finalize step 3→4 with grid CSV
                    function finalizeStep3To4(gridCSV) {
                        if (gridCSV) {
                            useGridAsSource(gridCSV);

                            showCSVStep(4);
                            setTimeout(function () { csvState.navigationInProgress = false; }, 300);
                        } else {
                            resetNavigationState();
                        }
                    }

                    // Progress, in the step bar

                    function hideFooterProgress() {
                        updateFileProgress(0, '');
                    }

                    // One check of every row (refreshGridIssues): required cells left empty and
                    // each column's rules. Anything to fix stops here.
                    var issues = DTGrid && DTGrid.refreshGridIssues ? DTGrid.refreshGridIssues() : { valid: true, rowCount: 0, lines: [] };
                    if (!issues.valid) {
                        stopOnGridIssues(issues);
                        return;
                    }

                    if (!hasBatched) {
                        finalizeStep3To4(getGridDataAsCSV());
                        return;
                    }

                    // Build the output in batches, with progress in the step bar for large grids
                    updateFileProgress(0, 'Building output...');
                    DTGrid.getGridDataAsCSVBatched(
                        function (processed, total) {
                            var pct = total > 0 ? Math.round((processed / total) * 100) : 100;
                            updateFileProgress(pct, 'Building output...');
                        },
                        function (gridCSV) {
                            updateFileProgress(100, 'Complete');
                            setTimeout(function () { hideFooterProgress(); }, 1000);
                            finalizeStep3To4(gridCSV);
                        }
                    );
                });
                return;
            }

            showCSVStep(csvState.modalStep + 1);

            setTimeout(() => {
                csvState.navigationInProgress = false;
            }, 300);
        } else {
            resetNavigationState();
        }
    }

    /**
     * Step 3 → 4: from here on the grid is the data. Its CSV replaces the source, its columns
     * (named after the variables) replace the headers, and every variable maps to its own column.
     *
     * Step 2's state is kept first: its headers index the parsed rows, and its variables carry
     * where each one is used. Back to Step 2 puts it back (restoreStep2State) — without that,
     * Step 2 read the original rows with the grid's column order (gtin showed the uom value)
     * and lost its Body / lines[] sections.
     */
    function useGridAsSource(gridCSV) {
        if (!csvState.step2State) {
            csvState.step2State = {
                rawCSVContent: csvState.rawCSVContent,
                sourceType: csvState.sourceType,
                templateVariables: csvState.templateVariables,
                currentHeaders: csvState.currentHeaders,
                selectedColumnTypes: csvState.selectedColumnTypes
            };
        }
        csvState.rawCSVContent = gridCSV;
        if (!csvState.originalSourceType) {
            csvState.originalSourceType = csvState.sourceType;
        }
        csvState.sourceType = 'grid';

        if (csvState.gridTemplateVariables) {
            csvState.selectedColumnTypes = {};
            csvState.gridTemplateVariables.forEach(function (v) {
                csvState.selectedColumnTypes[v.name] = v.dataType || 'string';
            });
            csvState.templateVariables = csvState.gridTemplateVariables.map(function (v) {
                return Object.assign({}, v, { mapped: true, mappedTo: v.name, column: v.name });
            });
            var lines = gridCSV.split('\n');
            csvState.currentHeaders = lines[0].split(',').map(function (h) { return h.trim().replace(/^"|"$/g, ''); });
        }
    }

    /** Back to Step 2: the source, headers and variables Step 2 had before Step 3 → 4. */
    function restoreStep2State() {
        const saved = csvState.step2State;
        if (!saved) return;
        csvState.rawCSVContent = saved.rawCSVContent;
        csvState.sourceType = saved.sourceType;
        csvState.templateVariables = saved.templateVariables;
        csvState.currentHeaders = saved.currentHeaders;
        csvState.selectedColumnTypes = saved.selectedColumnTypes;
        csvState.step2State = null;
    }

    function goToPreviousStep() {
        goBackTo(csvState.modalStep - 1);
    }

    /** The step bar: back to any step reached, or forward through each step's own checks. */
    function goToStep(targetStep) {
        if (targetStep < csvState.modalStep) {
            goBackTo(targetStep);
        } else if (targetStep > csvState.modalStep && window.DTAutoAdvance) {
            window.DTAutoAdvance.walkTo(targetStep);
        }
    }

    /**
     * Back to an earlier step: Back is one step, the step bar can jump several. Going back past
     * Step 3 puts Step 2's state back (restoreStep2State); going back to Step 1 resets the source.
     */
    function goBackTo(targetStep) {
        // Prevent multiple simultaneous calls
        if (csvState.navigationInProgress) {
            return;
        }
        // GitHub Issue #247: a chained Run Batch's input is the chained rows — no Step 1
        if (window.ChainPreload && window.ChainPreload.blocksBack(Math.min(csvState.modalStep, targetStep + 1))) {
            return;
        }

        if (targetStep >= 1 && targetStep < csvState.modalStep) {
            csvState.navigationInProgress = true;

            // GitHub Issue #202: Skip Step 2 when in Enter Data mode (no CSV to map)
            let previousStep = targetStep;
            if (previousStep === 2 && csvState.dataEntryMode) {
                previousStep = 1;
                csvState.dataEntryMode = false;
                csvState.sourceType = null;
            }

            if (previousStep <= 2 && csvState.modalStep >= 3) {
                restoreStep2State();
            }

            // Special handling when going back to step 1
            if (previousStep === 1) {
                if (hasBlockingNotification()) {
                    clearModalNotification();
                }

                if (csvState.sourceType === 'paste') {
                    csvState.rawCSVContent = null;
                }

                if (csvState.fileFormat && csvState.formatMetadata && window.currentCSVFileName) {
                    csvState.fileDetailsShown = true;
                    csvState.sourceType = 'file';
                } else {
                    csvState.fileDetailsShown = false;
                    csvState.fileFormat = null;
                    csvState.formatMetadata = null;
                    csvState.currentFile = null;

                    showUploadUI();

                    const fileInput = document.getElementById('csvModalFileInput');
                    if (fileInput) fileInput.value = '';

                    window.currentCSVFileName = null;
                    window.currentCSVFileSize = null;
                }
            }

            showCSVStep(previousStep);

            setTimeout(() => {
                csvState.navigationInProgress = false;
            }, 300);
        }
    }


    /**
     * GitHub Issue #202: Enter Data mode — skip file/paste, go directly to Step 3 with empty grid
     */
    function enterDataMode() {
        csvState.dataEntryMode = true;
        csvState.sourceType = 'grid';

        // Initialize grid if not already done
        if (!csvState.gridInitialized && csvState.endpointConfig) {
            initializeDataEntryGrid(csvState.endpointConfig);
        }

        // Skip directly to Step 3 (Review & Edit Data)
        showCSVStep(3);
    }

    function initializeArrayRepetitionFromEndpoint(endpoint) {

        // Store endpoint config for later use
        csvState.endpointConfig = endpoint;

        // Check for saved array repetition configuration
        const repeatableArrays = endpoint?.dataLoadingConfig?.repeatableArrays;
        if (repeatableArrays && repeatableArrays.length > 0) {
            const enabledArray = repeatableArrays.find(arr => arr.enabled);
            if (enabledArray) {

                // Store configuration in state
                csvState.selectedArrayPath = enabledArray.arrayPath;
                csvState.arrayRepetition = enabledArray.maxRepetitions || 1;

                // Initialize UI when we get to Step 4 (arrays will be detected by then)
                // Note: Don't initialize UI here since dropdown may not be populated yet
            }
        }

        // GitHub Issue #108: Initialize query param repetition detection
        initializeQueryParamRepetitionFromEndpoint(endpoint);

        // Also initialize error handling preferences
        initializeErrorHandlingFromEndpoint(endpoint);

        // GitHub Issue #129: Initialize grid with template variables
        initializeDataEntryGrid(endpoint);
    }

    // Initialize query param repetition detection (GitHub Issue #108)
    function initializeQueryParamRepetitionFromEndpoint(endpoint) {
        const queryParamConfig = detectRepeatableQueryParam(endpoint);

        if (queryParamConfig.detected) {
            // Store detection result in csvState
            csvState.queryParamRepetition = {
                detected: true,
                paramKey: queryParamConfig.paramKey,
                pattern: queryParamConfig.pattern,
                separator: queryParamConfig.separator,
                maxUrlLength: 2000, // Default
                maxPerRequest: null // Will be calculated or user-selected
            };

            // Extract template variables from pattern
            const variables = extractTemplateVariables(queryParamConfig.pattern);

            // Store variables for column mapping
            if (variables.length > 0) {
                csvState.queryParamVariables = variables;
            }
        } else {
            // No repeatable query params detected
            csvState.queryParamRepetition = null;
            csvState.queryParamVariables = null;
        }
    }

    function initializeErrorHandlingFromEndpoint(endpoint) {

        // Check for saved error handling configuration
        const errorHandling = endpoint?.dataLoadingConfig?.errorHandling;
        if (errorHandling) {

            // Store configuration for later UI initialization when Review is shown
            csvState.savedErrorHandling = errorHandling;
        } else {
            // Default to continue processing when no saved config
            csvState.savedErrorHandling = {
                mode: 'continue',
                tolerance: null
            };
        }
    }

    function initializeErrorHandlingUI() {

        if (!csvState.savedErrorHandling) {
            return;
        }

        const errorMode = csvState.savedErrorHandling.mode || 'continue';

        const select = document.getElementById('batchErrorModeSelect');
        if (select) select.value = errorMode === 'stopOnFirst' ? 'stopOnFirst' : 'continue';
    }

    // =========================================================================
    // GitHub Issue #129: Grid Data Entry Functions
    // =========================================================================

    /**
     * GitHub Issue #175: Parse modifiers from a modifier string
     * Lightweight JavaScript implementation for webview use
     *
     * @param {string} modifierString - The modifier portion (e.g., "3-50|upper|opt")
     * @param {string} dataType - The data type of the variable
     * @returns {Object} Parsed modifiers with constraints and flags
     */
    function parseModifiersForGrid(...args) {
        return window.DTDataEntryGrid.parseModifiersForGrid(...args);
    }

    /**
     * GitHub Issue #175: Parse template variable content to extract type, format, and modifiers
     * Handles syntax: {{VAR:type:format|modifier1|modifier2}}
     *
     * @param {string} content - Content inside {{ }} (e.g., "Name:string|3-50|upper")
     * @returns {Object} Parsed result with dataType, formatModifier, and modifierString
     */
    function parseTemplateVariableContent(...args) {
        return window.DTDataEntryGrid.parseTemplateVariableContent(...args);
    }

    /**
     * Extract template variables from endpoint configuration
     * Parses body, URL path, headers, and query params for {{VARIABLE}} patterns
     * Also handles inferred variables like {{}} where name comes from JSON key
     * Variables are returned in order of appearance in the template
     */
    function extractTemplateVariablesFromEndpoint(...args) {
        return window.DTDataEntryGrid.extractTemplateVariablesFromEndpoint(...args);
    }

    /**
     * Analyze JSON template to determine nesting levels for variables
     * Returns: { l1Fields: [colIndex], l2Fields: [colIndex], l3Fields: [colIndex], l4Fields: [colIndex] }
     * where colIndex refers to the column index in the grid (0-based, excluding row number column)
     * GitHub Issue #146: Added L4 support for 4-level nested templates
     */
    function analyzeGridNestingLevels(...args) {
        return window.DTDataEntryGrid.analyzeGridNestingLevels(...args);
    }

    /**
     * Initialize the data entry grid with columns from template variables
     * GitHub Issue #129: Vanilla JS grid implementation (replaces jspreadsheet)
     */
    function initializeDataEntryGrid(...args) {
        return window.DTDataEntryGrid.initializeDataEntryGrid(...args);
    }

    /**
     * Add a new row to the vanilla grid
     */
    function addGridRow(...args) {
        return window.DTDataEntryGrid.addGridRow(...args);
    }

    /**
     * GitHub Issue #162: Format value for HTML5 date input (expects YYYY-MM-DD)
     * Handles various input formats: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY, etc.
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForDateInput(...args) {
        return window.DTDataEntryGrid.formatValueForDateInput(...args);
    }

    /**
     * GitHub Issue #162: Format value for HTML5 datetime-local input (expects YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss)
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForDatetimeInput(...args) {
        return window.DTDataEntryGrid.formatValueForDatetimeInput(...args);
    }

    /**
     * GitHub Issue #162: Format value for HTML5 time input (expects HH:mm or HH:mm:ss)
     * Returns null if value cannot be parsed (distinguishes from empty input)
     */
    function formatValueForTimeInput(...args) {
        return window.DTDataEntryGrid.formatValueForTimeInput(...args);
    }

    /**
     * Get data from the grid as CSV-compatible format
     */
    function getGridDataAsCSV(...args) {
        return window.DTDataEntryGrid.getGridDataAsCSV(...args);
    }

    /**
     * Check if grid has any data entered
     */
    function hasGridData(...args) {
        return window.DTDataEntryGrid.hasGridData(...args);
    }

    /**
     * Remove completely empty rows from grid
     * GitHub Issue #154: Empty rows should be auto-deleted, not cause validation errors
     */
    function removeEmptyGridRows(...args) {
        return window.DTDataEntryGrid.removeEmptyGridRows(...args);
    }

    /**
     * Validate grid for blank cells
     * Returns validation result with list of blank cells
     * GitHub Issue #175: Skip optional/nullable fields - they're allowed to be blank
     */
    function validateGridForBlankCells(...args) {
        return window.DTDataEntryGrid.validateGridForBlankCells(...args);
    }

    /**
     * Clear file selection and show grid again
     */
    function clearFileAndShowGrid(...args) {
        return window.DTDataEntryGrid.clearFileAndShowGrid(...args);
    }

    // =========================================================================
    // End of GitHub Issue #129: Grid Data Entry Functions
    // =========================================================================

    function onArraySelectionChange() {
        // GitHub Issue #308: only shown when the template has two or more arrays that could
        // repeat. Choosing one is a setting like Reps: the samples rebuild for it.
        const select = document.getElementById('arrayRepetitionSelect');
        if (!select) { return; }
        csvState.selectedArrayPath = select.value || null;
        if (select.value) {
            const elementsInput = document.getElementById('elementsInput');
            const savedValue = getSavedArrayRepetitionValue();
            if (elementsInput && !csvState.arrayRepetition) { elementsInput.value = String(savedValue); }
            csvState.arrayRepetition = csvState.arrayRepetition || savedValue;
        }
        schedulePreviewRebuild(true);       // a select: one deliberate action
    }

    function onElementsInputChange(elementsValue) {
        const elementsNum = parseInt(elementsValue) || 1;

        // Ensure value is within bounds
        const clampedValue = Math.max(1, Math.min(1000, elementsNum));
        if (clampedValue !== elementsNum) {
            const elementsInput = document.getElementById('elementsInput');
            if (elementsInput) elementsInput.value = clampedValue;
        }

        const totalCallsDisplay = document.getElementById('totalApiCallsDisplay');
        if (!totalCallsDisplay) {
            console.warn('⚠️ Total API calls display element not found');
            return;
        }

        // GitHub Issue #119/#150: Different calculation for nested mode vs flat array mode
        // Use totalTransactions from backend (single source of truth) if available
        if (csvState.nestedMode && csvState.nestedMode.enabled) {
            // GitHub Issue #150: Use pre-calculated totalTransactions from backend
            const apiCalls = csvState.nestedMode.totalTransactions || csvState.nestedMode.estimatedApiCalls || csvState.nestedMode.totalGroups;
            totalCallsDisplay.textContent = apiCalls;
            console.log(`📊 [Nested Mode] Total API calls: ${apiCalls} (nestingLevel=${csvState.nestedMode.nestingLevel}, totalGroups=${csvState.nestedMode.totalGroups})`);
        } else {
            // Flat array mode: Calculate total API calls based on rows / reps
            let totalRows = 0;
            if (csvState.rawCSVContent) {
                const lines = csvState.rawCSVContent.split('\n');
                totalRows = lines.slice(1).filter(line => line.trim().length > 0).length;
            } else if (window.currentParsedCsvData) {
                totalRows = window.currentParsedCsvData.length;
            }

            const totalApiCalls = totalRows > 0 ? Math.ceil(totalRows / clampedValue) : 0;
            totalCallsDisplay.textContent = totalApiCalls;
            console.log(`📊 [Flat Mode] Total API calls: ${totalApiCalls} (${totalRows} rows / ${clampedValue} reps)`);
            console.log('[DEBUG #224-api] onElementsInputChange: rawCSVContent=' + (csvState.rawCSVContent ? csvState.rawCSVContent.length + ' chars' : 'null') + ', totalRows=' + totalRows + ', reps=' + clampedValue + ', result=' + totalApiCalls);
        }

        // Store current configuration
        csvState.arrayRepetition = clampedValue;
        updateRepeatedArrayStat();
        schedulePreviewRebuild(false);      // typed: wait for typing to stop
    }

    /**
     * GitHub Issue #354: name the array rows are packed into, on a flat template with one
     * array — with two or more, the Array picker names it. Shown at any Rows per request: it
     * used to appear only above 1, and popping in as the number changed was jarring.
     */
    function updateRepeatedArrayStat() {
        const plan = csvState.batchPlan;
        const shown = !!(plan && plan.shape === 'flat' && plan.arrayPath && plan.arrayCandidates.length === 1);
        const display = document.getElementById('repeatedArrayDisplay');
        if (display && shown) { display.textContent = plan.arrayPath === '$root' ? '[ ] top level' : plan.arrayPath; }
        setStatVisible('repeatedArrayGroup', shown);
    }

    // =========================================================================
    // GitHub Issue #308: Step 4 — Configure, Requests and the first requests,
    // all from the batch plan (data-loading/batch-plan.ts)
    // =========================================================================

    /** The settings the preview on screen was built with — Refresh lights up when they change. */
    function currentPreviewSettings() {
        const q = csvState.queryParamRepetition;
        return JSON.stringify({
            array: csvState.selectedArrayPath || null,
            reps: csvState.arrayRepetition || null,
            perUrl: q ? (q.maxPerRequest ?? null) : null
        });
    }

    /** A setting changed: rebuild the samples so the screen never shows a stale batch. A select
     *  rebuilds at once; a number being typed waits until typing stops (REBUILD_DEBOUNCE_MS).
     *  Nothing happens when the settings are back to what the samples were built with. */
    const REBUILD_DEBOUNCE_MS = 400;
    let rebuildTimer = null;
    function schedulePreviewRebuild(immediate) {
        if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
        if (csvState.previewBuiltWith === undefined || csvState.previewBuiltWith === currentPreviewSettings()) { return; }
        if (immediate) { rebuildStep4Preview(); return; }
        rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuildStep4Preview(); }, REBUILD_DEBOUNCE_MS);
    }

    /** What the samples are being rebuilt for, in the words of the Configure card. */
    function rebuildDescription() {
        const plan = csvState.batchPlan;
        if (plan && plan.shape === 'query-repeat') {
            const per = csvState.queryParamRepetition && csvState.queryParamRepetition.maxPerRequest;
            return per ? `${per} values per URL` : 'as many values per URL as fit';
        }
        const label = ((plan && plan.reps && plan.reps.label) || 'rows per request').toLowerCase();
        return `${csvState.arrayRepetition || 1} ${label}`;
    }

    /** Rebuild the samples with the settings on screen. The old cards stay, dimmed, under a
     *  strip saying what is being built, so the page does not jump while the plan comes back. */
    function rebuildStep4Preview() {
        const list = document.getElementById('requestPreviewList');
        if (list) {
            list.classList.add('is-rebuilding');
            let strip = list.querySelector('.request-preview-rebuilding');
            if (!strip) {
                strip = document.createElement('div');
                strip.className = 'request-preview-rebuilding';
                strip.setAttribute('role', 'status');
                list.prepend(strip);
            }
            strip.textContent = `Rebuilding for ${rebuildDescription()}…`;
        }
        if (csvState.selectedArrayPath && csvState.arrayRepetition) {
            generateJsonPreviewWithUIConfig();
        } else {
            generateJSONPreview();
        }
    }

    function setStatVisible(id, visible) {
        const el = document.getElementById(id);
        if (el) { el.classList.toggle('hidden', !visible); }
    }

    /** Endpoint headers as the request will carry them (enabled ones), for the Details view. */
    function endpointHeadersForPreview() {
        const headers = csvState.endpointConfig?.headers || {};
        const out = {};
        Object.entries(headers).forEach(([k, v]) => {
            if (typeof v === 'string') { out[k] = v; } else if (v && v.enabled !== false) { out[k] = v.value; }
        });
        return out;
    }

    function renderStep4(plan) {
        if (!plan) { return; }
        csvState.batchPlan = plan;
        csvState.showUnencoded = false;

        // Requests
        const set = (id, text) => { const el = document.getElementById(id); if (el) { el.textContent = text; } };
        set('totalApiCallsDisplay', plan.totals.requests.toLocaleString());
        set('batchRowsDisplay', plan.totals.rows.toLocaleString());
        set('requestFileSizeDisplay', plan.requests[0] ? window.RequestPreview.formatSize(plan.requests[0].size) : '-');
        // Execute's counts follow the plan (pre-calculated totals)
        if (csvState.nestedMode && csvState.nestedMode.enabled) {
            csvState.nestedMode.totalTransactions = plan.totals.requests;
            csvState.nestedMode.estimatedApiCalls = plan.totals.requests;
        }

        // Configure: only what applies to this template
        setStatVisible('arraySelectGroup', plan.arrayCandidates.length > 1);
        setStatVisible('repsControlGroup', plan.reps.applies);
        const repsLabel = document.getElementById('repsLabel');
        if (repsLabel && plan.reps.label) { repsLabel.textContent = plan.reps.label.charAt(0).toUpperCase() + plan.reps.label.slice(1); }
        if (plan.reps.applies) {
            const input = document.getElementById('elementsInput');
            if (input) { input.value = String(plan.reps.value); }
            csvState.arrayRepetition = plan.reps.value;
        }
        // The repeated array: chosen by the plan for a flat template, by the template's own
        // structure for a nested one (the Reps setting Execute saves hangs off it).
        if (plan.arrayPath && (plan.shape === 'flat' ? plan.arrayPath !== csvState.selectedArrayPath : !csvState.selectedArrayPath)) {
            csvState.selectedArrayPath = plan.arrayPath;
        }
        setStatVisible('queryItemsGroup', plan.shape === 'query-repeat');
        updateRepeatedArrayStat();
        // GitHub Issue #354: the columns that start a new request, with the ⓘ that explains how
        // rows become requests beside them; with no grouping the ⓘ stays on API calls.
        const groupColumns = plan.groups && plan.groups.columns.length > 0 ? plan.groups.columns : [];
        set('groupedByDisplay', groupColumns.join(', '));
        setStatVisible('groupedByGroup', groupColumns.length > 0);
        const explainBtn = document.getElementById('explainRequestsBtn');
        const explainHome = document.getElementById(groupColumns.length > 0 ? 'groupedByLabel' : 'apiCallsLabel');
        if (explainBtn && explainHome && explainBtn.parentElement !== explainHome) { explainHome.appendChild(explainBtn); }
        const encoded = plan.requests.some(r => r.unencodedBodyText);
        csvState.hasEncodingMarkers = encoded;
        setStatVisible('encodingToggleButtonContainer', encoded);
        const label = document.getElementById('encodingToggleLabel');
        if (label) { label.textContent = 'Show unencoded'; }
        const anything = plan.arrayCandidates.length > 1 || plan.reps.applies || plan.shape === 'query-repeat' || groupColumns.length > 0;
        setStatVisible('reviewConfigureSection', anything || encoded);

        // The samples now match these settings
        csvState.previewBuiltWith = currentPreviewSettings();
        if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }

        // The first requests, as Raw tab cards
        const title = document.getElementById('requestPreviewTitle');
        if (title) {
            title.textContent = plan.totals.requests > plan.requests.length ? 'Request samples' : 'Requests';
        }
        const list = document.getElementById('requestPreviewList');
        if (list) {
            disposeRequestEditors();
            list.classList.remove('is-rebuilding');
            const inputColumns = csvState.currentHeaders || csvState.transformedHeaders || [];
            list.innerHTML = window.RequestPreview.renderCards(plan, inputColumns);
            // Each card's INPUT rows, in the design system's table
            window.RequestPreview.fillInputTables(list, key => {
                const request = plan.requests[Number(key)];
                return request ? { columns: inputColumns, rows: request.inputRows || [] } : null;
            });
            if (!list.dataset.wired) {
                list.addEventListener('click', onRequestPreviewClick);
                list.dataset.wired = '1';
            }
            const first = list.querySelector('.raw-card.expanded');
            if (first) { fillRequestEditor(first); }
            // #466/#470: Review's requests as the Requests table (review-requests.js), in the cards' place
            if (window.ReviewRequests) window.ReviewRequests.drawn();
            applyPreviewShow();
        }
        const chips = document.getElementById('requestPreviewShow');
        if (chips && !chips.dataset.wired) {
            chips.addEventListener('click', (event) => {
                const chip = event.target.closest('.raw-show-chip');
                if (!chip) { return; }
                const part = chip.dataset.show;
                csvState.previewShow = { ...previewShow(), [part]: !previewShow()[part] };
                applyPreviewShow();
            });
            chips.dataset.wired = '1';
        }
    }

    /** Show Input / Request — the Raw tab's chips, applied to every preview card. */
    function previewShow() {
        return csvState.previewShow || { input: true, request: true };
    }

    function applyPreviewShow() {
        const show = previewShow();
        document.querySelectorAll('#requestPreviewShow .raw-show-chip').forEach(chip => {
            chip.setAttribute('aria-pressed', show[chip.dataset.show] ? 'true' : 'false');
        });
        document.querySelectorAll('#requestPreviewList .raw-csv-data-wrapper').forEach(el => el.classList.toggle('raw-section-hidden', !show.input));
        document.querySelectorAll('#requestPreviewList .raw-panes-wrapper').forEach(el => el.classList.toggle('raw-section-hidden', !show.request));
    }

    const requestEditors = new Map();
    function disposeRequestEditors() {
        // The cards are about to be replaced; a full-window one takes the peek-bar footer with it (#352).
        if (document.querySelector('#requestPreviewList .raw-pane-fullscreen')) {
            document.body.classList.remove('is-editor-fullscreen');
        }
        requestEditors.forEach(editor => { try { editor.dispose(); } catch { /* already gone */ } });
        requestEditors.clear();
    }

    /** Create (or update) the card's read-only editor for its current mode. */
    function fillRequestEditor(card) {
        const plan = csvState.batchPlan;
        const index = Number(card.dataset.requestIndex);
        const request = plan && plan.requests[index];
        const container = card.querySelector('.raw-monaco-container');
        if (!request || !container) { return; }
        const mode = container.dataset.requestMode || 'body';
        const content = window.RequestPreview.contentFor(request, mode, endpointHeadersForPreview(), csvState.showUnencoded);
        const existing = requestEditors.get(index);
        if (existing) {
            existing.setValue(content.text);
            if (typeof monaco !== 'undefined') { monaco.editor.setModelLanguage(existing.getModel(), content.language); }
            return;
        }
        if (typeof monaco === 'undefined' || !monaco.editor) {
            const pre = document.createElement('pre');
            pre.textContent = content.text;
            container.textContent = '';
            container.appendChild(pre);
            return;
        }
        if (typeof window.defineVSCodeTheme === 'function') { window.defineVSCodeTheme(); }
        const editor = monaco.editor.create(container, {
            value: content.text, language: content.language, theme: 'vscode-current',
            stickyScroll: window.DBMN_STICKY_SCROLL, readOnly: true, minimap: { enabled: false },
            scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true, contextmenu: false,
            lineNumbers: 'off', renderLineHighlight: 'none', folding: true,
            scrollbar: { vertical: 'auto', horizontal: 'auto', useShadows: false, alwaysConsumeMouseWheel: false }
        });
        // Fit the content, between the Raw tab's limits
        const fit = () => {
            const height = Math.min(400, Math.max(100, editor.getContentHeight()));
            container.style.height = height + 'px';
            editor.layout();
        };
        editor.onDidContentSizeChange(fit);
        fit();
        requestEditors.set(index, editor);
    }

    function onRequestPreviewClick(event) {
        const target = event.target.closest('[data-action]');
        const card = event.target.closest('.raw-card');
        if (!target || !card) { return; }
        const action = target.dataset.action;
        if (action === 'toggle') {
            const expand = card.classList.contains('collapsed');
            card.classList.toggle('collapsed', !expand);
            card.classList.toggle('expanded', expand);
            const arrow = card.querySelector('.raw-card-toggle');
            if (arrow) { arrow.textContent = expand ? '▼' : '▶'; }
            if (expand) { fillRequestEditor(card); }
        } else if (action === 'mode') {
            const container = card.querySelector('.raw-monaco-container');
            if (container) { container.dataset.requestMode = target.dataset.mode; }
            card.querySelectorAll('.raw-view-mode-btn').forEach(b => b.classList.toggle('active', b === target));
            fillRequestEditor(card);
        } else if (action === 'fullscreen') {
            const pane = target.closest('.raw-pane');
            if (pane) { toggleRequestPaneFullscreen(pane); }
        } else if (action === 'copy') {
            const plan = csvState.batchPlan;
            const request = plan && plan.requests[Number(card.dataset.requestIndex)];
            const container = card.querySelector('.raw-monaco-container');
            if (!request || !container) { return; }
            const content = window.RequestPreview.contentFor(request, container.dataset.requestMode, endpointHeadersForPreview(), csvState.showUnencoded);
            // One clipboard implementation with one fallback (dbmn-clipboard.js), never the raw API
            if (window.DbmnClipboard) {
                window.DbmnClipboard.writeText(content.text);
            }
        }
    }

    /**
     * GitHub Issue #352: a request on Review goes full window, as on the Console's
     * Raw tab (raw-tab-handler.js togglePaneFullscreen): same button, same
     * transaction-card.css styles, Esc to leave.
     */
    function toggleRequestPaneFullscreen(pane, force) {
        const on = typeof force === 'boolean' ? force : !pane.classList.contains('raw-pane-fullscreen');
        pane.classList.toggle('raw-pane-fullscreen', on);
        // Footer becomes a hover/focus "peek bar" while full-window (core.css).
        document.body.classList.toggle('is-editor-fullscreen', on);
        const btn = pane.querySelector('.raw-pane-fullscreen-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.setAttribute('title', on ? 'Exit full window (Esc)' : 'Toggle full window (Esc to exit)');
        }
        const card = pane.closest('.raw-card');
        const editor = card && requestEditors.get(Number(card.dataset.requestIndex));
        if (editor) { requestAnimationFrame(() => editor.layout()); }
    }

    // Capture phase, so Esc leaves full window before anything else acts on it.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') { return; }
        const pane = document.querySelector('#requestPreviewList .raw-pane.raw-pane-fullscreen');
        if (!pane || pane.querySelector('.find-widget.visible')) { return; }
        event.stopPropagation();
        toggleRequestPaneFullscreen(pane, false);
    }, true);

    /** GitHub Issue #127: show the bodies as sent (BASE64 fields encoded) or unencoded. */
    function toggleEncodingPreview() {
        if (!csvState.batchPlan) { return; }
        csvState.showUnencoded = !csvState.showUnencoded;
        const label = document.getElementById('encodingToggleLabel');
        if (label) { label.textContent = csvState.showUnencoded ? 'Show as sent' : 'Show unencoded'; }
        document.querySelectorAll('#requestPreviewList .raw-card.expanded').forEach(fillRequestEditor);
    }

    /** ⓘ on API calls: "How your rows become API requests" (shared/batch-explainer.js). */
    function explainRequests() {
        const plan = csvState.batchPlan;
        if (!plan || !window.DbmnModal || !window.BatchExplainer) { return; }
        const body = document.createElement('div');
        const sortedBy = csvState.sortingDecision === 'sorted' ? (csvState.sortedByColumns || []) : [];
        body.innerHTML = window.BatchExplainer.render(plan, { sortedBy });   // every value escaped by the renderer
        window.DbmnModal.show({
            title: 'How your rows become API requests',
            body,
            size: 'lg',
            // The standard DbmnModal footer (and its spacing) — every DBMN modal ends with one
            actions: [{ id: 'close', label: 'Close', variant: 'primary' }],
            help: { doc: 'batch-preparation', section: 'nested-grouping' }
        });
    }

    function getSavedArrayRepetitionValue() {
        // Get saved value from endpoint config
        const repeatableArrays = csvState.endpointConfig?.dataLoadingConfig?.repeatableArrays;
        if (repeatableArrays && repeatableArrays.length > 0) {
            const enabledArray = repeatableArrays.find(arr => arr.enabled && arr.arrayPath === csvState.selectedArrayPath);
            return enabledArray ? enabledArray.maxRepetitions : 1;
        }
        return 1; // Default value
    }

    function generateJsonPreviewWithUIConfig() {

        if (!csvState.selectedArrayPath || !csvState.arrayRepetition) {
            console.warn('⚠️ [Generate Preview] Missing array config');
            return;
        }

        // Create UI array config from current slider value
        const uiArrayConfig = {
            arrayPath: csvState.selectedArrayPath,
            maxRepetitions: csvState.arrayRepetition
        };

        // GitHub Issue #135: Send parsed data instead of CSV string
        const parsedData = getParsedDataForBackend();
        if (!parsedData || !parsedData.headers || parsedData.rows.length === 0) {
            console.error('❌ [Generate Preview] No parsed CSV data available');
            return;
        }

        const mappings = getCurrentMappings();

        // Request backend to generate JSON with UI config (not saved config)
        getVscode().postMessage({
            type: 'generateBulkJson',
            endpointId: csvState.endpointId,
            parsedData: parsedData,  // Send parsed data instead of CSV string
            countData: window.DTDataPreview.getCountDataForBackend(),  // every row, when parsedData is a sample
            queryParamRepetition: window.DTDataPreview.getQueryRepetitionForBackend(),
            mappings: mappings,
            mode: 'preview',
            uiArrayConfig: uiArrayConfig,  // Pass UI config to backend
            // GitHub Issue #162: Include source timezone for preview timezone conversion
            sourceTimezone: csvState.sourceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        });
    }

    function getCurrentMappings() {
        // Read actual mappings from csvState.templateVariables
        if (!csvState.templateVariables || csvState.templateVariables.length === 0) {
            return [];
        }

        // Transform template variables into backend mapping format
        // GitHub Issue #135: Include sourceFormat for type coercion during JSON generation
        const mappings = csvState.templateVariables.map(variable => ({
            variable: variable.name,
            column: variable.column || variable.mappedTo || null,
            dataType: variable.dataType || 'string',
            sourceFormat: csvState.sourceTypes?.[variable.name] || getDefaultSourceFormat(variable.dataType || 'string')
        }));

        return mappings;
    }


    function populateArrayDropdown(detectedArrays) {
        const select = document.getElementById('arrayRepetitionSelect');
        const configContainer = document.querySelector('.array-repetition-config-compact');

        if (!select) return;

        // Always show config bar (for Total API Calls / Request Size)
        if (configContainer) configContainer.style.display = 'block';
        const totalCallsContainer = document.getElementById('totalCallsContainer');
        if (totalCallsContainer) totalCallsContainer.style.display = 'flex';

        // GitHub Issue #279: Only offer arrays that are actually data-driven.
        // The backend flags each array with hasItemVariables; arrays whose element
        // template has no {{variables}} (e.g. AsnRequestedService) can't be grouped
        // or repeated from CSV rows, so they must not appear as grouping candidates.
        // Only filter when the flag is explicitly false (defensive for older payloads).
        detectedArrays = (detectedArrays || []).filter(arr => arr.hasItemVariables !== false);
        // GitHub Issue #354: the picker offers what the batch plan can repeat, nothing else — an
        // array inside another array's item (ExportDocuments[].ConditionCodes) is not a choice.
        const plan = csvState.batchPlan;
        if (plan && Array.isArray(plan.arrayCandidates) && (plan.shape === 'flat' || plan.shape === 'single')) {
            detectedArrays = detectedArrays.filter(arr => plan.arrayCandidates.includes(arr.path));
        }

        // Hide array-specific controls if no arrays detected
        if (!detectedArrays || detectedArrays.length === 0) {
            if (select) select.parentElement.style.display = 'none';
            const elementsContainer = document.getElementById('elementsInputContainer');
            if (elementsContainer) elementsContainer.style.display = 'none';
            return;
        }

        // Show array controls and clear existing options. One array is nothing to choose
        // between: the Step 4 summary names it instead.
        if (select) select.parentElement.style.display = detectedArrays.length > 1 ? 'flex' : 'none';
        select.innerHTML = '';

        if (detectedArrays.length > 0) {
            // Sort arrays by depth (root level first)
            const sortedArrays = detectedArrays.sort((a, b) => {
                const depthA = (a.path.match(/\./g) || []).length;
                const depthB = (b.path.match(/\./g) || []).length;
                return depthA - depthB;
            });

            sortedArrays.forEach(arrayInfo => {
                const option = document.createElement('option');
                option.value = arrayInfo.path;

                // Format display text
                // GitHub Issue #220: Show friendly label for top-level array
                let displayText;
                if (arrayInfo.path === '$root') {
                    displayText = '[ ] (top-level array)';
                } else {
                    const depth = (arrayInfo.path.match(/\./g) || []).length;
                    displayText = depth === 0
                        ? `${arrayInfo.path} (root level)`
                        : `${arrayInfo.path} (nested)`;
                }

                option.textContent = displayText;
                // GitHub Issue #279: Carry the backend's repsApplicable flag so
                // onArraySelectionChange can hide the Reps input for auto-grouping
                // arrays. Default true when the flag is absent (older payloads).
                option.dataset.repsApplicable = arrayInfo.repsApplicable === false ? 'false' : 'true';
                select.appendChild(option);
            });

            // Auto-select array based on saved config, else the plan's array, else the first
            let selectedArrayPath = plan && plan.arrayPath && sortedArrays.some(arr => arr.path === plan.arrayPath)
                ? plan.arrayPath : sortedArrays[0].path;

            // Check if we have saved configuration
            if (csvState.selectedArrayPath) {
                const savedArrayExists = sortedArrays.find(arr => arr.path === csvState.selectedArrayPath);
                if (savedArrayExists) {
                    selectedArrayPath = csvState.selectedArrayPath;
                }
            }

            select.value = selectedArrayPath;
            csvState.selectedArrayPath = selectedArrayPath;
            onArraySelectionChange();

            // Initialize elements input with saved value if available
            if (csvState.arrayRepetition && csvState.arrayRepetition >= 1) {
                const elementsInput = document.getElementById('elementsInput');
                if (elementsInput) {
                    elementsInput.value = csvState.arrayRepetition.toString();
                    onElementsInputChange(csvState.arrayRepetition.toString());
                }
            } else {
                // If no saved value, make sure button visibility is updated for default value
                onElementsInputChange('1'); // Default to 1 element
            }
        }
    }

    function updateEndpointConfiguration() {

        if (!csvState.endpointConfig || !csvState.endpointId) {
            console.warn('⚠️ [Endpoint Config] Missing endpoint config or ID, cannot save');
            return;
        }

        // Build array configuration from current UI state
        const repeatableArrays = [];
        // Reps 1 on a flat array is one row per request either way, so it isn't saved. On a 2- or
        // 3-level template "no setting" means EVERY entry in one request — so there Reps is
        // always saved, and Execute sends what Step 4 showed (GitHub Issue #308).
        // GitHub Issue #354: only an array Step 4 offers is saved — never a hidden selection — so a
        // template with nothing to repeat clears any stale setting instead of re-saving it.
        const plan = csvState.batchPlan;
        const nestedPlan = plan && /^nested-/.test(plan.shape);
        const arrayPath = !plan || !plan.arrayPath ? null
            : plan.shape === 'flat' && plan.arrayCandidates.includes(csvState.selectedArrayPath) ? csvState.selectedArrayPath
                : plan.arrayPath;
        if (arrayPath && csvState.arrayRepetition && (csvState.arrayRepetition > 1 || nestedPlan)) {
            repeatableArrays.push({
                arrayPath: arrayPath,
                enabled: true,
                maxRepetitions: csvState.arrayRepetition
            });
        }

        // Collect error handling configuration from UI
        const errorMode = document.getElementById('batchErrorModeSelect')?.value || 'continue';

        const errorHandling = {
            mode: errorMode,
            tolerance: null,
            retryConfig: {
                maxAttempts: 1,
                delaySeconds: 5,
                retryConditions: {
                    networkErrors: true,
                    serverErrors: true,
                    rateLimiting: true,
                    clientErrors: false
                }
            }
        };

        // Update endpoint config with both array repetition AND error handling settings
        const updatedEndpoint = {
            ...csvState.endpointConfig,
            dataLoadingConfig: {
                ...csvState.endpointConfig.dataLoadingConfig,
                repeatableArrays: repeatableArrays,
                errorHandling: errorHandling,
                ...rememberedMappingUpdate()
            }
        };

        // Save endpoint configuration using existing infrastructure
        getVscode().postMessage({
            type: 'saveEndpoint',
            endpoint: updatedEndpoint
        });
    }

    /**
     * GitHub Issue #307: what this run adds to the endpoint's remembered mapping — always
     * saved, no opt-in. The mapping just used (variable → column), merged over what was
     * remembered, so a variable this file didn't map keeps its old column. Data-entry (grid)
     * data maps every variable to itself — and from Step 3 on every source is grid data — so
     * it adds nothing: the mapping worth keeping is the one confirmed at Step 2.
     */
    function rememberedMappingUpdate() {
        const saved = csvState.endpointConfig?.dataLoadingConfig || {};
        if (csvState.sourceType === 'grid') { return {}; }
        const used = {};
        (csvState.templateVariables || []).forEach(v => {
            if (v && v.name && v.mappedTo && !/^(A8|ENV):/i.test(v.name)) { used[v.name] = v.mappedTo; }
        });
        if (Object.keys(used).length === 0) { return {}; }
        return { columnMappings: { ...(saved.columnMappings || {}), ...used } };
    }

    /**
     * GitHub Issue #307: Next on Map & Transform saves the mapping — the user has confirmed it
     * there, whether or not they go on to Execute. Only the mapping changes: Step 4's settings
     * (array reps, error handling) are saved at Execute, once they exist. Skipped when
     * nothing would change.
     */
    function saveRememberedMapping() {
        if (!csvState.endpointConfig || !csvState.endpointId) { return; }
        const saved = csvState.endpointConfig.dataLoadingConfig || {};
        const update = rememberedMappingUpdate();
        if (!update.columnMappings || JSON.stringify(update.columnMappings) === JSON.stringify(saved.columnMappings || {})) { return; }
        getVscode().postMessage({
            type: 'saveEndpoint',
            endpoint: { ...csvState.endpointConfig, dataLoadingConfig: { ...saved, ...update } }
        });
    }

    /** GitHub Issue #307: renames the current mapping implies (variable → its column's name). */
    function currentTemplateRenames() {
        if (!window.TemplateRename || csvState.sourceType === 'grid') { return {}; }
        return window.TemplateRename.renamesForMappings(csvState.templateVariables || []);
    }

    /**
     * GitHub Issue #307: "Update Endpoint Template" appears once a variable is mapped to a
     * column with a different name — the only case where it would change anything — and
     * lists what it would rename. Unticked by default.
     */
    function refreshUpdateTemplateOption() {
        const option = document.getElementById('updateTemplateOption');
        if (!option) { return; }
        const renames = currentTemplateRenames();
        const names = Object.keys(renames);
        option.classList.toggle('hidden', names.length === 0);
        const list = document.getElementById('updateTemplateRenames');
        if (list) {
            list.textContent = '';
            names.forEach((from, i) => {
                if (i > 0) { list.appendChild(document.createTextNode(', ')); }
                const a = document.createElement('code'); a.textContent = from;
                const b = document.createElement('code'); b.textContent = renames[from];
                list.appendChild(a); list.appendChild(document.createTextNode(' → ')); list.appendChild(b);
            });
        }
        if (names.length === 0) {
            const box = document.getElementById('updateTemplateCheckbox');
            if (box) { box.checked = false; }
        }
    }

    /** GitHub Issue #307: the column this endpoint remembered for a variable, if this file has it. */
    function rememberedColumnFor(variableName) {
        const remembered = csvState.endpointConfig?.dataLoadingConfig?.columnMappings;
        const column = remembered && remembered[variableName];
        return column && (csvState.currentHeaders || []).includes(column) ? column : null;
    }

    function onErrorToleranceToggle() {
        // No longer used - tolerance UI has been simplified
    }

    function onToleranceModeChange() {
        // No longer used - tolerance UI has been simplified
    }


    // =========================================================================
    // GitHub Issue #163: Tab Management Functions
    // =========================================================================

    /**
     * Switch to a different tab in the Step 1 input interface
     * GitHub Issue #202: Updated for file | paste tabs
     * @param {string} tabName - 'file' | 'paste'
     */
    function switchTab(tabName) {
        // Update state
        csvState.activeTab = tabName;

        // Update tab items
        document.querySelectorAll('#data-input-tabs .tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Toggle panels using .hidden class
        document.querySelectorAll('.tab-content > .tab-panel').forEach(panel => {
            const panelTab = panel.id.replace('tabPanel', '').toLowerCase();
            panel.classList.toggle('hidden', panelTab !== tabName);
        });

        // Check if other tabs have data and show warning
        updateTabWarning();

        // Update NEXT button state based on current tab
        updateNextButtonState();
    }

    /**
     * Update the data indicator dots on tabs
     * GitHub Issue #202: File and paste tab indicators
     */
    function updateTabDataIndicators() {
        // File tab indicator
        const fileIndicator = document.getElementById('tabIndicatorFile');
        if (fileIndicator) {
            if (csvState.tabData.file.hasData) {
                fileIndicator.classList.add('has-data');
                fileIndicator.title = csvState.tabData.file.fileName || 'File loaded';
            } else {
                fileIndicator.classList.remove('has-data');
                fileIndicator.title = '';
            }
        }

        // Paste tab indicator
        const pasteIndicator = document.getElementById('tabIndicatorPaste');
        if (pasteIndicator) {
            if (csvState.tabData.paste.hasData) {
                pasteIndicator.classList.add('has-data');
                pasteIndicator.title = 'Data pasted';
            } else {
                pasteIndicator.classList.remove('has-data');
                pasteIndicator.title = '';
            }
        }
    }

    /**
     * Show warning in footer notification if other tabs have data
     * Uses standard notification system instead of custom banner
     * NOTE: Only shows tab-specific warnings, does NOT clear other notifications
     */
    function updateTabWarning() {
        const activeTab = csvState.activeTab;
        const otherTabsWithData = [];

        if (activeTab !== 'file' && csvState.tabData.file.hasData) {
            otherTabsWithData.push('Upload File');
        }
        if (activeTab !== 'paste' && csvState.tabData.paste.hasData) {
            otherTabsWithData.push('Paste Text');
        }

        if (otherTabsWithData.length > 0 && hasCurrentTabData()) {
            const message = `Note: Data in [${otherTabsWithData.join('], [')}] tab${otherTabsWithData.length > 1 ? 's' : ''} will not be imported.`;
            showModalNotification('warning', message, { blocking: false });
        }
    }

    /**
     * Check if the current active tab has data
     * GitHub Issue #202: File and paste tabs
     */
    function hasCurrentTabData() {
        const activeTab = csvState.activeTab;
        switch (activeTab) {
            case 'file':
                return csvState.tabData.file.hasData;
            case 'paste':
                return csvState.tabData.paste.hasData;
            default:
                return false;
        }
    }

    /**
     * Update NEXT button state based on current tab's data
     */
    function updateNextButtonState() {
        const nextBtn = document.getElementById('csvNextBtn') || document.querySelector('.csv-navigation .btn-primary');
        if (!nextBtn) return;

        const hasData = hasCurrentTabData();
        nextBtn.disabled = !hasData;

        if (!hasData) {
            nextBtn.title = 'No data in current tab';
        } else {
            nextBtn.title = '';
        }

        // GitHub Issue #204: Sync Enter Data button and Read label with data state
        if (csvState.modalStep === 1) {
            nextBtn.textContent = 'Import Data';
            const enterDataBtn = document.getElementById('csvEnterDataBtn');
            if (enterDataBtn) {
                enterDataBtn.disabled = hasData;
            }
        }
    }

    /**
     * Mark that grid has data (no-op: grid is now Step 3, not a tab)
     * Kept for API compatibility — navigation buttons update via updateCSVNavigationButtons()
     */
    function updateGridTabData(_rowCount) {
        // GitHub Issue #202: Grid moved from tab to Step 3. Navigation state
        // is now managed by isStepValid(3) → hasGridData() via updateCSVNavigationButtons().
    }

    /**
     * Mark that file tab has data
     * Called when file is loaded
     */
    function updateFileTabData(hasData, fileName = null) {
        csvState.tabData.file.hasData = hasData;
        csvState.tabData.file.fileName = fileName;
        updateTabDataIndicators();
        updateTabWarning();
        updateNextButtonState();
    }

    /**
     * Mark that paste tab has data
     * Called when paste area changes
     */
    function updatePasteTabData(hasData, content = '') {
        csvState.tabData.paste.hasData = hasData;
        csvState.tabData.paste.content = content;
        updateTabDataIndicators();
        updateTabWarning();
        updateNextButtonState();
    }

    // =========================================================================
    // End GitHub Issue #163: Tab Management Functions
    // =========================================================================

    // Save batch configuration to endpoint before execution
    function saveBatchConfigurationToEndpoint(endpointId) {

        // Set flag that we're waiting for endpoint save to complete
        csvState.waitingForSave = true;

        // Show saving state (GitHub Issue #106)
        const executeBtn = document.getElementById('csvExecuteBtn');
        if (executeBtn) {
            executeBtn.disabled = true;
            executeBtn.innerHTML = '<span class="btn-spinner"></span> Processing...';
        }

        // Save array configuration and error handling using existing infrastructure
        updateEndpointConfiguration();
    }

    // Public API
    window.CSVHandler = {
        // State (exposed for initialization in Run Batch webview - GitHub Issue #106)
        csvState,

        // File handling
        handleCSVUpload,
        handleModalCSVUpload,
        processCSVFile,
        handleCSVDrop,
        handleCSVDragOver,
        handleCSVDragLeave,
        openComputerFileDialog,

        // GitHub Issue #129: Grid data entry
        clearFileAndShowGrid,
        initializeDataEntryGrid,
        getGridDataAsCSV,
        hasGridData,

        // GitHub Issue #163: Tab management
        switchTab,
        updateTabDataIndicators,
        updateGridTabData,
        updateFileTabData,
        updatePasteTabData,

        // Sheet/Delimiter selection
        updateSelectedSheet,
        updateSelectedDelimiter,

        // Batch naming
        updateBatchName,

        // Array Repetition
        onArraySelectionChange,
        onElementsInputChange,
        populateArrayDropdown,
        generateJsonPreviewWithUIConfig,

        // Query Parameter Repetition (GitHub Issue #108)
        onItemsPerRequestChange,
        onCustomItemsChange,
        generateQueryStringPreview,
        copyQueryPreview,

        // GitHub Issue #204: Body/Details toggle + Input columns
        setPreviewViewMode: (mode) => window.DTDataPreview.setPreviewViewMode(mode),
        togglePreviewInput: (checked) => window.DTDataPreview.togglePreviewInput(checked),

        // Error Handling Configuration
        onErrorToleranceToggle,
        onToleranceModeChange,

        // Modal management (resetCSVModal and showCSVStep still used by Run Batch webview)
        resetCSVModal,
        showCSVStep,

        // Navigation
        goToNextStep,
        goToPreviousStep,
        goToStep,
        useGridAsSource,
        enterDataMode,

        // Verification
        verifyCSVCompatibility,
        triggerCSVCompatibilityVerification,

        // State checks
        hasCSVDataSelected,
        areAllRequiredVariablesMapped,
        getVariablesThatNeedMapping,

        // Error handling
        showCSVError,
        showCSVVerificationError,

        // GitHub Issue #135: Unified notification system
        showModalNotification,
        clearModalNotification,
        hasBlockingNotification,

        // Column mapping
        populateColumnMappingTable,
        updateVariableMapping,
        findBestColumnMatch,

        // GitHub Issue #135: Coercion validation
        cancelCoercionValidation,

        // State access
        getState: () => csvState,
        setState: (updates) => Object.assign(csvState, updates),
        // The save Execute makes before running (array reps, error handling, #307 mapping)
        updateEndpointConfiguration,
        refreshUpdateTemplateOption,
        saveRememberedMapping,

        // Utility functions
        validateMapping: () => areAllRequiredVariablesMapped(),
        startDataLoading: () => {

            // Get the current endpoint ID
            const currentEndpointId = window.currentEndpointId || document.body.getAttribute('data-endpoint-id');

            if (!currentEndpointId || currentEndpointId === 'NEW') {
                showCSVError('Please save the endpoint before executing');
                return;
            }

            // First, save batch configuration to endpoint
            saveBatchConfigurationToEndpoint(currentEndpointId);
        },

        // Save batch configuration and then execute
        executeBatchWithConfiguration: (currentEndpointId) => {

            // GitHub Issue #106: For execution, we need to transform the FULL dataset
            // The cached transformedRows only contains sampled data (50 rows) for preview
            // So we need to request full transformation before execution

            // Check if we have column types that require transformation
            const hasColumnTypes = csvState.selectedColumnTypes && Object.keys(csvState.selectedColumnTypes).length > 0;

            if (hasColumnTypes) {
                // Request FULL data transformation for execution

                // GitHub Issue #162: Defensive recovery before transformation
                let csvDataForTransform = csvState.rawCSVContent;
                if (!csvDataForTransform) {
                    console.warn('[CSV Handler] rawCSVContent missing before transformation, attempting recovery...');
                    const pasteArea = document.getElementById('csvPasteArea');
                    if (pasteArea && pasteArea.value.trim()) {
                        csvDataForTransform = pasteArea.value.trim();
                        csvState.rawCSVContent = csvDataForTransform;
                        console.log('[CSV Handler] Recovered data from paste area for transformation');
                    } else if (hasGridData && hasGridData()) {
                        csvDataForTransform = getGridDataAsCSV();
                        if (csvDataForTransform) {
                            csvState.rawCSVContent = csvDataForTransform;
                            console.log('[CSV Handler] Recovered data from grid for transformation');
                        }
                    }
                }

                if (!csvDataForTransform) {
                    showCSVError('No CSV data available for execution');
                    return;
                }

                // Show loading state on execute button (GitHub Issue #106)
                const executeBtn = document.getElementById('csvExecuteBtn');
                if (executeBtn) {
                    executeBtn.disabled = true;
                    executeBtn.innerHTML = '<span class="btn-spinner"></span> Processing...';
                }

                // Set flag to execute after transformation completes
                csvState.executeAfterTransform = true;
                csvState.executionEndpointId = currentEndpointId;

                // GitHub Issue #218: Only send non-string columns for transformation
                // STRING is default — no transformation needed for string columns
                const nonStringTypes = window.DTTypeCoercion.filterNonStringTypes(csvState.selectedColumnTypes);

                // If all columns are string, skip transformation entirely
                if (Object.keys(nonStringTypes).length === 0) {
                    // No transformation needed — proceed with raw data
                    csvState.executeAfterTransform = false;
                    csvState.executionEndpointId = null;

                    // Reset execute button
                    const execBtn = document.getElementById('csvExecuteBtn');
                    if (execBtn) {
                        execBtn.disabled = false;
                        execBtn.innerHTML = 'Execute';
                    }

                    // Fall through to raw data execution below
                } else {
                    // Request transformation of FULL dataset (not sampled)
                    getVscode().postMessage({
                        type: 'applyTypeTransformations',
                        csvData: csvDataForTransform, // FULL data for execution
                        columnTypes: nonStringTypes,
                        isExecutionMode: true // GitHub Issue #106: Flag to indicate this is for execution, not preview
                    });

                    return; // Wait for transformation to complete, then continue
                }
            }

            // No transformation needed, proceed with raw data
            let csvDataForExecution = csvState.rawCSVContent;

            // GitHub Issue #162: Defensive recovery - if rawCSVContent is missing, try to recover
            if (!csvDataForExecution) {
                console.warn('[CSV Handler] rawCSVContent missing at execution, attempting recovery...');

                // Try paste area first
                const pasteArea = document.getElementById('csvPasteArea');
                if (pasteArea && pasteArea.value.trim()) {
                    csvDataForExecution = pasteArea.value.trim();
                    csvState.rawCSVContent = csvDataForExecution;
                    console.log('[CSV Handler] Recovered data from paste area');
                }
                // Try grid data
                else if (hasGridData && hasGridData()) {
                    csvDataForExecution = getGridDataAsCSV();
                    if (csvDataForExecution) {
                        csvState.rawCSVContent = csvDataForExecution;
                        console.log('[CSV Handler] Recovered data from grid');
                    }
                }
            }

            // Validate we have CSV data
            if (!csvDataForExecution) {
                showCSVError('No CSV data available for execution');
                return;
            }

            // Prepare the column mappings for backend
            const mappings = csvState.templateVariables ? csvState.templateVariables.map(variable => ({
                variable: variable.name,
                column: variable.mappedTo || null,
                dataType: variable.dataType || 'string'
            })) : [];


            // GitHub Issue #135: Parse CSV properly (honors quoted values) and apply source format conversion
            const lines = csvDataForExecution.split('\n');
            const headers = parseCSVLine(lines[0]);

            // Build header -> source format map for conversion
            const headerFormatMap = {};
            if (csvState.templateVariables && csvState.sourceTypes) {
                csvState.templateVariables.forEach(variable => {
                    if (variable.mappedTo && csvState.sourceTypes[variable.name]) {
                        headerFormatMap[variable.mappedTo] = csvState.sourceTypes[variable.name];
                    }
                });
            }

            const jsonData = lines.slice(1)
                .filter(line => line.trim().length > 0)
                .map(line => {
                    const values = parseCSVLine(line);
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
                const defaultName = generateDefaultBatchName();
                csvState.batchName = sanitizeBatchName(defaultName);
            }

            // Extract parallel processing configuration from current environment
            const parallelProcessingConfig = csvState.currentEnvironment?.parallelProcessing || {
                enabled: false,
                maxConcurrency: 1
            };

            // GitHub Issue #108: Include query param repetition config if detected
            // GitHub Issue #150: Include totalTransactions from preview (single source of truth)
            // GitHub Issue #162: Include source timezone for datetime conversion
            const executionMessage = {
                type: 'executeBulkLoadCommand',
                endpointId: currentEndpointId,
                jsonData: jsonData,
                mappings: mappings,
                batchName: csvState.batchName,
                sourceType: csvState.sourceType,
                sourceFileName: csvState.sourceFileName,
                sourceSheetName: csvState.sourceSheetName,
                parallelProcessing: getSelectedProcessingMode(),
                // GitHub Issue #150: Pass pre-calculated totalTransactions
                totalTransactions: csvState.nestedMode?.totalTransactions || null,
                nestingLevel: csvState.nestedMode?.nestingLevel || null,
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
                    paramKey: csvState.queryParamRepetition.paramKey, // GitHub Issue #108: Include paramKey for URL query param
                    pattern: csvState.queryParamRepetition.pattern,
                    separator: csvState.queryParamRepetition.separator,
                    maxUrlLength: csvState.queryParamRepetition.maxUrlLength || 2000,
                    maxPerRequest: csvState.queryParamRepetition.maxPerRequest // Can be null for auto-calculate
                };
            }

            // Call internal VS Code command for bulk execution (bypasses endpoint-manager execute logic),
            // through the one Execute confirmation (#470: run-batch-confirm.js) when the page has it
            if (window.RunBatchConfirm) window.RunBatchConfirm.send(executionMessage, m => getVscode().postMessage(m));
            else getVscode().postMessage(executionMessage);
        },
        copyJsonPreview: () => {
            // GitHub Issue #204: Copy details text if in details mode
            if (csvState.previewViewMode === 'details') {
                const detailsPre = document.querySelector('#jsonPreviewDetails pre');
                if (detailsPre) {
                    window.DbmnClipboard.writeText(detailsPre.textContent).then(ok => {
                        if (!ok && window.DbmnToast) window.DbmnToast.error('Failed to copy the preview');
                    });
                }
                return;
            }
            if (csvState.jsonPreviewEditor) {
                const jsonContent = csvState.jsonPreviewEditor.getValue();
                window.DbmnClipboard.writeText(jsonContent).then(ok => {
                    if (!ok && window.DbmnToast) window.DbmnToast.error('Failed to copy the JSON preview');
                });
            }
        },
        // GitHub Issue #127/#308: encoded vs unencoded bodies in the Step 4 request cards
        toggleEncodingPreview,
        // GitHub Issue #308: Step 4
        rebuildStep4Preview,
        explainRequests,
        schedulePreviewRebuild,
        renderStep4,

        handlePasteAreaChange: () => {
            // Handle paste area changes
            const pasteArea = document.getElementById('csvPasteArea');
            const hasContent = pasteArea?.value?.trim().length > 0;

            if (hasContent) {
                // Track source information for batch naming
                csvState.sourceType = 'paste';
                csvState.sourceFileName = null;
                csvState.sourceSheetName = null;

                // Clear file input since we're using paste instead
                const fileInput = document.getElementById('csvModalFileInput');
                if (fileInput) {
                    fileInput.value = '';
                }
                csvState.currentFile = null;

                // Process pasted CSV content
                const csvContent = pasteArea.value.trim();

                // GitHub Issue #172: Detect delimiter (tab vs comma)
                const delimiter = detectDelimiter(csvContent);

                // If tab-delimited, convert to CSV for consistent backend processing
                let normalizedContent = csvContent;
                if (delimiter === '\t') {
                    // Convert tabs to commas, handling quoted values properly
                    const parsed = parseDelimitedContent(csvContent, delimiter);
                    // Rebuild as CSV
                    const csvLines = [parsed.headers.join(',')];
                    parsed.rows.forEach(row => {
                        // Quote fields that contain commas
                        const quotedFields = row.map(field => {
                            if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                                return '"' + field.replace(/"/g, '""') + '"';
                            }
                            return field;
                        });
                        csvLines.push(quotedFields.join(','));
                    });
                    normalizedContent = csvLines.join('\n');
                    console.log('[handlePasteAreaChange] Detected tab-delimited data, converted to CSV format');
                }

                csvState.rawCSVContent = normalizedContent;
                // GitHub Issue #240: detectedDelimiter must match the delimiter of
                // rawCSVContent. Since we always normalize to CSV above, the stored
                // delimiter is always ',' regardless of what the user pasted.
                csvState.detectedDelimiter = ',';

                // Mark that we have data details ready (for paste, we don't need format detection)
                csvState.fileDetailsShown = true;

                // Note: parseCSVForModal is NOT sent here — it's sent by goToNextStep()
                // when the user clicks "Read Data". Sending it here caused auto-advance
                // to Step 2 before the user was ready.

                // GitHub Issue #163: Update paste tab data
                updatePasteTabData(true, normalizedContent);

                // Update Read Data button state
                updateReadButtonState();
            } else {
                // Paste area cleared - reset state
                csvState.fileDetailsShown = false;

                // GitHub Issue #163: Update paste tab data
                updatePasteTabData(false, '');

                updateReadButtonState();
            }
        },

        // Parsing and delimiter utilities (exposed for split modules)
        parseCSVLine,
        detectDelimiter,
        parseDelimitedContent,

        // Query parameter utilities (exposed for split modules)
        buildQueryStringPreview,
        calculateMaxItemsPerRequest,

        // Type coercion utilities (exposed for split modules)
        applyModifiersForDisplay,
        computeTargetSample,

        // Navigation and UI state (exposed for split modules)
        updateCSVNavigationButtons,
        updateReadButtonState,

        // Error handling UI (exposed for split modules)
        showEnhancedCSVError,
        initializeErrorHandlingUI,

        // Data ingestion utilities (exposed for split modules)
        checkNestedArraySorting,
        showProgressInDropzone,
        processMultiFormatFile,

        // Batch config utilities (exposed for split modules)
        onProcessingModeChange,

        // Message handling
        handleMessage: (message) => {
            // Handle CSV-related messages from the backend
            switch (message.type) {
                case 'formatDetected':
                    handleFormatDetected(message);
                    break;
                case 'formatConversionComplete':
                    handleFormatConversionComplete(message);
                    break;
                case 'formatConversionError':
                    handleFormatConversionError(message);
                    break;
                case 'excelSheetArraysResult':
                    if (window.DTTypeCoercion && window.DTTypeCoercion.handleExcelSheetArraysResult) {
                        window.DTTypeCoercion.handleExcelSheetArraysResult(message);
                    }
                    break;
                case 'excelSheetArraysError':
                    if (window.DTTypeCoercion && window.DTTypeCoercion.handleExcelSheetArraysError) {
                        window.DTTypeCoercion.handleExcelSheetArraysError(message);
                    }
                    break;
                case 'csvModalParsed':
                    handleCSVModalParsed(message);
                    break;
                case 'csvCompatibilityVerified':
                    handleCSVCompatibilityVerified(message);
                    break;
                case 'csvCompatibilityError':
                    handleCSVCompatibilityError(message);
                    break;
                // GitHub Issue #135: Coercion validation results
                case 'sampleCoercionResult':
                    handleSampleCoercionResult(message);
                    break;
                case 'fullCoercionResult':
                    handleFullCoercionResult(message);
                    break;
                // GitHub Issue #148: CSV Sorting for Nested Arrays
                case 'sortingAnalysisResult':
                    handleSortingAnalysisResult(message);
                    break;
                case 'sortingExplanation':
                    handleSortingExplanation(message);
                    break;
            }
        }
    };

    // Alias: window.DataTransformer points to the same API as window.CSVHandler
    window.DataTransformer = window.CSVHandler;

    // Message Handlers for Multi-Format Support
    function handleFormatDetected(...args) {
        return window.DTDataIngestion.handleFormatDetected(...args);
    }

    function showFileDetails(...args) {
        return window.DTDataIngestion.showFileDetails(...args);
    }

    function hideUploadUI(...args) {
        return window.DTDataIngestion.hideUploadUI(...args);
    }

    function showUploadUI(...args) {
        return window.DTDataIngestion.showUploadUI(...args);
    }

    function showConversionLoadingState(...args) {
        return window.DTDataIngestion.showConversionLoadingState(...args);
    }

    function hideConversionLoadingState(...args) {
        return window.DTDataIngestion.hideConversionLoadingState(...args);
    }

    function startFileConversion(...args) {
        return window.DTDataIngestion.startFileConversion(...args);
    }

    function handleFormatConversionComplete(...args) {
        return window.DTDataIngestion.handleFormatConversionComplete(...args);
    }

    function handleFormatConversionError(...args) {
        return window.DTDataIngestion.handleFormatConversionError(...args);
    }

    // Message Handlers
    function handleCSVModalParsed(...args) {
        return window.DTDataIngestion.handleCSVModalParsed(...args);
    }

    function handleCSVCompatibilityVerified(...args) {
        return window.DTDataIngestion.handleCSVCompatibilityVerified(...args);
    }

    function handleCSVCompatibilityError(...args) {
        return window.DTDataIngestion.handleCSVCompatibilityError(...args);
    }

    // ================================================
    // GitHub Issue #135: Coercion Validation Functions
    // ================================================

    // State for coercion validation
    let coercionValidationCancelled = false;

    /**
     * Handle sample coercion result from backend
     * Updates the status indicator for a specific variable
     */
    function handleSampleCoercionResult(...args) {
        return window.DTTypeCoercion.handleSampleCoercionResult(...args);
    }

    /**
     * Handle full coercion result from backend
     * Called when user clicks "Next" from Step 2
     */
    function handleFullCoercionResult(...args) {
        return window.DTTypeCoercion.handleFullCoercionResult(...args);
    }

    /**
     * GitHub Issue #148: Check if template has nested arrays that require sorted data
     * Called after coercion validation passes, before proceeding to step 3
     */
    function checkNestedArraySorting(...args) {
        return window.DTTypeCoercion.checkNestedArraySorting(...args);
    }

    /**
     * GitHub Issue #148: Handle sorting analysis result from backend
     */
    function handleSortingAnalysisResult(...args) {
        return window.DTTypeCoercion.handleSortingAnalysisResult(...args);
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
    function handleSortingExplanation(...args) {
        return window.DTTypeCoercion.handleSortingExplanation(...args);
    }

    // GitHub Issue #148: skipSorting() removed - auto-sort replaces the modal flow

    // GitHub Issue #148: applySorting() removed - auto-sort replaces the modal flow

    /**
     * GitHub Issue #148: Sort CSV data in memory and update state
     */
    function sortCSVDataInMemory(...args) {
        return window.DTTypeCoercion.sortCSVDataInMemory(...args);
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
     * GitHub Issue #148: Proceed to the next step after sorting check
     */
    function proceedToNextStep() {
        csvState.sortingPending = false;
        showCSVStep(csvState.modalStep + 1);
        csvState.navigationInProgress = false;
    }

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
    function showCoercionProgress(...args) {
        return window.DTTypeCoercion.showCoercionProgress(...args);
    }

    /**
     * Hide coercion progress modal
     */
    function hideCoercionProgress(...args) {
        return window.DTTypeCoercion.hideCoercionProgress(...args);
    }

    /**
     * Update coercion progress display
     */
    function updateCoercionProgress(...args) {
        return window.DTTypeCoercion.updateCoercionProgress(...args);
    }

    /**
     * Cancel coercion validation
     */
    function cancelCoercionValidation(...args) {
        return window.DTTypeCoercion.cancelCoercionValidation(...args);
    }

    // Expose cancelCoercionValidation globally for onclick handler
    window.cancelCoercionValidation = cancelCoercionValidation;

    /**
     * Start full coercion validation
     * Builds mappings from current state and sends to backend
     */
    function startFullCoercionValidation(...args) {
        return window.DTTypeCoercion.startFullCoercionValidation(...args);
    }

    /**
     * Trigger sample coercion validation for a variable
     * Collects sample values and sends to backend
     */
    function triggerSampleCoercionValidation(...args) {
        return window.DTTypeCoercion.triggerSampleCoercionValidation(...args);
    }


    /**
     * GitHub Issue #106: Helper function to sample CSV data for preview/validation
     * Returns first PREVIEW_SAMPLE_SIZE rows + headers for performance
     */
    function getSampledCSVData(...args) {
        return window.DTDataPreview.getSampledCSVData(...args);
    }

    // Function to update sample values in mapping table with fresh transformed data
    // GitHub Issue #162: Updated to use Source/Target layout
    function updateStep3SampleValues(...args) {
        return window.DTDataPreview.updateStep3SampleValues(...args);
    }


    // Function to refresh transformed data when navigating to Step 4
    function refreshTransformedDataForStep4(...args) {
        return window.DTDataPreview.refreshTransformedDataForStep4(...args);
    }

    // Function to refresh transformed data when navigating to Step 3
    function refreshTransformedDataForStep3(...args) {
        return window.DTDataPreview.refreshTransformedDataForStep3(...args);
    }

    // Column Mapping Functions
    // GitHub Issue #135: Source Format options for data transformation
    // Source formats are available for ALL target types - user may want to transform
    // COBOL/Scientific/Currency data even when storing as string
    const SOURCE_FORMAT_OPTIONS = window.DTTypeCoercion.SOURCE_FORMAT_OPTIONS;

    // Get all source format options (available for any target type)
    function getSourceFormatOptions(...args) {
        return window.DTTypeCoercion.getSourceFormatOptions(...args);
    }

    // Get default source format - suggest based on target type but don't restrict
    function getDefaultSourceFormat(...args) {
        return window.DTTypeCoercion.getDefaultSourceFormat(...args);
    }

    /**
     * GitHub Issue #135: Convert value based on source format
     * Applies source format transformation in frontend before sending to backend
     * This is necessary because backend uses naive CSV parsing that breaks quoted values
     */
    function convertValueBySourceFormat(...args) {
        return window.DTTypeCoercion.convertValueBySourceFormat(...args);
    }

    /**
     * GitHub Issue #135: Apply source format conversions to CSV data
     * Converts values based on user-selected source formats before sending to backend
     */
    function applySourceFormatConversions(...args) {
        return window.DTTypeCoercion.applySourceFormatConversions(...args);
    }

    function populateColumnMappingTable() {

        const mappingTableContainer = document.getElementById('columnMappingTable');
        if (!mappingTableContainer) {
            console.error('Column mapping table container not found');
            return;
        }

        // GitHub Issue #162: Check for datetime variables to show timezone row
        // Only datetime needs timezone conversion, not plain date
        const hasDateTimeVariables = csvState.templateVariables?.some(v => {
            const dataType = (v.dataType || '').toLowerCase();
            return dataType === 'datetime';
        });

        // Initialize source timezone if not set (default to user's local timezone)
        if (!csvState.sourceTimezone) {
            csvState.sourceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        }

        // GitHub Issue #162: Get CSV row count for display
        // Use totalRows first (actual file count), fall back to rows.length (preview slice)
        let rowCount = 0;
        if (csvState.currentParsedData) {
            rowCount = csvState.currentParsedData.totalRows ||
                       csvState.currentParsedData.rows?.length || 0;
        } else if (window.currentParsedCsvData) {
            rowCount = window.currentParsedCsvData.length;
        }

        // GitHub Issue #162: Build timezone options with system timezone as first/default
        const systemTimezone = csvState.sourceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const commonTimezones = [
            'UTC', 'GMT',
            'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
            'Europe/London', 'Europe/Paris', 'Europe/Berlin',
            'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kolkata',
            'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth',
            'Pacific/Auckland'
        ];

        // Build timezone options HTML - system timezone first if not already in list
        let timezoneOptions = '';
        if (!commonTimezones.includes(systemTimezone)) {
            timezoneOptions += `<option value="${systemTimezone}" selected>${systemTimezone} (System Default)</option>`;
        }
        commonTimezones.forEach(tz => {
            const isSystem = tz === systemTimezone;
            const label = isSystem ? `${tz} (System Default)` : tz;
            const selected = isSystem ? 'selected' : '';
            timezoneOptions += `<option value="${tz}" ${selected}>${label}</option>`;
        });

        // GitHub Issue #162: Build timezone subheader row (only if datetime variables exist)
        const timezoneSubheader = hasDateTimeVariables ? `
                    <tr class="timezone-subheader">
                        <td colspan="4">
                            <span class="timezone-label">Source timezone</span>
                            <select id="sourceTimezone" data-change="updateSourceTimezone" class="timezone-select">
                                ${timezoneOptions}
                            </select>
                            <span class="timezone-label">Target</span>
                            <span class="timezone-value" id="targetTimezoneDisplay">${csvState.currentEnvironment?.targetTimezone || 'UTC'} (from Environment)</span>
                        </td>
                    </tr>` : '';

        // GitHub Issue #148: Get nesting info for hierarchical display
        const nestingInfo = csvState.gridNestingInfo;

        // Variable-first layout: the variable is what the user is filling in, so it leads and
        // survives a narrow panel. Source format sits under the column picker; the sample cell
        // shows "raw → result" only when the two differ.
        const tableHTML = `
            <div class="csv-row-count">${rowCount.toLocaleString()} CSV rows</div>
            <table class="mapping-table enhanced-mapping map-layout hierarchical-layout">
                <colgroup>
                    <col class="map-col-variable"><col class="map-col-source"><col class="map-col-sample"><col class="map-col-status">
                </colgroup>
                <thead>${timezoneSubheader}
                    <tr>
                        <th>Variable</th>
                        <th>CSV Column</th>
                        <th>Sample</th>
                        <th class="status-col"></th>
                    </tr>
                </thead>
                <tbody>
                </tbody>
            </table>
        `;

        mappingTableContainer.innerHTML = tableHTML;

        const mappingTableBody = mappingTableContainer.querySelector('tbody');

        // Several modules write the two sample values by class, so watch the cells rather than
        // patch every writer: show only the result when the raw value is the same.
        const ownText = el => Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
        new MutationObserver(mutations => {
            const rows = new Set();
            mutations.forEach(m => {
                const node = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
                const row = node && node.closest('tr[data-variable]');
                if (row) rows.add(row);
            });
            rows.forEach(row => {
                const cell = row.querySelector('.map-sample-cell');
                const source = row.querySelector('.source-sample-cell');
                const target = row.querySelector('.target-sample-cell');
                if (cell && source && target) {
                    cell.classList.toggle('sample-same', ownText(source) === ownText(target));
                }
            });
        }).observe(mappingTableBody, { childList: true, characterData: true, subtree: true });

        if (!csvState.templateVariables || !csvState.currentHeaders) {
            mappingTableBody.innerHTML = '<tr><td colspan="4">No template variables or CSV headers available</td></tr>';
            return;
        }

        // GitHub Issue #137, #165: Filter out A8 system variables and ENV variables - they are not user-mapped
        const userVariables = csvState.templateVariables.filter(v => {
            const name = v.name || '';
            if (name.toUpperCase().startsWith('A8:')) return false;
            if (name.toUpperCase().startsWith('ENV:')) return false;
            return true;
        });

        if (userVariables.length === 0) {
            mappingTableBody.innerHTML = '<tr><td colspan="4">No user variables to map (only system/environment variables detected)</td></tr>';
            return;
        }

        // Initialize source types state if not exists
        if (!csvState.sourceTypes) {
            csvState.sourceTypes = {};
        }

        // Create mapping rows for each user variable (excluding A8 system variables)
        // Group rows by where the variable is used: BODY (top level, then each object/array
        // as an indented sub-section), URL PATH, QUERY · key, HEADER · key. A host that sends
        // no locations gets a flat list.
        const hasLocations = userVariables.some(v => Array.isArray(v.sources) && v.sources.length > 0);
        const sourceLabel = source => {
            const key = source.slice(source.indexOf(':') + 1);
            if (source === 'body') return 'Body';
            if (source === 'url') return 'URL';
            if (source.startsWith('query_param:')) return `Query ${key}`;
            if (source.startsWith('header:')) return `Header ${key}`;
            return source;
        };
        const locationOf = v => {
            const source = (v.sources && v.sources[0]) || 'body';
            if (source !== 'body') {
                return { key: source, rank: source === 'url' ? 2 : source.startsWith('query_param:') ? 3 : 4 };
            }
            const bodyPath = v.bodyPath || '';
            return { key: `body:${bodyPath}`, bodyPath, rank: bodyPath ? 1 : 0 };
        };
        const groupOrder = new Map();
        userVariables.forEach(v => {
            const location = locationOf(v);
            if (!groupOrder.has(location.key)) groupOrder.set(location.key, { ...location, first: groupOrder.size });
        });
        const orderedVariables = !hasLocations ? userVariables : userVariables
            .map((v, i) => ({ v, i, group: groupOrder.get(locationOf(v).key) }))
            .sort((a, b) => (a.group.rank - b.group.rank) || (a.group.first - b.group.first) || (a.i - b.i))
            .map(entry => entry.v);
        // `key` (a header or query param name) keeps its own case beside the caps label
        const sectionRow = (label, isSub, key) => {
            const tr = document.createElement('tr');
            tr.className = isSub ? 'map-section-row map-subsection-row' : 'map-section-row';
            tr.innerHTML = `<td colspan="4">${escapeHtml(label)}${key ? ` · <span class="map-section-key">${escapeHtml(key)}</span>` : ''}</td>`;
            return tr;
        };
        let currentGroupKey = null;
        let bodyHeaderShown = false;

        orderedVariables.forEach((variable, index) => {
            const row = document.createElement('tr');
            // GitHub Issue #137: Add data attribute for lookup by variable name
            row.setAttribute('data-variable', variable.name);

            const location = hasLocations ? locationOf(variable) : null;
            if (location && location.key !== currentGroupKey) {
                currentGroupKey = location.key;
                if (location.key.startsWith('body:')) {
                    if (!bodyHeaderShown) {
                        mappingTableBody.appendChild(sectionRow('Body', false));
                        bodyHeaderShown = true;
                    }
                    if (location.bodyPath) {
                        mappingTableBody.appendChild(sectionRow(location.bodyPath, true));
                    }
                } else if (location.key === 'url') {
                    mappingTableBody.appendChild(sectionRow('URL path', false));
                } else {
                    const [kind, ...rest] = location.key.split(':');
                    mappingTableBody.appendChild(sectionRow(kind === 'header' ? 'Header' : 'Query', false, rest.join(':')));
                }
            }
            if (location && location.bodyPath) {
                row.classList.add('map-row-nested');
            }

            // The section says where the variable is; only mention any other places it is used
            const otherSources = hasLocations ? (variable.sources || []).slice(1) : [];
            const alsoInText = otherSources.map(sourceLabel).join(', ');

            // GitHub Issue #137: the variable's name (not its index) goes with the change, as an
            // attribute value (#372: data-arg, not an inline handler's JS string)
            const escapedVarName = escapeHtml(variable.name);

            // GitHub Issue #135: Get target type and default source format
            const targetType = variable.dataType || 'string';
            const defaultSourceFormat = getDefaultSourceFormat(targetType);

            // GitHub Issue #218: STRING is default — always force passthrough for string types
            // This prevents stale sourceFormat (e.g., 'standard') from persisting after type change
            if (targetType === 'string') {
                csvState.sourceTypes[variable.name] = 'passthrough';
            } else if (!csvState.sourceTypes[variable.name]) {
                csvState.sourceTypes[variable.name] = defaultSourceFormat;
            }
            const currentSourceFormat = csvState.sourceTypes[variable.name];

            // Build Source Format dropdown options based on target type
            const formatOptions = getSourceFormatOptions(targetType);
            const sourceFormatOptions = formatOptions.map(opt =>
                `<option value="${opt.value}" ${opt.value === currentSourceFormat ? 'selected' : ''}>${opt.label}</option>`
            ).join('');

            // GitHub Issue #175: Parse modifiers for display in Template Variable column
            let mods = variable.modifiers;
            if (!mods && variable.formatModifier) {
                mods = parseModifiersForGrid(variable.formatModifier, targetType);
            }
            const hasValidation = mods && mods.hints && mods.hints.length > 0;
            // A list or lookup is sent as text, but is said as what it is (James, 2026-11-23: "I don't think this screen knows the type")
            const shownType = mods && mods.listKind ? mods.listKind : targetType;
            const isOptional = mods && (mods.isOptional || mods.isNullable);
            const hintsText = hasValidation ? mods.hints.join(', ') : '';

            // Build variable name with optional styling
            const varNameClass = hasValidation ? 'variable-name mapping-has-validation' : 'variable-name';
            const varNameTitle = hasValidation ? hintsText : '';
            const optionalIndicator = isOptional ? '<span class="mapping-optional-indicator" title="optional">○</span>' : '';

            row.innerHTML = `
                <td class="map-variable-cell">
                    <div class="map-variable-line">
                        <span class="${varNameClass}" ${varNameTitle ? `title="${varNameTitle}"` : ''}>${variable.name}${optionalIndicator}</span>
                        <span class="variable-type data-type-${shownType}">${shownType}</span>
                    </div>
                    ${alsoInText ? `<div class="variable-sources">Also in: ${escapeHtml(alsoInText)}</div>` : ''}
                    ${hintsText ? `<div class="variable-modifiers">${hintsText}</div>` : ''}
                </td>
                <td class="map-source-cell">
                    <select class="mapping-dropdown" data-change="updateVariableMapping" data-arg="${escapedVarName}">
                        <option value="">Select column...</option>
                        ${csvState.currentHeaders.map(header =>
                `<option value="${header}">${header}</option>`
            ).join('')}
                    </select>
                    <select class="source-format-select${currentSourceFormat === 'passthrough' ? ' format-none' : ''}" data-target-type="${targetType}" title="Source format" data-change="updateSourceType" data-arg="${escapedVarName}">
                        ${sourceFormatOptions}
                    </select>
                </td>
                <td class="map-sample-cell sample-same">
                    <div class="source-sample-cell">-</div>
                    <div class="target-sample-cell">-</div>
                </td>
                <td class="status-cell"></td>
            `;
            mappingTableBody.appendChild(row);

            // Preserve existing mapping if available (issue #75 - don't reset mappings when going back)
            if (variable.mappedTo && csvState.currentHeaders.includes(variable.mappedTo)) {
                const dropdown = row.querySelector('.mapping-dropdown');
                dropdown.value = variable.mappedTo;
                // GitHub Issue #162: Update both source and target sample values
                const sourceSampleCell = row.querySelector('.source-sample-cell');
                const targetSampleCell = row.querySelector('.target-sample-cell');
                const columnIndex = csvState.currentHeaders.indexOf(variable.mappedTo);
                if (columnIndex >= 0) {
                    // Get raw source value
                    let rawValue = '-';
                    if (csvState.currentParsedData && csvState.currentParsedData.rows && csvState.currentParsedData.rows.length > 0) {
                        rawValue = csvState.currentParsedData.rows[0][columnIndex] || '-';
                    } else if (window.currentParsedCsvData && window.currentParsedCsvData.length > 0) {
                        rawValue = window.currentParsedCsvData[0][columnIndex] || '-';
                    }
                    sourceSampleCell.textContent = rawValue;
                    // Compute target sample (converted value)
                    const targetValue = computeTargetSample(rawValue, variable.name, targetType);
                    targetSampleCell.textContent = targetValue;
                }
                // Ensure the variable state is marked as mapped
                variable.mapped = true;
                // GitHub Issue #135: Update status indicator
                updateRowStatus(variable.name);
            } else {
                // Only auto-map if no existing mapping exists. A column this endpoint remembered
                // (GitHub Issue #307) comes before name matching.
                const suggestedColumn = rememberedColumnFor(variable.name) || findBestColumnMatch(variable.name, csvState.currentHeaders);
                if (suggestedColumn) {
                    const dropdown = row.querySelector('.mapping-dropdown');
                    dropdown.value = suggestedColumn;
                    // GitHub Issue #137: Use variable name instead of index
                    updateVariableMapping(variable.name, suggestedColumn);
                }
            }
        });

        // Update dynamic mapping status after initial population
        updateMappingStatus();
        refreshUpdateTemplateOption();

        // GitHub Issue #135: Update all row statuses after population
        userVariables.forEach(variable => {
            if (variable.mappedTo) {
                updateRowStatus(variable.name);
            }
        });

        // GitHub Issue #175: Re-apply cached coercion results when navigating back
        // This ensures status indicators are shown correctly
        // A result is reused only while it was checked against the rows now loaded: new rows
        // (a re-chain, a new paste, a sort) get a fresh check instead of the old run's samples.
        if (csvState.coercionResults) {
            const rows = csvState.currentParsedData?.rows || window.currentParsedCsvData || [];
            userVariables.forEach((variable, idx) => {
                const cachedResult = csvState.coercionResults[variable.name];
                if (!cachedResult) return;
                const variableIndex = csvState.templateVariables.findIndex(v => v.name === variable.name);
                const columnIndex = variable.mappedTo ? csvState.currentHeaders.indexOf(variable.mappedTo) : -1;
                const checked = (cachedResult.coercedSamples || []).map(sample => String(sample.original ?? ''));
                const current = columnIndex < 0 ? [] : rows.slice(0, checked.length)
                    .map(row => (row[columnIndex] !== undefined ? String(row[columnIndex]) : ''));
                if (checked.length > 0 && checked.length === current.length && checked.every((value, i) => value === current[i])) {
                    // Re-apply the cached result (handleSampleCoercionResult will filter warnings)
                    handleSampleCoercionResult({ ...cachedResult, variableIndex });
                } else {
                    delete csvState.coercionResults[variable.name];
                    if (columnIndex >= 0) triggerSampleCoercionValidation(variable.name, variableIndex);
                }
            });
        }

        // GitHub Issue #162: Set the source timezone dropdown to the saved value
        const timezoneDropdown = document.getElementById('sourceTimezone');
        if (timezoneDropdown && csvState.sourceTimezone) {
            timezoneDropdown.value = csvState.sourceTimezone;
        }
    }

    function findBestColumnMatch(variableName, csvHeaders) {
        // Try exact match first (case insensitive)
        const exactMatch = csvHeaders.find(header =>
            header.toLowerCase() === variableName.toLowerCase()
        );
        if (exactMatch) return exactMatch;

        // Then ignoring punctuation too: a template updated from a mapping names the column
        // `location.gln` as `{{location_gln}}` (GitHub Issue #307, TemplateRename).
        if (window.TemplateRename) {
            const loose = window.TemplateRename.looseName(variableName);
            const looseMatch = loose && csvHeaders.find(header => window.TemplateRename.looseName(header) === loose);
            if (looseMatch) return looseMatch;
        }

        // Try partial match
        const partialMatch = csvHeaders.find(header =>
            header.toLowerCase().includes(variableName.toLowerCase()) ||
            variableName.toLowerCase().includes(header.toLowerCase())
        );
        if (partialMatch) return partialMatch;

        return null;
    }

    function updateVariableMapping(variableNameOrIndex, selectedColumn) {
        if (!csvState.templateVariables) {
            return;
        }

        // GitHub Issue #137: Support both variable name (string) and index (number)
        // Variable name is preferred since we filter out A8 variables
        let variableIndex;
        if (typeof variableNameOrIndex === 'string') {
            variableIndex = csvState.templateVariables.findIndex(v => v.name === variableNameOrIndex);
        } else {
            variableIndex = variableNameOrIndex;
        }

        if (variableIndex < 0 || !csvState.templateVariables[variableIndex]) {
            return;
        }

        // Update the variable mapping
        csvState.templateVariables[variableIndex].mapped = !!selectedColumn;
        csvState.templateVariables[variableIndex].column = selectedColumn;
        csvState.templateVariables[variableIndex].mappedTo = selectedColumn; // For compatibility

        // GitHub Issue #162: Update sample data display with Source/Target layout
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (mappingTable) {
            const variableName = csvState.templateVariables[variableIndex].name;
            const row = mappingTable.querySelector(`tr[data-variable="${variableName}"]`);
            if (row) {
                const sourceSampleCell = row.querySelector('.source-sample-cell');
                const targetSampleCell = row.querySelector('.target-sample-cell');

                if (selectedColumn) {
                    // Get raw value using column INDEX since CSV data is array-based
                    let rawValue = '-';
                    const columnIndex = csvState.currentHeaders.indexOf(selectedColumn);

                    if (columnIndex >= 0) {
                        if (csvState.currentParsedData && csvState.currentParsedData.rows && csvState.currentParsedData.rows.length > 0) {
                            rawValue = csvState.currentParsedData.rows[0][columnIndex] || '-';
                        } else if (window.currentParsedCsvData && window.currentParsedCsvData.length > 0) {
                            rawValue = window.currentParsedCsvData[0][columnIndex] || '-';
                        }
                    }

                    // Update source sample (raw value)
                    if (sourceSampleCell) {
                        sourceSampleCell.textContent = rawValue;
                    }

                    // Update target sample (converted value)
                    if (targetSampleCell) {
                        const variable = csvState.templateVariables[variableIndex];
                        const targetType = variable?.dataType || 'string';
                        const targetValue = computeTargetSample(rawValue, variableName, targetType);
                        targetSampleCell.textContent = targetValue;
                        targetSampleCell.title = `Mapped to: ${selectedColumn}`;
                    }
                } else {
                    // Column deselected - clear both samples
                    if (sourceSampleCell) sourceSampleCell.textContent = '-';
                    if (targetSampleCell) targetSampleCell.textContent = '-';
                }
            }
        }

        // Update navigation buttons based on mapping completeness
        updateCSVNavigationButtons();

        // Update dynamic mapping status display
        updateMappingStatus();
        refreshUpdateTemplateOption();

        // GitHub Issue #135: Trigger sample coercion validation (10 rows)
        if (selectedColumn) {
            const variableName = csvState.templateVariables[variableIndex].name;
            triggerSampleCoercionValidation(variableName, variableIndex);
        } else {
            // Column deselected - clear status
            const variableName = csvState.templateVariables[variableIndex].name;
            const mappingTable = document.querySelector('#columnMappingTable tbody');
            if (mappingTable) {
                const row = mappingTable.querySelector(`tr[data-variable="${variableName}"]`);
                if (row) {
                    const statusCell = row.querySelector('.status-cell');
                    if (statusCell) {
                        statusCell.innerHTML = '';
                    }
                }
            }
        }
    }

    // GitHub Issue #162: Update source timezone for all datetime columns
    function updateSourceTimezone(timezone) {
        csvState.sourceTimezone = timezone;

        // Refresh all target sample values in the mapping table
        refreshAllTargetSamples();

        // Refresh the JSON preview to show updated timezone conversion
        // Only if we're in a step that shows the preview
        if (csvState.currentStep >= 3 && csvState.endpointId) {
            generateJSONPreview();
        }
    }

    /**
     * GitHub Issue #162: Compute target sample value with source format and timezone conversion
     * GitHub Issue #175: Also applies modifiers (transforms) to show the final value
     * @param {string} rawValue - The raw value from CSV
     * @param {string} variableName - The template variable name
     * @param {string} targetType - The target data type (date, datetime, number, etc.)
     * @returns {string} - The converted value for display
     */
    function computeTargetSample(rawValue, variableName, targetType) {
        if (!rawValue || rawValue === '-' || rawValue === '') {
            return '-';
        }

        // Get source format for this variable
        const sourceFormat = csvState.sourceTypes?.[variableName] || getDefaultSourceFormat(targetType);

        // Apply source format conversion first
        let convertedValue = convertValueBySourceFormat(rawValue, sourceFormat);

        // For datetime types only, apply timezone conversion if configured
        // Date-only values don't have timezone - they represent a calendar date
        if (targetType === 'datetime' && csvState.sourceTimezone) {
            convertedValue = applyTimezoneConversion(convertedValue, targetType);
        }

        // GitHub Issue #175: Apply modifiers (transforms) to show final value
        convertedValue = applyModifiersForDisplay(convertedValue, variableName, targetType);

        return convertedValue;
    }

    /**
     * GitHub Issue #175: Apply transform modifiers for display in TARGET SAMPLE column
     * Applies: upper, lower, rnd, floor, ceil (transforms that change the value)
     * Does NOT apply: validation rules (length, comparisons), opt, null (empty behavior)
     *
     * @param {string} value - The current value after type conversion
     * @param {string} variableName - The template variable name
     * @param {string} targetType - The target data type
     * @returns {string} - The value with transforms applied
     */
    function applyModifiersForDisplay(value, variableName, targetType) {
        // Find the template variable to get its modifiers
        const templateVar = csvState.templateVariables?.find(v => v.name === variableName);
        if (!templateVar) {
            return value;
        }

        // Get modifiers - either pre-parsed or parse on-the-fly from modifierString/formatModifier
        let mods = templateVar.modifiers;
        if (!mods) {
            // Try to parse from modifierString (grid data) or formatModifier (backend data)
            const modString = templateVar.modifierString || templateVar.formatModifier;
            if (modString) {
                mods = parseModifiersForGrid(modString, targetType);
            }
        }

        if (!mods) {
            return value;
        }

        // For strings: apply upper/lower transforms
        if (targetType === 'string') {
            if (mods.toUpper) {
                return value.toUpperCase();
            }
            if (mods.toLower) {
                return value.toLowerCase();
            }
        }

        // For numbers: apply rnd, floor, ceil transforms
        if (targetType === 'number' || targetType === 'integer' || targetType === 'int') {
            const num = parseFloat(value);
            if (isNaN(num)) {
                return value;
            }

            let result = num;

            // Apply integer enforcement (from isInteger flag set by 'int' modifier)
            if (mods.isInteger) {
                result = Math.round(result);
            }

            // Apply rounding
            if (mods.roundTo !== null && mods.roundTo !== undefined) {
                const factor = Math.pow(10, mods.roundTo);
                result = Math.round(result * factor) / factor;
            }

            // Return formatted value
            if (mods.roundTo !== null && mods.roundTo !== undefined) {
                return result.toFixed(mods.roundTo);
            }
            return String(result);
        }

        // For date/datetime: apply date math transforms
        if (targetType === 'date' || targetType === 'datetime') {
            if (mods.dateMath) {
                // Parse the date math modifier (e.g., "+2d", "-1w", "+3M")
                const match = mods.dateMath.match(/^([+-]?\d+)([dwMyhm])$/);
                if (match) {
                    const amount = parseInt(match[1], 10);
                    const unit = match[2];

                    // Parse input as UTC date
                    let dateValue = value;
                    if (targetType === 'datetime' && !value.endsWith('Z') && !value.match(/[+-]\d{2}:?\d{2}$/)) {
                        dateValue = value + 'Z';
                    } else if (targetType === 'date') {
                        // For date type, append T00:00:00Z to parse as UTC
                        dateValue = value + 'T00:00:00Z';
                    }
                    const date = new Date(dateValue);

                    if (!isNaN(date.getTime())) {
                        // Apply date math based on unit
                        switch (unit) {
                            case 'd': date.setUTCDate(date.getUTCDate() + amount); break;
                            case 'w': date.setUTCDate(date.getUTCDate() + (amount * 7)); break;
                            case 'M': date.setUTCMonth(date.getUTCMonth() + amount); break;
                            case 'y': date.setUTCFullYear(date.getUTCFullYear() + amount); break;
                            case 'h': date.setUTCHours(date.getUTCHours() + amount); break;
                            case 'm': date.setUTCMinutes(date.getUTCMinutes() + amount); break;
                        }

                        // Format output for display
                        if (targetType === 'date') {
                            return date.toISOString().split('T')[0]; // YYYY-MM-DD
                        } else {
                            // datetime: YYYY-MM-DDTHH:MM:SS (without ms/Z for cleaner display)
                            return date.toISOString().replace(/\.\d{3}Z$/, '');
                        }
                    }
                }
            }
            return value;
        }

        return value;
    }

    /**
     * GitHub Issue #162: Apply timezone conversion for datetime values
     * Converts from source timezone to Environment's target timezone (or UTC as fallback)
     *
     * The input datetime string (e.g., "2024-01-05T09:00:00") is interpreted as
     * being in the SOURCE timezone, and we convert it to the target timezone.
     */
    function applyTimezoneConversion(value, targetType) {
        if (!value || value === '-') {
            return value;
        }

        try {
            const sourceTimezone = csvState.sourceTimezone || 'UTC';
            // Get target timezone from Environment, fall back to UTC
            const targetTimezone = csvState.currentEnvironment?.targetTimezone || 'UTC';

            // If source and target are the same, no conversion needed
            if (sourceTimezone === targetTimezone) {
                return value;
            }

            // Parse datetime: YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD HH:MM:SS
            const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s)(\d{2}):(\d{2}):(\d{2})/);
            if (!match) {
                return value;
            }

            const [, year, month, day, hour, minute, second] = match;

            // Calculate timezone offsets using a fixed reference point
            const testUtc = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));

            // Get source timezone offset
            const sourceFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: sourceTimezone,
                hour: 'numeric',
                hour12: false
            });
            const sourceHourTest = parseInt(sourceFormatter.format(testUtc), 10) || 0;

            // Get target timezone offset (with fallback for invalid timezone)
            let targetHourTest;
            try {
                const targetFormatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: targetTimezone,
                    hour: 'numeric',
                    hour12: false
                });
                targetHourTest = parseInt(targetFormatter.format(testUtc), 10) || 0;
            } catch (tzError) {
                // Invalid target timezone, fall back to UTC
                console.warn('[CSV Handler] Invalid target timezone, using UTC:', targetTimezone);
                targetHourTest = 12; // UTC at our reference point
            }

            // Calculate offsets from UTC (using 12:00 UTC reference)
            let sourceOffset = sourceHourTest - 12;
            let targetOffset = targetHourTest - 12;

            // Normalize offsets to -12 to +12 range
            if (sourceOffset > 12) sourceOffset -= 24;
            if (sourceOffset < -12) sourceOffset += 24;
            if (targetOffset > 12) targetOffset -= 24;
            if (targetOffset < -12) targetOffset += 24;

            // Convert: source → UTC → target
            // Net effect: add (targetOffset - sourceOffset) hours
            const netOffset = targetOffset - sourceOffset;

            const convertedDate = new Date(Date.UTC(
                parseInt(year, 10),
                parseInt(month, 10) - 1,
                parseInt(day, 10),
                parseInt(hour, 10) + netOffset,
                parseInt(minute, 10),
                parseInt(second, 10)
            ));

            if (isNaN(convertedDate.getTime())) {
                return value;
            }

            // Format result
            const resultYear = convertedDate.getUTCFullYear();
            const resultMonth = String(convertedDate.getUTCMonth() + 1).padStart(2, '0');
            const resultDay = String(convertedDate.getUTCDate()).padStart(2, '0');
            const resultHour = String(convertedDate.getUTCHours()).padStart(2, '0');
            const resultMinute = String(convertedDate.getUTCMinutes()).padStart(2, '0');
            const resultSecond = String(convertedDate.getUTCSeconds()).padStart(2, '0');

            return `${resultYear}-${resultMonth}-${resultDay}T${resultHour}:${resultMinute}:${resultSecond}`;
        } catch (e) {
            console.error('[CSV Handler] Timezone conversion error:', e);
            return value;
        }
    }

    /**
     * GitHub Issue #162: Refresh all target sample values when timezone or format changes
     */
    function refreshAllTargetSamples() {
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (!mappingTable || !csvState.templateVariables) return;

        csvState.templateVariables.forEach(variable => {
            // Skip A8 system variables and ENV variables (they don't have rows in the table)
            if (variable.name && variable.name.toUpperCase().startsWith('A8:')) return;
            if (variable.name && variable.name.toUpperCase().startsWith('ENV:')) return;
            if (!variable.mappedTo) return;

            const row = mappingTable.querySelector(`tr[data-variable="${variable.name}"]`);
            if (!row) return;

            const targetSampleCell = row.querySelector('.target-sample-cell');
            const sourceSampleCell = row.querySelector('.source-sample-cell');
            if (!targetSampleCell || !sourceSampleCell) return;

            const rawValue = sourceSampleCell.textContent;
            const targetType = variable.dataType || 'string';
            targetSampleCell.textContent = computeTargetSample(rawValue, variable.name, targetType);
        });
    }

    // GitHub Issue #135: Update source format for a variable
    function updateSourceType(variableName, sourceFormat) {
        if (!csvState.sourceTypes) {
            csvState.sourceTypes = {};
        }
        csvState.sourceTypes[variableName] = sourceFormat;

        // GitHub Issue #162: Update target sample value for this row
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (mappingTable) {
            const row = mappingTable.querySelector(`tr[data-variable="${variableName}"]`);
            if (row) {
                const targetSampleCell = row.querySelector('.target-sample-cell');
                const sourceSampleCell = row.querySelector('.source-sample-cell');
                if (targetSampleCell && sourceSampleCell) {
                    const rawValue = sourceSampleCell.textContent;
                    const variable = csvState.templateVariables?.find(v => v.name === variableName);
                    const targetType = variable?.dataType || 'string';
                    const targetValue = computeTargetSample(rawValue, variableName, targetType);
                    targetSampleCell.textContent = targetValue;
                }
            }
        }

        // Find variable and re-trigger sample validation with stored samples
        const variableIndex = csvState.templateVariables?.findIndex(v => v.name === variableName);
        if (variableIndex >= 0) {
            const variable = csvState.templateVariables[variableIndex];
            if (variable && variable.mappedTo) {
                // Re-trigger validation with stored sample values (or collect new ones)
                triggerSampleCoercionValidation(variableName, variableIndex);
            }
        }
    }

    // GitHub Issue #135: Update status indicator for a mapping row
    // Only show warnings for ACTUAL issues, not user choices
    function updateRowStatus(variableName) {
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (!mappingTable) return;

        const row = mappingTable.querySelector(`tr[data-variable="${variableName}"]`);
        if (!row) return;

        const statusCell = row.querySelector('.status-cell');
        // GitHub Issue #162: Use source sample cell for validation (raw value)
        const sourceSampleCell = row.querySelector('.source-sample-cell');
        if (!statusCell) return;

        const variable = csvState.templateVariables?.find(v => v.name === variableName);
        if (!variable) return;

        const targetType = (variable.dataType || 'string').toLowerCase();
        const sourceFormat = csvState.sourceTypes?.[variableName] || getDefaultSourceFormat(targetType);
        const mappedColumn = variable.mappedTo;

        // Clear previous status
        statusCell.innerHTML = '';
        statusCell.className = 'status-cell';
        row.classList.remove('has-warning', 'has-error');

        if (!mappedColumn) {
            // Not mapped yet - no status
            return;
        }

        // Get the raw sample value from source sample cell for validation
        const sampleValue = sourceSampleCell ? sourceSampleCell.textContent : '';
        if (!sampleValue || sampleValue === '-') {
            return; // No data to validate
        }

        // Check for ACTUAL issues only (not user choices)
        const issue = checkForActualIssues(sampleValue, sourceFormat, targetType);

        if (issue) {
            // Show warning with explanation text
            statusCell.innerHTML = `<span class="status-indicator status-warning" title="${issue.tooltip}">!</span>`;
            row.classList.add('has-warning');

            // Add issue summary below the sample value
            let issueText = sourceSampleCell.querySelector('.issue-text');
            if (!issueText) {
                issueText = document.createElement('div');
                issueText.className = 'issue-text';
                sourceSampleCell.appendChild(issueText);
            }
            issueText.textContent = issue.summary;
        }
    }

    // GitHub Issue #135: Check for ACTUAL issues only (local quick check)
    // Real validation happens via backend - this is just for instant feedback
    // Source format values: standard, cobol, scientific, currency (for numbers)
    //                       auto, yyyy-mm-dd, etc. (for dates)
    //                       standard (for booleans)
    //                       passthrough (for strings)
    function checkForActualIssues(valueStr, sourceFormat, targetType) {
        const cleanValue = valueStr.replace(/^["']|["']$/g, '').trim();
        const numberFormats = ['standard', 'cobol', 'scientific', 'currency'];

        // Issue 1: Precision loss when converting large numbers with standard format
        if (numberFormats.includes(sourceFormat)) {
            const MAX_SAFE = 9007199254740991;
            // Only check standard format - COBOL, scientific, currency have different parsing
            if (sourceFormat === 'standard' && /^-?\d+$/.test(cleanValue)) {
                const numValue = parseFloat(cleanValue);
                if (Math.abs(numValue) > MAX_SAFE) {
                    return {
                        summary: 'Precision loss possible',
                        tooltip: `Value "${cleanValue}" exceeds JavaScript's safe integer range.`
                    };
                }
            }
        }

        // Issue 2: Parse failure when Source is number format but value isn't numeric
        if (sourceFormat === 'standard' && !/^-?\d*\.?\d+$/.test(cleanValue) && cleanValue !== '') {
            return {
                summary: 'May not parse as number',
                tooltip: `Value "${cleanValue}" may not parse as a standard number.`
            };
        }

        // Issue 3: Parse failure when Source is boolean but value isn't boolean-like
        if (sourceFormat === 'standard' && (targetType === 'boolean' || targetType === 'bool')) {
            const lowerVal = cleanValue.toLowerCase();
            if (!['true', 'false', '1', '0', 'yes', 'no', 'y', 'n', ''].includes(lowerVal)) {
                return {
                    summary: 'May not parse as boolean',
                    tooltip: `Value "${cleanValue}" may not parse as a boolean. Expected: true/false, yes/no, 1/0`
                };
            }
        }

        // No issues - don't show anything (backend validation will provide detailed status)
        return null;
    }

    // Expose updateSourceType globally for onclick handler
    window.updateSourceType = updateSourceType;
    window.updateSourceTimezone = updateSourceTimezone;

    function updateMappingStatus() {
        if (window.BatchStepper) window.BatchStepper.refresh();
        const statusText = document.getElementById('mappingStatusText');
        const errorsContainer = document.getElementById('mappingErrors');

        if (!csvState.templateVariables) {
            return;
        }

        // Count mapped variables — only those that NEED a column. An unmapped |opt / |null
        // variable is fine (its key is omitted / sent as null), so it is neither counted
        // as missing nor highlighted.
        const needMapping = getVariablesThatNeedMapping();
        const totalVariables = needMapping.length;
        const mappedVariables = needMapping.filter(v => v.mapped).length;
        const unmappedVariables = needMapping.filter(v => !v.mapped);
        const allMapped = mappedVariables === totalVariables;

        // GitHub Issue #135: Highlight unmapped CSV Column dropdowns (not whole rows)
        const mappingTable = document.querySelector('#columnMappingTable tbody');
        if (mappingTable) {
            // Clear previous unmapped highlights from dropdowns
            mappingTable.querySelectorAll('select.unmapped-highlight').forEach(select => {
                select.classList.remove('unmapped-highlight');
            });

            // Highlight the CSV Column dropdown for unmapped variables
            unmappedVariables.forEach(v => {
                const row = mappingTable.querySelector(`tr[data-variable="${v.name}"]`);
                if (row) {
                    // Find the CSV Column dropdown (first select in the row)
                    const csvColumnSelect = row.querySelector('select.mapping-dropdown');
                    if (csvColumnSelect) {
                        csvColumnSelect.classList.add('unmapped-highlight');
                    }
                }
            });
        }

        // GitHub Issue #135: Hide top error container - use footer notification instead
        if (errorsContainer) {
            errorsContainer.classList.add('hidden');
        }

        // GitHub Issue #162: Removed "All X fields mapped" status text - redundant with Status column
        // Just hide the status text element if it exists
        if (statusText) {
            statusText.style.display = 'none';
        }

        if (allMapped) {
            // Clear any mapping-related notification (but only if we're in Step 2)
            if (csvState.modalStep === 2) {
                clearModalNotification();
            }
        }
        // Unmapped variables: the dropdowns are highlighted and the step bar shows "!" — the
        // footer stays clear. Next says what is missing when it is pressed.
    }

    function triggerCSVCompatibilityVerification() {
        // Get current endpoint ID from global scope
        const currentEndpointId = window.currentEndpointId || document.body.getAttribute('data-endpoint-id');

        if (!currentEndpointId || currentEndpointId === 'NEW') {
            console.error('❌ [CSV Handler] No valid endpoint ID for CSV compatibility verification');
            showCSVVerificationError('Please save the endpoint before verifying CSV compatibility');
            return;
        }

        // Check CSV data availability
        if (!csvState.rawCSVContent && (!window.csvModalData || !window.csvModalData.content)) {
            console.error('No CSV data available for verification');
            showCSVVerificationError('No CSV data available for verification');
            return;
        }

        const csvContent = csvState.rawCSVContent || window.csvModalData.content;
        getVscode().postMessage({
            type: 'verifyCSVCompatibility',
            csvData: csvContent,
            endpointId: currentEndpointId
        });
    }

    // Message handler for environment data updates
    window.addEventListener('message', event => {
        const message = event.data;

        // Handle current environment data response
        // GitHub Issue #162: Always store environment data (needed for timezone conversion in Step 2)
        if (message.type === 'currentEnvironmentData') {
            // Store environment data for parallel processing configuration and timezone
            csvState.currentEnvironment = message.environment;

            // GitHub Issue #162: Update target timezone display in Step 2 if visible
            const targetTimezoneDisplay = document.getElementById('targetTimezoneDisplay');
            if (targetTimezoneDisplay && message.environment?.targetTimezone) {
                targetTimezoneDisplay.textContent = message.environment.targetTimezone;
                // Refresh target samples with new timezone
                refreshAllTargetSamples();
            }

            // The run's environment fields are on Review (#435)
            if (csvState.modalStep !== 4) {
                return;
            }

            const populateField = (id, value) => {
                const element = document.getElementById(id);
                if (element) {
                    element.textContent = value;
                }
            };

            // Update environment name and base URL
            if (message.environment) {
                populateField('executionEnvironment', message.environment.name || 'Unknown');

                // Build full URL with method and path
                const baseUrl = message.environment.baseUrl || 'Not configured';
                const endpointMethod = csvState.endpointConfig?.method || document.getElementById('endpointMethod')?.value || 'POST';
                const endpointPath = csvState.endpointConfig?.path || document.getElementById('endpointPath')?.value || '/api/endpoint';

                if (baseUrl !== 'Not configured') {
                    // The address the rows go to, as Step 4's preview shows it: the environment's
                    // {{ENV:name}} values filled in (the same rule as env-template.ts) and one
                    // slash between the base URL and the path. A name the environment lacks stays.
                    const variables = message.environment.variables || {};
                    const filledPath = String(endpointPath).replace(/\{\{\s*ENV:([^}:]+?)\s*\}\}/gi, (match, name) =>
                        Object.prototype.hasOwnProperty.call(variables, name.trim()) ? String(variables[name.trim()]) : match);
                    // #424: the base URL's own {{name}} too (environment-url.ts fillBaseUrl)
                    const filledBase = baseUrl.replace(/\{\{\s*(?:ENV:)?([^{}:|\s]+)\s*\}\}/gi, (match, name) => variables[name] ? String(variables[name]) : match);
                    const joined = filledBase.replace(/\/+$/, '') + (filledPath.startsWith('/') ? '' : '/') + filledPath;
                    populateField('executionFullUrl', `${endpointMethod} ${joined}`);
                } else {
                    populateField('executionFullUrl', `${endpointMethod} ${baseUrl}`);
                }

                // #424: the variables the environment's header shows (the org among them), one stat
                // each before the Endpoint, so the confirm step says where the rows are going
                document.querySelectorAll('.execution-variable-stat').forEach(el => el.remove());
                const endpointStat = document.getElementById('executionFullUrl')?.closest('.stat-item');
                (message.headerVariables || []).forEach(variable => {
                    if (!endpointStat) return;
                    const item = document.createElement('div');
                    item.className = 'stat-item execution-variable-stat';
                    const label = document.createElement('span');
                    label.className = 'stat-label';
                    label.textContent = variable.name;
                    const value = document.createElement('span');
                    value.textContent = variable.value || 'Not set';
                    item.append(label, value);
                    endpointStat.parentElement.insertBefore(item, endpointStat);
                });

                // The production warning first, so nothing after it can stop it showing. Production
                // is what the host says (isProduction: production-guard's rule, the one Execute's
                // confirmation uses), or a name with "prod" in it, as before.
                const warningElement = document.getElementById('executionWarning');
                if (warningElement) {
                    const name = String(message.environment.name || '').toLowerCase();
                    const isProd = message.isProduction === true || name.includes('prod');
                    warningElement.classList.toggle('hidden', !isProd);
                }

                // Populate parallel processing dropdown
                const parallelConfig = message.environment.parallelProcessing;
                populateProcessingModeDropdown(parallelConfig);
            }
        }

        // Keep the endpoint as saved, so the next file in this tab maps from what this run
        // remembered (GitHub Issue #307) rather than from the copy the tab opened with.
        if (message.type === 'endpointSaved' && message.endpoint) {
            csvState.endpointConfig = message.endpoint;
        }

        // Handle endpoint saved response (used when saving before execution)
        if (message.type === 'endpointSaved' && csvState.waitingForSave) {
            // Clear the waiting flag
            csvState.waitingForSave = false;

            // Now proceed with execution
            const currentEndpointId = window.currentEndpointId || document.body.getAttribute('data-endpoint-id');
            window.CSVHandler.executeBatchWithConfiguration(currentEndpointId);
        }

        // Handle endpoint save error (when saving before execution)
        if (message.type === 'endpointSaveError' && csvState.waitingForSave) {
            console.error('❌ [Save Config] Failed to save endpoint configuration:', message.error);

            // Clear the waiting flag
            csvState.waitingForSave = false;

            showCSVError(`Failed to save configuration: ${message.error || 'Unknown error'}`);

            // Reset execute button
            const executeBtn = document.getElementById('csvExecuteBtn');
            if (executeBtn) {
                executeBtn.disabled = false;
                executeBtn.textContent = 'Execute';
            }
        }

        // Handle endpoint data response for array repetition initialization
        if (message.type === 'endpointData') {
            initializeArrayRepetitionFromEndpoint(message.endpoint);
        }

        // GitHub Issue #133: Handle endpointConfigLoaded from Run Batch webview
        // Run Batch sends 'endpointConfigLoaded' instead of 'endpointData'
        if (message.type === 'endpointConfigLoaded') {
            initializeArrayRepetitionFromEndpoint(message.endpoint);
        }

        // GitHub Issue #273: restore the Execute button after a cancelled
        // production-guard confirmation (button was mid "Processing…" spin).
        if (message.type === 'resetExecuteButton') {
            var resetBtn = document.getElementById('csvExecuteBtn');
            if (resetBtn) {
                resetBtn.disabled = false;
                resetBtn.innerHTML = 'Execute';
            }
        }

        // GitHub Issue #224: Handle batch preparation progress to update Execute button
        if (message.type === 'batchPreparationProgress') {
            var executeBtn = document.getElementById('csvExecuteBtn');
            if (executeBtn) {
                var displayMsg = message.message || 'Preparing batch...';
                executeBtn.innerHTML = '<span class="btn-spinner"></span> ' + displayMsg;
            }
        }

        // Handle bulk load command execution response
        if (message.type === 'bulkLoadCommandExecuted') {

            if (message.error) {
                // GitHub Issue #396: the batch did not start. Put Execute back (it was mid
                // "Preparing batch execution…") so it can be run again, and leave the
                // reason on screen until it is dismissed.
                var failedBtn = document.getElementById('csvExecuteBtn');
                if (failedBtn) {
                    failedBtn.disabled = false;
                    failedBtn.innerHTML = 'Execute';
                }
                showModalNotification('error', message.error, { persistent: true });
            } else if (message.success) {
                // Show success message to user
                // Note: Modal already closed by startDataLoading function
            }
        }

        // Handle array repetition preview response
        if (message.type === 'arrayRepetitionPreviewGenerated') {
            if (message.error) {
                console.error('❌ [Array Repetition] Preview generation failed:', message.error);
                displayJsonPreviewError(`Array Repetition Preview Error: ${message.error}`);
            } else if (message.jsonPreview) {

                // Display formatted JSON preview using Monaco editor
                if (csvState.jsonPreviewEditor) {
                    let formattedJson;
                    if (typeof message.jsonPreview === 'string') {
                        try {
                            const parsed = JSON.parse(message.jsonPreview);
                            formattedJson = JSON.stringify(parsed, null, 2);
                        } catch (e) {
                            formattedJson = message.jsonPreview;
                        }
                    } else {
                        formattedJson = JSON.stringify(message.jsonPreview, null, 2);
                    }

                    // Add info comments with array repetition details
                    let jsonWithComments = `/*
 * JSON Body Preview - Array Repetition: ${csvState.arrayRepetition} records per call
 *
 * This shows how multiple CSV rows will be combined into a single API request.
 * Selected array: ${csvState.selectedArrayPath}`;

                    if (message.showTruncationNote) {
                        jsonWithComments += `
 * 
 * NOTE: Showing first 25 records only. Actual execution will include all ${csvState.arrayRepetition} records.`;
                    }

                    jsonWithComments += `
 */

${formattedJson}`;

                    csvState.jsonPreviewEditor.setValue(jsonWithComments);
                } else {
                    // HTML fallback (GitHub Issue #106)
                    const previewContainer = document.getElementById('jsonPreviewEditor');
                    if (previewContainer) {
                        // Escape HTML to prevent injection, then display as plain text
                        const escapedJson = message.jsonPreview
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                        previewContainer.innerHTML = `<pre class="json-preview-pre">${escapedJson}</pre>`;
                    }
                }
            }
        }

        // Handle bulk JSON generated response from backend (for preview only now)
        if (message.type === 'bulkJsonGenerated') {

            // GitHub Issue #308: Step 4 is drawn from the batch plan, for every endpoint shape.
            // A request with no body has no JSON preview to process, so draw it now; otherwise
            // it is drawn at the end of the preview handling below, so the plan's counts and
            // Reps are the last word over the older nested-mode sync.
            if (!message.error && message.plan && !message.jsonPreview) {
                renderStep4(message.plan);
            }

            if (message.error) {
                console.error('❌ [JSON Preview] Bulk JSON generation failed:', message.error);
                // Display error message using helper function  
                displayJsonPreviewError(`Bulk JSON Error: ${message.error}`);
            } else if (message.mode === 'preview' && message.jsonPreview) {

                // GitHub Issue #127: Store encoded/unencoded previews for toggle
                csvState.encodedPreview = message.jsonPreview;
                csvState.unencodedPreview = message.unencodedPreview || message.jsonPreview;
                csvState.hasEncodingMarkers = message.hasEncodingMarkers || false;
                csvState.currentPreviewMode = 'encoded'; // Default: show encoded

                // GitHub Issue #127: Show/hide encoding toggle button based on whether template has encoding markers
                const toggleButtonContainer = document.getElementById('encodingToggleButtonContainer');
                const toggleButton = document.getElementById('encodingToggleBtn');
                const toggleLabel = document.getElementById('encodingToggleLabel');

                if (toggleButtonContainer) {
                    toggleButtonContainer.style.display = csvState.hasEncodingMarkers ? 'block' : 'none';
                }

                // Reset button label to show ACTION (default view is encoded, so button shows "Unencoded")
                if (toggleLabel) {
                    toggleLabel.textContent = 'Unencoded';
                }

                // GitHub Issue #127: Update file size display in header summary
                const fileSizeDisplay = document.getElementById('requestFileSizeDisplay');
                if (fileSizeDisplay) {
                    // Always show encoded size (what gets sent to API)
                    fileSizeDisplay.textContent = message.encodedSize || '-';
                }

                // Display formatted JSON preview using Monaco editor
                if (csvState.jsonPreviewEditor) {
                    // Use encoded preview by default (what gets sent to API)
                    let formattedJson;
                    if (typeof csvState.encodedPreview === 'string') {
                        try {
                            // Parse and re-stringify to ensure proper formatting
                            const parsed = JSON.parse(csvState.encodedPreview);
                            formattedJson = JSON.stringify(parsed, null, 2);
                        } catch (e) {
                            // If parsing fails, use the string as-is
                            formattedJson = csvState.encodedPreview;
                        }
                    } else {
                        formattedJson = JSON.stringify(csvState.encodedPreview, null, 2);
                    }

                    // Add info as comments at the top
                    const previewMode = csvState.hasEncodingMarkers ? ' (BASE64 Encoded)' : '';
                    const jsonWithComments = `/*
 * JSON Body Preview${previewMode}
 *
 * This is the actual JSON that will be sent to the API for the first row of your CSV data.
 * This preview shows variable substitution including A8 variables (sequence, date, datetime).
 */

${formattedJson}`;

                    csvState.jsonPreviewEditor.setValue(jsonWithComments);

                    // Handle array detection if provided (only on initial load, not on slider updates)
                    if (message.detectedArrays && !csvState.arraysAlreadyDetected) {
                        populateArrayDropdown(message.detectedArrays);
                        csvState.arraysAlreadyDetected = true; // Prevent re-population on slider changes
                    } else if (!csvState.arraysAlreadyDetected) {
                        populateArrayDropdown([]);
                        csvState.arraysAlreadyDetected = true;
                    }

                    // GitHub Issue #119: Sync UI with nested mode default value
                    if (message.nestedMode && message.nestedMode.enabled && message.nestedMode.maxGroupsShown) {
                        // Store nested mode data in csvState for use by onElementsInputChange()
                        csvState.nestedMode = message.nestedMode;
                        csvState.arrayRepetition = message.nestedMode.maxGroupsShown;

                        // Update the UI slider/input if it exists (correct field ID)
                        const repsInput = document.getElementById('elementsInput');
                        if (repsInput) {
                            repsInput.value = message.nestedMode.maxGroupsShown;
                        }

                        // Update API calls display with nested mode calculation
                        const totalCallsDisplay = document.getElementById('totalApiCallsDisplay');
                        if (totalCallsDisplay && message.nestedMode.estimatedApiCalls !== undefined) {
                            totalCallsDisplay.textContent = message.nestedMode.estimatedApiCalls;
                        }

                        console.log(`🔄 [Nested Mode] Synced Reps UI to backend value: ${message.nestedMode.maxGroupsShown}, API calls: ${message.nestedMode.estimatedApiCalls}`);
                    } else {
                        // Clear nested mode data if not in nested mode
                        csvState.nestedMode = null;
                    }
                } else {
                    console.warn('⚠️ [JSON Preview] Monaco editor not available, using HTML fallback');

                    // Fallback to HTML if Monaco editor not available (GitHub Issue #106)
                    const previewContainer = document.getElementById('jsonPreviewEditor');
                    if (previewContainer) {
                        // Escape HTML to prevent injection, then display as plain text
                        const escapedJson = message.jsonPreview
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                        previewContainer.innerHTML = `<pre class="json-preview-pre">${escapedJson}</pre>`;
                    }

                    // Handle array detection if provided (only on initial load, not on slider updates)
                    if (message.detectedArrays && !csvState.arraysAlreadyDetected) {
                        populateArrayDropdown(message.detectedArrays);
                        csvState.arraysAlreadyDetected = true; // Prevent re-population on slider changes
                    } else if (!csvState.arraysAlreadyDetected) {
                        populateArrayDropdown([]);
                        csvState.arraysAlreadyDetected = true;
                    }

                    // GitHub Issue #119: Sync UI with nested mode default value
                    if (message.nestedMode && message.nestedMode.enabled && message.nestedMode.maxGroupsShown) {
                        // Store nested mode data in csvState for use by onElementsInputChange()
                        csvState.nestedMode = message.nestedMode;
                        csvState.arrayRepetition = message.nestedMode.maxGroupsShown;

                        const repsInput = document.getElementById('elementsInput');
                        if (repsInput) {
                            repsInput.value = message.nestedMode.maxGroupsShown;
                        }

                        // Update API calls display with nested mode calculation
                        const totalCallsDisplay = document.getElementById('totalApiCallsDisplay');
                        if (totalCallsDisplay && message.nestedMode.estimatedApiCalls !== undefined) {
                            totalCallsDisplay.textContent = message.nestedMode.estimatedApiCalls;
                        }

                        console.log(`🔄 [Nested Mode] Synced Reps UI to backend value: ${message.nestedMode.maxGroupsShown}, API calls: ${message.nestedMode.estimatedApiCalls}`);
                    } else {
                        // Clear nested mode data if not in nested mode
                        csvState.nestedMode = null;
                    }
                }

                if (message.plan) {
                    renderStep4(message.plan);
                }

                // Log metadata if available
                if (message.metadata) {
                }
            } else if (message.mode === 'execute' && message.success) {
                // Handle batch creation completion (not execution)

                // Show success message to user with batch details
                const messageContainer = document.getElementById('csvModalMessageContainer');
                if (messageContainer) {
                    const batchInfo = message.batchId ? `<br><small>Batch ID: ${message.batchId}</small>` : '';
                    const transactionInfo = message.transactionCount ? `<br><small>Created ${message.transactionCount} transactions</small>` : '';

                    messageContainer.innerHTML = `
                        <div class="success-message">
                            ✅ ${message.message}
                            ${batchInfo}
                            ${transactionInfo}
                            <br>
                            <small>Use the execution webview to run this batch when ready.</small>
                        </div>
                    `;
                    messageContainer.classList.remove('hidden');
                }

                // Modal was already closed by startDataLoading function
            } else {
                // Fallback error
                const errorMessage = message.mode === 'execute' ? 'Failed to create bulk load batch' : 'Failed to generate JSON preview';
                displayJsonPreviewError(errorMessage);
            }
        }

        // Handle type transformation results
        if (message.type === 'typeTransformationCompleted') {
            handleTypeTransformationResult(message);
        }

        // Note: sortingAnalysisResult, fullCoercionResult, sampleCoercionResult, sortingExplanation
        // are handled via CSVHandler.handleMessage() which is called by the webview's inline script routing
    });

    // Enhanced Error Display Functions
    function showEnhancedCSVError(originalError, errorDetails, statistics) {
        if (!errorDetails || errorDetails.length === 0) {
            // Fallback to original error display
            showCSVVerificationError(originalError);
            return;
        }

        // Use statistics if available, otherwise calculate from error details
        const stats = statistics || {
            totalRows: 0,
            validatedRows: 0,
            errorCount: errorDetails.length,
            affectedRows: [...new Set(errorDetails.map(e => e.row))],
            errorsByColumn: {}
        };

        if (!statistics) {
            // Calculate column errors from error details
            errorDetails.forEach(error => {
                if (!stats.errorsByColumn[error.column]) {
                    stats.errorsByColumn[error.column] = 0;
                }
                stats.errorsByColumn[error.column]++;
            });
        }

        // Create enhanced error summary
        const columnSummaries = Object.keys(stats.errorsByColumn).map(column => {
            const errorCount = stats.errorsByColumn[column];
            const firstError = errorDetails.find(e => e.column === column);
            return `Column "${column}" (${firstError.expectedType} expected): ${errorCount} error${errorCount > 1 ? 's' : ''}`;
        });

        // The columns with errors, by name (the file itself is not shown on Source to highlight them in)
        const escapeText = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        let enhancedMessage = `Data Validation Issues Found
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 ${stats.errorCount} errors found in ${stats.affectedRows.length} rows
${columnSummaries.map(line => `• ${escapeText(line)}`).join('\n')}
<div class="validation-help">
    💡 <strong>To fix these issues:</strong> Update your source file to correct these data type errors, then upload the corrected file or select a different file.
</div>`;

        showCSVVerificationError(enhancedMessage);
    }

    /**
     * Populate processing mode dropdown based on environment configuration
     * GitHub Issue #78: Allow users to select processing mode at execution time
     */
    function populateProcessingModeDropdown(...args) {
        return window.DTBatchConfig.populateProcessingModeDropdown(...args);
    }

    /**
     * Handle processing mode dropdown change
     * GitHub Issue #78: Update UI and store selected mode
     */
    function onProcessingModeChange(...args) {
        return window.DTBatchConfig.onProcessingModeChange(...args);
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
            detailsSpan.textContent = '(one request at a time)';
        } else {
            detailsSpan.textContent = `(${selectedConcurrency} requests at the same time)`;
        }
    }

    /**
     * Get selected processing mode configuration
     * Returns the configuration to pass to execution
     */
    function getSelectedProcessingMode(...args) {
        return window.DTBatchConfig.getSelectedProcessingMode(...args);
    }

    /**
     * Show context menu for progress bar to change parallel processing mode
     * GitHub Issue #78: Allow switching processing mode during execution
     */
    function showProgressContextMenu(...args) {
        return window.DTBatchConfig.showProgressContextMenu(...args);
    }

    /**
     * Get current processing mode from dropdown or stored state
     */
    function getCurrentProcessingMode(...args) {
        return window.DTBatchConfig.getCurrentProcessingMode(...args);
    }

    /**
     * Change processing mode and update UI indicators
     */
    function changeProcessingMode(...args) {
        return window.DTBatchConfig.changeProcessingMode(...args);
    }

    /**
     * Update progress bar mode indicator
     */
    function updateProgressModeIndicator(...args) {
        return window.DTBatchConfig.updateProgressModeIndicator(...args);
    }

    // Expose functions to global scope for HTML event handlers
    window.updateVariableMapping = updateVariableMapping;
    window.populateProcessingModeDropdown = populateProcessingModeDropdown;
    window.showProgressContextMenu = showProgressContextMenu;
    window.changeProcessingMode = changeProcessingMode;

    // Make DataTransformer/CSVHandler methods available globally
    if (!window.CSVHandler) {
        window.CSVHandler = {};
    }
    window.CSVHandler.onProcessingModeChange = onProcessingModeChange;
    window.CSVHandler.getSelectedProcessingMode = getSelectedProcessingMode;

    // Alias: window.DataTransformer points to the same API as window.CSVHandler
    window.DataTransformer = window.CSVHandler;

    // #372: what Run Batch's markup may call (data-click / data-change / data-input / data-keydown);
    // the web app's CSP refuses inline handlers. Each looks the handler up when it runs, as the
    // inline `window.CSVHandler?.x()` did.
    const csv = name => (...args) => window.CSVHandler?.[name]?.(...args);
    const valueOf = (_arg, _event, element) => element.value;
    window.DbmnActions?.register({
        'csv:switchTab': tab => csv('switchTab')(tab),
        'csv:handleModalCSVUpload': (_arg, event) => csv('handleModalCSVUpload')(event),
        'csv:handleCSVDrop': (_arg, event) => csv('handleCSVDrop')(event),
        'csv:handleCSVDragOver': (_arg, event) => csv('handleCSVDragOver')(event),
        'csv:handleCSVDragLeave': (_arg, event) => csv('handleCSVDragLeave')(event),
        // The drop zone opens the file chooser, but not for a click on the sheet or hidden-rows
        // pickers drawn inside it: actions run before those pickers' own listeners (dbmn-actions.js)
        'csv:openComputerFileDialog': (_arg, event, element) => {
            if (element?.id === 'csvDropzone' && event?.target?.closest?.('.sheet-selector, .filter-choice-container')) return;
            csv('openComputerFileDialog')();
        },
        'csv:handlePasteAreaChange': () => csv('handlePasteAreaChange')(),
        'csv:cancelCoercionValidation': () => csv('cancelCoercionValidation')(),
        'csv:onArraySelectionChange': () => csv('onArraySelectionChange')(),
        'csv:onElementsInputChange': (...a) => csv('onElementsInputChange')(valueOf(...a)),
        'csv:onItemsPerRequestChange': () => csv('onItemsPerRequestChange')(),
        'csv:onCustomItemsChange': (...a) => csv('onCustomItemsChange')(valueOf(...a)),
        'csv:toggleEncodingPreview': () => csv('toggleEncodingPreview')(),
        'csv:explainRequests': () => csv('explainRequests')(),
        'csv:explainRequestsByKey': (_arg, event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            csv('explainRequests')();
        },
        'csv:updateBatchName': () => csv('updateBatchName')(),
        // Left empty: the default name comes back
        'csv:refreshBatchName': () => { if (window.DTBatchConfig) window.DTBatchConfig.refreshBatchName(); },
        'csv:onProcessingModeChange': () => csv('onProcessingModeChange')(),
        'csv:goToPreviousStep': () => csv('goToPreviousStep')(),
        'csv:enterDataMode': () => csv('enterDataMode')(),
        'csv:goToNextStep': () => csv('goToNextStep')(),
        'csv:startDataLoading': () => csv('startDataLoading')(),
        'csv:updateSelectedSheet': () => csv('updateSelectedSheet')(),
        // Slice 5 (#470): Validate's toolbar, in Results' style
        'grid:colsAll': () => window.DTDataEntryGrid?.setInvalidColsOnly(false),
        'grid:colsInvalid': () => window.DTDataEntryGrid?.setInvalidColsOnly(true),
        'grid:special': () => window.DTDataEntryGrid?.toggleGridSpecial(),
        'grid:clearFilters': () => window.DTDataEntryGrid?.clearGridFilters(),
        'grid:clearFileAndShowGrid': () => window.DTDataEntryGrid?.clearFileAndShowGrid(),
        'ingestion:setFilterChoice': choice => window.DTDataIngestion?.setFilterChoice(choice),
        'batchConfig:updateSelectedDelimiter': () => window.DTBatchConfig?.updateSelectedDelimiter(),
        'batchConfig:startFormatConversion': () => window.DTBatchConfig?.startFormatConversion(),
        changeProcessingMode: (mode, _event, element) => window.changeProcessingMode(mode, element.getAttribute('data-stage')),
        updateSourceTimezone: (...a) => window.updateSourceTimezone(valueOf(...a)),
        updateVariableMapping: (name, _event, element) => window.updateVariableMapping(name, element.value),
        updateSourceType: (name, _event, element) => {
            element.classList.toggle('format-none', element.value === 'passthrough');
            window.updateSourceType(name, element.value);
        }
    });
})();