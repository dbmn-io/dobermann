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
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
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
    // It says so on hover: the maximise icon at its right edge, as in every table
    await expect(cell.locator('.cell-expand-icon svg')).toHaveCount(1);
    await cell.hover();
    await expect(cell.locator('.cell-expand-icon')).toHaveCSS('opacity', '1');
    await cell.click();
    await expect(page.locator('.cell-detail, .dbmn-modal').first()).toBeVisible();
});

/* ── Rows that stay with the screen: asked for a page at a time ── */

// A screen's rows: 10,000 of them behind `page`, which answers a moment later and notes what it was asked
const sourcePage = (attrs = 'label="Orders" removable', extra = '') => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:900px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<input id="find" type="text" aria-label="Find">
<dbmn-table id="t" ${attrs}></dbmn-table>
<script>
  const t = document.getElementById('t');
  window.asked = []; window.told = []; window.searched = []; window.wait = 30;
  const who = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli'];
  const all = Array.from({ length: 10000 }, (_, i) => ({ order_no: 'SO-' + (10000 + i), customer: who[i % 3], qty: (i * 7) % 50, ref: String(i) }));
  window.rowsFor = ({ search, sort }) => {
      let rows = search ? all.filter(r => r.customer.toLowerCase().includes(search.toLowerCase())) : all.slice();
      if (sort) rows.sort((a, b) => (sort.dir === 'desc' ? -1 : 1) * (sort.id === 'qty' ? a.qty - b.qty : String(a[sort.id]).localeCompare(String(b[sort.id]))));
      return rows;
  };
  t.addEventListener('dbmn-table-layout', e => window.told.push(e.detail));
  t.addEventListener('dbmn-table-search', e => window.searched.push(e.detail.text));
  t.addEventListener('dbmn-table-shown', e => { window.shownText = e.detail.text; });
  t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer', className: 'from-b' }, { id: 'qty', name: 'qty', numbers: true }, { id: 'ref', name: 'ref' }];
  ${extra}
  t.source = { page: (start, count, opts) => new Promise(done => {
      window.asked.push({ start, count, search: opts.search, sort: opts.sort });
      const rows = window.rowsFor(opts);
      setTimeout(() => done({ rows: rows.slice(start, start + count), total: rows.length }), window.wait);
  }) };
