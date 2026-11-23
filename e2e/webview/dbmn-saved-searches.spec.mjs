/**
 * <dbmn-saved-searches> (shared/dbmn-saved-searches.js) in a real browser from the real files: a
 * search box's saved searches, a ★ drop-down beside the box (James, 2026-11-23: "drop down beside
 * the box, for sure").
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
/** `own`: the screen gives `current` and fills the box itself (Query); else the component follows `input`. */
const page = own => `<!doctype html><html><head><style>:root{--dbmn-foreground:#ccc;--dbmn-descriptionForeground:#999;--dbmn-focusBorder:#3794ff;--dbmn-errorForeground:#f14c4c;--dbmn-charts-yellow:#dcdcaa}
${read('shared/atomic.css')}${read('shared/search.css')} body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}
.bar{display:flex;gap:8px;justify-content:flex-end;width:600px}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-saved-searches.js')}</script></head><body>
<div class="bar"><input id="box" value=""><dbmn-saved-searches id="s"></dbmn-saved-searches></div><button id="other">elsewhere</button>
<script>
  window.changes = []; window.picks = []; window.typed = [];
  const s = document.getElementById('s'), box = document.getElementById('box');
  s.addEventListener('dbmn-saved-change', e => { window.changes.push(e.detail.searches); s.searches = e.detail.searches; });
  box.addEventListener('input', () => window.typed.push(box.value));
  ${own
        ? `s.addEventListener('dbmn-saved-pick', e => { window.picks.push(e.detail); box.value = e.detail.text; s.current = box.value; });
  box.addEventListener('input', () => { s.current = box.value; });`
        : `s.addEventListener('dbmn-saved-pick', e => window.picks.push(e.detail));
  s.input = box;`}
</script>
</body></html>`;

test('save this search: named in the menu, refused when blank or taken; the button then names it', async ({ page: p }) => {
    await p.setContent(page(false));
    const s = p.locator('#s');
    const button = s.locator('.dbmn-saved-btn');
    const menu = s.locator('.dbmn-saved-menu');
    await expect(button).toHaveText(/Saved/);
    await expect(menu).toBeHidden();
    // Nothing typed: nothing to save
    await button.click();
    await expect(menu).toBeVisible();
    await expect(menu.locator('.dbmn-saved-add')).toBeDisabled();
    await expect(menu.locator('.dbmn-saved-note')).toHaveText('Type a search first');
    await expect(menu.locator('.dbmn-saved-empty')).toHaveText('No saved searches yet');
    // A click elsewhere closes it
    await p.locator('#other').click();
    await expect(menu).toBeHidden();

    await p.locator('#box').fill('@status=late');
    await button.click();
    await menu.locator('.dbmn-saved-add').click();
    const name = menu.locator('.dbmn-saved-name-input');
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('status=late');          // a start: the search's words
    await name.fill('');
    await name.press('Enter');
    await expect(menu.locator('.dbmn-saved-problem')).toHaveText('Give it a name');
    await name.fill('Late orders');
    await name.press('Enter');
    expect(await p.evaluate(() => window.changes)).toEqual([[{ name: 'Late orders', text: '@status=late' }]]);
    // The box holds it: the button names it, the menu says so and offers no second save
    await expect(button).toHaveText(/Late orders/);
    await expect(button).toHaveClass(/is-saved/);
    await expect(menu.locator('.dbmn-saved-note')).toHaveText('Saved as Late orders');
    await expect(menu.locator('.dbmn-saved-add')).toBeDisabled();

    // Another search; its name taken (letter case aside) is refused
    await p.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await p.locator('#box').fill('@qty>10');
    await expect(button).toHaveText(/Saved/);
    await button.click();
    await menu.locator('.dbmn-saved-add').click();
    await name.fill('late ORDERS');
    await name.press('Enter');
    await expect(menu.locator('.dbmn-saved-problem')).toHaveText('A search called late ORDERS is saved already');
    // Esc in the box goes back to the menu, not out of it
    await name.press('Escape');
    await expect(menu).toBeVisible();
    await expect(name).toHaveCount(0);
    expect(await p.evaluate(() => window.changes.length)).toBe(1);
});

