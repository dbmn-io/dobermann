/**
 * The Console's search box adds a key the View does not show yet (James, 2026-11-23: "@ also shows
 * keys NOT yet shown and then allows us to add them into their group, at the end, eg, asnline.sku
 * gets added to asnline array"), on the REAL Console page.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_search_adds';
const ROWS = [
    { sku: 'DOG-001', name: 'Chew Ring', bin: 'B-12', lines: [{ item: 'ring', qty: 7, lot: 'L1' }] },
    { sku: 'DOG-002', name: 'Rope Tug', bin: 'A-01', lines: [{ item: 'rope', qty: 40, lot: 'L2' }] },
    { sku: 'DOG-003', name: 'Slow Feeder Bowl', bin: 'A-07', lines: [{ item: 'bowl', qty: 120, lot: 'L3' }] }
];
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' }, data: ROWS
});

async function open(page) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-search-adds.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager && !!window.ColumnHead);
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
        }),
        { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }
    ];
    for (const message of messages) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);
    }
    await expect(page.locator('#console-table thead th').first()).toBeVisible();
    return pageErrors;
}

/** The View's leaves, by their last part, in order (a group's after its own). */
const viewLeaves = page => page.evaluate(() => {
    const out = [];
    const walk = cols => (cols || []).forEach(c => { if (c.children) walk(c.children); else out.push(c.id.split('.').slice(-2).join('.')); });
    walk(window.dynamicReportManager.getActiveView('success').columns);
    return out;
});
const names = page => page.locator('#console-table thead th .column-name').allTextContents();

test('a key taken out of the View comes back by searching for it, at the end of its group, and stays', async ({ page }) => {
    const pageErrors = await open(page);
    expect(await viewLeaves(page)).toContain('data.bin');
    await page.locator('#console-table thead th', { hasText: 'bin' }).locator('.col-hide-btn').click();
    await expect.poll(() => viewLeaves(page)).not.toContain('data.bin');

    const box = page.locator('#search-input');
    // `@` lists it, said to add it
    await box.fill('@bi');
    await expect(page.locator('.column-suggest-option', { hasText: '@bin' })).toContainText('adds it');
    // Finished (its operator typed): it goes back in the View, at the end of its group, and filters
    await box.fill('@bin=A-01');
    await expect.poll(() => viewLeaves(page)).toContain('data.bin');
    // (the end of its own group: the records' columns, data.*)
    expect(await page.evaluate(() => window.dynamicReportManager.getActiveView('success').columns[0].children.map(c => c.id).pop())).toBe('data.bin');
    await expect.poll(() => names(page)).toContain('bin');
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(1);
    // Brought into view: scrolled to, sideways, as far as the table can
    await expect.poll(() => page.locator('#console-table .dbmn-table-scroll').evaluate(b => b.scrollLeft >= b.scrollWidth - b.clientWidth - 1)).toBe(true);
    // Cleared, it stays
    await box.fill('');
    expect(await names(page)).toContain('bin');
    expect(pageErrors).toEqual([]);
});

test('a key taken out of a list of records comes back into that list by searching for it', async ({ page }) => {
    const pageErrors = await open(page);
    const view = () => page.evaluate(() => window.dynamicReportManager.getActiveView('success'));
    // A list of records shows every key of its records: lot is there, a key of the lines column, not one to add
    const box = page.locator('#search-input');
    await box.fill('@lines.l');
    await expect(page.locator('.column-suggest-option', { hasText: '@lines.lot' })).toHaveCount(1);
    await expect(page.locator('.column-suggest-option', { hasText: '@lines.lot' })).not.toContainText('adds it');
    // Taken out of the list (as x on its sub-column does), it is offered, and a search brings it back
    await box.fill('');
    await page.evaluate(() => {
        const m = window.dynamicReportManager;
        m.getActiveView('success').hiddenSubColumns = ['data.lines.lot'];
        m._tableKey = '';
        m.extractAndRender('success');
    });
    await box.fill('@lines.l');
    await expect(page.locator('.column-suggest-option', { hasText: '@lines.lot' })).toContainText('adds it');
    await box.fill('@lines.lot=L2 ');
    await expect.poll(async () => (await view()).hiddenSubColumns || []).toEqual([]);
    expect(pageErrors).toEqual([]);
});
