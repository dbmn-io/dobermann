/**
 * <dbmn-table> (shared/dbmn-table.js) in a real browser from the real files: the shared search,
 * heading, drag and windowing pieces, held together by one element.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
const SCRIPTS = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js'];

const tablePage = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:900px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Orders" searchable removable></dbmn-table>
<script>
  const t = document.getElementById('t');
  window.shown = [];
  t.addEventListener('dbmn-table-shown', e => window.shown.push(e.detail.text));
  t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer' }, { id: 'qty', name: 'qty', numbers: true }, { id: 'notes', name: 'notes' }];
  const who = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli'];
  t.rows = Array.from({ length: 3000 }, (_, i) => ({ order_no: 'SO-' + (10000 + i), customer: who[i % 3], qty: (i * 7) % 50, notes: i === 1 ? { reason: 'Awaiting stock' } : '' }));
</script></body></html>`;

const column = (page, n) => page.locator('#t .dbmn-table-body tr').evaluateAll((rows, i) => rows.slice(0, 5).map(r => r.cells[i].textContent), n);
const names = page => page.locator('#t thead .column-name').allTextContents();

test('only the rows in view are drawn, and scrolling brings the rest', async ({ page }) => {
    await page.setContent(tablePage());
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('3,000 rows');
    expect(await page.locator('#t .dbmn-table-body tr').count()).toBeLessThan(120);
    // It fits its box: no sideways scroll for a table that has the room
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(0);
    await expect(page.locator('#t .dbmn-table-body tr').first()).toContainText('SO-10000');
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = box.scrollHeight; });
    await expect(page.locator('#t .dbmn-table-body tr').last()).toContainText('SO-12999');
    expect(await page.locator('#t .dbmn-table-body tr').count()).toBeLessThan(120);
});

test('search: words, one column, and the count says how many of how many', async ({ page }) => {
    await page.setContent(tablePage());
    const box = page.locator('#t .search-input');
    await box.fill('kettle');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    expect(new Set(await column(page, 1))).toEqual(new Set(['Kettle and Co']));
    // The box colours what is typed, as the Console's does
    expect(await page.locator('#t .search-input-mirror').textContent()).toBe('kettle');

    await box.fill('@qty=49 -kettle');
    const count = await page.locator('#t .dbmn-table-count').textContent();
    expect(count).toMatch(/^\d+ of 3,000 rows$/);
    expect(new Set(await column(page, 2))).toEqual(new Set(['49']));
    expect(await column(page, 1)).not.toContain('Kettle and Co');

    await box.fill('nothing-like-this');
    await expect(page.locator('#t .dbmn-table-none')).toHaveText('No rows match the search.');
    await box.fill('');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('3,000 rows');
    expect(await page.evaluate(() => window.shown.at(-1))).toBe('3,000 rows');
});

test('a heading sorts one way, the other, then as given; x removes the column', async ({ page }) => {
    await page.setContent(tablePage());
    const sort = page.locator('#t thead th').nth(2).locator('.col-sort-btn');
    await sort.click();
    expect(await column(page, 2)).toEqual(['0', '0', '0', '0', '0']);
    await expect(page.locator('#t thead th').nth(2)).toHaveClass(/sort-asc/);
    await page.locator('#t thead th').nth(2).locator('.col-sort-btn').click();
    expect(await column(page, 2)).toEqual(['49', '49', '49', '49', '49']);
    await page.locator('#t thead th').nth(2).locator('.col-sort-btn').click();
    expect(await column(page, 0)).toEqual(['SO-10000', 'SO-10001', 'SO-10002', 'SO-10003', 'SO-10004']);

    await page.locator('#t thead th').nth(1).locator('.col-hide-btn').click();
    expect(await names(page)).toEqual(['order_no', 'qty', 'notes']);
    expect((await column(page, 1))[1]).toBe('7');
});

test('the right edge resizes only its column', async ({ page }) => {
    await page.setContent(tablePage());
    const widths = () => page.locator('#t thead th').evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)));
    const before = await widths();
    const edge = await page.locator('#t thead th').nth(0).locator('.col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 80, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    const after = await widths();
    expect(after[0]).toBeGreaterThan(before[0] + 60);
    expect(after.slice(1)).toEqual(before.slice(1));
});

test('a right-click on a heading lists what it can do, and moves the column', async ({ page }) => {
    await page.setContent(tablePage());
    await page.locator('#t thead th').nth(3).click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu-item')).toContainText(['Sort A to Z', 'Sort Z to A', 'Clear the sort', 'Move to start']);
    await page.locator('.dbmn-context-menu-item', { hasText: 'Move to start' }).click();
    expect((await names(page))[0]).toBe('notes');
});

test('search reaches inside a nested value, and @column. lists its keys', async ({ page }) => {
    await page.setContent(tablePage());
    const box = page.locator('#t .search-input');
    await box.fill('@notes.reason~stock');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 3,000 rows');
    await box.fill('@notes');
    await expect(page.locator('#t .column-suggest-option .column-suggest-text').first()).toHaveText('.');
    await box.fill('@notes.');
    await expect(page.locator('#t .column-suggest-option .column-suggest-text')).toHaveText(['@notes.reason']);
});

test('a structured value opens in full', async ({ page }) => {
    await page.setContent(tablePage());
    const cell = page.locator('#t .dbmn-table-body tr').nth(1).locator('td.cell-expandable');
    await expect(cell).toContainText('Awaiting stock');
    await cell.click();
    await expect(page.locator('.cell-detail, .dbmn-modal').first()).toBeVisible();
});