</script></body></html>`;
const firstCell = page => page.locator('#t .dbmn-table-body tr:not(.dbmn-table-waiting)').first().locator('td').first();

test('rows on demand: only the pages in view are asked for, and a row not in yet is an empty row', async ({ page }) => {
    await page.setContent(sourcePage());
    await expect(firstCell(page)).toHaveText('SO-10000');
    expect(await page.evaluate(() => window.shownText)).toBe('10,000 rows');
    expect(await page.evaluate(() => window.asked.map(a => a.start))).toEqual([0]);
    // No search box or count of its own without `searchable`
    await expect(page.locator('#t .dbmn-table-tools')).toBeHidden();
    const rowHeight = await page.locator('#t .dbmn-table-body tr').first().evaluate(r => r.getBoundingClientRect().height);
    // Its height is the whole 10,000 rows' from the start: the scroll bar does not jump as pages land
    const tall = await page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollHeight);
    expect(tall).toBeGreaterThan(10000 * 20);
    // Far down: empty rows of the same height at once, then the rows of that page
    await page.evaluate(() => { window.wait = 400; });
    await page.locator('#t .dbmn-table-scroll').evaluate((box, h) => { box.scrollTop = 5000 * h; }, rowHeight);
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting').first()).toBeVisible();
    const heights = await page.locator('#t .dbmn-table-body tr.dbmn-table-waiting').evaluateAll(rows => rows.slice(0, 3).map(r => r.getBoundingClientRect().height));
    expect(new Set(heights)).toEqual(new Set([rowHeight]));
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting')).toHaveCount(0);
    const here = await firstCell(page).textContent();
    expect(Number(here.slice(3))).toBeGreaterThan(14900);
    expect(Number(here.slice(3))).toBeLessThan(15000);
    // Nothing between the top and there was asked for
    const starts = await page.evaluate(() => window.asked.map(a => a.start));
    expect(starts.length).toBeLessThanOrEqual(3);
    expect(starts.filter(s => s > 0 && s < 4600)).toEqual([]);
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollHeight)).toBe(tall);
});

test('rows on demand: an answer that says how many there are before the search counts "12 of 10,000 rows"', async ({ page }) => {
    await page.setContent(sourcePage('label="Orders" searchable').replace(
        'done({ rows: rows.slice(start, start + count), total: rows.length })',
        'done({ rows: rows.slice(start, start + count), total: rows.length, of: all.length })'));
    await expect(firstCell(page)).toHaveText('SO-10000');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('10,000 rows');
    await page.locator('#t .dbmn-table-tools input').fill('kettle');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('3,333 of 10,000 rows');
    await page.locator('#t .dbmn-table-tools input').fill('');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('10,000 rows');
});

test('rows on demand: a sort is the screen\'s; the icon is a clock until the rows land, and the third click clears it', async ({ page }) => {
    await page.setContent(sourcePage());
    await expect(firstCell(page)).toHaveText('SO-10000');
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 600; });
    await page.evaluate(() => { window.wait = 400; });
    const sort = page.locator('#t thead th').nth(2).locator('.col-sort-btn');
    await sort.click();
    // Answered at once, and the rows on screen stay until the new ones land
    await expect(sort).toHaveClass(/is-sorting/);
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting')).toHaveCount(0);
    expect(await page.evaluate(() => window.asked.at(-1))).toEqual({ start: 0, count: 200, search: '', sort: { id: 'qty', dir: 'asc' } });
    expect(await page.evaluate(() => window.told.at(-1).layout.sort)).toEqual({ id: 'qty', dir: 'asc' });
    await expect(page.locator('#t thead th').nth(2)).toHaveClass(/sort-asc/);
    await expect(page.locator('#t thead th').nth(2).locator('.col-sort-btn')).not.toHaveClass(/is-sorting/);
    // From the top, in the screen's order
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollTop)).toBe(0);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(2)).toHaveText('0');
    await page.evaluate(() => { window.wait = 20; });
    await page.locator('#t thead th').nth(2).locator('.col-sort-btn').click();
    await expect(page.locator('#t thead th').nth(2)).toHaveClass(/sort-desc/);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(2)).toHaveText('49');
    await page.locator('#t thead th').nth(2).locator('.col-sort-btn').click();
    await expect(firstCell(page)).toHaveText('SO-10000');
    expect(await page.evaluate(() => window.asked.at(-1).sort)).toBeNull();
});

test('rows on demand: the screen\'s own search box searches, and reload asks again from the top or in place', async ({ page }) => {
    await page.setContent(sourcePage('label="Orders"', "t.searchWith(document.getElementById('find'));"));
    await expect(firstCell(page)).toHaveText('SO-10000');
    // The suggestions are the table's columns, on the screen's box
    await page.locator('#find').fill('@');
    await expect(page.locator('.column-suggest-option .column-suggest-text', { hasText: '@order_no' })).toHaveCount(1);
    await page.locator('#find').fill('kettle');
    await expect(firstCell(page)).toHaveText('SO-10001');
    expect(await page.evaluate(() => window.searched.at(-1))).toBe('kettle');
    expect(await page.evaluate(() => window.asked.at(-1).search)).toBe('kettle');
    // (one asking for the word, not one a key)
    expect(await page.evaluate(() => window.asked.filter(a => a.search && a.search !== 'kettle').length)).toBe(0);
    expect(await page.evaluate(() => window.shownText)).toBe('3,333 rows');
    // A search that finds nothing says so
    await page.locator('#find').fill('nobody');
    await expect(page.locator('#t .dbmn-table-none')).toHaveText('No rows match the search.');
    await page.locator('#find').fill('');
    await expect(firstCell(page)).toHaveText('SO-10000');

    // A live refresh keeps the place; a change of rows goes back to the top
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 3000; });
    await page.evaluate(() => document.getElementById('t').reload({ keep: true }));
    await page.waitForFunction(() => window.asked.filter(a => a.start === 0).length >= 4);
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting')).toHaveCount(0);
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollTop)).toBe(3000);
    await page.evaluate(() => document.getElementById('t').reload());
    await expect.poll(() => page.locator('#t .dbmn-table-scroll').evaluate(box => box.scrollTop)).toBe(0);
    // An answer to an earlier asking is dropped: asked twice quickly, only the second lands
    await page.evaluate(() => {
        window.wait = 300; document.getElementById('find').value = 'harbour'; document.getElementById('t').reload();
        window.wait = 20; document.getElementById('find').value = 'mill'; document.getElementById('t').reload();
    });
    await page.waitForTimeout(500);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(1)).toHaveText('Mill Lane Deli');
});

test('rows on demand: a column removed and the rows asked again in place, the rows on screen stay until theirs land, never blank', async ({ page }) => {
    // (the first page answers quickly, the rest slowly: as when the host works a compare's Status out again)
    await page.setContent(sourcePage().replace('window.wait);', '(typeof window.wait === "function" ? window.wait(start) : window.wait));'));
    await expect(firstCell(page)).toHaveText('SO-10000');
    const rowHeight = await page.locator('#t .dbmn-table-body tr').first().evaluate(r => r.getBoundingClientRect().height);
    await page.locator('#t .dbmn-table-scroll').evaluate((box, h) => { box.scrollTop = 1000 * h; }, rowHeight);
    await expect.poll(async () => Number((await firstCell(page).textContent()).slice(3))).toBeGreaterThan(10900);
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting')).toHaveCount(0);
    const before = await firstCell(page).textContent();
    await page.evaluate(() => { window.wait = start => (start === 0 ? 50 : 1500); });
    // The screen takes a column out (its x), then asks again, staying where it is
    await page.locator('#t th[data-col="ref"] .col-hide-btn').click({ force: true });
    await page.evaluate(() => document.getElementById('t').reload({ keep: true }));
    // The first page is in, the one on screen is not: the rows drawn are still there, not empty rows
    await page.waitForFunction(() => window.asked.filter(a => a.start === 0).length >= 2);
    await page.waitForTimeout(400);
    // (looked at once, not waited for: the slow page is not in yet)
    expect(await page.evaluate(() => window.asked.filter(a => a.start > 0).length)).toBeGreaterThan(0);
    expect(await page.locator('#t .dbmn-table-body tr.dbmn-table-waiting').count()).toBe(0);
    expect(await firstCell(page).textContent()).toBe(before);
    expect(await page.locator('#t .dbmn-table-body tr').first().locator('td').count()).toBe(3);
    // Then its own page lands in their place
    await page.waitForTimeout(1300);
    await expect(page.locator('#t .dbmn-table-body tr.dbmn-table-waiting')).toHaveCount(0);
    await expect(firstCell(page)).toHaveText(before);
    // Asked again from the top (a new search): nothing of the old rows is kept for later
    await page.evaluate(() => { window.wait = 20; document.getElementById('t').reload(); });
    await expect(firstCell(page)).toHaveText('SO-10000');
    expect(await page.locator('#t').evaluate(t => t._was.size)).toBe(0);
});

test('the layout: what the user moved, removed and resized is told, and a saved layout is taken back', async ({ page }) => {
    await page.setContent(sourcePage());
    await expect(firstCell(page)).toHaveText('SO-10000');
    await page.locator('#t thead th').nth(3).click({ button: 'right' });
    await page.locator('.dbmn-context-menu-item', { hasText: 'Move to start' }).click();
    expect(await page.evaluate(() => { const d = window.told.at(-1); return [d.change, d.id, d.to, d.layout.order]; })).toEqual(['moved', 'ref', 0, ['ref', 'order_no', 'customer', 'qty']]);
    await page.locator('#t thead th').nth(1).locator('.col-hide-btn').click();
    expect(await page.evaluate(() => { const d = window.told.at(-1); return [d.change, d.id, d.layout.hidden]; })).toEqual(['removed', 'order_no', ['order_no']]);
    const edge = await page.locator('#t thead th').nth(0).locator('.col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 60, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    const resized = await page.evaluate(() => window.told.at(-1));
    expect(resized.change).toBe('resized');
    expect(resized.id).toBe('ref');
    // Only the width the user set is in the layout: measured ones are measured again next time
    expect(Object.keys(resized.layout.widths)).toEqual(['ref']);
    // The rows were not asked for again by any of it
    expect(await page.evaluate(() => window.asked.length)).toBe(1);

    // Given back (after the columns): the same order, the column still out, its width, and the sort shown
    await page.evaluate(saved => {
        const t = document.getElementById('t');
        t.columns = t.columns.concat([]).length ? [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer' }, { id: 'qty', name: 'qty', numbers: true }, { id: 'ref', name: 'ref' }] : [];
        t.layout = Object.assign({}, saved, { sort: { id: 'qty', dir: 'desc' } });
    }, resized.layout);
    expect(await names(page)).toEqual(['ref', 'customer', 'qty']);
    expect(Math.round((await page.locator('#t thead th').nth(0).boundingBox()).width)).toBe(resized.layout.widths.ref);
    await expect(page.locator('#t thead th').nth(2)).toHaveClass(/sort-desc/);
});

test('locked: columns can be neither moved nor removed', async ({ page }) => {
    await page.setContent(sourcePage('label="Orders" removable locked'));
    await expect(firstCell(page)).toHaveText('SO-10000');
    await expect(page.locator('#t thead .col-hide-btn')).toHaveCount(0);
    await expect(page.locator('#t thead .column-name.is-movable')).toHaveCount(0);
    await page.locator('#t thead th').nth(3).click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Sort' }).first()).toBeVisible();
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Move to start' })).toHaveCount(0);
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Remove' })).toHaveCount(0);
});

test('a column\'s class is on its heading and cells, a number sits right, and the screen\'s totals stay under the rows', async ({ page }) => {
    await page.setContent(sourcePage());
    await expect(firstCell(page)).toHaveText('SO-10000');
    await expect(page.locator('#t thead th').nth(1)).toHaveClass(/from-b/);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(1)).toHaveClass(/from-b/);
    // qty is a column of numbers; ref holds text that looks like one and stays left
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(2)).toHaveClass(/text-right/);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(3)).not.toHaveClass(/text-right/);
    await expect(page.locator('#t tfoot tr')).toHaveCount(0);
    await page.evaluate(() => { document.getElementById('t').totals = { qty: 244965, order_no: 'Total' }; });
    await expect(page.locator('#t tfoot td')).toHaveText(['Total', '', '244,965', '']);
    // In view at the bottom of the box however far the rows scroll
    const inView = async () => {
        const [foot, box] = await Promise.all([page.locator('#t tfoot td').first().boundingBox(), page.locator('#t .dbmn-table-scroll').boundingBox()]);
        return foot.y + foot.height <= box.y + box.height + 1 && foot.y > box.y;
    };
    expect(await inView()).toBe(true);
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 40000; });
    expect(await inView()).toBe(true);
    await page.evaluate(() => { document.getElementById('t').totals = null; });
    await expect(page.locator('#t tfoot tr')).toHaveCount(0);
});

test('totals put on after the columns were sized: a total its column cuts widens it, and every total says itself whole under the pointer', async ({ page }) => {
    // (a narrow box: the columns are not stretched to fill it, so qty is as narrow as its values)
    await page.setContent(tablePage().replace('width:900px', 'width:380px'));
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').first()).toHaveText('SO-10000');
    const qtyHead = page.locator('#t th[data-col="qty"]');
    const before = (await qtyHead.boundingBox()).width;
    await page.evaluate(() => { document.getElementById('t').totals = { qty: 1234567890, order_no: 'Total' }; });
    const total = page.locator('#t tfoot td').nth(2);
    await expect(total).toHaveText('1,234,567,890');
    await expect(total).toHaveAttribute('title', 'Total: 1,234,567,890');
    await expect(page.locator('#t tfoot td').first()).toHaveAttribute('title', 'Total: Total');
    // Whole, not "1,234,…": its column grew to it
    expect(await total.evaluate(td => td.scrollWidth <= td.clientWidth + 1)).toBe(true);
    expect((await qtyHead.boundingBox()).width).toBeGreaterThan(before);
    // A width the user set stays as set: its total is cut, and the pointer still shows it whole
    await page.evaluate(() => { const t = document.getElementById('t'); t.totals = null; t.layout = { widths: { qty: 50 } }; t.totals = { qty: 1234567890 }; });
    await expect(total).toHaveAttribute('title', 'Total: 1,234,567,890');
    expect(Math.round((await qtyHead.boundingBox()).width)).toBe(50);
});

test('a compared column\'s totals: under the pointer, every total of its group in one card, one under another, lined up, the ones not the same as the first marked', async ({ page }) => {
    await page.setContent(groupedPage().replace("{ id: 'qty|1', name: 'C1', group: qty, numbers: true }", "{ id: 'qty|1', name: 'C1', group: qty, numbers: true }, { id: 'qty|2', name: 'C2', group: qty, numbers: true }"));
    await page.evaluate(() => { document.getElementById('t').totals = { 'qty|0': 127450, 'qty|1': 127450, 'qty|2': 126881, sku: 'Total' }; });
    const c1 = page.locator('#t tfoot td.has-group-total').nth(1);
    await expect(page.locator('#t tfoot td.has-group-total')).toHaveCount(3);
    // (no tooltip of its own: the card says it, and more)
    expect(await c1.getAttribute('title')).toBeNull();
    await expect(page.locator('#t tfoot td').first()).toHaveAttribute('title', 'Total: Total');
    await c1.hover();
    const card = page.locator('.dbmn-total-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.dbmn-total-card-title')).toHaveText('qty: totals');
    if (process.env.TOTAL_SHOT) await page.screenshot({ path: process.env.TOTAL_SHOT });
    await expect(card.locator('.dbmn-total-card-name')).toHaveText(['BL', 'C1', 'C2']);
    await expect(card.locator('.dbmn-total-card-value')).toHaveText(['127,450', '127,450', '126,881']);
    // Lined up on the right, one under another
    const rights = await card.locator('.dbmn-total-card-value').evaluateAll(vs => vs.map(v => Math.round(v.getBoundingClientRect().right)));
    expect(new Set(rights).size).toBe(1);
    // The one hovered in bold; the one not the same as BL's marked
    await expect(card.locator('.dbmn-total-card-value').nth(1)).toHaveClass(/is-this/);
    await expect(card.locator('.dbmn-total-card-value').nth(2)).toHaveClass(/is-different/);
    await expect(card.locator('.dbmn-total-card-value').nth(1)).not.toHaveClass(/is-different/);
    // Above the totals, in the window
    const [cardBox, cellBox] = await Promise.all([card.boundingBox(), c1.boundingBox()]);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(cellBox.y);
    // Away from the totals, it goes
    await page.locator('#t thead th').first().hover();
    await expect(card).toHaveCount(0);
    // A column on its own, or a group with only one total, keeps its plain tooltip
    await page.evaluate(() => { document.getElementById('t').totals = { 'qty|0': 5, 'desc|0': 'x' }; });
    await expect(page.locator('#t tfoot td.has-group-total')).toHaveCount(0);
    await expect(page.locator('#t tfoot td').nth(2)).toHaveAttribute('title', 'Total: 5');
});

test('the search box\'s fill is exactly its outlined box: no grey band above or below it', async ({ page }) => {
    await page.setContent(tablePage());
    const [box, fill] = await Promise.all([page.locator('#t .search-input').boundingBox(), page.locator('#t .search-input-mirror').boundingBox()]);
    expect(Math.abs(box.y - fill.y)).toBeLessThan(1);
    expect(Math.abs(box.height - fill.height)).toBeLessThan(1);
});

test('a column heading in a view\'s colour (compare-sub) with no view (a calculated column) is solid: rows scrolled under it never show through', async ({ page }) => {
    await page.setContent(tablePage().replace("{ id: 'notes', name: 'notes' }", "{ id: 'notes', name: 'notes', className: 'compare-sub' }"));
    await page.addStyleTag({ content: read('shared/compare.css') });
    // (drawn on a canvas: the colour it paints, and how opaque)
    const paint = () => page.locator('#t th[data-col="notes"]').evaluate(th => {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = getComputedStyle(th).backgroundColor;
        c.fillRect(0, 0, 1, 1);
        return Array.from(c.getImageData(0, 0, 1, 1).data);
    });
    // The page's own colour, opaque: not transparent
    expect(await paint()).toEqual([30, 30, 30, 255]);
    // In a view's colour, its tint as before
    await page.locator('#t th[data-col="notes"]').evaluate(th => th.style.setProperty('--compare-c', 'rgb(0, 120, 212)'));
    const tinted = await paint();
    expect(tinted[3]).toBe(255);
    expect(tinted[2]).toBeGreaterThan(60);
});

test('rows the page holds: sized again when the first rows come, never squeezed by a long value, and `shown` is what the search shows', async ({ page }) => {
    await page.setContent(tablePage());
    const widths = () => page.locator('#t thead th').evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)));
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.removeAttribute('style');
        t.rows = [];
        t.columns = [{ id: 'when', name: 'when' }, { id: 'level', name: 'level' }, { id: 'message', name: 'message' }];
    });
    await expect(page.locator('#t .dbmn-table-none')).toHaveText('No rows.');
    const empty = await widths();
    await page.evaluate(() => {
        document.getElementById('t').rows = Array.from({ length: 50 }, (_, i) => ({ when: '2026-11-19 14:03:22.' + String(100 + i), level: 'info', message: 'A long line of a log that would squeeze every other column if the table let it, number ' + i + ' of fifty, and then some more words after that' }));
    });
    const filled = await widths();
    // The time column grew to hold a time (it was only as wide as its heading), and is whole: not cut by the message
    expect(filled).not.toEqual(empty);
    const time = page.locator('#t .dbmn-table-body tr').first().locator('td').first();
    expect(await time.evaluate(td => td.scrollWidth <= td.clientWidth)).toBe(true);
    // (a phrase: two words apart would find a 7 anywhere in a row too)
    await page.locator('#t .search-input').fill('"number 7"');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 50 rows');
    expect(await page.evaluate(() => document.getElementById('t').shown.map(r => r.when))).toEqual(['2026-11-19 14:03:22.107']);
});

test('typing in the search box is never held up, however many rows: the search waits for a pause and stops at the next key', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const who = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli'];
        document.getElementById('t').rows = Array.from({ length: 60000 }, (_, i) => ({ order_no: 'SO-' + (10000 + i), customer: who[i % 3], qty: (i * 7) % 50, notes: i % 100 === 1 ? { reason: 'Awaiting stock' } : '' }));
        // The longest the page was busy in one go, as the browser reports it
        window.longest = 0;
        new PerformanceObserver(list => list.getEntries().forEach(e => { window.longest = Math.max(window.longest, e.duration); })).observe({ entryTypes: ['longtask'] });
    });
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('60,000 rows');
    await page.evaluate(() => { window.longest = 0; });
    const box = page.locator('#t .search-input');
    await box.click();
    // Typed and deleted at a typist's pace: each key is handled in a few milliseconds
    const took = [];
    for (const key of [...'@customer~kettle', 'Backspace', 'Backspace', 'l', 'e']) {
        took.push(await page.evaluate(k => {
            const input = document.querySelector('#t .search-input');
            const t0 = performance.now();
            input.value = k === 'Backspace' ? input.value.slice(0, -1) : input.value + k;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return performance.now() - t0;
        }, key));
        await page.waitForTimeout(40);
    }
    // (judged on the second-slowest key: one hiccup of a busy machine is not the box holding a key)
    expect([...took].sort((a, b) => b - a)[1]).toBeLessThan(16);
    // The box is coloured as it is typed, before any row is searched
    await expect(page.locator('#t .search-input-mirror')).toContainText('@customer~kettle');
    // After the pause the rows are searched, a little at a time
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('20,000 of 60,000 rows');
    await expect(page.locator('#t .dbmn-table-body tr').first()).toContainText('Kettle and Co');
    expect(await page.evaluate(() => window.longest)).toBeLessThan(120);
    // A key during a search drops it: only the last words are answered
    await page.evaluate(() => {
        const input = document.querySelector('#t .search-input');
        input.value = '@customer~mill'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(130);   // (its search has just started)
    await page.evaluate(() => {
        const input = document.querySelector('#t .search-input');
        input.value = '@notes.reason~stock'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('600 of 60,000 rows');

    // New rows given while the box holds a search (a live list) are searched the same way: no long wait
    await page.evaluate(() => {
        window.longest = 0;
        const t = document.getElementById('t');
        t.rows = t.rows.concat([{ order_no: 'SO-NEW', customer: 'Quay Street Bakery', qty: 1, notes: { reason: 'Awaiting stock' } }]);
    });
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('601 of 60,001 rows');
    expect(await page.evaluate(() => window.longest)).toBeLessThan(120);
});

/* ── Rows inside a row: a list of records, opened in its cell ── */

const nestedPage = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:900px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Orders" searchable removable></dbmn-table>
<script>
  const t = document.getElementById('t');
  window.fetched = [];
  t.rowKey = row => row.order_no;
  t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer' }, { id: 'lines', name: 'lines' },
      { id: 'packages', name: 'packages', nested: { count: row => row.packageCount, rows: row => new Promise(done => { window.fetched.push(row.order_no); window.release = () => done([{ package: 'PK-' + row.order_no, kind: 'Carton' }, { package: 'PK2-' + row.order_no, kind: 'Pallet' }].slice(0, row.packageCount)); }) } }];
  const who = ['Harbour Foods', 'Kettle and Co', 'Mill Lane Deli'];
  t.rows = Array.from({ length: 2000 }, (_, i) => ({ order_no: 'SO-' + (10000 + i), customer: who[i % 3], packageCount: i % 2 ? 2 : 0,
      lines: Array.from({ length: i === 4 ? 140 : 1 + (i % 3) }, (_, n) => ({ line: n + 1, item: 'IT-' + ((i * 7 + n * 3) % 50), qty: (i + n * 5) % 40 })) }));
</script></body></html>`;
const parent = (page, text) => page.locator('#t .dbmn-table-body > tr', { hasText: text }).first();

