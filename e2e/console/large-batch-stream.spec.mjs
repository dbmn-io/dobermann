/**
 * The REAL Console page on a large batch (GitHub Issue #312).
 *
 * Reported 2026-10-02: a batch with thousands of transactions "is NOT loading. Its
 * extremely slow" — the host read every response file and posted them as one message,
 * so the page drew nothing until all of it had arrived and been parsed. And on the
 * Completed tab, "every time results are added, it re-sets the scroll position".
 *
 * Here the host's new behaviour is replayed: the first chunk in table_data_response
 * (payload.streaming set), the rest as console.raw_chunk. The page must be usable on
 * the first chunk and count up as the rest land; a redraw must keep the scroll.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH_ID = '2026-10-02T01-00-00_big';

const response = (i, ok = true) => ({
    httpStatus: ok ? 200 : 500, httpStatusText: ok ? 'OK' : 'Error', duration: 20, headers: {},
    data: { page: i, data: [{ sku: `SKU-${i}`, quantity: i }] },
    metadata: { executionId: `exec_${i}`, sourceFile: `transaction-${i}-response.json`, status: ok ? 'completed' : 'error' },
    status: ok ? 'completed' : 'error'
});

const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

async function open(page, firstChunk, streaming, { styles = false } = {}) {
    const file = join(ROOT, `.dev-local/console-harness-large-batch${styles ? '-styled' : ''}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '✅ Completed', styles }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.table_data_response', {
        rawData: { responses: firstChunk, metadata: { executionId: BATCH_ID, batchId: BATCH_ID, totalRows: streaming.total, rows: String(streaming.total) }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} },
        streaming
    }));
}

const tabCount = (page, tab) => page.locator(`.tab-count[data-tab="${tab}"]`).textContent();

test('the page is usable on the first chunk and counts up as the rest stream in', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await open(page, range(1, 101).map(i => response(i)), { loaded: 100, total: 300 });

    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('100');
    // The load shows in the execution progress bar, not a toast — the run's own progress
    // is already on the tab header and in the Activity drawer
    await expect(page.locator('#progress-phase')).toHaveText('Loading transactions');
    await expect(page.locator('#progress-count')).toHaveText('100/300');
    await expect(page.locator('#progress-bar-fill')).toHaveClass(/loading/);
    expect(await page.evaluate(() => document.getElementById('progress-bar-fill').style.width)).toBe('33%');

    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.raw_chunk', { responses: range(101, 201).map(i => response(i, i !== 150)), loaded: 200, total: 300 }));
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('199');
    await expect(page.locator('.tab-count[data-tab="errors"]')).toHaveText('1');
    await expect(page.locator('.tab-item[data-tab="errors"]')).toBeVisible();
    await expect(page.locator('#progress-count')).toHaveText('200/300');
    // An execution repaint while loading does not take the bar back
    await page.evaluate(m => window.postMessage(m, '*'), envelope('status_update', { status: 'completed', statusDisplay: '✅ Completed', progress: { completed: 300, total: 300, percentage: 100 } }));
    await expect(page.locator('#progress-phase')).toHaveText('Loading transactions');

    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.raw_chunk', { responses: range(201, 301).map(i => response(i)), loaded: 300, total: 300 }));
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('299');
    await expect(page.locator('.tab-count[data-tab="raw"]')).toHaveText('300');
    // Last chunk: the bar is handed back to the execution
    await expect(page.locator('#progress-phase')).not.toHaveText('Loading transactions');
    await expect(page.locator('#progress-bar-fill')).not.toHaveClass(/loading/);
    expect(await page.evaluate(() => window.progressHandler.loading)).toBe(false);
    expect(await page.evaluate(() => window.dynamicReportManager.rawData.responses.length)).toBe(300);
    expect(pageErrors).toEqual([]);
});

test('a live redraw of the Completed tab keeps the scroll position', async ({ page }) => {
    // The real stylesheet matters here: #table-container is always a scroll box, so clearing
    // the rows collapses it and the browser snaps scrollTop to 0 before the rows come back.
    await open(page, range(1, 301).map(i => response(i)), { loaded: 300, total: 300 }, { styles: true });
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('300');
    await page.evaluate(() => window.dynamicReportManager.switchTab('success'));
    await page.waitForFunction(() => document.getElementById('table-container').scrollHeight > 1000);

    await page.evaluate(() => { document.getElementById('table-container').scrollTop = 900; });
    const before = await page.evaluate(() => document.getElementById('table-container').scrollTop);
    expect(before).toBeGreaterThan(0);

    // A result lands: the tab redraws after its debounce
    await page.evaluate(m => window.postMessage(m, '*'), envelope('batch_member_result_update', { result: response(301), classification: 'success', memberIndex: 300, batchId: BATCH_ID, totalMembers: 301 }));
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('301');
    // Wait for the debounced redraw itself: the timer is armed by the result, then clears when it has run
    await page.waitForFunction(() => !!window.dynamicReportManager._renderDebounceTimer);
    await page.waitForFunction(() => !window.dynamicReportManager._renderDebounceTimer);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.getElementById('table-container').scrollTop)).toBe(before);
});

test('a batch still running: results that land while the batch streams in merge, with no duplicates', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // At open: 250 members have a response file (250 to stream), exec_251 is still pending — it rides in
    // the first chunk as a stub, as the host does for members without a file.
    const stub = { httpStatus: '-', status: 'pending', data: null, metadata: { executionId: 'exec_251', status: 'pending' } };
    await open(page, [...range(1, 101).map(i => response(i)), stub], { loaded: 100, total: 250 });
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('100');

    // While the stream is still going: exec_251 finishes (replaces its stub), and exec_240 — whose chunk
    // has not arrived yet — is re-reported live by the engine (a reprocess, say)
    await page.evaluate(m => window.postMessage(m, '*'), envelope('batch_member_result_update', { result: response(251), classification: 'success', memberIndex: 250, batchId: BATCH_ID, totalMembers: 251 }));
    await page.evaluate(m => window.postMessage(m, '*'), envelope('batch_member_result_update', { result: response(240, false), classification: 'errors', memberIndex: 239, batchId: BATCH_ID, totalMembers: 251 }));
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('101');
    await expect(page.locator('.tab-count[data-tab="errors"]')).toHaveText('1');
    await expect(page.locator('#progress-phase'), 'the bar still shows the load').toHaveText('Loading transactions');

    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.raw_chunk', { responses: range(101, 201).map(i => response(i)), loaded: 200, total: 250 }));
    // The last chunk carries exec_240 as it is on disk (an error) — it replaces the live row, not doubles it
    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.raw_chunk', { responses: range(201, 251).map(i => response(i, i !== 240)), loaded: 250, total: 250 }));

    await expect(page.locator('.tab-count[data-tab="raw"]')).toHaveText('251');
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('250');
    await expect(page.locator('.tab-count[data-tab="errors"]')).toHaveText('1');
    const ids = await page.evaluate(() => window.dynamicReportManager.rawData.responses.map(r => r.metadata.executionId));
    expect(new Set(ids).size).toBe(251);
    expect(ids).toContain('exec_251');
    // After the hand-back the bar's count is the batch's own tallies
    await expect(page.locator('#progress-count')).toHaveText('251/251');
    expect(pageErrors).toEqual([]);
});

test('the input rows stream too, ahead of the responses, and the Input tab counts up', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const inputRow = i => ({ sku: `SKU-${i}`, quantity: i });
    const file = join(ROOT, '.dev-local/console-harness-large-input.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH_ID, executionId: BATCH_ID, statusDisplay: '✅ Completed' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    // A small batch (3 responses, nothing to stream) with a big input file: 2 rows now, 4 to come
    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.table_data_response', {
        rawData: { responses: range(1, 4).map(i => response(i)), inputData: [inputRow(1), inputRow(2)], metadata: { executionId: BATCH_ID, batchId: BATCH_ID, totalRows: 3, rows: '3(6)' }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {} },
        streaming: { loaded: 3, total: 3, inputLoaded: 2, inputTotal: 6 }
    }));
    await expect(page.locator('.tab-count[data-tab="input"]')).toHaveText('2');
    await expect(page.locator('#progress-phase')).toHaveText('Loading input rows');
    await expect(page.locator('#progress-count')).toHaveText('2/6');

    await page.evaluate(m => window.postMessage(m, '*'), envelope('console.raw_chunk', { inputRows: range(3, 7).map(inputRow), loaded: 3, total: 3, inputLoaded: 6, inputTotal: 6 }));
    await expect(page.locator('.tab-count[data-tab="input"]')).toHaveText('6');
    await expect(page.locator('#progress-phase')).not.toHaveText(/Loading/);
    expect(await page.evaluate(() => window.progressHandler.loading)).toBe(false);
    expect(await page.evaluate(() => window.dynamicReportManager.rawData.inputData.length)).toBe(6);
    expect(pageErrors).toEqual([]);
});
