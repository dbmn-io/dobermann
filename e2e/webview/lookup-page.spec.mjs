/**
 * A lookup table's page (src/webviews/lookup/lookup-page.js) in a real browser from the real
 * files, the host faked: the table to edit, kept a moment after each change (or why not), every
 * column equal (a repeat amber, never refused), typed in fast with Tab and Enter, columns named
 * each differently and five at most, a block pasted as rows, a deleted table. And the New lookup
 * table dialog (shared/lookup-new.js).
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/buttons.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css',
    'shared/column-drag.css', 'shared/dbmn-footer.css', 'shared/dbmn-table.css', 'lookup/lookup.css'];
const SCRIPTS = ['shared/dbmn-actions.js', 'shared/icons.js', 'shared/search-words.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js',
    'shared/cell-detail.js', 'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-footer.js', 'shared/dbmn-table.js', 'shared/lookup-new.js'];

const TABLE = {
    id: 'lkp-1', name: 'Units', updatedAt: '2026-11-20T10:00:00Z',
    // (a key from before every column was equal: read, and no longer kept)
    columns: [{ id: 'c1', name: 'ERP unit', key: true }, { id: 'c2', name: 'WMS unit' }],
    rows: [{ c1: 'EA', c2: 'EACH' }, { c1: 'CS', c2: 'CASE' }]
};

// The page as lookup-page.ts builds it (its main and footer), with the host faked
const page = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a;--vscode-focusBorder:#4daafc}
${STYLES.map(read).join('\n')} body{width:900px}</style>
<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body class="lookup-body">
<main class="lookup-page">
    <dbmn-table id="lookupTable" label="Units" editable add-row row-delete edit-columns searchable></dbmn-table>
    <p class="lookup-gone" id="lookupGone" hidden>This lookup table has been deleted.</p>
</main>
<dbmn-footer class="lookup-footer">
    <dbmn-actions></dbmn-actions>
    <dbmn-status id="lookupStatus"></dbmn-status>
</dbmn-footer>
<script>${read('lookup/lookup-page.js')}</script>
</body></html>`;

const send = (p, message) => p.evaluate(m => window.postMessage(m, '*'), message);
const saves = p => p.evaluate(() => window.posted.filter(m => m.type === 'lookup.save'));
const td = (p, row, col) => p.locator('#lookupTable .dbmn-table-body tr').nth(row).locator('td').nth(col);

async function open(p) {
    await p.setContent(page());
    await expect.poll(() => p.evaluate(() => window.posted.map(m => m.type))).toEqual(['lookup.ready']);
    await send(p, { type: 'lookup.load', table: TABLE, limits: { columns: 5, rows: 1000 } });
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(2);
}

test('the table to edit: its rows, every column equal (no key), and kept a moment after a change', async ({ page: p }) => {
    await open(p);
    await expect(p.locator('#lookupTable thead .dbmn-key-mark')).toHaveCount(0);
    await expect(p.locator('#lookupStatus')).toHaveText('2 rows · kept');
    await td(p, 1, 2).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type('CARTON');
    await p.keyboard.press('ArrowUp')   // (kept by moving up: Enter on the last row starts a new one);
    await expect.poll(() => saves(p).then(s => s.length)).toBe(1);
    const [save] = await saves(p);
    expect(save.table.rows).toEqual([{ c1: 'EA', c2: 'EACH' }, { c1: 'CS', c2: 'CARTON' }]);
    expect(save.table.columns).toEqual([{ id: 'c1', name: 'ERP unit' }, { id: 'c2', name: 'WMS unit' }]);
    await expect(p.locator('#lookupStatus')).toHaveText('Keeping…');
    await send(p, { type: 'lookup.saved', seq: save.seq, rows: 2 });
    await expect(p.locator('#lookupStatus')).toHaveText('2 rows · kept');
});

test('a value twice in a column is amber, in any column, with why; it is kept all the same', async ({ page: p }) => {
    // James, 2026-11-23: "all equal. we can lookup any column and return any other column"
    await open(p);
    await td(p, 1, 2).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type('EACH');
    await p.keyboard.press('ArrowUp')   // (kept by moving up: Enter on the last row starts a new one);
    await expect(td(p, 0, 2)).toHaveClass(/dbmn-cell-key-duplicate/);
    await expect(td(p, 1, 2)).toHaveAttribute('title', 'EACH is in WMS unit 2 times: a lookup in WMS unit finds more than one row');
    await expect(td(p, 0, 1)).not.toHaveClass(/dbmn-cell-key-duplicate/);
    await expect.poll(() => saves(p).then(s => s.length)).toBe(1);
    expect((await saves(p))[0].table.rows.map(r => r.c2)).toEqual(['EACH', 'EACH']);
});

test('typed in fast: Tab to the next cell; past the last, and Enter on the last row, a new row', async ({ page: p }) => {
    await open(p);
    await td(p, 1, 1).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type('CS');
    await p.keyboard.press('Tab');
    await p.keyboard.type('CASE');
    // Tab past the last cell of the last row: a new row, its first cell held
    await p.keyboard.press('Tab');
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(3);
    await p.keyboard.type('PL');
    await p.keyboard.press('Tab');
    await p.keyboard.type('PALLET');
    // Enter on the last row: another
    await p.keyboard.press('Enter');
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(4);
    // ...but not from an empty one
    await p.keyboard.press('Enter');
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(4);
    await expect.poll(async () => { const s = await saves(p); return s.length ? s[s.length - 1].table.rows.map(r => `${r.c1}=${r.c2}`) : []; })
        .toEqual(['EA=EACH', 'CS=CASE', 'PL=PALLET', '=']);
});

test('columns: each named differently, five at most; what is refused is said', async ({ page: p }) => {
    await open(p);
    // Renamed as the other column is: refused
    await p.evaluate(() => {
        const t = document.getElementById('lookupTable');
        const asked = new CustomEvent('dbmn-table-columns', { bubbles: true, cancelable: true, detail: { kind: 'rename', id: 'c2', name: 'erp UNIT', old: 'WMS unit' } });
        window.refused = !t.dispatchEvent(asked);
    });
    expect(await p.evaluate(() => window.refused)).toBe(true);
    await expect(p.locator('#lookupStatus')).toHaveText('Another column is called ERP unit.');
    // A sixth: refused
    await send(p, { type: 'lookup.load', table: { ...TABLE, columns: ['A', 'B', 'C', 'D', 'E'].map(n => ({ id: n, name: n })) }, limits: { columns: 5, rows: 1000 } });
    await p.evaluate(() => {
        const t = document.getElementById('lookupTable');
        window.refused = !t.dispatchEvent(new CustomEvent('dbmn-table-columns', { bubbles: true, cancelable: true, detail: { kind: 'add', name: 'F', after: 'E' } }));
    });
    expect(await p.evaluate(() => window.refused)).toBe(true);
    await expect(p.locator('#lookupStatus')).toHaveText('A lookup table has up to 5 columns.');
});

test('New lookup table: a name, then up to five columns; a name taken or two columns alike are said, and it stays open', async ({ page: p }) => {
    // James, 2026-11-23: "first, prompt for name… name columns. up to 5. each with a different name"
    await p.setContent(page());
    await p.evaluate(() => { window.made = 'waiting'; window.LookupNew.ask({ taken: ['Regions'] }).then(m => { window.made = m; }); });
    const dialog = p.locator('.dbmn-modal');
    await expect(dialog).toContainText('New lookup table');
    const field = id => dialog.locator(`#dbmn-modal-field-${id}`);
    await field('name').fill('regions');
    await field('column0').fill('WMS');
    await field('column1').fill('wms');
    await dialog.getByRole('button', { name: 'Make the table' }).click();
    await expect(dialog).toContainText("There's a lookup table called regions already");
    await expect(dialog).toContainText('Another column is called WMS');
    expect(await p.evaluate(() => window.made)).toBe('waiting');
    await field('name').fill('UOM');
    await field('column1').fill('ERP');
    await field('column2').fill('TMS');
    await field('column3').fill('OMS');
    await dialog.getByRole('button', { name: 'Make the table' }).click();
    await expect(dialog).toBeHidden();
    expect(await p.evaluate(() => window.made)).toEqual({ name: 'UOM', columns: ['WMS', 'ERP', 'TMS', 'OMS'] });
});

test('a block from a spreadsheet: across and down from the cell, adding rows; values with no column are said', async ({ page: p }) => {
    await open(p);
    await td(p, 1, 1).click();
    await p.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'CS\tCASE\nPL\tPALLET\nBX\tBOX\textra\n');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(4);
    await expect(p.locator('#lookupStatus')).toHaveText('1 value had no column or row to go in.');
    await expect.poll(() => saves(p).then(s => s.length)).toBe(1);
    expect((await saves(p))[0].table.rows.map(r => r.c1)).toEqual(['EA', 'CS', 'PL', 'BX']);
});

test('deleted (from the Hub, or another tab): the table goes, and says so', async ({ page: p }) => {
    await open(p);
    await send(p, { type: 'lookup.missing' });
    await expect(p.locator('#lookupGone')).toBeVisible();
    await expect(p.locator('#lookupTable')).toBeHidden();
    await expect(p.locator('#lookupStatus')).toHaveText('Deleted');
});