test('a list of records opens inside its cell: its own headings, two cells side by side, and the rows below move down', async ({ page }) => {
    await page.setContent(nestedPage());
    const row = parent(page, 'SO-10001');
    const lines = row.locator('td[data-col="lines"]');
    // Closed: a count and a chevron, the row as tall as any other. A row with no packages has no chevron there
    await expect(lines.locator('.dbmn-nest-toggle')).toHaveText('2 records');
    await expect(lines.locator('.dbmn-nest-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(parent(page, 'SO-10000').locator('td[data-col="packages"] .dbmn-nest-toggle')).toHaveCount(0);
    const below = () => parent(page, 'SO-10002').boundingBox().then(b => b.y);
    const before = await below();
    await lines.locator('.dbmn-nest-toggle').click();
    await expect(lines.locator('.dbmn-nest-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(lines.locator('.dbmn-nest-table thead .column-name')).toHaveText(['line', 'item', 'qty']);
    await expect(lines.locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    expect(await below()).toBeGreaterThan(before + 40);
    // The records are inside the lines cell, not across the row, and its column grew to show them whole
    const [cell, inner, records] = await Promise.all([lines.boundingBox(), lines.locator('.dbmn-nest-content').boundingBox(), lines.locator('.dbmn-nest-table').boundingBox()]);
    expect(inner.x).toBeGreaterThanOrEqual(cell.x);
    expect(inner.x + inner.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
    expect(records.x + records.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
    // The other list in the same row opens in its own cell beside it; its records are fetched on opening
    const packages = row.locator('td[data-col="packages"]');
    expect(await page.evaluate(() => window.fetched)).toEqual([]);
    await packages.locator('.dbmn-nest-toggle').click();
    // (the fetch is held until the test lets it go, so the waiting state is there to see)
    await expect(packages.locator('.dbmn-nest-note')).toHaveText('Fetching the records…');
    await page.evaluate(() => window.release());
    await expect(packages.locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    expect(await page.evaluate(() => window.fetched)).toEqual(['SO-10001']);
    await expect(lines.locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    // Its own headings sort its records, and x takes a column out of every row's records
    await lines.locator('.dbmn-nest-table th[data-sub="qty"] .col-sort-btn').click();
    await lines.locator('.dbmn-nest-table th[data-sub="qty"] .col-sort-btn').click();
    const qty = await lines.locator('.dbmn-nest-table tbody tr td:nth-child(3)').allTextContents();
    expect(Number(qty[0])).toBeGreaterThanOrEqual(Number(qty[1]));
    await lines.locator('.dbmn-nest-table th[data-sub="item"] .col-hide-btn').click();
    await expect(lines.locator('.dbmn-nest-table thead .column-name')).toHaveText(['line', 'qty']);
    // Closed again: the rows below are back where they were
    await lines.locator('.dbmn-nest-toggle').click();
    await packages.locator('.dbmn-nest-toggle').click();
    expect(await below()).toBe(before);
    // Many records: the first 100, and it says so
    await parent(page, 'SO-10004').locator('td[data-col="lines"] .dbmn-nest-toggle').click();
    await expect(parent(page, 'SO-10004').locator('.dbmn-nest-table tbody tr')).toHaveCount(100);
    await expect(parent(page, 'SO-10004').locator('.dbmn-nest-note')).toHaveText('The first 100 of 140 records');
});

test('what is open stays with its row through a sort and a search, and the rows are still drawn only where in view', async ({ page }) => {
    await page.setContent(nestedPage());
    await parent(page, 'SO-10001').locator('td[data-col="lines"] .dbmn-nest-toggle').click();
    await expect(parent(page, 'SO-10001').locator('.dbmn-nest-table')).toHaveCount(1);
    // Still windowed with a row open, and the far end is reached
    expect(await page.locator('#t .dbmn-table-body > tr').count()).toBeLessThan(120);
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = box.scrollHeight; });
    await expect(page.locator('#t .dbmn-table-body > tr').last()).toContainText('SO-11999');
    expect(await page.locator('#t .dbmn-table-body > tr').count()).toBeLessThan(120);
    // The bottom row sits at the bottom of the box: the open row's height is counted in the scroll
    const [last, box] = await Promise.all([page.locator('#t .dbmn-table-body > tr').last().boundingBox(), page.locator('#t .dbmn-table-scroll').boundingBox()]);
    expect(Math.abs((last.y + last.height) - (box.y + box.height))).toBeLessThan(24);
    // Sorted the other way round: SO-10001 is now second from last, and still the one that is open
    await page.locator('#t thead th').first().locator('.col-sort-btn').click();
    await page.locator('#t thead th').first().locator('.col-sort-btn').click();
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 0; });
    await expect(page.locator('#t .dbmn-table-body > tr').first()).toContainText('SO-11999');
    await expect(page.locator('#t .dbmn-table-body .dbmn-nest-table')).toHaveCount(0);
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = box.scrollHeight; });
    await expect(parent(page, 'SO-10001').locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    await expect(parent(page, 'SO-10000').locator('.dbmn-nest-table')).toHaveCount(0);
    // A search that finds the order shows it with all its records, still open
    await page.locator('#t .search-input').fill('SO-10001');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 2,000 rows');
    await expect(parent(page, 'SO-10001').locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
});

/* ── A search that knows what each column is ── */

test('the search box says what each column is, offers what fits, and says how the search is read', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        const day = n => { const d = new Date(Date.now() - n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
        t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'placed', name: 'placed' }, { id: 'urgent', name: 'urgent' }, { id: 'qty', name: 'qty' }, { id: 'lines', name: 'lines' }, { id: 'ref', name: 'ref', type: 'text' }];
        t.rows = Array.from({ length: 100 }, (_, i) => ({ order_no: 'SO-' + i, placed: day(i), urgent: i % 4 === 0, qty: i, ref: i, lines: [{ item: 'IT-' + i, qty: i * 2 }] }));
    });
    const box = page.locator('#t .search-input');
    const options = () => page.locator('#t .column-suggest-option').evaluateAll(els => els.map(e => e.textContent));
    await box.fill('@');
    // Told from the values; `ref` holds numbers but the screen said it is text
    expect(await options()).toEqual(expect.arrayContaining(['@order_notext', '@placeddate', '@urgentyes/no', '@qtynumber', '@linesnested', '@reftext']));
    // No type in any heading
    expect(await names(page)).toEqual(['order_no', 'placed', 'urgent', 'qty', 'lines', 'ref']);
    await box.fill('@placed');
    expect(await options()).toEqual(['>after', '<before', '=on, or between', '>=on or after', '<=on or before']);
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('@placed>');
    expect((await options())[2]).toBe('7din the last 7 days');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('@placed>7d');
    // Days 0 to 7 ago are after "7 days ago" by the clock (day 7's midnight is not): 7 rows
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('7 of 100 rows');
    await expect(page.locator('#t .dbmn-table-reads')).toContainText('Reading this as: placed (date) after ');
    // The dates on show are as they came
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(1)).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    await box.fill('@placed=today');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 100 rows');
    await box.fill('@placed=30d..7d');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('24 of 100 rows');
    await box.fill('@urgent=');
    expect(await options()).toEqual(['true', 'false']);
    await page.keyboard.press('Enter');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('25 of 100 rows');
    await expect(page.locator('#t .dbmn-table-reads')).toHaveText('Reading this as: urgent (yes/no) is yes');
    // A key inside nested data has its own kind
    await box.fill('@lines.');
    expect(await options()).toEqual(['@lines.itemtext', '@lines.qtynumber']);
    await box.fill('@lines.qty>190');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('4 of 100 rows');
    await box.fill('kettle');
    await expect(page.locator('#t .dbmn-table-reads')).toBeHidden();
    // A column the table does not have is red in the box (and underlined), and the line says so
    await box.fill('@plcaed>7d @urgent=true');
    const unknown = page.locator('#t .search-input-mirror .search-tok-col-unknown');
    await expect(unknown).toHaveText('@plcaed');
    const red = await unknown.evaluate(el => getComputedStyle(el).color);
    expect(red).not.toBe(await page.locator('#t .search-input-mirror .search-tok-col-name').evaluate(el => getComputedStyle(el).color));
    expect(await unknown.evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('underline');
    await expect(page.locator('#t .dbmn-table-reads')).toHaveText('Reading this as: no column called plcaed and urgent (yes/no) is yes');
    // Not while a name is still being typed
    await box.fill('@pla');
    await expect(page.locator('#t .search-input-mirror .search-tok-col-unknown')).toHaveCount(0);
});

/* ── A live list: following the newest rows ── */

test('follow: the newest rows stay in view; scrolled away, the rows on screen stay put and the new ones are counted', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.follows = [];
        t.addEventListener('dbmn-table-follow', e => window.follows.push(e.detail));
        t.setAttribute('follow', 'top');
        t.columns = [{ id: 'n', name: 'n' }, { id: 'line', name: 'line' }];
        window.lines = Array.from({ length: 500 }, (_, i) => ({ n: 500 - i, line: 'line ' + (500 - i) }));
        t.rows = window.lines;
        // Newer lines go in at the top
        window.add = k => { const top = window.lines[0].n; window.lines = Array.from({ length: k }, (_, i) => ({ n: top + k - i, line: 'line ' + (top + k - i) })).concat(window.lines); t.rows = window.lines; };
    });
    const first = () => page.locator('#t .dbmn-table-body tr').first().locator('td').first().textContent();
    const inView = () => page.evaluate(() => {
        const box = document.querySelector('#t .dbmn-table-scroll').getBoundingClientRect();
        const head = document.querySelector('#t thead th').getBoundingClientRect();   // (the headings stay at the top of the box)
        const row = Array.from(document.querySelectorAll('#t .dbmn-table-body tr')).find(r => r.getBoundingClientRect().top >= head.bottom - 1);
        return { n: row.cells[0].textContent, at: Math.round(row.getBoundingClientRect().top - box.top) };
    });
    expect(await page.evaluate(() => document.getElementById('t').following)).toBe(true);
    // At the top: new lines are followed
    await page.evaluate(() => window.add(3));
    expect(await first()).toBe('503');
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(s => s.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.follows.at(-1))).toEqual({ following: true, unseen: 0 });
    // Scrolled down: it stops following, and says so
    await page.locator('#t .dbmn-table-scroll').evaluate(s => { s.scrollTop = 2000; });
    await expect.poll(() => page.evaluate(() => window.follows.at(-1))).toEqual({ following: false, unseen: 0 });
    const before = await inView();
    // New lines now: the row being read stays exactly where it is, and they are counted
    await page.evaluate(() => window.add(5));
    await expect.poll(() => page.evaluate(() => window.follows.at(-1))).toEqual({ following: false, unseen: 5 });
    expect(await inView()).toEqual(before);
    await page.evaluate(() => window.add(2));
    expect(await page.evaluate(() => window.follows.at(-1))).toEqual({ following: false, unseen: 7 });
    expect(await inView()).toEqual(before);
    // Back at the top: following again, nothing unseen
    await page.locator('#t .dbmn-table-scroll').evaluate(s => { s.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => window.follows.at(-1))).toEqual({ following: true, unseen: 0 });
    expect(await first()).toBe('510');
    // Told to stop, it stays put though it is at the top; told to follow, it goes to the newest
    await page.evaluate(() => { document.getElementById('t').following = false; window.add(1); });
    expect(await page.evaluate(() => window.follows.at(-1))).toEqual({ following: false, unseen: 1 });
    await page.locator('#t .dbmn-table-scroll').evaluate(s => { s.scrollTop = 900; });
    await page.evaluate(() => { document.getElementById('t').following = true; });
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(s => s.scrollTop)).toBe(0);
    expect(await first()).toBe('511');
});

test('follow="bottom": the newest rows are at the bottom; without follow a table never moves by itself', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.follows = [];
        t.addEventListener('dbmn-table-follow', e => window.follows.push(e.detail));
        t.columns = [{ id: 'n', name: 'n' }];
        window.lines = Array.from({ length: 400 }, (_, i) => ({ n: i + 1 }));
        t.rows = window.lines;
        window.add = k => { const last = window.lines.at(-1).n; window.lines = window.lines.concat(Array.from({ length: k }, (_, i) => ({ n: last + i + 1 }))); t.rows = window.lines; };
    });
    const gap = () => page.locator('#t .dbmn-table-scroll').evaluate(s => Math.round(s.scrollHeight - s.scrollTop - s.clientHeight));
    // No follow: rows added, nothing moves, nothing is told
    await page.locator('#t .dbmn-table-scroll').evaluate(s => { s.scrollTop = 1500; });
    await page.evaluate(() => window.add(10));
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(s => s.scrollTop)).toBe(1500);
    expect(await page.evaluate(() => window.follows.length)).toBe(0);
    // Following the bottom: there from the moment it is asked, and after each lot of new rows
    await page.evaluate(() => { const t = document.getElementById('t'); t.setAttribute('follow', 'bottom'); t.following = true; });
    expect(await gap()).toBeLessThan(2);
    await page.evaluate(() => window.add(4));
    expect(await gap()).toBeLessThan(2);
    await expect(page.locator('#t .dbmn-table-body tr').last()).toHaveText('414');
    // Scrolled up: it stays where it is and counts
    await page.locator('#t .dbmn-table-scroll').evaluate(s => { s.scrollTop = 1000; });
    await expect.poll(() => page.evaluate(() => window.follows.at(-1).following)).toBe(false);
    await page.evaluate(() => window.add(6));
    expect(await page.locator('#t .dbmn-table-scroll').evaluate(s => s.scrollTop)).toBe(1000);
    expect(await page.evaluate(() => window.follows.at(-1))).toEqual({ following: false, unseen: 6 });
});

