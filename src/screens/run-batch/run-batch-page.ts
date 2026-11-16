// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Run Batch's page (moved from RunBatchWebview.getHtmlContent, #343). Any host: `asset` maps a
 * path under src/webviews to a URL.
 */
import type { AssetUrl } from '../pages';

/** For a value placed inside a double-quoted HTML attribute. */
function escapeAttribute(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A value in a double-quoted attribute. */
const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildRunBatchPage(asset: AssetUrl, batchConfig: { endpointId: string; endpointName: string }): string {

        // Get data transformer module scripts (must load BEFORE orchestrator)
        const dtDataEntryGridUri = asset('shared/dt-data-entry-grid.js');
        const dtTypeCoercionUri = asset('shared/dt-type-coercion.js');
        const dtDataIngestionUri = asset('shared/dt-data-ingestion.js');
        const dtDataPreviewUri = asset('shared/dt-data-preview.js');
        const dtMismatchRepairUri = asset('shared/dt-mismatch-repair.js');
        const dtBatchConfigUri = asset('shared/dt-batch-config.js');
        const dtAutoAdvanceUri = asset('shared/dt-auto-advance.js');   // GitHub Issue #247
        const chainPreloadUri = asset('run-batch/chain-preload.js');    // GitHub Issue #247
        const csvHandlerScriptUri = asset('shared/data-transformer.js');
        const csvHandlerCssUri = asset('shared/data-transformer.css');
        const formManagerScriptUri = asset('endpoint/modules/form-manager.js');

        // Get shared utility scripts
        const jsonCommentStripperUri = asset('shared/json-comment-stripper.js');
        const jsoncParserUri = asset('shared/jsonc-parser.js');
        const queryParamBuilderUri = asset('shared/query-param-builder.js');
        const documentationHelpersUri = asset('shared/documentation-helpers.js');
        const monacoThemeUri = asset('shared/monaco-theme.js');
        const iconsUri = asset('shared/icons.js');
        const editorWindowControlsUri = asset('shared/editor-window-controls.js');
        const dbmnModalUri = asset('shared/dbmn-modal.js');
        const rowPasteUri = asset('shared/row-paste.js');
        const templateRenameUri = asset('shared/template-rename.js');
        const batchExplainerUri = asset('shared/batch-explainer.js');
        const requestPreviewUri = asset('shared/request-preview.js');
        const transactionCardCssUri = asset('shared/transaction-card.css');
        // #268: the data-transformer's notifications now route through DbmnToast
        const dbmnToastUri = asset('shared/dbmn-toast.js');
        const dbmnClipboardUri = asset('shared/dbmn-clipboard.js');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Run Batch: ${batchConfig.endpointName}</title>
    <link rel="stylesheet" href="${asset('shared/atomic.css')}">
    <link rel="stylesheet" href="${asset('shared/core.css')}">
    <link rel="stylesheet" href="${asset('shared/modals.css')}">
    <link rel="stylesheet" href="${asset('shared/tables.css')}">
    <link rel="stylesheet" href="${transactionCardCssUri}">
    <link rel="stylesheet" href="${asset('shared/tabs.css')}">
    <link rel="stylesheet" href="${asset('shared/toast.css')}">
    <link rel="stylesheet" href="${csvHandlerCssUri}">
</head>
<body class="editor-slide-in" data-endpoint-id="${batchConfig.endpointId}" data-endpoint-name="${escapeAttribute(batchConfig.endpointName || '')}">
    <!-- Readable buttons in every theme (shared/button-contrast.js): first in the body, so it applies before anything is painted -->
    <script src="${asset('shared/button-contrast.js')}"></script>
    <script src="${asset('shared/dbmn-actions.js')}"></script>
    <div class="editor-window-controls">
        <button type="button" class="editor-window-btn icon" data-window-action="maximize" data-icon="maximize-2" title="Maximise" aria-label="Maximise"></button>
        <button type="button" class="editor-window-btn icon" data-window-action="close" data-icon="x" title="Close" aria-label="Close"></button>
    </div>
    <!-- No in-page H1: the tab name already shows "Run Batch: <endpoint>", and a pinned
         heading wasted permanent vertical space (worse on small screens). Each step keeps
         its own H2 ("Step N: …") inside the scrollable area. -->

    <!-- CSV Handler UI embedded directly (not as modal) -->
    <div id="csvBatchContainer">
        <!-- GitHub Issue #202: Step 1 — Load Data (file/paste tabs only) -->
        <div id="csvUploadStep" class="csv-step">
            <!-- Hidden file input for dropzone click -->
            <input type="file" id="csvModalFileInput" accept=".csv,.xlsx,.xls,.tsv,.txt"
                data-change="csv:handleModalCSVUpload" class="hidden" />

            <!-- GitHub Issue #202: Tabbed file/paste interface -->
            <div class="data-input-container">
                <div class="webview-tabs" id="data-input-tabs">
                    <div class="tab-item active" data-tab="file" data-help="batch-preparation#upload-file" data-click="csv:switchTab" data-arg="file">
                        <span class="tab-label">Upload File</span>
                        <span class="tab-data-indicator" id="tabIndicatorFile"></span>
                    </div>
                    <div class="tab-item" data-tab="paste" data-help="batch-preparation#paste-text" data-click="csv:switchTab" data-arg="paste">
                        <span class="tab-label">Paste Text</span>
                        <span class="tab-data-indicator" id="tabIndicatorPaste"></span>
                    </div>
                </div>

                <div class="tab-content">
                    <!-- File upload panel with dropzone -->
                    <div class="tab-panel" id="tabPanelFile">
                        <div class="csv-dropzone csv-dropzone-clickable" id="csvDropzone"
                            data-click="csv:openComputerFileDialog"
                            data-drop="csv:handleCSVDrop"
                            data-dragover="csv:handleCSVDragOver"
                            data-dragleave="csv:handleCSVDragLeave">
                            <div class="dropzone-content">
                                <div class="dropzone-icon">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M12 16V8M12 8L9 11M12 8L15 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M3 15V16C3 18.2091 4.79086 20 7 20H17C19.2091 20 21 18.2091 21 16V15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                                <p class="dropzone-text">Drag &amp; drop a file here, or click to browse</p>
                                <p class="dropzone-hint">Supports CSV, Excel (.xlsx, .xls), TSV, and TXT files</p>
                                <p class="dropzone-hint dropzone-hint-locked">Open in Excel? <strong>Drag it in</strong> — Windows won't let the browse dialog pick a file that's in use.</p>
                            </div>
                        </div>
                    </div>

                    <!-- Paste panel -->
                    <div class="tab-panel hidden" id="tabPanelPaste">
                        <textarea id="csvPasteArea" rows="8" placeholder="Paste CSV or tab-delimited data here (e.g., from Excel)..." data-input="csv:handlePasteAreaChange"></textarea>
                        <p class="paste-hint">Tip: You can paste tab-delimited data copied from Excel - it will be automatically converted.</p>
                    </div>
                </div>
            </div>

            <div id="csvUploadError" class="error-message hidden"></div>

            <!-- GitHub Issue #226: Mount point for the column-mismatch repair panel.
                 Hidden by default; populated by DTMismatchRepair when bad rows are detected. -->
            <div id="csvMismatchRepairContainer" class="hidden"></div>
        </div>

        <!-- GitHub Issue #135: Combined Map & Transform Section (was Steps 2 & 3) -->
        <div id="csvMappingStep" class="csv-step hidden">
            <!-- GitHub Issue #162: Removed mapping status text - now redundant with Status column -->
            <div id="mappingErrors" class="hidden mt-15 p-12 border border-radius-4 bg-input"></div>
            <!-- Enhanced mapping table with coercion preview (GitHub Issue #135) -->
            <div id="columnMappingTable" class="mapping-table enhanced-mapping"></div>
            <!-- GitHub Issue #307: shown once a variable is mapped to a column with a different name -->
            <div id="updateTemplateOption" class="update-template-option hidden">
                <label class="update-template-toggle">
                    <input type="checkbox" id="updateTemplateCheckbox"> Update Endpoint Template
                </label>
                <p class="update-template-detail">After this batch runs, rename <span id="updateTemplateRenames"></span> in the template, so a file with these columns maps itself.</p>
            </div>
            <!-- Coercion validation progress modal -->
            <div id="coercionValidationProgress" class="validation-progress-modal hidden">
                <div class="validation-progress-content">
                    <h3>Validating data...</h3>
                    <div class="progress-bar-container">
                        <div id="coercionProgressBar" class="progress-bar" style="width: 0%"></div>
                    </div>
                    <p id="coercionProgressText">0% (0/0)</p>
                    <p id="coercionErrorCount" class="error-count hidden">Errors found: 0</p>
                    <button id="coercionCancelBtn" class="btn btn-secondary" data-click="csv:cancelCoercionValidation">Cancel</button>
                </div>
            </div>
        </div>

        <!-- GitHub Issue #202: Step 3 — Review & Edit Data (NEW) -->
        <div id="csvDataValidationStep" class="csv-step hidden">
            <div class="grid-entry-container" id="gridEntryContainer">
                <div id="csvGridEntry" class="csv-grid-entry"></div>
                <p class="grid-hint">Review your data below. Edit cells, add or delete rows, and fix any highlighted validation errors before proceeding.</p>
            </div>
        </div>

        <!-- JSON Preview Section (GitHub Issue #202: now Step 4) -->
        <div id="csvJsonPreviewStep" class="csv-step hidden">
            <!-- GitHub Issue #308: one Step 4 for every endpoint — body, URL parameters or both.
                 Configure and Requests use the Console Settings cards (tables.css .table-stats);
                 the first requests use the Raw tab's card (transaction-card.css). Everything is
                 filled from the batch plan (data-loading/batch-plan.ts) by renderStep4. -->
            <!-- #435: Configure and Summary in a column on the left; the samples beside them get the
                 rest of the width and all of the height. -->
            <div class="review-layout">
            <div class="review-sections">
                <div class="execution-section" id="reviewConfigureSection">
                    <h3>Configure</h3>
                    <!-- Changing a setting rebuilds the samples below by itself (schedulePreviewRebuild) -->
                    <div class="table-stats">
                        <!-- GitHub Issue #354: what starts a new request, for grouped and nested templates.
                             The ⓘ that explains it moves here from API calls (renderStep4). -->
                        <div class="stat-item hidden" id="groupedByGroup">
                            <span class="stat-label" id="groupedByLabel">Grouped by</span>
                            <span id="groupedByDisplay">-</span>
                        </div>
                        <!-- GitHub Issue #354: the array rows are packed into, when there is no picker to say so -->
                        <div class="stat-item hidden" id="repeatedArrayGroup">
                            <span class="stat-label">Array</span>
                            <span id="repeatedArrayDisplay">-</span>
                        </div>
                        <!-- Only when the template has two or more arrays that could repeat -->
                        <div class="stat-item hidden" id="arraySelectGroup">
                            <span class="stat-label">Array</span>
                            <select id="arrayRepetitionSelect" class="p-6 bg-input border border-radius-3 font-size-13" data-change="csv:onArraySelectionChange">
                                <option value="">No arrays detected</option>
                            </select>
                        </div>
                        <div class="stat-item hidden" id="repsControlGroup">
                            <span class="stat-label" id="repsLabel">Rows per request</span>
                            <input type="number" id="elementsInput" min="1" max="1000" value="1"
                                   class="w-80 p-6 bg-input border border-radius-3 text-center font-size-13"
                                   data-input="csv:onElementsInputChange">
                        </div>
                        <!-- URL query-parameter batches (GitHub Issue #108) -->
                        <div class="stat-item hidden" id="queryItemsGroup">
                            <span class="stat-label">Values per URL</span>
                            <div class="flex align-center gap-8 stat-control">
                                <select id="itemsPerRequestSelect" class="p-6 bg-input border border-radius-3 font-size-13" data-change="csv:onItemsPerRequestChange">
                                    <option value="auto">Auto (fit the URL)</option>
                                    <option value="25">25</option>
                                    <option value="50">50</option>
                                    <option value="75">75</option>
                                    <option value="100">100</option>
                                    <option value="custom">Custom…</option>
                                </select>
                                <div id="customItemsContainer" class="hidden">
                                    <input type="number" id="customItemsInput" min="1" max="1000" value="50"
                                           class="w-80 p-6 bg-input border border-radius-3 text-center font-size-13"
                                           data-input="csv:onCustomItemsChange">
                                </div>
                            </div>
                        </div>
                        <!-- GitHub Issue #127: BASE64 fields — show the body as sent, or unencoded -->
                        <div class="stat-item hidden" id="encodingToggleButtonContainer">
                            <span class="stat-label">Body</span>
                            <button id="encodingToggleBtn" type="button" data-click="csv:toggleEncodingPreview" class="btn btn-secondary font-size-12 p-6 px-12"><span id="encodingToggleLabel">Show unencoded</span></button>
                        </div>
                        <!-- #435: the run's own settings, here since Review is the last step (Execute is the footer's button) -->
                        <div class="stat-item is-stacked">
                            <label class="stat-label" for="batchNameInput">Name</label>
                            <input type="text" id="batchNameInput" placeholder="Batch name" maxlength="100" data-input="csv:updateBatchName">
                        </div>
                        <div class="stat-item is-stacked">
                            <label class="stat-label" for="batchErrorModeSelect">Error Handling</label>
                            <select id="batchErrorModeSelect">
                                <option value="continue">Continue processing</option>
                                <option value="stopOnFirst">Stop on first error</option>
                            </select>
                        </div>
                        <div class="stat-item is-stacked">
                            <label class="stat-label" for="processingModeDropdown">Processing Mode</label>
                            <select id="processingModeDropdown" data-change="csv:onProcessingModeChange">
                                <option value="1">Sequential (Safest)</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="execution-section">
                    <h3>Summary</h3>
                    <div class="table-stats">
                        <div class="stat-item">
                            <span class="stat-label" id="apiCallsLabel">API calls
                                <span id="explainRequestsBtn" class="help-icon" role="button" tabindex="0" data-click="csv:explainRequests" data-keydown="csv:explainRequestsByKey" title="How your rows become API requests" aria-label="How your rows become API requests"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></span>
                            </span>
                            <span id="totalApiCallsDisplay">-</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Rows</span>
                            <span id="batchRowsDisplay">-</span>
                        </div>
                        <div class="stat-item" title="First request size only">
                            <span class="stat-label">Size</span>
                            <span id="requestFileSizeDisplay">-</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Source</span>
                            <span id="executionSource" class="stat-value-cut">-</span>
                        </div>
                    </div>
                </div>

                <!-- Where the rows go, beside Execute -->
                <div class="execution-section">
                    <h3>Sending To</h3>
                    <div class="table-stats">
                        <div class="stat-item">
                            <span class="stat-label">Environment</span>
                            <span id="executionEnvironment" class="stat-value-cut">Loading...</span>
                        </div>
                        <!-- #424: one stat per variable the environment's header shows (data-transformer.js) -->
                        <div class="stat-item is-stacked">
                            <span class="stat-label">Endpoint</span>
                            <span id="executionFullUrl" class="font-mono stat-value-wrap">Loading...</span>
                        </div>
                    </div>
                    <div class="execution-warning hidden" id="executionWarning">
                        <strong>Warning:</strong> this is a production environment.
                    </div>
                </div>
            </div>

            <div class="execution-section review-requests">
                <div class="flex align-center justify-between gap-12 flex-wrap">
                    <!-- "Requests", or "Request samples" when the batch has more than it shows (renderStep4) -->
                    <h3 id="requestPreviewTitle">Requests</h3>
                    <!-- The Raw tab's Show chips: Input / Request on every card at once -->
                    <div class="raw-show-group" role="group" aria-label="Show" id="requestPreviewShow">
                        <span class="raw-show-label">Show</span>
                        <button type="button" class="raw-show-chip" data-show="input" aria-pressed="true" title="Show the input rows behind each request">Input</button>
                        <button type="button" class="raw-show-chip" data-show="request" aria-pressed="true" title="Show each request">Request</button>
                    </div>
                </div>
                <div id="requestPreviewList" class="request-preview-list">
                    <div class="raw-compact-view">Building the preview…</div>
                </div>
            </div>
            </div>
        </div>

        <!-- Sticky Footer with Action Buttons -->
        <div class="webview-footer">
            <div class="footer-content">
                <div class="footer-button-container">
                    <button id="csvBackBtn" data-click="csv:goToPreviousStep" class="btn btn-secondary hidden">Back</button>
                    <button id="csvEnterDataBtn" data-click="csv:enterDataMode" class="btn btn-secondary" data-help="batch-preparation#enter-data">Enter Data</button>
                    <button id="gridErrorFilterBtn" data-click="grid:toggleErrorFilter" class="btn btn-secondary hidden" disabled>Filter Errors</button>
                    <button id="csvNextBtn" data-click="csv:goToNextStep" class="btn btn-primary" disabled>Import Data</button>
                    <button id="csvExecuteBtn" data-click="csv:startDataLoading" class="btn btn-primary hidden">Execute</button>
                </div>
                <!-- Step bar (batch-stepper.js): Source, Map, Validate, Review. #435: in the footer
                     beside Back and Next, so the top of the screen is the step's own. Reading a file
                     and checking rows show their progress in the current step (no panel of its
                     own, which pushed the steps about as it came and went). -->
                <nav id="batchStepper" class="batch-stepper" aria-label="Run Batch steps"></nav>
                <!-- #268: the notification banner that lived here is gone; these
                     notifications now render through the shared DbmnToast overlay -->
            </div>
        </div>
    </div>

    <!-- Monaco Editor -->
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
    <script src="${asset('shared/monaco-loader-config.js')}"></script>
    <script src="${asset('shared/monaco-preload.js')}"></script>

    <!-- Zod validation disabled - using backend validation only -->
    <script src="${monacoThemeUri}"></script>
    <script src="${jsonCommentStripperUri}"></script>
    <script src="${jsoncParserUri}"></script>
    <script src="${queryParamBuilderUri}"></script>
    <script src="${documentationHelpersUri}"></script>
    <script src="${asset('shared/help-mode.js')}"></script>
    <script src="${asset('run-batch/run-batch-help.js')}"></script>
    <script src="${formManagerScriptUri}"></script>
    <script src="${dtDataEntryGridUri}"></script>
    <script src="${dtTypeCoercionUri}"></script>
    <script src="${dtDataIngestionUri}"></script>
    <script src="${dtDataPreviewUri}"></script>
    <script src="${dtMismatchRepairUri}"></script>
    <script src="${dtBatchConfigUri}"></script>
    <script src="${dtAutoAdvanceUri}"></script>
    <script src="${asset('shared/step-bar.js')}"></script>
    <script src="${asset('run-batch/batch-stepper.js')}"></script>
    <script src="${chainPreloadUri}"></script>
    <script src="${rowPasteUri}"></script>
    <script src="${templateRenameUri}"></script>
    <script src="${batchExplainerUri}"></script>
    <script src="${requestPreviewUri}"></script>
    <script src="${dbmnModalUri}"></script>
    <script src="${dbmnToastUri}"></script>
    <script src="${dbmnClipboardUri}"></script>
    <script src="${csvHandlerScriptUri}"></script>
    <script src="${iconsUri}"></script>
    <script src="${editorWindowControlsUri}"></script>

    <script src="${asset('run-batch/run-batch-page.js')}" data-endpoint-id="${attr(batchConfig.endpointId)}"></script>
</body>
</html>`;
}