test('pick fills the box and searches as typed; rename and delete in the menu', async ({ page: p }) => {
    await p.setContent(page(false));
    await p.evaluate(() => { document.getElementById('s').searches = [{ name: 'Late orders', text: '@status=late' }, { name: 'Big', text: '@qty>10' }]; });
    const s = p.locator('#s');
    const menu = s.locator('.dbmn-saved-menu');
    await s.locator('.dbmn-saved-btn').click();
    await expect(menu.locator('.dbmn-saved-row')).toHaveCount(2);
    await expect(menu.locator('.dbmn-saved-row').nth(1)).toContainText('Big');
    await expect(menu.locator('.dbmn-saved-row').nth(1)).toContainText('@qty>10');
    // Picked: the event, then the box filled and its own input event (the screen's typing path), the menu shut
    await menu.locator('.dbmn-saved-pick').nth(1).click();
    expect(await p.evaluate(() => window.picks)).toEqual([{ name: 'Big', text: '@qty>10' }]);
    await expect(p.locator('#box')).toHaveValue('@qty>10');
    expect(await p.evaluate(() => window.typed)).toEqual(['@qty>10']);
    await expect(menu).toBeHidden();
    await expect(s.locator('.dbmn-saved-btn')).toHaveText(/Big/);
    // The box set from script: refresh() makes the button follow
    await p.evaluate(() => { document.getElementById('box').value = '@status=late'; document.getElementById('s').refresh(); });
    await expect(s.locator('.dbmn-saved-btn')).toHaveText(/Late orders/);

    // Rename: ✎, the name in a box
    await s.locator('.dbmn-saved-btn').click();
    await menu.getByRole('button', { name: 'Rename Big' }).click();
    const box = menu.locator('.dbmn-saved-name-input');
    await expect(box).toHaveValue('Big');
    await box.fill('Large qty');
    await box.press('Enter');
    expect(await p.evaluate(() => window.changes.at(-1))).toEqual([{ name: 'Late orders', text: '@status=late' }, { name: 'Large qty', text: '@qty>10' }]);
    // Delete: ×, then Keep leaves it; Delete takes it out
    await menu.getByRole('button', { name: 'Delete Late orders' }).click();
    await expect(menu.locator('.dbmn-saved-ask')).toHaveText('Delete Late orders?');
    await menu.getByRole('button', { name: 'Keep' }).click();
    await expect(menu.locator('.dbmn-saved-row')).toHaveCount(2);
    await menu.getByRole('button', { name: 'Delete Late orders' }).click();
    await menu.getByRole('button', { name: 'Delete', exact: true }).click();
    expect(await p.evaluate(() => window.changes.at(-1))).toEqual([{ name: 'Large qty', text: '@qty>10' }]);
    await expect(menu.locator('.dbmn-saved-row')).toHaveCount(1);
    // The box's search is no longer saved: the button says Saved again
    await expect(s.locator('.dbmn-saved-btn')).toHaveText(/Saved/);
});

test('a screen that fills the box itself (Query): pick only asks; current names the button', async ({ page: p }) => {
    await p.setContent(page(true));
    await p.evaluate(() => { const s = document.getElementById('s'); s.searches = [{ name: 'Late orders', text: '@status=late' }]; s.current = ''; });
    const s = p.locator('#s');
    await s.locator('.dbmn-saved-btn').click();
    await s.locator('.dbmn-saved-pick').click();
    expect(await p.evaluate(() => window.picks)).toEqual([{ name: 'Late orders', text: '@status=late' }]);
    await expect(p.locator('#box')).toHaveValue('@status=late');
    // (the component typed nothing into the box: the screen did)
    expect(await p.evaluate(() => window.typed)).toEqual([]);
    await expect(s.locator('.dbmn-saved-btn')).toHaveText(/Late orders/);
    await p.locator('#box').fill('@status=late x');
    await expect(s.locator('.dbmn-saved-btn')).toHaveText(/Saved/);
});

test('at most 50 kept: the 51st is not offered; the menu fits beside the box', async ({ page: p }) => {
    await p.setContent(page(false));
    await p.evaluate(() => { document.getElementById('s').searches = Array.from({ length: 50 }, (_x, i) => ({ name: `S${i}`, text: `t${i}` })); });
    await p.locator('#box').fill('new one');
    await p.locator('#s .dbmn-saved-btn').click();
    await expect(p.locator('#s .dbmn-saved-add')).toBeDisabled();
    await expect(p.locator('#s .dbmn-saved-note')).toHaveText('50 saved: delete one first');
    // The menu opens under the button, right-aligned to it, inside the page
    const menu = await p.locator('#s .dbmn-saved-menu').boundingBox();
    const btn = await p.locator('#s .dbmn-saved-btn').boundingBox();
    expect(Math.abs(menu.x + menu.width - (btn.x + btn.width))).toBeLessThan(2);
    expect(menu.y).toBeGreaterThan(btn.y + btn.height);
    expect(menu.x).toBeGreaterThanOrEqual(0);
});

test('compact (inside a tight toolbar\'s box): the star and the caret, the name in the hover text', async ({ page: p }) => {
    await p.setContent(page(false));
    await p.evaluate(() => { const s = document.getElementById('s'); s.setAttribute('compact', ''); s.searches = [{ name: 'Late orders', text: '@status=late' }]; });
    await p.locator('#box').fill('@status=late');
    const button = p.locator('#s .dbmn-saved-btn');
    await expect(button.locator('.dbmn-saved-label')).toBeHidden();
    await expect(button).toHaveAttribute('title', 'Saved search: Late orders');
    await expect(button).toHaveAttribute('aria-label', 'Saved search: Late orders');
    expect((await button.boundingBox()).width).toBeLessThan(40);
    // The menu still works
    await button.click();
    await expect(p.locator('#s .dbmn-saved-note')).toHaveText('Saved as Late orders');
});
