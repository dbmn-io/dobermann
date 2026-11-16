// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Import/Export Webview Frontend Logic
 *
 * Handles UI interactions, file upload, conflict resolution, and message passing
 * with the extension backend.
 *
 * GitHub Issue: #90
 * Architecture: Vanilla JavaScript, message-based communication
 */

(function () {
    const vscode = acquireVsCodeApi();
    // Expose for shared/documentation-helpers.js (help icons → dbmn.io)
    window.vscode = vscode;

    // State management
    const state = {
        currentPage: 'landing',
        endpoints: {},
        environments: {},
        selectedEndpoints: new Set(),
        selectedEnvironments: new Set(),
        uploadedFile: null,
        importPackage: null,
        importItems: [], // All items with their actions (create/update)
        selectedItems: new Set(), // IDs of items user wants to import
        existingEndpoints: [], // Existing endpoints for dynamic action checking
        existingEnvironments: [], // Existing environments for dynamic action checking
        // Postman-specific (issue #189): per-endpoint data-loss summaries from the parser
        postmanLostByEndpointId: {}
    };

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        initializeEventListeners();
        notifyReady();
    });

    /**
     * Initialize all event listeners
     */
    function initializeEventListeners() {
        // Landing page choices
        document.getElementById('exportChoice')?.querySelector('button')
            ?.addEventListener('click', () => navigateToPage('export'));
        document.getElementById('importChoice')?.querySelector('button')
            ?.addEventListener('click', () => navigateToPage('import'));

        // Back buttons
        document.getElementById('backToLandingFromExport')
            ?.addEventListener('click', () => navigateToPage('landing'));
        document.getElementById('backToLandingFromImport')
            ?.addEventListener('click', () => navigateToPage('landing'));

        // Export page listeners
        initializeExportListeners();

        // Import page listeners
        initializeImportListeners();

        // Success page listeners
        initializeSuccessListeners();
    }

    /**
     * Initialize export page event listeners
     */
    function initializeExportListeners() {
        // Select/Deselect all buttons
        document.getElementById('selectAllEndpoints')
            ?.addEventListener('click', () => selectAll('endpoints'));
        document.getElementById('deselectAllEndpoints')
            ?.addEventListener('click', () => deselectAll('endpoints'));
        document.getElementById('selectAllEnvironments')
            ?.addEventListener('click', () => selectAll('environments'));
        document.getElementById('deselectAllEnvironments')
            ?.addEventListener('click', () => deselectAll('environments'));

        // Export button
        document.getElementById('executeExport')
            ?.addEventListener('click', handleExport);

        // Filename input
        document.getElementById('exportFilename')
            ?.addEventListener('input', updateExportButton);
    }

    /**
     * Initialize import page event listeners
     */
    function initializeImportListeners() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const browseButton = document.getElementById('browseFile');

        // Drag & drop events
        dropZone?.addEventListener('dragover', handleDragOver);
        dropZone?.addEventListener('dragleave', handleDragLeave);
        dropZone?.addEventListener('drop', handleFileDrop);

        // Browse button
        browseButton?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', handleFileSelect);

        // Import buttons
        document.getElementById('executeImport')
            ?.addEventListener('click', handleImport);

        // Item selection buttons (same as export, but for import trees)
        document.getElementById('selectAllImportEndpoints')
            ?.addEventListener('click', () => selectAllImport('endpoints'));
        document.getElementById('deselectAllImportEndpoints')
            ?.addEventListener('click', () => deselectAllImport('endpoints'));
        document.getElementById('selectAllImportEnvironments')
            ?.addEventListener('click', () => selectAllImport('environments'));
        document.getElementById('deselectAllImportEnvironments')
            ?.addEventListener('click', () => deselectAllImport('environments'));
    }

    /**
     * Initialize success page event listeners
     */
    function initializeSuccessListeners() {
        // Close button
        document.getElementById('closeSuccess')
            ?.addEventListener('click', () => {
                vscode.postMessage({ type: 'cancel' });
            });

        // Import/Export More button
        document.getElementById('importExportMore')
            ?.addEventListener('click', () => {
                navigateToPage('landing');
                // Reset state for new operation
                state.selectedEndpoints.clear();
                state.selectedEnvironments.clear();
                state.selectedItems.clear();
                state.importItems = [];
                state.uploadedFile = null;
            });

        // Open Folder button
        document.getElementById('openLocation')
            ?.addEventListener('click', (e) => {
                const filePath = e.target.dataset.filePath;
                if (filePath) {
                    vscode.postMessage({
                        type: 'openLocation',
                        payload: { filePath }
                    });
                }
            });
    }

    /**
     * Navigate to a different page
     */
    function navigateToPage(page) {
        // Hide all pages
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

        // Show target page
        const targetPage = document.getElementById(`${page}Page`);
        if (targetPage) {
            targetPage.classList.add('active');
            state.currentPage = page;
        }

        // Reset sections on import page
        if (page === 'import') {
            document.getElementById('uploadSection')?.classList.add('active');
            document.getElementById('conflictsSection')?.classList.remove('active');
            document.getElementById('postmanOptionsPanel')?.classList.add('hidden');
            // Disable import button until a valid file is loaded
            const importBtn = document.getElementById('executeImport');
            if (importBtn) importBtn.disabled = true;
        }

        // Clear any footer notification when changing pages
        clearFooterNotification();
    }


    /**
     * Build checkbox tree from items grouped by folder
     */
    function buildCheckboxTree(containerId, itemsByFolder, type) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';

        // Get folders sorted (empty string first for root)
        const folders = Object.keys(itemsByFolder).sort((a, b) => {
            if (a === '') return -1;
            if (b === '') return 1;
            return a.localeCompare(b);
        });

        folders.forEach(folder => {
            const items = itemsByFolder[folder];
            if (items.length === 0) return;

            // Create folder group
            const folderDiv = document.createElement('div');
            folderDiv.className = 'folder-group';

            // Folder header with checkbox
            const folderHeader = document.createElement('div');
            folderHeader.className = 'folder-header';

            const folderCheckbox = document.createElement('input');
            folderCheckbox.type = 'checkbox';
            folderCheckbox.id = `folder-${type}-${folder}`;
            folderCheckbox.addEventListener('change', (e) => {
                toggleFolderSelection(type, folder, e.target.checked);
            });

            const folderLabel = document.createElement('label');
            folderLabel.htmlFor = folderCheckbox.id;
            folderLabel.textContent = folder === '' ? 'Root' : folder;
            folderLabel.className = 'folder-label';

            folderHeader.appendChild(folderCheckbox);
            folderHeader.appendChild(folderLabel);
            folderDiv.appendChild(folderHeader);

            // Items in folder
            const itemsList = document.createElement('div');
            itemsList.className = 'folder-items';

            items.forEach(item => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'checkbox-item';

                const itemCheckbox = document.createElement('input');
                itemCheckbox.type = 'checkbox';
                itemCheckbox.id = `item-${type}-${item.id}`;
                itemCheckbox.dataset.folder = folder;
                itemCheckbox.dataset.type = type;
                itemCheckbox.dataset.itemId = item.id;
                itemCheckbox.addEventListener('change', (e) => {
                    console.log(`[checkbox change event] checkbox.id=${itemCheckbox.id}, item.id=${item.id}, checked=${e.target.checked}, folder=${folder}`);
                    toggleItemSelection(type, item.id, e.target.checked);
                    updateFolderCheckbox(type, folder);
                });

                const itemLabel = document.createElement('label');
                itemLabel.htmlFor = itemCheckbox.id;
                itemLabel.textContent = item.name || item.id;
                itemLabel.className = 'item-label';

                if (item.description) {
                    const description = document.createElement('span');
                    description.className = 'item-description';
                    description.textContent = item.description;
                    itemLabel.appendChild(description);
                }

                itemDiv.appendChild(itemCheckbox);
                itemDiv.appendChild(itemLabel);
                itemsList.appendChild(itemDiv);
            });

            folderDiv.appendChild(itemsList);
            container.appendChild(folderDiv);
        });

        updateSelectionCount(type);
    }

    /**
     * Toggle folder selection
     */
    function toggleFolderSelection(type, folder, selected) {
        const checkboxes = document.querySelectorAll(
            `input[type="checkbox"][data-type="${type}"][data-folder="${folder}"]`
        );

        checkboxes.forEach(checkbox => {
            // Only update checkbox if state is different to avoid redundant events
            if (checkbox.checked !== selected) {
                checkbox.checked = selected;
                // Manually call toggleItemSelection since programmatically setting
                // checkbox.checked doesn't trigger the 'change' event
                const itemId = checkbox.dataset.itemId;
                if (itemId) {
                    toggleItemSelection(type, itemId, selected);
                }
            }
        });
    }

    /**
     * Toggle item selection
     */
    function toggleItemSelection(type, itemId, selected) {
        const collection = type === 'endpoints' ? state.selectedEndpoints : state.selectedEnvironments;

        if (selected) {
            collection.add(itemId);
        } else {
            collection.delete(itemId);
        }

        console.log(`[toggleItemSelection] type=${type}, itemId=${itemId}, selected=${selected}, collection.size=${collection.size}`);
        updateSelectionCount(type);
        updateExportButton();
    }

    /**
     * Update folder checkbox based on child items
     */
    function updateFolderCheckbox(type, folder) {
        const checkboxes = Array.from(document.querySelectorAll(
            `input[type="checkbox"][data-type="${type}"][data-folder="${folder}"]`
        ));

        if (checkboxes.length === 0) return;

        const allChecked = checkboxes.every(cb => cb.checked);
        const someChecked = checkboxes.some(cb => cb.checked);

        const folderCheckbox = document.getElementById(`folder-${type}-${folder}`);
        if (folderCheckbox) {
            folderCheckbox.checked = allChecked;
            folderCheckbox.indeterminate = someChecked && !allChecked;
        }
    }

    /**
     * Select all items
     */
    function selectAll(type) {
        document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]`).forEach(checkbox => {
            checkbox.checked = true;
            toggleItemSelection(type, checkbox.dataset.itemId, true);
        });

        // Update folder checkboxes
        const folders = new Set(
            Array.from(document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]`))
                .map(cb => cb.dataset.folder)
        );
        folders.forEach(folder => updateFolderCheckbox(type, folder));
    }

    /**
     * Deselect all items
     */
    function deselectAll(type) {
        document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]`).forEach(checkbox => {
            checkbox.checked = false;
            toggleItemSelection(type, checkbox.dataset.itemId, false);
        });

        // Update folder checkboxes
        const folders = new Set(
            Array.from(document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]`))
                .map(cb => cb.dataset.folder)
        );
        folders.forEach(folder => updateFolderCheckbox(type, folder));
    }

    /**
     * Update selection count display (no-op in side-by-side layout)
     * Kept for compatibility with existing code that calls it
     */
    function updateSelectionCount(type) {
        // No longer needed with side-by-side layout - user can see selections directly
        // Function kept to avoid breaking existing code
    }

    /**
     * Update export button state
     */
    function updateExportButton() {
        const exportButton = document.getElementById('executeExport');

        // GitHub Issue #90: Check actual checked checkboxes, not Set size
        const hasEndpointSelection = document.querySelectorAll(
            'input[type="checkbox"][data-type="endpoints"]:checked:not([id^="folder-"])'
        ).length > 0;
        const hasEnvironmentSelection = document.querySelectorAll(
            'input[type="checkbox"][data-type="environments"]:checked:not([id^="folder-"])'
        ).length > 0;
        const hasSelection = hasEndpointSelection || hasEnvironmentSelection;

        const filenameInput = document.getElementById('exportFilename');
        const hasFilename = filenameInput?.value.trim().length > 0;

        if (exportButton) {
            exportButton.disabled = !hasSelection || !hasFilename;
        }
    }

    /**
     * Handle export button click
     */
    function handleExport() {
        const filename = document.getElementById('exportFilename')?.value.trim() || 'dobermann-export';

        const selectedEndpoints = Array.from(state.selectedEndpoints);
        const selectedEnvironments = Array.from(state.selectedEnvironments);
        // #289: credentials stay out of the file unless the user ticks the box
        const includeCredentials = document.getElementById('exportIncludeCredentials')?.checked === true;

        console.log('[handleExport] Sending export message:', {
            selectedEndpoints,
            selectedEnvironments,
            endpointCount: selectedEndpoints.length,
            environmentCount: selectedEnvironments.length,
            includeCredentials,
            filename
        });

        vscode.postMessage({
            type: 'exportSelected',
            payload: {
                selectedEndpoints,
                selectedEnvironments,
                includeConsoleSettings: true, // Always include console settings for endpoints
                includeCredentials,
                filename
            }
        });
    }

    /**
     * Handle drag over event
     */
    function handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.add('drag-over');
    }

    /**
     * Handle drag leave event
     */
    function handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');
    }

    /**
     * Handle file drop event
     */
    function handleFileDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            processFile(files[0]);
        }
    }

    /**
     * Handle file select from browse dialog
     */
    function handleFileSelect(e) {
        const files = e.target?.files;
        if (files && files.length > 0) {
            processFile(files[0]);
        }
        // Reset input so the same file can be re-selected after an error
        e.target.value = '';
    }

    /**
     * Process uploaded file - dispatches between DBMN .zip and Postman .json (issue #189)
     */
    function processFile(file) {
        const name = file.name.toLowerCase();
        const isZip = name.endsWith('.zip') || name.endsWith('.dbmn.zip');
        const isJson = name.endsWith('.json');
        if (!isZip && !isJson) {
            showFooterNotification('error', 'Invalid file type. Please upload a .dbmn.zip or Postman .json file.');
            return;
        }

        state.uploadedFile = file;
        state.isPostmanUpload = isJson;

        const reader = new FileReader();
        reader.onload = (e) => {
            if (isJson) {
                vscode.postMessage({
                    type: 'uploadPostmanFile',
                    payload: {
                        jsonText: e.target.result,
                        fileName: file.name
                    }
                });
            } else {
                vscode.postMessage({
                    type: 'uploadFile',
                    payload: {
                        fileData: e.target.result,
                        fileName: file.name
                    }
                });
            }

            showFooterNotification('info', 'Processing file...');
        };
        reader.onerror = () => {
            showFooterNotification('error', 'Failed to read file');
        };
        if (isJson) {
            reader.readAsText(file);
        } else {
            reader.readAsArrayBuffer(file);
        }
    }

    /**
     * Render the Postman options panel from the manager's preview payload.
     * Only wires listeners on the first upload — option toggles dispatch
     * postmanOptionsChanged back to the manager which re-runs prepareImport.
     */
    function renderPostmanOptionsPanel(opts) {
        const panel = document.getElementById('postmanOptionsPanel');
        if (!panel) return;

        if (!opts || !opts.showPanel) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');

        const summary = document.getElementById('postmanOptionsSummary');
        if (summary) {
            summary.textContent =
                `Collection: ${opts.collectionName} — ${opts.endpointCount} endpoint${opts.endpointCount === 1 ? '' : 's'}`;
        }

        renderPostmanUnsupportedFeatures(opts.unsupportedFeatures || []);

        const headersCheckbox = document.getElementById('postmanIncludeHeaders');
        const headerHint = document.getElementById('postmanHeaderHint');
        if (headersCheckbox) headersCheckbox.checked = !!opts.includeHeaders;
        if (headerHint) {
            headerHint.textContent = opts.includeHeaders
                ? `(${opts.headerCount} header${opts.headerCount === 1 ? '' : 's'} included)`
                : '(headers omitted — environment headers will apply at request time)';
        }

        const collectionFoldersHint = document.getElementById('postmanCollectionFoldersHint');
        if (collectionFoldersHint) {
            collectionFoldersHint.textContent = opts.detectedFolders && opts.detectedFolders.length
                ? `(${opts.detectedFolders.join(', ')})`
                : '(all at root)';
        }

        const datalist = document.getElementById('postmanExistingFolders');
        if (datalist) {
            datalist.innerHTML = '';
            (opts.existingFolders || []).forEach(folder => {
                const optionEl = document.createElement('option');
                optionEl.value = folder;
                datalist.appendChild(optionEl);
            });
        }

        const fromCollectionRadio = document.getElementById('postmanFolderModeFromCollection');
        const allIntoRadio = document.getElementById('postmanFolderModeAllInto');
        const targetFolderInput = document.getElementById('postmanTargetFolder');
        const usingTarget = opts.targetFolder !== null && opts.targetFolder !== undefined;
        if (fromCollectionRadio) fromCollectionRadio.checked = !usingTarget;
        if (allIntoRadio) allIntoRadio.checked = usingTarget;
        if (targetFolderInput) {
            targetFolderInput.disabled = !usingTarget;
            if (usingTarget) targetFolderInput.value = opts.targetFolder || '';
        }

        if (opts.firstUpload) {
            wirePostmanOptionListeners();
        }
    }

    /**
     * Render the contextual data-loss warning. Only shows what the parser
     * actually found — empty list = the warning block stays hidden.
     */
    function renderPostmanUnsupportedFeatures(features) {
        const wrap = document.getElementById('postmanUnsupportedFeatures');
        const list = document.getElementById('postmanUnsupportedList');
        if (!wrap || !list) return;

        list.innerHTML = '';

        if (!features.length) {
            wrap.classList.add('hidden');
            return;
        }
        wrap.classList.remove('hidden');

        for (const f of features) {
            const li = document.createElement('li');
            li.className = 'postman-unsupported-item';

            const label = document.createElement('span');
            label.className = 'postman-unsupported-item-label';
            label.textContent = f.label;
            li.appendChild(label);

            if (f.detail) {
                const detail = document.createElement('span');
                detail.className = 'postman-unsupported-item-detail';
                detail.textContent = ` (${f.detail})`;
                li.appendChild(detail);
            }
            list.appendChild(li);
        }
    }

    /**
     * Build a small "data loss" chip for a Postman-imported endpoint.
     * Returns null if this endpoint has nothing to lose. The tooltip lists
     * exactly what's being dropped from this specific endpoint.
     */
    function buildPostmanLossChip(endpointId) {
        const loss = state.postmanLostByEndpointId[endpointId];
        if (!loss) return null;

        const lines = [];
        if (loss.preRequestScripts > 0) {
            lines.push(`${loss.preRequestScripts} pre-request script${loss.preRequestScripts === 1 ? '' : 's'}`);
        }
        if (loss.testScripts > 0) {
            lines.push(`${loss.testScripts} test script${loss.testScripts === 1 ? '' : 's'}`);
        }
        if (loss.savedExamples > 0) {
            lines.push(`${loss.savedExamples} saved response example${loss.savedExamples === 1 ? '' : 's'}`);
        }
        if (loss.nonRawBodyMode) {
            lines.push(`body mode "${loss.nonRawBodyMode}" (only raw bodies are imported)`);
        }
        if (loss.nonBearerAuthType) {
            lines.push(`auth type "${loss.nonBearerAuthType}" (configure on Environment instead)`);
        }
        if (loss.deeplyNested) {
            lines.push('flattened from deeper folder nesting');
        }
        if (lines.length === 0) return null;

        const chip = document.createElement('span');
        chip.className = 'postman-loss-chip';
        chip.title = 'Data not imported from this endpoint:\n• ' + lines.join('\n• ');

        const icon = document.createElement('span');
        icon.className = 'postman-loss-chip-icon';
        icon.textContent = '⚠';
        chip.appendChild(icon);

        const text = document.createElement('span');
        text.className = 'postman-loss-chip-text';
        text.textContent = 'data dropped';
        chip.appendChild(text);

        return chip;
    }

    function wirePostmanOptionListeners() {
        const headersCheckbox = document.getElementById('postmanIncludeHeaders');
        const fromCollectionRadio = document.getElementById('postmanFolderModeFromCollection');
        const allIntoRadio = document.getElementById('postmanFolderModeAllInto');
        const targetFolderInput = document.getElementById('postmanTargetFolder');

        let debounce = null;
        const dispatchOptions = () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                const includeHeaders = headersCheckbox ? headersCheckbox.checked : true;
                const useTarget = allIntoRadio && allIntoRadio.checked;
                const targetFolder = useTarget
                    ? (targetFolderInput ? (targetFolderInput.value || '') : '')
                    : undefined;
                vscode.postMessage({
                    type: 'postmanOptionsChanged',
                    payload: { includeHeaders, targetFolder }
                });
                showFooterNotification('info', 'Updating preview...');
            }, 150);
        };

        if (headersCheckbox) headersCheckbox.addEventListener('change', () => {
            if (headersCheckbox.checked) {
                // Going from off → on: ask the backend to confirm via a VS Code modal.
                // Backend re-parses + pushes a fresh preview if confirmed; if cancelled it
                // sends postmanIncludeHeadersReverted which un-ticks the box again.
                vscode.postMessage({ type: 'confirmIncludeHeaders' });
            } else {
                dispatchOptions();
            }
        });
        if (fromCollectionRadio) fromCollectionRadio.addEventListener('change', () => {
            if (targetFolderInput) targetFolderInput.disabled = true;
            dispatchOptions();
        });
        if (allIntoRadio) allIntoRadio.addEventListener('change', () => {
            if (targetFolderInput) targetFolderInput.disabled = false;
            dispatchOptions();
        });
        if (targetFolderInput) targetFolderInput.addEventListener('input', dispatchOptions);
    }

    /**
     * Handle import button click
     */
    /**
     * Handle import - send only selected items
     * GitHub Issue #90: User explicitly approves what to import
     */
    function handleImport() {
        // Filter to only selected items
        const selectedItems = state.importItems.filter(item =>
            state.selectedItems.has(item.importItem.id)
        );

        console.log('[handleImport] Importing items:', {
            total: selectedItems.length,
            create: selectedItems.filter(i => i.action === 'create').length,
            update: selectedItems.filter(i => i.action === 'update').length,
            conflict: selectedItems.filter(i => i.action === 'conflict').length
        });

        vscode.postMessage({
            type: 'executeImport',
            payload: {
                selectedItems: selectedItems
            }
        });
    }

    /**
     * Display conflicts for resolution
     */
    /**
     * Display all import items with checkboxes in folder structure
     * GitHub Issue #90: Show ALL items, user selects what to import
     * Uses same folder structure as export for consistency
     */
    function displayImportItems(items) {
        console.log('[displayImportItems] Received items:', items);

        // Initialize selectedItems - conflicts NOT selected by default
        state.selectedItems.clear();
        state.importItems = items; // Store for later use
        items.forEach(item => {
            // Only add to selectedItems if NOT a conflict
            if (item.action !== 'conflict') {
                state.selectedItems.add(item.importItem.id);
            }
        });

        // Separate items by type
        const endpoints = items.filter(item => item.type === 'endpoint');
        const environments = items.filter(item => item.type === 'environment');

        // Group each type by folder
        const endpointsByFolder = groupImportItemsByFolder(endpoints);
        const environmentsByFolder = groupImportItemsByFolder(environments);

        // Build checkbox trees (reuse same pattern as export)
        buildImportCheckboxTree('importEndpointTree', endpointsByFolder, 'endpoints');
        buildImportCheckboxTree('importEnvironmentTree', environmentsByFolder, 'environments');
    }

    /**
     * Group import items by folder
     */
    function groupImportItemsByFolder(items) {
        const grouped = {
            '': [] // Root folder
        };

        for (const item of items) {
            const folder = item.importItem.folder || '';
            if (!grouped[folder]) {
                grouped[folder] = [];
            }
            grouped[folder].push(item);
        }

        return grouped;
    }

    /**
     * Build import checkbox tree with action badges
     * Similar to buildCheckboxTree but includes action badges and conflict resolution
     */
    function buildImportCheckboxTree(containerId, itemsByFolder, type) {
        console.log(`[buildImportCheckboxTree] containerId=${containerId}, type=${type}`);

        const container = document.getElementById(containerId);
        if (!container) {
            console.warn(`[buildImportCheckboxTree] Container not found: ${containerId}`);
            return;
        }

        container.innerHTML = '';

        // Get folders sorted (empty string first for root)
        const folders = Object.keys(itemsByFolder).sort((a, b) => {
            if (a === '') return -1;
            if (b === '') return 1;
            return a.localeCompare(b);
        });

        folders.forEach(folder => {
            const items = itemsByFolder[folder];
            if (items.length === 0) return;

            // Create folder group
            const folderDiv = document.createElement('div');
            folderDiv.className = 'folder-group';

            // Folder header with checkbox
            const folderHeader = document.createElement('div');
            folderHeader.className = 'folder-header';

            const folderCheckbox = document.createElement('input');
            folderCheckbox.type = 'checkbox';
            folderCheckbox.checked = true; // All checked by default
            folderCheckbox.id = `folder-import-${type}-${folder}`;
            folderCheckbox.addEventListener('change', (e) => {
                toggleImportFolderSelection(type, folder, e.target.checked);
            });

            const folderLabel = document.createElement('label');
            folderLabel.htmlFor = folderCheckbox.id;
            folderLabel.textContent = folder === '' ? 'Root' : folder;
            folderLabel.className = 'folder-label';

            folderHeader.appendChild(folderCheckbox);
            folderHeader.appendChild(folderLabel);
            folderDiv.appendChild(folderHeader);

            // Items in folder
            const itemsList = document.createElement('div');
            itemsList.className = 'folder-items';

            items.forEach((importItem, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'checkbox-item';

                const itemCheckbox = document.createElement('input');
                itemCheckbox.type = 'checkbox';
                // All items start checked and enabled
                itemCheckbox.checked = importItem.selected !== false;
                itemCheckbox.disabled = false;
                itemCheckbox.id = `import-item-${type}-${importItem.importItem.id}-${index}`;
                itemCheckbox.dataset.folder = folder;
                itemCheckbox.dataset.type = type;
                itemCheckbox.dataset.itemId = importItem.importItem.id;
                itemCheckbox.addEventListener('change', (e) => {
                    toggleImportItemSelection(importItem.importItem.id, e.target.checked);
                    updateImportFolderCheckbox(type, folder);
                });

                const itemLabel = document.createElement('label');
                itemLabel.htmlFor = itemCheckbox.id;
                itemLabel.className = 'item-label';
                itemLabel.style.display = 'flex';
                itemLabel.style.alignItems = 'center';
                itemLabel.style.gap = '8px';
                itemLabel.style.flexWrap = 'wrap';

                // Editable name input
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'import-item-name-input';
                nameInput.value = importItem.importItem.name;
                nameInput.style.border = '1px solid var(--vscode-input-border)';
                nameInput.style.background = 'var(--vscode-input-background)';
                nameInput.style.color = 'var(--vscode-input-foreground)';
                nameInput.style.padding = '2px 6px';
                nameInput.style.fontSize = '13px';
                nameInput.style.minWidth = '150px';
                nameInput.style.flex = '1';
                nameInput.addEventListener('input', (e) => {
                    importItem.importItem.name = e.target.value;
                    // Dynamically update action based on name+folder
                    checkDynamicAction(importItem, itemCheckbox, actionBadge);
                });
                nameInput.addEventListener('click', (e) => {
                    e.stopPropagation(); // Don't trigger label click
                });

                // Folder label + editable input
                if (importItem.importItem.folder !== undefined) {
                    const folderLabel = document.createElement('span');
                    folderLabel.textContent = 'in';
                    folderLabel.style.fontSize = '11px';
                    folderLabel.style.color = 'var(--vscode-descriptionForeground)';
                    itemLabel.appendChild(folderLabel);

                    const folderInput = document.createElement('input');
                    folderInput.type = 'text';
                    folderInput.className = 'import-item-folder-input';
                    folderInput.value = importItem.importItem.folder || 'Root';
                    folderInput.style.border = '1px solid var(--vscode-input-border)';
                    folderInput.style.background = 'var(--vscode-input-background)';
                    folderInput.style.color = 'var(--vscode-input-foreground)';
                    folderInput.style.padding = '2px 6px';
                    folderInput.style.fontSize = '11px';
                    folderInput.style.width = '100px';
                    folderInput.addEventListener('input', (e) => {
                        importItem.importItem.folder = e.target.value === 'Root' ? '' : e.target.value;
                        // Dynamically update action based on name+folder
                        checkDynamicAction(importItem, itemCheckbox, actionBadge);
                    });
                    folderInput.addEventListener('click', (e) => {
                        e.stopPropagation(); // Don't trigger label click
                    });
                    itemLabel.appendChild(folderInput);
                }

                itemLabel.appendChild(nameInput);

                // Action badge
                const actionBadge = document.createElement('span');
                actionBadge.className = `import-item-action ${importItem.action}`;
                actionBadge.textContent = importItem.action.toUpperCase();
                itemLabel.appendChild(actionBadge);

                // Endpoint names are unique, so the backend renamed a clashing one
                if (importItem.renamedFrom) {
                    const renamedNote = document.createElement('span');
                    renamedNote.className = 'import-item-renamed';
                    renamedNote.textContent = `renamed from "${importItem.renamedFrom}" — name already in use`;
                    itemLabel.appendChild(renamedNote);
                }

                // Per-endpoint data-loss flag (issue #189)
                const lossChip = buildPostmanLossChip(importItem.importItem.id);
                if (lossChip) itemLabel.appendChild(lossChip);

                itemDiv.appendChild(itemCheckbox);
                itemDiv.appendChild(itemLabel);

                itemsList.appendChild(itemDiv);
            });

            folderDiv.appendChild(itemsList);
            container.appendChild(folderDiv);
        });
    }

    /**
     * Check if conflict is resolved by comparing current values to original
     * Update checkbox state and action badge accordingly
     */
    /**
     * Check if the current name+folder exists in existing items
     * Dynamically update action between CREATE and UPDATE
     */
    function checkDynamicAction(importItem, checkbox, actionBadge) {
        const currentName = importItem.importItem.name;
        const currentFolder = importItem.importItem.folder || '';
        const itemType = importItem.type;

        // Get the appropriate existing items list
        const existingItems = itemType === 'endpoint' ? state.existingEndpoints : state.existingEnvironments;

        // Check if this name+folder combination exists
        const exists = existingItems.some(item =>
            item.name.toLowerCase() === currentName.toLowerCase() &&
            (item.folder || '') === currentFolder
        );

        if (exists) {
            // Name+folder exists → UPDATE
            if (importItem.action !== 'update') {
                importItem.action = 'update';
                actionBadge.className = 'import-item-action update';
                actionBadge.textContent = 'UPDATE';
                console.log(`[checkDynamicAction] Changed to UPDATE: ${currentName} in ${currentFolder || 'Root'}`);
            }
        } else {
            // Name+folder doesn't exist → CREATE
            if (importItem.action !== 'create') {
                importItem.action = 'create';
                actionBadge.className = 'import-item-action create';
                actionBadge.textContent = 'CREATE';
                console.log(`[checkDynamicAction] Changed to CREATE: ${currentName} in ${currentFolder || 'Root'}`);
            }
        }

        // Always enable checkbox (no more disabled conflicts)
        checkbox.disabled = false;
    }

    /**
     * Toggle import item selection
     */
    function toggleImportItemSelection(itemId, selected) {
        if (selected) {
            state.selectedItems.add(itemId);
        } else {
            state.selectedItems.delete(itemId);
        }
        console.log(`[toggleImportItemSelection] itemId=${itemId}, selected=${selected}, total=${state.selectedItems.size}`);
    }

    /**
     * Toggle import folder selection
     */
    function toggleImportFolderSelection(type, folder, selected) {
        const checkboxes = document.querySelectorAll(
            `input[type="checkbox"][data-type="${type}"][data-folder="${folder}"]:not([id^="folder-"])`
        );

        checkboxes.forEach(checkbox => {
            if (checkbox.checked !== selected) {
                checkbox.checked = selected;
                const itemId = checkbox.dataset.itemId;
                if (itemId) {
                    toggleImportItemSelection(itemId, selected);
                }
            }
        });
    }

    /**
     * Update import folder checkbox based on child items
     */
    function updateImportFolderCheckbox(type, folder) {
        const checkboxes = Array.from(document.querySelectorAll(
            `input[type="checkbox"][data-type="${type}"][data-folder="${folder}"]:not([id^="folder-"])`
        ));

        if (checkboxes.length === 0) return;

        const allChecked = checkboxes.every(cb => cb.checked);
        const someChecked = checkboxes.some(cb => cb.checked);

        const folderCheckbox = document.getElementById(`folder-import-${type}-${folder}`);
        if (folderCheckbox) {
            folderCheckbox.checked = allChecked;
            folderCheckbox.indeterminate = someChecked && !allChecked;
        }
    }

    /**
     * Select all import items of a type
     */
    function selectAllImport(type) {
        document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]:not([id^="folder-"])`).forEach(checkbox => {
            if (!checkbox.checked) {
                checkbox.checked = true;
                const itemId = checkbox.dataset.itemId;
                if (itemId) {
                    toggleImportItemSelection(itemId, true);
                }
            }
        });

        // Update folder checkboxes
        const folders = new Set(
            Array.from(document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]:not([id^="folder-"])`))
                .map(cb => cb.dataset.folder)
        );
        folders.forEach(folder => updateImportFolderCheckbox(type, folder));
    }

    /**
     * Deselect all import items of a type
     */
    function deselectAllImport(type) {
        document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]:not([id^="folder-"])`).forEach(checkbox => {
            if (checkbox.checked) {
                checkbox.checked = false;
                const itemId = checkbox.dataset.itemId;
                if (itemId) {
                    toggleImportItemSelection(itemId, false);
                }
            }
        });

        // Update folder checkboxes
        const folders = new Set(
            Array.from(document.querySelectorAll(`input[type="checkbox"][data-type="${type}"]:not([id^="folder-"])`))
                .map(cb => cb.dataset.folder)
        );
        folders.forEach(folder => updateImportFolderCheckbox(type, folder));
    }

    /** Auto-hide timer for notifications */
    let notificationTimer = null;

    /**
     * Get the active footer notification container based on current page
     */
    function getFooterNotificationContainer() {
        if (state.currentPage === 'export') {
            return document.getElementById('exportFooterNotification');
        }
        return document.getElementById('importFooterNotification');
    }

    /**
     * Show footer notification (matches console webview pattern exactly)
     * Uses shared footer-notification styles from tables.css
     * @param {string} type - 'error' | 'warning' | 'success' | 'info'
     * @param {string} message - The message to display
     * @param {object} options - { persistent: true } to prevent auto-hide
     */
    // Delegates to the shared fixed-overlay DbmnToast (no content shift).
    function showFooterNotification(type, message, options = {}) {
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message, {
                durationMs: options.duration,
                persistent: options.persistent,
                shake: options.shake,
                dismissible: options.dismissible
            });
        }
    }

    /**
     * Clear/dismiss the footer notification
     */
    function clearFooterNotification() {
        const container = getFooterNotificationContainer();
        if (container) {
            container.className = 'footer-notification hidden';
        }
        if (notificationTimer) {
            clearTimeout(notificationTimer);
            notificationTimer = null;
        }
    }

    // Expose to global scope for onclick handler
    window.clearFooterNotification = clearFooterNotification;

    /**
     * Show export success page
     */
    function showExportSuccess(result) {
        // Hide other pages
        document.getElementById('landingPage')?.classList.remove('active');
        document.getElementById('exportPage')?.classList.remove('active');
        document.getElementById('importPage')?.classList.remove('active');

        // Show success page
        const successPage = document.getElementById('successPage');
        successPage?.classList.add('active');

        // Set title and message
        document.getElementById('successTitle').textContent = 'Export Successful!';
        document.getElementById('successMessage').textContent =
            `Your configuration has been exported to a ZIP file.`;

        // Build summary
        const summaryHtml = `
            <h3>Export Summary</h3>
            <div class="success-summary-row">
                <span class="success-summary-label">Endpoints Exported</span>
                <span class="success-summary-value">${result.itemCount?.endpoints || 0}</span>
            </div>
            <div class="success-summary-row">
                <span class="success-summary-label">Environments Exported</span>
                <span class="success-summary-value">${result.itemCount?.environments || 0}</span>
            </div>
            ${result.itemCount?.reportSettings ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Report Settings Exported</span>
                <span class="success-summary-value">${result.itemCount.reportSettings}</span>
            </div>` : ''}
        `;
        document.getElementById('successSummary').innerHTML = summaryHtml;

        // Build details with file path
        const fileName = result.filePath.substring(result.filePath.lastIndexOf('/') + 1);
        const detailsHtml = `
            <h4>File Location</h4>
            <p><code>${fileName}</code></p>
            <p style="font-size: 11px; margin-top: 10px;">${result.filePath}</p>
        `;
        document.getElementById('successDetails').innerHTML = detailsHtml;

        // #289: say plainly whether the file carries credentials.
        // textContent, not innerHTML — environment names are user-supplied.
        const credentialsNote = document.createElement('p');
        credentialsNote.style.fontSize = '11px';
        credentialsNote.style.marginTop = '10px';
        if (result.credentialsIncluded) {
            credentialsNote.textContent =
                '⚠️ This file contains environment credentials — treat it like a password and keep it out of source control.';
        } else if (result.redactedEnvironments && result.redactedEnvironments.length) {
            credentialsNote.textContent =
                `Credentials were removed from: ${result.redactedEnvironments.join(', ')}. Recipients enter their own after importing.`;
        }
        if (credentialsNote.textContent) {
            document.getElementById('successDetails').appendChild(credentialsNote);
        }

        // Show "Open Folder" button and store file path
        const openLocationBtn = document.getElementById('openLocation');
        if (openLocationBtn) {
            openLocationBtn.style.display = 'inline-block';
            openLocationBtn.dataset.filePath = result.filePath;
        }
    }

    /**
     * Show import success page
     */
    function showImportSuccess(result) {
        // Hide other pages
        document.getElementById('landingPage')?.classList.remove('active');
        document.getElementById('exportPage')?.classList.remove('active');
        document.getElementById('importPage')?.classList.remove('active');

        // Show success page
        const successPage = document.getElementById('successPage');
        successPage?.classList.add('active');

        // Set title and message — a partial import lists its failures below the summary
        const failures = result.errors || [];
        document.getElementById('successTitle').textContent =
            failures.length ? 'Import Finished With Errors' : 'Import Successful!';
        document.getElementById('successMessage').textContent = failures.length
            ? `${failures.length} item${failures.length === 1 ? '' : 's'} could not be imported. Everything else was imported.`
            : `Your configuration has been imported into Dobermann.`;

        // Build summary with breakdown
        const endpointDetails = result.details?.endpoints || {};
        const envDetails = result.details?.environments || {};

        const summaryHtml = `
            <h3>Import Summary</h3>
            ${endpointDetails.created > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Endpoints Created</span>
                <span class="success-summary-value">${endpointDetails.created}</span>
            </div>` : ''}
            ${endpointDetails.updated > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Endpoints Updated</span>
                <span class="success-summary-value">${endpointDetails.updated}</span>
            </div>` : ''}
            ${endpointDetails.skipped > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Endpoints Skipped</span>
                <span class="success-summary-value">${endpointDetails.skipped}</span>
            </div>` : ''}
            ${envDetails.created > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Environments Created</span>
                <span class="success-summary-value">${envDetails.created}</span>
            </div>` : ''}
            ${envDetails.updated > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Environments Updated</span>
                <span class="success-summary-value">${envDetails.updated}</span>
            </div>` : ''}
            ${envDetails.skipped > 0 ? `
            <div class="success-summary-row">
                <span class="success-summary-label">Environments Skipped</span>
                <span class="success-summary-value">${envDetails.skipped}</span>
            </div>` : ''}
        `;
        document.getElementById('successSummary').innerHTML = summaryHtml;

        // textContent, not innerHTML — reasons carry names from the imported file
        if (failures.length) {
            const failureBlock = document.createElement('div');
            failureBlock.className = 'import-failures';
            const heading = document.createElement('h4');
            heading.textContent = 'Not Imported';
            const list = document.createElement('ul');
            failures.forEach(reason => {
                const entry = document.createElement('li');
                entry.textContent = reason;
                list.appendChild(entry);
            });
            failureBlock.appendChild(heading);
            failureBlock.appendChild(list);
            document.getElementById('successSummary').appendChild(failureBlock);
        }

        // #289: environments that arrived without credentials need re-keying
        const warnings = result.warnings || [];
        if (warnings.length) {
            const warningBlock = document.createElement('div');
            warningBlock.className = 'import-failures';
            const warningHeading = document.createElement('h4');
            warningHeading.textContent = 'Needs Attention';
            const warningList = document.createElement('ul');
            warnings.forEach(note => {
                const entry = document.createElement('li');
                entry.textContent = note;
                warningList.appendChild(entry);
            });
            warningBlock.appendChild(warningHeading);
            warningBlock.appendChild(warningList);
            document.getElementById('successSummary').appendChild(warningBlock);
        }

        // Build details
        const totalImported = (endpointDetails.created || 0) + (endpointDetails.updated || 0) +
                              (envDetails.created || 0) + (envDetails.updated || 0);
        const detailsHtml = `
            <h4>What's Next?</h4>
            <p>The imported items are now available in the Dobermann Explorer.</p>
            ${totalImported > 0 ? '<p>New items have been created with unique IDs.</p>' : ''}
        `;
        document.getElementById('successDetails').innerHTML = detailsHtml;

        // Hide "Open Folder" button for import
        const openLocationBtn = document.getElementById('openLocation');
        if (openLocationBtn) {
            openLocationBtn.style.display = 'none';
        }
    }

    /**
     * Notify extension that webview is ready
     */
    function notifyReady() {
        vscode.postMessage({ type: 'ready' });
    }

    /**
     * Handle messages from extension
     */
    window.addEventListener('message', (event) => {
        const message = event.data;

        switch (message.type) {
            case 'initialized':
                state.endpoints = message.payload.endpoints;
                state.environments = message.payload.environments;
                buildCheckboxTree('endpointTree', state.endpoints, 'endpoints');
                buildCheckboxTree('environmentTree', state.environments, 'environments');
                // Caller asked for a specific page (Hub > Import / Hub > Export):
                // skip the landing chooser and jump straight there.
                if (message.payload.startMode === 'import' || message.payload.startMode === 'export') {
                    navigateToPage(message.payload.startMode);
                }
                break;

            case 'importPreview':
                // Store import items (all items with their actions)
                state.importItems = message.payload.importPreview.items;
                state.existingEndpoints = message.payload.importPreview.existingEndpoints || [];
                state.existingEnvironments = message.payload.importPreview.existingEnvironments || [];

                console.log('[importPreview] Received items:', {
                    total: state.importItems.length,
                    endpoints: state.importItems.filter(i => i.type === 'endpoint').length,
                    environments: state.importItems.filter(i => i.type === 'environment').length,
                    create: state.importItems.filter(i => i.action === 'create').length,
                    update: state.importItems.filter(i => i.action === 'update').length,
                    existingEndpoints: state.existingEndpoints.length,
                    existingEnvironments: state.existingEnvironments.length
                });

                // Postman options panel (issue #189) - only present for Postman uploads
                state.postmanLostByEndpointId =
                    (message.payload.postmanOptions && message.payload.postmanOptions.lostByEndpointId) || {};
                renderPostmanOptionsPanel(message.payload.postmanOptions);

                // Display all import items
                displayImportItems(state.importItems);

                // Show conflicts section (now showing all items)
                document.getElementById('uploadSection')?.classList.remove('active');
                document.getElementById('conflictsSection')?.classList.add('active');
                // Enable import button now that we have valid items
                const importBtn = document.getElementById('executeImport');
                if (importBtn) importBtn.disabled = false;
                showFooterNotification('success', 'File processed successfully');
                break;

            case 'validationError':
                const errorMessages = message.payload.errors.map(e => typeof e === 'object' ? e.message : e);
                showFooterNotification('error', `Validation failed: ${errorMessages.join(', ')}`);
                break;

            case 'importError':
                showFooterNotification('error', message.payload.error);
                break;

            case 'exportError':
                showFooterNotification('error', message.payload.error);
                break;

            case 'importComplete':
                showImportSuccess(message.payload.result);
                break;

            case 'exportComplete':
                showExportSuccess(message.payload.result);
                break;

            case 'postmanIncludeHeadersReverted':
                // User cancelled the warning modal — un-tick the checkbox.
                const revertedCheckbox = document.getElementById('postmanIncludeHeaders');
                if (revertedCheckbox) revertedCheckbox.checked = false;
                const revertedHint = document.getElementById('postmanHeaderHint');
                if (revertedHint) {
                    revertedHint.textContent = '(headers omitted — environment headers will apply at request time)';
                }
                clearFooterNotification();
                break;
        }
    });
})();