test('a narrow heading gives its whole width to the name: nothing is kept back for the icons it has hidden', async ({ page }) => {
    await page.setContent(tablePage());
    const head = page.locator('#t thead th').nth(1);   // customer
    const measure = () => head.evaluate(th => {
        const name = th.querySelector('.column-name');
        const css = getComputedStyle(th);
        // (the width of the name's text itself, however wide its box is)
        const textWidth = el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width; };
        return { narrow: th.classList.contains('col-narrow'), cut: name.scrollWidth - name.clientWidth, name: name.clientWidth,
            room: th.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), needs: Math.ceil(textWidth(name)) };
    });
    const wide = await measure();
    // Just wide enough for the name alone (and a pixel): the icons are gone and the name is whole
    await page.evaluate(w => { const t = document.getElementById('t'); t.layout = Object.assign(t.layout, { widths: { customer: w } }); }, wide.needs + 16 + 2);
    await expect(head).toHaveClass(/col-narrow/);
    const fits = await measure();
    expect(fits.cut).toBe(0);
    // Narrower still: the name is cut only by what is really missing, with no room left unused beside it
    await page.evaluate(w => { const t = document.getElementById('t'); t.layout = Object.assign(t.layout, { widths: { customer: w } }); }, wide.needs - 4);
    await expect.poll(async () => (await measure()).cut).toBeGreaterThan(0);
    const cut = await measure();
    expect(cut.room - cut.name).toBeLessThanOrEqual(1);
    // A sort that is on still shows its icon in a narrow heading
    await head.click({ button: 'right' });
    await page.locator('.dbmn-context-menu-item', { hasText: 'Sort A to Z' }).click();
    await expect(page.locator('#t thead th').nth(1).locator('.col-sort-btn.is-sorted')).toBeVisible();
});

test('busy: the search box\'s glass is the spinner while something is looking, and the search icon again after', async ({ page }) => {
    await page.setContent(tablePage());
    const glass = page.locator('#t .dbmn-table-glass');
    await expect(glass).not.toHaveClass(/is-busy/);
    await page.evaluate(() => { document.getElementById('t').busy = true; });
    await expect(glass).toHaveClass(/is-busy/);
    await expect(page.locator('#t')).toHaveAttribute('aria-busy', '');
    expect(await glass.locator('svg').evaluate(svg => getComputedStyle(svg).animationName)).toBe('dbmn-table-spin');
    await page.evaluate(() => { document.getElementById('t').busy = false; });
    await expect(glass).not.toHaveClass(/is-busy/);
    await expect(page.locator('#t')).not.toHaveAttribute('aria-busy', '');
});

test('busy by itself while a source\'s rows are on their way', async ({ page }) => {
    await page.setContent(sourcePage('label="Orders" searchable'));
    await expect(firstCell(page)).toHaveText('SO-10000');
    const glass = page.locator('#t .dbmn-table-glass');
    await expect(glass).not.toHaveClass(/is-busy/);
    await page.evaluate(() => { window.wait = 500; document.getElementById('t').reload(); });
    await expect(glass).toHaveClass(/is-busy/);
    await expect(glass).not.toHaveClass(/is-busy/, { timeout: 3000 });
});

/* ── Columns in groups (a field with BL and C1 under it), and pinned columns ── */

const groupedPage = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1100px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Compared" searchable removable></dbmn-table>
<script>
  const t = document.getElementById('t');
  window.told = [];
  t.addEventListener('dbmn-table-layout', e => window.told.push(e.detail));
  const qty = { id: 'qty', name: 'qty', head: th => { const pill = document.createElement('span'); pill.className = 'diff-pill'; pill.textContent = '3'; th.querySelector('.column-header-content').append(pill); } };
  const desc = { id: 'desc', name: 'description' };
  t.columns = [
      { id: 'sku', name: 'sku', pinned: true }, { id: 'status', name: 'Status', pinned: true },
      { id: 'qty|0', name: 'BL', group: qty, numbers: true }, { id: 'qty|1', name: 'C1', group: qty, numbers: true },
      { id: 'desc|0', name: 'BL', group: desc }, { id: 'desc|1', name: 'C1', group: desc }
  ];
  t.rows = Array.from({ length: 50 }, (_, i) => ({ sku: 'SKU-' + String(i).padStart(3, '0'), status: i % 5 ? 'Same' : 'DIFF', 'qty|0': (i * 7) % 40, 'qty|1': (i * 11) % 40, 'desc|0': 'Item ' + i, 'desc|1': 'Item ' + (i % 5 ? i : i + 1) }));
