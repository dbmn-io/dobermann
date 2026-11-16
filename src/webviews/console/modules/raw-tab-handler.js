// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #166: RAW Tab Handler Module
 *
 * Handles the RAW tab functionality for viewing raw JSON request/response
 * data in the transaction report webview.
 *
 * Architecture Compliance:
 * - Uses existing rawData.responses for response data (same as SUCCESS/ERRORS tabs)
 * - Loads actual request file content from backend for batch transactions
 * - Uses Monaco Editor for JSON display with syntax highlighting and folding
 * - This module handles DOM updates + message passing
 * - No complex frameworks - vanilla JavaScript
 */

class RawTabHandler {
    constructor(reportManager) {
        this.reportManager = reportManager;
        this.state = RawTabHandler.defaultState();
        // Issue #296: the transaction modal opened from Completed/Error rows.
        // null when closed; otherwise { ref, show, el }.
        this.modal = null;
        // LRU cache for loaded request content per execution ID (max 200 entries, ~1MB)
        // Prevents unbounded memory growth for large batches
        this.loadedRequestContent = new Map();
        this.LRU_MAX_ENTRIES = 200;
        // Track if we've requested content loading
        this.contentLoadRequested = false;
        // Incremental content check: skip already-checked transactions
        this.lastContentCheckIndex = 0;
        // Viewport-driven lazy content loading
        this.contentObserver = null;
        this.pendingContentIds = new Set();
        this.pendingContentRequests = new Set(); // In-flight deduplication
        this.contentFlushTimer = null;
        this.CONTENT_BATCH_SIZE = 20;
        // Map sourceFile -> executionId for matching (GitHub Issue #166)
        // Fixes mismatch between rawData.responses execution IDs and database IDs
        this.sourceFileToExecId = new Map();
        // Map executionId -> {rowStart, rows} for CSV data display (GitHub Issue #166)
        this.execIdToRowInfo = new Map();
        // GitHub Issue #201: Map executionId -> {endpointPath, requestHeaders, requestQueryParams}
        this.execIdToEndpointInfo = new Map();
        // Store transaction summaries from backend
        this.transactionSummaries = [];

        // Valid transaction/batch_member statuses (not batch-level statuses)
        // Note: paused and stopped are batch-level only. #335: Cancel cuts off the requests in flight
        this.ALL_STATUSES = [
            'pending',
            'running',
            'completed',
            'error',
            'cancelled',
            'split'
        ];

        // Monaco editor instances - Map<editorId, monaco.editor.IStandaloneCodeEditor>
        this.monacoEditors = new Map();
        // Track if Monaco is ready
        this.monacoReady = false;
        // Queue of editors to create once Monaco is ready
        this.editorQueue = [];

        // Lazy loading: IntersectionObserver for Monaco editors (GitHub Issue #166)
        // Only creates editors when cards scroll into viewport - same pattern as logs/table virtual scroll
        this.editorObserver = null;

        // Lazy card body rendering: only build card bodies when visible
        this.bodyObserver = null;          // IntersectionObserver for building bodies on viewport entry
        this.bodyCleanupObserver = null;   // IntersectionObserver for clearing far-away bodies
        this.renderedBodies = new Set();   // Track which card indices have rendered bodies

        // Chunked rendering: render first batch sync, rest via requestAnimationFrame
        this.INITIAL_RENDER_COUNT = 50;
        this.CHUNK_SIZE = 50;
        this.renderAbortController = null;
    }


    /**
     * Normalize status value to standard format
     * Maps various status strings to the 4 valid transaction statuses
     */
    normalizeStatus(status) {
        if (!status) return 'pending';
        const s = status.toLowerCase().trim();

        // Map to 'completed'
        if (s === 'completed' || s === 'complete' || s === 'success' || s === 'ok') return 'completed';

        // Map to 'error'
        if (s === 'error' || s === 'errors' || s === 'failed' || s === 'fail' || s === 'failure') return 'error';

        // Map to 'split'
        if (s === 'split') return 'split';

        // #335: cut off in flight by Cancel
        if (s === 'cancelled' || s === 'canceled') return 'cancelled';

        // Map to 'running'
        if (s === 'running' || s === 'executing' || s === 'processing' || s === 'in_progress' || s === 'in-progress') return 'running';

        // Map to 'pending'
        if (s === 'pending' || s === 'waiting' || s === 'queued' || s === 'unknown' || s === '') return 'pending';

        // Default unknown statuses to pending
        return 'pending';
    }

    /**
     * Issue #306: one transaction gets a clean, un-nested view — no list
     * chrome, no Transaction #001 card to expand.
     */
    isSingleMode() {
        return this.getTransactions().length === 1;
    }

    /**
     * Resolve the transaction behind a view key. List cards are keyed by
     * their position in the whole list (rawData.responses), which a filter
     * never changes (#431); the transaction modal is 'm'.
     * Every card action goes through here so the same card markup serves
     * the list, the single view and the modal.
     */
    txFor(key) {
        if (key === RawTabHandler.MODAL_KEY) {
            if (!this.modal) return null;
            return this.getTransactions().find(tx => RawTabHandler.txRef(tx) === this.modal.ref) || null;
        }
        return this.getTransactions()[Number(key)] || null;
    }

    /**
     * #431: a list card's key, its transaction's position in the whole list. A live
     * result replaces its stub in place and a new one is added at the end, so a
     * transaction keeps its key while filters, and the cards around it, change.
     */
    keyOf(tx) {
        const all = this.getTransactions();
        let map = this._keyByTx;
        if (!map || this._keyByTxOf !== all || !map.has(tx) || all[map.get(tx)] !== tx) {
            map = new Map();
            all.forEach((t, i) => map.set(t, i));
            this._keyByTx = map;
            this._keyByTxOf = all;
        }
        const key = map.get(tx);
        return key === undefined ? -1 : key;
    }

    /** Database execution ID for a transaction (see sourceFileToExecId). */
    execIdFor(tx) {
        if (!tx) return null;
        const sourceFile = tx.metadata?.sourceFile;
        const mapped = sourceFile ? this.sourceFileToExecId.get(sourceFile) : null;
        if (mapped) return mapped;
        // An individual run has one execution: its own.
        const runMeta = this.reportManager.rawData?.metadata;
        if (runMeta && !runMeta.batchId && runMeta.executionId) return runMeta.executionId;
        return tx.metadata?.executionId || null;
    }

    /** The card element for a view key. List cards live in the Raw tab only. */
    cardFor(key) {
        if (key === RawTabHandler.MODAL_KEY) {
            return this.modal?.el?.querySelector('.raw-card') || null;
        }
        return document.querySelector(`.raw-tab-container .raw-card[data-index="${key}"]`);
    }

    /**
     * Issue #306: the request body for a transaction, or '' once it is known
     * there isn't one. undefined while it is still loading. A `{}` body counts
     * as no body — nothing was sent.
     */
    requestBodyFor(tx) {
        const individual = this.reportManager.rawData?.requestContent;
        if (individual && !RawTabHandler.isEmptyBody(individual)) return individual;
        const execId = this.execIdFor(tx);
        if (execId && this.loadedRequestContent.has(execId)) {
            const body = this.lruGet(execId);
            return RawTabHandler.isEmptyBody(body) ? '' : body;
        }
        // Still on its way if summaries are pending or promise a file to read.
        const loading = this.contentLoadRequested
            && (!this.summariesLoaded || this.transactionSummaries.length > 0);
        return loading ? undefined : '';
    }

    /** HTTP method of the endpoint, from the console header. */
    getRequestMethod() {
        const text = document.getElementById('info-endpoint')?.textContent?.trim() || '';
        const method = text.split(/\s+/)[0] || '';
        return /^[A-Z]+$/.test(method) ? method : '';
    }

    /**
     * Issue #306: effective Input/Request/Response visibility for a view.
     * `null` in the state means "auto": Request is off when there is no body
     * to show, Input is on only for a single transaction that has input rows.
     */
    showFor(key) {
        const isModal = key === RawTabHandler.MODAL_KEY;
        const state = isModal ? this.modal.show : this.state;
        const solo = isModal || this.isSingleMode();
        const tx = solo ? this.txFor(isModal ? key : 0) : null;
        const hasInput = this.hasInputFor(tx);

        let showRequest = state.showRequest;
        if (showRequest === null) {
            if (solo && tx) {
                const body = this.requestBodyFor(tx);
                showRequest = body === undefined
                    ? !RawTabHandler.BODYLESS_METHODS.includes(this.getRequestMethod())
                    : body !== '';
            } else {
                showRequest = !RawTabHandler.BODYLESS_METHODS.includes(this.getRequestMethod());
            }
        }
        let showData = state.showData;
        if (showData === null) showData = solo && hasInput;
        return {
            showData: showData && hasInput,
            showRequest,
            showResponse: state.showResponse,
            hasInput
        };
    }

    /** Whether the Input chip has anything to show for this view. */
    hasInputFor(tx) {
        const inputData = this.reportManager.rawData?.inputData;
        if (!inputData || inputData.length === 0) return false;
        return tx ? this.getCsvRowData(tx, 0).length > 0 : true;
    }

    /**
     * Get transactions from the existing rawData.responses
     * Uses the same data source as SUCCESS and ERRORS tabs
     */
    getTransactions() {
        const rawData = this.reportManager.rawData;
        if (!rawData || !rawData.responses) {
            return [];
        }
        return rawData.responses;
    }

    /**
     * Get status counts from transactions
     * Includes all standard statuses (even with 0 count)
     */
    getStatusCounts() {
        const transactions = this.getTransactions();

        // Initialize all standard statuses with 0
        const counts = {};
        this.ALL_STATUSES.forEach(status => {
            counts[status] = 0;
        });

        // Count actual transactions
        transactions.forEach(tx => {
            const rawStatus = tx.status || tx.metadata?.status || '';
            const status = this.normalizeStatus(rawStatus);
            counts[status] = (counts[status] || 0) + 1;
        });

        return counts;
    }

    /**
     * Render the RAW tab content
     */
    render() {
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        // Hide toolbar and data table — not needed for RAW tab
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        const dataTable = document.getElementById('data-table');
        if (dataTable) dataTable.style.display = 'none';
        tableContainer.classList.remove('hidden');

        // Check for cached content (hidden by cleanupAllTabContent, not destroyed)
        const existing = tableContainer.querySelector('.raw-tab-container');
        if (existing && existing.style.display === 'none') {
            // GitHub Issue #201: If data arrived since last render, discard stale empty-state cache
            const transactions = this.getTransactions();
            const hasEmptyState = existing.querySelector('.raw-empty-state');
            const modeChanged = (existing.dataset.mode === 'single') !== this.isSingleMode();
            if ((hasEmptyState && transactions.length > 0) || modeChanged) {
                existing.remove();
                this.contentLoadRequested = false;
                // Fall through to full render below
            } else {
                // Show cached content — instant tab switch
                existing.style.display = '';
                // Re-setup IntersectionObserver for lazy Monaco loading
                this.setupLazyLoading();
                // Always refresh filter bar counts — data may have changed while tab was hidden
                this.updateFilterBarCounts();
                // Process any new results that arrived while cached
                this._processNewResults();
                return;
            }
        }

        // No cache — full render
        // Dispose any existing Monaco editors first
        this.disposeAllEditors();

        // Remove other custom elements (shouldn't be present, but defensive)
        const existingCodeContainer = tableContainer.querySelector('.code-container');
        if (existingCodeContainer) existingCodeContainer.remove();
        const existingLogsContainer = tableContainer.querySelector('.logs-container');
        if (existingLogsContainer) existingLogsContainer.remove();
        const existingEmptyState = tableContainer.querySelector('.empty-state');
        if (existingEmptyState) existingEmptyState.remove();
        // Remove any leftover raw container (e.g. from stale state)
        if (existing) existing.remove();

        // Create RAW tab container
        const rawContainer = document.createElement('div');
        rawContainer.className = 'raw-tab-container';

        const transactions = this.getTransactions();

        if (transactions.length === 0) {
            rawContainer.innerHTML = `
                <div class="raw-empty-state">
                    <p>No transaction data available</p>
                </div>
            `;
            tableContainer.appendChild(rawContainer);
            return;
        }

        // Ask for request bodies first: whether one is still on its way
        // decides the Request default, and the chips and panes must agree.
        this.loadRequestContent();

        // Issue #312: a running batch opens on its Running transactions (see onExecutionStatus)
        if (this.state.statusFilter === 'all' && !this._statusFilterChosen && transactions.length > 1 && this.isLiveStatus()) {
            this.state.statusFilter = 'running';
            this._autoRunningFilter = true;
        }

        // Build filter bar + first batch of cards (chunked rendering)
        const filtered = this.getFilteredTransactions();
        const initialCount = Math.min(this.INITIAL_RENDER_COUNT, filtered.length);
        const single = this.isSingleMode();
        rawContainer.dataset.mode = single ? 'single' : 'list';
        rawContainer.classList.toggle('raw-single', single);
        // One transaction needs no list bar — its card carries Show and search.
        rawContainer.innerHTML = (single ? '' : this.buildFilterBar()) + this.buildContent(initialCount);
        tableContainer.appendChild(rawContainer);

        // Attach event handlers
        this.attachEventHandlers();

        // Initialize Monaco editors after DOM is ready
        this.initializeMonacoEditors();

        // Render remaining cards in async chunks
        if (filtered.length > initialCount) {
            this.renderRemainingChunks(initialCount, filtered);
        }
    }


    /**
     * Initialize Monaco editors with lazy loading (GitHub Issue #166)
     * Uses IntersectionObserver - same pattern as logs/table virtual scroll
     * Only creates editors when cards scroll into viewport
     */
    initializeMonacoEditors() {
        if (typeof require !== 'undefined' && !this.monacoReady) {
            require(['vs/editor/editor.main'], () => {
                this.monacoReady = true;
                defineVSCodeTheme();
                this.themeObserver = setupMonacoThemeObserver();
                this.setupLazyLoading();
            });
        } else if (this.monacoReady) {
            this.setupLazyLoading();
        }
    }

