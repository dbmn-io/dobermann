/**
 * The REAL Console page, in a real browser: resume a batch, retry its failures, and watch
 * the Error tab's number.
 *
 * Reported 2026-09-18: 64 failed members retried and succeeded. Their rows left the Error
 * tab at once, but its badge said 64 for the whole retry and only came right when the batch
 * completed. The bookkeeping is unit-tested in console-live-counts.test.ts; this drives the
 * page's own message handlers — clear_errors, batch_member_status_update,
 * batch_member_result_update — exactly as the host does, and reads the badge a user sees.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const row = (id, status, httpStatus) => ({
    httpStatus, status, data: status === 'completed' ? { created: 1 } : { error: 'Service Unavailable' },
    metadata: { executionId: id, status, timestamp: '2026-09-18T12:00:00Z' }
});

test('resume → retry 64 failures: the Error tab never shows a stale count', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    const file = join(ROOT, '.dev-local/console-harness.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'batch', batchId: 'batch-1' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);

    // A finished batch as the Console reopens it: 600 completed, 64 failed, 6 never run.
    const responses = [];
    const failedIds = [];
    for (let i = 0; i < 670; i++) {
        if (i >= 664) { responses.push(row(`m${i}`, 'pending', '-')); }
        else if (i % 10 === 3 && failedIds.length < 64) { failedIds.push(`m${i}`); responses.push(row(`m${i}`, 'error', 503)); }
        else { responses.push(row(`m${i}`, 'completed', 201)); }
    }
    await page.evaluate(rows => window.dynamicReportManager.initialize({ responses: rows, requests: [], logContent: [] }), responses);

    const badge = tab => page.locator(`.tab-count[data-tab="${tab}"]`);
    await expect(badge('errors')).toHaveText('64');
    await expect(badge('success')).toHaveText('600');

    const send = message => page.evaluate(m => window.postMessage(m, '*'), message);

    // The user resumes and chooses "Retry 64 failed".
    await send({ type: 'clear_errors', payload: { batchId: 'batch-1' } });
    await expect(badge('errors')).toHaveText('0');

    // The retried members run and succeed, a few at a time, as the batch engine reports them.
    const seen = new Set();
    for (let i = 0; i < failedIds.length; i += 8) {
        const ids = failedIds.slice(i, i + 8);
        await send({ type: 'batch_member_status_update', payload: { executionIds: ids, status: 'running', batchId: 'batch-1', memberIndices: {}, memberEndpointInfo: {} } });
        seen.add(await badge('errors').textContent());
        for (const id of ids) {
            await send({ type: 'batch_member_result_update', payload: { result: row(id, 'completed', 201), classification: 'success', batchId: 'batch-1', totalMembers: 670 } });
        }
        await page.waitForTimeout(30);
        seen.add(await badge('errors').textContent());
    }

    expect([...seen], 'every Error count shown during the retry').toEqual(['0']);
    await expect(badge('success')).toHaveText('664');
    await expect(page.locator('.tab-item[data-tab="errors"]')).toBeHidden();

    // …and nobody else's row was touched on the way.
    const tally = await page.evaluate(() => {
        const rows = window.dynamicReportManager.rawData.responses;
        const count = s => rows.filter(r => r.status === s).length;
        return { total: rows.length, completed: count('completed'), pending: count('pending'), error: count('error') };
    });
    expect(tally).toEqual({ total: 670, completed: 664, pending: 6, error: 0 });
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
