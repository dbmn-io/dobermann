// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnContextMenu (shared/dbmn-context-menu.js): what the menu is about (`summary`) first, read only,
 * then its actions, which the keyboard moves between as before.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const html = `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-descriptionForeground:#8a8a8a;--vscode-editor-background:#1e1e1e;--vscode-menu-background:#252526;--vscode-menu-foreground:#ccc;--vscode-widget-border:#444;--vscode-menu-selectionBackground:#04395e;--vscode-editorWarning-foreground:rgb(204, 167, 0)}
${['shared/atomic.css', 'shared/core.css'].map(read).join('\n')}
body{margin:0;padding:24px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
<script>${read('shared/icons.js')}</script><script>${read('shared/dbmn-context-menu.js')}</script></head><body>
<button id="slot" type="button">BL</button>
<script>
  window.chosen = [];
  document.getElementById('slot').addEventListener('click', e => {
      const ran = ['Read', '13 Nov, 09:18 · 9 days ago']; ran.tone = 'warn';
      window.DbmnContextMenu.show(e.currentTarget, [
          { summary: { title: 'BL · inventory', lines: [['Request', 'dbmn · GET /inventory'], ['View', 'LowStock'], ['Result', 'DBMN Local'], ran, ['Rows', '105,010']] } },
          { separator: true },
          { id: 'refresh', label: 'Read again', icon: 'refresh-cw' },
          { id: 'remove', label: 'Remove', icon: 'trash-2', danger: true }
      ], id => window.chosen.push(id));
  });
</script></body></html>`;

test('a summary first: its title and lines, read only; the keyboard moves between the actions only', async ({ page }) => {
    await page.setContent(html);
    expect(await page.evaluate(() => window.DbmnContextMenu.takesSummary)).toBe(true);
    await page.locator('#slot').click();
    const menu = page.locator('.dbmn-context-menu');
    const summary = menu.locator('.dbmn-context-menu-summary');
    await expect(summary).toBeVisible();
    // First in the menu, then the line, then the actions (in a part of their own, which scrolls when short of room)
    expect(await menu.evaluate(m => Array.from(m.children).map(c => c.className.split(' ')[0]))).toEqual(
        ['dbmn-context-menu-summary', 'dbmn-context-menu-separator', 'dbmn-context-menu-list']);
    expect(await menu.locator('.dbmn-context-menu-list').evaluate(l => Array.from(l.children).map(c => c.className.split(' ')[0]))).toEqual(
        ['dbmn-context-menu-item', 'dbmn-context-menu-item']);
    await expect(summary.locator('.dbmn-context-menu-summary-title')).toHaveText('BL · inventory');
    await expect(summary.locator('dt')).toHaveText(['Request', 'View', 'Result', 'Read', 'Rows']);
    await expect(summary.locator('dd')).toHaveText(['dbmn · GET /inventory', 'LowStock', 'DBMN Local', '13 Nov, 09:18 · 9 days ago', '105,010']);
    // Names in a column of their own, the values lined up beside them
    const [n1, v1, v2] = await Promise.all([summary.locator('dt').first().boundingBox(), summary.locator('dd').first().boundingBox(), summary.locator('dd').nth(1).boundingBox()]);
    expect(v1.x).toBeGreaterThan(n1.x + n1.width);
    expect(Math.abs(v1.x - v2.x)).toBeLessThan(1);
    expect(Math.abs(v1.y - n1.y)).toBeLessThan(2);
    // The old line in the warning colour, names otherwise quiet
    await expect(summary.locator('dd').nth(3)).toHaveCSS('color', 'rgb(204, 167, 0)');
    await expect(summary.locator('dt').first()).toHaveCSS('color', 'rgb(138, 138, 138)');
    // Not a choice: the first action has focus, arrows go round the actions alone
    await expect(menu.locator('[data-action="refresh"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[data-action="remove"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[data-action="refresh"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.locator('[data-action="remove"]')).toBeFocused();
    // A click on the summary chooses nothing and leaves the menu open
    await summary.click();
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.chosen)).toEqual([]);
    if (process.env.MENU_SHOT) await page.screenshot({ path: process.env.MENU_SHOT });
    await menu.locator('[data-action="refresh"]').click();
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => window.chosen)).toEqual(['refresh']);
});

test('a window too short for the menu: the actions scroll under the summary, the keyboard brings each into view, and scrolling them keeps it open', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 360 });
    await page.setContent(html.replace("{ id: 'remove', label: 'Remove', icon: 'trash-2', danger: true }",
        "...Array.from({ length: 12 }, (_, i) => ({ id: 'act' + i, label: 'Action ' + i, icon: 'circle-play' })), { id: 'remove', label: 'Remove', icon: 'trash-2', danger: true }"));
    await page.locator('#slot').click();
    const menu = page.locator('.dbmn-context-menu');
    const list = menu.locator('.dbmn-context-menu-list');
    // Inside the window, under its button, the actions cut to the room left and scrolling
    const [box, slot] = await Promise.all([menu.boundingBox(), page.locator('#slot').boundingBox()]);
    expect(box.y).toBeGreaterThanOrEqual(slot.y + slot.height);
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    expect(await list.evaluate(l => l.scrollHeight > l.clientHeight + 10)).toBe(true);
    // Up from the first action: the last, scrolled into view; the summary still at the top
    await page.keyboard.press('ArrowUp');
    const last = menu.locator('[data-action="remove"]');
    await expect(last).toBeFocused();
    const inView = () => page.evaluate(() => {
        const l = document.querySelector('.dbmn-context-menu-list').getBoundingClientRect();
        const f = document.activeElement.getBoundingClientRect();
        return f.top >= l.top - 1 && f.bottom <= l.bottom + 1;
    });
    expect(await inView()).toBe(true);
    const summary = await menu.locator('.dbmn-context-menu-summary').boundingBox();
    expect(Math.abs(summary.y - box.y)).toBeLessThan(8);
    // Down again: round to the first, scrolled back up
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[data-action="refresh"]')).toBeFocused();
    expect(await inView()).toBe(true);
    // Its own scrolling (the wheel over it) leaves it open; the page scrolling closes it
    await list.hover();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(200);
    await expect(menu).toBeVisible();
    expect(await list.evaluate(l => l.scrollTop)).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect(menu).toHaveCount(0);

    // Opened at the pointer in a short window: never taller than it, the actions scroll
    await page.evaluate(() => window.DbmnContextMenu.show({ clientX: 100, clientY: 300, preventDefault() {} },
        Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, label: 'Pick ' + i }))));
    const at = await menu.boundingBox();
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y + at.height).toBeLessThanOrEqual(360);
    expect(await list.evaluate(l => l.scrollHeight > l.clientHeight)).toBe(true);
    if (process.env.MENU_SHOT) await page.screenshot({ path: process.env.MENU_SHOT.replace('.png', '-short.png') });
});
