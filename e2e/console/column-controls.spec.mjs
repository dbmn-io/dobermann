/**
 * The Console's column headings on the REAL Console page: the controls every results table has
 * (shared/column-head.js and shared/column-drag.js). The name drags the column to another place,
 * the sort icon sorts, x takes the column out of the View, the right edge resizes, and a
 * right-click lists all of it by name. The order and the widths are the View's.
 *
 *   npm run test:e2e:console      (no backend needed — the page is loaded from src/)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, consolePage, envelope } from './console-page.mjs';

const EXEC_ID = 'exec_columns';

const FEW = [
    { sku: 'DOG-002', name: 'Rope Tug', quantity: 40, bin: 'A-01' },
    { sku: 'DOG-001', name: 'Chew Ring', quantity: 7, bin: 'B-12' },
    { sku: 'DOG-003', name: 'Slow Feeder Bowl', quantity: 120, bin: 'A-07' }
];
/** Enough rows that only those in view are drawn (the Console windows its rows from 200). */
const MANY = Array.from({ length: 600 }, (_, i) => ({ sku: `DOG-${String(i + 1).padStart(4, '0')}`, name: `Toy ${i + 1}`, quantity: i, bin: `A-${i % 40}` }));

let rows = FEW;
const responseFile = () => ({
    executionId: EXEC_ID, duration: 50, httpStatus: 200, httpStatusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: rows
});

const tableData = () => envelope('console.table_data_response', {
    rawData: {
        responses: [{ ...responseFile(), status: 'completed', metadata: { executionId: EXEC_ID, sourceFile: 'transaction-response.json', status: 'completed' } }],
        metadata: { executionId: EXEC_ID }, availablePaths: [], logContent: [], requestHeaders: {}, requestQueryParams: {}
    }
}, { success: true });

const statusUpdate = () => envelope('status_update', {
    status: 'completed', statusDisplay: '✅ Completed', durationSeconds: 0.05, startTime: Date.now() - 50,
    responseData: responseFile(), progress: { completed: 1, total: 1, percentage: 100 },
    responseFile: '/tmp/transaction-response.json', requestFile: '/tmp/transaction-request.json'
});

async function open(page, data) {
    rows = data;
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    const file = join(ROOT, '.dev-local/console-harness-column-controls.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, consolePage({ reportType: 'individual', executionId: EXEC_ID, statusDisplay: '✅ Completed', styles: true }));
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.dynamicReportManager && !!window.ColumnHead && !!window.ColumnDrag);

    for (const message of [tableData(), statusUpdate(), { type: 'REPORT_SETTINGS_LOADED', endpointId: 'endpoint-1', settings: null }]) {
        await page.evaluate(m => window.postMessage(m, '*'), message);
        await page.waitForTimeout(20);
    }
    return pageErrors;
}

