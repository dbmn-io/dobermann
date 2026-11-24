/**
 * Issues #306 and #296 on the REAL Console page, since B22 (Raw retired) in the full-transaction window
 * (<dbmn-transaction>, the Requests tab's): a single run's opens by itself with Request off when there is no body, and
 * an Input, Completed or Error row opens it on right-click ("View full transaction"), its input rows and Reprocess.
 * (Was raw-transaction-view.spec.mjs; its "Status and Show in the Raw bar" case went with the Raw tab.)
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope, requestsArrived } from './console-page.mjs';

/** A response as the host hands it to the page (sourceFile is what Raw maps IDs by). */
const response = (n, status, data) => ({
    httpStatus: status === 'completed' ? 200 : 422, status, data,
    headers: { 'content-type': 'application/json' },
    metadata: { executionId: `exec_${n}`, sourceFile: `transaction-00${n}-response.json`, status, memberIndex: n, timestamp: '2026-09-26T10:00:00Z', responseTime: 40 + n }
});

/** The Raw summaries: the real execution IDs, and which input rows built each request. */
const summaries = (count) => envelope('console.raw_tab_data_response', {
    transactions: Array.from({ length: count }, (_, i) => ({
        executionId: `exec_${i + 1}`, status: 'completed',
        responseFile: `/runs/transaction-00${i + 1}-response.json`, requestFile: `/runs/transaction-00${i + 1}-request.json`,
        rowStart: i + 1, rows: 1, reprocessCount: 0
    }))
});

const content = (items) => envelope('console.raw_transaction_content_response', { contents: items });

