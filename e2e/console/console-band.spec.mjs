/**
 * The REAL Console page in the screen band (James, 2026-11-24): at 2560 wide the tabs, the toolbar and the footer's
 * contents sit in the centred --dbmn-band (1280); its rows keep their own width. At 1280 nothing is squeezed.
 *
 *   npm run test:e2e:console      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage } from './console-page.mjs';

async function open(p, width) {
    await p.setViewportSize({ width, height: 900 });
    const dir = join(ROOT, '.dev-local', 'console-band');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'console.html');
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: 'b1', styles: true }));
    await p.goto(pathToFileURL(file).href);
    await p.waitForTimeout(300);
    return p.evaluate(() => {
        const box = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
        const foot = document.querySelector('dbmn-footer');
        const kids = [...foot.children].filter(k => k.getBoundingClientRect().width > 0).map(k => k.getBoundingClientRect());
        return { tabs: box(document.getElementById('report-tabs')), toolbar: box(document.getElementById('report-toolbar')),
            foot: { left: Math.min(...kids.map(k => k.left)), right: Math.max(...kids.map(k => k.right)) }, page: document.documentElement.scrollWidth };
    });
}

test('at 2560: the tabs, the toolbar and the footer in the centred 1280 band', async ({ page: p }) => {
    const m = await open(p, 2560);
    const lo = (2560 - 1280) / 2, hi = (2560 + 1280) / 2;
    for (const what of ['tabs', 'toolbar', 'foot']) {
        expect(m[what].left, `${what} starts inside the band`).toBeGreaterThanOrEqual(lo - 1);
        expect(m[what].right, `${what} ends inside the band`).toBeLessThanOrEqual(hi + 1);
        expect(m[what].left, `${what} near the band's left edge`).toBeLessThan(lo + 40);
    }
    await p.screenshot({ path: join(ROOT, '.dev-local', 'console-band', 'console-2560.png') });
});

test('at 1280: nothing squeezed, no sideways scroll', async ({ page: p }) => {
    const m = await open(p, 1280);
    expect(m.page).toBeLessThanOrEqual(1280);
    expect(m.toolbar.width, 'the screen\'s own side room only').toBeGreaterThanOrEqual(1280 - 40);
});
