// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for the host half of DBMN's clipboard access.
 *
 * A webview can't reach the clipboard itself: VS Code's Electron permission handler
 * doesn't grant `vscode-webview://` frames the `clipboard-read` /
 * `clipboard-sanitized-write` permissions the async Clipboard API needs. Both webview
 * base classes route those requests here, so the answer is the same whichever base a
 * manager happens to extend.
 */
import '../../../setup';
import { expect } from 'chai';
import { handleClipboardMessage } from '../../../../services/ui/clipboard-bridge';

interface ClipboardStub {
    text: string;
    readText: () => Promise<string>;
    writeText: (value: string) => Promise<void>;
    failRead?: boolean;
    failWrite?: boolean;
}

describe('clipboard bridge', () => {
    let clipboard: ClipboardStub;
    let replies: Record<string, unknown>[];
    const reply = (message: Record<string, unknown>) => { replies.push(message); };

    beforeEach(() => {
        replies = [];
        clipboard = {
            text: 'on the clipboard',
            readText: async () => {
                if (clipboard.failRead) { throw new Error('denied'); }
                return clipboard.text;
            },
            writeText: async (value: string) => {
                if (clipboard.failWrite) { throw new Error('denied'); }
                clipboard.text = value;
            }
        };
    });

    it('answers a read with the clipboard text, tagged with the request id', async () => {
        const served = await handleClipboardMessage(
            { type: 'dbmnModalReadClipboard', readId: 'r1' }, reply, clipboard);

        expect(served).to.equal(true);
        expect(replies).to.deep.equal([
            { type: 'dbmnModalClipboardText', readId: 'r1', text: 'on the clipboard' }
        ]);
    });

    it('answers a failed read with empty text rather than leaving the modal hanging', async () => {
        clipboard.failRead = true;

        await handleClipboardMessage({ type: 'dbmnModalReadClipboard', readId: 'r2' }, reply, clipboard);

        expect(replies[0]).to.deep.equal({ type: 'dbmnModalClipboardText', readId: 'r2', text: '' });
    });

    it('writes and confirms', async () => {
        const served = await handleClipboardMessage(
            { type: 'dbmnClipboardWrite', writeId: 'w1', text: '{"sku":"WOOF-1"}' }, reply, clipboard);

        expect(served).to.equal(true);
        expect(clipboard.text).to.equal('{"sku":"WOOF-1"}');
        expect(replies).to.deep.equal([{ type: 'dbmnClipboardWritten', writeId: 'w1', ok: true }]);
    });

    it('reports a failed write as ok:false, so the webview can say "Failed to copy"', async () => {
        clipboard.failWrite = true;

        await handleClipboardMessage({ type: 'dbmnClipboardWrite', writeId: 'w2', text: 'x' }, reply, clipboard);

        expect(replies[0]).to.deep.equal({ type: 'dbmnClipboardWritten', writeId: 'w2', ok: false });
    });

    it('treats a missing text as an empty copy rather than writing "undefined"', async () => {
        await handleClipboardMessage({ type: 'dbmnClipboardWrite', writeId: 'w3' }, reply, clipboard);

        expect(clipboard.text).to.equal('');
    });

    it('leaves every other message to the caller', async () => {
        const served = await handleClipboardMessage({ type: 'saveEndpoint' }, reply, clipboard);

        expect(served).to.equal(false);
        expect(replies).to.be.empty;
    });

    it('never replies to a request with no id — an unmatched reply would settle the wrong promise', async () => {
        expect(await handleClipboardMessage({ type: 'dbmnModalReadClipboard' }, reply, clipboard)).to.equal(true);
        expect(await handleClipboardMessage({ type: 'dbmnClipboardWrite', text: 'x' }, reply, clipboard)).to.equal(true);

        expect(replies).to.be.empty;
    });
});
