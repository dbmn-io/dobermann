/**
 * DbmnToast, in a real browser, in the shape the Hub actually runs it.
 *
 * Reported 2026-09-21: a host toast ("badge earned") and a toast from an editor open as a
 * Hub tab ("pasted successfully") appeared on top of each other instead of stacking. Cause:
 * an editor mounted as a Hub tab lives in its own srcdoc iframe (hub-tabs.js) which loads
 * dbmn-toast.js again — a second bottom-right container over the Hub's, neither document
 * able to see the other's toasts. These tests drive both documents together.
 *
 *   npm run test:e2e:webview      (no backend needed — the files are read from src/)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHARED = join(ROOT, 'src/webviews/shared');
const toastCss = readFileSync(join(SHARED, 'toast.css'), 'utf8');
const toastJs = readFileSync(join(SHARED, 'dbmn-toast.js'), 'utf8');

/** The marker hub-tabs.js' shim sets inside every embedded tab. Kept in step by
 *  the 'the Hub marks its tab iframes as embedded' test below. */
const EMBED_MARKER = '__dbmnEmbeddedTab__';

/**
 * A Hub-shaped page: the Hub document itself, with a full-bleed srcdoc iframe standing in
 * for a tab-hosted editor. Both documents load the real toast.css + dbmn-toast.js, and the
 * iframe carries the embed marker exactly as the Hub's shim sets it.
 */
function hubPage({ embedded = true } = {}) {
    const child = [
        '<!doctype html><html><head>',
        `<style>${toastCss}</style>`,
        embedded ? `<script>window.${EMBED_MARKER} = 'endpoint:abc';</script>` : '',
        `<script>${toastJs}</script>`,
        '</head><body style="margin:0;height:100%"></body></html>'
    ].join('');
    return [
        '<!doctype html><html><head>',
        `<style>html,body{margin:0;height:100%;background:#1e1e1e;color:#ccc;font-family:sans-serif}
         iframe{position:absolute;inset:40px 0 0 220px;width:calc(100% - 220px);height:calc(100% - 40px);border:0}
         ${toastCss}</style>`,
        `<script>${toastJs}</script>`,
        '</head><body>',
        `<iframe id="tab" srcdoc="${child.replace(/"/g, '&quot;')}"></iframe>`,
        '</body></html>'
    ].join('');
}

