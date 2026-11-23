// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* Monaco's AMD loader pointed at its pinned CDN copy, and its workers (#166). Load right after
 * Monaco's loader.js. A file rather than inline script so the web app's Content Security Policy
 * (#372, web/scripts/security-headers.ts, which allows this CDN path) lets it run; the endpoint
 * editor and the Console each used to carry their own inline copy. */
(function () {
    'use strict';
    var BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/';
    // loader.js didn't arrive (the CDN down or slow: CI run 45082794013): no Monaco, and the page
    // carries on without it (the Console's Raw tab checks for `require` before it asks for Monaco)
    if (typeof require === 'undefined' || typeof require.config !== 'function') return;
    require.config({ paths: { vs: BASE + 'vs' } });
    window.monacoProxy = URL.createObjectURL(new Blob([
        "self.MonacoEnvironment = { baseUrl: '" + BASE + "' };\nimportScripts('" + BASE + "vs/base/worker/workerMain.js');"
    ], { type: 'text/javascript' }));
    window.MonacoEnvironment = { getWorkerUrl: function () { return window.monacoProxy; } };
}());
