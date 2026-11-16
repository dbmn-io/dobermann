// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';

/**
 * The paw on every DBMN editor tab.
 *
 * Without `iconPath` VS Code draws a generic "lines" glyph on a webview tab, so a Hub,
 * Console and endpoint editor all look like anonymous documents. One SVG
 * (`images/tab-icon.svg`) serves both themes — see the note in that file.
 *
 * VS Code chrome, so it lives here rather than in the webview managers: on the SPA
 * migration (docs/portability/spa-migration.md) tabs are DBMN's own and this file goes.
 */
export function applyPanelIcon(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'tab-icon.svg');
}
