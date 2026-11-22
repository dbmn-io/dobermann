// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's page: console/console.html filled in for one run (moved from
 * ConsoleWebviewManager.generateHtmlContent, #343). Any host: `asset` maps a path under
 * src/webviews to a URL. File links only show for files that exist (Node fs, or the web
 * app's in-browser one).
 */
import type { AssetUrl } from '../pages';
import type { ConsoleWebviewConfig } from './console.controller';

/** console.html's script placeholders → their files. */
const SCRIPTS: Record<string, string> = {
    TIME_FORMATTER_URI: 'shared/time-formatter.js',
    CONSOLE_TABLE_BUILDER_URI: 'shared/console-table-builder.js',
    CONSOLE_LIVE_COUNTS_URI: 'shared/console-live-counts.js',
    CONSOLE_ERROR_REASON_URI: 'shared/console-error-reason.js', // #428
    SEARCH_MATCHER_URI: 'shared/search-matcher.js',
    DOCUMENTATION_HELPERS_URI: 'shared/documentation-helpers.js',
    RAW_TAB_HANDLER_URI: 'console/modules/raw-tab-handler.js',
    PROGRESS_HANDLER_URI: 'console/modules/progress-handler.js',
    BATCH_ACTIONS_URI: 'console/modules/batch-actions.js',
    CONSOLE_CHAIN_URI: 'console/modules/console-chain.js', // GitHub Issue #247
    HELP_MODE_URI: 'shared/help-mode.js',
    BUTTON_CONTRAST_URI: 'shared/button-contrast.js',
    CONSOLE_HELP_URI: 'console/modules/console-help.js',
    EXECUTION_ACTIONS_URI: 'shared/execution-actions.js',
    CONSOLE_SETTINGS_URI: 'console/modules/console-settings.js',
    DATA_NAVIGATOR_URI: 'console/modules/data-navigator.js',
    MONACO_THEME_URI: 'shared/monaco-theme.js',
    ICONS_SCRIPT: 'shared/icons.js',
    DBMN_FOOTER_URI: 'shared/dbmn-footer.js',
    DBMN_TABLE_URI: 'shared/dbmn-table.js',
    REQUEST_PREVIEW_URI: 'shared/request-preview.js', // the request card's INPUT section, shared with Run Batch's Review
    EDITOR_WINDOW_CONTROLS_SCRIPT: 'shared/editor-window-controls.js',
    DBMN_TOAST_URI: 'shared/dbmn-toast.js',
    DBMN_CLIPBOARD_URI: 'shared/dbmn-clipboard.js',
    DBMN_MODAL_URI: 'shared/dbmn-modal.js',
    ROW_PASTE_URI: 'shared/row-paste.js',
    VALUE_FORMATTER_URI: 'shared/value-formatter.js',
    CELL_DETAIL_URI: 'shared/cell-detail.js',
    VIRTUAL_WINDOW_URI: 'shared/virtual-window.js',
    COLUMN_DRAG_URI: 'shared/column-drag.js',
    COLUMN_HEAD_URI: 'shared/column-head.js',
    DBMN_CONTEXT_MENU_URI: 'shared/dbmn-context-menu.js',
    INPUT_ROW_STATUS_URI: 'shared/input-row-status.js', // Issue #304
    // #372: the page's own scripts, files rather than inline (the web app's CSP refuses inline script)
    CONSOLE_BOOT_URI: 'console/console-boot.js',
    CONSOLE_PAGE_URI: 'console/console-page.js',
    CONSOLE_COMPARE_URI: 'console/modules/console-compare.js', // #298
    DBMN_ACTIONS_URI: 'shared/dbmn-actions.js',
    MONACO_LOADER_CONFIG_URI: 'shared/monaco-loader-config.js'
};

/** The Raw tab's transaction card is shared with Run Batch Step 4 (GitHub Issue #308). */
const STYLES = ['atomic', 'core', 'modals', 'tables', 'tabs', 'toast', 'console', 'search', 'transaction-card', 'column-drag', 'column-head', 'dbmn-footer', 'dbmn-table'];

function base64Utf8(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
}

export function buildConsolePage(template: string, asset: AssetUrl, config: ConsoleWebviewConfig): string {
    let html = template;
    html = html.replace(/{{SHARED_STYLES}}/g, STYLES.map(name => `<link rel="stylesheet" href="${asset(`shared/${name}.css`)}">`).join('\n'));
    for (const [placeholder, file] of Object.entries(SCRIPTS)) {
    html = html.split(`{{${placeholder}}}`).join(asset(file));
    }
    html = html.replace(/{{REPORT_TYPE}}/g, config.type);
    html = html.replace(/{{EXECUTION_ID}}/g, config.executionId || '');
    html = html.replace(/{{BATCH_ID}}/g, config.batchId || '');
    html = html.replace(/{{ENDPOINT_NAME}}/g, config.executionSummary?.endpointName || 'Unknown');
    // #445: a batch's own name; a run without one (single runs, batches from before) shows its endpoint's
    html = html.replace(/{{BATCH_NAME}}/g, config.executionSummary?.batchName || config.executionSummary?.endpointName || 'Unknown');

    // Replace execution summary placeholders
    if (config.executionSummary) {
        // Environment and Organization as separate fields
        const env = config.executionSummary.environment && config.executionSummary.environment !== 'Unknown' ?
            config.executionSummary.environment : '';
        const org = config.executionSummary.organization && config.executionSummary.organization !== 'Unknown' ?
            config.executionSummary.organization : '';

        html = html.replace(/{{ENVIRONMENT}}/g, env);
        html = html.replace(/{{AGENT_LINK_VISIBILITY}}/g, config.executionSummary.runsInVsCode ? '' : 'hidden');
        html = html.replace(/{{ORGANIZATION}}/g, org);
        html = html.replace(/{{ENDPOINT_METHOD}}/g, config.executionSummary.endpointMethod || 'Unknown');
        html = html.replace(/{{ENDPOINT_PATH}}/g, config.executionSummary.endpointPath || 'Unknown');

        // Construct environment path for title: Environment/Org/Path
        let environmentPath = '';
        if (env) {
            environmentPath = env;
            if (org) {
                environmentPath += `/${org}`;
            }
        }
        if (config.executionSummary.endpointPath) {
            environmentPath += config.executionSummary.endpointPath;
        }
        html = html.replace(/{{ENVIRONMENT_PATH}}/g, environmentPath);

        // Construct full URL from environment baseUrl + endpoint path
        // The base URL comes from the environment; without it (signed out, the environment
        // gone), the path is still worth showing
        let fullUrl = config.executionSummary?.endpointPath || 'Unknown';
        if (config.executionSummary?.baseUrl && config.executionSummary.endpointPath) {
            const baseUrl = config.executionSummary.baseUrl.endsWith('/') ?
                config.executionSummary.baseUrl.slice(0, -1) :
                config.executionSummary.baseUrl;
            fullUrl = `${baseUrl}${config.executionSummary.endpointPath}`;
        }
        html = html.replace(/{{FULL_URL}}/g, fullUrl);
        html = html.replace(/{{TRANSACTION_COUNT}}/g, (config.executionSummary.transactionCount || 0).toString());
        html = html.replace(/{{RECORDS}}/g, (config.executionSummary.records || 0).toString());

        // GitHub Issue #102: Diagnostic stats for batch transaction counts
        html = html.replace(/{{EXPECTED_TRANSACTIONS}}/g, (config.executionSummary.expectedTransactions || 0).toString());
        html = html.replace(/{{ACTUAL_TRANSACTIONS}}/g, (config.executionSummary.actualTransactions || 0).toString());
        // Smart date/time formatting for start time
        let startTimeDisplay = 'Unknown';
        if (config.executionSummary.executedAt) {
            const executedDate = new Date(config.executionSummary.executedAt);
            const today = new Date();
            const isToday = executedDate.toDateString() === today.toDateString();

            if (isToday) {
                // Just show time if today
                startTimeDisplay = executedDate.toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
            } else {
                // Show date + time if not today
                startTimeDisplay = executedDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric'
                }) + ' ' + executedDate.toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
        }
        html = html.replace(/{{EXECUTED_AT}}/g, startTimeDisplay);

        // Enhanced status display with icon
        let statusDisplay = 'Unknown';
        if (config.executionSummary.status) {
            const status = config.executionSummary.status.toLowerCase();
            if (status === 'completed') {
                statusDisplay = '✅ Completed';
            } else if (status === 'failed' || status === 'error') {
                statusDisplay = '❌ Failed';
            } else if (status === 'running' || status === 'processing') {
                statusDisplay = '🔄 Running';
            } else if (status === 'partial') {
                statusDisplay = '⚠️ Partial Success';
            } else {
                statusDisplay = `${config.executionSummary.status}`;
            }
        }
        html = html.replace(/{{STATUS_DISPLAY}}/g, statusDisplay);

        // HTTP Status display for the tile: "200 (OK)" or "404 (Not Found)"
        let httpStatusDisplay = 'Unknown';
        let httpStatusVisibility = 'hidden'; // Hide by default
        const httpStatus = config.executionSummary.httpStatus;
        const httpStatusText = config.executionSummary.statusText;

        if (httpStatus && httpStatusText) {
            httpStatusDisplay = `${httpStatus} (${httpStatusText})`;
            httpStatusVisibility = ''; // Show if we have both
        } else if (httpStatus) {
            httpStatusDisplay = `${httpStatus}`;
            httpStatusVisibility = ''; // Show if we have status code
        } else if (httpStatusText) {
            httpStatusDisplay = httpStatusText;
            httpStatusVisibility = ''; // Show if we have status text
        }
        html = html.replace(/{{HTTP_STATUS_DISPLAY}}/g, httpStatusDisplay);
        html = html.replace(/{{HTTP_STATUS_VISIBILITY}}/g, httpStatusVisibility);

        // Execution status for title (no emoji, just text)
        let executionStatus = 'UNKNOWN';
        let titleStatusClass = '';
        let statusPillClass = 'status-pill-default';

        if (config.executionSummary.status) {
            const statusLower = config.executionSummary.status.toLowerCase();
            if (statusLower === 'completed') {
                executionStatus = 'COMPLETED';
                titleStatusClass = 'title-success';
                statusPillClass = 'status-pill-success';
            } else if (statusLower === 'failed' || statusLower === 'error') {
                executionStatus = 'ERROR';
                titleStatusClass = 'title-error';
                statusPillClass = 'status-pill-error';
            } else if (statusLower === 'running' || statusLower === 'processing') {
                executionStatus = 'RUNNING';
                titleStatusClass = 'title-running';
                statusPillClass = 'status-pill-running';
            } else if (statusLower === 'partial') {
                executionStatus = 'PARTIAL';
                titleStatusClass = 'title-partial';
                statusPillClass = 'status-pill-partial';
            } else if (statusLower === 'cancelled') {
                executionStatus = 'CANCELLED';
                titleStatusClass = 'title-stopped';
                statusPillClass = 'status-pill-cancelled';
            } else if (statusLower === 'paused') {
                executionStatus = 'PAUSED';
                titleStatusClass = 'title-warning';
                statusPillClass = 'status-pill-paused';
            } else if (statusLower === 'stopped') {
                executionStatus = 'STOPPED';
                titleStatusClass = 'title-stopped';
                statusPillClass = 'status-pill-stopped';
            } else if (statusLower === 'preparing') {
                executionStatus = 'PREPARING';
                titleStatusClass = 'title-preparing';
                statusPillClass = 'status-pill-preparing';
            } else {
                executionStatus = config.executionSummary.status.toUpperCase();
                statusPillClass = 'status-pill-default';
            }
        }

        html = html.replace(/{{EXECUTION_STATUS}}/g, executionStatus);
        html = html.replace(/{{TITLE_STATUS_CLASS}}/g, titleStatusClass);
        html = html.replace(/{{STATUS_PILL_CLASS}}/g, statusPillClass);

        // Duration formatting
        let durationDisplay = '-';
        if (config.executionSummary.duration) {
            if (config.executionSummary.duration < 1000) {
                durationDisplay = `${config.executionSummary.duration}ms`;
            } else if (config.executionSummary.duration < 60000) {
                durationDisplay = `${(config.executionSummary.duration / 1000).toFixed(1)}s`;
            } else {
                const minutes = Math.floor(config.executionSummary.duration / 60000);
                const seconds = Math.floor((config.executionSummary.duration % 60000) / 1000);
                durationDisplay = `${minutes}m ${seconds}s`;
            }
        }
        html = html.replace(/{{DURATION}}/g, durationDisplay);

        // GitHub Issue #102: Max threads (concurrency)
        const maxThreads = config.executionSummary.concurrency ? config.executionSummary.concurrency.toString() : '-';
        html = html.replace(/{{MAX_THREADS}}/g, maxThreads);

        // GitHub Issue #156: Initial concurrency for thread control
        const initialConcurrency = config.executionSummary.concurrency || 1;
        html = html.replace(/{{INITIAL_CONCURRENCY}}/g, initialConcurrency.toString());
        // GitHub Issue #156: Use environment's max concurrency (not batch's current concurrency)
        const envMaxConcurrency = config.executionSummary.environmentMaxConcurrency || 16;
        html = html.replace(/{{MAX_CONCURRENCY}}/g, envMaxConcurrency.toString());

        // Error message
        html = html.replace(/{{ERROR_MESSAGE}}/g, config.executionSummary.errorMessage || '');

        // Reprocess tracking: cross-batch fields deprecated (in-batch reprocess overhaul)
        // Input tab is always shown now (no child batches)
        html = html.replace(/{{HIDE_INPUT_TAB}}/g, 'false');

        // GitHub Issue #176: Batch copy lineage fields
        const copiedFromBatchId = config.executionSummary.copiedFromBatchId || '';
        const copiedFromEnvironment = config.executionSummary.copiedFromEnvironment || '';
        const copiedAt = config.executionSummary.copiedAt || '';
        const hasCopyInfo = copiedFromBatchId.length > 0;
        html = html.replace(/{{COPIED_FROM_BATCH_ID}}/g, copiedFromBatchId);
        html = html.replace(/{{COPIED_FROM_ENVIRONMENT}}/g, copiedFromEnvironment);
        html = html.replace(/{{COPIED_AT}}/g, copiedAt);
        html = html.replace(/{{COPY_INFO_VISIBILITY}}/g, hasCopyInfo ? '' : 'hidden');

        // GitHub Issue #176: Lineage badge in header (COPIED)
        if (hasCopyInfo) {
            html = html.replace(/{{LINEAGE_BADGE_TEXT}}/g, 'COPIED');
            html = html.replace(/{{LINEAGE_BADGE_VISIBILITY}}/g, '');
        } else {
            html = html.replace(/{{LINEAGE_BADGE_TEXT}}/g, '');
            html = html.replace(/{{LINEAGE_BADGE_VISIBILITY}}/g, 'hidden');
        }

        // Navigation: Endpoint and Environment IDs for clickable links
        html = html.replace(/{{ENDPOINT_ID}}/g, config.endpointId || '');
        html = html.replace(/{{ENVIRONMENT_ID}}/g, config.executionSummary.environmentId || '');

        // ENV variables: base64-encode JSON to avoid HTML escaping issues
        const envVars = config.executionSummary.environmentVariables;
        const envVarsJson = envVars && Object.keys(envVars).length > 0 ? base64Utf8(JSON.stringify(envVars)) : '';
        html = html.replace(/{{ENVIRONMENT_VARIABLES_JSON}}/g, envVarsJson);
    } else {
        // Fallback values when no execution summary available
        html = html.replace(/{{ENVIRONMENT}}/g, '');
        html = html.replace(/{{AGENT_LINK_VISIBILITY}}/g, 'hidden');
        html = html.replace(/{{ORGANIZATION}}/g, '');
        html = html.replace(/{{ENDPOINT_METHOD}}/g, 'Unknown');
        html = html.replace(/{{ENDPOINT_PATH}}/g, 'Unknown');
        html = html.replace(/{{ENVIRONMENT_PATH}}/g, 'Unknown');
        html = html.replace(/{{FULL_URL}}/g, 'Unknown');
        html = html.replace(/{{TRANSACTION_COUNT}}/g, '0');
        html = html.replace(/{{REQUEST_FILE}}/g, 'Unknown');
        html = html.replace(/{{RECORDS}}/g, '0');
        html = html.replace(/{{EXECUTED_AT}}/g, 'Unknown');
        html = html.replace(/{{STATUS_DISPLAY}}/g, 'Unknown');
        html = html.replace(/{{HTTP_STATUS_DISPLAY}}/g, 'Unknown');
        html = html.replace(/{{HTTP_STATUS_VISIBILITY}}/g, 'hidden');
        html = html.replace(/{{DURATION}}/g, '-');
        html = html.replace(/{{EXECUTION_STATUS}}/g, 'UNKNOWN');
        html = html.replace(/{{TITLE_STATUS_CLASS}}/g, '');
        html = html.replace(/{{STATUS_PILL_CLASS}}/g, 'status-pill-default');
        html = html.replace(/{{ERROR_MESSAGE}}/g, '');
        html = html.replace(/{{MAX_THREADS}}/g, '-');
        // GitHub Issue #156: Initial concurrency fallbacks
        html = html.replace(/{{INITIAL_CONCURRENCY}}/g, '1');
        html = html.replace(/{{MAX_CONCURRENCY}}/g, '1');
        html = html.replace(/{{HIDE_INPUT_TAB}}/g, 'false');
        // GitHub Issue #176: Batch copy lineage fallbacks
        html = html.replace(/{{COPIED_FROM_BATCH_ID}}/g, '');
        html = html.replace(/{{COPIED_FROM_ENVIRONMENT}}/g, '');
        html = html.replace(/{{COPIED_AT}}/g, '');
        html = html.replace(/{{COPY_INFO_VISIBILITY}}/g, 'hidden');
        html = html.replace(/{{LINEAGE_BADGE_TEXT}}/g, '');
        html = html.replace(/{{LINEAGE_BADGE_VISIBILITY}}/g, 'hidden');
        // Navigation fallbacks
        html = html.replace(/{{ENDPOINT_ID}}/g, config.endpointId || '');
        html = html.replace(/{{ENVIRONMENT_ID}}/g, '');
        html = html.replace(/{{ENVIRONMENT_VARIABLES_JSON}}/g, '');
    }


    return html;
}
