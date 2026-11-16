/**
 * The REAL Console page: a Run API on a paginated endpoint is a batch of one member. When
 * its first (only) result lands, the page jumps to the Completed tab — and that tab must
 * show the rows, not "No Data Found".
 *
 * Reported 2026-09-23 on the local stack (a fast API): status COMPLETED, Raw 1, Completed 1,
 * but the Completed tab said "No data available for this tab" until the user clicked Raw and
 * then Completed again. The host's messages are replayed here in the order the batch engine
 * sends them; the Console is opened while the member is still pending, as Run API does.
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

test('a batch of one: the Completed tab shows the rows the moment it opens', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-batch-of-one.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Preparing' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);

    for (const message of messages) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);     // a local API answers in well under a second
    }

    await expect(page.locator('#status-badge')).toHaveText('COMPLETED');
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('1');
    await expect(page.locator('.tab-item[data-tab="success"]')).toHaveClass(/active/);
    // The page's stylesheet is not loaded here, so "hidden" is the class, not the box.
    await expect(page.locator('#empty-state'), 'the empty state is not showing').toHaveClass(/hidden/);
    await expect(page.locator('#data-table tbody tr')).toHaveCount(3);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
