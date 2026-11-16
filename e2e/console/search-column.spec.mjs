/**
 * The Console's find box on the REAL Console page: `@column` terms filter on that column's own
 * value (search-matcher.js, shared with Compare), and typing `@` lists the table's columns, then
 * the operators.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_search';

const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: [
        { sku: 'WOOF-001', status: 'active', quantityOnHand: 5, uom: 'EA' },
        { sku: 'MEOW-002', status: 'reserved', quantityOnHand: 20, uom: 'CS' },
        { sku: 'WOOF-003', status: 'active', quantityOnHand: 50, uom: 'CS' }
    ]
});

const tableData = () => envelope('console.table_data_response', {
    rawData: {
        responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
        metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
    }
}, { success: true });

const completed = () => envelope('status_update', {
    status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.1, startTime: Date.now() - 100,
    responseData: responseFile(), progress: { completed: 1, total: 1, percentage: 100 },
    responseFile: '/tmp/transaction-response.json', requestFile: '/tmp/transaction-request.json'
});

test('@column search: a column\'s own value, and @ suggests the columns then the operators', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-search.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    for (const m of [tableData(), completed(), { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }]) {
        await page.evaluate(msg => window.postMessage(msg, '*'), m);
        await page.waitForTimeout(20);
    }
    const rows = page.locator('#data-table tbody tr');
    await expect(rows).toHaveCount(3);
    const box = page.locator('#search-input');
    await expect(box).toHaveAttribute('spellcheck', 'false');   // column names are not spelling mistakes

    const search = async (text, count) => {
        await box.fill(text);
        await expect(rows, text).toHaveCount(count);
    };
    await search('@status=active', 2);
    await search('@status!=active', 1);
    await search('@quantityOnHand>10', 2);
    await search('@sku~woof', 2);
    await search('@uom=EA|CS @status=active', 2);         // | is any of
    await search('@quantityOnHand=5..20', 2);             // .. is between, both ends in
    await search('@sku~WOOF-001, @sku~MEOW', 2);          // a comma: either part
    await search('@status=active 003', 1);   // words still search the whole row
    await search('@colour=red', 0);          // no such column: nothing
    await search('', 3);

    // Typing @ lists the columns; Enter picks one and lists the operators
    await box.pressSequentially('@st');
    const options = page.locator('.column-suggest .column-suggest-option');
    await expect(options.first()).toContainText('@status');
    await box.press('Enter');
    await expect(box).toHaveValue('@status');
    await expect(options.filter({ hasText: 'is not' })).toHaveCount(1);
    await box.press('Escape');
    await expect(page.locator('#search-input-mirror .search-tok-col-name')).toHaveText('@status');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
