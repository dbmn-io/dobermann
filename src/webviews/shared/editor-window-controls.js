// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Editor window controls — maximise / close cluster, shared by the endpoint,
 * environment, and console webviews. The cluster lives in the top-right of
 * each editor body.
 *
 * Usage in HTML:
 *     <div class="editor-window-controls">
 *         <button class="editor-window-btn" data-window-action="maximize" data-icon="maximize-2" title="Maximise"></button>
 *         <button class="editor-window-btn" data-window-action="close"    data-icon="x"          title="Close"></button>
 *     </div>
 *
 * Usage in JS:
 *     window.EditorWindowControls.wire(vscode, { slideOutMs: 220 });
 *
 * Backend messages posted on click:
 *   - { type: 'windowMaximize' }  — host fires `workbench.action.toggleMaximizeEditorGroup`
 *                                   which expands the editor across the whole editor
 *                                   area (hiding the Hub) and toggles back on a
 *                                   second click. The button locally toggles its
 *                                   icon between `maximize-2` and `minimize-2`
 *                                   to mirror the visual state. Inside a Hub tab
 *                                   the whole control cluster is hidden (the Hub
 *                                   header owns show/hide of the list column,
 *                                   Issue #292) so this only fires standalone.
 *   - { type: 'closeWebview' }    — host disposes the panel. Sent *after* the
 *                                   slide-out animation completes so the close
 *                                   reads as one motion.
 */
(function () {
    'use strict';

    function wire(vscode, opts) {
        const slideOutMs = (opts && opts.slideOutMs) || 220;
        if (window.Icons) window.Icons.injectIcons();

        document.querySelectorAll('.editor-window-btn').forEach(btn => {
            const action = btn.getAttribute('data-window-action');

            if (action === 'maximize') {
                let isMaxed = false;
                btn.addEventListener('click', () => {
                    isMaxed = !isMaxed;
                    if (window.Icons) {
                        const iconSpan = btn.matches('[data-icon]') ? btn
                            : btn.querySelector('[data-icon]');
                        // The button itself carries data-icon, so swap in place.
                        window.Icons.setIcon(iconSpan || btn, isMaxed ? 'minimize-2' : 'maximize-2');
                    }
                    btn.title = isMaxed ? 'Restore' : 'Maximise';
                    btn.setAttribute('aria-label', btn.title);
                    vscode.postMessage({ type: 'windowMaximize' });
                });
            } else if (action === 'close') {
                btn.addEventListener('click', () => {
                    document.body.classList.remove('editor-slide-in');
                    document.body.classList.add('editor-slide-out');
                    setTimeout(() => vscode.postMessage({ type: 'closeWebview' }), slideOutMs);
                });
            }
        });
    }

    window.EditorWindowControls = { wire };
})();