</script></body></html>`;

test('columns in groups: the group\'s name over its columns, each sorting on its own; pinned columns stay put', async ({ page }) => {
    await page.setContent(groupedPage());
    const rows = page.locator('#t thead tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('th')).toHaveText(['sku', 'Status', 'qty3', 'description']);
    await expect(rows.nth(1).locator('th .column-name')).toHaveText(['BL', 'C1', 'BL', 'C1']);
    expect(await rows.nth(0).locator('th[data-group="qty"]').evaluate(th => th.colSpan)).toBe(2);
    expect(await rows.nth(0).locator('th[data-col="sku"]').evaluate(th => th.rowSpan)).toBe(2);
    // The screen's own addition to a heading (a count of differences)
    await expect(rows.nth(0).locator('th[data-group="qty"] .diff-pill')).toHaveText('3');
    // Pinned: no remove, not movable
    await expect(page.locator('#t th[data-col="sku"] .col-hide-btn')).toHaveCount(0);
    await expect(page.locator('#t th[data-col="sku"] .column-name.is-movable')).toHaveCount(0);
    // The second row sits under the first while the rows scroll
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 400; });
    const [first, second] = await Promise.all([rows.nth(0).locator('th').nth(2).boundingBox(), rows.nth(1).locator('th').first().boundingBox()]);
    expect(Math.abs(second.y - (first.y + first.height))).toBeLessThan(2);
    // Each column under a group sorts on its own: C1 of qty, largest first
    const sub = page.locator('#t th[data-col="qty|1"]');
    await sub.locator('.col-sort-btn').click();
    await sub.locator('.col-sort-btn').click();
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 0; });
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(3)).toHaveText('39');
    expect(await page.evaluate(() => window.told.at(-1).layout.sort)).toEqual({ id: 'qty|1', dir: 'desc' });
    // The right edge of one column under a group resizes only it
    const widths = () => page.locator('#t th[data-col]').evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)));
    const before = await widths();
    const edge = await page.locator('#t th[data-col="desc|0"] .col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 70, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    const after = await widths();
    expect(after[4]).toBeGreaterThan(before[4] + 50);
    expect([after[0], after[1], after[2], after[3], after[5]]).toEqual([before[0], before[1], before[2], before[3], before[5]]);
});

test('while a column is held, the headings it cannot go to fade their words, never their fill (rows never show through)', async ({ page }) => {
    await page.setContent(groupedPage());
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-list-headerBackground', '#252526'));
    await page.locator('#t .dbmn-table-scroll').evaluate(box => { box.scrollTop = 300; });
    const grab = await page.locator('#t th[data-group="desc"]:not([data-col]) .column-name').boundingBox();
    await page.mouse.move(grab.x + 10, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x - 60, grab.y + grab.height / 2, { steps: 6 });
    const sku = page.locator('#t th[data-col="sku"]');
    await expect(sku).toHaveClass(/col-out/);
    const look = await sku.evaluate(th => ({ opacity: getComputedStyle(th).opacity, bg: getComputedStyle(th).backgroundColor, words: getComputedStyle(th.firstElementChild).opacity }));
    expect(look.opacity).toBe('1');
    expect(look.bg).toBe('rgb(37, 37, 38)');
    expect(Number(look.words)).toBeCloseTo(0.45, 2);
    await page.mouse.up();
});

test('a group moves and is removed as one, never past a pinned column', async ({ page }) => {
    await page.setContent(groupedPage());
    const ids = () => page.locator('#t th[data-col]').evaluateAll(ths => ths.map(th => th.dataset.col));
    // Move to start: first after the pinned columns, its columns together
    await page.locator('#t th[data-group="desc"]:not([data-col])').click({ button: 'right' });
    await page.locator('.dbmn-context-menu-item', { hasText: 'Move to start' }).click();
    expect(await ids()).toEqual(['sku', 'status', 'desc|0', 'desc|1', 'qty|0', 'qty|1']);
    expect(await page.evaluate(() => { const d = window.told.at(-1); return [d.change, d.id]; })).toEqual(['moved', 'desc']);
    // Dragged by its name: it moves past the other group, and the cells follow
    const from = await page.locator('#t th[data-group="desc"]:not([data-col]) .column-name').boundingBox();
    const to = await page.locator('#t th[data-group="qty"]:not([data-col])').boundingBox();
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width + 300, from.y + from.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(ids).toEqual(['sku', 'status', 'qty|0', 'qty|1', 'desc|0', 'desc|1']);
    await expect(page.locator('#t .dbmn-table-body tr').first().locator('td').nth(4)).toHaveText('Item 0');
    // While held, the group's name goes with its columns, and the group it passes slides aside, name and all
    const descHead = page.locator('#t th[data-group="desc"]:not([data-col])');
    const qtyHead = page.locator('#t th[data-group="qty"]:not([data-col])');
    const grab = await page.locator('#t th[data-col="desc|1"] .column-name').boundingBox();
    const qtyBox = await qtyHead.boundingBox();
    // (by one of its columns' names: that moves the whole group too)
    await page.mouse.move(grab.x + 5, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(qtyBox.x - 40, grab.y + grab.height / 2, { steps: 12 });
    await expect(descHead).toHaveClass(/col-lift/);
    await expect(page.locator('#t th[data-col="desc|0"]')).toHaveClass(/col-lift/);
    await expect(qtyHead).toHaveClass(/col-shift-right/);
    await expect(page.locator('#t th[data-col="qty|0"]')).toHaveClass(/col-shift-right/);
    const moving = await descHead.evaluate(th => new DOMMatrix(getComputedStyle(th).transform).m41);
    const under = await page.locator('#t th[data-col="desc|0"]').evaluate(th => new DOMMatrix(getComputedStyle(th).transform).m41);
    expect(moving).toBeLessThan(-50);
    expect(Math.abs(moving - under)).toBeLessThan(2);
    await page.mouse.up();
    await expect.poll(ids).toEqual(['sku', 'status', 'desc|0', 'desc|1', 'qty|0', 'qty|1']);
    expect(await page.evaluate(() => { const d = window.told.at(-1); return [d.change, d.id]; })).toEqual(['moved', 'desc']);
    // and back, by the other group's column
    const back = await page.locator('#t th[data-col="qty|0"] .column-name').boundingBox();
    const descBox = await descHead.boundingBox();
    await page.mouse.move(back.x + 5, back.y + back.height / 2);
    await page.mouse.down();
    await page.mouse.move(descBox.x - 300, back.y + back.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(ids).toEqual(['sku', 'status', 'qty|0', 'qty|1', 'desc|0', 'desc|1']);
    // A column under a group cannot be moved or removed on its own; the group's x removes both
    await page.locator('#t th[data-col="qty|0"]').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Move to start' })).toHaveCount(0);
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Remove' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('#t th[data-group="qty"]:not([data-col]) .col-hide-btn').click({ force: true });
    expect(await ids()).toEqual(['sku', 'status', 'desc|0', 'desc|1']);
    expect(await page.evaluate(() => { const d = window.told.at(-1); return [d.change, d.id, d.ids, d.layout.hidden]; })).toEqual(['removed', 'qty', ['qty|0', 'qty|1'], ['qty|0', 'qty|1']]);
    // A pinned column's menu sorts and fits, nothing more
    await page.locator('#t th[data-col="status"]').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Sort' }).first()).toBeVisible();
    await expect(page.locator('.dbmn-context-menu-item', { hasText: 'Move' })).toHaveCount(0);
});

test('a column of its own dragged past a group: the group slides aside with its name over it, and the column lands before it', async ({ page }) => {
    // (Query's Results: sku, the key, not pinned, dragged left over quantityOnHand's BL and C1)
    await page.setContent(groupedPage()
        .replace("{ id: 'sku', name: 'sku', pinned: true }, ", '')
        .replace("{ id: 'desc|1', name: 'C1', group: desc }", "{ id: 'desc|1', name: 'C1', group: desc }, { id: 'sku', name: 'sku' }"));
    const ids = () => page.locator('#t').evaluate(t => t.columns.map(c => c.id));
    expect(await ids()).toEqual(['status', 'qty|0', 'qty|1', 'desc|0', 'desc|1', 'sku']);
    const descHead = page.locator('#t th[data-group="desc"]:not([data-col])');
    const shift = loc => loc.evaluate(th => new DOMMatrix(getComputedStyle(th).transform).m41);
    const grab = await page.locator('#t th[data-col="sku"] .column-name').boundingBox();
    const d = await descHead.boundingBox();
    await page.mouse.move(grab.x + 5, grab.y + grab.height / 2);
    await page.mouse.down();
    // Short of the group's middle: its own heading (over both heading rows) goes with its cells; the group stays
    const sku = page.locator('#t th[data-col="sku"]');
    const skuCell = page.locator('#t .dbmn-table-body tr').first().locator('td').last();
    await page.mouse.move(d.x + d.width - 30, grab.y + grab.height / 2, { steps: 8 });
    await expect(sku).toHaveClass(/col-lift/);
    await expect.poll(() => shift(sku)).toBeLessThan(-40);
    expect(Math.abs(await shift(sku) - await shift(skuCell))).toBeLessThan(2);
    expect(Math.abs((await sku.boundingBox()).x - (await skuCell.boundingBox()).x)).toBeLessThan(2);
    await expect(descHead).not.toHaveClass(/col-shift/);
    await page.mouse.move(d.x + 10, grab.y + grab.height / 2, { steps: 8 });
    await expect(page.locator('#t th[data-col="desc|0"]')).toHaveClass(/col-shift-right/);
    await expect(descHead).toHaveClass(/col-shift-right/);
    // The name over the group has gone as far as its columns: still right over them
    await expect.poll(() => shift(page.locator('#t th[data-col="desc|0"]'))).toBeGreaterThan(20);
    // (once the slide, a sixth of a second, is done)
    await page.waitForTimeout(300);
    expect(Math.abs(await shift(descHead) - await shift(page.locator('#t th[data-col="desc|0"]')))).toBeLessThan(2);
    const [head, first, last] = await Promise.all([descHead.boundingBox(), page.locator('#t th[data-col="desc|0"]').boundingBox(), page.locator('#t th[data-col="desc|1"]').boundingBox()]);
    expect(Math.abs(head.x - first.x)).toBeLessThan(2);
    expect(Math.abs(head.x + head.width - (last.x + last.width))).toBeLessThan(2);
    await page.mouse.up();
    await expect.poll(ids).toEqual(['status', 'qty|0', 'qty|1', 'sku', 'desc|0', 'desc|1']);
    await expect(page.locator('#t thead tr').first().locator('th')).toHaveText(['Status', 'qty3', 'sku', 'description']);
});

test('a plain table\'s column is dragged to another place by its name; held against the end, it takes the end place, however wide', async ({ page }) => {
    await page.setContent(tablePage());
    const from = await page.locator('#t thead th').nth(3).locator('.column-name').boundingBox();
    const to = await page.locator('#t thead th').nth(0).boundingBox();
    await page.mouse.move(from.x + 8, from.y + from.height / 2);
    await page.mouse.down();
    // (far enough that its middle passes every other column's: it lands first)
    await page.mouse.move(to.x - 300, from.y + from.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => names(page)).toEqual(['notes', 'order_no', 'customer', 'qty']);
});

test('rows the screen acts on: a class on a row, a mark on a cell, and a click or right-click told with the row', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.clicked = []; window.menus = [];
        t.addEventListener('dbmn-table-row', e => window.clicked.push(e.detail.row.order_no));
        t.addEventListener('dbmn-table-row-menu', e => window.menus.push(e.detail.row.order_no));
        t.rowClass = row => (row.qty > 45 ? 'is-big' : '');
        t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'qty', name: 'qty', numbers: true, cell: (td, value) => { if (value > 45) td.classList.add('is-over'); } }, { id: 'notes', name: 'notes' }];
    });
    const first = page.locator('#t .dbmn-table-body tr').first();
    await expect(page.locator('#t .dbmn-table-body tr.is-big').first()).toBeVisible();
    await expect(page.locator('#t .dbmn-table-body tr.is-big td.is-over').first()).toBeVisible();
    await expect(page.locator('#t .dbmn-table-body tr:not(.is-big) td.is-over')).toHaveCount(0);
    await first.locator('td').first().click();
    await first.locator('td').first().click({ button: 'right' });
    expect(await page.evaluate(() => [window.clicked, window.menus])).toEqual([['SO-10000'], ['SO-10000']]);
    // A long value's own click opens it, and is not a click on the row
    await page.locator('#t .dbmn-table-body tr').nth(1).locator('td.cell-expandable').click();
    await expect(page.locator('.cell-detail, .dbmn-modal').first()).toBeVisible();
    expect(await page.evaluate(() => window.clicked)).toEqual(['SO-10000']);
});

test('a group\'s right edge sizes its columns evenly; a column can have no sort; headings drawn again run the screen\'s additions again', async ({ page }) => {
    await page.setContent(groupedPage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.count = 3;
        const qty = { id: 'qty', name: 'qty', head: th => { const pill = document.createElement('span'); pill.className = 'diff-pill'; pill.textContent = String(window.count); th.querySelector('.column-header-content').append(pill); } };
        t.columns = t.columns.map(c => (c.group && c.group.id === 'qty' ? { ...c, group: qty } : c.id === 'status' ? { ...c, sortable: false } : c));
    });
    // Status is filtered by the screen, not sorted: no sort icon, and its menu offers no sort
    await expect(page.locator('#t th[data-col="status"] .col-sort-btn')).toHaveCount(0);
    await expect(page.locator('#t th[data-col="sku"] .col-sort-btn')).toHaveCount(1);
    await page.locator('#t th[data-col="status"] .column-name').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu')).toBeVisible();
    await expect(page.locator('.dbmn-context-menu')).not.toContainText(/Sort/);
    await page.keyboard.press('Escape');
    // The screen's count in a heading changed: the headings are drawn again with it, nothing else moves
    await expect(page.locator('#t th[data-group="qty"] .diff-pill')).toHaveText('3');
    await page.evaluate(() => { window.count = 7; document.getElementById('t').redrawHeads(); });
    await expect(page.locator('#t th[data-group="qty"] .diff-pill')).toHaveText('7');
    // A group's right edge: its columns share the width evenly; the others stay as they are
    const widths = () => page.locator('#t th[data-col]').evaluateAll(ths => ths.map(th => Math.round(th.getBoundingClientRect().width)));
    const before = await widths();
    const edge = await page.locator('#t th[data-group="qty"]:not([data-col]) .col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 100, edge.y + edge.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await widths();
    expect(after[2]).toBeGreaterThan(before[2] + 30);
    expect(Math.abs(after[2] - after[3])).toBeLessThan(2);
    expect([after[0], after[1], after[4], after[5]]).toEqual([before[0], before[1], before[4], before[5]]);
    const told = await page.evaluate(() => window.told.filter(d => d.change === 'resized').map(d => d.id));
    expect(told).toEqual(['qty|0', 'qty|1']);
});

test('only a long (over 100 characters), many-line or structured value opens in full; one merely cut off by its column is not a link', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer', cell: (td, _v, row) => { td.dataset.title = `${row.order_no}: customer`; } }, { id: 'note', name: 'note' }];
        const long = 'x'.repeat(101);
        t.rows = [
            { order_no: 'SO-1', customer: 'Harbour Foods', note: 'y'.repeat(100) },
            { order_no: 'SO-2', customer: long, note: 'first line\nsecond line' },
            { order_no: 'SO-3', customer: 'Kettle and Co', note: '{"a":1}' }
        ];
        t.layout = { widths: { customer: 48 } };
    });
    const cell = (r, c) => page.locator('#t .dbmn-table-body tr').nth(r).locator('td').nth(c);
    // Cut off by its column, and 100 characters exactly: plain cells, whole on hover
    await expect(cell(0, 1)).toHaveText('Harbour Foods');
    await cell(0, 1).hover();
    await expect(cell(0, 1)).not.toHaveClass(/cell-expandable/);
    await expect(cell(0, 1).locator('.cell-expand-icon')).toHaveCount(0);
    await expect(cell(0, 2)).not.toHaveClass(/cell-expandable/);
    // Over 100, more than one line, JSON: links that open in full
    await expect(cell(1, 1)).toHaveClass(/cell-expandable/);
    await expect(cell(1, 2)).toHaveClass(/cell-expandable/);
    await expect(cell(2, 2)).toHaveClass(/cell-expandable/);
    // A cell may name itself for the window
    await cell(1, 1).click();
    await expect(page.locator('.dbmn-modal .cell-detail-pre')).toHaveText('x'.repeat(101));
    await expect(page.locator('.dbmn-modal .dbmn-modal-title')).toContainText('SO-2: customer');
    await page.keyboard.press('Escape');
});

test('a table in a dialog is measured at full size while the dialog zooms in (nothing cut short), and fills the dialog maximised', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.setContent(tablePage());
    await page.evaluate(() => {
        // (a view's rows dialog: rows from the host, the first page in while the dialog is still zooming in)
        const body = document.createElement('div');
        const t = document.createElement('dbmn-table');
        t.id = 'inDialog';
        t.setAttribute('searchable', '');
        t.style.display = 'block';
        t.style.height = '420px';
        body.append(t);
        const ids = ['id', 'userId', 'gtin', 'sku', 'description'];
        t.columns = ids.map(id => ({ id, name: id }));
        const rows = Array.from({ length: 300 }, (_, i) => ({ id: (4096 + i).toString(16) + '9d07a-de7a-40fa-9b0d-f3be76314abc', userId: '1d9d12be-8288-49ba-a258-2835f78a6a36', gtin: '000123456002' + (i % 100), sku: 'SKU-WOOF-020-0' + (4900 + i), description: 'Oatmeal and Honey Dog Shampoo' }));
        t.source = { page: (start, count) => Promise.resolve({ rows: rows.slice(start, start + count), total: rows.length }) };
        window.DbmnModal.show({ title: 'inventory', body, size: 'lg', maximisable: true, actions: [{ id: 'close', label: 'Close' }] });
    });
    const cells = page.locator('#inDialog .dbmn-table-body tr').first().locator('td');
    await expect(cells.first()).toHaveText('10009d07a-de7a-40fa-9b0d-f3be76314abc');
    await page.waitForTimeout(400);   // (the zoom is over)
    expect(await cells.evaluateAll(tds => tds.filter(td => td.scrollWidth > td.clientWidth + 1).map(td => td.textContent))).toEqual([]);
    // Maximised, the table takes the room the dialog has
    const before = await page.locator('#inDialog').evaluate(t => t.getBoundingClientRect().height);
    await page.locator('.dbmn-modal-max').click();
    const dialog = await page.locator('.dbmn-modal').evaluate(m => m.getBoundingClientRect().height);
    await expect.poll(() => page.locator('#inDialog').evaluate(t => t.getBoundingClientRect().height)).toBeGreaterThan(dialog * 0.7);
    expect(before).toBeLessThan(dialog * 0.7);
    await expect(page.locator('#inDialog .dbmn-table-body tr:not(.dbmn-table-waiting)')).not.toHaveCount(0);
});

test('the screen\'s own controls sit beside a cell\'s records ("Set as Row"): their clicks are the screen\'s, the toggle still opens them', async ({ page }) => {
    await page.setContent(nestedPage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.asked = []; window.clicked = [];
        t.addEventListener('dbmn-table-row', e => window.clicked.push(e.detail.row.order_no));
        t.columns = t.columns.map(c => (c.id !== 'lines' ? c : { ...c, nested: { controls: row => {
            const b = document.createElement('button');
            b.className = 'set-as-root-btn';
            b.textContent = 'Set as Row';
            b.addEventListener('click', () => window.asked.push(row.order_no));
            return b;
        } } }));
    });
    const lines = parent(page, 'SO-10001').locator('td[data-col="lines"]');
    await expect(lines.locator('.dbmn-nest-controls .dbmn-nest-toggle')).toHaveText('2 records');
    await lines.locator('.set-as-root-btn').click();
    expect(await page.evaluate(() => [window.asked, window.clicked])).toEqual([['SO-10001'], []]);
    await lines.locator('.dbmn-nest-toggle').click();
    await expect(lines.locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    await expect(lines.locator('.set-as-root-btn')).toHaveCount(1);
});

test('a short value that is structured (JSON text) opens in full too; short plain text does not', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.rows = [{ order_no: 'SO-1', customer: 'Harbour Foods', qty: 1, notes: '{"hold":true}' }, { order_no: 'SO-2', customer: 'Kettle and Co', qty: 2, notes: 'ok' }];
    });
    const notes = n => page.locator('#t .dbmn-table-body tr').nth(n).locator('td').nth(3);
    await expect(notes(0)).toHaveClass(/cell-expandable/);
    await expect(notes(0).locator('.cell-expand-icon')).toHaveCount(1);
    await expect(notes(1)).not.toHaveClass(/cell-expandable/);
});

test('a column that stays (removable: false) has no x and no Remove; the others still go', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'reason', name: 'Reason', removable: false }, { id: 'qty', name: 'qty', numbers: true }];
    });
    await expect(page.locator('#t th[data-col="reason"] .col-hide-btn')).toHaveCount(0);
    await expect(page.locator('#t th[data-col="qty"] .col-hide-btn')).toHaveCount(1);
    await page.locator('#t th[data-col="reason"] .column-name').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu')).toBeVisible();
    await expect(page.locator('.dbmn-context-menu')).not.toContainText('Remove');
});

test('a column removed from the records is told as such, kept in the layout, and taken back from a saved one', async ({ page }) => {
    await page.setContent(nestedPage());
    await page.evaluate(() => { window.told = []; document.getElementById('t').addEventListener('dbmn-table-layout', e => window.told.push(e.detail)); });
    const lines = parent(page, 'SO-10001').locator('td[data-col="lines"]');
    await lines.locator('.dbmn-nest-toggle').click();
    await expect(lines.locator('.dbmn-nest-table thead .column-name')).toHaveText(['line', 'item', 'qty']);
    await lines.locator('.dbmn-nest-table th[data-sub="item"] .col-hide-btn').click({ force: true });
    await expect(lines.locator('.dbmn-nest-table thead .column-name')).toHaveText(['line', 'qty']);
    const told = await page.evaluate(() => window.told.at(-1));
    expect([told.change, told.id, told.records, told.key, told.layout.recordHidden]).toEqual(['removed', 'lines.item', 'lines', 'item', ['lines.item']]);
    // A screen's saved layout brings it back as it was left: drawn again, the column stays removed
    await page.evaluate(() => {
        const t = document.getElementById('t');
        const columns = t.columns;
        t.columns = columns;
        t.layout = { recordHidden: ['lines.qty'] };
    });
    const again = parent(page, 'SO-10001').locator('td[data-col="lines"]');
    if (!(await again.locator('.dbmn-nest-table').count())) await again.locator('.dbmn-nest-toggle').click();
    await expect(again.locator('.dbmn-nest-table thead .column-name')).toHaveText(['line', 'item']);
});

test('within: a column moves only among its own object\'s columns, and past an object beside it as one', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        window.told = [];
        t.addEventListener('dbmn-table-layout', e => window.told.push(e.detail));
        t.columns = [
            { id: 'sku', name: 'sku', within: ['data'] }, { id: 'name', name: 'name', within: ['data'] },
            { id: 'zone', name: 'zone', within: ['data', 'location'] }, { id: 'bin', name: 'bin', within: ['data', 'location'] },
            { id: 'qty', name: 'qty', within: ['data'], numbers: true }
        ];
        t.rows = [{ sku: 'DOG-1', name: 'Rope', zone: 'A', bin: 'A-01', qty: 4 }];
    });
    const names = () => page.locator('#t thead th .column-name').allTextContents();
    // Move to end, among its own: zone goes after bin, not after qty
    await page.locator('#t th[data-col="zone"] .column-name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu').getByText('Move to end').click();
    await expect.poll(names).toEqual(['sku', 'name', 'bin', 'zone', 'qty']);
    expect(await page.evaluate(() => window.told.at(-1))).toMatchObject({ change: 'moved', id: 'zone', to: 3 });
    // name to the end of its own: past location's two columns (together) and qty
    await page.locator('#t th[data-col="name"] .column-name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu').getByText('Move to end').click();
    await expect.poll(names).toEqual(['sku', 'bin', 'zone', 'qty', 'name']);
    // A drag held far outside its own: it stays among them, and the table says so
    await page.evaluate(() => { window.outside = []; document.getElementById('t').addEventListener('dbmn-table-outside', e => window.outside.push(e.detail.id)); });
    // (to the right: zone held far past qty and name, the end of the page's room)
    const grab = await page.locator('#t th[data-col="bin"] .column-name').boundingBox();
    await page.mouse.move(grab.x + 6, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x + 26, grab.y + grab.height / 2, { steps: 4 });
    await page.mouse.move(grab.x + 900, grab.y + grab.height / 2, { steps: 8 });
    await page.mouse.up();
    // It took the last place among its own (after zone), not past qty or name
    await expect.poll(names).toEqual(['sku', 'zone', 'bin', 'qty', 'name']);
    expect(await page.evaluate(() => window.outside)).toEqual(['bin']);
});

test('records full width: the switch beside "N records" opens them in a row of their own under the row, for the whole column, and back', async ({ page }) => {
    await page.setContent(nestedPage());
    await page.evaluate(() => { window.told = []; document.getElementById('t').addEventListener('dbmn-table-layout', e => window.told.push(e.detail)); });
    const row = parent(page, 'SO-10001');
    const lines = row.locator('td[data-col="lines"]');
    await lines.locator('.dbmn-nest-toggle').click();
    await expect(lines.locator('.dbmn-nest-table')).toHaveCount(1);
    const span = lines.locator('.dbmn-nest-span');
    await expect(span).toHaveAttribute('aria-pressed', 'false');
    await expect(span).toHaveAttribute('title', 'Show the records full width, under the row');
    await span.click();
    // In a row of its own, under the order, across every column; the order's cell keeps only its line
    const wide = page.locator('#t .dbmn-table-body > tr.dbmn-nest-wide-row');
    await expect(wide).toHaveCount(1);
    expect(await wide.locator('> td').evaluate(td => td.colSpan)).toBe(4);
    await expect(wide.locator('.dbmn-nest-wide-name')).toHaveText('lines · 2 records');
    await expect(wide.locator('.dbmn-nest-table tbody tr')).toHaveCount(2);
    await expect(parent(page, 'SO-10001').locator('td[data-col="lines"] .dbmn-nest-table')).toHaveCount(0);
    expect(await page.evaluate(() => window.told.at(-1))).toMatchObject({ change: 'records-wide', id: 'lines', wide: true, layout: { recordsWide: ['lines'] } });
    // It sits under its row, before the next one
    const [above, under, next] = await Promise.all([parent(page, 'SO-10001'), wide, parent(page, 'SO-10002')].map(l => l.boundingBox()));
    expect(under.y).toBeGreaterThanOrEqual(above.y + above.height - 1);
    expect(next.y).toBeGreaterThanOrEqual(under.y + under.height - 1);
    // The whole column: another order's lines open full width too
    await parent(page, 'SO-10002').locator('td[data-col="lines"] .dbmn-nest-toggle').click();
    await expect(wide).toHaveCount(2);
    // Its records' headings still sort, and a click on the order's row is still the row's
    await wide.first().locator('th[data-sub="qty"] .col-sort-btn').click();
    await expect(wide.first().locator('th[data-sub="qty"]')).toHaveCount(1);
    // Back into the cell: the same switch
    await parent(page, 'SO-10001').locator('td[data-col="lines"] .dbmn-nest-span').click();
    await expect(wide).toHaveCount(0);
    await expect(parent(page, 'SO-10001').locator('td[data-col="lines"] .dbmn-nest-table')).toHaveCount(1);
    // A saved layout brings it back full width
    await page.evaluate(() => { const t = document.getElementById('t'); const c = t.columns; t.columns = c; t.layout = { recordsWide: ['lines'] }; });
    await expect(page.locator('#t .dbmn-table-body > tr.dbmn-nest-wide-row')).toHaveCount(2);
});

/* ── Editing (the editable attribute) ── */

const editPage = () => tablePage().replace('<dbmn-table id="t" label="Orders" searchable removable></dbmn-table>', '<dbmn-table id="t" label="Orders" editable></dbmn-table>')
    .replace("t.rows = Array.from({ length: 3000 }", "window.edits = []; t.addEventListener('dbmn-table-edit', e => window.edits.push({ kind: e.detail.kind, left: e.detail.left, changes: e.detail.changes.map(c => [c.id, c.old, c.value]) })); t.rows = Array.from({ length: 3000 }");
const td = (p, r, c) => p.locator('#t .dbmn-table-body > tr').nth(r).locator('td').nth(c);

// What a cell shows: what is typed in its box while it is open, else its text
const value = (p, r, c) => td(p, r, c).evaluate(el => { const box = el.querySelector('input.dbmn-cell-input'); return box ? box.value : el.textContent; });

test('editable (typing mode): one click puts the caret in a cell; Enter keeps it and the cell below opens; Esc gives it up and holds the cell', async ({ page }) => {
    await page.setContent(editPage());
    // Every cell a box to type in, with a text cursor
    expect(await td(page, 0, 1).evaluate(el => getComputedStyle(el).cursor)).toBe('text');
    await td(page, 1, 2).click();
    const box = td(page, 1, 2).locator('input.dbmn-cell-input');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('7');
    await box.fill('41');
    await page.keyboard.press('Enter');
    await expect(td(page, 1, 2)).toHaveText('41');
    // The cell below is open, its text selected: typing replaces it
    await expect(td(page, 2, 2).locator('input.dbmn-cell-input')).toBeFocused();
    expect(await page.evaluate(() => [window.edits, typeof document.getElementById('t').rows[1].qty])).toEqual([[{ kind: 'edit', left: 0, changes: [['qty', 7, 41]] }], 'number']);
    await page.keyboard.type('Z');
    await expect(td(page, 2, 2).locator('input')).toHaveValue('Z');
    await page.keyboard.press('Escape');
    await expect(td(page, 2, 2)).toHaveText('14');
    await expect(td(page, 2, 2)).toHaveClass(/dbmn-cell-active/);
    expect(await page.evaluate(() => window.edits.length)).toBe(1);
    // Held, the arrow keys move and the cell arrived at opens; Up and Down move a row from an open one
    await page.keyboard.press('ArrowLeft');
    await expect(td(page, 2, 1).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(td(page, 3, 1).locator('input.dbmn-cell-input')).toBeFocused();
    // Tab across, and on to the next row's first cell from the last
    await td(page, 0, 3).click();
    await page.keyboard.press('Tab');
    await expect(td(page, 1, 0).locator('input.dbmn-cell-input')).toBeFocused();
});

test('editable (typing mode): the open cell stays open, with what is typed, while the rows are drawn again', async ({ page }) => {
    await page.setContent(editPage());
    await td(page, 0, 1).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Ltd');
    await page.evaluate(() => { const t = document.getElementById('t'); t.rows = t.rows; });
    await expect(td(page, 0, 1).locator('input.dbmn-cell-input')).toBeFocused();
    await expect(td(page, 0, 1).locator('input')).toHaveValue('Harbour Foods Ltd');
    await page.keyboard.press('Enter');
    await expect(td(page, 0, 1)).toHaveText('Harbour Foods Ltd');
});

test('editable: a block pastes from the open cell, as one step that undoes and does again; copy takes the held cell', async ({ page }) => {
    await page.setContent(editPage());
    await td(page, 0, 1).click();
    // A spreadsheet's block: two rows, two cells each, and one cell past the last column (nowhere to go)
    await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'Acme\t5\r\nBeta\t6\tspare\r\n');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => value(page, 0, 1)).toBe('Acme');
    await expect(td(page, 1, 2)).toHaveText('6');
    expect(await page.evaluate(() => window.edits.at(-1))).toEqual({ kind: 'paste', left: 0, changes: [['customer', 'Harbour Foods', 'Acme'], ['qty', 0, 5], ['customer', 'Kettle and Co', 'Beta'], ['qty', 7, 6], ['notes', { reason: 'Awaiting stock' }, 'spare']] });
    // (the open cell has nothing typed in it: Ctrl+Z is the table's)
    await page.keyboard.press('Control+z');
    await expect.poll(() => value(page, 0, 1)).toBe('Harbour Foods');
    await expect(td(page, 1, 2)).toHaveText('7');
    await page.keyboard.press('Control+y');
    await expect.poll(() => value(page, 0, 1)).toBe('Acme');
    await page.keyboard.press('Escape');
    const copied = await page.evaluate(() => {
        const data = new DataTransfer();
        document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/plain');
    });
    expect(copied).toBe('Acme');
});

test('editable: the screen can refuse a change or a column; a list of records is not edited', async ({ page }) => {
    await page.setContent(editPage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.columns = [{ id: 'order_no', name: 'order_no', editable: false }, { id: 'customer', name: 'customer' }, { id: 'qty', name: 'qty', numbers: true }];
        t.addEventListener('dbmn-table-edit', e => { if (e.detail.changes.some(c => c.id === 'qty' && Number(c.value) < 0)) e.preventDefault(); });
    });
    await td(page, 0, 0).click();
    await expect(td(page, 0, 0).locator('input')).toHaveCount(0);
    await expect(td(page, 0, 0)).toHaveClass(/dbmn-cell-readonly/);
    await td(page, 0, 2).click();
    await td(page, 0, 2).locator('input').fill('-3');
    await page.keyboard.press('Enter');
    await expect(td(page, 0, 2)).toHaveText('0');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await expect(td(page, 0, 2)).toHaveText('');
});

/* ── A table people keep (a lookup table): rows added and deleted, columns edited, a key ── */

const lookupPage = () => tablePage()
    .replace('<dbmn-table id="t" label="Orders" searchable removable></dbmn-table>', '<dbmn-table id="t" label="Regions" editable add-row row-delete edit-columns></dbmn-table>')
    .replace(/t\.columns = \[[^\n]*\n/, "window.told = []; ['dbmn-table-rows', 'dbmn-table-columns'].forEach(type => t.addEventListener(type, e => window.told.push([type.replace('dbmn-table-', ''), e.detail.kind, e.detail.name || null]))); t.columns = [{ id: 'code', name: 'code', key: true }, { id: 'name', name: 'name' }, { id: 'region', name: 'region' }];\n")
    .replace(/  const who = [^\n]*\n  t\.rows = [^\n]*\n/, "  t.rows = [{ code: 'VIC', name: 'Victoria', region: 'South' }, { code: 'NSW', name: 'New South Wales', region: 'East' }, { code: 'VIC', name: 'Vic again', region: 'South' }, { code: '', name: 'No code', region: 'North' }];\n");
const rowsNow = page => page.evaluate(() => document.getElementById('t').rows.map(r => ({ ...r })));

test('a key column: a key on its heading; a value in two rows, or none, is amber with why; fixed, it clears', async ({ page }) => {
    await page.setContent(lookupPage());
    await expect(page.locator('#t thead th.is-key .dbmn-key-mark svg')).toHaveCount(1);
    await expect(td(page, 0, 1)).toHaveClass(/dbmn-cell-key-duplicate/);
    await expect(td(page, 0, 1)).toHaveAttribute('title', 'code VIC is in 2 rows: a key is in one row only');
    await expect(td(page, 1, 1)).not.toHaveClass(/dbmn-cell-key/);
    await expect(td(page, 3, 1)).toHaveClass(/dbmn-cell-key-missing/);
    expect(await page.evaluate(() => document.getElementById('t').keyProblems.map(p => [p.value, p.kind]))).toEqual([['VIC', 'duplicate'], ['VIC', 'duplicate'], ['', 'missing']]);
    await td(page, 2, 1).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('TAS');
    await page.keyboard.press('Enter');
    await expect(td(page, 0, 1)).not.toHaveClass(/dbmn-cell-key/);
    await expect(td(page, 2, 1)).not.toHaveClass(/dbmn-cell-key/);
});

test('add-row and row-delete: a row added opens for typing; a row\'s bin deletes it; Ctrl+Z undoes either', async ({ page }) => {
    await page.setContent(lookupPage());
    await expect(td(page, 0, 0)).toHaveText('1');
    await page.locator('#t .dbmn-table-add-row').click();
    expect(await rowsNow(page)).toHaveLength(5);
    await expect(td(page, 4, 1).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.type('QLD');
    // (kept by moving up: Enter on the last row would start another row, as Tab past its end does)
    await page.keyboard.press('ArrowUp');
    expect((await rowsNow(page))[4]).toEqual({ code: 'QLD', name: '', region: '' });
    // The bin on row 2 (its number turns into it on hover)
    await page.locator('#t .dbmn-table-body tr').nth(1).hover();
    await td(page, 1, 0).locator('.dbmn-row-delete').click();
    expect((await rowsNow(page)).map(r => r.code)).toEqual(['VIC', 'VIC', '', 'QLD']);
    await expect(page.locator('#t .dbmn-table-body .dbmn-row-num')).toHaveText(['1', '2', '3', '4']);
    // Back in the table, Ctrl+Z: the row comes back where it was; again: QLD unsaid; again: the added row goes
    await td(page, 0, 2).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    expect((await rowsNow(page)).map(r => r.code)).toEqual(['VIC', 'NSW', 'VIC', '', 'QLD']);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect((await rowsNow(page)).map(r => r.code)).toEqual(['VIC', 'NSW', 'VIC', '']);
    expect(await page.evaluate(() => window.told.map(t => t.slice(0, 2)))).toEqual([['rows', 'add'], ['rows', 'delete'], ['rows', 'add'], ['rows', 'delete']]);
});

test('edit-columns: a heading\'s menu renames a column, adds one after it, and deletes one with its values', async ({ page }) => {
    await page.setContent(lookupPage());
    const head = name => page.locator('#t thead th', { has: page.locator('.column-name', { hasText: new RegExp(`^${name}$`) }) });
    const answer = async (value, action) => {
        if (value !== null) await page.locator('#dbmn-modal-field-name').fill(value);
        await page.locator(`[data-action-id="${action}"]`).click();
        await expect(page.locator('.dbmn-modal-title')).toHaveCount(0);
    };
    await head('region').click({ button: 'right' });
    await expect(page.locator('.dbmn-context-menu-item .dbmn-context-menu-label')).toContainText(['Rename column…', 'Add a column after', 'Delete column']);
    await page.locator('.dbmn-context-menu-item[data-action="extra:rename"]').click();
    await answer('area', 'ok');
    await expect(page.locator('#t thead .column-name')).toHaveText(['#', 'code', 'name', 'area']);

    await head('name').click({ button: 'right' });
    await page.locator('.dbmn-context-menu-item[data-action="extra:add"]').click();
    await answer('notes', 'ok');
    await expect(page.locator('#t thead .column-name')).toHaveText(['#', 'code', 'name', 'notes', 'area']);
    // Typing into it straight away
    await expect(td(page, 0, 3).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.type('Head office');
    await page.keyboard.press('Enter');
    expect((await rowsNow(page))[0].notes).toBe('Head office');

    await head('notes').click({ button: 'right' });
    await page.locator('.dbmn-context-menu-item[data-action="extra:delete"]').click();
    await answer(null, 'confirm');
    await expect(page.locator('#t thead .column-name')).toHaveText(['#', 'code', 'name', 'area']);
    expect((await rowsNow(page))[0]).toEqual({ code: 'VIC', name: 'Victoria', region: 'South' });
    expect(await page.evaluate(() => window.told.map(t => t.slice(0, 3)))).toEqual([['columns', 'rename', 'area'], ['columns', 'add', 'notes'], ['columns', 'delete', 'notes']]);
});

/* ── Picking rows (`selectable`) ── */

const pickPage = single => tablePage()
    .replace('<dbmn-table id="t" label="Orders" searchable removable></dbmn-table>', `<dbmn-table id="t" label="Orders" searchable ${single ? 'selectable="single"' : 'selectable'}></dbmn-table>`)
    .replace("t.rows = Array.from({ length: 3000 }", "window.picks = []; window.opens = []; t.addEventListener('dbmn-table-select', e => window.picks.push(e.detail.selected.map(r => r.order_no))); t.addEventListener('dbmn-table-row-open', e => window.opens.push(e.detail.row.order_no)); t.rows = Array.from({ length: 3000 }");
const picked = page => page.evaluate(() => document.getElementById('t').selected.map(r => r.order_no));

test('selectable: a click picks a row and again unpicks it; Shift-click picks a run; the heading\'s box picks every row shown', async ({ page }) => {
    await page.setContent(pickPage(false));
    const rowsAt = n => page.locator('#t .dbmn-table-body tr').nth(n);
    await rowsAt(1).click();
    await rowsAt(3).locator('input.dbmn-pick-box').click();
    expect(await picked(page)).toEqual(['SO-10001', 'SO-10003']);
    await expect(rowsAt(1)).toHaveClass(/is-picked/);
    await expect(rowsAt(1).locator('input.dbmn-pick-box')).toBeChecked();
    await rowsAt(1).click();
    expect(await picked(page)).toEqual(['SO-10003']);
    // Shift-click: every row from the last one clicked (row 1) to this one
    await rowsAt(6).click({ modifiers: ['Shift'] });
    expect(await picked(page)).toEqual(['SO-10001', 'SO-10002', 'SO-10003', 'SO-10004', 'SO-10005', 'SO-10006']);
    // The heading's box: every row the search shows (Kettle and Co: 1,000 of them), then none of them
    await page.locator('#t .search-input').fill('Kettle');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    await page.locator('#t thead input.dbmn-pick-all').click();
    expect((await picked(page)).length).toBe(1000 + 4);   // (the four picked that aren't Kettle's stay)
    await page.locator('#t thead input.dbmn-pick-all').click();
    expect(await picked(page)).toEqual(['SO-10002', 'SO-10003', 'SO-10005', 'SO-10006']);
    expect(await page.evaluate(() => window.picks.length)).toBe(6);
    // A double-click: the screen's Open. (Picking changes the row in place: drawn again, the second
    // click would land on a new row and the browser would never see a double-click)
    await page.locator('#t .search-input').fill('');
    await page.evaluate(() => { window.firstRow = document.querySelectorAll('#t .dbmn-table-body tr')[2]; });
    await rowsAt(2).click();
    expect(await page.evaluate(() => document.querySelectorAll('#t .dbmn-table-body tr')[2] === window.firstRow)).toBe(true);
    await rowsAt(2).click();
    await rowsAt(2).dblclick();
    expect(await page.evaluate(() => window.opens)).toEqual(['SO-10002']);
    // The table's own column is not the screen's
    expect(await page.evaluate(() => document.getElementById('t').columns.map(c => c.id))).toEqual(['order_no', 'customer', 'qty', 'notes']);
});

test('selectable="single": one row at a time, round boxes, no box in the heading; selected can be set', async ({ page }) => {
    await page.setContent(pickPage(true));
    const rowsAt = n => page.locator('#t .dbmn-table-body tr').nth(n);
    await expect(page.locator('#t thead input.dbmn-pick-all')).toHaveCount(0);
    await expect(rowsAt(0).locator('input.dbmn-pick-box')).toHaveAttribute('type', 'radio');
    await rowsAt(4).click();
    await rowsAt(2).click();
    expect(await picked(page)).toEqual(['SO-10002']);
    await page.evaluate(() => { const t = document.getElementById('t'); t.selected = [t.rows[7]]; });
    await expect(rowsAt(7)).toHaveClass(/is-picked/);
    expect(await picked(page)).toEqual(['SO-10007']);
});

/* ── One search: hidden columns and fields ── */

test('the search reaches what is not shown by @name (a plain word: only what is shown; @@word is the Hub\'s alone, here the plain word); @ suggests them all', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.searchFields = [{ id: 'body', name: 'body', get: row => `{"sku":"${row.order_no}-X","note":"${row.qty > 40 ? 'urgent' : 'normal'}"}` }];
    });
    // A plain word looks only in the columns shown: a word only in a hidden field finds nothing
    await page.locator('#t .search-input').fill('urgent');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText(/^0 of/);
    // @@word is the Hub's alone (James, 2026-11-23): in a table it is the plain word, never deeper,
    // never coloured or said as anything else
    await page.locator('#t .search-input').fill('@@urgent');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText(/^0 of/);
    await expect(page.locator('#t .search-tok-deep')).toHaveCount(0);
    await expect(page.locator('#t .dbmn-table-reads')).not.toContainText('in any column');
    await page.locator('#t .search-input').fill('@@kettle');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    // @body names it
    await page.locator('#t .search-input').fill('@body~SO-10005-X');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 3,000 rows');
    // A column removed from view is still searched, by word and by @name
    await page.locator('#t .search-input').fill('');
    await page.locator('#t thead th').nth(1).hover();
    await page.locator('#t thead th').nth(1).locator('.col-hide-btn').click();
    await expect(page.locator('#t thead .column-name')).not.toContainText(['customer']);
    // (a plain word typed before the column went: searched again without it)
    await page.locator('#t .search-input').fill('');
    await page.locator('#t .search-input').fill('@customer=Kettle*');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    // @ suggests every column searched, shown or not, and the hidden field
    await page.locator('#t .search-input').fill('@');
    const offered = await page.locator('.search-suggest-item, .dbmn-suggest-item, [role="option"]').allTextContents();
    expect(offered.join(' ')).toContain('customer');
    expect(offered.join(' ')).toContain('body');
});

test('a column searched but not shown is told apart: its own colour in the box, last and marked in the @ list, "(not shown)" under the box', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => { document.getElementById('t').searchFields = [{ id: 'body', name: 'body', get: row => String(row.order_no) }]; });
    await page.locator('#t thead th').nth(1).hover();
    await page.locator('#t thead th').nth(1).locator('.col-hide-btn').click();
    const box = page.locator('#t .search-input');
    // Still being typed, a column not shown is told apart (finished, a search for it shows it: James, 2026-11-23)
    await box.fill('@customer');
    await expect(page.locator('#t .search-tok-col-hidden')).toHaveText('@customer');
    // A field the screen searches but never shows: told apart, and said so under the box
    await box.fill('@body=SO-1*');
    await expect(page.locator('#t .search-tok-col-hidden')).toHaveText('@body');
    await expect(page.locator('#t .dbmn-table-reads')).toContainText('not shown');
    // A finished term for the hidden column shows it: the box follows at once
    await box.fill('@customer=Kettle*');
    await expect(page.locator('#t .search-tok-col-name')).toHaveText('@customer');
    await expect(page.locator('#t .dbmn-table-reads')).not.toContainText('not shown');
    await box.fill('@order_no=1');
    await expect(page.locator('#t .search-tok-col-name')).toHaveText('@order_no');
    await expect(page.locator('#t .search-tok-col-hidden')).toHaveCount(0);
    await box.fill('@');
    const options = page.locator('#t .column-suggest-option');
    const texts = await options.locator('.column-suggest-text').allTextContents();
    const hiddenTexts = await page.locator('#t .column-suggest-option.is-hidden .column-suggest-text').allTextContents();
    // (customer is shown again by now: only the screen's hidden field is last, and marked)
    expect(hiddenTexts).toEqual(['@body']);   // (no @@: the Hub's lists alone have it)
    expect(texts).not.toContain('@@');
    expect(texts[texts.length - 1]).toBe('@body');
    expect(texts).toContain('@customer');
    await expect(page.locator('#t .column-suggest-option.is-hidden').last()).toContainText('@bodytext · not shown');
});

/* ── Widths when a narrow table fills its box ── */

const widthPage = cols => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1200px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Results"></dbmn-table>
<script>
  const t = document.getElementById('t');
  const tags = n => Array.from({ length: n }, (_, i) => 'C' + (i + 1)).join(' ');
  t.columns = ${cols};
  t.rows = Array.from({ length: 30 }, (_, i) => ({ status: i === 3 ? 'DIFF ' + tags(9) + ' Missing ' + tags(9) : 'Same', sku: 'SKU-' + i, qty: i }));
</script></body></html>`;
const widthOf = (p, id) => p.evaluate(i => Math.round(document.querySelector(`#t th[data-col="${i}"]`).getBoundingClientRect().width), id);

