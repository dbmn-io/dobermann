// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's page (src/screens/lookup). Any host: `asset` maps a path under src/webviews to
 * a URL.
 *
 * The design system's table fills the page as a data-entry grid: rows added from the line under
 * them and deleted from their number, columns renamed, added and deleted from a heading's
 * right-click menu, a block pasted from a spreadsheet. The footer: which column is the key, and
 * whether what shows is kept.
 */
import type { AssetUrl } from '../pages';
import { sharedStyleLinks } from '../pages';

export function buildLookupPage(asset: AssetUrl, config: { name: string }): string {
    const script = (rel: string) => `<script src="${asset(rel)}"></script>`;
    const title = String(config.name || 'Lookup table').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    ${sharedStyleLinks(asset, ['atomic', 'core', 'buttons', 'modals', 'tables', 'tabs', 'toast', 'console', 'column-drag', 'column-head', 'dbmn-footer', 'dbmn-table'])}
    <link rel="stylesheet" href="${asset('lookup/lookup.css')}">
</head>
<body class="editor-slide-in lookup-body">
    ${script('shared/button-contrast.js')}
    ${script('shared/dbmn-actions.js')}
    <div class="editor-window-controls">
        <button type="button" class="editor-window-btn icon" data-window-action="maximize" data-icon="maximize-2" title="Maximise" aria-label="Maximise"></button>
        <button type="button" class="editor-window-btn icon" data-window-action="close" data-icon="x" title="Close" aria-label="Close"></button>
    </div>

    <main class="lookup-page">
        <dbmn-table id="lookupTable" label="${title}" editable add-row row-delete edit-columns searchable></dbmn-table>
        <p class="lookup-gone" id="lookupGone" hidden>This lookup table has been deleted.</p>
    </main>

    <dbmn-footer class="lookup-footer">
        <dbmn-actions>
            <label class="lookup-key" title="The key: each of its values in one row only. A query looks values up in any column, key or not.">
                <span>Key</span>
                <select id="lookupKey" data-change="lookup:key"></select>
            </label>
        </dbmn-actions>
        <dbmn-status id="lookupStatus"></dbmn-status>
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
    ${script('shared/editor-window-controls.js')}
    ${script('lookup/lookup-page.js')}
</body>
</html>`;
}
