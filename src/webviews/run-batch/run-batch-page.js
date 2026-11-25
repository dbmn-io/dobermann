// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Run Batch's page script (run-batch-page.ts builds the page): the host bridge, the endpoint id,
 * and the routing of host messages to the CSV handler. A file, not inline script, so the web app's
 * Content Security Policy (#372) lets it run; the endpoint id rides on its script tag. */
(function() {
    const vscode = acquireVsCodeApi();
    window.vscode = vscode;

    // The endpoint this Run Batch is for, from this script's own tag (run-batch-page.ts)
    const tag = document.currentScript;
    const endpointId = tag ? tag.getAttribute('data-endpoint-id') || '' : '';

    // Set current endpoint ID globally for CSV handler
    window.currentEndpointId = endpointId;

    // Initialize CSV handler state with endpoint ID (GitHub Issue #106)
    // NOTE: Must be done AFTER data-transformer.js loads but BEFORE page load event
    if (window.CSVHandler && window.CSVHandler.csvState) {
        window.CSVHandler.csvState.endpointId = endpointId;
    } else {
        console.warn('[RunBatch] CSV Handler not available yet - will retry on page load');
    }

    // Wait for page load
    window.addEventListener('load', () => {
        // Ensure endpoint ID is set (in case CSV handler loaded late)
        if (window.CSVHandler && window.CSVHandler.csvState && !window.CSVHandler.csvState.endpointId) {
            window.CSVHandler.csvState.endpointId = endpointId;
        }

        // Hydrate icon placeholders + wire min/max/close cluster — same
        // pattern as the endpoint / environment / console webviews.
        if (window.EditorWindowControls) window.EditorWindowControls.wire(vscode);

        // Initialize help icons
        if (window.initializeAllHelpIcons) {
            window.initializeAllHelpIcons();
        }

        // Request endpoint configuration
        vscode.postMessage({ type: 'requestEndpointConfig' });
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
        const message = event.data;

        switch(message.type) {
            case 'endpointConfigLoaded':
                // Store endpoint config globally for CSV handler
                window.currentEndpointConfig = message.endpoint;
                // GitHub Issue #129: Initialize grid with template variables
                if (window.CSVHandler?.initializeDataEntryGrid) {
                    window.CSVHandler.initializeDataEntryGrid(message.endpoint);
                }
                break;

            // GitHub Issue #247: rows chained from a Console
            case 'chainPreload':
                if (window.ChainPreload) window.ChainPreload.apply(message);
                break;

            case 'batchExecutionStarted':
                vscode.postMessage({
                    type: 'showSuccessMessage',
                    message: message.message || 'Batch execution started successfully!'
                });
                vscode.postMessage({ type: 'closeWebview' });
                break;

            case 'batchExecutionError':
                alert('Batch execution failed: ' + message.error);
                break;

            case 'sectionContentLoaded':
                console.log('[RunBatch] Received sectionContentLoaded message:', message.title);
                if (window.renderDocumentationModal) {
                    console.log('[RunBatch] Calling renderDocumentationModal');
                    window.renderDocumentationModal(
                        message.title,
                        message.html,
                        message.docPath,
                        message.section
                    );
                } else {
                    console.error('[RunBatch] renderDocumentationModal not available');
                }
                break;

            // `lu` in the template: the lookup tables it names, for Validate to check against
            // (its own case, before the run of cases below that all go to the CSV handler)
            case 'templateLookups':
                if (window.DTDataEntryGrid && window.DTDataEntryGrid.setLookupTables) window.DTDataEntryGrid.setLookupTables(message.tables || []);
                break;

            // Route CSV handler messages
            case 'formatDetected':
            case 'formatConversionComplete':
            case 'formatConversionError':
            case 'excelSheetArraysResult':
            case 'excelSheetArraysError':
            case 'csvModalParsed':
            case 'csvCompatibilityVerified':
            case 'csvCompatibilityError':
            case 'csvVerified':
            case 'jsonPreviewGenerated':
            case 'bulkJsonGenerated':
            case 'bulkLoadCommandExecuted':
            case 'currentEnvironmentData':
            case 'workspaceValidated':
            case 'endpointTemplate':
            case 'typeTransformationCompleted':
            case 'typeTransformationsError':
            case 'endpointSaved':
            case 'endpointSaveError':
            // Map's functions (map-functions.ts): the list, and a column's steps on its first rows
            case 'map.functionsList':
            case 'map.functionsSample':
            case 'map.translated':
            // GitHub Issue #135: Coercion validation results
            case 'sampleCoercionResult':
            case 'fullCoercionResult':
            // GitHub Issue #148: CSV sorting for nested arrays
            case 'sortingAnalysisResult':
            case 'sortingExplanation':
                if (window.CSVHandler && window.CSVHandler.handleMessage) {
                    window.CSVHandler.handleMessage(message);
                } else {
                    console.error('[RunBatch] CSV Handler not available yet');
                }
                break;

            default:
                break;
        }
    });

})();
