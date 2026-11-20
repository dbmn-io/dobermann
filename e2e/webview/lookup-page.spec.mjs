/**
 * A lookup table's page (src/webviews/lookup/lookup-page.js) in a real browser from the real
 * files, the host faked: the table to edit, kept a moment after each change (or why not), a key
 * picked, a block pasted as rows, a deleted table.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/buttons.css', 'shared/tables.css', 'shared/console.css', 'shared/modals.css', 'shared/column-head.css',
    'shared/column-drag.css', 'shared/dbmn-footer.css', 'shared/dbmn-table.css', 'lookup/lookup.css'];
const SCRIPTS = ['shared/dbmn-actions.js', 'shared/icons.js', 'shared/search-words.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js',
    'shared/cell-detail.js', 'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-footer.js', 'shared/dbmn-table.js'];

const TABLE = {
    id: 'lkp-1', name: 'Units', updatedAt: '2026-11-20T10:00:00Z',
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
    <dbmn-actions><label class="lookup-key"><span>Key</span><select id="lookupKey" data-change="lookup:key"></select></label></dbmn-actions>
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
    await send(p, { type: 'lookup.load', table: TABLE, limits: { columns: 50, rows: 1000 } });
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(2);
}

test('the table to edit: its rows, the key picked, and kept a moment after a change', async ({ page: p }) => {
    await open(p);
    await expect(p.locator('#lookupKey')).toHaveValue('c1');
    await expect(p.locator('#lookupStatus')).toHaveText('2 rows · kept');
    await td(p, 1, 2).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type('CARTON');
    await p.keyboard.press('Enter');
    await expect.poll(() => saves(p).then(s => s.length)).toBe(1);
    const [save] = await saves(p);
    expect(save.table.rows).toEqual([{ c1: 'EA', c2: 'EACH' }, { c1: 'CS', c2: 'CARTON' }]);
    expect(save.table.columns).toEqual([{ id: 'c1', name: 'ERP unit', key: true }, { id: 'c2', name: 'WMS unit' }]);
    await expect(p.locator('#lookupStatus')).toHaveText('Keeping…');
    await send(p, { type: 'lookup.saved', seq: save.seq, rows: 2 });
    await expect(p.locator('#lookupStatus')).toHaveText('2 rows · kept');
});

test('a key in two rows is not kept: said why; the key changed to another column, it is', async ({ page: p }) => {
    await open(p);
    await td(p, 1, 1).click();
    await p.keyboard.press('Control+a');
    await p.keyboard.type('EA');
    await p.keyboard.press('Enter');
    await expect(p.locator('#lookupStatus')).toHaveText(/^Not kept: 2 rows to fix before it is kept/);
    expect(await saves(p)).toEqual([]);
    await p.locator('#lookupKey').selectOption('c2');
    await expect.poll(() => saves(p).then(s => s.length)).toBe(1);
    expect((await saves(p))[0].table.columns.map(c => !!c.key)).toEqual([false, true]);
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
