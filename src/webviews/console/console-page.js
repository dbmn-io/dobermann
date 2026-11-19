// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* The Console's page script. It was inline in console.html; it is a file so the web app's Content
 * Security Policy (#372), which refuses inline script, lets it run. What the page builder
 * (src/screens/console/console-page.ts) fills in arrives on this script's own tag. */

// The values the page builder fills in, from this script's tag (read now: currentScript is only
// set while the script first runs)
const CONSOLE_PAGE = (function (tag) {
    const read = name => (tag && tag.getAttribute('data-' + name)) || '';
    return Object.freeze({
        EXECUTION_ID: read('execution-id'),
        BATCH_ID: read('batch-id'),
        ENDPOINT_METHOD: read('endpoint-method'),
        HIDE_INPUT_TAB: read('hide-input-tab'),
        INITIAL_CONCURRENCY: read('initial-concurrency'),
        MAX_CONCURRENCY: read('max-concurrency'),
        REPORT_TYPE: read('report-type'),
        EXECUTION_STATUS: read('execution-status'),
        MAX_THREADS: read('max-threads'),
        ORGANIZATION: read('organization'),
        ENVIRONMENT_ID: read('environment-id'),
        ENDPOINT_ID: read('endpoint-id'),
        ENVIRONMENT_VARIABLES_JSON: read('environment-variables-json'),
        HTTP_STATUS_DISPLAY: read('http-status-display'),
        STATUS_DISPLAY: read('status-display')
    });
}(document.currentScript));

/** A value for a double-quoted attribute in markup built here (the markup's data-click actions). */
const consoleAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Global variables
const vscode = acquireVsCodeApi();
window.vscode = vscode; // Make vscode globally accessible for documentation-helpers.js
// Wire the editor window-controls cluster (min/max/close) so the
// console reads the same as the endpoint + environment editors.
if (window.EditorWindowControls) window.EditorWindowControls.wire(vscode);
let reportData = null;
let currentTab = null;
let tabConfigs = {};
let currentTableData = null;
let currentColumns = null;
let filteredData = null;
let visibleColumns = null;

// GitHub Issue #94: Store pagination metadata globally on window for cross-function access
window.paginationMetadata = null;

// GitHub Issue #159: Footer notification timeout for auto-dismiss
let activeNotificationTimeout = null;

/**
 * GitHub Issue #159: Show a notification in the footer area
 * Uses shared footer-notification styles from tables.css
 * @param {string} type - 'error' | 'warning' | 'info'
 * @param {string} message - The message to display
 * @param {object} options - { persistent: true } - errors always persist
 */
/**
 * GitHub Issue #225: Write dual-format clipboard (text/html + text/plain).
 * Uses copy event interception to write RAW HTML directly to clipboard — no DOM
 * serialization, so vendor CSS properties like mso-number-format survive intact.
 * This is critical for Excel to honor string-type hints and preserve leading zeros.
 *
 * Why not the async clipboard API's rich write? It requires user activation, which is lost
 * after the async backend round-trip. Why not execCommand with DOM selection?
 * Chromium's clipboard serializer re-serializes from DOM and strips unknown CSS
 * properties (including mso-number-format).
 */
function writeConsoleRichClipboard(html, plainText, formatLabel, scaleInfo) {
    let succeeded = false;

    // Dummy selection target — execCommand('copy') needs a selection to fire the copy event
    const dummy = document.createElement('textarea');
    dummy.value = plainText.substring(0, 1) || ' ';
    dummy.style.position = 'fixed';
    dummy.style.left = '-9999px';
    dummy.style.top = '0';
    document.body.appendChild(dummy);
    dummy.focus();
    dummy.select();

    const copyHandler = (e) => {
        e.preventDefault();
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', plainText);
        succeeded = true;
    };

    document.addEventListener('copy', copyHandler);
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('[console] execCommand copy threw:', err);
    }
    document.removeEventListener('copy', copyHandler);
    document.body.removeChild(dummy);

    if (succeeded) {
        showFooterNotification('info', `${formatLabel} copied to clipboard (${scaleInfo})`);
        return;
    }

    // Last resort: text only, through the one clipboard implementation (dbmn-clipboard.js)
    console.warn('[console] Rich clipboard write failed, falling back to text-only');
    window.DbmnClipboard.writeText(plainText).then(ok => {
        if (ok) showFooterNotification('info', `${formatLabel} copied to clipboard (${scaleInfo}) - text only`);
        else showFooterNotification('error', 'Failed to copy to clipboard');
    });
}

// Delegates to the shared fixed-overlay DbmnToast (no content shift).
// `options.source` preserves the Issue #250 single-slot semantics: a
// toast with a source replaces the previous one with that source, and
// clearFooterNotification(source) clears only that one.
function showFooterNotification(type, message, options = {}) {
    if (window.DbmnToast) {
        window.DbmnToast.show(type, message, {
            durationMs: options.duration,
            persistent: options.persistent,
            shake: options.shake,
            dismissible: options.dismissible,
            source: options.source
        });
        return;
    }
    vscode.postMessage({ type: type === 'error' ? 'showError' : type === 'warning' ? 'showWarning' : 'showInfo', message: message });
}

/**
 * Clear toast(s). With a filterSource, clears only the toast tagged with
 * that source (Issue #250 — won't nuke a pause/batch-state message owned
 * by someone else). With no arg, clears all current toasts.
 */
function clearFooterNotification(filterSource) {
    if (window.DbmnToast) window.DbmnToast.clear(filterSource);
}

// Expose to global scope for onclick handler
window.clearFooterNotification = clearFooterNotification;

/**
 * Issue #312: while a large batch streams in, the execution progress bar
 * shows the load — "Loading transactions" 300/5,000 — and is handed back
 * to the run when the last chunk lands (see ProgressHandler.showLoadingProgress).
 */
function showStreamingProgress(streaming) {
    if (!streaming || typeof streaming.total !== 'number') return;
    const inputLoaded = streaming.inputLoaded || 0, inputTotal = streaming.inputTotal || 0;
    if (inputLoaded < inputTotal) {
        progressHandler.showLoadingProgress(inputLoaded, inputTotal, 'input rows');
    } else {
        progressHandler.showLoadingProgress(streaming.loaded, streaming.total, 'transactions');
    }
}

// Dynamic Report Management Class - The RIGHT Way
class DynamicReportManager {
    constructor() {
        this.rawData = null;
        // O(1) lookup map: executionId → index in rawData.responses
        this._responseIndexMap = new Map();
        // Live running counts for success/error during batch execution
        this._liveSuccessCount = 0;
        this._liveErrorCount = 0;
        this._lastClassified = null; // cached full classification result; null = classify on next read
        this._renderDebounceTimer = null;
        this._renderDebounceMs = 1500; // debounce full table re-render during live updates
        this.currentClassification = 'httpStatus'; // 'httpStatus', 'custom', etc.
        this.currentTab = null;
        // One-shot auto-switch: when the first member result arrives
        // and the user is still on the default RAW/Input tab, flip
        // to Completed/Error so they see the result land. Only
        // happens once per Console; subsequent results don't keep
        // hijacking the tab if the user has moved elsewhere.
        this._autoSwitchedOnFirstResult = false;
        this.sortColumn = null;
        this.sortDirection = 'asc';

        // GitHub Issue #200: Track row/column counts for export scale limits
        this.currentRowCount = 0;
        this.currentColumnCount = 0;
        this.currentFilteredRowCount = null; // null = no filter active

        // Virtual scrolling state
        this.virtualScrollData = null;
        this.virtualScrollColumns = null;
        this.virtualScrollHandler = null;
        // Issue #287: rowHeight starts as an estimate and is replaced by the
        // measured height of rendered rows. Overscan is sized in pixels
        // (see VirtualWindow) so the buffer holds whatever the row height.
        this.rowHeight = 30;
        this.rowHeightMeasured = false;
        this.lastVirtualScrollTop = 0;

        // Issue #238: persist nested-array expansion across virtual-scroll
        // teardowns. Keyed by deterministic expandableId (rowIndex + path),
        // so when a row scrolls back into view its expanded state restores.
        this.expandedNestedIds = new Set();
        // Issue #238: registry of array data keyed by expandableId so the
        // toggle handler can lazy-render nested table HTML on demand
        // (avoids generating 1000s of hidden nested tables up front).
        this.arrayDataRegistry = new Map();
        // Issue #131: Throttling state to prevent scroll handler from overwhelming the DOM
        this.scrollRAFPending = false;
        this.lastRenderedStart = -1;
        this.lastRenderedEnd = -1;

        // Auto-scroll state for live log streaming
        this.autoScrollEnabled = true; // Auto-scroll to bottom on new logs
        this.userIsScrolling = false; // Track if user is manually scrolling
        this.logsContainer = null; // Reference to logs container element

        // GitHub Issue #166: RAW tab handler (external module)
        this.rawTabHandler = null;

        // GitHub Issue #229: Views-based settings
        // Each tab holds an activeView name and an array of ConsoleView objects.
        // Views combine root path, column selection, column order, and sort state.
        this.userSettings = {
            input: { activeView: '', views: [] },
            success: { activeView: '', views: [] },
            errors: { activeView: '', views: [] },
            filters: {}
        };
        // NEW: Navigation tracking for parent field inclusion (GitHub Issue #81)
        this.navigationHistory = {
            originalData: null,      // Store original extracted data at root level
            pathStack: [],           // Track navigation path (e.g., ['root', 'orders', 'items'])
            parentDataChain: []      // Store parent context data at each level
        };

        // FIX #110: WeakMap to track parent-child relationships without circular references
        // Maps child objects to their parent objects during nested array extraction
        this.parentChildMap = new WeakMap();

        // GitHub Issue #228: Track whether saved settings have been loaded from backend
        // Prevents switchTab from overwriting saved path/columns before they arrive
        this.settingsLoaded = false;

        // GitHub Issue #110: Initialize shared table builder utility
        this.tableBuilder = window.ConsoleTableBuilder.createConsoleTableBuilder();
    }

    // GitHub Issue #229: View-based settings helpers
    // Views combine rootPath + columns (ordered, presence = visible) + sort state.

    /**
     * Issue #248: Input tab uses pre-canned read-only views generated on
     * the fly from the endpoint's mapped variable names + the first input
     * row. Returns [Mapped Columns, All Columns] when the endpoint has
     * any template variables, else [All Columns]. Memoised on rawData
     * identity — regenerated on reload, not persisted.
     */
    getInputViews() {
        const rawDataForTab = this.rawData?.inputData || [];
        if (rawDataForTab.length === 0) return [];
        if (this._cachedInputViews && this._cachedInputViewsKey === this.rawData) {
            return this._cachedInputViews;
        }
        const sample = rawDataForTab[0];
        if (!sample || typeof sample !== 'object') {
            this._cachedInputViews = [];
            this._cachedInputViewsKey = this.rawData;
            return [];
        }
        const allKeys = Object.keys(sample);
        const allView = {
            name: 'All Columns',
            rowBasis: 'root',
            columns: allKeys.map(k => ({ id: k, source: 'current' })),
            isAutoGenerated: true,
            isReadOnly: true
        };
        const mappedNames = Array.isArray(this.rawData?.mappedVariableNames)
            ? this.rawData.mappedVariableNames : [];
        const mappedSet = new Set(mappedNames);
        const mappedKeys = allKeys.filter(k => mappedSet.has(k));
        const views = (mappedNames.length > 0 && mappedKeys.length > 0)
            ? [
                {
                    name: 'Mapped Columns',
                    rowBasis: 'root',
                    columns: mappedKeys.map(k => ({ id: k, source: 'current' })),
                    isAutoGenerated: true,
                    isReadOnly: true
                },
                allView
            ]
            : [allView];
        this._cachedInputViews = views;
        this._cachedInputViewsKey = this.rawData;
        return views;
    }

    /**
     * Issue #304: each input row's status — the status of the transaction
     * that sent it. null until the Raw summaries (row ranges) have
     * loaded, or when no transaction records which rows it sent.
     */
    getInputRowStatus() {
        const inputData = this.rawData?.inputData;
        const raw = this.rawTabHandler;
        if (!inputData || inputData.length === 0 || !raw || !window.InputRowStatus) return null;
        if (!raw.summariesLoaded) {
            raw.loadRequestContent();
            return null;
        }
        const byId = new Map();
        for (const s of raw.transactionSummaries) {
            byId.set(s.executionId, { key: s.executionId, rowStart: s.rowStart, rows: s.rows, status: s.status });
        }
        // Live results carry the current status (and the row range, for
        // transactions sent after the summaries loaded).
        for (const r of this.rawData.responses || []) {
            const id = raw.execIdFor(r);
            if (!id) continue;
            const t = byId.get(id) || { key: id };
            t.status = r.status || r.metadata?.status || t.status;
            if (r.metadata?.rowStart != null) {
                t.rowStart = r.metadata.rowStart;
                t.rows = r.metadata.rows;
            }
            byId.set(id, t);
        }
        const txs = [...byId.values()];
        if (!txs.some(t => t.rowStart != null)) return null;
        return window.InputRowStatus.rowStatuses(inputData.length, txs);
    }

    /**
     * Issue #304: the Input tab's rows — with the Result column and
     * filtered to the chosen status once statuses are known. Each row
     * keeps its transaction (non-enumerable __tx) for right-click.
     */
    getInputRecords() {
        const inputData = this.rawData?.inputData || [];
        const rowStatus = this.getInputRowStatus();
        this._inputRowStatus = rowStatus;
        this.updateInputStatusFilter(rowStatus);
        if (!rowStatus) return inputData;

        const colId = window.InputRowStatus.columnId(inputData[0]);
        const filter = this.inputStatusFilter || 'all';
        const { records, indices } = window.InputRowStatus.annotate(inputData, rowStatus.status, filter, colId);
        const raw = this.rawTabHandler;
        const txById = new Map(raw.getTransactions().map(t => [raw.execIdFor(t), t]));
        records.forEach((rec, j) => {
            const tx = txById.get(rowStatus.owner[indices[j]]);
            if (tx) Object.defineProperty(rec, '__tx', { value: tx, enumerable: false });
        });
        return records;
    }

    /** Issue #304: the Input view with the Result column first. */
    withInputStatusColumn(view) {
        const inputData = this.rawData?.inputData;
        if (!view || !this._inputRowStatus || !inputData?.length) return view;
        const colId = window.InputRowStatus.columnId(inputData[0]);
        if (view.columns.some(c => c.id === colId)) return view;
        return { ...view, columns: [{ id: colId, source: 'current' }, ...view.columns] };
    }

    /** Issue #304: show and fill the Input Result filter (counts per status). */
    updateInputStatusFilter(rowStatus) {
        const wrap = document.getElementById('input-status-filter-wrap');
        const select = document.getElementById('input-status-filter');
        if (!wrap || !select) return;
        const show = this.currentTab === 'input' && !!rowStatus;
        wrap.classList.toggle('hidden', !show);
        if (!show) return;
        const counts = window.InputRowStatus.counts(rowStatus.status);
        const current = this.inputStatusFilter || 'all';
        select.innerHTML = ['all'].concat(window.InputRowStatus.STATUSES).map(st =>
            `<option value="${st}"${st === current ? ' selected' : ''}>${window.InputRowStatus.LABELS[st]} (${counts[st].toLocaleString()})</option>`
        ).join('');
        if (!select._dbmnBound) {
            select._dbmnBound = true;
            select.addEventListener('change', () => {
                this.inputStatusFilter = select.value;
                this.extractAndRender('input');
            });
        }
    }

    /** Issue #304: statuses moved (results, summaries) — redraw Input if showing. */
    refreshInputStatuses() {
        if (this.currentTab !== 'input') return;
        clearTimeout(this._inputStatusTimer);
        // Issue #337: only if Input is still the tab on screen when it's due
        this._inputStatusTimer = setTimeout(() => {
            if (this.currentTab === 'input') this.extractAndRender('input');
        }, 300);
    }

    /**
     * Get or create the active view for a tab.
     * If no active view exists, creates a default one for 'root'.
     */
    getActiveView(tab) {
        // Issue #248: Input tab views are derived, not persisted. They
        // never flow through userSettings.
        if (tab === 'input') {
            const views = this.getInputViews();
            if (views.length === 0) return null;
            const persistedName = this.userSettings?.input?.activeView;
            const found = persistedName ? views.find(v => v.name === persistedName) : null;
            return this.withInputStatusColumn(found || views[0]);
        }
        const tabSettings = this.userSettings[tab];
        if (!tabSettings || !tabSettings.views) {
            this.userSettings[tab] = { activeView: '', views: [] };
        }
        const settings = this.userSettings[tab];

        // Issue #229: strip any legacy views that never got a rowBasis.
        // Prevents stale rootPath-only views from leaking through into the
        // render pipeline when settings load partial/out-of-order.
        const raw = (settings.views || []).filter(v => v && typeof v.rowBasis === 'string');

        // Phase 1A: strip auto-generated views whose name no longer matches
        // their rowBasis (e.g. an earlier buggy "path correction" mutated
        // rowBasis to 'root' while the name still says 'data').
        // Issue #242: the auto-generated DEFAULT view is exempt — its name
        // is intentionally fixed regardless of rowBasis.
        const clean = raw.filter(v => {
            if (v.isAutoGenerated === false) return true;  // user-named views survive
            if (v.name === 'DEFAULT') return true;          // auto-DEFAULT survives
            // For auto-generated views, name must equal rowBasis
            return v.name === v.rowBasis;
        });

        // Dedupe by name — keep the last one (most recently written).
        const byName = new Map();
        for (const v of clean) byName.set(v.name, v);
        settings.views = Array.from(byName.values());

        if (!settings.views.some(v => v.name === settings.activeView)) {
            settings.activeView = settings.views[0]?.name || '';
        }

        if (settings.views.length === 0) {
            // Issue #242 Phase C: no views — caller in extractAndRender
            // generates an auto-DEFAULT once raw data is available.
            return null;
        }
        const view = settings.views.find(v => v.name === settings.activeView);
        if (!view) {
            return settings.views[0];
        }
        return view;
    }

    /**
     * Set the active view for a tab by name.
     */
    setActiveView(tab, viewName) {
        if (!this.userSettings[tab]) {
            this.userSettings[tab] = { activeView: '', views: [] };
        }
        this.userSettings[tab].activeView = viewName;
    }

    /**
     * Find or create a view for the given row basis path on a tab.
     * Issue #229: transitional helper — the editor in 1B drives creation
     * via the Manage Views UI; this is used only by legacy callers that
     * haven't been deleted yet.
     */
    getOrCreateViewForPath(tab, rowBasis) {
        const settings = this.userSettings[tab];
        if (!settings || !settings.views) {
            this.userSettings[tab] = { activeView: '', views: [] };
        }
        const views = this.userSettings[tab].views;
        // 1. Exact match by rowBasis — preferred
        let view = views.find(v => v.rowBasis === rowBasis);
        if (view) return view;
        // Phase 1B.18: do NOT overwrite a same-named view's columns
        // with an empty auto-gen one — that destroys the user's
        // selected columns when paths collide with view names.
        // Just create a new auto-gen view with a unique name.
        let candidateName = rowBasis;
        let suffix = 2;
        const taken = new Set(views.map(v => v && v.name));
        while (taken.has(candidateName)) {
            candidateName = `${rowBasis} (${suffix++})`;
        }
        view = {
            name: candidateName,
            rowBasis: rowBasis,
            columns: [],
            isAutoGenerated: true
        };
        views.push(view);
        return view;
    }

    getCurrentPath(tab) {
        const view = this.getActiveView(tab);
        // Issue #248: belt-and-braces. getActiveView can return null for
        // tabs that have no views yet — accessing .rowBasis blew up the
        // Input tab in 0.1.4.
        return view ? (view.rowBasis || 'root') : 'root';
    }

    // Issue #248: read-only auto-views (Input tab) hide column-edit
    // affordances (no × hide button on headers, etc).
    isCurrentViewReadOnly() {
        const view = this.getActiveView(this.currentTab);
        return !!(view && view.isReadOnly);
    }

    setCurrentPath(tab, path) {
        // Switch to (or create) a view for the given path
        const view = this.getOrCreateViewForPath(tab, path);
        this.userSettings[tab].activeView = view.name;
    }

    // =====================================================
    // Issue #229 Phase 1B.3: Single-screen view editor
    // The dropdown owns view switching. The modal only edits one view.
    // =====================================================

    closeViewsModal() {
        document.getElementById('views-modal').classList.add('hidden');
        this.editorPendingView = null;
        this.editorEditingName = null;
        this._deleteArmed = false;
        clearTimeout(this._deleteArmTimer);
        this._removeAllArmed = false;
        clearTimeout(this._removeAllArmTimer);
        this.clearEditorNotification();
    }

    openViewEditor(viewName) {
        const tab = this.currentTab;
        // Issue #248: Input tab views are read-only auto-views. The UI
        // doesn't surface an Edit button, but guard anyway in case any
        // legacy path tries to open the editor here.
        if (tab === 'input') return;
        const settings = this.userSettings[tab] || { views: [] };
        let source = null;
        if (viewName) {
            source = (settings.views || []).find(v => v.name === viewName) || null;
        }
        // Deep clone so edits are pending until Save. New views get an
        // auto-unique "View{N}" name so Save works immediately even
        // if the user doesn't touch the name field.
        this.editorPendingView = source
            ? JSON.parse(JSON.stringify(source))
            : { name: this.nextAutoViewName(settings.views || []), rowBasis: 'root', columns: [], isAutoGenerated: false };
        this.editorEditingName = viewName || null;
        // Reporting reads a View by name: what it had when opened stays (see applyEditorLock)
        const use = this.viewUse(viewName);
        this.editorLock = source && use.locked ? { ids: this.collectAllIds(source.columns || []), text: use.text } : null;
        this._editorSamples = null;
        this.editorShowEmpty = false;

        // Phase 1B.10: expand/collapse state + search for the left tree.
        // Seeded so any group containing a currently-selected leaf is
        // pre-expanded — user sees their selection immediately.
        this.editorExpandedNodes = this.seedEditorExpandedSet(this.editorPendingView);
        // Issue #242 Phase A1: fresh views also get a depth-2 auto-expansion
        // applied on first render. Reset the gate so it fires once per open.
        this._editorDefaultExpansionSeeded = false;
        this.editorTreeSearch = '';
        const searchInput = document.getElementById('view-editor-tree-search');
        if (searchInput) searchInput.value = '';

        document.getElementById('views-modal').classList.remove('hidden');
        // The Name field below is the single place the name lives; the title no longer repeats it.
        document.getElementById('views-modal-title-text').textContent = viewName ? 'Edit View' : 'Create View';
        document.getElementById('view-editor-name').value = this.editorPendingView.name;
        this.clearEditorNotification();
        // Delete + Save As only make sense when editing an existing view
        document.getElementById('view-editor-delete').style.display = viewName ? '' : 'none';
        document.getElementById('view-editor-save-as').style.display = viewName ? '' : 'none';

        // Issue #229 Phase 1B.4: editing an existing view must respect
        // the saved rowBasis. The _rowBasisPinned flag is editor-only
        // (stripped on save), so set it explicitly here.
        if (viewName) this.editorPendingView._rowBasisPinned = true;

        this.autoUpdateRowBasis();
        this.updateSourcesForRowBasis();
        this.renderRowBasisSelect();
        this.renderEditorTree();
        this.renderEditorSelected();

        this.applyEditorLock();
    }

    /**
     * How Reporting uses a View: saved queries and compares read it by name, so a View either of
     * them reads is locked. It can gain columns and be reordered; its name, its row basis and
     * the columns it has stay.
     */
    viewUse(viewName) {
        const CC = window.ConsoleCompare;
        if (!viewName || this.currentTab !== 'success' || !CC) return { locked: false, text: '' };
        const queries = CC.queriesUsing(viewName), compares = CC.comparesUsing(viewName);
        const parts = [];
        if (queries) parts.push(queries === 1 ? 'a query' : `${queries} queries`);
        if (compares) parts.push(compares === 1 ? 'a compare' : `${compares} compares`);
        return { locked: parts.length > 0, text: parts.join(' and ') };
    }
    /** Is this column one a locked View had when the editor opened? */
    isEditorLocked(columnId) {
        return !!this.editorLock && this.editorLock.ids.has(columnId);
    }
    /** The editor's own controls for a locked View: said in a banner, and the ways to break it are off. */
    applyEditorLock() {
        const lock = this.editorLock;
        const why = lock ? `Used in ${lock.text}` : '';
        const banner = document.getElementById('view-editor-lock');
        if (banner) {
            banner.classList.toggle('hidden', !lock);
            document.getElementById('view-editor-lock-text').textContent = lock
                ? `${why}. You can add columns and change their order. Its name, its row basis and the columns it has now are locked.`
                : '';
            if (window.Icons && window.Icons.injectIcons) window.Icons.injectIcons(banner);
        }
        const name = document.getElementById('view-editor-name');
        name.readOnly = !!lock;
        name.title = lock ? `${why}: the name stays. Save As makes a copy with a new name.` : '';
        const basis = document.getElementById('view-editor-row-basis');
        basis.disabled = !!lock;
        basis.title = lock ? `${why}: the row basis stays` : 'Row basis — which selected array becomes the rows';
        const all = document.getElementById('view-editor-remove-all');
        all.disabled = !!lock;
        all.title = lock ? `${why}: its columns stay` : 'Clear all selected columns';
        const del = document.getElementById('view-editor-delete');
        del.disabled = !!lock;
        del.title = lock ? `${why}: it cannot be deleted` : '';
    }

    /**
     * A sample value for each column, from the first responses: the first value that is not
     * empty. A column with none is empty in the sample. Kept while the editor is open.
     */
    editorSamples() {
        if (this._editorSamples) return this._editorSamples;
        const samples = new Map();
        const visit = (obj, prefix) => {
            for (const key of Object.keys(obj)) {
                const v = obj[key];
                const id = prefix ? `${prefix}.${key}` : key;
                if (v === null || v === undefined || v === '') continue;
                if (Array.isArray(v)) {
                    const items = v.filter(item => item && typeof item === 'object').slice(0, 20);
                    if (items.length) items.forEach(item => visit(item, id));
                    else if (v.length && !samples.has(id)) samples.set(id, v);
                } else if (typeof v === 'object') {
                    visit(v, id);
                } else if (!samples.has(id)) {
                    samples.set(id, v);
                }
            }
        };
        (this.getRawDataForCurrentTab() || []).slice(0, 25).forEach(resp => { if (resp && typeof resp === 'object') visit(resp, ''); });
        this._editorSamples = samples;
        return samples;
    }
    /** The sample beside a column's name (escaped markup), or nothing. */
    editorSampleTag(columnId) {
        const samples = this.editorSamples();
        if (!samples.has(columnId)) return '';
        const v = samples.get(columnId);
        const text = Array.isArray(v) ? `[${v.length} item${v.length === 1 ? '' : 's'}]` : String(v);
        return `<span class="view-editor-sample" title="Sample: ${this.escapeHtml(text.slice(0, 300))}">${this.escapeHtml(text.slice(0, 80))}</span>`;
    }
    /** A column the picker leaves out: empty in the sample, and not in the View. */
    isEditorEmpty(node) {
        if (node.kind === 'array' || node.kind === 'object') return (node.children || []).every(child => this.isEditorEmpty(child));
        return !this.editorSamples().has(node.id) && !this.findColumnById(this.editorPendingView.columns, node.id);
    }
    countEditorEmpty(nodes) {
        let n = 0;
        for (const node of nodes || []) {
            if (node.kind === 'array' || node.kind === 'object') n += this.countEditorEmpty(node.children);
            else if (this.isEditorEmpty(node)) n++;
        }
        return n;
    }

    // Compute the next unused "View{N}" name for this tab, starting
    // at 1. Used as the default name when creating a new view so
    // Save never fails on a missing name.
    nextAutoViewName(existingViews) {
        const taken = new Set((existingViews || []).map(v => v && v.name));
        let n = 1;
        while (taken.has(`View${n}`)) n++;
        return `View${n}`;
    }

    // Phase 1B.10: walk the view's columns and return the set of
    // ancestor group ids that should be pre-expanded in the tree.
    seedEditorExpandedSet(view) {
        const set = new Set();
        if (!view || !Array.isArray(view.columns)) return set;
        const addAncestors = (id) => {
            const parts = id.split('.');
            for (let i = 1; i < parts.length; i++) {
                set.add(parts.slice(0, i).join('.'));
            }
        };
        const walk = (cols) => {
            for (const c of cols || []) {
                if (!c || !c.id) continue;
                if (c.source === 'nested') {
                    set.add(c.id);
                    if (Array.isArray(c.children)) walk(c.children);
                } else {
                    addAncestors(c.id);
                }
            }
        };
        walk(view.columns);
        return set;
    }

    toggleGroupExpand(nodeId) {
        if (!this.editorExpandedNodes) return;
        if (this.editorExpandedNodes.has(nodeId)) {
            this.editorExpandedNodes.delete(nodeId);
        } else {
            this.editorExpandedNodes.add(nodeId);
        }
        this.renderEditorTree();
    }

    onEditorTreeSearch(term) {
        this.editorTreeSearch = typeof term === 'string' ? term.trim().toLowerCase() : '';
        this.renderEditorTree();
    }

    // Two-click delete: first click arms the button (text changes to
    // "Click again to confirm"), second click within ~4s deletes.
    // VS Code webviews sandbox window.confirm so we can't use it.
    deleteViewFromEditor() {
        if (!this.editorEditingName || this.editorLock) return;
        const tab = this.currentTab;
        const settings = this.userSettings[tab];
        if (!settings) return;
        const name = this.editorEditingName;
        const btn = document.getElementById('view-editor-delete');

        if (!this._deleteArmed) {
            this._deleteArmed = true;
            const originalText = btn.textContent;
            btn.textContent = 'Click again to confirm';
            btn.style.background = 'var(--vscode-errorForeground)';
            btn.style.color = 'var(--vscode-editor-background)';
            clearTimeout(this._deleteArmTimer);
            this._deleteArmTimer = setTimeout(() => {
                this._deleteArmed = false;
                if (btn && document.getElementById('view-editor-delete') === btn) {
                    btn.textContent = originalText;
                    btn.style.background = '';
                    btn.style.color = 'var(--vscode-errorForeground)';
                }
            }, 4000);
            return;
        }

        clearTimeout(this._deleteArmTimer);
        this._deleteArmed = false;
        settings.views = (settings.views || []).filter(v => v.name !== name);
        if (settings.activeView === name) settings.activeView = '';
        if (settings.defaultView === name) settings.defaultView = undefined;
        this.closeViewsModal();
        this.extractAndRender(tab);
        this.updateRootPathSelector();
        debouncedSaveSettings();
    }

    // Issue #242 Phase A2: clear all selected columns. Arm-and-confirm
    // when more than 5 leaves are selected so a fat-finger doesn't nuke
    // a long curation session. Mirrors the deleteViewFromEditor pattern.
    removeAllFromEditor() {
        const view = this.editorPendingView;
        if (!view || this.editorLock) return;
        const leafCount = this.countLeafColumns(view.columns || []);
        if (leafCount === 0) return;
        const btn = document.getElementById('view-editor-remove-all');

        if (leafCount > 5 && !this._removeAllArmed) {
            this._removeAllArmed = true;
            const originalText = btn.textContent;
            btn.textContent = 'Click again to confirm';
            btn.style.background = 'var(--vscode-errorForeground)';
            btn.style.color = 'var(--vscode-editor-background)';
            clearTimeout(this._removeAllArmTimer);
            this._removeAllArmTimer = setTimeout(() => {
                this._removeAllArmed = false;
                if (btn && document.getElementById('view-editor-remove-all') === btn) {
                    btn.textContent = originalText;
                    btn.style.background = '';
                    btn.style.color = '';
                }
            }, 4000);
            return;
        }

        clearTimeout(this._removeAllArmTimer);
        this._removeAllArmed = false;
        if (btn) {
            btn.textContent = 'Remove All';
            btn.style.background = '';
            btn.style.color = '';
        }
        view.columns = [];
        this.autoUpdateRowBasis();
        this.updateSourcesForRowBasis();
        this.renderRowBasisSelect();
        this.renderEditorTree();
        this.renderEditorSelected();
    }

    // Issue #242 Phase B: re-order view.columns (and any nested-wrapper
    // children) to match the JSON response tree-walk order. Overrides
    // any prior drag/keyboard reorder — user explicitly clicked Sort.
    sortSelectedByTreeOrder() {
        const view = this.editorPendingView;
        if (!view) return;
        const rawDataForTab = this.getRawDataForCurrentTab();
        if (!rawDataForTab || rawDataForTab.length === 0) return;
        const tree = this.buildMergedResponseTree(rawDataForTab);
        const orderMap = new Map();
        this.buildTreeOrderMap(tree, orderMap, { i: 0 });
        view.columns = this.sortColumnsByOrderMap(view.columns || [], orderMap);
        this.renderEditorTree();
        this.renderEditorSelected();
    }

    buildTreeOrderMap(nodes, map, counter) {
        for (const n of nodes || []) {
            if (!n || !n.id) continue;
            map.set(n.id, counter.i++);
            if (n.children) this.buildTreeOrderMap(n.children, map, counter);
        }
    }

    sortColumnsByOrderMap(cols, orderMap) {
        const sorted = (cols || []).slice().sort((a, b) => {
            const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
            const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        for (const c of sorted) {
            if (c && c.children) c.children = this.sortColumnsByOrderMap(c.children, orderMap);
        }
        return sorted;
    }

    // Issue #229 Phase 1B.2: candidates = 'root' + every selected array path
    // (top-level or nested). Objects-as-rowBasis are also valid candidates
    // when the user's selection implies them.
    getCandidateRowBases(view) {
        const seen = new Set();
        const candidates = [{ path: 'root', depth: 0 }];
        const walk = (cols) => {
            for (const c of cols || []) {
                if (!c || !c.id) continue;
                if (c.source === 'nested' && (c.groupType === 'array' || c.groupType === 'object')) {
                    if (!seen.has(c.id)) {
                        seen.add(c.id);
                        candidates.push({
                            path: c.id,
                            depth: c.id.split('.').length,
                            kind: c.groupType
                        });
                    }
                    if (c.children) walk(c.children);
                }
            }
        };
        walk(view ? view.columns : []);
        return candidates;
    }

    // Pick the deepest selected ARRAY as default rowBasis; fall back to
    // 'root'. Runs after every column toggle so the default stays current.
    autoUpdateRowBasis() {
        if (!this.editorPendingView) return;
        // If user has explicitly locked a rowBasis that's still a valid
        // candidate, keep it. Otherwise fall to the deepest array, or root.
        const view = this.editorPendingView;
        const candidates = this.getCandidateRowBases(view).filter(c => c.kind === 'array' || c.path === 'root');
        const current = view.rowBasis || 'root';
        const stillValid = candidates.some(c => c.path === current);
        if (stillValid && view._rowBasisPinned) return;
        // Default: deepest array if any are selected, else root
        const arrays = candidates.filter(c => c.kind === 'array');
        if (arrays.length > 0) {
            arrays.sort((a, b) => b.depth - a.depth);
            view.rowBasis = arrays[0].path;
        } else {
            view.rowBasis = 'root';
        }
    }

    renderRowBasisSelect() {
        // Phase 1B.11: Row Basis lives in the Selected panel header.
        // Always visible; shows the single "root" option if no arrays
        // are selected yet, rather than hiding the control.
        const select = document.getElementById('view-editor-row-basis');
        if (!select) return;
        const view = this.editorPendingView;
        const candidates = this.getCandidateRowBases(view).filter(c => c.kind === 'array' || c.path === 'root');
        select.innerHTML = '';
        for (const c of candidates) {
            const opt = document.createElement('option');
            opt.value = c.path;
            opt.textContent = c.path === 'root'
                ? 'root — one row per response'
                : this.aliasEnvelopeDataPath(c.path) + '  (array)';
            if (c.path === (view.rowBasis || 'root')) opt.selected = true;
            select.appendChild(opt);
        }
    }

    onEditorRowBasisChanged() {
        if (!this.editorPendingView || this.editorLock) return;
        const select = document.getElementById('view-editor-row-basis');
        this.editorPendingView.rowBasis = select.value || 'root';
        // User touched the dropdown — pin their choice so autoUpdate
        // doesn't override it on subsequent column toggles.
        this.editorPendingView._rowBasisPinned = true;
        // Re-derive leaf sources from the new basis.
        this.updateSourcesForRowBasis();
        this.renderEditorTree();
        this.renderEditorSelected();
    }

    // Build a full-response tree shape from sample responses, then
    // render checkboxes. Each leaf's source is computed from the
    // current rowBasis relationship when checked.
    renderEditorTree() {
        const container = document.getElementById('view-editor-tree');
        container.innerHTML = '';
        const view = this.editorPendingView;
        if (!view) return;
        const rawDataForTab = this.getRawDataForCurrentTab();
        if (!rawDataForTab || rawDataForTab.length === 0) {
            container.innerHTML = '<div style="color:var(--vscode-descriptionForeground);padding:8px;">No response data yet — run the endpoint first.</div>';
            return;
        }
        const tree = this.buildMergedResponseTree(rawDataForTab);
        // Issue #242 Phase A1: for views with no columns selected yet,
        // pre-expand groups up to depth 2 so users see the structure on
        // open. Seeds once per editor session — after any user toggle the
        // gate stays set so we don't fight their collapses on re-render.
        if (!this._editorDefaultExpansionSeeded && (!view.columns || view.columns.length === 0)) {
            this.addDefaultEditorExpansion(tree, this.editorExpandedNodes, 2);
            this._editorDefaultExpansionSeeded = true;
        }
        const selectedIds = this.collectAllIds(view.columns || []);
        const empty = this.countEditorEmpty(tree);
        this.renderEditorTreeNodes(this.editorShowEmpty ? tree : this.withoutEditorEmpty(tree), container, selectedIds, 0);
        if (empty) {
            // Columns with no value in the sample are left out until asked for
            const note = document.createElement('div');
            note.className = 'view-editor-empty-note';
            const text = document.createElement('span');
            text.textContent = `${empty} empty column${empty === 1 ? '' : 's'} ${this.editorShowEmpty ? 'shown' : 'hidden'}`;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'view-editor-empty-toggle';
            toggle.id = 'view-editor-empty-toggle';
            toggle.textContent = this.editorShowEmpty ? 'Hide' : 'Show';
            toggle.addEventListener('click', () => { this.editorShowEmpty = !this.editorShowEmpty; this.renderEditorTree(); });
            note.append(text, toggle);
            container.appendChild(note);
        }
    }
    /** The picker's tree without the columns (and the groups of nothing else) that are empty in the sample. */
    withoutEditorEmpty(nodes) {
        return (nodes || []).filter(node => !this.isEditorEmpty(node))
            .map(node => (node.children ? Object.assign({}, node, { children: this.withoutEditorEmpty(node.children) }) : node));
    }

    // Issue #242 Phase A1: walk the tree adding every group id at depth
    // < maxDepth to the expansion set. Pure helper — no DOM access.
    addDefaultEditorExpansion(nodes, set, maxDepth, depth) {
        const d = depth || 0;
        if (d >= maxDepth) return;
        for (const node of nodes || []) {
            if (node && (node.kind === 'array' || node.kind === 'object')) {
                set.add(node.id);
                if (node.children) {
                    this.addDefaultEditorExpansion(node.children, set, maxDepth, d + 1);
                }
            }
        }
    }

    getRawDataForCurrentTab() {
        const tab = this.currentTab;
        if (tab === 'input') return this.rawData ? (this.rawData.inputData || []) : [];
        if (!this.rawData || !this.rawData.responses) return [];
        const classified = this._lastClassified || this.classifyResponses(this.rawData.responses);
        return classified[tab] || [];
    }

    // Walk a response JSON into nodes: { id, key, kind: 'leaf'|'object'|'array', children?, sample }
    // Phase 1B.8 — elide same-name envelope wrappers: an object whose
    // only child is a nested wrapper of the same key is collapsed so
    // the UI shows the inner shape directly. Display-only: the inner
    // node's id is untouched (e.g. `data.data`).
    buildResponseTreeForEditor(obj, prefix = '') {
        const nodes = [];
        if (!obj || typeof obj !== 'object') return nodes;
        for (const key of Object.keys(obj)) {
            const v = obj[key];
            const id = prefix ? `${prefix}.${key}` : key;
            if (v === null || v === undefined) {
                nodes.push({ id, key, kind: 'leaf', valueType: 'null' });
            } else if (Array.isArray(v)) {
                // GitHub Issue #239: An array containing only primitives is selectable
                // as a single column (renders as `[N items]`) — not an expandable group.
                // Only arrays whose first object element exists become 'array' groups
                // suitable for the rowBasis flow.
                const firstObject = v.find(item => item && typeof item === 'object');
                if (firstObject) {
                    nodes.push({
                        id, key, kind: 'array',
                        children: this.buildResponseTreeForEditor(firstObject, id)
                    });
                } else {
                    nodes.push({ id, key, kind: 'leaf', valueType: 'array' });
                }
            } else if (typeof v === 'object') {
                const childNodes = this.buildResponseTreeForEditor(v, id);
                if (
                    childNodes.length === 1 &&
                    (childNodes[0].kind === 'object' || childNodes[0].kind === 'array') &&
                    childNodes[0].key === key
                ) {
                    nodes.push(childNodes[0]);
                } else {
                    nodes.push({ id, key, kind: 'object', children: childNodes });
                }
            } else {
                nodes.push({ id, key, kind: 'leaf', valueType: typeof v });
            }
        }
        return nodes;
    }

    // Issue #270b: build the column-picker tree from a UNION of several
    // responses, not just the first. Some transactions have no detail
    // rows, so fields that only appear in later responses were unpickable
    // (the user had to hand-run a batch with a known-good record first).
    //
    // "Smart, not all": scan responses accumulating fields and stop once
    // STABLE consecutive responses add nothing new (schema converged),
    // with a hard cap of MAX_SAMPLE responses so huge result sets stay
    // cheap.
    buildMergedResponseTree(responses) {
        if (!Array.isArray(responses) || responses.length === 0) return [];
        const MAX_SAMPLE = 25;       // never scan more than this many
        const STABLE = 5;            // stop after N consecutive no-op merges
        const merged = [];
        const seenIds = new Set();
        let stable = 0;
        let scanned = 0;
        for (const resp of responses) {
            if (scanned >= MAX_SAMPLE) break;
            if (!resp || typeof resp !== 'object') continue;
            scanned++;
            const before = seenIds.size;
            // Merge logic lives in the shared (testable) table builder.
            this.tableBuilder.mergeSchemaTrees(merged, this.buildResponseTreeForEditor(resp), seenIds);
            if (seenIds.size === before) {
                if (++stable >= STABLE) break;
            } else {
                stable = 0;
            }
        }
        return merged;
    }

    collectAllIds(cols, out) {
        out = out || new Set();
        for (const c of cols || []) {
            if (!c || !c.id) continue;
            out.add(c.id);
            if (c.children) this.collectAllIds(c.children, out);
        }
        return out;
    }

    // Phase 1B.10: groups are now expand/collapse toggles (no checkbox).
    // When a search term is active, flatten the tree to just matching
    // leaves with their aliased full path so results transcend the
    // collapsed state.
    renderEditorTreeNodes(nodes, container, selectedIds, depth) {
        const view = this.editorPendingView;
        const search = (this.editorTreeSearch || '').trim();

        if (search) {
            const matches = this.collectLeafMatches(nodes, search);
            if (matches.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:10px;color:var(--vscode-descriptionForeground);font-size:12px;';
                empty.textContent = 'No columns match.';
                container.appendChild(empty);
                return;
            }
            for (const node of matches) {
                const isSelected = !!this.findColumnById(view.columns, node.id);
                const tag = this.editorSampleTag(node.id);
                const kept = this.isEditorLocked(node.id) ? ` disabled title="Used in ${this.escapeHtml(this.editorLock.text)}: this column stays"` : '';
                const aliasedPath = this.aliasEnvelopeDataPath(node.id);
                const row = document.createElement('div');
                row.className = 'column-item';
                row.innerHTML = `
                    <label class="view-editor-pick" title="${this.escapeHtml(aliasedPath)}">
                        <input type="checkbox" data-node-id="${this.escapeHtml(node.id)}" data-kind="leaf" ${isSelected ? 'checked' : ''}${kept} />
                        <span class="column-name">${this.escapeHtml(aliasedPath)}</span>
                        ${tag}
                    </label>
                `;
                container.appendChild(row);
            }
            container.querySelectorAll('input[type="checkbox"][data-node-id]').forEach(cb => {
                if (cb._bound) return;
                cb._bound = true;
                cb.addEventListener('change', () => {
                    this.toggleEditorNode(cb.dataset.nodeId, cb.dataset.kind, cb.checked);
                });
            });
            return;
        }

        // Normal tree mode — expand/collapse for groups, checkbox for leaves.
        for (const node of nodes) {
            const row = document.createElement('div');
            row.className = 'column-item';
            row.style.paddingLeft = (depth * 16) + 'px';

            const displayName = depth === 0
                ? this.aliasEnvelopeDataPath(node.id)
                : node.key;

            if (node.kind === 'array' || node.kind === 'object') {
                const kindBadge = node.kind === 'array' ? 'ARRAY' : 'OBJECT';
                const tag = '';
                const expanded = this.editorExpandedNodes && this.editorExpandedNodes.has(node.id);
                const chevron = window.Icons.icon(expanded ? 'chevron-down' : 'chevron-right');
                // Issue #242 Phase A3: tri-state "select all" checkbox
                // always visible on group rows (collapsed or expanded).
                // Cascades to every leaf under the group.
                const counts = this.getGroupLeafSelectionCounts(node);
                const cascadeCheckbox = counts.total > 0
                    ? `<input type="checkbox" data-cascade-id="${this.escapeHtml(node.id)}" title="Select all columns under ${this.escapeHtml(displayName)}" ${counts.selected === counts.total ? 'checked' : ''} />`
                    : '';
                row.innerHTML = `
                    <span style="display:inline-flex;align-items:center;gap:6px;user-select:none;">
                        ${cascadeCheckbox}
                        <span data-expand-id="${this.escapeHtml(node.id)}" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                            <span style="width:10px;text-align:center;font-size:10px;opacity:0.8;">${chevron}</span>
                            <span class="column-name">${this.escapeHtml(displayName)}</span>
                            <span class="variable-type data-type-${node.kind}">${kindBadge}</span>
                            ${tag}
                        </span>
                    </span>
                `;
                if (cascadeCheckbox) {
                    const cb = row.querySelector('input[data-cascade-id]');
                    if (cb) cb.indeterminate = counts.selected > 0 && counts.selected < counts.total;
                }
                container.appendChild(row);
                if (expanded && node.children && node.children.length > 0) {
                    this.renderEditorTreeNodes(node.children, container, selectedIds, depth + 1);
                }
            } else {
                const isSelected = !!this.findColumnById(view.columns, node.id);
                const tag = this.editorSampleTag(node.id);
                const kept = this.isEditorLocked(node.id) ? ` disabled title="Used in ${this.escapeHtml(this.editorLock.text)}: this column stays"` : '';
                row.innerHTML = `
                    <label class="view-editor-pick">
                        <input type="checkbox" data-node-id="${this.escapeHtml(node.id)}" data-kind="leaf" ${isSelected ? 'checked' : ''}${kept} />
                        <span class="column-name">${this.escapeHtml(displayName)}</span>
                        ${tag}
                    </label>
                `;
                container.appendChild(row);
            }
        }
        container.querySelectorAll('input[type="checkbox"][data-node-id]').forEach(cb => {
            if (cb._bound) return;
            cb._bound = true;
            cb.addEventListener('change', () => {
                this.toggleEditorNode(cb.dataset.nodeId, cb.dataset.kind, cb.checked);
            });
        });
        container.querySelectorAll('[data-expand-id]').forEach(el => {
            if (el._bound) return;
            el._bound = true;
            el.addEventListener('click', () => {
                this.toggleGroupExpand(el.dataset.expandId);
            });
        });
        // Issue #242 Phase A3: cascade checkboxes on group rows.
        container.querySelectorAll('input[type="checkbox"][data-cascade-id]').forEach(cb => {
            if (cb._bound) return;
            cb._bound = true;
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                this.cascadeToggleGroup(cb.dataset.cascadeId, cb.checked);
            });
        });
    }

    // Issue #242 Phase A3: collect every leaf id under a tree node
    // (non-recursive on the view's columns — operates on the JSON tree
    // sample). Returns { total, selected } for tri-state rendering.
    getGroupLeafSelectionCounts(node) {
        const view = this.editorPendingView;
        const leafIds = [];
        this.collectGroupLeafIds(node, leafIds);
        if (leafIds.length === 0) return { total: 0, selected: 0 };
        let selected = 0;
        for (const id of leafIds) {
            if (this.findColumnById(view ? view.columns : [], id)) selected++;
        }
        return { total: leafIds.length, selected };
    }

    collectGroupLeafIds(node, out) {
        if (!node) return;
        if (node.kind === 'array' || node.kind === 'object') {
            for (const child of node.children || []) {
                this.collectGroupLeafIds(child, out);
            }
        } else {
            out.push(node.id);
        }
    }

    // Cascade-select or cascade-deselect every leaf under a group.
    // Re-builds the tree to locate the node by id, then reuses the
    // single-leaf add/remove paths so source/wrapper logic stays in
    // one place.
    cascadeToggleGroup(groupId, checked) {
        const view = this.editorPendingView;
        if (!view) return;
        const rawDataForTab = this.getRawDataForCurrentTab();
        if (!rawDataForTab || rawDataForTab.length === 0) return;
        const tree = this.buildMergedResponseTree(rawDataForTab);
        const node = this.findTreeNodeById(tree, groupId);
        if (!node) return;
        const leafIds = [];
        this.collectGroupLeafIds(node, leafIds);
        if (checked) {
            for (const id of leafIds) this.addLeafToView(id);
        } else {
            for (const id of leafIds) {
                if (!this.isEditorLocked(id)) view.columns = this.removeColumnById(view.columns, id);
            }
            this.pruneEmptyWrappers();
        }
        this.autoUpdateRowBasis();
        this.updateSourcesForRowBasis();
        this.renderRowBasisSelect();
        this.renderEditorSelected();
        this.renderEditorTree();
    }

    findTreeNodeById(nodes, id) {
        for (const n of nodes || []) {
            if (!n) continue;
            if (n.id === id) return n;
            if (n.children) {
                const found = this.findTreeNodeById(n.children, id);
                if (found) return found;
            }
        }
        return null;
    }

    // Recursively collect LEAF nodes whose last-segment matches the
    // search term (case-insensitive). Ignores collapsed state.
    collectLeafMatches(nodes, term) {
        const out = [];
        const lower = term.toLowerCase();
        const walk = (list) => {
            for (const n of list || []) {
                if (n.kind === 'array' || n.kind === 'object') {
                    if (n.children && n.children.length) walk(n.children);
                } else {
                    // Issue #270b: match against the full aliased PATH, not
                    // just the leaf key, so searching `address` surfaces
                    // every leaf under data.address.* (street, town, …),
                    // not only leaves literally named "address".
                    const path = this.aliasEnvelopeDataPath(n.id) || n.id || '';
                    if (typeof path === 'string' && path.toLowerCase().includes(lower)) {
                        out.push(n);
                    }
                }
            }
        };
        walk(nodes);
        return out;
    }

    // Issue #229 Phase 1B.10: leaves only. Groups are expand/collapse
    // toggles now and never reach this path. `kind` is still accepted
    // so the call-site stays uniform, but non-leaf calls are ignored.
    toggleEditorNode(nodeId, kind, checked) {
        const view = this.editorPendingView;
        if (!view) return;
        if (kind !== 'leaf') return;
        if (checked) {
            this.addLeafToView(nodeId);
        } else {
            if (this.isEditorLocked(nodeId)) return;
            view.columns = this.removeColumnById(view.columns, nodeId);
            this.pruneEmptyWrappers();
        }
        this.autoUpdateRowBasis();
        this.updateSourcesForRowBasis();
        this.renderRowBasisSelect();
        this.renderEditorSelected();
        this.renderEditorTree();
    }

    // Issue #229 Phase 1B.2: structural wrapping. Leaves ALWAYS live
    // inside the nearest JSON-structural nested group (object/array)
    // regardless of rowBasis. Source (current vs ancestor) is derived
    // from rowBasis relationship and recomputed whenever rowBasis
    // changes — structure and semantics are orthogonal.
    // Issue #242 Phase C: optional viewArg + sampleArg let DEFAULT
    // generation reuse this path without setting editor state.
    addLeafToView(leafId, viewArg, sampleArg) {
        const view = viewArg || this.editorPendingView;
        if (this.findColumnById(view.columns, leafId)) return;

        const rowBasis = view.rowBasis || 'root';
        const source = this.deriveLeafSource(leafId, rowBasis);
        const ancestor = this.findNearestStructuralAncestor(leafId, sampleArg);
        if (ancestor) {
            const wrapper = this.ensureStructuralWrapper(ancestor, view, sampleArg);
            if (!wrapper.children) wrapper.children = [];
            if (!wrapper.children.some(c => c && c.id === leafId)) {
                wrapper.children.push({ id: leafId, source });
            }
            return;
        }
        view.columns.push({ id: leafId, source });
    }

    // Find the deepest nested object/array ancestor of leafId in the
    // response sample. Purely structural — doesn't consider rowBasis.
    findNearestStructuralAncestor(leafId, sampleArg) {
        let sample = sampleArg;
        if (!sample) {
            const rawDataForTab = this.getRawDataForCurrentTab();
            if (!rawDataForTab || rawDataForTab.length === 0) return null;
            sample = rawDataForTab[0];
        }
        const parts = leafId.split('.');
        if (parts.length < 2) return null;
        if (!sample || typeof sample !== 'object') return null;

        let cursor = sample;
        let absPath = '';
        let deepest = null;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            absPath = absPath ? absPath + '.' + seg : seg;
            if (cursor == null || typeof cursor !== 'object') break;
            const next = cursor[seg];
            if (Array.isArray(next)) {
                deepest = absPath;
                cursor = next.find(x => x && typeof x === 'object');
            } else if (next && typeof next === 'object') {
                deepest = absPath;
                cursor = next;
            } else {
                cursor = next;
            }
        }
        return deepest;
    }

    // Phase 1B.14: delegate to the shared builder helper.
    classifyStructuralKind(sample, path) {
        return this.tableBuilder.classifyStructuralKind(sample, path);
    }

    // Ensure a wrapper column exists at groupPath (creating parent
    // wrappers as needed, purely structurally). Returns the wrapper.
    // Issue #242 Phase C: viewArg + sampleArg make this callable
    // outside the editor flow (DEFAULT generation).
    ensureStructuralWrapper(groupPath, viewArg, sampleArg) {
        const view = viewArg || this.editorPendingView;
        let existing = this.findColumnById(view.columns, groupPath);
        if (existing) return existing;

        let sample = sampleArg;
        if (!sample) {
            const rawDataForTab = this.getRawDataForCurrentTab();
            if (rawDataForTab && rawDataForTab.length > 0) sample = rawDataForTab[0];
        }
        let groupType = 'object';
        if (sample) {
            // Phase 1B.14: classify based on the node's actual kind
            // at THIS step in the tree — not on the (array-spreading)
            // result of extractSingleAtPath.
            const kind = this.classifyStructuralKind(sample, groupPath);
            if (kind === 'array') groupType = 'array';
        }
        const wrapper = { id: groupPath, source: 'nested', groupType, children: [] };

        const parentGroup = this.findNearestStructuralAncestor(groupPath, sample);
        if (parentGroup) {
            const parent = this.ensureStructuralWrapper(parentGroup, view, sample);
            if (!parent.children) parent.children = [];
            parent.children.push(wrapper);
        } else {
            view.columns.push(wrapper);
        }
        return wrapper;
    }

    // Issue #242 Phase C: pick the row basis for an auto-generated
    // DEFAULT view. Walks the response tree, scores arrays-of-objects
    // by name + depth + breadth. Mirrors RootPathAnalyzerService.
    pickDefaultRowBasis(tree) {
        const PREFERRED = ['data', 'items', 'results', 'records', 'body', 'content', 'response', 'payload'];
        let bestId = null;
        let bestScore = -Infinity;
        const walk = (nodes, depth) => {
            for (const n of nodes || []) {
                if (!n) continue;
                if (n.kind === 'array') {
                    let score = 0;
                    if (PREFERRED.indexOf(n.key) !== -1) score += 10;
                    score -= depth;
                    if (n.children) score += Math.min(n.children.length, 5) * 0.5;
                    if (score > bestScore) {
                        bestScore = score;
                        bestId = n.id;
                    }
                }
                if (n.children) walk(n.children, depth + 1);
            }
        };
        walk(tree, 0);
        return bestId || 'root';
    }

    // Walk an object collecting up to `cap` leaf paths (depth-first,
    // source order). Arrays — both primitive arrays and arrays of
    // objects — are emitted as a single leaf at their own path: the
    // table renderer handles primitive arrays as `[N items]` and
    // object arrays as expand cells.
    collectLeafPaths(obj, prefix, out, cap) {
        if (out.length >= cap) return;
        if (obj === null || obj === undefined) return;
        if (typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const key of Object.keys(obj)) {
            if (out.length >= cap) return;
            const v = obj[key];
            const path = prefix + key;
            if (v === null || v === undefined) {
                out.push(path);
            } else if (Array.isArray(v) || typeof v !== 'object') {
                out.push(path);
            } else {
                this.collectLeafPaths(v, path + '.', out, cap);
            }
        }
    }

    // Issue #242 Phase C: generate the auto-DEFAULT view from the
    // first response in `rawDataForTab`. Returns a { name: 'DEFAULT',
    // rowBasis, columns, isAutoGenerated: true } view, or null when
    // there's no data to derive from.
    generateDefaultForTab(rawDataForTab) {
        if (!Array.isArray(rawDataForTab) || rawDataForTab.length === 0) return null;
        let sample = rawDataForTab[0];
        if (!sample || typeof sample !== 'object') return null;

        const tree = this.buildMergedResponseTree(rawDataForTab);
        let rowBasis = this.pickDefaultRowBasis(tree);

        // Resolve the pivot against the FIRST response that actually
        // holds data at the chosen rowBasis (issue #270b: the first
        // response may have no detail rows, so its schema/types would be
        // wrong). Fall back to root if none do.
        let pivot = sample;
        let prefix = '';
        if (rowBasis !== 'root') {
            let resolved = null;
            for (const resp of rawDataForTab) {
                if (!resp || typeof resp !== 'object') continue;
                const extracted = this.tableBuilder.extractSingleAtPath(resp, rowBasis);
                const candidate = Array.isArray(extracted)
                    ? extracted.find(x => x && typeof x === 'object')
                    : extracted;
                if (candidate && typeof candidate === 'object') {
                    resolved = { resp, candidate };
                    break;
                }
            }
            if (resolved) {
                sample = resolved.resp;
                pivot = resolved.candidate;
                prefix = rowBasis + '.';
            } else {
                rowBasis = 'root';
            }
        }

        const cap = 20;
        const leafIds = [];
        this.collectLeafPaths(pivot, prefix, leafIds, cap);

        const draft = { name: 'DEFAULT', rowBasis, columns: [], isAutoGenerated: true };
        for (const leafId of leafIds) {
            this.addLeafToView(leafId, draft, sample);
        }
        return draft;
    }

    // Derive a leaf's source from its rowBasis relationship.
    //   root basis: everything is 'current'.
    //   leaf inside rowBasis (or == rowBasis): 'current'.
    //   leaf outside: 'ancestor'.
    deriveLeafSource(leafId, rowBasis) {
        if (!rowBasis || rowBasis === 'root') return 'current';
        if (leafId === rowBasis) return 'current';
        if (leafId.startsWith(rowBasis + '.')) return 'current';
        return 'ancestor';
    }

    // Walk view.columns and recompute each leaf's source field from the
    // current rowBasis. Call whenever rowBasis changes.
    updateSourcesForRowBasis() {
        const view = this.editorPendingView;
        if (!view) return;
        const rowBasis = view.rowBasis || 'root';
        const walk = (cols) => {
            for (const c of cols || []) {
                if (!c) continue;
                if (c.source === 'nested') {
                    walk(c.children);
                } else {
                    c.source = this.deriveLeafSource(c.id, rowBasis);
                }
            }
        };
        walk(view.columns);
    }


    // Remove a wrapper at groupId and everything under it.
    removeWrapperDescendants(cols, groupId) {
        const out = [];
        for (const c of cols || []) {
            if (c && c.id === groupId) continue;
            if (c && c.children) c.children = this.removeWrapperDescendants(c.children, groupId);
            out.push(c);
        }
        return out;
    }

    // Drop any nested wrapper columns whose children list has gone empty.
    pruneEmptyWrappers() {
        const view = this.editorPendingView;
        if (!view) return;
        const prune = (cols) => {
            const out = [];
            for (const c of cols || []) {
                if (c && c.source === 'nested') {
                    c.children = prune(c.children || []);
                    if (c.children.length === 0) continue; // drop empty wrapper
                }
                out.push(c);
            }
            return out;
        };
        view.columns = prune(view.columns || []);
    }


    findColumnById(cols, id) {
        for (const c of cols || []) {
            if (c.id === id) return c;
            if (c.children) {
                const hit = this.findColumnById(c.children, id);
                if (hit) return hit;
            }
        }
        return null;
    }

    removeColumnById(cols, id) {
        const out = [];
        for (const c of cols || []) {
            if (c.id === id) continue;
            if (c.children) c.children = this.removeColumnById(c.children, id);
            out.push(c);
        }
        return out;
    }

    renderEditorSelected() {
        const container = document.getElementById('view-editor-selected');
        container.innerHTML = '';
        const view = this.editorPendingView;
        const cols = (view && view.columns) || [];
        document.getElementById('view-editor-count').textContent = String(this.countLeafColumns(cols));
        if (cols.length === 0) {
            container.innerHTML = '<div style="color:var(--vscode-descriptionForeground);padding:8px;font-size:12px;">No columns selected yet — check items on the left.</div>';
            this.editorSelectedId = null;
            return;
        }
        // Wire keyboard reorder once per editor session
        if (!container._kbdBound) {
            container._kbdBound = true;
            container.tabIndex = 0; // accept focus so keys work
            container.addEventListener('keydown', (e) => this.handleSelectedKeydown(e));
            container.addEventListener('click', (e) => {
                const row = e.target.closest('[data-col-id]');
                if (!row) return;
                // Clicking the × button should not change selection
                if (e.target.closest('button[data-remove]')) return;
                this.editorSelectedId = row.dataset.colId;
                this.renderEditorSelected();
                container.focus();
            });
        }
        this.renderSelectedColumns(cols, container, 0, '');
        this.wireEditorDragReorder(container);
        // Re-apply keyboard-selection highlight after re-render
        if (this.editorSelectedId) {
            const selRow = container.querySelector(`[data-col-id="${CSS.escape(this.editorSelectedId)}"]`);
            if (selRow) {
                selRow.style.outline = '2px solid var(--vscode-focusBorder)';
                selRow.style.outlineOffset = '-2px';
            }
        }
    }

    // Keyboard reorder: ↑/↓ = move 1 within scope; Shift+↑/↓ = move to
    // top/bottom within scope. No cross-scope moves.
    handleSelectedKeydown(e) {
        if (!this.editorSelectedId) return;
        const key = e.key;
        if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
        e.preventDefault();
        const view = this.editorPendingView;
        // Find which scope this selected id lives in
        const parentInfo = this.findColumnParent(view.columns, this.editorSelectedId, '');
        if (!parentInfo) return;
        const arr = parentInfo.array;
        const idx = arr.findIndex(c => c.id === this.editorSelectedId);
        if (idx < 0) return;
        let targetIdx;
        if (e.shiftKey) {
            targetIdx = key === 'ArrowUp' ? 0 : arr.length - 1;
        } else {
            targetIdx = key === 'ArrowUp' ? idx - 1 : idx + 1;
        }
        if (targetIdx < 0 || targetIdx >= arr.length || targetIdx === idx) return;
        const [moved] = arr.splice(idx, 1);
        arr.splice(targetIdx, 0, moved);
        this.renderEditorSelected();
    }

    // Walk view.columns recursively to find the array that directly
    // contains id and its scope (parent group id or '' for top-level).
    findColumnParent(cols, id, scope) {
        for (const c of cols || []) {
            if (c.id === id) return { array: cols, scope };
            if (c.children) {
                const hit = this.findColumnParent(c.children, id, c.id);
                if (hit) return hit;
            }
        }
        return null;
    }

    renderSelectedColumns(cols, container, depth, scope) {
        const view = this.editorPendingView;
        const activeRowBasis = view.rowBasis || 'root';
        const lastSeg = (id) => {
            const idx = id.lastIndexOf('.');
            return idx >= 0 ? id.slice(idx + 1) : id;
        };
        for (const col of cols) {
            // Phase 1B.8 — same-name envelope elision. An object wrapper
            // whose only child is a nested wrapper with the same
            // last-segment name is skipped; the child renders at this
            // depth/scope instead. Matches the left tree + console
            // adapter so the user sees one consistent shape.
            if (
                col && col.source === 'nested' && col.groupType === 'object' &&
                Array.isArray(col.children) && col.children.length === 1 &&
                col.children[0] && col.children[0].source === 'nested' &&
                lastSeg(col.children[0].id) === lastSeg(col.id)
            ) {
                this.renderSelectedColumns([col.children[0]], container, depth, scope);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'column-item';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '6px';
            row.style.padding = '4px 6px';
            row.style.paddingLeft = (6 + depth * 18) + 'px';
            row.draggable = true;
            row.dataset.colId = col.id;
            row.dataset.scope = scope; // parent-group id, empty for top-level

            const isNested = col.source === 'nested';
            const isRowBasis = isNested && col.id === activeRowBasis;
            const typeBadge = isNested
                ? `<span class="variable-type data-type-${col.groupType}">${col.groupType === 'array' ? 'ARRAY' : 'OBJECT'}</span>`
                : this.editorSampleTag(col.id);
            // A column a locked View had when it was opened stays: a lock where its x would be
            const remove = this.isEditorLocked(col.id)
                ? `<span class="view-editor-kept" title="Used in ${this.escapeHtml(this.editorLock.text)}: this column stays">${window.Icons.label('lock')}</span>`
                : `<button class="secondary-btn btn-xs view-editor-remove" data-remove="${this.escapeHtml(col.id)}" title="Remove from the View" aria-label="Remove ${this.escapeHtml(col.id)}">×</button>`;
            const rowBasisPill = isRowBasis
                ? '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);">' + window.Icons.label('star', 'row basis') + '</span>'
                : '';
            // Phase 1B.9 — tooltip shows aliased full path so
            // "data.data.gln" reads as "body.data.gln". Top-level rows
            // (scope === '') display the aliased full path so the
            // envelope wrapper reads "body" / "body.data"; deeper rows
            // stay on last-segment for readability.
            const aliasedPath = this.aliasEnvelopeDataPath(col.id);
            const leaf = col.id.lastIndexOf('.');
            const lastSegDisplay = leaf >= 0 ? col.id.slice(leaf + 1) : col.id;
            const displayName = (!scope) ? aliasedPath : lastSegDisplay;
            row.innerHTML = `
                <span style="cursor:grab;opacity:0.6;">≡</span>
                <span class="column-name" title="${this.escapeHtml(aliasedPath)}">${this.escapeHtml(displayName)}</span>
                ${typeBadge}
                ${rowBasisPill}
                ${remove}
            `;
            container.appendChild(row);
            // Recurse into nested children so users can see + reorder them
            if (isNested && Array.isArray(col.children) && col.children.length > 0) {
                this.renderSelectedColumns(col.children, container, depth + 1, col.id);
            }
        }
        container.querySelectorAll('button[data-remove]').forEach(btn => {
            if (btn._bound) return;
            btn._bound = true;
            btn.addEventListener('click', () => {
                if (this.isEditorLocked(btn.dataset.remove)) return;
                this.editorPendingView.columns = this.removeColumnById(this.editorPendingView.columns, btn.dataset.remove);
                this.pruneEmptyWrappers();
                this.autoUpdateRowBasis();
                this.renderRowBasisSelect();
                this.renderEditorSelected();
                this.renderEditorTree();
            });
        });
    }

    // Scope-local drag-reorder: a row can only swap with siblings that
    // share the same data-scope. Attempts to drop across scopes are
    // ignored (no cross-parent drags).
    wireEditorDragReorder(container) {
        let dragId = null;
        let dragScope = null;
        container.querySelectorAll('[data-col-id]').forEach(row => {
            row.addEventListener('dragstart', (e) => {
                dragId = row.dataset.colId;
                dragScope = row.dataset.scope || '';
                e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragover', (e) => {
                if ((row.dataset.scope || '') !== (dragScope || '')) return; // different scope
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            row.addEventListener('drop', (e) => {
                if ((row.dataset.scope || '') !== (dragScope || '')) return;
                e.preventDefault();
                const targetId = row.dataset.colId;
                if (!dragId || dragId === targetId) return;
                const arr = this.getColumnsArrayForScope(dragScope);
                if (!arr) return;
                const fromIdx = arr.findIndex(c => c.id === dragId);
                const toIdx = arr.findIndex(c => c.id === targetId);
                if (fromIdx < 0 || toIdx < 0) return;
                const [moved] = arr.splice(fromIdx, 1);
                arr.splice(toIdx, 0, moved);
                dragId = null;
                dragScope = null;
                this.renderEditorSelected();
            });
        });
    }

    // Return the columns[] array that holds children at the given scope.
    // scope === '' means the top-level view.columns. Otherwise it's the
    // id of the parent wrapper; walk the tree to find its children[].
    getColumnsArrayForScope(scope) {
        const view = this.editorPendingView;
        if (!view) return null;
        if (!scope) return view.columns;
        const wrapper = this.findColumnById(view.columns, scope);
        if (!wrapper) return null;
        if (!Array.isArray(wrapper.children)) wrapper.children = [];
        return wrapper.children;
    }

    countLeafColumns(cols) {
        let n = 0;
        for (const c of cols || []) {
            if (c.source === 'nested') n += this.countLeafColumns(c.children || []);
            else n += 1;
        }
        return n;
    }

    saveViewFromEditor() {
        const tab = this.currentTab;
        if (!this.editorPendingView) return;
        // A locked View keeps its name, whatever the field says (Save As had opened it for a copy)
        const name = this.editorLock ? this.editorEditingName : (document.getElementById('view-editor-name').value || '').trim();
        if (!name) {
            this.showEditorNotification('View name is required.', 'error', { shake: true });
            const nameInput = document.getElementById('view-editor-name');
            if (nameInput) nameInput.focus();
            return;
        }
        const settings = this.userSettings[tab] || { views: [], activeView: '' };
        this.userSettings[tab] = settings;
        const existingIdx = (settings.views || []).findIndex(v => v.name === name);
        // If renaming, existingIdx points to different view — name conflict
        if (existingIdx >= 0 && name !== this.editorEditingName) {
            this.showEditorNotification(`A view named "${name}" already exists on this tab.`, 'error', { shake: true });
            return;
        }
        const rowBasisSelect = document.getElementById('view-editor-row-basis');
        // The select may be hidden when there are no array candidates
        const rowBasis = (rowBasisSelect && rowBasisSelect.value) || this.editorPendingView.rowBasis || 'root';
        const was = (settings.views || []).find(v => v.name === this.editorEditingName);
        const viewToSave = {
            name,
            rowBasis,
            columns: this.editorPendingView.columns || [],
            // The widths set on the table's headings are the View's too
            ...(was && was.columnWidths ? { columnWidths: was.columnWidths } : {}),
            // Editor-authored views are explicit, not auto-generated
            isAutoGenerated: false
        };
        if (this.editorEditingName && this.editorEditingName !== name) {
            // Rename: drop the old entry first
            settings.views = settings.views.filter(v => v.name !== this.editorEditingName);
            if (settings.activeView === this.editorEditingName) settings.activeView = name;
            if (settings.defaultView === this.editorEditingName) settings.defaultView = name;
        }
        const idx = settings.views.findIndex(v => v.name === name);
        if (idx >= 0) settings.views[idx] = viewToSave;
        else settings.views.push(viewToSave);
        settings.activeView = name;
        // Phase 1B.10: last-saved view IS the default. No explicit
        // checkbox — saving a view promotes it to default for the tab,
        // so reopening the console lands on the freshest working view.
        settings.defaultView = name;
        this.extractAndRender(tab);
        this.updateRootPathSelector();
        this.closeViewsModal();
        debouncedSaveSettings();
    }

    saveViewAsNewFromEditor() {
        const tab = this.currentTab;
        if (!this.editorPendingView) return;
        const name = (document.getElementById('view-editor-name').value || '').trim();
        const settings = this.userSettings[tab] || { views: [], activeView: '' };
        this.userSettings[tab] = settings;
        // If the editor's name is empty or still matches an existing view
        // (including the one being edited), the user must enter a new name
        // before we save a copy. Focus + select the field as the in-place prompt.
        const collides = !name || (settings.views || []).some(v => v.name === name);
        if (collides) {
            const nameInput = document.getElementById('view-editor-name');
            if (nameInput) {
                // The copy is a new View: its name is its own, even when this one's is locked
                nameInput.readOnly = false;
                nameInput.focus();
                nameInput.select();
            }
            this.showEditorNotification('Enter a new name to save as a copy.', 'warning', { shake: true });
            return;
        }
        const rowBasisSelect = document.getElementById('view-editor-row-basis');
        const rowBasis = (rowBasisSelect && rowBasisSelect.value) || this.editorPendingView.rowBasis || 'root';
        const viewToSave = {
            name,
            rowBasis,
            columns: this.editorPendingView.columns || [],
            isAutoGenerated: false
        };
        settings.views = settings.views || [];
        settings.views.push(viewToSave);
        settings.activeView = name;
        settings.defaultView = name;
        this.extractAndRender(tab);
        this.updateRootPathSelector();
        this.closeViewsModal();
        debouncedSaveSettings();
    }

    escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Issue #229 Phase 1B.5: inline footer-notification inside the view
    // editor. Mirrors the standard pattern used by endpoint/environment
    // webviews (CSS in shared/tables.css) — notification sits to the
    // right of the action buttons, auto-dismisses for info/warning,
    // stays for error unless dismissed.
    showEditorNotification(message, type = 'info', opts = {}) {
        const container = document.getElementById('view-editor-notification');
        if (!container) return;
        if (this._editorNotifTimer) {
            clearTimeout(this._editorNotifTimer);
            this._editorNotifTimer = null;
        }
        const iconEl = container.querySelector('.notification-icon');
        const messageEl = container.querySelector('.notification-message');
        const dismissEl = container.querySelector('.notification-dismiss');
        container.className = `footer-notification notification-${type}`;
        if (iconEl) window.Icons.setIcon(iconEl, type === 'error' ? 'circle-x' : type === 'warning' ? 'triangle-alert' : 'info');
        if (messageEl) messageEl.textContent = message;
        if (dismissEl && !dismissEl._bound) {
            dismissEl._bound = true;
            dismissEl.addEventListener('click', () => this.clearEditorNotification());
        }
        container.classList.remove('hidden');
        if (opts && opts.shake) {
            container.classList.add('notification-shake');
            setTimeout(() => container.classList.remove('notification-shake'), 500);
        }
        if (type !== 'error' && !(opts && opts.persist)) {
            this._editorNotifTimer = setTimeout(() => this.clearEditorNotification(), 5000);
        }
    }

    clearEditorNotification() {
        const container = document.getElementById('view-editor-notification');
        if (container) {
            container.classList.add('hidden');
            container.classList.remove('notification-shake');
        }
        if (this._editorNotifTimer) {
            clearTimeout(this._editorNotifTimer);
            this._editorNotifTimer = null;
        }
    }

    /**
     * Get visible columns as a { columnId: boolean } map for backward compatibility.
     * Derives from the active view's columns array.
     * When a view has explicit columns, the map has _isExplicit=true.
     * Callers should treat missing entries as false when _isExplicit is set.
     */
    getVisibleColumns(tab, path = null) {
        // Issue #229 Phase 1B.7 bugfix: look up the ACTIVE view by name,
        // not by rowBasis. Two user views can share the same rowBasis
        // (e.g. auto-generated "data.data" + a user-made ViewTest) and
        // `.find(v => v.rowBasis === path)` returned the wrong one,
        // which meant visible-column checks used the other view's
        // column set and hid anything this view actually had.
        const settings = this.userSettings[tab];
        const view = settings && Array.isArray(settings.views)
            ? settings.views.find(v => v.name === settings.activeView)
            : null;
        if (!view || !view.columns || view.columns.length === 0) {
            return {}; // Empty = show all (default behavior)
        }
        // Build visibility map recursively so nested leaves inside
        // wrappers (Phase 1B.2) are also treated as visible by the
        // legacy isColumnVisible / getColumnsInVisualOrder path.
        const map = {};
        const walk = (cols) => {
            for (const c of cols || []) {
                if (!c || !c.id) continue;
                map[c.id] = true;
                if (c.children) walk(c.children);
            }
        };
        walk(view.columns);
        map._isExplicit = true;
        return map;
    }

    /**
     * Set visible columns from a { columnId: boolean } map.
     * Converts into the active view's columns array format.
     */
    setVisibleColumns(tab, path, visibleColumns) {
        const view = this.getOrCreateViewForPath(tab, path);
        // Merge with existing column order: keep ordered columns that are still visible,
        // append newly-visible columns at the end.
        const existingOrder = (view.columns || []).map(c => c.id);
        const newVisible = Object.entries(visibleColumns)
            .filter(([key, v]) => v !== false && key !== '_isExplicit')
            .map(([id]) => id);
        const newVisibleSet = new Set(newVisible);

        // Keep existing ordered columns that are still visible
        const ordered = existingOrder.filter(id => newVisibleSet.has(id));
        // Add newly visible columns not already in order
        const orderedSet = new Set(ordered);
        newVisible.forEach(id => {
            if (!orderedSet.has(id)) {
                ordered.push(id);
            }
        });

        view.columns = ordered.map(id => ({ id, source: 'current' }));
        this.userSettings[tab].activeView = view.name;
    }

    /**
     * Get ordered column IDs from the active view (recursive, leaves only).
     * Wrappers that collapse at render time are walked into; leaves
     * emerge in the order they appear in the tree.
     */
    getColumnOrder(tab) {
        const view = this.getActiveView(tab);
        if (!view.columns || view.columns.length === 0) return [];
        const out = [];
        const walk = (cols) => {
            for (const c of cols || []) {
                if (!c || !c.id) continue;
                if (c.source === 'nested') {
                    // Emit the wrapper id too so below-basis nested
                    // (which renders as a single leaf cell) sorts here.
                    out.push(c.id);
                    if (c.children) walk(c.children);
                } else {
                    out.push(c.id);
                }
            }
        };
        walk(view.columns);
        return out;
    }

    /**
     * Set column order on the active view from an array of column IDs.
     */
    setColumnOrder(tab, orderedIds) {
        const view = this.getActiveView(tab);
        view.columns = orderedIds.map(id => {
            // Preserve existing column metadata if present
            const existing = (view.columns || []).find(c => c.id === id);
            return existing || { id, source: 'current' };
        });
    }

    initialize(rawData) {
        // Preserve existing logs if they were streamed/loaded before refresh
        const existingLogs = this.rawData?.logContent;
        if (existingLogs && existingLogs.length > 0 && (!rawData.logContent || rawData.logContent.length === 0)) {
            rawData.logContent = existingLogs;
        }

        this.rawData = rawData;
        // Reset live counters
        this._liveSuccessCount = 0;
        this._liveErrorCount = 0;
        this._lastClassified = null;
        // The position map and the tallies are rebuilt together, below, by
        // ConsoleLiveCounts.seed — see applyLiveCounts().
        this._responseIndexMap.clear();

        // Compare backend vs frontend path discovery
        if (rawData?.responses && rawData.responses.length > 0) {
            const frontendPaths = discoverDataPaths(rawData.responses[0]);
        }

        // REMOVED: Early return that blocked tab creation for PREPARING/RUNNING executions
        // Tabs should always be created - empty state handled per-tab, not for entire report

        // Make sure the toolbar is visible
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.classList.remove('hidden');
        } else {
        }

        // Classify responses, and seed the live tallies + position map from the same
        // rows (reopen state recovery). One call, so they cannot disagree.
        const seeded = ConsoleLiveCounts.seed(rawData.responses, (rows) => this.classifyResponses(rows));
        this.applyLiveCounts(seeded);
        const classified = seeded.classified;

        // Create tabs based on available data
        this.createDynamicTabs(classified, rawData);

        // GitHub Issue #102: Initialize diagnostic stats for batch reports
        this.initializeDiagnosticStats(rawData);

        // Switch to first available tab
        const firstTab = Object.keys(classified).find(key => classified[key].length > 0);

        if (firstTab) {
            this.switchTab(firstTab);
        } else if (rawData.inputData !== undefined) {
            // If no responses yet, but has input data (batch preparing), switch to Input tab
            this.switchTab('input');
        } else {
            // Otherwise default to RAW tab (for PREPARING/RUNNING executions)
            // GitHub Issue #166: Changed from 'logs' to 'raw' since Logs tab is now hidden
            this.switchTab('raw');
        }
    }

    /**
     * GitHub Issue #102: Initialize diagnostic stats for batch reports
     * Shows Expected/Database/Live transaction counts to diagnose overcounting
     */
    initializeDiagnosticStats(rawData) {
        // GitHub Issue #102: Simple transaction count stat showing "actual/planned"
        const statElement = document.getElementById('transaction-count-stat');
        const valueElement = document.getElementById('transaction-count-value');

        if (!statElement || !valueElement) return;

        // Only show for batch reports with metadata
        const hasBatchId = rawData?.metadata?.batchId !== undefined;
        const hasPlanData = rawData?.metadata?.rows !== undefined;

        if (!hasBatchId || !hasPlanData) {
            statElement.classList.add('hidden');
            return;
        }

        // Show the stat element
        statElement.classList.remove('hidden');

        // Parse planned count from metadata.rows (format: "77(308)" → 77)
        const plannedCount = this.parseExpectedTransactionCount(rawData.metadata.rows);
        if (!plannedCount) {
            statElement.classList.add('hidden');
            return;
        }

        // Store planned count for updates
        this.plannedCount = plannedCount;

        // Set initial actual count from responses (will update from database query)
        const actualCount = rawData?.metadata?.totalRows || 0;
        valueElement.textContent = `${actualCount}/${plannedCount}`;

        // Request database count for more accurate actual count
        this.requestDatabaseCount(rawData.metadata.batchId);
    }

    /**
     * Parse expected transaction count from batch rows field
     * Format: "120(1234)" → 120 expected transactions, 1234 CSV rows
     * Returns: 120
     */
    parseExpectedTransactionCount(rowsField) {
        if (!rowsField || typeof rowsField !== 'string') {
            return null;
        }

        // Match pattern: "120(1234)" → extract 120
        const match = rowsField.match(/^(\d+)\(/);
        if (match && match[1]) {
            return parseInt(match[1], 10);
        }

        // Fallback: if no parentheses, might just be a number
        const simpleNumber = parseInt(rowsField, 10);
        if (!isNaN(simpleNumber)) {
            return simpleNumber;
        }

        return null;
    }

    /**
     * Request database count from backend for batch members
     */
    requestDatabaseCount(batchId) {
        if (!batchId) return;

        vscode.postMessage({
            type: 'console.request_database_count',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: { batchId }
        });
    }

    /**
     * Update transaction count display (GitHub Issue #102)
     * Shows "actual/planned" format (e.g., "35/77")
     */
    updateTransactionCount(actualCount) {
        const valueElement = document.getElementById('transaction-count-value');
        if (!valueElement || !this.plannedCount) return;

        valueElement.textContent = `${actualCount}/${this.plannedCount}`;
    }

    classifyResponses(responses) {
        // GitHub Issue #110: Delegate to shared table builder utility
        const classified = this.tableBuilder.classifyResponses(responses);

        // Add input data if available
        if (this.rawData.inputData && this.rawData.inputData.length > 0) {
            classified.input = this.rawData.inputData;
        }

        return classified;
    }

    /**
     * Narrow panel: compact the tab strip only when the full labels
     * overflow it (tabs.css .is-compact). Measured with labels shown,
     * so it re-expands as soon as there is room again.
     */
    fitReportTabs() {
        const bar = document.getElementById('report-tabs');
        if (!bar) return;
        bar.classList.remove('is-compact');
        if (bar.scrollWidth > bar.clientWidth) bar.classList.add('is-compact');
    }

    watchReportTabsFit() {
        const bar = document.getElementById('report-tabs');
        if (!bar || this._tabsFitWatched) return;
        this._tabsFitWatched = true;
        let queued = false;
        const schedule = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; this.fitReportTabs(); });
        };
        new ResizeObserver(schedule).observe(bar);
        // Tabs added/shown, counts growing, the active tab changing. The
        // bar's own class (set by fitReportTabs) is ignored, or it loops.
        new MutationObserver((records) => {
            if (records.some(r => r.target !== bar || r.type !== 'attributes')) schedule();
        }).observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
    }

    createDynamicTabs(classified, rawData) {
        const tabsContainer = document.getElementById('report-tabs');
        this.watchReportTabsFit();
        tabsContainer.innerHTML = '';

        // GitHub Issue #247: Links tab, in front of Input (console-chain.js)
        if (window.ConsoleChain) window.ConsoleChain.decorateTabs(tabsContainer, (t) => this.switchTab(t));

        // Create tabs in specified order: Input → Success → Errors → RAW → Settings
        // GitHub Issue #166: Request and Logs tabs hidden - RAW tab now provides this functionality
        // To re-enable, set window.showLegacyTabs = true before report loads

        // GitHub Issue #101: Request tab (hidden - RAW tab shows request/response for all transactions)
        if (window.showLegacyTabs) {
            const requestTab = document.createElement('div');
            requestTab.className = 'tab-item';
            requestTab.dataset.tab = 'request';
            requestTab.innerHTML = `
                <span class="tab-label">Request</span>
            `;
            requestTab.onclick = () => this.switchTab('request');
            tabsContainer.appendChild(requestTab);
        }

        // Logs tab (hidden - RAW tab has View Logs per transaction)
        if (window.showLegacyTabs) {
            const logsTab = document.createElement('div');
            logsTab.className = 'tab-item';
            logsTab.dataset.tab = 'logs';
            logsTab.innerHTML = `
                <span class="tab-label">Logs<span class="red-pulse ml-8 hidden" id="logs-tab-indicator">●</span></span>
            `;
            logsTab.onclick = () => this.switchTab('logs');
            tabsContainer.appendChild(logsTab);
        }

        // Input tab - always show if inputData exists (even during preparation before execution)
        // GitHub Issue #151: Hide Input tab for child batches (reprocessed from another batch - no CSV)
        if (rawData.inputData !== undefined && !window.hideInputTab) {
            const inputTab = document.createElement('div');
            inputTab.className = 'tab-item';
            inputTab.dataset.tab = 'input';
            inputTab.title = 'Input';
            const inputCount = classified.input?.length || 0;
            inputTab.innerHTML = `
                <span class="tab-label">Input</span>
                <span class="tab-count" data-tab="input">${inputCount}</span>
            `;
            inputTab.onclick = () => this.switchTab('input');
            tabsContainer.appendChild(inputTab);
        }

        // Detect if this is a batch report with results (RUNNING state)
        const isBatchReport = rawData.metadata?.batchId !== undefined;
        const hasResults = rawData.responses && rawData.responses.length > 0;

        // GitHub Issue #166/#184: RAW tab (after Input, before Completed/Error)
        // Shows raw request/response JSON for all transactions
        if (isBatchReport || (rawData.responses && rawData.responses.length > 0)) {
            const rawTab = document.createElement('div');
            rawTab.className = 'tab-item';
            rawTab.dataset.tab = 'raw';
            rawTab.title = 'Raw';
            const rawCount = rawData.responses ? rawData.responses.length : 0;
            rawTab.innerHTML = `<span class="tab-label">Raw</span><span class="tab-count" data-tab="raw">${rawCount}</span>`;
            rawTab.onclick = () => this.switchTab('raw');
            tabsContainer.appendChild(rawTab);
        }

        // Create tabs for Completed and Error
        // For batch reports during RUNNING: show Completed tab (even with count=0) to receive streaming updates
        //   Error tab is created hidden and revealed when errors actually arrive
        // For batch reports during PREPARING: don't show tabs yet (no execution started)
        // For individual reports: only show if they have data
        const tabLabels = { success: 'Completed', errors: 'Error' };
        const orderedCategories = ['success', 'errors'];
        orderedCategories.forEach(category => {
            const items = classified[category];
            const count = items?.length || 0;

            // Show tab if: has data OR is batch with results (RUNNING, not PREPARING)
            if ((items && items.length > 0) || (isBatchReport && hasResults)) {
                const tab = document.createElement('div');
                tab.className = 'tab-item';
                tab.dataset.tab = category;
                tab.title = tabLabels[category];

                const label = tabLabels[category];
                tab.innerHTML = `
                    <span class="tab-label">${label}</span>
                    <span class="tab-count" data-tab="${category}">${count}</span>
                `;
                tab.onclick = () => this.switchTab(category);

                // Hide errors tab until errors actually arrive
                if (category === 'errors' && count === 0) {
                    tab.style.display = 'none';
                }

                tabsContainer.appendChild(tab);
            }
        });

        // GitHub Issue #156: Info tab (always shown, last/rightmost tab)
        const infoTab = document.createElement('div');
        infoTab.className = 'tab-item';
        infoTab.dataset.tab = 'info';
        infoTab.title = 'Settings';
        infoTab.innerHTML = `<span class="tab-label">Settings</span>`;
        infoTab.onclick = () => this.switchTab('info');
        tabsContainer.appendChild(infoTab);

        // Initialize Info tab for batch vs individual
        initInfoTab(isBatchReport);
    }


    switchTab(tabName) {
        // Clear any pending debounced render from the previous tab
        if (this._renderDebounceTimer) {
            clearTimeout(this._renderDebounceTimer);
            this._renderDebounceTimer = null;
        }
        // Issue #337: and a pending Input redraw (input rows still streaming in)
        clearTimeout(this._inputStatusTimer);

        // Update active tab styling
        document.querySelectorAll('.tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        this.currentTab = tabName;

        // GitHub Issue #247: the Links tab is console-chain.js's; it also shows Chain on Completed
        if (window.ConsoleChain && window.ConsoleChain.onSwitchTab(tabName)) return;

        // Manage export button visibility based on tab
        const exportMenu = document.querySelector('.export-menu');
        const excelBtn = document.querySelector('.export-option[data-format="excel"]');
        const toolbar = document.getElementById('report-toolbar');
        const tableContainer = document.getElementById('table-container');
        const infoTabContent = document.getElementById('info-tab-content');

        // GitHub Issue #156: Handle Info tab
        if (tabName === 'info') {
            if (toolbar) toolbar.style.display = 'none';
            if (tableContainer) tableContainer.classList.add('hidden');
            if (infoTabContent) infoTabContent.classList.remove('hidden');
            document.getElementById('empty-state')?.classList.add('hidden');
            return;
        }

        // Hide Info tab content when switching to other tabs
        if (infoTabContent) infoTabContent.classList.add('hidden');
        if (toolbar) toolbar.style.display = 'flex';
        if (tableContainer) tableContainer.classList.remove('hidden');

        // Hide export entirely for Request/Logs/RAW tabs (non-tabular data)
        if (tabName === 'request' || tabName === 'logs' || tabName === 'raw') {
            if (exportMenu) exportMenu.style.display = 'none';
        }
        // Every table tab exports CSV and Excel. Excel from the Input tab keeps its
        // Result filter on the Input sheet (Issue #304: Error → Excel is the list of
        // rows to send back; Puppy School Lesson 3 Step 12).
        else {
            if (exportMenu) exportMenu.style.display = 'block';
            if (excelBtn) excelBtn.style.display = 'block';
        }

        // GitHub Issue #166: Clean up ALL tab content before rendering special tabs
        // This ensures no leftover content from previous tabs
        if (tabName === 'request' || tabName === 'logs' || tabName === 'raw') {
            this.cleanupAllTabContent();
        }

        // NEW: Handle Request and Logs tabs differently (like TabbedReportManager does)
        if (tabName === 'request') {
            this.renderRequestTab();
            return;
        }
        if (tabName === 'logs') {
            this.renderLogsTab();
            return;
        }
        // GitHub Issue #166: Handle RAW tab (using external module)
        if (tabName === 'raw') {
            if (this.rawTabHandler) {
                this.rawTabHandler.render();
            }
            return;
        }

        // When switching to data tabs from logs, restore table structure
        this.restoreTableStructure();

        // Issue #304: the Result filter belongs to the Input tab
        if (tabName !== 'input') {
            document.getElementById('input-status-filter-wrap')?.classList.add('hidden');
        }

        // Issue #248: Input tab now shows the View dropdown too — read-only
        // pre-canned views (Mapped Columns / All Columns), no editor.
        const rootSelector = document.querySelector('.view-selector');
        if (rootSelector) rootSelector.style.display = 'block';
        if (tabName === 'input') {
            this.updateRootPathSelector();
            this.extractAndRender(tabName);
            return;
        }

        // Phase 1B.18: views own rowBasis. Don't smart-default an
        // override here — it can match-by-name an existing view and
        // overwrite its columns. Just refresh the dropdown and let
        // extractAndRender use the active view's rowBasis as-is.
        this.updateRootPathSelector();
        this.extractAndRender(tabName);
    }

    findRecommendedPath(tabName) {
        // Use dynamic path discovery instead of backend paths
        const discoveredPaths = this.getDiscoveredPaths();
        if (!discoveredPaths || discoveredPaths.length === 0) return null;

        // Get the raw data for this tab to validate paths against
        let rawDataForTab;
        if (tabName === 'input') {
            rawDataForTab = this.rawData.inputData || [];
        } else {
            const classified = this.classifyResponses(this.rawData.responses);
            rawDataForTab = classified[tabName] || [];
        }

        if (rawDataForTab.length === 0) return null;

        // For success/error tabs, look for 'data' path, but validate it exists
        if (tabName === 'success' || tabName === 'errors') {
            const dataPath = discoveredPaths.find(p => p.path === 'data');
            if (dataPath) {
                // Test if the path actually extracts data
                const extracted = this.extractAtPath(rawDataForTab, 'data');
                if (extracted && extracted.length > 0) {
                    return 'data';
                }
            }
        }
        
        // Otherwise look for any recommended path that actually contains data
        for (const pathInfo of discoveredPaths) {
            if (pathInfo.recommended && pathInfo.path !== 'root') {
                const extracted = this.extractAtPath(rawDataForTab, pathInfo.path);
                if (extracted && extracted.length > 0) {
                    return pathInfo.path;
                }
            }
        }
        
        return null; // Fall back to 'root' if no valid path found
    }

    isValidRootPath(tabName, rootPath) {
        if (!rootPath || rootPath === 'root') return true; // 'root' is always valid

        // Get the raw data for this tab to validate path against
        let rawDataForTab;
        if (tabName === 'input') {
            rawDataForTab = this.rawData.inputData || [];
        } else {
            const classified = this.classifyResponses(this.rawData.responses);
            rawDataForTab = classified[tabName] || [];
        }

        if (rawDataForTab.length === 0) return false;

        // FIX issue#100: Don't extract ALL data just to validate path exists!
        // Just check if the path exists in the FIRST item
        if (rawDataForTab.length > 0) {
            const testResult = this.extractSingleAtPath(rawDataForTab[0], rootPath);
            return testResult !== null && testResult !== undefined;
        }

        return false;
    }



    /**
     * Issue #229: Convert a view's recursive column tree into the flat
     * { id, name, type, children: string[] } shape that renderTable and
     * renderHierarchicalHeaders expect. Avoids rewriting every legacy
     * renderer in Phase 1A.
     *
     * - source: 'nested' columns become groups (type: 'group') with
     *   children = IDs of their children; the children are appended to
     *   the flat array too (recursively).
     * - source: 'current' | 'ancestor' become leaf columns; ancestors
     *   are marked with isAncestor so the renderer can apply
     *   .col-ancestor styling.
     */
    viewToLegacyColumnShape(view, sampleResponse) {
        // Delegates to the shared builder so unit tests cover the
        // same adapter the console renders through. Passes a sample
        // response when available so the adapter can distinguish
        // genuine expand-cell arrays from object wrappers that were
        // mis-tagged 'array' by older view builders.
        return this.tableBuilder.viewToLegacyColumnShape(view, sampleResponse);
    }

    // Phase 1B.9 — display-only alias for the envelope `data` wrapper.
    // Paths like `data.data.gln` render as `body.data.gln` throughout
    // the UI; internal ids, storage, and saved views stay on `data.*`.
    aliasEnvelopeDataPath(path) {
        return this.tableBuilder.aliasEnvelopeDataPath(path);
    }

    // Views dropdown description: deep paths collapse to …last.two so
    // the row stays one line regardless of depth. Full path goes in
    // the title tooltip for context.
    shortenBasisPath(path) {
        if (!path || path === 'root') return path;
        const parts = path.split('.');
        if (parts.length <= 2) return path;
        return '…' + parts.slice(-2).join('.');
    }


    extractAndRender(tabName, rowBasisOverride = null, options = {}) {
        try {
            // FIX #110: Clear WeakMap at start of extraction to prevent stale references
            this.parentChildMap = new WeakMap();

            // Phase 1B.18: only snap the active view onto a different
            // rowBasis when the override actually differs from what
            // the active view already uses. Calling setCurrentPath
            // unconditionally can find()-match a sibling view that
            // shares the same rowBasis and silently switch activeView
            // away from the user's selection.
            if (rowBasisOverride) {
                const currentBasis = this.getCurrentPath(tabName);
                if (currentBasis !== rowBasisOverride) {
                    this.setCurrentPath(tabName, rowBasisOverride);
                }
            }

            // Get the raw data for this tab
            let rawDataForTab;
            if (tabName === 'input') {
                rawDataForTab = this.getInputRecords();
            } else {
                const classified = this._lastClassified || this.classifyResponses(this.rawData.responses);
                rawDataForTab = classified[tabName] || [];
            }

            if (rawDataForTab.length === 0) {
                // Issue #304: an Input status with no rows is a filter
                // result, not missing data — keep the filter reachable.
                if (tabName === 'input' && this._inputRowStatus && this.inputStatusFilter && this.inputStatusFilter !== 'all') {
                    this.renderTable([], []);
                    this.updateStats(0, 0);
                    return;
                }
                this.showEmptyState('No data available for this tab');
                return;
            }

            // Issue #242 Phase C: resolve active view, or generate an
            // auto-DEFAULT when the tab has no views yet. The DEFAULT
            // generator picks a smart row basis from the response and
            // surfaces up to 20 columns under it. Once the user edits
            // and saves DEFAULT, isAutoGenerated flips to false (in
            // saveViewFromEditor) and no further regeneration happens.
            let view = this.getActiveView(tabName);
            if (!view) {
                // Issue #248: Input tab has its own derived views path
                // (getInputViews); never persist a DEFAULT for it.
                if (tabName === 'input') {
                    this.showEmptyState('No input data available for this tab');
                    return;
                }
                const generated = this.generateDefaultForTab(rawDataForTab);
                if (generated) {
                    const settings = this.userSettings[tabName] || { activeView: '', views: [] };
                    settings.views = [generated];
                    settings.activeView = 'DEFAULT';
                    this.userSettings[tabName] = settings;
                    view = generated;
                    // Persist through the standard save path; backend
                    // strips auto-DEFAULT from the endpoint mirror so
                    // it doesn't travel with endpoint export.
                    debouncedSaveSettings();
                } else {
                    this.showEmptyState('No data available for this tab');
                    return;
                }
            }

            // View-driven extraction. Produces flat row objects keyed by
            // absolute column id. Replaces extractAtPath + inferColumns.
            // Screen rendering never flattens nested arrays — they stay as
            // raw payloads for renderExpandableArray. Denormalisation is
            // fully owned by rowBasis; the export pipeline handles CSV/Excel
            // cartesian flatten separately.
            const rows = this.tableBuilder.extractRowsForView(rawDataForTab, view);

            // Issue #250: surface responses that produced zero rows at
            // the current rowBasis — flags missing data so it isn't
            // mistaken for an API failure.
            const effectiveRowBasis = view.rowBasis || 'root';
            const emptyResponseCount = this.tableBuilder.countResponsesWithNoRows(rawDataForTab, effectiveRowBasis);

            // GitHub Issue #228: Restore saved sort state and apply sorting
            this.restoreSortState();
            if (this.sortColumn) {
                this.sortData(rows, this.sortColumn);
            }

            const sampleResponse = rawDataForTab && rawDataForTab[0];
            let columns = this.viewToLegacyColumnShape(view, sampleResponse);
            // #428: the Error tab says why, first, whatever the view — a 200 failed by the
            // endpoint's test looks just like a Completed row otherwise
            if (tabName === 'errors' && window.ConsoleErrorReason) {
                columns = window.ConsoleErrorReason.withReasonColumn(rows, columns);
            }

            // Check if search filter is active. Phase 1B.20: route
            // through the same advanced matcher handleSearch uses
            // (`SearchMatcher.parseSearchExpression` + matchesRow) so
            // patterns like `,`-OR, `+`-AND, wildcards, negation,
            // quoted-exact survive a sort. Previously this branch ran
            // a naive String.includes which left the table blank
            // when the user's term contained any non-literal syntax.
            const searchInput = document.getElementById('search-input');
            const searchTerm = searchInput ? searchInput.value : '';

            if (searchTerm && searchTerm.trim() !== '' && window.SearchMatcher) {
                const parsedTerms = window.SearchMatcher.parseSearchExpression(searchTerm);
                const leafColumns = columns.filter(col => col.type !== 'group');
                const filteredRows = rows.filter(row => {
                    return window.SearchMatcher.matchesRow(parsedTerms, row, leafColumns,
                        (r, colId) => this.extractNestedValue(r, colId));
                });

                this.renderTable(filteredRows, columns, options);
                this.updateStats(rows.length, columns.length);
                this.updateEmptyRowBasisWarning(emptyResponseCount, rawDataForTab.length, effectiveRowBasis);
                this.updateRootPathSelector(view.rowBasis || 'root');
                this.updateSearchResults(searchTerm, rows.length, filteredRows.length);
            } else {
                this.renderTable(rows, columns, options);
                this.updateStats(rows.length, columns.length);
                this.updateEmptyRowBasisWarning(emptyResponseCount, rawDataForTab.length, effectiveRowBasis);
                this.updateRootPathSelector(view.rowBasis || 'root');
                this.updateSearchResults(searchTerm, rows.length, rows.length);
            }

        } catch (error) {
            this.showEmptyState('Error processing data: ' + error.message);
        }
    }

    extractAtPath(dataArray, path) {
        // GitHub Issue #110: Delegate to shared table builder utility
        // The shared utility handles parent tracking and denormalization internally
        return this.tableBuilder.extractAtPath(dataArray, path);
    }

    extractSingleAtPath(obj, path) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.extractSingleAtPath(obj, path);
    }

    // NEW: Denormalize data with parent field values (GitHub Issue #81)
    // FIX: GitHub Issue #110 - Delegate to shared table builder utility
    denormalizeWithParentFields(childData, originalRootItem) {
        // NOTE: The shared utility's extractAtPath already handles denormalization internally
        // This method is kept for backward compatibility but may not be actively used
        // If called directly, use the shared utility's denormalization with inferDataType
        return this.tableBuilder.denormalizeWithParentFields(childData, (value) => this.inferColumnType(value));
    }


    isColumnVisible(columnId) {
        const visibleColumns = this.getVisibleColumns(this.currentTab);
        const isExplicitView = visibleColumns._isExplicit === true;

        // Check if explicitly set in user settings
        if (visibleColumns[columnId] !== undefined) {
            return visibleColumns[columnId] !== false;
        }

        // If explicit view, columns not listed are hidden
        if (isExplicitView) return false;

        // Auto-root view: everything visible. Parent-field defaultHidden
        // semantics live in the nested-table renderer (renderDataAsTable),
        // which has local access to the column hierarchy.
        return true;
    }
    
    getVisibleChildrenCount(childrenIds) {
        const visibleChildren = childrenIds.filter(childId => this.isColumnVisible(childId));
        return visibleChildren.length;
    }
    
    analyzeObjectStructure(obj, prefix, columnMap) {
        Object.keys(obj).forEach(key => {
            const value = obj[key];
            const fullKey = prefix ? `${prefix}.${key}` : key;
            const type = this.inferColumnType(value);
            
            
            if (type === 'object' && !Array.isArray(value) && value !== null) {
                // This is a nested object - create a group and analyze its children
                if (!columnMap.has(fullKey)) {
                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: this.formatColumnName(key),
                        type: 'group',
                        sortable: false,
                        filterable: false,
                        children: []
                    });
                }
                
                // Recursively analyze nested object
                this.analyzeObjectStructure(value, fullKey, columnMap);
            } else {
                // This is a primitive value, array, or null - create a regular column
                if (!columnMap.has(fullKey)) {
                    // NEW: Detect parent fields and mark them appropriately (GitHub Issue #81)
                    const isParentField = fullKey.startsWith('parent_L');
                    let columnName = this.formatColumnName(key);
                    let parentLevel = null;
                    let originalKey = key;
                    let defaultHidden = false;

                    if (isParentField) {
                        // Extract parent level from parent_L0.fieldname format
                        const match = fullKey.match(/^parent_L(\d+)\.(.+)$/);
                        if (match) {
                            parentLevel = parseInt(match[1]);
                            originalKey = match[2];
                            columnName = `${originalKey} (L${parentLevel})`;
                            defaultHidden = true; // Parent fields hidden by default
                        }
                    }

                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: columnName,
                        type: type,
                        sortable: true,
                        filterable: true,
                        parent: prefix || null,
                        isParent: isParentField,
                        parentLevel: parentLevel,
                        originalKey: originalKey,
                        defaultHidden: defaultHidden
                    });
                }
            }
        });
    }
    
    // GitHub Issue #229: Walk complete response from root, recursing INTO arrays
    analyzeFullResponseStructure(obj, prefix, columnMap, depth = 0, maxDepth = 8) {
        if (depth > maxDepth || !obj || typeof obj !== 'object') return;
        Object.keys(obj).forEach(key => {
            const value = obj[key];
            const fullKey = prefix ? `${prefix}.${key}` : key;
            const type = this.inferColumnType(value);

            if (Array.isArray(value)) {
                // Array → collapsible group, recurse into first item(s)
                if (!columnMap.has(fullKey)) {
                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: this.formatColumnName(key),
                        type: 'group',
                        dataType: 'array',
                        children: []
                    });
                }
                const sample = Math.min(value.length, 3);
                for (let i = 0; i < sample; i++) {
                    if (typeof value[i] === 'object' && value[i] !== null) {
                        this.analyzeFullResponseStructure(value[i], fullKey, columnMap, depth + 1, maxDepth);
                    }
                }
            } else if (type === 'object' && value !== null) {
                // Object → collapsible group, recurse
                if (!columnMap.has(fullKey)) {
                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: this.formatColumnName(key),
                        type: 'group',
                        dataType: 'object',
                        children: []
                    });
                }
                this.analyzeFullResponseStructure(value, fullKey, columnMap, depth + 1, maxDepth);
            } else {
                // Primitive → leaf column
                if (!columnMap.has(fullKey)) {
                    columnMap.set(fullKey, {
                        id: fullKey,
                        name: this.formatColumnName(key),
                        type: type,
                        parent: prefix || null,
                        sortable: true,
                        filterable: true
                    });
                }
            }
        });
    }


    buildColumnHierarchy(columnMap) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.buildColumnHierarchy(columnMap);
    }

    inferColumnType(value) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.inferDataType(value);
    }

    formatColumnName(key) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.formatColumnName(key);
    }

    // Helper to get discovered paths using frontend discovery
    getDiscoveredPaths() {
        if (!this.rawData || !this.rawData.responses || this.rawData.responses.length === 0) {
            return [];
        }

        // Use the first response to discover paths (consistent with backend approach)
        const firstResponse = this.rawData.responses[0];
        const discoveredPaths = discoverDataPaths(firstResponse);
        return discoveredPaths;
    }

    // Issue #229 Phase 1B: the "view selector" is now a Views dropdown —
    // it lists saved views for the active tab (plus Manage Views / Create
    // View). Kept the same DOM ids for minimal churn.
    // Issue #248: Input tab also uses this dropdown but renders its
    // pre-canned auto-views as read-only (no Edit button, no Create View
    // footer). Selection is sticky in-session but not persisted.
    updateRootPathSelector(_currentPath) {
        const tab = this.currentTab;
        const btnLabel = document.getElementById('current-root');
        const pathList = document.getElementById('root-path-list');
        if (!pathList) return;

        // For tabs that don't use views (logs, info, raw), fall back.
        if (tab !== 'success' && tab !== 'errors' && tab !== 'input') {
            if (btnLabel) btnLabel.textContent = _currentPath || 'root';
            pathList.innerHTML = '';
            return;
        }

        const isInput = tab === 'input';
        const views = isInput
            ? this.getInputViews()
            : ((this.userSettings[tab] || { views: [] }).views || []);
        const settings = this.userSettings[tab] || { views: [], activeView: '' };
        const activeName = isInput
            ? (this.userSettings?.input?.activeView || views[0]?.name)
            : settings.activeView;
        const active = views.find(v => v.name === activeName) || views[0];

        // Issue #250: flag views whose rowBasis is missing in some of the
        // current responses — the table would silently drop those rows
        // and look like an API failure. Computed once here so the active
        // label and each dropdown row can share the per-view counts.
        let rawDataForTab = [];
        if (!isInput && this.rawData && Array.isArray(this.rawData.responses)) {
            const classified = this._lastClassified || this.classifyResponses(this.rawData.responses);
            rawDataForTab = classified[tab] || [];
        }
        const viewEmptyCounts = new Map();
        for (const v of views) {
            const basis = v.rowBasis || 'root';
            const empty = (basis === 'root' || !rawDataForTab.length)
                ? 0
                : this.tableBuilder.countResponsesWithNoRows(rawDataForTab, basis);
            viewEmptyCounts.set(v.name, empty);
        }

        if (btnLabel) {
            const activeEmpty = active ? (viewEmptyCounts.get(active.name) || 0) : 0;
            btnLabel.textContent = active ? active.name : 'no views';
            // Mark the active label with a warning sibling so users see
            // the issue even when the dropdown is closed. Cleared by
            // re-render whenever views or data change.
            let warnEl = btnLabel.parentElement && btnLabel.parentElement.querySelector('.view-name-warning');
            if (activeEmpty > 0 && btnLabel.parentElement) {
                if (!warnEl) {
                    warnEl = document.createElement('span');
                    warnEl.className = 'view-name-warning';
                    btnLabel.parentElement.insertBefore(warnEl, btnLabel.nextSibling);
                }
                warnEl.innerHTML = ' ' + window.Icons.label('triangle-alert');
                warnEl.title = `${activeEmpty} of ${rawDataForTab.length} response${rawDataForTab.length === 1 ? '' : 's'} had no rows at the active row basis`;
            } else if (warnEl) {
                warnEl.remove();
            }
        }

        pathList.innerHTML = '';
        for (const v of views) {
            const item = document.createElement('div');
            const isCurrent = active && v.name === active.name;
            const isDefault = !isInput && settings.defaultView === v.name;
            item.className = `root-path-item${isCurrent ? ' current' : ''}`;
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            const aliasedBasis = this.aliasEnvelopeDataPath(v.rowBasis || 'root');
            const shortBasis = this.shortenBasisPath(aliasedBasis);
            const editButton = (v.isReadOnly || isInput)
                ? ''
                : `<button class="view-row-edit" title="Edit this view" aria-label="Edit view">Edit</button>`;
            // Issue #250: per-view warning icon when the current data has
            // empty rowBasis on some responses.
            const emptyForView = viewEmptyCounts.get(v.name) || 0;
            const warningBadge = emptyForView > 0
                ? ` <span class="view-name-warning" title="${this.escapeHtml(emptyForView + ' of ' + rawDataForTab.length + ' response' + (rawDataForTab.length === 1 ? '' : 's') + ' have no rows at this view\u2019s row basis')}">${window.Icons.label('triangle-alert')}</span>`
                : '';
            // #298: the Views saved compares read
            const inCompares = tab === 'success' && window.ConsoleCompare ? window.ConsoleCompare.comparesUsing(v.name) : 0;
            const compareNote = inCompares ? ` · used by ${inCompares} compare${inCompares === 1 ? '' : 's'}` : '';
            // A View a query reads is locked: the Reporting icon says so
            const use = this.viewUse(v.name);
            const queryBadge = use.locked ? ` <span title="Used in ${use.text}: columns can be added, not removed, and its row basis and name stay">${window.Icons.label('database')}</span>` : '';
            item.innerHTML = `
                <div class="path-info" style="flex:1;min-width:0;">
                    <div class="path-name">${this.escapeHtml(v.name)}${isDefault ? ' ' + window.Icons.label('star') : ''}${queryBadge}${warningBadge}</div>
                    <div class="path-description" title="row basis: ${this.escapeHtml(aliasedBasis)}">row basis: <code>${this.escapeHtml(shortBasis)}</code> · ${this.countLeafColumns(v.columns || [])} cols${(v.isReadOnly || isInput) ? ' · auto' : ''}${compareNote}</div>
                </div>
                ${editButton}
            `;
            item.onclick = (e) => {
                // Edit button → open editor; anywhere else on row → activate
                if (e.target.closest('.view-row-edit')) {
                    e.stopPropagation();
                    document.getElementById('root-dropdown').classList.add('hidden');
                    this.openViewEditor(v.name);
                    return;
                }
                this.activateView(v.name);
            };
            pathList.appendChild(item);
        }

        // No "+ Create View" footer for the Input tab — its views are derived.
        if (!isInput) {
            const divider = document.createElement('div');
            divider.style.cssText = 'border-top:1px solid var(--vscode-panel-border);margin:4px 0;';
            pathList.appendChild(divider);
            const create = document.createElement('div');
            create.className = 'root-path-item';
            create.innerHTML = '<div class="path-info"><div class="path-name">+ Create View…</div></div>';
            create.onclick = () => {
                document.getElementById('root-dropdown').classList.add('hidden');
                this.openViewEditor(null);
            };
            pathList.appendChild(create);
        }
    }

    activateView(viewName) {
        const tab = this.currentTab;
        // Issue #248: Input tab has no persisted userSettings entry by
        // default (its views are derived). Initialise on demand so the
        // selection survives within the session.
        if (!this.userSettings[tab]) {
            this.userSettings[tab] = { activeView: '', views: [] };
        }
        this.userSettings[tab].activeView = viewName;
        document.getElementById('root-dropdown').classList.add('hidden');
        this.extractAndRender(tab);
        if (tab === 'success' || tab === 'errors') debouncedSaveSettings();
    }

    changeRootPath(newPath) {
        if (!this.currentTab) return;

        const currentPath = this.getCurrentPath(this.currentTab);

        // NEW: Track navigation history for parent field inclusion (GitHub Issue #81)
        this.trackNavigation(currentPath, newPath);

        // Update to new path (this will create pathConfig if needed)
        this.setCurrentPath(this.currentTab, newPath);
        document.getElementById('current-root').textContent = newPath;
        document.getElementById('root-dropdown').classList.add('hidden');

        // Update the dropdown to highlight the new current path
        this.updateRootPathSelector(newPath);

        // Save settings if this is success or errors tab (GitHub Issue #84)
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }

        // Re-extract and render with new path
        this.extractAndRender(this.currentTab, newPath);
    }
    
    // Issue #229 Phase 1B.4: "New View" button inside expand-cells.
    // Opens the editor pre-filled with rowBasis = pathContext, scalar
    // descendants auto-seeded inside the proper nested wrapper chain,
    // and a unique suggested name. User just hits Save.
    setArrayAsRoot(pathContext) {
        if (!this.currentTab || !pathContext) return;

        // Open the editor in Create mode
        this.openViewEditor(null);

        const view = this.editorPendingView;
        if (!view) return;

        // Pin rowBasis to the array path
        view.rowBasis = pathContext;
        view._rowBasisPinned = true;

        // Walk the first sample item at pathContext and collect scalar
        // descendant ids — addLeafToView wires each into the right
        // nested wrapper chain automatically.
        const rawDataForTab = this.getRawDataForCurrentTab();
        if (rawDataForTab && rawDataForTab.length > 0) {
            let sampleItem;
            for (const response of rawDataForTab) {
                const extracted = this.tableBuilder.extractSingleAtPath(response, pathContext);
                const candidate = Array.isArray(extracted) ? extracted[0] : extracted;
                if (candidate && typeof candidate === 'object') {
                    sampleItem = candidate;
                    break;
                }
            }
            if (sampleItem && typeof sampleItem === 'object') {
                const prefix = pathContext + '.';
                for (const key of Object.keys(sampleItem)) {
                    const v = sampleItem[key];
                    if (v === null || v === undefined) continue;
                    const t = typeof v;
                    if (t === 'string' || t === 'number' || t === 'boolean') {
                        this.addLeafToView(prefix + key);
                    }
                }
            }
        }

        // Suggest a unique name from the last path segment. Append a
        // numeric suffix if the suggestion collides with existing views.
        const lastSegment = pathContext.split('.').pop() || pathContext;
        const existing = (this.userSettings[this.currentTab]?.views || []).map(v => v.name);
        let suggested = lastSegment;
        let counter = 2;
        while (existing.includes(suggested)) {
            suggested = `${lastSegment} ${counter}`;
            counter++;
        }
        view.name = suggested;
        const nameInput = document.getElementById('view-editor-name');
        if (nameInput) nameInput.value = suggested;

        this.updateSourcesForRowBasis();
        this.renderRowBasisSelect();
        this.renderEditorTree();
        this.renderEditorSelected();
    }

    // Issue #229 Phase 1B.12: "Set as Row" inside an expand-cell.
    // Drills the active view into that array by rebasing rowBasis in
    // place. Leaf sources (current/ancestor) are recomputed from the
    // new basis so the same columns render sensibly. Persists.
    setRowBasisOnActiveView(pathContext) {
        if (!this.currentTab || !pathContext) return;
        const view = this.getActiveView(this.currentTab);
        if (!view) return;
        if (view.rowBasis === pathContext) return;
        view.rowBasis = pathContext;
        const rebase = (cols) => {
            for (const c of cols || []) {
                if (c && c.source === 'nested') {
                    rebase(c.children || []);
                } else if (c) {
                    c.source = this.deriveLeafSource(c.id, pathContext);
                }
            }
        };
        rebase(view.columns || []);
        this.extractAndRender(this.currentTab);
        this.updateRootPathSelector();
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }
    }

    // NEW: Navigation tracking methods for parent field inclusion (GitHub Issue #81)
    trackNavigation(fromPath, toPath) {
        // Reset navigation history when going back to root
        if (toPath === 'root') {
            this.navigationHistory.pathStack = ['root'];
            this.navigationHistory.parentDataChain = [];
            this.navigationHistory.originalData = null;

            // FIX #110: Clear WeakMap when changing root path to prevent memory leaks
            this.parentChildMap = new WeakMap();
            return;
        }

        // Initialize path stack if empty
        if (this.navigationHistory.pathStack.length === 0) {
            this.navigationHistory.pathStack = ['root'];
        }

        // If we're going deeper into the data structure
        if (toPath.startsWith(fromPath + '.') || (fromPath === 'root' && !toPath.includes('root.'))) {
            // Going deeper - add to path stack and build parent data
            const pathSegments = toPath === 'root' ? ['root'] : toPath.split('.');
            this.navigationHistory.pathStack = pathSegments;
            this.buildParentDataChain();
        } else {
            // Different path or sibling path - reset and build new chain
            const pathSegments = toPath === 'root' ? ['root'] : toPath.split('.');
            this.navigationHistory.pathStack = pathSegments;

            // FIX #110: Clear WeakMap when changing to different path
            this.parentChildMap = new WeakMap();

            this.buildParentDataChain();
        }
    }

    buildParentDataChain() {
        this.navigationHistory.parentDataChain = [];

        if (!this.rawData || this.navigationHistory.pathStack.length <= 1) {
            return; // No parent data needed for root level
        }

        // Get the raw data for current tab
        let rawDataForTab;
        if (this.currentTab === 'input') {
            rawDataForTab = this.rawData.inputData || [];
        } else {
            const classified = this.classifyResponses(this.rawData.responses);
            rawDataForTab = classified[this.currentTab] || [];
        }

        if (rawDataForTab.length === 0) return;

        // Build parent data chain for each level up to (but not including) the current level
        for (let i = 0; i < this.navigationHistory.pathStack.length - 1; i++) {
            const partialPath = this.navigationHistory.pathStack.slice(0, i + 1).join('.');

            // Extract parent data at this level (without denormalization to avoid recursion)
            const parentData = this.extractAtPathRaw(rawDataForTab, partialPath);

            if (parentData && parentData.length > 0) {
                this.navigationHistory.parentDataChain.push({
                    path: partialPath,
                    level: i,
                    sampleData: parentData[0], // Store first item as sample for field discovery
                    parentFieldSchema: this.extractParentFieldSchema(parentData[0]) // Extract field schema
                });
            }
        }

    }

    // NEW: Extract data without denormalization to avoid recursion during parent chain building
    extractAtPathRaw(dataArray, path) {
        if (!path || path === 'root') {
            return dataArray;
        }

        let extracted = [];
        dataArray.forEach((item) => {
            const result = this.extractSingleAtPath(item, path);
            if (result !== null) {
                if (Array.isArray(result)) {
                    // FIX issue#100: Can't use spread operator on huge arrays (causes stack overflow)
                    // Use concat for large arrays instead of push(...result)
                    if (result.length > 10000) {
                        extracted = extracted.concat(result);
                    } else {
                        extracted.push(...result);
                    }
                } else {
                    extracted.push(result);
                }
            }
        });

        return extracted.length > 0 ? extracted : dataArray;
    }

    // NEW: Extract parent field schema for later use
    extractParentFieldSchema(parentData) {
        if (typeof parentData !== 'object' || parentData === null) {
            return {};
        }

        const schema = {};
        Object.keys(parentData).forEach(key => {
            const value = parentData[key];
            const fieldType = this.inferColumnType(value);

            // Only include simple values (no nested objects/arrays)
            if (fieldType !== 'object' && fieldType !== 'array') {
                schema[key] = value;
            }
        });

        return schema;
    }

    renderTable(data, columns, options = {}) {
        const tableHead = document.getElementById('table-head');
        const tableBody = document.getElementById('table-body');
        const tableContainer = document.getElementById('table-container');

        // Issue #312: a live redraw keeps the user's place. Clearing the body
        // collapses the container and the browser snaps scrollTop to 0, so
        // remember it first and put it back once the rows (or the virtual
        // spacer) give the container its height again.
        const keepScrollTop = options.keepScroll ? tableContainer.scrollTop : 0;
        // What is on show, for the find box: `@column.` lists the keys inside a column's nested data
        this._shownRows = data;
        this._shownColumns = columns;

        // Clear existing content
        tableHead.innerHTML = '';
        tableBody.innerHTML = '';

        // Reset virtual scroll state when switching to standard rendering
        if (this.virtualScrollHandler) {
            tableContainer.removeEventListener('scroll', this.virtualScrollHandler);
            this.virtualScrollHandler = null;
        }
        // Issue #131: Reset virtual scroll tracking state
        this.lastRenderedStart = -1;
        this.lastRenderedEnd = -1;
        this.virtualScrollData = null;
        // Reset container styles
        tableContainer.style.height = '';
        tableContainer.style.overflow = '';
        tableContainer.style.position = '';

        if (!data || data.length === 0) {
            // Only show empty state if we're certain there's no data AND we don't have overall response data
            // This prevents showing empty state during tab switches when live updates have provided data
            if (!this.rawData || !this.rawData.responses || this.rawData.responses.length === 0) {
                document.getElementById('empty-state').classList.remove('hidden');
                document.getElementById('table-container').classList.add('hidden');
            }
            return;
        }

        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('table-container').classList.remove('hidden');

        // PERFORMANCE: Use virtual scrolling for large datasets (Issue #94)
        const VIRTUAL_SCROLL_THRESHOLD = 200;
        if (data.length >= VIRTUAL_SCROLL_THRESHOLD) {
            this.renderTableVirtual(data, columns, keepScrollTop);
            return;
        }

        // Standard rendering for smaller datasets (preserves all features)
        // Build hierarchical header structure
        this._headRows = data;   // what the headings' sort icons read: numbers, or text
        this.renderHierarchicalHeaders(columns, tableHead);

        // Create data rows with rich rendering
        const groups = columns.filter(col => col.type === 'group');
        const dataColumns = columns.filter(col => col.type !== 'group');
        
        // Get columns in the same visual order as headers
        const columnsInVisualOrder = this.getColumnsInVisualOrder(groups, dataColumns);
        
        data.forEach((row, index) => {
            if (index === 0) {
            }
            
            const tr = document.createElement('tr');
            tr.className = 'data-row';
            // Issue #296: right-click → the transaction behind the row
            tr._dbmnRow = row;
            
            // Render columns in the same order as headers
            columnsInVisualOrder.forEach(column => {
                const td = document.createElement('td');
                const value = this.extractNestedValue(row, column.id);
                
                if (index === 0) {
                }
                
                // Use the original unified rendering functions for rich display
                // Arrays stay as expandable, nested objects are now flattened
                const baseCellClass = this.getCellClass(column.type);
                const cellClass = column.isAncestor
                    ? baseCellClass + ' col-ancestor'
                    : baseCellClass;
                if (Array.isArray(value)) {
                    // Issue #229 Phase 1B.7: column.id is already the
                    // absolute JSON path under the view model — don't
                    // prepend currentRoot (which would produce bad paths
                    // like `data.data.data` and prevent `+ New View`
                    // visibility from matching saved rowBasis values).
                    // Issue #238: pass row index so deterministic
                    // expandableId matches the virtual-scroll path.
                    const arrayPath = column.id;
                    td.innerHTML = renderDataAsTable(value, 0, arrayPath, index);
                    td.className = cellClass;
                } else {
                    // Primitive values or flattened nested values
                    this.applyPrimitiveCell(td, value, cellClass);
                    const width = this.columnWidthOf(column.id);
                    if (width) this.applyColumnWidth(td, width);
                }
                
                tr.appendChild(td);
            });

            tableBody.appendChild(tr);
        });

        if (keepScrollTop) tableContainer.scrollTop = keepScrollTop; // Issue #312

        // Issue #271: once the table has laid out, flag any cell whose
        // text is visually truncated as click-to-expand (needs geometry).
        requestAnimationFrame(() => this.markTruncatedCells(tableBody));
    }

    renderTableVirtual(data, columns, keepScrollTop = 0) {
        // Clean up any existing virtual scroll handler
        if (this.virtualScrollHandler) {
            const tableContainer = document.getElementById('table-container');
            tableContainer.removeEventListener('scroll', this.virtualScrollHandler);
            this.virtualScrollHandler = null;
        }

        // Store data and columns for scroll handler
        this.virtualScrollData = data;
        this.virtualScrollColumns = columns;

        const tableHead = document.getElementById('table-head');
        const tableBody = document.getElementById('table-body');
        const tableContainer = document.getElementById('table-container');

        // Render headers normally
        this._headRows = data;   // what the headings' sort icons read: numbers, or text
        this.renderHierarchicalHeaders(columns, tableHead);

        // Capture column widths from rendered headers
        this.captureColumnWidths(tableHead);

        // Set up virtual scrolling container
        const totalHeight = data.length * this.rowHeight;
        tableContainer.style.height = '600px'; // Fixed height for scrolling
        tableContainer.style.overflow = 'auto';
        tableContainer.style.position = 'relative';

        // Create spacer to enable scrolling
        const existingSpacer = tableBody.querySelector('.virtual-scroll-spacer');
        if (existingSpacer) {
            existingSpacer.remove();
        }
        const spacer = document.createElement('tr');
        spacer.className = 'virtual-scroll-spacer';
        spacer.style.height = `${totalHeight}px`;
        spacer.style.visibility = 'hidden';
        tableBody.appendChild(spacer);

        // Render initial visible rows. Issue #287: re-measure the real row
        // height on every render — CSS and fonts decide it, not a constant.
        this.lastRenderedStart = -1;
        this.lastRenderedEnd = -1;
        this.rowHeightMeasured = false;
        if (keepScrollTop) tableContainer.scrollTop = Math.min(keepScrollTop, totalHeight); // Issue #312
        this.lastVirtualScrollTop = tableContainer.scrollTop;
        this.updateVirtualRows();

        // Issue #131: Attach scroll handler with RAF throttling
        // This prevents scroll events from overwhelming the DOM during fast scrolling
        this.virtualScrollHandler = () => {
            if (this.scrollRAFPending) return;
            this.scrollRAFPending = true;
            requestAnimationFrame(() => {
                this.scrollRAFPending = false;
                this.updateVirtualRows();
            });
        };
        tableContainer.addEventListener('scroll', this.virtualScrollHandler, { passive: true });
    }

    captureColumnWidths(tableHead) {
        // Capture widths from the last header row (data column headers)
        const headerRows = tableHead.querySelectorAll('tr');
        const lastRow = headerRows[headerRows.length - 1];
        const headerCells = lastRow.querySelectorAll('th');

        // Capture and apply widths to ensure headers and body align perfectly
        this.columnWidths = Array.from(headerCells).map((th, index) => {
            // A width the user set stays as set
            if (th.dataset.columnId && this.columnWidthOf(th.dataset.columnId)) return th.offsetWidth;
            const width = th.offsetWidth;
            // Apply same explicit width to header cell
            th.style.width = `${width}px`;
            th.style.minWidth = `${width}px`;
            th.style.maxWidth = `${width}px`;
            return width;
        });
    }

    updateVirtualRows() {
        const tableContainer = document.getElementById('table-container');
        const tableBody = document.getElementById('table-body');

        // Issue #131: Guard against invalid state
        if (!this.virtualScrollData || !tableContainer || !tableBody || !window.VirtualWindow) {
            return;
        }
        const VW = window.VirtualWindow;

        const scrollTop = Math.max(0, tableContainer.scrollTop);
        const viewportHeight = tableContainer.clientHeight;
        const totalDataRows = this.virtualScrollData.length;

        // Issue #287: scroll speed (px since the last update) decides how far
        // ahead to render and how early to re-render, so fast wheel flings
        // and scrollbar drags land on rows that already exist.
        const delta = scrollTop - this.lastVirtualScrollTop;
        this.lastVirtualScrollTop = scrollTop;
        const direction = Math.sign(delta);
        const speed = Math.abs(delta);

        // Issue #238: while any nested array is expanded, render all rows
        // (skip virtual windowing). Variable expanded-row heights break the
        // constant row-height math; rendering everything sidesteps the
        // jank entirely. Capped to keep pathological dataset sizes from
        // full-rendering and tanking perf.
        const FULL_RENDER_CAP = 5000;
        const hasExpansions = !!(window.dynamicReportManager
            && window.dynamicReportManager.expandedNestedIds
            && window.dynamicReportManager.expandedNestedIds.size > 0);
        const skipWindowing = hasExpansions && totalDataRows <= FULL_RENDER_CAP;

        let target;
        if (skipWindowing) {
            target = { start: 0, end: totalDataRows };
        } else {
            // Issue #287: overscan grows with scroll speed but is capped —
            // the table lays out every rendered row, so a scrollbar jump
            // must not render hundreds of rows. A jump bigger than the cap
            // cannot be pre-rendered anyway; it lands on a fresh window.
            const MAX_OVERSCAN_PX = 3000;
            // A jump farther than the cap (scrollbar drag) can't be served by
            // overscan, so render just the viewport plus a little — the
            // window grows back to full overscan once scrolling slows.
            const isJump = speed > MAX_OVERSCAN_PX;
            const overscanAhead = isJump
                ? viewportHeight
                : Math.min(MAX_OVERSCAN_PX, Math.max(1500, viewportHeight * 4, speed * 3));
            // Only re-render once the rendered rows beyond the viewport run
            // low, instead of on every row-height of scroll. Margin stays
            // below the overscan so a fresh window doesn't re-render at once.
            const rendered = { start: this.lastRenderedStart, end: this.lastRenderedEnd };
            if (!VW.needsRender({
                rendered, scrollTop, viewportHeight, rowHeight: this.rowHeight, totalRows: totalDataRows,
                marginPx: Math.min(overscanAhead / 2, Math.max(viewportHeight, speed * 2))
            })) {
                return;
            }
            target = VW.computeWindow({
                scrollTop, viewportHeight, rowHeight: this.rowHeight, totalRows: totalDataRows, direction,
                overscanAhead,
                overscanBehind: Math.max(400, viewportHeight)
            });
        }

        // Add/update top spacer to push rendered rows to the correct scroll position
        let topSpacer = tableBody.querySelector(':scope > .virtual-scroll-top-spacer');
        if (!topSpacer) {
            topSpacer = document.createElement('tr');
            topSpacer.className = 'virtual-scroll-top-spacer';
            const cell = document.createElement('td');
            cell.colSpan = this.virtualScrollColumns.length;
            topSpacer.appendChild(cell);
            tableBody.insertBefore(topSpacer, tableBody.firstChild);
        }
        const topSpacerCell = topSpacer.querySelector('td');
        topSpacerCell.style.padding = '0';
        topSpacerCell.style.border = 'none';
        const bottomSpacer = tableBody.querySelector(':scope > .virtual-scroll-spacer');

        // Issue #287: keep rows that stay inside the window and build only
        // the rows entering it. Rows are keyed by data index (read from the
        // DOM, not lastRendered*), so a forced re-evaluation also keeps the
        // row a user just expanded connected (Issue #267A anchoring).
        let keepStart = -1;
        let keepEnd = -1;
        tableBody.querySelectorAll(':scope > tr.data-row').forEach(tr => {
            const i = Number(tr.dataset.rowIndex);
            if (!(i >= target.start && i < target.end)) {
                tr.remove();
                return;
            }
            if (keepStart < 0 || i < keepStart) keepStart = i;
            if (i + 1 > keepEnd) keepEnd = i + 1;
        });

        const groups = this.virtualScrollColumns.filter(col => col.type === 'group');
        const dataColumns = this.virtualScrollColumns.filter(col => col.type !== 'group');
        const columnsInVisualOrder = this.getColumnsInVisualOrder(groups, dataColumns);
        const addedRows = [];
        const buildRange = (from, to) => {
            const fragment = document.createDocumentFragment();
            for (let i = from; i < to; i++) {
                const tr = this.buildVirtualRow(i, columnsInVisualOrder);
                fragment.appendChild(tr);
                addedRows.push(tr);
            }
            return fragment;
        };
        if (keepStart < 0) {
            tableBody.insertBefore(buildRange(target.start, target.end), bottomSpacer);
        } else {
            if (target.start < keepStart) {
                tableBody.insertBefore(buildRange(target.start, keepStart), topSpacer.nextSibling);
            }
            if (keepEnd < target.end) {
                tableBody.insertBefore(buildRange(keepEnd, target.end), bottomSpacer);
            }
        }
        this.lastRenderedStart = target.start;
        this.lastRenderedEnd = target.end;
        this.applyVirtualPaddings(target, totalDataRows, topSpacerCell, bottomSpacer);

        // Issue #287: measure the real row height once per render. When it
        // differs from the estimate, keep the same first row at the top of
        // the viewport and re-window with the measured height.
        if (!this.rowHeightMeasured && !hasExpansions && addedRows.length > 0 && viewportHeight > 0) {
            const measured = VW.averageRowHeight(addedRows.slice(0, 50).map(tr => tr.getBoundingClientRect().height), 0);
            if (measured > 0) {
                this.rowHeightMeasured = true;
                if (Math.abs(measured - this.rowHeight) > 0.5) {
                    const anchorRow = scrollTop / this.rowHeight;
                    this.rowHeight = measured;
                    this.applyVirtualPaddings(target, totalDataRows, topSpacerCell, bottomSpacer);
                    tableContainer.scrollTop = anchorRow * measured;
                    this.lastVirtualScrollTop = tableContainer.scrollTop;
                    this.lastRenderedStart = -1;
                    this.lastRenderedEnd = -1;
                    this.updateVirtualRows();
                    return;
                }
            }
        }

        // Issue #271: flag truncated cells in the rows that just entered —
        // rows kept from the previous window were already checked.
        if (addedRows.length > 0) {
            requestAnimationFrame(() => addedRows.forEach(tr => {
                if (tr.isConnected) this.markTruncatedCells(tr);
            }));
        }
    }

    // Issue #287: size the spacers that stand in for unrendered rows.
    applyVirtualPaddings(range, totalDataRows, topSpacerCell, bottomSpacer) {
        const pads = window.VirtualWindow.paddings({
            start: range.start, end: range.end, totalRows: totalDataRows, rowHeight: this.rowHeight
        });
        topSpacerCell.style.height = `${pads.top}px`;
        if (bottomSpacer) bottomSpacer.style.height = `${pads.bottom}px`;
    }

    // Build one virtual-scroll data row, keyed by its data index.
    buildVirtualRow(i, columnsInVisualOrder) {
        const rowData = this.virtualScrollData[i];
        const tr = document.createElement('tr');
        tr.className = 'data-row';
        tr.dataset.rowIndex = String(i);
        // Issue #296: right-click → the transaction behind the row
        tr._dbmnRow = rowData;

        // Issue #238: dropped per-cell inline widths — they prevented
        // expanded nested arrays from growing the parent column
        // (maxWidth capped the cell). Column stability (preventing
        // width jiggle as virtual-scroll swaps row batches) should
        // come from <th> sizing or table-layout: fixed + <colgroup>,
        // not from forcing every td to a hard maxWidth.
        columnsInVisualOrder.forEach(column => {
            const td = document.createElement('td');
            const value = this.extractNestedValue(rowData, column.id);

            if (Array.isArray(value)) {
                // Issue #229 Phase 1B.7: column.id is already absolute.
                // Issue #238: pass row index so the expandableId is
                // deterministic and the manager Set can restore state.
                const arrayPath = column.id;
                td.innerHTML = renderDataAsTable(value, 0, arrayPath, i);
                td.className = this.getCellClass(column.type);
            } else {
                this.applyPrimitiveCell(td, value, this.getCellClass(column.type));
                const width = this.columnWidthOf(column.id);
                if (width) this.applyColumnWidth(td, width);
            }

            tr.appendChild(td);
        });
        return tr;
    }

    /*
     * A data column's heading, as in every results table (shared/column-head.js): the name drags
     * the column to another place, the sort icon sorts, x takes the column out of the View, the
     * right edge resizes (double-click fits), and a right-click lists all of it by name.
     */
    fillColumnHeader(th, column, hideable) {
        const CH = window.ColumnHead;
        const box = document.createElement('div');
        box.className = 'flex align-center column-header-content';
        const name = document.createElement('span');
        name.className = 'column-name';
        name.textContent = column.name;
        // A View Reporting reads keeps its columns: no x on its headings
        if (hideable && this.viewUse(this.userSettings[this.currentTab] && this.userSettings[this.currentTab].activeView).locked) hideable = false;
        const actions = document.createElement('span');
        actions.className = 'header-actions';
        const sort = CH.sortButton({
            label: column.name, numbers: this.isNumberColumn(column),
            dir: this.sortColumn === column.id ? this.sortDirection : ''
        });
        actions.appendChild(sort);
        if (hideable) {
            const hide = CH.hideButton({ label: column.name, title: 'Remove this column from the View' });
            hide.setAttribute('data-click', 'console:hideColumn');
            hide.setAttribute('data-arg', column.id);
            actions.appendChild(hide);
        }
        box.append(name, actions);
        th.replaceChildren(box, CH.edge());
        th.dataset.columnType = this.isNumberColumn(column) ? 'number' : (column.type || '');
        if (hideable) th.dataset.hideable = '1';
        if (column.id !== window.ConsoleErrorReason?.REASON_COLUMN_ID && this.canMoveColumn(column.id)) {
            name.classList.add('is-movable');
            name.title = 'Hold and drag to move this column';
        }
        const width = this.columnWidthOf(column.id);
        if (width) this.applyColumnWidth(th, width);
    }

    /** A column of numbers, by its type or (going by the first rows) its values: its sort reads 0 to 1, not A to Z. */
    isNumberColumn(column) {
        if (column.type === 'number') return true;
        let any = false;
        for (const row of (this._headRows || []).slice(0, 50)) {
            const v = this.extractNestedValue(row, column.id);
            if (v === null || v === undefined || v === '') continue;
            if (typeof v !== 'number') return false;
            any = true;
        }
        return any;
    }

    /**
     * A column's level: the list in the View that holds it (the View's own top level, or the
     * columns of the group it sits in), and that group. A View's columns are a tree that follows
     * the data's shape; the headings show its leaves in a row. A column moves among the columns
     * and groups of its own level, so the View's order can always say where it went.
     */
    columnLevel(columnId) {
        if (!this.currentTab || this.isCurrentViewReadOnly()) return null;
        const view = this.getActiveView(this.currentTab);
        let found = null;
        const walk = (cols, parent) => {
            for (const c of cols || []) {
                if (found || !c) continue;
                if (c.id === columnId) found = { list: cols, parent };
                else if (c.children) walk(c.children, c);
            }
        };
        walk(view && view.columns, null);
        return found;
    }
    canMoveColumn(columnId) {
        const level = this.columnLevel(columnId);
        return !!level && level.list.filter(c => c && c.id).length > 1;
    }

    /**
     * The places a column can take, as they sit in the headings: each column or group of its
     * level that is on screen, with the heading columns it covers (a group covers all of its own).
     */
    levelUnits(columnId) {
        const level = this.columnLevel(columnId);
        const head = document.getElementById('table-head');
        if (!level || !head || head.rows.length !== 1) return [];
        const ths = Array.from(head.rows[0].cells);
        const under = (col, into) => { into.add(col.id); (col.children || []).forEach(c => c && under(c, into)); return into; };
        const units = [];
        for (const item of level.list) {
            if (!item || !item.id) continue;
            const ids = under(item, new Set());
            const own = ths.filter(th => ids.has(th.dataset.columnId));
            if (!own.length) continue;
            const first = own[0], last = own[own.length - 1];
            const before = units[units.length - 1];
            // Not side by side in the headings as in the View: no place to move to
            if (last.cellIndex - first.cellIndex !== own.length - 1 || (before && first.cellIndex <= before.last)) return [];
            units.push({ item, head: first, index: first.cellIndex, last: last.cellIndex, left: first.offsetLeft, width: last.offsetLeft + last.offsetWidth - first.offsetLeft, cells: [] });
        }
        return units;
    }

    /** A column goes before or after another of its level: the View's order follows, and is saved. */
    moveColumnInLevel(item, target, after) {
        const level = this.columnLevel(item.id);
        if (!level || item === target || !level.list.includes(target)) return;
        level.list.splice(level.list.indexOf(item), 1);
        level.list.splice(level.list.indexOf(target) + (after ? 1 : 0), 0, item);
        // Rows drawn from here on (virtual scrolling) follow the new order
        if (this.virtualScrollColumns) {
            const at = new Map(this.getColumnOrder(this.currentTab).map((id, i) => [id, i]));
            const place = c => (at.has(c.id) ? at.get(c.id) : -1);
            this.virtualScrollColumns = this.virtualScrollColumns.map((c, i) => ({ c, i })).sort((x, y) => place(x.c) - place(y.c) || x.i - y.i).map(x => x.c);
        }
        if (this.currentTab === 'success' || this.currentTab === 'errors') debouncedSaveSettings();
    }

    /** Let go outside its level: say where the column can go. */
    columnLeftItsLevel(columnId) {
        const level = this.columnLevel(columnId);
        if (!level) return;
        const name = columnId.split('.').pop();
        const where = level.parent ? `the columns of ${this.aliasEnvelopeDataPath(level.parent.id)}` : 'the columns beside it';
        showFooterNotification('warning', `${name} can only move among ${where}.`, { source: 'column-move', duration: 5000 });
    }

    /** A column's width set by the user (its right edge dragged, or fitted): kept with the View. */
    columnWidthOf(columnId) {
        const view = this.currentTab ? this.getActiveView(this.currentTab) : null;
        return (view && view.columnWidths && view.columnWidths[columnId]) || 0;
    }
    applyColumnWidth(cell, width) {
        const w = `${width}px`;
        if (cell.tagName === 'TH') cell.style.width = w;
        cell.style.minWidth = w;
        cell.style.maxWidth = w;
    }
    /** Set a column's width on screen: its heading and each of its cells (one holding a nested table grows as it needs). */
    setColumnWidth(th, width) {
        const edges = 17;   // a cell's padding either side, and its border
        const inner = Math.max(24, Math.round(width) - edges);
        const index = th.cellIndex;
        this.applyColumnWidth(th, inner);
        document.querySelectorAll('#table-body > tr.data-row').forEach(tr => {
            const td = tr.cells[index];
            if (td && !td.querySelector('table')) this.applyColumnWidth(td, inner);
        });
        return { inner, shown: Math.round(th.getBoundingClientRect().width) };
    }
    saveColumnWidth(columnId, inner) {
        const view = this.getActiveView(this.currentTab);
        if (!view || view.isReadOnly) return;
        view.columnWidths = Object.assign({}, view.columnWidths, { [columnId]: inner });
        if (this.currentTab === 'success' || this.currentTab === 'errors') debouncedSaveSettings();
    }
    fitColumn(th) {
        const CH = window.ColumnHead;
        const index = th.cellIndex;
        const name = th.querySelector('.column-name');
        let need = CH.textWidth(name, name.textContent) + th.querySelector('.header-actions').offsetWidth + 40;
        document.querySelectorAll('#table-body > tr.data-row').forEach(tr => {
            const td = tr.cells[index];
            if (td && !td.querySelector('table')) need = Math.max(need, CH.textWidth(td, td.textContent) + 21);
        });
        const set = this.setColumnWidth(th, Math.min(CH.MAX_FIT, need));
        this.saveColumnWidth(th.dataset.columnId, set.inner);
    }

    /**
     * Sort from a heading or its menu. A click on the icon (no `dir`) goes one way, then the
     * other, then clears, as in every results table; `dir` null clears. The icon is a clock
     * until the rows are drawn again.
     */
    sortFromHeader(columnId, dir) {
        if (dir === undefined) dir = this.sortColumn !== columnId ? 'asc' : this.sortDirection === 'asc' ? 'desc' : null;
        const th = Array.from(document.querySelectorAll('#table-head th')).find(h => h.dataset.columnId === columnId);
        if (th) window.ColumnHead.wait(th.querySelector('.col-sort-btn'), dir || 'asc');
        requestAnimationFrame(() => setTimeout(() => {
            this.sortColumn = dir ? columnId : null;
            this.sortDirection = dir || 'asc';
            this.saveSortState();
            this.extractAndRender(this.currentTab);
        }, 0));
    }

    /** Wire the headings once: the sort icon, the drag, the edge, the menu. */
    initColumnHeads() {
        const head = document.getElementById('table-head');
        const table = document.getElementById('data-table');
        if (!head || !table || !window.ColumnHead || this._columnHeadsReady) return;
        this._columnHeadsReady = true;
        const single = () => head.rows.length === 1;
        head.addEventListener('click', event => {
            const button = event.target.closest('.col-sort-btn');
            const th = button && button.closest('th');
            if (th && th.dataset.columnId) this.sortFromHeader(th.dataset.columnId);
        });
        if (window.ColumnDrag) {
            let held = [], heldId = '';
            window.ColumnDrag.attach({
                table,
                scroller: document.getElementById('table-container'),
                canDrag: (th, event) => single() && !!th.dataset.columnId && !!event.target.closest('.column-name.is-movable'),
                // The places it can take are its own level's; each takes its cells on screen with it
                units: th => {
                    heldId = th.dataset.columnId;
                    held = this.levelUnits(heldId);
                    const count = head.rows[0].cells.length;
                    const rows = Array.from(table.rows).filter(r => r.cells.length === count);
                    held.forEach(u => { for (let i = u.index; i <= u.last; i++) rows.forEach(r => u.cells.push(r.cells[i])); });
                    return held;
                },
                onMove: (from, to) => this.moveColumnInLevel(held[from].item, held[to].item, to > from),
                onOutside: () => this.columnLeftItsLevel(heldId)
            });
        }
        window.ColumnHead.attachResize(head, {
            hold: table,
            canResize: th => single() && !!th.dataset.columnId,
            widthOf: th => th.getBoundingClientRect().width,
            setWidth: (th, width) => { const set = this.setColumnWidth(th, width); th._innerWidth = set.inner; return set.shown; },
            done: th => this.saveColumnWidth(th.dataset.columnId, th._innerWidth),
            fit: th => this.fitColumn(th)
        });
        head.addEventListener('contextmenu', event => {
            const th = event.target.closest('th');
            if (!th || !th.dataset.columnId) return;
            const id = th.dataset.columnId;
            const units = single() && th.querySelector('.column-name.is-movable') ? this.levelUnits(id) : [];
            const at = units.findIndex(u => u.item.id === id);
            const moveTo = where => {
                this.moveColumnInLevel(units[at].item, units[where === 'start' ? 0 : units.length - 1].item, where !== 'start');
                this.extractAndRender(this.currentTab);
            };
            window.ColumnHead.menu(event, {
                numbers: th.dataset.columnType === 'number',
                dir: this.sortColumn === id ? this.sortDirection : '', sorted: !!this.sortColumn,
                first: at === 0, last: at === units.length - 1,
                sort: dir => this.sortFromHeader(id, dir),
                move: at >= 0 && units.length > 1 ? moveTo : null,
                fit: single() ? () => { window.ColumnHead.holdWidths(table); this.fitColumn(th); } : null,
                remove: th.dataset.hideable ? () => this.hideColumn(id) : null,
                removeLabel: 'Remove from the View'
            });
        });
    }

    renderHierarchicalHeaders(columns, tableHead) {
        this.initColumnHeads();
        // Headings drawn again: the table fits its window again (a resize had held its columns)
        const table = document.getElementById('data-table');
        if (table) { table.style.width = ''; delete table.dataset.widthsHeld; }
        // Analyze column structure to determine header levels needed
        const groups = columns.filter(col => col.type === 'group');
        const dataColumns = columns.filter(col => col.type !== 'group');
        const hasGroups = groups.length > 0;
        
        if (!hasGroups) {
            // No groups - render simple single-level header
            this.renderSimpleHeader(dataColumns, tableHead);
            return;
        }
        
        // Render multi-level headers
        this.renderMultiLevelHeaders(groups, dataColumns, tableHead);
    }
    
    renderSimpleHeader(columns, tableHead) {
        const headerRow = document.createElement('tr');
        const readOnly = this.isCurrentViewReadOnly();

        columns.forEach(column => {
            const th = document.createElement('th');
            th.dataset.columnId = column.id;
            th.className = column.isAncestor
                ? 'sortable-header col-ancestor'
                : 'sortable-header';

            // Add sort indicator if this column is sorted
            if (this.sortColumn === column.id) {
                th.classList.add(`sort-${this.sortDirection}`);
            }

            // Issue #248: x is suppressed on read-only views (Input tab).
            // #428: the Error tab's Reason column is not the view's to hide
            this.fillColumnHeader(th, column, !(readOnly || column.id === window.ConsoleErrorReason?.REASON_COLUMN_ID));

            headerRow.appendChild(th);
        });
        
        tableHead.appendChild(headerRow);
    }
    
    calculateMaxDepth(columns) {
        let maxDepth = 0;
        
        columns.forEach(column => {
            if (column.type === 'group') {
                // Count dots in the group ID to determine nesting level
                const depth = (column.id.match(/\./g) || []).length + 1;
                maxDepth = Math.max(maxDepth, depth);
            }
        });
        
        // Add 1 for the data column row at the bottom
        return maxDepth + 1;
    }
    
    countAllDescendants(groupId, allColumns) {
        let count = 0;
        const group = allColumns.find(col => col.id === groupId);
        
        if (!group || !group.children) return 0;
        
        group.children.forEach(childId => {
            const child = allColumns.find(col => col.id === childId);
            if (child) {
                if (child.type === 'group') {
                    // Recursively count descendants of nested groups
                    count += this.countAllDescendants(childId, allColumns);
                } else if (this.isColumnVisible(childId)) {
                    // Count visible data columns
                    count += 1;
                }
            }
        });
        
        return count;
    }
    
    renderMultiLevelHeaders(groups, dataColumns, tableHead) {
        
        const allColumns = [...groups, ...dataColumns];
        const maxDepth = this.calculateMaxDepth(allColumns);
        
        // Create header rows - one for each depth level
        const headerRows = [];
        for (let i = 0; i < maxDepth; i++) {
            const row = document.createElement('tr');
            row.className = `header-row-level-${i}`;
            headerRows.push(row);
        }
        
        // Track processed columns to avoid duplicates
        const processedColumns = new Set();
        
        // Process standalone columns first (they span all rows)
        dataColumns.forEach(column => {
            if (!column.parent && this.isColumnVisible(column.id)) {
                const th = document.createElement('th');
                th.rowSpan = maxDepth;
                th.dataset.columnId = column.id;
                th.className = 'sortable-header standalone-header';
                
                // Add sort indicator
                if (this.sortColumn === column.id) {
                    th.classList.add(`sort-${this.sortDirection}`);
                }
                
                // Issue #248: x suppressed on read-only views (Input tab).
                this.fillColumnHeader(th, column, !(this.isCurrentViewReadOnly() || column.id === window.ConsoleErrorReason?.REASON_COLUMN_ID));

                headerRows[0].appendChild(th);
                processedColumns.add(column.id);
            }
        });
        
        // Process groups recursively by depth level
        this.renderGroupsAtDepth(groups, allColumns, headerRows, processedColumns, 0);
        
        // Add all header rows to the table
        headerRows.forEach(row => tableHead.appendChild(row));
    }
    
    renderGroupsAtDepth(groups, allColumns, headerRows, processedColumns, currentDepth) {
        // Find groups at this depth level
        const groupsAtThisDepth = groups.filter(group => {
            const depth = (group.id.match(/\./g) || []).length;
            return depth === currentDepth && !processedColumns.has(group.id);
        });
        
        groupsAtThisDepth.forEach(group => {
            if (processedColumns.has(group.id)) return;
            
            const descendantCount = this.countAllDescendants(group.id, allColumns);
            if (descendantCount > 0) {
                // Create group header
                const th = document.createElement('th');
                th.colSpan = descendantCount;
                th.className = 'group-header';
                
                // Calculate rowspan - groups span until their children appear
                const childDepth = this.getChildrenMaxDepth(group, allColumns);
                const rowSpan = childDepth - currentDepth;
                if (rowSpan > 1) {
                    th.rowSpan = rowSpan;
                }
                
                // Issue #248: × suppressed on read-only views (Input tab).
                const groupHideBtn = this.isCurrentViewReadOnly()
                    ? ''
                    : `<button class="group-hide-btn" data-click="console:hideColumnGroup" data-arg="${consoleAttr(group.id)}">×</button>`;
                th.innerHTML = `
                    <span class="group-name">${group.name}</span>
                    ${groupHideBtn}
                `;
                
                headerRows[currentDepth].appendChild(th);
                processedColumns.add(group.id);
                
                // Process children at next depth level
                this.renderChildrenAtNextDepth(group, allColumns, headerRows, processedColumns, currentDepth + 1);
            }
        });
    }
    
    renderChildrenAtNextDepth(parentGroup, allColumns, headerRows, processedColumns, targetDepth) {
        if (!parentGroup.children) return;
        
        parentGroup.children.forEach(childId => {
            const child = allColumns.find(col => col.id === childId);
            if (!child || processedColumns.has(childId)) return;
            
            if (child.type === 'group') {
                // Recursively render nested groups
                this.renderGroupsAtDepth([child], allColumns, headerRows, processedColumns, targetDepth);
            } else if (this.isColumnVisible(childId)) {
                // Render data column in the last row
                const th = document.createElement('th');
                th.dataset.columnId = child.id;
                th.className = 'sortable-header child-header';
                
                // Add sort indicator
                if (this.sortColumn === child.id) {
                    th.classList.add(`sort-${this.sortDirection}`);
                }
                
                // Issue #248: x suppressed on read-only views (Input tab).
                this.fillColumnHeader(th, child, !(this.isCurrentViewReadOnly() || child.id === window.ConsoleErrorReason?.REASON_COLUMN_ID));

                // Data columns go in the last header row
                const lastRowIndex = headerRows.length - 1;
                headerRows[lastRowIndex].appendChild(th);
                processedColumns.add(childId);
            }
        });
    }
    
    getChildrenMaxDepth(group, allColumns) {
        let maxDepth = (group.id.match(/\./g) || []).length + 1;
        
        if (group.children) {
            group.children.forEach(childId => {
                const child = allColumns.find(col => col.id === childId);
                if (child && child.type === 'group') {
                    maxDepth = Math.max(maxDepth, this.getChildrenMaxDepth(child, allColumns));
                }
            });
        }
        
        return maxDepth;
    }
    
    getColumnsInVisualOrder(groups, dataColumns) {
        // #428: the Error tab's Reason column is not the view's; it is always first
        const reasonId = window.ConsoleErrorReason?.REASON_COLUMN_ID;
        const reason = reasonId ? dataColumns.find(c => c.id === reasonId) : undefined;
        if (reason) {
            return [reason, ...this.getColumnsInVisualOrder(groups, dataColumns.filter(c => c !== reason))];
        }
        // GitHub Issue #229: If view has a column order, use it
        const columnOrder = this.getColumnOrder(this.currentTab);
        if (columnOrder.length > 0) {
            const allCols = [...groups, ...dataColumns];
            const colMap = new Map(allCols.map(c => [c.id, c]));
            const result = [];
            columnOrder.forEach(id => {
                const col = colMap.get(id);
                if (col && col.type !== 'group' && this.isColumnVisible(id)) {
                    result.push(col);
                }
            });
            // Append any visible columns not in the order (newly discovered)
            dataColumns.forEach(col => {
                if (!result.find(r => r.id === col.id) && this.isColumnVisible(col.id)) {
                    result.push(col);
                }
            });
            return result;
        }

        const result = [];
        const allColumns = [...groups, ...dataColumns];
        const processed = new Set();

        // First add standalone columns (they appear first)
        dataColumns.forEach(column => {
            if (!column.parent && this.isColumnVisible(column.id)) {
                result.push(column);
                processed.add(column.id);
            }
        });

        // Then add grouped columns in hierarchical order
        this.addGroupedColumnsInOrder(groups, allColumns, result, processed, 0);

        return result;
    }
    
    addGroupedColumnsInOrder(groups, allColumns, result, processed, currentDepth) {
        // Find groups at this depth level
        const groupsAtThisDepth = groups.filter(group => {
            const depth = (group.id.match(/\./g) || []).length;
            return depth === currentDepth && !processed.has(group.id);
        });
        
        groupsAtThisDepth.forEach(group => {
            if (processed.has(group.id)) return;
            
            processed.add(group.id);
            
            // Add this group's children in order
            this.addChildrenInOrder(group, allColumns, result, processed);
        });
    }
    
    addChildrenInOrder(parentGroup, allColumns, result, processed) {
        if (!parentGroup.children) return;
        
        parentGroup.children.forEach(childId => {
            const child = allColumns.find(col => col.id === childId);
            if (!child || processed.has(childId)) return;
            
            if (child.type === 'group') {
                // Process nested group recursively
                processed.add(childId);
                this.addChildrenInOrder(child, allColumns, result, processed);
            } else if (this.isColumnVisible(childId)) {
                // Add data column to result
                result.push(child);
                processed.add(childId);
            }
        });
    }
    
    extractNestedValue(row, columnId) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.extractNestedValue(row, columnId);
    }

// Use the original unified rendering functions - no inferior methods needed
    // All rich rendering is handled by the restored global functions below

    // Removed duplicate formatCellValue - GitHub Issue #110: Now delegates to shared utility

    getCellClass(columnType) {
        switch (columnType) {
            case 'number': return 'numeric-cell';
            case 'date': return 'date-cell';
            case 'boolean': return 'boolean-cell';
            default: return 'text-cell';
        }
    }

    // Issue #271: render a primitive cell. Long string values (escaped
    // JSON, BASE64, ZPL, big blobs) become click-to-expand — a modal
    // shows the value with smart, overridable formatting. The raw value
    // is held on the element (not the DOM text) to avoid duplicating
    // large strings into data-* attributes.
    applyPrimitiveCell(td, value, cellClass) {
        const str = value != null ? String(value) : '';
        td.textContent = str;
        td.className = cellClass;
        td._fullValue = str;
        // A cell is worth opening in the detail modal when its content is
        // STRUCTURED (JSON / escaped-JSON / BASE64 / ZPL) — regardless of
        // width. Truncated-but-plain cells are caught after layout by
        // markTruncatedCells (scrollWidth needs a laid-out cell).
        if (window.CellDetail && window.CellDetail.worthOpening(str)) {
            this.makeCellExpandable(td);
        }
    }

    // Issue #271: turn a primitive cell into a click-to-expand affordance.
    // Adds a hover `maximize-2` icon at the right edge, a pointer cursor,
    // a short tooltip preview, and a one-time click → detail modal.
    // Idempotent so the post-layout truncation pass can call it freely.
    makeCellExpandable(td) {
        if (td._cellDetailBound) return;
        td._cellDetailBound = true;
        td.classList.add('cell-expandable');
        const raw = td._fullValue != null ? String(td._fullValue) : '';
        td.title = raw.length > 300 ? (raw.slice(0, 300) + '… (click to view full)') : raw;
        if (window.Icons && window.Icons.icon) {
            const ic = document.createElement('span');
            ic.className = 'cell-expand-icon';
            ic.innerHTML = window.Icons.icon('maximize-2');
            td.appendChild(ic);
        }
        td.addEventListener('click', () => this.openCellDetailModal(td._fullValue));
    }

    // Issue #271: after the table has laid out, flag any primitive cell
    // whose text is visually cut off (ellipsis) as click-to-expand — so
    // discoverability tracks what's actually truncated on screen, not an
    // arbitrary character count. Skips nested-content cells (they have
    // their own inline expand toggle) and already-expandable cells.
    markTruncatedCells(scope) {
        const root = scope || document;
        const cells = root.querySelectorAll('td.text-cell, td.numeric-cell, td.date-cell, td.boolean-cell');
        cells.forEach(td => {
            if (td._cellDetailBound) return;
            if (td.querySelector('.expandable-array, .nested-data-table')) return;
            if (td.scrollWidth > td.clientWidth + 1) {
                this.makeCellExpandable(td);
            }
        });
    }

    // Issue #271: open the cell-detail modal with auto-detected, but
    // user-overridable, formatting for a long value (shared/cell-detail.js,
    // which Compare uses too).
    openCellDetailModal(rawValue) {
        if (window.CellDetail) window.CellDetail.open(rawValue);
    }

    // Issue #229 Phase 1B.5: handleSort used to short-circuit through
    // the legacy extractAtPath + inferColumns pipeline, which returned
    // column shapes misaligned with the view — resulting in blank
    // tables on non-root rowBasis after a sort click. Now it just
    // updates sort state and re-renders through the view pipeline,
    // which reads sortColumn/sortDirection via restoreSortState.
    handleSort(columnId) {
        if (this.sortColumn === columnId) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = columnId;
            this.sortDirection = 'asc';
        }
        this.saveSortState();
        this.extractAndRender(this.currentTab);
    }

    // GitHub Issue #228: Reusable sort logic for both interactive sort and restore
    sortData(data, columnId) {
        data.sort((a, b) => {
            let aVal = this.extractNestedValue(a, columnId);
            let bVal = this.extractNestedValue(b, columnId);

            // Handle arrays/objects for sorting
            if (Array.isArray(aVal)) aVal = aVal.length;
            if (Array.isArray(bVal)) bVal = bVal.length;
            if (typeof aVal === 'object' && aVal !== null) aVal = JSON.stringify(aVal);
            if (typeof bVal === 'object' && bVal !== null) bVal = JSON.stringify(bVal);

            // Handle null/undefined values
            if (aVal == null) aVal = '';
            if (bVal == null) bVal = '';

            // Type-specific comparison
            if (typeof aVal === 'number' && typeof bVal === 'number') {
                return this.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
            } else if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
                const result = aVal === bVal ? 0 : aVal ? 1 : -1;
                return this.sortDirection === 'asc' ? result : -result;
            } else {
                // String comparison
                const result = String(aVal).localeCompare(String(bVal));
                return this.sortDirection === 'asc' ? result : -result;
            }
        });
    }

    // GitHub Issue #228: Save sort state to active view
    saveSortState() {
        if (!this.currentTab) return;
        const view = this.getActiveView(this.currentTab);
        view.sortColumn = this.sortColumn;
        view.sortDirection = this.sortDirection;

        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }
    }

    // GitHub Issue #228: Restore sort state from active view
    restoreSortState() {
        if (!this.currentTab) return;
        const view = this.getActiveView(this.currentTab);

        if (view.sortColumn) {
            this.sortColumn = view.sortColumn;
            this.sortDirection = view.sortDirection || 'asc';
        } else {
            this.sortColumn = null;
            this.sortDirection = 'asc';
        }
    }

    handleSearch(searchTerm) {
        // Issue #229 Phase 1B.10: search uses the view pipeline so
        // filter behaviour matches what the table actually renders.
        // Legacy extractAtPath + inferColumns path was removed.
        if (!this.rawData) return;

        let currentData;
        if (this.currentTab === 'input') {
            currentData = this.getInputRecords();
        } else {
            const classified = this._lastClassified || this.classifyResponses(this.rawData.responses);
            currentData = classified[this.currentTab] || [];
        }
        if (!currentData || currentData.length === 0) return;

        const view = this.getActiveView(this.currentTab);
        if (!view) return;

        const allRows = this.tableBuilder.extractRowsForView(currentData, view);
        let columns = this.viewToLegacyColumnShape(view, currentData[0]);
        // #428: as renderTab — the Error tab's Reason column, searchable like any other
        if (this.currentTab === 'errors' && window.ConsoleErrorReason) {
            columns = window.ConsoleErrorReason.withReasonColumn(allRows, columns);
        }

        let filteredRows;
        if (!searchTerm || searchTerm.trim() === '') {
            filteredRows = allRows;
        } else {
            const parsedTerms = window.SearchMatcher.parseSearchExpression(searchTerm);
            filteredRows = allRows.filter(row => {
                return window.SearchMatcher.matchesRow(parsedTerms, row, columns, (r, colId) => r[colId]);
            });
        }

        // Issue #262: set the filter state BEFORE rendering so updateStats
        // (called inside renderTable) doesn't briefly clobber the footer
        // row-count text. updateSearchResults will overwrite it with the
        // final "X of Y rows" string after render.
        if (searchTerm && searchTerm.trim() !== '') {
            this.currentFilteredRowCount = filteredRows.length;
        } else {
            this.currentFilteredRowCount = null;
        }
        this.renderTable(filteredRows, columns);
        this.updateSearchResults(searchTerm, allRows.length, filteredRows.length);
    }
    
    // Issue #262: the inline (X of Y) span next to the search box was removed.
    // The footer #row-count is the single source of truth — when a search is
    // active it shows "filtered of total rows"; otherwise just "total rows".
    updateSearchResults(searchTerm, totalRows, filteredRows) {
        const rowCount = document.getElementById('row-count');

        if (searchTerm && searchTerm.trim() !== '') {
            if (rowCount) {
                rowCount.textContent = `${filteredRows.toLocaleString()} of ${totalRows.toLocaleString()} rows`;
            }
            this.currentFilteredRowCount = filteredRows; // GitHub Issue #200: Track for scale limits
        } else {
            if (rowCount) {
                rowCount.textContent = `${totalRows.toLocaleString()} rows`;
            }
            this.currentFilteredRowCount = null; // No filter active
        }
    }

    // Issue #229 Phase 1B.5: per-column × hide, view-native.
    // Removes the column from the active view's structural tree,
    // prunes any wrappers left empty, clears sort state if the
    // hidden column was sorted, re-renders, and persists.
    hideColumn(columnId) {
        if (!this.currentTab) return;
        const view = this.getActiveView(this.currentTab);
        if (!view) return;
        const use = this.viewUse(view.name);
        if (use.locked) {
            showFooterNotification('warning', `${view.name} is used in ${use.text}, so its columns stay.`, { source: 'view-locked', duration: 5000 });
            return;
        }
        view.columns = this.removeColumnById(view.columns || [], columnId);
        this.pruneEmptyWrappersOn(view);
        if (view.sortColumn === columnId) {
            view.sortColumn = undefined;
            view.sortDirection = undefined;
            this.sortColumn = null;
            this.sortDirection = 'asc';
        }
        this.extractAndRender(this.currentTab);
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }
    }

    // Hide a nested wrapper column (object or array group header).
    hideColumnGroup(groupId) {
        if (!this.currentTab) return;
        const view = this.getActiveView(this.currentTab);
        if (!view) return;
        view.columns = this.removeWrapperDescendants(view.columns || [], groupId);
        this.pruneEmptyWrappersOn(view);
        this.extractAndRender(this.currentTab);
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }
    }

    // Issue #229 Phase 1B.5: sub-table × handler. Removes the child
    // from the view, keeps the expand-cell visible, and re-renders
    // only the sub-table in place (so scroll and expand state stays).
    //
    // Issue #267B: sub-row hides apply to ALL saved views on this tab,
    // not just the active one — sub-row columns come from the data
    // shape (not user-curated per view), so "this field is noise" is
    // a statement that should hold across views. We track them as a
    // negative list (`view.hiddenSubColumns`) which renderObjectArrayAsTable
    // honours by absolute path.
    hideSubColumn(absColId, subtableId) {
        if (!this.currentTab) return;
        if (this.currentTab !== 'success' && this.currentTab !== 'errors') return;
        const settings = this.userSettings[this.currentTab];
        if (!settings || !Array.isArray(settings.views) || settings.views.length === 0) return;

        settings.views.forEach(view => {
            if (!view) return;
            const hidden = new Set(view.hiddenSubColumns || []);
            hidden.add(absColId);
            view.hiddenSubColumns = Array.from(hidden);
            // Also strip from the positive columns list in case the
            // column was ever explicitly added there.
            view.columns = this.removeColumnById(view.columns || [], absColId);
            this.pruneEmptyWrappersOn(view);
        });
        debouncedSaveSettings();

        // Re-render only the sub-table HTML so the outer expand-cell
        // stays open and scrolled in place. Raw data is no longer
        // mutated — renderObjectArrayAsTable filters by hiddenSubColumns.
        if (!subtableId) { this.extractAndRender(this.currentTab); return; }
        const entry = window.__subtableRegistry.get(subtableId);
        if (!entry || !Array.isArray(entry.array)) {
            this.extractAndRender(this.currentTab);
            return;
        }
        const parentPath = entry.pathContext || '';
        const stripKey = absColId.startsWith(parentPath + '.')
            ? absColId.slice(parentPath.length + 1).split('.')[0]
            : absColId.split('.').pop();
        if (entry.sortState && entry.sortState.column === stripKey) {
            entry.sortState = null;
        }
        const host = document.getElementById(subtableId);
        if (host) {
            host.innerHTML = renderObjectArrayAsTable(entry.array, entry.depth || 0, parentPath, subtableId);
        }
    }

    // Sort a sub-table in place. Toggles asc/desc on the same column,
    // sorts the registered array, and replaces the sub-table HTML —
    // the outer expand-cell stays visible and the scroll position
    // inside the sub-table is reset (browser default behaviour).
    sortSubTable(subtableId, columnKey) {
        if (!subtableId || !columnKey) return;
        const entry = window.__subtableRegistry.get(subtableId);
        if (!entry || !Array.isArray(entry.array)) return;
        const cur = entry.sortState;
        const dir = (cur && cur.column === columnKey && cur.dir === 'asc') ? 'desc' : 'asc';
        entry.sortState = { column: columnKey, dir };
        entry.array.sort((a, b) => {
            const av = (a == null) ? undefined : a[columnKey];
            const bv = (b == null) ? undefined : b[columnKey];
            if (av === bv) return 0;
            if (av === undefined || av === null) return dir === 'asc' ? -1 : 1;
            if (bv === undefined || bv === null) return dir === 'asc' ? 1 : -1;
            if (typeof av === 'number' && typeof bv === 'number') {
                return dir === 'asc' ? av - bv : bv - av;
            }
            const r = String(av).localeCompare(String(bv));
            return dir === 'asc' ? r : -r;
        });
        const host = document.getElementById(subtableId);
        if (host) {
            host.innerHTML = renderObjectArrayAsTable(entry.array, entry.depth || 0, entry.pathContext || '', subtableId);
        }
    }

    // Generic wrapper-prune helper that operates on any view (not just
    // the editor's pending view). Recursively removes nested wrappers
    // whose children arrays are now empty.
    pruneEmptyWrappersOn(view) {
        if (!view) return;
        const prune = (cols) => {
            const out = [];
            for (const c of cols || []) {
                if (c && c.source === 'nested') {
                    c.children = prune(c.children || []);
                    if (c.children.length === 0) continue;
                }
                out.push(c);
            }
            return out;
        };
        view.columns = prune(view.columns || []);
    }


    updateStats(rowCount, columnCount) {
        this.currentRowCount = rowCount;
        this.currentColumnCount = columnCount;
        document.getElementById('column-count').textContent = `${columnCount} columns`;
        // Issue #262: when a search filter is active, updateSearchResults
        // owns the row-count text ("X of Y rows"). Don't clobber it here.
        if (this.currentFilteredRowCount === null || this.currentFilteredRowCount === undefined) {
            document.getElementById('row-count').textContent = `${rowCount} rows`;
        }
        // Issue #250: clear by default; the response-render path
        // resets it via updateEmptyRowBasisWarning after counting.
        this.updateEmptyRowBasisWarning(0, 0, null);
    }

    // Issue #250: footer chip flagging responses that have no rows at
    // the current rowBasis. Hidden when emptyCount === 0 or rowBasis
    // is 'root' (root always yields one row per response).
    // Issue #250: surfaces an empty-row-basis warning in the same
    // standard notification slot as Pause / batch-failure. Tagged with
    // source='rowbasis' so a follow-up clear only nukes our own message.
    updateEmptyRowBasisWarning(emptyCount, totalCount, rowBasis) {
        if (!emptyCount || !rowBasis || rowBasis === 'root') {
            clearFooterNotification('rowbasis');
            return;
        }
        const message = `${emptyCount} of ${totalCount} response${totalCount === 1 ? '' : 's'} had no rows at ${rowBasis} — ancestor columns still shown with blank detail cells`;
        showFooterNotification('warning', message, { persistent: true, source: 'rowbasis' });
    }

    // GitHub Issue #200: Get effective row count (filtered if search active, total otherwise)
    getEffectiveRowCount() {
        return this.currentFilteredRowCount !== null ? this.currentFilteredRowCount : (this.currentRowCount || 0);
    }

    // GitHub Issue #200: Disable copy options that exceed safe row limits
    updateCopyDropdownLimits() {
        const COPY_LIMITS = { html: 1000, tsv: 1000, markdown: 1000, csv: 10000 };
        const rows = this.getEffectiveRowCount();
        const dropdown = document.getElementById('copy-dropdown');

        dropdown.querySelectorAll('.export-option').forEach(option => {
            const format = option.dataset.format;
            const limit = COPY_LIMITS[format];
            if (limit && rows > limit) {
                option.disabled = true;
                option.classList.add('limit-exceeded');
                option.title = `Limit: ${limit.toLocaleString()} rows (current: ${rows.toLocaleString()})`;
                let subtitle = option.querySelector('.limit-note');
                if (!subtitle) {
                    subtitle = document.createElement('span');
                    subtitle.className = 'limit-note';
                    option.appendChild(subtitle);
                }
                subtitle.textContent = `Max ${limit.toLocaleString()} rows`;
            } else {
                option.disabled = false;
                option.classList.remove('limit-exceeded');
                option.title = '';
                const subtitle = option.querySelector('.limit-note');
                if (subtitle) subtitle.remove();
            }
        });
    }

    // GitHub Issue #200: Disable Excel export when cell count exceeds safe limit
    updateExportDropdownLimits() {
        const EXCEL_CELL_LIMIT = 2_000_000;
        const rows = this.getEffectiveRowCount();
        const cols = this.currentColumnCount || 0;
        const cellCount = rows * cols;
        const dropdown = document.getElementById('export-dropdown');

        dropdown.querySelectorAll('.export-option').forEach(option => {
            const format = option.dataset.format;
            if (format === 'excel' && cellCount > EXCEL_CELL_LIMIT) {
                option.disabled = true;
                option.classList.add('limit-exceeded');
                option.title = `Limit: ${EXCEL_CELL_LIMIT.toLocaleString()} cells (current: ${cellCount.toLocaleString()})`;
                let subtitle = option.querySelector('.limit-note');
                if (!subtitle) {
                    subtitle = document.createElement('span');
                    subtitle.className = 'limit-note';
                    option.appendChild(subtitle);
                }
                subtitle.textContent = `Max 2M cells (${cellCount.toLocaleString()})`;
            } else {
                option.disabled = false;
                option.classList.remove('limit-exceeded');
                option.title = '';
                const subtitle = option.querySelector('.limit-note');
                if (subtitle) subtitle.remove();
            }
        });
    }

    showEmptyState(message) {
        document.getElementById('empty-state').classList.remove('hidden');
        document.getElementById('table-container').classList.add('hidden');
        document.getElementById('empty-state').querySelector('p').textContent = message;
    }

    // NEW: Render Logs tab content (DynamicReportManager version) - GitHub Issue #94
    renderLogsTab() {
        if (this.rawData?.logContent && this.rawData.logContent.length > 0) {
        }

        // Hide root path selector - not needed for log content
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'none';
        }

        // Get table container
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        tableContainer.classList.remove('hidden');

        // Hide the existing table instead of destroying it
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'none';
        }

        // Remove only our custom elements (not the data table)
        const existingCodeContainer = tableContainer.querySelector('.code-container');
        if (existingCodeContainer) {
            existingCodeContainer.remove();
        }
        const existingLogsContainer = tableContainer.querySelector('.logs-container');
        if (existingLogsContainer) {
            existingLogsContainer.remove();
        }
        const existingEmptyState = tableContainer.querySelector('.empty-state');
        if (existingEmptyState) {
            existingEmptyState.remove();
        }

        // GitHub Issue #94: Check if logs need to be loaded lazily
      

        if (!this.rawData?.logContent || this.rawData.logContent.length === 0) {

            // Remove any existing loading indicators first (avoid duplicates)
            const existingLoading = tableContainer.querySelector('.logs-loading');
            if (existingLoading) {
                existingLoading.remove();
            }

            // Show loading state
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'logs-loading';
            loadingDiv.style.textAlign = 'center';
            loadingDiv.style.padding = '40px';
            loadingDiv.style.color = 'var(--vscode-descriptionForeground)';
            loadingDiv.innerHTML = '<p>' + window.Icons.label('loader', 'Loading logs...') + '</p>';
            tableContainer.appendChild(loadingDiv);

            // Trigger lazy loading (only if not already loading)
            if (!this.logsLoadingInProgress) {
                this.logsLoadingInProgress = true;
                // executionId works for both batch and individual transactions
                this.loadLogsProgressively(this.rawData?.metadata?.executionId);
            } 
            return;
        } 

        // GitHub Issue #94: Set up virtual scrolling for large log files
        this.setupLogsVirtualScroll(tableContainer);
    }

    renderRequestTab() {
        // Hide root path selector - not needed for request content
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'none';
        }

        // Get table container
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        tableContainer.classList.remove('hidden');

        // Hide the existing table instead of destroying it
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'none';
        }

        // Remove only our custom elements (not the data table)
        const existingCodeContainer = tableContainer.querySelector('.code-container');
        if (existingCodeContainer) {
            existingCodeContainer.remove();
        }
        const existingLogsContainer = tableContainer.querySelector('.logs-container');
        if (existingLogsContainer) {
            existingLogsContainer.remove();
        }
        const existingEmptyState = tableContainer.querySelector('.empty-state');
        if (existingEmptyState) {
            existingEmptyState.remove();
        }

        // Check if we have any data to display (use this.rawData for DynamicReportManager)
        const hasHeaders = this.rawData?.requestHeaders && Object.keys(this.rawData.requestHeaders).length > 0;
        const hasParams = this.rawData?.requestQueryParams && Object.keys(this.rawData.requestQueryParams).length > 0;
        const hasBody = this.rawData?.requestContent && this.rawData.requestContent.trim() !== '{}' && this.rawData.requestContent.trim() !== '';

        if (!hasHeaders && !hasParams && !hasBody) {
            // Show empty state
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-state';
            emptyDiv.innerHTML = '<p>No request data available</p>';
            tableContainer.appendChild(emptyDiv);
            return;
        }

        // Create container
        const codeContainer = document.createElement('div');
        codeContainer.className = 'code-container';
        codeContainer.style.padding = '20px';
        codeContainer.style.height = '100%';
        codeContainer.style.overflow = 'auto';

        let contentHtml = '';

        // REQUEST HEADERS section
        if (hasHeaders) {
            contentHtml += '<div style="margin-bottom: 30px;">';
            contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">REQUEST HEADERS</div>';
            contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';
            contentHtml += '<div style="font-family: var(--vscode-editor-font-family); font-size: 13px;">';

            for (const [key, value] of Object.entries(this.rawData.requestHeaders)) {
                // Truncate long values (like tokens) but show full value in title
                const displayValue = value.length > 80 ? value.substring(0, 80) + '...' : value;
                contentHtml += `<div style="margin-bottom: 6px;" title="${this.escapeHtml(value)}">`;
                contentHtml += `<span style="color: var(--vscode-symbolIcon-keyForeground);">${this.escapeHtml(key)}</span>: `;
                contentHtml += `<span style="color: var(--vscode-editor-foreground);">${this.escapeHtml(displayValue)}</span>`;
                contentHtml += '</div>';
            }

            contentHtml += '</div></div>';
        }

        // QUERY PARAMETERS section
        if (hasParams) {
            contentHtml += '<div style="margin-bottom: 30px;">';
            contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">QUERY PARAMETERS</div>';
            contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';
            contentHtml += '<div style="font-family: var(--vscode-editor-font-family); font-size: 13px;">';

            for (const [key, value] of Object.entries(this.rawData.requestQueryParams)) {
                contentHtml += `<div style="margin-bottom: 6px;">`;
                contentHtml += `<span style="color: var(--vscode-symbolIcon-keyForeground);">${this.escapeHtml(key)}</span>: `;
                contentHtml += `<span style="color: var(--vscode-editor-foreground);">${this.escapeHtml(value)}</span>`;
                contentHtml += '</div>';
            }

            contentHtml += '</div></div>';
        }

        // REQUEST BODY section
        contentHtml += '<div style="margin-bottom: 20px;">';
        contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">REQUEST BODY</div>';
        contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';

        if (hasBody) {
            contentHtml += '<pre class="json-preview-pre" style="margin: 0;">' + this.escapeHtml(this.rawData.requestContent) + '</pre>';
        } else {
            // Check if this is a batch execution
            const isBatch = this.rawData?.metadata?.batchId;
            if (isBatch) {
                contentHtml += '<div style="color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 0;">Individual request bodies generated from CSV data.<br>See the Input tab to view the source CSV file.</div>';
            } else {
                contentHtml += '<div style="color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 0;">(No request body)</div>';
            }
        }

        contentHtml += '</div>';

        codeContainer.innerHTML = contentHtml;
        tableContainer.appendChild(codeContainer);
    }

    // Helper method to escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // GitHub Issue #94: Setup virtual scrolling for logs tab (streaming-aware)
    setupLogsVirtualScroll(tableContainer) {

        const LINE_HEIGHT = 24; // Height of each log line in pixels
        const BUFFER_SIZE = 100; // Number of visible lines to render

        // Remove existing logs container if present
        const existingContainer = tableContainer.querySelector('.logs-container');
        if (existingContainer) existingContainer.remove();

        // Create virtual scroll container
        const logsContainer = document.createElement('div');
        logsContainer.className = 'logs-container';
        // CRITICAL: Set explicit styles for virtual scroll container
        logsContainer.style.position = 'relative';
        logsContainer.style.height = '100%';
        logsContainer.style.overflow = 'auto';
        logsContainer.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
        logsContainer.style.fontSize = '13px';
        
        // Fix double scroll: Hide overflow on parent table-container
        tableContainer.style.overflow = 'hidden';

        // Create spacer to simulate full content height
        const spacer = document.createElement('div');
        spacer.className = 'logs-spacer';
        spacer.style.height = `${this.rawData.logContent.length * LINE_HEIGHT}px`;
        logsContainer.appendChild(spacer);

        // Create viewport for visible content
        const viewport = document.createElement('div');
        viewport.className = 'logs-viewport';
        viewport.style.position = 'absolute';
        viewport.style.top = '0';
        viewport.style.left = '0';
        viewport.style.right = '0';
        viewport.style.padding = '0 20px';
        logsContainer.appendChild(viewport);

        // Render function - only renders visible portion
        const renderVisibleLogs = () => {
            const scrollTop = logsContainer.scrollTop;
            const startIndex = Math.floor(scrollTop / LINE_HEIGHT);
            const endIndex = Math.min(startIndex + BUFFER_SIZE, this.rawData.logContent.length);

            viewport.innerHTML = '';
            viewport.style.transform = `translateY(${startIndex * LINE_HEIGHT}px)`;

            for (let i = startIndex; i < endIndex; i++) {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'log-line';
                lineDiv.style.height = `${LINE_HEIGHT}px`;
                lineDiv.style.lineHeight = `${LINE_HEIGHT}px`;
                lineDiv.style.whiteSpace = 'pre';
                lineDiv.textContent = this.rawData.logContent[i];
                viewport.appendChild(lineDiv);
            }
        };

        // Store update function for streaming chunks
        this.updateLogsVirtualScroll = () => {
            // Update spacer height to match new content length
            spacer.style.height = `${this.rawData.logContent.length * LINE_HEIGHT}px`;
            // Re-render visible portion in case user is scrolled down
            renderVisibleLogs();
            // Update stats
            this.updateStats(this.rawData.logContent.length, 1);
        };

        // Initial render
        renderVisibleLogs();

        // Store logsContainer reference for auto-scroll
        this.logsContainer = logsContainer;

        // Re-render on scroll with auto-scroll pause/resume detection
        logsContainer.addEventListener('scroll', () => {
            requestAnimationFrame(renderVisibleLogs);

            // Check if user has scrolled away from bottom
            const isAtBottom = logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 50;

            if (!isAtBottom && this.autoScrollEnabled) {
                // User scrolled up - pause auto-scroll
                this.autoScrollEnabled = false;
            } else if (isAtBottom && !this.autoScrollEnabled) {
                // User scrolled back to bottom - resume auto-scroll
                this.autoScrollEnabled = true;
            }
        });

        tableContainer.appendChild(logsContainer);
        this.updateStats(this.rawData.logContent.length, 1);
    }

    // GitHub Issue #94: Load logs progressively from backend
    loadLogsProgressively(batchId) {

        if (!batchId) {
            console.error('[ResponseData] No batchId/executionId provided - cannot load logs');
            return;
        }


        const message = {
            type: 'console.load_logs',
            correlationId: `load_logs_${Date.now()}`,
            timestamp: Date.now(),
            target: 'extension',
            payload: {
                batchId: batchId,
                progressiveLoad: true
            }
        };

        vscode.postMessage(message);
    }

    /**
     * GitHub Issue #166: Centralized tab content cleanup
     * Removes ALL tab-specific content containers from the DOM.
     * Call this at the START of any tab switch to ensure clean state.
     */
    cleanupAllTabContent() {
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        // Remove non-cacheable tab containers
        ['.logs-container', '.code-container', '.logs-loading', '.empty-state'].forEach(selector => {
            const element = tableContainer.querySelector(selector);
            if (element) {
                element.remove();
            }
        });

        // HIDE (not remove) RAW tab container for caching — instant tab switch back
        const rawContainer = tableContainer.querySelector('.raw-tab-container');
        if (rawContainer) {
            rawContainer.style.display = 'none';
            // Disconnect Monaco observer to save resources while hidden
            if (this.rawTabHandler?.editorObserver) {
                this.rawTabHandler.editorObserver.disconnect();
            }
        }

        // Hide the data table by default (will be shown by data tabs)
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'none';
        }
    }

    // Helper method to restore table structure when switching to data tabs
    restoreTableStructure() {
        // First, clean up all tab content
        this.cleanupAllTabContent();

        // Show the data table for data tabs
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'table';
        }

        // Show toolbar for data tabs
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'flex';
        }
    }


    exportCurrentTab(format, excelSafe = false) {
        if (!this.currentTab || !this.rawData) {
            vscode.postMessage({
                type: 'show_error',
                payload: { message: 'Report data not loaded yet. Please wait for execution to complete or refresh the report.' }
            });
            return;
        }

        // GitHub Issue #152: Disable export during running - data is out of sync between webview and backend
        const currentStatus = window.currentExecutionStatus;
        if (currentStatus === 'running' || currentStatus === 'executing' || currentStatus === 'processing' || currentStatus === 'preparing') {
            // Input tab can still be exported (reads from CSV file, not streamed data)
            if (this.currentTab !== 'input') {
                vscode.postMessage({
                    type: 'show_error',
                    payload: { message: 'Export for COMPLETED/ERROR is only available after batch completion. Input tab can still be exported.' }
                });
                return;
            }
        }

        const currentPath = this.getCurrentPath(this.currentTab) || 'root';

        // Save settings before export so backend has current path + visible columns
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            saveConsoleSettings();
        }

        // GitHub Issue #155: Send visible column IDs directly with export request
        // This ensures export uses EXACTLY what user sees, avoiding frontend/backend column ID mismatches
        const visibleColumns = this.getVisibleColumns(this.currentTab);
        const visibleColumnIds = Object.keys(visibleColumns).filter(id => visibleColumns[id] === true);

        // GitHub Issue #200: Send currentPath directly to avoid settings save race condition
        const exportCurrentPath = this.getCurrentPath(this.currentTab) || 'root';

        // GitHub Issue #200: Show immediate processing feedback
        const exportFormatNames = { 'csv': 'CSV', 'excel': 'Excel', 'json': 'JSON', 'sql': 'SQL' };
        const exportLabel = exportFormatNames[format] || format.toUpperCase();
        showFooterNotification('info', `Preparing ${exportLabel} export...`, { persistent: true });

        // Get active search term so backend can filter exported rows
        const searchInput = document.getElementById('search-input');
        const activeSearchTerm = searchInput ? searchInput.value.trim() : '';

        // Backend re-extraction: backend uses saved settings for current path
        // Eliminates 8MB+ message size limit
        // Note: Overlay will be shown AFTER user confirms save dialog (on export_started message)
        // Issue #229: send the active view directly so export works
        // even when endpoint persistence is unavailable.
        const activeViewForExport = this.getActiveView(this.currentTab);
        const exportViewPayload = activeViewForExport ? JSON.parse(JSON.stringify(activeViewForExport)) : null;

        const exportMessage = {
            type: 'console.export_data',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                format: format,
                tab: this.currentTab,
                // GitHub Issue #155: Include visible column IDs (null = all columns)
                visibleColumnIds: visibleColumnIds.length > 0 ? visibleColumnIds : null,
                // GitHub Issue #200: Include current root path directly
                currentPath: exportCurrentPath,
                // Filter-aware export: only export rows matching the active search
                searchTerm: activeSearchTerm || undefined,
                // Issue #304: Input rows filtered by transaction status
                inputStatusFilter: this.currentTab === 'input' ? (this.inputStatusFilter || 'all') : undefined,
                // Issue #229: Active view spec
                view: exportViewPayload,
                options: {
                    fileName: `report_${format}_${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19)}`,
                    // GitHub Issue #225: Prefix string cells with ' for Excel type preservation
                    excelSafeStrings: excelSafe
                }
            }
        };
        vscode.postMessage(exportMessage);

    }

    /**
     * Export current tab data to clipboard (multiple formats)
     * GitHub Issue #120: Add capability to copy CSV to clipboard
     * GitHub Issue #174: Support TSV, HTML, Markdown clipboard formats
     * @param {string} format - Clipboard format: 'csv', 'tsv', 'html', 'markdown'
     */
    exportToClipboard(format = 'csv', excelSafe = false) {
        if (!this.currentTab || !this.rawData) {
            vscode.postMessage({
                type: 'show_error',
                payload: { message: 'Report data not loaded yet. Please wait for execution to complete or refresh the report.' }
            });
            return;
        }

        // GitHub Issue #152: Disable export during running - data is out of sync between webview and backend
        const currentStatus = window.currentExecutionStatus;
        if (currentStatus === 'running' || currentStatus === 'executing' || currentStatus === 'processing' || currentStatus === 'preparing') {
            // Input tab can still be exported (reads from CSV file, not streamed data)
            if (this.currentTab !== 'input') {
                vscode.postMessage({
                    type: 'show_error',
                    payload: { message: 'Export for COMPLETED/ERROR is only available after batch completion. Input tab can still be exported.' }
                });
                return;
            }
        }

        // Save settings before export so backend has current path + visible columns
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            saveConsoleSettings();
        }

        // GitHub Issue #155: Send visible column IDs directly with export request
        const visibleColumns = this.getVisibleColumns(this.currentTab);
        const visibleColumnIds = Object.keys(visibleColumns).filter(id => visibleColumns[id] === true);

        // GitHub Issue #200: Send currentPath directly to avoid settings save race condition
        const currentPath = this.getCurrentPath(this.currentTab) || 'root';

        // GitHub Issue #200: Show immediate processing feedback
        const formatNames = { 'csv': 'CSV', 'tsv': 'Excel', 'html': 'Table', 'markdown': 'Markdown' };
        const formatLabel = formatNames[format] || format.toUpperCase();
        showFooterNotification('info', `Copying ${formatLabel} to clipboard...`, { persistent: true });

        // Get active search term so backend can filter exported rows
        const searchInput = document.getElementById('search-input');
        const activeSearchTerm = searchInput ? searchInput.value.trim() : '';

        // Issue #229: send the active view directly so export works
        // even if endpoint persistence is unavailable (old executions
        // whose endpoint was deleted/renamed).
        const activeView = this.getActiveView(this.currentTab);
        const viewPayload = activeView ? JSON.parse(JSON.stringify(activeView)) : null;

        // Send message to backend to generate clipboard content
        const clipboardMessage = {
            type: 'console.export_to_clipboard',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                tab: this.currentTab,
                format: format,  // GitHub Issue #174: Include format in request
                // GitHub Issue #155: Include visible column IDs (null = all columns)
                visibleColumnIds: visibleColumnIds.length > 0 ? visibleColumnIds : null,
                // GitHub Issue #200: Include current root path directly
                currentPath: currentPath,
                // Filter-aware export: only export rows matching the active search
                searchTerm: activeSearchTerm || undefined,
                // Issue #304: Input rows filtered by transaction status
                inputStatusFilter: this.currentTab === 'input' ? (this.inputStatusFilter || 'all') : undefined,
                // Issue #229: Active view spec (rowBasis + columns)
                view: viewPayload,
                options: {
                    includeHeaders: true,
                    delimiter: ',',
                    quoteChar: '"',
                    // GitHub Issue #225: Prefix string cells with ' for Excel type preservation
                    excelSafeStrings: excelSafe
                }
            }
        };

        vscode.postMessage(clipboardMessage);
    }

    startLogStreaming() {
        if (!this.rawData) return;
        vscode.postMessage({
            type: 'console.start_log_stream',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionId: this.rawData.metadata?.executionId || 'unknown',
                batchId: this.rawData.metadata?.batchId
            }
        });
    }

    stopLogStreaming() {
        if (!this.rawData) return;
        vscode.postMessage({
            type: 'console.stop_log_stream',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionId: this.rawData.metadata?.executionId || 'unknown',
                batchId: this.rawData.metadata?.batchId
            }
        });
    }

    handleLogStreamUpdate(content, isComplete = false) {
        if (this.currentTab !== 'logs') return;
        if (!this.rawData.logContent) this.rawData.logContent = [];
        const isFirstLogEvent = this.rawData.logContent.length === 0;
        const newLines = content.split('\n').filter(line => line.trim());
        this.rawData.logContent.push(...newLines);
        this.rawData.isStreaming = !isComplete;
        if (isFirstLogEvent) {
            const tableContainer = document.getElementById('table-container');
            if (tableContainer) {
                const loadingDiv = tableContainer.querySelector('.logs-loading');
                if (loadingDiv) loadingDiv.remove();
                this.setupLogsVirtualScroll(tableContainer);
            }
        } else if (this.updateLogsVirtualScroll) {
            this.updateLogsVirtualScroll();
        }
        if (this.autoScrollEnabled && this.logsContainer) {
            this.logsContainer.scrollTop = this.logsContainer.scrollHeight;
        }
    }

    /**
     * Handle batch member status updates (e.g. pending → running)
     * Creates stubs for new members or updates existing stubs in-place
     */
    handleMemberStatusUpdate(payload) {
        if (!this.rawData) return;
        const { executionIds, status, memberIndices, memberEndpointInfo } = payload;

        for (const execId of executionIds) {
            const memberIndex = memberIndices?.[execId];
            // O(1) lookup — and only trusted if that row really is this execution's
            const existingIndex = ConsoleLiveCounts.resolveIndex(this._responseIndexMap, this.rawData.responses, execId);

            if (existingIndex >= 0) {
                // Decrement live counter for old classification before changing status
                const oldClassification = this._getResultClassification(this.rawData.responses[existingIndex]);
                if (oldClassification === 'success') this._liveSuccessCount = Math.max(0, this._liveSuccessCount - 1);
                else if (oldClassification === 'errors') this._liveErrorCount = Math.max(0, this._liveErrorCount - 1);

                // Update existing stub's status (pending → running, or error → pending for retry)
                this.rawData.responses[existingIndex].status = status;
                if (this.rawData.responses[existingIndex].metadata) {
                    this.rawData.responses[existingIndex].metadata.status = status;
                    if (memberIndex !== undefined) {
                        this.rawData.responses[existingIndex].metadata.memberIndex = memberIndex;
                    }
                }
            } else {
                // Create new stub (member created after Console opened)
                const newIndex = this.rawData.responses.length;
                this.rawData.responses.push({
                    httpStatus: '-',
                    status: status,
                    data: null,
                    metadata: {
                        executionId: execId,
                        status: status,
                        memberIndex: memberIndex,
                        timestamp: new Date().toISOString()
                    }
                });
                // Keep index map in sync so handleMemberResultUpdate finds this stub
                if (execId !== undefined) {
                    this._responseIndexMap.set(execId, newIndex);
                }
            }

            // Store per-member endpoint info for RAW tab Details display
            if (memberEndpointInfo && memberEndpointInfo[execId] && this.rawTabHandler) {
                this.rawTabHandler.execIdToEndpointInfo.set(execId, memberEndpointInfo[execId]);
            }
        }

        // Update tab counts (live counters may have changed from retry status changes)
        this.updateTabCountWithAnimation('success', this._liveSuccessCount);
        this.updateTabCountWithAnimation('errors', this._liveErrorCount);
        const rawCountEl = document.querySelector('.tab-count[data-tab="raw"]');
        if (rawCountEl) {
            rawCountEl.textContent = this.rawData.responses.length;
        }

        // Refresh error/success tab if active (member was removed from classification).
        // Issue #312: debounced like a result — this used to redraw the whole table
        // on EVERY pending→running change, undebounced; with 8 threads on a 14,000
        // row table that was a stall every few hundred milliseconds.
        if (this.currentTab === 'errors' || this.currentTab === 'success') {
            this._lastClassified = null;
            this.scheduleLiveRender();
        }

        // Refresh RAW tab if active (Issue #312: only these members' cards)
        if (this.currentTab === 'raw' && this.rawTabHandler) {
            (payload.executionIds || []).forEach(id => this.rawTabHandler.handleNewResult(id));
        }
        // Issue #296: an open transaction modal follows its result
        this.rawTabHandler?.refreshModal();
        // Issue #304: input rows take their transaction's new status
        this.refreshInputStatuses();
    }

    /**
     * Handle batch member result updates (live streaming)
     */
    handleMemberResultUpdate(payload) {
        if (!this.rawData) {
            return;
        }

        // GitHub Issue #166: Set status from classification for RAW tab
        // classification is 'success' or 'errors' - map to 'completed' or 'error'
        if (!payload.result.status) {
            payload.result.status = payload.classification === 'success' ? 'completed' : 'error';
        }
        // Also set in metadata for consistency
        if (payload.result.metadata && !payload.result.metadata.status) {
            payload.result.metadata.status = payload.result.status;
        }
        // Store batch member index for correct transaction numbering
        if (payload.memberIndex !== undefined && payload.result.metadata) {
            payload.result.metadata.memberIndex = payload.memberIndex;
        }

        // GitHub Issue #102: Replace if exists (retry update), add if new
        const executionId = payload.result.metadata?.executionId;
        const existingIndex = ConsoleLiveCounts.resolveIndex(this._responseIndexMap, this.rawData.responses, executionId);

        // Update live running counters before mutating array (O(1) per result)
        if (existingIndex >= 0) {
            // Retry: decrement old classification before counting new one
            const oldClassification = this._getResultClassification(this.rawData.responses[existingIndex]);
            if (oldClassification === 'success') this._liveSuccessCount--;
            else if (oldClassification === 'errors') this._liveErrorCount--;
        }
        if (payload.classification === 'success') this._liveSuccessCount++;
        else if (payload.classification === 'errors') this._liveErrorCount++;

        // One-shot auto-switch to the result tab when the first
        // completion lands AND the user is still on the default
        // landing tab (raw / input). Subsequent results don't
        // bounce the user around — if they've navigated elsewhere
        // (settings, info), respect that.
        if (!this._autoSwitchedOnFirstResult
            && (this.currentTab === 'raw' || this.currentTab === 'input')) {
            const target = payload.classification === 'success' ? 'success' : 'errors';
            // Defer one tick so the tabs created/updated below exist
            // before switchTab() tries to activate one.
            setTimeout(() => {
                if (document.querySelector(`.tab-item[data-tab="${target}"]`)) {
                    this.switchTab(target);
                }
            }, 0);
            this._autoSwitchedOnFirstResult = true;
        }

        if (existingIndex >= 0) {
            // REPLACE - this is a retry update (e.g., 401 → 200)
            this.rawData.responses[existingIndex] = payload.result;
        } else {
            // ADD - this is a new transaction
            const newIndex = this.rawData.responses.length;
            this.rawData.responses.push(payload.result);
            if (executionId !== undefined) {
                this._responseIndexMap.set(executionId, newIndex);
            }
        }

        // Sync reprocessCount to transactionSummaries so RAW tab retry button reads correct count
        if (executionId && payload.result.metadata?.reprocessCount !== undefined && this.rawTabHandler) {
            const summary = this.rawTabHandler.transactionSummaries.find(s => s.executionId === executionId);
            if (summary) {
                summary.reprocessCount = payload.result.metadata.reprocessCount;
            }
        }

        // Check if COMPLETED/ERROR tabs exist - if not, create them now (first result arrived)
        const successTab = document.querySelector('.tab-item[data-tab="success"]');
        const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');

        if (!successTab || !errorsTab) {
            // First result arrived - need full classify to create tabs
            const classified = this.classifyResponses(this.rawData.responses);
            this._lastClassified = classified;
            this.createDynamicTabs(classified, this.rawData);

            // Reactivate current tab after recreating tabs
            const currentTabElement = document.querySelector(`.tab-item[data-tab="${this.currentTab}"]`);
            if (currentTabElement) {
                currentTabElement.classList.add('active');
            }
        } else {
            // Tabs already exist - update counts from live counters (cheap)
            this.updateTabCountWithAnimation('success', this._liveSuccessCount);
            this.updateTabCountWithAnimation('errors', this._liveErrorCount);
            this.updateTabCountWithAnimation('raw', this.rawData.responses.length);

            // Show/hide errors tab based on count
            if (this._liveErrorCount > 0) {
                errorsTab.style.display = '';
            }

            // The cached classification no longer includes this result. Drop it, so
            // whoever reads next (the auto-switch above, a tab click, the views
            // dropdown, search) classifies afresh — every reader falls back to
            // classifyResponses() when the cache is null. This used to be refreshed
            // on a one-second timer instead, and the auto-switch to Completed fired
            // inside that second: a batch of one (a paginated Run API) opened its
            // Completed tab on "No data available" with the count already at 1, until
            // the user clicked away and back.
            this._lastClassified = null;
        }

        // GitHub Issue #102: Update transaction count with live results
        const totalCompleted = this._liveSuccessCount + this._liveErrorCount;
        this.updateTransactionCount(totalCompleted);

        // Update progress bar in real-time (GitHub Issue #104)
        // Progress updates on EVERY transaction (fast like tab counts)
        // ETA updates come separately from timer (slow, stable, once per minute)
        if (payload.totalMembers) {
            this.paintBatchProgress(payload.totalMembers);
        }

        // If current tab matches result classification, debounce full table re-render
        // (Issue #312: keeping the scroll position — see scheduleLiveRender)
        if (this.currentTab === payload.classification) {
            this.scheduleLiveRender();
        }

        // GitHub Issue #166: Refresh RAW tab if it's currently active
        // This provides live updates showing transactions as they complete
        // (Issue #312: only this member's card)
        if (this.currentTab === 'raw' && this.rawTabHandler) {
            this.rawTabHandler.handleNewResult(executionId);
        }
        // Issue #296: an open transaction modal follows its result
        this.rawTabHandler?.refreshModal();
        // Issue #304: input rows take their transaction's new status
        this.refreshInputStatuses();
    }

    /**
     * Determine classification of a result for live counter adjustment (retries).
     * Mirrors the logic used by classifyResponses/tableBuilder.
     */
    _getResultClassification(result) {
        return ConsoleLiveCounts.classifyResult(result);
    }

    /**
     * Take a rebuilt set of derived state from ConsoleLiveCounts (seed / clearErrors).
     * The position map, both tallies and the cached classification always change
     * TOGETHER — setting one without the others is what left the Error tab saying 64
     * over an empty table during a retry.
     */
    applyLiveCounts(state) {
        this._responseIndexMap = state.indexMap;
        this._liveSuccessCount = state.liveSuccess;
        this._liveErrorCount = state.liveErrors;
        this._lastClassified = state.classified;
    }

    /**
     * Issue #311: the bottom progress count/bar, painted from the SAME
     * tallies as the Completed / Error tabs. It used to come from two
     * sources — these tallies on each member result, and the backend's
     * own count on each status update — and the two disagreed after a
     * resume (members cancelled in flight, errors reset to pending), so
     * the bar jumped about while the tabs were right. `total` is
     * remembered so a tally change with no total to hand (clearing the
     * errors for a retry) can repaint too.
     */
    paintBatchProgress(total) {
        if (total) this._progressTotal = total;
        total = this._progressTotal;
        if (!total) return;
        if (window.progressHandler && window.progressHandler.loading) return; // Issue #312: the bar shows the load
        const completed = this._liveSuccessCount + this._liveErrorCount;
        const box = window.ConsoleProgress;
        if (!box) return;
        box.count(`${completed}/${total}`);
        box.fill(Math.round((completed / total) * 100));
        // Keep the run's state (running, paused…). #436: but not a page's download (the first page
        // of Fetch all, "Processing data", a moving bar): with more than one page the box is the
        // batch's again, and it showed that page's state for good
        if (total > 1 && /\b(processing|loading|busy)\b/.test(box.state())) {
            box.state('running');
            if (window.progressHandler) box.phase(window.progressHandler.formatPhaseText('running'));
        }
    }

    /**
     * GitHub Issue #312: a chunk of a large batch streamed in after the first
     * screen. Merge, retally, update the tab badges, and redraw the open tab
     * without losing the user's scroll position.
     */
    appendResponses(incoming) {
        if (!this.rawData || !incoming || incoming.length === 0) return;
        const merged = ConsoleLiveCounts.append(this.rawData.responses, incoming, (rows) => this.classifyResponses(rows));
        this.rawData.responses = merged.responses;
        this.applyLiveCounts(merged);
        if (this.rawData.metadata) this.rawData.metadata.totalRows = merged.responses.length;

        const successTab = document.querySelector('.tab-item[data-tab="success"]');
        const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
        if (!successTab || !errorsTab) {
            // The first chunk had no results yet — build the tabs now
            this.createDynamicTabs(merged.classified, this.rawData);
            const current = document.querySelector(`.tab-item[data-tab="${this.currentTab}"]`);
            if (current) current.classList.add('active');
        } else {
            this.updateTabCountWithAnimation('success', this._liveSuccessCount);
            this.updateTabCountWithAnimation('errors', this._liveErrorCount);
            this.updateTabCountWithAnimation('raw', merged.responses.length);
            if (this._liveErrorCount > 0) errorsTab.style.display = '';
        }
        this.updateTransactionCount(this._liveSuccessCount + this._liveErrorCount);

        this.scheduleLiveRender();
        if (this.currentTab === 'raw' && this.rawTabHandler) incoming.forEach(r => this.rawTabHandler.handleNewResult(r.metadata && r.metadata.executionId));
        this.refreshInputStatuses();
    }

    /**
     * GitHub Issue #312: a chunk of the batch's input rows streamed in. Rows arrive
     * in file order, so appending keeps every row index — and the row-status map
     * (Issue #304), which is rebuilt from the length on the next Input redraw.
     */
    appendInputRows(rows) {
        if (!this.rawData || !rows || rows.length === 0) return;
        if (!this.rawData.inputData) this.rawData.inputData = [];
        for (const row of rows) this.rawData.inputData.push(row);
        this.updateTabCountWithAnimation('input', this.rawData.inputData.length);
        if (this.currentTab === 'input') this.refreshInputStatuses();
    }

    /**
     * Redraw the open results tab once the burst of updates settles. Issue #312:
     * the redraw keeps the scroll position — it used to clear the table and
     * leave the user back at the top every time a result came in.
     */
    scheduleLiveRender() {
        if (this.currentTab !== 'success' && this.currentTab !== 'errors') return;
        if (this._renderDebounceTimer) return;
        // Issue #312: a redraw of a big table is a big job — the bigger the table, the
        // less often it redraws while results pour in (1.5 s small … 15 s at 14,000+).
        const rows = this.rawData && this.rawData.responses ? this.rawData.responses.length : 0;
        const wait = Math.min(15000, this._renderDebounceMs + Math.floor(rows / 1000) * 1000);
        this._renderDebounceTimer = setTimeout(() => {
            this._renderDebounceTimer = null;
            this.extractAndRender(this.currentTab, this.getCurrentPath(this.currentTab), { keepScroll: true });
        }, wait);
    }

    /**
     * Update tab count with animation
     */
    updateTabCountWithAnimation(tabName, newCount) {
        const tabCountElement = document.querySelector(`.tab-count[data-tab="${tabName}"]`);
        if (!tabCountElement) return;

        const oldCount = parseInt(tabCountElement.textContent) || 0;
        if (newCount === oldCount) return; // No change

        // Update count
        tabCountElement.textContent = newCount.toString();

        // Add animation class
        tabCountElement.classList.add('count-increment');

        // Remove animation class after animation completes
        setTimeout(() => {
            tabCountElement.classList.remove('count-increment');
        }, 400);
    }

}

// UNIFIED DATA RENDERING - Single function to handle ALL data types (ORIGINAL RICH FUNCTIONS RESTORED)
function renderDataAsTable(data, depth = 0, pathContext = '', rowIndex = -1) {
    // Safety check to prevent infinite recursion
    if (depth > 10) {
        return '<div class="max-depth-reached">Max nesting depth reached</div>';
    }

    // Handle null/undefined
    if (data === null || data === undefined) {
        return '<span class="null-value">—</span>';
    }

    // Handle arrays
    if (Array.isArray(data)) {
        if (data.length === 0) {
            // Issue #250: render empty arrays as a quiet inline marker
            // matching null cells, rather than a chunky centred block.
            return '<span class="empty-array">[ ]</span>';
        }

        // Check if it's an array of objects or primitives
        const firstNonNull = data.find(item => item !== null && item !== undefined);
        if (firstNonNull && typeof firstNonNull === 'object') {
            // Array of objects -> show expandable button for collapsible control
            return renderExpandableArray(data, depth, pathContext, rowIndex);
        } else {
            // Array of primitives -> auto-expand (no button needed)
            return renderSimpleArrayList(data);
        }
    }
    
    // Handle objects
    if (typeof data === 'object') {
        // Single object -> key-value table
        return renderObjectAsTable(data, depth);
    }
    
    // Primitive value - just return as string
    return String(data);
}

// Issue #229 Phase 1B.5: per-expand-cell registry so sub-tables can
// sort and delete sub-columns in place without full table re-renders.
window.__subtableRegistry = window.__subtableRegistry || new Map();

function renderObjectArrayAsTable(arrayValue, depth = 0, pathContext = '', registryId = '') {
    // Use the same sophisticated column analysis as the main table
    if (!window.dynamicReportManager || !arrayValue || arrayValue.length === 0) {
        // Issue #250: keep the empty marker consistent with renderDataAsTable.
        return '<span class="empty-array">[ ]</span>';
    }

    // FIX issue#100: Limit inline expansion to prevent browser freeze
    const MAX_INLINE_ROWS = 100;
    const isLimited = arrayValue.length > MAX_INLINE_ROWS;
    const rowsToRender = isLimited ? arrayValue.slice(0, MAX_INLINE_ROWS) : arrayValue;

    // Infer columns using the same logic as the main table
    const columnMap = new Map();
    const sampleSize = Math.min(rowsToRender.length, 10);

    for (let i = 0; i < sampleSize; i++) {
        const item = rowsToRender[i];
        if (typeof item === 'object' && item !== null) {
            dynamicReportManager.analyzeObjectStructure(item, '', columnMap);
        }
    }

    const allColumns = dynamicReportManager.buildColumnHierarchy(columnMap);

    // GitHub Issue #228: Apply root column visibility to expanded nodes
    const visibleColumns = dynamicReportManager.getVisibleColumns(dynamicReportManager.currentTab);
    const hasVisibilitySettings = Object.keys(visibleColumns).length > 0;

    // Issue #267B: sub-row column hides live as a negative list of
    // absolute paths on the active view. The positive `visibleColumns`
    // map is keyed by absolute paths too, but column.id here is the
    // relative key inside the sub-table — so the positive lookup never
    // matches sub-row leaves. We resolve absolute paths and consult the
    // hidden list explicitly.
    const activeView = dynamicReportManager.getActiveView
        ? dynamicReportManager.getActiveView(dynamicReportManager.currentTab)
        : null;
    const hiddenSubColumns = new Set((activeView && activeView.hiddenSubColumns) || []);

    const shouldFilter = hasVisibilitySettings || hiddenSubColumns.size > 0;
    const columns = shouldFilter ? allColumns.filter(column => {
        const absId = pathContext ? `${pathContext}.${column.id}` : column.id;
        if (hiddenSubColumns.has(absId)) return false;
        if (column.type === 'group') {
            if (visibleColumns[column.id] === false) return false;
            if (column.children && column.children.length > 0) {
                return column.children.some(childId => {
                    const childAbsId = pathContext ? `${pathContext}.${childId}` : childId;
                    if (hiddenSubColumns.has(childAbsId)) return false;
                    if (visibleColumns[childId] !== undefined) return visibleColumns[childId] !== false;
                    const childCol = allColumns.find(c => c.id === childId);
                    return childCol && !childCol.defaultHidden;
                });
            }
            return true;
        }
        if (visibleColumns[column.id] !== undefined) return visibleColumns[column.id] !== false;
        return !column.defaultHidden;
    }) : allColumns;

    // Create table elements
    const table = document.createElement('table');
    table.className = 'data-table nested-data-table';

    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    // For nested tables, use simple headers to avoid column alignment issues with main table
    // Extract only data columns and create simple single-row headers
    const dataColumns = columns.filter(col => col.type !== 'group');
    const headerRow = document.createElement('tr');

    // Register this sub-table's array so sortSubTable / hideSubColumn
    // can find it by id and re-render in place.
    const entry = registryId ? (window.__subtableRegistry.get(registryId) || {}) : {};
    entry.array = arrayValue;
    entry.depth = depth;
    entry.pathContext = pathContext;
    if (!entry.sortState) entry.sortState = null;
    if (registryId) window.__subtableRegistry.set(registryId, entry);

    dataColumns.forEach(column => {
        const th = document.createElement('th');
        const absoluteChildId = pathContext ? `${pathContext}.${column.id}` : column.id;
        const safeName = (column.displayName || column.id).toString()
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const sortDirClass = (entry.sortState && entry.sortState.column === column.id)
            ? ` sort-${entry.sortState.dir}` : '';
        th.className = 'sortable-header' + sortDirClass;
        // An action in attributes, not a JS-attached handler: the table is serialized via outerHTML,
        // and attributes survive it (#372: data-click, which the CSP allows, not an inline onclick)
        if (registryId) {
            th.setAttribute('data-click', 'console:sortSubTable');
            th.setAttribute('data-arg', registryId);
            th.setAttribute('data-key', column.id);
        }
        th.innerHTML = `
            <div class="flex align-center column-header-content">
                <span class="column-name">${safeName}</span>
                <span class="header-actions">
                    <span class="sort-icon"></span>
                    <button class="column-hide-btn" data-click="console:hideSubColumn" data-arg="${consoleAttr(absoluteChildId)}" data-registry="${consoleAttr(registryId || '')}" data-stop-propagation>×</button>
                </span>
            </div>
        `;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    // Use the same row rendering logic as the main table (limited rows)
    rowsToRender.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.className = 'data-row nested-row';

        // Only render data columns (skip group headers)
        const dataColumns = columns.filter(col => col.type !== 'group');
        dataColumns.forEach(column => {
            const td = document.createElement('td');
            const value = dynamicReportManager.extractNestedValue(row, column.id);
            
            // Use the same rich rendering as main table
            if (Array.isArray(value)) {
                // Build path for nested arrays (without row index)
                const arrayPath = pathContext ? `${pathContext}.${column.id}` : column.id;
                td.innerHTML = renderDataAsTable(value, depth + 1, arrayPath);
                td.className = dynamicReportManager.getCellClass(column.type);
            } else {
                // Primitive values or flattened nested values
                td.textContent = value != null ? String(value) : '';
                td.className = dynamicReportManager.getCellClass(column.type);
            }
            
            tr.appendChild(td);
        });
        
        tbody.appendChild(tr);
    });
    
    table.appendChild(thead);
    table.appendChild(tbody);

    return table.outerHTML;
}

function renderExpandableArray(arrayValue, depth = 0, pathContext = '', rowIndex = -1) {
    // Issue #238: deterministic id (was random) so virtual-scroll
    // teardown + recreate maps to the same id, letting the manager's
    // expandedNestedIds Set restore the open state.
    const safePath = (pathContext || 'root').replace(/[^a-zA-Z0-9_-]/g, '_');
    const expandableId = `array-${rowIndex}-${depth}-${safePath}`;
    const mgr = window.dynamicReportManager;
    const isExpanded = !!(mgr && mgr.expandedNestedIds && mgr.expandedNestedIds.has(expandableId));
    const hiddenClass = isExpanded ? '' : 'hidden';
    const initialChevron = window.Icons.icon(isExpanded ? 'chevron-down' : 'chevron-right');
    const isLarge = arrayValue.length > 100;
    // Issue #238: register array data so the toggle handler can
    // lazy-render the nested table HTML only when the user expands.
    // This avoids generating thousands of hidden nested tables up front.
    if (mgr && mgr.arrayDataRegistry) {
        mgr.arrayDataRegistry.set(expandableId, { arrayValue, depth, pathContext });
    }

    // Build warning tooltip if array is large
    const warningIcon = isLarge ? `
        <span class="tooltip-icon tooltip-warning">
            ${window.Icons.icon('triangle-alert')}
            <div class="tooltip-popup">
                <div class="tooltip-title">Large Array Warning</div>
                <div class="tooltip-message">
                    This array contains <strong>${arrayValue.length.toLocaleString()}</strong> items.
                    Expanding will only show first 100 rows.
                </div>
                <div class="tooltip-footer">
                    ${window.Icons.label('lightbulb', 'Tip: Click "New View" to create a view rooted at this array.')}
                </div>
            </div>
        </span>
    ` : '';

    // Issue #229 Phase 1B.12: "Set as Row" drills into this array by
    // changing the active view's rowBasis in place (no new view).
    // Hidden when the active view is already based on this path.
    let showSetAsRow = false;
    if (pathContext && window.dynamicReportManager) {
        const activeView = window.dynamicReportManager.getActiveView(window.dynamicReportManager.currentTab);
        showSetAsRow = !!activeView && activeView.rowBasis !== pathContext;
    }
    return `
        <div class="expandable-array">
            <div class="array-controls">
                <button class="expand-toggle" data-click="console:toggleArrayExpansion" data-arg="${expandableId}">
                    <span class="expand-icon">${initialChevron}</span>
                    ${arrayValue.length.toLocaleString()} records
                </button>${warningIcon}
                ${showSetAsRow ? `<button class="set-as-root-btn" title="Set the row basis of the active view to this array" data-click="console:setRowBasisOnActiveView" data-arg="${consoleAttr(pathContext)}">Set as Row</button>` : ''}
            </div>
            <div id="${expandableId}" class="array-content ${hiddenClass}" data-stop-scroll>
                ${isExpanded ? renderObjectArrayAsTable(arrayValue, depth, pathContext, expandableId) : ''}
            </div>
        </div>
    `;
}

function renderObjectAsTable(obj, depth = 0) {
    if (!obj || typeof obj !== 'object') {
        return '<div class="empty-object">No data</div>';
    }
    
    const entries = Object.entries(obj);
    if (entries.length === 0) {
        return '<div class="empty-object">No properties</div>';
    }
    
    // Render as a 2-column table: Property | Value
    let tableHtml = '<table class="data-table object-table">';
    
    // No headers for object tables - just show key-value pairs
    
    // Data rows
    tableHtml += '<tbody>';
    entries.forEach(([key, value]) => {
        tableHtml += '<tr>';
        tableHtml += `<td class="font-bold text-link min-w-120">${key}</td>`;
        tableHtml += '<td class="break-word">';
        
        // Auto-expand all values - no buttons needed
        tableHtml += renderDataAsTable(value, depth + 1);
        
        tableHtml += '</td></tr>';
    });
    tableHtml += '</tbody></table>';
    
    return tableHtml;
}

function renderSimpleArrayList(arrayValue) {
    return arrayValue.map((item) => {
        return `<div class="simple-array-item">${String(item)}</div>`;
    }).join('');
}


// UNIFIED toggle function for all nested content
function toggleNestedExpansion(elementId) {
    const element = document.getElementById(elementId);
    const triggerRow = element.previousElementSibling;
    const toggle = triggerRow.querySelector('.expand-icon');
    const mgr = window.dynamicReportManager;

    // Issue #264 / #267A: anchor scroll position to the row being
    // toggled. Going 0↔1 expansions flips virtual-scroll windowing on
    // and off, which collapses or grows the spacer — without an anchor
    // the user's content shifts up by hundreds of pixels.
    const tableContainer = document.getElementById('table-container');
    const beforeTop = (tableContainer && triggerRow)
        ? triggerRow.getBoundingClientRect().top - tableContainer.getBoundingClientRect().top
        : null;

    if (element.classList.contains('hidden')) {
        // Issue #238: lazy-populate nested table HTML on first expand
        // (initial render only emits an empty <div>, to avoid generating
        // 1000s of hidden nested tables up front).
        if (!element.innerHTML.trim() && mgr && mgr.arrayDataRegistry) {
            const reg = mgr.arrayDataRegistry.get(elementId);
            if (reg) {
                element.innerHTML = renderObjectArrayAsTable(
                    reg.arrayValue, reg.depth, reg.pathContext, elementId
                );
            }
        }
        element.classList.remove('hidden');
        toggle.innerHTML = window.Icons.icon('chevron-down');
        // Issue #238: remember opened state so virtual-scroll teardown
        // doesn't lose it when the row leaves and re-enters the viewport.
        if (mgr && mgr.expandedNestedIds) mgr.expandedNestedIds.add(elementId);
    } else {
        element.classList.add('hidden');
        // Free the nested DOM on collapse — re-rendered on next expand
        // from the registry.
        element.innerHTML = '';
        toggle.innerHTML = window.Icons.icon('chevron-right');
        if (mgr && mgr.expandedNestedIds) mgr.expandedNestedIds.delete(elementId);
    }

    // Issue #238: nudge virtual scroll to re-evaluate windowing — going
    // 0→1 expansions triggers full render to dodge the variable-height
    // jank; back to 0 returns to normal virtual windowing.
    if (mgr && mgr.virtualScrollData && typeof mgr.updateVirtualRows === 'function') {
        mgr.lastRenderedStart = -1;
        mgr.lastRenderedEnd = -1;
        mgr.updateVirtualRows();
    }

    // Issue #267A: restore the triggerRow to its prior viewport offset.
    // Virtual-scroll re-render keeps the same trigger row in the DOM
    // (only data rows around it are swapped), so we can read its new
    // position and correct scrollTop by the delta.
    if (tableContainer && triggerRow && beforeTop !== null && triggerRow.isConnected) {
        const afterTop = triggerRow.getBoundingClientRect().top - tableContainer.getBoundingClientRect().top;
        const delta = afterTop - beforeTop;
        if (delta !== 0) {
            tableContainer.scrollTop += delta;
        }
    }
}

// Legacy functions for backwards compatibility
function toggleArrayExpansion(elementId) {
    toggleNestedExpansion(elementId);
}

function toggleObjectExpansion(elementId) {
    toggleNestedExpansion(elementId);
}

// Legacy Tab Management Class
class TabbedReportManager {
    constructor() {
        this.reportData = null;
        this.currentTab = null;
        this.tabConfigs = {
            input: { rootPath: 'root', visibleColumns: [], sortColumns: [], filters: [] },
            success: { rootPath: 'response.data', visibleColumns: [], sortColumns: [], filters: [] },
            errors: { rootPath: 'response.error', visibleColumns: [], sortColumns: [], filters: [] }
        };

        // GitHub Issue #200: Track row/column counts for export scale limits
        this.currentRowCount = 0;
        this.currentColumnCount = 0;
        this.currentFilteredRowCount = null; // null = no filter active
    }

    initialize(data) {
        
        // Validate data structure
        if (!data) {
            this.showEmptyState('No report data provided');
            return;
        }
        
        // Ensure data has at least basic structure
        if (typeof data !== 'object') {
            this.showEmptyState('Invalid report data format');
            return;
        }
        
        this.reportData = data;
        this.createTabs();
        
        // Activate first available tab (with defensive checks)
        if (data.success?.count > 0) {
            this.switchTab('success');
        } else if (data.errors?.count > 0) {
            this.switchTab('errors');
        } else if (data.input?.count > 0) {
            this.switchTab('input');
        } else {
            // No tabs available - empty state should already be shown by createTabs()
        }
    }

    createTabs() {
        // Defensive check: ensure reportData exists
        if (!this.reportData) {
            this.showEmptyState('No report data available');
            return;
        }


        const tabContainer = document.getElementById('report-tabs');
        if (!tabContainer) {
            return;
        }
        
        tabContainer.innerHTML = '';

        // Create tabs in specified order: Request → Logs → COMPLETED → ERROR

        // GitHub Issue #101: Request tab now always shown (displays headers, params, and body)
        this.addTab('request', 'Request', '');

        // NEW: Logs tab (always show, even if empty)
        this.addTab('logs', 'Logs', '');

        // Existing tabs (with defensive checks)
        // Tab labels: success → COMPLETED, errors → ERROR
        if (this.reportData.input?.count > 0) {
            this.addTab('input', 'Input', this.reportData.input.count);
        }
        if (this.reportData.success?.count > 0) {
            this.addTab('success', 'COMPLETED', this.reportData.success.count);
        }
        if (this.reportData.errors?.count > 0) {
            this.addTab('errors', 'ERROR', this.reportData.errors.count);
        }

        // GitHub Issue #156: Settings tab (always shown, last/rightmost tab)
        this.addTab('info', 'Settings', '');

        // Initialize Info tab for batch vs individual
        const isBatchReport = !!window.currentBatchId;
        initInfoTab(isBatchReport);

        // Handle case where no tabs were created
        if (tabContainer.children.length === 0) {
            this.showEmptyState('No data to display in any category');
        }
    }

    addTab(id, label, count) {
        const tabContainer = document.getElementById('report-tabs');
        const tab = document.createElement('button');
        tab.className = 'tab-item';
        tab.dataset.tab = id;
        tab.innerHTML = `
            <span class="tab-label">${label}</span>
            <span class="tab-count" data-tab="${id}">${count}</span>
        `;
        tab.onclick = () => this.switchTab(id);
        tabContainer.appendChild(tab);
    }

    switchTab(tabName) {
        // Update active tab styling
        document.querySelectorAll('.tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        this.currentTab = tabName;

        // Manage export button visibility based on tab
        const exportMenu = document.querySelector('.export-menu');
        const excelBtn = document.querySelector('.export-option[data-format="excel"]');
        const toolbar = document.getElementById('report-toolbar');
        const tableContainer = document.getElementById('table-container');
        const infoTabContent = document.getElementById('info-tab-content');

        // GitHub Issue #156: Handle Info tab
        if (tabName === 'info') {
            if (toolbar) toolbar.style.display = 'none';
            if (tableContainer) tableContainer.classList.add('hidden');
            if (infoTabContent) infoTabContent.classList.remove('hidden');
            document.getElementById('empty-state')?.classList.add('hidden');
            return;
        }

        // Hide Info tab content when switching to other tabs
        if (infoTabContent) infoTabContent.classList.add('hidden');
        if (tableContainer) tableContainer.classList.remove('hidden');

        // Hide export entirely for Request/Logs tabs (non-tabular data)
        if (tabName === 'request' || tabName === 'logs') {
            if (exportMenu) exportMenu.style.display = 'none';
        }
        // Every table tab exports CSV and Excel. Excel from the Input tab keeps its
        // Result filter on the Input sheet (Issue #304: Error → Excel is the list of
        // rows to send back; Puppy School Lesson 3 Step 12).
        else {
            if (exportMenu) exportMenu.style.display = 'block';
            if (excelBtn) excelBtn.style.display = 'block';
        }

        // NEW: Handle Request and Logs tabs differently
        if (tabName === 'request') {
            this.renderRequestTab();
            return;
        }

        if (tabName === 'logs') {
            this.renderLogsTab();
            return;
        }

        // When switching to data tabs from logs, restore table structure
        this.restoreTableStructure();

        // Original logic for existing tabs (input, success, errors)
        if (!this.reportData[tabName]) return;

        // Show toolbar for data tabs
        if (toolbar) {
            toolbar.style.display = 'flex';
        }

        const tabData = this.reportData[tabName];
        const config = this.tabConfigs[tabName];

        // Update root path selector
        this.updateRootSelector(tabData.availablePaths, config.rootPath);

        // Extract data at current root path and render
        const extractedData = this.extractAtPath(tabData.rows, config.rootPath);
        this.renderTable(extractedData, tabData.columns);

        // Update stats
        this.updateStats(extractedData.length, tabData.columns.length);

        // Store references for export
        currentTableData = extractedData;
        currentColumns = tabData.columns;
        filteredData = extractedData; // Will be updated by search
        visibleColumns = tabData.columns; // Will be updated by column management
    }

    // Removed duplicate extractAtPath and extractSingleAtPath methods
    // GitHub Issue #110: These methods now delegate to shared utility (see earlier in class)

    updateRootSelector(availablePaths, currentPath) {
        document.getElementById('current-root').textContent = currentPath;
        
        const pathList = document.getElementById('root-path-list');
        pathList.innerHTML = '';

        availablePaths.forEach(pathInfo => {
            const item = document.createElement('div');
            item.className = `root-path-item${pathInfo.path === currentPath ? ' current' : ''}${pathInfo.recommended ? ' recommended' : ''}`;
            item.innerHTML = `
                <div class="path-info">
                    <div class="path-name">${pathInfo.path}</div>
                    <div class="path-description">${pathInfo.description}</div>
                </div>
            `;
            item.onclick = () => this.changeRootPath(pathInfo.path);
            pathList.appendChild(item);
        });
    }

    changeRootPath(newPath) {
        if (!this.currentTab) return;

        this.tabConfigs[this.currentTab].rootPath = newPath;
        document.getElementById('current-root').textContent = newPath;
        document.getElementById('root-dropdown').classList.add('hidden');

        // Save settings if this is success or errors tab (GitHub Issue #84)
        if (this.currentTab === 'success' || this.currentTab === 'errors') {
            debouncedSaveSettings();
        }

        // Re-render with new root path
        this.switchTab(this.currentTab);
    }

    renderTable(data, columns) {
        const tableHead = document.getElementById('table-head');
        const tableBody = document.getElementById('table-body');

        // Clear existing content
        tableHead.innerHTML = '';
        tableBody.innerHTML = '';

        if (!data || data.length === 0) {
            document.getElementById('empty-state').classList.remove('hidden');
            document.getElementById('table-container').classList.add('hidden');
            return;
        }

        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('table-container').classList.remove('hidden');

        // Create header row
        const headerRow = document.createElement('tr');
        columns.forEach(column => {
            const th = document.createElement('th');
            th.textContent = column.name;
            th.dataset.columnId = column.id;
            th.className = 'sortable-header';
            th.onclick = () => this.sortByColumn(column.id);
            headerRow.appendChild(th);
        });
        tableHead.appendChild(headerRow);

        // Create data rows
        data.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.className = 'data-row';
            
            columns.forEach(column => {
                const td = document.createElement('td');
                const value = row[column.id];
                
                // Use rich rendering for arrays and objects, basic formatting for primitives
                if (Array.isArray(value) || (value && typeof value === 'object')) {
                    td.innerHTML = renderDataAsTable(value);
                } else {
                    td.textContent = this.formatCellValue(value);
                }
                
                td.className = this.getCellClass(column.type);
                tr.appendChild(td);
            });
            
            tableBody.appendChild(tr);
        });
    }

    formatCellValue(value) {
        // GitHub Issue #110: Delegate to shared table builder utility
        return this.tableBuilder.formatCellValue(value);
    }

    getCellClass(columnType) {
        switch (columnType) {
            case 'number': return 'numeric-cell';
            case 'date': return 'date-cell';
            case 'boolean': return 'boolean-cell';
            default: return 'text-cell';
        }
    }

    sortByColumn(columnId) {
        // TODO: Implement sorting logic
    }

    updateStats(rowCount, columnCount) {
        this.currentRowCount = rowCount;
        this.currentColumnCount = columnCount;
        document.getElementById('column-count').textContent = `${columnCount} columns`;
        // Issue #262: when a search filter is active, updateSearchResults
        // owns the row-count text ("X of Y rows"). Don't clobber it here.
        if (this.currentFilteredRowCount === null || this.currentFilteredRowCount === undefined) {
            document.getElementById('row-count').textContent = `${rowCount} rows`;
        }
        // Issue #250: legacy class doesn't run the rowBasis pipeline;
        // clear any prior rowbasis warning so it can't leak across tabs.
        clearFooterNotification('rowbasis');
    }

    // GitHub Issue #200: Get effective row count (filtered if search active, total otherwise)
    getEffectiveRowCount() {
        return this.currentFilteredRowCount !== null ? this.currentFilteredRowCount : (this.currentRowCount || 0);
    }

    // GitHub Issue #200: Disable copy options that exceed safe row limits
    updateCopyDropdownLimits() {
        const COPY_LIMITS = { html: 1000, tsv: 1000, markdown: 1000, csv: 10000 };
        const rows = this.getEffectiveRowCount();
        const dropdown = document.getElementById('copy-dropdown');

        dropdown.querySelectorAll('.export-option').forEach(option => {
            const format = option.dataset.format;
            const limit = COPY_LIMITS[format];
            if (limit && rows > limit) {
                option.disabled = true;
                option.classList.add('limit-exceeded');
                option.title = `Limit: ${limit.toLocaleString()} rows (current: ${rows.toLocaleString()})`;
                let subtitle = option.querySelector('.limit-note');
                if (!subtitle) {
                    subtitle = document.createElement('span');
                    subtitle.className = 'limit-note';
                    option.appendChild(subtitle);
                }
                subtitle.textContent = `Max ${limit.toLocaleString()} rows`;
            } else {
                option.disabled = false;
                option.classList.remove('limit-exceeded');
                option.title = '';
                const subtitle = option.querySelector('.limit-note');
                if (subtitle) subtitle.remove();
            }
        });
    }

    // GitHub Issue #200: Disable Excel export when cell count exceeds safe limit
    updateExportDropdownLimits() {
        const EXCEL_CELL_LIMIT = 2_000_000;
        const rows = this.getEffectiveRowCount();
        const cols = this.currentColumnCount || 0;
        const cellCount = rows * cols;
        const dropdown = document.getElementById('export-dropdown');

        dropdown.querySelectorAll('.export-option').forEach(option => {
            const format = option.dataset.format;
            if (format === 'excel' && cellCount > EXCEL_CELL_LIMIT) {
                option.disabled = true;
                option.classList.add('limit-exceeded');
                option.title = `Limit: ${EXCEL_CELL_LIMIT.toLocaleString()} cells (current: ${cellCount.toLocaleString()})`;
                let subtitle = option.querySelector('.limit-note');
                if (!subtitle) {
                    subtitle = document.createElement('span');
                    subtitle.className = 'limit-note';
                    option.appendChild(subtitle);
                }
                subtitle.textContent = `Max 2M cells (${cellCount.toLocaleString()})`;
            } else {
                option.disabled = false;
                option.classList.remove('limit-exceeded');
                option.title = '';
                const subtitle = option.querySelector('.limit-note');
                if (subtitle) subtitle.remove();
            }
        });
    }

    showEmptyState(message) {

        // Hide the tabs and table, show empty state
        document.getElementById('report-tabs').style.display = 'none';
        document.getElementById('table-container').classList.add('hidden');
        
        const emptyState = document.getElementById('empty-state');
        if (emptyState) {
            emptyState.classList.remove('hidden');
            const messageElement = emptyState.querySelector('p');
            if (messageElement) {
                messageElement.textContent = message;
            }
        }
    }

    exportCurrentTab(format) {
        if (!this.currentTab || !currentTableData) return;

        const config = this.tabConfigs[this.currentTab];

        vscode.postMessage({
            type: 'console.export_data',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                format: format,
                tableData: filteredData || currentTableData,
                columns: visibleColumns || currentColumns,
                options: {
                    fileName: `${this.currentTab}_export`,
                    includeHeaders: true,
                    rootPath: config.rootPath
                }
            }
        });
    }

    // NEW: Render Request tab content (GitHub Issue #101)
    renderRequestTab() {
        // Hide root path selector - not needed for request content
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'none';
        }

        // Get table container
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        tableContainer.classList.remove('hidden');
        tableContainer.innerHTML = '';

        // Check if we have any data to display (use this.rawData for DynamicReportManager)
        const hasHeaders = this.rawData?.requestHeaders && Object.keys(this.rawData.requestHeaders).length > 0;
        const hasParams = this.rawData?.requestQueryParams && Object.keys(this.rawData.requestQueryParams).length > 0;
        const hasBody = this.rawData?.requestContent && this.rawData.requestContent.trim() !== '{}' && this.rawData.requestContent.trim() !== '';

        if (!hasHeaders && !hasParams && !hasBody) {
            // Show empty state
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-state';
            emptyDiv.innerHTML = '<p>No request data available</p>';
            tableContainer.appendChild(emptyDiv);
            this.updateStats(0, 0);
            return;
        }

        // Create container
        const codeContainer = document.createElement('div');
        codeContainer.className = 'code-container';
        codeContainer.style.padding = '20px';
        codeContainer.style.height = '100%';
        codeContainer.style.overflow = 'auto';

        let contentHtml = '';

        // REQUEST HEADERS section
        if (hasHeaders) {
            contentHtml += '<div style="margin-bottom: 30px;">';
            contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">REQUEST HEADERS</div>';
            contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';
            contentHtml += '<div style="font-family: var(--vscode-editor-font-family); font-size: 13px;">';

            for (const [key, value] of Object.entries(this.rawData.requestHeaders)) {
                // Truncate long values (like tokens) but show full value in title
                const displayValue = value.length > 80 ? value.substring(0, 80) + '...' : value;
                contentHtml += `<div style="margin-bottom: 6px;" title="${this.escapeHtml(value)}">`;
                contentHtml += `<span style="color: var(--vscode-symbolIcon-keyForeground);">${this.escapeHtml(key)}</span>: `;
                contentHtml += `<span style="color: var(--vscode-editor-foreground);">${this.escapeHtml(displayValue)}</span>`;
                contentHtml += '</div>';
            }

            contentHtml += '</div></div>';
        }

        // QUERY PARAMETERS section
        if (hasParams) {
            contentHtml += '<div style="margin-bottom: 30px;">';
            contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">QUERY PARAMETERS</div>';
            contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';
            contentHtml += '<div style="font-family: var(--vscode-editor-font-family); font-size: 13px;">';

            for (const [key, value] of Object.entries(this.rawData.requestQueryParams)) {
                contentHtml += `<div style="margin-bottom: 6px;">`;
                contentHtml += `<span style="color: var(--vscode-symbolIcon-keyForeground);">${this.escapeHtml(key)}</span>: `;
                contentHtml += `<span style="color: var(--vscode-editor-foreground);">${this.escapeHtml(value)}</span>`;
                contentHtml += '</div>';
            }

            contentHtml += '</div></div>';
        }

        // REQUEST BODY section
        contentHtml += '<div style="margin-bottom: 20px;">';
        contentHtml += '<div style="font-weight: bold; font-size: 14px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; letter-spacing: 0.5px;">REQUEST BODY</div>';
        contentHtml += '<div style="border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px;"></div>';

        if (hasBody) {
            contentHtml += '<pre class="json-preview-pre" style="margin: 0;">' + this.escapeHtml(this.rawData.requestContent) + '</pre>';
        } else {
            // Check if this is a batch execution
            const isBatch = this.rawData?.metadata?.batchId;
            if (isBatch) {
                contentHtml += '<div style="color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 0;">Individual request bodies generated from CSV data.<br>See the Input tab to view the source CSV file.</div>';
            } else {
                contentHtml += '<div style="color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 0;">(No request body)</div>';
            }
        }

        contentHtml += '</div>';

        codeContainer.innerHTML = contentHtml;
        tableContainer.appendChild(codeContainer);

        // Update stats
        this.updateStats(1, 1);
    }

    // Helper method to escape HTML
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // NEW: Render Logs tab content
    renderLogsTab() {

        // Hide root path selector - not needed for log content
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'none';
        }

        // Get table container
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        tableContainer.classList.remove('hidden');

        // Hide the existing table instead of destroying it
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'none';
        }

        // Remove any existing logs container
        const existingLogsContainer = tableContainer.querySelector('.logs-container');
        if (existingLogsContainer) {
            existingLogsContainer.remove();
        }

        // Create logs container
        const logsContainer = document.createElement('div');
        logsContainer.className = 'logs-container';
        logsContainer.style.padding = '20px';
        logsContainer.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
        logsContainer.style.backgroundColor = 'var(--vscode-editor-background)';
        logsContainer.style.color = 'var(--vscode-editor-foreground)';
        logsContainer.style.border = '1px solid var(--vscode-panel-border)';
        logsContainer.style.borderRadius = '4px';

        if (this.rawData && this.rawData.logContent) {
            // Display pre-formatted log content from backend
            if (Array.isArray(this.rawData.logContent) && this.rawData.logContent.length > 0) {
                this.rawData.logContent.forEach(formattedLine => {
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'log-line';
                    lineDiv.textContent = formattedLine;
                    logsContainer.appendChild(lineDiv);
                });
                // Update stats
                this.updateStats(this.rawData.logContent.length, 1);
            } else {
                // Show empty state for empty array
                const placeholderDiv = document.createElement('div');
                placeholderDiv.className = 'logs-placeholder';
                placeholderDiv.style.textAlign = 'center';
                placeholderDiv.style.padding = '40px';
                placeholderDiv.style.color = 'var(--vscode-descriptionForeground)';
                placeholderDiv.innerHTML = '<p>' + window.Icons.label('file-text', 'No log content available') + '</p>';
                logsContainer.appendChild(placeholderDiv);
                this.updateStats(0, 0);
            }
        } else {
            // Show empty state or streaming indicator
            const placeholderDiv = document.createElement('div');
            placeholderDiv.className = 'logs-placeholder';
            placeholderDiv.style.textAlign = 'center';
            placeholderDiv.style.padding = '40px';
            placeholderDiv.style.color = 'var(--vscode-descriptionForeground)';

            if (this.reportData.isStreaming) {
                placeholderDiv.innerHTML = '<p>' + window.Icons.label('loader', 'Log streaming is active...') + '<br>Waiting for log data</p>';
            } else {
                placeholderDiv.innerHTML = '<p>' + window.Icons.label('file-text', 'No log content available') + '</p>';
            }

            logsContainer.appendChild(placeholderDiv);
            this.updateStats(0, 0);
        }

        tableContainer.appendChild(logsContainer);
    }

    // Helper method to restore table structure when switching from logs to data tabs
    // GitHub Issue #166: Also clean up RAW tab container
    restoreTableStructure() {
        const tableContainer = document.getElementById('table-container');
        if (!tableContainer) return;

        // Remove all tab-specific containers
        const containersToRemove = [
            '.logs-container',      // Logs tab
            '.code-container',      // Request tab
            '.raw-tab-container',   // RAW tab (GitHub Issue #166)
            '.logs-loading',        // Logs loading indicator
            '.empty-state'          // Empty state messages
        ];

        containersToRemove.forEach(selector => {
            const element = tableContainer.querySelector(selector);
            if (element) {
                element.remove();
            }
        });

        // Show the data table
        const dataTable = document.getElementById('data-table');
        if (dataTable) {
            dataTable.style.display = 'table';
        }

        // Show toolbar for data tabs
        const toolbar = document.getElementById('report-toolbar');
        if (toolbar) {
            toolbar.style.display = 'flex';
        }
    }

    // NEW: Handle log stream updates with auto-scroll
    handleLogStreamUpdate(content, isComplete = false) {
        if (this.currentTab !== 'logs') return; // Only update if logs tab is active

        // Append new content to existing logs
        if (!this.rawData.logContent) {
            this.rawData.logContent = [];
        }

        const isFirstLogEvent = this.rawData.logContent.length === 0;

        // Split incoming content into lines and append
        const newLines = content.split('\n').filter(line => line.trim());
        this.rawData.logContent.push(...newLines);

        // Update streaming state
        this.rawData.isStreaming = !isComplete;

        // First log event: Set up virtual scroll (for RUNNING executions that had no initial logs)
        if (isFirstLogEvent) {
            const tableContainer = document.getElementById('table-container');
            if (tableContainer) {
                // Remove loading indicator
                const loadingDiv = tableContainer.querySelector('.logs-loading');
                if (loadingDiv) loadingDiv.remove();

                // Set up virtual scroll
                this.setupLogsVirtualScroll(tableContainer);
            }
        }
        // Subsequent events: Update virtual scroll display
        else if (this.updateLogsVirtualScroll) {
            this.updateLogsVirtualScroll();
        }

        // Auto-scroll to bottom if enabled
        if (this.autoScrollEnabled && this.logsContainer) {
            this.logsContainer.scrollTop = this.logsContainer.scrollHeight;
        }
    }

    // NEW: Start log streaming
    startLogStreaming() {
        if (!this.reportData) return;

        vscode.postMessage({
            type: 'console.start_log_stream',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionId: this.reportData.metadata?.executionId || 'unknown',
                batchId: this.reportData.metadata?.batchId
            }
        });
    }

    // NEW: Stop log streaming
    stopLogStreaming() {
        if (!this.reportData) return;

        vscode.postMessage({
            type: 'console.stop_log_stream',
            correlationId: generateCorrelationId(),
            timestamp: Date.now(),
            source: 'webview',
            target: 'extension',
            payload: {
                executionId: this.reportData.metadata?.executionId || 'unknown'
            }
        });
    }

}

// Initialize report managers
const dynamicReportManager = new DynamicReportManager(); // New RIGHT way
const reportManager = new TabbedReportManager(); // Legacy fallback

// GitHub Issue #166: Initialize RAW tab handler (external module)
if (window.RawTabHandler) {
    dynamicReportManager.rawTabHandler = new window.RawTabHandler(dynamicReportManager);
    window.rawTabHandler = dynamicReportManager.rawTabHandler;
}

// Issue #296: right-click a Completed or Error row to view its
// transaction (or reprocess an error). Rows carry their response.
document.getElementById('table-body')?.addEventListener('contextmenu', (event) => {
    const tab = dynamicReportManager.currentTab;
    if (tab !== 'success' && tab !== 'errors' && tab !== 'input') return;
    const tr = event.target.closest('tr.data-row');
    const source = tr?._dbmnRow?.__response;
    // Issue #304: an Input row's source is the input record; its
    // transaction rides along as __tx.
    const response = tab === 'input' ? source?.__tx : source;
    if (!response || !window.rawTabHandler) return;
    window.rawTabHandler.showTransactionMenu(event, response);
});

// Make report managers globally accessible for onclick handlers and message handlers
window.dynamicReportManager = dynamicReportManager;
// #298: the View list shows which Views saved compares read (console-compare.js tells us)
window.onCompareViewsChanged = () => {
    dynamicReportManager.updateRootPathSelector();
    // Which Views Reporting reads decides which headings can remove their column
    const head = document.getElementById('table-head');
    // (the name as stored: asking for the View itself tidies the list of Views, which is not this hook's to do)
    const active = dynamicReportManager.currentTab === 'success' && dynamicReportManager.userSettings.success ? dynamicReportManager.userSettings.success.activeView : '';
    if (head && active && dynamicReportManager.viewUse(active).locked) head.querySelectorAll('th[data-hideable]').forEach(th => {
        delete th.dataset.hideable;
        const x = th.querySelector('.col-hide-btn');
        if (x) x.remove();
    });
};
window.reportManager = reportManager;

// Issue #229 Phase 1A dev seed — paste a view JSON to validate the
// view-driven renderer end-to-end before the editor ships. Removed
// when Phase 1B lands.
//   Usage (DevTools console):
//     _setActiveView({
//       name: 'PO Lines',
//       rowBasis: 'data.purchaseOrders.lines',
//       columns: [
//         { id: 'data.purchaseOrders.poNumber', source: 'ancestor' },
//         { id: 'data.purchaseOrders.lines.itemId', source: 'current' }
//       ]
//     }, 'success');  // second arg optional; defaults to current tab
window._setActiveView = function(viewInput, tab) {
    try {
        const view = (typeof viewInput === 'string') ? JSON.parse(viewInput) : viewInput;
        if (!view || typeof view !== 'object' || !view.name || !view.rowBasis) {
            console.error('[_setActiveView] Invalid view. Required: { name, rowBasis, columns }');
            return false;
        }
        if (!Array.isArray(view.columns)) view.columns = [];
        const tabName = tab || dynamicReportManager.currentTab || 'success';
        if (!dynamicReportManager.userSettings[tabName]) {
            dynamicReportManager.userSettings[tabName] = { activeView: '', views: [] };
        }
        const settings = dynamicReportManager.userSettings[tabName];
        const existingIdx = settings.views.findIndex(v => v.name === view.name);
        if (existingIdx >= 0) {
            settings.views[existingIdx] = view;
        } else {
            settings.views.push(view);
        }
        settings.activeView = view.name;
        dynamicReportManager.extractAndRender(tabName);
        console.info(`[_setActiveView] Applied view "${view.name}" to tab "${tabName}".`);
        return true;
    } catch (err) {
        console.error('[_setActiveView] Failed:', err);
        return false;
    }
};

// Initialize execution context from template values for button visibility logic
window.currentExecutionId = CONSOLE_PAGE.EXECUTION_ID;
window.currentBatchId = CONSOLE_PAGE.BATCH_ID;
// GitHub Issue #245: HTTP method drives pagination-button visibility (GET vs POST)
window.currentRequestMethod = CONSOLE_PAGE.ENDPOINT_METHOD;
// GitHub Issue #151: Hide Input tab for child batches (reprocessed from another batch)
window.hideInputTab = CONSOLE_PAGE.HIDE_INPUT_TAB === 'true';

// GitHub Issue #156: Thread control state for dynamic concurrency adjustment
const ALLOWED_THREAD_VALUES = [1, 2, 4, 8, 16];
let currentThreadCount = parseInt(CONSOLE_PAGE.INITIAL_CONCURRENCY, 10) || 1;
let maxThreadCount = parseInt(CONSOLE_PAGE.MAX_CONCURRENCY, 10) || 1;
window.currentExecutionStatus = null; // Track current status for thread control visibility

// ===== TIMER/PROGRESS MODULE (GitHub Issue #197) =====
window.progressHandler = new ProgressHandler();
// Issue #312: hydrate the page's static Lucide icons (data-icon spans)
document.addEventListener('DOMContentLoaded', () => { if (window.Icons) window.Icons.injectIcons(); });

// ===== BATCH ACTIONS MODULE (GitHub Issue #197) =====
window.batchActions = new BatchActions({
    executionId: CONSOLE_PAGE.EXECUTION_ID,
    batchId: CONSOLE_PAGE.BATCH_ID,
    reportType: CONSOLE_PAGE.REPORT_TYPE,
    executionStatus: CONSOLE_PAGE.EXECUTION_STATUS,
    vscode: vscode
});

// Convenience aliases for inline callers and progress-handler.js
function getErrorCount() { return batchActions.getErrorCount(); }
function setExportButtonEnabled(enabled) { batchActions.setExportButtonEnabled(enabled); }
function updateButtonVisibility(phase) { batchActions.updateButtonVisibility(phase); if (window.ConsoleChain) window.ConsoleChain.onStatus(phase); }

// Global expand/collapse handlers for arrays and objects
// (toggleArray / toggleObject removed in Issue #312: no callers; nested toggles use .expand-icon above)

// Timer cleanup on page unload
window.addEventListener('beforeunload', function() {
    progressHandler.stopTimer();
});

// Event handlers
document.addEventListener('DOMContentLoaded', function() {
    // Set ID label based on report type (batch vs individual)
    const isBatch = CONSOLE_PAGE.REPORT_TYPE === 'batch';
    const idLabel = document.getElementById('id-label');
    if (idLabel) {
        idLabel.textContent = isBatch ? 'Batch ID' : 'Transaction ID';
    }

    // GitHub Issue #102: Show threads stat only for batch reports
    const threadsElement = document.getElementById('threads-stat');
    if (threadsElement && isBatch) {
        const threadsValue = CONSOLE_PAGE.MAX_THREADS;
        if (threadsValue !== '-') {
            threadsElement.classList.remove('hidden');
        }
    }

    // View selector: dropdown is the only entry point — clicking the
    // button opens a list of views with per-view gear (edit) icons and
    // a footer '+ Create View' action. Issue #229 Phase 1B.3.
    // #439: the list floats over the page (position: fixed), placed under the button each time
    // it opens and again if the window changes size while it's open
    const placeViewsDropdown = () => {
        const dropdown = document.getElementById('root-dropdown');
        const button = document.getElementById('view-path-btn');
        if (!dropdown || !button || dropdown.classList.contains('hidden')) return;
        const at = button.getBoundingClientRect();
        dropdown.style.setProperty('--views-dropdown-top', `${Math.round(at.bottom + 4)}px`);
        dropdown.style.setProperty('--views-dropdown-left', `${Math.round(at.left)}px`);
    };
    document.getElementById('view-path-btn').addEventListener('click', function() {
        document.getElementById('root-dropdown').classList.toggle('hidden');
        placeViewsDropdown();
    });
    window.addEventListener('resize', placeViewsDropdown);
    document.getElementById('views-modal-close').addEventListener('click', function() {
        dynamicReportManager.closeViewsModal();
    });
    document.getElementById('view-editor-cancel').addEventListener('click', function() {
        dynamicReportManager.closeViewsModal();
    });
    document.getElementById('view-editor-save').addEventListener('click', function() {
        dynamicReportManager.saveViewFromEditor();
    });
    document.getElementById('view-editor-save-as').addEventListener('click', function() {
        dynamicReportManager.saveViewAsNewFromEditor();
    });
    document.getElementById('view-editor-delete').addEventListener('click', function() {
        dynamicReportManager.deleteViewFromEditor();
    });
    document.getElementById('view-editor-remove-all').addEventListener('click', function() {
        dynamicReportManager.removeAllFromEditor();
    });
    document.getElementById('view-editor-sort').addEventListener('click', function() {
        dynamicReportManager.sortSelectedByTreeOrder();
    });
    document.getElementById('view-editor-row-basis').addEventListener('change', function() {
        dynamicReportManager.onEditorRowBasisChanged();
    });
    // Phase 1B.10: Available-columns tree search — debounced input.
    (function () {
        const input = document.getElementById('view-editor-tree-search');
        if (!input) return;
        let timer = null;
        input.addEventListener('input', function () {
            const val = this.value;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () {
                dynamicReportManager.onEditorTreeSearch(val);
            }, 120);
        });
    })();

    // GitHub Issue #174: Copy menu (clipboard operations)
    document.getElementById('copy-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById('copy-dropdown').classList.toggle('show');
        document.getElementById('export-dropdown').classList.remove('show');
        // GitHub Issue #200: Update limits when dropdown opens
        dynamicReportManager.updateCopyDropdownLimits();
    });

    document.getElementById('copy-dropdown').querySelectorAll('.export-option').forEach(option => {
        option.addEventListener('click', function() {
            if (this.disabled) return; // GitHub Issue #200: Respect scale limits
            const format = this.dataset.format;
            const excelSafe = this.dataset.excelSafe === 'true'; // GitHub Issue #225
            dynamicReportManager.exportToClipboard(format, excelSafe);
            document.getElementById('copy-dropdown').classList.remove('show');
        });
    });


    // Export menu (file operations)
    document.getElementById('export-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById('export-dropdown').classList.toggle('show');
        document.getElementById('copy-dropdown').classList.remove('show');
        // GitHub Issue #200: Update limits when dropdown opens
        dynamicReportManager.updateExportDropdownLimits();
    });

    document.getElementById('export-dropdown').querySelectorAll('.export-option').forEach(option => {
        option.addEventListener('click', function() {
            if (this.disabled) return; // GitHub Issue #200: Respect scale limits
            const format = this.dataset.format;
            const excelSafe = this.dataset.excelSafe === 'true'; // GitHub Issue #225
            dynamicReportManager.exportCurrentTab(format, excelSafe);
            document.getElementById('export-dropdown').classList.remove('show');
        });
    });

    // Search functionality
    // GitHub Issue #227: Debounce search for performance with large datasets
    // GitHub Issue #261: Live syntax highlighting via mirror overlay
    const searchInputEl = document.getElementById('search-input');
    const searchMirrorEl = document.getElementById('search-input-mirror');
    let searchDebounceTimer = null;

    function renderSearchHighlight(value) {
        if (window.SearchMatcher) window.SearchMatcher.renderHighlight(searchMirrorEl, value);
    }

    if (window.SearchMatcher && window.SearchMatcher.followScroll) window.SearchMatcher.followScroll(searchInputEl, searchMirrorEl);
    // `@` lists the table's columns (as headed), then the operators: `@status=active`
    if (window.SearchMatcher && window.SearchMatcher.attachColumnSuggest) {
        window.SearchMatcher.attachColumnSuggest({
            input: searchInputEl,
            headings: () => [...new Set([...document.querySelectorAll('th[data-column-id] .column-name')].map(n => n.textContent.trim()).filter(Boolean))],
            // `@column.` lists the keys inside that column's nested data, from the rows on show
            keys: (heading, path) => window.SearchMatcher.nestedKeysFor(dynamicReportManager._shownRows, dynamicReportManager._shownColumns, heading, path, (row, id) => row[id])
        });
    }

    searchInputEl.addEventListener('input', function() {
        const value = this.value;
        renderSearchHighlight(value);
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        // A pause after the last key before searching: a word typed is one search, not one a letter
        searchDebounceTimer = setTimeout(function() {
            dynamicReportManager.handleSearch(value);
        }, 450);
    });
    searchInputEl.addEventListener('scroll', function() {
        if (searchMirrorEl) searchMirrorEl.scrollLeft = this.scrollLeft;
    });
    // Initialise mirror with any pre-filled value
    renderSearchHighlight(searchInputEl.value || '');

    // Column management — the legacy column-modal was replaced by the
    // Manage Views editor (#view-editor-*). Gear button + editor
    // handlers are wired inside ConsoleSettings/openViewEditor; the
    // old bindings to #column-modal-close etc. were dead and their
    // targets no longer exist in the HTML.

    // Close dropdowns when clicking outside
    document.addEventListener('click', function(event) {
        if (!event.target.closest('.view-selector')) {
            document.getElementById('root-dropdown').classList.add('hidden');
        }
        if (!event.target.closest('.export-menu')) {
            document.getElementById('export-dropdown').classList.remove('show');
            document.getElementById('copy-dropdown').classList.remove('show');
        }
    });

    // GitHub Issue #151: Reprocess link handler - open original batch report
    document.addEventListener('click', function(event) {
        if (event.target.classList.contains('reprocess-link')) {
            event.preventDefault();
            const batchId = event.target.dataset.batchId;
            if (batchId) {
                vscode.postMessage({
                    type: 'viewOriginalBatch',
                    correlationId: `view_original_${Date.now()}`,
                    source: 'webview',
                    target: 'extension',
                    timestamp: Date.now(),
                    payload: { batchId }
                });
            }
        }
    });

    // Navigation link handlers: open Endpoint or Environment
    document.addEventListener('click', function(event) {
        const navLink = event.target.closest('.nav-link');
        if (!navLink) return;
        event.preventDefault();
        if (navLink.classList.contains('stat-link') && !navLink.classList.contains('is-link')) return;   // no id to open
        const endpointId = navLink.dataset.endpointId;
        const environmentId = navLink.dataset.environmentId;
        if (endpointId) {
            vscode.postMessage({
                type: 'console.openEndpoint',
                correlationId: 'nav_endpoint_' + Date.now(),
                source: 'webview',
                target: 'extension',
                timestamp: Date.now(),
                payload: { endpointId: endpointId }
            });
        } else if (environmentId) {
            vscode.postMessage({
                type: 'console.openEnvironment',
                correlationId: 'nav_environment_' + Date.now(),
                source: 'webview',
                target: 'extension',
                timestamp: Date.now(),
                payload: { environmentId: environmentId }
            });
        }
    });

    // Initialize help icons
    if (window.initializeAllHelpIcons) {
        window.initializeAllHelpIcons();
    }
});

// Message handler
window.addEventListener('message', event => {
    const message = event.data;

    switch (message.type) {
        case 'progress_update':
            progressHandler.handleProgressUpdate(message.payload);
            break;

        // GitHub Issue #94: Handle progressive log chunk loading with progress bar
        case 'console.logs_chunk_loaded':

            // Initialize logContent array if it doesn't exist
            if (!dynamicReportManager.rawData) {
                dynamicReportManager.rawData = { responses: [], metadata: {}, availablePaths: [] };
            }
            if (!dynamicReportManager.rawData.logContent) {
                dynamicReportManager.rawData.logContent = [];
            }

            const isFirstChunk = dynamicReportManager.rawData.logContent.length === 0;

            // Append chunk to existing log content
            dynamicReportManager.rawData.logContent.push(...message.payload.chunk);

            // Only process if still on logs tab
            if (dynamicReportManager.currentTab === 'logs') {
                const tableContainer = document.getElementById('table-container');
                if (tableContainer) {
                    // First chunk: Display immediately with virtual scroll + show progress bar
                    if (isFirstChunk) {

                        // Remove loading indicator
                        const loadingDiv = tableContainer.querySelector('.logs-loading');
                        if (loadingDiv) loadingDiv.remove();

                        // Set up virtual scroll with first chunk
                        dynamicReportManager.setupLogsVirtualScroll(tableContainer);
                    }
                    // Subsequent chunks: Update virtual scroll automatically expands
                    else if (!message.payload.isComplete) {
                        // Update virtual scroll to reflect new content
                        if (dynamicReportManager.updateLogsVirtualScroll) {
                            dynamicReportManager.updateLogsVirtualScroll();
                        }
                        // LIVE indicator stays visible, no progress updates needed
                    }
                }
            }

            // Final chunk: Hide LIVE indicator
            if (message.payload.isComplete) {
                dynamicReportManager.logsLoadingInProgress = false;

                // Auto-start live streaming after historical logs loaded
                // Backend routes to live callbacks (RUNNING) or no-op (COMPLETED)
                dynamicReportManager.startLogStreaming();
            }
            break;

        case 'console.export_progress':
            progressHandler.handleExportProgress(message.payload);
            break;

        case 'console.table_data_response':
            const responseCount = message.payload?.rawData?.responses?.length || 0;

            // Defensive check for message structure
            if (!message.payload) {
                document.getElementById('loading-overlay').classList.add('hidden');
                document.getElementById('error-container').classList.remove('hidden');
                document.getElementById('error-message').textContent = 'Invalid message format received';
                break;
            }

            // Hide loading overlay and show data
            document.getElementById('loading-overlay').classList.add('hidden');
            document.getElementById('error-container').classList.add('hidden');

            // GitHub Issue #156: Show/hide Info tab organization based on content
            const infoOrgStat = document.getElementById('info-org-stat');
            const infoOrg = document.getElementById('info-organization');
            if (infoOrgStat && infoOrg) {
                const orgContent = infoOrg.textContent.trim();
                if (!orgContent || orgContent === '' || orgContent === 'Unknown' || orgContent === CONSOLE_PAGE.ORGANIZATION) {
                    infoOrgStat.style.display = 'none';
                }
            }

            // Navigation links: show when IDs are available
            const envLink = document.getElementById('info-environment-link');
            if (envLink && envLink.dataset.environmentId && envLink.dataset.environmentId !== '' && envLink.dataset.environmentId !== CONSOLE_PAGE.ENVIRONMENT_ID) {
                envLink.classList.add('is-link');
            }
            const endpointLink = document.getElementById('info-endpoint-link');
            if (endpointLink && endpointLink.dataset.endpointId && endpointLink.dataset.endpointId !== '' && endpointLink.dataset.endpointId !== CONSOLE_PAGE.ENDPOINT_ID) {
                endpointLink.classList.add('is-link');
            }

            // ENV Variables: decode and display if present
            const varsSection = document.getElementById('info-variables-section');
            const varsContainer = document.getElementById('info-variables-container');
            if (varsSection && varsContainer) {
                const encoded = varsSection.dataset.envVars;
                if (encoded && encoded !== '' && encoded !== CONSOLE_PAGE.ENVIRONMENT_VARIABLES_JSON) {
                    try {
                        const vars = JSON.parse(atob(encoded));
                        const entries = Object.entries(vars);
                        if (entries.length > 0) {
                            varsSection.style.display = '';
                            varsContainer.innerHTML = entries.map(function(entry) {
                                return '<div class="stat-item"><span class="stat-label">' +
                                    entry[0].replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                                    '</span><span class="font-mono">' +
                                    String(entry[1]).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                                    '</span></div>';
                            }).join('');
                        }
                    } catch (e) {
                        // Ignore decode errors - section stays hidden
                    }
                }
            }

            // GitHub Issue #156: Hide HTTP status stat for empty/placeholder values
            const infoHttpStatusStat = document.getElementById('info-http-status-stat');
            const infoHttpStatus = document.getElementById('info-http-status');
            if (infoHttpStatusStat && infoHttpStatus) {
                const httpContent = infoHttpStatus.textContent.trim();
                if (!httpContent || httpContent === '' || httpContent === '-' || httpContent === CONSOLE_PAGE.HTTP_STATUS_DISPLAY) {
                    infoHttpStatusStat.style.display = 'none';
                }
            }

            // Apply status-specific styling
            const statusBadge = document.getElementById('status-badge');
            const statusValue = CONSOLE_PAGE.STATUS_DISPLAY;
            if (statusBadge && statusValue) {
                if (statusValue.includes('✅') || statusValue.includes('Completed')) {
                    statusBadge.classList.add('completed');
                } else if (statusValue.includes('❌') || statusValue.includes('Failed')) {
                    statusBadge.classList.add('failed');
                    // GitHub Issue #173: Removed references to undefined summaryIcon/performanceTitle
                } else if (statusValue.includes('🔄') || statusValue.includes('Running')) {
                    statusBadge.classList.add('running');
                } else if (statusValue.includes('⚠️') || statusValue.includes('Partial')) {
                    statusBadge.classList.add('partial');
                }
            }

            // Check for new raw data format first (the RIGHT way)
            if (message.payload.rawData) {
                const t0 = performance.now();
                dynamicReportManager.initialize(message.payload.rawData);
                console.log('[DBMN timing] page: first data initialised in', Math.round(performance.now() - t0), 'ms;', (message.payload.rawData.responses || []).length, 'responses,', (message.payload.rawData.inputData || []).length, 'input rows; since page start', Math.round(performance.now()), 'ms');
                // Issue #312: a large batch — this was only the first chunk
                showStreamingProgress(message.payload.streaming);

                // GitHub Issue #152: Check status on initial load and update UI accordingly
                // Use the status from rawData metadata if available
                const metadataStatus = message.payload.rawData?.metadata?.status?.toLowerCase() || '';
                const badgeText = document.getElementById('status-badge')?.textContent?.toLowerCase() || '';
                const actualStatus = metadataStatus || badgeText;

                // Handle PAUSED status
                if (actualStatus.includes('paused')) {
                    // No toast on load — the status badge already shows "paused".
                    // A toast should reflect a live transition, not initial render
                    // of an already-finished/paused execution.
                    setExportButtonEnabled(true); // Can export paused batches
                }
                // Handle COMPLETED status - check for errors
                else if (actualStatus.includes('completed') || actualStatus === 'complete') {
                    const errorCount = getErrorCount();
                    if (errorCount > 0) {
                        // Update status badge to show "COMPLETED WITH ERRORS"
                        const badge = document.getElementById('status-badge');
                        if (badge) {
                            badge.textContent = 'COMPLETED WITH ERRORS';
                            badge.classList.remove('completed', 'status-pill-success');
                            badge.classList.add('status-pill-error');
                        }
                        // #438: the heading keeps the tab's and the footer's colour (completed); the pill says there were errors
                        // No toast on load — the "COMPLETED WITH ERRORS" badge
                        // already conveys this; toasts are for live transitions.
                        // Ensure errors tab is visible
                        const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
                        if (errorsTab) errorsTab.style.display = '';
                    } else {
                        // No errors - hide errors tab
                        const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
                        if (errorsTab) errorsTab.style.display = 'none';
                    }
                }
                // Handle STOPPED status
                else if (actualStatus.includes('stopped')) {
                    // No toast on load — the status badge already shows "stopped".
                }
            }
            // Legacy formats for backward compatibility
            else if (message.payload.input || message.payload.success || message.payload.errors) {
                // This is legacy tabbed data
                reportManager.initialize(message.payload);
            } else if (message.payload.tableData) {
                // This is legacy individual data - convert to tabbed format
                const tabbedData = convertIndividualToTabbed(message.payload.tableData, message.payload.performanceMetrics);
                reportManager.initialize(tabbedData);
            } else {
                document.getElementById('error-container').classList.remove('hidden');
                document.getElementById('error-message').textContent = 'Unknown report data format received';
            }
            break;

        case 'console.export_started':
            // Show export overlay with filename when export starts (after dialog confirmation)
            const exportOverlayStart = document.getElementById('export-overlay');
            const exportFilename = document.getElementById('export-filename');
            if (exportOverlayStart && exportFilename) {
                // Set filename in overlay
                const filename = event.data.payload?.filename || 'export file';
                exportFilename.textContent = filename;

                // Show overlay
                exportOverlayStart.classList.remove('hidden');

                // Failsafe: Auto-hide overlay after 60 seconds (in case export_complete message is missed)
                const exportTimeout = setTimeout(() => {
                    if (exportOverlayStart) {
                        exportOverlayStart.classList.add('hidden');
                    }
                }, 60000);

                // Store timeout ID so we can clear it when export completes
                exportOverlayStart.dataset.timeoutId = exportTimeout;
            }
            break;

        case 'console.export_complete':
            // Hide export overlay when export completes
            const exportOverlay = document.getElementById('export-overlay');
            if (exportOverlay) {
                // Clear timeout if it exists
                const timeoutId = exportOverlay.dataset.timeoutId;
                if (timeoutId) {
                    clearTimeout(parseInt(timeoutId));
                }
                exportOverlay.classList.add('hidden');
            }
            // GitHub Issue #200: Show completion notification
            if (message.payload && message.payload.success) {
                const exportedRows = message.payload.rowCount || 0;
                showFooterNotification('info', `Export complete (${exportedRows.toLocaleString()} rows)`);
            } else {
                clearFooterNotification();
            }
            break;

        // GitHub Issue #120, #174, #200: Handle clipboard ready message
        case 'console.clipboard_ready':
            // Check both message.data and message.payload for compatibility
            const clipboardData = message.data || message.payload;
            if (clipboardData) {
                const rowCount = clipboardData.rowCount || 0;
                // GitHub Issue #174: Get format name for display
                const formatNames = {
                    'csv': 'CSV',
                    'tsv': 'TSV',
                    'html': 'Table',
                    'markdown': 'Markdown'
                };
                const format = clipboardData.format || 'csv';
                const formatLabel = formatNames[format] || format.toUpperCase();

                // GitHub Issue #200: Backend already wrote to clipboard for non-HTML formats
                const colCount = clipboardData.columnCount || 0;
                const scaleInfo = colCount > 50
                    ? `${rowCount.toLocaleString()} rows × ${colCount} cols`
                    : `${rowCount.toLocaleString()} rows`;
                if (clipboardData.clipboardWritten) {
                    showFooterNotification('info', `${formatLabel} copied to clipboard (${scaleInfo})`);
                } else if (clipboardData.htmlContent && clipboardData.content) {
                    // GitHub Issue #225: Dual-format clipboard (text + type-aware HTML)
                    // Spreadsheets pick up HTML (with mso-number-format for string preservation)
                    // Text editors pick up plain text (unchanged CSV/TSV/Markdown)
                    writeConsoleRichClipboard(
                        clipboardData.htmlContent,
                        clipboardData.content,
                        formatLabel,
                        scaleInfo
                    );
                } else if (clipboardData.content && format === 'html') {
                    // For HTML: render into DOM, select, and execCommand('copy')
                    // This puts rich CF_HTML on the Windows clipboard so Outlook/Word paste as formatted table
                    try {
                        const container = document.createElement('div');
                        container.innerHTML = clipboardData.content;
                        container.style.position = 'fixed';
                        container.style.left = '-9999px';
                        container.style.top = '0';
                        document.body.appendChild(container);

                        const range = document.createRange();
                        range.selectNodeContents(container);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(range);

                        document.execCommand('copy');

                        selection.removeAllRanges();
                        document.body.removeChild(container);

                        showFooterNotification('info', `${formatLabel} copied to clipboard (${scaleInfo})`);
                    } catch (err) {
                        console.error('Failed to copy HTML to clipboard:', err);
                        showFooterNotification('error', 'Failed to copy HTML to clipboard. Please try again.');
                    }
                } else if (clipboardData.content) {
                    // Fallback: text formats with content (shouldn't happen with #200 fix)
                    window.DbmnClipboard.writeText(clipboardData.content).then(ok => {
                        if (ok) {
                            showFooterNotification('info', `${formatLabel} copied to clipboard (${scaleInfo})`);
                        } else {
                            console.error('Failed to copy to clipboard');
                            showFooterNotification('error', 'Failed to copy to clipboard. Please try again.');
                        }
                    });
                }
            }
            break;

        // NEW: Handle refresh and log streaming messages
        case 'console.report_refreshed':
            if (message.payload && message.payload.rawData) {
                // Update the current report data
                dynamicReportManager.initialize(message.payload.rawData);
            }
            break;

        case 'console.log_stream_update':
            if (message.payload && message.payload.content) {
                // Update log content in real-time
                dynamicReportManager.handleLogStreamUpdate(
                    message.payload.content,
                    message.payload.isComplete || false
                );
            }
            break;

        case 'batch_member_status_update':
            if (message.payload) {
                dynamicReportManager.handleMemberStatusUpdate(message.payload);
            }
            break;

        case 'batch_member_result_update':
            if (message.payload) {
                // Update batch member results in real-time
                dynamicReportManager.handleMemberResultUpdate(message.payload);

                // GitHub Issue #156: Also update the slide-out panel progress
                if (message.payload.progress) {
                    updatePanelProgress(message.payload.progress);
                }
            }
            break;

        case 'console.error':
            document.getElementById('loading-overlay').classList.add('hidden');
            document.getElementById('error-container').classList.remove('hidden');
            document.getElementById('error-message').textContent = message.payload.message || 'Unknown error occurred';
            break;

        case 'status_update':
            // Handle live status updates for individual transactions
            if (message.payload) {
                updateExecutionStatus(message.payload);
            }
            break;

        // GitHub Issue #156: Handle dynamic thread count updates (now updates panel)
        case 'concurrency_updated':
            if (message.payload) {
                currentThreadCount = message.payload.currentConcurrency || 1;
                maxThreadCount = message.payload.maxConcurrency || 16;

                // Update panel thread display
                const panelThreads = document.getElementById('panel-threads');
                if (panelThreads) {
                    panelThreads.textContent = currentThreadCount;
                }

                // Also update the threads stat if visible
                const threadsValue = document.getElementById('threads-value');
                if (threadsValue) {
                    threadsValue.textContent = currentThreadCount;
                }

                console.log('[Report] Concurrency updated:', message.payload);
                paintProgressStats();
            }
            break;

        // Clear error transactions when user chooses to reprocess on resume
        case 'clear_errors':
            console.log('[Report] Clearing error transactions for reprocessing');
            if (window.dynamicReportManager && window.dynamicReportManager.rawData) {
                // Take the failed rows out — exactly the rows the Error tab shows — and
                // rebuild the position map and the running tallies from what is left.
                // (This used to drop the rows and paint "0" but leave the tally and the
                // positions stale, so the first retried row put the old count back.)
                const mgr = window.dynamicReportManager;
                const cleared = ConsoleLiveCounts.clearErrors(mgr.rawData.responses, (rows) => mgr.classifyResponses(rows));
                mgr.rawData.responses = cleared.responses;
                mgr.applyLiveCounts(cleared);
                const successOnly = cleared.responses;

                mgr.updateTabCountWithAnimation('success', cleared.liveSuccess);
                mgr.updateTabCountWithAnimation('errors', cleared.liveErrors);
                mgr.paintBatchProgress(); // Issue #311: the bar follows the tabs

                // Hide errors tab (no errors now)
                const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
                if (errorsTab) errorsTab.style.display = 'none';

                // Clear footer notification
                clearFooterNotification();

                // If currently on errors tab, switch to success
                if (window.dynamicReportManager.currentTab === 'errors') {
                    window.dynamicReportManager.switchTab('success');
                }

                console.log('[Report] Cleared errors, remaining responses:', successOnly.length);
            }
            break;

        case 'REPORT_SETTINGS_LOADED':
            // GitHub Issue #228: Mark settings as loaded so switchTab can safely
            // override paths without clobbering saved user preferences
            if (window.dynamicReportManager) {
                window.dynamicReportManager.settingsLoaded = true;
            }

            // Always set endpoint ID if provided (even temp ones!)
            if (message.endpointId) {
                currentEndpointId = message.endpointId;

                // GitHub Issue #228: Always set endpointId on consoleSettings so saves work,
                // even when no saved settings exist yet (new endpoint)
                if (window.consoleSettings) {
                    window.consoleSettings.currentEndpointId = message.endpointId;
                }

                // Apply settings only if they exist
                if (message.settings) {
                    applyConsoleSettings(message.settings, message.endpointId);
                } else {
                }
            }
            break;

        // Issue #312: a host-side timing line, surfaced in this webview's DevTools console
        case 'console.timing':
            console.log('[DBMN timing]', message.line, 'at', new Date().toISOString());
            break;

        // Issue #312: the rest of a large batch, chunk by chunk — input rows first, then responses
        case 'console.raw_chunk':
            if (message.payload) {
                const tc = performance.now();
                if (message.payload.inputRows) dynamicReportManager.appendInputRows(message.payload.inputRows);
                if (message.payload.responses) dynamicReportManager.appendResponses(message.payload.responses);
                showStreamingProgress(message.payload);
                const ms = Math.round(performance.now() - tc);
                if (ms > 100 || message.payload.loaded >= message.payload.total) {
                    console.log('[DBMN timing] page: chunk', message.payload.loaded + '/' + message.payload.total, 'merged in', ms, 'ms');
                }
            }
            break;

        case 'console.database_count_response':
            // GitHub Issue #102: Update transaction count with database count
            if (message.payload && message.payload.count !== undefined) {
                dynamicReportManager.updateTransactionCount(message.payload.count);
            }
            break;

        case 'sectionContentLoaded':
            console.log('[Report] Received sectionContentLoaded message:', message.payload?.title);
            if (window.renderDocumentationModal && message.payload) {
                console.log('[Report] Calling renderDocumentationModal');
                window.renderDocumentationModal(
                    message.payload.title,
                    message.payload.html,
                    message.payload.docPath,
                    message.payload.section
                );
            } else {
                console.error('[Report] renderDocumentationModal not available or payload missing');
            }
            break;

        // GitHub Issue #197: Cases merged from second message handler
        case 'commandExecutionFailed':
            if (message.command === 'dbmn.deleteTransaction') {
                batchActions.resetDeleteButton();
            } else if (message.command === 'dbmn.rerunTransaction') {
                batchActions.resetRerunButton();
            }
            break;

        case 'paginationMetadata':
            // GitHub Issue #94: Handle pagination metadata from backend
            handlePaginationMetadata(message.paginationData);
            break;

        case 'nextPageCreated':
            // GitHub Issue #94: Re-enable button after next page is created
            const nextPageBtnCreated = document.getElementById('next-page-btn');
            if (nextPageBtnCreated) {
                nextPageBtnCreated.disabled = false;
                nextPageBtnCreated.innerHTML = window.Icons.label('arrow-right', 'Next Page', 'btn-icon');
                nextPageBtnCreated.style.opacity = '1';
            }
            break;

        case 'getPagesComplete':
            // GitHub Issue #198: Creation is now near-instant, just close modal
            if (message.success) {
                hidePaginationModal();
            } else {
                // Show error via validation area and re-enable buttons
                const rangeError = document.getElementById('range-validation-error');
                if (rangeError) {
                    rangeError.textContent = message.error || 'Failed to fetch pages';
                    rangeError.style.display = 'block';
                }
                const allPagesBtn = document.getElementById('get-all-pages-btn');
                const rangePagesBtn = document.getElementById('get-range-pages-btn');
                if (allPagesBtn) allPagesBtn.disabled = false;
                if (rangePagesBtn) rangePagesBtn.disabled = false;
            }
            break;

        case 'console.raw_tab_data_response':
            // GitHub Issue #166: Handle RAW tab data response
            // Note: messageFactory puts response data in 'data' not 'payload'
            const rawTabPayload = message.data || message.payload;
            if (window.rawTabHandler && rawTabPayload) {
                window.rawTabHandler.handleDataResponse(rawTabPayload);
            }
            break;

        case 'console.raw_transaction_content_response':
            // GitHub Issue #166: Handle RAW transaction content response
            const rawContentPayload = message.data || message.payload;
            if (window.rawTabHandler && rawContentPayload) {
                window.rawTabHandler.handleContentResponse(rawContentPayload);
            }
            break;

        case 'console.transaction_log_response':
            // GitHub Issue #166: Handle transaction log response for modal
            const logPayload = message.data || message.payload;
            if (window.rawTabHandler && logPayload) {
                window.rawTabHandler.handleLogContentResponse(logPayload);
            }
            break;

        case 'paginationSetupData':
            // GitHub Issue #198: Open pagination modal with data from backend
            showPaginationModal(message);
            break;

        case 'paginationConfigSaved':
            // GitHub Issue #198: Handle save result from backend
            handlePaginationConfigSaved(message);
            break;

    }
});

// Handle live status updates for individual transactions
function updateExecutionStatus(payload) {
    const reportTitle = document.getElementById('report-title');
    const statusBadge = document.getElementById('status-badge');

    if (statusBadge && payload.statusDisplay) {
        statusBadge.innerHTML = payload.statusDisplay;
    }

    // Update response data if provided (for individuals, full refresh is fine).
    // First, so the status below counts this attempt's errors: a Re-run that succeeded after
    // a failed attempt read COMPLETED WITH ERRORS, judged on the attempt before.
    if (payload.responseData && dynamicReportManager) {
        // Save current settings before refresh
        const currentSettings = window.dynamicReportManager?.userSettings;

        // Convert single response to proper rawData format expected by initialize()
        // Use dynamic path discovery to find all available paths in the response data
        const discoveredPaths = discoverDataPaths(payload.responseData);

        // GitHub Issue #201: Inject status so RAW tab can classify correctly
        const responseWithStatus = {
            ...payload.responseData,
            status: payload.status,
            metadata: {
                ...payload.responseData?.metadata,
                executionId: window.currentExecutionId,
                sourceFile: payload.responseFile ? payload.responseFile.split(/[/\\]/).pop() : undefined
            }
        };

        const rawDataFormat = {
            responses: [responseWithStatus], // Wrap single response in array with status
            inputData: undefined, // Individual transactions have no CSV input
            availablePaths: discoveredPaths, // Use dynamically discovered paths instead of hardcoded
            hasValidRequest: false, // Individual transactions handle request separately
            requestContent: null,
            logContent: [], // Logs handled separately
            isStreaming: false,
            // GitHub Issue #201: Include metadata so Raw tab can fetch request content
            metadata: {
                executionId: window.currentExecutionId,
                batchId: window.currentBatchId
            }
        };

        dynamicReportManager.initialize(rawDataFormat);

        // Check if settings are preserved after initialize
    }

    // Update both pill and title classes based on status
    if (payload.status) {
        const status = payload.status.toLowerCase();
        // GitHub Issue #156: Track current status for thread control visibility
        window.currentExecutionStatus = status;
        // Issue #312: the Raw tab's Running-only default follows the batch
        if (window.dynamicReportManager && window.dynamicReportManager.rawTabHandler) {
            window.dynamicReportManager.rawTabHandler.onExecutionStatus(status);
        }
        let statusPillClass = 'status-pill-default';
        let titleStatusClass = '';

        if (status === 'completed') {
            // GitHub Issue #152: Check if there are errors and show "COMPLETED WITH ERRORS"
            const errorCount = getErrorCount();
            if (errorCount > 0) {
                statusPillClass = 'status-pill-error';
                // #438: the heading has the tab's and the footer's colour (completed); the pill says there were errors
                titleStatusClass = 'title-success';
                statusBadge.textContent = 'COMPLETED WITH ERRORS';
                // Toast only on a live completion (saw it run this session),
                // not when re-opening an already-completed console.
                if (window.__consoleSawLive) {
                    showFooterNotification('error', `Batch completed with ${errorCount} error${errorCount > 1 ? 's' : ''}`, { persistent: true });
                }
                // Show errors tab (make sure it's visible)
                const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
                if (errorsTab) errorsTab.style.display = '';
            } else {
                statusPillClass = 'status-pill-success';
                titleStatusClass = 'title-success';
                statusBadge.textContent = 'COMPLETED';
                clearFooterNotification();
                // GitHub Issue #152: Hide errors tab if 0 errors after completion
                const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
                if (errorsTab) errorsTab.style.display = 'none';
            }
            // Stop timer when execution completes
            progressHandler.stopTimer();
            // GitHub Issue #152: Enable export button after completion
            setExportButtonEnabled(true);
        } else if (status === 'failed' || status === 'error') {
            statusPillClass = 'status-pill-error';
            titleStatusClass = 'title-error';
            statusBadge.textContent = 'ERROR';
            // Stop timer when execution fails
            progressHandler.stopTimer();
            // GitHub Issue #152: Enable export button
            setExportButtonEnabled(true);
        } else if (status === 'running' || status === 'processing') {
            // Mark that we've observed this execution running in THIS session,
            // so terminal-state toasts (completed-with-errors / paused) only
            // fire on a real live transition — never when re-opening a console
            // that was already finished/paused.
            window.__consoleSawLive = true;
            statusPillClass = 'status-pill-running';
            titleStatusClass = 'title-running';
            statusBadge.textContent = 'RUNNING';

            // GitHub Issue #152: Disable export button during running
            setExportButtonEnabled(false);

            // Start timer when execution starts running. Issue #311: or
            // resync it — after a resume the backend sends `now - total
            // run time`, so the clock carries on instead of restarting.
            if (payload.startTime && progressHandler.clockDisagrees(payload.startTime)) {
                progressHandler.startTimer(payload.startTime, progressHandler.executionETA);
            }
        } else if (status === 'partial') {
            statusPillClass = 'status-pill-partial';
            titleStatusClass = 'title-partial';
            statusBadge.textContent = 'PARTIAL';
        } else if (status === 'cancelled') {
            statusPillClass = 'status-pill-cancelled';
            titleStatusClass = 'title-stopped';
            statusBadge.textContent = 'CANCELLED';
            progressHandler.stopTimer();
            setExportButtonEnabled(true);
        } else if (status === 'paused') {
            statusPillClass = 'status-pill-paused';
            titleStatusClass = 'title-warning';
            statusBadge.textContent = 'PAUSED';
            // issue#269: no pause toast — the PAUSED status pill + the
            // Resume button already convey state in-context. (The pause
            // reason is also suppressed below so it doesn't surface as
            // an error toast.)
            // Stop timer when paused
            progressHandler.stopTimer();
            // Enable export for paused batches
            setExportButtonEnabled(true);
        } else if (status === 'stopped') {
            statusPillClass = 'status-pill-stopped';
            titleStatusClass = 'title-stopped';
            statusBadge.textContent = 'STOPPED';
            // Stopped means there was an error - ensure errors tab is visible
            const errorsTab = document.querySelector('.tab-item[data-tab="errors"]');
            if (errorsTab) errorsTab.style.display = '';
            progressHandler.stopTimer();
            // GitHub Issue #152: Enable export button
            setExportButtonEnabled(true);
        } else if (status === 'preparing') {
            window.__consoleSawLive = true;
            statusPillClass = 'status-pill-preparing';
            titleStatusClass = 'title-preparing';
            statusBadge.textContent = 'PREPARING';

            // GitHub Issue #152: Disable export button during preparing
            setExportButtonEnabled(false);

            // Start timer for batch executions (includes prep time)
            if (payload.startTime && progressHandler.clockDisagrees(payload.startTime)) {
                progressHandler.startTimer(payload.startTime, progressHandler.executionETA);
            }
        } else {
            statusBadge.textContent = status.toUpperCase();
        }

        // GitHub Issue #264: the progress section (bar + elapsed time)
        // stays visible in every state — only the "Remaining: …" ETA
        // text comes and goes. It makes no sense once nothing remains,
        // so drop it on terminal states; while paused keep the last
        // calculated value (hide only if we never managed to calc one,
        // in which case resume's next progress message repopulates it).
        if (window.ConsoleProgress) {
            window.ConsoleProgress.show();
            if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'stopped') {
                if (progressHandler) progressHandler._showEta = false;
                window.ConsoleProgress.remaining(null);
            } else if (status === 'paused') {
                const hasCalculatedETA = !!(progressHandler && progressHandler.executionETA);
                if (progressHandler) progressHandler._showEta = hasCalculatedETA;
                if (!hasCalculatedETA) window.ConsoleProgress.remaining(null);
            } else if (progressHandler) {
                progressHandler._showEta = true;
            }
        }

        // Update status pill class
        if (statusBadge) {
            statusBadge.className = `status-pill ${statusPillClass}`;
        }

        // Update title class
        if (reportTitle) {
            // Remove old title classes and add new one
            reportTitle.className = reportTitle.className.replace(/title-(success|error|running|partial|warning|preparing|stopped)/g, '');
            if (titleStatusClass) {
                reportTitle.classList.add(titleStatusClass);
            }
        }

        // Update Logs tab indicator
        updateLogsTabIndicator(status);
    }

    // GitHub Issue #156: Update duration if provided (Info tab)
    if (payload.durationSeconds !== undefined) {
        const infoDuration = document.getElementById('info-duration');
        if (infoDuration) {
            const isBatchExecution = !!window.currentBatchId;
            if (isBatchExecution) {
                infoDuration.textContent = formatDuration(Math.floor(payload.durationSeconds));
            } else {
                infoDuration.textContent = formatIndividualDuration(payload.durationSeconds);
            }
        }
    }

    // GitHub Issue #159: Update error message if provided using footer notification
    // issue#269: 'paused' passes its reason ("User requested pause") via
    // errorMessage — that's informational, not an error, so don't toast it.
    if (payload.errorMessage && payload.status !== 'paused') {
        showFooterNotification('error', payload.errorMessage, { persistent: true });
    } else if (payload.status === 'completed' || payload.status === 'running' || payload.status === 'paused') {
        clearFooterNotification();
    }

    // Update progress if provided (for individual executions).
    // Issue #312: not while the bar is showing a large batch loading.
    if (payload.progress && !progressHandler.loading) {
        const box = window.ConsoleProgress;

        // Issue #311: a batch whose rows are loaded paints from its own
        // tallies (the tab counts); the backend's count is only for the
        // first paint before the rows arrive, and for terminal states
        // where it is the final word.
        const mgr = window.dynamicReportManager;
        const terminal = payload.status === 'completed' || payload.status === 'stopped' || payload.status === 'error';
        const fromTallies = !!(window.currentBatchId && mgr && mgr.rawData && !terminal);

        if (fromTallies) {
            mgr.paintBatchProgress(payload.progress.total);
        } else if (box) {
            box.count(`${payload.progress.completed}/${payload.progress.total}`);
        }

        if (box) {
            if (!fromTallies) box.fill(payload.progress.percentage);
            // The box's colour follows the run's state
            const statusClass = payload.status ? payload.status.toLowerCase() : '';
            if (statusClass) box.state(statusClass);
        }

        // Update progress phase text when execution finishes or is paused/cancelled
        // GitHub Issue #159: Respect actual status (stopped vs completed)
        if (box) {
            const finalStatus = payload.status || 'completed';
            if (finalStatus === 'paused') box.phase('Paused');
            else if (finalStatus === 'cancelled') box.phase('Cancelled');
            else if (finalStatus === 'stopped') box.phase('Stopped');
            else if (payload.progress.percentage === 100) box.phase('Execution Complete');
        }
    }

    // Reset re-run button if execution completed/failed
    if (payload.status === 'completed' || payload.status === 'error') {
        const rerunBtn = document.getElementById('rerun-transaction-btn');
        if (rerunBtn) {
            rerunBtn.disabled = false;
            rerunBtn.innerHTML = window.Icons.label('refresh-cw', 'Re-run', 'btn-icon');
            rerunBtn.style.opacity = '1';
        }
    }

    // Update button visibility based on new status
    if (payload.status) {
        updateButtonVisibility(payload.status);
    }

    // Reconcile stale RAW tab stubs when batch reaches terminal state
    const terminalStatuses = ['completed', 'error', 'failed', 'stopped', 'cancelled'];
    if (payload.status && terminalStatuses.includes(payload.status.toLowerCase())) {
        if (dynamicReportManager?.rawTabHandler) {
            dynamicReportManager.rawTabHandler.reconcileStaleStubs();
        }
    }
}

// ===== DATA NAVIGATOR MODULE (GitHub Issue #197) =====
window.dataNavigator = new DataNavigator();

// Convenience wrapper - used by DynamicReportManager.getDiscoveredPaths() and message handler
function discoverDataPaths(data, maxDepth) { return dataNavigator.discoverDataPaths(data, maxDepth); }

// Utility functions
function generateCorrelationId() {
    return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}


// Convert individual report data to tabbed format for compatibility
function convertIndividualToTabbed(tableData, performanceMetrics) {
    
    // Defensive checks for tableData
    if (!tableData) {
        return {
            metadata: {
                totalRows: 0,
                extractionTime: performanceMetrics?.extractionTime || 0,
                dataType: 'individual'
            }
        };
    }
    
    if (typeof tableData !== 'object') {
        return {
            metadata: {
                totalRows: 0,
                extractionTime: performanceMetrics?.extractionTime || 0,
                dataType: 'individual'
            }
        };
    }
    
    // Ensure rows and columns exist
    const rows = tableData.rows || [];
    const columns = tableData.columns || [];
    const metadata = tableData.metadata || {
        totalRows: rows.length,
        extractionTime: performanceMetrics?.extractionTime || 0,
        dataType: 'individual'
    };
    
    // Create a single "success" tab for individual reports
    const tabbedData = {
        success: {
            type: 'success',
            rows: rows,
            columns: columns,
            count: rows.length,
            rootPath: 'root',
            availablePaths: [
                { 
                    path: 'root', 
                    type: 'object', 
                    depth: 0, 
                    recommended: true, 
                    description: 'Full response (no extraction)' 
                }
            ]
        },
        metadata: metadata
    };

    return tabbedData;
}

// ===== Transaction Action Functions (GitHub Issue #197: moved to batch-actions.js) =====
// Convenience wrappers for onclick handlers
function deleteTransaction() { batchActions.deleteTransaction(); }
function reprocessBatch() { batchActions.reprocessBatch(); }
function fetchNextPage() { batchActions.fetchNextPage(); }
function rerunTransaction() { batchActions.rerunTransaction(); }
function configurePagination() {
    // GitHub Issue #198: Send message to backend to gather data for pagination modal
    vscode.postMessage({
        type: 'configurePagination',
        correlationId: `configure_pagination_${Date.now()}`,
        source: 'webview',
        target: 'extension',
        timestamp: Date.now(),
        payload: {
            executionId: window.currentExecutionId || CONSOLE_PAGE.EXECUTION_ID
        }
    });
}
function updateTransactionButtons() { batchActions.updateTransactionButtons(); }


// GitHub Issue #197: Second message handler consolidated into the unified handler above

// Reset functions moved to batch-actions.js (GitHub Issue #197)

// GitHub Issue #94/#198: Handle pagination metadata and show pagination controls
function handlePaginationMetadata(paginationData) {
    if (!paginationData || !paginationData.enabled) {
        return; // No pagination, hide controls
    }

    // Store globally for use in Pagination modal
    window.paginationMetadata = paginationData;

    // Directly show pagination button — don't rely on updateButtonVisibility
    // because currentExecutionStatus may be null when re-opening a report
    var paginationBtn = document.getElementById('pagination-btn');
    if (paginationBtn) {
        paginationBtn.classList.remove('hidden');
    }

    // Trigger button visibility update with current status (if available)
    if (window.currentExecutionStatus) {
        updateButtonVisibility(window.currentExecutionStatus);
    }
}

// ===== GitHub Issue #198: Pagination Modal Functions =====

function showPaginationModal(data) {
    const modal = document.getElementById('pagination-modal');
    if (!modal) return;

    // Store context data
    window.paginationSetupData = data;

    // Populate Settings tab
    populatePaginationSettings(data);

    // Default tab logic
    if (!data.existingConfig) {
        // No config: show Settings tab
        switchPaginationTab('settings');
    } else {
        // Config exists: show Execute tab
        switchPaginationTab('execute');
    }

    // Populate Execute tab content based on context
    populateExecuteTab(data);

    modal.classList.remove('hidden');
}

function getSelectedPageSize() {
    const sizeInput = document.getElementById('pagination-size-value');
    if (!sizeInput || !sizeInput.value) return null;
    const parsed = parseInt(sizeInput.value, 10);
    return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

function getSelectedTotalCount() {
    const totalSelect = document.getElementById('pagination-totalcount-select');
    if (!totalSelect || !totalSelect.value) return null;
    const data = window.paginationSetupData;
    if (!data || !data.numericPaths) return null;
    const found = data.numericPaths.find(function(item) { return item.path === totalSelect.value; });
    return found ? found.value : null;
}

function populatePaginationSettings(data) {
    const config = data.existingConfig;
    const qp = data.queryParamsWithValues || [];

    // Populate Page Size inputs
    const sizeKeyInput = document.getElementById('pagination-size-key');
    const sizeValueInput = document.getElementById('pagination-size-value');
    if (sizeKeyInput) {
        if (config && config.sizeParamKey) {
            sizeKeyInput.value = config.sizeParamKey;
        } else {
            // Auto-detect from query params
            var sizeParam = qp.find(function(p) { return ['size', 'pagesize', 'limit', 'perpage', 'per_page'].indexOf(p.key.toLowerCase()) >= 0; });
            sizeKeyInput.value = sizeParam ? sizeParam.key : '';
        }
    }
    if (sizeValueInput) {
        if (config && config.sizeValue) {
            sizeValueInput.value = config.sizeValue;
        } else {
            // Auto-detect from query params
            var sizeParam2 = qp.find(function(p) { return ['size', 'pagesize', 'limit', 'perpage', 'per_page'].indexOf(p.key.toLowerCase()) >= 0; });
            sizeValueInput.value = (sizeParam2 && sizeParam2.value) ? sizeParam2.value : '';
        }
    }

    // Populate Page Number key input
    const paramKeyInput = document.getElementById('pagination-param-key');
    if (paramKeyInput) {
        if (config && config.paramKey) {
            paramKeyInput.value = config.paramKey;
        } else {
            // Auto-detect from query params
            var pageParam = qp.find(function(p) { return ['page', 'pagenumber', 'page_number', 'offset'].indexOf(p.key.toLowerCase()) >= 0; });
            paramKeyInput.value = pageParam ? pageParam.key : '';
        }
    }

    // Pre-select start value radio
    if (config) {
        const startVal = String(config.startValue);
        const radio = document.querySelector('input[name="pagination-start-value"][value="' + startVal + '"]');
        if (radio) radio.checked = true;
    } else if (data.detectedStartValue !== null && data.detectedStartValue !== undefined) {
        // Auto-detect from response when no existing config
        const radio = document.querySelector('input[name="pagination-start-value"][value="' + data.detectedStartValue + '"]');
        if (radio) radio.checked = true;
    }

    // Populate Total Record Count dropdown
    const totalSelect = document.getElementById('pagination-totalcount-select');
    if (totalSelect) {
        totalSelect.innerHTML = '<option value="">None &ndash; manage pages manually</option>';
        const numericPaths = data.numericPaths || [];
        const suggested = numericPaths.filter(function(p) { return p.suggested; });
        const other = numericPaths.filter(function(p) { return !p.suggested; });

        if (suggested.length > 0) {
            const sugGroup = document.createElement('optgroup');
            sugGroup.label = 'Suggested';
            suggested.forEach(function(item) {
                const opt = document.createElement('option');
                opt.value = item.path;
                opt.textContent = item.path + ' = ' + item.value.toLocaleString();
                sugGroup.appendChild(opt);
            });
            totalSelect.appendChild(sugGroup);
        }

        if (other.length > 0) {
            const otherGroup = document.createElement('optgroup');
            otherGroup.label = 'Other numeric fields';
            other.forEach(function(item) {
                const opt = document.createElement('option');
                opt.value = item.path;
                opt.textContent = item.path + ' = ' + item.value.toLocaleString();
                otherGroup.appendChild(opt);
            });
            totalSelect.appendChild(otherGroup);
        }

        // Pre-select from existing config
        if (config && config.totalCountPath) {
            totalSelect.value = config.totalCountPath;
        }
    }

    // Populate Size Path dropdown (reuse numericPaths data)
    const sizePathSelect = document.getElementById('pagination-size-path-select');
    if (sizePathSelect) {
        sizePathSelect.innerHTML = '<option value="">None \u2013 use value above</option>';
        const numericPaths2 = data.numericPaths || [];
        const sizeTargetNames = ['pagesize', 'size', 'limit', 'perpage'];
        const sizeSuggested = numericPaths2.filter(function(p) {
            return sizeTargetNames.indexOf(p.path.split('.').pop().toLowerCase()) >= 0;
        });
        const sizeOther = numericPaths2.filter(function(p) {
            return sizeTargetNames.indexOf(p.path.split('.').pop().toLowerCase()) < 0;
        });

        if (sizeSuggested.length > 0) {
            const sugGroup = document.createElement('optgroup');
            sugGroup.label = 'Suggested';
            sizeSuggested.forEach(function(item) {
                const opt = document.createElement('option');
                opt.value = item.path;
                opt.textContent = item.path + ' = ' + item.value.toLocaleString();
                sugGroup.appendChild(opt);
            });
            sizePathSelect.appendChild(sugGroup);
        }

        if (sizeOther.length > 0) {
            const otherGroup = document.createElement('optgroup');
            otherGroup.label = 'Other numeric fields';
            sizeOther.forEach(function(item) {
                const opt = document.createElement('option');
                opt.value = item.path;
                opt.textContent = item.path + ' = ' + item.value.toLocaleString();
                otherGroup.appendChild(opt);
            });
            sizePathSelect.appendChild(otherGroup);
        }

        // Pre-select from existing config
        if (config && config.sizePath) {
            sizePathSelect.value = config.sizePath;
        }
    }

    // GitHub Issue #245: body pagination — the page/size keys live in the
    // request body, not query params. Lock the key inputs and show a note;
    // the user just picks the total record count (and optional size).
    const settingsContent = document.getElementById('pagination-settings-content');
    const oldNote = document.getElementById('pagination-body-note');
    if (oldNote) oldNote.remove();
    const isBody = !!(config && config.location === 'body');
    // Relabel the key columns so the modal reads as body-based, not query-based.
    const paramKeyLabel = document.getElementById('pagination-param-key-label');
    const sizeKeyLabel = document.getElementById('pagination-size-key-label');
    if (paramKeyLabel) paramKeyLabel.textContent = isBody ? 'Body field (read-only)' : 'Query parameter key';
    if (sizeKeyLabel) sizeKeyLabel.textContent = isBody ? 'Body field (read-only)' : 'Query parameter key';
    if (paramKeyInput) {
        paramKeyInput.readOnly = isBody;
        paramKeyInput.title = isBody ? 'Set in the request body' : '';
    }
    if (sizeKeyInput) {
        sizeKeyInput.readOnly = isBody;
        sizeKeyInput.title = isBody ? 'Set in the request body' : '';
    }
    if (isBody && settingsContent) {
        const note = document.createElement('p');
        note.id = 'pagination-body-note';
        note.className = 'pagination-body-note';
        note.textContent = 'This endpoint paginates via the request body. Pick the total record count below to enable Fetch All — DBMN writes it back into the body template.';
        settingsContent.insertBefore(note, settingsContent.firstChild);
    }
}

function populateExecuteTab(data) {
    const summaryTable = document.getElementById('pagination-summary-table');
    const fetchControl = document.getElementById('pagination-fetch-control');
    const notConfigured = document.getElementById('pagination-not-configured');
    const allFetched = document.getElementById('pagination-all-fetched');
    const runBtn = document.getElementById('pagination-modal-run-btn');

    // Hide all first
    [summaryTable, fetchControl, notConfigured, allFetched].forEach(function(el) {
        if (el) el.classList.add('hidden');
    });
    if (runBtn) runBtn.classList.add('hidden');

    if (!data.existingConfig) {
        if (notConfigured) notConfigured.classList.remove('hidden');
        return;
    }

    // Build summary — only page size, total records, total pages
    const config = data.existingConfig;
    // #446: the page size and pages the API sends (the host works them out), else the size asked for
    const sent = data.sentPages || null;
    const pageSize = sent && sent.pageSize > 0 ? sent.pageSize : (config.sizeValue && config.sizeValue > 0) ? config.sizeValue : null;
    var totalCount = null;
    if (config.totalCountPath && data.numericPaths) {
        const found = data.numericPaths.find(function(item) { return item.path === config.totalCountPath; });
        if (found && typeof found.value === 'number' && found.value >= 0) {
            totalCount = found.value;
        }
    }
    const totalPages = sent && sent.totalPages > 0 ? sent.totalPages : (totalCount !== null && pageSize) ? Math.ceil(totalCount / pageSize) : null;

    // Calculate 1-based display page from raw API page
    var displayPage = null;
    var pm = window.paginationMetadata;
    if (pm && pm.enabled && pm.currentPage !== undefined) {
        var startValue = (pm.startValue !== undefined) ? pm.startValue : (config.startValue || 0);
        displayPage = pm.currentPage - startValue + 1;
    }

    var html = '<table class="pagination-summary"><tbody>';
    if (displayPage !== null && displayPage > 0) {
        var pageLabel = totalPages
            ? '<strong>' + displayPage + '</strong> of <strong>' + totalPages + '</strong>'
            : '<strong>' + displayPage + '</strong>';
        html += '<tr><td>Current page</td><td>' + pageLabel + '</td></tr>';
    }
    if (pageSize) html += '<tr><td>Page size</td><td><strong>' + pageSize.toLocaleString() + '</strong></td></tr>';
    if (totalCount !== null) html += '<tr><td>Total records</td><td><strong>' + totalCount.toLocaleString() + '</strong></td></tr>';
    if (totalPages && displayPage === null) html += '<tr><td>Total pages</td><td><strong>' + totalPages.toLocaleString() + '</strong></td></tr>';
    html += '</tbody></table>';

    if (!pageSize && totalCount === null) {
        html += '<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px;">Configure page size and total count in Settings for automatic page calculation.</p>';
    } else if (!totalCount && pageSize) {
        html += '<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px;">No total count configured. Pages will be fetched one at a time.</p>';
    }

    if (summaryTable) {
        summaryTable.innerHTML = html;
        summaryTable.classList.remove('hidden');
    }

    // Check if all pages already fetched (batch context)
    if (data.isBatch && window.paginationMetadata && window.paginationMetadata.enabled && !window.paginationMetadata.hasMorePages) {
        if (allFetched) allFetched.classList.remove('hidden');
        return;
    }

    // Show fetch control + Run button
    if (fetchControl) {
        fetchControl.classList.remove('hidden');

        // Configure fetch mode options based on what we know
        const fetchAllRadio = document.querySelector('input[name="pagination-fetch-mode"][value="all"]');
        const nextCountInput = document.getElementById('pagination-next-count');

        if (totalPages) {
            // We know total pages — use remainingPages from metadata (already accounts for start value)
            const remaining = (window.paginationMetadata && window.paginationMetadata.remainingPages !== undefined)
                ? Math.max(window.paginationMetadata.remainingPages, 0)
                : Math.max(totalPages - 1, 1);
            if (nextCountInput) {
                nextCountInput.value = 1;
                nextCountInput.max = remaining;
            }
            var nextRadioDefault = document.querySelector('input[name="pagination-fetch-mode"][value="next"]');
            if (nextRadioDefault) nextRadioDefault.checked = true;
        } else {
            // No total pages known — hide "fetch all", default to "get next"
            if (fetchAllRadio) fetchAllRadio.parentElement.classList.add('hidden');
            const nextRadio = document.querySelector('input[name="pagination-fetch-mode"][value="next"]');
            if (nextRadio) nextRadio.checked = true;
            if (nextCountInput) {
                nextCountInput.value = 1;
                nextCountInput.max = '';
            }
        }
    }
    if (runBtn) runBtn.classList.remove('hidden');
}

function switchPaginationTab(tabName) {
    const executeTab = document.getElementById('pagination-tab-execute');
    const settingsTab = document.getElementById('pagination-tab-settings');
    const executeContent = document.getElementById('pagination-execute-content');
    const settingsContent = document.getElementById('pagination-settings-content');
    const saveBtn = document.getElementById('pagination-modal-save-btn');
    const runBtn = document.getElementById('pagination-modal-run-btn');

    if (tabName === 'execute') {
        executeTab.classList.add('active');
        settingsTab.classList.remove('active');
        if (executeContent) executeContent.classList.remove('hidden');
        if (settingsContent) settingsContent.classList.add('hidden');
        if (saveBtn) saveBtn.classList.add('hidden');
        // Show Run if fetch control is visible (config exists and pages available)
        var fetchControl = document.getElementById('pagination-fetch-control');
        if (runBtn && fetchControl && !fetchControl.classList.contains('hidden')) {
            runBtn.classList.remove('hidden');
        }
    } else if (tabName === 'settings') {
        settingsTab.classList.add('active');
        executeTab.classList.remove('active');
        if (settingsContent) settingsContent.classList.remove('hidden');
        if (executeContent) executeContent.classList.add('hidden');
        if (saveBtn) saveBtn.classList.remove('hidden');
        if (runBtn) runBtn.classList.add('hidden');
    }
}

function getSelectedParamKey() {
    const paramKeyInput = document.getElementById('pagination-param-key');
    if (paramKeyInput && paramKeyInput.value.trim()) {
        return paramKeyInput.value.trim();
    }
    return '';
}

function savePaginationSettings() {
    // GitHub Issue #245: body pagination configures templates in the body,
    // so a query parameter key isn't required.
    const setupData = window.paginationSetupData;
    const location = (setupData && setupData.existingConfig && setupData.existingConfig.location) || 'query';
    const paramKey = getSelectedParamKey();
    if (location !== 'body' && !paramKey) {
        showFooterNotification('error', 'Please enter a page number parameter key.');
        return;
    }

    const startValueRadio = document.querySelector('input[name="pagination-start-value"]:checked');
    const startValue = startValueRadio ? parseInt(startValueRadio.value) : 1;

    const totalSelect = document.getElementById('pagination-totalcount-select');
    const totalCountPath = (totalSelect && totalSelect.value) ? totalSelect.value : undefined;

    const sizeKeyInput = document.getElementById('pagination-size-key');
    const sizeValueInput = document.getElementById('pagination-size-value');
    const sizeParamKey = sizeKeyInput ? sizeKeyInput.value.trim() : '';
    const sizeValue = sizeValueInput ? parseInt(sizeValueInput.value, 10) : 0;

    // Validate: if one size field is provided, both must be
    if ((sizeParamKey && (!sizeValue || sizeValue <= 0)) || (!sizeParamKey && sizeValue > 0)) {
        showFooterNotification('error', 'Page Size requires both a parameter key and a value.');
        return;
    }

    const data = window.paginationSetupData;
    if (!data || !data.endpointId) return;

    const sizePathSelect = document.getElementById('pagination-size-path-select');
    const sizePath = (sizePathSelect && sizePathSelect.value) ? sizePathSelect.value : undefined;

    const payload = {
        endpointId: data.endpointId,
        location: location,
        paramKey: paramKey,
        startValue: startValue,
        totalCountPath: totalCountPath,
        execute: false
    };
    if (sizeParamKey && sizeValue > 0) {
        payload.sizeParamKey = sizeParamKey;
        payload.sizeValue = sizeValue;
        if (sizePath) payload.sizePath = sizePath;
    }

    // Flag size change when batch exists so backend can clean up old results
    if (data.existingConfig && data.existingConfig.sizeValue && data.isBatch) {
        if (sizeValue !== data.existingConfig.sizeValue) {
            payload.sizeChanged = true;
            showFooterNotification('info', 'Page size changed. Clearing previous results\u2026');
        }
    }

    vscode.postMessage({
        type: 'savePaginationConfig',
        correlationId: 'save_pagination_config_' + Date.now(),
        source: 'webview',
        target: 'extension',
        timestamp: Date.now(),
        payload: payload
    });
}

function runFromExecuteTab() {
    const data = window.paginationSetupData;
    if (!data || !data.endpointId || !data.existingConfig) return;

    const config = data.existingConfig;

    // GitHub Issue #245: pagination always appends to the CURRENT batch.
    // Only create a batch on the very first run (no batch open yet). Previously
    // this also branched on `paginationMetadata.enabled`, so when detection was
    // momentarily unavailable (e.g. body pagination) a fetch spawned a NEW batch
    // + new console tab instead of adding pages to the open one. The backend
    // recomputes the page range from the batch's own members, so a missing
    // frontend `paginationMetadata` is safe here.
    if (!data.isBatch) {
        var fetchMode = document.querySelector('input[name="pagination-fetch-mode"]:checked');
        var fetchModeValue = fetchMode ? fetchMode.value : 'next';
        var nextInput = document.getElementById('pagination-next-count');
        var fetchCount = (fetchModeValue === 'next' && nextInput) ? parseInt(nextInput.value, 10) : undefined;

        hidePaginationModal();
        var runPayload = {
            endpointId: data.endpointId,
            location: config.location || 'query',
            paramKey: config.paramKey,
            startValue: config.startValue,
            totalCountPath: config.totalCountPath,
            execute: true,
            fetchMode: fetchModeValue
        };
        if (fetchCount && fetchCount > 1) {
            runPayload.fetchCount = fetchCount;
        }
        if (config.sizeParamKey && config.sizeValue) {
            runPayload.sizeParamKey = config.sizeParamKey;
            runPayload.sizeValue = config.sizeValue;
            if (config.sizePath) {
                runPayload.sizePath = config.sizePath;
            }
        }
        vscode.postMessage({
            type: 'savePaginationConfig',
            correlationId: 'run_pagination_' + Date.now(),
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: runPayload
        });
        return;
    }

    // Batch already exists — fetch more pages
    const mode = document.querySelector('input[name="pagination-fetch-mode"]:checked');
    if (!mode) return;

    if (mode.value === 'all') {
        hidePaginationModal();
        vscode.postMessage({
            type: 'getAllPages',
            correlationId: 'get_all_pages_' + Date.now(),
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: { batchId: CONSOLE_PAGE.BATCH_ID }
        });
    } else {
        var nextCountInput = document.getElementById('pagination-next-count');
        var nextCount = nextCountInput ? parseInt(nextCountInput.value, 10) : 1;
        if (isNaN(nextCount) || nextCount < 1) {
            showFooterNotification('error', 'Enter a valid number of pages.');
            return;
        }
        var currentPage = (window.paginationMetadata && window.paginationMetadata.currentPage) || 0;
        var fromPage = currentPage + 1;
        var toPage = currentPage + nextCount;

        hidePaginationModal();
        vscode.postMessage({
            type: 'getPageRange',
            correlationId: 'get_page_range_' + Date.now(),
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: {
                batchId: CONSOLE_PAGE.BATCH_ID,
                fromPage: fromPage,
                toPage: toPage
            }
        });
    }
}

function handlePaginationConfigSaved(msg) {
    if (msg.success) {
        if (msg.batchCleared) {
            // Batch was cleaned up due to size change — reset frontend state
            window.paginationMetadata = null;
            if (window.paginationSetupData) {
                window.paginationSetupData.isBatch = false;
            }
            showFooterNotification('info',
                'Previous batch cleared (' + msg.deletedMembers + ' pages). Run to fetch with new size.');
        }
        if (msg.executed) {
            hidePaginationModal();
        } else {
            // Settings saved: refresh execute tab and switch to it
            if (!msg.batchCleared) {
                showFooterNotification('info', 'Settings saved.');
            }
            if (window.paginationSetupData) {
                const totalSelect = document.getElementById('pagination-totalcount-select');
                const sizeKeyInput = document.getElementById('pagination-size-key');
                const sizeValueInput = document.getElementById('pagination-size-value');
                const sizeParamKey = sizeKeyInput ? sizeKeyInput.value.trim() : '';
                const sizeValue = sizeValueInput ? parseInt(sizeValueInput.value, 10) : 0;
                const sizePathSelect = document.getElementById('pagination-size-path-select');
                const sizePath = (sizePathSelect && sizePathSelect.value) ? sizePathSelect.value : undefined;

                const updatedConfig = {
                    paramKey: getSelectedParamKey(),
                    startValue: parseInt(document.querySelector('input[name="pagination-start-value"]:checked')?.value || '1'),
                    totalCountPath: (totalSelect && totalSelect.value) ? totalSelect.value : undefined
                };
                if (sizeParamKey && sizeValue > 0) {
                    updatedConfig.sizeParamKey = sizeParamKey;
                    updatedConfig.sizeValue = sizeValue;
                    if (sizePath) updatedConfig.sizePath = sizePath;
                }
                window.paginationSetupData.existingConfig = updatedConfig;
                populateExecuteTab(window.paginationSetupData);
            }
            switchPaginationTab('execute');
        }
    } else {
        showFooterNotification('error', msg.error || 'Failed to save pagination settings.');
    }
}

function hidePaginationModal() {
    const modal = document.getElementById('pagination-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
    window.paginationSetupData = null;
}

// Event Listeners for Pagination Modal
document.addEventListener('DOMContentLoaded', () => {
    // Pagination button click
    const paginationBtn = document.getElementById('pagination-btn');
    if (paginationBtn) {
        paginationBtn.addEventListener('click', configurePagination);
    }

    // Tab clicks (div.tab-item, not buttons)
    const executeTab = document.getElementById('pagination-tab-execute');
    const settingsTab = document.getElementById('pagination-tab-settings');
    if (executeTab) executeTab.addEventListener('click', () => switchPaginationTab('execute'));
    if (settingsTab) settingsTab.addEventListener('click', () => switchPaginationTab('settings'));

    // Close / Cancel
    const closeBtn = document.getElementById('pagination-modal-close');
    const cancelBtn = document.getElementById('pagination-modal-cancel-btn');
    if (closeBtn) closeBtn.addEventListener('click', hidePaginationModal);
    if (cancelBtn) cancelBtn.addEventListener('click', hidePaginationModal);

    // Footer Save button
    const footerSaveBtn = document.getElementById('pagination-modal-save-btn');
    if (footerSaveBtn) footerSaveBtn.addEventListener('click', savePaginationSettings);

    // Footer Run button
    const footerRunBtn = document.getElementById('pagination-modal-run-btn');
    if (footerRunBtn) footerRunBtn.addEventListener('click', runFromExecuteTab);

    // Go to Settings button (not-configured state)
    const goToSettingsBtn = document.getElementById('pagination-go-to-settings');
    if (goToSettingsBtn) goToSettingsBtn.addEventListener('click', () => switchPaginationTab('settings'));

    // Size path dropdown change → auto-populate the Value field
    const sizePathSelect = document.getElementById('pagination-size-path-select');
    if (sizePathSelect) {
        sizePathSelect.addEventListener('change', function() {
            const sizeValueInput = document.getElementById('pagination-size-value');
            if (!sizeValueInput || !window.paginationSetupData) return;
            const selectedPath = sizePathSelect.value;
            if (!selectedPath) return; // "None" selected
            const numericPaths = window.paginationSetupData.numericPaths || [];
            const match = numericPaths.find(function(p) { return p.path === selectedPath; });
            if (match && typeof match.value === 'number') {
                sizeValueInput.value = match.value;
            }
        });
    }
});

// Update buttons when page loads
document.addEventListener('DOMContentLoaded', updateTransactionButtons);

// ===== REPORT SETTINGS MODULE (GitHub Issue #197) =====
window.consoleSettings = new ConsoleSettings(vscode);

// Convenience wrappers for inline callers
function applyConsoleSettings(settings, endpointId) { consoleSettings.applyConsoleSettings(settings, endpointId); }
function saveConsoleSettings() { consoleSettings.saveConsoleSettings(); }
function debouncedSaveSettings() { consoleSettings.debouncedSaveSettings(); }

// ===== updateButtonVisibility moved to batch-actions.js (GitHub Issue #197) =====

// ===== GITHUB ISSUE #156: INFO TAB FUNCTIONS =====

// Track current execution status for enabling/disabling controls
let currentExecutionStatus = null;

/**
 * Initialize Info tab based on batch vs individual execution
 */
function initInfoTab(isBatch) {
    const configureSection = document.getElementById('info-configure-section');
    const httpStatusStat = document.getElementById('info-http-status-stat');
    const idLabel = document.getElementById('info-id-label');
    const lineageSection = document.getElementById('info-lineage-section');

    if (!isBatch) {
        // Individual: hide batch-specific sections
        if (configureSection) configureSection.style.display = 'none';
        if (idLabel) idLabel.textContent = 'Execution ID';
    } else {
        // Batch: show all sections, update ID label
        if (configureSection) configureSection.style.display = 'block';
        if (httpStatusStat) httpStatusStat.style.display = 'none'; // HTTP status per-transaction, not batch-level
        if (idLabel) idLabel.textContent = 'Batch ID';

        // Set up event listeners for editable fields
        setupInfoTabEventListeners();

        // GitHub Issue #156: Filter threads dropdown based on environment max concurrency
        filterThreadsDropdown(maxThreadCount);

        // Set initial values from current state
        const threadsDropdown = document.getElementById('info-threads');
        if (threadsDropdown && currentThreadCount) {
            threadsDropdown.value = currentThreadCount;
        }

        // Set initial enabled state based on current status
        // Check status badge for initial state
        const statusBadge = document.getElementById('status-badge');
        const statusText = statusBadge ? statusBadge.textContent.toLowerCase() : '';
        const isComplete = statusText.includes('completed') || statusText.includes('failed') ||
                           statusText.includes('cancelled') || statusText.includes('error');
        setInfoTabControlsEnabled(isComplete);
        paintProgressStats();
    }

    // Hide lineage section if no copy batch info
    const copiedFromBatchStat = document.getElementById('info-copied-from-batch-stat');
    const hasLineage = copiedFromBatchStat && !copiedFromBatchStat.classList.contains('hidden');
    if (lineageSection && !hasLineage) {
        lineageSection.style.display = 'none';
    }
}

/**
 * GitHub Issue #156: Filter threads dropdown based on environment max concurrency
 * Same logic as data-transformer.js populateProcessingModeDropdown
 */
function filterThreadsDropdown(envMaxConcurrency) {
    const dropdown = document.getElementById('info-threads');
    if (!dropdown) return;

    const maxAllowed = envMaxConcurrency || 16;

    // Remove options that exceed environment max
    Array.from(dropdown.options).forEach(option => {
        const value = parseInt(option.value, 10);
        if (value > maxAllowed) {
            option.remove();
        }
    });

    // Update description to show max
    const desc = document.getElementById('info-threads-desc');
    if (desc && maxAllowed < 16) {
        desc.textContent = `API calls at the same time (this environment allows up to ${maxAllowed})`;
    }
}

/**
 * Enable or disable Info tab Configure controls
 * - Name: Always editable
 * - Threads & Error Handling: Editable when NOT complete
 */
function setInfoTabControlsEnabled(isComplete) {
    const batchNameInput = document.getElementById('info-batch-name');
    const errorModeRadios = document.querySelectorAll('input[name="infoErrorMode"]');
    const threadsDropdown = document.getElementById('info-threads');
    const radioGroup = document.querySelector('#info-configure-section .radio-group');

    // Name is always editable
    if (batchNameInput) batchNameInput.disabled = false;

    // Threads and Error Handling editable when NOT complete
    const canEditExecution = !isComplete;
    errorModeRadios.forEach(radio => radio.disabled = !canEditExecution);
    if (threadsDropdown) threadsDropdown.disabled = !canEditExecution;

    // Visual feedback - add/remove disabled class for CSS styling
    if (radioGroup) {
        radioGroup.classList.toggle('disabled', !canEditExecution);
    }
}

/**
 * Update Info tab controls enabled state based on execution status
 */
function updateInfoTabForStatus(status) {
    currentExecutionStatus = status;
    const isBatch = !!window.currentBatchId;

    if (isBatch) {
        // Complete states where execution controls should be disabled
        const isComplete = status === 'completed' || status === 'failed' ||
                           status === 'cancelled' || status === 'error';
        setInfoTabControlsEnabled(isComplete);
        paintProgressStats();
    }
}

/**
 * The progress box's figures (a click on the box, or a hover): what a batch runs with, and what may
 * be changed while it runs: Threads (a button each, those over the environment's limit switched off)
 * and Stop on next error (a switch: while a batch runs it is the next error that stops it). The
 * same settings as the Settings tab's, kept in step both ways. Done, they are plain figures.
 */
const THREAD_CHOICES = [1, 2, 4, 8, 16];
function paintProgressStats() {
    const box = document.getElementById('progress-display');
    if (!box || !('stats' in box)) return;
    if (!window.currentBatchId) { box.stats = []; return; }
    const status = String(currentExecutionStatus || '').toLowerCase();
    const done = ['completed', 'failed', 'cancelled', 'error', 'stopped'].includes(status);
    const radio = document.querySelector('input[name="infoErrorMode"]:checked');
    const stopOnNext = !!(radio && radio.value === 'stopOnFirst');
    const stats = done ? [
        { label: 'Threads', value: String(currentThreadCount) },
        { label: 'Error handling', value: stopOnNext ? 'Stop on first error' : 'Continue processing' }
    ] : [
        { id: 'threads', label: 'Threads', value: currentThreadCount, options: THREAD_CHOICES, max: maxThreadCount || 16, overTitle: `This environment allows up to ${maxThreadCount || 16}` },
        { id: 'stopOnError', label: 'Stop on next error', value: stopOnNext }
    ];
    const handler = window.progressHandler;
    if (handler && handler.executionStartTime) {
        stats.push({ label: 'Started', value: new Date(handler.executionStartTime).toLocaleTimeString() });
    }
    box.stats = stats;
}
function listenToProgressBox() {
    const box = document.getElementById('progress-display');
    if (!box || box.dataset.listening) return;
    box.dataset.listening = '1';
    // The box only asks; the change goes the Settings tab's way, and its control follows
    box.addEventListener('dbmn-progress-change', event => {
        const { id, value } = event.detail || {};
        if (id === 'threads') {
            const n = Number(value);
            if (!(n >= 1) || n > (maxThreadCount || 16)) return;
            const dropdown = document.getElementById('info-threads');
            if (dropdown) dropdown.value = String(n);
            updateInfoThreadCount(n);
        } else if (id === 'stopOnError') {
            const radio = document.querySelector(`input[name="infoErrorMode"][value="${value ? 'stopOnFirst' : 'continue'}"]`);
            if (radio) radio.checked = true;
            updateInfoErrorMode(!!value);
        }
        paintProgressStats();
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', listenToProgressBox);
else listenToProgressBox();

/**
 * Set up event listeners for Info tab form controls
 */
function setupInfoTabEventListeners() {
    // Batch name input - save on blur or Enter
    const batchNameInput = document.getElementById('info-batch-name');
    if (batchNameInput) {
        batchNameInput.addEventListener('change', function() {
            updateInfoBatchName(this.value);
        });
        batchNameInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                updateInfoBatchName(this.value);
                this.blur();
            }
        });
    }

    // Error handling radio buttons
    const errorModeRadios = document.querySelectorAll('input[name="infoErrorMode"]');
    errorModeRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            const stopOnFirst = this.value === 'stopOnFirst';
            updateInfoErrorMode(stopOnFirst);
            paintProgressStats();
        });
    });

    // Processing mode dropdown
    const threadsDropdown = document.getElementById('info-threads');
    if (threadsDropdown) {
        threadsDropdown.addEventListener('change', function() {
            updateInfoThreadCount(parseInt(this.value, 10));
            paintProgressStats();
        });
    }
}

/** A Settings change was sent: said in a toast (the footer holds only actions and the progress box). */
function showInfoNotification(message) {
    if (window.DbmnToast) window.DbmnToast.info(message);
}

/**
 * Update batch name via backend command
 */
function updateInfoBatchName(name) {
    if (!window.currentBatchId || !name.trim()) return;
    // Issue #312: a direct Console message (the dbmn.updateBatch* commands are gone)
    vscode.postMessage({ type: 'updateBatchName', payload: { batchId: window.currentBatchId, name: name.trim() } });
    // #445: the title carries the batch's name too
    const titleName = document.getElementById('report-title-name');
    if (titleName) titleName.textContent = name.trim();
    showInfoNotification('Batch name updated');
}

/**
 * Update error handling mode via backend command
 */
function updateInfoErrorMode(stopOnFirst) {
    if (!window.currentBatchId) return;
    vscode.postMessage({ type: 'updateBatchErrorMode', payload: { batchId: window.currentBatchId, stopOnFirstError: stopOnFirst } });
    const modeText = stopOnFirst ? 'Stop on next error' : 'Continue processing';
    showInfoNotification(`Error handling: ${modeText}`);
}

/**
 * Update thread count via backend command
 */
function updateInfoThreadCount(threads) {
    if (!window.currentBatchId) return;

    console.log(`[Settings] Updating threads: ${currentThreadCount} → ${threads} for batch ${window.currentBatchId}`);

    vscode.postMessage({ type: 'updateBatchConcurrency', payload: { batchId: window.currentBatchId, concurrency: threads } });

    currentThreadCount = threads;
    showInfoNotification(`Threads: ${threads}`);
}

/**
 * Update Info tab duration display (called on status changes)
 */
function updateInfoTabDuration() {
    // Duration is rendered server-side with {{DURATION}} placeholder
    // For live updates during execution, we could update info-duration here
    // but the duration is typically updated via full report refresh
}

// ===== END INFO TAB FUNCTIONS =====

function updateLogsTabIndicator(status) {
    const indicator = document.getElementById('logs-tab-indicator');
    if (!indicator) return;

    // Show indicator for active execution states
    const isActiveExecution = status === 'preparing' || status === 'running';

    // Hide only for terminal states (execution truly finished)
    const isTerminalState = status === 'completed' || status === 'failed' ||
                           status === 'stopped' || status === 'cancelled';

    // Sticky behavior: only change visibility on explicit state changes
    if (isActiveExecution) {
        indicator.classList.remove('hidden');
    } else if (isTerminalState) {
        indicator.classList.add('hidden');
    }
    // Otherwise: do nothing (keep current visibility to prevent flashing during streaming)
}

// ===== Dynamic button handlers moved to batch-actions.js (GitHub Issue #197) =====
// Convenience wrappers for onclick handlers
function cancelExecution() { batchActions.cancelExecution(); }
function pauseBatch() { batchActions.pauseBatch(); }
function resumeBatch() { batchActions.resumeBatch(); }

// #372: what the Console's markup may call (data-click); the web app's CSP refuses inline handlers.
// The footer's functions are this script's globals, looked up when clicked as inline handlers did.
window.DbmnActions.register({
    'console:hideColumn': id => dynamicReportManager.hideColumn(id),
    'console:hideColumnGroup': id => dynamicReportManager.hideColumnGroup(id),
    'console:hideSubColumn': (absoluteId, _event, element) => dynamicReportManager.hideSubColumn(absoluteId, element.getAttribute('data-registry')),
    'console:sortSubTable': (registryId, event, element) => {
        if (event.target.classList.contains('column-hide-btn')) return;
        dynamicReportManager.sortSubTable(registryId, element.getAttribute('data-key'));
    },
    'console:toggleArrayExpansion': id => window.toggleArrayExpansion(id),
    'console:setRowBasisOnActiveView': path => dynamicReportManager.setRowBasisOnActiveView(path),
    deleteTransaction: () => window.deleteTransaction(),
    rerunTransaction: () => window.rerunTransaction(),
    reprocessBatch: () => window.reprocessBatch(),
    fetchNextPage: () => window.fetchNextPage(),
    pauseBatch: () => window.pauseBatch(),
    resumeBatch: () => window.resumeBatch(),
    cancelExecution: () => window.cancelExecution(),
    clearFooterNotification: () => window.clearFooterNotification()
});

// #438: the Hub says what colour this Console's tab is drawn in (hub-tabs.js, hubTabColour); the
// heading wears the same (console.css, html[data-tab-colour]), so the two never disagree.
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'hubTabColour') return;
    // 'none': the tab is drawn plain (no progress yet), so the heading is too
    document.documentElement.dataset.tabColour = message.colour || 'none';
});
