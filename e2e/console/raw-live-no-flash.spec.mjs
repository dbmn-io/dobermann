/**
 * #431 on the REAL Console page: while a batch runs, the Raw tab with a Status filter on
 * (it opens on Running) is updated in place as results come in. The cards already there
 * stay the same elements, so nothing on screen flashes; a result only adds or takes away
 * its own card.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH = 'batch-431';
const OK_BODY = { success: true, data: { created: 1 } };

const tx = (n, status) => ({
    httpStatus: status === 'running' ? '-' : status === 'error' ? 500 : 200,
    status,
    data: status === 'running' ? {} : status === 'error' ? { error: 'refused' } : OK_BODY,
    headers: { 'content-type': 'application/json' },
    metadata: { executionId: `exec_${n}`, sourceFile: `transaction-00${n}-response.json`, status, memberIndex: n, timestamp: '2026-11-06T00:12:20Z', responseTime: 300 }
});

async function openConsole(page, rows) {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-raw-live.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH, executionId: BATCH, styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(r => {
        window.dynamicReportManager.initialize({ responses: r, requests: [], logContent: [] });
        document.getElementById('loading-overlay')?.classList.add('hidden');
    }, rows);
    await page.locator('.tab-item[data-tab="raw"]').click();
    return pageErrors;
}

const send = (page, message) => page.evaluate(m => window.postMessage(m, '*'), message);
const finish = (page, n, status) => send(page, envelope('batch_member_result_update', {
    result: tx(n, status), classification: status === 'completed' ? 'success' : 'errors', memberIndex: n, totalMembers: 6, batchId: BATCH
}));

/** Tag every card on screen; a card rebuilt since loses its tag. */
const tagCards = page => page.evaluate(() => document.querySelectorAll('.raw-cards-container .raw-card').forEach(c => { c.__kept = true; }));
const cards = page => page.evaluate(() => Array.from(document.querySelectorAll('.raw-cards-container .raw-card'))
    .map(c => ({ id: c.dataset.execId, kept: c.__kept === true, expanded: c.classList.contains('expanded') })));
/** The live pass waits for results to stop arriving (500 ms) */
const settle = page => page.waitForTimeout(700);

test('Error filter: a new error adds its own card; the cards already there are not rebuilt', async ({ page }) => {
    const pageErrors = await openConsole(page, [tx(1, 'error'), tx(2, 'running'), tx(3, 'error'), tx(4, 'running'), tx(5, 'completed')]);
    await page.locator('#raw-status-select').selectOption('error');
    await expect(page.locator('.raw-cards-container .raw-card')).toHaveCount(2);
    // Cards open expanded; one the user closed stays closed
    await page.locator('.raw-card[data-exec-id="exec_3"] .raw-card-header').click();
    await expect(page.locator('.raw-card[data-exec-id="exec_3"]')).toHaveClass(/collapsed/);
    await tagCards(page);

    await finish(page, 2, 'error');     // lands between the two on screen
    await finish(page, 4, 'completed'); // not on this filter at all
    await settle(page);

    expect(await cards(page)).toEqual([
        { id: 'exec_1', kept: true, expanded: true },
        { id: 'exec_2', kept: false, expanded: true },
        { id: 'exec_3', kept: true, expanded: false }
    ]);
    await expect(page.locator('#raw-status-select option:checked')).toHaveText('Error (3)');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('Running filter: a finished transaction takes its card away; the others stay as they are', async ({ page }) => {
    const pageErrors = await openConsole(page, [tx(1, 'completed'), tx(2, 'running'), tx(3, 'running'), tx(4, 'running')]);
    await page.locator('#raw-status-select').selectOption('running');
    await expect(page.locator('.raw-cards-container .raw-card')).toHaveCount(3);
    await tagCards(page);

    await finish(page, 3, 'completed');
    await settle(page);

    expect(await cards(page)).toEqual([
        { id: 'exec_2', kept: true, expanded: true },
        { id: 'exec_4', kept: true, expanded: true }
    ]);
    // The cards that stayed still act on their own transaction (back on Raw: the Console
    // goes to the result's tab once, on the first result)
    if (!(await page.locator('.raw-card[data-exec-id="exec_4"]').isVisible())) await page.locator('.tab-item[data-tab="raw"]').click();
    await page.locator('.raw-card[data-exec-id="exec_4"] .raw-card-header').click();
    await expect(page.locator('.raw-card[data-exec-id="exec_4"]')).toHaveClass(/collapsed/);
    await expect(page.locator('.raw-card[data-exec-id="exec_2"]')).toHaveClass(/expanded/);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
