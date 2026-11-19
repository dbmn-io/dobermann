/**
 * Issues #306 and #296 on the REAL Console page: one transaction in Raw is shown clean (no
 * list, no Transaction #001 card), a `{}` request body is no body, Status and Show sit in the
 * Raw bar, and a Completed/Error row opens the same transaction card in a modal on right-click.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

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

test('one GET transaction: clean view, Request off, and {} is no body', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'individual', executionId: 'exec_1', endpoint: 'GET https://api.test/items' });
    await page.evaluate(r => window.dynamicReportManager.initialize({
        responses: [r], requests: [], logContent: [], metadata: { executionId: 'exec_1' }
    }), response(1, 'completed', { items: [{ sku: 'A' }] }));

    await page.locator('.tab-item[data-tab="raw"]').click();

    const card = page.locator('.raw-tab-container .raw-card');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(/raw-card-solo/);
    await expect(page.locator('.raw-card-title'), 'no Transaction #001 title').toHaveCount(0);
    await expect(page.locator('.raw-filter-bar'), 'no list bar for one transaction').toHaveCount(0);

    const chip = name => card.locator(`.raw-show-chip[data-show="${name}"]`);
    await expect(chip('showData'), 'no input rows to show').toBeDisabled();
    await expect(chip('showRequest')).toHaveAttribute('aria-pressed', 'false');
    await expect(chip('showResponse')).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('.raw-panes-container')).toHaveClass(/request-hidden/);

    // The request file holds `{}` — the host sends it back as no body.
    await send(page, summaries(1));
    await expect.poll(() => posted(page, 'console.get_raw_transaction_content').then(p => p.length)).toBeGreaterThan(0);
    await send(page, content([{ executionId: 'exec_1', requestContent: '', responseContent: null }]));

    await chip('showRequest').click();
    await expect(chip('showRequest')).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('.raw-panes-container')).not.toHaveClass(/request-hidden/);
    await expect(card.locator('.raw-request-pane .raw-view-mode-group'), 'no Body option').toHaveCount(0);
    await expect(card.locator('#monaco-request-0')).toHaveAttribute('data-request-mode', 'details');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('a batch: Status and Show sit in the Raw bar, no filter modal', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'batch', batchId: 'batch-1', endpoint: 'POST https://api.test/inventory' });
    await page.evaluate(rs => window.dynamicReportManager.initialize({
        responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-1' },
        inputData: [{ sku: 'A', uom: 'EA' }, { sku: 'B', uom: 'EA' }, { sku: 'C', uom: 'XX' }]
    }), [response(1, 'completed', { ok: 1 }), response(2, 'completed', { ok: 1 }), response(3, 'error', { message: 'violates check constraint "uom_check"' })]);

    await page.locator('.tab-item[data-tab="raw"]').click();
    await send(page, summaries(3));

    await expect(page.locator('#raw-filter-btn'), 'the funnel is gone').toHaveCount(0);
    const bar = page.locator('.raw-filter-bar');
    await expect(bar.locator('#raw-status-select option[value="error"]')).toHaveText('Error (1)');
    await expect(bar.locator('.raw-show-chip[data-show="showRequest"]'), 'POST sends a body').toHaveAttribute('aria-pressed', 'true');
    await expect(bar.locator('.raw-show-chip[data-show="showData"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.raw-tab-container .raw-card')).toHaveCount(3);

    await bar.locator('#raw-status-select').selectOption('error');
    await expect(page.locator('.raw-tab-container .raw-card')).toHaveCount(1);
    await expect(page.locator('.raw-card-title')).toHaveText('Transaction #003');

    await bar.locator('.raw-show-chip[data-show="showData"]').click();
    await expect(page.locator('.raw-tab-container .raw-csv-data-wrapper')).not.toHaveClass(/raw-section-hidden/);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('Input tab: filter rows by their transaction\'s status, and right-click to the transaction', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'batch', batchId: 'batch-1', endpoint: 'POST https://api.test/inventory' });
    // Three transactions of two rows each; the last two rows were never sent.
    await page.evaluate(rs => window.dynamicReportManager.initialize({
        responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-1' },
        inputData: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(sku => ({ sku, uom: sku === 'C' ? 'XX' : 'EA' }))
    }), [response(1, 'completed', { ok: 1 }), response(2, 'error', { message: 'uom_check' }), response(3, 'running', null)]);

    await page.locator('.tab-item[data-tab="input"]').click();
    const filter = page.locator('#input-status-filter');
    await expect(page.locator('#input-status-filter-wrap'), 'hidden until the row ranges load').toHaveClass(/hidden/);

    await expect.poll(() => posted(page, 'console.get_raw_tab_data').then(p => p.length)).toBe(1);
    await send(page, envelope('console.raw_tab_data_response', {
        transactions: [1, 2, 3].map(n => ({
            executionId: `exec_${n}`, status: 'completed', rowStart: (n - 1) * 2 + 1, rows: 2,
            responseFile: `/runs/transaction-00${n}-response.json`, requestFile: `/runs/transaction-00${n}-request.json`
        }))
    }));

    await expect(page.locator('#input-status-filter-wrap')).not.toHaveClass(/hidden/);
    await expect(filter.locator('option')).toHaveText(['All (8)', 'Completed (2)', 'Error (2)', 'Running (2)', 'Cancelled (0)', 'Not processed (2)']);
    await expect(page.locator('#console-table thead th').first()).toHaveText('Result');
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(8);

    await filter.selectOption('error');
    const rows = page.locator('#console-table .dbmn-table-body > tr.data-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('Error');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('C');

    // The filter goes with the export
    await page.evaluate(() => window.dynamicReportManager.exportCurrentTab('excel'));
    const exports = await posted(page, 'console.export_data');
    expect(exports.at(-1).payload.inputStatusFilter).toBe('error');

    // Right-click an Input row → its transaction
    await rows.nth(0).locator('td').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View transaction', 'Reprocess']);
    await page.locator('.raw-context-menu-item[data-action="view"]').click();
    await expect(page.locator('.dbmn-modal-transaction .dbmn-modal-title')).toHaveText('Transaction #002');
    await page.keyboard.press('Escape');

    await filter.selectOption('not_processed');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator('td').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu'), 'a row never sent has no transaction').toHaveCount(0);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('right-click an Error row: view the transaction, reprocess it with its real ID', async ({ page }) => {
    const pageErrors = await openConsole(page, { reportType: 'batch', batchId: 'batch-1', endpoint: 'POST https://api.test/inventory' });
    await page.evaluate(rs => window.dynamicReportManager.initialize({
        responses: rs, requests: [], logContent: [], metadata: { batchId: 'batch-1' },
        inputData: [{ sku: 'A', uom: 'EA' }, { sku: 'B', uom: 'EA' }, { sku: 'C', uom: 'XX' }]
    }), [response(1, 'completed', { ok: 1 }), response(2, 'completed', { ok: 1 }), response(3, 'error', { message: 'violates check constraint "uom_check"' })]);

    // Completed rows offer View only
    await page.locator('.tab-item[data-tab="success"]').click();
    await page.locator('#console-table .dbmn-table-body > tr.data-row').first().click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View transaction']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.raw-context-menu')).toHaveCount(0);

    // Error rows offer View and Reprocess
    await page.locator('.tab-item[data-tab="errors"]').click();
    // (in view first: a scroll closes the menu, and the page's scroll to the row would land just after it opens)
    const errorRow = page.locator('#console-table .dbmn-table-body > tr.data-row').first();
    await errorRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await errorRow.click({ button: 'right' });
    await expect(page.locator('.raw-context-menu-item')).toHaveText(['View transaction', 'Reprocess']);
    await page.locator('.raw-context-menu-item[data-action="view"]').click();

    const modal = page.locator('.dbmn-modal-transaction');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.dbmn-modal-title')).toHaveText('Transaction #003');
    const card = modal.locator('.raw-card-solo');
    await expect(card.locator('.raw-status-badge')).toHaveText('ERROR');

    // The modal asks for the Raw summaries (real IDs + input rows) even though Raw never opened.
    await expect.poll(() => posted(page, 'console.get_raw_tab_data').then(p => p.length)).toBe(1);
    await send(page, summaries(3));
    await send(page, content([{ executionId: 'exec_3', requestContent: '{\n  "sku": "C",\n  "uom": "XX"\n}', responseContent: null }]));
    await expect(card.locator('.raw-csv-data-wrapper'), 'input row shown for a single transaction').not.toHaveClass(/raw-section-hidden/);
    await expect(card.locator('.raw-csv-table td').nth(1)).toHaveText('XX');
    await expect(card.locator('.raw-request-pane .raw-view-mode-btn[data-mode="body"]')).toBeVisible();

    // The modal's Show chips work though the Raw tab was never opened.
    for (const [prop, hiddenClass] of [['showRequest', /request-hidden/], ['showResponse', /response-hidden/]]) {
        const chip = card.locator(`.raw-show-chip[data-show="${prop}"]`);
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'false');
        await expect(card.locator('.raw-panes-container')).toHaveClass(hiddenClass);
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
    const inputChip = card.locator('.raw-show-chip[data-show="showData"]');
    await inputChip.click();
    await expect(inputChip).toHaveAttribute('aria-pressed', 'false');
    await expect(card.locator('.raw-csv-data-wrapper')).toHaveClass(/raw-section-hidden/);
    await card.locator('.raw-solo-search').fill('uom');
    await expect.poll(() => page.evaluate(() => window.rawTabHandler.modal?.searchTerm)).toBe('uom');

    await card.locator('.raw-retry-btn').click();
    const retries = await posted(page, 'retryMember');
    expect(retries.map(m => m.payload)).toEqual([{ executionId: 'exec_3', batchId: 'batch-1' }]);
    await expect(card.locator('.raw-status-badge')).toHaveText('PENDING');

    // The result comes back through the live update — the modal follows it.
    const done = response(3, 'completed', { ok: 1 });
    await send(page, { type: 'batch_member_result_update', payload: { result: done, classification: 'success', batchId: 'batch-1', totalMembers: 3 } });
    await expect(card.locator('.raw-status-badge')).toHaveText('COMPLETED');

    // The modal body is a form: none of the card's buttons may submit (close) it.
    await card.locator('.raw-request-pane .raw-view-mode-btn[data-mode="details"]').click();
    await expect(card.locator('#monaco-request-m')).toHaveAttribute('data-request-mode', 'details');
    await card.locator('.raw-response-pane .raw-pane-copy-btn').click();
    await expect(modal, 'card buttons keep the modal open').toHaveCount(1);

    // Full window works in the modal; Esc leaves it without closing the modal.
    const responsePane = card.locator('.raw-response-pane');
    await responsePane.locator('.raw-pane-fullscreen-btn').click();
    await expect(responsePane).toHaveClass(/raw-pane-fullscreen/);
    await page.keyboard.press('Escape');
    await expect(responsePane).not.toHaveClass(/raw-pane-fullscreen/);
    await expect(modal, 'first Esc only leaves full window').toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
