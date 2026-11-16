// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The host half of DBMN's clipboard access.
 *
 * A webview cannot be relied on to reach the clipboard itself. VS Code's Electron
 * permission handler grants a `vscode-webview://` frame `deprecated-sync-clipboard-read`
 * (what `document.execCommand` uses) but not `clipboard-read` or
 * `clipboard-sanitized-write` — the permissions the async Clipboard API asks for.
 * So `navigator.clipboard.readText()` / `.writeText()` reject inside a webview, while
 * `vscode.env.clipboard` here always works.
 *
 * The host passes its clipboard: VS Code `vscode.env.clipboard`; the web app the browser's
 * (its screens sit in frames that may not be allowed to read it themselves).
 *
 * `shared/dbmn-clipboard.js` (write) and `shared/dbmn-modal.js` (the Paste button's read)
 * both come through these two messages. Wired into both webview base classes so it does
 * not matter which one a manager happens to extend — the Console extends
 * `ServiceAwareWebview`, every other webview extends `WebviewBase`, and the Run API form
 * with its Paste button opens in both.
 */

/** The host's clipboard (`vscode.env.clipboard`, `navigator.clipboard`). */
export interface TextClipboard {
    readText(): PromiseLike<string>;
    writeText(text: string): PromiseLike<void>;
}

/** Posts a message back to the webview that sent the request. */
export type ClipboardReply = (message: Record<string, unknown>) => void;

interface ClipboardRequest {
    type?: string;
    readId?: string;
    writeId?: string;
    text?: string;
}

/**
 * Serve a clipboard request from a webview.
 * @returns true when the message was a clipboard request (and has been answered),
 *          false when it is something else the caller should keep dispatching.
 */
export async function handleClipboardMessage(message: unknown, reply: ClipboardReply, clipboard: TextClipboard): Promise<boolean> {
    const request = (message ?? {}) as ClipboardRequest;

    if (request.type === 'dbmnModalReadClipboard') {
        // Issue #302: the Run API form's Paste button.
        if (!request.readId) { return true; }
        let text = '';
        try {
            text = await clipboard.readText();
        } catch (err) {
            // Reply with empty text — the modal explains "nothing to paste".
            console.error('[clipboard-bridge] read failed:', err);
        }
        reply({ type: 'dbmnModalClipboardText', readId: request.readId, text });
        return true;
    }

    if (request.type === 'dbmnClipboardWrite') {
        // Last resort of shared/dbmn-clipboard.js, after the async Clipboard API
        // and execCommand have both been refused.
        if (!request.writeId) { return true; }
        let ok = false;
        try {
            await clipboard.writeText(typeof request.text === 'string' ? request.text : '');
            ok = true;
        } catch (err) {
            console.error('[clipboard-bridge] write failed:', err);
        }
        reply({ type: 'dbmnClipboardWritten', writeId: request.writeId, ok });
        return true;
    }

    return false;
}
