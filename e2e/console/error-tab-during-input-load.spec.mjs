/**
 * The REAL Console page, GitHub Issue #337.
 *
 * Seen 2026-10-06: a 67,000-row batch against an environment whose sign-in had expired. Request 1
 * came back 401 and the batch stopped about 3 s in. The Console switched to the Error tab, but
 * the table showed the Input view: 67,000 rows, the file's own `status` values in the Result
 * column. Completed and back to Error showed the one error.
 *
 * The input rows were still streaming in. Each chunk asks for an Input redraw a moment later
 * (to settle the row statuses); the first result switched to the Error tab in between, and the
 * Input redraw then landed under it. Replayed here in that order.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH_ID = '2026-10-06T09-00-00_401';
const MEMBER_ID = 'exec_401_first';
const STATUSES = ['active', 'low_stock', 'reserved'];
const inputRow = i => ({ sku: `SKU-${i}`, location: 'DC-01', quantity: i, status: STATUSES[i % 3] });
const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

const unauthorised = () => ({
    httpStatus: 401, httpStatusText: 'Unauthorized', duration: 40, headers: { 'content-type': 'application/json' },
    data: { error: 'invalid_token', message: 'The access token expired' },
    metadata: { executionId: MEMBER_ID, sourceFile: 'transaction-001-response.json', status: 'error' },
    status: 'error'
});

test('#337: the first result switches to Error while Input is still loading; Error shows the error, not the input', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-error-during-input.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    const post = m => page.evaluate(message => window.postMessage(message, '*'), m);

    // Opens on Input, the first chunk of the file in, the rest streaming
    await post(envelope('console.table_data_response', {
        rawData: { responses: [], inputData: range(0, 500).map(inputRow), metadata: { executionId: BATCH_ID, batchId: BATCH_ID, totalRows: 2000, rows: '2000' }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} },
        streaming: { loaded: 0, total: 0, inputLoaded: 500, inputTotal: 2000 }
    }));
    await expect(page.locator('.tab-item[data-tab="input"]')).toHaveClass(/active/);

    // A chunk of input lands (an Input redraw is now due), then request 1's 401
    await post(envelope('console.raw_chunk', { inputRows: range(500, 1500).map(inputRow), loaded: 0, total: 0, inputLoaded: 1500, inputTotal: 2000 }));
    await post(envelope('batch_member_result_update', { result: unauthorised(), classification: 'errors', memberIndex: 0, batchId: BATCH_ID, totalMembers: 2000 }));
    await post(envelope('status_update', { status: 'error', statusDisplay: '❌ Error', durationSeconds: 3, startTime: Date.now() - 3000, progress: { completed: 1, total: 2000, percentage: 0 } }));

    await expect(page.locator('.tab-item[data-tab="errors"]')).toHaveClass(/active/);
    await expect(page.locator('.tab-count[data-tab="errors"]')).toHaveText('1');
    // Past the moment the Input redraw was due: the Error tab still shows the one error
    await page.waitForTimeout(800);
    await expect(page.locator('.tab-item[data-tab="errors"]')).toHaveClass(/active/);
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row'), 'one error, not the input file').toHaveCount(1);
    await expect(page.locator('#console-table')).not.toContainText('SKU-');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
