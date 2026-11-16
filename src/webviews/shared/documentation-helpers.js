// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Help icons open dbmn.io documentation in external browser.
 * HTML elements use data-help-doc and data-help-section attributes.
 * Example: <span class="help-icon" data-help-doc="endpoints" data-help-section="headers"></span>
 *
 * Uses CAPTURE-phase document delegation. This is critical because help
 * icons are sometimes nested inside other clickable elements (e.g. inside
 * the Copy and Export buttons in Console). Capture phase fires before any
 * listener attached to the parent button, so the help icon wins the click
 * even when its parent has its own click handler.
 *
 * Also exposes window.openDocumentation(docPath, section) for inline JS calls
 * (used in data-transformer.js notification links).
 */
(function(window) {
    'use strict';

    var DEBUG = false; // flip true to trace clicks in DevTools
    function log() {
        if (!DEBUG || !window.console) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[help-icons]');
        window.console.log.apply(window.console, args);
    }

    function getVscodeApi() {
        // Webviews acquireVsCodeApi() then assign window.vscode = vscode.
        if (window.vscode && typeof window.vscode.postMessage === 'function') {
            return window.vscode;
        }
        return null;
    }

    function openDocsUrl(doc, section) {
        var url = 'https://dbmn.io/docs/' + doc + '/' + (section ? '#' + section : '');
        var api = getVscodeApi();
        log('openDocsUrl', { doc: doc, section: section, url: url, hasApi: !!api });
        if (!api) {
            log('ERROR: window.vscode missing — webview did not assign it before click');
            return;
        }
        // url goes in payload so it survives the BaseMessage normalizer in
        // service-aware-base.ts (which only forwards correlationId/type/
        // timestamp/source/target/payload to processMessage). Top-level url
        // would be silently dropped on Console.
        api.postMessage({
            type: 'openExternalUrl',
            source: 'webview',
            target: 'extension',
            timestamp: Date.now(),
            payload: { url: url }
        });
    }

    var delegationAttached = false;
    function onClickCapture(e) {
        var target = e.target;
        // Some browsers report SVG element as target with no closest() helper for
        // the parent span — use el.parentNode walk as a fallback.
        var el = null;
        if (target && typeof target.closest === 'function') {
            el = target.closest('[data-help-doc]');
        }
        if (!el) {
            var node = target;
            while (node && node !== document) {
                if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-help-doc')) {
                    el = node;
                    break;
                }
                node = node.parentNode;
            }
        }
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
        var doc = el.getAttribute('data-help-doc');
        var section = el.getAttribute('data-help-section') || '';
        log('help-icon click', { doc: doc, section: section, target: target && target.tagName });
        openDocsUrl(doc, section);
    }

    function attachDelegation() {
        if (delegationAttached) return;
        delegationAttached = true;
        // useCapture=true so we beat parent-button click handlers.
        document.addEventListener('click', onClickCapture, true);
        log('delegation attached (capture phase)');
    }

    log('documentation-helpers.js loaded; readyState=', document.readyState);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachDelegation);
    } else {
        attachDelegation();
    }

    // Backwards-compatible no-op shim. Delegation already covers all icons,
    // including those rendered into modals after page load.
    window.initializeAllHelpIcons = function() {
        attachDelegation();
    };

    // Backwards-compatible: used by inline onclick handlers (e.g., data-transformer.js)
    window.openDocumentation = openDocsUrl;
})(window);
