// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's help map for help mode (shared/help-mode.js): which control documents where.
 * Step headings carry data-help in the markup; this covers the controls inside the steps.
 */
(function () {
    'use strict';
    if (!window.HelpMode) return;
    window.HelpMode.register([
        // Step 1 — Load Data
        { selector: '#csvDropzone', help: 'batch-preparation#upload-file' },
        { selector: '#csvPasteArea', help: 'batch-preparation#paste-text' },
        // Step 2 — Map & Transform
        { selector: '#columnMappingTable', help: 'batch-preparation#step-2-map-transform' },
        { selector: '#updateTemplateOption', help: 'batch-preparation#remember-mapping' },
        // Step 3 — Review & Edit Data
        { selector: '#gridEntryContainer, #gridErrorFilterBtn', help: 'batch-preparation#step-3-review-edit-data' },
        // Step 4 — Review & Configure
        { selector: '#repsControlGroup, #arraySelectGroup, #queryItemsGroup, #repeatedArrayGroup', help: 'batch-preparation#batch-configuration' },
        { selector: '#groupedByGroup', help: 'batch-preparation#nested-grouping' },
        { selector: '#explainRequestsBtn', help: 'batch-preparation#nested-grouping' },
        { selector: '#requestPreviewShow', help: 'batch-preparation#step-4-review-json' },
        { selector: '#requestPreviewList .raw-card-header', help: 'batch-preparation#step-4-review-json', first: true },
        // Step 4 — the run's own settings, and Execute (#435: there is no Step 5)
        { selector: '#batchNameInput', help: 'batch-preparation#batch-name' },
        { selector: '#batchErrorModeSelect', help: 'batch-preparation#error-handling' },
        { selector: '#processingModeDropdown', help: 'batch-preparation#processing-mode' },
        { selector: '#csvExecuteBtn', help: 'batch-preparation#execute' },
        // Every step
        { selector: '#csvNextBtn, #csvBackBtn', help: 'batch-preparation#overview' }
    ]);
})();
