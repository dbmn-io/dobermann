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
    // The progress box shows the clock beside the count until there is an estimate of the time left
    await expect(page.locator('#progress-display')).toHaveAttribute('note', '1m 5s');
    // A button whose label is rewritten at runtime keeps its icon
    await page.evaluate(() => window.updateButtonVisibility('pending'));
    expect(await page.locator('#cancel-preparation-btn svg').count()).toBe(1);
});

test('the progress box: Threads and Stop on next error are changed from its figures, in step with Settings', async ({ page }) => {
    const file = join(ROOT, '.dev-local/console-harness-progress-box.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '🔄 Running', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(() => { maxThreadCount = 8; initInfoTab(true); document.getElementById('loading-overlay')?.classList.add('hidden'); });
    await page.evaluate(m => window.postMessage(m, '*'), envelope('progress_update', { status: 'running', startTime: Date.now() - 5000 }));
    await page.evaluate(m => window.postMessage(m, '*'), envelope('status_update', { status: 'running', statusDisplay: '🔄 Running', progress: { completed: 1, total: 3, percentage: 33 } }));
    const box = page.locator('#progress-display');
    await expect(box).not.toHaveClass(/hidden/);
    await expect(box).toHaveAttribute('phase', 'Executing');
    // The figures open with a click on the box
    await box.click();
    const choices = page.locator('.dbmn-progress-stats .dbmn-progress-choice');
    await expect(choices).toHaveText(['1', '2', '4', '8', '16']);
    await expect(choices.filter({ hasText: /^16$/ }), 'over the environment\'s limit: switched off').toBeDisabled();
    await choices.filter({ hasText: /^4$/ }).click();
    await expect(page.locator('#info-threads')).toHaveValue('4');
    const stop = page.locator('.dbmn-progress-stats .dbmn-progress-switch');
    await expect(stop).toHaveAttribute('aria-checked', 'false');
    await stop.click();
    await expect(page.locator('input[name="infoErrorMode"][value="stopOnFirst"]')).toBeChecked();
    const posted = await page.evaluate(() => window.__posted.filter(m => /^updateBatch/.test(m.type)));
    expect(posted).toContainEqual({ type: 'updateBatchConcurrency', payload: { batchId: BATCH_ID, concurrency: 4 } });
    expect(posted).toContainEqual({ type: 'updateBatchErrorMode', payload: { batchId: BATCH_ID, stopOnFirstError: true } });
    // And the other way: Settings changes the figures
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dynamicReportManager.switchTab('info'));
    await page.locator('#info-threads').selectOption('2');
    await box.click();
    await expect(page.locator('.dbmn-progress-stats .dbmn-progress-choice[aria-pressed="true"]')).toHaveText('2');
    // Done: plain figures, nothing to change
    await page.evaluate(m => window.postMessage(m, '*'), envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', progress: { completed: 3, total: 3, percentage: 100 } }));
    await expect(box).toHaveAttribute('tone', 'ok');
    await page.keyboard.press('Escape');
    await box.click();
    await expect(page.locator('.dbmn-progress-stats .dbmn-progress-choice, .dbmn-progress-stats .dbmn-progress-switch')).toHaveCount(0);
    await expect(page.locator('.dbmn-progress-stats')).toContainText('Stop on first error');
});