test('a narrow table fills its box with its data columns: a pinned status keeps what its rows need, never stretched past it', async ({ page }) => {
    await page.setContent(widthPage(`[{ id: 'status', name: 'Status', pinned: true }, { id: 'sku', name: 'sku' }, { id: 'qty', name: 'qty', numbers: true }]`));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    const status = await widthOf(page, 'status');
    expect(status).toBeLessThanOrEqual(420);
    expect(await widthOf(page, 'sku')).toBeGreaterThan(status);   // the room went to the data
});

test('a column given its width keeps it; wrap puts a long status on a second line rather than widening it', async ({ page }) => {
    await page.setContent(widthPage(`[{ id: 'status', name: 'Status', pinned: true, width: 160, wrap: true }, { id: 'sku', name: 'sku' }, { id: 'qty', name: 'qty', numbers: true }]`));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    expect(Math.abs(await widthOf(page, 'status') - 160)).toBeLessThanOrEqual(1);
    const cell = page.locator('#t .dbmn-table-body tr').nth(3).locator('td').first();
    await expect(cell).toHaveClass(/dbmn-cell-wrap/);
    expect(await cell.evaluate(td => getComputedStyle(td).whiteSpace)).toBe('normal');
});

test('spare room goes first to a column whose values are cut, then to the rest: a long sku later in the rows is not cut while description has room to spare', async ({ page }) => {
    await page.setContent(`<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1200px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Input" searchable></dbmn-table>
<script>
  const t = document.getElementById('t');
  t.columns = [{ id: 'row', name: '#', pinned: true }, { id: 'sku', name: 'sku' }, { id: 'description', name: 'description' }, { id: 'locationName', name: 'locationName' },
      { id: 'uom', name: 'unitOfMeasure' }, { id: 'status', name: 'inventoryStatus' }, { id: 'lot', name: 'lotNumber' }];
  // The first rows (what the widths are measured from) have short skus; the errors further down have long ones.
  // The other columns are as wide as they need from the start, and fill most of the box
  t.rows = Array.from({ length: 400 }, (_, i) => ({ row: i + 1, sku: i < 60 ? 'S' + i : 'SKU-WOOF-00' + String(i).padStart(4, '0') + '-ERR',
      description: 'Kibble for large dogs, 10 kg bag', locationName: 'Distribution centre west 01', uom: 'EACH', status: 'AVAILABLE', lot: 'LOT-2026-11-0001' }));
</script></body></html>`);
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    await page.locator('#t .search-input').fill('ERR');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('340 of 400 rows');
    const cut = await page.evaluate(() => {
        const cell = document.querySelector('#t .dbmn-table-body tr td:nth-child(2)');
        return { text: cell.textContent, cut: cell.scrollWidth > cell.clientWidth + 1 };
    });
    expect(cut.text).toContain('-ERR');
    expect(cut.cut).toBe(false);
    // and the room it took came from what had room to spare, not from the long column's share of everything
    const w = id => page.evaluate(i => Math.round(document.querySelector(`#t th[data-col="${i}"]`).getBoundingClientRect().width), id);
    expect(await w('sku')).toBeLessThan(420);
});

