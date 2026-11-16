// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Load Monaco's editor module ahead of its first use, and say when it's there (GitHub Issue #106).
 * After monaco-loader-config.js. A file, not inline script, for the web app's CSP (#372). */
require(['vs/editor/editor.main'], function () {
    window.monacoLoaded = true;
});
