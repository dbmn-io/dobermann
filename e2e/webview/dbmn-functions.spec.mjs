/**
 * DbmnFunctions (shared/dbmn-functions.js) in a real browser from the real files: the functions on a
 * column as a chain of steps, top to bottom, a sample value followed down it (James, 2026-11-23: "top to
 * bottom… we chain them together, we don't nest them"; "Just say next sample").
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/buttons.css', 'shared/tables.css', 'shared/modals.css', 'shared/dbmn-functions.css'];
const SCRIPTS = ['shared/icons.js', 'shared/dbmn-modal.js', 'shared/dbmn-context-menu.js', 'shared/dbmn-functions.js'];

const page = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a;--vscode-textLink-foreground:#4daafc}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<script>
  // A column's values, as the screen's sample would read them
  const before = [' ea ', 'CA', 'dz', 'bx-1 '];
  const base = ['EACH', 'CASE', 'DZ', 'BOX'];
  window.lut = [{ tms: 'EA', wms: 'EACH' }, { tms: 'CA', wms: 'CASE' }, { tms: 'BX', wms: 'BOX' }, { tms: 'CA', wms: 'CRATE' }];
  window.TABLES = [{ id: 'uom', name: 'UOM', count: 4, columns: [{ id: 'tms', name: 'TMS' }, { id: 'wms', name: 'WMS' }] }];
  window.FUNCTIONS = [
    { id: 'translate', label: 'Translate values', sql: ['TRANSLATE(', 'x', ', ', { key: 'table', label: 'Table', kind: 'lookup', options: TABLES }, ')'] },
    { id: 'trim', label: 'Trim spaces', sql: ['TRIM(', 'x', ')'] },
    { id: 'upper', label: 'Upper case', sql: ['UPPER(', 'x', ')'] },
    { id: 'first', label: 'First characters', sql: ['SUBSTR(', 'x', ', 1, ', { key: 'n', number: true, label: 'Count' }, ')'] },
    { id: 'replace', label: 'Replace text', sql: ['REPLACE(', 'x', ", '", { key: 'from', label: 'Replace' }, "', '", { key: 'to', label: 'With' }, "')"] }
  ];
  const fns = { trim: v => v.trim(), upper: v => v.toUpperCase(), first: (v, p) => v.slice(0, p.n), replace: (v, p) => v.split(p.from || '\\u0000').join(p.to || '') };
  window.asked = [];
  // The steps' values, as Query's host gives them: each step's out, or where a Translate didn't find it
  window.sampleOf = applied => ({
    rows: before.map((v, r) => {
      const steps = [];
      let now = v;
      for (let i = 0; i < applied.length; i++) {
        const a = applied[i];
        if (a.id === 'translate') {
          const hits = window.lut.filter(x => x[a.params.from] === now);
          if (!hits.length) return { before: v, steps, after: v, missing: true, missingAt: i, base: base[r] };
          now = hits[0][a.params.to];
          steps.push(now);
          if (hits.length > 1) return Object.assign({ before: v, steps: steps.concat(applied.slice(i + 1).map(() => now)), after: now, twice: true, twiceAt: i, base: base[r] });
          continue;
        }
        now = fns[a.id](now, a.params);
        steps.push(now);
      }
      return { before: v, steps, after: now, base: base[r] };
    }),
    agree: 0.5
  });
  window.added = [];
  window.openIt = extra => { window.result = undefined; DbmnFunctions.open(Object.assign({ column: 'uom', functions: FUNCTIONS, defaults: { n: 2, from: '-', to: '' }, baseLabel: 'BL',
      sample: (applied, how) => { window.asked.push(applied.map(a => a.id).join('+') + (how && how.steps ? ':steps' : '')); return window.sampleOf(applied); } }, extra || {})).then(r => { window.result = r; }); };
</script></body></html>`;

const rows = p => p.locator('.dbmn-fx-row');
const names = p => p.locator('.dbmn-fx-row .dbmn-fx-name').allTextContents();
// (each value exactly as drawn: its spaces count)
const vals = p => p.locator('.dbmn-fx-out').evaluateAll(outs => outs.map(o => o.textContent));
// `flags`: which of the screen's handlers to give ({ add, open, newLookup }); the handlers live in the page
const open = async (p, applied, flags) => {
    await p.setContent(page());
    await p.evaluate(([a, f]) => {
        const extra = { applied: a };
        if (f && f.add) extra.onAddLookupRow = async row => { window.added.push(row); window.lut.push({ tms: row.value, wms: row.out }); return { ok: true }; };
        if (f && f.open) extra.onOpenLookup = id => { window.opened = id; };
        if (f && f.newLookup) extra.onNewLookup = () => { window.made = true; };
        window.openIt(extra);
    }, [applied, flags || null]);
    await expect(rows(p).first()).toBeVisible();
};
const TRANSLATE = { id: 'translate', params: { table: 'uom', from: 'tms', to: 'wms' } };

test('the chain, top to bottom: the source, then each step with its value; no function written anywhere', async ({ page: p }) => {
    await open(p, [{ id: 'trim', params: {} }, { id: 'upper', params: {} }, TRANSLATE]);
    await expect(p.locator('.dbmn-modal-title')).toHaveText('Functions');
    expect(await names(p)).toEqual(['Source column: uom', 'Trim spaces', 'Upper case', 'Translate values']);
    // The first sample, followed down: " ea " → "ea" → "EA" → "EACH"
    await expect.poll(() => vals(p)).toEqual([' ea ', 'ea', 'EA', 'EACH']);
    // Each row below the one before it, and every value in one column, level with its step's name
    const geo = await p.evaluate(() => [...document.querySelectorAll('.dbmn-fx-row')].map(r => {
        const n = r.querySelector('.dbmn-fx-name').getBoundingClientRect(), v = r.querySelector('.dbmn-fx-val').getBoundingClientRect();
        return { top: Math.round(r.getBoundingClientRect().top), valLeft: Math.round(v.left), level: Math.round(v.top - n.top) };
    }));
    geo.slice(1).forEach((g, i) => expect(g.top).toBeGreaterThan(geo[i].top));
    expect(new Set(geo.map(g => g.valLeft)).size).toBe(1);
    expect(new Set(geo.map(g => g.level))).toEqual(new Set([0]));
    // No function names in capitals, no nesting
    await expect(p.locator('.dbmn-modal')).not.toContainText(/TRIM\(|UPPER\(|TRANSLATE\(|uomrows/);
    // The sample is asked for every step's value
    expect(await p.evaluate(() => window.asked[0])).toBe('trim+upper+translate:steps');
    // Translate's fields: short labels, its table and columns picked
    const tr = rows(p).nth(3);
    await expect(tr.locator('.dbmn-fx-field > span')).toHaveText(['Table', 'From', 'To']);
    await expect(tr.locator('select.dbmn-fx-lookup')).toHaveValue('uom');
    await expect(tr.locator('select.dbmn-fx-lookup-col').nth(0)).toHaveValue('tms');
    await expect(tr.locator('select.dbmn-fx-lookup-col').nth(1)).toHaveValue('wms');
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => p.evaluate(() => window.result)).toEqual([{ id: 'trim', params: {} }, { id: 'upper', params: {} }, TRANSLATE]);
});

test('Previous and Next sample: the next value from the column goes down the chain', async ({ page: p }) => {
    await open(p, [{ id: 'trim', params: {} }, { id: 'upper', params: {} }]);
    const prev = p.getByRole('button', { name: '‹ Previous sample' }), next = p.getByRole('button', { name: 'Next sample ›' });
    await expect(prev).toBeDisabled();
    await expect.poll(() => vals(p)).toEqual([' ea ', 'ea', 'EA']);
    await next.click();
    await expect.poll(() => vals(p)).toEqual(['CA', 'CA', 'CA']);
    // (a step that left it as it was: not marked changed)
    await expect(rows(p).nth(1).locator('.dbmn-fx-val')).not.toHaveClass(/is-changed/);
    await next.click(); await next.click();
    await expect(next).toBeDisabled();
    await expect.poll(() => vals(p)).toEqual(['bx-1 ', 'bx-1', 'BX-1']);
    await prev.click();
    await expect.poll(() => vals(p)).toEqual(['dz', 'dz', 'DZ']);
});

test('+ Add a step, × removes one, Remove all steps; a field changed asks again', async ({ page: p }) => {
    await open(p, []);
    expect(await names(p)).toEqual(['Source column: uom']);
    await p.getByRole('button', { name: '+ Add a step' }).click();
    // The functions not in the chain yet, in the screen's order: Translate values first
    const menu = p.locator('.dbmn-context-menu');
    await expect(menu.locator('.dbmn-context-menu-item').first()).toHaveText('Translate values');
    await menu.getByText('First characters').click();
    expect(await names(p)).toEqual(['Source column: uom', 'First characters']);
    await expect.poll(() => vals(p)).toEqual([' ea ', ' e']);
    // Its Count, changed: the value with it
    await rows(p).nth(1).locator('input').fill('3');
    await expect.poll(() => vals(p)).toEqual([' ea ', ' ea']);
    await p.getByRole('button', { name: '+ Add a step' }).click();
    await menu.getByText('Trim spaces').click();
    expect(await names(p)).toEqual(['Source column: uom', 'First characters', 'Trim spaces']);
    await p.getByRole('button', { name: 'Remove First characters' }).click();
    expect(await names(p)).toEqual(['Source column: uom', 'Trim spaces']);
    await p.getByRole('button', { name: 'Remove all steps' }).click();
    expect(await names(p)).toEqual(['Source column: uom']);
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => p.evaluate(() => window.result)).toEqual([]);
});

test('a step moves by its grip: dragged, or Alt+↑ / Alt+↓; the values follow the new order', async ({ page: p }) => {
    await open(p, [{ id: 'first', params: { n: 2 } }, { id: 'trim', params: {} }]);
    await expect.poll(() => vals(p)).toEqual([' ea ', ' e', 'e']);
    // Alt+↑ on Trim's grip: Trim first
    await rows(p).nth(2).locator('.dbmn-fx-grip').focus();
    await p.keyboard.press('Alt+ArrowUp');
    expect(await names(p)).toEqual(['Source column: uom', 'Trim spaces', 'First characters']);
    await expect.poll(() => vals(p)).toEqual([' ea ', 'ea', 'ea']);
    await expect(rows(p).nth(1).locator('.dbmn-fx-grip')).toBeFocused();
    // Dragged by its grip below First characters: back as it was
    await rows(p).nth(1).locator('.dbmn-fx-grip').hover();
    await p.mouse.down();
    const target = await rows(p).nth(2).boundingBox();
    await rows(p).nth(1).dragTo(rows(p).nth(2), { targetPosition: { x: 40, y: target.height - 4 } });
    await p.mouse.up();
    await expect.poll(() => names(p)).toEqual(['Source column: uom', 'First characters', 'Trim spaces']);
    await p.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => p.evaluate(() => window.result.map(a => a.id))).toEqual(['first', 'trim']);
});

test('a value Translate didn\'t find: said on its row with + Add, and the steps after it show nothing for it', async ({ page: p }) => {
    await open(p, [{ id: 'upper', params: {} }, TRANSLATE, { id: 'first', params: { n: 2 } }], { add: true });
    await p.getByRole('button', { name: 'Next sample ›' }).click();
    await p.getByRole('button', { name: 'Next sample ›' }).click();
    // "dz" → "DZ" → not in TMS (+ Add) → nothing
    await expect.poll(() => vals(p)).toEqual(['dz', 'DZ', 'DZ · not in TMS+ Add', 'nothing (stopped above)']);
    await rows(p).nth(2).getByRole('button', { name: '+ Add' }).click();
    const box = rows(p).nth(2).locator('.dbmn-fx-add-box');
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute('placeholder', 'WMS for DZ');
    await box.fill('DOZEN');
    await box.press('Enter');
    expect(await p.evaluate(() => window.added)).toEqual([{ table: 'uom', from: 'tms', to: 'wms', value: 'DZ', out: 'DOZEN' }]);
    await expect.poll(() => vals(p)).toEqual(['dz', 'DZ', 'DOZEN', 'DO']);
    // CA is in TMS twice: the first row's, said on its step
    await p.getByRole('button', { name: '‹ Previous sample' }).click();
    await expect(rows(p).nth(2).locator('.dbmn-fx-twice')).toHaveText('in TMS twice, first row used');
    await expect(rows(p).nth(2).locator('.dbmn-fx-val')).toHaveText('CASE');
});

test('five steps with the longest fields fit the dialog: nothing past its edge, the values still in one column', async ({ page: p }) => {
    await p.setViewportSize({ width: 1100, height: 900 });
    await open(p, [{ id: 'trim', params: {} }, { id: 'replace', params: { from: '-', to: '' } }, { id: 'upper', params: {} }, TRANSLATE, { id: 'first', params: { n: 2 } }]);
    await expect(rows(p)).toHaveCount(6);
    const fit = await p.evaluate(() => {
        const form = document.querySelector('.dbmn-fx-form').getBoundingClientRect();
        const over = [...document.querySelectorAll('.dbmn-fx-form *')].filter(e => e.getBoundingClientRect().right > form.right + 0.5).length;
        const lefts = [...document.querySelectorAll('.dbmn-fx-row .dbmn-fx-out')].map(o => Math.round(o.getBoundingClientRect().left));
        return { over, lefts: [...new Set(lefts)], width: Math.round(form.width), scrollsSideways: document.querySelector('.dbmn-fx-form').scrollWidth > document.querySelector('.dbmn-fx-form').clientWidth };
    });
    expect(fit.over).toBe(0);
    expect(fit.lefts).toHaveLength(1);
    expect(fit.scrollsSideways).toBe(false);
    // Replace's two fields and Translate's three each sit on their step's own line, under its name
    await expect(rows(p).nth(2).locator('.dbmn-fx-field > span')).toHaveText(['Replace', 'With']);
});

test('a table that has been deleted shows as missing, never quietly another; Open and + New lookup table close the dialog and ask the screen', async ({ page: p }) => {
    await open(p, [{ id: 'translate', params: { table: 'gone', from: 'a', to: 'b' } }], { open: true, newLookup: true });
    const pick = rows(p).nth(1).locator('select.dbmn-fx-lookup');
    await expect(pick).toHaveValue('gone');
    await expect(pick.locator('option:checked')).toHaveText('Missing table (deleted)');
    await expect(pick).toHaveClass(/is-missing/);
    await pick.selectOption('uom');
    await rows(p).nth(1).getByRole('button', { name: 'Open' }).click();
    await expect.poll(() => p.evaluate(() => window.opened)).toBe('uom');
    await expect.poll(() => p.evaluate(() => window.result)).toBe(null);
    await open(p, [TRANSLATE], { newLookup: true });
    await rows(p).nth(1).locator('select.dbmn-fx-lookup').selectOption('__new__');
    await expect.poll(() => p.evaluate(() => window.made)).toBe(true);
    await expect.poll(() => p.evaluate(() => window.result)).toBe(null);
});

test('Cancel gives nothing; what was applied comes back in its order with its values', async ({ page: p }) => {
    await open(p, [{ id: 'replace', params: { from: '-', to: '_' } }, { id: 'trim', params: {} }]);
    expect(await names(p)).toEqual(['Source column: uom', 'Replace text', 'Trim spaces']);
    await expect(rows(p).nth(1).locator('input').nth(0)).toHaveValue('-');
    await expect(rows(p).nth(1).locator('input').nth(1)).toHaveValue('_');
    await p.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => p.evaluate(() => window.result)).toBe(null);
});
