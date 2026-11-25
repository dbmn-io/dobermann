/**
 * A batch's first result and the tab the Console shows (2026-11-26). The Console moves to Completed when the first
 * result of a run lands, once, if it is still on the tab it opened on. A tab the person clicked counts as their choice,
 * Requests included: they stay there (James, on this screen: "a running batch shouldn't interrupt"). And the Requests
 * table, hidden while results came in, is right the moment it is shown again; its count line never says more rows
 * than it shows.
 *
 *   npx playwright test --config e2e/console/playwright.config.mjs e2e/console/first-result-tab.spec.mjs
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope, requestsArrived } from './console-page.mjs';

const BATCH_ID = '2026-11-26T01-00-00_first';
const ROWS = 8;
const inputRow = i => ({ sku: `SKU-${i}`, description: i % 2 ? 'BOX, 12' : 'Plain', quantity: i });
const result = i => ({
    httpStatus: 201, httpStatusText: 'Created', duration: 30, headers: { 'content-type': 'application/json' },
    data: { created: 1, sku: `SKU-${i}` },
    metadata: { executionId: `exec_${i}`, sourceFile: `transaction-${i}-response.json`, status: 'completed', memberIndex: i, timestamp: '2026-11-26T01:00:00Z', responseTime: 30 },
    status: 'completed'
});

/** A running batch's Console, its input in and no result yet: it opens on Input. */
async function runningBatch(page) {
    const file = join(ROOT, '.dev-local/console-harness-first-result-tab.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await post(page, envelope('console.table_data_response', {
        rawData: { responses: [], inputData: Array.from({ length: ROWS }, (_, i) => inputRow(i + 1)), metadata: { executionId: BATCH_ID, batchId: BATCH_ID, totalRows: ROWS, rows: String(ROWS) }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} }
    }));
    await expect(page.locator('.tab-item[data-tab="input"]')).toHaveClass(/active/);
    // The Requests table's count line beside the rows it draws, at every change a person could see
    await page.evaluate(() => {
        window.__countOverRows = [];
        const check = () => {
            const panel = document.getElementById('requests-tab-content');
            const table = document.getElementById('requests-table');
            if (!panel || !table || panel.classList.contains('hidden')) return;
            const said = Number(((table.querySelector('.dbmn-table-count') || {}).textContent || '').replace(/[^\d]/g, '')) || 0;
            const drawn = table.querySelectorAll('.dbmn-table-body > tr:not(.dbmn-table-spacer)').length;
            if (said > drawn) window.__countOverRows.push(`"${said} rows" over ${drawn}`);
        };
        new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    });
}

const post = (page, m) => page.evaluate(message => window.postMessage(message, '*'), m);
/** Results landing, as the engine sends them; the host's word that the stored run has them. */
async function resultsLand(page, from, to) {
    for (let i = from; i <= to; i++) {
        await post(page, envelope('batch_member_result_update', { result: result(i), classification: 'success', memberIndex: i, batchId: BATCH_ID, totalMembers: ROWS }));
    }
    await requestsArrived(page);
}
const rowsDrawn = page => page.locator('#requests-table .dbmn-table-body > tr:not(.dbmn-table-spacer)');

test('Requests clicked before the first result: the Console stays on Requests, and shows every request after the run', async ({ page }) => {
    await runningBatch(page);
    await page.locator('.tab-item[data-tab="requests"]').click();
    await expect(page.locator('.tab-item[data-tab="requests"]')).toHaveClass(/active/);
    await resultsLand(page, 1, ROWS);
    await page.waitForTimeout(300);   // (the switch, when it happens, is a tick after the first result)
    await expect(page.locator('.tab-item[data-tab="requests"]'), 'still on Requests').toHaveClass(/active/);
    await expect(page.locator('.tab-item[data-tab="success"]')).not.toHaveClass(/active/);
    await expect(rowsDrawn(page)).toHaveCount(ROWS);
    expect(await page.evaluate(() => window.__countOverRows)).toEqual([]);
});

test('no tab clicked: the first result moves the Console to Completed, as before', async ({ page }) => {
    await runningBatch(page);
    await resultsLand(page, 1, ROWS);
    await expect(page.locator('.tab-item[data-tab="success"]')).toHaveClass(/active/);
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText(String(ROWS));
});

test('the Requests table, hidden while results came in, is right the moment it is shown again', async ({ page }) => {
    await runningBatch(page);
    // Requests drawn with the first 2, then the person goes to Completed; the other 6 land while it is hidden
    await page.locator('.tab-item[data-tab="requests"]').click();
    await resultsLand(page, 1, 2);
    await expect(rowsDrawn(page)).toHaveCount(2);
    await page.locator('.tab-item[data-tab="success"]').click();
    await resultsLand(page, 3, ROWS);
    await page.waitForTimeout(300);
    // Shown again: every request, and never a count above the rows on screen meanwhile
    await page.locator('.tab-item[data-tab="requests"]').click();
    await expect(rowsDrawn(page)).toHaveCount(ROWS);
    await expect(page.locator('#requests-table .dbmn-table-count')).toHaveText(`${ROWS} rows`);
    expect(await page.evaluate(() => window.__countOverRows)).toEqual([]);
});
