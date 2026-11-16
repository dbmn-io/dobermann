/**
 * The REAL Console page's Settings tab → Configure (Issue #312). Each control posts
 * the Console message the host handles — not the dbmn.updateBatch* commands that no
 * longer exist — and the Processing Mode select is tall enough to read.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH_ID = '2026-10-03T07-13-04_20f';

test('Name, Error Handling and Processing Mode post Console messages; the select is readable', async ({ page }) => {
    const file = join(ROOT, '.dev-local/console-harness-settings.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    // The host's first data message is what initialises the Settings tab (initInfoTab) — as on a real open
    // The host fills {{MAX_CONCURRENCY}} from the environment (8 here); the harness blanks placeholders
    await page.evaluate(() => { maxThreadCount = 8; initInfoTab(true); window.dynamicReportManager.switchTab('info'); });
    // A running batch: the controls are editable
    await page.evaluate(m => window.postMessage(m, '*'), envelope('status_update', { status: 'running', statusDisplay: '🔄 Running', progress: { completed: 1, total: 3, percentage: 33 } }));
    await expect(page.locator('#info-threads')).toBeEnabled();

    const select = page.locator('#info-threads');
    const box = await select.boundingBox();
    const textHeight = await select.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(box.height, 'the select shows its whole text').toBeGreaterThan(textHeight + 12);

    await select.selectOption('8');
    // The radio input sits behind its styled label; a user clicks the label
    await page.locator('label.radio-label:has(input[value="stopOnFirst"])').click({ force: true });
    await page.evaluate(() => {
        const radio = document.querySelector('input[name="infoErrorMode"][value="stopOnFirst"]');
        if (!radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.locator('#info-batch-name').fill('Inventory load');
    await page.locator('#info-batch-name').dispatchEvent('change');

    const posted = await page.evaluate(() => window.__posted.filter(m => /^updateBatch/.test(m.type)));
    expect(posted).toContainEqual({ type: 'updateBatchConcurrency', payload: { batchId: BATCH_ID, concurrency: 8 } });
    expect(posted).toContainEqual({ type: 'updateBatchErrorMode', payload: { batchId: BATCH_ID, stopOnFirstError: true } });
    expect(posted.some(m => m.type === 'updateBatchName' && m.payload.name === 'Inventory load')).toBe(true);
    expect(await page.evaluate(() => window.__posted.some(m => m.type === 'executeCommand'))).toBe(false);
});

test('the footer buttons and the progress row carry Lucide icons, not emoji (Issue #312)', async ({ page }) => {
    const file = join(ROOT, '.dev-local/console-harness-icons.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    for (const id of ['pause-batch-btn', 'resume-batch-btn', 'cancel-preparation-btn', 'rerun-transaction-btn', 'reprocess-batch-btn', 'next-page-btn']) {
        expect(await page.locator(`#${id} svg`).count(), id).toBe(1);
        expect(await page.locator(`#${id}`).textContent()).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25B6}]/u);
    }
    await page.evaluate(m => window.postMessage(m, '*'), envelope('progress_update', { status: 'running', startTime: Date.now() - 65000 }));
    expect(await page.locator('#progress-elapsed svg').count()).toBe(1);
    expect(await page.locator('#progress-elapsed').textContent()).toBe('1m 5s');
    // A button whose label is rewritten at runtime keeps its icon
    await page.evaluate(() => window.updateButtonVisibility('pending'));
    expect(await page.locator('#cancel-preparation-btn svg').count()).toBe(1);
});
