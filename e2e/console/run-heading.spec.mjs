/**
 * The REAL Console page's run heading (#464, #465): one line with the environment, the run's name and ⓘ, the tabs with
 * their counts (no Settings tab), ⓘ opening the run's details from console.details, the footer box listing the run's
 * figures from console.figures, and a rename asked of the host.
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

const DETAILS = {
    name: 'Inventory-Errors 20 Nov 20:14', renamable: true, environment: { name: 'DBMN Local', id: 'env-1', production: false },
    headers: [{ name: 'org', value: 'WOOF' }], endpoint: { name: 'Inventory', id: 'ep-1', method: 'POST' }, url: 'http://127.0.0.1/inventory',
    errorHandling: 'continue', errorHandlingEditable: false, threads: { current: 4, max: 8, editable: false },
    executionId: BATCH_ID, kind: 'batch', started: '2026-11-20T09:14:02Z', durationMs: 1400, lineage: null, variables: []
};
const FIGURES = { state: 'completed', withErrors: false, requests: { total: 1, done: 1 }, rows: { sent: 3, total: 3 }, completed: 1, errors: 0,
    reprocessed: 0, started: '2026-11-20T09:14:02Z', tookMs: 1400, elapsedMs: null, etaMs: null, threads: { current: 4, max: 8 }, errorHandling: 'continue' };

async function open(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-run-heading.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Preparing' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    for (const message of messages) { await page.evaluate(m => window.postMessage(m, '*'), message); await page.waitForTimeout(20); }
    return errors;
}

test('the run heading: one line, the tabs with their counts, no Settings tab', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('#run-heading')).toBeVisible();
    await expect(page.locator('#report-title')).toBeHidden();
    await expect(page.locator('#run-heading .tab-item[data-tab="success"] .tab-count')).toHaveText('1');
    await expect(page.locator('#run-heading .tab-item[data-tab="info"]')).toHaveCount(0);
    await expect(page.locator('#run-heading .tab-item[data-tab="success"]')).toHaveClass(/active/);
    await page.locator('#run-heading .tab-item[data-tab="raw"]').click();
    await expect(page.locator('#run-heading .tab-item[data-tab="raw"]')).toHaveClass(/active/);
    expect(errors).toEqual([]);
});

test('console.details names the run and its environment; ⓘ opens them; the environment link asks the host', async ({ page }) => {
    await open(page);
    await page.evaluate(d => window.postMessage({ type: 'console.details', details: d }, '*'), DETAILS);
    await expect(page.locator('#run-heading .dbmn-run-env')).toHaveText('DBMN Local');
    await expect(page.locator('#run-heading dbmn-name')).toContainText('Inventory-Errors 20 Nov 20:14');
    await page.locator('#run-heading .dbmn-run-info').click();
    await expect(page.locator('dbmn-run-details')).toContainText('POST Inventory');
    await expect(page.locator('dbmn-run-details')).toContainText('org');
    await expect(page.locator('dbmn-run-details')).not.toContainText('Organization');
    await page.keyboard.press('Escape');
    await expect(page.locator('dbmn-run-details')).toHaveCount(0);
    await page.locator('#run-heading .dbmn-run-env').click();
    expect(await page.evaluate(() => window.__posted.filter(m => m.type === 'console.openEnvironment'))).toEqual([{ type: 'console.openEnvironment', payload: { environmentId: 'env-1' } }]);
});

test('a rename on the heading asks the host, and the name it keeps is shown', async ({ page }) => {
    await open(page);
    await page.evaluate(d => window.postMessage({ type: 'console.details', details: d }, '*'), DETAILS);
    await page.locator('#run-heading dbmn-name').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Stock take');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__posted.filter(m => m.type === 'console.rename'))).toEqual([{ type: 'console.rename', name: 'Stock take' }]);
    await page.evaluate(() => window.postMessage({ type: 'console.named', name: 'Stock take' }, '*'));
    await expect(page.locator('#run-heading dbmn-name')).toContainText('Stock take');
    await expect(page.locator('#report-title-name')).toHaveText('Stock take');
});

test('console.figures: the footer box lists the finished run\'s figures', async ({ page }) => {
    await open(page);
    await page.evaluate(f => window.postMessage({ type: 'console.figures', figures: f }, '*'), FIGURES);
    const labels = await page.evaluate(() => (document.getElementById('progress-display').stats || []).map(s => `${s.label}: ${s.value}`));
    expect(labels).toEqual(expect.arrayContaining(['Requests: 1', 'Rows: 3 of 3', 'Completed: 1', 'Errors: 0', 'Took: 1 s']));
});