    /**
     * Setup lazy loading with IntersectionObserver (GitHub Issue #166)
     * Similar to virtual scroll pattern used in logs/tables - only render visible content
     * Two observers: editorObserver for Monaco creation, contentObserver for content fetching
     */
    setupLazyLoading() {
        // Clean up existing observers
        if (this.editorObserver) {
            this.editorObserver.disconnect();
        }
        if (this.contentObserver) {
            this.contentObserver.disconnect();
        }
        if (this.bodyObserver) {
            this.bodyObserver.disconnect();
        }
        if (this.bodyCleanupObserver) {
            this.bodyCleanupObserver.disconnect();
        }

        // Create IntersectionObserver with buffer zone for smoother UX
        // rootMargin adds 200px buffer above/below viewport (similar to bufferRows in virtual scroll)
        this.editorObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const container = entry.target;
                        // Create editor only when container enters viewport
                        this.createEditorForContainer(container);
                        // Stop observing after editor is created
                        this.editorObserver.unobserve(container);
                    }
                });
            },
            {
                root: null, // viewport
                rootMargin: '200px 0px', // Buffer zone: 200px above and below viewport
                threshold: 0
            }
        );

        // Content observer: fetches request content as cards approach viewport
        // Larger rootMargin (500px) to pre-fetch before cards are visible
        this.contentObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const card = entry.target;
                        const execId = this.getExecIdForCard(card);
                        if (execId
                            && !this.loadedRequestContent.has(execId)
                            && !this.pendingContentRequests.has(execId)
                            && !this.pendingContentIds.has(execId)) {
                            this.pendingContentIds.add(execId);
                            this.scheduleContentFlush();
                        }
                        this.contentObserver.unobserve(card);
                    }
                });
            },
            {
                root: null,
                rootMargin: '500px 0px',
                threshold: 0
            }
        );

        // Body observer: builds card body HTML when card scrolls near viewport
        // 600px buffer for smooth appearance before card is visible
        this.bodyObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const card = entry.target;
                        const index = parseInt(card.dataset.index, 10);
                        const needsBuild = !this.renderedBodies.has(index) || card.dataset.stale === 'true';
                        if (!isNaN(index) && card.classList.contains('expanded') && needsBuild) {
                            delete card.dataset.stale;
                            this.buildBodyForCard(card, index);
                        }
                    }
                });
            },
            {
                root: null,
                rootMargin: '600px 0px',
                threshold: 0
            }
        );

        // Body cleanup observer: clears card bodies when scrolled far away (>2000px)
        // Keeps observing (doesn't unobserve) so it fires again when card re-enters
        this.bodyCleanupObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) {
                        const card = entry.target;
                        const index = parseInt(card.dataset.index, 10);
                        if (!isNaN(index) && this.renderedBodies.has(index)) {
                            this.clearBodyForCard(card, index);
                        }
                    }
                });
            },
            {
                root: null,
                rootMargin: '2000px 0px',
                threshold: 0
            }
        );

        // Observe all cards for body building, cleanup, and content fetching.
        // The transaction modal's card builds its own body (openTransactionModal).
        document.querySelectorAll('.raw-tab-container .raw-card').forEach(card => {
            this.bodyObserver.observe(card);
            this.bodyCleanupObserver.observe(card);
            this.contentObserver.observe(card);
        });

        // Observe Monaco containers only for cards that already have bodies rendered
        document.querySelectorAll('.raw-tab-container .raw-monaco-container').forEach(container => {
            if (!this.monacoEditors.has(container.id)) {
                this.editorObserver.observe(container);
            }
        });
    }

    /**
     * Get the execution ID associated with a raw card element
     * Uses the card's data-index to look up the filtered transaction's exec ID
     */
    getExecIdForCard(card) {
        return this.execIdFor(this.txFor(card.dataset.index));
    }

    /**
     * Create editors that were queued while Monaco was loading
     * @deprecated Replaced by setupLazyLoading() - kept for backwards compatibility
     */
    createQueuedEditors() {
        // Now uses lazy loading instead - this method is kept for any direct calls
        this.setupLazyLoading();
    }

    /**
     * Create a Monaco editor for a specific container
     */
    createEditorForContainer(container) {
        if (!container || !this.monacoReady) return;
        if (!window.monaco) return;

        const editorId = container.id;

        // Skip if editor already exists
        if (this.monacoEditors.has(editorId)) return;

        // Resolve content from in-memory arrays (no base64 DOM attributes)
        const content = this.resolveContentForContainer(container);
        const searchTerm = this.searchTermFor(container.dataset.txIndex);
        // GitHub Issue #183: Use data-language for HTML responses
        const language = container.dataset.language || 'json';

        try {
            const editor = monaco.editor.create(container, {
                value: content,
                language: language,
                theme: 'vscode-current',
                stickyScroll: window.DBMN_STICKY_SCROLL,
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                folding: true,
                lineNumbers: 'off',
                renderLineHighlight: 'none',
                contextmenu: false,
                scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto',
                    verticalScrollbarSize: 10,
                    horizontalScrollbarSize: 10
                },
                fontSize: 12,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                lineDecorationsWidth: 0,
                lineNumbersMinChars: 0,
                glyphMargin: false,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                overviewRulerBorder: false,
                padding: { top: 8, bottom: 8 }
            });

            this.monacoEditors.set(editorId, editor);

            // Auto-adjust height based on content
            const contentHeight = Math.min(400, Math.max(100, editor.getContentHeight()));
            container.style.height = contentHeight + 'px';
            editor.layout();

            // Listen for content size changes
            editor.onDidContentSizeChange(() => {
                const newHeight = Math.min(400, Math.max(100, editor.getContentHeight()));
                container.style.height = newHeight + 'px';
                editor.layout();
            });

            // Apply search highlighting if there's a search term
            if (searchTerm) {
                this.highlightSearchInEditor(editor, searchTerm);
            }
        } catch (e) {
            console.error('Failed to create Monaco editor:', e);
            // Fallback to pre element display
            container.innerHTML = `<pre class="raw-json-content">${this.escapeHtml(content)}</pre>`;
        }
    }

    /**
     * Resolve the actual content string for a Monaco container using its
     * data-tx-index and data-pane-type attributes. Looks up directly from
     * the in-memory arrays instead of reading base64 DOM attributes.
     */
    resolveContentForContainer(container) {
        const paneType = container.dataset.paneType; // 'request' or 'response'
        const tx = this.txFor(container.dataset.txIndex);
        if (!tx) return '';

        if (paneType === 'response') {
            // GitHub Issue #2: Check response content mode (body vs headers)
            const responseMode = container.dataset.responseMode || 'body';
            if (responseMode === 'headers') {
                return this.buildResponseHeadersSummary(tx);
            }
            const responseData = tx.data;
            const txStatus = this.normalizeStatus(tx.status || tx.metadata?.status || '');
            const isPending = txStatus === 'pending' || txStatus === 'running';
            if (!responseData) {
                if (txStatus === 'cancelled') return '// Cancelled: the request was stopped before a response arrived';
                return isPending ? '// Awaiting response...' : '// No response data';
            }
            if (this.jsonlFormatFor(tx) && container.dataset.jsonlMode !== 'pretty') return this.jsonlLinesFor(tx);
            return typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2);
        }

        if (paneType === 'request') {
            const mode = container.dataset.requestMode || 'body';
            if (mode === 'details') {
                const execId = this.execIdFor(tx);
                const txEndpointInfo = execId ? this.execIdToEndpointInfo?.get(execId) : null;
                return this.buildGetRequestSummary(txEndpointInfo);
            }
            // mode === 'body'
            const body = this.requestBodyFor(tx);
            if (body === undefined) return '// Loading...';
            return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        }

        return '';
    }

    /** Search term that applies to a view: the modal keeps its own. */
    searchTermFor(key) {
        if (key === RawTabHandler.MODAL_KEY) return this.modal?.searchTerm || '';
        return this.state.searchTerm;
    }

    /**
     * Highlight search term in Monaco editor using decorations
     */
    highlightSearchInEditor(editor, searchTerm) {
        if (!editor) return 0;

        const model = editor.getModel();
        if (!model) return 0;

        const matches = searchTerm
            ? model.findMatches(searchTerm, true, false, false, null, true)
            : [];

        const decorations = matches.map(match => ({
            range: match.range,
            options: {
                className: 'raw-search-highlight-monaco',
                overviewRuler: {
                    color: '#ffff00',
                    position: monaco.editor.OverviewRulerLane.Center
                }
            }
        }));

        editor._rawSearchDecorations = editor.deltaDecorations(editor._rawSearchDecorations || [], decorations);
        return matches.length;
    }

    /**
     * Issue #306: re-highlight open editors in place. The single view and the
     * modal search within one transaction, so they highlight, never filter.
     */
    highlightSearchInView(key) {
        const term = this.searchTermFor(key);
        let total = 0;
        this.monacoEditors.forEach((editor, id) => {
            const container = document.getElementById(id);
            if (!container || container.dataset.txIndex !== String(key)) return;
            total += this.highlightSearchInEditor(editor, term) || 0;
        });
        return total;
    }

    /**
     * Dispose all Monaco editors and cleanup observers (GitHub Issue #166)
     */
    disposeAllEditors() {
        // Disconnect theme observer
        if (this.themeObserver) {
            this.themeObserver.disconnect();
            this.themeObserver = null;
        }

        // Disconnect editor observer to prevent callbacks for disposed editors
        if (this.editorObserver) {
            this.editorObserver.disconnect();
            this.editorObserver = null;
        }

        // Disconnect content observer
        if (this.contentObserver) {
            this.contentObserver.disconnect();
            this.contentObserver = null;
        }

        // Disconnect body observers
        if (this.bodyObserver) {
            this.bodyObserver.disconnect();
            this.bodyObserver = null;
        }
        if (this.bodyCleanupObserver) {
            this.bodyCleanupObserver.disconnect();
            this.bodyCleanupObserver = null;
        }

        // Clear rendered bodies tracking
        this.renderedBodies.clear();

        // Clear pending content state
        if (this.contentFlushTimer) {
            clearTimeout(this.contentFlushTimer);
            this.contentFlushTimer = null;
        }
        this.pendingContentIds.clear();
        this.pendingContentRequests.clear();

        // Dispose the list's Monaco editors. The transaction modal owns its
        // own (closeTransactionModal), so a list refresh never blanks it.
        this.monacoEditors.forEach((editor, id) => {
            if (RawTabHandler.isModalEditorId(id)) return;
            try {
                editor.dispose();
            } catch (e) {
                // Ignore disposal errors
            }
            this.monacoEditors.delete(id);
        });
    }

    /**
     * Dispose Monaco editors within a single card (used during in-place body updates)
     */
    disposeEditorsInCard(card) {
        card.querySelectorAll('.raw-monaco-container').forEach(container => {
            if (this.monacoEditors.has(container.id)) {
                try {
                    this.monacoEditors.get(container.id).dispose();
                } catch (e) {
                    // Ignore disposal errors
                }
                this.monacoEditors.delete(container.id);
            }
        });
    }

    /**
     * Build card body on-demand when card scrolls into viewport
     * Called by bodyObserver — renders full body HTML and observes Monaco containers
     */
    buildBodyForCard(card, index) {
        const tx = this.txFor(index);
        if (!tx) return;

        const bodyInner = card.querySelector('.raw-card-body-inner');
        if (!bodyInner) return;

        bodyInner.innerHTML = this.buildCardBody(tx, index);
        this.renderedBodies.add(index);

        // Observe Monaco containers and card for editor creation + content fetching
        this.observeNewContainers(index, index + 1);
    }

    /**
     * Clear card body to reclaim DOM elements when card scrolls far away
     * Called by bodyCleanupObserver — disposes editors and empties body
     */
    clearBodyForCard(card, index) {
        this.disposeEditorsInCard(card);
        const bodyInner = card.querySelector('.raw-card-body-inner');
        if (bodyInner) {
            bodyInner.innerHTML = '';
        }
        this.renderedBodies.delete(index);
    }

    /**
     * Load request file content from backend
     * For batch transactions, each transaction has its own request file
     */
    loadRequestContent() {
        const rawData = this.reportManager.rawData;

        // For individual transactions, requestContent is already available
        if (rawData?.requestContent) {
            return;
        }

        // For batch transactions, request content from backend
        const batchId = rawData?.metadata?.batchId;
        const executionId = rawData?.metadata?.executionId;

        if (!batchId && !executionId) {
            return;
        }

        // Only request once per render
        if (this.contentLoadRequested) {
            return;
        }
        this.contentLoadRequested = true;

        // Request transaction content (request files) from backend
        vscode.postMessage({
            type: 'console.get_raw_tab_data',
            correlationId: `raw_tab_${Date.now()}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                batchId: batchId,
                executionId: executionId
            }
        });
    }

    /**
     * Handle RAW tab data response from backend
     * Contains transaction summaries with file paths and database execution IDs
     * GitHub Issue #166: Store mapping for execution ID reconciliation
     */
    handleDataResponse(payload) {
        if (!payload || !payload.transactions) {
            return;
        }

        // Store transaction summaries and build mappings
        this.transactionSummaries = payload.transactions;
        this.summaryByExecId = new Map(payload.transactions.map(tx => [tx.executionId, tx])); // Issue #312
        this.summariesLoaded = true;
        this.sourceFileToExecId.clear();
        this.execIdToRowInfo = new Map(); // GitHub Issue #166: Map executionId -> {rowStart, rows}
        this.execIdToEndpointInfo = new Map(); // GitHub Issue #201: Per-transaction endpoint data

        payload.transactions.forEach(tx => {
            // Map by response file basename for matching with rawData.responses
            if (tx.responseFile) {
                const basename = tx.responseFile.split(/[/\\]/).pop();
                this.sourceFileToExecId.set(basename, tx.executionId);
            }
            // Store row info for CSV data display
            if (tx.rowStart !== undefined || tx.rows !== undefined) {
                this.execIdToRowInfo.set(tx.executionId, {
                    rowStart: tx.rowStart,
                    rows: tx.rows
                });
            }
            // GitHub Issue #201: Store per-transaction endpoint info
            if (tx.endpointPath || tx.requestHeaders || tx.requestQueryParams) {
                this.execIdToEndpointInfo.set(tx.executionId, {
                    endpointPath: tx.endpointPath,
                    requestHeaders: tx.requestHeaders,
                    requestQueryParams: tx.requestQueryParams
                });
            }
        });

        // Content is now loaded lazily via contentObserver as cards scroll into view
        // (previously loaded ALL content eagerly here — caused massive memory usage)

        // Issue #296: an open modal now knows its execution ID, input rows and
        // endpoint details — fetch its body and rebuild it.
        if (this.modal) {
            this.requestContentFor([this.txFor(RawTabHandler.MODAL_KEY)]);
            this.rebuildCardBody(RawTabHandler.MODAL_KEY);
        }
        // Issue #306: a single transaction with no body may now know it.
        this.applyAutoShow();

        // Issue #304: the Input tab's row statuses come from these row ranges.
        this.reportManager.refreshInputStatuses?.();

        // A reprocess asked for before the execution IDs were known
        if (this._pendingReprocess) {
            const tx = this._pendingReprocess;
            this._pendingReprocess = null;
            this.reprocessTransaction(tx);
        }
    }

    /**
     * Ask the host for the request bodies of these transactions, skipping any
     * already loaded or in flight.
     */
    requestContentFor(transactions) {
        const ids = [];
        for (const tx of transactions) {
            const execId = this.execIdFor(tx);
            if (!execId || this.loadedRequestContent.has(execId) || this.pendingContentRequests.has(execId)) continue;
            ids.push(execId);
            this.pendingContentRequests.add(execId);
        }
        if (ids.length === 0) return;
        vscode.postMessage({
            type: 'console.get_raw_transaction_content',
            correlationId: `raw_content_${Date.now()}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: { executionIds: ids }
        });
    }

    /** Rebuild one card's body in place (disposes and recreates its editors). */
    rebuildCardBody(key) {
        const card = this.cardFor(key);
        const tx = this.txFor(key);
        const bodyInner = card?.querySelector('.raw-card-body-inner');
        if (!bodyInner || !tx) return;
        this.disposeEditorsInCard(card);
        bodyInner.innerHTML = this.buildCardBody(tx, key);
        if (key === RawTabHandler.MODAL_KEY) {
            this.createEditorsIn(card);
        } else {
            this.renderedBodies.add(Number(key));
            this.observeNewContainers(Number(key), Number(key) + 1);
        }
    }

    /** Create editors straight away for every pane in an element. */
    createEditorsIn(root) {
        this.ensureMonaco(() => {
            root.querySelectorAll('.raw-monaco-container').forEach(c => this.createEditorForContainer(c));
        });
    }

    /** Load Monaco once, then run the callback. */
    ensureMonaco(callback) {
        if (this.monacoReady) {
            callback();
            return;
        }
        if (typeof require === 'undefined') return;
        require(['vs/editor/editor.main'], () => {
            if (!this.monacoReady) {
                this.monacoReady = true;
                defineVSCodeTheme();
                this.themeObserver = setupMonacoThemeObserver();
            }
            callback();
        });
    }

    /**
     * Handle RAW transaction content response from backend
     * Contains actual request/response file content
     * GitHub Issue #166: Updates all matching DOM elements after content loads
     */
    handleContentResponse(payload) {
        if (!payload || !payload.contents) {
            return;
        }

        // Store loaded content in LRU cache and clear in-flight tracking
        const updatedExecIds = new Set();
        payload.contents.forEach((item) => {
            this.pendingContentRequests.delete(item.executionId);
            if (item.error) return;
            // Issue #306: cache "no body" too ('') so the card stops loading
            // and settles on Details.
            this.lruSet(item.executionId, item.requestContent || '');
            updatedExecIds.add(item.executionId);
        });

        // Content is now in the LRU cache. Update visible editors that need it.
        // Cards whose bodies aren't rendered get fresh content when they are built
        const keys = Array.from(this.renderedBodies);
        if (this.modal) keys.push(RawTabHandler.MODAL_KEY);

        for (const key of keys) {
            const execId = this.execIdFor(this.txFor(key));
            if (!execId || !updatedExecIds.has(execId)) continue;
            this.refreshRequestPane(key);
        }

        // Issue #306: a single transaction's Request default follows its body.
        this.applyAutoShow();
    }

    /**
     * The request body for a card has arrived. A card built while it was
     * loading offers Body/Details; if the body turned out empty the card is
     * rebuilt on Details alone, otherwise only the editor's text is refreshed.
     */
    refreshRequestPane(key) {
        const requestContainer = document.getElementById(`monaco-request-${key}`);
        if (!requestContainer) return;
        const tx = this.txFor(key);
        const hasToggle = !!requestContainer.closest('.raw-request-pane')?.querySelector('.raw-view-mode-group');
        const hasBody = this.requestBodyFor(tx) !== '';
        if (hasToggle !== hasBody) {
            this.rebuildCardBody(key);
            return;
        }
        const currentMode = requestContainer.dataset.requestMode;
        if (currentMode === 'body' || !currentMode) {
            const editor = this.monacoEditors.get(requestContainer.id);
            if (editor) {
                editor.setValue(this.resolveContentForContainer(requestContainer));
            }
        }
    }

    /**
     * Build filter bar HTML. Issue #306: Status and Show sit in the bar
     * itself — they are how you read the list, not filters to dig for.
     */
    buildFilterBar() {
        const totalCount = this.getTransactions().length;

        return `
            <div class="raw-filter-bar">
                <div class="raw-filter-row">
                    <div class="raw-filter-group raw-search-group">
                        <input type="text" id="raw-search-input" class="raw-search-input"
                               placeholder="Search JSON content..." value="${this.escapeHtml(this.state.searchTerm)}">
                        <button id="raw-search-clear" class="raw-search-clear ${this.state.searchTerm ? '' : 'hidden'}">Clear</button>
                    </div>
                    <label class="raw-filter-group">
                        <span>Status</span>
                        <select id="raw-status-select" class="raw-status-dropdown">${this.buildStatusOptions()}</select>
                    </label>
                    ${this.buildShowChips(RawTabHandler.LIST_KEY)}
                </div>
                <div class="raw-filter-row raw-filter-row-secondary">
                    <span id="raw-counter" class="raw-counter">Showing ${this.getFilteredTransactions().length} of ${totalCount} transactions</span>
                    <div class="raw-expand-controls">
                        <button id="raw-expand-all" class="raw-control-btn">Expand All</button>
                        <button id="raw-collapse-all" class="raw-control-btn">Collapse All</button>
                    </div>
                </div>
            </div>
        `;
    }

    /** Status dropdown options, each with its count. */
    buildStatusOptions() {
        const counts = this.getStatusCounts();
        const opts = [['all', 'All', this.getTransactions().length]]
            .concat(this.ALL_STATUSES.map(st => [st, st.charAt(0).toUpperCase() + st.slice(1), counts[st] || 0]));
        // #428: test failures, the errors whose 200 the endpoint's own test turned down. Their
        // own choice, and not counted under Error too: each transaction is under one status, the
        // counts add up to All, and a real server error can't hide among 50 test failures.
        const reasons = window.ConsoleErrorReason;
        if (reasons) {
            const testFailed = this.getTransactions().filter(tx => reasons.isTestFailure(tx)).length;
            const at = opts.findIndex(([value]) => value === 'error');
            opts[at][2] = Math.max(0, opts[at][2] - testFailed);
            opts.splice(at + 1, 0, [RawTabHandler.TEST_FAILED_FILTER, 'Test failed', testFailed]);
        }
        return opts.map(([value, label, count]) =>
            `<option value="${value}"${this.state.statusFilter === value ? ' selected' : ''}>${label} (${count})</option>`
        ).join('');
    }

    /**
     * Issue #306: Input / Request / Response toggle chips for a view. Input
     * is disabled when the view has no input rows to show.
     */
    buildShowChips(key) {
        const show = this.showFor(key);
        const chip = (prop, label, title, disabled) => `
            <button type="button" class="raw-show-chip" data-show="${prop}"
                    aria-pressed="${show[prop] ? 'true' : 'false'}"${disabled ? ' disabled' : ''}
                    title="${disabled ? 'No input for this transaction' : title}">${label}</button>`;
        return `
            <div class="raw-show-group" role="group" aria-label="Show" data-view-key="${key}">
                <span class="raw-show-label">Show</span>
                ${chip('showData', 'Input', 'Show the input rows that built the request', !show.hasInput)}
                ${chip('showRequest', 'Request', 'Show the request that was sent', false)}
                ${chip('showResponse', 'Response', 'Show the response', false)}
            </div>`;
    }

    /**
     * Issue #306: toolbar of a single transaction (single view and modal):
     * Show chips plus a search that highlights within the transaction.
     */
    buildSoloToolbar(key) {
        const term = this.searchTermFor(key);
        return `
            <div class="raw-solo-toolbar">
                ${this.buildShowChips(key)}
                <input type="text" class="raw-search-input raw-solo-search" data-view-key="${key}"
                       placeholder="Search this transaction..." value="${this.escapeHtml(term)}">
            </div>`;
    }

    /**
     * Get filtered transactions based on current filter state
     * GitHub Issue #166: Uses sourceFile mapping for correct request content lookup
     */
    getFilteredTransactions() {
        let filtered = this.getTransactions();
        // Issue #306: one transaction is always shown; its search highlights.
        if (filtered.length === 1) return filtered;

        // Filter by status (using normalized status)
        if (this.state.statusFilter === RawTabHandler.TEST_FAILED_FILTER) {
            filtered = filtered.filter(tx => !!window.ConsoleErrorReason?.isTestFailure(tx));
        } else if (this.state.statusFilter !== 'all') {
            const reasons = window.ConsoleErrorReason;
            filtered = filtered.filter(tx => {
                const rawStatus = tx.status || tx.metadata?.status || '';
                const status = this.normalizeStatus(rawStatus);
                // #428: Error is the server's errors; test failures have their own choice
                if (status === 'error' && reasons?.isTestFailure(tx)) return false;
                return status === this.state.statusFilter;
            });
        }

        // Filter by search term
        if (this.state.searchTerm) {
            const searchLower = this.state.searchTerm.toLowerCase();

            filtered = filtered.filter((tx, idx) => {
                // Search in response data
                const responseStr = JSON.stringify(tx.data || {});
                if (responseStr.toLowerCase().includes(searchLower)) {
                    return true;
                }
                // Search in loaded request content - use sourceFile mapping
                const sourceFile = tx.metadata?.sourceFile;
                let execId = sourceFile ? this.sourceFileToExecId.get(sourceFile) : null;
                if (!execId) {
                    execId = tx.metadata?.executionId;
                }
                const requestContent = execId ? this.lruGet(execId) : null;
                if (requestContent && requestContent.toLowerCase().includes(searchLower)) {
                    return true;
                }
                // Search in individual request content
                const individualRequest = this.reportManager.rawData?.requestContent;
                if (individualRequest && individualRequest.toLowerCase().includes(searchLower)) {
                    return true;
                }
                return false;
            });
        }

        return filtered;
    }

    /**
     * Build HTML for a single transaction card (header + body)
     * Extracted for use by both buildContent() and chunked rendering.
     *
     * Issue #306/#296: the same card is the single-transaction view and the
     * modal's content (`solo`) — no expand toggle or title, always open, with
     * its own Show chips and search under the header.
     */
    buildCardHtml(tx, key, { solo = false } = {}) {
        const isExpanded = solo || this.state.allExpanded;
        const rawStatus = tx.status || tx.metadata?.status || '';
        const status = this.normalizeStatus(rawStatus);
        const statusClass = this.getStatusClass(status);
        const httpStatusDisplay = tx.httpStatus || '-';
        const httpStatusClass = this.getHttpStatusClass(httpStatusDisplay);
        const responseTime = tx.metadata?.responseTime;
        const responseTimeDisplay = responseTime != null ? `${responseTime}ms` : '';
        const timestamp = tx.metadata?.timestamp;
        const k = this.escapeHtml(String(key));

        const lead = solo ? '' : `
                    <span class="raw-card-toggle">${window.Icons.icon(isExpanded ? 'chevron-down' : 'chevron-right')}</span>
                    <span class="raw-card-title">${this.transactionTitle(tx)}</span>`;

        // #428: a 200 failed by the endpoint's own test says so — badge and reason
        const reasons = window.ConsoleErrorReason;
        const testFailed = !!reasons?.isTestFailure(tx);
        const badgeText = testFailed ? 'TEST FAILED' : status.toUpperCase();
        const badgeClass = testFailed ? 'status-test-failed' : statusClass;
        const reasonHtml = status === 'error' && reasons ? this.buildReasonLine(tx, testFailed) : '';

        return `
            <div class="raw-card ${isExpanded ? 'expanded' : 'collapsed'}${solo ? ' raw-card-solo' : ''}" data-index="${k}" data-exec-id="${this.escapeHtml(String(this.execIdFor(tx) || ''))}">
                <div class="raw-card-header"${solo ? '' : ` data-click="raw:toggleCard" data-arg="${k}"`}>${lead}
                    <span class="raw-status-badge ${badgeClass}">${badgeText}</span>
                    <span class="raw-http-status ${httpStatusClass}">${httpStatusDisplay}</span>
                    ${responseTimeDisplay ? `<span class="raw-response-time">${responseTimeDisplay}</span>` : ''}
                    <span class="raw-timestamp">${timestamp ? new Date(timestamp).toLocaleString() : ''}</span>
                    ${this.buildRetryButton(tx, key, status)}
                    <button type="button" class="raw-view-logs-btn" data-click="raw:viewLogs" data-arg="${k}" data-stop-propagation title="View Logs">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm1 2h8v1H4V5zm0 2h8v1H4V7zm0 2h5v1H4V9z"/></svg>
                        Logs
                    </button>
                    <button type="button" class="raw-copy-all-btn" data-click="raw:copyContent" data-arg="${k}" data-mode="both" data-stop-propagation title="Copy All">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                        Copy All
                    </button>
                </div>
                ${reasonHtml}
                ${solo ? this.buildSoloToolbar(key) : ''}
                <div class="raw-card-body">
                    <div class="raw-card-body-inner"></div>
                </div>
            </div>
        `;
    }

    /**
     * #428: why this transaction is an error, under its header. A test failure also says
     * the server's answer was fine — the verdict is the endpoint's own test.
     */
    buildReasonLine(tx, testFailed) {
        const reason = window.ConsoleErrorReason.reasonFor(tx);
        if (!reason) return '';
        const http = tx.httpStatus;
        const note = testFailed && typeof http === 'number'
            ? `<span class="raw-card-reason-note">The server answered ${http}; this result comes from the endpoint's test.</span>`
            : '';
        return `
                <div class="raw-card-reason${testFailed ? ' raw-card-reason-test' : ''}">
                    ${window.Icons.icon('triangle-alert')}
                    <span class="raw-card-reason-text">${this.escapeHtml(reason)}</span>
                    ${note}
                </div>`;
    }

    /** "Transaction #007" — batch member number, else position in the run. */
    transactionTitle(tx) {
        const displayNumber = tx.metadata?.memberIndex ?? (this.positionOf(tx) + 1);
        return `Transaction #${String(displayNumber).padStart(3, '0')}`;
    }

    /**
     * Issue #312: a transaction's position in the run, from a map rebuilt only when
     * the responses array changes. This was `indexOf` over every response — per card,
     * on every card, on every live result: 14,000 cards × 14,000 responses froze the
     * Console as soon as the Raw tab opened on a big running batch.
     */
    positionOf(tx) {
        const transactions = this.getTransactions();
        if (this._positions?.source !== transactions || this._positions.size !== transactions.length) {
            const map = new Map();
            transactions.forEach((t, i) => map.set(t, i));
            this._positions = { source: transactions, size: transactions.length, map };
        }
        const at = this._positions.map.get(tx);
        return at === undefined ? -1 : at;
    }

    /** Reprocess count for a transaction (from summaries or result metadata). */
    reprocessCountFor(tx) {
        const execId = this.execIdFor(tx);
        // Issue #312: a map, not `summaries.find` per card
        const summary = execId ? this.summaryByExecId?.get(execId) : null;
        return summary?.reprocessCount || tx.metadata?.reprocessCount || 0;
    }

    /**
     * Reprocess button with its reprocess-count badge. Enabled for errors
     * only; shown disabled while a reprocess runs, or as a record once one
     * has completed.
     */
    buildRetryButton(tx, key, status) {
        const reprocessCount = this.reprocessCountFor(tx);
        // Reprocess icon when count is 0, replaced by the red count badge once retried
        const retryIcon = reprocessCount > 0 ? `<span class="raw-retry-badge">${reprocessCount}</span>` : window.Icons.icon('refresh-cw');
        const isRetrying = status === 'pending' || status === 'running';
        const k = this.escapeHtml(String(key));
        if (status === 'error' || (isRetrying && reprocessCount > 0)) {
            return `<button type="button" class="raw-retry-btn${isRetrying ? ' retrying' : ''}" ${isRetrying ? 'disabled' : ''} data-click="raw:retryMember" data-arg="${k}" data-stop-propagation title="${isRetrying ? 'Reprocessing...' : 'Reprocess this transaction'}">${retryIcon} Reprocess</button>`;
        }
        if (reprocessCount > 0) {
            return `<button type="button" class="raw-retry-btn" disabled data-stop-propagation title="Reprocessed ${reprocessCount} time${reprocessCount > 1 ? 's' : ''}">${retryIcon} Reprocess</button>`;
        }
        return '';
    }

    /**
     * Build RAW tab content (transaction cards)
     * Always wraps in .raw-cards-container for consistent DOM updates
     * For chunked rendering, only builds first INITIAL_RENDER_COUNT cards;
     * remaining cards are appended async via renderRemainingChunks()
     */
    buildContent(limit) {
        const filtered = this.getFilteredTransactions();

        if (filtered.length === 0) {
            return `<div class="raw-cards-container"><div class="raw-empty-state">No transactions match your filters</div></div>`;
        }

        const count = limit !== undefined ? Math.min(limit, filtered.length) : filtered.length;
        let cardsHtml = '<div class="raw-cards-container">';

        for (let i = 0; i < count; i++) {
            cardsHtml += this.cardHtmlAt(filtered, i);
        }

        cardsHtml += '</div>';
        return cardsHtml;
    }

    /** Card for list position i — keyed by its place in the whole list (#431); solo when it is the only transaction. */
    cardHtmlAt(filtered, i) {
        return this.buildCardHtml(filtered[i], this.keyOf(filtered[i]), { solo: this.isSingleMode() });
    }

    /**
     * Cancel any in-progress chunked rendering
     */
    cancelChunkedRendering() {
        if (this.renderAbortController) {
            this.renderAbortController.abort();
            this.renderAbortController = null;
        }
    }

    /**
     * Render remaining cards in chunks via requestAnimationFrame
     * Appends CHUNK_SIZE cards per frame for non-blocking rendering
     */
    renderRemainingChunks(startFrom, filtered) {
        // Issue #312: a window, not the whole list. This used to append EVERY card in
        // frames of 50 — 14,000 cards (and their observers) for a big batch, which is
        // what froze the Console. Now the next chunk is built only when the user
        // scrolls to the end of what is rendered.
        this.cancelChunkedRendering();
        const container = document.querySelector('.raw-cards-container');
        if (!container || startFrom >= filtered.length) return;

        const sentinel = document.createElement('div');
        sentinel.className = 'raw-cards-more';
        sentinel.textContent = `Scroll for more (${(filtered.length - startFrom).toLocaleString()} more)`;
        container.appendChild(sentinel);

        const loadNext = () => {
            // #431: the list as it is now — live results add to it and take from it in place
            const list = this.getFilteredTransactions();
            const current = container.querySelectorAll(':scope > .raw-card').length;
            const end = Math.min(current + this.CHUNK_SIZE, list.length);
            let chunkHtml = '';
            for (let i = current; i < end; i++) chunkHtml += this.cardHtmlAt(list, i);
            sentinel.insertAdjacentHTML('beforebegin', chunkHtml);
            this.observeCardKeys(list.slice(current, end).map(tx => this.keyOf(tx)));
            if (end >= list.length) {
                this.cancelChunkedRendering();
            } else {
                sentinel.textContent = `Scroll for more (${(list.length - end).toLocaleString()} more)`;
            }
        };
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) loadNext();
        }, { root: document.getElementById('table-container'), rootMargin: '600px 0px' });
        observer.observe(sentinel);
        this.renderAbortController = { abort: () => { observer.disconnect(); sentinel.remove(); }, signal: { aborted: false } };
    }

    /**
     * Observe Monaco containers and cards in a range for lazy loading
     */
    observeNewContainers(startIdx, endIdx) {
        const keys = [];
        for (let i = startIdx; i < endIdx; i++) keys.push(i);
        this.observeCardKeys(keys);
    }

    /** Observe the cards with these keys (#431: keys, not list positions). */
    observeCardKeys(keys) {
        for (const i of keys) {
            const card = document.querySelector(`.raw-card[data-index="${i}"]`);
            if (!card) continue;

            // Observe card for lazy body building and cleanup
            if (this.bodyObserver) {
                this.bodyObserver.observe(card);
            }
            if (this.bodyCleanupObserver) {
                this.bodyCleanupObserver.observe(card);
            }

            // Observe card for content fetching
            if (this.contentObserver) {
                this.contentObserver.observe(card);
            }

            // Only observe Monaco containers if body is already rendered
            if (this.renderedBodies.has(i) && this.editorObserver) {
                card.querySelectorAll('.raw-monaco-container').forEach(container => {
                    if (!this.monacoEditors.has(container.id)) {
                        this.editorObserver.observe(container);
                    }
                });
            }
        }
    }

    /**
     * Build individual card body with Monaco editor containers
     * GitHub Issue #166: Uses sourceFile mapping to resolve correct execution IDs
     */
    buildCardBody(tx, index) {
        let bodyHtml = '';
        const show = this.showFor(index);
        const k = this.escapeHtml(String(index));

        // GitHub Issue #166: CSV Data row at top (full width, compact format)
        // Wrapped in grid-template-rows wrapper for smooth vertical collapse
        const csvRowData = this.getCsvRowData(tx, index);
        const csvHtml = this.buildCsvDataRow(csvRowData, index);
        if (csvHtml) {
            const wrapperHidden = show.showData ? '' : ' raw-section-hidden';
            bodyHtml += `<div class="raw-csv-data-wrapper${wrapperHidden}">${csvHtml}</div>`;
        }

        // Request/Response panes below — always render both, toggle via CSS classes
        const containerClasses = ['raw-panes-container'];
        // GitHub Issue #292: stack panes vertically when the tab is narrow.
        // The modal is sized by the window (less its margins), not the tab.
        const stacked = index === RawTabHandler.MODAL_KEY
            ? window.innerWidth - 90 < RawTabHandler.PANE_STACK_BREAKPOINT
            : this._panesStacked;
        if (stacked) containerClasses.push('is-stacked');
        if (!show.showRequest) containerClasses.push('request-hidden');
        if (!show.showResponse) containerClasses.push('response-hidden');
        if (!show.showRequest && !show.showResponse) {
            containerClasses.push('both-hidden');
        }

        // Issue #306: no body (blank or `{}`) means nothing was sent — the
        // request shows its Details only. Still loading keeps Body/Details.
        const isEmptyBody = this.requestBodyFor(tx) === '';

        // Detect HTML responses for view mode toggle
        const responseData = tx.data;
        const isHtmlResponse = typeof responseData === 'string' &&
            (responseData.trimStart().startsWith('<!DOCTYPE') || responseData.trimStart().startsWith('<html') || responseData.trimStart().startsWith('<HTML'));
        // Issue #115: a JSON Lines body, read into records; Lines shows it as it came
        const jsonl = this.jsonlFormatFor(tx);

        const bothHidden = !show.showRequest && !show.showResponse;
        const wrapperClass = bothHidden ? 'raw-panes-wrapper raw-section-hidden' : 'raw-panes-wrapper';
        bodyHtml += `<div class="raw-panes-section"><div class="${wrapperClass}"><div class="${containerClasses.join(' ')}">`;

        // Always render REQUEST pane — visibility controlled by CSS classes
        {
            const currentMode = isEmptyBody ? 'details' : 'body';

            const requestViewModeGroup = !isEmptyBody
                ? `<div class="raw-view-mode-group">
                       <button type="button" class="raw-view-mode-btn active" data-mode="body" data-click="raw:setRequestViewMode" data-arg="${k}" data-mode="body" data-stop-propagation>Body</button>
                       <button type="button" class="raw-view-mode-btn" data-mode="details" data-click="raw:setRequestViewMode" data-arg="${k}" data-mode="details" data-stop-propagation>Details</button>
                   </div>`
                : '';

            bodyHtml += `
                <div class="raw-pane raw-request-pane">
                    <div class="raw-pane-header">
                        <span class="raw-pane-title">REQUEST</span>
                        ${requestViewModeGroup}
                        <div class="raw-pane-header-actions">
                            <button type="button" class="raw-pane-copy-btn" data-click="raw:copyContent" data-arg="${k}" data-mode="request" title="Copy Request">
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                            </button>
                            <button type="button" class="raw-pane-fullscreen-btn" title="Toggle full window (Esc to exit)" aria-pressed="false" aria-label="Toggle full window">
                                <svg class="icon-enter" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h4v1H3v3H2V2zm12 0h-4v1h3v3h1V2zM2 14h4v-1H3v-3H2v4zm12 0h-4v-1h3v-3h1v4z"/></svg>
                                <svg class="icon-exit" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6 2v4H2V5h3V2h1zm4 0v4h4V5h-3V2h-1zm0 12v-4h4v1h-3v3h-1zm-4 0v-4H2v1h3v3h1z"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="raw-monaco-container" id="monaco-request-${index}" data-tx-index="${index}" data-pane-type="request" data-request-mode="${currentMode}"${isEmptyBody ? ' data-language="plaintext"' : ''}></div>
                </div>
            `;
        }

        // Always render RESPONSE pane — visibility controlled by CSS classes
        {
            // GitHub Issue #2: Check if response has headers for Body/Headers toggle
            const hasResponseHeaders = tx.headers && typeof tx.headers === 'object' && Object.keys(tx.headers).length > 0;

            const responseContentToggle = hasResponseHeaders
                ? `<div class="raw-view-mode-group" data-toggle-group="response-content">
                       <button type="button" class="raw-view-mode-btn active" data-mode="body" data-click="raw:setResponseContentMode" data-arg="${k}" data-mode="body" data-stop-propagation>Body</button>
                       <button type="button" class="raw-view-mode-btn" data-mode="headers" data-click="raw:setResponseContentMode" data-arg="${k}" data-mode="headers" data-stop-propagation>Headers</button>
                   </div>`
                : '';

            const viewModeGroup = jsonl
                ? `<div class="raw-view-mode-group" data-toggle-group="response-format">
                       <button type="button" class="raw-view-mode-btn active" data-mode="lines" title="One record per line, as received" data-click="raw:setJsonlMode" data-arg="${k}" data-mode="lines" data-stop-propagation>Lines</button>
                       <button type="button" class="raw-view-mode-btn" data-mode="pretty" title="The records as one indented JSON array" data-click="raw:setJsonlMode" data-arg="${k}" data-mode="pretty" data-stop-propagation>Pretty</button>
                   </div>`
                : isHtmlResponse
                ? `<div class="raw-view-mode-group" data-toggle-group="response-format">
                       <button type="button" class="raw-view-mode-btn active" data-mode="raw" data-click="raw:setViewMode" data-arg="${k}" data-mode="raw" data-stop-propagation>Raw</button>
                       <button type="button" class="raw-view-mode-btn" data-mode="render" data-click="raw:setViewMode" data-arg="${k}" data-mode="render" data-stop-propagation>Render</button>
                       <button type="button" class="raw-view-mode-btn" data-mode="text" data-click="raw:setViewMode" data-arg="${k}" data-mode="text" data-stop-propagation>Text</button>
                   </div>`
                : '';

            bodyHtml += `
                <div class="raw-pane raw-response-pane">
                    <div class="raw-pane-header">
                        <span class="raw-pane-title">RESPONSE${isHtmlResponse ? ' (HTML)' : ''}${jsonl ? this.jsonlTitleSuffix(jsonl) : ''}</span>
                        ${responseContentToggle}
                        ${viewModeGroup}
                        <div class="raw-pane-header-actions">
                            <button type="button" class="raw-pane-copy-btn" data-click="raw:copyContent" data-arg="${k}" data-mode="response" title="Copy Response">
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                            </button>
                            <button type="button" class="raw-pane-fullscreen-btn" title="Toggle full window (Esc to exit)" aria-pressed="false" aria-label="Toggle full window">
                                <svg class="icon-enter" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h4v1H3v3H2V2zm12 0h-4v1h3v3h1V2zM2 14h4v-1H3v-3H2v4zm12 0h-4v-1h3v-3h1v4z"/></svg>
                                <svg class="icon-exit" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6 2v4H2V5h3V2h1zm4 0v4h4V5h-3V2h-1zm0 12v-4h4v1h-3v3h-1zm-4 0v-4H2v1h3v3h1z"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="raw-monaco-container" id="monaco-response-${index}" data-tx-index="${index}" data-pane-type="response" data-response-mode="body"${isHtmlResponse ? ' data-language="html" data-is-html="true"' : ''}${jsonl ? ' data-language="plaintext" data-jsonl-mode="lines"' : ''}></div>
                    <div class="raw-headers-container hidden" id="headers-response-${index}"></div>
                    ${isHtmlResponse ? `<div class="raw-html-render hidden" id="html-render-${index}"></div>` : ''}
                    ${isHtmlResponse ? `<div class="raw-html-text hidden" id="html-text-${index}"></div>` : ''}
                </div>
            `;
        }

        bodyHtml += '</div></div>'; // close .raw-panes-container and .raw-panes-wrapper

        // Empty state message — same grid cell as wrapper, revealed in-place as panes collapse
        const emptyDisplay = bothHidden ? 'block' : 'none';
        bodyHtml += `<div class="raw-compact-view" style="display:${emptyDisplay}">Enable Request or Response to view content</div>`;

        bodyHtml += '</div>'; // close .raw-panes-section
        return bodyHtml;
    }

    /**
     * GitHub Issue #199: Build request details summary (query params, headers, URL)
     * Used by Body/Details toggle and as default view for GET requests
     */
    buildGetRequestSummary(txEndpointInfo) {
        const rawData = this.reportManager.rawData;
        const parts = [];

        // GitHub Issue #201: Per-transaction endpoint overrides global DOM header
        if (txEndpointInfo?.endpointPath) {
            const endpointText = document.getElementById('info-endpoint')?.textContent?.trim() || '';
            const spaceIdx = endpointText.indexOf(' ');
            const method = spaceIdx > 0 ? endpointText.substring(0, spaceIdx) : '';
            const fullUrl = spaceIdx > 0 ? endpointText.substring(spaceIdx + 1) : '';
            try {
                const parsedUrl = new URL(fullUrl);
                const pathWithoutEndpoint = parsedUrl.pathname.endsWith(txEndpointInfo.endpointPath)
                    ? parsedUrl.pathname.slice(0, -txEndpointInfo.endpointPath.length)
                    : parsedUrl.pathname;
                const baseUrl = `${parsedUrl.origin}${pathWithoutEndpoint}`;
                parts.push('// ENDPOINT');
                parts.push(`${method} ${baseUrl}${txEndpointInfo.endpointPath}`);
            } catch {
                parts.push('// ENDPOINT');
                parts.push(`${method} ${txEndpointInfo.endpointPath}`);
            }
        } else {
            // Fallback to global DOM (individual transactions, or batch without per-tx data)
            const infoEndpoint = document.getElementById('info-endpoint');
            if (infoEndpoint) {
                const endpointText = infoEndpoint.textContent.trim();
                if (endpointText && endpointText !== 'Unknown') {
                    parts.push('// ENDPOINT');
                    parts.push(endpointText);
                }
            }
        }

        // GitHub Issue #201: Per-transaction query params override global
        const params = txEndpointInfo?.requestQueryParams || rawData?.requestQueryParams;
        if (params && Object.keys(params).length > 0) {
            if (parts.length > 0) parts.push('');
            parts.push('// QUERY PARAMETERS');
            for (const [key, value] of Object.entries(params)) {
                parts.push(`${key}: ${value}`);
            }
        }

        // GitHub Issue #201: Per-transaction headers override global
        const headers = txEndpointInfo?.requestHeaders || rawData?.requestHeaders;
        if (headers && Object.keys(headers).length > 0) {
            if (parts.length > 0) parts.push('');
            parts.push('// HEADERS');
            for (const [key, value] of Object.entries(headers)) {
                parts.push(`${key}: ${value}`);
            }
        }

        return parts.length > 0 ? parts.join('\n') : '// No request details available';
    }

    /**
     * GitHub Issue #2: Build response headers summary for Headers view mode
     * Flat key: value list matching conventional HTTP header display.
     * Status is already shown in the card header, so not repeated here.
     * Response time is folded in as x-response-time for completeness.
     */
    buildResponseHeadersSummary(tx) {
        const lines = [];

        const headers = tx.headers;
        if (headers && typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers)) {
                lines.push(`${key}: ${value}`);
            }
        }

        const responseTime = tx.metadata?.responseTime;
        if (responseTime != null) {
            lines.push(`x-response-time: ${responseTime}ms`);
        }

        return lines.length > 0 ? lines.join('\n') : '// No response headers available';
    }

    /**
     * GitHub Issue #2: Build response headers as a DOM table for visual readability.
     * Two-column layout (Header / Value) reusing .raw-csv-table base styles.
     */
    buildResponseHeadersTable(tx) {
        const headers = tx.headers;
        const responseTime = tx.metadata?.responseTime;
        const hasHeaders = headers && typeof headers === 'object' && Object.keys(headers).length > 0;

        if (!hasHeaders && responseTime == null) {
            return '<div class="raw-headers-empty">No response headers available</div>';
        }

        let rows = '';
        if (hasHeaders) {
            for (const [key, value] of Object.entries(headers)) {
                rows += `<tr><td class="raw-headers-key">${this.escapeHtml(key)}</td><td class="raw-headers-value">${this.escapeHtml(String(value))}</td></tr>`;
            }
        }
        if (responseTime != null) {
            rows += `<tr><td class="raw-headers-key">${this.escapeHtml('x-response-time')}</td><td class="raw-headers-value">${this.escapeHtml(String(responseTime) + 'ms')}</td></tr>`;
        }

        return `<div class="raw-csv-table-wrapper raw-headers-table-wrapper">
            <table class="raw-csv-table raw-headers-table">
                <thead><tr><th>Header</th><th>Value</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    /**
     * GitHub Issue #2: Switch between Body/Headers view modes for RESPONSE pane
     * Shows headers table when in headers mode, Monaco editor when in body mode.
     * Hides Raw/Render/Text toggle when in headers mode (headers are always plaintext).
     */
    setResponseContentMode(index, mode) {
        const monacoContainer = document.getElementById(`monaco-response-${index}`);
        const headersContainer = document.getElementById(`headers-response-${index}`);
        if (!monacoContainer) return;

        // Update mode on the Monaco container (used by resolveContentForContainer and copyContent)
        monacoContainer.dataset.responseMode = mode;

        // Update Body/Headers toggle active state
        const contentGroup = monacoContainer.closest('.raw-response-pane')?.querySelector('[data-toggle-group="response-content"]');
        if (contentGroup) {
            contentGroup.querySelectorAll('.raw-view-mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }

        // Hide/show Raw/Render/Text toggle and HTML containers when in headers mode
        const formatGroup = monacoContainer.closest('.raw-response-pane')?.querySelector('[data-toggle-group="response-format"]');
        if (formatGroup) {
            formatGroup.style.display = mode === 'headers' ? 'none' : '';
        }

        if (mode === 'headers') {
            // Hide Monaco and HTML render/text containers, show headers table
            monacoContainer.classList.add('hidden');
            const render = document.getElementById(`html-render-${index}`);
            const text = document.getElementById(`html-text-${index}`);
            if (render) render.classList.add('hidden');
            if (text) text.classList.add('hidden');

            // Populate and show headers table
            if (headersContainer) {
                const tx = this.txFor(index);
                if (tx) {
                    headersContainer.innerHTML = this.buildResponseHeadersTable(tx);
                }
                headersContainer.classList.remove('hidden');
            }
        } else {
            // mode === 'body': show Monaco, hide headers table
            monacoContainer.classList.remove('hidden');
            if (headersContainer) {
                headersContainer.classList.add('hidden');
            }

            // Restore Monaco content for body mode
            const language = monacoContainer.dataset.isHtml === 'true' ? 'html'
                : monacoContainer.dataset.jsonlMode === 'lines' ? 'plaintext' : 'json';
            const content = this.resolveContentForContainer(monacoContainer);
            const editor = this.monacoEditors.get(monacoContainer.id);
            if (editor) {
                editor.setValue(content);
                const model = editor.getModel();
                if (model && window.monaco) {
                    monaco.editor.setModelLanguage(model, language);
                }
            } else {
                monacoContainer.dataset.language = language;
            }
        }
    }

    /**
     * LRU cache get — moves accessed key to end (most recently used)
     */
    lruGet(key) {
        if (!this.loadedRequestContent.has(key)) return undefined;
        const value = this.loadedRequestContent.get(key);
        // Move to end (most recently used)
        this.loadedRequestContent.delete(key);
        this.loadedRequestContent.set(key, value);
        return value;
    }

    /**
     * LRU cache set — evicts oldest entries when max size exceeded
     */
    lruSet(key, value) {
        // If key exists, delete first to update insertion order
        if (this.loadedRequestContent.has(key)) {
            this.loadedRequestContent.delete(key);
        }
        this.loadedRequestContent.set(key, value);
        // Evict oldest entries if over limit
        while (this.loadedRequestContent.size > this.LRU_MAX_ENTRIES) {
            const oldestKey = this.loadedRequestContent.keys().next().value;
            this.loadedRequestContent.delete(oldestKey);
        }
    }

    /**
     * Flush pending content IDs — sends batched request to backend
     * Caps at CONTENT_BATCH_SIZE per request to avoid large messages
     */
    flushPendingContent() {
        this.contentFlushTimer = null;
        if (this.pendingContentIds.size === 0) return;

        const ids = Array.from(this.pendingContentIds).slice(0, this.CONTENT_BATCH_SIZE);
        // Remove flushed IDs from pending
        ids.forEach(id => this.pendingContentIds.delete(id));
        // Track in-flight
        ids.forEach(id => this.pendingContentRequests.add(id));

        vscode.postMessage({
            type: 'console.get_raw_transaction_content',
            correlationId: `raw_content_${Date.now()}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionIds: ids
            }
        });

        // If there are remaining pending IDs, schedule another flush
        if (this.pendingContentIds.size > 0) {
            this.contentFlushTimer = setTimeout(() => this.flushPendingContent(), 50);
        }
    }

    /**
     * Schedule a debounced flush of pending content requests
     */
    scheduleContentFlush() {
        if (this.contentFlushTimer) return; // Already scheduled
        this.contentFlushTimer = setTimeout(() => this.flushPendingContent(), 150);
    }

    /**
     * Escape HTML entities — string-based to avoid DOM element creation overhead
     * (632K+ calls with DOM-based approach created/destroyed temporary divs)
     */
    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Get CSV row data for a transaction
     * GitHub Issue #166: Maps transaction to its source CSV rows
     * Returns array of rows (may be multiple due to maxRepetitions batching)
     */
    getCsvRowData(tx, index) {
        const rawData = this.reportManager.rawData;
        if (!rawData || !rawData.inputData || rawData.inputData.length === 0) {
            return [];
        }

        // First priority: Look up row info from backend transaction summaries
        const sourceFile = tx.metadata?.sourceFile;
        let execId = sourceFile ? this.sourceFileToExecId.get(sourceFile) : null;
        if (!execId) {
            execId = tx.metadata?.executionId;
        }

        if (execId && this.execIdToRowInfo && this.execIdToRowInfo.has(execId)) {
            const rowInfo = this.execIdToRowInfo.get(execId);
            if (rowInfo.rowStart !== undefined && rowInfo.rows !== undefined) {
                // rowStart is 1-based, rows is count of rows
                const startIdx = rowInfo.rowStart - 1;
                const rowCount = parseInt(rowInfo.rows, 10) || 1;
                const endIdx = startIdx + rowCount;
                return rawData.inputData.slice(startIdx, endIdx);
            }
        }

        // Second priority: Check transaction metadata for row range
        const rowStart = tx.metadata?.rowStart;
        const rows = tx.metadata?.rows;

        if (rowStart !== undefined && rows !== undefined) {
            const startIdx = rowStart - 1;
            const rowCount = parseInt(rows, 10) || 1;
            const endIdx = startIdx + rowCount;
            return rawData.inputData.slice(startIdx, endIdx);
        }

        // Third priority: Try csvRowData directly from metadata (may be array)
        if (tx.metadata?.csvRowData) {
            return Array.isArray(tx.metadata.csvRowData)
                ? tx.metadata.csvRowData
                : [tx.metadata.csvRowData];
        }

        // Fallback: single row by the transaction's position in the run
        const rowIndex = tx.metadata?.memberIndex ?? tx.metadata?.transactionIndex ?? this.getTransactions().indexOf(tx);
        if (rowIndex >= 0 && rowIndex < rawData.inputData.length) {
            return [rawData.inputData[rowIndex]];
        }

        return [];
    }

    /**
     * Build CSV data row display (full width, compact table format)
     * GitHub Issue #166: Shows CSV rows that generated this request
     */
    buildCsvDataRow(csvRows, index) {
        if (!csvRows || csvRows.length === 0) {
            return '';
        }

        // Get column headers from first row, excluding internal columns like __index
        const columns = Object.keys(csvRows[0]).filter(col => !col.startsWith('__'));
        if (columns.length === 0) {
            return '';
        }

        // Build compact table
        let html = `
            <div class="raw-csv-data-section">
                <div class="raw-csv-header">
                    <span>INPUT (${csvRows.length} row${csvRows.length > 1 ? 's' : ''})</span>
                    <button type="button" class="raw-pane-copy-btn" data-click="raw:copyContent" data-arg="${this.escapeHtml(String(index))}" data-mode="data" title="Copy CSV Data">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                    </button>
                </div>
                <div class="raw-csv-table-wrapper">
                    <table class="raw-csv-table">
                        <thead>
                            <tr>
                                ${columns.map(col => `<th>${this.escapeHtml(col)}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${csvRows.map(row => `
                                <tr>
                                    ${columns.map(col => `<td>${this.escapeHtml(String(row[col] ?? ''))}</td>`).join('')}
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        return html;
    }

    /**
     * Get CSS class for status badge
     * Valid transaction statuses: pending, running, completed, error, cancelled, split
     */
    getStatusClass(status) {
        const statusLower = (status || '').toLowerCase();
        if (statusLower === 'completed') return 'status-completed';
        if (statusLower === 'error') return 'status-error';
        if (statusLower === 'running') return 'status-running';
        if (statusLower === 'split') return 'status-split';
        if (statusLower === 'cancelled') return 'status-cancelled';
        return 'status-pending'; // Default to pending
    }

    /**
     * Get CSS class for HTTP status code pill
     */
    getHttpStatusClass(httpStatus) {
        const code = parseInt(httpStatus, 10);
        if (isNaN(code)) return 'http-other';
        if (code >= 200 && code < 300) return 'http-2xx';
        if (code >= 300 && code < 400) return 'http-3xx';
        if (code >= 400 && code < 500) return 'http-4xx';
        if (code >= 500) return 'http-5xx';
        return 'http-other';
    }

    /**
     * Toggle card expansion (GitHub Issue #166: lazy loading aware)
     */
    toggleCard(index) {
        const card = this.cardFor(index);
        if (!card) return;
        index = Number(index);

        const toggle = card.querySelector('.raw-card-toggle');

        if (card.classList.contains('expanded')) {
            // Collapse — CSS grid-template-rows transition handles animation
            card.classList.remove('expanded');
            card.classList.add('collapsed');
            toggle.innerHTML = window.Icons.icon('chevron-right');
        } else {
            // Expand — CSS grid-template-rows transition handles animation
            card.classList.remove('collapsed');
            card.classList.add('expanded');
            toggle.innerHTML = window.Icons.icon('chevron-down');

            // Build body if not yet rendered or marked stale
            if (!this.renderedBodies.has(index) || card.dataset.stale === 'true') {
                this.buildBodyForCard(card, index);
                delete card.dataset.stale;
            } else {
                // Body already rendered — ensure editors are observed
                const body = card.querySelector('.raw-card-body');
                if (body) {
                    body.querySelectorAll('.raw-monaco-container').forEach(container => {
                        if (!this.monacoEditors.has(container.id)) {
                            if (this.editorObserver) {
                                this.editorObserver.observe(container);
                            } else if (this.monacoReady) {
                                this.createEditorForContainer(container);
                            }
                        }
                    });
                }
            }
        }
    }

    /**
     * Copy raw content to clipboard
     * GitHub Issue #166: Uses sourceFile mapping to resolve correct execution IDs
     * GitHub Issue #174: Copy All uses rich HTML for paste into Outlook/Excel/Confluence
     */
    /** Issue #115: the JSONL format of a response read as JSON Lines, or null. */
    jsonlFormatFor(tx) {
        const format = tx && tx.format;
        return format && format.kind === 'jsonl' && Array.isArray(tx.data) ? format : null;
    }

    /** ` (JSONL · 1,240 records · 1 line not JSON)` */
    jsonlTitleSuffix(format) {
        const n = (format.records || 0).toLocaleString();
        let text = ` (JSONL · ${n} record${format.records === 1 ? '' : 's'}`;
        if (format.invalidCount) {
            text += ` · ${format.invalidCount.toLocaleString()} line${format.invalidCount === 1 ? '' : 's'} not JSON`;
        }
        return this.escapeHtml(text + ')');
    }

    /**
     * The body as lines again: one record per line, with the lines that weren't JSON put back
     * where they were (blank lines are not kept, so a position can shift by those).
     */
    jsonlLinesFor(tx) {
        const format = this.jsonlFormatFor(tx);
        const lines = tx.data.map(record => JSON.stringify(record));
        (format.invalid || []).slice().sort((a, b) => a.line - b.line).forEach(bad => {
            lines.splice(Math.min(bad.line - 1, lines.length), 0, bad.text);
        });
        return lines.join('\n');
    }

    /** Issue #115: Lines (as received) or Pretty (one indented JSON array) for a JSONL response. */
    setJsonlMode(index, mode) {
        const container = document.getElementById(`monaco-response-${index}`);
        if (!container) return;
        container.dataset.jsonlMode = mode;
        const group = container.closest('.raw-response-pane')?.querySelector('[data-toggle-group="response-format"]');
        group?.querySelectorAll('.raw-view-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        const language = mode === 'lines' ? 'plaintext' : 'json';
        container.dataset.language = language;
        const editor = this.monacoEditors.get(container.id);
        if (editor) {
            editor.setValue(this.resolveContentForContainer(container));
            const model = editor.getModel();
            if (model && window.monaco) monaco.editor.setModelLanguage(model, language);
        }
    }

    copyContent(index, type) {
        const tx = this.txFor(index);
        if (!tx) {
            this.showToast('Transaction not found', 'error');
            return;
        }

        // Get request content - same lookup as the card's request pane
        let requestContent = this.requestBodyFor(tx) || 'Request data not available';

        // Resolve per-transaction endpoint info (same as buildCardBody)
        const execIdForEndpoint = this.execIdFor(tx);
        const txEndpointInfo = execIdForEndpoint ? this.execIdToEndpointInfo?.get(execIdForEndpoint) : null;

        // GitHub Issue #199: Use currently displayed content (body or details) for copy
        const requestContainer = document.getElementById(`monaco-request-${index}`);
        const requestMode = requestContainer?.dataset?.requestMode || 'body';
        if (requestMode === 'details') {
            requestContent = this.buildGetRequestSummary(txEndpointInfo);
        }

        // GitHub Issue #2: Use currently displayed content (body or headers) for copy
        const responseContainer = document.getElementById(`monaco-response-${index}`);
        const responseMode = responseContainer?.dataset?.responseMode || 'body';
        // GitHub Issue #183: Handle string responses (HTML, plain text) without double-encoding
        const responseContent = responseMode === 'headers'
            ? this.buildResponseHeadersSummary(tx)
            : this.jsonlFormatFor(tx) && responseContainer
                ? this.resolveContentForContainer(responseContainer)
            : tx.data
                ? (typeof tx.data === 'string' ? tx.data : JSON.stringify(tx.data, null, 2))
                : 'No response data';

        // GitHub Issue #174: Copy All uses rich HTML clipboard
        if (type === 'both') {
            this.copyAllAsHtml(tx, index, requestContent, responseContent);
            return;
        }

        let textToCopy = '';
        if (type === 'request') {
            textToCopy = typeof requestContent === 'string' ? requestContent : JSON.stringify(requestContent, null, 2);
        } else if (type === 'response') {
            textToCopy = responseContent;
        } else if (type === 'data') {
            const csvRows = this.getCsvRowData(tx, index);
            if (csvRows && csvRows.length > 0) {
                // Format as JSON array if multiple rows, single object if one row
                textToCopy = csvRows.length === 1
                    ? JSON.stringify(csvRows[0], null, 2)
                    : JSON.stringify(csvRows, null, 2);
            } else {
                textToCopy = 'No CSV data available';
            }
        }

        window.DbmnClipboard.writeText(textToCopy).then(ok => {
            this.showToast(ok ? 'Copied to clipboard' : 'Failed to copy', ok ? 'success' : 'error');
        });
    }

    /**
     * GitHub Issue #183: Switch between Raw/Render/Text view modes for HTML responses
     * Uses shadow DOM with dark-mode-friendly base styles for Render mode
     * Text mode strips all HTML tags for plain text extraction
     */
    setViewMode(index, mode) {
        const monaco = document.getElementById(`monaco-response-${index}`);
        const render = document.getElementById(`html-render-${index}`);
        const text = document.getElementById(`html-text-${index}`);
        if (!monaco) return;

        // Hide all views
        monaco.classList.add('hidden');
        if (render) render.classList.add('hidden');
        if (text) text.classList.add('hidden');

        if (mode === 'raw') {
            monaco.classList.remove('hidden');
        } else if (mode === 'render' && render) {
            render.classList.remove('hidden');
            // Lazy-load shadow DOM on first use — resolve HTML from in-memory array
            if (!render.shadowRoot) {
                try {
                    const tx = this.txFor(monaco.dataset.txIndex);
                    const html = tx && typeof tx.data === 'string' ? tx.data : '';
                    const shadow = render.attachShadow({ mode: 'open' });
                    const baseStyles = `<style>
                        :host { background: transparent; color: inherit; display: block; padding: 12px; }
                        * { background: transparent !important; color: inherit !important; }
                        a { color: var(--vscode-textLink-foreground, #3794ff) !important; }
                        img { max-width: 100%; }
                        table { border-collapse: collapse; width: 100%; }
                        th, td { border: 1px solid var(--vscode-panel-border, #444); padding: 6px 10px; text-align: left; }
                        th { font-weight: 600; }
                        h1, h2, h3, h4, h5, h6 { color: var(--vscode-foreground) !important; }
                        pre, code { font-family: var(--vscode-editor-font-family, monospace); }
                    </style>`;
                    shadow.innerHTML = baseStyles + html;
                    // Strip scripts for safety
                    shadow.querySelectorAll('script').forEach(s => s.remove());
                } catch (e) {
                    render.textContent = 'Failed to render HTML content';
                }
            }
        } else if (mode === 'text' && text) {
            text.classList.remove('hidden');
            // Lazy-load text extraction on first use — resolve HTML from in-memory array
            if (!text.dataset.loaded) {
                try {
                    const tx = this.txFor(monaco.dataset.txIndex);
                    const html = tx && typeof tx.data === 'string' ? tx.data : '';
                    const tmp = document.createElement('div');
                    tmp.innerHTML = html;
                    text.textContent = tmp.textContent || tmp.innerText || '';
                    text.dataset.loaded = 'true';
                } catch (e) {
                    text.textContent = 'Failed to extract text content';
                }
            }
        }

        // Update active button state
        const group = monaco.closest('.raw-response-pane')?.querySelector('.raw-view-mode-group');
        if (group) {
            group.querySelectorAll('.raw-view-mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }
    }

    /**
     * GitHub Issue #199: Switch between Body/Details view modes for REQUEST pane
     * Swaps Monaco editor content and updates language mode
     */
    setRequestViewMode(index, mode) {
        const container = document.getElementById(`monaco-request-${index}`);
        if (!container) return;

        // Update mode before resolving content (resolveContentForContainer reads requestMode)
        container.dataset.requestMode = mode;
        const language = mode === 'body' ? 'json' : 'plaintext';

        // Resolve content from in-memory arrays
        const content = this.resolveContentForContainer(container);

        // Update Monaco editor if it exists
        const editor = this.monacoEditors.get(container.id);
        if (editor) {
            editor.setValue(content);
            const model = editor.getModel();
            if (model && window.monaco) {
                monaco.editor.setModelLanguage(model, language);
            }
        } else {
            // Editor not yet created - update language for when it's created
            container.dataset.language = language;
        }

        // Update active button state
        const group = container.closest('.raw-request-pane')?.querySelector('.raw-view-mode-group');
        if (group) {
            group.querySelectorAll('.raw-view-mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }
    }

    /**
     * Copy All as rich HTML for paste into Outlook/Excel/Confluence
     * GitHub Issue #174: Builds styled HTML with CSV table, request, and response sections
     * Colours: brand blue (#0078d4) for CSV/Request, green/red for response based on status
     */
    copyAllAsHtml(tx, index, requestContent, responseContent) {
        const show = this.showFor(index);
        const rawStatus = tx.status || tx.metadata?.status || '';
        const status = this.normalizeStatus(rawStatus);
        const isError = (status === 'error');
        const responseColor = isError ? '#D13438' : '#107C10';
        const brandBlue = '#0078d4';
        const fontStyle = 'font-family: Arial, sans-serif; font-size: 12px;';
        const sectionHeadingStyle = `padding: 8px 12px; color: white; font-weight: bold; font-size: 13px; margin: 0;`;

        let html = `<div style="${fontStyle}">`;

        // CSV Data section
        if (show.showData) {
            const csvRows = this.getCsvRowData(tx, index);
            if (csvRows && csvRows.length > 0) {
                const columns = Object.keys(csvRows[0]).filter(col => !col.startsWith('__'));
                if (columns.length > 0) {
                    html += `<p style="${sectionHeadingStyle} background-color: ${brandBlue};">INPUT DATA</p>`;
                    html += '<table style="border-collapse: collapse; width: 100%; margin-bottom: 16px;">';
                    html += '<thead><tr>';
                    for (const col of columns) {
                        html += `<th style="border: 1px solid #ddd; padding: 6px 8px; background-color: ${brandBlue}; color: white; text-align: left; font-size: 12px;">${this.escapeHtml(col)}</th>`;
                    }
                    html += '</tr></thead><tbody>';
                    csvRows.forEach((row, i) => {
                        const bg = i % 2 === 0 ? '#ffffff' : '#f9f9f9';
                        html += '<tr>';
                        for (const col of columns) {
                            html += `<td style="border: 1px solid #ddd; padding: 6px 8px; background-color: ${bg}; font-size: 12px;">${this.escapeHtml(String(row[col] ?? ''))}</td>`;
                        }
                        html += '</tr>';
                    });
                    html += '</tbody></table>';
                }
            }
        }

        // Simple light-background pre styling for external apps (Outlook, Teams, Confluence)
        // External apps apply their own backgrounds, so hardcoded light values work everywhere
        const preStyle = `background-color: #f5f5f5; border: 1px solid #ddd; padding: 10px; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-wrap: break-word;`;

        // Request section
        if (show.showRequest) {
            const reqText = typeof requestContent === 'string' ? requestContent : JSON.stringify(requestContent, null, 2);
            html += `<p style="${sectionHeadingStyle} background-color: ${brandBlue};">REQUEST</p>`;
            html += `<pre style="${preStyle} margin-bottom: 16px;">${this.escapeHtml(reqText)}</pre>`;
        }

        // Response section
        if (show.showResponse) {
            html += `<p style="${sectionHeadingStyle} background-color: ${responseColor};">RESPONSE (${status.toUpperCase()})</p>`;
            html += `<pre style="${preStyle}">${this.escapeHtml(responseContent)}</pre>`;
        }

        html += '</div>';

        // Build plain text fallback for text/plain clipboard entry
        const plainParts = [];
        if (show.showRequest) {
            const reqText = typeof requestContent === 'string' ? requestContent : JSON.stringify(requestContent, null, 2);
            plainParts.push('REQUEST\n' + reqText);
        }
        if (show.showResponse) {
            plainParts.push(`RESPONSE (${status.toUpperCase()})\n` + responseContent);
        }
        const plainText = plainParts.join('\n\n');

        // Rich clipboard: use Clipboard API to write both text/html and text/plain
        // This puts the exact HTML on the clipboard without DOM serialization stripping styles
        this.writeRichClipboard(html, plainText);
    }

    /**
     * Write rich HTML + plain text to the clipboard (Outlook/Excel/Confluence keep
     * the formatting). The Clipboard API, its execCommand fallback and the
     * plain-text last resort all live in shared/dbmn-clipboard.js.
     */
    writeRichClipboard(html, plainText) {
        window.DbmnClipboard.writeRich(html, plainText).then(ok => {
            this.showToast(ok ? 'Copied to clipboard' : 'Failed to copy', ok ? 'success' : 'error');
        });
    }

    /**
     * Show toast notification via the shared DbmnToast overlay. No `source`:
     * copy results stack (and each carries a dismiss button) rather than
     * replacing each other, so a second copy can't erase the first's outcome.
     */
    showToast(message, type = 'info') {
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message);
        }
    }

    /**
     * View logs for a transaction in a modal
     * GitHub Issue #166: Opens log file in Monaco editor modal
     */
    viewLogs(index) {
        const tx = this.txFor(index);
        if (!tx) {
            this.showToast('Transaction not found', 'error');
            return;
        }

        // Get the request file to derive log file path
        const execId = this.execIdFor(tx);

        // Try to resolve log path from transaction summary, otherwise let backend resolve from executionId
        const txSummary = this.transactionSummaries.find(s => s.executionId === execId);
        const logFilePath = txSummary?.logPath || (txSummary?.requestFile ? txSummary.requestFile.replace(/\.[^/.]+$/, '.log') : null);

        // Request log content from backend (backend can resolve logPath from executionId if not provided)
        vscode.postMessage({
            type: 'console.get_transaction_log',
            correlationId: `log_${Date.now()}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                logFilePath: logFilePath,
                executionId: execId,
                transactionIndex: this.getTransactions().indexOf(tx) + 1
            }
        });

        // Show loading modal
        this.showLogsModal(this.transactionTitle(tx), '// Loading logs...');
    }

    /**
     * Reprocess a single failed transaction. Batch members are reprocessed
     * in-batch; an individual transaction is re-run in place (the host
     * decides by execution type).
     */
    retryMember(index) {
        const tx = this.txFor(index);
        if (!tx) {
            this.showToast('Transaction not found', 'error');
            return;
        }

        // Optimistic UI: show the card as pending with its button disabled
        // (count is updated when the result arrives from the backend)
        const card = this.cardFor(index);
        if (card) {
            const badge = card.querySelector('.raw-status-badge');
            if (badge) {
                badge.textContent = 'PENDING';
                badge.className = 'raw-status-badge status-pending';
            }
            card.querySelector('.raw-card-reason')?.remove(); // #428: it is being tried again
            const retryBtn = card.querySelector('.raw-retry-btn');
            if (retryBtn) {
                retryBtn.disabled = true;
                retryBtn.className = 'raw-retry-btn retrying';
                retryBtn.title = 'Reprocessing...';
            }
        }

        this.reprocessTransaction(tx);
    }

    /**
     * Show logs modal with Monaco editor
     */
    showLogsModal(title, content) {
        // Remove existing modal if present
        this.closeLogsModal();

        const modal = document.createElement('div');
        modal.className = 'raw-logs-modal-overlay';
        modal.innerHTML = `
            <div class="raw-logs-modal">
                <div class="raw-logs-modal-header">
                    <span class="raw-logs-modal-title">Logs: ${this.escapeHtml(title)}</span>
                    <div class="raw-logs-modal-actions">
                        <button type="button" class="raw-logs-modal-copy" data-click="raw:copyLogsContent" title="Copy Logs">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                            Copy
                        </button>
                        <button type="button" class="raw-logs-modal-close" data-click="raw:closeLogsModal" title="Close">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
                        </button>
                    </div>
                </div>
                <div class="raw-logs-modal-body">
                    <div class="raw-logs-monaco-container" id="logs-modal-editor"></div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeLogsModal();
            }
        });

        // Close on Escape key
        this.logsModalEscHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeLogsModal();
            }
        };
        document.addEventListener('keydown', this.logsModalEscHandler);

        // Store content for copy
        this.logsModalContent = content;

        // Create Monaco editor for logs
        this.createLogsModalEditor(content);
    }

    /**
     * Create Monaco editor in logs modal
     */
    createLogsModalEditor(content) {
        const container = document.getElementById('logs-modal-editor');
        if (!container) return;

        if (!this.monacoReady || !window.monaco) {
            // Monaco not ready - show plain text
            container.innerHTML = `<pre class="raw-logs-fallback">${this.escapeHtml(content)}</pre>`;
            return;
        }

        try {
            // Dispose existing editor if any
            if (this.logsModalEditor) {
                this.logsModalEditor.dispose();
            }

            this.logsModalEditor = monaco.editor.create(container, {
                value: content,
                language: 'plaintext', // Formatted logs with emojis
                theme: 'vscode-current',
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                folding: false,
                lineNumbers: 'off',
                renderLineHighlight: 'none',
                contextmenu: true,
                scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto'
                },
                fontSize: 13,
                lineHeight: 20,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace'
            });
        } catch (e) {
            console.error('Failed to create logs Monaco editor:', e);
            container.innerHTML = `<pre class="raw-logs-fallback">${this.escapeHtml(content)}</pre>`;
        }
    }

    /**
     * Update logs modal content (called when backend responds)
     */
    updateLogsModalContent(content) {
        this.logsModalContent = content;

        if (this.logsModalEditor && window.monaco) {
            this.logsModalEditor.setValue(content);
        } else {
            const container = document.getElementById('logs-modal-editor');
            if (container) {
                this.createLogsModalEditor(content);
            }
        }
    }

    /**
     * Copy logs content to clipboard
     */
    copyLogsContent() {
        if (this.logsModalContent) {
            window.DbmnClipboard.writeText(this.logsModalContent).then(ok => {
                this.showToast(ok ? 'Logs copied to clipboard' : 'Failed to copy', ok ? 'success' : 'error');
            });
        }
    }

    /**
     * Close logs modal
     */
    closeLogsModal() {
        const modal = document.querySelector('.raw-logs-modal-overlay');
        if (modal) {
            modal.remove();
        }

        if (this.logsModalEditor) {
            this.logsModalEditor.dispose();
            this.logsModalEditor = null;
        }

        if (this.logsModalEscHandler) {
            document.removeEventListener('keydown', this.logsModalEscHandler);
            this.logsModalEscHandler = null;
        }

        this.logsModalContent = null;
    }

    /**
     * Handle log content response from backend
     */
    handleLogContentResponse(payload) {
        if (!payload) return;

        const content = payload.content || '// No log content available';
        this.updateLogsModalContent(content);
    }

    /**
     * Attach event handlers for filter controls
     */
    attachEventHandlers() {
        // Issue #306: Status filter sits in the bar
        const statusSelect = document.getElementById('raw-status-select');
        if (statusSelect) {
            statusSelect.addEventListener('change', () => {
                this.state.statusFilter = statusSelect.value;
                this._statusFilterChosen = true; // Issue #312: the user's pick outlives the batch
                this._autoRunningFilter = false;
                this.refreshContent();
            });
        }

        // Show chips and single-transaction search — delegated so the modal's
        // copy of the card gets them too.
        this.setupSoloControls();

        // Search input with debounce
        const searchInput = document.getElementById('raw-search-input');
        if (searchInput) {
            let searchTimeout;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    this.state.searchTerm = e.target.value;
                    this.refreshContent();
                }, 300);
            });
        }

        // Search clear button
        const searchClear = document.getElementById('raw-search-clear');
        if (searchClear) {
            searchClear.addEventListener('click', () => {
                this.state.searchTerm = '';
                const input = document.getElementById('raw-search-input');
                if (input) input.value = '';
                this.refreshContent();
            });
        }

        // Expand all — toggle CSS classes, then re-fire bodyObserver for visible cards
        const expandAll = document.getElementById('raw-expand-all');
        if (expandAll) {
            expandAll.addEventListener('click', () => {
                this.state.allExpanded = true;
                document.querySelectorAll('.raw-tab-container .raw-card').forEach(card => {
                    card.classList.remove('collapsed');
                    card.classList.add('expanded');
                    const toggle = card.querySelector('.raw-card-toggle');
                    if (toggle) toggle.innerHTML = window.Icons.icon('chevron-down');
                });
                // Disconnect and re-observe to re-fire bodyObserver for cards near viewport
                if (this.bodyObserver) {
                    this.bodyObserver.disconnect();
                    document.querySelectorAll('.raw-tab-container .raw-card').forEach(card => {
                        this.bodyObserver.observe(card);
                    });
                }
            });
        }

        // Collapse all — toggle CSS classes, then clear all rendered bodies to reclaim DOM
        const collapseAll = document.getElementById('raw-collapse-all');
        if (collapseAll) {
            collapseAll.addEventListener('click', () => {
                this.state.allExpanded = false;
                document.querySelectorAll('.raw-tab-container .raw-card').forEach(card => {
                    card.classList.remove('expanded');
                    card.classList.add('collapsed');
                    const toggle = card.querySelector('.raw-card-toggle');
                    if (toggle) toggle.innerHTML = window.Icons.icon('chevron-right');
                });
                // Clear all rendered bodies to reclaim DOM elements
                this.renderedBodies.forEach(index => {
                    const card = this.cardFor(index);
                    if (card) {
                        this.clearBodyForCard(card, index);
                    }
                });
            });
        }

        // Per-pane fullscreen toggle (GitHub Issue #254) — event delegation over
        // .raw-tab-container so newly-rendered card chunks pick it up for free.
        this.setupPaneFullscreenToggles();

        // Stack request/response panes when the tab is too narrow for both
        // side by side (GitHub Issue #292).
        this.setupPaneStacking();
    }

    /**
     * Issue #306: Show chips (list bar, single view, modal) and the search box
     * of a single transaction. Bound once on document; each control names its
     * view with data-view-key.
     */
    setupSoloControls() {
        if (this._soloControlsBound) return;
        this._soloControlsBound = true;

        document.addEventListener('click', (e) => {
            const chip = e.target.closest?.('.raw-show-chip');
            if (!chip || chip.disabled) return;
            const key = chip.closest('[data-view-key]')?.dataset.viewKey;
            if (key) this.toggleShow(key, chip.dataset.show);
        });

        let searchTimer;
        document.addEventListener('input', (e) => {
            const input = e.target.closest?.('.raw-solo-search');
            if (!input) return;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const key = input.dataset.viewKey;
                if (key === RawTabHandler.MODAL_KEY) {
                    if (this.modal) this.modal.searchTerm = input.value;
                } else {
                    this.state.searchTerm = input.value;
                }
                this.highlightSearchInView(key);
            }, 200);
        });
    }

    /** Flip one Show toggle for a view and apply it. */
    toggleShow(key, prop) {
        const isModal = key === RawTabHandler.MODAL_KEY;
        if (isModal && !this.modal) return;
        const state = isModal ? this.modal.show : this.state;
        state[prop] = !this.showFor(key)[prop];
        this.applyShow(key);
    }

    /**
     * Apply a view's effective Show state to its cards and chips. The list
     * bar and the single view share this.state, so both resolve to the Raw tab.
     */
    applyShow(key) {
        const isModal = key === RawTabHandler.MODAL_KEY;
        const root = isModal ? this.modal?.el : document.querySelector('.raw-tab-container');
        if (!root) return;
        const viewKey = isModal ? key : (this.isSingleMode() ? '0' : RawTabHandler.LIST_KEY);
        const show = this.showFor(viewKey);
        this.togglePaneVisibility(root, show);
        this.toggleRequestResponseVisibility(root, show);
        root.querySelectorAll('.raw-show-group').forEach(group => {
            group.querySelectorAll('.raw-show-chip').forEach(chip => {
                const prop = chip.dataset.show;
                chip.setAttribute('aria-pressed', show[prop] ? 'true' : 'false');
                if (prop === 'showData') chip.disabled = !show.hasInput;
            });
        });
        this._appliedShow = this._appliedShow || {};
        this._appliedShow[isModal ? 'modal' : 'raw'] = JSON.stringify(show);
    }

    /**
     * Issue #306: auto Show values (Request off without a body, Input on for
     * a single transaction) can change once a body or the input rows load.
     * Re-apply only where the resolved state actually moved.
     */
    applyAutoShow() {
        const targets = [];
        if (document.querySelector('.raw-tab-container .raw-card')) {
            targets.push([this.isSingleMode() ? '0' : RawTabHandler.LIST_KEY, 'raw']);
        }
        if (this.modal) targets.push([RawTabHandler.MODAL_KEY, 'modal']);
        for (const [key, slot] of targets) {
            const next = JSON.stringify(this.showFor(key));
            if (this._appliedShow?.[slot] !== next) this.applyShow(key);
        }
    }

    /**
     * GitHub Issue #292: below PANE_STACK_BREAKPOINT the two Raw panes share
     * too little width for their header controls, so they stack vertically.
     * One ResizeObserver on the tab container (not a CSS container query —
     * inline-size containment would make the section the containing block
     * for the position:fixed fullscreen pane). Monaco editors are created
     * with automaticLayout so they follow the grid change on their own.
     */
    setupPaneStacking() {
        if (this._paneStackingBound) return;
        const host = document.querySelector('.raw-tab-container') || document.body;
        if (!host || !window.ResizeObserver) return;
        this._paneStackingBound = true;
        const apply = (width) => {
            const stacked = width > 0 && width < RawTabHandler.PANE_STACK_BREAKPOINT;
            if (stacked === this._panesStacked) return;
            this._panesStacked = stacked;
            document.querySelectorAll('.raw-tab-container .raw-panes-container').forEach(c => {
                c.classList.toggle('is-stacked', stacked);
            });
        };
        apply(host.clientWidth);
        new ResizeObserver(entries => {
            for (const entry of entries) apply(entry.contentRect.width);
        }).observe(host);
    }

    /**
     * GitHub Issue #254: Fullscreen toggle for RAW request/response Monaco panes.
     * Mirrors the Body-editor pattern (endpoint.js: setupFullscreenToggle) —
     * toggle a CSS class on the pane, ask Monaco to re-layout, Esc exits.
     * Delegated on document so it survives card re-renders.
     */
    setupPaneFullscreenToggles() {
        if (this._paneFullscreenBound) return;
        this._paneFullscreenBound = true;

        document.addEventListener('click', (e) => {
            const btn = e.target.closest?.('.raw-pane-fullscreen-btn');
            if (!btn) return;
            e.stopPropagation();
            const pane = btn.closest('.raw-pane');
            if (!pane) return;
            this.togglePaneFullscreen(pane);
        });

        // Capture phase: Esc leaves full window before anything else sees it —
        // inside the transaction modal it must not also close the modal.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const pane = document.querySelector('.raw-pane.raw-pane-fullscreen');
            if (!pane) return;
            // Yield to Monaco's find widget if it owns the keystroke.
            if (pane.querySelector('.find-widget.visible')) return;
            e.stopPropagation();
            this.togglePaneFullscreen(pane, false);
        }, true);
    }

    togglePaneFullscreen(pane, force) {
        const on = typeof force === 'boolean' ? force : !pane.classList.contains('raw-pane-fullscreen');
        pane.classList.toggle('raw-pane-fullscreen', on);
        // Footer becomes a hover/focus "peek bar" while full-window (core.css).
        document.body.classList.toggle('is-editor-fullscreen', on);
        const btn = pane.querySelector('.raw-pane-fullscreen-btn');
        if (btn) {
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.setAttribute('title', on ? 'Exit full window (Esc)' : 'Toggle full window (Esc to exit)');
        }
        // Let the browser apply the new box before Monaco re-measures.
        requestAnimationFrame(() => {
            const container = pane.querySelector('.raw-monaco-container');
            if (!container) return;
            const editor = this.monacoEditors.get(container.id);
            if (editor) editor.layout();
        });
    }

    /**
     * Toggle CSV data section visibility via CSS class on wrapper — smooth grid-template-rows transition
     */
    togglePaneVisibility(root, show) {
        root.querySelectorAll('.raw-card').forEach(card => {
            const wrapper = card.querySelector('.raw-csv-data-wrapper');
            if (wrapper) wrapper.classList.toggle('raw-section-hidden', !show.showData);
        });
    }

    /**
     * Toggle Request/Response pane visibility with CSS class toggles.
     * Horizontal collapse via grid-template-columns on .raw-panes-container.
     * Vertical collapse via grid-template-rows on .raw-panes-wrapper when both hidden.
     */
    toggleRequestResponseVisibility(root, show) {
        root.querySelectorAll('.raw-card-body-inner').forEach(inner => {
            const wrapper = inner.querySelector('.raw-panes-wrapper');
            const container = inner.querySelector('.raw-panes-container');
            const emptyMsg = inner.querySelector('.raw-compact-view');
            if (!container) return;

            const requestPane = container.querySelector('.raw-request-pane');
            const responsePane = container.querySelector('.raw-response-pane');

            // Freeze height of all panes during transition — prevents word-wrap height jumps
            if (requestPane && requestPane.offsetHeight > 0) {
                requestPane.style.maxHeight = requestPane.offsetHeight + 'px';
            }
            if (responsePane && responsePane.offsetHeight > 0) {
                responsePane.style.maxHeight = responsePane.offsetHeight + 'px';
            }

            // Update column classes
            container.classList.toggle('request-hidden', !show.showRequest);
            container.classList.toggle('response-hidden', !show.showResponse);

            const bothHidden = !show.showRequest && !show.showResponse;
            container.classList.toggle('both-hidden', bothHidden);

            // Vertical collapse wrapper when both hidden
            if (wrapper) wrapper.classList.toggle('raw-section-hidden', bothHidden);

            // Empty state message
            if (emptyMsg) emptyMsg.style.display = bothHidden ? 'block' : 'none';
        });

        // Kick Monaco observers for newly visible panes
        if (show.showRequest || show.showResponse) {
            this.kickMonacoForNewlyVisiblePanes();
        }

        // After column transition (0.3s), unfreeze visible panes and re-layout editors
        setTimeout(() => {
            root.querySelectorAll('.raw-pane').forEach(pane => {
                if (pane.offsetWidth > 0) {
                    pane.style.maxHeight = '';
                }
            });
            this.monacoEditors.forEach((editor, id) => {
                const mc = document.getElementById(id);
                if (mc && mc.offsetWidth > 0) {
                    editor.layout();
                    const newHeight = Math.min(400, Math.max(100, editor.getContentHeight()));
                    mc.style.height = newHeight + 'px';
                    editor.layout();
                }
            });
        }, 350);
    }

    /**
     * Re-observe Monaco containers in newly visible panes via IntersectionObserver.
     * When a pane transitions from 0fr to 1fr, its Monaco containers gain non-zero width
     * and the observer fires naturally to create the editor.
     */
    kickMonacoForNewlyVisiblePanes() {
        if (!this.editorObserver) return;
        document.querySelectorAll('.raw-tab-container .raw-panes-container .raw-monaco-container').forEach(c => {
            if (!this.monacoEditors.has(c.id)) {
                this.editorObserver.observe(c);
            }
        });
    }

    /**
     * Refresh content (keeps filter bar, updates cards)
     */
    refreshContent() {
        // Cancel any in-progress chunked rendering
        this.cancelChunkedRendering();
        // Dispose all existing editors before rebuilding content
        this.disposeAllEditors();
        // Clear rendered bodies — card headers rebuilt, bodies lazy
        this.renderedBodies.clear();
        // Reset incremental content check so full scan runs after refresh
        this.lastContentCheckIndex = 0;

        const filtered = this.getFilteredTransactions();
        const initialCount = Math.min(this.INITIAL_RENDER_COUNT, filtered.length);

        // GitHub Issue #222: Use replaceChildren instead of outerHTML to keep
        // the .raw-cards-container element in the DOM, preventing layout reflow flash
        const container = document.querySelector('.raw-cards-container');
        if (container) {
            const cardsHtml = filtered.length === 0
                ? '<div class="raw-empty-state">No transactions match your filters</div>'
                : Array.from({ length: initialCount }, (_, i) => this.cardHtmlAt(filtered, i)).join('');
            const template = document.createElement('template');
            template.innerHTML = cardsHtml;
            container.replaceChildren(...template.content.childNodes);
        }

        // Update counter
        const counter = document.getElementById('raw-counter');
        if (counter) {
            const totalCount = this.getTransactions().length;
            counter.textContent = `Showing ${filtered.length} of ${totalCount} transactions`;
        }

        // Update clear button visibility
        const clearBtn = document.getElementById('raw-search-clear');
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !this.state.searchTerm);
        }

        // Re-initialize Monaco editors for visible cards
        this.initializeMonacoEditors();

        // Render remaining cards in async chunks
        if (filtered.length > initialCount) {
            this.renderRemainingChunks(initialCount, filtered);
        }
    }

    /**
     * Reset state (called when report changes)
     */
    reset() {
        this.disposeAllEditors(); // This also cleans up the observer
        this.cancelChunkedRendering();
        // Remove cached DOM so next render() builds fresh
        const existing = document.querySelector('.raw-tab-container');
        if (existing) existing.remove();
        this.state = RawTabHandler.defaultState();
        this.closeTransactionModal();
        this.loadedRequestContent.clear();
        this.contentLoadRequested = false;
        this.summariesLoaded = false;
        this.lastContentCheckIndex = 0;
        this.sourceFileToExecId.clear();
        this.execIdToRowInfo.clear();
        this.transactionSummaries = [];
    }

    /**
     * Reconcile stale transaction stubs when batch reaches terminal state.
     * Any stub still marked 'running' or 'pending' that has no real response data
     * is updated to 'completed' (the result arrived but the stub wasn't matched).
     */
    reconcileStaleStubs() {
        const transactions = this.getTransactions();
        let changed = false;

        for (const tx of transactions) {
            const rawStatus = tx.status || tx.metadata?.status || '';
            const normalized = this.normalizeStatus(rawStatus);

            if (normalized === 'running' || normalized === 'pending') {
                // Stub with actual response data — result arrived but status wasn't updated
                if (tx.data !== null && tx.data !== undefined) {
                    const newStatus = 'completed';
                    tx.status = newStatus;
                    if (tx.metadata) tx.metadata.status = newStatus;
                    changed = true;
                }
            }
        }

        if (changed) {
            this.updateFilterBarCounts();
            this._processNewResults();
        }
    }

    /**
     * Handle new transaction result during batch execution
     * Called when batch_member_result_update is received and RAW tab is active
     * Debounces rapid-fire results and appends only new cards incrementally
     */
    handleNewResult(executionId) {
        // Issue #312: remember WHICH transactions changed so the pass below touches
        // only their cards. No id (older callers) means "look at everything".
        if (!this._dirtyExecIds) this._dirtyExecIds = new Set();
        if (executionId) this._dirtyExecIds.add(executionId); else this._dirtyAll = true;
        if (this.newResultTimer) clearTimeout(this.newResultTimer);
        this.newResultTimer = setTimeout(() => this._processNewResults(), 500);
    }

    /**
     * Issue #312: the batch's status, from the Console. While it runs, the Raw tab opens
     * on Running only (a handful of cards instead of thousands); the moment it ends that
     * default steps back to All — unless the user had picked a filter themselves.
     */
    onExecutionStatus(status) {
        const running = this.isLiveStatus(status);
        if (!running && this._autoRunningFilter) {
            this._autoRunningFilter = false;
            this.state.statusFilter = 'all';
            if (document.querySelector('.raw-cards-container')) {
                const select = document.getElementById('raw-status-select');
                if (select) select.value = 'all';
                this.refreshContent();
            }
        }
    }

    isLiveStatus(status) {
        const badge = document.getElementById('status-badge');
        const s = String(status || window.currentExecutionStatus || (badge && badge.textContent) || '').toLowerCase();
        return /running|pending|preparing|executing/.test(s);
    }

    /**
     * Process new results: append new cards AND update existing cards whose status changed
     * (e.g., pending/running stubs replaced with completed/error results)
     * Falls back to full render if no container exists yet
     */
    _processNewResults() {
        // Issue #296: the modal's transaction may be the one that changed.
        this.refreshModal();

        const rawContainer = document.querySelector('.raw-tab-container');
        // Issue #306: a second transaction turns the single view into the
        // list (and a report reload can go the other way) — rebuild.
        if (rawContainer && (rawContainer.dataset.mode === 'single') !== this.isSingleMode()
            && !rawContainer.querySelector('.raw-empty-state')) {
            const visible = rawContainer.style.display !== 'none';
            this.disposeAllEditors();
            this.cancelChunkedRendering();
            rawContainer.remove();
            if (visible) this.render();
            return;
        }

        const container = document.querySelector('.raw-cards-container');
        if (!container) {
            // RAW tab not rendered yet — render it if it is the one showing
            if (this.reportManager.currentTab === 'raw') this.render();
            return;
        }

        // Issue #312: the unfiltered list is append-only, so with only some transactions
        // changed, only their cards need touching (a big batch has thousands).
        const unfiltered = this.state.statusFilter === 'all' && !this.state.searchTerm;
        if (unfiltered && !this._dirtyAll && this._dirtyExecIds && this._dirtyExecIds.size > 0) {
            const indexMap = this.reportManager._responseIndexMap;
            const all = this.getTransactions();
            for (const execId of this._dirtyExecIds) {
                const i = indexMap ? indexMap.get(execId) : undefined;
                const tx = i !== undefined ? all[i] : null;
                if (!tx) continue;
                const card = container.querySelector(`.raw-card[data-index="${i}"]`);
                if (card) this.refreshCard(card, tx, i);
            }
            this._dirtyExecIds.clear();
            this.appendNewCards(container, this.getFilteredTransactions(), container.querySelectorAll(':scope > .raw-card').length);
            this.updateFilterBarCounts();
            this.loadRequestContentForNewTransactions();
            return;
        }
        this._dirtyAll = false;
        this._dirtyExecIds?.clear();

        // #431: a filtered list changes as transactions start and finish (Running loses
        // one, Error gains one). It used to be rebuilt whole on every result: every card
        // on screen flashed, and one the user had closed opened again. Now each result
        // adds or takes away its own card, and the rest stay as they are.
        this.reconcileCards(container);
        this.updateFilterBarCounts();
        this.loadRequestContentForNewTransactions();
    }

    /**
     * A card's title and header up to date with its transaction; its body is rebuilt
     * later (when it scrolls into view or is opened) if the status changed.
     */
    refreshCard(card, tx, key) {
        const titleEl = card.querySelector('.raw-card-title');
        if (titleEl) {
            const newTitle = this.transactionTitle(tx);
            if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
        }
        if (this.refreshCardHeader(card, tx, key)) {
            // Mark stale — avoid rebuilding body during live execution to reduce GC churn.
            card.dataset.stale = 'true';
            if (this.renderedBodies.has(key)) this.clearBodyForCard(card, key);
            // A solo card is always open, so there is no scroll or expand
            // to rebuild it later — do it now.
            if (card.classList.contains('raw-card-solo')) {
                delete card.dataset.stale;
                this.buildBodyForCard(card, key);
            }
        }
    }

    /**
     * #431: bring the rendered cards in line with the list as it is now, card by card.
     * Cards that left the filter go, new ones go in at their place, the rest are
     * refreshed where they are — the same elements, so nothing flashes and what the
     * user opened, closed or scrolled to stays. With a "Scroll for more" window open,
     * the window keeps its size and the rest wait their turn in it.
     */
    reconcileCards(container) {
        const list = this.getFilteredTransactions();
        const sentinel = container.querySelector(':scope > .raw-cards-more');
        const cards = Array.from(container.querySelectorAll(':scope > .raw-card'));
        const shown = sentinel ? list.slice(0, cards.length) : list;
        const keys = shown.map(tx => this.keyOf(tx));
        const wanted = new Set(keys.map(String));

        for (const card of cards) {
            if (wanted.has(card.dataset.index)) continue;
            this.disposeEditorsInCard(card);
            this.renderedBodies.delete(Number(card.dataset.index));
            card.remove();
        }
        const byKey = new Map(cards.filter(card => card.isConnected).map(card => [card.dataset.index, card]));

        container.querySelector(':scope > .raw-empty-state')?.remove();
        const added = [];
        let previous = null;
        shown.forEach((tx, i) => {
            const key = keys[i];
            let card = byKey.get(String(key));
            if (card) {
                this.refreshCard(card, tx, key);
            } else {
                const template = document.createElement('template');
                template.innerHTML = this.buildCardHtml(tx, key, { solo: this.isSingleMode() }).trim();
                card = template.content.firstElementChild;
                added.push(key);
            }
            // In place: after the card before it (only a new card, or one whose place changed, moves)
            const expected = previous ? previous.nextElementSibling : container.firstElementChild;
            if (expected !== card) container.insertBefore(card, expected);
            previous = card;
        });

        if (list.length === 0) {
            container.insertAdjacentHTML('afterbegin', '<div class="raw-empty-state">No transactions match your filters</div>');
        }
        if (sentinel) {
            const more = list.length - shown.length;
            if (more > 0) sentinel.textContent = `Scroll for more (${more.toLocaleString()} more)`;
            else this.cancelChunkedRendering();
        }
        this.observeCardKeys(added);
    }

    /**
     * Issue #312: new transactions join the rendered list only when the whole list is
     * rendered; while a "Scroll for more" window is open they wait their turn in it
     * (its count is refreshed), and the Raw badge already says they arrived.
     */
    appendNewCards(container, filtered, currentCount) {
        const sentinel = container.querySelector('.raw-cards-more');
        if (sentinel) {
            sentinel.textContent = `Scroll for more (${(filtered.length - currentCount).toLocaleString()} more)`;
            return;
        }
        for (let i = currentCount; i < filtered.length; i++) {
            container.insertAdjacentHTML('beforeend', this.cardHtmlAt(filtered, i));
            this.observeCardKeys([this.keyOf(filtered[i])]);
        }
    }

    /**
     * Bring a card header up to date with its transaction's status — in
     * place, no rebuild, no flash. Returns true when the status changed.
     */
    refreshCardHeader(card, tx, key) {
        const badge = card.querySelector('.raw-status-badge');
        if (!badge) return false;

        const currentStatus = this.normalizeStatus(tx.status || tx.metadata?.status || '');
        // #428: a test failure's badge says TEST FAILED, and its card says why
        const testFailed = !!window.ConsoleErrorReason?.isTestFailure(tx);
        const label = testFailed ? 'TEST FAILED' : currentStatus.toUpperCase();
        if (badge.textContent.trim() === label) return false;

        badge.textContent = label;
        badge.className = `raw-status-badge ${testFailed ? 'status-test-failed' : this.getStatusClass(currentStatus)}`;

        card.querySelector('.raw-card-reason')?.remove();
        const reasonHtml = currentStatus === 'error' && window.ConsoleErrorReason ? this.buildReasonLine(tx, testFailed) : '';
        if (reasonHtml) card.querySelector('.raw-card-header')?.insertAdjacentHTML('afterend', reasonHtml);

        const httpStatusEl = card.querySelector('.raw-http-status');
        if (httpStatusEl) {
            httpStatusEl.textContent = tx.httpStatus || '-';
            httpStatusEl.className = `raw-http-status ${this.getHttpStatusClass(tx.httpStatus || '-')}`;
        }

        // Update response time in card header
        const responseTime = tx.metadata?.responseTime;
        let responseTimeEl = card.querySelector('.raw-response-time');
        if (responseTime != null) {
            if (!responseTimeEl) {
                responseTimeEl = document.createElement('span');
                responseTimeEl.className = 'raw-response-time';
                httpStatusEl?.insertAdjacentElement('afterend', responseTimeEl);
            }
            responseTimeEl.textContent = `${responseTime}ms`;
        }

        // Update retry button based on new status
        this.updateRetryButton(card, tx, key, currentStatus);
        return true;
    }

    /**
     * Update or insert the Reprocess button in a card header to match the
     * transaction's current status.
     */
    updateRetryButton(card, tx, key, status) {
        const existingBtn = card.querySelector('.raw-retry-btn');
        const html = this.buildRetryButton(tx, key, status);
        if (existingBtn) {
            if (html) existingBtn.outerHTML = html; else existingBtn.remove();
        } else if (html) {
            card.querySelector('.raw-view-logs-btn')?.insertAdjacentHTML('beforebegin', html);
        }
    }

    /**
     * Update filter bar status counts and counter text
     */
    updateFilterBarCounts() {
        const statusSelect = document.getElementById('raw-status-select');
        if (statusSelect) {
            statusSelect.innerHTML = this.buildStatusOptions();
        }

        const counter = document.getElementById('raw-counter');
        if (counter) {
            const totalCount = this.getTransactions().length;
            const filteredCount = this.getFilteredTransactions().length;
            counter.textContent = `Showing ${filteredCount} of ${totalCount} transactions`;
        }
    }

    /**
     * Issue #296: open one transaction in a modal — the same card as the
     * single-transaction Raw view, with its own Show chips and search.
     */
    openTransactionModal(tx) {
        if (!tx || !window.DbmnModal) return;
        this.closeTransactionModal();
        // Show chips, search and full-window panes — the Raw tab may never
        // have bound them.
        this.setupSoloControls();
        this.setupPaneFullscreenToggles();

        const key = RawTabHandler.MODAL_KEY;
        const el = document.createElement('div');
        el.className = 'raw-modal-transaction';
        this.modal = {
            ref: RawTabHandler.txRef(tx),
            show: { showRequest: null, showResponse: true, showData: null },
            searchTerm: '',
            el
        };

        // Execution IDs, input rows and request bodies come from the same
        // host calls the Raw tab makes — the Raw tab may never have opened.
        this.loadRequestContent();
        this.requestContentFor([tx]);

        el.innerHTML = this.buildCardHtml(tx, key, { solo: true });
        el.querySelector('.raw-card-body-inner').innerHTML = this.buildCardBody(tx, key);
        this._appliedShow = this._appliedShow || {};
        this._appliedShow.modal = JSON.stringify(this.showFor(key));

        const closed = window.DbmnModal.show({
            title: this.transactionTitle(tx),
            body: el,
            actions: [{ id: 'close', label: 'Close', variant: 'secondary' }],
            size: 'transaction'
        });
        requestAnimationFrame(() => this.createEditorsIn(el));
        closed.then(() => {
            if (this.modal?.el === el) this.closeTransactionModal({ dismiss: false });
        });
    }

    /** Close the transaction modal and dispose its editors. */
    closeTransactionModal({ dismiss = true } = {}) {
        if (!this.modal) return;
        const card = this.cardFor(RawTabHandler.MODAL_KEY);
        if (card) {
            // A pane left full-window goes with the modal
            if (card.querySelector('.raw-pane-fullscreen')) {
                document.body.classList.remove('is-editor-fullscreen');
            }
            this.disposeEditorsInCard(card);
        }
        this.modal = null;
        if (dismiss && window.DbmnModal?.isOpen()) window.DbmnModal.requestDismiss();
    }

    /** Keep an open modal in step with its transaction's live status. */
    refreshModal() {
        if (!this.modal) return;
        const key = RawTabHandler.MODAL_KEY;
        const tx = this.txFor(key);
        const card = this.cardFor(key);
        if (!tx || !card) return;
        if (this.refreshCardHeader(card, tx, key)) {
            this.rebuildCardBody(key);
        }
    }

    /**
     * Issue #296: right-click menu for a Completed/Error row. View opens the
     * transaction modal; Reprocess is offered for error transactions only.
     */
    showTransactionMenu(event, tx) {
        if (!tx) return;
        event.preventDefault();
        this.closeTransactionMenu();

        const isError = this.normalizeStatus(tx.status || tx.metadata?.status || '') === 'error';
        const items = [
            { id: 'view', label: 'View transaction', run: () => this.openTransactionModal(tx) }
        ];
        if (isError) {
            items.push({ id: 'reprocess', label: 'Reprocess', run: () => this.reprocessTransaction(tx) });
        }

        const menu = document.createElement('div');
        menu.className = 'raw-context-menu';
        menu.setAttribute('role', 'menu');
        menu.style.position = 'fixed';
        items.forEach(item => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'raw-context-menu-item';
            btn.setAttribute('role', 'menuitem');
            btn.dataset.action = item.id;
            btn.textContent = item.label;
            btn.addEventListener('click', () => {
                this.closeTransactionMenu();
                item.run();
            });
            menu.appendChild(btn);
        });
        document.body.appendChild(menu);

        // Keep the menu on screen
        const rect = menu.getBoundingClientRect();
        const left = Math.min(event.clientX, window.innerWidth - rect.width - 4);
        const top = Math.min(event.clientY, window.innerHeight - rect.height - 4);
        menu.style.left = `${Math.max(4, left)}px`;
        menu.style.top = `${Math.max(4, top)}px`;
        // Focus without scrolling — a scroll closes the menu.
        menu.querySelector('button')?.focus({ preventScroll: true });

        const close = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && menu.contains(e.target)) return;
            this.closeTransactionMenu();
        };
        this._menuCloser = close;
        document.addEventListener('mousedown', close, true);
        document.addEventListener('keydown', close, true);
        window.addEventListener('blur', close);
        window.addEventListener('scroll', close, true);
    }

    closeTransactionMenu() {
        document.querySelectorAll('.raw-context-menu').forEach(m => m.remove());
        const close = this._menuCloser;
        if (!close) return;
        document.removeEventListener('mousedown', close, true);
        document.removeEventListener('keydown', close, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('scroll', close, true);
        this._menuCloser = null;
    }

    /**
     * Ask the host to reprocess a transaction. The real execution ID comes
     * with the Raw summaries, so wait for them if they haven't loaded yet.
     */
    reprocessTransaction(tx) {
        if (!this.summariesLoaded) {
            this.loadRequestContent();
            if (this.contentLoadRequested) {
                this._pendingReprocess = tx;
                return;
            }
        }
        const execId = this.execIdFor(tx);
        if (!execId) {
            this.showToast('Cannot identify transaction to reprocess', 'error');
            return;
        }
        vscode.postMessage({
            type: 'retryMember',
            correlationId: `retry_${Date.now()}`,
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionId: execId,
                batchId: window.currentBatchId
            }
        });
        this.showToast('Reprocessing transaction...', 'info');
    }

    /**
     * Load request content for transactions that don't have it yet
     * Called during live streaming to load new transaction content
     */
    loadRequestContentForNewTransactions() {
        // Issue #312: only for cards that are rendered. This scanned EVERY transaction
        // and asked the host for every request body it did not have — 14,000 ids in
        // one message on a big batch, 14,000 files read and posted back — every time
        // the user came back to the Raw tab. Cards that scroll into view fetch their
        // own content (contentObserver); this covers the ones already on screen.
        const container = document.querySelector('.raw-cards-container');
        const needsContent = [];
        if (container) {
            container.querySelectorAll('.raw-card[data-exec-id]').forEach(card => {
                const execId = card.dataset.execId;
                if (execId && !this.loadedRequestContent.has(execId) && !this.pendingContentRequests.has(execId)) {
                    needsContent.push(execId);
                }
            });
        }
        this.lastContentCheckIndex = this.getTransactions().length;

        if (needsContent.length > 0) {
            // Request content from backend
            vscode.postMessage({
                type: 'console.get_raw_transaction_content',
                correlationId: `raw_content_stream_${Date.now()}`,
                timestamp: Date.now(),
                source: 'webview',
                target: 'extension',
                payload: {
                    executionIds: needsContent
                }
            });
        }
    }
}