async function openConsole(page, { reportType, batchId = '', executionId = '', endpoint }) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, `.dev-local/console-harness-raw-${reportType}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType, batchId, executionId }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(text => { document.getElementById('info-endpoint').textContent = text; }, endpoint);
    return pageErrors;
}

const send = (page, message) => page.evaluate(m => window.postMessage(m, '*'), message);
const posted = (page, type) => page.evaluate(t => window.__posted.filter(m => m.type === t), type);

test('one GET transaction: its window opens by itself, Request off with no body, the response shown', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'individual', executionId: 'exec_1', endpoint: 'GET https://api.test/items' });
    await page.evaluate(r => window.dynamicReportManager.initialize({
        responses: [r], requests: [], logContent: [], metadata: { executionId: 'exec_1' }
    }), response(1, 'completed', { items: [{ sku: 'A' }] }));
    await requestsArrived(page);

    const tx = page.locator('dbmn-transaction[window]');
    await expect(tx).toHaveCount(1);
    await expect(tx.locator('.dbmn-tx-title')).toHaveText('Transaction #001');
    const show = name => tx.locator('.dbmn-tx-seg-btn', { hasText: name });
    await expect(show('Request'), 'no body: Request starts off').not.toHaveClass(/is-on/);
    await expect(show('Response')).toHaveClass(/is-on/);
    await expect(tx.locator('.dbmn-tx-pane[data-part="request"]')).toHaveCount(0);
    await expect(tx.locator('.dbmn-tx-pane[data-part="response"]')).toContainText('"sku"', { timeout: 15_000 });
    await show('Request').click();
    await expect(tx.locator('.dbmn-tx-pane[data-part="request"]')).toHaveCount(1);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('Input tab: rows searched by their transaction\'s Result in the box (no drop-down), and right-click to the transaction', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'batch', batchId: 'batch-1', endpoint: 'POST https://api.test/inventory' });
    // Three transactions of two rows each; the last two rows were never sent.
    await page.evaluate(rs => window.dynamicReportManager.initialize({
        responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-1' },
        inputData: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(sku => ({ sku, uom: sku === 'C' ? 'XX' : 'EA' }))
    }), [response(1, 'completed', { ok: 1 }), response(2, 'error', { message: 'uom_check' }), response(3, 'running', null)]);

    await page.locator('.tab-item[data-tab="input"]').click();
    // The Result drop-down beside the box is gone (James, 2026-11-24: "kind of legacy"): the box searches @Result
    await expect(page.locator('#input-status-filter, #input-status-filter-wrap')).toHaveCount(0);
    const box = page.locator('#search-input');

    await expect.poll(() => posted(page, 'console.get_raw_tab_data').then(p => p.length)).toBe(1);
    await send(page, envelope('console.raw_tab_data_response', {
        transactions: [1, 2, 3].map(n => ({
            executionId: `exec_${n}`, status: 'completed', rowStart: (n - 1) * 2 + 1, rows: 2,
            responseFile: `/runs/transaction-00${n}-response.json`, requestFile: `/runs/transaction-00${n}-request.json`
        }))
    }));

    await expect(page.locator('#console-table thead th').first()).toHaveText('Result');
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(8);

    await box.fill('@Result=Error');
    const rows = page.locator('#console-table .dbmn-table-body > tr.data-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('Error');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('C');

    // The search goes with the export, and no status filter of its own
    await page.evaluate(() => window.dynamicReportManager.exportCurrentTab('excel'));
    const exports = await posted(page, 'console.export_data');
    expect(exports.at(-1).payload.searchTerm).toBe('@Result=Error');
    expect(exports.at(-1).payload.inputStatusFilter).toBeUndefined();

    // Right-click an Input row → its full transaction, with its input rows (rows 3 and 4: C and D)
    await rows.nth(0).locator('td').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View full transaction', 'Reprocess']);
    await page.locator('.raw-context-menu-item[data-action="view"]').click();
    const tx = page.locator('dbmn-transaction[window]');
    await expect(tx.locator('.dbmn-tx-title')).toHaveText('Transaction #002');
    // (a sent request opens on Request and Response; its input rows are a click away)
    await tx.locator('.dbmn-tx-seg-btn', { hasText: 'Input' }).click();
    await expect(tx.locator('.dbmn-tx-input')).toContainText('XX', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(tx).toHaveCount(0);

    await box.fill('@Result="Not processed"');
    await expect(rows).toHaveCount(2);

    // The Input tab has the star in its box, as every tab: a search saved there is kept with the endpoint's Views
    await page.evaluate(() => { window.consoleSettings.currentEndpointId = 'endpoint-1'; });
    const star = page.locator('#console-saved');
    await expect(star).toBeVisible();
    await star.locator('.dbmn-saved-btn').click();
    await star.locator('.dbmn-saved-add').click();
    await star.locator('.dbmn-saved-name-input').fill('Never sent');
    await star.locator('.dbmn-saved-name-input').press('Enter');
    await expect(star.locator('.dbmn-saved-btn')).toHaveClass(/is-saved/);
    await expect.poll(async () => {
        const saves = await posted(page, 'console.save_settings');
        const last = saves.at(-1);
        return last && last.payload && last.payload.settings && last.payload.settings.input;
    }).toEqual({ activeView: '', views: [], searches: [{ name: 'Never sent', text: '@Result="Not processed"' }] });
    await page.keyboard.press('Escape');
    await rows.nth(0).locator('td').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu'), 'a row never sent has no transaction').toHaveCount(0);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('right-click an Error row: its full transaction, with its input row, reason and Reprocess with its real ID', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'batch', batchId: 'batch-1', endpoint: 'POST https://api.test/inventory' });
    await page.evaluate(rs => window.dynamicReportManager.initialize({
        responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-1' },
        inputData: [{ sku: 'A', uom: 'EA' }, { sku: 'B', uom: 'EA' }, { sku: 'C', uom: 'XX' }]
    }), [response(1, 'completed', { ok: 1 }), response(2, 'completed', { ok: 1 }), response(3, 'error', { message: 'violates check constraint "uom_check"' })]);
    // (the run's record: each request's real ID and input rows, as the host sends it)
    await send(page, summaries(3));

    // Completed rows offer View full transaction only
    await page.locator('.tab-item[data-tab="success"]').click();
    await page.locator('#console-table .dbmn-table-body > tr.data-row').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View full transaction']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.raw-context-menu')).toHaveCount(0);

    // Error rows offer View full transaction and Reprocess
    await page.locator('.tab-item[data-tab="errors"]').click();
    // (in view first: a scroll closes the menu, and the page's scroll to the row would land just after it opens)
    const errorRow = page.locator('#console-table .dbmn-table-body > tr.data-row').first();
    await errorRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await errorRow.click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View full transaction', 'Reprocess']);
    await page.locator('.raw-context-menu-item[data-action="view"]').click();

    const tx = page.locator('dbmn-transaction[window]');
    await expect(tx.locator('.dbmn-tx-title')).toHaveText('Transaction #003');
    await expect(tx.locator('.dbmn-tx-head .raw-status-badge')).toHaveText('ERROR');
    // (why it failed, as the Error tab says it: the fixture has no error message of its own, so its HTTP status)
    await expect(tx.locator('.raw-card-reason-text')).toContainText('HTTP 422');
    // its input row (the design system's table), shown though no other tab was opened: a click away
    await tx.locator('.dbmn-tx-seg-btn', { hasText: 'Input' }).click();
    await expect(tx.locator('.dbmn-tx-input')).toContainText('XX', { timeout: 15_000 });
    // Show: each part turns off and on again
    for (const part of ['Request', 'Response', 'Input']) {
        const b = tx.locator('.dbmn-tx-seg-btn', { hasText: part });
        const on = async () => /\bis-on\b/.test(await b.getAttribute('class'));
        const was = await on();
        await b.click();
        await expect.poll(on).toBe(!was);
        await b.click();
        await expect.poll(on).toBe(was);
    }
    await tx.locator('.dbmn-tx-reprocess').click();
    const retries = await posted(page, 'retryMember');
    expect(retries.map(m => m.payload)).toEqual([{ executionId: 'exec_3', batchId: 'batch-1' }]);

    // The result comes back through the live update: the open window follows it (as Raw's card did)
    const done = response(3, 'completed', { ok: 1 });
    await send(page, { type: 'batch_member_result_update', payload: { result: done, classification: 'success', batchId: 'batch-1', totalMembers: 3 } });
    await expect(tx.locator('.dbmn-tx-head .raw-status-badge')).toHaveText('COMPLETED', { timeout: 10_000 });

    // ⤢ fills the window with a pane; the first Esc puts it back, the second closes the window
    const pane = () => tx.locator('.dbmn-tx-pane[data-part="response"]');
    await pane().locator('.dbmn-tx-max').click();
    await expect(pane()).toHaveClass(/is-max/);
    await page.keyboard.press('Escape');
    await expect(pane()).not.toHaveClass(/is-max/);
    await expect(tx, 'the first Esc only puts the pane back').toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(tx).toHaveCount(0);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
