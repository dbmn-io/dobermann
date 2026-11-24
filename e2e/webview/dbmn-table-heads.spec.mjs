/**
 * <dbmn-table>'s heading count and filter (James, 2026-11-24, one piece for Query's DIFF counts and Validate's invalid
 * counts, and for a Status column's filter): the table draws them and says what was clicked; the screen filters.
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

const page = () => `<!doctype html><html><head>
<style>:root{--dbmn-foreground:#ccc;--dbmn-editor-background:#1e1e1e;--dbmn-panel-border:#444}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1100px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-table id="t" label="Input"></dbmn-table>
<script>
  const t = document.getElementById('t');
  window.heard = [];
  t.addEventListener('dbmn-table-count', e => window.heard.push(['count', e.detail]));
  t.addEventListener('dbmn-table-filter', e => window.heard.push(['filter', e.detail]));
  window.statusFilter = on => ({ label: 'Status', items: [{ value: 'invalid', label: 'INVALID', count: 3, on: on.includes('invalid') }, { value: 'valid', label: 'VALID', count: 997, on: on.includes('valid') }] });
  window.cols = (o = {}) => [
    { id: 'st', name: 'Status', pinned: true, filter: statusFilter(o.status || ['invalid', 'valid']) },
    { id: 'sku', name: 'sku' },
    { id: 'qty', name: 'quantityOnHand', count: { n: 2, on: !!o.qty } },
    { id: 'uom', name: 'uom', count: { n: o.uomN === undefined ? 1 : o.uomN, on: false } }
  ];
  t.columns = cols();
  t.rows = Array.from({ length: 20 }, (_, i) => ({ st: i < 3 ? 'INVALID' : 'VALID', sku: 'SKU-' + i, qty: i * 10, uom: 'EA' }));
</script></body></html>`;
const heard = p => p.evaluate(() => window.heard.splice(0));
const head = (p, id) => p.locator(`#t thead th[data-col="${id}"]`);

test('a count pill on a heading: a click asks for only those rows, again for all; a funnel while on; none at 0', async ({ page: p }) => {
    await p.setContent(page());
    await expect(head(p, 'qty').locator('.dbmn-head-count')).toHaveText('2');
    await expect(head(p, 'sku').locator('.dbmn-head-count')).toHaveCount(0);
    await head(p, 'qty').locator('.dbmn-head-count').click();
    expect(await heard(p)).toEqual([['count', { id: 'qty', on: true }]]);
    // (the screen filters and gives the columns again, the count on)
    await p.evaluate(() => { t.columns = cols({ qty: true }); });
    await expect(head(p, 'qty').locator('.dbmn-head-count')).toHaveClass(/is-active/);
    await head(p, 'qty').locator('.dbmn-head-funnel').click();
    expect(await heard(p)).toEqual([['count', { id: 'qty', on: false }]]);
    // Nothing to count: no pill
    await p.evaluate(() => { t.columns = cols({ uomN: 0 }); });
    await expect(head(p, 'uom').locator('.dbmn-head-count')).toHaveCount(0);
    // A click on the pill never sorts the column
    await p.evaluate(() => { t.columns = cols(); });
    await head(p, 'qty').locator('.dbmn-head-count').click();
    await expect(head(p, 'qty')).not.toHaveAttribute('aria-sort', /ascending|descending/);
});

test('a filter on a heading: ▾ opens Show and Only per line with their counts; each change is said; a funnel while filtering', async ({ page: p }) => {
    await p.setContent(page());
    await head(p, 'st').locator('.dbmn-head-btn').click();
    const menu = p.locator('.dbmn-filter-menu');
    await expect(menu.locator('.dbmn-filter-line:not(.dbmn-filter-heading) .dbmn-filter-name')).toHaveText(['INVALID', 'VALID']);
    await expect(menu.locator('.dbmn-filter-count')).toHaveText(['3', '997']);
    // Untick VALID: only INVALID
    await menu.locator('.dbmn-filter-tick input').nth(1).uncheck();
    expect(await heard(p)).toEqual([['filter', { id: 'st', values: ['invalid'] }]]);
    // Only VALID
    await menu.locator('.dbmn-filter-only input').nth(1).click();
    expect(await heard(p)).toEqual([['filter', { id: 'st', values: ['valid'] }]]);
    // The screen applies it, the headings are drawn again: the open menu takes the new state, a funnel shows
    await p.evaluate(() => { t.columns = cols({ status: ['valid'] }); t.redrawHeads(); });
    await expect(menu.locator('.dbmn-filter-only.is-alone')).toHaveCount(1);
    await expect(head(p, 'st').locator('.dbmn-head-funnel')).toHaveCount(1);
    // Only on the line already alone: every line back
    await menu.locator('.dbmn-filter-only input').nth(1).click();
    expect(await heard(p)).toEqual([['filter', { id: 'st', values: null }]]);
    // Escape closes it
    await p.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // The funnel clears it
    await head(p, 'st').locator('.dbmn-head-funnel').click();
    expect(await heard(p)).toEqual([['filter', { id: 'st', values: null }]]);
});

test('clearFilters: every count off and every filter back to all, as their own events', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { t.columns = cols({ qty: true, status: ['invalid'] }); });
    await p.evaluate(() => t.clearFilters());
    // (in the columns' order: Status's filter, then quantityOnHand's count)
    expect(await heard(p)).toEqual([['filter', { id: 'st', values: null }], ['count', { id: 'qty', on: false }]]);
});

test('a group heading takes a count too (Side by side: the field over its runs); the event names the group', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        const g = { id: 'group:qty', name: 'quantityOnHand', count: { n: 6, on: false } };
        t.columns = [{ id: 'sku', name: 'sku' }, { id: 'qBL', name: 'BL', group: g }, { id: 'qC1', name: 'C1', group: g }];
    });
    const groupHead = p.locator('#t thead th[data-group="group:qty"]').first();
    await expect(groupHead.locator('.dbmn-head-count')).toHaveText('6');
    await groupHead.locator('.dbmn-head-count').click();
    expect(await heard(p)).toEqual([['count', { id: 'group:qty', on: true }]]);
});


test('a total the screen marks ({ value, className }) wears its class in the totals row and on its line in the card', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        const g = { id: 'group:qty', name: 'quantityOnHand' };
        t.columns = [{ id: 'sku', name: 'sku' }, { id: 'qBL', name: 'BL', group: g }, { id: 'qC1', name: 'C1', group: g }];
        t.rows = [['A', '1', '2']];
        t.totals = { qBL: 1, qC1: { value: 2, className: 'is-diff-mark' } };
    });
    const cells = p.locator('#t tfoot td');
    await expect(cells.nth(1)).toHaveText('1');
    await expect(cells.nth(1)).not.toHaveClass(/is-diff-mark/);
    await expect(cells.nth(2)).toHaveText('2');
    await expect(cells.nth(2)).toHaveClass(/is-diff-mark/);
    await cells.nth(2).hover();
    await expect(p.locator('.dbmn-total-card .dbmn-total-card-value.is-diff-mark')).toHaveText('2');
    await expect(p.locator('.dbmn-total-card .dbmn-total-card-name.is-diff-mark')).toHaveText('C1');
    await expect(p.locator('.dbmn-total-card .is-different')).toHaveCount(0);
});
