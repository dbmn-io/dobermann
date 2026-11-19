// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* DBMN Hub — the first script in every tab's frame.
 *
 * hub-tabs.js puts `<script src=".../tab-frame.js" data-tab-id="…">` at the top of each tab
 * document's <head>, so this runs before the screen's own scripts. It was two inline scripts
 * built as strings; it is a file now so the web app's Content Security Policy (#372), which
 * refuses inline script, lets it run. The tab's id comes from its own script tag.
 *
 * Two jobs:
 *   1. The bridge: `window.vscode` / `acquireVsCodeApi()` for the screen, posting to the Hub with
 *      the tab's id, plus the inbound message queue (G8), the ready signal (G5), dirty state, the
 *      footer height, Ctrl/Cmd+W and the workbench chords.
 *   2. The theme: the Hub's `--vscode-*` tokens and body theme classes, copied in and kept in step.
 */
(function () {
    'use strict';
    var script = document.currentScript;
    var tabId = script ? script.getAttribute('data-tab-id') : null;
    if (!tabId) {
        console.error('[tab-frame] no data-tab-id on its script tag: not a Hub tab');
        return;
    }

    function toHub(payload) {
        try { window.parent.postMessage({ __embeddedFromTab__: true, tabId: tabId, payload: payload }, '*'); } catch (_e) { /* the Hub is gone */ }
    }

    var bridge = {
        postMessage: function (msg) { toHub(msg); },
        getState: function () { return null; },
        setState: function (_s) {}
    };
    window.vscode = bridge;
    window.acquireVsCodeApi = function () { return bridge; };
    // Tells shared components they are a tab inside the Hub, not a standalone panel. DbmnToast
    // reads it and hands its toasts to the Hub document so there is ONE stack: two documents each
    // with their own bottom-right overlay covered each other instead of stacking.
    window.__dbmnEmbeddedTab__ = tabId;

    // G8 — inbound message buffer. The Hub bridge forwards host events (progress_update,
    // status_update, loadInitialData…) to the iframe as soon as __embeddedReady__ fires, but the
    // screen's own `window.addEventListener("message", …)` typically sits at the BOTTOM of its
    // script and doesn't attach until parsing reaches that line. Without this queue, fast events
    // (a sub-300ms API failure, the first progress tick of a batch) hit the iframe before the
    // screen is listening and are silently dropped.
    //
    // We intercept window.addEventListener("message", …): this is the only listener installed
    // natively, and every screen listener is stored in a list. Until the first screen listener
    // attaches, every "message" event is queued. On attach, the queue is drained into the new
    // handler in arrival order, then subsequent events dispatch directly. removeEventListener is
    // also intercepted so a screen that detaches/re-attaches behaves predictably.
    var managerListeners = [];
    var inboundQueue = [];
    var nativeAdd = window.addEventListener.bind(window);
    var nativeRemove = window.removeEventListener.bind(window);
    nativeAdd('message', function (ev) {
        if (managerListeners.length === 0) { inboundQueue.push(ev); return; }
        for (var i = 0; i < managerListeners.length; i++) {
            try { managerListeners[i](ev); } catch (_e) { /* one listener's error doesn't stop the rest */ }
        }
    });
    window.addEventListener = function (type, handler, options) {
        if (type === 'message' && typeof handler === 'function') {
            managerListeners.push(handler);
            while (inboundQueue.length > 0) {
                var ev = inboundQueue.shift();
                try { handler(ev); } catch (_e) { /* as above */ }
            }
            return;
        }
        return nativeAdd(type, handler, options);
    };
    window.removeEventListener = function (type, handler, options) {
        if (type === 'message' && typeof handler === 'function') {
            var idx = managerListeners.indexOf(handler);
            if (idx >= 0) managerListeners.splice(idx, 1);
            return;
        }
        return nativeRemove(type, handler, options);
    };

    // G5 — signalReady. Fires from whichever event arrives first (DOMContentLoaded,
    // readystatechange to interactive or complete, window.load), dedupes after the first call.
    // Without this signal the loader stays up and the host never broadcasts initial state.
    var readyFired = false;
    function signalReady() {
        if (readyFired) return;
        readyFired = true;
        toHub({ type: '__embeddedReady__' });
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        signalReady();
    } else {
        document.addEventListener('DOMContentLoaded', signalReady);
        document.addEventListener('readystatechange', function () {
            if (document.readyState === 'interactive' || document.readyState === 'complete') signalReady();
        });
        window.addEventListener('load', signalReady);
    }

    // Dirty-state observation. Every editor enables its Save button when there are unsaved
    // changes (endpoint: #save-endpoint-btn, env: #saveEnvBtn, etc.). Watch the universal
    // `disabled` attribute toggle and propagate to the tab. Works without modifying any editor.
    //
    // A page with no Save button reports for itself instead: Run Batch calls
    // dbmnSetTabDirty(true) while it holds data that has not been run (Issue #348). Once a page
    // reports, the Save-button watcher stands down.
    var explicitDirty = false;
    var lastReported = null;
    function reportDirty(dirty) {
        if (dirty === lastReported) return;
        lastReported = dirty;
        toHub({ type: '__tabDirty__', dirty: dirty });
    }
    window.dbmnSetTabDirty = function (dirty) { explicitDirty = true; reportDirty(!!dirty); };
    // A screen whose tab shows a name the host does not know (Run Batch: the batch it is about to
    // run) says what its tab is called.
    var lastName = null;
    window.dbmnSetTabName = function (name) {
        var text = String(name === null || name === undefined ? '' : name);
        if (!text || text === lastName) return;
        lastName = text;
        toHub({ type: '__tabName__', name: text });
    };
    function watchDirty() {
        var btn = document.getElementById('save-endpoint-btn')
            || document.getElementById('saveEnvBtn')
            || document.getElementById('saveBatchBtn')
            || document.querySelector('[id^=save]');
        if (!btn) return;
        function check() {
            if (explicitDirty) return;
            // Save button enabled means dirty.
            reportDirty(!btn.disabled);
        }
        check();
        new MutationObserver(check).observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    }

    // Measure the sticky webview-footer so the scrollable body ends above it instead of running
    // the full viewport height. Re-measure on resize + when the footer's own size changes (button
    // overflow into a More dropdown, etc).
    function updateFooterHeight() {
        var footer = document.querySelector('.webview-footer');
        var h = footer ? footer.offsetHeight : 0;
        document.documentElement.style.setProperty('--dbmn-footer-h', h + 'px');
    }
    function watchFooter() {
        updateFooterHeight();
        window.addEventListener('resize', updateFooterHeight);
        var footer = document.querySelector('.webview-footer');
        if (footer && window.ResizeObserver) new ResizeObserver(updateFooterHeight).observe(footer);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { watchDirty(); watchFooter(); });
    } else {
        watchDirty(); watchFooter();
    }

    // Ctrl/Cmd+W inside a nested iframe (e.g. focus deep in a Monaco pane on the Console RAW tab)
    // never reaches the outer VS Code webview, so the contributed keybinding
    // (dbmn.hub.closeActiveTab, when: activeWebviewPanelId==hub) silently misses. Catch it here
    // in capture phase and post the same dirty-aware close request the host-side path uses.
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'w' && e.key !== 'W') return;
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        toHub({ type: '__requestCloseTab__' });
    }, true);

    // Alt+W: the close-tab key in every DBMN (a browser keeps Ctrl+W for itself and closes the
    // whole page, so the web app can't have it). Same nested-iframe gap as Ctrl+W, same route.
    // `code` too: Option+W on a Mac reports its character (∑) as the key.
    document.addEventListener('keydown', function (e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key !== 'w' && e.key !== 'W' && e.code !== 'KeyW') return;
        e.preventDefault();
        e.stopPropagation();
        toHub({ type: '__requestCloseTab__' });
    }, true);

    // Workbench chord forwarding. Ctrl/Cmd chords have the same nested-iframe forwarding gap as
    // Ctrl+W — VS Code's keybinding service only listens on the outer webview iframe. Catch here,
    // post to the parent, host runs the workbench command. Capture on `document` runs before
    // anything deeper in the tree, Monaco included, so a mapped chord means the same thing
    // wherever focus is. Everything NOT in the map (Ctrl+F find, Ctrl+/, the editing chords) is
    // untouched. Keep in sync with the allowlist in hub-manager.ts and the map in hub.js.
    var CHORD_MAP = {
        'p':       'workbench.action.quickOpen',
        'p:shift': 'workbench.action.showCommands',
        'n':       'workbench.action.files.newUntitledFile',
        'o':       'workbench.action.files.openFile',
        'b':       'workbench.action.toggleSidebarVisibility',
        'j':       'workbench.action.togglePanel',
        '`':       'workbench.action.terminal.toggleTerminal',
        ',':       'workbench.action.openSettings',
        'e:shift': 'workbench.view.explorer',
        'f:shift': 'workbench.action.findInFiles',
        'g:shift': 'workbench.view.scm',
        'x:shift': 'workbench.view.extensions',
        'd:shift': 'workbench.view.debug'
    };
    document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        var cmd = CHORD_MAP[e.shiftKey ? key + ':shift' : key];
        if (!cmd) return;
        e.preventDefault();
        e.stopPropagation();
        toHub({ type: 'runWorkbenchCommand', command: cmd });
    }, true);
}());

