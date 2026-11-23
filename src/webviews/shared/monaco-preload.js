// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Load Monaco's editor module ahead of its first use, and say when it's there (GitHub Issue #106).
 * After monaco-loader-config.js. A file, not inline script, for the web app's CSP (#372). */
// (no loader: the CDN didn't answer; the page carries on without Monaco)
if (typeof require === 'function') {
    require(['vs/editor/editor.main'], function () {
        window.monacoLoaded = true;
    });
}
