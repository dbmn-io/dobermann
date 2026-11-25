/**
 * The request window over a running batch (James, 2026-11-25, on :5181):
 *  - "as the batch is running, it seems to flash and refresh… a running batch shouldn't interrupt the modal. We
 *    shouldn't be refreshing anything": updates that change nothing don't draw the window again, and the table behind
 *    it isn't reloaded while it is open (it catches up once it closes);
 *  - "I had like transaction 300 and something open and then I think that transaction completed but then it opened up
 *    transaction 10": the window stays on the request it was opened for, by its id, however the run re-orders its rows,
 *    and shows that request's new state in place.
 * The real Console page, the Requests tab's fake host (console-page.mjs) answering by id as the host does.
 *
 *   npx playwright test --config e2e/console/playwright.config.mjs e2e/console/requests-window-live.spec.mjs
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope, requestsArrived } from './console-page.mjs';

const done = n => ({
    httpStatus: 201, status: 'completed', data: { created: n }, headers: { 'content-type': 'application/json' },
    metadata: { executionId: `m-${n}`, status: 'completed', memberIndex: n, timestamp: '2026-11-25T21:00:00Z', responseTime: 40 }
});
const running = n => ({ httpStatus: null, status: 'running', data: null, headers: {},
    metadata: { executionId: `m-${n}`, status: 'running', memberIndex: n, timestamp: '2026-11-25T21:00:00Z', responseTime: null } });

async function batchWithRequestTenOpen(page) {
    const file = join(ROOT, '.dev-local/console-harness-requests-window-live.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: 'batch-live', executionId: 'batch-live', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    // Twelve requests; #010 still running
    // (as the host sends a run's data: initialize() alone left the loading overlay over the page)
    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.table_data_response', {
        rawData: { responses: Array.from({ length: 12 }, (_, i) => (i + 1 === 10 ? running(10) : done(i + 1))), metadata: { executionId: 'batch-live', batchId: 'batch-live' },
            availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} } }));
    await requestsArrived(page);
    await page.locator('#run-heading .tab-item[data-tab="requests"]').click();
    await page.locator('#requests-table .dbmn-table-body > tr:not(.dbmn-table-spacer) td[data-col="n"]', { hasText: /^010$/ }).click();
    const tx = page.locator('dbmn-transaction[window]');
    await expect(tx.locator('.dbmn-tx-title')).toHaveText(/#010$/);
    // Every title the window shows from here on
    await page.evaluate(() => {
        window.__titles = [];
        const tx = document.querySelector('dbmn-transaction[window]');
        new MutationObserver(() => { const t = tx.querySelector('.dbmn-tx-title'); if (t) window.__titles.push(t.textContent); })
            .observe(tx, { childList: true, subtree: true, characterData: true });
    });
    return tx;
}

const pageAsks = page => page.evaluate(() => window.__posted.filter(m => m.type === 'console.requests.page').length);

test('a running batch doesn\'t draw the open window again, or reload the table behind it, when nothing about its request changed', async ({ page }) => {
    const tx = await batchWithRequestTenOpen(page);
    // (the code editor's one draw when it has loaded, if it loads: then the pane is marked)
    await page.evaluate(() => new Promise(done => { const ed = window.ConsoleEditor; if (ed && ed.whenReady) { ed.whenReady(done); setTimeout(done, 5000); } else done(); }));
    await page.waitForTimeout(100);
    await page.evaluate(() => { document.querySelector('dbmn-transaction[window] .dbmn-tx-pane[data-part="request"]').__mark = 'first'; });
    const asked = await pageAsks(page);
    for (let i = 0; i < 3; i++) { await requestsArrived(page); await page.waitForTimeout(1_100); }
    expect(await page.evaluate(() => document.querySelector('dbmn-transaction[window] .dbmn-tx-pane[data-part="request"]').__mark), 'the same pane: not drawn again').toBe('first');
    expect(await pageAsks(page) - asked, 'the table behind the window: not reloaded while it is open').toBe(0);
    expect(await page.evaluate(() => window.__titles.filter(t => !/#010$/.test(t))), 'no other request shown').toEqual([]);
    // Closed: the table catches up, once
    await page.keyboard.press('Escape');
    await expect(tx).toHaveCount(0);
    await expect.poll(async () => await pageAsks(page) - asked, { timeout: 5_000 }).toBeGreaterThan(0);
});

test('the run re-orders its requests and the open one finishes: the window stays on it, by its id, and shows it finished', async ({ page }) => {
    const tx = await batchWithRequestTenOpen(page);
    // The host's order changes (as a re-sort or a filter does: the 10th place is another request now), and #010 ends
    await page.evaluate(r10 => {
        const list = window.dynamicReportManager.rawData.responses;
        list.splice(list.findIndex(x => x.metadata.executionId === 'm-10'), 1);
        list.unshift(r10);
    }, done(10));
    await requestsArrived(page);
    await expect(tx.locator('.raw-status-badge').first()).toHaveText('Completed', { timeout: 5_000 });
    await expect(tx.locator('.dbmn-tx-pane[data-part="response"]')).toContainText('"created"', { timeout: 5_000 });
    await expect(tx.locator('.dbmn-tx-title')).toHaveText(/#010$/);
    expect(await page.evaluate(() => window.__titles.filter(t => !/#010$/.test(t))), 'never another request').toEqual([]);
});
