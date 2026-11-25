/**
 * The REAL Console page when Monaco's loader can't be fetched from its CDN (a network blip: CI run
 * 45082794013 failed first-result-tab on "require is not defined"). The page carries on without
 * Monaco: no uncaught error, and the Completed tab shows its rows.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope, openFirstRequest, requestsArrived } from './console-page.mjs';

const EXEC_ID = 'exec_monaco_cdn_down';
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' }, data: [{ sku: 'DOG-001', qty: 7 }, { sku: 'DOG-002', qty: 40 }]
});

test('Monaco\'s CDN down: the Console opens without an error and shows the rows', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // The CDN refuses: loader.js never arrives, so there is no AMD `require`
    await page.route(/cdn\.jsdelivr\.net/, route => route.abort('internetdisconnected'));
    const file = join(ROOT, '.dev-local/console-harness-monaco-cdn-down.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
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
        })
    ];
    for (const message of messages) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);
    }
    // (its rows are on Completed, whichever tab a Run API opens on)
    await page.locator('.tab-item[data-tab="success"]').click();
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(2);
    // The full transaction too (B22: Raw is gone), opened from the Requests tab; its panes need Monaco, so they show the
    // text without it
    await requestsArrived(page);
    await openFirstRequest(page);
    const tx = page.locator('dbmn-transaction[window]');
    await expect(tx).toHaveCount(1);
    await expect(tx.locator('.dbmn-tx-pane[data-part="response"] [data-editor="text"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(tx.locator('.dbmn-tx-pane[data-part="response"] .dbmn-tx-code')).not.toHaveText('—');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
