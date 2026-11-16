// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #197: Batch Actions Module
 *
 * Handles action buttons (delete, copy, reprocess, rerun, cancel, pause, resume, stop),
 * button visibility management, and utility functions for the execution report webview.
 *
 * Architecture Compliance:
 * - Extracted from inline JavaScript in report.html
 * - Follows same pattern as raw-tab-handler.js
 * - Template variables passed via constructor config (no {{...}} in module)
 * - Uses window.vscode for postMessage, window.currentBatchId/currentExecutionId for dynamic state
 */

class BatchActions {
    constructor(config) {
        this.executionId = config.executionId;
        this.batchId = config.batchId;
        this.reportType = config.reportType;
        this.executionStatus = config.executionStatus;
        this.vscode = config.vscode;
    }

    // ===== ACTION FUNCTIONS =====

    deleteTransaction() {
        const deleteBtn = document.getElementById('delete-transaction-btn');
        if (deleteBtn.disabled) return; // Prevent double-clicking

        // Disable button immediately and show processing state
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting...';
        deleteBtn.style.opacity = '0.6';

        // Send semantic delete message handled directly by the console backend
        this.vscode.postMessage({
            type: 'deleteTransaction',
            payload: {
                id: this.executionId,
                executionId: this.executionId,
                batchId: this.batchId || undefined,
                isBatch: this.reportType === 'batch'
            }
        });
    }

    reprocessBatch() {
        this.vscode.postMessage({
            type: 'reprocessBatch',
            payload: {
                id: this.batchId,
                executionId: this.executionId,
                batchId: this.batchId,
                isBatch: true
            }
        });
    }

    /**
     * GitHub Issue #94: Fetch next page for paginated batches
     */
    fetchNextPage() {
        const nextPageBtn = document.getElementById('next-page-btn');
        if (nextPageBtn.disabled) return; // Prevent double-clicking

        // Disable button immediately
        nextPageBtn.disabled = true;
        nextPageBtn.innerHTML = window.Icons.label('loader', 'Fetching...', 'btn-icon');
        nextPageBtn.style.opacity = '0.6';

        // Send message to backend to create next batch_member
        this.vscode.postMessage({
            type: 'fetchNextPage',
            correlationId: `fetch_next_page_${Date.now()}`,
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: {
                batchId: this.batchId,
                executionId: this.executionId
            }
        });
    }

    rerunTransaction() {
        const rerunBtn = document.getElementById('rerun-transaction-btn');
        if (rerunBtn.disabled) return; // Prevent double-clicking

        // Disable button immediately and show processing state
        rerunBtn.disabled = true;
        rerunBtn.innerHTML = window.Icons.label('refresh-cw', 'Re-running...', 'btn-icon');
        rerunBtn.style.opacity = '0.6';

        // Send semantic rerun message handled directly by the console backend
        this.vscode.postMessage({
            type: 'rerunTransaction',
            payload: {
                id: this.executionId,
                executionId: this.executionId
            }
        });
    }

    cancelExecution() {
        this.vscode.postMessage({
            type: 'cancel_execution',
            timestamp: Date.now()
        });
    }

    pauseBatch() {
        this.vscode.postMessage({
            type: 'pauseBatch',
            payload: {
                id: window.currentBatchId,
                executionId: window.currentExecutionId,
                batchId: window.currentBatchId,
                isBatch: true
            }
        });
    }

    resumeBatch() {
        this.vscode.postMessage({
            type: 'resumeBatch',
            payload: {
                id: window.currentBatchId,
                executionId: window.currentExecutionId,
                batchId: window.currentBatchId,
                isBatch: true
            }
        });
    }

    // ===== BUTTON MANAGEMENT =====

    /**
     * Show/hide transaction-specific buttons based on report type and status
     * GitHub Issue #151: Button visibility follows same logic as tree context menus
     */
    updateTransactionButtons() {
        const isBatch = this.reportType === 'batch';
        const status = this.executionStatus.toLowerCase();
        if (window.ConsoleChain) window.ConsoleChain.onStatus(status);   // GitHub Issue #247
        const reprocessBtn = document.getElementById('reprocess-batch-btn');
        const resumeBtn = document.getElementById('resume-batch-btn');
        const rerunBtn = document.getElementById('rerun-transaction-btn');
        const nextPageBtn = document.getElementById('next-page-btn');
        const deleteBtn = document.getElementById('delete-transaction-btn');
        const paginationBtn = document.getElementById('pagination-btn');

        // Issue #314: the static buttons follow the shared rule set (execution-actions.js),
        // the same one the History list's right-click menu reads. Active states leave
        // the dynamic buttons (Pause/Cancel/Resume) to updateButtonVisibility.
        const actions = window.ExecutionActions.visibleActions(status, isBatch);
        const show = (btn, on) => { if (btn) btn.classList.toggle('hidden', !on); };
        show(rerunBtn, actions.includes('rerun'));
        show(reprocessBtn, actions.includes('reprocess'));
        show(resumeBtn, actions.includes('resume'));
        if (actions.includes('delete')) show(deleteBtn, true);

        if (isBatch) {
            // GitHub Issue #198: Pagination button for paginated batches (completed only)
            if (paginationBtn) {
                if (window.paginationMetadata?.enabled &&
                    (status === 'completed' || status === 'error')) {
                    paginationBtn.classList.remove('hidden');
                } else {
                    paginationBtn.classList.add('hidden');
                }
            }
        } else {
            // GitHub Issue #198/#245: Pagination button on individual executions only for GET.
            // The from-scratch setup is query-param based (GET). POST pagination is body
            // template-driven (becomes a batch, handled by the batch path above); plain POSTs
            // are data-creation runs that shouldn't offer pagination.
            if (paginationBtn) {
                if ((window.currentRequestMethod || '').toUpperCase() === 'GET') {
                    paginationBtn.classList.remove('hidden');
                } else {
                    paginationBtn.classList.add('hidden');
                }
            }
        }

        // GitHub Issue #94: Next Page button hidden by default
        // Updated by handlePaginationMetadata() when batch data loads
        if (nextPageBtn) nextPageBtn.classList.add('hidden');
    }

