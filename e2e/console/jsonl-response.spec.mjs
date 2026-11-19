/**
 * Issue #115 on the REAL Console page: a JSON Lines response is one transaction whose lines are
 * records. Completed gives each line a row (row basis `data`); Raw labels it JSONL and shows
 * the lines as they came (Lines) or as one indented array (Pretty).
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage } from './console-page.mjs';

const RECORDS = [
    { sku: 'DOG-001', location: 'WH1', quantity: 12 },
    { sku: 'DOG-002', location: 'WH1', quantity: 3 },
    { sku: 'DOG-003', location: 'WH2', quantity: 7 }
];

/** The response file the engine writes for a JSONL body whose last line was cut off. */
const response = () => ({
    executionId: 'exec_1', duration: 90, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/x-ndjson' },
    data: RECORDS,
    format: { kind: 'jsonl', records: 3, invalid: [{ line: 4, text: '{"sku":"DOG-0' }], invalidCount: 1 },
    status: 'completed',
    metadata: { executionId: 'exec_1', sourceFile: 'transaction-001-response.json', status: 'completed', timestamp: '2026-10-10T10:00:00Z', responseTime: 90 }
});

test('a JSONL response: a row per line in Completed; Raw shows the lines, then Pretty', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-jsonl.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: 'exec_1' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    await page.evaluate(r => window.dynamicReportManager.initialize({
        responses: [r], requests: [], logContent: [], metadata: { executionId: 'exec_1' }
    }), response());

    // Completed: one transaction, three rows — one per line
    await page.locator('.tab-item[data-tab="success"]').click();
    await expect(page.locator('.tab-count[data-tab="success"]')).toHaveText('1');
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row')).toHaveCount(3);
    await expect(page.locator('#console-table')).toContainText('DOG-003');

    // Raw: labelled, Lines by default
    await page.locator('.tab-item[data-tab="raw"]').click();
    const pane = page.locator('.raw-response-pane').first();
    await expect(pane.locator('.raw-pane-title')).toHaveText('RESPONSE (JSONL · 3 records · 1 line not JSON)');
    await expect(pane.locator('[data-toggle-group="response-format"] .raw-view-mode-btn.active')).toHaveText('Lines');
    const container = pane.locator('.raw-monaco-container');
    await expect(container).toHaveAttribute('data-jsonl-mode', 'lines');
    const shown = () => page.evaluate(() => {
        const el = document.querySelector('.raw-response-pane .raw-monaco-container');
        return window.rawTabHandler.resolveContentForContainer(el);
    });
    expect(await shown()).toBe([...RECORDS.map(r => JSON.stringify(r)), '{"sku":"DOG-0'].join('\n'));

    await pane.locator('.raw-view-mode-btn[data-mode="pretty"]').click();
    await expect(container).toHaveAttribute('data-jsonl-mode', 'pretty');
    expect(await shown()).toBe(JSON.stringify(RECORDS, null, 2));
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('while the body arrives the footer says how much: a real bar with a total, a busy one without, then 100% and Processing', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-jsonl-receiving.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: 'exec_1', statusDisplay: '🔄 Running' }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    const post = m => page.evaluate(message => window.postMessage(message, '*'), m);
    // startTime 4 s ago: the request has been going that long
    const receiving = (r) => ({ type: 'progress_update', payload: { executionId: 'exec_1', title: 'Receiving', status: 'running', totalProgress: 0, startTime: Date.now() - 4000, timestamp: Date.now(), receiving: r } });
    // The progress box (dbmn-progress): its state (the bar's look), its value, and the one time beside the count
    const box = page.locator('#progress-display');

    // No total (a streamed body): records and MB, a busy bar (not a full one), the speed
    await post(receiving({ bytes: 10 * 1048576, lines: 12340, jsonl: true, done: false }));
    await expect(page.locator('#progress-display')).toHaveAttribute('phase', 'Receiving 12,340 records');
    await expect(page.locator('#progress-display')).toHaveAttribute('count', '10.0 MB');
    await expect(box).toHaveAttribute('data-state', /\bbusy\b/);
    await expect(box).toHaveAttribute('busy', '');
    await expect(box).toHaveAttribute('note', '2.5 MB/s');
    await expect(page.locator('#progress-display')).not.toHaveClass(/hidden/);
    expect(await page.evaluate(() => window.progressHandler?.executionStartTime ?? null), 'the run clock not started by a body update').toBe(null);

    // X-Total-Count: of how many, a real percentage, and the time left (4 s for 80% → 1 s)
    await post(receiving({ bytes: 64 * 1048576, lines: 76097, totalRecords: 95121, jsonl: true, done: false }));
    await expect(page.locator('#progress-display')).toHaveAttribute('phase', 'Receiving 76,097 / 95,121 records');
    await expect(page.locator('#progress-display')).toHaveAttribute('count', '80%');
    await expect(box).toHaveAttribute('data-state', /\bloading\b/);
    await expect(box).toHaveAttribute('value', '80');
    await expect(box).toHaveAttribute('note', '64.0 MB · ≈1s left');

    // All in: 100%, then processing (parse and save) as a barber pole until the result arrives
    await post(receiving({ bytes: 80.5 * 1048576, lines: 95121, totalRecords: 95121, jsonl: true, done: true }));
    await expect(page.locator('#progress-display')).toHaveAttribute('phase', 'Processing 95,121 records');
    await expect(page.locator('#progress-display')).toHaveAttribute('count', '100%');
    await expect(box).toHaveAttribute('data-state', /\bprocessing\b/);
    await expect(box).toHaveAttribute('value', '100');
    expect(await box.getAttribute('note'), 'no time beside it while it is processed').toBe(null);
    await post(receiving({ bytes: 1048576, lines: 3, jsonl: false, done: true }));
    await expect(page.locator('#progress-display')).toHaveAttribute('phase', 'Processing data');

    // Not JSON Lines, with a Content-Length: a percentage of the bytes
    await post(receiving({ bytes: 1048576, lines: 3, totalBytes: 4 * 1048576, jsonl: false, done: false }));
    await expect(page.locator('#progress-display')).toHaveAttribute('phase', 'Receiving');
    await expect(page.locator('#progress-display')).toHaveAttribute('count', '25%');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
