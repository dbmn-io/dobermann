// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Form Manager Module
 * Handles form state, validation, change tracking, and data collection
 */
(function() {
    // Get vscode API from window (set by bridge)
    const getVscode = () => window.vscode;
    // Module state
    const formState = {
        hasUnsavedChanges: false,
        initialStateJSON: '',
        isNewEndpoint: false,
        currentEndpointId: document.body.getAttribute('data-endpoint-id'),
        currentEndpointData: null
    };
    
    // Initialize isNewEndpoint based on currentEndpointId
    formState.isNewEndpoint = !formState.currentEndpointId || 
                               formState.currentEndpointId === '' || 
                               formState.currentEndpointId === 'NEW';

    // Initialize form tracking
    function setupFormChangeTracking() {
        // Listen for changes on all form inputs
        const formElements = document.querySelectorAll(
            'input[type="text"], input[type="checkbox"], input[type="radio"], textarea, select'
        );
        
        formElements.forEach(element => {
            // Skip certain elements that shouldn't trigger change tracking
            if (element.id === 'csvFileInput' || 
                element.id === 'modalCsvFile' ||
                element.classList.contains('no-track')) {
                return;
            }
            
            element.addEventListener('change', () => {
                checkForChanges();
            });
            
            // For text inputs, also listen to input event for real-time tracking
            if (element.type === 'text' || element.tagName === 'TEXTAREA') {
                element.addEventListener('input', () => {
                    checkForChanges();
                });
            }
        });
        
        // Capture initial state after a short delay to ensure everything is loaded
        setTimeout(captureInitialFormState, 100);
    }

    // Capture the initial form state for comparison
    function captureInitialFormState() {
        const currentData = collectCurrentEndpointData();
        formState.initialStateJSON = JSON.stringify(currentData);
        formState.hasUnsavedChanges = false;
        updateTitle();
    }

    // Check if form has changes
    function checkForChanges() {
        const currentData = collectCurrentEndpointData();
        const currentStateJSON = JSON.stringify(currentData);
        
        formState.hasUnsavedChanges = currentStateJSON !== formState.initialStateJSON;
        updateTitle();
        updateButtonStates();
    }

    // Update the title to show unsaved changes
    function updateTitle() {
        const title = document.querySelector('h2');
        if (title) {
            const baseTitle = formState.isNewEndpoint ? 'New Endpoint' : 'Edit Endpoint';
            title.textContent = formState.hasUnsavedChanges ? `${baseTitle} *` : baseTitle;
        }
    }

    // Reset change tracking after save
    function resetChangeTracking() {
        captureInitialFormState();
        formState.hasUnsavedChanges = false;
        updateTitle();
    }

    // Collect all form data
    function collectCurrentEndpointData() {
        const nameInput = document.getElementById('endpointName');
        const descriptionInput = document.getElementById('endpointDescription');
        const pathInput = document.getElementById('endpointPath');
        const methodSelect = document.getElementById('endpointMethod');
        const bodyTextarea = window.monacoEditor ? 
            window.monacoEditor.getValue() : 
            (window.pendingBodyContent || '');

        const headers = collectCustomHeaders();

        const queryParams = collectQueryParams();
        const testScript = collectSingleTestScript();
        const dataLoadingConfig = collectDataLoadingConfig(bodyTextarea);

        return {
            id: formState.currentEndpointId || generateTemporaryId(),
            name: nameInput ? nameInput.value : '',
            description: descriptionInput ? descriptionInput.value : '',
            path: pathInput ? pathInput.value : '',
            method: methodSelect ? methodSelect.value : 'GET',
            headers: headers,
            queryParams: queryParams,
            body: bodyTextarea,
            testScript: testScript,
            dataLoadingConfig: dataLoadingConfig,
            folder: formState.currentEndpointFolder || undefined
        };
    }

    // Collect the endpoint's own headers
    function collectCustomHeaders() {
        const headers = {};
        const headerRows = document.querySelectorAll('#customHeadersContainer .header-row');
        
        headerRows.forEach(row => {
            const keyInput = row.querySelector('.header-key');
            const valueInput = row.querySelector('.header-value');
            const enabledCheckbox = row.querySelector('.header-enabled');
            
            if (keyInput && valueInput) {
                const key = keyInput.value.trim();
                const value = valueInput.value.trim();
                
                if (key) {
                    headers[key] = {
                        value: value,
                        enabled: enabledCheckbox ? enabledCheckbox.checked : true
                    };
                }
            }
        });
        
        return headers;
    }

    // Collect query parameters
    function collectQueryParams() {
        const params = {};
        const paramRows = document.querySelectorAll('#queryParamsContainer .param-row');
        
        paramRows.forEach(row => {
            const keyInput = row.querySelector('.param-key');
            const valueInput = row.querySelector('.param-value');
            
            if (keyInput && valueInput) {
                const key = keyInput.value.trim();
                const value = valueInput.value.trim();
                
                if (key) {
                    params[key] = value;
                }
            }
        });
        
        return params;
    }

    // Collect single test script
    function collectSingleTestScript() {
        const testScriptTextarea = document.getElementById('singleTestScript');
        return testScriptTextarea ? testScriptTextarea.value.trim() : '';
    }

    // Collect data loading configuration
    function collectDataLoadingConfig(bodyTextarea) {
        const methodSelect = document.getElementById('endpointMethod');
        const method = methodSelect ? methodSelect.value : 'GET';
        
        // Only collect for POST/PUT/PATCH methods
        if (!['POST', 'PUT', 'PATCH'].includes(method)) {
            return undefined;
        }

        // Check if data loading section exists and is visible
        const dataLoadingSection = document.getElementById('dataLoadingConfig');
        if (!dataLoadingSection || dataLoadingSection.style.display === 'none') {
            return undefined;
        }

        // Collect template variables
        const variables = [];
        const variableRows = document.querySelectorAll('.template-variable');
        variableRows.forEach(row => {
            const name = row.querySelector('.variable-name')?.textContent;
            const dataType = row.querySelector('.variable-type')?.value || 'string';
            if (name) {
                variables.push({ name, dataType });
            }
        });

        // Collect repeatable arrays
        const repeatableArrays = {};
        const arrayCheckboxes = document.querySelectorAll('.array-repeat-checkbox:checked');
        arrayCheckboxes.forEach(checkbox => {
            const arrayPath = checkbox.getAttribute('data-array-path');
            const maxInput = checkbox.parentElement.querySelector('.max-repetitions-input');
            if (arrayPath && maxInput) {
                repeatableArrays[arrayPath] = {
                    maxRepetitions: parseInt(maxInput.value) || 10
                };
            }
        });

        // Collect error tolerance settings
        const errorToleranceEnabled = document.getElementById('errorToleranceEnabled')?.checked || false;
        let errorTolerance = { mode: 'strict' };
        
        if (errorToleranceEnabled) {
            const absoluteRadio = document.getElementById('errorModeAbsolute');
            const percentageRadio = document.getElementById('errorModePercentage');
            
            if (absoluteRadio?.checked) {
                const limit = parseInt(document.getElementById('errorLimitAbsolute')?.value) || 0;
                errorTolerance = { mode: 'absolute', limit };
            } else if (percentageRadio?.checked) {
                const limit = parseInt(document.getElementById('errorLimitPercentage')?.value) || 0;
                errorTolerance = { mode: 'percentage', limit };
            }
        }

        return {
            jsonTemplate: bodyTextarea,
            detectArrays: true,
            repeatableArrays: Object.keys(repeatableArrays).length > 0 ? repeatableArrays : [],
            variables,
            errorHandling: {
                mode: errorTolerance.mode === 'strict' ? 'stopOnFirst' : 'continue',
                enableErrorTolerance: errorTolerance.mode !== 'strict',
                toleranceMode: errorTolerance.mode === 'percentage' ? 'percentage' : 'absolute',
                absoluteErrorLimit: errorTolerance.mode === 'absolute' ? Math.max(errorTolerance.limit || 1, 1) : 1,
                percentageErrorLimit: errorTolerance.mode === 'percentage' ? Math.max(errorTolerance.limit || 1, 1) : 1,
                retryConfig: {
                    maxAttempts: 3,
                    delaySeconds: 1,
                    retryConditions: {
                        networkErrors: true,
                        serverErrors: true,
                        rateLimiting: false,
                        clientErrors: false
                    }
                }
            },
            dataValidation: {
                enforceDataTypes: document.getElementById('enforceDataTypes')?.checked || false,
                variableDataTypes: {}
            }
        };
    }

    // Validate form data
    function validateEndpointData() {
        const errors = [];
        
        const nameInput = document.getElementById('endpointName');
        const pathInput = document.getElementById('endpointPath');
        
        if (!nameInput || !nameInput.value.trim()) {
            errors.push('Endpoint name is required');
        }
        
        if (!pathInput || !pathInput.value.trim()) {
            errors.push('Endpoint path is required');
        } else if (!pathInput.value.startsWith('/')) {
            errors.push('Endpoint path must start with /');
        }
        
        return errors;
    }

    // Save endpoint
    function saveEndpoint() {
        // Validate first
        const errors = validateEndpointData();
        if (errors.length > 0) {
            getVscode().postMessage({
                type: 'showError',
                message: errors.join('\n')
            });
            return;
        }

        const endpointData = collectCurrentEndpointData();
        
        getVscode().postMessage({
            type: 'saveEndpoint',
            endpoint: endpointData
        });
    }

    // Handle endpoint saved
    function handleEndpointSaved(endpoint) {
        // Update state
        formState.currentEndpointId = endpoint.id;
        formState.currentEndpointData = endpoint;
        formState.isNewEndpoint = false;
        
        // Update UI
        document.body.setAttribute('data-endpoint-id', endpoint.id);
        
        // Reset change tracking
        resetChangeTracking();
        
        // Show success message
        getVscode().postMessage({
            type: 'showInfo',
            message: 'Endpoint saved successfully'
        });
    }

    // Generate temporary ID for new endpoints
    function generateTemporaryId() {
        return 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // Update button states based on form state
    function updateButtonStates() {
        const saveBtn = document.getElementById('saveEndpointBtn');
        if (saveBtn) {
            saveBtn.disabled = !formState.hasUnsavedChanges;
        }
    }

    // Public API
    window.FormManager = {
        // Setup
        setupFormChangeTracking,
        
        // State management
        captureInitialFormState,
        checkForChanges,
        resetChangeTracking,
        
        // Data collection
        collectCurrentEndpointData,
        collectCustomHeaders,
        collectQueryParams,
        collectSingleTestScript,
        collectDataLoadingConfig: (body) => collectDataLoadingConfig(body),
        
        // Validation
        validateEndpointData,
        
        // Actions
        saveEndpoint,
        handleEndpointSaved,
        
        // UI updates
        updateTitle,
        updateButtonStates,
        
        // Utilities
        generateTemporaryId,
        
        // State access
        getState: () => formState,
        setState: (updates) => Object.assign(formState, updates),
        hasUnsavedChanges: () => formState.hasUnsavedChanges
    };
})();