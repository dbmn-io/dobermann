/**
 * The Console's toolbar at the widths James works at (900 to 1280 px), on the REAL page: every control in
 * it can be reached (the element under its middle is the control itself, nothing laid over it) and none
 * is cut off at the window's edge; the ★ opens a menu whose items are on top and in the window.
 * (The manager for James, 2026-11-23, after a ★ that couldn't be clicked: "hunt for anything like the dead ★".)
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_toolbar_reach';
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' }, data: [{ sku: 'DOG-001', name: 'Chew Ring', bin: 'B-12' }, { sku: 'DOG-002', name: 'Rope Tug', bin: 'A-01' }]
});

async function open(page, width, dark) {
    const file = join(ROOT, `.dev-local/console-harness-reach-${width}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    for (const message of [
        envelope('console.table_data_response', { rawData: { responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }], metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} } }, { success: true }),
        envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.05, startTime: Date.now() - 50, responseData: responseFile(), progress: { completed: 1, total: 1, percentage: 100 }, responseFile: '/tmp/r.json', requestFile: '/tmp/q.json' }),
        { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }
    ]) { await page.evaluate(m => window.postMessage(m, '*'), message); await page.waitForTimeout(20); }
    await expect(page.locator('#console-table thead th').first()).toBeVisible();
}

/** Each visible control in `scope`: can it be clicked (nothing laid over its middle), and is it all in the window? */
const reach = (page, scope) => page.evaluate(sel => {
    const out = [];
    document.querySelectorAll(`${sel} button, ${sel} select, ${sel} input`).forEach(c => {
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(c).visibility === 'hidden') return;
        if (c.tabIndex < 0 || c.closest('[aria-hidden="true"]')) return;   // (out of reach on purpose)
        const name = (c.id || c.getAttribute('aria-label') || c.textContent || c.className).trim().slice(0, 30);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !(hit === c || c.contains(hit))) out.push(`${name}: covered by ${hit ? (hit.id || hit.className || hit.tagName) : 'nothing'}`);
        if (r.right > window.innerWidth + 0.5 || r.left < -0.5) out.push(`${name}: cut off at the edge`);
    });
    return out;
}, scope);

for (const width of [900, 1100, 1280]) {
    for (const dark of [false, true]) {
        test(`at ${width}px (${dark ? 'dark' : 'light'}): every toolbar control can be clicked and none is cut off; the ★ menu is on top`, async ({ page }) => {
            await open(page, width, dark);
            expect(await reach(page, '#report-toolbar')).toEqual([]);
            // The ★: its menu on top of the table, in the window
            await page.locator('#console-saved .dbmn-saved-btn').click();
            const menu = page.locator('#console-saved .dbmn-saved-menu');
            await expect(menu).toBeVisible();
            expect(await reach(page, '#console-saved .dbmn-saved-menu')).toEqual([]);
            const box = await menu.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
        });
    }
}