test('hidden characters shown (as Word\'s ¶): marks over the real characters in every text cell, drawing only; off again, plain', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        t.columns = [{ id: 'sku', name: 'sku' }, { id: 'note', name: 'note' }, { id: 'qty', name: 'qty', numbers: true }, { id: 'long', name: 'long', wrap: true }];
        t.rows = [
            { sku: ' A1 ', note: 'two  spaces\tthen tab', qty: 5, long: 'line one\nline two' },
            { sku: 'B 2', note: 'zero​width', qty: 0, long: '' },
            { sku: 'C3', note: null, qty: 7, long: 'plain' }
        ];
    });
    const cell = (r, c) => page.locator('#t .dbmn-table-body tr').nth(r).locator('td').nth(c);
    // Off: nothing marked
    await expect(page.locator('#t .dbmn-sc')).toHaveCount(0);
    await page.evaluate(() => { t.specialCharacters = true; });
    expect(await page.evaluate(() => t.specialCharacters)).toBe(true);
    // A mark per character, over it: the cell's text is still exactly the value
    await expect(cell(0, 0).locator('.dbmn-sc.is-space')).toHaveCount(2);
    expect(await cell(0, 0).textContent()).toBe(' A1 ');
    await expect(cell(0, 1).locator('.dbmn-sc.is-space')).toHaveCount(3);
    await expect(cell(0, 1).locator('.dbmn-sc.is-tab')).toHaveCount(1);
    expect(await cell(0, 1).textContent()).toBe('two  spaces\tthen tab');
    expect(await cell(0, 0).locator('.dbmn-sc.is-space').first().evaluate(e => getComputedStyle(e, '::after').content)).toBe('"·"');
    expect(await cell(0, 1).locator('.dbmn-sc.is-tab').evaluate(e => getComputedStyle(e, '::after').content)).toBe('"→"');
    // Spaces kept as they are: two spaces take two spaces' room, not one
    const [one, two] = await cell(0, 1).locator('.dbmn-sc.is-space').evaluateAll(list => list.map(e => e.getBoundingClientRect()));
    expect(two.left - one.left).toBeGreaterThan(2);
    // A non-breaking space, and a character that draws nothing, boxed with its code
    expect(await cell(1, 0).locator('.dbmn-sc.is-nbsp').evaluate(e => getComputedStyle(e, '::after').content)).toBe('"°"');
    expect(await cell(1, 1).locator('.dbmn-sc.is-code').getAttribute('data-code')).toBe('200B');
    // A line break: one line in a row ("↵"), a real break where the column wraps
    expect(await cell(0, 3).locator('.dbmn-sc.is-break').evaluate(e => getComputedStyle(e, '::after').content)).toBe('"↵"');
    await expect(cell(0, 3).locator('.dbmn-sc.is-break')).toHaveClass(/is-breaking/);
    // "" given is "blank"; a missing value stays an empty cell; a number is left alone
    await expect(cell(1, 3).locator('.dbmn-sc.is-blank')).toHaveCount(1);
    expect(await cell(1, 3).locator('.dbmn-sc').evaluate(e => getComputedStyle(e, '::after').content)).toBe('"blank"');
    await expect(cell(2, 1).locator('.dbmn-sc')).toHaveCount(0);
    await expect(cell(2, 2).locator('.dbmn-sc')).toHaveCount(0);
    // Every row the same height still: nothing wraps in a cell that doesn't
    const heights = await page.locator('#t .dbmn-table-body tr').evaluateAll(rows => rows.slice(1).map(r => Math.round(r.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    // Drawing only: search finds the real text
    await page.locator('#t .search-input').fill('two  spaces');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 3 rows');
    await page.locator('#t .search-input').fill('');
    // The same marks for a screen's own cells
    const made = await page.evaluate(() => {
        const box = document.createElement('div');
        box.append(window.DbmnTable.showSpecial('a b\nc', { breaks: true }));
        return { text: box.textContent, marks: [...box.querySelectorAll('.dbmn-sc')].map(m => m.className), has: [window.DbmnTable.hasSpecial('ab'), window.DbmnTable.hasSpecial('a b'), window.DbmnTable.hasSpecial('')] };
    });
    expect(made).toEqual({ text: 'a b\nc', marks: ['dbmn-sc is-space', 'dbmn-sc is-break is-breaking'], has: [false, true, true] });
    if (process.env.SPECIAL_SHOT) await page.locator('#t').screenshot({ path: process.env.SPECIAL_SHOT });
    // Off again: plain text, no marks
    await page.evaluate(() => { t.specialCharacters = false; });
    await expect(page.locator('#t .dbmn-sc')).toHaveCount(0);
    expect(await cell(0, 0).textContent()).toBe(' A1 ');
});

test('a column the search filters shows a funnel; its click, or removing the column, takes its terms out of the box', async ({ page }) => {
    // James, 2026-11-23: "if a column is removed from table, so should its search filter… a FILTER icon in columns added to search query box"
    await page.setContent(tablePage());
    const box = page.locator('#t .search-input');
    const funnels = () => page.locator('#t thead th').evaluateAll(ths => ths.filter(th => th.querySelector('.dbmn-col-funnel')).map(th => th.dataset.col));
    await box.fill('kettle');
    expect(await funnels()).toEqual([]);
    await box.fill('@qty=49 kettle');
    await expect.poll(funnels).toEqual(['qty']);
    // `@@word` is a word in every column, never a column's: no funnel for it
    await box.fill('@@awaiting @customer=kettle');
    await expect.poll(funnels).toEqual(['customer']);
    // The funnel clears that column's terms only, and the rows are searched again
    await page.locator('#t thead th[data-col="customer"] .dbmn-col-funnel').click();
    await expect(box).toHaveValue('@@awaiting');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1 of 3,000 rows');
    expect(await funnels()).toEqual([]);
    // The funnel sits between the name and the sort, all on the heading's one line
    await box.fill('@qty>40, @customer~mill');
    await expect.poll(funnels).toEqual(['customer', 'qty']);
    if (process.env.FUNNEL_SHOT) await page.locator('#t thead').screenshot({ path: process.env.FUNNEL_SHOT });
    const parts = await page.locator('#t thead th[data-col="qty"]').evaluate(th => ['.column-name', '.dbmn-col-funnel', '.col-sort-btn'].map(s => { const r = th.querySelector(s).getBoundingClientRect(); return { left: r.left, mid: r.top + r.height / 2 }; }));
    expect(parts[0].left).toBeLessThan(parts[1].left);
    expect(parts[1].left).toBeLessThan(parts[2].left);
    expect(Math.abs(parts[1].mid - parts[2].mid)).toBeLessThan(2);
    // Removing a column takes its terms out (the OR's comma with them), and the search runs again
    await page.locator('#t thead th[data-col="qty"] .col-hide-btn').click();
    await expect(box).toHaveValue('@customer~mill');
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    expect(await funnels()).toEqual(['customer']);
});

test('filtered: a screen that runs its own search names the columns; the funnel\'s click is the screen\'s', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        window.unfiltered = [];
        t.addEventListener('dbmn-table-unfilter', e => window.unfiltered.push(e.detail.id));
        t.filtered = ['notes'];
    });
    const funnel = page.locator('#t thead th[data-col="notes"] .dbmn-col-funnel');
    await expect(funnel).toBeVisible();
    await expect(funnel).toHaveAttribute('title', 'Clear this column\'s search');
    await funnel.click();
    expect(await page.evaluate(() => window.unfiltered)).toEqual(['notes']);
    // The table's own box is not the screen's: what it says does not draw the funnels while `filtered` is set
    await page.locator('#t .search-input').fill('@qty=1');
    expect(await page.locator('#t thead .dbmn-col-funnel').count()).toBe(1);
    await page.evaluate(() => { t.filtered = null; });
    await expect(page.locator('#t thead th[data-col="qty"] .dbmn-col-funnel')).toBeVisible();
    expect(await page.locator('#t thead .dbmn-col-funnel').count()).toBe(1);
});

