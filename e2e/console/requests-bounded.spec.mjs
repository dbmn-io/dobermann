/**
 * The Requests table pages in a screenful at a time, however many requests a run has (2026-11-25: Review's table sat
 * in a box with no height, so its scroll box grew with every row it drew and it asked for page after page until all
 * 67,000 of lesson 2's requests were drawn: 5 GB, the web lessons killed). Here the Console's Requests tab, with the
 * real stylesheets, on a run of 5,000: a few hundred rows drawn at most, a page or two asked for, until it scrolls.
 *
 *   npm run test:e2e:console      (no backend needed: the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, requestsArrived } from './console-page.mjs';

const response = n => ({
    httpStatus: 201, status: 'completed', data: { created: n }, headers: { 'content-type': 'application/json' },
    metadata: { executionId: `exec_${n}`, status: 'completed', memberIndex: n, timestamp: '2026-11-25T00:00:00Z', responseTime: 40 }
});

for (const [width, height] of [[1280, 800], [2560, 1300]]) {
    test(`${width}: 5,000 requests: the table draws a screenful and asks for a page or two, not the run`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        const file = join(ROOT, `.dev-local/console-harness-requests-bounded-${width}.html`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, consolePage({ reportType: 'batch', batchId: 'batch-big', executionId: 'batch-big', styles: true }));
        await page.goto(pathToFileURL(file).href);
        await page.waitForFunction(() => !!window.dynamicReportManager);
        await page.evaluate(rs => {
            window.dynamicReportManager.initialize({ responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-big' } });
            document.getElementById('loading-overlay')?.classList.add('hidden');
        }, Array.from({ length: 5000 }, (_, i) => response(i + 1)));
        await requestsArrived(page);
        await page.locator('.tab-item[data-tab="requests"]').click();
        const rows = page.locator('#requests-table .dbmn-table-body > tr:not(.dbmn-table-spacer)');
        await expect(rows.first()).toContainText('001', { timeout: 15_000 });
        await page.waitForTimeout(1500);   // (long enough for a runaway to ask for many more pages)
        const asked = await page.evaluate(() => window.__posted.filter(m => m.type === 'console.requests.page').length);
        const drawn = await rows.count();
        const box = await page.locator('#requests-table .dbmn-table-scroll').boundingBox();
        expect(box.height, 'the rows scroll in a box no taller than the window').toBeLessThanOrEqual(height);
        expect(drawn, 'a screenful drawn, not the run').toBeLessThan(200);
        expect(asked, 'a page or two asked for').toBeLessThanOrEqual(3);
    });
}
