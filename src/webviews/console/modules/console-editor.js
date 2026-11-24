// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's code editor for a pane of <dbmn-transaction> (its `editor` hook): the same read-only Monaco editor as
 * Raw's card (raw-tab-handler.js createEditorForContainer), so a body folds at the margin arrows, a folded part copies,
 * and the search marks it. Draws nothing of its own.
 *
 *   tx.editor = window.ConsoleEditor.make;   // (container, { pane, text, language }) → { search(text), dispose() } | null
 *
 * null while Monaco is not loaded (or failed): the window shows the text as it is, then redraws its panes in Monaco
 * once whenReady() says so (each pane's data-editor says which: "text" or "monaco", for a spec to wait on).
 * Browser: window.ConsoleEditor.
 */
(function () {
    'use strict';

    function ready() {
        const raw = window.rawTabHandler;
        return !!(window.monaco && window.monaco.editor && (!raw || raw.monacoReady));
    }
    /** Monaco loaded (the Console loads it only when asked: Raw did, now the window does), then `then`. */
    function whenReady(then) {
        if (ready()) { then(); return; }
        const raw = window.rawTabHandler;
        if (raw && typeof raw.ensureMonaco === 'function') raw.ensureMonaco(() => { if (ready()) then(); });
    }

    function make(container, { text, language }) {
        if (!ready() || !container) return null;
        let editor;
        try {
            container.classList.add('dbmn-tx-monaco');
            editor = window.monaco.editor.create(container, {
                value: text || '', language: language || 'plaintext', theme: 'vscode-current',
                readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on',
                automaticLayout: true, folding: true, lineNumbers: 'off', renderLineHighlight: 'none', contextmenu: false,
                scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                fontSize: 12, fontFamily: 'Consolas, Monaco, "Courier New", monospace', lineDecorationsWidth: 0,
                lineNumbersMinChars: 0, glyphMargin: false, overviewRulerLanes: 0, hideCursorInOverviewRuler: true,
                overviewRulerBorder: false, padding: { top: 8, bottom: 8 }, stickyScroll: window.DBMN_STICKY_SCROLL
            });
        } catch (e) {
            container.classList.remove('dbmn-tx-monaco');
            return null;
        }
        let marks = [];
        return {
            search(term) {
                const model = editor.getModel();
                if (!model) return;
                const found = term && term.trim() ? model.findMatches(term.trim(), false, false, false, null, false) : [];
                marks = editor.deltaDecorations(marks, found.map(m => ({ range: m.range, options: { inlineClassName: 'dbmn-tx-hit' } })));
                if (found.length) editor.revealRangeInCenterIfOutsideViewport(found[0].range);
            },
            dispose() { try { editor.dispose(); } catch { /* gone */ } }
        };
    }

    window.ConsoleEditor = { make, ready, whenReady };
})();