test('a column is dragged by its name, sorted by its icon, resized by its edge, and removed by x', async ({ page }) => {
    const pageErrors = await open(page, FEW);

    const heads = page.locator('#console-table thead th');
    const names = () => heads.locator('.column-name').allTextContents();
    const column = n => page.locator('#console-table .dbmn-table-body > tr.data-row').evaluateAll((trs, i) => trs.map(tr => tr.cells[i].textContent.trim()), n);
    const viewOrder = () => page.evaluate(() => window.dynamicReportManager.getActiveView('success').columns[0].children.map(c => c.id.split('.').pop()));
    await expect(heads).toHaveCount(4);
    const was = await names();
    expect(was).toEqual(['sku', 'name', 'quantity', 'bin']);

    // The name does not sort; the icon does, and a column of numbers says so
    const sku = heads.nth(0), quantity = heads.nth(2);
    await sku.locator('.column-name').click();
    await expect(page.locator('#console-table thead th.sort-asc')).toHaveCount(0);
    await expect(quantity.locator('.col-sort-btn')).toHaveAttribute('title', 'Sort smallest first');
    await expect(sku.locator('.col-sort-btn')).toHaveAttribute('title', 'Sort A to Z');
    await sku.locator('.col-sort-btn').click();
    await expect(heads.nth(0)).toHaveClass(/sort-asc/);
    expect(await column(0)).toEqual(['DOG-001', 'DOG-002', 'DOG-003']);
    await heads.nth(2).locator('.col-sort-btn').click();
    await expect(heads.nth(2)).toHaveClass(/sort-asc/);
    expect(await column(2)).toEqual(['7', '40', '120']);

    // Drag sku's name past name: the whole column lifts, name slides aside, and it lands
    const grab = await heads.nth(0).locator('.column-name').boundingBox();
    const first = await heads.nth(0).boundingBox();
    const next = await heads.nth(1).boundingBox();
    await page.mouse.move(grab.x + 6, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x + 26, grab.y + grab.height / 2, { steps: 4 });
    await expect(page.locator('#console-table .dbmn-table-grid')).toHaveClass(/col-dragging/);
    await expect(page.locator('#console-table .dbmn-table-body td.col-lift')).toHaveCount(3);
    await page.mouse.move(grab.x + 6 + (next.x + next.width / 2) - (first.x + first.width / 2) + 5, grab.y + grab.height / 2, { steps: 8 });
    await expect(page.locator('#console-table .dbmn-table-body td.col-shift-left').first()).toBeVisible();
    await page.mouse.up();
    await expect.poll(names).toEqual(['name', 'sku', 'quantity', 'bin']);
    await expect(page.locator('#console-table .dbmn-table-grid')).not.toHaveClass(/col-dragging/);
    expect(await column(1)).toEqual(['DOG-001', 'DOG-002', 'DOG-003']);
    // The View's own order follows, so it is saved and comes back
    expect(await viewOrder()).toEqual(['name', 'sku', 'quantity', 'bin']);

    // Right-click a heading: Move to end, by name
    await heads.nth(0).locator('.column-name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu').getByText('Move to end').click();
    await expect.poll(names).toEqual(['sku', 'quantity', 'bin', 'name']);
    expect(await viewOrder()).toEqual(['sku', 'quantity', 'bin', 'name']);
    await heads.nth(1).locator('.column-name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu').getByText('Clear the sort').click();
    await expect(page.locator('#console-table thead th.sort-asc, #console-table thead th.sort-desc')).toHaveCount(0);

    // The right edge resizes its column only; the width is kept with the View
    const widths = () => heads.evaluateAll(ths => ths.map(th => th.getBoundingClientRect().width));
    const [w0, w1] = await widths();
    const edge = await heads.nth(0).locator('.col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 70, edge.y + edge.height / 2, { steps: 5 });
    // While it is pulled, the line is lit the height of the table
    await expect(page.locator('.col-size-guide')).toHaveCount(1);
    expect((await page.locator('.col-size-guide').boundingBox()).height).toBeGreaterThan(edge.height * 2);
    await page.mouse.up();
    await expect(page.locator('.col-size-guide')).toHaveCount(0);
    expect((await widths())[0]).toBeGreaterThan(w0 + 50);
    expect(Math.abs((await widths())[1] - w1)).toBeLessThan(3);
    expect(await page.evaluate(() => Object.keys(window.dynamicReportManager.getActiveView('success').columnWidths || {}).length)).toBe(1);
    // Pulled too narrow for its name and its icons, the heading is its name alone
    const thin = await heads.nth(0).locator('.col-edge').boundingBox();
    await page.mouse.move(thin.x + thin.width / 2, thin.y + thin.height / 2);
    await page.mouse.down();
    await page.mouse.move(thin.x - 400, thin.y + thin.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(heads.nth(0)).toHaveClass(/col-narrow/);
    await heads.nth(0).hover();
    await expect(heads.nth(0).locator('.col-hide-btn')).toBeHidden();
    // ...and a double-click fits it to what is on screen, icons and all
    await heads.nth(0).locator('.col-edge').dblclick();
    expect((await widths())[0]).toBeLessThan(w0 + 50);
    await expect(heads.nth(0)).not.toHaveClass(/col-narrow/);

    // x takes the column out of the View
    await heads.nth(3).hover();
    await heads.nth(3).locator('.col-hide-btn').click();
    await expect.poll(names).toEqual(['sku', 'quantity', 'bin']);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

test('a long result: a dragged column stays where it was put as more rows are drawn', async ({ page }) => {
    const pageErrors = await open(page, MANY);
    const heads = page.locator('#console-table thead th');
    const names = () => heads.locator('.column-name').allTextContents();
    await expect(heads).toHaveCount(4);
    // Only the rows in view are drawn
    expect(await page.locator('#console-table .dbmn-table-body > tr.data-row').count()).toBeLessThan(600);

    const grab = await heads.nth(0).locator('.column-name').boundingBox();
    const first = await heads.nth(0).boundingBox();
    const next = await heads.nth(1).boundingBox();
    await page.mouse.move(grab.x + 6, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x + 26, grab.y + grab.height / 2, { steps: 4 });
    await page.mouse.move(grab.x + 6 + (next.x + next.width / 2) - (first.x + first.width / 2) + 5, grab.y + grab.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(names).toEqual(['name', 'sku', 'quantity', 'bin']);

    // Rows drawn after the move (scrolled into view) are in the new order
    await page.locator('#console-table .dbmn-table-scroll').evaluate(box => { box.scrollTop = box.scrollHeight; });
    const last = page.locator('#console-table .dbmn-table-body > tr.data-row').last();
    await expect(last.locator('td').nth(0)).toHaveText('Toy 600');
    await expect(last.locator('td').nth(1)).toHaveText('DOG-0600');
    // ...and a sort keeps it
    await heads.nth(2).locator('.col-sort-btn').click();
    await expect(heads.nth(2)).toHaveClass(/sort-asc/);
    expect(await names()).toEqual(['name', 'sku', 'quantity', 'bin']);
    await expect(page.locator('#console-table .dbmn-table-body > tr.data-row').first().locator('td').nth(1)).toHaveText('DOG-0001');
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

/** Rows with a group inside: the View keeps `location`'s columns in a list of their own. */
const NESTED = [
    { sku: 'DOG-002', name: 'Rope Tug', location: { zone: 'A', bin: 'A-01', aisle: 3 }, quantity: 40 },
    { sku: 'DOG-001', name: 'Chew Ring', location: { zone: 'B', bin: 'B-12', aisle: 1 }, quantity: 7 },
    { sku: 'DOG-003', name: 'Slow Feeder Bowl', location: { zone: 'A', bin: 'A-07', aisle: 2 }, quantity: 120 }
];

test('a column in a group moves within its group, past a group beside it, and never out of its own', async ({ page }) => {
    const pageErrors = await open(page, NESTED);
    const heads = page.locator('#console-table thead th');
    const names = () => heads.locator('.column-name').allTextContents();
    const column = n => page.locator('#console-table .dbmn-table-body > tr.data-row').evaluateAll((trs, i) => trs.map(tr => tr.cells[i].textContent.trim()), n);
    await expect(heads).toHaveCount(6);
    expect(await names()).toEqual(['sku', 'name', 'zone', 'bin', 'aisle', 'quantity']);

    /** Hold column `from` by its name and let it go `past` px beyond the middle of column `to` (or at x). */
    const drag = async (from, to, check) => {
        const grab = await heads.nth(from).locator('.column-name').boundingBox();
        const a = await heads.nth(from).boundingBox();
        const b = typeof to === 'number' ? await heads.nth(to).boundingBox() : null;
        const y = grab.y + grab.height / 2;
        const travel = b ? (b.x + b.width / 2) - (a.x + a.width / 2) + (b.x > a.x ? 5 : -5) : to.by;
        await page.mouse.move(grab.x + 6, y);
        await page.mouse.down();
        await page.mouse.move(grab.x + 6 + Math.sign(travel) * 20, y, { steps: 4 });
        await page.mouse.move(grab.x + 6 + travel, y, { steps: 8 });
        if (check) await check();
        await page.mouse.up();
        await expect(page.locator('#console-table .dbmn-table-grid')).not.toHaveClass(/col-dragging/);
    };
    const levels = () => page.evaluate(() => {
        const last = c => c.id.split('.').pop();
        const walk = cols => cols.map(c => (c.children ? { [last(c)]: walk(c.children) } : last(c)));
        let cols = window.dynamicReportManager.getActiveView('success').columns;
        while (cols.length === 1 && cols[0].children) cols = cols[0].children;
        return walk(cols);
    });
    expect(await levels()).toEqual(['sku', 'name', { location: ['zone', 'bin', 'aisle'] }, 'quantity']);

    // Within its group: zone past bin. While it is held, headings outside the group are dimmed
    await drag(2, 3, async () => {
        await expect(heads.nth(0)).toHaveClass(/col-out/);
        await expect(heads.nth(4)).not.toHaveClass(/col-out/);
    });
    await expect.poll(names).toEqual(['sku', 'name', 'bin', 'zone', 'aisle', 'quantity']);
    expect(await column(2)).toEqual(['A-01', 'B-12', 'A-07']);
    expect(await levels()).toEqual(['sku', 'name', { location: ['bin', 'zone', 'aisle'] }, 'quantity']);

    // Past a group: name goes to the far side of all of location's columns, which slide aside together
    await drag(1, 4, async () => {
        await expect(page.locator('#console-table thead th.col-shift-left')).toHaveCount(3);
    });
    await expect.poll(names).toEqual(['sku', 'bin', 'zone', 'aisle', 'name', 'quantity']);
    expect(await column(4)).toEqual(['Rope Tug', 'Chew Ring', 'Slow Feeder Bowl']);
    expect(await levels()).toEqual(['sku', { location: ['bin', 'zone', 'aisle'] }, 'name', 'quantity']);

    // Never out of its group: aisle dragged far to the left stops at the group's start, and says why
    // (far: the table fills the window, so its columns are wide)
    await drag(3, { by: -1500 });
    await expect.poll(names).toEqual(['sku', 'aisle', 'bin', 'zone', 'name', 'quantity']);
    expect(await levels()).toEqual(['sku', { location: ['aisle', 'bin', 'zone'] }, 'name', 'quantity']);
    await expect(page.locator('.dbmn-toast').filter({ hasText: 'aisle can only move among the columns of' })).toBeVisible();

    // The menu moves within the group too
    await heads.nth(1).locator('.column-name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu').getByText('Move to end').click();
    await expect.poll(names).toEqual(['sku', 'bin', 'zone', 'aisle', 'name', 'quantity']);

    // The sort icon: one way, the other, then no sort — as in Query and Compare
    const sort = heads.nth(0).locator('.col-sort-btn');
    await sort.click();
    await expect(heads.nth(0)).toHaveClass(/sort-asc/);
    expect(await column(0)).toEqual(['DOG-001', 'DOG-002', 'DOG-003']);
    await heads.nth(0).locator('.col-sort-btn').click();
    await expect(heads.nth(0)).toHaveClass(/sort-desc/);
    expect(await column(0)).toEqual(['DOG-003', 'DOG-002', 'DOG-001']);
    await expect(heads.nth(0).locator('.col-sort-btn')).toHaveAttribute('title', 'Sorted Z to A. Click to clear the sort');
    await heads.nth(0).locator('.col-sort-btn').click();
    await expect(page.locator('#console-table thead th.sort-asc, #console-table thead th.sort-desc')).toHaveCount(0);
    expect(await column(0)).toEqual(['DOG-002', 'DOG-001', 'DOG-003']);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});
