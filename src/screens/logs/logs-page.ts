// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Logs screen's page (Dobermann issue 7). Any host: `asset` maps a path under src/webviews
 * to a URL.
 *
 * The design system's log list fills the page, over its footer: Refresh, Copy and Save on the
 * left; on the right, how many lines show, or while a search looks back through the days kept,
 * how far it has got. Not live: Refresh reads the lines again.
 */
import type { AssetUrl } from '../pages';
import { sharedStyleLinks } from '../pages';

export function buildLogsPage(asset: AssetUrl): string {
    const script = (rel: string) => `<script src="${asset(rel)}"></script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Logs</title>
    ${sharedStyleLinks(asset, ['atomic', 'core', 'buttons', 'modals', 'tables', 'tabs', 'toast', 'console', 'search', 'column-drag', 'column-head', 'dbmn-footer', 'dbmn-table', 'dbmn-log'])}
    <link rel="stylesheet" href="${asset('logs/logs.css')}">
</head>
<body class="editor-slide-in logs-body">
    ${script('shared/button-contrast.js')}
    ${script('shared/dbmn-actions.js')}
    <div class="editor-window-controls">
        <button type="button" class="editor-window-btn icon" data-window-action="maximize" data-icon="maximize-2" title="Maximise" aria-label="Maximise"></button>
        <button type="button" class="editor-window-btn icon" data-window-action="close" data-icon="x" title="Close" aria-label="Close"></button>
    </div>

    <main class="logs-page">
        <dbmn-log id="logsList" label="Logs"></dbmn-log>
    </main>

    <dbmn-footer class="logs-footer">
        <dbmn-actions>
            <button type="button" id="logsRefreshBtn" class="btn btn-secondary" data-click="logs:refresh" title="Read the lines again, newest first">Refresh</button>
            <button type="button" class="btn btn-secondary" data-click="logs:copy" title="Copy the lines shown">Copy</button>
            <button type="button" class="btn btn-secondary" data-click="logs:save" title="Save the lines shown to a file">Save</button>
        </dbmn-actions>
        <!-- How many lines; while a search looks back through the days kept, how far it has got instead -->
        <dbmn-status id="logsStatus"></dbmn-status>
        <dbmn-progress id="logsSearching" phase="Searching" busy hidden></dbmn-progress>
    </dbmn-footer>

    ${script('shared/search-words.js')}
    ${script('shared/search-matcher.js')}
    ${script('shared/value-formatter.js')}
    ${script('shared/cell-detail.js')}
    ${script('shared/virtual-window.js')}
    ${script('shared/column-drag.js')}
    ${script('shared/column-head.js')}
    ${script('shared/help-mode.js')}
    ${script('shared/dbmn-modal.js')}
    ${script('shared/dbmn-context-menu.js')}
    ${script('shared/dbmn-toast.js')}
    ${script('shared/dbmn-clipboard.js')}
    ${script('shared/icons.js')}
    ${script('shared/dbmn-footer.js')}
    ${script('shared/dbmn-table.js')}
    ${script('shared/dbmn-level.js')}
    ${script('shared/dbmn-log.js')}
    ${script('shared/editor-window-controls.js')}
    ${script('logs/logs-page.js')}
</body>
</html>`;
}
