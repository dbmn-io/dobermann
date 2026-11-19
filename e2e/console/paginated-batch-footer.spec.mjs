/**
 * The REAL Console page on Fetch all (GitHub Issue #436).
 *
 * Reported 2026-11-09: while a paginated run fetched its pages, the footer read "Processing data"
 * (the striped bar of a response body being saved) all the time, under the batch's own count
 * (465/721), and switched between the two. The first page's download progress is shown, since
 * nothing else is there yet; once the batch has more pages, its own progress owns the footer.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const BATCH = 'batch-436';

const page1 = (n) => ({
    httpStatus: 200, httpStatusText: 'OK', duration: 20, headers: {},
    data: { page: n, items: [{ sku: `SKU-${n}` }] },
    metadata: { executionId: `page_${n}`, sourceFile: `transaction-${n}-response.json`, status: 'completed' },
    status: 'completed'
});

test('after the first page, the batch\'s count takes the footer back from "Processing data"', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-paginated-footer.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: BATCH, executionId: BATCH, statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    const post = m => page.evaluate(message => window.postMessage(message, '*'), m);
    // The progress box (dbmn-progress): its phase and its state (the bar's look)
    const box = page.locator('#progress-display');

    // The batch is running; page 1's body arrives and is saved
    await post({ type: 'progress_update', payload: { executionId: BATCH, status: 'running', startTime: Date.now() - 2000, timestamp: Date.now() } });
    await post({ type: 'progress_update', payload: { executionId: BATCH, title: 'Receiving', status: 'running', totalProgress: 100, startTime: Date.now() - 1000, timestamp: Date.now(), receiving: { bytes: 1048576, lines: 0, jsonl: false, done: true } } });
    await expect(box).toHaveAttribute('phase', 'Processing data');
    await expect(box).toHaveAttribute('data-state', /\bprocessing\b/);

    // Page 1's result is in; Fetch all's next pages come in with the batch's total
    await page.evaluate(r => {
        window.dynamicReportManager.initialize({ responses: r, requests: [], logContent: [] });
        document.getElementById('loading-overlay')?.classList.add('hidden');
    }, [page1(1)]);
    await post(envelope('batch_member_result_update', { result: page1(2), classification: 'success', memberIndex: 1, batchId: BATCH, totalMembers: 721 }));
    await post(envelope('batch_member_result_update', { result: page1(3), classification: 'success', memberIndex: 2, batchId: BATCH, totalMembers: 721 }));

    await expect(page.locator('#progress-display')).toHaveAttribute('count', '3/721');
    await expect(box, 'the batch\'s own phase, not the page\'s').toHaveAttribute('phase', 'Executing');
    await expect(box).not.toHaveAttribute('data-state', /\b(processing|loading|busy)\b/);
    await expect(box).toHaveAttribute('data-state', /\brunning\b/);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
