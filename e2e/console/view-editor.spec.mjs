/**
 * The View editor on the REAL Console page: each column shows a sample value, columns that are
 * empty in the sample are left out until asked for, and a View that Reporting reads (a saved
 * query or compare) is locked: it can gain columns, and nothing it has can be taken away.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_view_editor';
const ROWS = [
    { sku: 'DOG-002', name: 'Rope Tug', notes: '', discontinued: null, location: { zone: 'A', bin: 'A-01' }, quantity: 40 },
    { sku: 'DOG-001', name: 'Chew Ring', notes: '', discontinued: null, location: { zone: 'B', bin: 'B-12' }, quantity: 7 }
];
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' }, data: ROWS
});

async function open(page) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-view-editor.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager && !!window.ColumnHead);
    const messages = [
        envelope('console.table_data_response', { rawData: {
            responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
            metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
        } }, { success: true }),
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
    await expect(page.locator('#table-head th').first()).toBeVisible();
    return pageErrors;
}
const viewName = page => page.evaluate(() => window.dynamicReportManager.getActiveView('success').name);
const edit = async page => page.evaluate(() => window.dynamicReportManager.openViewEditor(window.dynamicReportManager.getActiveView('success').name));

test('the editor shows a sample value by each column and leaves out the empty ones until asked', async ({ page }) => {
    const pageErrors = await open(page);
    await edit(page);
    const tree = page.locator('#view-editor-tree');
    const leaf = id => tree.locator(`input[data-node-id$="${id}"]`);

    // A value from the data beside the name; no "(current)" or "(ancestor)"
    await expect(tree.locator('.view-editor-pick', { has: page.locator('input[data-node-id$=".sku"]') }).locator('.view-editor-sample')).toHaveText('DOG-002');
    await expect(tree.locator('.view-editor-pick', { has: page.locator('input[data-node-id$=".quantity"]') }).locator('.view-editor-sample')).toHaveText('40');
    await expect(tree).not.toContainText('(current)');
    await expect(tree).not.toContainText('(ancestor)');
    await expect(page.locator('#view-editor-selected .view-editor-sample').first()).toBeVisible();
    await expect(page.locator('#view-editor-selected')).not.toContainText('ancestor');

    // Take the two blank columns out of the View: empty in the sample, they leave the list
    for (const id of ['.notes', '.discontinued']) {
        if (await leaf(id).count()) await leaf(id).click();   // it leaves the list as it is unticked
    }
    await expect(leaf('.notes')).toHaveCount(0);
    await expect(leaf('.discontinued')).toHaveCount(0);
    await expect(tree.locator('.view-editor-empty-note')).toContainText('2 empty columns hidden');
    await tree.locator('#view-editor-empty-toggle').click();
    await expect(leaf('.notes')).toHaveCount(1);
    await expect(tree.locator('.view-editor-empty-note')).toContainText('2 empty columns shown');
    // Search leaves them out too, until shown
    await tree.locator('#view-editor-empty-toggle').click();
    await page.locator('#view-editor-tree-search').fill('notes');
    await expect(tree).toContainText('No columns match.');

    // Not locked: everything is open
    await expect(page.locator('#view-editor-lock')).toBeHidden();
    await expect(page.locator('#view-editor-remove-all')).toBeEnabled();
    await expect(page.locator('#view-editor-delete')).toBeEnabled();
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('a View Reporting reads is locked: it gains columns, and keeps its name, row basis and the columns it has', async ({ page }) => {
    const pageErrors = await open(page);
    const name = await viewName(page);
    // Take one column out first, so there is one to add once locked
    await edit(page);
    await page.locator('#view-editor-tree input[data-node-id$=".quantity"]').uncheck();
    await page.locator('#view-editor-save').click();
    await expect(page.locator('#table-head .col-hide-btn').first()).toBeAttached();
    const had = await page.locator('#table-head th').count();

    // A saved compare reads it now (as the host tells the page)
    await page.evaluate(n => window.postMessage({ type: 'console.compareViews', payload: { views: { [n]: 1 }, queries: {} } }, '*'), name);
    // The headings can no longer take a column out
    await expect(page.locator('#table-head .col-hide-btn')).toHaveCount(0);
    await page.locator('#table-head th').first().locator('.column-name').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu')).toBeVisible();
    await expect(page.locator('.dbmn-context-menu')).not.toContainText('Remove from the View');
    await page.keyboard.press('Escape');

    await edit(page);
    await expect(page.locator('#view-editor-lock')).toBeVisible();
    await expect(page.locator('#view-editor-lock')).toContainText('Used in a compare');
    await expect(page.locator('#view-editor-lock svg')).toBeVisible();
    await expect(page.locator('#view-editor-name')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('#view-editor-row-basis')).toBeDisabled();
    await expect(page.locator('#view-editor-remove-all')).toBeDisabled();
    await expect(page.locator('#view-editor-delete')).toBeDisabled();
    // Every column it has: a lock where its x was, and its tick cannot be taken off
    const selected = page.locator('#view-editor-selected');
    await expect(selected.locator('button[data-remove]')).toHaveCount(0);
    await expect(selected.locator('.view-editor-kept').first()).toBeVisible();
    await expect(page.locator('#view-editor-tree input[data-node-id]:checked:not(:disabled)')).toHaveCount(0);

    // A column can be added (and that one taken off again before saving)
    await page.locator('#view-editor-tree input[data-node-id$=".quantity"]').check();
    await expect(selected.locator('button[data-remove]')).toHaveCount(1);
    await page.locator('#view-editor-save').click();
    await expect(page.locator('#table-head th')).toHaveCount(had + 1);
    expect(await viewName(page)).toBe(name);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
