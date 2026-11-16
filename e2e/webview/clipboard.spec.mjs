/**
 * DbmnClipboard, in a real browser.
 *
 * Reported 2026-09-21: the Console's Request and Response copy buttons said "Failed to copy"
 * while Copy All on the same card worked. Copy All had an execCommand fallback and had been
 * quietly using it — the async Clipboard API rejects in a webview whenever the document
 * isn't focused or the API isn't permitted in the tab's iframe. These tests reject the async
 * API the same way and prove the text still reaches the clipboard.
 *
 *   npm run test:e2e:webview
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clipboardJs = readFileSync(join(ROOT, 'src/webviews/shared/dbmn-clipboard.js'), 'utf8');

const PAGE = `<!doctype html><html><head><script>${clipboardJs}</script></head>
    <body><p id="keep">some text the user had selected</p></body></html>`;

// navigator.clipboard only exists in a secure context, which http://127.0.0.1 is and
// about:blank / file:// are not. One throwaway server for the file.
let server, origin;
test.beforeAll(async () => {
    server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(() => server?.close());

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function load(page, { rejectAsyncApi = false } = {}) {
    await page.goto(origin);
    if (rejectAsyncApi) {
        // Exactly how a webview fails: "NotAllowedError: Document is not focused".
        await page.evaluate(() => {
            const err = () => Promise.reject(new DOMException('Document is not focused', 'NotAllowedError'));
            Object.defineProperty(navigator.clipboard, 'writeText', { value: err, configurable: true });
            Object.defineProperty(navigator.clipboard, 'write', { value: err, configurable: true });
        });
    }
}

const read = (page) => page.evaluate(() => navigator.clipboard.readText());

test('writeText copies when the async Clipboard API works', async ({ page }) => {
    await load(page);

    expect(await page.evaluate(() => window.DbmnClipboard.writeText('{"sku":"WOOF-1"}'))).toBe(true);
    expect(await read(page)).toBe('{"sku":"WOOF-1"}');
});

test('writeText still copies when the async Clipboard API is refused', async ({ page }) => {
    await load(page, { rejectAsyncApi: true });

    expect(await page.evaluate(() => window.DbmnClipboard.writeText('{"sku":"WOOF-2"}'))).toBe(true);
    expect(await read(page)).toBe('{"sku":"WOOF-2"}');
});

test('writeRich falls back without losing the content', async ({ page }) => {
    await load(page, { rejectAsyncApi: true });

    const ok = await page.evaluate(() =>
        window.DbmnClipboard.writeRich('<b>REQUEST</b><pre>{}</pre>', 'REQUEST\n{}'));
    expect(ok).toBe(true);
    expect(await read(page)).toContain('REQUEST');
});

test('the copy leaves the user\'s own selection alone', async ({ page }) => {
    await load(page, { rejectAsyncApi: true });

    await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('keep'));
        window.getSelection().addRange(range);
    });
    await page.evaluate(() => window.DbmnClipboard.writeText('something else'));

    expect(await page.evaluate(() => window.getSelection().toString()))
        .toBe('some text the user had selected');
});

test('an empty or null value is copied as empty, not crashed on', async ({ page }) => {
    await load(page);

    expect(await page.evaluate(() => window.DbmnClipboard.writeText(null))).toBe(true);
    expect(await read(page)).toBe('');
});

test('the extension host is the last resort when the browser refuses outright', async ({ page }) => {
    await load(page, { rejectAsyncApi: true });

    // execCommand refused too (a locked-down host, or a future Chromium without it):
    // the webview asks the extension host, whose vscode.env.clipboard always works.
    const result = await page.evaluate(() => {
        document.execCommand = () => false;
        window.vscode = {
            postMessage: (m) => {
                window.__sentToHost = m;
                window.postMessage({ type: 'dbmnClipboardWritten', writeId: m.writeId, ok: true }, '*');
            }
        };
        return window.DbmnClipboard.writeText('{"sku":"WOOF-3"}');
    });

    expect(result).toBe(true);
    expect(await page.evaluate(() => window.__sentToHost)).toMatchObject({
        type: 'dbmnClipboardWrite', text: '{"sku":"WOOF-3"}'
    });
});

test('a copy outside VS Code fails honestly rather than hanging', async ({ page }) => {
    await load(page, { rejectAsyncApi: true });

    // No host bridge and no execCommand: the caller gets false and can say so.
    const result = await page.evaluate(() => {
        document.execCommand = () => false;
        return window.DbmnClipboard.writeText('nowhere to go');
    });

    expect(result).toBe(false);
});

test('every webview that can toast can also copy', async () => {
    // The helper is only useful where it is loaded. Any webview carrying
    // dbmn-toast.js is a webview a copy button can appear in.
    const { globSync } = await import('node:fs');
    const sources = globSync('src/webviews/**/*.{html,ts}', { cwd: ROOT })
        .map((f) => [f, readFileSync(join(ROOT, f), 'utf8')])
        .filter(([, text]) => text.includes('dbmn-toast.js') || /DBMN_TOAST_(SCRIPT|URI|JS_URI)/.test(text));
    const missing = sources
        .filter(([, text]) => !text.includes('dbmn-clipboard.js') && !/DBMN_CLIPBOARD/.test(text))
        .map(([file]) => file);

    expect(missing).toEqual([]);
});

test('no webview copies through navigator.clipboard directly', async () => {
    // The whole point of the module: one implementation with one fallback. A direct
    // `navigator.clipboard.writeText()` anywhere else re-opens the reported bug.
    const { globSync } = await import('node:fs');
    const offenders = globSync('src/webviews/**/*.js', { cwd: ROOT })
        .filter((f) => !f.endsWith('dbmn-clipboard.js'))
        .filter((f) => /navigator\.clipboard\.(writeText|write)\s*\(/.test(readFileSync(join(ROOT, f), 'utf8')));

    expect(offenders).toEqual([]);
});
