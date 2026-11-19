/**
 * A plain (non-paginated) Run API on the REAL Console page: the Completed tab must show the
 * response as soon as the run completes, whatever order the host's messages arrive in.
 *
 * Written with first-result-tab.spec.mjs (2026-09-23). That bug was the paginated path — a
 * batch of one — and this path was never affected; these four orderings pin it that way,
 * since a local API answers fast enough for the initial load, the status updates and the
 * saved settings to overlap.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_1';


/** The response file the engine writes for one GET, as the host reads it back. */
const responseFile = () => ({
    executionId: EXEC_ID, duration: 108, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: [{ sku: 'DOG-001', location: 'WH1', quantity: 12 }, { sku: 'DOG-002', location: 'WH1', quantity: 3 }]
});

/** console.table_data_response as loadInitialData sends it — before or after the file exists. */
const tableData = (done) => envelope('console.table_data_response', {
    rawData: {
        responses: done ? [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }] : [],
        metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
    }
}, { success: true });

const statusUpdate = (status) => envelope('status_update', {
    status, statusDisplay: status === 'completed' ? '✅ Completed' : '🔄 Running',
    durationSeconds: 0.1, startTime: Date.now() - 100,
    responseData: status === 'completed' ? responseFile() : undefined,
    progress: { completed: status === 'completed' ? 1 : 0, total: 1, percentage: status === 'completed' ? 100 : 50 },
    responseFile: status === 'completed' ? '/tmp/transaction-response.json' : undefined, requestFile: '/tmp/transaction-request.json'
});

const settingsLoaded = () => ({ type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null });

const ORDERS = {
    'file read before the run finished, then running, then completed':
        [tableData(false), statusUpdate('running'), statusUpdate('completed'), settingsLoaded()],
    'settings first, then the run':
        [settingsLoaded(), tableData(false), statusUpdate('running'), statusUpdate('completed')],
    'the run finished before the initial load came back':
        [statusUpdate('running'), statusUpdate('completed'), tableData(true), settingsLoaded()],
    'completed landed between the initial load and the settings':
        [tableData(false), statusUpdate('running'), settingsLoaded(), statusUpdate('completed')]
};

for (const [name, messages] of Object.entries(ORDERS)) {
    test(`Completed tab shows the rows straight away — ${name}`, async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(e.message));
        const file = join(ROOT, '.dev-local/console-harness-individual.html');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '🔄 Running' }));
        await page.goto(pathToFileURL(file).href);
        await page.waitForFunction(() => !!window.dynamicReportManager);

        for (const message of messages) {
            await page.evaluate(m => window.postMessage(m, '*'), message);
            await page.waitForTimeout(20);
        }

        await expect(page.locator('#status-badge')).toHaveText('COMPLETED');
        await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('1');
        await expect(page.locator('.tab-item[data-tab="success"]')).toHaveClass(/active/);
        // The page's own stylesheet is not loaded here, so "hidden" is the class, not the box.
        await expect(page.locator('#empty-state'), 'the empty state is not showing').toHaveClass(/hidden/);
        await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(2);
        expect(pageErrors, 'uncaught errors in the page').toEqual([]);
    });
}
