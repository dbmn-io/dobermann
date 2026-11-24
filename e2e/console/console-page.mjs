/**
 * The REAL Console page for Playwright, loaded straight from src/ — no VS Code, no backend.
 * consolePage() fills the placeholders console-webview-manager.ts fills; envelope() wraps a
 * payload the way the host posts it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEBVIEWS = join(ROOT, 'src/webviews');

/** Placeholder → the file console-webview-manager.ts points it at. */
const SCRIPTS = {
    TIME_FORMATTER_URI: 'shared/time-formatter.js',
    CONSOLE_TABLE_BUILDER_URI: 'shared/console-table-builder.js',
    CONSOLE_LIVE_COUNTS_URI: 'shared/console-live-counts.js',
    CONSOLE_ERROR_REASON_URI: 'shared/console-error-reason.js', // #428
    SEARCH_MATCHER_URI: 'shared/search-matcher.js',
    DOCUMENTATION_HELPERS_URI: 'shared/documentation-helpers.js',
    RAW_TAB_HANDLER_URI: 'console/modules/raw-tab-handler.js',
    PROGRESS_HANDLER_URI: 'console/modules/progress-handler.js',
    EXECUTION_ACTIONS_URI: 'shared/execution-actions.js',
    BATCH_ACTIONS_URI: 'console/modules/batch-actions.js',
    CONSOLE_SETTINGS_URI: 'console/modules/console-settings.js',
    DATA_NAVIGATOR_URI: 'console/modules/data-navigator.js',
    MONACO_THEME_URI: 'shared/monaco-theme.js',
    ICONS_SCRIPT: 'shared/icons.js',
    DBMN_FOOTER_URI: 'shared/dbmn-footer.js',
    DBMN_TABLE_URI: 'shared/dbmn-table.js',
    DBMN_SAVED_SEARCHES_URI: 'shared/dbmn-saved-searches.js',
    // #464: the run heading, its name and the run's details, and their wiring
    DBMN_NAME_URI: 'shared/dbmn-name.js',
    DBMN_RUN_HEADING_URI: 'shared/dbmn-run-heading.js',
    DBMN_RUN_DETAILS_URI: 'shared/dbmn-run-details.js',
    CONSOLE_RUN_HEADING_URI: 'console/modules/console-run-heading.js',
    CONSOLE_EDITOR_URI: 'console/modules/console-editor.js',
    CONSOLE_REQUESTS_URI: 'console/modules/requests-tab.js',   // #466
    DBMN_TRANSACTION_URI: 'shared/dbmn-transaction.js',
    CONSOLE_CHAIN_URI: 'console/modules/console-chain.js',
    REQUEST_PREVIEW_URI: 'shared/request-preview.js',
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
    INPUT_ROW_STATUS_URI: 'shared/input-row-status.js',
    // #372: the page's own scripts, files rather than inline
    CONSOLE_BOOT_URI: 'console/console-boot.js',
    CONSOLE_PAGE_URI: 'console/console-page.js',
    CONSOLE_COMPARE_URI: 'console/modules/console-compare.js', // #298
    DBMN_ACTIONS_URI: 'shared/dbmn-actions.js',
    MONACO_LOADER_CONFIG_URI: 'shared/monaco-loader-config.js'
};

/** The stylesheets console-webview-manager.ts links, for a scenario that needs real layout. */
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/modals.css', 'shared/tables.css', 'shared/tabs.css',
    'shared/toast.css', 'shared/console.css', 'shared/transaction-card.css', 'shared/column-drag.css', 'shared/column-head.css',
    'shared/dbmn-footer.css', 'shared/dbmn-table.css', 'shared/search.css', 'shared/dbmn-name.css'];

/**
 * @param {{ reportType: 'batch' | 'individual', batchId?: string, executionId?: string, statusDisplay?: string, styles?: boolean }} opts
 *   `styles: true` links the real stylesheets — only for a scenario about geometry (scroll,
 *   heights); everything else asserts on the "hidden" CLASS and stays stylesheet-free.
 */
export function consolePage({ reportType, batchId = '', executionId = '', statusDisplay = '', styles = false }) {
    // CONSOLE_HTML=<path> runs the same scenario against another copy of the page (e.g. an
    // older revision, to confirm this test fails where the bug exists).
    let html = readFileSync(process.env.CONSOLE_HTML || join(WEBVIEWS, 'console/console.html'), 'utf8');
    for (const [placeholder, file] of Object.entries(SCRIPTS)) {
        html = html.split(`{{${placeholder}}}`).join(pathToFileURL(join(WEBVIEWS, file)).href);
    }
    // No stylesheet by default: assert on the "hidden" CLASS, not on visibility.
    const links = styles ? STYLES.map(f => `<link rel="stylesheet" href="${pathToFileURL(join(WEBVIEWS, f)).href}">`).join('') : '';
    html = html.split('{{SHARED_STYLES}}').join(links);
    html = html.split('{{REPORT_TYPE}}').join(reportType).split('{{BATCH_ID}}').join(batchId).split('{{EXECUTION_ID}}').join(executionId);
    html = html.split('{{STATUS_DISPLAY}}').join(statusDisplay);
    html = html.split('{{ENVIRONMENT_VARIABLES_JSON}}').join('{}');
    html = html.replace(/\{\{[A-Z_]+\}\}/g, '');
    // The webview API the page expects from VS Code.
    const shim = '<script>window.__posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.__posted.push(m), getState: () => ({}), setState: () => {} });</script>';
    return html.replace('<head>', `<head>${shim}`);
}

/** A host → webview message, as console-webview-manager.ts posts it. */
export const envelope = (type, payload, extra = {}) =>
    ({ type, correlationId: `${type}_${Date.now()}`, timestamp: Date.now(), source: 'extension', target: 'webview', payload, ...extra });
