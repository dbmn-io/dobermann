/**
 * The REAL Console page's Raw tab on a large running batch (Issue #312).
 *
 * Reported 2026-10-03 with 14,000 transactions: "clicking in the RAW tab freezes the
 * console". Every card looked its transaction up with a linear scan, and every live
 * result walked every card. Now: a running batch opens Raw on Running only, and a
 * result touches its own card.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH_ID = '2026-10-03T07-13-04_20f';

const response = (n, status) => ({
    httpStatus: status === 'completed' ? 200 : '-', status, data: status === 'completed' ? { page: n } : null,
    metadata: { executionId: `exec_${n}`, sourceFile: status === 'completed' ? `transaction-${n}-response.json` : undefined, status, memberIndex: n, timestamp: '2026-10-03T07:00:00Z' }
});

/** A running batch: the first `done` completed, the next `running` running, the rest pending. */
const responses = (done, running, total) => Array.from({ length: total }, (_, i) =>
    response(i + 1, i < done ? 'completed' : i < done + running ? 'running' : 'pending'));

async function openRunning(page, done, running, total) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-raw-large.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.table_data_response', {
        rawData: { responses: responses(done, running, total), metadata: { executionId: BATCH_ID, batchId: BATCH_ID, totalRows: total, rows: String(total) }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} }
    }));
    await page.evaluate(m => window.postMessage(m, '*'), envelope('status_update', { status: 'running', statusDisplay: '🔄 Running', progress: { completed: done, total, percentage: Math.round(done / total * 100) } }));
    await expect(page.locator('.tab-count[data-tab="raw"]')).toHaveText(String(total));
    return pageErrors;
}

const send = (page, m) => page.evaluate(m => window.postMessage(m, '*'), m);

test('a running batch opens Raw on Running only, and steps back to All when it finishes', async ({ page }) => {
    const pageErrors = await openRunning(page, 400, 8, 420);
    await page.locator('.tab-item[data-tab="raw"]').click();

    await expect(page.locator('#raw-status-select')).toHaveValue('running');
    await expect(page.locator('.raw-tab-container .raw-card')).toHaveCount(8);
    await expect(page.locator('.raw-tab-container .raw-status-badge').first()).toHaveText('RUNNING');

    await send(page, envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', progress: { completed: 420, total: 420, percentage: 100 } }));
    await expect(page.locator('#raw-status-select')).toHaveValue('all');
    await expect.poll(() => page.locator('.raw-tab-container .raw-card').count()).toBeGreaterThan(8);
    expect(pageErrors).toEqual([]);
});

test('the user\'s own Status choice outlives the batch', async ({ page }) => {
    await openRunning(page, 10, 2, 12);
    await page.locator('.tab-item[data-tab="raw"]').click();
    await page.locator('#raw-status-select').selectOption('completed');
    await send(page, envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', progress: { completed: 12, total: 12, percentage: 100 } }));
    await page.waitForTimeout(200);
    await expect(page.locator('#raw-status-select')).toHaveValue('completed');
});

test('on All, only a window of cards is rendered, and a live result touches its own card', async ({ page }) => {
    const pageErrors = await openRunning(page, 2, 4, 304);
    await page.locator('.tab-item[data-tab="raw"]').click();
    await page.locator('#raw-status-select').selectOption('all');
    // A window of 50 and a "Scroll for more" marker — not 304 cards
    await expect.poll(() => page.locator('.raw-tab-container .raw-card').count()).toBeGreaterThanOrEqual(50);
    expect(await page.locator('.raw-tab-container .raw-card').count(), 'a window, not the whole list').toBeLessThan(304);
    await expect(page.locator('.raw-cards-more')).toContainText('more');

    // Count the work a live result causes: titles rebuilt, headers refreshed
    await page.evaluate(() => {
        const h = window.rawTabHandler; window.__titles = 0; window.__headers = 0;
        const t = h.transactionTitle.bind(h); h.transactionTitle = tx => { window.__titles++; return t(tx); };
        const r = h.refreshCardHeader.bind(h); h.refreshCardHeader = (...a) => { window.__headers++; return r(...a); };
    });
    // exec_3 (running, in the window) completes
    await send(page, envelope('batch_member_result_update', { result: response(3, 'completed'), classification: 'success', memberIndex: 3, batchId: BATCH_ID, totalMembers: 304 }));
    await expect(page.locator('.raw-card[data-exec-id="exec_3"] .raw-status-badge')).toHaveText('COMPLETED');
    const work = await page.evaluate(() => ({ titles: window.__titles, headers: window.__headers }));
    expect(work.headers, 'one card refreshed, not 50').toBeLessThanOrEqual(2);
    expect(work.titles).toBeLessThanOrEqual(2);
    expect(pageErrors).toEqual([]);
});

test('coming back to Raw on All asks for the rendered cards\' bodies, not all 14,000', async ({ page }) => {
    const pageErrors = await openRunning(page, 2, 4, 1200);
    await page.locator('.tab-item[data-tab="raw"]').click();
    await page.evaluate(() => { const h = window.rawTabHandler; h.state.statusFilter = 'all'; h._statusFilterChosen = true; h.refreshContent(); });
    await expect.poll(() => page.locator('.raw-tab-container .raw-card').count()).toBeGreaterThanOrEqual(50);
    await page.evaluate(() => { window.__posted.length = 0; });

    await page.locator('.tab-item[data-tab="success"]').click();
    await page.locator('.tab-item[data-tab="raw"]').click();
    await page.waitForTimeout(800);

    const requests = await page.evaluate(() => window.__posted.filter(m => m.type === 'console.get_raw_transaction_content').map(m => m.payload.executionIds.length));
    const rendered = await page.locator('.raw-tab-container .raw-card').count();
    for (const n of requests) expect(n, 'never more than the rendered cards').toBeLessThanOrEqual(rendered);
    expect(pageErrors).toEqual([]);
});
