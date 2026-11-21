/**
 * DbmnFunctions (shared/dbmn-functions.js) in a real browser from the real files: functions on a
 * column, ticked in order, tried on the column's values before and after.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/modals.css', 'shared/dbmn-functions.css'];
const SCRIPTS = ['shared/icons.js', 'shared/dbmn-modal.js', 'shared/dbmn-functions.js'];

const page = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a;--vscode-textLink-foreground:#4daafc}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<script>
  const before = [' 000412', '000413 ', '000414'];
  const base = ['412', '413', '999'];
  const fns = { trim: v => v.trim(), ltrimZeros: v => v.replace(/^0+/, ''), first: (v, p) => v.slice(0, p.n), replace: (v, p) => v.split(p.from).join(p.to) };
  window.FUNCTIONS = [
    { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
    { id: 'ltrimZeros', label: 'Drop leading zeros', sql: ['LTRIM(', 'x', ", '0')"] },
    { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', number: true, label: 'How many characters' }, ')'] },
    { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Text to replace' }, "', '", { key: 'to', label: 'Replace it with' }, "')"] },
    { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: [{ id: 'uom', name: 'Units of measure', count: 12 }] }, ')'] }
  ];
  window.asked = [];
  window.sampleOf = applied => {
    const after = before.map(v => applied.reduce((value, a) => (fns[a.id] ? fns[a.id](value, a.params) : value), v));
    return { rows: before.map((v, i) => ({ before: v, after: after[i], base: base[i] })), agree: after.filter((v, i) => v === base[i]).length / base.length };
  };
  window.openIt = extra => { window.result = undefined; DbmnFunctions.open(Object.assign({ column: 'C1.sku', functions: FUNCTIONS, defaults: { n: 4, from: '-', to: '' }, asLabel: 'Compares as', baseLabel: 'BL',
      sample: applied => { window.asked.push(applied.map(a => a.id).join('+')); return window.sampleOf(applied); } }, extra || {})).then(r => { window.result = r; }); };
</script></body></html>`;

const line = (p, label) => p.locator('.dbmn-fx-line', { hasText: label });

test('ticked in order, written around the column, tried on its values beside BL\'s, and applied in that order', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => window.openIt());
    await expect(p.locator('.dbmn-modal-title')).toHaveText('Functions on C1.sku');
    await expect(p.locator('.dbmn-fx-sample thead th')).toHaveText(['C1.sku', 'Compares as', 'BL']);
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('C1.sku');
    await expect(p.locator('.dbmn-fx-clear')).toBeHidden();
    // Two ticked: each says its place, the line writes them together, the values follow
    await line(p, 'Trim spaces').locator('input[type="checkbox"]').check();
    await line(p, 'Drop leading zeros').locator('input[type="checkbox"]').check();
    await expect(line(p, 'Trim spaces').locator('.dbmn-fx-order')).toHaveText('1st');
    await expect(line(p, 'Drop leading zeros').locator('.dbmn-fx-order')).toHaveText('2nd');
    await expect(p.locator('.dbmn-fx-sql')).toHaveText("LTRIM(TRIM(C1.sku), '0')");
    const first = p.locator('.dbmn-fx-sample tbody tr').nth(0).locator('td');
    await expect(first.nth(1)).toHaveText('412');
    await expect(first.nth(1)).toHaveClass(/dbmn-fx-changed/);
    await expect(first.nth(2)).toHaveText('412');
    await expect(p.locator('.dbmn-fx-sample tbody td.dbmn-fx-agrees')).toHaveCount(2);
    await expect(p.locator('.dbmn-fx-agree')).toHaveText('67% agree with BL');
    // Typing a value ticks its function; a pasted value is trimmed
    await line(p, 'First characters').locator('input[data-fn-value="n"]').fill('2');
    await expect(line(p, 'First characters').locator('input[type="checkbox"]')).toBeChecked();
    await expect(line(p, 'First characters').locator('.dbmn-fx-order')).toHaveText('3rd');
    await line(p, 'First characters').locator('input[type="checkbox"]').uncheck();
    await p.locator('.dbmn-modal [data-action-id="ok"]').click();
    await expect.poll(() => p.evaluate(() => window.result)).toEqual([{ id: 'trim', params: {} }, { id: 'ltrimZeros', params: {} }]);
});

test('what was applied comes back ticked, in its order and with its values; Clear all; Cancel gives nothing', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => window.openIt({ applied: [{ id: 'replace', params: { from: 'X', to: 'Y' } }, { id: 'trim', params: {} }] }));
    await expect(line(p, 'Replace text').locator('.dbmn-fx-order')).toHaveText('1st');
    await expect(line(p, 'Trim spaces').locator('.dbmn-fx-order')).toHaveText('2nd');
    await expect(line(p, 'Replace text').locator('input[data-fn-value="from"]')).toHaveValue('X');
    await expect(p.locator('.dbmn-fx-sql')).toHaveText("TRIM(REPLACE(C1.sku, 'X', 'Y'))");
    await p.locator('.dbmn-fx-clear').click();
    await expect(p.locator('.dbmn-fx-line input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('C1.sku');
    await p.locator('.dbmn-modal [data-action-id="cancel"]').click();
    await expect.poll(() => p.evaluate(() => window.result)).toBe(null);
});

test('no column to compare with: two columns and no agreement; an answer to an older ask is dropped', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        // The first answer comes last: it must not overwrite the newer one
        let n = 0;
        window.openIt({ baseLabel: undefined, asLabel: 'Joins as', sample: applied => new Promise(done => {
            const mine = ++n;
            setTimeout(() => done(window.sampleOf(applied)), mine === 1 ? 400 : 20);
        }) });
    });
    await expect(p.locator('.dbmn-fx-sample thead th')).toHaveText(['C1.sku', 'Joins as']);
    await line(p, 'Trim spaces').locator('input[type="checkbox"]').check();
    await expect(p.locator('.dbmn-fx-sample tbody tr').first().locator('td')).toHaveCount(2);
    await expect(p.locator('.dbmn-fx-sample tbody tr').first().locator('td').nth(1)).toHaveText('000412');
    await p.waitForTimeout(500);
    // Still the trimmed values: the late answer to the first ask (nothing ticked) was dropped
    await expect(p.locator('.dbmn-fx-sample tbody tr').first().locator('td').nth(1)).toHaveText('000412');
    await expect(p.locator('.dbmn-fx-agree')).toHaveText('');
});

test('a lookup table is picked from the saved ones, and Open closes the dialog and asks the screen to open it', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { window.opened = []; window.openIt({ onOpenLookup: id => window.opened.push(id) }); });
    const translate = line(p, 'Translate values');
    await translate.locator('select.dbmn-fx-lookup').selectOption('uom');
    await expect(translate.locator('input[type="checkbox"]')).toBeChecked();
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('TRANSLATE(C1.sku, Units of measure)');
    await translate.locator('.dbmn-fx-open').click();
    await expect(p.locator('.dbmn-modal')).toHaveCount(0);
    await expect.poll(() => p.evaluate(() => [window.opened, window.result])).toEqual([['uom'], null]);
});

test('+ New lookup table… at the end of the picker: the dialog closes, and the screen is asked to make one', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { window.made = 0; window.openIt({ onNewLookup: () => { window.made += 1; } }); });
    const pick = line(p, 'Translate values').locator('select.dbmn-fx-lookup');
    await expect(pick.locator('option').last()).toHaveText('+ New lookup table…');
    await pick.selectOption('__new__');
    await expect(p.locator('.dbmn-modal')).toHaveCount(0);
    await expect.poll(() => p.evaluate(() => [window.made, window.result])).toEqual([1, null]);
});

test('no onNewLookup given: no + New lookup table… in the picker', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => window.openIt({}));
    await expect(line(p, 'Translate values').locator('select.dbmn-fx-lookup option', { hasText: 'New lookup table' })).toHaveCount(0);
});

test('a lookup table that has been deleted shows as missing, never quietly another', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => window.openIt({ applied: [{ id: 'translate', params: { table: 'gone' } }] }));
    const pick = line(p, 'Translate values').locator('select.dbmn-fx-lookup');
    await expect(pick).toHaveValue('gone');
    await expect(pick).toHaveClass(/is-missing/);
    await expect(pick.locator('option:checked')).toHaveText('Missing table (deleted)');
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('TRANSLATE(C1.sku, missing table)');
    await pick.selectOption('uom');
    await expect(pick).not.toHaveClass(/is-missing/);
});

test('Translate values: From and To from the table\'s columns; the whole table shown, From and To marked, this record\'s row lit', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        const units = { id: 'units', name: 'Units', count: 3, columns: [{ id: 'erp', name: 'ERP unit' }, { id: 'wms', name: 'WMS unit' }, { id: 'fin', name: 'Finance unit' }] };
        const rows = [{ erp: 'EA', wms: 'EACH', fin: 'UNIT' }, { erp: 'CS', wms: 'CASE', fin: 'BOX12' }, { erp: 'PL', wms: 'PALLET', fin: 'PLT' }];
        FUNCTIONS[4] = { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: [units, { id: 'other', name: 'Other', count: 0, columns: [{ id: 'a', name: 'A' }] }] }, ')'] };
        window.openIt({ baseLabel: undefined, sample: applied => (applied.some(a => a.id === 'translate') ? { table: { columns: units.columns, rows }, value: 'CS' } : window.sampleOf(applied)) });
    });
    const translate = line(p, 'Translate values');
    await translate.locator('select.dbmn-fx-lookup').selectOption('units');
    // From the first column, to the second, by default
    await expect(translate.locator('select.dbmn-fx-lookup-col')).toHaveCount(2);
    await expect(translate.locator('select.dbmn-fx-lookup-col').first()).toHaveValue('erp');
    await expect(translate.locator('select.dbmn-fx-lookup-col').last()).toHaveValue('wms');
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('TRANSLATE(C1.sku, Units: ERP unit → WMS unit)');
    // The whole table, From and To marked, the row with this record's value (CS) lit
    await expect(p.locator('.dbmn-fx-lut tbody tr')).toHaveCount(3);
    await expect(p.locator('.dbmn-fx-lut th.is-from')).toHaveText('ERP unit from');
    await expect(p.locator('.dbmn-fx-lut th.is-to')).toHaveText('WMS unit to');
    await expect(p.locator('.dbmn-fx-lut tr.is-used td')).toHaveText(['CS', 'CASE', 'BOX12']);
    await expect(p.locator('.dbmn-fx-sample-box')).toBeHidden();
    // Another To: what it becomes changes; Apply gives the table and both columns, by id
    await translate.locator('select.dbmn-fx-lookup-col').last().selectOption('fin');
    await expect(p.locator('.dbmn-fx-sql')).toHaveText('TRANSLATE(C1.sku, Units: ERP unit → Finance unit)');
    await expect(p.locator('.dbmn-fx-lut th.is-to')).toHaveText('Finance unit to');
    await p.locator('[data-action-id="ok"]').click();
    await expect.poll(() => p.evaluate(() => window.result)).toEqual([{ id: 'translate', params: { table: 'units', from: 'erp', to: 'fin' } }]);
});

test('Translate values applied before comes back with its From and To; another table keeps a column it also has', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        const cols = (...names) => names.map(n => ({ id: n, name: n.toUpperCase() }));
        FUNCTIONS[4] = { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Lookup table', kind: 'lookup', options: [{ id: 'a', name: 'A', columns: cols('x', 'y', 'z') }, { id: 'b', name: 'B', columns: cols('q', 'z') }] }, ')'] };
        window.openIt({ applied: [{ id: 'translate', params: { table: 'a', from: 'z', to: 'x' } }] });
    });
    const cols = line(p, 'Translate values').locator('select.dbmn-fx-lookup-col');
    await expect(cols.first()).toHaveValue('z');
    await expect(cols.last()).toHaveValue('x');
    await line(p, 'Translate values').locator('select.dbmn-fx-lookup').selectOption('b');
    await expect(cols.first()).toHaveValue('z');   // B has z too: kept
    await expect(cols.last()).toHaveValue('z');    // B has no x: its second column
});
