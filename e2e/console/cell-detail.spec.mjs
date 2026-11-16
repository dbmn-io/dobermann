/**
 * The Console's long-value cell (Issue #271) on the REAL Console page: a structured value (a JSON
 * string here) is click-to-expand, and opens the cell value window, formatted. The window lives
 * in shared/cell-detail.js, which Compare uses too.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_cell';

const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: [{ sku: 'DOG-001', payload: '{"label":"Chew Toy","sizes":[1,2]}' }]
});

const tableData = () => envelope('console.table_data_response', {
    rawData: {
        responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
        metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
    }
}, { success: true });

const statusUpdate = () => envelope('status_update', {
    status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.05, startTime: Date.now() - 50,
    responseData: responseFile(), progress: { completed: 1, total: 1, percentage: 100 },
    responseFile: '/tmp/transaction-response.json', requestFile: '/tmp/transaction-request.json'
});

test('a JSON value in a cell opens in full, formatted, in the cell value window', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-cell-detail.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager && !!window.CellDetail);

    for (const message of [tableData(), statusUpdate(), { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }]) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);
    }

    const cell = page.locator('#data-table tbody td.cell-expandable', { hasText: 'Chew Toy' });
    await expect(cell).toHaveCount(1);
    await cell.click();
    const modal = page.locator('.dbmn-modal');
    await expect(modal.locator('.dbmn-modal-title')).toHaveText('Cell value');
    await expect(modal.locator('.cell-detail-pre')).toContainText('"label": "Chew Toy"');
    await expect(modal.locator('.cell-detail-select')).toHaveValue('deep');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