    /**
     * Update button visibility based on execution phase/status
     * Called during live execution updates
     */
    updateButtonVisibility(phase) {
        // Hide all dynamic buttons first
        const dynamicButtons = [
            'cancel-preparation-btn',
            'pause-batch-btn',
            'resume-batch-btn'
        ];
        dynamicButtons.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('hidden');
        });

        // Hide static buttons during active execution
        const staticButtons = [
            'delete-transaction-btn',
            'rerun-transaction-btn',
            'reprocess-batch-btn'
        ];

        // Issue #314: ONE rule set, shared with the History list's right-click menu
        const isBatchExecution = !!window.currentBatchId;
        const actions = window.ExecutionActions.visibleActions(phase, isBatchExecution);
        const byAction = {
            delete: 'delete-transaction-btn', rerun: 'rerun-transaction-btn',
            reprocess: 'reprocess-batch-btn', resume: 'resume-batch-btn', pause: 'pause-batch-btn', cancel: 'cancel-preparation-btn'
        };
        staticButtons.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.add('hidden');
        });
        actions.forEach(action => {
            const btn = document.getElementById(byAction[action]);
            if (btn) btn.classList.remove('hidden');
        });
        if (actions.includes('cancel')) {
            const cancelBtn = document.getElementById('cancel-preparation-btn');
            if (cancelBtn) {
                cancelBtn.innerHTML = window.Icons.label('square', 'Cancel', 'btn-icon');
                cancelBtn.title = phase === 'preparing' ? 'Cancel preparation'
                    : (phase === 'executing' || phase === 'running') ? 'Cancel: stop now, and cut off the requests in flight' // #335
                    : (phase === 'paused' || phase === 'stopped') ? 'Cancel: stop this batch. Its results stay in History, and Resume carries on later'
                    : 'Cancel — leave the queue without running'; // Issue #309
            }
        }

        // GitHub Issue #156: Update Info tab for status changes
        window.updateInfoTabDuration();
        window.updateInfoTabForStatus(phase);

        // GitHub Issue #198: Pagination button visibility
        const nextPageBtn = document.getElementById('next-page-btn');
        const paginationBtn = document.getElementById('pagination-btn');
        const isBatchExec = !!window.currentBatchId;

        if (phase === 'completed' && window.paginationMetadata && window.paginationMetadata.enabled) {
            // Show "Next Page" button if more pages available
            if (nextPageBtn) {
                if (window.paginationMetadata.hasMorePages) {
                    nextPageBtn.classList.remove('hidden');
                    nextPageBtn.disabled = false;
                } else {
                    nextPageBtn.classList.add('hidden');
                }
            }

            // Show "Pagination" button for completed paginated batches
            if (paginationBtn) {
                paginationBtn.classList.remove('hidden');
            }
        } else if (!isBatchExec && (phase === 'completed' || phase === 'error' || !phase)) {
            // Individual execution: pagination button only for GET (see note above).
            // GitHub Issue #245
            if (paginationBtn) {
                if ((window.currentRequestMethod || '').toUpperCase() === 'GET') {
                    paginationBtn.classList.remove('hidden');
                } else {
                    paginationBtn.classList.add('hidden');
                }
            }
            if (nextPageBtn) nextPageBtn.classList.add('hidden');
        } else {
            // Hide during active execution
            if (nextPageBtn) nextPageBtn.classList.add('hidden');
            if (paginationBtn && isBatchExec) paginationBtn.classList.add('hidden');
        }
    }

    // ===== BUTTON RESET =====

    resetDeleteButton() {
        const deleteBtn = document.getElementById('delete-transaction-btn');
        if (deleteBtn) {
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
            deleteBtn.style.opacity = '1';
        }
    }

    resetRerunButton() {
        const rerunBtn = document.getElementById('rerun-transaction-btn');
        if (rerunBtn) {
            rerunBtn.disabled = false;
            rerunBtn.innerHTML = window.Icons.label('refresh-cw', 'Re-run', 'btn-icon');
            rerunBtn.style.opacity = '1';
        }
    }

    // ===== UTILITY FUNCTIONS =====

    /**
     * GitHub Issue #152: Get error count from report manager
     */
    getErrorCount() {
        if (window.dynamicReportManager && window.dynamicReportManager.rawData) {
            const classified = window.dynamicReportManager.classifyResponses(window.dynamicReportManager.rawData.responses || []);
            return classified.errors?.length || 0;
        }
        return 0;
    }

    /**
     * GitHub Issue #152: Enable/disable export button during running
     */
    setExportButtonEnabled(enabled) {
        const exportBtn = document.getElementById('export-btn');
        if (exportBtn) {
            exportBtn.disabled = !enabled;
            if (enabled) {
                exportBtn.classList.remove('disabled');
                exportBtn.title = '';
            } else {
                exportBtn.classList.add('disabled');
                exportBtn.title = 'Export is only available after batch completion';
            }
        }
    }
}
