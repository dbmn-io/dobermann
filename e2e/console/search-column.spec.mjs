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
    const rows = page.locator('#console-table .dbmn-table-body > tr.data-row');
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

// A column holding nested data (a list of objects): a term is asked of the values inside it, and
// a key named after a dot asks only that key. Before, only ~ could match such a column.
test('@column search reaches inside nested data: @column=value and @column.key=value', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const data = [
        { order: 'SO-1', itemCode: [{ key: 'A-2207', value: 'Olive oil', qty: 24 }, { key: 'C-7001', value: 'Paper cups', qty: 10 }] },
        { order: 'SO-2', itemCode: [{ key: 'B-0418', value: 'Espresso beans', qty: 60 }] },
        { order: 'SO-3', itemCode: [{ key: 'A-3110', value: 'A-2207 box', qty: 5 }] }
    ];
    const response = { ...responseFile(), data };
    const file = join(ROOT, '.dev-local/console-harness-search-nested.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager);
    const messages = [
        envelope('console.table_data_response', {
            rawData: {
                responses: [{ ...response, status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
                metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
            }
        }, { success: true }),
        envelope('status_update', {
            status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.1, startTime: Date.now() - 100,
            responseData: response, progress: { completed: 1, total: 1, percentage: 100 },
            responseFile: '/tmp/transaction-response.json', requestFile: '/tmp/transaction-request.json'
        }),
        { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }
    ];
    for (const m of messages) {
        await page.evaluate(msg => window.postMessage(msg, '*'), m);
        await page.waitForTimeout(20);
    }
    const rows = page.locator('#console-table .dbmn-table-body > tr.data-row');
    await expect(rows).toHaveCount(3);
    const box = page.locator('#search-input');
    const search = async (text, orders) => {
        await box.fill(text);
        await expect(rows, text).toHaveCount(orders.length);
        for (const [i, order] of orders.entries()) await expect(rows.nth(i), text).toContainText(order);
    };
    await search('@itemCode~A-2207', ['SO-1', 'SO-3']);        // contains, as before: anywhere in its text
    await search('@itemCode=A-2207', ['SO-1']);                // is: a value inside it, whole
    await search('@itemCode.key=A-2207', ['SO-1']);            // only under that key
    await search('@itemCode.value~A-2207', ['SO-3']);
    await search('@itemCode.qty>20', ['SO-1', 'SO-2']);
    await search('@itemCode.key!=A-2207', ['SO-2', 'SO-3']);
    await search('@itemCode.nope=A-2207', []);
    await search('', ['SO-1', 'SO-2', 'SO-3']);

    // Typing the dot lists the keys inside the column; picking one goes on to the operators
    const options = page.locator('.column-suggest-option');
    await box.fill('@item');
    await expect(options.first()).toContainText('@itemCode');
    await expect(options.first()).toContainText('nested');
    await box.fill('@itemCode');
    await expect(options.first().locator('.column-suggest-text')).toHaveText('.');
    await box.press('Enter');
    await expect(box).toHaveValue('@itemCode.');
    await expect(options.locator('.column-suggest-text')).toHaveText(['@itemCode.key', '@itemCode.value', '@itemCode.qty']);
    await box.pressSequentially('v');
    await expect(options.locator('.column-suggest-text')).toHaveText(['@itemCode.value']);
    await box.press('Enter');
    await expect(box).toHaveValue('@itemCode.value');
    await expect(options.first().locator('.column-suggest-text')).toHaveText('=');
    await box.pressSequentially('~beans');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('SO-2');
    expect(pageErrors).toEqual([]);
});