test('a finished @name for a column not shown shows it again, at the end, and it stays', async ({ page }) => {
    // James, 2026-11-23: "@ search which returns column that is hidden, should ADD the column… stay"
    await page.setContent(tablePage());
    await page.evaluate(() => { window.told = []; t.addEventListener('dbmn-table-layout', e => window.told.push(e.detail.change)); });
    await page.locator('#t thead th[data-col="customer"] .col-hide-btn').click();
    expect(await names(page)).toEqual(['order_no', 'qty', 'notes']);
    const box = page.locator('#t .search-input');
    // The @ list says what a search for it does
    await box.fill('@cust');
    await expect(page.locator('#t .column-suggest-option', { hasText: '@customer' })).toContainText('adds it');
    // Still being typed: nothing yet
    await box.fill('@customer');
    expect(await names(page)).toEqual(['order_no', 'qty', 'notes']);
    // Its operator (or a space) finishes it: the column comes back at the end, filtered, and is
    // brought into view: scrolled to sideways, its heading lit for a moment
    await page.evaluate(() => { t.style.width = '320px'; });
    await box.fill('@customer~mill');
    await expect.poll(() => names(page)).toEqual(['order_no', 'qty', 'notes', 'customer']);
    await expect(page.locator('#t thead th[data-col="customer"]')).toHaveClass(/is-revealed/);
    await expect.poll(() => page.locator('#t .dbmn-table-scroll').evaluate(b => b.scrollLeft)).toBeGreaterThan(0);
    const seen = await page.locator('#t').evaluate(el => { const b = el.querySelector('.dbmn-table-scroll').getBoundingClientRect(); const h = el.querySelector('thead th[data-col="customer"]').getBoundingClientRect(); return h.right <= b.right + 1 && h.left >= b.left - 1; });
    expect(seen).toBe(true);
    await page.evaluate(() => { t.style.width = ''; });
    await expect(page.locator('#t .dbmn-table-count')).toHaveText('1,000 of 3,000 rows');
    await expect(page.locator('#t thead th[data-col="customer"] .dbmn-col-funnel')).toBeVisible();
    expect(await page.evaluate(() => window.told)).toContain('shown');
    // And it stays when the search is cleared
    await box.fill('');
    expect(await names(page)).toEqual(['order_no', 'qty', 'notes', 'customer']);
});

test('a finished @name for a field the screen adds asks the screen, once', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        window.asked = [];
        t.addEventListener('dbmn-table-add-column', e => window.asked.push(e.detail));
        t.searchFields = [{ id: 'bin', name: 'bin', adds: true }, { id: 'body', name: 'body' }];
    });
    const box = page.locator('#t .search-input');
    await box.fill('@bi');
    await expect(page.locator('#t .column-suggest-option', { hasText: '@bin' })).toContainText('adds it');
    await box.fill('@bin');
    expect(await page.evaluate(() => window.asked)).toEqual([]);
    await box.fill('@bin=A-01');
    await box.fill('@bin=A-012');
    expect(await page.evaluate(() => window.asked)).toEqual([{ id: 'bin', name: 'bin' }]);
    // A field only searched (no `adds`) is never asked for
    await box.fill('@body~x ');
    expect(await page.evaluate(() => window.asked)).toHaveLength(1);
});
