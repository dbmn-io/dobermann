// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Data Transformer Module: Data Ingestion
 * GitHub Issue #195: Extracted from data-transformer.js
 *
 * Contains file upload and format handling:
 * - File processing progress display
 * - Multi-format file processing (CSV, Excel, TSV)
 * - Drag/drop file handling
 * - Format detection and conversion handlers
 * - CSV modal parsing callbacks
 */
(function () {
    'use strict';

    // Module-level references (set via init)
    let csvState = null;
    let getVscode = null;

    // =========================================================================
    // File Processing Progress Functions
    // =========================================================================

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function showProgressInDropzone(dropzone, file) {
        // Save original content for restoration later
        csvState.originalDropzoneContent = dropzone.innerHTML;
        csvState.isProcessing = true;

        // Store file size for progress estimation (bytes → MB)
        csvState._fileSizeMB = file.size / (1024 * 1024);

        // Add processing class to dropzone
        dropzone.classList.add('processing');

        // GitHub Issue #224: Simplified dropzone — progress bar is in the footer
        dropzone.innerHTML = '<div class="csv-file-processing">' +
            '<div class="csv-processing-file-info">' +
            '<h4>Processing: ' + file.name + '</h4>' +
            '<p class="file-size">(' + formatFileSize(file.size) + ')</p>' +
            '</div>' +
            '</div>';

        updateFileProgress(0, 'Fetching file...');
    }

    /**
     * GitHub Issue #224: how far reading a file (or checking its rows) has got. #435: shown in the
     * step bar, as a fill behind the step it belongs to and its text as that step's summary
     * (batch-stepper.js); a panel of its own in the footer pushed the steps about.
     * @param {number} percent - 0-100; with no phase, 0 clears it
     * @param {string} [phase] - What is happening ("Fetching file...")
     * @param {number} [estimateSec] - An estimate, not a measure: the fill moves there over this long
     */
    function updateFileProgress(percent, phase, estimateSec) {
        if (!phase && !percent) {
            csvState.stepProgress = null;
        } else {
            const same = csvState.stepProgress && csvState.stepProgress.step === csvState.modalStep;
            csvState.stepProgress = {
                step: same ? csvState.stepProgress.step : (csvState.modalStep || 1),
                percent: percent,
                text: phase || (same ? csvState.stepProgress.text : ''),
                seconds: estimateSec || 0
            };
        }
        if (window.BatchStepper) window.BatchStepper.refresh();
    }

    function completeProgressAndRestore(dropzone) {
        // [PERF #224] T10 — total file load time
        if (csvState._perfT0) {
            console.log('[PERF #224] T10 fileLoadComplete: +' + Math.round(performance.now() - csvState._perfT0) + 'ms TOTAL');
            csvState._perfT0 = null;
        }

        // GitHub Issue #224: the read is complete (the step bar says so)
        updateFileProgress(100, 'Complete');

        // Add completion class and wait a moment before restoration
        dropzone.classList.remove('processing');
        dropzone.classList.add('processing-complete');

        setTimeout(function () {
            // Restore original dropzone content
            if (csvState.originalDropzoneContent) {
                dropzone.innerHTML = csvState.originalDropzoneContent;
                dropzone.classList.remove('processing-complete');
                csvState.originalDropzoneContent = null;
            }
            csvState.isProcessing = false;

            // Clear the step bar's progress
            // Reset bar for next use
            updateFileProgress(0, '');
        }, 1500); // Show completion state for 1.5 seconds
    }

    function handleProgressError(dropzone, errorMessage) {
        // Show error state briefly, then restore
        dropzone.classList.remove('processing', 'processing-complete');

        // GitHub Issue #224: clear the progress on error
        updateFileProgress(0, '');

        setTimeout(function () {
            if (csvState.originalDropzoneContent) {
                dropzone.innerHTML = csvState.originalDropzoneContent;
                csvState.originalDropzoneContent = null;
            }
            csvState.isProcessing = false;

            // Show error message
            getVscode().postMessage({
                type: 'showError',
                message: errorMessage
            });
        }, 500);
    }

    // =========================================================================
    // Multi-Format File Processing
    // =========================================================================

    function handleCSVUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Get supported extensions for validation
        const supportedExtensions = ['.csv', '.xlsx', '.xls', '.tsv', '.txt'];
        const fileName = file.name.toLowerCase();
        const isSupported = supportedExtensions.some(ext => fileName.endsWith(ext));

        if (!isSupported) {
            const supportedList = supportedExtensions.join(', ');
            getVscode().postMessage({
                type: 'showError',
                message: `Please select a supported file format: ${supportedList}`
            });
            return;
        }

        csvState.currentFile = file;
        // Track source information for batch naming
        csvState.sourceType = 'file';
        csvState.sourceFileName = file.name;
        csvState.sourceSheetName = null; // Will be set later if Excel

        // GitHub Issue #202: Update file tab data
        if (window.CSVHandler && window.CSVHandler.updateFileTabData) {
            window.CSVHandler.updateFileTabData(true, file.name);
        }

        // Clear paste area since we're using file instead
        const pasteArea = document.getElementById('csvPasteArea');
        if (pasteArea) {
            pasteArea.value = '';
        }

        // Reset type detection flag for new file upload (GitHub Issue #106)
        csvState.typeDetectionCompleted = false;
        csvState.selectedColumnTypes = {};

        // GitHub Issue #202: Show progress in the dropzone inside the grid panel
        const dropzone = document.getElementById('csvDropzone');
        if (dropzone) {
            dropzone.classList.remove('hidden');
            showProgressInDropzone(dropzone, file);
            processMultiFormatFile(file, dropzone);
        } else {
            processMultiFormatFile(file);
        }

        // Update Read File button state
        if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
            window.CSVHandler.updateReadButtonState();
        }
    }

    /**
     * Turn a FileReader DOMException into something the user can act on (dbmn#4).
     *
     * The common failure on Windows is `NotReadableError`. The File handed over
     * by <input type="file"> is a *snapshot* — path plus size plus mtime — and
     * the browser re-validates it at read time. Excel rewrites and touches a
     * workbook while it's open (autosave, its ~$lock bookkeeping), so a file
     * that was fine at the moment of picking can fail microseconds later. That
     * timing dependency is why the same action works for some people and not
     * others, and why retrying often succeeds.
     */
    function describeFileReadError(err, file) {
        var name = err && err.name ? err.name : '';
        var detail = err && err.message ? err.message : '';
        var isExcel = /\.(xlsx|xls)$/i.test((file && file.name) || '');

        if (name === 'NotReadableError' || name === 'NotFoundError') {
            if (isExcel) {
                return 'Could not read "' + ((file && file.name) || 'the file') + '". '
                    + 'It looks like the file changed on disk while being read — this usually means '
                    + "it's open in Excel. Save and close it in Excel, then try again.";
            }
            return 'Could not read "' + ((file && file.name) || 'the file') + '". '
                + 'It may have been moved, renamed, or changed by another program since you selected it. '
                + 'Try selecting it again.';
        }

        if (name === 'SecurityError') {
            return 'Access to "' + ((file && file.name) || 'the file') + '" was blocked. '
                + 'Try copying it somewhere local (e.g. your Desktop) and selecting it from there.';
        }

        return 'Error reading file' + (name ? ' (' + name + ')' : '')
            + (detail ? ': ' + detail : '.');
    }

    function processMultiFormatFile(file, dropzone) {
        if (dropzone === undefined) dropzone = null;
        const reader = new FileReader();

        // [PERF #224] T0 — anchor for all subsequent timing
        csvState._perfT0 = performance.now();
        console.log('[PERF #224] T0 fileSelected: ' + file.name + ' (' + (file.size / (1024*1024)).toFixed(1) + 'MB)');

        // Store file metadata
        window.currentCSVFileName = file.name;
        window.currentCSVFileSize = file.size;

        // Add progress tracking to FileReader
        reader.onprogress = function (e) {
            if (dropzone && e.lengthComputable) {
                // GitHub Issue #224: Map FileReader 0-100% to bar 0-5%
                var pct = Math.round((e.loaded / e.total) * 5);
                updateFileProgress(pct, 'Fetching file...');
            }
        };

        reader.onload = function (e) {
            // GitHub Issue #224: Reading done — start estimated detect transition
            if (dropzone) {
                var estimatedDetectSec = (csvState._fileSizeMB || 1) * 1.5;
                // Clamp to minimum 0.5s, max 90s
                estimatedDetectSec = Math.max(0.5, Math.min(90, estimatedDetectSec));
                updateFileProgress(95, 'Fetching file...', estimatedDetectSec);
            }

            // [PERF #224] T1 — file in memory
            if (csvState._perfT0) console.log('[PERF #224] T1 readerOnload: +' + Math.round(performance.now() - csvState._perfT0) + 'ms');

            const fileData = e.target.result;
            csvState.rawFileData = fileData; // Store original file data

            // Send to extension for format detection
            getVscode().postMessage({
                type: 'detectFileFormat',
                fileData: fileData,
                fileName: file.name,
                fileSize: file.size
            });
        };

        reader.onerror = function () {
            // dbmn#4: `onerror` receives a ProgressEvent, NOT an Error — reading
            // `.message` off it always yielded undefined, so every failure here
            // surfaced as "Error reading file: undefined". The real DOMException
            // lives on `reader.error`.
            var err = reader.error || {};
            var message = describeFileReadError(err, file);

            if (dropzone) {
                handleProgressError(dropzone, message);
            } else {
                if (window.CSVHandler && window.CSVHandler.showCSVError) {
                    window.CSVHandler.showCSVError(message);
                }
            }
        };

        // Start reading stage
        if (dropzone) {
            updateFileProgress(2, 'Fetching file...');
        }

        // Read as ArrayBuffer for Excel files, text for others
        const fileName = file.name.toLowerCase();
        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            reader.readAsArrayBuffer(file);
        } else {
            reader.readAsText(file);
        }
    }

    function processCSVFile(file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            const csvContent = e.target.result;

            // Store file metadata and raw CSV content
            window.currentCSVFileName = file.name;
            window.currentCSVFileSize = file.size;
            csvState.rawCSVContent = csvContent; // Store raw CSV content for verification

            // Send to extension for parsing
            getVscode().postMessage({
                type: 'parseCSVForModal',
                csvData: csvContent,
                fileName: file.name,
                fileSize: file.size
            });
        };
        reader.onerror = function () {
            // dbmn#4: same ProgressEvent-vs-Error bug as processMultiFormatFile.
            if (window.CSVHandler && window.CSVHandler.showCSVError) {
                window.CSVHandler.showCSVError(describeFileReadError(reader.error || {}, file));
            }
        };
        reader.readAsText(file);
    }

    function handleCSVDrop(event) {
        event.preventDefault();
        event.stopPropagation();

        const files = event.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            const supportedExtensions = ['.csv', '.xlsx', '.xls', '.tsv', '.txt'];
            const fileName = file.name.toLowerCase();
            const isSupported = supportedExtensions.some(ext => fileName.endsWith(ext));

            if (isSupported) {
                csvState.currentFile = file;
                // Track source information for batch naming
                csvState.sourceType = 'file';
                csvState.sourceFileName = file.name;
                csvState.sourceSheetName = null; // Will be set later if Excel

                // GitHub Issue #202: Update file tab data and stay on grid tab
                if (window.CSVHandler && window.CSVHandler.updateFileTabData) {
                    window.CSVHandler.updateFileTabData(true, file.name);
                }

                // Clear paste area since we're using file instead
                const pasteArea = document.getElementById('csvPasteArea');
                if (pasteArea) {
                    pasteArea.value = '';
                }

                // Reset type detection flag for new file upload (GitHub Issue #106)
                csvState.typeDetectionCompleted = false;
                csvState.selectedColumnTypes = {};
                csvState.fileDetailsShown = false; // GitHub Issue #111: Reset for new file

                // GitHub Issue #202: Show progress in dropzone inside grid panel
                const dropzone = document.getElementById('csvDropzone');
                if (dropzone) {
                    dropzone.classList.remove('hidden');
                    showProgressInDropzone(dropzone, file);
                    processMultiFormatFile(file, dropzone);
                } else {
                    processMultiFormatFile(file);
                }
            } else {
                const supportedList = supportedExtensions.join(', ');
                if (window.CSVHandler && window.CSVHandler.showCSVError) {
                    window.CSVHandler.showCSVError(`Please drop a supported file format: ${supportedList}`);
                }
            }
        }
    }

    function handleCSVDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        // GitHub Issue #202: Visual feedback on the dropzone
        const dropzone = document.getElementById('csvDropzone');
        if (dropzone) {
            dropzone.classList.add('drag-over');
        }
    }

    function handleCSVDragLeave(event) {
        event.preventDefault();
        // GitHub Issue #202: Remove visual feedback from dropzone
        const dropzone = document.getElementById('csvDropzone');
        if (dropzone) {
            dropzone.classList.remove('drag-over');
        }
    }

    // =========================================================================
    // Format Detection and Conversion Handlers
    // =========================================================================

    function handleFormatDetected(message) {
        // [PERF #224] T4 — format detected
        if (csvState._perfT0) console.log('[PERF #224] T4 formatDetected: +' + Math.round(performance.now() - csvState._perfT0) + 'ms');

        // GitHub Issue #224: Snap to 75% — format detected
        if (csvState.isProcessing) {
            updateFileProgress(75, 'Fetching file...');
        }

        if (message.error) {
            if (csvState.isProcessing) {
                const dropzone = document.querySelector('.csv-dropzone');
                if (dropzone) {
                    handleProgressError(dropzone, `Format detection failed: ${message.error}`);
                    return;
                }
            }
            if (window.CSVHandler && window.CSVHandler.showCSVError) {
                window.CSVHandler.showCSVError(`Format detection failed: ${message.error}`);
            }
            return;
        }

        // Store format information
        csvState.fileFormat = message.format;
        csvState.formatMetadata = message.metadata;

        // GitHub Issue #207: Store per-sheet details for table/filter validation
        if (message.metadata?.sheetDetails) {
            csvState.sheetDetails = message.metadata.sheetDetails;
        }

        // Initialize selected sheet index for Excel files
        if (message.format === 'excel') {
            csvState.selectedSheetIndex = 0;
            // Set initial sheet name for batch naming
            csvState.sourceSheetName = message.metadata?.sheets?.[0] || 'Sheet1';
        }

        // Show file details in Step 1 (replace drop zone content)
        showFileDetails(message);

        // GitHub Issue #224: the read is done — the user clicks "Import Data" to continue
        if (csvState.isProcessing) {
            updateFileProgress(100, 'Complete');
            setTimeout(function () {
                updateFileProgress(0, '');
            }, 800);
            csvState.isProcessing = false;
            var dropzone = document.getElementById('csvDropzone');
            if (dropzone) {
                dropzone.classList.remove('processing', 'processing-complete');
                csvState.originalDropzoneContent = null;
            }
        }

        // GitHub Issue #207: Validate the default sheet (tables, filters)
        if (message.format === 'excel' && csvState.sheetDetails) {
            showExcelValidation(csvState.selectedSheetIndex || 0);
        }

        // Don't start conversion automatically - wait for user to click "Read File"
    }

    function showFileDetails(formatMessage) {
        const dropzone = document.getElementById('csvDropzone');

        if (!dropzone) {
            // Update state and navigation even without dropzone
            csvState.fileDetailsShown = true;
            if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
                window.CSVHandler.updateCSVNavigationButtons();
            }
            return;
        }

        // GitHub Issue #202: Show file details inside the dropzone
        let detailsHTML = `
            <div class="dropzone-file-details">
                <div class="dropzone-file-info">
                    <span class="dropzone-file-icon">&#128196;</span>
                    <span class="dropzone-file-name">${window.currentCSVFileName}</span>
                    <span class="dropzone-file-size">(${formatFileSize(window.currentCSVFileSize)})</span>
                </div>
                <div class="dropzone-file-actions">
                    <button class="btn btn-link btn-sm" data-click="csv:openComputerFileDialog">Change File</button>
                    <button class="btn btn-link btn-sm" data-click="grid:clearFileAndShowGrid">Clear</button>
                </div>
        `;

        // Add sheet selection for Excel files with multiple sheets
        if (formatMessage.format === 'excel' && formatMessage.metadata.sheets && formatMessage.metadata.sheets.length > 1) {
            const selectedIdx = csvState.selectedSheetIndex || 0;
            detailsHTML += `
                <div class="sheet-selector">
                    <label>Select Sheet:</label>
                    <select id="excelSheetSelect" data-change="csv:updateSelectedSheet">
                        ${formatMessage.metadata.sheets.map((sheet, index) =>
                `<option value="${index}"${index === selectedIdx ? ' selected' : ''}>${sheet}</option>`
            ).join('')}
                    </select>
                </div>
                <div id="filterChoiceContainer" class="filter-choice-container"></div>
            `;
        } else if (formatMessage.format === 'excel') {
            // Single-sheet Excel — still need placeholder for potential hidden rows
            detailsHTML += `
                <div id="filterChoiceContainer" class="filter-choice-container"></div>
            `;
        }

        detailsHTML += '</div>';

        dropzone.innerHTML = detailsHTML;
        // Clicks on the sheet and range pickers stay there: the dropzone underneath would open
        // the file dialog. A listener on each, not an inline handler (#372: the web app's CSP)
        dropzone.querySelectorAll('.sheet-selector, .filter-choice-container').forEach(el => el.addEventListener('click', event => event.stopPropagation()));
        dropzone.classList.remove('hidden');
        dropzone.classList.add('file-selected');

        // Update state and navigation
        csvState.fileDetailsShown = true;
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }

    function hideUploadUI() {
        // Hide only the drop zone, not the entire upload container
        const dropzone = document.getElementById('csvDropzone');
        if (dropzone) {
            dropzone.classList.add('hidden');
        }
    }

    function showUploadUI() {
        // GitHub Issue #202: Restore dropzone to original upload content
        const dropzone = document.getElementById('csvDropzone');
        if (dropzone) {
            dropzone.innerHTML = `
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
            `;
            dropzone.classList.remove('file-selected', 'processing');
            dropzone.classList.remove('hidden');
        }
    }

    function showConversionLoadingState() {
        // Update the "Import Data" button to show loading
        const nextBtn = document.getElementById('csvNextBtn');
        if (nextBtn) {
            nextBtn.textContent = 'Processing...';
            nextBtn.disabled = true;
        }
    }

    function hideConversionLoadingState() {
        // Restore the "Import Data" button
        const nextBtn = document.getElementById('csvNextBtn');
        if (nextBtn) {
            nextBtn.textContent = 'Import Data';
            nextBtn.disabled = false;
        }
    }

    // =========================================================================
    // GitHub Issue #207: Excel Table/Filter Validation
    // =========================================================================

    /**
     * Validate the selected Excel sheet for table structure and filter state.
     * Shows footer notifications for errors, table info, or filter prompts.
     */
    function showExcelValidation(sheetIndex) {
        if (!csvState.sheetDetails) return;

        const sheet = csvState.sheetDetails[sheetIndex];
        if (!sheet) return;

        // Only clear filter choice when sheet actually changes (not on back-nav restore)
        // Back-nav persistence is handled by the caller restoring the radio selection

        // Remove filter choice UI when switching to a sheet without hidden rows
        const container = document.getElementById('filterChoiceContainer');

        // Check validation status
        if (sheet.validationStatus === 'error') {
            if (container) container.innerHTML = '';
            csvState.filterChoice = null;
            if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                window.CSVHandler.showModalNotification('error', sheet.validationMessage, { persistent: true });
            }
            if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
                window.CSVHandler.updateReadButtonState();
            }
            return;
        }

        // Check for hidden rows — show inline radio buttons for filter choice
        if (sheet.filter && sheet.filter.hasHiddenRows) {
            const visibleCount = sheet.rowCount - 1 - sheet.filter.hiddenRowCount;
            const totalCount = sheet.rowCount - 1;

            if (container) {
                container.innerHTML = `
                    <label>Import range:</label>
                    <div class="radio-group-inline">
                        <label class="radio-label">
                            <input type="radio" name="filterMode" value="visible"
                                data-change="ingestion:setFilterChoice" data-arg="visible">
                            Filtered rows (${visibleCount} rows)
                        </label>
                        <label class="radio-label">
                            <input type="radio" name="filterMode" value="all"
                                data-change="ingestion:setFilterChoice" data-arg="all">
                            All rows (${totalCount} rows)
                        </label>
                    </div>
                `;
            }

            // Show prompt if no choice yet
            if (!csvState.filterChoice) {
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification('warning', 'Please select range of records to import', { persistent: true });
                }
            }

            if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
                window.CSVHandler.updateReadButtonState();
            }
            return;
        }

        // No hidden rows on this sheet — remove radio buttons and clear choice
        if (container) container.innerHTML = '';
        csvState.filterChoice = null;

        // No table/filter issues — clear any previous notification
        if (!sheet.filter?.hasAutoFilter && sheet.tableCount === 0) {
            if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
                window.CSVHandler.clearModalNotification();
            }
        }

        // Always re-evaluate Read button for valid sheets (fixes: switching from invalid→valid sheet)
        if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
            window.CSVHandler.updateReadButtonState();
        }
    }

    /**
     * Handle user's filter import choice (called from inline buttons).
     */
    function setFilterChoice(choice) {
        csvState.filterChoice = choice;

        // Clear the "Please select" prompt — no confirmation needed, the radio selection speaks for itself
        if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
            window.CSVHandler.clearModalNotification();
        }

        // Re-enable Read File button
        if (window.CSVHandler && window.CSVHandler.updateReadButtonState) {
            window.CSVHandler.updateReadButtonState();
        }
    }

    function startFileConversion() {
        // [PERF #224] T5 — user clicks Import Data
        if (csvState._perfT0) console.log('[PERF #224] T5 startConversion: +' + Math.round(performance.now() - csvState._perfT0) + 'ms (user click)');

        // Set loading state
        csvState.conversionInProgress = true;
        csvState.isProcessing = true;
        showConversionLoadingState();

        // GitHub Issue #224: progress again for the conversion phase
        // Recalculate file size in case _fileSizeMB was lost between phases
        if (!csvState._fileSizeMB && window.currentCSVFileSize) {
            csvState._fileSizeMB = window.currentCSVFileSize / (1024 * 1024);
        }
        updateFileProgress(0, 'Importing data...');

        // Prepare conversion options based on format
        const conversionOptions = {};

        if (csvState.fileFormat === 'excel') {
            // Use selected sheet index, or default to first sheet
            conversionOptions.sheetIndex = csvState.selectedSheetIndex || 0;

            // GitHub Issue #207: Pass effective data range from table detection
            if (csvState.sheetDetails) {
                const sheet = csvState.sheetDetails[conversionOptions.sheetIndex];
                if (sheet && sheet.effectiveDataRange) {
                    conversionOptions.effectiveDataRange = sheet.effectiveDataRange;
                }
            }

            // GitHub Issue #207: Pass skipHidden based on user's filter choice
            if (csvState.filterChoice === 'all') {
                conversionOptions.skipHidden = false;
            } else {
                conversionOptions.skipHidden = true;
            }

            // GitHub Issue #256: Skip phantom empty rows from styled-but-empty
            // cells (e.g. endpoint-generated templates with reserved blank rows).
            conversionOptions.skipEmptyRows = true;
        }

        // GitHub Issue #224: Start estimated conversion progress (0% → 55%)
        // Use rAF so the browser paints 0% before starting the CSS transition
        if (csvState.isProcessing) {
            var estimatedConvertSec = (csvState._fileSizeMB || 1) * 0.3;
            estimatedConvertSec = Math.max(0.3, Math.min(30, estimatedConvertSec));
            requestAnimationFrame(function () {
                updateFileProgress(55, 'Importing data...', estimatedConvertSec);
            });
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

    function handleFormatConversionComplete(message) {
        // [PERF #224] T8 — conversion complete
        if (csvState._perfT0) console.log('[PERF #224] T8 conversionComplete: +' + Math.round(performance.now() - csvState._perfT0) + 'ms');

        // GitHub Issue #224: Snap to 60%, then estimate through verification phase
        if (csvState.isProcessing) {
            updateFileProgress(60, 'Importing data...');
            // Start estimated transition toward 95% for verifyCSVCompatibility
            var estimatedVerifySec = (csvState._fileSizeMB || 1) * 0.3;
            estimatedVerifySec = Math.max(0.5, Math.min(30, estimatedVerifySec));
            // Small delay so the snap to 60% renders before starting the transition
            setTimeout(function () {
                updateFileProgress(95, 'Importing data...', estimatedVerifySec);
            }, 50);
        }

        // Clear conversion state
        csvState.conversionInProgress = false;
        hideConversionLoadingState();

        if (message.error) {
            if (window.CSVHandler && window.CSVHandler.showCSVError) {
                window.CSVHandler.showCSVError(`Failed to process file: ${message.error}`);
            }
            return;
        }

        // Store converted CSV data
        csvState.rawCSVContent = message.csvData;

        // GitHub Issue #207: Show filtered data notification after Excel import
        if (csvState.fileFormat === 'excel' && csvState.sheetDetails) {
            const sheetIdx = csvState.selectedSheetIndex || 0;
            const sheet = csvState.sheetDetails[sheetIdx];
            if (sheet && sheet.filter && sheet.filter.hasAutoFilter && sheet.filter.hasHiddenRows) {
                const hiddenCount = sheet.filter.hiddenRowCount;
                const totalRows = message.preview ? message.preview.totalRows || message.preview.rows?.length : null;
                if (csvState.filterChoice === 'all') {
                    const msg = totalRows
                        ? `Imported ${totalRows} rows (all rows including ${hiddenCount} previously hidden).`
                        : `Imported all rows (including ${hiddenCount} previously hidden).`;
                    if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                        window.CSVHandler.showModalNotification('info', msg, { persistent: false });
                    }
                } else {
                    const msg = totalRows
                        ? `Imported ${totalRows} visible rows (${hiddenCount} hidden row${hiddenCount !== 1 ? 's' : ''} excluded).`
                        : `Imported visible rows only (${hiddenCount} hidden row${hiddenCount !== 1 ? 's' : ''} excluded).`;
                    if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                        window.CSVHandler.showModalNotification('info', msg, { persistent: false });
                    }
                }
            }
        }

        // GitHub Issue #226: If the converted CSV has column-count mismatches,
        // do NOT advance to Step 2 (mapping). Mount the inline repair panel on
        // Step 1 and block — see project plan: "block Step 1 -> Step 2".
        if (message.columnMismatch && message.columnMismatch.rows && message.columnMismatch.rows.length > 0) {
            csvState.rawCSVContent = message.csvData;
            mountMismatchRepairOrClear(message.columnMismatch, {
                fileName: window.currentCSVFileName || 'converted-file',
                fileSize: message.csvData.length
            });
            setTimeout(function () {
                csvState.navigationInProgress = false;
            }, 300);
            return;
        }

        // No mismatches — clear any prior repair UI from a previous attempt.
        mountMismatchRepairOrClear(null, null);

        // If preview data is available, use it directly instead of round-trip parsing
        if (message.preview && message.preview.headers && message.preview.rows) {

            // Store state data like handleCSVModalParsed does
            csvState.verificationPassed = true;
            csvState.currentHeaders = message.preview.headers;
            csvState.currentParsedData = message.preview; // Store the full preview object

            // Store data in global scope for compatibility
            window.currentParsedCsvData = message.preview.rows;
            window.currentCSVFileName = window.currentCSVFileName || 'converted-file';
            window.currentCSVFileSize = window.currentCSVFileSize || message.csvData.length;

            // Create enhanced preview with metadata
            const enhancedPreview = {
                ...message.preview,
                totalRows: message.preview.totalRows || message.preview.rows.length,
                fileName: window.currentCSVFileName,
                fileSize: window.currentCSVFileSize
            };

            // Now advance to Step 2 and show the preview
            // Cross-module call: showCSVStep is in the orchestrator
            if (window.CSVHandler && window.CSVHandler.showCSVStep) {
                window.CSVHandler.showCSVStep(2);
            }

            // Show CSV preview with type detection
            if (window.CSVHandler && window.CSVHandler.displayCSVModalPreview) {
                window.CSVHandler.displayCSVModalPreview(enhancedPreview);
            }

            // Trigger compatibility verification to populate template variables and mapping table
            if (window.CSVHandler && window.CSVHandler.triggerCSVCompatibilityVerification) {
                window.CSVHandler.triggerCSVCompatibilityVerification();
            }
        } else {
            // Fallback to old behavior if no preview
            if (window.CSVHandler && window.CSVHandler.showCSVStep) {
                window.CSVHandler.showCSVStep(2);
            }

            // Trigger compatibility verification to populate template variables and mapping table
            if (window.CSVHandler && window.CSVHandler.triggerCSVCompatibilityVerification) {
                window.CSVHandler.triggerCSVCompatibilityVerification();
            }
        }

        // GitHub Issue #224: Progress bar stays visible — completion deferred to handleCSVCompatibilityVerified

        // Clear navigation flag with timeout to prevent double-clicks
        setTimeout(function () {
            csvState.navigationInProgress = false;
        }, 300);
    }

    function handleFormatConversionError(message) {
        // Clear conversion state
        csvState.conversionInProgress = false;
        hideConversionLoadingState();

        // GitHub Issue #224: clear the progress on error
        if (csvState.isProcessing) {
            csvState.isProcessing = false;
            updateFileProgress(0, '');
        }

        if (window.CSVHandler && window.CSVHandler.showCSVError) {
            window.CSVHandler.showCSVError(`Conversion failed: ${message.error}`);
        }
        csvState.conversionPassed = false;
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }

    // =========================================================================
    // GitHub Issue #226: Column-mismatch repair panel wiring
    // =========================================================================

    /**
     * Mount / hide the v3 inline repair editor. The module reads the full
     * raw CSV from `csvState.rawCSVContent`, lets the user fix in-place, and
     * posts `parseCSVForModal` itself when the user clicks Continue.
     */
    function mountMismatchRepairOrClear(columnMismatch, context) {
        const fileName = (context && context.fileName) || window.currentCSVFileName || 'uploaded-data.csv';

        if (!columnMismatch || !columnMismatch.rows || columnMismatch.rows.length === 0) {
            if (window.DTMismatchRepair) window.DTMismatchRepair.hide();
            if (window.CSVHandler && window.CSVHandler.clearModalNotification) {
                window.CSVHandler.clearModalNotification();
            }
            return;
        }

        if (window.DTMismatchRepair) {
            window.DTMismatchRepair.show(columnMismatch, { fileName: fileName });
        }

        if (window.CSVHandler && window.CSVHandler.showModalNotification) {
            const msg = columnMismatch.rows.length === 1
                ? '1 row has the wrong number of columns. Fix below to continue.'
                : columnMismatch.rows.length + ' rows have the wrong number of columns. Fix below to continue.';
            window.CSVHandler.showModalNotification('warning', msg, { blocking: true });
        }
    }

    // =========================================================================
    // CSV Parsing Callbacks
    // =========================================================================

    function handleCSVModalParsed(message) {
        // [PERF #224] T9 — CSV parsed for modal
        if (csvState._perfT0) console.log('[PERF #224] T9 csvModalParsed: +' + Math.round(performance.now() - csvState._perfT0) + 'ms');

        // GitHub Issue #224: Snap to 95% if still processing
        if (csvState.isProcessing) {
            updateFileProgress(95, 'Importing data...');
        }

        if (message.error) {
            if (csvState.isProcessing) {
                const dropzone = document.querySelector('.csv-dropzone');
                if (dropzone) {
                    handleProgressError(dropzone, `CSV Validation Failed: ${message.error}`);
                    return;
                }
            }
            if (window.CSVHandler && window.CSVHandler.showCSVVerificationError) {
                window.CSVHandler.showCSVVerificationError(`CSV Validation Failed: ${message.error}`);
            }
            csvState.verificationPassed = false;
            if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
                window.CSVHandler.updateCSVNavigationButtons();
            }
            return;
        }

        // CSV validation passed - update state
        csvState.verificationPassed = true;
        csvState.currentHeaders = message.preview.headers;

        // Store data in global scope for compatibility
        window.currentParsedCsvData = message.preview.rows;
        window.currentCSVFileName = message.fileName;
        window.currentCSVFileSize = message.fileSize;

        // Store raw CSV content for verification - get it from the message if available

        if (message.csvData) {
            csvState.rawCSVContent = message.csvData;
        } else if (window.csvModalData && window.csvModalData.content) {
            csvState.rawCSVContent = window.csvModalData.content;
        }

        // Enhance preview data with message info (includes totalRows for accurate count display)
        const enhancedPreview = {
            ...message.preview,
            totalRows: message.rowCount,
            fileName: message.fileName,
            fileSize: message.fileSize
        };

        // Store enhanced preview with totalRows for accurate row count display (GitHub Issue fix)
        csvState.currentParsedData = enhancedPreview;

        // Show CSV preview
        if (window.CSVHandler && window.CSVHandler.displayCSVModalPreview) {
            window.CSVHandler.displayCSVModalPreview(enhancedPreview);
        }

        // GitHub Issue #226: Inline-editable repair panel for column-count mismatches.
        // Replaces the opaque banner from #135 — the user can now fix bad rows
        // in place instead of being forced back to the source file. When
        // mismatches are present we early-return so the compatibility-verify
        // cascade (which would auto-advance to Step 2 in
        // handleCSVCompatibilityVerified) does NOT fire — keeping the user on
        // Step 1 until every row is repaired.
        if (message.columnMismatch && message.columnMismatch.rows && message.columnMismatch.rows.length > 0) {
            mountMismatchRepairOrClear(message.columnMismatch, {
                fileName: message.fileName,
                fileSize: message.fileSize
            });
            // Complete progress bar so the dropzone state is restored
            if (csvState.isProcessing && !csvState.conversionInProgress) {
                const dz = document.querySelector('.csv-dropzone');
                if (dz) completeProgressAndRestore(dz);
            }
            return;
        }

        // No mismatches — clear any prior repair panel from a re-parse cycle.
        mountMismatchRepairOrClear(null, null);

        // Trigger compatibility verification for mapping step
        if (window.CSVHandler && window.CSVHandler.triggerCSVCompatibilityVerification) {
            window.CSVHandler.triggerCSVCompatibilityVerification();
        }

        // Complete progress and restore dropzone if we're in the CSV modal parsed flow (not format conversion flow)
        if (csvState.isProcessing && !csvState.conversionInProgress) {
            const dropzone = document.querySelector('.csv-dropzone');
            if (dropzone) {
                completeProgressAndRestore(dropzone);
            }
        }

    }

    function handleCSVCompatibilityVerified(message) {
        // GitHub Issue #224: the true "load complete"
        if (csvState.isProcessing) {
            // [PERF #224] T10 — total file load time
            if (csvState._perfT0) {
                console.log('[PERF #224] T10 fileLoadComplete: +' + Math.round(performance.now() - csvState._perfT0) + 'ms TOTAL');
                csvState._perfT0 = null;
            }
            updateFileProgress(100, 'Complete');
            csvState.isProcessing = false;
            setTimeout(function () {
                updateFileProgress(0, '');
            }, 1000);
        }

        // GitHub Issue #148: ALWAYS clear navigation flag first, before any early returns
        // This prevents buttons from being stuck disabled when grid data auto-skips mapping
        csvState.navigationInProgress = false;

        // Hide any error messages
        const errorElement = document.getElementById('csvVerificationError');
        if (errorElement) {
            errorElement.classList.add('hidden');
        }

        // Hide the success message too - it's not necessary to show
        const successElement = document.getElementById('csvVerificationSuccess');
        if (successElement) {
            successElement.classList.add('hidden');
        }

        // Store template variables for mapping
        // GitHub Issue #148: Get template variables from message OR fallback to gridTemplateVariables for grid source
        let templateVarsFromMessage = (message.mappingStatus && message.mappingStatus.variables && message.mappingStatus.variables.length > 0)
            ? message.mappingStatus.variables
            : null;

        // GitHub Issue #148: For grid data, use gridTemplateVariables as fallback
        // This fixes the bug where grid navigation to Step 3 was blocked because
        // message.mappingStatus.variables was empty/missing for grid data
        if (!templateVarsFromMessage && csvState.sourceType === 'grid' && csvState.gridTemplateVariables) {
            templateVarsFromMessage = csvState.gridTemplateVariables;
        }

        if (templateVarsFromMessage) {
            csvState.templateVariables = templateVarsFromMessage;
            csvState.apiCallEstimation = message.apiCallEstimation;
            csvState.executionInfo = message.executionInfo;

            // Store array repetition value if available
            if (message.apiCallEstimation && message.apiCallEstimation.elementsPerCall) {
                csvState.arrayRepetition = message.apiCallEstimation.elementsPerCall;
            }

            // Store endpoint configuration if provided
            if (message.endpointConfig) {
                csvState.endpointConfig = message.endpointConfig;
            }

            // GitHub Issue #148: Advance to step 2 for grid/paste data if we're at step 1
            // This happens AFTER template variables are set so showCSVStep(2) can populate the mapping table
            // goToNextStep returns early for grid data, waiting for this handler to advance the step
            // For paste: parseCSVForModal is only sent from goToNextStep() (user clicks "Read Data"),
            // NOT from handlePasteAreaChange(), so this auto-advance only fires after user action.
            if (csvState.modalStep === 1 && (csvState.sourceType === 'grid' || csvState.sourceType === 'paste')) {
                if (window.CSVHandler && window.CSVHandler.showCSVStep) {
                    window.CSVHandler.showCSVStep(2);
                }
            }

            // Populate the column mapping table (also called by showCSVStep, but ensure it's done)
            if (csvState.modalStep === 2) {
                if (window.CSVHandler && window.CSVHandler.populateColumnMappingTable) {
                    window.CSVHandler.populateColumnMappingTable();
                }
            }

            // UX Improvement: Auto-skip Step 2 for grid data entry
            // Grid columns ARE the template variables - nothing to map
            // File/Paste still need mapping (CSV columns -> template variables)
            // Only auto-skip on initial forward navigation, not when pressing Back
            // GitHub Issue #148: Still check for sorting requirements even when skipping mapping
            if (csvState.sourceType === 'grid' && csvState.modalStep === 2 && !csvState.autoSkipAttempted) {
                csvState.autoSkipAttempted = true;
                if (window.CSVHandler && window.CSVHandler.showModalNotification) {
                    window.CSVHandler.showModalNotification('info', 'No mapping required for grid data. Press Back to review if needed.', { blocking: false });
                }
                // Cross-module call: checkNestedArraySorting is in the orchestrator (coercion area)
                if (window.CSVHandler && window.CSVHandler.checkNestedArraySorting) {
                    window.CSVHandler.checkNestedArraySorting();
                }
                return;
            }
        }

        csvState.verificationPassed = true;

        // GitHub Issue #148: navigationInProgress already cleared at function start
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }

        // GitHub Issue #247: every column matched with confidence → skip Step 2
        if (window.DTAutoAdvance) window.DTAutoAdvance.afterMapping();
    }

    function handleCSVCompatibilityError(message) {
        // GitHub Issue #224: clear the progress on a verification error
        if (csvState.isProcessing) {
            csvState.isProcessing = false;
            updateFileProgress(0, '');
        }

        // GitHub Issue #148: Ensure navigationInProgress is cleared on errors
        csvState.navigationInProgress = false;

        // Store error details and statistics for cell highlighting
        if (message.errorDetails) {
            csvState.errorDetails = message.errorDetails;
        }
        if (message.statistics) {
            csvState.validationStatistics = message.statistics;
        }

        // Show enhanced error summary with statistics
        // Cross-module call: showEnhancedCSVError is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.showEnhancedCSVError) {
            window.CSVHandler.showEnhancedCSVError(message.error, message.errorDetails, message.statistics);
        }

        // Update preview to show error rows by default when errors are found
        // Cross-module call: updatePreviewToShowErrors is in the orchestrator (type coercion area)
        if (window.CSVHandler && window.CSVHandler.updatePreviewToShowErrors) {
            window.CSVHandler.updatePreviewToShowErrors();
        }

        // Highlight error cells in the preview table
        // Cross-module call: highlightErrorCells is in the orchestrator
        if (window.CSVHandler && window.CSVHandler.highlightErrorCells) {
            window.CSVHandler.highlightErrorCells();
        }

        // Update buttons after clearing navigation state
        if (window.CSVHandler && window.CSVHandler.updateCSVNavigationButtons) {
            window.CSVHandler.updateCSVNavigationButtons();
        }
    }


    // =========================================================================
    // Public API
    // =========================================================================

    window.DTDataIngestion = {
        // Init function to receive shared state
        init: function (sharedState, vscodeFn) {
            csvState = sharedState;
            getVscode = vscodeFn;
        },

        // File processing progress
        formatFileSize,
        showProgressInDropzone,
        updateFileProgress,
        completeProgressAndRestore,
        handleProgressError,

        // File upload handling
        handleCSVUpload,
        processMultiFormatFile,
        processCSVFile,
        handleCSVDrop,
        handleCSVDragOver,
        handleCSVDragLeave,

        // Format detection and conversion
        handleFormatDetected,
        showFileDetails,
        hideUploadUI,
        showUploadUI,
        showConversionLoadingState,
        hideConversionLoadingState,
        startFileConversion,
        handleFormatConversionComplete,
        handleFormatConversionError,

        // GitHub Issue #207: Excel table/filter validation
        showExcelValidation,
        setFilterChoice,

        // CSV parsing callbacks
        handleCSVModalParsed,
        handleCSVCompatibilityVerified,
        handleCSVCompatibilityError
    };
})();
