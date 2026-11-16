/**
 * #428 on the REAL Console page: a 200 that the endpoint's own test turned down is named a
 * test failure everywhere — TEST FAILED on its card with the test and its assertion under
 * the header, a Reason column first on the Error tab, a "Test failed" Status filter — and a
 * live result lands on the Error tab at once, never counted under Completed first.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH = 'batch-428';
const TEST_MESSAGE = 'Test "PostExecutionTest" failed: Expected undefined to be true';
const OK_BODY = { success: true, data: { TotalCount: 100, FailedRecords: [], FailedCount: 0, SuccessCount: 100 }, statusCode: 'OK' };

const response = (n, kind) => {
    const status = kind === 'completed' ? 'completed' : 'error';
    const metadata = { executionId: `exec_${n}`, sourceFile: `transaction-00${n}-response.json`, status, memberIndex: n, timestamp: '2026-11-05T05:05:43Z', responseTime: 480 };
    if (kind === 'test-failed') Object.assign(metadata, { testStatus: 'failed', errorMessage: TEST_MESSAGE });
    if (kind === 'server-error') Object.assign(metadata, { errorMessage: 'HTTP 400: Bad Request' });
    if (kind === 'completed') metadata.testStatus = 'passed';
    return {
        httpStatus: kind === 'server-error' ? 400 : 200, status,
        data: kind === 'server-error' ? { message: 'ItemId is required' } : OK_BODY,
        headers: { 'content-type': 'application/json' }, metadata
    };
};

async function openConsole(page) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-test-failed.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH, executionId: BATCH, styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    return pageErrors;
}

const send = (page, message) => page.evaluate(m => window.postMessage(m, '*'), message);

/** Load rows as a reopened Console does. The harness has no host to lift the loading overlay. */
const load = (page, rows) => page.evaluate(r => {
    window.dynamicReportManager.initialize({ responses: r, requests: [], logContent: [] });
    document.getElementById('loading-overlay')?.classList.add('hidden');
}, rows);

test('a test failure is named on its card, filtered on its own, and explained on the Error tab', async ({ page }) => {
    const pageErrors = await openConsole(page);
    const rows = [response(1, 'completed'), response(2, 'test-failed'), response(3, 'test-failed'), response(4, 'server-error')];
    await load(page, rows);

    await expect(page.locator('.tab-count[data-tab="errors"]')).toHaveText('3');
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('1');

    // Raw: TEST FAILED beside the 200, the reason under the header; a server error stays ERROR
    await page.locator('.tab-item[data-tab="raw"]').click();
    const card = n => page.locator(`.raw-card[data-exec-id="exec_${n}"]`);
    await expect(card(2).locator('.raw-status-badge')).toHaveText('TEST FAILED');
    await expect(card(2).locator('.raw-http-status')).toHaveText('200');
    await expect(card(2).locator('.raw-card-reason-text')).toHaveText(TEST_MESSAGE);
    await expect(card(2).locator('.raw-card-reason-note')).toContainText('The server answered 200');
    await expect(card(4).locator('.raw-status-badge')).toHaveText('ERROR');
    await expect(card(4).locator('.raw-card-reason-text')).toHaveText('HTTP 400: Bad Request');
    await expect(card(4).locator('.raw-card-reason-note')).toHaveCount(0);
    await expect(card(1).locator('.raw-card-reason')).toHaveCount(0);

    // The Status filter has Test failed after Error, each under one: the server error is Error's
    // only one, so it can't hide among test failures, and the counts add up to All
    const options = await page.locator('#raw-status-select option').allTextContents();
    expect(options).toContain('All (4)');
    expect(options).toContain('Completed (1)');
    expect(options).toContain('Test failed (2)');
    expect(options.indexOf('Test failed (2)')).toBe(options.indexOf('Error (1)') + 1);
    await page.locator('#raw-status-select').selectOption('error');
    await expect(page.locator('.raw-cards-container .raw-card')).toHaveCount(1);
    await expect(card(4)).toHaveCount(1);
    await page.locator('#raw-status-select').selectOption('test-failed');
    await expect(page.locator('.raw-cards-container .raw-card')).toHaveCount(2);
    await page.screenshot({ path: join(ROOT, '.dev-local/428-raw-test-failed.png'), fullPage: true });

    // Error tab: Reason first, whatever the view; not a column the view can hide
    await page.locator('.tab-item[data-tab="errors"]').click();
    const firstHeader = page.locator('#table-head th').first();
    await expect(firstHeader.locator('.column-name')).toHaveText('Reason');
    await expect(firstHeader.locator('.column-hide-btn')).toHaveCount(0);
    const reasons = await page.locator('#table-body tr').evaluateAll(trs => trs.map(tr => tr.querySelector('td')?.textContent?.trim()));
    expect(reasons).toEqual([TEST_MESSAGE, TEST_MESSAGE, 'HTTP 400: Bad Request']);
    await page.screenshot({ path: join(ROOT, '.dev-local/428-error-tab.png'), fullPage: true });

    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('live: a test failure goes straight to Error, never counted under Completed first', async ({ page }) => {
    const pageErrors = await openConsole(page);
    await load(page, [response(1, 'completed')]);
    const badge = tab => page.locator(`.tab-count[data-tab="${tab}"]`);
    await expect(badge('success')).toHaveText('1');

    // What the engine now sends for a 200 whose test failed: classification by its saved status
    const seen = new Set();
    for (const n of [2, 3, 4]) {
        await send(page, envelope('batch_member_result_update', { result: response(n, 'test-failed'), classification: 'errors', memberIndex: n, totalMembers: 4, batchId: BATCH }));
        await page.waitForTimeout(30);
        seen.add(await badge('success').textContent());
    }
    expect([...seen], 'Completed never counted them').toEqual(['1']);
    await expect(badge('errors')).toHaveText('3');

    await page.locator('.tab-item[data-tab="raw"]').click();
    await expect(page.locator('.raw-card[data-exec-id="exec_3"] .raw-status-badge')).toHaveText('TEST FAILED');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