// Export for use in report.html
/** GitHub Issue #292: tab width (px) below which Raw panes stack vertically. */
RawTabHandler.PANE_STACK_BREAKPOINT = 640;

/** Issue #306: view key of the Raw list's filter bar. */
RawTabHandler.LIST_KEY = 'list';

/** #428: the Status filter's "Test failed" choice (errors decided by the endpoint's test). */
RawTabHandler.TEST_FAILED_FILTER = 'test-failed';

/** Issue #296: view key of the transaction modal's card. */
RawTabHandler.MODAL_KEY = 'm';
RawTabHandler.isModalEditorId = (id) => id.endsWith('-' + RawTabHandler.MODAL_KEY);

/** Issue #306: methods that send no request body. */
RawTabHandler.BODYLESS_METHODS = ['GET', 'HEAD', 'DELETE', 'OPTIONS'];

/** Issue #306: showRequest/showData null = auto (see showFor). */
RawTabHandler.defaultState = () => ({
    statusFilter: 'all',
    showRequest: null,
    showResponse: true,
    showData: null,
    searchTerm: '',
    allExpanded: true
});

/** Stable identity for a transaction across result updates. */
RawTabHandler.txRef = (tx) => tx?.metadata?.sourceFile || tx?.metadata?.executionId || null;

