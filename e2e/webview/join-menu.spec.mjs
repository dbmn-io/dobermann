/**
 * Which rows a join keeps (shared/relation-glyph.js, RelationGlyph.join), and the menu Query's Join
 * opens from a button (shared/dbmn-context-menu.js, opened under its anchor, items with a picture
 * and a second line), in a real browser from the real files.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/compare.css'];
const SCRIPTS = ['shared/icons.js', 'shared/relation-glyph.js', 'shared/dbmn-context-menu.js'];

const page = top => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-menu-background:#2a2a2a;--vscode-focusBorder:#4daafc;--vscode-charts-blue:#4f8fd8;--vscode-charts-orange:#d9894a;--vscode-editorWarning-foreground:#e0b45a}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;height:600px;background:#1e1e1e;color:#ccc;font:13px sans-serif}
#kind{position:absolute;left:40px;top:${top}px}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<div id="pics"></div>
<button type="button" id="kind">Join kind</button>
<script>
  ['inner', 'left', 'right', 'outer', 'compare'].forEach(k => document.getElementById('pics').append(RelationGlyph.join(k, k === 'left' ? { left: 'rgb(1, 2, 3)' } : undefined)));
  window.chosen = [];
  document.getElementById('kind').addEventListener('click', e => DbmnContextMenu.show(e.currentTarget, [
    { id: 'compare', label: 'Compare', detail: 'Match the views on the key and compare their values', glyph: RelationGlyph.join('compare') },
    { id: 'inner', label: 'Join', detail: 'Only rows Stock and Counts both have', glyph: RelationGlyph.join('inner') },
    { id: 'left', label: 'Left join', detail: 'All of Stock; Counts where it matches', glyph: RelationGlyph.join('left'), checked: true },
    { id: 'right', label: 'Right join', detail: 'All of Counts; Stock where it matches', glyph: RelationGlyph.join('right') },
    { id: 'outer', label: 'Outer join', detail: 'Every row of both, matched where they can be', glyph: RelationGlyph.join('outer') }
  ].map(item => Object.assign({ checked: false }, item)), id => window.chosen.push(id)));
</script></body></html>`;

test('a join\'s picture: the rows it keeps filled, the overlap always; Compare is the scale; the screen\'s colours', async ({ page: p }) => {
    await p.setContent(page(200));
    const pics = p.locator('#pics svg.join-glyph');
    await expect(pics).toHaveCount(5);
    const kept = await pics.evaluateAll(svgs => svgs.map(s => Array.from(s.querySelectorAll('.is-kept')).map(c => c.getAttribute('class').split(' ')[0])));
    expect(kept).toEqual([[], ['j-l'], ['j-r'], ['j-l', 'j-r'], []]);
    expect(await pics.evaluateAll(svgs => svgs.map(s => !!s.querySelector('.j-both')))).toEqual([true, true, true, true, false]);
    await expect(pics.nth(4)).toHaveClass(/is-compare/);
    expect(await pics.nth(4).locator('path').count()).toBeGreaterThan(0);
    // The kept side filled, the other only drawn round; the screen's colour on the left one
    const fills = await pics.nth(1).evaluate(s => [...s.querySelectorAll('circle')].map(c => [getComputedStyle(c).fillOpacity, getComputedStyle(c).fill]));
    expect(fills).toEqual([['0.55', 'rgb(1, 2, 3)'], ['0', 'rgb(217, 137, 74)']]);
    const box = await pics.first().boundingBox();
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([36, 20]);
});

test('the menu opens under its button: a picture, a bold name and a quiet line each; the chosen one is marked and focused', async ({ page: p }) => {
    await p.setContent(page(200));
    await p.locator('#kind').click();
    const menu = p.locator('.dbmn-context-menu');
    await expect(menu).toBeVisible();
    const button = await p.locator('#kind').boundingBox();
    const at = await menu.boundingBox();
    expect(Math.round(at.x)).toBe(Math.round(button.x));
    expect(Math.round(at.y)).toBe(Math.round(button.y + button.height + 4));
    const items = menu.locator('.dbmn-context-menu-item');
    await expect(items.locator('.dbmn-context-menu-label')).toHaveText(['Compare', 'Join', 'Left join', 'Right join', 'Outer join']);
    await expect(items.nth(2).locator('.dbmn-context-menu-detail')).toHaveText('All of Stock; Counts where it matches');
    await expect(items.nth(2).locator('.dbmn-context-menu-glyph svg.join-glyph')).toHaveCount(1);
    expect(await items.nth(2).locator('.dbmn-context-menu-label').evaluate(el => getComputedStyle(el).fontWeight)).toBe('600');
    await expect(items.nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(2)).toHaveAttribute('role', 'menuitemradio');
    await expect(items.nth(2)).toBeFocused();
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    expect(await p.evaluate(() => window.chosen)).toEqual(['right']);
});

test('with no room below its button, the menu opens above it', async ({ page: p }) => {
    await p.setViewportSize({ width: 800, height: 500 });
    await p.setContent(page(440));
    await p.locator('#kind').click();
    const button = await p.locator('#kind').boundingBox();
    const at = await p.locator('.dbmn-context-menu').boundingBox();
    expect(Math.round(at.y + at.height)).toBe(Math.round(button.y - 4));
});
