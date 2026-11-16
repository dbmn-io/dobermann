// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Monaco Theme Utility
 *
 * Defines a custom Monaco theme ('vscode-current') that reads the actual
 * VS Code CSS variables so editors match the user's real theme — not just
 * generic light/dark.
 *
 * Usage (inside a Monaco require callback, after monaco is available):
 *   defineVSCodeTheme();
 *   monaco.editor.create(container, { theme: 'vscode-current', ... });
 *   setupMonacoThemeObserver();
 */

/**
 * Define (or re-define) the 'vscode-current' Monaco theme by reading
 * computed CSS variables from the document root.
 * Must be called after Monaco is loaded.
 */
window.defineVSCodeTheme = function defineVSCodeTheme() {
    const style = getComputedStyle(document.documentElement);
    const get = (v, fallback) => style.getPropertyValue(v).trim() || fallback || '';
    const themeKind = document.body.getAttribute('data-vscode-theme-kind');
    const isLight = (themeKind === 'vscode-light' || themeKind === 'vscode-high-contrast-light');
    const base = isLight ? 'vs' : 'vs-dark';

    // Explicit selection colors — webview CSS variables often resolve to the
    // focusHighlight color (red/orange in many themes) instead of the real
    // editor selection colour. Always use subtle blue tones that work universally.
    const selectionBg = isLight ? '#add6ff80' : '#264f7880';
    const selectionHighlightBg = isLight ? '#add6ff40' : '#264f7840';

    monaco.editor.defineTheme('vscode-current', {
        base: base,
        inherit: true,
        rules: [],
        colors: {
            'editor.background': get('--vscode-editor-background'),
            'editor.foreground': get('--vscode-editor-foreground'),
            'editor.selectionBackground': selectionBg,
            'editor.selectionHighlightBackground': selectionHighlightBg,
            'editor.inactiveSelectionBackground': selectionHighlightBg,
            'editor.lineHighlightBackground': get('--vscode-editor-lineHighlightBackground'),
            'editorLineNumber.foreground': get('--vscode-editorLineNumber-foreground'),
            'editorLineNumber.activeForeground': get('--vscode-editorLineNumber-activeForeground'),
            'editorCursor.foreground': get('--vscode-editorCursor-foreground'),
            'editorWidget.background': get('--vscode-editorWidget-background'),
            'editorWidget.border': get('--vscode-editorWidget-border')
        }
    });
};

/**
 * Issue #296: VS Code's Sticky Scroll for every DBMN JSON editor — the
 * parents of the lines in view stay pinned at the top as you scroll.
 * Pass as `stickyScroll` to monaco.editor.create. Built from indentation:
 * the default outline model needs the JSON language worker, which the
 * webviews don't always run.
 */
window.DBMN_STICKY_SCROLL = Object.freeze({ enabled: true, maxLineCount: 5, defaultModel: 'indentationModel' });

/**
 * Watch for VS Code theme changes and re-apply the custom Monaco theme.
 * Optionally calls `callback` after each theme update.
 * Returns the MutationObserver (caller can .disconnect() for cleanup).
 */
window.setupMonacoThemeObserver = function setupMonacoThemeObserver(callback) {
    const observer = new MutationObserver(() => {
        window.defineVSCodeTheme();
        monaco.editor.setTheme('vscode-current');
        if (typeof callback === 'function') {
            callback();
        }
    });

    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-vscode-theme-kind']
    });
    // #373: outside VS Code a theme is `--vscode-*` properties on the root element, and one
    // theme can follow another of the same kind: re-read the tokens when they change too.
    // In VS Code another theme over VS Code's is a stylesheet, not the root's style: the Hub (and
    // each tab frame copying it) marks the root with data-dbmn-theme when it changes.
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-dbmn-theme']
    });

    return observer;
};
