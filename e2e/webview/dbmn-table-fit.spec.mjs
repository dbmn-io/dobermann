/**
 * <dbmn-table>'s widths when there is room, and when its box widens (James, 2026-11-24, Query Results on an
 * ultrawide): a column the screen draws itself (Compact's value and the other run's coloured pill) was held to 420px
 * and its pill cut off; and a table sized in a narrow box stayed that width when the box grew.
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

/** A table in a box `width` wide: a key, a column the screen draws itself (a value and a 260px pill), a short one. */
const tablePage = (width, others = 0) => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}
#box{width:${width}px}
.pill{display:inline-block;width:260px;margin-left:8px;background:#cca700;color:#222}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<div id="box"><dbmn-table id="t" label="Results" removable></dbmn-table></div>
<script>
  const t = document.getElementById('t');
  t.columns = [
    { id: 'sku', name: 'sku', pinned: true },
    { id: 'createdAt', name: 'createdAt', render: (value) => {
        const cell = document.createElement('span');
        cell.textContent = value;
        const pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = 'C1 2026-03-03T23:18:52';
        cell.append(pill);
        return cell;
    } },
    { id: 'uom', name: 'uom' }
  ].concat(Array.from({ length: ${others} }, (_, k) => ({ id: 'more' + k, name: 'treatPreference' + k })));
  t.rows = Array.from({ length: 50 }, (_, i) => Object.assign({ sku: 'SKU-' + i, createdAt: '2026-10-29T04:28:29.981171+00:00', uom: 'EA' },
    ...Array.from({ length: ${others} }, (_, k) => ({ ['more' + k]: 'Every package gets a tail wag ' + k }))));
</script></body></html>`;

const widthOf = (page, id) => page.locator(`#t thead th[data-col="${id}"]`).evaluate(th => Math.round(th.getBoundingClientRect().width));
const tableWidth = page => page.locator('#t table').first().evaluate(el => Math.round(el.getBoundingClientRect().width));

test('a drawn column gets the width its value and pill need when there is room (no longer held to 420)', async ({ page }) => {
    // (his case: other wide columns beside it and a little room to spare: shared out in proportion, the pill was cut)
    await page.setContent(tablePage(1600, 3));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    // The value (~260px) and its 260px pill: more than 420, so the pill shows whole
    expect(await widthOf(page, 'createdAt')).toBeGreaterThan(500);
    const pill = await page.locator('#t .dbmn-table-body tr').first().locator('.pill').boundingBox();
    const cell = await page.locator('#t .dbmn-table-body tr').first().locator('td').nth(1).boundingBox();
    expect(pill.x + pill.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
});

test('in a narrow box a drawn column is still held to 420 (the table scrolls instead)', async ({ page }) => {
    await page.setContent(tablePage(600));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    expect(await widthOf(page, 'createdAt')).toBeLessThanOrEqual(420);
});

test('sized in a narrow box, the table fills its box when the box widens', async ({ page }) => {
    await page.setContent(tablePage(700));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    const before = await tableWidth(page);
    await page.locator('#box').evaluate(b => { b.style.width = '1600px'; });
    await expect.poll(() => tableWidth(page)).toBeGreaterThan(before + 600);
    // (filled to the box: within a few pixels of its scroll box)
    const box = await page.locator('#t .dbmn-table-scroll').first().evaluate(el => el.clientWidth);
    expect(Math.abs((await tableWidth(page)) - box)).toBeLessThanOrEqual(4);
    // The pinned key column keeps its width
    expect(await widthOf(page, 'sku')).toBeLessThan(200);
});

test('a column resized by hand keeps its width when the box widens', async ({ page }) => {
    await page.setContent(tablePage(900));
    await expect(page.locator('#t .dbmn-table-body tr').first()).toBeVisible();
    const edge = await page.locator('#t thead th[data-col="uom"] .col-edge').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + 60, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    const set = await widthOf(page, 'uom');
    await page.locator('#box').evaluate(b => { b.style.width = '1600px'; });
    await page.waitForTimeout(300);
    expect(await widthOf(page, 'uom')).toBe(set);
});