/* The theme: copies the Hub document's VS Code theme tokens (`--vscode-*` custom properties) and
 * body class (`vscode-dark` / `vscode-light` / data-vscode-theme-*) into the frame so
 * `var(--vscode-foreground)` resolves and theme-aware CSS renders correctly. Without this the
 * frame is a vanilla document with no VS Code styling context. */
(function () {
    'use strict';
    try {
        var parent = window.parent;
        if (!parent || parent === window) return;
        var pRoot = parent.document.documentElement;

        function applyTokens() {
            var computed = parent.getComputedStyle(pRoot);
            var declarations = [];
            for (var i = 0; i < computed.length; i++) {
                var prop = computed[i];
                if (prop.indexOf('--vscode-') === 0) {
                    declarations.push(prop + ':' + computed.getPropertyValue(prop) + ';');
                }
            }
            // Monaco in the frame re-reads its colours when this changes (monaco-theme.js)
            document.documentElement.setAttribute('data-dbmn-theme', pRoot.getAttribute('data-dbmn-theme') || '0');
            var existing = document.getElementById('__dbmnVscodeTheme');
            if (existing) { existing.textContent = ':root{' + declarations.join('') + '}'; return; }
            var styleEl = document.createElement('style');
            styleEl.id = '__dbmnVscodeTheme';
            styleEl.textContent = ':root{' + declarations.join('') + '}';
            (document.head || document.documentElement).appendChild(styleEl);
        }

        function applyBodyTheme() {
            var pBody = parent.document.body;
            if (!pBody || !document.body) return;
            var pClasses = pBody.className.split(/\s+/).filter(function (c) { return c.indexOf('vscode-') === 0; });
            // Strip stale vscode-* classes before applying current ones so switching from
            // vscode-dark to vscode-light actually removes the old class.
            document.body.className = document.body.className.split(/\s+/).filter(function (c) { return c.indexOf('vscode-') !== 0; }).concat(pClasses).join(' ').trim();
            for (var a = 0; a < pBody.attributes.length; a++) {
                var att = pBody.attributes[a];
                if (att.name.indexOf('data-vscode-') === 0) document.body.setAttribute(att.name, att.value);
            }
        }

        function applyAll() { applyTokens(); applyBodyTheme(); }

        // #344: is DBMN for VS Code there (the web app's Hub says)? The Console title's icon follows it
        function applyAgentConnection() {
            var state = pRoot.getAttribute('data-agent-connection');
            if (state) document.documentElement.setAttribute('data-agent-connection', state);
            else document.documentElement.removeAttribute('data-agent-connection');
        }

        // Initial pass — tokens go on :root immediately, body class waits for the frame's body.
        applyAgentConnection();
        applyTokens();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyBodyTheme);
        } else {
            applyBodyTheme();
        }

        // VS Code re-injects --vscode-* tokens and updates body.class when the user changes theme.
        // Watch the parent for those mutations and repropagate.
        function onMutation(records) {
            for (var i = 0; i < records.length; i++) {
                var n = records[i].attributeName;
                if (n === 'data-agent-connection') { applyAgentConnection(); continue; }
                // data-dbmn-theme: the Hub put another theme over VS Code's (hub.js) or took it off
                if (n === 'class' || n === 'style' || n === 'data-dbmn-theme' || (n && n.indexOf('data-vscode-') === 0)) { applyAll(); return; }
            }
        }
        var obs = new (parent.MutationObserver || window.MutationObserver)(onMutation);
        obs.observe(pRoot, { attributes: true });
        var watchBody = function () { if (parent.document.body) obs.observe(parent.document.body, { attributes: true }); };
        if (parent.document.readyState === 'loading') parent.document.addEventListener('DOMContentLoaded', watchBody);
        else watchBody();
    } catch (e) { console.error('[dbmn-theme-bootstrap]', e); }
}());
