/**
 * The REAL Console page: the Views drop-down with many views (GitHub Issue #439).
 *
 * Reported 2026-11-10: with many views on an endpoint, the list ran under the footer and the
 * last views could not be reached. The results area clips what overflows it, and the list hung
 * inside it. The list now floats over the page, above the footer, and scrolls within the window.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage } from './console-page.mjs';

const BATCH = 'batch-439';

const row = (n) => ({
    httpStatus: 200, httpStatusText: 'OK', duration: 20, headers: {},
    data: { data: { id: n, name: `Item ${n}`, packages: [{ code: `P${n}` }] } },
    metadata: { executionId: `exec_${n}`, sourceFile: `transaction-${n}-response.json`, status: 'completed' },
    status: 'completed'
});

test('every view in a long list can be reached: the list stays in the window, above the footer, and scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 560 });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-views-dropdown.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH, executionId: BATCH, statusDisplay: '✅ Completed', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);

    // Twelve saved views on the Completed tab
    await page.evaluate(rows => {
        const mgr = window.dynamicReportManager;
        mgr.initialize({ responses: rows, requests: [], logContent: [] });
        document.getElementById('loading-overlay')?.classList.add('hidden');
        const views = Array.from({ length: 12 }, (_, i) => ({ name: `View ${i + 1}`, rowBasis: 'body.data', columns: [{ path: 'id' }, { path: 'name' }] }));
        mgr.userSettings.success = { ...(mgr.userSettings.success || {}), views, activeView: 'View 1' };
        mgr.currentTab = 'success';
        mgr.updateRootPathSelector();
    }, Array.from({ length: 5 }, (_, i) => row(i + 1)));

    await page.locator('#view-path-btn').click();
    const dropdown = page.locator('#root-dropdown');
    await expect(dropdown).toBeVisible();

    // Inside the window, not cut off at the results area
    const box = await dropdown.boundingBox();
    expect(box.y + box.height, 'the list ends inside the window').toBeLessThanOrEqual(560);
    expect(box.y + box.height, 'and reaches down over the footer').toBeGreaterThan(560 - 60);

    // Nothing is drawn over it: not the results area's edge, not the footer (zoomed in, the list
    // reaches down over both)
    const covered = await dropdown.evaluate(d => {
        const r = d.getBoundingClientRect();
        return [r.top + 10, (r.top + r.bottom) / 2, r.bottom - 4].filter(y => !d.contains(document.elementFromPoint(r.left + 20, y))).map(Math.round);
    });
    expect(covered, 'heights where something covers the list').toEqual([]);

    // The last view can be scrolled to and clicked: nothing covers or clips it
    const last = page.locator('.root-path-item', { hasText: 'View 12' });
    await last.scrollIntoViewIfNeeded();
    const hit = await last.evaluate(el => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
        return !!top && el.contains(top);
    });
    expect(hit, 'View 12 is on top where it is drawn').toBe(true);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
