/**
 * Run Batch's Validate grid (shared/dt-data-entry-grid.js) on the design system's table, in a real
 * browser from the real files: typing, Tab adding a row, Ctrl+D, the row bin, Ctrl+Z, amber cells
 * with their reason on hover, the errors filter, dates, tick boxes and paste.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css',
    'shared/column-drag.css', 'shared/dbmn-table.css', 'shared/data-transformer.css'];
const SCRIPTS = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js', 'shared/dt-data-entry-grid.js'];

// gtin: exactly 14 characters; uom: upper case; qty: a whole number, 0 or more; due: a date, optional; active: yes/no
const BODY = JSON.stringify({ items: [{ gtin: '{{gtin:string|14}}', uom: '{{uom:string|upper}}', qty: '{{qty:number|int|>=0}}', due: '{{due:date|opt}}', active: '{{active:boolean}}' }] });

const gridPage = (body = BODY) => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a;--vscode-input-border:#555;--vscode-focusBorder:#4daafc}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1000px;background:#1e1e1e;color:#ccc;font:13px sans-serif}
#csvDataValidationStep{height:420px}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<button id="csvNextBtn">Next</button><button id="gridErrorFilterBtn" disabled>Filter Errors</button>
<div id="csvDataValidationStep"><div id="gridEntryContainer" class="grid-entry-container"><div id="csvGridEntry" class="csv-grid-entry"></div></div><p class="grid-hint"></p></div>
<script>
  window.state = { modalStep: 3 };
  DTDataEntryGrid.init(window.state, () => null);
  DTDataEntryGrid.initializeDataEntryGrid({ body: ${JSON.stringify(body)} });
  // (Run Batch wires the footer button as data-click="grid:toggleErrorFilter")
  document.getElementById('gridErrorFilterBtn').addEventListener('click', () => DTDataEntryGrid.toggleErrorFilter());
  window.load = rows => {
    const vars = window.state.gridTemplateVariables.map(v => Object.assign({}, v, { mappedTo: v.name }));
    DTDataEntryGrid.populateGridFromMappedData({ headers: ['gtin', 'uom', 'qty', 'due', 'active'], rows }, vars);
  };
</script></body></html>`;

const GOOD = ['00012345600012', 'EA', '5', '2026-11-20', 'true'];
const rowsOf = page => page.evaluate(() => window.state.gridDataModel.map(r => r.slice()));
const body = page => page.locator('#validateGrid .dbmn-table-body tr:not(.dbmn-table-spacer)');
// A cell by its row among those shown and its column: 0 is the row number, then gtin, uom, qty, due, active
const td = (page, row, col) => body(page).nth(row).locator('td').nth(col);
const loaded = async (page, rows) => {
    await page.evaluate(r => window.load(r), rows);
    await expect(page.locator('#csvNextBtn')).toHaveText('Next');   // the background check has finished
};

test('the grid is the shared table: a row number, a column per variable, ○ on an optional one, the rules on a heading\'s hover', async ({ page }) => {
    await page.setContent(gridPage());
    await expect(page.locator('#validateGrid thead .column-name')).toHaveText(['#', 'gtin', 'uom', 'qty', 'due', 'active']);
    await expect(page.locator('#validateGrid thead th').nth(4).locator('.grid-header-optional-indicator')).toHaveText('○');
    await expect(page.locator('#validateGrid thead th').nth(1)).toHaveClass(/grid-header-has-validation/);
    await expect(body(page)).toHaveCount(1);
    await expect(td(page, 0, 0)).toHaveText('1');
});

test('typing: one click and type, in the column\'s case; Tab on the last cell adds a row, its first cell open; Ctrl+D; Ctrl+Z undoes', async ({ page }) => {
    await page.setContent(gridPage());
    // A data-entry grid: every cell a box, a text cursor, one click to type
    expect(await td(page, 0, 1).evaluate(el => getComputedStyle(el).cursor)).toBe('text');
    await td(page, 0, 1).click();
    await expect(td(page, 0, 1).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.type('00012345600012');
    await page.keyboard.press('Tab');
    await page.keyboard.type('ea');
    await page.keyboard.press('Tab');
    await page.keyboard.type('1x2');
    await page.keyboard.press('Enter');
    expect((await rowsOf(page))[0].slice(0, 3)).toEqual(['00012345600012', 'EA', '12']);
    // The last cell, then Tab: a new row, its first cell held
    await td(page, 0, 4).click();
    await page.keyboard.press('Tab');
    await expect(td(page, 0, 5)).toHaveClass(/dbmn-cell-active/);
    await page.keyboard.press('Tab');
    await expect(body(page)).toHaveCount(2);
    await expect(td(page, 1, 1).locator('input.dbmn-cell-input')).toBeFocused();
    // Ctrl+D: the value above, then on to the next cell
    await page.keyboard.press('Control+d');
    await expect(td(page, 1, 1)).toHaveText('00012345600012');
    await expect(td(page, 1, 2).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.press('Control+z');   // the copy
    await expect(td(page, 1, 1)).toHaveText('');
    await page.keyboard.press('Control+z');   // qty
    await page.keyboard.press('Control+z');   // uom
    expect((await rowsOf(page))[0].slice(0, 3)).toEqual(['00012345600012', '', '']);
});

test('a yes/no cell is a tick box a click turns over; a date opens the browser\'s date box', async ({ page }) => {
    await page.setContent(gridPage());
    await td(page, 0, 5).click();
    expect((await rowsOf(page))[0][4]).toBe('true');
    await expect(td(page, 0, 5).locator('input.grid-checkbox')).toBeChecked();
    await page.keyboard.press('Space');
    expect((await rowsOf(page))[0][4]).toBe('false');
    await td(page, 0, 4).click();
    await expect(td(page, 0, 4).locator('input.dbmn-cell-input')).toHaveAttribute('type', 'date');
    await td(page, 0, 4).locator('input').fill('2026-12-01');
    await page.keyboard.press('Enter');
    expect((await rowsOf(page))[0][3]).toBe('2026-12-01');
});

test('loaded rows: the rows to fix show first, amber, the reason on hover; Show All shows every row; fixing one checks again', async ({ page }) => {
    await page.setContent(gridPage());
    await loaded(page, [GOOD, ['123', 'EA', '5', '', 'false'], GOOD, ['00012345600043', 'CS', '-1', '', 'true'], ['', 'PL', '3', '', 'true']]);
    // Opening a cell moves nothing: the cell, its row and its text stay where they were
    const before = await td(page, 1, 3).boundingBox();
    const textAt = async () => td(page, 1, 3).evaluate(el => {
        const box = el.querySelector('input.dbmn-cell-input');
        if (!box) { const r = document.createRange(); r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().left); }
        return Math.round(box.getBoundingClientRect().left + parseFloat(getComputedStyle(box).paddingLeft) + parseFloat(getComputedStyle(box).borderLeftWidth));
    });
    const textBefore = await textAt();
    await td(page, 1, 3).click();
    await expect(td(page, 1, 3).locator('input.dbmn-cell-input')).toBeFocused();
    expect(await td(page, 1, 3).boundingBox()).toEqual(before);
    expect(Math.abs(await textAt() - textBefore)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(body(page)).toHaveCount(3);
    await expect(page.locator('#gridErrorFilterBtn')).toHaveText('Show All');
    await expect(page.locator('.grid-hint')).toHaveText(/^Showing the 3 rows that need fixing, of 5\./);
    await expect(body(page).locator('td.grid-row-num')).toHaveText(['2', '4', '5']);
    await expect(td(page, 0, 1)).toHaveClass(/grid-cell-error/);
    await expect(td(page, 0, 1)).toHaveAttribute('title', /gtin must be exactly 14 characters/);
    await expect(td(page, 1, 3)).toHaveClass(/grid-cell-error/);
    await expect(td(page, 2, 1)).toHaveClass(/grid-cell-blank-warning/);
    // The optional date may be empty
    await expect(td(page, 0, 4)).not.toHaveClass(/grid-cell-blank-warning/);

    await page.locator('#gridErrorFilterBtn').click();
    await expect(page.locator('#gridErrorFilterBtn')).toHaveText('Filter Errors (3)');
    await expect(body(page)).toHaveCount(5);
    await page.locator('#gridErrorFilterBtn').click();
    await expect(body(page)).toHaveCount(3);

    // Fix row 4's qty: once typing stops it is checked again (no longer amber) but stays in view
    // while the grid holds the keys; leaving the grid shows only the rows still to fix
    await td(page, 1, 3).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('7');
    await page.keyboard.press('Enter');
    await expect(td(page, 1, 3)).not.toHaveClass(/grid-cell-error/);
    await expect(page.locator('#gridErrorFilterBtn')).toHaveText('Show All');
    await expect(body(page)).toHaveCount(3);
    // (the cell below is open: Esc gives it up, Esc again leaves the grid)
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(body(page)).toHaveCount(2);
    await expect(page.locator('.grid-hint')).toHaveText(/^Showing the 2 rows that need fixing, of 5\./);
});

test('a row\'s number turns into a bin on hover: it deletes the row, Ctrl+Z puts it back', async ({ page }) => {
    await page.setContent(gridPage());
    await loaded(page, [GOOD, ['', 'PL', '3', '', 'true'], ['00012345600050', 'CS', '2', '', 'false']]);
    await body(page).nth(0).hover();
    const bin = td(page, 0, 0).locator('.row-delete-btn');
    await expect(bin).toBeVisible();
    await bin.click();
    await expect(page.locator('#gridErrorFilterBtn')).toBeDisabled();
    await expect(body(page)).toHaveCount(2);
    await expect(body(page).locator('td.grid-row-num')).toHaveText(['1', '2']);
    await page.keyboard.press('Control+z');
    await expect(body(page)).toHaveCount(1);   // back, and it needs fixing again: only it shows
    expect((await rowsOf(page))[1]).toEqual(['', 'PL', '3', '', 'true']);
});

test('a block pasted from a spreadsheet fills from the held cell, adding rows; one Ctrl+Z takes it away', async ({ page }) => {
    await page.setContent(gridPage());
    await td(page, 0, 1).click();
    await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '00012345600012\tea\t5\r\n00012345600043\tcs\t6\r\n');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(body(page)).toHaveCount(2);
    expect((await rowsOf(page)).map(r => r.slice(0, 3))).toEqual([['00012345600012', 'EA', '5'], ['00012345600043', 'CS', '6']]);
    await page.keyboard.press('Control+z');
    expect(await rowsOf(page)).toEqual([['', '', '', '', '']]);
});

test('many rows: only the rows in view are drawn', async ({ page }) => {
    await page.setContent(gridPage());
    await loaded(page, Array.from({ length: 20000 }, (_, i) => [String(10000000000000 + i), 'EA', String(i % 9), '', 'true']));
    await expect(page.locator('.grid-hint')).toHaveText(/^20,000 rows\./);
    expect(await body(page).count()).toBeLessThan(120);
});

test('typed rows: deleting one keeps every other row in view, numbered again (the filter is for rows loaded)', async ({ page }) => {
    await page.setContent(gridPage());
    // Row 1 complete; rows 2 and 3 empty (to fix)
    await td(page, 0, 1).click();
    await page.keyboard.type('00012345600012');
    await page.keyboard.press('Tab');
    await page.keyboard.type('EA');
    await page.keyboard.press('Tab');
    await page.keyboard.type('5');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { DTDataEntryGrid.addGridRow({ skipFocus: true }); DTDataEntryGrid.addGridRow({ skipFocus: true }); });
    await expect(body(page)).toHaveCount(3);
    await body(page).nth(1).hover();
    await td(page, 1, 0).locator('.row-delete-btn').click();
    await expect(body(page)).toHaveCount(2);
    await page.waitForTimeout(800);   // (the checks after the delete)
    await expect(body(page)).toHaveCount(2);
    await expect(body(page).locator('td.grid-row-num')).toHaveText(['1', '2']);
    await expect(td(page, 0, 1)).toHaveText('00012345600012');
    await expect(page.locator('#gridErrorFilterBtn')).toHaveText('Filter Errors (1)');
});

// An order and its lines: orderId once per order (level 1), sku and qty per line (level 2)
const NESTED = JSON.stringify({ orderId: '{{orderId}}', customer: '{{customer}}', lines: [{ sku: '{{sku}}', qty: '{{qty:number}}' }] });

test('nested data entry: Tab on the last cell adds a row; the next Tab copies the order\'s fields from the row above and goes to the line\'s', async ({ page }) => {
    await page.setContent(gridPage(NESTED));
    await expect(page.locator('#validateGrid thead .column-name')).toHaveText(['#', 'orderId', 'customer', 'sku', 'qty']);
    await td(page, 0, 1).click();
    for (const value of ['SO-1', 'Harbour Foods', 'A-1']) { await page.keyboard.type(value); await page.keyboard.press('Tab'); }
    await page.keyboard.type('5');
    await page.keyboard.press('Tab');   // the last cell: a new row
    await expect(body(page)).toHaveCount(2);
    await expect(page.locator('#progressiveCopyHint')).toHaveText('Tab to copy orderId and customer from row above');
    await expect(td(page, 1, 1).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.press('Tab');   // copies the order, on to the line
    expect((await rowsOf(page))[1]).toEqual(['SO-1', 'Harbour Foods', '', '']);
    await expect(td(page, 1, 3).locator('input.dbmn-cell-input')).toBeFocused();
    await page.keyboard.type('B-2');
    await page.keyboard.press('Tab');
    await page.keyboard.type('7');
    await page.keyboard.press('Enter');
    expect((await rowsOf(page))[1]).toEqual(['SO-1', 'Harbour Foods', 'B-2', '7']);
    await expect(page.locator('#progressiveCopyHint')).toHaveCount(0);
});

test('lu: a value not in the lookup table, or in it twice, is a row to fix, saying why; one in it passes; the tables come from the screen', async ({ page }) => {
    // James, 2026-11-23: "{{uom | lu:uom:tms>wms}}… any failed lookup returns as a validate failure in step 3"
    const LU = JSON.stringify({ items: [{ uom: '{{uom | lu:uom:tms>wms}}', check: '{{code | lu:uom:wms}}' }] });
    await page.setContent(gridPage(LU));
    // The screen gives the tables (Run Batch: templateLookups)
    await page.evaluate(() => DTDataEntryGrid.setLookupTables([{
        id: 'lkp-uom', name: 'UOM', columns: [{ id: 'c1', name: 'WMS' }, { id: 'c3', name: 'TMS' }],
        rows: [{ c1: 'EA', c3: 'EA' }, { c1: 'ST', c3: 'SE' }, { c1: 'CS', c3: 'CA' }, { c1: 'BX', c3: 'CA' }]
    }]));
    await page.evaluate(rows => {
        const vars = window.state.gridTemplateVariables.map(v => Object.assign({}, v, { mappedTo: v.name }));
        DTDataEntryGrid.populateGridFromMappedData({ headers: ['uom', 'code'], rows }, vars);
    }, [['SE', 'ST'], ['DZ', 'EA'], ['CA', 'EA'], ['EA', 'XX']]);
    await expect(page.locator('#csvNextBtn')).toHaveText('Next');
    await expect(page.locator('.grid-hint')).toHaveText(/^Showing the 3 rows that need fixing, of 4\./);
    await expect(body(page).locator('td.grid-row-num')).toHaveText(['2', '3', '4']);
    await expect(td(page, 0, 1)).toHaveAttribute('title', /uom DZ isn't in UOM's TMS column/);
    await expect(td(page, 1, 1)).toHaveAttribute('title', /uom CA is in UOM's TMS column 2 times/);
    await expect(td(page, 2, 2)).toHaveAttribute('title', /code XX isn't in UOM's WMS column/);
    await expect(td(page, 2, 1)).not.toHaveClass(/grid-cell-error/);
});
