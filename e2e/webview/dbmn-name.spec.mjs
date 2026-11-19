/**
 * <dbmn-name> (shared/dbmn-name.js) in a real browser from the real files: a report's name on its
 * screen, renamed in place.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const page = () => `<!doctype html><html><head><style>:root{--vscode-foreground:#ccc;--vscode-descriptionForeground:#999;--vscode-focusBorder:#3794ff}
${read('shared/atomic.css')}${read('shared/dbmn-name.css')} body{margin:0;padding:16px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-name.js')}</script></head><body>
<dbmn-name id="n" label="Query name" max="30" value="New query" unnamed></dbmn-name><button id="other">elsewhere</button>
<script>window.asked = []; document.getElementById('n').addEventListener('dbmn-name-change', e => window.asked.push(e.detail.name));</script>
</body></html>`;

test('the name renames in place: click, type, then Enter, Tab or a click elsewhere keeps it; Esc gives it up', async ({ page: p }) => {
    await p.setContent(page());
    const name = p.locator('#n');
    const shown = name.locator('.dbmn-name-show');
    const box = name.locator('.dbmn-name-input');
    // Not named yet: italics
    await expect(shown).toHaveText('New query');
    expect(await name.locator('.dbmn-name-text').evaluate(el => getComputedStyle(el).fontStyle)).toBe('italic');
    await expect(box).toBeHidden();
    // Click: a box with the name selected
    await shown.click();
    await expect(box).toBeVisible();
    await expect(box).toBeFocused();
    // The box takes the name's place: the name is not shown beside it
    await expect(shown).toBeHidden();
    expect(await box.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 'New query'.length]);
    // No password manager in it
    await expect(box).toHaveAttribute('data-1p-ignore', 'true');
    await expect(box).toHaveAttribute('autocomplete', 'off');
    // Typed and Enter: asked for, cleaned; shown at once, no longer italic
    await box.fill('  Open   orders\tby item ');
    await box.press('Enter');
    expect(await p.evaluate(() => window.asked)).toEqual(['Open orders by item']);
    await expect(shown).toHaveText('Open orders by item');
    await expect(name).not.toHaveAttribute('unnamed', '');
    await expect(shown).toBeFocused();
    // Esc: nothing asked, the name it had
    await shown.click();
    await box.fill('Something else');
    await box.press('Escape');
    await expect(shown).toHaveText('Open orders by item');
    // Leaving the box keeps what was typed: Tab, and a click elsewhere
    await shown.click();
    await box.fill('Open orders by site');
    await p.keyboard.press('Tab');
    await expect(shown).toHaveText('Open orders by site');
    await expect(p.locator('#other')).toBeFocused();
    await shown.click();
    await box.fill('Open orders by week');
    await p.locator('#other').click();
    await expect(shown).toHaveText('Open orders by week');
    expect(await p.evaluate(() => window.asked)).toEqual(['Open orders by item', 'Open orders by site', 'Open orders by week']);
    // Too long: cut to the limit; the controller's answer is set back as value
    await shown.click();
    await box.fill('x'.repeat(50));
    await box.press('Enter');
    expect(await p.evaluate(() => window.asked.at(-1))).toBe('x'.repeat(30));
    await p.evaluate(() => { document.getElementById('n').value = 'Kept by the controller'; });
    await expect(shown).toHaveText('Kept by the controller');
    // Keyboard: Enter on the name opens the box
    await shown.focus();
    await p.keyboard.press('Enter');
    await expect(box).toBeVisible();
});