/** Screen rects of every visible toast, in both documents. */
async function toastRects(page) {
    const collect = () => Array.from(document.querySelectorAll('.dbmn-toast')).map((n) => {
        const r = n.getBoundingClientRect();
        return { text: n.textContent, top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    });
    const outer = await page.evaluate(collect);
    // The iframe is positioned by the parent, so shift the child's rects into screen space.
    const frameBox = await page.locator('#tab').boundingBox();
    const inner = (await page.frameLocator('#tab').locator('body').evaluate(collect)).map((r) => ({
        ...r, top: r.top + frameBox.y, bottom: r.bottom + frameBox.y,
        left: r.left + frameBox.x, right: r.right + frameBox.x
    }));
    return [...outer, ...inner];
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function loadHub(page, opts) {
    await page.setContent(hubPage(opts));
    await expect(page.frameLocator('#tab').locator('body')).toBeAttached();
    // The srcdoc document has to have run dbmn-toast.js before we call into it.
    await page.waitForFunction(() => !!document.getElementById('tab')?.contentWindow?.DbmnToast);
}

/** Fire a toast from the embedded tab's own document, as an editor in a Hub tab does. */
const fromTab = (page, level, message) => page.evaluate(([l, m]) => {
    document.getElementById('tab').contentWindow.DbmnToast.show(l, m);
}, [level, message]);

test('a host toast and an embedded editor toast stack — they never cover each other', async ({ page }) => {
    await loadHub(page);

    await page.evaluate(() => window.DbmnToast.info('Badge earned: Sit'));
    await fromTab(page, 'success', 'Endpoint data pasted successfully');

    const rects = await toastRects(page);
    expect(rects).toHaveLength(2);
    expect(overlaps(rects[0], rects[1])).toBe(false);
    // One stack means one container, in the Hub document.
    expect(await page.locator('.dbmn-toast').count()).toBe(2);
    expect(await page.frameLocator('#tab').locator('.dbmn-toast').count()).toBe(0);
});

test('a standalone webview (no embed marker) still renders its own toasts', async ({ page }) => {
    await loadHub(page, { embedded: false });

    await fromTab(page, 'info', 'Saved');

    expect(await page.frameLocator('#tab').locator('.dbmn-toast').count()).toBe(1);
    expect(await page.locator('.dbmn-toast').count()).toBe(0);
});

test('source-replacement and clear() from an embedded tab reach the one stack', async ({ page }) => {
    await loadHub(page);

    await page.evaluate(() => {
        const t = document.getElementById('tab').contentWindow.DbmnToast;
        t.show('info', 'Rows 1–100', { source: 'csv' });
        t.show('info', 'Rows 101–200', { source: 'csv' });
    });
    await expect(page.locator('.dbmn-toast')).toHaveCount(1);
    await expect(page.locator('.dbmn-toast')).toHaveText(/Rows 101–200/);

    await page.evaluate(() => document.getElementById('tab').contentWindow.DbmnToast.clear('csv'));
    await expect(page.locator('.dbmn-toast')).toHaveCount(0);
});

test('hovering a toast holds it open past its auto-hide', async ({ page }) => {
    await loadHub(page);

    await page.evaluate(() => window.DbmnToast.info('Read me', { durationMs: 400 }));
    await page.locator('.dbmn-toast').hover();
    await page.waitForTimeout(1200);
    await expect(page.locator('.dbmn-toast')).toHaveCount(1);

    await page.mouse.move(5, 5);
    await expect(page.locator('.dbmn-toast')).toHaveCount(0);
});

test('a burst of toasts is capped, newest kept', async ({ page }) => {
    await loadHub(page);

    await page.evaluate(() => {
        for (let i = 1; i <= 8; i++) window.DbmnToast.info('Message ' + i, { persistent: true });
    });
    // Persistent toasts are the user's to dismiss — those are never retired.
    await expect(page.locator('.dbmn-toast')).toHaveCount(8);

    await page.evaluate(() => window.DbmnToast.clear());
    await page.evaluate(() => {
        for (let i = 1; i <= 8; i++) window.DbmnToast.info('Auto ' + i);
    });
    const texts = await page.locator('.dbmn-toast:not(.is-leaving)').allTextContents();
    expect(texts.length).toBeLessThanOrEqual(4);
    expect(texts[texts.length - 1]).toContain('Auto 8');
});

test('the Hub marks its tab iframes as embedded', () => {
    // Each tab's first script (#372: a file, tab-frame.js, which hub-tabs.js loads in every tab)
    const tabFrame = readFileSync(join(ROOT, 'src/webviews/hub/tab-frame.js'), 'utf8');
    expect(tabFrame).toContain(EMBED_MARKER);
    expect(readFileSync(join(ROOT, 'src/webviews/hub/hub-tabs.js'), 'utf8')).toContain('tab-frame.js');
});

/* ── How long a toast stays, and who gets to clear it ─────────────────────────
 * Reported 2026-09-21: "we are dismissing messages WAY too quickly", and a second
 * copy replaced the first's result before it could be read. Driven on a fake clock
 * so the timings are exact and the tests stay instant.
 */

/** Seconds of the page's own clock. */
const tick = (page, seconds) => page.clock.fastForward(seconds * 1000);

test('an info toast survives well past the old 6.5s, and an error far longer', async ({ page }) => {
    await page.clock.install();
    await loadHub(page);

    await page.evaluate(() => {
        window.DbmnToast.info('Copied to clipboard');
        window.DbmnToast.error('Failed to copy');
    });
    await expect(page.locator('.dbmn-toast')).toHaveCount(2);

    await tick(page, 7);
    await expect(page.locator('.dbmn-toast')).toHaveCount(2, { timeout: 2000 });

    await tick(page, 3); // 10s — info has gone, the error has not
    await expect(page.locator('.dbmn-toast')).toHaveCount(1);
    await expect(page.locator('.dbmn-toast')).toHaveText(/Failed to copy/);

    await tick(page, 11); // 21s
    await expect(page.locator('.dbmn-toast')).toHaveCount(0);
});

test('every toast has a dismiss button, and clearing one leaves the rest', async ({ page }) => {
    await loadHub(page);

    await page.evaluate(() => {
        window.DbmnToast.success('Copied to clipboard');
        window.DbmnToast.info('Badge earned: Sit');
    });
    await expect(page.locator('.dbmn-toast-close')).toHaveCount(2);

    await page.locator('.dbmn-toast', { hasText: 'Copied to clipboard' }).locator('.dbmn-toast-close').click();
    await expect(page.locator('.dbmn-toast')).toHaveCount(1);
    await expect(page.locator('.dbmn-toast')).toHaveText(/Badge earned/);
});

test('two copy results stack instead of replacing each other', async ({ page }) => {
    await loadHub(page);

    // What the Console's copy buttons do now — no `source`, so no single-slot replace.
    await fromTab(page, 'success', 'Copied to clipboard');
    await fromTab(page, 'error', 'Failed to copy');

    await expect(page.locator('.dbmn-toast')).toHaveCount(2);
    const rects = await toastRects(page);
    expect(overlaps(rects[0], rects[1])).toBe(false);
});
