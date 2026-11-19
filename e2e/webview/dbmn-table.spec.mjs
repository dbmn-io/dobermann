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
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
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
    await page.locator('#t .search-input').fill('number 7');
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
    expect(Math.max(...took)).toBeLessThan(16);
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

test('a value cut off by its column\'s width opens in full when the pointer finds it; a cell may name itself for the window', async ({ page }) => {
    await page.setContent(tablePage());
    await page.evaluate(() => {
        const t = document.getElementById('t');
        t.columns = [{ id: 'order_no', name: 'order_no' }, { id: 'customer', name: 'customer', cell: (td, _v, row) => { td.dataset.title = `${row.order_no}: customer`; } }, { id: 'qty', name: 'qty', numbers: true }];
        t.layout = { widths: { customer: 48 } };
    });
    const cell = page.locator('#t .dbmn-table-body tr').first().locator('td').nth(1);
    await expect(cell).toHaveText('Harbour Foods');
    await expect(cell).not.toHaveClass(/cell-expandable/);   // short: nothing marks it until it is seen cut off
    await cell.hover();
    await expect(cell).toHaveClass(/cell-expandable/);
    await cell.click();
    await expect(page.locator('.dbmn-modal .cell-detail-pre')).toHaveText('Harbour Foods');
    await expect(page.locator('.dbmn-modal .dbmn-modal-title')).toContainText('SO-10000: customer');
    await page.keyboard.press('Escape');
    // One that fits is left alone: a click on it is a click on its row
    const fits = page.locator('#t .dbmn-table-body tr').first().locator('td').nth(0);
    await fits.hover();
    await expect(fits).not.toHaveClass(/cell-expandable/);
});
