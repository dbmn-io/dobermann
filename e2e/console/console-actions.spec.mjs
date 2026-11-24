/**
 * The REAL Console page's footer Actions (B20): Copy, Export, Chain and Query under one menu in the footer, the
 * toolbar's own buttons gone from sight; each item does what its old control did.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH_ID = '2026-09-23T10-27-36_yz4';
const MEMBER_ID = 'exec_1790159256185_l1pneugx0';


/** One page of /inventory, as the response file holds it. */
const pageResponse = () => ({
    httpStatus: 200, httpStatusText: 'OK', duration: 755, headers: { 'content-type': 'application/json' },
    data: { totalCount: 74979, pageSize: 500, page: 0, totalPages: 150, data: [
        { sku: 'DOG-001', locationGln: '4012345000009', quantity: 12 },
        { sku: 'DOG-002', locationGln: '4012345000009', quantity: 3 },
        { sku: 'DOG-003', locationGln: '4012345000016', quantity: 40 }
    ] },
    metadata: { executionId: MEMBER_ID, sourceFile: 'transaction-001-response.json', timestamp: '2026-09-23T10:27:37.614Z' }
});

/** The Console opened during PREPARING: the member exists but has no response yet. */
const initialLoad = () => envelope('console.table_data_response', {
    rawData: {
        responses: [{ httpStatus: '-', status: 'pending', data: null, metadata: { executionId: MEMBER_ID, sourceFile: undefined, status: 'pending', timestamp: '2026-09-23T10:27:36.189Z' } }],
        metadata: { executionId: BATCH_ID, batchId: BATCH_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
    }
});

const messages = [
    initialLoad(),
    envelope('status_update', { status: 'running', statusDisplay: '🔄 Running', durationSeconds: 0, startTime: Date.now(), progress: { completed: 0, total: 1, percentage: 0 } }),
    envelope('batch_member_status_update', { executionIds: [MEMBER_ID], status: 'running', batchId: BATCH_ID, memberIndices: { [MEMBER_ID]: 0 }, memberEndpointInfo: { [MEMBER_ID]: { endpointPath: '/inventory', requestHeaders: {}, requestQueryParams: { page: '0', size: '500' } } } }),
    envelope('batch_member_result_update', { result: pageResponse(), classification: 'success', memberIndex: 0, batchId: BATCH_ID, totalMembers: 1 }),
    envelope('progress_update', { completed: 1, total: 1, percentage: 100, batchId: BATCH_ID }),
    envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 1, startTime: Date.now() - 1400, progress: { completed: 1, total: 1, percentage: 100 } })
];


async function openRun(page) {
    const file = join(ROOT, '.dev-local/console-harness-actions.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Preparing', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    for (const message of messages) { await page.evaluate(m => window.postMessage(m, '*'), message); await page.waitForTimeout(20); }
    await expect(page.locator('#run-heading .tab-item[data-tab="success"]')).toHaveClass(/active/);
}

test('the footer\'s Actions: Copy and Export choices in one menu, the toolbar\'s buttons out of sight; an item does what its control did', async ({ page }) => {
    await openRun(page);
    await expect(page.locator('.toolbar-actions')).toBeHidden();
    await expect(page.locator('#console-actions-btn')).toBeVisible();
    await page.locator('#console-actions-btn').click();
    const labels = await page.locator('.dbmn-context-menu-item').allTextContents();
    expect(labels.map(l => l.trim())).toEqual(expect.arrayContaining(['Copy', 'Copy for Excel', 'Copy as CSV', 'Export CSV', 'Export Excel']));
    // Export CSV: the page's own export, as the old option did (its message to the host)
    await page.locator('.dbmn-context-menu-item', { hasText: 'Export CSV' }).first().click();
    await expect.poll(() => page.evaluate(() => window.__posted.filter(m => /export/i.test(m.type || '')).length)).toBeGreaterThan(0);
});

test('the footer\'s Actions is only where the rows are: not on the Requests tab', async ({ page }) => {
    await openRun(page);
    await page.locator('#run-heading .tab-item[data-tab="requests"]').click();
    await expect(page.locator('#console-actions-btn')).toBeHidden();
    await page.locator('#run-heading .tab-item[data-tab="success"]').click();
    await expect(page.locator('#console-actions-btn')).toBeVisible();
});