/**
 * Issue #306: blank, `{}` or `[]` is no body — nothing was sent, so there is
 * nothing to show but the request details.
 */
RawTabHandler.isEmptyBody = (content) => {
    if (content === null || content === undefined) return true;
    if (typeof content !== 'string') {
        return typeof content === 'object' && Object.keys(content).length === 0;
    }
    const trimmed = content.trim();
    if (trimmed === '') return true;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 0;
    } catch {
        return false;
    }
};

window.RawTabHandler = RawTabHandler;

// #372: what the Raw tab's markup may call (data-click); the web app's CSP refuses inline handlers.
// `data-arg` is the card's key, `data-mode` the second argument where there is one.
const rawMode = element => element.getAttribute('data-mode');
window.DbmnActions?.register({
    'raw:toggleCard': key => window.rawTabHandler.toggleCard(key),
    'raw:viewLogs': key => window.rawTabHandler.viewLogs(key),
    'raw:retryMember': key => window.rawTabHandler.retryMember(key),
    'raw:copyContent': (key, _event, element) => window.rawTabHandler.copyContent(key, rawMode(element)),
    'raw:setRequestViewMode': (key, _event, element) => window.rawTabHandler.setRequestViewMode(key, rawMode(element)),
    'raw:setResponseContentMode': (key, _event, element) => window.rawTabHandler.setResponseContentMode(key, rawMode(element)),
    'raw:setJsonlMode': (key, _event, element) => window.rawTabHandler.setJsonlMode(key, rawMode(element)),
    'raw:setViewMode': (key, _event, element) => window.rawTabHandler.setViewMode(key, rawMode(element)),
    'raw:copyLogsContent': () => window.rawTabHandler.copyLogsContent(),
    'raw:closeLogsModal': () => window.rawTabHandler.closeLogsModal()
});
