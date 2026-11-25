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
    CONSOLE_EDITOR_URI: 'shared/dbmn-code-pane.js',
    CONSOLE_ACTIONS_URI: 'console/modules/console-actions.js',
    DBMN_REQUESTS_URI: 'shared/dbmn-requests.js',              // #466: the Requests table (shared with Review)
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
    const shim = `<script>window.__posted = []; ${REQUESTS_HOST}
window.acquireVsCodeApi = () => ({ postMessage: m => { window.__posted.push(m); window.__requestsHost(m); }, getState: () => ({}), setState: () => {} });</script>`;
    return html.replace('<head>', `<head>${shim}`);
}

/**
 * The host's side of the Requests tab (B22: Raw is gone, Requests is a run's requests), stood in for: it answers
 * console.requests.counts / page / detail from the page's own run (dynamicReportManager.rawData.responses), as
 * console.controller.ts answers them from the stored run. A request's number is its place; its status as the
 * stored member's (success → completed; a 2xx its test failed → test_failed); its reason the error message; a JSON
 * Lines body as its lines (stored-run-requests.ts jsonLinesOf). As the host: when the tab comes on screen it is told
 * to ask again (console.requests.changed), and requestsArrived() is the host's word that the run's requests landed.
 */
const REQUESTS_HOST = `window.__requestsHost = (function () {
  const text = v => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const bodyOf = x => {
    const f = x.format;
    if (f && f.kind === 'jsonl' && Array.isArray(x.data)) {
      const lines = x.data.map(r => JSON.stringify(r));
      (f.invalid || []).slice().sort((a, b) => a.line - b.line).forEach(bad => lines.splice(Math.min(Math.max(0, bad.line - 1), lines.length), 0, String(bad.text)));
      return lines.join('\\n');
    }
    return text(x.data);
  };
  const pairs = h => (Array.isArray(h) ? h : Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) })));
  const responses = () => ((window.dynamicReportManager && window.dynamicReportManager.rawData && window.dynamicReportManager.rawData.responses) || []);
  const row = (x, i) => {
    const m = x.metadata || {};
    const st = String(m.status || x.status || '').toLowerCase();
    const status = m.testStatus === 'failed' ? 'test_failed' : st === 'success' ? 'completed' : (st || 'completed');
    const body = bodyOf(x);
    const req = text(x.request !== undefined ? x.request : m.request);
    return { id: m.executionId || 'req-' + (i + 1), n: m.memberIndex ?? i + 1, status, http: typeof x.httpStatus === 'number' ? x.httpStatus : null,
      httpText: x.httpStatusText || null, timeMs: m.responseTime ?? null, sent: m.timestamp || null,
      rowStart: m.rowStart ?? null, rowEnd: m.rowEnd ?? null, method: m.method || 'POST', url: m.url || '', query: {},
      request: req === null ? null : { preview: req.slice(0, 200), items: null, bytes: req.length },
      response: body === null ? null : { preview: body.slice(0, 200), items: null, bytes: body.length, contentType: (x.headers && x.headers['content-type']) || '' },
      requestHeaders: [], responseHeaders: pairs(x.headers), reason: m.errorMessage || null, reprocessCount: 0, hasLogs: true,
      __req: req, __body: body };
  };
  const reply = m => setTimeout(() => window.postMessage(m, '*'), 0);
  return m => {
    if (!m || typeof m.type !== 'string' || m.type.indexOf('console.requests.') !== 0) return;
    const all = responses().map(row);
    const tally = () => { const counts = {}; all.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; }); return { total: all.length, counts }; };
    if (m.type === 'console.requests.counts') reply({ type: 'console.requests.counts', ...tally() });
    else if (m.type === 'console.requests.arrived' || (m.type === 'console.requests.shown' && m.shown)) reply({ type: 'console.requests.changed', ...tally() }); else if (m.type === 'console.requests.page') {
      let rows = all;
      if (Array.isArray(m.statuses) && m.statuses.length) rows = rows.filter(r => m.statuses.includes(r.status));
      if (m.search) { const s = String(m.search).toLowerCase(); rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(s)); }
      const page = rows.slice(m.offset || 0, (m.offset || 0) + (m.limit || 100)).map(({ __req, __body, ...r }) => r);
      reply({ type: 'console.requests.rows', seq: m.seq, rows: page, total: rows.length, of: all.length });
    } else if (m.type === 'console.requests.detail') {
      const r = all.find(x => x.id === m.id);
      // (by its id, with its row as it stands now, as the host answers: the open window follows it)
      const { __req, __body, ...rowNow } = r || {};
      reply({ type: 'console.requests.detail', seq: m.seq, detail: r ? { id: r.id, method: r.method, url: r.url, query: {}, requestHeaders: [], responseHeaders: r.responseHeaders,
        requestBody: r.__req, responseBody: r.__body, rows: r.rowStart ? [r.rowStart, r.rowEnd] : null, row: rowNow } : undefined });
    }
  };
})();`;

/** The run's requests have landed (the host tells the page as they do): the Requests tab's count. */
export const requestsArrived = page => page.evaluate(() => window.__requestsHost({ type: 'console.requests.arrived' }));

/** The first request's window, as a person opens it: the Requests tab, its first row clicked (a Run API opens nothing
 *  by itself: James, 2026-11-25). */
export async function openFirstRequest(page) {
    await page.locator('.tab-item[data-tab="requests"]').click();
    await page.locator('#requests-table .dbmn-table-body > tr:not(.dbmn-table-spacer) td[data-col="n"]').first().click();
}

/** A host → webview message, as console-webview-manager.ts posts it. */
export const envelope = (type, payload, extra = {}) =>
    ({ type, correlationId: `${type}_${Date.now()}`, timestamp: Date.now(), source: 'extension', target: 'webview', payload, ...extra });
