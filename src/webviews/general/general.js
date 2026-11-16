// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// General webview JavaScript
(function() {
    const vscode = acquireVsCodeApi();

    window.addEventListener('load', () => {
        vscode.postMessage({ type: 'ready' });
    });

    // Listen for messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
            case 'checkUnsavedChanges':
                // General view has no unsaved changes
                vscode.postMessage({
                    type: 'unsavedChangesResponse',
                    hasUnsavedChanges: false
                });
                break;
        }
    });
})();