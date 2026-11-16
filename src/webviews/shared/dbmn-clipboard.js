// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnClipboard — copying that actually works inside a VS Code webview.
 *
 * `navigator.clipboard.writeText()` / `.write()` reject inside a VS Code webview.
 * The async Clipboard API needs Chromium's `clipboard-sanitized-write`
 * permission, and VS Code's Electron permission handler does not grant that to a
 * `vscode-webview://` frame — it grants those frames `deprecated-sync-clipboard-read`,
 * which is what `document.execCommand('copy')` uses. (Focus and user activation
 * can refuse it too: `writeText` throws "Document is not focused" whenever
 * another frame holds focus.) The rejection is indistinguishable from a real
 * failure, so the user gets "Failed to copy" for a copy that would have worked.
 *
 * Reported 2026-09-21: the Console's Request and Response copy buttons said
 * "Failed to copy" while Copy All on the same card worked. Copy All was not
 * succeeding where they failed — it already had an `execCommand` fallback and had
 * been quietly using it. The plain-text copies had none, and threw the rejection
 * away without logging it, which is why the cause went unrecorded for so long.
 *
 * So: async API → execCommand → the extension host (`vscode.env.clipboard`, which
 * has none of these restrictions; the same round trip the Run API form's Paste
 * button uses to READ). Every webview copy goes through this module.
 *
 * Portability (docs/portability/spa-migration.md): the order is deliberate. The two
 * WEB standards come first and are all a browser build ever uses — `window.vscode`
 * doesn't exist there, so `hostWriteText` resolves false and is never reached. The
 * host hop is a VS Code-only shim confined to this file plus
 * services/ui/clipboard-bridge.ts; ejecting deletes those two and nothing else.
 * Callers only ever see `writeText`/`writeRich` returning a boolean.
 *
 *   DbmnClipboard.writeText('…').then(ok => ok ? toast.success() : toast.error());
 *   DbmnClipboard.writeRich('<div>…</div>', 'plain text');   // Teams / Outlook / Excel
 *
 * Both resolve to a boolean and never reject — the caller decides what to say.
 */
(function () {
    'use strict';

    /** Run `fn` with a throwaway node in the document, then clean up. */
    function withScratchNode(node, fn) {
        // Off-screen rather than hidden: `display:none` and `hidden` can't be
        // selected, and a selection is what execCommand copies.
        node.style.position = 'fixed';
        node.style.top = '0';
        node.style.left = '-9999px';
        document.body.appendChild(node);

        var selection = window.getSelection();
        var previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        try {
            return fn(node, selection);
        } finally {
            if (node.parentNode) node.parentNode.removeChild(node);
            // Restore whatever the user had selected before we borrowed it.
            if (selection) {
                selection.removeAllRanges();
                if (previous) selection.addRange(previous);
            }
        }
    }

    function execCommandText(text) {
        try {
            return withScratchNode(document.createElement('textarea'), function (area) {
                area.value = text;
                area.setAttribute('readonly', 'readonly');
                area.select();
                area.setSelectionRange(0, text.length);
                return document.execCommand('copy');
            });
        } catch (_e) {
            return false;
        }
    }

    function execCommandRich(html) {
        try {
            return withScratchNode(document.createElement('div'), function (container, selection) {
                container.innerHTML = html;
                if (!selection) return false;
                var range = document.createRange();
                range.selectNodeContents(container);
                selection.removeAllRanges();
                selection.addRange(range);
                return document.execCommand('copy');
            });
        } catch (_e) {
            return false;
        }
    }

    /** Report why the async API was refused, once per reason. The old code
     *  discarded this — which is why "Failed to copy" was a mystery. */
    var reported = {};
    function noteRefusal(api, err) {
        var reason = (err && (err.name + ': ' + err.message)) || 'unknown';
        if (reported[api + reason]) return;
        reported[api + reason] = true;
        console.warn('[dbmn-clipboard] navigator.clipboard.' + api + ' refused — falling back.',
            { reason: reason, documentFocused: document.hasFocus(), embedded: !!window.__dbmnEmbeddedTab__ });
    }

    /**
     * Ask the extension host to do the copy. `vscode.env.clipboard` runs in the
     * host process, so none of the webview's focus or permission rules apply.
     * Resolves false outside VS Code, or if the host doesn't answer.
     */
    function hostWriteText(text) {
        var bridge = window.vscode;
        if (!bridge || typeof bridge.postMessage !== 'function') return Promise.resolve(false);
        return new Promise(function (resolve) {
            var writeId = 'clipw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var settled = false;
            var timer;
            function finish(ok) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolve(ok);
            }
            function onMessage(ev) {
                var m = ev && ev.data;
                if (!m || m.type !== 'dbmnClipboardWritten' || m.writeId !== writeId) return;
                finish(m.ok === true);
            }
            window.addEventListener('message', onMessage);
            timer = setTimeout(function () { finish(false); }, 2000);
            try {
                bridge.postMessage({ type: 'dbmnClipboardWrite', writeId: writeId, text: text });
            } catch (_e) {
                finish(false);
            }
        });
    }

    /**
     * Copy plain text.
     * @param {string} text
     * @returns {Promise<boolean>} true when the text reached the clipboard.
     */
    function writeText(text) {
        var value = text === null || text === undefined ? '' : String(text);
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(value).then(
                function () { return true; },
                function (err) {
                    noteRefusal('writeText', err);
                    return execCommandText(value) || hostWriteText(value);
                }
            );
        }
        return Promise.resolve(execCommandText(value) || hostWriteText(value));
    }

    /**
     * Copy rich HTML with a plain-text alternative, so a paste into Outlook,
     * Teams, Excel or Confluence keeps its formatting and a paste into an editor
     * still gets readable text.
     * @param {string} html
     * @param {string} plainText
     * @returns {Promise<boolean>} true when something reached the clipboard.
     */
    function writeRich(html, plainText) {
        var text = plainText === null || plainText === undefined ? '' : String(plainText);
        if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
            var item = new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([text], { type: 'text/plain' })
            });
            return navigator.clipboard.write([item]).then(
                function () { return true; },
                function (err) {
                    noteRefusal('write', err);
                    // Formatting is the nice-to-have, the content is not.
                    return execCommandRich(html) || writeText(text);
                }
            );
        }
        // No rich-clipboard support at all — plain text beats copying nothing.
        return Promise.resolve(execCommandRich(html)).then(function (ok) {
            return ok ? true : writeText(text);
        });
    }

    window.DbmnClipboard = { writeText: writeText, writeRich: writeRich };
})();
