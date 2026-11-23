/**
 * The Console's saved searches (James, 2026-11-23: "that saved search should be everywhere where we
 * have a search box… console"), on the REAL Console page: the star in the box at its right, the searches kept
 * with the tab's View and saved with the endpoint's settings; picking one searches as typed, so an
 * @key the View doesn't show is added.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_saved_searches';
const ROWS = [
    { sku: 'DOG-001', name: 'Chew Ring', bin: 'B-12' },
    { sku: 'DOG-002', name: 'Rope Tug', bin: 'A-01' },
    { sku: 'DOG-003', name: 'Slow Feeder Bowl', bin: 'A-07' }
];
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' }, data: ROWS
});

async function open(page) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-saved-searches.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager && !!customElements.get('dbmn-saved-searches'));
    const messages = [
        envelope('console.table_data_response', {
            rawData: {
                responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
                metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
            }
        }, { success: true }),
        envelope('status_update', {
            status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.05, startTime: Date.now() - 50,
            responseData: responseFile(), progress: { completed: 1, total: 1, percentage: 100 },
            responseFile: '/tmp/transaction-response.json', requestFile: '/tmp/transaction-request.json'
        }),
        { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }
    ];
    for (const message of messages) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);
    }
    await expect(page.locator('#console-table thead th').first()).toBeVisible();
    return pageErrors;
}

const leaves = page => page.evaluate(() => {
    const out = [];
    const walk = cols => (cols || []).forEach(c => { if (c.children) walk(c.children); else out.push(c.id); });
    walk(window.dynamicReportManager.getActiveView('success').columns);
    return out;
});

test('saved with the View and the endpoint\'s settings; picked, it searches and brings back a key the View dropped', async ({ page }) => {
    const pageErrors = await open(page);
    const saved = page.locator('#console-saved');
    const button = saved.locator('.dbmn-saved-btn');
    // In the box at its right end, star only (as in Query: James, 2026-11-23), on the Completed tab
    await expect(saved).toBeVisible();
    const boxAt = await page.locator('#search-input').boundingBox();
    const starAt = await button.boundingBox();
    expect(starAt.x + starAt.width).toBeLessThanOrEqual(boxAt.x + boxAt.width);
    expect(starAt.x).toBeGreaterThan(boxAt.x + boxAt.width - 46);
    expect(Math.abs((starAt.y + starAt.height / 2) - (boxAt.y + boxAt.height / 2))).toBeLessThan(2);
    // Lucide's star and a caret, no name (the name is in the hover); the star as big as the box's magnifier, give or take 2px
    await expect(button.locator('svg')).toHaveCount(2);
    const glass = await page.locator('.search-icon-inset').first().boundingBox();
    const star = await button.locator('.dbmn-saved-star svg').boundingBox();
    expect(Math.abs(star.height - glass.height)).toBeLessThanOrEqual(2);
    await expect(button.locator('.dbmn-saved-label')).toBeHidden();
    // The text keeps clear of it
    expect(await page.locator('#search-input').evaluate(i => parseFloat(getComputedStyle(i).paddingRight))).toBeGreaterThanOrEqual(starAt.width + 4);

    // Save a search
    const box = page.locator('#search-input');
    await box.fill('@bin=A-01');
    await button.click();
    await saved.locator('.dbmn-saved-add').click();
    await saved.locator('.dbmn-saved-name-input').fill('Aisle A');
    await saved.locator('.dbmn-saved-name-input').press('Enter');
    await expect(button).toHaveAttribute('title', 'Saved search: Aisle A');
    await expect(button).toHaveClass(/is-saved/);
    // Kept on the View, and sent with the endpoint's settings
    expect(await page.evaluate(() => window.dynamicReportManager.getActiveView('success').searches)).toEqual([{ name: 'Aisle A', text: '@bin=A-01' }]);
    await expect.poll(() => page.evaluate(() => {
        const sent = window.__posted.filter(m => m.type === 'console.save_settings').pop();
        const views = sent && sent.payload.settings.success.views;
        return views ? views.map(v => v.searches || []).flat() : [];
    }), { timeout: 5000 }).toEqual([{ name: 'Aisle A', text: '@bin=A-01' }]);

    // bin taken out of the View; the box cleared
    await page.keyboard.press('Escape');
    await box.fill('');
    await page.locator('#console-table thead th', { hasText: 'bin' }).locator('.col-hide-btn').click();
    await expect.poll(() => leaves(page)).not.toContain('data.bin');
    await expect(button).not.toHaveClass(/is-saved/);
    // Picked: the box holds it, bin comes back, and the rows are searched
    await button.click();
    await saved.locator('.dbmn-saved-pick', { hasText: 'Aisle A' }).click();
    await expect(box).toHaveValue('@bin=A-01');
    await expect.poll(() => leaves(page)).toContain('data.bin');
    await expect(page.locator('#console-table tbody tr.data-row')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#console-table tbody tr.data-row')).toContainText('Rope Tug');
    await expect(button).toHaveAttribute('title', 'Saved search: Aisle A');
    expect(pageErrors).toEqual([]);
});
